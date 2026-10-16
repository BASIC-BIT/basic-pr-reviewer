import { createHash } from 'node:crypto';
import { z } from 'zod';
import { livePullSchema, publicationTargetSchema, reviewResultSchema } from './contracts.js';
import type { Finding, LivePull, PublicationFence, PublicationNotice, PublicationOperation, PublicationOutcome, PublicationRecord, PublicationTarget, ReviewIdentity, ReviewResult, Store, TrustedPolicy } from './contracts.js';
import { GitHubAccessError, GitHubPermissionError } from './github.js';
import type { CheckPublication, InlineComment, PublicationGitHubPort } from './github.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const marker = (key: string) => `<!-- subscription-review:${key} -->`;
const sticky = '<!-- subscription-review:summary -->';
const findingMarker = (id: string) => `<!-- subscription-finding:${hash(id)} -->`;
const progressSchema = z.object({ state: z.enum(['queued', 'leased', 'complete', 'incomplete', 'intervention']),
  reason: z.string().nullable(), nextAttemptAt: z.number(), result: reviewResultSchema.nullable() });
class StalePublication extends Error {}
class PendingPublication extends Error {}

// Model prose is plain text. Only service-generated source links are clickable.
export function sanitizeText(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/https?:\/\/[^\s<>\])]+/gi, '[link removed]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/@/g, '(at)')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~])/g, '\\$1');
}
function decodePath(path: Finding['location']['path']): string | null {
  if (!path) return null;
  try {
    const bytes = Buffer.from(path.bytesBase64, 'base64'), decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(decoded).equals(bytes) || /[\x00-\x1f\x7f]/.test(decoded) || decoded.startsWith('/') ||
      decoded.split('/').some(part => !part || part === '.' || part === '..')) return null;
    return decoded;
  } catch { return null; }
}
function component(value: string): string { return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`); }
function sourceLink(result: ReviewResult, finding: Finding): string {
  const location = finding.location, path = decodePath(location.path);
  if (!path) return 'Source location unavailable.';
  const unit = (result.reviewUnits ?? []).find(unit => finding.evidence.some(evidence => evidence.unitId === unit.id) &&
    (unit.path.bytesBase64 === location.path?.bytesBase64 || unit.oldPath?.bytesBase64 === location.path?.bytesBase64));
  if (!unit) return 'Source location unavailable.';
  const left = location.kind === 'line' && location.side === 'LEFT' || unit.newBlobId === null || unit.oldPath?.bytesBase64 === location.path?.bytesBase64;
  const sha = left ? result.identity.mergeBaseSha : result.identity.headSha;
  return `[Source](https://github.com/${component(result.identity.owner)}/${component(result.identity.repo)}/blob/${sha}/${path.split('/').map(component).join('/')})`;
}
export function findingAnchor(result: ReviewResult, finding: Finding): Omit<InlineComment, 'body'> | null {
  const location = finding.location;
  if (location.kind !== 'line' || !decodePath(location.path)) return null;
  const unit = (result.reviewUnits ?? []).find(unit => {
    const path = location.side === 'LEFT' ? unit.oldPath ?? unit.path : unit.path;
    const lines = location.side === 'LEFT' ? unit.oldLines : unit.newLines;
    return ['text', 'delete'].includes(unit.kind) && finding.evidence.some(evidence => evidence.unitId === unit.id) &&
      path.bytesBase64 === location.path.bytesBase64 && lines.count > 0 && location.startLine >= lines.start && location.endLine < lines.start + lines.count;
  });
  if (!unit) return null;
  // GitHub uses the diff filename, including LEFT comments on a renamed file.
  const path = decodePath(unit.path); if (!path) return null;
  return { path, side: location.side, line: location.endLine,
    ...(location.startLine === location.endLine ? {} : { start_line: location.startLine, start_side: location.side }) };
}
function chunks(text: string, limit: number): string[] {
  const result: string[] = []; let current = '', bytes = 0;
  for (const char of text) { const size = Buffer.byteLength(char); if (bytes + size > limit) { result.push(current); current = ''; bytes = 0; } current += char; bytes += size; }
  if (current) result.push(current); return result;
}
function compatible(a: ReviewIdentity, b: ReviewIdentity): boolean {
  const { generation: _ag, attemptId: _aa, ...x } = a, { generation: _bg, attemptId: _ba, ...y } = b;
  return same(x, y);
}
function destination(identity: PublicationTarget): PublicationTarget {
  return { installationId: identity.installationId, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repo,
    pullNumber: identity.pullNumber, headSha: identity.headSha, baseRef: identity.baseRef, baseSha: identity.baseSha, mergeBaseSha: identity.mergeBaseSha };
}

export function createPublisher(options: {
  store: Store; github: PublicationGitHubPort;
  readPolicy: (pull: LivePull) => Promise<Pick<TrustedPolicy, 'policy' | 'policyHash'>>;
  notify: (notice: { repositoryId: string; pullNumber: number; reason: string }) => void;
  engineRevision: string; operatorCommand: string;
}) {
  const { store, github } = options;
  z.string().min(1).max(200).parse(options.engineRevision);
  z.string().regex(/^[a-zA-Z0-9 _./-]+$/).max(200).parse(options.operatorCommand);
  // The host must hold its singleton before constructing this publisher.
  const serial = new Map<string, Promise<PublicationOutcome>>();
  const repairing = new Set<string>();
  function locked(target: PublicationTarget, action: () => Promise<PublicationOutcome>): Promise<PublicationOutcome> {
    const key = `${target.repositoryId}/${target.pullNumber}`;
    const work = (serial.get(key) ?? Promise.resolve()).then(action, action);
    serial.set(key, work); void work.finally(() => { if (serial.get(key) === work) serial.delete(key); }).catch(() => {});
    return work;
  }
  async function guard(target: PublicationTarget, fence: PublicationFence, identity: ReviewIdentity | null): Promise<void> {
    if (!store.publicationFenceCurrent(fence)) throw new StalePublication();
    const clock = store.accessGeneration();
    const pull = livePullSchema.parse(await github.readLivePull(target.installationId, target.repositoryId, target.pullNumber));
    if (!same(destination(pull), destination(target))) throw new StalePublication();
    if (identity) {
      const trusted = await options.readPolicy(pull);
      if (trusted.policyHash !== identity.policyHash || !trusted.policy.enabled || pull.state !== 'open' || pull.draft ||
        pull.headRepositoryId !== target.repositoryId || !trusted.policy.baseBranches.includes(pull.baseRef) ||
        trusted.policy.skipLabels.some(label => pull.labels.includes(label)) || pull.author.type !== 'User' && !trusted.policy.allowBotAuthors) throw new StalePublication();
    }
    if (!store.publicationFenceCurrent(fence) || store.accessGeneration() !== clock) throw new StalePublication();
  }
  function notify(target: PublicationTarget, reason: string) { options.notify({ repositoryId: target.repositoryId, pullNumber: target.pullNumber, reason }); }
  async function mutate(target: PublicationTarget, fence: PublicationFence, identity: ReviewIdentity | null,
    channel: PublicationOperation['channel'], payload: unknown, write: (body: string) => Promise<string>, slot = '0'): Promise<void> {
    await guard(target, fence, identity);
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const key = hash({ fence, target, channel, slot });
    const record = store.planPublicationOperation({ key, fence, target, channel, body });
    if (record.state === 'acknowledged') return;
    const owned = await github.listOwnedPublications(target);
    const found = owned.filter(item => item.channel === channel && item.body.includes(marker(key)) &&
      (channel === 'summary' || item.headSha === target.headSha));
    if (found.length === 1) { store.acknowledgePublication(key, found[0]!.id); await guard(target, fence, identity); return; }
    if (record.state === 'sending' || found.length > 1) { notify(target, 'publication_acknowledgement_uncertain'); throw new PendingPublication(); }
    await guard(target, fence, identity);
    store.markPublicationSending(key);
    let id: string;
    try { id = await write(marker(key)); }
    catch (error) { notify(target, error instanceof GitHubAccessError ? 'publication_access_revoked' : 'publication_acknowledgement_uncertain'); throw error; }
    store.acknowledgePublication(key, id);
    await guard(target, fence, identity);
  }
  async function summaryAndCheck(target: PublicationTarget, fence: PublicationFence, identity: ReviewIdentity | null,
    channel: 'summary' | 'check', body: string, check: Omit<CheckPublication, 'body'>): Promise<void> {
    await guard(target, fence, identity);
    const owned = await github.listOwnedPublications(target), receipts = store.publicationOperations(target.repositoryId, target.pullNumber);
    const previous = owned.find(item => item.channel === channel && (channel !== 'check' || item.headSha === check.headSha) &&
      receipts.some(receipt => receipt.channel === channel && (receipt.remoteId === item.id || item.body.includes(marker(receipt.key)))));
    if (!previous && receipts.some(receipt => receipt.channel === channel && receipt.state === 'sending' &&
      (channel === 'summary' || receipt.target.headSha === target.headSha))) throw new PendingPublication();
    await mutate(target, fence, identity, channel, { body, check }, async operationMarker => {
      const text = `${channel === 'summary' ? sticky + '\n' : ''}${operationMarker}\n${body}`;
      return channel === 'summary' ? github.upsertSummary(target, previous?.id ?? null, text)
        : github.upsertCheck(target, previous?.id ?? null, { ...check, body: text });
    });
  }
  function render(record: PublicationRecord, progress: z.infer<typeof progressSchema>) {
    const { identity } = record.intent, result = progress.result;
    const lines = ['## Subscription review', `Attempt ${identity.attemptId}. Private operator lookup: \`${sanitizeText(options.operatorCommand)} ${identity.attemptId}\`.`,
      `Head \`${identity.headSha}\`. Base ${sanitizeText(identity.baseRef)} \`${identity.baseSha}\`.`,
      `State: ${progress.state}. ${result?.complete ? 'Complete supplied coverage.' : 'Coverage is incomplete or not yet reviewed.'}`,
      `Fresh units: ${(result?.coveredUnitIds.length ?? 0) - (result?.reusedUnitIds.length ?? 0)}. Reused units: ${result?.reusedUnitIds.length ?? 0}. Missing units: ${result?.missingUnitIds.length ?? 0}.`,
      `Engine: ${sanitizeText(options.engineRevision)}. Runtime: \`${identity.runtimeHash}\`. Policy: \`${identity.policyHash}\`.`,
      `Recovery or failure reason: ${sanitizeText(progress.reason ? chunks(progress.reason, 500)[0] ?? 'none' : result?.failureCodes.slice(0, 5).map(code => chunks(code, 100)[0]).join(', ') ?? 'none') || 'none'}.`];
    const label = (path: Finding['location']['path']) => sanitizeText(decodePath(path) ?? 'byte-unsafe or unspecified path');
    const omissions = [...(result?.reviewUnits ?? []).map(unit => `${result?.reusedUnitIds.includes(unit.id) ? 'Reused' : 'Fresh'}: ${label(unit.path)}.`), ...(result?.exclusions ?? []).map(item => `Excluded: ${label(item.path)}, ${sanitizeText(item.code)}.`),
      ...(result?.missingScope ?? []).map(item => `Missing: ${label(item.path)}, ${sanitizeText(item.code)}.`)];
    let omitted = 0;
    for (const line of omissions) { if (Buffer.byteLength(lines.join('\n\n') + line) < 8000) lines.push(line); else omitted++; }
    if (omitted) lines.push(`${omitted} additional scope entries are in the private attempt record.`);
    if (result?.status === 'skipped') lines.push('No eligible scope; no inference was required.');
    if (!result?.findings.length) lines.push(result?.complete ? 'No findings in the supplied scope. This does not prove absence of defects.' : 'No findings reported so far; review is not complete.');
    if (!result?.complete) {
      const prior = store.publications(identity.repositoryId, identity.pullNumber).map(item => ({ item, parsed: progressSchema.safeParse(JSON.parse(item.intent.body)) }))
        .filter(entry => entry.item.intent.channel === 'summary' && compatible(entry.item.intent.identity, identity) &&
          entry.item.intent.identity.attemptId !== identity.attemptId && entry.parsed.success && entry.parsed.data.result?.complete).at(-1);
      if (prior?.parsed.success && prior.parsed.data.result) lines.push(`Prior complete evidence for this same comparison remains available from attempt ${prior.item.intent.identity.attemptId}: ${prior.parsed.data.result.findings.length} findings. The newer attempt above has not replaced that coverage.`);
      if (prior) {
        const receipt = store.publicationOperations(identity.repositoryId, identity.pullNumber).find(operation => operation.channel === 'inline' &&
          operation.fence.kind === 'review' && operation.fence.publicationId === prior.item.id && operation.state === 'acknowledged');
        if (receipt?.remoteId && /^[0-9]+$/.test(receipt.remoteId)) lines.push(`[Prior findings](https://github.com/${component(identity.owner)}/${component(identity.repo)}/pull/${identity.pullNumber}#pullrequestreview-${receipt.remoteId}).`);
      }
    }
    const findingTexts = (result?.findings ?? []).map(finding => `${findingMarker(finding.id)}\n${finding.severity}: ${sanitizeText(finding.message)}\n${sourceLink(result!, finding)}`);
    let included = 0;
    for (const text of findingTexts) { if (Buffer.byteLength(lines.join('\n\n') + text) > 48_000) break; lines.push(text); included++; }
    if (included < findingTexts.length) lines.push(`${findingTexts.length - included} further findings follow in commit-scoped review batches. Every finding is retained in the private attempt record.`);
    return { body: lines.join('\n\n'), findingTexts };
  }
  async function findingAlreadyPublished(identity: ReviewIdentity, findingId: string, part: number): Promise<boolean> {
    const target = destination(identity), intents = store.publications(identity.repositoryId, identity.pullNumber);
    for (const operation of store.publicationOperations(identity.repositoryId, identity.pullNumber)) {
      if (operation.channel !== 'inline' || operation.state === 'planned' || operation.fence.kind !== 'review') continue;
      const publicationId = operation.fence.publicationId;
      const original = intents.find(intent => intent.id === publicationId);
      if (!original || !compatible(original.intent.identity, identity)) continue;
      const payload = z.object({ findingId: z.string(), part: z.number() }).safeParse(JSON.parse(operation.body));
      if (!payload.success || payload.data.findingId !== findingId || payload.data.part !== part) continue;
      const remote = (await github.listOwnedPublications(target)).filter(item => item.channel === 'inline' && item.headSha === target.headSha && item.body.includes(marker(operation.key)));
      if (remote.length === 1) { store.acknowledgePublication(operation.key, remote[0]!.id); return true; }
      throw new PendingPublication();
    }
    return false;
  }
  async function undoResolution(operation: PublicationOperation): Promise<void> {
    const undo = store.planPublicationUndo(operation.key);
    if (undo.state === 'acknowledged') return;
    const thread = (await github.listThreads(operation.target)).find(thread => thread.id === operation.body);
    if (!thread?.owned) throw new PendingPublication();
    if (thread.resolved) await github.unresolveThread(operation.target, thread.id);
    const after = (await github.listThreads(operation.target)).find(thread => thread.id === operation.body);
    if (!after || after.resolved) throw new PendingPublication();
    store.acknowledgePublication(undo.key, operation.body);
    store.acknowledgePublication(operation.key, operation.body);
  }
  async function recoverResolutions(target: PublicationTarget): Promise<void> {
    const operations = store.publicationOperations(target.repositoryId, target.pullNumber);
    for (const operation of operations.filter(item => item.channel === 'resolve' && item.state === 'sending')) {
      const thread = (await github.listThreads(target)).find(thread => thread.id === operation.body);
      if (!thread?.owned) throw new PendingPublication();
      if (thread.hasReplies || !store.publicationFenceCurrent(operation.fence)) await undoResolution(operation);
      else if (thread.resolved) store.acknowledgePublication(operation.key, thread.id);
      // An unresolved thread may be retried only by current complete assessment cleanup.
    }
    for (const operation of operations.filter(item => item.channel === 'unresolve' && item.state === 'sending')) {
      const original = operations.find(item => item.channel === 'resolve' && item.body === operation.body && same(item.fence, operation.fence));
      if (original) await undoResolution(original);
    }
  }
  async function cleanup(result: ReviewResult, fence: PublicationFence): Promise<void> {
    if (!result.complete || result.integrationStatus !== 'completed') return;
    const target = destination(result.identity);
    await recoverResolutions(target);
    const receipts = store.publicationOperations(target.repositoryId, target.pullNumber);
    for (const assessment of result.priorFindingAssessments ?? []) {
      if (assessment.assessment !== 'fixed') continue;
      let threads = await github.listThreads(target);
      for (const candidate of threads) {
        if (!candidate.owned || candidate.resolved || candidate.hasReplies || !candidate.body.includes(findingMarker(assessment.findingId)) ||
          !receipts.some(receipt => {
            if (receipt.channel !== 'inline' || receipt.remoteId !== candidate.reviewId || receipt.state !== 'acknowledged') return false;
            const payload = z.object({ findingId: z.string(), part: z.number() }).safeParse(JSON.parse(receipt.body));
            return payload.success && payload.data.findingId === assessment.findingId && payload.data.part === 0;
          })) continue;
        await guard(target, fence, result.identity);
        threads = await github.listThreads(target);
        const current = threads.find(thread => thread.id === candidate.id);
        if (!current?.owned || current.resolved || current.hasReplies) continue;
        const key = hash({ fence, thread: candidate.id, action: 'resolve' });
        const operation = store.planPublicationOperation({ key, fence, target, channel: 'resolve', body: candidate.id });
        if (operation.state === 'acknowledged') continue;
        await guard(target, fence, result.identity);
        store.markPublicationSending(key);
        await github.resolveThread(target, candidate.id);
        const after = (await github.listThreads(target)).find(thread => thread.id === candidate.id);
        let stale = false; try { await guard(target, fence, result.identity); } catch { stale = true; }
        if (after?.hasReplies || stale) {
          // Compensate only the resolution this operation just made, even if its review became stale.
          await undoResolution(store.publicationOperations(target.repositoryId, target.pullNumber).find(item => item.key === key)!);
          if (stale) throw new StalePublication();
        } else store.acknowledgePublication(key, candidate.id);
      }
    }
  }
  async function reconcile(record: PublicationRecord): Promise<PublicationOutcome> {
    const identity = record.intent.identity, target = destination(identity), fence: PublicationFence = { kind: 'review', publicationId: record.id };
    try {
      await guard(target, fence, identity);
      const saved = store.publications(identity.repositoryId, identity.pullNumber).find(item => item.id === record.id);
      if (!saved || !same(saved, record)) throw new StalePublication();
      const progress = progressSchema.parse(JSON.parse(record.intent.body)), { body, findingTexts } = render(record, progress);
      const check: Omit<CheckPublication, 'body'> = { headSha: identity.headSha,
        status: progress.state === 'queued' ? 'queued' : progress.state === 'leased' ? 'in_progress' : 'completed',
        conclusion: ['queued', 'leased'].includes(progress.state) ? null : progress.result?.complete ? 'success' : 'neutral' };
      if (record.intent.channel !== 'inline') await summaryAndCheck(target, fence, identity, record.intent.channel, body, check);
      if (record.intent.channel === 'summary' && progress.result) {
        const result = progress.result;
        for (const [index, finding] of result.findings.entries()) {
          const text = findingTexts[index]!;
          const parts = chunks(text, 40_000), anchor = findingAnchor(result, finding);
          for (const [part, value] of parts.entries()) {
            await guard(target, fence, identity);
            if (await findingAlreadyPublished(identity, finding.id, part)) continue;
            const comments: InlineComment[] = anchor && part === 0 ? [{ ...anchor, body: value }] : [];
            const batchBody = comments.length ? `Finding ${index + 1} of ${result.findings.length}.` : value;
            await mutate(target, fence, identity, 'inline', { findingId: finding.id, part, comments, batchBody }, operationMarker =>
              github.createReview(target, { commitId: identity.headSha, body: `${operationMarker}\n${batchBody}`, comments }), `${index}:${part}`);
          }
        }
        await cleanup(result, fence);
      }
      return { status: 'published', reason: null };
    } catch (error) {
      if (error instanceof StalePublication && store.publicationOperations(target.repositoryId, target.pullNumber).some(operation => same(operation.fence, fence) && operation.state !== 'planned')) {
        await repairStale(target, identity.generation);
      }
      return failure(error, target);
    }
  }
  async function repairStale(target: PublicationTarget, generation: number): Promise<void> {
    const key = `${target.repositoryId}/${target.pullNumber}`;
    if (repairing.has(key)) { notify(target, 'stale_publication_requires_reconciliation'); return; }
    repairing.add(key);
    try {
      const observed = store.observation(target.repositoryId, target.pullNumber);
      if (observed.generation !== generation) {
        const notice = store.publicationNotices(target.repositoryId, target.pullNumber).at(-1);
        if (notice && notice.generation === observed.generation) { await reconcileNotice(notice); return; }
        const latest = store.publications(target.repositoryId, target.pullNumber).filter(item => item.state === 'planned');
        for (const record of latest) await reconcile(record);
        return;
      }
      const pull = livePullSchema.parse(await github.readLivePull(target.installationId, target.repositoryId, target.pullNumber));
      const reason = 'publication_outdated';
      store.invalidatePull(target.repositoryId, target.pullNumber, observed.generation, reason, pull.headSha, pull.baseRef, pull);
      const notice = store.publicationNotices(target.repositoryId, target.pullNumber).at(-1);
      if (notice) await reconcileNotice(notice);
    } catch { notify(target, 'stale_publication_requires_reconciliation'); }
    finally { repairing.delete(key); }
  }
  function failure(error: unknown, target: PublicationTarget): PublicationOutcome {
    if (error instanceof StalePublication) return { status: 'stale', reason: 'comparison_changed' };
    if (error instanceof GitHubAccessError) { store.setAccess(target.installationId, target.repositoryId, false); return { status: 'access_revoked', reason: 'publication_access_revoked' }; }
    if (error instanceof GitHubPermissionError) { notify(target, 'publication_permission_unavailable'); return { status: 'pending', reason: 'publication_permission_unavailable' }; }
    notify(target, error instanceof PendingPublication ? 'publication_acknowledgement_uncertain' : 'publication_failed');
    return { status: 'pending', reason: error instanceof PendingPublication ? 'acknowledgement_uncertain' : 'publication_failed' };
  }
  async function reconcileNotice(notice: PublicationNotice): Promise<PublicationOutcome> {
    const stored = store.publicationNotices(notice.target.repositoryId, notice.target.pullNumber).find(item => item.id === notice.id);
    if (!stored || !same(stored, notice)) return { status: 'stale', reason: 'notice_not_current' };
    const target = publicationTargetSchema.parse(notice.target), fence: PublicationFence = { kind: 'notice', noticeId: notice.id };
    try {
      await guard(target, fence, null);
      await recoverResolutions(target);
      const owned = await github.listOwnedPublications(target);
      const receipts = store.publicationOperations(target.repositoryId, target.pullNumber);
      if (notice.kind !== 'configuration_failure' && !owned.some(item => item.channel === 'summary' && receipts.some(operation => operation.channel === 'summary' && (operation.remoteId === item.id || item.body.includes(marker(operation.key)))))) return { status: 'published', reason: 'no_existing_review' };
      const body = `## Subscription review\n\n${notice.kind === 'outdated' ? 'Comparison outdated' : notice.kind === 'cancelled' ? 'Review cancelled' : 'Configuration failure'}. Reason: ${sanitizeText(notice.reason)}.\n\nCurrent head \`${target.headSha}\`, base \`${target.baseSha}\`. Previous findings remain historical evidence.\n\n${notice.reviewedIdentity ? `Reviewed attempt ${notice.reviewedIdentity.attemptId}, head ${notice.reviewedIdentity.headSha}, base ${notice.reviewedIdentity.baseSha}.` : 'No review attempt was admitted.'}`;
      for (const channel of ['summary', 'check'] as const) await summaryAndCheck(target, fence, null, channel, body,
        { headSha: target.headSha, status: 'completed', conclusion: notice.kind === 'cancelled' ? 'cancelled' : 'neutral' });
      return { status: 'published', reason: null };
    } catch (error) {
      if (error instanceof StalePublication && store.publicationOperations(target.repositoryId, target.pullNumber).some(operation => same(operation.fence, fence) && operation.state !== 'planned')) await repairStale(target, notice.generation);
      return failure(error, target);
    }
  }
  return {
    reconcilePublication(record: PublicationRecord) { return locked(destination(record.intent.identity), async () => { try { await recoverResolutions(destination(record.intent.identity)); return await reconcile(record); } catch (error) { return failure(error, destination(record.intent.identity)); } }); },
    reconcileNotice(notice: PublicationNotice) { return locked(notice.target, () => reconcileNotice(notice)); },
    publishReview(input: ReviewResult): Promise<PublicationOutcome> {
      const result = reviewResultSchema.parse(input), target = destination(result.identity);
      return locked(target, async () => {
        const records = store.publications(target.repositoryId, target.pullNumber).filter(record => record.state === 'planned' && same(record.intent.identity, result.identity));
        if (!records.length) return { status: 'stale', reason: 'no_current_intent' };
        let outcome: PublicationOutcome = { status: 'published', reason: null };
        for (const record of records) {
          const progress = progressSchema.parse(JSON.parse(record.intent.body));
          if (!same(progress.result, result)) return { status: 'stale', reason: 'result_not_current' };
          const next = await reconcile(record); if (next.status === 'stale' || next.status === 'access_revoked') return next;
          if (next.status === 'pending') outcome = next;
        }
        return outcome;
      });
    },
  };
}
