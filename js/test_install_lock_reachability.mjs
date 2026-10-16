// Proof that the app-level install fixtures reach the paths they were written to
// test — and that they do so BECAUSE the writer lock was granted, not because
// something bypassed it.
//
// The failure this exists to prevent is quiet. js/writer-lock.js fails closed, so
// when a fixture has no `navigator.locks`, `runInstall` refuses before the first
// device command. Every assertion that only checks "this phase did not happen" or
// "the log does not contain X" then passes trivially, and the suite looks green
// while proving nothing. A v2 install test asserting a phase list is a little
// better — it fails loudly with an empty array — but a suite that only ever
// asserts absence is a suite that proves absence.
//
// Three cases, in order:
//
//   1. WITH the lock: a real install runs every phase and every device write is
//      recorded. This is the "did we reach the intended path" half.
//   2. WITHOUT the lock (navigator.locks removed): the SAME install is refused
//      before the first device command, and the refusal names Web Locks. This is
//      the half that proves the tests are not passing vacuously — it reproduces
//      the exact symptom the fixture migration fixed.
//   3. The refused run left no state behind, so a following run is not poisoned.
//
// app.js is imported unmodified. Nothing here stubs writer-lock.js.
import test from 'node:test';
import assert from 'node:assert/strict';

// --- the same minimal DOM + navigator the app fixtures use --------------------
class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.queryNodes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {} };
    this.textContent = ''; this.disabled = false; this.hidden = false;
    this.value = ''; this.checked = false;
  }
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  querySelector(selector) {
    if (!this.queryNodes.has(selector)) this.queryNodes.set(selector, new Element());
    return this.queryNodes.get(selector);
  }
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

const { installWebLocksFixture, resetWebLocksFixture } = await import('./web-locks-fixture.mjs');
const { sha256Blob, sha256Bytes } = await import('./sha256.js');
const { DIRECT_HELPER_BYTES } = await import('./combined-fixture.mjs');
const { phaseReply, readbackReply } = await import('./direct-test-protocol.mjs');

const HEADER_HEX = '8816885870b203004c4b000000000000';
const HEADER_SPACED = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const DF_OK = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
  '/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache', ''].join('\n');
const DF_OK_DATA = ['Filesystem     1K-blocks      Used Available Use% Mounted on',
  '/dev/block/mmcblk0p49 60000000 100000 59000000  10% /data', ''].join('\n');
// The real protocol-2 manifest shape, not a placeholder: app.js re-parses this
// text against the selected target before any phase runs, and a malformed one
// stops the run at the manifest gate — which would look exactly like a lock
// refusal in a phase-list assertion.
const V2_MANIFEST = [
  'schema=1', 'protocol=2', 'release=radar-puffin-build-test', 'device=radar_puffin',
  'target=radar_puffin', 'fastboot_products=RADAR', 'transfer_bytes_total=4096',
  'transfer=boot:boot.img:' + 'b'.repeat(64),
  'transfer=ota-manifest:manifest:' + '1'.repeat(64),
  'transfer=ota-signature:manifest.sig:' + '2'.repeat(64),
  'transfer=local-package:update.ota.tar:' + '4'.repeat(64),
  'staging=airplay2:p.squashfs:' + '3'.repeat(64) + ':m.json:' + '5'.repeat(64),
].join('\n');

// The real app, with the Web Locks double in place — the same installation order
// the tracked fixtures use.
installWebLocksFixture();
const app = await import('./app.js');
// The post-reboot wait for LibreEcho is covered by test_post_install*.mjs.
app.__setPostInstallHookForTest(async () => {});

test.beforeEach(() => { resetWebLocksFixture(); });

// --- a recording ADB device, so a REACHED phase is visible -------------------
// Same answers as the proven js/test_direct_install.mjs fixture: a v2 direct run
// re-reads the recovery identity (TWRP version, uevent, partition size, Kaeru
// header) before the first phase, so a device that cannot answer those stops the
// run with an empty phase list — indistinguishable from a lock refusal unless the
// log is checked.
function directAdb() {
  const records = { phases: [], controlPushes: [], bulkPushes: [], push: [], shell: [] };
  const calls = [];
  const landed = new Map();
  const adb = {
    records, calls,
    shell: async (command) => {
      records.shell.push(command); calls.push(command);
      if (command.includes('ro.twrp.version')) return { stdout: '3.7.0_9-0\nradar_puffin\nTEST-DOT\n' };
      if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
      if (command.includes('mmcblk0p7/size')) return { stdout: '20480\n' };
      if (command.includes('od -An')) return { stdout: `${HEADER_SPACED}\n` };
      if (command.startsWith('df ')) return { stdout: command.includes('/data') ? DF_OK_DATA : DF_OK };
      const readback = await readbackReply(command, landed);
      if (readback) return readback;
      if (command.includes('--phase ')) {
        const phase = /--phase (\w+)/.exec(command)[1];
        const dry = command.includes('--dry-run');
        records.phases.push(`${phase}${dry ? ':dry-run' : ''}`);
        if (phase === 'prepare') return phaseReply(command, 'result=prepare-noop\nreboot_required=0\n');
        if (phase === 'initialize') return phaseReply(command, 'result=initialized\nformat_state=formatted\n');
        if (phase === 'transfer') return phaseReply(command, 'result=transferred\n');
        if (phase === 'finalize' && dry) return phaseReply(command, 'result=dry-run-ok\n');
        if (phase === 'finalize') return phaseReply(command, 'result=installed\n');
      }
      return { stdout: '' };
    },
    push: async (path, blob) => {
      calls.push(`push ${path}`); records.push.push(path);
      if (path.startsWith('/cache/libreecho-direct/')) records.controlPushes.push(path);
      if (path.startsWith('/data/libreecho/incoming/')) records.bulkPushes.push(path);
      landed.set(path, blob);
    },
    flash: async (...args) => { throw new Error('a v2 direct run must never flash'); },
    reboot: async (target) => { records.reboot = target; return true; },
    close: async () => {},
  };
  return adb;
}

async function primeDirectRun(adb) {
  const prefix = 'libreecho-radar-puffin';
  const roles = [
    { role: 'transfer:boot', name: `${prefix}-boot.img`, content: 'boot-bytes' },
    { role: 'transfer:ota-manifest', name: 'manifest', content: 'signed-manifest-bytes' },
    { role: 'transfer:ota-signature', name: 'manifest.sig', content: 'sig-hex-bytes' },
    { role: 'transfer:local-package', name: `${prefix}.ota.tar`, content: 'ota-tar-bytes' },
    { role: 'staging:airplay2:payload', name: `${prefix}-airplay2.squashfs`, content: 'payload' },
    { role: 'staging:airplay2:manifest', name: `${prefix}-airplay2.manifest.json`, content: 'fm' },
  ];
  const files = new Map(); const sums = new Map();
  for (const role of roles) {
    const blob = new Blob([role.content]); blob.name = role.name;
    files.set(role.name, blob); sums.set(role.name, await sha256Blob(blob));
  }
  const manifestText = V2_MANIFEST;
  const directRoles = roles.map(r => ({ role: r.role, name: r.name, sha256: sums.get(r.name), size: files.get(r.name).size }));
  Object.assign(app.state, {
    release: { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' },
    identity: { product: 'RADAR', unlockStatus: 'true',
      profile: { id: 'radar', product: 'RADAR', marketing: 'Echo', board: 'radar_puffin', libreEcho: 'reference', lkBuildMap: {} },
      lkBuild: '59779ca-20220524_183401', serialRaw: 'TEST-DOT' },
    target: { board: 'radar_puffin', slug: 'radar-puffin', prefix, legacy: false },
    board: null, targetsJson: null,
    files, sums, bundleReady: true, bundleBoard: 'radar_puffin', bundleHardwareAccepted: true,
    installProtocol: 2, directRelease: 'radar-puffin-build-test',
    directManifestText: manifestText,
    directManifestSha: await sha256Bytes(new TextEncoder().encode(manifestText)),
    directHelper: new TextEncoder().encode(DIRECT_HELPER_BYTES),
    directRoles, directTransferTotal: directRoles.reduce((s, r) => s + r.size, 0),
    abort: false, running: false, kaeruHeader: HEADER_HEX, recoverySerial: 'TEST-DOT',
    adb: adb ?? directAdb(), fastboot: null, receipts: [],
    writerLock: null, provisionMode: 'skip', provisionState: 'idle',
  });
  return app.state;
}

const withLocalStorage = (fn) => async () => {
  const prior = globalThis.localStorage;
  const entries = new Map();
  globalThis.localStorage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: (key) => entries.delete(key),
  };
  try { await fn(entries); } finally { globalThis.localStorage = prior; }
};

test('WITH the lock: the install reaches every phase and records every device write', withLocalStorage(async () => {
  const adb = directAdb();
  await primeDirectRun(adb);
  await app.runInstall({ dryRun: false });

  // This is the assertion that could not pass vacuously: an empty phase list is a
  // failure, so a fail-closed run cannot satisfy it.
  assert.deepEqual(adb.records.phases,
    ['prepare', 'initialize', 'transfer', 'finalize:dry-run', 'finalize'],
    'the run stopped before the phases it was written to test');
  assert.equal(adb.records.controlPushes.length, 2, 'the control helper was never pushed');
  assert.equal(adb.records.bulkPushes.length, 6, `bulk pushes: ${adb.records.bulkPushes.join(', ')}`);
  assert.equal(app.state.writerLock, null, 'the writer lock was not released after the run');
}));

test('WITHOUT the lock: the same install is refused before the first device command', withLocalStorage(async () => {
  // Remove the API entirely — this is exactly what a node fixture without the
  // Web Locks double provides, and it is the symptom the migration fixed.
  const saved = globalThis.navigator.locks;
  delete globalThis.navigator.locks;
  try {
    const adb = directAdb();
    await primeDirectRun(adb);
    await app.runInstall({ dryRun: false });

    assert.deepEqual(adb.records.phases, [], 'a run with no Web Locks still wrote to the device');
    assert.deepEqual(adb.calls, [], 'a run with no Web Locks still issued a device command');
    assert.match(app.terminal.plainText(), /does not offer Web Locks/i,
      'the refusal did not name the missing API');
  } finally {
    globalThis.navigator.locks = saved;
  }
}));

test('the refused run leaves no lock behind, so the next run installs normally', withLocalStorage(async () => {
  const saved = globalThis.navigator.locks;
  delete globalThis.navigator.locks;
  try {
    await primeDirectRun(directAdb());
    await app.runInstall({ dryRun: false });
    assert.equal(app.state.writerLock, null, 'a refused run kept a writer lock');
  } finally {
    globalThis.navigator.locks = saved;
  }

  // Same page, next press. If the refusal had leaked a lock, this would stop
  // with "another tab of this page is installing" — a failure an operator would
  // hit at exactly the worst moment: right after a refusal.
  const adb = directAdb();
  await primeDirectRun(adb);
  await app.runInstall({ dryRun: false });
  assert.deepEqual(adb.records.phases,
    ['prepare', 'initialize', 'transfer', 'finalize:dry-run', 'finalize'],
    'the retry after a refusal did not reach its phases');
}));

test('the run really did take and then release the origin-wide lock', withLocalStorage(async () => {
  const seen = [];
  const realRequest = globalThis.navigator.locks.request.bind(globalThis.navigator.locks);
  globalThis.navigator.locks.request = (name, options, callback) => {
    seen.push({ name, ifAvailable: options?.ifAvailable === true });
    return realRequest(name, options, callback);
  };
  const adb = directAdb();
  try {
    await primeDirectRun(adb);
    await app.runInstall({ dryRun: false });
  } finally {
    delete globalThis.navigator.locks.request;
  }

  // The app asked for the real origin-wide mutex, in the refusing form.
  assert.equal(seen.length, 1, `expected one lock request, saw ${JSON.stringify(seen)}`);
  assert.equal(seen[0].name, 'libreecho.writer.exclusive/1',
    'the run asked for a different lock than every other tab of this origin');
  assert.equal(seen[0].ifAvailable, true, 'the run queued instead of refusing a second writer at once');
  // And the run only completed because that request was GRANTED: the same run
  // with no Web Locks at all stops with zero phases (the case above).
  assert.deepEqual(adb.records.phases,
    ['prepare', 'initialize', 'transfer', 'finalize:dry-run', 'finalize'],
    'the granted run did not reach its phases');
}));