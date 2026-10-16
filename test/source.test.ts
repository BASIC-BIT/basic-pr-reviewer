import { readFile, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSourceService } from '../src/source.js';
import { fixture, policy, identity, service } from './fixtures/source.js';
import type { Entry } from './fixtures/source.js';

describe('immutable inert Git source', { timeout: 120000 }, () => {
  it('uses merge base, ignores export-ignore/attributes and creates stable byte-safe units', async () => {
    const f = await fixture([{ path: 'kept.txt', text: 'old\n' }], [
      { path: 'kept.txt', text: 'new\n' }, { path: '.gitattributes', text: '* export-ignore diff=hostile filter=hostile\n' },
      { path: 'Case', text: 'one\n' }, { path: 'case', text: 'two\n' },
      { path: '..like', text: 'three\n' }, { path: Buffer.from([0xff, 0x61]), text: 'bytes\n' },
      { path: 'AGENTS.md', text: 'hostile instruction' }, { path: '.claude-review', text: 'planted result' },
      { path: 'link', text: '../../outside-secret', mode: '120000' },
    ], [{ path: 'base-only.txt', text: 'do not include' }]);
    const p = policy(), { source, root } = await service(f);
    const manifest = await source.captureManifest(identity(f, p), p);
    expect(manifest.retrievalFailures).toEqual([]);
    expect(manifest.units).toHaveLength(9);
    expect(manifest.sourceMap.some((item) => item.path.bytesBase64 === Buffer.from([0xff, 0x61]).toString('base64'))).toBe(true);
    const bundle = await source.materializeBundle(manifest, manifest.units.map((unit) => unit.id));
    expect(bundle.allowedReadScope).toEqual([bundle.directory]);
    expect(new Set(bundle.sourceMap.map((item) => item.alias)).size).toBe(bundle.sourceMap.length);
    for (const item of bundle.sourceMap) {
      const path = join(bundle.directory, item.alias);
      expect((await lstat(path)).isSymbolicLink()).toBe(false);
      expect(item.alias).toMatch(/^(data|quarantine)\/[0-9a-f]{64}\.(old|new|diff)\.txt$/);
    }
    expect(bundle.sourceMap.find((item) => item.path.bytesBase64 === Buffer.from('AGENTS.md').toString('base64'))?.alias).toMatch(/^quarantine\//);
    const again = await source.captureManifest({ ...identity(f, p), attemptId: '5', generation: 2 }, p);
    expect(again.units.map((unit) => unit.id)).toEqual(manifest.units.map((unit) => unit.id));
    await source.destroyWorkspace(bundle.directory);
    await source.destroyWorkspace(manifest.workspace);
    await source.destroyWorkspace(again.workspace);
    expect(await readdir(root)).toEqual([]);
  });
  it('accounts for over 3000 files and 500000 diff bytes without API patches', async () => {
    const files = Array.from({ length: 3005 }, (_, index) => ({ path: `file-${index}.txt`, text: `${'synthetic '.repeat(35)}\n` }));
    const f = await fixture([], files), p = policy(), { source } = await service(f);
    const manifest = await source.captureManifest(identity(f, p), p);
    expect(manifest.units).toHaveLength(3005);
    expect(manifest.retrievalFailures).toEqual([]);
    expect(manifest.units.reduce((sum, unit) => sum + unit.diffBytes, 0)).toBeGreaterThan(500000);
  }, 120000);
  it('records rename, delete, binary, gitlink and explicit excluded dispositions', async () => {
    const seed = await fixture([], []);
    const f = await fixture([{ path: 'before', text: 'rename me\n' }, { path: 'gone', text: 'delete me\n' }], [
      { path: 'after', text: 'rename me\n' }, { path: 'binary', text: Buffer.from([0, 1, 2]) },
      { path: 'module', text: seed.head, mode: '160000' }, { path: 'ignored.md', text: 'excluded' },
    ]);
    const p = policy({ excludeGlobs: ['*.md'] }), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p);
    expect(m.retrievalFailures).toEqual([]);
    expect(m.units.map((unit) => unit.kind).sort()).toEqual(['binary', 'delete', 'gitlink', 'rename']);
    expect(m.exclusions).toHaveLength(1);
    expect(m.sourceMap).toHaveLength(5);
    expect(m.units.find((unit) => unit.kind === 'rename')?.oldPath?.bytesBase64).toBe(Buffer.from('before').toString('base64'));
  });
  it('fails closed for missing objects, incorrect merge base and policy identity', async () => {
    const f = await fixture([], [{ path: 'file', text: 'new' }]), p = policy(), { source } = await service(f);
    const missing = await source.captureManifest({ ...identity(f, p), headSha: 'f'.repeat(40) }, p);
    expect(missing.retrievalFailures.length).toBeGreaterThan(0);
    const wrong = await source.captureManifest({ ...identity(f, p), mergeBaseSha: f.head }, p);
    expect(wrong.retrievalFailures).toEqual([{ path: null, code: 'comparison_mismatch' }]);
    await expect(source.captureManifest(identity(f, p), { ...p, policy: { ...p.policy, contextMode: 'diff' } })).rejects.toThrow('policy');
  });
  it('restricts private context before materializing and hashes all readable files', async () => {
    const f = await fixture([{ path: 'unchanged-secret', text: 'PRIVATE' }, { path: 'changed', text: 'old\n' }],
      [{ path: 'unchanged-secret', text: 'PRIVATE' }, { path: 'changed', text: 'new\n' }]);
    const p = policy({ contextMode: 'diff' }), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p), b = await source.materializeBundle(m, m.units.map((unit) => unit.id));
    expect(b.sourceMap.every((item) => item.side === 'diff')).toBe(true);
    expect((await Promise.all(b.sourceMap.map((item) => readFile(join(b.directory, item.alias), 'utf8')))).join()).not.toContain('PRIVATE');
    expect((await source.materializeBundle(m, m.units.map((unit) => unit.id))).contextHash).toBe(b.contextHash);
    await expect(source.materializeBundle(m, ['untrusted-unit'])).rejects.toThrow('unit');
    await expect(source.destroyWorkspace(join(m.workspace, '..'))).rejects.toThrow('workspace');
  });
  it('records limits, leaves other scope reviewable and removes abandoned workspaces at startup', async () => {
    const f = await fixture([], [{ path: 'large', text: 'x'.repeat(30000) }, { path: 'small', text: 'ok\n' }]);
    const p = policy(), { source, root } = await service(f, { maxBlobBytes: 10000 });
    const m = await source.captureManifest(identity(f, p), p);
    expect(m.retrievalFailures).toHaveLength(1);
    expect(m.sourceMap).toHaveLength(2);
    expect(m.units).toHaveLength(1);
    await source.materializeBundle(m, m.units.map((unit) => unit.id));
    await createSourceService({ root });
    expect(await readdir(root)).toEqual([]);
  });
  it('quarantines nested startup files and a planted review result as ordinary source data', async () => {
    const files = ['nested/CLAUDE.md', 'nested/AGENTS.md', '.claude/settings.json', '.mcp.json', '.claude-review/review.md'].map((path) => ({ path, text: `UNTRUSTED ${path}` }));
    const f = await fixture([], files), p = policy(), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p), b = await source.materializeBundle(m, m.units.map((unit) => unit.id));
    expect(m.retrievalFailures).toEqual([]);
    expect(m.sourceMap).toHaveLength(files.length);
    expect(b.sourceMap.every((entry) => entry.alias.startsWith('quarantine/'))).toBe(true);
    const planted = b.sourceMap.find((entry) => entry.path.bytesBase64 === Buffer.from('.claude-review/review.md').toString('base64') && entry.side === 'new');
    expect(planted && await readFile(join(b.directory, planted.alias), 'utf8')).toBe('UNTRUSTED .claude-review/review.md');
    expect(await readdir(b.directory)).toEqual(['data', 'quarantine']);
  });
  it('only admits allowlisted neighboring context and rejects changed manifest authority', async () => {
    const old = [{ path: 'changed', text: 'old\n' }, { path: 'allowed/context.txt', text: 'ALLOWED' }, { path: 'private/secret', text: 'SECRET' }];
    const f = await fixture(old, [{ path: 'changed', text: 'new\n' }, ...old.slice(1)]), p = policy({ contextMode: 'allowlist', contextAllowGlobs: ['allowed/**'] }), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p), b = await source.materializeBundle(m, m.units.map((unit) => unit.id));
    expect(b.sourceMap.some((entry) => entry.path.bytesBase64 === Buffer.from('allowed/context.txt').toString('base64'))).toBe(true);
    expect(b.sourceMap.some((entry) => entry.path.bytesBase64 === Buffer.from('private/secret').toString('base64'))).toBe(false);
    m.identity.policyHash = 'f'.repeat(64);
    await expect(source.materializeBundle(m, m.units.map((unit) => unit.id))).rejects.toThrow('manifest');
  });
  it('splits a huge hunk without losing bytes and reports bundle omissions', async () => {
    const text = `${'large-line '.repeat(60000)}\n`, f = await fixture([], [{ path: 'huge', text }]), p = policy({ contextMode: 'diff' }), { source } = await service(f, { maxBundleBytes: 140000 });
    const m = await source.captureManifest(identity(f, p), p);
    expect(m.retrievalFailures).toEqual([]);
    expect(m.units.length).toBeGreaterThan(4);
    expect(m.units.every((unit) => unit.diffBytes <= 128 * 1024)).toBe(true);
    expect(m.units.reduce((sum, unit) => sum + unit.diffBytes, 0)).toBeGreaterThan(Buffer.byteLength(text));
    const b = await source.materializeBundle(m, m.units.map((unit) => unit.id));
    expect(b.omissions.some((entry) => entry.code === 'bundle_limit')).toBe(true);
    expect(new Set(b.sourceMap.flatMap((entry) => entry.unitIds)).size).toBeLessThan(m.units.length);
    for (const entry of b.sourceMap) expect(await readFile(join(b.directory, entry.alias), 'utf8')).toMatch(/^diff --git [\s\S]+@@ /);
  });
  it('cleans aborted capture and materialization without deleting unrelated directories', async () => {
    const f = await fixture([], [{ path: 'file', text: 'new\n' }]), p = policy(), { source, root } = await service(f);
    const aborted = new AbortController(); aborted.abort();
    await expect(source.captureManifest(identity(f, p), p, aborted.signal)).rejects.toThrow('cancelled');
    expect(await readdir(root)).toEqual([]);
    const m = await source.captureManifest(identity(f, p), p);
    await expect(source.materializeBundle(m, m.units.map((unit) => unit.id), aborted.signal)).rejects.toThrow();
    expect((await readdir(root)).every((name) => name.startsWith('capture-'))).toBe(true);
    await expect(source.destroyWorkspace(f.directory)).rejects.toThrow('workspace');
  });
  it('uses Git slash semantics and excludes ambiguous names under a private exclusion policy', async () => {
    const privatePath = Buffer.concat([Buffer.from('private/'), Buffer.from([0xff])]);
    const old = [{ path: 'allowed/good', text: 'GOOD' }, { path: 'allowed\\secret', text: 'BAD' }];
    const f = await fixture(old, [...old, { path: privatePath, text: 'HIDDEN' }, { path: 'changed', text: 'ok' }]);
    const p = policy({ contextMode: 'allowlist', contextAllowGlobs: ['allowed/**'], excludeGlobs: ['private/**'] }), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p), b = await source.materializeBundle(m, m.units.map((unit) => unit.id));
    expect(m.retrievalFailures).toEqual([]);
    expect(m.exclusions.some((entry) => entry.path?.bytesBase64 === privatePath.toString('base64'))).toBe(true);
    expect(b.sourceMap.some((entry) => entry.path.bytesBase64 === Buffer.from('allowed\\secret').toString('base64'))).toBe(false);
  });
  it('caps generated diff memory as well as unique blobs and keeps smaller remaining changes', async () => {
    const f = await fixture([], Array.from({ length: 12 }, (_, index) => ({ path: `file${index}`, text: 'x'.repeat(1500) })));
    const p = policy(), { source } = await service(f, { maxCaptureBytes: 6000 });
    const m = await source.captureManifest(identity(f, p), p);
    expect(m.sourceMap).toHaveLength(12);
    expect(m.units.length).toBeGreaterThan(0);
    expect(m.retrievalFailures.length).toBeGreaterThan(0);
    expect(m.sourceMap.filter((item) => item.disposition === 'review').length + m.retrievalFailures.length).toBe(12);
  });
  it('budgets retained raw diffs and patch pieces across many distinct exhausted blob pairs', async () => {
    const texts = Array.from({ length: 8 }, (_, index) => `${String.fromCharCode(65 + index).repeat(1500)}\n`);
    const old: Entry[] = [{ path: '000-small', text: 'old\n' }], changed: Entry[] = [{ path: '000-small', text: 'new\n' }];
    for (const [left, before] of texts.entries()) for (const [right, after] of texts.entries()) if (left !== right) {
      const path = `pair-${left}-${right}`;
      old.push({ path, text: before }); changed.push({ path, text: after });
    }
    const maxCaptureBytes = 20000, f = await fixture(old, changed), p = policy(), { source } = await service(f, { maxCaptureBytes });
    const m = await source.captureManifest(identity(f, p), p);
    const uniqueBlobBytes = [...texts, 'old\n', 'new\n'].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    // Each fixture pair produces one small hunk, so its raw diff and patch piece have equal length.
    const retainedRawDiffs = new Map(m.units.map((unit) => [`${unit.oldBlobId}:${unit.newBlobId}`, unit.diffBytes]));
    const retainedBytes = uniqueBlobBytes + m.units.reduce((sum, unit) => sum + unit.diffBytes, 0) + [...retainedRawDiffs.values()].reduce((sum, bytes) => sum + bytes, 0);
    expect(m.sourceMap).toHaveLength(57);
    expect(m.units.some((unit) => unit.path.bytesBase64 === Buffer.from('000-small').toString('base64'))).toBe(true);
    expect(m.retrievalFailures.length).toBeGreaterThan(40);
    expect(m.sourceMap.filter((item) => item.disposition === 'review').length + m.retrievalFailures.length).toBe(57);
    expect(retainedBytes).toBeLessThanOrEqual(maxCaptureBytes);
    expect(m.retrievalFailures.every((failure) => failure.code === 'capture_limit')).toBe(true);
  });
  it('preserves changed scope when optional allowlist enumeration exceeds the Git output ceiling', async () => {
    const neighbors = Array.from({ length: 40 }, (_, index) => ({ path: `neighbors/file-${index}.txt`, text: 'unchanged\n' }));
    const f = await fixture(neighbors, [...neighbors, { path: 'changed', text: 'review this\n' }]);
    const limits = { maxGitOutputBytes: 1024 }, p = policy({ contextMode: 'allowlist', contextAllowGlobs: ['neighbors/**'] }), { source, root } = await service(f, limits);
    const m = await source.captureManifest(identity(f, p), p);
    expect(m.sourceMap).toHaveLength(1);
    expect(m.sourceMap[0]?.disposition).toBe('review');
    expect(m.units).toHaveLength(1);
    expect(m.retrievalFailures).toEqual([{ path: null, code: 'context_git_output_limit' }]);
    const b = await source.materializeBundle(m, m.units.map((unit) => unit.id));
    expect(b.omissions).toContainEqual({ path: null, code: 'context_git_output_limit' });
    expect(b.sourceMap.every((entry) => entry.path.bytesBase64 === Buffer.from('changed').toString('base64'))).toBe(true);
    await source.destroyWorkspace(b.directory); await source.destroyWorkspace(m.workspace);
    expect(await readdir(root)).toEqual([]);
  });
  it('retains selected unit and readable-context hashes across unrelated heads and attempts', async () => {
    const f = await fixture([], [{ path: 'selected', text: 'same selected change\n' }]), p = policy({ excludeGlobs: ['excluded/**'] }), { source } = await service(f);
    const first = await source.captureManifest(identity(f, p), p);
    const firstBundle = await source.materializeBundle(first, first.units.map((unit) => unit.id));
    const nextHead = f.commit([{ path: 'selected', text: 'same selected change\n' }, { path: 'excluded/other', text: 'unrelated' }], f.merge);
    const next = await source.captureManifest({ ...identity(f, p), headSha: nextHead, attemptId: '50', generation: 4 }, p);
    expect(next.units.map((unit) => unit.id)).toEqual(first.units.map((unit) => unit.id));
    expect((await source.materializeBundle(next, first.units.map((unit) => unit.id))).contextHash).toBe(firstBundle.contextHash);
  });
  it('ignores inherited diff/textconv/filter configuration and LFS/export attributes', async () => {
    const f = await fixture([], [{ path: '.gitattributes', text: '* export-ignore diff=hostile filter=lfs\n' }, { path: 'file', text: 'ordinary source\n' }]);
    vi.stubEnv('GIT_EXTERNAL_DIFF', 'must-never-execute');
    vi.stubEnv('GIT_CONFIG_COUNT', '3');
    for (const [index, key] of ['diff.external', 'diff.hostile.textconv', 'filter.lfs.smudge'].entries()) {
      vi.stubEnv(`GIT_CONFIG_KEY_${index}`, key); vi.stubEnv(`GIT_CONFIG_VALUE_${index}`, 'must-never-execute');
    }
    const p = policy(), { source } = await service(f), m = await source.captureManifest(identity(f, p), p);
    expect(m.retrievalFailures).toEqual([]); expect(m.sourceMap).toHaveLength(2);
    const b = await source.materializeBundle(m, m.units.map((unit) => unit.id));
    expect((await Promise.all(b.sourceMap.map((entry) => readFile(join(b.directory, entry.alias), 'utf8')))).join()).toContain('ordinary source');
  });
  it('splits large multiline hunks into overlapping real line ranges', async () => {
    const text = Array.from({ length: 6000 }, (_, index) => `${index} ${'line content '.repeat(6)}\n`).join('');
    const f = await fixture([], [{ path: 'file', text }]), p = policy({ contextMode: 'diff' }), { source } = await service(f);
    const m = await source.captureManifest(identity(f, p), p);
    expect(m.retrievalFailures).toEqual([]);
    expect(m.units.length).toBeGreaterThan(3);
    let coveredThrough = 1;
    for (const unit of m.units) {
      expect(unit.oldLines).toEqual({ start: 0, count: 0 });
      expect(unit.newLines.start).toBeLessThanOrEqual(coveredThrough);
      expect(unit.diffBytes).toBeLessThanOrEqual(128 * 1024);
      coveredThrough = unit.newLines.start + unit.newLines.count;
    }
    expect(coveredThrough).toBe(6001);
  });
  it('reports a disk safeguard and removes its captured repository', async () => {
    const f = await fixture([], [{ path: 'file', text: 'synthetic\n' }]), p = policy(), { source, root } = await service(f, { maxDiskBytes: 1 });
    expect((await source.captureManifest(identity(f, p), p)).retrievalFailures).toEqual([{ path: null, code: 'disk_limit' }]);
    expect(await readdir(root)).toEqual([]);
  });
});
