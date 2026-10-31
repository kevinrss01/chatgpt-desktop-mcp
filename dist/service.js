import { execFileSync, spawnSync } from 'node:child_process';
import { resolveNs } from 'node:dns/promises';
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BUNDLE_PATHS, configDir } from './paths.js';
import { errorMessage, isRecord } from './util.js';
/**
 * Keeps the MCP server reachable with macOS LaunchAgents: the server and an
 * optional Cloudflare tunnel restart when they exit, a watchdog restarts
 * whichever stops answering, and everything starts again at login.
 */
export const LABEL_PREFIX = 'com.chatgpt-desktop-mcp';
export const ROLES = ['server', 'tunnel', 'watchdog', 'keepawake', 'openapp'];
export const KEEP_AWAKE_MODES = ['ac', 'always', 'off'];
export const DEFAULT_PORT = 8723;
export const DEFAULT_TUNNEL_NAME = 'chatgpt-desktop-mcp';
const WATCHDOG_INTERVAL_SECONDS = 120;
const PUBLIC_FAILURES_BEFORE_RESTART = 2;
const BOOTSTRAP_ATTEMPTS = 10;
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;
const TUNNEL_NAME = /^[A-Za-z0-9][\w.-]{0,62}$/;
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
export function label(role) {
    return `${LABEL_PREFIX}.${role}`;
}
export function logDirectory() {
    return join(homedir(), 'Library', 'Logs', 'chatgpt-desktop-mcp');
}
function launchAgentPath(role) {
    return join(homedir(), 'Library', 'LaunchAgents', `${label(role)}.plist`);
}
function serviceConfigPath() {
    return join(configDir(), 'service.json');
}
function watchdogStatePath() {
    return join(configDir(), 'watchdog-state.json');
}
/** Written by the background server after it checks access to the folder where new chats go. */
export function folderAccessPath() {
    return join(configDir(), 'folder-access.json');
}
export function readFolderAccess() {
    try {
        const parsed = JSON.parse(readFileSync(folderAccessPath(), 'utf8'));
        if (!isRecord(parsed) || typeof parsed.folder !== 'string' || typeof parsed.state !== 'string')
            return null;
        return {
            folder: parsed.folder,
            state: parsed.state,
            node: typeof parsed.node === 'string' ? parsed.node : '',
            checkedAt: typeof parsed.checkedAt === 'string' ? parsed.checkedAt : '',
        };
    }
    catch {
        return null;
    }
}
export function normalizeHostname(value) {
    const hostname = value.trim().toLowerCase().replace(/\.$/, '');
    if (/^[a-z]+:\/\//.test(hostname) || hostname.includes('/')) {
        throw new Error('--hostname takes a bare hostname such as mcp.example.com. Use --public-url for a full URL.');
    }
    if (!HOSTNAME.test(hostname))
        throw new Error(`"${value}" is not a valid hostname, e.g. mcp.example.com`);
    return hostname;
}
/** Normalizes a public base URL: no trailing slash, no trailing /mcp, no query. */
export function normalizePublicUrl(value) {
    let url;
    try {
        url = new URL(value.trim());
    }
    catch {
        throw new Error(`"${value}" is not a valid URL, e.g. https://mcp.example.com`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new Error('--public-url must start with https:// or http://');
    if (url.username || url.password)
        throw new Error('--public-url must not contain credentials');
    const path = url.pathname.replace(/\/+$/, '').replace(/\/mcp$/, '');
    return `${url.origin}${path}`;
}
function cleanServeSettings(value) {
    const result = {};
    if (!value)
        return result;
    if (value.sandbox)
        result.sandbox = value.sandbox;
    if (value.approvalPolicy)
        result.approvalPolicy = value.approvalPolicy;
    if (value.workspaceRoot)
        result.workspaceRoot = value.workspaceRoot;
    if (value.codexBin)
        result.codexBin = value.codexBin;
    if (value.allowOrigins && value.allowOrigins.length > 0)
        result.allowOrigins = [...value.allowOrigins];
    return result;
}
/**
 * Combines command-line values with the settings saved by the previous install,
 * so running install again after an upgrade keeps the same URL and options.
 */
export function resolveServiceSettings(input, saved) {
    const base = input.reset ? null : saved;
    const exposures = [input.hostname !== undefined, input.publicUrl !== undefined, input.localOnly === true].filter(Boolean).length;
    if (exposures > 1)
        throw new Error('Use only one of --hostname, --public-url, and --local-only.');
    let hostname = base?.hostname ?? null;
    let tunnelName = base?.tunnelName ?? null;
    let publicUrl = base?.publicUrl ?? null;
    if (input.localOnly) {
        hostname = null;
        tunnelName = null;
        publicUrl = null;
    }
    if (input.hostname !== undefined) {
        if (!hostname)
            tunnelName = null;
        hostname = normalizeHostname(input.hostname);
        publicUrl = null;
    }
    if (input.publicUrl !== undefined) {
        publicUrl = normalizePublicUrl(input.publicUrl);
        hostname = null;
        tunnelName = null;
    }
    if (input.tunnelName !== undefined) {
        if (!hostname)
            throw new Error('--tunnel-name needs --hostname.');
        if (!TUNNEL_NAME.test(input.tunnelName))
            throw new Error('--tunnel-name may contain letters, digits, ".", "_", and "-" (up to 63 characters).');
        tunnelName = input.tunnelName;
    }
    if (hostname && !tunnelName)
        tunnelName = DEFAULT_TUNNEL_NAME;
    const port = input.port ?? base?.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('--port must be a number between 1 and 65535');
    return {
        port,
        hostname,
        tunnelName,
        publicUrl,
        keepAwake: input.keepAwake ?? base?.keepAwake ?? 'ac',
        openApp: input.openApp ?? base?.openApp ?? true,
        serve: { ...cleanServeSettings(base?.serve), ...cleanServeSettings(input.serve) },
    };
}
/** The URL agents use, without the /mcp suffix, or null when the server is local only. */
export function publicBaseUrl(settings) {
    if (settings.hostname)
        return `https://${settings.hostname}`;
    return settings.publicUrl;
}
export function serveArguments(settings) {
    const args = ['serve', '--host', '127.0.0.1', '--port', String(settings.port)];
    const { serve } = settings;
    if (serve.sandbox)
        args.push('--sandbox', serve.sandbox);
    if (serve.approvalPolicy)
        args.push('--approval-policy', serve.approvalPolicy);
    if (serve.workspaceRoot)
        args.push('--workspace-root', serve.workspaceRoot);
    if (serve.codexBin)
        args.push('--codex-bin', serve.codexBin);
    for (const origin of serve.allowOrigins ?? [])
        args.push('--allow-origin', origin);
    return args;
}
function xmlEscape(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export function renderPlist(spec) {
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
    if (spec.startInterval)
        lines.push(`  <key>StartInterval</key><integer>${spec.startInterval}</integer>`);
    if (spec.env && Object.keys(spec.env).length > 0) {
        lines.push('  <key>EnvironmentVariables</key>', '  <dict>');
        for (const [key, value] of Object.entries(spec.env)) {
            lines.push(`    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`);
        }
        lines.push('  </dict>');
    }
    lines.push(`  <key>StandardOutPath</key><string>${xmlEscape(spec.logFile)}</string>`, `  <key>StandardErrorPath</key><string>${xmlEscape(spec.logFile)}</string>`, '</dict>', '</plist>', '');
    return lines.join('\n');
}
export function renderTunnelConfig(tunnelId, credentialsFile, port, hostname) {
    const lines = [`tunnel: ${tunnelId}`, `credentials-file: ${credentialsFile}`, 'ingress:'];
    if (hostname)
        lines.push(`  - hostname: ${hostname}`, `    service: http://127.0.0.1:${port}`, '  - service: http_status:404');
    else
        lines.push(`  - service: http://127.0.0.1:${port}`);
    return `${lines.join('\n')}\n`;
}
/** First executable named `name` on PATH, keeping symlinks so version-manager upgrades keep working. */
export function findExecutable(name) {
    for (const directory of (process.env.PATH ?? '').split(delimiter)) {
        if (!directory)
            continue;
        const candidate = join(directory, name);
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            // Not here.
        }
    }
    return null;
}
function uid() {
    const value = process.getuid?.();
    if (value == null)
        throw new Error('LaunchAgents need a macOS user session.');
    return value;
}
function launchctl(args) {
    const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
    return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}
function loadAgent(role, spec) {
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
    if (!loaded.ok)
        throw new Error(`launchctl could not load ${spec.label}: ${loaded.output}`);
}
function unloadAgent(role) {
    launchctl(['bootout', `gui/${uid()}/${label(role)}`]);
    const path = launchAgentPath(role);
    if (existsSync(path))
        unlinkSync(path);
}
function parseServeSettings(value) {
    if (!isRecord(value))
        return {};
    return cleanServeSettings({
        sandbox: typeof value.sandbox === 'string' ? value.sandbox : undefined,
        approvalPolicy: typeof value.approvalPolicy === 'string' ? value.approvalPolicy : undefined,
        workspaceRoot: typeof value.workspaceRoot === 'string' ? value.workspaceRoot : undefined,
        codexBin: typeof value.codexBin === 'string' ? value.codexBin : undefined,
        allowOrigins: Array.isArray(value.allowOrigins) ? value.allowOrigins.filter((origin) => typeof origin === 'string') : undefined,
    });
}
export function readServiceConfig() {
    if (!existsSync(serviceConfigPath()))
        return null;
    const parsed = JSON.parse(readFileSync(serviceConfigPath(), 'utf8'));
    if (!isRecord(parsed) || typeof parsed.port !== 'number' || !Array.isArray(parsed.roles))
        return null;
    const roles = parsed.roles.filter((role) => ROLES.includes(String(role)));
    const keepAwake = KEEP_AWAKE_MODES.includes(parsed.keepAwake) ? parsed.keepAwake : null;
    return {
        version: 1,
        port: parsed.port,
        hostname: typeof parsed.hostname === 'string' ? parsed.hostname : null,
        tunnelName: typeof parsed.tunnelName === 'string' ? parsed.tunnelName : null,
        tunnelId: typeof parsed.tunnelId === 'string' ? parsed.tunnelId : null,
        node: typeof parsed.node === 'string' ? parsed.node : null,
        publicUrl: typeof parsed.publicUrl === 'string' ? parsed.publicUrl : null,
        // Files written by 0.1.x only list roles.
        keepAwake: keepAwake ?? (roles.includes('keepawake') ? 'ac' : 'off'),
        openApp: typeof parsed.openApp === 'boolean' ? parsed.openApp : roles.includes('openapp'),
        serve: parseServeSettings(parsed.serve),
        roles,
    };
}
/** Path of the Cloudflare origin certificate from `cloudflared tunnel login`, honoring TUNNEL_ORIGIN_CERT. */
function originCertificate() {
    const explicit = process.env.TUNNEL_ORIGIN_CERT?.trim();
    if (explicit)
        return existsSync(explicit) ? explicit : null;
    const candidates = [join(homedir(), '.cloudflared'), join(homedir(), '.cloudflare-warp'), join(homedir(), 'cloudflare-warp'), '/etc/cloudflared', '/usr/local/etc/cloudflared'];
    return candidates.map((directory) => join(directory, 'cert.pem')).find((path) => existsSync(path)) ?? null;
}
function cloudflaredJson(cloudflared, args) {
    return JSON.parse(execFileSync(cloudflared, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
/** Returns the id of the named tunnel, creating it if needed. */
function ensureTunnel(cloudflared, name) {
    const tunnels = cloudflaredJson(cloudflared, ['tunnel', 'list', '--output', 'json']);
    const existing = Array.isArray(tunnels) ? tunnels.find((tunnel) => isRecord(tunnel) && tunnel.name === name) : undefined;
    if (isRecord(existing) && typeof existing.id === 'string')
        return existing.id;
    const created = cloudflaredJson(cloudflared, ['tunnel', 'create', '--output', 'json', name]);
    if (isRecord(created) && typeof created.id === 'string')
        return created.id;
    throw new Error(`cloudflared did not return an id for tunnel ${name}`);
}
/** Finds the nameservers of the closest DNS zone that contains `hostname`. */
async function zoneNameservers(hostname) {
    const labels = hostname.split('.');
    for (let index = 0; index < labels.length - 1; index += 1) {
        const zone = labels.slice(index).join('.');
        try {
            const nameservers = await resolveNs(zone);
            if (nameservers.length > 0)
                return { zone, nameservers };
        }
        catch {
            // Not a zone apex; keep walking up.
        }
    }
    return null;
}
/** Name of the Cloudflare zone that `cloudflared tunnel login` authorized, or null if it cannot be read. */
async function loginZone(certificate) {
    try {
        const block = /-----BEGIN ARGO TUNNEL TOKEN-----([\s\S]*?)-----END ARGO TUNNEL TOKEN-----/.exec(readFileSync(certificate, 'utf8'));
        if (!block?.[1])
            return null;
        const token = JSON.parse(Buffer.from(block[1].replace(/\s/g, ''), 'base64').toString('utf8'));
        if (!isRecord(token) || typeof token.zoneID !== 'string' || typeof token.apiToken !== 'string')
            return null;
        // The same request cloudflared makes with this token; it only goes to the Cloudflare API.
        const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(token.zoneID)}`, {
            headers: { authorization: `Bearer ${token.apiToken}` },
            signal: AbortSignal.timeout(10_000),
        });
        const body = await response.json();
        return isRecord(body) && isRecord(body.result) && typeof body.result.name === 'string' ? body.result.name.toLowerCase() : null;
    }
    catch {
        return null;
    }
}
/**
 * cloudflared creates the DNS record in the zone it is logged in to. A hostname
 * from another domain would silently become "<hostname>.<login zone>", so stop first.
 */
async function assertHostnameZone(hostname, certificate) {
    const zone = await loginZone(certificate);
    if (zone) {
        if (hostname === zone || hostname.endsWith(`.${zone}`))
            return;
        throw new Error(`The Cloudflare login on this Mac is for ${zone}, so cloudflared would create ${hostname}.${zone} instead of ${hostname}.\n` +
            `Run "cloudflared tunnel login" and pick the domain of ${hostname} (or set TUNNEL_ORIGIN_CERT to that domain's cert.pem), then run install again.`);
    }
    // The zone could not be read (offline or an old certificate): at least make sure the domain is on Cloudflare.
    const found = await zoneNameservers(hostname);
    if (!found)
        return; // Offline or unknown: let cloudflared decide.
    if (found.nameservers.some((nameserver) => /\.ns\.cloudflare\.com\.?$/i.test(nameserver)))
        return;
    throw new Error(`${found.zone} uses ${found.nameservers.join(', ')}, not Cloudflare DNS, so a Cloudflare tunnel cannot publish ${hostname}.\n` +
        'Add the domain to Cloudflare (the free plan works), or run your own tunnel or proxy and use --public-url.\n' +
        'Pass --skip-zone-check to bypass this check.');
}
function routeHostname(cloudflared, tunnelId, hostname, overwrite) {
    const args = ['tunnel', 'route', 'dns', ...(overwrite ? ['--overwrite-dns'] : []), tunnelId, hostname];
    const result = spawnSync(cloudflared, args, { encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status === 0)
        return;
    // Re-running install is fine when the record already points at this tunnel.
    if (/already configured to route to your tunnel/i.test(output))
        return;
    throw new Error(`Could not route ${hostname} to the tunnel: ${output.trim()}\nUse --overwrite-dns to replace an existing DNS record.`);
}
function tunnelCredentials(tunnelId, certificate) {
    const candidates = [join(dirname(certificate), `${tunnelId}.json`), join(homedir(), '.cloudflared', `${tunnelId}.json`)];
    const found = candidates.find((path) => existsSync(path));
    if (!found)
        throw new Error(`Tunnel credentials not found (${candidates.join(' or ')}). The tunnel was probably created on another machine; pick a new --tunnel-name.`);
    return found;
}
/** Environment for the agents, so they use the same config folder and Codex home as the install command. */
function agentEnvironment(node) {
    const path = [dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
    const env = { PATH: [...new Set(path)].join(':'), CHATGPT_DESKTOP_MCP_CONFIG_DIR: configDir() };
    for (const key of ['CODEX_HOME', 'CHATGPT_DESKTOP_MCP_CODEX_BIN', 'CHATGPT_DESKTOP_MCP_LOG']) {
        const value = process.env[key]?.trim();
        if (value)
            env[key] = value;
    }
    return env;
}
export async function installService(settings, options = {}) {
    if (process.platform !== 'darwin')
        throw new Error('The service command manages macOS LaunchAgents.');
    const node = options.nodePath ?? findExecutable('node') ?? process.execPath;
    const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
    const logs = logDirectory();
    mkdirSync(logs, { recursive: true });
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const env = agentEnvironment(node);
    const specs = new Map();
    specs.set('server', {
        label: label('server'),
        program: [node, cli, ...serveArguments(settings)],
        runAtLoad: true,
        keepAlive: true,
        logFile: join(logs, 'server.log'),
        env,
    });
    let tunnelId = null;
    if (settings.hostname && settings.tunnelName) {
        const cloudflared = findExecutable('cloudflared');
        if (!cloudflared)
            throw new Error('cloudflared is not installed. Install it with: brew install cloudflared');
        const certificate = originCertificate();
        if (!certificate)
            throw new Error('Cloudflare is not logged in on this Mac. Run: cloudflared tunnel login');
        if (!options.skipZoneCheck)
            await assertHostnameZone(settings.hostname, certificate);
        tunnelId = ensureTunnel(cloudflared, settings.tunnelName);
        routeHostname(cloudflared, tunnelId, settings.hostname, options.overwriteDns ?? false);
        const tunnelConfig = join(configDir(), 'cloudflared.yml');
        writeFileSync(tunnelConfig, renderTunnelConfig(tunnelId, tunnelCredentials(tunnelId, certificate), settings.port, settings.hostname), { mode: 0o600 });
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
        env,
    });
    if (settings.keepAwake !== 'off') {
        // -s blocks system sleep on AC power; -i also blocks idle sleep on battery.
        const flags = settings.keepAwake === 'always' ? ['-i', '-s'] : ['-s'];
        specs.set('keepawake', { label: label('keepawake'), program: ['/usr/bin/caffeinate', ...flags], runAtLoad: true, keepAlive: true, logFile: join(logs, 'keepawake.log') });
    }
    if (settings.openApp) {
        const bundle = APP_BUNDLE_PATHS.find((candidate) => existsSync(candidate));
        if (bundle) {
            specs.set('openapp', { label: label('openapp'), program: ['/usr/bin/open', '-g', bundle], runAtLoad: true, keepAlive: false, logFile: join(logs, 'openapp.log') });
        }
    }
    let resolvedNode = null;
    try {
        resolvedNode = realpathSync(node);
    }
    catch {
        resolvedNode = node;
    }
    const config = { version: 1, ...settings, tunnelId, node: resolvedNode, roles: [...specs.keys()] };
    writeFileSync(serviceConfigPath(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    for (const role of ROLES)
        if (!specs.has(role))
            unloadAgent(role);
    for (const [role, spec] of specs)
        loadAgent(role, spec);
    return { config, agents: [...specs.values()].map((spec) => spec.label) };
}
export function uninstallService() {
    for (const role of ROLES)
        unloadAgent(role);
    for (const file of [serviceConfigPath(), watchdogStatePath(), folderAccessPath()])
        if (existsSync(file))
            unlinkSync(file);
    return [...ROLES];
}
export async function probeHealth(url, timeoutMs) {
    try {
        const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'chatgpt-desktop-mcp-watchdog' } });
        return response.ok;
    }
    catch {
        return false;
    }
}
export function agentState(role) {
    const result = launchctl(['print', `gui/${uid()}/${label(role)}`]);
    if (!result.ok)
        return { label: label(role), loaded: false, running: false, pid: null, lastExit: null };
    const pid = /\bpid = (\d+)/.exec(result.output)?.[1];
    return {
        label: label(role),
        loaded: true,
        running: /\bstate = running/.test(result.output),
        pid: pid ? Number(pid) : null,
        lastExit: /last exit code = ([^\n]+)/.exec(result.output)?.[1]?.trim() ?? null,
    };
}
/**
 * Health check used by the watchdog. With repair, it restarts the server when
 * localhost stops answering, and restarts the tunnel it manages when the public
 * URL fails twice in a row while the internet and the local server are up.
 * Only repair runs count toward that limit, so status checks never trigger a restart.
 */
export async function checkService(repair) {
    const config = readServiceConfig();
    if (!config)
        throw new Error('The service is not installed. Run: chatgpt-desktop-mcp service install');
    const actions = [];
    const domain = `gui/${uid()}`;
    const local = await probeHealth(`http://127.0.0.1:${config.port}/healthz`, 5_000);
    if (!local && repair && config.roles.includes('server')) {
        launchctl(['kickstart', '-k', `${domain}/${label('server')}`]);
        actions.push('restarted server');
    }
    const base = publicBaseUrl(config);
    let publicOk = null;
    let internet = null;
    if (base) {
        publicOk = await probeHealth(`${base}/healthz`, 10_000);
        if (!publicOk)
            internet = await probeHealth('https://1.1.1.1/cdn-cgi/trace', 5_000);
        if (!repair || !config.roles.includes('tunnel'))
            return { local, public: publicOk, internet, actions };
        let failures = 0;
        try {
            const state = JSON.parse(readFileSync(watchdogStatePath(), 'utf8'));
            failures = isRecord(state) && typeof state.publicFailures === 'number' ? state.publicFailures : 0;
        }
        catch {
            failures = 0;
        }
        if (publicOk) {
            failures = 0;
        }
        else {
            if (internet && local)
                failures += 1;
            if (failures >= PUBLIC_FAILURES_BEFORE_RESTART) {
                launchctl(['kickstart', '-k', `${domain}/${label('tunnel')}`]);
                actions.push('restarted tunnel');
                failures = 0;
            }
        }
        try {
            writeFileSync(watchdogStatePath(), JSON.stringify({ publicFailures: failures, checkedAt: new Date().toISOString() }), { mode: 0o600 });
        }
        catch (error) {
            actions.push(`could not save watchdog state: ${errorMessage(error)}`);
        }
    }
    return { local, public: publicOk, internet, actions };
}
