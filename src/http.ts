import { randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Scope, TokenStore } from './auth.js';
import { log } from './log.js';
import { errorMessage } from './util.js';

export interface HttpServerOptions {
  host: string;
  port: number;
  tokens: Pick<TokenStore, 'verify'>;
  createServer: (scope: Scope) => McpServer;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
}

export interface RunningHttpServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 20;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

/** Origins are only sent by browsers; reject any that are not explicitly allowed. */
function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (!origin) return true;
  return allowed.includes(origin);
}

/**
 * Identifies the caller for rate limiting. Behind a local tunnel every request
 * comes from loopback, so the tunnel's client-IP header is used there only.
 */
function clientKey(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (!LOOPBACK.has(remote)) return remote;
  const forwarded = req.headers['cf-connecting-ip'];
  return typeof forwarded === 'string' && forwarded ? forwarded : remote;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const allowedOrigins = options.allowedOrigins ?? [];
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
  const failures = new Map<string, number[]>();

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found. The MCP endpoint is /mcp.' });
      return;
    }
    const origin = req.headers.origin;
    if (!originAllowed(origin, allowedOrigins)) {
      sendJson(res, 403, { error: 'Origin not allowed' });
      return;
    }
    if (origin) {
      // Browser clients from an allowed origin need CORS headers, and their preflight carries no token.
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'Origin');
      res.setHeader('access-control-expose-headers', 'mcp-session-id, mcp-protocol-version');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
          'access-control-max-age': '600',
        });
        res.end();
        return;
      }
    }

    const token = bearerToken(req);
    const record = token ? options.tokens.verify(token) : null;
    if (!record) {
      const key = clientKey(req);
      const now = Date.now();
      const recent = (failures.get(key) ?? []).filter((time) => now - time < FAILURE_WINDOW_MS);
      if (recent.length >= MAX_FAILURES_PER_WINDOW) {
        failures.set(key, recent);
        sendJson(res, 429, { error: 'Too many failed authentication attempts. Try again later.' }, { 'retry-after': '60' });
        return;
      }
      recent.push(now);
      failures.set(key, recent);
      if (failures.size > 10_000) failures.clear();
      sendJson(res, 401, { error: 'Missing or invalid bearer token' }, { 'www-authenticate': 'Bearer realm="chatgpt-desktop-mcp"' });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'This server is stateless; use POST /mcp.' }, { allow: 'POST' });
      return;
    }

    let body: unknown;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 400;
      sendJson(res, status, { jsonrpc: '2.0', error: { code: -32700, message: errorMessage(error) }, id: null });
      return;
    }

    const requestId = randomUUID().slice(0, 8);
    log.debug('mcp request', { requestId, token: record.id, scope: record.scope });
    const server = options.createServer(record.scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((error: unknown) => {
      log.error('request failed', { message: errorMessage(error) });
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
      else res.end();
    });
  });
  // Long waits are allowed; keep-alive comments from the SSE stream keep proxies happy.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;
  return {
    url: `http://${host}:${address.port}/mcp`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
