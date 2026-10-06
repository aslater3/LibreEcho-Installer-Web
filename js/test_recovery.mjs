// Recovery-handoff, cancellation and /cache preflight tests.
//
// These exercise the browser recovery permission handoff (poll vs grant),
// prompt cancellation, late-session disposal and the pre-push /cache free-space
// gate with fake transports only — no device, no USB.

import test from 'node:test';
import assert from 'node:assert/strict';
import { phaseReply, readbackReply } from './direct-test-protocol.mjs';
import { sha256Blob, sha256Bytes } from './sha256.js';
import { createHash } from 'node:crypto';
import * as stages from './stages.js';
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
// Node 22 exposes `navigator` as a getter only; redefine it for this process.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: { usb: {
    getDevices: async () => [],
    requestDevice: async () => { throw new Error('background code opened a permission prompt'); },
  } },
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

const quiet = { line() {}, info() {}, ok() {}, warn() {}, error() {},
  command() {}, endProgress() {}, progress() {}, phase() {} };

// --- fixtures --------------------------------------------------------------

const PROFILE = {
  id: 'biscuit', product: 'BISCUIT', marketing: 'Echo Dot', board: 'biscuit',
  libreEcho: 'experimental', userdataContractSectors: [2137088],
  lkBuildMap: { '63cb91b-20221007_072309': { payload: 'test.img', size: 3, sha256: 'a'.repeat(64) } },
};
const DEVICE = { vendorId: 0x18d1, productId: 0x4ee1 };

function twrpSession({ serial = 'TEST-DOT', board = 'biscuit', device = DEVICE,
  closed = () => {}, header = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00' } = {}) {
  const client = {
    shell: async (command) => ({ stdout:
      command.includes('ro.twrp.version') ? `3.7.0_9-0\n${board}\n${serial}\n`
        : command.includes('uevent') ? 'PARTNAME=expdb\n'
          : command.includes('/size') ? '20480\n'
            : `${header}\n` }),
    close: async () => { closed(); },
  };
  return { device, transport: { close: async () => {} }, client };
}

function setup() {
  app.state.release = { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' };
  app.state.identity = { product: 'BISCUIT', unlockStatus: 'false', profile: PROFILE,
    lkBuild: '63cb91b-20221007_072309', serialRaw: 'TEST-DOT' };
  app.state.adb = null;
  app.state.recoverySerial = null;
  app.state.kaeruHeader = null;
  app.state.abort = false;
  app.state.running = false;
  app.state.recoveryWaiting = false;
  app.state.recoveryAbort = null;
  app.state.recoveryGrantInFlight = false;
  app.state.target = null;
  app.state.targetsJson = null;
  app.state.files = new Map();
  app.state.sums = null;
  app.state.bundleReady = false;
  app.state.bundleBoard = null;
  app.state.bundleHardwareAccepted = false;
  app.state.installProtocol = 2;
  app.state.directRelease = null;
  app.state.directHelper = null;
  app.state.directManifestText = null;
  app.state.directManifestSha = null;
  app.state.directRoles = null;
  app.state.directTransferTotal = null;
  // Page-session unlock latch: reset between tests exactly like the other
  // per-session fields, so one test's submitted unlock cannot leak into the next.
  app.state.unlockSubmitted = null;
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// /cache free-space preflight
// ---------------------------------------------------------------------------

const DF_OK = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
  '/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache', ''].join('\n');
const DF_LOW = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
  '/dev/block/mmcblk0p11  1048576 1048000 576  99% /cache', ''].join('\n');

function cacheAdb({ df = DF_OK } = {}) {
  const commands = [];
  const pushes = [];
  return {
    commands,
    pushes,
    shell: async (command) => { commands.push(command); return { stdout: command.includes('df') ? df : '' }; },
    push: async (path) => { pushes.push(path); },
  };
}

async function pushOne(adb) {
  const file = new Blob(['verified bytes']);
  const name = 'libreecho-test-boot.img';
  return stages.pushBundle({ adb, files: new Map([[name, file]]), sums: new Map([[name, await sha256Blob(file)]]),
    terminal: quiet, requireCacheSpace: true });
}

const mkdirCount = (adb) => adb.commands.filter((command) => command.includes('mkdir')).length;

test('/cache preflight blocks mkdir and push when free space is insufficient', async () => {
  const adb = cacheAdb({ df: DF_LOW });
  await assert.rejects(pushOne(adb), /cache|free|space|needs/i);
  assert.equal(mkdirCount(adb), 0, 'the bundle directory was created before the space check');
  assert.deepEqual(adb.pushes, [], 'files were pushed into a full /cache');
});

test('/cache preflight fails closed when df output has no usable filesystem row', async () => {
  const adb = cacheAdb({ df: 'df: /cache: No such file or directory\n' });
  await assert.rejects(pushOne(adb), /cache|free|space|read|measure/i);
  assert.equal(mkdirCount(adb), 0);
  assert.deepEqual(adb.pushes, [], 'files were pushed after an unreadable df');
});

test('/cache preflight fails closed on empty df output', async () => {
  const adb = cacheAdb({ df: '' });
  await assert.rejects(pushOne(adb), /cache|free|space|read|measure/i);
  assert.equal(mkdirCount(adb), 0);
  assert.deepEqual(adb.pushes, []);
});

test('/cache preflight permits the push when free space covers the files plus overhead', async () => {
  const adb = cacheAdb({ df: DF_OK });
  const result = await pushOne(adb);
  assert.equal(result.fileCount, 1);
  assert.equal(mkdirCount(adb), 1, 'the bundle directory was not created after a passing preflight');
  assert.equal(adb.pushes.length, 1);
});

test('parseCacheFreeBytes reports free bytes and refuses malformed rows', () => {
  assert.equal(stages.parseCacheFreeBytes(DF_OK), 948576 * 1024);
  assert.throws(() => stages.parseCacheFreeBytes('Filesystem 1K-blocks Used Available Use% Mounted on\n'), /cache|free|space|read|parse/i);
});

// ---------------------------------------------------------------------------
// Recovery handoff: background poll, permission CTA, resume, refusals
// ---------------------------------------------------------------------------

test('background recovery polling never opens a browser permission prompt', async () => {
  setup();
  const promise = app.awaitRecovery({ terminal: quiet, timeoutMs: 60, intervalMs: 5 });
  await assert.rejects(promise, /timed out|TWRP/i);
  assert.equal(app.state.recoveryWaiting, false, 'the waiting state was not cleared');
});

test('the recovery-permission action is available while the install waits', async () => {
  setup();
  app.state.running = true;
  const promise = app.awaitRecovery({ terminal: quiet, timeoutMs: 200, intervalMs: 5,
    grantedDevices: async () => [], open: async () => { throw new Error('should not open'); } });
  await tick(1);
  assert.equal(app.state.recoveryWaiting, true, 'the page did not enter the waiting state');
  assert.equal(elements.get('btn-grant-recovery').disabled, false, 'the permission action was disabled while waiting');
  app.requestStop();
  await assert.rejects(promise, /stop|cancel/i);
  assert.equal(app.state.recoveryWaiting, false);
  assert.equal(elements.get('btn-grant-recovery').disabled, true, 'the permission action stayed enabled after the run stopped');
});

test('an already-granted matching device resumes automatically without a prompt', async () => {
  setup();
  const session = twrpSession();
  const result = await app.awaitRecovery({ terminal: quiet, timeoutMs: 200, intervalMs: 5,
    grantedDevices: async () => [DEVICE], open: async () => session });
  assert.equal(result.client, session.client);
  assert.equal(app.state.recoverySerial, 'TEST-DOT');
  assert.equal(app.state.kaeruHeader, '8816885870b203004c4b000000000000');
});

test('a granted device with the wrong serial is refused without changing the target', async () => {
  setup();
  const before = { ...app.state.identity };
  let closed = 0;
  const promise = app.awaitRecovery({ terminal: quiet, timeoutMs: 60, intervalMs: 5,
    grantedDevices: async () => [DEVICE],
    open: async () => twrpSession({ serial: 'OTHER-DEVICE', closed: () => { closed += 1; } }) });
  await assert.rejects(promise, /timed out|TWRP/i);
  assert.ok(closed > 0, 'the wrong-serial session was not closed');
  assert.equal(app.state.adb, null, 'a wrong device was bound to the run');
  assert.equal(app.state.recoverySerial, null);
  assert.deepEqual(app.state.identity, before, 'the frozen identity changed');
});

test('a granted device with the wrong board is refused', async () => {
  setup();
  const promise = app.awaitRecovery({ terminal: quiet, timeoutMs: 60, intervalMs: 5,
    grantedDevices: async () => [DEVICE],
    open: async () => twrpSession({ board: 'radar_puffin', serial: 'TEST-DOT' }) });
  await assert.rejects(promise, /timed out|TWRP/i);
  assert.equal(app.state.adb, null, 'a wrong-board recovery device was accepted');
});

test('cancelling the chooser leaves the wait intact and allows a retry', async () => {
  setup();
  const cancel = Object.assign(new Error('no device selected'), { name: 'NotFoundError' });
  const refused = await app.grantRecovery({ request: () => Promise.reject(cancel) });
  assert.equal(refused, null);
  assert.equal(app.state.adb, null, 'a cancelled chooser mutated the run');

  const session = twrpSession();
  const granted = await app.grantRecovery({ request: () => Promise.resolve(DEVICE), open: async () => session });
  assert.equal(granted.client, session.client, 'the retry did not bind the chosen recovery device');
  assert.equal(app.state.recoverySerial, 'TEST-DOT');
});

test('stop during the recovery poll cancels promptly', async () => {
  setup();
  const promise = app.awaitRecovery({ terminal: quiet, timeoutMs: 60000, intervalMs: 5000,
    grantedDevices: async () => [], open: async () => { throw new Error('should not open'); } });
  await tick(10);
  const started = Date.now();
  app.requestStop();
  await assert.rejects(promise, /stop|cancel/i);
  assert.ok(Date.now() - started < 1000, 'the recovery wait was not cancelled promptly');
});

test('a chooser that resolves after stop is disposed and never bound', async () => {
  setup();
  let resolveOpen;
  let closed = 0;
  const opened = new Promise((resolve) => { resolveOpen = resolve; });
  const waiting = app.awaitRecovery({ terminal: quiet, timeoutMs: 60000, intervalMs: 5000,
    grantedDevices: async () => [], open: async () => { throw new Error('poll must not open'); } });
  await tick(5);
  const grant = app.grantRecovery({ request: () => Promise.resolve(DEVICE),
    open: () => opened.then(() => twrpSession({ closed: () => { closed += 1; } })) });
  await tick(5);
  app.requestStop();
  resolveOpen();
  await grant;
  await assert.rejects(waiting, /stop|cancel/i);
  assert.ok(closed > 0, 'a session bound after stop was not disposed');
  assert.equal(app.state.adb, null, 'a late session was bound to a stopped run');
});

test('the recovery wait never re-submits the unlock or starts a device write', async () => {
  const previous = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  try {
    setup();
    const payloadDigest = createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex');
    app.state.identity = { ...app.state.identity, product: 'RADAR',
      profile: { ...PROFILE, id: 'radar', board: 'radar_puffin',
        lkBuildMap: { '63cb91b-20221007_072309': { payload: 'test.img', size: 3, sha256: payloadDigest } } } };
    app.state.bundleReady = true;
    app.state.bundleBoard = 'radar_puffin';
    app.state.bundleHardwareAccepted = true;
    app.state.payloadBytes = new Uint8Array([1, 2, 3]);
    app.state.payloadName = 'test.img';
    app.state.sums = new Map([['libreecho-radar-puffin-v0.14.0-boot.img', 'b'.repeat(64)]]);
    app.state.files = new Map();
    let flashes = 0;
    let pushes = 0;
    app.state.fastboot = { client: { flash: async () => { flashes += 1; throw new Error('timeout after write'); } } };
    app.state.adb = { shell: async () => { pushes += 1; return { stdout: '' }; }, push: async () => { pushes += 1; } };
    await app.runInstall({ dryRun: false, recovery: { grantedDevices: async () => [], timeoutMs: 40, intervalMs: 5 } });
    assert.equal(flashes, 1, 'the unlock payload was submitted more than once');
    assert.equal(pushes, 0, 'a device write started after the unlock without a recovery session');
    assert.match(app.terminal.plainText(), /do not re-submit|never re-submitting|recovery/i);
  } finally { globalThis.localStorage = previous; }
});

// ---------------------------------------------------------------------------
// Combined-layout recovery ZIP selection + download UI + native click wiring
// ---------------------------------------------------------------------------

test('a combined-layout target ZIP is the one that runs, from its verified members', async () => {
  const previous = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  const commands = [];
  const adb = { shell: async (command) => { commands.push(command);
    return { stdout: command.startsWith('twrp install') ? '__RECEIPT__result=installed\n' : '' }; } };
  const members = ['libreecho-biscuit-install.zip', 'libreecho-biscuit-bundle.manifest'];
  try {
    const receipt = await stages.runRecoveryPhase({ adb, tag: 'biscuit-v0.14.0', serialRaw: 'TEST-DOT',
      phase: 'prepare', zipName: members[0], allowZipNames: members }, { terminal: quiet });
    assert.equal(receipt.result, 'installed');
    const install = commands.find((command) => command.startsWith('twrp install'));
    assert.match(install, /libreecho-biscuit-install\.zip/);
    assert.doesNotMatch(install, /libreecho-install\.zip/);
  } finally { globalThis.localStorage = previous; }
});

test('runRecoveryPhase refuses any ZIP that is not a verified target member', async () => {
  const previous = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  const commands = [];
  const adb = { shell: async (command) => { commands.push(command); return { stdout: '' }; } };
  try {
    await assert.rejects(stages.runRecoveryPhase({ adb, tag: 't1', serialRaw: 'TEST-DOT', phase: 'prepare',
      zipName: 'libreecho-radar-puffin-install.zip', allowZipNames: ['libreecho-biscuit-install.zip'] },
      { terminal: quiet }), /verified member|refus/i);
    await assert.rejects(stages.runRecoveryPhase({ adb, tag: 't2', serialRaw: 'TEST-DOT', phase: 'prepare',
      zipName: '../../etc/passwd' }, { terminal: quiet }), /unsafe|refus/i);
    assert.deepEqual(commands, [], 'an unverified recovery ZIP name reached ADB');
  } finally { globalThis.localStorage = previous; }
});

test('a verified protocol-2 bundle drives the direct helper for its target, never a legacy twrp install', async () => {
  const previous = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  try {
    setup();
    app.state.identity = { ...app.state.identity, unlockStatus: 'true' };
    const roles = [
      { role: 'transfer:boot', name: 'libreecho-biscuit-boot.img', content: 'boot' },
      { role: 'transfer:ota-manifest', name: 'manifest', content: 'signed' },
      { role: 'transfer:ota-signature', name: 'manifest.sig', content: 'sig' },
      { role: 'transfer:local-package', name: 'libreecho-biscuit.ota.tar', content: 'ota' },
      { role: 'staging:airplay2:payload', name: 'libreecho-biscuit-airplay2.squashfs', content: 'payload' },
      { role: 'staging:airplay2:manifest', name: 'libreecho-biscuit-airplay2.manifest.json', content: 'fm' },
    ];
    const files = new Map(); const sums = new Map();
    for (const role of roles) {
      const blob = new Blob([role.content]); blob.name = role.name;
      files.set(role.name, blob); sums.set(role.name, await sha256Blob(blob));
    }
    const manifestText = 'protocol=2\nrelease=biscuit-build-test\ntarget=biscuit\ndevice=biscuit\nfastboot_products=BISCUIT\n';
    app.state.installProtocol = 2;
    app.state.directRelease = 'biscuit-build-test';
    app.state.directManifestText = manifestText;
    app.state.directManifestSha = await sha256Bytes(new TextEncoder().encode(manifestText));
    app.state.directHelper = new TextEncoder().encode('#!/sbin/sh\n');
    app.state.directRoles = roles.map((role) => ({ role: role.role, name: role.name, sha256: sums.get(role.name), size: files.get(role.name).size }));
    app.state.files = files;
    app.state.sums = sums;
    app.state.bundleReady = true;
    app.state.bundleBoard = 'biscuit';
    app.state.bundleHardwareAccepted = true;
    app.state.target = { board: 'biscuit', slug: 'biscuit', prefix: 'libreecho-biscuit', legacy: false };
    app.state.recoverySerial = 'TEST-DOT';
    app.state.kaeruHeader = '8816885870b203004c4b000000000000';
    const commands = [];
    const pushes = [];
    const landed = new Map();
    app.state.adb = {
      shell: async (command) => {
        commands.push(command);
        if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
        if (command.includes('mmcblk0p7/size')) return { stdout: '20480\n' };
        if (command.startsWith('df ')) return { stdout: DF_OK };
        const readback = await readbackReply(command, landed);
        if (readback) return readback;
        if (command.includes('--phase ')) {
          const phase = /--phase (\w+)/.exec(command)[1];
          if (phase === 'prepare') return phaseReply(command, 'result=prepare-noop\nreboot_required=0\n');
          if (phase === 'initialize') return phaseReply(command, 'result=initialized\n');
          if (phase === 'transfer') return phaseReply(command, 'result=transferred\n');
          if (phase === 'finalize' && command.includes('--dry-run')) return phaseReply(command, 'result=dry-run-ok\n');
          if (phase === 'finalize') return phaseReply(command, 'result=installed\n');
        }
        if (command.includes('od -An')) return { stdout: '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00\n' };
        return { stdout: '' };
      },
      push: async (path, blob) => { pushes.push(path); landed.set(path, blob); },
    };
    await app.runInstall({ dryRun: false });
    const helperRuns = commands.filter((command) => command.includes('--phase '));
    assert.ok(helperRuns.length >= 5, `the direct helper never ran: ${commands.join(' | ')}`);
    assert.ok(helperRuns.every((command) => /--target biscuit/.test(command)), 'the helper ran without the verified biscuit target');
    assert.ok(!commands.some((command) => /twrp install/.test(command)), 'a legacy twrp install ran');
    assert.ok(pushes.some((path) => path.startsWith('/data/libreecho/incoming/')), 'no payload reached the userdata landing zone');
    assert.ok(!pushes.some((path) => path.startsWith('/cache/libreecho-bundle')), 'a payload was staged in the legacy /cache path');
    assert.match(app.terminal.plainText(), /pushed .*payload/);
  } finally { globalThis.localStorage = previous; }
});

test('the download UI keeps file X of Y while hashing and logs the filename instead', () => {
  setup();
  app.state.progressClock = { startedAt: Date.now(), done: 0, total: 0, rate: 0 };
  app.handleDownloadEvent({ phase: 'verifying', name: 'libreecho-boot.img', index: 3, count: 36, done: 100, total: 100 });
  assert.equal(elements.get('download-files').textContent, 'file 3 of 36');
  assert.equal(elements.get('download-eta').textContent, '', 'the ETA claimed a value while hashing');
  assert.match(app.terminal.plainText(), /checking libreecho-boot\.img/);
});

test('the Download button click is wired to the automatic download path', async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 404 });
  try {
    setup();
    app.state.board = 'radar_puffin';
    app.state.release = { tag: 'radar-puffin-v0.14.0', assets: [] };
    app.state.fetchingBundle = false;
    const click = elements.get('btn-download').listeners.get('click');
    assert.equal(typeof click, 'function', 'the Download button has no click listener');
    click();
    assert.equal(app.state.fetchingBundle, true, 'clicking Download did not start the download path');
  } finally {
    app.state.downloadController?.abort();
    app.state.fetchingBundle = false;
    globalThis.fetch = previous;
    await tick(40);
  }
});

test('a standalone recovery grant is not blocked by a stale stop flag from an earlier run', async () => {
  setup();
  app.state.abort = true;    // left over from a stopped run
  app.state.running = false; // no run is active now
  const session = twrpSession();
  const granted = await app.grantRecovery({ request: () => Promise.resolve(DEVICE), open: async () => session });
  assert.equal(granted?.client, session.client);
  assert.equal(app.state.recoverySerial, 'TEST-DOT');
});

// ---------------------------------------------------------------------------
// The 10-minute recovery deadline, the visible countdown, and the unlock latch
// ---------------------------------------------------------------------------

test('the recovery wait defaults to ten minutes and shows a countdown', async () => {
  assert.equal(app.RECOVERY_TIMEOUT_MS, 600000, 'the recovery deadline is not ten minutes');
  assert.equal(app.RECOVERY_TIMEOUT_MS, stages.RECOVERY_TIMEOUT_MS,
    'the page wait and the shared constant have drifted apart');
  assert.equal(stages.RECOVERY_TIMEOUT_MS, 600000);
  // 180 s expired while a healthy TWRP waited on a human in Chrome's chooser.
  assert.ok(app.RECOVERY_TIMEOUT_MS > 180000, 'the deadline was not lengthened past three minutes');

  assert.equal(app.formatCountdown(9 * 60 * 1000 + 58000), '9:58');
  assert.equal(app.formatCountdown(45000), '45s');
  assert.equal(app.formatCountdown(0), '0s');
  assert.equal(app.formatCountdown(-5), '0s', 'a negative remainder rendered as a real time');

  setup();
  const promise = app.awaitRecovery({ terminal: quiet, timeoutMs: 400, intervalMs: 10,
    grantedDevices: async () => [], open: async () => { throw new Error('must not open'); } });
  await tick(40);
  assert.equal(app.state.recoveryWaiting, true);
  assert.match(elements.get('recovery-countdown').textContent, /^\d+(:\d\d|s) left$/,
    'no countdown is visible while the page waits for TWRP');
  await assert.rejects(promise, /timed out|TWRP/i);
  assert.equal(elements.get('recovery-countdown').textContent, '',
    'the countdown survived the end of the wait');
});

test('the unlock latch is set before flash:brick leaves the host', async () => {
  setup();
  const previous = globalThis.localStorage;
  const bytes = new Uint8Array([1, 2, 3]);
  const { sha256Bytes } = await import('./sha256.js');
  const pinned = { ...PROFILE, lkBuildMap: { '63cb91b-20221007_072309': {
    payload: 'test.img', size: bytes.length, sha256: await sha256Bytes(bytes) } } };
  const base = { profile: pinned, lkBuild: '63cb91b-20221007_072309', payloadBytes: bytes,
    payloadName: 'test.img', serialRaw: 'TEST-DOT', terminal: quiet };
  const freshStorage = () => {
    const entries = new Map();
    globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, value) };
  };
  try {
    // The decisive property: `onSubmit` must have run BEFORE `flash` is called, so
    // a synchronous throw, an exception or a timeout from the transport all leave
    // the latch set. Reading the latch only after the await would pass even if the
    // production code latched afterwards, which is precisely the bug.
    freshStorage();
    let latched = null;
    let latchedWhenFlashed = null;
    const outcome = await stages.submitUnlockPayload({ ...base,
      client: { flash: async () => { latchedWhenFlashed = latched; throw new Error('timeout after write'); } },
      onSubmit: (serial) => { latched = serial; } });
    assert.equal(outcome.outcome, 'unknown');
    assert.equal(latchedWhenFlashed, 'TEST-DOT', 'flash:brick was called before the latch was set');
    assert.equal(latched, 'TEST-DOT');

    // A synchronous throw (not even a rejected promise) must still latch. The
    // stage reports it as an unknown outcome rather than propagating, so the
    // assertion is on the latch seen from inside the client.
    freshStorage();
    let thrownLatched = null;
    let seen = 'never';
    const outcome1 = await stages.submitUnlockPayload({ ...base,
      client: { flash: () => { seen = String(thrownLatched); throw new Error('transport died'); } },
      onSubmit: (serial) => { thrownLatched = serial; } });
    assert.equal(seen, 'TEST-DOT', 'a synchronous flash failure skipped the latch');
    assert.equal(outcome1.outcome, 'unknown');

    // A latch callback that throws must never block the write it protects.
    freshStorage();
    const outcome2 = await stages.submitUnlockPayload({ ...base,
      client: { flash: async () => { throw new Error('timeout after write'); } },
      onSubmit: () => { throw new Error('latch bookkeeping exploded'); } });
    assert.equal(outcome2.outcome, 'unknown');

    // The page latch is only set by runInstall, never by a direct stage call.
    assert.equal(app.state.unlockSubmitted, null, 'a direct stage call touched page state');
  } finally { globalThis.localStorage = previous; }
});


