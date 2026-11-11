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

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case 'model/list':
        return { data: [{ id: 'gpt-test', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }], serviceTiers: [] }] };
      case 'thread/read':
        return { thread: { id: params.threadId, model: 'gpt-test' } };
      case 'thread/start':
        return { thread: { id: 'chat-1' }, model: 'gpt-test' };
      case 'thread/loaded/list':
        return { data: [], nextCursor: null };
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

function makeBridge(options: Partial<BridgeOptions> = {}, desktop = notOpenInApp) {
  const reader = new FakeAppServer();
  const runner = new FakeAppServer();
  const bridge = new DesktopBridge(reader as unknown as AppServerClient, runner as unknown as AppServerClient, desktop, {
    workspaceRoot: mkdtempSync(join(tmpdir(), 'cdm-bridge-')),
    ...options,
  });
  return { bridge, runner };
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

  it('releases a new chat before the app owns and starts it, without a background turn', async () => {
    let owned = false;
    const state = { model: 'gpt-test', reasoningEffort: 'low', running: false } as LiveChatState;
    const desktop = {
      openChat: vi.fn(async () => {
        expect(runner.calls.map((call) => call.method)).toContain('thread/unsubscribe');
        owned = true;
        return state;
      }),
      liveState: async () => ({ state: owned ? state : null, uncertain: false }),
      startTurn: vi.fn(async () => {
        expect(owned).toBe(true);
        return {};
      }),
      updateNextTurnSettings: vi.fn(async () => true),
    };
    const { bridge, runner } = makeBridge({}, desktop as unknown as DesktopApp);
    const created = await bridge.createChat({ prompt: 'Test', model: 'gpt-test', effort: 'low' });
    expect(created).toMatchObject({ deliveredVia: 'app', turnStarted: true, turnId: null });
    expect(desktop.startTurn).toHaveBeenCalledOnce();
    expect(desktop.updateNextTurnSettings).toHaveBeenCalledWith('chat-1', { model: 'gpt-test', effort: 'low' });
    expect(runner.calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('does not fall back to a headless turn when app handoff fails', async () => {
    const desktop = { openChat: vi.fn(async () => { throw new Error('unavailable'); }) };
    const { bridge, runner } = makeBridge({}, desktop as unknown as DesktopApp);
    await expect(bridge.createChat({ prompt: 'Test' })).rejects.toThrow(/Chat chat-1 was created.*unavailable/);
    expect(runner.calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('never resends a prompt when the app start acknowledgement times out', async () => {
    const state = { model: 'gpt-test', running: false } as LiveChatState;
    const desktop = {
      openChat: async () => state,
      liveState: async () => ({ state, uncertain: false }),
      startTurn: vi.fn(async () => { throw new Error('timeout'); }),
    };
    const { bridge, runner } = makeBridge({}, desktop as unknown as DesktopApp);
    await expect(bridge.createChat({ prompt: 'Test' })).rejects.toThrow(/do not create a duplicate/);
    expect(desktop.startTurn).toHaveBeenCalledOnce();
    expect(runner.calls.some((call) => call.method === 'turn/start')).toBe(false);
  });

  it('opens stored chats in the app and steers their running turn', async () => {
    const state = { model: 'gpt-test', running: true, activeTurnId: 'app-turn', cwd: '/tmp' } as LiveChatState;
    const desktop = {
      liveState: async () => ({ state: null, uncertain: false }),
      openChat: vi.fn(async () => state),
      steerTurn: vi.fn(async () => ({})),
    };
    const { bridge, runner } = makeBridge({}, desktop as unknown as DesktopApp);
    await expect(bridge.sendMessage({ chatId: 'stored-chat', message: 'Change direction', whenBusy: 'steer' }))
      .resolves.toMatchObject({ deliveredVia: 'app', action: 'steered', turnId: 'app-turn' });
    expect(desktop.openChat).toHaveBeenCalledWith('stored-chat');
    expect(desktop.steerTurn).toHaveBeenCalledOnce();
    expect(runner.calls).toHaveLength(0);
  });
});
