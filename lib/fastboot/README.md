# fastboot.js — Fastboot over WebUSB, no dependencies

Vanilla ES modules implementing the Fastboot USB protocol for a browser-based
installer (part of the LibreEcho one-shot installer served from GitHub Pages).
No bundler, no npm packages, no build step: load the files as native ES modules
with `<script type="module">`.

```
fastboot.js                      protocol framing + FastbootClient (transport agnostic)
webusb-fastboot-transport.js     Chromium WebUSB transport (UsbFastbootTransport)
test_fastboot.mjs                node:test suite with a scripted fake bootloader
README.md                        this file
```

- Runs in Node too (for tests and automation) — `fastboot.js` imports nothing.
- `fastboot.js` never touches WebUSB; the transport is injected.
- Target browser: desktop Chromium (Chrome/Edge/Brave) with WebUSB, over
  `https://` or `http://localhost`.

## Quick start (browser)

```html
<script type="module">
  import { FastbootClient } from './fastboot.js';
  import { UsbFastbootTransport } from './webusb-fastboot-transport.js';

  document.querySelector('#connect').addEventListener('click', async () => {
    // requestDevice() must run from a user gesture (a click).
    const transport = await UsbFastbootTransport.open();
    const fastboot = new FastbootClient(transport, { timeout: 15000 });
    try {
      console.log('device:', await fastboot.getVar('product'));
      console.log('serial:', await fastboot.getVar('serialno'));
      console.log('unlock:', await fastboot.getVar('unlock_status'));

      const image = new Uint8Array(await (await fetch('./boot.img')).arrayBuffer());
      await fastboot.flash('boot_a', image, {
        onProgress: (sent, total) => console.log(`${sent}/${total} bytes`),
        onInfo: (line) => console.log(line),
      });
      await fastboot.reboot();
    } finally {
      await transport.close();
    }
  });
</script>
```

Re-attaching in a later visit (the page keeps the device permission) needs no
gesture and no chooser:

```js
const transport = await UsbFastbootTransport.open(null, { preferPaired: true });
```

## The Transport interface

`fastboot.js` only knows these four methods; anything implementing them works
(WebUSB here, an HTTP proxy or a serial port elsewhere):

```js
class Transport {
  async write(bytes) {}      // Uint8Array -> device
  async read() {}            // -> next chunk as Uint8Array, or null on timeout
  async flush() {}           // discard buffered input
  setTimeout(ms) {}          // per-transfer timeout in milliseconds
}
```

`Transport` is exported as an abstract base class, and `FastbootClient`
validates the interface on construction (`TypeError` naming the missing
methods).

## FastbootClient API

| method | wire traffic | notes |
| --- | --- | --- |
| `raw(command)` | `command` | `{ status, info, data, dataLength, noReply }`; **does not throw on FAIL** |
| `getVar(name)` | `getvar:<name>` | value string; multi-line INFO payloads joined with `\n` |
| `getPartitionSize(name)` | `getvar:partition-size:<name>` | number (decimal or `0x` hex) |
| `download(bytes, opts)` | `download:<8 hex>` + payload | returns bytes sent |
| `flash(partition, bytes, opts)` | `download:` … then `flash:<part>` | `bytes` optional: omit to flash the download buffer; `singleDownload: true` opts into whole-image brick-only mode |
| `erase(partition)` | `erase:<part>` | returns the INFO lines |
| `reboot(target?)` | `reboot` / `reboot-bootloader` | silence tolerated (device resets) |
| `continue()` | `continue` | silence tolerated |
| `oemCommand(cmd)` | `oem <cmd>` | returns the INFO text |
| `power(cmd = 'power')` | `power` | silence tolerated; some bootloaders need `power('powerdown')` |

`options` for `download()` / `flash()`:

- `onProgress(sent, total)` — called after every accepted chunk.
- `chunkSize` — upper bound for one `download:` command (the device's
  `max-download-size` still wins if smaller).
- `onInfo(line)` — INFO/TEXT progress lines as they arrive.
- `singleDownload: true` (only for `flash('brick', image, ...)`) — send one
  `download:<full size>` and the complete raw image before `flash:brick`, even
  when `getvar:max-download-size` is smaller. Requires DATA to offer exactly
  the full image size and an OKAY for the payload; refusal/short window/timeout
  aborts without flashing and never falls back to chunked downloads. Rejects
  empty or larger-than-128-MiB images, missing bytes, and `chunkSize` together
  with this option. The installer must independently verify the selected image
  and its expected length before calling this API. This is host-only behavior,
  not proof the bootloader can accept the image.
- `writeTimeoutMs` — in single-download mode, the whole raw payload write
  deadline (default and maximum 900000 ms). A timed-out WebUSB write cannot be
  cancelled by this client; disconnect/reconnect instead of reusing the session.

Constructor: `new FastbootClient(transport, { timeout = 10000, onInfo })`.
`client.maxDownloadSize` caches `getvar:max-download-size` (queried once,
lazily, by the first ordinary `download()`). The single-download brick mode
never queries or obeys that variable.

Exported helpers: `parsePartitionSize(value)`, `toHex8(n)`, `cleanValue(text)`,
`concatBytes(...)`, `createFastbootClient(transport, options)`,
`ResponseStream` (the incremental parser), `FastbootStatus`, `Transport`.

### Errors

All extend `FastbootError` (which carries `.command` and `.status`):

| class | when | fields |
| --- | --- | --- |
| `FastbootFailError` | device answered `FAIL` | `.reason` (verbatim device text) |
| `FastbootTimeoutError` | no reply within the timeout | `.timeoutMs` |
| `FastbootProtocolError` | wrong status word, bad length field, unexpected reply | `.detail` |

Only `raw()` returns a `FAIL` status instead of throwing; every convenience
method throws `FastbootFailError` with the bootloader's own reason text, e.g.
`fastboot: "flash:boot_a" failed: Image is not a boot image`. Nothing waits
forever: every read is bounded by the client timeout, which is pushed into the
transport before each transfer.

## WebUSB transport

```js
UsbFastbootTransport.isSupported()               // false when navigator.usb is missing
await UsbFastbootTransport.open(filter?, opts?)  // chooser (+ user gesture)
await UsbFastbootTransport.open(filter, { preferPaired: true })
UsbFastbootTransport.findPairedDevice(filter)    // navigator.usb.getDevices() lookup
await UsbFastbootTransport.fromDevice(usbDevice, opts?)
transport.close() / releaseInterface() / reset() / describe()
```

- `filter` is a single WebUSB filter object or an array; `null` uses
  `DEFAULT_FASTBOOT_FILTERS` = `[{vendorId: 0x18d1}]` (Android fastboot,
  product IDs 0x4ee0–0x4ee7), `[{classCode: 0xff}]` (the vendor-specific
  interface the Echo/MT8163 target exposes) and MediaTek 0x0e8d.
  `androidFastbootFilters()` enumerates the eight 0x4ee0–0x4ee7 IDs explicitly.
- `fromDevice()` opens the device, selects configuration 1, picks the
  interface/alternate with a bulk IN/OUT pair (preferring class `0xFF`),
  claims it and resolves the endpoints and packet sizes.
- `write()` splits into bulk transfers of the OUT endpoint packet size;
  `read()` keeps the in-flight `transferIn` across timeouts, so late bytes are
  never lost, and `flush()` drains anything already buffered.
- Clear failures: "WebUSB is not available …", "could not claim interface N
  (Access denied). Close every other program or tab using the device", "this
  device exposes no bulk IN/OUT endpoint pair. Is it really in fastboot mode?".

## Protocol notes (what the code guarantees)

- Command → 4 ASCII status bytes (`OKAY`, `FAIL`, `DATA`, `INFO`, `TEXT`).
- `INFO`/`TEXT` carry 8 ASCII hex length digits + payload; they are collected
  until a terminal `OKAY`/`FAIL`.
- `DATA` carries only the 8 hex digit maximum-accepted-chunk window; the payload
  then travels host → device and is acknowledged with `OKAY`/`FAIL`.
- `OKAY`/`FAIL` may be followed by result/reason text in the same transfer;
  text arriving in the *next* transfer is picked up with a short bounded grace
  read (a FAIL is still bounded by the command timeout).
- Parsing is incremental: one read may hold several messages, one message may
  span many reads. `ResponseStream` buffers and never assumes read == message.
- Download chunking follows the real host: `download:<size>` → `DATA <window>`
  → that many raw bytes → `OKAY`, repeating until the image is sent; a smaller
  window shrinks the subsequent chunk sizes.

Known fastboot variables handled by `getVar()`: `product`,
`partition-size:<name>`, `max-download-size`, `unlock_status`
(`true`/`false`/`unlocked`/`locked`), `lk_build_desc`, `serialno`, plus
tolerance for `okay`-prefixed values, trailing NULs and a `<name>:` echo.

## Tests

```sh
node --test test_fastboot.mjs     # or: node test_fastboot.mjs
```

Tests require no hardware and run against a scripted fake transport and a
fake bootloader that speaks the protocol: framing, split and multi-message
reads, FAIL reasons (including split across transfers), chunked downloads,
whole-image brick download and fail-closed short-window handling, flash/erase/
reboot/oem, the timeout path, and the WebUSB transport's write splitting,
buffering and interface selection against an in-memory `USBDevice`.

## Troubleshooting

- `requestDevice()` must be called from a click handler, on https or localhost.
- `claimInterface()` "Access denied": close `adb`, `fastboot`, any terminal or
  file manager with the device open, unplug/replug, retry.
- Device not listed: it must be in fastboot mode (vendor-specific interface,
  class `0xFF`). Chromium shows unclaimed/blocked devices in
  `chrome://device-log` and `navigator.usb.getDevices()` lists granted ones.
- Everything times out right after a reboot: re-open the transport — the device
  re-enumerates with new endpoints.
