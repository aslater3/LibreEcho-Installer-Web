// "Start from recovery": the only entry for a page that has no fastboot identity
// because the Echo is already unlocked and sitting in TWRP.
//
// A reloaded page used to be a dead end — awaitRecovery/grantRecovery both refuse
// without a fastboot `getvar` identity, and the device cannot be put back into
// fastboot to produce one. These pin the four things that make the new entry safe
// rather than merely convenient: it accepts only a device that proves all four
// facts from recovery, it refuses the same four cases it must, it binds the
// session exactly like a polled recovery so runInstall takes its resumed path
// without ever reaching flash:brick, and the unchanged release gates still block
// a board mismatch before any write. Deterministic fakes only — no USB, no adb,
// no fastboot, no chooser is ever opened against a real browser.

import test from 'node:test';
import assert from 'node:assert/strict';

// --- minimal DOM so the real page module imports under node ---------------
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
    this.focused = 0;
    this.scrolled = 0;
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
  focus() { this.focused += 1; }
  scrollIntoView() { this.scrolled += 1; }
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
globalThis.window = { isSecureContext: false, location: { search: '', origin: 'https://localhost' } };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { usb: {
    getDevices: async () => [],
    requestDevice: async () => { throw new Error('a test opened a real chooser'); },
  } },
});
const app = await import('./app.js');
const { recoveryChooserFilters } = await import('./device.js');
const { phaseReply, readbackReply } = await import('./direct-test-protocol.mjs');

const HEADER = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const HEADER_HEX = '8816885870b203004c4b000000000000';
const DEVICE = { vendorId: 0x18d1, productId: 0x4ee2, serialNumber: 'G090L90964010665' };
const SERIAL = 'G090L90964010665';

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

/**
 * A fake TWRP device. Every refusal case is a single altered field, so each test
 * names exactly one missing fact.
 */
function twrpDevice({
  twrp = '3.7.0_9-0',
  board = 'radar_puffin',
  serial = SERIAL,
  header = HEADER,
  expdb = 'PARTNAME=expdb',
  sectors = '20480',
} = {}) {
  const records = { flashes: [], shell: [], pushes: [], closed: 0 };
  const landed = new Map();
  const DF_CACHE = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
    '/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache', ''].join('\n');
  const DF_DATA = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
    '/dev/block/mmcblk0p49 60000000 100000 59000000  10% /data', ''].join('\n');
  const client = {
    records,
    shell: async (command) => {
      records.shell.push(command);
      if (command.includes('ro.twrp.version')) {
        return { stdout: [twrp, board, serial].join('\n') + '\n' };
      }
      if (command.includes('uevent')) return { stdout: `${expdb}\n` };
      if (command.includes('/size')) return { stdout: `${sectors}\n` };
      if (command.includes('od -An')) return { stdout: `${header}\n` };
      // The staging reserve and the v2 phases read these; answering them keeps
      // this test focused on the recovery entry rather than on `df`.
      if (command.startsWith('df ')) return { stdout: command.includes('/data') ? DF_DATA : DF_CACHE };
      const readback = await readbackReply(command, landed);
      if (readback) return readback;
      if (command.includes('--phase ')) {
        const phase = /--phase (\w+)/.exec(command)[1];
        const dry = command.includes('--dry-run');
        if (phase === 'prepare') return phaseReply(command, 'result=prepare-noop\nreboot_required=0\n');
        if (phase === 'initialize') return phaseReply(command, 'result=initialized\nformat_state=formatted\n');
        if (phase === 'transfer') return phaseReply(command, 'result=transferred\n');
        if (phase === 'finalize' && dry) return phaseReply(command, 'result=dry-run-ok\n');
        if (phase === 'finalize') return phaseReply(command, 'result=installed\n');
      }
      return { stdout: '' };
    },
    // Every device write the run could attempt, recorded rather than performed.
    flash: async (...args) => { records.flashes.push(args); return {}; },
    push: async (path, blob) => { records.pushes.push(path); landed.set(path, blob); },
    close: async () => { records.closed += 1; },
  };
  return { device: DEVICE, client, records };
}

/** A page with no identity at all: exactly the reloaded-page situation. */
function blankPage({ board = 'radar_puffin', buildReady = false } = {}) {
  Object.assign(app.state, {
    releases: [], release: buildReady ? { tag: 'radar-puffin-v0.14.0', assets: [], board } : null,
    board: null, target: null, targetsJson: null, sums: null, files: new Map(),
    bundleReady: false, bundleBoard: null, bundleHardwareAccepted: false, installProtocol: null,
    identity: null, fastboot: null, payloadBytes: null, payloadName: '',
    running: false, abort: false, fetchingBundle: false, downloadedBundle: null,
    recoveryWaiting: false, recoveryDeadline: null, recoveryAbort: null,
    recoveryGrantInFlight: false, recoveryChooserWide: false, recoveryAlreadyGranted: false,
    recoverySession: null, recoverySerial: null, recoveryAcceptedEpoch: 0, recoveryEpoch: 0,
    kaeruHeader: null, adb: null, unlockSubmitted: null, receipts: [], stageProgress: {},
  });
}

/** Grants a chosen device through the real single-owner claim path. */
function chooserFor(device) {
  return { request: async () => device, open: async () => ({ device: DEVICE, client: device.client }) };
}

// ---------------------------------------------------------------------------
// A. the four facts must all come from the device
// ---------------------------------------------------------------------------

test('a valid TWRP+Kaeru device is accepted and bound as an unlocked identity', async () => {
  blankPage();
  const session = twrpDevice();
  const identity = await app.startFromRecovery(chooserFor(session));

  assert.equal(identity.serialRaw, SERIAL);
  assert.equal(identity.profile.board, 'radar_puffin');
  assert.equal(identity.unlockStatus, 'true');
  assert.equal(identity.source, 'recovery');
  assert.equal(identity.serialMasked, '••••' + SERIAL.slice(-4));
  // The session is bound exactly as claimRecoveryDevice binds it, so every
  // existing gate treats this as a normal accepted recovery.
  assert.equal(app.state.adb, session.client);
  assert.equal(app.state.recoverySerial, SERIAL);
  assert.equal(app.state.kaeruHeader, HEADER_HEX);
  assert.equal(app.state.recoverySession.client, session.client);
  assert.deepEqual(session.records.flashes, [], 'the recovery entry flashed anything');
});

test('the Kaeru header is read from the device and required', async () => {
  blankPage();
  // readKaeruHeader's own geometry/magic checks are unchanged; this only proves
  // the entry goes through it rather than assuming a header exists.
  await assert.rejects(
    app.startFromRecovery(chooserFor(twrpDevice({ header: '00 ' + HEADER.slice(3) }))),
    /Kaeru LK header|expdb/,
  );
  assert.equal(app.state.identity, null, 'a refused device left an identity behind');
  await assert.rejects(
    app.startFromRecovery(chooserFor(twrpDevice({ expdb: 'PARTNAME=userdata', sectors: '20480' }))),
    /Kaeru|expdb/,
  );
  assert.equal(app.state.identity, null);
});

// ---------------------------------------------------------------------------
// B. the four refusals
// ---------------------------------------------------------------------------

const REFUSALS = [
  { name: 'a missing serial', device: { serial: '' }, pattern: /no serial|refusing to identify/i },
  { name: 'an unknown board', device: { board: 'pineapple' }, pattern: /not a LibreEcho target/i },
  { name: 'a missing Kaeru header', device: { header: 'de ad be ef 88 16 88 58 70 b2 03 00 4c 4b 00 00' }, pattern: /Kaeru LK header/i },
  { name: 'no TWRP running', device: { twrp: '' }, pattern: /TWRP is not running/i },
];

for (const { name, device, pattern } of REFUSALS) {
  test(`${name} is refused and leaves no identity`, async () => {
    blankPage();
    const session = twrpDevice(device);
    await assert.rejects(app.startFromRecovery(chooserFor(session)), pattern);
    assert.equal(app.state.identity, null, `${name} left a partial identity`);
    assert.equal(app.state.adb, null, `${name} left an ADB session bound`);
    assert.equal(app.state.kaeruHeader, null, `${name} left a Kaeru header bound`);
    assert.ok(session.records.closed > 0, `${name} left the USB interface open`);
    assert.deepEqual(session.records.flashes, [], `${name} wrote to the device`);
  });
}

test('an unrecognised board is refused even when a serial and header are perfect', async () => {
  blankPage();
  const session = twrpDevice({ board: 'raspberrypi' });
  await assert.rejects(app.startFromRecovery(chooserFor(session)), /not a LibreEcho target/);
  assert.equal(app.state.identity, null);
});

test("Biscuit's omni codename is recognised, and nothing else is", async () => {
  blankPage();
  for (const [device, board] of [['omni_biscuit', 'biscuit'], ['biscuit', 'biscuit']]) {
    const identity = await app.startFromRecovery(chooserFor(twrpDevice({ board: device })));
    assert.equal(identity.profile.board, board, `${device} was not recognised`);
    blankPage();
  }
});

test('the entry refuses to replace an identity that already exists', async () => {
  blankPage();
  app.state.identity = { product: 'RADAR', serialRaw: 'OTHER', unlockStatus: 'true', profile: {} };
  await assert.rejects(
    app.startFromRecovery(chooserFor(twrpDevice())),
    /already identified/,
  );
});

test('a cancelled chooser changes nothing', async () => {
  blankPage();
  const result = await app.startFromRecovery({
    request: async () => { const error = new Error('no device selected'); error.name = 'NotFoundError'; throw error; },
    open: async () => { throw new Error('the entry opened a device after a cancelled chooser'); },
  });
  assert.equal(result, null);
  assert.equal(app.state.identity, null);
});

test('the chooser is VID:PID-only, never unfiltered, when there is no serial yet', () => {
  assert.deepEqual(recoveryChooserFilters({ serial: null }),
    [{ vendorId: 0x18d1, productId: 0x4ee2 }]);
});

// ---------------------------------------------------------------------------
// C. runInstall takes the resumed path and never sends flash:brick
// ---------------------------------------------------------------------------

test('runInstall proceeds past recovery without ever calling flash:brick', withLocalStorage(async () => {
  blankPage({ board: 'radar_puffin', buildReady: true });
  const session = twrpDevice();
  await app.startFromRecovery(chooserFor(session));

  // The release gates runInstall already enforces, primed exactly as the v2
  // direct-userdata path requires. Nothing here stubs a gate away.
  const prefix = 'libreecho-radar-puffin';
  const roles = [
    ['transfer:boot', `${prefix}-boot.img`, 'boot-bytes'],
    ['transfer:ota-manifest', 'manifest', 'signed'],
    ['transfer:ota-signature', 'manifest.sig', 'sig'],
    ['transfer:local-package', `${prefix}.ota.tar`, 'ota'],
    ['staging:airplay2:payload', `${prefix}-airplay2.squashfs`, 'payload'],
    ['staging:airplay2:manifest', `${prefix}-airplay2.manifest.json`, 'fm'],
  ];
  const files = new Map();
  const sums = new Map();
  for (const [, name, content] of roles) {
    const blob = new Blob([content]); blob.name = name;
    files.set(name, blob);
    sums.set(name, Buffer.from(content).toString('hex').padEnd(64, '0'));
  }
  const digestOf = (name) => sums.get(name);
  const bootName = `${prefix}-boot.img`;
  const otaName = `${prefix}.ota.tar`;
  const payloadName = `${prefix}-airplay2.squashfs`;
  const featureName = `${prefix}-airplay2.manifest.json`;
  const manifestText = [
    'schema=1', 'protocol=2', 'release=radar-puffin-build-test', 'device=radar_puffin',
    'target=radar_puffin', 'fastboot_products=RADAR',
    `transfer=boot:${bootName}:${digestOf(bootName)}`,
    `transfer=ota-manifest:manifest:${digestOf('manifest')}`,
    `transfer=ota-signature:manifest.sig:${digestOf('manifest.sig')}`,
    `transfer=local-package:${otaName}:${digestOf(otaName)}`,
    `staging=airplay2:${payloadName}:${digestOf(payloadName)}:${featureName}:${digestOf(featureName)}`,
  ].join('\n');
  const directRoles = roles.map(([role, name]) => ({ role, name, sha256: sums.get(name), size: files.get(name).size }));
  Object.assign(app.state, {
    target: { board: 'radar_puffin', slug: 'radar-puffin', prefix, legacy: false },
    files, sums, bundleReady: true, bundleBoard: 'radar_puffin', bundleHardwareAccepted: true,
    installProtocol: 2, directRelease: 'radar-puffin-build-test',
    directManifestText: manifestText, directManifestSha: 'a'.repeat(64),
    directHelper: new TextEncoder().encode('#!/bin/sh\n'),
    directRoles, directTransferTotal: directRoles.reduce((sum, role) => sum + role.size, 0),
    downloadedBundle: null,
  });

  await app.runInstall({ dryRun: false, recovery: {
    timeoutMs: 60, intervalMs: 5, grantedDevices: async () => [],
    // Any attempt to reach the recovery wait would mean the resumed path was
    // NOT taken, so this fails loudly instead of silently opening a second time.
    open: async () => { throw new Error('runInstall re-entered the recovery wait'); },
  } });

  assert.deepEqual(session.records.flashes, [],
    'flash:brick was submitted to a device that entered through recovery');
  assert.equal(app.state.unlockSubmitted, null, 'the entry latched an unlock submission');
  // It got past recovery and into the transfer phase on the already-bound session.
  assert.ok(session.records.shell.some((command) => command.includes('--phase prepare')),
    'the run never reached the prepare phase');
  assert.match(app.terminal.plainText(), /continuing from verified recovery/i);
}));

test('the unlock stage is never offered for a recovery-entered device', async () => {
  blankPage();
  await app.startFromRecovery(chooserFor(twrpDevice()));
  // The Amonet panel is hidden and its inputs disabled — there is no ZIP path.
  assert.equal(elements.get('amonet-panel').hidden, true);
  assert.equal(elements.get('payload-input').disabled, true);
  assert.equal(elements.get('amonet-archive-input').disabled, true);
  assert.match(elements.get('amonet-route').textContent, /no Amonet unlock ZIP needed/i);
  // With the accepted-recovery skip removed the route still skips on its own,
  // because a recovery-entered device is unlocked by construction. Proved by
  // dropping the bound session so the first branch cannot apply.
  app.state.kaeruHeader = null;
  app.refreshControls();
  assert.match(elements.get('amonet-route').textContent, /already unlocked/i);
  assert.equal(elements.get('payload-input').disabled, true);
});

// ---------------------------------------------------------------------------
// D. the unchanged release gates still block before any write
// ---------------------------------------------------------------------------

test('a board mismatch against the selected build blocks before any write', withLocalStorage(async () => {
  blankPage({ board: 'biscuit', buildReady: true });
  const session = twrpDevice({ board: 'radar_puffin' });
  await app.startFromRecovery(chooserFor(session));
  assert.equal(app.state.identity.profile.board, 'radar_puffin');

  // A Biscuit-targeted build is selected against a Radar device.
  Object.assign(app.state, {
    target: { board: 'biscuit', slug: 'biscuit', prefix: 'libreecho-biscuit', legacy: false },
    files: new Map([['x', new Blob(['x'])]]), sums: new Map([['x', '0'.repeat(64)]]),
    bundleReady: true, bundleBoard: 'biscuit', bundleHardwareAccepted: true, installProtocol: 2,
    directRelease: 'r', directManifestText: 'protocol=2', directManifestSha: 'a'.repeat(64),
    directHelper: new Uint8Array([1]), directRoles: [], directTransferTotal: 0,
  });

  await app.runInstall({ dryRun: false, recovery: {
    timeoutMs: 60, intervalMs: 5, grantedDevices: async () => [],
    open: async () => { throw new Error('a board mismatch opened a device'); },
  } });

  assert.deepEqual(session.records.flashes, [], 'a board mismatch still submitted flash:brick');
  assert.ok(session.records.pushes.length === 0, 'a board mismatch pushed a payload to the device');
  assert.match(app.terminal.plainText(), /identity stage failed: release board mismatch/i);
  assert.ok(!session.records.shell.some((command) => command.includes('--phase prepare')),
    'the run reached a device write despite the board mismatch');
}));

// ---------------------------------------------------------------------------
// E. the affordances the operator actually sees
// ---------------------------------------------------------------------------

test('the recovery entry is the status-bar action when no identity exists', () => {
  // Everything the earlier primary actions ask for is present: device, build and
  // a verified download. The only thing left is the device itself.
  blankPage({ board: 'radar_puffin', buildReady: true });
  app.state.board = 'radar_puffin';
  app.state.bundleReady = true;
  app.refreshControls();
  const label = elements.get('status-bar-action').dataset.actionLabel ?? '';
  assert.match(label, /already in recovery/i);
  assert.equal(elements.get('status-bar-action-row').hidden, false);
  // The step-3 button exists and is enabled in exactly this state.
  assert.equal(elements.get('btn-recovery-entry').disabled, false);
});

test('the recovery entry closes once a device is identified', () => {
  blankPage();
  app.refreshControls();
  assert.equal(elements.get('btn-recovery-entry').disabled, false);
  app.state.identity = { product: 'RADAR', serialRaw: 'X', unlockStatus: 'true',
    profile: { board: 'radar_puffin', marketing: 'Echo', libreEcho: 'ref', userdataContractSectors: [] } };
  app.refreshControls();
  assert.equal(elements.get('btn-recovery-entry').disabled, true,
    'the recovery entry stayed open next to an identified device');
});

test('the device panel says found in recovery and masks the serial in the log', async () => {
  blankPage();
  await app.startFromRecovery(chooserFor(twrpDevice()));
  const panel = elements.get('device-panel');
  const rows = panel.children.map((row) => row.querySelector('strong')?.textContent ?? '').join('\n');
  assert.match(rows, /read from the running TWRP/);
  assert.match(rows, /Kaeru LK header intact/);
  // The log never carries the full serial; the panel does.
  const log = app.terminal.plainText();
  assert.ok(!log.includes(SERIAL), 'the full serial leaked into the log');
  assert.match(log, /••••/);
  assert.match(log, /found in recovery/i);
});