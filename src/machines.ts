import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BridgeError, errorMessage, isRecord } from './util.js';

/**
 * Other Macs running chatgpt-desktop-mcp. Requests that name one of them are
 * forwarded to its MCP endpoint with the token stored here, so one endpoint can
 * drive the ChatGPT app on several machines. Machines are managed from the CLI only.
 */

export interface MachineRecord {
  name: string;
  /** MCP endpoint, ending in /mcp. */
  url: string;
  token: string;
  /** Only read tools are forwarded to this machine. */
  readOnly: boolean;
  addedAt: string;
}

interface MachinesFile {
  version: 1;
  localName: string | null;
  /** Machine names in the order "auto" tries them. Missing names go last. */
  order: string[];
  machines: MachineRecord[];
}

/** Names that select machines instead of naming one. */
export const RESERVED_NAMES = ['auto', 'all', 'local', 'this'];
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function validateMachineName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!NAME.test(normalized)) throw new Error('Machine names use lowercase letters, digits, and "-" (up to 32 characters).');
  if (RESERVED_NAMES.includes(normalized)) throw new Error(`"${normalized}" is reserved. Pick another name.`);
  return normalized;
}

/** Accepts a base URL or the /mcp endpoint and returns the endpoint. */
export function normalizeMachineUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`"${value}" is not a URL, e.g. https://mcp.example.com/mcp`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The machine URL must start with https:// or http://');
  if (url.username || url.password) throw new Error('Put the token in the token prompt, not in the URL.');
  const path = url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '');
  return `${url.origin}${path}/mcp`;
}

function defaultLocalName(): string {
  const base = hostname().replace(/\.local$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = base.slice(0, 32).replace(/-+$/, '');
  return name && !RESERVED_NAMES.includes(name) ? name : 'this-mac';
}

export class MachineStore {
  constructor(private readonly dir: string) {}

  get file(): string {
    return join(this.dir, 'machines.json');
  }

  private load(): MachinesFile {
    if (!existsSync(this.file)) return { version: 1, localName: null, order: [], machines: [] };
    const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    const machines: MachineRecord[] = [];
    if (isRecord(parsed) && Array.isArray(parsed.machines)) {
      for (const entry of parsed.machines) {
        if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.url !== 'string' || typeof entry.token !== 'string') continue;
        machines.push({
          name: entry.name,
          url: entry.url,
          token: entry.token,
          readOnly: entry.readOnly === true,
          addedAt: typeof entry.addedAt === 'string' ? entry.addedAt : '',
        });
      }
    }
    return {
      version: 1,
      localName: isRecord(parsed) && typeof parsed.localName === 'string' ? parsed.localName : null,
      order: isRecord(parsed) && Array.isArray(parsed.order) ? parsed.order.filter((name): name is string => typeof name === 'string') : [],
      machines,
    };
  }

  private save(file: MachinesFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
    chmodSync(this.file, 0o600);
  }

  localName(): string {
    return this.load().localName ?? defaultLocalName();
  }

  setLocalName(name: string): void {
    const file = this.load();
    const normalized = validateMachineName(name);
    if (file.machines.some((machine) => machine.name === normalized)) throw new Error(`"${normalized}" is already used by another machine.`);
    const previous = file.localName ?? defaultLocalName();
    file.order = file.order.map((entry) => (entry === previous ? normalized : entry));
    this.save({ ...file, localName: normalized });
  }

  list(): MachineRecord[] {
    return this.load().machines;
  }

  get(name: string): MachineRecord | undefined {
    return this.load().machines.find((machine) => machine.name === name);
  }

  add(record: Omit<MachineRecord, 'addedAt'>, replace = false): MachineRecord {
    const file = this.load();
    const name = validateMachineName(record.name);
    if (name === (file.localName ?? defaultLocalName())) throw new Error(`"${name}" is the name of this machine.`);
    const existing = file.machines.findIndex((machine) => machine.name === name);
    if (existing >= 0 && !replace) throw new Error(`A machine named "${name}" exists. Remove it first or pass --replace.`);
    const saved: MachineRecord = { ...record, name, url: normalizeMachineUrl(record.url), addedAt: new Date().toISOString() };
    if (existing >= 0) file.machines[existing] = saved;
    else file.machines.push(saved);
    this.save(file);
    return saved;
  }

  remove(name: string): boolean {
    const file = this.load();
    const remaining = file.machines.filter((machine) => machine.name !== name);
    if (remaining.length === file.machines.length) return false;
    this.save({ ...file, machines: remaining, order: file.order.filter((entry) => entry !== name) });
    return true;
  }

  /** All machine names, this machine included, in the order "auto" tries them. */
  order(): string[] {
    const file = this.load();
    const names = [file.localName ?? defaultLocalName(), ...file.machines.map((machine) => machine.name)];
    const ordered = file.order.filter((name) => names.includes(name));
    return [...new Set([...ordered, ...names])];
  }

  prefer(name: string): string[] {
    const order = this.order();
    if (!order.includes(name)) throw new Error(`No machine named "${name}". Run: chatgpt-desktop-mcp machine list`);
    const file = this.load();
    const updated = [name, ...order.filter((entry) => entry !== name)];
    this.save({ ...file, order: updated });
    return updated;
  }
}

export interface MachineStatus {
  name: string;
  local: boolean;
  available: boolean;
  access: 'control' | 'read' | null;
  version: string | null;
  liveAppControl: boolean | null;
  hostname: string | null;
  latencyMs: number | null;
  error: string | null;
}

export interface LocalStatusSource {
  version: string;
  liveAppControl(): boolean;
}

const CONNECT_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 150_000;
const STATUS_CACHE_MS = 20_000;

function describeError(error: unknown): string {
  const message = errorMessage(error);
  if (/\b401\b|invalid bearer token/i.test(message)) return 'the token for this machine was rejected';
  if (/\b(502|503|530|1033)\b/.test(message)) return 'not reachable (the Mac may be asleep, offline, or its server stopped)';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timed out|timeout/i.test(message)) return `not reachable (${message})`;
  return message;
}

/** A lazily connected MCP client for one remote machine. */
class RemoteMachine {
  private client: Client | null = null;
  private connecting: Promise<Client> | null = null;
  status: { value: MachineStatus; at: number } | null = null;

  constructor(
    readonly record: MachineRecord,
    private readonly clientVersion: string,
  ) {}

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    if (this.connecting) return this.connecting;
    const transport = new StreamableHTTPClientTransport(new URL(this.record.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.record.token}`, 'user-agent': 'chatgpt-desktop-mcp-router' } },
    });
    const client = new Client({ name: 'chatgpt-desktop-mcp-router', version: this.clientVersion });
    this.connecting = client
      .connect(transport, { timeout: CONNECT_TIMEOUT_MS })
      .then(() => {
        this.client = client;
        return client;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private reset(): void {
    const client = this.client;
    this.client = null;
    void client?.close().catch(() => undefined);
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<CallToolResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const client = await this.connect();
        return (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallToolResult;
      } catch (error) {
        this.reset();
        // Retry once on a stale connection; the servers are stateless, so reconnecting is cheap.
        if (attempt === 0 && !/timed out|timeout/i.test(errorMessage(error))) continue;
        throw error;
      }
    }
  }

  async probe(): Promise<MachineStatus> {
    const started = Date.now();
    const base: MachineStatus = {
      name: this.record.name,
      local: false,
      available: false,
      access: null,
      version: null,
      liveAppControl: null,
      hostname: null,
      latencyMs: null,
      error: null,
    };
    try {
      const result = await this.callTool('list_machines', { includeOthers: false }, STATUS_TIMEOUT_MS);
      const text = result.content.find((part) => part.type === 'text');
      const parsed: unknown = text && text.type === 'text' ? JSON.parse(text.text) : null;
      const self = isRecord(parsed) && Array.isArray(parsed.machines) ? parsed.machines.find((entry) => isRecord(entry) && entry.local === true) : null;
      if (result.isError || !isRecord(self)) throw new Error(text && text.type === 'text' ? text.text : 'unexpected answer');
      const remoteAccess = self.access === 'read' ? 'read' : 'control';
      base.available = true;
      base.access = this.record.readOnly ? 'read' : remoteAccess;
      base.version = typeof self.version === 'string' ? self.version : null;
      base.liveAppControl = typeof self.liveAppControl === 'boolean' ? self.liveAppControl : null;
      base.hostname = typeof self.hostname === 'string' ? self.hostname : null;
    } catch (error) {
      base.error = describeError(error);
    }
    base.latencyMs = Date.now() - started;
    this.status = { value: base, at: Date.now() };
    return base;
  }

  async cachedStatus(): Promise<MachineStatus> {
    if (this.status && Date.now() - this.status.at < STATUS_CACHE_MS) return this.status.value;
    return this.probe();
  }

  close(): void {
    this.reset();
  }
}

export type Target = { kind: 'local'; name: string } | { kind: 'remote'; name: string; remote: RemoteMachine };

/** Resolves machine names to this machine or a remote one, reusing connections across requests. */
export class MachineRouter {
  private readonly remotes = new Map<string, RemoteMachine>();

  constructor(
    readonly store: MachineStore,
    private readonly local: LocalStatusSource,
  ) {}

  /** True when other machines are configured, so tools take a machine argument. */
  hasMachines(): boolean {
    return this.store.list().length > 0;
  }

  localName(): string {
    return this.store.localName();
  }

  private remote(record: MachineRecord): RemoteMachine {
    const key = record.name;
    const existing = this.remotes.get(key);
    if (existing && existing.record.url === record.url && existing.record.token === record.token && existing.record.readOnly === record.readOnly) {
      return existing;
    }
    existing?.close();
    const created = new RemoteMachine(record, this.local.version);
    this.remotes.set(key, created);
    return created;
  }

  localStatus(access: 'control' | 'read'): MachineStatus {
    return {
      name: this.localName(),
      local: true,
      available: true,
      access,
      version: this.local.version,
      liveAppControl: this.local.liveAppControl(),
      hostname: hostname(),
      latencyMs: 0,
      error: null,
    };
  }

  /** Status of every machine in "auto" order. Remote machines are probed in parallel. */
  async statuses(access: 'control' | 'read', refresh = true): Promise<MachineStatus[]> {
    const records = new Map(this.store.list().map((record) => [record.name, record]));
    return Promise.all(
      this.store.order().map(async (name) => {
        const record = records.get(name);
        if (!record) return this.localStatus(access);
        const remote = this.remote(record);
        const status = refresh ? await remote.probe() : await remote.cachedStatus();
        // A read token on the hub can only reach read tools anywhere.
        return access === 'read' && status.access ? { ...status, access: 'read' as const } : status;
      }),
    );
  }

  /**
   * Picks the machine for a request: omitted or "local"/"this" is this machine,
   * "auto" is the first available machine in the saved order.
   */
  async resolve(machine: string | undefined, needsControl: boolean): Promise<Target> {
    const requested = machine?.trim().toLowerCase();
    const localName = this.localName();
    if (!requested || requested === 'local' || requested === 'this' || requested === localName) return { kind: 'local', name: localName };
    if (requested === 'auto') {
      for (const name of this.store.order()) {
        if (name === localName) return { kind: 'local', name };
        const record = this.store.get(name);
        if (!record || (needsControl && record.readOnly)) continue;
        const status = await this.remote(record).cachedStatus();
        if (status.available && (!needsControl || status.access === 'control')) return { kind: 'remote', name, remote: this.remote(record) };
      }
      throw new BridgeError('No machine is available. Check list_machines.');
    }
    if (requested === 'all') throw new BridgeError('"all" is only supported by list_chats and list_pending_requests.');
    const record = this.store.get(requested);
    if (!record) {
      throw new BridgeError(`Unknown machine "${requested}". Known machines: ${this.store.order().join(', ')}. Use list_machines.`);
    }
    if (needsControl && record.readOnly) throw new BridgeError(`Machine "${record.name}" is read-only on this server.`);
    return { kind: 'remote', name: record.name, remote: this.remote(record) };
  }

  /** Every machine for "all" requests, in order. */
  targets(): Target[] {
    const records = new Map(this.store.list().map((record) => [record.name, record]));
    return this.store.order().map((name) => {
      const record = records.get(name);
      return record ? { kind: 'remote', name, remote: this.remote(record) } : { kind: 'local', name };
    });
  }

  close(): void {
    for (const remote of this.remotes.values()) remote.close();
    this.remotes.clear();
  }
}

export function describeMachineError(error: unknown): string {
  return describeError(error);
}
