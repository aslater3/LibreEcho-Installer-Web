/**
 * test_adb.mjs — node:test suite for adb.js / webusb-adb-transport.js.
 *
 * Everything is driven by a scripted fake adbd (a real protocol peer: it parses
 * host messages, verifies header magic and payload checksums, and answers in
 * protocol) over an in-memory Transport. No device, no npm dependencies.
 *
 *   node --test test_adb.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

import {
  AdbClient,
  AdbError,
  AdbFailError,
  AdbTimeoutError,
  AdbAuthRequiredError,
  Sha256,
  sha256Hex,
  cstring,
  toHex,
  ascii4,
  readU32LE,
  writeU32LE,
  concatBytes,
  A_CNXN,
  A_AUTH,
  A_OPEN,
  A_OKAY,
  A_CLSE,
  A_WRTE,
  A_FAIL,
  HEADER_SIZE,
  MAX_PAYLOAD,
  SYNC_DATA_MAX,
} from './adb.js';

import {
  WebUsbAdbTransport,
  TWRP_USB_FILTERS,
  findAdbInterface,
  isDisconnectError,
  isWebUsbAvailable,
} from './webusb-adb-transport.js';

// Node >= 18 exposes globalThis.crypto; older runtimes need node:crypto.
globalThis.crypto ??= webcrypto;

/* -------------------------------------------------------------------------- */
/* local (independent) protocol helpers — deliberately NOT adb.js's own       */
/* -------------------------------------------------------------------------- */

const EMPTY = new Uint8Array(0);
const enc = new TextEncoder();

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Temporary tracing, enabled with ADB_DEBUG=1. */
const DEBUG = !!process.env.ADB_DEBUG;
const dbg = (...args) => {
  if (DEBUG) console.error('[adbd]', ...args);
};

const cat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

/** Independent LE writers so the fake adbd does not share code with adb.js. */
function u32le(value) {
  const v = value >>> 0;
  return new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
}

function rdU32(bytes, off) {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}

/** Independent ADB checksum: sum of bytes mod 2^32. */
function sum32(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) % 4294967296;
  return sum;
}

/** Build a device-side ADB frame with the independent helpers above. */
function frame(command, arg0, arg1, payload = EMPTY) {
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  out.set(u32le(command), 0);
  out.set(u32le(arg0), 4);
  out.set(u32le(arg1), 8);
  out.set(u32le(payload.length), 12);
  out.set(u32le(sum32(payload)), 16);
  out.set(u32le(command ^ 0xffffffff), 20);
  out.set(payload, HEADER_SIZE);
  return out;
}

function text4(bytes) {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

/* -------------------------------------------------------------------------- */
/* fake transport                                                             */
/* -------------------------------------------------------------------------- */

/** Host-side Transport backed by an in-memory queue. */
class FakeTransport {
  constructor() {
    /** @type {FakeAdbd|null} */
    this.adbd = null;
    /** @type {Uint8Array[]} */
    this.writes = [];
    /** @type {Uint8Array[]} every chunk handed to AdbClient.read() */
    this.reads = [];
    /** @type {number[]} the size of every chunk handed to AdbClient.read() */
    this.readSizes = [];
    /** @type {number[]} every value passed to Transport.setTimeout() */
    this.timeouts = [];
    this.flushes = 0;
    this.closed = false;
    this._queue = [];
    this._waiter = null;
  }

  setTimeout(ms) {
    this.timeouts.push(ms);
    return Promise.resolve();
  }

  async flush() {
    this.flushes += 1;
  }

  async write(bytes) {
    this.writes.push(bytes.slice());
    if (this.adbd) await this.adbd.onHostData(bytes);
  }

  /** @returns {Promise<Uint8Array|null>} */
  async read() {
    if (this._queue.length > 0) {
      const chunk = this._queue.shift();
      this.reads.push(chunk);
      this.readSizes.push(chunk.length);
      return chunk;
    }
    if (this.closed) return null;
    return new Promise((resolve) => {
      this._waiter = resolve;
    });
  }

  /** Device -> host bytes. Each `feed` becomes exactly one `read()` result. */
  feed(bytes) {
    if (!bytes || bytes.length === 0) return;
    const waiter = this._waiter;
    if (waiter) {
      this._waiter = null;
      this.reads.push(bytes);
      this.readSizes.push(bytes.length);
      waiter(bytes);
      return;
    }
    this._queue.push(bytes);
  }

  async close() {
    this.closed = true;
    const waiter = this._waiter;
    if (waiter) {
      this._waiter = null;
      waiter(null);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* fake adbd (scripted protocol peer)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Scripted adbd. Implements CNXN/AUTH, OPEN, WRTE flow control, CLSE and the
 * `sync:` service (SEND/DATA/DONE/STAT/QUIT) against a virtual filesystem.
 */
class FakeAdbd {
  constructor(transport, options = {}) {
    this.transport = transport;
    transport.adbd = this;
    this.banner = options.banner ?? 'device::Amazon Echo Gen 2 (TWRP 3.7)';
    this.maxData = options.maxData ?? MAX_PAYLOAD;
    this.version = 0x01000000;

    // scripted behaviours
    this.authRequired = false;
    this.silent = false; // receive but never answer anything
    this.ignoreOpen = false; // handshake only, no stream replies
    this.holdShell = false; // archive shell streams that never close
    this.ackWrites = true; // send the transport-level OKAY for every host WRTE
    this.autoFlush = true;
    this.chunkBytes = null; // deliver N bytes per host read when autoFlush

    /** @type {Map<string, string>} service -> FAIL text */
    this.failOpen = new Map();
    /** @type {Map<string, number>} path -> errno for SEND */
    this.failSend = new Map();
    /** @type {Map<string, number>} path -> errno for STAT */
    this.failStat = new Map();
    /** @type {Map<string, {chunks?: string[], out?: string}>} command -> output */
    this.shellResponses = new Map();
    this.defaultShellResponse = (cmd) => ({ chunks: [`/sbin/sh: ${cmd}: not found\n`] });
    /** @type {Map<string, {mode:number,size:number,mtime:number,data:Uint8Array}>} */
    this.files = new Map();

    // observations
    /** @type {string[]} protocol violations seen from the host */
    this.errors = [];
    /** @type {any[]} every message received from the host */
    this.messages = [];
    this.stats = {
      cnxn: 0,
      open: 0,
      okaySent: 0,
      okayReceived: 0,
      wrteSent: 0,
      wrteReceived: 0,
      wrteChecksumOk: 0,
      clseSent: 0,
      clseReceived: 0,
      failSent: 0,
      shellRuns: 0,
      syncOkaySent: 0,
      syncFailSent: 0,
      quits: 0,
      bytesReceived: 0,
    };

    this.streamsByHost = new Map();
    this.streamsByDevice = new Map();
    this.nextDeviceId = 100;
    this._in = EMPTY;
    this._out = EMPTY;
  }

  /* ------------------------------ host input ----------------------------- */

  onHostData(bytes) {
    this.stats.bytesReceived += bytes.length;
    this._in = this._in.length ? cat(this._in, bytes) : bytes.slice();
    this._parseHost();
  }

  _parseHost() {
    while (this._in.length >= HEADER_SIZE) {
      const command = rdU32(this._in, 0);
      const arg0 = rdU32(this._in, 4);
      const arg1 = rdU32(this._in, 8);
      const dataLength = rdU32(this._in, 12);
      const dataChecksum = rdU32(this._in, 16);
      const magic = rdU32(this._in, 20);
      if (magic !== ((command ^ 0xffffffff) >>> 0)) {
        this.errors.push(`bad header magic 0x${magic.toString(16)} for command 0x${command.toString(16)}`);
      }
      if (dataLength > MAX_PAYLOAD + 1024) {
        this.errors.push(`data_length ${dataLength} is implausible`);
        this._in = EMPTY;
        return;
      }
      if (this._in.length < HEADER_SIZE + dataLength) return;
      const payload = this._in.slice(HEADER_SIZE, HEADER_SIZE + dataLength);
      this._in = this._in.subarray(HEADER_SIZE + dataLength).slice();
      const actual = sum32(payload);
      if (actual !== dataChecksum) {
        this.errors.push(
          `checksum mismatch for command 0x${command.toString(16)}: got ${actual}, header says ${dataChecksum}`
        );
      } else if (command === A_WRTE) {
        this.stats.wrteChecksumOk += 1;
      }
      const message = { command, arg0, arg1, dataLength, dataChecksum, payload, text: cstring(payload) };
      this.messages.push(message);
      this._handle(message);
    }
  }

  _handle(message) {
    dbg('<-', '0x' + message.command.toString(16), 'arg0=' + message.arg0, 'arg1=' + message.arg1, 'len=' + message.dataLength);
    switch (message.command) {
      case A_CNXN: {
        this.stats.cnxn += 1;
        if (this.authRequired) {
          this._send(A_AUTH, 0, 0, new Uint8Array(20).fill(0x42));
        } else {
          this._send(A_CNXN, this.version, this.maxData, enc.encode(`${this.banner}\0`));
        }
        return;
      }
      case A_OPEN: {
        this.stats.open += 1;
        const service = message.text;
        const hostId = message.arg0;
        if (this.ignoreOpen) return;
        const failText = this.failOpen.get(service);
        if (failText) {
          this._send(A_FAIL, 0, hostId, enc.encode(failText));
          return;
        }
        const deviceId = this.nextDeviceId++;
        const stream = {
          hostId,
          deviceId,
          service,
          buf: EMPTY,
          file: null,
          stdin: EMPTY,
          quit: false,
        };
        this.streamsByHost.set(hostId, stream);
        this.streamsByDevice.set(deviceId, stream);
        this._send(A_OKAY, deviceId, hostId);
        if (service === 'sync:') return;
        if (service.startsWith('shell:')) {
          this._runShell(stream, service.slice('shell:'.length));
          return;
        }
        this._send(A_CLSE, deviceId, hostId);
        return;
      }
      case A_WRTE: {
        this.stats.wrteReceived += 1;
        // Inbound host->device: arg1 is the DEVICE's own stream id (adb's
        // find_local_socket(arg1, arg0) convention).
        const stream = this.streamsByDevice.get(message.arg1);
        if (!stream) return;
        if (this.ackWrites) this._send(A_OKAY, stream.deviceId, stream.hostId); // flow control: consumed
        if (stream.service === 'sync:') this._onSyncBytes(stream, message.payload);
        else stream.stdin = cat(stream.stdin, message.payload);
        return;
      }
      case A_OKAY: {
        this.stats.okayReceived += 1;
        return;
      }
      case A_CLSE: {
        this.stats.clseReceived += 1;
        const stream = this.streamsByDevice.get(message.arg1);
        if (stream) {
          this.streamsByDevice.delete(message.arg1);
          this.streamsByHost.delete(stream.hostId);
        }
        return;
      }
      default:
        this.errors.push(`unexpected command 0x${message.command.toString(16)} from host`);
    }
  }

  /* ------------------------------ host output ---------------------------- */

  _send(command, arg0, arg1, payload = EMPTY) {
    if (this.silent) return;
    dbg('->', '0x' + command.toString(16), 'arg0=' + arg0, 'arg1=' + arg1, 'len=' + payload.length);
    this._out = cat(this._out, frame(command, arg0, arg1, payload));
    if (command === A_OKAY) this.stats.okaySent += 1;
    if (command === A_WRTE) this.stats.wrteSent += 1;
    if (command === A_CLSE) this.stats.clseSent += 1;
    if (command === A_FAIL) this.stats.failSent += 1;
    if (this.autoFlush) this.pump();
  }

  /** Number of device bytes still queued for the host. */
  get buffered() {
    return this._out.length;
  }

  /** Deliver everything queued, honouring `chunkBytes` when set. */
  pump() {
    while (this._out.length > 0) {
      const n = this.chunkBytes ? Math.min(this.chunkBytes, this._out.length) : this._out.length;
      const chunk = this._out.slice(0, n);
      this._out = this._out.subarray(n).slice();
      this.transport.feed(chunk);
    }
  }

  /** Feed exactly `n` queued bytes as a single host read (for split tests). */
  releaseBytes(n) {
    if (this._out.length === 0) return 0;
    const take = Math.min(n, this._out.length);
    const chunk = this._out.slice(0, take);
    this._out = this._out.subarray(take).slice();
    this.transport.feed(chunk);
    return chunk.length;
  }

  /** Feed all queued device bytes as a single host read. */
  releaseAll() {
    const n = this._out.length;
    if (n > 0) this.releaseBytes(n);
    return n;
  }

  /* -------------------------------- shell -------------------------------- */

  _runShell(stream, command) {
    this.stats.shellRuns += 1;
    if (this.holdShell) return;
    const response = this.shellResponses.get(command) ?? this.defaultShellResponse(command);
    const chunks = response.chunks ?? [response.out ?? ''];
    for (const chunk of chunks) {
      this._send(A_WRTE, stream.deviceId, stream.hostId, enc.encode(chunk));
    }
    this._send(A_CLSE, stream.deviceId, stream.hostId);
  }

  /** The currently open shell stream, if any (used to script streaming output). */
  shellStream() {
    for (const stream of this.streamsByHost.values()) {
      if (stream.service.startsWith('shell:')) return stream;
    }
    return null;
  }

  /** Send one more chunk of stdout on the open shell stream. */
  emitShellOutput(text) {
    const stream = this.shellStream();
    if (!stream) throw new Error('no open shell stream');
    this._send(A_WRTE, stream.deviceId, stream.hostId, enc.encode(text));
  }

  /** Close the open shell stream (as a finished command would). */
  closeShellStream() {
    const stream = this.shellStream();
    if (!stream) throw new Error('no open shell stream');
    this._send(A_CLSE, stream.deviceId, stream.hostId);
  }

  /* --------------------------------- sync -------------------------------- */

  _onSyncBytes(stream, payload) {
    stream.buf = cat(stream.buf, payload);
    while (stream.buf.length >= 8) {
      const id = text4(stream.buf);
      const len = rdU32(stream.buf, 4);
      if (stream.buf.length < 8 + len) break;
      const data = stream.buf.slice(8, 8 + len);
      stream.buf = stream.buf.subarray(8 + len).slice();
      this._handleSync(stream, id, len, data);
    }
  }

  _handleSync(stream, id, len, data) {
    switch (id) {
      case 'SEND': {
        const spec = cstring(data);
        const comma = spec.lastIndexOf(',');
        const path = spec.slice(0, comma);
        const mode = Number(spec.slice(comma + 1));
        const errno = this.failSend.get(path);
        if (errno) {
          this.stats.syncFailSent += 1;
          this._syncFail(stream, errno);
          return;
        }
        stream.file = { path, mode, chunks: [], size: 0, mtime: 0 };
        this._syncOkay(stream);
        return;
      }
      case 'DATA': {
        if (len > SYNC_DATA_MAX) {
          this.errors.push(`DATA chunk of ${len} bytes exceeds the 64 KiB sync limit`);
        }
        if (!stream.file) {
          this._syncFail(stream, 22);
          return;
        }
        stream.file.chunks.push(data);
        stream.file.size += data.length;
        return; // DATA carries no reply
      }
      case 'DONE': {
        if (!stream.file) {
          this._syncFail(stream, 22);
          return;
        }
        stream.file.mtime = rdU32(data, 0);
        this.files.set(stream.file.path, {
          mode: stream.file.mode,
          size: stream.file.size,
          mtime: stream.file.mtime,
          data: concatBytes(stream.file.chunks),
        });
        stream.file = null;
        this._syncOkay(stream);
        return;
      }
      case 'STAT': {
        const path = cstring(data);
        const errno = this.failStat.get(path);
        if (errno) {
          this.stats.syncFailSent += 1;
          this._syncFail(stream, errno);
          return;
        }
        const file = this.files.get(path);
        if (!file) {
          this.stats.syncFailSent += 1;
          this._syncFail(stream, 2); // ENOENT
          return;
        }
        const out = new Uint8Array(16);
        out.set(enc.encode('STAT'), 0);
        writeU32LE(out, 4, file.mode);
        writeU32LE(out, 8, file.size);
        writeU32LE(out, 12, file.mtime);
        this._send(A_WRTE, stream.deviceId, stream.hostId, out);
        return;
      }
      case 'QUIT': {
        this.stats.quits += 1;
        return;
      }
      default:
        this.errors.push(`unknown sync sub-command ${JSON.stringify(id)}`);
    }
  }

  _syncOkay(stream) {
    this.stats.syncOkaySent += 1;
    const reply = new Uint8Array(8);
    reply.set(enc.encode('OKAY'), 0);
    this._send(A_WRTE, stream.deviceId, stream.hostId, reply);
  }

  _syncFail(stream, errno) {
    const reply = new Uint8Array(8);
    reply.set(enc.encode('FAIL'), 0);
    writeU32LE(reply, 4, errno);
    this._send(A_WRTE, stream.deviceId, stream.hostId, reply);
  }
}

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeClient(options = {}) {
  const transport = new FakeTransport();
  const adbd = new FakeAdbd(transport, options.adbd);
  const client = new AdbClient(transport, options.client);
  return { transport, adbd, client };
}

function patternBytes(length, seed = 31) {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * seed + 7) & 0xff;
  return out;
}

/* -------------------------------------------------------------------------- */
/* hash helpers                                                               */
/* -------------------------------------------------------------------------- */

test('sha256: streaming hasher and WebCrypto agree, and match a known vector', async () => {
  assert.equal(
    await sha256Hex(enc.encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
  const data = patternBytes(300_000);
  const streaming = new Sha256();
  for (let off = 0; off < data.length; off += 7777) {
    streaming.update(data.subarray(off, Math.min(off + 7777, data.length)));
  }
  assert.equal(streaming.hex(), await sha256Hex(data));
});

/* -------------------------------------------------------------------------- */
/* handshake                                                                  */
/* -------------------------------------------------------------------------- */

test('connect(): CNXN handshake reports banner, version and maxdata', async () => {
  const { adbd, client, transport } = makeClient();
  const info = await client.connect({ banner: 'host::LibreEcho-WebInstaller' });

  assert.equal(info.deviceBanner, 'device::Amazon Echo Gen 2 (TWRP 3.7)');
  assert.equal(info.version, 0x01000000);
  assert.equal(info.maxData, 256 * 1024);
  assert.equal(client.device, info);

  // exactly one frame reached the device: CNXN with version/maxdata/'host::' banner
  assert.equal(transport.writes.length, 1);
  const cnxn = adbd.messages.find((m) => m.command === A_CNXN);
  assert.ok(cnxn, 'device received CNXN');
  assert.equal(cnxn.arg0, 0x01000000);
  assert.equal(cnxn.arg1, 256 * 1024);
  assert.equal(cnxn.text, 'host::LibreEcho-WebInstaller');
  assert.equal(cnxn.payload.at(-1), 0, 'banner is NUL terminated');
  assert.deepEqual(adbd.errors, []);
  assert.equal(adbd.stats.cnxn, 1);

  await client.close();
});

test('connect(): a device demanding AUTH fails with a clear error', async () => {
  const { adbd, client } = makeClient();
  adbd.authRequired = true;

  await assert.rejects(client.connect(), (err) => {
    assert.ok(err instanceof AdbAuthRequiredError, `expected AdbAuthRequiredError, got ${err.name}`);
    assert.match(err.message, /AUTH/);
    assert.match(err.message, /key provider/i);
    assert.equal(err.tokenLength, 20);
    assert.match(err.hint, /recovery|key provider/i);
    return true;
  });
});

/* -------------------------------------------------------------------------- */
/* framing                                                                    */
/* -------------------------------------------------------------------------- */

test('framing: messages split across many reads are reassembled (2-byte reads)', async () => {
  const { adbd, client, transport } = makeClient();
  adbd.chunkBytes = 2;
  adbd.shellResponses.set('echo hi', { chunks: ['hi\n'] });

  const info = await client.connect();
  assert.equal(info.deviceBanner, adbd.banner);
  const { stdout, exitCode } = await client.shell('echo hi');

  assert.equal(stdout, 'hi\n');
  assert.equal(exitCode, null);
  assert.ok(transport.readSizes.length > 20, `expected many reads, got ${transport.readSizes.length}`);
  assert.ok(
    transport.readSizes.every((n) => n <= 2),
    `every read must be <= 2 bytes, saw ${transport.readSizes.join(',')}`
  );
  assert.deepEqual(adbd.errors, []);
});

test('framing: a header split across reads plus several messages in one read', async () => {
  const { adbd, client, transport } = makeClient();
  await client.connect();
  const readsBefore = transport.readSizes.length;

  adbd.autoFlush = false;
  adbd.shellResponses.set('uname -r', { chunks: ['Linux 4.4.0 (TWRP)\n', 'adb: 1.0.41\n'] });
  const streamed = [];
  const pending = client.shell('uname -r', { onOutput: (chunk) => streamed.push(chunk) });

  await tick();
  // The device queued OKAY(24) WRTE(24+19) WRTE(24+12) CLSE(24) == 127 bytes.
  assert.equal(adbd.buffered, 127, 'device queued its four replies');

  assert.equal(adbd.releaseBytes(10), 10); // splits the OKAY header
  assert.equal(adbd.releaseBytes(14), 14); // completes it
  await tick();
  assert.equal(adbd.releaseBytes(5), 5); // splits the first WRTE header
  const tail = adbd.buffered;
  assert.equal(adbd.releaseBytes(tail), tail); // 3 late messages in ONE read

  const { stdout } = await pending;
  assert.equal(stdout, 'Linux 4.4.0 (TWRP)\nadb: 1.0.41\n');
  assert.equal(streamed.join(''), 'Linux 4.4.0 (TWRP)\nadb: 1.0.41\n');

  const sizes = transport.readSizes.slice(readsBefore);
  assert.deepEqual(sizes, [10, 14, 5, tail], 'read boundaries are what the device produced');
  assert.ok(tail > 2 * HEADER_SIZE, 'one read carried several messages');
  assert.deepEqual(adbd.errors, []);
});

/* -------------------------------------------------------------------------- */
/* shell                                                                      */
/* -------------------------------------------------------------------------- */

test('shell(): collects stdout+stderr, streams chunks, acks device writes', async () => {
  const { adbd, client } = makeClient();
  await client.connect();
  adbd.shellResponses.set('ls -l /sdcard', {
    chunks: ['total 2\n', '-rw-r--r-- 1 root root 5 Jan 1 00:00 a.txt\n', 'sh: warning: x\n'],
  });

  const chunks = [];
  const { stdout, exitCode } = await client.shell('ls -l /sdcard', { onOutput: (c) => chunks.push(c) });

  assert.equal(stdout, 'total 2\n-rw-r--r-- 1 root root 5 Jan 1 00:00 a.txt\nsh: warning: x\n');
  assert.equal(exitCode, null);
  assert.equal(chunks.join(''), stdout, 'onOutput delivered exactly the bytes the device sent');
  assert.ok(chunks.length >= 1);

  const open = adbd.messages.find((m) => m.command === A_OPEN);
  assert.equal(open.text, 'shell:ls -l /sdcard');
  assert.equal(open.payload.at(-1), 0, 'service string is NUL terminated on the wire');
  assert.equal(adbd.stats.shellRuns, 1);
  assert.ok(adbd.stats.okayReceived >= 3, 'host acked each device WRTE so adbd keeps sending');
  assert.equal(adbd.stats.clseReceived, 1, 'host answered the device CLSE');
  assert.deepEqual(adbd.errors, []);
});

test('shell(): output is streamed to onOutput while the command is still running', async () => {
  const { adbd, client } = makeClient();
  await client.connect();
  adbd.holdShell = true; // stream opens, the device sends output on request

  const chunks = [];
  const pending = client.shell('dd if=/dev/zero of=/dev/block/by-name/boot bs=1M', {
    timeout: 5000,
    onOutput: (chunk) => chunks.push(chunk),
  });
  await tick();
  assert.equal(adbd.stats.shellRuns, 1);

  adbd.emitShellOutput('1024+0 records in\n');
  await tick();
  assert.deepEqual(chunks, ['1024+0 records in\n'], 'first chunk arrived before the command finished');

  adbd.emitShellOutput('1024+0 records out\n');
  await tick();
  adbd.closeShellStream();

  const { stdout } = await pending;
  assert.equal(stdout, '1024+0 records in\n1024+0 records out\n');
  assert.deepEqual(chunks, ['1024+0 records in\n', '1024+0 records out\n']);
  assert.deepEqual(adbd.errors, []);
});

test('shell(): OPEN refused by the device surfaces its FAIL text', async () => {
  const { adbd, client } = makeClient();
  await client.connect();
  adbd.failOpen.set('shell:boom', 'exec failed: no such file or directory');

  await assert.rejects(client.shell('boom'), (err) => {
    assert.ok(err instanceof AdbFailError, `expected AdbFailError, got ${err.name}`);
    assert.equal(err.service, 'shell:boom');
    assert.equal(err.text, 'exec failed: no such file or directory');
    assert.match(err.message, /exec failed: no such file or directory/);
    return true;
  });
});

/* -------------------------------------------------------------------------- */
/* push (sync service)                                                        */
/* -------------------------------------------------------------------------- */

test('push(): multi-chunk payload with progress and per-WRTE checksum verification', async () => {
  const { adbd, client } = makeClient();
  await client.connect();

  const total = SYNC_DATA_MAX * 2 + 1234; // three DATA chunks
  const data = patternBytes(total);
  const progress = [];
  const result = await client.push('/data/local/tmp/bundle.tar.gz', data, {
    mode: 0o644,
    mtime: 1_700_000_000,
    onProgress: (p) => progress.push({ ...p }),
  });

  // client-side accounting
  assert.equal(result.bytes, total);
  assert.equal(result.sha256, await sha256Hex(data));

  // device-side file
  const file = adbd.files.get('/data/local/tmp/bundle.tar.gz');
  assert.ok(file, 'device received the file');
  assert.equal(file.size, total);
  assert.equal(file.mode, 0o644);
  assert.equal(file.mtime, 1_700_000_000);
  assert.equal(toHex(file.data), toHex(data), 'device bytes are identical to the source');

  // sync exchange shape
  const syncIds = ['SEND', 'DATA', 'DATA', 'DATA', 'DONE', 'QUIT'];
  assert.equal(adbd.stats.wrteReceived, syncIds.length, 'one WRTE per sync sub-command');
  assert.equal(adbd.stats.wrteChecksumOk, adbd.stats.wrteReceived, 'every WRTE checksum verified');
  assert.equal(adbd.stats.syncOkaySent, 2, 'OKAY for SEND and for DONE');
  assert.equal(adbd.stats.syncFailSent, 0);
  assert.equal(adbd.stats.quits, 1);

  // progress
  assert.equal(progress.length, Math.ceil(total / SYNC_DATA_MAX));
  assert.deepEqual(progress.at(-1), { sent: total, total });
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].sent > progress[i - 1].sent, 'progress is monotonic');
  }
  assert.equal(progress[0].sent, SYNC_DATA_MAX, 'first chunk is the full 64 KiB');
  assert.deepEqual(adbd.errors, []);
});

test('push(): a Blob is sliced per chunk, never materialised whole', async () => {
  class CountingBlob extends Blob {
    constructor(parts, options) {
      super(parts, options);
      this.sliceCalls = [];
    }
    slice(start, end, type) {
      this.sliceCalls.push([start, end]);
      return super.slice(start, end, type);
    }
  }

  const { adbd, client } = makeClient();
  await client.connect();

  const total = SYNC_DATA_MAX * 2 + 4096;
  const data = patternBytes(total, 17);
  const blob = new CountingBlob([data.subarray(0, 40000), data.subarray(40000)], {
    type: 'application/octet-stream',
  });
  assert.equal(blob.size, total);

  const progress = [];
  const result = await client.push('/sdcard/install-blob.tar', blob, {
    mode: 0o600,
    mtime: 1,
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.bytes, total);
  assert.equal(result.sha256, await sha256Hex(data));

  // streaming proof: one slice per chunk, contiguous, none larger than 64 KiB
  const expectedChunks = Math.ceil(total / SYNC_DATA_MAX);
  assert.equal(blob.sliceCalls.length, expectedChunks);
  assert.ok(blob.sliceCalls.every(([s, e]) => e - s <= SYNC_DATA_MAX), 'no slice exceeds 64 KiB');
  let cursor = 0;
  for (const [start, end] of blob.sliceCalls) {
    assert.equal(start, cursor, 'slices are contiguous from offset 0');
    cursor = end;
  }
  assert.equal(cursor, total, 'slices cover the whole blob exactly once');

  const file = adbd.files.get('/sdcard/install-blob.tar');
  assert.equal(file.size, total);
  assert.equal(file.mode, 0o600);
  assert.equal(toHex(file.data), toHex(data));
  assert.deepEqual(adbd.errors, []);
});

test('push(): SEND refused by the device raises AdbFailError with its errno', async () => {
  const { adbd, client } = makeClient();
  await client.connect();
  adbd.failSend.set('/system/readonly.txt', 13); // EACCES

  await assert.rejects(client.push('/system/readonly.txt', new Uint8Array(32)), (err) => {
    assert.ok(err instanceof AdbFailError, `expected AdbFailError, got ${err.name}`);
    assert.equal(err.errno, 13);
    assert.match(err.message, /errno 13/);
    assert.match(err.message, /EACCES/);
    assert.match(err.message, /SEND \/system\/readonly\.txt/);
    return true;
  });
  assert.equal(adbd.stats.syncFailSent, 1);
  assert.equal(adbd.files.size, 0, 'nothing was written');
  assert.equal(adbd.stats.clseReceived, 1, 'the sync stream was closed anyway');
});

/* -------------------------------------------------------------------------- */
/* stat / exists                                                              */
/* -------------------------------------------------------------------------- */

test('stat()/exists(): real values, missing path, and a FAIL errno path', async () => {
  const { adbd, client } = makeClient();
  await client.connect();
  const payload = enc.encode('hello');
  adbd.files.set('/data/local/tmp/hello.txt', {
    mode: 0o100644,
    size: payload.length,
    mtime: 1_700_000_123,
    data: payload,
  });

  assert.deepEqual(await client.stat('/data/local/tmp/hello.txt'), {
    mode: 0o100644,
    size: 5,
    mtime: 1_700_000_123,
  });
  assert.equal(await client.exists('/data/local/tmp/hello.txt'), true);

  assert.equal(await client.stat('/data/local/tmp/missing.txt'), null);
  assert.equal(await client.exists('/data/local/tmp/missing.txt'), false);

  adbd.failStat.set('/data/private', 13);
  await assert.rejects(client.stat('/data/private'), (err) => {
    assert.ok(err instanceof AdbFailError);
    assert.equal(err.errno, 13);
    assert.match(err.message, /stat\(\/data\/private\)/);
    return true;
  });

  assert.deepEqual(adbd.errors, []);
});

/* -------------------------------------------------------------------------- */
/* timeouts and shutdown                                                      */
/* -------------------------------------------------------------------------- */

test('timeouts: an unresponsive device produces AdbTimeoutError, not a hang', async () => {
  // 1) no reply to CNXN at all
  const silent = makeClient({ client: { timeout: 120, shellTimeout: 120 } });
  silent.adbd.silent = true;
  const t0 = Date.now();
  await assert.rejects(silent.client.connect(), (err) => {
    assert.ok(err instanceof AdbTimeoutError, `expected AdbTimeoutError, got ${err.name}`);
    assert.match(err.message, /timeout/i);
    assert.match(err.message, /connect/);
    assert.equal(err.timeoutMs, 120);
    return true;
  });
  const connectElapsed = Date.now() - t0;
  assert.ok(connectElapsed >= 100 && connectElapsed < 3000, `connect timed out in ${connectElapsed}ms`);

  // 2) handshake works but OPEN is never answered
  const noOpen = makeClient({ client: { timeout: 150, shellTimeout: 150 } });
  const info = await noOpen.client.connect();
  assert.equal(info.deviceBanner, noOpen.adbd.banner);
  noOpen.adbd.ignoreOpen = true;
  const t1 = Date.now();
  await assert.rejects(noOpen.client.shell('id'), (err) => {
    assert.ok(err instanceof AdbTimeoutError, `expected AdbTimeoutError, got ${err.name}`);
    assert.match(err.message, /OPEN shell:id/);
    return true;
  });
  const shellElapsed = Date.now() - t1;
  assert.ok(shellElapsed >= 100 && shellElapsed < 3000, `shell timed out in ${shellElapsed}ms`);
});

test('timeouts: a device that stops acking writes cannot hang a push', async () => {
  const { adbd, client } = makeClient({ client: { timeout: 150, pushTimeout: 150 } });
  await client.connect();
  adbd.ackWrites = false; // the device consumes WRTE frames but never says OKAY

  const started = Date.now();
  await assert.rejects(client.push('/data/local/tmp/stall.bin', new Uint8Array(10)), (err) => {
    assert.ok(err instanceof AdbTimeoutError, `expected AdbTimeoutError, got ${err.name}`);
    assert.match(err.message, /waiting for device OKAY/);
    assert.match(err.message, /stall\.bin/);
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 100 && elapsed < 3000, `push gave up after ${elapsed}ms`);
});

test('close(): open streams are closed on the wire and later calls are refused', async () => {
  const { adbd, client } = makeClient();
  await client.connect();
  adbd.holdShell = true; // device opens the stream but never finishes it

  const pending = client.shell('sleep 100', { timeout: 5000 });
  await tick();
  await client.close();

  await assert.rejects(pending, (err) => {
    assert.ok(err instanceof AdbError, `expected AdbError, got ${err.name}`);
    assert.match(err.message, /closed/i);
    return true;
  });
  assert.equal(adbd.stats.clseReceived, 1, 'client sent CLSE for the hung stream');
  await assert.rejects(client.shell('echo x'), /closed/);
});

/* -------------------------------------------------------------------------- */
/* WebUSB transport                                                           */
/* -------------------------------------------------------------------------- */

class MockUsbDevice {
  constructor(options = {}) {
    this.vendorId = options.vendorId ?? 0x18d1;
    this.productId = options.productId ?? 0x4ee0;
    this.opened = false;
    this.configuration = null;
    this.maxWriteChunk = options.maxWriteChunk ?? null;
    this.configurations = options.configurations ?? [
      {
        configurationValue: 1,
        interfaces: [
          {
            interfaceNumber: 0,
            alternates: [
              {
                interfaceClass: 0xff,
                interfaceSubclass: 0x42,
                interfaceProtocol: 0x01,
                endpoints: [
                  { endpointNumber: 1, direction: 'in', type: 'bulk' },
                  { endpointNumber: 2, direction: 'out', type: 'bulk' },
                ],
              },
            ],
          },
        ],
      },
    ];
    this.calls = [];
    this.outChunks = [];
    this.inQueue = [];
    this.idleReads = options.idleReads ?? 0;
    this.listeners = new Map();
  }

  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type) {
    this.listeners.delete(type);
  }
  emit(type) {
    this.listeners.get(type)?.();
  }

  async open() {
    this.calls.push('open');
    this.opened = true;
  }
  async selectConfiguration(value) {
    this.calls.push(['selectConfiguration', value]);
    this.configuration = this.configurations.find((c) => c.configurationValue === value) ?? null;
  }
  async claimInterface(n) {
    this.calls.push(['claimInterface', n]);
    this.claimed = n;
  }
  async releaseInterface(n) {
    this.calls.push(['releaseInterface', n]);
    this.claimed = null;
  }
  async close() {
    this.calls.push('close');
    this.opened = false;
  }
  async clearHalt(direction, ep) {
    this.calls.push(['clearHalt', direction, ep]);
  }

  async transferOut(endpoint, data) {
    this.calls.push(['transferOut', endpoint, data.byteLength]);
    const n = this.maxWriteChunk ? Math.min(this.maxWriteChunk, data.byteLength) : data.byteLength;
    this.outChunks.push(new Uint8Array(data.subarray(0, n)));
    return { status: 'ok', bytesWritten: n };
  }

  async transferIn(endpoint, length) {
    this.calls.push(['transferIn', endpoint, length]);
    if (this.idleReads > 0) {
      this.idleReads -= 1;
      const err = new Error('transfer timed out');
      err.name = 'TimeoutError';
      throw err;
    }
    if (this.inQueue.length === 0) {
      const err = new Error('The device was disconnected.');
      err.name = 'NotFoundError';
      throw err;
    }
    const bytes = this.inQueue.shift();
    return { status: 'ok', data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  }
}

function usbDeviceWith(interfaces) {
  return new MockUsbDevice({
    configurations: [{ configurationValue: 1, interfaces }],
  });
}

test('webusb: ADB interface discovery falls back to the first bulk in/out pair', () => {
  const labelled = new MockUsbDevice();
  assert.deepEqual(findAdbInterface(labelled), {
    configurationValue: 1,
    interfaceNumber: 0,
    inEndpoint: 1,
    outEndpoint: 2,
  });

  // interface 0 is a HID-ish interface with only one endpoint; interface 1 has the bulk pair
  const fallback = usbDeviceWith([
    {
      interfaceNumber: 0,
      alternates: [
        {
          interfaceClass: 0x03,
          interfaceSubclass: 0,
          interfaceProtocol: 0,
          endpoints: [{ endpointNumber: 3, direction: 'in', type: 'interrupt' }],
        },
      ],
    },
    {
      interfaceNumber: 1,
      alternates: [
        {
          interfaceClass: 0xff,
          interfaceSubclass: 0x42,
          interfaceProtocol: 0x01,
          endpoints: [
            { endpointNumber: 4, direction: 'in', type: 'bulk' },
            { endpointNumber: 5, direction: 'out', type: 'bulk' },
          ],
        },
      ],
    },
  ]);
  assert.deepEqual(findAdbInterface(fallback), {
    configurationValue: 1,
    interfaceNumber: 1,
    inEndpoint: 4,
    outEndpoint: 5,
  });

  assert.equal(
    findAdbInterface(usbDeviceWith([{ interfaceNumber: 0, alternates: [{ endpoints: [] }] }])),
    null
  );
});

test('webusb: open() claims the ADB interface and write() loops over partial transfers', async () => {
  const device = new MockUsbDevice({ maxWriteChunk: 7 });
  const transport = new WebUsbAdbTransport(device, { readSize: 4096 });

  await transport.open();
  assert.equal(device.opened, true);
  assert.deepEqual(device.calls.slice(0, 3), ['open', ['selectConfiguration', 1], ['claimInterface', 0]]);
  assert.deepEqual(transport.endpoints, { in: 1, out: 2, interfaceNumber: 0 });

  const payload = patternBytes(30);
  await transport.write(payload);
  await transport.flush();
  assert.equal(device.outChunks.length, Math.ceil(30 / 7), 'partial transferOut results were retried');
  const reassembled = concatBytes(device.outChunks);
  assert.equal(toHex(reassembled), toHex(payload));
  assert.equal(
    device.calls.filter((c) => Array.isArray(c) && c[0] === 'transferOut').length,
    5,
    'one transferOut per 7-byte slice'
  );

  await transport.write(new Uint8Array([1, 2, 3]));
  await transport.close();
  assert.deepEqual(
    device.calls.filter((c) => c === 'close' || (Array.isArray(c) && c[0] === 'releaseInterface')),
    [['releaseInterface', 0], 'close']
  );
  await assert.rejects(transport.write(new Uint8Array([9])), /closed/);
});

test('webusb: read() ignores idle transfer timeouts and ends on disconnect', async () => {
  const device = new MockUsbDevice({ idleReads: 1 });
  const transport = new WebUsbAdbTransport(device, { readSize: 1024 });
  await transport.open();

  const first = patternBytes(5);
  device.inQueue.push(first);
  const got = await transport.read();
  assert.equal(toHex(got), toHex(first));
  assert.notEqual(got.buffer, first.buffer, 'bytes are copied out of the UA-owned buffer');
  assert.equal(
    device.calls.filter((c) => Array.isArray(c) && c[0] === 'transferIn').length,
    2,
    'the idle timeout was retried'
  );

  // no queued data and the device is gone -> null, not a throw
  assert.equal(await transport.read(), null);
  assert.equal(transport.isOpen, false);
});

test('webusb: disconnect event closes the transport', async () => {
  const device = new MockUsbDevice();
  const transport = new WebUsbAdbTransport(device);
  await transport.open();
  assert.equal(transport.isOpen, true);
  device.emit('disconnect');
  assert.equal(transport.isOpen, false);
  await transport.release();
  assert.equal(isDisconnectError(Object.assign(new Error('x'), { name: 'NotFoundError' })), true);
  assert.equal(isDisconnectError(new Error('transfer timed out')), false);
});

test('webusb: TWRP device filters and static discovery use navigator.usb', async () => {
  assert.ok(TWRP_USB_FILTERS.length >= 9);
  assert.deepEqual(TWRP_USB_FILTERS[0], { vendorId: 0x18d1, productId: 0x4ee0 });
  assert.deepEqual(TWRP_USB_FILTERS.at(-1), { vendorId: 0x18d1, productId: 0xd00d });

  const twrp = new MockUsbDevice({ productId: 0x4ee2 });
  const other = new MockUsbDevice({ vendorId: 0x1234, productId: 0x5678 });
  const requested = [];
  const fakeUsb = {
    async getDevices() {
      return [other, twrp];
    },
    async requestDevice({ filters }) {
      requested.push(filters);
      return twrp;
    },
  };

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { usb: fakeUsb }, configurable: true, writable: true });
  try {
    assert.equal(isWebUsbAvailable(), true);
    const found = await WebUsbAdbTransport.getDevices();
    assert.equal(found.length, 1);
    assert.equal(found[0].productId, 0x4ee2);

    const transport = await WebUsbAdbTransport.requestDevice();
    assert.deepEqual(requested[0], TWRP_USB_FILTERS);
    assert.equal(transport instanceof WebUsbAdbTransport, true);
    assert.equal(twrp.opened, true);
    await transport.close();

    const attached = await WebUsbAdbTransport.attachExisting();
    assert.ok(attached instanceof WebUsbAdbTransport, 're-attach without a chooser');
    await attached.close();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});

/* -------------------------------------------------------------------------- */
/* end-to-end: the installer's actual flow, against the fake device           */
/* -------------------------------------------------------------------------- */

/**
 * Full-scale push. Off by default because it moves real hundreds of megabytes;
 * run it with `ADB_BIG_MB=240 node --test test_adb.mjs` (it is the shape the
 * installer actually performs: one Blob, streamed 64 KiB at a time).
 */
const BIG_MB = Number(process.env.ADB_BIG_MB ?? 0);

test(
  'push(): a hundreds-of-MB Blob streams without materialising extra copies',
  { skip: BIG_MB === 0 ? 'set ADB_BIG_MB=<megabytes> to run the full-scale push' : false },
  async () => {
    const { adbd, client } = makeClient({ client: { timeout: 120_000, pushTimeout: 900_000 } });
    await client.connect();

    // Build the payload as N references to one deterministic 1 MiB block: the
    // test never holds two full copies of the data.
    const block = patternBytes(1 << 20, 13);
    const blob = new Blob(new Array(BIG_MB).fill(block), { type: 'application/octet-stream' });
    const expected = new Sha256();
    for (let i = 0; i < BIG_MB; i++) expected.update(block);
    const expectedHex = expected.hex();

    const progress = [];
    const started = Date.now();
    const result = await client.push('/data/local/tmp/libreecho-install.tar', blob, {
      mode: 0o644,
      onProgress: (p) => progress.push(p.sent),
    });
    const elapsed = Date.now() - started;

    assert.equal(result.bytes, blob.size);
    assert.equal(result.sha256, expectedHex, 'streamed hash matches the incremental reference hash');
    assert.equal(progress.length, Math.ceil(blob.size / SYNC_DATA_MAX));
    assert.equal(progress.at(-1), blob.size);

    const file = adbd.files.get('/data/local/tmp/libreecho-install.tar');
    assert.equal(file.size, blob.size);
    const readback = new Sha256();
    for (let off = 0; off < file.data.length; off += 1 << 20) {
      readback.update(file.data.subarray(off, Math.min(off + (1 << 20), file.data.length)));
    }
    assert.equal(readback.hex(), expectedHex, 'on-device bytes hash identically');
    assert.deepEqual(adbd.errors, []);
    assert.equal(adbd.stats.wrteChecksumOk, adbd.stats.wrteReceived);

    console.log(
      `      ${(blob.size / 1024 / 1024).toFixed(0)} MiB pushed in ${(elapsed / 1000).toFixed(1)}s ` +
        `(${progress.length} DATA chunks, ${adbd.stats.wrteReceived} WRTE frames)`
    );
  }
);

test('end-to-end: handshake -> shell -> push -> verify readback sha256', async () => {
  const { adbd, client } = makeClient({ client: { timeout: 5000, shellTimeout: 5000, pushTimeout: 5000 } });
  const info = await client.connect({ banner: 'host::LibreEcho-WebInstaller' });
  assert.match(info.deviceBanner, /TWRP/);

  adbd.shellResponses.set('mount /data', { chunks: [''] });
  adbd.shellResponses.set('df -h /data', { chunks: ['Filesystem      Size  Used Avail\n', '/dev/block/data 4.6G 1.1G 3.5G\n'] });
  assert.equal((await client.shell('mount /data')).stdout, '');
  assert.match((await client.shell('df -h /data')).stdout, /3\.5G/);
  assert.equal((await client.shell('nosuchcmd')).stdout, '/sbin/sh: nosuchcmd: not found\n');

  const bundle = patternBytes(SYNC_DATA_MAX + 100, 5);
  const target = '/data/local/tmp/libreecho-install.tar';
  const pushed = await client.push(target, bundle, { mode: 0o644 });

  const stat = await client.stat(target);
  assert.equal(stat.size, bundle.length);
  assert.equal(stat.mode, 0o644);
  assert.equal(await client.exists(target), true);

  // the caller's readback comparison: hash the on-device bytes independently
  const onDevice = adbd.files.get(target);
  assert.equal(await sha256Hex(onDevice.data), pushed.sha256, 'on-device sha256 matches the pushed bytes');

  await client.close();
  assert.deepEqual(adbd.errors, []);
});
