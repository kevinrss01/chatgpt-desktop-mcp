import { describe, expect, it } from 'vitest';
import { renderPlist, renderTunnelConfig } from '../src/service.js';

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
