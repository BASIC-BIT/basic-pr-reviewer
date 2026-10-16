import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  admittedEventSchema, attemptStateSchema, passOutcomeSchema, passSpecSchema,
  publicationIntentSchema, reviewIdentitySchema, timestampSchema,
} from './contracts.js';
import type {
  AttemptRecord, PassRecord, PublicationRecord, ReviewIdentity, Store,
} from './contracts.js';

export const LEASE_DURATION_MS = 60 * 60 * 1_000;
const attemptRowSchema = z.object({
  identity_json: z.string(), state: attemptStateSchema,
  created_at: timestampSchema, updated_at: timestampSchema,
  lease_token: z.string().nullable(), lease_expires_at: timestampSchema.nullable(),
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
  };
  if (row.state === 'leased') {
    if (row.lease_token === null || row.lease_expires_at === null) throw new Error('Invalid stored lease');
    return { ...record, state: row.state, lease: { token: row.lease_token, expiresAt: row.lease_expires_at } };
  }
  return { ...record, state: row.state, lease: null };
}

function readPass(value: unknown): PassRecord {
  const row = passRowSchema.parse(value);
  return {
    id: String(row.id), spec: passSpecSchema.parse(JSON.parse(row.spec_json)),
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
    if (version !== 0 && version !== 1) throw new Error(`Unsupported schema version ${version}`);
    db.exec('PRAGMA journal_mode = WAL');
    if (version === 0) {
      transaction(() => {
        const current = z.object({ user_version: z.number().int() }).parse(db.prepare('PRAGMA user_version').get());
        if (current.user_version === 0) db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
        else if (current.user_version !== 1) throw new Error(`Unsupported schema version ${current.user_version}`);
      });
    }
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
    const current = db.prepare('SELECT current_attempt_id FROM pulls WHERE repository_id = ? AND pull_number = ?')
      .get(identity.repositoryId, identity.pullNumber);
    const pointer = z.object({ current_attempt_id: z.number().int().positive() }).parse(current);
    if (String(pointer.current_attempt_id) !== identity.attemptId || stored.state === 'superseded') {
      throw new Error('Stale review generation');
    }
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
        const workKey = createHash('sha256').update(JSON.stringify({ identity: event.identity, trigger: event.trigger })).digest('hex');
        const existing = db.prepare('SELECT * FROM attempts WHERE work_key = ?').get(workKey);
        let admitted: AttemptRecord;
        let kind: 'created' | 'duplicate';
        if (existing) {
          admitted = readAttempt(existing);
          kind = 'duplicate';
        } else {
          const { repositoryId, pullNumber } = event.identity;
          const now = Date.now();
          db.prepare('INSERT INTO pulls (repository_id, pull_number, updated_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
            .run(repositoryId, pullNumber, now);
          const prior = z.object({ generation: z.number().int().nonnegative() }).parse(
            db.prepare('SELECT generation FROM pulls WHERE repository_id = ? AND pull_number = ?').get(repositoryId, pullNumber));
          const generation = prior.generation + 1;
          db.prepare("UPDATE attempts SET state = 'superseded', lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE repository_id = ? AND pull_number = ? AND state != 'superseded'")
            .run(now, repositoryId, pullNumber);
          db.prepare("UPDATE publications SET state = 'superseded', updated_at = ? WHERE attempt_id IN (SELECT id FROM attempts WHERE repository_id = ? AND pull_number = ?) AND state = 'planned'")
            .run(now, repositoryId, pullNumber);
          const inserted = db.prepare("INSERT INTO attempts (repository_id, pull_number, generation, work_key, identity_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
            .run(repositoryId, pullNumber, generation, workKey, '{}', now, now);
          const id = String(inserted.lastInsertRowid);
          const identity = reviewIdentitySchema.parse({ ...event.identity, attemptId: id, generation });
          db.prepare('UPDATE attempts SET identity_json = ? WHERE id = ?').run(JSON.stringify(identity), id);
          db.prepare('UPDATE pulls SET generation = ?, current_attempt_id = ?, updated_at = ? WHERE repository_id = ? AND pull_number = ?')
            .run(generation, id, now, repositoryId, pullNumber);
          admitted = attempt(id);
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
        const candidate = db.prepare("SELECT a.* FROM attempts a JOIN pulls p ON p.current_attempt_id = a.id WHERE a.state = 'queued' OR (a.state = 'leased' AND a.lease_expires_at <= ?) ORDER BY a.created_at, a.id LIMIT 1").get(now);
        if (!candidate) return null;
        const record = readAttempt(candidate);
        const lease = { token: randomUUID(), expiresAt };
        db.prepare("UPDATE attempts SET state = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?")
          .run(lease.token, expiresAt, now, record.identity.attemptId);
        return { ...record, state: 'leased', updatedAt: now, lease };
      });
    },
    savePass(identityInput, specInput, outcomeInput) {
      const identity = reviewIdentitySchema.parse(identityInput);
      const spec = passSpecSchema.parse(specInput);
      const outcome = passOutcomeSchema.parse(outcomeInput);
      if (spec.id !== outcome.passId) throw new Error('Pass ID mismatch');
      transaction(() => {
        assertCurrent(identity);
        const specJson = JSON.stringify(spec);
        const outcomeJson = JSON.stringify(outcome);
        const existing = db.prepare('SELECT * FROM passes WHERE attempt_id = ? AND pass_id = ?').get(identity.attemptId, spec.id);
        if (existing) {
          const saved = readPass(existing);
          if (JSON.stringify(saved.spec) !== specJson) throw new Error('Pass specification is immutable');
          if (JSON.stringify(saved.outcome) === outcomeJson) return;
          if (saved.outcome.status === 'completed') throw new Error('Completed pass is immutable');
        }
        const now = Date.now();
        db.prepare('INSERT INTO passes (attempt_id, pass_id, spec_json, outcome_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(attempt_id, pass_id) DO UPDATE SET outcome_json = excluded.outcome_json, updated_at = excluded.updated_at')
          .run(identity.attemptId, spec.id, specJson, outcomeJson, now, now);
      });
    },
    current(repositoryId, pullNumber) {
      const row = db.prepare('SELECT a.* FROM attempts a JOIN pulls p ON p.current_attempt_id = a.id WHERE p.repository_id = ? AND p.pull_number = ?')
        .get(repositoryId, pullNumber);
      if (!row) return null;
      const record = readAttempt(row);
      const passes = db.prepare('SELECT * FROM passes WHERE attempt_id = ? ORDER BY id').all(record.identity.attemptId).map(readPass);
      return { ...record, passes };
    },
    planPublication(input) {
      const intent = publicationIntentSchema.parse(input);
      return transaction(() => {
        assertCurrent(intent.identity);
        const existing = db.prepare('SELECT * FROM publications WHERE attempt_id = ? AND publication_key = ?')
          .get(intent.identity.attemptId, intent.key);
        if (existing) {
          const record = readPublication(existing);
          if (JSON.stringify(record.intent) !== JSON.stringify(intent)) throw new Error('Publication intent is immutable');
          return record;
        }
        const now = Date.now();
        const inserted = db.prepare("INSERT INTO publications (attempt_id, publication_key, intent_json, state, created_at, updated_at) VALUES (?, ?, ?, 'planned', ?, ?)")
          .run(intent.identity.attemptId, intent.key, JSON.stringify(intent), now, now);
        return readPublication(db.prepare('SELECT * FROM publications WHERE id = ?').get(inserted.lastInsertRowid));
      });
    },
    async backup(destination) {
      await backup(db, destination);
    },
    close() {
      if (db.isOpen) db.close();
    },
  };
}
