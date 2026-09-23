/**
 * webusb-adb-transport.js — Chromium WebUSB transport for `adb.js`.
 *
 * Implements the `Transport` contract that `AdbClient` expects:
 *   write(Uint8Array) -> Promise<void>
 *   read()            -> Promise<Uint8Array|null>
 *   flush()           -> Promise<void>
 *   setTimeout(ms)    -> Promise<void>
 *
 * plus device discovery for the ADB interface as exposed by TWRP / adbd:
 * vendor 0x18d1 with product IDs 0x4ee0..0x4ee7 or 0xd00d (a caller-supplied
 * filter list is always accepted too).
 *
 * Chromium-only by design; like every WebUSB page it must be served over HTTPS
 * (or http://localhost) and the user must accept the device chooser once.
 *
 * @module webusb-adb-transport
 */

/** USB vendor ID Google uses for ADB interfaces. */
export const ADB_VENDOR_ID = 0x18d1;

/**
 * Default `requestDevice` filters: TWRP/adbd on the Amazon Echo Gen 2 appears as
 * 0x18d1:0x4ee0..0x4ee7 (or the generic 0x18d1:0xd00d).
 * @type {{vendorId: number, productId?: number}[]}
 */
export const TWRP_USB_FILTERS = [
  { vendorId: ADB_VENDOR_ID, productId: 0x4ee0 },
  { vendorId: ADB_VENDOR_ID, productId: 0x4ee1 },
  { vendorId: ADB_VENDOR_ID, productId: 0x4ee2 },
  { vendorId: ADB_VENDOR_ID, productId: 0x4ee3 },
  { vendorId: ADB_VENDOR_ID, productId: 0x4ee4 },
  { vendorId: ADB_VENDOR_ID, productId: 0x4ee5 },
  { vendorId: ADB_VENDOR_ID, productId: 0x4ee6 },
  { vendorId: ADB_VENDOR_ID, productId: 0x4ee7 },
  { vendorId: ADB_VENDOR_ID, productId: 0xd00d },
];

/** ADB's USB interface descriptor triple. */
export const ADB_INTERFACE = { interfaceClass: 0xff, interfaceSubclass: 0x42, interfaceProtocol: 0x01 };

/** Default bulk read size (matches adb's own 64 KiB reads on the wire). */
export const DEFAULT_READ_SIZE = 64 * 1024;
/** Default per-transfer timeout (ms) passed to WebUSB. */
export const DEFAULT_TRANSFER_TIMEOUT_MS = 15_000;
/** Default transfer timeout while pushing large payloads. */
export const LARGE_TRANSFER_TIMEOUT_MS = 120_000;

/**
 * True when this browser exposes WebUSB.
 * @returns {boolean}
 */
export function isWebUsbAvailable() {
  return typeof navigator !== 'undefined' && !!navigator.usb;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A transient WebUSB transfer timeout (idle device) versus a real failure.
 * @param {any} err
 * @returns {boolean}
 */
function isTimeoutError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError') return true;
  return /timeout/i.test(String(err.message ?? err));
}

/**
 * A disconnect / unplug, after which reads must end rather than retry.
 * @param {any} err
 * @returns {boolean}
 */
export function isDisconnectError(err) {
  if (!err) return false;
  if (err.name === 'NotFoundError' || err.name === 'NetworkError' || err.name === 'InvalidStateError') return true;
  return /disconnect|detached|device .* lost|no device/i.test(String(err.message ?? err));
}

/**
 * Find the ADB interface (and its bulk endpoints) inside a WebUSB device.
 *
 * @param {USBDevice} device
 * @returns {{configurationValue: number|null, interfaceNumber: number,
 *            inEndpoint: number, outEndpoint: number}|null}
 */
export function findAdbInterface(device) {
  const configurations = device.configurations ?? [];
  for (const config of configurations) {
    for (const iface of config.interfaces ?? []) {
      for (const alt of iface.alternates ?? []) {
        if (
          alt.interfaceClass === ADB_INTERFACE.interfaceClass &&
          alt.interfaceSubclass === ADB_INTERFACE.interfaceSubclass &&
          alt.interfaceProtocol === ADB_INTERFACE.interfaceProtocol
        ) {
          const endpoints = alt.endpoints ?? [];
          const inEp = endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
          const outEp = endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
          if (inEp && outEp) {
            return {
              configurationValue: config.configurationValue,
              interfaceNumber: iface.interfaceNumber,
              inEndpoint: inEp.endpointNumber,
              outEndpoint: outEp.endpointNumber,
            };
          }
        }
      }
    }
  }
  // Some devices (including a few adbd builds) do not label the interface at all:
  // fall back to the first interface that owns a bulk in/out pair.
  for (const config of configurations) {
    for (const iface of config.interfaces ?? []) {
      for (const alt of iface.alternates ?? []) {
        const endpoints = alt.endpoints ?? [];
        const inEp = endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
        const outEp = endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
        if (inEp && outEp) {
          return {
            configurationValue: config.configurationValue,
            interfaceNumber: iface.interfaceNumber,
            inEndpoint: inEp.endpointNumber,
            outEndpoint: outEp.endpointNumber,
          };
        }
      }
    }
  }
  return null;
}

/**
 * WebUSB transport for ADB-over-USB.
 *
 * @example
 * import { AdbClient } from './adb.js';
 * import { WebUsbAdbTransport } from './webusb-adb-transport.js';
 *
 * const transport = await WebUsbAdbTransport.requestDevice(); // user picks the Echo
 * const adb = new AdbClient(transport);
 * await adb.connect({ banner: 'host::LibreEcho-WebInstaller' });
 * ...
 * await adb.close(); // releases the interface
 */
export class WebUsbAdbTransport {
  /**
   * Whether WebUSB is usable in this browser/context.
   * @returns {boolean}
   */
  static isSupported() {
    return isWebUsbAvailable();
  }

  /**
   * Ask the user to pick an ADB device, open it and return a ready transport.
   *
   * @param {{filters?: {vendorId: number, productId?: number}[], readSize?: number,
   *          timeout?: number}} [options]
   * @returns {Promise<WebUsbAdbTransport>}
   */
  static async requestDevice(options = {}) {
    if (!isWebUsbAvailable()) {
      throw new Error('WebUSB is not available: use Chromium desktop over https:// (or http://localhost)');
    }
    const filters = options.filters ?? TWRP_USB_FILTERS;
    const device = await navigator.usb.requestDevice({ filters });
    const transport = new WebUsbAdbTransport(device, options);
    await transport.open();
    return transport;
  }

  /**
   * Devices this origin already has permission for (no chooser).
   * @param {{filters?: {vendorId: number, productId?: number}[],
   *          productIds?: number[]}} [options]
   * @returns {Promise<USBDevice[]>}
   */
  static async getDevices(options = {}) {
    if (!isWebUsbAvailable()) {
      throw new Error('WebUSB is not available: use Chromium desktop over https:// (or http://localhost)');
    }
    const filters = options.filters ?? TWRP_USB_FILTERS;
    const devices = await navigator.usb.getDevices();
    return devices.filter((device) =>
      filters.some(
        (f) =>
          f.vendorId === device.vendorId &&
          (f.productId === undefined || f.productId === device.productId)
      )
    );
  }

  /**
   * Re-attach to a previously authorised device without prompting.
   * @param {{filters?: {vendorId: number, productId?: number}[], readSize?: number,
   *          timeout?: number}} [options]
   * @returns {Promise<WebUsbAdbTransport|null>} null when none is available
   */
  static async attachExisting(options = {}) {
    const devices = await WebUsbAdbTransport.getDevices(options);
    if (devices.length === 0) return null;
    const transport = new WebUsbAdbTransport(devices[0], options);
    await transport.open();
    return transport;
  }

  /**
   * @param {USBDevice} device
   * @param {{readSize?: number, timeout?: number}} [options]
   */
  constructor(device, options = {}) {
    if (!device) throw new Error('WebUsbAdbTransport requires a USBDevice');
    this.device = device;
    this.readSize = options.readSize ?? DEFAULT_READ_SIZE;
    this.timeout = options.timeout ?? DEFAULT_TRANSFER_TIMEOUT_MS;
    this._interfaceNumber = null;
    this._configurationValue = null;
    this._inEndpoint = null;
    this._outEndpoint = null;
    this._closed = false;
    this._writeChain = Promise.resolve();
    this._disconnected = false;
    this._onDisconnect = () => {
      this._disconnected = true;
      this._closed = true;
    };
    if (typeof device.addEventListener === 'function') {
      device.addEventListener('disconnect', this._onDisconnect);
    }
  }

  /** Endpoints currently in use (useful for diagnostics/UI). */
  get endpoints() {
    return { in: this._inEndpoint, out: this._outEndpoint, interfaceNumber: this._interfaceNumber };
  }

  /**
   * Open the device, select the ADB configuration and claim its interface.
   * @returns {Promise<this>}
   */
  async open() {
    const device = this.device;
    if (!device.opened) await device.open();
    if (device.configuration == null && (device.configurations ?? []).length > 0) {
      const config = device.configurations[0];
      await device.selectConfiguration(config.configurationValue ?? 1);
    }
    const found = findAdbInterface(device);
    if (!found) throw new Error('no ADB (bulk in/out) interface found on this USB device');
    this._interfaceNumber = found.interfaceNumber;
    this._configurationValue = device.configuration?.configurationValue ?? found.configurationValue ?? 1;
    await device.claimInterface(this._interfaceNumber);
    this._inEndpoint = found.inEndpoint;
    this._outEndpoint = found.outEndpoint;
    this._closed = false;
    this._disconnected = false;
    return this;
  }

  /**
   * Write every byte, looping over partial `transferOut` results.
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   */
  async write(bytes) {
    if (this._closed) throw new Error('WebUSB transport is closed');
    const next = this._writeChain.then(() => this._writeAll(bytes));
    next.catch(() => {}); // a failure is reported to the caller, never as an unhandled rejection
    this._writeChain = next;
    return next;
  }

  /** @param {Uint8Array} bytes @private */
  async _writeAll(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await this.device.transferOut(this._outEndpoint, bytes.subarray(offset));
      if (result.status !== 'ok') throw new Error(`WebUSB transferOut failed: status ${result.status}`);
      if (!result.bytesWritten) throw new Error('WebUSB transferOut wrote 0 bytes');
      offset += result.bytesWritten;
    }
  }

  /**
   * Resolve with the next chunk of device bytes, or `null` once the transport is
   * closed / the device is unplugged. Idle transfer timeouts are retried, since
   * adbd legitimately sends nothing until there is output.
   * @returns {Promise<Uint8Array|null>}
   */
  async read() {
    while (!this._closed) {
      let result;
      try {
        result = await this.device.transferIn(this._inEndpoint, this.readSize);
      } catch (err) {
        if (this._closed) return null;
        if (isDisconnectError(err)) {
          this._closed = true;
          return null;
        }
        if (isTimeoutError(err)) {
          await delay(0);
          continue;
        }
        throw err;
      }
      if (result.status === 'stall') {
        await this.device.clearHalt('in', this._inEndpoint);
        continue;
      }
      if (result.status !== 'ok') throw new Error(`WebUSB transferIn failed: status ${result.status}`);
      const data = result.data;
      if (data && data.byteLength > 0) {
        // The DataView's buffer is reused by the UA: copy out before returning.
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      }
    }
    return null;
  }

  /**
   * Wait for every queued write to reach the device.
   * @returns {Promise<void>}
   */
  async flush() {
    await this._writeChain;
  }

  /**
   * Set the per-transfer WebUSB timeout. `AdbClient` calls this with the
   * remaining time of the current operation (a 240 MB push raises it).
   * @param {number} ms
   * @returns {Promise<void>}
   */
  async setTimeout(ms) {
    if (typeof ms === 'number' && ms >= 0) {
      this.timeout = Math.min(Math.max(ms, 100), LARGE_TRANSFER_TIMEOUT_MS);
    }
  }

  /**
   * Release the interface and close the device.
   * @returns {Promise<void>}
   */
  async close() {
    this._closed = true;
    if (typeof this.device.removeEventListener === 'function') {
      this.device.removeEventListener('disconnect', this._onDisconnect);
    }
    if (this._interfaceNumber != null) {
      try {
        await this.device.releaseInterface(this._interfaceNumber);
      } catch {
        /* device already gone */
      }
      this._interfaceNumber = null;
    }
    try {
      if (this.device.opened) await this.device.close();
    } catch {
      /* device already gone */
    }
  }

  /** Alias for {@link close} (matches the adb/WebUSB vocabulary). */
  async release() {
    return this.close();
  }

  /** False once closed, released or unplugged. */
  get isOpen() {
    return !this._closed;
  }
}

export default WebUsbAdbTransport;
