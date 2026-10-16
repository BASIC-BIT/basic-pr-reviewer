import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGitHubAdapter, GitHubAccessError, GitHubPermissionError } from '../src/github.js';
import { createAdmissionService } from '../src/events.js';
import { openStore } from '../src/store.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40);
const repo = { default_branch: 'main', id: 200, name: 'fixture', owner: { id: 400, login: 'trusted-owner' } };
const live = { number: 42, state: 'open', draft: false, user: { login: 'author', type: 'User' }, labels: [],
  head: { sha: head, repo: { id: 200 } }, base: { sha: base, ref: 'main', repo: { id: 200 } } };
function setup(handler?: (path: string) => { status: number; data: unknown; headers?: Record<string, string> } | undefined) {
  const calls: { url: URL; auth: string | null; body: string }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ url, auth: request.headers.get('authorization'), body: await request.text() });
    const custom = handler?.(url.pathname);
    const data = custom?.data ?? (
      url.pathname === '/app/installations/100' ? { id: 100, suspended_at: null, account: { id: 400 } } :
      url.pathname === '/app/installations/100/access_tokens' ? { token: 'synthetic-installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), repository_selection: 'all', permissions: {} } :
      url.pathname === '/repositories/200' ? repo :
      url.pathname === '/repos/trusted-owner/fixture/pulls/42' ? live :
      url.pathname.startsWith('/repos/trusted-owner/fixture/compare/') ? { base_commit: { sha: base }, merge_base_commit: { sha: merge } } :
      url.pathname === '/installation/repositories' ? { repositories: [repo] } :
      url.pathname === '/repos/trusted-owner/fixture/pulls' ? [{ number: 42 }] :
      { type: 'file', encoding: 'base64', size: 5, content: 'aGVsbG8=' });
    return new Response(JSON.stringify(data), { status: custom?.status ?? (url.pathname.endsWith('/access_tokens') ? 201 : 200),
      headers: { 'content-type': 'application/json', ...custom?.headers } });
  };
  return { calls, github: createGitHubAdapter({ appId: '300', privateKey: key, ownerIds: ['400'], fetch: transport }) };
}
describe('Octokit installation adapter with synthetic HTTP transport', () => {
  it('paginates owned publications and limits mutation tokens to the repository and operation', async () => {
    let comments = 0, reviews = 0, checks = 0;
    const { calls, github } = setup(path => {
      if (path === '/app') return { status: 200, data: { slug: 'fixture-reviewer' } };
      if (path === '/users/fixture-reviewer%5Bbot%5D' || path === '/users/fixture-reviewer[bot]') return { status: 200, data: { id: 500 } };
      if (path.endsWith('/issues/42/comments')) return { status: 200, data: ++comments === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: 'untrusted marker', user: { id: 999 }, performed_via_github_app: null }))
        : [{ id: 501, body: 'owned summary', user: { id: 500 }, performed_via_github_app: { id: 300 } }] };
      if (path.endsWith('/pulls/42/reviews')) return { status: 200, data: ++reviews === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: 'other', user: { id: 999 }, commit_id: head }))
        : [{ id: 502, body: 'owned review', user: { id: 500 }, commit_id: head }] };
      if (path.includes('/commits/')) return { status: 200, data: { check_runs: ++checks === 1
        ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1, app: { id: 999 }, head_sha: head, output: { summary: 'other' } }))
        : [{ id: 503, app: { id: 300 }, head_sha: head, output: { summary: 'owned check' } }] } };
      if (path.endsWith('/issues/comments/501')) return { status: 200, data: { id: 501 } };
      if (path.endsWith('/check-runs/503')) return { status: 200, data: { id: 503 } };
      return undefined;
    });
    const target = { installationId: '100', repositoryId: '200', owner: 'trusted-owner', repo: 'fixture', pullNumber: 42,
      headSha: head, baseSha: base, baseRef: 'main', mergeBaseSha: merge };
    expect(await github.listOwnedPublications(target)).toEqual([
      { id: '501', body: 'owned summary', channel: 'summary', headSha: null },
      { id: '502', body: 'owned review', channel: 'inline', headSha: head },
      { id: '503', body: 'owned check', channel: 'check', headSha: head },
    ]);
    await github.upsertSummary(target, '501', 'safe body');
    await github.upsertCheck(target, '503', { headSha: head, body: 'safe check', status: 'completed', conclusion: 'neutral' });
    const tokenBodies = calls.filter(call => call.url.pathname.endsWith('/access_tokens')).map(call => JSON.parse(call.body || '{}'));
    expect(tokenBodies).toContainEqual({ repository_ids: [200], permissions: { pull_requests: 'write' } });
    expect(tokenBodies).toContainEqual({ repository_ids: [200], permissions: { checks: 'write' } });
    expect(JSON.parse(calls.find(call => call.url.pathname.endsWith('/check-runs/503'))!.body)).not.toHaveProperty('head_sha');
    expect(tokenBodies.some(body => body.permissions?.contents === 'write' || body.permissions?.issues === 'write')).toBe(false);
    expect(calls.filter(call => call.url.searchParams.get('page') === '2')).toHaveLength(3);
  });
  it('binds COMMENT reviews to the trusted commit and paginates thread roots without fetching human reply text', async () => {
    let page = 0;
    const { calls, github } = setup(path => {
      if (path === '/app') return { status: 200, data: { slug: 'fixture-reviewer' } };
      if (path.startsWith('/users/fixture-reviewer')) return { status: 200, data: { id: 500 } };
      if (path.endsWith('/pulls/42/reviews')) return { status: 200, data: { id: 502 } };
      if (path === '/graphql') return { status: 200, data: { data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: ++page === 1, endCursor: page === 1 ? 'next' : null },
        nodes: [{ id: `thread-${page}`, isResolved: false, comments: { totalCount: page === 1 ? 2 : 1,
          nodes: [{ body: 'root', author: { databaseId: 500 }, pullRequestReview: { databaseId: 502 } }] } }],
      } } } } } };
      return undefined;
    });
    const target = { installationId: '100', repositoryId: '200', owner: 'trusted-owner', repo: 'fixture', pullNumber: 42,
      headSha: head, baseSha: base, baseRef: 'main', mergeBaseSha: merge };
    await github.createReview(target, { commitId: head, body: 'finding', comments: [{ path: 'new.ts', side: 'LEFT', line: 7, body: 'root' }] });
    expect(JSON.parse(calls.find(call => call.url.pathname.endsWith('/reviews'))!.body)).toMatchObject({ event: 'COMMENT', commit_id: head,
      comments: [{ path: 'new.ts', side: 'LEFT', line: 7 }] });
    await expect(github.createReview(target, { commitId: base, body: 'wrong', comments: [] })).rejects.toThrow(/commit mismatch/);
    expect((await github.listThreads(target)).map(thread => thread.hasReplies)).toEqual([true, false]);
    expect(calls.filter(call => call.url.pathname === '/graphql').map(call => JSON.parse(call.body).variables.after)).toEqual([null, 'next']);
  });
  it('reports unavailable thread permissions without requesting Contents write', async () => {
    const { calls, github } = setup(path => path === '/graphql' ? { status: 403, data: { message: 'Resource not accessible by integration' } } : undefined);
    const target = { installationId: '100', repositoryId: '200', owner: 'trusted-owner', repo: 'fixture', pullNumber: 42,
      headSha: head, baseSha: base, baseRef: 'main', mergeBaseSha: merge };
    await expect(github.resolveThread(target, 'thread-node')).rejects.toThrow(GitHubPermissionError);
    const tokens = calls.filter(call => call.url.pathname.endsWith('/access_tokens')).map(call => JSON.parse(call.body || '{}'));
    expect(tokens.at(-1)).toEqual({ repository_ids: [200], permissions: { pull_requests: 'write' } });
    expect(tokens.some(token => token.permissions?.contents === 'write')).toBe(false);
  });
  it('provides a host-only contents-read credential scoped to the verified repository', async () => {
    const { calls, github } = setup();
    const credential = await github.installationCredential({ installationId: '100', repositoryId: '200', owner: 'trusted-owner', repo: 'fixture' });
    expect(credential).toBe('synthetic-installation-token');
    expect(JSON.parse(calls.filter((call) => call.url.pathname.endsWith('/access_tokens')).at(-1)?.body ?? '{}')).toEqual({ repository_ids: [200], permissions: { contents: 'read' } });
    await expect(github.installationCredential({ installationId: '100', repositoryId: '200', owner: 'other-owner', repo: 'fixture' })).rejects.toThrow(GitHubAccessError);
  });
  it('uses installation authentication, canonical repository names and exact-SHA merge-base metadata', async () => {
    const { calls, github } = setup();
    const pull = await github.readLivePull('100', '200', 42);
    expect(pull).toMatchObject({ owner: 'trusted-owner', headSha: head, baseSha: base, mergeBaseSha: merge });
    const compare = calls.find((call) => call.url.pathname.includes('/compare/'));
    expect(compare?.url.pathname).toBe(`/repos/trusted-owner/fixture/compare/${base}...${head}`);
    expect(compare?.auth).toBe('token synthetic-installation-token');
    expect(await github.readFile(pull, 'REVIEW.md')).toBe('hello');
    expect(calls.at(-1)?.url.searchParams.get('ref')).toBe(base);
  });
  it('verifies unknown installations with App auth before minting tokens and never tries another installation on revocation', async () => {
    const { calls, github } = setup((path) => path === '/repositories/200' || path === '/app/installations/999' ? { status: 404, data: { message: 'Not Found' } } : undefined);
    await expect(github.readLivePull('999', '200', 42)).rejects.toThrow(GitHubAccessError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe('/app/installations/999');
    await expect(github.readLivePull('100', '200', 42)).rejects.toThrow(GitHubAccessError);
    expect(calls.filter((call) => call.url.pathname.includes('/999'))).toHaveLength(1);
    expect(calls.some((call) => call.url.pathname.includes('/pulls/'))).toBe(false);
  });
  it('propagates installation-status rate limits instead of marking access revoked', async () => {
    const { github } = setup((path) => path === '/app/installations/100'
      ? { status: 403, data: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } } : undefined);
    await expect(github.listRepositories('100')).rejects.toMatchObject({ status: 403 });
  });
  it('paginates installed repositories and open PRs', async () => {
    const counts = new Map<string, number>();
    const { calls, github } = setup((path) => {
      counts.set(path, (counts.get(path) ?? 0) + 1);
      const count = counts.get(path);
      if (path === '/installation/repositories') return { status: 200, data: { repositories: count === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, owner: { id: 400 } })) : [{ id: 200, owner: { id: 400 } }] } };
      if (path === '/repos/trusted-owner/fixture/pulls') return { status: 200, data: count === 1 ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) : [{ number: 101 }] };
      return undefined;
    });
    expect(await github.listRepositories('100')).toHaveLength(101);
    expect(await github.listOpenPulls('100', '200')).toHaveLength(101);
    expect(calls.filter((call) => call.url.searchParams.get('page') === '2')).toHaveLength(2);
  });
  it('does not downgrade denied content reads into missing onboarding policy', async () => {
    const { github } = setup((path) => path.includes('/contents/') ? { status: 403, data: { message: 'Resource not accessible by integration' } } : undefined);
    const pull = await github.readLivePull('100', '200', 42);
    await expect(github.readFile(pull, 'REVIEW.md')).rejects.toThrow(GitHubAccessError);
  });
  it('rejects live installation accounts outside the immutable owner allowlist', async () => {
    const { github, calls } = setup((path) => path === '/app/installations/100'
      ? { status: 200, data: { id: 100, suspended_at: null, account: { id: 999 } } } : undefined);
    await expect(github.readLivePull('100', '200', 42)).rejects.toThrow(GitHubAccessError);
    expect(calls.some((call) => call.url.pathname.endsWith('/access_tokens'))).toBe(false);
  });
  it('rejects repository transfers outside the approved owner boundary', async () => {
    const { github } = setup((path) => path === '/repositories/200'
      ? { status: 200, data: { ...repo, owner: { id: 999, login: 'other-owner' } } } : undefined);
    await expect(github.readLivePull('100', '200', 42)).rejects.toThrow(GitHubAccessError);
  });
  it('discovers only active installations under approved immutable owners', async () => {
    const { github } = setup((path) => path === '/app/installations' ? { status: 200, data: [
      { id: 100, account: { id: 400 }, suspended_at: null },
      { id: 101, account: { id: 999 }, suspended_at: null },
      { id: 102, account: { id: 400 }, suspended_at: '2026-01-01T00:00:00Z' },
    ] } : undefined);
    expect(await github.listInstallations()).toEqual(['100']);
  });
  it('verifies a newly installed approved owner without an installation-ID enrollment list', async () => {
    const { github, calls } = setup((path) => path === '/app/installations/999'
      ? { status: 200, data: { id: 999, account: { id: 400 }, suspended_at: null } } :
      path === '/app/installations/999/access_tokens' ? { status: 201, data: { token: 'new-synthetic-token', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'selected' } } : undefined);
    expect((await github.readLivePull('999', '200', 42)).installationId).toBe('999');
    expect(calls.some((call) => call.url.pathname === '/app/installations/999/access_tokens')).toBe(true);
  });
  it('does not expose authenticated Octokit request headers on transient errors', async () => {
    const { github } = setup((path) => path === '/app/installations/100' ? { status: 500, data: { message: 'Server failure' } } : undefined);
    const error: unknown = await github.assertInstallation('100').catch((error: unknown) => error);
    expect(error).toMatchObject({ status: 500 });
    expect(error).not.toHaveProperty('request');
  });
  it.each(['/app/installations/100', '/repositories/200'])('classifies secondary limits on %s with primary allowance and no retry header', async (limitedPath) => {
    const { github } = setup((path) => path === limitedPath ? { status: 403,
      data: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits' },
      headers: { 'x-ratelimit-remaining': '100' } } : undefined);
    const error: unknown = await github.readLivePull('100', '200', 42).catch((error: unknown) => error);
    expect(error).not.toBeInstanceOf(GitHubAccessError);
    expect(error).toMatchObject({ status: 403, rateLimited: true, response: { headers: { 'x-ratelimit-remaining': '100' } } });
    expect(error).not.toHaveProperty('request');
    expect(error).not.toHaveProperty('response.data');
    const store = openStore(':memory:');
    try {
      const service = createAdmissionService({ store, github, webhookSecret: 'synthetic-secret', appId: '300', ownerIds: ['400'], runtimeHash: 'e'.repeat(64) });
      const body = Buffer.from(JSON.stringify({ action: 'opened', installation: { id: 100 }, repository: { id: 200 },
        sender: { login: 'human', type: 'User' }, number: 42, pull_request: { number: 42 } }));
      const headers = { 'x-github-event': 'pull_request', 'x-github-delivery': 'secondary-limit',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'synthetic-secret').update(body).digest('hex')}` };
      await expect(service.admitWebhook(headers, body)).rejects.toMatchObject({ rateLimited: true });
      expect(store.accessAllowed('100', '200')).toBe(true);
      expect(store.receipt('secondary-limit')).toBeNull();
    } finally { store.close(); }
  });
});
