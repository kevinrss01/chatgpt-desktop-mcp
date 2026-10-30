import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenStore } from '../src/auth.js';

describe('TokenStore', () => {
  it('verifies created tokens, keeps only digests on disk, and revokes', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cdm-auth-')), 'config');
    const store = new TokenStore(dir);
    const { token, record } = store.create('monitor', 'read');

    expect(token).toMatch(/^cdm_[A-Za-z0-9_-]{43}$/);
    expect(store.verify(token)).toMatchObject({ id: record.id, scope: 'read' });
    expect(store.verify(`${token}x`)).toBeNull();
    expect(store.verify('not-a-token')).toBeNull();
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(store.list())).not.toContain(token);

    expect(store.revoke('monitor')).toBe(true);
    expect(store.verify(token)).toBeNull();
    expect(store.revoke('monitor')).toBe(false);
  });

  it('recovers from a lock left behind by a crashed process', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cdm-auth-')), 'config');
    mkdirSync(dir, { recursive: true });
    const lock = join(dir, 'config.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const store = new TokenStore(dir);
    const { token } = store.create('after-crash', 'read');
    expect(store.verify(token)).not.toBeNull();
    expect(existsSync(lock)).toBe(false);
  });
});
