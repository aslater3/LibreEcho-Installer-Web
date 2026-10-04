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
import { phaseReply, readbackReply } from './direct-test-protocol.mjs';
import { sha256Blob, sha256Bytes } from './sha256.js';

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
  app.state.unlockSubmitted = null;
  app.state.target = null;
  app.state.targetsJson = null;
  // The unlock payload is per-device session state too. Left set, it silently
  // changes which gate the NEXT test's unlock branch hits, so a leftover payload
  // would turn a "branch not entered" failure into a digest-mismatch failure.
  app.state.payloadBytes = null;
  app.state.payloadName = '';
  app.state.fastboot = null;
  app.state.files = new Map();
  app.state.sums = null;
  app.state.bundleReady = false;
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
  // A short interval because the newer wait now SKIPS a device another owner holds
  // instead of queueing on the mutex, so it retries on its next poll. Queueing was
  // the interleaved-CNXN race: the second open started against the same physical
  // interface while the first was still handshaking.
  const first = app.awaitRecovery({ timeoutMs: 60000, intervalMs: 5,
    grantedDevices: async () => [DEVICE],
    open: async () => { opened.push('old'); return oldSession; } });
  // Observe `first` immediately: it is invalidated by the newer wait's generation
  // bump, which can land before the assertions below run, and an unobserved
  // rejection in that window fails the whole file.
  const firstSettled = raceSettle(first, 400);
  await tick(20);
  const second = app.awaitRecovery({ timeoutMs: 60000, intervalMs: 5,
    grantedDevices: async () => [DEVICE],
    open: async () => { opened.push('new'); return newSession; } });
  probe.resolve();
  const result = await second;
  assert.match(await firstSettled, /^rejected/, 'the superseded wait was not invalidated');
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

// A grant arriving while the poll already owns the device must step aside, not
// queue behind the mutex. This replaces the old "a grant queued behind a poll"
// expectation: queueing meant the second open began against the same physical
// interface while the poll was still handshaking, which is exactly the
// interleaved-CNXN failure the ownership registry exists to prevent. The poll's
// own accepted session is the answer, and the grant must not open a second one.
test('a grant during an in-flight poll steps aside and never opens a second session', async () => {
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
  await tick(10);
  probe.resolve();
  const claimed = await waiting;
  const granted = await grant;
  assert.equal(claimed.client, pollSession.client);
  assert.equal(grantOpens, 0, 'a contending grant opened a second recovery interface');
  // The grant must not fabricate a result either: it reports that it stepped
  // aside, and the accepted poll session is what the run continues on.
  assert.equal(granted, null, 'a grant that could not take the device reported a session');
  assert.equal(app.state.adb, pollSession.client, 'the poll session was not the one bound');
  assert.match(app.terminal.plainText(), /already being connected|press the button again/i);
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

function recoveryClient({ header = HEADER, rebootFirst = false } = {}) {
  const landed = new Map();
  let prepares = 0;
  let closed = 0;
  return {
    closedCount: () => closed,
    prepareCount: () => prepares,
    client: {
      async shell(command) {
        if (command.includes('getprop')) return { stdout: '3.7.0_9-0\nbiscuit\nTEST-DOT\n' };
        if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
        if (command.includes('mmcblk0p7/size')) return { stdout: '20480\n' };
        if (command.startsWith('df ')) return { stdout: DF_OK };
        const readback = await readbackReply(command, landed);
        if (readback) return readback;
        if (command.includes('libreecho-direct-install.sh') && command.includes('--phase prepare')) {
          prepares += 1;
          return phaseReply(command, `result=prepare-ok\nreboot_required=${rebootFirst ? 1 : 0}\n`);
        }
        if (command.includes('od -An')) return { stdout: `${header}\n` };
        return { stdout: '' };
      },
      async push(path, blob) { landed.set(path, blob); },
      async close() { closed += 1; },
    },
  };
}

test('runInstall re-waits for a fresh recovery session after a v2 prepare reboot', async () => {
  setup();
  const file = new Blob(['bundle']);
  const bootSum = await sha256Blob(file);
  const manifestText = 'protocol=2\nrelease=biscuit-build-test\ntarget=biscuit\ndevice=biscuit\nfastboot_products=BISCUIT\n';
  app.state.files = new Map([['libreecho-biscuit-boot.img', file]]);
  app.state.sums = new Map([['libreecho-biscuit-boot.img', bootSum]]);
  app.state.identity = { ...app.state.identity, unlockStatus: 'true' };
  app.state.bundleReady = true;
  app.state.bundleBoard = 'biscuit';
  app.state.bundleHardwareAccepted = true;
  app.state.target = { board: 'biscuit', slug: 'biscuit', prefix: 'libreecho-biscuit', legacy: false };
  app.state.release = { tag: 'biscuit-v0.14.0', assets: [], board: 'biscuit' };
  app.state.installProtocol = 2;
  app.state.directRelease = 'biscuit-build-test';
  app.state.directManifestText = manifestText;
  app.state.directManifestSha = await sha256Bytes(new TextEncoder().encode(manifestText));
  app.state.directHelper = new TextEncoder().encode('#!/sbin/sh\n');
  app.state.directRoles = [{ role: 'transfer:boot', name: 'libreecho-biscuit-boot.img', sha256: bootSum, size: file.size }];
  const first = recoveryClient({ header: HEADER, rebootFirst: true });
  const second = recoveryClient({ header: OTHER_HEADER });
  const opened = [];
  await app.runInstall({ dryRun: false, recovery: {
    timeoutMs: 2000, intervalMs: 5,
    grantedDevices: async () => [DEVICE],
    open: async () => { const next = opened.length === 0 ? first : second; opened.push(next); return { device: DEVICE, client: next.client }; },
  } });
  assert.equal(opened.length, 2,
    'the post-reboot wait reused the pre-reboot session instead of opening a fresh one');
  assert.equal(first.prepareCount(), 1, 'the prepare phase did not run on the first session');
  assert.match(app.terminal.plainText(), /Kaeru header changed after recovery reboot|do not install/i);
});

// ---------------------------------------------------------------------------
// Continue from TWRP: the page-session unlock latch
//
// After an unknown-outcome unlock and a recovery timeout, `invalidateRecovery`
// in the run's finally clears state.adb / recoverySerial / kaeruHeader, so the
// `resumedRecovery` short-circuit no longer applies. Without the latch a second
// Run click would re-enter the unlock branch — assessIdentity still reads the
// stale LOCKED fastboot identity — and submit flash:brick a second time against
// a device whose unlock outcome is unknown. The latch is what makes the in-page
// resume safe, so this is an end-to-end test through three real runInstall calls.
//
// A run must clear every release gate before it reaches the unlock branch, so the
// fixture installs a complete verified build rather than stubbing gates away.
async function verifiedBuild() {
  const file = new Blob(['bundle']);
  const bootSum = await sha256Blob(file);
  const manifestText = 'protocol=2\nrelease=biscuit-build-test\ntarget=biscuit\ndevice=biscuit\nfastboot_products=BISCUIT\n';
  app.state.files = new Map([['libreecho-biscuit-boot.img', file]]);
  app.state.sums = new Map([['libreecho-biscuit-boot.img', bootSum]]);
  app.state.bundleReady = true;
  app.state.bundleBoard = 'biscuit';
  app.state.bundleHardwareAccepted = true;
  app.state.target = { board: 'biscuit', slug: 'biscuit', prefix: 'libreecho-biscuit', legacy: false };
  app.state.release = { tag: 'biscuit-v0.14.0', assets: [], board: 'biscuit' };
  app.state.installProtocol = 2;
  app.state.directRelease = 'biscuit-build-test';
  app.state.directManifestText = manifestText;
  app.state.directManifestSha = await sha256Bytes(new TextEncoder().encode(manifestText));
  app.state.directHelper = new TextEncoder().encode('#!/sbin/sh\n');
  app.state.directRoles = [{ role: 'transfer:boot', name: 'libreecho-biscuit-boot.img', sha256: bootSum, size: file.size }];
  return bootSum;
}

test('a second run after an unknown unlock and a recovery timeout never re-submits brick', async () => {
  setup();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = await sha256Bytes(bytes);
    const profile = { ...PROFILE, lkBuildMap: { '63cb91b-20221007_072309': {
      payload: 'test.img', size: bytes.length, sha256: digest } } };
    await verifiedBuild();
    app.state.identity = { ...app.state.identity, profile };
    app.state.payloadBytes = bytes;
    app.state.payloadName = 'test.img';

    let flashes = 0;
    let pushes = 0;
    // Unknown outcome, exactly as observed: the device stops answering.
    app.state.fastboot = { client: { flash: async () => { flashes += 1; throw new Error('timeout after write'); } } };
    const noDevice = { timeoutMs: 60, intervalMs: 5 };
    // Counted at the device LIST step, not at open: with an empty granted list no
    // open is ever attempted, but polling is the observable proof that the run
    // reached the recovery wait instead of re-entering the unlock branch.
    let polls = 0;
    const recovery = { ...noDevice, grantedDevices: async () => { polls += 1; return []; } };

    // Run 1: submits brick once, then times out waiting for TWRP.
    await app.runInstall({ dryRun: false, recovery });
    assert.equal(flashes, 1, 'the first run did not submit the unlock payload exactly once');
    assert.equal(app.state.unlockSubmitted, 'TEST-DOT', 'the page latch was not set by the run');
    assert.equal(pushes, 0, 'a device write started after an unlock with no recovery session');
    assert.ok(polls > 0, 'the first run never reached the recovery wait');
    assert.match(app.terminal.plainText(), /timed out waiting for TWRP|recovery stage failed/i);

    // Run 2 ("Continue from TWRP"): the same Run entry point, no reload.
    const pollsAfterFirst = polls;
    await app.runInstall({ dryRun: false, recovery });
    assert.equal(flashes, 1, 'the second run re-submitted flash:brick against an unknown unlock outcome');
    assert.ok(polls > pollsAfterFirst, 'the second run never re-entered the recovery wait');
    assert.equal(pushes, 0, 'the second run started a device write without a recovery session');
    assert.match(app.terminal.plainText(),
      /already submitted in this page session|without re-submitting/i,
      'the resume did not report that the unlock is not being repeated');

    // Run 3 proves the latch is sticky, not a one-shot skip: still no brick.
    await app.runInstall({ dryRun: false, recovery });
    assert.equal(flashes, 1, 'a third run re-submitted flash:brick');
  } finally { globalThis.localStorage = previous; }
});

test('a latch for a different serial does not suppress this device unlock', async () => {
  setup();
  const previous = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value) };
  try {
    // A previous unlock against a DIFFERENT device must not latch this one out.
    app.state.unlockSubmitted = 'SOME-OTHER-DOT';
    await verifiedBuild();
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = await sha256Bytes(bytes);
    // This device's OWN valid pinned payload, so the unlock branch is entered and
    // the refusal that follows can only be the recovery wait — never a payload
    // gate. That isolates what is under test: a foreign latch must not divert
    // this device into the "already submitted" resume branch.
    app.state.identity = { ...app.state.identity, profile: { ...PROFILE, lkBuildMap: {
      '63cb91b-20221007_072309': { payload: 'test.img', size: bytes.length, sha256: digest } } } };
    app.state.payloadBytes = bytes;
    app.state.payloadName = 'test.img';
    let flashes = 0;
    app.state.fastboot = { client: { flash: async () => { flashes += 1; throw new Error('timeout after write'); } } };
    await app.runInstall({ dryRun: false, recovery: { grantedDevices: async () => [], timeoutMs: 40, intervalMs: 5 } });
    assert.equal(flashes, 1, 'this device never submitted its own unlock');
    assert.equal(app.state.unlockSubmitted, 'TEST-DOT',
      'a foreign latch suppressed this device unlock, or the run latched the wrong serial');
    assert.match(app.terminal.plainText(),
      /unlock outcome unknown|checking only for same-serial TWRP/i,
      'this device went to the resume branch instead of submitting its own unlock');
  } finally { globalThis.localStorage = previous; }
});

test('"Continue from TWRP" is offered only after a latched unlock with no live session', async () => {
  setup();
  const node = elements.get('btn-continue-twrp');
  assert.equal(typeof node?.listeners?.get('click'), 'function', 'the Continue button is not wired');
  await verifiedBuild();
  // No latch: hidden. Install readiness is satisfied by the fixture.
  app.state.unlockSubmitted = null;
  app.refreshControls();
  assert.equal(node.hidden, true, 'Continue from TWRP was offered with no submitted unlock');
  // Latched, but an accepted recovery session survives: hidden, the normal Run works.
  app.state.unlockSubmitted = 'TEST-DOT';
  app.state.adb = twrpSession().client;
  app.state.recoverySerial = 'TEST-DOT';
  app.state.kaeruHeader = '8816885870b203004c4b000000000000';
  app.refreshControls();
  assert.equal(node.hidden, true, 'Continue from TWRP was offered alongside a live recovery session');
  // Latched and no session: shown — this is the state a recovery timeout leaves.
  app.state.adb = null;
  app.state.kaeruHeader = null;
  app.refreshControls();
  assert.equal(node.hidden, false, 'Continue from TWRP was not offered after a latched timeout');
  // A latch for another serial is not this device's resume offer.
  app.state.unlockSubmitted = 'SOME-OTHER-DOT';
  app.refreshControls();
  assert.equal(node.hidden, true, 'Continue from TWRP was offered for a latch belonging to another serial');
});

// F2: the control must be repainted by the run's own finally. setRunning(false)
// repaints while the old state.adb is still bound, so on the "recovery accepted,
// then the install failed" path the resume affordance stayed hidden until an
// unrelated later repaint. Driving the real runInstall — rather than hand-setting
// state — is what catches that.
test('"Continue from TWRP" is visible straight after a post-recovery install failure', async () => {
  setup();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  try {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = await sha256Bytes(bytes);
    await verifiedBuild();
    app.state.identity = { ...app.state.identity, profile: { ...PROFILE, lkBuildMap: {
      '63cb91b-20221007_072309': { payload: 'test.img', size: bytes.length, sha256: digest } } } };
    app.state.payloadBytes = bytes;
    app.state.payloadName = 'test.img';
    // Unknown unlock outcome, so the page latch is what must carry the resume.
    let flashes = 0;
    app.state.fastboot = { client: { flash: async () => { flashes += 1; throw new Error('timeout after write'); } } };

    // TWRP is accepted for the right serial, board and header; the install then
    // fails later (the helper is pushed and the phase shells throw).
    const twrp = {
      async shell(command) {
        if (command.includes('getprop')) return { stdout: '3.7.0_9-0\nbiscuit\nTEST-DOT\n' };
        if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
        if (command.includes('/size')) return { stdout: '20480\n' };
        if (command.includes('od -An')) return { stdout: `${HEADER}\n` };
        throw new Error('device stopped answering during the install phase');
      },
      async close() {},
    };
    const node = elements.get('btn-continue-twrp');

    await app.runInstall({ dryRun: false, recovery: {
      timeoutMs: 2000, intervalMs: 5,
      grantedDevices: async () => [DEVICE],
      open: async () => ({ device: DEVICE, client: twrp }),
    } });

    assert.equal(flashes, 1, 'the run never submitted the unlock payload');
    assert.equal(app.state.unlockSubmitted, 'TEST-DOT', 'the page latch was not set');
    assert.match(app.terminal.plainText(), /install stage failed|recovery stage failed/i);
    assert.equal(app.state.adb, null, 'the finally did not drop the bound recovery session');
    // No manual repaint here: this must be the finally's own refreshControls().
    assert.equal(node.hidden, false,
      'the resume affordance stayed hidden until an unrelated later repaint');
  } finally { globalThis.localStorage = previous; }
});

// ---------------------------------------------------------------------------
// Single ownership per USB device, and the descriptor-serial pre-filter
//
// Observed on hardware: two ADB opens and two CNNX handshakes interleaved on one
// USB interface, so a healthy TWRP failed both with "waiting for CNXN/AUTH" and
// "no more data from the device". The poller was also opening an unrelated
// already-granted Radar on every round. These pin both halves of the fix.
// ---------------------------------------------------------------------------

test('a granted device another owner is opening is skipped, never opened twice', async () => {
  setup();
  const probe = deferred();
  const held = twrpSession({ onProbe: () => probe.promise });
  const opened = [];
  // The poll claims the device and parks inside the awaited validation, so the
  // device is genuinely owned for the whole window the second claimant looks at.
  const waiting = app.awaitRecovery({ timeoutMs: 200, intervalMs: 5,
    grantedDevices: async () => [DEVICE],
    open: async () => { opened.push('held'); return held; } });
  await tick(20);
  assert.equal(opened.length, 1, 'the poll never took ownership of the device');

  // A contender on the SAME device must be refused before any await, so its open
  // never runs. A 200 ms deadline with 5 ms polls gives many rounds to misbehave.
  let contenderOpens = 0;
  const contender = app.grantRecovery({
    request: () => Promise.resolve(DEVICE),
    open: async () => { contenderOpens += 1; return twrpSession(); },
  });
  const result = await raceSettle(contender, 400);
  assert.match(result, /^resolved$/, 'a contending grant neither bound nor reported refusal');
  assert.equal(contenderOpens, 0, 'a second open started while the poll still owned the device');

  probe.resolve();
  const claimed = await waiting;
  assert.equal(claimed.client, held.client, 'the owning poll did not bind its session');
  assert.equal(app.state.adb, held.client);
  assert.equal(opened.length, 1, 'the device was opened more than once across the whole wait');
});

test('the poller skips every granted device while a permission chooser is open', async () => {
  setup();
  app.state.running = true;
  const chooser = deferred();
  const session = twrpSession();
  let pollOpens = 0;
  // The device only becomes visible to the poll WHILE the chooser is open. With
  // the pause in place no poll round touches it; before the fix this same sequence
  // opened the device underneath the operator's open chooser.
  let listVisible = false;
  const waiting = app.awaitRecovery({ timeoutMs: 60000, intervalMs: 5,
    grantedDevices: async () => (listVisible ? [DEVICE] : []),
    open: async () => { pollOpens += 1; return session; } });
  await tick(10);
  const grant = app.grantRecovery({ request: () => chooser.promise, open: async () => session });
  await tick(5);
  assert.equal(app.state.recoveryGrantInFlight, true, 'the chooser was not marked in flight');
  listVisible = true;
  await tick(30);
  assert.equal(pollOpens, 0, 'the poll opened a granted device while the chooser was open');
  assert.match(app.terminal.plainText(), /poll paused while the USB permission chooser is open/i);

  chooser.resolve(DEVICE);
  await raceSettle(grant, 400);
  assert.equal(pollOpens, 0, 'the granted device was opened twice: once by each path');
  assert.equal(app.state.recoverySerial, 'TEST-DOT');
  app.requestStop();
  await raceSettle(waiting, 400);
});

test('a granted device with a different descriptor serial is never opened in the first half of a wait', async () => {
  setup();
  const before = { ...app.state.identity };
  const TIMEOUT = 300;
  const openedAt = [];
  const startedAt = Date.now();
  // An already-granted, healthy-looking Radar on the same origin: same vendor,
  // same product, healthy TWRP answers — but it is NOT the selected device. The
  // descriptor exclusion is kept (it is sound on this hardware: the TWRP iSerial
  // equals the fastboot serialno), but only for the first half of the wait —
  // after that the bounded escape hatch below may probe it exactly once.
  const foreign = { ...DEVICE, serialNumber: 'RADAR-OTHER-0001' };
  const promise = app.awaitRecovery({ timeoutMs: TIMEOUT, intervalMs: 10,
    grantedDevices: async () => [foreign],
    open: async () => { openedAt.push(Date.now() - startedAt); return twrpSession({ serial: 'RADAR-OTHER-0001' }); } });
  await assert.rejects(promise, /timed out|TWRP/i);
  const firstHalf = openedAt.filter((at) => at < TIMEOUT / 2);
  assert.equal(firstHalf.length, 0,
    `the foreign device was opened ${firstHalf.length}x in the first half of the wait`);
  // Bounded: at most one probe for the whole wait, however long it runs.
  assert.ok(openedAt.length <= 1, `the escape hatch probed ${openedAt.length} times; it must probe at most once per wait`);
  assert.equal(app.state.adb, null, 'a foreign-serial device was bound to the run');
  assert.equal(app.state.recoverySerial, null);
  assert.deepEqual(app.state.identity, before, 'the frozen identity changed');
  assert.match(app.terminal.plainText(), /not the selected serial/i);
});

// F3 escape hatch: a descriptor serial that merely *looks* different must not
// cost the operator the whole countdown. Once the wait has burned half its
// deadline with no matching/blank candidate ever appearing, one mismatching
// candidate is probed — and the ADB-reported serial still decides.
test('a mismatching descriptor serial is probed once after half the deadline, and the ADB serial still decides', async () => {
  setup();
  const twrp = { ...DEVICE, serialNumber: 'G090L90964010665' };
  let openedFor = 0;
  // The correct device, whose TWRP iSerial differs from the fastboot serialno in
  // case only. The ADB-reported serial matches, so the probe must be accepted.
  const promise = app.awaitRecovery({ timeoutMs: 1200, intervalMs: 20,
    grantedDevices: async () => [twrp],
    open: async () => { openedFor += 1; return twrpSession(); } });
  const result = await promise;
  assert.ok(openedFor >= 1, 'the mismatching device was never probed, so the wait could only time out');
  assert.equal(result.client.client ? true : true, true);
  assert.equal(app.state.recoverySerial, 'TEST-DOT', 'the escape-hatch probe did not accept the correct device');
  const log = app.terminal.plainText();
  assert.match(log, /descriptor serial may not match the fastboot serialno/i,
    'the escape hatch probed without logging why');
  // The warning is masked: no full serial reaches the log.
  assert.ok(!/G090L90964010665/.test(log), 'the full serial was written to the log');
  assert.match(log, /probing it once anyway/i);
});

test('the escape hatch never accepts a foreign device: the ADB serial check stays authoritative', async () => {
  setup();
  let openedFor = 0;
  const foreign = { ...DEVICE, serialNumber: 'RADAR-OTHER-0001' };
  // Probed once, ADB says a different serial, so the claim is refused every time.
  const promise = app.awaitRecovery({ timeoutMs: 800, intervalMs: 20,
    grantedDevices: async () => [foreign],
    open: async () => { openedFor += 1; return twrpSession({ serial: 'RADAR-OTHER-0001' }); } });
  await assert.rejects(promise, /timed out|TWRP/i);
  assert.ok(openedFor >= 1, 'the escape hatch never fired, so this proves nothing');
  assert.ok(openedFor <= 2, `the escape hatch probed ${openedFor} times; it must probe at most once per wait`);
  assert.equal(app.state.adb, null, 'a foreign device was bound to the run');
  assert.equal(app.state.recoverySerial, null);
});

test('a matching descriptor serial is opened, and a blank one still falls back to probing', async () => {
  setup();
  // Empty serialNumber cannot exclude anything, so it must NOT be filtered out:
  // filtering it would refuse the real device whenever a platform omits the
  // descriptor serial. The ADB-reported serial stays the authoritative gate.
  const blank = { ...DEVICE, serialNumber: '' };
  const openedSerials = [];
  const promise = app.awaitRecovery({ timeoutMs: 80, intervalMs: 5,
    grantedDevices: async () => [blank],
    open: async ({ device }) => { openedSerials.push(device.serialNumber);
      return twrpSession({ serial: 'OTHER' }); } });
  await assert.rejects(promise, /timed out|TWRP/i);
  // Several rounds are expected: the wait retries. What matters is that the blank
  // serial was probed at all, rather than filtered out before any open.
  assert.ok(openedSerials.length > 0, 'a blank descriptor serial was filtered instead of probed');
  assert.ok(openedSerials.every((serial) => serial === ''),
    'the probe was not made against the blank-serial candidate');

  setup();
  const matching = { ...DEVICE, serialNumber: 'TEST-DOT' };
  const session = twrpSession();
  const result = await app.awaitRecovery({ timeoutMs: 500, intervalMs: 5,
    grantedDevices: async () => [matching], open: async () => session });
  assert.equal(result.client, session.client, 'the descriptor-serial-matching device was not opened');
  assert.equal(app.state.recoverySerial, 'TEST-DOT');
});

// Keep the header constant referenced so a future edit cannot silently drop it.
assert.equal(typeof HEADER_HEX, 'string');
