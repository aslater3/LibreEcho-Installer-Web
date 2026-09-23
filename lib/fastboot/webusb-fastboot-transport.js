/**
 * @file webusb-fastboot-transport.js
 * @summary Chromium WebUSB transport for the Fastboot protocol in fastboot.js.
 *
 * Implements the byte-pipe interface `FastbootClient` needs on top of
 * `navigator.usb` (WebUSB). Nothing in fastboot.js imports this file, so the
 * protocol layer keeps working in Node and can be pointed at any other
 * transport (USB serial, a proxy, a fake in tests).
 *
 * Hard requirements from the WebUSB specification / Chromium:
 *   - desktop Chromium based browser (Chrome, Edge, Brave, Opera) with WebUSB;
 *   - a secure context: https:// or http://localhost (a GitHub Pages site
 *     qualifies);
 *   - `requestDevice()` must be called from a user gesture (a click handler);
 *   - the device must be closed in every other program (adb, fastboot,
 *     Mass Storage, another tab) or `claimInterface()` fails with
 *     "Access denied".
 *
 * Typical use:
 *   import { UsbFastbootTransport } from './webusb-fastboot-transport.js';
 *   import { FastbootClient } from './fastboot.js';
 *
 *   button.addEventListener('click', async () => {
 *     const transport = await UsbFastbootTransport.open(); // shows the picker
 *     const fastboot = new FastbootClient(transport, { timeout: 15000 });
 *     try {
 *       console.log(await fastboot.getVar('product'));
 *     } finally {
 *       await transport.close();
 *     }
 *   });
 */

import { Transport } from './fastboot.js';

/* ─────────────────────────── USB identities ─────────────────────────── */

/** Google / Android: fastboot devices use product IDs 0x4ee0-0x4ee7. */
export const ANDROID_FASTBOOT_VENDOR_ID = 0x18d1;
/** The classic Android fastboot product ID range. */
export const ANDROID_FASTBOOT_PRODUCT_IDS = Object.freeze([
  0x4ee0, 0x4ee1, 0x4ee2, 0x4ee3, 0x4ee4, 0x4ee5, 0x4ee6, 0x4ee7,
]);
/** MediaTek (MT8163 / Amazon Echo) vendor ID. */
export const MEDIATEK_VENDOR_ID = 0x0e8d;
/** USB interface class used by fastboot: vendor specific. */
export const VENDOR_SPECIFIC_CLASS = 0xff;

/**
 * Default `requestDevice()` filters: the Android fastboot identity, the
 * vendor specific interface class (0xFF) that the Echo/MT8163 target exposes,
 * and the MediaTek vendor. Pass your own filters to `open()` to override.
 */
export const DEFAULT_FASTBOOT_FILTERS = Object.freeze([
  { vendorId: ANDROID_FASTBOOT_VENDOR_ID },
  { classCode: VENDOR_SPECIFIC_CLASS },
  { vendorId: MEDIATEK_VENDOR_ID, classCode: VENDOR_SPECIFIC_CLASS },
]);

/**
 * Explicit filter for every Android fastboot product ID.
 * @returns {Array<{vendorId: number, productId: number}>}
 */
export function androidFastbootFilters() {
  return ANDROID_FASTBOOT_PRODUCT_IDS.map((productId) => ({
    vendorId: ANDROID_FASTBOOT_VENDOR_ID,
    productId,
  }));
}

/* ───────────────────────────── helpers ─────────────────────────────── */

const DEFAULT_PACKET_SIZE = 64;
const DEFAULT_OUT_PACKET_SIZE = 512;
const DEFAULT_FLUSH_TIMEOUT_MS = 30;
const DEFAULT_FLUSH_READS = 16;

/** Bulk packet sizes come from the endpoint descriptor; never trust a zero. */
function packetSizeOf(value, fallback) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : fallback;
}

const UNSUPPORTED_MESSAGE =
  'WebUSB is not available: navigator.usb is missing. Use a desktop Chromium based browser '
  + '(Chrome/Edge/Brave, version 61+) over https:// or http://localhost.';

/** @returns {any} the WebUSB manager, or throws with a readable message */
function usbManager() {
  const usb = globalThis.navigator && globalThis.navigator.usb;
  if (usb) return usb;
  throw new Error(UNSUPPORTED_MESSAGE);
}

/**
 * Accept a single filter object, an array of filters, or nothing (defaults).
 * @param {object|object[]|null|undefined} filter
 * @returns {object[]}
 */
function normalizeFilters(filter) {
  if (filter === undefined || filter === null) return [...DEFAULT_FASTBOOT_FILTERS];
  if (Array.isArray(filter)) {
    if (filter.length === 0) throw new TypeError('WebUsbFastbootTransport: the filter array is empty');
    return filter;
  }
  if (typeof filter === 'object') return [filter];
  throw new TypeError('WebUsbFastbootTransport: filter must be an object or an array of objects');
}

/**
 * Does a granted USBDevice match at least one WebUSB filter?
 * @param {any} device
 * @param {object[]} filters
 * @returns {boolean}
 */
export function deviceMatchesFilters(device, filters) {
  return normalizeFilters(filters).some((f) => {
    if (f.vendorId !== undefined && device.vendorId !== f.vendorId) return false;
    if (f.productId !== undefined && device.productId !== f.productId) return false;
    if (f.classCode !== undefined) {
      const interfaces = device.configuration?.interfaces ?? [];
      const matchesInterface = interfaces.some((iface) =>
        (iface.alternates ?? []).some((alt) => alt.interfaceClass === f.classCode));
      const matchesDevice = device.deviceClass === f.classCode;
      if (!matchesInterface && !matchesDevice) return false;
    }
    if (f.subclassCode !== undefined && device.deviceSubclass !== f.subclassCode) return false;
    if (f.protocolCode !== undefined && device.deviceProtocol !== f.protocolCode) return false;
    return true;
  });
}

/**
 * Find the interface/alternate exposing a bulk IN/OUT pair, preferring
 * vendor specific (0xFF) interfaces and already selected alternates.
 * @param {any} device
 * @returns {null|{interfaceNumber: number, alternateSetting: number, interfaceClass: number, active: boolean, inEndpoint: any, outEndpoint: any}}
 */
export function findFastbootInterface(device) {
  const configuration = device?.configuration;
  if (!configuration) return null;
  let best = null;
  for (const iface of configuration.interfaces ?? []) {
    for (const alternate of iface.alternates ?? []) {
      const endpoints = alternate.endpoints ?? [];
      const outEndpoint = endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      const inEndpoint = endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
      if (!outEndpoint || !inEndpoint) continue;
      const active = iface.alternate ? iface.alternate === alternate : alternate.alternateSetting === 0;
      const score = (alternate.interfaceClass === VENDOR_SPECIFIC_CLASS ? 4 : 0) + (active ? 2 : 0);
      if (!best || score > best.score) {
        best = {
          score,
          interfaceNumber: iface.interfaceNumber,
          alternateSetting: alternate.alternateSetting,
          interfaceClass: alternate.interfaceClass,
          active,
          inEndpoint,
          outEndpoint,
        };
      }
    }
  }
  return best;
}

/**
 * Race a promise against a timer without cancelling the underlying operation.
 * @param {Promise<any>} promise
 * @param {number} ms
 * @returns {Promise<{timedOut?: boolean, value?: any, error?: unknown}>}
 */
function raceWithTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, Math.floor(ms)));
  });
  const settled = promise.then((value) => ({ value }), (error) => ({ error }));
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

/* ──────────────────────────── transport ────────────────────────────── */

/**
 * WebUSB transport for Fastboot. Subclasses {@link Transport} and is passed
 * straight to `new FastbootClient(transport)`.
 *
 * Prefer the static helpers: `UsbFastbootTransport.open(filter)` for a fresh
 * session (shows the chooser) and
 * `UsbFastbootTransport.open(filter, { preferPaired: true })` to re-attach to
 * a device the page was already granted (`navigator.usb.getDevices()`), which
 * needs no user gesture.
 */
export class UsbFastbootTransport extends Transport {
  /**
   * @param {any} device an opened USBDevice (created by the static helpers)
   * @param {{interfaceNumber: number, alternateSetting: number, interfaceClass: number, active: boolean, inEndpoint: any, outEndpoint: any}} picked
   * @param {{timeout?: number, outPacketSize?: number, inPacketSize?: number, flushTimeout?: number}} [options]
   */
  constructor(device, picked, options = {}) {
    super();
    this.device = device;
    this.interfaceNumber = picked.interfaceNumber;
    this.alternateSetting = picked.alternateSetting;
    this.interfaceClass = picked.interfaceClass;
    this.inEndpointNumber = picked.inEndpoint.endpointNumber;
    this.outEndpointNumber = picked.outEndpoint.endpointNumber;
    this.inPacketSize = packetSizeOf(options.inPacketSize ?? picked.inEndpoint.packetSize, DEFAULT_PACKET_SIZE);
    this.outPacketSize = packetSizeOf(options.outPacketSize ?? picked.outEndpoint.packetSize, DEFAULT_OUT_PACKET_SIZE);
    this.timeoutMs = options.timeout ?? 5000;
    this.flushTimeoutMs = options.flushTimeout ?? DEFAULT_FLUSH_TIMEOUT_MS;
    this._pendingRead = null;
    this._closed = false;
  }

  /* ── static helpers ─────────────────────────────────────────────────── */

  /** @returns {boolean} true when this browser exposes WebUSB */
  static isSupported() {
    return Boolean(globalThis.navigator && globalThis.navigator.usb);
  }

  /** @returns {any} the WebUSB manager */
  static get usb() {
    return usbManager();
  }

  /**
   * Find an already granted device (no chooser, no user gesture needed).
   * @param {object|object[]|null} [filter] WebUSB filters, defaults to DEFAULT_FASTBOOT_FILTERS
   * @returns {Promise<any|null>}
   */
  static async findPairedDevice(filter = null) {
    const usb = usbManager();
    const filters = normalizeFilters(filter);
    const granted = await usb.getDevices();
    return granted.find((device) => deviceMatchesFilters(device, filters)) ?? null;
  }

  /**
   * Show the browser device chooser for a new fastboot device.
   * Must be called from a user gesture (a click) or Chromium rejects it.
   * @param {object|object[]|null} [filter] WebUSB filters, defaults to DEFAULT_FASTBOOT_FILTERS
   * @returns {Promise<any>} the chosen USBDevice
   */
  static async requestDevice(filter = null) {
    const filters = normalizeFilters(filter); // validate the filters before touching WebUSB
    const usb = usbManager();
    return usb.requestDevice({ filters });
  }

  /**
   * Open (and claim) a fastboot device and return a ready transport.
   * @param {object|object[]|null} [filter] WebUSB filters, e.g. `{vendorId: 0x18d1}`
   * @param {{preferPaired?: boolean, timeout?: number, outPacketSize?: number, inPacketSize?: number}} [options]
   *   `preferPaired: true` reuses a device granted in an earlier session and
   *   only falls back to the chooser when none matches.
   * @returns {Promise<UsbFastbootTransport>}
   */
  static async open(filter = null, options = {}) {
    if (options.preferPaired) {
      const paired = await UsbFastbootTransport.findPairedDevice(filter);
      if (paired) return UsbFastbootTransport.fromDevice(paired, options);
    }
    const device = await UsbFastbootTransport.requestDevice(filter);
    return UsbFastbootTransport.fromDevice(device, options);
  }

  /**
   * Wrap an already obtained USBDevice: open it, select the configuration,
   * claim the fastboot interface and locate the bulk endpoints.
   * @param {any} device
   * @param {{timeout?: number, outPacketSize?: number, inPacketSize?: number}} [options]
   * @returns {Promise<UsbFastbootTransport>}
   */
  static async fromDevice(device, options = {}) {
    if (!device || typeof device.open !== 'function') {
      throw new TypeError('WebUsbFastbootTransport: a USBDevice is required');
    }
    if (!device.opened) {
      try {
        await device.open();
      } catch (err) {
        throw new Error(`WebUSB: could not open the device (${err?.message ?? err}). Unplug and replug it, then retry.`);
      }
    }
    if (!device.configuration) {
      try {
        await device.selectConfiguration(1);
      } catch (err) {
        throw new Error(`WebUSB: could not select configuration 1 (${err?.message ?? err}).`);
      }
    }
    const picked = findFastbootInterface(device);
    if (!picked) {
      throw new Error(
        'WebUSB: this device exposes no bulk IN/OUT endpoint pair. Is it really in fastboot mode? '
        + '(fastboot devices use a vendor specific interface, class 0xFF.)',
      );
    }
    if (!picked.active) {
      try {
        await device.selectAlternateInterface(picked.interfaceNumber, picked.alternateSetting);
      } catch (err) {
        throw new Error(
          `WebUSB: could not select alternate setting ${picked.alternateSetting} of interface `
          + `${picked.interfaceNumber} (${err?.message ?? err}).`,
        );
      }
    }
    try {
      await device.claimInterface(picked.interfaceNumber);
    } catch (err) {
      throw new Error(
        `WebUSB: could not claim interface ${picked.interfaceNumber} (${err?.message ?? err}). `
        + 'Close every other program or tab using the device (adb, fastboot, mass storage) and retry.',
      );
    }
    return new UsbFastbootTransport(device, picked, options);
  }

  /* ── Transport interface ───────────────────────────────────────────── */

  /**
   * Send raw bytes, one bulk transfer per packet sized chunk.
   * @param {Uint8Array} bytes
   */
  async write(bytes) {
    if (this._closed) throw new Error('WebUsbFastbootTransport: the transport is closed');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let offset = 0; offset < data.length; offset += this.outPacketSize) {
      const chunk = data.subarray(offset, Math.min(offset + this.outPacketSize, data.length));
      const result = await this.device.transferOut(this.outEndpointNumber, chunk);
      if (!result || result.status !== 'ok') {
        throw new Error(`WebUSB: transferOut failed on endpoint ${this.outEndpointNumber} (${result?.status ?? 'unknown status'})`);
      }
      if (typeof result.bytesWritten === 'number' && result.bytesWritten !== chunk.length) {
        throw new Error(`WebUSB: transferOut wrote ${result.bytesWritten} of ${chunk.length} bytes`);
      }
    }
  }

  /**
   * Receive the next chunk of bytes.
   *
   * The in-flight `transferIn` is remembered between calls so a timeout never
   * loses bytes: the next `read()` resumes waiting on the same transfer.
   * @returns {Promise<Uint8Array|null>} null when nothing arrived before the timeout
   */
  async read() {
    if (this._closed) throw new Error('WebUsbFastbootTransport: the transport is closed');
    if (!this._pendingRead) {
      const pending = this.device.transferIn(this.inEndpointNumber, this.inPacketSize);
      pending.catch(() => {}); // handled per call through raceWithTimeout()
      this._pendingRead = pending;
    }
    const outcome = await raceWithTimeout(this._pendingRead, this.timeoutMs);
    if (outcome.timedOut) return null;
    this._pendingRead = null;
    if (outcome.error) {
      throw new Error(`WebUSB: transferIn failed on endpoint ${this.inEndpointNumber} (${outcome.error?.message ?? outcome.error})`);
    }
    const result = outcome.value;
    if (!result) return null;
    if (result.status === 'stall') {
      await this._clearHalt('in', this.inEndpointNumber);
      throw new Error(`WebUSB: endpoint ${this.inEndpointNumber} stalled (halted); the halt was cleared, retry the command`);
    }
    if (result.status !== 'ok') {
      throw new Error(`WebUSB: transferIn returned status "${result.status}"`);
    }
    const view = result.data;
    if (!view || view.byteLength === 0) return new Uint8Array(0);
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  }

  /**
   * Discard anything the device already sent (leftovers from a previous
   * command or a device that spams INFO lines).
   */
  async flush() {
    if (this._closed) return;
    const deadline = Date.now() + this.flushTimeoutMs;
    for (let attempt = 0; attempt < DEFAULT_FLUSH_READS; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      this.setTimeout(remaining);
      let chunk = null;
      try {
        chunk = await this.read();
      } catch {
        break;
      }
      if (!chunk) break;
    }
    this.setTimeout(this.timeoutMs);
  }

  /** @param {number} ms per-transfer timeout used by read() */
  setTimeout(ms) {
    const value = Number(ms);
    this.timeoutMs = Number.isFinite(value) && value > 0 ? value : 1;
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /**
   * Release the interface and close the device. Keep the transport if only the
   * interface had to be released (`releaseInterface` alone) by calling
   * `releaseInterface()` directly.
   * @param {{release?: boolean, close?: boolean}} [options]
   */
  async close({ release = true, close: closeDevice = true } = {}) {
    if (this._closed) return;
    this._closed = true;
    this._pendingRead = null;
    if (release) await this.releaseInterface();
    if (closeDevice) {
      try {
        await this.device.close();
      } catch {
        /* the device may already be gone (unplugged / rebooted into the OS) */
      }
    }
  }

  /** Release just the claimed interface (leaves the device open). */
  async releaseInterface() {
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch {
      /* already released, or the device vanished */
    }
  }

  /** USB port reset, useful to recover a wedged device before retrying. */
  async reset() {
    try {
      await this.device.reset();
    } catch (err) {
      throw new Error(`WebUSB: device reset failed (${err?.message ?? err}). Replug the device.`);
    }
  }

  async _clearHalt(direction, endpointNumber) {
    try {
      await this.device.clearHalt(direction, endpointNumber);
    } catch {
      /* best effort */
    }
  }

  /** @returns {{vendorId: number, productId: number, productName: string, manufacturerName: string, serialNumber: string, interfaceNumber: number, inEndpoint: number, outEndpoint: number, inPacketSize: number, outPacketSize: number}} */
  describe() {
    const device = this.device ?? {};
    return {
      vendorId: device.vendorId ?? 0,
      productId: device.productId ?? 0,
      productName: device.productName ?? '',
      manufacturerName: device.manufacturerName ?? '',
      serialNumber: device.serialNumber ?? '',
      interfaceNumber: this.interfaceNumber,
      inEndpoint: this.inEndpointNumber,
      outEndpoint: this.outEndpointNumber,
      inPacketSize: this.inPacketSize,
      outPacketSize: this.outPacketSize,
    };
  }
}

/** Alias kept for callers that prefer the explicit name. */
export const WebUsbFastbootTransport = UsbFastbootTransport;
