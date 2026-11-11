import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenStore } from '../src/auth.js';
import type { DesktopBridge } from '../src/bridge.js';
import { startHttpServer, type RunningHttpServer } from '../src/http.js';
import { MachineRouter, MachineStore, normalizeMachineUrl, validateMachineName } from '../src/machines.js';
import { createMcpServer } from '../src/tools.js';

/** A bridge that answers like a Mac named after its chats. */
function fakeBridge(label: string): DesktopBridge {
  let waits = 0;
  return {
    listModels: async () => [{ id: `model-${label}` }],
    listChats: async () => ({ chats: [{ id: `${label}-chat`, updatedAt: label === 'mini' ? '2026-10-31T10:00:00.000Z' : '2026-10-30T10:00:00.000Z' }], nextCursor: null }),
    listPendingRequests: () => [],
    getChatStatus: async (chatId: string) => {
      if (!chatId.startsWith(label)) throw new Error(`thread not loaded: ${chatId}`);
      return { chatId, running: false };
    },
    createChat: async (params: { prompt?: string }) => ({ chatId: `${label}-new`, turnId: null, turnStarted: Boolean(params.prompt), deliveredVia: 'app', prompt: params.prompt }),
    // The first wait times out so the hub has to wait again.
    waitForChat: async (chatId: string) => ({ chatId, running: waits === 0, timedOut: waits++ === 0 }),
  } as unknown as DesktopBridge;
}

interface Node {
  server: RunningHttpServer;
  store: MachineStore;
  router: MachineRouter;
  controlToken: string;
  readToken: string;
}

async function startNode(label: string): Promise<Node> {
  const dir = mkdtempSync(join(tmpdir(), `cdm-machines-${label}-`));
  const tokens = new TokenStore(dir);
  const store = new MachineStore(dir);
  store.setLocalName(label);
  const router = new MachineRouter(store, { version: '0.0.0-test', liveAppControl: () => label === 'laptop' });
  const bridge = fakeBridge(label);
  const server = await startHttpServer({ host: '127.0.0.1', port: 0, tokens, createServer: (scope) => createMcpServer(bridge, scope, '0.0.0-test', router) });
  return { server, store, router, controlToken: tokens.create('agent', 'control').token, readToken: tokens.create('reader', 'read').token };
}

let hub: Node;
let mini: Node;

beforeAll(async () => {
  hub = await startNode('laptop');
  mini = await startNode('mini');
  hub.store.add({ name: 'mini', url: mini.server.url, token: mini.controlToken, readOnly: false });
  hub.store.add({ name: 'gone', url: 'http://127.0.0.1:9/mcp', token: 'cdm_unused', readOnly: false });
});

afterAll(async () => {
  hub.router.close();
  mini.router.close();
  await hub.server.close();
  await mini.server.close();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(hub.server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ value: any; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
  return { value: result.isError ? text : JSON.parse(text), isError: result.isError === true };
}

describe('machine routing', () => {
  it('lists every machine with its availability', async () => {
    const client = await connect(hub.controlToken);
    const { value } = await call(client, 'list_machines');
    expect(value.thisMachine).toBe('laptop');
    expect(value.machines.map((machine: { name: string; available: boolean }) => [machine.name, machine.available])).toEqual([
      ['laptop', true],
      ['mini', true],
      ['gone', false],
    ]);
    expect(value.machines[1]).toMatchObject({ access: 'control', liveAppControl: false, version: '0.0.0-test' });
    await client.close();
  });

  it('runs tools on the chosen machine and tags results', async () => {
    const client = await connect(hub.controlToken);
    expect((await call(client, 'list_models')).value).toEqual({ machine: 'laptop', models: [{ id: 'model-laptop' }] });
    expect((await call(client, 'list_models', { machine: 'mini' })).value).toEqual({ machine: 'mini', models: [{ id: 'model-mini' }] });
    const created = await call(client, 'create_chat', { machine: 'mini', prompt: 'hello', wait: true, waitSeconds: 120 });
    expect(created.value).toMatchObject({ machine: 'mini', chatId: 'mini-new', prompt: 'hello', result: { chatId: 'mini-new', timedOut: false } });
    const unknown = await call(client, 'list_models', { machine: 'nope' });
    expect(unknown.isError).toBe(true);
    expect(unknown.value).toContain('Unknown machine');
    const offline = await call(client, 'list_models', { machine: 'gone' });
    expect(offline.isError).toBe(true);
    expect(offline.value).toMatch(/^gone: not reachable/);
    const elsewhere = await call(client, 'get_chat_status', { chatId: 'mini-new' });
    expect(elsewhere.value).toContain('pass machine');
    await client.close();
  });

  it('merges chats from every machine with machine "all"', async () => {
    const client = await connect(hub.readToken);
    const { value } = await call(client, 'list_chats', { machine: 'all' });
    expect(value.chats.map((chat: { machine: string; id: string }) => [chat.machine, chat.id])).toEqual([
      ['mini', 'mini-chat'],
      ['laptop', 'laptop-chat'],
    ]);
    expect(value.machines.find((machine: { machine: string }) => machine.machine === 'gone')).toMatchObject({ ok: false });
    await client.close();
  });

  it('honors read tokens, read-only machines, and the auto order', async () => {
    const reader = await connect(hub.readToken);
    const names = (await reader.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('create_chat');
    expect((await call(reader, 'list_machines')).value.machines[1].access).toBe('read');
    await reader.close();

    hub.store.add({ name: 'mini', url: mini.server.url, token: mini.controlToken, readOnly: true }, true);
    const client = await connect(hub.controlToken);
    const refused = await call(client, 'create_chat', { machine: 'mini', prompt: 'x' });
    expect(refused.value).toContain('read-only');
    hub.store.add({ name: 'mini', url: mini.server.url, token: mini.controlToken, readOnly: false }, true);

    hub.store.prefer('gone');
    expect((await call(client, 'list_models', { machine: 'auto' })).value.machine).toBe('laptop');
    hub.store.prefer('mini');
    expect((await call(client, 'list_models', { machine: 'auto' })).value.machine).toBe('mini');
    await client.close();
  });
});

describe('machine names and URLs', () => {
  it('validates names and normalizes endpoints', () => {
    expect(validateMachineName(' Mac-Mini ')).toBe('mac-mini');
    expect(() => validateMachineName('auto')).toThrow(/reserved/);
    expect(() => validateMachineName('my mac')).toThrow();
    expect(normalizeMachineUrl('https://mcp.example.com')).toBe('https://mcp.example.com/mcp');
    expect(normalizeMachineUrl('https://mcp.example.com/mcp/')).toBe('https://mcp.example.com/mcp');
    expect(() => normalizeMachineUrl('https://user:secret@mcp.example.com')).toThrow(/token/);
  });
});
