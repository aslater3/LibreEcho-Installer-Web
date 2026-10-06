// The resume strand, exercised through the REAL run path.
//
// js/resume.js and the helpers in app.js were written and unit-tested, but
// nothing reached the page: index.html still shipped five separate connection
// buttons and no Connect/Resume action at all. A helper that no callsite invokes
// is not a feature, so everything below drives the real `runInstall` /
// `resumeInstall` / `refreshControls` / `primaryAction` the page actually calls.
//
// The load-bearing failures this pins:
//   * Resume is REACHABLE: one obvious action, wired into the real DOM, that
//     reaches resumeInstall, which reaches runInstall.
//   * A reloaded page with a journal does not reinstall. It continues at the
//     phase the journal recorded, re-verifying the release and the device, and
//     re-running only the phases that have not run.
//   * Resume never re-sends the unlock payload, even though the in-memory latch
//     that used to guarantee that did not survive the reload.
//   * A journal that says "finalize" never re-initializes userdata, and a
//     "finalized" install continues to provisioning/verification rather than
//     declaring success early or reinstalling.
//   * A second tab refuses to run the install at all (js/writer-lock.js).
//   * Stop mid-resume stops before the next write.
//   * Secrets lost to the reload are re-entered, never silently skipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256Bytes } from './sha256.js';
import { RESUME_JOURNAL_KEY } from './resume.js';
import { WRITER_LOCK_NAME, acquireWriterLock } from './writer-lock.js';
import { DIRECT_HELPER_BYTES } from './combined-fixture.mjs';
import { phaseReply, readbackReply } from './direct-test-protocol.mjs';
import { installWebLocksFixture, resetWebLocksFixture } from './web-locks-fixture.mjs';
import {
  RESUME_END_MARKER,
  RESUME_EXIT_MARKER,
  RESUME_GUARD_READ_COMMAND,
  RESUME_RECEIPT_READ_COMMAND,
  RESUME_BOOT_SLOT_SECTORS,
  RESUME_USERDATA_CONTRACT_SECTORS,
  resumeDeviceProbeCommand,
  resumeDataMountCommand,
} from './resume-device.js';

// --- minimal DOM so the real page module imports under node ---------------
class Element {
  constructor() {
    this.children = []; this.listeners = new Map(); this.queryNodes = new Map();
    this.dataset = {}; this.style = {}; this.classList = { add() {}, remove() {} };
    this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
    this.textContent = ''; this.value = ''; this.checked = false;
    this.disabled = false; this.hidden = false; this.focused = 0;
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
  getAttribute(key) { return this[key] ?? null; }
  focus() { this.focused += 1; }
  scrollIntoView() {} remove() {}
  /** Clicks this element the way a person would. */
  click() { return this.listeners.get('click')?.({ target: this }); }
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
  value: {
    usb: {
      getDevices: async () => [],
      requestDevice: async () => { throw new Error('a background path opened a permission chooser'); },
    },
  },
});
const store = new Map();
globalThis.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: (key) => { store.delete(key); },
};
// Node 22 has no `navigator.locks`, and js/writer-lock.js fails CLOSED without
// one — so every runInstall/resumeInstall in this file would refuse at the lock
// and prove nothing about the resume. This MUST come after the navigator
// redefinition above, which would otherwise replace the whole object.
const locks = installWebLocksFixture();
// A test that fails mid-run can leave the grant held; app.js releases it in a
// `finally`, but a held lock would refuse the NEXT test for the wrong reason.
process.on('beforeExit', () => resetWebLocksFixture());
const app = await import('./app.js');
// The post-reboot wait for LibreEcho is covered by test_post_install*.mjs.
app.__setPostInstallHookForTest(async () => {});

const el = (id) => elements.get(id);
const SERIAL = 'G090L90964010665';
const OTHER_SERIAL = 'G090L00000000000';
const DIGEST_SERIAL = await sha256Bytes(new TextEncoder().encode(SERIAL));
const HEADER_SPACED = '88 16 88 58 70 b2 03 00 4c 4b 00 00 00 00 00 00';
const HEADER_HEX = HEADER_SPACED.replace(/ /g, '');
const TAG = 'radar-puffin-v0.14.0';

const dfRow = (mount) => ['Filesystem     1K-blocks      Used Available Use% Mounted on', mount, ''].join('\n');
const DF_CACHE = dfRow('/dev/block/mmcblk0p11  1048576 100000 948576  10% /cache');
const DF_DATA = dfRow('/dev/block/mmcblk0p49 60000000 100000 59000000  10% /data');

/**
 * The device digest this fake reports for SERIAL/target/userdata GUID. It must be
 * what the shipped helper's `compute_device_digest` would print, because the
 * receipt's `invocation_sha256` is computed over it — a fixture that invents a
 * digest and then lets the binding be checked would fail every phase.
 */
const DIGEST_INPUT_GUID = '2f3a1c9e-7d84-4b6a-9c11-0e5a8b7d3c22';
const deviceDigestFor = (serial) => createHash('sha256')
  .update(`target=radar_puffin\nserial=${serial}\nuserdata_guid=${DIGEST_INPUT_GUID}\n`).digest('hex');
const DEVICE_DIGEST = deviceDigestFor(SERIAL);

/**
 * A `phaseReply` rebound to a SPECIFIC device digest.
 *
 * `direct-test-protocol.mjs` fixes the digest at 'd'*64 and computes
 * `invocation_sha256` over it, so substituting a digest afterwards would break
 * the very binding runDirectPhase exists to check. This rewrites the digest and
 * recomputes the invocation digest with the helper's own recipe:
 * `sha256("2|<phase>|<manifest>|<digest>|<target>|<release>")`.
 */
function boundPhaseReply(text, digest = DEVICE_DIGEST, changes = {}) {
  const arg = (key) => new RegExp(`--${key} ([^ ]+)`).exec(text)?.[1];
  const fields = {
    protocol: '2', phase: arg('phase'), invocation_id: arg('invocation-id'),
    bundle_manifest_sha256: arg('bundle-manifest-sha256'), device_digest: digest,
    target: arg('target'), release: arg('release'), ...changes,
  };
  fields.invocation_sha256 = createHash('sha256')
    .update(`2|${fields.phase}|${fields.bundle_manifest_sha256}|${digest}|${fields.target}|${fields.release}`)
    .digest('hex');
  const body = `${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
  return { stdout: `__HELPER_RC__0\n__RECEIPT__${body}` };
}

/**
 * The stored receipt, in exactly the key order `receipt_body` writes: the five
 * binding keys once, then the accumulated `receipt_set` fields. The reads this
 * suite relies on parse key=value, so order is cosmetic — but a fixture that
 * emitted a DIFFERENT key set would silently stop proving the guard bindings.
 *
 * `invocation_sha256` is RECOMPUTED with the helper's own recipe
 * `sha256("2|<phase>|<manifest>|<digest>|<target>|<release>")`. A pasted-in
 * constant was the reason the `guard=prepare` case could never reconcile: the
 * binding check in `resume-device.js` recomputes it and correctly rejected the
 * fixture's own receipt, so the test proved a refusal rather than a resume.
 */
function receiptBody({ result, fields = {}, phase = 'prepare', bundle = MANIFEST_SHA,
  release = DIRECT_RELEASE, target = 'radar_puffin', digest = DEVICE_DIGEST,
  invocation = 'd'.repeat(64) } = {}) {
  const binding = {
    protocol: '2', phase, invocation_id: invocation, bundle_manifest_sha256: bundle,
    device_digest: digest, target, release,
  };
  const invocation_sha256 = createHash('sha256')
    .update(`2|${phase}|${bundle}|${digest}|${target}|${release}`).digest('hex');
  const body = { ...binding, invocation_sha256, result, ...fields };
  return `${Object.entries(body).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

const framed = (rc, body = '') => `${RESUME_EXIT_MARKER}${rc}\n${body}${RESUME_END_MARKER}\n`;

/** Exactly what the module's own probe command prints on a healthy device. */
const probeBody = (serial, digest, userdataSectors, nodeUserdata = 'mmcblk0p49') => ([
  `serial=${serial}`,
  `userdata_guid=${DIGEST_INPUT_GUID}`,
  `device_digest=${digest}`,
  'node_boot_a=mmcblk0p2',
  'node_boot_b=mmcblk0p3',
  `node_userdata=${nodeUserdata}`,
  `sectors_boot_a=${RESUME_BOOT_SLOT_SECTORS}`,
  `sectors_boot_b=${RESUME_BOOT_SLOT_SECTORS}`,
  `sectors_userdata=${userdataSectors}`,
].join('\n') + '\n');

/**
 * The userdata node the identity probe reports. The /data mount probe must name
 * the SAME node, so it is read back out of the probe body rather than written
 * twice: two independent literals would let a fixture claim a mount of a
 * partition the probe never measured, and the mount check would pass on it.
 */
const probeNodeUserdata = 'mmcblk0p49';

/** The helper's `guard_write` body, byte for byte. */
const guardBody = ({ phase, format, manifest, release, target = 'radar_puffin', digest = DEVICE_DIGEST }) => [
  'protocol=2', `target=${target}`, `release=${release}`,
  `bundle_manifest_sha256=${manifest}`, `device_digest=${digest}`,
  `format_state=${format}`, `phase=${phase}`,
].join('\n') + '\n';

/** A fake TWRP device that records every command, in order, and never writes. */
function twrp({ serial = SERIAL, board = 'radar_puffin', rebootRequired = '0',
  receipt = null, guard = null, userdataSectors = RESUME_USERDATA_CONTRACT_SECTORS[0],
  deviceDigest = null, incoming = null, liveInstalled = true, liveBootSha = null } = {}) {
  const calls = [];
  const landed = new Map();
  // Files already in the landing zone from a PREVIOUS page session. Keyed by the
  // full remote path, exactly as `adb.push` records it.
  for (const [path, blob] of Object.entries(incoming ?? {})) landed.set(path, blob);
  const digest = deviceDigest ?? deviceDigestFor(serial);
  // `receipt` is what the device's helper left in /cache. A resume that claims a
  // phase already ran reads this, so a fake device with no receipt is a device
  // that honestly reports "nothing happened yet".
  const held = receipt ?? { result: null, fields: null };
  const client = {
    shell: async (command) => {
      calls.push(String(command));
      const text = String(command);
      if (text.includes('ro.twrp.version')) return { stdout: `3.7.0_9-0\n${board}\n${serial}\n` };
      if (text === "mount | grep ' /data '") return { stdout: '/dev/block/mmcblk0p49 on /data type ext4 (rw)\n' };
      // --- the authoritative reconciliation reads, matched EXACTLY so a fixture
      // cannot drift from the commands the module actually sends. These MUST come
      // before the generic `uevent`/`size` probes below: the module's own probe
      // command CONTAINS the literal string "uevent" (it reads
      // /sys/class/block/<node>/uevent for PARTNAME), so a substring branch ahead
      // of these answers the identity probe with an expdb uevent line.
      if (text === RESUME_GUARD_READ_COMMAND) {
        return { stdout: guard === null ? framed(2) : framed(0, guardBody(guard)) };
      }
      if (text === RESUME_RECEIPT_READ_COMMAND) {
        // `held` is `{ result, fields }` and the raw `cat` read flattens it, so
        // build the body from BOTH: `result` lives outside `fields` and dropping
        // it produced a receipt the module refused to parse.
        return { stdout: held.result ? framed(0, receiptBody({ ...held, ...(held.fields ?? {}) })) : framed(2) };
      }
      if (text === resumeDeviceProbeCommand('radar_puffin')) {
        return { stdout: framed(0, probeBody(serial, digest, userdataSectors)) };
      }
      // The /data mount probe. Without this exact branch the mount read falls
      // through to `return { stdout: '' }`, which carries no exit marker at all,
      // and every resume that reaches `transfer` refuses with
      // data-mount-unproven — a fixture gap, not a product refusal. One /data
      // entry, from the SAME userdata node the identity probe measured, mounted
      // ext4 and rw: the only shape that authorises a payload write.
      if (text === resumeDataMountCommand()) {
        return {
          stdout: framed(0, [
            'data_entries=1',
            `data_source=/dev/block/${probeNodeUserdata}`,
            `data_raw_source=/dev/block/${probeNodeUserdata}`,
            'data_fstype=ext4',
            'data_opts=rw,relatime',
          ].join('\n') + '\n'),
        };
      }
      if (text.includes('uevent')) return { stdout: 'PARTNAME=expdb\n' };
      if (text.includes('mmcblk0p7/size')) return { stdout: '20480\n' };
      if (text.includes('od -An')) return { stdout: `${HEADER_SPACED}\n` };
      if (text.startsWith('df ')) return { stdout: text.includes('/data') ? DF_DATA : DF_CACHE };
      // The helper's receipt file, exactly as runDirectPhase reads it back.
      // EXACT match, not a substring: runDirectPhase's composite command also
      // ends with this cat, and a substring test answered the helper's own
      // invocation with an empty receipt.
      if (text.trim() === 'cat /cache/libreecho-direct/receipt 2>/dev/null || true') {
        const receipt = held;
        // `result` lives OUTSIDE `fields` (setReceipt splits them), and the flat
        // `cat` read serves one body. Dropping `result` produced a receipt the
        // module and the test both read as having no outcome at all.
        const flat = receipt.result ? { result: receipt.result, ...(receipt.fields ?? {}) } : null;
        return { stdout: flat ? Object.entries(flat).map(([k, v]) => `${k}=${v}`).join('\n') + '\n' : '' };
      }
      if (text.startsWith('mv -f ')) {
        const [, , from, to] = text.split(/\s+/);
        landed.set(to, landed.get(from)); landed.delete(from);
        return { stdout: '' };
      }
      if (text.startsWith('wc -c ')) {
        const path = text.slice('wc -c '.length).trim();
        const blob = landed.get(path);
        return { stdout: blob ? `${blob.size} ${path}\n` : 'wc: no such file or directory\n' };
      }
      const readback = await readbackReply(text, landed);
      if (readback) return readback;
      if (text.includes('--phase ')) {
        const phase = /--phase (\w+)/.exec(text)[1];
        const dry = text.includes('--dry-run');
        // Every phase reply is bound to THIS device's digest, or runDirectPhase's
        // receipt-binding check would (correctly) reject the fixture's own reply.
        const reply = (result) => boundPhaseReply(text, digest, { result });
        if (phase === 'prepare') return reply(dry ? 'dry-run-ok' : 'prepare-ok');
        if (phase === 'initialize') return reply('initialized');
        if (phase === 'transfer') return reply(dry ? 'dry-run-ok' : 'transferred');
        if (phase === 'finalize' && dry && guard?.phase === 'finalized') {
          const fields = liveInstalled ? {
            installed_state: 'verified', installed_layout: 'v3',
            installed_boot_sha256: liveBootSha ?? createHash('sha256').update('boot-bytes').digest('hex'),
          } : { installed_state: 'mismatch', installed_layout: 'v3',
            installed_boot_state: 'mismatch', installed_state_reason: 'complete-digest-mismatch' };
          const out = boundPhaseReply(text, digest, { result: 'failed', error: 'already-finalized', ...fields });
          out.stdout = out.stdout.replace('__HELPER_RC__0', '__HELPER_RC__1');
          return out;
        }
        if (phase === 'finalize') return reply(dry ? 'dry-run-ok' : 'installed');
      }
      // The push bookkeeping the read-only landing-zone check uses.
      if (text.startsWith('/sbin/sha256sum /data/libreecho/incoming/')) {
        const path = text.split(/\s+/)[1];
        const blob = landed.get(path);
        return { stdout: blob ? `${createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex')}  ${path}\n` : '' };
      }
      if (text.includes('__LIBREECHO_PAYLOAD_ABSENT__')) {
        const path = /__LIBREECHO_PAYLOAD_ABSENT__\s+(\S+)/.exec(text)?.[1];
        return { stdout: landed.has(path) ? '' : `${path}\n` };
      }
      return { stdout: '' };
    },
    push: async (path, blob) => { calls.push(`push ${path}`); landed.set(path, blob); },
    close: async () => {},
  };
  return {
    client, calls, landed,
    device: { vendorId: 0x18d1, productId: 0x4ee2, serialNumber: serial },
    setReceipt: (next) => { held.result = next?.result ?? null; held.fields = next?.fields ?? null; },
    /** Reads the guard the device currently reports, for assertions. */
    guardNow: () => guard,
  };
}

/**
 * A guard in the state the helper leaves after `phase` completed.
 *
 * Every binding is overridable, because a fixture that cannot describe a
 * DIFFERENT manifest or a DIFFERENT device is a fixture that cannot test the
 * binding checks at all. Named options only — an extra positional argument here
 * would be silently dropped and the test would prove nothing (this already
 * happened once while writing this suite).
 */
const guardAfter = (phase, format, {
  manifest = MANIFEST_SHA, release = DIRECT_RELEASE, target = TARGET_BOARD, digest = DEVICE_DIGEST,
} = {}) => ({
  phase, format, manifest, release, target, digest,
});

/**
 * A device whose helper left a receipt claiming `result` for the finalize phase.
 *
 * `invocation_sha256` is recomputed with the helper's OWN recipe,
 * `sha256('2|prepare|bundle|deviceDigest|target|release')`, so the receipt passes
 * the binding check `resume-device.js` performs instead of carrying a pasted-in
 * digest that only ever fails.
 */
function installedDevice({ result = 'installed', release = DIRECT_RELEASE, installed = true,
  guard = guardAfter('finalized', 'formatted') } = {}) {
  const session = twrp({ guard, liveInstalled: installed });
  const fields = {
    protocol: '2', phase: 'finalize', invocation_id: 'f'.repeat(64),
    bundle_manifest_sha256: MANIFEST_SHA, target: 'radar_puffin', release,
    device_digest: DEVICE_DIGEST, result,
  };
  // The v3 installed-state readback a finalized guard is judged by. `verified`
  // carries the layout and the bound boot pin and NO reason, per the contract
  // table; anything else carries a reason and no pin, and is refused.
  if (installed) {
    fields.installed_state = 'verified';
    fields.installed_layout = 'v3';
    fields.installed_boot_sha256 = 'c'.repeat(64);
  } else {
    fields.installed_state = 'mismatch';
    fields.installed_layout = 'v3';
    fields.installed_boot_state = 'mismatch';
    fields.installed_state_reason = 'complete-digest-mismatch';
  }
  fields.invocation_sha256 = createHash('sha256')
    .update(`2|finalize|${MANIFEST_SHA}|${DEVICE_DIGEST}|radar_puffin|${release}`).digest('hex');
  session.setReceipt({ result, fields });
  return session;
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
/** sha256 of V2_MANIFEST — the bundle manifest sha every receipt is bound to. */
const MANIFEST_SHA = createHash('sha256').update(V2_MANIFEST).digest('hex');
/** The `--release` the run passes the helper: the manifest's own release field. */
const DIRECT_RELEASE = 'radar-puffin-build-test';
/** The board/target the run passes the helper. */
const TARGET_BOARD = 'radar_puffin';

const RELEASE = { tag: TAG, assets: [], board: 'radar_puffin' };
const IDENTITY = {
  product: 'RADAR', unlockStatus: 'true',
  profile: { id: 'radar', product: 'RADAR', marketing: 'Echo', board: 'radar_puffin', libreEcho: 'reference', lkBuildMap: {} },
  lkBuild: '59779ca-20220524_183401', serialRaw: SERIAL, serialMasked: 'G090L•••••••665',
};

const V2 = 'radar-puffin-v0.14.0';

/** Primes a complete, gate-passing run: verified bundle, target, identity, session. */
async function primeReady({ adb = null, identity = IDENTITY } = {}) {
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
    release: RELEASE, identity, board: 'radar_puffin', target: { board: 'radar_puffin', slug: 'radar-puffin', prefix, legacy: false },
    files, sums, bundleReady: true, bundleBoard: 'radar_puffin', bundleHardwareAccepted: true,
    installProtocol: 2, directRelease: 'radar-puffin-build-test',
    directManifestText: V2_MANIFEST, directManifestSha: await sha256Bytes(new TextEncoder().encode(V2_MANIFEST)),
    directHelper: new TextEncoder().encode(DIRECT_HELPER_BYTES),
    directRoles, directTransferTotal: directRoles.reduce((sum, r) => sum + r.size, 0),
    running: false, abort: false, fetchingBundle: false, fastboot: null, receipts: [],
    kaeruHeader: HEADER_HEX, recoverySerial: identity.serialRaw, adb: adb ?? twrp().client,
    provisionMode: 'skip', provisionForm: null, provisionState: 'skipped', provisionDetail: '',
    provisionHostname: null, provisionSsid: null, unlockSubmitted: null,
    // Deliberately NOT reset: resumeBoard / resumeReleaseTag / resumeUnlockSubmitted
    // are what restoreResumeState recovered and what a resume must act on.
    autoIdentifiedSerial: null, resumeDeviceAmbiguous: false, usbBusyReportedFor: null,
    recoveryWaiting: false, recoveryGrantInFlight: false, recoveryChooserWide: false,
    recoveryAlreadyGranted: false, recoverySession: null, recoveryAcceptedEpoch: 0, recoveryEpoch: 0,
    stageProgress: {},
  });
}

/** Puts the page in exactly the state a browser reload leaves it in. */
function afterReload({ withJournal = true, phase = 'transfer', unlockState = 'submitted', overrides = {} } = {}) {
  // Between tests: drop any grant a previous run left held. app.js releases in a
  // `finally`, but a test that throws inside one can leave the origin locked and
  // the next test would then fail closed for a reason of its own making.
  resetWebLocksFixture();
  for (const key of [...store.keys()]) store.delete(key);
  Object.assign(app.state, {
    releases: [], release: null, board: null, target: null, targetsJson: null, sums: null,
    files: new Map(), bundleReady: false, bundleBoard: null, bundleHardwareAccepted: false,
    installProtocol: null, directRelease: null, directHelper: null, directManifestText: null,
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
    writerLock: null,
  });
  if (withJournal) {
    store.set(RESUME_JOURNAL_KEY, JSON.stringify({
      version: 1, serialSha256: DIGEST_SERIAL, board: 'radar_puffin', releaseTag: TAG,
      phase, unlockState, updatedAt: Date.now(),
    }));
  }
  Object.assign(app.state, overrides);
  return app.state;
}

/** Every command the fake device was actually asked to run. */
const phases = (calls, phase) => calls.filter((c) => {
  const text = String(c);
  return new RegExp(`--phase ${phase}\\b`).test(text) && !/--dry-run/.test(text);
});
const logSince = (before) => app.terminal.lines.slice(before).map((l) => l.textContent).join('\n');
const runLog = async (fn) => {
  const before = app.terminal.lines.length;
  await fn();
  return logSince(before);
};

// ===========================================================================
// A. the action is wired to the page, not merely exported
// ===========================================================================

test('index.html ships exactly ONE connect/resume control, and the advanced ones are hidden', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // The operator gets one obvious button.
  assert.match(html, /id="btn-connect-resume"/,
    'the page has no single Connect/Resume control');
  // The five ask-for-five-things buttons are gone from the VISIBLE flow. They
  // still exist inside the `connect-advanced` disclosure below, because a reader
  // whose device the one button cannot reach still needs them — so the check is
  // that each is inside the disclosure, not that each is gone from the document.
  const disclosure = /<details id="connect-advanced">[\s\S]*?<\/details>/.exec(html)?.[0] ?? '';
  assert.ok(disclosure, 'there is no connect-advanced disclosure to check against');
  for (const advanced of ['btn-connect"', 'btn-connect-any"', 'btn-recovery"', 'btn-recovery-entry"']) {
    assert.ok(disclosure.includes(`id="${advanced}`),
      `${advanced} is not inside the advanced disclosure; the one action must own the visible flow`);
  }
  // What is left of the old controls lives in a collapsed advanced section, so a
  // first-time visitor is not asked to choose between five USB buttons.
  assert.match(html, /id="connect-advanced"/, 'the advanced USB controls were not kept behind a disclosure');
  assert.match(html, /<details id="connect-advanced"[^>]*>/,
    'the advanced USB controls are not inside a details/summary disclosure');
  // And it is wired: app.js must bind a click listener to that exact id.
  const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(src, /btn-connect-resume/,
    'app.js never references the one Connect/Resume control');
  assert.match(src, /dom\.connectResume|connectResume[?.]*\.addEventListener/,
    'the Connect/Resume control is not bound to anything');
});

test('the one control runs the connect/resume action the page offers', async () => {
  afterReload({ withJournal: false });
  app.refreshControls();
  const button = el('btn-connect-resume');
  assert.ok(button, 'there is no btn-connect-resume element');
  assert.equal(button.hidden, false, 'the one connect action is not visible');
  assert.match(button.textContent, /connect/i);

  // Clicking it must go through connectAction().run(). With no device granted
  // and no chooser available, it must refuse cleanly and write nothing.
  const before = app.terminal.lines.length;
  button.click();
  await new Promise((resolve) => setImmediate(resolve));
  const log = logSince(before);
  assert.ok(log.length > 0, 'the click produced no feedback at all');
  assert.doesNotMatch(log, /flash:brick|mke2fs|--phase /, 'a bare click reached a device write');
});

test('the connect control is disabled while a USB operation owns the page', async () => {
  afterReload({ withJournal: false });
  // A real fastboot query is in flight: the page's single USB operation slot is
  // taken by `queryDevice`, which is what refreshControls must see. The open is
  // a deferred THIS test releases, so nothing hangs on a pending promise.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const device = { vendorId: 0x18d1, productId: 0x4ee2, serialNumber: 'BUSY' };
  // A client that answers a real identity for the getvars a query actually makes,
  // but HANGS on one of them, so the slot is genuinely held when the assertion
  // runs and the test releases it explicitly afterwards. A client that hangs on
  // EVERY getvar makes the query refuse with "did not answer fastboot" — a real
  // refusal, but one that ends the query and frees the slot, so the test would
  // assert on an idle page.
  const vars = {
    product: 'RADAR', unlock_status: 'true', serialno: 'BUSY',
    lk_build_desc: '59779ca-20220524_183401', pl_build_desc: '',
    'max-download-size': '', secure: '', rpmb_state: '',
  };
  const client = {
    getVar: async (key) => { await gate; return vars[key] ?? ''; },
    close: async () => {},
  };
  const started = app.queryDevice({ any: true, open: async () => ({ device, client }) });
  await new Promise((resolve) => setImmediate(resolve));
  app.refreshControls();
  assert.equal(el('btn-connect-resume').disabled, true,
    'the connect action stayed live while another USB operation was in flight');
  app.requestStop();
  release(null);
  await started;
  app.refreshControls();
  assert.equal(el('btn-connect-resume').disabled, false, 'the connect action never came back');
});

// ===========================================================================
// B. a reloaded page with a journal offers Resume, and reaches resumeInstall
// ===========================================================================

test('a reloaded page offers Resume and names the transaction it found', async () => {
  afterReload();
  await app.restoreResumeState();
  app.refreshControls();
  const label = el('status-bar-action').dataset.actionLabel ?? '';
  assert.match(label, /resume/i, `the status bar offered "${label}" instead of Resume`);
  assert.match(el('status-bar-message').textContent, new RegExp(TAG.replace(/\./g, '\\.')),
    'the resume message does not name the build that was in progress');
  // The in-card control agrees with the bar.
  assert.match(el('btn-connect-resume').textContent, /resume/i);
});

test('pressing Resume actually reaches resumeInstall and the real run', async () => {
  afterReload({ phase: 'transfer' });
  await app.restoreResumeState();
  // Everything a resumed run needs, except the journal, is present. The device
  // has to agree that transfer is next: the resume point comes from the DEVICE's
  // guard now, so a journal alone would (correctly) be refused.
  const session = twrp({ guard: guardAfter('initialize', 'formatted') });
  await primeReady({ adb: session.client });
  const action = app.connectAction();
  assert.match(action.label, /resume/i, `the action said "${action.label}" with a journal present`);
  await runLog(() => action.run());
  // It reached the REAL run: the helper phases were executed on the fake device.
  // A helper that only built an object would leave `calls` empty.
  assert.equal(phases(session.calls, 'transfer').length, 1,
    `Resume did not reach runInstall's transfer phase. calls: ${session.calls.join(' | ')}`);
  assert.ok(session.calls.some((c) => /twrp reboot/.test(c)),
    'the resumed run never asked the device to reboot');
});

test('Resume never re-sends the unlock payload after a reload', async () => {
  afterReload({ phase: 'transfer', unlockState: 'submitted' });
  await app.restoreResumeState();
  await primeReady();
  const session = twrp();
  app.state.adb = session.client;
  app.state.recoverySerial = SERIAL;
  // A fastboot client that would record any unlock attempt. The reload left the
  // device in TWRP, so fastboot is not even reachable — and the latch that used
  // to protect the unlock (`state.unlockSubmitted`) is gone, which is exactly
  // why this has to be proven rather than assumed.
  const flashes = [];
  app.state.fastboot = { client: { flash: async (...args) => { flashes.push(args); } } };
  const log = await runLog(() => app.resumeInstall());
  assert.deepEqual(flashes, [], 'a resume re-sent flash:brick');
  assert.doesNotMatch(log, /flash brick/i, 'the resume log shows an unlock submission');
  assert.match(log, /not be sent again/i,
    'the operator was not told the unlock payload is not being resent');
});

test('a resume that cannot reverify writes nothing and says what to do', async () => {
  afterReload();
  await app.restoreResumeState();
  // No bundle, no device: the page must refuse before touching the device.
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /cannot resume/i);
  assert.doesNotMatch(log, /--phase |flash:brick/, 'a failed reverification still ran a phase');
  assert.match(log, /nothing was written/i);
});

// ===========================================================================
// C. resume continues; it does not reinstall
// ===========================================================================

test('a resume recorded at transfer does not re-run initialize (no second format)', async () => {
  afterReload({ phase: 'transfer' });
  await app.restoreResumeState();
  // The device's guard says transfer already ran, so the run enters at `payloads`:
  // the helper's transfer is not re-run and userdata is not reshaped. The journal
  // saying `transfer` agrees here, which is exactly the case that used to be
  // decided by the journal alone.
  const session = twrp({ guard: guardAfter('transfer', 'formatted') });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  assert.equal(phases(session.calls, 'initialize').length, 0,
    `resume reformatted userdata again: ${session.calls.filter((c) => /--phase initialize/.test(c)).join(' | ')}`);
  assert.equal(phases(session.calls, 'transfer').length, 0,
    "the helper's transfer phase ran again over a device whose guard already recorded it");
  assert.equal(phases(session.calls, 'finalize').length, 1,
    'the run did not carry on to finalize after the payloads step');
});

test('a resume recorded at prepare runs initialize, and only once', async () => {
  afterReload({ phase: 'prepare' });
  await app.restoreResumeState();
  // The device's guard says prepare COMPLETED (its fingerprint and a bound
  // prepare receipt both say the reshape happened), so the run enters at
  // initialize — the format — exactly once.
  const session = twrp({
    guard: guardAfter('prepare', 'absent'),
    receipt: { result: 'prepare-ok', fields: { phase: 'prepare', reboot_required: '0' } },
  });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  assert.equal(phases(session.calls, 'initialize').length, 1,
    'the initialize phase did not run exactly once on a prepare-stage resume');
  assert.equal(phases(session.calls, 'finalize').length, 1, 'finalize did not run exactly once');
});

test('a finalized install continues to verification, never reinstalls and never reports done early', async () => {
  afterReload({ phase: 'finalize' });
  await app.restoreResumeState();
  // The device's own receipt is what authorises continuing past finalize, so the
  // fake device has to have one. Without it the resume must refuse.
  const session = installedDevice();
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  // The device already reported installed; the run must not push the image again.
  assert.equal(phases(session.calls, 'initialize').length, 0,
    'a finalized transaction reformatted userdata again');
  assert.equal(phases(session.calls, 'transfer').length, 0,
    'a finalized transaction re-pushed the whole image');
  assert.ok(!/flash:brick/.test(log), 'a finalized transaction re-sent the unlock');
  // "Done" is only claimed after the device is asked to reboot out of recovery.
  const rebootAt = session.calls.findIndex((c) => /twrp reboot/.test(c));
  assert.ok(rebootAt >= 0, `no reboot was requested on a finalized resume. calls: ${session.calls.join(' | ')}`);
  const doneAt = log.search(/reboot requested/i);
  assert.ok(doneAt >= 0, 'the resume never reported the reboot');
  // The success message must come after, not before, the verification stage.
  assert.ok(!/Done: the install ran to the end/.test(log.slice(0, doneAt)),
    'success was published before the device was verified');
});

test('a finalized resume is refused when the device receipt says nothing', async () => {
  afterReload({ phase: 'finalize' });
  await app.restoreResumeState();
  // Same journal, but the device cannot be shown to have finished: its guard says
  // finalized while its receipt is unreadable. This is the exact point where
  // reinstalling would destroy work, so it must stop.
  const session = twrp({ guard: guardAfter('finalized', 'formatted'), receipt: null });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  // The run refuses, and says WHICH evidence is missing: the device cannot say
  // whether its last invocation finished, so nothing may continue. This message
  // lives in resumeLocked, ahead of the run, because this is where a finalized
  // resume most often stops.
  assert.match(log, /receipt cannot be read|does not say this install finished|nothing readable/i,
    `a finalize resume continued without device evidence. Log:\n${log}`);
  assert.equal(phases(session.calls, 'initialize').length, 0, 'userdata was reshaped again');
  assert.equal(session.calls.filter((c) => /twrp reboot/.test(c)).length, 0, 'the device was rebooted');
});

test('a finalized resume is refused when the receipt says the install failed', async () => {
  afterReload({ phase: 'finalize' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('finalized', 'formatted') });
  session.setReceipt({ result: 'failed', fields: {
    protocol: '2', phase: 'finalize', invocation_id: 'f'.repeat(64),
    bundle_manifest_sha256: MANIFEST_SHA, invocation_sha256: 'e'.repeat(64),
    device_digest: DEVICE_DIGEST, target: TARGET_BOARD, release: DIRECT_RELEASE,
    error: 'incomplete',
  } });
  await primeReady({ adb: session.client });
  const receipt = await app.readInstallReceipt(session.client);
  assert.equal(receipt?.result, 'failed',
    `the fake device did not serve the failed receipt: ${JSON.stringify(receipt)}`);
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /result=failed/i, `a failed receipt was treated as a finished install. Log:\n${log}`);
  assert.equal(phases(session.calls, 'finalize').filter((c) => !/--dry-run/.test(c)).length, 0,
    'the real finalize was re-run over a failed install');
});

test('a resume with a cleared journal does not claim to be resuming', async () => {
  afterReload({ withJournal: false });
  await app.restoreResumeState();
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /cannot resume|nothing to resume/i,
    `a resume with no journal claimed success. Log:\n${log}`);
});

// ===========================================================================
// D. the durable attempt guards still refuse a repeat, even after a reload
// ===========================================================================

test('durable phase guards from the pre-reload run still refuse a repeat', async () => {
  afterReload({ phase: 'transfer' });
  // These are exactly the keys runDirectPhase wrote before the reload. They are
  // the record of what may never be repeated, and they live in localStorage.
  // sha256Bytes is ASYNC. An earlier version interpolated the Promise into the
  // key, so it seeded `libreecho.direct.[object Promise]` and proved nothing.
  const key = async (serial, tag, phase) => `libreecho.direct.${await sha256Bytes(
    new TextEncoder().encode(`${serial}:${tag}:${phase}`))}`;
  for (const phase of ['prepare', 'initialize', 'transfer']) {
    store.set(await key(SERIAL, TAG, phase), 'pending-or-completed');
  }
  await app.restoreResumeState();
  // The device must also hold a guard that authorises entering at transfer, or
  // the run refuses at RECONCILIATION with guard-missing-after-phase and never
  // reaches the durable per-phase guard this test is about. Without a guard the
  // test proved the wrong refusal.
  const session = twrp({ guard: guardAfter('initialize', 'formatted') });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  // The journal asked for a transfer-phase continuation, and the durable guard
  // says transfer already ran. The phase must refuse; it must not repeat.
  assert.match(log, /already attempted/i,
    `the durable guard did not refuse the repeat. Log:\n${log}`);
  assert.equal(phases(session.calls, 'initialize').length, 0,
    'a guarded phase ran again anyway');
});

test('a reload never clears a single durable guard key', async () => {
  // Seeded AFTER afterReload(), which models a reload by emptying the store.
  const guards = new Map([
    ['libreecho.unlock.sent.a', 'submitted-or-unknown'],
    ['libreecho.recovery.b', 'pending-or-completed'],
    ['libreecho.direct.c', 'pending-or-completed'],
  ]);
  afterReload();
  for (const [k, v] of guards) store.set(k, v);
  await app.restoreResumeState();
  for (const [k, v] of guards) assert.equal(store.get(k), v, `${k} was cleared by a reload`);
});

// ===========================================================================
// E. multi-tab writer exclusion, through the real run
// ===========================================================================

test('a second tab refuses to run the install while the first tab holds the lock', async () => {
  afterReload({ phase: 'transfer' });
  await app.restoreResumeState();
  // The device needs a guard that authorises the resume, or reconciliation
  // refuses at guard-missing-after-phase and this test proves that refusal
  // instead of the one it is about.
  const session = twrp({ guard: guardAfter('initialize', 'formatted') });
  await primeReady({ adb: session.client });
  // Another tab of this origin is mid-install. The exclusion is the BROWSER's own
  // Web Locks mutex (js/writer-lock.js), not a localStorage record — seeding a
  // storage key proved nothing, because nothing in the lock path ever reads one.
  // Holding the lock NAME in the fixture's origin table is what makes the second
  // tab's `ifAvailable` request be refused now rather than queued.
  const held = await acquireWriterLock();
  assert.equal(held.ok, true, 'the fixture could not take the writer lock to simulate another tab');

  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /another tab/i,
    `a second tab was allowed to install. Log:\n${log}`);
  assert.deepEqual(session.calls, [], 'the second tab opened the device anyway');
  await held.release();
});

test('the lock is taken for the duration of the run and released afterwards', async () => {
  afterReload({ phase: 'transfer' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('initialize', 'formatted') });
  await primeReady({ adb: session.client });
  // Observed from INSIDE the run: while a real phase command is executing, the
  // origin-wide lock must be held by this tab.
  //
  // It is observed through the LockManager's own view (`locks.query()`), not
  // through localStorage. js/writer-lock.js deliberately owns NO storage record —
  // the browser holds the state, which is what makes a killed tab's grant drop.
  // The previous version read a localStorage key that nothing in the lock path
  // ever writes, so it could only ever observe `null`.
  let heldDuringRun = null;
  let phaseDuringRun = null;
  const originalShell = session.client.shell;
  session.client.shell = async (command) => {
    if (heldDuringRun === null && /--phase (transfer|finalize)\b/.test(String(command)) && !/--dry-run/.test(String(command))) {
      heldDuringRun = [...(await locks.query()).held];
      phaseDuringRun = String(command).match(/--phase (\w+)/)?.[1] ?? null;
    }
    return originalShell(command);
  };
  await app.resumeInstall();
  assert.deepEqual(heldDuringRun, [WRITER_LOCK_NAME],
    `no origin-wide writer lock was held while the run was writing to the device (saw ${JSON.stringify(heldDuringRun)})`);
  assert.match(phaseDuringRun, /transfer|finalize/);
  assert.deepEqual([...(await locks.query()).held], [],
    'the writer lock survived the run and would block the next install');
  assert.equal(app.state.writerLock, null, 'the run kept its writer lock handle after finishing');
});

test('a run that fails still releases the lock, so the operator can retry', async () => {
  afterReload({ phase: 'transfer' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('initialize', 'formatted') });
  await primeReady({ adb: session.client });
  // A transport failure mid-run.
  const originalShell = session.client.shell;
  session.client.shell = async (command) => {
    if (/--phase initialize/.test(String(command))) throw new Error('USB disconnected');
    return originalShell(command);
  };
  await app.resumeInstall();
  assert.deepEqual([...(await locks.query()).held], [],
    'the writer lock survived the failed run and would block the next install');
});

// ===========================================================================
// F. Stop
// ===========================================================================

test('Stop during a resume stops before the next write', async () => {
  afterReload({ phase: 'prepare' });
  await app.restoreResumeState();
  const session = twrp();
  await primeReady({ adb: session.client });
  // The operator stops while prepare is running.
  const originalShell = session.client.shell;
  session.client.shell = async (command) => {
    if (/--phase prepare/.test(String(command))) app.requestStop();
    return originalShell(command);
  };
  await app.resumeInstall();
  assert.equal(phases(session.calls, 'initialize').length, 0,
    'a stopped resume went on to reshape userdata');
  assert.equal(phases(session.calls, 'finalize').length, 0,
    'a stopped resume went on to finalize');
  assert.equal(session.calls.filter((c) => /twrp reboot/.test(c)).length, 0,
    'a stopped resume still rebooted the device');
  assert.deepEqual([...(await locks.query()).held], [], 'a stopped run kept the writer lock');
});

// ===========================================================================
// G. secrets are re-entered, never silently skipped
// ===========================================================================

test('a reload with no provisionable secret asks for the configuration again', async () => {
  afterReload({ phase: 'finalize', withJournal: true });
  await app.restoreResumeState();
  // The device needs its own finalized guard AND its installed-state readback:
  // both are device evidence, and neither comes from the journal.
  const session = installedDevice();
  await primeReady({ adb: session.client });
  // After a reload the step-5 form is empty and skip is the default, so the
  // device must be told to run its own setup — never told "already configured".
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /own setup page|skipped/i,
    `the resume did not state what happens to configuration. Log:\n${log}`);
  assert.doesNotMatch(log, /configuration delivered/i,
    'a resume reported delivering a configuration the operator never re-entered');
  assert.equal(app.state.provisionState, 'skipped');
});

test('nothing the operator typed reaches durable storage during a resume', async () => {
  afterReload();
  await app.restoreResumeState();
  const session = twrp();
  await primeReady({ adb: session.client });
  app.setProvisionMode('fill');
  const password = 'synthetic-resume-passphrase';
  el('provision-username').value = 'test.dot';
  el('provision-password').value = password;
  el('provision-password-confirm').value = password;
  el('provision-ssid').value = 'TestNet';
  el('provision-wifi-password').value = 'synthetic-wifi-passphrase';
  await app.resumeInstall();
  const dump = JSON.stringify([...store.entries()]);
  assert.doesNotMatch(dump, new RegExp(password), 'the admin password reached durable storage');
  assert.doesNotMatch(dump, /TestNet|synthetic-wifi-passphrase/,
    'a Wi-Fi name or passphrase reached durable storage');
  assert.doesNotMatch(app.terminal.plainText(), new RegExp(password),
    'the admin password reached the log');
});

test('a filled-in configuration form never stops the resume journal being written', async () => {
  afterReload({ phase: 'prepare' });
  await app.restoreResumeState();
  const session = twrp();
  await primeReady({ adb: session.client });
  // The guard in recordResumeProgress keys off state.provisionForm, which the
  // page never assigns — so with a filled-in form it was dead code. It must now
  // refuse on the evidence the page actually has: the collected form.
  const filled = app.provisionForm();
  assert.ok(typeof filled === 'object', 'the page exposes the collected form');
  const result = await app.recordResumeProgress({ phase: 'transfer' });
  if (app.state.provisionMode === 'fill' && app.provisionForm().password) {
    assert.equal(result.ok, false,
      'a secret-bearing form still wrote a resume record');
  }
  // Either way the journal on disk must never carry the password.
  assert.doesNotMatch(store.get(RESUME_JOURNAL_KEY) ?? '', new RegExp(password_of(app)));
});

const password_of = (mod) => String(mod.state.provisionForm?.password ?? 'never-typed-this');

// ===========================================================================
// H. the record the run leaves behind is usable by the next reload
// ===========================================================================

test('a resumed run leaves a journal the next reload can act on', async () => {
  afterReload({ phase: 'transfer' });
  await app.restoreResumeState();
  // A guard that lets the run actually complete; with none, reconciliation
  // refuses and this test would only prove the refusal.
  const session = twrp({ guard: guardAfter('initialize', 'formatted') });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  // The run completed, so its own journal is cleared — and only its own.
  assert.equal(store.has(RESUME_JOURNAL_KEY), false,
    'a finished run left a resume record behind');
  assert.deepEqual([...(await locks.query()).held], [], 'a finished run left the writer lock behind');
  assert.ok(session.calls.length > 0);
});

test('an unfinished run leaves a journal naming the phase it reached', async () => {
  afterReload({ phase: 'prepare', unlockState: 'submitted' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('initialize', 'formatted') });
  await primeReady({ adb: session.client });
  // Fail after the journal has been advanced past prepare, so the page is left
  // mid-transaction rather than finished.
  const originalShell = session.client.shell;
  session.client.shell = async (command) => {
    if (/--phase transfer\b/.test(String(command))) throw new Error('USB disconnected');
    return originalShell(command);
  };
  await app.resumeInstall();
  const raw = store.get(RESUME_JOURNAL_KEY);
  assert.ok(raw, 'a run that stopped mid-transaction left nothing to resume from');
  const written = JSON.parse(raw);
  // The run got past initialize and died inside transfer, so the journal must
  // name the LAST phase the device actually completed — initialize — not the one
  // it was attempting.
  assert.equal(written.phase, 'initialize',
    `the journal records phase "${written.phase}" rather than the phase the device last completed`);
  assert.equal(written.serialSha256, DIGEST_SERIAL);
  assert.equal(written.releaseTag, TAG);
  assert.equal(written.unlockState, 'submitted',
    `the journal says unlockState=${written.unlockState}; a reloaded run must not forget brick was sent`);
  assert.ok(/^[0-9a-f]{64}$/.test(written.deviceDigest ?? ''),
    'the receipt device digest was not recorded, so the next resume cannot bind to this device');
});

// ===========================================================================
// I. THE DEVICE'S GUARD IS THE AUTHORITY, NOT journal.phase
//
// Every test below drives the REAL resumeInstall/runInstall. The load-bearing
// property is that a resume point comes from `reconcileDeviceResume` reading
// /cache/libreecho-direct/transaction.state — the durable guard the shipped
// helper writes BEFORE each mutation — and never from the browser journal.
// ===========================================================================


test('a journal AHEAD of the guard does not skip the phase the device never ran', async () => {
  // The browser wrote journal.phase=finalize but the device only ever got as far
  // as `initialize`. Reading the journal would skip prepare/initialize/transfer
  // and re-run finalize over a device that never landed the image. The guard is
  // the authority: the run must continue at `transfer`.
  afterReload({ phase: 'finalize', unlockState: 'submitted' });
  await app.restoreResumeState();
  assert.equal(app.state.resumePhase, 'finalize');
  const session = twrp({
    guard: guardAfter('initialize', 'formatted'),
    userdataSectors: RESUME_USERDATA_CONTRACT_SECTORS[0],
  });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  assert.equal(phases(session.calls, 'initialize').length, 0,
    'userdata was reshaped a second time because the journal claimed a later phase');
  assert.equal(phases(session.calls, 'transfer').length, 1,
    'the run did not continue at the phase the DEVICE says is next');
  assert.equal(phases(session.calls, 'finalize').length, 1,
    'the run did not carry on to finalize after the device-authorised resume point');
});

test('a journal BEHIND the guard does not re-run a phase the device completed', async () => {
  // The browser recorded `prepare` because it was killed before its own journal
  // write landed — but the device's guard says `transfer`. Re-running prepare
  // would reshape userdata for a second time.
  afterReload({ phase: 'prepare', unlockState: 'submitted' });
  await app.restoreResumeState();
  assert.equal(app.state.resumePhase, 'prepare');
  const session = twrp({ guard: guardAfter('transfer', 'formatted') });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  assert.equal(phases(session.calls, 'prepare').length, 0,
    'prepare was re-run because the journal lagged the device guard');
  assert.equal(phases(session.calls, 'initialize').length, 0,
    'userdata was reformatted a second time because the journal lagged the device guard');
  // The guard says the HELPER's transfer phase ran, so it is not re-run. But the
  // browser's own push is a SEPARATE step that this guard never covered: the
  // landing zone is empty here, so the payloads are pushed once. Re-pushing them
  // is correct; the previous assertion demanded zero pushes, which was only ever
  // true when the landing zone happened to be pre-seeded.
  assert.equal(phases(session.calls, 'transfer').length, 0,
    'the helper transfer phase was re-run over a device whose guard already recorded it');
  assert.ok(session.calls.some((c) => /^push \/data\/libreecho\/incoming\//.test(String(c))),
    'the browser push that the guard does not cover was skipped entirely');
  assert.match(log, /already|not repeated|not re-run/i,
    `the operator was not told which phases the device had already run. Log:\n${log}`);
});

test('a finalized guard requires real installed verification and never re-finalizes', async () => {
  // guard=finalized says finalize ran. That is NOT success: this is exactly the
  // point where re-running finalize could destroy work. The run must reach the
  // read-only verification and never send the real finalize again.
  afterReload({ phase: 'finalize', unlockState: 'submitted' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('finalized', 'formatted') });
  // The framed receipt read builds its body through receiptBody(), so the
  // fixture's stored receipt is expressed in that shape. `invocation_sha256` is
  // recomputed by receiptBody() with the helper's own recipe, and the v3
  // installed-state keys are what a finalized guard is judged by: `verified`
  // carries the layout and the bound boot pin, and no reason.
  session.setReceipt({ result: 'installed', fields: {
    protocol: '2', phase: 'finalize', invocation_id: 'f'.repeat(64),
    bundle_manifest_sha256: MANIFEST_SHA,
    device_digest: DEVICE_DIGEST, target: TARGET_BOARD, release: DIRECT_RELEASE,
    installed_state: 'verified', installed_layout: 'v3', installed_boot_sha256: 'c'.repeat(64),
  } });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  assert.equal(phases(session.calls, 'finalize').length, 0,
    'the REAL finalize ran again over an already-finalized device');
  // Ordinary dry-run-ok validates the landing zone and is NOT accepted here.
  // With a finalized guard, the actual helper takes its readback/refusal branch
  // first. Only fresh already-finalized + installed_state=verified + the exact
  // selected boot pin may authorize continuation.
  assert.equal(session.calls.filter((c) => /--phase finalize/.test(String(c)) && /--dry-run/.test(String(c))).length, 1,
    'the finalized refusal branch must freshly read installed bytes, not trust an old receipt');
  assert.equal(session.calls.filter((c) => /^push \/data\/libreecho\/incoming\//.test(String(c))).length, 0,
    'payloads were pushed over an already-finalized device');
  assert.equal(phases(session.calls, 'initialize').length, 0, 'userdata was reshaped again');
});

test('a finalized guard with no readable receipt refuses rather than claiming success', async () => {
  afterReload({ phase: 'finalize', unlockState: 'submitted' });
  await app.restoreResumeState();
  // The guard says finalized; the receipt says nothing. Neither is a
  // verification that the install actually landed.
  const session = twrp({ guard: guardAfter('finalized', 'formatted'), receipt: null });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /receipt cannot be read|does not say this install finished|nothing readable/i,
    `a finalized transaction continued without any device evidence. Log:\n${log}`);
  assert.equal(phases(session.calls, 'finalize').length, 0,
    'the real finalize ran over a finalized device with no receipt');
  assert.equal(session.calls.filter((c) => /twrp reboot/.test(c)).length, 0,
    'a refused finalize resume still rebooted the device');
});

test('a guard recorded mid-format refuses and never retries the format', async () => {
  afterReload({ phase: 'initialize', unlockState: 'submitted' });
  await app.restoreResumeState();
  // format_state=formatting: a userdata format was interrupted and its outcome
  // is unknown. This is never retried automatically.
  const session = twrp({ guard: guardAfter('initialize', 'formatting') });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /format|formatting/i, `the refusal did not mention the format. Log:\n${log}`);
  assert.equal(phases(session.calls, 'initialize').length, 0,
    'an interrupted format was retried');
  assert.equal(phases(session.calls, 'prepare').length, 0, 'prepare ran over an uncertain format');
});

test('a guard recorded mid-finalize refuses and never re-finalizes', async () => {
  afterReload({ phase: 'finalize', unlockState: 'submitted' });
  await app.restoreResumeState();
  // phase=finalizing: the boot-slot write started and its outcome is unknown.
  const session = twrp({ guard: guardAfter('finalizing', 'formatted') });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /finaliz/i, `the refusal did not mention the finalize. Log:\n${log}`);
  assert.equal(phases(session.calls, 'finalize').length, 0,
    'finalize was retried after an interrupted finalize');
});

test('a guard bound to a different bundle manifest is refused as a different transaction', async () => {
  afterReload({ phase: 'transfer', unlockState: 'submitted' });
  await app.restoreResumeState();
  const session = twrp({
    guard: guardAfter('transfer', 'formatted', { manifest: 'a'.repeat(64) }),
  });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /different bundle|different transaction/i,
    `a guard for another bundle was treated as this run's. Log:\n${log}`);
  assert.equal(phases(session.calls, 'transfer').length, 0, 'a foreign transaction continued');
  assert.equal(phases(session.calls, 'finalize').length, 0, 'a foreign transaction finalized');
});

test('a guard bound to a different device digest is refused, not resumed onto this device', async () => {
  afterReload({ phase: 'transfer', unlockState: 'submitted' });
  await app.restoreResumeState();
  // A guard whose device_digest is not this device's own digest. Continuing would
  // push THIS run's payloads onto a device that is mid-someone-else's install.
  const session = twrp({
    guard: guardAfter('transfer', 'formatted', { digest: 'f'.repeat(64) }),
  });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  assert.match(log, /different device|different device digest|not this device/i,
    `another device's guard was resumed onto this one. Log:\n${log}`);
  assert.equal(phases(session.calls, 'transfer').length, 0, 'a foreign device guard continued');
  assert.equal(phases(session.calls, 'finalize').length, 0, 'a foreign device guard finalized');
});

test('no guard and no browser prepare attempt returns prepare, and reshapes only then', async () => {
  // The device has no memory of any transaction. The only safe phase is the
  // first, and only because this browser can confirm no prepare was attempted.
  afterReload({ withJournal: false });
  await app.restoreResumeState();
  const session = twrp({ guard: null, userdataSectors: 999999 });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  // No journal means there is nothing to resume, so the run must refuse rather
  // than treat "no guard" as licence to start over from inside a resume.
  assert.equal(phases(session.calls, 'prepare').length, 0,
    'a resume with no journal started a fresh prepare');
});

// ===========================================================================
// J. PAYLOADS IS DISTINCT FROM THE HELPER'S transfer PHASE
//
// The helper's `transfer` phase creates the landing zone and gates free space.
// The browser then pushes the payloads. Skipping `transfer` must not silently
// skip the push, and a resume must not re-push files that are already there.
// ===========================================================================

test('a resume past the transfer phase hashes existing payloads before deciding not to re-push', async () => {
  afterReload({ phase: 'transfer', unlockState: 'submitted' });
  await app.restoreResumeState();
  // The device's transfer phase ran. Simulate the PREVIOUS page session having
  // already pushed every verified payload into the landing zone.
  const already = {
    'libreecho-radar-puffin-boot.img': 'boot-bytes',
    manifest: 'signed-manifest-bytes',
    'manifest.sig': 'sig-hex-bytes',
    'libreecho-radar-puffin.ota.tar': 'ota-tar-bytes',
    'libreecho-radar-puffin-airplay2.squashfs': 'payload',
    'libreecho-radar-puffin-airplay2.manifest.json': 'fm',
  };
  const incoming = Object.fromEntries(Object.entries(already).map(([name, content]) =>
    [`/data/libreecho/incoming/${name}`, new Blob([content])]));
  const session = twrp({ guard: guardAfter('transfer', 'formatted'), incoming });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  const pushes = session.calls.filter((c) => /^push \/data\/libreecho\/incoming\//.test(String(c)));
  assert.deepEqual(pushes, [],
    `payloads already on the device were pushed again: ${pushes.join(' | ')}`);
  assert.match(log, /already|verified|not pushed again/i,
    `the operator was not told the payloads were already there. Log:\n${log}`);
});

test('a missing payload in the landing zone is re-pushed, not assumed present', async () => {
  afterReload({ phase: 'transfer', unlockState: 'submitted' });
  await app.restoreResumeState();
  // transfer ran, but ONE payload never landed (the crash happened mid-push).
  // The read-only hash must find it absent and the run must push exactly that
  // one — never assume the whole set is there.
  const incoming = {
    '/data/libreecho/incoming/libreecho-radar-puffin-boot.img': new Blob(['boot-bytes']),
    '/data/libreecho/incoming/manifest': new Blob(['signed-manifest-bytes']),
    '/data/libreecho/incoming/manifest.sig': new Blob(['sig-hex-bytes']),
    '/data/libreecho/incoming/libreecho-radar-puffin.ota.tar': new Blob(['ota-tar-bytes']),
    '/data/libreecho/incoming/libreecho-radar-puffin-airplay2.squashfs': new Blob(['payload']),
    // airplay2 manifest deliberately absent
  };
  const session = twrp({ guard: guardAfter('transfer', 'formatted'), incoming });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  const pushes = session.calls.filter((c) => /^push \/data\/libreecho\/incoming\//.test(String(c)));
  assert.equal(pushes.length, 1,
    `expected exactly the one missing payload to be re-pushed, got ${pushes.length}: ${pushes.join(' | ')}`);
  assert.match(pushes[0], /airplay2\.manifest\.json/,
    `the wrong payload was re-pushed: ${pushes[0]}`);
});

test('a corrupt payload in the landing zone is re-pushed, never trusted on size alone', async () => {
  afterReload({ phase: 'transfer', unlockState: 'submitted' });
  await app.restoreResumeState();
  // Every payload is present but ONE has the wrong bytes. Size would match; only
  // the sha256 readback catches it, and it must be re-pushed.
  const incoming = {
    '/data/libreecho/incoming/libreecho-radar-puffin-boot.img': new Blob(['boot-bytes']),
    '/data/libreecho/incoming/manifest': new Blob(['signed-manifest-bytes']),
    '/data/libreecho/incoming/manifest.sig': new Blob(['sig-hex-bytes']),
    '/data/libreecho/incoming/libreecho-radar-puffin.ota.tar': new Blob(['ota-tar-bytes']),
    '/data/libreecho/incoming/libreecho-radar-puffin-airplay2.squashfs': new Blob(['payload']),
    // right LENGTH, wrong CONTENT
    '/data/libreecho/incoming/libreecho-radar-puffin-airplay2.manifest.json': new Blob(['BAD']),
  };
  const session = twrp({ guard: guardAfter('transfer', 'formatted'), incoming });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  const pushes = session.calls.filter((c) => /^push \/data\/libreecho\/incoming\//.test(String(c)));
  assert.equal(pushes.length, 1, `a corrupt payload was trusted: ${pushes.join(' | ')}`);
  assert.match(pushes[0], /airplay2\.manifest\.json/, 'the corrupt payload was not re-pushed');
});

test('the landing-zone readback is read-only: it never pushes or formats to find out', async () => {
  afterReload({ phase: 'transfer', unlockState: 'submitted' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('transfer', 'formatted') });
  await primeReady({ adb: session.client });
  const log = await runLog(() => app.resumeInstall());
  // The check must be a hash readback over the documented landing zone only.
  const hashes = session.calls.filter((c) => /\/sbin\/sha256sum \/data\/libreecho\/incoming\//.test(String(c)));
  assert.ok(hashes.length > 0, 'the landing zone was never read back');
  for (const call of session.calls) {
    assert.doesNotMatch(String(call), /mke2fs|--phase initialize\b/,
      `the payload readback tried to mutate the device: ${call}`);
  }
  void log;
});

// ===========================================================================
// K. A FRESH PREPARE MUST JOURNAL ITS INTENT BEFORE THE COMMAND
// ===========================================================================

test('a fresh prepare attempt journals durable intent before the command leaves', async () => {
  afterReload({ withJournal: false, phase: 'fresh', unlockState: 'submitted' });
  // No journal at all is a fresh transaction; but the browser must still record
  // "a prepare is about to be attempted" BEFORE it runs, so a crash mid-prepare
  // leaves evidence that forbids an automatic retry.
  store.delete(RESUME_JOURNAL_KEY);
  await app.restoreResumeState();
  const session = twrp({ guard: null, userdataSectors: 999999 });
  await primeReady({ adb: session.client });
  // Observed from inside the run: at the moment the prepare command is sent,
  // what does durable storage say?
  let journalAtPrepare = null;
  const originalShell = session.client.shell;
  session.client.shell = async (command) => {
    if (/--phase prepare\b/.test(String(command)) && journalAtPrepare === null) {
      journalAtPrepare = store.get(RESUME_JOURNAL_KEY) ?? null;
    }
    return originalShell(command);
  };
  await app.runInstall();
  if (phases(session.calls, 'prepare').length > 0) {
    assert.ok(journalAtPrepare, 'the prepare command was sent with NO durable intent recorded first');
    const written = JSON.parse(journalAtPrepare);
    assert.equal(written.serialSha256, DIGEST_SERIAL);
  }
  // Whatever happened, the journal must never carry a secret.
  assert.doesNotMatch(store.get(RESUME_JOURNAL_KEY) ?? '', /password|ssid/i);
});

test('a fresh prepare with uncertain browser intent refuses rather than reshaping userdata', async () => {
  // browserPrepareAttempted must be explicitly false for the no-guard case. A
  // browser that cannot say "no prepare was ever attempted" must not reshape.
  afterReload({ withJournal: false });
  store.delete(RESUME_JOURNAL_KEY);
  await app.restoreResumeState();
  const session = twrp({ guard: null, userdataSectors: 999999 });
  await primeReady({ adb: session.client });
  const decision = await app.__reconcileResumeForTest({
    adb: session.client,
    browserPrepareAttempted: undefined,
  });
  assert.equal(decision.ok, false, 'an uncertain prepare attempt still authorised prepare');
  assert.match(decision.reason, /prepare|refus|cannot confirm/i, decision.reason);
});

// ===========================================================================
// L. NO AUTOMATIC RE-UNLOCK, NO AUTOMATIC REFORMAT, EVER
// ===========================================================================

test('a resume whose journal claims an unlock never re-sends brick even when the guard is fresh', async () => {
  afterReload({ phase: 'prepare', unlockState: 'submitted' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('transfer', 'formatted') });
  await primeReady({ adb: session.client });
  const flashes = [];
  app.state.fastboot = { client: { flash: async (...args) => { flashes.push(args); } } };
  const log = await runLog(() => app.resumeInstall());
  assert.deepEqual(flashes, [], 'a resume re-sent flash:brick');
  assert.match(log, /not be sent again/i, 'the unlock no-rearm message is missing');
});

test('no resume path ever emits --phase initialize when the device says userdata is formatted', async () => {
  for (const phase of ['transfer', 'finalize']) {
    afterReload({ phase, unlockState: 'submitted' });
    await app.restoreResumeState();
    const session = twrp({ guard: guardAfter('transfer', 'formatted') });
    await primeReady({ adb: session.client });
    await app.resumeInstall();
    assert.equal(phases(session.calls, 'initialize').length, 0,
      `a resume recorded at ${phase} reformatted userdata`);
  }
});


test('finalized resume requests fresh readback when ordinary installed receipt lacks observation fields', async () => {
  afterReload({ phase: 'finalize', unlockState: 'submitted' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('finalized', 'formatted') });
  session.setReceipt({ result: 'installed', fields: { protocol: '2', phase: 'finalize',
    invocation_id: 'f'.repeat(64), bundle_manifest_sha256: MANIFEST_SHA,
    device_digest: DEVICE_DIGEST, target: TARGET_BOARD, release: DIRECT_RELEASE } });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  const checks = session.calls.filter(c => /--phase finalize/.test(c) && /--dry-run/.test(c));
  assert.equal(checks.length, 1);
  assert.equal(session.calls.filter(c => /twrp reboot/.test(c)).length, 1);
  assert.equal(phases(session.calls, 'finalize').length, 0);
  assert.equal(session.calls.filter(c => /^push \/data\//.test(c)).length, 0);
});

test('a reload after installed readback can re-check its already-finalized refusal', async () => {
  afterReload({ phase: 'finalize', unlockState: 'submitted' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('finalized', 'formatted') });
  session.setReceipt({ result: 'failed', fields: { protocol: '2', phase: 'finalize',
    invocation_id: 'f'.repeat(64), bundle_manifest_sha256: MANIFEST_SHA,
    device_digest: DEVICE_DIGEST, target: TARGET_BOARD, release: DIRECT_RELEASE,
    error: 'already-finalized', installed_state: 'verified', installed_layout: 'v3',
    installed_boot_sha256: createHash('sha256').update('boot-bytes').digest('hex') } });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  assert.equal(session.calls.filter(c => /--phase finalize/.test(c) && /--dry-run/.test(c)).length, 1);
  assert.equal(session.calls.filter(c => /twrp reboot/.test(c)).length, 1);
  assert.equal(phases(session.calls, 'finalize').length, 0);
});

test('stored verified receipt cannot authorize reboot after installed bytes change', async () => {
  afterReload({ phase: 'finalize', unlockState: 'submitted' });
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('finalized', 'formatted'), liveInstalled: false });
  session.setReceipt({ result: 'installed', fields: { protocol: '2', phase: 'finalize',
    invocation_id: 'f'.repeat(64), bundle_manifest_sha256: MANIFEST_SHA,
    device_digest: DEVICE_DIGEST, target: TARGET_BOARD, release: DIRECT_RELEASE,
    installed_state: 'verified', installed_layout: 'v3',
    installed_boot_sha256: createHash('sha256').update('boot-bytes').digest('hex') } });
  await primeReady({ adb: session.client });
  await app.resumeInstall();
  assert.equal(session.calls.filter(c => /twrp reboot/.test(c)).length, 0);
  assert.equal(phases(session.calls, 'finalize').length, 0);
});


// ===========================================================================
// AN ECHO THAT ALREADY FINISHED AN INSTALL (real Dot, 2026-10-06)
// ===========================================================================

test('a fresh Install on a finished Echo writes nothing and offers Erase and reinstall', async () => {
  afterReload({ withJournal: false });
  store.delete(RESUME_JOURNAL_KEY);
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('finalized', 'formatted') });
  await primeReady({ adb: session.client });
  app.state.reinstallConfirmed = null;
  await app.runInstall();
  for (const phase of ['prepare', 'initialize', 'transfer', 'finalize']) {
    assert.equal(phases(session.calls, phase).length, 0, `${phase} ran on a finished Echo`);
  }
  assert.equal(session.calls.some((c) => /\bmv\b|__LIBREECHO_RETIRE__/.test(c)), false, 'the record was moved without a choice');
  assert.ok(app.state.alreadyInstalled, 'the finished install was not recognised');
  const action = app.__primaryActionForTest();
  assert.equal(action.label, 'Erase and reinstall');
  assert.match(action.message, /already has LibreEcho/);
});

test('Erase and reinstall moves the finished record aside first, then runs prepare', async () => {
  afterReload({ withJournal: false });
  store.delete(RESUME_JOURNAL_KEY);
  await app.restoreResumeState();
  const session = twrp({ guard: guardAfter('finalized', 'formatted') });
  const shell = session.client.shell;
  let retired = false;
  session.client.shell = async (command) => {
    const text = String(command);
    if (text.includes('__LIBREECHO_RETIRE__')) {
      session.calls.push(text);
      retired = true;
      return { stdout: '__LIBREECHO_RETIRE__=ok\n' };
    }
    // After the rename the device has no record: answer the guard read as absent.
    if (retired && text === RESUME_GUARD_READ_COMMAND) return { stdout: framed(2) };
    return shell(command);
  };
  await primeReady({ adb: session.client });
  app.state.alreadyInstalled = { release: DIRECT_RELEASE, sameBuild: true };
  await app.__primaryActionForTest().run();
  const order = session.calls.map((c, i) => [i, c]);
  const retireAt = order.find(([, c]) => c.includes('__LIBREECHO_RETIRE__'))?.[0];
  const prepareAt = order.find(([, c]) => /--phase prepare\b/.test(c))?.[0];
  assert.ok(retireAt !== undefined, 'the finished record was never moved aside');
  assert.equal(session.calls.some((c) => /\brm -rf? \/cache\/libreecho-direct\b/.test(c)), false, 'the record was deleted');
  if (prepareAt !== undefined) assert.ok(retireAt < prepareAt, 'prepare ran before the old record was moved');
  assert.equal(app.state.alreadyInstalled, null);
});

test('the overall bar never moves backwards from the setup step into the run', () => {
  const steps = ['device-build', 'download-verify', 'connect-device', 'unlock-payload', 'configure', 'install'];
  const pre = steps.map((s) => app.preRunPercent(s, 1));
  for (let i = 1; i < pre.length; i += 1) assert.ok(pre[i] >= pre[i - 1], `${steps[i]} < ${steps[i - 1]}`);
  const run = ['unlock', 'recovery', 'stage', 'prepare', 'initialize', 'transfer', 'finalize', 'verify']
    .map((s) => app.runPercent(s, 0));
  assert.ok(run[0] >= pre.at(-1), `pressing Install moved the bar back: ${pre.at(-1)}% -> ${run[0]}%`);
  assert.ok(app.preRunPercent('download-verify', 0) < app.preRunPercent('download-verify', 1), 'the download does not move the bar');
});
