// Issue aslater3/LibreEcho#322: an Echo already sitting in TWRP when the page is
// opened could not be identified at all.
//
//   * "Find previously authorised recovery" failed with "select and identify the
//     fastboot device first" (it only reuses a fastboot identity), while
//   * the fastboot query correctly refused the ADB device and pointed back at
//     "My Echo is already in recovery", and
//   * that button was greyed out during the download.
//
// Correction (issue #28): #26 also believed the Dot's TWRP enumerated as
// 18d1:d001. It does not: the Dot's TWRP is 18d1:4ee2, like Radar's, and
// 18d1:d001 is LibreEcho's own adbd on an installed Echo. d001 stays in the
// chooser only so an installed LibreEcho can be recognised (test_resume_28.mjs).
//
// These pin the way out: every recovery button identifies the device from TWRP
// itself with the command-line installer's checks (board, TWRP marker, expdb
// LK -> Kaeru chain), the fastboot query hands the device it already has
// permission for straight to that entry, a failed check refuses with a next
// step, the target comes from the device, and the unlock is never sent.
// Deterministic fakes only: no USB, adb or fastboot, and no real chooser.

import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.queryNodes = new Map();
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.classList = { add() {}, remove() {} };
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
  }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  focus() {}
  scrollIntoView() {}
  remove() {}
  set innerHTML(value) { this._html = value; this.children = []; }
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
// A secure context, so the real chooser helpers run as far as navigator.usb.
globalThis.window = { isSecureContext: true, location: { search: '', origin: 'https://localhost' } };
const chooserCalls = [];
let chooserReply = null;
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { usb: {
    getDevices: async () => [],
    requestDevice: async (options) => {
      chooserCalls.push(options);
      if (chooserReply) return chooserReply(options);
      const error = new Error('No device selected.'); error.name = 'NotFoundError'; throw error;
    },
  } },
});

const app = await import('./app.js');
const { openFastboot, RECOVERY_NOT_FASTBOOT_MESSAGE } = await import('./transports.js');
const { kaeruChainOffset } = await import('./stages.js');
const { phaseReply, readbackReply } = await import('./direct-test-protocol.mjs');
const { expdbChainReply, expdbImage } = await import('./kaeru-chain-fixture.mjs');

const HEADER = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const SERIAL = 'TEST-DOT-0322';

/**
 * The Dot from the report, in TWRP: a USBDevice on 18d1:4ee2 whose only
 * interface is ADB (ff/42/01). The real openFastboot reads its descriptors and
 * refuses it.
 */
function dotUsbDevice() {
  const endpoints = [
    { direction: 'in', type: 'bulk', endpointNumber: 1, packetSize: 64 },
    { direction: 'out', type: 'bulk', endpointNumber: 2, packetSize: 64 },
  ];
  return {
    vendorId: 0x18d1, productId: 0x4ee2, productName: 'Echo', serialNumber: SERIAL,
    opened: false, closeCalls: 0, releaseCalls: [],
    configuration: { interfaces: [{ interfaceNumber: 0, interfaceClass: 0xff, alternate: 0,
      alternates: [{ alternateSetting: 0, interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 0x01, endpoints }] }] },
    async open() { this.opened = true; },
    async close() { this.closeCalls += 1; this.opened = false; },
    async claimInterface(number) { this.claimed = number; },
    async releaseInterface(number) { this.releaseCalls.push(number); },
    async selectAlternateInterface() {},
  };
}

/** The TWRP side of that device: answers the probe, expdb and the v2 phases. */
function twrpClient({ twrp = '3.7.0_9-0', board = 'biscuit', serial = SERIAL, chain = expdbImage(),
  nodes = ['mmcblk0p7'] } = {}) {
  const records = { flashes: [], shell: [], pushes: [], closed: 0 };
  const landed = new Map();
  const DF_CACHE = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/mmcblk0p11 1048576 100000 948576 10% /cache\n';
  const DF_DATA = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/mmcblk0p49 60000000 100000 59000000 10% /data\n';
  return {
    records,
    shell: async (command) => {
      records.shell.push(command);
      const chainReply = expdbChainReply(command, { image: chain, nodes });
      if (chainReply) return chainReply;
      if (command.includes('ro.twrp.version')) return { stdout: [twrp, board, serial].join('\n') + '\n' };
      if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
      if (command.includes('/size')) return { stdout: '20480\n' };
      if (command.includes('od -An')) return { stdout: `${HEADER}\n` };
      if (command.startsWith('df ')) return { stdout: command.includes('/data') ? DF_DATA : DF_CACHE };
      const readback = await readbackReply(command, landed);
      if (readback) return readback;
      if (command.includes('--phase ')) {
        const phase = /--phase (\w+)/.exec(command)[1];
        if (phase === 'prepare') return phaseReply(command, 'result=prepare-noop\nreboot_required=0\n');
        if (phase === 'initialize') return phaseReply(command, 'result=initialized\nformat_state=formatted\n');
        if (phase === 'transfer') return phaseReply(command, 'result=transferred\n');
        if (phase === 'finalize' && command.includes('--dry-run')) return phaseReply(command, 'result=dry-run-ok\n');
        if (phase === 'finalize') return phaseReply(command, 'result=installed\n');
      }
      return { stdout: '' };
    },
    flash: async (...args) => { records.flashes.push(args); return {}; },
    push: async (path, blob) => { records.pushes.push(path); landed.set(path, blob); },
    close: async () => { records.closed += 1; },
  };
}

/** The page as the reporter had it: Echo Dot chosen in the menu, nothing identified. */
function freshPage({ board = 'biscuit' } = {}) {
  Object.assign(app.state, {
    releases: [], release: { tag: 'radar-puffin-v0.14.4', assets: [] },
    board, target: { board, slug: board === 'biscuit' ? 'biscuit' : 'radar-puffin',
      prefix: board === 'biscuit' ? 'libreecho-biscuit' : 'libreecho-radar-puffin', legacy: false },
    targetsJson: null, sums: null, files: new Map(),
    bundleReady: false, bundleBoard: null, bundleHardwareAccepted: false, installProtocol: null,
    identity: null, fastboot: null, payloadBytes: null, payloadName: '',
    running: false, abort: false, fetchingBundle: false, downloadedBundle: null,
    recoveryWaiting: false, recoveryDeadline: null, recoveryAbort: null,
    recoveryGrantInFlight: false, recoveryOtherSerial: null, recoveryAlreadyGranted: false,
    recoverySession: null, recoverySerial: null, recoveryAcceptedEpoch: 0, recoveryEpoch: 0,
    kaeruHeader: null, adb: null, unlockSubmitted: null, receipts: [], stageProgress: {},
  });
  chooserCalls.length = 0;
  chooserReply = null;
}

/** The real fastboot open against the Dot's descriptors, as "Show all USB devices…" does. */
function realFastbootOpen(device) {
  return (options) => openFastboot({ ...options, device });
}

const logText = () => app.terminal.plainText();
const logSince = (mark) => logText().slice(mark);

// ---------------------------------------------------------------------------
// A. the loop from the report
// ---------------------------------------------------------------------------

test('#322: "Find previously authorised recovery" with no identity opens the recovery chooser instead of failing', async () => {
  freshPage();
  const mark = logText().length;
  const click = elements.get('btn-recovery').listeners.get('click');
  assert.equal(typeof click, 'function');
  click();
  // The handler is fire-and-forget; let its promise chain settle.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const log = logSince(mark);
  assert.ok(!/select and identify the fastboot device first/.test(log),
    'the recovery button still demanded a fastboot identity');
  assert.equal(chooserCalls.length, 1, 'no chooser was opened for the recovery entry');
  assert.deepEqual(chooserCalls[0].filters, [
    { vendorId: 0x18d1, productId: 0x4ee2 }, { vendorId: 0x18d1, productId: 0xd001 },
  ]);
  assert.match(log, /reading your Echo's identity from recovery/);
  assert.equal(app.state.identity, null, 'a cancelled chooser left an identity');
});

test('#322: the fastboot query of an Echo in TWRP carries on into the recovery entry with the same device', async () => {
  freshPage();
  const usb = dotUsbDevice();
  const client = twrpClient();
  const opened = [];
  const mark = logText().length;
  const identity = await app.queryDevice({
    any: true,
    open: realFastbootOpen(usb),
    recoveryOpen: async ({ device }) => { opened.push(device); return { device, client }; },
  });
  assert.ok(identity, 'the query still ended in a refusal that points at another button');
  assert.equal(identity.source, 'recovery');
  assert.equal(identity.serialRaw, SERIAL);
  // The target is the board the device reported.
  assert.equal(identity.profile.board, 'biscuit');
  assert.deepEqual(opened, [usb], 'the recovery entry did not reuse the device the operator already chose');
  assert.equal(chooserCalls.length, 0, 'a second permission chooser was opened');
  assert.deepEqual(usb.releaseCalls, [0], 'the fastboot probe left the ADB interface claimed');
  assert.deepEqual(client.records.flashes, [], 'the recovery entry wrote to the device');
  assert.equal(app.state.unlockSubmitted, null);
  const log = logSince(mark);
  assert.match(log, /recovery identity checks passed: TWRP 3\.7\.0_9-0, board biscuit, expdb LK → Kaeru chain intact/);
  assert.ok(!log.includes(SERIAL), 'the full serial leaked into the log');
  assert.notEqual(elements.get('install-readiness').textContent, 'Install blocked: query the device in fastboot first.');
});

test('#322: a handoff whose checks fail refuses with a next step and leaves nothing bound', async () => {
  freshPage();
  const client = twrpClient({ chain: expdbImage({ kaeru: false }) });
  const mark = logText().length;
  const result = await app.queryDevice({
    any: true, open: realFastbootOpen(dotUsbDevice()),
    recoveryOpen: async ({ device }) => ({ device, client }),
  });
  assert.equal(result, null);
  assert.equal(app.state.identity, null);
  assert.equal(app.state.adb, null);
  assert.equal(app.state.kaeruHeader, null);
  assert.ok(client.records.closed > 0, 'the refused interface was left open');
  const log = logSince(mark);
  assert.match(log, /starting from recovery failed: .*LK → Kaeru header chain/);
  assert.match(log, /Do not run the unlock again from this page/);
});

test('#322: during a run, the query of an ADB device fails closed exactly as before', async () => {
  freshPage();
  app.state.running = true;
  let opened = 0;
  await assert.rejects(
    app.queryDevice({ any: true, open: realFastbootOpen(dotUsbDevice()),
      recoveryOpen: async () => { opened += 1; throw new Error('a run handed off to recovery'); } }),
    (error) => error.message === RECOVERY_NOT_FASTBOOT_MESSAGE,
  );
  assert.equal(opened, 0);
  app.state.running = false;
});

test('#322: "My Echo is already in recovery" stays available while the build downloads', async () => {
  freshPage();
  app.state.fetchingBundle = true;
  app.refreshControls();
  assert.equal(elements.get('btn-recovery-entry').disabled, false,
    'the recovery entry is greyed out during the download again');
  const client = twrpClient();
  const identity = await app.startFromRecovery({ request: async () => dotUsbDevice(),
    open: async ({ device }) => ({ device, client }) });
  assert.equal(identity.source, 'recovery');
  app.state.fetchingBundle = false;
  // It is still closed during a run.
  app.state.identity = null;
  app.state.running = true;
  app.refreshControls();
  assert.equal(elements.get('btn-recovery-entry').disabled, true);
  app.state.running = false;
});

// ---------------------------------------------------------------------------
// B. the command-line installer's checks, each one required
// ---------------------------------------------------------------------------

const CHAIN_REFUSALS = [
  ['no Kaeru header after LK', { chain: expdbImage({ kaeru: false }) }, /LK → Kaeru header chain/],
  ['a second header not named kaeru', { chain: expdbImage({ kaeruName: 'other' }) }, /LK → Kaeru header chain/],
  ['a Kaeru header without the extended magic', { chain: expdbImage({ kaeruExt: 0 }) }, /LK → Kaeru header chain/],
  ['a first header not named LK', { chain: expdbImage({ lkName: 'XX' }) }, /LK → Kaeru header chain/],
  ['expdb resolving to two block devices', { nodes: ['mmcblk0p7', 'mmcblk1p7'] }, /exactly one block device/],
  ['expdb not found in sysfs', { nodes: [] }, /exactly one block device/],
];

for (const [name, options, pattern] of CHAIN_REFUSALS) {
  test(`recovery identity refuses ${name}`, async () => {
    freshPage();
    const client = twrpClient(options);
    await assert.rejects(app.startFromRecovery({ request: async () => dotUsbDevice(),
      open: async ({ device }) => ({ device, client }) }), pattern);
    assert.equal(app.state.identity, null, `${name} left an identity`);
    assert.equal(app.state.adb, null);
    assert.deepEqual(client.records.flashes, []);
    assert.deepEqual(client.records.pushes, []);
  });
}

test('an ADB device without TWRP or LibreEcho markers is refused with a next step', async () => {
  freshPage();
  const client = twrpClient({ twrp: '' });
  await assert.rejects(app.startFromRecovery({ request: async () => dotUsbDevice(),
    open: async ({ device }) => ({ device, client }) }), /TWRP is not running.*Query device.*already running LibreEcho/);
  assert.equal(app.state.identity, null);
});

test('a TWRP marker outside the command-line installer bound is refused', async () => {
  freshPage();
  for (const twrp of ['3.7.0; reboot', '3'.repeat(65)]) {
    const client = twrpClient({ twrp });
    await assert.rejects(app.startFromRecovery({ request: async () => dotUsbDevice(),
      open: async ({ device }) => ({ device, client }) }), /TWRP is not running/);
    assert.equal(app.state.identity, null);
  }
});

test('the board must be an exact LibreEcho recovery name, never a substring', async () => {
  for (const [board, expected] of [['radar', 'radar_puffin'], ['radar_puffin', 'radar_puffin'],
    ['biscuit', 'biscuit'], ['omni_biscuit', 'biscuit']]) {
    freshPage();
    const identity = await app.startFromRecovery({ request: async () => dotUsbDevice(),
      open: async ({ device }) => ({ device, client: twrpClient({ board }) }) });
    assert.equal(identity.profile.board, expected, `${board} was not recognised`);
  }
  for (const board of ['biscuit_clone', 'notbiscuit', 'radar2', '']) {
    freshPage();
    await assert.rejects(app.startFromRecovery({ request: async () => dotUsbDevice(),
      open: async ({ device }) => ({ device, client: twrpClient({ board }) }) }), /not a LibreEcho target/);
    assert.equal(app.state.identity, null, `${board} left an identity`);
  }
});

test('kaeruChainOffset follows round8(512 + LK size), as the command-line installer does', async () => {
  for (const lkSize of [0x03b270, 1, 7, 0x40001]) {
    const image = expdbImage({ lkSize });
    let expected = 512 + lkSize;
    expected += (8 - (expected % 8)) % 8;
    assert.equal(image.kaeruOffset, expected);
    assert.equal(await kaeruChainOffset(async (offset, count) => image.read(offset, count)), expected);
  }
  // A short read fails closed.
  assert.equal(await kaeruChainOffset(async () => null), null);
  assert.equal(await kaeruChainOffset(async (offset, count) => new Uint8Array(count - 1)), null);
});

// ---------------------------------------------------------------------------
// C. the target is the device's board, and a mismatch refuses before writes
// ---------------------------------------------------------------------------

function primeVerifiedBuild(board) {
  const prefix = board === 'biscuit' ? 'libreecho-biscuit' : 'libreecho-radar-puffin';
  const roles = [
    ['transfer:boot', `${prefix}-boot.img`, 'boot-bytes'],
    ['transfer:ota-manifest', 'manifest', 'signed'],
    ['transfer:ota-signature', 'manifest.sig', 'sig'],
    ['transfer:local-package', `${prefix}.ota.tar`, 'ota'],
  ];
  const files = new Map();
  const sums = new Map();
  for (const [, name, content] of roles) {
    const blob = new Blob([content]); blob.name = name;
    files.set(name, blob);
    sums.set(name, Buffer.from(content).toString('hex').padEnd(64, '0'));
  }
  const manifestText = [
    'schema=1', 'protocol=2', 'release=build-test', `device=${board}`, `target=${board}`,
    `fastboot_products=${board === 'biscuit' ? 'BISCUIT' : 'RADAR'}`,
    `transfer=boot:${prefix}-boot.img:${sums.get(`${prefix}-boot.img`)}`,
    `transfer=ota-manifest:manifest:${sums.get('manifest')}`,
    `transfer=ota-signature:manifest.sig:${sums.get('manifest.sig')}`,
    `transfer=local-package:${prefix}.ota.tar:${sums.get(`${prefix}.ota.tar`)}`,
  ].join('\n');
  const directRoles = roles.map(([role, name]) => ({ role, name, sha256: sums.get(name), size: files.get(name).size }));
  Object.assign(app.state, {
    files, sums, bundleReady: true, bundleBoard: board, bundleHardwareAccepted: true,
    installProtocol: 2, directRelease: 'build-test', directManifestText: manifestText,
    directManifestSha: 'a'.repeat(64), directHelper: new TextEncoder().encode('#!/bin/sh\n'),
    directRoles, directTransferTotal: directRoles.reduce((sum, role) => sum + role.size, 0),
  });
}

const withLocalStorage = (fn) => async () => {
  const prior = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (k) => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, String(v)),
    removeItem: (k) => entries.delete(k) };
  try { await fn(); } finally { globalThis.localStorage = prior; }
};

test('menu says Echo Dot, device reports Radar: identified as Radar, install refused before any write',
  withLocalStorage(async () => {
    freshPage({ board: 'biscuit' });
    primeVerifiedBuild('biscuit');
    const client = twrpClient({ board: 'radar' });
    const mark = logText().length;
    const identity = await app.queryDevice({ any: true, open: realFastbootOpen(dotUsbDevice()),
      recoveryOpen: async ({ device }) => ({ device, client }) });
    assert.equal(identity.profile.board, 'radar_puffin', 'the menu choice replaced what the device reported');
    assert.match(logSince(mark), /the selected build targets biscuit, but this device reports radar_puffin/);
    assert.match(elements.get('install-readiness').textContent, /release board mismatch/);
    await app.runInstall({ dryRun: false, recovery: { timeoutMs: 60, intervalMs: 5, grantedDevices: async () => [],
      open: async () => { throw new Error('a board mismatch opened a device'); } } });
    assert.match(logSince(mark), /identity stage failed: release board mismatch/);
    assert.deepEqual(client.records.flashes, []);
    assert.deepEqual(client.records.pushes, []);
    assert.ok(!client.records.shell.some((command) => command.includes('--phase')), 'a phase ran despite the mismatch');
  }));

test('TWRP-first Dot with the Dot build installs from the verified recovery and never sends the unlock',
  withLocalStorage(async () => {
    freshPage({ board: 'biscuit' });
    primeVerifiedBuild('biscuit');
    const client = twrpClient({ board: 'biscuit' });
    const mark = logText().length;
    await app.queryDevice({ any: true, open: realFastbootOpen(dotUsbDevice()),
      recoveryOpen: async ({ device }) => ({ device, client }) });
    assert.equal(app.state.identity.source, 'recovery');
    assert.equal(elements.get('install-readiness').textContent,
      'Published build verified for this device. Recovery is checked before any install write.');
    await app.runInstall({ dryRun: false, recovery: { timeoutMs: 60, intervalMs: 5, grantedDevices: async () => [],
      open: async () => { throw new Error('runInstall re-entered the recovery wait'); } } });
    const log = logSince(mark);
    assert.match(log, /continuing from verified recovery without re-submitting the unlock payload/);
    assert.ok(!/flash brick/.test(log), 'flash:brick appeared in the log');
    assert.deepEqual(client.records.flashes, [], 'flash:brick was sent to a recovery-identified Echo');
    assert.equal(app.state.unlockSubmitted, null);
    assert.ok(client.records.shell.some((command) => command.includes('--phase prepare')),
      'the run never reached the install phases');
  }));
