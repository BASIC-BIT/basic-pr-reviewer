import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chmod, statfs, rm } from 'node:fs/promises';
import { z } from 'zod';
import { createAdmissionService, RECONCILIATION_INTERVAL_MS } from './events.js';
import { createScheduler } from './scheduler.js';
import type { SchedulerOptions } from './scheduler.js';
import { createPublisher } from './publisher.js';
import { createRetention } from './retention.js';
import { loadPolicy, ConfigurationError } from './policy.js';
import { GitHubAccessError } from './github.js';
import type { GitHubPort } from './github.js';
import type { Store, LivePull } from './contracts.js';

export type ServiceComponents = {
  store: Store; github: GitHubPort; source: SchedulerOptions['source']; worker: SchedulerOptions['worker'];
  webhookSecret: string; appId: string; ownerIds: string[]; engineRevision: string;
  backup: (destination: string) => Promise<void>;
  dailyBackup: (now: number) => Promise<void>;
};
export type ServiceConfig = {
  stateDirectory: string; controlSocket: string; port: number;
  acquireOwnership: () => Promise<() => Promise<void>>;
  pause: { read: () => Promise<boolean>; write: (paused: boolean) => Promise<void> };
  open: () => Promise<ServiceComponents>;
  heartbeat: (health: ServiceHealth) => Promise<void>;
  now?: () => number; tickMs?: number; minimumFreeBytes?: number;
};
export type ServiceHealth = { healthy: boolean; database: boolean; scheduler: boolean; paused: boolean;
  freeBytes: number; workerFailures: number; publicationFailures: number; recoveryRequired: boolean;
  lastCycleAt: number; reason: string | null };
const commandSchema = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('inspect'), repositoryId: z.string().regex(/^[1-9][0-9]*$/), pullNumber: z.number().int().positive() }),
  z.strictObject({ command: z.enum(['reconcile', 'pause', 'resume']) }),
  z.strictObject({ command: z.literal('backup'), destination: z.string().min(1) }),
]);
export type OperatorCommand = z.infer<typeof commandSchema>;
export type RunningService = Awaited<ReturnType<typeof startService>>;
async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > limit) throw new Error('request_limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function respond(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
export async function startService(config: ServiceConfig) {
  const release = await config.acquireOwnership();
  let components: ServiceComponents | undefined;
  const now = config.now ?? Date.now;
  let stopping = false, paused = false, timer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined, heartbeatWork: Promise<void> | null = null;
  let pauseChange: Promise<void> = Promise.resolve();
  let activeCycle: Promise<void> | null = null, lastCycleAt = now(), lastReconcile = now(), lastPurge = 0;
  let pauseFailure = false;
  let reason: string | null = null, publicationFailures = 0, freeBytes = 0;
  const requests = new Set<Promise<void>>();
  const webhook = createServer(), control = createServer();
  try {
    paused = await config.pause.read();
    components = await config.open();
    const { store, github, source, worker, backup, dailyBackup } = components;
    const owners = new Set(components.ownerIds);
    async function trusted(pull: LivePull) {
      const installation = await github.assertInstallation(pull.installationId);
      if (!owners.has(installation.ownerId) || !owners.has(pull.ownerId)) throw new GitHubAccessError(pull.installationId, pull.repositoryId);
      if (await github.readDefaultBranch(pull.installationId, pull.repositoryId) !== pull.baseRef) throw new ConfigurationError('Untrusted base branch');
      return loadPolicy(github, pull);
    }
    const admission = createAdmissionService({ store, github, webhookSecret: components.webhookSecret,
      appId: components.appId, ownerIds: components.ownerIds, runtimeHash: worker.runtimeHash, now });
    const scheduler = createScheduler({ store, source, worker, now,
      readCurrent: async (identity, signal) => {
        signal.throwIfAborted();
        const pull = await github.readLivePull(identity.installationId, identity.repositoryId, identity.pullNumber);
        const policy = await trusted(pull); signal.throwIfAborted();
        return { pull, trusted: policy };
      } });
    const publisher = createPublisher({ store, github, readPolicy: trusted, engineRevision: components.engineRevision,
      operatorCommand: 'reviewer inspect', notify: notice => { publicationFailures++; reason = notice.reason; } });
    const retention = createRetention({ store });
    async function health(): Promise<ServiceHealth> {
      let database = true, workerFailures = 0, pending = 0;
      try { const counts = store.health(); workerFailures = counts.workerFailures; pending = counts.publicationFailures; }
      catch { database = false; }
      try { const disk = await statfs(config.stateDirectory); freeBytes = disk.bavail * disk.bsize; }
      catch { freeBytes = 0; }
      const healthy = database && workerFailures === 0 && pending === 0 && publicationFailures === 0 && !pauseFailure && !scheduler.recoveryRequired && freeBytes >= (config.minimumFreeBytes ?? 512 * 1024 * 1024) && reason === null &&
        (activeCycle !== null || now() - lastCycleAt < Math.max(120000, (config.tickMs ?? 5000) * 3));
      return { healthy, database, scheduler: !stopping && !scheduler.recoveryRequired, paused, freeBytes,
        workerFailures, publicationFailures: Math.max(publicationFailures, pending), recoveryRequired: scheduler.recoveryRequired, lastCycleAt, reason: pauseFailure ? 'pause_state_failed' : reason };
    }
    async function beat(): Promise<void> {
      if (!heartbeatWork) heartbeatWork = health().then(config.heartbeat).catch(() => { reason = 'heartbeat_failed'; }).finally(() => { heartbeatWork = null; });
      await heartbeatWork;
    }
    async function dispatch(): Promise<void> {
      for (const installation of store.trackedInstallations()) for (const pull of store.trackedPulls(installation)) {
        for (const record of store.publications(pull.repositoryId, pull.pullNumber)) {
          if (paused || stopping) return;
          if (record.state === 'planned') await publisher.reconcilePublication(record);
        }
      }
      for (const notice of store.publicationNotices()) {
        if (paused || stopping) return;
        if (store.publicationFenceCurrent({ kind: 'notice', noticeId: notice.id })) await publisher.reconcileNotice(notice);
      }
    }
    // Ownership precedes all cleanup, and live reconciliation precedes any publication.
    await scheduler.recoverWorker();
    store.interruptLeases(now()); scheduler.recoverExpiredLeases(now());
    await retention.purgeExpired(now());
    await admission.reconcileInstalled();
    async function cycle(): Promise<void> {
      if (stopping || activeCycle) return activeCycle ?? Promise.resolve();
      const work = async () => {
        try {
          reason = null; publicationFailures = 0;
          const status = await health();
          if (!status.database || status.freeBytes < (config.minimumFreeBytes ?? 512 * 1024 * 1024)) throw new Error('storage_unavailable');
          if (now() - lastPurge >= 86400000) { await retention.purgeExpired(now()); await dailyBackup(now()); lastPurge = now(); }
          if (now() - lastReconcile >= RECONCILIATION_INTERVAL_MS) { await admission.reconcileInstalled(); lastReconcile = now(); }
          if (scheduler.recoveryRequired) await scheduler.recoverWorker();
          if (!paused && !stopping) await scheduler.tick(now());
          if (!paused && !stopping) await dispatch();
        } catch { reason ??= 'service_cycle_failed'; }
        finally {
          lastCycleAt = now();
          await beat();
        }
      };
      activeCycle = work();
      try { await activeCycle; } finally { activeCycle = null; }
    }
    function changePause(value: boolean): Promise<void> {
      const work = pauseChange.then(async () => {
        if (value) paused = true;
        try { await config.pause.write(value); }
        catch (error) { paused = true; pauseFailure = true; if (activeCycle) await activeCycle; throw error; }
        if (value && activeCycle) await activeCycle;
        paused = value; pauseFailure = false;
      });
      pauseChange = work.catch(() => {});
      return work;
    }
    async function command(input: unknown): Promise<unknown> {
      const parsed = commandSchema.parse(input);
      if (stopping) throw new Error('service_stopping');
      switch (parsed.command) {
        case 'inspect': return { observation: store.observation(parsed.repositoryId, parsed.pullNumber),
          current: store.current(parsed.repositoryId, parsed.pullNumber), notices: store.publicationNotices(parsed.repositoryId, parsed.pullNumber),
          operations: store.publicationOperations(parsed.repositoryId, parsed.pullNumber) };
        case 'pause': await changePause(true); return { paused, drained: true };
        case 'resume': await changePause(false); return { paused };
        case 'reconcile': await admission.reconcileInstalled(); return { reconciled: true };
        case 'backup': await backup(parsed.destination); return { backedUp: true };
      }
    }
    function track(action: () => Promise<void>): void {
      const promise = action(); requests.add(promise);
      void promise.finally(() => requests.delete(promise)).catch(() => {});
    }
    webhook.on('request', (request, response) => track(async () => {
      try {
        if (request.method === 'GET' && request.url === '/health') {
          const status = await health(); return respond(response, status.healthy ? 200 : 503, status);
        }
        if (request.method !== 'POST' || request.url !== '/webhook') return respond(response, 404, { error: 'not_found' });
        if (stopping || scheduler.recoveryRequired || !(await health()).database) return respond(response, 503, { error: 'unavailable' });
        const bytes = await body(request, 30 * 1024 * 1024);
        const headers: Record<string, string | undefined> = {};
        for (const key of ['x-hub-signature-256', 'x-github-delivery', 'x-github-event']) {
          const value = request.headers[key]; if (typeof value === 'string') headers[key] = value;
        }
        const result = await admission.admitWebhook(headers, bytes);
        respond(response, 202, result);
      } catch { respond(response, 503, { error: 'admission_failed' }); }
    }));
    control.on('request', (request, response) => track(async () => {
      try {
        if (request.method !== 'POST' || request.url !== '/control') return respond(response, 404, { error: 'not_found' });
        const value: unknown = JSON.parse((await body(request, 16384)).toString('utf8'));
        respond(response, 200, await command(value));
      } catch { respond(response, 503, { error: 'command_failed' }); }
    }));
    for (const server of [webhook, control]) { server.requestTimeout = 30000; server.headersTimeout = 10000; }
    if (process.platform !== 'win32') await rm(config.controlSocket, { force: true });
    await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(config.controlSocket, () => { control.off('error', reject); resolve(); }); });
    if (process.platform !== 'win32') await chmod(config.controlSocket, 0o600);
    await new Promise<void>((resolve, reject) => { webhook.once('error', reject); webhook.listen(config.port, '127.0.0.1', () => { webhook.off('error', reject); resolve(); }); });
    function schedule() { if (!stopping) { timer = setTimeout(() => { void cycle().finally(schedule); }, config.tickMs ?? 5000); timer.unref(); } }
    schedule();
    heartbeatTimer = setInterval(() => { if (!stopping) void beat(); }, 30000);
    heartbeatTimer.unref();
    await beat();
    return { webhookAddress: webhook.address(), health, command, cycle,
      async stop(): Promise<void> {
        if (stopping) return;
        stopping = true; if (timer) clearTimeout(timer); if (heartbeatTimer) clearInterval(heartbeatTimer); scheduler.stop();
        const closed = [webhook, control].map(server => new Promise<void>(resolve => server.close(() => resolve())));
        for (const server of [webhook, control]) server.closeIdleConnections();
        await Promise.allSettled([...(heartbeatWork ? [heartbeatWork] : []), ...requests, ...(activeCycle ? [activeCycle] : [])]);
        await Promise.all(closed);
        try { await scheduler.recoverWorker(); }
        finally { store.close(); await release(); }
      } };
  } catch (error) {
    if (timer) clearTimeout(timer); if (heartbeatTimer) clearInterval(heartbeatTimer);
    webhook.close(); control.close();
    components?.store.close(); await release();
    throw error;
  }
}
