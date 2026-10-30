import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { APP_SERVER_TIMEOUT, AppServerError } from './appServer.js';
import { findModel, parseModel, resolveSpeed, validateEffort } from './catalog.js';
import { formatTurn, lastAgentMessage, summarizeThread } from './format.js';
import { IpcRequestError } from './ipc.js';
import { log } from './log.js';
import { globalStatePath } from './paths.js';
import { BridgeError, asArray, asString, errorMessage, isRecord, sleep, truncate } from './util.js';
/** Desktop chats are tagged "vscode" by app-server; CLI and app-server chats are user-facing too. */
const USER_SOURCE_KINDS = ['vscode', 'cli', 'appServer'];
const ALL_SOURCE_KINDS = [
    'cli',
    'vscode',
    'exec',
    'appServer',
    'subAgent',
    'subAgentReview',
    'subAgentCompact',
    'subAgentThreadSpawn',
    'subAgentOther',
    'unknown',
];
const MODEL_CACHE_MS = 5 * 60_000;
/**
 * Codex lets only one process write to a chat. The runner process holds chats it
 * runs until it exits, so it is stopped shortly after its last turn ends; the
 * desktop app can then open those chats again.
 */
const RUNNER_IDLE_STOP_MS = 2_000;
/** A turn whose start was never confirmed stops blocking the runner after this long. */
const UNCONFIRMED_TURN_TIMEOUT_MS = 120_000;
function slugFromPrompt(prompt) {
    const words = (prompt ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean)
        .slice(0, 5);
    return words.length > 0 ? words.join('-').slice(0, 48) : 'chat';
}
function today() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function expandHome(path) {
    return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}
function textInput(text) {
    return [{ type: 'text', text, text_elements: [] }];
}
/** Codex allows one writer per chat; explain the lock instead of surfacing the raw error. */
function explainWriterLock(error, action) {
    if (/active writer/i.test(errorMessage(error))) {
        throw new BridgeError(`Cannot ${action}: another Codex process has this chat loaded, usually the ChatGPT app because the chat is open there. Do it from the app, or try again after the app releases the chat.`, { cause: error });
    }
    throw error;
}
/**
 * High-level operations exposed as MCP tools. Chats open in a ChatGPT window
 * are driven through the app (live in its UI); everything else goes through a
 * private app-server process that shares the app's chat storage.
 */
export class DesktopBridge {
    reader;
    runner;
    desktop;
    options;
    turns = new Map();
    pending = new Map();
    waiters = new Map();
    chatLocks = new Map();
    runnerStopTimer = null;
    runnerOperations = 0;
    modelCache = null;
    nextPendingKey = 1;
    /**
     * @param reader long-lived app-server for lists, history, and models; it never loads chats.
     * @param runner app-server that starts and runs turns; stopped when idle to release chats.
     */
    constructor(reader, runner, desktop, options) {
        this.reader = reader;
        this.runner = runner;
        this.desktop = desktop;
        this.options = options;
        runner.on('notification', (notification) => this.onNotification(notification));
        runner.on('serverRequest', (request) => this.onServerRequest(request));
        runner.on('exit', () => this.onRunnerExit());
    }
    // ---------------------------------------------------------------- catalog
    async listModels(refresh = false) {
        if (!refresh && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS)
            return this.modelCache.models;
        const models = [];
        let cursor = null;
        do {
            const page = await this.reader.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
            const data = isRecord(page) ? asArray(page.data) : [];
            for (const entry of data) {
                const model = parseModel(entry);
                if (model)
                    models.push(model);
            }
            cursor = isRecord(page) ? asString(page.nextCursor) : null;
        } while (cursor);
        this.modelCache = { at: Date.now(), models };
        return models;
    }
    async listProjects() {
        const projects = [];
        try {
            const state = JSON.parse(readFileSync(globalStatePath(), 'utf8'));
            if (isRecord(state)) {
                const labels = isRecord(state['electron-workspace-root-labels']) ? state['electron-workspace-root-labels'] : {};
                for (const root of asArray(state['electron-saved-workspace-roots'])) {
                    if (typeof root !== 'string')
                        continue;
                    const label = asString(labels[root]) ?? root.split('/').filter(Boolean).at(-1) ?? root;
                    projects.push({ path: root, label, exists: existsSync(root) });
                }
            }
        }
        catch (error) {
            log.debug('could not read desktop project list', { message: errorMessage(error) });
        }
        const recent = new Map();
        const page = await this.listChats({ limit: 100 });
        for (const chat of page.chats) {
            if (!chat.cwd)
                continue;
            const entry = recent.get(chat.cwd) ?? { chats: 0, lastActivity: null };
            entry.chats += 1;
            if (!entry.lastActivity || (chat.updatedAt && chat.updatedAt > entry.lastActivity))
                entry.lastActivity = chat.updatedAt;
            recent.set(chat.cwd, entry);
        }
        return {
            projects,
            recentFolders: [...recent.entries()]
                .map(([path, entry]) => ({ path, ...entry }))
                .sort((a, b) => (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''))
                .slice(0, 30),
        };
    }
    // ------------------------------------------------------------------ reads
    async listChats(params) {
        const request = {
            limit: Math.min(Math.max(params.limit ?? 20, 1), 100),
            sortKey: 'updated_at',
            sortDirection: 'desc',
            sourceKinds: params.includeBackground ? ALL_SOURCE_KINDS : USER_SOURCE_KINDS,
            archived: params.archived ?? false,
        };
        if (params.cursor)
            request.cursor = params.cursor;
        if (params.search)
            request.searchTerm = params.search;
        if (params.project)
            request.cwd = await this.resolveProjectPath(params.project, false);
        const result = await this.reader.request('thread/list', request);
        const chats = (isRecord(result) ? asArray(result.data) : [])
            .map((thread) => summarizeThread(thread))
            .filter((chat) => chat !== null)
            .map((chat) => (this.turns.get(chat.id)?.status === 'inProgress' ? { ...chat, runningViaBridge: true } : chat));
        return { chats, nextCursor: isRecord(result) ? asString(result.nextCursor) : null };
    }
    async readChat(params) {
        const options = {
            includeToolCalls: params.includeToolCalls ?? true,
            includeToolOutputs: params.includeToolOutputs ?? false,
            includeReasoning: params.includeReasoning ?? false,
            maxCharsPerItem: Math.min(Math.max(params.maxCharsPerItem ?? 4000, 200), 50_000),
        };
        const [thread, page] = await Promise.all([
            this.reader.request('thread/read', { threadId: params.chatId, includeTurns: false }),
            this.reader.request('thread/turns/list', {
                threadId: params.chatId,
                limit: Math.min(Math.max(params.turns ?? 5, 1), 50),
                sortDirection: 'desc',
                itemsView: 'full',
                ...(params.cursor ? { cursor: params.cursor } : {}),
            }),
        ]);
        const turns = (isRecord(page) ? asArray(page.data) : [])
            .map((turn) => formatTurn(turn, options))
            .filter((turn) => turn !== null)
            .reverse();
        await this.markRunningTurn(params.chatId, turns);
        return {
            chat: isRecord(thread) ? summarizeThread(thread.thread) : null,
            turns,
            olderCursor: isRecord(page) ? asString(page.nextCursor) : null,
        };
    }
    async getChatStatus(chatId) {
        const tracked = this.turns.get(chatId);
        if (tracked?.status === 'inProgress') {
            const meta = await this.threadMeta(chatId);
            return {
                chatId,
                location: 'bridge',
                running: true,
                activeTurnId: tracked.turnId,
                title: meta?.title ?? null,
                cwd: meta?.cwd ?? null,
                model: meta?.model ?? null,
                reasoningEffort: meta?.reasoningEffort ?? null,
                speed: null,
                lastTurn: null,
                lastAgentMessage: tracked.lastAgentMessage,
                pendingRequests: this.pendingFor(chatId).map((request) => ({ type: request.kind, requestId: request.requestId })),
            };
        }
        let live;
        try {
            live = await this.desktop.liveState(chatId, 'quick');
        }
        catch (error) {
            if (error instanceof IpcRequestError && error.code === 'snapshot-unavailable') {
                const meta = await this.threadMeta(chatId);
                return {
                    chatId,
                    location: 'app',
                    running: false,
                    stateUnknown: true,
                    activeTurnId: null,
                    title: meta?.title ?? null,
                    cwd: meta?.cwd ?? null,
                    model: meta?.model ?? null,
                    reasoningEffort: meta?.reasoningEffort ?? null,
                    speed: null,
                    lastTurn: null,
                    lastAgentMessage: null,
                    pendingRequests: [],
                    note: error.message,
                };
            }
            log.debug('live state unavailable', { message: errorMessage(error) });
            live = { state: null, uncertain: true };
        }
        if (live.state)
            return this.statusFromLive(live.state);
        const [meta, history] = await Promise.all([this.threadMeta(chatId), this.recentTurns(chatId, 1)]);
        const last = history.at(-1) ?? null;
        let note;
        if (!live.uncertain && last?.status === 'interrupted' && !last.completedAt) {
            note = 'The last turn has no completion record. If a Codex client outside the app is running this chat, its live state is not visible here.';
        }
        return {
            chatId,
            location: 'stored',
            running: false,
            activeTurnId: null,
            title: meta?.title ?? null,
            cwd: meta?.cwd ?? null,
            model: meta?.model ?? null,
            reasoningEffort: meta?.reasoningEffort ?? null,
            speed: null,
            lastTurn: last ? { id: last.id, status: last.status, completedAt: last.completedAt } : null,
            lastAgentMessage: lastAgentMessage(history) ?? tracked?.lastAgentMessage ?? null,
            pendingRequests: [],
            note,
        };
    }
    async waitForChat(chatId, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        let status = await this.getChatStatus(chatId);
        while ((status.running || status.stateUnknown) && Date.now() < deadline) {
            const remaining = deadline - Date.now();
            if (status.location === 'bridge')
                await this.waitForBridgeTurn(chatId, remaining);
            else
                await sleep(Math.min(2_500, remaining));
            status = await this.getChatStatus(chatId);
        }
        if (!status.running && status.location !== 'stored' && status.lastAgentMessage === null) {
            const history = await this.recentTurns(chatId, 1).catch(() => []);
            status = { ...status, lastAgentMessage: lastAgentMessage(history) };
        }
        return { ...status, timedOut: status.running || status.stateUnknown === true };
    }
    // --------------------------------------------------------------- controls
    async createChat(params) {
        const cwd = params.project ? await this.resolveProjectPath(params.project, true) : this.newChatFolder(params.prompt);
        const models = await this.listModels();
        const model = params.model ? findModel(models, params.model) : models.find((entry) => entry.isDefault);
        if (params.model && !model)
            throw new BridgeError(`Unknown model "${params.model}". Use list_models to see available models.`);
        const effort = validateEffort(model, params.effort);
        const speed = resolveSpeed(model, params.speed);
        const start = { cwd, serviceName: 'chatgpt-desktop-mcp' };
        if (params.model && model)
            start.model = model.id;
        if (speed)
            start.serviceTier = speed;
        const sandbox = this.forcedSetting('sandbox', params.sandbox);
        const approvalPolicy = this.forcedSetting('approvalPolicy', params.approvalPolicy);
        if (sandbox)
            start.sandbox = sandbox;
        if (approvalPolicy)
            start.approvalPolicy = approvalPolicy;
        const { started, chatId, turnId } = await this.withRunner(async () => {
            const response = await this.runner.request('thread/start', start);
            const thread = isRecord(response) && isRecord(response.thread) ? response.thread : null;
            const id = asString(thread?.id);
            if (!id)
                throw new BridgeError('codex app-server did not return a chat id.');
            if (params.title)
                await this.runner.request('thread/name/set', { threadId: id, name: params.title });
            const firstTurn = params.prompt
                ? await this.startBridgeTurn(id, params.prompt, { model: params.model ? model?.id : undefined, effort, speed })
                : null;
            return { started: response, chatId: id, turnId: firstTurn };
        });
        return {
            chatId,
            turnId,
            cwd,
            model: asString(isRecord(started) ? started.model : null) ?? model?.id ?? null,
            reasoningEffort: effort ?? asString(isRecord(started) ? started.reasoningEffort : null),
            speed: speed ?? asString(isRecord(started) ? started.serviceTier : null),
        };
    }
    sendMessage(params) {
        // Serialize actions per chat so two callers cannot both see it idle and start two turns.
        return this.withChatLock(params.chatId, () => this.sendMessageLocked(params));
    }
    async sendMessageLocked(params) {
        const whenBusy = params.whenBusy ?? 'reject';
        const tracked = this.turns.get(params.chatId);
        if (tracked?.status === 'inProgress') {
            return this.handleBusyBridgeChat(params, tracked, whenBusy);
        }
        let live;
        try {
            live = (await this.desktop.liveState(params.chatId, 'definitive')).state;
        }
        catch (error) {
            throw new BridgeError(`The ChatGPT app did not confirm whether it has this chat open (${errorMessage(error)}). The message was not sent, to avoid running it twice.`, { cause: error });
        }
        if (live) {
            const turn = await this.resolveTurnOptions(params, live.model);
            const startInApp = async () => {
                if (turn.model || turn.effort) {
                    const model = turn.model ?? live.model;
                    if (!model)
                        throw new BridgeError('The app did not report a model for this chat, so the reasoning effort cannot be changed.');
                    const applied = await this.desktop.updateNextTurnSettings(params.chatId, { model, effort: turn.effort ?? live.reasoningEffort });
                    if (!applied)
                        throw new BridgeError('The ChatGPT app did not apply the model settings; the message was not sent.');
                }
                await this.desktop.startTurn(params.chatId, { text: params.message, speed: turn.speed }).catch((error) => {
                    if (error instanceof IpcRequestError && error.code === 'timeout') {
                        throw new BridgeError('The ChatGPT app did not confirm the message in time. It may still have been sent; check get_chat_status or read_chat before sending it again.', { cause: error });
                    }
                    throw error;
                });
            };
            if (live.running) {
                if (whenBusy === 'reject') {
                    throw new BridgeError('This chat is busy in the ChatGPT app. Use whenBusy "steer" to add the message to the running turn, or "interrupt" to stop it first.');
                }
                if (whenBusy === 'steer') {
                    await this.desktop.steerTurn(params.chatId, params.message, live.cwd);
                    return { chatId: params.chatId, deliveredVia: 'app', action: 'steered', turnId: live.activeTurnId };
                }
                if (live.activeTurnId)
                    await this.desktop.interruptTurn(params.chatId, live.activeTurnId);
                await this.waitUntilAppIdle(params.chatId, 20_000);
                await startInApp();
                return { chatId: params.chatId, deliveredVia: 'app', action: 'interruptedAndStarted', turnId: null };
            }
            await startInApp();
            return { chatId: params.chatId, deliveredVia: 'app', action: 'started', turnId: null };
        }
        const meta = await this.threadMeta(params.chatId);
        if (!meta)
            throw new BridgeError(`Chat ${params.chatId} was not found.`);
        const turn = await this.resolveTurnOptions(params, meta.model);
        const resume = { threadId: params.chatId, excludeTurns: true };
        if (turn.model)
            resume.model = turn.model;
        if (this.options.sandbox)
            resume.sandbox = this.options.sandbox;
        if (this.options.approvalPolicy)
            resume.approvalPolicy = this.options.approvalPolicy;
        const turnId = await this.withRunner(async () => {
            await this.runner.request('thread/resume', resume).catch((error) => explainWriterLock(error, 'send the message'));
            return this.startBridgeTurn(params.chatId, params.message, turn);
        });
        return { chatId: params.chatId, deliveredVia: 'bridge', action: 'started', turnId };
    }
    interruptChat(chatId) {
        return this.withChatLock(chatId, () => this.interruptChatLocked(chatId));
    }
    async interruptChatLocked(chatId) {
        const tracked = this.turns.get(chatId);
        if (tracked?.status === 'inProgress' && tracked.turnId) {
            await this.runner.request('turn/interrupt', { threadId: chatId, turnId: tracked.turnId });
            return { chatId, interrupted: true, via: 'bridge', turnId: tracked.turnId };
        }
        const live = (await this.desktop.liveState(chatId, 'definitive')).state;
        if (live?.running && live.activeTurnId) {
            await this.desktop.interruptTurn(chatId, live.activeTurnId);
            return { chatId, interrupted: true, via: 'app', turnId: live.activeTurnId };
        }
        return { chatId, interrupted: false, via: null, turnId: null };
    }
    async renameChat(chatId, title) {
        await this.withChatLock(chatId, () => this.withRunner(() => this.runner.request('thread/name/set', { threadId: chatId, name: title }).catch((error) => explainWriterLock(error, 'rename the chat'))));
        return { chatId, title };
    }
    archiveChat(chatId, archived) {
        return this.withChatLock(chatId, () => this.archiveChatLocked(chatId, archived));
    }
    async archiveChatLocked(chatId, archived) {
        if (archived) {
            const status = await this.getChatStatus(chatId);
            if (status.running || status.stateUnknown)
                throw new BridgeError('This chat is running. Interrupt it before archiving.');
            await this.withRunner(() => this.runner.request('thread/archive', { threadId: chatId }).catch((error) => explainWriterLock(error, 'archive the chat')));
        }
        else {
            await this.withRunner(() => this.runner.request('thread/unarchive', { threadId: chatId }).catch((error) => explainWriterLock(error, 'restore the chat')));
        }
        return { chatId, archived };
    }
    listPendingRequests(chatId) {
        return [...this.pending.values()].filter((request) => !chatId || request.chatId === chatId).map((request) => this.describePending(request));
    }
    respondToRequest(requestId, answer, answers, content) {
        const request = this.pending.get(requestId);
        if (!request)
            throw new BridgeError(`No pending request with id ${requestId}. It may have been answered or expired.`);
        const info = this.describePending(request);
        if (!info.answers.includes(answer))
            throw new BridgeError(`Invalid answer "${answer}". Use one of: ${info.answers.join(', ')}.`);
        switch (request.method) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval':
                this.runner.respond(request.rpcId, { decision: answer });
                break;
            case 'execCommandApproval':
            case 'applyPatchApproval': {
                const legacy = { accept: 'approved', acceptForSession: 'approved_for_session', decline: 'denied', cancel: 'abort' };
                this.runner.respond(request.rpcId, { decision: legacy[answer] ?? 'denied' });
                break;
            }
            case 'item/tool/requestUserInput': {
                if (answer === 'cancel') {
                    this.runner.respondError(request.rpcId, -32800, 'Cancelled by the MCP client');
                    break;
                }
                const formatted = {};
                for (const [questionId, values] of Object.entries(answers ?? {}))
                    formatted[questionId] = { answers: values };
                this.runner.respond(request.rpcId, { answers: formatted });
                break;
            }
            case 'mcpServer/elicitation/request':
                this.runner.respond(request.rpcId, { action: answer, content: answer === 'accept' ? (content ?? {}) : null });
                break;
            default:
                this.runner.respondError(request.rpcId, -32800, 'Declined by the MCP client');
        }
        this.pending.delete(requestId);
        return { requestId, answered: answer };
    }
    // ---------------------------------------------------------------- helpers
    /** Operator flags (--sandbox, --approval-policy) win; a caller cannot loosen them. */
    forcedSetting(name, requested) {
        const forced = this.options[name];
        if (forced && requested && requested !== forced) {
            throw new BridgeError(`This server forces ${name} "${forced}", so "${requested}" is not allowed.`);
        }
        return forced ?? requested;
    }
    async withChatLock(chatId, operation) {
        const previous = this.chatLocks.get(chatId) ?? Promise.resolve();
        const run = previous.then(operation, operation);
        const settled = run.catch(() => undefined);
        this.chatLocks.set(chatId, settled);
        try {
            return await run;
        }
        finally {
            if (this.chatLocks.get(chatId) === settled)
                this.chatLocks.delete(chatId);
        }
    }
    statusFromLive(live) {
        return {
            chatId: live.chatId,
            location: 'app',
            running: live.running,
            activeTurnId: live.activeTurnId,
            title: live.title,
            cwd: live.cwd,
            model: live.model,
            reasoningEffort: live.reasoningEffort,
            speed: live.speed,
            lastTurn: live.latestTurnId ? { id: live.latestTurnId, status: live.latestTurnStatus ?? 'unknown', completedAt: null } : null,
            lastAgentMessage: live.lastAgentMessage,
            pendingRequests: live.pendingRequests,
            note: live.pendingRequests.length > 0 ? 'The chat is waiting for an approval or answer in the ChatGPT app.' : undefined,
        };
    }
    /** Persisted history marks a turn that is still running elsewhere as interrupted; correct it from live state. */
    async markRunningTurn(chatId, turns) {
        const last = turns.at(-1);
        if (!last || last.status !== 'interrupted' || last.completedAt)
            return;
        const tracked = this.turns.get(chatId);
        if (tracked?.status === 'inProgress' && tracked.turnId === last.id) {
            last.status = 'inProgress';
            return;
        }
        const live = await this.desktop.liveState(chatId, 'quick').catch(() => ({ state: null, uncertain: true }));
        if (live.state?.activeTurnId === last.id)
            last.status = 'inProgress';
    }
    async resolveTurnOptions(params, currentModel) {
        if (!params.model && !params.effort && !params.speed)
            return {};
        const models = await this.listModels();
        const model = findModel(models, params.model ?? currentModel);
        if (params.model && !model)
            throw new BridgeError(`Unknown model "${params.model}". Use list_models to see available models.`);
        return {
            model: params.model ? model?.id : undefined,
            effort: validateEffort(model, params.effort),
            speed: resolveSpeed(model, params.speed),
        };
    }
    async startBridgeTurn(chatId, text, turn) {
        const tracked = {
            chatId,
            turnId: null,
            status: 'inProgress',
            startedAt: new Date().toISOString(),
            completedAt: null,
            lastAgentMessage: null,
            error: null,
        };
        this.turns.set(chatId, tracked);
        const request = { threadId: chatId, input: textInput(text) };
        if (turn.model)
            request.model = turn.model;
        if (turn.effort)
            request.effort = turn.effort;
        if (turn.speed)
            request.serviceTier = turn.speed;
        try {
            const result = await this.runner.request('turn/start', request);
            const started = isRecord(result) && isRecord(result.turn) ? result.turn : null;
            tracked.turnId = tracked.turnId ?? asString(started?.id);
            const status = asString(started?.status);
            if (status && status !== 'inProgress' && tracked.status === 'inProgress')
                this.completeTrackedTurn(tracked, status, null);
            return tracked.turnId;
        }
        catch (error) {
            if (error instanceof AppServerError && error.code === APP_SERVER_TIMEOUT) {
                // The engine may have accepted the turn. Keep tracking it so the runner is not stopped under it,
                // and tell the caller not to resend blindly.
                this.expireUnconfirmedTurn(tracked);
                throw new BridgeError('The Codex engine did not confirm the message in time. It may still be running; check get_chat_status before sending it again.', { cause: error });
            }
            this.completeTrackedTurn(tracked, 'failed', errorMessage(error));
            throw error;
        }
    }
    expireUnconfirmedTurn(tracked) {
        const timer = setTimeout(() => {
            if (tracked.status === 'inProgress' && tracked.turnId === null && this.turns.get(tracked.chatId) === tracked) {
                this.completeTrackedTurn(tracked, 'failed', 'The engine never confirmed this turn.');
            }
        }, UNCONFIRMED_TURN_TIMEOUT_MS);
        timer.unref();
    }
    handleBusyBridgeChat(params, tracked, whenBusy) {
        if (whenBusy === 'reject') {
            throw new BridgeError('This chat is busy. Use whenBusy "steer" to add the message to the running turn, or "interrupt" to stop it first.');
        }
        const turnId = tracked.turnId;
        if (!turnId) {
            throw new BridgeError('The running turn has not reported its id yet. Try again in a moment.');
        }
        return this.withRunner(async () => {
            if (whenBusy === 'steer') {
                await this.runner.request('turn/steer', { threadId: params.chatId, expectedTurnId: turnId, input: textInput(params.message) });
                return { chatId: params.chatId, deliveredVia: 'bridge', action: 'steered', turnId };
            }
            await this.runner.request('turn/interrupt', { threadId: params.chatId, turnId });
            const stopped = await this.waitForBridgeTurn(params.chatId, 20_000);
            if (!stopped)
                throw new BridgeError('The running turn did not stop in time; the new message was not sent.');
            const meta = await this.threadMeta(params.chatId);
            const turn = await this.resolveTurnOptions(params, meta?.model ?? null);
            const newTurnId = await this.startBridgeTurn(params.chatId, params.message, turn);
            return { chatId: params.chatId, deliveredVia: 'bridge', action: 'interruptedAndStarted', turnId: newTurnId };
        });
    }
    async waitUntilAppIdle(chatId, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const live = await this.desktop.liveState(chatId, 'quick');
            if (!live.state?.running)
                return;
            await sleep(500);
        }
        throw new BridgeError('The running turn did not stop in time; the new message was not sent.');
    }
    /** Resolves true once the bridge turn is no longer running, or false on timeout. */
    waitForBridgeTurn(chatId, timeoutMs) {
        if (this.turns.get(chatId)?.status !== 'inProgress')
            return Promise.resolve(true);
        return new Promise((resolveWait) => {
            const waiters = this.waiters.get(chatId) ?? new Set();
            const done = () => {
                clearTimeout(timer);
                waiters.delete(done);
                resolveWait(this.turns.get(chatId)?.status !== 'inProgress');
            };
            const timer = setTimeout(done, Math.max(0, timeoutMs));
            waiters.add(done);
            this.waiters.set(chatId, waiters);
        });
    }
    async threadMeta(chatId) {
        try {
            const result = await this.reader.request('thread/read', { threadId: chatId, includeTurns: false });
            return isRecord(result) ? summarizeThread(result.thread) : null;
        }
        catch (error) {
            log.debug('thread/read failed', { message: errorMessage(error) });
            return null;
        }
    }
    async recentTurns(chatId, count) {
        const page = await this.reader.request('thread/turns/list', {
            threadId: chatId,
            limit: count,
            sortDirection: 'desc',
            itemsView: 'full',
        });
        const options = { includeToolCalls: false, includeToolOutputs: false, includeReasoning: false, maxCharsPerItem: 8000 };
        return (isRecord(page) ? asArray(page.data) : [])
            .map((turn) => formatTurn(turn, options))
            .filter((turn) => turn !== null)
            .reverse();
    }
    async resolveProjectPath(project, create) {
        const trimmed = project.trim();
        if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
            const path = resolve(expandHome(trimmed));
            if (!existsSync(path)) {
                if (!create)
                    return path;
                throw new BridgeError(`Folder ${path} does not exist.`);
            }
            return path;
        }
        const { projects } = await this.listProjects();
        const wanted = trimmed.toLowerCase();
        const match = projects.find((entry) => entry.label.toLowerCase() === wanted || entry.path.split('/').filter(Boolean).at(-1)?.toLowerCase() === wanted);
        if (!match) {
            throw new BridgeError(`Unknown project "${project}". Pass an absolute folder path or a name from list_projects.`);
        }
        return match.path;
    }
    newChatFolder(prompt) {
        const base = join(isAbsolute(this.options.workspaceRoot) ? this.options.workspaceRoot : resolve(this.options.workspaceRoot), today());
        const slug = slugFromPrompt(prompt);
        let candidate = join(base, slug);
        for (let suffix = 2; existsSync(candidate); suffix += 1)
            candidate = join(base, `${slug}-${suffix}`);
        mkdirSync(candidate, { recursive: true });
        return candidate;
    }
    pendingFor(chatId) {
        return this.listPendingRequests(chatId);
    }
    describePending(request) {
        const params = request.params;
        const base = { requestId: request.key, chatId: request.chatId, turnId: request.turnId, createdAt: request.createdAt };
        switch (request.method) {
            case 'item/commandExecution/requestApproval':
            case 'execCommandApproval': {
                const command = asString(params.command) ?? (Array.isArray(params.command) ? params.command.join(' ') : '');
                const reason = asString(params.reason);
                return {
                    ...base,
                    kind: 'commandApproval',
                    summary: truncate(`Run command: ${command}${reason ? ` (${reason})` : ''}`, 600),
                    answers: ['accept', 'acceptForSession', 'decline', 'cancel'],
                };
            }
            case 'item/fileChange/requestApproval':
            case 'applyPatchApproval':
                return {
                    ...base,
                    kind: 'fileChangeApproval',
                    summary: truncate(`Apply file changes${asString(params.reason) ? `: ${asString(params.reason)}` : ''}`, 600),
                    answers: ['accept', 'acceptForSession', 'decline', 'cancel'],
                };
            case 'item/tool/requestUserInput': {
                const questions = asArray(params.questions)
                    .filter(isRecord)
                    .map((question) => ({
                    id: asString(question.id) ?? '',
                    question: asString(question.question) ?? asString(question.header) ?? '',
                    options: asArray(question.options)
                        .map((option) => (isRecord(option) ? asString(option.label) : asString(option)))
                        .filter((option) => option !== null),
                }));
                return { ...base, kind: 'userInput', summary: 'The agent asked a question.', answers: ['answer', 'cancel'], questions };
            }
            case 'mcpServer/elicitation/request':
                return {
                    ...base,
                    kind: 'mcpElicitation',
                    summary: truncate(`${asString(params.serverName) ?? 'An MCP server'} asks: ${asString(params.message) ?? ''}`, 600),
                    answers: ['accept', 'decline', 'cancel'],
                };
            case 'item/permissions/requestApproval':
                return { ...base, kind: 'permissions', summary: 'The agent asked for extra permissions.', answers: ['decline'] };
            default:
                return { ...base, kind: 'other', summary: request.method, answers: ['decline'] };
        }
    }
    async withRunner(operation) {
        this.cancelRunnerStop();
        this.runnerOperations += 1;
        try {
            return await operation();
        }
        finally {
            this.runnerOperations -= 1;
            this.scheduleRunnerStop();
        }
    }
    runnerBusy() {
        if (this.runnerOperations > 0 || this.pending.size > 0)
            return true;
        for (const tracked of this.turns.values())
            if (tracked.status === 'inProgress')
                return true;
        return false;
    }
    /** Stops the runner once it is idle so the chats it loaded can be opened in the app again. */
    scheduleRunnerStop() {
        this.cancelRunnerStop();
        const timer = setTimeout(() => {
            this.runnerStopTimer = null;
            if (this.runnerBusy() || !this.runner.isRunning())
                return;
            log.debug('stopping idle runner to release chats');
            this.runner.stop();
        }, RUNNER_IDLE_STOP_MS);
        timer.unref();
        this.runnerStopTimer = timer;
    }
    cancelRunnerStop() {
        if (this.runnerStopTimer)
            clearTimeout(this.runnerStopTimer);
        this.runnerStopTimer = null;
    }
    completeTrackedTurn(tracked, status, error) {
        tracked.status = status;
        tracked.completedAt = new Date().toISOString();
        tracked.error = error;
        for (const waiter of this.waiters.get(tracked.chatId) ?? [])
            waiter();
        this.waiters.delete(tracked.chatId);
        for (const [key, request] of this.pending) {
            if (request.chatId === tracked.chatId)
                this.pending.delete(key);
        }
        this.scheduleRunnerStop();
    }
    onNotification(notification) {
        const params = isRecord(notification.params) ? notification.params : {};
        if (notification.method === 'serverRequest/resolved') {
            // The server resolved a request itself (for example a question that timed out); stop offering it.
            const rpcId = params.requestId;
            for (const [key, request] of this.pending) {
                if (request.rpcId === rpcId)
                    this.pending.delete(key);
            }
            this.scheduleRunnerStop();
            return;
        }
        const chatId = asString(params.threadId);
        if (!chatId)
            return;
        const tracked = this.turns.get(chatId);
        if (!tracked)
            return;
        switch (notification.method) {
            case 'turn/started': {
                const turn = isRecord(params.turn) ? params.turn : {};
                tracked.turnId = asString(turn.id) ?? tracked.turnId;
                return;
            }
            case 'turn/completed': {
                const turn = isRecord(params.turn) ? params.turn : {};
                const error = isRecord(turn.error) ? asString(turn.error.message) : null;
                if (tracked.turnId === null || tracked.turnId === asString(turn.id)) {
                    tracked.turnId = asString(turn.id) ?? tracked.turnId;
                    this.completeTrackedTurn(tracked, asString(turn.status) ?? 'completed', error);
                }
                return;
            }
            case 'item/completed': {
                const item = isRecord(params.item) ? params.item : {};
                if (item.type === 'agentMessage' && typeof item.text === 'string')
                    tracked.lastAgentMessage = item.text;
                return;
            }
            default:
                return;
        }
    }
    onServerRequest(request) {
        const params = isRecord(request.params) ? request.params : {};
        const supported = [
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
            'item/tool/requestUserInput',
            'mcpServer/elicitation/request',
            'item/permissions/requestApproval',
            'execCommandApproval',
            'applyPatchApproval',
        ];
        if (!supported.includes(request.method)) {
            this.runner.respondError(request.id, -32601, `chatgpt-desktop-mcp does not handle ${request.method}`);
            return;
        }
        const key = `req_${this.nextPendingKey++}`;
        this.pending.set(key, {
            key,
            rpcId: request.id,
            method: request.method,
            params,
            chatId: asString(params.threadId) ?? asString(params.conversationId),
            turnId: asString(params.turnId),
            createdAt: new Date().toISOString(),
        });
        log.info('chat is waiting for an answer', { requestId: key, method: request.method });
    }
    onRunnerExit() {
        for (const tracked of this.turns.values()) {
            if (tracked.status === 'inProgress')
                this.completeTrackedTurn(tracked, 'failed', 'codex app-server stopped');
        }
        this.pending.clear();
    }
}
