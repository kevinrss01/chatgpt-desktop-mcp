import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppServerClient } from './appServer.js';
import { TokenStore } from './auth.js';
import { DesktopIpcClient } from './ipc.js';
import { APP_BUNDLE_PATHS, configDir, ipcSocketPath, resolveCodexBinary } from './paths.js';
import { agentState, readServiceConfig } from './service.js';
import { errorMessage } from './util.js';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function appVersion(bundle: string): string | null {
  try {
    return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(bundle, 'Contents', 'Info.plist')], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function commandExists(command: string): boolean {
  try {
    execFileSync('/usr/bin/which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(version: string, codexBinary?: string): Promise<boolean> {
  const checks: Check[] = [];
  const bundle = APP_BUNDLE_PATHS.find((path) => existsSync(path));
  checks.push({
    name: 'Desktop app',
    ok: bundle !== undefined,
    detail: bundle ? `${bundle} (${appVersion(bundle) ?? 'unknown version'})` : 'ChatGPT.app was not found in /Applications',
  });

  const binary = resolveCodexBinary(codexBinary);
  let binaryVersion = 'not found';
  try {
    binaryVersion = execFileSync(binary.path, ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    binaryVersion = errorMessage(error);
  }
  checks.push({ name: 'Codex engine', ok: binaryVersion.startsWith('codex'), detail: `${binary.path} [${binary.source}] ${binaryVersion}` });

  const appServer = new AppServerClient({ binary: binary.path, clientVersion: version, requestTimeoutMs: 20_000 });
  try {
    const models: unknown = await appServer.request('model/list', { includeHidden: false });
    const count = typeof models === 'object' && models !== null && 'data' in models && Array.isArray(models.data) ? models.data.length : 0;
    checks.push({ name: 'Background engine', ok: true, detail: `app-server started, ${count} models available` });
  } catch (error) {
    checks.push({ name: 'Background engine', ok: false, detail: errorMessage(error) });
  } finally {
    appServer.stop();
  }

  const ipc = new DesktopIpcClient();
  if (!ipc.isAvailable()) {
    checks.push({ name: 'Live app control', ok: false, detail: `${ipcSocketPath()} not found. Open the ChatGPT app to control open chats live.` });
  } else {
    try {
      await ipc.ping();
      checks.push({ name: 'Live app control', ok: true, detail: 'connected to the app IPC router' });
    } catch (error) {
      checks.push({ name: 'Live app control', ok: false, detail: errorMessage(error) });
    } finally {
      ipc.close();
    }
  }

  const tokens = new TokenStore(configDir()).list();
  checks.push({
    name: 'Access tokens',
    ok: tokens.length > 0,
    detail: tokens.length > 0 ? `${tokens.length} token(s) in ${configDir()}` : 'none yet; run: chatgpt-desktop-mcp token create',
  });
  checks.push({
    name: 'cloudflared (optional)',
    ok: commandExists('cloudflared'),
    detail: commandExists('cloudflared') ? 'installed; --tunnel is available' : 'not installed; needed only for --tunnel',
  });
  const service = process.platform === 'darwin' ? readServiceConfig() : null;
  if (service) {
    const missing = service.roles.filter((role) => !agentState(role).loaded);
    checks.push({
      name: 'Background service (optional)',
      ok: missing.length === 0,
      detail:
        missing.length === 0
          ? `${service.roles.length} LaunchAgents loaded${service.hostname ? `, public URL https://${service.hostname}/mcp` : ''}`
          : `not loaded: ${missing.join(', ')}; run: chatgpt-desktop-mcp service install`,
    });
  } else {
    checks.push({ name: 'Background service (optional)', ok: false, detail: 'not installed; run: chatgpt-desktop-mcp service install --hostname <host>' });
  }

  for (const check of checks) process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}\n`);
  return checks.filter((check) => !check.name.includes('optional')).every((check) => check.ok);
}
