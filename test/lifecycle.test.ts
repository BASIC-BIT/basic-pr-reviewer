import { afterEach, expect, it } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fixture, git, temp, policy } from './fixtures/source.js';
import { createSourceService } from '../src/source.js';
import { startService } from '../src/main.js';
import type { RunningService, ServiceHealth } from '../src/main.js';
import { openStore } from '../src/store.js';
import { createBackups } from '../src/retention.js';
import { controlRequest, loadSecret, CredentialFailure } from '../src/runtime.js';
import { GitHubAccessError } from '../src/github.js';
import type { GitHubPort, OwnedPublication, ReviewThread } from '../src/github.js';
import type { LivePull, PassOutcome, PassSpec, Store } from '../src/contracts.js';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const running: RunningService[] = [];
afterEach(async () => { for (const service of running.splice(0)) await service.stop(); });
async function setup() {
  const remote = await fixture([], [{ path: 'src/index.ts', text: 'source-sentinel-private\n' }]);
  const root = await temp(), sourceRoot = join(root,'source'); await mkdir(sourceRoot);
  const live: LivePull = { installationId:'1',repositoryId:'2',ownerId:'4',owner:'synthetic',repo:'fixture',pullNumber:3,
    headRepositoryId:'2',baseRepositoryId:'2',headSha:remote.head,baseSha:remote.base,mergeBaseSha:remote.merge,baseRef:'main',
    draft:false,state:'open',labels:[],author:{login:'author',type:'User'} };
  let now = Date.now(), ownedLock = false, revoked = false, loseResponse = false;
  const owned: OwnedPublication[] = [], threads: ReviewThread[] = [], calls: PassSpec[] = [], heartbeats: ServiceHealth[] = [];
  const repoPolicy = policy({ skipLabels:['skip-review'], rerunOnUnskip:true }).policy;
  let hook: ((signal: AbortSignal) => Promise<void>) | undefined;
  let mode: 'success'|'partial'|'emptyFailure'|'integrationFailure'|'quota'|'fixed'|'conflictingId'|'conflictingReference'|'partialFixed' = 'success';
  const github: GitHubPort = {
    async assertInstallation() { if(revoked) throw new GitHubAccessError('1','2'); return {ownerId:'4'}; },
    async readDefaultBranch() { return 'main'; }, async listInstallations(){return ['1'];},
    async listRepositories(){if(revoked) throw new GitHubAccessError('1','2');return [{installationId:'1',repositoryId:'2'}];},
    async listOpenPulls(){return live.state==='open'?[3]:[];},
    async readLivePull(){ if(revoked) throw new GitHubAccessError('1','2');return structuredClone(live);},
    async readFile(_pull,path){return path==='.github/claude-review.json'?JSON.stringify(repoPolicy):'Synthetic trusted review instructions.';},
    async readPermission(){return 'write';}, async readCheckRun(){return {appId:'5',headSha:live.headSha,pullNumbers:[3]};},
    async listOwnedPublications(){return owned;},
    async upsertSummary(_target,id,body){ const row = {id:id??randomUUID(),channel:'summary' as const,body,headSha:null};const index=owned.findIndex(item=>item.id===id);if(index<0)owned.push(row);else owned[index]=row;return row.id;},
    async upsertCheck(_target,id,check){const row={id:id??randomUUID(),channel:'check' as const,body:check.body,headSha:check.headSha};const index=owned.findIndex(item=>item.id===id);if(index<0)owned.push(row);else owned[index]=row;return row.id;},
    async createReview(_target,review){const id=randomUUID();owned.push({id,channel:'inline',body:review.body,headSha:review.commitId});for(const comment of review.comments)threads.push({id:randomUUID(),reviewId:id,body:comment.body,owned:true,resolved:false,hasReplies:false});if(loseResponse){loseResponse=false;throw new Error('synthetic lost response');}return id;},
    async listThreads(){return threads;}, async resolveThread(_target,id){const t=threads.find(t=>t.id===id);if(t)t.resolved=true;},async unresolveThread(_target,id){const t=threads.find(t=>t.id===id);if(t)t.resolved=false;},
  };
  let store: Store;
  const socket = process.platform==='win32'?`\\\\.\\pipe\\reviewer-${randomUUID()}`:join(root,'control.sock');
  async function start(tickMs = 3600000) {
    const service=await startService({stateDirectory:root,controlSocket:socket,port:0,now:()=>now,tickMs,minimumFreeBytes:0,
      acquireOwnership:async()=>{if(ownedLock)throw new Error('locked');ownedLock=true;return async()=>{ownedLock=false;};},
      heartbeat:async health=>{heartbeats.push(health);},
      open:async()=>{
        expect(ownedLock).toBe(true);
        store=openStore(join(root,'ledger.sqlite'));
        const source=await createSourceService({root:sourceRoot,fetch:async({directory,identity,beforeCredential})=>{await beforeCredential?.();git(directory,['index-pack','--stdin'],git(remote.directory,['pack-objects','--stdout','--revs'],`${identity.baseSha}\n${identity.headSha}\n`));}});
        const backups=await createBackups(store,join(root,'backups'));
        return {store,github,source,webhookSecret:'synthetic-hook',appId:'5',ownerIds:['4'],engineRevision:'a'.repeat(40),backup:backups.backup,dailyBackup:backups.daily,
          worker:{runtimeHash:'e'.repeat(64),reap:async()=>{expect(ownedLock).toBe(true);},runPass:async(_identity,spec,signal,guard)=>{
            await guard?.();signal.throwIfAborted();calls.push(spec);await hook?.(signal);
            const unit=spec.reviewUnits[0];
            let findings: PassOutcome['findings']=unit&&spec.kind==='scope'&&mode!=='emptyFailure'&&mode!=='quota'?[{id:'synthetic-finding',message:'Validate the return value.',severity:'P2' as const,
              location:{kind:'line' as const,path:unit.path,side:'RIGHT' as const,startLine:1,endLine:1},evidence:[{unitId:unit.id,explanation:'Synthetic evidence.'}]}]:[];
            if (spec.kind === 'integration' && (mode === 'conflictingId' || mode === 'conflictingReference')) findings = spec.priorFindings.map(finding => ({ ...finding, ...(mode === 'conflictingReference' ? { id: 'conflicting-finding', priorFindingId: finding.id } : {}) }));
            const base={passId:spec.id,findings,priorFindingAssessments:['fixed','conflictingId','conflictingReference','partialFixed'].includes(mode)&&spec.kind==='integration'?spec.priorFindings.map(finding=>({findingId:finding.id,assessment:'fixed' as const})):[],model:{name:'synthetic',cliVersion:'fixture'},usage:{inputTokens:1,outputTokens:1}};
            if(mode==='partialFixed'&&spec.kind==='integration'||mode==='partial'||mode==='emptyFailure'||mode==='quota'||mode==='integrationFailure'&&spec.kind==='integration')return {...base,status:'failed',failureCode:mode==='quota'?'quota_exhausted':'provider_failure'} satisfies PassOutcome;
            return {...base,status:'completed',failureCode:null} satisfies PassOutcome;
          }} };
      }});
    running.push(service); return service;
  }
  async function send(service:RunningService,action='synchronize',delivery: string=randomUUID()) {
    const value={action,installation:{id:1},repository:{id:2},number:3,pull_request:{number:3},sender:{login:'human',type:'User'},...(action==='labeled'||action==='unlabeled'?{label:{name:'skip-review'}}:{})};
    const body=JSON.stringify(value),address=service.webhookAddress;if(!address||typeof address==='string')throw new Error('address');
    return fetch(`http://127.0.0.1:${address.port}/webhook`,{method:'POST',headers:{'x-github-event':'pull_request','x-github-delivery':delivery,'x-hub-signature-256':`sha256=${createHmac('sha256','synthetic-hook').update(body).digest('hex')}`},body});
  }
  return {setHook:(next:typeof hook)=>{hook=next;},start,send,root,sourceRoot,socket,live,remote,owned,threads,calls,heartbeats,store:()=>store!,advance:(ms:number)=>{now+=ms;},setMode:(m:typeof mode)=>{mode=m;},lose:()=>{loseResponse=true;},revoke:()=>{revoked=true;},now:()=>now};
}
it('runs duplicate admission, partial retry preservation, integration recovery, restart, reuse and publication reconciliation', async()=>{
  const f=await setup();let service=await f.start();
  expect(f.store().current('2',3)).toBeNull();
  const first=await f.send(service,'opened','duplicate');expect(first.status).toBe(202);
  expect((await (await f.send(service,'opened','duplicate')).json()).kind).toBe('duplicate');
  f.setMode('partial');f.lose();await service.cycle();
  expect(f.store().current('2',3)?.passes[0]?.outcome.findings).toHaveLength(1);
  f.advance(70000);f.setMode('emptyFailure');await service.cycle();
  expect(f.store().current('2',3)?.passes[0]?.outcome.findings).toHaveLength(1);
  f.advance(400000);f.setMode('success');await service.cycle();
  f.setMode('integrationFailure');await service.cycle();
  expect(f.calls.at(-1)?.priorFindings).toHaveLength(1);
  await service.stop();running.splice(running.indexOf(service),1);
  await mkdir(join(f.sourceRoot,'capture-AbCd12'));await writeFile(join(f.sourceRoot,'capture-AbCd12','orphan'),'source-sentinel-private');
  f.advance(70000);service=await f.start();f.setMode('success');await service.cycle();
  expect(f.store().current('2',3)?.result?.complete).toBe(true);
  expect(f.owned.filter(p=>p.channel==='summary')).toHaveLength(1);expect(f.threads).toHaveLength(1);
  expect(await readdir(f.sourceRoot)).toEqual([]);
  const oldCount=f.calls.length;
  f.live.headSha=f.remote.commit([{path:'src/index.ts',text:'source-sentinel-private\n'},{path:'src/other.ts',text:'new\n'}],f.live.headSha);
  await f.send(service);await service.cycle();await service.cycle();await service.cycle();
  expect(f.store().current('2',3)?.result?.reusedUnitIds.length).toBeGreaterThan(0);
  expect(f.calls.length-oldCount).toBeLessThan(4);
  const durable=await readFile(join(f.root,'ledger.sqlite'));expect(durable.includes('source-sentinel-private')).toBe(false);
  expect(JSON.stringify(f.owned)).not.toContain('source-sentinel-private');expect(JSON.stringify(f.heartbeats)).not.toContain('synthetic-hook');
});
it('handles base-only invalidation, skip/unskip, close/reopen, quota retry, purge and revocation',async()=>{
  const f=await setup();const service=await f.start();await f.send(service,'opened');await service.cycle();await service.cycle();
  const before=f.calls.length;f.live.baseSha=f.remote.commit([{path:'base.txt',text:'base\n'}],f.remote.base);
  await service.command({command:'reconcile'});await service.cycle();expect(f.calls).toHaveLength(before);
  expect(f.owned.find(p=>p.channel==='summary')?.body).toContain('outdated');
  f.live.headSha=f.remote.commit([{path:'src/index.ts',text:'source-sentinel-private\nchanged\n'}],f.live.headSha);
  await f.send(service);f.live.labels=['skip-review'];await f.send(service,'labeled');await service.cycle();expect(f.calls).toHaveLength(before);
  f.live.labels=[];await f.send(service,'unlabeled');f.setMode('quota');await service.cycle();const due=f.store().current('2',3)?.nextAttemptAt??0;expect(due).toBeGreaterThan(f.now());
  await service.cycle();expect(f.calls).toHaveLength(before+1);f.advance(70000);f.setMode('success');await service.cycle();await service.cycle();
  f.live.state='closed';await f.send(service,'closed');f.advance(29*86400000);await service.cycle();expect(f.store().current('2',3)).not.toBeNull();
  f.live.state='open';await f.send(service,'reopened');await service.cycle();
  f.live.state='closed';await f.send(service,'closed');f.advance(30*86400000);await service.cycle();expect(f.store().current('2',3)).toBeNull();
  f.live.state='open';await f.send(service,'reopened');expect(f.store().current('2',3)?.passes).toEqual([]);await service.cycle();await service.cycle();
  expect(f.owned.filter(p=>p.channel==='summary')).toHaveLength(1);
  f.revoke();await service.command({command:'reconcile'});expect(f.store().accessAllowed('1','2')).toBe(false);const count=f.calls.length;await service.cycle();expect(f.calls).toHaveLength(count);
});
it('exposes private controls, rejects lost-storage intake, and locks before opening dependencies',async()=>{
  const f=await setup();const service=await f.start();
  await expect(f.start()).rejects.toThrow('locked');
  expect(await controlRequest(f.socket,{command:'pause'})).toEqual({paused:true});
  await f.send(service,'opened');await service.cycle();expect(f.calls).toHaveLength(0);
  await controlRequest(f.socket,{command:'resume'});await service.cycle();expect(f.calls).toHaveLength(1);
  await controlRequest(f.socket,{command:'backup',destination:join(f.root,'backups','operator.sqlite')});
  const restored=openStore(join(f.root,'backups','operator.sqlite'));try{expect(restored.current('2',3)?.passes).toHaveLength(1);}finally{restored.close();}
  expect(await controlRequest(f.socket,{command:'inspect',repositoryId:'2',pullNumber:3})).toHaveProperty('current');
  if (process.platform === 'linux') {
    const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
    const configPath = join(f.root, 'config.json');
    await writeFile(configPath, JSON.stringify({ stateDirectory: f.root, backupDirectory: join(f.root, 'backups'), releaseManifest: join(f.root, 'release.json'), region: 'us-east-1', appId: '5', ownerIds: ['4'], privateKey: { secretId: 'synthetic' }, webhookSecret: { secretId: 'synthetic' }, oauthToken: { secretId: 'synthetic' } }));
    const result = await promisify(execFile)(process.execPath, ['dist/runtime.js', 'inspect', '2', '3'], { env: { ...process.env, REVIEWER_CONFIG: configPath } });
    expect(JSON.parse(result.stdout).current.passes).toHaveLength(1);
  }
  f.store().close();expect((await f.send(service)).status).toBe(503);expect((await service.health()).database).toBe(false);
});
it('classifies supervisor secret failures without retaining provider diagnostics',async()=>{
  const syntheticClient=(status:number)=>new SecretsManagerClient({region:'us-east-1',credentials:{accessKeyId:'synthetic',secretAccessKey:'synthetic'},maxAttempts:1,
    requestHandler:{handle:async()=>({response:{statusCode:status,headers:{'content-type':'application/x-amz-json-1.1'},body:Buffer.from(JSON.stringify(status===200?{SecretString:'synthetic-token'}:{__type:status===403?'AccessDeniedException':'ServiceUnavailableException',message:'secret-sentinel'}))}})}});
  const ok=syntheticClient(200),denied=syntheticClient(403),temporary=syntheticClient(503);
  try{expect(await loadSecret(ok,{secretId:'synthetic'})).toBe('synthetic-token');await expect(loadSecret(denied,{secretId:'synthetic'})).rejects.toEqual(new CredentialFailure('configuration'));
    await expect(loadSecret(temporary,{secretId:'synthetic'})).rejects.toEqual(new CredentialFailure('temporary'));
  }finally{ok.destroy();denied.destroy();temporary.destroy();}
});

it('aborts an active timer-driven worker and cleans its source before releasing ownership',async()=>{
  const f=await setup();
  let entered:()=>void=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;});
  f.setHook(async signal=>{entered();await new Promise<void>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));});
  const service=await f.start(10);await f.send(service,'opened');await started;
  await service.stop();running.splice(running.indexOf(service),1);expect(await readdir(f.sourceRoot)).toEqual([]);
  f.setHook(undefined);const restarted=await f.start();await restarted.cycle();await restarted.cycle();
  expect(f.store().current('2',3)?.result?.complete).toBe(true);
});

it('retires a retained partial finding only after current completed integration explicitly verifies its fix',async()=>{
  const f=await setup();const service=await f.start();await f.send(service,'opened');
  f.setMode('partial');await service.cycle();f.advance(70000);f.setMode('emptyFailure');await service.cycle();
  f.advance(400000);f.setMode('success');await service.cycle();f.setMode('fixed');await service.cycle();
  const current=f.store().current('2',3);
  expect(current?.result?.complete).toBe(true);expect(current?.passes[0]?.outcome.findings).toHaveLength(1);
  expect(current?.result?.findings).toEqual([]);expect(current?.result?.priorFindingAssessments).toContainEqual({findingId:'synthetic-finding',assessment:'fixed'});
  expect(f.threads).toHaveLength(1);expect(f.threads[0]?.resolved).toBe(true);
});

it.each(['conflictingId','conflictingReference','partialFixed'] as const)('does not retire a finding from conflicting or incomplete integration: %s',async mode=>{
  const f=await setup();const service=await f.start();await f.send(service,'opened');
  f.setMode('partial');await service.cycle();f.advance(70000);f.setMode('emptyFailure');await service.cycle();
  f.advance(400000);f.setMode('success');await service.cycle();
  expect(f.threads).toHaveLength(1);const retainedThread=f.threads[0]!;f.setMode(mode);await service.cycle();
  const result=f.store().current('2',3)?.result;
  expect(result?.findings.some(finding=>finding.id==='synthetic-finding')).toBe(true);
  expect(retainedThread.resolved).toBe(false);expect(f.threads.every(thread=>!thread.resolved)).toBe(true);
  expect(result?.priorFindingAssessments?.some(assessment=>assessment.assessment==='fixed')).toBe(false);
});
