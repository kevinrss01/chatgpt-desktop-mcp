import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
export const APP_BUNDLE_PATHS = ['/Applications/ChatGPT.app', '/Applications/Codex.app'];
/** Codex CLI binaries shipped inside the desktop app, newest layout first. */
const APP_CODEX_BINARIES = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
];
export function codexHome() {
    return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}
/**
 * Prefers the Codex binary bundled with the desktop app so the protocol version
 * matches the app that owns the chats.
 */
export function resolveCodexBinary(explicit) {
    if (explicit)
        return { path: explicit, source: 'option' };
    const fromEnv = process.env.CHATGPT_DESKTOP_MCP_CODEX_BIN?.trim();
    if (fromEnv)
        return { path: fromEnv, source: 'env' };
    for (const candidate of APP_CODEX_BINARIES) {
        if (existsSync(candidate))
            return { path: candidate, source: 'desktop-app' };
    }
    return { path: 'codex', source: 'path' };
}
/** Path of the desktop app's local IPC router socket. */
export function ipcSocketPath() {
    const primary = join(codexHome(), 'ipc', 'ipc.sock');
    if (existsSync(primary))
        return primary;
    const uid = process.getuid?.();
    const fallback = join(tmpdir(), 'codex-ipc', uid == null ? 'ipc.sock' : `ipc-${uid}.sock`);
    return existsSync(fallback) ? fallback : primary;
}
export function globalStatePath() {
    return join(codexHome(), '.codex-global-state.json');
}
export function configDir() {
    const explicit = process.env.CHATGPT_DESKTOP_MCP_CONFIG_DIR?.trim();
    if (explicit)
        return explicit;
    const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
    return join(base, 'chatgpt-desktop-mcp');
}
export function defaultWorkspaceRoot() {
    return join(homedir(), 'Documents', 'Codex');
}
