// Browser side of the delivered recovery direct-userdata protocol v2.
//
// The browser verifies the whole release on the computer, extracts the bounded
// self-contained helper from the digest-verified installer ZIP, pushes ONLY the
// helper and the anchor manifest to /cache/libreecho-direct, then drives the
// explicit phases:
//
//   prepare (GPT reshape) -> [reboot] -> initialize (format once)
//     -> transfer (landing zone + free-space gate) -> push payloads to
//        /data/libreecho/incoming -> finalize --dry-run (landed-completely check)
//        -> finalize (boot slots + features; NO format reachable)
//
// There is no bulk /cache staging and no legacy fallback: a bundle without
// protocol 2 is refused before any device mutation. The helper's exit status is
// not the outcome — the receipt is.
//
// Before any phase runs, the page reads the helper's own transaction guard and
// last receipt (read-only) and decides from THEM where the install stands; see
// `classifyDirectTransaction` for the state machine. The browser-side
// localStorage attempt guard is only ever satisfied by a device state that
// proves the earlier attempt's outcome.

import { sha256Blob, sha256Bytes } from "./sha256.js";
import { parseCacheFreeBytes, StageError, RecoveryStopped } from "./stages.js";
import { readZipMember } from "./amonet.js";
import { verifyEd25519Signature } from "./signature.js";
import { PROTOCOL_DIRECT, recoveryMembersForTarget } from "./targets.js";

export const DIRECT_PROTOCOL = PROTOCOL_DIRECT;
export const DIRECT_STATE_DIR = "/cache/libreecho-direct";
export const DIRECT_HELPER_PATH = `${DIRECT_STATE_DIR}/libreecho-direct-install.sh`;
export const DIRECT_MANIFEST_PATH = `${DIRECT_STATE_DIR}/bundle.manifest`;
export const DIRECT_RECEIPT_PATH = `${DIRECT_STATE_DIR}/receipt`;
/** The helper's monotone transaction guard (written before every mutation). */
export const DIRECT_TRANSACTION_PATH = `${DIRECT_STATE_DIR}/transaction.state`;
export const DIRECT_LOG_PATH = `${DIRECT_STATE_DIR}/install.log`;
export const DIRECT_INCOMING_DIR = "/data/libreecho/incoming";
export const DIRECT_HELPER_MEMBER = "libreecho-direct-install.sh";
export const DIRECT_HELPER_MAX_BYTES = 1024 * 1024;
/** Documented reserve for the state dir entry, install.log and receipt writes. */
export const DIRECT_CONTROL_OVERHEAD_BYTES = 1024 * 1024;

const PHASES = ["prepare", "initialize", "transfer", "finalize"];
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const SHELL_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeMemberName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 200
    && SHELL_TOKEN.test(name) && !name.includes("/") && !name.includes("\\") && !name.includes("..")
    && !name.startsWith(".") && !/[\u0000-\u001f\u007f]/.test(name);
}

function requireShellToken(value, label) {
  if (typeof value !== "string" || !SHELL_TOKEN.test(value) || value.length > 200) {
    throw new StageError("release", `refusing an unsafe ${label} for the recovery helper: ${value ?? "(none)"}`);
  }
  return value;
}

/**
 * The exact, explicit helper invocation. No implicit marker, no argument is
 * interpolated without a strict charset check, and `--reset-transaction` is
 * never emitted automatically.
 */
export function directPhaseCommand({ phase, dryRun = false, bundleManifestSha256, target, release, invocationId,
  helperPath = DIRECT_HELPER_PATH, manifestPath = DIRECT_MANIFEST_PATH,
  stateDir = DIRECT_STATE_DIR, incomingDir = DIRECT_INCOMING_DIR } = {}) {
  if (!PHASES.includes(phase)) throw new StageError("install", `refusing an unsupported recovery phase: ${phase}`);
  if (typeof bundleManifestSha256 !== "string" || !SHA256_HEX.test(bundleManifestSha256)) {
    throw new StageError("install", "a hex64 bundle manifest sha256 is required before a phase can run");
  }
  for (const [path, expected] of [[helperPath, DIRECT_HELPER_PATH], [manifestPath, DIRECT_MANIFEST_PATH], [stateDir, DIRECT_STATE_DIR], [incomingDir, DIRECT_INCOMING_DIR]]) {
    if (path !== expected) throw new StageError("install", "refusing a noncanonical recovery path");
  }
  if (typeof invocationId !== "string" || !/^[a-f0-9]{64}$/.test(invocationId)) {
    throw new StageError("install", "a fresh hex64 invocation ID is required");
  }
  requireShellToken(target, "target");
  requireShellToken(release, "release");
  const args = [
    `/sbin/sh ${helperPath}`,
    "--protocol 2",
    `--phase ${phase}`,
    `--invocation-id ${invocationId}`,
    `--bundle-manifest ${manifestPath}`,
    `--bundle-manifest-sha256 ${bundleManifestSha256}`,
    `--target ${target}`,
    `--release ${release}`,
    `--state-dir ${stateDir}`,
    `--incoming-dir ${incomingDir}`,
  ];
  if (dryRun) args.push("--dry-run");
  return args.join(" ");
}

/**
 * Every exact file the browser must transfer: the fixed `transfer=` roles plus
 * each `staging=` payload and manifest. Deduplicated by name; each name is a
 * safe basename and each digest is pinned.
 */
export function planRoles(parsed) {
  if (!parsed || parsed.protocol !== DIRECT_PROTOCOL) {
    throw new StageError("release", "the bundle manifest is not a direct-userdata protocol 2 manifest");
  }
  const roles = [];
  const seen = new Set();
  const add = (role, name, sha256) => {
    if (!safeMemberName(name)) throw new StageError("release", `refusing an unsafe transfer name: ${name ?? "(none)"}`);
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) throw new StageError("release", `transfer ${role} is not sha256-pinned`);
    if (seen.has(name)) return;
    seen.add(name);
    roles.push({ role, name, sha256: sha256.toLowerCase() });
  };
  for (const transfer of parsed.transfers ?? []) add(`transfer:${transfer.role}`, transfer.name, transfer.sha256);
  for (const line of parsed.staging ?? []) {
    const parts = String(line).split(":");
    if (parts.length !== 5) throw new StageError("release", `malformed staging line: ${line}`);
    const [feature, payloadName, payloadSha, manifestName, manifestSha] = parts;
    if (!safeMemberName(feature)) throw new StageError("release", `unsafe feature name: ${feature}`);
    add(`staging:${feature}:payload`, payloadName, payloadSha);
    add(`staging:${feature}:manifest`, manifestName, manifestSha);
  }
  if (!roles.some((role) => role.role === "transfer:boot")) throw new StageError("release", "the bundle manifest has no boot transfer role");
  if (!roles.some((role) => role.role === "transfer:ota-manifest")) throw new StageError("release", "the bundle manifest has no ota-manifest transfer role");
  if (!roles.some((role) => role.role === "transfer:ota-signature")) throw new StageError("release", "the bundle manifest has no ota-signature transfer role");
  return roles;
}

/** Extract the bounded self-contained helper from the digest-verified ZIP. */
export async function extractDirectHelper({ archiveBlob, maxBytes = DIRECT_HELPER_MAX_BYTES } = {}) {
  const bytes = await readZipMember({ archiveBlob, memberPath: DIRECT_HELPER_MEMBER, maxBytes });
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    throw new StageError("release", "the verified installer ZIP does not carry the direct install helper");
  }
  return bytes;
}

/**
 * Host-side verification of the v2 plan: every role resolves to a locally
 * verified blob whose digest matches the anchor manifest, the exact byte total
 * matches `transfer_bytes_total`, the signed manifest verifies against the
 * published key, and the bounded helper extracts from the verified ZIP. Nothing
 * here touches the device.
 */
export async function prepareDirectInstall({ parsed, files, sums, target, manifestName } = {}) {
  if (!parsed || parsed.protocol !== DIRECT_PROTOCOL) throw new StageError("release", "the bundle manifest is not a direct-userdata protocol 2 manifest");
  if (!target?.prefix || !files?.get) throw new StageError("release", "the resolved target and verified files are required");
  if (!Number.isSafeInteger(parsed.transferBytesTotal) || parsed.transferBytesTotal < 0) {
    throw new StageError("release", "the bundle manifest has no valid transfer_bytes_total");
  }
  const roles = [];
  let sum = 0;
  for (const role of planRoles(parsed)) {
    const blob = files.get(role.name);
    if (!blob) throw new StageError("release", `missing-upload:${role.role} — ${role.name} was not verified locally`);
    const pinned = sums?.get?.(role.name);
    if (typeof pinned !== "string" || !SHA256_HEX.test(pinned)) throw new StageError("release", `${role.name}: no verified digest is pinned`);
    const digest = await sha256Blob(blob);
    if (digest.toLowerCase() !== pinned.toLowerCase()) throw new StageError("release", `${role.name}: verified digest mismatch`);
    if (digest.toLowerCase() !== role.sha256) throw new StageError("release", `${role.name}: does not match the recovery manifest digest`);
    const size = Number(blob.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new StageError("release", `${role.name}: file size is unknown`);
    sum += size;
    roles.push({ ...role, size });
  }
  if (sum !== parsed.transferBytesTotal) {
    throw new StageError("release", `the transfer set is ${sum} bytes but the manifest declares ${parsed.transferBytesTotal}`);
  }

  const signedManifest = files.get("manifest");
  const signature = files.get("manifest.sig");
  const keyBlob = files.get(`${target.prefix}-ota-public-key.hex`);
  if (!signedManifest || !signature || !keyBlob) {
    throw new StageError("release", "the signed manifest, its signature or the published OTA public key is missing");
  }
  const message = new Uint8Array(await signedManifest.arrayBuffer());
  try {
    await verifyEd25519Signature({ message, signatureHex: (await signature.text()).trim(), publicKeyHex: (await keyBlob.text()).trim() });
  } catch (error) {
    throw new StageError("release", `signed manifest precheck failed: ${error.message}`);
  }

  const zipName = recoveryMembersForTarget(target)[0];
  const zipBlob = files.get(zipName);
  if (!zipBlob) throw new StageError("release", `the verified installer ZIP (${zipName}) is missing`);
  const zipPin = sums?.get?.(zipName);
  if (typeof zipPin !== "string" || !SHA256_HEX.test(zipPin) || (await sha256Blob(zipBlob)).toLowerCase() !== zipPin.toLowerCase()) {
    throw new StageError("release", "installer ZIP digest pin missing or mismatch before extraction");
  }
  let helper;
  try {
    helper = await extractDirectHelper({ archiveBlob: zipBlob });
  } catch (error) {
    throw new StageError("release", `installer helper extraction failed: ${error.message}`);
  }

  const manifestBlob = files.get(manifestName);
  if (!manifestBlob) throw new StageError("release", `the verified ${manifestName} is missing`);
  const manifestText = await manifestBlob.text();
  const manifestSha256 = await sha256Blob(manifestBlob);
  const pinnedManifest = sums?.get?.(manifestName);
  if (typeof pinnedManifest !== "string" || !SHA256_HEX.test(pinnedManifest) || pinnedManifest.toLowerCase() !== manifestSha256.toLowerCase()) {
    throw new StageError("release", "the bundle manifest digest changed after verification");
  }
  return { roles, transferBytesTotal: parsed.transferBytesTotal, helper, manifestText, manifestSha256 };
}

/** Exact bytes to push into /cache plus the documented reserve. */
export function controlPreflightBytes({ helperBytes, manifestText } = {}) {
  if (!(helperBytes instanceof Uint8Array) || helperBytes.length === 0) throw new StageError("stage", "the verified helper bytes are unavailable");
  if (typeof manifestText !== "string" || manifestText.length === 0) throw new StageError("stage", "the verified bundle manifest is unavailable");
  const pushBytes = helperBytes.length + new TextEncoder().encode(manifestText).length;
  return { pushBytes, neededBytes: pushBytes + DIRECT_CONTROL_OVERHEAD_BYTES };
}

/**
 * Push ONLY the helper and the anchor manifest into the control-plane dir, after
 * a bounded /cache free-space check. No payload is ever staged in /cache.
 */
export async function pushDirectControl({ adb, helperBytes, manifestText, terminal, isCancelled = null } = {}) {
  const check = () => { if (isCancelled?.()) throw new RecoveryStopped(); };
  check();
  if (!adb?.shell || !adb?.push) throw new StageError("stage", "a recovery ADB session is required to hand off the installer");
  const sizing = controlPreflightBytes({ helperBytes, manifestText });
  let output;
  try {
    output = await adb.shell(`df -Pk ${DIRECT_STATE_DIR.split("/").slice(0, 2).join("/")} 2>&1 || true`);
  } catch (error) {
    throw new StageError("stage", `/cache free space could not be read (${error.message}); nothing was pushed`);
  }
  check();
  let freeBytes;
  try {
    freeBytes = parseCacheFreeBytes(output?.stdout, "/cache");
  } catch {
    terminal?.error("cannot measure free space on /cache; refusing to hand off the installer");
    throw new StageError("stage", "/cache free space could not be read; refusing to hand off the installer");
  }
  if (freeBytes < sizing.neededBytes) {
    terminal?.error(`/cache has ${freeBytes} bytes free but the control files need ${sizing.neededBytes}`);
    throw new StageError("stage", `/cache has ${freeBytes} bytes free but the control files need ${sizing.neededBytes}; nothing was pushed`);
  }
  check();
  await adb.shell(`mkdir -p ${DIRECT_STATE_DIR}`);
  check();
  terminal?.command(`adb push libreecho-direct-install.sh → ${DIRECT_HELPER_PATH} (${helperBytes.length} bytes)`);
  await adb.push(DIRECT_HELPER_PATH, new Blob([helperBytes]));
  check();
  terminal?.command(`adb push bundle.manifest → ${DIRECT_MANIFEST_PATH}`);
  await adb.push(DIRECT_MANIFEST_PATH, new Blob([manifestText]));
  check();
  for (const [path, blob] of [[DIRECT_HELPER_PATH, new Blob([helperBytes])], [DIRECT_MANIFEST_PATH, new Blob([manifestText])]]) {
    const wanted = await sha256Blob(blob);
    check();
    const readback = await adb.shell(`/sbin/sha256sum ${path}`);
    check();
    const fields = String(readback?.stdout ?? "").trim().split(/\s+/);
    if (fields.length !== 2 || fields[0] !== wanted || fields[1] !== path) {
      throw new StageError("stage", `control digest readback failed: ${path}; helper will not be executed`);
    }
  }
  terminal?.info(`/cache/${DIRECT_STATE_DIR.split("/").pop()}: ${freeBytes} bytes free, ${sizing.pushBytes} bytes of control files + ${DIRECT_CONTROL_OVERHEAD_BYTES} reserve`);
  return { ...sizing, freeBytes, fileCount: 2 };
}

async function readDirectLog(adb, tail = 40) {
  try {
    const result = await adb.shell(`tail -n ${tail} ${DIRECT_LOG_PATH} 2>/dev/null || true`);
    return String(result?.stdout ?? "");
  } catch {
    return "";
  }
}

/**
 * Runs one explicit helper phase. Require both successful helper exit and a
 * uniquely keyed receipt bound to a fresh random nonce, protocol, phase, bundle,
 * release, target and device. Exit status alone is not evidence of installation.
 * A phase is attempt-guarded in localStorage
 * BEFORE it runs, so a disconnect, reload or crash yields an unknown outcome
 * that is never silently repeated. `--reset-transaction` is never automatic;
 * there is deliberately no code path that resets it. The non-mutating
 * `finalize --dry-run` is not guarded, so it never blocks the real finalize.
 *
 * `deviceAllowsRepeat` is the ONLY way past an existing guard entry, and only
 * `classifyDirectTransaction` sets it: it is true when the Echo's own
 * transaction guard, read immediately before this run, proves that an earlier
 * attempt of this phase either never reached its first mutation or is one the
 * helper itself guarantees to be safe to repeat (see the state machine there).
 * Without that proof the refusal stands.
 */
export async function runDirectPhase({ adb, phase, dryRun = false, serialRaw, tag,
  bundleManifestSha256, target, release, stateDir, incomingDir, deviceDigest = null, terminal, isCancelled = null,
  deviceAllowsRepeat = false, transactionPhase = null } = {}) {
  if (!adb?.shell) throw new StageError("install", "a recovery ADB session is required to run a phase");
  if (isCancelled?.()) throw new RecoveryStopped();
  if (!globalThis.crypto?.getRandomValues) throw new StageError("install", "secure invocation randomness is unavailable");
  const invocationId = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const command = directPhaseCommand({ phase, dryRun, bundleManifestSha256, target, release, stateDir, incomingDir, invocationId });
  if (!dryRun) {
    if (!serialRaw || !tag || typeof localStorage === "undefined") {
      throw new StageError("install", "persistent device-bound recovery attempt storage is unavailable");
    }
    const key = `libreecho.direct.${await sha256Bytes(new TextEncoder().encode(`${serialRaw}:${tag}:${phase}`))}`;
    if (isCancelled?.()) throw new RecoveryStopped();
    try {
      if (localStorage.getItem(key)) {
        if (!deviceAllowsRepeat) {
          throw new StageError("install", `the ${phase} phase was already attempted from this browser on this Echo, and the Echo's own `
            + `install state (${DIRECT_TRANSACTION_PATH}) does not prove what that attempt did, so it is not run again. `
            + "Nothing was run. Leave the Echo in TWRP and report this with the log so its state can be checked first");
        }
        terminal?.info(`this browser started the ${phase} phase on this Echo before; the Echo's install state `
          + `(phase=${transactionPhase || "none recorded"}) proves that attempt left nothing unresolved, so ${phase} runs again`);
      }
      localStorage.setItem(key, "pending-or-completed");
    } catch (error) {
      if (error instanceof StageError) throw error;
      throw new StageError("install", "cannot persist the recovery attempt guard");
    }
  }
  if (isCancelled?.()) throw new RecoveryStopped();
  terminal?.command(command);
  const result = await adb.shell(
    `${command} 2>&1; rc=$?; printf "\\n__HELPER_RC__%s\\n__RECEIPT__" "$rc"; cat ${DIRECT_RECEIPT_PATH} 2>/dev/null`,
    { onOutput: (chunk) => terminal?.line(chunk) },
  );
  if (isCancelled?.()) throw new RecoveryStopped();
  const text = String(result?.stdout ?? "");
  const envelope = /(?:^|\n)__HELPER_RC__(\d+)\r?\n__RECEIPT__/.exec(text);
  if (!envelope || text.split("__RECEIPT__").length !== 2 || envelope[1] !== "0") {
    throw new StageError(phase, "recovery helper exit status missing or nonzero; outcome is not accepted");
  }
  const receipt = Object.create(null);
  for (const line of text.slice(envelope.index + envelope[0].length).split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-z][a-z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(receipt, match[1])) throw new StageError(phase, "malformed or duplicate receipt field");
    receipt[match[1]] = match[2];
  }
  const expected = { protocol: "2", phase, invocation_id: invocationId, bundle_manifest_sha256: bundleManifestSha256, target, release };
  for (const [key, value] of Object.entries(expected)) {
    if (receipt[key] !== value) throw new StageError(phase, `receipt binding mismatch: ${key}`);
  }
  if (!/^[a-f0-9]{64}$/.test(receipt.device_digest ?? "") || (deviceDigest !== null && receipt.device_digest !== deviceDigest)) {
    throw new StageError(phase, "receipt device binding mismatch");
  }
  const binding = await sha256Bytes(new TextEncoder().encode(`2|${phase}|${bundleManifestSha256}|${receipt.device_digest}|${target}|${release}`));
  if (isCancelled?.()) throw new RecoveryStopped();
  if (receipt.invocation_sha256 !== binding) throw new StageError(phase, "receipt invocation digest mismatch");
  if (receipt.result === "failed") throw new StageError(phase, `the ${phase} phase failed: ${receipt.error ?? "unknown"}`);
  const allowed = dryRun ? ["dry-run-ok", ...(phase === "prepare" ? ["prepare-noop"] : [])] : {
    prepare: ["prepare-ok", "prepare-noop"], initialize: ["initialized"], transfer: ["transferred"], finalize: ["installed"],
  }[phase];
  if (!allowed.includes(receipt.result)) throw new StageError(phase, "unexpected receipt result");
  return receipt;
}

/**
 * Push the exact selected transfer/staging roles into the userdata landing
 * zone. Each file's digest is re-verified locally immediately before it is
 * pushed, and cancellation is re-checked before every push.
 */
export async function pushDirectPayloads({ adb, roles, files, sums, terminal, isCancelled = null } = {}) {
  if (!adb?.push) throw new StageError("transfer", "a recovery ADB session is required to push payloads");
  if (!Array.isArray(roles) || roles.length === 0) throw new StageError("transfer", "no transfer roles were selected");
  let pushedBytes = 0;
  for (const role of roles) {
    if (isCancelled?.()) throw new RecoveryStopped();
    if (!safeMemberName(role?.name)) throw new StageError("transfer", `refusing an unsafe upload name: ${role?.name ?? "(none)"}`);
    const blob = files?.get?.(role.name);
    if (!blob) throw new StageError("transfer", `missing-upload:${role.role} — ${role.name} is not in the verified set`);
    const pinned = sums?.get?.(role.name);
    const digest = await sha256Blob(blob);
    if (digest.toLowerCase() !== String(role.sha256).toLowerCase()
      || (typeof pinned === "string" && digest.toLowerCase() !== pinned.toLowerCase())) {
      throw new StageError("transfer", `${role.name}: digest changed before the push`);
    }
    if (isCancelled?.()) throw new RecoveryStopped();
    const remote = `${DIRECT_INCOMING_DIR}/${role.name}`;
    terminal?.command(`adb push ${role.name} → ${remote} (${blob.size} bytes)`);
    await adb.push(remote, blob);
    if (isCancelled?.()) throw new RecoveryStopped();
    pushedBytes += blob.size;
    terminal?.ok(`pushed ${role.name}`);
  }
  terminal?.endProgress?.();
  return { pushedBytes, fileCount: roles.length };
}

// ---------------------------------------------------------------------------
// Resume from the Echo's own transaction state (issue #28)
// ---------------------------------------------------------------------------
//
// The helper keeps the authoritative record of a direct install on the device:
//
//   transaction.state  protocol, target, release, bundle_manifest_sha256,
//                      device_digest, format_state, phase. Monotone:
//                      prepare -> initialize -> transfer -> finalizing ->
//                      finalized. Every phase persists it (and syncs) BEFORE
//                      its first mutation, and refuses to run when it is later
//                      than the phase may be.
//   receipt            the outcome of the LAST helper invocation only. Every
//                      invocation first replaces it with result=failed, so it
//                      says nothing about earlier phases.
//
// The page used to keep its own attempt guard in localStorage (one key per
// serial, release tag and phase, set BEFORE the phase runs) and refused any
// repeat outright. That is the right default — an attempt whose outcome is
// unknown must never be silently repeated — but it had no way out: a browser
// that had run a whole, successful install could never get past "prepare phase
// already attempted" again (aslater3/LibreEcho#322).
//
// The way out is the device's own guard, read before any phase runs. It is
// bound to this build (bundle manifest digest, target, release) and to this
// device (the helper's device digest, recomputed here when TWRP can answer for
// it), and then decides:
//
//   transaction.state                     receipt          the page does         an earlier browser attempt
//                                                                                 of these phases may repeat
//   ------------------------------------  ---------------  --------------------  --------------------------
//   cannot be read, or /cache unmounted   -                start at prepare      none (old behaviour)
//   absent                                -                start at prepare      prepare initialize transfer finalize
//   bound to another bundle/target/       -                REFUSE (conflict)     -
//     release/device
//   malformed, unknown protocol/phase/    -                REFUSE (unreadable)   -
//     format_state, impossible pair
//   phase '' or prepare, format absent    -                start at prepare      prepare initialize transfer finalize
//   phase initialize, format formatting   -                REFUSE (format-       -
//                                                            uncertain)
//   phase initialize, format formatted    -                start at transfer     transfer finalize
//   phase transfer, format formatted      -                start at transfer     transfer finalize
//   phase finalizing                      -                REFUSE (finalize-     -
//                                                            uncertain)
//   phase finalized                       result=installed COMPLETE: no phase    - (nothing runs)
//                                         bound to the       runs; reboot into
//                                         same build and     LibreEcho and hand
//                                         device             over to setup (#24)
//   phase finalized                       anything else    REFUSE (finalized-    -
//                                                            unconfirmed)
//
// Why each permitted repeat is safe (all of it is enforced again by the helper
// itself, which re-checks the guard on every invocation):
//   * absent: every phase writes the guard before its first mutation, and
//     initialize/transfer/finalize refuse without it, so no earlier attempt
//     changed anything the helper tracks.
//   * prepare/absent: an earlier prepare either changed nothing or rewrote the
//     userdata GPT entry to the contract size from the same first sector, which
//     is idempotent (and a no-op once the new table is live after the reboot);
//     the helper explicitly allows prepare here. initialize persists
//     phase=initialize, format_state=formatting before it formats, so an
//     earlier initialize never formatted. transfer and finalize need
//     format_state=formatted, so earlier attempts were refused unchanged.
//   * initialize|transfer/formatted: format_state=formatted is written only
//     after the format and the tree completed. transfer may repeat by the
//     helper's own rule (it only creates the landing directory and re-checks
//     free space); payload pushes overwrite. finalize persists phase=finalizing
//     before its first boot-slot write, so an earlier finalize wrote nothing.
//
// Never: `--reset-transaction` is never sent, a refused state is never worked
// around, and an uncertain format or finalize is never repeated.

/**
 * Read-only, one round trip: each file is fenced so "absent" and "unreadable"
 * differ. "Absent" only counts when /cache is a mounted filesystem: on an
 * unmounted /cache a missing file proves nothing, so that read is unreadable.
 */
export const DIRECT_TRANSACTION_READ_COMMAND = [
  "if grep -q ' /cache ' /proc/mounts; then echo __LE_CACHE__ mounted; else echo __LE_CACHE__ unmounted; fi",
  ...[DIRECT_TRANSACTION_PATH, DIRECT_RECEIPT_PATH]
    .map((path) => `if [ -f ${path} ]; then echo __LE_BEGIN__ ${path}; cat ${path}; echo; echo __LE_END__ ${path}; `
      + `else echo __LE_ABSENT__ ${path}; fi`),
].join("; ");

/**
 * Read-only: the inputs of the helper's `compute_device_digest` — the serial
 * TWRP reports and the userdata partition, resolved by name the way the helper
 * does (by-name link first, else sysfs PARTNAME). The GUID is read separately.
 */
export const DEVICE_IDENTITY_READ_COMMAND = [
  'echo "le_serial=$(getprop ro.serialno)"',
  'echo "le_boot_serial=$(getprop ro.boot.serialno)"',
  'echo "le_byname=$(readlink -f /dev/block/by-name/userdata 2>/dev/null)"',
  'for u in /sys/class/block/mmcblk0p*/uevent; do grep -qx PARTNAME=userdata "$u" 2>/dev/null && echo "le_sysfs=$(basename "$(dirname "$u")")"; done',
].join("; ");

const TRANSACTION_PHASES = ["", "prepare", "initialize", "transfer", "finalizing", "finalized"];
const FORMAT_STATES = ["", "absent", "formatting", "formatted"];
const ALL_PHASES = Object.freeze(["prepare", "initialize", "transfer", "finalize"]);

/** Strict `key=value` lines; a malformed or duplicate line makes the whole file unreadable. */
function parseKeyValues(text) {
  const fields = Object.create(null);
  for (const line of String(text ?? "").split("\n")) {
    if (line === "") continue;
    const match = /^([a-z][a-z0-9_]*)=(.*)$/.exec(line);
    if (!match || Object.hasOwn(fields, match[1])) return null;
    fields[match[1]] = match[2];
  }
  return fields;
}

/** Splits DIRECT_TRANSACTION_READ_COMMAND output into the two files, or reports it unreadable. */
export function parseTransactionRead(stdout) {
  const text = String(stdout ?? "").replace(/\r/g, "");
  const lines = text.split("\n");
  if (!lines.includes("__LE_CACHE__ mounted")) return { readable: false };
  const files = {};
  for (const [name, path] of [["state", DIRECT_TRANSACTION_PATH], ["receipt", DIRECT_RECEIPT_PATH]]) {
    const absent = lines.includes(`__LE_ABSENT__ ${path}`);
    const beginMarker = `__LE_BEGIN__ ${path}\n`;
    const begin = text.indexOf(beginMarker);
    const start = begin + beginMarker.length;
    const end = begin === -1 ? -1 : text.indexOf(`\n__LE_END__ ${path}`, start - 1);
    if (absent && begin === -1) files[name] = { present: false, text: null };
    else if (!absent && begin !== -1 && end >= start - 1) files[name] = { present: true, text: text.slice(start, Math.max(start, end)) };
    else return { readable: false };
  }
  return { readable: true, ...files };
}

/**
 * Recomputes the helper's device digest (sha256 of `target=`, `serial=` and
 * `userdata_guid=` lines) from TWRP, read-only. Returns null whenever any input
 * cannot be read: the caller then binds the receipt to the guard instead.
 */
export async function computeDeviceDigest({ adb, target } = {}) {
  try {
    const fields = new Map();
    const sysfs = [];
    const reply = await adb.shell(DEVICE_IDENTITY_READ_COMMAND);
    for (const raw of String(reply?.stdout ?? "").replace(/\r/g, "").split("\n")) {
      const match = /^(le_[a-z_]+)=(.*)$/.exec(raw.trim());
      if (!match) continue;
      if (match[1] === "le_sysfs") sysfs.push(match[2]);
      else if (!fields.has(match[1])) fields.set(match[1], match[2].trim());
    }
    const serial = fields.get("le_serial") || fields.get("le_boot_serial") || "";
    if (!serial || /\s/.test(serial)) return null;
    const byName = /^\/dev\/block\/(mmcblk0p\d+)$/.exec(fields.get("le_byname") ?? "")?.[1];
    const node = byName ?? (sysfs.length === 1 && /^mmcblk0p\d+$/.test(sysfs[0]) ? sysfs[0] : null);
    if (!node) return null;
    const number = node.slice("mmcblk0p".length);
    const info = await adb.shell(`/sbin/sgdisk --info=${number} /dev/block/mmcblk0`);
    const guid = /^Partition unique GUID: (.*)$/m.exec(String(info?.stdout ?? "").replace(/\r/g, ""))?.[1] ?? "";
    if (!guid) return null;
    return await sha256Bytes(new TextEncoder().encode(`target=${target}\nserial=${serial}\nuserdata_guid=${guid}\n`));
  } catch {
    return null;
  }
}

/** What to say about a refused device state: the state, why, and the one safe next step. */
const REPORT_NEXT_STEP = "Leave the Echo in TWRP, do not run the install again, and report this with the log "
  + "(Report a problem) so the device's state can be checked first. This page never resets an install transaction.";

/**
 * The state machine above, as a pure decision. `read` is `parseTransactionRead`
 * output, `expected` the verified build (`bundleManifestSha256`, `target`,
 * `release`) and `deviceDigest` the recomputed digest or null.
 *
 * Returns `{ status, resumeAt, allowRepeat, transaction, receipt, code, message }`:
 *   status "unknown"  — the state could not be read; run as before, every browser guard stands.
 *   status "fresh"    — no transaction on the device; start at prepare.
 *   status "resume"   — start at `resumeAt` ("prepare" or "transfer").
 *   status "complete" — finalized and confirmed: run nothing, hand over to LibreEcho.
 *   status "refuse"   — run nothing; `message` names the state and the safe next step.
 * `allowRepeat` lists the phases whose earlier browser attempt the device state settles.
 */
export async function classifyDirectTransaction({ read, expected, deviceDigest = null } = {}) {
  const base = { resumeAt: null, allowRepeat: [], transaction: null, receipt: null, code: null };
  const refuse = (code, message, extra = {}) => ({ ...base, ...extra, status: "refuse", code, message });
  if (!read?.readable) {
    return { ...base, status: "unknown", resumeAt: "prepare",
      message: `the Echo's install state (${DIRECT_TRANSACTION_PATH}) could not be read; starting at prepare with every earlier attempt from this browser still refused` };
  }
  if (!read.state.present) {
    return { ...base, status: "fresh", resumeAt: "prepare", allowRepeat: [...ALL_PHASES],
      message: "no install transaction is recorded on this Echo; starting at prepare" };
  }
  const transaction = parseKeyValues(read.state.text);
  const receipt = read.receipt.present ? parseKeyValues(read.receipt.text) : null;
  const extra = { transaction, receipt };
  if (!transaction) {
    return refuse("transaction-unreadable", `the Echo's install state (${DIRECT_TRANSACTION_PATH}) is malformed, so how far `
      + `the install got cannot be proven. Nothing was run. ${REPORT_NEXT_STEP}`, extra);
  }
  const phase = transaction.phase ?? "";
  const format = transaction.format_state ?? "";
  const described = `phase=${phase || "(none)"}, format_state=${format || "(none)"}`;
  if (transaction.protocol !== "2" || !TRANSACTION_PHASES.includes(phase) || !FORMAT_STATES.includes(format)
    || !/^[a-f0-9]{64}$/.test(transaction.device_digest ?? "")) {
    return refuse("transaction-unreadable", `the Echo's install state (${described}, protocol=${transaction.protocol ?? "(none)"}) `
      + `is not one this page understands, so how far the install got cannot be proven. Nothing was run. ${REPORT_NEXT_STEP}`, extra);
  }
  // Bound to this build and this device, or nothing of it is trusted.
  const conflicts = [];
  if (transaction.bundle_manifest_sha256 !== expected?.bundleManifestSha256) conflicts.push("bundle manifest");
  if (transaction.target !== expected?.target) conflicts.push("target");
  if (transaction.release !== expected?.release) conflicts.push("release");
  if (conflicts.length) {
    const recorded = `release ${transaction.release || "(none)"}, target ${transaction.target || "(none)"}`;
    const next = phase === "finalized"
      ? "That install finished: restart the Echo normally to start LibreEcho, and update it from LibreEcho itself."
      : `To continue that install, choose release ${transaction.release || "(the recorded one)"} for this Echo and press Install again.`;
    return refuse("transaction-conflict", `this Echo holds an install transaction for a different build (${recorded}, `
      + `${described}; different ${conflicts.join(", ")}). This page never runs a phase over, repeats or resets another `
      + `transaction, so nothing was run. ${next}`, extra);
  }
  if (deviceDigest !== null && transaction.device_digest !== deviceDigest) {
    return refuse("transaction-conflict", `the Echo's install state (${described}) was recorded for a different device `
      + `identity (serial or userdata partition) than this Echo reports now. Nothing was run. ${REPORT_NEXT_STEP}`, extra);
  }
  const bound = `${described}, release ${transaction.release}, target ${transaction.target}, bound to this build`;
  if ((phase === "" || phase === "prepare") && (format === "" || format === "absent")) {
    return { ...base, ...extra, status: "resume", resumeAt: "prepare", allowRepeat: [...ALL_PHASES],
      message: `the Echo's install state is ${bound}: userdata is not formatted yet, and prepare is safe to repeat `
        + "(it changes nothing once userdata already matches), so the install continues at prepare" };
  }
  if (phase === "initialize" && format === "formatting") {
    return refuse("format-uncertain", `the Echo's install state is ${described}: formatting userdata started but was `
      + `never confirmed. A format whose outcome is unknown is never repeated automatically, so nothing was run. ${REPORT_NEXT_STEP}`, extra);
  }
  if ((phase === "initialize" || phase === "transfer") && format === "formatted") {
    return { ...base, ...extra, status: "resume", resumeAt: "transfer", allowRepeat: ["transfer", "finalize"],
      message: `the Echo's install state is ${bound}: userdata is already prepared and formatted, so prepare and `
        + "initialize are not run again and the install continues at transfer" };
  }
  if (phase === "finalizing") {
    return refuse("finalize-uncertain", `the Echo's install state is ${described}: finalize started writing the boot `
      + `slots but never confirmed that it finished. That is never repeated automatically, so nothing was run. ${REPORT_NEXT_STEP}`, extra);
  }
  if (phase === "finalized") {
    const why = await finalizedReceiptProblem({ receipt, transaction, expected, deviceDigest });
    if (why) {
      return refuse("finalized-unconfirmed", `the Echo's install state records the install as finished (${described}), `
        + `but its last receipt does not confirm it (${why}). Nothing was run and nothing will be repeated. Restart the `
        + "Echo normally; if LibreEcho starts, finish setup as the guide's step 5 describes. If it does not, report this with the log.", extra);
    }
    return { ...base, ...extra, status: "complete",
      message: `the Echo's install state is ${bound}, and its receipt confirms result=installed: `
        + "the install already finished, so no phase runs again" };
  }
  return refuse("transaction-unreadable", `the Echo's install state (${described}) is not a combination the installer `
    + `writes, so how far the install got cannot be proven. Nothing was run. ${REPORT_NEXT_STEP}`, extra);
}

/** Why a finalized transaction's receipt does not confirm the install, or null when it does. */
async function finalizedReceiptProblem({ receipt, transaction, expected, deviceDigest }) {
  if (!receipt) return "no readable receipt";
  if (receipt.result !== "installed") return `result=${receipt.result ?? "(none)"}${receipt.error ? ` error=${receipt.error}` : ""}`;
  const binding = { protocol: "2", phase: "finalize", bundle_manifest_sha256: expected.bundleManifestSha256,
    target: expected.target, release: expected.release, device_digest: transaction.device_digest };
  for (const [key, value] of Object.entries(binding)) {
    if (receipt[key] !== value) return `receipt ${key} does not match`;
  }
  if (deviceDigest !== null && receipt.device_digest !== deviceDigest) return "receipt device does not match";
  const invocation = await sha256Bytes(new TextEncoder().encode(
    `2|finalize|${expected.bundleManifestSha256}|${transaction.device_digest}|${expected.target}|${expected.release}`));
  if (receipt.invocation_sha256 !== invocation) return "receipt invocation digest does not match";
  return null;
}

/**
 * Reads the Echo's transaction guard and receipt (read-only) and classifies
 * them. A transport failure is "unknown": the run then behaves exactly as it
 * did before this existed, with every browser guard in force.
 */
export async function inspectDirectTransaction({ adb, bundleManifestSha256, target, release, terminal } = {}) {
  let read = { readable: false };
  try {
    read = parseTransactionRead((await adb.shell(DIRECT_TRANSACTION_READ_COMMAND))?.stdout);
  } catch (error) {
    terminal?.warn(`the Echo's install state could not be read (${error.message})`);
  }
  const deviceDigest = read.readable && read.state.present ? await computeDeviceDigest({ adb, target }) : null;
  if (read.readable && read.state.present) {
    terminal?.line(deviceDigest
      ? "device binding: the install state's device digest was recomputed from this Echo"
      : "device binding: the device digest could not be recomputed here; the receipt is bound to the install state's digest instead");
  }
  return classifyDirectTransaction({ read, expected: { bundleManifestSha256, target, release }, deviceDigest });
}
