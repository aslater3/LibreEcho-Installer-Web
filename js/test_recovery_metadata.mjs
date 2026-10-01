import test from 'node:test';
import assert from 'node:assert/strict';
import { completeFixture, tar } from './bundle-fixture.mjs';
import { extractRecoveryMetadata } from './recovery-metadata.js';
const fixture = () => { const f=completeFixture(); return { ...f, map:new Map(f.files.map(b=>[b.name,b])) }; };
test('three exact archive members are bound to verified bundle.manifest hashes',async()=>{
 const f=fixture();const result=await extractRecoveryMetadata(f.map,f.tag);
 assert.deepEqual(new Set(result.files.keys()),new Set(f.metadata.keys()));
 for(const [name,b] of result.files)assert.equal(await b.text(),f.metadata.get(name));
});
test('archive member digest mismatch is rejected',async()=>{
 const f=fixture();f.map.set(`libreecho-${f.tag}-initial-install.tar`,new Blob([tar([['manifest.json','bad']])]));
 await assert.rejects(extractRecoveryMetadata(f.map,f.tag),/derived digest mismatch/);
});
test('missing derived digest pin is rejected',async()=>{
 const f=fixture();f.map.set('bundle.manifest',new Blob(['no pins']));
 await assert.rejects(extractRecoveryMetadata(f.map,f.tag),/pin missing/);
});
test('tar duplicate member is rejected',async()=>{
 const f=fixture();f.map.set(`libreecho-${f.tag}-initial-install.tar`,new Blob([tar([['manifest.json','{}'],['manifest.json','{}']])]));
 await assert.rejects(extractRecoveryMetadata(f.map,f.tag),/duplicate/);
});
test('tar header corruption is rejected',async()=>{
 const f=fixture();const b=tar([['manifest.json','{}']]);b[0]^=1;f.map.set(`libreecho-${f.tag}-initial-install.tar`,new Blob([b]));
 await assert.rejects(extractRecoveryMetadata(f.map,f.tag),/header checksum/);
});
test('missing archive fails closed',async()=>{
 const f=fixture();f.map.delete(`libreecho-${f.tag}.ota.tar`);
 await assert.rejects(extractRecoveryMetadata(f.map,f.tag),/missing verified/);
});
