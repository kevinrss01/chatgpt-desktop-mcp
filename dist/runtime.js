import { readFileSync } from 'node:fs';
import { AppServerClient } from './appServer.js';
import { DesktopBridge } from './bridge.js';
import { DesktopApp } from './desktop.js';
import { DesktopIpcClient } from './ipc.js';
import { defaultWorkspaceRoot, resolveCodexBinary } from './paths.js';
export function packageVersion() {
    try {
        const raw = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
        return typeof raw === 'object' && raw !== null && 'version' in raw && typeof raw.version === 'string' ? raw.version : '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
export function createRuntime(options = {}) {
    const version = packageVersion();
    const binary = resolveCodexBinary(options.codexBinary);
    const reader = new AppServerClient({ binary: binary.path, clientVersion: version });
    const runner = new AppServerClient({ binary: binary.path, clientVersion: version });
    const ipc = new DesktopIpcClient();
    const bridge = new DesktopBridge(reader, runner, new DesktopApp(ipc), {
        workspaceRoot: options.workspaceRoot ?? defaultWorkspaceRoot(),
        sandbox: options.sandbox,
        approvalPolicy: options.approvalPolicy,
    });
    return {
        bridge,
        reader,
        runner,
        ipc,
        version,
        shutdown: () => {
            ipc.close();
            reader.stop();
            runner.stop();
        },
    };
}
