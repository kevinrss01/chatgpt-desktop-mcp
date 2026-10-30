import { spawn } from 'node:child_process';
import readline from 'node:readline';
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
/**
 * Starts a Cloudflare quick tunnel to the local server. Quick tunnels get a new
 * random hostname each time; use a named tunnel for a stable address.
 */
export function startQuickTunnel(localUrl, binary = 'cloudflared', timeoutMs = 45_000) {
    return new Promise((resolve, reject) => {
        const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', localUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
        let settled = false;
        const finish = (error, url) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (error || !url) {
                child.kill('SIGTERM');
                reject(error ?? new Error('cloudflared did not report a tunnel URL'));
                return;
            }
            resolve({ url, stop: () => child.kill('SIGTERM') });
        };
        const timer = setTimeout(() => finish(new Error('Timed out waiting for the Cloudflare quick tunnel URL')), timeoutMs);
        const scan = (line) => {
            const match = QUICK_TUNNEL_URL.exec(line);
            if (match)
                finish(null, match[0]);
        };
        readline.createInterface({ input: child.stdout }).on('line', scan);
        readline.createInterface({ input: child.stderr }).on('line', scan);
        child.on('error', (error) => finish(new Error(`Could not start cloudflared (${error.message}). Install it with: brew install cloudflared`)));
        child.on('exit', (code) => finish(new Error(`cloudflared exited with code ${code ?? 'unknown'}`)));
    });
}
