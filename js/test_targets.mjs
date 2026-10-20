import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  targetsForRelease, targetForBoard, parseTargetsJson, inventoryNamesForTarget,
  requiredMembersForTarget, nameBelongsToTarget, parseBundleManifest, offeredBoards,
  releaseDeclaresTargets, targetsAssetName, isStableReleaseTag,
} from './targets.js';
import { fetchReleaseBundle, fetchTargetsJson } from './auto-fetch.js';
import { sha256Blob } from './sha256.js';
import { formatSize, formatDuration, computeEta, summariseProgress } from './progress.js';
import { combinedFixture, hashBytes, REAL_TAG, REAL_INVENTORY } from './combined-fixture.mjs';

const LEGACY_TAG = 'radar-puffin-build-bb79646-4f32d15c721c8c85-b79745773b3f5ff7';
const blob = value => { const file = new Blob([value]); file.name = value; return file; };

function fetcherFor(fixture, calls = []) {
  return async url => {
    calls.push(String(url));
    const name = decodeURIComponent(String(url).split('/').pop());
    return fixture.bytes.has(name) ? new Response(fixture.bytes.get(name)) : new Response('missing', { status: 404 });
  };
}
const releaseFor = fixture => ({ tag: fixture.tag, assets: fixture.assets, kind: 'development', prerelease: true, publishedAt: '2026-10-01T00:00:00Z' });

// --- target discovery -------------------------------------------------------

test('a combined release is discovered from targets.json and a legacy release stays Radar-only', () => {
  const f = combinedFixture();
  const combined = targetsForRelease({ tag: f.tag, targetsJson: f.targetsJson });
  assert.deepEqual(combined.map(t => t.board), ['radar_puffin', 'biscuit']);
  assert.equal(combined.find(t => t.board === 'biscuit').prefix, f.biscuitPrefix);
  assert.equal(combined.find(t => t.board === 'radar_puffin').prefix, `libreecho-${f.tag}`);
  assert.equal(combined.every(t => t.legacy === false), true);

  const legacy = targetsForRelease({ tag: LEGACY_TAG });
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].board, 'radar_puffin');
  assert.equal(legacy[0].prefix, `libreecho-${LEGACY_TAG}`);
  assert.equal(legacy[0].legacy, true);
});

test('targets.json is validated and a missing board is refused', () => {
  const f = combinedFixture();
  assert.throws(() => parseTargetsJson('not json'), /JSON/i);
  assert.throws(() => parseTargetsJson(JSON.stringify({ schema: 'other' })), /schema/i);
  assert.throws(() => parseTargetsJson(JSON.stringify({ schema: 'libreecho-combined-release-v1', release: f.tag, targets: [] })), /no targets/i);
  assert.throws(() => parseTargetsJson(JSON.stringify({ schema: 'libreecho-combined-release-v1', release: f.tag,
    targets: [{ board: 'unknown', prefix: 'x' }] })), /unknown board/i);
  const radarOnly = JSON.parse(f.targetsJson);
  radarOnly.targets = radarOnly.targets.filter(entry => entry.board === 'radar_puffin');
  assert.throws(() => targetForBoard({ tag: f.tag, board: 'biscuit', targetsJson: JSON.stringify(radarOnly) }), /does not offer/i);
  // A release without targets.json offers only Radar.
  assert.throws(() => targetForBoard({ tag: f.tag, board: 'biscuit', targetsJson: null }), /does not offer/i);
});

test('offeredBoards drives what the UI shows for each layout', () => {
  const f = combinedFixture();
  assert.deepEqual(offeredBoards({ tag: f.tag, assets: f.assets }), ['radar_puffin', 'biscuit']);
  assert.deepEqual(offeredBoards({ tag: LEGACY_TAG, assets: [{ name: 'x' }] }), ['radar_puffin']);
  assert.equal(releaseDeclaresTargets({ tag: f.tag, assets: f.assets }), true);
  assert.equal(releaseDeclaresTargets({ tag: LEGACY_TAG, assets: [{ name: 'x' }] }), false);
  assert.equal(targetsAssetName(f.tag), `libreecho-${f.tag}-targets.json`);
});

test('combined listing without Dot recovery inventory does not offer Dot', () => {
  const f = combinedFixture();
  assert.deepEqual(offeredBoards({ tag: f.tag, assets: f.assets.filter(a => a.name !== REAL_INVENTORY.biscuit.recovery) }), ['radar_puffin']);
});
test('combined target prefix cannot point at another board namespace', () => {
  const f = combinedFixture(); const data = JSON.parse(f.targetsJson);
  data.targets.find(t => t.board === 'biscuit').prefix = 'libreecho-radar-puffin-other';
  assert.throws(() => parseTargetsJson(JSON.stringify(data)), /prefix/);
});
test('combined recovery manifest requires exactly the selected identity', () => {
  const f = combinedFixture(); const target = targetForBoard({ tag: f.tag, board: 'biscuit', targetsJson: f.targetsJson });
  for (const text of ['', 'target=biscuit\ndevice=biscuit', 'target=biscuit\ndevice=biscuit\nfastboot_products=BISCUIT,RADAR', 'target=radar_puffin\ntarget=biscuit\ndevice=biscuit\nfastboot_products=BISCUIT']) {
    assert.throws(() => parseBundleManifest(text, target), /identity|target|manifest|product|duplicate/i);
  }
});

// --- per-target names -------------------------------------------------------

test('per-target required members use the real combined and legacy names', () => {
  const f = combinedFixture();
  const [radar, biscuit] = targetsForRelease({ tag: f.tag, targetsJson: f.targetsJson });

  const biscuitReq = requiredMembersForTarget(biscuit);
  assert.ok(biscuitReq.normal.includes(`${f.biscuitPrefix}-boot.img`));
  assert.ok(biscuitReq.normal.includes(`${f.biscuitPrefix}-feature-plan.json`));
  assert.ok(biscuitReq.normal.includes(`${f.biscuitPrefix}-tts.squashfs`));
  assert.ok(biscuitReq.normal.includes(`${f.biscuitPrefix}.ota.tar`));
  assert.deepEqual(biscuitReq.recovery, ['libreecho-biscuit-install.zip', 'libreecho-biscuit-bundle.manifest']);
  assert.deepEqual(inventoryNamesForTarget({ tag: f.tag, target: biscuit }), {
    normal: REAL_INVENTORY.biscuit.normal, recovery: [REAL_INVENTORY.biscuit.recovery],
  });

  const radarReq = requiredMembersForTarget(radar);
  assert.ok(radarReq.normal.includes(`${f.radarPrefix}-assistant.manifest.json`));
  assert.deepEqual(radarReq.recovery, ['libreecho-radar-puffin-install.zip', 'libreecho-radar-puffin-bundle.manifest']);
  assert.deepEqual(inventoryNamesForTarget({ tag: f.tag, target: radar }), {
    normal: REAL_INVENTORY.radar_puffin.normal, recovery: [REAL_INVENTORY.radar_puffin.recovery],
  });

  const legacy = requiredMembersForTarget(targetsForRelease({ tag: LEGACY_TAG })[0]);
  assert.ok(legacy.normal.includes(`libreecho-${LEGACY_TAG}-boot.img`));
  assert.deepEqual(legacy.recovery, ['libreecho-install.zip', 'bundle.manifest']);
  assert.deepEqual(inventoryNamesForTarget({ tag: LEGACY_TAG, target: targetsForRelease({ tag: LEGACY_TAG })[0] }), {
    normal: `libreecho-${LEGACY_TAG}-SHA256SUMS`, recovery: [`libreecho-${LEGACY_TAG}-TWRPINSTALL-SHA256SUMS`],
  });
});

test('a target namespace never claims another board\'s asset', () => {
  const f = combinedFixture();
  const [radar, biscuit] = targetsForRelease({ tag: f.tag, targetsJson: f.targetsJson });
  assert.equal(nameBelongsToTarget(`${f.biscuitPrefix}-boot.img`, biscuit), true);
  assert.equal(nameBelongsToTarget('libreecho-biscuit-install.zip', biscuit), true);
  assert.equal(nameBelongsToTarget('libreecho-radar-puffin-base-airplay2-x.payload.squashfs', biscuit), false);
  assert.equal(nameBelongsToTarget('libreecho-biscuit-install.zip', radar), false);
  assert.equal(nameBelongsToTarget('libreecho-install.zip', radar), true, 'legacy alias must stay Radar-owned');
});

// --- cross-target / conflicting / digest checks -----------------------------

test('the chosen target downloads only its own assets and verifies them', async () => {
  const f = combinedFixture();
  const calls = [];
  const bundle = await fetchReleaseBundle(releaseFor(f), {
    board: 'biscuit', targetsJson: f.targetsJson, mirrorBase: 'https://mirror.example/mirror', fetcher: fetcherFor(f, calls),
  });
  assert.equal(bundle.target.board, 'biscuit');
  assert.equal(bundle.target.prefix, f.biscuitPrefix);
  const names = new Set(bundle.files.map(file => file.name));
  for (const name of f.normalNames.biscuit) assert.ok(names.has(name), name);
  for (const name of f.recoveryNames.biscuit) assert.ok(names.has(name), name);
  const radarAssets = new Set([...f.normalNames.radar_puffin, ...f.recoveryNames.radar_puffin]);
  assert.ok(![...names].some(name => radarAssets.has(name)), 'Radar assets were fetched for a Dot build');
  assert.ok(bundle.totalBytes > 0 && bundle.fileCount === names.size);
  assert.ok(!calls.some(url => radarAssets.has(decodeURIComponent(url.split('/').pop()))), `Radar asset requested: ${calls.join(', ')}`);
  await bundle.dispose();
});

test('a foreign asset smuggled into the target inventory is refused', async () => {
  const f = combinedFixture();
  const normalName = REAL_INVENTORY.biscuit.normal;
  const radarAsset = [...f.bytes.keys()].find(name => name.startsWith('libreecho-radar-puffin-base-'));
  f.bytes.set(normalName, `${f.bytes.get(normalName)}\n${'c'.repeat(64)}  ${radarAsset}`);
  const asset = f.assets.find(a => a.name === normalName);
  asset.digest = `sha256:${hashBytes(f.bytes.get(normalName))}`;
  asset.size = Buffer.byteLength(f.bytes.get(normalName));
  await assert.rejects(fetchReleaseBundle(releaseFor(f), {
    board: 'biscuit', targetsJson: f.targetsJson, mirrorBase: 'https://m', fetcher: fetcherFor(f),
  }), /another target/i);
});

test('conflicting checksum listings fail closed', async () => {
  const f = combinedFixture();
  const recoveryName = REAL_INVENTORY.biscuit.recovery;
  const bootimg = `${f.biscuitPrefix}-boot.img`;
  f.bytes.set(recoveryName, `${f.bytes.get(recoveryName)}\n${'f'.repeat(64)}  ${bootimg}`);
  const asset = f.assets.find(a => a.name === recoveryName);
  asset.digest = `sha256:${hashBytes(f.bytes.get(recoveryName))}`;
  asset.size = Buffer.byteLength(f.bytes.get(recoveryName));
  await assert.rejects(fetchReleaseBundle(releaseFor(f), {
    board: 'biscuit', targetsJson: f.targetsJson, mirrorBase: 'https://m', fetcher: fetcherFor(f),
  }), /conflicting/i);
});

test('a published digest that disagrees with the listing fails before download', async () => {
  const f = combinedFixture();
  const target = `${f.biscuitPrefix}-boot.img`;
  f.assets.find(a => a.name === target).digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(fetchReleaseBundle(releaseFor(f), {
    board: 'biscuit', targetsJson: f.targetsJson, mirrorBase: 'https://m', fetcher: fetcherFor(f),
  }), /digest differs|digest mismatch|API digest/i);
});

test('the combined descriptor is fetched and digest-checked', async () => {
  const f = combinedFixture();
  const text = await fetchTargetsJson(releaseFor(f), { mirrorBase: 'https://m', fetcher: fetcherFor(f) });
  assert.equal(text, f.targetsJson);
  const bad = combinedFixture();
  bad.assets.find(a => a.name === targetsAssetName(bad.tag)).digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(fetchTargetsJson(releaseFor(bad), { mirrorBase: 'https://m', fetcher: fetcherFor(bad) }), /digest/i);
});

test('a Dot bundle manifest is refused for a Radar target', () => {
  const f = combinedFixture();
  const [radar] = targetsForRelease({ tag: f.tag, targetsJson: f.targetsJson });
  assert.throws(() => parseBundleManifest(f.bytes.get('libreecho-biscuit-bundle.manifest'), radar),
    /describes biscuit|not radar_puffin/i);
  assert.doesNotThrow(() => parseBundleManifest(f.bytes.get('libreecho-biscuit-bundle.manifest'),
    targetsForRelease({ tag: f.tag, targetsJson: f.targetsJson })[1]));
});

// --- progress arithmetic ----------------------------------------------------

test('progress bytes/percent/file-count/ETA arithmetic is correct', () => {
  assert.equal(formatSize(718 * 1048576), '718 MB');
  assert.equal(formatSize(11.4 * 1048576), '11.4 MB');
  assert.equal(formatSize(512 * 1024), '512 KB');
  assert.equal(formatSize(0), '0 MB');
  assert.equal(formatDuration(1500), '2s');
  assert.equal(formatDuration(65000), '1m 05s');
  assert.equal(computeEta({ done: 50, total: 100, elapsedMs: 1000 }), 1000);
  assert.equal(computeEta({ done: 100, total: 100, elapsedMs: 1000 }), 0);
  assert.equal(computeEta({ done: 0, total: 100, elapsedMs: 1000 }), null);
  assert.equal(computeEta({ done: 10, total: 0, elapsedMs: 1000 }), null);

  const summary = summariseProgress([
    { phase: 'preparing', done: 0, total: 0, index: 0, count: 0 },
    { phase: 'downloading', done: 30, total: 120, index: 2, count: 8 },
    { phase: 'downloading', done: 120, total: 120, index: 8, count: 8 },
    { phase: 'complete', done: 120, total: 120, index: 8, count: 8 },
  ]);
  assert.equal(summary.percent, 100);
  assert.equal(summary.done, 120);
  assert.equal(summary.total, 120);
  assert.equal(summary.index, 8);
  assert.equal(summary.count, 8);
  assert.equal(summary.phase, 'complete');
});

test('download events carry a monotonically growing done total and a final 100%', async () => {
  const f = combinedFixture();
  const events = [];
  const bundle = await fetchReleaseBundle(releaseFor(f), {
    board: 'radar_puffin', targetsJson: f.targetsJson, mirrorBase: 'https://m',
    fetcher: fetcherFor(f), onEvent: event => events.push(event),
  });
  const downloading = events.filter(event => event.phase === 'downloading');
  assert.ok(downloading.length > 0);
  for (let i = 1; i < downloading.length; i += 1) {
    const previous = downloading[i - 1];
    const current = downloading[i];
    assert.ok(current.done >= (current.index === previous.index ? previous.done : 0), 'done went backwards within a file');
  }
  const complete = events.at(-1);
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.done, bundle.totalBytes);
  assert.equal(complete.total, bundle.totalBytes);
  const summary = summariseProgress(events);
  assert.equal(summary.percent, 100);
  assert.equal(summary.count, bundle.fileCount);
  await bundle.dispose();
});

// --- bounded-memory hashing -------------------------------------------------

test('hashing streams a Blob in bounded chunks and never calls whole-blob arrayBuffer/text', async () => {
  const size = 10;
  let rootArrayBuffer = 0, rootText = 0, slices = 0;
  const fake = {
    size,
    slice(start, end) {
      slices += 1;
      return { size: end - start, arrayBuffer: async () => new Uint8Array(end - start) };
    },
    arrayBuffer() { rootArrayBuffer += 1; throw new Error('whole-blob arrayBuffer() used'); },
    text() { rootText += 1; throw new Error('whole-blob text() used'); },
  };
  const digest = await sha256Blob(fake, { chunkSize: 4 });
  assert.equal(rootArrayBuffer, 0, 'hashing read the whole Blob into one buffer');
  assert.equal(rootText, 0);
  assert.ok(slices >= 3, `expected chunked slices, got ${slices}`);
  assert.equal(digest, createHash('sha256').update(Buffer.alloc(size)).digest('hex'));
});

// --- stable releases do not publish the dev-only verification report --------

// Member names (no hashes) of the published radar-puffin-v0.14.2 inventories.
const STABLE_0142_RADAR_NORMAL = ["libreecho-radar-puffin-base-airplay2-3583f5346d44bad33e1747020f75bdc86582deb0c55e1526b7269a097a67ed8a.payload.squashfs", "libreecho-radar-puffin-base-airplay2-dde7fa448e1bee553f06a05a624415d40d03775e28048b5cdfc91be595ad9cc0.manifest.json", "libreecho-radar-puffin-base-assistant-133101d270bcda2cd8332b4cb8d229a5562dff6f1179ea2b091c18732277bc80.payload.squashfs", "libreecho-radar-puffin-base-assistant-d6f45c424b326dd87ac4d24fefe9c2e46252e25d5bc350626802261520af79d6.manifest.json", "libreecho-radar-puffin-base-stt-21820516c0dc831f24037f982ea73e09344e738aaa6c8ec2ea19f994ebc7178f.manifest.json", "libreecho-radar-puffin-base-stt-6c1e866b364f1c06548ace326d8748d1a7f28a7488669627019bf99f9137e856.payload.squashfs", "libreecho-radar-puffin-base-tts-66022599c1a695bddce2ad4ebe812ec2185bd9589ca9a6f37577eccc59379252.manifest.json", "libreecho-radar-puffin-base-tts-a9defee502d10da24144407a23acbd3ba3db6e323823922cbf34eb32f802cabc.payload.squashfs", "libreecho-radar-puffin-base-wakeword-8f4e6318d683316266e238bef51ebb820722a25494297548817c97fb6a402ef8.payload.squashfs", "libreecho-radar-puffin-base-wakeword-affd75af145391cfcc883445185ead96cb429b0299dd1c5e0b89894d9271411a.manifest.json", "libreecho-radar-puffin-release-completeness.json", "libreecho-radar-puffin-stable.ota.tar", "libreecho-radar-puffin-v0.14.2-airplay2.manifest.json", "libreecho-radar-puffin-v0.14.2-airplay2.squashfs", "libreecho-radar-puffin-v0.14.2-assistant.manifest.json", "libreecho-radar-puffin-v0.14.2-assistant.squashfs", "libreecho-radar-puffin-v0.14.2-boot.img", "libreecho-radar-puffin-v0.14.2-build.json", "libreecho-radar-puffin-v0.14.2-feature-assets.json", "libreecho-radar-puffin-v0.14.2-feature-plan.json", "libreecho-radar-puffin-v0.14.2-initial-install.tar", "libreecho-radar-puffin-v0.14.2-installer.py", "libreecho-radar-puffin-v0.14.2-ota-public-key.hex", "libreecho-radar-puffin-v0.14.2-release-notes.md", "libreecho-radar-puffin-v0.14.2-run-one-shot.sh", "libreecho-radar-puffin-v0.14.2-stt.manifest.json", "libreecho-radar-puffin-v0.14.2-stt.squashfs", "libreecho-radar-puffin-v0.14.2-tts.manifest.json", "libreecho-radar-puffin-v0.14.2-tts.squashfs", "libreecho-radar-puffin-v0.14.2-wakeword.manifest.json", "libreecho-radar-puffin-v0.14.2-wakeword.squashfs", "libreecho-radar-puffin-v0.14.2.ota.tar"];
const STABLE_0142_BISCUIT_NORMAL = ["libreecho-biscuit-base-airplay2-3583f5346d44bad33e1747020f75bdc86582deb0c55e1526b7269a097a67ed8a.payload.squashfs", "libreecho-biscuit-base-airplay2-dde7fa448e1bee553f06a05a624415d40d03775e28048b5cdfc91be595ad9cc0.manifest.json", "libreecho-biscuit-base-assistant-133101d270bcda2cd8332b4cb8d229a5562dff6f1179ea2b091c18732277bc80.payload.squashfs", "libreecho-biscuit-base-assistant-d6f45c424b326dd87ac4d24fefe9c2e46252e25d5bc350626802261520af79d6.manifest.json", "libreecho-biscuit-base-stt-21820516c0dc831f24037f982ea73e09344e738aaa6c8ec2ea19f994ebc7178f.manifest.json", "libreecho-biscuit-base-stt-6c1e866b364f1c06548ace326d8748d1a7f28a7488669627019bf99f9137e856.payload.squashfs", "libreecho-biscuit-base-tts-66022599c1a695bddce2ad4ebe812ec2185bd9589ca9a6f37577eccc59379252.manifest.json", "libreecho-biscuit-base-tts-a9defee502d10da24144407a23acbd3ba3db6e323823922cbf34eb32f802cabc.payload.squashfs", "libreecho-biscuit-base-wakeword-8f4e6318d683316266e238bef51ebb820722a25494297548817c97fb6a402ef8.payload.squashfs", "libreecho-biscuit-base-wakeword-affd75af145391cfcc883445185ead96cb429b0299dd1c5e0b89894d9271411a.manifest.json", "libreecho-biscuit-release-completeness.json", "libreecho-biscuit-stable.ota.tar", "libreecho-biscuit-v0.14.2-airplay2.manifest.json", "libreecho-biscuit-v0.14.2-airplay2.squashfs", "libreecho-biscuit-v0.14.2-assistant.manifest.json", "libreecho-biscuit-v0.14.2-assistant.squashfs", "libreecho-biscuit-v0.14.2-boot.img", "libreecho-biscuit-v0.14.2-build.json", "libreecho-biscuit-v0.14.2-feature-assets.json", "libreecho-biscuit-v0.14.2-feature-plan.json", "libreecho-biscuit-v0.14.2-initial-install.tar", "libreecho-biscuit-v0.14.2-installer.py", "libreecho-biscuit-v0.14.2-ota-public-key.hex", "libreecho-biscuit-v0.14.2-release-notes.md", "libreecho-biscuit-v0.14.2-run-one-shot.sh", "libreecho-biscuit-v0.14.2-stt.manifest.json", "libreecho-biscuit-v0.14.2-stt.squashfs", "libreecho-biscuit-v0.14.2-tts.manifest.json", "libreecho-biscuit-v0.14.2-tts.squashfs", "libreecho-biscuit-v0.14.2-wakeword.manifest.json", "libreecho-biscuit-v0.14.2-wakeword.squashfs", "libreecho-biscuit-v0.14.2.ota.tar"];
const STABLE_0142_TARGETS = JSON.stringify({
  schema: 'libreecho-combined-release-v1',
  release: 'radar-puffin-v0.14.2',
  targets: [
    { board: 'radar_puffin', prefix: 'libreecho-radar-puffin-v0.14.2', target_descriptor_sha256: 'a'.repeat(64) },
    { board: 'biscuit', prefix: 'libreecho-biscuit-v0.14.2', target_descriptor_sha256: 'b'.repeat(64) },
  ],
});

test('stable releases do not require the dev-only verification report', () => {
  assert.equal(isStableReleaseTag('radar-puffin-v0.14.2'), true);
  assert.equal(isStableReleaseTag(REAL_TAG), false);
  assert.equal(isStableReleaseTag('radar-puffin-nightly-20261020'), false);
  const [radar, biscuit] = targetsForRelease({ tag: 'radar-puffin-v0.14.2', targetsJson: STABLE_0142_TARGETS });
  for (const target of [radar, biscuit]) {
    assert.equal(target.stable, true);
    assert.ok(!requiredMembersForTarget(target).normal.some(n => n.endsWith('-verification.txt')),
      `${target.board} stable target must not require verification.txt`);
  }
  // Regression: every required member is listed by the real 0.14.2 inventories
  // (the browser installer refused 0.14.2 with "missing from the normal
  // checksum inventory" for -verification.txt).
  const radarListed = new Set(STABLE_0142_RADAR_NORMAL);
  for (const name of requiredMembersForTarget(radar).normal) assert.ok(radarListed.has(name), `${name} listed in 0.14.2 radar inventory`);
  const biscuitListed = new Set(STABLE_0142_BISCUIT_NORMAL);
  for (const name of requiredMembersForTarget(biscuit).normal) assert.ok(biscuitListed.has(name), `${name} listed in 0.14.2 biscuit inventory`);
  // Legacy (no targets.json) stable resolution follows the same rule.
  const legacy = targetsForRelease({ tag: 'radar-puffin-v0.14.2' })[0];
  assert.equal(legacy.stable, true);
  assert.ok(!requiredMembersForTarget(legacy).normal.some(n => n.endsWith('-verification.txt')));
});

test('development builds still require the verification report', () => {
  const f = combinedFixture();
  for (const target of targetsForRelease({ tag: f.tag, targetsJson: f.targetsJson })) {
    assert.equal(target.stable, false);
    assert.ok(requiredMembersForTarget(target).normal.includes(`${target.prefix}-verification.txt`));
  }
  const legacy = targetsForRelease({ tag: REAL_TAG })[0];
  assert.ok(requiredMembersForTarget(legacy).normal.includes(`libreecho-${REAL_TAG}-verification.txt`));
});
