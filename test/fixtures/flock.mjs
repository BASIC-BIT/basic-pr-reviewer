import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { assertFlock } from '../../dist/runtime.js';
if (process.argv[2] === 'verify' || process.argv[2] === 'hold') {
  await assertFlock(process.argv[3]);
  if (process.argv[2] === 'hold') { process.stdout.write('owned\n'); setInterval(() => {}, 1000); }
} else {
  const root = await mkdtemp(join(tmpdir(),'reviewer-lock-')), path = join(root,'service.lock');
  let child;
  try {
    const args = ['--exclusive','--nonblock','--no-fork',path,process.execPath,fileURLToPath(import.meta.url)];
    child = spawn('flock',[...args,'hold',path],{stdio:['ignore','pipe','pipe']});
    await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw new Error('lock child exited');}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('lock timeout')),10000);timer.unref();})]);
    assert.equal(spawnSync('flock',[...args,'verify',path],{encoding:'utf8'}).status,1);
    assert.notEqual(spawnSync(process.execPath,[fileURLToPath(import.meta.url),'verify',path],{encoding:'utf8'}).status,0);
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;child=undefined;
    const released=spawnSync('flock',[...args,'verify',path],{encoding:'utf8'});assert.equal(released.status,0,released.stderr);
    process.stdout.write(JSON.stringify({competingProcessDenied:true,forgedLockedFlagDenied:true,releasedOnExit:true})+'\n');
  } finally { child?.kill('SIGKILL'); await rm(root,{recursive:true,force:true}); }
}
