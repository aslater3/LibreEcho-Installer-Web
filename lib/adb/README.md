# ADB over WebUSB (dependency-free)

A browser-side ADB client used by the LibreEcho browser installer to talk to
TWRP (and to the installed image) from a page. No npm packages, no build step:
two ES modules plus a Node test suite.

| File | Purpose |
|---|---|
| `adb.js` | Protocol framing, incremental parser, `AdbClient` (connect, shell, push, stat) |
| `webusb-adb-transport.js` | WebUSB transport: device chooser, interface/endpoint discovery, bulk transfers |
| `test_adb.mjs` | `node:test` suite against a scripted fake adbd (no hardware, no dependencies) |

## Transport contract

`AdbClient` depends on a transport shaped like this, so the same client works
against the WebUSB transport, a test double, or anything else:

```js
class Transport {
  async write(bytes) {}   // Uint8Array
  async read() {}         // Uint8Array | null (null = timeout)
  async flush() {}
  setTimeout(ms) {}
}
```

## Quick start

```js
import { AdbClient } from './adb.js';
import { WebUsbAdbTransport } from './webusb-adb-transport.js';

const transport = await WebUsbAdbTransport.requestDevice(); // browser chooser
const adb = new AdbClient(transport);
await adb.connect({ banner: 'host::libreecho-browser-installer' });

const { stdout } = await adb.shell('getprop ro.twrp.version');
console.log(stdout);

await adb.push('/cache/libreecho-bundle/libreecho-boot.img', blob, {
  mode: 0o644,
  onProgress: ({ sent, total }) => console.log(`${sent}/${total}`),
});
await adb.close();
```

## What is implemented

* **Handshake** — `CNXN` (version `0x01000000`, `maxdata` 256 KiB, banner), then
  `CNXN` or `AUTH` handling. A device that demands an authentication token
  raises `AdbAuthRequiredError` with a clear message instead of failing
  obscurely; TWRP's adbd does not require one.
* **Streams** — `OPEN`/`OKAY`/`WRTE`/`CLSE` with per-stream routing by local and
  remote id, checksum verification on every inbound payload, payloads split to
  `maxData`, and `A_CNXN` keep-alive replies.
* **Shell** — the `shell:<cmd>` service, streamed stdout+stderr, with
  `onOutput(chunk)` for live terminal output. The legacy service carries no exit
  status, so `exitCode` is `null`; a refused `OPEN` surfaces the device's `FAIL`
  text.
* **Push** — the `sync:` service (`SEND` → `DATA` chunks of ≤64 KiB → `DONE` →
  `QUIT`), streaming from a `Blob`/`ArrayBuffer`/`Uint8Array` without
  materialising extra copies, with `onProgress({sent, total})` and a SHA-256 of
  the pushed bytes returned for a readback comparison.
* **stat / exists** — the sync `STAT` sub-command, returning `null` for a
  missing path rather than throwing.
* **Timeouts** — per-operation deadlines (`AdbTimeoutError` names the operation),
  with generous defaults for a >200 MB push.

`A_CNXN`, `A_AUTH`, `A_OPEN`, `A_OKAY`, `A_CLSE`, `A_WRTE`, `A_SYNC` appear as
`A_SYNC`, `A_CNXN`, `A_AUTH`, `A_OPEN`, `A_OKAY`, `A_CLSE`, `A_WRTE` and
`A_FAIL` exports, with `errnoName()` for sync error codes.

## WebUSB notes

* The client claims the vendor interface (`class 0xFF`, subclass `0x42`,
  protocol `0x01`) and uses its bulk in/out pair.
* `WebUsbAdbTransport.requestDevice({ filters })` prompts once; after that
  `getDevices({ filters })` / `attachExisting({ filters })` re-attach silently,
  which is what the installer uses after a reboot re-enumerates the device.
* Chromium desktop only: Firefox and Safari expose no WebUSB, and the page must
  be a secure context (HTTPS or localhost).
* The default filters cover TWRP/Android ADB (`0x18d1` with product ids
  `0x4ee0`–`0x4ee7`, `0xd00d`) and can be overridden.

## Tests

```bash
node --test test_adb.mjs
# 22 tests: 21 pass, 1 skipped (the multi-hundred-megabyte push is opt-in)
ADB_BIG_MB=256 node --test test_adb.mjs   # includes the large streaming push
```

The suite drives a scripted fake adbd, including deliberately hostile framing:
a header split across two reads, two messages coalesced into one read, a
`FAIL`+errno reply, an `AUTH`-demanding device, and a timeout. Every `WRTE`
checksum is verified by the fake peer, so a client that sent the wrong bytes
would fail the test rather than pass it.
