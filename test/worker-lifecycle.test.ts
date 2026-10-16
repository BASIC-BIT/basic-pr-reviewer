import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { SpawnOptionsWithoutStdio } from 'node:child_process';
import { createWorker, profile } from '../src/worker.js';
import { passSpecSchema } from '../src/contracts.js';
import { event } from './fixtures/identities.js';
import { navigationAlias, renderNavigation, passContextHash } from '../src/source.js';

const fake = vi.hoisted(() => ({ reply: (_args: string[], _env: NodeJS.ProcessEnv | undefined) => ({ stdout: '', code: 0 }) }));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn(command: string, args: string[], options: SpawnOptionsWithoutStdio) {
    if (command !== 'docker') throw new Error('Unexpected executable');
    const reply = fake.reply(args, options.env);
    return actual.spawn(process.execPath, ['-e', `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(reply.stdout)});process.exit(${reply.code})})`], options);
  } };
});
afterEach(() => vi.restoreAllMocks());

it('blocks admission after removal failure, then reaps before admitting again without persisting credentials', async () => {
  // Only this fake Docker test adapts the UID gate; unit CI may run under any UID.
  if (process.getuid) vi.spyOn(process, 'getuid').mockReturnValue(1000);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'worker-lifecycle-')));
  try {
    const bundle = join(root, 'bundle'); await mkdir(bundle); await mkdir(join(bundle, 'data')); await mkdir(join(bundle, 'quarantine'));
    let failRemoval = true, starts = 0, remainingContainer = false;
    const calls: string[][] = [];
    fake.reply = (args, env) => {
      calls.push(args);
      expect(JSON.stringify({ args, env }).includes('synthetic-lifecycle-credential')).toBe(false);
      expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      let stdout = '';
      if (args[0] === 'version') stdout = '29.5.2';
      else if (args[0] === 'image') stdout = 'linux/amd64';
      else if (args[0] === 'run' && args.includes('cat')) {
        stdout = readFileSync(new URL(`../worker/${basename(args.at(-1) ?? '')}`, import.meta.url), 'utf8');
      } else if (args[0] === 'run' && args.at(-1) === '--version') stdout = args.includes('node') ? `v${profile.node}` : `${profile.cliVersion} (Claude Code)`;
      else if (args[0] === 'run' && args.includes('dpkg-query')) stdout = profile.squid;
      else if (args[0] === 'exec') stdout = '-----BEGIN CERTIFICATE-----\nsynthetic';
      else if (args[0] === 'start') {
        starts++;
        stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { findings: [], priorFindingAssessments: [] },
          modelUsage: { [profile.model]: { inputTokens: 1, outputTokens: 1 } } });
      } else if (args[0] === 'rm' && failRemoval) {
        failRemoval = false; remainingContainer = true; return { stdout: '', code: 1 };
      } else if (args[0] === 'ps' && remainingContainer) stdout = 'a'.repeat(12);
      else if (args[0] === 'rm' && args.includes('a'.repeat(12))) remainingContainer = false;
      return { stdout, code: 0 };
    };
    const credential = vi.fn(async () => 'synthetic-lifecycle-credential');
    const worker = await createWorker({ workerImage: `sha256:${'1'.repeat(64)}`, proxyImage: `sha256:${'2'.repeat(64)}`,
      temporaryRoot: root, oauthToken: credential });
    const identity = { ...event.identity, attemptId: '1', generation: 1, runtimeHash: worker.runtimeHash };
    const spec = passSpecSchema.parse({ id: 'lifecycle', kind: 'scope', unitIds: [], reviewUnits: [], sourceMap: [], trustedInstructions: [], priorFindings: [], bundlePath: bundle,
      contextHash: createHash('sha256').update(JSON.stringify({ policyHash: identity.policyHash, runtimeHash: worker.runtimeHash, files: [] })).digest('hex') });
    spec.contextHash = passContextHash(identity, spec.sourceMap, renderNavigation(spec));
    await writeFile(join(bundle, navigationAlias), renderNavigation(spec));
    await worker.reap();
    expect((await worker.runPass(identity, spec, new AbortController().signal)).failureCode).toBe('cleanup_failure');
    expect(calls.filter(args => args[0] === 'network' && args[1] === 'rm')).toHaveLength(2);
    expect((await worker.runPass(identity, spec, new AbortController().signal)).failureCode).toBe('recovery_required');
    expect(starts).toBe(1);
    await worker.reap();
    expect(remainingContainer).toBe(false);
    expect((await worker.runPass(identity, spec, new AbortController().signal)).status).toBe('completed');
    expect(starts).toBe(2);
    const beforeCredentialCount = credential.mock.calls.length;
    const controller = new AbortController();
    const guard = vi.fn(async () => { await Promise.resolve(); controller.abort(); controller.signal.throwIfAborted(); });
    expect((await worker.runPass(identity, spec, controller.signal, guard)).failureCode).toBe('cancelled');
    expect(guard).toHaveBeenCalledOnce();
    expect(credential).toHaveBeenCalledTimes(beforeCredentialCount);
    expect(starts).toBe(2);
    for (const args of calls.filter(args => args[0] === 'create' || args[0] === 'run' && args.includes('-d'))) {
      expect(args[args.indexOf('--log-driver') + 1]).toBe('none');
    }
    const text = '"'.repeat(profile.maxRequestBytes), allocationCalls = calls.length;
    const oversized = { ...spec, trustedInstructions: [{ path: 'REVIEW.md', text, hash: createHash('sha256').update(text).digest('hex') }] };
    expect((await worker.runPass(identity, oversized, new AbortController().signal)).failureCode).toBe('request_input_limit');
    expect(calls).toHaveLength(allocationCalls);
    expect(credential).toHaveBeenCalledTimes(beforeCredentialCount);
    expect(starts).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
