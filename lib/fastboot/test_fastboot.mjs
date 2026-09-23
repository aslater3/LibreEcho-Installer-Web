/**
 * @file test_fastboot.mjs
 * @summary Real Node test suite (node:test + node:assert) for fastboot.js and
 * the WebUSB transport module. Run with:
 *
 *   node --test test_fastboot.mjs      # or simply: node test_fastboot.mjs
 *
 * Everything runs against an in-process scripted fake transport, so no USB
 * hardware is required. The tests assert protocol behaviour exactly: framing,
 * buffering across reads, multi message reads, FAIL reasons, timeouts, chunked
 * downloads and the FATAL-free high level API.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FastbootClient,
  FastbootError,
  FastbootFailError,
  FastbootTimeoutError,
  FastbootProtocolError,
  ResponseStream,
  Transport,
  cleanValue,
  concatBytes,
  createFastbootClient,
  parsePartitionSize,
  toHex8,
  DEFAULT_MAX_DOWNLOAD_SIZE,
} from './fastboot.js';

import {
  UsbFastbootTransport,
  WebUsbFastbootTransport,
  androidFastbootFilters,
  DEFAULT_FASTBOOT_FILTERS,
} from './webusb-fastboot-transport.js';

/* ────────────────────────────── helpers ────────────────────────────── */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** @param {string} text @returns {Uint8Array} */
const enc = (text) => encoder.encode(text);
/** @param {Uint8Array} bytes @returns {string} */
const dec = (bytes) => decoder.decode(bytes);

/** A Fastboot frame: status + 8 hex digit length + payload. */
function frame(status, payload = '') {
  const body = typeof payload === 'string' ? enc(payload) : payload;
  return concatBytes(enc(status), enc(toHex8(body.length)), body);
}

const infoFrame = (text) => frame('INFO', text);
const textFrame = (text) => frame('TEXT', text);
const dataFrame = (size) => enc(`DATA${toHex8(size)}`);
const okayFrame = () => enc('OKAY');
const failFrame = (reason) => concatBytes(enc('FAIL'), enc(reason));

/** Split a chunk into 1-byte chunks, the way a fussy device might. */
function shatter(chunk, size = 1) {
  const pieces = [];
  for (let offset = 0; offset < chunk.length; offset += size) {
    pieces.push(chunk.slice(offset, offset + size));
  }
  return pieces;
}

/**
 * The transport interface, faked: everything written is recorded, replies are
 * produced by a `respond` callback at write time and then read back one chunk
 * at a time. An empty queue makes read() answer null, i.e. "timeout".
 */
class FakeTransport {
  constructor(options = {}) {
    /** @type {Array<Uint8Array|Function|null>} */
    this.queue = [];
    /** every Uint8Array handed to write(), copied @type {Uint8Array[]} */
    this.writes = [];
    this.flushCount = 0;
    this.timeoutValues = [];
    this.timeoutMs = 5000;
    this.respond = options.respond ?? null;
  }

  /** Queue raw chunks / strings / null (simulated timeout) for read(). */
  push(...chunks) {
    for (const chunk of chunks) this.queue.push(typeof chunk === 'string' ? enc(chunk) : chunk);
  }

  /** Push a chunk received in pieces of `size` bytes. */
  pushShattered(chunk, size = 1) {
    this.push(...shatter(chunk, size));
  }

  async write(bytes) {
    const copy = Uint8Array.from(bytes);
    this.writes.push(copy);
    if (this.respond) {
      const reply = this.respond(dec(copy), this, copy);
      if (Array.isArray(reply) && reply.length) this.push(...reply);
    }
  }

  async read() {
    if (!this.queue.length) return null; // nothing buffered: the timeout expired
    const item = this.queue.shift();
    if (typeof item === 'function') return item();
    return item;
  }

  async flush() {
    this.flushCount += 1;
    this.queue.length = 0;
  }

  setTimeout(ms) {
    this.timeoutMs = ms;
    this.timeoutValues.push(ms);
  }
}

/**
 * A tiny fake bootloader that speaks the real protocol over the fake
 * transport, so tests can drive the client through complete flows and assert
 * on what the "device" saw.
 */
function makeDevice(options = {}) {
  const vars = {
    product: 'Echo Dot (3rd gen)',
    serialno: 'G090LF0000000000',
    'max-download-size': '0x1000',
    'partition-size:boot_a': '0x00020000',
    'partition-size:userdata': '268435456',
    unlock_status: 'unlocked',
    'lk_build_desc': 'lk 2.0 (LibreEcho)\nbuild 2026-01-02\nplatform mt8163',
    ...options.vars,
  };
  const state = {
    /** protocol commands the device decoded @type {string[]} */
    commands: [],
    /** raw payload writes the device received @type {Uint8Array[]} */
    payloads: [],
    /** pending download window, null when the next write is a command */
    pendingDownload: null,
    downloadCount: 0,
    /** largest window the device will accept per download */
    offeredChunk: options.offeredChunk ?? 0x1000,
  };

  const respond = (command, transport, rawBytes) => {
    if (state.pendingDownload !== null) {
      const { accepted } = state.pendingDownload;
      state.pendingDownload = null;
      state.downloadCount += 1;
      state.payloads.push(rawBytes);
      if (rawBytes.length !== accepted) {
        return [failFrame(`short write: expected ${accepted} bytes, got ${rawBytes.length}`)];
      }
      const override = options.onPayload?.(state.downloadCount, rawBytes, state);
      return override ?? [okayFrame()];
    }

    state.commands.push(command);
    const override = options.onCommand?.(command, state);
    if (override) return override;

    if (command.startsWith('getvar:')) {
      const name = command.slice('getvar:'.length);
      const value = vars[name];
      if (value === undefined) return [failFrame(`unknown variable: ${name}`)];
      return [...String(value).split('\n').map((line) => infoFrame(`${line}\n`)), okayFrame()];
    }
    if (command.startsWith('download:')) {
      const size = parseInt(command.slice('download:'.length), 16);
      if (!Number.isFinite(size) || size <= 0) return [failFrame(`bad download size: ${command}`)];
      const accepted = Math.min(size, state.offeredChunk);
      state.pendingDownload = { requested: size, accepted };
      return [dataFrame(accepted)];
    }
    if (command.startsWith('flash:')) return [infoFrame('Sending sparse image...\n'), okayFrame()];
    if (command.startsWith('erase:')) return [okayFrame()];
    if (command.startsWith('oem')) return [infoFrame('(bootloader) oem ok\n'), okayFrame()];
    if (command === 'reboot' || command === 'reboot-bootloader' || command === 'continue'
        || command === 'power' || command === 'powerdown') {
      return null; // the device resets: no reply at all
    }
    return [failFrame(`unknown command: ${command}`)];
  };

  return {
    respond,
    state,
    vars,
    /** protocol commands the device decoded */
    get commands() { return state.commands; },
    /** raw payload writes the device received */
    get payloads() { return state.payloads; },
  };
}

/** Client + fake device + transport in one call. */
function setup(options = {}) {
  const device = makeDevice(options);
  const transport = new FakeTransport({ respond: device.respond });
  const client = new FastbootClient(transport, { timeout: options.timeout ?? 500 });
  return { device, transport, client };
}

/* ─────────────────────── pure helpers / framing ────────────────────── */

test('parsePartitionSize accepts decimal and 0x hex', () => {
  assert.equal(parsePartitionSize('0x10000000'), 0x10000000);
  assert.equal(parsePartitionSize('0X00020000'), 0x20000);
  assert.equal(parsePartitionSize('268435456'), 268435456);
  assert.equal(parsePartitionSize('0'), 0);
  assert.equal(parsePartitionSize(4096), 4096);
  assert.equal(parsePartitionSize(' 0x400 \n'), 0x400);
});

test('parsePartitionSize rejects garbage instead of guessing', () => {
  for (const bad of ['', '   ', 'unknown', 'not found', '0x', '12abc', '-1', '1.5']) {
    assert.throws(() => parsePartitionSize(bad), /partition size|empty partition size/, `should reject ${JSON.stringify(bad)}`);
  }
  assert.throws(() => parsePartitionSize(-1), /partition size/);
  assert.throws(() => parsePartitionSize(1.5), /partition size/);
});

test('toHex8 encodes the 8 digit lowercase field the protocol uses', () => {
  assert.equal(toHex8(0x1000), '00001000');
  assert.equal(toHex8(0), '00000000');
  assert.equal(toHex8(0xdeadbeef), 'deadbeef');
  assert.throws(() => toHex8(-1), RangeError);
  assert.throws(() => toHex8(0x100000000), RangeError);
});

test('cleanValue strips padding NULs, whitespace and the okay prefix', () => {
  assert.equal(cleanValue('0x00100000\u0000'), '0x00100000');
  assert.equal(cleanValue('unlocked\n'), 'unlocked');
  assert.equal(cleanValue('okay 0x00200000'), '0x00200000');
  assert.equal(cleanValue('okay0x00200000'), '0x00200000');
  assert.equal(cleanValue('OKAY: true'), 'true');
  assert.equal(cleanValue('okay'), '');
  assert.equal(cleanValue(''), '');
  assert.equal(cleanValue(enc('lock_state\u0000')), 'lock_state');
});

test('ResponseStream parses one message at a time and buffers partial input', () => {
  const stream = new ResponseStream();
  const reply = concatBytes(infoFrame('hello\n'), dataFrame(0x40), okayFrame());

  assert.equal(stream.next(), null, 'nothing buffered yet');
  stream.push(reply.subarray(0, 3));
  assert.equal(stream.next(), null, 'half a status word is not a message');
  stream.push(reply.subarray(3, 5));
  assert.equal(stream.next(), null, 'status without the length field is not a message');

  stream.push(reply.subarray(5));
  const first = stream.next();
  assert.equal(first.status, 'INFO');
  assert.equal(dec(first.payload), 'hello\n');

  const second = stream.next();
  assert.equal(second.status, 'DATA');
  assert.equal(second.length, 0x40, 'DATA length field is parsed into .length');
  assert.equal(second.payload.length, 0, 'DATA carries no payload of its own');

  const third = stream.next();
  assert.equal(third.status, 'OKAY');
  assert.equal(stream.next(), null);
});

test('ResponseStream rejects an unknown status word', () => {
  const stream = new ResponseStream();
  stream.push(enc('WHOOPS'));
  assert.throws(() => stream.next(), (err) => {
    assert.ok(err instanceof FastbootProtocolError);
    assert.match(err.message, /unexpected status word "WHOO/);
    return true;
  });
});

test('ResponseStream rejects a malformed length field', () => {
  const stream = new ResponseStream();
  stream.push(enc('INFOzzzzzzzz'));
  assert.throws(() => stream.next(), /invalid length field "zzzzzzzz"/);
});

test('FastbootClient refuses a transport that does not implement the interface', () => {
  assert.throws(() => new FastbootClient(null), TypeError);
  assert.throws(() => new FastbootClient({ write() {}, read() {} }), /flush\(\), setTimeout\(\)/);
  assert.ok(new FakeTransport() instanceof Transport === false, 'FakeTransport is a duck-typed transport, not a subclass');
  assert.equal(typeof createFastbootClient(new FakeTransport(), { timeout: 1 }).getVar, 'function');
});

/* ─────────────────────────── getvar / parsing ──────────────────────── */

test('getVar returns a single INFO payload and sends exactly one command', async () => {
  const { device, transport, client } = setup();
  assert.equal(await client.getVar('product'), 'Echo Dot (3rd gen)');
  assert.deepEqual(device.commands, ['getvar:product']);
  assert.equal(dec(transport.writes[0]), 'getvar:product');
  assert.equal(transport.writes.length, 1, 'no extra traffic');
  assert.equal(transport.flushCount, 1, 'input is flushed before the command');
});

test('getVar joins the multi INFO lines real bootloaders emit', async () => {
  const { device, client } = setup();
  const value = await client.getVar('lk_build_desc');
  assert.equal(value, 'lk 2.0 (LibreEcho)\nbuild 2026-01-02\nplatform mt8163');
  assert.equal(value.split('\n').length, 3);
  assert.deepEqual(device.commands, ['getvar:lk_build_desc']);
});

test('getVar handles partition sizes, unlock_status, serialno and max-download-size', async () => {
  const { client } = setup();
  assert.equal(await client.getVar('partition-size:boot_a'), '0x00020000');
  assert.equal(await client.getVar('partition-size:userdata'), '268435456');
  assert.equal(await client.getVar('unlock_status'), 'unlocked');
  assert.equal(await client.getVar('serialno'), 'G090LF0000000000');
  assert.equal(await client.getVar('max-download-size'), '0x1000');
  assert.equal(client.maxDownloadSize, 0x1000, 'max-download-size is cached for downloads');
  assert.equal(await client.getPartitionSize('boot_a'), 0x20000);
});

test('getVar tolerates an okay prefixed value, trailing NULs and a name echo', async () => {
  const transport = new FakeTransport({
    respond: (command) => {
      if (command === 'getvar:unlock_status') return [infoFrame('okay true\u0000'), okayFrame()];
      if (command === 'getvar:serialno') return [infoFrame('serialno: G090LF0000000000\n'), okayFrame()];
      if (command === 'getvar:max-download-size') return [enc('OKAY'), enc('okay0x00200000'), new Uint8Array([0])];
      if (command === 'getvar:partition-size:boot_a') return [infoFrame(''), okayFrame()];
      return [failFrame('nope')];
    },
  });
  const client = new FastbootClient(transport, { timeout: 100 });

  assert.equal(await client.getVar('unlock_status'), 'true');
  assert.equal(await client.getVar('serialno'), 'G090LF0000000000');
  // OKAY carrying the value in the same transfer, with a NUL terminator
  assert.equal(await client.getVar('max-download-size'), '0x00200000');
  assert.equal(client.maxDownloadSize, 0x200000);
  // empty INFO payload: an empty string, not a crash
  assert.equal(await client.getVar('partition-size:boot_a'), '');
});

test('getVar recovers a value that arrives in a second transfer after OKAY', async () => {
  const transport = new FakeTransport({ respond: () => [okayFrame(), enc('0x00000800\u0000')] });
  const client = new FastbootClient(transport, { timeout: 100 });
  assert.equal(await client.getVar('max-download-size'), '0x00000800');
  assert.equal(client.maxDownloadSize, 0x800);
});

test('FAIL propagates with the device reason instead of an empty error', async () => {
  const transport = new FakeTransport({
    respond: (command) => (command === 'getvar:serialno'
      ? [failFrame('Device not unlocked. Cannot get serial number.')]
      : [okayFrame()]),
  });
  const client = new FastbootClient(transport, { timeout: 100 });

  await assert.rejects(client.getVar('serialno'), (err) => {
    assert.ok(err instanceof FastbootFailError, 'is a FastbootFailError');
    assert.ok(err instanceof FastbootError, 'is a FastbootError');
    assert.equal(err.name, 'FastbootFailError');
    assert.equal(err.command, 'getvar:serialno');
    assert.equal(err.status, 'FAIL');
    assert.equal(err.reason, 'Device not unlocked. Cannot get serial number.');
    assert.match(err.message, /getvar:serialno/);
    assert.match(err.message, /Device not unlocked/);
    return true;
  });
});

test('a FAIL split across transfers still carries its reason', async () => {
  const transport = new FakeTransport({
    respond: (command) => (command === 'getvar:serialno'
      ? [enc('FA'), enc('IL'), enc('Device not'), enc(' unlocked')]
      : [failFrame('unexpected')]),
  });
  const client = new FastbootClient(transport, { timeout: 200 });
  await assert.rejects(client.getVar('serialno'), (err) => {
    assert.ok(err instanceof FastbootFailError);
    assert.equal(err.reason, 'Device not unlocked');
    return true;
  });
});

test('raw() reports FAIL and DATA without throwing, and never eats messages', async () => {
  const { client } = setup();
  const failure = await client.raw('oem unlock');
  assert.equal(failure.status, 'OKAY');
  assert.deepEqual(failure.info, ['(bootloader) oem ok']);

  const transport = new FakeTransport({ respond: () => [failFrame('partition not found')] });
  const other = new FastbootClient(transport, { timeout: 100 });
  const res = await other.raw('flash:does_not_exist');
  assert.equal(res.status, 'FAIL', 'raw() does not throw on a device FAIL');
  assert.equal(dec(res.data), 'partition not found', 'the reason is exposed as bytes');
  assert.deepEqual(res.info, []);
});

test('a response split into single byte reads is reassembled', async () => {
  const reply = concatBytes(infoFrame('G090LF0000000000\n'), okayFrame());
  const transport = new FakeTransport({
    respond: (command) => (command === 'getvar:serialno' ? shatter(reply, 1) : [failFrame('nope')]),
  });
  const client = new FastbootClient(transport, { timeout: 200 });
  assert.equal(await client.getVar('serialno'), 'G090LF0000000000');
});

test('two messages in one read are both parsed', async () => {
  const combined = concatBytes(infoFrame('Echo Dot (3rd gen)\n'), infoFrame('extra line\n'), okayFrame());
  const transport = new FakeTransport({
    respond: (command) => (command === 'getvar:product' ? [combined] : [failFrame('nope')]),
  });
  const client = new FastbootClient(transport, { timeout: 200 });

  const res = await client.raw('getvar:product');
  assert.equal(res.status, 'OKAY');
  assert.deepEqual(res.info, ['Echo Dot (3rd gen)', 'extra line']);
  assert.equal(await client.getVar('product'), 'Echo Dot (3rd gen)\nextra line');
});

test('TEXT frames are collected like INFO frames', async () => {
  const transport = new FakeTransport({
    respond: () => [textFrame('(bootloader) 100%\n'), okayFrame()],
  });
  const client = new FastbootClient(transport, { timeout: 100 });
  const res = await client.raw('flash:system');
  assert.deepEqual(res.info, ['(bootloader) 100%']);
});

/* ────────────────────────────── download ───────────────────────────── */

test('download splits the image by max-download-size and honours the DATA window', async () => {
  const { device, transport, client } = setup(); // device reports max-download-size 0x1000
  const data = Uint8Array.from({ length: 0x2500 }, (_, i) => (i * 7 + 3) & 0xff);
  const progress = [];

  const sent = await client.download(data, { onProgress: (done, total) => progress.push([done, total]) });

  assert.equal(sent, data.length);
  assert.deepEqual(device.commands, [
    'getvar:max-download-size',
    'download:00001000',
    'download:00001000',
    'download:00000500',
  ]);
  assert.deepEqual(state_payloadLengths(device), [0x1000, 0x1000, 0x500]);
  assert.deepEqual(progress, [[0x1000, 0x2500], [0x2000, 0x2500], [0x2500, 0x2500]]);
  const written = concatBytes(...device.state.payloads);
  assert.equal(written.length, data.length);
  assert.deepEqual(written, data, 'every byte reaches the device, in order and once');

  assert.equal(transport.writes.length, 7, 'getvar + (download: + payload) per chunk');
  assert.equal(dec(transport.writes[0]), 'getvar:max-download-size');
  assert.equal(dec(transport.writes[1]), 'download:00001000');
  assert.equal(transport.writes[2].length, 0x1000, 'first payload chunk');
  assert.equal(dec(transport.writes[5]), 'download:00000500');
  assert.equal(transport.writes[6].length, 0x500, 'last payload chunk');
});

test('download narrows the chunk size when the device offers a smaller window', async () => {
  const { device, client } = setup({ offeredChunk: 0x800 });
  const data = new Uint8Array(0x2500);
  await client.download(data);

  assert.deepEqual(device.commands, [
    'getvar:max-download-size',
    'download:00001000', // asked for 0x1000, offered 0x800
    'download:00000800',
    'download:00000800',
    'download:00000800',
    'download:00000500',
  ]);
  assert.equal(client.maxDownloadSize, 0x800, 'the window the device really offered is remembered');
});

test('download respects an explicit chunkSize cap', async () => {
  const { device, client } = setup({ vars: { 'max-download-size': '0x10000' } });
  const data = new Uint8Array(0x1000);
  await client.download(data, { chunkSize: 0x400 });

  assert.deepEqual(device.commands, [
    'getvar:max-download-size',
    'download:00000400',
    'download:00000400',
    'download:00000400',
    'download:00000400',
  ]);
});

test('download queries max-download-size only once', async () => {
  const { device, client } = setup();
  await client.download(new Uint8Array(0x800));
  await client.download(new Uint8Array(0x800));
  const queries = device.commands.filter((c) => c === 'getvar:max-download-size');
  assert.equal(queries.length, 1);
  assert.equal(device.state.payloads.length, 2);
});

test('download falls back to the default chunk size when the device has no max-download-size', async () => {
  const { device, client } = setup({
    vars: { 'max-download-size': undefined },
    onCommand: (command) => (command === 'getvar:max-download-size' ? [failFrame('unknown variable: max-download-size')] : undefined),
  });
  const data = new Uint8Array(10);
  await client.download(data);
  assert.equal(client.maxDownloadSize, null, 'nothing was cached');
  assert.deepEqual(device.commands, ['getvar:max-download-size', 'download:0000000a']);
  assert.ok(DEFAULT_MAX_DOWNLOAD_SIZE >= 0x100000);
});

test('download halves the image across many split reads', async () => {
  const data = Uint8Array.from({ length: 0x1200 }, (_, i) => (i * 13 + 1) & 0xff);
  const transport = new FakeTransport();
  const device = makeDevice();
  transport.respond = (command, self, rawBytes) => {
    const reply = device.respond(command, self, rawBytes);
    // every chunk of the reply arrives in 3 byte pieces
    return reply ? reply.flatMap((chunk) => shatter(chunk, 3)) : reply;
  };
  const client = new FastbootClient(transport, { timeout: 500 });

  await client.download(data, { chunkSize: 0x800 });
  assert.deepEqual(concatBytes(...device.state.payloads), data);
  assert.deepEqual(device.commands, [
    'getvar:max-download-size',
    'download:00000800',
    'download:00000800',
    'download:00000200',
  ]);
});

test('download reports FAIL from the device with the reason and stops', async () => {
  const { device, client } = setup({
    onPayload: (count) => (count === 2 ? [failFrame('download buffer overflow')] : undefined),
  });
  const data = new Uint8Array(0x2500);

  await assert.rejects(client.download(data), (err) => {
    assert.ok(err instanceof FastbootFailError);
    assert.equal(err.reason, 'download buffer overflow');
    assert.equal(err.command, 'download:00001000');
    assert.match(err.message, /download:00001000/);
    return true;
  });
  assert.equal(device.state.payloads.length, 2, 'stopped after the failed chunk');
  assert.deepEqual(device.commands, ['getvar:max-download-size', 'download:00001000', 'download:00001000']);
});

test('download propagates a FAIL to the download command itself', async () => {
  const { device, client } = setup({
    onCommand: (command) => (command.startsWith('download:') ? [failFrame('partition table says no')] : undefined),
  });
  await assert.rejects(client.download(new Uint8Array(0x100)), FastbootFailError);
  assert.equal(device.state.payloads.length, 0, 'no payload was sent');
});

test('download rejects a device that answers OKAY instead of DATA', async () => {
  const transport = new FakeTransport({ respond: () => [okayFrame()] });
  const client = new FastbootClient(transport, { timeout: 100 });
  client.maxDownloadSize = 0x1000;
  await assert.rejects(client.download(new Uint8Array(4)), (err) => {
    assert.ok(err instanceof FastbootProtocolError);
    assert.match(err.message, /expected DATA/);
    return true;
  });
});

test('download surfaces INFO progress lines while acknowledging a chunk', async () => {
  const lines = [];
  const { client } = setup({
    onPayload: () => [infoFrame('(bootloader) writing chunk\n'), okayFrame()],
  });
  await client.download(new Uint8Array(0x100), { onInfo: (line) => lines.push(line) });
  assert.deepEqual(lines, ['(bootloader) writing chunk']);
});

test('download accepts an ArrayBuffer, a view and a Blob', async () => {
  const { device, client } = setup({ vars: { 'max-download-size': '0x10000' } });
  const source = Uint8Array.from({ length: 8 }, (_, i) => i + 1);

  await client.download(source.buffer);
  await client.download(new DataView(source.buffer));
  await client.download(new Blob([source]));
  await client.download([1, 2, 3, 4, 5, 6, 7, 8]);

  assert.equal(device.state.payloads.length, 4);
  for (const payload of device.state.payloads) assert.deepEqual(payload, source);
  await assert.rejects(client.download('not bytes'), TypeError);
});

/* ─────────────────────── flash / erase / lifecycle ─────────────────── */

test('flash downloads the image and then writes the partition', async () => {
  const { device, transport, client } = setup();
  const image = Uint8Array.from({ length: 0x200 }, (_, i) => (i * 3) & 0xff);

  const result = await client.flash('boot_a', image);

  assert.deepEqual(device.commands, ['getvar:max-download-size', 'download:00000200', 'flash:boot_a']);
  assert.deepEqual(result, { bytes: 0x200, info: ['Sending sparse image...'] });
  assert.deepEqual(device.state.payloads[0], image);
  assert.equal(dec(transport.writes[0]), 'getvar:max-download-size');
  assert.equal(dec(transport.writes[1]), 'download:00000200');
  assert.deepEqual(transport.writes[2], image, 'the raw image goes out between download: and flash:');
  assert.equal(dec(transport.writes[3]), 'flash:boot_a', 'flash is only sent after the payload');
});

test('flash without bytes writes the partition from the download buffer', async () => {
  const { device, client } = setup();
  const result = await client.flash('system');
  assert.deepEqual(device.commands, ['flash:system']);
  assert.deepEqual(device.state.payloads, []);
  assert.equal(result.bytes, 0);
  assert.deepEqual(result.info, ['Sending sparse image...']);
});

test('flash propagates a FAIL with the bootloader reason and the command name', async () => {
  const { client } = setup({
    onCommand: (command) => (command === 'flash:boot_a' ? [failFrame('Image is not a boot image')] : undefined),
  });
  await assert.rejects(client.flash('boot_a', new Uint8Array(0x100)), (err) => {
    assert.ok(err instanceof FastbootFailError);
    assert.equal(err.command, 'flash:boot_a');
    assert.equal(err.reason, 'Image is not a boot image');
    return true;
  });
});

test('erase sends erase:<partition> and returns the bootloader INFO lines', async () => {
  const { device, client } = setup({
    onCommand: (command) => (command === 'erase:expdb' ? [infoFrame('(bootloader) erasing\n'), okayFrame()] : undefined),
  });
  const lines = await client.erase('expdb');
  assert.deepEqual(device.commands, ['erase:expdb']);
  assert.deepEqual(lines, ['(bootloader) erasing']);
  assert.deepEqual(device.state.payloads, [], 'erase never sends a payload');
});

test('erase propagates a FAIL with the reason', async () => {
  const { client } = setup({
    onCommand: (command) => (command === 'erase:misc' ? [failFrame('permission denied')] : undefined),
  });
  await assert.rejects(client.erase('misc'), (err) => {
    assert.ok(err instanceof FastbootFailError);
    assert.equal(err.reason, 'permission denied');
    assert.equal(err.command, 'erase:misc');
    return true;
  });
});

test('reboot, continue and power tolerate a device that never answers', async () => {
  const { device, client } = setup();
  assert.equal(await client.reboot(), false, 'silent device: reported as not acknowledged');
  assert.equal(await client.continue(), false);
  assert.equal(await client.power(), false);
  assert.deepEqual(device.commands, ['reboot', 'continue', 'power']);

  assert.equal(await client.reboot('bootloader'), false);
  assert.equal(await client.power('powerdown'), false);
  assert.deepEqual(device.commands.slice(3), ['reboot-bootloader', 'powerdown']);
});

test('reboot reports true when the bootloader does acknowledge', async () => {
  const { client } = setup({
    onCommand: (command) => (command === 'reboot' ? [okayFrame()] : undefined),
  });
  assert.equal(await client.reboot(), true);
});

test('oemCommand sends "oem <cmd>" and returns the INFO text', async () => {
  const { device, client } = setup();
  const text = await client.oemCommand('device-info');
  assert.equal(text, '(bootloader) oem ok');
  assert.deepEqual(device.commands, ['oem device-info']);
});

test('oemCommand throws with the vendor reason on FAIL', async () => {
  const { client } = setup({
    onCommand: (command) => (command === 'oem unlock' ? [failFrame('unlock not allowed')] : undefined),
  });
  await assert.rejects(client.oemCommand('unlock'), (err) => {
    assert.ok(err instanceof FastbootFailError);
    assert.equal(err.reason, 'unlock not allowed');
    assert.match(err.message, /oem unlock/);
    return true;
  });
});

/* ──────────────────────────── timeout path ─────────────────────────── */

test('a silent device times out with the command name and the timeout in the error', async () => {
  const transport = new FakeTransport(); // nothing queued, no responder: the device is mute
  const client = new FastbootClient(transport, { timeout: 250 });

  const started = Date.now();
  await assert.rejects(client.getVar('product'), (err) => {
    assert.ok(err instanceof FastbootTimeoutError);
    assert.ok(err instanceof FastbootError);
    assert.equal(err.name, 'FastbootTimeoutError');
    assert.equal(err.command, 'getvar:product');
    assert.equal(err.timeoutMs, 250);
    assert.match(err.message, /timed out after 250ms/);
    assert.match(err.message, /getvar:product/);
    return true;
  });
  assert.ok(Date.now() - started < 2000, 'the timeout is enforced, not a hang');
  assert.deepEqual(transport.timeoutValues[0], 250, 'the client pushed its timeout into the transport');
  assert.equal(dec(transport.writes[0]), 'getvar:product');
});

test('download times out naming the download command when the device goes quiet', async () => {
  const transport = new FakeTransport();
  const client = new FastbootClient(transport, { timeout: 100 });
  await assert.rejects(client.download(new Uint8Array(0x100)), (err) => {
    assert.ok(err instanceof FastbootTimeoutError);
    assert.equal(err.command, 'download:00000100');
    assert.equal(err.timeoutMs, 100);
    return true;
  });
  assert.ok(client.maxDownloadSize === null, 'the failed getvar did not poison the cached window');
});

test('a transport failure is reported with the command that was in flight', async () => {
  const transport = new FakeTransport({ respond: () => [okayFrame()] });
  transport.read = async () => { throw new Error('device disconnected'); };
  const client = new FastbootClient(transport, { timeout: 100 });
  await assert.rejects(client.getVar('product'), (err) => {
    assert.ok(err instanceof FastbootError);
    assert.ok(!(err instanceof FastbootTimeoutError));
    assert.equal(err.command, 'getvar:product');
    assert.match(err.message, /device disconnected/);
    assert.ok(err.cause instanceof Error, 'the transport error is preserved as the cause');
    return true;
  });
});

test('a write failure is reported with the command that was in flight', async () => {
  const transport = new FakeTransport();
  transport.write = async () => { throw new Error('LIBUSB_TRANSFER_ERROR'); };
  const client = new FastbootClient(transport, { timeout: 100 });
  await assert.rejects(client.erase('expdb'), /transport failed to send "erase:expdb": LIBUSB_TRANSFER_ERROR/);
});

/* ───────────────────── WebUSB transport (no hardware) ──────────────── */

/**
 * A faithful in-memory USBDevice: writes are recorded, reads park until fed
 * (like a real bulk endpoint), so the transport's buffering can be tested.
 */
function fakeUsbDevice({ packetSize = 64, interfaces = null, opened = false, claimFails = false } = {}) {
  const plan = interfaces ?? [makeInterface(0, 0xff, packetSize)];
  const incoming = [];
  const waiters = [];
  const device = {
    vendorId: 0x18d1,
    productId: 0x4ee0,
    productName: 'Echo (fastboot)',
    manufacturerName: 'Amazon',
    serialNumber: 'G090LF0000000000',
    opened,
    selectedConfiguration: opened ? 1 : null,
    configuration: opened ? { configurationValue: 1, interfaces: plan } : null,
    claimed: [],
    released: [],
    written: [],
    haltCleared: [],
    resetCalled: 0,
    async open() { this.opened = true; },
    async selectConfiguration(value) {
      this.selectedConfiguration = value;
      this.configuration = { configurationValue: value, interfaces: plan };
    },
    async selectAlternateInterface(number, setting) { this.selectedAlternate = [number, setting]; },
    async claimInterface(number) {
      if (claimFails) throw new Error('Access denied');
      this.claimed.push(number);
    },
    async releaseInterface(number) { this.released.push(number); },
    async close() { this.closed = true; },
    async transferOut(number, data) {
      this.written.push({ endpoint: number, data: Uint8Array.from(data) });
      return { status: 'ok', bytesWritten: data.byteLength };
    },
    /** Resolve the oldest parked request, or queue the chunk for the next one. */
    feed(chunk) {
      const waiter = waiters.shift();
      if (waiter) waiter({ status: 'ok', data: new DataView(Uint8Array.from(chunk).buffer) });
      else incoming.push(chunk);
    },
    transferIn(number, length) {
      const next = incoming.shift();
      if (next) return Promise.resolve({ status: 'ok', data: new DataView(Uint8Array.from(next).buffer) });
      return new Promise((resolve) => waiters.push(resolve));
    },
    async clearHalt(direction, number) { this.haltCleared.push([direction, number]); },
    async reset() { this.resetCalled += 1; },
  };
  return device;
}

/** @param {number} base first endpoint number (out), in is base+1 */
function bulkEndpoints(base, packetSize) {
  return [
    { endpointNumber: base, direction: 'out', type: 'bulk', packetSize },
    { endpointNumber: base + 1, direction: 'in', type: 'bulk', packetSize },
  ];
}

/** @param {number} number @param {number} interfaceClass @param {number} packetSize */
function makeInterface(number, interfaceClass, packetSize) {
  const alternate = { alternateSetting: 0, interfaceClass, endpoints: bulkEndpoints(number * 2 + 1, packetSize) };
  return { interfaceNumber: number, alternate, alternates: [alternate] };
}

/** @param {ReturnType<typeof makeDevice>} device @returns {number[]} */
function state_payloadLengths(device) {
  return device.state.payloads.map((payload) => payload.length);
}

test('UsbFastbootTransport is a Transport and exposes the documented helpers', () => {
  assert.equal(Object.getPrototypeOf(UsbFastbootTransport.prototype), Transport.prototype);
  assert.equal(WebUsbFastbootTransport, UsbFastbootTransport, 'both names refer to the same class');
  for (const name of ['open', 'fromDevice', 'requestDevice', 'findPairedDevice', 'isSupported']) {
    assert.equal(typeof UsbFastbootTransport[name], 'function', `static ${name}()`);
  }
  for (const name of ['write', 'read', 'flush', 'setTimeout', 'close', 'releaseInterface', 'reset', 'describe']) {
    assert.equal(typeof UsbFastbootTransport.prototype[name], 'function', `instance ${name}()`);
  }
  assert.equal(UsbFastbootTransport.isSupported(), Boolean(globalThis.navigator?.usb));
  if (!globalThis.navigator?.usb) {
    assert.equal(UsbFastbootTransport.isSupported(), false);
  }
});

test('WebUSB filters cover the Android fastboot ids and the 0xFF vendor class', () => {
  assert.ok(DEFAULT_FASTBOOT_FILTERS.some((f) => f.vendorId === 0x18d1));
  assert.ok(DEFAULT_FASTBOOT_FILTERS.some((f) => f.classCode === 0xff));
  const android = androidFastbootFilters();
  assert.equal(android.length, 8);
  assert.deepEqual(android[0], { vendorId: 0x18d1, productId: 0x4ee0 });
  assert.deepEqual(android[7], { vendorId: 0x18d1, productId: 0x4ee7 });
});

test('opening without WebUSB fails with a message that says what to do', async () => {
  if (globalThis.navigator?.usb) return; // real WebUSB present: nothing to assert here
  await assert.rejects(UsbFastbootTransport.open(), /WebUSB is not available/);
  await assert.rejects(UsbFastbootTransport.open({ vendorId: 0x18d1 }), /navigator\.usb is missing/);
  await assert.rejects(UsbFastbootTransport.findPairedDevice(), /WebUSB is not available/);
  assert.throws(() => UsbFastbootTransport.usb, /WebUSB is not available/);
  await assert.rejects(UsbFastbootTransport.requestDevice([]), /filter array is empty/);
  await assert.rejects(UsbFastbootTransport.requestDevice('nope'), /filter must be an object/);
});

test('fromDevice opens, claims the vendor specific interface and splits writes', async () => {
  const device = fakeUsbDevice({ packetSize: 4 });
  const transport = await UsbFastbootTransport.fromDevice(device, { timeout: 40 });

  assert.equal(device.opened, true, 'the device is opened');
  assert.equal(device.selectedConfiguration, 1, 'configuration 1 is selected');
  assert.deepEqual(device.claimed, [0], 'the fastboot interface is claimed');
  assert.equal(transport.interfaceClass, 0xff);
  assert.equal(transport.outEndpointNumber, 1);
  assert.equal(transport.inEndpointNumber, 2);
  assert.equal(transport.outPacketSize, 4);

  await transport.write(enc('getvar:product')); // 14 bytes, 4 byte packets
  assert.deepEqual(device.written.map((w) => w.data.length), [4, 4, 4, 2]);
  assert.deepEqual(device.written.map((w) => w.endpoint), [1, 1, 1, 1]);
  assert.equal(dec(concatBytes(...device.written.map((w) => w.data))), 'getvar:product');

  const info = transport.describe();
  assert.equal(info.productName, 'Echo (fastboot)');
  assert.equal(info.interfaceNumber, 0);
  assert.equal(info.outPacketSize, 4);

  await transport.close();
  assert.deepEqual(device.released, [0]);
  assert.equal(device.closed, true, 'close() closes the device');
  await assert.rejects(transport.write(enc('OKAY')), /transport is closed/);
});

test('the WebUSB transport never loses bytes across a timeout', async () => {
  const device = fakeUsbDevice({ packetSize: 64, opened: true });
  const transport = await UsbFastbootTransport.fromDevice(device, { timeout: 40 });
  transport.setTimeout(40);

  assert.equal(await transport.read(), null, 'silent device: null, not a hang');
  device.feed(enc('OKAY'));
  assert.equal(dec(await transport.read()), 'OKAY', 'the parked transfer delivers the late bytes');

  device.feed(enc('stale-1'));
  device.feed(enc('stale-2'));
  await transport.flush();
  assert.equal(await transport.read(), null, 'flush() discarded both stale chunks');

  device.feed(enc('FAILreason'));
  assert.equal(dec(await transport.read()), 'FAILreason', 'the transport is usable after a flush');
  await transport.close();
});

test('fromDevice prefers the vendor specific interface when several expose bulk pairs', async () => {
  const device = fakeUsbDevice({ interfaces: [makeInterface(0, 0x08, 512), makeInterface(1, 0xff, 512)] });
  const transport = await UsbFastbootTransport.fromDevice(device, { timeout: 10 });
  assert.equal(transport.interfaceNumber, 1, 'the class 0xFF interface wins over mass storage');
  assert.deepEqual(device.claimed, [1]);
  await transport.close();
});

test('fromDevice explains itself when the device is not in fastboot mode', async () => {
  const device = fakeUsbDevice({
    interfaces: [{ interfaceNumber: 0, alternate: { alternateSetting: 0, interfaceClass: 0x08, endpoints: [bulkEndpoints(1, 64)[0]] }, alternates: [] }],
  });
  await assert.rejects(UsbFastbootTransport.fromDevice(device), /no bulk IN\/OUT endpoint pair/);
  await assert.rejects(UsbFastbootTransport.fromDevice(null), TypeError);
});

test('fromDevice reports a denied interface claim with remediation', async () => {
  const device = fakeUsbDevice({ claimFails: true });
  await assert.rejects(UsbFastbootTransport.fromDevice(device), /could not claim interface 0[\s\S]*Close every other program/);
});

test('a full getvar round trip runs through the WebUSB transport', async () => {
  const device = fakeUsbDevice({ packetSize: 512, opened: true });
  // answer the command the way a real device does: on receipt
  const reply = concatBytes(infoFrame('Echo Dot (3rd gen)\n'), okayFrame());
  device.transferOut = async (number, data) => {
    device.written.push({ endpoint: number, data: Uint8Array.from(data) });
    device.feed(reply);
    return { status: 'ok', bytesWritten: data.byteLength };
  };
  const transport = await UsbFastbootTransport.fromDevice(device, { timeout: 50 });
  const client = new FastbootClient(transport, { timeout: 50 });

  assert.equal(await client.getVar('product'), 'Echo Dot (3rd gen)');
  assert.equal(dec(concatBytes(...device.written.map((w) => w.data))), 'getvar:product');
  assert.equal(transport.describe().inPacketSize, 512);
  await transport.close();
});
