import type { AdmittedEvent, PassOutcome, PassSpec } from '../../src/contracts.js';
import { passSpecSchema } from '../../src/contracts.js';

export const event: AdmittedEvent = {
  schemaVersion: 1,
  deliveryId: 'delivery-1',
  receivedAt: 1_000,
  expectedGeneration: 0,
  trigger: { kind: 'automatic' },
  identity: {
    installationId: '100', repositoryId: '200', owner: 'example', repo: 'fixture',
    pullNumber: 42, headSha: 'a'.repeat(40), baseRef: 'main', baseSha: 'b'.repeat(40),
    mergeBaseSha: 'c'.repeat(40), policyHash: 'd'.repeat(64), runtimeHash: 'e'.repeat(64),
  },
};

export const spec: PassSpec = passSpecSchema.parse({
  id: 'scope-1', kind: 'scope', unitIds: ['1'.repeat(64)], contextHash: 'f'.repeat(64),
  bundlePath: 'bundles/synthetic', priorFindings: [],
  reviewUnits: [{ id: '1'.repeat(64), sourceId: '2'.repeat(64), path: { bytesBase64: 'c3JjL2ZpbGUudHM=' }, oldPath: null,
    oldBlobId: null, newBlobId: 'a'.repeat(40), oldLines: { start: 0, count: 0 }, newLines: { start: 1, count: 3 },
    kind: 'text', contentHash: '3'.repeat(64), groupId: '4'.repeat(64), diffBytes: 10 }], sourceMap: [], trustedInstructions: [],
});

export const outcome: PassOutcome = {
  passId: spec.id, status: 'completed', findings: [{
    id: 'finding-1', message: 'A synthetic fixture finding.', severity: 'P2',
    location: { kind: 'line', path: { bytesBase64: 'c3JjL2ZpbGUudHM=' }, side: 'RIGHT', startLine: 2, endLine: 2 },
    evidence: [{ unitId: '1'.repeat(64), explanation: 'Synthetic evidence.' }],
  }],
  priorFindingAssessments: [], failureCode: null,
  model: { name: 'synthetic', cliVersion: 'fixture' },
  usage: { inputTokens: 10, outputTokens: 5 },
};
