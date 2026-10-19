#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { mkdir, readFile, realpath, lstat, stat, writeFile, rename, rm, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { openStore } from './store.js';
import { createGitHubAdapter } from './github.js';
import { createSourceService } from './source.js';
import { createWorker, profile } from './worker.js';
import { verifyRelease } from './release.js';
import { createBackups } from './retention.js';
import { startService } from './main.js';
import type { OperatorCommand, ServiceHealth } from './main.js';

const reference = z.strictObject({ secretId: z.string().min(1), jsonKey: z.string().min(1).optional() });
export const runtimeConfigSchema = z.strictObject({
  stateDirectory: z.string().min(1), backupDirectory: z.string().min(1), releaseManifest: z.string().min(1),
  region: z.string().min(1), appId: z.string().regex(/^[1-9][0-9]*$/), ownerIds: z.array(z.string().regex(/^[1-9][0-9]*$/)).min(1),
  privateKey: reference, webhookSecret: reference, oauthToken: reference,
  port: z.number().int().min(1).max(65535).default(8787), initiallyPaused: z.boolean().default(true),
});
export class CredentialFailure extends Error {
  constructor(readonly credentialFailure: 'configuration' | 'temporary') { super(`credential_${credentialFailure}_failure`); }
}
export async function loadSecret(client: Pick<SecretsManagerClient, 'send'>, input: z.infer<typeof reference>): Promise<string> {
  const ref = reference.parse(input);
  try {
    const result = await client.send(new GetSecretValueCommand({ SecretId: ref.secretId, VersionStage: 'AWSCURRENT' }));
    const text = z.string().min(1).max(1024 * 1024).parse(result.SecretString);
    if (!ref.jsonKey) return text;
    return z.string().min(1).parse(z.record(z.string(), z.unknown()).parse(JSON.parse(text))[ref.jsonKey]);
  } catch (error) {
    const meta = z.object({ name: z.string(), $metadata: z.object({ httpStatusCode: z.number().optional() }).optional() }).safeParse(error);
    const permanent = !meta.success || ['AccessDeniedException', 'ResourceNotFoundException', 'InvalidRequestException', 'InvalidParameterException',
      'DecryptionFailure', 'CredentialsProviderError', 'ZodError', 'SyntaxError', 'UnrecognizedClientException'].includes(meta.data.name) ||
      meta.data.$metadata?.httpStatusCode === 403 || meta.data.$metadata?.httpStatusCode === 401;
    throw new CredentialFailure(permanent ? 'configuration' : 'temporary');
  }
}
export async function assertFlock(path: string): Promise<void> {
  if (process.platform !== 'linux') throw new Error('linux_supervisor_required');
  const info = await stat(path, { bigint: true });
  if ((await lstat(path)).isSymbolicLink()) throw new Error('unsafe_lock');
  const major = ((info.dev >> 8n) & 0xfffn) | ((info.dev >> 32n) & 0xfffff000n);
  const minor = (info.dev & 0xffn) | ((info.dev >> 12n) & 0xffffff00n);
  const locks = await readFile('/proc/locks', 'utf8');
  const held = locks.split('\n').some(line => {
    const parts = line.trim().split(/\s+/);
    if (parts[1] !== 'FLOCK' || parts[3] !== 'WRITE' || parts[4] !== String(process.pid)) return false;
    const device = parts[5]?.split(':');
    return device?.length === 3 && BigInt(`0x${device[0]}`) === major && BigInt(`0x${device[1]}`) === minor && device[2] === String(info.ino);
  });
  if (!held) throw new Error('exclusive_flock_required');
}
export async function controlRequest(socketPath: string, command: OperatorCommand): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/control', method: 'POST', timeout: command.command === 'pause' ? profile.timeoutMs + 15 * 60 * 1000 : 120000, headers: { 'content-type': 'application/json' } }, response => {
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 16 * 1024 * 1024) req.destroy(new Error('control_response_limit')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => {
        try { if (response.statusCode !== 200) throw new Error('operator_command_failed'); resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('control_timeout'))); req.end(JSON.stringify(command));
  });
}
export function createPauseState(directory: string, initiallyPaused: boolean) {
  const path = join(directory, 'pause.json');
  async function write(paused: boolean): Promise<void> {
    const temporary = join(directory, `pause-${randomUUID()}.pending`);
    try {
      await writeFile(temporary, JSON.stringify(paused) + '\n', { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, path);
      if (process.platform === 'linux') { const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
    } finally { await rm(temporary, { force: true }); }
  }
  async function read(): Promise<boolean> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 || process.platform === 'linux' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new Error('unsafe_pause_state');
      return z.boolean().parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      await write(initiallyPaused); return initiallyPaused;
    }
  }
  return { read, write };
}
export async function runCli(args: string[]): Promise<void> {
  const config = runtimeConfigSchema.parse(JSON.parse(await readFile(process.env.REVIEWER_CONFIG ?? '/etc/basic-pr-reviewer/config.json', 'utf8')));
  const root = resolve(config.stateDirectory), socketPath = join(root, 'control.sock');
  if (args[0] !== 'serve') {
    let command: OperatorCommand;
    if (args[0] === 'inspect' && args.length === 3) command = { command: 'inspect', repositoryId: args[1] ?? '', pullNumber: Number(args[2]) };
    else if (args[0] === 'backup' && args.length === 2) command = { command: 'backup', destination: args[1] ?? '' };
    else if (args.length === 1 && (args[0] === 'pause' || args[0] === 'resume' || args[0] === 'reconcile')) command = { command: args[0] };
    else throw new Error('usage: reviewer serve|inspect ID PR|reconcile|pause|resume|backup PATH');
    process.stdout.write(JSON.stringify(await controlRequest(socketPath, command), null, 2) + '\n'); return;
  }
  if (process.platform !== 'linux' || process.getuid?.() !== 1000) throw new Error('linux_uid1000_required');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || await realpath(root) !== root || (rootInfo.mode & 0o077) !== 0 || rootInfo.uid !== 1000) throw new Error('unsafe_state_directory');
  process.umask(0o077);
  const lockPath = join(root, 'service.lock');
  if (args.length === 1) {
    const exit = await new Promise<number>((resolveExit, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '--no-fork', lockPath, process.execPath, fileURLToPath(import.meta.url), 'serve', '--locked'], { stdio: 'inherit' });
      const forward = () => child.kill('SIGTERM'); process.once('SIGTERM', forward); process.once('SIGINT', forward);
      child.once('error', reject); child.once('exit', code => { process.off('SIGTERM', forward); process.off('SIGINT', forward); resolveExit(code ?? 1); });
    });
    process.exitCode = exit; return;
  }
  if (args.length !== 2 || args[1] !== '--locked') throw new Error('invalid_serve_arguments');
  const client = new SecretsManagerClient({ region: config.region, maxAttempts: 3, requestHandler: { requestTimeout: 15000, connectionTimeout: 5000 } });
  const engineRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const heartbeat = async (health: ServiceHealth) => {
    const path = join(root, 'heartbeat.json'), temporary = join(root, 'heartbeat.pending');
    await writeFile(temporary, JSON.stringify({ ...health, observedAt: Date.now() }) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  };
  try {
    const service = await startService({ stateDirectory: root, controlSocket: socketPath, port: config.port, heartbeat, pause: createPauseState(root, config.initiallyPaused),
      acquireOwnership: async () => { await assertFlock(lockPath); return async () => {}; },
      open: async () => {
        const release = await verifyRelease(engineRoot, resolve(config.releaseManifest));
        const privateKey = await loadSecret(client, config.privateKey), webhookSecret = await loadSecret(client, config.webhookSecret);
        const store = openStore(join(root, 'ledger.sqlite'));
        try {
          const github = createGitHubAdapter({ appId: config.appId, privateKey, ownerIds: config.ownerIds });
          const workerRoot = join(root, 'workers'); await mkdir(workerRoot, { recursive: true, mode: 0o700 });
          const worker = await createWorker({ release, workerImage: release.workerImage, proxyImage: release.proxyImage, temporaryRoot: workerRoot,
            oauthToken: () => loadSecret(client, config.oauthToken) });
          await worker.reap();
          const source = await createSourceService({ root: join(root, 'source'), credential: id => github.installationCredential(id) });
          const backups = await createBackups(store, resolve(config.backupDirectory));
          return { store, github, source, worker, webhookSecret, appId: config.appId, ownerIds: config.ownerIds,
            engineRevision: release.coreRevision, backup: backups.backup, dailyBackup: backups.daily };
        } catch (error) { store.close(); throw error; }
      } });
    const stop = () => { void service.stop().catch(() => { process.exitCode = 1; }).finally(() => client.destroy()); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch (error) { client.destroy(); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCli(process.argv.slice(2)); }
  catch { process.stderr.write('Reviewer command failed. Check the private service health and configuration.\n'); process.exitCode = 1; }
}
