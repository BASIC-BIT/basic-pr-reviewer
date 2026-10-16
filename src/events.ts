import { randomUUID } from 'node:crypto';
import { Webhooks } from '@octokit/webhooks';
import { z } from 'zod';
import { livePullSchema, timestampSchema } from './contracts.js';
import type { LivePull, RepoPolicy, Store, WebhookAdmission } from './contracts.js';
import { GitHubAccessError } from './github.js';
import type { GitHubPort } from './github.js';
import { ConfigurationError, loadPolicy } from './policy.js';
import { StaleAdmissionObservationError } from './store.js';

export type WebhookHeaders = Record<string, string | undefined>;
export const RECONCILIATION_INTERVAL_MS = 15 * 60 * 1000;
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String);
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const actorSchema = z.object({ login: z.string().min(1), type: z.enum(['User', 'Bot', 'Mannequin']) });
type Actor = z.infer<typeof actorSchema>;
type Context = {
  installationId: string; repositoryId: string; pullNumber: number; deliveryId: string;
  actor: Actor | null; kind: 'automatic' | 'rerun' | 'base' | 'reconcile';
  action: string; label: string | null; commandKey: string | null; checkRunId: string | null;
};
const ignored = (reason: string): WebhookAdmission => ({ kind: 'ignored', reason });
const protectedReasons = new Set(['skipped', 'disabled', 'base_changed', 'retarget', 'access_revoked']);

function ineligible(pull: LivePull, policy: RepoPolicy, actor: Actor | null): string | null {
  if (!policy.enabled) return 'disabled';
  if (!policy.baseBranches.includes(pull.baseRef)) return 'base_branch';
  if (policy.skipLabels.some((label) => pull.labels.includes(label))) return 'skipped';
  if (pull.author.type !== 'User' && !policy.allowBotAuthors) return 'bot_author';
  if (actor && actor.type !== 'User' && !policy.allowedBotActors.includes(actor.login)) return 'bot_actor';
  return null;
}

export function createAdmissionService(options: {
  store: Store; github: GitHubPort; webhookSecret: string; appId: string;
  ownerIds: string[]; runtimeHash: string;
}) {
  const { store, github } = options;
  if (!options.webhookSecret) throw new Error('A webhook signing secret is required');
  z.string().regex(/^[0-9a-f]{64}$/).parse(options.runtimeHash);
  const verifier = new Webhooks({ secret: options.webhookSecret });
  const known = new Set<string>();
  const owners = new Set(options.ownerIds);

  async function verifyInstallation(installationId: string): Promise<void> {
    const installed = await github.assertInstallation(installationId);
    if (!owners.has(installed.ownerId)) throw new Error('Unapproved installation owner');
    known.add(installationId);
  }
  async function installationInventory(): Promise<Set<string>> {
    return new Set([...known, ...store.trackedInstallations(), ...await github.listInstallations()]);
  }

  async function processPull(context: Context): Promise<WebhookAdmission> {
    for (let retry = 0; retry < 3; retry++) {
      // Observe before *both* live identity and policy reads. Revocation has its own clock.
      const observed = store.observation(context.repositoryId, context.pullNumber);
      let accessGeneration = store.accessGeneration();
      try {
        await verifyInstallation(context.installationId);
        const pull = livePullSchema.parse(await github.readLivePull(context.installationId, context.repositoryId, context.pullNumber));
        if (pull.installationId !== context.installationId || pull.repositoryId !== context.repositoryId || pull.pullNumber !== context.pullNumber) throw new Error('Live pull identity mismatch');
        if (!owners.has(pull.ownerId)) throw new GitHubAccessError(context.installationId, context.repositoryId);
        accessGeneration = store.restoreAccess(context.installationId, context.repositoryId, accessGeneration);
        function cancel(reason: string): WebhookAdmission {
          if (store.accessGeneration() !== accessGeneration) throw new StaleAdmissionObservationError();
          store.invalidatePull(context.repositoryId, context.pullNumber, observed.generation, reason, pull.headSha, pull.baseRef);
          return { kind: 'cancelled', reason };
        }
        if (context.kind === 'base') {
          if (pull.baseRef !== context.action) return ignored('unrelated_base');
          return cancel('base_changed');
        }
        if (pull.state === 'closed') return cancel('closed');
        if (pull.draft) return cancel('draft');
        if (pull.headRepositoryId !== pull.repositoryId || pull.baseRepositoryId !== pull.repositoryId) return cancel('fork');
        if (observed.observedBaseRef !== null && observed.observedBaseRef !== pull.baseRef) return cancel('retarget');
        const current = store.current(context.repositoryId, context.pullNumber);
        if (context.kind !== 'rerun' && current && current.identity.headSha === pull.headSha &&
          (current.identity.baseSha !== pull.baseSha || current.identity.mergeBaseSha !== pull.mergeBaseSha)) return cancel('base_changed');
        let trusted;
        try { trusted = await loadPolicy(github, pull); }
        catch (error) {
          if (!(error instanceof ConfigurationError)) throw error;
          cancel('configuration_failure');
          return { kind: 'configuration_failure', reason: error.message };
        }
        const reason = ineligible(pull, trusted.policy, context.actor);
        if (reason) return cancel(reason);
        if (context.kind === 'reconcile' && observed.blockedReason === 'bot_actor' && observed.observedHeadSha === pull.headSha) return ignored('waiting_for_authorized_actor');
        if (context.kind === 'automatic') {
          if (context.action === 'labeled' || context.action === 'unlabeled') {
            if (!context.label || !trusted.policy.skipLabels.includes(context.label)) return ignored('irrelevant_label');
            if (context.action === 'unlabeled' && !trusted.policy.rerunOnUnskip) {
              if (observed.blockedReason !== 'skipped' || observed.observedHeadSha !== pull.headSha) cancel('skipped');
              return ignored('unskip_requires_head_or_rerun');
            }
          } else if (!['opened', 'ready_for_review', 'synchronize', 'reopened'].includes(context.action)) {
            return ignored('lifecycle_currently_eligible');
          }
        }
        if (context.kind === 'rerun') {
          if (!context.actor || context.actor.type !== 'User') return ignored('human_rerun_required');
          if (!['write', 'maintain', 'admin'].includes(await github.readPermission(pull, context.actor.login))) return ignored('write_permission_required');
          if (context.checkRunId) {
            const check = await github.readCheckRun(pull, context.checkRunId);
            if (check.appId !== options.appId || check.headSha !== pull.headSha || !check.pullNumbers.includes(pull.pullNumber)) return ignored('unrelated_check_run');
          }
        } else if (observed.blockedReason && protectedReasons.has(observed.blockedReason) && observed.observedHeadSha === pull.headSha &&
          !(context.action === 'unlabeled' && trusted.policy.rerunOnUnskip)) {
          return ignored('waiting_for_head_or_rerun');
        }
        if (store.observation(context.repositoryId, context.pullNumber).generation !== observed.generation || store.accessGeneration() !== accessGeneration) throw new StaleAdmissionObservationError();
        const admitted = store.admit({ schemaVersion: 1, deliveryId: context.commandKey ?? context.deliveryId,
          receivedAt: Date.now(), expectedGeneration: observed.generation, expectedAccessGeneration: accessGeneration,
          trigger: context.kind === 'rerun' ? { kind: 'rerun', sequence: observed.rerunSequence + 1 } : { kind: 'automatic' },
          identity: { installationId: pull.installationId, repositoryId: pull.repositoryId, owner: pull.owner, repo: pull.repo,
            pullNumber: pull.pullNumber, headSha: pull.headSha, baseRef: pull.baseRef, baseSha: pull.baseSha,
            mergeBaseSha: pull.mergeBaseSha, policyHash: trusted.policyHash, runtimeHash: options.runtimeHash } });
        return { kind: admitted.kind === 'created' ? 'admitted' : 'duplicate', attemptId: admitted.identity.attemptId };
      } catch (error) {
        if (error instanceof StaleAdmissionObservationError && retry < 2) continue;
        if (error instanceof GitHubAccessError) store.setAccess(context.installationId, error.repositoryId, false);
        throw error;
      }
    }
    throw new Error('Admission retries exhausted');
  }

  async function admitWebhook(headers: WebhookHeaders, body: Buffer): Promise<WebhookAdmission> {
    if (body.length > 30 * 1024 * 1024) throw new Error('Webhook body exceeds size limit');
    const signature = headers['x-hub-signature-256'];
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    let valid = false;
    try { valid = typeof signature === 'string' && await verifier.verify(text, signature); } catch { /* Reject malformed signatures. */ }
    if (!valid) throw new Error('Invalid webhook signature');
    const deliveryId = z.string().min(1).max(200).parse(headers['x-github-delivery']);
    const event = z.string().min(1).parse(headers['x-github-event']);
    const replay = store.receipt(deliveryId);
    if (replay) return 'attemptId' in replay ? { kind: 'duplicate', attemptId: replay.attemptId } : replay;
    const raw: unknown = JSON.parse(text);
    const common = z.object({ installation: z.object({ id }), action: z.string().optional() }).parse(raw);
    const installationId = common.installation.id;
    let result: WebhookAdmission;
    if (event === 'installation' || event === 'installation_repositories') {
      const owner = z.object({ installation: z.object({ account: z.object({ id }) }) }).parse(raw).installation.account.id;
      if (!owners.has(owner)) throw new Error('Unapproved installation owner');
      const lifecycle = z.object({ action: z.string(), repositories_removed: z.array(z.object({ id })).optional(),
        repositories_added: z.array(z.object({ id })).optional() }).parse(raw);
      if (event === 'installation' && ['deleted', 'suspend'].includes(lifecycle.action)) {
        store.setAccess(installationId, null, false);
        result = { kind: 'cancelled', reason: 'installation_revoked' };
      } else if (event === 'installation_repositories' && lifecycle.action === 'removed') {
        const removed = lifecycle.repositories_removed;
        if (!removed?.length) throw new Error('Missing removed repository IDs');
        for (const repo of removed) store.setAccess(installationId, repo.id, false);
        result = { kind: 'cancelled', reason: 'repository_removed' };
      } else if ((event === 'installation' && ['created', 'unsuspend'].includes(lifecycle.action)) || (event === 'installation_repositories' && lifecycle.action === 'added')) {
        await verifyInstallation(installationId);
        if (event === 'installation') store.setAccess(installationId, null, true);
        else {
          const installed = await github.listRepositories(installationId);
          if (!lifecycle.repositories_added?.length) throw new Error('Missing added repository IDs');
          for (const repo of lifecycle.repositories_added) {
            if (installed.some((value) => value.repositoryId === repo.id)) store.setAccess(installationId, repo.id, true);
          }
        }
        result = ignored('installation_updated');
      } else result = ignored('unhandled_installation_action');
    } else {
      const meta = z.object({ repository: z.object({ id }), sender: actorSchema }).parse(raw);
      const repositoryId = meta.repository.id;
      const base = { installationId, repositoryId, deliveryId, actor: meta.sender, action: common.action ?? '',
        label: null, commandKey: null, checkRunId: null };
      if (event === 'pull_request') {
        const value = z.object({ action: z.string(), number, pull_request: z.object({ number }), label: z.object({ name: z.string() }).optional() }).parse(raw);
        if (value.number !== value.pull_request.number) throw new Error('Webhook pull number mismatch');
        result = await processPull({ ...base, kind: 'automatic', pullNumber: value.number, label: value.label?.name ?? null });
      } else if (event === 'issue_comment') {
        const value = z.object({ action: z.string(), issue: z.object({ number, pull_request: z.object({}).optional() }),
          comment: z.object({ id, body: z.string(), user: actorSchema }) }).parse(raw);
        if (value.action !== 'created' || !value.issue.pull_request || value.comment.body.trim() !== '/claude-review rerun' || value.comment.user.type !== 'User') result = ignored('not_a_rerun_command');
        else result = await processPull({ ...base, actor: value.comment.user, kind: 'rerun', pullNumber: value.issue.number, commandKey: `comment:${repositoryId}:${value.comment.id}` });
      } else if (event === 'check_run') {
        const value = z.object({ action: z.string(), check_run: z.object({ id, app: z.object({ id }), pull_requests: z.array(z.object({ number })) }) }).parse(raw);
        const target = value.check_run.pull_requests[0];
        if (value.action !== 'rerequested' || value.check_run.app.id !== options.appId || value.check_run.pull_requests.length !== 1 || !target) result = ignored('unrelated_check_run');
        else result = await processPull({ ...base, kind: 'rerun', pullNumber: target.number, checkRunId: value.check_run.id });
      } else if (event === 'push') {
        const value = z.object({ ref: z.string().min(1) }).parse(raw);
        if (!value.ref.startsWith('refs/heads/')) result = ignored('not_a_branch_push');
        else {
          await verifyInstallation(installationId);
          const pulls = await github.listOpenPulls(installationId, repositoryId);
          let cancelled = false;
          for (const pullNumber of pulls) {
            const outcome = await processPull({ ...base, kind: 'base', action: value.ref.slice('refs/heads/'.length), pullNumber });
            cancelled ||= outcome.kind === 'cancelled';
          }
          result = cancelled ? { kind: 'cancelled', reason: 'base_changed' } : ignored('no_matching_pulls');
        }
      } else result = ignored('unsubscribed_event');
    }
    // The caller may now send HTTP acknowledgement. There is no inference call in this path.
    store.acknowledge(deliveryId, result);
    return result;
  }

  async function reconcilePull(repositoryId: string, pullNumber: number): Promise<void> {
    // Resolve repository ownership through the App's current approved-owner inventory.
    for (const installationId of await installationInventory()) {
      let repositories;
      try { repositories = await github.listRepositories(installationId); }
      catch (error) {
        if (error instanceof GitHubAccessError) store.setAccess(installationId, error.repositoryId, false);
        throw error;
      }
      if (!repositories.some((repo) => repo.repositoryId === repositoryId)) {
        if (store.trackedPulls(installationId).some((pull) => pull.repositoryId === repositoryId)) {
          store.setAccess(installationId, repositoryId, false);
          throw new Error('Repository access revoked');
        }
        continue;
      }
      await processPull({ installationId, repositoryId, pullNumber, deliveryId: `reconcile:${randomUUID()}`,
        actor: null, kind: 'reconcile', action: '', label: null, commandKey: null, checkRunId: null });
      return;
    }
    throw new Error('Repository is not installed');
  }
  async function reconcileInstalled(): Promise<void> {
    for (const installationId of await installationInventory()) {
      try {
        const installed = await github.listRepositories(installationId);
        const tracked = store.trackedPulls(installationId);
        for (const pull of tracked) {
          if (!installed.some((repo) => repo.repositoryId === pull.repositoryId)) store.setAccess(installationId, pull.repositoryId, false);
        }
        for (const repo of installed) {
          const open = await github.listOpenPulls(installationId, repo.repositoryId);
          const numbers = new Set([...open, ...tracked.filter((pull) => pull.repositoryId === repo.repositoryId).map((pull) => pull.pullNumber)]);
          for (const pullNumber of numbers) {
            await processPull({ ...repo, pullNumber, deliveryId: `reconcile:${randomUUID()}`,
              actor: null, kind: 'reconcile', action: '', label: null, commandKey: null, checkRunId: null });
          }
        }
      } catch (error) {
        if (error instanceof GitHubAccessError) {
          store.setAccess(installationId, error.repositoryId, false);
          continue;
        }
        throw error;
      }
    }
  }
  function retryAfter(error: unknown, now = Date.now()): number | null {
    const parsed = z.object({ status: z.number(), rateLimited: z.boolean().optional(),
      response: z.object({ headers: z.record(z.string(), z.unknown()) }) }).safeParse(error);
    if (!parsed.success || ![403, 429].includes(parsed.data.status)) return null;
    const headers = parsed.data.response.headers;
    if (typeof headers['retry-after'] === 'string' && Number.isFinite(Number(headers['retry-after']))) return Math.max(1000, Number(headers['retry-after']) * 1000);
    if (headers['x-ratelimit-remaining'] === '0' && typeof headers['x-ratelimit-reset'] === 'string') return Math.max(1000, Number(headers['x-ratelimit-reset']) * 1000 - now);
    return parsed.data.status === 429 || parsed.data.rateLimited ? 60_000 : null;
  }
  // Startup and recurring execution stay serial. The host owns shutdown and the alarm.
  function startReconciliation(onError: (error: unknown) => void): () => void {
    let stopped = false;
    let rateLimitFailures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function run() {
      let delay = RECONCILIATION_INTERVAL_MS;
      try { await reconcileInstalled(); rateLimitFailures = 0; }
      catch (error) {
        onError(error);
        const limited = retryAfter(error);
        rateLimitFailures = limited === null ? 0 : Math.min(rateLimitFailures + 1, 5);
        if (limited !== null) delay = Math.max(limited, Math.min(RECONCILIATION_INTERVAL_MS, 60_000 * 2 ** (rateLimitFailures - 1)));
      }
      if (!stopped) { timer = setTimeout(() => { void run(); }, timestampSchema.parse(delay)); timer.unref(); }
    }
    void run();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }
  return { admitWebhook, reconcilePull, reconcileInstalled, startReconciliation };
}
