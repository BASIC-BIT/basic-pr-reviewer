import { z } from 'zod';

export const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idSchema = z.string().min(1);
const githubIdSchema = z.string().regex(/^[1-9][0-9]*$/);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const instructionPathSchema = z.string().min(1).max(512).refine((path) =>
  !path.startsWith('/') && !path.includes('\\') && !path.includes(':') &&
  path.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
  !/[\x00-\x1f]/.test(path), 'Invalid repository instruction path');
export const repoPolicySchema = z.strictObject({
  schemaVersion: z.literal(1), enabled: z.boolean(),
  baseBranches: z.array(z.string().min(1)).min(1).default(['main']),
  skipLabels: z.array(z.string().min(1)).default(['skip-review']),
  rerunOnUnskip: z.boolean().default(false), excludeGlobs: z.array(z.string()).default([]),
  excludeDocsOnly: z.boolean().default(false), allowBotAuthors: z.boolean().default(false),
  allowedBotActors: z.array(z.string().min(1)).default([]),
  contextMode: z.enum(['diff', 'changed-context-only', 'allowlist']).default('changed-context-only'),
  contextAllowGlobs: z.array(z.string()).default([]), githubLinksOnly: z.boolean().default(false),
  instructionPaths: z.array(instructionPathSchema).max(32).default([]),
});
export type RepoPolicy = z.infer<typeof repoPolicySchema>;
export const livePullSchema = z.strictObject({
  installationId: githubIdSchema, repositoryId: githubIdSchema,
  ownerId: githubIdSchema,
  headRepositoryId: githubIdSchema.nullable(), baseRepositoryId: githubIdSchema,
  owner: idSchema, repo: idSchema, pullNumber: sequenceSchema,
  headSha: shaSchema, baseRef: idSchema, baseSha: shaSchema, mergeBaseSha: shaSchema,
  draft: z.boolean(), state: z.enum(['open', 'closed']), labels: z.array(z.string()),
  author: z.strictObject({ login: idSchema, type: z.enum(['User', 'Bot', 'Mannequin']) }),
});
export type LivePull = z.infer<typeof livePullSchema>;
export type TrustedPolicy = {
  policy: RepoPolicy; policyHash: string;
  instructions: { path: string; text: string; hash: string }[];
};
export const webhookAdmissionSchema = z.union([
  z.strictObject({ kind: z.enum(['admitted', 'duplicate']), attemptId: githubIdSchema }),
  z.strictObject({ kind: z.enum(['ignored', 'cancelled', 'configuration_failure']), reason: idSchema }),
]);
export type WebhookAdmission = z.infer<typeof webhookAdmissionSchema>;
export type PullObservation = {
  generation: number; rerunSequence: number; blockedReason: string | null;
  observedHeadSha: string | null; observedBaseRef: string | null;
};

export const reviewInputSchema = z.strictObject({
  installationId: githubIdSchema,
  repositoryId: githubIdSchema,
  owner: idSchema,
  repo: idSchema,
  pullNumber: sequenceSchema,
  headSha: shaSchema,
  baseRef: idSchema,
  baseSha: shaSchema,
  mergeBaseSha: shaSchema,
  policyHash: hashSchema,
  runtimeHash: hashSchema,
});
export const reviewIdentitySchema = reviewInputSchema.extend({
  attemptId: githubIdSchema,
  generation: sequenceSchema,
});
export type ReviewIdentity = z.infer<typeof reviewIdentitySchema>;

export const admittedEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  deliveryId: idSchema,
  receivedAt: timestampSchema,
  // Read before resolving live identity; a fresh transition must still match this observation.
  expectedGeneration: timestampSchema,
  expectedAccessGeneration: timestampSchema.optional(),
  identity: reviewInputSchema,
  trigger: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('automatic') }),
    z.strictObject({ kind: z.literal('rerun'), sequence: sequenceSchema }),
  ]),
});
export type AdmittedEvent = z.infer<typeof admittedEventSchema>;

// Git paths can contain non-UTF-8 bytes; display aliases must never become publication paths.
export const pathIdentitySchema = z.strictObject({
  bytesBase64: z.string().min(1).refine((value) => {
    const bytes = Buffer.from(value, 'base64');
    return bytes.toString('base64') === value && !bytes.includes(0);
  }, 'Expected a canonical base64 Git path without NUL bytes'),
});
export type PathIdentity = z.infer<typeof pathIdentitySchema>;

export const sourceMappingSchema = z.strictObject({
  id: hashSchema, path: pathIdentitySchema, oldPath: pathIdentitySchema.nullable(),
  oldBlobId: shaSchema.nullable(), newBlobId: shaSchema.nullable(),
  oldMode: z.string().regex(/^[0-7]{6}$/), newMode: z.string().regex(/^[0-7]{6}$/),
  disposition: z.enum(['review', 'excluded', 'retrieval_failure']),
});
export const reviewUnitSchema = z.strictObject({
  id: hashSchema, sourceId: hashSchema, path: pathIdentitySchema, oldPath: pathIdentitySchema.nullable(),
  oldBlobId: shaSchema.nullable(), newBlobId: shaSchema.nullable(),
  oldLines: z.strictObject({ start: timestampSchema, count: timestampSchema }),
  newLines: z.strictObject({ start: timestampSchema, count: timestampSchema }),
  kind: z.enum(['text', 'rename', 'delete', 'binary', 'symlink', 'gitlink', 'mode']),
  contentHash: hashSchema, groupId: hashSchema, diffBytes: timestampSchema,
});
export type ReviewUnit = z.infer<typeof reviewUnitSchema>;
export const sourceOmissionSchema = z.strictObject({ path: pathIdentitySchema.nullable(), code: idSchema, unitIds: z.array(hashSchema).optional() });
export const bundleMappingSchema = z.strictObject({
  alias: z.string().regex(/^(data|quarantine)\/[0-9a-f]{64}\.(old|new|diff)\.txt$/),
  path: pathIdentitySchema, side: z.enum(['old', 'new', 'diff']), unitIds: z.array(hashSchema),
  contentHash: hashSchema,
});
export const bundleInputSchema = bundleMappingSchema.extend({
  bytes: timestampSchema, role: z.enum(['diff', 'changed', 'context']),
});
export const manifestSchema = z.strictObject({
  identity: reviewIdentitySchema, units: z.array(reviewUnitSchema),
  exclusions: z.array(sourceOmissionSchema), retrievalFailures: z.array(sourceOmissionSchema),
  sourceMap: z.array(sourceMappingSchema), workspace: idSchema,
  bundleInputs: z.array(bundleInputSchema), bundleOmissions: z.array(sourceOmissionSchema),
  maxBundleBytes: sequenceSchema,
});
export type Manifest = z.infer<typeof manifestSchema>;
export const bundleDescriptorSchema = z.strictObject({
  contextHash: hashSchema, sourceMap: z.array(bundleMappingSchema),
  omissions: z.array(sourceOmissionSchema),
});
export type BundleDescriptor = z.infer<typeof bundleDescriptorSchema>;
export const bundleSchema = z.strictObject({
  directory: idSchema, contextHash: hashSchema, sourceMap: z.array(bundleMappingSchema),
  omissions: z.array(sourceOmissionSchema), allowedReadScope: z.array(idSchema),
});
export type Bundle = z.infer<typeof bundleSchema>;

const lineLocationSchema = z.strictObject({
  kind: z.literal('line'),
  path: pathIdentitySchema,
  side: z.enum(['LEFT', 'RIGHT']),
  startLine: sequenceSchema,
  endLine: sequenceSchema,
}).refine((location) => location.endLine >= location.startLine, 'Line range is reversed');
export const findingSchema = z.strictObject({
  id: idSchema,
  message: z.string().trim().min(1),
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  location: z.union([
    lineLocationSchema,
    z.strictObject({ kind: z.literal('summary'), path: pathIdentitySchema.nullable() }),
  ]),
  evidence: z.array(z.strictObject({ unitId: idSchema, explanation: z.string().trim().min(1) })).min(1),
  priorFindingId: idSchema.optional(),
});
export type Finding = z.infer<typeof findingSchema>;

export const plannedPassSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['scope', 'integration']),
  unitIds: z.array(idSchema),
  contextHash: hashSchema,
  priorFindings: z.array(findingSchema),
  // Defaults preserve readable legacy records, which cannot match a current scope hash.
  groupId: idSchema.nullable().default(null),
  scopeHash: hashSchema.default('0'.repeat(64)),
  omissions: z.array(sourceOmissionSchema).default([]),
  initialBytes: timestampSchema.max(200 * 1024).default(0),
  initialAliases: z.array(idSchema).default([]),
  reusedFrom: idSchema.nullable().default(null),
}).refine((spec) => new Set(spec.unitIds).size === spec.unitIds.length, 'Duplicate unit IDs');
export type PlannedPass = z.infer<typeof plannedPassSchema>;
export const passSpecSchema = plannedPassSchema.safeExtend({
  bundlePath: idSchema, reviewUnits: z.array(reviewUnitSchema), sourceMap: z.array(bundleMappingSchema),
  trustedInstructions: z.array(z.strictObject({ path: idSchema, text: z.string(), hash: hashSchema })),
}).refine((spec) => spec.reviewUnits.length === spec.unitIds.length &&
  new Set(spec.reviewUnits.map((unit) => unit.id)).size === spec.unitIds.length &&
  spec.reviewUnits.every((unit) => spec.unitIds.includes(unit.id)), 'Invalid materialized unit assignment');
export type PassSpec = z.infer<typeof passSpecSchema>;

const passOutcomeBaseSchema = z.strictObject({
  passId: idSchema,
  findings: z.array(findingSchema),
  priorFindingAssessments: z.array(z.strictObject({
    findingId: idSchema, assessment: z.enum(['fixed', 'open', 'uncertain']),
  })),
  model: z.strictObject({ name: idSchema, cliVersion: idSchema }),
  usage: z.strictObject({ inputTokens: timestampSchema.nullable(), outputTokens: timestampSchema.nullable() }),
});
export const passOutcomeSchema = z.discriminatedUnion('status', [
  passOutcomeBaseSchema.extend({ status: z.literal('completed'), failureCode: z.null() }),
  passOutcomeBaseSchema.extend({ status: z.literal('failed'), failureCode: idSchema }),
  passOutcomeBaseSchema.extend({ status: z.literal('incomplete'), failureCode: idSchema }),
]).refine((outcome) => new Set(outcome.findings.map((finding) => finding.id)).size === outcome.findings.length,
    'Duplicate finding IDs');
export type PassOutcome = z.infer<typeof passOutcomeSchema>;

export function validatePassOutcome(spec: PlannedPass, input: PassOutcome): PassOutcome {
  const outcome = passOutcomeSchema.parse(input);
  if (spec.id !== outcome.passId) throw new Error('Pass ID mismatch');
  const assigned = new Set(spec.unitIds), prior = new Set(spec.priorFindings.map((finding) => finding.id));
  if (outcome.findings.some((finding) => finding.evidence.some((entry) => !assigned.has(entry.unitId)) ||
    finding.priorFindingId !== undefined && !prior.has(finding.priorFindingId))) throw new Error('Finding outside assigned pass scope');
  const assessed = outcome.priorFindingAssessments.map((item) => item.findingId);
  if (new Set(assessed).size !== assessed.length || assessed.some((id) => !prior.has(id))) throw new Error('Invalid prior finding assessment');
  return outcome;
}

export const publicationIntentSchema = z.strictObject({
  identity: reviewIdentitySchema,
  key: idSchema,
  channel: z.enum(['inline', 'summary', 'check']),
  body: z.string().min(1),
});
export type PublicationIntent = z.infer<typeof publicationIntentSchema>;

export const attemptStateSchema = z.enum(['queued', 'leased', 'superseded']);
export type Lease = { token: string; expiresAt: number };
export type AttemptRecord = {
  identity: ReviewIdentity;
  createdAt: number;
  updatedAt: number;
} & ({ state: 'queued' | 'superseded'; lease: null } | { state: 'leased'; lease: Lease });
export type Admission = AttemptRecord & { kind: 'created' | 'duplicate' };
export type ClaimedAttempt = AttemptRecord & { state: 'leased'; lease: Lease };
export type PassRecord = {
  id: string;
  identity: ReviewIdentity;
  spec: PlannedPass;
  outcome: PassOutcome;
  createdAt: number;
  updatedAt: number;
};
export type Ancestry = Readonly<{ headSha: string; ancestorHeadShas: readonly string[] }>;
export type CoveragePlan = {
  freshPasses: PlannedPass[]; reusedPasses: PassRecord[];
  reusedPassIds: string[]; invalidatedPassIds: string[]; uncoveredUnitIds: string[];
};
export type ReviewResult = {
  identity: ReviewIdentity; complete: boolean;
  status: 'complete' | 'incomplete' | 'skipped'; reason: 'no_eligible_scope' | null;
  coveredUnitIds: string[]; reusedUnitIds: string[]; missingUnitIds: string[];
  integrationStatus: 'pending' | 'completed' | 'failed' | 'incomplete' | 'not_required';
  findings: Finding[]; exclusions: z.infer<typeof sourceOmissionSchema>[];
  missingScope: z.infer<typeof sourceOmissionSchema>[]; failureCodes: string[];
  generation: number; publicationState: 'unpublished';
};
export type PullRecord = AttemptRecord & { rerunSequence: number; passes: PassRecord[] };
export type PublicationRecord = {
  id: string;
  intent: PublicationIntent;
  state: 'planned' | 'superseded';
  createdAt: number;
  updatedAt: number;
};

export interface Store {
  admit(event: AdmittedEvent): Admission;
  claim(now: number): ClaimedAttempt | null;
  savePass(identity: ReviewIdentity, spec: PlannedPass | PassSpec, outcome: PassOutcome): void;
  passHistory(repositoryId: string, pullNumber: number): PassRecord[];
  current(repositoryId: string, pullNumber: number): PullRecord | null;
  trackedPulls(installationId: string): { repositoryId: string; pullNumber: number }[];
  trackedInstallations(): string[];
  observation(repositoryId: string, pullNumber: number): PullObservation;
  invalidatePull(repositoryId: string, pullNumber: number, expectedGeneration: number,
    reason: string, headSha: string | null, baseRef: string | null): void;
  accessGeneration(): number;
  accessAllowed(installationId: string, repositoryId: string): boolean;
  restoreAccess(installationId: string, repositoryId: string, expectedAccessGeneration: number): number;
  setAccess(installationId: string, repositoryId: string | null, allowed: boolean): void;
  receipt(deliveryId: string): WebhookAdmission | null;
  acknowledge(deliveryId: string, admission: WebhookAdmission): void;
  planPublication(intent: PublicationIntent): PublicationRecord;
  backup(path: string): Promise<void>;
  close(): void;
}
