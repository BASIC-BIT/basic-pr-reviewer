import { createHash } from 'node:crypto';
import { manifestSchema, plannedPassSchema, reviewIdentitySchema, validatePassOutcome } from './contracts.js';
import type { Ancestry, CoveragePlan, Manifest, PassRecord, PlannedPass, ReviewIdentity, ReviewResult } from './contracts.js';
import { assertVerifiedAncestry, describeBundle, sourceGroup } from './source.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const INITIAL_BYTES = 200 * 1024;
const exclusionCodes = new Set(['policy_exclusion', 'docs_only', 'binary_content', 'gitlink_content', 'binary_context']);
const missing = (items: PlannedPass['omissions']) => items.filter((item) => !exclusionCodes.has(item.code));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function groupFor(unit: Manifest['units'][number]): string {
  const group = sourceGroup(unit.path);
  return unit.oldPath && sourceGroup(unit.oldPath) !== group ? '@shared' : group;
}

function makePass(manifest: Manifest, kind: PlannedPass['kind'], unitIds: string[], groupId: string | null): PlannedPass {
  const shared = manifest.sourceMap.filter((item) => item.disposition !== 'excluded' &&
    (sourceGroup(item.path) === '@shared' || item.oldPath && sourceGroup(item.oldPath) !== sourceGroup(item.path)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const descriptor = describeBundle(manifest, unitIds, groupId);
  const groupUnits = groupId === null ? manifest.units : manifest.units.filter((unit) => groupFor(unit) === groupId);
  const scopeHash = hash({ version: 1, shared, groupUnits: groupUnits.map((unit) => unit.id).sort(), omissions: descriptor.omissions });
  let initialBytes = 0;
  const initialAliases: string[] = [];
  const sizes = new Map(manifest.bundleInputs.map((entry) => [entry.alias, entry.bytes]));
  for (const entry of descriptor.sourceMap.filter((entry) => entry.side === 'diff')) {
    const bytes = sizes.get(entry.alias) ?? 0;
    if (initialBytes + bytes <= INITIAL_BYTES) { initialAliases.push(entry.alias); initialBytes += bytes; }
  }
  const id = hash({ kind, unitIds, contextHash: descriptor.contextHash, scopeHash,
    ...(kind === 'integration' ? { identity: manifest.identity } : {}) });
  return { id, kind, unitIds, groupId, scopeHash, contextHash: descriptor.contextHash,
    omissions: descriptor.omissions, initialBytes, initialAliases, priorFindings: [], reusedFrom: null };
}

function currentPasses(manifest: Manifest, covered = new Set<string>()): PlannedPass[] {
  if (!manifest.units.length) return [];
  const groups = new Map<string, Manifest['units']>();
  for (const unit of manifest.units) {
    if (covered.has(unit.id)) continue;
    const group = groupFor(unit), units = groups.get(group) ?? [];
    units.push(unit); groups.set(group, units);
  }
  const result: PlannedPass[] = [];
  for (const [group, units] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    let selected: string[] = [], bytes = 0;
    for (const unit of units.sort((a, b) => a.path.bytesBase64.localeCompare(b.path.bytesBase64) || a.id.localeCompare(b.id))) {
      if (selected.length && bytes + unit.diffBytes > INITIAL_BYTES) { result.push(makePass(manifest, 'scope', selected, group)); selected = []; bytes = 0; }
      if (unit.diffBytes > INITIAL_BYTES) throw new Error('Source unit exceeds initial pass budget');
      selected.push(unit.id); bytes += unit.diffBytes;
    }
    if (selected.length) result.push(makePass(manifest, 'scope', selected, group));
  }
  result.push(makePass(manifest, 'integration', manifest.units.map((unit) => unit.id).sort(), null));
  return result;
}

function withFindings(spec: PlannedPass, findings: PlannedPass['priorFindings'], assessments: PlannedPass['priorFindings'] = []): PlannedPass {
  const priorFindings = [...new Map(findings.map((finding) => [finding.id, finding])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const assessmentFindings = [...new Map(assessments.map(finding => [finding.id, finding])).values()].sort((a, b) => a.id.localeCompare(b.id));
  return { ...spec, id: hash({ sourcePassId: spec.id, priorFindings, assessmentFindings }), priorFindings, assessmentFindings };
}

function compatibleIdentity(old: ReviewIdentity, current: ReviewIdentity): boolean {
  const { headSha: _oh, attemptId: _oa, generation: _og, ...a } = old;
  const { headSha: _ch, attemptId: _ca, generation: _cg, ...b } = current;
  return same(a, b) && old.generation <= current.generation;
}

function validRecord(record: PassRecord, spec: PlannedPass): boolean {
  try {
    reviewIdentitySchema.parse(record.identity);
    const stored = plannedPassSchema.parse(record.spec);
    validatePassOutcome(stored, record.outcome);
    return stored.id === spec.id && stored.kind === spec.kind && stored.contextHash === spec.contextHash &&
      stored.scopeHash === spec.scopeHash && stored.groupId === spec.groupId && same(stored.unitIds, spec.unitIds) &&
      same(stored.omissions, spec.omissions);
  } catch { return false; }
}

function currentScope(manifest: Manifest, record: PassRecord): boolean {
  try {
    if (record.spec.kind !== 'scope' || !record.spec.unitIds.length) return false;
    const ids = new Set(record.spec.unitIds), units = manifest.units.filter((unit) => ids.has(unit.id));
    if (units.length !== ids.size || units.some((unit) => groupFor(unit) !== record.spec.groupId) ||
      units.reduce((sum, unit) => sum + unit.diffBytes, 0) > INITIAL_BYTES) return false;
    return validRecord(record, makePass(manifest, 'scope', record.spec.unitIds, record.spec.groupId));
  } catch { return false; }
}

export function splitScope(input: Manifest, passInput: PlannedPass): PlannedPass[] {
  const manifest = manifestSchema.parse(input), pass = plannedPassSchema.parse(passInput);
  if (pass.kind !== 'scope') throw new Error('Only scope passes can split');
  const expected = makePass(manifest, 'scope', pass.unitIds, pass.groupId);
  if (pass.id !== expected.id) throw new Error('Scope no longer matches current source');
  if (pass.unitIds.length < 2) return [];
  const middle = Math.ceil(pass.unitIds.length / 2);
  return [pass.unitIds.slice(0, middle), pass.unitIds.slice(middle)].map((ids) => makePass(manifest, 'scope', ids, pass.groupId));
}

export function planCoverage(input: Manifest, previous: PassRecord[], ancestry: Ancestry): CoveragePlan {
  const manifest = manifestSchema.parse(input);
  assertVerifiedAncestry(ancestry, manifest.identity.headSha);
  const reusedPasses: PassRecord[] = [], used = new Set<string>(), covered = new Set<string>();
  for (const record of [...previous].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))) {
    if (record.outcome.status !== 'completed' || !compatibleIdentity(record.identity, manifest.identity) ||
      !ancestry.ancestorHeadShas.includes(record.identity.headSha) || !currentScope(manifest, record) ||
      missing(record.spec.omissions).length > 0 || record.spec.unitIds.every((id) => covered.has(id))) continue;
    used.add(record.id);
    for (const id of record.spec.unitIds) covered.add(id);
    reusedPasses.push(same(record.identity, manifest.identity) ? record :
      { ...record, identity: manifest.identity, spec: { ...record.spec, reusedFrom: record.id } });
  }
  const freshPasses = currentPasses(manifest, covered);
  // Replanning after scope execution supplies current findings, including useful failed-pass findings.
  const integrationIndex = freshPasses.findIndex((pass) => pass.kind === 'integration');
  const integration = freshPasses[integrationIndex];
  const currentScopes = previous.filter((record) => same(record.identity, manifest.identity) && currentScope(manifest, record));
  if (integration) {
    const currentFindings = [...reusedPasses, ...currentScopes].flatMap(record => record.outcome.findings);
    const readable = new Set(describeBundle(manifest, integration.unitIds, null).sourceMap.map(entry => entry.path.bytesBase64));
    const retained = previous.filter(record => record.identity.attemptId !== manifest.identity.attemptId &&
      compatibleIdentity(record.identity, manifest.identity) && ancestry.ancestorHeadShas.includes(record.identity.headSha))
      .filter(record => { try { validatePassOutcome(record.spec, record.outcome); return true; } catch { return false; } })
      .flatMap(record => record.outcome.findings).filter(finding => finding.location.path && readable.has(finding.location.path.bytesBase64) &&
        !currentFindings.some(current => current.id === finding.id));
    freshPasses[integrationIndex] = withFindings(integration, currentFindings, retained);
  }
  return { freshPasses, reusedPasses, reusedPassIds: [...used],
    invalidatedPassIds: previous.filter((record) => !used.has(record.id)).map((record) => record.id),
    uncoveredUnitIds: manifest.units.filter((unit) => !covered.has(unit.id)).map((unit) => unit.id) };
}

export function aggregateReview(identityInput: ReviewIdentity, input: Manifest, outcomes: PassRecord[]): ReviewResult {
  const identity = reviewIdentitySchema.parse(identityInput), manifest = manifestSchema.parse(input);
  if (!same(identity, manifest.identity)) throw new Error('Review identity mismatch');
  const covered = new Set<string>(), reused = new Set<string>();
  const findings = new Map<string, ReviewResult['findings'][number]>(), failureCodes = new Set<string>();
  let integrationStatus: ReviewResult['integrationStatus'] = 'pending';
  const missingScope = [...manifest.retrievalFailures];
  const exclusions = [...manifest.exclusions, ...manifest.bundleOmissions.filter((item) => exclusionCodes.has(item.code))];
  const integration = manifest.units.length ? makePass(manifest, 'integration', manifest.units.map((unit) => unit.id).sort(), null) : null;
  if (integration) missingScope.push(...missing(integration.omissions));
  const accepted = new Map<string, PassRecord>();
  for (const record of [...outcomes].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))) {
    if (!same(record.identity, identity) || accepted.has(record.spec.id)) continue;
    if (currentScope(manifest, record) || integration && record.spec.reusedFrom === null &&
      validRecord(record, withFindings(integration, record.spec.priorFindings, record.spec.assessmentFindings))) accepted.set(record.spec.id, record);
  }
  for (const record of [...accepted.values()].filter((item) => item.spec.kind === 'scope')) {
    const spec = record.spec;
    for (const finding of record.outcome.findings) findings.set(finding.id, finding);
    if (record.outcome.failureCode) failureCodes.add(record.outcome.failureCode);
    if (record.outcome.status !== 'completed') continue;
    const omittedUnits = new Set(missing(spec.omissions).flatMap((item) => item.unitIds ?? []));
    for (const id of spec.unitIds) {
      if (omittedUnits.has(id)) continue;
      covered.add(id); if (record.spec.reusedFrom) reused.add(id);
    }
  }
  let priorFindingAssessments: NonNullable<ReviewResult['priorFindingAssessments']> = [];
  if (integration) {
    const candidates = [...accepted.values()].filter((record) => record.spec.kind === 'integration');
    const current = candidates.find(record => record.spec.id === withFindings(integration, [...findings.values()], record.spec.assessmentFindings).id) ?? candidates[0];
    const expected = withFindings(integration, [...findings.values()], current?.spec.assessmentFindings);
    for (const record of candidates) {
      for (const finding of record.outcome.findings) findings.set(finding.id, finding);
      if (record.outcome.failureCode) failureCodes.add(record.outcome.failureCode);
    }
    if (current) {
      integrationStatus = current.outcome.status;
      const readable = new Set(describeBundle(manifest, integration.unitIds, null).sourceMap.map(entry => entry.path.bytesBase64));
      priorFindingAssessments = current.outcome.priorFindingAssessments.map(assessment => {
        const finding = [...current.spec.priorFindings, ...(current.spec.assessmentFindings ?? [])].find(finding => finding.id === assessment.findingId);
        return { ...assessment, assessment: finding?.location.path && readable.has(finding.location.path.bytesBase64) ? assessment.assessment : 'uncertain' };
      });
      if (integrationStatus === 'completed' && (current.spec.id !== expected.id || missing(integration.omissions).length > 0)) {
        integrationStatus = 'incomplete';
        if (current.spec.id !== expected.id) failureCodes.add('integration_findings_mismatch');
      }
    }
  }
  const missingUnitIds = manifest.units.filter((unit) => !covered.has(unit.id)).map((unit) => unit.id);
  const unique = (items: PlannedPass['omissions']) => [...new Map(items.map((item) => [JSON.stringify(item), item])).values()];
  for (const item of missingScope) failureCodes.add(item.code);
  const skipped = manifest.units.length === 0 && missingScope.length === 0;
  if (skipped) integrationStatus = 'not_required';
  const complete = missingUnitIds.length === 0 && missingScope.length === 0 && integrationStatus === 'completed';
  return { identity, complete, status: skipped ? 'skipped' : complete ? 'complete' : 'incomplete', reason: skipped ? 'no_eligible_scope' : null,
    coveredUnitIds: [...covered].sort(), reusedUnitIds: [...reused].sort(), missingUnitIds,
    integrationStatus, reviewUnits: manifest.units, priorFindingAssessments: complete ? priorFindingAssessments : [], findings: [...findings.values()], exclusions: unique(exclusions), missingScope: unique(missingScope),
    failureCodes: [...failureCodes].sort(), generation: identity.generation, publicationState: 'unpublished' };
}

export function validateIntegrationInputs(input: Manifest, spec: PlannedPass): void {
  const manifest = manifestSchema.parse(input);
  if (spec.kind !== 'integration') {
    if (spec.assessmentFindings?.length) throw new Error('Assessment inputs require integration');
    return;
  }
  const base = makePass(manifest, 'integration', manifest.units.map(unit => unit.id).sort(), null);
  if (withFindings(base, spec.priorFindings, spec.assessmentFindings).id !== spec.id) throw new Error('Integration input hash mismatch');
  const readable = new Set(describeBundle(manifest, spec.unitIds, null).sourceMap.map(entry => entry.path.bytesBase64));
  if (spec.assessmentFindings?.some(finding => !finding.location.path || !readable.has(finding.location.path.bytesBase64)))
    throw new Error('Assessment source unavailable');
}
