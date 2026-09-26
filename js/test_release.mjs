import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchReleaseIndex, parseSums, verifyBundleFiles } from './release.js';
import { requiredBundleMembers } from './profiles.js';

test('checksum names cannot escape the bundle directory or become shell fragments', () => {
  for (const name of ['../expdb', 'boot.img;reboot', 'nested/file', 'boot.img\nreboot']) {
    assert.throws(() => parseSums(`${'a'.repeat(64)}  ${name}\n`), /filename|name|invalid/i, name);
  }
});

test('a failed digest never appears in the verified file map', async () => {
  const file = new Blob(['wrong']);
  file.name = 'boot.img';
  const result = await verifyBundleFiles([file], { sums: new Map([['boot.img', '0'.repeat(64)]]) });
  assert.equal(result.failed.length, 1);
  assert.equal(result.byName.has('boot.img'), false, 'mismatched file remains stageable');
});

test('release lookup retains the API asset SHA-256 trust anchor', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{
    tag_name: 'radar-puffin-v0.14.0', published_at: '2026-09-26T00:00:00Z',
    assets: [{ name: 'libreecho-install.zip', size: 123, digest: `sha256:${'a'.repeat(64)}` }],
  }] });
  try {
    const releases = await fetchReleaseIndex();
    assert.equal(releases[0].assets[0].digest, `sha256:${'a'.repeat(64)}`);
  } finally { globalThis.fetch = previous; }
});

test('a complete recovery handoff requires both separately published ZIP members', () => {
  const required = requiredBundleMembers('radar-puffin-v0.14.0');
  assert.ok(required.includes('libreecho-install.zip'));
  assert.ok(required.includes('bundle.manifest'));
  assert.ok(required.includes('libreecho-radar-puffin-v0.14.0-TWRPINSTALL-SHA256SUMS'));
});
