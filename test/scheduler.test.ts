import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore, LEASE_DURATION_MS, RECOVERY_WINDOW_MS } from '../src/store.js';
import { event, outcome, spec } from './fixtures/identities.js';
import type { Store } from '../src/contracts.js';
import { createScheduler } from '../src/scheduler.js';
import { createSourceService } from '../src/source.js';
import { fixture, policy, identity, service, temp, git } from './fixtures/source.js';
import type { PassOutcome, PassSpec, ReviewIdentity, LivePull } from '../src/contracts.js';

vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>();
  return { ...fs, rm: vi.fn(fs.rm), writeFile: vi.fn(fs.writeFile) };
});
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const stores: Store[] = [];
function ledger(path = ':memory:') { const store = openStore(path); stores.push(store); return store; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('worker ownership', () => {
  it('fences an expired owner from saving, publishing, renewing or finishing a replacement claim', () => {
    const store = ledger(), identity = store.admit(event).identity;
    const first = store.claim(1000)!;
    const late = { token: first.lease.token, now: 1000 + LEASE_DURATION_MS };
    expect(() => store.savePass(identity, spec, outcome, late)).toThrow(/lease/i);
    store.recoverExpiredLeases(late.now);
    const replacement = store.claim(late.now)!;
    expect(replacement.lease.token).not.toBe(first.lease.token);
    expect(() => store.renewLease(identity, late)).toThrow(/lease/i);
    expect(() => store.planPublication({ identity, key: 'stale', channel: 'check', body: 'old' }, late)).toThrow(/lease/i);
    expect(() => store.settle(identity, late, { state: 'incomplete', reason: 'old', nextAttemptAt: late.now, result: null })).toThrow(/lease/i);
    store.savePass(identity, spec, outcome, { token: replacement.lease.token, now: late.now });
    expect(store.current(identity.repositoryId, identity.pullNumber)?.passes).toHaveLength(1);
  });

  it('uses one lease globally and renews without allowing a terminal owner to write', () => {
    const store = ledger(), identity = store.admit(event).identity;
    store.admit({ ...event, deliveryId: 'other', identity: { ...event.identity, pullNumber: 43 } });
    const claimed = store.claim(1000)!;
    expect(store.claim(1001)).toBeNull();
    const owner = { token: claimed.lease.token, now: 2000 };
    expect(store.renewLease(identity, owner).expiresAt).toBe(2000 + LEASE_DURATION_MS);
    store.settle(identity, owner, { state: 'incomplete', reason: 'stopped', nextAttemptAt: 2000, result: null });
    expect(() => store.savePass(identity, spec, outcome, owner)).toThrow(/lease/i);
    expect(store.claim(2001)?.identity.pullNumber).toBe(43);
  });

  it('cancellation advances the observation and invalidates every worker transition', () => {
    const store = ledger(), identity = store.admit(event).identity;
    const claim = store.claim(1000)!, owner = { token: claim.lease.token, now: 1001 };
    store.invalidatePull(identity.repositoryId, identity.pullNumber, identity.generation, 'base_changed', identity.headSha, identity.baseRef);
    expect(() => store.savePass(identity, spec, outcome, owner)).toThrow(/stale/i);
    expect(() => store.renewLease(identity, owner)).toThrow(/stale/i);
    expect(store.claim(2000)).toBeNull();
  });
  it('stops repeated crashed claims after four losses instead of restarting forever', () => {
    const store = ledger(), identity = store.admit(event).identity;
    for (let i = 0; i < 4; i++) {
      const now = 1000 + i * LEASE_DURATION_MS;
      expect(store.claim(now)).not.toBeNull();
      store.recoverExpiredLeases(now + LEASE_DURATION_MS);
    }
    expect(store.claim(1000 + 5 * LEASE_DURATION_MS)).toBeNull();
    expect(store.current(identity.repositoryId, identity.pullNumber)).toMatchObject({ state: 'incomplete', interventionReason: 'lease_recovery_exhausted' });
  });
  it('cannot finish a missing result as a clean review', () => {
    const store = ledger(), identity = store.admit(event).identity, claim = store.claim(1000)!;
    expect(() => store.settle(identity, { token: claim.lease.token, now: 1001 }, { state: 'complete', reason: null, nextAttemptAt: 1001, result: null })).toThrow(/missing complete/i);
    expect(store.current(identity.repositoryId, identity.pullNumber)?.state).toBe('leased');
    expect(store.publications(identity.repositoryId, identity.pullNumber).filter(record => record.state === 'planned').every(record => JSON.parse(record.intent.body).state === 'leased')).toBe(true);
  });
});

async function setup(entries = [{ path: 'packages/alpha/index.ts', text: 'alpha\n' }, { path: 'packages/beta/index.ts', text: 'beta\n' }]) {
  const f = await fixture([], entries), trusted = policy(), { source, root } = await service(f);
  const path = join(await temp(), 'ledger.sqlite'), store = ledger(path);
  const input = identity(f, trusted);
  const { attemptId: _attempt, generation: _generation, ...reviewInput } = input;
  const admitted = store.admit({ ...event, identity: reviewInput, expectedGeneration: 0 });
  let now = 1000;
  const { policyHash: _policy, runtimeHash: _runtime, ...pullInput } = reviewInput;
  const pull: LivePull = { ...pullInput, ownerId: '1', headRepositoryId: input.repositoryId, baseRepositoryId: input.repositoryId,
    draft: false, state: 'open', labels: [], author: { login: 'synthetic', type: 'User' } };
  const calls: PassSpec[] = [];
  let run = async (_identity: ReviewIdentity, pass: PassSpec): Promise<PassOutcome> => ({ ...outcome, passId: pass.id, findings: [] });
  const ports = { store, source, now: () => now, random: () => 0.5,
    readCurrent: async (_id: ReviewIdentity, _signal: AbortSignal) => ({ pull, trusted }),
    worker: { runtimeHash: input.runtimeHash, reap: async () => {},
      runPass: async (id: ReviewIdentity, pass: PassSpec, signal: AbortSignal, guard?: () => Promise<void>) => {
        await guard?.(); signal.throwIfAborted(); calls.push(pass); return run(id, pass);
      } } };
  return { ports, root, path, store, id: admitted.identity, calls, pull, remote: f, commit: f.commit,
    scheduler: createScheduler(ports), setRun: (fn: typeof run) => { run = fn; }, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('ledger scheduler', { timeout: 120000 }, () => {
  it('persists one scope at a time and resumes after restart without rerunning it', async () => {
    const f = await setup();
    await f.scheduler.tick(f.now());
    expect(f.calls).toHaveLength(1);
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.passes).toHaveLength(1);
    f.store.close();
    const reopened = ledger(f.path);
    const resumed = createScheduler({ ...f.ports, store: reopened });
    await resumed.tick(f.now());
    await resumed.tick(f.now());
    expect(f.calls.map(pass => pass.kind)).toEqual(['scope', 'scope', 'integration']);
    expect(new Set(f.calls.map(pass => pass.id)).size).toBe(3);
    expect(reopened.current(f.id.repositoryId, f.id.pullNumber)?.result?.status).toBe('complete');
    const intents = reopened.publications(f.id.repositoryId, f.id.pullNumber);
    expect(intents.filter(record => record.state === 'planned')).toHaveLength(2);
    expect(intents.filter(record => record.state === 'planned').every(record => record.intent.body.includes('"state":"complete"'))).toBe(true);
  });

  it('honors persisted temporary retry timing and finite retries', async () => {
    const f = await setup();
    f.setRun(async (_id, pass) => ({ ...outcome, passId: pass.id, findings: [], status: 'failed', failureCode: 'temporary' }));
    await f.scheduler.tick(f.now());
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.nextAttemptAt).toBe(f.now() + 60000);
    await createScheduler(f.ports).tick(f.now());
    expect(f.calls).toHaveLength(1);
    f.advance(60000); await f.scheduler.tick(f.now());
    expect(f.calls).toHaveLength(2);
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.nextAttemptAt).toBe(f.now() + 300000);
  });

  it('yields between completed passes to another eligible PR', async () => {
    const f = await setup();
    const { attemptId: _a, generation: _g, ...input } = f.id;
    const other = f.store.admit({ ...event, deliveryId: 'other', identity: { ...input, pullNumber: 4 }, expectedGeneration: 0 }).identity;
    f.ports.readCurrent = async id => ({ pull: { ...f.pull, pullNumber: id.pullNumber }, trusted: policy() });
    const calls: number[] = [];
    f.setRun(async (id, pass) => { calls.push(id.pullNumber); return { ...outcome, passId: pass.id, findings: [] }; });
    for (let i = 0; i < 6; i++) await f.scheduler.tick(f.now());
    expect(calls).toEqual([f.id.pullNumber, other.pullNumber, f.id.pullNumber, other.pullNumber, f.id.pullNumber, other.pullNumber]);
    expect(await readdir(f.root)).toEqual([]);
  });

  it.each(['closed', 'draft', 'skipped', 'access_revoked', 'base_changed'] as const)('cancels active work for %s without saving obsolete results', async reason => {
    const f = await setup();
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    f.ports.worker.runPass = async (_id, pass, signal, guard) => {
      await guard?.(); started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ...outcome, passId: pass.id, findings: [] };
    };
    const tick = f.scheduler.tick(f.now());
    await running;
    await f.scheduler.cancelPull(f.id.repositoryId, f.id.pullNumber, reason);
    await tick;
    await f.scheduler.tick(f.now());
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.state).toBe('superseded');
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.passes).toEqual([]);
    expect(await readdir(f.root)).toEqual([]);
    const generation = f.store.observation(f.id.repositoryId, f.id.pullNumber).generation;
    await f.scheduler.cancelPull(f.id.repositoryId, f.id.pullNumber, reason);
    expect(f.store.observation(f.id.repositoryId, f.id.pullNumber).generation).toBe(generation);
  });

  it('rechecks live identity after asynchronous materialization and before credentials', async () => {
    const f = await setup();
    const original = f.ports.source.materializePass;
    f.ports.source.materializePass = async (...args) => {
      const value = await original(...args);
      f.pull.baseSha = 'f'.repeat(40);
      return value;
    };
    await f.scheduler.tick(f.now());
    expect(f.calls).toEqual([]);
    expect(f.store.observation(f.id.repositoryId, f.id.pullNumber).blockedReason).toBe('base_changed');
    expect(await readdir(f.root)).toEqual([]);
  });

  it('does not cancel useful work for irrelevant label changes', async () => {
    const f = await setup();
    f.pull.labels = ['documentation', 'ci:visuals'];
    await f.scheduler.tick(f.now());
    expect(f.calls).toHaveLength(1);
    expect(f.store.observation(f.id.repositoryId, f.id.pullNumber).blockedReason).toBeNull();
  });

  it('splits exhausted scopes, preserves completed children and integrates failed-parent findings', async () => {
    const f = await setup([{ path: 'packages/alpha/a.ts', text: 'a\n' }, { path: 'packages/alpha/b.ts', text: 'b\n' }]);
    f.setRun(async (_id, pass) => pass.kind === 'scope' && pass.unitIds.length > 1 ? {
      ...outcome, passId: pass.id, status: 'incomplete', failureCode: 'turn_limit', findings: [{ ...outcome.findings[0]!, evidence: [{ unitId: pass.unitIds[0]!, explanation: 'Captured evidence.' }] }],
    } : { ...outcome, passId: pass.id, findings: [] });
    for (let i = 0; i < 5; i++) await createScheduler(f.ports).tick(f.now());
    expect(f.calls.map(pass => [pass.kind, pass.unitIds.length])).toEqual([['scope', 2], ['scope', 1], ['scope', 1], ['integration', 2]]);
    expect(f.calls.at(-1)?.priorFindings).toHaveLength(1);
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.result).toMatchObject({ status: 'complete', missingUnitIds: [], failureCodes: ['turn_limit'] });
    expect(await readdir(f.root)).toEqual([]);
  });

  it('stops a single unsplittable exhausted unit with incomplete coverage', async () => {
    const f = await setup([{ path: 'a.ts', text: 'a\n' }]);
    f.setRun(async (_id, pass) => ({ ...outcome, passId: pass.id, findings: [], status: 'incomplete', failureCode: 'turn_limit' }));
    for (let i = 0; i < 9; i++) await f.scheduler.tick(f.now());
    const current = f.store.current(f.id.repositoryId, f.id.pullNumber);
    expect(f.calls).toHaveLength(5);
    expect(current).toMatchObject({ state: 'incomplete', result: { status: 'incomplete', complete: false } });
    expect(current?.result?.missingUnitIds).toHaveLength(1);
  });

  it('stops after 48 hours while retaining earlier progress and a visible incomplete intent', async () => {
    const f = await setup();
    await f.scheduler.tick(f.now());
    f.advance(RECOVERY_WINDOW_MS);
    await createScheduler(f.ports).tick(f.now());
    const current = f.store.current(f.id.repositoryId, f.id.pullNumber);
    expect(f.calls).toHaveLength(1);
    expect(current).toMatchObject({ state: 'incomplete', interventionReason: 'recovery_deadline' });
    expect(current?.passes).toHaveLength(1);
    expect(f.store.publications(f.id.repositoryId, f.id.pullNumber).at(-1)?.intent.body).toContain('recovery_deadline');
  });

  it('blocks every PR after cleanup failure until explicit safe worker recovery', async () => {
    const f = await setup();
    f.setRun(async (_id, pass) => ({ ...outcome, passId: pass.id, findings: [], status: 'failed', failureCode: 'cleanup_failure' }));
    const reap = vi.spyOn(f.ports.worker, 'reap');
    await f.scheduler.tick(f.now());
    await f.scheduler.tick(f.now());
    expect(f.calls).toHaveLength(1);
    expect(reap).not.toHaveBeenCalled();
    await f.scheduler.recoverWorker();
    f.setRun(async (_id, pass) => ({ ...outcome, passId: pass.id, findings: [] }));
    await f.scheduler.tick(f.now());
    expect(f.calls).toHaveLength(2);
    expect(reap).toHaveBeenCalledOnce();
  });

  it('schedules no inference for empty eligible scope', async () => {
    const f = await setup([]);
    await f.scheduler.tick(f.now());
    expect(f.calls).toEqual([]);
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'complete', result: { status: 'skipped', complete: false } });
  });

  it('finishes all reachable scopes within finite retries across repeated restarts', async () => {
    const f = await setup();
    f.setRun(async (_id, pass) => ({ ...outcome, passId: pass.id, findings: [], status: 'failed', failureCode: 'temporary' }));
    for (let i = 0; i < 30; i++) { await createScheduler(f.ports).tick(f.now()); f.advance(900000); }
    expect(f.calls).toHaveLength(12);
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'incomplete', result: { status: 'incomplete', complete: false } });
  });

  it('honors authoritative reset timing across restart, then stops on authentication failure', async () => {
    const f = await setup();
    f.ports.readCurrent = async () => { throw { status: 429, response: { headers: { 'x-ratelimit-reset': String((f.now() + 1200000) / 1000), 'retry-after': '1200' } } }; };
    await f.scheduler.tick(f.now());
    const expected = f.now() + 1200000;
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.nextAttemptAt).toBe(expected);
    f.advance(60000); await createScheduler(f.ports).tick(f.now());
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.nextAttemptAt).toBe(expected);
    f.advance(1140000);
    f.ports.readCurrent = async () => { throw { status: 401 }; };
    await createScheduler(f.ports).tick(f.now());
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'intervention', interventionReason: 'authentication_failure' });
    expect(f.calls).toEqual([]);
  });

  it('stops on provider authentication failure with a visible intervention reason', async () => {
    const f = await setup();
    f.setRun(async (_id, pass) => ({ ...outcome, passId: pass.id, findings: [], status: 'failed', failureCode: 'authentication_failure' }));
    await f.scheduler.tick(f.now());
    f.advance(RECOVERY_WINDOW_MS); await f.scheduler.tick(f.now());
    expect(f.calls).toHaveLength(1);
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'intervention', interventionReason: 'authentication_failure' });
    expect(f.store.publications(f.id.repositoryId, f.id.pullNumber).at(-1)?.intent.body).toContain('authentication_failure');
  });

  it('renews a live lease and aborts when current observation changes during an awaited stage', async () => {
    const f = await setup();
    let resolve!: (snapshot: Awaited<ReturnType<typeof f.ports.readCurrent>>) => void;
    f.ports.readCurrent = () => new Promise(done => { resolve = done; });
    vi.useFakeTimers();
    try {
      const running = f.scheduler.tick(f.now());
      const before = f.store.current(f.id.repositoryId, f.id.pullNumber)?.lease?.expiresAt;
      f.advance(60000); await vi.advanceTimersByTimeAsync(30000);
      expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.lease?.expiresAt).toBe((before ?? 0) + 60000);
      await f.scheduler.cancelPull(f.id.repositoryId, f.id.pullNumber, 'draft');
      resolve({ pull: f.pull, trusted: policy() });
      await running;
      expect(f.calls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('admits a concurrent new head while fencing the old worker and its publication intent', async () => {
    const f = await setup();
    const head = f.commit([{ path: 'new.ts', text: 'new head\n' }], f.id.headSha);
    f.setRun(async (_id, pass) => {
      const { attemptId: _a, generation: _g, ...input } = f.id;
      f.store.admit({ ...event, deliveryId: 'new-head', expectedGeneration: f.id.generation, identity: { ...input, headSha: head } });
      f.pull.headSha = head;
      return { ...outcome, passId: pass.id, findings: [] };
    });
    await Promise.all([f.scheduler.tick(f.now()), f.scheduler.tick(f.now())]);
    expect(f.calls).toHaveLength(1);
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'queued', identity: { headSha: head, generation: 2 }, passes: [] });
    expect(f.store.publications(f.id.repositoryId, f.id.pullNumber).filter(record => record.state === 'planned').every(record => record.intent.identity.generation === 2 && JSON.parse(record.intent.body).state === 'queued')).toBe(true);
    expect(await readdir(f.root)).toEqual([]);
  });

  it('preserves completed progress and stops admission when source cleanup fails', async () => {
    const f = await setup();
    let fail = true;
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (fail && String(path).startsWith(f.root) && /[\\/]bundle-/.test(String(path))) { fail = false; throw new Error('synthetic cleanup failure'); }
      await actualFs.rm(path, options);
    });
    try {
      await f.scheduler.tick(f.now()); await f.scheduler.tick(f.now());
      expect(f.calls).toHaveLength(1);
      expect(f.scheduler.recoveryRequired).toBe(true);
      expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.passes[0]?.outcome.status).toBe('completed');
      await f.scheduler.recoverWorker();
      expect(f.scheduler.recoveryRequired).toBe(false);
      expect(await readdir(f.root)).toEqual([]);
      await f.scheduler.tick(f.now());
      expect(f.calls).toHaveLength(2);
      expect(new Set(f.calls.map(pass => pass.id)).size).toBe(2);
    } finally { vi.mocked(rm).mockImplementation(actualFs.rm); }
  });

  it('keeps a guarded credential-read authentication failure visible even if a worker sanitizes it', async () => {
    const f = await setup();
    f.ports.worker.runPass = async (_id, pass, _signal, guard) => {
      f.ports.readCurrent = async () => { throw { status: 401 }; };
      try { await guard?.(); } catch { /* The actual worker returns a sanitized failure. */ }
      return { ...outcome, passId: pass.id, findings: [], status: 'failed', failureCode: 'worker_failure' };
    };
    await f.scheduler.tick(f.now());
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'intervention', interventionReason: 'authentication_failure', passes: [] });
    expect(await readdir(f.root)).toEqual([]);
  });

  it('aborts an in-flight pass at the recovery deadline while keeping saved scope', async () => {
    const f = await setup();
    await f.scheduler.tick(f.now());
    f.advance(RECOVERY_WINDOW_MS - 60000);
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.ports.worker.runPass = async (_id, pass, signal, guard) => {
      await guard?.(); started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ...outcome, passId: pass.id, findings: [] };
    };
    vi.useFakeTimers();
    try {
      const tick = f.scheduler.tick(f.now());
      await ready;
      f.advance(60000);
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'incomplete', interventionReason: 'recovery_deadline' });
      await tick;
      expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.passes).toHaveLength(1);
    } finally { vi.useRealTimers(); }
  });

  it('keeps saved findings visible through a source outage without claiming unrevalidated coverage', async () => {
    const f = await setup();
    f.setRun(async (_id, pass) => ({ ...outcome, passId: pass.id, findings: [{ ...outcome.findings[0]!, evidence: [{ unitId: pass.unitIds[0]!, explanation: 'Saved scope evidence.' }] }] }));
    await f.scheduler.tick(f.now());
    const source = await createSourceService({ root: await temp(), fetch: async () => { throw new Error('synthetic outage'); } });
    const restarted = createScheduler({ ...f.ports, source });
    await restarted.tick(f.now());
    const current = f.store.current(f.id.repositoryId, f.id.pullNumber);
    expect(current?.passes).toHaveLength(1);
    expect(current?.result).toMatchObject({ status: 'incomplete', complete: false, coveredUnitIds: [], findings: [expect.objectContaining({ message: outcome.findings[0]!.message })] });
    expect(current?.result?.missingUnitIds).toHaveLength(1);
    expect(current?.result?.failureCodes).toContain('retrieval_failed');
  });

  it.each([undefined, {}])('stops a Git credential authentication failure before inference with response %j', async response => {
    const f = await setup();
    const credential = vi.fn(async (): Promise<string> => { throw { status: 401, response, message: 'SECRET_AUTH_MESSAGE' }; });
    const source = await createSourceService({ root: await temp(), credential });
    await createScheduler({ ...f.ports, source }).tick(f.now());
    expect(credential).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'intervention', interventionReason: 'authentication_failure' });
    expect(JSON.stringify(f.store.publications(f.id.repositoryId, f.id.pullNumber))).not.toContain('SECRET_AUTH_MESSAGE');
  });

  it('uses finite backoff for a credential 429 with missing diagnostics and unknown timing', async () => {
    const f = await setup();
    const credential = vi.fn(async (): Promise<string> => { throw { status: 429, response: {}, message: 'SECRET_QUOTA_MESSAGE' }; });
    const source = await createSourceService({ root: await temp(), credential }), scheduler = createScheduler({ ...f.ports, source });
    await scheduler.tick(f.now());
    expect(f.store.current(f.id.repositoryId, f.id.pullNumber)).toMatchObject({ state: 'queued', interventionReason: 'source_rate_limited', nextAttemptAt: f.now() + 60000, result: null });
    await scheduler.tick(f.now());
    expect(credential).toHaveBeenCalledOnce();
    expect(f.calls).toEqual([]);
    expect(JSON.stringify(f.store.publications(f.id.repositoryId, f.id.pullNumber))).not.toContain('SECRET_QUOTA_MESSAGE');
  });

  it.each(['capture', 'materialize'] as const)('blocks admission when internal %s cleanup fails before returning ownership', async stage => {
    const f = await setup(), root = await temp();
    let failOperation = true, holdCleanup = true, writes = 0, captures = 0;
    const source = await createSourceService({ root, fetch: async ({ directory, identity }) => {
      captures++;
      if (stage === 'capture' && failOperation) throw new Error('PRIVATE_CAPTURE_DIAGNOSTIC');
      const pack = git(f.remote.directory, ['pack-objects', '--stdout', '--revs'], `${identity.baseSha}\n${identity.headSha}\n`);
      git(directory, ['index-pack', '--stdin'], pack);
    } });
    const ownedKind = stage === 'capture' ? /[\\/]capture-/ : /[\\/]bundle-/;
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (holdCleanup && String(path).startsWith(root) && ownedKind.test(String(path))) throw new Error('PRIVATE_CLEANUP_DIAGNOSTIC');
      await actualFs.rm(path, options);
    });
    vi.mocked(writeFile).mockImplementation(async (path, data, options) => {
      if (stage === 'materialize' && failOperation && String(path).startsWith(root) && /[\\/]bundle-/.test(String(path)) && ++writes === 2) throw new Error('PRIVATE_WRITE_DIAGNOSTIC');
      await actualFs.writeFile(path, data, options);
    });
    const scheduler = createScheduler({ ...f.ports, source });
    await actualFs.writeFile(join(root, 'unrelated.txt'), 'must be preserved');
    try {
      await scheduler.tick(f.now());
      expect(scheduler.recoveryRequired).toBe(true);
      expect(await readdir(root)).toHaveLength(2);
      f.advance(60000); await scheduler.tick(f.now());
      expect(captures).toBe(1); expect(f.calls).toEqual([]);
      await expect(source.captureManifest(f.id, policy())).rejects.toThrow('source_cleanup_failure');
      expect(captures).toBe(1);
      await expect(scheduler.recoverWorker()).rejects.toThrow('source_cleanup_failure');
      expect(scheduler.recoveryRequired).toBe(true);
      expect(await readdir(root)).toHaveLength(2);
      holdCleanup = false; failOperation = false;
      await scheduler.recoverWorker();
      expect(await readdir(root)).toEqual(['unrelated.txt']);
      expect(scheduler.recoveryRequired).toBe(false);
      await scheduler.tick(f.now());
      expect(captures).toBe(2); expect(f.calls).toHaveLength(1);
      expect(await readdir(root)).toEqual(['unrelated.txt']);
    } finally {
      holdCleanup = false;
      vi.mocked(rm).mockImplementation(actualFs.rm);
      vi.mocked(writeFile).mockImplementation(actualFs.writeFile);
    }
  });

  it.each([false, true])('persists an authoritative source credential reset through restart without premature retries or raw metadata, cleanup failure: %s', async failCleanup => {
    const f = await setup(), root = await temp(), resetAt = f.now() + 1200000;
    const credential = vi.fn(async (): Promise<string> => { throw {
      status: 429, message: 'PRIVATE_PROVIDER_MESSAGE', credential: 'PRIVATE_CREDENTIAL',
      response: { headers: { 'x-ratelimit-reset': String(resetAt / 1000), 'retry-after': '1200', authorization: 'PRIVATE_HEADER' } },
    }; });
    const source = await createSourceService({ root, credential });
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (failCleanup && String(path).startsWith(root) && /[\\/]capture-/.test(String(path))) { failCleanup = false; throw new Error('PRIVATE_CLEANUP_DIAGNOSTIC'); }
      await actualFs.rm(path, options);
    });
    try {
      await createScheduler({ ...f.ports, source }).tick(f.now());
      expect(f.store.current(f.id.repositoryId, f.id.pullNumber)?.nextAttemptAt).toBe(resetAt);
      f.store.close();
      const reopened = ledger(f.path), restarted = createScheduler({ ...f.ports, store: reopened, source });
      if (source.recoveryRequired) await restarted.recoverWorker();
      f.advance(60000); await restarted.tick(f.now());
      expect(credential).toHaveBeenCalledOnce();
      f.advance(1140000); await restarted.tick(f.now());
      expect(credential).toHaveBeenCalledTimes(2);
      const serialized = JSON.stringify({ current: reopened.current(f.id.repositoryId, f.id.pullNumber), intents: reopened.publications(f.id.repositoryId, f.id.pullNumber) });
      for (const secret of ['PRIVATE_PROVIDER_MESSAGE', 'PRIVATE_CREDENTIAL', 'PRIVATE_HEADER', 'authorization', 'retry-after']) expect(serialized).not.toContain(secret);
      expect(f.calls).toEqual([]); expect(await readdir(root)).toEqual([]);
    } finally { vi.mocked(rm).mockImplementation(actualFs.rm); }
  });
});
