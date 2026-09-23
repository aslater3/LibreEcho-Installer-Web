// Transport adapter.
//
// The protocol implementations live in ./lib (fastboot.js, adb.js and their
// WebUSB transports). This module is the single place that knows their export
// shape, so a change there touches one file here and nothing in the stage code.
//
// Actual APIs (see ./lib/*/README.md):
//   fastboot.js                  FastbootClient(transport, options), createFastbootClient
//   webusb-fastboot-transport.js UsbFastbootTransport.open(filter) / .fromDevice(device) /
//                                .requestDevice(filter) / .findPairedDevice(filter)
//   adb.js                       AdbClient(transport, options) with connect/shell/push/…
//   webusb-adb-transport.js      WebUsbAdbTransport.requestDevice({filters}) /
//                                .attachExisting({filters}) / new + open()

import { MODES, webusbSupport } from "./device.js";

const FASTBOOT_MODULE = "../lib/fastboot/fastboot.js";
const FASTBOOT_TRANSPORT = "../lib/fastboot/webusb-fastboot-transport.js";
const ADB_MODULE = "../lib/adb/adb.js";
const ADB_TRANSPORT = "../lib/adb/webusb-adb-transport.js";

/** WebUSB filters for the fastboot transport, derived from the mode table. */
export function fastbootFilters(mode = "fastboot") {
  return (MODES[mode] ?? MODES.fastboot).filters.map((filter) => ({ ...filter }));
}

function adbFilters() {
  // The transport requires a vendorId in every filter, so only vendor-keyed
  // entries are usable there.
  return MODES.adb.filters.filter((filter) => typeof filter.vendorId === "number");
}

/**
 * Prompts for any USB device, with no filter list.
 *
 * The fastboot transport's own helper rejects an empty filter array, and a
 * classCode filter cannot help here: these devices report bDeviceClass 0, so
 * class-based filters never match them. Asking WebUSB for an unfiltered chooser
 * is the only way to see an identity that is not already in the table above.
 */
export async function promptAnyDevice({ onLog } = {}) {
  const support = webusbSupport();
  if (!support.ok) throw new Error(support.reason);
  const device = await navigator.usb.requestDevice({ filters: [] });
  if (onLog) onLog(`unfiltered chooser returned ${device.vendorId}:${device.productId}${device.productName ? ` (${device.productName})` : ""}`);
  return device;
}

async function importOrNull(path) {
  try {
    return await import(path);
  } catch (error) {
    return { __error: error };
  }
}

function resolveExport(module, names, path) {
  if (module?.__error) {
    return { ok: false, reason: `${path} failed to load: ${module.__error.message}` };
  }
  for (const name of names) {
    if (module[name]) return { ok: true, value: module[name], name };
  }
  return { ok: false, reason: `${path} exports none of: ${names.join(", ")}` };
}

export async function protocolSupport() {
  const fastboot = await importOrNull(FASTBOOT_MODULE);
  const fastbootTransport = await importOrNull(FASTBOOT_TRANSPORT);
  const adb = await importOrNull(ADB_MODULE);
  const adbTransport = await importOrNull(ADB_TRANSPORT);
  return {
    fastboot: resolveExport(fastboot, ["FastbootClient"], FASTBOOT_MODULE),
    fastbootTransport: resolveExport(
      fastbootTransport,
      ["UsbFastbootTransport", "WebUsbFastbootTransport"],
      FASTBOOT_TRANSPORT,
    ),
    adb: resolveExport(adb, ["AdbClient"], ADB_MODULE),
    adbTransport: resolveExport(adbTransport, ["WebUsbAdbTransport"], ADB_TRANSPORT),
  };
}

/**
 * Opens a fastboot session. Without a device the transport prompts the operator
 * through the browser's own device chooser; with one it attaches directly.
 * `any: true` uses an unfiltered chooser, for an identity not in the table.
 */
export async function openFastboot({ device = null, onLog, any = false } = {}) {
  const support = await protocolSupport();
  if (!support.fastboot.ok) throw new Error(support.fastboot.reason);
  if (!support.fastbootTransport.ok) throw new Error(support.fastbootTransport.reason);
  const TransportClass = support.fastbootTransport.value;
  let transport;
  if (device) {
    transport = await TransportClass.fromDevice(device);
  } else if (any) {
    const chosen = await promptAnyDevice({ onLog });
    transport = await TransportClass.fromDevice(chosen);
  } else {
    transport = await TransportClass.open(fastbootFilters("fastboot"));
  }
  const client = new support.fastboot.value(transport, {
    onInfo: (line) => onLog && onLog(`fastboot: ${line}`),
  });
  if (onLog) onLog(`fastboot interface claimed on ${transport.device?.vendorId ?? "?"}:${transport.device?.productId ?? "?"}`);
  return { device: transport.device ?? device, transport, client };
}

/** Opens an ADB session, prompting for the device when one is not supplied. */
export async function openAdb({ device = null, onLog, any = false } = {}) {
  const support = await protocolSupport();
  if (!support.adb.ok) throw new Error(support.adb.reason);
  if (!support.adbTransport.ok) throw new Error(support.adbTransport.reason);
  const TransportClass = support.adbTransport.value;
  let transport;
  if (device) {
    transport = await new TransportClass(device, {}).open();
  } else if (any) {
    const chosen = await promptAnyDevice({ onLog });
    transport = await new TransportClass(chosen, {}).open();
  } else {
    transport = await TransportClass.requestDevice({ filters: adbFilters() });
  }
  const client = new support.adb.value(transport);
  const info = await client.connect({ banner: "host::libreecho-browser-installer" });
  if (onLog) {
    onLog(`adb interface claimed on ${transport.device?.vendorId ?? "?"}:${transport.device?.productId ?? "?"}`);
    if (info?.deviceBanner) onLog(`device banner: ${info.deviceBanner}`);
  }
  return { device: transport.device ?? device, transport, client, info };
}

/**
 * Re-attaches to a device the origin already has permission for, without a
 * chooser. Used after a reboot, when the device re-enumerates in another mode.
 */
export async function reattachAdb({ timeoutMs = 120000, onLog } = {}) {
  const support = await protocolSupport();
  if (!support.adbTransport.ok) throw new Error(support.adbTransport.reason);
  const TransportClass = support.adbTransport.value;
  const filters = adbFilters();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    try {
      const granted = await TransportClass.getDevices({ filters });
      if (granted.length > 0) {
        const transport = await new TransportClass(granted[0], {}).open();
        const client = new support.adb.value(transport);
        await client.connect({ banner: "host::libreecho-browser-installer" });
        if (onLog) onLog(`re-attached to adb device ${granted[0].vendorId}:${granted[0].productId}`);
        return { device: granted[0], transport, client };
      }
    } catch (error) {
      if (onLog) onLog(`re-attach attempt ${attempt}: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  throw new Error("the device did not re-appear in ADB mode with its existing permission");
}
