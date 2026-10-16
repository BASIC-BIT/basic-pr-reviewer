import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
it.skipIf(process.platform !== 'linux')('uses kernel flock ownership across competing processes and releases it on process death',()=>{
  const result=execFileSync(process.execPath,['test/fixtures/flock.mjs'],{encoding:'utf8',timeout:20000});
  expect(JSON.parse(result)).toEqual({competingProcessDenied:true,forgedLockedFlagDenied:true,releasedOnExit:true});
});

it('persists initial pause and explicit resume atomically without accepting malformed state',async()=>{
  const { createPauseState } = await import('../src/runtime.js');
  const { mkdtemp, readFile, writeFile, rm, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');const { tmpdir } = await import('node:os');
  const root=await mkdtemp(join(tmpdir(),'pause-state-'));
  try {
    const pause=createPauseState(root,true);expect(await pause.read()).toBe(true);await pause.write(false);
    expect(await createPauseState(root,true).read()).toBe(false);expect(await readFile(join(root,'pause.json'),'utf8')).toBe('false\n');
    if(process.platform==='linux')expect((await stat(join(root,'pause.json'))).mode&0o777).toBe(0o600);
    await writeFile(join(root,'pause.json'),'invalid');await expect(pause.read()).rejects.toThrow();
    await expect(createPauseState(join(root,'missing'),true).write(true)).rejects.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
});
