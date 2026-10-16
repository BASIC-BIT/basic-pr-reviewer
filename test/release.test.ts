import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { verifyRelease, assertVerifiedRelease } from '../src/release.js';
import { workerRuntimeHash } from '../src/worker.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('binds the compiled core including renderer bytes and core revision into worker compatibility', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-')); roots.push(root);
  await mkdir(join(root, 'dist')); await mkdir(join(root, 'worker'));
  const files: Record<string,string> = {};
  for (const name of ['dist/schema.sql', 'dist/source.js', 'dist/worker.js', 'package-lock.json', 'package.json', 'worker/settings.json'].sort()) {
    await writeFile(join(root, name), name);
    files[name] = createHash('sha256').update(name).digest('hex');
  }
  const path = join(root, 'release.json'), workerImage = `sha256:${'1'.repeat(64)}`, proxyImage = `sha256:${'2'.repeat(64)}`;
  const manifest = { schemaVersion: 1, coreRevision: 'a'.repeat(40), workerImage, proxyImage, files };
  await writeFile(path, JSON.stringify(manifest));
  const first = await verifyRelease(root,path);
  assertVerifiedRelease(first);
  await writeFile(path, JSON.stringify({ ...manifest, coreRevision: 'b'.repeat(40) }));
  const second = await verifyRelease(root,path);
  expect(workerRuntimeHash(workerImage,proxyImage,first.coreHash)).not.toBe(workerRuntimeHash(workerImage,proxyImage,second.coreHash));
  expect(() => assertVerifiedRelease({ ...first })).toThrow('unverified_release');
  await writeFile(join(root, 'dist/source.js'), 'changed renderer');
  await expect(verifyRelease(root,path)).rejects.toThrow('release_file_mismatch');
  expect(await readFile(join(root,'dist/source.js'),'utf8')).toBe('changed renderer');
});
