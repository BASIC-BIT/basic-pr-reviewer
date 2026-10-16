import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Manifest, PassRecord, PlannedPass } from '../src/contracts.js';
import { aggregateReview, planCoverage, splitScope } from '../src/passes.js';
import { fixture, policy, identity, service } from './fixtures/source.js';

function record(m: Manifest, spec: PlannedPass, failed = false): PassRecord {
  return { id: spec.id, identity: m.identity, spec, createdAt: 1, updatedAt: 1,
    outcome: { passId: spec.id, ...(failed ? { status: 'failed', failureCode: 'temporary' } as const : { status: 'completed', failureCode: null } as const),
      findings: spec.unitIds[0] ? [{ id: `finding-${spec.id}`, message: 'Synthetic interface mismatch.', severity: 'P2',
        location: { kind: 'summary', path: null }, evidence: [{ unitId: spec.unitIds[0], explanation: 'Synthetic evidence.' }] }] : [],
      priorFindingAssessments: [], model: { name: 'fixture', cliVersion: 'fixture' }, usage: { inputTokens: null, outputTokens: null } } };
}
const entries = [
  { path: 'packages/alpha/src/index.ts', text: 'alpha\n' },
  { path: 'packages/beta/src/index.ts', text: 'beta\n' },
];

describe('trusted coverage planning', { timeout: 120000 }, () => {
  it('reuses only completed compatible scope from an incomplete baseline and always schedules current integration', async () => {
    const f = await fixture([], entries), p = policy(), { source } = await service(f);
    const first = await source.captureManifest(identity(f, p), p);
    const initial = planCoverage(first, [], await source.verifyAncestry(first, []));
    const scopes = initial.freshPasses.filter((pass) => pass.kind === 'scope');
    expect(scopes).toHaveLength(2);
    const previous = scopes.map((pass, index) => record(first, pass, index === 1));
    const head = f.commit([...entries, { path: 'packages/beta/test/new.test.ts', text: 'new test\n' }], f.head);
    const current = await source.captureManifest({ ...identity(f, p), headSha: head, attemptId: '5', generation: 2 }, p);
    const plan = planCoverage(current, previous, await source.verifyAncestry(current, previous.map((pass) => pass.identity.headSha)));
    expect(plan.reusedPassIds).toEqual([previous[0]!.id]);
    expect(plan.invalidatedPassIds).toEqual([previous[1]!.id]);
    expect(plan.freshPasses.filter((pass) => pass.kind === 'scope').flatMap((pass) => pass.unitIds)).toHaveLength(2);
    expect(plan.freshPasses.filter((pass) => pass.kind === 'integration')).toHaveLength(1);
    expect(plan.uncoveredUnitIds).toHaveLength(2);
    const integration = plan.freshPasses.find((pass) => pass.kind === 'integration')!;
    const result = aggregateReview(current.identity, current, [...plan.reusedPasses,
      ...plan.freshPasses.map((pass) => record(current, pass, pass === integration))]);
    expect(result.complete).toBe(false);
    expect(result.integrationStatus).toBe('failed');
    expect(result.coveredUnitIds).toHaveLength(3);
    expect(result.reusedUnitIds).toEqual(previous[0]!.spec.unitIds);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.failureCodes).toContain('temporary');
  });

  it('plans without writing bundles and verifies exact narrowed readable context before running', async () => {
    const neighbors = [
      { path: 'packages/alpha/src/context.ts', text: 'alpha context' },
      { path: 'packages/beta/src/context.ts', text: 'beta context' },
      { path: 'shared/contracts.ts', text: 'shared contract' },
    ];
    const f = await fixture(neighbors, [...entries, ...neighbors]);
    const p = policy({ contextMode: 'allowlist', contextAllowGlobs: ['**'] }), { source, root } = await service(f);
    const m = await source.captureManifest(identity(f, p), p);
    const before = await readdir(root), plan = planCoverage(m, [], await source.verifyAncestry(m, []));
    expect(await readdir(root)).toEqual(before);
    const scope = plan.freshPasses.find((pass) => pass.kind === 'scope')!;
    expect(scope).not.toHaveProperty('bundlePath');
    const runnable = await source.materializePass(m, scope);
    const text = (await Promise.all(runnable.bundle.sourceMap.map((entry) => readFile(join(runnable.bundle.directory, entry.alias), 'utf8')))).join();
    expect(text).toContain('alpha context');
    expect(text).toContain('shared contract');
    expect(text).not.toContain('beta context');
    expect(runnable.spec.bundlePath).toBe(runnable.bundle.directory);
    expect(runnable.bundle.contextHash).toBe(scope.contextHash);
    await expect(source.materializePass(m, { ...scope, contextHash: '0'.repeat(64) })).rejects.toThrow(/descriptor|context/i);
    await expect(source.materializePass(m, { ...scope, initialAliases: ['../../host-config'] })).rejects.toThrow(/initial|descriptor/i);
    await expect(source.materializePass(m, { ...scope, kind: 'integration' })).rejects.toThrow(/integration/i);
    const integration = await source.materializePass(m, plan.freshPasses.find((pass) => pass.kind === 'integration')!);
    expect(integration.bundle.sourceMap.some((entry) => Buffer.from(entry.path.bytesBase64, 'base64').toString() === 'packages/beta/src/context.ts')).toBe(true);
  });

  it('invalidates force pushes, base, policy and runtime changes even when units remain identical', async () => {
    const f = await fixture([], entries), p = policy(), { source } = await service(f);
    const first = await source.captureManifest(identity(f, p), p);
    const previous = planCoverage(first, [], await source.verifyAncestry(first, [])).freshPasses.map((pass) => record(first, pass));
    const force = f.commit([...entries, { path: 'excluded/file', text: 'different lineage' }], f.merge);
    const current = await source.captureManifest({ ...identity(f, p), headSha: force, attemptId: '5', generation: 2 }, p);
    expect(planCoverage(current, previous, await source.verifyAncestry(current, [f.head])).reusedPassIds).toEqual([]);
    const proof = await source.verifyAncestry(first, [f.head]);
    for (const change of [{ baseSha: 'e'.repeat(40) }, { baseRef: 'release' }, { mergeBaseSha: 'e'.repeat(40) },
      { policyHash: 'e'.repeat(64) }, { runtimeHash: 'f'.repeat(64) }]) {
      const changed = { ...first, identity: { ...first.identity, ...change, attemptId: '6', generation: 2 } };
      expect(planCoverage(changed, previous, proof).reusedPassIds).toEqual([]);
    }
    expect(() => planCoverage(first, previous, { headSha: f.head, ancestors: [f.head] } as never)).toThrow(/ancestry/i);
  });

  it('invalidates the affected neighboring context and all scope for shared configuration changes', async () => {
    const context = { path: 'packages/alpha/src/context.ts', text: 'context v1' };
    const shared = { path: 'shared/contracts.ts', text: 'shared v1' };
    const f = await fixture([context, shared], [...entries, context, shared]);
    const p = policy({ contextMode: 'allowlist', contextAllowGlobs: ['**'] }), { source } = await service(f);
    const first = await source.captureManifest(identity(f, p), p);
    const previous = planCoverage(first, [], await source.verifyAncestry(first, [])).freshPasses.filter((pass) => pass.kind === 'scope').map((pass) => record(first, pass));
    for (const sharedChange of [false, true]) {
      const head = f.commit([...entries, { ...context, text: 'context v2' }, { ...shared, text: sharedChange ? 'shared v2' : shared.text }], f.head);
      const m = await source.captureManifest({ ...identity(f, p), headSha: head, attemptId: '5', generation: 2 }, p);
      const plan = planCoverage(m, previous, await source.verifyAncestry(m, [f.head]));
      expect(plan.reusedPassIds).toEqual(sharedChange ? [] : [previous[1]!.id]);
    }
  });

  it('drops removed hunks from the current denominator and requires exact current integration', async () => {
    const f = await fixture([], entries), p = policy(), { source } = await service(f);
    const first = await source.captureManifest(identity(f, p), p);
    const previous = planCoverage(first, [], await source.verifyAncestry(first, [])).freshPasses.map((pass) => record(first, pass));
    const head = f.commit([entries[0]!], f.head);
    const m = await source.captureManifest({ ...identity(f, p), headSha: head, attemptId: '5', generation: 2 }, p);
    const plan = planCoverage(m, previous, await source.verifyAncestry(m, [f.head]));
    expect(plan.reusedPassIds).toEqual([previous[0]!.id]);
    const pending = aggregateReview(m.identity, m, [...plan.reusedPasses, previous.at(-1)!]);
    expect(pending.complete).toBe(false);
    expect(pending.coveredUnitIds).toHaveLength(1);
    expect(pending.missingUnitIds).toEqual([]);
    const result = aggregateReview(m.identity, m, [...plan.reusedPasses, ...plan.freshPasses.map((pass) => record(m, pass))]);
    expect(result.complete).toBe(true);
    expect(result.coveredUnitIds).toHaveLength(1);
  });

  it('skips empty and policy-excluded comparisons without inference, but never skips retrieval failure', async () => {
    for (const docsOnly of [false, true]) {
      const f = await fixture([], docsOnly ? [{ path: 'guide.md', text: 'documentation' }] : []);
      const p = policy({ excludeDocsOnly: true }), { source } = await service(f);
      const m = await source.captureManifest(identity(f, p), p);
      expect(planCoverage(m, [], await source.verifyAncestry(m, [])).freshPasses).toEqual([]);
      expect(aggregateReview(m.identity, m, [])).toMatchObject({ status: 'skipped', reason: 'no_eligible_scope', complete: false, integrationStatus: 'not_required' });
      expect(aggregateReview(m.identity, m, []).exclusions).toHaveLength(docsOnly ? 1 : 0);
    }
    const f = await fixture([], entries), p = policy(), { source } = await service(f, { maxDiskBytes: 1 });
    const m = await source.captureManifest(identity(f, p), p);
    expect(planCoverage(m, [], await source.verifyAncestry(m, [])).freshPasses).toEqual([]);
    expect(aggregateReview(m.identity, m, [])).toMatchObject({ status: 'incomplete', complete: false });
    expect(aggregateReview(m.identity, m, []).missingScope).toEqual([{ path: null, code: 'disk_limit' }]);
  });

  it('preserves reviewed units and findings when optional context enumeration fails', async () => {
    const neighbors = Array.from({ length: 40 }, (_, i) => ({ path: `packages/alpha/context-${i}.ts`, text: 'context' }));
    const f = await fixture(neighbors, [...neighbors, entries[0]!]);
    const p = policy({ contextMode: 'allowlist', contextAllowGlobs: ['**'] }), { source } = await service(f, { maxGitOutputBytes: 1024 });
    const m = await source.captureManifest(identity(f, p), p);
    const plan = planCoverage(m, [], await source.verifyAncestry(m, []));
    const result = aggregateReview(m.identity, m, plan.freshPasses.map((pass) => record(m, pass)));
    expect(result.complete).toBe(false);
    expect(result.coveredUnitIds).toEqual([m.units[0]!.id]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.missingScope).toContainEqual({ path: null, code: 'context_git_output_limit' });
  });

  it('keeps binary and gitlink content exclusions distinct from unavailable review units', async () => {
    const seed = await fixture([], []);
    const f = await fixture([], [entries[0]!, { path: 'packages/beta/image.bin', text: Buffer.from([0, 1, 2]) },
      { path: 'packages/beta/submodule', text: seed.head, mode: '160000' }]);
    const p = policy({ contextMode: 'diff' }), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p);
    const plan = planCoverage(m, [], await source.verifyAncestry(m, []));
    const scopes = plan.freshPasses.filter((pass) => pass.kind === 'scope').map((pass) => record(m, pass));
    const integration = planCoverage(m, scopes, await source.verifyAncestry(m, [m.identity.headSha])).freshPasses;
    const records = [...scopes, ...integration.map((pass) => record(m, pass))];
    const result = aggregateReview(m.identity, m, records);
    expect(result.complete).toBe(true);
    expect(result.exclusions.map((item) => item.code)).toEqual(['binary_content', 'gitlink_content']);
    expect(result.missingScope).toEqual([]);
    const limited = await service(f, { maxBundleBytes: 10 });
    const missing = await limited.source.captureManifest(identity(f, p), p);
    const limitedPlan = planCoverage(missing, [], await limited.source.verifyAncestry(missing, []));
    const partial = aggregateReview(missing.identity, missing, limitedPlan.freshPasses.map((pass) => record(missing, pass)));
    expect(partial.complete).toBe(false);
    expect(partial.coveredUnitIds).toEqual([]);
    expect(partial.missingScope.some((item) => item.code === 'bundle_limit')).toBe(true);
  });

  it('splits a large module into bounded deterministic passes and retains every source unit', async () => {
    const text = Array.from({ length: 8000 }, (_, i) => `${i} ${'synthetic line '.repeat(6)}\n`).join('');
    const f = await fixture([], [{ path: 'src/alpha/source.ts', text }, { path: 'test/alpha/source.test.ts', text: 'test\n' }]);
    const p = policy(), { source, root } = await service(f);
    const m = await source.captureManifest(identity(f, p), p), proof = await source.verifyAncestry(m, []);
    const plan = planCoverage(m, [], proof), scopes = plan.freshPasses.filter((pass) => pass.kind === 'scope');
    expect(scopes.length).toBeGreaterThan(2);
    expect(new Set(scopes.map((pass) => pass.groupId)).size).toBe(1);
    expect(scopes.flatMap((pass) => pass.unitIds).sort()).toEqual(m.units.map((unit) => unit.id).sort());
    expect(scopes.every((pass) => pass.initialBytes <= 200 * 1024)).toBe(true);
    expect(planCoverage(m, [], proof)).toEqual(plan);
    expect((await readdir(root)).some((name) => name.startsWith('bundle-'))).toBe(false);
  });

  it('requires integration to receive current scope findings and rejects invented or partial assigned coverage', async () => {
    const f = await fixture([], entries), p = policy(), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p), proof = await source.verifyAncestry(m, [f.head]);
    const plan = planCoverage(m, [], proof), records = plan.freshPasses.map((pass) => record(m, pass));
    expect(aggregateReview(m.identity, m, records).complete).toBe(false);
    const scopes = records.filter((item) => item.spec.kind === 'scope');
    const integration = planCoverage(m, scopes, proof).freshPasses.find((pass) => pass.kind === 'integration')!;
    expect(integration.priorFindings).toHaveLength(2);
    expect(integration.id).not.toBe(plan.freshPasses.find((pass) => pass.kind === 'integration')!.id);
    expect(aggregateReview(m.identity, m, [...scopes, record(m, integration)]).complete).toBe(true);
    const wrong = structuredClone(scopes[0]!);
    wrong.spec.unitIds = [];
    expect(aggregateReview(m.identity, m, [wrong, scopes[1]!, record(m, integration)]).complete).toBe(false);
    const invented = structuredClone(scopes[0]!);
    (invented.outcome as unknown as { coverage: string[] }).coverage = m.units.map((unit) => unit.id);
    expect(aggregateReview(m.identity, m, [invented, scopes[1]!, record(m, integration)]).complete).toBe(false);
  });

  it('invalidates independent groups for root configuration and unknown-impact changes even in diff-only mode', async () => {
    const f = await fixture([], entries), p = policy({ contextMode: 'diff' }), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p);
    const previous = planCoverage(m, [], await source.verifyAncestry(m, [])).freshPasses.filter((pass) => pass.kind === 'scope').map((pass) => record(m, pass));
    for (const path of ['package.json', 'unclassified/setup/file']) {
      const head = f.commit([...entries, { path, text: 'changed configuration' }], f.head);
      const next = await source.captureManifest({ ...identity(f, p), headSha: head, attemptId: '5', generation: 2 }, p);
      expect(planCoverage(next, previous, await source.verifyAncestry(next, [f.head])).reusedPassIds).toEqual([]);
    }
  });

  it('reuses completed smaller scopes after exhaustion and schedules only their unfinished units', async () => {
    const f = await fixture([], [entries[0]!, { path: 'packages/alpha/test/index.test.ts', text: 'test\n' }]);
    const p = policy(), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p), proof = await source.verifyAncestry(m, [f.head]);
    const initial = planCoverage(m, [], proof), parent = initial.freshPasses[0]!;
    const split = splitScope(m, parent);
    expect(split).toHaveLength(2);
    expect(split.every((pass) => pass.unitIds.length === 1)).toBe(true);
    expect(splitScope(m, split[0]!)).toEqual([]);
    const parentFailure = record(m, parent, true);
    const previous = split.map((pass, index) => record(m, pass, index === 1));
    const resumed = planCoverage(m, previous, proof);
    expect(resumed.reusedPassIds).toEqual([previous[0]!.id]);
    expect(resumed.freshPasses.filter((pass) => pass.kind === 'scope').flatMap((pass) => pass.unitIds)).toEqual(split[1]!.unitIds);
    const scopes = [previous[0]!, record(m, resumed.freshPasses[0]!)];
    const integration = planCoverage(m, [parentFailure, ...scopes], proof).freshPasses.find((pass) => pass.kind === 'integration')!;
    const result = aggregateReview(m.identity, m, [parentFailure, ...scopes, record(m, integration)]);
    expect(result.complete).toBe(true);
    expect(result.coveredUnitIds).toHaveLength(2);
    expect(result.findings.some((finding) => finding.id === parentFailure.outcome.findings[0]!.id)).toBe(true);
    const overlapping = planCoverage(m, [{ ...previous[0]!, updatedAt: 2 }, record(m, parent)], proof);
    expect(overlapping.freshPasses.map((pass) => pass.kind)).toEqual(['integration']);
  });

  it('preserves completed scope coverage when only the full integration bundle exceeds its resource limit', async () => {
    const f = await fixture([], [{ path: 'packages/alpha/file.ts', text: 'a'.repeat(1100) }, { path: 'packages/beta/file.ts', text: 'b'.repeat(1100) }]);
    const p = policy({ contextMode: 'diff' }), { source } = await service(f, { maxBundleBytes: 1800 });
    const m = await source.captureManifest(identity(f, p), p), proof = await source.verifyAncestry(m, [f.head]);
    const scopes = planCoverage(m, [], proof).freshPasses.filter((pass) => pass.kind === 'scope').map((pass) => record(m, pass));
    expect(scopes.every((item) => item.spec.omissions.length === 0)).toBe(true);
    const integration = planCoverage(m, scopes, proof).freshPasses.find((pass) => pass.kind === 'integration')!;
    const result = aggregateReview(m.identity, m, [...scopes, record(m, integration)]);
    expect(result.coveredUnitIds).toHaveLength(2);
    expect(result.findings.length).toBeGreaterThanOrEqual(2);
    expect(result.integrationStatus).toBe('incomplete');
    expect(result.complete).toBe(false);
    expect(result.missingScope.some((item) => item.code === 'bundle_limit')).toBe(true);
  });
});
