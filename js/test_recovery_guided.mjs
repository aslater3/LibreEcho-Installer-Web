// Guided one-click recovery permission: filter construction, the
// VID:PID-only chooser, the silent already-granted probe, and the status-bar copy the
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

function setup() {
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
  app.state.recoveryOtherSerial = null;
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

test('the recovery chooser filter is the TWRP VID:PID only, never narrowed by serial', () => {
  // TWRP's USB serial can differ from the fastboot serial; a serial-narrowed
  // chooser then lists nothing and the operator has no device to pick.
  assert.deepEqual(recoveryChooserFilters({ serial: 'TEST-DOT' }),
    [{ vendorId: 0x18d1, productId: 0x4ee2 }, { vendorId: 0x18d1, productId: 0xd001 }]);
});

test('the recovery chooser is never unfiltered and never class-filtered', () => {
  for (const serial of ['TEST-DOT', '', '   ', null, undefined]) {
    const filters = recoveryChooserFilters({ serial });
    // TWRP (4ee2, Radar and Echo Dot) and LibreEcho's own adbd (d001), which is
    // listed only so an installed LibreEcho can be recognised, never as TWRP.
    assert.equal(filters.length, 2, 'the chooser must list exactly TWRP and the installed-LibreEcho identity');
    for (const filter of filters) {
      assert.ok(Number.isInteger(filter.vendorId) && Number.isInteger(filter.productId),
        'the filter must stay scoped to recovery VID:PID');
      assert.equal(filter.vendorId, 0x18d1);
      assert.ok([0x4ee2, 0xd001].includes(filter.productId), 'a non-recovery product id is listed');
      // deviceClass is never usable: these devices report class 0.
      assert.equal('deviceClass' in filter, false);
      assert.equal('classCode' in filter, false);
      assert.equal('serialNumber' in filter, false);
    }
  }
});

// --- the grant path -------------------------------------------------------

test('one grant click opens the chooser once and binds a device whose ADB serial matches', async () => {
  setup();
  const seen = [];
  await app.grantRecovery({
    request: (options) => { seen.push(options); return Promise.resolve(TWRP); },
    open: async () => twrpSession(),
  });
  assert.equal(seen.length, 1, 'the chooser was opened more than once for one click');
  assert.equal(app.state.recoverySerial, 'TEST-DOT');
});

test('a chosen Echo whose ADB serial differs is refused and the operator is told what to do', async () => {
  setup();
  const refused = await app.grantRecovery({
    request: () => Promise.resolve({ ...TWRP, serialNumber: 'OTHER-SERIAL-0001' }),
    open: async () => twrpSession({ serial: 'OTHER-SERIAL-0001' }),
  });
  assert.equal(refused, null, 'a wrong-serial recovery device was accepted');
  assert.equal(app.state.recoverySerial, null);
  assert.equal(app.state.recoveryOtherSerial, '••••0001');
  const log = app.terminal.plainText();
  assert.match(log, /reports serial ••••0001/);
  assert.match(log, /My Echo is already in recovery/);
  assert.doesNotMatch(log, /OTHER-SERIAL-0001/, 'the full serial reached the log');

  // A second press on the right device still binds it.
  const second = await app.grantRecovery({ request: () => Promise.resolve(TWRP), open: async () => twrpSession() });
  assert.equal(second.client !== undefined, true, 'the retry did not bind the chosen device');
});

test('a claimInterface failure explains that another program holds the USB connection', async () => {
  setup();
  const busy = Object.assign(new Error("Failed to execute 'claimInterface' on 'USBDevice': Unable to claim interface."),
    { name: 'NetworkError' });
  const refused = await app.grantRecovery({ request: () => Promise.resolve(TWRP), open: async () => { throw busy; } });
  assert.equal(refused, null);
  assert.equal(app.state.recoveryGrantInFlight, false, 'a failed open left the grant flag set');
  const log = app.terminal.plainText();
  assert.match(log, /adb kill-server/);
  assert.match(log, /My Echo is already in recovery/);
  assert.equal(app.isUsbInterfaceBusy(busy), true);
  assert.equal(app.isUsbInterfaceBusy(new Error('A transfer error has occurred.')), false);
});

test('cancelling the chooser leaves the wait intact', async () => {
  setup();
  const cancel = Object.assign(new Error('no device selected'), { name: 'NotFoundError' });
  const refused = await app.grantRecovery({ request: () => Promise.reject(cancel) });
  assert.equal(refused, null);
  assert.equal(app.state.recoveryGrantInFlight, false, 'a cancelled chooser left the grant flag set');
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

test('only a granted device with this Echo\'s serial counts as already granted', async () => {
  setup();
  // A phone with USB debugging, or another Echo in TWRP, shares 18d1:4ee2. It
  // must not hide the button behind "no permission click is needed".
  const other = { ...TWRP, serialNumber: 'PHONE-SERIAL-1234' };
  app.state.recoveryAlreadyGranted = false;
  assert.equal(await app.checkAlreadyGranted({ grantedDevices: async () => [other] }), false);
  assert.equal(app.state.recoveryAlreadyGranted, false, 'a foreign 18d1:4ee2 device suppressed the prompt');
  assert.equal(await app.checkAlreadyGranted({ grantedDevices: async () => [{ ...TWRP, serialNumber: '' }] }), false);
  assert.equal(await app.checkAlreadyGranted({ grantedDevices: async () => [other, TWRP] }), true);
  assert.equal(app.state.recoveryAlreadyGranted, true);
});

test('a new recovery wait re-earns its prompt instead of trusting an old grant', async () => {
  setup();
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
// --- an Echo in TWRP that reports another serial ----------------------------

test('a different-serial Echo turns the wait action into Stop, then offers the recovery entry', () => {
  setup();
  app.state.running = true;
  app.state.recoveryOtherSerial = '••••0001';
  app.refreshControls();
  assert.equal(elements.get('status-bar-action').dataset.actionLabel, 'Stop waiting');
  assert.match(elements.get('status-bar-message').textContent, /reports serial ••••0001/);
  assert.match(elements.get('status-bar-hint').textContent, /My Echo is already in recovery/);

  // After the stop: the one action that can work is the recovery entry.
  app.state.running = false;
  app.state.recoveryWaiting = false;
  app.refreshControls();
  assert.equal(elements.get('status-bar-action').dataset.actionLabel, 'My Echo is already in recovery');
  assert.match(elements.get('status-bar-message').textContent, /unlocked/);
  app.state.recoveryOtherSerial = null;
});

test('only a claimInterface failure is treated as a USB connection held elsewhere', () => {
  assert.equal(app.isUsbInterfaceBusy(Object.assign(new Error('A transfer error has occurred.'), { name: 'NetworkError' })), false);
  assert.equal(app.isUsbInterfaceBusy(Object.assign(new Error('The device was disconnected.'), { name: 'NotFoundError' })), false);
  assert.equal(app.isUsbInterfaceBusy(new Error("Failed to execute 'claimInterface' on 'USBDevice': Unable to claim interface.")), true);
});
