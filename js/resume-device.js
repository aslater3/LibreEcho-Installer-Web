// Authoritative resume reconciliation: what the DEVICE says, not what the
// browser journal hoped.
//
// The resume journal (`resume.js`) is a hint written by a browser tab about a
// transaction that was in progress. It is never an authority. The device's own
// durable guard — /cache/libreecho-direct/transaction.state, written by the
// shipped helper with `guard_write` BEFORE each mutation — is the authority for
// which phases already happened, and the device layout plus the helper's own
// device digest are the authority for whether it is the same device.
//
// Earlier versions derived the resume point from `journal.phase`. That is a
// browser-tab claim: it can be stale, it can be ahead (written before the
// mutation that then failed), and it can be behind (a phase that completed but
// whose journal write never landed). Reading a phase skip from it can therefore
// skip a GPT reshape that never ran, or skip a finalize that did, or - worst -
// re-enter `initialize` and format userdata a second time.
//
// Everything in this module is read-only. It reads exactly two fixed files, runs
// exactly one fixed identity probe derived from the shipped helper's own
// `compute_device_digest` recipe, and writes nothing. Every refusal carries a
// stable `code` so the caller can say what blocked it without parsing prose.

import { StageError, RecoveryStopped } from "./stages.js";
import { sha256Bytes } from "./sha256.js";

/** The one fixed state dir. Nothing else is ever read. */
export const RESUME_STATE_DIR = "/cache/libreecho-direct";
export const RESUME_GUARD_NAME = "transaction.state";
export const RESUME_RECEIPT_NAME = "receipt";

/** A guard or receipt is a handful of short lines; 16 KiB is generous. */
export const RESUME_CONTROL_READ_LIMIT_BYTES = 16 * 1024;

/**
 * Shell exit marker. Each probe prints `__LIBREECHO_RESUME_RC__<n>` BEFORE any
 * body and `__LIBREECHO_RESUME_END__` after it, so "absent" (rc 2) is
 * distinguishable from "unreadable" (rc 92), "oversize" (rc 93) and "the path is
 * a symlink" (rc 91). Exit status of the transport is not evidence of anything:
 * every read is bounded and framed so a truncated stream cannot be mistaken for
 * an empty file.
 */
export const RESUME_EXIT_MARKER = "__LIBREECHO_RESUME_RC__";
export const RESUME_END_MARKER = "__LIBREECHO_RESUME_END__";

/** Guard schema this reader understands; a newer writer must not be trusted. */
export const RESUME_GUARD_SCHEMA = 1;
/** The helper's `PROTOCOL_SUPPORTED`. The guard records it verbatim. */
export const RESUME_GUARD_PROTOCOL = "2";

/** The helper's `phase_rank` vocabulary, in rank order. */
export const RESUME_GUARD_PHASES = Object.freeze(["prepare", "initialize", "transfer", "finalizing", "finalized"]);
/** The helper's `format_state` vocabulary. `formatting` is an interrupted format. */
export const RESUME_GUARD_FORMAT_STATES = Object.freeze(["absent", "formatting", "formatted"]);
export const RESUME_GUARD_REQUIRED_FIELDS = Object.freeze([
  "protocol", "target", "release", "bundle_manifest_sha256", "device_digest", "format_state", "phase",
]);
export const RESUME_GUARD_OPTIONAL_FIELDS = Object.freeze(["schema"]);

/**
 * Every key the shipped helper can write into a receipt, plus the five binding
 * keys `receipt_body` always emits and the identity keys `main()` sets. An
 * unknown key means a helper this reader does not understand, which is a
 * refusal, not a field to ignore.
 *
 * This list is read off the helper's current `receipt_set` call sites, not
 * remembered. Two things changed when the helper gained transaction rollover and
 * the v3 installed-state readback:
 *
 *   * `staging` is GONE. It had no producer anywhere in the helper, so the old
 *     list accepted a key no helper writes — and, worse, a reader that trusted
 *     the list could not tell a real receipt from a fabricated one.
 *   * the rollover and readback keys are present: `archived_transaction`,
 *     `would_rollover_transaction`, `rolled_over_from`, `rolled_over_phase`,
 *     `rolled_over_format_state`, `installed_state`, `installed_boot_state`,
 *     `installed_layout`, `installed_state_reason`, `installed_boot_sha256`.
 *
 * A real receipt from the current helper therefore parses; a receipt carrying
 * anything not named here is still refused.
 */
export const RESUME_RECEIPT_FIELDS = Object.freeze([
  // The five binding keys `receipt_body` emits, plus main()'s identity keys.
  "protocol", "phase", "invocation_id", "bundle_manifest_sha256", "invocation_sha256",
  "target", "release", "device_digest", "result", "error",
  // Per-phase `receipt_set` fields.
  "target_check", "reboot_required", "userdata_sectors", "userdata_first", "userdata_last",
  "would_write", "format_state", "data_mount", "transfer_bytes_total", "transfer_need_bytes",
  "incoming_dir", "free_bytes", "hardlinked", "features", "local_package",
  "boot_a_sha256", "boot_b_sha256", "validated",
  // Transaction rollover (prepare archiving a finalized predecessor).
  "archived_transaction", "would_rollover_transaction",
  "rolled_over_from", "rolled_over_phase", "rolled_over_format_state",
  // Installed-state readback for a finalized guard.
  "installed_state", "installed_boot_state", "installed_layout",
  "installed_state_reason", "installed_boot_sha256",
]);
export const RESUME_RECEIPT_REQUIRED_FIELDS = Object.freeze([
  "protocol", "phase", "invocation_id", "bundle_manifest_sha256", "invocation_sha256", "result",
]);

/** Layout constants, taken from the shipped helper's own configuration. */
export const RESUME_BOOT_SLOT_SECTORS = 32768;
export const RESUME_USERDATA_CONTRACT_SECTORS = Object.freeze([2137088, 2153472]);

/** The helper's own mount defaults, so the mount probe reads what it reads. */
export const RESUME_DATA_MOUNT_POINT = "/data";
export const RESUME_MOUNTS_FILE = "/proc/mounts";

/** What this module can authorise. Everything else is a refusal. */
export const RESUME_NEXT_PHASES = Object.freeze(["prepare", "initialize", "transfer", "payloads", "verify-installed"]);

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const SHELL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const SERIAL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const PART_BASE = /^mmcblk0p[0-9]+$/;
const SECTORS = /^[0-9]{1,12}$/;
const KEY_VALUE = /^([a-z][a-z0-9_]*)=(.*)$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function fail(code, message, detail = null) {
  throw new StageError("install", message, detail === null ? { code } : { code, ...detail });
}

function cleanToken(value, label, code) {
  if (typeof value !== "string" || !SHELL_TOKEN.test(value) || CONTROL.test(value)) {
    fail(code, `refusing a ${label} that is not a plain token: ${JSON.stringify(value ?? null)}`);
  }
  return value;
}

/**
 * The fixed read for ONE control file. `path` is a module constant, never
 * caller input; the shell is written so it cannot be redirected anywhere else.
 *
 * Refuses symlinked components (including /cache itself), refuses a directory
 * that is missing, bounds the read at 16 KiB before it is emitted, and frames
 * the result between the exit marker and the end marker.
 */
function controlReadCommand(file) {
  if (file !== RESUME_GUARD_NAME && file !== RESUME_RECEIPT_NAME) {
    throw new Error(`refusing to read a non-contract control file: ${file}`);
  }
  // Plain single-quoted shell lines joined with newlines. No JS interpolation
  // happens inside the script, so shell `${...}` and `$(...)` are literal.
  return [
    '__d=/cache/libreecho-direct; __p=$__d/' + file + '; __rc=0',
    'for __a in /cache $__d $__p; do',
    '  if [ -L "$__a" ]; then __rc=91; break; fi',
    'done',
    'if [ "$__rc" = 0 ]; then',
    '  if [ ! -d "$__d" ] || [ ! -f "$__p" ]; then',
    '    __rc=2',
    '  else',
    "    __b=$(wc -c < \"$__p\" 2>/dev/null | tr -d ' \\r')",
    '    case "$__b" in',
    "      ''|*[!0-9]*) __rc=92 ;;",
    '      *) if [ "$__b" -gt ' + RESUME_CONTROL_READ_LIMIT_BYTES + ' ]; then __rc=93; fi ;;',
    '    esac',
    '  fi',
    'fi',
    "printf '" + RESUME_EXIT_MARKER + "%s\\n' \"$__rc\"",
    'if [ "$__rc" = 0 ]; then cat "$__p" 2>/dev/null; fi',
    "printf '" + RESUME_END_MARKER + "\\n'",
  ].join("\n");
}

/** The exact fixed read for the guard. */
export const RESUME_GUARD_READ_COMMAND = controlReadCommand(RESUME_GUARD_NAME);
/** The exact fixed read for the receipt. */
export const RESUME_RECEIPT_READ_COMMAND = controlReadCommand(RESUME_RECEIPT_NAME);

/**
 * The identity + layout probe. It reproduces the shipped helper's own recipes:
 *
 *   * `partition_node` reduced to the part that decides an answer from sysfs - a
 *     by-name link must resolve to an `mmcblk0pN` node whose own `PARTNAME` is
 *     the requested partition;
 *   * `compute_device_digest`: serial from `getprop ro.serialno` then
 *     `ro.boot.serialno`, the userdata partition's own GPT unique GUID, and
 *     sha256 over `target=<t>\nserial=<s>\nuserdata_guid=<g>\n`;
 *   * `partition_sectors`: `cat /sys/class/block/<base>/size`.
 *
 * Nothing is written, no helper is invoked, and no payload is touched.
 */
export function resumeDeviceProbeCommand(target) {
  cleanToken(target, "probe target", "probe-target-unsafe");
  return [
    '__sys=/sys/class/block; __by=/dev/block/by-name; __disk=/dev/block/mmcblk0; __rc=0',
    '__pname() {',
    '  __w=$1',
    '  __n=$(readlink -f "$__by/$__w" 2>/dev/null)',
    '  case "$__n" in',
    '    */mmcblk0p*) __b=${__n##*/} ;;',
    "    *) printf ''; return 1 ;;",
    '  esac',
    '  case "$__b" in',
    '    mmcblk0p[0-9]*) ;;',
    "    *) printf ''; return 1 ;;",
    '  esac',
    "  __got=$(sed -n 's/^PARTNAME=//p' \"$__sys/$__b/uevent\" 2>/dev/null | head -n 1)",
    '  [ "$__got" = "$__w" ] || { printf ""; return 1; }',
    '  printf "%s" "$__b"',
    '}',
    '__a=$(__pname boot_a); __b=$(__pname boot_b); __ud=$(__pname userdata)',
    'if [ -z "$__a" ] || [ -z "$__b" ] || [ -z "$__ud" ]; then __rc=12; fi',
    'if [ "$__rc" = 0 ]; then',
    '  __part=${__ud#mmcblk0p}',
    '  case "$__part" in',
    "    ''|*[!0-9]*) __rc=12 ;;",
    "    *) __guid=$(/sbin/sgdisk --info=\"$__part\" \"$__disk\" 2>/dev/null | sed -n 's/^Partition unique GUID: \\(.*\\)$/\\1/p' | head -n 1)",
    '       [ -n "$__guid" ] || __rc=11 ;;',
    '  esac',
    'fi',
    'if [ "$__rc" = 0 ]; then',
    '  __serial=$(getprop ro.serialno 2>/dev/null)',
    '  [ -n "$__serial" ] || __serial=$(getprop ro.boot.serialno 2>/dev/null)',
    '  [ -n "$__serial" ] || __rc=10',
    'fi',
    'if [ "$__rc" = 0 ]; then',
    "  __dg=$(printf 'target=%s\\nserial=%s\\nuserdata_guid=%s\\n' '" + target + "' \"$__serial\" \"$__guid\" | /sbin/sha256sum 2>/dev/null | awk '{ print $1 }')",
    '  case "$__dg" in',
    "    ''|*[!0-9a-f]*) __rc=13 ;;",
    '    *) [ "${#__dg}" -eq 64 ] || __rc=13 ;;',
    '  esac',
    'fi',
    "printf '" + RESUME_EXIT_MARKER + "%s\\n' \"$__rc\"",
    'if [ "$__rc" = 0 ]; then',
    '  printf "serial=%s\\n" "$__serial"',
    '  printf "userdata_guid=%s\\n" "$__guid"',
    '  printf "device_digest=%s\\n" "$__dg"',
    '  printf "node_boot_a=%s\\n" "$__a"',
    '  printf "node_boot_b=%s\\n" "$__b"',
    '  printf "node_userdata=%s\\n" "$__ud"',
    '  printf "sectors_boot_a=%s\\n" "$(cat "$__sys/$__a/size" 2>/dev/null | tr -d \' \\r\')"',
    '  printf "sectors_boot_b=%s\\n" "$(cat "$__sys/$__b/size" 2>/dev/null | tr -d \' \\r\')"',
    '  printf "sectors_userdata=%s\\n" "$(cat "$__sys/$__ud/size" 2>/dev/null | tr -d \' \\r\')"',
    'fi',
    "printf '" + RESUME_END_MARKER + "\\n'",
  ].join("\n");
}

/**
 * Splits a framed probe reply into `{ rc, body }`, or null when the framing is
 * not intact.
 *
 * Transport output may carry noise before the exit marker, so the markers are
 * located rather than anchored. What must hold: exactly one of each marker, the
 * exit marker at the start of a line with a newline-terminated rc, the end
 * marker at the start of its own line, and nothing but whitespace after it. A
 * truncated stream therefore fails closed instead of looking like an empty file.
 */
export function parseFramedProbe(text) {
  const value = String(text ?? "");
  const rcAt = value.indexOf(RESUME_EXIT_MARKER);
  const endAt = value.indexOf(RESUME_END_MARKER);
  if (rcAt < 0 || endAt < 0 || endAt <= rcAt) return null;
  if (value.indexOf(RESUME_EXIT_MARKER, rcAt + 1) !== -1) return null;
  if (value.indexOf(RESUME_END_MARKER, endAt + 1) !== -1) return null;
  if (endAt > 0 && value[endAt - 1] !== "\n") return null;
  if (!/^\s*$/.test(value.slice(endAt + RESUME_END_MARKER.length))) return null;
  const afterMarker = value.slice(rcAt + RESUME_EXIT_MARKER.length);
  const head = /^(\d+)\r?\n/.exec(afterMarker);
  if (!head) return null;
  const bodyStart = rcAt + RESUME_EXIT_MARKER.length + head[0].length;
  return { rc: Number(head[1]), body: value.slice(bodyStart, endAt) };
}

const CONTROL_RC = {
  0: "present",
  2: "absent",
  91: "symlink-refused",
  92: "size-unreadable",
  93: "oversize",
};

/** Strict key/value parse. Duplicates, unknown keys and missing required keys all fail. */
function parseKeyValue(body, { allowed, required, label }) {
  const fields = Object.create(null);
  const seen = [];
  for (const raw of String(body).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const match = KEY_VALUE.exec(line);
    if (!match) fail(`${label}-malformed`, `the ${label} has a line that is not key=value: ${JSON.stringify(line.slice(0, 60))}`);
    const [, key, value] = match;
    if (Object.hasOwn(fields, key)) fail(`${label}-duplicate-field`, `the ${label} repeats the field ${key}`);
    if (!allowed.includes(key)) fail(`${label}-unknown-field`, `the ${label} carries the unknown field ${key}`);
    if (CONTROL.test(value)) fail(`${label}-malformed`, `the ${label} field ${key} carries a control character`);
    fields[key] = value;
    seen.push(key);
  }
  for (const key of required) {
    if (!Object.hasOwn(fields, key)) fail(`${label}-missing-field`, `the ${label} has no ${key} field`);
  }
  return fields;
}

function requireHex64(value, label, field, code) {
  const lower = String(value ?? "").toLowerCase();
  if (!HEX64.test(lower)) fail(code, `the ${label} ${field} is not a sha256 digest`);
  return lower;
}

const DECIMAL = /^(0|[1-9][0-9]{0,11})$/;
const FLAG = Object.freeze(["0", "1"]);
/** The helper's `installed_state` vocabulary (receipt_installed_state). */
const INSTALLED_STATES = Object.freeze(["verified", "mismatch", "unmounted", "unknown"]);
/** The helper's `installed_boot_state` vocabulary (installed_boot_state). */
const INSTALLED_BOOT_STATES = Object.freeze(["match", "mismatch", "unknown"]);
/** The helper's `installed_layout` vocabulary. */
const INSTALLED_LAYOUTS = Object.freeze(["v3", "legacy"]);
/** `validated` is emitted only by a finalize dry run, and only as `full`. */
const VALIDATED = Object.freeze(["full"]);
/** The helper's `target_check` vocabulary: match, override or unknown. */
const TARGET_CHECKS = Object.freeze(["match", "override", "unknown"]);

/**
 * The V3-CONTRACT §7.2 `installed_state_reason` vocabulary, transcribed from the
 * contract table and from every `INSTALLED_REASON=` assignment and readback
 * `printf` in the shipped helper. §7.2 is explicit that a NEW token must be added
 * to the contract when it appears, so a token not named here means this reader
 * does not understand the helper's vocabulary — and it is refused rather than
 * echoed into an operator-facing message, because the token is a value that
 * reaches the UI.
 *
 * Every token is `<name>` or `<name>:<detail>`; the detail is a boot slot, a
 * feature id, a mount source or a filesystem type, and it is checked as a
 * non-empty, single-segment value so a token cannot smuggle a newline, a path
 * traversal or a second colon-delimited field into the message.
 */
const INSTALLED_REASON_TOKENS = Object.freeze([
  // /data could not be read at all (installed_data_mount_state).
  "data-not-mounted", "userdata-node-unresolved", "data-mounted-from-wrong-node", "data-mount-fstype",
  // Nothing was ever installed.
  "no-installed-record",
  // The v3 generation pointer and tree.
  "generations-missing", "generations-path-symlink", "generation-missing", "generation-path-symlink",
  "generation-file-missing", "generation-file-set", "generation-unreadable",
  "current-pointer-unreadable", "current-pointer-unsafe",
  // The installed manifest is the authority.
  "manifest-unreadable", "not-a-v3-generation", "manifest-transaction-mismatch",
  "manifest-board-mismatch", "manifest-feature-set", "manifest-boot-digest",
  "manifest-not-this-bundle", "signature-not-this-bundle", "feature-digest",
  // The COMPLETE marker and per-feature pins.
  "complete-digest-mismatch", "feature-pin-missing", "feature-dir-missing", "feature-path-symlink",
  "feature-payload-missing", "feature-payload-digest", "feature-manifest-missing",
  "feature-manifest-digest", "feature-asset-unsafe", "feature-manifest-asset-unsafe",
  // The legacy staging tree.
  "staged-manifest-missing", "staging-path-symlink",
  // The boot half.
  "boot-pin-missing", "boot-slot-digest", "partition-unresolved", "partition-not-block",
]);
/** Validate readback evidence as one observation, not independent optional claims. */
function validateInstalledEvidence(fields) {
  const has = key => Object.hasOwn(fields, key);
  const invalid = () => fail("receipt-malformed", "the installed-state evidence is incomplete or inconsistent");
  const keys = ["installed_layout", "installed_boot_sha256", "installed_boot_state", "installed_state_reason"];
  if (!has("installed_state")) {
    if (keys.some(has)) invalid();
    return;
  }
  const state = fields.installed_state;
  if (!INSTALLED_STATES.includes(state)) invalid();
  if (state === "verified") {
    if (!has("installed_layout") || !has("installed_boot_sha256")
      || has("installed_boot_state") || has("installed_state_reason")) invalid();
    return;
  }
  if (!has("installed_boot_state") || !has("installed_state_reason") || has("installed_boot_sha256")) invalid();
  if ((state === "unknown" || state === "unmounted") && has("installed_layout")) invalid();
  const reason = fields.installed_state_reason;
  const [token, detail, extra] = reason.split(":");
  if (!INSTALLED_REASON_TOKENS.includes(token) || extra !== undefined) invalid();
  const slotTokens = ["boot-slot-digest", "partition-unresolved", "partition-not-block"];
  const featureTokens = ["feature-digest", "feature-pin-missing", "feature-dir-missing", "feature-path-symlink",
    "feature-payload-missing", "feature-payload-digest", "feature-manifest-missing", "feature-manifest-digest"];
  const pathTokens = ["data-mounted-from-wrong-node", "feature-asset-unsafe", "feature-manifest-asset-unsafe"];
  if (slotTokens.includes(token)) {
    if (!["boot_a", "boot_b"].includes(detail)) invalid();
  } else if (featureTokens.includes(token) || token === "data-mount-fstype") {
    if (!detail || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(detail)) invalid();
  } else if (pathTokens.includes(token)) {
    if (!detail || detail.length > 512 || !/^[A-Za-z0-9/._+~-]+$/.test(detail)
      || detail.split("/").some(part => part === "." || part === "..")) invalid();
  } else if (detail !== undefined) invalid();
  if (state === "unknown" && token !== "no-installed-record") invalid();
  if (state === "unmounted" && !["data-not-mounted", "userdata-node-unresolved",
    "data-mounted-from-wrong-node", "data-mount-fstype"].includes(token)) invalid();
}

function oneOf(value, allowed, label, field) {
  if (!allowed.includes(value)) {
    fail("receipt-malformed", `the receipt ${field} is ${JSON.stringify(value)}, not one of ${allowed.join("/")}`);
  }
  return value;
}

function optionalToken(value, label, code) {
  if (typeof value !== "string" || !SHELL_TOKEN.test(value) || CONTROL.test(value)) {
    fail(code, `refusing a ${label} that is not a plain token: ${JSON.stringify(value ?? null)}`);
  }
  return value;
}

/**
 * The helper's `validate_place_paths` safe-name shape for a path-y value:
 * never empty, never hidden, never a path traversal. `/data/...` values are
 * absolute on purpose (they come from the helper's own DATA root), so the
 * archive-name form `<release>-<sha>-<digest>.state` is what is checked here.
 */
function optionalArchiveName(value) {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*-[0-9a-f]{64}-[0-9a-f]{64}\.state$/.test(value)) {
    fail("receipt-malformed", `the receipt archive name is not a guard_archive_name: ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalHex64(value, field) {
  if (!HEX64.test(String(value ?? "").toLowerCase())) {
    fail("receipt-malformed", `the receipt ${field} is not a sha256 digest`);
  }
  return String(value).toLowerCase();
}

function optionalDecimal(value, field) {
  if (!DECIMAL.test(String(value ?? ""))) {
    fail("receipt-malformed", `the receipt ${field} is not a decimal count: ${JSON.stringify(value)}`);
  }
  return Number(value);
}

/**
 * Parses /cache/libreecho-direct/receipt. The receipt is overwritten every phase.
 *
 * Every known field is format-checked against the value the helper's own recipe
 * produces, because these fields are EVIDENCE: `reboot_required` tells the caller
 * to reboot, `boot_a_sha256`/`boot_b_sha256` are the installed-image pins, and the
 * `installed_*` set is the v3 readback a finalized guard is judged by. Accepting
 * any string in those keys would let a fabricated receipt satisfy a gate.
 */
export function parseResumeReceipt(body) {
  const fields = parseKeyValue(body, {
    allowed: RESUME_RECEIPT_FIELDS,
    required: RESUME_RECEIPT_REQUIRED_FIELDS,
    label: "receipt",
  });
  validateInstalledEvidence(fields);
  const has = (key) => Object.hasOwn(fields, key);
  const opt = (key) => (has(key) ? fields[key] : null);
  const optOneOf = (key, allowed) => (has(key) ? oneOf(fields[key], allowed, "receipt", key) : null);
  const optDecimal = (key) => (has(key) ? optionalDecimal(fields[key], key) : null);
  const optHex = (key) => (has(key) ? optionalHex64(fields[key], key) : null);
  // `invocation_id` is validated by the helper itself (`hex64`) and BLANKED when
  // it is not one, so an empty or non-hex id means the receipt was never bound to
  // a browser invocation. It is kept verbatim here and judged by the caller.
  const invocationId = has("invocation_id") ? fields.invocation_id : null;
  if (invocationId !== null && (CONTROL.test(invocationId) || invocationId.length > 64)) {
    fail("receipt-malformed", `the receipt invocation_id is not a usable nonce: ${JSON.stringify(invocationId)}`);
  }
  return {
    protocol: fields.protocol,
    phase: fields.phase,
    result: fields.result,
    error: opt("error"),
    invocationId,
    invocationSha256: optionalHex64(fields.invocation_sha256, "invocation_sha256"),
    bundleManifestSha256: requireHex64(fields.bundle_manifest_sha256, "receipt", "bundle_manifest_sha256", "receipt-malformed"),
    deviceDigest: has("device_digest") ? requireHex64(fields.device_digest, "receipt", "device_digest", "receipt-malformed") : null,
    target: has("target") ? optionalToken(fields.target, "receipt target", "receipt-malformed") : null,
    release: has("release") ? optionalToken(fields.release, "receipt release", "receipt-malformed") : null,
    // Evidence the caller acts on.
    rebootRequired: has("reboot_required") ? oneOf(fields.reboot_required, FLAG, "receipt", "reboot_required") === "1" : null,
    formatState: optOneOf("format_state", RESUME_GUARD_FORMAT_STATES),
    targetCheck: optOneOf("target_check", TARGET_CHECKS),
    validated: optOneOf("validated", VALIDATED),
    dataMount: opt("data_mount"),
    bootASha256: optHex("boot_a_sha256"),
    bootBSha256: optHex("boot_b_sha256"),
    installedState: optOneOf("installed_state", INSTALLED_STATES),
    installedBootState: optOneOf("installed_boot_state", INSTALLED_BOOT_STATES),
    installedLayout: optOneOf("installed_layout", INSTALLED_LAYOUTS),
    installedStateReason: opt("installed_state_reason"),
    installedBootSha256: optHex("installed_boot_sha256"),
    // Rollover evidence: which finalized transaction prepare archived or would
    // archive, and what it was in before the rollover.
    archivedTransaction: has("archived_transaction") ? optionalArchiveName(fields.archived_transaction) : null,
    wouldRolloverTransaction: has("would_rollover_transaction") ? optionalArchiveName(fields.would_rollover_transaction) : null,
    rolledOverFrom: has("rolled_over_from") ? optionalToken(fields.rolled_over_from, "receipt rolled_over_from", "receipt-malformed") : null,
    rolledOverPhase: optOneOf("rolled_over_phase", RESUME_GUARD_PHASES),
    rolledOverFormatState: optOneOf("rolled_over_format_state", RESUME_GUARD_FORMAT_STATES),
    // Counts, kept for the caller's free-space and geometry reporting.
    userdataSectors: optDecimal("userdata_sectors"),
    userdataFirst: optDecimal("userdata_first"),
    userdataLast: optDecimal("userdata_last"),
    transferBytesTotal: optDecimal("transfer_bytes_total"),
    transferNeedBytes: optDecimal("transfer_need_bytes"),
    freeBytes: optDecimal("free_bytes"),
    hardlinked: optDecimal("hardlinked"),
  };
}

/**
 * Parses /cache/libreecho-direct/transaction.state. Accepts the shipped helper's
 * legacy field set plus an optional `schema=1`; anything else is refused so a
 * newer or foreign writer cannot authorise a skip.
 */
export function parseResumeGuard(body) {
  const fields = parseKeyValue(body, {
    allowed: [...RESUME_GUARD_REQUIRED_FIELDS, ...RESUME_GUARD_OPTIONAL_FIELDS],
    required: RESUME_GUARD_REQUIRED_FIELDS,
    label: "guard",
  });
  if (Object.hasOwn(fields, "schema") && fields.schema !== String(RESUME_GUARD_SCHEMA)) {
    fail("guard-schema-unsupported", `the guard declares schema=${JSON.stringify(fields.schema)}; this reader only understands schema=${RESUME_GUARD_SCHEMA}`);
  }
  const guard = {
    schema: Object.hasOwn(fields, "schema") ? RESUME_GUARD_SCHEMA : null,
    protocol: fields.protocol,
    target: cleanToken(fields.target, "guard target", "guard-malformed"),
    release: cleanToken(fields.release, "guard release", "guard-malformed"),
    bundleManifestSha256: requireHex64(fields.bundle_manifest_sha256, "guard", "bundle_manifest_sha256", "guard-malformed"),
    deviceDigest: requireHex64(fields.device_digest, "guard", "device_digest", "guard-malformed"),
    formatState: fields.format_state,
    phase: fields.phase,
  };
  if (guard.protocol !== RESUME_GUARD_PROTOCOL) {
    fail("guard-protocol-mismatch", `the guard records protocol=${JSON.stringify(guard.protocol)}, not ${RESUME_GUARD_PROTOCOL}`);
  }
  if (!RESUME_GUARD_FORMAT_STATES.includes(guard.formatState)) {
    fail("guard-format-state-corrupt", `the guard names an unknown format_state ${JSON.stringify(guard.formatState)}`);
  }
  if (!RESUME_GUARD_PHASES.includes(guard.phase)) {
    fail("guard-phase-corrupt", `the guard names an unknown phase ${JSON.stringify(guard.phase)}`);
  }
  return guard;
}

function checkCancel(isCancelled) {
  if (isCancelled?.()) throw new RecoveryStopped();
}

async function runShell(adb, command, code) {
  let result;
  try {
    result = await adb.shell(command);
  } catch (error) {
    fail(code, `the device refused the ${error?.message ? "probe" : "probe"}: ${error?.message ?? error}`, { command: undefined });
  }
  return String(result?.stdout ?? "");
}

/** Reads one fixed control file. Returns `{ present, fields, code }`. */
async function readControl(adb, file, command, isCancelled) {
  checkCancel(isCancelled);
  const framed = parseFramedProbe(await runShell(adb, command, "control-read-failed"));
  checkCancel(isCancelled);
  if (!framed) fail("control-unterminated", `the read of ${RESUME_STATE_DIR}/${file} did not carry a complete exit marker`);
  const code = CONTROL_RC[framed.rc] ?? "control-read-failed";
  if (framed.rc !== 0) {
    if (framed.rc === 2) return { present: false, fields: null, code };
    fail(code, `${RESUME_STATE_DIR}/${file} could not be read safely (${code})`);
  }
  // Byte length, not `String.prototype.length`: this runs in a BROWSER, where
  // `Buffer` does not exist, and a UTF-16 code-unit count would undercount every
  // multi-byte character in the body. TextEncoder is the web-standard byte
  // measure and is what the rest of this codebase already uses.
  if (new TextEncoder().encode(framed.body).byteLength > RESUME_CONTROL_READ_LIMIT_BYTES) {
    fail("control-oversize", `${RESUME_STATE_DIR}/${file} exceeded the ${RESUME_CONTROL_READ_LIMIT_BYTES}-byte read bound`);
  }
  return { present: true, fields: framed.body, code };
}

/**
 * The bounded, read-only /data mount probe.
 *
 * Writing into /data while it is not mounted writes into recovery's own ramfs:
 * the copies succeed, the digests read back and the whole tree is gone at boot.
 * The shipped helper's `verify_data_mount` refuses that, and so does this — with
 * no way to mount anything, because mounting is a mutation and this module
 * never mutates.
 *
 * It reads the helper's own `MOUNTS` file (`/proc/mounts`), reports EVERY /data
 * entry it finds plus the count, and resolves the mount source through
 * `readlink -f` exactly as the helper's `part_node` does, so the caller can
 * compare it against the userdata node the identity probe measured. Exactly one
 * /data entry is required: a stack of two is ambiguous and therefore refused
 * rather than guessed at. Framed like every other read, so a truncated stream
 * cannot look like an empty mount table.
 */
export function resumeDataMountCommand() {
  return [
    `__m=${RESUME_MOUNTS_FILE}; __d=${RESUME_DATA_MOUNT_POINT}; __rc=0`,
    // /proc/mounts is a kernel-provided symlink to self/mounts on Linux.
    `if [ ! -f "$__m" ] || [ ! -r "$__m" ]; then __rc=92; fi`,
    'if [ "$__rc" = 0 ]; then',
    "  __lines=$(awk -v d=\"$__d\" '$2 == d { print }' \"$__m\" 2>/dev/null | head -n 2)",
    '  [ -n "$__lines" ] || __rc=2',
    'fi',
    'if [ "$__rc" = 0 ]; then',
    "  __n=$(printf '%s\\n' \"$__lines\" | wc -l | tr -d ' \\r')",
    '  case "$__n" in',
    "    '1') : ;;",
    "    *) __rc=20 ;;",
    '  esac',
    'fi',
    "printf '" + RESUME_EXIT_MARKER + "%s\\n' \"$__rc\"",
    'if [ "$__rc" = 0 ]; then',
    "  printf 'data_entries=%s\\n' \"$__n\"",
    // One line only, so every field below comes from the SAME entry the count
    // admitted. `$2` is the mount point, `$3` the fstype, `$4` the options.
    '  __row=$(printf \'%s\\n\' "$__lines" | head -n 1)',
    "  __src=$(printf '%s\\n' \"$__row\" | awk '{ print $1 }')",
    "  __fs=$(printf '%s\\n' \"$__row\" | awk '{ print $3 }')",
    "  __opts=$(printf '%s\\n' \"$__row\" | awk '{ print $4 }')",
    // part_node: readlink -f, falling back to the literal path. An ABSOLUTE
    // source is what a real mount table carries and what gets resolved; a
    // relative one (`rootfs`) is reported verbatim, because resolving it would
    // silently produce a path under the caller's own cwd.
    "  case \"$__src\" in",
    "    /*) __node=$(readlink -f \"$__src\" 2>/dev/null || printf '%s' \"$__src\") ;;",
    "    *) __node=$__src ;;",
    "  esac",
    "  printf 'data_source=%s\\n' \"$__node\"",
    "  printf 'data_raw_source=%s\\n' \"$__src\"",
    "  printf 'data_fstype=%s\\n' \"$__fs\"",
    "  printf 'data_opts=%s\\n' \"$__opts\"",
    'fi',
    "printf '" + RESUME_END_MARKER + "\\n'",
  ].join("\n");
}

function probeLayout(fields) {
  const node = (name) => {
    const value = fields[name];
    if (typeof value !== "string" || !PART_BASE.test(value)) {
      fail("layout-unreadable", `the device reported no usable ${name} partition node`);
    }
    return value;
  };
  const sectors = (name) => {
    const value = fields[name];
    if (typeof value !== "string" || !SECTORS.test(value) || Number(value) <= 0) {
      fail("layout-unreadable", `the device reported no usable ${name} sector count`);
    }
    return Number(value);
  };
  return {
    bootA: sectors("sectors_boot_a"),
    bootB: sectors("sectors_boot_b"),
    userdata: sectors("sectors_userdata"),
    nodeBootA: node("node_boot_a"),
    nodeBootB: node("node_boot_b"),
    nodeUserdata: node("node_userdata"),
    userdataGuid: typeof fields.userdata_guid === "string" && fields.userdata_guid ? fields.userdata_guid : null,
    serial: typeof fields.serial === "string" && fields.serial ? fields.serial : null,
  };
}

const MOUNT_RC = {
  0: "present",
  2: "data-mount-absent",
  20: "data-mount-ambiguous",
  92: "data-mounts-unreadable",
};

/**
 * Reads /proc/mounts through the fixed probe and decides whether payloads may be
 * written into /data at all.
 *
 * The test is on the mount table's own VALUES, never on the probe's exit status:
 * the helper's own comment records why (awk exits 0 even when it printed nothing).
 * Four facts must hold together, and each one is a refusal on its own:
 *
 *   * the mount source resolves to the SAME node the identity probe measured for
 *     userdata — a /data mounted from another partition (or from recovery's own
 *     ramfs, or `rootfs`) would take every write and lose it at boot;
 *   * the filesystem is ext4, the format the helper writes;
 *   * the options include `rw`;
 *   * exactly one /data entry exists.
 */
async function requireDataMount(adb, layout, isCancelled) {
  checkCancel(isCancelled);
  const framed = parseFramedProbe(await runShell(adb, resumeDataMountCommand(), "data-mount-unproven"));
  checkCancel(isCancelled);
  if (!framed) fail("data-mount-unproven", "the /data mount probe did not carry a complete exit marker");
  if (framed.rc !== 0) {
    const code = MOUNT_RC[framed.rc] ?? "data-mount-unproven";
    fail(code, `${RESUME_DATA_MOUNT_POINT} is not a proven writable userdata mount (${code}): payload writes would not survive a reboot`);
  }
  // A probe that claims rc=0 but carries no usable evidence is NOT proof. This
  // is the helper's own recorded trap (awk exits 0 even when it printed nothing),
  // so the reply is judged on its values and an unusable one is unproven rather
  // than a malformed-detail leak. The underlying code rides along in the detail.
  let mount;
  try {
    mount = parseKeyValue(framed.body, {
      allowed: ["data_entries", "data_source", "data_raw_source", "data_fstype", "data_opts"],
      required: ["data_entries", "data_source", "data_raw_source", "data_fstype", "data_opts"],
      label: "data-mount",
    });
  } catch (error) {
    fail("data-mount-unproven", `${RESUME_DATA_MOUNT_POINT} mount evidence is unusable (${error.detail?.code ?? error.message}); it cannot authorise a payload write`,
      { probeCode: error.detail?.code ?? null });
  }
  if (mount.data_entries !== "1") {
    fail("data-mount-ambiguous", `${RESUME_DATA_MOUNT_POINT} has ${mount.data_entries} mount entries; exactly one is required before any write`);
  }
  // The identity probe reports the userdata node by its bare sysfs name
  // (`mmcblk0p49`) while the mount table carries a device PATH. The helper's own
  // `partition_node` resolves a by-name link under /dev/block and returns
  // `/dev/block/<node>`, so that is the only form of the source that means "this
  // is the partition we measured". Comparing a bare basename instead would accept
  // a mount from any path that happens to end in the right name.
  const wanted = `/dev/block/${layout.nodeUserdata}`;
  if (mount.data_source !== wanted) {
    fail("data-mount-wrong-node", `${RESUME_DATA_MOUNT_POINT} is mounted from ${mount.data_source}, not the measured userdata node ${wanted}`);
  }
  if (!PART_BASE.test(layout.nodeUserdata)) {
    fail("data-mount-wrong-node", `${RESUME_DATA_MOUNT_POINT} is mounted from ${mount.data_source}, but the measured userdata node is not a block node`);
  }
  if (mount.data_fstype !== "ext4") {
    fail("data-mount-fstype", `${RESUME_DATA_MOUNT_POINT} is mounted as ${mount.data_fstype}, not ext4`);
  }
  if (!/(^|,)rw(,|$)/.test(mount.data_opts)) {
    fail("data-mount-readonly", `${RESUME_DATA_MOUNT_POINT} is mounted read-only (${mount.data_opts}); a payload write would fail`);
  }
  return { source: mount.data_source, fstype: mount.data_fstype, opts: mount.data_opts };
}

/**
 * `check_device` plus `fingerprint_ok`, from the shipped helper: both boot slots
 * are exactly BOOT_SLOT_SECTORS, and the userdata partition matches one of the
 * contract sizes. The boot-slot check is the same prerequisite for EVERY phase,
 * including prepare; the fingerprint is what says "prepare's reshape is real".
 */
function checkLayout(layout, { requireFingerprint }) {
  if (layout.bootA !== RESUME_BOOT_SLOT_SECTORS || layout.bootB !== RESUME_BOOT_SLOT_SECTORS) {
    fail("layout-mismatch", `the boot slots are ${layout.bootA}/${layout.bootB} sectors, not ${RESUME_BOOT_SLOT_SECTORS}: the layout this run must work on is not present`);
  }
  const fingerprint = RESUME_USERDATA_CONTRACT_SECTORS.includes(layout.userdata);
  if (requireFingerprint && !fingerprint) {
    fail("layout-mismatch", `userdata is ${layout.userdata} sectors, which is not a contract size (${RESUME_USERDATA_CONTRACT_SECTORS.join(" or ")}): the prepare reshape is not there to be skipped past`);
  }
  return fingerprint;
}

/**
 * The shipped helper's `receipt_invocation`, recomputed in the browser:
 *   printf '%s' "$PROTOCOL|$PHASE|$BUNDLE_MANIFEST_SHA256|$DEVICE_DIGEST|$TARGET|$RELEASE" | sha256sum
 * Note `printf '%s'`: the hashed input has NO trailing newline.
 *
 * `invocation_sha256` is the receipt's self-binding. Every other field in the
 * receipt is a CLAIM about the run that wrote it; this one is checkable, because
 * it is a digest over the receipt's own bindings. Comparing it against the
 * expected bindings is what stops a receipt for a different manifest, device,
 * target, release or protocol from being read as prepare evidence — a receipt
 * whose six binding keys are copied out of a real one but whose digest was
 * pasted in by hand fails here and nowhere else.
 */
async function boundPrepareReceipt(receipt, { manifestSha256, target, release, deviceDigest }) {
  if (!receipt?.present) return { ok: false, why: "the device holds no receipt" };
  let fields;
  try {
    fields = parseResumeReceipt(receipt.fields);
  } catch (error) {
    // An unusable receipt is not evidence. With the guard saying prepare, the
    // refusal below reports the missing evidence instead of the parse error.
    return { ok: false, why: `the stored receipt is unusable (${error.detail?.code ?? error.message})` };
  }
  if (fields.result !== "prepare-ok" && fields.result !== "prepare-noop") {
    return { ok: false, why: `the stored receipt is result=${fields.result} for phase=${fields.phase}` };
  }
  if (fields.phase !== "prepare") return { ok: false, why: `the stored receipt describes the ${fields.phase} phase, not prepare` };
  if (fields.protocol !== RESUME_GUARD_PROTOCOL) return { ok: false, why: `the stored receipt is protocol=${fields.protocol}` };
  // A blank or non-hex `invocation_id` means the helper never bound the receipt to
  // a browser invocation (it validates `hex64` and blanks anything else), so the
  // receipt describes an unbound run and cannot be this browser's prepare.
  if (!/^[0-9a-f]{64}$/.test(String(fields.invocationId ?? ""))) {
    return { ok: false, why: "the stored receipt carries no valid invocation id" };
  }
  if (fields.bundleManifestSha256 !== manifestSha256) return { ok: false, why: "the stored receipt is bound to a different bundle manifest" };
  if (fields.deviceDigest === null) return { ok: false, why: "the stored receipt carries no device digest" };
  if (fields.deviceDigest !== deviceDigest) return { ok: false, why: "the stored receipt is bound to a different device digest" };
  if (fields.target !== target) return { ok: false, why: "the stored receipt names a different target" };
  if (fields.release !== release) return { ok: false, why: "the stored receipt names a different release" };
  const expected = await sha256Bytes(new TextEncoder().encode(
    `${RESUME_GUARD_PROTOCOL}|${fields.phase}|${manifestSha256}|${deviceDigest}|${target}|${release}`,
  ));
  if (fields.invocationSha256 !== expected) {
    return { ok: false, why: "the stored receipt's invocation digest does not recompute from its own bindings" };
  }
  return { ok: true, why: null, receipt: fields };
}

/**
 * Every non-empty journal binding is cross-checked. The journal is never the
 * authority, but a journal that disagrees with the immutable assets is evidence
 * that this resume is not the transaction the device remembers.
 */
function checkJournalBindings(journal, expected) {
  const checks = [];
  const compare = (name, present, wanted, code) => {
    if (present === null || present === undefined || present === "") return;
    if (String(present) !== String(wanted)) {
      fail(code, `the resume journal's ${name} does not match this run`, { field: name });
    }
    checks.push(name);
  };
  compare("bundleManifestSha256", journal?.bundleManifestSha256, expected.manifestSha256, "journal-binding-mismatch");
  compare("target", journal?.target, expected.target, "journal-binding-mismatch");
  compare("releaseTag", journal?.releaseTag, expected.release, "journal-binding-mismatch");
  compare("deviceDigest", journal?.deviceDigest, expected.deviceDigest, "journal-binding-mismatch");
  compare("kaeruHeader", journal?.kaeruHeader, expected.kaeruHeader, "journal-binding-mismatch");
  compare("serialSha256", journal?.serialSha256, expected.serialSha256, "journal-binding-mismatch");
  return checks;
}

/**
 * Reconciles a resume against the device and returns the earliest phase that may
 * still run, or throws a `StageError` with a stable `detail.code`.
 *
 * Returns `{ nextPhase, deviceDigest, guard, receipt, reason, evidence }`:
 *
 *   * `nextPhase` is one of `RESUME_NEXT_PHASES`. `payloads` is the browser push
 *     that must follow the device's `transfer`; `verify-installed` is the
 *     parent's post-finalize slot check, which must run before any repeat of
 *     finalize.
 *   * `guard` is the parsed durable device guard, or `null` when the device has
 *     none.
 *   * `receipt` is the parsed device receipt, or `null`. It is NEVER treated as
 *     durable evidence about an earlier phase: the helper overwrites it on every
 *     invocation.
 *
 * `journal` is optional and only ever corroborating. `browserPrepareAttempted`
 * must be explicitly `false` for the one case that has no guard to read (a fresh
 * transaction, which returns `prepare`); a missing answer is a refusal, because
 * "no browser attempt guard" is exactly the fact that makes prepare safe.
 */
export async function reconcileDeviceResume({
  adb, journal = null, manifestSha256, target, release, serialRaw, kaeruHeader,
  browserPrepareAttempted = null, isCancelled = null,
} = {}) {
  if (typeof adb?.shell !== "function") fail("no-adb-session", "a recovery ADB session is required to reconcile a resume");
  if (typeof manifestSha256 !== "string" || !HEX64.test(manifestSha256.toLowerCase())) {
    fail("bundle-manifest-unpinned", "a hex64 bundle manifest sha256 is required before a resume can be reconciled");
  }
  const manifest = manifestSha256.toLowerCase();
  cleanToken(target, "target", "target-unsafe");
  cleanToken(release, "release", "release-unsafe");
  if (typeof serialRaw !== "string" || !SERIAL_TOKEN.test(serialRaw)) {
    fail("serial-unsafe", "the targeted device serial is required and must be a plain token");
  }
  if (typeof kaeruHeader !== "string" || !HEX32.test(kaeruHeader.toLowerCase())) {
    fail("kaeru-header-unusable", "the verified Kaeru expdb header (32 hex characters) is required");
  }
  const kaeru = kaeruHeader.toLowerCase();

  checkCancel(isCancelled);
  const guardRead = await readControl(adb, RESUME_GUARD_NAME, RESUME_GUARD_READ_COMMAND, isCancelled);
  const receiptRead = await readControl(adb, RESUME_RECEIPT_NAME, RESUME_RECEIPT_READ_COMMAND, isCancelled);
  checkCancel(isCancelled);
  const probe = parseFramedProbe(await runShell(adb, resumeDeviceProbeCommand(target), "device-probe-failed"));
  checkCancel(isCancelled);
  if (!probe) fail("device-probe-unterminated", "the device identity probe did not carry a complete exit marker");
  if (probe.rc !== 0) {
    const code = { 10: "serial-unreadable", 11: "userdata-guid-unreadable", 12: "partition-identity-unresolved", 13: "device-digest-unreadable" }[probe.rc];
    if (!code) fail("device-probe-failed", `the device identity probe failed (rc=${probe.rc})`);
    fail(code, `the device identity probe failed (rc=${probe.rc}): serial, the userdata GPT GUID and its partition node are all required`);
  }
  const probeFields = parseKeyValue(probe.body, {
    allowed: ["serial", "userdata_guid", "device_digest", "node_boot_a", "node_boot_b", "node_userdata",
      "sectors_boot_a", "sectors_boot_b", "sectors_userdata"],
    required: ["serial", "userdata_guid", "device_digest", "node_boot_a", "node_boot_b", "node_userdata",
      "sectors_boot_a", "sectors_boot_b", "sectors_userdata"],
    label: "probe",
  });
  const layout = probeLayout(probeFields);
  const deviceDigest = requireHex64(probeFields.device_digest, "probe", "device_digest", "device-digest-unreadable");
  if (layout.serial !== serialRaw) {
    fail("serial-mismatch", "the device in recovery is not the serial this resume is bound to");
  }

  const expected = {
    manifestSha256: manifest,
    target,
    release,
    deviceDigest,
    kaeruHeader: kaeru,
    serialSha256: await sha256Bytes(new TextEncoder().encode(serialRaw)),
  };
  const journalChecks = checkJournalBindings(journal, expected);

  const evidence = {
    layout,
    journalChecks,
    guardPhase: null,
    guardFormatState: null,
    guardSource: guardRead.present ? "device" : "absent",
    receiptSource: receiptRead.present ? "device" : "absent",
    receiptResult: null,
    dataMount: null,
  };

  if (!guardRead.present) {
    // No durable guard. The device has no memory of a transaction, so the only
    // phase that can be safe is the first one, and only when the browser also has
    // no record of a prepare attempt. A journal naming any other phase is a
    // claim the device does not support.
    if (journal?.phase && journal.phase !== "fresh") {
      fail("guard-missing-after-phase", `the device holds no transaction guard, but the journal claims the ${journal.phase} phase; the journal never authorises a skip`);
    }
    if (journal?.unlockState && journal.unlockState !== "none") {
      fail("guard-missing-after-unlock", "the device holds no transaction guard and an unlock was already submitted; start a fresh, deliberate transaction");
    }
    if (browserPrepareAttempted !== false) {
      fail("guard-missing-prepare-attempted", "the device holds no transaction guard and this browser cannot confirm that no prepare attempt was made; refusing to reshape userdata");
    }
    checkLayout(layout, { requireFingerprint: false });
    return {
      nextPhase: "prepare", deviceDigest, guard: null, receipt: receiptRead.present ? parseResumeReceipt(receiptRead.fields) : null,
      reason: null, evidence: { ...evidence, skippedPhases: [] },
    };
  }

  const guard = parseResumeGuard(guardRead.fields);
  evidence.guardPhase = guard.phase;
  evidence.guardFormatState = guard.formatState;
  if (guard.bundleManifestSha256 !== manifest) {
    fail("guard-binding-mismatch:bundle_manifest_sha256", "the device's transaction guard is bound to a different bundle manifest; it is a different transaction");
  }
  if (guard.target !== target) {
    fail("guard-binding-mismatch:target", `the device's transaction guard names target=${guard.target}, not ${target}`);
  }
  if (guard.release !== release) {
    fail("guard-binding-mismatch:release", `the device's transaction guard names release=${guard.release}, not ${release}`);
  }
  if (guard.deviceDigest !== deviceDigest) {
    fail("guard-device-digest-mismatch", "the device's transaction guard was written for a different device digest; it is not this device's transaction");
  }

  if (guard.formatState === "formatting") {
    fail("guard-format-uncertain", "the device recorded format_state=formatting: a userdata format was interrupted and its outcome is unknown; it is never retried automatically");
  }

  let nextPhase;
  let reason;
  let skippedPhases;
  let dataMount = null;
  if (guard.phase === "prepare") {
    if (guard.formatState !== "absent") {
      fail("guard-phase-state-impossible", `the device's guard says phase=prepare with format_state=${guard.formatState}; that combination is never written`);
    }
    // Guard phase=prepare is written BEFORE the GPT reshape, so on its own it
    // cannot say whether prepare finished. Ambiguous by construction: the reshape
    // either happened or did not. Two independent pieces of evidence are
    // required, and if either is missing this refuses rather than guessing.
    const fingerprint = checkLayout(layout, { requireFingerprint: false });
    const bound = await boundPrepareReceipt(receiptRead, { manifestSha256: manifest, target, release, deviceDigest });
    if (!fingerprint || !bound.ok) {
      const why = !fingerprint
        ? `userdata is ${layout.userdata} sectors, which is not a contract size, and ${bound.why ?? "the prepare receipt is absent"}`
        : bound.why;
      fail("prepare-evidence-incomplete", `the device guard says prepare, but whether the GPT reshape happened cannot be settled from here: ${why}`);
    }
    nextPhase = "initialize";
    reason = null;
    skippedPhases = ["prepare"];
  } else if (guard.phase === "initialize") {
    if (guard.formatState !== "formatted") {
      fail("guard-phase-state-impossible", `the device's guard says phase=initialize with format_state=${guard.formatState}; that combination is never written`);
    }
    checkLayout(layout, { requireFingerprint: true });
    // userdata is already formatted. `initialize` is the only phase that formats,
    // and it is never re-entered. But `transfer` is what writes payloads into
    // /data, so the mount must be proven before this phase is handed to the
    // caller — otherwise the very next phase writes into recovery's ramfs.
    dataMount = await requireDataMount(adb, layout, isCancelled);
    nextPhase = "transfer";
    reason = null;
    skippedPhases = ["prepare", "initialize"];
  } else if (guard.phase === "transfer") {
    if (guard.formatState !== "formatted") {
      fail("guard-phase-state-impossible", `the device's guard says phase=transfer with format_state=${guard.formatState}; that combination is never written`);
    }
    checkLayout(layout, { requireFingerprint: true });
    // `payloads` is the browser push: every byte of it lands in /data.
    dataMount = await requireDataMount(adb, layout, isCancelled);
    nextPhase = "payloads";
    reason = null;
    skippedPhases = ["prepare", "initialize", "transfer"];
  } else if (guard.phase === "finalizing") {
    fail("guard-phase-uncertain:finalizing", "the device recorded phase=finalizing: the boot-slot write started and its outcome is unknown; finalize is not retried automatically");
  } else {
    if (guard.formatState !== "formatted") {
      fail("guard-phase-state-impossible", `the device's guard says phase=finalized with format_state=${guard.formatState}; that combination is never written`);
    }
    checkLayout(layout, { requireFingerprint: true });
    // Finalize is complete and repeatable-free. The parent must verify the slots
    // and the landed files before it believes any of it; it never re-finalizes.
    nextPhase = "verify-installed";
    reason = null;
    skippedPhases = ["prepare", "initialize", "transfer", "finalize"];
  }

  let receipt = null;
  if (receiptRead.present) {
    receipt = parseResumeReceipt(receiptRead.fields);
    evidence.receiptResult = receipt.result;
  }
  evidence.dataMount = dataMount;
  return { nextPhase, deviceDigest, guard, receipt, reason, evidence: { ...evidence, skippedPhases } };
}

// --- an earlier, FINISHED install --------------------------------------------
//
// A finished install leaves `transaction.state` with `phase=finalized`, and the
// shipped helper refuses every new `prepare` over it (`already-finalized`). That
// is right for a resume, but it also blocks a deliberate reinstall, and the old
// page reported it as an unexplained "nonzero exit". These two functions let the
// page say it plainly before anything runs, and, only after the operator chose
// "Erase and reinstall", move the finished record aside. Nothing is deleted: the
// whole state directory is renamed, so its guard, receipt and logs stay on the
// device as evidence. A record that is NOT finalized (an interrupted install) is
// never moved: that is the case the guard exists to protect.

/** Reads and parses the device guard. `null` when the device holds none. */
export async function readTransactionGuard(adb, isCancelled = null) {
  if (typeof adb?.shell !== "function") fail("no-adb-session", "a recovery ADB session is required to read the install record");
  const read = await readControl(adb, RESUME_GUARD_NAME, RESUME_GUARD_READ_COMMAND, isCancelled);
  if (!read.present) return null;
  return parseResumeGuard(read.fields);
}

export const RETIRE_MARKER = "__LIBREECHO_RETIRE__=";

/** The one rename. `stamp` is a plain token chosen by the caller. */
export function retireFinalizedCommand(stamp) {
  cleanToken(stamp, "archive stamp", "retire-stamp-unsafe");
  const dir = RESUME_STATE_DIR;
  const archive = `${RESUME_STATE_DIR}.finalized-${stamp}`;
  return [
    `__d=${dir}; __a=${archive}`,
    `if [ -L "$__d" ] || [ ! -d "$__d" ]; then echo ${RETIRE_MARKER}nodir`,
    `elif [ -e "$__a" ] || [ -L "$__a" ]; then echo ${RETIRE_MARKER}exists`,
    `elif [ -L "$__d/${RESUME_GUARD_NAME}" ] || ! grep -qx 'phase=finalized' "$__d/${RESUME_GUARD_NAME}" 2>/dev/null; then echo ${RETIRE_MARKER}notfinalized`,
    `elif mv "$__d" "$__a" && sync; then echo ${RETIRE_MARKER}ok`,
    `else echo ${RETIRE_MARKER}failed; fi`,
  ].join("\n");
}

/**
 * Moves a FINALIZED state directory aside. Refuses (throws) on anything else.
 * Returns the archive path.
 */
export async function retireFinalizedTransaction(adb, { stamp, isCancelled = null } = {}) {
  checkCancel(isCancelled);
  const guard = await readTransactionGuard(adb, isCancelled);
  if (!guard) fail("retire-no-record", "the Echo holds no install record to move aside");
  if (guard.phase !== "finalized") {
    fail("retire-not-finalized", `the Echo's install record is at ${guard.phase}, not finished; an interrupted install is never erased from here`);
  }
  checkCancel(isCancelled);
  const out = String((await adb.shell(retireFinalizedCommand(stamp)))?.stdout ?? "");
  const match = new RegExp(`${RETIRE_MARKER}([a-z]+)`).exec(out);
  if (!match || match[1] !== "ok") {
    fail(`retire-${match?.[1] ?? "unconfirmed"}`, `the finished install record could not be moved aside (${match?.[1] ?? "no confirmation"})`);
  }
  return `${RESUME_STATE_DIR}.finalized-${stamp}`;
}
