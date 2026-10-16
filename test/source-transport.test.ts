import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { repoPolicySchema } from '../src/contracts.js';
import type { ReviewIdentity, TrustedPolicy } from '../src/contracts.js';
import { createSourceService, SourceFailure } from '../src/source.js';

vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>();
  return { ...module, spawn: vi.fn(module.spawn) };
});
const { spawn: actualSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
const roots: string[] = [];
afterEach(async () => { vi.mocked(spawn).mockImplementation(actualSpawn); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const policy = repoPolicySchema.parse({ schemaVersion: 1, enabled: true });
const trusted: TrustedPolicy = { policy, instructions: [], policyHash: createHash('sha256').update(JSON.stringify({ policy, instructions: [] })).digest('hex') };
const identity: ReviewIdentity = { installationId: '1', repositoryId: '2', owner: 'synthetic', repo: 'fixture', pullNumber: 3,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'b'.repeat(40), baseRef: 'main',
  policyHash: trusted.policyHash, runtimeHash: 'c'.repeat(64), attemptId: '4', generation: 1 };

async function checkTransport(exerciseHelper: boolean, host = 'github.com') {
  const root = await mkdtemp(join(process.cwd(), "reviewer-test-credential space'-")); roots.push(root);
  let fetchCount = 0, credentialOutput = '';
  vi.mocked(spawn).mockImplementation((command, args, options) => {
    if (!Array.isArray(args)) throw new Error('Expected fixed argument array');
    const fetchAt = args.indexOf('fetch');
    if (fetchAt === -1) return actualSpawn(command, args, options);
    fetchCount++;
    expect(args.slice(fetchAt)).toEqual(['fetch', '--no-tags', '--no-recurse-submodules', '--', 'https://github.com/synthetic/fixture.git', identity.baseSha, identity.headSha]);
    expect(args.some((arg) => arg.includes('synthetic-secret-token'))).toBe(false);
    expect(options?.env?.REVIEWER_GIT_TOKEN).toBe('synthetic-secret-token');
    expect(args).toContain('credential.useHttpPath=true');
    expect(args).toContain('http.followRedirects=false');
    // A synthetic credential request replaces the network fetch. No network is permitted here.
    const child = actualSpawn(command, exerciseHelper ? [...args.slice(0, fetchAt), 'credential', 'fill'] : ['--version'], options);
    if (exerciseHelper) child.stdin?.write(`protocol=https\nhost=${host}\npath=synthetic/fixture.git\n\n`);
    child.stdout?.on('data', (data: Buffer) => { credentialOutput += data.toString(); });
    return child;
  });
  const source = await createSourceService({ root, credential: async () => 'synthetic-secret-token' });
  const manifest = await source.captureManifest(identity, trusted);
  expect(fetchCount).toBe(1);
  expect(manifest.retrievalFailures.length).toBeGreaterThan(0); // No objects were fetched by the synthetic command.
  expect(JSON.stringify(manifest)).not.toContain('synthetic-secret-token');
  expect(await readdir(root)).toEqual([]);
  return credentialOutput;
}
it('constructs an HTTPS-only exact-SHA fetch with process-scoped credentials and sanitized failure', async () => { await checkTransport(false); });
it('checks the claimed identity after asynchronous setup and before resolving a Git credential', async () => {
  const root = await mkdtemp(join(process.cwd(), 'reviewer-test-source-guard-')); roots.push(root);
  const credential = vi.fn(async () => 'synthetic-secret-token');
  const source = await createSourceService({ root, credential });
  const controller = new AbortController();
  await expect(source.captureManifest(identity, trusted, controller.signal, async () => {
    await Promise.resolve(); controller.abort(); controller.signal.throwIfAborted();
  })).rejects.toThrow('cancelled');
  expect(credential).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});
it.each([
  { name: 'numeric reset headers', status: 429, rateLimited: false, headers: { 'x-ratelimit-reset': '1201', 'retry-after': '1200' }, expected: { resetAt: 1201000, retryAfterMs: 1200000 } },
  { name: 'invalid timing stays unknown', status: 429, rateLimited: false, headers: { 'x-ratelimit-reset': 'SECRET_RAW_RESET', 'retry-after': 'Infinity' }, expected: { resetAt: null, retryAfterMs: null } },
  { name: 'explicit secondary rate limit', status: 403, rateLimited: true, headers: { 'retry-after': '1200' }, expected: { resetAt: null, retryAfterMs: 1200000 } },
])('exports only sanitized source rate timing for $name', async ({ status, rateLimited, headers, expected }) => {
  const root = await mkdtemp(join(process.cwd(), 'reviewer-test-source-rate-')); roots.push(root);
  const source = await createSourceService({ root, credential: async () => { throw {
    status, rateLimited, message: 'SECRET_RAW_MESSAGE', credential: 'SECRET_CREDENTIAL',
    response: { headers: { ...headers, authorization: 'SECRET_HEADER' } },
  }; } });
  const failure: unknown = await source.captureManifest(identity, trusted).then(() => null, error => error);
  expect(failure).toBeInstanceOf(SourceFailure);
  if (!(failure instanceof SourceFailure)) throw new Error('Missing safe source failure');
  expect(failure.reason).toEqual({ kind: 'rate_limit', retryTiming: expected });
  expect(failure.message).toBe('source_rate_limited');
  expect(JSON.stringify(failure)).not.toContain('SECRET');
  expect(await readdir(root)).toEqual([]);
});
it.skipIf(process.env.REVIEWER_HOST_GIT_TEST !== '1')('launches the real Git credential helper with only synthetic credentials and rejects another host', async () => {
  expect(await checkTransport(true)).toContain('password=synthetic-secret-token');
  expect(await checkTransport(true, 'untrusted.invalid')).not.toContain('synthetic-secret-token');
});
