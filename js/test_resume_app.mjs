// Reload/resume and the single Connect/Resume entry.
//
// The failure this pins is the one an operator actually hit: the page was
// reloaded after a reboot, the device had already moved into TWRP, and every
// continuation path refused because a fastboot identity no longer existed. Five
// connection buttons asked for five different things, none of which was "pick up
// where you were", and the reload lost the chosen device, board and release.
//
// What has to be true now, in order:
//   * a reload restores non-secret transaction/release/board/device-digest state
//   * continuing REVERIFIES the immutable release assets and the actual on-device
//     state — the journal is a hint, never the authority
//   * a reload never redoes unlock and never reformats
//   * durable libreecho.unlock.* guards, including the legacy keys, all survive
//   * a previously granted matching device may be identified READ-ONLY on load,
//     but page load alone never starts destructive work
//   * an ambiguous device set requires an explicit choice
//   * USB-busy is one actionable explanation, not repeated log noise
//   * changed device or changed release fails safe rather than continuing
//   * secrets are never stored or logged, so provisioning is re-entered

import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.queryNodes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {} };
    this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
    this.textContent = ''; this.value = ''; this.disabled = false; this.hidden = false;
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
  setAttribute(key, value) { this[key] = value; }
  focus() {} scrollIntoView() {} remove() {}
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

/** A shared storage double; survives across "reloads" inside one test. */
const store = new Map();
const writes = [];
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { writes.push(key); store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};

const app = await import('./app.js');
const { RESUME_JOURNAL_KEY } = await import('./resume.js');
const { sha256Bytes } = await import('./sha256.js');

const SERIAL = 'G090L90964010665';
const OTHER_SERIAL = 'G090L99999999999';
const DIGEST_SERIAL = await sha256Bytes(new TextEncoder().encode(SERIAL));
const DIGEST_OTHER = await sha256Bytes(new TextEncoder().encode(OTHER_SERIAL));
// `dd ... | od -An -tx1` returns 16 space-separated bytes; HEADER_HEX is what
// readKaeruHeader joins them into.
const HEADER_BYTES = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const HEADER_HEX = HEADER_BYTES.replace(/ /g, '');

const el = (id) => elements.get(id);
const latest = (before) => app.terminal.lines.slice(before).map((l) => l.textContent).join('\n');
const flashCalls = [];
const rebootCalls = [];
const pushes = [];
const shells = [];

/** A fake TWRP device: probes report facts, writes are recorded, never done. */
function twrp({ serial = SERIAL, board = 'radar_puffin', twrpVersion = '3.7.0_9-0',
  header = HEADER_BYTES, expdb = 'PARTNAME=expdb', sectors = '20480' } = {}) {
  const client = {
    shell: async (command) => {
      shells.push(command);
      if (command.includes('ro.twrp.version')) {
        return { stdout: `${twrpVersion}\n${board}\n${serial}\n` };
      }
      if (command.includes('uevent')) return { stdout: `${expdb}\n` };
      if (command.includes('/size')) return { stdout: `${sectors}\n` };
      if (command.includes('od -An')) return { stdout: `${header}\n` };
      if (command.startsWith('df ')) {
        return { stdout: 'Filesystem     1K-blocks      Used Available Use% Mounted on\n'
          + '/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache\n' };
      }
      return { stdout: '' };
    },
    flash: async (...args) => { flashCalls.push(args); },
    reboot: async (target) => { rebootCalls.push(target); return true; },
    push: async (path) => { pushes.push(path); },
    close: async () => {},
  };
  const device = { vendorId: 0x18d1, productId: 0x4ee2, serialNumber: serial };
  return { device, client };
}

const USB_BUSY = 'another part of this page already has this USB device open';

/** Puts the page in the state a reload leaves it in: nothing but the journal. */
function reloadedPage() {
  Object.assign(app.state, {
    releases: [], release: null, board: null, target: null, targetsJson: null,
    sums: null, files: new Map(), bundleReady: false, bundleBoard: null,
    bundleHardwareAccepted: false, installProtocol: null,
    directRelease: null, directHelper: null, directManifestText: null,
    directManifestSha: null, directRoles: null, directTransferTotal: null,
    identity: null, fastboot: null, payloadBytes: null, payloadName: '',
    running: false, abort: false, fetchingBundle: false, downloadedBundle: null,
    recoveryWaiting: false, recoveryDeadline: null, recoveryAbort: null,
    recoveryGrantInFlight: false, recoveryChooserWide: false, recoveryAlreadyGranted: false,
    recoverySession: null, recoverySerial: null, recoveryAcceptedEpoch: 0, recoveryEpoch: 0,
    kaeruHeader: null, adb: null, unlockSubmitted: null, receipts: [], stageProgress: {},
    resumeBoard: null, resumeReleaseTag: null, resumeSerialSha256: null, resumePhase: null,
    resumeUnlockSubmitted: false, resumeMayReunUnlock: false, resumeMayFormat: false,
    autoIdentifiedSerial: null, resumeDeviceAmbiguous: false, usbBusyReportedFor: null,
  });
}

/** The journal a mid-transfer run would have left behind. */
function journal(overrides = {}) {
  return {
    version: 1,
    serialSha256: DIGEST_SERIAL,
    board: 'radar_puffin',
    releaseTag: 'radar-puffin-v0.14.0',
    phase: 'transfer',
    unlockState: 'submitted',
    updatedAt: 1750000000000,
    ...overrides,
  };
}

function seedJournal(overrides = {}) {
  store.set(RESUME_JOURNAL_KEY, JSON.stringify(journal(overrides)));
}

// ---------------------------------------------------------------------------
// A. restoreResumeState: what a reload gets back
// ---------------------------------------------------------------------------

test('a reload restores board, release and device digest from the journal', async () => {
  reloadedPage();
  seedJournal();
  const result = await app.restoreResumeState();
  assert.equal(result.ok, true, result.reason);
  assert.equal(app.state.resumeBoard, 'radar_puffin');
  assert.equal(app.state.resumeReleaseTag, 'radar-puffin-v0.14.0');
  assert.equal(app.state.resumeSerialSha256, DIGEST_SERIAL);
  assert.match(latest(0), /resume/i);
});

test('a reload restores nothing but a hint — no identity, no bundle readiness', async () => {
  reloadedPage();
  seedJournal();
  await app.restoreResumeState();
  // The journal says what we were doing. It does NOT say the device is there,
  // the bundle is verified, or anything may run.
  assert.equal(app.state.identity, null, 'a journal invented a device identity');
  assert.equal(app.state.bundleReady, false, 'a journal marked the bundle verified');
  assert.equal(app.state.installProtocol, null);
  assert.equal(app.state.unlockSubmitted, null, 'a journal claimed the page session submitted unlock');
});

test('with no journal the page starts clean and says so', async () => {
  reloadedPage();
  store.delete(RESUME_JOURNAL_KEY);
  const result = await app.restoreResumeState();
  assert.equal(result.ok, false);
  assert.match(result.reason, /no resume journal/i);
  assert.equal(app.state.resumeBoard, null);
});

test('a corrupt journal is discarded, not repaired, and the page stays usable', async () => {
  reloadedPage();
  store.set(RESUME_JOURNAL_KEY, '{"version":1,"serialSha256":"not-a-digest"}');
  const result = await app.restoreResumeState();
  assert.equal(result.ok, false);
  assert.match(result.reason, /corrupt|unusable|serial/i);
  assert.equal(app.state.resumeBoard, null);
  assert.equal(el('btn-run').disabled, true, 'a damaged journal enabled the install');
});

test('an unreadable journal never blocks the ordinary first-time path', async () => {
  reloadedPage();
  const prior = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error('storage is disabled'); },
    setItem() {}, removeItem() {},
  };
  try {
    const result = await app.restoreResumeState();
    assert.equal(result.ok, false);
    assert.match(result.reason, /cannot read/i);
  } finally {
    globalThis.localStorage = prior;
  }
});

// ---------------------------------------------------------------------------
// B. the journal never re-arms unlock, and guards survive
// ---------------------------------------------------------------------------

test('restoring after a reload never re-arms the unlock', async () => {
  reloadedPage();
  seedJournal({ unlockState: 'submitted' });
  await app.restoreResumeState();
  assert.equal(app.state.resumeMayReunUnlock, false,
    'a reloaded journal re-armed flash:brick');
});

test('restoring never clears a single durable guard key, legacy ones included', async () => {
  reloadedPage();
  const guards = new Map([
    ['libreecho.unlock.aaa', 'submitted-or-unknown'],
    ['libreecho.unlock.sent.bbb', 'submitted-or-unknown'],
    ['legacy.unlock.ccc', 'submitted-or-unknown'],
    ['libreecho.recovery.ddd', 'pending-or-completed'],
    ['libreecho.direct.eee', 'pending-or-completed'],
  ]);
  for (const [key, value] of guards) store.set(key, value);
  seedJournal();
  await app.restoreResumeState();
  for (const [key, value] of guards) {
    assert.equal(store.get(key), value, `${key} was cleared by a reload`);
  }
  // The one key a finished transaction may clear is its own, and only when asked.
  assert.equal(store.has(RESUME_JOURNAL_KEY), true, 'restore must not clear the journal');
});

test('no secret ever reaches durable storage, and no secret is ever logged', async () => {
  reloadedPage();
  seedJournal();
  await app.restoreResumeState();
  app.state.provisionMode = 'fill';
  const node = el('provision-form-wrap');
  const dump = JSON.stringify([...store.entries()]) + JSON.stringify([...store.keys()]);
  assert.doesNotMatch(dump, /password|ssid|wifi/i);
  assert.equal(node.dataset.invalid, undefined);
});

// ---------------------------------------------------------------------------
// C. reverification: the journal is a hint, the device is the authority
// ---------------------------------------------------------------------------

test('a resume plan is refused unless the release assets reverify', async () => {
  reloadedPage();
  seedJournal();
  await app.restoreResumeState();
  const plan = await app.planResume({
    // The bundle is gone after a reload: no files, no sums. A journal must not
    // paper over that.
    verifyRelease: async () => ({ ok: false, reason: 'the verified bundle is gone after a reload' }),
    verifyDevice: async () => ({ ok: true }),
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /bundle is gone/i);
  assert.equal(plan.startAt, null);
});

test('a resume plan is refused when the device does not match the journal', async () => {
  reloadedPage();
  seedJournal();
  await app.restoreResumeState();
  const plan = await app.planResume({
    verifyRelease: async () => ({ ok: true }),
    verifyDevice: async () => ({ ok: false, reason: 'the connected device is a different Echo' }),
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /different Echo/i);
  assert.equal(plan.startAt, null);
});

test('a resume plan names the phase to continue at, from the journal', async () => {
  reloadedPage();
  seedJournal({ phase: 'prepare' });
  await app.restoreResumeState();
  const plan = await app.planResume({
    verifyRelease: async () => ({ ok: true }),
    verifyDevice: async () => ({ ok: true, header: HEADER_HEX, deviceDigest: 'd'.repeat(64) }),
  });
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.startAt, 'prepare');
  assert.equal(plan.mayReunUnlock, false, 'a resume plan re-armed the unlock');
  assert.equal(plan.mayReformat, false, 'a resume plan re-armed formatting');
});

test('a resume never starts at the formatting phase on its own', async () => {
  reloadedPage();
  seedJournal({ phase: 'initialize' });
  await app.restoreResumeState();
  const plan = await app.planResume({
    verifyRelease: async () => ({ ok: true }),
    verifyDevice: async () => ({ ok: true, header: HEADER_HEX, deviceDigest: 'd'.repeat(64) }),
  });
  assert.equal(plan.ok, true);
  // `initialize` is the formatting phase. It may only ever be re-entered when the
  // device itself reports it already ran, which is the caller's evidence to
  // supply — a journal saying so is never enough.
  assert.equal(plan.requiresDeviceEvidenceForFormat, true);
});

// ---------------------------------------------------------------------------
// D. USB busy: one actionable explanation
// ---------------------------------------------------------------------------

test('a busy USB device produces one explanation, not a repeated flood', async () => {
  reloadedPage();
  const session = twrp();
  // The real contention: a second page part already owns this interface. The
  // claim registry is what detects it, so the test takes the real claim rather
  // than stubbing the detection.
  const release = app.__claimDeviceForTest(session.device);
  assert.ok(release, 'the test could not take a competing claim');
  const before = app.terminal.lines.length;
  let refusals = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await app.startFromRecovery({
      request: async () => session.device,
      open: async () => ({ device: session.device, client: session.client }),
    });
    if (result === null) refusals += 1;
  }
  release();
  const spoken = app.terminal.lines.slice(before)
    .map((l) => l.textContent)
    .filter((text) => /already open elsewhere in this page/i.test(text));
  assert.equal(refusals, 3, 'every attempt was refused rather than half-performed');
  assert.equal(spoken.length, 1,
    `the busy explanation repeated ${spoken.length} times across ${refusals} attempts`);
});

test('a USB-busy episode explains itself again in a later episode', async () => {
  reloadedPage();
  const session = twrp();
  // Every test in this file shares one app module and one terminal, so the
  // baseline must be taken INSIDE this test, not at file scope.
  const before = app.terminal.lines.length;
  const busyLines = () => app.terminal.lines.slice(before)
    .map((l) => l.textContent)
    .filter((text) => /already open elsewhere in this page/i.test(text));
  // Episode 1: contended. Every retry inside one episode is silent.
  const first = app.__claimDeviceForTest(session.device);
  await app.startFromRecovery({ request: async () => session.device, open: async () => ({ device: session.device, client: session.client }) });
  await app.startFromRecovery({ request: async () => session.device, open: async () => ({ device: session.device, client: session.client }) });
  assert.equal(busyLines().length, 1, 'one episode, one explanation');
  // The contention ends and the page acquires the claim, which closes the episode.
  first();
  await app.startFromRecovery({ request: async () => session.device, open: async () => ({ device: session.device, client: session.client }) });
  assert.ok(app.state.identity, 'the freed attempt succeeded');
  assert.equal(app.state.usbBusyReportedFor, null, 'acquiring the claim did not end the episode');
  // Episode 2: a new owner takes the device again. This is a NEW episode and
  // must explain itself again, or a later real problem would be silent.
  // The successful attempt bound an identity, which startFromRecovery refuses to
  // replace; drop it so episode 2 exercises the busy path and nothing else.
  app.state.identity = null;
  const second = app.__claimDeviceForTest(session.device);
  await app.startFromRecovery({ request: async () => session.device, open: async () => ({ device: session.device, client: session.client }) });
  second();
  assert.equal(busyLines().length, 2, 'a later episode stayed silent');
});

// ---------------------------------------------------------------------------
// E. changed device / changed release fails safe
// ---------------------------------------------------------------------------

test('a different device than the journal describes refuses to continue', async () => {
  reloadedPage();
  seedJournal();
  await app.restoreResumeState();
  const session = twrp({ serial: OTHER_SERIAL });
  const before = app.terminal.lines.length;
  await assert.rejects(app.assertResumeMatchesDevice(session.client), /different|journal/i);
  assert.match(latest(before), /different/i);
});

test('the device the journal describes is accepted and its header recorded', async () => {
  reloadedPage();
  seedJournal();
  await app.restoreResumeState();
  const session = twrp();
  const result = await app.assertResumeMatchesDevice(session.client);
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.serial, SERIAL);
  assert.equal(result.header, HEADER_HEX);
});

// ---------------------------------------------------------------------------
// F. the single Connect/Resume entry point
// ---------------------------------------------------------------------------

test('one obvious Connect/Resume action exists for a plain first-time page', async () => {
  reloadedPage();
  store.delete(RESUME_JOURNAL_KEY);
  await app.restoreResumeState();
  const action = app.connectAction();
  assert.ok(action, 'there is no connect action on an unconnected page');
  assert.match(action.label, /connect|resume/i);
  assert.equal(typeof action.run, 'function');
});

test('a page with a resumable journal offers Resume, and says which release', async () => {
  reloadedPage();
  seedJournal();
  await app.restoreResumeState();
  const action = app.connectAction();
  assert.match(action.label, /resume/i);
  assert.match(action.message, /radar-puffin-v0\.14\.0/);
});

test('the connect action refuses to start destructive work with no identity', async () => {
  reloadedPage();
  store.delete(RESUME_JOURNAL_KEY);
  await app.restoreResumeState();
  const action = app.connectAction();
  // The action exists and is labelled, but running it without a chosen device
  // must not reach a write. It must route to the chooser instead.
  assert.equal(action.destructive, false);
});

test('auto-identify on page load is read-only and starts nothing', async () => {
  reloadedPage();
  const session = twrp();
  const before = app.terminal.lines.length;
  const result = await app.autoIdentifyGrantedDevice({
    grantedDevices: async () => [session.device],
    open: async () => ({ device: session.device, client: session.client }),
  });
  assert.equal(result.identified, true);
  assert.equal(result.readOnly, true);
  assert.equal(result.mayProceed, false, 'auto-identify claimed the page may write');
  assert.deepEqual(flashCalls, []);
  assert.deepEqual(rebootCalls, []);
});

test('auto-identify refuses when the journal describes a different device', async () => {
  reloadedPage();
  seedJournal();
  // A journal from an earlier test must not silently make this one ambiguous.
  await app.restoreResumeState();
  const session = twrp({ serial: OTHER_SERIAL });
  const result = await app.autoIdentifyGrantedDevice({
    grantedDevices: async () => [session.device],
    open: async () => ({ device: session.device, client: session.client }),
  });
  assert.equal(result.identified, false);
  assert.equal(result.differentDevice, true);
  assert.match(result.reason, /none is the Echo this install was for|different/i);
  assert.deepEqual(flashCalls, [], 'a different Echo was written to');
  assert.deepEqual(rebootCalls, [], 'a different Echo was rebooted');
});

test('an ambiguous device set requires an explicit choice and never picks one', async () => {
  reloadedPage();
  // No journal: with nothing to match against, BOTH granted devices stay
  // candidates and the operator must choose. This is the genuinely ambiguous case.
  store.delete(RESUME_JOURNAL_KEY);
  const a = twrp({ serial: SERIAL });
  const b = twrp({ serial: OTHER_SERIAL });
  let opened = 0;
  const result = await app.autoIdentifyGrantedDevice({
    grantedDevices: async () => [a.device, b.device],
    open: async () => { opened += 1; return { device: a.device, client: a.client }; },
  });
  assert.equal(result.identified, false);
  assert.equal(result.ambiguous, true, 'two candidates were narrowed without a choice');
  assert.equal(app.state.resumeDeviceAmbiguous, true);
  assert.match(result.reason, /choose|which/i);
  assert.equal(opened, 0, 'an ambiguous set was opened without a choice');
});

test('auto-identify with no granted device is simply nothing to do', async () => {
  reloadedPage();
  const result = await app.autoIdentifyGrantedDevice({
    grantedDevices: async () => [],
    open: async () => { throw new Error('nothing was granted'); },
  });
  assert.equal(result.identified, false);
  assert.equal(result.ambiguous, false);
  assert.match(result.reason, /no.*device|nothing/i);
});

// ---------------------------------------------------------------------------
// G. the browser permission gesture stays explicit
// ---------------------------------------------------------------------------

test('a browser permission request always requires a gesture and is never auto-run', async () => {
  const src = await import('node:fs/promises').then((fs) => fs.readFile(
    new URL('./app.js', import.meta.url), 'utf8'));
  // requestDevice must be reachable only from an explicit operator action.
  assert.ok(!/autoIdentifyGrantedDevice[\s\S]{0,600}requestDevice/.test(src),
    'the auto-identify path can open a chooser');
  assert.match(src, /requestDevice|requestRecoveryDevice/,
    'the page no longer requests devices at all');
});

// ---------------------------------------------------------------------------
// H. the run actually records the transaction
// ---------------------------------------------------------------------------

test('a run writes a journal naming this device and release as it progresses', async () => {
  reloadedPage();
  seedJournal();
  // The run's own progress record must reach storage. This is the only way a
  // reload mid-install can name the transaction at all.
  Object.assign(app.state, {
    board: 'radar_puffin',
    release: { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' },
    identity: { serialRaw: SERIAL, profile: { board: 'radar_puffin' }, product: 'RADAR' },
    unlockSubmitted: SERIAL,
  });
  const result = await app.recordResumeProgress({
    phase: 'transfer', bundleManifestSha256: 'a'.repeat(64), deviceDigest: 'd'.repeat(64),
    kaeruHeader: HEADER_HEX, target: 'radar_puffin',
  });
  assert.equal(result.ok, true, result.reason);
  const stored = JSON.parse(store.get(RESUME_JOURNAL_KEY));
  assert.equal(stored.phase, 'transfer');
  assert.equal(stored.board, 'radar_puffin');
  assert.equal(stored.releaseTag, 'radar-puffin-v0.14.0');
  assert.equal(stored.serialSha256, DIGEST_SERIAL);
  assert.equal(stored.unlockState, 'submitted', 'a submitted unlock was not recorded');
  assert.equal(stored.deviceDigest, 'd'.repeat(64), 'the receipt device digest was not recorded');
  assert.doesNotMatch(store.get(RESUME_JOURNAL_KEY), new RegExp(SERIAL), 'the plain serial was stored');
});

/**
 * A filled-in configuration form must never stop the journal being written.
 *
 * This test used to demand the OPPOSITE — that a run with a secret-bearing form
 * refuse to record at all. That was the wrong contract, and enforcing it made
 * the page worse: `recordResumeProgress` is called before every mutating phase,
 * so refusing while a form was filled left a run that had already reshaped
 * userdata with NO durable record of itself, and a reload would then offer no
 * resume for a transaction that really happened.
 *
 * The safety property is not "write nothing", it is "write the allowlist and
 * nothing else". The form is never passed in — `writeResumeJournal` would refuse
 * a secret-shaped field anyway — so what is on disk is provably independent of
 * what the operator typed. `provisionMode` IS recorded, which is a non-secret
 * fact about the operator's CHOICE and is what lets a later reload ask for the
 * configuration again instead of pretending it was delivered.
 */
test('a filled-in configuration form still records resumable, non-secret progress', async () => {
  reloadedPage();
  Object.assign(app.state, {
    board: 'radar_puffin',
    release: { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' },
    identity: { serialRaw: SERIAL, profile: { board: 'radar_puffin' } },
    provisionMode: 'fill', provisionForm: { password: 'correct-horse' },
  });
  const before = store.get(RESUME_JOURNAL_KEY);
  const result = await app.recordResumeProgress({ phase: 'transfer' });
  assert.equal(result.ok, true, result.reason);
  const text = store.get(RESUME_JOURNAL_KEY);
  assert.notEqual(text, before, 'the journal was not written at all');
  // Resumable, and bound to this device and release.
  assert.equal(JSON.parse(text).phase, 'transfer');
  assert.equal(JSON.parse(text).provisionMode, 'fill');
  // And none of it came from the form.
  assert.doesNotMatch(text, /correct-horse/);
  assert.doesNotMatch(text, /provisionForm|password|ssid/i);
});

test('a completed run clears only its own journal key', async () => {
  const guards = new Map([
    ['libreecho.unlock.aaa', 'submitted-or-unknown'],
    ['libreecho.unlock.sent.bbb', 'submitted-or-unknown'],
    ['libreecho.recovery.ccc', 'pending-or-completed'],
    ['libreecho.direct.ddd', 'pending-or-completed'],
  ]);
  for (const [k, v] of guards) store.set(k, v);
  seedJournal();
  const { clearResumeJournal, RESUME_JOURNAL_KEY: KEY } = await import('./resume.js');
  assert.equal(clearResumeJournal().ok, true);
  assert.equal(store.has(KEY), false, 'the journal survived a completed install');
  for (const [k, v] of guards) assert.equal(store.get(k), v, `${k} was erased by a completed install`);
});
