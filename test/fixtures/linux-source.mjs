import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { createSourceService } from '../../dist/source.js';
import { repoPolicySchema } from '../../dist/contracts.js';
import { planCoverage } from '../../dist/passes.js';

assert.equal(process.getuid(), 1000);
const remote = '/handoff/remote.git';
function git(directory, args, input) {
  const result = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=fixture@example.invalid', '--git-dir', directory, ...args],
    { input, env: { PATH: process.env.PATH, HOME: '/tmp', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(result.status, 0, 'Synthetic Git command failed'); return result.stdout;
}
git(remote, ['init', '--bare', '--template=']);
const emptyTree = git(remote, ['mktree'], '').toString().trim();
const base = git(remote, ['commit-tree', emptyTree], 'synthetic base').toString().trim();
const blob = git(remote, ['hash-object', '-w', '--stdin'], 'synthetic source\n').toString().trim();
const tree = git(remote, ['mktree'], `100644 blob ${blob}\tfile.ts\n`).toString().trim();
const head = git(remote, ['commit-tree', tree, '-p', base], 'synthetic head').toString().trim();
const policy = repoPolicySchema.parse({ schemaVersion: 1, enabled: true });
const trusted = { policy, instructions: [], policyHash: createHash('sha256').update(JSON.stringify({ policy, instructions: [] })).digest('hex') };
const identity = { installationId: '1', repositoryId: '2', owner: 'synthetic', repo: 'fixture', pullNumber: 3,
  headSha: head, baseSha: base, mergeBaseSha: base, baseRef: 'main', policyHash: trusted.policyHash,
  runtimeHash: 'a'.repeat(64), attemptId: '4', generation: 1 };
const source = await createSourceService({ root: '/handoff/source', fetch: async ({ directory }) => {
  git(directory, ['index-pack', '--stdin'], git(remote, ['pack-objects', '--stdout', '--revs'], `${base}\n${head}\n`));
} });
const manifest = await source.captureManifest(identity, trusted);
const pass = planCoverage(manifest, [], await source.verifyAncestry(manifest, [])).freshPasses.find(pass => pass.kind === 'scope');
assert.ok(pass);
const { bundle } = await source.materializePass(manifest, pass);
assert.equal(statSync(bundle.directory).uid, 1000);
assert.equal(statSync(bundle.directory).mode & 0o777, 0o500);
for (const entry of bundle.sourceMap) {
  const stat = statSync(`${bundle.directory}/${entry.alias}`);
  assert.equal(stat.uid, 1000); assert.equal(stat.mode & 0o777, 0o400);
}
writeFileSync('/handoff/materialized.json', JSON.stringify({ subpath: bundle.directory.slice('/handoff/'.length), aliases: bundle.sourceMap.map(entry => entry.alias) }));
await source.destroyWorkspace(manifest.workspace);
