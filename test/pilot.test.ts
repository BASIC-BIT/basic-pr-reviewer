import { expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { runPilot, runPilotCli, pilotRequestSchema } from '../src/pilot.js';
import { createAdmissionService } from '../src/events.js';
import { openStore } from '../src/store.js';
import { createSourceService } from '../src/source.js';
import { fixture, git, temp, policy } from './fixtures/source.js';
import type { GitHubPort } from '../src/github.js';
import type { LivePull, PassSpec, PassOutcome, ReviewIdentity } from '../src/contracts.js';

async function setup(files = 1) {
  const entries = Array.from({ length: files }, (_, i) => ({ path: `src/file-${String(i).padStart(3, '0')}.ts`, text: `export const value = ${i};\n` }));
  const remote = await fixture([], entries), root = await temp();
  const live: LivePull = { installationId: '1', repositoryId: '2', ownerId: '4', owner: 'synthetic', repo: 'fixture', pullNumber: 3,
    headRepositoryId: '2', baseRepositoryId: '2', headSha: remote.head, baseSha: remote.base, mergeBaseSha: remote.merge,
    baseRef: 'main', draft: false, state: 'open', labels: [], author: { login: 'author', type: 'User' } };
  const store = openStore(join(root, 'ledger.sqlite'));
  let revoked = false, missingPolicy = false, locked = false, exhausted = false, now = Date.now();
  const writes: string[] = [], calls: PassSpec[] = [];
  const github: GitHubPort = {
    async assertInstallation() { if (revoked) throw new Error('revoked'); return { ownerId: '4' }; },
    async readLivePull() { return structuredClone(live); }, async readDefaultBranch() { return 'main'; },
    async readFile(_pull, path) { return missingPolicy ? null : path === '.github/claude-review.json' ? JSON.stringify(policy().policy) : 'Synthetic instructions.'; },
    async listInstallations() { throw new Error('inventory forbidden'); }, async listRepositories() { throw new Error('inventory forbidden'); }, async listOpenPulls() { throw new Error('inventory forbidden'); },
    async readPermission() { return 'write'; }, async readCheckRun() { throw new Error('unused'); },
    async listOwnedPublications() { return []; }, async listThreads() { return []; },
    async upsertSummary() { writes.push('summary'); return '11'; }, async upsertCheck() { writes.push('check'); return '12'; },
    async createReview() { writes.push('inline'); return '13'; }, async resolveThread() { writes.push('resolve'); }, async unresolveThread() { writes.push('unresolve'); },
  };
  const admission = createAdmissionService({ store, github, webhookSecret: 'synthetic', appId: '5', ownerIds: ['4'], runtimeHash: 'e'.repeat(64), now: () => now });
  async function admit() {
    const body = JSON.stringify({ action: 'synchronize', installation: { id: 1 }, repository: { id: 2 }, number: 3, pull_request: { number: 3, head: { sha: live.headSha } }, sender: { login: 'human', type: 'User' } });
    await admission.admitWebhook({ 'x-github-event': 'pull_request', 'x-github-delivery': `delivery-${now++}`, 'x-hub-signature-256': `sha256=${createHmac('sha256', 'synthetic').update(body).digest('hex')}` }, Buffer.from(body));
  }
  await admit();
  const sourceRoot = join(root, 'source'); await mkdir(sourceRoot);
  const source = await createSourceService({ root: sourceRoot, fetch: async ({ directory, identity, beforeCredential }) => {
    await beforeCredential?.(); git(directory, ['index-pack', '--stdin'], git(remote.directory, ['pack-objects', '--stdout', '--revs'], `${identity.baseSha}\n${identity.headSha}\n`));
  } });
  if (files > 1) {
    // Cache immutable synthetic input at the source boundary; lifecycle tests cover per-attempt filesystem cleanup.
    const capture = source.captureManifest, destroy = source.destroyWorkspace;
    const captures = new Map<string, Awaited<ReturnType<typeof capture>>>();
    source.captureManifest = async (...args) => {
      const key = JSON.stringify(args[0]); let manifest = captures.get(key);
      if (!manifest) { manifest = await capture(...args); captures.set(key, manifest); }
      return manifest;
    };
    source.destroyWorkspace = async path => { if (![...captures.values()].some(m => m.workspace === path)) await destroy(path); };
    source.recoverCleanup = async () => {};
  }
  const worker = { runtimeHash: 'e'.repeat(64), reap: vi.fn(async () => { expect(locked).toBe(true); }),
    runPass: vi.fn(async (_identity: ReviewIdentity, spec: PassSpec, signal: AbortSignal, guard?: () => Promise<void>): Promise<PassOutcome> => {
      await guard?.(); signal.throwIfAborted(); calls.push(spec);
      const unit = spec.reviewUnits[0];
      const base = { passId: spec.id, findings: unit && spec.kind === 'scope' ? [{ id: `finding-${unit.id}`, message: 'Synthetic finding.', severity: 'P2' as const,
        location: { kind: 'summary' as const, path: null }, evidence: [{ unitId: unit.id, explanation: 'Synthetic evidence.' }] }] : [], priorFindingAssessments: [], model: { name: 'synthetic', cliVersion: 'fixture' }, usage: { inputTokens: 1, outputTokens: 1 } };
      return exhausted && calls.length > 1 ? { ...base, status: 'failed', failureCode: 'turn_limit' } : { ...base, status: 'completed', failureCode: null };
    }) };
  const options = { acquireOwnership: async () => { if (locked) throw new Error('locked'); locked = true; return async () => { locked = false; }; },
    requirePaused: vi.fn(async () => {}), openStore: async () => ({ store, close: () => {} }),
    open: vi.fn(async () => ({ github, source, worker, ownerIds: ['4'], coreRevision: 'a'.repeat(40), coreHash: 'b'.repeat(64) })),
    now: () => now };
  const request = () => pilotRequestSchema.parse({ identity: store.current('2', 3)!.identity, coreRevision: 'a'.repeat(40), coreHash: 'b'.repeat(64), maxTicks: 200, maxElapsedMs: 60000 });
  return { store, live, remote, entries, options, request, calls, writes, worker, admit,
    revoke: () => { revoked = true; }, missing: () => { missingPolicy = true; }, lock: () => { locked = true; }, exhaust: () => { exhausted = true; }, recover: () => { exhausted = false; }, advance: () => { now += 60001; } };
}

it('requires intent, ownership, durable pause and exact admission before opening credentials', async () => {
  const f = await setup();
  try {
    await expect(runPilot(f.request(), { credentials: false, inference: true, publication: false }, f.options)).rejects.toThrow();
    expect(f.options.open).not.toHaveBeenCalled();
    f.lock(); await expect(runPilot(f.request(), { credentials: true, inference: true, publication: false }, f.options)).rejects.toThrow('locked');
    expect(f.options.open).not.toHaveBeenCalled();
  } finally { f.store.close(); }
});

it.each(['stale', 'revoked', 'missing', 'other', 'runtime', 'pause', 'core', 'attempt'] as const)('refuses %s without inference or publication', async reason => {
  const f = await setup(); const request = f.request();
  if (reason === 'stale') f.live.headSha = 'f'.repeat(40);
  if (reason === 'revoked') f.revoke();
  if (reason === 'missing') f.missing();
  if (reason === 'other') { const { attemptId, generation, ...identity } = request.identity; f.store.admit({ schemaVersion: 1, deliveryId: 'other', receivedAt: Date.now(), expectedGeneration: 0, trigger: { kind: 'automatic' }, identity: { ...identity, pullNumber: 4 } }); }
  if (reason === 'runtime') request.identity.runtimeHash = 'f'.repeat(64);
  if (reason === 'core') request.coreHash = 'f'.repeat(64);
  if (reason === 'attempt') request.identity.attemptId = '999';
  if (reason === 'pause') f.options.requirePaused.mockRejectedValueOnce(new Error('paused_required'));
  try {
    await expect(runPilot(request, { credentials: true, inference: true, publication: false }, f.options)).rejects.toThrow();
    expect(f.calls).toEqual([]); expect(f.writes).toEqual([]);
  } finally { f.store.close(); }
});

it('rejects missing, ambiguous and extra CLI intent before reading host configuration', async () => {
  for (const flags of [[], ['--allow-credentials', '--allow-inference', '--drained'], ['--allow-credentials', '--allow-inference', '--drained', '--shadow', '--allow-publication'], ['--allow-credentials', '--allow-inference', '--drained', '--shadow', '--override']]) {
    await expect(runPilotCli(['missing.json', 'unused.json', ...flags])).rejects.toThrow('pilot_arguments_required');
  }
});

it('enforces elapsed bounds between passes without publishing and permits bounded continuation', async () => {
  const f = await setup(); const normal = f.worker.runPass.getMockImplementation()!;
  f.worker.runPass.mockImplementationOnce(async (...args) => { const outcome = await normal(...args); f.advance(); return outcome; });
  try {
    const report = await runPilot(f.request(), { credentials: true, inference: true, publication: true }, f.options);
    expect(report.deadlineReached).toBe(true); expect(report.executedPasses).toBe(1); expect(report.publications).toEqual([]); expect(f.writes).toEqual([]);
    const continued = await runPilot(f.request(), { credentials: true, inference: true, publication: false }, f.options);
    expect(continued.coverage?.complete).toBe(true);
  } finally { f.store.close(); }
});

it('refuses a force push during inference before any publication', async () => {
  const f = await setup(); const normal = f.worker.runPass.getMockImplementation()!;
  f.worker.runPass.mockImplementationOnce(async (...args) => { const outcome = await normal(...args); f.live.headSha = 'f'.repeat(40); await args[3]?.(); return outcome; });
  try {
    await expect(runPilot(f.request(), { credentials: true, inference: true, publication: true }, f.options)).rejects.toThrow('pilot_target_changed');
    expect(f.writes).toEqual([]);
  } finally { f.store.close(); }
});

it('interrupts inference, cleans owned allocations and releases its lease without resuming normal execution', async () => {
  const f = await setup(), cancellation = new AbortController();
  f.worker.runPass.mockImplementationOnce(async (_identity, _spec, signal) => {
    cancellation.abort(); signal.throwIfAborted(); throw new Error('expected abort');
  });
  try {
    const report = await runPilot(f.request(), { credentials: true, inference: true, publication: true }, { ...f.options, signal: cancellation.signal });
    expect(report.deadlineReached).toBe(true); expect(report.normalExecutionPaused).toBe(true);
    expect(f.store.current('2', 3)?.state).toBe('queued'); expect(f.worker.reap).toHaveBeenCalledTimes(2); expect(f.writes).toEqual([]);
  } finally { f.store.close(); }
});

it('withholds every shadow write, resumes saved work, and publishes only with explicit intent', async () => {
  const f = await setup();
  try {
    const partial = await runPilot({ ...f.request(), maxTicks: 1 }, { credentials: true, inference: true, publication: false }, f.options);
    expect(partial.mode).toBe('shadow'); expect(partial.coverage?.complete).toBe(false); expect(f.writes).toEqual([]);
    const complete = await runPilot(f.request(), { credentials: true, inference: true, publication: false }, f.options);
    expect(complete.coverage?.complete).toBe(true); expect(f.calls).toHaveLength(2); expect(f.writes).toEqual([]);
    const published = await runPilot(f.request(), { credentials: true, inference: true, publication: true }, f.options);
    expect(published.publications.some(p => p.state === 'acknowledged')).toBe(true); expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(published)).not.toContain('Synthetic finding');
  } finally { f.store.close(); }
});

it('accounts for 66 files, keeps completed findings after exhaustion and reuses only compatible scope on continuation', async () => {
  const f = await setup(66); f.exhaust();
  try {
    const partial = await runPilot({ ...f.request(), maxTicks: 2 }, { credentials: true, inference: true, publication: false }, f.options);
    expect(partial.coverage?.eligibleFiles).toBe(66);
    expect(partial.coverage?.complete).toBe(false); expect(partial.coverage!.coveredUnits).toBeGreaterThan(0);
    expect(partial.coverage!.missingUnits).toBeGreaterThan(0); expect(partial.coverage!.findings).toBeGreaterThan(0);
    const completedPass = f.calls[0]!.id; f.recover();
    const continued = await runPilot(f.request(), { credentials: true, inference: true, publication: false }, f.options);
    expect(continued.coverage).toMatchObject({ complete: false, coveredUnits: 65, missingUnits: 1, findings: 66, integrationStatus: 'completed' });
    const saved = f.store.current('2', 3)!;
    const completedScopes = saved.passes.filter(pass => pass.spec.kind === 'scope' && pass.outcome.status === 'completed');
    expect(completedScopes).toHaveLength(65);
    expect(completedScopes.every(pass => pass.outcome.findings.every(finding => saved.result!.findings.some(retained => retained.id === finding.id)))).toBe(true);
    expect(f.calls.filter(p => p.id === completedPass)).toHaveLength(1);
    expect(f.store.current('2', 3)?.result?.findings.some(finding => finding.id === `finding-${f.calls[0]!.unitIds[0]}`)).toBe(true);
    f.live.headSha = f.remote.commit([...f.entries, { path: 'src/extra.ts', text: 'export const extra = true;\n' }], f.live.headSha); await f.admit();
    const delta = await runPilot(f.request(), { credentials: true, inference: true, publication: false }, f.options);
    expect(delta.coverage?.complete).toBe(true); expect(delta.coverage!.reusedUnits).toBe(65);
    expect(delta.coverage?.integrationStatus).toBe('completed');
    expect(delta.executedPasses).toBe(3); // Retry failed scope, cover the new file, then current integration.
    f.live.headSha = f.remote.commit([{ ...f.entries[0]!, text: 'export const value = 999;\n' }, ...f.entries.slice(1), { path: 'src/extra.ts', text: 'export const extra = true;\n' }], f.live.headSha); await f.admit();
    const changed = await runPilot(f.request(), { credentials: true, inference: true, publication: false }, f.options);
    expect(changed.coverage).toMatchObject({ complete: true, reusedUnits: 66, integrationStatus: 'completed' });
    expect(changed.executedPasses).toBe(2);
  } finally { f.store.close(); }
}, 60000);
