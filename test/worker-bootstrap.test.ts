import { describe, expect, it } from 'vitest';
import { runBounded } from '../src/worker.js';

describe('credential stdin bootstrap', () => {
  const probe = `import {readCredential} from './worker/bootstrap.mjs';
    import {readFileSync} from 'node:fs';
    try { const token=readCredential(0); const prompt=readFileSync(0,'utf8');
      process.stdout.write(JSON.stringify({credentialValid:token==='synthetic-credential',prompt}));
    } catch {process.stderr.write('credential_handoff_failed');process.exitCode=1;}`;
  it('consumes only the bounded credential line and leaves a large prompt unchanged', async () => {
    const prompt = 'review data\n'.repeat(20000);
    const result = await runBounded(process.execPath, ['--input-type=module', '-e', probe], {
      signal: new AbortController().signal, timeoutMs: 2000, env: {}, input: `synthetic-credential\n${prompt}`,
    });
    expect(result.kind).toBe('exited');
    if (result.kind === 'exited') expect(JSON.parse(result.stdout.toString())).toEqual({ credentialValid: true, prompt });
  });
  it.each(['', '\nreview', 'missing-delimiter', 'invalid\r\nreview', 'invalid\0\nreview', `${'x'.repeat(8193)}\nreview`])('fails closed on malformed credential framing', async (input) => {
    const result = await runBounded(process.execPath, ['--input-type=module', '-e', probe], {
      signal: new AbortController().signal, timeoutMs: 2000, env: {}, input,
    });
    expect(result).toEqual({ kind: 'failed', code: 'process_failure' });
  });
});
