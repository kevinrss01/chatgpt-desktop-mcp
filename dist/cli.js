#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TokenStore } from './auth.js';
import { runDoctor } from './doctor.js';
import { startHttpServer } from './http.js';
import { log, setLogLevel } from './log.js';
import { configDir } from './paths.js';
import { createRuntime, packageVersion } from './runtime.js';
import { agentState, checkService, installService, logDirectory, probeHealth, readServiceConfig, uninstallService } from './service.js';
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

Service install options:
  --port <number>           Local port (default 8723)
  --hostname <host>         Public hostname on a Cloudflare zone, e.g. mcp.example.com
  --tunnel-name <name>      Named Cloudflare tunnel to create or reuse (default chatgpt-desktop-mcp)
  --overwrite-dns           Replace an existing DNS record for --hostname
  --no-keep-awake           Let the Mac sleep on AC power (sleep makes the server unreachable)
  --no-open-app             Do not open the ChatGPT app at login

Shared options:
  --codex-bin <path>        Codex binary (default: the one bundled with ChatGPT.app)
  --workspace-root <dir>    Parent folder for new chats without a project (default ~/Documents/Codex)
  --sandbox <mode>          Force read-only | workspace-write | danger-full-access for chats run by the bridge
  --approval-policy <mode>  Force untrusted | on-request | never for chats run by the bridge
  --verbose                 Debug logging
`;
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'];
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;
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
async function serviceCommand(subcommand, args, tokens) {
    const out = (line) => process.stdout.write(`${line}\n`);
    switch (subcommand) {
        case 'install': {
            const port = parsePort(args.port);
            if (port === 0)
                fail('--port must be a fixed port for the service');
            const hostname = args.hostname?.trim().toLowerCase();
            if (hostname !== undefined && !HOSTNAME.test(hostname))
                fail('--hostname must be a DNS name such as mcp.example.com');
            if (args['tunnel-name'] && !hostname)
                fail('--tunnel-name needs --hostname');
            const { config, agents } = installService({
                port,
                hostname,
                tunnel: hostname ? (args['tunnel-name'] ?? 'chatgpt-desktop-mcp') : undefined,
                overwriteDns: args['overwrite-dns'],
                keepAwake: !args['no-keep-awake'],
                openApp: !args['no-open-app'],
            });
            for (const agent of agents)
                out(`loaded  ${agent}`);
            const local = await waitForHealth(`http://127.0.0.1:${port}/healthz`, 30_000);
            out(`${local ? 'ok  ' : 'FAIL'}  local   http://127.0.0.1:${port}/mcp`);
            if (config.hostname) {
                const remote = await waitForHealth(`https://${config.hostname}/healthz`, 60_000);
                out(`${remote ? 'ok  ' : 'FAIL'}  public  https://${config.hostname}/mcp`);
            }
            out(`Logs: ${logDirectory()}`);
            if (tokens.list().length === 0)
                out('No access tokens yet. Create one for each agent with: chatgpt-desktop-mcp token create --name <agent>');
            return;
        }
        case 'status': {
            const config = readServiceConfig();
            if (!config)
                fail('The service is not installed. Run: chatgpt-desktop-mcp service install --hostname <host>');
            for (const role of config.roles) {
                const state = agentState(role);
                // The watchdog and the app opener run briefly and exit, so "loaded" is their healthy state.
                const status = state.running ? `running (pid ${state.pid ?? '?'})` : state.loaded ? 'loaded' : 'NOT LOADED';
                const failed = !state.running && state.lastExit !== null && /^-?\d+$/.test(state.lastExit) && state.lastExit !== '0';
                out(`${role.padEnd(9)}  ${status}${failed ? `, last exit code ${state.lastExit}` : ''}`);
            }
            const check = await checkService(false);
            out(`${check.local ? 'ok  ' : 'FAIL'}  local   http://127.0.0.1:${config.port}/mcp`);
            if (config.hostname) {
                const reason = check.public || check.internet !== false ? '' : ' (this Mac is offline)';
                out(`${check.public ? 'ok  ' : 'FAIL'}  public  https://${config.hostname}/mcp${reason}`);
            }
            out(`Logs: ${logDirectory()}`);
            out(`Tokens: ${tokens.list().length}`);
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
            port: { type: 'string', default: '8723' },
            tunnel: { type: 'boolean', default: false },
            hostname: { type: 'string' },
            'tunnel-name': { type: 'string' },
            'overwrite-dns': { type: 'boolean', default: false },
            'no-keep-awake': { type: 'boolean', default: false },
            'no-open-app': { type: 'boolean', default: false },
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
            await serviceCommand(subcommand, values, tokens);
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
            const port = parsePort(values.port);
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
