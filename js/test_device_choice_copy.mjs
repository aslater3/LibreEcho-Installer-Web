// Connection UX: one mode-aware action; protocol controls stay under Advanced.
// DOM fixture only: no USB, chooser, adb, fastboot or real browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
    resumeBoard: null, resumeReleaseTag: null, resumeUnlockSubmitted: false,
    resumeDeviceAmbiguous: false,
  });
}

test('card 3 offers one primary connect action without making users choose a USB mode', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const card = html.match(/<section[^>]*id="card-connect-device"[\s\S]*?<\/section>/)?.[0];
  assert.ok(card, 'connection card exists');
  const advanced = card.match(/<details[^>]*id="connect-advanced"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(advanced, 'advanced controls remain available');
  assert.doesNotMatch(advanced.split('>')[0], /\bopen(?:\s|=|$)/, 'Advanced starts closed');
  assert.equal((card.match(/id="btn-connect-resume"/g) ?? []).length, 1);
  assert.doesNotMatch(advanced, /id="btn-connect-resume"/, 'primary action is outside Advanced');
  for (const id of ['btn-connect', 'btn-connect-any', 'btn-recovery', 'btn-grant-recovery', 'btn-recovery-entry']) {
    assert.ok(advanced.includes(`id="${id}"`), `${id} stays under Advanced`);
  }
  assert.doesNotMatch(card, /id="(?:choice-fastboot|choice-recovery|device-mode-choice)"/);
  assert.match(card, /choose the USB device named “Echo”/);
  assert.match(card, /no fastboot is needed/);
  assert.equal((advanced.match(/<p(?:\s|>)/g) ?? []).length,
    (advanced.match(/<\/p>/g) ?? []).length, 'all Advanced paragraphs are closed');
});

test('the primary connect action is visible before identification', () => {
  blankPage();
  app.refreshControls();
  const button = elements.get('btn-connect-resume');
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Connect to your Echo');
});

test('fresh connection retires after identification', () => {
  blankPage({ identity: {
    product: 'RADAR', unlockStatus: 'true', serialRaw: 'RADAR-DOT', profile: PROFILE,
  } });
  app.refreshControls();
  assert.equal(elements.get('btn-connect-resume').hidden, true);
});

test('a saved transaction keeps the resume action visible after identification', () => {
  blankPage({ identity: {
    product: 'RADAR', unlockStatus: 'true', serialRaw: 'RADAR-DOT', profile: PROFILE,
  } });
  app.state.resumeBoard = 'radar_puffin';
  app.state.resumeReleaseTag = 'fixture-release';
  app.refreshControls();
  const button = elements.get('btn-connect-resume');
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Resume this install');
});

test('the USB permission grant is hidden unless a wait for TWRP is running', () => {
  blankPage({ recoveryWaiting: false });
  app.refreshControls();
  assert.equal(elements.get('btn-grant-recovery').hidden, true);
  blankPage({ recoveryWaiting: true });
  app.refreshControls();
  assert.equal(elements.get('btn-grant-recovery').hidden, false);
});

test('a query without identity leaves the primary action available', () => {
  blankPage();
  app.refreshControls();
  assert.equal(elements.get('btn-connect-resume').hidden, false);
  assert.equal(elements.get('btn-connect-resume').disabled, false);
  assert.equal(elements.get('btn-recovery-entry').disabled, false,
    'advanced recovery entry remains available after an empty query');
});
