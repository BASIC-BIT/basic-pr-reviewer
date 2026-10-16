import { Octokit } from '@octokit/core';
import { createAppAuth } from '@octokit/auth-app';
import { z } from 'zod';
import { livePullSchema } from './contracts.js';
import type { LivePull } from './contracts.js';

export type InstalledRepository = { installationId: string; repositoryId: string };
export interface GitHubPort {
  assertInstallation(installationId: string): Promise<{ ownerId: string }>;
  listInstallations(): Promise<string[]>;
  readLivePull(installationId: string, repositoryId: string, pullNumber: number): Promise<LivePull>;
  readFile(pull: LivePull, path: string): Promise<string | null>;
  readPermission(pull: LivePull, login: string): Promise<string>;
  readCheckRun(pull: LivePull, id: string): Promise<{ appId: string; headSha: string; pullNumbers: number[] }>;
  listRepositories(installationId: string): Promise<InstalledRepository[]>;
  listOpenPulls(installationId: string, repositoryId: string): Promise<number[]>;
}
const numericId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String);
const apiId = z.union([numericId, z.string().regex(/^[1-9][0-9]*$/)]);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const user = z.object({ login: z.string().min(1), type: z.enum(['User', 'Bot', 'Mannequin']) });
const repository = z.object({ id: apiId, name: z.string().min(1), owner: z.object({ id: apiId, login: z.string().min(1) }) });
const apiPull = z.object({
  number: z.number().int().positive(), state: z.enum(['open', 'closed']), draft: z.boolean(), user,
  labels: z.array(z.object({ name: z.string() })),
  head: z.object({ sha, repo: z.object({ id: apiId }).nullable() }),
  base: z.object({ sha, ref: z.string().min(1), repo: z.object({ id: apiId }) }),
});

export class GitHubAccessError extends Error {
  constructor(readonly installationId: string, readonly repositoryId: string | null, readonly status?: number) {
    super('Installation access revoked or unavailable'); this.name = 'GitHubAccessError';
  }
}

function rateLimited(error: object): boolean {
  if ('message' in error && typeof error.message === 'string' && /secondary rate limit/i.test(error.message)) return true;
  if (!('response' in error)) return false;
  const response = z.object({ headers: z.record(z.string(), z.unknown()) }).safeParse(error.response);
  return response.success && (response.data.headers['x-ratelimit-remaining'] === '0' || Boolean(response.data.headers['retry-after']));
}

function requestError(error: unknown): Error {
  const meta = z.object({ status: z.number(), response: z.object({ headers: z.object({
    'retry-after': z.string().optional(), 'x-ratelimit-remaining': z.string().optional(), 'x-ratelimit-reset': z.string().optional(),
  }) }).optional() }).safeParse(error);
  return meta.success ? Object.assign(new Error('GitHub request failed'), {
    status: meta.data.status, rateLimited: error !== null && typeof error === 'object' && rateLimited(error),
    response: { headers: meta.data.response?.headers ?? {} },
  }) : new Error('GitHub request failed');
}

export function createGitHubAdapter(options: {
  appId: string; privateKey: string; ownerIds: string[];
  fetch?: typeof fetch;
}): GitHubPort {
  const settings = { authStrategy: createAppAuth, request: { fetch: options.fetch ?? fetch } };
  const app = new Octokit({ ...settings, auth: { appId: options.appId, privateKey: options.privateKey } });
  const installations = new Map<string, Octokit>();
  const owners = new Set(options.ownerIds);
  const verified = new Set<string>();

  function client(id: string): Octokit {
    z.string().regex(/^[1-9][0-9]*$/).parse(id);
    let installation = installations.get(id);
    if (!installation) {
      installation = new Octokit({ ...settings,
        auth: { appId: options.appId, privateKey: options.privateKey, installationId: id } });
      installations.set(id, installation);
    }
    return installation;
  }
  async function request(installationId: string, repositoryId: string | null, route: string,
    parameters: Record<string, string | number> = {}): Promise<unknown> {
    if (!verified.has(installationId)) await assertInstallation(installationId);
    try { return (await client(installationId).request(route, parameters)).data; }
    catch (error) {
      if (error && typeof error === 'object' && 'status' in error && [401, 403, 404].includes(Number(error.status))) {
        // Rate limits are temporary, never an excuse to try another installation's token.
        if (rateLimited(error)) throw requestError(error);
        throw new GitHubAccessError(installationId, repositoryId, Number(error.status));
      }
      throw requestError(error);
    }
  }
  async function assertInstallation(installationId: string): Promise<{ ownerId: string }> {
    z.string().regex(/^[1-9][0-9]*$/).parse(installationId);
    let value: unknown;
    try { value = (await app.request('GET /app/installations/{installation_id}', { installation_id: Number(installationId) })).data; }
    catch (error) {
      if (error && typeof error === 'object' && 'status' in error && [401, 403, 404].includes(Number(error.status))) {
        if (rateLimited(error)) throw requestError(error);
        throw new GitHubAccessError(installationId, null);
      }
      throw requestError(error);
    }
    const installed = z.object({ id: apiId, account: z.object({ id: apiId }), suspended_at: z.string().nullable() }).parse(value);
    if (installed.id !== installationId || !owners.has(installed.account.id) || installed.suspended_at !== null) throw new GitHubAccessError(installationId, null);
    verified.add(installationId);
    return { ownerId: installed.account.id };
  }
  async function readRepository(installationId: string, repositoryId: string) {
    const repo = repository.parse(await request(installationId, repositoryId, 'GET /repositories/{repository_id}', { repository_id: repositoryId }));
    if (repo.id !== repositoryId || !owners.has(repo.owner.id)) throw new GitHubAccessError(installationId, repositoryId);
    return repo;
  }
  async function pages(installationId: string, repositoryId: string | null, route: string,
    parameters: Record<string, string | number>, field: string | null): Promise<unknown[]> {
    const all: unknown[] = [];
    for (let page = 1; ; page++) {
      const value = await request(installationId, repositoryId, route, { ...parameters, per_page: 100, page });
      const rows = z.array(z.unknown()).parse(field === null ? value : z.record(z.string(), z.unknown()).parse(value)[field]);
      all.push(...rows);
      if (rows.length < 100) return all;
    }
  }
  return {
    assertInstallation,
    async listInstallations() {
      const ids: string[] = [];
      for (let page = 1; ; page++) {
        const rows = z.array(z.object({ id: apiId, account: z.object({ id: apiId }), suspended_at: z.string().nullable() }))
          .parse((await app.request('GET /app/installations', { per_page: 100, page }).catch((error: unknown) => { throw requestError(error); })).data);
        for (const row of rows) if (owners.has(row.account.id) && row.suspended_at === null) ids.push(row.id);
        if (rows.length < 100) return ids;
      }
    },
    async readLivePull(installationId, repositoryId, pullNumber) {
      await assertInstallation(installationId);
      const repo = await readRepository(installationId, repositoryId);
      const parameters = { owner: repo.owner.login, repo: repo.name };
      const pull = apiPull.parse(await request(installationId, repositoryId, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...parameters, pull_number: pullNumber }));
      if (pull.number !== pullNumber || pull.base.repo.id !== repositoryId) throw new GitHubAccessError(installationId, repositoryId);
      const comparison = z.object({ base_commit: z.object({ sha }), merge_base_commit: z.object({ sha }) }).parse(
        await request(installationId, repositoryId, 'GET /repos/{owner}/{repo}/compare/{basehead}', {
          ...parameters, basehead: `${pull.base.sha}...${pull.head.sha}`,
        }));
      if (comparison.base_commit.sha !== pull.base.sha) throw new Error('GitHub comparison base identity mismatch');
      return livePullSchema.parse({ installationId, repositoryId, ownerId: repo.owner.id, owner: repo.owner.login, repo: repo.name,
        pullNumber, headRepositoryId: pull.head.repo?.id ?? null, baseRepositoryId: pull.base.repo.id,
        headSha: pull.head.sha, baseRef: pull.base.ref, baseSha: pull.base.sha,
        mergeBaseSha: comparison.merge_base_commit.sha, draft: pull.draft, state: pull.state,
        labels: pull.labels.map((label) => label.name), author: pull.user });
    },
    async readFile(pull, path) {
      let value: unknown;
      try { value = await request(pull.installationId, pull.repositoryId, 'GET /repos/{owner}/{repo}/contents/{path}', {
        owner: pull.owner, repo: pull.repo, path, ref: pull.baseSha,
      }); }
      catch (error) {
        // A missing file is configuration failure; a missing repository is access revocation.
        if (error instanceof GitHubAccessError && error.status === 404) { await readRepository(pull.installationId, pull.repositoryId); return null; }
        throw error;
      }
      const file = z.object({ type: z.literal('file'), encoding: z.literal('base64'), content: z.string(), size: z.number().int().nonnegative().max(1024 * 1024) }).parse(value);
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.length !== file.size) throw new Error('Invalid GitHub file length');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    },
    async readPermission(pull, login) {
      return z.object({ permission: z.string() }).parse(await request(pull.installationId, pull.repositoryId,
        'GET /repos/{owner}/{repo}/collaborators/{username}/permission', { owner: pull.owner, repo: pull.repo, username: login })).permission;
    },
    async readCheckRun(pull, id) {
      const check = z.object({ app: z.object({ id: apiId }), head_sha: sha,
        pull_requests: z.array(z.object({ number: z.number().int().positive() })) }).parse(await request(pull.installationId, pull.repositoryId,
        'GET /repos/{owner}/{repo}/check-runs/{check_run_id}', { owner: pull.owner, repo: pull.repo, check_run_id: id }));
      return { appId: check.app.id, headSha: check.head_sha, pullNumbers: check.pull_requests.map((item) => item.number) };
    },
    async listRepositories(installationId) {
      await assertInstallation(installationId);
      return (await pages(installationId, null, 'GET /installation/repositories', {}, 'repositories'))
        .map((value) => z.object({ id: apiId, owner: z.object({ id: apiId }) }).parse(value))
        .filter((repo) => owners.has(repo.owner.id))
        .map((repo) => ({ installationId, repositoryId: repo.id }));
    },
    async listOpenPulls(installationId, repositoryId) {
      const repo = await readRepository(installationId, repositoryId);
      return (await pages(installationId, repositoryId, 'GET /repos/{owner}/{repo}/pulls', { owner: repo.owner.login, repo: repo.name, state: 'open' }, null))
        .map((value) => z.object({ number: z.number().int().positive() }).parse(value).number);
    },
  };
}
