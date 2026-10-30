import { mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopIpcClient, FrameDecoder, IpcRequestError, encodeFrame, ipcMethodVersion } from '../src/ipc.js';

describe('IPC framing', () => {
  it('decodes frames split across chunks and several frames in one chunk', () => {
    const decoder = new FrameDecoder();
    const first = encodeFrame({ type: 'response', requestId: 'a' });
    const second = encodeFrame({ type: 'broadcast', method: 'x', params: { text: 'é'.repeat(10) } });
    const joined = Buffer.concat([first, second]);
    expect(decoder.push(joined.subarray(0, 3))).toEqual([]);
    expect(decoder.push(joined.subarray(3, first.length + 5))).toEqual([{ type: 'response', requestId: 'a' }]);
    expect(decoder.push(joined.subarray(first.length + 5))).toEqual([{ type: 'broadcast', method: 'x', params: { text: 'é'.repeat(10) } }]);
  });

  it('rejects zero-length frames', () => {
    expect(() => new FrameDecoder().push(Buffer.alloc(4))).toThrow(/Invalid IPC frame length/);
  });

  it('uses the version the desktop app expects for each method', () => {
    expect(ipcMethodVersion('thread-follower-start-turn', {})).toBe(2);
    expect(ipcMethodVersion('thread-follower-interrupt-turn', { expectedTurnId: 't' })).toBe(4);
    expect(ipcMethodVersion('thread-follower-interrupt-turn', {})).toBe(3);
  });
});

/** Minimal stand-in for the desktop app's IPC router. */
function startFakeRouter(socketPath: string, onRequest: (message: Record<string, unknown>, reply: (m: unknown) => void) => void) {
  const seen: Array<Record<string, unknown>> = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    const reply = (message: unknown) => socket.write(encodeFrame(message));
    socket.on('data', (chunk: Buffer) => {
      for (const raw of decoder.push(chunk)) {
        const message = raw as Record<string, unknown>;
        seen.push(message);
        if (message.type === 'request' && message.method === 'initialize') {
          reply({ type: 'response', requestId: message.requestId, resultType: 'success', method: 'initialize', result: { clientId: 'client-1' } });
          // A peer asks every client whether it owns a chat; the bridge must decline.
          reply({ type: 'client-discovery-request', requestId: 'discovery-1', request: { method: 'thread-follower-start-turn' } });
        } else if (message.type === 'request') {
          onRequest(message, reply);
        }
      }
    });
  });
  return new Promise<{ server: net.Server; seen: typeof seen }>((resolve) => server.listen(socketPath, () => resolve({ server, seen })));
}

describe('DesktopIpcClient', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('initializes, forwards requests, maps errors, and declines discovery', async () => {
    const socketPath = join(mkdtempSync(join(tmpdir(), 'cdm-ipc-')), 'ipc.sock');
    const { server, seen } = await startFakeRouter(socketPath, (message, reply) => {
      const params = message.params as Record<string, unknown>;
      if (params.conversationId === 'owned') {
        reply({ type: 'response', requestId: message.requestId, resultType: 'success', result: { settings: { model: 'm' } } });
      } else {
        reply({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' });
      }
    });
    const client = new DesktopIpcClient({ socketPath });
    cleanups.push(() => {
      client.close();
      server.close();
    });

    await expect(client.request('thread-follower-read-model-settings', { conversationId: 'owned' })).resolves.toEqual({
      settings: { model: 'm' },
    });
    const failure = client.request('thread-follower-read-model-settings', { conversationId: 'other' });
    await expect(failure).rejects.toBeInstanceOf(IpcRequestError);
    await expect(failure).rejects.toMatchObject({ code: 'no-client-found' });

    const forwarded = seen.find((message) => message.method === 'thread-follower-read-model-settings');
    expect(forwarded).toMatchObject({ sourceClientId: 'client-1', version: 1 });
    expect(seen).toContainEqual({ type: 'client-discovery-response', requestId: 'discovery-1', response: { canHandle: false } });
  });

  it('reports a missing app as app-not-running', async () => {
    const client = new DesktopIpcClient({ socketPath: join(tmpdir(), 'cdm-missing', 'ipc.sock') });
    await expect(client.request('thread-follower-read-model-settings', {})).rejects.toMatchObject({ code: 'app-not-running' });
  });
});
