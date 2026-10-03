import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requiredBundleMembers } from './profiles.js';
import { completeFixture } from './bundle-fixture.mjs';
import { combinedFixture } from './combined-fixture.mjs';

class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.queryNodes = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = { add() {}, remove() {} };
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
  }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
  remove() {}
}
const elements = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  },
  createElement: () => new Element(),
};
globalThis.window = { isSecureContext: false, location: { search: '' } };
const app = await import('./app.js');
test('Run is disabled until a compatible published bundle and device are verified', () => {
  assert.equal(elements.get('btn-run').disabled, true);
});
const payload = new Uint8Array([1, 2, 3]);
const digest = createHash('sha256').update(payload).digest('hex');
const profile = {
  id: 'biscuit', product: 'BISCUIT', marketing: 'Dot', board: 'biscuit',
  libreEcho: 'bring-up planned, no shipped image', userdataContractSectors: [2137088],
  lkBuildMap: { '63cb91b-20221007_072309': { payload: 'test.img', size: 3, sha256: digest } },
};
const setup = (writes) => {
  assert.ok(app.state && app.runInstall, 'app must expose its actual run state for device-free page tests');
  app.state.release = { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' };
  app.state.sums = new Map([['libreecho-radar-puffin-v0.14.0-boot.img', digest]]);
  app.state.identity = { product: 'BISCUIT', unlockStatus: 'false', profile,
    lkBuild: '63cb91b-20221007_072309', serialRaw: 'TEST-DOT' };
  app.state.fastboot = { client: { flash: async (...args) => { writes.push(args); throw new Error('test transport'); } } };
  app.state.payloadBytes = payload;
  app.state.payloadName = 'test.img';
  app.state.files = new Map();
  app.state.adb = null;
  app.state.recoverySerial = null;
  app.state.kaeruHeader = null;
  app.state.running = false;
  app.state.target = null;
  app.state.targetsJson = null;
  app.state.bundleReady = false;
  app.state.bundleBoard = null;
  app.state.bundleHardwareAccepted = false;
  // The browser is v2-only: a verified protocol-2 plan is required before unlock.
  app.state.installProtocol = 2;
  app.state.directHelper = null;
  app.state.directManifestText = null;
  app.state.directManifestSha = null;
  app.state.directRoles = null;
  app.state.directTransferTotal = null;
  app.state.directRelease = null;
};

test('Query Device uses only targeted getvars and shows local model/full serial without logging it', async () => {
  assert.equal(typeof app.queryDevice, 'function');
  const requested = [];
  const forbidden = [];
  const values = { product: 'BISCUIT', unlock_status: 'false', lk_build_desc: '63cb91b-20221007_072309',
    pl_build_desc: 'bd7ae89-20221003_215949', 'max-download-size': '0x6d00000',
    serialno: 'TEST-DOT-FULL-SERIAL', secure: 'yes', rpmb_state: '1' };
  const client = {
    getVar: async (key) => { requested.push(key); return values[key] ?? ''; },
    flash: async () => { forbidden.push('flash'); },
    erase: async () => { forbidden.push('erase'); },
  };
  const before = app.terminal.lines.length;
  const identity = await app.queryDevice({ open: async () => ({
    device: { vendorId: 0x0bb4, productId: 0x0c01, productName: 'Android' }, client,
  }) });
  assert.equal(identity.profile.marketing, 'Amazon Echo Dot 2nd Generation (2016)');
  assert.equal(identity.serialRaw, values.serialno);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(requested, ['product', 'unlock_status', 'lk_build_desc', 'pl_build_desc',
    'max-download-size', 'serialno', 'secure', 'rpmb_state']);
  const panelRows = elements.get('device-panel').children.map((row) => [
    row.querySelector('span').textContent, row.querySelector('strong').textContent,
  ]);
  assert.ok(panelRows.some(([label, value]) => label === 'model' && value.includes('Echo Dot')));
  assert.ok(panelRows.some(([label, value]) => label === 'USB serial' && value === values.serialno));
  assert.equal(app.terminal.lines.slice(before).some((line) => line.textContent.includes(values.serialno)), false);
});

test('querying another device clears a previously selected Amonet payload', async () => {
  assert.equal(typeof app.queryDevice, 'function');
  app.state.payloadBytes = new Uint8Array([1, 2, 3]);
  app.state.payloadName = 'old.img';
  const client = { getVar: async (key) => ({ product: 'BISCUIT', unlock_status: 'false',
    lk_build_desc: '63cb91b-20221007_072309', serialno: 'NEW-DOT' }[key] ?? '') };
  await app.queryDevice({ open: async () => ({ device: { vendorId: 0x0bb4, productId: 0x0c01 }, client }) });
  assert.equal(app.state.payloadBytes, null);
  assert.equal(app.state.payloadName, '');
});

test('a pinned Amonet ZIP selects the matching payload without USB writes', async () => {
  assert.equal(typeof app.loadAmonetArchive, 'function');
  const writes = [];
  setup(writes);
  const tiny = new Uint8Array([1, 2, 3]);
  const tinyProfile = { ...profile,
    archive: { name: 'amonet-biscuit-v2.0.0.zip', size: 3, sha256: 'a'.repeat(64) },
    lkBuildMap: { '63cb91b-20221007_072309': { payload: 'fastbrick-20221007.img',
      size: 3, sha256: digest } } };
  app.state.identity.profile = tinyProfile;
  const calls = [];
  const file = { name: tinyProfile.archive.name, size: tinyProfile.archive.size };
  await app.loadAmonetArchive({ file, acquire: async (args) => {
    calls.push(args);
    return { bytes: tiny, source: 'local pinned ZIP' };
  } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].archiveBlob, file);
  assert.equal(calls[0].archiveSha256, tinyProfile.archive.sha256);
  assert.equal(calls[0].archiveSize, tinyProfile.archive.size);
  assert.equal(calls[0].memberPath, 'amonet/bin/fastbrick-20221007.img');
  assert.equal(calls[0].payloadSha256, digest);
  assert.equal(app.state.payloadName, 'fastbrick-20221007.img');
  assert.deepEqual(app.state.payloadBytes, tiny);
  assert.deepEqual(writes, []);
});

test('an unpinned Amonet archive is refused before extraction', async () => {
  assert.equal(typeof app.loadAmonetArchive, 'function');
  setup([]);
  app.state.identity.profile = { ...profile,
    archive: { name: 'amonet-biscuit-v2.0.0.zip', size: 3, sha256: 'a'.repeat(64) } };
  let invoked = false;
  await assert.rejects(app.loadAmonetArchive({ file: { name: 'wrong.zip', size: 3 },
    acquire: async () => { invoked = true; } }), /archive|name|pinned/i);
  assert.equal(invoked, false);
});

test('advanced raw payload selection refuses a same-name hash mismatch and clears old bytes', async () => {
  assert.equal(typeof app.loadPayload, 'function');
  setup([]);
  app.state.identity.profile = { ...profile, lkBuildMap: { '63cb91b-20221007_072309': {
    payload: 'test.img', size: 3, sha256: digest } } };
  app.state.payloadBytes = new Uint8Array([1, 2, 3]);
  app.state.payloadName = 'test.img';
  const file = new Blob([new Uint8Array([4, 5, 6])]);
  file.name = 'test.img';
  await assert.rejects(app.loadPayload(file), /hash|digest|pinned|mismatch/i);
  assert.equal(app.state.payloadBytes, null);
  assert.equal(app.state.payloadName, '');
});

test('the page rehearsal never submits brick even with a valid selected payload', async () => {
  const writes = [];
  setup(writes);
  await app.runInstall({ dryRun: true });
  assert.deepEqual(writes, [], 'Rehearse submitted an unlock write');
  assert.ok(app.terminal.plainText().includes('rehearsal'), `the actual UI path was not exercised: ${app.terminal.plainText()}`);
});

test('rehearsal without a connected device never opens WebUSB', async () => {
  const writes = [];
  setup(writes);
  app.state.identity = null;
  const before = app.terminal.lines.length;
  await app.runInstall({ dryRun: true });
  assert.deepEqual(writes, []);
  const latest = app.terminal.lines.slice(before).map((line) => line.textContent).join('\n');
  assert.match(latest, /host-only rehearsal complete/i);
  assert.doesNotMatch(latest, /device connection failed|WebUSB/i);
});

test('rehearsal with no selected checksums reports a local preflight, not a release fetch error', async () => {
  const writes = [];
  setup(writes);
  app.state.sums = null;
  app.state.identity = null;
  const before = app.terminal.lines.length;
  await app.runInstall({ dryRun: true });
  const latest = app.terminal.lines.slice(before).map((line) => line.textContent).join('\n');
  assert.deepEqual(writes, []);
  assert.match(latest, /select.*bundle|bundle.*not.*verified/i);
  assert.match(latest, /host-only rehearsal complete/i);
  assert.doesNotMatch(latest, /Failed to fetch|github.com\/.*releases\/download/);
});

test('the page refuses a Radar release on BISCUIT before unlock', async () => {
  const writes = [];
  setup(writes);
  await app.runInstall({ dryRun: false });
  assert.deepEqual(writes, [], 'wrong-board release reached flash:brick');
  assert.match(app.terminal.plainText(), /wrong-board|release board mismatch|no qualified Biscuit image/i);
});

test('a complete bundle without hardware-acceptance metadata cannot unlock', async () => {
  const writes = [];
  setup(writes);
  app.state.identity.profile = { ...profile, id: 'radar', board: 'radar_puffin' };
  app.state.identity.product = 'RADAR';
  app.state.bundleReady = true;
  app.state.bundleBoard = 'radar_puffin';
  app.state.bundleHardwareAccepted = false;
  await app.runInstall({ dryRun: false });
  assert.deepEqual(writes, [], 'non-hardware-accepted build reached flash:brick');
  assert.match(app.terminal.plainText(), /no hardware-accepted board/i);
});

test('verified same-device recovery resumes without resubmitting brick', async () => {
  const writes = [];
  setup(writes);
  app.state.identity.profile = { ...profile, id: 'radar', board: 'radar_puffin' };
  app.state.identity.product = 'RADAR';
  app.state.bundleReady = true;
  app.state.bundleBoard = 'radar_puffin';
  app.state.bundleHardwareAccepted = true;
  app.state.recoverySerial = app.state.identity.serialRaw;
  app.state.kaeruHeader = '8816885870b203004c4b000000000000';
  app.state.adb = { shell: async (command) => ({ stdout: command.includes('uevent') ? 'PARTNAME=expdb\n'
    : command.includes('/size') ? '20480\n'
      : '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00\n' }) };
  await app.runInstall({ dryRun: false });
  assert.deepEqual(writes, [], 'continuation re-submitted flash:brick');
  assert.match(app.terminal.plainText(), /verified recovery|continuing.*recovery/i);
});

test('changing releases invalidates all verified bundle state', () => {
  const oldRelease = { tag: 'radar-puffin-v0.14.0', assets: [], publishedAt: '2026-09-25T00:00:00Z', kind: 'stable' };
  const newRelease = { tag: 'radar-puffin-v0.14.1', assets: [], publishedAt: '2026-09-26T00:00:00Z', kind: 'stable' };
  app.state.releases = [oldRelease, newRelease];
  app.state.release = oldRelease;
  app.state.sums = new Map([['old', '0'.repeat(64)]]);
  app.state.files = new Map([['old', new Blob(['old'])]]);
  app.state.bundleReady = true;
  app.state.bundleBoard = 'radar_puffin';
  const select = elements.get('release-select');
  select.value = newRelease.tag;
  select.listeners.get('change')();
  assert.equal(app.state.release, newRelease);
  assert.equal(app.state.bundleReady, false);
  assert.equal(app.state.files.size, 0);
  assert.equal(app.state.sums, null);
});

test('refreshing the release list invalidates assets from the previous selection', async () => {
  assert.equal(typeof app.loadReleases, 'function');
  const previousFetch = globalThis.fetch;
  const old = { tag: 'radar-puffin-v0.14.0', assets: [], publishedAt: '2026-09-25T00:00:00Z', kind: 'stable' };
  app.state.release = old;
  app.state.sums = new Map([['old', '0'.repeat(64)]]);
  app.state.files = new Map([['old', new Blob(['old'])]]);
  app.state.bundleReady = true;
  app.state.bundleBoard = 'radar_puffin';
  globalThis.fetch = async () => ({ ok: true, json: async () => [{
    tag_name: 'radar-puffin-v0.14.1', published_at: '2026-09-26T00:00:00Z',
    assets: [], prerelease: false, draft: false,
  }] });
  try {
    await app.loadReleases();
    assert.equal(app.state.release.tag, 'radar-puffin-v0.14.1');
    assert.equal(app.state.bundleReady, false);
      assert.equal(app.state.files.size, 0);
    assert.equal(app.state.sums, null);
  } finally { globalThis.fetch = previousFetch; }
});

test('first-use recovery permission is explicitly requested and serial-checked', async () => {
  assert.equal(typeof app.grantRecovery, 'function');
  setup([]);
  const requested = [];
  const usbDevice = { vendorId: 0x18d1, productId: 0x4ee1 };
  const client = { shell: async (command) => ({ stdout:
    command.includes('ro.twrp.version') ? '3.7.0_9-0\nbiscuit\nTEST-DOT\n'
      : command.includes('uevent') ? 'PARTNAME=expdb\n'
        : command.includes('/size') ? '20480\n'
          : command.includes('od -An') ? '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00\n' : '' }),
    close: async () => {} };
  const session = { device: usbDevice, client };
  await app.grantRecovery({
    // The chooser is now asked for narrow filters rather than a mode name, so the
    // requested argument records the options the page actually passes.
    request: (options) => { requested.push(options); return Promise.resolve(usbDevice); },
    openSession: async () => session,
  });
  assert.deepEqual(requested, [{ serial: 'TEST-DOT' }],
    'the recovery chooser was not asked for the selected device by serial');
  assert.equal(app.state.recoverySerial, 'TEST-DOT');
  assert.equal(app.state.kaeruHeader, '8816885870b203004c4b000000000000');
});

const makeFile = (name, content) => {
  const blob = new Blob([content]);
  blob.name = name;
  return blob;
};
const sha = (content) => createHash('sha256').update(content).digest('hex');
function makeCompleteBundle(tag, { wrongChecksum = false } = {}) {
  if (wrongChecksum) {
    const f = completeFixture(tag);
    f.assets.find(a => a.name.endsWith('-TWRPINSTALL-SHA256SUMS')).digest = `sha256:${'0'.repeat(64)}`;
    return f;
  }
  return completeFixture(tag);
}
test('a complete API-digest-anchored bundle earns readiness', async () => {
  const tag = 'radar-puffin-v0.14.0';
  const { files, assets } = makeCompleteBundle(tag);
  app.state.release = { tag, assets };
  app.state.sums = null;
  app.state.files = new Map();
  app.state.bundleReady = false;
  await app.verifyBundle(files);
  assert.equal(app.state.bundleReady, true, app.terminal.plainText());
  assert.ok(app.state.files.has('libreecho-install.zip'));
  assert.ok(app.state.files.has('bundle.manifest'));
});

test('auto-fetch commits the same verified state as manual including archive metadata', async () => {
  assert.equal(typeof app.fetchBundleAutomatically, 'function');
  const f = completeFixture(); const previous = globalThis.fetch;
  app.state.release = { tag: f.tag, assets: f.assets };
  globalThis.fetch = async url => {
    const name = decodeURIComponent(String(url).split('/').pop());
    return f.bytes.has(name) ? new Response(f.bytes.get(name)) : new Response('', { status: 404 });
  };
  try {
    await app.fetchBundleAutomatically({ mirrorBase: 'https://approved/mirror' });
    assert.equal(app.state.bundleReady, true, app.terminal.plainText());
    const automatic = new Map(app.state.sums);
    for (const name of f.metadata.keys()) assert.ok(app.state.files.has(name));
    await app.verifyBundle(f.files);
    assert.deepEqual(app.state.sums, automatic);
  } finally { globalThis.fetch = previous; }
});

test('manual selection supersedes an in-flight automatic fetch without stale state', async () => {
  const f=completeFixture();const previous=globalThis.fetch;
  app.state.release={tag:f.tag,assets:f.assets};
  let unblock; let requested;
  const started=new Promise(resolve=>{requested=resolve;});
  globalThis.fetch=async () => {requested(); return new Promise(resolve=>{unblock=resolve;});};
  try {
    const downloading=app.fetchBundleAutomatically({mirrorBase:'https://approved/mirror'});
    await started;
    await app.verifyBundle(f.files);
    assert.equal(app.state.bundleReady,true);
    unblock(new Response(f.bytes.get(`libreecho-${f.tag}-SHA256SUMS`)));
    await downloading;
    assert.equal(app.state.bundleReady,true);
    assert.equal(app.state.fetchingBundle,false);
  } finally {globalThis.fetch=previous;}
});

test('auto-fetch without a helper or Pages assets keeps manual selection enabled', async () => {
  const previous = globalThis.fetch;
  app.state.release = completeFixture();
  globalThis.fetch = async () => new Response('', { status: 404 });
  try {
    await app.fetchBundleAutomatically({ mirrorBase: 'http://127.0.0.1:8767/releases' });
    assert.equal(app.state.bundleReady, false);
    assert.equal(app.state.files.size, 0);
    assert.equal(elements.get('btn-bundle').disabled, false);
  } finally { globalThis.fetch = previous; }
});

test('a substituted TWRP checksum inventory cannot earn readiness', async () => {
  const tag = 'radar-puffin-v0.14.0';
  const { files, assets } = makeCompleteBundle(tag, { wrongChecksum: true });
  app.state.release = { tag, assets };
  app.state.sums = null;
  app.state.files = new Map();
  app.state.bundleReady = false;
  await app.verifyBundle(files);
  assert.equal(app.state.bundleReady, false, 'untrusted recovery checksum inventory was accepted');
  assert.match(app.terminal.plainText(), /TWRP.*checksum.*mismatch|TWRP.*digest.*mismatch/i);
});

test('loading the build list never downloads release assets', async () => {
  const urls = [];
  const previousFetch = globalThis.fetch;
  const previousLocation = globalThis.window.location;
  globalThis.window.location = { search: '', href: 'http://127.0.0.1:8799/', origin: 'http://127.0.0.1:8799' };
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.includes('/mirror/health')) return Response.json({ repository: 'aslater3/LibreEcho', mirror: true });
    if (value.includes('api.github.com')) return { ok: true, json: async () => [{
      tag_name: 'radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d', published_at: '2026-10-01T00:00:00Z',
      assets: [
        { name: 'libreecho-radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d-boot.img', size: 10, digest: `sha256:${'a'.repeat(64)}` },
        { name: 'libreecho-radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d-targets.json', size: 10, digest: `sha256:${'b'.repeat(64)}` },
      ],
      prerelease: true, draft: false,
    }] };
    return new Response('', { status: 404 });
  };
  try {
    await app.loadReleases();
    assert.ok(urls.length > 0, 'the build list was not read');
    assert.ok(urls.every((value) => value.includes('api.github.com')),
      `loading the build list downloaded release data: ${urls.join(', ')}`);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.window.location = previousLocation;
  }
});

test('a combined release downloads and verifies only the chosen target (Echo Dot)', async () => {
  const f = combinedFixture();
  const previous = globalThis.fetch;
  const urls = [];
  app.state.release = { tag: f.tag, assets: f.assets, kind: 'development', publishedAt: '2026-10-01T00:00:00Z', prerelease: true };
  app.state.board = 'biscuit';
  app.state.target = null;
  app.state.targetsJson = null;
  globalThis.fetch = async (url) => {
    const value = String(url);
    urls.push(value);
    const name = decodeURIComponent(value.split('/').pop());
    return f.bytes.has(name) ? new Response(f.bytes.get(name)) : new Response('', { status: 404 });
  };
  try {
    await app.fetchBundleAutomatically({ mirrorBase: 'https://approved/mirror', board: 'biscuit' });
    assert.equal(app.state.bundleReady, true, app.terminal.plainText());
    assert.equal(app.state.bundleBoard, 'biscuit');
    assert.equal(app.state.target.board, 'biscuit');
    assert.equal(app.state.bundleHardwareAccepted, true);
    assert.ok(app.state.files.has('libreecho-biscuit-bundle.manifest'));
    assert.ok(app.state.files.has('libreecho-biscuit-install.zip'));
    assert.ok(![...app.state.files.keys()].some((name) => name.startsWith('libreecho-radar-puffin-base')),
      'a Radar asset was fetched for a Dot build');
    const radarAssets = new Set([...f.normalNames.radar_puffin, ...f.recoveryNames.radar_puffin]);
    assert.ok(!urls.some((value) => radarAssets.has(decodeURIComponent(value.split('/').pop()))),
      `a Radar asset was requested: ${urls.join(', ')}`);
  } finally {
    globalThis.fetch = previous;
  }
});

test('a build that is not hardware-accepted verifies but cannot be installed', async () => {
  const f = combinedFixture({ biscuitAccepted: false });
  const previous = globalThis.fetch;
  app.state.release = { tag: f.tag, assets: f.assets, kind: 'development', publishedAt: '2026-10-01T00:00:00Z', prerelease: true };
  app.state.board = 'biscuit';
  app.state.target = null;
  app.state.targetsJson = null;
  globalThis.fetch = async (url) => {
    const name = decodeURIComponent(String(url).split('/').pop());
    return f.bytes.has(name) ? new Response(f.bytes.get(name)) : new Response('', { status: 404 });
  };
  try {
    await app.fetchBundleAutomatically({ mirrorBase: 'https://approved/mirror', board: 'biscuit' });
    assert.equal(app.state.bundleReady, true, app.terminal.plainText());
    assert.equal(app.state.bundleHardwareAccepted, false);
    assert.equal(elements.get('btn-run').disabled, true, 'an unqualified build enabled Run');
    assert.match(app.terminal.plainText(), /not marked hardware-accepted/i);
  } finally {
    globalThis.fetch = previous;
  }
});

// --- manual selection of a combined release --------------------------------

test('a combined release selected by hand resolves the chosen board from the verified descriptor', async () => {
  const f = combinedFixture();
  app.state.release = { tag: f.tag, assets: f.assets };
  app.state.board = 'biscuit';
  app.state.target = null;
  app.state.targetsJson = null;
  app.state.sums = null;
  app.state.files = new Map();
  app.state.bundleReady = false;
  await app.verifyBundle(f.files);
  assert.equal(app.state.bundleReady, true, app.terminal.plainText());
  assert.equal(app.state.target.board, 'biscuit');
  assert.ok(app.state.files.has('libreecho-biscuit-install.zip'));
  assert.ok(![...app.state.files.keys()].some((name) => name.startsWith('libreecho-radar-puffin-base')),
    'a Radar asset was accepted for a Dot manual selection');
});

test('a combined release selected by hand without its descriptor is refused, not treated as legacy Radar', async () => {
  const f = combinedFixture();
  app.state.release = { tag: f.tag, assets: f.assets };
  app.state.board = 'biscuit';
  app.state.target = null;
  app.state.targetsJson = null;
  app.state.sums = null;
  app.state.files = new Map();
  app.state.bundleReady = false;
  const selected = f.files.filter((file) => !file.name.endsWith('-targets.json'));
  await app.verifyBundle(selected);
  assert.equal(app.state.bundleReady, false, 'a combined release fell back to a board without its descriptor');
  assert.match(app.terminal.plainText(), /targets\.json|combined/i);
});

test('a combined release selected by hand with a tampered descriptor is refused', async () => {
  const f = combinedFixture();
  const descriptorName = [...f.bytes.keys()].find((name) => name.endsWith('-targets.json'));
  const tampered = 'x'.repeat(Buffer.byteLength(f.bytes.get(descriptorName)));
  const files = f.files.map((file) => {
    if (file.name !== descriptorName) return file;
    const blob = new Blob([tampered]);
    blob.name = descriptorName;
    return blob;
  });
  app.state.release = { tag: f.tag, assets: f.assets };
  app.state.board = 'biscuit';
  app.state.target = null;
  app.state.targetsJson = null;
  app.state.sums = null;
  app.state.files = new Map();
  app.state.bundleReady = false;
  await app.verifyBundle(files);
  assert.equal(app.state.bundleReady, false);
  assert.match(app.terminal.plainText(), /checksum|digest|record/i);
});
