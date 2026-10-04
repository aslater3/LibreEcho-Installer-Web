// Install stages for the browser one-shot installer.
//
// The stage list mirrors the reviewed host installer contract:
//
//   release   verify the published release inventory
//   device    find the device in fastboot (WebUSB permission prompt)
//   identity  read product / unlock_status / LK build description
//   unlock    submit the per-LK fastbrick payload to `brick` (no case opening)
//   recovery  wait for TWRP and connect over ADB
//   stage     hand the verified helper + anchor manifest to /cache/libreecho-direct
//   prepare   reshape userdata; the browser reboots recovery when asked
//   initialize format userdata exactly once and create the tree
//   transfer  create the landing zone and free-space gate
//   finalize  write boot slots + features (NO format reachable)
//   verify    reboot and confirm the device is reachable
//
// The page's recovery stages are narrower than the fastbrick unlock: the
// build-selected fastbrick payload itself writes preloader/LK/TEE/RPMB/Kaeru.
// Install writes require the verified published target, exact helper and
// compatible recovery boot chain. Never write FASTBOOT_PLEASE to expdb.

import { Sha256, sha256Blob, sha256Bytes } from "./sha256.js";
import { parseSums, fetchSums, releaseAssetUrl, releasePageUrl, assetPrefix } from "./release.js";
import { maskSerial, describeUsbDevice } from "./device.js";
import { profileForProduct, payloadForProfile } from "./profiles.js";
import { openFastboot, openAdb } from "./transports.js";

export const STAGES = [
  { id: "release", title: "Verify the release inventory" },
  { id: "device", title: "Find the device in fastboot" },
  { id: "identity", title: "Read the device identity" },
  { id: "unlock", title: "Unlock the boot chain (no case opening)" },
  { id: "recovery", title: "Reach TWRP over ADB" },
  { id: "stage", title: "Hand the verified installer to recovery" },
  { id: "prepare", title: "Prepare the userdata layout" },
  { id: "initialize", title: "Initialize userdata (format once)" },
  { id: "transfer", title: "Transfer payloads to userdata" },
  { id: "finalize", title: "Finalize boot slots and features" },
  { id: "configure", title: "Deliver the one-shot configuration" },
  { id: "verify", title: "Verify and reboot" },
];

export const BUNDLE_DIR = "/cache/libreecho-bundle";
const RECEIPT_PATH = "/cache/libreecho-install-receipt";
const LOG_PATH = "/cache/libreecho-install.log";
const DRY_RUN_FLAG = "/cache/libreecho-install-dry-run";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class StageError extends Error {
  constructor(stage, message, detail) {
    super(message);
    this.name = "StageError";
    this.stage = stage;
    this.detail = detail;
  }
}

/** Raised when the operator stops while a device wait is in progress. */
export class RecoveryStopped extends StageError {
  constructor(message = "the operator stopped while waiting for recovery") {
    super("recovery", message);
    this.name = "RecoveryStopped";
    this.stopped = true;
  }
}

/**
 * How long a recovery wait tolerates TWRP not appearing, in milliseconds.
 *
 * Ten minutes, not three: the operator may have to reboot the device by hand and
 * then find Chrome's device chooser, so a human is inside this deadline. A short
 * deadline expired against a perfectly healthy TWRP that was simply waiting to be
 * granted. The wait stays bounded and shows a visible countdown, and a timeout
 * after a submitted unlock is recoverable in-page (see `state.unlockSubmitted`)
 * rather than by reloading the page and losing every verified artifact.
 *
 * Both recovery waits read this one constant so the page and the standalone
 * helper cannot drift apart again.
 */
export const RECOVERY_TIMEOUT_MS = 10 * 60 * 1000;
export const RECOVERY_POLL_INTERVAL_MS = 4000;

/**
 * Serialises recovery claims. A background poll and a user-granted permission
 * chooser must never open the same USB interface at the same time, so both run
 * their open/validate step through one lock.
 */
export function createMutex() {
  let tail = Promise.resolve();
  return {
    async run(fn) {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => { release = resolve; });
      await previous;
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/** Reads the receipt the recovery installer appends to, as key=value lines. */
export function parseReceipt(text) {
  const fields = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = /^(?<key>[a-z_]+)=(?<value>.*)$/.exec(line.trim());
    if (match) fields[match.groups.key] = match.groups.value;
  }
  return fields;
}

export async function readReceipt(adb, { attempts = 1, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await adb.shell(`cat ${RECEIPT_PATH} 2>/dev/null || true`);
    const fields = parseReceipt(result.stdout);
    if (Object.keys(fields).length > 0) return fields;
    if (attempt < attempts) await sleep(delayMs);
  }
  return {};
}

export async function readInstallLog(adb, { tail = 40 } = {}) {
  const result = await adb.shell(`tail -n ${tail} ${LOG_PATH} 2>/dev/null || true`);
  return result.stdout ?? "";
}

// ---------------------------------------------------------------------------
// Stage 1 — release inventory
// ---------------------------------------------------------------------------

export async function verifyReleaseInventory({ tag, sumsText, repository, mirrorBase, terminal }) {
  const prefix = assetPrefix(tag);
  let sums;
  let source;
  if (sumsText) {
    sums = parseSums(sumsText);
    source = "operator-supplied SHA256SUMS";
  } else {
    const fetched = await fetchSums(tag, { repository, mirrorBase });
    sums = fetched.sums;
    source = fetched.source;
  }
  const required = [`${prefix}-boot.img`, `${prefix}-ota-public-key.hex`];
  const missing = required.filter((name) => !sums.has(name));
  if (missing.length) {
    throw new StageError("release", `release inventory is missing: ${missing.join(", ")}`);
  }
  if (!sums.has(`${prefix}.ota.tar`)) {
    terminal?.warn("release has no signed OTA archive listed; an initial install does not need one");
  }
  terminal?.ok(`release inventory verified from ${source} (${sums.size} entries)`);
  return { sums, source, prefix };
}

// ---------------------------------------------------------------------------
// Stage 2/3 — device and identity
// ---------------------------------------------------------------------------

export async function readFastbootIdentity(client, terminal) {
  const read = async (name) => {
    try {
      return (await client.getVar(name)) ?? "";
    } catch (error) {
      terminal?.warn(`getvar:${name} → ${error.message}`);
      return "";
    }
  };
  const product = (await read("product")).trim();
  const unlockStatus = (await read("unlock_status")).trim();
  const lkBuild = (await read("lk_build_desc")).trim();
  const plBuild = (await read("pl_build_desc")).trim();
  const maxDownload = (await read("max-download-size")).trim();
  const serialRaw = (await read("serialno")).trim();
  const secure = (await read("secure")).trim();
  const rpmbState = (await read("rpmb_state")).trim();
  const identity = {
    product,
    unlockStatus,
    lkBuild,
    plBuild,
    maxDownload,
    serialRaw,
    secure,
    rpmbState,
    serialMasked: maskSerial(serialRaw),
    profile: profileForProduct(product),
  };
  terminal?.line(`product:        ${product || "not reported"}`);
  terminal?.line(`unlock_status:  ${unlockStatus || "not reported"}`);
  terminal?.line(`lk_build_desc:  ${lkBuild || "not reported"}`);
  terminal?.line(`pl_build_desc:  ${plBuild || "not reported"}`);
  terminal?.line(`secure:         ${secure || "not reported"}`);
  terminal?.line(`rpmb_state:     ${rpmbState || "not reported"}`);
  terminal?.line(`max-download:   ${maxDownload || "not reported"}`);
  terminal?.line(`device id:      ${identity.serialMasked} (masked; never logged in full)`);
  return identity;
}

/**
 * Assesses a fastboot identity for the gates that must hold before any write.
 *
 * `selectedBoard` is the board of the build actually selected for installation
 * (the resolved target or verified build metadata). It is null when no build has
 * been chosen yet, which is the "device only" case: nothing about the build can
 * be concluded, so no build-vs-device warning is made. A Biscuit-targeted build on
 * a Biscuit device therefore produces no warning at all — warning on every Biscuit
 * regardless of the selected build was misleading, because the real block for a
 * wrong build is the board-mismatch check in runInstall.
 */
export function assessIdentity(identity, terminal, { selectedBoard = null } = {}) {
  const findings = [];
  if (!identity.serialRaw) findings.push("fastboot serialno is missing; cannot bind recovery to this device");
  if (!identity.profile) {
    findings.push(
      `fastboot product ${identity.product || "(empty)"} is not a LibreEcho target. The installer only supports RADAR and BISCUIT.`,
    );
  } else {
    terminal?.ok(`recognised target: ${identity.profile.marketing} (${identity.profile.board})`);
    const board = String(selectedBoard ?? "").trim();
    if (board && !boardMatches(board, identity.profile.board)) {
      terminal?.warn(
        `the selected build targets ${board}, but this device reports ${identity.profile.board}; `
        + "install is blocked until you choose the build for this device.",
      );
    }
  }
  const unlockStatus = String(identity.unlockStatus ?? "").trim().toLowerCase();
  const unlocked = /^(true|unlocked|yes|1)$/.test(unlockStatus);
  if (!unlocked && !/^(false|locked|no|0)$/.test(unlockStatus)) {
    findings.push("unlock_status was not a recognised true/false value; refusing an unlock write");
  }
  return { unlocked, findings };
}

// ---------------------------------------------------------------------------
// Stage 4 — unlock
// ---------------------------------------------------------------------------

/**
 * Ask an already-unlocked Echo sitting in fastboot to restart into TWRP.
 *
 * Kaeru (the unlocked LK on both supported Echos) implements the standard
 * `reboot-recovery` target: it writes the `boot-recovery` command into the misc
 * partition's bootloader message and resets, and LK consumes that command on the
 * next boot. Nothing else is written, in particular not expdb, where Kaeru lives.
 *
 * Without this an unlocked device skips the unlock stage (whose payload is what
 * normally restarts the Echo) and the page waits for a TWRP nothing asked for.
 *
 * @returns {Promise<{requested: boolean, reason?: string}>} requested=false means
 *   the bootloader explicitly refused, so the operator must start TWRP by hand.
 */
export async function requestRecoveryReboot({ client, terminal }) {
  if (!client || typeof client.reboot !== "function") {
    return { requested: false, reason: "no fastboot connection to send the restart through" };
  }
  terminal?.command("fastboot reboot-recovery");
  try {
    await client.reboot("recovery");
  } catch (error) {
    const detail = String(error?.message ?? error);
    // Only an explicit FAIL is a refusal. A reset racing the reply surfaces as a
    // transfer or timeout error, which is the expected way this command ends.
    if (error?.name === "FastbootFailError") {
      terminal?.warn(`the bootloader refused reboot-recovery: ${detail}`);
      return { requested: false, reason: detail };
    }
    terminal?.line(`the connection closed while restarting (${detail}); this is expected`);
  }
  terminal?.ok("restart into TWRP requested");
  return { requested: true };
}

/**
 * Submits the fastbrick payload to `brick`. The community host scripts treat a
 * timeout as the success signal, because the device stops answering fastboot
 * while the payload runs. That ambiguity is surfaced, never retried silently:
 * a timeout is reported as an unknown outcome, which is a stop condition.
 */
export async function submitUnlockPayload({ client, profile, lkBuild, payloadBytes, payloadName, serialRaw, terminal, onSubmit = null }) {
  if (!profile) throw new StageError("unlock", "device is not a recognised LibreEcho target");
  const selection = payloadForProfile(profile, lkBuild);
  if (!selection || !selection.sha256 || !Number.isSafeInteger(selection.size)) {
    throw new StageError("unlock", `no pinned unlock payload is declared for LK build description "${lkBuild}"`);
  }
  if (!(payloadBytes instanceof Uint8Array) || payloadName !== selection.payload || payloadBytes.length !== selection.size) {
    throw new StageError("unlock", `unlock payload must be ${selection.payload} with pinned size ${selection.size}`);
  }
  const digest = await sha256Bytes(payloadBytes);
  if (digest !== selection.sha256) {
    throw new StageError("unlock", `unlock payload digest mismatch for ${selection.payload}`);
  }
  if (!serialRaw || typeof localStorage === "undefined") {
    throw new StageError("unlock", "persistent device-bound unlock attempt storage is unavailable");
  }
  // Two durable guards, both written and checked in the same fail-closed block.
  //
  // The digest key keeps the guard precise: exactly this payload for this device
  // has already been sent.
  //
  // The serial key is the coarse backstop the page-session latch cannot provide:
  // the latch lives in memory, so a reload loses it, while a partially applied
  // flash:brick writes lk_b and can bring the device back to fastboot LOCKED
  // reporting a DIFFERENT lk_build_desc. A different build means a different
  // digest means a different digest key — which would let flash:brick go out a
  // second time. The serial key cannot be re-keyed by anything the device does,
  // and it is scoped to one serial, so a different device is unaffected.
  const digestKey = `libreecho.unlock.${await sha256Bytes(new TextEncoder().encode(`${serialRaw}:${profile.id}:${digest}`))}`;
  const serialKey = `libreecho.unlock.sent.${await sha256Bytes(new TextEncoder().encode(String(serialRaw)))}`;
  try {
    if (localStorage.getItem(digestKey) || localStorage.getItem(serialKey)) {
      throw new StageError("unlock", "unlock attempt already submitted; do not re-submit");
    }
    // Persist BEFORE sending, because a disconnect, new tab or reload has an unknown outcome.
    localStorage.setItem(digestKey, "submitted-or-unknown");
    localStorage.setItem(serialKey, "submitted-or-unknown");
  } catch (error) {
    if (error instanceof StageError) throw error;
    throw new StageError("unlock", "cannot persist the single-submission guard");
  }
  terminal?.command(`fastboot flash brick <${selection.payload}>`);
  // Latch BEFORE the write, not after it. Every failure mode of `flash` leaves an
  // unknown outcome — including a synchronous throw from the client — so a latch
  // taken after the await would be skipped exactly when it matters most, and a
  // second Run would submit `brick` again against a device whose unlock state is
  // unknown. The caller's latch must be set before any byte can leave the host.
  try { onSubmit?.(serialRaw); } catch { /* the latch must never block the write it protects */ }
  try {
    // Single whole-image download, never chunk this AMNT payload into buffers.
    await client.flash("brick", payloadBytes, {
      singleDownload: true,
      onProgress: (sent, total) => terminal?.progress("submitting unlock payload", sent / total, `${sent} / ${total} bytes`),
      onInfo: (line) => terminal?.line(line),
    });
    terminal?.endProgress();
    terminal?.warn("payload command returned; unlock state requires recovery and readback verification");
    return { outcome: "unknown" };
  } catch (error) {
    terminal?.endProgress();
    const detail = String(error.message ?? error);
    if (/Device mismatch|eMMC-RO/i.test(detail)) {
      throw new StageError("unlock", `payload explicitly refused the device: ${detail}`);
    }
    terminal?.warn(`unlock submission outcome UNKNOWN (${detail}); do not re-submit`);
    return { outcome: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — recovery
// ---------------------------------------------------------------------------

export async function readKaeruHeader(adb) {
  const meta = await adb.shell("cat /sys/class/block/mmcblk0p7/uevent");
  const sectors = await adb.shell("cat /sys/class/block/mmcblk0p7/size");
  if (!/^PARTNAME=expdb$/m.test(meta.stdout ?? "") || (sectors.stdout ?? "").trim() !== "20480") {
    throw new StageError("recovery", "expdb identity or geometry is not the pinned Kaeru partition");
  }
  const bytes = await adb.shell("dd if=/dev/block/mmcblk0p7 bs=16 count=1 2>/dev/null | od -An -tx1");
  const fields = (bytes.stdout ?? "").trim().split(/\s+/);
  if (fields.length !== 16 || fields.some((field) => !/^[0-9a-fA-F]{2}$/.test(field))) {
    throw new StageError("recovery", "cannot read the complete expdb Kaeru header");
  }
  const hex = fields.join("").toLowerCase();
  if (hex.startsWith("46415354424f4f545f504c45415345")) {
    throw new StageError("recovery", "FASTBOOT_PLEASE has overwritten the expdb Kaeru header");
  }
  if (!hex.startsWith("88168858") || hex.slice(16, 20) !== "4c4b") {
    throw new StageError("recovery", "expdb does not contain the expected Kaeru LK header");
  }
  return hex;
}

/**
 * Probes an opened ADB session and refuses it unless it is the selected TWRP
 * device: TWRP must be running, the serial must match the frozen fastboot
 * serial, and (when a board is known) the reported board must match. Only then
 * is the existing Kaeru expdb check run, and its header is returned for the
 * caller's before/after comparison.
 */
export async function validateRecoverySession({ client, expectedSerial, expectedBoard = "", terminal } = {}) {
  const probe = await client.shell("getprop ro.twrp.version; getprop ro.product.device; getprop ro.serialno");
  const lines = String(probe?.stdout ?? "").split(/\r?\n/).map((line) => line.trim());
  const [twrpVersion = "", device = "", serial = ""] = lines;
  terminal?.line(`adb probe: twrp=${twrpVersion || "(none)"} device=${device || "(none)"} serial=${maskSerial(serial)}`);
  if (!/^\d/.test(twrpVersion)) {
    throw new StageError("recovery", "ADB answered but TWRP is not running on the selected device");
  }
  if (!expectedSerial || serial !== expectedSerial) {
    throw new StageError("recovery", `recovery serial ${maskSerial(serial)} does not match the selected fastboot device`);
  }
  if (expectedBoard && !boardMatches(device, expectedBoard)) {
    throw new StageError("recovery", `recovery board ${device || "(none)"} does not match the selected ${expectedBoard}`);
  }
  const header = await readKaeruHeader(client);
  return { twrpVersion, device, serial, header };
}

function normaliseBoard(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Explicit board identity aliases for the recovery environment: the boot chain's
 * product string and TWRP's `ro.product.device` are not spelled identically for
 * every build, so an empty or clearly different board is refused while a
 * documented alias (radar_puffin vs radar) is accepted, never a substring.
 */
export function boardMatches(observed, expected) {
  const a = normaliseBoard(observed);
  const b = normaliseBoard(expected);
  if (!a || !b) return false;
  return a === b || (["radar", "radar_puffin"].includes(a) && ["radar", "radar_puffin"].includes(b));
}

/**
 * @deprecated Not used by the page. The install's recovery wait is
 * `awaitRecovery` in app.js, which polls already-granted devices through
 * `pollGrantedRecovery` with the descriptor-serial pre-filter, the single-owner
 * claim registry and the 10-minute `RECOVERY_TIMEOUT_MS` deadline. This helper
 * has none of those: it calls `reattachAdb`, which opens EVERY granted device and
 * shells `getprop ro.serialno` — reintroducing verbatim the defect the page's
 * poll path removes (a second ADB open on an unrelated granted device, which is
 * the interleaved-CNXN failure). Kept exported only because
 * js/test_safety.mjs still imports it; do not add a production caller.
 *
 * Waits for a previously authorised TWRP device over ADB. A changed USB
 * identity may require a separate user-gesture permission grant. This helper
 * never opens a chooser from its polling loop. The wait
 * is cancellable: `signal` (an AbortSignal) or `isCancelled()` stops it promptly.
 */
export async function waitForRecovery({ timeoutMs = RECOVERY_TIMEOUT_MS, intervalMs = RECOVERY_POLL_INTERVAL_MS, terminal,
  adbDevice = null, expectedSerial = "", expectedBoard = "", openSession = null,
  signal = null, isCancelled = null } = {}) {
  const { reattachAdb } = await import("./transports.js");
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    if (isCancelled?.() || signal?.aborted) throw new RecoveryStopped();
    if (Date.now() >= deadline) break;
    attempt += 1;
    let session = null;
    try {
      session = openSession
        ? await openSession()
        : adbDevice
          ? await openAdb({ device: adbDevice, onLog: (line) => terminal?.line(line) })
          : await reattachAdb({ timeoutMs: Math.min(intervalMs * 3, 12000), expectedSerial, onLog: null });
      if (!session) { await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now()))); continue; }
      const validated = await validateRecoverySession({ client: session.client, expectedSerial, expectedBoard, terminal });
      terminal?.ok(`TWRP ${validated.twrpVersion} is reachable over ADB on the selected device`);
      session.validated = validated;
      return session;
    } catch (error) {
      if (error instanceof RecoveryStopped) throw error;
      if (attempt === 1 || attempt % 5 === 0) {
        terminal?.line(`waiting for the selected recovery (${Math.round(Math.max(0, deadline - Date.now()) / 1000)}s left): ${error.message}`);
      }
      try { await (session?.client?.close?.() ?? session?.close?.()); } catch { /* disconnect during mode change */ }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new StageError("recovery", "timed out waiting for TWRP on the selected serial");
}

// ---------------------------------------------------------------------------
// Stage 6 — stage the bundle
// ---------------------------------------------------------------------------

/**
 * Conservative reserve added to the exact push set before comparing against the
 * device's free /cache space. Documented, not measured per device: it covers
 * ext4 block rounding for every pushed file, the staging directory entry, and
 * the recovery installer's own scratch and receipt writes in /cache. It is
 * deliberately generous rather than tight.
 */
export const CACHE_STAGING_OVERHEAD_BYTES = 4 * 1024 * 1024;

/** Exact bytes to push, plus the documented staging reserve, for the selected files. */
export function cachePreflightBytes({ files, sums } = {}) {
  const names = [...(sums?.keys() ?? [])].filter((name) => files?.has(name));
  if (names.length === 0) throw new StageError("stage", "no verified bundle files were provided");
  let pushBytes = 0;
  for (const name of names) {
    const size = Number(files.get(name)?.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new StageError("stage", `${name}: file size is unknown; cannot size the /cache preflight`);
    }
    pushBytes += size;
  }
  if (!Number.isSafeInteger(pushBytes + CACHE_STAGING_OVERHEAD_BYTES)) throw new StageError("stage", "bundle exceeds safe cache size accounting");
  return { pushBytes, fileCount: names.length, neededBytes: pushBytes + CACHE_STAGING_OVERHEAD_BYTES };
}

/**
 * Parses `df -Pk <path>` output and returns free bytes. It fails closed: an
 * unreadable or malformed row throws rather than being treated as free space.
 */
export function parseCacheFreeBytes(text, path = "/cache") {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.filter(line => !/^filesystem\b/i.test(line));
  if (rows.length !== 1) throw new StageError("stage", `df ${path} returned an ambiguous filesystem result`);
  for (const line of rows) {
    if (/^filesystem\b/i.test(line)) continue;
    const columns = line.split(/\s+/);
    if (columns.length !== 6 || columns[5] !== path || !/^\d+%$/.test(columns[4])) continue;
    // POSIX `df -P`: Filesystem, 1024-blocks, Used, Available, Capacity, Mounted on.
    if (!/^\d+$/.test(columns[1]) || !/^\d+$/.test(columns[2]) || !/^\d+$/.test(columns[3])) continue;
    const [total, used, free] = columns.slice(1, 4).map(Number);
    if (![total, used, free, free * 1024].every(Number.isSafeInteger) || used > total || free > total || Number(columns[4].slice(0, -1)) > 100) continue;
    return free * 1024;
  }
  throw new StageError("stage", `df ${path} returned no readable filesystem row`);
}

/**
 * Reads `df -Pk /cache` from the recovery ADB session and refuses to stage
 * anything unless the free space covers the exact push set plus the documented
 * overhead. It never deletes device files and never falls back to /data or
 * /sdcard (which recovery shares with /data).
 */
export async function preflightCache({ adb, files, sums, terminal, path = "/cache" } = {}) {
  if (path !== "/cache") throw new StageError("stage", "only /cache staging is permitted");
  if (!adb) throw new StageError("stage", "the /cache preflight needs a recovery ADB session");
  const sizing = cachePreflightBytes({ files, sums });
  let output;
  try {
    output = await adb.shell(`df -Pk ${path} 2>&1 || true`);
  } catch (error) {
    throw new StageError("stage", `${path} free space could not be read (${error.message}); nothing was pushed`);
  }
  let freeBytes;
  try {
    freeBytes = parseCacheFreeBytes(output?.stdout, path);
  } catch {
    terminal?.error(`cannot measure free space on ${path}; refusing to create or push the bundle`);
    throw new StageError("stage", `${path} free space could not be read; refusing to create or push the bundle`);
  }
  if (freeBytes < sizing.neededBytes) {
    terminal?.error(`${path} has ${freeBytes} bytes free but the bundle needs ${sizing.neededBytes}`);
    throw new StageError("stage",
      `${path} has ${freeBytes} bytes free but the bundle needs ${sizing.neededBytes} `
      + `(${sizing.pushBytes} bytes of files + ${CACHE_STAGING_OVERHEAD_BYTES} bytes staging overhead); `
      + "no files were pushed and nothing on the device was deleted");
  }
  terminal?.info(`${path}: ${freeBytes} bytes free, ${sizing.neededBytes} needed `
    + `(${sizing.fileCount} files, ${sizing.pushBytes} bytes + ${CACHE_STAGING_OVERHEAD_BYTES} overhead)`);
  return { freeBytes, ...sizing };
}

export async function pushBundle({ adb, files, sums, terminal, onProgress }) {
  const names = [...sums.keys()].filter((name) => files.has(name));
  if (names.length === 0) throw new StageError("stage", "no verified bundle files were provided");
  // Validate every byte before the first device-side mkdir or push.
  for (const name of names) {
    const digest = await sha256Blob(files.get(name));
    if (digest !== sums.get(name)) {
      throw new StageError("stage", `${name}: digest mismatch before ADB push`);
    }
  }
  // Measure free /cache from the exact push set before creating or writing anything.
  await preflightCache({ adb, files, sums, terminal });
  await adb.shell(`mkdir -p ${BUNDLE_DIR}`);
  let pushed = 0;
  let totalBytes = 0;
  for (const name of names) totalBytes += files.get(name).size;
  for (const name of names) {
    const file = files.get(name);
    const remote = `${BUNDLE_DIR}/${name}`;
    terminal?.command(`adb push ${name} → ${remote} (${(file.size / 1048576).toFixed(1)} MiB)`);
    await adb.push(remote, file, {
      // onProgress from the ADB client is ({ sent, total }).
      onProgress: ({ sent, total }) => {
        const overall = (pushed + sent) / totalBytes;
        terminal?.progress(
          `pushing ${name}`,
          overall,
          `${(overall * totalBytes / 1048576).toFixed(0)} / ${(totalBytes / 1048576).toFixed(0)} MiB`,
        );
        if (onProgress) onProgress(overall);
        void total;
      },
    });
    pushed += file.size;
    terminal?.ok(`pushed ${name}`);
  }
  terminal?.endProgress();
  return { pushedBytes: totalBytes, fileCount: names.length };
}

/** Re-hashes the pushed files on the device and compares with the release digests. */
export async function verifyStagedBundle({ adb, sums, files, terminal }) {
  const names = [...sums.keys()].filter((name) => files.has(name));
  const mismatches = [];
  terminal?.info(`verifying ${names.length} pushed file(s) on the device with sha256sum`);
  for (const name of names) {
    const result = await adb.shell(`sha256sum ${BUNDLE_DIR}/${name} 2>/dev/null || true`);
    const actual = /^([0-9a-f]{64})/.exec((result.stdout ?? "").trim())?.[1] ?? "";
    const expected = sums.get(name);
    if (actual !== expected) mismatches.push({ name, expected, actual });
  }
  if (mismatches.length) {
    for (const item of mismatches) {
      terminal?.error(`${item.name}: device ${item.actual || "(no digest)"} != release ${item.expected}`);
    }
    throw new StageError("stage", `${mismatches.length} pushed file(s) do not match the release digests on the device`);
  }
  terminal?.ok("every pushed file matches its release digest on the device");
  return { verified: names.length };
}

// ---------------------------------------------------------------------------
// Stage 7/8 — run the recovery installer phases
// ---------------------------------------------------------------------------

/**
 * Runs the installer zip once and reads the receipt. The zip decides for itself
 * whether it is reshaping userdata (prepare) or installing: it measures the
 * partition against the image contract. The host's job is only to run it, read
 * the receipt, and reboot between the two runs when asked.
 *
 * The ZIP basename comes from the verified target (the legacy alias or the
 * combined release's `libreecho-<slug>-install.zip`) and is whitelisted here, so
 * a name that was not one of the target's verified recovery members can never be
 * handed to `twrp install`.
 */
export async function runRecoveryPhase({ adb, tag, serialRaw, phase = "prepare",
  zipName = null, allowZipNames = null }, { dryRun = false, terminal } = {}) {
  if (dryRun) {
    terminal?.info("rehearsal is host-only; no recovery command was issued");
    return { result: "rehearsal", writes_performed: [] };
  }
  if (!serialRaw || !tag || !["prepare", "install"].includes(phase) || typeof localStorage === "undefined") {
    throw new StageError("install", "persistent device-bound recovery attempt storage is unavailable");
  }
  const chosen = zipName ?? "libreecho-install.zip";
  const allowed = Array.isArray(allowZipNames) || allowZipNames instanceof Set ? new Set(allowZipNames) : null;
  if (typeof chosen !== "string" || !/^libreecho-(?:(?:radar-puffin|biscuit)-)?install\.zip$/.test(chosen)) {
    throw new StageError("install", `refusing to run an unsafe recovery ZIP name: ${chosen}`);
  }
  if (allowed && !allowed.has(chosen)) {
    throw new StageError("install", `refusing a recovery ZIP that is not a verified member of the selected target: ${chosen}`);
  }
  const key = `libreecho.recovery.${await sha256Bytes(new TextEncoder().encode(`${serialRaw}:${tag}:${phase}`))}`;
  try {
    if (localStorage.getItem(key)) throw new StageError("install", `${phase} ZIP already attempted; classify the device and receipt before any repeat`);
    localStorage.setItem(key, "pending-or-completed");
  } catch (error) {
    if (error instanceof StageError) throw error;
    throw new StageError("install", "cannot persist the recovery attempt guard");
  }
  const zip = `${BUNDLE_DIR}/${chosen}`;
  await adb.shell(`rm -f ${DRY_RUN_FLAG} ${RECEIPT_PATH}`);
  terminal?.command(`twrp install ${zip}`);
  const result = await adb.shell(
    `twrp install ${zip} 2>&1; echo "__RECEIPT__"; cat ${RECEIPT_PATH} 2>/dev/null || true`,
    { onOutput: (chunk) => terminal?.line(chunk) },
  );
  const [output, receiptText] = String(result.stdout ?? "").split("__RECEIPT__");
  if (output?.trim()) {
    for (const line of output.trim().split(/\r?\n/)) terminal?.line(line);
  }
  const receipt = parseReceipt(receiptText);
  if (!receipt.result) {
    const log = await readInstallLog(adb);
    terminal?.warn(`no receipt was written; last installer log lines follow`);
    for (const line of log.trim().split(/\r?\n/).slice(-12)) terminal?.line(line);
    throw new StageError("install", "the recovery installer did not write a receipt");
  }
  terminal?.ok(`receipt: ${Object.entries(receipt).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  return receipt;
}

export async function rebootAndWait({ adb, target = "recovery", terminal, settleMs = 8000 }) {
  const command = target === "recovery" ? "/sbin/twrp reboot recovery" : "/sbin/twrp reboot";
  terminal?.command(command);
  try {
    await adb.shell(command);
  } catch (error) {
    terminal?.warn(`reboot transport disconnected or failed: ${error.message}; the next device state is unverified`);
  }
  terminal?.info("reboot requested; a new serial-bound session is required before any further write");
  await sleep(settleMs);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export class InstallerRun {
  constructor({ terminal, context }) {
    this.terminal = terminal;
    this.context = context;
    this.state = { stage: "idle", identity: null, receipts: [] };
  }

  log(message) {
    this.terminal.line(message);
  }
}
