import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { protectedFolder } from '../src/permissions.js';
import {
  normalizePublicUrl,
  publicBaseUrl,
  renderPlist,
  renderTunnelConfig,
  resolveServiceSettings,
  serveArguments,
  type ServiceSettings,
} from '../src/service.js';

const saved: ServiceSettings = {
  port: 9000,
  hostname: 'mcp.example.com',
  tunnelName: 'my-tunnel',
  tunnelCredentials: null,
  publicUrl: null,
  keepAwake: 'always',
  openApp: false,
  serve: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
};

describe('resolveServiceSettings', () => {
  it('uses defaults on a first install', () => {
    expect(resolveServiceSettings({}, null)).toEqual({
      port: 8723,
      hostname: null,
      tunnelName: null,
      tunnelCredentials: null,
      publicUrl: null,
      keepAwake: 'ac',
      openApp: true,
      serve: {},
    });
    expect(resolveServiceSettings({ hostname: 'MCP.Example.org.' }, null)).toMatchObject({ hostname: 'mcp.example.org', tunnelName: 'chatgpt-desktop-mcp' });
  });

  it('keeps the saved URL and server flags when install runs again without options', () => {
    expect(resolveServiceSettings({}, saved)).toEqual(saved);
    expect(resolveServiceSettings({ keepAwake: 'off', serve: { sandbox: 'read-only' } }, saved)).toMatchObject({
      hostname: 'mcp.example.com',
      tunnelName: 'my-tunnel',
      keepAwake: 'off',
      serve: { sandbox: 'read-only', approvalPolicy: 'on-request' },
    });
  });

  it('switches between a Cloudflare hostname, your own proxy, and local only', () => {
    const proxied = resolveServiceSettings({ publicUrl: 'https://my-mac.tail1234.ts.net/mcp/' }, saved);
    expect(proxied).toMatchObject({ hostname: null, tunnelName: null, publicUrl: 'https://my-mac.tail1234.ts.net' });
    expect(resolveServiceSettings({ hostname: 'agents.example.net' }, proxied)).toMatchObject({ hostname: 'agents.example.net', tunnelName: 'chatgpt-desktop-mcp', publicUrl: null });
    expect(resolveServiceSettings({ hostname: 'agents.example.net' }, saved).tunnelName).toBe('my-tunnel');
    expect(resolveServiceSettings({ localOnly: true }, saved)).toMatchObject({ hostname: null, tunnelName: null, publicUrl: null, port: 9000 });
    expect(resolveServiceSettings({ reset: true }, saved)).toEqual(resolveServiceSettings({}, null));
  });

  it('rejects conflicting or malformed options', () => {
    expect(() => resolveServiceSettings({ hostname: 'a.example.com', publicUrl: 'https://b.example.com' }, null)).toThrow(/only one/);
    expect(() => resolveServiceSettings({ tunnelName: 'x' }, null)).toThrow(/needs --hostname/);
    expect(() => resolveServiceSettings({ hostname: 'https://mcp.example.com' }, null)).toThrow(/--public-url/);
    expect(() => resolveServiceSettings({ port: 0 }, null)).toThrow(/--port/);
    expect(() => normalizePublicUrl('ftp://example.com')).toThrow(/https/);
  });

  it('runs a tunnel created on another Mac from its credentials file', () => {
    const imported = resolveServiceSettings({ hostname: 'mini.example.com', tunnelCredentials: '/tmp/abc.json' }, null);
    expect(imported).toMatchObject({ hostname: 'mini.example.com', tunnelName: null, tunnelCredentials: '/tmp/abc.json' });
    expect(resolveServiceSettings({}, imported)).toEqual(imported);
    expect(resolveServiceSettings({ tunnelName: 'own' }, imported)).toMatchObject({ tunnelName: 'own', tunnelCredentials: null });
    expect(resolveServiceSettings({ publicUrl: 'https://x.example.com' }, imported).tunnelCredentials).toBeNull();
    expect(() => resolveServiceSettings({ tunnelCredentials: '/tmp/abc.json' }, null)).toThrow(/needs --hostname/);
  });
});

describe('server arguments and URLs', () => {
  it('passes saved server flags to serve and builds the public URL', () => {
    expect(serveArguments({ ...saved, serve: { ...saved.serve, allowOrigins: ['https://a.example'] } })).toEqual([
      'serve',
      '--host',
      '127.0.0.1',
      '--port',
      '9000',
      '--sandbox',
      'workspace-write',
      '--approval-policy',
      'on-request',
      '--allow-origin',
      'https://a.example',
    ]);
    expect(publicBaseUrl(saved)).toBe('https://mcp.example.com');
    expect(publicBaseUrl({ hostname: null, publicUrl: 'https://example.com/codex' })).toBe('https://example.com/codex');
    expect(publicBaseUrl({ hostname: null, publicUrl: null })).toBeNull();
  });
});

describe('protectedFolder', () => {
  it('flags folders macOS guards from background processes', () => {
    expect(protectedFolder(join(homedir(), 'Documents', 'Codex'))).toBe(join(homedir(), 'Documents'));
    expect(protectedFolder(join(homedir(), 'Desktop'))).toBe(join(homedir(), 'Desktop'));
    expect(protectedFolder('/Volumes/Work/projects')).toBe('/Volumes/Work');
    expect(protectedFolder(join(homedir(), 'DocumentsArchive'))).toBeNull();
    expect(protectedFolder(join(homedir(), 'code', 'app'))).toBeNull();
  });
});

describe('renderPlist', () => {
  it('escapes arguments and sets restart keys only for long-running agents', () => {
    const plist = renderPlist({
      label: 'com.chatgpt-desktop-mcp.server',
      program: ['/usr/bin/node', '/tmp/a&b <c>/cli.js', 'serve'],
      runAtLoad: true,
      keepAlive: true,
      logFile: '/tmp/server.log',
      env: { PATH: '/usr/bin:/bin' },
    });
    expect(plist).toContain('<string>/tmp/a&amp;b &lt;c&gt;/cli.js</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<key>PATH</key><string>/usr/bin:/bin</string>');
    expect(plist).not.toContain('StartInterval');

    const periodic = renderPlist({ label: 'w', program: ['/bin/true'], runAtLoad: false, keepAlive: false, startInterval: 120, logFile: '/tmp/w.log' });
    expect(periodic).toContain('<key>StartInterval</key><integer>120</integer>');
    expect(periodic).not.toContain('KeepAlive');
  });
});

describe('renderTunnelConfig', () => {
  it('routes only the chosen hostname to the local server', () => {
    expect(renderTunnelConfig('abc', '/creds/abc.json', 8723, 'mcp.example.com')).toBe(
      [
        'tunnel: abc',
        'credentials-file: /creds/abc.json',
        'ingress:',
        '  - hostname: mcp.example.com',
        '    service: http://127.0.0.1:8723',
        '  - service: http_status:404',
        '',
      ].join('\n'),
    );
  });
});
