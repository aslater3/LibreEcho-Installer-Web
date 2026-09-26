/**
 * adb.js — dependency-free ADB (Android Debug Bridge) USB protocol + client.
 *
 * Plain ES module. Runs unmodified in Chromium (via the WebUSB transport in
 * `webusb-adb-transport.js`) and in Node >= 18 (see `test_adb.mjs`, which
 * drives it with a scripted fake adbd).
 *
 * The only external dependency is the `Transport` object injected into
 * `AdbClient`:
 *
 * @typedef {Object} Transport
 * @property {(bytes: Uint8Array) => Promise<void>} write  queue bytes to the device
 * @property {() => Promise<Uint8Array|null>} read        next chunk of device bytes,
 *                                                        or `null` when no more will ever arrive
 * @property {() => Promise<void>} flush                  flush pending writes
 * @property {(ms: number) => Promise<void>} setTimeout   per-transfer timeout in ms
 *
 * Nothing else is required: no bundler, no npm, no auth (TWRP's adbd is
 * AUTH-free — a device that does demand AUTH produces a clear error instead of
 * a hang).
 *
 * Protocol notes (all little-endian, 24-byte header):
 *   uint32 command, uint32 arg0, uint32 arg1, uint32 data_length,
 *   uint32 data_checksum, uint32 magic            where magic = command ^ 0xFFFFFFFF
 * Direction convention: the sender puts its own stream id in arg0 and the
 * peer's stream id in arg1, so the receiver always looks a stream up by arg1.
 *
 * @module adb
 */

/* -------------------------------------------------------------------------- */
/* constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Legacy SYNC command (modern devices use `sync:` service sub-commands). */
export const A_SYNC = 0x434e5953;
/** CNXN — connect / handshake. */
export const A_CNXN = 0x4e584e43;
/** AUTH — authentication request (device -> host). */
export const A_AUTH = 0x48545541;
/** OPEN — open a service stream. */
export const A_OPEN = 0x4e45504f;
/** OKAY — stream opened / "ready for more". */
export const A_OKAY = 0x59414b4f;
/** CLSE — close a stream. */
export const A_CLSE = 0x45534c43;
/** WRTE — payload-carrying packet. */
export const A_WRTE = 0x45545257;
/** FAIL — service open / write refused (device -> host). */
export const A_FAIL = 0x4c494146;

/** Protocol version we advertise. */
export const ADB_VERSION = 0x01000000;
/** Max payload we are willing to receive in one message. */
export const MAX_PAYLOAD = 256 * 1024;
/** Max bytes in a single sync DATA sub-command (adb uses 64 KiB). */
export const SYNC_DATA_MAX = 64 * 1024;
/** ADB message header size in bytes. */
export const HEADER_SIZE = 24;

/** Default per-operation timeout (ms). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default timeout for one shell command. */
export const DEFAULT_SHELL_TIMEOUT_MS = 300_000;
/** Default timeout for one push (240 MB over USB needs a while). */
export const DEFAULT_PUSH_TIMEOUT_MS = 900_000;

const EMPTY = new Uint8Array(0);
const SYNC_OKAY = 'OKAY';
const SYNC_FAIL = 'FAIL';
const textEncoder = new TextEncoder();

/* -------------------------------------------------------------------------- */
/* errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Generic ADB error. */
export class AdbError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, label?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'AdbError';
    if (info.cause !== undefined) this.cause = info.cause;
    if (info.label !== undefined) this.label = info.label;
  }
}

/** The device answered FAIL. Carries the peer's errno (sync) and/or text (OPEN). */
export class AdbFailError extends AdbError {
  /**
   * @param {string} message
   * @param {{errno?: number, text?: string, label?: string, service?: string}} [info]
   */
  constructor(message, info = {}) {
    super(message, info);
    this.name = 'AdbFailError';
    this.errno = info.errno ?? null;
    this.text = info.text ?? null;
    this.service = info.service ?? null;
  }
}

/** An operation exceeded its deadline. Guarantees we never hang forever. */
export class AdbTimeoutError extends AdbError {
  /**
   * @param {string} message
   * @param {{label?: string, timeoutMs?: number}} [info]
   */
  constructor(message, info = {}) {
    super(message, info);
    this.name = 'AdbTimeoutError';
    this.timeoutMs = info.timeoutMs ?? null;
  }
}

/** The device replied AUTH: it wants a signing key that we do not have. */
export class AdbAuthRequiredError extends AdbError {
  /**
   * @param {string} message
   * @param {{tokenLength?: number}} [info]
   */
  constructor(message, info = {}) {
    super(message, info);
    this.name = 'AdbAuthRequiredError';
    this.tokenLength = info.tokenLength ?? null;
    this.hint =
      'Configure a key provider on the AdbClient, or boot the device into a ' +
      'recovery image (e.g. TWRP) whose adbd does not require authentication.';
  }
}

/** POSIX errno -> name, used to make sync FAIL errors readable. */
const ERRNO_NAMES = {
  1: 'EPERM',
  2: 'ENOENT',
  3: 'ESRCH',
  5: 'EIO',
  9: 'EBADF',
  11: 'EAGAIN',
  12: 'ENOMEM',
  13: 'EACCES',
  17: 'EEXIST',
  20: 'ENOTDIR',
  21: 'EISDIR',
  22: 'EINVAL',
  28: 'ENOSPC',
  30: 'EROFS',
  32: 'EPIPE',
};

/**
 * Human-readable name for a POSIX errno.
 * @param {number} errno
 * @returns {string}
 */
export function errnoName(errno) {
  return ERRNO_NAMES[errno] ?? `errno ${errno}`;
}

/* -------------------------------------------------------------------------- */
/* byte helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * UTF-8 encode a string.
 * @param {string} s
 * @returns {Uint8Array}
 */
export function encodeUtf8(s) {
  return textEncoder.encode(s);
}

/**
 * UTF-8 decode bytes (non-fatal).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Read a NUL-terminated ASCII/UTF-8 string (the ADB wire format for banner and
 * service strings).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function cstring(bytes) {
  let end = bytes.indexOf(0);
  if (end < 0) end = bytes.length;
  return decodeUtf8(bytes.subarray(0, end));
}

/**
 * ASCII decode of exactly four bytes (sync sub-command ids).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function ascii4(bytes) {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

/**
 * Little-endian uint32 read.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
export function readU32LE(bytes, offset) {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  );
}

/**
 * Little-endian uint32 write.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} value
 */
export function writeU32LE(bytes, offset, value) {
  const v = value >>> 0;
  bytes[offset] = v & 0xff;
  bytes[offset + 1] = (v >>> 8) & 0xff;
  bytes[offset + 2] = (v >>> 16) & 0xff;
  bytes[offset + 3] = (v >>> 24) & 0xff;
}

/**
 * ADB's data checksum: sum of all payload bytes mod 2^32.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function adbChecksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) >>> 0;
  return sum >>> 0;
}

/**
 * Concatenate byte chunks into one buffer.
 * @param {Uint8Array[]} chunks
 * @returns {Uint8Array}
 */
export function concatBytes(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Build a complete ADB message (header + payload).
 * @param {number} command
 * @param {number} arg0
 * @param {number} arg1
 * @param {Uint8Array} [payload]
 * @returns {Uint8Array}
 */
export function buildMessage(command, arg0, arg1, payload = EMPTY) {
  const out = new Uint8Array(HEADER_SIZE + payload.length);
  writeU32LE(out, 0, command);
  writeU32LE(out, 4, arg0);
  writeU32LE(out, 8, arg1);
  writeU32LE(out, 12, payload.length);
  writeU32LE(out, 16, adbChecksum(payload));
  writeU32LE(out, 20, (command ^ 0xffffffff) >>> 0);
  out.set(payload, HEADER_SIZE);
  return out;
}

/**
 * Parse a 24-byte ADB header without validating the magic.
 * @param {Uint8Array} bytes
 * @param {number} [offset]
 * @returns {{command:number, arg0:number, arg1:number, dataLength:number,
 *            dataChecksum:number, magic:number}}
 */
export function parseHeader(bytes, offset = 0) {
  return {
    command: readU32LE(bytes, offset),
    arg0: readU32LE(bytes, offset + 4),
    arg1: readU32LE(bytes, offset + 8),
    dataLength: readU32LE(bytes, offset + 12),
    dataChecksum: readU32LE(bytes, offset + 16),
    magic: readU32LE(bytes, offset + 20),
  };
}

/* -------------------------------------------------------------------------- */
/* sha256                                                                     */
/* -------------------------------------------------------------------------- */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

const HEX = '0123456789abcdef';
/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  return s;
}

/**
 * Streaming SHA-256. Exists so `push()` can hash a >200 MB payload chunk by
 * chunk without ever materialising a second copy of it.
 */
export class Sha256 {
  constructor() {
    /** @type {Uint32Array} */
    this._h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this._buf = new Uint8Array(64);
    this._buflen = 0;
    /** total bytes fed in (for the length padding) */
    this._len = 0;
    this._w = new Uint32Array(64);
  }

  /**
   * Feed more data.
   * @param {Uint8Array} data
   * @returns {Sha256} this
   */
  update(data) {
    this._len += data.length;
    let i = 0;
    if (this._buflen > 0) {
      while (this._buflen < 64 && i < data.length) this._buf[this._buflen++] = data[i++];
      if (this._buflen === 64) {
        this._block(this._buf, 0);
        this._buflen = 0;
      }
    }
    while (i + 64 <= data.length) {
      this._block(data, i);
      i += 64;
    }
    while (i < data.length) this._buf[this._buflen++] = data[i++];
    return this;
  }

  /**
   * Finish and return the 32-byte digest. The instance must not be reused.
   * @returns {Uint8Array}
   */
  digest() {
    // SHA-256 pads with 0x80, zeroes, then the message length in BITS as a
    // 64-bit BIG-endian value.
    const bits = this._len * 8;
    const hi = Math.floor(bits / 4294967296) >>> 0;
    const lo = bits >>> 0;
    const pad = new Uint8Array(((this._buflen < 56 ? 56 : 120) - this._buflen) + 8);
    pad[0] = 0x80;
    pad[pad.length - 8] = (hi >>> 24) & 0xff;
    pad[pad.length - 7] = (hi >>> 16) & 0xff;
    pad[pad.length - 6] = (hi >>> 8) & 0xff;
    pad[pad.length - 5] = hi & 0xff;
    pad[pad.length - 4] = (lo >>> 24) & 0xff;
    pad[pad.length - 3] = (lo >>> 16) & 0xff;
    pad[pad.length - 2] = (lo >>> 8) & 0xff;
    pad[pad.length - 1] = lo & 0xff;
    this.update(pad);
    // Digest words are serialised BIG-endian.
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
      const word = this._h[i];
      out[i * 4] = (word >>> 24) & 0xff;
      out[i * 4 + 1] = (word >>> 16) & 0xff;
      out[i * 4 + 2] = (word >>> 8) & 0xff;
      out[i * 4 + 3] = word & 0xff;
    }
    return out;
  }

  /**
   * Finish and return the lowercase hex digest.
   * @returns {string}
   */
  hex() {
    return toHex(this.digest());
  }

  /**
   * @param {Uint8Array} data
   * @param {number} off
   * @private
   */
  _block(data, off) {
    const w = this._w;
    for (let i = 0; i < 16; i++) {
      const o = off + i * 4;
      w[i] = ((data[o] << 24) | (data[o + 1] << 16) | (data[o + 2] << 8) | data[o + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = this._h[0];
    let b = this._h[1];
    let c = this._h[2];
    let d = this._h[3];
    let e = this._h[4];
    let f = this._h[5];
    let g = this._h[6];
    let h = this._h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    this._h[0] = (this._h[0] + a) >>> 0;
    this._h[1] = (this._h[1] + b) >>> 0;
    this._h[2] = (this._h[2] + c) >>> 0;
    this._h[3] = (this._h[3] + d) >>> 0;
    this._h[4] = (this._h[4] + e) >>> 0;
    this._h[5] = (this._h[5] + f) >>> 0;
    this._h[6] = (this._h[6] + g) >>> 0;
    this._h[7] = (this._h[7] + h) >>> 0;
  }
}

/**
 * SHA-256 (hex) of a byte buffer using WebCrypto. Used by callers to compare a
 * pushed file against an on-device read-back.
 *
 * Works in the browser (`crypto.subtle`) and in Node 18+ (`globalThis.crypto`);
 * in older Node run `globalThis.crypto ??= require('node:crypto').webcrypto`.
 *
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} data
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256Hex(data) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new AdbError(
      'crypto.subtle (WebCrypto) is not available in this environment; ' +
        'browsers require a secure context (https:// or localhost)'
    );
  }
  let bytes;
  if (data instanceof Uint8Array) bytes = data;
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else throw new AdbError('sha256Hex() expects a Uint8Array, ArrayBuffer or ArrayBufferView');
  const digest = await subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/* -------------------------------------------------------------------------- */
/* internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A promise plus its resolvers. A no-op rejection handler is attached so an
 * abandoned stream can never raise an unhandled rejection.
 * @template T
 * @returns {{promise: Promise<T>, resolve: (v:T)=>void, reject: (e:Error)=>void, settled: boolean}}
 */
function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject, settled: false };
}

/** Simple FIFO byte queue with an awaitable "has data" signal. */
class ByteQueue {
  constructor() {
    /** @type {Uint8Array[]} */
    this.chunks = [];
    this.length = 0;
    /** @type {(() => void)|null} */
    this._waiter = null;
  }

  /** @param {Uint8Array} bytes */
  push(bytes) {
    if (!bytes || bytes.length === 0) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
    this._wake();
  }

  _wake() {
    const w = this._waiter;
    if (w) {
      this._waiter = null;
      w();
    }
  }

  /** @returns {Promise<void>} resolves as soon as the queue is non-empty */
  waited() {
    if (this.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this._waiter = resolve;
    });
  }

  /**
   * Remove everything currently buffered as one chunk.
   * @returns {Uint8Array|null}
   */
  drain() {
    if (this.length === 0) return null;
    const out = this.take(this.length);
    return out;
  }

  /**
   * Remove exactly `n` bytes, or return null if fewer are buffered.
   * @param {number} n
   * @returns {Uint8Array|null}
   */
  take(n) {
    if (this.length < n) return null;
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const need = n - off;
      if (head.length <= need) {
        out.set(head, off);
        off += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), off);
        this.chunks[0] = head.subarray(need);
        off += need;
      }
    }
    this.length -= n;
    return out;
  }
}

/**
 * An operation deadline. Every await in this module is bounded by one, which is
 * what makes "never hang" true rather than aspirational.
 */
class Deadline {
  /**
   * @param {number} ms
   * @param {string} label
   */
  constructor(ms, label) {
    this.total = ms;
    this.label = label;
    this.at = Date.now() + ms;
  }

  /** @returns {number} ms left (may be <= 0) */
  remaining() {
    return this.at - Date.now();
  }
}

/**
 * Build a sync sub-command frame: 4-byte ASCII id + uint32 LE payload length + payload.
 * @param {string} id
 * @param {Uint8Array} [payload]
 * @returns {Uint8Array}
 */
export function packSync(id, payload = EMPTY) {
  const out = new Uint8Array(8 + payload.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  writeU32LE(out, 4, payload.length);
  out.set(payload, 8);
  return out;
}

/**
 * Byte length of anything `push()` accepts.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|Blob} data
 * @returns {number}
 */
export function byteLengthOf(data) {
  if (data instanceof Uint8Array) return data.length;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (data != null && typeof data.size === 'number' && typeof data.slice === 'function') return data.size;
  throw new AdbError('push() data must be a Uint8Array, ArrayBuffer, ArrayBufferView or Blob');
}

/**
 * Materialise `n` bytes at `off` without copying the whole source: typed arrays
 * are sliced as views, Blobs via `Blob.prototype.slice().arrayBuffer()`.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|Blob} source
 * @param {number} off
 * @param {number} n
 * @returns {Promise<Uint8Array>}
 */
async function bytesAt(source, off, n) {
  if (source instanceof Uint8Array) return source.subarray(off, off + n);
  if (ArrayBuffer.isView(source)) return new Uint8Array(source.buffer, source.byteOffset + off, n);
  if (source instanceof ArrayBuffer) return new Uint8Array(source, off, n);
  if (source != null && typeof source.size === 'number' && typeof source.slice === 'function') {
    const ab = await source.slice(off, off + n).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new AdbError('push() data must be a Uint8Array, ArrayBuffer, ArrayBufferView or Blob');
}

/* -------------------------------------------------------------------------- */
/* client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * ADB client: CNXN handshake, service streams, shell and sync (push/stat).
 *
 * @example
 * import { AdbClient } from './adb.js';
 * import { WebUsbAdbTransport } from './webusb-adb-transport.js';
 *
 * const transport = await WebUsbAdbTransport.requestDevice();
 * const adb = new AdbClient(transport);
 * await adb.connect({ banner: 'host::LibreEcho-WebInstaller' });
 * await adb.shell('mount /system');
 * const res = await adb.push('/data/local/tmp/install.tar', fileBlob, {
 *   mode: 0o644,
 *   onProgress: ({ sent, total }) => console.log(`${sent}/${total}`),
 * });
 */
export class AdbClient {
  /**
   * @param {Transport} transport
   * @param {{timeout?: number, shellTimeout?: number, pushTimeout?: number,
   *          maxData?: number, ackWrites?: boolean}} [options]
   *   timeout      default per-operation deadline (ms)
   *   shellTimeout default deadline for one shell command (ms)
   *   pushTimeout  default deadline for one push (ms)
   *   maxData      max payload we advertise in CNXN
   *   ackWrites    wait for the device's OKAY after every WRTE we send
   */
  constructor(transport, options = {}) {
    if (!transport || typeof transport.write !== 'function' || typeof transport.read !== 'function') {
      throw new AdbError('AdbClient requires a Transport with {write, read, flush, setTimeout}');
    }
    /** @type {Transport} */
    this.transport = transport;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.shellTimeout = options.shellTimeout ?? DEFAULT_SHELL_TIMEOUT_MS;
    this.pushTimeout = options.pushTimeout ?? DEFAULT_PUSH_TIMEOUT_MS;
    this.maxData = options.maxData ?? MAX_PAYLOAD;
    this.ackWrites = options.ackWrites ?? true;
    /** @type {{deviceBanner: string, version: number, maxData: number}|null} */
    this.device = null;

    this._buf = EMPTY;
    /** @type {Map<number, any>} */
    this._streams = new Map();
    this._nextLocalId = 1;
    this._cnxn = null;
    this._readerStarted = false;
    this._closed = false;
    /** @type {Error|null} */
    this._readerError = null;
  }

  /* ------------------------------------------------------------------ */
  /* public API                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Perform the CNXN handshake.
   *
   * @param {{banner?: string, timeout?: number}} [options] `banner` is the host
   *   banner advertised to adbd; `host::` is prepended when missing.
   * @returns {Promise<{deviceBanner: string, version: number, maxData: number}>}
   * @throws {AdbAuthRequiredError} when the device replies AUTH and no key
   *   provider is configured (TWRP's adbd does not do this).
   * @throws {AdbTimeoutError} when the device never answers.
   */
  async connect(options = {}) {
    if (this.device) return this.device;
    const deadline = this._deadline(options.timeout, 'connect');
    const text = options.banner ?? 'host::adb.js';
    const payload = encodeUtf8(text.includes('::') ? `${text}\0` : `host::${text}\0`);
    const wait = makeDeferred();
    this._cnxn = wait;
    this._startReader();
    await this._send(A_CNXN, ADB_VERSION, this.maxData, payload, deadline, 'connect (CNXN)');
    const info = await this._race(wait.promise, deadline, 'connect (waiting for CNXN/AUTH)');
    this.device = info;
    return info;
  }

  /**
   * Run a shell command through the `shell:<cmd>` service and collect its
   * combined stdout+stderr. The legacy service carries no exit status, so
   * `exitCode` is null (use `shell,v2,raw:` if you need one).
   *
   * @param {string} command
   * @param {{onOutput?: (chunk: string) => void, timeout?: number}} [options]
   * @returns {Promise<{stdout: string, exitCode: number|null}>}
   */
  async shell(command, options = {}) {
    const deadline = this._deadline(options.timeout ?? this.shellTimeout, `shell(${command})`);
    const stream = await this._openStream(`shell:${command}`, deadline);

    const parts = [];
    let total = 0;
    const decoder = new TextDecoder('utf-8');
    const handler = (payload) => {
      parts.push(payload);
      total += payload.length;
      if (options.onOutput) options.onOutput(decoder.decode(payload, { stream: true }));
    };
    stream.onData = handler;
    // Output can already be buffered: the device may answer OPEN, stream its
    // output and close in the very same transport read (a coalesced read).
    const queued = stream.rx.drain();
    if (queued) handler(queued);

    let error = null;
    try {
      await this._race(stream.closed.promise, deadline, `shell(${command})`);
    } catch (err) {
      error = err;
    } finally {
      await this._closeStream(stream);
    }
    if (error) throw error;
    // Flush a trailing partial multi-byte sequence to the streaming consumer only;
    // the raw bytes are already in `parts`, so it must not be appended again.
    const tail = decoder.decode();
    if (tail && options.onOutput) options.onOutput(tail);
    return { stdout: decodeUtf8(concatBytes(parts)), exitCode: stream.exitCode ?? null };
  }

  /**
   * Push bytes to the device over the `sync:` service, streaming in
   * <= 64 KiB DATA chunks. Accepts a `Blob` (sliced per chunk, so the payload is
   * never copied wholesale) or a `Uint8Array`/`ArrayBuffer`.
   *
   * @param {string} remotePath target path on the device
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView|Blob} data
   * @param {{mode?: number, mtime?: number, onProgress?: (p: {sent: number, total: number}) => void,
   *          timeout?: number}} [options] `mode` is the decimal permission set
   *   (e.g. 0o644). `sha256` in the result is computed while streaming, using a
   *   dependency-free incremental hasher.
   * @returns {Promise<{bytes: number, sha256: string}>}
   * @throws {AdbFailError} includes the device's errno (and name, e.g. EACCES).
   */
  async push(remotePath, data, options = {}) {
    const mode = options.mode ?? 0o644;
    const mtime = options.mtime ?? Math.floor(Date.now() / 1000);
    const total = byteLengthOf(data);
    const deadline = this._deadline(options.timeout ?? this.pushTimeout, `push(${remotePath})`);
    const stream = await this._openStream('sync:', deadline);
    const hash = new Sha256();
    let sent = 0;
    let error = null;

    try {
      await this._writeToStream(
        stream,
        packSync('SEND', encodeUtf8(`${remotePath},${mode}`)),
        deadline,
        `push(${remotePath}) SEND`
      );

      for (let off = 0; off < total; off += SYNC_DATA_MAX) {
        const n = Math.min(SYNC_DATA_MAX, total - off);
        const chunk = await bytesAt(data, off, n);
        hash.update(chunk);
        await this._writeToStream(stream, packSync('DATA', chunk), deadline, `push(${remotePath}) DATA`);
        sent += n;
        if (options.onProgress) options.onProgress({ sent, total });
      }

      await this._writeToStream(stream, concatBytes([encodeUtf8('DONE'), u32Bytes(mtime)]), deadline, `push(${remotePath}) DONE`);
      await this._syncExpectOkay(stream, deadline, `DONE ${remotePath}`);
      await this._writeToStream(stream, packSync('QUIT'), deadline, `push(${remotePath}) QUIT`);
    } catch (err) {
      error = err;
    } finally {
      await this._closeStream(stream);
    }
    if (error) throw error;
    return { bytes: sent, sha256: hash.hex() };
  }

  /**
   * `stat` a remote path over the sync service.
   *
   * @param {string} remotePath
   * @param {{timeout?: number}} [options]
   * @returns {Promise<{mode: number, size: number, mtime: number}|null>} null when
   *   the path does not exist (ENOENT/ENOTDIR); other failures throw.
   */
  async stat(remotePath, options = {}) {
    const deadline = this._deadline(options.timeout, `stat(${remotePath})`);
    const stream = await this._openStream('sync:', deadline);
    let result;
    let error = null;
    try {
      await this._writeToStream(
        stream,
        packSync('STAT', encodeUtf8(remotePath)),
        deadline,
        `stat(${remotePath}) STAT`
      );
      const id = ascii4(await this._take(stream, 4, deadline, `stat(${remotePath}) reply`));
      if (id === 'STAT') {
        const rest = await this._take(stream, 12, deadline, `stat(${remotePath}) values`);
        result = { mode: readU32LE(rest, 0), size: readU32LE(rest, 4), mtime: readU32LE(rest, 8) };
      } else if (id === SYNC_FAIL) {
        const err = await this._take(stream, 4, deadline, `stat(${remotePath}) errno`);
        const errno = readU32LE(err, 0);
        if (errno === 2 || errno === 20) {
          result = null;
        } else {
          throw new AdbFailError(
            `stat(${remotePath}) failed: device returned FAIL errno ${errno} (${errnoName(errno)})`,
            { errno, label: `stat(${remotePath})` }
          );
        }
      } else {
        throw new AdbError(`sync protocol error while stat(${remotePath}): unexpected reply id ${JSON.stringify(id)}`);
      }
    } catch (err) {
      error = err;
    } finally {
      await this._closeStream(stream);
    }
    if (error) throw error;
    return result;
  }

  /**
   * Whether a remote path exists.
   * @param {string} remotePath
   * @param {{timeout?: number}} [options]
   * @returns {Promise<boolean>}
   */
  async exists(remotePath, options = {}) {
    return (await this.stat(remotePath, options)) !== null;
  }

  /**
   * Close every open stream and release the transport.
   * @returns {Promise<void>}
   */
  async close() {
    const open = [...this._streams.values()];
    for (const stream of open) {
      await this._closeStream(stream, new AdbError('ADB client closed while the stream was open'));
    }
    this._closed = true;
    if (typeof this.transport.close === 'function') {
      try {
        await this.transport.close();
      } catch {
        /* the device is already gone; nothing to do */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* internals: plumbing                                                */
  /* ------------------------------------------------------------------ */

  /**
   * @param {number|undefined} timeout
   * @param {string} label
   * @returns {Deadline}
   * @private
   */
  _deadline(timeout, label) {
    return new Deadline(typeof timeout === 'number' && timeout > 0 ? timeout : this.timeout, label);
  }

  /**
   * Reject a promise when the deadline passes, with a message naming the
   * operation. This is the single choke point that prevents hangs.
   * @template T
   * @param {Promise<T>} promise
   * @param {Deadline} deadline
   * @param {string} label
   * @returns {Promise<T>}
   * @private
   */
  _race(promise, deadline, label) {
    const ms = deadline.remaining();
    if (ms <= 0) {
      return Promise.reject(
        new AdbTimeoutError(`ADB timeout after ${deadline.total} ms while ${label}`, {
          label,
          timeoutMs: deadline.total,
        })
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new AdbTimeoutError(`ADB timeout after ${deadline.total} ms while ${label}`, {
            label,
            timeoutMs: deadline.total,
          })
        );
      }, ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /**
   * @param {number} command
   * @param {number} arg0
   * @param {number} arg1
   * @param {Uint8Array} [payload]
   * @param {Deadline} deadline
   * @param {string} label
   * @returns {Promise<void>}
   * @private
   */
  async _send(command, arg0, arg1, payload, deadline, label) {
    if (this._closed) throw new AdbError(`ADB client is closed; cannot send ${label}`);
    if (this._readerError) throw this._readerError;
    const frame = buildMessage(command, arg0, arg1, payload ?? EMPTY);
    this._setTransportTimeout(deadline);
    try {
      await this.transport.write(frame);
      if (typeof this.transport.flush === 'function') await this.transport.flush();
    } catch (err) {
      throw new AdbError(`ADB transport write failed while ${label}: ${err?.message ?? err}`, { cause: err });
    }
  }

  /**
   * Best-effort transport-level timeout hint; never throws.
   * @param {Deadline} deadline
   * @private
   */
  _setTransportTimeout(deadline) {
    if (typeof this.transport.setTimeout !== 'function') return;
    try {
      const p = this.transport.setTimeout(Math.max(0, deadline.remaining()));
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* the transport does not care; our own deadline still applies */
    }
  }

  /** @private */
  _startReader() {
    if (this._readerStarted) return;
    this._readerStarted = true;
    this._readLoop().catch((err) => this._fail(err));
  }

  /** @private */
  async _readLoop() {
    while (!this._closed) {
      const chunk = await this.transport.read();
      if (chunk == null) throw new AdbError('ADB transport ended unexpectedly (no more data from the device)');
      if (chunk.length === 0) continue;
      this._append(chunk);
      this._parse();
    }
  }

  /**
   * @param {Uint8Array} chunk
   * @private
   */
  _append(chunk) {
    if (this._buf.length === 0) {
      this._buf = chunk;
      return;
    }
    const next = new Uint8Array(this._buf.length + chunk.length);
    next.set(this._buf, 0);
    next.set(chunk, this._buf.length);
    this._buf = next;
  }

  /**
   * Parse every complete message currently buffered. A single transport read may
   * hold half a message, several messages, or anything in between.
   * @private
   */
  _parse() {
    while (true) {
      if (this._buf.length < HEADER_SIZE) return;
      const header = parseHeader(this._buf, 0);
      if (header.magic !== ((header.command ^ 0xffffffff) >>> 0)) {
        throw new AdbError(
          `ADB protocol error: bad header magic (command 0x${header.command.toString(16)}, ` +
            `magic 0x${header.magic.toString(16)})`
        );
      }
      if (header.dataLength > this.maxData + 1024) {
        throw new AdbError(`ADB protocol error: data_length ${header.dataLength} exceeds maxData ${this.maxData}`);
      }
      const total = HEADER_SIZE + header.dataLength;
      if (this._buf.length < total) return;
      const payload = this._buf.slice(HEADER_SIZE, total);
      const actualChecksum = adbChecksum(payload);
      if (actualChecksum !== header.dataChecksum) {
        throw new AdbError(
          `ADB protocol error: payload checksum mismatch for command 0x${header.command.toString(16)} ` +
            `(header ${header.dataChecksum}, computed ${actualChecksum})`
        );
      }
      const rest = this._buf.subarray(total);
      this._buf = rest.length ? rest.slice() : EMPTY;
      this._dispatch(header, payload);
    }
  }

  /**
   * @param {{command:number, arg0:number, arg1:number, dataLength:number,
   *          dataChecksum:number, magic:number}} header
   * @param {Uint8Array} payload
   * @private
   */
  _dispatch(header, payload) {
    switch (header.command) {
      case A_CNXN: {
        const wait = this._cnxn;
        this._cnxn = null;
        if (wait && !wait.settled) {
          wait.settled = true;
          wait.resolve({
            deviceBanner: cstring(payload),
            version: header.arg0,
            maxData: header.arg1,
          });
        }
        return;
      }
      case A_AUTH: {
        const wait = this._cnxn;
        this._cnxn = null;
        const err = new AdbAuthRequiredError(
          `device demands AUTH (${payload.length}-byte token) and no key provider is configured`,
          { tokenLength: payload.length }
        );
        if (wait && !wait.settled) {
          wait.settled = true;
          wait.reject(err);
        } else {
          this._fail(err);
        }
        return;
      }
      case A_OKAY: {
        const stream = this._streams.get(header.arg1);
        if (!stream) return;
        stream.remoteId = header.arg0;
        if (stream.state === 'opening') {
          stream.state = 'open';
          if (!stream.opened.settled) {
            stream.opened.settled = true;
            stream.opened.resolve();
          }
        } else if (stream.pendingAcks > 0) {
          stream.pendingAcks -= 1;
          const waiter = stream.ackWaiters.shift();
          if (waiter) waiter();
        }
        return;
      }
      case A_WRTE: {
        const stream = this._streams.get(header.arg1);
        if (!stream) return;
        stream.remoteId = header.arg0;
        this._ackStream(stream);
        if (stream.onData) stream.onData(payload);
        else stream.rx.push(payload);
        return;
      }
      case A_CLSE: {
        const stream = this._streams.get(header.arg1);
        if (!stream) return;
        stream.remoteId = header.arg0;
        stream.closedByDevice = true;
        const localId = stream.localId;
        const remoteId = stream.remoteId;
        this._finishStream(stream, stream.error ?? null);
        // The peer closed first: answer with CLSE so both ends agree it is gone.
        this._send(A_CLSE, localId, remoteId, EMPTY, this._deadline(this.timeout, 'CLSE'), 'CLSE').catch(() => {});
        return;
      }
      case A_FAIL: {
        const stream = this._streams.get(header.arg1);
        const text = cstring(payload) || decodeUtf8(payload);
        const service = stream ? stream.service : 'unknown';
        const err = new AdbFailError(
          `device refused ${service}: FAIL${text ? ` "${text}"` : ''}`,
          { text, service, label: service }
        );
        if (!stream) return;
        stream.remoteId = header.arg0;
        this._finishStream(stream, err);
        return;
      }
      default:
        // A_SYNC and anything unknown: ignore (no legacy SYNC handshake needed).
        return;
    }
  }

  /**
   * Mark a stream finished exactly once, waking everyone waiting on it.
   * @param {any} stream
   * @param {Error|null} error
   * @private
   */
  _finishStream(stream, error = null) {
    if (stream.finished) return;
    stream.finished = true;
    stream.error = error ?? stream.error ?? null;
    this._streams.delete(stream.localId);
    if (!stream.opened.settled) {
      stream.opened.settled = true;
      if (error) stream.opened.reject(error);
      else stream.opened.resolve();
    }
    if (!stream.closed.settled) {
      stream.closed.settled = true;
      if (error) stream.closed.reject(error);
      else stream.closed.resolve();
    }
    stream.rx._wake();
  }

  /**
   * A write to the device was consumed: send the OKAY that lets adbd send more.
   * @param {any} stream
   * @private
   */
  _ackStream(stream) {
    this._send(
      A_OKAY,
      stream.localId,
      stream.remoteId,
      EMPTY,
      this._deadline(this.timeout, 'OKAY'),
      'OKAY (flow control)'
    ).catch(() => {});
  }

  /**
   * Something broke at transport level: fail every waiter rather than hang.
   * @param {Error} err
   * @private
   */
  _fail(err) {
    if (this._readerError) return;
    this._readerError = err;
    const wait = this._cnxn;
    this._cnxn = null;
    if (wait && !wait.settled) {
      wait.settled = true;
      wait.reject(err);
    }
    for (const stream of [...this._streams.values()]) this._finishStream(stream, err);
  }

  /* ------------------------------------------------------------------ */
  /* internals: streams                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Open a service stream and wait for the device's OKAY.
   * @param {string} service e.g. 'shell:ls' or 'sync:'
   * @param {Deadline} deadline
   * @returns {Promise<any>}
   * @private
   */
  async _openStream(service, deadline) {
    const localId = this._nextLocalId++;
    const stream = {
      localId,
      remoteId: 0,
      service,
      state: 'opening',
      finished: false,
      closedByDevice: false,
      error: null,
      exitCode: null,
      onData: null,
      rx: new ByteQueue(),
      opened: makeDeferred(),
      closed: makeDeferred(),
      pendingAcks: 0,
      ackWaiters: [],
    };
    this._streams.set(localId, stream);
    try {
      const payload = encodeUtf8(service.endsWith('\0') ? service : `${service}\0`);
      await this._send(A_OPEN, localId, 0, payload, deadline, `OPEN ${service}`);
      await this._race(stream.opened.promise, deadline, `OPEN ${service}`);
    } catch (err) {
      this._finishStream(stream, err instanceof Error ? err : new AdbError(String(err)));
      throw err;
    }
    return stream;
  }

  /**
   * Send a WRTE and (by default) wait for the device's OKAY.
   * @param {any} stream
   * @param {Uint8Array} payload
   * @param {Deadline} deadline
   * @param {string} label
   * @returns {Promise<void>}
   * @private
   */
  async _writeToStream(stream, payload, deadline, label) {
    if (payload.length > this.maxData) {
      throw new AdbError(`internal error: ${label} payload ${payload.length} exceeds maxData ${this.maxData}`);
    }
    let ack = null;
    if (this.ackWrites) {
      ack = new Promise((resolve) => stream.ackWaiters.push(resolve));
      ack.catch(() => {});
    }
    stream.pendingAcks += 1;
    await this._send(A_WRTE, stream.localId, stream.remoteId, payload, deadline, label);
    if (ack) {
      await this._race(ack, deadline, `${label} (waiting for device OKAY)`);
    } else {
      stream.pendingAcks -= 1;
    }
  }

  /**
   * Close a stream, sending CLSE unless the device already closed it.
   * @param {any} stream
   * @param {Error|null} [error] failures to reject pending waiters with
   * @returns {Promise<void>}
   * @private
   */
  async _closeStream(stream, error = null) {
    if (stream.finished) return;
    const localId = stream.localId;
    const remoteId = stream.remoteId;
    this._finishStream(stream, error);
    if (!stream.closedByDevice && remoteId) {
      try {
        await this._send(A_CLSE, localId, remoteId, EMPTY, this._deadline(this.timeout, 'CLSE'), 'CLSE');
      } catch {
        /* best effort: the stream is already gone locally */
      }
    }
  }

  /**
   * Read exactly `n` bytes from a stream, honouring the deadline.
   * @param {any} stream
   * @param {number} n
   * @param {Deadline} deadline
   * @param {string} label
   * @returns {Promise<Uint8Array>}
   * @private
   */
  async _take(stream, n, deadline, label) {
    while (true) {
      if (stream.rx.length >= n) return stream.rx.take(n);
      if (stream.error) throw stream.error;
      if (stream.finished) throw new AdbError(`ADB stream closed by the device before ${label} completed`);
      await this._race(stream.rx.waited(), deadline, label);
    }
  }

  /**
   * Read an 8-byte sync reply (id + uint32) and turn FAIL into AdbFailError.
   * @param {any} stream
   * @param {Deadline} deadline
   * @param {string} label
   * @returns {Promise<number>} the OKAY value (always 0 on real devices)
   * @private
   */
  async _syncExpectOkay(stream, deadline, label) {
    const id = ascii4(await this._take(stream, 4, deadline, `${label} reply`));
    if (id === SYNC_OKAY) {
      const value = await this._take(stream, 4, deadline, `${label} reply value`);
      return readU32LE(value, 0);
    }
    if (id === SYNC_FAIL) {
      const value = await this._take(stream, 4, deadline, `${label} errno`);
      const errno = readU32LE(value, 0);
      throw new AdbFailError(
        `sync ${label} failed: device returned FAIL errno ${errno} (${errnoName(errno)})`,
        { errno, label }
      );
    }
    throw new AdbError(`sync protocol error while ${label}: unexpected reply id ${JSON.stringify(id)}`);
  }
}

/**
 * @param {number} value
 * @returns {Uint8Array} 4-byte little-endian encoding
 */
function u32Bytes(value) {
  const out = new Uint8Array(4);
  writeU32LE(out, 0, value);
  return out;
}

export default AdbClient;
