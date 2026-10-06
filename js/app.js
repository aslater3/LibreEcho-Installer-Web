// Browser one-shot installer — UI and run orchestration.
//
// Step order and safety rules mirror the reviewed host installer. Nothing is
// written until the release inventory, the device identity and the unlock
// payload (when needed) have all been read and checked; every stage reports what
// it verified, and a failed stage stops the run.

import { Terminal } from "./terminal.js";
import { webusbSupport, describeUsbDevice, requestRecoveryDevice, recoveryChooserFilters, maskSerial, MODES, classifyDevice } from "./device.js";
import { protocolSupport, openFastboot, openAdb, grantedAdbDevices } from "./transports.js";
import {
  installerConfig,
  fetchReleaseIndex,
  verifyBundleFiles,
  sha256OfBlob,
  parseSums,
  releasePageUrl,
  amonetArchiveUrl,
} from "./release.js";
import { STAGES, StageError, RecoveryStopped, createMutex, validateRecoverySession, readFastbootIdentity, assessIdentity, submitUnlockPayload, requestRecoveryReboot, readKaeruHeader, rebootAndWait, boardMatches, RECOVERY_TIMEOUT_MS, RECOVERY_POLL_INTERVAL_MS } from "./stages.js";
import { retireDirectPhaseGuards, DIRECT_PROTOCOL, DIRECT_INCOMING_DIR, DIRECT_RECEIPT_PATH, prepareDirectInstall, pushDirectControl, pushDirectPayloads, readLandedPayloads, runDirectPhase } from "./direct-install.js";
import { PROFILES, payloadForProfile } from "./profiles.js";
import {
  installableBoards,
  profileForBoard,
  isInstallableBoard,
  releaseOffersBoard,
  targetForBoard,
  inventoryNamesForTarget,
  requiredMembersForTarget,
  recoveryManifestNameForTarget,
  recoveryMembersForTarget,
  parseBundleManifest,
  targetsForRelease,
  releaseDeclaresTargets,
  targetsAssetName,
} from "./targets.js";
import { discoverMirror, fetchReleaseBundle, fetchTargetsJson, createBundleStore } from "./auto-fetch.js";
import { extractRecoveryMetadata } from "./recovery-metadata.js";
import { sha256Bytes } from "./sha256.js";
import {
  RESUME_JOURNAL_KEY,
  browserStorage,
  readResumeJournal,
  writeResumeJournal,
  clearResumeJournal,
  classifyResumeState,
} from "./resume.js";
import { acquireWriterLock } from "./writer-lock.js";
import { reconcileDeviceResume } from "./resume-device.js";
import { formatSize, formatDuration, computeEta } from "./progress.js";
import { RUNNING_ADB_FILTERS, pollRunningEcho, sendSetupToRunningEcho } from "./post-install.js";
import {
  PROVISION_DEFAULTS, PROVISION_PATH,
  validateProvision, deliverProvision,
} from "./provision.js";

const config = installerConfig();

const dom = {
  terminal: document.getElementById("terminal"),
  capability: document.getElementById("capability"),
  deviceSelect: document.getElementById("device-select"),
  releaseSelect: document.getElementById("release-select"),
  releaseMeta: document.getElementById("release-meta"),
  downloadPanel: document.getElementById("download-panel"),
  downloadPhase: document.getElementById("download-phase"),
  downloadPercent: document.getElementById("download-percent"),
  downloadBar: document.getElementById("download-bar"),
  downloadBytes: document.getElementById("download-bytes"),
  downloadFiles: document.getElementById("download-files"),
  downloadEta: document.getElementById("download-eta"),
  downloadError: document.getElementById("download-error"),
  bundleInput: document.getElementById("bundle-input"),
  bundleFolderInput: document.getElementById("bundle-folder-input"),
  payloadInput: document.getElementById("payload-input"),
  archiveInput: document.getElementById("amonet-archive-input"),
  amonetPanel: document.getElementById("amonet-panel"),
  amonetRoute: document.getElementById("amonet-route"),
  statusRelease: document.getElementById("status-release"),
  statusBundle: document.getElementById("status-bundle"),
  statusDevice: document.getElementById("status-device"),
  statusPayload: document.getElementById("status-payload"),
  devicePanel: document.getElementById("device-panel"),
  connectResume: document.getElementById("btn-connect-resume"),
  connectHint: document.getElementById("connect-hint"),
  recoveryWait: document.getElementById("recovery-wait"),
  recoveryCountdown: document.getElementById("recovery-countdown"),
  continueFromTwrp: document.getElementById("btn-continue-twrp"),
  stepList: document.getElementById("step-list"),
  statusBar: document.getElementById("status-bar"),
  statusBarStage: document.getElementById("status-bar-stage"),
  statusBarTitle: document.getElementById("status-bar-title"),
  statusBarMessage: document.getElementById("status-bar-message"),
  statusBarProgress: document.getElementById("status-bar-progress"),
  statusBarFill: document.getElementById("status-bar-fill"),
  statusBarActionRow: document.getElementById("status-bar-action-row"),
  statusBarAction: document.getElementById("status-bar-action"),
  statusBarHint: document.getElementById("status-bar-hint"),
  statusBarSecondary: document.getElementById("status-bar-secondary"),
  capabilitySummary: document.getElementById("capability-summary"),
  prereqWrap: document.getElementById("install-prereq-wrap"),
  prereqList: document.getElementById("install-prereqs"),
  logCard: document.getElementById("log-card"),
  logToggle: document.getElementById("btn-log-toggle"),
  provisionFormWrap: document.getElementById("provision-form-wrap"),
  statusProvision: document.getElementById("status-provision"),
  provision: {
    modeSkip: document.getElementById("provision-mode-skip"),
    modeFill: document.getElementById("provision-mode-fill"),
    username: document.getElementById("provision-username"),
    password: document.getElementById("provision-password"),
    passwordConfirm: document.getElementById("provision-password-confirm"),
    ssid: document.getElementById("provision-ssid"),
    security: document.getElementById("provision-security"),
    wifiPassword: document.getElementById("provision-wifi-password"),
    hostname: document.getElementById("provision-hostname"),
    volume: document.getElementById("provision-volume"),
    volumeOutput: document.getElementById("provision-volume-output"),
    wakeWord: document.getElementById("provision-wake-word"),
    wakeSensitivity: document.getElementById("provision-wake-sensitivity"),
    sensitivityOutput: document.getElementById("provision-sensitivity-output"),
    localOnly: document.getElementById("provision-local-only"),
    telemetry: document.getElementById("provision-telemetry"),
    hostnamePreview: document.getElementById("provision-hostname-preview"),
  },
  buttons: {
    refresh: document.getElementById("btn-refresh"),
    download: document.getElementById("btn-download"),
    retry: document.getElementById("btn-retry"),
    verifyBundle: document.getElementById("btn-bundle"),
    connect: document.getElementById("btn-connect"),
    selectArchive: document.getElementById("btn-amonet-archive"),
    fetchArchive: document.getElementById("btn-fetch-amonet"),
    dryRun: document.getElementById("btn-dry-run"),
    run: document.getElementById("btn-run"),
    abort: document.getElementById("btn-abort"),
    recovery: document.getElementById("btn-recovery"),
    grantRecovery: document.getElementById("btn-grant-recovery"),
    recoveryEntry: document.getElementById("btn-recovery-entry"),
    connectAny: document.getElementById("btn-connect-any"),
  },
};

export const terminal = new Terminal(dom.terminal, {
  // Errors and warnings are mirrored into the sticky bar so nothing important
  // is only in the log — the operator reported exactly that problem (issue 14:
  // "basically silent unless you scroll back up").
  onLine: ({ kind, message }) => mirrorToStatusBar({ kind, message }),
});

export const state = {
  releases: [],
  release: null,
  board: null,
  target: null,
  targetsJson: null,
  sums: null,
  files: new Map(),
  payloadBytes: null,
  payloadName: "",
  fastboot: null,
  identity: null,
  deviceQueryEpoch: 0,
  adb: null,
  recoverySerial: null,
  kaeruHeader: null,
  receipts: [],
  bundleReady: false,
  bundleBoard: null,
  bundleHardwareAccepted: false,
  installProtocol: null,
  directRelease: null,
  directHelper: null,
  directManifestText: null,
  directManifestSha: null,
  directRoles: null,
  directTransferTotal: null,
  running: false,
  abort: false,
  fetchingBundle: false,
  downloadController: null,
  downloadedBundle: null,
  downloadTimer: null,
  recoveryWaiting: false,
  // false only when this run had to ask for TWRP and the bootloader refused, so
  // the page must not claim the Echo is restarting by itself.
  recoveryRestartRequested: true,
  recoveryDeadline: null,
  recoveryAbort: null,
  recoveryGrantInFlight: false,
  // True only after a narrow chooser produced a device that failed acceptance.
  // The next press then offers the wider VID:PID-only list — an explicit second
  // choice, never an automatic fallback, and never the unfiltered chooser.
  recoveryChooserWide: false,
  // Set by the silent already-granted probe; suppresses the permission button
  // entirely when this page already holds access for the selected device.
  recoveryAlreadyGranted: false,
  recoverySession: null,
  recoveryAcceptedEpoch: 0,
  recoveryEpoch: 0,
  // Set the moment this page session submits flash:brick, keyed to the serial.
  // A second Run click must never re-enter the unlock branch: assessIdentity still
  // reads the stale locked fastboot identity long after the payload was sent, so
  // the run would otherwise submit `brick` a second time against a device whose
  // unlock outcome is unknown. Never cleared by a run's `finally`.
  unlockSubmitted: null,
  // Step 5 (optional one-shot configuration). `provisionMode` is "skip" by
  // default, so an install never requires configuration. The collected form
  // lives here ONLY — never in localStorage/sessionStorage/IndexedDB — and is
  // wiped by clearProvisionSecrets() after delivery, on Stop, and on unload.
  provisionMode: "skip",
  // True once the operator has actually answered step 5 (either way). Skip is
  // the default, but a default is not an answer: until this is set the card
  // stays open, so the setup form is never hidden behind a collapsed card.
  provisionChosen: false,
  provisionForm: null,
  // "idle" | "skipped" | "delivered" | "failed" — the honest reportable state.
  provisionState: "idle",
  provisionDetail: "",
  // Non-secret by design: both appear in the closing status message so the
  // operator knows where to point a browser.
  provisionHostname: null,
  provisionSsid: null,
  // --- reload / resume -------------------------------------------------------
  // Everything below is restored from the durable resume journal (js/resume.js).
  // It is a HINT about what the previous page session was doing: it restores the
  // board, the release tag and the device digest so the operator can be told what
  // they were doing, and nothing else. It never restores an identity, never marks
  // a bundle verified, and never authorises a write. `resumeMayReunUnlock` and
  // `resumeMayFormat` are hard false: a journal is written by a tab on a shared
  // origin and cannot be what re-sends flash:brick or reformats userdata.
  resumeBoard: null,
  resumeReleaseTag: null,
  resumeSerialSha256: null,
  resumePhase: null,
  resumeUnlockSubmitted: false,
  resumeMayReunUnlock: false,
  resumeMayFormat: false,
  // The device digest `reconcileResume` measured on the DEVICE during this
  // session's resume (js/resume-device.js). It is the value the helper's guard is
  // bound to, and it is what binds a resume to one physical Echo. Null until a
  // resume has reconciled; never taken from the journal.
  resumeDeviceDigest: null,
  // The DEVICE's own guard phase, as `reconcileDeviceResume` read it. This is
  // what tells the run whether the device's receipt is (or is not) prepare
  // evidence. Never taken from the journal: the journal's `phase` is a
  // different vocabulary and a browser-tab claim. Null until a resume reconciles.
  resumeGuardPhase: null,
  // Set when this page session identified a previously granted device read-only
  // on load. It names the device; it never starts work.
  autoIdentifiedSerial: null,
  // Set when the granted device set could not be narrowed to one, so the next
  // Connect press must ask which device rather than picking for the operator.
  resumeDeviceAmbiguous: false,
  // Exactly one USB-busy explanation is published per contention episode, so a
  // retry loop cannot flood the log with the same sentence.
  usbBusyReportedFor: null,
  // The durable cross-tab writer lock handle (js/writer-lock.js). `recoveryClaims`
  // is a Map and cannot see another tab of this origin, so this is what makes a
  // second tab refuse BEFORE it opens the device. Null whenever this tab does
  // not hold it.
  writerLock: null,
  // Overall progress of a run. `runStage` is the STAGES id the run is on and
  // `runFraction` how far through it (only the payload push and the boot wait
  // report a fraction). The bar used to be derived from the wizard CARD, and the
  // whole run lives on one card, so it sat at the same value for the entire run.
  runStage: null,
  runFraction: 0,
  // After the reboot: what the running Echo reported. "booting" | "applying" |
  // "done" | "needs-setup" | "setup-failed" | "timeout" | "no-permission" | null.
  postInstall: null,
  postInstallIp: null,
  postInstallDetail: "",
  // An open ADB session to the RUNNING image, held only while step 5 is waiting
  // to be sent to a device that needs setup.
  postInstallSession: null,
};

// Rough share of a typical run's wall time per stage, so the bar moves at an
// honest pace. Transfer is dominated by the payload push; verify is the wait for
// LibreEcho to start.
const STAGE_WEIGHTS = { release: 1, device: 1, identity: 1, unlock: 3, recovery: 5, stage: 3,
  prepare: 2, initialize: 4, transfer: 55, finalize: 8, configure: 1, verify: 16 };

/** 0..100 for the current run position. Pure over STAGES and STAGE_WEIGHTS. */
export function runPercent(stageId, fraction = 0) {
  const total = STAGES.reduce((sum, stage) => sum + (STAGE_WEIGHTS[stage.id] ?? 1), 0);
  let done = 0;
  for (const stage of STAGES) {
    const weight = STAGE_WEIGHTS[stage.id] ?? 1;
    if (stage.id === stageId) {
      return Math.round(((done + weight * Math.max(0, Math.min(1, fraction))) / total) * 100);
    }
    done += weight;
  }
  return 0;
}

/** Moves the bar without republishing the message. */
function setRunProgress(stageId, fraction = 0) {
  state.runStage = stageId;
  state.runFraction = fraction;
  const percent = runPercent(stageId, fraction);
  if (dom.statusBarFill) dom.statusBarFill.style.width = `${percent}%`;
  try { dom.statusBarProgress?.setAttribute?.("aria-valuenow", String(percent)); } catch { /* no ARIA support */ }
}

function setStatus(node, text, kind = "pending") {
  if (!node) return;
  node.textContent = text;
  node.dataset.state = kind;
}

// --- step 5: optional one-shot configuration -------------------------------
//
// The whole feature is optional and off by default. Nothing is persisted in the
// browser: the form lives in `state.provisionForm` and in the input elements
// only, and both are cleared once the run is over, on Stop, and on unload. The
// only artefact that leaves the browser is one provision file, written by
// deliverProvision() after finalize and before the reboot.

const provisionInputs = [
  "username", "password", "passwordConfirm", "ssid", "security", "wifiPassword",
  "hostname", "volume", "wakeWord", "wakeSensitivity", "localOnly", "telemetry",
];

/** True when the operator has answered the step-5 question either way. */
function provisionDecided() {
  return state.provisionMode === "skip" || state.provisionState !== "idle";
}

/** The form as the validators and the document builder need it. */
export function provisionForm() {
  const node = dom.provision;
  const value = (name, fallback = "") => {
    const field = node?.[name];
    return field?.value === undefined ? fallback : field.value;
  };
  const checked = (name) => node?.[name]?.checked === true;
  return {
    username: value("username").trim(),
    password: value("password"),
    passwordConfirm: value("passwordConfirm"),
    ssid: value("ssid").trim(),
    security: value("security", PROVISION_DEFAULTS.security),
    wifiPassword: value("wifiPassword"),
    hostname: value("hostname", PROVISION_DEFAULTS.hostname).trim(),
    volume: value("volume", PROVISION_DEFAULTS.volume),
    wakeWord: value("wakeWord", PROVISION_DEFAULTS.wake_word),
    wakeSensitivity: value("wakeSensitivity", PROVISION_DEFAULTS.wake_sensitivity),
    localOnly: checked("localOnly"),
    telemetry: checked("telemetry"),
  };
}

/** True when the collected form would be delivered as-is. */
function provisionFormValid() {
  return state.provisionMode === "skip" || validateProvision(provisionForm()).length === 0;
}

/** One line describing what step 5 currently means. */
function provisionSummary() {
  if (state.provisionState === "delivered") return "Configuration delivered — the Echo will apply it on first boot.";
  if (state.provisionState === "failed") return "Configuration NOT delivered — set the Echo up on the device.";
  if (state.provisionState === "skipped") return "Skipped — you will set it up on the device.";
  if (state.provisionMode === "skip") return "Skipped — you will set it up on the device.";
  const errors = validateProvision(provisionForm());
  if (errors.length) return `${errors.length} field(s) still need attention before the install can carry this.`;
  const form = provisionForm();
  return form.ssid
    ? `${form.hostname}.local · joins ${form.ssid} · admin ${form.username}`
    : `${form.hostname}.local · admin ${form.username} (Wi-Fi set up on the device)`;
}

/** The status-bar line for step 5. */
function provisionMessage() {
  if (state.provisionState === "delivered") {
    return "Your settings are on the device's userdata. It applies them itself on first boot — this page cannot confirm that it worked.";
  }
  if (state.provisionState === "failed") {
    return `Your settings were NOT delivered (${state.provisionDetail || "unknown reason"}). The install itself is complete; set the Echo up on the device.`;
  }
  if (state.provisionMode === "skip") {
    return "Nothing to do here — the Echo will run its own setup page on first boot. Change your mind and fill this in before pressing Run the install.";
  }
  const errors = validateProvision(provisionForm());
  if (errors.length) return errors[0].message;
  return "Configuration looks complete. It is written after the install finishes and before the reboot; the password is never stored by this page.";
}

/** Where the operator goes next, once the device is verified. */
function installDoneSummary() {
  if (state.provisionState === "delivered") return "Installed, configuration delivered, reboot requested.";
  if (state.provisionState === "failed") return "Installed, reboot requested — configuration NOT delivered.";
  if (state.provisionMode === "skip") return "Installed, reboot requested; set up on the device.";
  return "Installed, reboot requested.";
}

/**
 * The final state the operator is left in (issue 22: after the run there was no
 * clear "done" anywhere in the status bar). It says what actually happened, and
 * is explicit about what this page did NOT verify.
 *
 * That caveat belongs HERE, not at the one call site that published it: the
 * run's `finally` block republishes the bar from installDoneMessage(), so a
 * caveat added only to the DONE setStatusBar call is overwritten moments later
 * and the operator is left reading a claim this page cannot back.
 */
function installDoneMessage() {
  const outcome = state.provisionState === "delivered"
    ? (provisionHostname()
      ? `Configuration delivered — the Echo will join ${provisionSsid() || "your network"} and finish setup on first boot; open http://${provisionHostname()}.local:8080`
      : "Configuration delivered — the Echo will join your network and finish setup on first boot; open its setup page at http://libreecho.local:8080")
    : "Install finished and a reboot was requested. Open the setup page on the device.";
  return `${outcome} The running OS is not verified by this page — confirm the device itself before calling it complete.`;
}

function provisionHostname() {
  return state.provisionHostname ?? "";
}

function provisionSsid() {
  return state.provisionSsid ?? "";
}

/** Paints the per-field error text under the step-5 form. */
function renderProvisionErrors() {
  const errors = validateProvision(provisionForm());
  for (const field of provisionInputs) {
    const node = document.getElementById(`provision-error-${field}`);
    const message = errors.find((entry) => entry.field === field)?.message ?? "";
    if (node) node.textContent = message;
  }
  if (dom.provisionFormWrap) {
    dom.provisionFormWrap.dataset.invalid = errors.length ? "true" : "false";
  }
  return errors;
}

/** Keeps the derived outputs (percentages, hostname preview) in step. */
function renderProvisionDerived() {
  const node = dom.provision;
  if (node?.volumeOutput) node.volumeOutput.textContent = `${node.volume?.value ?? PROVISION_DEFAULTS.volume}%`;
  if (node?.sensitivityOutput) node.sensitivityOutput.textContent = `${node.wakeSensitivity?.value ?? PROVISION_DEFAULTS.wake_sensitivity}%`;
  if (node?.hostnamePreview) {
    const host = (node.hostname?.value ?? "").trim() || PROVISION_DEFAULTS.hostname;
    node.hostnamePreview.textContent = `${host}.local`;
  }
}

/**
 * Wipes every secret this page held: the password/passphrase input values and
 * the mirrored form object. The delivered hostname and SSID are NOT secrets —
 * both are printed in the closing message on purpose — so they survive until
 * that message is published, then are cleared with the rest.
 */
export function clearProvisionSecrets({ keepSummary = false } = {}) {
  const node = dom.provision;
  for (const name of ["password", "passwordConfirm", "wifiPassword"]) {
    if (node?.[name]) node[name].value = "";
  }
  state.provisionForm = null;
  if (!keepSummary) {
    state.provisionSsid = null;
    state.provisionHostname = null;
  }
}

/** Reads the step-5 controls and repaints every derived part of the card. */
export function onProvisionInput() {
  state.provisionForm = null;
  renderProvisionDerived();
  const errors = renderProvisionErrors();
  const decided = state.provisionMode === "fill" && errors.length === 0;
  if (state.postInstall) refreshStatusBar();
  if (state.provisionMode === "skip") setStatus(dom.statusProvision, "will be set up on the device", "pending");
  else setStatus(dom.statusProvision, decided ? "ready to install" : `${errors.length} field(s) to fix`,
    decided ? "ok" : "warn");
  renderStepCards();
}

/** Applies the skip/fill choice. Skipping clears every secret immediately. */
export function setProvisionMode(mode, { chosen = true } = {}) {
  const next = mode === "fill" ? "fill" : "skip";
  state.provisionMode = next;
  // The page's own initial default is not the operator's answer.
  if (chosen) state.provisionChosen = true;
  if (dom.provisionFormWrap) dom.provisionFormWrap.hidden = next !== "fill";
  if (next === "skip") {
    clearProvisionSecrets();
    state.provisionState = "skipped";
    state.provisionDetail = "";
    setStatus(dom.statusProvision, "will be set up on the device", "pending");
  } else {
    state.provisionState = "idle";
    onProvisionInput();
  }
  renderStepCards();
  refreshStatusBar();
  return next;
}

// --- reload / resume --------------------------------------------------------
//
// The reload strand, in one paragraph. A run rebots the Echo into TWRP, the
// operator reloads the page (or the browser does), and every piece of context the
// page held was in memory: the identity, the chosen board, the release and the
// verified bundle. The device is now in TWRP, so `queryDevice` cannot reach it —
// and `awaitRecovery`/`findRecovery` require a fastboot `serialno` the device no
// longer has. Every continuation path refused, so the operator was left sitting
// in TWRP with a page that could not help.
//
// The fix has two halves, and keeping them separate is the whole point:
//
//   1. `restoreResumeState()` reads a durable, non-secret journal so the page can
//      say "you were installing X on THIS Echo". It restores nothing that grants
//      authority: no identity, no bundle readiness, no unlock latch.
//   2. `planResume()` refuses to continue until the immutable release assets AND
//      the actual device have both been re-verified. The journal is the hint; the
//      device is the authority. A reload therefore re-derives everything it needs
//      and re-asks the operator for nothing.
//
// Two things are unconditionally false here and are not configurable: the journal
// can never authorise re-sending `flash:brick`, and it can never authorise
// re-formatting userdata. Those live behind the durable `libreecho.unlock.*` and
// `libreecho.direct.*` guards, which survive a reload by construction and which
// nothing in this file removes.

/** True when a journal exists at all, whatever it says. */
export function hasResumeJournal(storage = browserStorage()) {
  return readResumeJournal(storage).ok;
}

/**
 * Restores the non-secret transaction context after a reload.
 *
 * Never throws and never blocks the page: a first-time visitor, a corrupt record
 * and a storage-disabled browser all end up with the ordinary Connect flow, which
 * is exactly where they should be. The two authority flags are set from
 * `classifyResumeState`, which hard-codes them false.
 */
export async function restoreResumeState({ storage = browserStorage(), announce = true } = {}) {
  state.resumeBoard = null;
  state.resumeReleaseTag = null;
  state.resumeSerialSha256 = null;
  state.resumePhase = null;
  state.resumeUnlockSubmitted = false;
  state.resumeMayReunUnlock = false;
  state.resumeMayFormat = false;
  const read = readResumeJournal(storage);
  const classified = classifyResumeState(read);
  state.resumeMayReunUnlock = classified.mayReunUnlock;
  state.resumeMayFormat = classified.mayReformat;
  if (!classified.resumable) {
    // Not an error: most visitors have no journal. Report it once, quietly, and
    // leave the page in its normal first-run state.
    if (announce && !classified.fresh) terminal.info(`no usable resume record (${read.reason}); starting a fresh connection`);
    refreshControls();
    return { ok: false, reason: read.reason ?? "there is no resume journal" };
  }
  const journal = classified.journal;
  state.resumeBoard = journal.board;
  state.resumeReleaseTag = journal.releaseTag;
  state.resumeSerialSha256 = journal.serialSha256;
  state.resumePhase = journal.phase;
  state.resumeUnlockSubmitted = journal.unlockState !== "none";
  if (announce) {
    terminal.info(`a resume record was found: ${journal.board} · ${journal.releaseTag} · stopped at the ${journal.phase} phase. `
      + "Nothing has been written; the device and the build are checked again before anything continues.");
    if (state.resumeUnlockSubmitted) {
      terminal.info("an unlock payload was submitted before the reload, so it will NOT be sent again");
    }
  }
  refreshControls();
  return { ok: true, journal, classified, reason: null };
}

/**
 * Records the current transaction so a reload can name it. Called as a run
 * progresses; every call is best-effort and a refusal is reported, never thrown,
 * because a missing journal only costs convenience.
 *
 * The body is built from a fixed field list. The step-5 form is never passed in
 * — `writeResumeJournal` refuses secret-shaped fields anyway, and refusing them
 * twice is deliberate.
 */
export function recordResumeProgress({ phase = null, bundleManifestSha256 = null,
  deviceDigest = null, kaeruHeader = null, target = null, storage = browserStorage() } = {}) {
  const identity = state.identity;
  if (!identity?.serialRaw) return { ok: false, reason: "no device identity to record" };
  // Persist only the explicit non-secret allowlist below, even when the form is filled.
  return (async () => {
    const body = {
      version: 1,
      serialSha256: await sha256Bytes(new TextEncoder().encode(String(identity.serialRaw))),
      board: identity.profile?.board ?? state.bundleBoard ?? null,
      releaseTag: state.release?.tag ?? null,
      provisionMode: state.provisionMode === "fill" ? "fill" : "skip",
      phase: phase ?? state.resumePhase ?? "fresh",
      unlockState: state.unlockSubmitted === identity.serialRaw || state.resumeUnlockSubmitted
        ? "submitted" : "none",
      bundleManifestSha256, deviceDigest, kaeruHeader, target,
      updatedAt: Date.now(),
    };
    const result = writeResumeJournal(storage, body);
    if (!result.ok) terminal.warn(`this run cannot be resumed after a reload: ${result.reason}`);
    return result;
  })();
}

/**
 * Decides whether the transaction may continue, and where.
 *
 * Both verifications are mandatory and neither is optional:
 *   - `verifyRelease` must re-establish the immutable release assets. After a
 *     reload there is no verified bundle in memory, so this is usually the step
 *     that refuses: the journal alone can never stand in for re-fetching and
 *     re-verifying the signed inventory.
 *   - `verifyDevice` must re-establish the actual device. A journal naming a
 *     serial digest is not evidence that device is plugged in, or that it is the
 *     same device, or that its userdata is where it was left.
 *
 * Returns `startAt: null` whenever either fails, so a caller cannot accidentally
 * continue from a partial plan.
 */
export async function planResume({ verifyRelease, verifyDevice, storage = browserStorage() } = {}) {
  const read = readResumeJournal(storage);
  const classified = classifyResumeState(read);
  if (!classified.resumable) {
    return { ok: false, reason: read.reason ?? "there is nothing to resume", startAt: null };
  }
  const release = await verifyRelease?.({ journal: classified.journal });
  if (!release?.ok) {
    return { ok: false, reason: `the release did not reverify: ${release?.reason ?? "not checked"}`, startAt: null };
  }
  const device = await verifyDevice?.({ journal: classified.journal });
  if (!device?.ok) {
    return { ok: false, reason: `the device did not reverify: ${device?.reason ?? "not checked"}`, startAt: null };
  }
  const phase = classified.phase ?? "fresh";
  return {
    ok: true,
    reason: null,
    startAt: phase,
    journal: classified.journal,
    release,
    device,
    // Hard false, independent of everything above: a journal never re-arms the
    // unlock and never re-arms formatting.
    mayReunUnlock: false,
    mayReformat: false,
    // `initialize` formats userdata. Re-entering it is only ever safe on the
    // device's own evidence that it already ran, which the caller must supply.
    requiresDeviceEvidenceForFormat: phase === "initialize",
  };
}

/**
 * Checks a connected recovery client against the journal's serial digest.
 *
 * The digest is compared, never a stored plain serial, so this is a matching
 * test rather than an identity lookup. A different device is refused outright:
 * continuing another Echo's install would write the wrong device.
 */
export async function assertResumeMatchesDevice(client) {
  const read = readResumeJournal();
  const classified = classifyResumeState(read);
  if (!classified.resumable) return { ok: true, reason: null, serial: null, header: null };
  const probe = await probeRecoveryEntry({ client, terminal });
  const observed = await sha256Bytes(new TextEncoder().encode(String(probe.serial)));
  if (observed !== classified.journal.serialSha256) {
    const reason = `this is a different Echo than the resume record describes (${maskSerial(probe.serial)}); refusing to continue another device's install`;
    terminal.error(reason);
    throw new StageError("recovery", reason);
  }
  return { ok: true, reason: null, serial: probe.serial, header: probe.header };
}

/**
 * Identifies a device this origin was already granted, without a chooser and
 * without writing anything.
 *
 * This runs on page load, so the only thing it may do is name a device. It never
 * starts an install, never sends a payload and never reboots — a reload must not
 * be able to mutate a device by itself. Three outcomes:
 *   - exactly one granted candidate that matches the journal → identified
 *   - more than one candidate → ambiguous, and the operator must choose
 *   - no candidate (or only non-matching ones) → nothing to do
 */
export async function autoIdentifyGrantedDevice({ grantedDevices = grantedAdbDevices, open = openAdb } = {}) {
  let devices;
  try {
    devices = await grantedDevices();
  } catch (error) {
    return { identified: false, ambiguous: false, reason: `this browser will not list previously allowed devices (${error.message})` };
  }
  if (!Array.isArray(devices) || devices.length === 0) {
    return { identified: false, ambiguous: false, reason: "no USB device is currently allowed for this page" };
  }
  const read = readResumeJournal();
  const expected = classifyResumeState(read).journal?.serialSha256 ?? null;
  // Narrow by the USB descriptor serial, which is a HINT (deviceSerialVerdict):
  // a blank serial cannot exclude anything, so those candidates are kept and
  // resolved by the ADB-reported serial instead. When a journal exists, only a
  // descriptor whose digest matches may be considered a candidate at all — that is
  // what stops a reload from auto-attaching to a different Echo.
  let candidates = devices;
  if (expected) {
    candidates = [];
    for (const device of devices) {
      const declared = String(device?.serialNumber ?? "").trim();
      if (!declared) { candidates.push(device); continue; }
      const digest = await sha256Bytes(new TextEncoder().encode(declared));
      if (digest === expected) candidates.push(device);
    }
  }
  if (candidates.length === 0) {
    // Reached either because nothing is allowed, or because every allowed device
    // is a DIFFERENT Echo than the journal describes. Both matter to the
    // operator and the two need different actions, so the message says which.
    const allowed = devices.length;
    return {
      identified: false,
      ambiguous: false,
      differentDevice: true,
      reason: allowed
        ? `${allowed} USB device(s) are allowed for this page, but none is the Echo this install was for; `
          + "start a fresh install for the device you have plugged in"
        : "no allowed USB device matches the resume record",
    };
  }
  if (candidates.length > 1) {
    state.resumeDeviceAmbiguous = true;
    const reason = `${candidates.length} allowed USB devices could be your Echo; choose the one you want from the list`;
    terminal.info(reason);
    refreshControls();
    return { identified: false, ambiguous: true, reason, candidates };
  }
  state.resumeDeviceAmbiguous = false;
  const releaseOperation = beginDeviceOperation("entry");
  if (!releaseOperation) return { identified: false, ambiguous: false, reason: "another connection is in progress" };
  try {
    const identity = await runRecoveryEntry({ request: async () => candidates[0], open });
    if (!identity) return { identified: false, ambiguous: false, reason: "the device could not be identified" };
    state.autoIdentifiedSerial = state.identity.serialRaw;
    return { identified: true, ambiguous: false, reason: null, readOnly: true, mayProceed: false,
      serial: state.identity.serialRaw, header: state.kaeruHeader };
  } catch (error) {
    return { identified: false, ambiguous: false, reason: `the allowed device did not read back as a TWRP Echo (${error.message})` };
  } finally { releaseOperation(); }

}

/**
 * The single Connect/Resume action the operator is offered.
 *
 * There used to be five connection buttons asking for five different things. One
 * obvious action is what an ordinary user needs: either "Connect to your Echo"
 * (nothing was in progress) or "Resume" (a journal names a transaction). Neither
 * is ever destructive — both route to a read-only probe or a chooser.
 */
export function connectAction() {
  const resumable = Boolean(state.resumeBoard && state.resumeReleaseTag);
  if (resumable) {
    return {
      label: "Resume this install",
      message: `You were installing ${state.resumeReleaseTag} on your ${state.resumeBoard} Echo, and the page was reloaded. `
        + "Resume re-checks the build and your device before continuing — nothing is written until both agree.",
      hint: state.resumeUnlockSubmitted
        ? "Your unlock payload was already sent, so it will not be sent again."
        : "",
      secondary: "If this was a different Echo or a different build, start a fresh install instead.",
      destructive: false,
      kind: "action",
      focus: true,
      run: () => resumeInstall().catch((error) => terminal.error(`resume failed: ${error.message}`)),
    };
  }
  return {
    label: "Connect to your Echo",
    message: state.resumeDeviceAmbiguous
      ? "More than one USB device could be your Echo. Press this, then choose the right one from Chrome's list."
      : "Press this, then choose the USB device named “Echo” from Chrome's list. This only reads your device.",
    hint: "If your Echo is in TWRP recovery, choose it here — no fastboot is needed.",
    secondary: "Nothing is unlocked, written or restarted by connecting.",
    destructive: false,
    kind: "action",
    focus: true,
    run: () => connectDevice().catch((error) => terminal.error(`connect failed: ${error.message}`)),
  };
}

/**
 * The one Connect button's body. Mode-aware and read-only: it either identifies
 * an Echo in fastboot or identifies one in TWRP, and in both cases it only reads.
 * Nothing here writes, formats, unlocks or reboots.
 */
export async function connectDevice({ request = null, open = openAdb, openBoot = openFastboot } = {}) {
  if (state.running || state.fetchingBundle) throw new StageError("device", "wait for the current operation to finish before connecting again");
  const releaseOperation = beginDeviceOperation("entry");
  if (!releaseOperation) return null;
  state.abort = false;
  const epoch = nextRecoveryEpoch();
  try {
    // Invoke the chooser directly from the click, before awaiting any USB work.
    const choose = request ?? (() => navigator.usb.requestDevice({ filters: [...MODES.fastboot.filters, ...MODES.adb.filters] }));
    const device = await choose();
    if (isStopped() || isEpochStale(epoch)) throw new RecoveryStopped();
    if (!device) return null;
    const expected = readResumeJournal().journal?.serialSha256;
    if (expected && device.serialNumber && await sha256Bytes(new TextEncoder().encode(device.serialNumber)) !== expected) {
      throw new StageError("device", "this is a different Echo from the saved install; reconnect the original Echo");
    }
    // An Echo already running LibreEcho (its own adbd, 18d1:d001) is not an
    // install target from here: check how it is doing and offer setup instead.
    if (RUNNING_ADB_FILTERS.some((f) => f.vendorId === device.vendorId && f.productId === device.productId)) {
      releaseOperation();
      return await waitForLibreEcho({ device, serial: device.serialNumber ?? "" });
    }
    const modes = classifyDevice(device).interfaces.filter(i => i.interfaceClass === 255 && i.interfaceSubclass === 66);
    const isFastboot = modes.some(i => i.interfaceProtocol === 3);
    const isAdb = modes.some(i => i.interfaceProtocol === 1);
    // Exact known identities are a fallback for browsers without descriptors.
    const recovery = isAdb || (!isFastboot && device.vendorId === 0x18d1 && device.productId === 0x4ee2);
    const fastboot = isFastboot || (!isAdb && device.vendorId === 0x0bb4 && device.productId === 0x0c01);
    if (recovery === fastboot) throw new StageError("device", "the Echo's USB mode is unclear; reconnect it and try again");
    await closeRecoverySession(state.fastboot);
    state.fastboot = null;
    invalidateRecovery({ close: true });
    state.identity = null;
    if (recovery) return await runRecoveryEntry({ request: async () => device, open });
    const identity = await runDeviceQuery({ any: false, open: options => openBoot({ ...options, device }) });
    if (expected && await sha256Bytes(new TextEncoder().encode(identity.serialRaw)) !== expected) {
      await closeRecoverySession(state.fastboot); state.fastboot = null; state.identity = null;
      throw new StageError("device", "the connected Echo does not match the saved install");
    }
    return identity;
  } catch (error) {
    if (isChooserCancel(error)) { terminal.info("No device was selected. Press Connect when you are ready."); return null; }
    throw error;
  } finally {
    state.recoveryGrantInFlight = false;
    releaseOperation();
    refreshControls();
  }
}

/**
 * The Resume button's body.
 *
 * A resume is refused unless BOTH the release assets and the device reverify, so
 * this function's first act is to build a plan and stop if it is not safe. Only
 * then does it re-enter the ordinary run flow, which re-derives everything from
 * the device — the journal contributes a starting point and nothing more.
 */
/**
 * Re-establishes the immutable release assets for a resume.
 *
 * This is the step a journal cannot substitute for, and it is deliberately the
 * real download+verify path rather than a lookup in `state.releases`. After a
 * reload the page holds no verified bundle at all, and the journal names a tag —
 * a tag is not an inventory. So unless this page session has *already* verified
 * the exact recorded build for the exact recorded board (nothing lost, nothing
 * to re-derive), the bundle is re-fetched and re-hashed from the published
 * checksums before any device work.
 */
export async function reverifyReleaseForResume(journal) {
  if (!journal?.releaseTag) return { ok: false, reason: "no release was recorded" };
  const board = journal.board ?? null;
  if (!isInstallableBoard(board)) return { ok: false, reason: `the recorded board ${board} is not one this installer can install` };
  // Already verified in THIS page session, for this exact tag and board. A
  // resume pressed without a reload lands here and needs nothing re-fetched.
  if (state.bundleReady && state.release?.tag === journal.releaseTag
    && state.bundleBoard === board && state.bundleHardwareAccepted === true) {
    return { ok: true, release: state.release, alreadyVerified: true };
  }
  // The release list is not in memory after a reload; read it before deciding
  // the recorded tag no longer exists.
  if (state.releases.length === 0) {
    try { await loadReleases(); } catch (error) {
      return { ok: false, reason: `the build list could not be read (${error.message})` };
    }
  }
  const release = state.releases.find((entry) => entry.tag === journal.releaseTag) ?? null;
  if (!release) {
    return { ok: false, reason: `the recorded build ${journal.releaseTag} is no longer published; download and verify a build yourself` };
  }
  if (!releaseOffersBoard(release, board)) {
    return { ok: false, reason: `the recorded build ${journal.releaseTag} is not offered for ${boardLabel(board)}` };
  }
  state.board = board;
  state.release = release;
  // The real path: fetch every asset and re-hash it against the API-anchored
  // inventory. This is what earns `bundleReady` again.
  const verified = await fetchBundleAutomatically({ board });
  if (!verified) return { ok: false, reason: `the build ${journal.releaseTag} did not download and verify` };
  if (state.bundleBoard !== board) {
    return { ok: false, reason: `the verified build is for ${boardLabel(state.bundleBoard)}, not ${boardLabel(board)}` };
  }
  return { ok: true, release, alreadyVerified: false };
}

/**
 * Reads the helper's own receipt back off the device.
 *
 * A resume that says "finalize" is claiming the image was installed. Exit status
 * is not evidence — the helper writes a machine-readable receipt for exactly
 * this reason — so the claim is checked against what the device actually holds
 * before the page continues to the reboot and reports anything as done.
 *
 * This path constant is imported. It was not: the template interpolated
 * `undefined`, every call threw a ReferenceError, and the `catch` turned every
 * answer into `null`. That made every receipt check in the page vacuously pass
 * as "nothing readable" while looking like a device that reported nothing.
 */
export async function readInstallReceipt(adb) {
  if (!adb?.shell) return null;
  try {
    const result = await adb.shell(`cat ${DIRECT_RECEIPT_PATH} 2>/dev/null || true`);
    const receipt = {};
    for (const line of String(result?.stdout ?? "").split(/\r?\n/)) {
      const match = /^([a-z][a-z0-9_]*)=(.*)$/.exec(line.trim());
      if (match) receipt[match[1]] = match[2];
    }
    return Object.keys(receipt).length ? receipt : null;
  } catch {
    return null;
  }
}

/**
 * The device-authoritative resume decision, and the ONLY thing allowed to name a
 * resume point.
 *
 * `journal.phase` is a browser-tab claim. It can be stale (written before the
 * mutation that then failed), ahead (written before the mutation), or behind (a
 * phase completed but the journal write never landed). Reading a skip from it can
 * skip a GPT reshape that never ran, or re-enter `initialize` and format userdata
 * a second time. So the browser journal is passed in only as corroboration, and
 * the answer comes from `reconcileDeviceResume`, which reads the device's own
 * durable guard — `/cache/libreecho-direct/transaction.state`, written by the
 * shipped helper with `guard_write` BEFORE each mutation.
 *
 * Every refusal is returned rather than thrown, so the caller can speak to the
 * operator: `{ ok: false, reason, code }`. A `StageError` from the module is
 * unwrapped into its stable `detail.code` here, so nothing has to parse prose.
 *
 * `browserPrepareAttempted` must be an EXPLICIT boolean. The one case with no
 * guard to read is a genuinely fresh transaction, and reshaping userdata is only
 * safe when this browser can positively say no prepare was ever attempted.
 * Anything else — `undefined` included — is a refusal, because "this browser does
 * not know" is exactly the fact that makes prepare unsafe.
 *
 * @returns {Promise<{ok: boolean, nextPhase?: string, reason?: string, code?: string,
 *   deviceDigest?: string, guard?: object, evidence?: object}>}
 */
export async function reconcileResume({ adb, journal = null, browserPrepareAttempted = null,
  isCancelled = null } = {}) {
  // The immutable bindings the guard is matched against. All four come from state
  // this run re-derived from the verified bundle and the verified device; none is
  // read from the journal.
  const target = state.target?.board ?? state.bundleBoard ?? null;
  const manifestSha256 = state.directManifestSha ?? null;
  const release = state.directRelease ?? null;
  const serialRaw = state.identity?.serialRaw ?? state.recoverySerial ?? null;
  const kaeruHeader = state.kaeruHeader ?? null;
  if (!adb?.shell) return { ok: false, reason: "no Echo is connected in recovery; nothing can be reconciled", code: "no-adb-session" };
  if (!manifestSha256) {
    return { ok: false, reason: "the verified bundle manifest is not in this page session; nothing can be reconciled", code: "bundle-manifest-unpinned" };
  }
  try {
    const reconciled = await reconcileDeviceResume({
      adb, journal: journalForGuard(journal, release), manifestSha256, target, release, serialRaw, kaeruHeader,
      browserPrepareAttempted, isCancelled,
    });
    return { ok: true, ...reconciled, reason: null, code: null };
  } catch (error) {
    if (error instanceof RecoveryStopped) throw error;
    if (!(error instanceof StageError)) {
      return { ok: false, reason: `the device could not be reconciled: ${error.message}`, code: "reconcile-failed" };
    }
    return { ok: false, reason: error.message, code: error.detail?.code ?? "reconcile-refused", detail: error.detail };
  }
}

/**
 * Translates a browser journal into the namespace the DEVICE's guard uses.
 *
 * There are two different "release" strings in one transaction and they are not
 * interchangeable:
 *
 *   * `releaseTag` — the PUBLISHED TAG (`radar-puffin-v0.14.0`), which is what the
 *     GitHub release is called and what the journal records;
 *   * `release` — the BUNDLE MANIFEST RELEASE (`radar-puffin-build-test`), the
 *     `release=` line inside the signed `bundle.manifest`, which is what
 *     `--release` passes to the helper and what the device's guard and receipt
 *     record.
 *
 * `reconcileDeviceResume` cross-checks a journal's release against the guard's, so
 * handing it the published tag would refuse EVERY resume as
 * `journal-binding-mismatch` — a mismatch that means only "two namespaces were
 * compared", not "a different transaction". This rewrites the one field into the
 * guard's namespace and leaves every other field untouched, so the journal still
 * corroborates exactly as much as it can.
 *
 * If this run cannot name a manifest release, there is nothing safe to translate
 * to, so the journal is dropped rather than passed in a namespace that can only
 * produce a false refusal. Losing corroboration is always better than losing the
 * resume.
 */
function journalForGuard(journal, manifestRelease) {
  if (!journal || typeof manifestRelease !== "string" || manifestRelease === "") return null;
  return { ...journal, releaseTag: manifestRelease };
}

/**
 * A test-only seam onto the reconcile decision, so a suite can drive the refusal
 * codes without priming a whole run. Not reachable from any page control.
 */
export async function __reconcileResumeForTest({ adb, browserPrepareAttempted = null, journal = null } = {}) {
  return reconcileResume({ adb, journal, browserPrepareAttempted });
}

/**
 * The Resume button's body.
 *
 * A resume is refused unless BOTH the release assets and the device reverify, so
 * this function's first act is to build a plan and stop if it is not safe. Only
 * then does it re-enter the ordinary run flow, which re-derives everything from
 * the device — the journal contributes a starting point and nothing more.
 *
 * The starting point is the whole point. `runInstall({ resumeFrom })` re-runs the
 * recorded phase and everything after it, and skips the phases before it. That is
 * what makes a resume a resume rather than a reinstall: re-entering `initialize`
 * would reshape userdata a second time, and re-entering `transfer` would push the
 * whole image again over an install that may already be complete.
 */
export async function resumeInstall({ verifyRelease = null, verifyDevice = null } = {}) {
  if (state.running || state.fetchingBundle) {
    throw new StageError("install", "wait for the current operation to finish before resuming");
  }
  // Claim the writer lock BEFORE any device command. The reverification below
  // reads the recovery session and the Kaeru header, so a resume that probed
  // first would talk to a device another tab is already writing to — the exact
  // interleaved-handshake failure the in-memory claim exists to prevent, one
  // layer up. runInstall adopts this live grant; Web Locks are non-reentrant,
  // so it must not request the same exclusive lock again.
  const claim = await acquireWriterLock();
  if (!claim.ok) {
    terminal.warn(`cannot resume: ${claim.reason}`);
    terminal.info("nothing was written and nothing was read from a device another tab is using. "
      + "Close the other tab, or wait for it to finish, then press the button again.");
    setStatusBar({ step: "connect-device", kind: "bad", action: null,
      message: `Resume not started: ${claim.reason}`,
      secondary: "Nothing was written. Only one tab of this page may install at a time." });
    refreshControls();
    return null;
  }
  state.writerLock = claim;
  try {
    return await resumeLocked({ verifyRelease, verifyDevice });
  } finally {
    // Only released here when the resume never reached runInstall, which owns
    // the lock from its own point of view once it takes over.
    if (state.writerLock === claim) {
      await claim.release();
      state.writerLock = null;
    }
  }
}

/** The body of resumeInstall, called with the writer lock already held. */
async function resumeLocked({ verifyRelease = null, verifyDevice = null } = {}) {
  // Re-fetch and re-verify the signed inventory. After a reload there is nothing
  // verified in memory, and a journal cannot substitute for the release assets.
  const reverified = verifyRelease ?? ((context) => reverifyReleaseForResume(context.journal));
  // Re-establish the actual device. The journal says which Echo; only the device
  // can confirm it, so this refuses rather than assumes.
  const deviceCheck = verifyDevice ?? (async () => {
    if (!state.adb) return { ok: false, reason: "no Echo is connected; press Connect first" };
    if (!state.resumeSerialSha256) return { ok: true };
    const digest = await sha256Bytes(new TextEncoder().encode(String(state.identity?.serialRaw ?? state.recoverySerial ?? "")));
    if (digest !== state.resumeSerialSha256) {
      return { ok: false, reason: "the connected Echo is not the one this install was for" };
    }
    return { ok: true, serial: state.recoverySerial };
  });
  const plan = await planResume({ verifyRelease: reverified, verifyDevice: deviceCheck });
  if (!plan.ok) {
    terminal.warn(`cannot resume: ${plan.reason}`);
    terminal.info("nothing was written and nothing was retried. Download and verify the build again, then run the install from the start — "
      + "the phases that already ran are guarded on the device and will not be repeated blindly.");
    refreshControls();
    return null;
  }
  // The device must still be verified as the journal's device before any phase.
  if (state.adb && plan.journal.serialSha256) {
    await assertResumeMatchesDevice(state.adb);
  }
  // Said UNCONDITIONALLY, and before the device is asked anything, because it is
  // the one thing an operator must never have to re-derive: a resume never
  // re-sends the unlock payload. It is emitted here, above the reconciliation,
  // because the reconciliation is exactly where a resume most often refuses — and
  // a refusal must not be the outcome where the no-rearm claim was never made.
  if (plan.journal?.unlockState && plan.journal.unlockState !== "none") {
    terminal.ok("an unlock payload was submitted before the page was reloaded, so it will NOT be sent again");
  }
  // The release re-verified above, so the immutable bindings the guard is matched
  // against are in place. The resume POINT is now the device's to say, not the
  // journal's: plan.startAt (journal.phase) is deliberately not used for it.
  const journal = readResumeJournal().journal ?? null;
  const reconciled = await reconcileResume({
    adb: state.adb,
    journal,
    browserPrepareAttempted: browserPreparedAttempted(plan.journal),
    isCancelled: () => state.abort,
  });
  if (!reconciled.ok) {
    terminal.warn(`cannot resume: ${reconciled.reason}`);
    if (reconciled.code) terminal.line(`device reconciliation refused: ${reconciled.code}`);
    terminal.info("nothing was written. The device keeps the record of what already happened to it, so this is safe to retry once the cause is clear — "
      + "but nothing here will be guessed at, repeated or reformatted for you.");
    setStatusBar({ step: "install", kind: "bad", action: null,
      message: `Resume not started: ${reconciled.reason}`,
      secondary: "Nothing was written. The device's own transaction record decides what may still run." });
    refreshControls();
    return null;
  }
  const skipped = reconciled.evidence?.skippedPhases ?? [];
  terminal.ok(reconciled.guard
    ? `the device's own transaction record says this install reached the ${reconciled.guard.phase} phase`
    : "the device holds no transaction record; this is a fresh transaction");
  if (skipped.length) {
    terminal.ok(`already done on the device, and not repeated: ${skipped.join(", ")}`);
  }
  state.resumeDeviceDigest = reconciled.deviceDigest ?? null;
  state.resumeGuardPhase = reconciled.guard?.phase ?? null;
  // The prepare receipt the reconciliation already parsed and accepted as bound
  // to THIS bundle on THIS device. Handing it to the run avoids a second, looser
  // `readInstallReceipt` parse that could disagree with the bound one.
  state.resumePrepareReceipt = reconciled.receipt ?? null;
  // `initialize` reshapes userdata and `finalize` writes boot slots, so neither is
  // ever entered on a browser's word. What the guard says about them is what the
  // module already decided above.
  if (reconciled.nextPhase === "verify-installed") {
    // THE finalized CASE IS NOT SUCCESS. The guard records what the helper
    // STARTED; it does not record that the image landed, and the receipt is
    // overwritten by every later invocation. Two states are refused outright here,
    // before any command, because continuing from either would be a guess:
    //
    //   * no receipt at all — the device cannot say what its last invocation did;
    //   * an unclassified failed receipt. The helper's already-finalized
    //     refusal is the sole exception: it permits a new readback, not success.
    //
    // A present, bound receipt permits the fresh installed-state observation
    // below. The run never re-runs the real finalize.
    const receipt = reconciled.receipt;
    if (!receipt) {
      terminal.warn("the device's record says finalize completed, but its receipt cannot be read, "
        + "so nothing here can say whether the image actually landed");
      terminal.info("nothing was written. This is the one point where a repeated install would destroy work — "
        + "check the device, then start a fresh install deliberately.");
      setStatusBar({ step: "install", kind: "bad", action: null,
        message: "Resume not started: the device's finalize receipt cannot be read",
        secondary: "Nothing was written. The install is not repeated on an unverified device." });
      refreshControls();
      return null;
    }
    // A prior readback deliberately leaves failed/already-finalized. It can
    // authorize another readback, never a write or success from that old file.
    if (receipt.result === "failed" && receipt.error !== "already-finalized") {
      terminal.warn(`the device's last installer invocation FAILED (result=failed, ${receipt.error ?? "no reason recorded"}), `
        + "so its outcome has to be classified on the device before anything continues");
      terminal.info("nothing was written. Preserve the current device state; do not re-run the installer over it "
        + "without classifying that failure first.");
      setStatusBar({ step: "install", kind: "bad", action: null,
        message: `Resume not started: the device reports result=failed (${receipt.error ?? "unknown"})`,
        secondary: "Nothing was written. The failed invocation must be classified on the device first." });
      refreshControls();
      return null;
    }
    terminal.ok(`the device's record says finalize completed; its receipt reports result=${receipt.result}, `
      + "so the run will verify what is actually installed before claiming anything");
  }
  return runInstall({ dryRun: false, resumeFrom: reconciled.nextPhase });
}

/**
 * Whether this browser can say that no prepare attempt was ever made.
 *
 * This is the single fact that makes the "device holds no guard" case safe, since
 * prepare is the phase that reshapes userdata. It is answered from the durable
 * per-phase attempt guard the run wrote BEFORE each destructive phase — a browser
 * that never wrote one cannot have attempted it. `null` (not `false`) is returned
 * when the answer is unknowable, because `undefined` is a refusal upstream and a
 * guess here would reshape userdata.
 */
function browserPreparedAttempted(journalRecord) {
  if (!journalRecord) return null;
  // A journal naming any phase past fresh means this browser got at least as far
  // as deciding to prepare; a fresh/none record is the only "definitely not" case.
  if (journalRecord.phase && journalRecord.phase !== "fresh") return true;
  return false;
}

/**
 * The delivery step inside a run. Returns {delivered, detail} and NEVER throws:
 * a failed delivery must not fail an otherwise complete install, and it must
 * never be reported as success.
 */
async function deliverProvisionStep({ adb, release, target }) {
  const form = provisionForm();
  const errors = validateProvision(form);
  if (errors.length) {
    state.provisionState = "failed";
    state.provisionDetail = errors[0].message;
    terminal.error(`configuration not delivered: ${errors[0].message}`);
    return { delivered: false, detail: errors[0].message };
  }
  try {
    const result = await deliverProvision({ adb, form, release, target, terminal, isCancelled: () => state.abort });
    state.provisionState = "delivered";
    state.provisionDetail = "";
    state.provisionHostname = form.hostname;
    state.provisionSsid = form.ssid;
    setStatus(dom.statusProvision, "delivered", "ok");
    terminal.ok(`configuration delivered to ${PROVISION_PATH}; the device applies it on first boot`);
    return { delivered: true, detail: result };
  } catch (error) {
    state.provisionState = "failed";
    state.provisionDetail = error.message;
    setStatus(dom.statusProvision, "NOT delivered", "warn");
    terminal.error(`configuration NOT delivered: ${error.message}`);
    terminal.info("the install itself is complete — set the Echo up on its own setup page; this page will not retry");
    return { delivered: false, detail: error.message };
  }
}

function renderStepList(activeId = null) {
  dom.stepList.innerHTML = "";
  const order = STAGES.findIndex((stage) => stage.id === activeId);
  STAGES.forEach((stage, index) => {
    const item = document.createElement("li");
    const done = order > index || (order === -1 && state.stageProgress?.[stage.id] === "done");
    item.className = "step-item";
    if (activeId === stage.id) item.classList.add("step-active");
    else if (done) item.classList.add("step-done");
    item.innerHTML = `<span class="step-index">${String(index + 1).padStart(2, "0")}</span><span class="step-title"></span>`;
    item.querySelector(".step-title").textContent = stage.title;
    dom.stepList.appendChild(item);
  });
}

function currentStage(id) {
  if (state.running && STAGES.some((stage) => stage.id === id)) { state.runStage = id; state.runFraction = 0; }
  renderStepList(id);
  // A stage change is the primary driver of the sticky bar: it re-points the
  // step counter, the title and the progress bar at the card the operator
  // should be looking at.
  const step = stepCardForStage(id);
  if (step) setStatusBar({ step, message: stageMessage(step), kind: "pending" });
}

/** One plain-English line per wizard step: what is happening / what to do now. */
function stageMessage(step) {
  const blocked = installReadinessReason();
  switch (step) {
    case "device-build":
      return state.board
        ? `Installing for ${boardLabel(state.board)} on build ${state.release?.tag ?? "(choose a build)"}.`
        : "Choose your device to see the builds made for it.";
    case "download-verify":
      if (state.bundleReady) return `Build verified: ${state.files.size} file(s) checked against the published checksums.`;
      if (state.fetchingBundle) return "Downloading the build and checking every file. Keep this tab open.";
      if (!state.board) return "Waiting for you to choose your device in step 1 — the build to download depends on it.";
      return state.release ? "Press Download and verify to fetch and check the published build."
        : "Choose a build first, then download and verify it.";
    case "connect-device":
      if (state.identity) {
        const blockedHere = installReadinessReason();
        return blockedHere ? `Device found (${state.identity.product}). Install is blocked: ${blockedHere}.`
          : `Device found (${state.identity.product}). Everything is checked — press Run the install in step 5.`;
      }
      return "Press Query device and choose your Echo in Chrome's list. This only reads; it writes nothing. Already in TWRP? Press “My Echo is already in recovery” instead.";
    case "unlock-payload":
      return state.payloadBytes ? `Unlock payload ${state.payloadName} is verified and ready.`
        : "This device is locked: select the pinned Amonet ZIP so the unlock stage has its verified payload.";
    case "configure":
      return provisionMessage();
    case "install":
      if (state.running) return "Install in progress. Watch the progress bar; do not unplug the device.";
      if (state.stageProgress?.finalize === "done") return installDoneMessage();
      if (blocked) return `Install is not available yet: ${blocked}.`;
      return state.provisionChosen ? "Everything is verified. Press Install."
        : "Everything is verified. Optional: fill in step 5 (account and Wi-Fi) so your Echo sets itself up, then press Install.";
    default:
      return "Working…";
  }
}

// --- wizard status bar + step cards ----------------------------------------
//
// The whole point of this rewrite: the operator must never have to scroll back
// up to find out what is happening. Every stage change, operator action,
// success and failure is republished through ONE function, setStatusBar, so the
// sticky bar and the step cards can never disagree with each other or with the
// log. Nothing important lives only in the terminal panel.

// The six wizard steps, in the order the operator does them. `stage` maps a
// card to the STAGES entry that makes it active, so the run can highlight the
// right card as it progresses. Step 5 (configure) is optional: skipping it is a
// first-class, valid outcome and never blocks the install.
const WIZARD_STEPS = [
  { id: "device-build", title: "Device & build", summary: () => {
    const build = state.release?.tag;
    return build ? `${boardLabel(state.board)} · ${build}` : "No build selected yet.";
  } },
  { id: "download-verify", title: "Download & verify", summary: () => {
    if (state.bundleReady) return `Verified ${state.files.size} file(s) for ${boardLabel(state.board)}.`;
    if (state.fetchingBundle) return "Downloading and checking the published build…";
    return "Nothing downloaded yet.";
  } },
  { id: "connect-device", title: "Connect the device", summary: () => {
    if (!state.identity) return "No device queried yet.";
    return `${state.identity.profile?.marketing ?? state.identity.product ?? "Device"} · ${state.identity.serialMasked ?? ""}`.trim();
  } },
  { id: "unlock-payload", title: "Unlock payload", summary: () => state.payloadBytes
    ? `${state.payloadName} verified and ready.` : "Not needed." },
  { id: "configure", title: "Configure your device", summary: () => provisionSummary() },
  { id: "install", title: "Install", summary: () => {
    const blocked = installReadinessReason();
    if (state.running) return "Install in progress.";
    if (state.stageProgress?.finalize === "done") return installDoneSummary();
    return blocked ? `Blocked: ${blocked}` : "Ready to run the install.";
  } },
];

const STEP_STAGE_MAP = {
  "device-build": null,
  "download-verify": "release",
  "connect-device": "device",
  "unlock-payload": "unlock",
  configure: "configure",
  install: "stage",
};

/** Which wizard card a run stage belongs to, or null when it spans the run. */
function stepCardForStage(stageId) {
  return STEP_STAGE_MAP[stageId] ? stageId : Object.keys(STEP_STAGE_MAP).find((key) => STEP_STAGE_MAP[key] === stageId) ?? null;
}

const cardNode = (id) => document.getElementById(`card-${id}`) ?? (id === "unlock-payload" ? document.getElementById("amonet-panel") : null);
const badgeNode = (id) => document.getElementById(`badge-${id}`);
const summaryNode = (id) => document.getElementById(`summary-${id}`);

/**
 * Repaints the numbered step cards: badge, one-line summary, and which one is
 * active. `activeStep` is a wizard step id; the active card is scrolled into
 * view so a change of step is never silent.
 */
export function renderStepCards(activeStep = null) {
  for (const step of WIZARD_STEPS) {
    const badge = badgeNode(step.id);
    const summary = summaryNode(step.id);
    let status = "waiting";
    if (step.id === activeStep) status = "active";
    else if (stepDone(step.id)) status = "done";
    else if (stepReady(step.id)) status = "ready";
    const card = cardNode(step.id);
    if (card) card.dataset.state = status;
    if (badge) {
      badge.dataset.state = status === "active" ? "ready" : status;
      badge.textContent = status === "active" ? "do this now"
        : status === "done" ? "done" : status === "ready" ? "ready" : "waiting";
    }
    if (summary) summary.textContent = step.summary();
  }
  // The unlock card only exists for a locked device, exactly as before.
  const unlockCard = cardNode("unlock-payload");
  if (unlockCard && amonetRequirement().mode !== "required") unlockCard.dataset.state = "waiting";
  if (activeStep) scrollCardIntoView(activeStep);
}

/** A card is done when the work it gates is complete. */
function stepDone(id) {
  // A release is pre-selected before any device is chosen, so "a release exists"
  // alone must not mark step 1 finished — the device choice is part of it.
  if (id === "device-build") return Boolean(state.board) && Boolean(state.release);
  if (id === "download-verify") return state.bundleReady === true;
  if (id === "connect-device") return Boolean(state.identity);
  if (id === "unlock-payload") return Boolean(state.payloadBytes);
  // Step 5 is done by a DECISION, not by a prerequisite: skipping is a complete,
  // valid answer, so it must never leave the card "ready" and nagging.
  if (id === "configure") {
    if (state.postInstall === "needs-setup" || state.postInstall === "setup-failed") return false;
    return state.provisionChosen && provisionDecided();
  }
  return state.stageProgress?.finalize === "done" || installReadinessReason() === null;
}

function stepReady(id) {
  if (id === "device-build") return !state.board || (Boolean(state.board) && !state.release);
  if (id === "download-verify") return Boolean(state.board) && Boolean(state.release) && !state.bundleReady && !state.fetchingBundle;
  if (id === "connect-device") return Boolean(state.bundleReady) && !state.identity;
  if (id === "unlock-payload") return amonetRequirement().mode === "required" && !state.payloadBytes;
  if (id === "configure") {
    if (state.postInstall === "needs-setup" || state.postInstall === "setup-failed") return true;
    return !state.provisionChosen || (provisionDecided() ? false : provisionFormValid());
  }
  return state.identity ? installReadinessReason() === null : false;
}

/**
 * Brings the active card into view. Deliberately tolerant: `scrollIntoView` is
 * absent from the node test DOM stubs, and a missing scroll hint must never be
 * able to break a run.
 */
function scrollCardIntoView(id) {
  const card = cardNode(id);
  try {
    card?.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  } catch { /* no scroll support in this environment */ }
}

let statusBarActionHandler = null;
// The last published payload, so a mirrored log line can update the message
// WITHOUT clearing the primary action the operator is being asked to press.
let lastStatusBar = { step: null, message: "", kind: "pending", action: null, hint: "", secondary: "" };

/**
 * The single status-bar publisher. `action` is the one primary button the
 * operator may press now; it is delegated so the same handler can be offered
 * from the bar, and its label is written into the button rather than baked into
 * the markup. Passing `null` for action removes the button entirely.
 */
export function setStatusBar({ step = null, message = "", kind = "pending", action = null, hint = "", secondary = "", focusAction = false } = {}) {
  const stepDef = WIZARD_STEPS.find((entry) => entry.id === step) ?? null;
  const activeStage = stepDef ? STAGES.findIndex((stage) => stage.id === STEP_STAGE_MAP[stepDef.id]) : -1;
  if (dom.statusBarStage) {
    dom.statusBarStage.textContent = stepDef
      ? `Step ${WIZARD_STEPS.indexOf(stepDef) + 1} of ${WIZARD_STEPS.length}`
      : "LibreEcho installer";
  }
  if (dom.statusBarTitle) dom.statusBarTitle.textContent = stepDef ? stepDef.title : "Ready";
  if (dom.statusBarMessage) dom.statusBarMessage.textContent = message;
  if (dom.statusBar) dom.statusBar.dataset.kind = kind;
  const percent = state.postInstall === "done" ? 100
    : state.runStage ? runPercent(state.runStage, state.runFraction)
      : Math.max(0, Math.min(100, Math.round(
        (activeStage >= 0 ? (activeStage / Math.max(1, STAGES.length - 1)) * 100 : 0))));
  if (dom.statusBarFill) dom.statusBarFill.style.width = `${percent}%`;
  // ARIA progress value is set defensively: a host without setAttribute (the node
  // test DOM stubs) must not be able to break a run.
  try { dom.statusBarProgress?.setAttribute?.("aria-valuenow", String(percent)); } catch { /* no ARIA support */ }
  statusBarActionHandler = typeof action === "function" ? action : null;
  if (dom.statusBarActionRow) dom.statusBarActionRow.hidden = !action;
  if (dom.statusBarAction && action) {
    dom.statusBarAction.textContent = action.label ?? "Continue";
    dom.statusBarAction.dataset.actionLabel = action.label ?? "";
    dom.statusBarAction.disabled = action.disabled === true;
  }
  if (dom.statusBarHint) dom.statusBarHint.textContent = hint;
  if (dom.statusBarSecondary) dom.statusBarSecondary.textContent = secondary;
  lastStatusBar = { step, message, kind, action, hint, secondary };
  renderStepCards(step);
  if (focusAction && dom.statusBarAction) {
    try { dom.statusBarAction.focus?.(); } catch { /* no focus support */ }
    try { dom.statusBarAction.scrollIntoView?.({ block: "nearest" }); } catch { /* no scroll support */ }
  }
}

/**
 * Mirrors a log line into the bar when it matters, so nothing is log-only.
 *
 * The pending primary action is deliberately PRESERVED: an operator who is
 * being told "no USB device was chosen; still waiting" must not also have the
 * button they need to press removed from under them. A later real state change
 * (refreshControls) republishes the correct action anyway.
 */
export function mirrorToStatusBar({ kind, message } = {}) {
  if (kind !== "error" && kind !== "warn") return;
  const action = lastStatusBar.action;
  setStatusBar({
    step: lastStatusBar.step,
    message,
    kind,
    action: action ? { label: action.label ?? "Continue" } : null,
    hint: lastStatusBar.hint,
    secondary: lastStatusBar.secondary,
  });
}

// --- capability ------------------------------------------------------------

async function reportCapabilities() {
  const support = webusbSupport();
  const protocols = await protocolSupport();
  const rows = [
    ["WebUSB", support.ok ? "available" : "unavailable", support.ok ? "ok" : "bad", support.reason],
    ["Secure context", support.secure ? "yes" : "no", support.secure ? "ok" : "bad", "WebUSB requires HTTPS."],
    ["Fastboot module", protocols.fastboot.ok ? "loaded" : "missing", protocols.fastboot.ok ? "ok" : "bad", protocols.fastboot.reason ?? ""],
    ["Fastboot transport", protocols.fastbootTransport.ok ? "loaded" : "missing", protocols.fastbootTransport.ok ? "ok" : "bad", protocols.fastbootTransport.reason ?? ""],
    ["ADB module", protocols.adb.ok ? "loaded" : "missing", protocols.adb.ok ? "ok" : "bad", protocols.adb.reason ?? ""],
    ["ADB transport", protocols.adbTransport.ok ? "loaded" : "missing", protocols.adbTransport.ok ? "ok" : "bad", protocols.adbTransport.reason ?? ""],
  ];
  dom.capability.innerHTML = "";
  for (const [label, value, kind, note] of rows) {
    const row = document.createElement("div");
    row.className = "capability-row";
    row.innerHTML = `<span class="capability-label"></span><span class="capability-value"></span><span class="capability-note"></span>`;
    row.querySelector(".capability-label").textContent = label;
    const valueNode = row.querySelector(".capability-value");
    valueNode.textContent = value;
    valueNode.dataset.state = kind;
    row.querySelector(".capability-note").textContent = note ?? "";
    dom.capability.appendChild(row);
  }
  // Everything that matters is one line unless something is actually wrong; the
  // per-capability table stays available in the <details> above the steps.
  const failures = rows.filter(([, , kind]) => kind === "bad");
  if (dom.capabilitySummary) {
    if (failures.length === 0) {
      dom.capabilitySummary.textContent = "Browser ready ✓ — WebUSB and the protocol modules are loaded.";
      dom.capabilitySummary.dataset.state = "ok";
    } else {
      dom.capabilitySummary.textContent = `${failures.length} browser requirement(s) not met — open the details below.`;
      dom.capabilitySummary.dataset.state = "bad";
    }
  }
  if (!support.ok) {
    terminal.warn(support.reason);
    // A browser that cannot do the job is a page-level failure, not a log line.
    setStatusBar({ step: "device-build", message: support.reason, kind: "bad",
      action: null, secondary: "Open the capability details to see which check failed." });
  }
  return { support, protocols };
}

// --- releases and download --------------------------------------------------

const boards = installableBoards();

function boardLabel(board) {
  return profileForBoard(board)?.marketing ?? board ?? "your device";
}

function clearBundleReadiness() {
  state.bundleReady = false;
  state.bundleBoard = null;
  state.bundleHardwareAccepted = false;
  state.target = null;
  state.targetsJson = null;
  state.files = new Map();
  state.sums = null;
}

function discardAutomaticBundle() {
  state.downloadController?.abort();
  state.downloadController = null;
  state.fetchingBundle = false;
  stopDownloadTimer();
  const old = state.downloadedBundle;
  state.downloadedBundle = null;
  if (old) old.dispose().catch(error => terminal.warn(`download cleanup: ${error.message}`));
}

async function resolveSources() {
  const source = await discoverMirror({ mirrorBase: config.mirrorBase, origin: window.location.origin });
  const local = config.mirrorBase && !config.amonetMirrorBase
    ? await discoverMirror({ origin: window.location.origin }) : source;
  if (local?.amonetMirrorBase && !config.amonetMirrorBase) config.amonetMirrorBase = local.amonetMirrorBase;
  return source?.mirrorBase || config.bootstrapBase;
}

// --- plain-language helpers -------------------------------------------------

const KIND_WORD = { stable: "Stable release", development: "Development build" };

function kindWord(release) {
  return KIND_WORD[release?.kind] ?? "Build";
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown date";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Best-effort size of one board's assets, read from the verified GitHub listing. */
function targetBytes(release, board) {
  const profile = profileForBoard(board);
  if (!release || !profile) return 0;
  const scoped = release.assets.filter(asset => asset.name.startsWith(`libreecho-${profile.slug}`));
  const list = scoped.length ? scoped : release.assets;
  return list.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
}

function releasesForBoard() {
  if (!state.board) return state.releases;
  return state.releases.filter(release => releaseOffersBoard(release, state.board));
}

function renderBoardOptions() {
  if (!dom.deviceSelect) return;
  dom.deviceSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose your device…";
  dom.deviceSelect.appendChild(placeholder);
  for (const board of boards) {
    const option = document.createElement("option");
    option.value = board.board;
    option.textContent = board.marketing;
    dom.deviceSelect.appendChild(option);
  }
  dom.deviceSelect.value = state.board ?? "";
}

function pickDefaultRelease() {
  const candidates = [...releasesForBoard()].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return candidates.find(release => release.kind === "stable") ?? candidates[0] ?? null;
}

function renderReleaseOptions() {
  if (!dom.releaseSelect) return;
  dom.releaseSelect.innerHTML = "";
  if (!state.board) {
    const hint = document.createElement("option");
    hint.value = "";
    hint.textContent = "Choose your device first";
    dom.releaseSelect.appendChild(hint);
    state.release = pickDefaultRelease();
    dom.releaseSelect.value = state.release?.tag ?? "";
    return;
  }
  const list = [...releasesForBoard()].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  if (list.length === 0) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = `No builds available for ${boardLabel(state.board)}`;
    dom.releaseSelect.appendChild(none);
    state.release = null;
    dom.releaseSelect.value = "";
    return;
  }
  for (const release of list) {
    const option = document.createElement("option");
    option.value = release.tag;
    option.textContent = `${kindWord(release)} · ${formatDate(release.publishedAt)} · ${formatSize(targetBytes(release, state.board))}`;
    dom.releaseSelect.appendChild(option);
  }
  state.release = pickDefaultRelease();
  dom.releaseSelect.value = state.release?.tag ?? "";
}

// --- download progress ------------------------------------------------------

function ensureDownloadPanel(visible) {
  if (dom.downloadPanel) dom.downloadPanel.style.display = visible ? "" : "none";
}

function setDownloadPhase(phase) {
  if (dom.downloadPhase) dom.downloadPhase.textContent = phase;
}

function renderDownloadProgress({ percent = 0, done = 0, total = 0, index = 0, count = 0, etaMs = null } = {}) {
  const clamped = Math.max(0, Math.min(100, percent));
  if (dom.downloadBar) dom.downloadBar.style.width = `${clamped.toFixed(1)}%`;
  if (dom.downloadPercent) dom.downloadPercent.textContent = `${Math.round(clamped)}%`;
  if (dom.downloadBytes) dom.downloadBytes.textContent = `${formatSize(done)} of ${formatSize(total)}`;
  if (dom.downloadFiles) dom.downloadFiles.textContent = count ? `file ${Math.min(Math.max(index, 1), count)} of ${count}` : "";
  if (dom.downloadEta) dom.downloadEta.textContent = Number.isFinite(etaMs) && etaMs > 0 ? `about ${formatDuration(etaMs)} left` : "";
}

function resetProgressClock() {
  state.progressClock = { startedAt: Date.now(), done: 0, total: 0, rate: 0 };
}

function etaFor(done, total) {
  const clock = state.progressClock;
  if (!clock || !total || done <= 0) return null;
  const elapsed = Math.max(1, Date.now() - clock.startedAt);
  clock.rate = done / elapsed;
  clock.done = done;
  clock.total = total;
  return computeEta({ done, total, elapsedMs: elapsed });
}

function startDownloadTimer() {
  stopDownloadTimer();
  state.downloadTimer = setInterval(() => {
    const clock = state.progressClock;
    if (!clock || !clock.total || clock.done >= clock.total) return;
    const percent = (clock.done / clock.total) * 100;
    renderDownloadProgress({ percent, done: clock.done, total: clock.total, index: clock.index ?? 0, count: clock.count ?? 0, etaMs: etaFor(clock.done, clock.total) });
  }, 1000);
}

function stopDownloadTimer() {
  if (state.downloadTimer) { clearInterval(state.downloadTimer); state.downloadTimer = null; }
}

function showDownloadError(message) {
  if (dom.downloadError) { dom.downloadError.textContent = message; dom.downloadError.style.display = ""; }
  if (dom.buttons.retry) dom.buttons.retry.style.display = "";
}

function hideDownloadError() {
  if (dom.downloadError) { dom.downloadError.textContent = ""; dom.downloadError.style.display = "none"; }
  if (dom.buttons.retry) dom.buttons.retry.style.display = "none";
}

export function handleDownloadEvent(event) {
  if (!event) return;
  if (event.phase === "preparing") {
    setDownloadPhase("Preparing");
    if (dom.downloadFiles) dom.downloadFiles.textContent = event.name ? `reading ${event.name}` : "";
    return;
  }
  if (event.phase === "downloading") {
    setDownloadPhase("Downloading");
    const clock = state.progressClock;
    if (clock) { clock.index = event.index; clock.count = event.count; }
    renderDownloadProgress({
      percent: event.total ? (event.done / event.total) * 100 : 0,
      done: event.done, total: event.total, index: event.index, count: event.count,
      etaMs: etaFor(event.done, event.total),
    });
    if (event.fileBytes === 0 && event.name) {
      terminal.line(`[${event.index}/${event.count}] ${event.name} — ${formatSize(event.fileTotal)}`);
    }
    return;
  }
  if (event.phase === "verifying") {
    setDownloadPhase("Checking files");
    const clock = state.progressClock;
    if (clock) {
      if (Number.isFinite(event.index) && event.index > 0) clock.index = event.index;
      if (Number.isFinite(event.count) && event.count > 0) clock.count = event.count;
    }
    const index = clock?.index ?? 0;
    const count = clock?.count ?? 0;
    // Keep the file X of Y counter visible while hashing; filenames belong in
    // the log, not in the compact counter. The ETA is unknown during hashing.
    if (dom.downloadFiles && count > 0) {
      dom.downloadFiles.textContent = `file ${Math.min(Math.max(index, 1), count)} of ${count}`;
    }
    if (dom.downloadEta) dom.downloadEta.textContent = "";
    if (event.name) terminal.line(`checking ${event.name}`);
    return;
  }
  if (event.phase === "complete") {
    renderDownloadProgress({ percent: 100, done: event.total, total: event.total, index: event.count, count: event.count });
  }
}


export async function fetchBundleAutomatically({ mirrorBase = null, reuse = false, board = null, onEvent = handleDownloadEvent } = {}) {
  if (state.running) throw new Error("cannot download during an active run");
  const release = state.release;
  if (!release) return false;
  const chosenBoard = board ?? state.board ?? "radar_puffin";
  if (!isInstallableBoard(chosenBoard)) {
    showDownloadError("Choose your device first, then download its build.");
    return false;
  }
  if (!releaseOffersBoard(release, chosenBoard)) {
    showDownloadError(`This build is not offered for ${boardLabel(chosenBoard)}. Choose a build made for your device.`);
    return false;
  }
  if (!reuse || state.downloadedBundle?.release !== release || state.downloadedBundle?.board !== chosenBoard) discardAutomaticBundle();
  state.downloadController?.abort();
  const controller = new AbortController();
  state.downloadController = controller;
  state.fetchingBundle = true;
  clearBundleReadiness();
  state.board = chosenBoard;
  setRunning(false);
  hideDownloadError();
  resetProgressClock();
  startDownloadTimer();
  ensureDownloadPanel(true);
  if (dom.downloadPanel) dom.downloadPanel.dataset.state = "";
  setDownloadPhase("Preparing");
  renderDownloadProgress({ percent: 0, done: 0, total: 0, index: 0, count: 0 });
  setStatus(dom.statusBundle, "downloading and checking", "pending");
  terminal.info(`preparing ${kindWord(release).toLowerCase()} ${release.tag} for ${boardLabel(chosenBoard)}`);
  let bundle;
  let store;
  try {
    mirrorBase ||= await resolveSources();
    controller.signal.throwIfAborted();
    if (!mirrorBase) throw new Error("no download source is configured for this page; use the advanced option to verify files you already downloaded");
    store = await createBundleStore();
    const targetsJson = await fetchTargetsJson(release, { mirrorBase, signal: controller.signal, store, onEvent });
    const target = targetForBoard({ tag: release.tag, board: chosenBoard, targetsJson });
    state.targetsJson = targetsJson;
    state.target = target;
    bundle = state.downloadedBundle ?? await fetchReleaseBundle(release, {
      board: chosenBoard, targetsJson, mirrorBase, signal: controller.signal, store, onEvent,
    });
    if (state.release !== release || state.downloadController !== controller) throw new Error("build changed during download");
    bundle.release = release;
    bundle.board = chosenBoard;
    state.downloadedBundle = bundle;
    const byName = new Map(bundle.files.map(file => [file.name, file]));
    controller.signal.throwIfAborted();
    await verifyBundle([...byName.values()], { automatic: true, target });
    if (state.bundleReady) {
      if (dom.downloadPanel) dom.downloadPanel.dataset.state = "ok";
      setDownloadPhase("Verified");
      renderDownloadProgress({ percent: 100, done: bundle.totalBytes ?? 0, total: bundle.totalBytes ?? 0, index: bundle.fileCount ?? 0, count: bundle.fileCount ?? 0 });
    }
    return state.bundleReady;
  } catch (error) {
    if (state.downloadController === controller) {
      clearBundleReadiness();
      state.downloadedBundle = null;
      setStatus(dom.statusBundle, "download failed", "bad");
      terminal.error(error.message);
      showDownloadError(error.message);
    }
    if (bundle) await bundle.dispose();
    else if (store?.dispose) { try { await store.dispose(); } catch { /* already disposed */ } }
    return false;
  } finally {
    if (state.downloadController === controller) {
      state.downloadController = null;
      state.fetchingBundle = false;
      terminal.endProgress();
      stopDownloadTimer();
      setRunning(false);
    }
  }
}


export async function loadReleases() {
  if (state.running) throw new Error("cannot refresh builds during an active run");
  discardAutomaticBundle();
  state.sums = null;
  state.files = new Map();
  state.bundleReady = false;
  state.bundleBoard = null;
  state.bundleHardwareAccepted = false;
  state.target = null;
  state.targetsJson = null;
  setRunning(false);
  hideDownloadError();
  ensureDownloadPanel(false);
  setStatus(dom.statusBundle, "nothing downloaded", "pending");
  setStatus(dom.statusRelease, "loading", "pending");
  terminal.info(`reading the build list for ${config.repository} (api.github.com)`);
  try {
    state.releases = await fetchReleaseIndex(config.repository);
  } catch (error) {
    setStatus(dom.statusRelease, "unavailable", "bad");
    terminal.error(`build list unavailable: ${error.message}`);
    terminal.warn("the installer still works: use the advanced option to verify files you downloaded yourself.");
    return;
  }
  renderBoardOptions();
  renderReleaseOptions();
  const preferredTag = config.releaseTag;
  if (preferredTag) {
    const preferred = state.releases.find((release) => release.tag === preferredTag
      && (!state.board || releaseOffersBoard(release, state.board)));
    if (preferred) { state.release = preferred; dom.releaseSelect.value = preferred.tag; }
  }
  describeSelectedRelease();
  setStatus(dom.statusRelease, state.release ? "ready" : "none", state.release ? "ok" : "bad");
  if (!state.board) terminal.info("choose your device above to see the builds made for it");
  else if (!state.release) terminal.warn(`no build for ${boardLabel(state.board)} is published yet`);
  else terminal.ok(`latest build for ${boardLabel(state.board)}: ${state.release.tag}`);
  setRunning(false);
}

function describeSelectedRelease() {
  if (!dom.releaseMeta) return;
  const release = state.release;
  dom.releaseMeta.innerHTML = "";
  if (!release) {
    const note = document.createElement("p");
    note.className = "fine-print";
    note.textContent = state.board
      ? `No build for ${boardLabel(state.board)} is available yet.`
      : "Choose your device to see the builds made for it.";
    dom.releaseMeta.appendChild(note);
    return;
  }
  const lines = [
    `${kindWord(release)} for ${state.board ? boardLabel(state.board) : "a supported device"} · ${formatDate(release.publishedAt)} · ${formatSize(targetBytes(release, state.board ?? "radar_puffin"))}`,
  ];
  if (release.prerelease) lines.push("This is a development preview, not a final release.");
  for (const line of lines) {
    const row = document.createElement("p");
    row.className = "fine-print";
    row.textContent = line;
    dom.releaseMeta.appendChild(row);
  }
  const tag = document.createElement("p");
  tag.className = "fine-print";
  tag.textContent = `build id: ${release.tag}`;
  dom.releaseMeta.appendChild(tag);
  const link = document.createElement("a");
  link.className = "text-link";
  link.href = releasePageUrl(release.tag, config.repository);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Open the release page";
  dom.releaseMeta.appendChild(link);
}

// --- bundle ----------------------------------------------------------------

export function resolveSelectionTarget(release, files = [], { target = state.target, targetsJson = state.targetsJson, board = state.board } = {}) {
  if (target) return target;
  if (!release) throw new Error("select a build first");
  // A combined release names its targets in a descriptor. Without the verified
  // descriptor there is no safe way to pick a board, so never fall back to the
  // legacy Radar alias for a release that advertises one.
  if (releaseDeclaresTargets(release) && !targetsJson) {
    throw new Error("this combined build needs its verified targets.json before a target can be resolved");
  }
  if (!targetsJson) return targetsForRelease({ tag: release.tag })[0];
  if (board) return targetForBoard({ tag: release.tag, board, targetsJson });
  const inventory = files.find((file) => typeof file?.name === "string"
    && file.name.endsWith("-SHA256SUMS") && !file.name.endsWith("-TWRPINSTALL-SHA256SUMS"));
  if (!inventory) throw new Error("choose your device first, or include the release's -SHA256SUMS file");
  const prefix = inventory.name.slice(0, -"-SHA256SUMS".length);
  const match = targetsForRelease({ tag: release.tag, targetsJson }).find((entry) => entry.prefix === prefix);
  if (!match) throw new Error("these files do not match any target published by this build");
  return match;
}

/**
 * For a combined release selected by hand, finds the advertised targets.json in
 * the selection, verifies its size and SHA-256 against the release API's record,
 * and returns its text. A release that advertises a descriptor but does not
 * carry a verifiable one is refused rather than treated as legacy Radar.
 */
async function resolveSelectedTargetsJson(release, byName) {
  if (!releaseDeclaresTargets(release)) return null;
  const name = targetsAssetName(release.tag);
  const file = byName.get(name);
  const asset = release.assets.find((entry) => entry.name === name);
  if (!file || !asset || !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "") || file.size !== asset.size) {
    throw new Error(`this combined build needs its verified ${name}: select it with the other files, or use Download`);
  }
  const actual = await sha256OfBlob(file);
  if (actual !== asset.digest.slice(7)) {
    throw new Error(`${name}: checksum does not match GitHub's record for this build`);
  }
  return file.text();
}

export async function verifyBundle(fileList, { automatic = false, target = null } = {}) {
  if (state.running) throw new Error("cannot change bundle during an active run");
  if (!automatic) discardAutomaticBundle();
  const release = state.release;
  const downloadController = automatic ? state.downloadController : null;
  state.bundleReady = false;
  state.bundleBoard = null;
  state.bundleHardwareAccepted = false;
  state.files = new Map();
  state.sums = null;
  state.installProtocol = null;
  state.directRelease = null;
  state.directHelper = null;
  state.directManifestText = null;
  state.directManifestSha = null;
  state.directRoles = null;
  state.directTransferTotal = null;
  refreshControls();
  if (!release) {
    terminal.error("select a build first");
    return;
  }
  const files = [...fileList];
  const byName = new Map();
  for (const file of files) {
    if (byName.has(file.name)) {
      terminal.error(`duplicate selected asset: ${file.name}`);
      return;
    }
    byName.set(file.name, file);
  }
  let resolved;
  let selectedTargetsJson = null;
  try {
    // A hand-selected combined release carries its own descriptor; verify it
    // against the API record and resolve the board from it, never from a legacy
    // fallback or a stale target.
    selectedTargetsJson = target ? null : await resolveSelectedTargetsJson(release, byName);
    resolved = target ?? resolveSelectionTarget(release, files, { target: null, targetsJson: selectedTargetsJson, board: state.board });
  } catch (error) {
    terminal.error(error.message);
    if (automatic) showDownloadError(error.message);
    return;
  }
  const { normal: normalName, recovery: recoveryNames } = inventoryNamesForTarget({ tag: release.tag, target: resolved });
  try {
    const readPinnedInventory = async (name) => {
      const file = byName.get(name);
      const asset = release.assets.find((entry) => entry.name === name);
      if (!file || !asset || !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "") || file.size !== asset.size) {
        throw new Error(`${name}: missing published checksum file`);
      }
      const actual = await sha256OfBlob(file);
      if (actual !== asset.digest.slice(7)) throw new Error(`${name}: checksum inventory digest mismatch against GitHub's record`);
      return parseSums(await file.text());
    };
    const normal = await readPinnedInventory(normalName);
    const recovery = new Map();
    for (const name of recoveryNames) {
      for (const [entry, expected] of await readPinnedInventory(name)) {
        if (recovery.has(entry) && recovery.get(entry) !== expected) throw new Error(`${entry}: conflicting checksum inventories`);
        recovery.set(entry, expected);
      }
    }
    const required = requiredMembersForTarget(resolved);
    for (const name of required.normal) {
      if (!normal.has(name)) throw new Error(`${name}: missing from the correct release checksum inventory`);
    }
    for (const name of required.recovery) {
      if (!recovery.has(name)) throw new Error(`${name}: missing from the recovery checksum inventory`);
    }
    const sums = new Map(normal);
    for (const [name, expected] of recovery) {
      if (sums.has(name) && sums.get(name) !== expected) throw new Error(`${name}: conflicting checksum inventories`);
      sums.set(name, expected);
    }
    for (const [name, expected] of sums) {
      const asset = release.assets.find((entry) => entry.name === name);
      if (!asset || asset.digest !== `sha256:${expected}` || byName.get(name)?.size !== asset.size) {
        throw new Error(`${name}: missing asset or published digest/size differs from the checksum listing`);
      }
    }
    const result = await verifyBundleFiles(files, {
      sums,
      onProgress: (fraction, name) => terminal.progress("checking files", fraction, name),
    });
    terminal.endProgress();
    if (result.failed.length || result.missing.length) {
      throw new Error(`not complete: ${result.failed.length} file(s) did not match, ${result.missing.length} missing`);
    }
    const manifestName = recoveryManifestNameForTarget(resolved);
    const manifest = result.byName.get(manifestName);
    if (!manifest) throw new Error(`the recovery bundle manifest (${manifestName}) is missing`);
    const parsedManifest = parseBundleManifest(await manifest.text(), resolved);
    const build = JSON.parse(await result.byName.get(`${resolved.prefix}-build.json`).text());
    if (!build.board || String(build.board).toLowerCase() !== resolved.board) {
      throw new Error(`the build metadata names ${build.board ?? "no board"}, not ${resolved.board}`);
    }
    const metadata = await extractRecoveryMetadata(result.byName, { prefix: resolved.prefix, manifestName });
    for (const [name, digest] of metadata.sums) {
      if (sums.has(name)) throw new Error(`${name}: derived metadata collides with inventory`);
      sums.set(name, digest);
      result.byName.set(name, metadata.files.get(name));
      result.checked.push({ name, sha256: digest, size: metadata.files.get(name).size });
    }
    // A protocol-2 release is fully verified on the computer here: every exact
    // transfer role resolves to a verified blob, the byte total matches, the
    // signed manifest verifies against the published key, and the bounded helper
    // extracts from the verified ZIP. A protocol-less bundle is left as legacy
    // for runInstall to refuse before unlock; a present-but-wrong protocol was
    // already rejected by parseBundleManifest.
    if (parsedManifest.protocol === DIRECT_PROTOCOL) {
      const prepared = await prepareDirectInstall({ parsed: parsedManifest, files: result.byName, sums, target: resolved, manifestName });
      state.installProtocol = DIRECT_PROTOCOL;
      state.directRoles = prepared.roles;
      state.directTransferTotal = prepared.transferBytesTotal;
      state.directHelper = prepared.helper;
      state.directManifestText = prepared.manifestText;
      state.directManifestSha = prepared.manifestSha256;
      state.directRelease = String(parsedManifest.fields.release ?? "");
    }
    if (state.release !== release || (automatic && (downloadController?.signal.aborted || state.downloadController !== downloadController))) throw new Error("build selection changed during checking");
    state.target = resolved;
    if (selectedTargetsJson) state.targetsJson = selectedTargetsJson;
    state.sums = sums;
    state.files = result.byName;
    state.bundleBoard = build.board;
    state.bundleHardwareAccepted = build.hardware_accepted === true;
    state.bundleReady = true;
    setRunning(false);
    setStatus(dom.statusBundle, `${result.checked.length} files verified`, "ok");
    terminal.ok(`complete bundle verified against the published checksums and GitHub's record (${build.board})`);
    if (!state.bundleHardwareAccepted) {
      terminal.warn("this build is not marked hardware-accepted; it can be verified but not installed by this page");
    }
  } catch (error) {
    if (automatic && state.downloadController !== downloadController) return;
    terminal.endProgress();
    setStatus(dom.statusBundle, "checking failed", "bad");
    terminal.error(error.message);
    if (automatic) showDownloadError(error.message);
  }
}

// --- device ----------------------------------------------------------------

/**
 * What the operator is told when a fastboot query read nothing at all.
 *
 * The page must not remember an empty identity: it would both block the install
 * ("fastboot serialno is missing") and refuse the recovery entry ("a device is
 * already identified"), leaving a reloaded page with no way forward.
 */
export const EMPTY_FASTBOOT_IDENTITY_MESSAGE = "the device did not answer fastboot";

export async function queryDevice({ any = false, open = openFastboot } = {}) {
  // The page opens one USB connection at a time. Taken BEFORE any await and
  // before the state reset below, so a refused query cannot invalidate an
  // identity an in-flight ADB operation is still using.
  // `shareWith: ["query"]` — a second query is superseded, not refused: the
  // deviceQueryEpoch contract already makes the older one close its own session.
  const releaseOperation = beginDeviceOperation("query", { shareWith: ["query"] });
  if (!releaseOperation) return null;
  try {
    return await runDeviceQuery({ any, open });
  } finally {
    releaseOperation();
  }
}

/** The body of `queryDevice`, with the page-wide USB slot already claimed. */
async function runDeviceQuery({ any, open }) {
  // Never carry a previous unlock decision into a failed or superseded query.
  // This function also serves the run-owned query when no device is selected.
  const epoch = ++state.deviceQueryEpoch;
  state.fastboot = null;
  state.identity = null;
  state.payloadBytes = null;
  state.payloadName = "";
  dom.archiveInput.value = "";
  dom.payloadInput.value = "";
  invalidateRecovery({ close: true });
  dom.devicePanel.innerHTML = "";
  refreshControls();
  currentStage("device");
  // Set when the device answered nothing, so the failure handler below can keep
  // the refusal as the LAST thing it publishes — a repaint after the message
  // would overwrite the sticky status bar with the generic stage text.
  let answeredNothing = false;
  try {
    if (any) terminal.info("unfiltered chooser: the browser will list every USB device on this machine");
    const session = await open({ onLog: (line) => terminal.line(line), any });
    if (state.deviceQueryEpoch !== epoch) {
      await closeRecoverySession(session);
      throw new StageError("device", "device query superseded by another selection");
    }
    state.fastboot = session;
    terminal.ok(`fastboot device ready: ${describeUsbDevice(session.device)}`);
    currentStage("identity");
    const identity = await readFastbootIdentity(session.client, terminal);
    if (state.deviceQueryEpoch !== epoch) {
      await closeRecoverySession(session);
      throw new StageError("device", "device query superseded by another selection");
    }
    // A device that answered NOTHING is not an identity. Storing one — even an
    // all-empty one — is what wedged the page on 2026-10-03: the status bar then
    // said "Install is not available yet: fastboot serialno is missing" and the
    // recovery entry was refused as "a device is already identified", so a
    // reloaded page could not continue. Product AND serial both empty is exactly
    // what adbd (or a wedged interface) looks like to a fastboot client: refuse,
    // close, leave state.identity null so the recovery entry stays available.
    if (!identity.product && !identity.serialRaw) {
      await closeRecoverySession(session);
      state.fastboot = null;
      dom.devicePanel.innerHTML = "";
      answeredNothing = true;
      throw new StageError("device", EMPTY_FASTBOOT_IDENTITY_MESSAGE);
    }
    state.identity = identity;
    state.payloadBytes = null;
    state.payloadName = "";
    setStatus(dom.statusPayload, "select the pinned archive for this device", "pending");
    state.adb = null;
    state.recoverySerial = null;
    state.kaeruHeader = null;
    const assessment = assessIdentity(identity, terminal, { selectedBoard: state.target?.board ?? state.bundleBoard ?? null });
    renderDevicePanel(identity, assessment);
    setStatus(
      dom.statusDevice,
      `${identity.product || "unknown"} · ${assessment.unlocked ? "unlocked" : "locked"} · ${identity.serialMasked}`,
      identity.profile ? (assessment.unlocked ? "ok" : "warn") : "bad",
    );
    refreshControls();
    if (state.downloadedBundle && !state.fetchingBundle) await fetchBundleAutomatically({ reuse: true });
    if (state.deviceQueryEpoch === epoch && config.amonetMirrorBase
      && amonetRequirement().mode === "required" && !state.payloadBytes) {
      await fetchPinnedAmonetArchive().catch(error => {
        if (state.deviceQueryEpoch !== epoch) return;
        setStatus(dom.statusPayload, "select the pinned archive for this device", "pending");
        terminal.warn(`select pinned Amonet ZIP manually: ${error.message}`);
      });
    }
    return identity;
  } catch (error) {
    if (state.deviceQueryEpoch === epoch) {
      state.identity = null;
      state.fastboot = null;
      state.payloadBytes = null;
      state.payloadName = "";
      invalidateRecovery({ close: true });
      dom.devicePanel.innerHTML = "";
      // A device that answered nothing is reported as exactly that, not as
      // "not connected": nothing was ever read from it, so the operator must be
      // pointed at the recovery entry rather than at a cable they already have
      // plugged in. Published AFTER the repaint so nothing overwrites it.
      setStatus(dom.statusDevice, answeredNothing ? "did not answer" : "not connected", "bad");
      refreshControls();
      if (answeredNothing) {
        terminal.error("the device did not answer fastboot — nothing was read from it. "
          + "If your Echo is in recovery, use “My Echo is already in recovery” instead.");
      }
    }
    throw error;
  }
}

function renderDevicePanel(identity, assessment) {
  dom.devicePanel.innerHTML = "";
  const blocked = installReadinessReason();
  // A recovery-entered identity has no fastboot getvar to report, so the rows it
  // cannot honestly fill are replaced with what it *can* prove: how the device
  // was found, and that the unlock was therefore already applied.
  const fromRecovery = identity.source === "recovery";
  const rows = fromRecovery ? [
    ["model", `${identity.profile.marketing} (read from the running TWRP)`],
    ["recovery board", identity.recoveryBoard || "(not reported)"],
    ["TWRP version", identity.twrpVersion || "(not reported)"],
    ["USB serial", identity.serialRaw || "(not reported)"],
    ["unlock_status", "unlocked (Kaeru LK header intact in expdb)"],
    ["found by", "reading the device from recovery — no fastboot identity existed on this page"],
    ["serial privacy", "shown only in this local panel; masked in the log"],
    ["recognised target", `${identity.profile.marketing} — ${identity.profile.libreEcho}`],
    ["userdata contract", identity.profile ? `${(identity.profile.userdataContractSectors ?? []).join(" or ")} sectors` : "—"],
    ["next step", blocked ? `install blocked: ${blocked}` : "recovery verification"],
  ] : [
    ["model", identity.profile ? `${identity.profile.marketing} (inferred from LK product)` : "unrecognised LK product"],
    ["fastboot product", identity.product || "(not reported)"],
    ["USB serial", identity.serialRaw || "(not reported)"],
    ["unlock_status", identity.unlockStatus || "(not reported)"],
    ["LK build description", identity.lkBuild || "(not reported)"],
    ["preloader build description", identity.plBuild || "(not reported)"],
    ["secure", identity.secure || "(not reported)"],
    ["rpmb_state", identity.rpmbState || "(not reported)"],
    ["max-download-size", identity.maxDownload || "(not reported)"],
    ["serial privacy", "shown only in this local panel; masked in the log"],
    ["recognised target", identity.profile ? `${identity.profile.marketing} — ${identity.profile.libreEcho}` : "not a declared LibreEcho target"],
    ["userdata contract", identity.profile ? `${(identity.profile.userdataContractSectors ?? []).join(" or ")} sectors` : "—"],
    ["next step", blocked ? `install blocked: ${blocked}` : (assessment.unlocked ? "recovery verification" : "unlock preflight")],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "device-row";
    row.innerHTML = "<span></span><strong></strong>";
    row.querySelector("span").textContent = label;
    row.querySelector("strong").textContent = value;
    dom.devicePanel.appendChild(row);
  }
}

/**
 * How long the page waits for TWRP before giving up, in milliseconds.
 *
 * Ten minutes, not three: the operator may have to reboot the device by hand and
 * then find Chrome's device chooser. A short deadline expired while a perfectly
 * healthy TWRP was waiting on a human, and the only recovery was reloading the
 * page — which loses every verified artifact. The wait is still bounded and the
 * countdown is visible, and a timeout after a submitted unlock is recoverable
 * in-page via "Continue from TWRP" (see state.unlockSubmitted).
 *
 * Re-exported from ./stages.js so the page wait and the standalone
 * `waitForRecovery` helper share one deadline instead of drifting apart.
 */
export { RECOVERY_TIMEOUT_MS, RECOVERY_POLL_INTERVAL_MS } from "./stages.js";

/** "9:58" / "45s" — the countdown shown while waiting for TWRP. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(Number(ms ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

// --- recovery handoff ------------------------------------------------------

// One lock for the whole page: the background recovery poll and a user-granted
// chooser must never open the same USB interface at the same time.
const recoveryLock = createMutex();
let recoveryWake = null;

// Exactly one owner per USB device at a time.
//
// Serialising validation behind a mutex is not enough. While the poller is
// opening a device and the operator clicks "Allow TWRP access", the second open
// is queued but still *starts* against the same physical interface, so two
// USBDevice opens and two CNXN handshakes interleave on one USB interface and
// both fail ("waiting for CNXN/AUTH", "no more data from the device") even
// though TWRP is healthy. This registry makes ownership exclusive per device so
// a contender skips instead of queueing. The mutex stays as the final
// serialisation point for the case where two owners disagree about a key.
const recoveryClaims = new Map();

/**
 * ONE device operation in flight for the whole page.
 *
 * The per-device registry above cannot see the fastboot query at all: `queryDevice`
 * opens a fastboot transport without ever claiming a recovery key, so a fastboot
 * open and an ADB open could run against the same physical interface at once —
 * the live 2026-10-03 interleaved-CNXN failure. Ownership has to be page-wide, not
 * per-key, because the page has exactly one Echo.
 *
 * The guard is a plain token, never a queue: a contender refuses immediately with
 * a terminal.warn and a status-bar message rather than waiting, because "wait,
 * then open the same interface anyway" is precisely the race. It is taken before
 * the first await of each entry point and released in a finally, so a refusal, a
 * cancel, a timeout and a thrown transport error all free it.
 *
 * A token object rather than the kind alone, so a same-kind re-entry cannot have
 * its release clear the newer holder's claim.
 */
let deviceOperation = null;

/** Human-readable names, used in the refusal the operator reads. */
const DEVICE_OPERATION_LABELS = {
  query: "Query device",
  entry: "My Echo is already in recovery",
  grant: "Allow USB access to TWRP",
  poll: "waiting for TWRP",
};

function describeOperation(kind) {
  return DEVICE_OPERATION_LABELS[kind] ?? "another USB operation";
}

/** The kind of operation this page currently owns, or null. */
function currentDeviceOperation() {
  return deviceOperation?.kind ?? null;
}

/** True while this page owns its single USB operation slot. */
function deviceOperationBusy() {
  return deviceOperation !== null;
}

/**
 * Claims the page's single USB operation slot.
 *
 * Returns a release function instead of throwing, so every caller can release it
 * in its own `finally` without a try/catch dance. `null` is returned when a
 * *different* operation already holds the slot — after warning the operator,
 * which is the whole point of refusing rather than queueing.
 *
 * `shareWith` names kinds that may coexist with this one. Only `queryDevice` uses
 * it: a second query is not a second USB owner, because the epoch contract
 * (`state.deviceQueryEpoch`) already makes an older in-flight query close its
 * own late session and throw "superseded" instead of binding. Two different
 * operations, by contrast, have no such contract and would interleave.
 */
function beginDeviceOperation(kind, { shareWith = [] } = {}) {
  if (deviceOperation && deviceOperation.kind !== kind && !shareWith.includes(deviceOperation.kind)) {
    // Repaint the controls FIRST. The warning below is mirrored into the status
    // bar by the terminal's onLine hook, and any repaint afterwards would
    // overwrite that message with the generic stage text — so the refusal has to
    // be the last thing this function does.
    refreshControls();
    terminal.warn(`${describeOperation(kind)} refused: ${describeOperation(deviceOperation.kind)} `
      + "is already running on this page. Only one USB connection is opened at a time — "
      + "wait for it to finish, then press this again.");
    return null;
  }
  const token = { kind };
  deviceOperation = token;
  return () => { if (deviceOperation === token) deviceOperation = null; };
}

/**
 * Identity of a granted USBDevice for ownership purposes. The descriptor serial
 * is the strongest key; otherwise the vendor/product pair. A key is only ever a
 * *claim* identity — the ADB-reported serial in claimRecoveryDevice stays the
 * authoritative acceptance gate.
 */
function claimKey(device) {
  const serial = String(device?.serialNumber ?? "").trim();
  if (serial) return `serial:${serial}`;
  return `usb:${device?.vendorId ?? "?"}:${device?.productId ?? "?"}`;
}

/** True when someone else already owns this device, so a contender must skip. */
function isRecoveryDeviceBusy(device) {
  return recoveryClaims.has(claimKey(device));
}

/**
 * One actionable explanation per contention episode.
 *
 * The busy refusal used to be published by every caller that hit it — the grant,
 * the entry, and every poll round — so a device that stayed busy for a ten
 * minute wait produced hundreds of identical lines that buried the real message.
 * The episode is keyed on the device's claim identity and released when the
 * contention ends, so a retry after the other owner finishes explains itself
 * again.
 */
function reportUsbBusyOnce(device, what) {
  const key = claimKey(device);
  if (state.usbBusyReportedFor === key) return false;
  state.usbBusyReportedFor = key;
  terminal.warn(`this USB device is already open elsewhere in this page, so ${what} cannot run. `
    + "Wait a few seconds for the other operation to finish, or press Stop, then try again.");
  return true;
}

/** Ends a contention episode so the next refusal explains itself again. */
function clearUsbBusyEpisode(device) {
  if (state.usbBusyReportedFor === claimKey(device)) state.usbBusyReportedFor = null;
}

/** Raised when a claim is refused because another owner holds the device. */
class RecoveryDeviceBusy extends StageError {
  constructor(device) {
    super("recovery", `another part of this page already has this USB device open (${device?.vendorId ?? "?"}:${device?.productId ?? "?"})`);
    this.name = "RecoveryDeviceBusy";
    this.busy = true;
  }
}

// `state.abort` only means "the operator stopped an active run"; a standalone
// recovery grant or find (no run in progress) must not be blocked by a stale
// flag left over from a previous stopped run.
function isStopped() {
  return state.running && state.abort;
}

// Every wait owns a generation. A generation is invalidated by a stop, a
// timeout, the end of the run, or a newer wait replacing this one, so a poll or
// chooser that resolves late can never bind a session to a superseded run.
function nextRecoveryEpoch() {
  state.recoveryEpoch += 1;
  return state.recoveryEpoch;
}

function isEpochStale(epoch) {
  return epoch != null && epoch !== state.recoveryEpoch;
}

// A session the current generation still owns, matching the frozen serial,
// satisfies a claim without opening a second USB interface.
function acceptedRecoveryFor(expectedSerial) {
  return Boolean(state.adb && state.kaeruHeader && state.recoverySerial === expectedSerial
    && !isEpochStale(state.recoveryAcceptedEpoch));
}

/**
 * Drops the bound recovery session and invalidates every in-flight wait/grant.
 * Used on stop, timeout, run-end and after a recovery reboot, where the previous
 * session has already been disconnected by the reboot.
 */
export function invalidateRecovery({ close = true } = {}) {
  const session = state.recoverySession;
  nextRecoveryEpoch();
  state.recoverySession = null;
  state.recoveryAcceptedEpoch = 0;
  state.adb = null;
  state.recoverySerial = null;
  state.kaeruHeader = null;
  if (close && session) closeRecoverySession(session).catch(() => { /* the reboot already disconnected it */ });
  return session;
}

function isChooserCancel(error) {
  const name = String(error?.name ?? "");
  const message = String(error?.message ?? error ?? "");
  return name === "NotFoundError" || /no device selected|cancelled|canceled|user (denied|aborted)/i.test(message);
}

async function closeRecoverySession(session) {
  if (!session) return;
  try {
    await (session.client?.close?.() ?? session.close?.());
  } catch { /* disconnect during a USB mode change */ }
}

function recoverySleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted || isStopped()) { reject(new RecoveryStopped()); return; }
    let done = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      if (recoveryWake === wake) recoveryWake = null;
    };
    const finish = (settle, value) => {
      if (done) return;
      done = true;
      cleanup();
      settle(value);
    };
    const onAbort = () => finish(reject, new RecoveryStopped());
    const wake = () => finish(resolve);
    timer = setTimeout(() => finish(resolve), Math.max(0, ms));
    signal?.addEventListener?.("abort", onAbort);
    recoveryWake = wake;
  });
}

function wakeRecoveryWaiter() {
  if (recoveryWake) { const wake = recoveryWake; wake(); }
}

/**
 * Rejects as soon as `signal` aborts, without cancelling the underlying work.
 *
 * F7: when the deadline fires, this rejects the wait but the in-flight
 * `claimRecoveryDevice` keeps running — it holds its `recoveryClaims` entry and
 * the open interface until its own ADB deadlines expire. An immediately
 * following "Continue from TWRP" wait therefore skips that device as
 * `RecoveryDeviceBusy` for a few seconds. That is correct and self-healing: the
 * claim's `finally` releases both. Do NOT "fix" it by removing that `finally`.
 */
function abortable(promise, signal) {
  if (signal?.aborted) return Promise.reject(new RecoveryStopped());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new RecoveryStopped());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

/** Stop button entry point: cancel any in-flight wait promptly. */
export function requestStop() {
  state.abort = true;
  nextRecoveryEpoch(); // every generation captured before the stop is now stale
  try { state.recoveryAbort?.abort(); } catch { /* already aborted */ }
  wakeRecoveryWaiter();
}

// The wait UI carries a visible countdown, because a human (Chrome's chooser)
// is inside this deadline. `state.recoveryDeadline` is the absolute time the
// wait expires; null when not waiting.
function enterRecoveryWaitingUI(deadline = null) {
  state.recoveryWaiting = true;
  state.recoveryDeadline = deadline;
  // A new wait must re-earn its prompt: a grant probe from an earlier wait must
  // not silently suppress a click this run genuinely needs.
  state.recoveryAlreadyGranted = false;
  state.recoveryChooserWide = false;
  if (dom.buttons.grantRecovery) dom.buttons.grantRecovery.textContent = "Allow USB access to TWRP…";
  if (dom.recoveryWait) {
    dom.recoveryWait.style.display = "";
    dom.recoveryWait.textContent =
      "Waiting for TWRP to appear. When it does, choose the new USB device named “Echo” in Chrome's prompt. "
      + "The install continues automatically once it is connected.";
  }
  renderRecoveryCallout();
  paintRecoveryCountdown(deadline);
  refreshControls();
  // A permission granted on an earlier run persists in Chrome, so before asking
  // for a click we look — silently, never opening a chooser — at the devices
  // this origin already holds. If ours is among them the background poller
  // binds it and the operator is never prompted at all.
  checkAlreadyGranted().catch(() => { /* the prompt stays available */ });
}

/**
 * True when this page already holds a permission for the selected device's
 * recovery identity. Read-only: getDevices never opens an interface, so this
 * cannot race the poller or the single-ownership rule.
 */
async function checkAlreadyGranted({ grantedDevices = grantedAdbDevices, serial = null } = {}) {
  const expected = String(serial ?? state.identity?.serialRaw ?? "").trim();
  if (!expected) return false;
  const devices = await grantedDevices();
  if (!Array.isArray(devices)) return false;
  const found = devices.some((device) => String(device?.serialNumber ?? "").trim() === expected
    || device?.vendorId === 0x18d1 && device?.productId === 0x4ee2);
  if (found) {
    state.recoveryAlreadyGranted = true;
    terminal.line("this page already holds USB access for your Echo; no permission click is needed");
  }
  return found;
}

/**
 * The large operator prompt, shown in the active step card as well as the bar.
 * The countdown lives in this node too, so the number the operator reads is the
 * number the page is enforcing.
 */
function renderRecoveryCallout() {
  const node = document.getElementById("callout-connect-device");
  if (!node) return;
  if (!state.recoveryWaiting) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.hidden = false;
  node.innerHTML = "";
  const title = document.createElement("strong");
  title.textContent = "Your Echo needs one click from you";
  const body = document.createElement("span");
  const countdown = document.createElement("span");
  countdown.id = "recovery-callout-countdown";
  body.textContent = " Press the button below, then choose the USB device named “Echo” in Chrome’s list. "
    + "It can take about 15 seconds to appear while your Echo restarts, and the list updates by itself. "
    + "The install then continues automatically.";
  node.append(title, body);
  const tail = document.createElement("div");
  tail.id = "recovery-callout-tail";
  tail.className = "fine-print";
  node.appendChild(tail);
  paintCalloutCountdown();
}

/** Repaints the countdown in the callout only; the prompt text is not rewritten. */
function paintCalloutCountdown() {
  const tail = document.getElementById("recovery-callout-tail");
  if (!tail || !state.recoveryWaiting) return;
  tail.textContent = state.recoveryDeadline == null
    ? "Waiting. This page keeps looking until you stop it."
    : `${formatCountdown(state.recoveryDeadline - Date.now())} left before this page gives up. You can keep waiting and press the button again.`;
}

/** Repaints the visible countdown. The surrounding prompt text is not rewritten. */
function paintRecoveryCountdown(deadline) {
  if (deadline == null) {
    if (dom.recoveryCountdown) dom.recoveryCountdown.textContent = "";
    return;
  }
  if (dom.recoveryCountdown) dom.recoveryCountdown.textContent = `${formatCountdown(deadline - Date.now())} left`;
  paintCalloutCountdown();
}

function leaveRecoveryWaitingUI() {
  state.recoveryWaiting = false;
  state.recoveryDeadline = null;
  if (dom.buttons.grantRecovery) dom.buttons.grantRecovery.textContent = "Allow USB access to TWRP";
  if (dom.recoveryWait) { dom.recoveryWait.style.display = "none"; dom.recoveryWait.textContent = ""; }
  if (dom.recoveryCountdown) dom.recoveryCountdown.textContent = "";
  renderRecoveryCallout();
}

/**
 * Runs `body` as the page's single owner of one recovery USB device.
 *
 * Ownership is taken BEFORE the mutex, because serialising behind it is not
 * enough: a queued open still *starts* against the same physical interface, and
 * two USBDevice opens interleave two CNXN handshakes on one cable. The registry
 * entry is released in a finally on every path — success, refusal, timeout or
 * transport error — so a contender skips rather than waits, and the next attempt
 * starts from a clean registry.
 */
async function withExclusiveRecoveryClaim(device, { epoch = null, stale = null, body } = {}) {
  const key = claimKey(device);
  // Refuse before any await: a queued open is exactly the interleaved-CNXN race.
  if (isRecoveryDeviceBusy(device)) throw new RecoveryDeviceBusy(device);
  recoveryClaims.set(key, { epoch: epoch ?? state.recoveryEpoch, at: Date.now() });
  try {
    return await recoveryLock.run(async () => {
      if (stale?.()) throw new RecoveryStopped();
      return await body();
    });
  } finally {
    recoveryClaims.delete(key);
  }
}

/**
 * Opens one candidate device, validates it as the selected TWRP device (serial,
 * board, Kaeru) and only then binds it to the run. The frozen identity and the
 * caller's generation/abort token are re-checked inside the lock and again after
 * every awaited validation, so a stop, a newer wait or a late result is disposed
 * rather than bound, and an already-accepted session is reused instead of
 * opening a second interface.
 *
 * Ownership is exclusive per USB device and is taken BEFORE the mutex, so a
 * poller and a grant click on the same physical device never both start an open.
 * The registry entry is released in a finally on every path — success, refusal,
 * timeout or transport error — and the session itself is always closed before the
 * claim is dropped, so the next attempt opens a clean interface.
 */
async function claimRecoveryDevice(device, { expectedSerial, expectedBoard, identity = null,
  epoch = null, open = openAdb, openSession = null, signal = null } = {}) {
  const stale = () => signal?.aborted || isStopped() || isEpochStale(epoch)
    || (identity != null && state.identity !== identity);
  return withExclusiveRecoveryClaim(device, { epoch, stale, body: async () => {
    if (!expectedBoard) {
      throw new StageError("recovery", "the selected device has no declared board; refusing an unqualified recovery session");
    }
    // A session already accepted for this generation satisfies the claim without
    // opening a second interface for the same device.
    if (acceptedRecoveryFor(expectedSerial)) return state.recoverySession ?? { client: state.adb };
    const session = openSession
      ? await openSession()
      : await open({ device, onLog: (line) => terminal.line(line) });
    if (!session) throw new StageError("recovery", "the browser returned no recovery device");
    if (stale()) { await closeRecoverySession(session); throw new RecoveryStopped(); }
    try {
      const validated = await validateRecoverySession({ client: session.client, expectedSerial, expectedBoard, terminal });
      // Re-check after the awaited validation: a stop or a newer generation must
      // never bind a session that arrived late.
      if (stale()) throw new RecoveryStopped();
      state.adb = session.client;
      state.recoverySession = session;
      state.recoveryAcceptedEpoch = epoch ?? state.recoveryEpoch;
      state.kaeruHeader = validated.header;
      state.recoverySerial = expectedSerial;
      refreshControls();
      session.validated = validated;
      return session;
    } catch (error) {
      // Release the interface before the claim is dropped, so the next poll or
      // grant gets a clean retry rather than inheriting a half-open transport.
      await closeRecoverySession(session);
      throw error;
    }
  } });
}

/**
 * "Start from recovery": the only entry for a page that was reloaded (or opened
 * for the first time) while the Echo is already unlocked and sitting in TWRP.
 *
 * Everything else on this page derives from a fastboot `getvar` identity, so a
 * fresh page had no way to continue: awaitRecovery/grantRecovery refuse without
 * one, and re-querying fastboot is impossible because the device is not in
 * fastboot. This reads the identity from the recovery environment itself and
 * builds the same shape `readFastbootIdentity` produces, so every downstream
 * gate is unchanged.
 *
 * It never trusts the chooser. Chrome's list is scoped to the measured TWRP
 * VID:PID and nothing else — there is no serial to narrow it with yet — so the
 * serial, board, TWRP version and Kaeru expdb header are ALL read back from the
 * device and every one of them must qualify before any state is bound. A device
 * that fails any of them is closed, and nothing is remembered: the next attempt
 * starts clean.
 */
export async function startFromRecovery({ request = null, open = openAdb } = {}) {
  if (state.running || state.fetchingBundle) {
    throw new StageError("recovery", "starting from recovery is only available while no install is running");
  }
  if (state.identity) {
    throw new StageError("recovery", "a device is already identified; query the device in fastboot instead of replacing that identity");
  }
  // Claimed before requestDevice: it must stay the first device action for the
  // button's user activation, and no chooser may open while a fastboot query or
  // an ADB poll already has this one USB interface.
  const releaseOperation = beginDeviceOperation("entry");
  if (!releaseOperation) return null;
  try {
    return await runRecoveryEntry({ request, open });
  } finally {
    releaseOperation();
  }
}

/** The body of `startFromRecovery`, with the page-wide USB slot already claimed. */
async function runRecoveryEntry({ request, open }) {
  if (state.recoveryGrantInFlight) {
    terminal.warn("a browser USB permission chooser is already open; finish that one first");
    return null;
  }
  state.recoveryGrantInFlight = true;
  // requestDevice must be the FIRST device action so the button's user
  // activation is still valid: no await precedes it.
  const choose = request ?? ((options) => requestRecoveryDevice(options));
  let device;
  try {
    device = await choose({ serial: null });
  } catch (error) {
    if (isChooserCancel(error)) {
      terminal.warn("no USB device was chosen; your Echo is unchanged");
      refreshControls();
      return null;
    }
    throw new StageError("recovery", `the browser device chooser failed: ${error.message}`);
  }
  // This entry owns a fresh generation: any older in-flight wait or grant is now
  // stale, so a late result can never bind over this session.
  const epoch = nextRecoveryEpoch();
  let session;
  try {
    session = await withExclusiveRecoveryClaim(device, {
      epoch,
      stale: () => isStopped() || isEpochStale(epoch),
      body: async () => {
        const opened = await open({ device, onLog: (line) => terminal.line(line) });
        if (!opened) throw new StageError("recovery", "the browser returned no recovery device");
        try {
          const probe = await probeRecoveryEntry({ client: opened.client, terminal });
          if (isStopped() || isEpochStale(epoch)) throw new RecoveryStopped();
          const journal = readResumeJournal().journal;
          if (journal && (await sha256Bytes(new TextEncoder().encode(probe.serial)) !== journal.serialSha256
            || probe.profile.board !== journal.board)) {
            throw new StageError("recovery", "this is a different Echo from the saved install; reconnect the original Echo");
          }
          if (isStopped() || isEpochStale(epoch)) throw new RecoveryStopped();
          // The same five fields claimRecoveryDevice binds, so every later gate
          // (acceptedRecoveryFor, the Kaeru before/after comparison, runInstall's
          // resumedRecovery short-circuit) treats this exactly like a polled
          // recovery session.
          state.adb = opened.client;
          state.recoverySession = opened;
          state.recoveryAcceptedEpoch = epoch;
          state.kaeruHeader = probe.header;
          state.recoverySerial = probe.serial;
          state.identity = recoveryEntryIdentity(probe);
          opened.validated = probe;
          return opened;
        } catch (error) {
          // Never leave a half-verified interface open, and never leave a partial
          // identity behind: a refusal must be exactly as clean as before the click.
          await closeRecoverySession(opened);
          state.identity = null;
          throw error;
        }
      },
    });
  } catch (error) {
    if (error instanceof RecoveryDeviceBusy) {
      reportUsbBusyOnce(device, "identifying your Echo from recovery");
      refreshControls();
      return null;
    }
    throw error;
  } finally {
    state.recoveryGrantInFlight = false;
  }
  // The contention is over, so the next refusal is allowed to explain itself.
  clearUsbBusyEpisode(device);
  const identity = state.identity;
  renderDevicePanel(identity, assessIdentity(identity, undefined,
    { selectedBoard: state.target?.board ?? state.bundleBoard ?? null }));
  setStatus(dom.statusDevice, `${identity.product} · unlocked · found in recovery · ${identity.serialMasked}`, "ok");
  setStatus(dom.statusPayload, "not needed — unlock skipped (device was already unlocked)", "ok");
  terminal.ok(`${identity.profile.marketing} found in recovery (TWRP ${session.validated.twrpVersion}) with an intact Kaeru expdb header`);
  terminal.line(`recovery entry identity: board=${identity.profile.board} serial=${identity.serialMasked} (masked); no fastboot identity was available on this page`);
  if (state.downloadedBundle && !state.fetchingBundle) await fetchBundleAutomatically({ reuse: true });
  refreshControls();
  return identity;
}

/**
 * The recovery-side equivalent of `readFastbootIdentity`: reads the properties a
 * TWRP environment can answer, and refuses unless every one of them qualifies.
 *
 * The bar is deliberately high. A serial alone does not identify a device, a
 * recognised board alone does not prove this is the board the operator chose, and
 * an intact Kaeru expdb header is the one thing that proves the LK unlock this
 * page would otherwise have performed has already happened. All four must hold,
 * plus a running TWRP, before any identity exists.
 */
export async function probeRecoveryEntry({ client, terminal } = {}) {
  const probe = await client.shell("getprop ro.twrp.version; getprop ro.product.device; getprop ro.serialno");
  const [twrpVersion = "", device = "", serial = ""] = String(probe?.stdout ?? "")
    .split(/\r?\n/).map((line) => line.trim());
  terminal?.line(`recovery probe: twrp=${twrpVersion || "(none)"} device=${device || "(none)"} serial=${maskSerial(serial)}`);
  if (!/^\d/.test(twrpVersion)) {
    throw new StageError("recovery", "ADB answered but TWRP is not running on the device you chose");
  }
  if (!serial) {
    throw new StageError("recovery", "the chosen device reports no serial; refusing to identify it from recovery alone");
  }
  const profile = recoveryProfileForBoard(device);
  if (!profile) {
    throw new StageError("recovery",
      `recovery board ${device || "(empty)"} is not a LibreEcho target (only RADAR and BISCUIT are); refusing to continue`);
  }
  const header = await readKaeruHeader(client);
  return { twrpVersion, device, serial, profile, header };
}

/**
 * The profile a recovery environment's `ro.product.device` names. Biscuit's
 * kernel answers with the platform codename (`omni_biscuit`) as well as with the
 * board name, so a codename match is required there; every other board is only
 * accepted through the declared `boardMatches` alias set, never a substring.
 */
function recoveryProfileForBoard(observed) {
  const name = String(observed ?? "").trim().toLowerCase();
  if (!name) return null;
  if (name.includes("biscuit")) return profileForBoard("biscuit");
  return PROFILES.find((profile) => boardMatches(name, profile.board)) ?? null;
}

/**
 * The identity a recovery entry earns, in the shape every existing gate reads.
 *
 * `unlockStatus: "true"` is a conclusion, not a guess: an intact Kaeru LK header
 * in expdb is written by the unlock this page would otherwise submit, so reaching
 * TWRP with it intact means the unlock is already applied. It is also the reason
 * the unlock is never offered from here — `amonetRequirement` returns skip for
 * `source: "recovery"`, so flash:brick has no path to a device that entered
 * through this button.
 */
function recoveryEntryIdentity(probe) {
  return {
    product: probe.profile.product,
    unlockStatus: "true",
    lkBuild: "",
    plBuild: "",
    maxDownload: "",
    serialRaw: probe.serial,
    serialMasked: maskSerial(probe.serial),
    profile: probe.profile,
    twrpVersion: probe.twrpVersion,
    recoveryBoard: probe.device,
    source: "recovery",
  };
}

/**
 * What a granted USBDevice's USB descriptor serial says about it being the
 * selected device. The descriptor serial is a *narrowing hint*, never the
 * acceptance gate — `validateRecoverySession`'s ADB-reported serial check
 * (ro.serialno) stays authoritative, because the two values come from different
 * sources.
 *
 * On this hardware the exclusion IS trusted: the TWRP USB descriptor's iSerial
 * equals the fastboot `getvar serialno` value, both `G090L90964010665` for the
 * same physical Echo (USB timeline 18d1:4ee2 / G090L90964010665). So a granted
 * Radar on the same origin is skipped without ever being opened, which is what
 * keeps a second ADB open off an unrelated device during a Biscuit's wait — two
 * opens on one USB interface is exactly the interleaved-CNXN failure this filter
 * prevents. Matching is trimmed and case-insensitive because iSerial formatting
 * is not guaranteed to match fastboot's byte-for-byte.
 *
 * A blank or absent serialNumber cannot exclude anything, so it stays a
 * candidate and falls back to open-and-probe.
 */
function deviceSerialVerdict(device, expectedSerial) {
  const declared = String(device?.serialNumber ?? "").trim();
  if (declared === "") return "unknown";
  const expected = String(expectedSerial ?? "").trim();
  if (expected === "") return "unknown";
  return declared.toUpperCase() === expected.toUpperCase() ? "match" : "mismatch";
}

/**
 * Tries every already-granted device without ever opening a chooser.
 *
 * `mismatchProbe(device)` is the bounded escape hatch. Matching and blank-serial
 * candidates are always probed; a descriptor-serial mismatch is not, because on
 * this hardware the exclusion is sound (see deviceSerialVerdict). But if a whole
 * wait has reached half its deadline without a single matching/blank candidate
 * appearing, while a mismatching granted candidate exists, the descriptor serial
 * is no longer allowed to decide the outcome on its own: that candidate is probed
 * ONCE, with a masked warning, and the ADB-reported serial still decides whether
 * it is accepted. This turns "silently skip the right device for the full
 * countdown" into a bounded, logged probe.
 */
async function pollGrantedRecovery({ expectedSerial, expectedBoard, identity, epoch,
  grantedDevices, open, openSession, signal, mismatchProbe = null }) {
  // While the operator's permission chooser is open, the page owns the device
  // search. Polling in parallel is what produced two interleaved CNXN handshakes
  // on one interface; skip the whole round and let the grant resolve.
  if (state.recoveryGrantInFlight) {
    terminal.line("recovery poll paused while the USB permission chooser is open");
    return null;
  }
  let devices;
  try {
    devices = await grantedDevices();
  } catch (error) {
    terminal.line(`recovery poll unavailable: ${error.message}`);
    return null;
  }
  if (!Array.isArray(devices) || devices.length === 0) return null;
  for (const device of devices) {
    if (signal?.aborted || isStopped() || isEpochStale(epoch)) throw new RecoveryStopped();
    if (deviceSerialVerdict(device, expectedSerial) === "mismatch" && !mismatchProbe?.(device)) {
      // Descriptor-level mismatch: skip without opening, so an unrelated granted
      // device is never claimed and never disrupts the selected one's transport.
      terminal.line(`skipping a granted USB device that is not the selected serial (${device.vendorId}:${device.productId})`);
      continue;
    }
    try {
      return await claimRecoveryDevice(device, { expectedSerial, expectedBoard, identity, epoch, open, openSession, signal });
    } catch (error) {
      if (error instanceof RecoveryStopped) throw error;
      // Another owner has this device right now (a grant click, or a newer wait).
      // Skip it this round; the next poll retries cleanly once the owner is done.
      if (error instanceof RecoveryDeviceBusy) {
        terminal.line(`skipping a recovery candidate another owner is already opening (${device.vendorId}:${device.productId})`);
        continue;
      }
      terminal.line(`ignoring a granted recovery candidate: ${error.message}`);
    }
  }
  return null;
}

/**
 * Waits for the selected TWRP device. It polls already-granted devices in the
 * background (no prompt) and exposes a dedicated permission action while
 * waiting, so a first-time grant the operator makes by hand is accepted and the
 * run continues automatically. Cancellation is prompt even while a claim is
 * mid-open or mid-validation: the wait settles immediately and the in-flight
 * claim disposes its late session instead of binding it.
 */
export async function awaitRecovery({ timeoutMs = RECOVERY_TIMEOUT_MS, intervalMs = RECOVERY_POLL_INTERVAL_MS,
  grantedDevices = grantedAdbDevices, open = openAdb, openSession = null } = {}) {
  const identity = state.identity;
  if (!identity?.serialRaw) throw new StageError("recovery", "select and identify the fastboot device first");
  if (!identity.profile?.board) throw new StageError("recovery", "the selected device has no declared board; recovery cannot be verified");
  const expectedSerial = identity.serialRaw;
  const expectedBoard = identity.profile.board;
  const epoch = nextRecoveryEpoch(); // a new wait replaces and invalidates any older one
  const controller = new AbortController();
  state.recoveryAbort = controller;
  const deadline = Date.now() + timeoutMs;
  enterRecoveryWaitingUI(deadline);
  // Bound the whole wait, including an unresolved USB open or identity probe.
  // Checking the deadline only between polls leaves a hung probe unbounded.
  let timedOut = false;
  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(0, timeoutMs));
  // A one-second repaint keeps the visible countdown honest without coupling it
  // to the poll interval.
  const countdownTimer = setInterval(() => paintRecoveryCountdown(deadline), 1000);
  let accepted = false;
  // Bounded escape hatch for the descriptor-serial pre-filter. If the wait has
  // burned half its deadline and no matching/blank-serial candidate has ever
  // appeared, a mismatching granted candidate gets probed exactly once — per
  // wait — with a masked warning. The ADB-reported serial remains the acceptance
  // gate, so this can never accept a foreign device; it only stops a descriptor
  // mismatch from skipping the RIGHT device silently for the whole countdown.
  let sawProbeableCandidate = false;
  let mismatchProbed = false;
  const mismatchProbe = (device) => {
    if (mismatchProbed || sawProbeableCandidate) return false;
    if (Date.now() - (deadline - timeoutMs) < timeoutMs / 2) return false;
    mismatchProbed = true;
    terminal.warn(`the granted USB device ${device.vendorId}:${device.productId} reports serial ${maskSerial(device.serialNumber)}, `
      + `not ${maskSerial(expectedSerial)}; probing it once anyway because the USB descriptor serial may not match the fastboot serialno. `
      + `Only a matching ADB-reported serial is accepted.`);
    return true;
  };
  try {
    for (;;) {
      if (isStopped() || controller.signal.aborted || isEpochStale(epoch)) throw new RecoveryStopped();
      if (acceptedRecoveryFor(expectedSerial)) {
        terminal.ok("recovery session is ready on the selected serial");
        accepted = true;
        return { client: state.adb, header: state.kaeruHeader };
      }
      let claimed = null;
      try {
        // Listed once here so the escape hatch can see the whole candidate set
        // before the round decides what to open.
        const devices = await grantedDevices();
        if (Array.isArray(devices)) {
          sawProbeableCandidate = sawProbeableCandidate
            || devices.some((device) => deviceSerialVerdict(device, expectedSerial) !== "mismatch");
        }
        // One page-wide USB owner, per round. The claim is taken around the
        // open+validate only and released every round, and it may coexist with a
        // grant: the grant button is the operator's way INTO this wait, and the
        // per-device claim registry below already refuses a grant whose device the
        // poll is opening. Holding the slot for the whole countdown would make
        // the only recovery from a stuck poll unavailable. A round refuses
        // outright (no queue, no second open) when a fastboot query or a
        // recovery entry currently owns the device; the next round retries
        // cleanly once that owner is done.
        const releaseOperation = beginDeviceOperation("poll", { shareWith: ["grant"] });
        if (!releaseOperation) {
          await recoverySleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), controller.signal);
          continue;
        }
        try {
          claimed = await abortable(pollGrantedRecovery({ expectedSerial, expectedBoard, identity, epoch,
            grantedDevices: async () => devices, open, openSession, signal: controller.signal,
            mismatchProbe }), controller.signal);
        } finally {
          releaseOperation();
        }
      } catch (error) {
        if (error instanceof RecoveryStopped) throw error;
        terminal.line(`recovery poll failed: ${error.message}`);
      }
      if (claimed) { accepted = true; return { client: claimed.client, header: state.kaeruHeader }; }
      if (Date.now() >= deadline) throw new StageError("recovery", "timed out waiting for TWRP on the selected serial");
      await recoverySleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), controller.signal);
    }
  } catch (error) {
    if (timedOut) throw new StageError("recovery", "timed out waiting for TWRP on the selected serial");
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(countdownTimer);
    // Only the owner of the current generation may clear the shared wait state.
    if (state.recoveryAbort === controller) {
      state.recoveryAbort = null;
      leaveRecoveryWaitingUI();
      // A stop/timeout while still the owner invalidates every captured
      // generation; a superseded wait leaves the newer generation untouched.
      if (!accepted && state.recoveryEpoch === epoch) {
        if (state.recoveryAcceptedEpoch === epoch) invalidateRecovery({ close: true });
        else nextRecoveryEpoch();
      }
    }
    refreshControls();
  }
}

export async function grantRecovery(options = {}) {
  // Freeze the run identity, the generation and the abort token BEFORE any
  // await: the permission chooser must be the first device action so the click's
  // user activation stays valid, and a stop that lands while the chooser is open
  // must still invalidate its late result.
  const identity = state.identity;
  if (!identity?.serialRaw) throw new StageError("recovery", "select and identify the fastboot device first");
  if (!identity.profile?.board) throw new StageError("recovery", "the selected device has no declared board; recovery cannot be verified");
  if (state.running && !state.recoveryWaiting) {
    throw new StageError("recovery", "recovery permission can only be granted while the install is waiting for TWRP");
  }
  // The page-wide slot, so a grant click can never race a fastboot query, a
  // recovery entry or a second grant. Claimed after the gates above (which must
  // still throw their own StageErrors) and before the chooser is opened.
  // `shareWith: ["grant", "poll"]` — the grant button IS the operator's way into
  // a poll's wait, and the per-device claim registry refuses the actual open when
  // the poll already holds the device. Everything else refuses immediately.
  const releaseOperation = beginDeviceOperation("grant", { shareWith: ["grant", "poll"] });
  if (!releaseOperation) return null;
  try {
    return await runRecoveryGrant(options);
  } finally {
    releaseOperation();
  }
}

/** The body of `grantRecovery`, with the page-wide USB slot already claimed. */
async function runRecoveryGrant({ request = null, requestWide = null, open = openAdb,
  openSession = null, signal = null } = {}) {
  const identity = state.identity;
  const expectedSerial = identity.serialRaw;
  const expectedBoard = identity.profile.board;
  const epoch = state.recoveryEpoch;
  const capturedSignal = signal ?? state.recoveryAbort?.signal ?? null;
  if (state.recoveryGrantInFlight) {
    terminal.warn("a browser USB permission chooser is already open; finish that one first");
    return null;
  }
  state.recoveryGrantInFlight = true;
  // The narrow chooser names the exact device: VID:PID plus the serial this run
  // is about, so the operator's list cannot contain an unrelated granted device.
  // The wider VID:PID-only list is used ONLY after a narrow attempt was already
  // made and its device was not accepted — never automatically.
  // requestDevice must be the first device action, so the browser's user
  // activation from the button click is still valid: no await precedes it.
  const useWide = state.recoveryChooserWide;
  const narrow = request ?? ((options) => requestRecoveryDevice(options));
  const wide = requestWide ?? ((options) => requestRecoveryDevice({ ...options, wide: true }));
  const openChooser = useWide ? wide : narrow;
  let pending;
  try {
    pending = openChooser({ serial: expectedSerial });
  } catch (error) {
    state.recoveryGrantInFlight = false;
    throw new StageError("recovery", `could not open the browser device chooser: ${error.message}`);
  }
  let device;
  try {
    device = await pending;
  } catch (error) {
    if (isChooserCancel(error)) {
      state.recoveryGrantInFlight = false;
      terminal.warn("no USB device was chosen; still waiting for TWRP — you can try again");
      state.recoveryChooserWide = false;
      refreshControls();
      return null;
    }
    throw new StageError("recovery", `the browser device chooser failed: ${error.message}`);
  }
  // The narrow chooser can legitimately list nothing when the descriptor omits
  // serialNumber. Offer the VID:PID-only list as an explicit second choice — it
  // is never taken automatically, and the ADB-reported serial check below
  // remains the gate that decides which device is accepted.
  try {
    device = await claimRecoveryDevice(device, { expectedSerial, expectedBoard, identity, epoch,
      open, openSession, signal: capturedSignal });
    state.recoveryChooserWide = false;
    terminal.ok("USB access granted to the selected TWRP device; Kaeru header intact");
    return device;
  } catch (error) {
    if (error instanceof RecoveryStopped) { state.recoveryChooserWide = false; return null; }
    // A poll already owns this device: it will bind the same interface, so the
    // grant simply steps aside rather than opening a second one.
    if (error instanceof RecoveryDeviceBusy) {
      state.recoveryChooserWide = false;
      // The wait is not stuck and no second connection was opened, so say both
      // plainly: the operator's click did nothing harmful, the existing attempt
      // is still running, and a second click is the right recovery if the wait
      // times out — rather than leaving them believing an install is progressing
      // when the owning poll can still fail its own validation seconds later.
      terminal.warn("Your Echo is already being connected — wait a few seconds. If nothing happens before the countdown ends, press the button again.");
      refreshControls();
      return null;
    }
    if (!state.recoveryChooserWide) {
      // Offer the wider (still VID:PID-scoped) list once, and say plainly why.
      state.recoveryChooserWide = true;
      terminal.warn(`the chosen device was not accepted: ${error.message}. If Chrome's list showed a device with no serial number, press the button again to list every Echo in recovery.`);
      refreshControls();
      return null;
    }
    state.recoveryChooserWide = false;
    terminal.warn(`the chosen device was not accepted: ${error.message}`);
    refreshControls();
    return null;
  } finally {
    state.recoveryGrantInFlight = false;
    wakeRecoveryWaiter();
  }
}

async function findRecovery() {
  currentStage("recovery");
  const session = await awaitRecovery({ timeoutMs: 30000 });
  terminal.ok("the selected TWRP device has an intact Kaeru expdb header");
  const receipt = await session.client.shell("cat /cache/libreecho-install-receipt 2>/dev/null || true");
  if (String(receipt.stdout ?? "").trim()) {
    terminal.info("an existing install receipt is present on the device:");
    for (const line of String(receipt.stdout).trim().split(/\r?\n/)) terminal.line(line);
  }
  return session;
}

// --- unlock payload --------------------------------------------------------

// This decides only whether an UNLOCK payload is needed, not whether the
// recovery/boot chain is compatible. Unlocked fastboot still has to pass the
// same-serial, target and Kaeru recovery gates; it never earns install readiness.
function amonetRequirement() {
  const identity = state.identity;
  if (!identity) return { mode: "pending", message: "Query the device to determine whether an Amonet unlock ZIP is needed." };
  const assessment = assessIdentity(identity, { ok() {}, warn() {} },
    { selectedBoard: state.target?.board ?? state.bundleBoard ?? null });
  if (assessment.findings.length) return { mode: "blocked", message: `Install blocked: ${assessment.findings[0]}. No unlock archive can resolve this automatically.` };
  if (acceptedRecoveryFor(identity.serialRaw)) return { mode: "skip", message: "Same-device TWRP and Kaeru header verified — no Amonet unlock ZIP needed." };
  // A recovery-entered device is unlocked by construction: it was only accepted
  // because an intact Kaeru LK header is already in expdb. Offering an unlock ZIP
  // here would be the one path that could re-send flash:brick to a device this
  // page never put into recovery, so it is a hard skip, not a preference.
  if (identity.source === "recovery") return { mode: "skip", message: "Your Echo was found already in recovery, so it is already unlocked — no Amonet unlock ZIP is needed and none will be sent." };
  if (assessment.unlocked) return { mode: "skip", message: "Already unlocked — no Amonet unlock ZIP needed. Same-device TWRP and the Kaeru boot chain must still be verified before installation." };
  if (!payloadForProfile(identity.profile, identity.lkBuild)) return { mode: "blocked", message: "Install blocked: this locked LK build is not supported by a pinned unlock payload." };
  return { mode: "required", message: "Locked device — the matching pinned Amonet ZIP is required for the unlock phase." };
}

function refreshAmonetControls() {
  const requirement = amonetRequirement();
  const enabled = requirement.mode === "required" && !state.running;
  if (dom.amonetPanel) dom.amonetPanel.hidden = requirement.mode !== "required";
  if (dom.amonetRoute) dom.amonetRoute.textContent = requirement.message;
  dom.payloadInput.disabled = !enabled;
  dom.archiveInput.disabled = !enabled;
  dom.buttons.selectArchive.disabled = !enabled;
  dom.buttons.fetchArchive.disabled = !enabled || !config.amonetMirrorBase;
  if (requirement.mode !== "required") {
    setStatus(dom.statusPayload, requirement.mode === "skip" ? "not needed — unlock skipped"
      : requirement.mode === "blocked" ? "blocked — device identity unverified" : "query the device first",
    requirement.mode === "skip" ? "ok" : requirement.mode === "blocked" ? "bad" : "pending");
  }
}

function assertAmonetRequired() {
  const requirement = amonetRequirement();
  if (requirement.mode !== "required") throw new StageError("unlock", requirement.mode === "skip"
    ? "Amonet unlock payload not required: already unlocked or verified in recovery"
    : requirement.message);
}

/**
 * Every unmet prerequisite for the Install button, as plain bullets.
 *
 * The Install button used to sit at the bottom of the page and stay greyed out
 * with no explanation (issue 7), so the operator could not tell a missing
 * prerequisite from a broken page. This reuses the SAME fail-closed gates as
 * installReadinessReason — it never softens one, it only enumerates them, so
 * every item here is something the gate itself is actually enforcing.
 */
export function unmetPrerequisites() {
  const unmet = [];
  if (!state.board) unmet.push("Choose which device you are installing.");
  if (!state.release) unmet.push("Choose a published build for that device.");
  if (!state.identity) unmet.push("Query the device in fastboot (step 3) so its identity can be read from the device itself — or, if it is already in TWRP, use “My Echo is already in recovery” there.");
  else {
    const assessment = assessIdentity(state.identity, undefined,
      { selectedBoard: state.target?.board ?? state.bundleBoard ?? null });
    if (assessment.findings.length) {
      for (const finding of assessment.findings) unmet.push(`Device check: ${finding}`);
    }
  }
  if (!state.bundleReady) unmet.push("Download and verify the complete published build, including both checksum inventories.");
  const board = state.identity?.profile?.board ?? null;
  if (board && state.release && (state.target?.board ?? state.bundleBoard) !== board) {
    unmet.push(`Release board mismatch: the selected build is for ${state.target?.board ?? state.bundleBoard}, this device is ${board}.`);
  }
  if (state.bundleReady && !state.bundleHardwareAccepted) {
    unmet.push("This build is not marked hardware-accepted, so no device write is allowed.");
  }
  if (state.bundleReady && state.installProtocol !== DIRECT_PROTOCOL) {
    unmet.push("This release does not publish direct-userdata protocol v2 metadata, which the browser install requires.");
  }
  if (amonetRequirement().mode === "required" && !state.payloadBytes) {
    unmet.push("Select the pinned Amonet unlock ZIP for this device's LK build (step 4).");
  }
  if (state.running) unmet.push("Wait for the current run to finish.");
  if (state.fetchingBundle) unmet.push("Wait for the download to finish.");
  return unmet;
}

/** Paints the unmet-prerequisite bullet list next to the Install button. */
function renderPrerequisites() {
  if (!dom.prereqList || !dom.prereqWrap) return;
  const unmet = installReadinessReason() === null && !state.running && !state.fetchingBundle ? [] : unmetPrerequisites();
  dom.prereqList.innerHTML = "";
  for (const item of unmet) {
    const node = document.createElement("li");
    node.textContent = item;
    dom.prereqList.appendChild(node);
  }
  dom.prereqWrap.dataset.empty = unmet.length === 0 ? "true" : "false";
}

/**
 * The single primary action the operator may press right now, or null when the
 * next step is not a button. Priority order mirrors what actually blocks a
 * run: a waiting-for-the-human recovery grant outranks everything, then a
 * missing build, a missing download, an unqueried device, the unlock payload,
 * and finally the install itself.
 */
function primaryAction() {
  const after = postInstallAction();
  if (after) return after;
  // A journal naming an unfinished transaction outranks EVERYTHING below,
  // including "choose your device" and "download the build". After a reload the
  // page has neither a board nor a release selected — they were in memory — so
  // any check ordered before this one would send the operator back to step 1 for
  // a transaction that is already three phases into an install. Resume is the
  // answer to "where was I", and it reverifies the build and the device itself.
  if (!state.running && !state.identity && state.resumeBoard && state.resumeReleaseTag) {
    const action = connectAction();
    return { step: "connect-device", label: action.label, message: action.message,
      hint: action.hint, secondary: action.secondary, kind: "action", focus: true,
      run: action.run };
  }
  if (state.running) {
    if (state.recoveryWaiting) {
      const wide = state.recoveryChooserWide;
      if (state.recoveryAlreadyGranted) {
        // This origin already holds permission for the device and the poller is
        // binding it: no button at all, because there is nothing to press.
        return { step: "connect-device", label: "Connect to your Echo in recovery",
          message: "This page already has USB access to your Echo, so it is connecting now — there is nothing for you to press.",
          hint: "Still nothing after about 15 seconds? Press Stop, then press Connect to choose it in Chrome’s list.",
          secondary: "Recovery here is TWRP.", kind: "pending", suppressed: true };
      }
      return {
        step: "connect-device",
        label: wide ? "Connect to your Echo (showing all)" : "Connect to your Echo in recovery",
        message: wide
          ? "Press this, then choose your Echo from the list. Chrome shows every Echo in recovery on this machine."
          : state.recoveryRestartRequested
            ? "Your Echo is restarting. Press this once, then choose the USB device named “Echo” in Chrome’s list. The install continues by itself."
            : "Your Echo did not accept the restart request, so start TWRP on it yourself. Then press this once and choose the USB device named “Echo” in Chrome’s list. The install continues by itself.",
        hint: "It can take about 15 seconds to appear while it restarts — the list updates by itself, so wait if it is not there yet.",
        secondary: wide
          ? "Chrome asks for permission once per USB device. If this is not your Echo, press Stop."
          : "Chrome asks for permission once per USB device. Recovery here is TWRP.",
        kind: "action",
        focus: true,
        run: () => grantRecovery().catch((error) => terminal.error(`recovery USB permission failed: ${error.message}`)),
      };
    }
    return null;
  }
  if (continueFromTwrpAvailable()) {
    return {
      step: "install",
      label: "Continue from TWRP",
      message: "The unlock payload was already submitted in this page session, so it will not be sent again. Continue from the recovery step to finish the install.",
      hint: "Press this if your Echo is sitting in recovery and you closed nothing.",
      kind: "action",
      run: () => runInstall({ dryRun: false }),
    };
  }
  if (!state.board) {
    // No device chosen yet: the next thing is a choice, not a button. Offering
    // "Download and verify" here would be a lie — the download is per-device.
    return { step: "device-build", label: "Choose your device", message: stageMessage("device-build"),
      hint: "Pick the device in step 1; the builds made for it appear straight away.",
      kind: "action", run: () => dom.deviceSelect?.focus?.() };
  }
  if (!state.release) {
    return { step: "device-build", label: "Choose a build", message: stageMessage("device-build"),
      hint: "The newest stable build for this device is selected by default.",
      kind: "action", run: () => dom.releaseSelect?.focus?.() };
  }
  if (!state.bundleReady && !state.fetchingBundle) {
    return { step: "download-verify", label: "Download and verify", message: stageMessage("download-verify"),
      hint: "Checks every file against the published checksums before anything is written.",
      kind: "action", run: () => fetchBundleAutomatically().catch((error) => terminal.error(error.message)) };
  }
  if (!state.identity) {
    // With no fastboot identity there is only one button that can possibly work:
    // a device sitting in TWRP cannot answer "Query device", which is exactly
    // the dead end a reloaded page hits. The recovery entry becomes the primary
    // action here; step 3 keeps the read-only fastboot query beside it, so the
    // normal path is still one click away.
    return { step: "connect-device", label: "My Echo is already in recovery",
      message: "Your Echo is already in recovery, so it cannot answer a fastboot query. Press this to read its identity from recovery itself.",
      hint: "Press this once, then choose the USB device named “Echo” in Chrome’s list. Nothing is unlocked again.",
      secondary: "TWRP and the Kaeru header are checked before anything is written.",
      kind: "action", focus: true,
      run: () => startFromRecovery().catch((error) => terminal.error(`starting from recovery failed: ${error.message}`)) };
  }
  if (installReadinessReason() === null) {
    return { step: "install", label: "Install", message: stageMessage("install"), kind: "action",
      run: () => runInstall({ dryRun: false }) };
  }
  return null;
}

/**
 * Republishes the sticky bar from whatever the current primary action is.
 */
function refreshStatusBar() {
  const action = primaryAction();
  if (!action) {
    const step = state.recoveryWaiting ? "connect-device"
      : state.running ? "install"
        : state.identity ? "install" : state.bundleReady ? "connect-device"
          : state.release ? "download-verify" : "device-build";
    setStatusBar({ step, message: stageMessage(step), kind: state.running ? "pending" : "pending" });
    return;
  }
  setStatusBar({ step: action.step, message: action.message, kind: action.kind ?? "pending",
    action: action.suppressed ? null : { label: action.label, disabled: action.disabled === true },
    hint: action.hint ?? "", secondary: action.secondary ?? "",
    // The recovery gesture needs a focused button: requestDevice requires a
    // fresh user activation, so the Run click's activation is long expired by
    // the time the device is in recovery.
    focusAction: action.focus === true });
}

export async function loadAmonetArchive({ file = null, url = null, acquire = null } = {}) {
  if (state.running) throw new StageError("unlock", "cannot change the Amonet archive during an active run");
  assertAmonetRequired();
  const identity = state.identity;
  const profile = identity?.profile;
  const archive = profile?.archive;
  const selection = payloadForProfile(profile, identity?.lkBuild);
  if (!archive || !selection?.sha256 || !Number.isSafeInteger(selection.size)) {
    throw new StageError("unlock", "query a supported device and exact LK build before selecting Amonet");
  }
  if ((file && url) || (!file && !url)) throw new StageError("unlock", "select one pinned ZIP or one configured mirror URL");
  if (file && (file.name !== archive.name || file.size !== archive.size)) {
    throw new StageError("unlock", `wrong Amonet archive: expected ${archive.name} (${archive.size} bytes)`);
  }
  state.payloadBytes = null;
  state.payloadName = "";
  setStatus(dom.statusPayload, "verifying Amonet ZIP", "pending");
  const verify = acquire ?? (await import("./amonet.js")).acquireAmonetPayload;
  const result = await verify({ archiveBlob: file, url, archiveSha256: archive.sha256,
    archiveSize: archive.size, memberPath: `amonet/bin/${selection.payload}`, payloadSha256: selection.sha256,
    payloadSize: selection.size });
  if (state.identity !== identity || !(result.bytes instanceof Uint8Array) || result.bytes.length !== selection.size) {
    throw new StageError("unlock", "Amonet payload size or device identity changed during verification");
  }
  assertAmonetRequired();
  state.payloadBytes = result.bytes;
  state.payloadName = selection.payload;
  terminal.ok(`verified ${archive.name} and extracted pinned ${selection.payload} (${selection.size} bytes)`);
  setStatus(dom.statusPayload, `${selection.payload} — verified from pinned ZIP`, "ok");
  return result;
}

export async function fetchPinnedAmonetArchive() {
  assertAmonetRequired();
  const archive = state.identity?.profile?.archive;
  if (!archive) throw new StageError("unlock", "query the device before fetching its Amonet archive");
  if (!config.amonetMirrorBase) throw new StageError("unlock", "no approved CORS Amonet mirror is configured; select the pinned ZIP instead");
  return loadAmonetArchive({ url: amonetArchiveUrl(config.amonetMirrorBase, archive.name) });
}

export async function loadPayload(file) {
  if (state.running) throw new StageError("unlock", "cannot change the unlock payload during an active run");
  if (file) assertAmonetRequired();
  const identity = state.identity;
  state.payloadBytes = null;
  state.payloadName = "";
  if (!file) return;
  const selection = payloadForProfile(identity?.profile, identity?.lkBuild);
  if (!selection || file.name !== selection.payload || file.size !== selection.size) {
    setStatus(dom.statusPayload, "raw payload not pinned for this device", "bad");
    throw new StageError("unlock", "raw payload name or size does not match the pinned LK build");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { sha256Bytes } = await import("./sha256.js");
  const digest = await sha256Bytes(bytes);
  if (digest !== selection.sha256) {
    setStatus(dom.statusPayload, "raw payload digest mismatch", "bad");
    throw new StageError("unlock", "raw payload digest mismatch against pinned image");
  }
  if (state.identity !== identity) throw new StageError("unlock", "device identity changed during payload verification");
  assertAmonetRequired();
  state.payloadBytes = bytes;
  state.payloadName = file.name;
  terminal.ok(`verified pinned raw fastbrick image ${file.name} (${bytes.length} bytes)`);
  setStatus(dom.statusPayload, `${file.name} — verified sha256 ${digest.slice(0, 12)}…`, "ok");
}

// --- run -------------------------------------------------------------------

// Image-safety policy belongs to the publisher. The browser verifies the exact
// published bytes and target rather than requiring a second, unset safety flag.
// Protocol, hardware-acceptance and same-device recovery checks remain separate.
function installReadinessReason() {
  if (!state.identity) return "query the device in fastboot first";
  const assessment = assessIdentity(state.identity, undefined,
    { selectedBoard: state.target?.board ?? state.bundleBoard ?? null });
  if (assessment.findings.length) return assessment.findings[0];
  if (!state.release || !state.bundleReady) return "download and verify the complete published build first";
  const board = state.identity.profile.board;
  if ((state.target?.board ?? state.bundleBoard) !== board || state.bundleBoard !== board) {
    return "release board mismatch: choose the published build for this device";
  }
  if (!state.bundleHardwareAccepted) return "this build is not marked hardware-accepted";
  if (state.installProtocol !== DIRECT_PROTOCOL) return "this release does not publish direct-userdata protocol v2 metadata";
  return null;
}

/**
 * Re-evaluates every control's enabled/hidden state from `state`.
 *
 * Exported because the availability of "Continue from TWRP" is a function of
 * page state that changes outside any click handler — most importantly after a
 * run's `finally` invalidates the recovery session, which is precisely when the
 * operator needs to be offered the resume. Keeping this callable lets that
 * transition be observed rather than assumed.
 */
export function refreshControls() {
  const running = state.running;
  const busy = running || state.fetchingBundle;
  const blocked = installReadinessReason();
  dom.buttons.run.disabled = busy || blocked !== null;
  const readiness = document.getElementById("install-readiness");
  if (readiness) readiness.textContent = running ? "Install in progress." : state.fetchingBundle
    ? "Downloading and verifying the selected build." : blocked ? `Install blocked: ${blocked}.`
      : "Published build verified for this device. Recovery is checked before any install write.";
  renderPrerequisites();
  if (state.identity) renderDevicePanel(state.identity, assessIdentity(state.identity, undefined,
    { selectedBoard: state.target?.board ?? state.bundleBoard ?? null }));
  if (dom.buttons.download) dom.buttons.download.disabled = busy || !state.release || !state.board;
  dom.buttons.dryRun.disabled = running;
  dom.buttons.verifyBundle.disabled = running;
  dom.bundleInput.disabled = running;
  dom.bundleFolderInput.disabled = running;
  refreshAmonetControls();
  dom.releaseSelect.disabled = running;
  if (dom.deviceSelect) dom.deviceSelect.disabled = running;
  // The alternative device query stays closed during a run; the only recovery
  // action that opens is the dedicated permission grant, and only while the run
  // is actually waiting for TWRP.
  // While any device operation is in flight, every control that would open a USB
  // connection is disabled: the page owns one interface at a time, and a live
  // button here is the affordance that produced the interleaved-handshake failure.
  const operationBusy = deviceOperationBusy();
  // The one connect/resume control. It is disabled by exactly the same rule as
  // every other USB-opening control — one interface at a time — and its label is
  // republished from connectAction() so it always says what pressing it will do.
  if (dom.connectResume) {
    const action = connectAction();
    dom.connectResume.textContent = action.label;
    dom.connectResume.disabled = busy || operationBusy;
    dom.connectResume.hidden = state.identity !== null && !state.resumeBoard;
  }
  if (dom.connectHint) dom.connectHint.textContent = connectAction().hint;
  dom.buttons.connect.disabled = running || operationBusy;
  dom.buttons.connectAny.disabled = running || operationBusy;
  dom.buttons.grantRecovery.disabled = (busy && !state.recoveryWaiting) || operationBusy;
  // The recovery entry is only ever the answer to "no fastboot identity exists".
  // Once a device is identified it must be closed, so this can never replace or
  // race a fastboot query or an in-progress run.
  dom.buttons.recoveryEntry.disabled = busy || state.identity !== null || operationBusy;
  if (dom.buttons.grantRecovery) dom.buttons.grantRecovery.hidden = !state.recoveryWaiting;
  dom.buttons.refresh.disabled = running;
  dom.buttons.abort.disabled = !running;
  // Step 5 is frozen during a run: the document is derived from these exact
  // values after finalize, so changing them mid-run would deliver something the
  // operator never saw validated.
  // After the install the form re-opens only when the running Echo needs setup
  // and this page holds a USB session to deliver it over.
  const provisionLocked = running
    || (state.stageProgress?.finalize === "done" && !state.postInstallSession);
  for (const name of provisionInputs) {
    if (dom.provision[name]) dom.provision[name].disabled = provisionLocked;
  }
  if (dom.provision.modeSkip) dom.provision.modeSkip.disabled = provisionLocked;
  if (dom.provision.modeFill) dom.provision.modeFill.disabled = provisionLocked;
  refreshContinueFromTwrp();
  refreshStatusBar();
}

/**
 * "Continue from TWRP" is offered only when this page session has already sent
 * flash:brick for the selected serial and no accepted recovery session survives.
 * That is exactly the state a recovery timeout leaves behind: the unlock outcome
 * is unknown, so the page must not invite a plain second Run (which looks like a
 * fresh install and could submit brick again) and must not force a reload, which
 * would discard every verified artifact. The button drives the same `runInstall`,
 * which now short-circuits the unlock stage.
 */
function continueFromTwrpAvailable() {
  return Boolean(state.identity?.serialRaw && !state.running && !state.fetchingBundle
    && state.unlockSubmitted === state.identity.serialRaw
    && !(state.adb && state.recoverySerial === state.identity.serialRaw && state.kaeruHeader)
    && installReadinessReason() === null);
}

function refreshContinueFromTwrp() {
  const node = dom.continueFromTwrp;
  if (!node) return;
  node.hidden = !continueFromTwrpAvailable();
  if (!node.hidden) {
    node.textContent = "Continue from TWRP — the unlock payload was already submitted and will not be sent again";
  }
}

function setRunning(running) {
  state.running = running;
  refreshControls();
}

function assertNotAborted(stage) {
  if (state.abort) throw new StageError(stage, "aborted by the operator");
}

/**
 * The protocol-2 phases, in the order a fresh run performs them.
 *
 * `resumeFrom` names the earliest phase that still has to run. Everything before
 * it is skipped — but ONLY after the release and the device have both reverified
 * (resumeInstall does that before calling here), and only for a real write run.
 * A rehearsal always walks the whole list, because it writes nothing.
 *
 * `resumeFrom` is the DEVICE's answer (`reconcileResume` → nextPhase), never the
 * browser journal's phase. The vocabulary is the module's `RESUME_NEXT_PHASES`,
 * which is deliberately NOT the same set as the helper's phase names: it adds
 * `payloads` (the browser's own push, which is a separate step from the helper's
 * `transfer`) and `verify-installed` (read-only, past finalize). Anything outside
 * the set restarts from the top rather than skipping, because skipping a phase
 * this list does not contain would be a guess.
 *
 * The six names are ORDERED, and the order is load-bearing:
 *
 *   prepare -> initialize -> transfer -> payloads -> finalize -> verify-installed
 *
 * `transfer` and `payloads` are adjacent but distinct on purpose. `transfer` means
 * "the helper must still create and gate the landing zone"; `payloads` means "it
 * already did, and only the browser's push is outstanding". Collapsing them into
 * one index would either re-run the helper phase over a device that already did
 * it, or skip the push entirely over a device that never received the image.
 */
const DIRECT_PHASES = ["prepare", "initialize", "transfer", "payloads", "finalize", "verify-installed"];

/**
 * Where a resume re-enters, as an index into DIRECT_PHASES.
 *
 * Anything unknown — `null`, `"fresh"`, or a browser journal's own phase
 * vocabulary — restarts from the top. Skipping a phase on the strength of a value
 * this list does not contain would be a guess, and a guess here can format
 * userdata.
 */
function resumePhaseIndex(phase) {
  const index = DIRECT_PHASES.indexOf(phase);
  return index < 0 ? 0 : index;
}

export async function runInstall({ dryRun = false, recovery = {}, resumeFrom = null } = {}) {
  if (state.running || state.fetchingBundle) return;
  state.abort = false;
  state.recoveryRestartRequested = true;
  state.stageProgress = {};
  state.receipts = [];
  // A fresh run must not inherit the previous run's delivery verdict. The
  // step-5 form is NOT cleared here: it is read after finalize, so wiping the
  // inputs at the start of the run would guarantee a NOT-delivered verdict for
  // a form the operator deliberately filled in. Secrets are dropped at every
  // other exit — Stop, page unload, and after delivery (clearProvisionSecrets
  // with keepSummary).
  state.provisionState = state.provisionMode === "skip" ? "skipped" : "idle";
  state.provisionDetail = "";
  state.postInstall = null;
  state.postInstallIp = null;
  state.runStage = null;
  state.runFraction = 0;
  let afterInstall = null;
  // Hold the browser's exclusive Web Lock across the entire run. It never
  // expires while this tab is alive. Resume passes ownership of its live grant
  // into this run rather than attempting a second, non-reentrant acquisition.
  let writer = state.writerLock;
  const adopt = writer?.ok === true && writer.held;
  if (!dryRun && !adopt) {
    writer = await acquireWriterLock();
    if (!writer.ok) {
      terminal.warn(`cannot start the install: ${writer.reason}`);
      terminal.info("nothing was written. Close the other tab, or wait for it to finish, then press the button again.");
      setStatusBar({ step: "install", kind: "bad", action: null,
        message: `Install not started: ${writer.reason}`,
        secondary: "Nothing was written. Only one tab of this page may install at a time." });
      refreshControls();
      return null;
    }
  }
  if (writer?.ok === true) state.writerLock = writer;
  const resumeAt = dryRun ? 0 : resumePhaseIndex(resumeFrom);
  if (!dryRun && resumeAt > 0) {
    terminal.info(`resuming at the ${DIRECT_PHASES[resumeAt]} phase; `
      + `the ${DIRECT_PHASES.slice(0, resumeAt).join(", ")} phase(s) already ran and are not repeated`);
  }
  setRunning(true);
  terminal.phase(1, STAGES.length, dryRun ? "rehearsal: no writes" : "browser one-shot install");
  terminal.info(`release ${state.release?.tag ?? "(none)"} · repository ${config.repository}`);
  if (config.mirrorBase) terminal.info(`asset mirror: ${config.mirrorBase}`);
  else terminal.info("bundle source: same-origin Pages release directory or loopback development helper; manual files remain available");

  try {
    const release = state.release;
    if (!release) throw new StageError("release", "no release selected");

    if (!state.sums) {
      if (dryRun) {
        terminal.warn("select and verify the local bundle, including both checksum files, before release compatibility can be assessed");
        terminal.ok("host-only rehearsal complete; zero USB write commands were sent");
        return;
      }
      throw new StageError("release", "select and verify the complete local bundle before unlock");
    }
    terminal.ok(`using the ${state.sums.size}-entry API-digest-anchored bundle inventory`);
    state.stageProgress.release = "done";
    assertNotAborted("release");
    if (dryRun && !state.identity) {
      terminal.info("no device is connected; identity and release compatibility cannot be checked in this rehearsal");
      terminal.ok("host-only rehearsal complete; zero USB write commands were sent");
      return;
    }

    if (!state.identity) {
      currentStage("device");
      await queryDevice();
    }
    state.stageProgress.device = "done";
    assertNotAborted("device");

    const assessment = assessIdentity(state.identity, terminal,
      { selectedBoard: state.target?.board ?? state.bundleBoard ?? null });
    state.stageProgress.identity = "done";
    const profile = state.identity.profile;
    // Name the transaction now that there is a device and a release to name it
    // with. Best-effort: a missing journal costs convenience on a later reload,
    // never the run.
    await recordResumeProgress({ phase: "fresh" }).catch(() => {});
    // The board comes from the resolved target (or the verified build metadata).
    // A legacy release without a targets.json descriptor is Radar-only.
    const knownBoard = state.target?.board ?? state.bundleBoard ?? null;
    const legacyRadarOnly = !state.targetsJson && !knownBoard;
    const boardMismatch = !profile
      || (knownBoard
        ? profile.board !== knownBoard
        : (legacyRadarOnly && release.tag.startsWith("radar-puffin-") && profile.board !== "radar_puffin"));
    const blockReason = boardMismatch
      ? `release board mismatch: ${release.tag} is not a qualified ${profile?.board ?? "unknown"} image`
      : profile.id === "biscuit" && knownBoard !== "biscuit"
        ? "release board mismatch: Biscuit requires a Biscuit-targeted published build"
        : assessment.findings[0] ?? null;
    if (dryRun) {
      if (blockReason) terminal.warn(blockReason);
      terminal.ok("host-only rehearsal complete; zero USB write commands were sent");
      return;
    }
    if (blockReason) throw new StageError("identity", blockReason);
    if (!state.bundleReady) throw new StageError("release", "the complete release bundle and recovery ZIP must be verified before unlock");
    if (state.bundleBoard !== profile.board) throw new StageError("release", "release board mismatch in verified build metadata");
    if (state.bundleHardwareAccepted !== true) throw new StageError("release", "build metadata has no hardware-accepted board; refusing device writes");
    // Refuse an old or protocol-less bundle BEFORE unlock or any device mutation.
    // There is deliberately no legacy /cache bulk-staging fallback.
    if (state.installProtocol !== DIRECT_PROTOCOL) {
      throw new StageError("release", "this release does not publish direct-userdata protocol v2 metadata; refusing the legacy /cache bulk-staging flow before unlock");
    }

    const resumedRecovery = state.adb && state.recoverySerial === state.identity.serialRaw && state.kaeruHeader;
    // A resume whose journal says the unlock already went out. The page-session
    // latch (`state.unlockSubmitted`) is exactly what a reload destroys, and the
    // durable `libreecho.unlock.sent.*` guard inside submitUnlockPayload is what
    // still holds — but relying on that alone would mean the run reached the
    // unlock branch at all, and re-reading a locked fastboot identity is not
    // evidence that brick was not already sent. So the journal's word is treated
    // as a hard skip: continue, never re-submit.
    const resumeUnlockSettled = Boolean(resumeFrom) && (state.resumeUnlockSubmitted
      || readResumeJournal().journal?.unlockState !== "none");
    // The unlock latch is per page session and keyed to the serial. Once flash:brick
    // has been sent the outcome is unknown (usually the device stops answering), so
    // the ONLY correct follow-up is the recovery wait — never a second submission.
    // This survives the `finally` below, unlike the bound ADB session, and it is what
    // makes "Continue from TWRP" safe after a recovery timeout.
    const unlockAlreadySent = state.unlockSubmitted === state.identity.serialRaw;
    if (resumedRecovery) {
      terminal.ok("continuing from verified recovery without re-submitting the unlock payload");
      state.stageProgress.unlock = "done";
    } else if (resumeUnlockSettled) {
      terminal.ok("an unlock payload was submitted before the page was reloaded, so it will NOT be sent again");
      state.stageProgress.unlock = "done";
    } else if (unlockAlreadySent) {
      terminal.ok("the unlock payload was already submitted in this page session; continuing from TWRP without re-submitting it");
      state.stageProgress.unlock = "unknown";
      currentStage("recovery");
      await awaitRecovery(recovery);
    } else {
      if (!assessment.unlocked) {
        currentStage("unlock");
        const outcome = await submitUnlockPayload({
          client: state.fastboot.client,
          profile: state.identity.profile,
          lkBuild: state.identity.lkBuild,
          payloadBytes: state.payloadBytes,
          payloadName: state.payloadName,
          serialRaw: state.identity.serialRaw,
          terminal,
          // Set the latch immediately before flash:brick leaves the host. It is
          // deliberately not cleared by this run's `finally` (invalidateRecovery
          // drops the bound ADB session, not this), which is what makes a second
          // Run click after a recovery timeout safe.
          onSubmit: (serial) => { state.unlockSubmitted = serial; },
        });
        state.stageProgress.unlock = "done";
        if (outcome.outcome === "unknown") {
          terminal.warn("unlock outcome unknown; checking only for same-serial TWRP, never re-submitting brick");
        }
      } else {
        terminal.ok("device is already unlocked; skipping the unlock stage");
        state.stageProgress.unlock = "skipped";
        // The unlock payload is what normally restarts the Echo. With no payload to
        // send, ask Kaeru for TWRP explicitly; otherwise nothing restarts it.
        currentStage("recovery");
        const restart = await requestRecoveryReboot({ client: state.fastboot?.client, terminal });
        state.recoveryRestartRequested = restart.requested;
        if (!restart.requested) {
          terminal.warn(`could not restart your Echo into TWRP from here (${restart.reason}); `
            + "start TWRP on the Echo yourself, then choose it in Chrome's list");
        }
      }
      assertNotAborted("unlock");
      currentStage("recovery");
      // Waits for TWRP, polling already-granted devices without a prompt and
      // keeping the dedicated permission action available while it waits.
      await awaitRecovery(recovery);
    }
    // From here on the unlock is settled one way or another, so the journal must
    // say so: after a reload this is what keeps flash:brick from being resent.
    await recordResumeProgress({ phase: "fresh", kaeruHeader: state.kaeruHeader }).catch(() => {});
    const kaeruBefore = await readKaeruHeader(state.adb);
    if (resumedRecovery && kaeruBefore !== state.kaeruHeader) {
      throw new StageError("recovery", "Kaeru header changed since recovery was verified; do not install");
    }
    state.kaeruHeader = kaeruBefore;
    state.stageProgress.recovery = "done";
    assertNotAborted("recovery");

    if (state.files.size === 0) {
      throw new StageError("stage", "no verified bundle files: select the release bundle before running");
    }
    if (!(state.directHelper instanceof Uint8Array) || !state.directManifestText || !Array.isArray(state.directRoles)) {
      throw new StageError("stage", "the verified protocol-2 plan is incomplete; re-verify the bundle before running");
    }
    const targetBoard = state.target?.board ?? state.bundleBoard;
    const phaseShared = {
      adb: state.adb,
      serialRaw: state.identity.serialRaw,
      tag: release.tag,
      bundleManifestSha256: state.directManifestSha,
      target: targetBoard,
      release: state.directRelease,
      terminal,
      isCancelled: () => state.abort,
    };

    currentStage("stage");
    // Only the bounded helper and the anchor manifest reach /cache: no payload is
    // ever staged there, and the legacy `/cache/libreecho-bundle` path is unused.
    await pushDirectControl({ adb: state.adb, helperBytes: state.directHelper, manifestText: state.directManifestText, terminal, isCancelled: () => state.abort });
    state.stageProgress.stage = "done";
    assertNotAborted("stage");

    currentStage("prepare");
    let prepared = null;
    // A resume past prepare must NOT re-run it: prepare is the phase that
    // reshapes userdata when the layout does not match, so re-entering it can
    // destroy work the previous run already did. It was skipped only because the
    // DEVICE's guard said so (see reconcileResume), and the device digest that
    // binds the rest of the run to this device comes from the same evidence.
    if (resumeAt > DIRECT_PHASES.indexOf("prepare")) {
      // The helper OVERWRITES the receipt on every invocation, so whatever is
      // there now describes the LAST thing that ran — a transfer, a finalize, or
      // a read-only rehearsal — and it is not prepare evidence at all.
      //
      // Skipping prepare needs NO receipt when the device's guard already says
      // the transaction got past it (`initialize`/`transfer`/`finalizing`/
      // `finalized` are only ever written after prepare completed). Judging the
      // latest receipt as prepare evidence would refuse every such continuation,
      // naming a perfectly good `result=installed` as a broken prepare.
      //
      // `guardPhase === 'prepare'` is the ONE case where the latest receipt IS
      // the prepare evidence, and it is exactly the case the reconciliation has
      // already verified as bound to this bundle on this device before handing
      // the run a resume point at all. So only there is its result judged, and a
      // non-prepare result there is still a refusal.
      const lastSeen = state.resumePrepareReceipt ?? await readInstallReceipt(state.adb);
      if (state.resumeGuardPhase === "prepare" && lastSeen?.result
        && !["prepare-ok", "prepare-noop"].includes(lastSeen.result)) {
        throw new StageError("prepare", `the device reports prepare result=${lastSeen.result}; classify it before continuing`);
      }
      prepared = { ...(lastSeen ?? {}), device_digest: state.resumeDeviceDigest ?? lastSeen?.device_digest ?? null };
      terminal.ok(`continuing after a prepare phase the device's record says completed `
        + `(the last invocation the device recorded was ${lastSeen?.result ?? "nothing readable"}); it is not re-run`);
      // The digest is the binding for every later phase. When the reconciliation
      // measured one, use it; never leave a later phase unbound.
      prepared = { ...(prepared ?? {}), device_digest: state.resumeDeviceDigest ?? prepared?.device_digest ?? null };
    } else {
      prepared = await runDirectPhase({ ...phaseShared, phase: "prepare" });
      state.receipts.push(prepared);
      if (!["prepare-ok", "prepare-noop"].includes(prepared.result)) {
        throw new StageError("prepare", `the prepare phase returned result=${prepared.result ?? "unknown"}`);
      }
      if (await readKaeruHeader(state.adb) !== kaeruBefore) {
        throw new StageError("install", "expdb Kaeru header changed during the prepare phase; do not reboot");
      }
      assertNotAborted("prepare");
    }
    phaseShared.deviceDigest = prepared?.device_digest ?? null;
    // The device digest is the receipt's own device binding: it is what lets a
    // resume prove it is talking to the same device the helper measured.
    //
    // The journal must name the LAST PHASE THE DEVICE COMPLETED, never the one
    // this run is entering. Writing `prepare` unconditionally here rewound the
    // record of a resume whose device had already reached `initialize`: the next
    // reload then read a journal claiming less progress than the device had
    // actually made, and the only thing that saved it was the device guard
    // catching the disagreement. A journal that lags is a hint that misleads.
    // `resumeGuardPhase` is the device's own answer and is only ever a phase the
    // helper had actually reached.
    const completedPhase = resumeAt > DIRECT_PHASES.indexOf("prepare")
      ? (state.resumeGuardPhase ?? "prepare")
      : "prepare";
    await recordResumeProgress({ phase: completedPhase, bundleManifestSha256: state.directManifestSha,
      deviceDigest: phaseShared.deviceDigest, kaeruHeader: state.kaeruHeader,
      target: targetBoard }).catch(() => {});
    if (resumeAt <= DIRECT_PHASES.indexOf("prepare") && prepared.reboot_required === "1") {
      terminal.info("userdata was reshaped; rebooting recovery before it can be initialized");
      await rebootAndWait({ adb: state.adb, target: "recovery", terminal });
      // The reboot disconnected the pre-reboot session: drop it so the next wait
      // opens a fresh serial-bound session instead of reusing the stale handle.
      invalidateRecovery({ close: false });
      const next = await awaitRecovery(recovery);
      state.adb = next.client;
      phaseShared.adb = state.adb;
      if (await readKaeruHeader(state.adb) !== kaeruBefore) {
        throw new StageError("install", "expdb Kaeru header changed after recovery reboot; do not install");
      }
    }
    state.stageProgress.prepare = "done";
    assertNotAborted("prepare");

    currentStage("initialize");
    // `initialize` is the one userdata-formatting phase, so it is never re-entered
    // because a journal said so. It is skipped only when the DEVICE's guard
    // recorded format_state=formatted, and the module verified the layout
    // fingerprint before returning that answer — so this branch reads the
    // evidence rather than assuming, and userdata is never reshaped a second time.
    if (resumeAt > DIRECT_PHASES.indexOf("initialize")) {
      const earlier = await readInstallReceipt(state.adb);
      terminal.ok(`the device's record says userdata is already formatted `
        + `(the device reports ${earlier?.result ?? "no stored receipt"}); userdata is not reshaped again`);
    } else {
      const initialized = await runDirectPhase({ ...phaseShared, phase: "initialize" });
      state.receipts.push(initialized);
      await recordResumeProgress({ phase: "initialize", bundleManifestSha256: state.directManifestSha,
        deviceDigest: phaseShared.deviceDigest, kaeruHeader: state.kaeruHeader,
        target: targetBoard }).catch(() => {});
      if (initialized.result !== "initialized") {
        throw new StageError("initialize", `the initialize phase returned result=${initialized.result ?? "unknown"}`);
      }
      if (await readKaeruHeader(state.adb) !== kaeruBefore) {
        throw new StageError("install", "expdb Kaeru header changed during initialize; do not install");
      }
      state.stageProgress.initialize = "done";
      assertNotAborted("initialize");
    }

    currentStage("transfer");
    // The helper's `transfer` phase creates the landing zone and gates free space.
    // It is distinct from the browser's own push (`payloads` below): a resume may
    // need neither, one, or both, and the device's guard decides which.
    if (resumeAt > DIRECT_PHASES.indexOf("transfer")) {
      terminal.ok("the device's record says the transfer phase already ran; it is not re-run");
    } else {
      const transferred = await runDirectPhase({ ...phaseShared, phase: "transfer" });
      state.receipts.push(transferred);
      await recordResumeProgress({ phase: "transfer", bundleManifestSha256: state.directManifestSha,
        deviceDigest: phaseShared.deviceDigest, kaeruHeader: state.kaeruHeader,
        target: targetBoard }).catch(() => {});
      if (transferred.result !== "transferred") {
        throw new StageError("transfer", `the transfer phase returned result=${transferred.result ?? "unknown"}`);
      }
      assertNotAborted("transfer");
      state.stageProgress.transfer = "done";
      assertNotAborted("transfer");
    }

    // `payloads` is not a STAGES id — the push is the second half of the same
    // "Transfer payloads to userdata" card, so it repaints that stage rather than
    // inventing a thirteenth one.
    currentStage("transfer");
    // A device whose guard says FINALIZED already consumed the payloads: the
    // helper hardlinked or moved them into the installed tree. Re-pushing the
    // whole image into /data there is a large mutation on a device that is
    // already installed, so it is never done. The read-only hash readback still
    // runs as evidence, and a file it cannot find is reported rather than
    // repaired — restoring it is a deliberate fresh install, not a resume.
    const verifyingFinalized = resumeAt > DIRECT_PHASES.indexOf("finalize");
    // Did the browser's push land? Never an assumption either way: skipping it
    // unconditionally wastes the whole image, and running it unconditionally
    // re-sends it over an install that may already be complete. The answer is a
    // read-only hash of the landing zone. The finalize phase re-hashes whatever is
    // actually there and refuses if it is incomplete, so a skipped push cannot
    // fake a complete install.
    const landed = await readLandedPayloads({
      adb: state.adb, roles: state.directRoles, terminal, isCancelled: () => state.abort,
    });
    assertNotAborted("transfer");
    const present = new Set(landed.checked.filter((entry) => entry.present).map((entry) => entry.name));
    const missing = landed.checked.filter((entry) => !entry.present);
    if (verifyingFinalized) {
      if (missing.length) {
        terminal.warn(`${missing.length} of ${landed.checked.length} landing-zone payload(s) are absent or do not match `
          + `(${missing.slice(0, 4).map((entry) => `${entry.name}: ${entry.reason}`).join(", ")}); `
          + "nothing is pushed over an already-installed device");
      }
      terminal.ok("this install is already finalized, so no payload is pushed again");
    } else if (missing.length === 0) {
      terminal.ok(`all ${landed.checked.length} verified payload(s) are already on the device and match; nothing is pushed again`);
    } else {
      terminal.info(`${missing.length} of ${landed.checked.length} payload(s) are missing or do not match `
        + `(${missing.slice(0, 4).map((entry) => `${entry.name}: ${entry.reason}`).join(", ")}); pushing only those`);
      const rolesToPush = state.directRoles.filter((role) => !present.has(role.name));
      const pushed = await pushDirectPayloads({
        adb: state.adb, roles: rolesToPush, files: state.files, sums: state.sums, terminal,
        isCancelled: () => state.abort,
        onProgress: (fraction) => setRunProgress("transfer", fraction),
      });
      terminal.ok(`pushed ${pushed.fileCount} verified payload(s) into ${DIRECT_INCOMING_DIR}`);
    }
    state.stageProgress.transfer = "done";
    assertNotAborted("transfer");

    currentStage("finalize");
    // Finalized guards require a FRESH observation of installed bytes. A stored
    // receipt is only historical evidence. The helper's finalized branch refuses
    // the write (rc=1, already-finalized) but attaches installed readback before
    // it ever touches the consumed landing zone. Normal dry-run success is NOT
    // proof of installed state and is refused by this dedicated parser mode.
    if (verifyingFinalized) {
      const bootPin = state.directRoles.find(role => role.role === "transfer:boot")?.sha256;
      if (!bootPin) throw new StageError("finalize", "verified boot pin is missing");
      const proof = await runDirectPhase({ ...phaseShared, phase: "finalize", dryRun: true,
        verifyInstalledBootSha256: bootPin });
      state.receipts.push(proof);
      terminal.ok("fresh installed-state readback matches this bundle; no boot image or payload was written again");
    } else {
      // The landed-completely gate: finalize --dry-run verifies every upload by
      // digest and writes nothing. Only then is the real finalize (no format) run.
      const rehearsal = await runDirectPhase({ ...phaseShared, phase: "finalize", dryRun: true });
      if (rehearsal.result !== "dry-run-ok") {
        throw new StageError("finalize", `the landed-completely check returned result=${rehearsal.result ?? "unknown"}`);
      }
      const finalized = await runDirectPhase({ ...phaseShared, phase: "finalize" });
      state.receipts.push(finalized);
      await recordResumeProgress({ phase: "finalize", bundleManifestSha256: state.directManifestSha,
        deviceDigest: phaseShared.deviceDigest, kaeruHeader: state.kaeruHeader,
        target: targetBoard }).catch(() => {});
      if (finalized.result !== "installed") {
        throw new StageError("finalize", `the finalize phase returned result=${finalized.result ?? "unknown"}`);
      }
      if (await readKaeruHeader(state.adb) !== kaeruBefore) {
        throw new StageError("install", "expdb Kaeru header changed during finalize; do not reboot");
      }
      // Outcome known: this transaction's "never repeat" guards are retired so
      // a later reinstall of the same release is possible.
      await retireDirectPhaseGuards({ serialRaw: phaseShared.serialRaw, tag: phaseShared.tag });
    }
    state.stageProgress.finalize = "done";

    // Step 5 delivery. Only here: after finalize returned result=installed, and
    // before the reboot. It writes ONE file and can never format or re-format
    // userdata, so a failure is reported without failing the install.
    if (state.provisionMode === "fill") {
      currentStage("configure");
      const provisionTarget = profileForBoard(targetBoard)?.slug ?? null;
      if (!provisionTarget) {
        state.provisionState = "failed";
        state.provisionDetail = `no provision target for board ${targetBoard}`;
        terminal.error(`configuration NOT delivered: ${state.provisionDetail}`);
      } else {
        await deliverProvisionStep({ adb: state.adb, release: state.directRelease, target: provisionTarget });
      }
      state.stageProgress.configure = state.provisionState === "delivered" ? "done" : "skipped";
      assertNotAborted("configure");
    } else {
      state.provisionState = "skipped";
      state.stageProgress.configure = "skipped";
      terminal.info("configuration skipped: the Echo will run its own setup page on first boot");
    }

    currentStage("verify");
    terminal.phase(STAGES.length, STAGES.length, "verify and reboot");
    assertNotAborted("verify");
    const installedSerial = state.identity?.serialRaw ?? state.recoverySerial ?? "";
    await rebootAndWait({ adb: state.adb, target: "", terminal });
    state.stageProgress.verify = "done";
    if (state.provisionMode === "skip") {
      terminal.info("once LibreEcho starts, this page offers the setup step here (the setup page on the device also works)");
    }
    // The install's writes are over. The wait for LibreEcho to start runs AFTER
    // this run has released its lock and recovery session (below the finally),
    // because it only reads from the running image.
    afterInstall = { serial: installedSerial, expectProvision: state.provisionState === "delivered" };
    // Every secret this page held is dropped the moment it is no longer needed:
    // the closing message keeps only the non-secret hostname/SSID.
    clearProvisionSecrets({ keepSummary: true });
    // The transaction is over, so the resume record goes. This removes exactly
    // one key — the journal's own — and never the durable libreecho.unlock.*,
    // libreecho.recovery.* or libreecho.direct.* attempt guards, which must keep
    // saying "already attempted" for as long as the browser holds them.
    clearResumeJournal();
    // Success is republished to the bar too; the run is over and nothing is
    // pending, so no primary action is offered. Issue 22 wanted an explicit
    // DONE state here rather than a silent, indistinguishable final screen.
    setStatusBar({ step: "install", kind: "pending", action: null,
      message: "Installed. Your Echo is restarting into LibreEcho — keep it plugged in while this page checks it started.",
      hint: "This usually takes one to two minutes.",
      secondary: "The full log is beside the steps; use Save log to keep it." });
  } catch (error) {
    const stage = error instanceof StageError ? error.stage : "unknown";
    terminal.error(`${stage} stage failed: ${error.message}`);
    if (error.detail) terminal.line(String(error.detail));
    terminal.info("nothing further was attempted. Preserve the current device state; do not re-run a submitted unlock or installer ZIP without classifying its result first.");
    // The failure must be visible without scrolling back to the log.
    const failedStep = stepCardForStage(stage) ?? "install";
    setStatusBar({ step: failedStep, message: `${stage} stage failed: ${error.message}`,
      kind: "bad", action: null,
      secondary: "Nothing further was attempted. Preserve the current device state.",
      hint: state.unlockSubmitted === state.identity?.serialRaw
        ? "The unlock payload was already submitted in this page session; it will not be sent again."
        : "" });
  } finally {
    // The durable writer lock is released on EVERY exit — success, refusal,
    // failure and Stop — so a failed run never leaves the operator locked out of
    // their own next attempt. `release()` only ever removes this tab's own lock.
    if (state.writerLock === writer && writer?.held) {
      writer.setPhase("done");
      await writer.release();
      state.writerLock = null;
    }
    setRunning(false);
    // The run owns no recovery session once it ends; drop the bound handle and
    // invalidate any grant whose chooser may still be open.
    invalidateRecovery({ close: true });
    renderStepList(null);
    // Repaint AFTER invalidate: setRunning(false) above repainted while the old
    // state.adb was still bound, so on the "recovery accepted, then the install
    // failed" path the "Continue from TWRP" control stayed hidden until some
    // unrelated later repaint. The resume affordance depends on the
    // post-invalidate state.
    refreshControls();
  }
  if (afterInstall && !dryRun) {
    if (postInstallHook) await postInstallHook(afterInstall);
    else await waitForLibreEcho(afterInstall);
  }
}

// --- after the install: did LibreEcho actually start? ----------------------
//
// The old page stopped at "reboot requested" and told the operator to go and
// find the setup page. The one-shot installer this replaces did better: it
// waited for the device's own ADB, then opened the setup page. This does the
// same from the browser, read-only: it re-attaches to the SAME Echo (serial
// checked) on LibreEcho's own adbd, waits for startup-ready and the web
// service, and then either reports where the device is on the network, or —
// if nobody configured it — offers the setup form right here.

const POST_INSTALL_ATTACH_MS = 240000;
// Test seam: replaces the real wait, so host suites never sit on a timer.
let postInstallHook = null;
export function __setPostInstallHookForTest(hook) { postInstallHook = hook; }

async function attachRunningEcho({ serial, deadline, generation }) {
  // No WebUSB (a test harness or an unsupported browser): nothing to attach to.
  if (!globalThis.navigator?.usb) return null;
  const support = await protocolSupport();
  if (!support.adbTransport.ok || !support.adb.ok) throw new Error(support.adbTransport.reason || support.adb.reason);
  const Transport = support.adbTransport.value;
  const Client = support.adb.value;
  while (Date.now() < deadline) {
    if (state.abort || generation !== state.postInstallGeneration) return null;
    const devices = await Transport.getDevices({ filters: RUNNING_ADB_FILTERS }).catch(() => []);
    for (const device of devices) {
      if (serial && device.serialNumber && device.serialNumber !== serial) continue;
      let transport;
      try {
        transport = await new Transport(device, {}).open();
        const client = new Client(transport);
        await client.connect({ banner: "host::libreecho-browser-installer" });
        return { device, transport, client };
      } catch {
        try { await transport?.close(); } catch { /* re-enumerating */ }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

/** The bar's action after an install, or null while nothing post-install applies. */
function postInstallAction() {
  const s = state.postInstall;
  if (!s || (state.running && s !== "booting")) return null;
  const host = state.provisionHostname || "libreecho";
  const check = () => waitForLibreEcho({ request: true }).catch((error) => terminal.error(error.message));
  if (s === "booting" || s === "applying") {
    // While booting the button is live: a browser that has never been allowed to
    // use the RUNNING Echo (a different USB identity from TWRP) cannot find it
    // on its own, and making the operator wait out the whole deadline first is
    // the "nothing is happening" screen the operator reported.
    return { step: "install", label: "Check my Echo", kind: "pending", suppressed: s === "applying",
      run: check,
      message: s === "applying"
        ? "LibreEcho is running and applying your settings — joining your Wi-Fi. Keep it plugged in."
        : "Installed. Your Echo is restarting into LibreEcho — keep it plugged in while this page checks it started.",
      hint: s === "applying" ? "This usually takes one to two minutes."
        : "This usually takes one to two minutes. If Chrome has not been allowed to use the running Echo yet, press Check my Echo and choose “LibreEcho”.",
      secondary: "" };
  }
  if (s === "done") {
    const url = `http://${state.postInstallIp}:8080/`;
    return { step: "install", label: "Open your Echo's page", kind: "ok", focus: true,
      message: `Done — your Echo is running LibreEcho and is on your network at ${state.postInstallIp} (also ${host}.local).`,
      hint: "Press the button to open its page.", secondary: "",
      run: () => window.open(url, "_blank", "noopener") };
  }
  if (s === "needs-setup" || s === "setup-failed") {
    const ready = Boolean(state.postInstallSession) && validateProvision(provisionForm()).length === 0
      && Boolean(provisionForm().ssid);
    return { step: "configure", label: state.postInstallSession ? "Send settings to your Echo" : "Check my Echo",
      kind: s === "setup-failed" ? "bad" : "action", focus: ready,
      message: s === "setup-failed"
        ? `LibreEcho is running, but it did not finish setting itself up (${state.postInstallDetail || "unknown reason"}). Check step 5 and send the settings again.`
        : "LibreEcho is running. Now set it up: fill in step 5 — account and Wi-Fi — then press Send settings to your Echo.",
      hint: ready ? "The settings go over USB; nothing is reinstalled."
        : "Fill in every field in step 5, including your Wi-Fi name and password.",
      secondary: "", disabled: state.postInstallSession ? !ready : false,
      run: state.postInstallSession
        ? () => sendSettingsToRunningEcho().catch((error) => terminal.error(error.message))
        : check };
  }
  return { step: "install", label: "Check my Echo", kind: "warn", focus: true,
    message: s === "no-permission"
      ? "Installed, but this page could not reach your Echo after it restarted. Press Check my Echo and choose “LibreEcho” in Chrome's list."
      : "Installed, but your Echo has not finished starting yet. Leave it plugged in and press Check my Echo.",
    hint: "Checking only reads; nothing is reinstalled.", secondary: "", run: check };
}

function publishPostInstall() {
  refreshStatusBar();
}

/**
 * Waits for the installed Echo to come up and routes to the next step. Also the
 * body of the "Check my Echo" action, so a slow first boot or a page reload can
 * pick up from here.
 */
export async function waitForLibreEcho({ serial = state.identity?.serialRaw ?? "", expectProvision = false, request = false, device = null,
  open = openAdb, pollOptions = {} } = {}) {
  // Each wait takes a generation. A newer one (a Check my Echo press during the
  // background wait) supersedes it: the old loop stops and leaves the outcome
  // to the newer call.
  state.postInstallGeneration = (state.postInstallGeneration ?? 0) + 1;
  const generation = state.postInstallGeneration;
  const superseded = () => generation !== state.postInstallGeneration;
  state.postInstall = "booting";
  state.postInstallDetail = "";
  setRunProgress("verify", 0.05);
  terminal.phase(STAGES.length, STAGES.length, "waiting for LibreEcho to start");
  publishPostInstall();
  let session = null;
  try {
    if (request || device) {
      // From a button press: may ask Chrome for permission to the running image.
      const chosen = device ?? await navigator.usb.requestDevice({ filters: RUNNING_ADB_FILTERS });
      const opened = await open({ device: chosen, onLog: (line) => terminal.line(line) });
      session = { device: chosen, transport: opened.transport, client: opened.client };
      serial = serial || chosen.serialNumber || "";
    } else {
      session = await attachRunningEcho({ serial, deadline: Date.now() + POST_INSTALL_ATTACH_MS, generation });
    }
    if (!session) {
      if (superseded()) return state.postInstall;
      state.postInstall = "no-permission";
      terminal.warn("LibreEcho's own USB connection did not appear with the permission this page already has");
      publishPostInstall();
      refreshControls();
      return state.postInstall;
    }
    terminal.ok("re-attached to your Echo on LibreEcho's own ADB");
    const started = Date.now();
    const { probe, verdict } = await pollRunningEcho({
      client: session.client, expectedSerial: serial, expectProvision,
      isCancelled: () => state.abort, ...pollOptions,
      onProbe: (_probe, v) => setRunProgress("verify", Math.min(0.95, 0.2 + (Date.now() - started) / 300000 + (v.state === "applying" ? 0.3 : 0))),
    });
    state.postInstall = verdict.state;
    state.postInstallIp = verdict.ip ?? probe.ip ?? null;
    state.postInstallDetail = verdict.error ? `${verdict.error}${verdict.wifi ? `, Wi-Fi ${verdict.wifi}` : ""}` : "";
    if (verdict.state === "done") {
      setRunProgress("verify", 1);
      terminal.ok(`LibreEcho started, is set up, and is on the network at ${state.postInstallIp}`);
    } else if (verdict.state === "needs-setup") {
      setRunProgress("verify", 1);
      terminal.ok("LibreEcho started; it has not been set up yet");
      state.postInstallSession = session;
      session = null; // kept open for "Send settings to your Echo"
      state.provisionState = "idle";
      if (state.provisionMode !== "fill") setProvisionMode("fill");
    } else if (verdict.state === "setup-failed") {
      terminal.warn(`LibreEcho started but setup did not complete: ${state.postInstallDetail}`);
      state.postInstallSession = session;
      session = null;
      state.provisionState = "idle";
      if (state.provisionMode !== "fill") setProvisionMode("fill");
    } else {
      terminal.warn(`LibreEcho did not report ready in time (last state: ${verdict.last})`);
    }
  } catch (error) {
    if (isChooserCancel(error)) { terminal.info("No device was selected."); state.postInstall = "no-permission"; }
    else { terminal.warn(`checking LibreEcho failed: ${error.message}`); state.postInstall = "timeout"; }
  } finally {
    if (session) { try { await session.client?.close?.(); } catch { try { await session.transport?.close?.(); } catch { /* gone */ } } }
  }
  publishPostInstall();
  refreshControls();
  return state.postInstall;
}

/** "Send settings to your Echo": step 5 delivered to the RUNNING image over USB. */
export async function sendSettingsToRunningEcho({ waitOptions = {} } = {}) {
  const session = state.postInstallSession;
  if (!session?.client) throw new StageError("configure", "reconnect your Echo first (press Check my Echo)");
  const target = profileForBoard(state.identity?.profile?.board ?? state.board)?.slug ?? null;
  const release = state.directRelease || state.release?.tag || "";
  state.running = true;
  refreshControls();
  try {
    terminal.phase(STAGES.length, STAGES.length, "sending your settings to the running Echo");
    await sendSetupToRunningEcho({ client: session.client, form: provisionForm(), release, target, terminal,
      isCancelled: () => state.abort });
    state.provisionState = "delivered";
    state.provisionHostname = provisionForm().hostname;
    state.provisionSsid = provisionForm().ssid;
    clearProvisionSecrets({ keepSummary: true });
    terminal.ok("settings delivered; your Echo is applying them");
  } catch (error) {
    terminal.error(`settings NOT delivered: ${error.message}`);
    setStatusBar({ step: "configure", kind: "bad", message: `Your settings were not delivered: ${error.message}`,
      hint: "Fix step 5 and press Send settings to your Echo again.", secondary: "" });
    state.running = false;
    refreshControls();
    return null;
  }
  state.running = false;
  state.postInstallSession = null;
  refreshControls();
  // Only the web service restarted, so the same USB session still works: reuse
  // it to watch the device apply the settings and join the Wi-Fi.
  return waitForLibreEcho({ serial: state.identity?.serialRaw ?? session.device?.serialNumber ?? "",
    expectProvision: true, device: session.device ?? {}, open: async () => session, ...waitOptions });
}

// --- wiring ----------------------------------------------------------------

/**
 * A test-only seam onto the per-device claim registry. The USB-busy
 * deduplication is about two owners of one interface, and reproducing that needs
 * a second owner; this creates one without opening a real device. It is exported
 * for the suite and is not reachable from any page control.
 */
export function __claimDeviceForTest(device) {
  const key = claimKey(device);
  if (recoveryClaims.has(key)) return null;
  recoveryClaims.set(key, { epoch: state.recoveryEpoch, at: Date.now() });
  return () => recoveryClaims.delete(key);
}

dom.buttons.refresh?.addEventListener("click", () => loadReleases().catch((error) => terminal.error(error.message)));
dom.deviceSelect?.addEventListener("change", () => {
  state.board = dom.deviceSelect.value || null;
  discardAutomaticBundle();
  clearBundleReadiness();
  hideDownloadError();
  ensureDownloadPanel(false);
  renderReleaseOptions();
  describeSelectedRelease();
  setStatus(dom.statusRelease, state.release ? "ready" : "none", state.release ? "ok" : "bad");
  setStatus(dom.statusBundle, "nothing downloaded", "pending");
  if (state.board && state.release) terminal.info(`${boardLabel(state.board)}: latest build ${state.release.tag} (nothing downloaded yet)`);
  setRunning(false);
});
dom.releaseSelect?.addEventListener("change", () => {
  discardAutomaticBundle();
  clearBundleReadiness();
  hideDownloadError();
  ensureDownloadPanel(false);
  state.release = state.releases.find((release) => release.tag === dom.releaseSelect.value) ?? state.release;
  setStatus(dom.statusBundle, "nothing downloaded", "pending");
  describeSelectedRelease();
  setRunning(false);
});
dom.buttons.download?.addEventListener("click", () => {
  if (!state.board) { showDownloadError("Choose your device first."); return; }
  if (!state.release) { showDownloadError("No build is selected."); return; }
  fetchBundleAutomatically().catch((error) => terminal.error(error.message));
});
dom.buttons.retry?.addEventListener("click", () => {
  hideDownloadError();
  fetchBundleAutomatically().catch((error) => terminal.error(error.message));
});
dom.buttons.verifyBundle?.addEventListener("click", () => dom.bundleInput.click());
dom.bundleInput?.addEventListener("change", (event) => {
  verifyBundle(event.target.files).catch((error) => terminal.error(`bundle verification failed: ${error.message}`));
});
dom.bundleFolderInput?.addEventListener("change", (event) => {
  verifyBundle(event.target.files).catch((error) => terminal.error(`bundle verification failed: ${error.message}`));
});
dom.buttons.selectArchive?.addEventListener("click", () => dom.archiveInput.click());
dom.archiveInput?.addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) loadAmonetArchive({ file }).catch((error) => terminal.error(`Amonet archive rejected: ${error.message}`));
});
dom.buttons.fetchArchive?.addEventListener("click", () => {
  fetchPinnedAmonetArchive().catch((error) => terminal.error(`Amonet archive fetch failed: ${error.message}`));
});
dom.payloadInput?.addEventListener("change", (event) => {
  loadPayload(event.target.files?.[0]).catch((error) => terminal.error(`payload read failed: ${error.message}`));
});
// The ONE connect action. It is a dispatcher, not a second implementation: it
// calls connectAction(), which is the same object the sticky status bar renders,
// so the in-card button and the bar can never disagree about what pressing this
// does. Everything else about a connection (which USB mode, fastboot or recovery)
// is decided by what the device actually answers.
dom.connectResume?.addEventListener("click", () => {
  const action = connectAction();
  action.run();
});
dom.buttons.connect?.addEventListener("click", () => {
  queryDevice().catch((error) => terminal.error(`device query failed: ${error.message}`));
});
dom.buttons.connectAny?.addEventListener("click", () => {
  queryDevice({ any: true }).catch((error) =>
    terminal.error(`device query failed (unfiltered): ${error.message}`),
  );
});
dom.buttons.recovery?.addEventListener("click", () => {
  findRecovery().catch((error) => terminal.error(`recovery connection failed: ${error.message}`));
});
dom.buttons.grantRecovery?.addEventListener("click", () => {
  grantRecovery().catch((error) => terminal.error(`recovery USB permission failed: ${error.message}`));
});
dom.buttons.recoveryEntry?.addEventListener("click", () => {
  startFromRecovery().catch((error) => terminal.error(`starting from recovery failed: ${error.message}`));
});
dom.buttons.dryRun?.addEventListener("click", () => runInstall({ dryRun: true }));
dom.buttons.run?.addEventListener("click", () => runInstall({ dryRun: false }));
dom.continueFromTwrp?.addEventListener("click", () => runInstall({ dryRun: false }));
dom.statusBarAction?.addEventListener("click", () => {
  // The bar offers exactly one action at a time; the handler is republished by
  // setStatusBar, so it always matches the label the operator can see.
  const action = primaryAction();
  if (!action) return;
  action.run();
});
dom.logToggle?.addEventListener("click", () => {
  // The log is secondary but never lost: this only hides it.
  const collapsed = dom.terminal?.hidden === true;
  if (dom.terminal) dom.terminal.hidden = !collapsed;
  if (dom.logCard) dom.logCard.dataset.collapsed = collapsed ? "false" : "true";
  if (dom.logToggle) {
    dom.logToggle.textContent = collapsed ? "Hide log" : "Show log";
    dom.logToggle.setAttribute("aria-expanded", collapsed ? "true" : "false");
  }
});
dom.buttons.abort?.addEventListener("click", () => {
  requestStop();
  // Stop must not leave a password sitting in the form: the operator can press
  // Run again, and a stopped run is exactly when the page is abandoned.
  clearProvisionSecrets();
  terminal.warn("stop requested: a device wait is cancelled now; the current USB operation finishes, then the run stops before the next stage");
});
// Step 5 wiring. The mode radio is the default-deny control: "skip" is checked
// in the markup, so a page that is never touched writes nothing.
dom.provision.modeSkip?.addEventListener("change", () => setProvisionMode("skip"));
dom.provision.modeFill?.addEventListener("change", () => setProvisionMode("fill"));
for (const name of provisionInputs) {
  dom.provision[name]?.addEventListener("input", onProvisionInput);
  dom.provision[name]?.addEventListener("change", onProvisionInput);
}
// Reload and close must not leave a credential recoverable from this page.
globalThis.addEventListener?.("pagehide", () => clearProvisionSecrets(), { once: true });
globalThis.addEventListener?.("beforeunload", () => clearProvisionSecrets(), { once: true });
document.getElementById("download-log")?.addEventListener("click", () => {
  const blob = new Blob([terminal.plainText()], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `libreecho-browser-install-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  link.click();
  URL.revokeObjectURL(link.href);
});

terminal.info("LibreEcho browser installer — preview");
terminal.info(`repository: ${config.repository}${config.mirrorBase ? ` · mirror: ${config.mirrorBase}` : ""}`);
terminal.info("choose your device, then download the build made for it; nothing is downloaded automatically");
renderBoardOptions();
setProvisionMode("skip", { chosen: false });
setRunning(false);
renderStepList(null);
// A reload restores only the non-secret transaction context, before anything
// else, so the status bar can already say what this page was doing. It restores
// no identity and no bundle readiness, so the Connect/Resume action stays gated.
restoreResumeState().then((restored) => {
  // Read-only identification of a previously granted device. This may NAME a
  // device and nothing else: it is deliberately not chained to any run, so a page
  // load can never begin a write, an unlock or a reboot.
  return autoIdentifyGrantedDevice().catch((error) => {
    terminal.info(`this page will ask which device to use: ${error.message}`);
    return null;
  }).then((identified) => {
    if (restored?.ok || identified?.identified) refreshControls();
  });
});
reportCapabilities()
  .then(({ support }) => {
    if (support.ok) loadReleases();
  })
  .catch((error) => terminal.error(`capability check failed: ${error.message}`));
