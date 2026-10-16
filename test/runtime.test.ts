import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
it.skipIf(process.platform !== 'linux')('uses kernel flock ownership across competing processes and releases it on process death',()=>{
  const result=execFileSync(process.execPath,['test/fixtures/flock.mjs'],{encoding:'utf8',timeout:20000});
  expect(JSON.parse(result)).toEqual({competingProcessDenied:true,forgedLockedFlagDenied:true,releasedOnExit:true});
});
