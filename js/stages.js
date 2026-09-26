// Install stages for the browser one-shot installer.
//
// The stage list mirrors the reviewed host installer contract:
//
//   release   verify the published release inventory
//   device    find the device in fastboot (WebUSB permission prompt)
//   identity  read product / unlock_status / LK build description
//   unlock    submit the per-LK fastbrick payload to `brick` (no case opening)
//   recovery  wait for TWRP and connect over ADB
//   stage     push the verified bundle to /cache/libreecho-bundle
//   prepare   run the recovery installer; it reshapes userdata and reboots
//   install   run it again after the reboot: format, boot slots, features
//   verify    reboot and confirm the device is reachable
//
// The page's recovery stages are narrower than the fastbrick unlock: the
// build-selected fastbrick payload itself writes preloader/LK/TEE/RPMB/Kaeru.
// No install write is enabled until the board, exact ZIP and marker-safe boot
// image are positively qualified. Never write FASTBOOT_PLEASE to expdb.

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
  { id: "stage", title: "Push the verified bundle to /cache" },
  { id: "prepare", title: "Run the prepare phase" },
  { id: "install", title: "Run the install phase" },
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

export function assessIdentity(identity, terminal) {
  const findings = [];
  if (!identity.serialRaw) findings.push("fastboot serialno is missing; cannot bind recovery to this device");
  if (!identity.profile) {
    findings.push(
      `fastboot product ${identity.product || "(empty)"} is not a LibreEcho target. The installer only supports RADAR and BISCUIT.`,
    );
  } else {
    terminal?.ok(`recognised target: ${identity.profile.marketing} (${identity.profile.board})`);
    if (identity.profile.id === "biscuit") {
      terminal?.warn(
        "Radar LibreEcho images can run experimentally on Biscuit, but no marker-safe Biscuit-qualified one-shot image is published.",
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
 * Submits the fastbrick payload to `brick`. The community host scripts treat a
 * timeout as the success signal, because the device stops answering fastboot
 * while the payload runs. That ambiguity is surfaced, never retried silently:
 * a timeout is reported as an unknown outcome, which is a stop condition.
 */
export async function submitUnlockPayload({ client, profile, lkBuild, payloadBytes, payloadName, serialRaw, terminal }) {
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
  const key = `libreecho.unlock.${await sha256Bytes(new TextEncoder().encode(`${serialRaw}:${profile.id}:${digest}`))}`;
  try {
    if (localStorage.getItem(key)) throw new StageError("unlock", "unlock attempt already submitted; do not re-submit");
    // Persist BEFORE sending, because a disconnect, new tab or reload has an unknown outcome.
    localStorage.setItem(key, "submitted-or-unknown");
  } catch (error) {
    if (error instanceof StageError) throw error;
    throw new StageError("unlock", "cannot persist the single-submission guard");
  }
  terminal?.command(`fastboot flash brick <${selection.payload}>`);
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
  const bytes = await adb.shell("dd if=/dev/mmcblk0p7 bs=16 count=1 2>/dev/null | od -An -tx1");
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
 * Waits for TWRP to appear over ADB. The browser keeps the USB permission it
 * was granted, so re-attachment after a USB mode change needs no new prompt;
 * the device chooser is only used when nothing has been granted yet.
 */
export async function waitForRecovery({ timeoutMs = 180000, intervalMs = 4000, terminal,
  adbDevice = null, expectedSerial = "", openSession = null } = {}) {
  const { reattachAdb } = await import("./transports.js");
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const session = openSession
        ? await openSession()
        : adbDevice
          ? await openAdb({ device: adbDevice, onLog: (line) => terminal?.line(line) })
          : await reattachAdb({ timeoutMs: Math.min(intervalMs * 3, 12000), expectedSerial, onLog: null });
      const probe = await session.client.shell("getprop ro.twrp.version; getprop ro.product.device; getprop ro.serialno");
      const lines = String(probe.stdout ?? "").split(/\r?\n/).map((line) => line.trim());
      const [twrpVersion = "", device = "", serial = ""] = lines;
      terminal?.line(`adb probe ${attempt}: twrp=${twrpVersion || "(none)"} device=${device || "(none)"} serial=${maskSerial(serial)}`);
      if (/^\d/.test(twrpVersion) && expectedSerial && serial === expectedSerial) {
        terminal?.ok(`TWRP ${twrpVersion} is reachable over ADB on the selected device`);
        return session;
      }
      terminal?.warn("ADB answered but TWRP or serial did not match the selected fastboot device");
      await session.client.close();
    } catch (error) {
      if (attempt === 1 || attempt % 5 === 0) {
        terminal?.line(`waiting for the selected recovery (${Math.round((deadline - Date.now()) / 1000)}s left): ${error.message}`);
      }
    }
    await sleep(intervalMs);
  }
  throw new StageError("recovery", "timed out waiting for TWRP on the selected serial");
}

// ---------------------------------------------------------------------------
// Stage 6 — stage the bundle
// ---------------------------------------------------------------------------

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
 */
export async function runRecoveryPhase({ adb, tag, serialRaw, phase = "prepare" }, { dryRun = false, terminal } = {}) {
  if (dryRun) {
    terminal?.info("rehearsal is host-only; no recovery command was issued");
    return { result: "rehearsal", writes_performed: [] };
  }
  if (!serialRaw || !tag || !["prepare", "install"].includes(phase) || typeof localStorage === "undefined") {
    throw new StageError("install", "persistent device-bound recovery attempt storage is unavailable");
  }
  const key = `libreecho.recovery.${await sha256Bytes(new TextEncoder().encode(`${serialRaw}:${tag}:${phase}`))}`;
  try {
    if (localStorage.getItem(key)) throw new StageError("install", `${phase} ZIP already attempted; classify the device and receipt before any repeat`);
    localStorage.setItem(key, "pending-or-completed");
  } catch (error) {
    if (error instanceof StageError) throw error;
    throw new StageError("install", "cannot persist the recovery attempt guard");
  }
  const zip = `${BUNDLE_DIR}/libreecho-install.zip`;
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
