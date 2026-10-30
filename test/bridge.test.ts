import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppServerClient } from '../src/appServer.js';
import { DesktopBridge, type BridgeOptions } from '../src/bridge.js';
import type { DesktopApp } from '../src/desktop.js';

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

function makeBridge(options: Partial<BridgeOptions> = {}) {
  const reader = new FakeAppServer();
  const runner = new FakeAppServer();
  const bridge = new DesktopBridge(reader as unknown as AppServerClient, runner as unknown as AppServerClient, notOpenInApp, {
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
    await bridge.createChat({ project });
    expect(runner.calls.find((call) => call.method === 'thread/start')?.params).toMatchObject({ sandbox: 'read-only', approvalPolicy: 'on-request' });
  });

  it('starts only one turn when two messages race for an idle chat', async () => {
    const { bridge, runner } = makeBridge();
    const results = await Promise.allSettled([
      bridge.sendMessage({ chatId: 'chat-1', message: 'first' }),
      bridge.sendMessage({ chatId: 'chat-1', message: 'second' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/busy/);
    expect(runner.calls.filter((call) => call.method === 'turn/start')).toHaveLength(1);
  });
});
