import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { z } from 'zod';
import { bundleSchema, manifestSchema, repoPolicySchema, reviewIdentitySchema } from './contracts.js';
import type { Bundle, Manifest, PathIdentity, ReviewIdentity, ReviewUnit, TrustedPolicy } from './contracts.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const objectId = (type: string, bytes: Buffer) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
const zero = '0'.repeat(40), emptyBlob = objectId('blob', Buffer.alloc(0));
const limitsSchema = z.strictObject({
  maxBlobBytes: z.number().int().positive().default(16 * 1024 * 1024),
  maxCaptureBytes: z.number().int().positive().default(128 * 1024 * 1024),
  maxBundleBytes: z.number().int().positive().default(128 * 1024 * 1024),
  maxGitOutputBytes: z.number().int().positive().default(64 * 1024 * 1024),
  maxDiskBytes: z.number().int().positive().default(1024 * 1024 * 1024),
  gitTimeoutMs: z.number().int().positive().default(5 * 60 * 1000),
});
type FetchInput = { directory: string; identity: ReviewIdentity; signal?: AbortSignal };
type SourceOptions = {
  root: string; limits?: z.input<typeof limitsSchema>;
  // Host-only seams. Credentials and object stores never enter a worker bundle.
  fetch?: (input: FetchInput) => Promise<void>;
  credential?: (identity: ReviewIdentity) => Promise<string>;
};
type Snapshot = { manifest: Manifest; policy: TrustedPolicy; blobs: Map<string, Buffer>;
  patches: Map<string, Buffer>; context: { path: PathIdentity; blob: string; mode: string }[] };
class SourceError extends Error { constructor(readonly code: string) { super(code); } }
function utf8(bytes: Buffer): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}
const pathIdentity = (bytes: Buffer): PathIdentity => ({ bytesBase64: bytes.toString('base64') });
const pathText = (path: PathIdentity) => utf8(Buffer.from(path.bytesBase64, 'base64'));
function matches(path: PathIdentity, globs: string[]): boolean {
  const text = pathText(path);
  return text !== null && globs.some((glob) => posix.matchesGlob(text, glob));
}
const excluded = (path: PathIdentity, globs: string[]) => globs.length > 0 && (pathText(path) === null || matches(path, globs));
function quarantine(path: PathIdentity): boolean {
  const text = pathText(path);
  return text === null || text.split('/').some((part) => /^(?:AGENTS\.md|CLAUDE\.md|\.claude(?:-review)?|\.mcp.*|mcp\.json)$/i.test(part));
}
function fields(bytes: Buffer): Buffer[] {
  const result: Buffer[] = []; let start = 0;
  for (let index = 0; index < bytes.length; index++) if (bytes[index] === 0) { result.push(bytes.subarray(start, index)); start = index + 1; }
  if (start !== bytes.length) throw new SourceError('invalid_git_output');
  return result;
}
function rawChanges(bytes: Buffer): Manifest['sourceMap'] {
  const parts = fields(bytes), result: Manifest['sourceMap'] = [];
  for (let index = 0; index < parts.length;) {
    const header = parts[index++]?.toString('ascii').match(/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([ADMT]|R100)$/);
    const first = parts[index++];
    if (!header || !first?.length) throw new SourceError('invalid_git_output');
    const [, oldMode, newMode, old, next, status] = header;
    if (!oldMode || !newMode || !old || !next) throw new SourceError('invalid_git_output');
    const second = status === 'R100' ? parts[index++] : first;
    if (!second?.length) throw new SourceError('invalid_git_output');
    const path = pathIdentity(second), oldPath = status === 'R100' ? pathIdentity(first) : null;
    const mapping = { path, oldPath, oldBlobId: old === zero ? null : old, newBlobId: next === zero ? null : next, oldMode, newMode };
    result.push({ ...mapping, id: hash(JSON.stringify(mapping)), disposition: 'review' });
  }
  return result;
}
function patchPieces(patch: Buffer) {
  const hunks = patch.toString('utf8').split(/(?=^@@ )/m), pieces: { bytes: Buffer; oldLines: ReviewUnit['oldLines']; newLines: ReviewUnit['newLines'] }[] = [];
  let preamble = hunks.shift() ?? '';
  if (!hunks.length) { hunks.push(preamble); preamble = ''; }
  for (const hunk of hunks) {
    const range = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n/.exec(hunk);
    const oldLines = { start: Number(range?.[1] ?? 0), count: Number(range ? range[2] ?? 1 : 0) };
    const newLines = { start: Number(range?.[3] ?? 0), count: Number(range ? range[4] ?? 1 : 0) };
    if (Buffer.byteLength(preamble + hunk) <= 128 * 1024 || !range) {
      pieces.push({ bytes: Buffer.from(preamble + hunk), oldLines, newLines }); continue;
    }
    const rows: { bytes: Buffer; old: number; next: number; oldCount: number; newCount: number }[] = [];
    let old = oldLines.start, next = newLines.start;
    for (const line of hunk.slice(range[0].length).match(/[^\n]*\n|[^\n]+$/g) ?? []) {
      const oldCount = line[0] === '-' || line[0] === ' ' ? 1 : 0, newCount = line[0] === '+' || line[0] === ' ' ? 1 : 0;
      const bytes = Buffer.from(line);
      for (let offset = 0; offset < bytes.length;) {
        let end = Math.min(offset + 32 * 1024, bytes.length);
        while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
        const fragment = bytes.subarray(offset, end);
        rows.push({ bytes: bytes.length <= 32 * 1024 ? fragment : Buffer.concat([
          Buffer.from(`[source line fragment ${offset}:${end} of ${bytes.length} bytes]\n`), fragment, Buffer.from('\n'),
        ]), old, next, oldCount, newCount });
        offset = end;
      }
      old += oldCount; next += newCount;
    }
    for (let start = 0; start < rows.length;) {
      let end = start, size = 0;
      while (end < rows.length && size + (rows[end]?.bytes.length ?? 0) <= 104 * 1024) size += rows[end++]?.bytes.length ?? 0;
      let before = start, after = end, contextBytes = 0;
      while (before > 0 && start - before < 3 && contextBytes + (rows[before - 1]?.bytes.length ?? 0) <= 8 * 1024) contextBytes += rows[--before]?.bytes.length ?? 0;
      contextBytes = 0;
      while (after < rows.length && after - end < 3 && contextBytes + (rows[after]?.bytes.length ?? 0) <= 8 * 1024) contextBytes += rows[after++]?.bytes.length ?? 0;
      const slice = rows.slice(before, after), first = slice[0];
      if (!first || end === start) throw new SourceError('invalid_diff_chunk');
      const oldRange = { start: first.old, count: Math.max(...slice.map((row) => row.old + row.oldCount)) - first.old };
      const newRange = { start: first.next, count: Math.max(...slice.map((row) => row.next + row.newCount)) - first.next };
      pieces.push({ bytes: Buffer.concat([Buffer.from(`${preamble}@@ -${oldRange.start},${oldRange.count} +${newRange.start},${newRange.count} @@\n`), ...slice.map((row) => row.bytes)]), oldLines: oldRange, newLines: newRange });
      start = end;
    }
  }
  return pieces;
}

export async function createSourceService(options: SourceOptions) {
  const limits = limitsSchema.parse(options.limits ?? {});
  await mkdir(options.root, { recursive: true, mode: 0o700 });
  if ((await lstat(options.root)).isSymbolicLink()) throw new Error('Unsafe source root');
  const root = await realpath(options.root), snapshots = new Map<string, Snapshot>();
  const owned = (directory: string) => dirname(resolve(directory)) === root && /^(capture|bundle)-[A-Za-z0-9]+$/.test(resolve(directory).slice(root.length + 1));
  async function destroyWorkspace(directory: string): Promise<void> {
    if (!owned(directory)) throw new Error('Not a service workspace');
    snapshots.delete(directory);
    async function writable(path: string): Promise<void> {
      const stat = await lstat(path).catch(() => null);
      if (!stat || stat.isSymbolicLink()) return;
      await chmod(path, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) for (const entry of await readdir(path)) await writable(join(path, entry));
    }
    await writable(directory);
    await rm(directory, { recursive: true, force: true });
  }
  // Construct once at startup with a dedicated root, before starting attempts.
  for (const entry of await readdir(root)) if (owned(join(root, entry))) await destroyWorkspace(join(root, entry));
  async function diskBytes(path: string): Promise<number> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new SourceError('unsafe_workspace');
    if (!stat.isDirectory()) return stat.size;
    let bytes = 0;
    for (const entry of await readdir(path)) bytes += await diskBytes(join(path, entry));
    return bytes;
  }
  async function git(directory: string, args: string[], input?: Buffer, signal?: AbortSignal, extraEnv: NodeJS.ProcessEnv = {}): Promise<Buffer> {
    signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'SystemDrive']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', ...extraEnv });
    return new Promise((accept, reject) => {
      const child = spawn('git', ['--no-replace-objects', '-c', `core.hooksPath=${join(dirname(directory), 'disabled-hooks')}`, '-c', 'core.attributesFile=',
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'credential.helper=',
        '-c', 'core.fsmonitor=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', '--git-dir', directory, ...args],
        { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      const chunks: Buffer[] = []; let size = 0, failure: SourceError | null = null, checking = false;
      let terminating: Promise<void> | null = null;
      const stop = (code: string) => {
        if (failure) return;
        failure = new SourceError(code);
        if (!child.pid) return;
        if (process.platform === 'win32') {
          terminating = new Promise((done) => {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { child.kill(); done(); }); killer.on('close', () => done());
          });
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
      };
      const aborted = () => stop('cancelled');
      signal?.addEventListener('abort', aborted, { once: true });
      const timer = setTimeout(() => stop('git_timeout'), limits.gitTimeoutMs);
      const disk = setInterval(() => {
        if (checking) return;
        checking = true;
        void diskBytes(dirname(directory)).then((bytes) => { if (bytes > limits.maxDiskBytes) stop('disk_limit'); })
          .catch(() => stop('workspace_failure')).finally(() => { checking = false; });
      }, 1000);
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > limits.maxGitOutputBytes) stop('git_output_limit'); else chunks.push(chunk); });
      child.stderr.resume(); // Remote/helper diagnostics may contain credentials.
      child.stdin.on('error', () => {});
      child.on('error', () => { failure ??= new SourceError('git_unavailable'); });
      child.on('close', async (code) => {
        clearTimeout(timer); clearInterval(disk); signal?.removeEventListener('abort', aborted);
        await terminating;
        if (failure || code !== 0) reject(failure ?? new SourceError('git_failure')); else accept(Buffer.concat(chunks));
      });
      child.stdin.end(input);
    });
  }
  async function fetchObjects(input: FetchInput): Promise<void> {
    if (options.fetch) return options.fetch(input);
    const { directory, identity, signal } = input;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(identity.owner) || !/^[A-Za-z0-9_.-]+$/.test(identity.repo)) throw new SourceError('invalid_repository');
    if (!options.credential) throw new SourceError('credential_unavailable');
    const token = await options.credential(identity);
    if (!token || /[\r\n\0]/.test(token)) throw new SourceError('credential_invalid');
    const helper = join(dirname(directory), 'credential.cjs');
    await writeFile(helper, `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 8192) process.exit(1); });
process.stdin.on('end', () => {
  const fields = Object.fromEntries(input.trim().split('\\n').map(line => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
  if (process.argv[2] === 'get' && fields.protocol === 'https' && fields.host === 'github.com' &&
      fields.path === ${JSON.stringify(`${identity.owner}/${identity.repo}.git`)}) {
    process.stdout.write('username=x-access-token\\npassword=' + process.env.REVIEWER_GIT_TOKEN + '\\n');
  }
});
`, { mode: 0o600, flag: 'wx' });
    // Git starts its helper. Only trusted executable/script paths enter this fixed command.
    const quote = (path: string) => `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`;
    try {
      await git(directory, ['-c', `credential.helper=!${quote(process.execPath)} ${quote(helper)}`, '-c', 'credential.useHttpPath=true', '-c', 'http.followRedirects=false',
        '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-recurse-submodules',
        '--', `https://github.com/${identity.owner}/${identity.repo}.git`, identity.baseSha, identity.headSha], undefined, signal, { REVIEWER_GIT_TOKEN: token });
    } finally { await rm(helper, { force: true }); }
  }

  async function captureManifest(input: ReviewIdentity, trusted: TrustedPolicy, signal?: AbortSignal): Promise<Manifest> {
    const identity = reviewIdentitySchema.parse(input), policy = repoPolicySchema.parse(trusted.policy);
    const instructions = trusted.instructions.map((item) => ({ path: item.path, hash: hash(item.text) }));
    if (instructions.some((item, index) => item.hash !== trusted.instructions[index]?.hash) ||
      hash(JSON.stringify({ policy, instructions })) !== identity.policyHash || trusted.policyHash !== identity.policyHash) throw new Error('Trusted policy identity mismatch');
    const workspace = await mkdtemp(join(root, 'capture-')), directory = join(workspace, 'objects.git');
    const manifest: Manifest = { identity, units: [], exclusions: [], retrievalFailures: [], sourceMap: [], workspace };
    const snapshot: Snapshot = { manifest, policy: { ...trusted, policy }, blobs: new Map(), patches: new Map(), context: [] };
    try {
      await git(directory, ['init', '--bare', '--template='], undefined, signal);
      await fetchObjects({ directory, identity, ...(signal ? { signal } : {}) });
      signal?.throwIfAborted();
      if (await diskBytes(workspace) > limits.maxDiskBytes) throw new SourceError('disk_limit');
      await git(directory, ['fsck', '--full', '--strict', '--no-reflogs'], undefined, signal);
      for (const id of new Set([identity.baseSha, identity.headSha, identity.mergeBaseSha])) {
        const commit = await git(directory, ['cat-file', 'commit', id], undefined, signal);
        if (objectId('commit', commit) !== id) throw new SourceError('object_hash_mismatch');
      }
      const mergeBases = (await git(directory, ['merge-base', '--all', identity.baseSha, identity.headSha], undefined, signal)).toString().trim().split('\n');
      if (mergeBases.length !== 1 || mergeBases[0] !== identity.mergeBaseSha) throw new SourceError('comparison_mismatch');
      manifest.sourceMap = rawChanges(await git(directory, ['diff', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv',
        '--find-renames=100%', identity.mergeBaseSha, identity.headSha, '--'], undefined, signal));
      const docGlobs = ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.txt', 'docs/**'];
      const docsOnly = policy.excludeDocsOnly && manifest.sourceMap.length > 0 && manifest.sourceMap.every((item) => matches(item.path, docGlobs) && (!item.oldPath || matches(item.oldPath, docGlobs)));
      for (const item of manifest.sourceMap) if (docsOnly || excluded(item.path, policy.excludeGlobs) || (item.oldPath && excluded(item.oldPath, policy.excludeGlobs))) {
        item.disposition = 'excluded'; manifest.exclusions.push({ path: item.path, code: docsOnly ? 'docs_only' : 'policy_exclusion' });
      }
      if (policy.contextMode === 'allowlist') {
        try {
          for (const entry of fields(await git(directory, ['ls-tree', '-rz', '--full-tree', identity.headSha], undefined, signal))) {
            const tab = entry.indexOf(9), metadata = entry.subarray(0, tab).toString('ascii').match(/^([0-7]{6}) blob ([0-9a-f]{40})$/);
            const path = pathIdentity(entry.subarray(tab + 1));
            if (metadata?.[1] && metadata[2] && matches(path, policy.contextAllowGlobs) && !excluded(path, policy.excludeGlobs)) snapshot.context.push({ path, blob: metadata[2], mode: metadata[1] });
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          snapshot.context = [];
          manifest.retrievalFailures.push({ path: null, code: error instanceof SourceError ? `context_${error.code}` : 'context_retrieval_failed' });
        }
      }
      const ids = new Set<string>();
      for (const item of manifest.sourceMap.filter((item) => item.disposition === 'review')) {
        if (item.oldBlobId && item.oldMode !== '160000') ids.add(item.oldBlobId);
        if (item.newBlobId && item.newMode !== '160000') ids.add(item.newBlobId);
      }
      for (const item of snapshot.context) ids.add(item.blob);
      let captured = 0;
      const failed = new Map<string, string>();
      if (ids.size) {
        const rows = (await git(directory, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], Buffer.from([...ids].join('\n') + '\n'), signal)).toString().trim().split('\n');
        for (const row of rows) {
          const [id, type, count] = row.split(' ');
          if (!id || !ids.has(id)) throw new SourceError('invalid_git_output');
          const size = Number(count);
          if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) { failed.set(id, 'missing_blob'); continue; }
          if (size > limits.maxBlobBytes || captured + size > limits.maxCaptureBytes) { failed.set(id, 'capture_limit'); continue; }
          try {
            const bytes = await git(directory, ['cat-file', 'blob', id], undefined, signal);
            if (bytes.length !== size || objectId('blob', bytes) !== id) { failed.set(id, 'object_hash_mismatch'); continue; }
            snapshot.blobs.set(id, bytes); captured += bytes.length;
          } catch (error) { if (signal?.aborted) throw error; failed.set(id, error instanceof SourceError ? error.code : 'blob_retrieval_failed'); }
        }
      }
      await git(directory, ['hash-object', '-w', '--stdin'], Buffer.alloc(0), signal);
      const diffs = new Map<string, Buffer>();
      for (const item of manifest.sourceMap.filter((item) => item.disposition === 'review')) {
        signal?.throwIfAborted();
        const failure = failed.get(item.oldBlobId ?? '') ?? failed.get(item.newBlobId ?? '');
        if (failure) { item.disposition = 'retrieval_failure'; manifest.retrievalFailures.push({ path: item.path, code: failure }); continue; }
        const old = snapshot.blobs.get(item.oldBlobId ?? '') ?? Buffer.alloc(0), next = snapshot.blobs.get(item.newBlobId ?? '') ?? Buffer.alloc(0);
        let kind: ReviewUnit['kind'] = item.oldPath ? 'rename' : item.newBlobId === null ? 'delete' : 'text';
        if (item.oldMode === '160000' || item.newMode === '160000') kind = 'gitlink';
        else if (item.oldMode === '120000' || item.newMode === '120000') kind = 'symlink';
        else if (old.includes(0) || next.includes(0) || utf8(old) === null || utf8(next) === null) kind = 'binary';
        else if (item.oldBlobId === item.newBlobId && !item.oldPath) kind = 'mode';
        let patch: Buffer, pendingDiff: { key: string; bytes: Buffer } | null = null;
        if (kind === 'binary' || kind === 'gitlink') patch = Buffer.from(`${kind}: old=${item.oldBlobId ?? 'absent'} new=${item.newBlobId ?? 'absent'}\n`);
        else {
          const key = `${item.oldBlobId ?? emptyBlob}:${item.newBlobId ?? emptyBlob}`;
          let diff = diffs.get(key);
          if (!diff) {
            try {
              diff = await git(directory, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', item.oldBlobId ?? emptyBlob, item.newBlobId ?? emptyBlob, '--'], undefined, signal);
              pendingDiff = { key, bytes: diff };
            }
            catch (error) {
              if (signal?.aborted) throw error;
              item.disposition = 'retrieval_failure'; manifest.retrievalFailures.push({ path: item.path, code: error instanceof SourceError ? error.code : 'diff_retrieval_failed' }); continue;
            }
          }
          patch = diff.length ? diff : Buffer.from(`${kind}: ${item.oldMode} -> ${item.newMode}\n`);
        }
        const pieces = patchPieces(patch), generatedBytes = pieces.reduce((sum, piece) => sum + piece.bytes.length, 0);
        const retainedBytes = generatedBytes + (pendingDiff?.bytes.length ?? 0);
        if (captured + retainedBytes > limits.maxCaptureBytes) {
          item.disposition = 'retrieval_failure'; manifest.retrievalFailures.push({ path: item.path, code: 'capture_limit' }); continue;
        }
        captured += retainedBytes;
        if (pendingDiff) diffs.set(pendingDiff.key, pendingDiff.bytes);
        for (const [index, { bytes, oldLines, newLines }] of pieces.entries()) {
          const contentHash = hash(bytes);
          const unit = { sourceId: item.id, path: item.path, oldPath: item.oldPath, oldBlobId: item.oldBlobId, newBlobId: item.newBlobId,
            oldLines, newLines, kind, contentHash, groupId: hash(item.path.bytesBase64), diffBytes: bytes.length };
          const id = hash(JSON.stringify({ ...unit, index }));
          manifest.units.push({ ...unit, id }); snapshot.patches.set(id, bytes);
        }
      }
      for (const entry of snapshot.context) if (failed.has(entry.blob)) manifest.retrievalFailures.push({ path: entry.path, code: failed.get(entry.blob) ?? 'missing_blob' });
      snapshot.manifest = manifestSchema.parse(manifest); snapshots.set(workspace, snapshot); return manifest;
    } catch (error) {
      await destroyWorkspace(workspace);
      if (signal?.aborted) throw new SourceError('cancelled');
      manifest.units = []; manifest.retrievalFailures = [{ path: null, code: error instanceof SourceError ? error.code : 'retrieval_failed' }];
      for (const item of manifest.sourceMap) if (item.disposition === 'review') item.disposition = 'retrieval_failure';
      return manifest;
    }
  }

  async function materializeBundle(input: Manifest, unitIds: string[], signal?: AbortSignal): Promise<Bundle> {
    signal?.throwIfAborted();
    const manifest = manifestSchema.parse(input), snapshot = snapshots.get(manifest.workspace);
    if (!snapshot || JSON.stringify(manifest) !== JSON.stringify(snapshot.manifest)) throw new Error('Unknown or modified source manifest');
    const selected = new Set(unitIds);
    if (selected.size !== unitIds.length || unitIds.some((id) => !snapshot.patches.has(id))) throw new Error('Unknown or duplicate review unit');
    const directory = await mkdtemp(join(root, 'bundle-'));
    const sourceMap: Bundle['sourceMap'] = [], omissions = [...manifest.exclusions, ...manifest.retrievalFailures];
    let bytes = 0;
    try {
      await mkdir(join(directory, 'data')); await mkdir(join(directory, 'quarantine'));
      async function add(path: PathIdentity, side: 'old' | 'new' | 'diff', content: Buffer, ids: string[], key: string) {
        signal?.throwIfAborted();
        const alias = `${quarantine(path) ? 'quarantine' : 'data'}/${hash(key)}.${side}.txt`;
        const existing = sourceMap.find((item) => item.alias === alias);
        if (existing) { existing.unitIds = [...new Set([...existing.unitIds, ...ids])].sort(); return; }
        if (bytes + content.length > limits.maxBundleBytes) { omissions.push({ path, code: 'bundle_limit', unitIds: ids }); return; }
        await writeFile(join(directory, alias), content, { flag: 'wx', mode: 0o400 });
        sourceMap.push({ alias, path, side, unitIds: [...ids].sort(), contentHash: hash(content) }); bytes += content.length;
      }
      const units = manifest.units.filter((unit) => selected.has(unit.id));
      for (const unit of units) {
        const patch = snapshot.patches.get(unit.id);
        if (!patch) throw new Error('Missing captured unit');
        await add(unit.path, 'diff', patch, [unit.id], unit.id);
        if (unit.kind === 'binary' || unit.kind === 'gitlink') omissions.push({ path: unit.path, code: `${unit.kind}_content`, unitIds: [unit.id] });
      }
      if (snapshot.policy.policy.contextMode !== 'diff') {
        for (const mapping of manifest.sourceMap.filter((item) => units.some((unit) => unit.sourceId === item.id))) {
          const ids = units.filter((unit) => unit.sourceId === mapping.id).map((unit) => unit.id);
          for (const side of ['old', 'new'] satisfies ('old' | 'new')[]) {
            const blob = side === 'old' ? mapping.oldBlobId : mapping.newBlobId, mode = side === 'old' ? mapping.oldMode : mapping.newMode;
            const path = side === 'old' ? mapping.oldPath ?? mapping.path : mapping.path;
            if (!blob) continue;
            const content = snapshot.blobs.get(blob);
            if (mode === '160000') await add(path, side, Buffer.from(`gitlink ${blob}\n`), ids, `${path.bytesBase64}:${blob}`);
            else if (content && !content.includes(0) && utf8(content) !== null) await add(path, side, content, ids, `${path.bytesBase64}:${blob}`);
            else omissions.push({ path, code: 'binary_context' });
          }
        }
        for (const entry of snapshot.context) {
          const content = snapshot.blobs.get(entry.blob);
          if (content && !content.includes(0) && utf8(content) !== null) await add(entry.path, 'new', content, [], `${entry.path.bytesBase64}:${entry.blob}`);
          else if (content) omissions.push({ path: entry.path, code: 'binary_context' });
        }
      }
      sourceMap.sort((a, b) => a.alias.localeCompare(b.alias));
      const contextHash = hash(JSON.stringify({ policyHash: manifest.identity.policyHash, runtimeHash: manifest.identity.runtimeHash, files: sourceMap }));
      await chmod(join(directory, 'data'), 0o500); await chmod(join(directory, 'quarantine'), 0o500); await chmod(directory, 0o500);
      return bundleSchema.parse({ directory, contextHash, sourceMap, omissions, allowedReadScope: [directory] });
    } catch (error) { await destroyWorkspace(directory); throw error; }
  }
  return { captureManifest, materializeBundle, destroyWorkspace };
}
