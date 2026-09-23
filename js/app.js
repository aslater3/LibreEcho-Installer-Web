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
  parseSums,
  releasePageUrl,
  assetPrefix,
} from "./release.js";
import { STAGES, StageError, verifyReleaseInventory, readFastbootIdentity, assessIdentity, submitUnlockPayload, waitForRecovery, pushBundle, verifyStagedBundle, runRecoveryPhase, rebootAndWait } from "./stages.js";
import { payloadNameCandidates } from "./profiles.js";

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
  },
};

const terminal = new Terminal(dom.terminal);

const state = {
  releases: [],
  release: null,
  sums: null,
  files: new Map(),
  payloadBytes: null,
  payloadName: "",
  fastboot: null,
  identity: null,
  adb: null,
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

async function loadReleases() {
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

async function verifyBundle(fileList) {
  const release = state.release;
  if (!release) {
    terminal.error("select a release first");
    return;
  }
  const files = [...fileList].filter((file) => file.size > 0 || file.name.endsWith(".sha256"));
  if (files.length === 0) {
    terminal.warn("no files selected");
    return;
  }
  terminal.info(`hashing ${files.length} file(s) locally; nothing is written to the device in this step`);
  if (!state.sums) {
    const sumsFile = files.find((file) => file.name.endsWith("SHA256SUMS"));
    if (!sumsFile) {
      terminal.error("the release SHA256SUMS file is not in the selection; download it from the release page and include it");
      setStatus(dom.statusBundle, "missing SHA256SUMS", "bad");
      return;
    }
    state.sums = parseSums(await sumsFile.text());
    terminal.ok(`parsed ${state.sums.size} digests from ${sumsFile.name}`);
  }
  const result = await verifyBundleFiles(files, {
    sums: state.sums,
    onProgress: (fraction, name) =>
      terminal.progress("hashing bundle", fraction, name),
  });
  terminal.endProgress();
  for (const item of result.checked) {
    terminal.ok(`${item.name} — ${(item.size / 1048576).toFixed(1)} MiB matches the release digest`);
  }
  for (const item of result.missing) {
    terminal.warn(`${item} is not in the selection (it is required before flashing)`);
  }
  for (const item of result.failed) {
    terminal.error(`${item.name}: local ${item.actual} != release ${item.expected}`);
  }
  state.files = result.byName;
  const okCount = result.checked.length;
  setStatus(
    dom.statusBundle,
    `${okCount} verified${result.failed.length ? `, ${result.failed.length} mismatch` : ""}${result.missing.length ? `, ${result.missing.length} missing` : ""}`,
    result.failed.length ? "bad" : okCount ? "ok" : "pending",
  );
  if (result.failed.length) {
    terminal.error("refusing to continue: the local bundle does not match the published release");
  } else if (result.missing.length) {
    terminal.warn("some release files are missing from the selection; the installer will push only what it verified");
  }
}

// --- device ----------------------------------------------------------------

async function connectFastboot() {
  currentStage("device");
  try {
    const session = await openFastboot({ onLog: (line) => terminal.line(line) });
    state.fastboot = session;
    terminal.ok(`fastboot device ready: ${describeUsbDevice(session.device)}`);
    currentStage("identity");
    const identity = await readFastbootIdentity(session.client, terminal);
    state.identity = identity;
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
    ["fastboot product", identity.product || "(not reported)"],
    ["unlock_status", identity.unlockStatus || "(not reported)"],
    ["LK build description", identity.lkBuild || "(not reported)"],
    ["max-download-size", identity.maxDownload || "(not reported)"],
    ["device id", `${identity.serialMasked} (masked in this page)`],
    ["recognised target", identity.profile ? `${identity.profile.marketing} — ${identity.profile.libreEcho}` : "not a declared LibreEcho target"],
    ["userdata contract", identity.profile ? `${identity.profile.userdataContractSectors.join(" or ")} sectors` : "—"],
    ["next step", assessment.unlocked ? "unlocked: continue to the recovery install" : "locked: an unlock payload is required"],
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
  // Re-attach silently when permission already exists; only prompt when the
  // origin has never been granted access to an ADB device.
  let session = null;
  try {
    const { reattachAdb } = await import("./transports.js");
    session = await reattachAdb({ timeoutMs: 6000, onLog: (line) => terminal.line(line) });
  } catch {
    session = null;
  }
  if (!session) {
    terminal.info("no ADB device is authorised for this origin yet: asking the browser for access");
    session = await waitForRecovery({ timeoutMs: 30000, terminal });
  }
  state.adb = session.client;
  const probe = await session.client.shell("getprop ro.twrp.version; cat /proc/mounts | grep -c cache");
  terminal.ok(`recovery session ready (${String(probe.stdout ?? "").trim().replace(/\s+/g, " ")})`);
  const receipt = await session.client.shell("cat /cache/libreecho-install-receipt 2>/dev/null || true");
  if (String(receipt.stdout ?? "").trim()) {
    terminal.info("an existing install receipt is present on the device:");
    for (const line of String(receipt.stdout).trim().split(/\r?\n/)) terminal.line(line);
  }
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
  dom.buttons.run.disabled = running;
  dom.buttons.dryRun.disabled = running;
  dom.buttons.connect.disabled = running;
  dom.buttons.refresh.disabled = running;
  dom.buttons.abort.disabled = !running;
}

function assertNotAborted(stage) {
  if (state.abort) throw new StageError(stage, "aborted by the operator");
}

async function runInstall({ dryRun = false } = {}) {
  if (state.running) return;
  state.abort = false;
  state.stageProgress = {};
  setRunning(true);
  terminal.phase(1, STAGES.length, dryRun ? "rehearsal: no writes" : "browser one-shot install");
  terminal.info(`release ${state.release?.tag ?? "(none)"} · repository ${config.repository}`);
  if (config.mirrorBase) terminal.info(`asset mirror: ${config.mirrorBase}`);
  else terminal.warn("no CORS-capable asset mirror configured: payload bytes must come from your own download");

  try {
    const release = state.release;
    if (!release) throw new StageError("release", "no release selected");

    if (!state.sums) {
      currentStage("release");
      const inventory = await verifyReleaseInventory({
        tag: release.tag,
        repository: config.repository,
        mirrorBase: config.mirrorBase,
        terminal,
      });
      state.sums = inventory.sums;
    } else {
      terminal.ok(`using the ${state.sums.size}-entry inventory parsed from the supplied SHA256SUMS`);
    }
    state.stageProgress.release = "done";
    assertNotAborted("release");

    if (!state.identity) {
      currentStage("device");
      await connectFastboot();
    }
    state.stageProgress.device = "done";
    assertNotAborted("device");

    const assessment = assessIdentity(state.identity, terminal);
    state.stageProgress.identity = "done";

    if (!assessment.unlocked) {
      currentStage("unlock");
      const outcome = await submitUnlockPayload({
        client: state.fastboot.client,
        profile: state.identity.profile,
        lkBuild: state.identity.lkBuild,
        payloadBytes: state.payloadBytes,
        terminal,
      });
      state.stageProgress.unlock = "done";
      if (outcome.outcome === "unknown") {
        terminal.warn("stopping here on purpose: an unknown unlock outcome must not be retried automatically");
        terminal.info("watch the device. If it lands in recovery, press 'Find recovery over ADB' and continue from there.");
        setRunning(false);
        return;
      }
    } else {
      terminal.ok("device is already unlocked; skipping the unlock stage");
      state.stageProgress.unlock = "skipped";
    }
    assertNotAborted("unlock");

    currentStage("recovery");
    const recovery = await waitForRecovery({ terminal });
    state.adb = recovery.client;
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

    currentStage(dryRun ? "prepare" : "prepare");
    const first = await runRecoveryPhase({ adb: state.adb, tag: release.tag, dryRun, terminal });
    state.receipts.push(first);
    if (dryRun) {
      terminal.ok("rehearsal complete; nothing was written to the device");
      state.stageProgress.prepare = "done";
      setRunning(false);
      return;
    }
    if (first.reboot_required === "1") {
      terminal.info("the installer reshaped userdata and needs a reboot before it can install");
      state.stageProgress.prepare = "done";
      currentStage("install");
      await rebootAndWait({ adb: state.adb, target: "recovery", terminal });
      const next = await waitForRecovery({ terminal });
      state.adb = next.client;
      const second = await runRecoveryPhase({ adb: state.adb, tag: release.tag, terminal });
      state.receipts.push(second);
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
    terminal.ok("install complete: reboot requested. LibreEcho should come up and serve its control centre.");
    terminal.info("if the device does not come back, hold the documented recovery route rather than re-running the installer");
    state.stageProgress.verify = "done";
  } catch (error) {
    const stage = error instanceof StageError ? error.stage : "unknown";
    terminal.error(`${stage} stage failed: ${error.message}`);
    if (error.detail) terminal.line(String(error.detail));
    terminal.info("nothing further was attempted. Fix the reported condition and re-run; each stage re-checks what it needs.");
  } finally {
    setRunning(false);
    renderStepList(null);
  }
}

// --- wiring ----------------------------------------------------------------

dom.buttons.refresh?.addEventListener("click", () => loadReleases().catch((error) => terminal.error(error.message)));
dom.releaseSelect?.addEventListener("change", () => {
  state.sums = null;
  state.release = state.releases.find((release) => release.tag === dom.releaseSelect.value) ?? state.release;
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
  connectFastboot().catch((error) => terminal.error(`device connection failed: ${error.message}`));
});
dom.buttons.recovery?.addEventListener("click", () => {
  findRecovery().catch((error) => terminal.error(`recovery connection failed: ${error.message}`));
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
renderStepList(null);
reportCapabilities()
  .then(({ support }) => {
    if (support.ok) loadReleases();
  })
  .catch((error) => terminal.error(`capability check failed: ${error.message}`));
