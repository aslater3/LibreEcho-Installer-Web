// Device discovery and USB-mode classification for the browser installer.
//
// The Echo family exposes a different USB identity in each mode the installer
// has to cross. WebUSB can claim the vendor-specific fastboot interface and the
// CDC-ACM interface the boot ROM and preloader use; it cannot claim the
// mass-storage interface, which is why nothing here depends on one.

export const MODES = {
  // Identities measured on real hardware are marked [measured]; the rest come
  // from the platform documentation. Note that these devices report
  // bDeviceClass 0 (classing is per-interface), so a WebUSB `classCode` filter
  // never matches them — an unfiltered chooser is the fallback, not a
  // class-based filter.
  brom: {
    id: "brom",
    label: "Boot ROM (BROM)",
    detail: "MediaTek boot ROM. Reached with the eMMC short (or a cleared preloader header).",
    filters: [{ vendorId: 0x0e8d, productId: 0x0003 }],
  },
  preloader: {
    id: "preloader",
    label: "Preloader USB download",
    detail:
      "The preloader awaiting a download-agent handshake. [measured] It presents a CDC-ACM pair with the product string \"Failed to load LK\" when the boot chain fell back to download mode.",
    filters: [{ vendorId: 0x0e8d, productId: 0x2000 }],
  },
  fastboot: {
    id: "fastboot",
    label: "Fastboot",
    detail: "Android/MediaTek fastboot. This is where the no-short install starts.",
    filters: [
      // [measured] The identity this platform's fastboot has been observed to
      // present: 0bb4:0c01 (HTC's vendor id, used by several MTK bootloaders).
      { vendorId: 0x0bb4, productId: 0x0c01 },
      { vendorId: 0x18d1, productId: 0x4ee0 },
      { vendorId: 0x18d1, productId: 0x4ee1 },
      { vendorId: 0x18d1, productId: 0x4ee2 },
      { vendorId: 0x18d1, productId: 0x4ee3 },
      { vendorId: 0x18d1, productId: 0x4ee4 },
      { vendorId: 0x18d1, productId: 0x4ee5 },
      { vendorId: 0x18d1, productId: 0x4ee6 },
      { vendorId: 0x18d1, productId: 0x4ee7 },
      { vendorId: 0x18d1, productId: 0xd00d },
      { vendorId: 0x0e8d, productId: 0x201c },
      { vendorId: 0x0e8d, productId: 0x2001 },
    ],
  },
  adb: {
    id: "adb",
    label: "ADB (TWRP recovery or the installed image)",
    detail: "Used to push the bundle, drive the recovery installer and read receipts.",
    filters: [
      // [measured] LibreEcho's own adbd on the running image: 18d1:d001 with the
      // interface at class 0xFF subclass 0x42 protocol 0x01.
      { vendorId: 0x18d1, productId: 0xd001 },
      { vendorId: 0x18d1, productId: 0xd00d },
      { vendorId: 0x18d1, productId: 0x4ee0 },
      { vendorId: 0x18d1, productId: 0x4ee1 },
      { vendorId: 0x18d1, productId: 0x4ee2 },
      { vendorId: 0x18d1, productId: 0x4ee3 },
      { vendorId: 0x18d1, productId: 0x4ee4 },
      { vendorId: 0x18d1, productId: 0x4ee5 },
      { vendorId: 0x18d1, productId: 0x4ee6 },
      { vendorId: 0x18d1, productId: 0x4ee7 },
      { vendorId: 0x0e8d, productId: 0x201d },
    ],
  },
};

/** Unfiltered chooser: every USB device the machine exposes. */
export const NO_FILTERS = [];


export function webusbSupport() {
  if (typeof navigator === "undefined" || !navigator.usb) {
    return {
      ok: false,
      secure: typeof window !== "undefined" ? window.isSecureContext : false,
      reason:
        "This browser exposes no WebUSB API. Use a desktop Chromium browser (Chrome, Edge, Brave, Opera) over HTTPS.",
    };
  }
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return { ok: false, secure: false, reason: "WebUSB needs a secure context (HTTPS or localhost)." };
  }
  return { ok: true, secure: true, reason: "" };
}

export function describeUsbDevice(device) {
  const vid = device.vendorId.toString(16).padStart(4, "0");
  const pid = device.productId.toString(16).padStart(4, "0");
  const name = [device.manufacturerName, device.productName].filter(Boolean).join(" ");
  return `${name ? `${name} — ` : ""}${vid}:${pid}`;
}

/**
 * Classifies a device from its descriptors. The vendor interface is what
 * matters: fastboot and adb both use class 0xFF with two bulk endpoints, so the
 * caller confirms the mode by protocol probe (getvar vs CNXN) rather than
 * trusting the descriptors alone.
 */
export function classifyDevice(device) {
  const interfaces = [];
  for (const configuration of device.configurations ?? []) {
    for (const iface of configuration.interfaces ?? []) {
      for (const alternate of iface.alternates ?? []) {
        interfaces.push({ interfaceNumber: iface.interfaceNumber, ...alternate });
      }
    }
  }
  const vendor = interfaces.find((iface) => iface.interfaceClass === 0xff);
  const cdc = interfaces.find((iface) => iface.interfaceClass === 0x0a);
  const bulk = interfaces.filter((iface) =>
    (iface.endpoints ?? []).some((endpoint) => endpoint.type === "bulk"),
  );
  let mode = "unknown";
  if (cdc && !vendor) mode = "brom";
  else if (vendor) mode = "vendor-bulk";
  return { interfaces, vendor, cdc, bulk, mode };
}

/** Never surfaces a device serial in the UI or a log; only a stable short tag. */
export function maskSerial(serial) {
  if (!serial) return "unknown";
  const text = String(serial).trim();
  if (text.length <= 4) return "••••";
  return `••••${text.slice(-4)}`;
}

export async function requestDevice(mode) {
  const support = webusbSupport();
  if (!support.ok) throw new Error(support.reason);
  const table = MODES[mode] ?? MODES.fastboot;
  return navigator.usb.requestDevice({ filters: table.filters });
}

export async function pairedDevices() {
  if (typeof navigator === "undefined" || !navigator.usb) return [];
  return navigator.usb.getDevices();
}
