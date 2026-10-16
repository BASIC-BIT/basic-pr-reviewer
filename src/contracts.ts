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

export const passSpecSchema = z.strictObject({
  id: idSchema,
  kind: z.enum(['scope', 'integration']),
  unitIds: z.array(idSchema),
  contextHash: hashSchema,
  bundlePath: idSchema,
  priorFindings: z.array(findingSchema),
}).refine((spec) => new Set(spec.unitIds).size === spec.unitIds.length, 'Duplicate unit IDs');
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
  spec: PassSpec;
  outcome: PassOutcome;
  createdAt: number;
  updatedAt: number;
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
  savePass(identity: ReviewIdentity, spec: PassSpec, outcome: PassOutcome): void;
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
