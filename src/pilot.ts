import { z } from 'zod';
import { reviewIdentitySchema, livePullSchema } from './contracts.js';
import type { Store, LivePull } from './contracts.js';
import type { GitHubPort } from './github.js';
import { loadPolicy } from './policy.js';
import { createScheduler } from './scheduler.js';
import type { SchedulerOptions } from './scheduler.js';
import { createPublisher } from './publisher.js';
import { profile, createWorker } from './worker.js';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, lstat, realpath, open, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { assertFlock, runtimeConfigSchema, createPauseState, loadSecret } from './runtime.js';
import { verifyRelease } from './release.js';
import { createGitHubAdapter } from './github.js';
import { openStore } from './store.js';
import { createSourceService } from './source.js';

export const pilotRequestSchema = z.strictObject({
  identity: reviewIdentitySchema,
  coreRevision: z.string().regex(/^[0-9a-f]{40}$/), coreHash: z.string().regex(/^[0-9a-f]{64}$/),
  maxTicks: z.number().int().min(1).max(1000), maxElapsedMs: z.number().int().min(1).max(24 * 60 * 60 * 1000),
});
type PilotRequest = z.infer<typeof pilotRequestSchema>;
type Intent = { credentials: boolean; inference: boolean; publication: boolean };
type Components = { github: GitHubPort; source: SchedulerOptions['source']; worker: SchedulerOptions['worker'];
  ownerIds: string[]; coreRevision: string; coreHash: string };
export type PilotOptions = {
  acquireOwnership: () => Promise<() => Promise<void>>;
  requirePaused: () => Promise<void>;
  openStore: () => Promise<{ store: Store; close: () => void }>;
  open: () => Promise<Components>; now?: () => number; signal?: AbortSignal;
};
const sameIdentity = (a: PilotRequest['identity'], b: PilotRequest['identity']) =>
  Object.entries(a).every(([key, value]) => b[key as keyof typeof b] === value);

// The caller supplies the same production lock and stopped-service check as the supervisor.
export async function runPilot(input: unknown, intent: Intent, options: PilotOptions) {
  const request = pilotRequestSchema.parse(input), target = request.identity;
  if (!intent.credentials || !intent.inference || typeof intent.publication !== 'boolean') throw new Error('pilot_intent_required');
  const release = await options.acquireOwnership();
  let ledger: Awaited<ReturnType<PilotOptions['openStore']>> | undefined;
  let scheduler: ReturnType<typeof createScheduler> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const now = options.now ?? Date.now, started = now();
  let expired = false, ticks = 0, passes = 0;
  const stop = () => { expired = true; scheduler?.stop(); };
  options.signal?.addEventListener('abort', stop, { once: true });
  const publications: { status: string; reason: string | null }[] = [];
  try {
    await options.requirePaused();
    ledger = await options.openStore();
    const { store } = ledger;
    function bound() { if (expired || options.signal?.aborted || now() - started >= request.maxElapsedMs) throw new Error('pilot_deadline'); }
    function admitted() {
      const current = store.current(target.repositoryId, target.pullNumber);
      if (!current || !sameIdentity(target, current.identity) || current.state === 'superseded' || current.state === 'leased' ||
        store.observation(target.repositoryId, target.pullNumber).blockedReason || !store.accessAllowed(target.installationId, target.repositoryId)) throw new Error('pilot_admission_mismatch');
      for (const installation of store.trackedInstallations()) for (const pull of store.trackedPulls(installation)) {
        const other = store.current(pull.repositoryId, pull.pullNumber);
        if (other && !sameIdentity(target, other.identity) && (other.state === 'queued' || other.state === 'leased')) throw new Error('pilot_other_work');
      }
      return current;
    }
    admitted(); bound();
    const components = await options.open();
    const { github, worker, source } = components;
    if (components.coreRevision !== request.coreRevision || components.coreHash !== request.coreHash || worker.runtimeHash !== target.runtimeHash) throw new Error('pilot_release_mismatch');
    async function trusted(pull: LivePull) {
      bound();
      const installation = await github.assertInstallation(target.installationId);
      if (!components.ownerIds.includes(installation.ownerId) || !components.ownerIds.includes(pull.ownerId)) throw new Error('pilot_owner_mismatch');
      for (const key of ['installationId', 'repositoryId', 'owner', 'repo', 'pullNumber', 'headSha', 'baseRef', 'baseSha', 'mergeBaseSha'] as const) {
        if (pull[key] !== target[key]) throw new Error('pilot_target_changed');
      }
      if (await github.readDefaultBranch(target.installationId, target.repositoryId) !== target.baseRef) throw new Error('pilot_default_required');
      const policy = await loadPolicy(github, pull);
      if (policy.policyHash !== target.policyHash || !policy.policy.enabled || !policy.policy.baseBranches.includes(pull.baseRef) ||
        pull.state !== 'open' || pull.draft || pull.headRepositoryId !== target.repositoryId || pull.baseRepositoryId !== target.repositoryId ||
        policy.policy.skipLabels.some(label => pull.labels.includes(label)) || pull.author.type !== 'User' && !policy.policy.allowBotAuthors) throw new Error('pilot_policy_changed');
      bound(); return policy;
    }
    async function readCurrent(identity: PilotRequest['identity'], signal: AbortSignal) {
      bound(); signal.throwIfAborted();
      if (!sameIdentity(target, identity)) throw new Error('pilot_target_mismatch');
      const pull = livePullSchema.parse(await github.readLivePull(target.installationId, target.repositoryId, target.pullNumber));
      return { pull, trusted: await trusted(pull) };
    }
    await readCurrent(target, new AbortController().signal);
    scheduler = createScheduler({ store, source, now, readCurrent,
      worker: { ...worker, async runPass(identity, spec, signal, guard) {
        bound(); if (passes >= request.maxTicks) throw new Error('pilot_work_limit');
        await readCurrent(identity, signal); passes++;
        return worker.runPass(identity, spec, signal, guard);
      } } });
    deadline = setTimeout(stop, Math.max(1, request.maxElapsedMs - (now() - started)));
    deadline.unref();
    await scheduler.recoverWorker();
    const publisher = intent.publication ? createPublisher({ store, github, readPolicy: trusted, engineRevision: request.coreRevision,
      operatorCommand: 'reviewer inspect', notify: () => {}, beforeWrite: async destination => {
        bound(); admitted();
        if (Object.entries(destination).some(([key, value]) => target[key as keyof typeof target] !== value)) throw new Error('pilot_publication_target_changed');
        await readCurrent(target, new AbortController().signal);
      } }) : null;
    for (; ticks < request.maxTicks && !expired && now() - started < request.maxElapsedMs;) {
      const current = admitted();
      await readCurrent(target, new AbortController().signal);
      if (current.state !== 'queued' || current.nextAttemptAt > now()) break;
      ticks++; await scheduler.tick(now());
      if (scheduler.recoveryRequired) break;
    }
    // Shadow intents remain in the production ledger, but no publisher runs without explicit intent.
    if (publisher && !expired && now() - started < request.maxElapsedMs) {
      admitted(); await readCurrent(target, new AbortController().signal);
      for (const record of store.publications(target.repositoryId, target.pullNumber)) {
        bound();
        if (record.state === 'planned' && sameIdentity(record.intent.identity, target) && store.publicationFenceCurrent({ kind: 'review', publicationId: record.id })) {
          publications.push(await publisher.reconcilePublication(record));
        }
      }
    }
    if (expired) { store.interruptLeases(now()); scheduler.recoverExpiredLeases(now()); }
    const current = store.current(target.repositoryId, target.pullNumber), result = current?.result;
    const records = current?.passes ?? [];
    const currentPublications = new Set(store.publications(target.repositoryId, target.pullNumber)
      .filter(record => record.state === 'planned' && sameIdentity(record.intent.identity, target) && store.publicationFenceCurrent({ kind: 'review', publicationId: record.id }))
      .map(record => record.id));
    return {
      mode: intent.publication ? 'publication' : 'shadow', identity: target, coreRevision: request.coreRevision, coreHash: request.coreHash,
      bounds: { maxTicks: request.maxTicks, maxElapsedMs: request.maxElapsedMs, maxTurnsPerPass: profile.maxTurns, maxPassMs: profile.timeoutMs },
      elapsedMs: now() - started, ticks, executedPasses: passes, deadlineReached: expired || now() - started >= request.maxElapsedMs,
      state: current?.state ?? 'UNKNOWN', reason: current?.interventionReason ?? null, nextEligibleAt: current?.nextAttemptAt ?? 'UNKNOWN', cleanupRequired: scheduler.recoveryRequired,
      coverage: result ? { complete: result.complete, eligibleFiles: result.reviewUnits ? new Set(result.reviewUnits.map(unit => unit.path.bytesBase64)).size : 'UNKNOWN',
        coveredUnits: result.coveredUnitIds.length, missingUnits: result.missingUnitIds.length, reusedUnits: result.reusedUnitIds.length,
        integrationStatus: result.integrationStatus, exclusions: result.exclusions.length, missingScope: result.missingScope.length, findings: result.findings.length } : null,
      passes: records.map(record => ({ id: record.spec.id, kind: record.spec.kind, status: record.outcome.status, failureCode: record.outcome.failureCode,
        usage: record.outcome.usage, model: record.outcome.model })),
      publications: intent.publication ? store.publicationOperations(target.repositoryId, target.pullNumber)
        .filter(record => record.fence.kind === 'review' && currentPublications.has(record.fence.publicationId))
        .map(record => ({ key: record.key, channel: record.channel, state: record.state, remoteId: record.remoteId })) : [],
      publicationOutcomes: publications, pendingIntents: currentPublications.size,
      turns: 'UNKNOWN', quotaRemaining: 'UNKNOWN', workerPeakMemoryBytes: 'UNKNOWN', supervisorPeakRssBytes: process.resourceUsage().maxRSS * 1024,
      normalExecutionPaused: true,
    };
  } finally {
    if (deadline) clearTimeout(deadline);
    options.signal?.removeEventListener('abort', stop);
    scheduler?.stop();
    try { if (scheduler) { await scheduler.recoverWorker(); ledger?.store.interruptLeases(now()); scheduler.recoverExpiredLeases(now()); } }
    finally { try { ledger?.close(); } finally { await release(); } }
  }
}

export async function runPilotCli(args: string[]): Promise<void> {
  const [requestPath, reportPath, ...flags] = args;
  const allowed = new Set(['--allow-credentials', '--allow-inference', '--allow-publication', '--shadow', '--drained', '--locked']);
  if (!requestPath || !reportPath || flags.some(flag => !allowed.has(flag)) || new Set(flags).size !== flags.length ||
    !flags.includes('--allow-credentials') || !flags.includes('--allow-inference') || !flags.includes('--drained') ||
    Number(flags.includes('--allow-publication')) + Number(flags.includes('--shadow')) !== 1) throw new Error('pilot_arguments_required');
  if (process.platform !== 'linux' || process.getuid?.() !== 1000) throw new Error('linux_uid1000_required');
  // Fixed production paths prevent an alternate state directory from evading host-wide worker ownership.
  const root = '/var/lib/basic-pr-reviewer', configPath = '/etc/basic-pr-reviewer/config.json';
  if (process.env.REVIEWER_CONFIG && process.env.REVIEWER_CONFIG !== configPath) throw new Error('pilot_production_config_required');
  const rootInfo = await lstat(root), configInfo = await lstat(configPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(root) !== root || rootInfo.uid !== 1000 || (rootInfo.mode & 0o077) !== 0 ||
    !configInfo.isFile() || configInfo.isSymbolicLink() || configInfo.uid !== 0 || (configInfo.mode & 0o022) !== 0) throw new Error('pilot_unsafe_host_paths');
  const config = runtimeConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  if (config.stateDirectory !== root) throw new Error('pilot_production_state_required');
  const request = pilotRequestSchema.parse(JSON.parse(await readFile(requestPath, 'utf8')));
  const lockPath = join(root, 'service.lock');
  process.umask(0o077);
  if (!flags.includes('--locked')) {
    process.exitCode = await new Promise<number>((resolveExit, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '--no-fork', lockPath, process.execPath, fileURLToPath(import.meta.url), ...args, '--locked'], { stdio: 'inherit' });
      const forward = () => child.kill('SIGTERM'); process.once('SIGINT', forward); process.once('SIGTERM', forward);
      child.once('error', reject); child.once('exit', code => { process.off('SIGINT', forward); process.off('SIGTERM', forward); resolveExit(code ?? 1); });
    });
    return;
  }
  let client: SecretsManagerClient | undefined;
  let report: unknown;
  await assertFlock(lockPath);
  const output = await open(resolve(reportPath), 'wx', 0o600);
  const cancellation = new AbortController(), stop = () => cancellation.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const outcome = await runPilot(request, { credentials: true, inference: true, publication: flags.includes('--allow-publication') }, {
      signal: cancellation.signal,
      acquireOwnership: async () => { await assertFlock(lockPath); return async () => {}; },
      requirePaused: async () => {
        const state = execFileSync('systemctl', ['show', 'basic-pr-reviewer.service', '--property=ActiveState', '--value'], { encoding: 'utf8', timeout: 10000 }).trim();
        if (state !== 'inactive') throw new Error('pilot_stopped_service_required');
        await lstat(join(root, 'pause.json'));
        if (!await createPauseState(root, true).read()) throw new Error('pilot_paused_required');
      },
      openStore: async () => { const store = openStore(join(root, 'ledger.sqlite')); return { store, close: () => store.close() }; },
      open: async () => {
        const release = await verifyRelease(dirname(dirname(fileURLToPath(import.meta.url))), resolve(config.releaseManifest));
        if (release.coreRevision !== request.coreRevision || release.coreHash !== request.coreHash) throw new Error('pilot_release_mismatch');
        client = new SecretsManagerClient({ region: config.region, maxAttempts: 3, requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 } });
        const github = createGitHubAdapter({ appId: config.appId, privateKey: await loadSecret(client, config.privateKey), ownerIds: config.ownerIds });
        const workerRoot = join(root, 'workers'); await mkdir(workerRoot, { recursive: true, mode: 0o700 });
        const worker = await createWorker({ release, workerImage: release.workerImage, proxyImage: release.proxyImage, temporaryRoot: workerRoot,
          oauthToken: () => loadSecret(client!, config.oauthToken) });
        const source = await createSourceService({ root: join(root, 'source'), credential: identity => github.installationCredential(identity) });
        return { github, worker, source, ownerIds: config.ownerIds, coreRevision: release.coreRevision, coreHash: release.coreHash };
      },
    });
    report = outcome;
    if (outcome.deadlineReached || outcome.cleanupRequired) process.exitCode = 1;
  } catch {
    process.exitCode = 1;
    report = { mode: flags.includes('--allow-publication') ? 'publication' : 'shadow', identity: request.identity,
      coreRevision: request.coreRevision, coreHash: request.coreHash, status: 'REFUSED_OR_INTERRUPTED',
      outcome: 'UNKNOWN', message: 'Inspect private ledger and host state before retrying. Raw diagnostics withheld.' };
  } finally { client?.destroy(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  try { await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); }
  finally { await output.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runPilotCli(process.argv.slice(2)); }
  catch { process.stderr.write('Pilot refused. Check explicit intent, production ownership and private inputs.\n'); process.exitCode = 1; }
}
