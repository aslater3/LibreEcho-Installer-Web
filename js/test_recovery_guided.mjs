// Guided one-click recovery permission: filter construction, the never-automatic
// wider fallback, the silent already-granted probe, and the status-bar copy the
// operator actually reads. Deterministic fakes only — no device, no USB, no
// chooser is ever opened against a real browser.

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
  set scrollHeight(value) { this._scrollHeight = value; }
  get scrollHeight() { return this._scrollHeight ?? 0; }
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

const HEADER = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const TWRP = { vendorId: 0x18d1, productId: 0x4ee2, serialNumber: 'TEST-DOT' };
const PROFILE = {
  id: 'biscuit', product: 'BISCUIT', marketing: 'Echo Dot', board: 'biscuit',
  libreEcho: 'experimental', userdataContractSectors: [2137088],
  lkBuildMap: { '63cb91b-20221007_072309': { payload: 'test.img', size: 3, sha256: 'a'.repeat(64) } },
};

function setup({ alreadyGranted = [] } = {}) {
  app.state.release = { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' };
  app.state.board = 'biscuit';
  app.state.identity = { product: 'BISCUIT', unlockStatus: 'false', profile: PROFILE,
    lkBuild: '63cb91b-20221007_072309', serialRaw: 'TEST-DOT' };
  app.state.adb = null;
  app.state.recoverySerial = null;
  app.state.kaeruHeader = null;
  app.state.abort = false;
  app.state.running = false;
  app.state.bundleReady = true;
  app.state.bundleBoard = 'biscuit';
  app.state.bundleHardwareAccepted = true;
  app.state.installProtocol = 2;
  app.state.payloadBytes = new Uint8Array([1, 2, 3]);
  app.state.payloadName = 'test.img';
  app.state.recoveryWaiting = true;
  app.state.recoveryDeadline = Date.now() + 600000;
  app.state.recoveryAbort = null;
  app.state.recoveryGrantInFlight = false;
  app.state.recoveryChooserWide = false;
  app.state.recoveryAlreadyGranted = false;
  app.state.recoverySession = null;
  app.state.recoveryEpoch = 0;
  app.state.unlockSubmitted = 'TEST-DOT';
}

function twrpSession({ serial = 'TEST-DOT', board = 'biscuit' } = {}) {
  const client = {
    shell: async (command) => ({ stdout:
      command.includes('ro.twrp.version') ? `3.7.0_9-0\n${board}\n${serial}\n`
        : command.includes('uevent') ? 'PARTNAME=expdb\n'
          : command.includes('/size') ? '20480\n' : `${HEADER}\n` }),
    close: async () => {},
  };
  return { device: TWRP, client };
}

// --- filter construction ---------------------------------------------------

test('the recovery chooser filter names the exact device: VID:PID plus serial', () => {
  assert.deepEqual(recoveryChooserFilters({ serial: 'TEST-DOT' }),
    [{ vendorId: 0x18d1, productId: 0x4ee2, serialNumber: 'TEST-DOT' }]);
});

test('the recovery chooser is never unfiltered and never class-filtered', () => {
  for (const serial of ['TEST-DOT', '', '   ', null, undefined]) {
    const filters = recoveryChooserFilters({ serial });
    assert.equal(filters.length, 1, 'the chooser must list exactly one USB identity');
    for (const filter of filters) {
      assert.ok(Number.isInteger(filter.vendorId) && Number.isInteger(filter.productId),
        'the filter must stay scoped to recovery VID:PID');
      assert.equal(filter.vendorId, 0x18d1);
      assert.equal(filter.productId, 0x4ee2);
      // deviceClass is never usable: these devices report class 0.
      assert.equal('deviceClass' in filter, false);
      assert.equal('classCode' in filter, false);
    }
  }
});

test('the wider fallback keeps VID:PID and drops only the serial', () => {
  assert.deepEqual(recoveryChooserFilters({ serial: 'TEST-DOT', wide: true }),
    [{ vendorId: 0x18d1, productId: 0x4ee2 }]);
  // Widening must not widen into "every USB device on this machine".
  assert.equal(recoveryChooserFilters({ serial: null, wide: true }).length, 1);
});

// --- the grant path uses the narrow filter first --------------------------

test('the first grant asks for the narrow serial filter', async () => {
  setup();
  const seen = [];
  await app.grantRecovery({
    request: (options) => { seen.push(options); return Promise.resolve(TWRP); },
    requestWide: (options) => { seen.push({ ...options, wide: true }); return Promise.resolve(TWRP); },
    open: async () => twrpSession(),
  });
  assert.equal(seen.length, 1, 'the chooser was opened more than once for one click');
  assert.deepEqual(seen[0], { serial: 'TEST-DOT' });
  assert.equal(app.state.recoverySerial, 'TEST-DOT');
});

test('a refused narrow device offers the wider list, and only the next press uses it', async () => {
  setup();
  const seen = [];
  // First press: a device that is not this one. The wide list is OFFERED, not used.
  const first = await app.grantRecovery({
    request: (options) => { seen.push({ wide: false, ...options }); return Promise.resolve(TWRP); },
    requestWide: (options) => { seen.push({ wide: true, ...options }); return Promise.resolve(TWRP); },
    // A wrong ADB serial is refused by the authoritative gate.
    open: async () => twrpSession({ serial: 'SOME-OTHER-DOT' }),
  });
  assert.equal(first, null, 'a wrong-serial recovery device was accepted');
  assert.equal(seen.length, 1, 'the wider chooser was opened without a second click');
  assert.equal(app.state.recoveryChooserWide, true, 'the wider list was not offered after a refusal');

  // Second press: now the wider list is used, and it still only carries VID:PID.
  const second = await app.grantRecovery({
    request: (options) => { seen.push({ wide: false, ...options }); return Promise.resolve(TWRP); },
    requestWide: (options) => { seen.push({ wide: true, ...options }); return Promise.resolve(TWRP); },
    open: async () => twrpSession(),
  });
  assert.equal(second.client !== undefined, true, 'the retry did not bind the chosen device');
  assert.deepEqual(seen[1], { wide: true, serial: 'TEST-DOT' });
});

test('cancelling the chooser leaves the wait intact and does not widen the next list', async () => {
  setup();
  const cancel = Object.assign(new Error('no device selected'), { name: 'NotFoundError' });
  const refused = await app.grantRecovery({ request: () => Promise.reject(cancel) });
  assert.equal(refused, null);
  assert.equal(app.state.recoveryGrantInFlight, false, 'a cancelled chooser left the grant flag set');
  assert.equal(app.state.recoveryChooserWide, false,
    'a cancellation silently widened the chooser');
  assert.equal(app.state.adb, null);

  const session = twrpSession();
  const granted = await app.grantRecovery({ request: () => Promise.resolve(TWRP), open: async () => session });
  assert.equal(granted.client, session.client, 'the retry did not bind the chosen recovery device');
});

// --- the silent already-granted path --------------------------------------

test('an already-granted device needs no click at all', async () => {
  // A run that is genuinely waiting for TWRP: this is the state the operator
  // meets after the unlock submission returns.
  setup();
  app.state.running = true;
  app.state.recoveryWaiting = true;
  app.state.adb = null;
  app.refreshControls();
  const bar = elements.get('status-bar');
  assert.match(elements.get('status-bar-action').dataset.actionLabel ?? '', /Connect to your Echo/i);
  assert.equal(bar.dataset.kind, 'action');

  // The silent probe finds a permission this origin already holds (an earlier
  // run on the same device), so the button disappears and the poller takes over.
  app.state.recoveryAlreadyGranted = true;
  app.refreshControls();
  assert.equal(elements.get('status-bar-action-row').hidden, true,
    'the operator was still asked to click an already-permitted device');
  assert.match(elements.get('status-bar-message').textContent, /already has USB access/i);
});

test('a new recovery wait re-earns its prompt instead of trusting an old grant', async () => {
  setup({ alreadyGranted: [TWRP] });
  // Simulate the probe having succeeded on an earlier wait…
  app.state.recoveryAlreadyGranted = true;
  // …then a new wait begins: the prompt must come back.
  app.state.recoveryWaiting = false;
  app.state.recoveryAbort = null;
  await assert.rejects(app.awaitRecovery({ timeoutMs: 30, intervalMs: 5,
    grantedDevices: async () => [], open: async () => { throw new Error('must not open'); } }),
    /timed out|TWRP/i);
  assert.equal(app.state.recoveryAlreadyGranted, false,
    'a stale grant suppressed the prompt for a new wait');
});

// --- the copy the operator reads ------------------------------------------

test('the recovery prompt is jargon-free and explains the one required click', () => {
  setup();
  app.state.running = true;
  app.refreshControls();
  const message = elements.get('status-bar-message').textContent;
  const label = elements.get('status-bar-action').dataset.actionLabel ?? '';
  const hint = elements.get('status-bar-hint').textContent;
  assert.match(label, /^Connect to your Echo/);
  assert.match(message, /Chrome/, 'the prompt does not say where the device is chosen');
  assert.match(message, /continues by itself/i, 'the prompt does not say the install continues');
  assert.doesNotMatch(message, /CNXN|getvar|interface|ADBD|open the shell/);
  assert.match(hint, /15 seconds|15s/, 'the prompt does not say how long the device takes to appear');
  assert.match(hint, /updates by itself|by itself/i);
  // TWRP may appear only as a small secondary line.
  assert.equal(/TWRP/.test(message), false, 'TWRP jargon leaked into the main prompt');
});

test('the recovery button takes focus, because the gesture needs a fresh click', () => {
  setup();
  app.state.running = true;
  const button = elements.get('status-bar-action');
  button.focused = 0;
  app.refreshControls();
  assert.ok(button.focused > 0, 'the recovery button was not focused for the required gesture');
});