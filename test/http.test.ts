import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenStore } from '../src/auth.js';
import type { DesktopBridge } from '../src/bridge.js';
import { startHttpServer, type RunningHttpServer } from '../src/http.js';
import { createMcpServer } from '../src/tools.js';

const fakeBridge = {
  listModels: async () => [{ id: 'gpt-test' }],
  createChat: async () => ({ chatId: 'c1' }),
} as unknown as DesktopBridge;

let server: RunningHttpServer;
let readToken: string;
let controlToken: string;

beforeAll(async () => {
  const tokens = new TokenStore(join(mkdtempSync(join(tmpdir(), 'cdm-http-')), 'config'));
  readToken = tokens.create('reader', 'read').token;
  controlToken = tokens.create('controller', 'control').token;
  server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    tokens,
    allowedOrigins: ['https://allowed.example'],
    createServer: (scope) => createMcpServer(fakeBridge, scope, '0.0.0-test'),
  });
});

afterAll(async () => {
  await server.close();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

function post(headers: Record<string, string>): Promise<Response> {
  return fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

describe('HTTP endpoint', () => {
  it('rejects missing tokens, wrong tokens, and foreign browser origins', async () => {
    expect((await post({})).status).toBe(401);
    expect((await post({ authorization: 'Bearer cdm_wrong' })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${readToken}`, origin: 'https://evil.example' })).status).toBe(403);
  });

  it('answers CORS preflight for allowed origins before authentication', async () => {
    const preflight = await fetch(server.url, { method: 'OPTIONS', headers: { origin: 'https://allowed.example' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
    const call = await post({ authorization: `Bearer ${readToken}`, origin: 'https://allowed.example' });
    expect(call.status).toBe(200);
    expect(call.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
  });

  it('limits read tokens to read tools', async () => {
    const reader = await connect(readToken);
    const names = (await reader.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('read_chat');
    expect(names).not.toContain('send_message');
    await reader.close();

    const controller = await connect(controlToken);
    const controlNames = (await controller.listTools()).tools.map((tool) => tool.name);
    expect(controlNames).toEqual(expect.arrayContaining(['create_chat', 'send_message', 'interrupt_chat']));
    const result = await controller.callTool({ name: 'list_models', arguments: {} });
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ models: [{ id: 'gpt-test' }] }, null, 2) }]);
    await controller.close();
  });

  it('throttles repeated failures from one client without blocking valid tokens', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) await post({ authorization: 'Bearer cdm_wrong' });
    expect((await post({ authorization: 'Bearer cdm_wrong' })).status).toBe(429);
    expect((await post({ authorization: `Bearer ${controlToken}` })).status).toBe(200);
  });
});
