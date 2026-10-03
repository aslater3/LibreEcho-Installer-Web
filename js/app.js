// Browser one-shot installer — UI and run orchestration.
//
// Step order and safety rules mirror the reviewed host installer. Nothing is
// written until the release inventory, the device identity and the unlock
// payload (when needed) have all been read and checked; every stage reports what
// it verified, and a failed stage stops the run.

import { Terminal } from "./terminal.js";
import { webusbSupport, describeUsbDevice, requestRecoveryDevice, recoveryChooserFilters, maskSerial } from "./device.js";
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
import { STAGES, StageError, RecoveryStopped, createMutex, validateRecoverySession, readFastbootIdentity, assessIdentity, submitUnlockPayload, readKaeruHeader, rebootAndWait, RECOVERY_TIMEOUT_MS, RECOVERY_POLL_INTERVAL_MS } from "./stages.js";
import { DIRECT_PROTOCOL, DIRECT_INCOMING_DIR, prepareDirectInstall, pushDirectControl, pushDirectPayloads, runDirectPhase } from "./direct-install.js";
import { payloadForProfile } from "./profiles.js";
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
import { formatSize, formatDuration, computeEta } from "./progress.js";

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
};

function setStatus(node, text, kind = "pending") {
  if (!node) return;
  node.textContent = text;
  node.dataset.state = kind;
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
      return "Press Query device and choose your Echo in Chrome's list. This only reads; it writes nothing.";
    case "unlock-payload":
      return state.payloadBytes ? `Unlock payload ${state.payloadName} is verified and ready.`
        : "This device is locked: select the pinned Amonet ZIP so the unlock stage has its verified payload.";
    case "install":
      if (state.running) return "Install in progress. Watch the progress bar; do not unplug the device.";
      if (state.stageProgress?.finalize === "done") return "Install finished and a reboot was requested. The running OS is not verified by this page.";
      return blocked ? `Install is not available yet: ${blocked}.` : "Everything is verified. Press Run the install.";
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

// The five wizard steps, in the order the operator does them. `stage` maps a
// card to the STAGES entry that makes it active, so the run can highlight the
// right card as it progresses.
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
  { id: "install", title: "Install", summary: () => {
    const blocked = installReadinessReason();
    if (state.running) return "Install in progress.";
    if (state.stageProgress?.finalize === "done") return "Installed; reboot requested.";
    return blocked ? `Blocked: ${blocked}` : "Ready to run the install.";
  } },
];

const STEP_STAGE_MAP = {
  "device-build": null,
  "download-verify": "release",
  "connect-device": "device",
  "unlock-payload": "unlock",
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
  return state.stageProgress?.finalize === "done" || installReadinessReason() === null;
}

function stepReady(id) {
  if (id === "device-build") return !state.board || (Boolean(state.board) && !state.release);
  if (id === "download-verify") return Boolean(state.board) && Boolean(state.release) && !state.bundleReady && !state.fetchingBundle;
  if (id === "connect-device") return Boolean(state.bundleReady) && !state.identity;
  if (id === "unlock-payload") return amonetRequirement().mode === "required" && !state.payloadBytes;
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
  const percent = Math.max(0, Math.min(100, Math.round(
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

export async function queryDevice({ any = false, open = openFastboot } = {}) {
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
      setStatus(dom.statusDevice, "not connected", "bad");
      refreshControls();
    }
    throw error;
  }
}

function renderDevicePanel(identity, assessment) {
  dom.devicePanel.innerHTML = "";
  const blocked = installReadinessReason();
  const rows = [
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
  const key = claimKey(device);
  // Refuse before any await: a queued open is exactly the interleaved-CNXN race.
  if (isRecoveryDeviceBusy(device)) throw new RecoveryDeviceBusy(device);
  recoveryClaims.set(key, { epoch: epoch ?? state.recoveryEpoch, at: Date.now() });
  try {
    return await recoveryLock.run(async () => {
      if (stale()) throw new RecoveryStopped();
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
    });
  } finally {
    recoveryClaims.delete(key);
  }
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
        claimed = await abortable(pollGrantedRecovery({ expectedSerial, expectedBoard, identity, epoch,
          grantedDevices: async () => devices, open, openSession, signal: controller.signal,
          mismatchProbe }), controller.signal);
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

export async function grantRecovery({ request = null, requestWide = null, open = openAdb, openSession = null, signal = null } = {}) {
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
  if (!state.identity) unmet.push("Query the device in fastboot (step 3) so its identity can be read from the device itself.");
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
          : "Your Echo is restarting. Press this once, then choose the USB device named “Echo” in Chrome’s list. The install continues by itself.",
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
    return { step: "connect-device", label: "Query device", message: stageMessage("connect-device"),
      hint: "Read-only fastboot query. Choose your Echo in Chrome’s list.", kind: "action",
      run: () => queryDevice().catch((error) => terminal.error(`device query failed: ${error.message}`)) };
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
    action: action.suppressed ? null : { label: action.label },
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
  dom.buttons.connect.disabled = running;
  dom.buttons.connectAny.disabled = running;
  dom.buttons.grantRecovery.disabled = busy && !state.recoveryWaiting;
  dom.buttons.refresh.disabled = running;
  dom.buttons.abort.disabled = !running;
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

export async function runInstall({ dryRun = false, recovery = {} } = {}) {
  if (state.running || state.fetchingBundle) return;
  state.abort = false;
  state.stageProgress = {};
  state.receipts = [];
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
    // The unlock latch is per page session and keyed to the serial. Once flash:brick
    // has been sent the outcome is unknown (usually the device stops answering), so
    // the ONLY correct follow-up is the recovery wait — never a second submission.
    // This survives the `finally` below, unlike the bound ADB session, and it is what
    // makes "Continue from TWRP" safe after a recovery timeout.
    const unlockAlreadySent = state.unlockSubmitted === state.identity.serialRaw;
    if (resumedRecovery) {
      terminal.ok("continuing from verified recovery without re-submitting the unlock payload");
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
      }
      assertNotAborted("unlock");
      currentStage("recovery");
      // Waits for TWRP, polling already-granted devices without a prompt and
      // keeping the dedicated permission action available while it waits.
      await awaitRecovery(recovery);
    }
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
    const prepared = await runDirectPhase({ ...phaseShared, phase: "prepare" });
    state.receipts.push(prepared);
    phaseShared.deviceDigest = prepared.device_digest;
    if (!["prepare-ok", "prepare-noop"].includes(prepared.result)) {
      throw new StageError("prepare", `the prepare phase returned result=${prepared.result ?? "unknown"}`);
    }
    if (await readKaeruHeader(state.adb) !== kaeruBefore) {
      throw new StageError("install", "expdb Kaeru header changed during the prepare phase; do not reboot");
    }
    assertNotAborted("prepare");
    if (prepared.reboot_required === "1") {
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
    const initialized = await runDirectPhase({ ...phaseShared, phase: "initialize" });
    state.receipts.push(initialized);
    if (initialized.result !== "initialized") {
      throw new StageError("initialize", `the initialize phase returned result=${initialized.result ?? "unknown"}`);
    }
    if (await readKaeruHeader(state.adb) !== kaeruBefore) {
      throw new StageError("install", "expdb Kaeru header changed during initialize; do not install");
    }
    state.stageProgress.initialize = "done";
    assertNotAborted("initialize");

    currentStage("transfer");
    const transferred = await runDirectPhase({ ...phaseShared, phase: "transfer" });
    state.receipts.push(transferred);
    if (transferred.result !== "transferred") {
      throw new StageError("transfer", `the transfer phase returned result=${transferred.result ?? "unknown"}`);
    }
    assertNotAborted("transfer");
    const pushed = await pushDirectPayloads({ adb: state.adb, roles: state.directRoles, files: state.files, sums: state.sums, terminal, isCancelled: () => state.abort });
    terminal.ok(`pushed ${pushed.fileCount} verified payload(s) into ${DIRECT_INCOMING_DIR}`);
    state.stageProgress.transfer = "done";
    assertNotAborted("transfer");

    currentStage("finalize");
    // The landed-completely gate: finalize --dry-run verifies every upload by
    // digest and writes nothing. Only then is the real finalize (no format) run.
    const rehearsal = await runDirectPhase({ ...phaseShared, phase: "finalize", dryRun: true });
    if (rehearsal.result !== "dry-run-ok") {
      throw new StageError("finalize", `the landed-completely check returned result=${rehearsal.result ?? "unknown"}`);
    }
    const finalized = await runDirectPhase({ ...phaseShared, phase: "finalize" });
    state.receipts.push(finalized);
    if (finalized.result !== "installed") {
      throw new StageError("finalize", `the finalize phase returned result=${finalized.result ?? "unknown"}`);
    }
    if (await readKaeruHeader(state.adb) !== kaeruBefore) {
      throw new StageError("install", "expdb Kaeru header changed during finalize; do not reboot");
    }
    state.stageProgress.finalize = "done";

    currentStage("verify");
    terminal.phase(STAGES.length, STAGES.length, "verify and reboot");
    assertNotAborted("verify");
    await rebootAndWait({ adb: state.adb, target: "", terminal });
    terminal.warn("reboot requested; installed OS boot, userdata preservation and service readiness are NOT verified by this page");
    terminal.info("confirm the same device and its marker-free running image before calling the installation complete");
    state.stageProgress.verify = "done";
    // Success is republished to the bar too; the run is over and nothing is
    // pending, so no primary action is offered.
    setStatusBar({ step: "install", kind: "ok", action: null,
      message: "Install finished and a reboot was requested. The running OS is not verified by this page — confirm the device itself before calling it complete.",
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
}

// --- wiring ----------------------------------------------------------------

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
  terminal.warn("stop requested: a device wait is cancelled now; the current USB operation finishes, then the run stops before the next stage");
});
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
setRunning(false);
renderStepList(null);
reportCapabilities()
  .then(({ support }) => {
    if (support.ok) loadReleases();
  })
  .catch((error) => terminal.error(`capability check failed: ${error.message}`));
