import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, LEASE_DURATION_MS, StaleAdmissionObservationError } from '../src/store.js';
import type { PublicationIntent, Store } from '../src/contracts.js';
import { event, outcome, spec } from './fixtures/identities.js';

describe('persistent review ledger', () => {
  let directory: string;
  let path: string;
  const stores: Store[] = [];
  function open(): Store {
    const store = openStore(path);
    stores.push(store);
    return store;
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'review-ledger-'));
    path = join(directory, 'ledger.sqlite');
  });
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('deduplicates delivery replay and distinct deliveries for the same logical work', () => {
    const store = open();
    const first = store.admit(event);
    expect(first.kind).toBe('created');
    expect(store.admit(event)).toMatchObject({ kind: 'duplicate', identity: first.identity });
    expect(store.admit({ ...event, deliveryId: 'delivery-2' })).toMatchObject({
      kind: 'duplicate', identity: first.identity,
    });
    expect(store.current('200', 42)?.identity).toEqual(first.identity);
    expect(store.claim(2_000)?.identity).toEqual(first.identity);
    expect(store.claim(2_001)).toBeNull();
  });

  it('increments generation for an explicit rerun and deduplicates its sequence', () => {
    const store = open();
    const first = store.admit(event);
    const rerun = store.admit({ ...event, deliveryId: 'rerun-1', expectedGeneration: first.identity.generation, trigger: { kind: 'rerun', sequence: 1 } });
    expect(rerun.identity.generation).toBe(first.identity.generation + 1);
    expect(rerun.identity.attemptId).not.toBe(first.identity.attemptId);
    expect(store.admit({ ...event, deliveryId: 'rerun-replay', trigger: { kind: 'rerun', sequence: 1 } }))
      .toMatchObject({ kind: 'duplicate', identity: rerun.identity });
    expect(store.admit({ ...event, deliveryId: 'late-automatic' }).identity).toEqual(rerun.identity);
    expect(store.admit({ ...event, deliveryId: 'fresh-automatic', expectedGeneration: rerun.identity.generation }).identity).toEqual(rerun.identity);
    expect(store.current('200', 42)?.identity).toEqual(rerun.identity);
    expect(store.claim(2_000)?.identity).toEqual(rerun.identity);
  });

  it('fences stale generations and mismatched identities from current coverage', () => {
    const store = open();
    const first = store.admit(event);
    const second = store.admit({ ...event, deliveryId: 'new-head', expectedGeneration: first.identity.generation, identity: { ...event.identity, headSha: 'f'.repeat(40) } });
    expect(() => store.savePass(first.identity, spec, outcome)).toThrow(/stale/i);
    expect(() => store.savePass({ ...second.identity, baseSha: 'a'.repeat(40) }, spec, outcome)).toThrow(/identity/i);
    expect(store.current('200', 42)?.passes).toEqual([]);
    store.savePass(second.identity, spec, outcome);
    expect(store.current('200', 42)?.passes).toHaveLength(1);
  });

  it('creates a new current generation when a freshly observed head returns from A to B to A', () => {
    const store = open();
    const first = store.admit(event);
    const second = store.admit({ ...event, deliveryId: 'head-b', expectedGeneration: first.identity.generation, identity: { ...event.identity, headSha: 'f'.repeat(40) } });
    const returned = store.admit({ ...event, deliveryId: 'head-a-again', expectedGeneration: second.identity.generation });
    expect(returned.kind).toBe('created');
    expect(returned.identity.generation).toBe(second.identity.generation + 1);
    expect(returned.identity.attemptId).not.toBe(first.identity.attemptId);
    expect(store.current('200', 42)?.identity).toEqual(returned.identity);
    expect(() => store.savePass(second.identity, spec, outcome)).toThrow(/stale/i);
    expect(store.claim(2_000)?.identity).toEqual(returned.identity);
  });

  it('rejects a stale observation before admitting a fresh transition and permits a new live read', () => {
    const firstStore = open();
    const secondStore = open();
    const first = firstStore.admit(event);
    const observedGeneration = first.identity.generation;
    const second = secondStore.admit({ ...event, deliveryId: 'head-b', expectedGeneration: observedGeneration, identity: { ...event.identity, headSha: 'f'.repeat(40) } });
    expect(() => firstStore.admit({ ...event, deliveryId: 'delayed-a', expectedGeneration: observedGeneration })).toThrow(StaleAdmissionObservationError);
    expect(firstStore.current('200', 42)?.identity).toEqual(second.identity);
    const refreshed = firstStore.admit({ ...event, deliveryId: 'delayed-a', expectedGeneration: second.identity.generation });
    expect(refreshed.identity.generation).toBe(second.identity.generation + 1);
  });

  it('replays a known old delivery without restoring its superseded generation', () => {
    const store = open();
    const first = store.admit(event);
    const second = store.admit({ ...event, deliveryId: 'head-b', expectedGeneration: first.identity.generation, identity: { ...event.identity, headSha: 'f'.repeat(40) } });
    expect(store.admit(event)).toMatchObject({ kind: 'duplicate', identity: first.identity, state: 'superseded' });
    expect(store.current('200', 42)?.identity).toEqual(second.identity);
    expect(store.claim(2_000)?.identity).toEqual(second.identity);
  });

  it('persists a PR-wide rerun high-water mark and ignores repeated or unseen lower sequences', () => {
    const store = open();
    const first = store.admit(event);
    const rerun = store.admit({ ...event, deliveryId: 'rerun-3', expectedGeneration: first.identity.generation, trigger: { kind: 'rerun', sequence: 3 } });
    store.close();
    const reopened = open();
    expect(reopened.current('200', 42)?.rerunSequence).toBe(3);
    expect(reopened.admit({ ...event, deliveryId: 'rerun-2-late', expectedGeneration: rerun.identity.generation, trigger: { kind: 'rerun', sequence: 2 } }))
      .toMatchObject({ kind: 'duplicate', identity: rerun.identity });
    const second = reopened.admit({ ...event, deliveryId: 'head-b', expectedGeneration: rerun.identity.generation, identity: { ...event.identity, headSha: 'f'.repeat(40) } });
    expect(reopened.admit({ ...event, deliveryId: 'rerun-3-late', trigger: { kind: 'rerun', sequence: 3 } }))
      .toMatchObject({ kind: 'duplicate', identity: second.identity });
    expect(reopened.current('200', 42)).toMatchObject({ identity: second.identity, rerunSequence: 3 });
    expect(() => reopened.admit({ ...event, deliveryId: 'rerun-4', trigger: { kind: 'rerun', sequence: 4 } }))
      .toThrow(StaleAdmissionObservationError);
    const next = reopened.admit({ ...event, deliveryId: 'rerun-4', expectedGeneration: second.identity.generation, identity: { ...event.identity, headSha: 'f'.repeat(40) }, trigger: { kind: 'rerun', sequence: 4 } });
    expect(next.identity.generation).toBe(second.identity.generation + 1);
    expect(reopened.current('200', 42)?.rerunSequence).toBe(4);
  });

  it('retains saved pass JSON and delivery deduplication across a close and reopen', () => {
    const firstStore = open();
    const admitted = firstStore.admit(event);
    firstStore.savePass(admitted.identity, spec, outcome);
    firstStore.close();
    const reopened = open();
    expect(reopened.current('200', 42)).toMatchObject({
      identity: admitted.identity, passes: [{ spec, outcome }],
    });
    expect(reopened.admit(event)).toMatchObject({ kind: 'duplicate', identity: admitted.identity });
    reopened.savePass(admitted.identity, spec, outcome);
    expect(reopened.current('200', 42)?.passes).toHaveLength(1);
    expect(() => reopened.savePass(admitted.identity, { ...spec, contextHash: '0'.repeat(64) }, outcome)).toThrow(/pass/i);
  });

  it('allows a failed pass to recover while preserving a completed result', () => {
    const store = open();
    const admitted = store.admit(event);
    store.savePass(admitted.identity, spec, { ...outcome, status: 'failed', failureCode: 'temporary' });
    store.savePass(admitted.identity, spec, outcome);
    expect(store.current('200', 42)?.passes[0]?.outcome).toEqual(outcome);
    expect(() => store.savePass(admitted.identity, spec, { ...outcome, findings: [] })).toThrow(/completed pass/i);
  });

  it('leases an attempt to one connection and reclaims it only after expiry', () => {
    const firstStore = open();
    const secondStore = open();
    firstStore.admit(event);
    const claim = firstStore.claim(2_000);
    expect(claim).not.toBeNull();
    expect(secondStore.claim(2_001)).toBeNull();
    expect(secondStore.claim(2_000 + LEASE_DURATION_MS - 1)).toBeNull();
    const reclaimed = secondStore.claim(2_000 + LEASE_DURATION_MS);
    expect(reclaimed?.identity).toEqual(claim?.identity);
    expect(reclaimed?.lease.token).not.toBe(claim?.lease.token);
    expect(firstStore.claim(2_000 + LEASE_DURATION_MS + 1)).toBeNull();
  });

  it('persists immutable, idempotent publication intent and rejects stale intent', () => {
    const firstStore = open();
    const first = firstStore.admit(event);
    const intent: PublicationIntent = { identity: first.identity, key: 'summary-1', channel: 'summary', body: 'Synthetic summary.' };
    const planned = firstStore.planPublication(intent);
    expect(planned).toMatchObject({ state: 'planned', intent });
    firstStore.close();
    const reopened = open();
    expect(reopened.planPublication(intent)).toEqual(planned);
    expect(() => reopened.planPublication({ ...intent, body: 'Different summary.' })).toThrow(/publication/i);
    reopened.admit({ ...event, deliveryId: 'rerun', expectedGeneration: first.identity.generation, trigger: { kind: 'rerun', sequence: 1 } });
    expect(() => reopened.planPublication({ ...intent, key: 'stale-summary' })).toThrow(/stale/i);
  });

  it('rejects an unknown database schema version without rewriting it', () => {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 99');
    db.close();
    expect(() => openStore(path)).toThrow(/schema version/i);
    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 99 });
    unchanged.close();
  });

  it('creates an online backup that retains saved progress', async () => {
    const store = open();
    const admitted = store.admit(event);
    store.savePass(admitted.identity, spec, outcome);
    const backupPath = join(directory, 'backup.sqlite');
    await store.backup(backupPath);
    const backupStore = openStore(backupPath);
    stores.push(backupStore);
    expect(backupStore.current('200', 42)?.passes[0]?.outcome).toEqual(outcome);
  });

  it('rejects malformed identities and unsupported event versions before admission', () => {
    const store = open();
    // @ts-expect-error Runtime input must still reject versions unknown to TypeScript callers.
    expect(() => store.admit({ ...event, schemaVersion: 2 })).toThrow();
    expect(() => store.admit({ ...event, expectedGeneration: -1 })).toThrow();
    for (const field of ['headSha', 'baseSha', 'mergeBaseSha']) {
      expect(() => store.admit({ ...event, identity: { ...event.identity, [field]: 'bad-sha' } })).toThrow();
    }
    expect(store.current('200', 42)).toBeNull();
  });

  it('rejects malformed findings and worker-supplied coverage before persisting', () => {
    const store = open();
    const admitted = store.admit(event);
    const malformed = [
      { ...outcome, passId: 'another-pass' },
      { ...outcome, findings: [{ id: 'bad', message: '', severity: 'P9' }] },
      { ...outcome, findings: [{ ...outcome.findings[0], location: { kind: 'line', path: { bytesBase64: '***' }, side: 'RIGHT', startLine: 2, endLine: 1 } }] },
      { ...outcome, coverage: ['unit-1'] },
    ];
    for (const invalid of malformed) {
      // @ts-expect-error Malformed worker output crosses a runtime boundary despite its static type.
      expect(() => store.savePass(admitted.identity, spec, invalid)).toThrow();
    }
    expect(store.current('200', 42)?.passes).toEqual([]);
  });

  it('keeps hostile untrusted text in bound values', () => {
    const store = open();
    const admitted = store.admit({ ...event, identity: { ...event.identity, baseRef: "main'; DROP TABLE attempts; --" } });
    store.savePass(admitted.identity, { ...spec, id: "pass'); DROP TABLE pulls; --" }, {
      ...outcome, passId: "pass'); DROP TABLE pulls; --",
    });
    expect(store.current('200', 42)?.passes).toHaveLength(1);
    expect(store.admit({ ...event, deliveryId: 'still-works', expectedGeneration: admitted.identity.generation }).kind).toBe('created');
  });
  it('retains cancelled generations, rerun high-water and receipts across restart', () => {
    const store = open();
    const identity = store.admit({ ...event, trigger: { kind: 'rerun', sequence: 3 } }).identity;
    store.invalidatePull('200', 42, 1, 'skipped', identity.headSha, identity.baseRef);
    store.acknowledge('cancelled', { kind: 'cancelled', reason: 'skipped' });
    store.close();
    const restored = open();
    expect(restored.observation('200', 42)).toMatchObject({ generation: 2, rerunSequence: 3, blockedReason: 'skipped' });
    expect(restored.receipt('cancelled')).toEqual({ kind: 'cancelled', reason: 'skipped' });
    expect(restored.claim(Date.now())).toBeNull();
    const admitted = restored.admit({ ...event, deliveryId: 'post-restart', expectedGeneration: 2, trigger: { kind: 'rerun', sequence: 4 } });
    expect(admitted.identity.generation).toBe(3);
  });
  it('fences a second base invalidation racing with admission even when head and cancellation reason are unchanged', () => {
    const store = open();
    const first = store.admit(event);
    store.invalidatePull('200', 42, first.identity.generation, 'base_changed', event.identity.headSha, 'main');
    const observed = store.observation('200', 42);
    store.invalidatePull('200', 42, observed.generation, 'base_changed', event.identity.headSha, 'main');
    expect(() => store.admit({ ...event, deliveryId: 'between-base-pushes', expectedGeneration: observed.generation,
      identity: { ...event.identity, baseSha: 'f'.repeat(40) } })).toThrow(StaleAdmissionObservationError);
  });
  it('restores verified installation and repository access atomically without reviving cancelled attempts', () => {
    const store = open();
    store.admit(event);
    store.setAccess('100', null, false);
    store.setAccess('100', '200', false);
    const generation = store.observation('200', 42).generation;
    const accessGeneration = store.accessGeneration();
    const concurrent = open();
    concurrent.setAccess('100', '200', false);
    expect(() => store.restoreAccess('100', '200', accessGeneration)).toThrow(StaleAdmissionObservationError);
    expect(store.accessAllowed('100', '200')).toBe(false);
    const cancelledGeneration = store.observation('200', 42).generation;
    expect(cancelledGeneration).toBeGreaterThan(generation);
    store.restoreAccess('100', '200', store.accessGeneration());
    expect(store.accessAllowed('100', '200')).toBe(true);
    expect(store.current('200', 42)?.state).toBe('superseded');
    expect(store.observation('200', 42).generation).toBe(cancelledGeneration);
    expect(store.claim(Date.now())).toBeNull();
  });
});
