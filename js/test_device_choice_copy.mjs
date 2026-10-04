// R4 (UX, copy only): with no identity, card 3 must say WHICH button to press.
//
// The live 2026-10-03 page presented three buttons with nothing to say when each
// applied, so an operator whose Echo was sitting in TWRP pressed "Query device",
// watched every getvar time out, and had no way to tell that the recovery entry
// beside it was the one that worked. Card 3 now names the two states the Echo can
// be in — fastboot (first install) and already in recovery — points each at its
// own button, and the USB permission grant is hidden unless a wait for TWRP is
// actually running.
//
// Nothing here changes a gate: it asserts only what the operator can read and
// press. Deterministic DOM only — no USB, no chooser, no adb, no fastboot.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

function blankPage({ identity = null, recoveryWaiting = false } = {}) {
  Object.assign(app.state, {
    releases: [], release: null, board: null, target: null, targetsJson: null, sums: null,
    files: new Map(), payloadBytes: null, payloadName: '', fastboot: null, identity,
    deviceQueryEpoch: 0, adb: null, recoverySerial: null, kaeruHeader: null, receipts: [],
    bundleReady: false, bundleBoard: null, bundleHardwareAccepted: false, installProtocol: null,
    running: false, abort: false, fetchingBundle: false, downloadedBundle: null,
    recoveryWaiting, recoveryDeadline: null, recoveryAbort: null,
    recoveryGrantInFlight: false, recoveryChooserWide: false, recoveryAlreadyGranted: false,
    recoverySession: null, recoveryAcceptedEpoch: 0, recoveryEpoch: 0,
    unlockSubmitted: null, stageProgress: {},
  });
}

// ---------------------------------------------------------------------------
// A. the card names both states and points each at its own button
// ---------------------------------------------------------------------------

test('card 3 names both possible Echo states and which button each one uses', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  // The two labels the operator actually has to choose between.
  assert.match(html, /Echo is in fastboot \(first install\)/,
    'the fastboot choice is not named');
  assert.match(html, /Echo is already in recovery/,
    'the recovery choice is not named');
  // Each must be tied to the button that works for it, by the real label.
  assert.match(html, /Echo is in fastboot \(first install\)[\s\S]*?Query device \(read-only fastboot\)/,
    'the fastboot choice does not point at the query button');
  assert.match(html, /Echo is already in recovery[\s\S]*?My Echo is already in recovery/,
    'the recovery choice does not point at the recovery entry');
  // And the distinction has to be a physical one the operator can recognise.
  assert.match(html, /fastboot mode/, 'the fastboot screen is not described');
  assert.match(html, /TWRP/, 'the recovery screen is not described');
});

test('the two choices are shown while no device is identified', () => {
  blankPage({ identity: null });
  app.refreshControls();

  assert.equal(elements.get('device-mode-choice').hidden, false,
    'the choice prompt was hidden with no identity');
  assert.equal(elements.get('choice-fastboot').hidden, false);
  assert.equal(elements.get('choice-recovery').hidden, false);
  assert.equal(elements.get('device-mode-choice-done').hidden, true,
    'the "already identified" note was shown before anything was identified');
});

test('the two choices retire once a device is identified', () => {
  blankPage({ identity: {
    product: 'RADAR', unlockStatus: 'true', serialRaw: 'RADAR-DOT', profile: PROFILE,
  } });
  app.refreshControls();

  assert.equal(elements.get('device-mode-choice').hidden, true,
    'the mode choice stayed up after the device was identified');
  assert.equal(elements.get('choice-fastboot').hidden, true);
  assert.equal(elements.get('choice-recovery').hidden, true);
  assert.equal(elements.get('device-mode-choice-done').hidden, false,
    'nothing told the operator that step 3 is finished');
});

// ---------------------------------------------------------------------------
// B. the grant button exists only while a wait for TWRP is running
// ---------------------------------------------------------------------------

test('the USB permission grant is hidden unless a wait for TWRP is running', () => {
  blankPage({ recoveryWaiting: false });
  app.refreshControls();
  assert.equal(elements.get('btn-grant-recovery').hidden, true,
    'the grant button looked like a fourth choice with no wait running');

  blankPage({ recoveryWaiting: true });
  app.refreshControls();
  assert.equal(elements.get('btn-grant-recovery').hidden, false,
    'the grant button stayed hidden during the one state it exists for');
});

test('an empty fastboot identity leaves both choices visible', () => {
  // The refusal path clears state.identity, so the operator is back at exactly
  // the choice this card exists to disambiguate — it must not be left hidden.
  blankPage({ identity: null });
  app.refreshControls();
  assert.equal(elements.get('choice-fastboot').hidden, false);
  assert.equal(elements.get('choice-recovery').hidden, false);
  assert.equal(elements.get('btn-recovery-entry').disabled, false,
    'the recovery choice was left disabled after a query read nothing');
});