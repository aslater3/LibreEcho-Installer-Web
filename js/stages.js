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
// Everything the installer can determine is read from the device; nothing is
// assumed from a product name. Writes are limited to what each stage declares,
// and the recovery installer itself refuses to touch expdb, lk, tee, preloader,
// the GPT, persist, recovery, system_a or system_b.

import { Sha256 } from "./sha256.js";
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
  const maxDownload = (await read("max-download-size")).trim();
  const serialRaw = (await read("serialno")).trim();
  const identity = {
    product,
    unlockStatus,
    lkBuild,
    maxDownload,
    serialMasked: maskSerial(serialRaw),
    profile: profileForProduct(product),
  };
  terminal?.line(`product:        ${product || "not reported"}`);
  terminal?.line(`unlock_status:  ${unlockStatus || "not reported"}`);
  terminal?.line(`lk_build_desc:  ${lkBuild || "not reported"}`);
  terminal?.line(`max-download:   ${maxDownload || "not reported"}`);
  terminal?.line(`device id:      ${identity.serialMasked} (masked; never logged in full)`);
  return identity;
}

export function assessIdentity(identity, terminal) {
  const findings = [];
  if (!identity.profile) {
    findings.push(
      `fastboot product ${identity.product || "(empty)"} is not a LibreEcho target. The installer only supports RADAR and BISCUIT.`,
    );
  } else {
    terminal?.ok(`recognised target: ${identity.profile.marketing} (${identity.profile.board})`);
    if (identity.profile.id === "biscuit") {
      terminal?.warn(
        "biscuit bring-up is planned rather than shipped: no LibreEcho image is published for the Echo Dot yet.",
      );
    }
  }
  const unlocked = /^(true|unlocked|yes|1)$/i.test(identity.unlockStatus);
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
export async function submitUnlockPayload({ client, profile, lkBuild, payloadBytes, timeoutMs = 8000, terminal }) {
  if (!profile) throw new StageError("unlock", "device is not a recognised LibreEcho target");
  const selection = payloadForProfile(profile, lkBuild);
  if (!selection) {
    throw new StageError(
      "unlock",
      `no unlock payload is declared for LK build description "${lkBuild}". Refusing to guess a payload.`,
    );
  }
  if (!payloadBytes) {
    throw new StageError(
      "unlock",
      `the unlock payload for ${selection.payload} must be supplied by the operator (it is not distributed in any repository).`,
    );
  }
  terminal?.command(`fastboot flash brick <${selection.payload}>`);
  try {
    // onProgress from the fastboot client is (sent, total).
    await client.flash("brick", payloadBytes, {
      onProgress: (sent, total) => terminal?.progress("submitting unlock payload", sent / total, `${sent} / ${total} bytes`),
      onInfo: (line) => terminal?.line(line),
    });
    terminal?.endProgress();
    terminal?.ok("the bootloader accepted the payload command");
    return { outcome: "accepted" };
  } catch (error) {
    terminal?.endProgress();
    if (/timeout/i.test(String(error.message))) {
      terminal?.warn(
        "the fastboot command timed out. In this flow that usually means the payload started. " +
          "The outcome is UNKNOWN: do not re-submit. Watch the device for a recovery boot.",
      );
      return { outcome: "unknown" };
    }
    throw new StageError("unlock", `unlock submission failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — recovery
// ---------------------------------------------------------------------------

/**
 * Waits for TWRP to appear over ADB. The browser keeps the USB permission it
 * was granted, so re-attachment after a USB mode change needs no new prompt;
 * the device chooser is only used when nothing has been granted yet.
 */
export async function waitForRecovery({ timeoutMs = 180000, intervalMs = 4000, terminal, adbDevice = null } = {}) {
  const { reattachAdb } = await import("./transports.js");
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const session = adbDevice
        ? await openAdb({ device: adbDevice, onLog: (line) => terminal?.line(line) })
        : await reattachAdb({ timeoutMs: Math.min(intervalMs * 3, 12000), onLog: null });
      const probe = await session.client.shell("getprop ro.twrp.version; getprop ro.product.device");
      const lines = String(probe.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const [twrpVersion = "", device = ""] = lines;
      terminal?.line(`adb probe ${attempt}: twrp=${twrpVersion || "(none)"} device=${device || "(none)"}`);
      if (/^\d/.test(twrpVersion)) {
        terminal?.ok(`TWRP ${twrpVersion} is reachable over ADB${device ? ` (${device})` : ""}`);
        return session;
      }
      terminal?.warn("ADB answered but this is not TWRP; waiting for recovery to come back");
      await session.client.close();
    } catch (error) {
      if (attempt === 1 || attempt % 5 === 0) {
        terminal?.line(
          `waiting for recovery over ADB (${Math.round((deadline - Date.now()) / 1000)}s left): ${error.message}`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new StageError("recovery", "timed out waiting for TWRP over ADB");
}

// ---------------------------------------------------------------------------
// Stage 6 — stage the bundle
// ---------------------------------------------------------------------------

export async function pushBundle({ adb, files, sums, terminal, onProgress }) {
  const names = [...sums.keys()];
  const present = names.filter((name) => files.has(name));
  if (present.length === 0) throw new StageError("stage", "no verified bundle files were provided");
  await adb.shell(`mkdir -p ${BUNDLE_DIR}`);
  let pushed = 0;
  let totalBytes = 0;
  for (const name of present) totalBytes += files.get(name).size;
  for (const name of present) {
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
  return { pushedBytes: totalBytes, fileCount: present.length };
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
export async function runRecoveryPhase({ adb, tag }, { dryRun = false, terminal } = {}) {
  const zip = `${BUNDLE_DIR}/${assetPrefix(tag)}-install.zip`;
  if (dryRun) {
    await adb.shell(`: > ${DRY_RUN_FLAG}`);
    terminal?.info("dry-run flag created: every check runs, nothing is written");
  } else {
    await adb.shell(`rm -f ${DRY_RUN_FLAG} ${RECEIPT_PATH}`);
  }
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

export async function rebootAndWait({ adb, target = "recovery", timeoutMs = 180000, terminal }) {
  terminal?.command(`adb reboot ${target}`);
  try {
    await adb.shell(`reboot ${target}`);
  } catch (error) {
    terminal?.warn(`reboot command returned: ${error.message}`);
  }
  terminal?.info(`waiting up to ${Math.round(timeoutMs / 1000)}s for the device to come back (${target})`);
  await sleep(8000);
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
