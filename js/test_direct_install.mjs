// Direct-userdata v2 browser integration tests.
//
// These pin the browser side of the delivered recovery protocol v2 (CONTRACT.md):
// a complete release is verified on the host before any device mutation, an old
// or protocol-less bundle is refused before unlock, only the helper + manifest
// reach /cache, the payloads land directly on userdata, finalize never formats,
// and every mutating step is cancellable and attempt-guarded. Fake transports
// only — no USB, no adb, no device.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { DIRECT_HELPER_MEMBER, DIRECT_HELPER_BYTES, directFixture } from './combined-fixture.mjs';
import { zipBuffer } from './bundle-fixture.mjs';
import { sha256Blob, sha256Bytes } from './sha256.js';
import { parseBundleManifest } from './targets.js';
import { verifyEd25519Signature } from './signature.js';
import * as direct from './direct-install.js';
import { phaseReply, readbackReply } from './direct-test-protocol.mjs';
import { installWebLocksFixture, resetWebLocksFixture } from './web-locks-fixture.mjs';

// --- minimal DOM so the real page module imports under node ---------------
class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.queryNodes = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = { add() {}, remove() {} };
    this.textContent = '';
    this.disabled = false;
  }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
  remove() {}
  set innerHTML(value) { this._html = value; }
  get innerHTML() { return this._html ?? ''; }
}
const elements = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  },
  createElement: () => new Element(),
};
globalThis.window = { isSecureContext: false, location: { search: '', origin: 'https://localhost' } };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: { usb: { getDevices: async () => [], requestDevice: async () => { throw new Error('background code opened a permission prompt'); } } },
});
// --- Web Locks (js/writer-lock.js) ------------------------------------------
// app.js takes the browser's origin-wide exclusive writer lock before any device
// command and FAILS CLOSED without it, so under node — which has `navigator` but
// no `navigator.locks` — every install here would stop at "cannot start the
// install: this browser does not offer Web Locks" and never reach the behaviour
// under test. This is a faithful LockManager double, not an allow-anything stub:
// it excludes a second holder of the same name and holds the grant until the
// granted callback settles. Installed AFTER the `navigator` redefinition above,
// which replaces the whole object. See js/test_web_locks_integration.mjs, which
// drives the real acquireWriterLock against it and would fail if it became one.
installWebLocksFixture();
test.beforeEach(() => { resetWebLocksFixture(); });

const app = await import('./app.js');
// The post-reboot wait for LibreEcho is covered by test_post_install*.mjs.
app.__setPostInstallHookForTest(async () => {});

const quiet = { line() {}, info() {}, ok() {}, warn() {}, error() {}, command() {}, endProgress() {}, progress() {}, phase() {} };
const HEADER_HEX = '8816885870b203004c4b000000000000';
const HEADER_SPACED = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const DF_OK = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
  '/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache', ''].join('\n');
const DF_OK_DATA = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
  '/dev/block/mmcblk0p49 60000000 100000 59000000  10% /data', ''].join('\n');

const withLocalStorage = (fn) => async () => {
  const prior = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
  try { await fn(entries); } finally { globalThis.localStorage = prior; }
};

// ---------------------------------------------------------------------------
// A. Ed25519 signed-manifest precheck (WebCrypto; fail-closed)
// ---------------------------------------------------------------------------

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKeyHex: Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('hex'),
  };
}

test('the Ed25519 precheck accepts a signature made by the pinned published key', async () => {
  const { privateKey, publicKeyHex } = keypair();
  const message = new TextEncoder().encode('format=libreecho-ota-v2\nboard=radar_puffin\n');
  const signatureHex = edSign(null, message, privateKey).toString('hex');
  assert.equal(await verifyEd25519Signature({ message, signatureHex, publicKeyHex }), true);
});

test('the Ed25519 precheck refuses a tampered manifest or signature', async () => {
  const { privateKey, publicKeyHex } = keypair();
  const message = new TextEncoder().encode('format=libreecho-ota-v2\nboard=radar_puffin\n');
  const signatureHex = edSign(null, message, privateKey).toString('hex');
  const tampered = new TextEncoder().encode('format=libreecho-ota-v2\nboard=biscuit\n');
  await assert.rejects(verifyEd25519Signature({ message: tampered, signatureHex, publicKeyHex }), /signature|verify/i);
  const other = keypair();
  await assert.rejects(verifyEd25519Signature({ message, signatureHex, publicKeyHex: other.publicKeyHex }), /signature|verify/i);
});

test('the Ed25519 precheck fails closed when WebCrypto Ed25519 is unavailable', async () => {
  const { publicKeyHex } = keypair();
  const message = new TextEncoder().encode('x');
  await assert.rejects(verifyEd25519Signature({ message, signatureHex: 'a'.repeat(128), publicKeyHex, subtle: null }), /unavailable|subtle/i);
  await assert.rejects(verifyEd25519Signature({ message, signatureHex: 'nothex', publicKeyHex }), /hex|signature/i);
});

// ---------------------------------------------------------------------------
// B. bundle.manifest v2 parsing
// ---------------------------------------------------------------------------

const V2_MANIFEST = [
  'schema=1', 'protocol=2', 'release=radar-puffin-build-test', 'device=radar_puffin',
  'target=radar_puffin', 'fastboot_products=RADAR', 'transfer_bytes_total=4096',
  'transfer=boot:boot.img:' + 'b'.repeat(64),
  'transfer=ota-manifest:manifest:' + '1'.repeat(64),
  'transfer=ota-signature:manifest.sig:' + '2'.repeat(64),
  'transfer=local-package:update.ota.tar:' + '4'.repeat(64),
  'staging=airplay2:p.squashfs:' + '3'.repeat(64) + ':m.json:' + '5'.repeat(64),
].join('\n');
const V2_TARGET = { board: 'radar_puffin', product: 'RADAR', prefix: 'libreecho-x', slug: 'radar-puffin', legacy: false };

test('parseBundleManifest reads protocol, transfers and transfer_bytes_total', () => {
  const parsed = parseBundleManifest(V2_MANIFEST, V2_TARGET);
  assert.equal(parsed.protocol, 2);
  assert.equal(parsed.transferBytesTotal, 4096);
  assert.deepEqual(parsed.transfers.map(t => t.role), ['boot', 'ota-manifest', 'ota-signature', 'local-package']);
  assert.equal(parsed.transfers[0].name, 'boot.img');
  assert.equal(parsed.transfers[0].sha256, 'b'.repeat(64));
  assert.equal(parsed.staging.length, 1);
});

test('parseBundleManifest stays legacy when no protocol key is present', () => {
  const parsed = parseBundleManifest('schema=1\ntarget=radar_puffin\ndevice=radar_puffin\nfastboot_products=RADAR\n', V2_TARGET);
  assert.equal(parsed.protocol, null);
  assert.equal(parsed.transferBytesTotal, null);
  assert.deepEqual(parsed.transfers, []);
});

test('parseBundleManifest fails closed on an unknown protocol or malformed transfer', () => {
  assert.throws(() => parseBundleManifest(V2_MANIFEST.replace('protocol=2', 'protocol=9'), V2_TARGET), /protocol/i);
  assert.throws(() => parseBundleManifest(V2_MANIFEST.replace('protocol=2', 'protocol=two'), V2_TARGET), /protocol/i);
  assert.throws(() => parseBundleManifest(V2_MANIFEST.replace('transfer=boot:boot.img:' + 'b'.repeat(64), 'transfer=sideways:boot.img:' + 'b'.repeat(64)), V2_TARGET), /transfer|role/i);
  assert.throws(() => parseBundleManifest(V2_MANIFEST + '\ntransfer=boot:boot.img:' + 'c'.repeat(64), V2_TARGET), /duplicate/i);
  assert.throws(() => parseBundleManifest(V2_MANIFEST.replace(':' + 'b'.repeat(64), ':nothex'), V2_TARGET), /transfer|digest|sha/i);
  assert.throws(() => parseBundleManifest(V2_MANIFEST.replace('transfer=boot:boot.img:', 'transfer=boot:../boot.img:'), V2_TARGET), /transfer|name|path/i);
});

// ---------------------------------------------------------------------------
// C. direct-install helpers
// ---------------------------------------------------------------------------

function directArtifacts({ tamperSignature = false, tamperPayload = false, omitHelper = false, mismatchTotal = false } = {}) {
  const { privateKey, publicKeyHex } = generateKeyPairSync('ed25519') && keypair();
  const signedManifest = Buffer.from('format=libreecho-ota-v2\nfeature_ids=airplay2\nfeature_airplay2_action=preserve\n');
  const signatureHex = edSign(null, signedManifest, privateKey).toString('hex');
  const prefix = 'libreecho-radar-puffin';
  const boot = `${prefix}-boot.img`;
  const ota = `${prefix}.ota.tar`;
  const payload = `${prefix}-airplay2.squashfs`;
  const featureManifest = `${prefix}-airplay2.manifest.json`;
  const zipName = `${prefix}-install.zip`;

  const contents = new Map([
    [boot, Buffer.from('boot-bytes')],
    ['manifest', signedManifest],
    ['manifest.sig', Buffer.from(tamperSignature ? 'f'.repeat(128) : signatureHex)],
    [ota, Buffer.from('ota-tar-bytes')],
    [payload, Buffer.from(tamperPayload ? 'payload-bytes' : 'payload')],
    [featureManifest, Buffer.from('fm')],
    [`${prefix}-ota-public-key.hex`, Buffer.from(publicKeyHex)],
    [zipName, zipBuffer(omitHelper ? [{ name: 'not-the-helper', data: 'x' }] : [{ name: DIRECT_HELPER_MEMBER, data: DIRECT_HELPER_BYTES }])],
  ]);
  const sha = (n) => createHash('sha256').update(contents.get(n)).digest('hex');
  const size = (n) => contents.get(n).length;
  const total = [boot, 'manifest', 'manifest.sig', ota, payload, featureManifest].reduce((s, n) => s + size(n), 0);
  const manifestText = [
    'schema=1', 'protocol=2', 'release=radar-puffin-build-test', 'device=radar_puffin',
    'target=radar_puffin', 'fastboot_products=RADAR',
    `transfer_bytes_total=${mismatchTotal ? total + 1 : total}`,
    `transfer=boot:${boot}:${sha(boot)}`,
    `transfer=ota-manifest:manifest:${sha('manifest')}`,
    `transfer=ota-signature:manifest.sig:${sha('manifest.sig')}`,
    `transfer=local-package:${ota}:${sha(ota)}`,
    `staging=airplay2:${payload}:${sha(payload)}:${featureManifest}:${sha(featureManifest)}`,
    `local_package=${ota}:${sha(ota)}`,
  ].join('\n');
  const manifestName = `${prefix}-bundle.manifest`;
  contents.set(manifestName, Buffer.from(manifestText));
  const files = new Map([...contents].map(([name, value]) => { const blob = new Blob([value]); blob.name = name; return [name, blob]; }));
  const sums = new Map([...contents].map(([name]) => [name, sha(name)]));
  const target = { board: 'radar_puffin', product: 'RADAR', prefix, slug: 'radar-puffin', legacy: false };
  const parsed = parseBundleManifest(manifestText, target);
  return { files, sums, parsed, target, manifestText, manifestName, zipName };
}

test('the direct phase command is explicit, bounded and never resets the transaction', () => {
  const command = direct.directPhaseCommand({ invocationId: "f".repeat(64), phase: 'transfer', bundleManifestSha256: 'a'.repeat(64),
    target: 'radar_puffin', release: 'radar-puffin-build-test' });
  assert.match(command, /^\/sbin\/sh \/cache\/libreecho-direct\/libreecho-direct-install\.sh /);
  assert.match(command, /--protocol 2/);
  assert.match(command, /--phase transfer/);
  assert.match(command, /--bundle-manifest \/cache\/libreecho-direct\/bundle\.manifest/);
  assert.match(command, new RegExp(`--bundle-manifest-sha256 ${'a'.repeat(64)}`));
  assert.match(command, /--target radar_puffin/);
  assert.match(command, /--release radar-puffin-build-test/);
  assert.match(command, /--incoming-dir \/data\/libreecho\/incoming/);
  assert.doesNotMatch(command, /--reset-transaction/);
  const dry = direct.directPhaseCommand({ invocationId: "f".repeat(64), phase: 'finalize', dryRun: true, bundleManifestSha256: 'a'.repeat(64), target: 'radar_puffin', release: 'r' });
  assert.match(dry, /--dry-run/);
  assert.throws(() => direct.directPhaseCommand({ invocationId: "f".repeat(64), phase: 'wipe', bundleManifestSha256: 'a'.repeat(64), target: 'radar_puffin', release: 'r' }), /phase/i);
  assert.throws(() => direct.directPhaseCommand({ invocationId: "f".repeat(64), phase: 'prepare', bundleManifestSha256: 'nope', target: 'radar_puffin', release: 'r' }), /sha|manifest/i);
});

test('prepareDirectInstall resolves every exact transfer/staging role against verified bytes', async () => {
  const { files, sums, parsed, target, manifestName } = directArtifacts();
  const prepared = await direct.prepareDirectInstall({ parsed, files, sums, target, manifestName });
  assert.deepEqual(prepared.roles.map(r => r.role).sort(),
    ['staging:airplay2:manifest', 'staging:airplay2:payload', 'transfer:boot', 'transfer:local-package', 'transfer:ota-manifest', 'transfer:ota-signature']);
  assert.equal(prepared.transferBytesTotal, parsed.transferBytesTotal);
  assert.ok(prepared.helper instanceof Uint8Array && prepared.helper.length > 0);
  assert.equal(prepared.manifestSha256, sums.get(manifestName));
});

test('prepareDirectInstall refuses a missing role, a digest mismatch, an inconsistent total and a tampered signature', async () => {
  const base = directArtifacts();
  const withoutBoot = new Map(base.files); withoutBoot.delete(`${base.target.prefix}-boot.img`);
  await assert.rejects(direct.prepareDirectInstall({ parsed: base.parsed, files: withoutBoot, sums: base.sums, target: base.target, manifestName: base.manifestName }), /missing|verified|upload|role/i);

  const badSum = new Map(base.sums); badSum.set('manifest', 'a'.repeat(64));
  await assert.rejects(direct.prepareDirectInstall({ parsed: base.parsed, files: base.files, sums: badSum, target: base.target, manifestName: base.manifestName }), /digest|sha|mismatch/i);

  const badTotal = directArtifacts({ mismatchTotal: true });
  await assert.rejects(direct.prepareDirectInstall({ parsed: badTotal.parsed, files: badTotal.files, sums: badTotal.sums, target: badTotal.target, manifestName: badTotal.manifestName }), /total|byte/i);

  const torn = directArtifacts({ tamperSignature: true });
  await assert.rejects(direct.prepareDirectInstall({ parsed: torn.parsed, files: torn.files, sums: torn.sums, target: torn.target, manifestName: torn.manifestName }), /signature|verify/i);

  const tamperedPlan = { ...base.parsed, transfers: base.parsed.transfers.map(t => (t.role === 'boot' ? { ...t, sha256: 'c'.repeat(64) } : t)) };
  await assert.rejects(direct.prepareDirectInstall({ parsed: tamperedPlan, files: base.files, sums: base.sums, target: base.target, manifestName: base.manifestName }), /digest|mismatch|manifest/i);
});

test('prepareDirectInstall refuses an installer ZIP whose bounded helper member is missing', async () => {
  const noHelper = directArtifacts({ omitHelper: true });
  await assert.rejects(direct.prepareDirectInstall({ parsed: noHelper.parsed, files: noHelper.files, sums: noHelper.sums, target: noHelper.target, manifestName: noHelper.manifestName }), /helper|member|missing/i);
});

// ---------------------------------------------------------------------------
// D. runInstall v2 orchestration (fake transports only)
// ---------------------------------------------------------------------------

function directAdb({ onCommand = null, prepareReboot = false, breakDryRun = false } = {}) {
  const calls = [];
  const landed = new Map();
  const records = { shell: [], push: [], phases: [], controlPushes: [], bulkPushes: [] };
  const PHASES = ['prepare', 'initialize', 'transfer', 'finalize'];
  const adb = {
    calls, records,
    shell: async (command) => {
      calls.push(command); records.shell.push(command);
      onCommand?.(command, adb);
      if (command.includes('ro.twrp.version')) return { stdout: '3.7.0_9-0\nradar_puffin\nTEST-DOT\n' };
      if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
      if (command.includes('mmcblk0p7/size')) return { stdout: '20480\n' };
      if (command.includes('od -An')) return { stdout: `${HEADER_SPACED}\n` };
      if (command.startsWith('df ')) return { stdout: command.includes('/data') ? DF_OK_DATA : DF_OK };
      const readback = await readbackReply(command, landed);
      if (readback) return readback;
      if (command.includes('--phase ')) {
        const phase = /--phase (\w+)/.exec(command)[1];
        const dry = command.includes('--dry-run');
        records.phases.push(`${phase}${dry ? ':dry-run' : ''}`);
        if (phase === 'prepare') return phaseReply(command, `result=${prepareReboot ? 'prepare-ok' : 'prepare-noop'}\nreboot_required=${prepareReboot ? '1' : '0'}\n`);
        if (phase === 'initialize') return phaseReply(command, 'result=initialized\nformat_state=formatted\n');
        if (phase === 'transfer') return phaseReply(command, 'result=transferred\n');
        if (phase === 'finalize' && dry) return phaseReply(command, breakDryRun ? 'result=failed\nerror=missing-upload:boot\n' : 'result=dry-run-ok\n');
        if (phase === 'finalize') return phaseReply(command, 'result=installed\n');
      }
      return { stdout: '' };
    },
    push: async (path, blob) => {
      calls.push(`push ${path}`); records.push.push(path);
      if (path.startsWith('/cache/libreecho-direct/')) records.controlPushes.push(path);
      if (path.startsWith('/data/libreecho/incoming/')) records.bulkPushes.push(path);
      landed.set(path, blob);
    },
    close: async () => {},
  };
  return adb;
}

async function primeDirectRun({ adb = null, overrides = {} } = {}) {
  const prefix = 'libreecho-radar-puffin';
  const roles = [
    { role: 'transfer:boot', name: `${prefix}-boot.img`, content: 'boot-bytes' },
    { role: 'transfer:ota-manifest', name: 'manifest', content: 'signed-manifest-bytes' },
    { role: 'transfer:ota-signature', name: 'manifest.sig', content: 'sig-hex-bytes' },
    { role: 'transfer:local-package', name: `${prefix}.ota.tar`, content: 'ota-tar-bytes' },
    { role: 'staging:airplay2:payload', name: `${prefix}-airplay2.squashfs`, content: 'payload' },
    { role: 'staging:airplay2:manifest', name: `${prefix}-airplay2.manifest.json`, content: 'fm' },
  ];
  const files = new Map(); const sums = new Map();
  for (const role of roles) {
    const blob = new Blob([role.content]); blob.name = role.name;
    files.set(role.name, blob); sums.set(role.name, await sha256Blob(blob));
  }
  const manifestText = V2_MANIFEST.replace(/b{64}/g, 'b'.repeat(64));
  const directRoles = roles.map(r => ({ role: r.role, name: r.name, sha256: sums.get(r.name), size: files.get(r.name).size }));
  Object.assign(app.state, {
    release: { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' },
    identity: { product: 'RADAR', unlockStatus: 'true',
      profile: { id: 'radar', product: 'RADAR', marketing: 'Echo', board: 'radar_puffin', libreEcho: 'reference', lkBuildMap: {} },
      lkBuild: '59779ca-20220524_183401', serialRaw: 'TEST-DOT' },
    target: { board: 'radar_puffin', slug: 'radar-puffin', prefix, legacy: false },
    board: null, targetsJson: null,
    files, sums, bundleReady: true, bundleBoard: 'radar_puffin', bundleHardwareAccepted: true,
    installProtocol: 2, directRelease: 'radar-puffin-build-test',
    directManifestText: manifestText, directManifestSha: await sha256Bytes(new TextEncoder().encode(manifestText)),
    directHelper: new TextEncoder().encode(DIRECT_HELPER_BYTES),
    directRoles, directTransferTotal: directRoles.reduce((s, r) => s + r.size, 0),
    abort: false, running: false, kaeruHeader: HEADER_HEX, recoverySerial: 'TEST-DOT',
    adb: adb ?? directAdb(), fastboot: null, receipts: [],
  });
  Object.assign(app.state, overrides);
  return app.state;
}

test('a v2 install runs control push, prepare, initialize, transfer, bulk push, finalize dry-run then finalize — and never formats', withLocalStorage(async () => {
  const adb = directAdb();
  await primeDirectRun({ adb });
  await app.runInstall({ dryRun: false });
  assert.deepEqual(adb.records.phases, ['prepare', 'initialize', 'transfer', 'finalize:dry-run', 'finalize']);
  assert.deepEqual([...adb.records.controlPushes].sort(),
    ['/cache/libreecho-direct/bundle.manifest', '/cache/libreecho-direct/libreecho-direct-install.sh']);
  assert.equal(adb.records.bulkPushes.length, 6, `bulk pushes: ${adb.records.bulkPushes.join(', ')}`);
  assert.ok(adb.records.bulkPushes.every(p => p.startsWith('/data/libreecho/incoming/')), 'a payload was not pushed to the userdata landing zone');
  assert.ok(!adb.records.shell.some(c => /twrp install/.test(c)), 'the legacy twrp install path was used');
  assert.ok(!adb.records.shell.some(c => /mke2fs|sgdisk/.test(c)), 'the browser ran a format/reshape command directly');
  assert.ok(!adb.records.shell.some(c => /--reset-transaction/.test(c)), 'a transaction reset was issued automatically');
  assert.ok(!adb.calls.some(c => String(c).includes('/cache/libreecho-bundle')), 'a bulk payload was staged in /cache');
  // ordering: control push precedes prepare; bulk pushes precede the finalize dry-run
  const firstPhaseIdx = adb.calls.findIndex(c => String(c).includes('libreecho-direct-install.sh'));
  const lastControlIdx = adb.calls.map(String).lastIndexOf('/cache/libreecho-direct/bundle.manifest');
  assert.ok(lastControlIdx < firstPhaseIdx, 'the control files were pushed after the first phase');
  const dryIdx = adb.calls.findIndex(c => String(c).includes('--phase finalize') && String(c).includes('--dry-run'));
  const firstBulkIdx = adb.calls.findIndex(c => String(c).startsWith('push /data/libreecho/incoming/'));
  assert.ok(firstBulkIdx < dryIdx, 'payloads were not pushed before the finalize dry-run');
  assert.match(app.terminal.plainText(), /installed|finalize/i);
}));

test('an old or protocol-less verified bundle is refused before unlock and before any device command', withLocalStorage(async () => {
  const adb = directAdb();
  await primeDirectRun({ adb, overrides: { installProtocol: null } });
  await app.runInstall({ dryRun: false });
  assert.deepEqual(adb.calls, [], `an unverified-protocol bundle reached the device: ${adb.calls.join(' | ')}`);
  assert.match(app.terminal.plainText(), /protocol|direct-userdata|refus/i);
}));

test('a cancelled run stops before the next mutating phase', withLocalStorage(async () => {
  const adb = directAdb({ onCommand: (command) => { if (command.includes('--phase initialize')) app.requestStop(); } });
  await primeDirectRun({ adb });
  await app.runInstall({ dryRun: false });
  assert.ok(adb.records.phases.includes('initialize'), 'initialize never ran');
  assert.ok(!adb.records.phases.some(p => p.startsWith('transfer')), 'transfer ran after the operator stopped');
  assert.deepEqual(adb.records.bulkPushes, [], 'a payload was pushed after the operator stopped');
}));

test('a failed finalize dry-run blocks the real finalize', withLocalStorage(async () => {
  const adb = directAdb({ breakDryRun: true });
  await primeDirectRun({ adb });
  await app.runInstall({ dryRun: false });
  assert.ok(adb.records.phases.includes('finalize:dry-run'));
  assert.ok(!adb.records.phases.includes('finalize'), 'the real finalize ran despite a failed landed-completely check');
}));

test('hardware-acceptance and board-matching gates still block before any device command', withLocalStorage(async () => {
  const adb = directAdb();
  await primeDirectRun({ adb, overrides: { bundleHardwareAccepted: false } });
  await app.runInstall({ dryRun: false });
  assert.deepEqual(adb.calls, [], 'a non-hardware-accepted build reached the device');
  assert.match(app.terminal.plainText(), /hardware-accepted|hardware/i);

  const adb2 = directAdb();
  await primeDirectRun({ adb: adb2, overrides: { bundleBoard: 'biscuit' } });
  await app.runInstall({ dryRun: false });
  assert.deepEqual(adb2.calls, [], 'wrong-board build reached the device');
  assert.match(app.terminal.plainText(), /release board mismatch/i);
}));

// ---------------------------------------------------------------------------
// E. persistent attempts / no automatic format retry
// ---------------------------------------------------------------------------

test('Stop during the cache query prevents control pushes in the actual app path', withLocalStorage(async () => {
  const adb = directAdb({ onCommand: command => { if (command.startsWith('df ')) app.requestStop(); } });
  await primeDirectRun({ adb });
  await app.runInstall({ dryRun: false });
  assert.deepEqual(adb.records.controlPushes, []);
}));

for (const stopAt of ['finalize', 'prepare-header']) {
  test(`Stop at ${stopAt} prevents a reboot`, withLocalStorage(async () => {
    let prepared = false;
    const adb = directAdb({ prepareReboot: stopAt === 'prepare-header', onCommand: command => {
      if (command.includes('--phase prepare')) prepared = true;
      if ((stopAt === 'finalize' && command.includes('--phase finalize') && !command.includes('--dry-run')) ||
          (stopAt === 'prepare-header' && prepared && command.includes('od -An'))) app.requestStop();
    } });
    await primeDirectRun({ adb });
    await app.runInstall({ dryRun: false });
    assert.ok(adb.records.phases.includes(stopAt === 'finalize' ? 'finalize' : 'prepare'));
    assert.ok(!adb.records.shell.some(c => c.includes('/sbin/twrp reboot')));
  }));
}

for (const missing of ['zip', 'manifest']) {
  test(`the exported verifier refuses missing ${missing} digest pins`, async () => {
    const f = directArtifacts();
    f.sums.delete(missing === 'zip' ? f.zipName : f.manifestName);
    await assert.rejects(direct.prepareDirectInstall(f), /digest|pin|verified/i);
  });
}
test('the exported verifier rehashes the ZIP at helper extraction', async () => {
  const f = directArtifacts();
  f.files.set(f.zipName, new Blob([zipBuffer([{ name: DIRECT_HELPER_MEMBER, data: 'changed helper' }])]));
  await assert.rejects(direct.prepareDirectInstall(f), /digest|mismatch/i);
});

test('a destructive phase is attempt-guarded and never silently repeated', withLocalStorage(async () => {
  const adb = directAdb();
  const args = { adb, phase: 'initialize', serialRaw: 'TEST-DOT', tag: 'radar-puffin-v0.14.0',
    bundleManifestSha256: 'a'.repeat(64), target: 'radar_puffin', release: 'radar-puffin-build-test',
    terminal: quiet, isCancelled: () => false };
  const first = await direct.runDirectPhase(args);
  assert.equal(first.result, 'initialized');
  const count = adb.records.shell.length;
  await assert.rejects(direct.runDirectPhase(args), /already attempted|pending|classif/i);
  assert.equal(adb.records.shell.length, count, 'a repeated destructive phase reached the device');
}));

test('the finalize dry-run is not attempt-guarded and does not block the real finalize', withLocalStorage(async () => {
  const adb = directAdb();
  const base = { adb, phase: 'finalize', serialRaw: 'TEST-DOT', tag: 't', bundleManifestSha256: 'a'.repeat(64),
    target: 'radar_puffin', release: 'r', terminal: quiet, isCancelled: () => false };
  assert.equal((await direct.runDirectPhase({ ...base, dryRun: true })).result, 'dry-run-ok');
  assert.equal((await direct.runDirectPhase({ ...base, dryRun: false })).result, 'installed');
}));

// ---------------------------------------------------------------------------
// F. verifyBundle captures the v2 plan and rejects a tampered signed manifest
// ---------------------------------------------------------------------------

test('verifyBundle stores the protocol-2 plan and extracted helper for a complete release', async () => {
  const f = directFixture();
  Object.assign(app.state, { release: { tag: f.tag, assets: f.assets }, board: 'radar_puffin', targetsJson: null,
    running: false, files: new Map(), sums: null, target: null, bundleReady: false });
  await app.verifyBundle(f.files);
  assert.equal(app.state.installProtocol, 2);
  assert.equal(app.state.bundleReady, true);
  assert.ok(app.state.directHelper instanceof Uint8Array && app.state.directHelper.length > 0, 'the helper was not extracted');
  assert.equal(app.state.directManifestSha, f.assets.find(a => a.name === 'libreecho-radar-puffin-bundle.manifest').digest.slice(7));
  assert.ok(Array.isArray(app.state.directRoles) && app.state.directRoles.length >= 6);
  assert.equal(app.state.directRoles.reduce((s, r) => s + r.size, 0), Number(/transfer_bytes_total=(\d+)/.exec(app.state.directManifestText)[1]));
});

test('verifyBundle refuses a v2 release whose signed manifest does not verify', async () => {
  const f = directFixture();
  // Replace the signed manifest inside the ota.tar with a tampered copy and
  // rebuild every dependent digest so only the signature is wrong.
  const original = f.metadata.get('manifest');
  const tampered = Buffer.concat([Buffer.from(original), Buffer.from('\n')]);
  f.bytes.set('manifest', tampered);
  const { tar } = await import('./bundle-fixture.mjs');
  f.bytes.set(`libreecho-${f.tag}.ota.tar`, tar([['manifest', tampered], ['manifest.sig', f.metadata.get('manifest.sig')]]));
  const text = f.bytes.get('libreecho-radar-puffin-bundle.manifest').toString()
    .replace(/payload=manifest:[0-9a-f]{64}/, `payload=manifest:${createHash('sha256').update(tampered).digest('hex')}`)
    .replace(/transfer=ota-manifest:manifest:[0-9a-f]{64}/, `transfer=ota-manifest:manifest:${createHash('sha256').update(tampered).digest('hex')}`);
  f.bytes.set('libreecho-radar-puffin-bundle.manifest', Buffer.from(text));
  const { hashBytes } = await import('./combined-fixture.mjs');
  const normal = f.normalNames.radar_puffin.map(n => `${hashBytes(f.bytes.get(n))}  ${n}`).join('\n');
  const recovery = f.recoveryNames.radar_puffin.map(n => `${hashBytes(f.bytes.get(n))}  ${n}`).join('\n');
  f.bytes.set('libreecho-radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d-SHA256SUMS', Buffer.from(normal));
  f.bytes.set('libreecho-radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d-radar-puffin-TWRPINSTALL-SHA256SUMS', Buffer.from(recovery));
  f.assets = [...f.bytes].map(([name, value]) => ({ name, size: Buffer.byteLength(value), digest: `sha256:${hashBytes(value)}` }));
  f.files = [...f.bytes].map(([name, value]) => { const blob = new Blob([value]); blob.name = name; return blob; });
  Object.assign(app.state, { release: { tag: f.tag, assets: f.assets }, board: 'radar_puffin', targetsJson: null,
    running: false, files: new Map(), sums: null, target: null, bundleReady: false });
  await app.verifyBundle(f.files);
  assert.equal(app.state.bundleReady, false, 'a tampered signed manifest was accepted');
  assert.match(app.terminal.plainText(), /signature|verify/i);
});

// ---------------------------------------------------------------------------
// G. optional real-artifact parser/plan check (local test fixtures only)
// ---------------------------------------------------------------------------

test('real protocol-2 bundle plan (opt-in local fixture, not published)', { skip: !process.env.LIBREECHO_DIRECT_FIXTURE }, async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = process.env.LIBREECHO_DIRECT_FIXTURE;
  const read = (name) => readFile(path.join(dir, name));
  const manifestName = 'libreecho-radar-puffin-bundle.manifest';
  const manifestBlob = new Blob([await read(manifestName)]); manifestBlob.name = manifestName;
  const target = { board: 'radar_puffin', product: 'RADAR', prefix: `libreecho-${/release=(.*)/.exec(await read(manifestName).then(b => b.toString()))[1]}`, slug: 'radar-puffin', legacy: false };
  const parsed = parseBundleManifest(await manifestBlob.text(), target);
  assert.equal(parsed.protocol, 2);
  const zipName = 'libreecho-radar-puffin-install.zip';
  const zipBlob = new Blob([await read(zipName)]); zipBlob.name = zipName;
  const helper = await direct.extractDirectHelper({ archiveBlob: zipBlob });
  assert.ok(helper.length > 0);
  assert.match(new TextDecoder().decode(helper), /direct-userdata|protocol/i);
  const { statSync } = await import('node:fs');
  const plan = direct.planRoles(parsed);
  const total = plan.reduce((sum, entry) => sum + statSync(path.join(dir, entry.name)).size, 0);
  assert.equal(total, parsed.transferBytesTotal);
});
