import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import net from 'node:net';
import { log } from './log.js';
import { ipcSocketPath } from './paths.js';
import { isRecord } from './util.js';

const MAX_FRAME_BYTES = 256 * 1024 * 1024;
const INITIALIZING_CLIENT_ID = 'initializing-client';

/**
 * Message versions understood by the ChatGPT desktop app's IPC router.
 * Verified against ChatGPT for macOS 26.1027. The app ignores requests whose
 * version does not match, so unsupported app versions show up as timeouts.
 */
export const IPC_METHOD_VERSIONS: Readonly<Record<string, number>> = {
  'thread-stream-following-changed': 1,
  'thread-follower-start-turn': 2,
  'thread-follower-steer-turn': 1,
  'thread-follower-interrupt-turn': 4,
  'thread-follower-read-model-settings': 1,
  'thread-follower-update-thread-settings': 2,
};

export function ipcMethodVersion(method: string, params: unknown): number {
  if (method === 'thread-follower-interrupt-turn' && isRecord(params) && params.expectedTurnId == null) return 3;
  return IPC_METHOD_VERSIONS[method] ?? 1;
}

export function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw new Error(`IPC message size ${payload.length} is outside the allowed range`);
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Decodes the router's framing: a little-endian uint32 byte length, then UTF-8 JSON. */
export class FrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private expected: number | null = null;

  push(chunk: Buffer): unknown[] {
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    const messages: unknown[] = [];
    for (;;) {
      if (this.expected === null) {
        if (this.buffered < 4) break;
        const length = this.peekHeader();
        if (length === 0 || length > MAX_FRAME_BYTES) throw new Error(`Invalid IPC frame length: ${length}`);
        this.expected = length;
      }
      if (this.buffered < 4 + this.expected) break;
      const frame = this.take(4 + this.expected);
      this.expected = null;
      messages.push(JSON.parse(frame.subarray(4).toString('utf8')));
    }
    return messages;
  }

  private peekHeader(): number {
    const first = this.chunks[0];
    if (first && first.length >= 4) return first.readUInt32LE(0);
    return Buffer.concat(this.chunks, this.buffered).readUInt32LE(0);
  }

  private take(length: number): Buffer {
    const all = this.chunks.length === 1 && this.chunks[0] ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    const frame = all.subarray(0, length);
    const rest = all.subarray(length);
    this.chunks = rest.length > 0 ? [rest] : [];
    this.buffered = rest.length;
    return frame;
  }
}

export class IpcRequestError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? `ChatGPT desktop IPC request failed: ${code}`);
    this.name = 'IpcRequestError';
  }
}

export interface IpcMessage {
  type: string;
  requestId?: string;
  method?: string;
  params?: unknown;
  resultType?: string;
  result?: unknown;
  error?: unknown;
  sourceClientId?: string;
  version?: number;
}

interface PendingResponse {
  resolve: (message: IpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client for the desktop app's IPC router (~/.codex/ipc/ipc.sock). The router
 * forwards thread-follower requests to the app window that owns a chat, which
 * is how other Codex surfaces drive a chat that is open in the app.
 */
export class DesktopIpcClient {
  private socket: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private clientId = INITIALIZING_CLIENT_ID;
  private readonly pending = new Map<string, PendingResponse>();
  private readonly listeners = new Set<(message: IpcMessage) => void>();

  constructor(private readonly options: { socketPath?: string; clientType?: string } = {}) {}

  get socketPath(): string {
    return this.options.socketPath ?? ipcSocketPath();
  }

  isAvailable(): boolean {
    return existsSync(this.socketPath);
  }

  /** Connects and completes the router handshake without sending a request. */
  async ping(): Promise<void> {
    await this.connect();
  }

  async request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    const socket = await this.connect();
    const response = await this.sendRequest(socket, method, params, timeoutMs);
    if (response.resultType === 'success') return response.result;
    const code = typeof response.error === 'string' ? response.error : 'unknown-error';
    throw new IpcRequestError(code);
  }

  async broadcast(method: string, params: unknown): Promise<void> {
    const socket = await this.connect();
    socket.write(
      encodeFrame({ type: 'broadcast', method, sourceClientId: this.clientId, version: ipcMethodVersion(method, params), params }),
    );
  }

  onBroadcast(listener: (message: IpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): Promise<net.Socket> {
    if (this.socket && !this.socket.destroyed) return Promise.resolve(this.socket);
    if (this.connecting) return this.connecting;
    this.connecting = new Promise<net.Socket>((resolve, reject) => {
      if (!this.isAvailable()) {
        reject(new IpcRequestError('app-not-running', 'The ChatGPT desktop app IPC socket was not found. Is the app running?'));
        return;
      }
      const socket = net.connect(this.socketPath);
      const decoder = new FrameDecoder();
      const failConnect = (error: Error) => {
        socket.destroy();
        reject(new IpcRequestError('connect-failed', `Could not connect to the ChatGPT desktop app: ${error.message}`));
      };
      socket.once('error', failConnect);
      socket.on('data', (chunk: Buffer) => {
        let messages: unknown[];
        try {
          messages = decoder.push(chunk);
        } catch (error) {
          log.warn('invalid frame from desktop IPC router', { message: (error as Error).message });
          socket.destroy();
          return;
        }
        for (const message of messages) {
          if (isRecord(message) && typeof message.type === 'string') this.handleMessage(socket, message as unknown as IpcMessage);
        }
      });
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null;
          this.clientId = INITIALIZING_CLIENT_ID;
        }
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new IpcRequestError('client-disconnected'));
        }
        this.pending.clear();
      });
      socket.once('connect', () => {
        socket.off('error', failConnect);
        socket.on('error', (error) => log.debug('desktop IPC socket error', { message: error.message }));
        this.sendRequest(socket, 'initialize', { clientType: this.options.clientType ?? 'chatgpt-desktop-mcp' }, 5_000, 0)
          .then((response) => {
            const assigned = isRecord(response.result) && typeof response.result.clientId === 'string' ? response.result.clientId : null;
            if (response.resultType !== 'success' || !assigned) throw new IpcRequestError('initialize-failed');
            this.clientId = assigned;
            this.socket = socket;
            resolve(socket);
          })
          .catch((error: Error) => {
            socket.destroy();
            reject(error);
          });
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private sendRequest(socket: net.Socket, method: string, params: unknown, timeoutMs: number, version?: number): Promise<IpcMessage> {
    const requestId = randomUUID();
    return new Promise<IpcMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new IpcRequestError('timeout', `The ChatGPT desktop app did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.write(
        encodeFrame({
          type: 'request',
          requestId,
          sourceClientId: this.clientId,
          version: version ?? ipcMethodVersion(method, params),
          method,
          params,
          timeoutMs,
        }),
      );
    });
  }

  private handleMessage(socket: net.Socket, message: IpcMessage): void {
    switch (message.type) {
      case 'response': {
        const pending = message.requestId ? this.pending.get(message.requestId) : undefined;
        if (!pending || !message.requestId) return;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message);
        return;
      }
      case 'client-discovery-request':
        // This client never owns chats, so it declines every forwarded request.
        socket.write(encodeFrame({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } }));
        return;
      case 'request':
        socket.write(encodeFrame({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'unsupported-method' }));
        return;
      case 'broadcast':
        for (const listener of this.listeners) {
          try {
            listener(message);
          } catch (error) {
            log.debug('broadcast listener failed', { message: (error as Error).message });
          }
        }
        return;
      default:
        return;
    }
  }
}
