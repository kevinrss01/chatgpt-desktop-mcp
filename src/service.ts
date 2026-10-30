import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BUNDLE_PATHS, configDir } from './paths.js';
import { errorMessage, isRecord } from './util.js';

/**
 * Keeps the MCP server reachable with macOS LaunchAgents: the server and the
 * Cloudflare tunnel restart when they exit, a watchdog restarts whichever stops
 * answering, and everything starts again at login.
 */

export const LABEL_PREFIX = 'com.chatgpt-desktop-mcp';
export const ROLES = ['server', 'tunnel', 'watchdog', 'keepawake', 'openapp'] as const;
export type Role = (typeof ROLES)[number];

export interface ServiceConfig {
  version: 1;
  port: number;
  hostname: string | null;
  tunnelName: string | null;
  tunnelId: string | null;
  roles: Role[];
}

export interface AgentSpec {
  label: string;
  program: string[];
  runAtLoad: boolean;
  keepAlive: boolean;
  startInterval?: number;
  logFile: string;
  env?: Record<string, string>;
}

export interface InstallOptions {
  port: number;
  tunnel?: string;
  hostname?: string;
  overwriteDns?: boolean;
  keepAwake: boolean;
  openApp: boolean;
  nodePath?: string;
}

const WATCHDOG_INTERVAL_SECONDS = 120;
const PUBLIC_FAILURES_BEFORE_RESTART = 2;
const BOOTSTRAP_ATTEMPTS = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function label(role: Role): string {
  return `${LABEL_PREFIX}.${role}`;
}

export function logDirectory(): string {
  return join(homedir(), 'Library', 'Logs', 'chatgpt-desktop-mcp');
}

function launchAgentPath(role: Role): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${label(role)}.plist`);
}

function serviceConfigPath(): string {
  return join(configDir(), 'service.json');
}

function watchdogStatePath(): string {
  return join(configDir(), 'watchdog-state.json');
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderPlist(spec: AgentSpec): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xmlEscape(spec.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...spec.program.map((argument) => `    <string>${xmlEscape(argument)}</string>`),
    '  </array>',
    `  <key>RunAtLoad</key><${spec.runAtLoad ? 'true' : 'false'}/>`,
  ];
  if (spec.keepAlive) {
    lines.push('  <key>KeepAlive</key><true/>', '  <key>ThrottleInterval</key><integer>10</integer>');
  }
  if (spec.startInterval) lines.push(`  <key>StartInterval</key><integer>${spec.startInterval}</integer>`);
  if (spec.env && Object.keys(spec.env).length > 0) {
    lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
    for (const [key, value] of Object.entries(spec.env)) {
      lines.push(`    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`);
    }
    lines.push('  </dict>');
  }
  lines.push(
    `  <key>StandardOutPath</key><string>${xmlEscape(spec.logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(spec.logFile)}</string>`,
    '</dict>',
    '</plist>',
    '',
  );
  return lines.join('\n');
}

export function renderTunnelConfig(tunnelId: string, credentialsFile: string, port: number, hostname: string | null): string {
  const lines = [`tunnel: ${tunnelId}`, `credentials-file: ${credentialsFile}`, 'ingress:'];
  if (hostname) lines.push(`  - hostname: ${hostname}`, `    service: http://127.0.0.1:${port}`, '  - service: http_status:404');
  else lines.push(`  - service: http://127.0.0.1:${port}`);
  return `${lines.join('\n')}\n`;
}

/** First executable named `name` on PATH, keeping symlinks so version-manager upgrades keep working. */
export function findExecutable(name: string): string | null {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return null;
}

function uid(): number {
  const value = process.getuid?.();
  if (value == null) throw new Error('LaunchAgents need a macOS user session.');
  return value;
}

function launchctl(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function loadAgent(role: Role, spec: AgentSpec): void {
  const path = launchAgentPath(role);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderPlist(spec), { mode: 0o644 });
  const domain = `gui/${uid()}`;
  launchctl(['bootout', `${domain}/${spec.label}`]);
  launchctl(['enable', `${domain}/${spec.label}`]);
  // bootout returns before the old job is fully gone, so bootstrap can fail briefly with an I/O error.
  let loaded = launchctl(['bootstrap', domain, path]);
  for (let attempt = 1; !loaded.ok && attempt < BOOTSTRAP_ATTEMPTS; attempt += 1) {
    sleepSync(500);
    loaded = launchctl(['bootstrap', domain, path]);
  }
  if (!loaded.ok) throw new Error(`launchctl could not load ${spec.label}: ${loaded.output}`);
}

function unloadAgent(role: Role): void {
  launchctl(['bootout', `gui/${uid()}/${label(role)}`]);
  const path = launchAgentPath(role);
  if (existsSync(path)) unlinkSync(path);
}

export function readServiceConfig(): ServiceConfig | null {
  if (!existsSync(serviceConfigPath())) return null;
  const parsed: unknown = JSON.parse(readFileSync(serviceConfigPath(), 'utf8'));
  if (!isRecord(parsed) || typeof parsed.port !== 'number' || !Array.isArray(parsed.roles)) return null;
  return {
    version: 1,
    port: parsed.port,
    hostname: typeof parsed.hostname === 'string' ? parsed.hostname : null,
    tunnelName: typeof parsed.tunnelName === 'string' ? parsed.tunnelName : null,
    tunnelId: typeof parsed.tunnelId === 'string' ? parsed.tunnelId : null,
    roles: parsed.roles.filter((role): role is Role => (ROLES as readonly string[]).includes(String(role))),
  };
}

function cloudflaredJson(cloudflared: string, args: string[]): unknown {
  return JSON.parse(execFileSync(cloudflared, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

/** Returns the id of the named tunnel, creating it if needed. Requires `cloudflared tunnel login`. */
function ensureTunnel(cloudflared: string, name: string): string {
  if (!existsSync(join(homedir(), '.cloudflared', 'cert.pem'))) {
    throw new Error('Cloudflare is not logged in on this Mac. Run: cloudflared tunnel login');
  }
  const tunnels = cloudflaredJson(cloudflared, ['tunnel', 'list', '--output', 'json']);
  const existing = Array.isArray(tunnels) ? tunnels.find((tunnel) => isRecord(tunnel) && tunnel.name === name) : undefined;
  if (isRecord(existing) && typeof existing.id === 'string') return existing.id;
  const created = cloudflaredJson(cloudflared, ['tunnel', 'create', '--output', 'json', name]);
  if (isRecord(created) && typeof created.id === 'string') return created.id;
  throw new Error(`cloudflared did not return an id for tunnel ${name}`);
}

function routeHostname(cloudflared: string, tunnelId: string, hostname: string, overwrite: boolean): void {
  const args = ['tunnel', 'route', 'dns', ...(overwrite ? ['--overwrite-dns'] : []), tunnelId, hostname];
  const result = spawnSync(cloudflared, args, { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0) return;
  // Re-running install is fine when the record already points at this tunnel.
  if (/already configured to route to your tunnel/i.test(output)) return;
  throw new Error(`Could not route ${hostname} to the tunnel: ${output.trim()}\nUse --overwrite-dns to replace an existing DNS record.`);
}

export function installService(options: InstallOptions): { config: ServiceConfig; agents: string[] } {
  if (process.platform !== 'darwin') throw new Error('The service command manages macOS LaunchAgents.');
  const node = options.nodePath ?? findExecutable('node') ?? process.execPath;
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const logs = logDirectory();
  mkdirSync(logs, { recursive: true });
  const path = [dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

  const specs = new Map<Role, AgentSpec>();
  specs.set('server', {
    label: label('server'),
    program: [node, cli, 'serve', '--host', '127.0.0.1', '--port', String(options.port)],
    runAtLoad: true,
    keepAlive: true,
    logFile: join(logs, 'server.log'),
    env: { PATH: path },
  });

  let tunnelId: string | null = null;
  if (options.tunnel) {
    const cloudflared = findExecutable('cloudflared');
    if (!cloudflared) throw new Error('cloudflared is not installed. Install it with: brew install cloudflared');
    tunnelId = ensureTunnel(cloudflared, options.tunnel);
    if (options.hostname) routeHostname(cloudflared, tunnelId, options.hostname, options.overwriteDns ?? false);
    const credentials = join(homedir(), '.cloudflared', `${tunnelId}.json`);
    if (!existsSync(credentials)) throw new Error(`Tunnel credentials not found at ${credentials}. Create the tunnel on this Mac.`);
    const tunnelConfig = join(configDir(), 'cloudflared.yml');
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(tunnelConfig, renderTunnelConfig(tunnelId, credentials, options.port, options.hostname ?? null), { mode: 0o600 });
    specs.set('tunnel', {
      label: label('tunnel'),
      program: [cloudflared, 'tunnel', '--no-autoupdate', '--loglevel', 'warn', '--config', tunnelConfig, 'run', tunnelId],
      runAtLoad: true,
      keepAlive: true,
      logFile: join(logs, 'tunnel.log'),
    });
  }

  specs.set('watchdog', {
    label: label('watchdog'),
    program: [node, cli, 'service', 'check', '--repair', '--quiet'],
    runAtLoad: false,
    keepAlive: false,
    startInterval: WATCHDOG_INTERVAL_SECONDS,
    logFile: join(logs, 'watchdog.log'),
    env: { PATH: path },
  });
  if (options.keepAwake) {
    // -s prevents system sleep only while the Mac is on AC power.
    specs.set('keepawake', { label: label('keepawake'), program: ['/usr/bin/caffeinate', '-s'], runAtLoad: true, keepAlive: true, logFile: join(logs, 'keepawake.log') });
  }
  if (options.openApp) {
    const bundle = APP_BUNDLE_PATHS.find((candidate) => existsSync(candidate));
    if (bundle) {
      specs.set('openapp', { label: label('openapp'), program: ['/usr/bin/open', '-g', bundle], runAtLoad: true, keepAlive: false, logFile: join(logs, 'openapp.log') });
    }
  }

  const config: ServiceConfig = {
    version: 1,
    port: options.port,
    hostname: options.hostname ?? null,
    tunnelName: options.tunnel ?? null,
    tunnelId,
    roles: [...specs.keys()],
  };
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(serviceConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  for (const role of ROLES) if (!specs.has(role)) unloadAgent(role);
  for (const [role, spec] of specs) loadAgent(role, spec);
  return { config, agents: [...specs.values()].map((spec) => spec.label) };
}

export function uninstallService(): Role[] {
  for (const role of ROLES) unloadAgent(role);
  for (const file of [serviceConfigPath(), watchdogStatePath()]) if (existsSync(file)) unlinkSync(file);
  return [...ROLES];
}

export async function probeHealth(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'chatgpt-desktop-mcp-watchdog' } });
    return response.ok;
  } catch {
    return false;
  }
}

export interface AgentState {
  label: string;
  loaded: boolean;
  running: boolean;
  pid: number | null;
  lastExit: string | null;
}

export function agentState(role: Role): AgentState {
  const result = launchctl(['print', `gui/${uid()}/${label(role)}`]);
  if (!result.ok) return { label: label(role), loaded: false, running: false, pid: null, lastExit: null };
  const pid = /\bpid = (\d+)/.exec(result.output)?.[1];
  return {
    label: label(role),
    loaded: true,
    running: /\bstate = running/.test(result.output),
    pid: pid ? Number(pid) : null,
    lastExit: /last exit code = ([^\n]+)/.exec(result.output)?.[1]?.trim() ?? null,
  };
}

export interface CheckResult {
  local: boolean;
  public: boolean | null;
  internet: boolean | null;
  actions: string[];
}

/**
 * Health check used by the watchdog. With repair, it restarts the server when
 * localhost stops answering, and restarts the tunnel when the public URL fails
 * twice in a row while the internet and the local server are up. Only repair
 * runs count toward that limit, so manual status checks never trigger a restart.
 */
export async function checkService(repair: boolean): Promise<CheckResult> {
  const config = readServiceConfig();
  if (!config) throw new Error('The service is not installed. Run: chatgpt-desktop-mcp service install');
  const actions: string[] = [];
  const domain = `gui/${uid()}`;
  const local = await probeHealth(`http://127.0.0.1:${config.port}/healthz`, 5_000);
  if (!local && repair && config.roles.includes('server')) {
    launchctl(['kickstart', '-k', `${domain}/${label('server')}`]);
    actions.push('restarted server');
  }

  let publicOk: boolean | null = null;
  let internet: boolean | null = null;
  if (config.hostname) {
    publicOk = await probeHealth(`https://${config.hostname}/healthz`, 10_000);
    if (!publicOk) internet = await probeHealth('https://1.1.1.1/cdn-cgi/trace', 5_000);
    if (!repair) return { local, public: publicOk, internet, actions };
    let failures = 0;
    try {
      const state: unknown = JSON.parse(readFileSync(watchdogStatePath(), 'utf8'));
      failures = isRecord(state) && typeof state.publicFailures === 'number' ? state.publicFailures : 0;
    } catch {
      failures = 0;
    }
    if (publicOk) {
      failures = 0;
    } else {
      if (internet && local) failures += 1;
      if (failures >= PUBLIC_FAILURES_BEFORE_RESTART && config.roles.includes('tunnel')) {
        launchctl(['kickstart', '-k', `${domain}/${label('tunnel')}`]);
        actions.push('restarted tunnel');
        failures = 0;
      }
    }
    try {
      writeFileSync(watchdogStatePath(), JSON.stringify({ publicFailures: failures, checkedAt: new Date().toISOString() }), { mode: 0o600 });
    } catch (error) {
      actions.push(`could not save watchdog state: ${errorMessage(error)}`);
    }
  }
  return { local, public: publicOk, internet, actions };
}
