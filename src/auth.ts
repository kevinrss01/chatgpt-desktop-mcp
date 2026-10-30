import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from './util.js';

export type Scope = 'read' | 'control';

export interface TokenRecord {
  id: string;
  name: string;
  scope: Scope;
  sha256: string;
  createdAt: string;
}

interface ConfigFile {
  version: 1;
  tokens: TokenRecord[];
}

const TOKEN_PREFIX = 'cdm_';
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isTokenRecord(value: unknown): value is TokenRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.scope === 'read' || value.scope === 'control') &&
    typeof value.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(value.sha256)
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stores SHA-256 digests of bearer tokens. Raw tokens are shown once at creation
 * and never written to disk.
 */
export class TokenStore {
  constructor(private readonly dir: string) {}

  get file(): string {
    return join(this.dir, 'config.json');
  }

  list(): TokenRecord[] {
    return this.load().tokens;
  }

  create(name: string, scope: Scope): { token: string; record: TokenRecord } {
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const record: TokenRecord = {
      id: `tok_${randomBytes(4).toString('hex')}`,
      name,
      scope,
      sha256: sha256Hex(token),
      createdAt: new Date().toISOString(),
    };
    this.withLock(() => {
      const config = this.load();
      config.tokens.push(record);
      this.save(config);
    });
    return { token, record };
  }

  revoke(idOrName: string): boolean {
    return this.withLock(() => {
      const config = this.load();
      const remaining = config.tokens.filter((token) => token.id !== idOrName && token.name !== idOrName);
      if (remaining.length === config.tokens.length) return false;
      this.save({ ...config, tokens: remaining });
      return true;
    });
  }

  /** Returns the matching token record, comparing digests in constant time. */
  verify(token: string): TokenRecord | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const candidate = Buffer.from(sha256Hex(token), 'hex');
    let match: TokenRecord | null = null;
    for (const record of this.load().tokens) {
      const stored = Buffer.from(record.sha256, 'hex');
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) match = record;
    }
    return match;
  }

  /** Serializes read-modify-write cycles across processes so a revoke cannot be undone by a concurrent create. */
  private withLock<T>(operation: () => T): T {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = join(this.dir, 'config.lock');
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        closeSync(openSync(lock, 'wx', 0o600));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) {
            unlinkSync(lock);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error(`The token store is locked by another process (${lock}).`);
        sleepSync(50);
      }
    }
    try {
      return operation();
    } finally {
      try {
        unlinkSync(lock);
      } catch {
        // Already removed.
      }
    }
  }

  private load(): ConfigFile {
    if (!existsSync(this.file)) return { version: 1, tokens: [] };
    const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
    const tokens = isRecord(parsed) && Array.isArray(parsed.tokens) ? parsed.tokens.filter(isTokenRecord) : [];
    return { version: 1, tokens };
  }

  private save(config: ConfigFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.file);
    chmodSync(this.file, 0o600);
  }
}
