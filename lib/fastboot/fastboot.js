/**
 * @file fastboot.js
 * @summary Dependency-free implementation of the Fastboot USB protocol.
 *
 * The Fastboot wire protocol is byte oriented and needs no libraries, so this
 * module runs unchanged in Chromium (through WebUSB), in Node, and in tests,
 * as long as a transport implementing the small interface below is supplied:
 *
 *   class Transport {
 *     async write(bytes: Uint8Array): void   // send raw bytes to the device
 *     async read(): Uint8Array | null        // next chunk of bytes, null on timeout
 *     async flush(): void                    // discard buffered input
 *     setTimeout(ms: number): void           // per-transfer timeout
 *   }
 *
 * Wire format recap
 * -----------------
 *   host -> device: ASCII command, e.g. "getvar:product", "download:00001000",
 *                   "flash:boot_a", "erase:expdb", "reboot".
 *   device -> host: 4 ASCII status bytes (OKAY / FAIL / DATA / INFO), then
 *                   - for INFO / TEXT / DATA: 8 ASCII hex digits (payload
 *                     length, or max accepted chunk size for DATA) followed by
 *                     that many payload bytes;
 *                   - for OKAY / FAIL: any bytes that follow in the same
 *                     transfer are the result / failure reason text.
 *
 * Real devices are fussy: a response may arrive split across several reads and
 * a single read may carry several messages, so every byte goes through
 * `ResponseStream`, an incremental parser that never assumes one read equals
 * one message.
 */

/* ─────────────────────────── wire constants ─────────────────────────── */

export const STATUS_OKAY = 'OKAY';
export const STATUS_FAIL = 'FAIL';
export const STATUS_DATA = 'DATA';
export const STATUS_INFO = 'INFO';
export const STATUS_TEXT = 'TEXT';

/** The four (plus TEXT) Fastboot status words. */
export const FastbootStatus = Object.freeze({
  OKAY: STATUS_OKAY,
  FAIL: STATUS_FAIL,
  DATA: STATUS_DATA,
  INFO: STATUS_INFO,
  TEXT: STATUS_TEXT,
});

const STATUS_LENGTH = 4; // every reply starts with 4 ASCII status bytes
const LENGTH_FIELD_LENGTH = 8; // 8 ASCII hex digits: payload length / chunk size
const TERMINAL_STATUSES = new Set([STATUS_OKAY, STATUS_FAIL]);
const TEXT_STATUSES = new Set([STATUS_INFO, STATUS_TEXT]);
const KNOWN_STATUSES = new Set([...TERMINAL_STATUSES, ...TEXT_STATUSES, STATUS_DATA]);
const HEX_FIELD_RE = /^[0-9a-fA-F]{8}$/;

/** Default per-transfer timeout, milliseconds. */
export const DEFAULT_TIMEOUT_MS = 10000;
/** Chunk size used when the device never reports "max-download-size". */
export const DEFAULT_MAX_DOWNLOAD_SIZE = 0x100000;
/** How long to keep waiting for the reason text that follows a FAIL. */
const LATE_TEXT_GRACE_MS = 150;
/** How many extra reads are allowed while collecting that late reason text. */
const LATE_TEXT_MAX_READS = 4;

/* ───────────────────────────── helpers ─────────────────────────────── */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** @param {string} text @returns {Uint8Array} */
function encodeAscii(text) {
  return textEncoder.encode(text);
}

/** @param {Uint8Array} bytes @returns {string} */
function decodeText(bytes) {
  return textDecoder.decode(bytes);
}

/**
 * Join an arbitrary number of byte chunks into one Uint8Array.
 * @param {...(Uint8Array|null|undefined)} chunks
 * @returns {Uint8Array}
 */
export function concatBytes(...chunks) {
  let total = 0;
  for (const chunk of chunks) if (chunk && chunk.length) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (!chunk || !chunk.length) continue;
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * Normalise a value as it comes off the wire: drop padding NULs and stray
 * whitespace and tolerate the "okay<value>" prefix some bootloaders emit.
 * @param {string|Uint8Array|null|undefined} text
 * @returns {string}
 */
export function cleanValue(text) {
  if (text === null || text === undefined) return '';
  let out = String(typeof text === 'string' ? text : decodeText(text));
  out = out.replace(/^[\s\0]+/, '').replace(/[\s\0]+$/, '');
  // "okay", "okay 0x1000", "okay0x1000", "okay: 0x1000" -> "0x1000"
  out = out.replace(/^okay(?=$|[\s:=[\],;]|0x|\d)[\s:=[\],;]*/i, '');
  return out.trim();
}

/**
 * Encode a length as the 8 digit lowercase hex field Fastboot uses.
 * @param {number} value
 * @returns {string}
 */
export function toHex8(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new RangeError(`fastboot: cannot encode ${JSON.stringify(value)} as an 8 digit hex field`);
  }
  return n.toString(16).padStart(8, '0');
}

/**
 * Parse a partition size / size string as bootloaders report it. Accepts both
 * decimal ("268435456") and 0x-prefixed hex ("0x10000000").
 * @param {string|number} value
 * @returns {number}
 */
export function parsePartitionSize(value) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`fastboot: not a partition size: ${String(value)}`);
    }
    return value;
  }
  const text = String(value ?? '').replace(/^[\s\0]+|[\s\0]+$/g, '');
  if (!text) throw new Error('fastboot: empty partition size');
  if (/^0x[0-9a-f]+$/i.test(text)) return parseInt(text, 16);
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`fastboot: not a partition size: ${JSON.stringify(String(value))}`);
  }
  return Number(text);
}

/**
 * Coerce the many reasonable byte containers into a Uint8Array.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView|number[]|Blob} input
 * @param {string} what
 * @returns {Promise<Uint8Array>}
 */
async function toBytes(input, what) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (Array.isArray(input)) return Uint8Array.from(input);
  if (input && typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
  throw new TypeError(`fastboot: ${what} must be a Uint8Array, ArrayBuffer, view, byte array or Blob`);
}

/** @returns {number} */
function nowMs() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/* ────────────────────────────── errors ─────────────────────────────── */

/** Base class for every error this module throws. */
export class FastbootError extends Error {
  /**
   * @param {string} message
   * @param {{command?: string|null, status?: string|null, cause?: unknown}} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'FastbootError';
    /** Command that was in flight, when known. */
    this.command = details.command ?? null;
    /** Terminal status word, when known. */
    this.status = details.status ?? null;
  }
}

/** The device answered FAIL. The reason text is preserved verbatim. */
export class FastbootFailError extends FastbootError {
  /**
   * @param {string} command
   * @param {string} reason
   */
  constructor(command, reason) {
    const text = reason && reason.length ? reason : 'device reported FAIL without a reason';
    super(`fastboot: "${command}" failed: ${text}`, { command, status: STATUS_FAIL });
    this.name = 'FastbootFailError';
    /** Raw reason text from the bootloader (may be empty). */
    this.reason = reason ?? '';
  }
}

/** No reply arrived inside the configured timeout. */
export class FastbootTimeoutError extends FastbootError {
  /**
   * @param {string} command
   * @param {number} timeoutMs
   * @param {string} [what]
   */
  constructor(command, timeoutMs, what = 'a device reply') {
    super(`fastboot: timed out after ${timeoutMs}ms waiting for ${what} to "${command}"`, { command });
    this.name = 'FastbootTimeoutError';
    /** Timeout that elapsed, in milliseconds. */
    this.timeoutMs = timeoutMs;
  }
}

/** The device broke the framing rules (unknown status word, bad length field...). */
export class FastbootProtocolError extends FastbootError {
  /**
   * @param {string|null} command
   * @param {string} detail
   */
  constructor(command, detail) {
    super(`fastboot: protocol error${command ? ` for "${command}"` : ''}: ${detail}`, { command });
    this.name = 'FastbootProtocolError';
    this.detail = detail;
  }
}

/* ───────────────────────────── transport ───────────────────────────── */

/**
 * Transport interface a FastbootClient talks to. Subclass it (see
 * webusb-fastboot-transport.js) or pass any object with the same methods.
 * A Transport is deliberately dumb: bytes in, bytes out.
 */
export class Transport {
  /** @param {Uint8Array} bytes */
  async write(bytes) { // eslint-disable-line no-unused-vars
    throw new Error('Transport.write() is not implemented');
  }

  /** @returns {Promise<Uint8Array|null>} null means "nothing arrived before the timeout" */
  async read() {
    throw new Error('Transport.read() is not implemented');
  }

  async flush() {
    throw new Error('Transport.flush() is not implemented');
  }

  /** @param {number} ms */
  setTimeout(ms) { // eslint-disable-line no-unused-vars
    throw new Error('Transport.setTimeout() is not implemented');
  }
}

const TRANSPORT_METHODS = ['write', 'read', 'flush', 'setTimeout'];

/**
 * Fail fast with a helpful message when a bogus transport is supplied.
 * @param {unknown} transport
 */
export function assertTransport(transport) {
  if (!transport || typeof transport !== 'object') {
    throw new TypeError('fastboot: a transport object is required (see Transport)');
  }
  const missing = TRANSPORT_METHODS.filter((name) => typeof (/** @type {any} */ (transport))[name] !== 'function');
  if (missing.length) {
    throw new TypeError(`fastboot: transport is missing method(s): ${missing.map((m) => `${m}()`).join(', ')}`);
  }
}

/* ─────────────────────── incremental reply parser ──────────────────── */

/**
 * Buffers raw device bytes and yields one complete Fastboot message at a time.
 * Message shape: `{ status, payload, length }` where `payload` holds the bytes
 * of an INFO/TEXT payload (or the trailing text of OKAY/FAIL) and `length` is
 * the number parsed from the 8 hex digit length field of DATA messages.
 */
export class ResponseStream {
  constructor() {
    /** @type {Uint8Array} */
    this._bytes = new Uint8Array(0);
  }

  /** Drop everything buffered so far. */
  reset() {
    this._bytes = new Uint8Array(0);
  }

  /** @returns {number} bytes waiting to be parsed */
  get pending() {
    return this._bytes.length;
  }

  /** @param {Uint8Array} chunk */
  push(chunk) {
    if (!chunk || chunk.length === 0) return;
    this._bytes = concatBytes(this._bytes, chunk);
  }

  /**
   * Pull the next complete message out of the buffer.
   * @returns {{status: string, payload: Uint8Array, length: number|null}|null}
   *   null while more bytes are needed.
   */
  next() {
    const buf = this._bytes;
    if (buf.length < STATUS_LENGTH) return null;
    const status = decodeText(buf.subarray(0, STATUS_LENGTH));
    if (!KNOWN_STATUSES.has(status)) {
      throw new FastbootProtocolError(null, `unexpected status word ${JSON.stringify(status)} in device reply`);
    }

    if (TERMINAL_STATUSES.has(status)) {
      // Everything after OKAY/FAIL in this transfer is the result / reason text.
      const rest = buf.subarray(STATUS_LENGTH);
      const nul = rest.indexOf(0);
      const text = nul === -1 ? rest : rest.subarray(0, nul);
      this._bytes = new Uint8Array(0);
      return { status, payload: Uint8Array.from(text), length: null };
    }

    if (buf.length < STATUS_LENGTH + LENGTH_FIELD_LENGTH) return null;
    const hex = decodeText(buf.subarray(STATUS_LENGTH, STATUS_LENGTH + LENGTH_FIELD_LENGTH));
    if (!HEX_FIELD_RE.test(hex)) {
      throw new FastbootProtocolError(null, `invalid length field ${JSON.stringify(hex)} after ${status}`);
    }
    const length = parseInt(hex, 16);
    const start = STATUS_LENGTH + LENGTH_FIELD_LENGTH;
    if (status === STATUS_DATA) {
      // A DATA reply is only the status word plus the 8 hex digit window: the
      // payload travels host -> device, so nothing follows it here.
      this._bytes = Uint8Array.from(buf.subarray(start));
      return { status, payload: new Uint8Array(0), length };
    }
    if (buf.length < start + length) return null; // still arriving
    const payload = Uint8Array.from(buf.subarray(start, start + length));
    this._bytes = Uint8Array.from(buf.subarray(start + length));
    return { status, payload, length };
  }
}

/* ──────────────────────────── fastboot client ──────────────────────── */

/**
 * High level Fastboot client. Works against any object implementing the
 * {@link Transport} interface, so the protocol layer stays testable in Node
 * and portable to any byte pipe.
 */
export class FastbootClient {
  /**
   * @param {Transport} transport already-open transport
   * @param {{timeout?: number, timeoutMs?: number, maxDownloadSize?: number|null, onInfo?: ((line: string) => void)|null}} [options]
   *   `timeout` is the per-transfer timeout in milliseconds used for every
   *   command (and re-applied to the transport before each read).
   */
  constructor(transport, options = {}) {
    assertTransport(transport);
    /** @type {Transport} */
    this.transport = transport;
    /** Per-transfer timeout in milliseconds. @type {number} */
    this.timeoutMs = options.timeoutMs ?? options.timeout ?? DEFAULT_TIMEOUT_MS;
    /** Cached "max-download-size" reported by the device, or null. @type {number|null} */
    this.maxDownloadSize = options.maxDownloadSize ?? null;
    /** Optional sink for INFO progress lines. @type {((line: string) => void)|null} */
    this.onInfo = options.onInfo ?? null;
    this._stream = new ResponseStream();
  }

  /* ── low level plumbing ─────────────────────────────────────────────── */

  /**
   * Send one command and read its full reply, buffering across reads.
   * @param {string} command ASCII command without a trailing NUL
   * @param {{allowNoReply?: boolean, expectValue?: boolean}} [options]
   *   `allowNoReply` turns a silent device into `{status: null, noReply: true}`
   *   instead of a timeout (used by reboot/continue/power).
   *   `expectValue` adds one short grace read for OKAY replies so values that
   *   arrive in a second transfer are not lost (used by getVar).
   * @returns {Promise<{status: string|null, info: string[], payload: Uint8Array|null, dataLength: number|null, noReply: boolean}>}
   */
  async _command(command, options = {}) {
    const { allowNoReply = false, expectValue = false } = options;
    this._stream.reset();
    try {
      await this.transport.flush();
    } catch (cause) {
      throw new FastbootError(`fastboot: transport failed to flush before "${command}": ${messageOf(cause)}`, { command, cause });
    }
    this.transport.setTimeout(this.timeoutMs);
    try {
      await this.transport.write(encodeAscii(command));
    } catch (cause) {
      throw new FastbootError(`fastboot: transport failed to send "${command}": ${messageOf(cause)}`, { command, cause });
    }
    const message = await this._readReply(command, { allowNoReply, expectValue });
    return {
      status: message.status,
      info: message.info,
      payload: message.payload,
      dataLength: message.length,
      noReply: Boolean(message.noReply),
    };
  }

  /**
   * Read messages until a terminal (OKAY/FAIL, or DATA for download:).
   * INFO/TEXT lines are collected; bytes are buffered so split reads and
   * multiple messages per read are both handled.
   */
  async _readReply(command, { allowNoReply = false, expectValue = false } = {}) {
    const startedAt = nowMs();
    const info = [];
    for (;;) {
      let message = this._stream.next();
      while (message) {
        if (TEXT_STATUSES.has(message.status)) {
          info.push(decodeText(message.payload));
          message = this._stream.next();
          continue;
        }
        const wantsLateText = message.status === STATUS_FAIL
          || (expectValue && message.status === STATUS_OKAY);
        if (wantsLateText && message.payload.length === 0) {
          const late = await this._readLateText(command, startedAt);
          if (late) message.payload = late;
        }
        return { ...message, info };
      }

      const elapsed = nowMs() - startedAt;
      if (elapsed >= this.timeoutMs) throw new FastbootTimeoutError(command, this.timeoutMs);
      const remaining = Math.max(1, Math.ceil(this.timeoutMs - elapsed));
      this.transport.setTimeout(remaining);
      let chunk;
      try {
        chunk = await this.transport.read();
      } catch (cause) {
        throw new FastbootError(`fastboot: transport failed while reading the reply to "${command}": ${messageOf(cause)}`, { command, cause });
      }
      if (chunk === null || chunk === undefined) {
        if (allowNoReply) return { status: null, info, payload: null, length: null, noReply: true };
        throw new FastbootTimeoutError(command, this.timeoutMs);
      }
      if (chunk.length === 0) continue;
      this._stream.push(chunk);
    }
  }

  /**
   * Some bootloaders send "FAIL" and the reason (or an OKAY result value) in
   * two separate transfers. Give them a short, bounded opportunity to deliver.
   * @returns {Promise<Uint8Array|null>}
   */
  async _readLateText(command, startedAt) {
    const chunks = [];
    for (let attempt = 0; attempt < LATE_TEXT_MAX_READS; attempt += 1) {
      const elapsed = nowMs() - startedAt;
      if (elapsed >= this.timeoutMs) break;
      this.transport.setTimeout(Math.max(1, Math.min(LATE_TEXT_GRACE_MS, Math.ceil(this.timeoutMs - elapsed))));
      let chunk;
      try {
        chunk = await this.transport.read();
      } catch {
        break;
      }
      if (!chunk || chunk.length === 0) break;
      chunks.push(chunk);
      const merged = concatBytes(...chunks);
      if (merged.indexOf(0) !== -1) return merged; // NUL terminated: complete
    }
    return chunks.length ? concatBytes(...chunks) : null;
  }

  /** Reason text for a FAIL reply, payload first then the last INFO line. */
  _reason(response) {
    const fromPayload = cleanValue(response?.payload ?? null);
    if (fromPayload) return fromPayload;
    const lines = (response?.info ?? []).map(cleanValue).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : '';
  }

  /** Send a command and require OKAY (or a tolerated silence). */
  async _expectOkay(command, { allowNoReply = false } = {}) {
    const res = await this._command(command, { allowNoReply });
    if (res.status === STATUS_FAIL) throw new FastbootFailError(command, this._reason(res));
    if (res.status !== STATUS_OKAY) {
      if (res.noReply) return res;
      throw new FastbootProtocolError(command, `expected OKAY from the device, received ${String(res.status)}`);
    }
    return res;
  }

  /** INFO lines of a reply, cleaned and de-duplicated of empties. */
  _lines(response) {
    return (response?.info ?? []).map(cleanValue).filter(Boolean);
  }

  /** Effective download chunk size, asking the device once when needed. */
  async _resolveChunkSize(requested) {
    if (this.maxDownloadSize === null) {
      try {
        await this.getVar('max-download-size');
      } catch {
        /* device does not implement it (or FAILed): fall back to the default */
      }
    }
    let max = this.maxDownloadSize ?? DEFAULT_MAX_DOWNLOAD_SIZE;
    if (requested && requested > 0) max = Math.min(max, requested);
    return Math.max(1, max);
  }

  /* ── public API ─────────────────────────────────────────────────────── */

  /**
   * Run a raw ASCII command and return the unparsed result.
   *
   * Unlike the convenience helpers below, `raw()` never throws for a device
   * FAIL: the FAIL status and its reason are reported in the result and it is
   * up to the caller to decide what a failure means.
   * @param {string} command e.g. "getvar:product", "oem unlock", "reboot"
   * @returns {Promise<{status: string|null, info: string[], data: Uint8Array|null, dataLength: number|null, noReply: boolean}>}
   *   `status` is "OKAY" | "FAIL" | "DATA" (or null when the device stayed
   *   silent and silence was tolerated), `info` holds the cleaned INFO/TEXT
   *   lines, `data` holds the payload bytes (OKAY/FAIL text, if any) and
   *   `dataLength` the chunk size offered by a DATA reply.
   */
  async raw(command) {
    const res = await this._command(String(command));
    const data = res.payload && res.payload.length ? res.payload : null;
    return { status: res.status, info: this._lines(res), data, dataLength: res.dataLength, noReply: res.noReply };
  }

  /**
   * Read a bootloader variable.
   *
   * Handles every multi line form real bootloaders emit for
   * `getvar:product`, `getvar:partition-size:<name>`,
   * `getvar:max-download-size`, `getvar:unlock_status` ("true"/"false"/
   * "unlocked"/"locked"), `getvar:lk_build_desc`, `getvar:serialno`, ...
   * INFO payload lines are cleaned (trailing NULs, an "okay" prefix and a
   * leading "<name>:" echoed by some bootloaders) and joined with "\n".
   * `max-download-size` is cached on {@link FastbootClient#maxDownloadSize}.
   * @param {string} name variable name, may contain ':' (partition-size:boot_a)
   * @returns {Promise<string>} the value, '' when the device returned nothing
   * @throws {FastbootFailError} when the device answers FAIL
   * @throws {FastbootTimeoutError} when the device never answers
   */
  async getVar(name) {
    const command = `getvar:${name}`;
    const res = await this._command(command, { expectValue: true });
    if (res.status === STATUS_FAIL) throw new FastbootFailError(command, this._reason(res));
    const value = this._valueFrom(res, name);
    if (name === 'max-download-size' && value) {
      try {
        const size = parsePartitionSize(value);
        if (size > 0) this.maxDownloadSize = size;
      } catch {
        /* unparsable value: keep whatever we had */
      }
    }
    return value;
  }

  /**
   * Convenience wrapper: `getvar:partition-size:<name>` parsed to a number.
   * @param {string} name partition name, e.g. "boot_a"
   * @returns {Promise<number>}
   */
  async getPartitionSize(name) {
    return parsePartitionSize(await this.getVar(`partition-size:${name}`));
  }

  /** Extract the value text from a getVar reply. */
  _valueFrom(res, name) {
    const strip = (text) => {
      let out = cleanValue(text);
      const prefix = `${String(name).toLowerCase()}:`;
      if (out.toLowerCase().startsWith(prefix)) out = cleanValue(out.slice(prefix.length));
      return out;
    };
    const parts = res.info.map(strip).filter((line) => line.length > 0);
    if (!parts.length && res.payload && res.payload.length) {
      const trailing = strip(decodeText(res.payload));
      if (trailing) parts.push(trailing);
    }
    return parts.join('\n');
  }

  /**
   * Upload a payload to the bootloader's download buffer.
   *
   * The image is split into chunks no larger than the device's reported
   * `max-download-size` (queried once through getvar when unknown, see
   * {@link DEFAULT_MAX_DOWNLOAD_SIZE} for the fallback) and no larger than
   * `chunkSize` when given. For each chunk the sequence is:
   *   -> `download:<8 hex digits>`   <- DATA + <8 hex digits accepted window>
   *   -> raw payload bytes           <- OKAY (or FAIL + reason)
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView|number[]|Blob} bytes
   * @param {{onProgress?: ((sent: number, total: number) => void)|null, chunkSize?: number, onInfo?: ((line: string) => void)|null}} [options]
   * @returns {Promise<number>} total bytes sent
   * @throws {FastbootFailError} on FAIL (the device reason is included)
   * @throws {FastbootTimeoutError} when a reply never arrives
   * @throws {FastbootProtocolError} when the device answers something unexpected
   */
  async download(bytes, { onProgress = null, chunkSize = 0, onInfo = null } = {}) {
    const data = await toBytes(bytes, 'payload');
    let maxChunk = await this._resolveChunkSize(chunkSize);
    const total = data.length;
    let sent = 0;
    while (sent < total) {
      const size = Math.min(maxChunk, total - sent);
      const command = `download:${toHex8(size)}`;
      const res = await this._command(command);
      if (res.status === STATUS_FAIL) throw new FastbootFailError(command, this._reason(res));
      if (res.status !== STATUS_DATA) {
        throw new FastbootProtocolError(command, `expected DATA from the device, received ${String(res.status)}`);
      }
      const offered = res.dataLength ?? size;
      const accepted = Math.min(offered, size);
      if (accepted <= 0) throw new FastbootProtocolError(command, 'the device offered a 0 byte window');
      if (accepted < size) {
        // The device offered less than we asked for: shrink our window too.
        maxChunk = Math.min(maxChunk, accepted);
        this.maxDownloadSize = Math.min(this.maxDownloadSize ?? accepted, accepted);
      }
      try {
        await this.transport.write(data.subarray(sent, sent + accepted));
      } catch (cause) {
        throw new FastbootError(`fastboot: transport failed to send the payload for "${command}": ${messageOf(cause)}`, { command, cause });
      }
      const ack = await this._readReply(command);
      for (const line of ack.info) {
        const clean = cleanValue(line);
        if (clean) {
          if (onInfo) onInfo(clean);
          else if (this.onInfo) this.onInfo(clean);
        }
      }
      if (ack.status === STATUS_FAIL) throw new FastbootFailError(command, this._reason(ack));
      if (ack.status !== STATUS_OKAY) {
        throw new FastbootProtocolError(command, `expected OKAY after the payload, received ${String(ack.status)}`);
      }
      sent += accepted;
      if (onProgress) onProgress(sent, total);
    }
    return sent;
  }

  /**
   * Write an image to a partition: `download:` the bytes, then `flash:<part>`.
   * Pass `bytes` as null/undefined to flash whatever was downloaded earlier
   * (`fastboot flash:<part>` on its own).
   * @param {string} partition partition name, e.g. "boot_a"
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView|number[]|Blob|null} [bytes]
   * @param {{onProgress?: ((sent: number, total: number) => void)|null, chunkSize?: number, onInfo?: ((line: string) => void)|null}} [options]
   * @returns {Promise<{bytes: number, info: string[]}>} bytes downloaded and the flash progress lines
   * @throws {FastbootFailError} when download or flash FAILs (reason included)
   */
  async flash(partition, bytes = null, { onProgress = null, chunkSize = 0, onInfo = null } = {}) {
    const report = onInfo ?? this.onInfo ?? null;
    let downloaded = 0;
    if (bytes !== null && bytes !== undefined) {
      downloaded = await this.download(bytes, { onProgress, chunkSize, onInfo: report });
    }
    const command = `flash:${partition}`;
    const res = await this._expectOkay(command);
    const lines = this._lines(res);
    if (report) for (const line of lines) report(line);
    return { bytes: downloaded, info: lines };
  }

  /**
   * Erase a partition: `erase:<partition>`.
   * @param {string} partition
   * @returns {Promise<string[]>} INFO progress lines reported by the bootloader
   */
  async erase(partition) {
    const res = await this._expectOkay(`erase:${partition}`);
    const lines = this._lines(res);
    if (this.onInfo) for (const line of lines) this.onInfo(line);
    return lines;
  }

  /**
   * Reboot the device. The bootloader usually resets before it can answer, so
   * silence is tolerated.
   * @param {string|null} [target] e.g. "bootloader" -> `reboot-bootloader`
   * @returns {Promise<boolean>} true when the device acknowledged
   */
  async reboot(target = null) {
    const command = target ? `reboot-${target}` : 'reboot';
    const res = await this._expectOkay(command, { allowNoReply: true });
    return !res.noReply;
  }

  /**
   * Leave fastboot and let the device continue booting (`continue`).
   * @returns {Promise<boolean>} true when the device acknowledged
   */
  async continue() {
    const res = await this._expectOkay('continue', { allowNoReply: true });
    return !res.noReply;
  }

  /**
   * Run a vendor command: `oem <cmd>`.
   * @param {string} cmd e.g. "unlock", "device-info"
   * @returns {Promise<string>} the INFO text the bootloader returned
   * @throws {FastbootFailError} when the bootloader refuses (reason included)
   */
  async oemCommand(cmd) {
    const command = `oem ${cmd}`;
    const res = await this._expectOkay(command);
    return this._lines(res).join('\n');
  }

  /**
   * Power the device down / off the USB bus.
   *
   * The plain `power` command is used by default; bootloaders that implement a
   * different spelling can be driven with `power('powerdown')` or
   * `oemCommand('poweroff')`. Silence is tolerated because the device may cut
   * the link first.
   * @param {string} [command]
   * @returns {Promise<boolean>} true when the device acknowledged
   */
  async power(command = 'power') {
    const res = await this._expectOkay(command, { allowNoReply: true });
    return !res.noReply;
  }
}

/**
 * Human readable message for an unknown thrown value.
 * @param {unknown} cause
 * @returns {string}
 */
function messageOf(cause) {
  if (!cause) return 'unknown error';
  if (typeof cause === 'string') return cause;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Create a client bound to a transport.
 * @param {Transport} transport
 * @param {ConstructorParameters<typeof FastbootClient>[1]} [options]
 * @returns {FastbootClient}
 */
export function createFastbootClient(transport, options) {
  return new FastbootClient(transport, options);
}
