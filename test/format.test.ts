import { describe, expect, it } from 'vitest';
import { parseLiveState } from '../src/desktop.js';
import { formatTurn, summarizeThread } from '../src/format.js';

const options = { includeToolCalls: true, includeToolOutputs: false, includeReasoning: false, maxCharsPerItem: 40 };

describe('history formatting', () => {
  it('summarizes items and truncates long text', () => {
    const turn = formatTurn(
      {
        id: 't1',
        status: 'completed',
        startedAt: 1_793_000_000,
        completedAt: 1_793_000_010,
        items: [
          { type: 'userMessage', content: [{ type: 'text', text: 'hello' }, { type: 'image', url: 'x' }] },
          { type: 'reasoning', summary: ['secret plan'] },
          { type: 'commandExecution', command: 'ls -la', exitCode: 0, status: 'completed', aggregatedOutput: 'files' },
          { type: 'fileChange', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'update' } }] },
          { type: 'mcpToolCall', server: 'github', tool: 'search', status: 'completed', result: { ok: true } },
          { type: 'agentMessage', text: 'x'.repeat(100) },
        ],
      },
      options,
    );
    expect(turn?.startedAt).toBe('2026-10-26T07:33:20.000Z');
    expect(turn?.items.map((item) => item.type)).toEqual(['userMessage', 'commandExecution', 'fileChange', 'mcpToolCall', 'agentMessage']);
    expect(turn?.items[0]?.text).toBe('hello\n[image]');
    expect(turn?.items[1]).toMatchObject({ detail: '$ ls -la (exit 0)' });
    expect(turn?.items[1]?.text).toBeUndefined();
    expect(turn?.items[2]?.detail).toBe('update a.ts');
    expect(turn?.items[4]?.text).toHaveLength(40);
  });

  it('builds chat summaries from app-server threads', () => {
    expect(summarizeThread({ id: 'c1', preview: 'Fix   the\nbuild', source: { subAgent: 'review' }, updatedAt: 1_793_000_000 })).toMatchObject({
      id: 'c1',
      title: 'Fix the build',
      source: 'subAgent',
      updatedAt: '2026-10-26T07:33:20.000Z',
    });
  });
});

describe('live app state', () => {
  it('finds the running turn and settings in an app snapshot', () => {
    const state = parseLiveState(
      'c1',
      {
        title: 'Chat',
        threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
        latestThreadSettings: { cwd: '/repo', model: 'gpt-test', effort: 'high', serviceTier: 'priority', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } },
        requests: [{ method: 'item/commandExecution/requestApproval' }],
        turnHistory: {
          history: {
            entitiesByKey: {
              'turn:a': { turnId: 'a', status: 'completed', turnStartedAtMs: 1, items: [{ type: 'agentMessage', text: 'old' }] },
              'tail:b': { turnId: 'b', status: 'inProgress', turnStartedAtMs: 2, items: { x: { type: 'agentMessage', text: 'working' } } },
            },
          },
        },
      },
      { model: null, reasoningEffort: null, mode: null, resumeState: null },
    );
    expect(state).toMatchObject({
      running: true,
      activeTurnId: 'b',
      latestTurnId: 'b',
      model: 'gpt-test',
      reasoningEffort: 'high',
      speed: 'priority',
      sandbox: 'workspaceWrite',
      pendingRequests: [{ type: 'item/commandExecution/requestApproval' }],
      lastAgentMessage: 'working',
    });
  });
});
