// R2: ONE page-wide USB owner.
//
// The live 2026-10-03 failure ran two USB operations against the same physical
// interface: the fastboot query (queryDevice → openFastboot, which never touched
// the per-device recovery claim registry) opened 18d1:4ee2 while the recovery
// entry's ADB transport opened the same USBDevice. Two opens, two handshakes,
// one cable. The log showed "fastboot interface claimed on 6353:20194" (=18d1:
// 4ee2) followed by "ADB timeout after 30000 ms while connect".
//
// The fix is a page-wide slot: while one of queryDevice, startFromRecovery,
// grantRecovery or a recovery poll round runs, the others refuse IMMEDIATELY with
// a terminal warning and a status-bar message. No queueing, no second open.
//
// Deterministic barriers only — no USB, no chooser, no adb, no fastboot.

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
globalThis.window = { isSecureContext: false, location: { search: '', origin: 'https://localhost' } };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { usb: {
    getDevices: async () => [],
    requestDevice: async () => { throw new Error('a test opened a real chooser'); },
  } },
});
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
const app = await import('./app.js');

const PROFILE = {
  id: 'radar', product: 'RADAR', marketing: 'Amazon Echo', board: 'radar_puffin',
  libreEcho: 'stable', userdataContractSectors: [20480],
};

function blankPage() {
  Object.assign(app.state, {
    releases: [], release: null, board: null, target: null, targetsJson: null, sums: null,
    files: new Map(), payloadBytes: null, payloadName: '', fastboot: null, identity: null,
    deviceQueryEpoch: 0, adb: null, recoverySerial: null, kaeruHeader: null, receipts: [],
    bundleReady: false, bundleBoard: null, bundleHardwareAccepted: false, installProtocol: null,
    running: false, abort: false, fetchingBundle: false, downloadedBundle: null,
    recoveryWaiting: false, recoveryDeadline: null, recoveryAbort: null,
    recoveryGrantInFlight: false, recoveryChooserWide: false, recoveryAlreadyGranted: false,
    recoverySession: null, recoverySerial: null, recoveryAcceptedEpoch: 0, recoveryEpoch: 0,
    unlockSubmitted: null, stageProgress: {},
  });
}

/** A barrier an entry point can be parked on, to prove it is still in flight. */
function gate() {
  let open;
  let entered;
  const reached = new Promise((resolve) => { entered = resolve; });
  const promise = new Promise((resolve) => { open = resolve; });
  return {
    reached,
    release: (value) => open(value),
    async enter() { entered(); return promise; },
  };
}

// ---------------------------------------------------------------------------
// A. entry in flight -> queryDevice refuses without opening
// ---------------------------------------------------------------------------

test('with the recovery entry in flight, queryDevice refuses without opening anything', async () => {
  blankPage();
  const parked = gate();
  const entryChooserCalled = [];
  const entry = app.startFromRecovery({
    request: async () => {
      entryChooserCalled.push('chooser');
      return { vendorId: 0x18d1, productId: 0x4ee2, serialNumber: 'TEST-SERIAL' };
    },
    // Parked mid-open: the entry is provably in flight from here on.
    open: async () => { await parked.enter(); return { device: {}, client: {} }; },
  });
  await tick(1);
  assert.deepEqual(entryChooserCalled, ['chooser'], 'the entry never reached its chooser');

  let fastbootOpened = 0;
  const result = await app.queryDevice({
    open: async () => { fastbootOpened += 1; throw new Error('queryDevice opened a device'); },
  });

  assert.equal(fastbootOpened, 0, 'queryDevice opened a USB device while the entry held the page');
  assert.equal(result, null, 'a refused query must report no identity');
  assert.equal(app.state.identity, null, 'a refused query stored an identity');
  const log = app.terminal.plainText();
  assert.match(log, /Query device refused/i);
  assert.match(log, /already in recovery/i, 'the refusal must name the operation that owns the page');
  assert.match(log, /Only one USB connection is opened at a time/i);

  // The refusal must also reach the sticky status bar, not only the log.
  assert.match(elements.get('status-bar-message').textContent, /already in recovery/i);

  parked.release({ device: {}, client: {} });
  await entry.catch(() => { /* the parked probe fails on a fake client */ });
});

test('with a fastboot query in flight, startFromRecovery refuses without asking the browser', async () => {
  blankPage();
  const parked = gate();
  const query = app.queryDevice({ open: async () => { await parked.enter(); return { device: {}, client: {} }; } });
  await parked.reached;

  let chooserCalls = 0;
  let openCalls = 0;
  const result = await app.startFromRecovery({
    request: async () => { chooserCalls += 1; return { vendorId: 0x18d1, productId: 0x4ee2 }; },
    open: async () => { openCalls += 1; throw new Error('the entry opened a device'); },
  });

  assert.equal(chooserCalls, 0, 'startFromRecovery opened a browser chooser');
  assert.equal(openCalls, 0, 'startFromRecovery opened a device');
  assert.equal(result, null, 'a refused entry must report no identity');
  assert.equal(app.state.identity, null);
  assert.match(app.terminal.plainText(), /already in recovery refused/i);
  assert.match(elements.get('status-bar-message').textContent, /Query device/i);

  parked.release({ device: {}, client: {} });
  await query.catch(() => { /* the parked probe fails on a fake client */ });
});

// ---------------------------------------------------------------------------
// B. the guard is released on every path, and re-entrancy is not blocked
// ---------------------------------------------------------------------------

test('the slot is released after a successful query, so the entry works next', async () => {
  blankPage();
  const values = { product: 'RADAR', unlock_status: 'true', serialno: 'RADAR-DOT' };
  const client = { getVar: async (key) => values[key] ?? '' };
  const identity = await app.queryDevice({
    open: async () => ({ device: { vendorId: 0x0bb4, productId: 0x0c01 }, client }),
  });
  assert.equal(identity.serialRaw, 'RADAR-DOT');
  // The identity exists, so the entry refuses for its OWN reason — proving the
  // refusal is the "already identified" StageError, not a stuck guard.
  await assert.rejects(
    app.startFromRecovery({ request: async () => ({}), open: async () => ({}) }),
    /already identified/,
  );
});

test('the slot is released after a query that threw', async () => {
  blankPage();
  await assert.rejects(
    app.queryDevice({ open: async () => { throw new Error('no device selected'); } }),
    /no device selected/,
  );
  // A released slot means the next query runs rather than being refused.
  const values = { product: 'RADAR', unlock_status: 'true', serialno: 'SECOND' };
  const identity = await app.queryDevice({
    open: async () => ({ device: { vendorId: 0x0bb4, productId: 0x0c01 },
      client: { getVar: async (key) => values[key] ?? '' } }),
  });
  assert.equal(identity.serialRaw, 'SECOND');
});

test('a second query is superseded, never refused — the epoch contract still owns it', async () => {
  blankPage();
  const parked = gate();
  const older = app.queryDevice({ open: async () => { await parked.enter(); return { device: {}, client: {} }; } });
  await parked.reached;

  const values = { product: 'RADAR', unlock_status: 'true', serialno: 'NEWER' };
  await app.queryDevice({
    open: async () => ({ device: { vendorId: 0x0bb4, productId: 0x0c01 },
      client: { getVar: async (key) => values[key] ?? '' } }),
  });

  parked.release({ device: {}, client: {} });
  await assert.rejects(older, /superseded/);
  assert.equal(app.state.identity.serialRaw, 'NEWER', 'the older query bound over the newer one');
});

// ---------------------------------------------------------------------------
// C. the buttons the operator can see
// ---------------------------------------------------------------------------

test('every USB-opening control is disabled while one operation is in flight', async () => {
  blankPage();
  app.refreshControls();
  for (const id of ['btn-connect', 'btn-connect-any', 'btn-grant-recovery', 'btn-recovery-entry']) {
    assert.equal(elements.get(id).disabled, false, `${id} was disabled with nothing in flight`);
  }

  const parked = gate();
  const entry = app.startFromRecovery({
    request: async () => ({ vendorId: 0x18d1, productId: 0x4ee2, serialNumber: 'TEST-SERIAL' }),
    open: async () => { await parked.enter(); return { device: {}, client: {} }; },
  });
  await tick(1);
  app.refreshControls();

  for (const id of ['btn-connect', 'btn-connect-any', 'btn-grant-recovery', 'btn-recovery-entry']) {
    assert.equal(elements.get(id).disabled, true,
      `${id} stayed live while the recovery entry held the page's USB connection`);
  }

  parked.release({ device: {}, client: {} });
  await entry.catch(() => {});
  app.refreshControls();
  assert.equal(elements.get('btn-connect').disabled, false, 'the query button stayed dead after release');
});

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));