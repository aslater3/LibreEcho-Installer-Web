import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as auto from './auto-fetch.js';
import { requiredBundleMembers } from './profiles.js';
const hash = x => createHash('sha256').update(x).digest('hex');
const tag = 'radar-puffin-v0.14.0';
const prefix = `libreecho-${tag}`;
function fixture() {
  const bytes = new Map(requiredBundleMembers(tag).filter(n => !n.endsWith('SHA256SUMS')).map(n => [n, n.endsWith('-build.json') ? JSON.stringify({ board: 'radar_puffin', hardware_accepted: true }) : `bytes ${n}`]));
  bytes.set('extra.bin', 'extra');
  const normal = [...bytes].filter(([n]) => !['bundle.manifest', 'libreecho-install.zip'].includes(n)).map(([n,b]) => `${hash(b)}  ${n}`).join('\n');
  const twrp = ['bundle.manifest', 'libreecho-install.zip'].map(n => `${hash(bytes.get(n))}  ${n}`).join('\n');
  bytes.set(`${prefix}-SHA256SUMS`, normal); bytes.set(`${prefix}-TWRPINSTALL-SHA256SUMS`, twrp);
  const release = { tag, assets: [...bytes].map(([name,b]) => ({ name, size: Buffer.byteLength(b), digest: `sha256:${hash(b)}` })) };
  const calls = [];
  const fetcher = async url => { calls.push(String(url)); const name = decodeURIComponent(String(url).split('/').pop()); return bytes.has(name) ? new Response(bytes.get(name)) : new Response('missing', { status: 404 }); };
  return { bytes, release, fetcher, calls };
}
test('automatic bundle downloads checksum union and verifies every asset against SUMS and API', async () => {
  assert.equal(typeof auto.fetchReleaseBundle, 'function');
  const f = fixture(); const progress = [];
  const bundle = await auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://mirror.example/mirror', fetcher: f.fetcher, onProgress: (...p) => progress.push(p) });
  assert.deepEqual(new Set(bundle.files.map(f => f.name)), new Set(f.bytes.keys()));
  assert.ok(bundle.files.every(f => f instanceof Blob));
  assert.ok(progress.length); await bundle.dispose();
});
test('download progress uses the complete fixed plan before the first payload', async () => {
  const f = fixture(); const events = [];
  const bundle = await auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://m', fetcher: f.fetcher, onEvent: e => events.push(e) });
  const transfer = events.filter(e => e.phase === 'downloading');
  const total = f.release.assets.reduce((n, a) => n + a.size, 0);
  assert.ok(transfer.length > 0);
  for (const e of transfer) {
    assert.equal(e.total, total, 'denominator must not grow as each file starts');
    assert.equal(e.count, f.release.assets.length);
  }
  assert.ok(events.some(e => e.phase === 'preparing'));
  assert.equal(events.at(-1).phase, 'complete');
  assert.equal(events.at(-1).done, total);
  await bundle.dispose();
});
test('invalid late payload size is rejected before any payload is downloaded', async () => {
  const f = fixture(); f.release.assets.find(a => a.name === 'extra.bin').size = -1;
  await assert.rejects(auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://m', fetcher: f.fetcher }), /size/);
  assert.ok(f.calls.every(url => url.endsWith('SHA256SUMS')));
});
test('duplicate API asset names are rejected rather than choosing the first', async () => {
  const f = fixture(); f.release.assets.push({ ...f.release.assets[0] });
  await assert.rejects(auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://m', fetcher: f.fetcher }), /duplicate/i);
});
test('SUMS mismatch fails closed', async () => {
  const f = fixture(); const n = `${prefix}-boot.img`; f.bytes.set(n, 'corrupt');
  await assert.rejects(auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://m', fetcher: f.fetcher }), /size|digest|checksum/);
});
test('API digest mismatch even for non-required union member fails closed', async () => {
  const f = fixture(); f.release.assets.find(a => a.name === 'extra.bin').digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://m', fetcher: f.fetcher }), /API|digest|checksum/);
});
test('missing release asset fails closed before fetching its bytes', async () => {
  const f = fixture(); f.release.assets = f.release.assets.filter(a => a.name !== 'extra.bin');
  await assert.rejects(auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://m', fetcher: f.fetcher }), /missing.*asset|asset.*missing/);
  assert.ok(!f.calls.some(n => n.endsWith('/extra.bin')));
});
test('missing API digest refuses checksum inventories', async () => {
  const f = fixture(); f.release.assets.find(a => a.name.endsWith('-SHA256SUMS')).digest = null;
  await assert.rejects(auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://m', fetcher: f.fetcher }), /API|digest/);
});
test('helper absent leaves manual selection available and never attempts GitHub byte fetch', async () => {
  const urls = [];
  assert.equal(await auto.discoverMirror({ origin: 'http://127.0.0.1:8766', fetcher: async url => { urls.push(url); return new Response('not found', { status: 404 }); } }), null);
  assert.deepEqual(urls, ['http://127.0.0.1:8766/mirror/health']);
});
test('helper discovery and configured mirror precedence', async () => {
  assert.deepEqual(await auto.discoverMirror({ origin: 'http://127.0.0.1:8766', fetcher: async () => Response.json({ repository: 'aslater3/LibreEcho', mirror: true, amonet: true }) }), { mirrorBase: 'http://127.0.0.1:8766/mirror', amonetMirrorBase: 'http://127.0.0.1:8766/amonet' });
  assert.equal((await auto.discoverMirror({ mirrorBase: 'https://approved/mirror', fetcher: () => { throw new Error('must not probe'); } })).mirrorBase, 'https://approved/mirror');
});
test('OPFS streams into a file without materializing the release in JS arrays', async () => {
  const writes = []; const removes = []; let data = [];
  const handle = { createWritable: async () => new WritableStream({ write: chunk => { writes.push(chunk.length); data.push(chunk); } }), getFile: async () => { const file = new Blob(data); file.name='asset.bin'; return file; } };
  const storage = { getDirectory: async () => ({ getDirectoryHandle: async () => ({ getFileHandle: async () => handle }), removeEntry: async (...args) => removes.push(args) }) };
  const store = await auto.createBundleStore(storage);
  const file = await store.receive(new Response('streamed'), 'asset.bin', { expectedSize: 8 });
  assert.equal(await file.text(), 'streamed'); assert.ok(writes.length);
  await store.dispose(); assert.equal(removes.length,1); await store.dispose(); assert.equal(removes.length,1);
});
test('OPFS quota failure surfaces rather than silently retaining huge RAM blobs', async () => {
  await assert.rejects(auto.createBundleStore({ getDirectory: async () => { throw new Error('quota'); } }), /quota/);
});
test('conflicting inventories are rejected', async () => {
  const f = fixture(); const name = `${prefix}-TWRPINSTALL-SHA256SUMS`;
  f.bytes.set(name, f.bytes.get(name)+`\n${'0'.repeat(64)}  extra.bin`);
  const a = f.release.assets.find(a=>a.name===name); a.digest=`sha256:${hash(f.bytes.get(name))}`; a.size=Buffer.byteLength(f.bytes.get(name));
  await assert.rejects(auto.fetchReleaseBundle(f.release,{ mirrorBase:'https://m',fetcher:f.fetcher }), /conflicting/);
});
test('cancellation refuses incomplete downloads', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(auto.fetchReleaseBundle(f.release, { mirrorBase: 'https://m', fetcher: f.fetcher, signal: controller.signal }), /abort/i);
});
