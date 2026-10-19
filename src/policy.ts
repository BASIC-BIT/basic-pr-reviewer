import { createHash } from 'node:crypto';
import { repoPolicySchema } from './contracts.js';
import type { LivePull, TrustedPolicy } from './contracts.js';
import type { GitHubPort } from './github.js';

export class ConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'ConfigurationError'; }
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export async function loadPolicy(github: Pick<GitHubPort, 'readFile'>, pull: LivePull): Promise<TrustedPolicy> {
  const raw = await github.readFile(pull, '.github/claude-review.json');
  if (raw === null) throw new ConfigurationError('Missing trusted .github/claude-review.json');
  let policy;
  try { policy = repoPolicySchema.parse(JSON.parse(raw)); }
  catch { throw new ConfigurationError('Invalid trusted repository policy'); }
  const instructions: TrustedPolicy['instructions'] = [];
  // Only the trusted policy selects additional instructions; links in PR text select nothing.
  for (const path of new Set(['REVIEW.md', ...policy.instructionPaths])) {
    const text = await github.readFile(pull, path);
    if (text === null) throw new ConfigurationError(`Missing trusted instruction: ${path}`);
    instructions.push({ path, text, hash: hash(text) });
  }
  return { policy, instructions, policyHash: hash(JSON.stringify({
    policy, instructions: instructions.map(({ path, hash }) => ({ path, hash })),
  })) };
}
