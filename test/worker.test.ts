import { describe, expect, it } from 'vitest';
import { validateOutcome, runBounded, profile, passPrompt } from '../src/worker.js';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spec as base } from './fixtures/identities.js';
import { outcome as saved } from './fixtures/identities.js';
import { navigationAlias, renderNavigation } from '../src/source.js';

const spec = base;
const terminal = (changes = {}) => Buffer.from(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
  structured_output: { findings: [], priorFindingAssessments: [] }, modelUsage: { [profile.model]: { inputTokens: 5, outputTokens: 3 } }, ...changes }));

describe('worker output boundary', () => {
  it('accepts only a successful structured result with the pinned model', () => {
    expect(validateOutcome(terminal(), spec)).toMatchObject({ status: 'completed', findings: [], model: { name: profile.model } });
  });
  it('accepts the pinned CLI null API status only with independently successful output', () => {
    expect(validateOutcome(terminal({ terminal_reason: 'completed', api_error_status: null }), spec).status).toBe('completed');
    expect(validateOutcome(terminal({ is_error: true, terminal_reason: 'api_error', api_error_status: null }), spec).status).toBe('failed');
    expect(validateOutcome(terminal({ api_error_status: null }), spec, 1).status).toBe('failed');
    for (const api_error_status of [399, 600, '401']) expect(validateOutcome(terminal({ api_error_status }), spec).status).toBe('failed');
  });
  it('classifies observed CLI authentication and quota metadata on nonzero exits without accepting findings', () => {
    for (const [status, code] of [[401, 'authentication_failure'], [429, 'quota_limited']] as const) {
      const raw = terminal({ is_error: true, terminal_reason: 'api_error', api_error_status: status, result: 'SECRET_RAW_ERROR' });
      const result = validateOutcome(raw, spec, 1);
      expect(result).toMatchObject({ status: 'failed', failureCode: code, findings: [] });
      expect(JSON.stringify(result)).not.toContain('SECRET_RAW_ERROR');
    }
    expect(validateOutcome(terminal(), spec, 1).status).toBe('failed');
    expect(validateOutcome(terminal({ structured_output: { findings: [], priorFindingAssessments: [], api_error_status: 401 } }), spec).failureCode).toBe('invalid_output');
  });
  it('keeps independently validated structured findings on exhaustion without certifying coverage', () => {
    const { id: _id, ...finding } = saved.findings[0]!;
    const raw = terminal({ subtype: 'error_max_turns', is_error: true, structured_output: { findings: [finding], priorFindingAssessments: [] } });
    expect(validateOutcome(raw, spec, 1)).toMatchObject({ status: 'incomplete', failureCode: 'turn_limit', findings: [expect.objectContaining({ message: finding.message })] });
    expect(validateOutcome(terminal({ subtype: 'error_max_turns', modelUsage: {} }), spec, 1).findings).toEqual([]);
  });
  it('assigns stable service IDs and verifies finding paths, lines and evidence', () => {
    const original = saved.findings[0];
    if (!original) throw new Error('missing fixture');
    const { id: _id, ...finding } = original;
    const encode = (value: unknown) => terminal({ structured_output: { findings: [value], priorFindingAssessments: [] } });
    const good = validateOutcome(encode(finding), spec);
    expect(good.status).toBe('completed');
    expect(good.findings[0]?.id).toMatch(/^[a-f0-9]{64}$/);
    expect(validateOutcome(encode(finding), spec)).toEqual(good);
    for (const invalid of [
      { ...finding, id: 'model-controlled-id' },
      { ...finding, evidence: [{ unitId: 'foreign', explanation: 'invented' }] },
      { ...finding, location: { kind: 'line', path: { bytesBase64: 'Zm9yZWlnbg==' }, side: 'RIGHT', startLine: 2, endLine: 2 } },
      { ...finding, location: { ...finding.location, startLine: 4, endLine: 4 } },
      { ...finding, location: { ...finding.location, side: 'LEFT' } },
      { ...finding, priorFindingId: 'foreign' },
    ]) expect(validateOutcome(encode(invalid), spec).status).toBe('failed');
  });
  it('rejects forged materialized assignments and unknown prior assessments', () => {
    expect(validateOutcome(terminal(), { ...spec, reviewUnits: [] }).status).toBe('failed');
    expect(validateOutcome(terminal({ structured_output: { findings: [], priorFindingAssessments: [{ findingId: 'foreign', assessment: 'fixed' }] } }), spec).status).toBe('failed');
  });
  it.each([
    ['is_error', terminal({ is_error: true })],
    ['exhausted', terminal({ subtype: 'error_max_turns' })],
    ['malformed', Buffer.from('SENTINEL_SECRET')],
    ['empty', Buffer.alloc(0)],
    ['fallback', terminal({ structured_output: undefined, result: '{"findings":[]}' })],
    ['schema', terminal({ structured_output: { findings: [], priorFindingAssessments: [], coverage: ['all'] } })],
    ['model', terminal({ modelUsage: { invented: { inputTokens: 5, outputTokens: 3 } } })],
    ['oversized', Buffer.alloc(2 * 1024 * 1024 + 1)],
  ])('rejects %s without leaking raw text', (_name, raw) => {
    const outcome = validateOutcome(raw, spec);
    expect(outcome.status).not.toBe('completed');
    expect(JSON.stringify(outcome)).not.toContain('SENTINEL_SECRET');
  });
});

describe('bounded fake CLI execution', () => {
  const execute = (code: string, signal = new AbortController().signal, timeoutMs = 2000) =>
    runBounded(process.execPath, ['-e', code], { signal, timeoutMs, env: {}, input: 'input over stdin' });
  it('uses stdin and captures normal output', async () => {
    const result = await execute("process.stdin.on('data', b=>process.stdout.write(b))");
    expect(result.kind).toBe('exited');
    if (result.kind === 'exited') expect(result.stdout.toString()).toBe('input over stdin');
  });
  it('does not expose failing process stderr', async () => {
    const result = await execute("process.stderr.write('SENTINEL_SECRET');process.exit(1)");
    expect(result).toEqual({ kind: 'failed', code: 'process_failure' });
  });
  it('bounds output before concatenating or parsing', async () => {
    expect(await execute("process.stdout.write(Buffer.alloc(3*1024*1024))")).toEqual({ kind: 'failed', code: 'output_limit' });
  });
  it('times out a hanging process', async () => {
    expect(await execute('setInterval(()=>{},1000)', undefined, 50)).toEqual({ kind: 'failed', code: 'timeout' });
  });
  it.skipIf(process.platform === 'win32')('kills the timed-out process group including children holding its output pipe', async () => {
    expect(await execute("require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)", undefined, 250))
      .toEqual({ kind: 'failed', code: 'timeout' });
  });
  it('honors cancellation', async () => {
    const controller = new AbortController();
    const promise = execute('setInterval(()=>{},1000)', controller.signal);
    controller.abort();
    expect(await promise).toEqual({ kind: 'failed', code: 'cancelled' });
  });
});

describe('verified materialized input', () => {
  it('bounds large integration metadata and findings by serialized UTF-8 bytes', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'worker-large-')));
    try {
      await mkdir(join(directory, 'data')); await mkdir(join(directory, 'quarantine'));
      const reviewUnits = Array.from({ length: 3000 }, (_, i) => ({ ...spec.reviewUnits[0]!, id: createHash('sha256').update(String(i)).digest('hex') }));
      const sourceMap = reviewUnits.map(unit => ({ alias: `data/${unit.id}.diff.txt`, path: unit.path,
        side: 'diff' as const, unitIds: [unit.id], contentHash: createHash('sha256').update('synthetic diff').digest('hex') }));
      await Promise.all(sourceMap.map(entry => writeFile(join(directory, entry.alias), 'synthetic diff')));
      const materialized = { ...spec, kind: 'integration' as const, bundlePath: directory, sourceMap,
        reviewUnits, unitIds: reviewUnits.map(unit => unit.id),
        priorFindings: Array.from({ length: 3000 }, (_, i) => ({ ...saved.findings[0]!, id: `current-${i}`, message: 'quoted "\\\n文'.repeat(30) })),
        assessmentFindings: Array.from({ length: 3000 }, (_, i) => ({ ...saved.findings[0]!, id: `retained-${i}` })) };
      await writeFile(join(directory, navigationAlias), renderNavigation(materialized));
      const prompt = await passPrompt(materialized);
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(256 * 1024);
      expect(JSON.parse(prompt)).not.toHaveProperty('units');
      expect(JSON.parse(prompt)).not.toHaveProperty('priorFindings');
      const navigation = JSON.parse(renderNavigation(materialized));
      expect(navigation.units).toEqual(reviewUnits);
      expect(navigation.sourceMap).toEqual(sourceMap);
      expect(navigation.priorFindings).toEqual(materialized.priorFindings);
      expect(navigation.assessmentFindings).toEqual(materialized.assessmentFindings);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('passes 200 KiB of inert source and captured instructions through stdin, rejecting tampering and extra files', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'worker-prompt-')));
    try {
      await mkdir(join(directory, 'data')); await mkdir(join(directory, 'quarantine'));
      const alias = `data/${'a'.repeat(64)}.diff.txt`, text = 'x'.repeat(200 * 1024);
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      const materialized = { ...spec, bundlePath: directory, initialBytes: Buffer.byteLength(text), initialAliases: [alias],
        sourceMap: [{ alias, path: { bytesBase64: 'YS50cw==' }, side: 'diff' as const, unitIds: spec.unitIds, contentHash: hash(text) }],
        trustedInstructions: [{ path: 'AGENTS.md', text: 'Captured trusted guidance', hash: hash('Captured trusted guidance') }] };
      await writeFile(join(directory, alias), text);
      await writeFile(join(directory, navigationAlias), renderNavigation(materialized));
      const prompt = await passPrompt(materialized);
      expect(prompt).toContain('Captured trusted guidance');
      expect(prompt).not.toContain(directory);
      const result = await runBounded(process.execPath, ['-e', "process.stdin.pipe(process.stdout)"], {
        input: prompt, env: {}, timeoutMs: 2000, signal: new AbortController().signal,
      });
      expect(result.kind).toBe('exited');
      if (result.kind === 'exited') expect(result.stdout.toString()).toBe(prompt);
      await expect(passPrompt({ ...materialized, trustedInstructions: [{ path: 'AGENTS.md', text: 'forged', hash: hash('original') }] })).rejects.toThrow('invalid_instructions');
      await writeFile(join(directory, alias), 'tampered');
      await expect(passPrompt(materialized)).rejects.toThrow('invalid_bundle');
      await writeFile(join(directory, alias), text);
      await writeFile(join(directory, navigationAlias), 'tampered index');
      await expect(passPrompt(materialized)).rejects.toThrow('invalid_bundle');
      await writeFile(join(directory, navigationAlias), renderNavigation(materialized));
      await writeFile(join(directory, 'CLAUDE.md'), 'autoload must not enter mount');
      await expect(passPrompt(materialized)).rejects.toThrow('invalid_bundle');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('selects whole previews after JSON escaping and never drops required instructions', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'worker-encoded-')));
    try {
      await mkdir(join(directory, 'data')); await mkdir(join(directory, 'quarantine'));
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      const texts = ['"\\\n'.repeat(60 * 1024), '文'.repeat(1000)];
      const sourceMap = texts.map((text, i) => ({ alias: `data/${hash(String(i))}.diff.txt`, path: spec.reviewUnits[0]!.path,
        side: 'diff' as const, unitIds: spec.unitIds, contentHash: hash(text) }));
      const materialized = { ...spec, bundlePath: directory, sourceMap, initialAliases: sourceMap.map(entry => entry.alias),
        initialBytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0) };
      for (const [i, entry] of sourceMap.entries()) await writeFile(join(directory, entry.alias), texts[i]!);
      await writeFile(join(directory, navigationAlias), renderNavigation(materialized));
      const prompt = await passPrompt(materialized);
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(profile.maxRequestBytes);
      expect(JSON.parse(prompt).initialDiffs).toEqual([{ alias: sourceMap[1]!.alias, text: texts[1] }]);
      const text = '文'.repeat(profile.maxRequestBytes / 2);
      await expect(passPrompt({ ...materialized, trustedInstructions: [{ path: 'REVIEW.md', text, hash: hash(text) }] }))
        .rejects.toThrow('request_input_limit');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
