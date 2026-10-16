import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const manifestSchema = z.strictObject({ schemaVersion: z.literal(1), coreRevision: z.string().regex(/^[a-f0-9]{40}$/),
  workerImage: digest, proxyImage: digest, files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) });
export type VerifiedRelease = { coreRevision: string; coreHash: string; workerImage: string; proxyImage: string };
const verified = new WeakSet<VerifiedRelease>();
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function releaseFiles(root: string): Promise<Record<string, string>> {
  const names = ['package.json', 'package-lock.json', 'dist/schema.sql'];
  for (const name of await readdir(join(root, 'dist'))) if (name.endsWith('.js')) names.push(`dist/${name}`);
  for (const name of await readdir(join(root, 'worker'))) names.push(`worker/${name}`);
  const files: Record<string, string> = {};
  for (const name of names.sort()) files[name] = hash(await readFile(join(root, name)));
  return files;
}
export async function writeRelease(root: string, destination: string, workerImage: string, proxyImage: string): Promise<void> {
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root, stdio: 'pipe', windowsHide: true });
  if (execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'src', 'worker', 'package.json', 'package-lock.json'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()) throw new Error('untracked_release_inputs');
  const coreRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  const manifest = manifestSchema.parse({ schemaVersion: 1, coreRevision, workerImage, proxyImage, files: await releaseFiles(root) });
  await writeFile(destination, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
}
export async function verifyRelease(root: string, path: string): Promise<VerifiedRelease> {
  const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const actual = await releaseFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('release_file_mismatch');
  const release = Object.freeze({ coreRevision: manifest.coreRevision, coreHash: hash(JSON.stringify({ revision: manifest.coreRevision, files: actual })),
    workerImage: manifest.workerImage, proxyImage: manifest.proxyImage });
  verified.add(release);
  return release;
}
export function assertVerifiedRelease(release: VerifiedRelease): void {
  if (!verified.has(release)) throw new Error('unverified_release');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, destination, workerImage, proxyImage] = z.tuple([z.string(), z.string(), digest, digest]).parse(process.argv.slice(2));
  await writeRelease(resolve(root), resolve(destination), workerImage, proxyImage);
}
