// The page after an install: re-attach to the running Echo, check it started, hand
// over to setup (Installer-Web #23). Host-only fakes; no USB, no device.


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

const SERIAL = 'TESTSERIAL0001';
const out = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
const RUNNING = { serial: SERIAL, ready: 1, web: 1, setup: 0, ip: '' };
const DEVICE = { vendorId: 0x18d1, productId: 0xd001, serialNumber: SERIAL };
const fast = { pollOptions: { intervalMs: 1, timeoutMs: 50 } };
const FORWARD = /adb forward tcp:18080 tcp:8080/;

function fakeSession(replies) {
  const session = { closed: false, commands: [],
    client: {
      shell: async (command) => { session.commands.push(command); return { stdout: replies.length > 1 ? replies.shift() : replies[0] }; },
      close: async () => { session.closed = true; },
    } };
  return session;
}

const bar = () => ({
  message: document.getElementById('status-bar-message').textContent,
  label: document.getElementById('status-bar-action').textContent,
  actionShown: !document.getElementById('status-bar-action-row').hidden,
});

test('Check my Echo: same serial, started, not set up → setup handoff, USB released', async () => {
  const session = fakeSession([out({ ...RUNNING, ready: 0 }), out(RUNNING)]);
  const chosenWith = [];
  const result = await app.waitForLibreEcho({ serial: SERIAL, request: true, ...fast,
    chooser: async (filters) => { chosenWith.push(filters); return DEVICE; },
    open: async ({ device }) => { assert.equal(device, DEVICE); return session; } });
  assert.equal(result, 'needs-setup');
  assert.deepEqual(chosenWith, [[{ vendorId: 0x18d1, productId: 0xd001 }]]);
  assert.equal(session.closed, true, 'the page kept the USB interface the host adb needs');
  assert.ok(session.commands.every((c) => !/reboot|restart|rm |mkfs|dd /.test(c)), 'the check wrote to the device');
  const { message, label, actionShown } = bar();
  assert.match(message, FORWARD);
  assert.match(message, /http:\/\/127\.0\.0\.1:18080\/setup\.html/);
  assert.equal(label, 'Open the setup instructions');
  assert.equal(actionShown, true);
  assert.equal(document.getElementById('btn-connect').disabled, false, 'the USB slot was not released');
  assert.match(app.terminal.plainText(), FORWARD);
});

test('an Echo that is already set up and on Wi-Fi offers its own page', async () => {
  const session = fakeSession([out({ ...RUNNING, setup: 1, ip: '192.168.1.40' })]);
  const result = await app.waitForLibreEcho({ serial: SERIAL, request: true, ...fast,
    chooser: async () => DEVICE, open: async () => session });
  assert.equal(result, 'done');
  assert.equal(app.state.postInstallIp, '192.168.1.40');
  assert.match(bar().message, /192\.168\.1\.40/);
  assert.equal(bar().label, "Open your Echo's page");
});

test('a cancelled chooser leaves Check my Echo on offer, with the terminal fallback', async () => {
  let opened = 0;
  const result = await app.waitForLibreEcho({ serial: SERIAL, request: true, ...fast,
    chooser: async () => { const e = new Error('No device selected.'); e.name = 'NotFoundError'; throw e; },
    open: async () => { opened += 1; return fakeSession([out(RUNNING)]); } });
  assert.equal(result, 'no-permission');
  assert.equal(opened, 0);
  assert.equal(bar().label, 'Check my Echo');
  assert.match(document.getElementById('status-bar-hint').textContent, FORWARD);
});

test('a different Echo answering is refused and the session is closed', async () => {
  const session = fakeSession([out({ ...RUNNING, serial: 'OTHERSERIAL0002' })]);
  const result = await app.waitForLibreEcho({ serial: SERIAL, request: true, ...fast,
    chooser: async () => DEVICE, open: async () => session });
  assert.equal(result, 'timeout');
  assert.equal(session.closed, true);
  assert.match(app.terminal.plainText(), /different Echo/);
  assert.equal(bar().label, 'Check my Echo');
});

test('an Echo that never reports ready is a bounded wait, not a hang', async () => {
  const session = fakeSession([out({ ...RUNNING, ready: 0 })]);
  const result = await app.waitForLibreEcho({ serial: SERIAL, request: true, ...fast,
    chooser: async () => DEVICE, open: async () => session });
  assert.equal(result, 'timeout');
  assert.equal(session.closed, true);
});

test('a new device query ends the post-install state', async () => {
  const session = fakeSession([out(RUNNING)]);
  await app.waitForLibreEcho({ serial: SERIAL, request: true, ...fast, chooser: async () => DEVICE, open: async () => session });
  assert.equal(app.state.postInstall, 'needs-setup');
  await app.queryDevice({ open: async () => { throw new Error('No device selected.'); } }).catch(() => {});
  assert.equal(app.state.postInstall, null);
  assert.notEqual(bar().label, 'Open the setup instructions');
});
