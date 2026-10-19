import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, link, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { Store } from './contracts.js';
import { timestampSchema } from './contracts.js';
export const RETENTION_MS = 30 * 86400000;
export const BACKUP_RETENTION_MS = 7 * 86400000;
export type PurgeReport = { purged: number };
export function createRetention(options: { store: Store }) {
  return {
    async purgeExpired(now: number): Promise<PurgeReport> {
      timestampSchema.parse(now);
      return { purged: now < RETENTION_MS ? 0 : options.store.purgeClosedBefore(now - RETENTION_MS) };
    },
  };
}
// Deployment supplies encryption at rest for this private directory and its remote copy.
export async function createBackups(store: Store, directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await realpath(directory);
  if (root !== resolve(directory) || (await lstat(directory)).isSymbolicLink()) throw new Error('unsafe_backup_root');
  await chmod(root, 0o700);
  for (const name of await readdir(root)) if (/^pending-[a-zA-Z0-9]{6}$/.test(name)) {
    const path = join(root, name);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('unsafe_backup_entry');
    await rm(path, { recursive: true, force: true });
  }
  async function backup(destination: string): Promise<void> {
    const path = resolve(destination);
    if (dirname(path) !== root || !/^[a-zA-Z0-9_-]+\.sqlite$/.test(basename(path))) throw new Error('unsafe_backup_destination');
    if (await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('backup_exists');
    const temporary = await mkdtemp(join(root, 'pending-'));
    try {
      const snapshot = join(temporary, 'snapshot.sqlite');
      await store.backup(snapshot);
      await chmod(snapshot, 0o600);
      // The owner-only root excludes untrusted writers; never follow a destination symlink.
      if (await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('backup_exists');
      await link(snapshot, path);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async function daily(now: number): Promise<void> {
    const day = Math.floor(timestampSchema.parse(now) / 86400000);
    const destination = join(root, `daily-${day}.sqlite`);
    try { const info = await lstat(destination); if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe_backup_entry'); } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      await backup(destination);
    }
    for (const name of await readdir(root)) {
      const match = /^daily-(\d+)\.sqlite$/.exec(name);
      if (match && Number(match[1]) * 86400000 <= day * 86400000 - BACKUP_RETENTION_MS) {
        const path = join(root, name);
        if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error('unsafe_backup_entry');
        await rm(path);
      }
    }
  }
  return { backup, daily };
}
