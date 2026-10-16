// After the install reboots the Echo: find LibreEcho's own ADB, confirm it is
// the same device and that it actually started, and report the setup state.
//
// Read-only except for `sendSetupToRunningEcho`, which delivers the same
// one-shot provision document the install path writes, then restarts only the
// web daemon so it applies the file. No partition, boot slot or userdata
// layout is touched from here.

import { StageError } from "./stages.js";
import { deliverProvision, PROVISION_DIR } from "./provision.js";

/** LibreEcho's running-image adbd, as measured on the Dot: 18d1:d001. */
export const RUNNING_ADB_FILTERS = Object.freeze([{ vendorId: 0x18d1, productId: 0xd001 }]);

/**
 * One shell round trip. Every value is printed as `key=value` on its own line so
 * the parser cannot be confused by output it does not expect. Nothing secret is
 * read: provision.result holds status codes only, and the setup marker is a
 * presence test.
 */
export const BOOT_PROBE_COMMAND = [
  "echo serial=$(tr ' ' '\\n' < /proc/cmdline | sed -n 's/^androidboot.serialno=//p')",
  "echo ready=$(test -e /run/libreecho/startup-ready && echo 1 || echo 0)",
  "echo web=$(test -S /run/libreecho/network.sock && pidof libreecho-web >/dev/null && echo 1 || echo 0)",
  `echo setup=$(test -e ${PROVISION_DIR}/web-config.json.setup-complete && echo 1 || echo 0)`,
  `echo pending=$(test -e ${PROVISION_DIR}/provision.json && echo 1 || echo 0)`,
  `sed -n 's/^\\(result\\|error\\|wifi\\)=/provision_\\1=/p' ${PROVISION_DIR}/provision.result 2>/dev/null`,
  "echo ip=$(ip -4 -o addr show wlan0 2>/dev/null | sed -n 's/.* inet \\([0-9.]*\\)\\/.*/\\1/p' | head -n 1)",
].join("; ");

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const CODE = /^[a-z0-9-]{1,40}$/;

/** Parses BOOT_PROBE_COMMAND output. Unknown or malformed values are dropped. */
export function parseBootProbe(stdout) {
  const fields = new Map();
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const match = /^([a-z_]+)=(.*)$/.exec(raw.trim());
    if (match && !fields.has(match[1])) fields.set(match[1], match[2].trim());
  }
  const flag = (name) => fields.get(name) === "1";
  const code = (name) => (CODE.test(fields.get(name) ?? "") ? fields.get(name) : null);
  const ip = fields.get("ip") ?? "";
  return {
    serial: fields.get("serial") ?? "",
    ready: flag("ready"),
    web: flag("web"),
    setupComplete: flag("setup"),
    provisionPending: flag("pending"),
    provision: code("provision_result")
      ? { result: code("provision_result"), error: code("provision_error"), wifi: code("provision_wifi") }
      : null,
    ip: IPV4.test(ip) && !ip.startsWith("127.") ? ip : null,
  };
}

/**
 * What the page should do next, from one probe. Pure, so the decision table is
 * tested directly.
 *  - booting:       LibreEcho is not up yet; keep waiting.
 *  - applying:      a provision file is still pending or Wi-Fi is associating.
 *  - done:          set up and on the network; open its page.
 *  - needs-setup:   running, never set up; ask for the settings here.
 *  - setup-failed:  the device refused or could not apply the settings.
 */
export function classifyBoot(probe, { expectProvision = false } = {}) {
  if (!probe?.ready || !probe.web) return { state: "booting" };
  if (probe.provisionPending) return { state: "applying" };
  const result = probe.provision?.result ?? null;
  if (probe.setupComplete) return probe.ip ? { state: "done", ip: probe.ip } : { state: "applying" };
  if (result === "applied") return probe.ip ? { state: "done", ip: probe.ip } : { state: "applying" };
  if (result && result !== "applied") {
    return { state: "setup-failed", error: probe.provision.error ?? result, wifi: probe.provision.wifi };
  }
  // No result yet while the daemon is still waiting for its own association.
  if (expectProvision) return { state: "applying" };
  return { state: "needs-setup" };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls one open client until `classifyBoot` leaves `booting`/`applying`, or the
 * deadline passes. A transport error is returned to the caller (the device may
 * have restarted again); the caller re-opens and calls this again.
 */
export async function pollRunningEcho({ client, expectedSerial, expectProvision = false,
  timeoutMs = 360000, intervalMs = 3000, now = Date.now, sleep = delay, isCancelled = () => false,
  onProbe = () => {} } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (isCancelled()) throw new StageError("verify", "stopped");
    const probe = parseBootProbe((await client.shell(BOOT_PROBE_COMMAND))?.stdout);
    if (expectedSerial && probe.serial && probe.serial !== expectedSerial) {
      throw new StageError("verify", "a different Echo answered; reconnect the one that was just installed");
    }
    const verdict = classifyBoot(probe, { expectProvision });
    onProbe(probe, verdict);
    if (verdict.state !== "booting" && verdict.state !== "applying") return { probe, verdict };
    if (now() >= deadline) return { probe, verdict: { state: "timeout", last: verdict.state } };
    await sleep(intervalMs);
  }
}

/**
 * Delivers the setup form to a RUNNING LibreEcho (no recovery needed) and asks
 * only the web daemon to restart so its existing first-boot path applies it.
 * The device refuses it by itself if setup was already completed.
 */
export async function sendSetupToRunningEcho({ client, form, release, target, terminal, isCancelled } = {}) {
  const delivered = await deliverProvision({ adb: client, form, release, target, terminal, isCancelled });
  terminal?.command("/etc/init.d/libreecho-web.init restart");
  try {
    await client.shell("/etc/init.d/libreecho-web.init restart >/dev/null 2>&1 </dev/null");
  } catch (error) {
    throw new StageError("configure", `the settings were delivered but the setup service did not restart (${error.message})`);
  }
  return delivered;
}
