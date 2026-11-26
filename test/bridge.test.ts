import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppServerClient } from '../src/appServer.js';
import { DesktopBridge, type BridgeOptions } from '../src/bridge.js';
import type { DesktopApp, LiveChatState } from '../src/desktop.js';

/** Records requests and answers like a minimal codex app-server. */
class FakeAppServer extends EventEmitter {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  /** Chat queue and stored turns, shared state that the fake app consumes. */
  queue: string[] = [];
  turns: Array<Record<string, unknown>> = [];
  failQueueAdd = false;

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case 'model/list':
        return { data: [{ id: 'gpt-test', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], serviceTiers: [] }] };
      case 'thread/read':
        return { thread: { id: params.threadId, model: 'gpt-test' } };
      case 'thread/start':
        return { thread: { id: 'chat-1' }, model: 'gpt-test', reasoningEffort: 'high' };
      case 'thread/loaded/list':
        return { data: [], nextCursor: null };
      case 'thread/turns/list':
        return { data: [...this.turns].reverse().slice(0, Number(params.limit ?? 1)), nextCursor: null };
      case 'thread/queue/add': {
        if (this.failQueueAdd) throw new Error('queue unavailable');
        const id = `queued-${this.queue.length + 1}`;
        this.queue.push(id);
        return { queuedSubmission: { id } };
      }
      case 'thread/queue/list':
        return { data: this.queue.map((id) => ({ id })), nextCursor: null };
      case 'turn/start':
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { turn: { id: `turn-${this.calls.length}`, status: 'inProgress' } };
      default:
        return {};
    }
  }

  isRunning(): boolean {
    return true;
  }

  stop(): void {}
  respond(): void {}
  respondError(): void {}
}

const notOpenInApp = { liveState: async () => ({ state: null, uncertain: false }) } as unknown as DesktopApp;

function makeBridge(options: Partial<BridgeOptions> = {}, desktop = notOpenInApp, reader = new FakeAppServer()) {
  const runner = new FakeAppServer();
  const bridge = new DesktopBridge(reader as unknown as AppServerClient, runner as unknown as AppServerClient, desktop, {
    workspaceRoot: mkdtempSync(join(tmpdir(), 'cdm-bridge-')),
    appPickupTimeoutMs: 1_500,
    ...options,
  });
  return { bridge, runner, reader };
}

/** A desktop app without live control that sends queued messages when woken, like ChatGPT 26.1120. */
function queueDrivenApp(reader: FakeAppServer, { picksUp = true } = {}) {
  return {
    liveState: async () => ({ state: null, uncertain: false }),
    revealChat: vi.fn(async () => {}),
    wakeChat: vi.fn(async () => {
      if (!picksUp) return;
      reader.queue = [];
      reader.turns.push({ id: `app-turn-${reader.turns.length + 1}`, status: 'inProgress', items: [] });
    }),
  };
}

describe('DesktopBridge', () => {
  it('does not let a caller loosen sandbox or approval settings forced by the operator', async () => {
    const { bridge, runner } = makeBridge({ sandbox: 'read-only', approvalPolicy: 'on-request' });
    const project = mkdtempSync(join(tmpdir(), 'cdm-project-'));
    await expect(bridge.createChat({ project, sandbox: 'danger-full-access' })).rejects.toThrow(/forces sandbox "read-only"/);
    await expect(bridge.createChat({ project, approvalPolicy: 'never' })).rejects.toThrow(/forces approvalPolicy "on-request"/);
    await expect(bridge.createChat({ project })).rejects.toThrow(/permission|permissions/);
    await bridge.createChat({ project, execution: 'background' });
    expect(runner.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' });
  });

  it('starts only one turn when two messages race for an idle chat', async () => {
    const { bridge, runner } = makeBridge();
    const results = await Promise.allSettled([
      bridge.sendMessage({ chatId: 'chat-1', message: 'first', execution: 'background' }),
      bridge.sendMessage({ chatId: 'chat-1', message: 'second', execution: 'background' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/busy/);
    expect(runner.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });

  it('saves the requested settings in a new chat and lets the app run its prompt', async () => {
    const reader = new FakeAppServer();
    const desktop = queueDrivenApp(reader);
    const { bridge, runner } = makeBridge({}, desktop as unknown as DesktopApp, reader);
    const created = await bridge.createChat({ prompt: 'Test', model: 'gpt-test', effort: 'low' });

    expect(created).toMatchObject({ deliveredVia: 'app', turnStarted: true, turnId: 'app-turn-1', model: 'gpt-test', reasoningEffort: 'low' });
    const methods = runner.calls.map((call) => call.method);
    expect(methods.indexOf('thread/settings/update')).toBeLessThan(methods.indexOf('thread/unsubscribe'));
    expect(runner.calls.find((call) => call.method === 'thread/settings/update')?.params).toMatchObject({
      model: 'gpt-test',
      effort: 'low',
      collaborationMode: { settings: { model: 'gpt-test', reasoning_effort: 'low' } },
    });
    expect(reader.calls.find((call) => call.method === 'thread/queue/add')?.params).toMatchObject({ threadId: 'chat-1' });
    expect(desktop.wakeChat).toHaveBeenCalledWith('chat-1');
    expect(methods).not.toContain('turn/start');
  });

  it('keeps the engine default effort when the caller does not choose one', async () => {
    const reader = new FakeAppServer();
    const { bridge, runner } = makeBridge({}, queueDrivenApp(reader) as unknown as DesktopApp, reader);
    const created = await bridge.createChat({ prompt: 'Test' });
    expect(created).toMatchObject({ model: 'gpt-test', reasoningEffort: 'high' });
    expect(runner.calls.find((call) => call.method === 'thread/settings/update')?.params).toMatchObject({ model: 'gpt-test', effort: 'high' });
  });

  it('archives the new chat instead of leaving it empty when the prompt cannot be queued', async () => {
    const reader = new FakeAppServer();
    reader.failQueueAdd = true;
    const desktop = queueDrivenApp(reader);
    const { bridge, runner } = makeBridge({}, desktop as unknown as DesktopApp, reader);
    await expect(bridge.createChat({ prompt: 'Test' })).rejects.toThrow(/queue unavailable.*archived/);
    expect(runner.calls.some((call) => call.method === 'thread/archive')).toBe(true);
    expect(desktop.wakeChat).not.toHaveBeenCalled();
    expect(runner.calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('reports a message the app has not picked up as queued, without resending it', async () => {
    const reader = new FakeAppServer();
    const desktop = queueDrivenApp(reader, { picksUp: false });
    const { bridge, runner } = makeBridge({}, desktop as unknown as DesktopApp, reader);
    const created = await bridge.createChat({ prompt: 'Test' });
    expect(created).toMatchObject({ turnStarted: false, queuedMessageId: 'queued-1' });
    expect(created.note).toMatch(/Do not send it again/);
    expect(reader.calls.filter((call) => call.method === 'thread/queue/add')).toHaveLength(1);
    expect(runner.calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('queues follow-ups for a chat the app is running only when asked to', async () => {
    const reader = new FakeAppServer();
    reader.turns.push({ id: 'running', status: 'interrupted', completedAt: null, items: [] });
    const desktop = queueDrivenApp(reader, { picksUp: false });
    const { bridge } = makeBridge({}, desktop as unknown as DesktopApp, reader);

    await expect(bridge.sendMessage({ chatId: 'chat-1', message: 'Next' })).rejects.toThrow(/whenBusy "queue"/);
    await expect(bridge.sendMessage({ chatId: 'chat-1', message: 'Next', whenBusy: 'steer' })).rejects.toThrow(/no longer lets other processes steer/);
    expect(reader.calls.some((call) => call.method === 'thread/queue/add')).toBe(false);
    await expect(bridge.sendMessage({ chatId: 'chat-1', message: 'Next', whenBusy: 'queue' })).resolves.toMatchObject({ action: 'queued', deliveredVia: 'app' });
  });

  it('reports a turn the app is running as running', async () => {
    const reader = new FakeAppServer();
    reader.turns.push({ id: 'running', status: 'interrupted', completedAt: null, items: [] });
    const { bridge } = makeBridge({}, queueDrivenApp(reader) as unknown as DesktopApp, reader);
    await expect(bridge.getChatStatus('chat-1')).resolves.toMatchObject({ running: true, location: 'app', activeTurnId: 'running' });
    await expect(bridge.interruptChat('chat-1')).rejects.toThrow(/Stop it from the app/);
  });

  it('steers the running turn of a chat that an older app exposes over IPC', async () => {
    const state = { model: 'gpt-test', running: true, activeTurnId: 'app-turn', cwd: '/tmp' } as LiveChatState;
    const desktop = {
      liveState: async () => ({ state, uncertain: false }),
      steerTurn: vi.fn(async () => ({})),
    };
    const { bridge, runner } = makeBridge({}, desktop as unknown as DesktopApp);
    await expect(bridge.sendMessage({ chatId: 'open-chat', message: 'Change direction', whenBusy: 'steer' }))
      .resolves.toMatchObject({ deliveredVia: 'app', action: 'steered', turnId: 'app-turn' });
    expect(desktop.steerTurn).toHaveBeenCalledOnce();
    expect(runner.calls).toHaveLength(0);
  });
});
