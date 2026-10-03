// R1: a fastboot query must refuse a device that is answering ADB.
//
// The live 2026-10-03 failure: 18d1:4ee2 was listed in MODES.fastboot.filters
// and `findFastbootInterface` accepts any vendor-class bulk pair, so "Query
// device" claimed TWRP's own interface (ff/42/01). Every getvar then timed out
// and the page looked like a broken fastboot device instead of a device in the
// wrong mode. `openFastboot` now reads the claimed interface's alternate after
// the transport opens: an ADB protocol byte releases the interface, closes the
// device and refuses, naming the entry that actually works. Fastboot's own
// ff/42/03 and 0bb4:0c01 must still be accepted.
//
// The REAL transport and the REAL FastbootClient run against fake USBDevice
// descriptors — only the device is faked, so the descriptor reading under test
// is the production code path. No USB, no chooser, no adb, no fastboot binary.

import test from "node:test";
import assert from "node:assert/strict";

import { openFastboot, RECOVERY_NOT_FASTBOOT_MESSAGE, fastbootFilters } from "./transports.js";
import { MODES } from "./device.js";

/**
 * A fake USBDevice whose interface carries the given class/subclass/protocol
 * triple and a bulk IN/OUT pair — exactly what `findFastbootInterface` looks
 * for, so the protocol byte is the only thing that can refuse it.
 */
function fakeDevice({ vendorId = 0x18d1, productId = 0x4ee2, interfaceSubclass = 0x42,
  interfaceProtocol = 0x01, interfaceClass = 0xff } = {}) {
  const endpoints = [
    { direction: "in", type: "bulk", endpointNumber: 1, packetSize: 64 },
    { direction: "out", type: "bulk", endpointNumber: 2, packetSize: 64 },
  ];
  return {
    vendorId,
    productId,
    productName: "Echo",
    serialNumber: "TEST-SERIAL",
    opened: false,
    closeCalls: 0,
    releaseCalls: [],
    configuration: {
      interfaces: [{
        interfaceNumber: 0,
        interfaceClass,
        alternate: 0,
        alternates: [{
          alternateSetting: 0, interfaceClass, interfaceSubclass, interfaceProtocol, endpoints,
        }],
      }],
    },
    async open() { this.opened = true; },
    async close() { this.closeCalls += 1; this.opened = false; },
    async claimInterface(number) { this.claimed = number; },
    async releaseInterface(number) { this.releaseCalls.push(number); },
    async selectAlternateInterface() {},
  };
}

test("an ADB interface (ff/42/01) is refused, released and closed", async () => {
  const device = fakeDevice({ interfaceProtocol: 0x01 });
  const logs = [];

  await assert.rejects(
    () => openFastboot({ device, onLog: (line) => logs.push(line) }),
    (thrown) => {
      assert.equal(thrown.message, RECOVERY_NOT_FASTBOOT_MESSAGE);
      assert.equal(thrown.name, "StageError", "the refusal must be shaped like a StageError");
      assert.equal(thrown.stage, "device");
      return true;
    },
  );

  // The refused claim must leave the recovery interface free: leaving it
  // claimed would break the very entry the message points the operator at.
  assert.deepEqual(device.releaseCalls, [0], "the claimed interface must be released");
  assert.equal(device.closeCalls, 1, "the raw device handle must be closed");
  assert.equal(device.opened, false, "the device must not be left open");
  assert.ok(logs.some((line) => /ADB/.test(line)), "the log must say what was refused");
  assert.ok(!logs.some((line) => /fastboot device ready/.test(line)),
    "a refused device was announced as a fastboot session");
});

test("a fastboot interface (ff/42/03) is accepted and stays open", async () => {
  const device = fakeDevice({ vendorId: 0x0bb4, productId: 0x0c01, interfaceProtocol: 0x03 });
  const session = await openFastboot({ device, onLog: () => {} });

  assert.equal(session.device, device);
  assert.equal(typeof session.client.getVar, "function", "a real FastbootClient is returned");
  assert.deepEqual(device.releaseCalls, [], "an accepted interface is not released");
  assert.equal(device.closeCalls, 0, "a live session must not close its device");
  assert.equal(device.opened, true);
});

test("the refusal message names the recovery entry verbatim", () => {
  assert.equal(RECOVERY_NOT_FASTBOOT_MESSAGE,
    "this Echo is in recovery (ADB), not fastboot — use “My Echo is already in recovery”");
});

test("a non-0x42 subclass is not treated as ADB", async () => {
  // Only the measured ff/42/01 triple is refused. A vendor interface that
  // happens to carry protocol 0x01 under a different subclass must still work,
  // or a legitimate bootloader interface would be refused on a guess.
  const device = fakeDevice({ vendorId: 0x0e8d, productId: 0x201c,
    interfaceSubclass: 0xff, interfaceProtocol: 0x01 });
  const session = await openFastboot({ device, onLog: () => {} });
  assert.ok(session.client, "a non-0x42 interface was refused as ADB");
  await session.client.transport.close();
});

test("18d1:4ee2 is a recovery identity, never a fastboot one", () => {
  const fastbootIds = MODES.fastboot.filters
    .map((f) => `${f.vendorId.toString(16)}:${f.productId.toString(16)}`);
  assert.ok(!fastbootIds.includes("18d1:4ee2"),
    "TWRP's identity is still offered as a fastboot filter");
  const adbIds = MODES.adb.filters
    .map((f) => `${f.vendorId.toString(16)}:${f.productId.toString(16)}`);
  assert.ok(adbIds.includes("18d1:4ee2"), "TWRP's identity was dropped from the adb list");
  // The filter list the fastboot transport actually uses is this same table.
  assert.ok(!fastbootFilters("fastboot").some((f) => f.productId === 0x4ee2));
  // 0bb4:0c01 is the measured fastboot identity and must stay.
  assert.ok(fastbootIds.includes("bb4:c01"), "the measured fastboot identity was removed");
});