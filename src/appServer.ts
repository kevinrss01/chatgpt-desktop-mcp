import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { log } from './log.js';
import { isRecord } from './util.js';

export class AppServerError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'AppServerError';
  }
}

/** Error code used when the app-server does not answer in time; the request may still have been applied. */
export const APP_SERVER_TIMEOUT = -32001;

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export interface AppServerOptions {
  binary: string;
  clientVersion: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

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
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('CODEX_') && key !== 'CODEX_HOME') continue;
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
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private ready = false;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrTail: string[] = [];
  serverInfo: { userAgent: string | null; platformOs: string | null } = { userAgent: null, platformOs: null };

  constructor(private readonly options: AppServerOptions) {
    super();
  }

  get binary(): string {
    return this.options.binary;
  }

  async ensureStarted(): Promise<void> {
    if (this.ready && this.child) return;
    if (!this.starting) {
      this.starting = this.spawnAndInitialize().finally(() => {
        this.starting = null;
      });
    }
    await this.starting;
  }

  async request<T = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureStarted();
    return (await this.rawRequest(method, params, timeoutMs)) as T;
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  recentStderr(): string[] {
    return [...this.stderrTail];
  }

  stop(): void {
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

  isRunning(): boolean {
    return this.child !== null;
  }

  private async spawnAndInitialize(): Promise<void> {
    log.debug('starting codex app-server', { binary: this.options.binary });
    const child = spawn(this.options.binary, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnvironment(),
    });
    this.child = child;
    this.ready = false;
    child.on('error', (error) => this.handleExit(child, error));
    child.on('exit', (code, signal) =>
      this.handleExit(child, new Error(`codex app-server exited (${code ?? signal ?? 'unknown'})`)),
    );
    child.stdin.on('error', (error) => log.debug('app-server stdin error', { message: error.message }));
    // Ignore output from a child that has been replaced, so stale events never reach the bridge.
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.child === child) this.handleLine(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });

    let result: unknown;
    try {
      result = await this.rawRequest(
        'initialize',
        {
          clientInfo: { name: 'chatgpt_desktop_mcp', title: 'ChatGPT Desktop MCP', version: this.options.clientVersion },
          capabilities: { experimentalApi: true, optOutNotificationMethods: OPTED_OUT_NOTIFICATIONS },
        },
        30_000,
      );
    } catch (error) {
      // Do not leave a half-started child behind; the next request spawns a fresh one.
      if (this.child === child) this.child = null;
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

  private rawRequest(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 60_000): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new AppServerError(-32000, 'codex app-server is not running'));
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

  private write(message: unknown): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      log.debug('ignoring non-JSON app-server output');
      return;
    }
    if (!isRecord(message)) return;
    const hasId = typeof message.id === 'number' || typeof message.id === 'string';
    const method = typeof message.method === 'string' ? message.method : null;

    if (hasId && method) {
      const request: AppServerRequest = { id: message.id as string | number, method, params: message.params };
      this.emit('serverRequest', request);
      return;
    }
    if (hasId) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        const code = typeof message.error.code === 'number' ? message.error.code : -32603;
        const text = typeof message.error.message === 'string' ? message.error.message : 'Unknown app-server error';
        pending.reject(new AppServerError(code, text, message.error.data));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (method) {
      this.emit('notification', { method, params: message.params } satisfies AppServerNotification);
    }
  }

  private handleExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    // A child replaced or stopped on purpose (stop() clears this.child first) needs no handling.
    if (this.child !== child) return;
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
