import test from 'node:test';
import assert from 'node:assert/strict';
import {boardMatches,parseCacheFreeBytes,pushBundle,runRecoveryPhase} from './stages.js';
import {sha256Blob} from './sha256.js';

test('ZIP command refuses unsafe names even if supplied in an allowlist',async()=>{
 const prior=globalThis.localStorage;
 globalThis.localStorage={getItem:()=>null,setItem:()=>{}};
 try {
  for(const zipName of ['x;echo injected.zip','x$(id).zip','x y.zip']){
   const calls=[];
   await assert.rejects(runRecoveryPhase({adb:{shell:async c=>{calls.push(c);return {stdout:'__RECEIPT__result=installed'}}},tag:'test',serialRaw:'TEST',zipName,allowZipNames:[zipName]}),/unsafe|ZIP/);
   assert.deepEqual(calls,[]);
  }
 }finally{globalThis.localStorage=prior;}
});

test('recovery board matching uses explicit aliases, never substrings',()=>{
 assert.ok(boardMatches('RADAR','radar_puffin'));
 assert.ok(boardMatches('biscuit','biscuit'));
 for(const name of ['b','iscuit','other_biscuit','biscuit_radar','rad'])assert.equal(boardMatches(name,name==='rad'?'radar_puffin':'biscuit'),false,name);
});
test('cache measurement rejects wrong mount, multiple rows, impossible and unsafe counts',()=>{
 for(const text of ['/dev/x 100 0 100 0% /data','/dev/x 100 0 100 0% /cache\n/dev/y 100 0 100 0% /cache','/dev/x 100 0 101 0% /cache','/dev/x 99999999999999999999 0 99999999999999999999 0% /cache'])assert.throws(()=>parseCacheFreeBytes(text),/cache|filesystem|space/i,text);
});
test('cache gate is mandatory for every push call, including a false legacy option',async()=>{
 const file=new Blob(['x']); const name='boot.img';
 for(const options of [{},{requireCacheSpace:false}]){
  const writes=[];
  const adb={shell:async command=>{if(command.startsWith('df '))return {stdout:'/dev/x 100 99 1 99% /cache'};writes.push(command);return {stdout:''}},push:async()=>writes.push('push')};
  await assert.rejects(pushBundle({adb,files:new Map([[name,file]]),sums:new Map([[name,await sha256Blob(file)]]),...options}),/cache|space/);
  assert.deepEqual(writes,[]);
 }
});
