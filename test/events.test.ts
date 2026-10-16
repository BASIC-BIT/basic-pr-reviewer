import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdmissionService } from '../src/events.js';
import { loadPolicy } from '../src/policy.js';
import { openStore } from '../src/store.js';
import { createRetention } from '../src/retention.js';
import { GitHubAccessError } from '../src/github.js';
import type { AdmissionGitHubPort } from '../src/github.js';
import type { LivePull, RepoPolicy, Store } from '../src/contracts.js';

const secret = 'synthetic-webhook-secret';
const policy: RepoPolicy = {
  schemaVersion: 1, enabled: true, baseBranches: ['main'], skipLabels: ['skip-review'],
  rerunOnUnskip: false, excludeGlobs: [], excludeDocsOnly: false, allowBotAuthors: false,
  allowedBotActors: [], contextMode: 'diff', contextAllowGlobs: [], githubLinksOnly: true,
  instructionPaths: ['AGENTS.md'],
  docsOnlyGlobs: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.txt', 'docs/**'],
};
const pull: LivePull = {
  installationId: '100', repositoryId: '200', ownerId: '400', headRepositoryId: '200', baseRepositoryId: '200',
  owner: 'example', repo: 'fixture', pullNumber: 42, headSha: 'a'.repeat(40),
  baseRef: 'main', baseSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40),
  draft: false, state: 'open', labels: [], author: { login: 'author', type: 'User' },
};
class FakeGitHub implements AdmissionGitHubPort {
  live = structuredClone(pull);
  calls: string[] = [];
  defaultBranch: string | null = 'main';
  async readDefaultBranch() { return this.defaultBranch; }
  permission = 'write';
  revoked = false;
  files = new Map([
    ['.github/claude-review.json', JSON.stringify(policy)], ['REVIEW.md', 'Review this repository.'],
    ['AGENTS.md', 'Use the repository conventions.'],
  ]);
  beforeRead: (() => void) | undefined;
  async assertInstallation(id: string) {
    this.calls.push(`access:${id}`);
    if (this.revoked || id !== '100') throw new Error('Installation access revoked');
    return { ownerId: '400' };
  }
  async listInstallations() { return ['100']; }
  async readLivePull(installationId: string, repositoryId: string, number: number) {
    this.calls.push(`pull:${installationId}:${repositoryId}:${number}`);
    this.beforeRead?.();
    if (this.revoked) throw new Error('Installation access revoked');
    return structuredClone(this.live);
  }
  async readFile(value: LivePull, path: string) {
    this.calls.push(`file:${value.baseSha}:${path}`);
    return this.files.get(path) ?? null;
  }
  async readPermission(value: LivePull, login: string) {
    this.calls.push(`permission:${login}`);
    return this.permission;
  }
  async readCheckRun() { return { appId: '300', headSha: this.live.headSha, pullNumbers: [42] }; }
  async listRepositories() { return [{ installationId: '100', repositoryId: '200' }]; }
  async listOpenPulls() { return [42]; }
}
const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = openStore(':memory:'); stores.push(store);
  const github = new FakeGitHub();
  const service = createAdmissionService({ store, github, webhookSecret: secret, appId: '300',
    ownerIds: ['400'], runtimeHash: 'e'.repeat(64) });
  return { store, github, service };
}
let sequence = 0;
function payload(action = 'opened', extra = {}) {
  return { action, installation: { id: 100, account: { id: 400 } }, repository: { id: 200 }, number: 42,
    sender: { login: 'human', type: 'User' }, pull_request: { number: 42 }, ...extra };
}
function signed(value: unknown, event = 'pull_request', delivery = `delivery-${++sequence}`) {
  const body = Buffer.from(JSON.stringify(value));
  return { body, headers: { 'x-github-delivery': delivery, 'x-github-event': event,
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } };
}
async function send(service: ReturnType<typeof createAdmissionService>, value: unknown, event?: string, delivery?: string) {
  const input = signed(value, event, delivery);
  return service.admitWebhook(input.headers, input.body);
}

describe('signed, durable event admission', () => {
  it('rejects invalid signatures and oversize bodies before any API call or durable write', async () => {
    const { store, github, service } = setup();
    const input = signed(payload());
    await expect(service.admitWebhook({ ...input.headers, 'x-hub-signature-256': 'sha256=bad' }, input.body)).rejects.toThrow(/signature/i);
    await expect(service.admitWebhook(input.headers, Buffer.alloc(30 * 1024 * 1024 + 1))).rejects.toThrow(/size/i);
    expect(github.calls).toEqual([]);
    expect(store.observation('200', 42).generation).toBe(0);
    expect(store.receipt(input.headers['x-github-delivery'])).toBeNull();
  });
  it.each(['opened', 'ready_for_review', 'synchronize', 'reopened'])('admits current eligible %s and acknowledges durable work', async (action) => {
    const { store, service } = setup();
    const result = await send(service, payload(action));
    expect(result.kind).toBe('admitted');
    expect(store.current('200', 42)).toMatchObject({ state: 'queued', identity: { mergeBaseSha: 'c'.repeat(40), generation: 1 } });
    expect(store.claim(Date.now())).not.toBeNull();
  });
  it('acks known replay without fresh API calls, including after restart-equivalent service recreation', async () => {
    const { store, github, service } = setup();
    await send(service, payload(), 'pull_request', 'same-delivery');
    const calls = github.calls.length;
    expect((await send(service, payload(), 'pull_request', 'same-delivery')).kind).toBe('duplicate');
    expect(github.calls).toHaveLength(calls);
    expect(store.current('200', 42)?.identity.generation).toBe(1);
  });
  it('fails unknown installations and malformed signed events closed', async () => {
    const { store, github, service } = setup();
    await expect(send(service, payload('opened', { installation: { id: 999 } }))).rejects.toThrow(/installation/i);
    await expect(send(service, { installation: { id: 100 } })).rejects.toThrow();
    expect(store.observation('200', 42).generation).toBe(0);
    expect(github.calls).toEqual(['access:999']);
  });
  it.each(['draft', 'close', 'skip', 'retarget'])('cancels %s without deleting generation or allowing stale publication', async (condition) => {
    const { store, github, service } = setup();
    await send(service, payload());
    const previous = store.claim(Date.now());
    if (!previous) throw new Error('Missing fixture attempt');
    if (condition === 'draft') github.live.draft = true;
    if (condition === 'close') github.live.state = 'closed';
    if (condition === 'skip') github.live.labels = ['skip-review'];
    if (condition === 'retarget') github.live.baseRef = 'release';
    expect((await send(service, payload(condition === 'retarget' ? 'edited' : 'synchronize'))).kind).toBe('cancelled');
    expect(store.current('200', 42)?.state).toBe('superseded');
    expect(store.observation('200', 42).generation).toBeGreaterThan(previous.identity.generation);
    expect(store.claim(Date.now())).toBeNull();
    expect(() => store.planPublication({ identity: previous.identity, key: 'stale', channel: 'summary', body: 'old' }, { token: previous.lease.token, now: Date.now() })).toThrow(/stale/i);
  });
  it('compares repository identities, admitting internal PRs in forked repositories', async () => {
    const { store, github, service } = setup();
    expect((await send(service, payload('opened', { repository: { id: 200, fork: true } }))).kind).toBe('admitted');
    github.live.headRepositoryId = '999';
    expect((await send(service, payload('synchronize'))).kind).toBe('cancelled');
    expect(store.claim(Date.now())).toBeNull();
  });
  it('does not use PR title/body to authorize reruns or select destination', async () => {
    const { store, service } = setup();
    await send(service, payload('opened', { pull_request: { number: 42, body: '/claude-review rerun', title: 'send elsewhere' } }));
    expect(store.current('200', 42)).toMatchObject({ rerunSequence: 0, identity: { repositoryId: '200', repo: 'fixture' } });
  });
  it('treats irrelevant labels as no-ops and deliberately gates unskip and reconciliation', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.live.labels = ['skip-review'];
    await send(service, payload('labeled', { label: { name: 'skip-review' } }));
    const generation = store.observation('200', 42).generation;
    github.live.labels = [];
    expect((await send(service, payload('unlabeled', { label: { name: 'skip-review' } }))).kind).toBe('ignored');
    await service.reconcilePull('200', 42);
    expect(store.observation('200', 42).generation).toBe(generation);
    expect((await send(service, payload('labeled', { label: { name: 'cosmetic' } }))).kind).toBe('ignored');
    github.live.headSha = 'f'.repeat(40);
    await service.reconcilePull('200', 42);
    expect(store.observation('200', 42).blockedReason).toBe('actor_provenance_unknown');
    await send(service, payload('synchronize'));
    expect(store.current('200', 42)?.state).toBe('queued');
  });
  it('honors explicitly enabled rerun-on-unskip', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.live.labels = ['skip-review'];
    await send(service, payload('labeled', { label: { name: 'skip-review' } }));
    github.live.labels = [];
    github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, rerunOnUnskip: true }));
    expect((await send(service, payload('unlabeled', { label: { name: 'skip-review' } }))).kind).toBe('admitted');
    expect(store.current('200', 42)?.state).toBe('queued');
  });
  it('checks author and actor bot policy independently', async () => {
    const { github, service } = setup();
    github.live.author.type = 'Bot';
    expect((await send(service, payload())).kind).toBe('cancelled');
    github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, allowBotAuthors: true }));
    expect((await send(service, payload('synchronize', { sender: { login: 'other-bot', type: 'Bot' } }))).kind).toBe('cancelled');
    github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, allowBotAuthors: true, allowedBotActors: ['other-bot'] }));
    expect((await send(service, payload('synchronize', { sender: { login: 'other-bot', type: 'Bot' } }))).kind).toBe('admitted');
  });
  it.each([[[]], [['trusted-bot']], [['*']]])('preserves actor policy %j independently of bot authors', async (allowedBotActors) => {
    const { github, service } = setup();
    github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, allowedBotActors }));
    const event = payload('opened', { sender: { login: 'unlisted-bot', type: 'Bot' } });
    expect(await send(service, event)).toMatchObject(allowedBotActors.includes('*')
      ? { kind: 'admitted' } : { kind: 'cancelled', reason: 'bot_actor' });
    github.live.author.type = 'Bot';
    expect(await send(service, event)).toMatchObject({ kind: 'cancelled', reason: 'bot_author' });
    github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, allowedBotActors, allowBotAuthors: true }));
    expect(await send(service, event)).toMatchObject(allowedBotActors.includes('*')
      ? { kind: 'admitted' } : { kind: 'cancelled', reason: 'bot_actor' });
  });
  it('limits the wildcard to bot actors rather than other non-human types', async () => {
    const { github, service } = setup();
    github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, allowedBotActors: ['*'] }));
    expect(await send(service, payload('opened', { sender: { login: 'imported-user', type: 'Mannequin' } })))
      .toMatchObject({ kind: 'cancelled', reason: 'bot_actor' });
  });
  it.each([[[]], [['*']]])('requires exact human rerun commands and fresh write permission with actor policy %j', async (allowedBotActors) => {
    const { store, github, service } = setup();
    github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, allowedBotActors }));
    await send(service, payload());
    const comment = (body: string, type = 'User') => payload('created', {
      issue: { number: 42, pull_request: {} }, comment: { id: 501, body, user: { login: 'operator', type } },
    });
    expect((await send(service, comment('please /claude-review rerun'), 'issue_comment')).kind).toBe('ignored');
    expect((await send(service, comment('/claude-review rerun', 'Bot'), 'issue_comment')).kind).toBe('ignored');
    github.permission = 'read';
    expect((await send(service, comment('/claude-review rerun'), 'issue_comment')).kind).toBe('ignored');
    github.permission = 'maintain';
    expect((await send(service, comment('/claude-review rerun'), 'issue_comment')).kind).toBe('admitted');
    const generation = store.observation('200', 42).generation;
    expect((await send(service, comment('/claude-review rerun'), 'issue_comment')).kind).toBe('duplicate');
    expect(store.observation('200', 42).generation).toBe(generation);
    expect(store.current('200', 42)?.rerunSequence).toBe(1);
    expect(github.calls).toContain('permission:operator');
  });
  it('checks authenticated check-run context and current actor permission', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    const check = payload('rerequested', { check_run: { id: 700, app: { id: 300 }, pull_requests: [{ number: 42 }] } });
    github.permission = 'read';
    expect((await send(service, check, 'check_run')).kind).toBe('ignored');
    github.permission = 'admin';
    expect((await send(service, check, 'check_run')).kind).toBe('admitted');
    expect(store.current('200', 42)?.rerunSequence).toBe(1);
    expect((await send(service, { ...check, check_run: { id: 700, app: { id: 999 }, pull_requests: [{ number: 42 }] } }, 'check_run')).kind).toBe('ignored');
  });
  it('invalidates base-only work without queuing inference, including never-reviewed pulls', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.live.baseSha = 'd'.repeat(40);
    expect((await send(service, payload('', { ref: 'refs/heads/main' }), 'push')).kind).toBe('cancelled');
    expect(store.claim(Date.now())).toBeNull();
    await service.reconcilePull('200', 42);
    expect(store.claim(Date.now())).toBeNull();
    const fresh = setup();
    await send(fresh.service, payload('', { ref: 'refs/heads/main' }), 'push');
    await fresh.service.reconcilePull('200', 42);
    expect(fresh.store.current('200', 42)).toBeNull();
  });
  it('loads policy and referenced instructions only at captured base SHA and hashes their content', async () => {
    const { github } = setup();
    const first = await loadPolicy(github, pull);
    expect(first.instructions.map((file) => file.path)).toEqual(['REVIEW.md', 'AGENTS.md']);
    expect(github.calls.every((call) => call.startsWith(`file:${pull.baseSha}:`))).toBe(true);
    github.files.set('AGENTS.md', 'Changed trusted instruction.');
    expect((await loadPolicy(github, pull)).policyHash).not.toBe(first.policyHash);
    github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, instructionPaths: ['../private.md'] }));
    await expect(loadPolicy(github, pull)).rejects.toThrow(/policy|instruction/i);
  });
  it('records visible missing/invalid policy failures and queues no inference', async () => {
    const { store, github, service } = setup();
    github.files.delete('.github/claude-review.json');
    const result = await send(service, payload(), 'pull_request', 'bad-config');
    expect(result.kind).toBe('configuration_failure');
    expect(store.receipt('bad-config')).toMatchObject({ kind: 'configuration_failure' });
    expect(store.publicationNotices()).toMatchObject([{ kind: 'configuration_failure', reviewedIdentity: null, target: { installationId: '100', repositoryId: '200', pullNumber: 42 } }]);
    expect(store.claim(Date.now())).toBeNull();
  });
  it('rereads live identity and policy after stale observation rather than retrying old snapshots', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.beforeRead = () => {
      github.beforeRead = undefined;
      const observed = store.observation('200', 42);
      store.invalidatePull('200', 42, observed.generation, 'base_changed', github.live.headSha, github.live.baseRef);
      github.live.headSha = 'f'.repeat(40);
    };
    await send(service, payload('synchronize'));
    expect(store.current('200', 42)?.identity.headSha).toBe('f'.repeat(40));
    expect(github.calls.filter((call) => call.startsWith('pull:'))).toHaveLength(3);
    expect(github.calls.filter((call) => call.endsWith(':.github/claude-review.json'))).toHaveLength(3);
  });
  it.each(['installation', 'installation_repositories'])('cancels pending/running work on %s revocation and fences in-flight admission', async (event) => {
    const { store, github, service } = setup();
    await send(service, payload());
    store.claim(Date.now());
    const revocation = event === 'installation' ? payload('suspend') : payload('removed', { repositories_removed: [{ id: 200 }] });
    await send(service, revocation, event);
    expect(store.current('200', 42)?.state).toBe('superseded');
    github.revoked = true;
    await expect(send(service, payload('synchronize'))).rejects.toThrow(/access|revoked/i);
    expect(store.claim(Date.now())).toBeNull();
  });
  it('handles delayed close delivery using fresh live state without cancelling a reopened head', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.live.headSha = 'f'.repeat(40);
    await send(service, payload('synchronize'));
    await send(service, payload('closed'));
    expect(store.current('200', 42)).toMatchObject({ state: 'queued', identity: { headSha: 'f'.repeat(40) } });
  });
  it('invalidates missed base-only changes during reconciliation instead of starting a new review', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.live.baseSha = 'd'.repeat(40);
    await service.reconcilePull('200', 42);
    expect(store.claim(Date.now())).toBeNull();
    expect(store.observation('200', 42).blockedReason).toBe('base_changed');
  });
  it('does not let reconciliation bypass a rejected bot actor on the same head', async () => {
    const { store, service } = setup();
    await send(service, payload('opened', { sender: { login: 'disallowed-bot', type: 'Bot' } }));
    await service.reconcilePull('200', 42);
    expect(store.claim(Date.now())).toBeNull();
  });
  it('fences installation revocation during policy reads without admitting its observed identity', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    const read = github.readFile.bind(github);
    github.readFile = async (live, path) => {
      const value = await read(live, path);
      if (path === 'AGENTS.md') { store.setAccess('100', null, false); github.revoked = true; }
      return value;
    };
    await expect(send(service, payload('synchronize'))).rejects.toThrow(/access revoked/i);
    expect(store.claim(Date.now())).toBeNull();
    expect(store.observation('200', 42).generation).toBe(2);
  });
  it('cancels prior work when inventory reads discover revoked access', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.listRepositories = async () => { throw new GitHubAccessError('100', null); };
    await expect(service.reconcilePull('200', 42)).rejects.toThrow(/access revoked/i);
    expect(store.claim(Date.now())).toBeNull();
  });
  it('reconciles all PR pages at startup and honors rate-limit reset time before the next scan', async () => {
    vi.useFakeTimers();
    const { github, service } = setup();
    let scans = 0;
    github.listRepositories = async () => {
      scans++;
      if (scans === 1) throw { status: 403, response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((Date.now() + 1_200_000) / 1000) } } };
      return [{ installationId: '100', repositoryId: '200' }];
    };
    const errors: unknown[] = [];
    const stop = service.startReconciliation((error) => errors.push(error));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(scans).toBe(1);
      expect(errors).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(900_000);
      expect(scans).toBe(1);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(scans).toBe(2);
      expect(github.calls.some((call) => call.startsWith('pull:'))).toBe(true);
      await vi.advanceTimersByTimeAsync(900_000);
      expect(scans).toBe(3);
    } finally { stop(); vi.useRealTimers(); }
  });
  it('normalizes a small policy without broadening context access', async () => {
    const { github } = setup();
    github.files.set('.github/claude-review.json', JSON.stringify({ schemaVersion: 1, enabled: true }));
    const trusted = await loadPolicy(github, pull);
    expect(trusted.policy).toMatchObject({ contextMode: 'changed-context-only', contextAllowGlobs: [],
      rerunOnUnskip: false, allowBotAuthors: false, githubLinksOnly: false });
    expect(trusted.instructions.map((file) => file.path)).toEqual(['REVIEW.md']);
  });
  it('recovers a missed repository-removal event by cancelling stored work absent from the live inventory', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.listRepositories = async () => [];
    await service.reconcileInstalled();
    expect(store.claim(Date.now())).toBeNull();
    expect(store.accessAllowed('100', '200')).toBe(false);
  });
  it('recovers a missed close event for a tracked PR absent from the open list', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.live.state = 'closed';
    github.listOpenPulls = async () => [];
    await service.reconcileInstalled();
    expect(store.claim(Date.now())).toBeNull();
    expect(store.observation('200', 42).blockedReason).toBe('closed');
  });
  it('processes closure even when trusted policy has become unavailable', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.live.state = 'closed';
    github.files.clear();
    expect(await send(service, payload('closed'))).toEqual({ kind: 'cancelled', reason: 'closed' });
    expect(store.claim(Date.now())).toBeNull();
  });
  it('rejects a valid signed delivery from a live installation with an unapproved owner', async () => {
    const { github, service, store } = setup();
    github.assertInstallation = async () => { github.calls.push('verified-access'); return { ownerId: '999' }; };
    github.readLivePull = async (installationId) => ({ ...github.live, installationId });
    await expect(send(service, payload('opened', { installation: { id: 999 } }))).rejects.toThrow(/unapproved installation owner/i);
    expect(github.calls).toEqual(['verified-access']);
    expect(store.claim(Date.now())).toBeNull();
  });
  it('checks immutable live owner IDs independently of webhook text', async () => {
    const { store, github, service } = setup();
    github.live.ownerId = '999';
    await expect(send(service, payload('opened', { repository: { id: 200, owner: { id: 400 } } }))).rejects.toThrow(GitHubAccessError);
    expect(store.claim(Date.now())).toBeNull();
  });
  it('onboards another selected repository under an approved owner using its own local policy', async () => {
    const { store, github, service } = setup();
    github.live = { ...github.live, repositoryId: '201', headRepositoryId: '201', baseRepositoryId: '201', repo: 'another' };
    expect((await send(service, payload('opened', { repository: { id: 201 } }))).kind).toBe('admitted');
    expect(store.current('201', 42)?.identity.repo).toBe('another');
  });
  it('admits a newly verified installation under an approved owner without manual installation enrollment', async () => {
    const { store, github, service } = setup();
    github.assertInstallation = async () => ({ ownerId: '400' });
    github.readLivePull = async (installationId) => ({ ...github.live, installationId });
    expect((await send(service, payload('opened', { installation: { id: 999 } }))).kind).toBe('admitted');
    expect(store.current('200', 42)?.identity.installationId).toBe('999');
  });
  it('continues reconciling independent installations after cancelling a revoked installation', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    github.listInstallations = async () => ['101'];
    github.listRepositories = async (installationId?: string) => {
      if (installationId === '100') throw new GitHubAccessError('100', null);
      return [{ installationId: '101', repositoryId: '201' }];
    };
    github.assertInstallation = async () => ({ ownerId: '400' });
    github.readLivePull = async () => ({ ...github.live, installationId: '101', repositoryId: '201', headRepositoryId: '201', baseRepositoryId: '201' });
    await service.reconcileInstalled();
    expect(store.current('200', 42)?.state).toBe('superseded');
    expect(store.observation('201', 42).blockedReason).toBe('actor_provenance_unknown');
  });
  it.each(['installation', 'installation_repositories'])('recovers missed %s restoration from live access without reviving the cancelled head', async (event) => {
    const { store, github, service } = setup();
    await send(service, payload());
    const previous = store.current('200', 42)?.identity;
    await send(service, event === 'installation' ? payload('suspend') : payload('removed', { repositories_removed: [{ id: 200 }] }), event);
    expect(store.accessAllowed('100', '200')).toBe(false);
    const cancelledGeneration = store.observation('200', 42).generation;
    // GitHub now reports active membership, but no restoration event was delivered.
    await service.reconcileInstalled();
    expect(store.accessAllowed('100', '200')).toBe(true);
    expect(store.current('200', 42)).toMatchObject({ state: 'superseded', identity: previous });
    expect(store.observation('200', 42).generation).toBe(cancelledGeneration);
    expect(store.claim(Date.now())).toBeNull();
    github.live.headSha = 'f'.repeat(40);
    await service.reconcileInstalled();
    expect(store.observation('200', 42).blockedReason).toBe('actor_provenance_unknown');
    await send(service, payload('synchronize'));
    expect(store.current('200', 42)).toMatchObject({ state: 'queued', identity: { headSha: 'f'.repeat(40) } });
  });
  it('recovers a delayed removal delivery and admits a later head without another re-add event', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    const removal = payload('removed', { repositories_removed: [{ id: 200 }] });
    await send(service, removal, 'installation_repositories');
    await send(service, payload('added', { repositories_added: [{ id: 200 }] }), 'installation_repositories');
    github.live.headSha = 'f'.repeat(40);
    await send(service, payload('synchronize'));
    const previous = store.current('200', 42)?.identity;
    await send(service, removal, 'installation_repositories');
    await service.reconcilePull('200', 42);
    expect(store.accessAllowed('100', '200')).toBe(true);
    expect(store.current('200', 42)).toMatchObject({ state: 'superseded', identity: previous });
    github.live.headSha = 'd'.repeat(40);
    expect((await send(service, payload('synchronize'))).kind).toBe('admitted');
  });
  it('lets an authorized explicit rerun verify restored access without restoring the cancelled attempt', async () => {
    const { store, service } = setup();
    await send(service, payload());
    const previous = store.current('200', 42)?.identity.attemptId;
    await send(service, payload('suspend'), 'installation');
    expect((await send(service, payload('created', { issue: { number: 42, pull_request: {} },
      comment: { id: 600, body: '/claude-review rerun', user: { login: 'operator', type: 'User' } } }), 'issue_comment')).kind).toBe('admitted');
    expect(store.current('200', 42)?.identity.attemptId).not.toBe(previous);
    expect(store.current('200', 42)?.rerunSequence).toBe(1);
  });
  it('does not clear concurrent revocation using live metadata read before that revocation', async () => {
    const { store, github, service } = setup();
    await send(service, payload());
    const read = github.readLivePull.bind(github);
    github.readLivePull = async (installationId, repositoryId, pullNumber) => {
      const snapshot = await read(installationId, repositoryId, pullNumber);
      store.setAccess('100', null, false);
      github.revoked = true;
      return snapshot;
    };
    await expect(send(service, payload('synchronize'))).rejects.toThrow(/access revoked/i);
    expect(store.accessAllowed('100', '200')).toBe(false);
    expect(store.current('200', 42)?.state).toBe('superseded');
  });
  it('backs off secondary limits without persisting revocation and returns to the regular cadence after success', async () => {
    vi.useFakeTimers();
    const { store, github, service } = setup();
    let scans = 0;
    github.listRepositories = async () => {
      scans++;
      if (scans <= 6) throw Object.assign(new Error('GitHub request failed'), { status: 403, rateLimited: true,
        response: { headers: { 'x-ratelimit-remaining': '100' } } });
      return [{ installationId: '100', repositoryId: '200' }];
    };
    const errors: unknown[] = [];
    const stop = service.startReconciliation((error) => errors.push(error));
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(scans).toBe(1);
      expect(store.accessAllowed('100', '200')).toBe(true);
      for (const expected of [
        { delay: 60_000, scans: 2 }, { delay: 120_000, scans: 3 }, { delay: 240_000, scans: 4 },
        { delay: 480_000, scans: 5 }, { delay: 900_000, scans: 6 }, { delay: 900_000, scans: 7 },
      ]) {
        await vi.advanceTimersByTimeAsync(expected.delay - 1);
        expect(scans).toBe(expected.scans - 1);
        await vi.advanceTimersByTimeAsync(1);
        expect(scans).toBe(expected.scans);
      }
      expect(errors).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(900_000);
      expect(scans).toBe(8);
    } finally { stop(); vi.useRealTimers(); }
  });
});

it('rejects a forged feature-base policy before reading its files and follows default branch renames', async () => {
  const { store, github, service } = setup();
  github.live.baseRef = 'attacker';
  github.files.set('.github/claude-review.json', JSON.stringify({ ...policy, baseBranches: ['attacker'], contextMode: 'repo' }));
  expect(await send(service, payload())).toEqual({ kind: 'cancelled', reason: 'untrusted_base' });
  expect(github.calls.filter(call => call.startsWith('file:'))).toEqual([]);
  expect(store.current('200', 42)).toBeNull();
});
it('does not infer a missed-head actor is human during reconciliation', async () => {
  const { store, github, service } = setup();
  await service.reconcileInstalled();
  expect(store.current('200', 42)).toBeNull();
  expect(store.observation('200', 42).blockedReason).toBe('actor_provenance_unknown');
  await send(service, payload());
  const first = store.current('200', 42)!;
  await service.reconcileInstalled();
  expect(store.current('200', 42)?.identity).toEqual(first.identity);
  github.live.headSha = 'f'.repeat(40);
  await service.reconcileInstalled();
  expect(store.current('200', 42)?.state).toBe('superseded');
  expect(store.observation('200', 42).blockedReason).toBe('actor_provenance_unknown');
});

it('fails closed with missing repository metadata and accepts a verified default branch rename',async()=>{
  const {github,service}=setup();github.defaultBranch=null;
  expect(await send(service,payload())).toEqual({kind:'cancelled',reason:'untrusted_base'});
  expect(github.calls.filter(call=>call.startsWith('file:'))).toEqual([]);
  github.defaultBranch='trunk';github.live.baseRef='trunk';
  github.files.set('.github/claude-review.json',JSON.stringify({...policy,baseBranches:['trunk']}));
  await send(service,payload('synchronize'));
  expect(await send(service,{installation:{id:100},repository:{id:200},sender:{login:'human',type:'User'},action:'created',issue:{number:42,pull_request:{}},comment:{id:9898,body:'/claude-review rerun',user:{login:'human',type:'User'}}},'issue_comment')).toMatchObject({kind:'admitted'});
});

it('retains and purges configuration notices that never admitted an attempt',async()=>{
  const {github,store,service}=setup();github.files.delete('REVIEW.md');
  await send(service,payload('opened'),'pull_request','configuration-notice');
  expect(store.current('200',42)).toBeNull();expect(store.trackedInstallations()).toContain('100');expect(store.trackedPulls('100')).toContainEqual({repositoryId:'200',pullNumber:42});
  const notice=store.publicationNotices('200',42)[0]!;
  store.planPublicationOperation({key:'a'.repeat(64),fence:{kind:'notice',noticeId:notice.id},target:notice.target,channel:'summary',body:'synthetic'});
  github.live.state='closed';await service.reconcileInstalled();
  store.observePullState('200',42,'open',0);store.observePullState('200',42,'closed',1000);
  expect(store.purgeClosedBefore(1000)).toBe(1);expect(store.publicationNotices()).toEqual([]);expect(store.publicationOperations('200',42)).toEqual([]);expect(store.receipt('configuration-notice')).toBeNull();
});

it('expires orphan comment and check receipts while preserving tracked open and closure retention',async()=>{
  const day=86400000,start=Date.now();let now=start;const clock=vi.spyOn(Date,'now').mockImplementation(()=>now);
  try {
    const {store,github,service}=setup();github.live.state='closed';
    const comment=(number:number)=>payload('created',{issue:{number,pull_request:{}},comment:{id:501,body:'ordinary comment',user:{login:'human',type:'User'}}});
    await send(service,comment(42),'issue_comment','orphan-comment');
    await send(service,payload('completed',{check_run:{id:502,app:{id:999},pull_requests:[{number:42}]}}),'check_run','orphan-check');
    expect(github.calls).toEqual([]);expect(store.trackedPulls('100')).toEqual([]);
    github.live={...pull,pullNumber:43};await send(service,payload('opened',{number:43,pull_request:{number:43}}));
    await send(service,comment(43),'issue_comment','open-comment');
    github.live={...pull,pullNumber:44};await send(service,payload('opened',{number:44,pull_request:{number:44}}));
    await send(service,comment(44),'issue_comment','closed-comment');
    now=start+10*day;github.live.state='closed';await send(service,payload('closed',{number:44,pull_request:{number:44}}));
    const retention=createRetention({store});now=start+29*day;await retention.purgeExpired(now);
    expect(store.receipt('orphan-comment')).not.toBeNull();expect(store.receipt('orphan-check')).not.toBeNull();
    now=start+30*day;await retention.purgeExpired(now);
    expect(store.receipt('orphan-comment')).toBeNull();expect(store.receipt('orphan-check')).toBeNull();
    expect(store.receipt('open-comment')).not.toBeNull();expect(store.receipt('closed-comment')).not.toBeNull();
    now=start+40*day;await retention.purgeExpired(now);expect(store.receipt('closed-comment')).toBeNull();
    now=start+60*day;await retention.purgeExpired(now);expect(store.receipt('open-comment')).not.toBeNull();
  } finally {clock.mockRestore();}
});
