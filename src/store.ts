import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  admittedEventSchema, attemptStateSchema, passOutcomeSchema, passSpecSchema, plannedPassSchema, validatePassOutcome,
  publicationIntentSchema, reviewIdentitySchema, timestampSchema,
  webhookAdmissionSchema, leaseOwnershipSchema, reviewResultSchema, publicationTargetSchema, publicationNoticeSchema, publicationFenceSchema, publicationOperationSchema, livePullSchema,
} from './contracts.js';
import type {
  AttemptRecord, PassRecord, PublicationRecord, ReviewIdentity, Store,
  PullObservation, LeaseOwnership, AttemptSettlement, LivePull, PublicationFence, PublicationNotice, PublicationOperation,
} from './contracts.js';

const publicationTables = `CREATE TABLE publication_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, repository_id TEXT NOT NULL, pull_number INTEGER NOT NULL,
  notice_json TEXT NOT NULL CHECK(json_valid(notice_json)),
  FOREIGN KEY(repository_id, pull_number) REFERENCES pulls(repository_id, pull_number)
) STRICT;
CREATE TABLE publication_operations (
  operation_key TEXT PRIMARY KEY, repository_id TEXT NOT NULL, pull_number INTEGER NOT NULL,
  operation_json TEXT NOT NULL CHECK(json_valid(operation_json)),
  FOREIGN KEY(repository_id, pull_number) REFERENCES pulls(repository_id, pull_number)
) STRICT;
PRAGMA user_version = 4;`;

export const LEASE_DURATION_MS = 60 * 60 * 1_000;
export const RECOVERY_WINDOW_MS = 48 * 60 * 60 * 1_000;
export class StaleAdmissionObservationError extends Error {
  constructor() {
    super('Stale admission observation; read current generation and live identity again');
    this.name = 'StaleAdmissionObservationError';
  }
}
const attemptRowSchema = z.object({
  identity_json: z.string(), state: attemptStateSchema,
  created_at: timestampSchema, updated_at: timestampSchema,
  lease_token: z.string().nullable(), lease_expires_at: timestampSchema.nullable(),
  terminal_state: z.enum(['complete', 'incomplete', 'intervention']).nullable(),
  next_attempt_at: timestampSchema, recovery_started_at: timestampSchema.nullable(),
  last_work_at: timestampSchema, intervention_reason: z.string().nullable(), result_json: z.string().nullable(),
});
const passRowSchema = z.object({
  id: z.number().int().positive(), spec_json: z.string(), outcome_json: z.string(),
  created_at: timestampSchema, updated_at: timestampSchema,
});
const publicationRowSchema = z.object({
  id: z.number().int().positive(), intent_json: z.string(), state: z.enum(['planned', 'superseded']),
  created_at: timestampSchema, updated_at: timestampSchema,
});

function readAttempt(value: unknown): AttemptRecord {
  const row = attemptRowSchema.parse(value);
  const record = {
    identity: reviewIdentitySchema.parse(JSON.parse(row.identity_json)),
    createdAt: row.created_at, updatedAt: row.updated_at,
    nextAttemptAt: row.next_attempt_at, recoveryStartedAt: row.recovery_started_at,
    lastWorkAt: row.last_work_at, interventionReason: row.intervention_reason,
    result: row.result_json === null ? null : reviewResultSchema.parse(JSON.parse(row.result_json)),
  };
  if (row.state === 'leased') {
    if (row.lease_token === null || row.lease_expires_at === null) throw new Error('Invalid stored lease');
    return { ...record, state: row.state, lease: { token: row.lease_token, expiresAt: row.lease_expires_at } };
  }
  return { ...record, state: row.state === 'superseded' ? row.state : row.terminal_state ?? row.state, lease: null };
}

function readPass(value: unknown, identity: ReviewIdentity): PassRecord {
  const row = passRowSchema.parse(value);
  const { bundlePath: _path, ...stored } = JSON.parse(row.spec_json);
  return {
    id: String(row.id), identity, spec: plannedPassSchema.parse(stored),
    outcome: passOutcomeSchema.parse(JSON.parse(row.outcome_json)),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function readPublication(value: unknown): PublicationRecord {
  const row = publicationRowSchema.parse(value);
  return {
    id: String(row.id), intent: publicationIntentSchema.parse(JSON.parse(row.intent_json)),
    state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function openStore(path: string): Store {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    const { user_version: version } = z.object({ user_version: z.number().int() })
      .parse(db.prepare('PRAGMA user_version').get());
    if (![0, 2, 3, 4, 5].includes(version)) throw new Error(`Unsupported schema version ${version}`);
    db.exec('PRAGMA journal_mode = WAL');
    if (version === 0) {
      transaction(() => {
        const current = z.object({ user_version: z.number().int() }).parse(db.prepare('PRAGMA user_version').get());
        if (current.user_version === 0) db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
        else if (current.user_version !== 5) throw new Error(`Unsupported schema version ${current.user_version}`);
      });
    }
    if (version === 2) transaction(() => {
      const current = z.object({ user_version: z.number().int() }).parse(db.prepare('PRAGMA user_version').get());
      if (current.user_version === 3 || current.user_version === 4) return;
      db.exec(`ALTER TABLE attempts ADD COLUMN terminal_state TEXT CHECK (terminal_state IN ('complete', 'incomplete', 'intervention'));
        ALTER TABLE attempts ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE attempts ADD COLUMN recovery_started_at INTEGER;
        ALTER TABLE attempts ADD COLUMN last_work_at INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE attempts ADD COLUMN intervention_reason TEXT;
        ALTER TABLE attempts ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json));
        ALTER TABLE attempts ADD COLUMN lease_losses INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE attempts ADD COLUMN progress_sequence INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE pass_executions (attempt_id INTEGER NOT NULL REFERENCES attempts(id), pass_id TEXT NOT NULL,
          count INTEGER NOT NULL CHECK (count > 0), PRIMARY KEY (attempt_id, pass_id)) STRICT;
        PRAGMA user_version = 3;`);
    });
    transaction(() => {
      const current = z.object({ user_version: z.number().int() }).parse(db.prepare('PRAGMA user_version').get());
      if (current.user_version === 3) db.exec(publicationTables);
      if (current.user_version === 3 || current.user_version === 4) db.exec('ALTER TABLE pulls ADD COLUMN closed_at INTEGER; ALTER TABLE webhook_receipts ADD COLUMN repository_id TEXT; ALTER TABLE webhook_receipts ADD COLUMN pull_number INTEGER; PRAGMA user_version = 5;');
    });
  } catch (error) {
    db.close();
    throw error;
  }

  function transaction<T>(run: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function attempt(id: string): AttemptRecord {
    return readAttempt(db.prepare('SELECT * FROM attempts WHERE id = ?').get(id));
  }

  function assertCurrent(identity: ReviewIdentity): void {
    const stored = attempt(identity.attemptId);
    if (JSON.stringify(stored.identity) !== JSON.stringify(identity)) throw new Error('Review identity mismatch');
    const current = db.prepare('SELECT current_attempt_id, generation FROM pulls WHERE repository_id = ? AND pull_number = ?')
      .get(identity.repositoryId, identity.pullNumber);
    const pointer = z.object({ current_attempt_id: z.number().int().positive(), generation: timestampSchema }).parse(current);
    if (String(pointer.current_attempt_id) !== identity.attemptId || pointer.generation !== identity.generation || stored.state === 'superseded') {
      throw new Error('Stale review generation');
    }
  }

  function assertOwner(identity: ReviewIdentity, input: LeaseOwnership): LeaseOwnership {
    assertCurrent(identity);
    const owner = leaseOwnershipSchema.parse(input), record = attempt(identity.attemptId);
    if (record.state !== 'leased' || record.lease.token !== owner.token || record.lease.expiresAt <= owner.now) throw new Error('Worker lease lost');
    if (!accessAllowed(identity.installationId, identity.repositoryId)) throw new Error('Installation access revoked');
    return owner;
  }

  function publication(input: PublicationRecord['intent'], now: number): PublicationRecord {
    const intent = publicationIntentSchema.parse(input);
    const existing = db.prepare('SELECT * FROM publications WHERE attempt_id = ? AND publication_key = ?')
      .get(intent.identity.attemptId, intent.key);
    if (existing) {
      const record = readPublication(existing);
      if (JSON.stringify(record.intent) !== JSON.stringify(intent)) throw new Error('Publication intent is immutable');
      return record;
    }
    const inserted = db.prepare("INSERT INTO publications (attempt_id, publication_key, intent_json, state, created_at, updated_at) VALUES (?, ?, ?, 'planned', ?, ?)")
      .run(intent.identity.attemptId, intent.key, JSON.stringify(intent), now, now);
    return readPublication(db.prepare('SELECT * FROM publications WHERE id = ?').get(inserted.lastInsertRowid));
  }

  function progress(identity: ReviewIdentity, settlement: Omit<AttemptSettlement, 'state'> & { state: AttemptSettlement['state'] | 'leased' }, now: number): void {
    const body = JSON.stringify({ state: settlement.state, reason: settlement.reason, nextAttemptAt: settlement.nextAttemptAt, result: settlement.result });
    const key = createHash('sha256').update(body).digest('hex');
    db.prepare('UPDATE attempts SET progress_sequence = progress_sequence + 1 WHERE id = ?').run(identity.attemptId);
    const { progress_sequence: sequence } = z.object({ progress_sequence: timestampSchema }).parse(db.prepare('SELECT progress_sequence FROM attempts WHERE id = ?').get(identity.attemptId));
    db.prepare("UPDATE publications SET state = 'superseded', updated_at = ? WHERE attempt_id = ? AND state = 'planned' AND json_extract(intent_json, '$.channel') IN ('summary', 'check')")
      .run(now, identity.attemptId);
    for (const channel of ['summary', 'check'] satisfies PublicationRecord['intent']['channel'][]) {
      publication({ identity, key: `${channel}-${sequence}-${key}`, channel, body }, now);
    }
  }

  function observation(repositoryId: string, pullNumber: number): PullObservation {
    const value = db.prepare('SELECT * FROM pulls WHERE repository_id = ? AND pull_number = ?').get(repositoryId, pullNumber);
    if (!value) return { generation: 0, rerunSequence: 0, blockedReason: null, observedHeadSha: null, observedBaseRef: null };
    const row = z.object({ generation: timestampSchema, rerun_sequence: timestampSchema,
      blocked_reason: z.string().nullable(), observed_head_sha: z.string().nullable(), observed_base_ref: z.string().nullable() }).parse(value);
    return { generation: row.generation, rerunSequence: row.rerun_sequence, blockedReason: row.blocked_reason,
      observedHeadSha: row.observed_head_sha, observedBaseRef: row.observed_base_ref };
  }
  function accessGeneration(): number {
    return z.object({ generation: timestampSchema }).parse(db.prepare('SELECT generation FROM access_clock WHERE id = 1').get()).generation;
  }
  function accessAllowed(installationId: string, repositoryId: string): boolean {
    return !db.prepare('SELECT 1 FROM access_rules WHERE installation_id = ? AND repository_id IN (?, ?) AND allowed = 0')
      .get(installationId, repositoryId, '*');
  }
  function invalidatePull(repositoryId: string, pullNumber: number, expectedGeneration: number,
    reason: string, headSha: string | null, baseRef: string | null): void {
    const observed = observation(repositoryId, pullNumber);
    if (observed.generation !== expectedGeneration) throw new StaleAdmissionObservationError();
    const now = Date.now();
    db.prepare(`INSERT INTO pulls (repository_id, pull_number, generation, blocked_reason, observed_head_sha, observed_base_ref, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, pull_number) DO UPDATE SET generation = excluded.generation,
      blocked_reason = excluded.blocked_reason, observed_head_sha = excluded.observed_head_sha, observed_base_ref = excluded.observed_base_ref, updated_at = excluded.updated_at`)
      .run(repositoryId, pullNumber, observed.generation + 1, reason, headSha, baseRef, now);
    db.prepare("UPDATE attempts SET state = 'superseded', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE repository_id = ? AND pull_number = ? AND state != 'superseded'")
      .run(now, repositoryId, pullNumber);
    db.prepare("UPDATE publications SET state = 'superseded', updated_at = ? WHERE attempt_id IN (SELECT id FROM attempts WHERE repository_id = ? AND pull_number = ?) AND state = 'planned'")
      .run(now, repositoryId, pullNumber);
  }

  function recordNotice(input: LivePull, expectedGeneration: number, kind: PublicationNotice['kind'], reason: string): PublicationNotice {
    const pull = livePullSchema.parse(input), target = publicationTargetSchema.parse({ installationId: pull.installationId,
      repositoryId: pull.repositoryId, owner: pull.owner, repo: pull.repo, pullNumber: pull.pullNumber,
      headSha: pull.headSha, baseSha: pull.baseSha, baseRef: pull.baseRef, mergeBaseSha: pull.mergeBaseSha });
    const observed = observation(pull.repositoryId, pull.pullNumber);
    if (observed.generation !== expectedGeneration || observed.blockedReason !== reason) throw new StaleAdmissionObservationError();
    const row = db.prepare('SELECT a.* FROM pulls p JOIN attempts a ON a.id = p.current_attempt_id WHERE p.repository_id = ? AND p.pull_number = ?').get(pull.repositoryId, pull.pullNumber);
    const reviewedIdentity = row ? readAttempt(row).identity : null;
    const inserted = db.prepare("INSERT INTO publication_notices(repository_id, pull_number, notice_json) VALUES (?, ?, '{}')").run(pull.repositoryId, pull.pullNumber);
    const notice = publicationNoticeSchema.parse({ id: String(inserted.lastInsertRowid), target, generation: observed.generation, kind, reason, reviewedIdentity });
    db.prepare('UPDATE publication_notices SET notice_json = ? WHERE id = ?').run(JSON.stringify(notice), notice.id);
    return notice;
  }
  function fenceCurrent(input: PublicationFence): boolean {
    const fence = publicationFenceSchema.parse(input);
    if (fence.kind === 'review') {
      const row = db.prepare('SELECT * FROM publications WHERE id = ?').get(fence.publicationId);
      if (!row) return false;
      const record = readPublication(row);
      if (record.state !== 'planned') return false;
      try { assertCurrent(record.intent.identity); } catch { return false; }
      return accessAllowed(record.intent.identity.installationId, record.intent.identity.repositoryId);
    }
    const row = db.prepare('SELECT notice_json FROM publication_notices WHERE id = ?').get(fence.noticeId);
    if (!row) return false;
    const notice = publicationNoticeSchema.parse(JSON.parse(z.object({ notice_json: z.string() }).parse(row).notice_json));
    const observed = observation(notice.target.repositoryId, notice.target.pullNumber);
    return observed.generation === notice.generation && observed.blockedReason === notice.reason &&
      accessAllowed(notice.target.installationId, notice.target.repositoryId);
  }
  function operation(key: string): PublicationOperation {
    return publicationOperationSchema.parse(JSON.parse(z.object({ operation_json: z.string() }).parse(
      db.prepare('SELECT operation_json FROM publication_operations WHERE operation_key = ?').get(key)).operation_json));
  }
  function saveOperation(value: PublicationOperation): void {
    db.prepare('UPDATE publication_operations SET operation_json = ? WHERE operation_key = ?').run(JSON.stringify(value), value.key);
  }

  return {
    admit(input) {
      const event = admittedEventSchema.parse(input);
      return transaction(() => {
        const replay = db.prepare('SELECT attempt_id FROM deliveries WHERE id = ?').get(event.deliveryId);
        if (replay) {
          const { attempt_id: id } = z.object({ attempt_id: z.number().int().positive() }).parse(replay);
          return { kind: 'duplicate', ...attempt(String(id)) };
        }
        const { repositoryId, pullNumber } = event.identity;
        if (event.expectedAccessGeneration !== undefined && event.expectedAccessGeneration !== accessGeneration()) throw new StaleAdmissionObservationError();
        if (!accessAllowed(event.identity.installationId, repositoryId)) throw new Error('Installation access revoked');
        const observed = observation(repositoryId, pullNumber);
        const workKey = createHash('sha256').update(JSON.stringify(event.identity)).digest('hex');
        const row = db.prepare('SELECT a.*, p.rerun_sequence FROM pulls p JOIN attempts a ON p.current_attempt_id = a.id WHERE p.repository_id = ? AND p.pull_number = ?')
          .get(repositoryId, pullNumber);
        const current = row ? readAttempt(row) : null;
        const snapshot = row ? z.object({ work_key: z.string(), rerun_sequence: timestampSchema }).parse(row) : null;
        const rerunSequence = snapshot?.rerun_sequence ?? 0;
        const duplicate = event.trigger.kind === 'automatic'
          ? current?.state !== 'superseded' && snapshot?.work_key === workKey : event.trigger.sequence <= rerunSequence;
        let admitted: AttemptRecord;
        let kind: 'created' | 'duplicate';
        if (current && duplicate) {
          admitted = current;
          kind = 'duplicate';
        } else {
          if (event.expectedGeneration !== observed.generation) throw new StaleAdmissionObservationError();
          const now = Date.now();
          db.prepare('INSERT INTO pulls (repository_id, pull_number, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
            .run(repositoryId, pullNumber, now);
          const generation = observed.generation + 1;
          db.prepare("UPDATE attempts SET state = 'superseded', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE repository_id = ? AND pull_number = ? AND state != 'superseded'")
            .run(now, repositoryId, pullNumber);
          db.prepare("UPDATE publications SET state = 'superseded', updated_at = ? WHERE attempt_id IN (SELECT id FROM attempts WHERE repository_id = ? AND pull_number = ?) AND state = 'planned'")
            .run(now, repositoryId, pullNumber);
          const inserted = db.prepare("INSERT INTO attempts (repository_id, pull_number, generation, work_key, identity_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
            .run(repositoryId, pullNumber, generation, workKey, '{}', now, now);
          const id = String(inserted.lastInsertRowid);
          const identity = reviewIdentitySchema.parse({ ...event.identity, attemptId: id, generation });
          db.prepare('UPDATE attempts SET identity_json = ? WHERE id = ?').run(JSON.stringify(identity), id);
          db.prepare('UPDATE pulls SET generation = ?, current_attempt_id = ?, updated_at = ?, rerun_sequence = ?, blocked_reason = NULL, observed_head_sha = ?, observed_base_ref = ? WHERE repository_id = ? AND pull_number = ?')
            .run(generation, id, now, event.trigger.kind === 'rerun' ? event.trigger.sequence : rerunSequence, event.identity.headSha, event.identity.baseRef, repositoryId, pullNumber);
          admitted = attempt(id);
          progress(identity, { state: 'queued', reason: null, nextAttemptAt: event.receivedAt, result: null }, now);
          kind = 'created';
        }
        db.prepare('INSERT INTO deliveries (id, attempt_id, received_at, trigger_json) VALUES (?, ?, ?, ?)')
          .run(event.deliveryId, admitted.identity.attemptId, event.receivedAt, JSON.stringify(event.trigger));
        return { kind, ...admitted };
      });
    },
    claim(now) {
      timestampSchema.parse(now);
      const expiresAt = timestampSchema.parse(now + LEASE_DURATION_MS);
      return transaction(() => {
        if (db.prepare("SELECT 1 FROM attempts WHERE state = 'leased' LIMIT 1").get()) return null;
        const candidate = db.prepare(`SELECT a.* FROM attempts a JOIN pulls p ON p.current_attempt_id = a.id
          WHERE a.state = 'queued' AND a.terminal_state IS NULL AND a.next_attempt_at <= ? AND a.generation = p.generation
          AND p.blocked_reason IS NULL ORDER BY a.last_work_at, a.created_at, a.id LIMIT 1`).get(now);
        if (!candidate) return null;
        const record = readAttempt(candidate);
        const lease = { token: randomUUID(), expiresAt };
        db.prepare("UPDATE attempts SET state = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ?, recovery_started_at = COALESCE(recovery_started_at, ?) WHERE id = ?")
          .run(lease.token, expiresAt, now, now, record.identity.attemptId);
        progress(record.identity, { state: 'leased', reason: null, nextAttemptAt: now, result: record.result }, now);
        return { ...record, recoveryStartedAt: record.recoveryStartedAt ?? now, state: 'leased', updatedAt: now, lease };
      });
    },
    renewLease(identity, ownership) {
      return transaction(() => {
        const owner = assertOwner(identity, ownership), expiresAt = timestampSchema.parse(owner.now + LEASE_DURATION_MS);
        db.prepare('UPDATE attempts SET lease_expires_at = ?, updated_at = ? WHERE id = ?').run(expiresAt, owner.now, identity.attemptId);
        return { token: owner.token, expiresAt };
      });
    },
    recoverExpiredLeases(now) {
      timestampSchema.parse(now);
      transaction(() => {
        const rows = db.prepare("SELECT * FROM attempts WHERE state = 'leased' AND lease_expires_at <= ?").all(now);
        for (const row of rows) {
          const record = readAttempt(row), losses = z.object({ lease_losses: timestampSchema }).parse(row).lease_losses + 1;
          const terminal = losses >= 4 || now - (record.recoveryStartedAt ?? now) >= RECOVERY_WINDOW_MS;
          const reason = terminal ? 'lease_recovery_exhausted' : 'lease_expired';
          db.prepare(`UPDATE attempts SET state = 'queued', terminal_state = ?, lease_token = NULL, lease_expires_at = NULL,
            lease_losses = ?, next_attempt_at = ?, last_work_at = MAX(?, (SELECT MAX(last_work_at) + 1 FROM attempts)), intervention_reason = ?, updated_at = ? WHERE id = ?`)
            .run(terminal ? 'incomplete' : null, losses, now, now, reason, now, record.identity.attemptId);
          progress(record.identity, { state: terminal ? 'incomplete' : 'queued', reason, nextAttemptAt: now, result: record.result }, now);
        }
      });
    },
    startPass(identity, passId, ownership) {
      return transaction(() => {
        assertOwner(identity, ownership);
        z.string().min(1).parse(passId);
        db.prepare(`INSERT INTO pass_executions VALUES (?, ?, 1) ON CONFLICT(attempt_id, pass_id) DO UPDATE SET count = count + 1`).run(identity.attemptId, passId);
        return z.object({ count: timestampSchema }).parse(db.prepare('SELECT count FROM pass_executions WHERE attempt_id = ? AND pass_id = ?').get(identity.attemptId, passId)).count;
      });
    },
    passAttempts(identity, passId) {
      const row = db.prepare('SELECT count FROM pass_executions WHERE attempt_id = ? AND pass_id = ?').get(identity.attemptId, passId);
      return row ? z.object({ count: timestampSchema }).parse(row).count : 0;
    },
    settle(identity, ownership, input) {
      const settlement = z.strictObject({ state: z.enum(['queued', 'complete', 'incomplete', 'intervention']),
        nextAttemptAt: timestampSchema, reason: z.string().nullable(), result: reviewResultSchema.nullable() }).parse(input);
      transaction(() => {
        const owner = assertOwner(identity, ownership);
        if (settlement.result && JSON.stringify(settlement.result.identity) !== JSON.stringify(identity)) throw new Error('Review identity mismatch');
        if (settlement.state === 'complete' && (!settlement.result || !['complete', 'skipped'].includes(settlement.result.status))) throw new Error('Missing complete review result');
        progress(identity, settlement, owner.now);
        // Break equal-clock ties so one review cannot keep the oldest queue position.
        db.prepare(`UPDATE attempts SET state = 'queued', terminal_state = ?, next_attempt_at = ?, last_work_at = MAX(?, (SELECT MAX(last_work_at) + 1 FROM attempts)), intervention_reason = ?,
          result_json = ?, updated_at = ?, lease_token = NULL, lease_expires_at = NULL WHERE id = ?`)
          .run(settlement.state === 'queued' ? null : settlement.state, settlement.nextAttemptAt, owner.now, settlement.reason,
            settlement.result ? JSON.stringify(settlement.result) : null, owner.now, identity.attemptId);
      });
    },
    savePass(identityInput, specInput, outcomeInput, ownership) {
      const identity = reviewIdentitySchema.parse(identityInput);
      const { bundlePath: _path, reviewUnits: _units, sourceMap: _map, trustedInstructions: _instructions, ...planned } = 'bundlePath' in specInput
        ? passSpecSchema.parse(specInput) : { ...plannedPassSchema.parse(specInput), bundlePath: null, reviewUnits: [], sourceMap: [], trustedInstructions: [] };
      const spec = plannedPassSchema.parse(planned);
      const outcome = validatePassOutcome(spec, outcomeInput);
      transaction(() => {
        const owner = assertOwner(identity, ownership);
        const specJson = JSON.stringify(spec);
        let outcomeJson = JSON.stringify(outcome);
        const existing = db.prepare('SELECT * FROM passes WHERE attempt_id = ? AND pass_id = ?').get(identity.attemptId, spec.id);
        if (existing) {
          const saved = readPass(existing, identity);
          if (JSON.stringify(saved.spec) !== specJson) throw new Error('Pass specification is immutable');
          if (JSON.stringify(saved.outcome) === outcomeJson) return;
          if (saved.outcome.status === 'completed') throw new Error('Completed pass is immutable');
          // A retry is not evidence that a previously validated finding disappeared.
          const findings = new Map(saved.outcome.findings.map(finding => [finding.id, finding]));
          for (const finding of outcome.findings) findings.set(finding.id, finding);
          outcomeJson = JSON.stringify({ ...outcome, findings: [...findings.values()] });
        }
        const now = owner.now;
        db.prepare('INSERT INTO passes (attempt_id, pass_id, spec_json, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id, pass_id) DO UPDATE SET outcome_json = excluded.outcome_json, updated_at = excluded.updated_at')
          .run(identity.attemptId, spec.id, specJson, outcomeJson, now, now);
      });
    },
    current(repositoryId, pullNumber) {
      const row = db.prepare('SELECT a.*, p.rerun_sequence FROM attempts a JOIN pulls p ON p.current_attempt_id = a.id WHERE p.repository_id = ? AND p.pull_number = ?')
        .get(repositoryId, pullNumber);
      if (!row) return null;
      const record = readAttempt(row);
      const passes = db.prepare('SELECT * FROM passes WHERE attempt_id = ? ORDER BY id').all(record.identity.attemptId).map((pass) => readPass(pass, record.identity));
      const { rerun_sequence: rerunSequence } = z.object({ rerun_sequence: timestampSchema }).parse(row);
      return { ...record, rerunSequence, passes };
    },
    passHistory(repositoryId, pullNumber) {
      return db.prepare(`SELECT p.*, a.identity_json FROM passes p JOIN attempts a ON a.id = p.attempt_id
        WHERE a.repository_id = ? AND a.pull_number = ? ORDER BY p.id`).all(repositoryId, pullNumber)
        .map((row) => readPass(row, reviewIdentitySchema.parse(JSON.parse(z.object({ identity_json: z.string() }).parse(row).identity_json))));
    },
    observation, accessGeneration, accessAllowed,
    restoreAccess(installationId, repositoryId, expectedAccessGeneration) {
      timestampSchema.parse(expectedAccessGeneration);
      return transaction(() => {
        if (accessGeneration() !== expectedAccessGeneration) throw new StaleAdmissionObservationError();
        const restored = db.prepare('DELETE FROM access_rules WHERE installation_id = ? AND repository_id IN (?, ?) AND allowed = 0')
          .run(installationId, repositoryId, '*');
        if (restored.changes > 0) db.prepare('UPDATE access_clock SET generation = generation + 1 WHERE id = 1').run();
        return accessGeneration();
      });
    },
    trackedPulls(installationId) {
      return db.prepare('SELECT a.* FROM pulls p JOIN attempts a ON a.id = p.current_attempt_id').all()
        .map(readAttempt).filter((record) => record.identity.installationId === installationId)
        .map((record) => ({ repositoryId: record.identity.repositoryId, pullNumber: record.identity.pullNumber }))
        .concat(db.prepare('SELECT notice_json FROM publication_notices').all().map(row => publicationNoticeSchema.parse(JSON.parse(z.object({ notice_json: z.string() }).parse(row).notice_json)))
          .filter(notice => notice.target.installationId === installationId).map(notice => ({ repositoryId: notice.target.repositoryId, pullNumber: notice.target.pullNumber })))
        .filter((pull, index, all) => all.findIndex(other => other.repositoryId === pull.repositoryId && other.pullNumber === pull.pullNumber) === index);
    },
    trackedInstallations() {
      return [...new Set(db.prepare('SELECT a.* FROM pulls p JOIN attempts a ON a.id = p.current_attempt_id').all()
        .map(readAttempt).map((record) => record.identity.installationId)
        .concat(db.prepare('SELECT notice_json FROM publication_notices').all().map(row => publicationNoticeSchema.parse(JSON.parse(z.object({ notice_json: z.string() }).parse(row).notice_json)).target.installationId)))];
    },
    invalidatePull(repositoryId, pullNumber, expectedGeneration, reason, headSha, baseRef, live) {
      timestampSchema.parse(expectedGeneration);
      transaction(() => {
        if (live && (live.repositoryId !== repositoryId || live.pullNumber !== pullNumber || live.headSha !== headSha || live.baseRef !== baseRef)) throw new Error('Notice destination mismatch');
        invalidatePull(repositoryId, pullNumber, expectedGeneration, reason, headSha, baseRef);
        if (live) recordNotice(live, expectedGeneration + 1, ['configuration_failure', 'actor_provenance_unknown', 'untrusted_base'].includes(reason) ? 'configuration_failure'
          : ['base_changed', 'retarget', 'publication_outdated', 'superseded', 'policy_changed'].includes(reason) ? 'outdated' : 'cancelled', reason);
      });
    },
    setAccess(installationId, repositoryId, allowed) {
      transaction(() => {
        db.prepare('INSERT INTO access_rules VALUES (?, ?, ?) ON CONFLICT(installation_id, repository_id) DO UPDATE SET allowed = excluded.allowed')
          .run(installationId, repositoryId ?? '*', allowed ? 1 : 0);
        db.prepare('UPDATE access_clock SET generation = generation + 1 WHERE id = 1').run();
        if (allowed) return;
        const rows = db.prepare('SELECT a.* FROM pulls p JOIN attempts a ON a.id = p.current_attempt_id').all();
        for (const value of rows) {
          const record = readAttempt(value);
          if (record.identity.installationId !== installationId || (repositoryId !== null && record.identity.repositoryId !== repositoryId)) continue;
          const identity = record.identity;
          invalidatePull(identity.repositoryId, identity.pullNumber, observation(identity.repositoryId, identity.pullNumber).generation,
            'access_revoked', identity.headSha, identity.baseRef);
        }
      });
    },
    receipt(deliveryId) {
      const value = db.prepare('SELECT result_json FROM webhook_receipts WHERE id = ?').get(deliveryId);
      return value ? webhookAdmissionSchema.parse(JSON.parse(z.object({ result_json: z.string() }).parse(value).result_json)) : null;
    },
    acknowledge(deliveryId, input, target) {
      const admission = webhookAdmissionSchema.parse(input);
      db.prepare('INSERT INTO webhook_receipts(id, result_json, received_at, repository_id, pull_number) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(deliveryId, JSON.stringify(admission), Date.now(), target?.repositoryId ?? null, target?.pullNumber ?? null);
    },
    planPublication(input, ownership) {
      const intent = publicationIntentSchema.parse(input);
      return transaction(() => {
        const owner = assertOwner(intent.identity, ownership);
        return publication(intent, owner.now);
      });
    },
    publications(repositoryId, pullNumber) {
      return db.prepare(`SELECT p.* FROM publications p JOIN attempts a ON a.id = p.attempt_id
        WHERE a.repository_id = ? AND a.pull_number = ? ORDER BY p.id`).all(repositoryId, pullNumber).map(readPublication);
    },
    publicationNotices(repositoryId, pullNumber) {
      return db.prepare('SELECT notice_json FROM publication_notices ORDER BY id').all()
        .map((row) => publicationNoticeSchema.parse(JSON.parse(z.object({ notice_json: z.string() }).parse(row).notice_json)))
        .filter((notice) => (repositoryId === undefined || notice.target.repositoryId === repositoryId) && (pullNumber === undefined || notice.target.pullNumber === pullNumber));
    },
    recordNotice(input, expectedGeneration, kind, reason) {
      return transaction(() => recordNotice(input, expectedGeneration, kind, reason));
    },
    publicationFenceCurrent: fenceCurrent,
    planPublicationOperation(input) {
      const candidate = publicationOperationSchema.parse({ ...input, state: 'planned', remoteId: null });
      return transaction(() => {
        if (!fenceCurrent(candidate.fence)) throw new StaleAdmissionObservationError();
        const fence = candidate.fence;
        const source = fence.kind === 'review' ? readPublication(db.prepare('SELECT * FROM publications WHERE id = ?').get(fence.publicationId)).intent.identity
          : publicationNoticeSchema.parse(JSON.parse(z.object({ notice_json: z.string() }).parse(db.prepare('SELECT notice_json FROM publication_notices WHERE id = ?').get(fence.noticeId)).notice_json)).target;
        const target = publicationTargetSchema.parse(Object.fromEntries(Object.entries(source).filter(([key]) => key in publicationTargetSchema.shape)));
        if (JSON.stringify(target) !== JSON.stringify(candidate.target)) throw new Error('Publication target mismatch');
        const existing = db.prepare('SELECT 1 FROM publication_operations WHERE operation_key = ?').get(candidate.key);
        if (existing) {
          const saved = operation(candidate.key);
          if (JSON.stringify({ ...saved, state: 'planned', remoteId: null }) !== JSON.stringify(candidate)) throw new Error('Publication operation is immutable');
          return saved;
        }
        db.prepare('INSERT INTO publication_operations VALUES (?, ?, ?, ?)').run(candidate.key, candidate.target.repositoryId, candidate.target.pullNumber, JSON.stringify(candidate));
        return candidate;
      });
    },
    publicationOperations(repositoryId, pullNumber) {
      return db.prepare('SELECT operation_key FROM publication_operations WHERE repository_id = ? AND pull_number = ?').all(repositoryId, pullNumber)
        .map((row) => operation(z.object({ operation_key: z.string() }).parse(row).operation_key));
    },
    markPublicationSending(key) {
      transaction(() => { const saved = operation(key); if (!fenceCurrent(saved.fence)) throw new StaleAdmissionObservationError();
        if (saved.state === 'planned') saveOperation({ ...saved, state: 'sending' }); });
    },
    planPublicationUndo(resolveKey) {
      return transaction(() => {
        const original = operation(resolveKey);
        if (original.channel !== 'resolve' || original.state === 'planned') throw new Error('No resolution to undo');
        const key = createHash('sha256').update(resolveKey + ':undo').digest('hex');
        if (db.prepare('SELECT 1 FROM publication_operations WHERE operation_key = ?').get(key)) return operation(key);
        const undo: PublicationOperation = { ...original, key, channel: 'unresolve', state: 'sending', remoteId: null };
        db.prepare('INSERT INTO publication_operations VALUES (?, ?, ?, ?)').run(key, undo.target.repositoryId, undo.target.pullNumber, JSON.stringify(undo));
        return undo;
      });
    },
    acknowledgePublication(key, remoteId) {
      z.string().min(1).parse(remoteId);
      transaction(() => { const saved = operation(key); saveOperation({ ...saved, state: 'acknowledged', remoteId }); });
    },
    interruptLeases(now) {
      timestampSchema.parse(now);
      db.prepare("UPDATE attempts SET lease_expires_at = ? WHERE state = 'leased'").run(now);
    },
    observePullState(repositoryId, pullNumber, state, now) {
      timestampSchema.parse(now);
      db.prepare(`INSERT INTO pulls(repository_id, pull_number, updated_at, closed_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(repository_id, pull_number) DO UPDATE SET closed_at = CASE WHEN ? = 'open' THEN NULL ELSE COALESCE(pulls.closed_at, excluded.closed_at) END`)
        .run(repositoryId, pullNumber, now, state === 'closed' ? now : null, state);
    },
    purgeClosedBefore(cutoff) {
      timestampSchema.parse(cutoff);
      return transaction(() => {
        const expired = db.prepare('SELECT repository_id, pull_number FROM pulls WHERE closed_at IS NOT NULL AND closed_at <= ?').all(cutoff);
        for (const row of expired) {
          const { repository_id: repositoryId, pull_number: pullNumber } = z.object({ repository_id: z.string(), pull_number: z.number() }).parse(row);
          db.prepare('DELETE FROM webhook_receipts WHERE repository_id = ? AND pull_number = ?').run(repositoryId, pullNumber);
          const attempts = 'SELECT id FROM attempts WHERE repository_id = ? AND pull_number = ?';
          db.prepare(`DELETE FROM webhook_receipts WHERE json_extract(result_json, '$.attemptId') IN (${attempts})`).run(repositoryId, pullNumber);
          for (const table of ['deliveries', 'passes', 'publications', 'pass_executions']) db.prepare(`DELETE FROM ${table} WHERE attempt_id IN (${attempts})`).run(repositoryId, pullNumber);
          for (const table of ['publication_operations', 'publication_notices']) db.prepare(`DELETE FROM ${table} WHERE repository_id = ? AND pull_number = ?`).run(repositoryId, pullNumber);
          db.prepare('UPDATE pulls SET current_attempt_id = NULL WHERE repository_id = ? AND pull_number = ?').run(repositoryId, pullNumber);
          db.prepare('DELETE FROM attempts WHERE repository_id = ? AND pull_number = ?').run(repositoryId, pullNumber);
          db.prepare('DELETE FROM pulls WHERE repository_id = ? AND pull_number = ?').run(repositoryId, pullNumber);
        }
        db.prepare(`DELETE FROM webhook_receipts WHERE received_at <= ? AND NOT EXISTS (
          SELECT 1 FROM pulls p WHERE p.repository_id = webhook_receipts.repository_id AND p.pull_number = webhook_receipts.pull_number
        )`).run(cutoff);
        return expired.length;
      });
    },
    health() {
      const count = (sql: string) => z.object({ count: z.number() }).parse(db.prepare(sql).get()).count;
      return { workerFailures: count("SELECT count(*) AS count FROM attempts a JOIN pulls p ON p.current_attempt_id = a.id WHERE a.state != 'superseded' AND a.terminal_state IN ('incomplete','intervention')"),
        publicationFailures: count("SELECT count(*) AS count FROM publication_operations WHERE json_extract(operation_json, '$.state') = 'sending'") };
    },
    async backup(destination) {
      await backup(db, destination);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
