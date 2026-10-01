// Recovery-handoff cancellation/lifecycle race tests.
//
// These pin the epoch-ownership contract for the browser recovery handoff: a
// run/wait freezes the device identity and an abort/generation token BEFORE any
// awaited device action; every claim re-checks that token inside the mutex and
// again after every awaited validation before it binds; a stop, timeout, run-end
// or a newer wait invalidates the token, so a late poll or chooser result is
// disposed instead of bound. Deterministic barriers only — no device, no USB.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Blob } from './sha256.js';

// --- minimal DOM so the real page module imports under node ---------------
class Element {
  constructor() {
    this.children = [];
    this.listeners = new Map();
    this.queryNodes = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = { add() {}, remove() {} };
    this.textContent = '';
    this.disabled = false;
  }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
  remove() {}
  set innerHTML(value) { this._html = value; }
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
  configurable: true,
  writable: true,
  value: { usb: {
    getDevices: async () => [],
    requestDevice: async () => { throw new Error('background code opened a permission prompt'); },
  } },
});
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
const app = await import('./app.js');

const HEADER = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const OTHER_HEADER = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 99';
const HEADER_HEX = '8816885870b203004c4b000000000000';
const DEVICE = { vendorId: 0x18d1, productId: 0x4ee1 };
const PROFILE = {
  id: 'biscuit', product: 'BISCUIT', marketing: 'Echo Dot', board: 'biscuit',
  libreEcho: 'experimental', userdataContractSectors: [2137088],
  lkBuildMap: { '63cb91b-20221007_072309': { payload: 'test.img', size: 3, sha256: 'a'.repeat(64) } },
};

function setup() {
  app.state.release = { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' };
  app.state.identity = { product: 'BISCUIT', unlockStatus: 'false', profile: PROFILE,
    lkBuild: '63cb91b-20221007_072309', serialRaw: 'TEST-DOT' };
  app.state.adb = null;
  app.state.recoverySerial = null;
  app.state.kaeruHeader = null;
  app.state.abort = false;
  app.state.running = false;
  app.state.recoveryWaiting = false;
  app.state.recoveryAbort = null;
  app.state.recoveryGrantInFlight = false;
  app.state.recoverySession = null;
  app.state.recoveryAcceptedEpoch = 0;
  app.state.recoveryEpoch = 0;
  app.state.target = null;
  app.state.targetsJson = null;
  app.state.files = new Map();
  app.state.sums = null;
  app.state.bundleReady = false;
  app.state.markerSafe = false;
  app.state.bundleBoard = null;
  app.state.bundleHardwareAccepted = false;
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 'resolved' | 'rejected:<name>' | 'timeout', always within ms. */
async function raceSettle(promise, ms = 400) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  const settled = promise.then(() => 'resolved', (error) => `rejected:${error?.name ?? String(error)}`);
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  if (result === 'timeout') promise.catch(() => {});
  return result;
}

/** A fake TWRP session; `onProbe` gates the first getprop probe (validation). */
function twrpSession({ serial = 'TEST-DOT', board = 'biscuit', header = HEADER, onProbe = null } = {}) {
  let closed = 0;
  const client = {
    async shell(command) {
      if (command.includes('getprop')) {
        if (onProbe) await onProbe();
        return { stdout: `3.7.0_9-0\n${board}\n${serial}\n` };
      }
      if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
      if (command.includes('/size')) return { stdout: '20480\n' };
      return { stdout: `${header}\n` };
    },
    async close() { closed += 1; },
  };
  return { device: DEVICE, client, closedCount: () => closed };
}

// ---------------------------------------------------------------------------
// Stop/timeout while a claim is mid-flight
// ---------------------------------------------------------------------------

test('the recovery deadline bounds an unresolved validation and rejects its late session', async () => {
  setup();
  const entered = deferred();
  const probe = deferred();
  const session = twrpSession({ onProbe: () => { entered.resolve(); return probe.promise; } });
  const waiting = app.awaitRecovery({ timeoutMs: 40, intervalMs: 5000,
    grantedDevices: async () => [DEVICE], open: async () => session });
  await entered.promise;
  const settled = await raceSettle(waiting, 400);
  // Always release the barrier, including on RED, so the process cannot hang.
  probe.resolve();
  await waiting.catch(() => {});
  await tick(20);
  assert.match(settled, /^rejected/, 'deadline did not bound the pending validation');
  assert.equal(app.state.adb, null);
  assert.ok(session.closedCount() >= 1);
});

test('a stop during the awaited validation settles the wait and closes the late session', async () => {
  setup();
  const probe = deferred();
  const session = twrpSession({ onProbe: () => probe.promise });
  let opens = 0;
  const waiting = app.awaitRecovery({ timeoutMs: 60000, intervalMs: 5000,
    grantedDevices: async () => [DEVICE],
    open: async () => { opens += 1; return session; } });
  await tick(20);
  assert.equal(opens, 1, 'the poll never opened the granted device');
  app.requestStop();
  const settled = await raceSettle(waiting, 400);
  assert.match(settled, /^rejected/, 'the wait did not settle while its validation was unresolved');
  probe.resolve(); // the in-flight validation returns late
  await tick(40);
  assert.equal(session.closedCount() >= 1, true, 'the late validated session was not closed');
  assert.equal(app.state.adb, null, 'a late session was bound after the stop');
  assert.equal(app.state.recoveryWaiting, false);
});

test('a newer wait supersedes an older in-flight poll and closes its late session', async () => {
  setup();
  app.state.running = true;
  const probe = deferred();
  const oldSession = twrpSession({ onProbe: () => probe.promise });
  const newSession = twrpSession();
  const opened = [];
  const first = app.awaitRecovery({ timeoutMs: 60000, intervalMs: 5000,
    grantedDevices: async () => [DEVICE],
    open: async () => { opened.push('old'); return oldSession; } });
  await tick(20);
  const second = app.awaitRecovery({ timeoutMs: 60000, intervalMs: 5000,
    grantedDevices: async () => [DEVICE],
    open: async () => { opened.push('new'); return newSession; } });
  await tick(5); // the second wait queues on the mutex behind the first
  probe.resolve();
  const result = await second;
  const firstSettled = await raceSettle(first, 400);
  assert.match(firstSettled, /^rejected/, 'the superseded wait was not invalidated');
  assert.equal(result.client, newSession.client, 'the newer wait did not bind its own session');
  assert.equal(app.state.adb, newSession.client);
  assert.ok(oldSession.closedCount() >= 1, 'the superseded poll session was not closed');
  assert.equal(opened.filter((name) => name === 'old').length, 1, 'the old session was opened more than once');
});

// ---------------------------------------------------------------------------
// Late chooser results and duplicate opens
// ---------------------------------------------------------------------------

test('a permission chooser that resolves after the run ended is refused before it opens', async () => {
  setup();
  app.state.running = true;
  const chooser = deferred();
  const waiting = app.awaitRecovery({ timeoutMs: 60000, intervalMs: 5000,
    grantedDevices: async () => [], open: async () => { throw new Error('poll must not open'); } });
  await tick(10);
  assert.equal(app.state.recoveryWaiting, true);
  let requested = 0;
  let opens = 0;
  const session = twrpSession();
  const grant = app.grantRecovery({
    request: () => { requested += 1; return chooser.promise; },
    open: async () => { opens += 1; return session; },
  });
  await tick(5);
  assert.equal(requested, 1, 'the click did not request the permission chooser');
  app.requestStop();
  app.state.running = false; // the run's finally clears the active-run flag
  await raceSettle(waiting, 400);
  chooser.resolve(DEVICE); // the chooser returns after the stop
  const granted = await grant;
  assert.equal(granted, null, 'a late grant bound a recovery session');
  assert.equal(opens, 0, 'a recovery interface was opened after the stop');
  assert.equal(session.closedCount(), 0, 'a refused-early chooser still opened and needed closing');
  assert.equal(app.state.adb, null);
});

test('a grant queued behind a poll that already bound the interface never opens a second session', async () => {
  setup();
  app.state.running = true;
  const probe = deferred();
  const pollSession = twrpSession({ onProbe: () => probe.promise });
  let grantOpens = 0;
  const waiting = app.awaitRecovery({ timeoutMs: 60000, intervalMs: 5000,
    grantedDevices: async () => [DEVICE], open: async () => pollSession });
  await tick(20);
  const grantSession = twrpSession();
  const grant = app.grantRecovery({
    request: () => Promise.resolve(DEVICE),
    open: async () => { grantOpens += 1; return grantSession; },
  });
  await tick(10); // queued behind the poll's mutex
  probe.resolve();
  const claimed = await waiting;
  const granted = await grant;
  assert.equal(claimed.client, pollSession.client);
  assert.equal(grantOpens, 0, 'the queued grant opened a second recovery interface');
  assert.equal(granted.client, pollSession.client, 'the queued grant did not reuse the accepted session');
  assert.equal(app.state.adb, pollSession.client);
});

// ---------------------------------------------------------------------------
// Refusals that must happen before the permission chooser opens
// ---------------------------------------------------------------------------

test('a grant during an active run that is not waiting for recovery is refused before the chooser', async () => {
  setup();
  app.state.running = true;
  app.state.recoveryWaiting = false;
  let requested = 0;
  await assert.rejects(app.grantRecovery({
    request: () => { requested += 1; return Promise.resolve(DEVICE); },
    open: async () => { throw new Error('no interface may be opened'); },
  }), /waiting|recovery/i);
  assert.equal(requested, 0, 'the permission chooser opened during a device write');
});

test('a grant without a declared board is refused before the chooser', async () => {
  setup();
  app.state.identity = { ...app.state.identity, profile: { ...PROFILE, board: '' } };
  let requested = 0;
  await assert.rejects(app.grantRecovery({
    request: () => { requested += 1; return Promise.resolve(DEVICE); },
    open: async () => twrpSession(),
  }), /board/i);
  assert.equal(requested, 0, 'the permission chooser opened without a declared board');
  assert.equal(app.state.adb, null);
});

test('the permission chooser is requested synchronously on the click, before any await', async () => {
  setup();
  let called = false;
  const pending = app.grantRecovery({
    request: () => { called = true; return Promise.resolve(DEVICE); },
    open: async () => twrpSession(),
  });
  assert.equal(called, true, 'an await preceded the permission request and would drop user activation');
  await pending;
});

// ---------------------------------------------------------------------------
// Orchestration: a recovery reboot must not reuse the pre-reboot session
// ---------------------------------------------------------------------------

const DF_OK = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
  '/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache', ''].join('\n');

function recoveryClient({ header = HEADER, bootSum = '' } = {}) {
  let installs = 0;
  let closed = 0;
  return {
    closedCount: () => closed,
    installCount: () => installs,
    client: {
      async shell(command) {
        if (command.includes('getprop')) return { stdout: '3.7.0_9-0\nbiscuit\nTEST-DOT\n' };
        if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
        if (command.includes('/size')) return { stdout: '20480\n' };
        if (command.startsWith('df ')) return { stdout: DF_OK };
        if (command.startsWith('sha256sum')) return { stdout: `${bootSum}  libreecho-biscuit-boot.img\n` };
        if (command.startsWith('twrp install')) {
          installs += 1;
          return { stdout: installs === 1
            ? '__RECEIPT__result=installed\nreboot_required=1\n'
            : '__RECEIPT__result=installed\nreboot_required=0\n' };
        }
        if (command.includes('od -An')) return { stdout: `${header}\n` };
        return { stdout: '' };
      },
      async push() {},
      async close() { closed += 1; },
    },
  };
}

test('runInstall re-waits for a fresh recovery session after a recovery reboot', async () => {
  setup();
  const file = new Blob(['bundle']);
  const bootSum = await sha256Blob(file);
  app.state.files = new Map([['libreecho-biscuit-boot.img', file]]);
  app.state.sums = new Map([['libreecho-biscuit-boot.img', bootSum]]);
  app.state.identity = { ...app.state.identity, unlockStatus: 'true' };
  app.state.bundleReady = true;
  app.state.bundleBoard = 'biscuit';
  app.state.bundleHardwareAccepted = true;
  app.state.markerSafe = true;
  app.state.target = { board: 'biscuit', slug: 'biscuit', prefix: 'libreecho-biscuit-v0.14.0', legacy: false };
  app.state.release = { tag: 'biscuit-v0.14.0', assets: [], board: 'biscuit' };
  const first = recoveryClient({ header: HEADER, bootSum });
  const second = recoveryClient({ header: OTHER_HEADER, bootSum });
  const opened = [];
  await app.runInstall({ dryRun: false, recovery: {
    timeoutMs: 2000, intervalMs: 5,
    grantedDevices: async () => [DEVICE],
    open: async () => { const next = opened.length === 0 ? first : second; opened.push(next); return { device: DEVICE, client: next.client }; },
  } });
  assert.equal(opened.length, 2,
    'the post-reboot wait reused the pre-reboot session instead of opening a fresh one');
  assert.equal(first.installCount(), 1, 'the prepare phase did not run on the first session');
  assert.match(app.terminal.plainText(), /Kaeru header changed after recovery reboot|do not install/i);
});

// Keep the header constant referenced so a future edit cannot silently drop it.
assert.equal(typeof HEADER_HEX, 'string');
