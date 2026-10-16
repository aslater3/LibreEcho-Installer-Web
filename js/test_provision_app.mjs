// Step-5 delivery through the REAL runInstall, not a stubbed helper.
//
// These pin the parts of the contract that only exist at the app level: the
// ordering (after finalize returned result=installed, before the reboot), the
// fact that skipping writes nothing at all, that a failed delivery is reported
// without claiming success and without failing the install, and that no secret
// survives the run in the log or in any browser storage.
//
// Fake transports only — no USB, no adb, no device. Synthetic credentials only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256Bytes } from './sha256.js';
import { DIRECT_HELPER_BYTES } from './combined-fixture.mjs';
import { phaseReply, readbackReply } from './direct-test-protocol.mjs';
import { PROVISION_PATH, PROVISION_TMP_PATH, PROVISION_SCHEMA, buildUsersLine } from './provision.js';
import { installWebLocksFixture, resetWebLocksFixture } from './web-locks-fixture.mjs';

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
    this.hidden = false;
    this.value = '';
    this.checked = false;
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
}
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
};
globalThis.document = { getElementById: element, createElement: () => new Element() };
globalThis.window = { isSecureContext: false, location: { search: '', origin: 'https://localhost' } };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true, writable: true,
  value: { usb: { getDevices: async () => [], requestDevice: async () => { throw new Error('background code opened a permission prompt'); } } },
});
// --- Web Locks (js/writer-lock.js) ------------------------------------------
// app.js takes the browser's origin-wide exclusive writer lock before any device
// command and FAILS CLOSED without it, so under node — which has `navigator` but
// no `navigator.locks` — every install here would stop at "cannot start the
// install: this browser does not offer Web Locks" and never reach the behaviour
// under test. This is a faithful LockManager double, not an allow-anything stub:
// it excludes a second holder of the same name and holds the grant until the
// granted callback settles. Installed AFTER the `navigator` redefinition above,
// which replaces the whole object. See js/test_web_locks_integration.mjs, which
// drives the real acquireWriterLock against it and would fail if it became one.
installWebLocksFixture();
test.beforeEach(() => { resetWebLocksFixture(); });

const app = await import('./app.js');
// The post-reboot wait for LibreEcho is covered by test_post_install*.mjs.
app.__setPostInstallHookForTest(async () => {});

const HEADER_HEX = '8816885870b203004c4b000000000000';
const HEADER_SPACED = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const MOUNTED = '/dev/block/mmcblk0p49 on /data type ext4 (rw)\n';
const PASSWORD = 'synthetic-admin-passphrase';
const WIFI_PASSWORD = 'synthetic-wifi-passphrase';

const dfRow = (mount) => [
  'Filesystem     1K-blocks      Used Available Use% Mounted on',
  mount, '',
].join('\n');
const DF_CACHE = dfRow('/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache');
const DF_DATA = dfRow('/dev/block/mmcblk0p49 60000000 100000 59000000  10% /data');

/** A localStorage stand-in that keeps a key ORDER, as the real one does. */
const fakeStorage = () => {
  const entries = new Map();
  return {
    entries,
    api: {
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => entries.set(key, String(value)),
      removeItem: (key) => entries.delete(key),
      key: (index) => [...entries.keys()][index] ?? null,
      get length() { return entries.size; },
    },
  };
};

// Both storages are installed so a test can prove the feature reaches NEITHER of
// them. The page persists only device-bound attempt guards, keyed by a digest of
// serial:tag:phase — never by anything the operator typed.
const withLocalStorage = (fn) => async () => {
  const priorLocal = globalThis.localStorage;
  const priorSession = globalThis.sessionStorage;
  const local = fakeStorage();
  const session = fakeStorage();
  globalThis.localStorage = local.api;
  globalThis.sessionStorage = session.api;
  try { await fn(local.entries, session.entries); } finally {
    globalThis.localStorage = priorLocal;
    globalThis.sessionStorage = priorSession;
  }
};

/**
 * A fake recovery ADB session that records every command in order.
 *
 * `df` is answered PER PATH, exactly as the real device does: the /cache
 * control-file preflight and the /data free-space gate are different
 * measurements, and answering both with one /data row makes the /cache row
 * unreadable — which is a fixture bug that aborts the run before finalize.
 */
function provisionAdb({ mount = MOUNTED, provisionPushFails = false, sizeMismatch = false, cacheFree = true } = {}) {
  const calls = [];
  const landed = new Map();
  return {
    calls, landed,
    shell: async (command) => {
      calls.push(String(command));
      if (String(command).includes('ro.twrp.version')) return { stdout: '3.7.0_9-0\nradar_puffin\nTEST-DOT\n' };
      if (String(command).includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
      if (String(command).includes('mmcblk0p7/size')) return { stdout: '20480\n' };
      if (String(command).includes('od -An')) return { stdout: `${HEADER_SPACED}\n` };
      if (String(command).startsWith('df ')) {
        if (String(command).includes('/data')) return { stdout: DF_DATA };
        return { stdout: cacheFree ? DF_CACHE : dfRow('/dev/block/mmcblk0p11  1048576 1048000 576  99% /cache') };
      }
      if (String(command) === "mount | grep ' /data '") return { stdout: mount };
      if (String(command).startsWith('mv -f ')) {
        const [, , from, to] = String(command).split(/\s+/);
        landed.set(to, landed.get(from));
        landed.delete(from);
        return { stdout: '' };
      }
      if (String(command).startsWith('wc -c ')) {
        const path = String(command).slice('wc -c '.length).trim();
        const blob = landed.get(path);
        if (!blob) return { stdout: 'wc: no such file or directory\n' };
        return { stdout: `${sizeMismatch ? 3 : blob.size} ${path}\n` };
      }
      const readback = await readbackReply(String(command), landed);
      if (readback) return readback;
      if (String(command).includes('--phase ')) {
        const phase = /--phase (\w+)/.exec(String(command))[1];
        const dry = String(command).includes('--dry-run');
        if (phase === 'prepare') return phaseReply(String(command), 'result=prepare-noop\nreboot_required=0\n');
        if (phase === 'initialize') return phaseReply(String(command), 'result=initialized\n');
        if (phase === 'transfer') return phaseReply(String(command), 'result=transferred\n');
        if (phase === 'finalize' && dry) return phaseReply(String(command), 'result=dry-run-ok\n');
        if (phase === 'finalize') return phaseReply(String(command), 'result=installed\n');
      }
      return { stdout: '' };
    },
    push: async (path, blob) => {
      calls.push(`push ${path}`);
      if (String(path) === PROVISION_TMP_PATH && provisionPushFails) throw new Error('EACCES');
      landed.set(path, blob);
    },
    close: async () => {},
  };
}

const V2_MANIFEST = [
  'schema=1', 'protocol=2', 'release=radar-puffin-build-test', 'device=radar_puffin',
  'target=radar_puffin', 'fastboot_products=RADAR', 'transfer_bytes_total=4096',
  'transfer=boot:boot.img:' + 'b'.repeat(64),
  'transfer=ota-manifest:manifest:' + '1'.repeat(64),
  'transfer=ota-signature:manifest.sig:' + '2'.repeat(64),
  'transfer=local-package:update.ota.tar:' + '4'.repeat(64),
  'staging=airplay2:p.squashfs:' + '3'.repeat(64) + ':m.json:' + '5'.repeat(64),
].join('\n');

/** Primes a complete, gate-passing v2 run, exactly as test_direct_install does. */
async function primeProvisionRun({ adb = null, overrides = {} } = {}) {
  const prefix = 'libreecho-radar-puffin';
  const roles = [
    { role: 'transfer:boot', name: `${prefix}-boot.img`, content: 'boot-bytes' },
    { role: 'transfer:ota-manifest', name: 'manifest', content: 'signed-manifest-bytes' },
    { role: 'transfer:ota-signature', name: 'manifest.sig', content: 'sig-hex-bytes' },
    { role: 'transfer:local-package', name: `${prefix}.ota.tar`, content: 'ota-tar-bytes' },
    { role: 'staging:airplay2:payload', name: `${prefix}-airplay2.squashfs`, content: 'payload' },
    { role: 'staging:airplay2:manifest', name: `${prefix}-airplay2.manifest.json`, content: 'fm' },
  ];
  const files = new Map();
  const sums = new Map();
  for (const role of roles) {
    const blob = new Blob([role.content]);
    blob.name = role.name;
    files.set(role.name, blob);
    sums.set(role.name, createHash('sha256').update(role.content).digest('hex'));
  }
  const directRoles = roles.map((r) => ({ role: r.role, name: r.name, sha256: sums.get(r.name), size: files.get(r.name).size }));
  Object.assign(app.state, {
    release: { tag: 'radar-puffin-v0.14.0', assets: [], board: 'radar_puffin' },
    identity: { product: 'RADAR', unlockStatus: 'true',
      profile: { id: 'radar', product: 'RADAR', marketing: 'Echo', board: 'radar_puffin', libreEcho: 'reference', lkBuildMap: {} },
      lkBuild: '59779ca-20220524_183401', serialRaw: 'TEST-DOT' },
    target: { board: 'radar_puffin', slug: 'radar-puffin', prefix, legacy: false },
    board: 'radar_puffin', targetsJson: null,
    files, sums, bundleReady: true, bundleBoard: 'radar_puffin', bundleHardwareAccepted: true,
    installProtocol: 2, directRelease: 'radar-puffin-build-test',
    directManifestText: V2_MANIFEST, directManifestSha: await sha256Bytes(new TextEncoder().encode(V2_MANIFEST)),
    directHelper: new TextEncoder().encode(DIRECT_HELPER_BYTES),
    directRoles, directTransferTotal: directRoles.reduce((s, r) => s + r.size, 0),
    abort: false, running: false, kaeruHeader: HEADER_HEX, recoverySerial: 'TEST-DOT',
    adb: adb ?? provisionAdb(), fastboot: null, receipts: [],
    provisionMode: 'skip', provisionForm: null, provisionState: 'skipped',
    provisionDetail: '', provisionHostname: null, provisionSsid: null,
  });
  Object.assign(app.state, overrides);
  return app.state;
}

/**
 * The element id for a step-5 field. The page's markup is kebab-case for EVERY
 * control (`provision-password-confirm`, `provision-wake-sensitivity`), so a
 * camelCase id here writes into a detached stub the real page never reads and
 * the form comes back empty at delivery time.
 */
const provisionElementId = (key) => `provision-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** Fills the step-5 controls, as the operator would. */
function fillProvisionForm({ ssid = 'TestNet', security = 'wpa2', wifiPassword = WIFI_PASSWORD, ...rest } = {}) {
  const values = {
    username: 'test.dot', password: PASSWORD, passwordConfirm: PASSWORD,
    ssid, security, wifiPassword, hostname: 'test-dot', volume: '64',
    wakeWord: 'Alexa', wakeSensitivity: '68', localOnly: true, telemetry: false,
    ...rest,
  };
  for (const [key, value] of Object.entries(values)) {
    const node = element(provisionElementId(key));
    if (typeof value === 'boolean') node.checked = value;
    else node.value = String(value);
  }
  app.setProvisionMode('fill');
  return values;
}

const provisionPushIndex = (calls) => calls.findIndex((c) => String(c) === `push ${PROVISION_TMP_PATH}`);
const finalizeIndex = (calls) => calls.findIndex((c) => /--phase finalize(?!.*--dry-run)/.test(String(c)));
const rebootIndex = (calls) => calls.findIndex((c) => /twrp reboot/.test(String(c)));

/**
 * Commands that could reshape userdata, write a partition directly, re-run a
 * mutating phase, or reset the transaction.
 *
 * `--phase initialize` is listed on purpose: it is the ONE legitimate
 * userdata-reshaping phase, and it must appear exactly once — before delivery.
 * The previous version of this test tried to assert its absence inside a
 * self-cancelling `&& !(/--phase initialize/ === false)` expression, so the
 * case could never fail and never checked anything.
 */
const DESTRUCTIVE = /mke2fs|sgdisk|twrp install|dd .*mmcblk0p16|--reset-transaction|--phase wipe\b|--phase initialize\b/;
/**
 * Counts real (non-dry-run) invocations of one helper phase.
 *
 * `--dry-run` is the non-mutating landed-completely rehearsal and finalize is
 * expected to appear twice by design (rehearsal + real), so it is excluded
 * here. The rehearsal is asserted separately, by the fact that a real run has
 * exactly one of them.
 */
const countRealPhase = (calls, phase) => calls.filter((c) => {
  const text = String(c);
  return new RegExp(`--phase ${phase}\\b`).test(text) && !/--dry-run/.test(text);
}).length;
const destructiveCalls = (calls) => calls.filter((c) => DESTRUCTIVE.test(String(c)));

/**
 * The terminal is a single module-level instance, so its backlog accumulates
 * across tests. Each test asserts about ITS OWN run, so the log is cut at the
 * first line of this run. Without this, a successful delivery in test 1 leaves
 * "configuration delivered" in the backlog and every later negative assertion
 * fails against another test's output — the negative cases would be
 * self-contaminating rather than wrong.
 */
const runLog = async (adb, prime) => {
  const before = app.terminal.lines.length;
  await prime();
  return app.terminal.lines.slice(before).map((node) => node.textContent).join('\n');
};

// ---------------------------------------------------------------------------
// A. ordering through the real run
// ---------------------------------------------------------------------------

test('the configuration is delivered after finalize and before the reboot', withLocalStorage(async () => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  fillProvisionForm();
  await app.runInstall({ dryRun: false });
  const pushAt = provisionPushIndex(adb.calls);
  const finalizedAt = finalizeIndex(adb.calls);
  const rebootedAt = rebootIndex(adb.calls);
  assert.ok(pushAt >= 0, `no provision push happened: ${adb.calls.join(' | ')}`);
  assert.ok(finalizedAt >= 0, 'the real finalize never ran');
  assert.ok(rebootedAt >= 0, 'no reboot was requested');
  assert.ok(finalizedAt < pushAt, 'the configuration was delivered before finalize returned installed');
  assert.ok(pushAt < rebootedAt, 'the configuration was delivered after the reboot');
  assert.equal(app.state.provisionState, 'delivered');
  const delivered = JSON.parse(await adb.landed.get(PROVISION_PATH).text());
  assert.equal(delivered.schema, PROVISION_SCHEMA);
  assert.deepEqual(delivered.binding, { release: 'radar-puffin-build-test', target: 'radar-puffin' });
}));

test('the delivered users line is the canonical salted SHA-256 of the admin password', withLocalStorage(async () => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  fillProvisionForm();
  await app.runInstall({ dryRun: false });
  const delivered = JSON.parse(await adb.landed.get(PROVISION_PATH).text());
  const [user, scheme, salt, digest] = delivered.admin.users_line.split(':');
  assert.equal(user, 'test.dot');
  assert.equal(scheme, 'sha256');
  assert.equal(digest, createHash('sha256').update(`${salt}:${PASSWORD}`, 'utf8').digest('hex'));
  assert.match(salt, /^[0-9a-f]{64}$/);
}));

// ---------------------------------------------------------------------------
// B. skipping writes nothing
// ---------------------------------------------------------------------------

test('skipping the step writes nothing and says the device does its own setup', withLocalStorage(async (local, session) => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  app.setProvisionMode('skip');
  const before = app.terminal.lines.length;
  await app.runInstall({ dryRun: false });
  const log = app.terminal.lines.slice(before).map((node) => node.textContent).join('\n');
  assert.equal(provisionPushIndex(adb.calls), -1, 'a configuration was pushed even though the step was skipped');
  assert.ok(!adb.landed.has(PROVISION_PATH), 'a configuration file landed on the device after a skip');
  assert.equal(app.state.provisionState, 'skipped');
  assert.match(log, /configuration skipped/i, `the run did not say the step was skipped: ${log}`);
  assert.match(log, /setup page on the device/i, `the run did not point at the device setup page: ${log}`);
  for (const [label, entries] of [['localStorage', local], ['sessionStorage', session]]) {
    for (const [key, value] of entries) {
      assert.ok(!value.includes(PASSWORD), `the admin password reached ${label} key ${key}`);
    }
  }
}));

test('skipping is the default: an untouched page installs without configuring', withLocalStorage(async () => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  // No setProvisionMode call at all — the state the page loads with.
  app.state.provisionMode = 'skip';
  assert.deepEqual(app.unmetPrerequisites(), [], 'configuration blocked the install');
  await app.runInstall({ dryRun: false });
  assert.equal(provisionPushIndex(adb.calls), -1);
}));

// ---------------------------------------------------------------------------
// C. failure is reported honestly and does not fail the install
// ---------------------------------------------------------------------------

for (const [name, options] of [
  ['a rejected push', { provisionPushFails: true }],
  ['a short readback', { sizeMismatch: true }],
  ['an unmounted /data', { mount: 'rootfs on / type ext4 (rw)\n' }],
]) {
  test(`${name} reports NOT delivered without claiming success and without failing the install`, withLocalStorage(async () => {
    const adb = provisionAdb(options);
    await primeProvisionRun({ adb });
    fillProvisionForm();
    // This run's own lines only: the terminal is shared across tests.
    const before = app.terminal.lines.length;
    await app.runInstall({ dryRun: false });
    const log = app.terminal.lines.slice(before).map((node) => node.textContent).join('\n');
    assert.equal(app.state.provisionState, 'failed', `${name} was not recorded as a failure`);
    assert.match(log, /NOT delivered/i, `${name} produced no NOT-delivered line: ${log}`);
    assert.doesNotMatch(log, /configuration delivered/i, `${name} claimed a delivery: ${log}`);
    assert.doesNotMatch(log, /configuration delivered to/i, `${name} claimed a delivery: ${log}`);
    // The install itself still finished: finalize ran, verify completed and the
    // reboot was requested.
    assert.ok(finalizeIndex(adb.calls) >= 0, `${name} stopped the install before finalize`);
    assert.ok(rebootIndex(adb.calls) >= 0, `${name} blocked the reboot`);
    assert.equal(app.state.stageProgress.verify, 'done', `${name} did not finish the verify stage`);
    // And the closing bar says to go set it up on the device — read the text the
    // run actually left on the bar, not a hand-set value.
    const bar = element('status-bar-message').textContent;
    assert.match(bar, /NOT delivered|setup page on the device/i,
      `${name} left an uninformative closing message: ${bar}`);
    assert.doesNotMatch(bar, /Configuration delivered/i, `${name} claimed the device was configured`);
  }));
}

test('a failed delivery never re-issues a mutating command and never retries the push', withLocalStorage(async () => {
  const adb = provisionAdb({ provisionPushFails: true });
  await primeProvisionRun({ adb });
  fillProvisionForm();
  await app.runInstall({ dryRun: false });
  assert.equal(app.state.provisionState, 'failed');
  // Every mutating phase ran exactly once. A retry of any of them after a
  // failed delivery would re-shape userdata or re-write slots on a device whose
  // state this page has not re-read.
  for (const phase of ['prepare', 'initialize', 'transfer', 'finalize']) {
    assert.equal(countRealPhase(adb.calls, phase), 1, `${phase} ran more than once`);
  }
  // The landed-completely rehearsal is non-mutating and runs once, alongside the
  // single real finalize.
  assert.equal(adb.calls.filter((c) => /--phase finalize\b/.test(String(c)) && /--dry-run/.test(String(c))).length, 1,
    'the finalize rehearsal did not run exactly once');
  // initialize is the one legitimate format step, and it is the only one issued.
  assert.deepEqual(destructiveCalls(adb.calls).map((c) => /--phase (\w+)/.exec(String(c))?.[1] ?? String(c).trim().slice(0, 40)),
    ['initialize'], `a command that can reshape userdata was issued more than once: ${destructiveCalls(adb.calls).join(' | ')}`);
  assert.equal(adb.calls.filter((c) => String(c) === `push ${PROVISION_TMP_PATH}`).length, 1,
    'the provision file was pushed more than once');
  assert.ok(!adb.calls.some((c) => /--reset-transaction/.test(String(c))), 'the transaction was reset automatically');
}));

// ---------------------------------------------------------------------------
// D. secrets hygiene through a real run
// ---------------------------------------------------------------------------

test('no secret reaches the terminal text or any browser storage during a real run', withLocalStorage(async (local, session) => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  fillProvisionForm();
  const before = app.terminal.lines.length;
  await app.runInstall({ dryRun: false });
  const log = app.terminal.lines.slice(before).map((node) => node.textContent).join('\n');
  assert.equal(app.state.provisionState, 'delivered', `the run failed before delivering: ${app.state.provisionDetail}`);
  assert.ok(log.length > 0, 'this run produced no log lines at all');
  assert.doesNotMatch(log, new RegExp(PASSWORD), 'the admin password is in the log');
  assert.doesNotMatch(log, new RegExp(WIFI_PASSWORD), 'the Wi-Fi passphrase is in the log');
  // The users line's salt and digest must not be printed either.
  const delivered = JSON.parse(await adb.landed.get(PROVISION_PATH).text());
  const [, , salt, digest] = delivered.admin.users_line.split(':');
  assert.ok(!log.includes(salt), 'the credential salt is in the log');
  assert.ok(!log.includes(digest), 'the credential digest is in the log');
  // Neither storage may hold the password, the passphrase, the salt, the digest,
  // or any value derived from the form.
  for (const [label, entries] of [['localStorage', local], ['sessionStorage', session]]) {
    for (const [key, value] of entries) {
      for (const secret of [PASSWORD, WIFI_PASSWORD, salt, digest]) {
        assert.ok(!value.includes(secret), `a credential reached ${label} key ${key}`);
      }
      // The passphrase is delivered verbatim into the provision document, so a
      // leak of the whole document into storage is the case to catch too.
      assert.ok(!value.includes('libreecho-provision'), `the provision document reached ${label} key ${key}`);
    }
    // No key may be named after a form field either.
    for (const key of entries.keys()) {
      assert.doesNotMatch(key, /provision|password|passphrase|ssid|users_line/i,
        `a form field name reached a ${label} key: ${key}`);
    }
  }
}));

test('the password inputs are cleared once the run is over', withLocalStorage(async () => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  fillProvisionForm();
  assert.equal(element('provision-password').value, PASSWORD);
  assert.equal(element('provision-password-confirm').value, PASSWORD);
  assert.equal(element('provision-wifi-password').value, WIFI_PASSWORD);
  await app.runInstall({ dryRun: false });
  assert.equal(app.state.provisionState, 'delivered', 'the run did not deliver, so clearing proves nothing');
  assert.equal(element('provision-password').value, '', 'the admin password survived the run');
  assert.equal(element('provision-password-confirm').value, '', 'the password confirmation survived the run');
  assert.equal(element('provision-wifi-password').value, '', 'the Wi-Fi passphrase survived the run');
  assert.equal(app.state.provisionForm, null, 'the mirrored form object survived the run');
}));

test('Stop clears the password before the run can continue', withLocalStorage(async () => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  fillProvisionForm();
  assert.equal(element('provision-password').value, PASSWORD);
  // Drive the real Stop button, not an internal call: the handler is the
  // contract's "Stop leaves no secret behind" boundary.
  element('btn-abort').listeners.get('click')();
  assert.equal(app.state.abort, true, 'Stop did not request a stop');
  assert.equal(element('provision-password').value, '', 'the admin password survived Stop');
  assert.equal(element('provision-password-confirm').value, '', 'the password confirmation survived Stop');
  assert.equal(element('provision-wifi-password').value, '', 'the Wi-Fi passphrase survived Stop');
  assert.equal(app.state.provisionForm, null, 'the mirrored form object survived Stop');
  // And the run that follows must not be able to deliver what Stop cleared.
  await app.runInstall({ dryRun: false });
  assert.notEqual(app.state.provisionState, 'delivered',
    'a run after Stop delivered a configuration from a form the operator cancelled');
  assert.equal(provisionPushIndex(adb.calls), -1, 'a configuration was pushed after Stop cleared the form');
}));

// ---------------------------------------------------------------------------
// E. truthful completion text
// ---------------------------------------------------------------------------

test('a delivered configuration ends with the .local URL and says it was not verified', withLocalStorage(async () => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  fillProvisionForm({ hostname: 'test-dot', ssid: 'TestNet' });
  await app.runInstall({ dryRun: false });
  assert.equal(app.state.provisionState, 'delivered');
  // Read the bar the run actually left behind. The run's `finally` block
  // republishes it, so this is the message the operator really ends up reading.
  const bar = element('status-bar-message').textContent;
  assert.match(bar, /Configuration delivered/i, `the closing message is not about the delivery: ${bar}`);
  assert.match(bar, /http:\/\/test-dot\.local:8080/, `the closing message omits the URL: ${bar}`);
  assert.match(bar, /TestNet|your network/, 'the closing message does not name the network');
  assert.match(bar, /not verified/i, `the closing message claims more than this page knows: ${bar}`);
}));

test('skipping ends by pointing at the setup page on the device', withLocalStorage(async () => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  app.setProvisionMode('skip');
  await app.runInstall({ dryRun: false });
  assert.equal(app.state.provisionState, 'skipped');
  const bar = element('status-bar-message').textContent;
  assert.match(bar, /setup page on the device/i, `the closing message points nowhere: ${bar}`);
  assert.doesNotMatch(bar, /Configuration delivered/i);
  assert.match(bar, /not verified/i, `the closing message claims more than this page knows: ${bar}`);
}));

test('a failed delivery never says the device was configured', withLocalStorage(async () => {
  const adb = provisionAdb({ provisionPushFails: true });
  await primeProvisionRun({ adb });
  fillProvisionForm();
  await app.runInstall({ dryRun: false });
  assert.equal(app.state.provisionState, 'failed');
  const bar = element('status-bar-message').textContent;
  assert.doesNotMatch(bar, /Configuration delivered/i, `the closing message claims a delivery: ${bar}`);
  assert.match(bar, /setup page on the device/i, `the closing message points nowhere: ${bar}`);
  assert.match(bar, /not verified/i, `the closing message claims more than this page knows: ${bar}`);
}));

// ---------------------------------------------------------------------------
// F. the step never blocks the install
// ---------------------------------------------------------------------------

test('an unfinished configuration form does not block the install', withLocalStorage(async () => {
  const adb = provisionAdb();
  await primeProvisionRun({ adb });
  fillProvisionForm({ username: 'bad user', password: 'short', passwordConfirm: 'nope' });
  assert.deepEqual(app.unmetPrerequisites(), [],
    `an invalid step-5 form was listed as an install prerequisite: ${app.unmetPrerequisites().join(' | ')}`);
  assert.notEqual(app.state.stageProgress.configure, 'done',
    'an invalid form was painted as a completed configure step before any run');
  // And the install really does run to the end with that invalid form.
  await app.runInstall({ dryRun: false });
  assert.equal(app.state.stageProgress.verify, 'done', 'an invalid step-5 form blocked the install');
  assert.equal(rebootIndex(adb.calls) >= 0, true, 'an invalid step-5 form blocked the reboot');
  assert.equal(app.state.provisionState, 'failed', 'an invalid form was reported as anything but not delivered');
  assert.ok(!adb.landed.has(PROVISION_PATH), 'an invalid form was written to the device anyway');
}));

test('the configuration errors are painted per field, under the right control', () => {
  fillProvisionForm({ username: 'bad user' });
  app.onProvisionInput();
  assert.match(element('provision-error-username').textContent, /username/i);
  assert.equal(element('provision-error-hostname').textContent, '', 'a valid field was marked broken');
  assert.equal(element('provision-form-wrap').dataset.invalid, 'true');
  app.setProvisionMode('skip');
  assert.equal(element('provision-form-wrap').hidden, true, 'the form stayed open after choosing skip');
});

test('buildUsersLine stays importable and stable for the app-level vector', async () => {
  const line = await buildUsersLine('test.dot', PASSWORD, {
    randomBytes: () => Uint8Array.from({ length: 32 }, (_, i) => i),
  });
  const [, , salt, digest] = line.split(':');
  assert.equal(digest, createHash('sha256').update(`${salt}:${PASSWORD}`, 'utf8').digest('hex'));
});
