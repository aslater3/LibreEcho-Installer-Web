import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { acquireAmonetPayload } from './amonet.js';

const memberPath = 'amonet/bin/fastbrick-20221007.img';
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const data = Buffer.from('synthetic fastbrick image, not device firmware');

// ZIP fixtures are generated in memory. Central/local offsets are deliberately
// exposed so individual assertions can corrupt exactly one structural field.
function zip(entries = [{ name: memberPath, data, method: 0 }]) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data: body, method = 0, flags = 0 } of entries) {
    const nameBytes = Buffer.from(name);
    const compressed = method === 8 ? deflateRawSync(body) : Buffer.from(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return { buffer: Buffer.concat([...locals, cd, eocd]), centralOffset: offset, eocdOffset: offset + cd.length };
}

function options(fixture, payload = data) {
  return {
    archiveBlob: new Blob([fixture.buffer]), archiveSha256: sha256(fixture.buffer),
    memberPath, payloadSha256: sha256(payload), payloadSize: payload.length,
  };
}
function corrupted(fixture, change) {
  const copy = { ...fixture, buffer: Buffer.from(fixture.buffer) };
  change(copy.buffer, copy);
  return options(copy);
}

test('stored member yields exact bytes and local provenance', async () => {
  const result = await acquireAmonetPayload(options(zip()));
  assert.ok(result.bytes instanceof Uint8Array);
  assert.deepEqual(Buffer.from(result.bytes), data);
  assert.equal(result.source, 'local archive');
});

test('deflated member is expanded with native deflate-raw stream', async () => {
  const result = await acquireAmonetPayload(options(zip([{ name: memberPath, data, method: 8 }])));
  assert.deepEqual(Buffer.from(result.bytes), data);
});

test('only the named member is decompressed, not unrelated member data', async () => {
  const fixture = zip([{ name: 'other/file.bin', data: Buffer.from('other'), method: 8 }, { name: memberPath, data }]);
  // Deliberately corrupt the unrelated deflate stream, then pin the modified
  // archive. A reader that tries to decompress every entry fails here.
  fixture.buffer.fill(0xff, 30 + Buffer.byteLength('other/file.bin'), fixture.centralOffset - (30 + Buffer.byteLength(memberPath) + data.length));
  const result = await acquireAmonetPayload(options(fixture));
  assert.deepEqual(Buffer.from(result.bytes), data);
});

test('bad local archive digest refuses without attempting a URL fallback', async () => {
  let fetched = false;
  await assert.rejects(acquireAmonetPayload({ ...options(zip()), archiveSha256: '0'.repeat(64), fetchImpl: () => { fetched = true; throw Error('fetched'); } }), /archive.*sha|archive.*digest/i);
  assert.equal(fetched, false);
});

test('local archive with configured URL refuses ambiguity before any fetch', async () => {
  let fetched = false;
  await assert.rejects(acquireAmonetPayload({ ...options(zip()), archiveSha256: '0'.repeat(64), url: 'https://example.test/archive.zip', fetchImpl: () => { fetched = true; throw Error('fetched'); } }), /source|both|either/i);
  assert.equal(fetched, false);
});

test('directory records in a ZIP do not make its named payload invalid', async () => {
  const fixture = zip([
    { name: 'amonet/', data: Buffer.alloc(0) },
    { name: 'amonet/bin/', data: Buffer.alloc(0) },
    { name: memberPath, data },
  ]);
  const result = await acquireAmonetPayload(options(fixture));
  assert.deepEqual(Buffer.from(result.bytes), data);
});

test('explicit CORS URL fetch succeeds and records provenance', async () => {
  const fixture = zip();
  const input = options(fixture);
  delete input.archiveBlob;
  const url = 'https://mirror.example.test/amonet.zip';
  const result = await acquireAmonetPayload({ ...input, url, fetchImpl: async (called, init) => {
    assert.equal(called, url);
    assert.equal(init.mode, 'cors');
    assert.equal(init.credentials, 'omit');
    return { ok: true, blob: async () => new Blob([fixture.buffer]) };
  } });
  assert.equal(result.source, url);
  assert.deepEqual(Buffer.from(result.bytes), data);
});

test('failed fetch is not silently replaced by local or other source', async () => {
  const input = options(zip());
  delete input.archiveBlob;
  await assert.rejects(acquireAmonetPayload({ ...input, url: 'https://mirror.example.test/bad.zip', fetchImpl: async () => ({ ok: false, status: 403 }) }), /fetch|HTTP|403/i);
});

test('invalid or ambiguous source and missing pins are rejected', async () => {
  const input = options(zip());
  await assert.rejects(acquireAmonetPayload({ ...input, url: 'https://example.test/a.zip' }), /source|both|either/i);
  await assert.rejects(acquireAmonetPayload({ ...input, archiveSha256: 'wrong' }), /sha|digest/i);
  await assert.rejects(acquireAmonetPayload({ ...input, payloadSize: -1 }), /size/i);
  await assert.rejects(acquireAmonetPayload({ ...input, archiveBlob: undefined, url: 'file:///tmp/f.zip' }), /https?/i);
});

test('insecure remote HTTP archive URL is refused before fetching', async () => {
  const input = options(zip());
  delete input.archiveBlob;
  let fetched = false;
  await assert.rejects(acquireAmonetPayload({ ...input, url: 'http://mirror.example.test/a.zip',
    fetchImpl: async () => { fetched = true; return { ok: true }; } }), /HTTPS|secure/i);
  assert.equal(fetched, false);
});

test('the pinned archive byte size is checked before ZIP parsing', async () => {
  const fixture = zip();
  await assert.rejects(acquireAmonetPayload({ ...options(fixture), archiveSize: fixture.buffer.length - 1 }), /archive.*size/i);
});

test('mirror Content-Length mismatch is refused before reading a body', async () => {
  const fixture = zip();
  const input = options(fixture);
  delete input.archiveBlob;
  let read = false;
  await assert.rejects(acquireAmonetPayload({ ...input, archiveSize: fixture.buffer.length,
    url: 'https://mirror.example.test/a.zip', fetchImpl: async () => ({ ok: true,
      headers: { get: () => String(fixture.buffer.length + 1) },
      blob: async () => { read = true; return new Blob([fixture.buffer]); } }) }), /archive.*size|content.length/i);
  assert.equal(read, false);
});

test('missing member and duplicate member names are refused', async () => {
  await assert.rejects(acquireAmonetPayload({ ...options(zip()), memberPath: 'amonet/bin/missing.img' }), /member|missing/i);
  const fixture = zip([{ name: memberPath, data }, { name: memberPath, data }]);
  await assert.rejects(acquireAmonetPayload(options(fixture)), /duplicate/i);
});

test('traversal in requested path or any archive entry is refused', async () => {
  await assert.rejects(acquireAmonetPayload({ ...options(zip()), memberPath: '../fastbrick.img' }), /path|name/i);
  for (const name of ['../escape', '/absolute', 'a/../escape', 'a\\escape', 'C:/drive']) {
    const fixture = zip([{ name, data: Buffer.from('other') }, { name: memberPath, data }]);
    await assert.rejects(acquireAmonetPayload(options(fixture)), /path|name/i, name);
  }
});

test('declared payload size must match expectation before decompression', async () => {
  await assert.rejects(acquireAmonetPayload({ ...options(zip()), payloadSize: data.length - 1 }), /size/i);
  await assert.rejects(acquireAmonetPayload(corrupted(zip(), (b, f) => b.writeUInt32LE(0xffffffff, f.centralOffset + 24))), /size|zip64|large/i);
});

test('actual output size is capped even when deflate lies in central directory', async () => {
  const f = zip([{ name: memberPath, data, method: 8 }]);
  const input = corrupted(f, (b, x) => { b.writeUInt32LE(1, x.centralOffset + 24); b.writeUInt32LE(1, 22); });
  await assert.rejects(acquireAmonetPayload({ ...input, payloadSize: 1, payloadSha256: sha256(data) }), /size|large/i);
});

test('payload SHA-256 mismatch refuses extraction', async () => {
  await assert.rejects(acquireAmonetPayload({ ...options(zip()), payloadSha256: '0'.repeat(64) }), /payload.*sha|payload.*digest/i);
});

test('truncated central directory, bad EOCD offsets, and split volumes refuse', async () => {
  const f = zip();
  for (const edit of [
    (b, x) => b.writeUInt32LE(x.centralOffset + 1, x.eocdOffset + 16),
    (b, x) => b.writeUInt32LE(1, x.eocdOffset + 12),
    (b, x) => b.writeUInt16LE(1, x.eocdOffset + 4),
    (b, x) => b.writeUInt16LE(0xffff, x.eocdOffset + 10),
  ]) await assert.rejects(acquireAmonetPayload(corrupted(f, edit)), /zip|central|disk|bounds/i);
});

test('bad local signature, local name, local method, and local size refuse', async () => {
  const f = zip();
  for (const edit of [
    (b) => b.writeUInt32LE(0, 0),
    (b) => b.write('X', 30),
    (b) => b.writeUInt16LE(8, 8),
    (b) => b.writeUInt32LE(1, 18),
    (b, x) => b.writeUInt32LE(x.centralOffset + 1, x.centralOffset + 42),
  ]) await assert.rejects(acquireAmonetPayload(corrupted(f, edit)), /local|zip|bounds|mismatch/i);
});

test('unsupported compression and encryption refuse', async () => {
  for (const { method, flags } of [{ method: 12, flags: 0 }, { method: 0, flags: 1 }]) {
    await assert.rejects(acquireAmonetPayload(options(zip([{ name: memberPath, data, method, flags }]))), /method|compress|encrypt|flag/i);
  }
});

test('untrusted member data cannot overlap the central directory', async () => {
  const f = zip();
  await assert.rejects(acquireAmonetPayload(corrupted(f, (b, x) => { b.writeUInt32LE(x.centralOffset, x.centralOffset + 20); b.writeUInt32LE(x.centralOffset, 18); })), /bounds|overlap|local|size/i);
});

test('real pinned Biscuit ZIP (opt-in local host fixture, no repo binary)', { skip: !process.env.AMONET_BISCUIT_ZIP }, async () => {
  const { readFile } = await import('node:fs/promises');
  const archiveBlob = new Blob([await readFile(process.env.AMONET_BISCUIT_ZIP)]);
  const result = await acquireAmonetPayload({
    archiveBlob,
    archiveSha256: '98297293701082bc7272efe077f941c56fc7b6e1f27ef6f2e93b6e4c6fc7b62d',
    memberPath,
    payloadSha256: '1100a16f152d713a3c9794f5954c657075db7a602e42f53b6775d4a7f31a4395',
    payloadSize: 114349580,
  });
  assert.equal(result.bytes.byteLength, 114349580);
});
