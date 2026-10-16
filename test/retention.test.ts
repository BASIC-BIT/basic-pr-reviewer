import { afterEach, expect, it } from 'vitest';
import { openStore } from '../src/store.js';
import { createRetention } from '../src/retention.js';
import { event, spec, outcome } from './fixtures/identities.js';
const stores: ReturnType<typeof openStore>[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
const day = 86400000;
it('retains open and day29 closed records, deletes day30 and cancels expiry on reopen', async () => {
  const store = openStore(':memory:'); stores.push(store);
  for (const pr of [1,2,3,4]) {
    store.admit({ ...event, deliveryId: `p${pr}`, identity: { ...event.identity, pullNumber: pr } });
    store.observePullState('200', pr, pr === 1 ? 'open' : 'closed', 0);
  }
  store.observePullState('200', 4, 'open', day * 29);
  const retention = createRetention({ store });
  expect(await retention.purgeExpired(29 * day)).toEqual({ purged: 0 });
  expect(await retention.purgeExpired(30 * day)).toEqual({ purged: 2 });
  expect(store.current('200', 1)).not.toBeNull();
  expect(store.current('200', 4)).not.toBeNull();
  expect(store.current('200', 2)).toBeNull();
  expect(store.receipt('p2')).toBeNull();
  expect(await retention.purgeExpired(60 * day)).toEqual({ purged: 0 });
});
it('retains useful findings when an incomplete same-pass retry later returns empty', () => {
  const store = openStore(':memory:'); stores.push(store);
  const identity = store.admit(event).identity, claim = store.claim(1000)!;
  const owner = { token: claim.lease.token, now: 1001 };
  store.savePass(identity, spec, { ...outcome, status: 'incomplete', failureCode: 'provider_failure' }, owner);
  store.savePass(identity, spec, { ...outcome, status: 'failed', failureCode: 'provider_failure', findings: [] }, owner);
  expect(store.current('200', 42)?.passes[0]?.outcome.findings).toEqual(outcome.findings);
});

it('backs up a live WAL database and keeps exactly seven daily snapshots', async () => {
  const { mkdtemp, readdir, rm, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { createBackups } = await import('../src/retention.js');
  const root = await mkdtemp(join(tmpdir(),'backups-'));
  const store = openStore(join(root,'live.sqlite'));
  try {
    store.admit(event);
    const directory = join(root,'snapshots'), backups = await createBackups(store,directory);
    for (let day=0;day<9;day++) await backups.daily(day*86400000);
    const names = await readdir(directory);expect(names).toHaveLength(7);expect(names).not.toContain('daily-1.sqlite');
    const restored=openStore(join(directory,'daily-8.sqlite'));
    try { expect(restored.current('200',42)?.identity.headSha).toBe(event.identity.headSha); } finally { restored.close(); }
    await expect(backups.backup(join(root,'escape.sqlite'))).rejects.toThrow('unsafe_backup_destination');
    await expect(backups.backup(join(directory,'daily-8.sqlite'))).rejects.toThrow('backup_exists');
    if(process.platform!=='win32') expect((await stat(directory)).mode&0o777).toBe(0o700);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
it('surfaces storage purge failures instead of reporting successful cleanup', async()=>{
  const store=openStore(':memory:');store.close();
  await expect(createRetention({store}).purgeExpired(60*day)).rejects.toThrow();
});
