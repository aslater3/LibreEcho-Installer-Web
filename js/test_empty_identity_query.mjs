// R3: a fastboot query that read NOTHING must not be remembered as an identity.
//
// The live 2026-10-03 failure stored a completely empty identity from a device
// that was answering ADB. The consequences were all downstream of that one fact:
//   - the status bar said "Install is not available yet: fastboot serialno is
//     missing", so install looked broken rather than un-attempted;
//   - the "My Echo is already in recovery" entry refused with "a device is
//     already identified", the one entry that could have unblocked the operator;
//   - the page could only be recovered by reloading, losing every verified
//     artifact.
//
// So a query whose product AND serialno are both empty must close the session,
// leave state.identity null, say what happened and keep the recovery entry
// available. Deterministic fakes only — no USB, no chooser, no adb.

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

function blankPage() {
  Object.assign(app.state, {
    releases: [], release: null, board: null, target: null, targetsJson: null, sums: null,
    files: new Map(), payloadBytes: null, payloadName: '', fastboot: null, identity: null,
    deviceQueryEpoch: 0, adb: null, recoverySerial: null, kaeruHeader: null, receipts: [],
    bundleReady: false, bundleBoard: null, bundleHardwareAccepted: false, installProtocol: null,
    running: false, abort: false, fetchingBundle: false, downloadedBundle: null,
    recoveryWaiting: false, recoveryDeadline: null, recoveryAbort: null,
    recoveryGrantInFlight: false, recoveryChooserWide: false, recoveryAlreadyGranted: false,
    recoverySession: null, recoveryAcceptedEpoch: 0, recoveryEpoch: 0,
    unlockSubmitted: null, stageProgress: {},
  });
}

/** A client that answers nothing at all — adbd talking to a fastboot client. */
function silentClient({ serialno = '', product = '' } = {}) {
  const client = {
    closes: 0,
    getVar: async (key) => {
      if (key === 'serialno') return serialno;
      if (key === 'product') return product;
      throw new Error('The transfer was cancelled');
    },
  };
  client.close = async () => { client.closes += 1; };
  return client;
}

test('a query that read nothing stores no identity and leaves the recovery entry available', async () => {
  blankPage();
  const client = silentClient();

  await assert.rejects(
    app.queryDevice({
      open: async () => ({ device: { vendorId: 0x18d1, productId: 0x4ee2 }, client }),
    }),
    /did not answer fastboot/i,
  );

  // The wedge itself: an empty identity must not survive the query.
  assert.equal(app.state.identity, null, 'an empty identity was stored');
  assert.equal(app.state.fastboot, null, 'a closed session was left bound');
  assert.equal(client.closes, 1, 'the session must be closed, not left holding the interface');
  assert.equal(elements.get('device-panel').children.length, 0, 'a device panel was rendered');
  assert.equal(elements.get('status-device').textContent, 'did not answer');

  // The operator must be told, in the log and on the sticky bar, and told WHY
  // the recovery entry is the right next move. Checked BEFORE any repaint: the
  // refusal is published last on purpose, so a later refreshControls would
  // legitimately replace it with the generic stage message.
  const log = app.terminal.plainText();
  assert.match(log, /the device did not answer fastboot/i);
  assert.match(log, /My Echo is already in recovery/);
  assert.match(elements.get('status-bar-message').textContent, /already in recovery/i);

  // And the entry that unblocks the operator must still be offered, both as
  // the enabled step-3 button and as the status-bar action. The bar action is
  // only the recovery entry once a device and a build are chosen — before that
  // the page correctly asks for a device first.
  app.refreshControls();
  assert.equal(elements.get('btn-recovery-entry').disabled, false,
    'the recovery entry was disabled after an empty query');
  app.state.board = 'radar_puffin';
  app.state.release = { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' };
  app.state.bundleReady = true;
  app.refreshControls();
  assert.match(elements.get('status-bar-action').dataset.actionLabel ?? '', /already in recovery/i);
});

test('the empty-identity refusal is a StageError the run reports as a device failure', async () => {
  blankPage();
  await assert.rejects(
    app.queryDevice({ open: async () => ({ device: { vendorId: 0x18d1, productId: 0x4ee2 }, client: silentClient() }) }),
    (error) => {
      assert.equal(error.name, 'StageError');
      assert.equal(error.stage, 'device');
      return true;
    },
  );
});

test('a query that read a serial but no product is still an identity', async () => {
  blankPage();
  // Only BOTH empty is a refusal. A bootloader that reports a serial and an
  // unrecognised product is a real device whose identity must be kept, so
  // assessIdentity can report it honestly.
  const identity = await app.queryDevice({
    open: async () => ({ device: { vendorId: 0x0bb4, productId: 0x0c01 },
      client: { getVar: async (key) => (key === 'serialno' ? 'SERIAL-ONLY' : '') } }),
  });
  assert.equal(identity.serialRaw, 'SERIAL-ONLY');
  assert.equal(app.state.identity.serialRaw, 'SERIAL-ONLY');
});

test('an empty query leaves no stale unlock decision behind', async () => {
  blankPage();
  app.state.payloadBytes = new Uint8Array([1, 2, 3]);
  app.state.payloadName = 'old.img';
  await assert.rejects(
    app.queryDevice({ open: async () => ({ device: { vendorId: 0x18d1, productId: 0x4ee2 }, client: silentClient() }) }),
    /did not answer fastboot/i,
  );
  assert.equal(app.state.payloadBytes, null, 'a payload survived a query that read nothing');
  assert.equal(app.state.payloadName, '');
});