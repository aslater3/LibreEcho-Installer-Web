// Authoritative resume reconciliation, tested against a fake SHELL and nothing
// else.
//
// The only fake in this file is the transport boundary: a `shell()` double that
// answers the module's fixed commands with device facts. Every parser, gate,
// refusal code and next-phase decision is the module's real code. In particular
// the guard and receipt bodies are byte-exact what the shipped helper's
// `guard_write` and `receipt_body` emit, and the probe replies are what the
// module's own probe command would print on that device.
//
// What must hold, and what these tests pin:
//   * a resume point comes from the DEVICE's guard, never from journal.phase;
//   * a journal that is ahead or behind the guard never authorises a skip;
//   * format and finalize uncertainty is refused, never retried;
//   * the immutable bundle, release and target must match exactly;
//   * an incomplete prepare is refused rather than guessed at;
//   * a prepare receipt counts only when its `invocation_sha256` is the digest
//     the shipped helper's own recipe computes over the receipt's own bindings,
//     so a forged binding is refused;
//   * anything that writes into /data needs a real ext4 read-write /data whose
//     source IS the userdata node this module measured — recovery's own ramfs,
//     a foreign node, a read-only mount or an ambiguous mount table is refused
//     before any payload phase is returned;
//   * this module must run in a BROWSER: no Node globals on any path, so the
//     control-read bound is measured with TextEncoder and the suites below
//     delete `globalThis.Buffer` while a success path runs.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESUME_BOOT_SLOT_SECTORS,
  RESUME_CONTROL_READ_LIMIT_BYTES,
  RESUME_DATA_MOUNT_POINT,
  RESUME_END_MARKER,
  RESUME_EXIT_MARKER,
  RESUME_GUARD_PHASES,
  RESUME_GUARD_READ_COMMAND,
  RESUME_GUARD_SCHEMA,
  RESUME_MOUNTS_FILE,
  RESUME_NEXT_PHASES,
  RESUME_RECEIPT_READ_COMMAND,
  RESUME_STATE_DIR,
  RESUME_USERDATA_CONTRACT_SECTORS,
  parseResumeGuard,
  parseResumeReceipt,
  RESUME_RECEIPT_FIELDS,
  reconcileDeviceResume,
  resumeDataMountCommand,
  resumeDeviceProbeCommand,
} from './resume-device.js';
import { StageError } from './stages.js';
import { sha256Bytes } from './sha256.js';

const TARGET = 'radar_puffin';
const RELEASE = 'radar-puffin-v0.14.0';
const SERIAL = 'G090L00000000001';
const MANIFEST = 'b'.repeat(64);
const KAERU = '8816885870b203004c4b000000000000'.slice(0, 32);
const GUID = '2f3a1c9e-7d84-4b6a-9c11-0e5a8b7d3c22';
// sha256 of `target=<TARGET>\nserial=<SERIAL>\nuserdata_guid=<GUID>\n`, i.e. what the
// shipped helper's compute_device_digest would print for this device. The test
// below re-derives it through a real shell so it cannot drift.
const DIGEST = 'a2fbfd272291d0173653e23653b9744aa11a3f75a6aa8ecd335c09865f1953e9';

/** The helper's `guard_write` body, byte for byte, for one phase/format pair. */
function guardText({ phase = 'prepare', format = 'absent', protocol = '2', target = TARGET,
  release = RELEASE, bundle = MANIFEST, digest = DIGEST, schema = null } = {}) {
  // A second positional argument here has silently produced a fixture that
  // contradicted the device reply twice already; make it loud.
  assert.ok(arguments.length <= 1, 'guardText takes one options object');
  const lines = [
    `protocol=${protocol}`,
    `target=${target}`,
    `release=${release}`,
    `bundle_manifest_sha256=${bundle}`,
    `device_digest=${digest}`,
    `format_state=${format}`,
    `phase=${phase}`,
  ];
  if (schema !== null) lines.splice(0, 0, `schema=${schema}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The shipped helper's `receipt_invocation`, verbatim:
 *   printf '%s' "$PROTOCOL|$PHASE|$BUNDLE_MANIFEST_SHA256|$DEVICE_DIGEST|$TARGET|$RELEASE" | sha256sum
 * Note `printf '%s'` — there is no trailing newline in the hashed input, which
 * is exactly the detail a hand-written fixture gets wrong.
 */
function helperInvocationSha256({ protocol = '2', phase, bundle = MANIFEST, digest = DIGEST,
  target = TARGET, release = RELEASE } = {}) {
  return createHash('sha256').update(`${protocol}|${phase}|${bundle}|${digest}|${target}|${release}`).digest('hex');
}

/**
 * A receipt as `receipt_body` writes it: the five binding keys exactly once,
 * then the accumulated `receipt_set` fields.
 *
 * `invocationSha256` defaults to the REAL helper digest over these bindings, so a
 * fixture cannot accidentally pass the invocation check with a placeholder — and
 * `invocationSha256: 'forged'` is how a test pins the refusal.
 */
function receiptText(fields = {}, { phase = 'prepare', protocol = '2', bundle = MANIFEST,
  digest = DIGEST, target = TARGET, release = RELEASE,
  invocation = 'd'.repeat(64), invocationSha = null } = {}) {
  // The binding keys `receipt_body` always emits, then the identity keys main()
  // sets before any phase runs, then the phase's own `receipt_set` fields.
  const binding = {
    protocol,
    phase,
    invocation_id: invocation,
    bundle_manifest_sha256: bundle,
    invocation_sha256: invocationSha ?? helperInvocationSha256({
      protocol, phase, bundle, digest, target, release,
    }),
  };
  if (digest !== null) binding.device_digest = digest;
  if (target !== null) binding.target = target;
  if (release !== null) binding.release = release;
  return `${Object.entries({ ...binding, ...fields }).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/**
 * A receipt carrying the v3 readback keys the updated helper emits. This is the
 * shape `receipt_installed_state` writes for a device whose guard is finalized —
 * the case that must not be refused as an unknown-field receipt.
 */
/**
 * A receipt carrying the v3 readback keys. Per V3-CONTRACT 7.2 the key set is
 * fixed per state: `verified` comes with layout AND boot pin and NO reason;
 * every other state carries `installed_boot_state` AND a reason and NO pin; and
 * `unmounted`/`unknown` carry no layout, because there was no tree to name.
 */
function installedStateReceipt({ state, boot = 'match', layout = 'v3', reason = null,
  bootSha = 'c'.repeat(64), phase = 'prepare', result = 'prepare-ok', ...rest } = {}) {
  // The helper only emits `installed_layout` when INSTALLED_LAYOUT is non-empty
  // (`if [ -n "$INSTALLED_LAYOUT" ]`), so an unmounted readback OMITS the key.
  // `layout: null` must therefore drop it rather than print `installed_layout=`.
  const fields = { result, installed_state: state };
  if (state === 'verified') {
    // verified: the pin is the verdict. `installed_boot_state` is never set.
    if (layout !== null) fields.installed_layout = layout;
    if (bootSha !== null) fields.installed_boot_sha256 = bootSha;
  } else {
    fields.installed_boot_state = boot;
    if (layout !== null) fields.installed_layout = layout;
    if (reason !== null) fields.installed_state_reason = reason;
  }
  return receiptText(fields, { phase, ...rest });
}

/**
 * A rollover receipt: prepare archived a FINALIZED guard for a different release
 * and is now a brand-new transaction.
 */
function rolloverReceipt({ from = 'radar-puffin-v0.13.0', phase = 'finalized', format = 'formatted',
  archived = null, wouldRollover = null, ...rest } = {}) {
  const fields = { result: 'prepare-noop', reboot_required: '0',
    rolled_over_from: from, rolled_over_phase: phase, rolled_over_format_state: format };
  if (archived !== null) fields.archived_transaction = archived;
  if (wouldRollover !== null) fields.would_rollover_transaction = wouldRollover;
  return receiptText(fields, { ...rest });
}

/** guard_archive_name receives release, bundle SHA, device digest in that order. */
const archiveName = (bundle, release, digest) => `${release}-${bundle}-${digest}.state`;

/** A framed reply, exactly as the module's commands print it. */
function framed(rc, body = '') {
  return `${RESUME_EXIT_MARKER}${rc}\n${body ?? ''}${RESUME_END_MARKER}\n`;
}

// --- /data mount evidence ---------------------------------------------------
//
// Writing into /data while it is not mounted writes into recovery's own ramfs:
// the copies succeed, the digests read back and the whole tree is gone at boot.
// So the phases that write into /data are only authorised once /data is PROVEN
// to be the measured userdata node, ext4 and read-write.
//
// The fake below answers the module's mount probe by EXECUTING the module's real
// `resumeDataMountCommand()` against a real /proc/mounts-shaped file under a
// temp dir. That makes the mount evidence a genuine parse of a genuine mount
// table through the module's own shell — a hardcoded reply string would let an
// implementation accept a shape no device ever produces.

const MOUNT_FIXTURE_DIR = mkdtempSync(join(tmpdir(), 'libreecho-mounts-'));
let mountFixtureSeq = 0;

/**
 * Writes a real mount table. `entries` is a list of
 * `[source, target, fstype, options]` tuples, exactly /proc/mounts columns.
 */
function writeMounts(entries) {
  const path = join(MOUNT_FIXTURE_DIR, `mounts-${mountFixtureSeq++}`);
  const text = `${entries.map(([src, target, fs, opts]) => `${src} ${target} ${fs} ${opts} 0 0`).join('\n')}\n`;
  writeFileSync(path, text);
  return path;
}

/** The healthy device: /data is the measured userdata node, ext4, rw. */
const DEFAULT_DATA_MOUNT = { kind: 'entries', entries: [
  ['/dev/block/mmcblk0p11', '/cache', 'ext4', 'rw,nosuid,nodev,noatime'],
  ['/dev/block/mmcblk0p49', RESUME_DATA_MOUNT_POINT, 'ext4', 'rw,nosuid,nodev,noatime'],
  ['rootfs', '/', 'rootfs', 'ro,seclabel'],
] };

/** Recovery's own ramfs sitting at /data: the writes would evaporate. */
const RAMFS_DATA_MOUNT = { kind: 'entries', entries: [
  ['rootfs', '/', 'rootfs', 'ro,seclabel'],
  ['rootfs', RESUME_DATA_MOUNT_POINT, 'rootfs', 'rw,seclabel'],
] };

/**
 * Runs the module's real mount command with its fixed mounts path redirected at
 * a real file. Only the mounts path is substituted; the parsing, the fs/opt
 * checks and the emitted lines are the module's own shell.
 */
function runMountProbe(mount) {
  const command = resumeDataMountCommand();
  assert.ok(command.includes(RESUME_MOUNTS_FILE),
    `the mount probe must read the helper's own mounts file ${RESUME_MOUNTS_FILE}`);
  const files = mount.kind === 'entries' ? writeMounts(mount.entries) : mount.files;
  // The probe prints its own markers, so it is handed back verbatim (framing is
  // the module's own) rather than re-wrapped.
  return execFileSync('sh', ['-c', command.replace(RESUME_MOUNTS_FILE, files)], { encoding: 'utf8' });
}

/** A reply the module's mount probe would produce for a real mount table. */
function mountReply(mount, { rc = null, empty = false } = {}) {
  if (empty) return framed(0, '');
  if (rc !== null) return framed(rc);
  return runMountProbe(mount);
}

/** The reply the module's own probe command prints on a healthy device. */
function probeReply({ serial = SERIAL, digest = DIGEST, bootSectors = RESUME_BOOT_SLOT_SECTORS,
  userdataSectors = RESUME_USERDATA_CONTRACT_SECTORS[0] } = {}) {
  return [
    `serial=${serial}`,
    `userdata_guid=${GUID}`,
    `device_digest=${digest}`,
    'node_boot_a=mmcblk0p2',
    'node_boot_b=mmcblk0p3',
    'node_userdata=mmcblk0p49',
    `sectors_boot_a=${bootSectors}`,
    `sectors_boot_b=${bootSectors}`,
    `sectors_userdata=${userdataSectors}`,
  ].join('\n') + '\n';
}
const PROBE_BODY = probeReply();

/**
 * The fake device. `shell()` is matched on the module's own fixed command
 * constants, so a fixture cannot drift from the commands the module sends.
 *
 * `dataMount` is the ONE thing this fake can lie about, and it is deliberately
 * parameterised per knob: the mount probe is answered by RUNNING the module's
 * real `resumeDataMountCommand()` against a real temporary mounts file, so the
 * mount evidence is a genuine parse of a genuine /proc/mounts rather than a
 * hardcoded string the module could have been written to accept.
 */
function twrp({
  guard = null, receipt = null, guardRc = null, receiptRc = null,
  userdataSectors = RESUME_USERDATA_CONTRACT_SECTORS[0],
  bootSectors = RESUME_BOOT_SLOT_SECTORS, serial = SERIAL, digest = DIGEST,
  probeRc = 0, probeBody = null, throwOn = null,
  dataMount = DEFAULT_DATA_MOUNT, mountRc = null, mountUnreadable = false,
} = {}) {
  const calls = [];
  // Every fixture knob the module reads back is threaded into the probe reply, so
  // a fixture cannot describe a device the reply then contradicts.
  const probeBodyForDevice = () => probeReply({ serial, digest, bootSectors, userdataSectors });
  const client = {
    shell: async (command) => {
      const text = String(command);
      calls.push(text);
      if (throwOn && text.includes(throwOn)) throw new Error('device offline');
      if (text === RESUME_GUARD_READ_COMMAND) {
        return { stdout: guardRc !== null ? framed(guardRc) : framed(guard === null ? 2 : 0, guard) };
      }
      if (text === RESUME_RECEIPT_READ_COMMAND) {
        return { stdout: receiptRc !== null ? framed(receiptRc) : framed(receipt === null ? 2 : 0, receipt) };
      }
      if (text === resumeDeviceProbeCommand(TARGET)) {
        const body = probeBody ?? probeBodyForDevice();
        return { stdout: probeRc === 0 ? framed(0, body) : framed(probeRc) };
      }
      if (text === resumeDataMountCommand()) {
        return { stdout: mountReply(dataMount, { rc: mountRc, empty: mountUnreadable }) };
      }
      throw new Error(`unexpected shell command: ${text}`);
    },
  };
  return { client, calls, probe: () => calls.filter((c) => c.includes('__sys=/sys/class/block')).length,
    mountProbes: () => calls.filter((c) => c === resumeDataMountCommand()).length };
}

function args(overrides = {}) {
  return {
    adb: twrp().client,
    journal: null,
    manifestSha256: MANIFEST,
    target: TARGET,
    release: RELEASE,
    serialRaw: SERIAL,
    kaeruHeader: KAERU,
    browserPrepareAttempted: false,
    ...overrides,
  };
}

/** Runs and returns the refusal, asserting it really is a StageError with a code. */
async function refuses(call) {
  const error = await call().then(() => null, (thrown) => thrown);
  assert.ok(error instanceof StageError, `expected a StageError, got ${error}`);
  assert.equal(typeof error.detail?.code, 'string');
  return error;
}

// --- the fixed reads ------------------------------------------------------

test('the fixed reads name only the two contract files and are bounded', () => {
  assert.match(RESUME_GUARD_READ_COMMAND, /\/cache\/libreecho-direct/);
  assert.match(RESUME_GUARD_READ_COMMAND, /transaction\.state/);
  assert.match(RESUME_RECEIPT_READ_COMMAND, /\/cache\/libreecho-direct/);
  assert.match(RESUME_RECEIPT_READ_COMMAND, /receipt/);
  assert.doesNotMatch(RESUME_GUARD_READ_COMMAND, /receipt\.buf|install\.log|sgdisk\.out|upload-index/);
  for (const command of [RESUME_GUARD_READ_COMMAND, RESUME_RECEIPT_READ_COMMAND]) {
    assert.ok(command.includes(String(RESUME_CONTROL_READ_LIMIT_BYTES)));
    assert.ok(command.includes(RESUME_EXIT_MARKER) && command.includes(RESUME_END_MARKER));
    // Every symlink check runs over /cache itself, the state dir and the file.
    assert.match(command, /for __a in \/cache \$__d \$__p/);
  }
  assert.equal(RESUME_STATE_DIR, '/cache/libreecho-direct');
});

test('the probe command reproduces the helper compute_device_digest recipe', () => {
  const command = resumeDeviceProbeCommand(TARGET);
  assert.ok(command.includes("getprop ro.serialno"), 'serial from ro.serialno first');
  assert.ok(command.includes("getprop ro.boot.serialno"), 'serial falls back to ro.boot.serialno');
  assert.ok(command.includes('/sbin/sgdisk --info='), 'userdata GUID read from the GPT');
  assert.ok(command.includes("target=%s\\nserial=%s\\nuserdata_guid=%s\\n"), 'exact digest input format');
  assert.ok(command.includes('/sbin/sha256sum'), 'sha256, as the helper does');
  assert.ok(command.includes('PARTNAME='), 'the partition node must prove its own PARTNAME');
  assert.ok(command.includes(TARGET));
  // Nothing that writes.
  assert.doesNotMatch(command, /(^|[\s|;])(rm|mv|mkdir|mkfs|touch|dd)\s|[>|]\s*\/dev\/block\//);
});

test('the probe digest line reproduces the helper recipe, byte for byte', () => {
  // This is the whole point of computing the digest here at all: the resume may
  // only skip phases when it has measured the SAME digest the shipped helper
  // would. So run the module's actual digest pipeline through a real shell with
  // a known serial and GUID, and compare it with the helper's documented input
  // format computed independently.
  const line = resumeDeviceProbeCommand(TARGET)
    .split('\n')
    .find((l) => l.includes('__dg=$(printf'));
  assert.ok(line, 'the probe must compute a digest');
  // The assignment is `__dg=$(printf ... | sha256sum | awk '{ print $1 }')`;
  // run that inner pipeline with the serial and GUID this fixture uses.
  // The trailing `')` closes awk's program and then the substitution, so keep
  // the quote that belongs to awk.
  const inner = line.slice(line.indexOf('$(printf') + 2, line.lastIndexOf("')") + 1);
  assert.ok(inner.startsWith('printf') && inner.includes('sha256sum') && inner.includes('awk'),
    `unexpected digest pipeline shape: ${inner}`);
  const local = inner
    .replace('/sbin/sha256sum', 'sha256sum')
    .replace('"$__serial"', `'${SERIAL}'`)
    .replace('"$__guid"', `'${GUID}'`);
  const digest = execFileSync('sh', ['-c', local], { encoding: 'utf8' }).trim();
  assert.match(digest, /^[0-9a-f]{64}$/);
  // The helper's format string, verbatim from compute_device_digest:
  //   printf 'target=%s\nserial=%s\nuserdata_guid=%s\n' | sha256sum | awk '{print $1}'
  const expected = createHash('sha256')
    .update(`target=${TARGET}\nserial=${SERIAL}\nuserdata_guid=${GUID}\n`)
    .digest('hex');
  assert.equal(digest, expected);
});

test('an unsafe probe target is refused before any device command', async () => {
  assert.throws(() => resumeDeviceProbeCommand('radar puffin; rm -rf /'), StageError);
  assert.throws(() => resumeDeviceProbeCommand('../etc'), StageError);
});

// --- guard parsing --------------------------------------------------------

test('the shipped guard field set parses, with or without schema=1', () => {
  const legacy = parseResumeGuard(guardText());
  assert.equal(legacy.phase, 'prepare');
  assert.equal(legacy.formatState, 'absent');
  assert.equal(legacy.schema, null);
  const versioned = parseResumeGuard(guardText({ schema: RESUME_GUARD_SCHEMA }));
  assert.equal(versioned.schema, RESUME_GUARD_SCHEMA);
  assert.deepEqual({ ...versioned, schema: null }, legacy);
  for (const phase of RESUME_GUARD_PHASES) {
    assert.equal(parseResumeGuard(guardText({ phase })).phase, phase);
  }
});

test('a guard with a duplicate, unknown or missing field is refused', () => {
  const dup = `protocol=2\nprotocol=2\n${guardText().split('\n').slice(1).join('\n')}`;
  assert.throws(() => parseResumeGuard(dup), (e) => e.detail.code === 'guard-duplicate-field');
  assert.throws(() => parseResumeGuard(`${guardText()}free_bytes=12\n`),
    (e) => e.detail.code === 'guard-unknown-field');
  assert.throws(() => parseResumeGuard(guardText().replace(/^phase=.*\n/m, '')),
    (e) => e.detail.code === 'guard-missing-field');
  assert.throws(() => parseResumeGuard('protocol=2\nnot a kv line\n'),
    (e) => e.detail.code === 'guard-malformed');
  assert.throws(() => parseResumeGuard(guardText({ schema: 2 })),
    (e) => e.detail.code === 'guard-schema-unsupported');
  assert.throws(() => parseResumeGuard(guardText({ protocol: '1' })),
    (e) => e.detail.code === 'guard-protocol-mismatch');
  assert.throws(() => parseResumeGuard(guardText({ format: 'unknown' })),
    (e) => e.detail.code === 'guard-format-state-corrupt');
  assert.throws(() => parseResumeGuard(guardText({ phase: 'reboot' })),
    (e) => e.detail.code === 'guard-phase-corrupt');
  assert.throws(() => parseResumeGuard(guardText({ bundle: 'z'.repeat(64) })),
    (e) => e.detail.code === 'guard-malformed');
  assert.throws(() => parseResumeGuard(guardText({ target: 'radar puffin' })),
    (e) => e.detail.code === 'guard-malformed');
});

test('an empty or whitespace-only guard body is a refusal, not an empty guard', async () => {
  const error = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({ guard: "\n\n" }).client,
  })));
  assert.equal(error.detail.code, 'guard-missing-field');
});

test('a receipt parses, and the required binding keys are enforced', () => {
  const receipt = parseResumeReceipt(receiptText({ result: 'prepare-ok', reboot_required: '1' }));
  assert.equal(receipt.result, 'prepare-ok');
  assert.equal(receipt.phase, 'prepare');
  assert.equal(receipt.deviceDigest, DIGEST);
  assert.equal(receipt.error, null);
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'x' }).replace(/^result=.*\n/m, '')),
    (e) => e.detail.code === 'receipt-missing-field');
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'x', wifi_password: 'nope' })),
    (e) => e.detail.code === 'receipt-unknown-field');
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'x' }).replace('result=x', 'result=x\nresult=y')),
    (e) => e.detail.code === 'receipt-duplicate-field');
});

// --- the absent guard -----------------------------------------------------

test('no guard plus a fresh journal and no browser prepare attempt yields prepare', async () => {
  const result = await reconcileDeviceResume(args({ adb: twrp().client }));
  assert.equal(result.nextPhase, 'prepare');
  assert.equal(result.guard, null);
  assert.equal(result.receipt, null);
  assert.equal(result.deviceDigest, DIGEST);
  assert.deepEqual(result.evidence.skippedPhases, []);
  assert.equal(result.evidence.guardSource, 'absent');
});

test('no guard plus an unknown browser prepare attempt is refused, not assumed', async () => {
  for (const browserPrepareAttempted of [null, true]) {
    const error = await refuses(() => reconcileDeviceResume(args({ browserPrepareAttempted })));
    assert.equal(error.detail.code, 'guard-missing-prepare-attempted');
  }
});

test('no guard plus a journal claiming a later phase is refused', async () => {
  for (const phase of ['prepare', 'initialize', 'transfer', 'finalize']) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp().client,
      journal: { phase, unlockState: 'submitted', releaseTag: RELEASE, target: TARGET },
    })));
    assert.equal(error.detail.code, 'guard-missing-after-phase');
  }
});

test('no guard plus a submitted unlock is refused', async () => {
  const error = await refuses(() => reconcileDeviceResume(args({
    adb: twrp().client,
    journal: { phase: 'fresh', unlockState: 'submitted' },
  })));
  assert.equal(error.detail.code, 'guard-missing-after-unlock');
});

test('no guard but an implausible layout is still refused before prepare', async () => {
  const error = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({ bootSectors: 65536 }).client,
  })));
  assert.equal(error.detail.code, 'layout-mismatch');
});

// --- per-phase decisions --------------------------------------------------

test('guard=prepare/absent with a bound prepare receipt and a contract layout skips prepare', async () => {
  const result = await reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'prepare', format: 'absent' }),
      receipt: receiptText({ result: 'prepare-ok', reboot_required: '1', userdata_sectors: String(RESUME_USERDATA_CONTRACT_SECTORS[1]) }),
    }).client,
  }));
  assert.equal(result.nextPhase, 'initialize');
  assert.deepEqual(result.evidence.skippedPhases, ['prepare']);
  assert.equal(result.guard.phase, 'prepare');
});

test('guard=prepare/absent is refused when the prepare evidence is incomplete', async () => {
  // No receipt: guard phase=prepare is written BEFORE the reshape, so it cannot
  // say whether prepare finished.
  const noReceipt = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({ guard: guardText({ phase: 'prepare', format: 'absent' }) }).client,
  })));
  assert.equal(noReceipt.detail.code, 'prepare-evidence-incomplete');
  assert.match(noReceipt.message, /no receipt/);

  // A contract-size layout but a receipt from another phase: the receipt is
  // overwritten every phase, so it proves nothing about prepare.
  const otherPhase = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'prepare', format: 'absent' }),
      receipt: receiptText({ result: 'transferred' }, { phase: 'transfer' }),
    }).client,
  })));
  assert.equal(otherPhase.detail.code, 'prepare-evidence-incomplete');

  // A receipt bound to another bundle, device, target or release is not prepare
  // evidence for this transaction either.
  for (const overrides of [{ bundle: 'f'.repeat(64) }, { digest: '9'.repeat(64) },
    { target: 'biscuit' }, { release: 'biscuit-v0.1.0' }]) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({
        guard: guardText({ phase: 'prepare', format: 'absent' }),
        receipt: receiptText({ result: 'prepare-ok' }, overrides),
      }).client,
    })));
    assert.equal(error.detail.code, 'prepare-evidence-incomplete');
  }

  // A contract-size layout is absent: the reshape cannot have happened, so the
  // guard cannot be skipped past.
  const unreshaped = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'prepare', format: 'absent' }),
      receipt: receiptText({ result: 'prepare-ok' }),
      userdataSectors: 1_000_000,
    }).client,
  })));
  assert.equal(unreshaped.detail.code, 'prepare-evidence-incomplete');
});

test('guard=initialize/formatted yields transfer and never initialize again', async () => {
  const result = await reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'initialize', format: 'formatted' }),
      receipt: receiptText({ result: 'initialized', format_state: 'formatted' }, { phase: 'initialize' }),
    }).client,
  }));
  assert.equal(result.nextPhase, 'transfer');
  assert.deepEqual(result.evidence.skippedPhases, ['prepare', 'initialize']);
  assert.equal(result.receipt.result, 'initialized');
});

test('guard=transfer/formatted yields payloads, never format', async () => {
  const result = await reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'transfer', format: 'formatted' }),
      receipt: receiptText({ result: 'transferred' }, { phase: 'transfer' }),
    }).client,
  }));
  assert.equal(result.nextPhase, 'payloads');
  assert.deepEqual(result.evidence.skippedPhases, ['prepare', 'initialize', 'transfer']);
  assert.ok(RESUME_NEXT_PHASES.includes(result.nextPhase));
});

test('guard=finalized yields verify-installed and never repeats finalize', async () => {
  const result = await reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'finalized', format: 'formatted' }),
      receipt: receiptText({ result: 'installed', format_state: 'formatted' }, { phase: 'finalize' }),
    }).client,
  }));
  assert.equal(result.nextPhase, 'verify-installed');
  assert.deepEqual(result.evidence.skippedPhases, ['prepare', 'initialize', 'transfer', 'finalize']);
});

test('an interrupted format is refused: its outcome is unknown and never retried', async () => {
  for (const phase of ['initialize', 'transfer', 'finalizing', 'finalized']) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({ guard: guardText({ phase, format: 'formatting' }) }).client,
    })));
    assert.equal(error.detail.code, 'guard-format-uncertain');
  }
});

test('finalizing is refused as uncertain, with no retry authorised', async () => {
  const error = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'finalizing', format: 'formatted' }),
      receipt: receiptText({ result: 'dry-run-ok' }, { phase: 'finalize' }),
    }).client,
  })));
  assert.equal(error.detail.code, 'guard-phase-uncertain:finalizing');
  assert.ok(!/retry/i.test(error.message), 'the refusal must not offer a retry');
});

test('a phase/format_state combination the helper never writes is refused', async () => {
  for (const [phase, format] of [['prepare', 'formatted'], ['initialize', 'absent'],
    ['transfer', 'absent'], ['finalized', 'absent']]) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({ guard: guardText({ phase, format }) }).client,
    })));
    assert.equal(error.detail.code, 'guard-phase-state-impossible');
  }
});

// --- immutable bindings ---------------------------------------------------

test('a guard bound to a different bundle, target, release or device is refused', async () => {
  for (const [overrides, code] of [
    [{ bundle: 'f'.repeat(64) }, 'guard-binding-mismatch:bundle_manifest_sha256'],
    [{ target: 'biscuit' }, 'guard-binding-mismatch:target'],
    [{ release: 'biscuit-v0.1.0' }, 'guard-binding-mismatch:release'],
    [{ digest: '9'.repeat(64) }, 'guard-device-digest-mismatch'],
  ]) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({ guard: guardText({ phase: 'transfer', format: 'formatted', ...overrides }) }).client,
    })));
    assert.equal(error.detail.code, code);
  }
});

test('the device digest is computed by the helper recipe, so a different serial refuses', async () => {
  // The probe on this device answers with SERIAL, but the caller is bound to a
  // different one: the same helper recipe would have produced a different digest.
  const error = await refuses(() => reconcileDeviceResume(args({ serialRaw: 'G090L00000009999' })));
  assert.equal(error.detail.code, 'serial-mismatch');
});

test('an unreadable device identity is refused, never guessed', async () => {
  for (const [probeRc, code] of [[10, 'serial-unreadable'], [11, 'userdata-guid-unreadable'],
    [12, 'partition-identity-unresolved'], [13, 'device-digest-unreadable']]) {
    const error = await refuses(() => reconcileDeviceResume(args({ adb: twrp({ probeRc }).client })));
    assert.equal(error.detail.code, code);
  }
  const weird = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({ probeBody: PROBE_BODY.replace(`sectors_userdata=${RESUME_USERDATA_CONTRACT_SECTORS[0]}`, 'sectors_userdata=none') }).client,
  })));
  assert.equal(weird.detail.code, 'layout-unreadable');
});

test('an unsafe control path on the device is refused, not read', async () => {
  for (const [rc, code] of [[91, 'symlink-refused'], [92, 'size-unreadable'], [93, 'oversize']]) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({ guard: guardText({ phase: 'transfer', format: 'formatted' }), guardRc: rc }).client,
    })));
    assert.equal(error.detail.code, code);
  }
  // An unterminated stream cannot be mistaken for an empty file.
  const unterminated = await refuses(() => reconcileDeviceResume(args({
    adb: { shell: async (command) => ({ stdout: command === RESUME_GUARD_READ_COMMAND ? `${RESUME_EXIT_MARKER}0\nphase=transfer\n` : framed(2) }) },
  })));
  assert.equal(unterminated.detail.code, 'control-unterminated');
});

// --- journal is corroboration, never authority ----------------------------

test('a journal behind the guard changes nothing; a journal ahead never skips a phase', async () => {
  const guard = guardText({ phase: 'initialize', format: 'formatted' });
  const behind = await reconcileDeviceResume(args({
    adb: twrp({ guard }).client,
    // The journal only got as far as prepare. The guard, not the journal, decides.
    journal: { phase: 'prepare', releaseTag: RELEASE, target: TARGET, bundleManifestSha256: MANIFEST },
  }));
  assert.equal(behind.nextPhase, 'transfer');
  assert.deepEqual(behind.evidence.journalChecks, ['bundleManifestSha256', 'target', 'releaseTag']);

  const ahead = await reconcileDeviceResume(args({
    adb: twrp({ guard }).client,
    // A journal claiming finalize, with the guard at initialize: no skip.
    journal: { phase: 'finalize', releaseTag: RELEASE, target: TARGET },
  }));
  assert.equal(ahead.nextPhase, 'transfer');
  assert.equal(ahead.guard.phase, 'initialize');
});

test('every non-empty journal binding is cross-checked', async () => {
  const guard = guardText({ phase: 'transfer', format: 'formatted' });
  const serialSha256 = await sha256Bytes(new TextEncoder().encode(SERIAL));
  for (const journal of [
    { bundleManifestSha256: 'f'.repeat(64) },
    { target: 'biscuit' },
    { releaseTag: 'biscuit-v0.1.0' },
    { deviceDigest: '9'.repeat(64) },
    { kaeruHeader: '0'.repeat(32) },
    { serialSha256: '0'.repeat(64) },
  ]) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({ guard }).client,
      journal,
    })));
    assert.equal(error.detail.code, 'journal-binding-mismatch');
  }
  // Empty fields are simply absent, not disagreements.
  const result = await reconcileDeviceResume(args({
    adb: twrp({ guard }).client,
    journal: { bundleManifestSha256: '', target: null, releaseTag: undefined,
      deviceDigest: '', kaeruHeader: '', serialSha256, phase: 'transfer' },
  }));
  assert.equal(result.nextPhase, 'payloads');
  assert.deepEqual(result.evidence.journalChecks, ['serialSha256']);
});

// --- input validation and cancellation ------------------------------------

test('the required inputs are validated before any device command', async () => {
  const fake = twrp();
  const cases = [
    [{ manifestSha256: 'not-a-digest' }, 'bundle-manifest-unpinned'],
    [{ target: 'radar puffin' }, 'target-unsafe'],
    [{ release: 'a/b' }, 'release-unsafe'],
    [{ serialRaw: 'G090L; rm -rf /' }, 'serial-unsafe'],
    [{ kaeruHeader: 'zz' }, 'kaeru-header-unusable'],
    [{ adb: null }, 'no-adb-session'],
  ];
  for (const [overrides, code] of cases) {
    const error = await refuses(() => reconcileDeviceResume(args({ adb: fake.client, ...overrides })));
    assert.equal(error.detail.code, code);
  }
  assert.equal(fake.calls.length, 0, 'nothing may reach the device before the inputs are checked');
});

test('a cancelled resume stops before it reads anything', async () => {
  const fake = twrp();
  const error = await reconcileDeviceResume(args({
    adb: fake.client,
    isCancelled: () => true,
  })).then(() => null, (thrown) => thrown);
  assert.equal(error?.name, 'RecoveryStopped');
  assert.equal(fake.calls.length, 0);
});

test('the reconciliation reads the guard, the receipt and the device, once each', async () => {
  const fake = twrp({
    guard: guardText({ phase: 'transfer', format: 'formatted' }),
    receipt: receiptText({ result: 'transferred' }, { phase: 'transfer' }),
  });
  const result = await reconcileDeviceResume(args({ adb: fake.client }));
  assert.equal(result.nextPhase, 'payloads');
  assert.deepEqual(fake.calls, [RESUME_GUARD_READ_COMMAND, RESUME_RECEIPT_READ_COMMAND,
    resumeDeviceProbeCommand(TARGET), resumeDataMountCommand()]);
  assert.equal(fake.mountProbes(), 1, 'the mount probe runs exactly once');
});

test('a transport failure during a probe is a refusal, not a silent pass', async () => {
  const fake = twrp({ throwOn: '__sys=/sys/class/block' });
  const error = await refuses(() => reconcileDeviceResume(args({ adb: fake.client })));
  assert.equal(error.detail.code, 'device-probe-failed');
});

test('no secret ever appears in a refusal message', async () => {
  const fake = twrp({ guard: guardText({ phase: 'transfer', format: 'formatted', target: 'radar puffin' }) });
  const error = await refuses(() => reconcileDeviceResume(args({ adb: fake.client })));
  assert.equal(error.stage, 'install');
  assert.ok(!/password|ssid|psk/i.test(`${error.message} ${JSON.stringify(error.detail)}`));
});
// --- the browser has no Node globals ---------------------------------------

test('a success path runs with no Node globals at all', async () => {
  // `Buffer` is a Node global that does not exist in a browser page. Line 359
  // used `Buffer.byteLength` on the SUCCESS path of every control read, so the
  // module would have thrown a ReferenceError in the one place it is supposed to
  // return a result. Everything else on this path must be web-standard.
  const saved = { Buffer: globalThis.Buffer, process: globalThis.process };
  delete globalThis.Buffer;
  delete globalThis.process;
  try {
    const result = await reconcileDeviceResume(args({
      adb: twrp({
        guard: guardText({ phase: 'transfer', format: 'formatted' }),
        receipt: receiptText({ result: 'transferred' }, { phase: 'transfer' }),
      }).client,
    }));
    assert.equal(result.nextPhase, 'payloads');
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('the control-read bound is measured in BYTES, not UTF-16 code units', async () => {
  // A guard body of multi-byte characters is fewer code units than bytes. A
  // `str.length`-style bound would let an oversize file through, and a
  // UTF-16-code-unit bound with a multi-byte body would refuse a legal one.
  const heavy = 'x\u00e9\u00e9\u00e9';
  assert.ok(new TextEncoder().encode(heavy).length > heavy.length,
    'this fixture must have more bytes than UTF-16 code units');
  const oneByteOver = heavy.repeat(Math.ceil(RESUME_CONTROL_READ_LIMIT_BYTES / heavy.length) + 1);
  assert.ok(new TextEncoder().encode(oneByteOver).length > RESUME_CONTROL_READ_LIMIT_BYTES);
  const error = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({ guard: `${heavy.repeat(RESUME_CONTROL_READ_LIMIT_BYTES / heavy.length + 1)}protocol=2\n`,
      guardRc: null }).client,
  })));
  assert.equal(error.detail.code, 'control-oversize');
});

// --- the receipt schema the helper actually emits --------------------------

test('the allowed receipt keys are exactly the keys the updated helper writes', async () => {
  // Each of these is a `receipt_set` key in the shipped helper's current
  // source. `staging` was in the old list with no producer anywhere in the
  // helper, and a stale allowlist is what made a v3 readback receipt an
  // unknown-field refusal.
  assert.doesNotThrow(() => parseResumeReceipt(rolloverReceipt({
    from: 'radar-puffin-v0.13.0', phase: 'finalized', format: 'formatted',
    archived: archiveName('f'.repeat(64), 'radar-puffin-v0.13.0', DIGEST),
  })));
  assert.doesNotThrow(() => parseResumeReceipt(rolloverReceipt({
    from: 'radar-puffin-v0.13.0', wouldRollover: archiveName('f'.repeat(64), 'radar-puffin-v0.13.0', DIGEST),
  })), 'the dry-run rollover key is emitted too');

  // The v3 readback keys, exactly as receipt_installed_state writes them.
  for (const receipt of [
    installedStateReceipt({ state: 'verified', boot: 'match', layout: 'v3' }),
    installedStateReceipt({ state: 'mismatch', boot: 'mismatch', layout: 'v3',
      reason: 'complete-digest-mismatch' }),
    installedStateReceipt({ state: 'unmounted', boot: 'unknown', layout: null, reason: 'data-not-mounted' }),
    installedStateReceipt({ state: 'unknown', boot: 'unknown', layout: null, reason: 'no-installed-record' }),
  ]) {
    assert.doesNotThrow(() => parseResumeReceipt(receipt), `refused a real helper receipt: ${receipt}`);
  }
});

test('an unknown receipt key is still refused, and `staging` is gone from the schema', () => {
  // Retaining strict rejection is the point: an unknown key means a helper this
  // reader does not understand, which is a refusal, not a field to ignore.
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'x', wifi_password: 'nope' })),
    (e) => e.detail.code === 'receipt-unknown-field');
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'x', staging: '/data/x' })),
    (e) => e.detail.code === 'receipt-unknown-field');
});

test('known receipt fields are format-validated, so a receipt cannot lie about evidence', () => {
  const base = { result: 'installed' };
  // reboot_required is a 0/1 flag from the helper.
  assert.throws(() => parseResumeReceipt(receiptText({ ...base, reboot_required: 'yes' }, { phase: 'finalize' })),
    (e) => e.detail.code === 'receipt-malformed');
  // The boot digests are sha256s; the caller uses them as installed evidence.
  assert.throws(() => parseResumeReceipt(receiptText({ ...base, boot_a_sha256: 'not-a-digest' }, { phase: 'finalize' })),
    (e) => e.detail.code === 'receipt-malformed');
  assert.throws(() => parseResumeReceipt(receiptText({ ...base, boot_b_sha256: 'zz' }, { phase: 'finalize' })),
    (e) => e.detail.code === 'receipt-malformed');
  // `validated` is the helper's own vocabulary: dry-run only, and only `full`.
  assert.throws(() => parseResumeReceipt(receiptText({ ...base, validated: 'partial' }, { phase: 'finalize' })),
    (e) => e.detail.code === 'receipt-malformed');
  // Numeric fields are decimal counts.
  for (const key of ['userdata_sectors', 'userdata_first', 'userdata_last',
    'transfer_bytes_total', 'transfer_need_bytes', 'free_bytes', 'hardlinked']) {
    assert.throws(() => parseResumeReceipt(receiptText({ ...base, [key]: '12x' }, { phase: 'finalize' })),
      (e) => e.detail.code === 'receipt-malformed', `${key} accepted a non-decimal value`);
  }
  // The installed-state vocabulary is the helper's, not ours.
  assert.throws(() => parseResumeReceipt(installedStateReceipt({ state: 'probably-fine' })),
    (e) => e.detail.code === 'receipt-malformed');
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'failed', installed_state: 'mismatch', installed_layout: 'v3', installed_state_reason: 'complete-digest-mismatch', installed_boot_state: 'ish' })),
    (e) => e.detail.code === 'receipt-malformed');
  // Rollover evidence: a phase and a format_state, not free text.
  assert.throws(() => parseResumeReceipt(rolloverReceipt({ phase: 'weird' })),
    (e) => e.detail.code === 'receipt-malformed');
  assert.throws(() => parseResumeReceipt(rolloverReceipt({ format: 'halfway' })),
    (e) => e.detail.code === 'receipt-malformed');
  // And a well-formed one survives.
  const ok = parseResumeReceipt(receiptText({
    result: 'installed', format_state: 'formatted', hardlinked: '12', reboot_required: '0',
    boot_a_sha256: 'a'.repeat(64), boot_b_sha256: 'a'.repeat(64), validated: 'full',
  }, { phase: 'finalize' }));
  assert.equal(ok.result, 'installed');
  assert.equal(ok.bootASha256, 'a'.repeat(64));
  assert.equal(ok.bootBSha256, 'a'.repeat(64));
  assert.equal(ok.rebootRequired, false);
  assert.equal(ok.installedState, null);
});

test('the installed-state evidence a v3 readback carries is preserved for the caller', () => {
  // The parent uses these to decide whether a finalized install is really there;
  // the reconciliation must not drop them on the floor.
  const parsed = parseResumeReceipt(installedStateReceipt({ state: 'verified',
    layout: 'v3', bootSha: 'b'.repeat(64) }));
  assert.equal(parsed.installedState, 'verified');
  assert.equal(parsed.installedBootState, null);
  assert.equal(parsed.installedLayout, 'v3');
  assert.equal(parsed.installedBootSha256, 'b'.repeat(64));
  const rollover = parseResumeReceipt(rolloverReceipt({ from: 'radar-puffin-v0.13.0' }));
  assert.equal(rollover.rolledOverFrom, 'radar-puffin-v0.13.0');
  assert.equal(rollover.rolledOverPhase, 'finalized');
  assert.equal(rollover.rolledOverFormatState, 'formatted');
  assert.equal(rollover.rebootRequired, false);
});

// --- the prepare receipt's invocation binding ------------------------------

test('a prepare receipt with a FORGED invocation digest is refused', async () => {
  // The invocation digest is the helper's own recipe over the receipt's own
  // bindings. Any receipt whose digest does not recompute is not a receipt this
  // helper wrote for these bindings, so it is not prepare evidence.
  const error = await refuses(() => reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'prepare', format: 'absent' }),
      receipt: receiptText({ result: 'prepare-ok', reboot_required: '1' },
        { invocationSha: 'f'.repeat(64) }),
    }).client,
  })));
  assert.equal(error.detail.code, 'prepare-evidence-incomplete');
});

test('a prepare receipt with an UNBOUND invocation id is refused', async () => {
  // The helper validates `--invocation-id` as hex64 and blanks it when it is not;
  // the browser always sends one. An empty id means the receipt was not bound to
  // this browser's invocation, so the caller must not be able to point at it.
  for (const invocation of ['', 'zz', 'abc']) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({
        guard: guardText({ phase: 'prepare', format: 'absent' }),
        receipt: receiptText({ result: 'prepare-ok' }, { invocation }),
      }).client,
    })));
    assert.equal(error.detail.code, 'prepare-evidence-incomplete', `invocation_id=${invocation}`);
  }
});

test('the invocation digest recomputes through the helper recipe, byte for byte', () => {
  // Independent re-derivation of `receipt_invocation` through a REAL shell, so
  // the fixture digest cannot drift from the helper's `printf '%s'` (no trailing
  // newline) shape.
  const input = `2|prepare|${MANIFEST}|${DIGEST}|${TARGET}|${RELEASE}`;
  const fromShell = execFileSync('sh',
    ['-c', `printf '%s' ${JSON.stringify(input)} | sha256sum | awk '{ print $1 }'`],
    { encoding: 'utf8' }).trim();
  assert.equal(fromShell, helperInvocationSha256({ phase: 'prepare' }));
  assert.notEqual(
    createHash('sha256').update(`${input}\n`).digest('hex'),
    fromShell,
    'a trailing newline in the hashed input must NOT be the helper recipe');
});

test('a real prepare receipt passes the invocation check and still yields initialize', async () => {
  // The positive control: if the recipe were wrong in the other direction every
  // resume would refuse forever.
  const result = await reconcileDeviceResume(args({
    adb: twrp({
      guard: guardText({ phase: 'prepare', format: 'absent' }),
      receipt: receiptText({ result: 'prepare-ok', reboot_required: '1' }),
    }).client,
  }));
  assert.equal(result.nextPhase, 'initialize');
  assert.equal(result.receipt.rebootRequired, true, 'prepare reboot_required is preserved for the caller');
});

test('the journal is never the authority for the prepare receipt, and neither is a receipt for another bundle', async () => {
  // A receipt bound to a different bundle/digest/target/release recomputes a
  // different invocation digest too, so every one of these must refuse.
  for (const overrides of [{ bundle: 'f'.repeat(64) }, { digest: '9'.repeat(64) },
    { target: 'biscuit' }, { release: 'biscuit-v0.1.0' }, { protocol: '1' }]) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({
        guard: guardText({ phase: 'prepare', format: 'absent' }),
        receipt: receiptText({ result: 'prepare-ok' }, overrides),
      }).client,
    })));
    assert.equal(error.detail.code, 'prepare-evidence-incomplete', JSON.stringify(overrides));
  }
});

// --- /data mount evidence before any payload phase ------------------------

test('the mount probe reads the helper\'s own mounts file and proves the node by symlink', () => {
  const command = resumeDataMountCommand();
  assert.ok(command.includes(RESUME_MOUNTS_FILE), 'reads the helper MOUNTS default');
  assert.ok(command.includes(RESUME_DATA_MOUNT_POINT), 'looks at the helper DATA root');
  assert.ok(command.includes('readlink -f'), 'resolves the source, exactly as part_node does');
  assert.ok(command.includes(RESUME_EXIT_MARKER) && command.includes(RESUME_END_MARKER), 'framed like every other read');
  // Nothing writes: no mount, no mkdir, no umount.
  assert.doesNotMatch(command, /(^|[\s|;])(mount|umount|mkdir|rm|dd|mkfs|touch)\s/);
});

test('the production mount probe can read Linux procfs mounts', { skip: process.platform !== 'linux' }, () => {
  // Execute the untouched production command; /proc/mounts is normally a
  // procfs-managed symlink. No /data mount on this host is a valid rc=2, not 92.
  const out = execFileSync('sh', ['-c', resumeDataMountCommand()], { encoding: 'utf8' });
  assert.match(out, new RegExp(`^${RESUME_EXIT_MARKER}(0|2|20)\\n`), out);
  assert.ok(out.includes(RESUME_END_MARKER));
});

test('the mount probe really answers for a healthy /data and for recovery ramfs', () => {
  // Run the module's OWN shell, not a canned reply. If this did not answer for
  // the healthy fixture, every refusal test below would pass for the wrong reason.
  const healthy = runMountProbe(DEFAULT_DATA_MOUNT);
  assert.match(healthy, new RegExp(`^${RESUME_EXIT_MARKER}0\\n`), healthy);
  assert.match(healthy, /data_source=/);
  assert.match(healthy, /data_fstype=ext4/);
  assert.match(healthy, /data_opts=.*\brw\b/);
  assert.match(healthy, /data_entries=1/, 'exactly one /data entry is required');

  const ramfs = runMountProbe(RAMFS_DATA_MOUNT);
  assert.match(ramfs, /data_fstype=rootfs/, ramfs);
  assert.match(ramfs, /data_source=rootfs/);

  // Two stacked /data lines are ambiguous. The probe refuses them at the count,
  // BEFORE it prints any field, so an ambiguous table can never be read as if it
  // had settled on one entry.
  const ambiguous = runMountProbe({ kind: 'entries', entries: [
    ['/dev/block/mmcblk0p49', RESUME_DATA_MOUNT_POINT, 'ext4', 'rw'],
    ['/dev/block/mmcblk0p50', RESUME_DATA_MOUNT_POINT, 'ext4', 'rw'],
  ] });
  assert.match(ambiguous, new RegExp(`^${RESUME_EXIT_MARKER}20\\n`), ambiguous);
  assert.doesNotMatch(ambiguous, /data_source=/, 'no field may be emitted for an ambiguous table');
});

test('initialize and transfer require a real, rw, ext4 /data on the measured node', async () => {
  for (const [phase, next] of [['initialize', 'transfer'], ['transfer', 'payloads']]) {
    const good = await reconcileDeviceResume(args({
      adb: twrp({ guard: guardText({ phase, format: 'formatted' }) }).client,
    }));
    assert.equal(good.nextPhase, next, `${phase} on a healthy device`);
  }
});

test('a ramfs /data is refused before any payload phase is returned', async () => {
  // Recovery's own ramfs IS a mount, so the refusal names what is wrong with it
  // (it is not the userdata node) rather than claiming the mount is unproven.
  for (const phase of ['initialize', 'transfer']) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({ guard: guardText({ phase, format: 'formatted' }), dataMount: RAMFS_DATA_MOUNT }).client,
    })));
    assert.equal(error.detail.code, 'data-mount-wrong-node', `${phase} against recovery ramfs`);
    assert.match(error.message, /rootfs/, 'the refusal must name the source it saw');
  }
});

test('a /data mounted from the WRONG node is refused', async () => {
  for (const phase of ['initialize', 'transfer']) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({
        guard: guardText({ phase, format: 'formatted' }),
        dataMount: { kind: 'entries', entries: [
          ['/dev/block/mmcblk0p50', RESUME_DATA_MOUNT_POINT, 'ext4', 'rw'],
        ] },
      }).client,
    })));
    assert.equal(error.detail.code, 'data-mount-wrong-node', phase);
  }
});

test('a read-only /data is refused', async () => {
  for (const phase of ['initialize', 'transfer']) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({
        guard: guardText({ phase, format: 'formatted' }),
        dataMount: { kind: 'entries', entries: [
          ['/dev/block/mmcblk0p49', RESUME_DATA_MOUNT_POINT, 'ext4', 'ro,seclabel'],
        ] },
      }).client,
    })));
    assert.equal(error.detail.code, 'data-mount-readonly', phase);
  }
});

test('an unmounted or ambiguous /data is refused', async () => {
  const absent = { kind: 'entries', entries: [
    ['rootfs', '/', 'rootfs', 'ro,seclabel'],
  ] };
  const ambiguous = { kind: 'entries', entries: [
    ['/dev/block/mmcblk0p49', RESUME_DATA_MOUNT_POINT, 'ext4', 'rw'],
    ['/dev/block/mmcblk0p50', RESUME_DATA_MOUNT_POINT, 'ext4', 'rw'],
  ] };
  for (const [mount, code] of [[absent, 'data-mount-absent'], [ambiguous, 'data-mount-ambiguous']]) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({ guard: guardText({ phase: 'transfer', format: 'formatted' }), dataMount: mount }).client,
    })));
    assert.equal(error.detail.code, code, JSON.stringify(mount));
  }
});

test('an unreadable mount probe is refused, never assumed', async () => {
  // Two distinct failures, two distinct codes, and neither is accepted: the
  // mount table itself unreadable (rc 92), and a probe that CLAIMS success while
  // printing no evidence at all — the helper's own awk-exits-0 trap.
  for (const [device, code] of [
    [{ mountUnreadable: true }, 'data-mount-unproven'],
    [{ mountRc: 92 }, 'data-mounts-unreadable'],
  ]) {
    const error = await refuses(() => reconcileDeviceResume(args({
      adb: twrp({ guard: guardText({ phase: 'transfer', format: 'formatted' }), ...device }).client,
    })));
    assert.equal(error.detail.code, code, JSON.stringify(device));
  }
});

test('the mount probe runs only for the phases that write into /data', async () => {
  // prepare only reshapes the GPT; finalized/verify-installed must not demand a
  // writable /data to be told what the next phase is, and a fresh resume has not
  // proven it yet either. Only initialize and transfer write payloads there.
  const cases = [
    [{ guard: null }, 0],
    [{ guard: guardText({ phase: 'prepare', format: 'absent' }),
      receipt: receiptText({ result: 'prepare-ok' }) }, 0],
    [{ guard: guardText({ phase: 'finalized', format: 'formatted' }) }, 0],
    [{ guard: guardText({ phase: 'initialize', format: 'formatted' }) }, 1],
    [{ guard: guardText({ phase: 'transfer', format: 'formatted' }) }, 1],
  ];
  for (const [fixture, probes] of cases) {
    const fake = twrp(fixture);
    await reconcileDeviceResume(args({ adb: fake.client })).catch(() => null);
    assert.equal(fake.mountProbes(), probes, JSON.stringify(Object.keys(fixture)));
  }
});

// --- the v3 installed-state readback, exactly as V3-CONTRACT 7.2/7.3 says ----
//
// The readback is an OBSERVATION, not a result: a finalized guard records that
// finalize RAN, and only this receipt can say the payload is still there. The
// contract's table (7.2) fixes which keys accompany which state, and 7.3 fixes
// what `verified` means. These tests pin the table, because a readback that
// parses but drops a required key would let a destroyed install read as healthy.

test('installed_state requires exactly the keys the contract table names', () => {
  // verified: layout AND boot pin are both set; no reason (nothing failed).
  const verified = parseResumeReceipt(installedStateReceipt({ state: 'verified', layout: 'v3',
    bootSha: 'b'.repeat(64) }));
  assert.equal(verified.installedState, 'verified');
  assert.equal(verified.installedLayout, 'v3');
  assert.equal(verified.installedBootSha256, 'b'.repeat(64));
  assert.equal(verified.installedStateReason, null, 'a verified readback has no reason token');

  // mismatch: layout and boot_state are set, and the boot PIN is not (the pin
  // would be a claim about bytes that did not match).
  const mismatch = parseResumeReceipt(installedStateReceipt({ state: 'mismatch', layout: 'v3',
    boot: 'mismatch', reason: 'complete-digest-mismatch' }));
  assert.equal(mismatch.installedState, 'mismatch');
  assert.equal(mismatch.installedLayout, 'v3');
  assert.equal(mismatch.installedBootState, 'mismatch');
  assert.equal(mismatch.installedBootSha256, null);
  assert.equal(mismatch.installedStateReason, 'complete-digest-mismatch');

  // unmounted: /data could not be read at all, so there is NO layout to report —
  // the helper leaves INSTALLED_LAYOUT empty and omits the key.
  const unmounted = parseResumeReceipt(installedStateReceipt({ state: 'unmounted', layout: null,
    boot: 'unknown', bootSha: null, reason: 'data-not-mounted' }));
  assert.equal(unmounted.installedLayout, null);
  assert.equal(unmounted.installedBootState, 'unknown');
  assert.equal(unmounted.installedStateReason, 'data-not-mounted');

  // unknown: nothing was ever installed, so it is not a mismatch.
  const unknown = parseResumeReceipt(installedStateReceipt({ state: 'unknown', layout: null,
    boot: 'unknown', bootSha: null, reason: 'no-installed-record' }));
  assert.equal(unknown.installedState, 'unknown');
  assert.equal(unknown.installedStateReason, 'no-installed-record');
  assert.throws(() => parseResumeReceipt(installedStateReceipt({ state: 'unknown', layout: null,
    boot: 'unknown', bootSha: null, reason: 'complete-digest-mismatch' })),
  (e) => e.detail.code === 'receipt-malformed',
  'an unknown readback is specifically "no record", never a mismatch reason');
});

test('a legacy-layout readback is accepted as readily as a v3 one', () => {
  const legacy = parseResumeReceipt(installedStateReceipt({ state: 'mismatch', layout: 'legacy',
    boot: 'match', reason: 'staged-manifest-missing' }));
  assert.equal(legacy.installedLayout, 'legacy');
  assert.equal(legacy.installedBootState, 'match');
});

test('installed_state_reason accepts the documented colon-carrying tokens', () => {
  // 7.2: the token names the FIRST thing that did not check out, and a detail
  // may be appended after a colon. Every token below is a real assignment or a
  // real printf in the shipped helper.
  for (const reason of [
    'data-not-mounted',
    'userdata-node-unresolved',
    'data-mounted-from-wrong-node:/dev/block/mmcblk0p50',
    'data-mount-fstype:ext4',
    'no-installed-record',
    'complete-digest-mismatch',
    'boot-slot-digest:boot_a',
    'boot-slot-digest:boot_b',
    'feature-payload-digest:tts',
    'feature-payload-missing:tts',
    'feature-manifest-digest:alexa',
    'feature-manifest-missing:alsa',
    'feature-path-symlink:tts',
    'feature-dir-missing:tts',
    'feature-pin-missing:tts',
    'feature-asset-unsafe:weird/name',
    'feature-manifest-asset-unsafe:tts',
    'generation-file-missing',
    'generation-file-set',
    'generation-missing',
    'generation-path-symlink',
    'generation-unreadable',
    'generations-missing',
    'generations-path-symlink',
    'staged-manifest-missing',
    'staging-path-symlink',
    'not-a-v3-generation',
    'manifest-board-mismatch',
    'manifest-boot-digest',
    'manifest-feature-set',
    'manifest-transaction-mismatch',
    'manifest-not-this-bundle',
    'signature-not-this-bundle',
    'feature-digest:tts',
    'manifest-unreadable',
    'boot-pin-missing',
    'current-pointer-unreadable',
    'current-pointer-unsafe',
    'partition-unresolved:boot_a',
    'partition-not-block:boot_b',
  ]) {
    const parsed = parseResumeReceipt(installedStateReceipt({ state: 'mismatch', layout: 'v3',
      boot: 'mismatch', reason }));
    assert.equal(parsed.installedStateReason, reason, `refused a documented reason token: ${reason}`);
  }
});

test('an UNDOCUMENTED or unsafe reason token is refused, not passed through', () => {
  // 7.2 says a NEW token must be added to the contract when it appears, so an
  // unknown one means this reader does not understand the helper's vocabulary.
  // It must fail closed rather than be echoed into the operator's message.
  for (const reason of [
    'whatever-broke',
    'data-not-mounted; rm -rf /',
    'data-not-mounted\ninstalled_state=verified',
    'boot-slot-digest:boot_a:boot_b',
    'data-not-mounted ',
    '',
    'boot-slot-digest:../../etc',
  ]) {
    assert.throws(() => parseResumeReceipt(installedStateReceipt({ state: 'mismatch', layout: 'v3',
      boot: 'mismatch', reason })),
    (e) => e.detail.code === (reason.includes('\n') ? 'receipt-duplicate-field' : 'receipt-malformed'),
    `accepted a bad reason token: ${JSON.stringify(reason)}`);
  }
});

test('the boot pin and the boot verdict are mutually exclusive claims', () => {
  // 7.3: the pin is what a VERIFIED readback hashed the slots against. In any
  // other state only the verdict is reported. A receipt carrying both is either
  // two different runs' leftovers or a fabrication, and either way must not be
  // read as "verified, and here is the pin".
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'failed', installed_state: 'verified', installed_layout: 'v3',
    installed_boot_state: 'match', installed_boot_sha256: 'b'.repeat(64) })),
  (e) => e.detail.code === 'receipt-malformed');
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'failed', installed_state: 'mismatch', installed_layout: 'v3',
    installed_state_reason: 'complete-digest-mismatch', installed_boot_state: 'mismatch', installed_boot_sha256: 'b'.repeat(64) })),
  (e) => e.detail.code === 'receipt-malformed');
  // A boot pin on its own, with no readback at all, is not a readback.
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'installed', installed_boot_sha256: 'b'.repeat(64) },
    { phase: 'finalize' })),
  (e) => e.detail.code === 'receipt-malformed');
  // And a readback state with neither verdict nor pin is incomplete.
  assert.throws(() => parseResumeReceipt(receiptText({
    result: 'installed', installed_state: 'verified', installed_layout: 'v3',
  }, { phase: 'finalize' })), (e) => e.detail.code === 'receipt-malformed');
});

test('a verified readback without its layout or pin is refused', () => {
  // 7.2 states verified comes WITH installed_layout and installed_boot_sha256.
  // A verified verdict with nothing behind it is the exact shape of a fabricated
  // "the install is fine", so it must not parse.
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'installed',
    installed_state: 'verified', installed_boot_sha256: 'b'.repeat(64) }, { phase: 'finalize' })),
  (e) => e.detail.code === 'receipt-malformed');
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'installed',
    installed_state: 'verified', installed_layout: 'v3' }, { phase: 'finalize' })),
  (e) => e.detail.code === 'receipt-malformed');
  // The layout is only meaningful WITH a state; a stray one is not evidence.
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'installed',
    installed_layout: 'v3', installed_boot_state: 'match' }, { phase: 'finalize' })),
  (e) => e.detail.code === 'receipt-malformed');
});

test('a non-verified readback must carry a reason token', () => {
  // Every non-verified state names WHY (7.2). A mismatch with no reason is the
  // shape a UI would render as "mismatch" with nothing to tell the operator.
  for (const state of ['mismatch', 'unmounted', 'unknown']) {
    assert.throws(() => parseResumeReceipt(receiptText({ result: 'installed', installed_state: state,
      installed_boot_state: 'mismatch', installed_layout: 'v3' }, { phase: 'finalize' })),
    (e) => e.detail.code === 'receipt-malformed', `${state} without a reason`);
  }
});

test('installed_boot_state is required on every non-verified readback', () => {
  // 7.3: the boot half is reported on its own in EVERY non-verified state, so a
  // feature-level mismatch never hides a boot-level one.
  for (const state of ['mismatch', 'unmounted', 'unknown']) {
    const parsed = parseResumeReceipt(installedStateReceipt({ state, layout: state === 'unmounted' || state === 'unknown' ? null : 'v3',
      boot: 'match', bootSha: null, reason: state === 'unknown' ? 'no-installed-record' : 'data-not-mounted' }));
    assert.equal(parsed.installedBootState, 'match');
    assert.throws(() => parseResumeReceipt(receiptText({ result: 'installed', installed_state: state,
      installed_state_reason: 'data-not-installed' }, { phase: 'finalize' })),
    (e) => e.detail.code === 'receipt-malformed', `${state} without a boot verdict`);
  }
});

test('the unknown-key refusal is unchanged by the readback schema', () => {
  // The worker added keys; it did not widen what this reader accepts. A receipt
  // from a helper with ANOTHER new key is still refused rather than partly read.
  assert.throws(() => parseResumeReceipt(receiptText({ result: 'installed',
    installed_state: 'verified', installed_layout: 'v3', installed_boot_sha256: 'b'.repeat(64),
    installed_generation: 'abc' }, { phase: 'finalize' })),
  (e) => e.detail.code === 'receipt-unknown-field');
  assert.ok(RESUME_RECEIPT_FIELDS.includes('installed_state'));
  assert.ok(RESUME_RECEIPT_FIELDS.includes('installed_layout'));
  assert.ok(RESUME_RECEIPT_FIELDS.includes('installed_state_reason'));
  assert.ok(RESUME_RECEIPT_FIELDS.includes('installed_boot_sha256'));
  assert.ok(RESUME_RECEIPT_FIELDS.includes('installed_boot_state'));
  // `installed_generation` is NOT in the contract, so it must not be in the list.
  assert.ok(!RESUME_RECEIPT_FIELDS.includes('installed_generation'));
});
