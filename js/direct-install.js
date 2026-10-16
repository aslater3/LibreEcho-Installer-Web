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

import { sha256Blob, sha256Bytes } from "./sha256.js";
import { parseResumeReceipt } from "./resume-device.js";
import { parseCacheFreeBytes, StageError, RecoveryStopped } from "./stages.js";
import { readZipMember } from "./amonet.js";
import { verifyEd25519Signature } from "./signature.js";
import { PROTOCOL_DIRECT, recoveryMembersForTarget } from "./targets.js";

export const DIRECT_PROTOCOL = PROTOCOL_DIRECT;
export const DIRECT_STATE_DIR = "/cache/libreecho-direct";
export const DIRECT_HELPER_PATH = `${DIRECT_STATE_DIR}/libreecho-direct-install.sh`;
export const DIRECT_MANIFEST_PATH = `${DIRECT_STATE_DIR}/bundle.manifest`;
export const DIRECT_RECEIPT_PATH = `${DIRECT_STATE_DIR}/receipt`;
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

/** The browser's per-phase "never repeat" guard key for one device and release. */
export async function directPhaseGuardKey(serialRaw, tag, phase) {
  return `libreecho.direct.${await sha256Bytes(new TextEncoder().encode(`${serialRaw}:${tag}:${phase}`))}`;
}

/**
 * Retires the per-phase guards of a transaction whose outcome is KNOWN: finalize
 * returned result=installed and the Kaeru header was unchanged. The guards exist
 * so an attempt with an unknown outcome is never blindly repeated. Left in place
 * after success, they blocked any later reinstall of the same release on the
 * same Echo from this browser, forever ("prepare phase already attempted"). The
 * device's own finalized transaction record still refuses a stale repeat.
 */
export async function retireDirectPhaseGuards({ serialRaw, tag, phases = ["prepare", "initialize", "transfer", "finalize"] } = {}) {
  if (!serialRaw || !tag || typeof localStorage === "undefined") return 0;
  let removed = 0;
  for (const phase of phases) {
    const key = await directPhaseGuardKey(serialRaw, tag, phase);
    try { if (localStorage.getItem(key) !== null) { localStorage.removeItem(key); removed += 1; } } catch { /* storage unavailable */ }
  }
  return removed;
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
 */
export async function runDirectPhase({ adb, phase, dryRun = false, serialRaw, tag,
  bundleManifestSha256, target, release, stateDir, incomingDir, deviceDigest = null, terminal, isCancelled = null,
  verifyInstalledBootSha256 = null } = {}) {
  if (!adb?.shell) throw new StageError("install", "a recovery ADB session is required to run a phase");
  if (isCancelled?.()) throw new RecoveryStopped();
  const installedReadback = verifyInstalledBootSha256 !== null;
  if (installedReadback && (phase !== "finalize" || dryRun !== true
    || !SHA256_HEX.test(verifyInstalledBootSha256) || !SHA256_HEX.test(deviceDigest ?? ""))) {
    throw new StageError("install", "installed readback requires a dry-run finalize and pinned boot/device digests");
  }
  if (!globalThis.crypto?.getRandomValues) throw new StageError("install", "secure invocation randomness is unavailable");
  const invocationId = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
  const command = directPhaseCommand({ phase, dryRun, bundleManifestSha256, target, release, stateDir, incomingDir, invocationId });
  if (!dryRun) {
    if (!serialRaw || !tag || typeof localStorage === "undefined") {
      throw new StageError("install", "persistent device-bound recovery attempt storage is unavailable");
    }
    const key = await directPhaseGuardKey(serialRaw, tag, phase);
    if (isCancelled?.()) throw new RecoveryStopped();
    try {
      if (localStorage.getItem(key)) throw new StageError("install", `${phase} phase already attempted; classify the device and receipt before any repeat`);
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
  if (!envelope || text.split("__RECEIPT__").length !== 2 || envelope[1] !== (installedReadback ? "1" : "0")) {
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
  if (installedReadback) {
    // A finalized guard takes the helper's readback/refusal branch BEFORE
    // landing-zone validation. Accept only that exact fresh observation, never
    // an ordinary dry-run result or an arbitrary failed installer invocation.
    const proof = parseResumeReceipt(text.slice(envelope.index + envelope[0].length));
    if (receipt.result !== "failed" || receipt.error !== "already-finalized"
      || proof.installedState !== "verified"
      || proof.installedBootSha256 !== verifyInstalledBootSha256.toLowerCase()) {
      throw new StageError(phase, "fresh installed-state readback does not match the selected bundle");
    }
    return receipt;
  }
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
export async function pushDirectPayloads({ adb, roles, files, sums, terminal, isCancelled = null, onProgress = null } = {}) {
  if (!adb?.push) throw new StageError("transfer", "a recovery ADB session is required to push payloads");
  if (!Array.isArray(roles) || roles.length === 0) throw new StageError("transfer", "no transfer roles were selected");
  let pushedBytes = 0;
  let totalBytes = 0;
  for (const role of roles) totalBytes += files?.get?.(role?.name)?.size ?? 0;
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
    const before = pushedBytes;
    await adb.push(remote, blob, {
      onProgress: ({ sent }) => {
        if (!totalBytes) return;
        const fraction = (before + sent) / totalBytes;
        terminal?.progress?.(`pushing ${role.name}`, fraction,
          `${Math.round((before + sent) / 1048576)} / ${Math.round(totalBytes / 1048576)} MiB`);
        onProgress?.(fraction);
      },
    });
    if (isCancelled?.()) throw new RecoveryStopped();
    pushedBytes += blob.size;
    terminal?.endProgress?.();
    terminal?.ok(`pushed ${role.name}`);
  }
  terminal?.endProgress?.();
  return { pushedBytes, fileCount: roles.length };
}

/**
 * Reads the landing zone back and reports, per role, whether the file already on
 * the device is byte-identical to the locally verified one.
 *
 * WHY THIS EXISTS. A resume that skips the helper's `transfer` phase has to
 * decide whether the browser's own payload push also already happened. Skipping
 * the push unconditionally wastes the whole image; pushing it unconditionally
 * re-sends hundreds of megabytes over an install that may already be complete.
 * The only answer that is not a guess is a read-back comparison.
 *
 * READ-ONLY BY CONSTRUCTION. It runs `sha256sum` over the two documented landing
 * paths and nothing else. No phase runs, no file is created, moved or removed,
 * and no path outside `DIRECT_INCOMING_DIR` is ever named. A size check would not
 * be enough: a truncated or substituted file can match a length exactly, and only
 * the digest is what the helper's own `finalize_validate` will later re-check.
 *
 * A role whose file is absent, unreadable or different is reported `present:
 * false` with the reason, so the caller re-pushes exactly that one. An
 * UNREADABLE probe (transport error, or output that does not parse) is never
 * reported as "already present": it is `present: false, reason: "unreadable"`,
 * because the fail-closed reading of "I could not tell" is "assume it is not
 * there and push it again", which is safe, over "assume it is fine".
 *
 * @returns {Promise<{checked: Array<{role, name, sha256, remote, present, reason}>, allPresent: boolean}>}
 */
export async function readLandedPayloads({ adb, roles, terminal, isCancelled = null } = {}) {
  if (!adb?.shell) throw new StageError("transfer", "a recovery ADB session is required to read the landing zone back");
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new StageError("transfer", "no transfer roles were selected for the landing-zone readback");
  }
  const check = () => { if (isCancelled?.()) throw new RecoveryStopped(); };
  const checked = [];
  for (const role of roles) {
    check();
    if (!safeMemberName(role?.name)) throw new StageError("transfer", `refusing an unsafe upload name: ${role?.name ?? "(none)"}`);
    const wanted = String(role.sha256 ?? "").toLowerCase();
    if (!SHA256_HEX.test(wanted)) throw new StageError("transfer", `${role.name}: landing-zone readback needs a pinned digest`);
    const remote = `${DIRECT_INCOMING_DIR}/${role.name}`;
    const record = { role: role.role, name: role.name, sha256: wanted, remote, present: false, reason: null };
    let observed = null;
    try {
      // `/sbin/sha256sum <path> 2>/dev/null || true` — the same shape the control
      // push readback uses, so one command answers "is this exact file there?".
      const result = await adb.shell(`/sbin/sha256sum ${remote} 2>/dev/null || true`);
      const fields = String(result?.stdout ?? "").trim().split(/\s+/).filter(Boolean);
      // `sha256sum` prints "<digest>  <path>". Requiring BOTH means a line that
      // merely contains 64 hex characters is not accepted as a digest.
      if (fields.length === 2 && fields[1] === remote && SHA256_HEX.test(fields[0])) observed = fields[0].toLowerCase();
    } catch {
      observed = null;
    }
    check();
    if (observed === null) record.reason = "absent or unreadable";
    else if (observed !== wanted) record.reason = "digest mismatch";
    else { record.present = true; record.reason = null; }
    checked.push(record);
  }
  const already = checked.filter((entry) => entry.present).length;
  terminal?.info(`landing zone: ${already} of ${checked.length} verified payload(s) are already on the device`);
  return { checked, allPresent: checked.length > 0 && already === checked.length };
}
