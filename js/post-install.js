// After the install reboots the Echo: find LibreEcho's own ADB, confirm it is
// the same device and that it actually started, and say what to do next.
//
// Read-only. One shell round trip per probe; nothing is written, restarted or
// rebooted from here. Ported from the post-install half of #15, without the
// in-page provisioning.

import { StageError } from "./stages.js";

/** LibreEcho's running-image adbd (ro.adb.secure=0, no AUTH): 18d1:d001. */
export const RUNNING_ADB_FILTERS = Object.freeze([{ vendorId: 0x18d1, productId: 0xd001 }]);

/** The device's setup-complete marker sits next to its web config. */
export const SETUP_MARKER = "/data/libreecho/config/web-config.json.setup-complete";

/** Where the host-side forward points; mirrors the CLI installer and guide step 5. */
export const SETUP_LOCAL_PORT = 18080;
export const SETUP_URL = `http://127.0.0.1:${SETUP_LOCAL_PORT}/setup.html`;
export const SETUP_GUIDE_URL = "https://github.com/aslater3/LibreEcho/blob/main/docs/install/README.md#5-first-boot-and-setup";
/** The two host commands that open the setup page, exactly as the guide gives them. */
export const SETUP_COMMANDS = Object.freeze([
  "adb wait-for-device",
  `adb forward tcp:${SETUP_LOCAL_PORT} tcp:8080`,
]);

/**
 * Every value is printed as `key=value` on its own line so the parser cannot be
 * confused by output it does not expect. Presence tests only; no file body is read.
 */
export const BOOT_PROBE_COMMAND = [
  "echo serial=$(tr ' ' '\\n' < /proc/cmdline | sed -n 's/^androidboot.serialno=//p')",
  "echo ready=$(test -e /run/libreecho/startup-ready && echo 1 || echo 0)",
  "echo web=$(test -S /run/libreecho/network.sock && pidof libreecho-web >/dev/null && echo 1 || echo 0)",
  `echo setup=$(test -e ${SETUP_MARKER} && echo 1 || echo 0)`,
  "echo ip=$(ip -4 -o addr show wlan0 2>/dev/null | sed -n 's/.* inet \\([0-9.]*\\)\\/.*/\\1/p' | head -n 1)",
].join("; ");

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** Parses BOOT_PROBE_COMMAND output. Unknown or malformed values are dropped. */
export function parseBootProbe(stdout) {
  const fields = new Map();
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const match = /^([a-z_]+)=(.*)$/.exec(raw.trim());
    if (match && !fields.has(match[1])) fields.set(match[1], match[2].trim());
  }
  const flag = (name) => fields.get(name) === "1";
  const ip = fields.get("ip") ?? "";
  return {
    serial: fields.get("serial") ?? "",
    ready: flag("ready"),
    web: flag("web"),
    setupComplete: flag("setup"),
    ip: IPV4.test(ip) && !ip.startsWith("127.") ? ip : null,
  };
}

/**
 * What the page should say next, from one probe. Pure, so the table is tested directly.
 *  - booting:      LibreEcho is not up yet; keep waiting.
 *  - needs-setup:  running and never set up (every fresh install); open setup.
 *  - done:         set up and on the network; open its page.
 *  - offline:      set up, but not on Wi-Fi yet.
 */
export function classifyBoot(probe) {
  if (!probe?.ready || !probe.web) return { state: "booting" };
  if (!probe.setupComplete) return { state: "needs-setup" };
  return probe.ip ? { state: "done", ip: probe.ip } : { state: "offline" };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls one open client until `classifyBoot` leaves `booting`, or the deadline
 * passes. A transport error propagates: the device may have restarted again.
 */
export async function pollRunningEcho({ client, expectedSerial, timeoutMs = 360000, intervalMs = 3000,
  now = Date.now, sleep = delay, isCancelled = () => false, onProbe = () => {} } = {}) {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (isCancelled()) throw new StageError("verify", "stopped");
    const probe = parseBootProbe((await client.shell(BOOT_PROBE_COMMAND))?.stdout);
    if (expectedSerial && probe.serial && probe.serial !== expectedSerial) {
      throw new StageError("verify", "a different Echo answered; reconnect the one that was just installed");
    }
    const verdict = classifyBoot(probe);
    onProbe(probe, verdict);
    if (verdict.state !== "booting") return { probe, verdict };
    if (now() >= deadline) return { probe, verdict: { state: "timeout", last: verdict.state } };
    await sleep(intervalMs);
  }
}
