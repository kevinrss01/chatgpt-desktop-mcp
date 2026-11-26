import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { APP_SERVER_TIMEOUT, AppServerClient, AppServerError, type AppServerNotification, type AppServerRequest } from './appServer.js';
import { findModel, parseModel, resolveSpeed, validateEffort, type ModelInfo } from './catalog.js';
import { DesktopApp, type LiveChatState } from './desktop.js';
import { formatTurn, lastAgentMessage, summarizeThread, type ChatSummary, type FormatOptions, type FormattedTurn } from './format.js';
import { IpcRequestError } from './ipc.js';
import { log } from './log.js';
import { globalStatePath } from './paths.js';
import { BridgeError, asArray, asString, errorMessage, isRecord, sleep, truncate } from './util.js';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type WhenBusy = 'reject' | 'queue' | 'steer' | 'interrupt';

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
/** How long to wait for the app to pick up a queued message; it may need to launch first. */
const APP_PICKUP_TIMEOUT_MS = 30_000;

const APP_LIVE_CONTROL_REMOVED =
  'The ChatGPT app (26.1120 and later) no longer lets other processes steer or interrupt a turn it is running.';

export interface BridgeOptions {
  workspaceRoot: string;
  /** Forced for every chat this bridge starts or resumes; undefined inherits the user's Codex config. */
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  /** How long to wait for the app to pick up a queued message. Default 30 seconds. */
  appPickupTimeoutMs?: number;
}

interface TrackedTurn {
  chatId: string;
  turnId: string | null;
  status: string;
  startedAt: string;
  completedAt: string | null;
  lastAgentMessage: string | null;
  error: string | null;
}

interface PendingServerRequest {
  key: string;
  rpcId: string | number;
  method: string;
  params: Record<string, unknown>;
  chatId: string | null;
  turnId: string | null;
  createdAt: string;
}

export interface PendingRequestInfo {
  requestId: string;
  chatId: string | null;
  turnId: string | null;
  kind: 'commandApproval' | 'fileChangeApproval' | 'userInput' | 'mcpElicitation' | 'permissions' | 'other';
  createdAt: string;
  summary: string;
  answers: string[];
  questions?: Array<{ id: string; question: string; options: string[] }>;
}

export type ChatLocation = 'app' | 'bridge' | 'stored';

export interface ChatStatus {
  chatId: string;
  location: ChatLocation;
  running: boolean;
  activeTurnId: string | null;
  title: string | null;
  cwd: string | null;
  model: string | null;
  reasoningEffort: string | null;
  speed: string | null;
  lastTurn: { id: string; status: string; completedAt: string | null } | null;
  lastAgentMessage: string | null;
  pendingRequests: Array<{ type: string; requestId?: string }>;
  /** True when the app has the chat open but its live state could not be read; treat it as possibly running. */
  stateUnknown?: boolean;
  /** Messages waiting in the chat's queue; the app sends them one by one as turns end. */
  queuedMessages?: number;
  note?: string;
}

export interface TurnOptions {
  model?: string;
  effort?: string;
  speed?: string;
}

export interface CreateChatParams extends TurnOptions {
  execution?: 'app' | 'background';
  prompt?: string;
  project?: string;
  title?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
}

export interface SendMessageParams extends TurnOptions {
  execution?: 'app' | 'background';
  chatId: string;
  message: string;
  whenBusy?: WhenBusy;
}

export interface SendResult {
  chatId: string;
  deliveredVia: 'app' | 'bridge';
  /** queued: the message waits in the chat's queue and the app sends it when the chat is free. */
  action: 'started' | 'queued' | 'steered' | 'interruptedAndStarted';
  turnId: string | null;
  queuedMessageId?: string;
  note?: string;
}

export interface ListChatsParams {
  limit?: number;
  cursor?: string;
  project?: string;
  search?: string;
  archived?: boolean;
  includeBackground?: boolean;
}

export interface ReadChatParams extends Partial<FormatOptions> {
  chatId: string;
  turns?: number;
  cursor?: string;
}

function slugFromPrompt(prompt: string | undefined): string {
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

function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
}

function textInput(text: string) {
  return [{ type: 'text', text, text_elements: [] }];
}

/**
 * History written by another process shows a turn that is still running as
 * "interrupted" with no completion time; finished turns always have one.
 */
function looksRunning(turn: FormattedTurn | null | undefined): boolean {
  return Boolean(turn && !turn.completedAt && (turn.status === 'inProgress' || turn.status === 'interrupted'));
}

/** Codex allows one writer per chat; explain the lock instead of surfacing the raw error. */
function explainWriterLock(error: unknown, action: string): never {
  if (/active writer/i.test(errorMessage(error))) {
    throw new BridgeError(
      `Cannot ${action}: another Codex process has this chat loaded, usually the ChatGPT app because the chat is open there. Do it from the app, or try again after the app releases the chat.`,
      { cause: error },
    );
  }
  throw error;
}

/**
 * High-level operations exposed as MCP tools. Chats open in a ChatGPT window
 * are driven through the app (live in its UI); everything else goes through a
 * private app-server process that shares the app's chat storage.
 */
export class DesktopBridge {
  private readonly turns = new Map<string, TrackedTurn>();
  private readonly pending = new Map<string, PendingServerRequest>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly chatLocks = new Map<string, Promise<unknown>>();
  private runnerStopTimer: NodeJS.Timeout | null = null;
  private runnerOperations = 0;
  private modelCache: { at: number; models: ModelInfo[] } | null = null;
  private nextPendingKey = 1;

  /**
   * @param reader long-lived app-server for lists, history, and models; it never loads chats.
   * @param runner app-server that starts and runs turns; stopped when idle to release chats.
   */
  constructor(
    private readonly reader: AppServerClient,
    private readonly runner: AppServerClient,
    private readonly desktop: DesktopApp,
    private readonly options: BridgeOptions,
  ) {
    runner.on('notification', (notification: AppServerNotification) => this.onNotification(notification));
    runner.on('serverRequest', (request: AppServerRequest) => this.onServerRequest(request));
    runner.on('exit', () => this.onRunnerExit());
  }

  // ---------------------------------------------------------------- catalog

  async listModels(refresh = false): Promise<ModelInfo[]> {
    if (!refresh && this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS) return this.modelCache.models;
    const models: ModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const page: unknown = await this.reader.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
      const data = isRecord(page) ? asArray(page.data) : [];
      for (const entry of data) {
        const model = parseModel(entry);
        if (model) models.push(model);
      }
      cursor = isRecord(page) ? asString(page.nextCursor) : null;
    } while (cursor);
    this.modelCache = { at: Date.now(), models };
    return models;
  }

  async listProjects(): Promise<{ projects: Array<{ path: string; label: string; exists: boolean }>; recentFolders: Array<{ path: string; chats: number; lastActivity: string | null }> }> {
    const projects: Array<{ path: string; label: string; exists: boolean }> = [];
    try {
      const state: unknown = JSON.parse(readFileSync(globalStatePath(), 'utf8'));
      if (isRecord(state)) {
        const labels = isRecord(state['electron-workspace-root-labels']) ? state['electron-workspace-root-labels'] : {};
        for (const root of asArray(state['electron-saved-workspace-roots'])) {
          if (typeof root !== 'string') continue;
          const label = asString(labels[root]) ?? root.split('/').filter(Boolean).at(-1) ?? root;
          projects.push({ path: root, label, exists: existsSync(root) });
        }
      }
    } catch (error) {
      log.debug('could not read desktop project list', { message: errorMessage(error) });
    }
    const recent = new Map<string, { chats: number; lastActivity: string | null }>();
    const page = await this.listChats({ limit: 100 });
    for (const chat of page.chats) {
      if (!chat.cwd) continue;
      const entry = recent.get(chat.cwd) ?? { chats: 0, lastActivity: null };
      entry.chats += 1;
      if (!entry.lastActivity || (chat.updatedAt && chat.updatedAt > entry.lastActivity)) entry.lastActivity = chat.updatedAt;
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

  async listChats(params: ListChatsParams): Promise<{ chats: Array<ChatSummary & { runningViaBridge?: boolean }>; nextCursor: string | null }> {
    const request: Record<string, unknown> = {
      limit: Math.min(Math.max(params.limit ?? 20, 1), 100),
      sortKey: 'updated_at',
      sortDirection: 'desc',
      sourceKinds: params.includeBackground ? ALL_SOURCE_KINDS : USER_SOURCE_KINDS,
      archived: params.archived ?? false,
    };
    if (params.cursor) request.cursor = params.cursor;
    if (params.search) request.searchTerm = params.search;
    if (params.project) request.cwd = await this.resolveProjectPath(params.project, false);
    const result: unknown = await this.reader.request('thread/list', request);
    const chats = (isRecord(result) ? asArray(result.data) : [])
      .map((thread) => summarizeThread(thread))
      .filter((chat): chat is ChatSummary => chat !== null)
      .map((chat) => (this.turns.get(chat.id)?.status === 'inProgress' ? { ...chat, runningViaBridge: true } : chat));
    return { chats, nextCursor: isRecord(result) ? asString(result.nextCursor) : null };
  }

  async readChat(params: ReadChatParams): Promise<{ chat: ChatSummary | null; turns: FormattedTurn[]; olderCursor: string | null }> {
    const options: FormatOptions = {
      includeToolCalls: params.includeToolCalls ?? true,
      includeToolOutputs: params.includeToolOutputs ?? false,
      includeReasoning: params.includeReasoning ?? false,
      maxCharsPerItem: Math.min(Math.max(params.maxCharsPerItem ?? 4000, 200), 50_000),
    };
    const [thread, page] = await Promise.all([
      this.reader.request<unknown>('thread/read', { threadId: params.chatId, includeTurns: false }),
      this.reader.request<unknown>('thread/turns/list', {
        threadId: params.chatId,
        limit: Math.min(Math.max(params.turns ?? 5, 1), 50),
        sortDirection: 'desc',
        itemsView: 'full',
        ...(params.cursor ? { cursor: params.cursor } : {}),
      }),
    ]);
    const turns = (isRecord(page) ? asArray(page.data) : [])
      .map((turn) => formatTurn(turn, options))
      .filter((turn): turn is FormattedTurn => turn !== null)
      .reverse();
    await this.markRunningTurn(params.chatId, turns);
    return {
      chat: isRecord(thread) ? summarizeThread(thread.thread) : null,
      turns,
      olderCursor: isRecord(page) ? asString(page.nextCursor) : null,
    };
  }

  async getChatStatus(chatId: string): Promise<ChatStatus> {
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

    let live: { state: LiveChatState | null; uncertain: boolean };
    try {
      live = await this.desktop.liveState(chatId, 'quick');
    } catch (error) {
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
    if (live.state) return this.statusFromLive(live.state);

    const [meta, history, queued] = await Promise.all([
      this.threadMeta(chatId),
      this.recentTurns(chatId, 1),
      this.queuedMessageIds(chatId).catch(() => [] as string[]),
    ]);
    const last = history.at(-1) ?? null;
    // Without live control, a turn the app is running shows up only in stored history.
    const runningElsewhere = looksRunning(last);
    let note: string | undefined;
    if (runningElsewhere) {
      note = 'The last turn has no completion record yet, so it is treated as running (usually in the ChatGPT app). A turn that crashed also looks like this.';
    } else if (queued.length > 0) {
      note = 'Messages are queued; the ChatGPT app sends them when it opens or wakes the chat.';
    }
    return {
      chatId,
      location: runningElsewhere ? 'app' : 'stored',
      running: runningElsewhere,
      activeTurnId: runningElsewhere ? last?.id ?? null : null,
      title: meta?.title ?? null,
      cwd: meta?.cwd ?? null,
      model: meta?.model ?? null,
      reasoningEffort: meta?.reasoningEffort ?? null,
      speed: null,
      lastTurn: last ? { id: last.id, status: last.status, completedAt: last.completedAt } : null,
      lastAgentMessage: lastAgentMessage(history) ?? tracked?.lastAgentMessage ?? null,
      pendingRequests: [],
      queuedMessages: queued.length,
      note,
    };
  }

  async waitForChat(chatId: string, timeoutMs: number): Promise<ChatStatus & { timedOut: boolean }> {
    const deadline = Date.now() + timeoutMs;
    let status = await this.getChatStatus(chatId);
    while ((status.running || status.stateUnknown || (status.queuedMessages ?? 0) > 0) && Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (status.location === 'bridge') await this.waitForBridgeTurn(chatId, remaining);
      else await sleep(Math.min(2_500, remaining));
      status = await this.getChatStatus(chatId);
    }
    if (!status.running && status.location !== 'stored' && status.lastAgentMessage === null) {
      const history = await this.recentTurns(chatId, 1).catch(() => []);
      status = { ...status, lastAgentMessage: lastAgentMessage(history) };
    }
    return { ...status, timedOut: status.running || status.stateUnknown === true };
  }

  // --------------------------------------------------------------- controls

  async createChat(params: CreateChatParams): Promise<{ chatId: string; turnId: string | null; turnStarted: boolean; deliveredVia: 'app' | 'bridge'; cwd: string; model: string | null; reasoningEffort: string | null; speed: string | null; queuedMessageId?: string; note?: string }> {
    const inApp = params.execution !== 'background';
    const sandbox = this.forcedSetting('sandbox', params.sandbox);
    const approvalPolicy = this.forcedSetting('approvalPolicy', params.approvalPolicy);
    if (inApp && (sandbox || approvalPolicy)) {
      throw new BridgeError('Desktop chats use the permissions selected in the app. Explicit sandbox or approvalPolicy overrides require execution "background"; they cannot be silently applied to an app-owned chat.');
    }
    const cwd = params.project ? await this.resolveProjectPath(params.project, true) : this.newChatFolder(params.prompt);
    const models = await this.listModels();
    const model = params.model ? findModel(models, params.model) : models.find((entry) => entry.isDefault);
    if (params.model && !model) throw new BridgeError(`Unknown model "${params.model}". Use list_models to see available models.`);
    const effort = validateEffort(model, params.effort);
    const speed = resolveSpeed(model, params.speed);

    const start: Record<string, unknown> = { cwd, serviceName: 'chatgpt-desktop-mcp', ...(inApp ? { config: { thread_unload_delay_secs: 0 } } : {}) };
    if (params.model && model) start.model = model.id;
    if (speed) start.serviceTier = speed;
    if (sandbox) start.sandbox = sandbox;
    if (approvalPolicy) start.approvalPolicy = approvalPolicy;

    const { started, chatId, turnId: bridgeTurnId, settings } = await this.withRunner(async () => {
      const response: unknown = await this.runner.request('thread/start', start);
      const thread = isRecord(response) && isRecord(response.thread) ? response.thread : null;
      const id = asString(thread?.id);
      if (!id) throw new BridgeError('codex app-server did not return a chat id.');
      if (params.title) await this.runner.request('thread/name/set', { threadId: id, name: params.title });
      let applied: { model: string | null; effort: string | null; speed: string | null } | null = null;
      if (inApp) {
        // thread/start settings live only in this process until a turn runs, so the
        // app would open the chat with its own defaults. Persist them in the chat first.
        applied = {
          model: (params.model ? model?.id : null) ?? asString(isRecord(response) ? response.model : null) ?? model?.id ?? null,
          effort: effort ?? asString(isRecord(response) ? response.reasoningEffort : null),
          speed: speed ?? asString(isRecord(response) ? response.serviceTier : null),
        };
        if (applied.model) await this.persistSettings(id, { model: applied.model, effort: applied.effort, speed: speed ?? null });
        // The app must own the chat before anything runs. Unsubscribe only this idle
        // chat, so other background jobs are not interrupted.
        await this.runner.request('thread/unsubscribe', { threadId: id });
        await this.waitUntilRunnerReleases(id);
      }
      const firstTurn = !inApp && params.prompt
        ? await this.startBridgeTurn(id, params.prompt, { model: params.model ? model?.id : undefined, effort, speed })
        : null;
      return { started: response, chatId: id, turnId: firstTurn, settings: applied };
    });
    let turnId = bridgeTurnId;
    let turnStarted = Boolean(params.prompt);
    let queuedMessageId: string | undefined;
    let note: string | undefined;
    if (inApp) {
      if (params.prompt) {
        const delivered = await this.withChatLock(chatId, () => this.queueForApp(chatId, params.prompt as string, { discardChatOnFailure: true }));
        turnId = delivered.turnId;
        turnStarted = delivered.action === 'started';
        queuedMessageId = delivered.queuedMessageId;
        note = delivered.note;
      } else {
        await this.desktop.revealChat(chatId).catch((error: unknown) => {
          note = `The chat was created but could not be shown in the app: ${errorMessage(error)}`;
        });
      }
    }
    return {
      chatId,
      turnId,
      turnStarted,
      deliveredVia: inApp ? 'app' : 'bridge',
      cwd,
      model: settings?.model ?? (params.model ? model?.id ?? null : asString(isRecord(started) ? started.model : null) ?? model?.id ?? null),
      reasoningEffort: settings ? settings.effort : effort ?? asString(isRecord(started) ? started.reasoningEffort : null),
      speed: settings ? settings.speed : speed ?? asString(isRecord(started) ? started.serviceTier : null),
      ...(queuedMessageId ? { queuedMessageId } : {}),
      ...(note ? { note } : {}),
    };
  }

  /** Writes model, effort, and speed into a chat this runner has loaded, so whoever opens it next uses them. */
  private async persistSettings(chatId: string, settings: { model: string; effort: string | null; speed: string | null }): Promise<void> {
    await this.runner.request('thread/settings/update', {
      threadId: chatId,
      model: settings.model,
      effort: settings.effort,
      ...(settings.speed ? { serviceTier: settings.speed } : {}),
      collaborationMode: { mode: 'default', settings: { model: settings.model, reasoning_effort: settings.effort, developer_instructions: null } },
    });
  }

  /**
   * Delivers a message through the app: adds it to the chat's server-side queue,
   * then asks the app to wake the chat. The app sends queued messages itself,
   * one per turn, so the chat runs live in its window. Resolves "queued" when the
   * app has not picked the message up yet; it stays queued and is never resent.
   */
  private async queueForApp(chatId: string, text: string, options: { discardChatOnFailure?: boolean } = {}): Promise<SendResult> {
    const previousTurnId = (await this.recentTurns(chatId, 1).catch(() => [])).at(-1)?.id ?? null;
    let queuedMessageId: string | null;
    try {
      const added: unknown = await this.reader.request('thread/queue/add', { threadId: chatId, clientUserMessageId: randomUUID(), input: textInput(text) });
      queuedMessageId = isRecord(added) && isRecord(added.queuedSubmission) ? asString(added.queuedSubmission.id) : null;
      if (!queuedMessageId) throw new BridgeError('codex app-server did not confirm the queued message.');
    } catch (error) {
      if (options.discardChatOnFailure) {
        // Nothing was sent, so do not leave an empty chat behind in the sidebar.
        const discarded = await this.withRunner(() => this.runner.request('thread/archive', { threadId: chatId })).then(() => true, () => false);
        throw new BridgeError(
          `Could not queue the message for the ChatGPT app: ${errorMessage(error)}. ${discarded ? 'The new empty chat was archived; it is safe to retry.' : `Chat ${chatId} was created but is empty; reuse it with send_message instead of creating a duplicate.`}`,
          { cause: error },
        );
      }
      throw error;
    }
    try {
      await this.desktop.wakeChat(chatId);
    } catch (error) {
      return {
        chatId,
        deliveredVia: 'app',
        action: 'queued',
        turnId: null,
        queuedMessageId,
        note: `The message is queued in the chat, but the ChatGPT app could not be woken (${errorMessage(error)}). It is sent when the chat is opened in the app. Do not send it again.`,
      };
    }
    const picked = await this.waitForQueuePickup(chatId, queuedMessageId, this.options.appPickupTimeoutMs ?? APP_PICKUP_TIMEOUT_MS);
    if (picked) {
      const turnId = await this.waitForNewTurn(chatId, previousTurnId, 10_000);
      return { chatId, deliveredVia: 'app', action: 'started', turnId, queuedMessageId };
    }
    return {
      chatId,
      deliveredVia: 'app',
      action: 'queued',
      turnId: null,
      queuedMessageId,
      note: 'The message is queued. The ChatGPT app sends it when the current turn ends, or when the chat is opened in the app. Do not send it again.',
    };
  }

  /** Resolves true once the app has taken the message off the queue (it starts a turn when it does). */
  private async waitForQueuePickup(chatId: string, queuedMessageId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      await sleep(500);
      const queued = await this.queuedMessageIds(chatId).catch(() => null);
      if (queued && !queued.includes(queuedMessageId)) return true;
    } while (Date.now() < deadline);
    return false;
  }

  /** The started turn reaches stored history shortly after pickup; wait for it so callers never read the previous turn. */
  private async waitForNewTurn(chatId: string, previousTurnId: string | null, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    do {
      const last = (await this.recentTurns(chatId, 1).catch(() => [])).at(-1);
      if (last && last.id !== previousTurnId) return last.id;
      await sleep(300);
    } while (Date.now() < deadline);
    return null;
  }

  private async queuedMessageIds(chatId: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: unknown = await this.reader.request('thread/queue/list', { threadId: chatId, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const item of isRecord(page) ? asArray(page.data) : []) {
        const id = isRecord(item) ? asString(item.id) : null;
        if (id) ids.push(id);
      }
      cursor = isRecord(page) ? asString(page.nextCursor) : null;
    } while (cursor);
    return ids;
  }

  private async waitUntilRunnerReleases(chatId: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    do {
      let cursor: string | null = null;
      let loaded = false;
      do {
        const page: unknown = await this.runner.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!isRecord(page) || !Array.isArray(page.data)) throw new BridgeError('Could not confirm that the background engine released the chat.');
        loaded = page.data.includes(chatId);
        cursor = asString(page.nextCursor);
      } while (!loaded && cursor && Date.now() < deadline);
      if (!loaded && !cursor) return;
      await sleep(100);
    } while (Date.now() < deadline);
    throw new BridgeError(`The background engine has not released chat ${chatId}. No prompt was sent.`);
  }

  sendMessage(params: SendMessageParams): Promise<SendResult> {
    // Serialize actions per chat so two callers cannot both see it idle and start two turns.
    return this.withChatLock(params.chatId, () => this.sendMessageLocked(params));
  }

  private async sendMessageLocked(params: SendMessageParams): Promise<SendResult> {
    const whenBusy = params.whenBusy ?? 'reject';
    const tracked = this.turns.get(params.chatId);
    if (tracked?.status === 'inProgress') {
      return this.handleBusyBridgeChat(params, tracked, whenBusy);
    }

    let live: LiveChatState | null;
    try {
      live = (await this.desktop.liveState(params.chatId, 'definitive')).state;
    } catch (error) {
      throw new BridgeError(
        `The ChatGPT app did not confirm whether it has this chat open (${errorMessage(error)}). The message was not sent, to avoid running it twice.`,
        { cause: error },
      );
    }

    if (!live && params.execution !== 'background') {
      if (this.options.sandbox || this.options.approvalPolicy) {
        throw new BridgeError('This bridge forces permission overrides. Use execution "background" or open the chat in the app and use its permissions.');
      }
      return this.sendThroughAppQueue(params, whenBusy);
    }

    if (live) {
      const turn = await this.resolveTurnOptions(params, live.model);
      const startInApp = async () => {
        if (turn.model || turn.effort) {
          const model = turn.model ?? live.model;
          if (!model) throw new BridgeError('The app did not report a model for this chat, so the reasoning effort cannot be changed.');
          const applied = await this.desktop.updateNextTurnSettings(params.chatId, { model, effort: turn.effort ?? live.reasoningEffort });
          if (!applied) throw new BridgeError('The ChatGPT app did not apply the model settings; the message was not sent.');
        }
        await this.desktop.startTurn(params.chatId, { text: params.message, speed: turn.speed }).catch((error: unknown) => {
          if (error instanceof IpcRequestError && error.code === 'timeout') {
            throw new BridgeError(
              'The ChatGPT app did not confirm the message in time. It may still have been sent; check get_chat_status or read_chat before sending it again.',
              { cause: error },
            );
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
        if (live.activeTurnId) await this.desktop.interruptTurn(params.chatId, live.activeTurnId);
        await this.waitUntilAppIdle(params.chatId, 20_000);
        await startInApp();
        return { chatId: params.chatId, deliveredVia: 'app', action: 'interruptedAndStarted', turnId: null };
      }
      await startInApp();
      return { chatId: params.chatId, deliveredVia: 'app', action: 'started', turnId: null };
    }

    const meta = await this.threadMeta(params.chatId);
    if (!meta) throw new BridgeError(`Chat ${params.chatId} was not found.`);
    const turn = await this.resolveTurnOptions(params, meta.model);
    const resume: Record<string, unknown> = { threadId: params.chatId, excludeTurns: true };
    if (turn.model) resume.model = turn.model;
    if (this.options.sandbox) resume.sandbox = this.options.sandbox;
    if (this.options.approvalPolicy) resume.approvalPolicy = this.options.approvalPolicy;
    const turnId = await this.withRunner(async () => {
      await this.runner.request('thread/resume', resume).catch((error: unknown) => explainWriterLock(error, 'send the message'));
      return this.startBridgeTurn(params.chatId, params.message, turn);
    });
    return { chatId: params.chatId, deliveredVia: 'bridge', action: 'started', turnId };
  }

  /** Follow-ups for chats the app cannot be driven live for: queue the message and let the app send it. */
  private async sendThroughAppQueue(params: SendMessageParams, whenBusy: WhenBusy): Promise<SendResult> {
    const meta = await this.threadMeta(params.chatId);
    if (!meta) throw new BridgeError(`Chat ${params.chatId} was not found.`);
    const [history, queued] = await Promise.all([
      this.recentTurns(params.chatId, 1).catch(() => []),
      this.queuedMessageIds(params.chatId).catch(() => []),
    ]);
    const busy = looksRunning(history.at(-1)) || queued.length > 0;
    if (busy && whenBusy === 'reject') {
      throw new BridgeError('This chat is running in the ChatGPT app or already has queued messages. Use whenBusy "queue" to send this message after the current work.');
    }
    if (busy && (whenBusy === 'steer' || whenBusy === 'interrupt')) {
      throw new BridgeError(`${APP_LIVE_CONTROL_REMOVED} Use whenBusy "queue" to send this message after the current turn, or steer it from the app.`);
    }
    if (params.model || params.effort || params.speed) {
      const turn = await this.resolveTurnOptions(params, meta.model);
      const model = turn.model ?? meta.model;
      if (!model) throw new BridgeError('This chat has no recorded model, so its reasoning effort cannot be changed.');
      await this.withRunner(async () => {
        await this.runner
          .request('thread/resume', { threadId: params.chatId, excludeTurns: true, config: { thread_unload_delay_secs: 0 } })
          .catch((error: unknown) => {
            if (/active writer/i.test(errorMessage(error))) {
              throw new BridgeError(
                'The chat is loaded in the ChatGPT app, which owns its model settings, so they cannot be changed from here. The message was not sent. Send it without model, effort, or speed, or change them in the app.',
                { cause: error },
              );
            }
            throw error;
          });
        await this.persistSettings(params.chatId, { model, effort: turn.effort ?? meta.reasoningEffort ?? null, speed: turn.speed ?? null });
        await this.runner.request('thread/unsubscribe', { threadId: params.chatId });
        await this.waitUntilRunnerReleases(params.chatId);
      });
    }
    return this.queueForApp(params.chatId, params.message);
  }

  interruptChat(chatId: string): Promise<{ chatId: string; interrupted: boolean; via: 'app' | 'bridge' | null; turnId: string | null }> {
    return this.withChatLock(chatId, () => this.interruptChatLocked(chatId));
  }

  private async interruptChatLocked(chatId: string): Promise<{ chatId: string; interrupted: boolean; via: 'app' | 'bridge' | null; turnId: string | null }> {
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
    if (!live && looksRunning((await this.recentTurns(chatId, 1).catch(() => [])).at(-1))) {
      throw new BridgeError(`${APP_LIVE_CONTROL_REMOVED} Stop it from the app.`);
    }
    return { chatId, interrupted: false, via: null, turnId: null };
  }

  async renameChat(chatId: string, title: string): Promise<{ chatId: string; title: string }> {
    await this.withChatLock(chatId, () =>
      this.withRunner(() =>
        this.runner.request('thread/name/set', { threadId: chatId, name: title }).catch((error: unknown) => explainWriterLock(error, 'rename the chat')),
      ),
    );
    return { chatId, title };
  }

  archiveChat(chatId: string, archived: boolean): Promise<{ chatId: string; archived: boolean }> {
    return this.withChatLock(chatId, () => this.archiveChatLocked(chatId, archived));
  }

  private async archiveChatLocked(chatId: string, archived: boolean): Promise<{ chatId: string; archived: boolean }> {
    if (archived) {
      const status = await this.getChatStatus(chatId);
      if (status.running || status.stateUnknown) throw new BridgeError('This chat is running. Interrupt it before archiving.');
      await this.withRunner(() =>
        this.runner.request('thread/archive', { threadId: chatId }).catch((error: unknown) => explainWriterLock(error, 'archive the chat')),
      );
    } else {
      await this.withRunner(() =>
        this.runner.request('thread/unarchive', { threadId: chatId }).catch((error: unknown) => explainWriterLock(error, 'restore the chat')),
      );
    }
    return { chatId, archived };
  }

  listPendingRequests(chatId?: string): PendingRequestInfo[] {
    return [...this.pending.values()].filter((request) => !chatId || request.chatId === chatId).map((request) => this.describePending(request));
  }

  respondToRequest(requestId: string, answer: string, answers?: Record<string, string[]>, content?: Record<string, unknown>): { requestId: string; answered: string } {
    const request = this.pending.get(requestId);
    if (!request) throw new BridgeError(`No pending request with id ${requestId}. It may have been answered or expired.`);
    const info = this.describePending(request);
    if (!info.answers.includes(answer)) throw new BridgeError(`Invalid answer "${answer}". Use one of: ${info.answers.join(', ')}.`);

    switch (request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        this.runner.respond(request.rpcId, { decision: answer });
        break;
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const legacy: Record<string, string> = { accept: 'approved', acceptForSession: 'approved_for_session', decline: 'denied', cancel: 'abort' };
        this.runner.respond(request.rpcId, { decision: legacy[answer] ?? 'denied' });
        break;
      }
      case 'item/tool/requestUserInput': {
        if (answer === 'cancel') {
          this.runner.respondError(request.rpcId, -32800, 'Cancelled by the MCP client');
          break;
        }
        const formatted: Record<string, { answers: string[] }> = {};
        for (const [questionId, values] of Object.entries(answers ?? {})) formatted[questionId] = { answers: values };
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
  private forcedSetting<T extends string>(name: 'sandbox' | 'approvalPolicy', requested: T | undefined): T | undefined {
    const forced = this.options[name] as T | undefined;
    if (forced && requested && requested !== forced) {
      throw new BridgeError(`This server forces ${name} "${forced}", so "${requested}" is not allowed.`);
    }
    return forced ?? requested;
  }

  private async withChatLock<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chatLocks.get(chatId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const settled = run.catch(() => undefined);
    this.chatLocks.set(chatId, settled);
    try {
      return await run;
    } finally {
      if (this.chatLocks.get(chatId) === settled) this.chatLocks.delete(chatId);
    }
  }

  private statusFromLive(live: LiveChatState): ChatStatus {
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
  private async markRunningTurn(chatId: string, turns: FormattedTurn[]): Promise<void> {
    const last = turns.at(-1);
    if (!last || last.status !== 'interrupted' || last.completedAt) return;
    const tracked = this.turns.get(chatId);
    if (tracked?.status === 'inProgress' && tracked.turnId === last.id) {
      last.status = 'inProgress';
      return;
    }
    const live = await this.desktop.liveState(chatId, 'quick').catch(() => ({ state: null, uncertain: true }));
    if (live.state?.activeTurnId === last.id) last.status = 'inProgress';
  }

  private async resolveTurnOptions(params: TurnOptions, currentModel: string | null): Promise<TurnOptions> {
    if (!params.model && !params.effort && !params.speed) return {};
    const models = await this.listModels();
    const model = findModel(models, params.model ?? currentModel);
    if (params.model && !model) throw new BridgeError(`Unknown model "${params.model}". Use list_models to see available models.`);
    return {
      model: params.model ? model?.id : undefined,
      effort: validateEffort(model, params.effort),
      speed: resolveSpeed(model, params.speed),
    };
  }

  private async startBridgeTurn(chatId: string, text: string, turn: TurnOptions): Promise<string | null> {
    const tracked: TrackedTurn = {
      chatId,
      turnId: null,
      status: 'inProgress',
      startedAt: new Date().toISOString(),
      completedAt: null,
      lastAgentMessage: null,
      error: null,
    };
    this.turns.set(chatId, tracked);
    const request: Record<string, unknown> = { threadId: chatId, input: textInput(text) };
    if (turn.model) request.model = turn.model;
    if (turn.effort) request.effort = turn.effort;
    if (turn.speed) request.serviceTier = turn.speed;
    try {
      const result: unknown = await this.runner.request('turn/start', request);
      const started = isRecord(result) && isRecord(result.turn) ? result.turn : null;
      tracked.turnId = tracked.turnId ?? asString(started?.id);
      const status = asString(started?.status);
      if (status && status !== 'inProgress' && tracked.status === 'inProgress') this.completeTrackedTurn(tracked, status, null);
      return tracked.turnId;
    } catch (error) {
      if (error instanceof AppServerError && error.code === APP_SERVER_TIMEOUT) {
        // The engine may have accepted the turn. Keep tracking it so the runner is not stopped under it,
        // and tell the caller not to resend blindly.
        this.expireUnconfirmedTurn(tracked);
        throw new BridgeError(
          'The Codex engine did not confirm the message in time. It may still be running; check get_chat_status before sending it again.',
          { cause: error },
        );
      }
      this.completeTrackedTurn(tracked, 'failed', errorMessage(error));
      throw error;
    }
  }

  private expireUnconfirmedTurn(tracked: TrackedTurn): void {
    const timer = setTimeout(() => {
      if (tracked.status === 'inProgress' && tracked.turnId === null && this.turns.get(tracked.chatId) === tracked) {
        this.completeTrackedTurn(tracked, 'failed', 'The engine never confirmed this turn.');
      }
    }, UNCONFIRMED_TURN_TIMEOUT_MS);
    timer.unref();
  }

  private handleBusyBridgeChat(params: SendMessageParams, tracked: TrackedTurn, whenBusy: WhenBusy): Promise<SendResult> {
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
        return { chatId: params.chatId, deliveredVia: 'bridge' as const, action: 'steered' as const, turnId };
      }
      await this.runner.request('turn/interrupt', { threadId: params.chatId, turnId });
      const stopped = await this.waitForBridgeTurn(params.chatId, 20_000);
      if (!stopped) throw new BridgeError('The running turn did not stop in time; the new message was not sent.');
      const meta = await this.threadMeta(params.chatId);
      const turn = await this.resolveTurnOptions(params, meta?.model ?? null);
      const newTurnId = await this.startBridgeTurn(params.chatId, params.message, turn);
      return { chatId: params.chatId, deliveredVia: 'bridge' as const, action: 'interruptedAndStarted' as const, turnId: newTurnId };
    });
  }

  private async waitUntilAppIdle(chatId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const live = await this.desktop.liveState(chatId, 'quick');
      if (!live.state?.running) return;
      await sleep(500);
    }
    throw new BridgeError('The running turn did not stop in time; the new message was not sent.');
  }

  /** Resolves true once the bridge turn is no longer running, or false on timeout. */
  private waitForBridgeTurn(chatId: string, timeoutMs: number): Promise<boolean> {
    if (this.turns.get(chatId)?.status !== 'inProgress') return Promise.resolve(true);
    return new Promise((resolveWait) => {
      const waiters = this.waiters.get(chatId) ?? new Set<() => void>();
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

  private async threadMeta(chatId: string): Promise<ChatSummary | null> {
    try {
      const result: unknown = await this.reader.request('thread/read', { threadId: chatId, includeTurns: false });
      return isRecord(result) ? summarizeThread(result.thread) : null;
    } catch (error) {
      log.debug('thread/read failed', { message: errorMessage(error) });
      return null;
    }
  }

  private async recentTurns(chatId: string, count: number): Promise<FormattedTurn[]> {
    const page: unknown = await this.reader.request('thread/turns/list', {
      threadId: chatId,
      limit: count,
      sortDirection: 'desc',
      itemsView: 'full',
    });
    const options: FormatOptions = { includeToolCalls: false, includeToolOutputs: false, includeReasoning: false, maxCharsPerItem: 8000 };
    return (isRecord(page) ? asArray(page.data) : [])
      .map((turn) => formatTurn(turn, options))
      .filter((turn): turn is FormattedTurn => turn !== null)
      .reverse();
  }

  private async resolveProjectPath(project: string, create: boolean): Promise<string> {
    const trimmed = project.trim();
    if (trimmed.startsWith('/') || trimmed.startsWith('~')) {
      const path = resolve(expandHome(trimmed));
      if (!existsSync(path)) {
        if (!create) return path;
        throw new BridgeError(`Folder ${path} does not exist.`);
      }
      return path;
    }
    const { projects } = await this.listProjects();
    const wanted = trimmed.toLowerCase();
    const match = projects.find(
      (entry) => entry.label.toLowerCase() === wanted || entry.path.split('/').filter(Boolean).at(-1)?.toLowerCase() === wanted,
    );
    if (!match) {
      throw new BridgeError(`Unknown project "${project}". Pass an absolute folder path or a name from list_projects.`);
    }
    return match.path;
  }

  private newChatFolder(prompt: string | undefined): string {
    const base = join(isAbsolute(this.options.workspaceRoot) ? this.options.workspaceRoot : resolve(this.options.workspaceRoot), today());
    const slug = slugFromPrompt(prompt);
    let candidate = join(base, slug);
    for (let suffix = 2; existsSync(candidate); suffix += 1) candidate = join(base, `${slug}-${suffix}`);
    mkdirSync(candidate, { recursive: true });
    return candidate;
  }

  private pendingFor(chatId: string): PendingRequestInfo[] {
    return this.listPendingRequests(chatId);
  }

  private describePending(request: PendingServerRequest): PendingRequestInfo {
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
              .filter((option): option is string => option !== null),
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

  private async withRunner<T>(operation: () => Promise<T>): Promise<T> {
    this.cancelRunnerStop();
    this.runnerOperations += 1;
    try {
      return await operation();
    } finally {
      this.runnerOperations -= 1;
      this.scheduleRunnerStop();
    }
  }

  private runnerBusy(): boolean {
    if (this.runnerOperations > 0 || this.pending.size > 0) return true;
    for (const tracked of this.turns.values()) if (tracked.status === 'inProgress') return true;
    return false;
  }

  /** Stops the runner once it is idle so the chats it loaded can be opened in the app again. */
  private scheduleRunnerStop(): void {
    this.cancelRunnerStop();
    const timer = setTimeout(() => {
      this.runnerStopTimer = null;
      if (this.runnerBusy() || !this.runner.isRunning()) return;
      log.debug('stopping idle runner to release chats');
      this.runner.stop();
    }, RUNNER_IDLE_STOP_MS);
    timer.unref();
    this.runnerStopTimer = timer;
  }

  private cancelRunnerStop(): void {
    if (this.runnerStopTimer) clearTimeout(this.runnerStopTimer);
    this.runnerStopTimer = null;
  }

  private completeTrackedTurn(tracked: TrackedTurn, status: string, error: string | null): void {
    tracked.status = status;
    tracked.completedAt = new Date().toISOString();
    tracked.error = error;
    for (const waiter of this.waiters.get(tracked.chatId) ?? []) waiter();
    this.waiters.delete(tracked.chatId);
    for (const [key, request] of this.pending) {
      if (request.chatId === tracked.chatId) this.pending.delete(key);
    }
    this.scheduleRunnerStop();
  }

  private onNotification(notification: AppServerNotification): void {
    const params = isRecord(notification.params) ? notification.params : {};
    if (notification.method === 'serverRequest/resolved') {
      // The server resolved a request itself (for example a question that timed out); stop offering it.
      const rpcId = params.requestId;
      for (const [key, request] of this.pending) {
        if (request.rpcId === rpcId) this.pending.delete(key);
      }
      this.scheduleRunnerStop();
      return;
    }
    const chatId = asString(params.threadId);
    if (!chatId) return;
    const tracked = this.turns.get(chatId);
    if (!tracked) return;
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
        if (item.type === 'agentMessage' && typeof item.text === 'string') tracked.lastAgentMessage = item.text;
        return;
      }
      default:
        return;
    }
  }

  private onServerRequest(request: AppServerRequest): void {
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

  private onRunnerExit(): void {
    for (const tracked of this.turns.values()) {
      if (tracked.status === 'inProgress') this.completeTrackedTurn(tracked, 'failed', 'codex app-server stopped');
    }
    this.pending.clear();
  }
}
