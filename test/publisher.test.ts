import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fixture, identity as sourceIdentity, policy, service, temp } from './fixtures/source.js';
import { aggregateReview, planCoverage } from '../src/passes.js';
import type { Manifest, PlannedPass } from '../src/contracts.js';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/store.js';
import { createPublisher, sanitizeText, findingAnchor } from '../src/publisher.js';
import { repoPolicySchema } from '../src/contracts.js';
import type { LivePull, ReviewResult, Store } from '../src/contracts.js';
import { GitHubAccessError } from '../src/github.js';
import type { PublicationGitHubPort, OwnedPublication, ReviewThread } from '../src/github.js';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
const input = { installationId: '1', repositoryId: '2', owner: 'fixture', repo: 'example', pullNumber: 3,
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), baseRef: 'main',
  policyHash: 'd'.repeat(64), runtimeHash: 'e'.repeat(64) };
const path = { bytesBase64: Buffer.from('src/index.ts').toString('base64') };
function setup(change: (result: ReviewResult) => void = () => {}, database = ':memory:') {
  const store = openStore(database); stores.push(store);
  const identity = store.admit({ schemaVersion: 1, deliveryId: 'first', receivedAt: 1, expectedGeneration: 0,
    identity: input, trigger: { kind: 'automatic' } }).identity;
  const unit = { id: 'f'.repeat(64), sourceId: '0'.repeat(64), path, oldPath: null, oldBlobId: null,
    newBlobId: input.headSha, oldLines: { start: 0, count: 0 }, newLines: { start: 1, count: 2 },
    kind: 'text' as const, contentHash: '1'.repeat(64), groupId: '2'.repeat(64), diffBytes: 20 };
  const result: ReviewResult = { identity, complete: true, status: 'complete', reason: null,
    coveredUnitIds: [unit.id], reusedUnitIds: [], missingUnitIds: [], integrationStatus: 'completed',
    findings: [{ id: 'finding-one', severity: 'P2', message: 'Broken return value.',
      location: { kind: 'line', path, side: 'RIGHT', startLine: 1, endLine: 1 }, evidence: [{ unitId: unit.id, explanation: 'Return is absent.' }] }],
    exclusions: [], missingScope: [], failureCodes: [], generation: identity.generation, publicationState: 'unpublished',
    reviewUnits: [unit], priorFindingAssessments: [] };
  change(result);
  const lease = store.claim(1)!;
  store.settle(identity, { token: lease.lease.token, now: 2 }, { state: 'complete', result, reason: null, nextAttemptAt: 2 });
  const { policyHash: _p, runtimeHash: _r, ...target } = input;
  let live: LivePull = { ...target, ownerId: '4', headRepositoryId: '2', baseRepositoryId: '2',
    draft: false, state: 'open', labels: [], author: { type: 'User', login: 'author' } };
  const owned: OwnedPublication[] = [], threads: ReviewThread[] = [];
  let policyHash = input.policyHash;
  const notices: string[] = [], checks: { conclusion: string | null; status: string }[] = [];
  let calls = 0, loseReview = false, mutate: (() => void) | null = null;
  const github: PublicationGitHubPort = {
    async readLivePull() { return live; },
    async listOwnedPublications() { return owned; },
    async upsertSummary(_target, id, body) { calls++; const record = { id: id ?? String(calls), channel: 'summary' as const, body, headSha: null };
      const index = owned.findIndex((item) => item.id === id && item.channel === 'summary'); if (index < 0) owned.push(record); else owned[index] = record; mutate?.(); return record.id; },
    async upsertCheck(_target, id, check) { checks.push(check); calls++; const record = { id: id ?? String(calls), channel: 'check' as const, body: check.body, headSha: check.headSha };
      const index = owned.findIndex((item) => item.id === id && item.channel === 'check'); if (index < 0) owned.push(record); else owned[index] = record; mutate?.(); return record.id; },
    async createReview(_target, review) { calls++; const id = String(calls); owned.push({ id, channel: 'inline', body: review.body, headSha: review.commitId });
      for (const comment of review.comments) threads.push({ id: `thread-${threads.length}`, reviewId: id, body: comment.body, owned: true, resolved: false, hasReplies: false });
      mutate?.(); if (loseReview) throw new Error('lost acknowledgement'); return id; },
    async listThreads() { return threads; },
    async resolveThread(_target, id) { threads.find((item) => item.id === id)!.resolved = true; mutate?.(); },
    async unresolveThread(_target, id) { threads.find((item) => item.id === id)!.resolved = false; },
  };
  const publisher = () => createPublisher({ store, github, readPolicy: async () => ({ policy: repoPolicySchema.parse({ schemaVersion: 1, enabled: true }), policyHash }),
    notify: notice => { notices.push(notice.reason); }, engineRevision: 'fixture-engine', operatorCommand: 'reviewer inspect' });
  return { store, identity, result, owned, threads, publisher, github, notices, checks, live: () => live, setPolicy: () => { policyHash = 'f'.repeat(64); }, setLive: (value: Partial<LivePull>) => { live = { ...live, ...value }; },
    loseReview: () => { loseReview = true; }, mutate: (value: (() => void) | null) => { mutate = value; }, calls: () => calls };
}

describe('safe publication', () => {
  it('publishes terminal intents without a model lease and reconciles a lost review acknowledgement once', async () => {
    const f = setup(); f.loseReview();
    await f.publisher().publishReview(f.result);
    await f.publisher().publishReview(f.result);
    expect(f.owned.filter((item) => item.channel === 'inline')).toHaveLength(1);
    expect(f.threads).toHaveLength(1);
    expect(f.owned.filter((item) => item.channel === 'summary')).toHaveLength(1);
  });
  it.each(['headSha', 'baseSha', 'baseRef'] as const)('fences changed %s before writes', async (field) => {
    const f = setup(); f.setLive({ [field]: field === 'baseRef' ? 'release' : '9'.repeat(40) });
    expect((await f.publisher().publishReview(f.result)).status).toBe('stale'); expect(f.calls()).toBe(0);
  });
  it('fences changed policy, revoked access and a newer same-head attempt', async () => {
    const policy = setup(); policy.setPolicy(); expect((await policy.publisher().publishReview(policy.result)).status).toBe('stale'); expect(policy.calls()).toBe(0);
    const denied = setup(); denied.github.readLivePull = async () => { throw new GitHubAccessError('1', '2'); };
    expect((await denied.publisher().publishReview(denied.result)).status).toBe('access_revoked'); expect(denied.store.accessAllowed('1', '2')).toBe(false);
    const rerun = setup(); rerun.store.admit({ schemaVersion: 1, deliveryId: 'rerun', receivedAt: 3, expectedGeneration: 1, identity: input, trigger: { kind: 'rerun', sequence: 1 } });
    expect((await rerun.publisher().publishReview(rerun.result)).status).toBe('stale'); expect(rerun.calls()).toBe(0);
  });
  it.each(['headSha', 'baseSha', 'baseRef'] as const)('marks an accepted summary outdated when %s races the write', async field => {
    const f = setup(); f.mutate(() => { f.mutate(null); f.setLive({ [field]: field === 'baseRef' ? 'release' : '9'.repeat(40) }); });
    expect((await f.publisher().publishReview(f.result)).status).toBe('stale');
    expect(f.owned.find(item => item.channel === 'summary')?.body).toContain('Comparison outdated');
    expect(f.threads).toEqual([]); expect(f.checks.at(-1)?.conclusion).toBe('neutral');
  });
  it('updates to a newer same-head queued attempt after a write race', async () => {
    const f = setup(); f.mutate(() => { f.mutate(null); f.store.admit({ schemaVersion: 1, deliveryId: 'rerun', receivedAt: 3, expectedGeneration: 1, identity: input, trigger: { kind: 'rerun', sequence: 1 } }); });
    expect((await f.publisher().publishReview(f.result)).status).toBe('stale');
    expect(f.owned.find(item => item.channel === 'summary')?.body).toContain('Attempt 2.'); expect(f.checks.at(-1)?.status).toBe('queued');
  });
  it('leaves an ambiguous create pending without duplicating it', async () => {
    const f = setup(); let creates = 0; f.github.createReview = async () => { creates++; throw new Error('unknown acceptance'); };
    expect((await f.publisher().publishReview(f.result)).status).toBe('pending');
    expect((await f.publisher().publishReview(f.result)).status).toBe('pending');
    expect(creates).toBe(1); expect(f.notices).toContain('publication_acknowledgement_uncertain');
  });
  it('reconciles partial finding batches before continuing', async () => {
    const f = setup(result => { result.findings.push({ ...result.findings[0]!, id: 'second' }); });
    const original = f.github.createReview; let count = 0;
    f.github.createReview = async (...args) => { const id = await original(...args); if (++count === 2) throw new Error('second ack lost'); return id; };
    await f.publisher().publishReview(f.result); await f.publisher().publishReview(f.result);
    expect(f.threads).toHaveLength(2); expect(f.owned.filter(item => item.channel === 'inline')).toHaveLength(2);
  });
  it('keeps multibyte findings within byte bounds and retains every fragment', async () => {
    const message = '界'.repeat(40_000);
    const f = setup(result => { result.findings[0]!.message = message; });
    expect((await f.publisher().publishReview(f.result)).status).toBe('published');
    expect(f.owned.every(item => Buffer.byteLength(item.body) <= 50_000)).toBe(true);
    expect(f.threads.every(item => Buffer.byteLength(item.body) <= 50_000)).toBe(true);
    const emitted = [...f.owned.filter(item => item.channel === 'inline').map(item => item.body), ...f.threads.map(item => item.body)].join('');
    expect([...emitted].filter(char => char === '界')).toHaveLength(40_000);
    expect(f.owned.find(item => item.channel === 'summary')?.body).toContain('1 further findings');
  });
  it('retains invalid anchors and byte-unsafe paths as summary-only findings', async () => {
    for (const bytes of [Buffer.from([0xff, 0xfe]), Buffer.from('bad\nname')]) {
      const f = setup(result => { const path = { bytesBase64: bytes.toString('base64') }; result.findings[0]!.location = { kind: 'line', path, side: 'RIGHT', startLine: 1, endLine: 1 }; result.reviewUnits![0]!.path = path; });
      await f.publisher().publishReview(f.result); expect(f.threads).toEqual([]);
      expect(f.owned.find(item => item.channel === 'summary')?.body).toContain('Source location unavailable');
    }
    const invalid = setup(result => { result.findings[0]!.location = { kind: 'line', path, side: 'RIGHT', startLine: 999, endLine: 999 }; });
    await invalid.publisher().publishReview(invalid.result); expect(invalid.threads).toEqual([]);
    expect(invalid.owned.find(item => item.channel === 'summary')?.body).toContain('Broken return value');
  });
  it('uses validated diff filenames for LEFT rename and deletion locations', () => {
    const f = setup(), oldPath = { bytesBase64: Buffer.from('src/old.ts').toString('base64') };
    const unit = f.result.reviewUnits![0]!; unit.oldPath = oldPath; unit.oldLines = { start: 4, count: 3 }; unit.oldBlobId = input.baseSha;
    f.result.findings[0]!.location = { kind: 'line', path: oldPath, side: 'LEFT', startLine: 4, endLine: 6 };
    expect(findingAnchor(f.result, f.result.findings[0]!)).toEqual({ path: 'src/index.ts', side: 'LEFT', line: 6, start_line: 4, start_side: 'LEFT' });
    unit.kind = 'delete'; unit.path = oldPath; unit.newBlobId = null;
    expect(findingAnchor(f.result, f.result.findings[0]!)?.path).toBe('src/old.ts');
  });
  it('publishes durable never-admitted configuration failures and fences repeated base notices', async () => {
    const f = setup(), live = { ...f.live(), pullNumber: 8 };
    f.store.invalidatePull('2', 8, 0, 'configuration_failure', live.headSha, live.baseRef);
    const notice = f.store.recordNotice(live, 1, 'configuration_failure', 'configuration_failure');
    f.github.readLivePull = async () => live;
    expect((await f.publisher().reconcileNotice(notice)).status).toBe('published');
    expect(notice.reviewedIdentity).toBe(null); expect(f.owned[0]?.body).toContain('No review attempt was admitted');
    const unreviewed = setup(), other = { ...unreviewed.live(), pullNumber: 8 };
    unreviewed.store.invalidatePull('2', 8, 0, 'base_changed', other.headSha, other.baseRef);
    const base = unreviewed.store.recordNotice(other, 1, 'outdated', 'base_changed'); unreviewed.github.readLivePull = async () => other;
    expect((await unreviewed.publisher().reconcileNotice(base)).reason).toBe('no_existing_review'); expect(unreviewed.calls()).toBe(0);
    unreviewed.store.invalidatePull('2', 8, 1, 'base_changed', other.headSha, other.baseRef);
    expect((await unreviewed.publisher().reconcileNotice(base)).status).toBe('stale');
  });
  it.each(['fixed', 'open', 'uncertain'] as const)('cleans up only verified %s findings and keeps human replies open', async assessment => {
    const f = setup(); await f.publisher().publishReview(f.result);
    const next = f.store.admit({ schemaVersion: 1, deliveryId: 'rerun', receivedAt: 3, expectedGeneration: 1, identity: input, trigger: { kind: 'rerun', sequence: 1 } });
    const result = { ...f.result, identity: next.identity, generation: next.identity.generation, findings: [], priorFindingAssessments: [{ findingId: 'finding-one', assessment }] };
    const claim = f.store.claim(4)!; f.store.settle(next.identity, { token: claim.lease.token, now: 5 }, { state: 'complete', result, reason: null, nextAttemptAt: 5 });
    await f.publisher().publishReview(result);
    expect(f.threads[0]?.resolved).toBe(assessment === 'fixed');
  });
  it.each(['before', 'during'] as const)('preserves a human reply %s resolution', async timing => {
    const f = setup(); await f.publisher().publishReview(f.result);
    const next = f.store.admit({ schemaVersion: 1, deliveryId: 'rerun', receivedAt: 3, expectedGeneration: 1, identity: input, trigger: { kind: 'rerun', sequence: 1 } });
    const result = { ...f.result, identity: next.identity, generation: 2, findings: [], priorFindingAssessments: [{ findingId: 'finding-one', assessment: 'fixed' as const }] };
    const claim = f.store.claim(4)!; f.store.settle(next.identity, { token: claim.lease.token, now: 5 }, { state: 'complete', result, reason: null, nextAttemptAt: 5 });
    if (timing === 'before') f.threads[0]!.hasReplies = true;
    else f.github.resolveThread = async (_target, id) => { const thread = f.threads.find(thread => thread.id === id)!; thread.resolved = true; thread.hasReplies = true; };
    await f.publisher().publishReview(result); expect(f.threads[0]?.resolved).toBe(false);
  });
  it('reconciles accepted writes after closing and reopening actual SQLite', async () => {
    const database = join(await temp(), 'publication.sqlite'), f = setup(() => {}, database); f.loseReview();
    await f.publisher().publishReview(f.result); f.store.close();
    const reopened = openStore(database); stores.push(reopened);
    const publisher = createPublisher({ store: reopened, github: f.github, readPolicy: async () => ({ policy: repoPolicySchema.parse({ schemaVersion: 1, enabled: true }), policyHash: input.policyHash }), notify: () => {}, engineRevision: 'fixture-engine', operatorCommand: 'reviewer inspect' });
    expect((await publisher.publishReview(f.result)).status).toBe('published'); expect(f.threads).toHaveLength(1);
    expect(reopened.publicationOperations('2', 3).filter(operation => operation.channel === 'inline')).toMatchObject([{ state: 'acknowledged' }]);
  });
  it('recovers a lost resolution acknowledgement and durably undoes a racing human reply', async () => {
    const f = setup(); await f.publisher().publishReview(f.result);
    const next = f.store.admit({ schemaVersion: 1, deliveryId: 'rerun', receivedAt: 3, expectedGeneration: 1, identity: input, trigger: { kind: 'rerun', sequence: 1 } });
    const result = { ...f.result, identity: next.identity, generation: 2, findings: [], priorFindingAssessments: [{ findingId: 'finding-one', assessment: 'fixed' as const }] };
    const claim = f.store.claim(4)!; f.store.settle(next.identity, { token: claim.lease.token, now: 5 }, { state: 'complete', result, reason: null, nextAttemptAt: 5 });
    f.github.resolveThread = async () => { f.threads[0]!.resolved = true; f.threads[0]!.hasReplies = true; throw new Error('resolve ack lost'); };
    expect((await f.publisher().publishReview(result)).status).toBe('pending');
    expect((await f.publisher().publishReview(result)).status).toBe('published'); expect(f.threads[0]!.resolved).toBe(false);
    expect(f.store.publicationOperations('2', 3).filter(item => item.channel === 'unresolve')).toMatchObject([{ state: 'acknowledged' }]);
  });
  it('closes a previously published finding through real source, planner, integration and SQLite settlement', async () => {
    const repo = await fixture([], [{ path: 'src/index.ts', text: 'broken\n' }]), trusted = policy(), { source } = await service(repo);
    const store = openStore(':memory:'); stores.push(store); const transport = setup();
    const publisher = createPublisher({ store, github: transport.github, readPolicy: async () => trusted, notify: () => {}, engineRevision: 'fixture-engine', operatorCommand: 'reviewer inspect' });
    let oldFindingId = '';
    async function run(head: string, generation: number) {
      const { attemptId: _a, generation: _g, ...identity } = { ...sourceIdentity(repo, trusted), headSha: head };
      const admitted = store.admit({ schemaVersion: 1, deliveryId: `head-${generation}`, receivedAt: generation * 10,
        expectedGeneration: generation - 1, identity, trigger: { kind: 'automatic' } });
      transport.setLive({ ...identity, installationId: identity.installationId, headRepositoryId: identity.repositoryId, baseRepositoryId: identity.repositoryId });
      // Live transport exposes only its documented destination/state fields.
      transport.github.readLivePull = async () => ({ installationId: identity.installationId, repositoryId: identity.repositoryId, owner: identity.owner, repo: identity.repo,
        pullNumber: identity.pullNumber, headSha: identity.headSha, baseSha: identity.baseSha, baseRef: identity.baseRef, mergeBaseSha: identity.mergeBaseSha,
        ownerId: '4', headRepositoryId: identity.repositoryId, baseRepositoryId: identity.repositoryId, labels: [], state: 'open', draft: false, author: { type: 'User', login: 'author' } });
      const manifest: Manifest = await source.captureManifest(admitted.identity, trusted), claim = store.claim(generation * 10)!;
      const owner = { token: claim.lease.token, now: generation * 10 + 1 };
      const proof = await source.verifyAncestry(manifest, [repo.head, head]);
      async function save(spec: PlannedPass) {
        await source.materializePass(manifest, spec);
        const unit = manifest.units[0]!;
        const findings: ReviewResult['findings'] = generation === 1 && spec.kind === 'scope' ? [{ id: 'retained-real-finding', severity: 'P2', message: 'Synthetic broken value.',
          location: { kind: 'line', path: unit.path, side: 'RIGHT', startLine: 1, endLine: 1 }, evidence: [{ unitId: unit.id, explanation: 'Synthetic source.' }] }] : [];
        if (findings.length) oldFindingId = findings[0]!.id;
        store.savePass(admitted.identity, spec, { passId: spec.id, status: 'completed', failureCode: null, findings,
          priorFindingAssessments: generation === 2 && spec.kind === 'integration' ? [{ findingId: oldFindingId, assessment: 'fixed' }] : [],
          model: { name: 'fixture', cliVersion: 'fixture' }, usage: { inputTokens: null, outputTokens: null } }, owner);
      }
      for (const spec of planCoverage(manifest, store.passHistory(identity.repositoryId, identity.pullNumber), proof).freshPasses.filter(spec => spec.kind === 'scope')) await save(spec);
      const integration = planCoverage(manifest, store.passHistory(identity.repositoryId, identity.pullNumber), proof).freshPasses.find(spec => spec.kind === 'integration')!;
      if (generation === 2) expect(integration.assessmentFindings?.map(finding => finding.id)).toContain(oldFindingId);
      await save(integration);
      const result = aggregateReview(admitted.identity, manifest, store.current(identity.repositoryId, identity.pullNumber)!.passes);
      expect(result.complete).toBe(true);
      store.settle(admitted.identity, owner, { state: 'complete', nextAttemptAt: generation * 10 + 2, reason: null, result });
      expect((await publisher.publishReview(result)).status).toBe('published');
      await source.destroyWorkspace(manifest.workspace);
    }
    await run(repo.head, 1); expect(transport.threads).toHaveLength(1); expect(transport.threads[0]!.resolved).toBe(false);
    const next = repo.commit([{ path: 'src/index.ts', text: 'fixed\n' }], repo.head);
    await run(next, 2); expect(transport.threads).toHaveLength(1); expect(transport.threads[0]!.resolved).toBe(true);
  });
  it('serializes concurrent publication calls for the same pull', async () => {
    const f = setup(), publisher = f.publisher();
    await Promise.all([publisher.publishReview(f.result), publisher.publishReview(f.result)]);
    expect(f.threads).toHaveLength(1); expect(f.owned.filter(item => item.channel === 'summary')).toHaveLength(1);
  });
  it('preserves prior complete evidence during a failed same-identity rerun', async () => {
    const f = setup(); await f.publisher().publishReview(f.result);
    const next = f.store.admit({ schemaVersion: 1, deliveryId: 'rerun', receivedAt: 3, expectedGeneration: 1, identity: input, trigger: { kind: 'rerun', sequence: 1 } });
    const result = { ...f.result, identity: next.identity, generation: 2, complete: false, status: 'incomplete' as const, findings: [], integrationStatus: 'failed' as const };
    const claim = f.store.claim(4)!; f.store.settle(next.identity, { token: claim.lease.token, now: 5 }, { state: 'incomplete', result, reason: 'quota_limited', nextAttemptAt: 5 });
    await f.publisher().publishReview(result);
    const summary = f.owned.find(item => item.channel === 'summary')!.body;
    expect(summary).toContain('Attempt 2.'); expect(summary).toContain('Prior complete evidence for this same comparison');
    expect(summary).toContain('[Prior findings]'); expect(f.threads).toHaveLength(1); expect(f.checks.at(-1)?.conclusion).toBe('neutral');
  });
  it('repairs a head update racing a lifecycle summary and rejects old repeated base notices', async () => {
    const f = setup(); await f.publisher().publishReview(f.result); f.setLive({ baseSha: '7'.repeat(40) });
    f.store.invalidatePull('2', 3, 1, 'base_changed', f.live().headSha, f.live().baseRef, f.live());
    const notice = f.store.publicationNotices('2', 3).at(-1)!;
    f.mutate(() => { f.mutate(null); f.setLive({ headSha: '8'.repeat(40) }); });
    expect((await f.publisher().reconcileNotice(notice)).status).toBe('stale');
    expect(f.owned.find(item => item.channel === 'summary')?.body).toContain('8'.repeat(40));
    expect(f.checks.at(-1)?.conclusion).toBe('neutral');
    const calls = f.calls(); await f.publisher().reconcileNotice(notice); expect(f.calls()).toBe(calls);
  });
  it('requires the stored finding receipt as well as an App-owned thread marker', async () => {
    const f = setup(result => { result.findings.push({ ...result.findings[0]!, id: 'second' }); }); await f.publisher().publishReview(f.result);
    const marker = (id: string) => createHash('sha256').update(JSON.stringify(id)).digest('hex');
    f.threads[0]!.body = f.threads[0]!.body.replace(marker('finding-one'), marker('second'));
    const next = f.store.admit({ schemaVersion: 1, deliveryId: 'rerun', receivedAt: 3, expectedGeneration: 1, identity: input, trigger: { kind: 'rerun', sequence: 1 } });
    const result = { ...f.result, identity: next.identity, generation: 2, findings: [], priorFindingAssessments: [{ findingId: 'second', assessment: 'fixed' as const }] };
    const claim = f.store.claim(4)!; f.store.settle(next.identity, { token: claim.lease.token, now: 5 }, { state: 'complete', result, reason: null, nextAttemptAt: 5 });
    await f.publisher().publishReview(result);
    expect(f.threads.map(thread => thread.resolved)).toEqual([false, true]);
  });
  it('neutralizes untrusted Markdown, images, mentions and operation markers', () => {
    const rendered = sanitizeText('![x](https://evil.invalid/a) @person <!-- reviewer:fake --> [x](https://github.com/fixture/example)');
    expect(rendered).not.toContain('https://evil.invalid'); expect(rendered).not.toContain('@person');
    expect(rendered).not.toContain('<!--'); expect(rendered).not.toContain('![');
  });
});
