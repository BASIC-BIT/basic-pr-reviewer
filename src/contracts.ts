import { z } from 'zod';

export const timestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const idSchema = z.string().min(1);
const githubIdSchema = z.string().regex(/^[1-9][0-9]*$/);
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

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
export type PullRecord = AttemptRecord & { passes: PassRecord[] };
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
  planPublication(intent: PublicationIntent): PublicationRecord;
  backup(path: string): Promise<void>;
  close(): void;
}
