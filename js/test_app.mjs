import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { requiredBundleMembers } from './profiles.js';

class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
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
  querySelector() { return new Element(); }
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
test('Run is disabled until a marker-safe compatible bundle is qualified', () => {
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
};

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

test('a complete bundle without marker-safe boot qualification cannot unlock', async () => {
  const writes = [];
  setup(writes);
  app.state.identity.profile = { ...profile, id: 'radar', board: 'radar_puffin' };
  app.state.identity.product = 'RADAR';
  app.state.bundleReady = true;
  app.state.bundleBoard = 'radar_puffin';
  app.state.markerSafe = false;
  await app.runInstall({ dryRun: false });
  assert.deepEqual(writes, [], 'unqualified boot image reached flash:brick');
  assert.match(app.terminal.plainText(), /marker.safe|FASTBOOT_PLEASE|image qualification/i);
});

test('verified same-device recovery resumes without resubmitting brick', async () => {
  const writes = [];
  setup(writes);
  app.state.identity.profile = { ...profile, id: 'radar', board: 'radar_puffin' };
  app.state.identity.product = 'RADAR';
  app.state.bundleReady = true;
  app.state.bundleBoard = 'radar_puffin';
  app.state.markerSafe = true;
  app.state.recoverySerial = app.state.identity.serialRaw;
  app.state.kaeruHeader = '8816885870b203004c4b000000000000';
  app.state.adb = { shell: async (command) => ({ stdout: command.includes('uevent') ? 'PARTNAME=expdb\n'
    : command.includes('/size') ? '20480\n'
      : '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00\n' }) };
  await app.runInstall({ dryRun: false });
  assert.deepEqual(writes, [], 'continuation re-submitted flash:brick');
  assert.match(app.terminal.plainText(), /verified recovery|continuing.*recovery/i);
});

test('changing releases invalidates all verified bundle and marker state', () => {
  const oldRelease = { tag: 'radar-puffin-v0.14.0', assets: [], publishedAt: '2026-09-25T00:00:00Z', kind: 'stable' };
  const newRelease = { tag: 'radar-puffin-v0.14.1', assets: [], publishedAt: '2026-09-26T00:00:00Z', kind: 'stable' };
  app.state.releases = [oldRelease, newRelease];
  app.state.release = oldRelease;
  app.state.sums = new Map([['old', '0'.repeat(64)]]);
  app.state.files = new Map([['old', new Blob(['old'])]]);
  app.state.bundleReady = true;
  app.state.bundleBoard = 'radar_puffin';
  app.state.markerSafe = true;
  const select = elements.get('release-select');
  select.value = newRelease.tag;
  select.listeners.get('change')();
  assert.equal(app.state.release, newRelease);
  assert.equal(app.state.bundleReady, false);
  assert.equal(app.state.markerSafe, false);
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
  app.state.markerSafe = true;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{
    tag_name: 'radar-puffin-v0.14.1', published_at: '2026-09-26T00:00:00Z',
    assets: [], prerelease: false, draft: false,
  }] });
  try {
    await app.loadReleases();
    assert.equal(app.state.release.tag, 'radar-puffin-v0.14.1');
    assert.equal(app.state.bundleReady, false);
    assert.equal(app.state.markerSafe, false);
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
    request: (mode) => { requested.push(mode); return Promise.resolve(usbDevice); },
    openSession: async () => session,
  });
  assert.deepEqual(requested, ['adb']);
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
  const prefix = `libreecho-${tag}`;
  const members = requiredBundleMembers(tag);
  const normalNames = members.filter((name) => !name.endsWith('SHA256SUMS') && name !== 'libreecho-install.zip' && name !== 'bundle.manifest');
  const body = (name) => name.endsWith('-build.json') ? JSON.stringify({ board: 'radar_puffin', hardware_accepted: true }) : `test bytes for ${name}`;
  const files = normalNames.map((name) => makeFile(name, body(name)));
  const normal = normalNames.map((name) => `${sha(body(name))}  ${name}`).join('\n') + '\n';
  const twrp = ['libreecho-install.zip', 'bundle.manifest'].map((name) => `${sha(body(name))}  ${name}`).join('\n') + '\n';
  files.push(makeFile('libreecho-install.zip', body('libreecho-install.zip')));
  files.push(makeFile('bundle.manifest', body('bundle.manifest')));
  files.push(makeFile(`${prefix}-SHA256SUMS`, normal));
  files.push(makeFile(`${prefix}-TWRPINSTALL-SHA256SUMS`, twrp));
  const assets = files.map((file) => ({ name: file.name, size: file.size,
    digest: `sha256:${wrongChecksum && file.name === `${prefix}-TWRPINSTALL-SHA256SUMS` ? '0'.repeat(64) : sha(file.name.endsWith('SHA256SUMS') ? (file.name.includes('TWRPINSTALL') ? twrp : normal) : body(file.name))}` }));
  return { files, assets };
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
