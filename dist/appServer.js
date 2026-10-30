import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { log } from './log.js';
import { isRecord } from './util.js';
export class AppServerError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
        this.name = 'AppServerError';
    }
}
/** Error code used when the app-server does not answer in time; the request may still have been applied. */
export const APP_SERVER_TIMEOUT = -32001;
/** Streaming deltas the bridge never uses; opting out keeps stdout traffic small. */
const OPTED_OUT_NOTIFICATIONS = [
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/reasoning/textDelta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/commandExecution/outputDelta',
    'item/commandExecution/terminalInteraction',
    'item/fileChange/outputDelta',
    'item/fileChange/patchUpdated',
    'item/mcpToolCall/progress',
    'thread/tokenUsage/updated',
    'turn/diff/updated',
];
/** Environment for the child process: keep CODEX_HOME, drop per-session Codex variables. */
function childEnvironment() {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (key.startsWith('CODEX_') && key !== 'CODEX_HOME')
            continue;
        env[key] = value;
    }
    return env;
}
/**
 * JSON-RPC client for `codex app-server` over stdio. The process shares
 * ~/.codex with the desktop app, so it sees the same chats, projects, config,
 * and sign-in.
 */
export class AppServerClient extends EventEmitter {
    options;
    child = null;
    starting = null;
    ready = false;
    nextId = 1;
    pending = new Map();
    stderrTail = [];
    serverInfo = { userAgent: null, platformOs: null };
    constructor(options) {
        super();
        this.options = options;
    }
    get binary() {
        return this.options.binary;
    }
    async ensureStarted() {
        if (this.ready && this.child)
            return;
        if (!this.starting) {
            this.starting = this.spawnAndInitialize().finally(() => {
                this.starting = null;
            });
        }
        await this.starting;
    }
    async request(method, params, timeoutMs) {
        await this.ensureStarted();
        return (await this.rawRequest(method, params, timeoutMs));
    }
    respond(id, result) {
        this.write({ id, result });
    }
    respondError(id, code, message) {
        this.write({ id, error: { code, message } });
    }
    recentStderr() {
        return [...this.stderrTail];
    }
    stop() {
        const child = this.child;
        this.child = null;
        this.ready = false;
        const stopped = new AppServerError(-32000, 'codex app-server was stopped');
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(stopped);
        }
        this.pending.clear();
        child?.kill('SIGTERM');
    }
    isRunning() {
        return this.child !== null;
    }
    async spawnAndInitialize() {
        log.debug('starting codex app-server', { binary: this.options.binary });
        const child = spawn(this.options.binary, ['app-server'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: childEnvironment(),
        });
        this.child = child;
        this.ready = false;
        child.on('error', (error) => this.handleExit(child, error));
        child.on('exit', (code, signal) => this.handleExit(child, new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})`)));
        child.stdin.on('error', (error) => log.debug('app-server stdin error', { message: error.message }));
        // Ignore output from a child that has been replaced, so stale events never reach the bridge.
        readline.createInterface({ input: child.stdout }).on('line', (line) => {
            if (this.child === child)
                this.handleLine(line);
        });
        readline.createInterface({ input: child.stderr }).on('line', (line) => {
            this.stderrTail.push(line);
            if (this.stderrTail.length > 40)
                this.stderrTail.shift();
        });
        let result;
        try {
            result = await this.rawRequest('initialize', {
                clientInfo: { name: 'chatgpt_desktop_mcp', title: 'ChatGPT Desktop MCP', version: this.options.clientVersion },
                capabilities: { experimentalApi: true, optOutNotificationMethods: OPTED_OUT_NOTIFICATIONS },
            }, 30_000);
        }
        catch (error) {
            // Do not leave a half-started child behind; the next request spawns a fresh one.
            if (this.child === child)
                this.child = null;
            child.kill('SIGTERM');
            throw error;
        }
        if (isRecord(result)) {
            this.serverInfo = {
                userAgent: typeof result.userAgent === 'string' ? result.userAgent : null,
                platformOs: typeof result.platformOs === 'string' ? result.platformOs : null,
            };
        }
        this.write({ method: 'initialized', params: {} });
        this.ready = true;
        log.debug('codex app-server ready');
    }
    rawRequest(method, params, timeoutMs = this.options.requestTimeoutMs ?? 60_000) {
        const child = this.child;
        if (!child)
            return Promise.reject(new AppServerError(-32000, 'codex app-server is not running'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new AppServerError(APP_SERVER_TIMEOUT, `codex app-server did not answer ${method} within ${timeoutMs} ms`));
            }, timeoutMs);
            this.pending.set(id, { method, resolve, reject, timer });
            this.write({ id, method, params });
        });
    }
    write(message) {
        const child = this.child;
        if (!child || child.stdin.destroyed)
            return;
        child.stdin.write(`${JSON.stringify(message)}\n`);
    }
    handleLine(line) {
        if (!line.trim())
            return;
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            log.debug('ignoring non-JSON app-server output');
            return;
        }
        if (!isRecord(message))
            return;
        const hasId = typeof message.id === 'number' || typeof message.id === 'string';
        const method = typeof message.method === 'string' ? message.method : null;
        if (hasId && method) {
            const request = { id: message.id, method, params: message.params };
            this.emit('serverRequest', request);
            return;
        }
        if (hasId) {
            const pending = this.pending.get(Number(message.id));
            if (!pending)
                return;
            this.pending.delete(Number(message.id));
            clearTimeout(pending.timer);
            if (isRecord(message.error)) {
                const code = typeof message.error.code === 'number' ? message.error.code : -32603;
                const text = typeof message.error.message === 'string' ? message.error.message : 'Unknown app-server error';
                pending.reject(new AppServerError(code, text, message.error.data));
            }
            else {
                pending.resolve(message.result);
            }
            return;
        }
        if (method) {
            this.emit('notification', { method, params: message.params });
        }
    }
    handleExit(child, error) {
        if (this.child !== child && this.child !== null)
            return;
        this.child = null;
        this.ready = false;
        const detail = this.stderrTail.at(-1);
        const failure = new AppServerError(-32000, detail ? `${error.message}: ${detail}` : error.message);
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(failure);
        }
        this.pending.clear();
        log.warn('codex app-server stopped', { reason: error.message });
        this.emit('exit', failure);
    }
}
