// Page-level after-install behaviour, with a fake DOM and a fake running Echo.
// No USB, no device. Pins what the operator reported on the real Dot:
//   * the bar sat at one value for the whole run
//   * after the reboot nothing confirmed LibreEcho started or opened setup
//   * an Echo reached via "already in recovery" never got the setup step
import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.queryNodes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {} };
    this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
    this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false;
  }
  set innerHTML(value) { this._html = value; this.children = []; }
  get innerHTML() { return this._html ?? ''; }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
  setAttribute(key, value) { this[`attr:${key}`] = value; }
  focus() {} scrollIntoView() {} remove() {}
}
const elements = new Map();
const el = (id) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
globalThis.document = { getElementById: el, createElement: () => new Element() };
const opened = [];
globalThis.window = { isSecureContext: false, location: { search: '', origin: 'https://localhost' }, open: (url) => opened.push(url) };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const app = await import('./app.js');
const { STAGES } = await import('./stages.js');
const SERIAL = 'G090L90964010665';
const bar = () => el('status-bar-message').textContent;
const action = () => el('status-bar-action').textContent;
const fast = { pollOptions: { intervalMs: 0, sleep: async () => {} } };

const probe = (o = {}) => Object.entries({ serial: SERIAL, ready: 1, web: 1, setup: 0, pending: 0, ip: '', ...o })
  .map(([k, v]) => `${k}=${v}`).join('\n');

function fakeEcho(replies) {
  const calls = [];
  let size = 0;
  const client = {
    shell: async (cmd) => {
      calls.push(cmd);
      if (cmd.includes('startup-ready')) return { stdout: replies.length > 1 ? replies.shift() : replies[0] };
      if (cmd.startsWith('mount')) return { stdout: '/dev/mmcblk0p16 on /data type ext4 (rw)\n' };
      if (cmd.startsWith('wc -c')) return { stdout: `${size} /data/libreecho/config/provision.json\n` };
      return { stdout: '' };
    },
    push: async (path, blob) => { calls.push(`push ${path}`); size = blob.size; },
    close: async () => { calls.push('close'); },
  };
  const device = { vendorId: 0x18d1, productId: 0xd001, serialNumber: SERIAL };
  return { calls, client, device, open: async () => ({ device, transport: {}, client }) };
}

function fillForm() {
  const v = { 'provision-username': 'admin', 'provision-password': 'correct horse', 'provision-password-confirm': 'correct horse',
    'provision-ssid': 'Home', 'provision-security': 'wpa2', 'provision-wifi-password': 'wifipassword', 'provision-hostname': 'kitchen',
    'provision-volume': '50', 'provision-wake-word': 'Alexa', 'provision-wake-sensitivity': '68' };
  for (const [id, value] of Object.entries(v)) el(id).value = value;
}

test('progress is weighted by real work and rises through the run', () => {
  const values = STAGES.map((s) => app.runPercent(s.id, 0));
  for (let i = 1; i < values.length; i += 1) assert.ok(values[i] > values[i - 1], `${STAGES[i].id} did not advance`);
  assert.ok(app.runPercent('transfer', 1) - app.runPercent('transfer', 0) >= 40, 'the push must move the bar');
  assert.ok(app.runPercent('transfer', 0.5) > app.runPercent('transfer', 0));
  assert.ok(app.runPercent('finalize', 0) > 60, 'the old bar sat around 45-50% for the whole run');
  assert.equal(app.runPercent('verify', 1), 100);
});

test('the setup step is not collapsed before the operator has answered it', () => {
  // Exactly what the page does on load: the default is set, nobody answered.
  assert.equal(app.state.provisionChosen, false, 'loading the page counted as the operator choosing skip');
  app.renderStepCards();
  assert.notEqual(el('card-configure').dataset.state, 'done',
    'reaching the device via recovery left step 5 collapsed as "done" with the default skip');
  app.setProvisionMode('skip');
  app.renderStepCards();
  assert.equal(el('card-configure').dataset.state, 'done');
});

test('installed without setup: waits for LibreEcho, then offers setup here and delivers it over USB', async () => {
  app.state.stageProgress = { finalize: 'done' };
  app.state.provisionMode = 'skip';
  app.state.identity = { serialRaw: SERIAL, profile: { board: 'biscuit' } };
  app.state.directRelease = 'radar-puffin-build-test';
  const echo = fakeEcho([probe({ ready: 0 }), probe({ web: 0 }), probe()]);
  const result = await app.waitForLibreEcho({ device: echo.device, open: echo.open, ...fast });
  assert.equal(result, 'needs-setup');
  assert.equal(app.state.provisionMode, 'fill', 'the setup form was not opened');
  assert.equal(el('provision-ssid').disabled, false, 'the setup form stayed locked after the install');
  assert.match(bar(), /set it up/i);
  assert.equal(echo.calls.includes('close'), false, 'the USB session needed to send settings was closed');

  fillForm();
  app.onProvisionInput();
  assert.equal(action(), 'Send settings to your Echo');
  assert.equal(el('status-bar-action').disabled, false);

  echo.client.shell = ((orig, after) => async (cmd) => {
    if (cmd.includes('startup-ready')) return { stdout: after.length > 1 ? after.shift() : after[0] };
    return orig(cmd);
  })(echo.client.shell, [probe({ pending: 1 }), probe({ setup: 1 }), probe({ setup: 1, ip: '192.168.0.77' })]);
  const done = await app.sendSettingsToRunningEcho({ waitOptions: fast });
  assert.equal(done, 'done');
  const pushIndex = echo.calls.indexOf('push /data/libreecho/config/provision.json.tmp');
  assert.ok(pushIndex >= 0, 'the settings were not pushed');
  assert.ok(echo.calls.some((c) => c.startsWith('/etc/init.d/libreecho-web.init restart')));
  assert.equal(echo.calls.some((c) => /reboot|mkfs|twrp|dd |direct-install/.test(c)), false, 'post-install setup wrote more than the settings');
  assert.match(bar(), /192\.168\.0\.77/);
  assert.equal(action(), "Open your Echo's page");
  assert.equal(el('status-bar-fill').style.width, '100%');
  el('status-bar-action').listeners.get('click')();
  assert.deepEqual(opened, ['http://192.168.0.77:8080/']);
  assert.equal(el('provision-password').value, '', 'the admin password outlived delivery');
});

test('a different Echo answering after the reboot is refused, never configured', async () => {
  app.state.identity = { serialRaw: SERIAL, profile: { board: 'biscuit' } };
  const echo = fakeEcho([probe({ serial: 'OTHER00000000000' })]);
  const result = await app.waitForLibreEcho({ serial: SERIAL, device: echo.device, open: echo.open, ...fast });
  assert.equal(result, 'timeout');
  assert.equal(echo.calls.some((c) => c.startsWith('push')), false);
  assert.match(action(), /Check my Echo/);
});

test('settings refused by the device are reported, not shown as success', async () => {
  const echo = fakeEcho([probe({ provision_result: 'partial', provision_error: 'assoc-timeout', provision_wifi: 'failed' })]);
  const result = await app.waitForLibreEcho({ device: echo.device, open: echo.open, expectProvision: true, ...fast });
  assert.equal(result, 'setup-failed');
  assert.match(bar(), /assoc-timeout/);
  assert.doesNotMatch(bar(), /^Done/);
});

test('Check my Echo during the background wait takes over; the old wait does not overwrite the result', async () => {
  app.state.identity = { serialRaw: SERIAL, profile: { board: 'biscuit' } };
  // A background wait with no permitted device: it would sit on its deadline.
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { usb: { getDevices: async () => [] } } });
  const background = app.waitForLibreEcho({ serial: SERIAL });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(action(), 'Check my Echo', 'no way to act while the page waits');
  assert.equal(el('status-bar-action').hidden, false);
  const echo = fakeEcho([probe({ setup: 1, ip: '192.168.0.80' })]);
  const pressed = await app.waitForLibreEcho({ device: echo.device, open: echo.open, ...fast });
  assert.equal(pressed, 'done');
  // The superseded loop notices within one poll and returns without touching state.
  await Promise.race([background, new Promise((_, no) => setTimeout(() => no(new Error('old wait never stopped')), 5000))]);
  assert.equal(app.state.postInstall, 'done');
  assert.match(bar(), /192\.168\.0\.80/);
});
