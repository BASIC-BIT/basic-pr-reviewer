import { z } from 'zod';
import { livePullSchema, repoPolicySchema, timestampSchema } from './contracts.js';
import type { ClaimedAttempt, LivePull, Manifest, PassOutcome, PlannedPass, ReviewIdentity, Store, TrustedPolicy } from './contracts.js';
import { GitHubAccessError } from './github.js';
import { aggregateReview, planCoverage, splitScope } from './passes.js';
import { ConfigurationError } from './policy.js';
import { RECOVERY_WINDOW_MS } from './store.js';
import type { createSourceService } from './source.js';
import type { createWorker } from './worker.js';

export type CancellationReason = 'superseded' | 'closed' | 'draft' | 'skipped' | 'access_revoked' | 'base_changed' | 'retarget' | 'policy_changed' | 'disabled' | 'fork' | 'bot_author';
export const RETRY_DELAYS_MS = [60_000, 300_000, 900_000];
export const HEARTBEAT_MS = 30_000;
type Source = Awaited<ReturnType<typeof createSourceService>>;
type Worker = Awaited<ReturnType<typeof createWorker>>;
export type SchedulerOptions = {
  store: Store; source: Source; worker: Worker; now: () => number; random?: () => number;
  // Host composition verifies installation ownership/access and loads policy at trusted revisions.
  readCurrent: (identity: ReviewIdentity, signal: AbortSignal) => Promise<{ pull: LivePull; trusted: TrustedPolicy }>;
};

export function createScheduler(options: SchedulerOptions) {
  const { store, source, worker } = options;
  let active: { claim: ClaimedAttempt; controller: AbortController } | null = null;
  let blocked = false;
  const cleanup = new Set<string>();

  async function cancelPull(repositoryId: string, pullNumber: number, reason: CancellationReason): Promise<void> {
    const current = store.current(repositoryId, pullNumber), observed = store.observation(repositoryId, pullNumber);
    if (observed.blockedReason !== reason || current?.state !== 'superseded') {
      store.invalidatePull(repositoryId, pullNumber, observed.generation, reason, current?.identity.headSha ?? null, current?.identity.baseRef ?? null);
    }
    if (active?.claim.identity.repositoryId === repositoryId && active.claim.identity.pullNumber === pullNumber) active.controller.abort();
  }

  function recoverExpiredLeases(now: number): void {
    if (active && active.claim.lease.expiresAt <= now) active.controller.abort();
    store.recoverExpiredLeases(now);
  }

  async function recoverWorker(): Promise<void> {
    if (active) throw new Error('worker_busy');
    blocked = true;
    await worker.reap();
    for (const directory of cleanup) { await source.destroyWorkspace(directory); cleanup.delete(directory); }
    blocked = false;
  }

  async function run(claim: ClaimedAttempt, controller: AbortController): Promise<void> {
    const { identity } = claim, { signal } = controller;
    let manifest: Manifest | null = null;
    let result = claim.result;
    const boundaryFailure: { error?: unknown } = {};
    const owner = () => ({ token: claim.lease.token, now: timestampSchema.parse(options.now()) });
    function check(): void {
      signal.throwIfAborted();
      const current = store.current(identity.repositoryId, identity.pullNumber), observed = store.observation(identity.repositoryId, identity.pullNumber);
      if (current?.state !== 'leased' || current.lease.token !== claim.lease.token || current.lease.expiresAt <= options.now() ||
        observed.generation !== identity.generation || !store.accessAllowed(identity.installationId, identity.repositoryId)) {
        controller.abort(); signal.throwIfAborted();
      }
      if (options.now() - (claim.recoveryStartedAt ?? options.now()) >= RECOVERY_WINDOW_MS) {
        store.settle(identity, owner(), { state: 'incomplete', reason: 'recovery_deadline', nextAttemptAt: options.now(), result });
        controller.abort(); signal.throwIfAborted();
      }
    }
    async function awaited<T>(stage: Promise<T>): Promise<T> { const value = await stage; check(); return value; }
    async function current(): Promise<TrustedPolicy> {
      check();
      let snapshot: Awaited<ReturnType<typeof options.readCurrent>> | null = null;
      for (let retry = 0; retry < 3; retry++) {
        const accessGeneration = store.accessGeneration();
        const value = await awaited(options.readCurrent(identity, signal));
        if (store.accessGeneration() === accessGeneration) { snapshot = value; break; }
      }
      if (!snapshot) throw new Error('access_observation_changed');
      const pull = livePullSchema.parse(snapshot.pull), policy = repoPolicySchema.parse(snapshot.trusted.policy);
      let reason: CancellationReason | null = null;
      if (pull.installationId !== identity.installationId || pull.repositoryId !== identity.repositoryId || pull.pullNumber !== identity.pullNumber ||
        pull.owner !== identity.owner || pull.repo !== identity.repo) reason = 'access_revoked';
      else if (pull.state === 'closed') reason = 'closed';
      else if (pull.draft) reason = 'draft';
      else if (pull.headRepositoryId !== identity.repositoryId || pull.baseRepositoryId !== identity.repositoryId) reason = 'fork';
      else if (pull.baseRef !== identity.baseRef) reason = 'retarget';
      else if (pull.headSha !== identity.headSha) reason = 'superseded';
      else if (pull.baseSha !== identity.baseSha || pull.mergeBaseSha !== identity.mergeBaseSha) reason = 'base_changed';
      else if (!policy.enabled || !policy.baseBranches.includes(pull.baseRef)) reason = 'disabled';
      else if (policy.skipLabels.some(label => pull.labels.includes(label))) reason = 'skipped';
      else if (pull.author.type !== 'User' && !policy.allowBotAuthors) reason = 'bot_author';
      else if (snapshot.trusted.policyHash !== identity.policyHash || worker.runtimeHash !== identity.runtimeHash) reason = 'policy_changed';
      if (reason) { await cancelPull(identity.repositoryId, identity.pullNumber, reason); signal.throwIfAborted(); }
      return snapshot.trusted;
    }
    async function guard(): Promise<void> {
      try { await current(); }
      catch (error) { boundaryFailure.error = error; throw error; }
    }
    function settle(state: 'queued' | 'complete' | 'incomplete' | 'intervention', reason: string | null, nextAttemptAt = options.now()): void {
      check();
      store.settle(identity, owner(), { state, reason, nextAttemptAt, result });
    }
    function retry(count: number, reason: string, resetAt?: number): void {
      const delay = RETRY_DELAYS_MS[count - 1], now = options.now();
      const next = Math.max(now + Math.round((delay ?? 0) * (0.9 + (options.random?.() ?? Math.random()) * 0.2)), resetAt ?? 0);
      if (delay === undefined || next - (claim.recoveryStartedAt ?? now) >= RECOVERY_WINDOW_MS) settle('incomplete', 'recovery_exhausted');
      else settle('queued', reason, next);
    }
    function records() { return store.current(identity.repositoryId, identity.pullNumber)?.passes ?? []; }
    function select(pass: PlannedPass, covered: Set<string>): PlannedPass | null {
      if (pass.kind === 'scope' && pass.unitIds.every(id => covered.has(id))) return null;
      const saved = records().find(record => record.spec.id === pass.id);
      if (saved?.outcome.status === 'completed') return null;
      const exhausted = saved?.outcome.failureCode === 'turn_limit' || saved?.outcome.failureCode === 'timeout';
      if (exhausted && manifest && pass.kind === 'scope') {
        for (const child of splitScope(manifest, pass)) { const next = select(child, covered); if (next) return next; }
        return null;
      }
      if (store.passAttempts(identity, pass.id) >= 4) return null;
      return pass;
    }
    const timer = setInterval(() => {
      try { check(); claim.lease = store.renewLease(identity, owner()); }
      catch { controller.abort(); }
    }, HEARTBEAT_MS);
    timer.unref();
    try {
      check();
      const trusted = await current();
      // Capture owns its temporary directory until it returns, even on cancellation.
      manifest = await source.captureManifest(identity, trusted, signal, guard);
      if ('error' in boundaryFailure) throw boundaryFailure.error;
      check();
      const history = store.passHistory(identity.repositoryId, identity.pullNumber);
      const ancestry = await awaited(source.verifyAncestry(manifest, [identity.headSha, ...history.map(record => record.identity.headSha)], signal));
      let plan = planCoverage(manifest, history, ancestry);
      for (const reused of plan.reusedPasses) store.savePass(identity, reused.spec, reused.outcome, owner());
      result = aggregateReview(identity, manifest, records());
      if (!manifest.units.length && manifest.retrievalFailures.length) {
        const saved = records();
        result = { ...result,
          findings: [...new Map(saved.flatMap(record => record.outcome.findings).map(finding => [finding.id, finding])).values()],
          missingUnitIds: [...new Set(saved.filter(record => record.spec.kind === 'scope').flatMap(record => record.spec.unitIds))],
          integrationStatus: saved.length ? 'incomplete' : result.integrationStatus,
        };
      }
      const credentialFailure = manifest.retrievalFailures.find(item => ['authentication_failure', 'credential_unavailable', 'credential_invalid'].includes(item.code));
      if (credentialFailure) { settle('intervention', credentialFailure.code); return; }
      const covered = new Set(result.coveredUnitIds);
      let next: PlannedPass | null = null;
      for (const pass of plan.freshPasses.filter(pass => pass.kind === 'scope')) { next = select(pass, covered); if (next) break; }
      // Integration inputs must include every usable scope finding at this boundary.
      if (!next) {
        plan = planCoverage(manifest, store.passHistory(identity.repositoryId, identity.pullNumber), ancestry);
        const integration = plan.freshPasses.find(pass => pass.kind === 'integration');
        if (integration) next = select(integration, covered);
      }
      if (!next) {
        if (result.status === 'complete' || result.status === 'skipped') settle('complete', null);
        else if (manifest.retrievalFailures.length) retry(store.startPass(identity, 'retrieval', owner()), 'source_unavailable');
        else settle('incomplete', 'scope_exhausted');
        return;
      }
      const pass = next;
      await current();
      const materialized = await source.materializePass(manifest, pass, signal);
      cleanup.add(materialized.bundle.directory);
      let outcome: PassOutcome;
      try {
        check();
        const count = store.startPass(identity, pass.id, owner());
        await current();
        outcome = await worker.runPass(identity, materialized.spec, signal, guard);
        if (outcome.failureCode === 'cleanup_failure' || outcome.failureCode === 'recovery_required') blocked = true;
        if ('error' in boundaryFailure) throw boundaryFailure.error;
        check();
        store.savePass(identity, pass, outcome, owner());
        result = aggregateReview(identity, manifest, records());
        if (blocked) settle('queued', 'cleanup_failure');
        else if (outcome.status === 'completed') {
          if (result.status === 'complete') settle('complete', null);
          else settle('queued', 'automatic_recovery');
        } else if (['authentication_failure', 'credential_unavailable', 'provider_access_denied'].includes(outcome.failureCode)) settle('intervention', outcome.failureCode);
        else if (outcome.failureCode === 'turn_limit' || outcome.failureCode === 'timeout') settle('queued', 'scope_exhausted');
        else if (count >= 4) settle('queued', 'pass_retries_exhausted');
        else retry(count, outcome.failureCode);
      } finally {
        await source.destroyWorkspace(materialized.bundle.directory);
        cleanup.delete(materialized.bundle.directory);
      }
    } catch (error) {
      if (error instanceof GitHubAccessError) {
        await cancelPull(identity.repositoryId, identity.pullNumber, 'access_revoked');
      } else if (!signal.aborted) {
        try {
          check();
          const failure = z.object({ status: z.number().optional(), response: z.object({ headers: z.record(z.string(), z.unknown()) }).optional() }).safeParse(error);
          if (error instanceof ConfigurationError) settle('intervention', 'configuration_failure');
          else if (failure.success && failure.data.status === 401) settle('intervention', 'authentication_failure');
          else {
            const headers = failure.success ? failure.data.response?.headers ?? {} : {};
            const reset = z.coerce.number().int().nonnegative().safeParse(headers['x-ratelimit-reset']);
            const after = z.coerce.number().nonnegative().safeParse(headers['retry-after']);
            const resetAt = Math.max(reset.success ? reset.data * 1000 : 0, after.success ? options.now() + after.data * 1000 : 0);
            retry(store.startPass(identity, 'stage_failure', owner()), 'temporary_stage_failure', resetAt);
          }
        }
        catch { controller.abort(); }
      }
    } finally {
      clearInterval(timer);
      if (manifest) {
        cleanup.add(manifest.workspace);
        try { await source.destroyWorkspace(manifest.workspace); cleanup.delete(manifest.workspace); }
        catch { blocked = true; }
      }
      if (cleanup.size) blocked = true;
    }
  }

  async function tick(now: number): Promise<void> {
    timestampSchema.parse(now);
    if (active || blocked) return;
    recoverExpiredLeases(now);
    const claim = store.claim(now);
    if (!claim) return;
    const controller = new AbortController();
    active = { claim, controller };
    try { await run(claim, controller); }
    finally { active = null; }
  }
  return { tick, cancelPull, recoverExpiredLeases, recoverWorker, get recoveryRequired() { return blocked; } };
}
