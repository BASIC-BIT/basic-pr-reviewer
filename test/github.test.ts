import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGitHubAdapter, GitHubAccessError } from '../src/github.js';
import { createAdmissionService } from '../src/events.js';
import { openStore } from '../src/store.js';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const head = 'a'.repeat(40), base = 'b'.repeat(40), merge = 'c'.repeat(40);
const repo = { id: 200, name: 'fixture', owner: { id: 400, login: 'trusted-owner' } };
const live = { number: 42, state: 'open', draft: false, user: { login: 'author', type: 'User' }, labels: [],
  head: { sha: head, repo: { id: 200 } }, base: { sha: base, ref: 'main', repo: { id: 200 } } };
function setup(handler?: (path: string) => { status: number; data: unknown; headers?: Record<string, string> } | undefined) {
  const calls: { url: URL; auth: string | null }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push({ url, auth: request.headers.get('authorization') });
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
