// Browser one-shot installer — UI and run orchestration.
//
// Step order and safety rules mirror the reviewed host installer. Nothing is
// written until the release inventory, the device identity and the unlock
// payload (when needed) have all been read and checked; every stage reports what
// it verified, and a failed stage stops the run.

import { Terminal } from "./terminal.js";
import { webusbSupport, describeUsbDevice, requestDevice, maskSerial } from "./device.js";
import { protocolSupport, openFastboot, openAdb } from "./transports.js";
import {
  installerConfig,
  fetchReleaseIndex,
  pickLatestStable,
  pickLatestDevelopment,
  verifyBundleFiles,
  sha256OfBlob,
  parseSums,
  releasePageUrl,
  assetPrefix,
} from "./release.js";
import { STAGES, StageError, readFastbootIdentity, assessIdentity, submitUnlockPayload, waitForRecovery, readKaeruHeader, pushBundle, verifyStagedBundle, runRecoveryPhase, rebootAndWait } from "./stages.js";
import { payloadNameCandidates, requiredBundleMembers } from "./profiles.js";

const config = installerConfig();

const dom = {
  terminal: document.getElementById("terminal"),
  capability: document.getElementById("capability"),
  releaseSelect: document.getElementById("release-select"),
  releaseMeta: document.getElementById("release-meta"),
  bundleInput: document.getElementById("bundle-input"),
  bundleFolderInput: document.getElementById("bundle-folder-input"),
  payloadInput: document.getElementById("payload-input"),
  statusRelease: document.getElementById("status-release"),
  statusBundle: document.getElementById("status-bundle"),
  statusDevice: document.getElementById("status-device"),
  statusPayload: document.getElementById("status-payload"),
  devicePanel: document.getElementById("device-panel"),
  stepList: document.getElementById("step-list"),
  buttons: {
    refresh: document.getElementById("btn-refresh"),
    verifyBundle: document.getElementById("btn-bundle"),
    connect: document.getElementById("btn-connect"),
    dryRun: document.getElementById("btn-dry-run"),
    run: document.getElementById("btn-run"),
    abort: document.getElementById("btn-abort"),
    recovery: document.getElementById("btn-recovery"),
    grantRecovery: document.getElementById("btn-grant-recovery"),
    connectAny: document.getElementById("btn-connect-any"),
  },
};

export const terminal = new Terminal(dom.terminal);

export const state = {
  releases: [],
  release: null,
  sums: null,
  files: new Map(),
  payloadBytes: null,
  payloadName: "",
  fastboot: null,
  identity: null,
  adb: null,
  recoverySerial: null,
  kaeruHeader: null,
  receipts: [],
  bundleReady: false,
  bundleBoard: null,
  markerSafe: false,
  running: false,
  abort: false,
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
  if (!support.ok) {
    terminal.warn(support.reason);
  }
  return { support, protocols };
}

// --- releases --------------------------------------------------------------

export async function loadReleases() {
  if (state.running) throw new Error("cannot refresh releases during an active run");
  state.sums = null;
  state.files = new Map();
  state.bundleReady = false;
  state.bundleBoard = null;
  state.markerSafe = false;
  setRunning(false);
  setStatus(dom.statusBundle, "nothing verified for this release", "pending");
  setStatus(dom.statusRelease, "loading", "pending");
  terminal.info(`reading the release index for ${config.repository} (api.github.com is CORS-readable)`);
  try {
    state.releases = await fetchReleaseIndex(config.repository);
  } catch (error) {
    setStatus(dom.statusRelease, "unavailable", "bad");
    terminal.error(`release index unavailable: ${error.message}`);
    terminal.warn("the installer still works: provide the release tag and your downloaded bundle explicitly.");
    return;
  }
  const stable = pickLatestStable(state.releases);
  const dev = pickLatestDevelopment(state.releases);
  dom.releaseSelect.innerHTML = "";
  const add = (release, label) => {
    if (!release) return;
    const option = document.createElement("option");
    option.value = release.tag;
    const count = release.assets.length;
    option.textContent = `${label}: ${release.tag} (${count} assets, published ${new Date(release.publishedAt).toISOString().slice(0, 10)})`;
    dom.releaseSelect.appendChild(option);
  };
  add(stable, "Stable");
  add(dev, "Development");
  for (const release of state.releases) {
    if (release !== stable && release !== dev) add(release, release.kind === "stable" ? "Stable" : "Development");
    }
  state.release = stable ?? dev ?? state.releases[0];
  if (config.releaseTag) {
    const preferred = state.releases.find((release) => release.tag === config.releaseTag);
    if (preferred) state.release = preferred;
  }
  dom.releaseSelect.value = state.release?.tag ?? "";
  describeSelectedRelease();
  setStatus(dom.statusRelease, state.release ? "selected" : "none", state.release ? "ok" : "bad");
}

function describeSelectedRelease() {
  const release = state.release;
  if (!release) {
    dom.releaseMeta.textContent = "No release selected.";
    return;
  }
  const boot = release.assets.find((asset) => asset.name.endsWith("-boot.img"));
  const features = release.assets.filter((asset) => asset.name.endsWith(".squashfs"));
  const prefix = assetPrefix(release.tag);
  const featureName = (name) => name.replace(`${prefix}-`, "").replace(".squashfs", "");
  const total = release.assets.reduce((sum, asset) => sum + asset.size, 0);
  dom.releaseMeta.innerHTML = "";
  const lines = [
    `${release.kind === "stable" ? "Stable" : "Development"} release ${release.tag} · published ${new Date(release.publishedAt).toISOString().slice(0, 10)}`,
    `${release.assets.length} assets · ${(total / 1048576).toFixed(0)} MiB total`,
    boot ? `boot image: ${boot.name} (${(boot.size / 1048576).toFixed(1)} MiB)` : "no boot image in this release",
    `${features.length} feature payload(s)${features.length ? `: ${features.map((asset) => featureName(asset.name)).join(", ")}` : ""}`,
  ];
  for (const line of lines) {
    const row = document.createElement("p");
    row.textContent = line;
    dom.releaseMeta.appendChild(row);
  }
  const link = document.createElement("a");
  link.className = "text-link";
  link.href = releasePageUrl(release.tag, config.repository);
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "Open the release page to download the bundle (browser downloads work; in-page fetches do not)";
  dom.releaseMeta.appendChild(link);
}

// --- bundle ----------------------------------------------------------------

export async function verifyBundle(fileList) {
  if (state.running) throw new Error("cannot change bundle during an active run");
  const release = state.release;
  state.bundleReady = false;
  state.markerSafe = false;
  state.bundleBoard = null;
  state.files = new Map();
  state.sums = null;
  if (!release) {
    terminal.error("select a release first");
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
  const prefix = assetPrefix(release.tag);
  const normalName = `${prefix}-SHA256SUMS`;
  const twrpName = `${prefix}-TWRPINSTALL-SHA256SUMS`;
  try {
    const readPinnedInventory = async (name) => {
      const file = byName.get(name);
      const asset = release.assets.find((entry) => entry.name === name);
      if (!file || !asset || !/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? "") || file.size !== asset.size) {
        throw new Error(`${name}: missing API-digest-anchored checksum inventory`);
      }
      const actual = await sha256OfBlob(file);
      if (actual !== asset.digest.slice(7)) throw new Error(`${name}: checksum digest mismatch against GitHub release API`);
      return parseSums(await file.text());
    };
    const normal = await readPinnedInventory(normalName);
    const twrp = await readPinnedInventory(twrpName);
    const required = requiredBundleMembers(release.tag);
    for (const name of required) {
      if (name === normalName || name === twrpName) continue;
      const inventory = name === "libreecho-install.zip" || name === "bundle.manifest" ? twrp : normal;
      if (!inventory.has(name)) throw new Error(`${name}: missing from the correct release checksum inventory`);
      const asset = release.assets.find((entry) => entry.name === name);
      if (!asset || asset.digest !== `sha256:${inventory.get(name)}`) {
        throw new Error(`${name}: published asset digest differs from the checksum inventory`);
      }
    }
    const sums = new Map([...normal, ...twrp]);
    const result = await verifyBundleFiles(files, {
      sums,
      onProgress: (fraction, name) => terminal.progress("hashing bundle", fraction, name),
    });
    terminal.endProgress();
    if (result.failed.length || result.missing.length) {
      throw new Error(`bundle not complete: ${result.failed.length} digest mismatch, ${result.missing.length} missing`);
    }
    const build = JSON.parse(await result.byName.get(`${prefix}-build.json`).text());
    if (!build.board || build.hardware_accepted !== true) {
      throw new Error("build metadata has no hardware-accepted board; refusing device writes");
    }
    if (state.release !== release) throw new Error("release selection changed during verification");
    state.sums = sums;
    state.files = result.byName;
    state.bundleBoard = build.board;
    state.bundleReady = true;
    setRunning(false);
    setStatus(dom.statusBundle, `${result.checked.length} verified (including recovery ZIP)`, "ok");
    terminal.ok(`complete bundle verified against GitHub release API (${build.board})`);
  } catch (error) {
    terminal.endProgress();
    setStatus(dom.statusBundle, "verification failed", "bad");
    terminal.error(error.message);
  }
}

// --- device ----------------------------------------------------------------

export async function queryDevice({ any = false, open = openFastboot } = {}) {
  currentStage("device");
  try {
    if (any) terminal.info("unfiltered chooser: the browser will list every USB device on this machine");
    const session = await open({ onLog: (line) => terminal.line(line), any });
    state.fastboot = session;
    terminal.ok(`fastboot device ready: ${describeUsbDevice(session.device)}`);
    currentStage("identity");
    const identity = await readFastbootIdentity(session.client, terminal);
    state.identity = identity;
    state.adb = null;
    state.recoverySerial = null;
    state.kaeruHeader = null;
    const assessment = assessIdentity(identity, terminal);
    renderDevicePanel(identity, assessment);
    setStatus(
      dom.statusDevice,
      `${identity.product || "unknown"} · ${assessment.unlocked ? "unlocked" : "locked"} · ${identity.serialMasked}`,
      identity.profile ? (assessment.unlocked ? "ok" : "warn") : "bad",
    );
    return identity;
  } catch (error) {
    setStatus(dom.statusDevice, "not connected", "bad");
    throw error;
  }
}

function renderDevicePanel(identity, assessment) {
  dom.devicePanel.innerHTML = "";
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
    ["userdata contract", identity.profile ? `${identity.profile.userdataContractSectors.join(" or ")} sectors` : "—"],
    ["next step", state.markerSafe ? (assessment.unlocked ? "recovery verification" : "qualified unlock preflight") : "install blocked: no marker-safe board image qualified"],
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

async function findRecovery() {
  currentStage("recovery");
  if (!state.identity?.serialRaw) throw new StageError("recovery", "select and identify the fastboot device first");
  const session = await waitForRecovery({ timeoutMs: 30000, expectedSerial: state.identity.serialRaw, terminal });
  state.adb = session.client;
  state.kaeruHeader = await readKaeruHeader(session.client);
  state.recoverySerial = state.identity.serialRaw;
  terminal.ok("the selected TWRP device has an intact Kaeru expdb header");
  const receipt = await session.client.shell("cat /cache/libreecho-install-receipt 2>/dev/null || true");
  if (String(receipt.stdout ?? "").trim()) {
    terminal.info("an existing install receipt is present on the device:");
    for (const line of String(receipt.stdout).trim().split(/\r?\n/)) terminal.line(line);
  }
  return session;
}

export async function grantRecovery({ request = requestDevice, openSession = null } = {}) {
  if (!state.identity?.serialRaw) throw new StageError("recovery", "select and identify the fastboot device first");
  // requestDevice must run directly from the button event's user activation.
  const pendingDevice = request("adb");
  const device = await pendingDevice;
  const session = await waitForRecovery({ adbDevice: device, openSession, expectedSerial: state.identity.serialRaw,
    timeoutMs: 30000, terminal });
  const header = await readKaeruHeader(session.client);
  state.adb = session.client;
  state.kaeruHeader = header;
  state.recoverySerial = state.identity.serialRaw;
  terminal.ok("ADB permission granted to the selected TWRP device; Kaeru header intact");
  return session;
}

// --- unlock payload --------------------------------------------------------

async function loadPayload(file) {
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { sha256Bytes } = await import("./sha256.js");
  const digest = await sha256Bytes(bytes);
  state.payloadBytes = bytes;
  state.payloadName = file.name;
  const candidates = payloadNameCandidates(state.identity?.profile);
  const looksRight = candidates.length === 0 || candidates.includes(file.name);
  terminal.info(`unlock payload: ${file.name} (${bytes.length} bytes) sha256=${digest}`);
  if (!looksRight) {
    terminal.warn(
      `this payload name is not in the declared map for the detected device (${candidates.join(", ") || "none"}). ` +
        "Confirm the release archive the payload came from before submitting it.",
    );
  }
  setStatus(dom.statusPayload, `${file.name} — sha256 ${digest.slice(0, 12)}…`, looksRight ? "ok" : "warn");
}

// --- run -------------------------------------------------------------------

function setRunning(running) {
  state.running = running;
  dom.buttons.run.disabled = running || !state.bundleReady || !state.markerSafe;
  dom.buttons.dryRun.disabled = running;
  dom.buttons.verifyBundle.disabled = running;
  dom.bundleInput.disabled = running;
  dom.bundleFolderInput.disabled = running;
  dom.payloadInput.disabled = running;
  dom.releaseSelect.disabled = running;
  dom.buttons.connect.disabled = running;
  dom.buttons.grantRecovery.disabled = running;
  dom.buttons.refresh.disabled = running;
  dom.buttons.abort.disabled = !running;
}

function assertNotAborted(stage) {
  if (state.abort) throw new StageError(stage, "aborted by the operator");
}

export async function runInstall({ dryRun = false } = {}) {
  if (state.running) return;
  state.abort = false;
  state.stageProgress = {};
  state.receipts = [];
  setRunning(true);
  terminal.phase(1, STAGES.length, dryRun ? "rehearsal: no writes" : "browser one-shot install");
  terminal.info(`release ${state.release?.tag ?? "(none)"} · repository ${config.repository}`);
  if (config.mirrorBase) terminal.info(`asset mirror: ${config.mirrorBase}`);
  else terminal.warn("no CORS-capable asset mirror configured: payload bytes must come from your own download");

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

    const assessment = assessIdentity(state.identity, terminal);
    state.stageProgress.identity = "done";
    const profile = state.identity.profile;
    const boardMismatch = !profile || (release.tag.startsWith("radar-puffin-") && profile.board !== "radar_puffin");
    const blockReason = boardMismatch
      ? `release board mismatch: ${release.tag} is not a qualified ${profile?.board ?? "unknown"} image`
      : profile.id === "biscuit"
        ? "no qualified Biscuit image has been published; refusing unlock and install"
        : assessment.findings[0] ?? null;
    if (dryRun) {
      if (blockReason) terminal.warn(blockReason);
      terminal.ok("host-only rehearsal complete; zero USB write commands were sent");
      return;
    }
    if (blockReason) throw new StageError("identity", blockReason);
    if (!state.bundleReady) throw new StageError("release", "the complete release bundle and recovery ZIP must be verified before unlock");
    if (state.bundleBoard !== profile.board) throw new StageError("release", "release board mismatch in verified build metadata");
    if (state.markerSafe !== true) throw new StageError("release", "marker-safe image qualification is missing; FASTBOOT_PLEASE risk blocks unlock and install");

    const resumedRecovery = state.adb && state.recoverySerial === state.identity.serialRaw && state.kaeruHeader;
    if (resumedRecovery) {
      terminal.ok("continuing from verified recovery without re-submitting the unlock payload");
      state.stageProgress.unlock = "done";
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
      const recovery = await waitForRecovery({ terminal, expectedSerial: state.identity.serialRaw });
      state.adb = recovery.client;
      state.recoverySerial = state.identity.serialRaw;
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
    currentStage("stage");
    await pushBundle({ adb: state.adb, files: state.files, sums: state.sums, terminal });
    await verifyStagedBundle({ adb: state.adb, sums: state.sums, files: state.files, terminal });
    state.stageProgress.stage = "done";
    assertNotAborted("stage");

    currentStage("prepare");
    const first = await runRecoveryPhase({ adb: state.adb, tag: release.tag,
      serialRaw: state.identity.serialRaw, phase: "prepare" }, { terminal });
    state.receipts.push(first);
    if (await readKaeruHeader(state.adb) !== kaeruBefore) {
      throw new StageError("install", "expdb Kaeru header changed during the recovery installer; do not reboot");
    }
    if (first.reboot_required === "1") {
      terminal.info("the installer reshaped userdata and needs a reboot before it can install");
      state.stageProgress.prepare = "done";
      currentStage("install");
      await rebootAndWait({ adb: state.adb, target: "recovery", terminal });
      const next = await waitForRecovery({ terminal, expectedSerial: state.identity.serialRaw });
      state.adb = next.client;
      if (await readKaeruHeader(state.adb) !== kaeruBefore) {
        throw new StageError("install", "expdb Kaeru header changed after recovery reboot; do not install");
      }
      const second = await runRecoveryPhase({ adb: state.adb, tag: release.tag,
        serialRaw: state.identity.serialRaw, phase: "install" }, { terminal });
      state.receipts.push(second);
      if (await readKaeruHeader(state.adb) !== kaeruBefore) {
        throw new StageError("install", "expdb Kaeru header changed during install; do not reboot");
      }
      if (second.result !== "installed") {
        throw new StageError("install", `the install phase returned result=${second.result ?? "unknown"}`);
      }
    } else if (first.result !== "installed") {
      throw new StageError("install", `the recovery installer returned result=${first.result ?? "unknown"}`);
    }
    state.stageProgress.install = "done";

    currentStage("verify");
    terminal.phase(STAGES.length, STAGES.length, "verify and reboot");
    await rebootAndWait({ adb: state.adb, target: "", terminal });
    terminal.warn("reboot requested; installed OS boot, userdata preservation and service readiness are NOT verified by this page");
    terminal.info("confirm the same device and its marker-free running image before calling the installation complete");
    state.stageProgress.verify = "done";
  } catch (error) {
    const stage = error instanceof StageError ? error.stage : "unknown";
    terminal.error(`${stage} stage failed: ${error.message}`);
    if (error.detail) terminal.line(String(error.detail));
    terminal.info("nothing further was attempted. Preserve the current device state; do not re-run a submitted unlock or installer ZIP without classifying its result first.");
  } finally {
    setRunning(false);
    renderStepList(null);
  }
}

// --- wiring ----------------------------------------------------------------

dom.buttons.refresh?.addEventListener("click", () => loadReleases().catch((error) => terminal.error(error.message)));
dom.releaseSelect?.addEventListener("change", () => {
  state.sums = null;
  state.files = new Map();
  state.bundleReady = false;
  state.bundleBoard = null;
  state.markerSafe = false;
  state.release = state.releases.find((release) => release.tag === dom.releaseSelect.value) ?? state.release;
  setStatus(dom.statusBundle, "nothing verified for this release", "pending");
  describeSelectedRelease();
});
dom.buttons.verifyBundle?.addEventListener("click", () => dom.bundleInput.click());
dom.bundleInput?.addEventListener("change", (event) => {
  verifyBundle(event.target.files).catch((error) => terminal.error(`bundle verification failed: ${error.message}`));
});
dom.bundleFolderInput?.addEventListener("change", (event) => {
  verifyBundle(event.target.files).catch((error) => terminal.error(`bundle verification failed: ${error.message}`));
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
dom.buttons.abort?.addEventListener("click", () => {
  state.abort = true;
  terminal.warn("stop requested: the current USB operation finishes, then the run stops before the next stage");
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
setRunning(false);
renderStepList(null);
reportCapabilities()
  .then(({ support }) => {
    if (support.ok) loadReleases();
  })
  .catch((error) => terminal.error(`capability check failed: ${error.message}`));
