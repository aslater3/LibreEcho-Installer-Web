// F1/F8: openAdb must release the USB interface for EVERY failure point, not
// just a failing handshake. WebUsbAdbTransport.open() throws at three points
// after device.open() has already succeeded (selectConfiguration, "no ADB
// interface found", claimInterface) — all of which happen on a mode change.
// The exception used to escape before anything released the interface, so the
// next poll round inherited a half-open transport on the same USB interface:
// the field "waiting for CNXN/AUTH" / "no more data from the device" failure.
//
// Before this suite existed, reverting the release call left all 237 js tests
// green (F8: zero references to openAdb in js/test_*.mjs).

import test from "node:test";
import assert from "node:assert/strict";

import { openAdb } from "./transports.js";

/**
 * Fake USBDevice. `open()` always succeeds and marks the handle open, so the
 * failure under test happens strictly *after* the physical open.
 */
function fakeDevice(overrides = {}) {
  return {
    vendorId: 0x18d1,
    productId: 0x4ee2,
    opened: false,
    closeCalls: 0,
    releaseCalls: [],
    async open() { this.opened = true; },
    async close() { this.closeCalls += 1; this.opened = false; },
    async claimInterface(number) { this.claimed = number; },
    async releaseInterface(number) { this.releaseCalls.push(number); },
    ...overrides,
  };
}

/**
 * Fake transport class. `mode` picks which stage throws:
 *   "no-interface"     — open() throws after device.open(), no claim
 *   "claim"            — open() throws from claimInterface, _interfaceNumber set
 *   "connect"          — open() succeeds, client.connect() throws
 *   "connect-after"    — open() succeeds, connect throws, transport.close() itself throws
 */
function fakeTransportClass(mode, { connectImpl } = {}) {
  return class FakeTransport {
    constructor(device) {
      this.device = device;
      this._interfaceNumber = null;
      this.closeCalls = 0;
    }
    async open() {
      if (!this.device.opened) await this.device.open();
      if (mode === "no-interface") {
        throw new Error("no ADB (bulk in/out) interface found on this USB device");
      }
      this._interfaceNumber = 0;
      if (mode === "claim") {
        throw new Error("NetworkError: claimInterface failed");
      }
      return this;
    }
    async close() {
      this.closeCalls += 1;
      if (mode === "connect-after") throw new Error("disconnect during mode change");
      if (this._interfaceNumber != null) {
        try { await this.device.releaseInterface(this._interfaceNumber); } catch { /* gone */ }
        this._interfaceNumber = null;
      }
      if (this.device.opened) await this.device.close();
    }
  };
}

function fakeClientClass(connectImpl) {
  return class FakeClient {
    constructor(transport) { this.transport = transport; }
    connect(options) { return connectImpl ? connectImpl(options) : Promise.reject(new Error("timeout waiting for CNXN")); }
    close() { return this.transport.close(); }
  };
}

test("a transport.open() that fails before producing a transport still closes the raw device handle", async () => {
  const device = fakeDevice();
  const TransportClass = fakeTransportClass("no-interface");
  const ClientClass = fakeClientClass();

  await assert.rejects(
    () => openAdb({ device, TransportClass, ClientClass }),
    /no ADB \(bulk in\/out\) interface found/,
  );

  // No transport object ever existed, so only the raw handle can release it.
  assert.equal(device.closeCalls, 1, "device.close() must be called when open() throws with no transport");
  assert.equal(device.opened, false, "the device must not be left open");
});

test("a claimInterface failure releases the claimed interface and closes the device", async () => {
  const device = fakeDevice();
  // open() sets _interfaceNumber then throws at claimInterface, exactly like
  // WebUsbAdbTransport.open() — the interface number is known at that point.
  const TransportClass = fakeTransportClass("claim");
  const ClientClass = fakeClientClass();

  await assert.rejects(
    () => openAdb({ device, TransportClass, ClientClass }),
    /claimInterface failed/,
  );

  assert.equal(device.closeCalls, 1, "device.close() must be called after a claimInterface failure");
  assert.equal(device.opened, false, "the device must not be left open");
});

test("a failing handshake releases the interface and closes the device", async () => {
  const device = fakeDevice();
  const TransportClass = fakeTransportClass("connect");
  const ClientClass = fakeClientClass(async () => { throw new Error("timeout waiting for CNXN"); });

  await assert.rejects(
    () => openAdb({ device, TransportClass, ClientClass }),
    /timeout waiting for CNXN/,
  );

  assert.equal(device.closeCalls, 1);
  assert.equal(device.opened, false);
});

test("release is not short-circuited by a transport.close() that itself throws", async () => {
  // WebUsbAdbTransport.close() swallows its own releaseInterface/device.close()
  // errors internally, so a close() that throws means it did NOT finish
  // releasing. Returning after it (the old `return` in releaseUsbInterface)
  // left the device open forever.
  const device = fakeDevice();
  const TransportClass = fakeTransportClass("connect-after");
  const ClientClass = fakeClientClass(async () => { throw new Error("no more data from the device"); });

  await assert.rejects(
    () => openAdb({ device, TransportClass, ClientClass }),
    /no more data from the device/,
  );

  assert.equal(device.closeCalls, 1, "device.close() must be attempted even when transport.close() threw");
  assert.equal(device.opened, false);
});

test("a successful connect returns the session and does not release anything", async () => {
  const device = fakeDevice();
  const TransportClass = fakeTransportClass("ok");
  const ClientClass = fakeClientClass(async () => ({ deviceBanner: "device::libreecho" }));

  const session = await openAdb({ device, TransportClass, ClientClass });

  assert.equal(session.device, device);
  assert.ok(session.client, "a client is returned");
  assert.equal(session.info.deviceBanner, "device::libreecho");
  assert.equal(device.closeCalls, 0, "a live session must not be released");
  assert.equal(device.opened, true);
});

test("a failure with no device at all still propagates without throwing a release error", async () => {
  // requestDevice() itself rejects: there is nothing to release, and the
  // original error must reach the operator rather than a release artifact.
  class RejectingTransport {
    static async requestDevice() { throw new Error("no device selected"); }
  }
  await assert.rejects(
    () => openAdb({ TransportClass: RejectingTransport, ClientClass: fakeClientClass() }),
    /no device selected/,
  );
});