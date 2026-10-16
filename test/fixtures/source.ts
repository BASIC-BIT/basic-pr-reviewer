import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, vi } from 'vitest';
import { repoPolicySchema } from '../../src/contracts.js';
import type { ReviewIdentity, TrustedPolicy } from '../../src/contracts.js';
import { createSourceService } from '../../src/source.js';

const temporary: string[] = [];
export async function temp() { const directory = await mkdtemp(join(process.cwd(), 'reviewer-test-')); temporary.push(directory); return directory; }
afterEach(async () => {
  vi.unstubAllEnvs();
  async function remove(path: string): Promise<void> {
    const stat = await lstat(path).catch(() => null);
    if (!stat) return;
    if (!stat.isSymbolicLink()) { await chmod(path, 0o700); if (stat.isDirectory()) for (const name of await readdir(path)) await remove(join(path, name)); }
    await rm(path, { recursive: true, force: true });
  }
  await Promise.all(temporary.splice(0).map(remove));
});
export function git(directory: string, args: string[], input?: Buffer | string): Buffer {
  const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '--git-dir', directory, ...args],
    { input, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' }, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}
export type Entry = { path: string | Buffer; text: string | Buffer; mode?: string };
export async function fixture(old: Entry[], changed: Entry[], extraBase: Entry[] = []) {
  const directory = join(await temp(), 'remote.git');
  git(directory, ['init', '--bare', '--template=']);
  const blobs = new Map<string, string>();
  const blob = (text: string | Buffer) => {
    const key = Buffer.from(text).toString('base64');
    let value = blobs.get(key);
    if (!value) { value = git(directory, ['hash-object', '-w', '--stdin'], text).toString().trim(); blobs.set(key, value); }
    return value;
  };
  function tree(entries: Entry[]): string {
    const groups = new Map<string, Entry[]>(), records: Buffer[] = [];
    for (const entry of entries) {
      const path = Buffer.from(entry.path), slash = path.indexOf(47);
      if (slash !== -1) {
        const key = path.subarray(0, slash).toString('base64'), group = groups.get(key) ?? [];
        group.push({ ...entry, path: path.subarray(slash + 1) }); groups.set(key, group);
      } else records.push(Buffer.concat([Buffer.from(`${entry.mode ?? '100644'} ${entry.mode === '160000' ? 'commit' : 'blob'} ${entry.mode === '160000' ? String(entry.text) : blob(entry.text)}\t`), path, Buffer.from([0])]));
    }
    for (const [key, group] of groups) records.push(Buffer.concat([Buffer.from(`040000 tree ${tree(group)}\t`), Buffer.from(key, 'base64'), Buffer.from([0])]));
    return git(directory, ['mktree', '-z'], Buffer.concat(records)).toString().trim();
  }
  const commit = (entries: Entry[], parent?: string) => git(directory, ['commit-tree', tree(entries), ...(parent ? ['-p', parent] : [])], 'synthetic\n').toString().trim();
  const merge = commit(old), head = commit(changed, merge), base = extraBase.length ? commit([...old, ...extraBase], merge) : merge;
  git(directory, ['update-ref', 'refs/heads/main', base]);
  git(directory, ['update-ref', 'refs/heads/change', head]);
  return { directory, head, base, merge, commit };
}
export function policy(overrides = {}): TrustedPolicy {
  const parsed = repoPolicySchema.parse({ schemaVersion: 1, enabled: true, ...overrides });
  return { policy: parsed, instructions: [], policyHash: createHash('sha256').update(JSON.stringify({ policy: parsed, instructions: [] })).digest('hex') };
}
export function identity(f: { head: string; base: string; merge: string }, p: TrustedPolicy): ReviewIdentity {
  return { installationId: '1', repositoryId: '2', owner: 'synthetic', repo: 'fixture', pullNumber: 3,
    headSha: f.head, baseSha: f.base, mergeBaseSha: f.merge, baseRef: 'main', policyHash: p.policyHash,
    runtimeHash: 'a'.repeat(64), attemptId: '4', generation: 1 };
}
export async function service(f: { directory: string }, limits = {}) {
  const root = await temp();
  return { root, source: await createSourceService({ root, limits,
    fetch: async ({ directory, identity }) => {
      const pack = git(f.directory, ['pack-objects', '--stdout', '--revs'], `${identity.baseSha}\n${identity.headSha}\n`);
      git(directory, ['index-pack', '--stdin'], pack);
    } }) };
}
