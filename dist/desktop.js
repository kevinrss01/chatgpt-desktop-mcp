import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { IpcRequestError } from './ipc.js';
import { APP_BUNDLE_PATHS } from './paths.js';
import { asArray, asString, isRecord, sleep } from './util.js';
const HOST_ID = 'local';
/** An app window that owns a chat answers in milliseconds. */
const QUICK_PROBE_MS = 2_000;
/** The IPC router reports "no-client-found" only after its 10 second discovery timeout. */
const DEFINITIVE_PROBE_MS = 12_500;
function textInput(text) {
    return [{ type: 'text', text, text_elements: [] }];
}
function turnEntities(state) {
    const history = isRecord(state.turnHistory) && isRecord(state.turnHistory.history) ? state.turnHistory.history : null;
    const fromHistory = history && isRecord(history.entitiesByKey) ? Object.values(history.entitiesByKey) : [];
    const legacy = Array.isArray(state.turns) ? state.turns : [];
    const entities = [...legacy, ...fromHistory].filter(isRecord);
    return entities.sort((a, b) => Number(a.turnStartedAtMs ?? 0) - Number(b.turnStartedAtMs ?? 0));
}
function lastAgentText(entity) {
    if (!entity)
        return null;
    const items = asArray(entity.items).filter(isRecord);
    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim())
            return item.text;
    }
    return null;
}
/** Extracts the fields an agent needs from the app's internal conversation snapshot. */
export function parseLiveState(chatId, state, settings) {
    const runtime = isRecord(state.threadRuntimeStatus) ? state.threadRuntimeStatus : {};
    const runtimeStatus = asString(runtime.type) ?? 'unknown';
    const entities = turnEntities(state);
    const active = entities.find((entity) => entity.status === 'inProgress');
    const latest = entities.at(-1);
    const threadSettings = isRecord(state.latestThreadSettings) ? state.latestThreadSettings : {};
    const sandboxPolicy = isRecord(threadSettings.sandboxPolicy) ? threadSettings.sandboxPolicy : {};
    const requests = asArray(state.requests).filter(isRecord);
    return {
        chatId,
        running: active !== undefined || runtimeStatus === 'active',
        runtimeStatus,
        activeFlags: asArray(runtime.activeFlags).filter((flag) => typeof flag === 'string'),
        activeTurnId: asString(active?.turnId),
        latestTurnId: asString(latest?.turnId),
        latestTurnStatus: asString(latest?.status),
        title: asString(state.title),
        cwd: asString(threadSettings.cwd) ?? asString(state.cwd),
        model: asString(threadSettings.model) ?? settings.model,
        reasoningEffort: asString(threadSettings.effort) ?? settings.reasoningEffort,
        speed: asString(threadSettings.serviceTier),
        approvalPolicy: asString(threadSettings.approvalPolicy),
        sandbox: asString(sandboxPolicy.type),
        pendingRequests: requests.map((request) => ({ type: asString(request.method) ?? asString(request.type) ?? 'unknown' })),
        lastAgentMessage: lastAgentText(latest),
    };
}
/** Live control of chats that are open in a ChatGPT desktop app window. */
export class DesktopApp {
    ipc;
    snapshotsInFlight = new Map();
    constructor(ipc) {
        this.ipc = ipc;
    }
    isRunning() {
        return this.ipc.isAvailable();
    }
    /** Open the stored chat normally, then wait until the app actually owns it. */
    async openChat(chatId) {
        const app = APP_BUNDLE_PATHS.find((path) => existsSync(path));
        if (!app)
            throw new IpcRequestError('app-not-installed', 'The Codex desktop app was not found.');
        await promisify(execFile)('/usr/bin/open', ['-g', '-a', app, `codex://threads/${encodeURIComponent(chatId)}`]);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            const { settings } = await this.ownedChatSettings(chatId, 'quick');
            if (settings?.resumeState === 'resumed') {
                const { state } = await this.liveState(chatId);
                if (state)
                    return state;
            }
            await sleep(250);
        }
        throw new IpcRequestError('handoff-timeout', `The desktop app did not take ownership of chat ${chatId}. No message was sent. Open the chat and retry send_message.`);
    }
    /**
     * Returns the app's settings for a chat that an app window currently owns,
     * or null when no window owns it (or the app is not running).
     */
    async ownedChatSettings(chatId, mode = 'quick') {
        if (!this.ipc.isAvailable())
            return { settings: null, uncertain: false };
        let result;
        try {
            result = await this.ipc.request('thread-follower-read-model-settings', { conversationId: chatId }, mode === 'quick' ? QUICK_PROBE_MS : DEFINITIVE_PROBE_MS);
        }
        catch (error) {
            if (error instanceof IpcRequestError) {
                if (error.code === 'no-client-found' || error.code === 'app-not-running')
                    return { settings: null, uncertain: false };
                if (error.code === 'timeout' && mode === 'quick')
                    return { settings: null, uncertain: true };
            }
            throw error;
        }
        const settings = isRecord(result) && isRecord(result.settings) ? result.settings : null;
        if (!settings)
            return { settings: null, uncertain: false };
        return {
            settings: {
                model: asString(settings.model),
                reasoningEffort: asString(settings.reasoningEffort),
                mode: asString(settings.mode),
                resumeState: asString(settings.resumeState),
            },
            uncertain: false,
        };
    }
    async liveState(chatId, mode = 'quick') {
        const { settings, uncertain } = await this.ownedChatSettings(chatId, mode);
        if (!settings)
            return { state: null, uncertain };
        const snapshot = await this.snapshot(chatId);
        if (!snapshot) {
            // Owned but no state: never guess "idle", since callers decide whether to send based on it.
            throw new IpcRequestError('snapshot-unavailable', 'The ChatGPT app has this chat open but did not report its live state. Try again.');
        }
        return { state: parseLiveState(chatId, snapshot, settings), uncertain: false };
    }
    /**
     * Model and reasoning effort live in the chat's collaboration settings, so the
     * app ignores them inside a turn request. Like the app's model picker, set them
     * for the next turn first.
     */
    async updateNextTurnSettings(chatId, settings) {
        const result = await this.ipc.request('thread-follower-update-thread-settings', { conversationId: chatId, threadSettings: settings }, 15_000);
        return isRecord(result) && result.applied === true;
    }
    async startTurn(chatId, options) {
        const request = { threadId: chatId, input: textInput(options.text) };
        if (options.model)
            request.model = options.model;
        if (options.effort)
            request.effort = options.effort;
        if (options.speed)
            request.serviceTier = options.speed;
        return this.ipc.request('thread-follower-start-turn', { conversationId: chatId, turnStart: { request, context: {} } }, 60_000);
    }
    /** The app restores restoreMessage into the composer if steering fails, so it mirrors a composer message. */
    async steerTurn(chatId, text, cwd) {
        const restoreMessage = {
            id: randomUUID(),
            text,
            context: {
                prompt: text,
                addedFiles: [],
                fileAttachments: [],
                ideContext: null,
                imageAttachments: [],
                workspaceRoots: cwd ? [cwd] : [],
            },
        };
        return this.ipc.request('thread-follower-steer-turn', { conversationId: chatId, input: textInput(text), restoreMessage, clientUserMessageId: restoreMessage.id }, 30_000);
    }
    async interruptTurn(chatId, expectedTurnId) {
        return this.ipc.request('thread-follower-interrupt-turn', { conversationId: chatId, mode: 'user-stop', expectedTurnId }, 30_000);
    }
    /**
     * Follows the chat just long enough to receive the owner's snapshot, then
     * stops following so the app does not keep streaming patches to this client.
     */
    snapshot(chatId, timeoutMs = 5_000) {
        const existing = this.snapshotsInFlight.get(chatId);
        if (existing)
            return existing;
        const promise = new Promise((resolve) => {
            let settled = false;
            const finish = (value) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                stopListening();
                void this.ipc
                    .broadcast('thread-stream-following-changed', { conversationId: chatId, hostId: HOST_ID, following: false })
                    .catch(() => undefined);
                resolve(value);
            };
            const stopListening = this.ipc.onBroadcast((message) => {
                if (message.method !== 'thread-stream-state-changed' || !isRecord(message.params))
                    return;
                if (message.params.conversationId !== chatId || !isRecord(message.params.change))
                    return;
                const change = message.params.change;
                if (change.type === 'snapshot' && isRecord(change.conversationState))
                    finish(change.conversationState);
            });
            const timer = setTimeout(() => finish(null), timeoutMs);
            this.ipc
                .broadcast('thread-stream-following-changed', { conversationId: chatId, hostId: HOST_ID, following: true })
                .catch(() => finish(null));
        }).finally(() => {
            this.snapshotsInFlight.delete(chatId);
        });
        this.snapshotsInFlight.set(chatId, promise);
        return promise;
    }
}
