#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TokenStore } from './auth.js';
import { runDoctor } from './doctor.js';
import { startHttpServer } from './http.js';
import { log, setLogLevel } from './log.js';
import { configDir, defaultWorkspaceRoot } from './paths.js';
import { protectedFolder, saveFolderAccess, watchFolderAccess } from './permissions.js';
import { createRuntime, packageVersion } from './runtime.js';
import { DEFAULT_PORT, KEEP_AWAKE_MODES, agentState, checkService, folderAccessPath, installService, logDirectory, probeHealth, publicBaseUrl, readServiceConfig, readFolderAccess, resolveServiceSettings, uninstallService, } from './service.js';
import { createMcpServer } from './tools.js';
import { startQuickTunnel } from './tunnel.js';
import { errorMessage } from './util.js';
const HELP = `chatgpt-desktop-mcp ${packageVersion()}
Control Codex chats in the ChatGPT desktop app over MCP.

Usage:
  chatgpt-desktop-mcp serve [options]      Serve MCP over HTTP at /mcp (bearer token required)
  chatgpt-desktop-mcp stdio [--read-only]  Serve MCP over stdio for a local client
  chatgpt-desktop-mcp token create [--name <label>] [--scope control|read]
  chatgpt-desktop-mcp token list
  chatgpt-desktop-mcp token revoke <id-or-name>
  chatgpt-desktop-mcp doctor               Check the app, engine, IPC, and tokens
  chatgpt-desktop-mcp service install [options]  Keep the server (and a named tunnel) running with launchd
  chatgpt-desktop-mcp service status       Show the background agents and health
  chatgpt-desktop-mcp service check [--repair] [--quiet]
  chatgpt-desktop-mcp service uninstall    Remove the LaunchAgents (keeps the Cloudflare tunnel and DNS record)

Serve options:
  --host <address>          Listen address (default 127.0.0.1)
  --port <number>           Listen port (default 8723)
  --tunnel                  Expose the server through a Cloudflare quick tunnel (random URL)
  --allow-origin <origin>   Allow a browser origin (repeatable)

Service install options (saved; running install again reuses them, and options you pass replace them):
  --hostname <host>         Publish on your own domain through a named Cloudflare tunnel, e.g. mcp.example.com
  --tunnel-name <name>      Cloudflare tunnel to create or reuse (default chatgpt-desktop-mcp)
  --overwrite-dns           Replace an existing DNS record for --hostname
  --skip-zone-check         Skip the check that the hostname's domain uses Cloudflare DNS
  --public-url <url>        Use a tunnel or proxy you run yourself (Tailscale Funnel, ngrok, nginx...); monitored only
  --local-only              Remove the saved hostname or public URL
  --port <number>           Local port (default 8723)
  --keep-awake <mode>       ac: no idle sleep on AC power (default) | always: also on battery | off
  --open-app, --no-open-app Open the ChatGPT app at login (default: on)
  --reset                   Ignore the saved settings and start from the defaults
  --sandbox, --approval-policy, --workspace-root, --codex-bin, and --allow-origin are passed to the background server.

Shared options:
  --codex-bin <path>        Codex binary (default: the one bundled with ChatGPT.app)
  --workspace-root <dir>    Parent folder for new chats without a project (default ~/Documents/Codex)
  --sandbox <mode>          Force read-only | workspace-write | danger-full-access for chats run by the bridge
  --approval-policy <mode>  Force untrusted | on-request | never for chats run by the bridge
  --verbose                 Debug logging
`;
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'];
function fail(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}
function parsePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        fail('--port must be a number between 0 and 65535');
    return port;
}
async function waitForHealth(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await probeHealth(url, 3_000))
            return true;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
}
function describeSettings(settings) {
    const base = publicBaseUrl(settings);
    const exposure = settings.hostname
        ? `${base}/mcp (Cloudflare tunnel "${settings.tunnelName}")`
        : settings.publicUrl
            ? `${base}/mcp (your own tunnel or proxy, monitored only)`
            : 'none, this Mac only';
    const keepAwake = { ac: 'on AC power', always: 'always, also on battery', off: 'off' }[settings.keepAwake];
    const serve = [];
    if (settings.serve.sandbox)
        serve.push(`--sandbox ${settings.serve.sandbox}`);
    if (settings.serve.approvalPolicy)
        serve.push(`--approval-policy ${settings.serve.approvalPolicy}`);
    if (settings.serve.workspaceRoot)
        serve.push(`--workspace-root ${settings.serve.workspaceRoot}`);
    if (settings.serve.codexBin)
        serve.push(`--codex-bin ${settings.serve.codexBin}`);
    for (const origin of settings.serve.allowOrigins ?? [])
        serve.push(`--allow-origin ${origin}`);
    return [
        `Public URL:   ${exposure}`,
        `Local URL:    http://127.0.0.1:${settings.port}/mcp`,
        `Keep awake:   ${keepAwake}`,
        `Open ChatGPT: ${settings.openApp ? 'at login' : 'no'}`,
        `Server flags: ${serve.length > 0 ? serve.join(' ') : 'none (chats use your Codex settings)'}`,
    ];
}
async function serviceCommand(subcommand, args, serve, tokens) {
    const out = (line) => process.stdout.write(`${line}\n`);
    switch (subcommand) {
        case 'install': {
            if (args['open-app'] && args['no-open-app'])
                fail('Use either --open-app or --no-open-app.');
            const keepAwake = args['no-keep-awake'] ? 'off' : args['keep-awake'];
            if (keepAwake !== undefined && !KEEP_AWAKE_MODES.includes(keepAwake)) {
                fail(`--keep-awake must be one of: ${KEEP_AWAKE_MODES.join(', ')}`);
            }
            const saved = args.reset ? null : readServiceConfig();
            let settings;
            try {
                settings = resolveServiceSettings({
                    port: args.port === undefined ? undefined : parsePort(args.port),
                    hostname: args.hostname,
                    tunnelName: args['tunnel-name'],
                    publicUrl: args['public-url'],
                    localOnly: args['local-only'],
                    keepAwake: keepAwake,
                    openApp: args['no-open-app'] ? false : args['open-app'] ? true : undefined,
                    serve,
                }, saved);
            }
            catch (error) {
                fail(errorMessage(error));
            }
            if (saved)
                out('Reusing the saved settings; options you passed replace them.');
            for (const line of describeSettings(settings))
                out(line);
            const cliFolder = protectedFolder(fileURLToPath(import.meta.url));
            if (cliFolder) {
                out(`Warning: this copy of chatgpt-desktop-mcp is inside ${cliFolder}, which macOS guards from background processes.`);
                out('         The server cannot start until node is allowed there. A global npm install avoids this.');
            }
            const chatFolder = protectedFolder(settings.serve.workspaceRoot ?? defaultWorkspaceRoot());
            if (chatFolder) {
                out(`Note: new chats go in ${settings.serve.workspaceRoot ?? defaultWorkspaceRoot()}. macOS asks once whether node may access ${chatFolder}; click Allow.`);
            }
            const { agents } = await installService(settings, { overwriteDns: args['overwrite-dns'], skipZoneCheck: args['skip-zone-check'] });
            for (const agent of agents)
                out(`loaded  ${agent}`);
            const logs = logDirectory();
            const local = await waitForHealth(`http://127.0.0.1:${settings.port}/healthz`, 30_000);
            out(`${local ? 'ok  ' : 'FAIL'}  local   http://127.0.0.1:${settings.port}/mcp`);
            if (!local)
                out(`      See ${join(logs, 'server.log')}`);
            if (!local && cliFolder)
                out(`      The server is probably waiting for permission to read ${cliFolder}.`);
            let remote = true;
            const base = publicBaseUrl(settings);
            if (base) {
                remote = await waitForHealth(`${base}/healthz`, 60_000);
                out(`${remote ? 'ok  ' : 'FAIL'}  public  ${base}/mcp`);
                if (!remote && settings.hostname) {
                    out('      A new DNS record can take a few minutes. If it still fails, the hostname may not be in the Cloudflare');
                    out('      domain you picked at "cloudflared tunnel login": log in for that domain (or set TUNNEL_ORIGIN_CERT)');
                    out(`      and run install again. Tunnel log: ${join(logs, 'tunnel.log')}`);
                }
                else if (!remote) {
                    out(`      Check that your tunnel or proxy forwards ${base} to http://127.0.0.1:${settings.port}.`);
                }
            }
            out(`Logs: ${logs}`);
            if (tokens.list().length === 0)
                out('No access tokens yet. Create one for each agent with: chatgpt-desktop-mcp token create --name <agent>');
            if (!local || !remote)
                process.exitCode = 1;
            return;
        }
        case 'status': {
            const config = readServiceConfig();
            if (!config)
                fail('The service is not installed. Run: chatgpt-desktop-mcp service install --hostname <host>');
            for (const line of describeSettings(config))
                out(line);
            for (const role of config.roles) {
                const state = agentState(role);
                // The watchdog and the app opener run briefly and exit, so "loaded" is their healthy state.
                const status = state.running ? `running (pid ${state.pid ?? '?'})` : state.loaded ? 'loaded' : 'NOT LOADED';
                const failed = !state.running && state.lastExit !== null && /^-?\d+$/.test(state.lastExit) && state.lastExit !== '0';
                out(`${role.padEnd(9)}  ${status}${failed ? `, last exit code ${state.lastExit}` : ''}`);
            }
            const check = await checkService(false);
            out(`${check.local ? 'ok  ' : 'FAIL'}  local   http://127.0.0.1:${config.port}/mcp`);
            const base = publicBaseUrl(config);
            if (base) {
                const reason = check.public || check.internet !== false ? '' : ' (this Mac is offline)';
                out(`${check.public ? 'ok  ' : 'FAIL'}  public  ${base}/mcp${reason}`);
            }
            out(`Logs: ${logDirectory()}`);
            out(`Tokens: ${tokens.list().length}`);
            const access = readFolderAccess();
            if (access && access.state !== 'ok') {
                const what = access.state === 'denied' ? 'is blocked from' : 'is waiting for permission to read';
                out(`Folders: the background server ${what} ${access.folder}.`);
                out(`         Allow it in System Settings > Privacy & Security > Files and Folders, or add ${access.node} to Full Disk Access.`);
            }
            else if (access) {
                out(`Folders: ${access.folder} is accessible`);
            }
            if (config.node)
                out(`Node: ${config.node}`);
            if (!check.local || check.public === false)
                process.exitCode = 1;
            return;
        }
        case 'check': {
            const check = await checkService(args.repair);
            const summary = `local=${check.local ? 'ok' : 'down'} public=${check.public === null ? 'n/a' : check.public ? 'ok' : 'down'}${check.internet === false ? ' internet=down' : ''}`;
            if (!args.quiet)
                out(summary);
            if (check.actions.length > 0)
                out(`${new Date().toISOString()} ${summary} -> ${check.actions.join(', ')}`);
            if (!check.local || check.public === false)
                process.exitCode = 1;
            return;
        }
        case 'uninstall': {
            const config = readServiceConfig();
            uninstallService();
            out('Removed the LaunchAgents and stopped the background server.');
            if (config?.tunnelName) {
                out(`Kept the Cloudflare tunnel "${config.tunnelName}"${config.hostname ? ` and the DNS record for ${config.hostname}` : ''}.`);
                out(`To delete them: cloudflared tunnel delete ${config.tunnelName}, then remove the DNS record in the Cloudflare dashboard.`);
            }
            return;
        }
        default:
            fail('Usage: chatgpt-desktop-mcp service install|status|check|uninstall');
    }
}
async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            host: { type: 'string', default: '127.0.0.1' },
            port: { type: 'string' },
            tunnel: { type: 'boolean', default: false },
            hostname: { type: 'string' },
            'tunnel-name': { type: 'string' },
            'public-url': { type: 'string' },
            'local-only': { type: 'boolean', default: false },
            'keep-awake': { type: 'string' },
            'no-keep-awake': { type: 'boolean', default: false },
            'open-app': { type: 'boolean', default: false },
            'no-open-app': { type: 'boolean', default: false },
            'overwrite-dns': { type: 'boolean', default: false },
            'skip-zone-check': { type: 'boolean', default: false },
            reset: { type: 'boolean', default: false },
            repair: { type: 'boolean', default: false },
            quiet: { type: 'boolean', default: false },
            'allow-origin': { type: 'string', multiple: true },
            'codex-bin': { type: 'string' },
            'workspace-root': { type: 'string' },
            sandbox: { type: 'string' },
            'approval-policy': { type: 'string' },
            'read-only': { type: 'boolean', default: false },
            name: { type: 'string' },
            scope: { type: 'string', default: 'control' },
            verbose: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false },
            version: { type: 'boolean', short: 'v', default: false },
        },
    });
    if (values.verbose)
        setLogLevel('debug');
    if (values.version) {
        process.stdout.write(`${packageVersion()}\n`);
        return;
    }
    const [command, subcommand, argument] = positionals;
    if (values.help || !command || command === 'help') {
        process.stdout.write(HELP);
        return;
    }
    if (process.platform !== 'darwin' && command !== 'token') {
        log.warn('The ChatGPT desktop app integration is only tested on macOS.');
    }
    if (values.sandbox && !SANDBOX_MODES.includes(values.sandbox))
        fail(`--sandbox must be one of: ${SANDBOX_MODES.join(', ')}`);
    if (values['approval-policy'] && !APPROVAL_POLICIES.includes(values['approval-policy'])) {
        fail(`--approval-policy must be one of: ${APPROVAL_POLICIES.join(', ')}`);
    }
    const runtimeOptions = {
        codexBinary: values['codex-bin'],
        workspaceRoot: values['workspace-root'],
        sandbox: values.sandbox,
        approvalPolicy: values['approval-policy'],
    };
    const tokens = new TokenStore(configDir());
    switch (command) {
        case 'token': {
            if (subcommand === 'create') {
                const scope = values.scope;
                if (scope !== 'control' && scope !== 'read')
                    fail('--scope must be control or read');
                const { token, record } = tokens.create(values.name ?? `token-${tokens.list().length + 1}`, scope);
                process.stdout.write(`Created ${record.scope} token ${record.id} (${record.name}). Store it now; it is not shown again:\n${token}\n`);
                return;
            }
            if (subcommand === 'list') {
                const list = tokens.list();
                if (list.length === 0)
                    process.stdout.write('No tokens. Create one with: chatgpt-desktop-mcp token create\n');
                for (const record of list)
                    process.stdout.write(`${record.id}  ${record.scope.padEnd(7)}  ${record.name}  created ${record.createdAt}\n`);
                return;
            }
            if (subcommand === 'revoke') {
                if (!argument)
                    fail('Usage: chatgpt-desktop-mcp token revoke <id-or-name>');
                if (!tokens.revoke(argument))
                    fail(`No token matches ${argument}`);
                process.stdout.write(`Revoked ${argument}\n`);
                return;
            }
            fail('Usage: chatgpt-desktop-mcp token create|list|revoke');
            break;
        }
        case 'doctor': {
            const healthy = await runDoctor(packageVersion(), values['codex-bin']);
            process.exit(healthy ? 0 : 1);
            break;
        }
        case 'service': {
            // Paths are resolved here because launchd starts the server from /.
            const codexBin = values['codex-bin'];
            const serve = {
                sandbox: values.sandbox,
                approvalPolicy: values['approval-policy'],
                workspaceRoot: values['workspace-root'] ? resolve(values['workspace-root']) : undefined,
                codexBin: codexBin && codexBin.includes('/') ? resolve(codexBin) : codexBin,
                allowOrigins: values['allow-origin'],
            };
            await serviceCommand(subcommand, values, serve, tokens);
            return;
        }
        case 'stdio': {
            const runtime = createRuntime(runtimeOptions);
            const server = createMcpServer(runtime.bridge, values['read-only'] ? 'read' : 'control', runtime.version);
            const shutdown = () => {
                runtime.shutdown();
                process.exit(0);
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
            process.stdin.on('close', shutdown);
            await server.connect(new StdioServerTransport());
            return;
        }
        case 'serve': {
            const port = parsePort(values.port ?? String(DEFAULT_PORT));
            if (tokens.list().length === 0) {
                if (process.stderr.isTTY) {
                    const { token, record } = tokens.create('default', 'control');
                    process.stderr.write(`\nCreated a control token (${record.id}). Store it now; it is not shown again:\n\n  ${token}\n\nSend it as: Authorization: Bearer <token>\n\n`);
                }
                else {
                    // Never print a new secret into a log file (launchd, nohup, CI). Tokens created later work without a restart.
                    log.warn('No access tokens yet, so every request will be rejected. Create one with: chatgpt-desktop-mcp token create');
                }
            }
            const runtime = createRuntime(runtimeOptions);
            const http = await startHttpServer({
                host: values.host,
                port,
                tokens,
                allowedOrigins: values['allow-origin'] ?? [],
                createServer: (scope) => createMcpServer(runtime.bridge, scope, runtime.version),
            });
            log.info(`MCP endpoint: ${http.url}`);
            let stopTunnel = null;
            if (values.tunnel) {
                const tunnel = await startQuickTunnel(`http://127.0.0.1:${http.port}`);
                stopTunnel = tunnel.stop;
                log.info(`Public MCP endpoint: ${tunnel.url}/mcp`);
            }
            // Start the engine now so the first tool call is fast and setup problems show up immediately.
            runtime.reader.ensureStarted().catch((error) => log.error('could not start codex app-server', { message: errorMessage(error) }));
            if (!process.stderr.isTTY) {
                // In the background, macOS asks before node may read Documents and similar folders. Ask now, at
                // login or install time, rather than when an agent first creates a chat there.
                const chatRoot = values['workspace-root'] ? resolve(values['workspace-root']) : defaultWorkspaceRoot();
                void watchFolderAccess(chatRoot, (state) => {
                    void saveFolderAccess(folderAccessPath(), chatRoot, state, process.execPath);
                    if (state === 'waiting')
                        log.warn(`Waiting for macOS to let node read ${chatRoot}. Click Allow, or add ${process.execPath} to Full Disk Access.`);
                    if (state === 'denied')
                        log.warn(`macOS blocks node from ${chatRoot}. Allow it in System Settings > Privacy & Security, or add ${process.execPath} to Full Disk Access.`);
                });
            }
            const shutdown = () => {
                stopTunnel?.();
                runtime.shutdown();
                void http.close().finally(() => process.exit(0));
            };
            process.on('SIGINT', shutdown);
            process.on('SIGTERM', shutdown);
            return;
        }
        default:
            fail(`Unknown command "${command}". Run chatgpt-desktop-mcp --help.`);
    }
}
main().catch((error) => {
    log.error(errorMessage(error));
    process.exit(1);
});
