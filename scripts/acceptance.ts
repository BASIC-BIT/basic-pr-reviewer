// Local synthetic acceptance only. This command never reads an OAuth credential.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { cliArguments, profile, workerRuntimeHash, sandboxArguments, validateOutcome, createWorker } from '../dist/worker.js';
import { passSpecSchema } from '../dist/contracts.js';
import { navigationAlias, renderNavigation, passContextHash } from '../dist/source.js';

assert.equal(process.argv[2], '--worker-profile');
const worker = process.argv[3], proxy = process.argv[4];
assert.match(worker ?? '', /^sha256:[a-f0-9]{64}$/); assert.match(proxy ?? '', /^sha256:[a-f0-9]{64}$/);
if (!worker || !proxy) throw new Error('Immutable worker and proxy image IDs are required');
const prefix = `reviewer-test-${randomUUID()}`, network = `${prefix}-internal`, egress = `${prefix}-egress`, proxyName = `${prefix}-proxy`;
const containers: string[] = [], networks: string[] = [];
const images: string[] = [];
const volumes: string[] = [];
const temporary = mkdtempSync(join(process.cwd(), 'worker-acceptance-'));
function docker(args: string[], input?: string) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 30000, maxBuffer: profile.maxOutputBytes,
    windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  assert.equal(result.status, 0, `Docker ${args[0]} failed; raw process output is withheld`);
  return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
}
const hardened = sandboxArguments();
let failed = false;
try {
  const workerId = docker(['image', 'inspect', worker, '--format', '{{.Id}}']);
  const proxyId = docker(['image', 'inspect', proxy, '--format', '{{.Id}}']);
  const sourceTag = `${prefix}-source-image`, volume = `${prefix}-source`;
  docker(['build', '-q', '--build-arg', `WORKER_IMAGE=${workerId}`, '-t', sourceTag, '-f', 'test/fixtures/source-worker.Dockerfile', 'test/fixtures']); images.push(sourceTag);
  docker(['volume', 'create', volume]); volumes.push(volume);
  docker(['run', '--rm', '--network', 'none', '--user', '0:0', '--mount', `type=volume,source=${volume},target=/handoff`,
    '--entrypoint', 'node', workerId, '-e', "require('fs').chownSync('/handoff',1000,1000)"]);
  docker(['run', '--rm', '--network', 'none', ...hardened, '--mount', `type=volume,source=${volume},target=/handoff`,
    '--mount', `type=bind,source=${process.cwd()},target=/repo,readonly`, sourceTag, '/repo/test/fixtures/linux-source.mjs']);
  const materialized = JSON.parse(docker(['run', '--rm', '--network', 'none', ...hardened,
    '--mount', `type=volume,source=${volume},target=/handoff,readonly`, '--entrypoint', 'cat', workerId, '/handoff/materialized.json']));
  docker(['run', '--rm', '--network', 'none', ...hardened,
    '--mount', `type=volume,source=${volume},target=/bundle,volume-subpath=${materialized.subpath},readonly`, '--entrypoint', 'node', workerId, '-e',
    `const fs=require('fs'),assert=require('assert/strict'); assert.equal(process.getuid(),1000);
      for(const alias of ${JSON.stringify(materialized.aliases)}){const path='/bundle/'+alias;assert.ok(fs.readFileSync(path).length);assert.equal(fs.statSync(path).mode&511,256);assert.throws(()=>fs.writeFileSync(path,'forbidden'));}`]);
  assert.equal(docker(['run', '--rm', '--network', 'none', ...hardened, '--entrypoint', 'claude', workerId, '--version']), `${profile.cliVersion} (Claude Code)`);
  const help = docker(['run', '--rm', '--network', 'none', ...hardened, '--entrypoint', 'claude', workerId, '--help']);
  for (const flag of ['--restricted', '--safe-mode', '--tools', '--strict-mcp-config', '--json-schema']) assert.ok(help.includes(flag));
  docker(['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', network]); networks.push(network);
  docker(['network', 'create', egress]); networks.push(egress);
  const inspected = JSON.parse(docker(['network', 'inspect', network]));
  assert.equal(inspected[0].Internal, true); assert.equal(inspected[0].EnableIPv6, false);
  assert.equal(inspected[0].Options['com.docker.network.bridge.gateway_mode_ipv4'], 'isolated');
  docker(['run', '-d', '--name', proxyName, '--network', egress, ...hardened, '--workdir', '/tmp', proxyId]); containers.push(proxyName);
  docker(['network', 'connect', '--alias', 'egress', network, proxyName]);
  const probes = `
    const assert=require('node:assert/strict'),net=require('node:net'),tls=require('node:tls'),fs=require('node:fs');
    assert.notEqual(process.getuid(),0);
    assert.ok(!fs.readFileSync('/proc/net/route','utf8').split('\\n').some(x=>x.split(/\\s+/)[1]==='00000000'));
    const connect=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port});s.setTimeout(500);s.on('connect',()=>{s.destroy();resolve(true)});s.on('error',()=>resolve(false));s.on('timeout',()=>{s.destroy();resolve(false)})});
    (async()=>{
      for(const host of ['169.254.169.254','10.0.0.1','172.17.0.1','192.168.1.1','1.1.1.1','host.docker.internal']) assert.equal(await connect(host,80),false,host);
      for(const target of ['169.254.169.254:443','127.0.0.1:443','[::1]:443','2130706433:443','api.github.com:443','api.anthropic.com.evil.invalid:443','api.anthropic.com:80']) {
        const denied=await new Promise((resolve,reject)=>{const s=net.connect(3128,'egress',()=>s.write('CONNECT '+target+' HTTP/1.1\\r\\nHost: '+target+'\\r\\n\\r\\n'));s.setTimeout(3000);s.once('data',b=>{
          if(/^HTTP\\/1\\.[01] 403/.test(b.toString())){s.destroy();resolve(true);return}
          const t=tls.connect({socket:s,servername:'api.anthropic.com',rejectUnauthorized:false},()=>t.write('POST /v1/messages HTTP/1.1\\r\\nHost: '+target+'\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n'));
          t.once('data',b=>{t.destroy();resolve(/^HTTP\\/1\\.[01] 403/.test(b.toString()))});
          t.on('error',()=>resolve(true));t.on('end',()=>resolve(true));
        });s.on('error',reject);s.on('timeout',()=>{s.destroy();reject(new Error('proxy timeout'))})});
        assert.equal(denied,true,target);
      }
      console.log(JSON.stringify({nonroot:true,noDefaultRoute:true,directDenied:6,proxyDenied:7}));
    })().catch(e=>{console.error(e.message);process.exit(1)});
  `;
  const probeReport = JSON.parse(docker(['run', '--rm', '--network', network, ...hardened, '--entrypoint', 'node', workerId, '-e', probes]));
  const fakeName = `${prefix}-fake`;
  docker(['run', '-d', '--name', fakeName, '--network', egress, ...hardened, '--workdir', '/tmp',
    '--mount', `type=bind,source=${resolve('test/fixtures')},target=/fixture,readonly`, '--entrypoint', 'sh', proxyId, '/fixture/fake-proxy-entrypoint.sh']); containers.push(fakeName);
  docker(['network', 'connect', '--alias', 'fake-egress', network, fakeName]);
  let ca = '';
  for (let tries = 0; tries < 30 && !ca; tries++) {
    ca = docker(['exec', fakeName, 'node', '-e', "const fs=require('fs');if(fs.existsSync('/tmp/fake-state.json'))process.stdout.write(fs.readFileSync('/tmp/ca.pem'))"]);
    if (!ca) await setTimeout(100);
  }
  assert.match(ca, /^-----BEGIN CERTIFICATE-----/, docker(['logs', fakeName]));
  writeFileSync(join(temporary, 'ca.pem'), ca, { mode: 0o444 });
  mkdirSync(join(temporary, 'bundle'));
  writeFileSync(join(temporary, 'bundle', 'probe.txt'), 'synthetic read-only source\n', { mode: 0o444 });
  mkdirSync(join(temporary, 'sentinel'));
  mkdirSync(join(temporary, 'bundle', '.claude'));
  writeFileSync(join(temporary, 'bundle', '.claude', 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch /sentinel/executed' }] }] } }));
  writeFileSync(join(temporary, 'bundle', '.mcp.json'), JSON.stringify({ mcpServers: { hostile: { command: 'sh', args: ['-c', 'touch /sentinel/executed'] } } }));
  const httpsProbe = `const net=require('net'),tls=require('tls'),fs=require('fs'),assert=require('assert/strict');
    const request=(method,path)=>new Promise((resolve,reject)=>{
      const s=net.connect(3128,'fake-egress',()=>s.write('CONNECT api.anthropic.com:443 HTTP/1.1\\r\\nHost: api.anthropic.com:443\\r\\n\\r\\n'));
      s.setTimeout(5000,()=>{s.destroy();reject(new Error('timeout'))});s.once('data',()=>{
        const body=method==='GET'?'':'{}';
        const t=tls.connect({socket:s,servername:'api.anthropic.com',ca:fs.readFileSync('/trust/ca.pem')},()=>t.write(method+' '+path+' HTTP/1.1\\r\\nHost: api.anthropic.com\\r\\nContent-Length: '+body.length+'\\r\\nConnection: close\\r\\n\\r\\n'+body));
        let b='';t.on('data',x=>b+=x);t.on('end',()=>resolve(Number(b.split(' ')[1])));t.on('error',reject);
      });s.on('error',reject);
    });
    (async()=>{
      assert.equal(await request('POST','/v1/messages/count_tokens'),200);
      for(const [method,path] of [
        ['GET','/api/claude_code/settings'],['POST','/api/claude_code/settings'],['GET','/api/claude_code/policy_limits'],
        ['POST','/api/oauth/claude_cli/create_api_key'],['GET','/v1/messages'],['POST','/v1/messages?beta=true&extra=1'],
        ['POST','/v1/messages?beta=false'],['POST','//v1/messages'],['POST','/v1/messages/count_tokens/../../api/claude_code/settings']
      ]) assert.equal(await request(method,path),403,method+' '+path);
      console.log(JSON.stringify({allowedInference:true,deniedPaths:9}));
    })().catch(e=>{console.error(e.message);process.exit(1)});`;
  docker(['run', '--rm', '--network', network, ...hardened, '--entrypoint', 'node',
    '--mount', `type=bind,source=${join(temporary, 'ca.pem')},target=/trust/ca.pem,readonly`, workerId, '-e', httpsProbe]);
  for (const variant of ['bad-cert', 'private-dns']) {
    const name = `${prefix}-${variant}`, caPath = join(temporary, `${variant}.pem`);
    const extra = variant === 'bad-cert' ? ['--env', 'SYNTHETIC_BAD_CERT=1'] : ['--add-host', 'api.anthropic.com:127.0.0.1'];
    docker(['run', '-d', '--name', name, '--network', egress, ...hardened, '--workdir', '/tmp', ...extra,
      '--mount', `type=bind,source=${resolve('test/fixtures')},target=/fixture,readonly`, '--entrypoint', 'sh', proxyId, '/fixture/fake-proxy-entrypoint.sh']);
    containers.push(name); docker(['network', 'connect', '--alias', variant, network, name]);
    let certificate = '';
    for (let tries = 0; tries < 30 && !certificate; tries++) {
      certificate = docker(['exec', name, 'node', '-e', "const fs=require('fs');if(fs.existsSync('/tmp/fake-state.json'))process.stdout.write(fs.readFileSync('/tmp/ca.pem'))"]);
      if (!certificate) await setTimeout(100);
    }
    assert.match(certificate, /^-----BEGIN CERTIFICATE-----/); writeFileSync(caPath, certificate);
    const requestCode = httpsProbe.slice(0, httpsProbe.indexOf('    (async()=>')).replace("'fake-egress'", JSON.stringify(variant));
    const expected = variant === 'private-dns' ? 'status===403' : 'status===502 || status===503';
    docker(['run', '--rm', '--network', network, ...hardened, '--entrypoint', 'node',
      '--mount', `type=bind,source=${caPath},target=/trust/ca.pem,readonly`, workerId, '-e',
      `${requestCode} request('POST','/v1/messages').then(status=>assert.ok(${expected},String(status))).catch(e=>{console.error(e.message);process.exit(1)});`]);
    assert.deepEqual(JSON.parse(docker(['exec', name, 'cat', '/tmp/fake-state.json'])).paths, []);
  }
  const fakeWorker = `${prefix}-worker`; containers.push(fakeWorker);
  let raw: string;
  try { raw = docker(['run', '--name', fakeWorker, '--log-driver', 'none', '-i', '--network', network, ...hardened,
    '--env', 'HTTPS_PROXY=http://fake-egress:3128', '--env', 'HTTP_PROXY=http://fake-egress:3128',
    '--env', 'NODE_EXTRA_CA_CERTS=/trust/ca.pem',
    '--mount', `type=bind,source=${join(temporary, 'ca.pem')},target=/trust/ca.pem,readonly`,
    '--mount', `type=bind,source=${join(temporary, 'bundle')},target=/bundle,readonly`,
    '--mount', `type=bind,source=${join(temporary, 'sentinel')},target=/sentinel`,
    workerId, ...cliArguments()], 'synthetic-oauth-token\nReview the synthetic file /bundle/probe.txt.');
  } catch { throw new Error('Synthetic CLI execution failed; raw process output is withheld'); }
  const terminal = JSON.parse(raw);
  const fakeState = JSON.parse(docker(['exec', fakeName, 'cat', '/tmp/fake-state.json']));
  const configuration = docker(['inspect', fakeWorker]);
  assert.equal(configuration.includes('synthetic-oauth-token'), false, 'Credential must not enter Docker metadata');
  assert.equal(configuration.includes('CLAUDE_CODE_OAUTH_TOKEN'), false, 'Docker must not store the OAuth environment entry');
  assert.equal(JSON.parse(configuration)[0].HostConfig.LogConfig.Type, 'none');
  assert.equal(fakeState.promptCredential, false, 'Credential must not enter model input');
  assert.equal(terminal.subtype, 'success', JSON.stringify({ subtype: terminal.subtype, is_error: terminal.is_error, requests: fakeState.requests, tools: fakeState.tools }));
  assert.equal(terminal.is_error, false);
  assert.deepEqual(terminal.structured_output, { findings: [], priorFindingAssessments: [] });
  const originalOutcome = validateOutcome(Buffer.from(raw), passSpecSchema.parse({ id: 'synthetic', kind: 'scope', unitIds: [], contextHash: 'a'.repeat(64),
    bundlePath: join(temporary, 'bundle'), reviewUnits: [], sourceMap: [], trustedInstructions: [], priorFindings: [] }));
  assert.equal(originalOutcome.status, 'completed', JSON.stringify({ code: originalOutcome.failureCode,
    fields: Object.keys(terminal), apiStatusType: terminal.api_error_status === null ? 'null' : typeof terminal.api_error_status,
    pinnedModelPresent: Object.hasOwn(terminal.modelUsage ?? {}, profile.model) }));
  assert.equal(fakeState.auth, true);
  assert.ok(fakeState.tools.includes('Read') && fakeState.tools.includes('Glob') && fakeState.tools.includes('Grep'));
  assert.ok(!fakeState.tools.includes('Bash') && !fakeState.tools.some((name: string) => name.startsWith('mcp__')));
  assert.ok(fakeState.paths.every((path: string) => /^\/v1\/messages(?:\/count_tokens)?(?:\?beta=true)?$/.test(path)));
  assert.equal(fakeState.commandExecuted, false);
  assert.equal(existsSync(join(temporary, 'sentinel', 'executed')), false);
  assert.equal(fakeState.secretLeaked, false);
  assert.deepEqual(fakeState.tools, ['Glob', 'Grep', 'Read', 'StructuredOutput']);
  assert.equal(fakeState.results.length, 14);
  assert.ok(fakeState.results.slice(0, 3).every((result: { isError: boolean }) => !result.isError));
  assert.ok(fakeState.results.slice(3).every((result: { isError: boolean }) => result.isError));
  const navigationProvider = `${prefix}-navigation-provider`, navigationWorker = `${prefix}-navigation-worker`;
  docker(['run', '-d', '--name', navigationProvider, '--network', egress, ...hardened, '--workdir', '/tmp',
    '--env', 'SYNTHETIC_NAVIGATION=1', '--mount', `type=bind,source=${resolve('test/fixtures')},target=/fixture,readonly`,
    '--entrypoint', 'sh', proxyId, '/fixture/fake-proxy-entrypoint.sh']); containers.push(navigationProvider);
  docker(['network', 'connect', '--alias', 'navigation-egress', network, navigationProvider]);
  let navigationCa = '';
  for (let tries = 0; tries < 30 && !navigationCa; tries++) {
    navigationCa = docker(['exec', navigationProvider, 'node', '-e', "const fs=require('fs');if(fs.existsSync('/tmp/fake-state.json'))process.stdout.write(fs.readFileSync('/tmp/ca.pem'))"]);
    if (!navigationCa) await setTimeout(100);
  }
  assert.match(navigationCa, /^-----BEGIN CERTIFICATE-----/);
  const navigationCaPath = join(temporary, 'navigation-ca.pem'); writeFileSync(navigationCaPath, navigationCa);
  assert.ok(Buffer.byteLength(materialized.prompt) <= profile.maxRequestBytes);
  containers.push(navigationWorker);
  const navigationRaw = docker(['run', '--name', navigationWorker, '--log-driver', 'none', '-i', '--network', network, ...hardened,
    '--env', 'HTTPS_PROXY=http://navigation-egress:3128', '--env', 'HTTP_PROXY=http://navigation-egress:3128', '--env', 'NODE_EXTRA_CA_CERTS=/trust/ca.pem',
    '--mount', `type=bind,source=${navigationCaPath},target=/trust/ca.pem,readonly`,
    '--mount', `type=volume,source=${volume},target=/bundle,volume-subpath=${materialized.subpath},readonly`,
    workerId, ...cliArguments()], `synthetic-oauth-token\n${materialized.prompt}`);
  const navigationState = JSON.parse(docker(['exec', navigationProvider, 'cat', '/tmp/fake-state.json']));
  assert.equal(validateOutcome(Buffer.from(navigationRaw), passSpecSchema.parse(materialized.spec)).status, 'completed');
  assert.equal(navigationState.navigationRead, true, JSON.stringify(navigationState)); assert.equal(navigationState.sourceAliasRead, true);
  assert.equal(navigationState.promptCredential, false); assert.equal(navigationState.auth, true);
  assert.equal(navigationState.requests, 3);
  const fixtureTag = `${prefix}-proxy-image`;
  docker(['build', '-q', '--build-arg', `PROXY_IMAGE=${proxyId}`, '-t', fixtureTag, '-f', 'test/fixtures/worker-proxy.Dockerfile', 'test/fixtures']); images.push(fixtureTag);
  const fixtureId = docker(['image', 'inspect', fixtureTag, '--format', '{{.Id}}']);
  const owned = join(temporary, 'owned'), emptyBundle = join(temporary, 'inert'); mkdirSync(owned); mkdirSync(emptyBundle);
  mkdirSync(join(emptyBundle, 'data')); mkdirSync(join(emptyBundle, 'quarantine'));
  const service = await createWorker({ workerImage: workerId, proxyImage: fixtureId, temporaryRoot: owned, oauthToken: async () => 'synthetic-oauth-token' });
  const ownerLabel = 'io.basic-pr-reviewer.owner=worker-service';
  assert.equal(docker(['ps', '-aq', '--filter', `label=${ownerLabel}`]), '', 'Acceptance requires an idle worker service');
  assert.equal(docker(['network', 'ls', '-q', '--filter', `label=${ownerLabel}`]), '', 'Acceptance requires an idle worker service');
  const orphanNetwork = `${prefix}-orphan-network`, orphan = `${prefix}-orphan`;
  networks.push(orphanNetwork); containers.push(orphan);
  docker(['network', 'create', '--label', ownerLabel, orphanNetwork]);
  docker(['run', '-d', '--name', orphan, '--label', ownerLabel, '--network', orphanNetwork, ...hardened,
    '--entrypoint', 'node', workerId, '-e', 'setInterval(()=>{},1000)']);
  const orphanDirectory = mkdtempSync(join(owned, 'worker-')); writeFileSync(join(orphanDirectory, 'ca.pem'), 'synthetic public certificate');
  const identity = { installationId: '1', repositoryId: '2', owner: 'synthetic', repo: 'fixture', pullNumber: 3,
    headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), mergeBaseSha: 'c'.repeat(40), baseRef: 'main', policyHash: 'd'.repeat(64),
    runtimeHash: service.runtimeHash, attemptId: '4', generation: 1 };
  const assigned = passSpecSchema.parse({ id: 'synthetic-owned', kind: 'scope', unitIds: [],
    contextHash: createHash('sha256').update(JSON.stringify({ policyHash: identity.policyHash, runtimeHash: service.runtimeHash, files: [] })).digest('hex'),
    bundlePath: emptyBundle, reviewUnits: [], sourceMap: [], trustedInstructions: [], priorFindings: [] });
  assigned.contextHash = passContextHash(identity, assigned.sourceMap, renderNavigation(assigned));
  writeFileSync(join(emptyBundle, navigationAlias), renderNavigation(assigned));
  assert.equal((await service.runPass(identity, assigned, new AbortController().signal)).failureCode, 'recovery_required');
  await service.reap();
  containers.splice(containers.indexOf(orphan), 1); networks.splice(networks.indexOf(orphanNetwork), 1);
  assert.equal(existsSync(orphanDirectory), false);
  assert.equal(docker(['inspect', proxyName, '--format', '{{.State.Running}}']), 'true');
  const outcome = await service.runPass(identity, assigned, new AbortController().signal);
  assert.equal(outcome.status, 'completed', outcome.failureCode ?? 'unknown');
  assert.equal(docker(['ps', '-aq', '--filter', 'label=io.basic-pr-reviewer.owner=worker-service']), '');
  assert.equal(docker(['network', 'ls', '-q', '--filter', 'label=io.basic-pr-reviewer.owner=worker-service']), '');
  const cancellation = new AbortController();
  const cancelledRun = service.runPass(identity, assigned, cancellation.signal);
  await setTimeout(250); cancellation.abort();
  assert.equal((await cancelledRun).failureCode, 'cancelled');
  assert.equal(docker(['ps', '-aq', '--filter', `label=${ownerLabel}`]), '');
  assert.equal(docker(['network', 'ls', '-q', '--filter', `label=${ownerLabel}`]), '');
  assert.deepEqual(readdirSync(owned), []);
  // Parsing all exact flags offline must reach authentication, rather than an unknown-option failure.
  const flagRun = spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', ...hardened, '--entrypoint', 'claude', workerId, ...cliArguments()],
    { input: 'Synthetic offline flag check.', encoding: 'utf8', timeout: 15000, maxBuffer: profile.maxOutputBytes, windowsHide: true });
  assert.ok(!/unknown option|unknown argument/i.test(`${flagRun.stdout}${flagRun.stderr}`));
  process.stdout.write(`${JSON.stringify({ workerId, proxyId, runtimeHash: workerRuntimeHash(workerId, proxyId), profile,
    ...probeReport, linuxMaterializedOwnership: true, deniedPaths: 9, upstreamCertificateVerified: true, privateDnsDenied: true,
    orphanReaped: true, unrelatedResourcesPreserved: true, cancelledAllocationCleaned: true,
    credentialAbsentFromDockerMetadata: true, credentialAbsentFromModelInput: true, fakeState,
    navigationState, requestBytes: Buffer.byteLength(materialized.prompt), liveInference: false }, null, 2)}\n`);
} catch (error) {
  failed = true; throw error;
} finally {
  const failures: string[] = [];
  const clean = (label: string, action: () => void) => { try { action(); } catch { failures.push(label); } };
  for (const name of containers.reverse()) clean(`container ${name}`, () => docker(['rm', '-f', name]));
  for (const name of networks.reverse()) clean(`network ${name}`, () => docker(['network', 'rm', name]));
  for (const name of images.reverse()) clean(`image ${name}`, () => docker(['image', 'rm', name]));
  for (const name of volumes.reverse()) clean(`volume ${name}`, () => docker(['volume', 'rm', name]));
  clean(`directory ${temporary}`, () => {
    assert.ok(temporary.startsWith(join(process.cwd(), 'worker-acceptance-')));
    rmSync(temporary, { recursive: true, force: true });
  });
  if (failures.length) {
    if (failed) process.stderr.write(`${JSON.stringify({ cleanupFailures: failures })}\n`);
    else throw new Error(`Acceptance cleanup failed: ${failures.join(', ')}`);
  }
}
