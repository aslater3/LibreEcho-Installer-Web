// Actual page-module tests: fake USB/DOM only, never a physical device.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.queryNodes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {} };
    this.textContent = ''; this.hidden = false; this.disabled = false; this.value = '';
  }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
  remove() {}
}
const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  },
  createElement: () => new Element(),
};
globalThis.window = { isSecureContext: false, location: { search: '', origin: 'https://localhost' },
  LIBREECHO_INSTALLER_CONFIG: { amonetMirrorBase: 'https://invalid.example/pinned/' } };
globalThis.fetch = async () => { throw new Error('network disabled in fake-USB tests'); };
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { usb: {
  getDevices: async () => [], addEventListener() {},
  requestDevice: async () => { throw new Error('unexpected real USB chooser'); },
} } });
const app = await import('./app.js');
const node = (id) => elements.get(id);
const vars = {
  product: 'BISCUIT', unlock_status: 'true', lk_build_desc: '63cb91b-20221007_072309',
  pl_build_desc: 'bd7ae89-20221003_215949', serialno: 'TEST-DOT', secure: 'yes',
  rpmb_state: '1', 'max-download-size': '0x6d00000',
};
async function query(overrides = {}, { open = null } = {}) {
  app.state.running = false;
  app.state.downloadedBundle = null;
  const commands = [];
  const client = {
    getVar: async (key) => { commands.push(`getvar ${key}`); return { ...vars, ...overrides }[key] ?? ''; },
    flash: async () => { commands.push('flash'); throw new Error('unexpected flash'); },
    erase: async () => { commands.push('erase'); throw new Error('unexpected erase'); },
    reboot: async () => { commands.push('reboot'); throw new Error('unexpected reboot'); },
  };
  await app.queryDevice({ open: open ?? (async () => ({
    device: { vendorId: 0x0bb4, productId: 0x0c01 }, client,
  })) });
  return commands;
}

test('Amonet controls are hidden and disabled until an actual device query', () => {
  assert.equal(node('amonet-panel')?.hidden, true, 'Amonet ZIP panel must not ask for a file before identification');
  assert.equal(node('btn-amonet-archive').disabled, true);
  assert.equal(node('payload-input').disabled, true);
});

test('recognized unlocked fastboot hides the archive, removes its requirement, and does not qualify recovery', async () => {
  const commands = await query();
  assert.equal(node('amonet-panel')?.hidden, true, 'unlocked device must not be asked for an Amonet ZIP');
  assert.equal(node('btn-amonet-archive').disabled, true);
  assert.equal(node('btn-fetch-amonet').disabled, true);
  assert.equal(node('payload-input').disabled, true);
  assert.match(node('amonet-route')?.textContent ?? '', /already unlocked.*(no|not).*ZIP/i);
  assert.match(node('amonet-route').textContent, /TWRP.*Kaeru.*verif/i);
  assert.match(node('status-payload').textContent, /not needed/i);
  assert.equal(app.state.adb, null);
  assert.equal(app.state.kaeruHeader, null, 'an unlocked flag must not establish recovery compatibility');
  assert.equal(app.state.bundleReady, false, 'archive visibility must not establish release verification');
  assert.equal(node('btn-run').disabled, true);
  assert.ok(commands.every((c) => c.startsWith('getvar ')), 'query sent a device mutation');
});

test('every supported unlocked token skips archive acquisition, including configured auto-fetch', async () => {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ repository: 'aslater3/LibreEcho',
      amonetMirrorBase: 'https://invalid.example/pinned/' }) };
  };
  try {
    for (const unlock_status of ['true', 'yes', '1']) {
      await query({ unlock_status });
      assert.equal(node('amonet-panel').hidden, true);
    }
    assert.deepEqual(calls, [], 'unlocked query fetched an unnecessary Amonet archive');
  } finally { globalThis.fetch = oldFetch; }
});

test('a supported locked device restores the pinned archive controls', async () => {
  await query({ unlock_status: 'false' });
  assert.equal(node('amonet-panel')?.hidden, false, 'locked supported target still needs the verified unlock payload');
  assert.equal(node('btn-amonet-archive').disabled, false);
  assert.equal(node('payload-input').disabled, false);
  assert.match(node('status-payload').textContent, /select.*pinned archive/i);
  assert.match(node('amonet-route')?.textContent ?? '', /locked.*pinned/i);
});

test('unknown lock state, unknown target or missing serial cannot silently choose an install route', async () => {
  for (const overrides of [{ unlock_status: '' }, { unlock_status: 'unknown' },
    { product: 'OTHER', unlock_status: 'true' }, { serialno: '', unlock_status: 'true' },
    { unlock_status: 'false', lk_build_desc: 'unknown' }]) {
    await query(overrides);
    assert.equal(node('amonet-panel').hidden, true);
    assert.equal(node('btn-amonet-archive').disabled, true);
    assert.match(node('amonet-route').textContent, /blocked|unverified|unknown|missing|not supported/i);
    assert.doesNotMatch(node('status-payload').textContent, /not needed/i);
  }
});

test('a failed device query invalidates an earlier unlocked identity and selected archive', async () => {
  await query();
  app.state.payloadBytes = new Uint8Array([1, 2, 3]); app.state.payloadName = 'stale.img';
  await assert.rejects(query({}, { open: async () => { throw new Error('device disconnected'); } }), /disconnected/);
  assert.equal(app.state.identity, null, 'failed fresh query retained the previous unlocked identity');
  assert.equal(app.state.fastboot, null);
  assert.equal(app.state.payloadBytes, null);
  assert.equal(app.state.payloadName, '');
  assert.equal(node('amonet-panel').hidden, true);
  assert.match(node('amonet-route').textContent, /query|not identified|not connected/i);
});

test('archive and raw-payload entry points reject unlocked state before reading or fetching bytes', async () => {
  await query();
  let acquired = false;
  let read = false;
  await assert.rejects(app.loadAmonetArchive({ url: 'https://invalid.example/pinned.zip',
    acquire: async () => { acquired = true; return {}; } }), /already unlocked|not required/i);
  const file = { name: 'fastbrick-20221007.img', size: 114349580,
    arrayBuffer: async () => { read = true; return new ArrayBuffer(0); } };
  await assert.rejects(app.loadPayload(file), /already unlocked|not required/i);
  assert.equal(acquired, false);
  assert.equal(read, false);
});

test('a delayed older device query cannot replace the newer unlock decision', async () => {
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const old = app.queryDevice({ open: async () => {
    started(); return new Promise((resolve) => { release = resolve; });
  } });
  await ready;
  await query({ unlock_status: 'false', serialno: 'CURRENT-DOT' });
  const client = { getVar: async (key) => vars[key] ?? '' };
  release({ device: { vendorId: 0x0bb4, productId: 0x0c01 }, client });
  await assert.rejects(old, /superseded/);
  assert.equal(app.state.identity.serialRaw, 'CURRENT-DOT');
  assert.equal(node('amonet-panel').hidden, false);
});

test('unlocked fastboot with an unknown LK description does not claim verified recovery', async () => {
  await query({ lk_build_desc: 'unqualified-chain' });
  assert.equal(node('amonet-panel').hidden, true, 'an unlocked unit must not be offered a repeated unlock');
  assert.match(node('amonet-route').textContent, /must still be verified/i);
  assert.equal(app.state.kaeruHeader, null);
  assert.equal(node('btn-run').disabled, true);
});

test('a pending archive cannot publish for a replaced device identity', async () => {
  await query({ unlock_status: 'false' });
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = app.loadAmonetArchive({ url: 'https://invalid.example/pinned.zip', acquire: async () => {
    started(); return new Promise((resolve) => { release = resolve; });
  } });
  await ready;
  await query({ serialno: 'OTHER-DOT' });
  release({ bytes: new Uint8Array(114349580) });
  await assert.rejects(pending, /identity changed|identity.*changed/i);
  assert.equal(app.state.payloadBytes, null);
  assert.equal(node('amonet-panel').hidden, true);
});

test('a pending raw payload cannot publish for a replaced device identity', async () => {
  await query({ unlock_status: 'false' });
  const bytes = new Uint8Array([1, 2, 3]);
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  app.state.identity.profile = { ...app.state.identity.profile, lkBuildMap: {
    [vars.lk_build_desc]: { payload: 'fixture.img', size: 3, sha256 },
  } };
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = app.loadPayload({ name: 'fixture.img', size: 3,
    arrayBuffer: async () => { started(); return new Promise((resolve) => { release = resolve; }); } });
  await ready;
  await query({ serialno: 'OTHER-DOT' });
  release(bytes.buffer);
  await assert.rejects(pending, /identity changed|device.*changed/i);
  assert.equal(app.state.payloadBytes, null);
});

test('markup ships hidden archive controls, route status and a cache-busted page module', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<section[^>]*id="amonet-panel"[^>]*hidden/);
  assert.match(html, /id="amonet-route"[^>]*role="status"/);
  assert.match(html, /src="js\/app\.js\?v=[^"]+"/);
});
