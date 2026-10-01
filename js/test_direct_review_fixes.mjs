import test from 'node:test';
import assert from 'node:assert/strict';
import * as direct from './direct-install.js';
import { phaseReply, digest, readbackReply } from './direct-test-protocol.mjs';
const base = { phase: 'prepare', dryRun: true, target: 'biscuit', release: 'release-test', bundleManifestSha256: 'a'.repeat(64) };
const df = { stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/block/cache 100000 1 99999 1% /cache\n' };
const body = 'result=dry-run-ok\n';

test('phase accepts fresh bound receipt and generates a different nonce for every call', async () => {
  const nonces = [];
  const adb = { shell: async c => { nonces.push(/--invocation-id ([a-f0-9]{64})/.exec(c)?.[1]); return phaseReply(c, body); } };
  await direct.runDirectPhase({ ...base, adb });
  await direct.runDirectPhase({ ...base, adb });
  assert.match(nonces[0] ?? '', /^[a-f0-9]{64}$/);
  assert.notEqual(nonces[0], nonces[1]);
});
for (const [key, value] of Object.entries({ phase:'finalize', protocol:'1', target:'radar_puffin', release:'old-release', invocation_id:'0'.repeat(64), bundle_manifest_sha256:'0'.repeat(64), invocation_sha256:'0'.repeat(64), device_digest:'not-a-digest' })) {
 test(`phase rejects mismatched receipt ${key}`, async () => {
  const adb = { shell: async c => phaseReply(c, body, { changes: { [key]: value } }) };
  await assert.rejects(direct.runDirectPhase({ ...base, adb }), /receipt|binding|invocation|device/i);
 });
}
test('phase refuses helper failure even with a fresh successful receipt', async () => {
 await assert.rejects(direct.runDirectPhase({ ...base, adb: { shell: async c => phaseReply(c, body, { rc:127 }) } }), /exit|status|helper/i);
});
test('phase refuses duplicate receipt keys', async () => {
 await assert.rejects(direct.runDirectPhase({ ...base, adb: { shell: async c => phaseReply(c, body + 'phase=prepare\n') } }), /duplicate|receipt/i);
});
test('phase pins device digest from the previous phase', async () => {
 await assert.rejects(direct.runDirectPhase({ ...base, deviceDigest:'e'.repeat(64), adb: { shell: async c => phaseReply(c, body) } }), /device|receipt/i);
});
test('phase refuses a result token from a different operation', async () => {
 await assert.rejects(direct.runDirectPhase({ ...base, adb: { shell: async c => phaseReply(c, 'result=installed\n') } }), /result|receipt/i);
});
test('a stale success receipt without fresh execution evidence is refused', async () => {
 await assert.rejects(direct.runDirectPhase({ ...base, adb: { shell: async () => ({ stdout:'__RECEIPT__result=dry-run-ok\n' }) } }), /receipt|helper|status/i);
});
for (const boundary of ['df', 'mkdir', 'helper-push', 'manifest-push']) {
 test(`Stop during ${boundary} prevents the next mutation`, async () => {
  let stopped=false; const mutations=[]; const landed=new Map();
  const adb={
   shell:async c=> {
    if(c.startsWith('df ')){if(boundary==='df')stopped=true;return df;}
    if(c.startsWith('mkdir ')){mutations.push('mkdir');if(boundary==='mkdir')stopped=true;return {stdout:''};}
    return await readbackReply(c,landed) ?? {stdout:''};
   },
   push:async (p,b)=>{ const what=p.endsWith('.sh')?'helper-push':'manifest-push';mutations.push(what);landed.set(p,b);if(boundary===what)stopped=true; },
  };
  await assert.rejects(direct.pushDirectControl({adb,helperBytes:new TextEncoder().encode('helper'),manifestText:'manifest',isCancelled:()=>stopped}), /stop|cancel/i);
  const expected=['mkdir','helper-push','manifest-push'];
  assert.deepEqual(mutations,boundary==='df'?[]:expected.slice(0,expected.indexOf(boundary)+1));
 });
}
test('a truncated control push is refused by device digest readback', async () => {
 const landed=new Map(); let reads=0;
 const adb={shell:async c=>{ if(c.startsWith('df '))return df;if(c.startsWith('/sbin/sha256sum '))reads++;return await readbackReply(c,landed)??{stdout:''};},push:async(p,b)=>landed.set(p,b.slice(0,1))};
 await assert.rejects(direct.pushDirectControl({adb,helperBytes:new TextEncoder().encode('helper'),manifestText:'manifest'}),/digest|readback/i);
 assert.ok(reads>0);
});
test('Stop during payload hashing prevents that push', async () => {
 let stopped=false;let pushes=0;
 const blob=new Blob(['bytes']);const original=blob.slice.bind(blob);
 blob.slice=(...args)=>{const part=original(...args);const read=part.arrayBuffer.bind(part);part.arrayBuffer=async()=>{const bytes=await read();stopped=true;return bytes;};return part;};
 await assert.rejects(direct.pushDirectPayloads({ adb:{push:async()=>pushes++},roles:[{name:'payload',sha256:digest(Buffer.from('bytes'))}],files:new Map([['payload',blob]]),sums:new Map([['payload',digest(Buffer.from('bytes'))]]),isCancelled:()=>stopped }),/stop|cancel/i);
 assert.equal(pushes,0);
});
for(const name of ['x;id','x y',"x'y",'x`id`','x$(id)']) {
 test(`unsafe payload name refused: ${name}`,()=>assert.throws(()=>direct.planRoles({protocol:2,transfers:[{role:'boot',name,sha256:'a'.repeat(64)},{role:'ota-manifest',name:'manifest',sha256:'b'.repeat(64)},{role:'ota-signature',name:'signature',sha256:'c'.repeat(64)},{role:'local-package',name:'package',sha256:'d'.repeat(64)}]}),/unsafe/i));
}
for(const field of ['helperPath','manifestPath','stateDir','incomingDir']) {
 test(`noncanonical ${field} refused`,()=>assert.throws(()=>direct.directPhaseCommand({...base,invocationId:'f'.repeat(64),[field]:'/tmp/x;id'}),/path|canonical|unsafe/i));
}
