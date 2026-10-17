import test from 'node:test';
import assert from 'node:assert/strict';
import * as release from './release.js';
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

test('Amonet mirror URL is explicit, pinned to archive name and HTTPS-only', () => {
  assert.equal(typeof release.amonetArchiveUrl, 'function');
  assert.equal(release.amonetArchiveUrl('https://mirror.example/amonet/', 'amonet-biscuit-v2.0.0.zip'),
    'https://mirror.example/amonet/amonet-biscuit-v2.0.0.zip');
  assert.throws(() => release.amonetArchiveUrl('http://mirror.example/amonet', 'amonet-biscuit-v2.0.0.zip'), /HTTPS|secure/i);
  assert.throws(() => release.amonetArchiveUrl('https://mirror.example', '../other.zip'), /archive|name|invalid/i);
});

const stable = (tag, publishedAt, extra = {}) => ({ tag, publishedAt, kind: 'stable', prerelease: false, assets: [], ...extra });

test('the latest stable is the highest version, never a later-published 0.13.x bridge', () => {
  const releases = [
    stable('radar-puffin-v0.13.21', '2026-10-20T00:00:00Z'),
    stable('radar-puffin-v0.14.0', '2026-10-16T00:00:00Z'),
    stable('radar-puffin-v0.13.20', '2026-10-01T00:00:00Z'),
  ];
  assert.equal(release.pickLatestStable(releases).tag, 'radar-puffin-v0.14.0');
  assert.equal(release.pickLatestStable(releases.filter((r) => r.tag !== 'radar-puffin-v0.14.0')), null,
    'a retired release must never be selected, even when it is the only stable one');
});

test('stable selection compares versions numerically, not by date or string', () => {
  const releases = [
    stable('radar-puffin-v0.14.2', '2026-12-01T00:00:00Z'),
    stable('radar-puffin-v0.14.10', '2026-11-01T00:00:00Z'),
    stable('radar-puffin-v0.15.0', '2026-10-01T00:00:00Z', { prerelease: true }),
    { tag: 'radar-puffin-nightly-abc', publishedAt: '2027-01-01T00:00:00Z', kind: 'development', prerelease: true, assets: [] },
  ];
  assert.equal(release.pickLatestStable(releases).tag, 'radar-puffin-v0.14.10');
});

test('the retired-version notion matches the dl.libreecho.org Worker (0.0.x to 0.13.x)', () => {
  for (const tag of ['radar-puffin-v0.0.1', 'radar-puffin-v0.9.9', 'radar-puffin-v0.13.0', 'radar-puffin-v0.13.21']) {
    assert.equal(release.isRetiredTag(tag), true, tag);
  }
  for (const tag of ['radar-puffin-v0.14.0', 'radar-puffin-v0.130.0', 'radar-puffin-v1.0.0', 'radar-puffin-v1.13.0',
    'radar-puffin-nightly-013', 'radar-puffin-build-0130']) {
    assert.equal(release.isRetiredTag(tag), false, tag);
  }
});

test('the release index never lists retired 0.13.x releases', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [
    { tag_name: 'radar-puffin-v0.13.21', published_at: '2026-10-20T00:00:00Z', assets: [] },
    { tag_name: 'radar-puffin-v0.14.0', published_at: '2026-10-16T00:00:00Z', assets: [] },
  ] });
  try {
    const releases = await fetchReleaseIndex();
    assert.deepEqual(releases.map((r) => r.tag), ['radar-puffin-v0.14.0']);
  } finally { globalThis.fetch = previous; }
});
