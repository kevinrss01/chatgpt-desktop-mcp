import { readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * macOS privacy protection (TCC) makes background processes ask before they read
 * these folders. Until the user answers, the read blocks.
 */
export function protectedFolder(path: string): string | null {
  const home = homedir();
  for (const name of ['Documents', 'Desktop', 'Downloads', join('Library', 'Mobile Documents')]) {
    const root = join(home, name);
    const rel = relative(root, path);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return root;
  }
  if (path.startsWith('/Volumes/')) return path.split('/').slice(0, 3).join('/');
  return null;
}

export type FolderAccess = 'ok' | 'denied' | 'waiting';

/** Lists the folder, or its nearest existing parent, and reports whether macOS let this process in. */
async function readFolder(folder: string): Promise<Exclude<FolderAccess, 'waiting'>> {
  let target = folder;
  for (;;) {
    try {
      await readdir(target);
      return 'ok';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') return 'denied';
      if (code !== 'ENOENT' || dirname(target) === target) return 'ok';
      target = dirname(target);
    }
  }
}

/**
 * Checks folder access without blocking the server. A pending permission prompt
 * shows up as "waiting" after `timeoutMs`, then `onChange` fires again once the user answers.
 */
export async function watchFolderAccess(folder: string, onChange: (state: FolderAccess) => void, timeoutMs = 5_000): Promise<void> {
  const read = readFolder(folder);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'waiting'>((resolve) => {
    timer = setTimeout(() => resolve('waiting'), timeoutMs);
    timer.unref();
  });
  const first = await Promise.race([read, timeout]);
  clearTimeout(timer);
  onChange(first);
  if (first === 'waiting') onChange(await read);
}

export async function saveFolderAccess(file: string, folder: string, state: FolderAccess, node: string): Promise<void> {
  const body = { folder, state, node, checkedAt: new Date().toISOString() };
  await writeFile(file, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 }).catch(() => undefined);
}
