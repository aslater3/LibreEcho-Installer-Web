// Issue #28 (from aslater3/LibreEcho#322): resume a part-finished or finished
// direct install from the Echo's own transaction state, and recognise an
// installed LibreEcho on ADB.
//
// The reporter's Dot had finished the whole install (transaction.state
// phase=finalized, receipt result=installed), but every later run in the same
// browser stopped at "prepare phase already attempted", because the page's
// localStorage attempt guard refused any repeat and nothing read the device.
// When the Dot was running LibreEcho (18d1:d001, no getprop), the page only
// said "ADB answered but TWRP is not running".
//
// These pin the state machine in direct-install.js (`classifyDirectTransaction`)
// through the real page: the device's record decides, the browser guard is only
// passed when that record proves the earlier outcome, uncertain states refuse
// with the exact state and next step, nothing is ever reset, and LibreEcho is
// reported as installed with the post-install handoff. Fake transports only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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
  value: { usb: { getDevices: async () => [], requestDevice: async () => { throw new Error('background code opened a permission prompt'); } } },
});

const app = await import('./app.js');
const direct = await import('./direct-install.js');
const { sha256Bytes } = await import('./sha256.js');

const handoffs = [];
app.__setPostInstallHookForTest(async (args) => { handoffs.push(args); });

const sha = (text) => createHash('sha256').update(text).digest('hex');
const SERIAL = 'TEST-DOT-0028';
const TAG = 'radar-puffin-v0.14.4';
const RELEASE = 'radar-puffin-v0.14.4';
const TARGET = 'biscuit';
const GUID = '0F2E5D1C-0000-4000-8000-0000DEADBEEF';
const DEVICE_DIGEST = sha(`target=${TARGET}\nserial=${SERIAL}\nuserdata_guid=${GUID}\n`);
const HEADER = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const HEADER_HEX = '8816885870b203004c4b000000000000';
const DF_CACHE = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/mmcblk0p11 1048576 100000 948576 10% /cache\n';
const DF_DATA = 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/mmcblk0p49 60000000 100000 59000000 10% /data\n';
const MANIFEST_TEXT = [
  'schema=1', 'protocol=2', `release=${RELEASE}`, `device=${TARGET}`, `target=${TARGET}`, 'fastboot_products=BISCUIT',
  'transfer=boot:libreecho-biscuit-boot.img:' + 'b'.repeat(64),
].join('\n');
const BUNDLE_SHA = sha(MANIFEST_TEXT);

const kv = (fields) => Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\n');

/** transaction.state exactly as the helper's guard_write lays it out. */
function guard({ phase, format, bundle = BUNDLE_SHA, target = TARGET, release = RELEASE, digest = DEVICE_DIGEST, protocol = '2' } = {}) {
  return `${kv({ protocol, target, release, bundle_manifest_sha256: bundle, device_digest: digest, format_state: format, phase })}\n`;
}

/** The reporter's finalize receipt (aslater3/LibreEcho#322), with this fixture's bindings. */
function installedReceipt({ result = 'installed', error = null, digest = DEVICE_DIGEST, release = RELEASE } = {}) {
  const fields = {
    protocol: '2', phase: 'finalize', invocation_id: 'e'.repeat(64), bundle_manifest_sha256: BUNDLE_SHA,
    invocation_sha256: sha(`2|finalize|${BUNDLE_SHA}|${digest}|${TARGET}|${release}`),
    target_check: 'match', target: TARGET, release, device_digest: digest,
    boot_a_sha256: '9'.repeat(64), boot_b_sha256: '9'.repeat(64), result,
    format_state: 'formatted', hardlinked: '15', features: 'airplay2 tts wakeword stt assistant',
    local_package: '/data/libreecho/update/incoming/local-install.ota.tar',
  };
  if (error) fields.error = error;
  return `${kv(fields)}\n`;
}

/** A phase receipt bound to the device digest the helper computes on this Echo. */
function phaseReply(command, body, digest = DEVICE_DIGEST) {
  const arg = (key) => new RegExp(`--${key} ([^ ]+)`).exec(command)?.[1];
  const values = { protocol: '2', phase: arg('phase'), invocation_id: arg('invocation-id'),
    bundle_manifest_sha256: arg('bundle-manifest-sha256'), device_digest: digest, target: arg('target'), release: arg('release') };
  values.invocation_sha256 = sha(`2|${values.phase}|${values.bundle_manifest_sha256}|${digest}|${values.target}|${values.release}`);
  return { stdout: `__HELPER_RC__0\n__RECEIPT__${kv(values)}\n${body}` };
}

/**
 * The Echo in TWRP: answers the transaction read from `state`/`receipt` (null =
 * file absent), the device-identity read, the Kaeru reads and the v2 phases.
 */
function twrpEcho({ state = null, receipt = null, readable = true, cacheMounted = true, guid = GUID, prepareReboot = false, onCommand = null } = {}) {
  const records = { shell: [], phases: [], controlPushes: [], bulkPushes: [], reboots: [] };
  const landed = new Map();
  const fence = (path, text) => (text == null ? `__LE_ABSENT__ ${path}\n` : `__LE_BEGIN__ ${path}\n${text}\n__LE_END__ ${path}\n`);
  return {
    records,
    shell: async (command) => {
      records.shell.push(command);
      onCommand?.(command);
      if (command === direct.DIRECT_TRANSACTION_READ_COMMAND) {
        return { stdout: readable ? `__LE_CACHE__ ${cacheMounted ? 'mounted' : 'unmounted'}\n`
          + fence(direct.DIRECT_TRANSACTION_PATH, state) + fence(direct.DIRECT_RECEIPT_PATH, receipt) : '' };
      }
      if (command === direct.DEVICE_IDENTITY_READ_COMMAND) {
        return { stdout: `le_serial=${SERIAL}\nle_boot_serial=${SERIAL}\nle_byname=/dev/block/mmcblk0p16\nle_sysfs=mmcblk0p16\n` };
      }
      if (command === '/sbin/sgdisk --info=16 /dev/block/mmcblk0') {
        return { stdout: `Partition GUID code: 0FC63DAF-8483-4772-8E79-3D69D8477DE4 (Linux filesystem)\nPartition unique GUID: ${guid}\nFirst sector: 1\n` };
      }
      if (command.includes('ro.twrp.version')) return { stdout: `3.7.0_9-0\n${TARGET}\n${SERIAL}\n` };
      if (command.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
      if (command.includes('/size')) return { stdout: '20480\n' };
      if (command.includes('od -An')) return { stdout: `${HEADER}\n` };
      if (command.startsWith('df ')) return { stdout: command.includes('/data') ? DF_DATA : DF_CACHE };
      if (command.startsWith('/sbin/sha256sum ')) {
        const path = command.split(' ')[1];
        const blob = landed.get(path);
        return { stdout: blob ? `${sha(Buffer.from(await blob.arrayBuffer()))}  ${path}\n` : '' };
      }
      if (command.startsWith('/sbin/twrp reboot')) { records.reboots.push(command); return { stdout: '' }; }
      if (command.includes('--phase ')) {
        const phase = /--phase (\w+)/.exec(command)[1];
        const dry = command.includes('--dry-run');
        records.phases.push(`${phase}${dry ? ':dry-run' : ''}`);
        if (phase === 'prepare') return phaseReply(command, `result=${prepareReboot ? 'prepare-ok' : 'prepare-noop'}\nreboot_required=${prepareReboot ? '1' : '0'}\n`);
        if (phase === 'initialize') return phaseReply(command, 'result=initialized\nformat_state=formatted\n');
        if (phase === 'transfer') return phaseReply(command, 'result=transferred\n');
        if (phase === 'finalize' && dry) return phaseReply(command, 'result=dry-run-ok\n');
        if (phase === 'finalize') return phaseReply(command, 'result=installed\n');
      }
      return { stdout: '' };
    },
    push: async (path, blob) => {
      if (path.startsWith('/cache/libreecho-direct/')) records.controlPushes.push(path);
      if (path.startsWith('/data/libreecho/incoming/')) records.bulkPushes.push(path);
      landed.set(path, blob);
    },
    close: async () => {},
  };
}

/** LibreEcho's own adbd (18d1:d001): no getprop, LibreEcho's markers. */
function libreEchoClient({ serial = SERIAL, target = TARGET } = {}) {
  const records = { shell: [], pushes: [], closed: 0 };
  return {
    records,
    shell: async (command) => {
      records.shell.push(command);
      if (command.includes('getprop')) {
        return { stdout: '/system/bin/sh: getprop: not found\n/system/bin/sh: getprop: not found\n/system/bin/sh: getprop: not found\n' };
      }
      if (command.includes('/etc/libreecho/target')) return { stdout: `le_target=${target}\nle_serial=${serial}\n` };
      return { stdout: '' };
    },
    push: async (path) => { records.pushes.push(path); },
    close: async () => { records.closed += 1; },
  };
}

const LIBREECHO_USB = { vendorId: 0x18d1, productId: 0xd001, productName: 'MT8163-ARM32-ADB', serialNumber: SERIAL };

let storage = new Map();
const withLocalStorage = (fn) => async () => {
  const prior = globalThis.localStorage;
  storage = new Map();
  globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k) };
  try { await fn(); } finally { globalThis.localStorage = prior; }
};

/** Marks phases as attempted in this browser, exactly as runDirectPhase keys them. */
async function markAttempted(...phases) {
  for (const phase of phases) {
    storage.set(`libreecho.direct.${await sha256Bytes(new TextEncoder().encode(`${SERIAL}:${TAG}:${phase}`))}`, 'pending-or-completed');
  }
}

/** A verified Dot build and an Echo already bound in TWRP (as after "My Echo is already in recovery"). */
async function primeRun(adb, { source = 'recovery' } = {}) {
  const roles = [
    ['transfer:boot', 'libreecho-biscuit-boot.img', 'boot-bytes'],
    ['transfer:ota-manifest', 'manifest', 'signed'],
    ['transfer:ota-signature', 'manifest.sig', 'sig'],
    ['transfer:local-package', 'libreecho-biscuit.ota.tar', 'ota'],
  ];
  const files = new Map();
  const sums = new Map();
  for (const [, name, content] of roles) {
    const blob = new Blob([content]); blob.name = name;
    files.set(name, blob); sums.set(name, sha(content));
  }
  const directRoles = roles.map(([role, name]) => ({ role, name, sha256: sums.get(name), size: files.get(name).size }));
  handoffs.length = 0;
  Object.assign(app.state, {
    release: { tag: TAG, assets: [] }, board: TARGET,
    target: { board: TARGET, slug: 'biscuit', prefix: 'libreecho-biscuit', legacy: false }, targetsJson: null,
    identity: { product: 'BISCUIT', unlockStatus: 'true', serialRaw: SERIAL, serialMasked: '••••0028', lkBuild: '',
      profile: { id: 'biscuit', product: 'BISCUIT', marketing: 'Echo Dot', board: TARGET, libreEcho: 'reference', lkBuildMap: {} },
      source },
    files, sums, bundleReady: true, bundleBoard: TARGET, bundleHardwareAccepted: true,
    installProtocol: 2, directRelease: RELEASE, directManifestText: MANIFEST_TEXT, directManifestSha: BUNDLE_SHA,
    directHelper: new TextEncoder().encode('#!/sbin/sh\n'), directRoles,
    directTransferTotal: directRoles.reduce((sum, role) => sum + role.size, 0),
    running: false, abort: false, fetchingBundle: false, unlockSubmitted: null, payloadBytes: null,
    recoveryWaiting: false, recoveryDeadline: null, recoveryAbort: null, recoveryGrantInFlight: false,
    recoveryOtherSerial: null, recoveryLibreEcho: null, recoveryAlreadyGranted: false,
    adb: adb ?? null, recoverySession: adb ? { client: adb } : null, recoverySerial: adb ? SERIAL : null,
    kaeruHeader: adb ? HEADER_HEX : null, recoveryAcceptedEpoch: adb ? app.state.recoveryEpoch : 0,
    receipts: [], stageProgress: {},
  });
}

const logText = () => app.terminal.plainText();
const logSince = (mark) => logText().slice(mark);
const RUN_TIMEOUT = { timeout: 60000 };

// ---------------------------------------------------------------------------
// A. the reporter's case: finished on the device, guard set in this browser
// ---------------------------------------------------------------------------

test('#28: finalized + installed on the Echo with the prepare guard set goes straight to the handoff, running no phase',
  RUN_TIMEOUT, withLocalStorage(async () => {
    const adb = twrpEcho({ state: guard({ phase: 'finalized', format: 'formatted' }), receipt: installedReceipt() });
    await primeRun(adb);
    await markAttempted('prepare');
    const mark = logText().length;
    await app.runInstall({ dryRun: false });
    const log = logSince(mark);
    assert.ok(!/already attempted/.test(log), `the browser guard still stopped the run:\n${log}`);
    assert.deepEqual(adb.records.phases, [], 'a phase ran against a finished install');
    assert.deepEqual(adb.records.controlPushes, [], 'control files were pushed to a finished install');
    assert.deepEqual(adb.records.bulkPushes, []);
    assert.ok(!adb.records.shell.some((c) => /--reset-transaction|mke2fs|sgdisk --delete/.test(c)));
    assert.deepEqual(adb.records.reboots, ['/sbin/twrp reboot'], 'the Echo was not rebooted into LibreEcho');
    assert.deepEqual(handoffs, [{ serial: SERIAL }], 'the post-install handoff (#24) did not start');
    assert.match(log, /receipt confirms result=installed/);
    assert.match(log, /LibreEcho is already installed on this Echo/);
    assert.match(log, /device digest was recomputed/);
    assert.ok(!log.includes(SERIAL), 'the full serial leaked into the log');
    assert.ok(!log.includes(DEVICE_DIGEST) && !log.includes(GUID), 'device identifiers leaked into the log');
  }));

test('#28: a finished install is recognised in a browser that never ran it too', RUN_TIMEOUT, withLocalStorage(async () => {
  const adb = twrpEcho({ state: guard({ phase: 'finalized', format: 'formatted' }), receipt: installedReceipt() });
  await primeRun(adb);
  await app.runInstall({ dryRun: false });
  assert.deepEqual(adb.records.phases, []);
  assert.deepEqual(handoffs, [{ serial: SERIAL }]);
}));

test('#28: the finished-install check binds the receipt even when the device digest cannot be recomputed',
  RUN_TIMEOUT, withLocalStorage(async () => {
    // No GUID from sgdisk: the receipt must then match the install state's own digest.
    const ok = twrpEcho({ guid: '', state: guard({ phase: 'finalized', format: 'formatted' }), receipt: installedReceipt() });
    await primeRun(ok);
    const mark = logText().length;
    await app.runInstall({ dryRun: false });
    assert.match(logSince(mark), /could not be recomputed/);
    assert.deepEqual(handoffs, [{ serial: SERIAL }]);
    const torn = twrpEcho({ guid: '', state: guard({ phase: 'finalized', format: 'formatted' }),
      receipt: installedReceipt({ digest: 'c'.repeat(64) }) });
    await primeRun(torn);
    await app.runInstall({ dryRun: false });
    assert.deepEqual(handoffs, [], 'a receipt bound to another device was accepted');
    assert.deepEqual(torn.records.phases, []);
  }));

// ---------------------------------------------------------------------------
// B. intermediate states resume from the device's record
// ---------------------------------------------------------------------------

test('#28: phase=prepare, not formatted: prepare is repeated (helper-safe) and the install continues, guards and all',
  RUN_TIMEOUT, withLocalStorage(async () => {
    const adb = twrpEcho({ state: guard({ phase: 'prepare', format: 'absent' }),
      receipt: 'protocol=2\nphase=prepare\nresult=prepare-ok\nreboot_required=1\n' });
    await primeRun(adb);
    await markAttempted('prepare', 'initialize');
    const mark = logText().length;
    await app.runInstall({ dryRun: false });
    assert.deepEqual(adb.records.phases, ['prepare', 'initialize', 'transfer', 'finalize:dry-run', 'finalize']);
    const log = logSince(mark);
    assert.match(log, /continues at prepare/);
    assert.match(log, /prepare phase on this Echo before; the Echo's install state \(phase=prepare\) proves/);
    assert.deepEqual(handoffs, [{ serial: SERIAL }]);
  }));

for (const phase of ['initialize', 'transfer']) {
  test(`#28: phase=${phase}, formatted: prepare and initialize are skipped and the install continues at transfer`,
    RUN_TIMEOUT, withLocalStorage(async () => {
      const adb = twrpEcho({ state: guard({ phase, format: 'formatted' }), receipt: 'protocol=2\nresult=failed\nerror=incomplete\n' });
      await primeRun(adb);
      await markAttempted('prepare', 'initialize', 'transfer', 'finalize');
      const mark = logText().length;
      await app.runInstall({ dryRun: false });
      assert.deepEqual(adb.records.phases, ['transfer', 'finalize:dry-run', 'finalize'],
        'a completed format was repeated or the install did not resume at transfer');
      assert.ok(!adb.records.shell.some((c) => c.includes('--phase initialize')), 'initialize (the only format) ran again');
      assert.equal(adb.records.bulkPushes.length, 4);
      assert.match(logSince(mark), /continues at transfer/);
      assert.deepEqual(handoffs, [{ serial: SERIAL }]);
    }));
}

test('#28: a resumed transfer still requires receipts bound to the device digest the install state recorded',
  RUN_TIMEOUT, withLocalStorage(async () => {
    const adb = twrpEcho({ state: guard({ phase: 'initialize', format: 'formatted', digest: 'c'.repeat(64) }) });
    // The recomputed digest (DEVICE_DIGEST) differs from the recorded one: refused before any phase.
    await primeRun(adb);
    const mark = logText().length;
    await app.runInstall({ dryRun: false });
    assert.deepEqual(adb.records.phases, []);
    assert.match(logSince(mark), /recorded for a different device identity/);
  }));

// ---------------------------------------------------------------------------
// C. uncertain or foreign states refuse with the exact state and next step
// ---------------------------------------------------------------------------

const REFUSALS = [
  ['an uncertain format', { state: guard({ phase: 'initialize', format: 'formatting' }) },
    /phase=initialize, format_state=formatting: formatting userdata started but was never confirmed.*never repeated automatically.*Leave the Echo in TWRP.*never resets/],
  ['an interrupted finalize', { state: guard({ phase: 'finalizing', format: 'formatted' }) },
    /phase=finalizing, format_state=formatted: finalize started writing the boot slots but never confirmed.*Leave the Echo in TWRP/],
  ['a finalized install whose receipt does not confirm it', {
    state: guard({ phase: 'finalized', format: 'formatted' }),
    receipt: installedReceipt({ result: 'failed', error: 'already-finalized' }) },
  /records the install as finished \(phase=finalized.*does not confirm it \(result=failed error=already-finalized\).*Restart the Echo normally/],
  ['another bundle manifest', { state: guard({ phase: 'transfer', format: 'formatted', bundle: 'f'.repeat(64) }) },
    /install transaction for a different build \(release radar-puffin-v0\.14\.4, target biscuit.*different bundle manifest\).*never runs a phase over, repeats or resets/],
  ['another release', { state: guard({ phase: 'finalized', format: 'formatted', release: 'radar-puffin-v0.14.3' }), receipt: installedReceipt() },
    /different build \(release radar-puffin-v0\.14\.3.*different (bundle manifest, )?release\).*That install finished: restart the Echo normally/],
  ['another target', { state: guard({ phase: 'prepare', format: 'absent', target: 'radar_puffin' }) },
    /different build \(release radar-puffin-v0\.14\.4, target radar_puffin.*different target\).*choose release radar-puffin-v0\.14\.4/],
  ['a malformed install state', { state: 'protocol=2\nphase=finalized\nphase=prepare\n' }, /is malformed/],
  ['an unknown phase', { state: guard({ phase: 'wiping', format: 'absent' }) }, /phase=wiping.*is not one this page understands/],
  ['an impossible combination', { state: guard({ phase: 'prepare', format: 'formatted' }) }, /phase=prepare, format_state=formatted\) is not a combination/],
];

for (const [name, fixture, pattern] of REFUSALS) {
  test(`#28: ${name} is refused with the exact state and runs nothing`, RUN_TIMEOUT, withLocalStorage(async () => {
    const adb = twrpEcho(fixture);
    await primeRun(adb);
    await markAttempted('prepare');
    const mark = logText().length;
    await app.runInstall({ dryRun: false });
    const log = logSince(mark);
    assert.match(log, pattern);
    assert.match(log, /install stage failed/);
    assert.deepEqual(adb.records.phases, [], `${name}: a phase ran`);
    assert.deepEqual(adb.records.controlPushes, [], `${name}: control files were pushed`);
    assert.deepEqual(adb.records.reboots, [], `${name}: the Echo was rebooted`);
    assert.deepEqual(handoffs, []);
    assert.ok(!adb.records.shell.some((c) => /--reset-transaction/.test(c)));
  }));
}

test('#28: when the install state cannot be read, an earlier attempt is still refused, with the exact phase', RUN_TIMEOUT,
  withLocalStorage(async () => {
    const adb = twrpEcho({ readable: false });
    await primeRun(adb);
    await markAttempted('prepare');
    const mark = logText().length;
    await app.runInstall({ dryRun: false });
    const log = logSince(mark);
    assert.match(log, /could not be read/);
    assert.match(log, /the prepare phase was already attempted from this browser on this Echo.*does not prove what that attempt did.*Nothing was run/);
    assert.deepEqual(adb.records.phases, []);
  }));

test('#28: an absent install state on an unmounted /cache proves nothing, so an earlier attempt stays refused', RUN_TIMEOUT,
  withLocalStorage(async () => {
    const adb = twrpEcho({ cacheMounted: false });
    await primeRun(adb);
    await markAttempted('prepare');
    const mark = logText().length;
    await app.runInstall({ dryRun: false });
    assert.match(logSince(mark), /could not be read.*\n?.*the prepare phase was already attempted/s);
    assert.deepEqual(adb.records.phases, []);
  }));

test('classifyDirectTransaction is the documented state machine', async () => {
  const expected = { bundleManifestSha256: BUNDLE_SHA, target: TARGET, release: RELEASE };
  const read = (state, receipt = null) => direct.parseTransactionRead('__LE_CACHE__ mounted\n'
    + (state == null ? `__LE_ABSENT__ ${direct.DIRECT_TRANSACTION_PATH}\n` : `__LE_BEGIN__ ${direct.DIRECT_TRANSACTION_PATH}\n${state}\n__LE_END__ ${direct.DIRECT_TRANSACTION_PATH}\n`)
    + (receipt == null ? `__LE_ABSENT__ ${direct.DIRECT_RECEIPT_PATH}\n` : `__LE_BEGIN__ ${direct.DIRECT_RECEIPT_PATH}\n${receipt}\n__LE_END__ ${direct.DIRECT_RECEIPT_PATH}\n`));
  const decide = (state, receipt, deviceDigest = DEVICE_DIGEST) =>
    direct.classifyDirectTransaction({ read: read(state, receipt), expected, deviceDigest });
  const all = ['prepare', 'initialize', 'transfer', 'finalize'];
  const table = [
    [null, null, 'fresh', 'prepare', all],
    [guard({ phase: 'prepare', format: 'absent' }), null, 'resume', 'prepare', all],
    [guard({ phase: '', format: '' }), null, 'resume', 'prepare', all],
    [guard({ phase: 'initialize', format: 'formatting' }), null, 'refuse', null, []],
    [guard({ phase: 'initialize', format: 'formatted' }), null, 'resume', 'transfer', ['transfer', 'finalize']],
    [guard({ phase: 'transfer', format: 'formatted' }), null, 'resume', 'transfer', ['transfer', 'finalize']],
    [guard({ phase: 'finalizing', format: 'formatted' }), null, 'refuse', null, []],
    [guard({ phase: 'finalized', format: 'formatted' }), installedReceipt(), 'complete', null, []],
    [guard({ phase: 'finalized', format: 'formatted' }), null, 'refuse', null, []],
  ];
  for (const [state, receipt, status, resumeAt, allow] of table) {
    const verdict = await decide(state, receipt);
    assert.equal(verdict.status, status, `${state} -> ${verdict.status}: ${verdict.message}`);
    assert.equal(verdict.resumeAt, resumeAt, `${state}`);
    assert.deepEqual(verdict.allowRepeat, allow, `${state}`);
  }
  assert.equal((await direct.classifyDirectTransaction({ read: direct.parseTransactionRead(''), expected })).status, 'unknown');
  assert.deepEqual((await direct.classifyDirectTransaction({ read: { readable: false }, expected })).allowRepeat, []);
  assert.equal((await decide(guard({ phase: 'finalized', format: 'formatted' }), installedReceipt(), 'a'.repeat(64))).code,
    'transaction-conflict');
  // The receipt's invocation digest must match its bindings.
  const forged = installedReceipt().replace(/invocation_sha256=[0-9a-f]+/, `invocation_sha256=${'0'.repeat(64)}`);
  assert.equal((await decide(guard({ phase: 'finalized', format: 'formatted' }), forged)).code, 'finalized-unconfirmed');
});

// ---------------------------------------------------------------------------
// D. an installed LibreEcho on ADB (18d1:d001) is recognised as installed
// ---------------------------------------------------------------------------

test('#28: "My Echo is already in recovery" on an Echo running LibreEcho says so and hands over to setup', async () => {
  await primeRun(null);
  Object.assign(app.state, { identity: null, running: false });
  const client = libreEchoClient();
  const mark = logText().length;
  const result = await app.startFromRecovery({ request: async () => LIBREECHO_USB, open: async ({ device }) => ({ device, client }) });
  const log = logSince(mark);
  assert.equal(result, null);
  assert.equal(app.state.identity, null, 'LibreEcho was identified as a recovery device');
  assert.equal(app.state.adb, null);
  assert.ok(!/TWRP is not running/.test(log), 'LibreEcho was reported as a failed TWRP');
  assert.match(log, /this Echo is running LibreEcho \(target biscuit\), not TWRP, so LibreEcho is already installed on it/);
  assert.match(log, /Volume Up \(\+\) only/);
  assert.deepEqual(handoffs, [{ serial: SERIAL, found: true }], 'the post-install handoff did not start');
  assert.ok(client.records.closed > 0, 'the LibreEcho interface was left open');
  assert.deepEqual(client.records.pushes, []);
  assert.ok(!client.records.shell.some((c) => /reboot|--phase/.test(c)), 'the recovery entry acted on LibreEcho');
  assert.ok(!log.includes(SERIAL), 'the full serial leaked into the log');
});

test('#28: during the first recovery wait, the identified Echo running LibreEcho is reported and handed over', RUN_TIMEOUT,
  withLocalStorage(async () => {
    await primeRun(null, { source: 'fastboot' });
    const client = libreEchoClient();
    const mark = logText().length;
    await app.runInstall({ dryRun: false, recovery: { timeoutMs: 300, intervalMs: 10,
      grantedDevices: async () => [LIBREECHO_USB], open: async ({ device }) => ({ device, client }) } });
    const log = logSince(mark);
    assert.match(log, /your Echo answered as LibreEcho \(target biscuit\), not TWRP\. LibreEcho is already installed on it/);
    assert.equal((log.match(/your Echo answered as LibreEcho/g) ?? []).length, 1, 'the LibreEcho notice repeated every poll');
    assert.ok(!/ignoring a granted recovery candidate: ADB answered but TWRP is not running/.test(log));
    assert.match(log, /checking it \(read-only\) and showing how to open its setup page/);
    assert.deepEqual(handoffs, [{ serial: SERIAL, found: true }]);
    assert.deepEqual(client.records.pushes, []);
  }));

test('#28: a LibreEcho with another serial is not this Echo and is never handed over', RUN_TIMEOUT, withLocalStorage(async () => {
  await primeRun(null, { source: 'fastboot' });
  const client = libreEchoClient({ serial: 'OTHER-ECHO-9999' });
  const mark = logText().length;
  await app.runInstall({ dryRun: false, recovery: { timeoutMs: 200, intervalMs: 10,
    grantedDevices: async () => [{ ...LIBREECHO_USB, serialNumber: 'OTHER-ECHO-9999' }], open: async ({ device }) => ({ device, client }) } });
  const log = logSince(mark);
  assert.match(log, /an Echo running LibreEcho \(serial ••••9999\) is connected; it is not the Echo this page identified/);
  assert.match(log, /timed out waiting for TWRP on the selected serial/);
  assert.deepEqual(handoffs, []);
}));

// ---------------------------------------------------------------------------
// E. prepare's reboot to recovery lands in LibreEcho
// ---------------------------------------------------------------------------

test('#28: when prepare\'s reboot brings up LibreEcho instead of TWRP, the page says to enter recovery by hand and resume',
  RUN_TIMEOUT, withLocalStorage(async () => {
    const adb = twrpEcho({ prepareReboot: true });
    await primeRun(adb);
    const client = libreEchoClient();
    const mark = logText().length;
    await app.runInstall({ dryRun: false, recovery: { timeoutMs: 300, intervalMs: 10,
      grantedDevices: async () => [LIBREECHO_USB], open: async ({ device }) => ({ device, client }) } });
    const log = logSince(mark);
    assert.deepEqual(adb.records.phases, ['prepare'], 'a phase ran without TWRP after the reboot');
    assert.deepEqual(adb.records.reboots, ['/sbin/twrp reboot recovery']);
    assert.match(log, /your Echo answered as LibreEcho \(target biscuit\), not TWRP\. The install is part-way through and must continue from TWRP, so put it into recovery by hand: unplug the Echo, hold Volume Up \(\+\) only/);
    assert.match(log, /recovery stage failed: timed out waiting for TWRP: your Echo started LibreEcho instead\. Put it into recovery by hand: .*Volume Up \(\+\) only.*Then press Install again: the page reads the Echo's own install state and resumes from it/);
    assert.deepEqual(handoffs, [], 'a part-way install was handed over as if it were installed');
  }));
