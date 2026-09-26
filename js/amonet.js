import { sha256Blob, sha256Bytes } from './sha256.js';

// A bounded, single-member ZIP reader, not a general-purpose unzipper. Archive
// and payload pins are supplied by the caller, never inferred from ZIP metadata.
const MAX_ARCHIVE_SIZE = 512 * 1024 * 1024;
const MAX_MEMBER_SIZE = 256 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const digestPattern = /^[0-9a-f]{64}$/i;

function requirePath(path, allowDirectory = false) {
  if (typeof path !== 'string' || !path || path.startsWith('/') ||
      path.includes('\\') || path.includes('\0') || path.includes(':') ||
      (path.endsWith('/') && !allowDirectory) ||
      (allowDirectory && path.endsWith('/') ? path.slice(0, -1) : path)
        .split('/').some((part) => !part || part === '.' || part === '..' || /[\u0000-\u001f\u007f]/.test(part))) {
    throw new Error('Invalid ZIP member path');
  }
}

function requireRange(start, size, limit, label) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) ||
      start < 0 || size < 0 || start + size > limit) {
    throw new Error(`ZIP ${label} out of bounds`);
  }
}

function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function read(blob, start, size, limit, label) {
  requireRange(start, size, limit, label);
  const bytes = new Uint8Array(await blob.slice(start, start + size).arrayBuffer());
  if (bytes.length !== size) throw new Error(`ZIP ${label} truncated`);
  return bytes;
}

async function directory(blob) {
  // EOCD is at most 65,535 comment bytes from EOF; archives with trailing
  // bytes, split volumes or ZIP64 sentinels are intentionally unsupported.
  const start = Math.max(0, blob.size - (22 + 0xffff));
  const tail = await read(blob, start, blob.size - start, blob.size, 'EOCD');
  const tailView = view(tail);
  for (let pos = tail.length - 22; pos >= 0; pos -= 1) {
    if (tailView.getUint32(pos, true) !== 0x06054b50 ||
        pos + 22 + tailView.getUint16(pos + 20, true) !== tail.length) continue;
    const count = tailView.getUint16(pos + 10, true);
    const size = tailView.getUint32(pos + 12, true);
    const offset = tailView.getUint32(pos + 16, true);
    if (tailView.getUint16(pos + 4, true) !== 0 || tailView.getUint16(pos + 6, true) !== 0 ||
        tailView.getUint16(pos + 8, true) !== count) throw new Error('Split ZIP disk not supported');
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error('ZIP64 not supported');
    if (offset + size !== start + pos) throw new Error('ZIP central directory bounds mismatch');
    return { offset, size, count };
  }
  throw new Error('ZIP end-of-central-directory missing');
}

async function findMember(blob, memberPath) {
  const { offset, size, count } = await directory(blob);
  // Central metadata only. No other member's compressed contents are accessed
  // after whole-archive hashing (which is required by the archive trust pin).
  const bytes = await read(blob, offset, size, blob.size, 'central directory');
  const dv = view(bytes);
  let pos = 0;
  let chosen;
  const seen = new Set();
  for (let i = 0; i < count; i += 1) {
    requireRange(pos, 46, size, 'central header');
    if (dv.getUint32(pos, true) !== 0x02014b50) throw new Error('Invalid ZIP central header');
    const nameLength = dv.getUint16(pos + 28, true);
    const extraLength = dv.getUint16(pos + 30, true);
    const commentLength = dv.getUint16(pos + 32, true);
    const length = 46 + nameLength + extraLength + commentLength;
    requireRange(pos, length, size, 'central entry');
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength));
    requirePath(name, true);
    if (seen.has(name)) throw new Error('Duplicate ZIP member');
    seen.add(name);
    const uncompressedSize = dv.getUint32(pos + 24, true);
    const compressedSize = dv.getUint32(pos + 20, true);
    const localOffset = dv.getUint32(pos + 42, true);
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff)
      throw new Error('ZIP64 member not supported');
    if (uncompressedSize > MAX_MEMBER_SIZE || compressedSize > MAX_ARCHIVE_SIZE)
      throw new Error('Oversized ZIP member');
    if (name === memberPath) {
      chosen = {
        nameBytes: bytes.slice(pos + 46, pos + 46 + nameLength),
        method: dv.getUint16(pos + 10, true), flags: dv.getUint16(pos + 8, true),
        crc: dv.getUint32(pos + 16, true), compressedSize, uncompressedSize, localOffset,
      };
    }
    pos += length;
  }
  if (pos !== size) throw new Error('ZIP central directory size mismatch');
  if (!chosen) throw new Error('ZIP member missing');
  return { ...chosen, centralOffset: offset };
}

async function compressedMember(blob, entry) {
  const { localOffset, centralOffset, nameBytes, compressedSize, uncompressedSize, method, flags } = entry;
  if (method !== 0 && method !== 8) throw new Error('Unsupported ZIP compression method');
  if (flags & ~0x808) throw new Error('Unsupported ZIP flags or encryption');
  if (method === 0 && compressedSize !== uncompressedSize) throw new Error('Stored ZIP size mismatch');
  const header = await read(blob, localOffset, 30, centralOffset, 'local header');
  const dv = view(header);
  if (dv.getUint32(0, true) !== 0x04034b50) throw new Error('Invalid ZIP local header');
  if (dv.getUint16(6, true) !== flags || dv.getUint16(8, true) !== method)
    throw new Error('ZIP local header flags/method mismatch');
  if (!(flags & 8) || dv.getUint32(18, true) !== 0 || dv.getUint32(22, true) !== 0) {
    if (dv.getUint32(18, true) !== compressedSize || dv.getUint32(22, true) !== uncompressedSize)
      throw new Error('ZIP local header size mismatch');
  }
  if (!(flags & 8) && dv.getUint32(14, true) !== entry.crc)
    throw new Error('ZIP local header CRC mismatch');
  const nameLength = dv.getUint16(26, true);
  const dataStart = localOffset + 30 + nameLength + dv.getUint16(28, true);
  requireRange(localOffset, dataStart - localOffset + compressedSize, centralOffset, 'local member data');
  if (nameLength !== nameBytes.length) throw new Error('ZIP local member name mismatch');
  const localName = await read(blob, localOffset + 30, nameLength, centralOffset, 'local name');
  if (!localName.every((byte, index) => byte === nameBytes[index])) throw new Error('ZIP local member name mismatch');
  return blob.slice(dataStart, dataStart + compressedSize);
}

async function expand(blob, method, expectedSize) {
  if (method === 0) return new Uint8Array(await blob.arrayBuffer());
  if (typeof DecompressionStream !== 'function') throw new Error('Browser lacks deflate-raw DecompressionStream');
  const reader = blob.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const bytes = new Uint8Array(expectedSize);
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > expectedSize - length) throw new Error('ZIP payload exceeds expected size');
      bytes.set(value, length);
      length += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return bytes.subarray(0, length);
}

/**
 * Acquire exactly one pinned payload from a local File/Blob or an explicitly
 * supplied CORS HTTP(S) URL. Returns { bytes: Uint8Array, source: string }.
 * Does not select an archive, consult a default URL, or write to any device.
 */
export async function acquireAmonetPayload({
  archiveBlob, url, archiveSha256, archiveSize, memberPath, payloadSha256, payloadSize, fetchImpl = globalThis.fetch,
} = {}) {
  if (Boolean(archiveBlob) === Boolean(url)) throw new Error('Specify either a local archive or a URL source');
  if (!digestPattern.test(archiveSha256) || !digestPattern.test(payloadSha256))
    throw new Error('Valid archive and payload SHA-256 pins are required');
  requirePath(memberPath);
  if (!Number.isSafeInteger(payloadSize) || payloadSize < 0 || payloadSize > MAX_MEMBER_SIZE)
    throw new Error('Invalid or oversized payload size');
  if (archiveSize !== undefined && (!Number.isSafeInteger(archiveSize) || archiveSize <= 0 || archiveSize > MAX_ARCHIVE_SIZE))
    throw new Error('Invalid pinned archive size');
  let blob = archiveBlob;
  let source = 'local archive';
  if (url) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('URL must be HTTP(S)');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname)))
      throw new Error('Amonet archive mirror must use HTTPS (loopback HTTP is local-test only)');
    if (parsed.username || parsed.password || parsed.hash) throw new Error('Invalid archive mirror URL');
    if (typeof fetchImpl !== 'function') throw new Error('URL fetch unavailable');
    const response = await fetchImpl(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) throw new Error(`Archive fetch failed (HTTP ${response.status})`);
    const declared = response.headers?.get?.('content-length');
    if (declared !== null && declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) !== (archiveSize ?? Number(declared))))
      throw new Error('Archive Content-Length differs from pinned archive size');
    const limit = archiveSize ?? MAX_ARCHIVE_SIZE;
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const parts = [];
      let received = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > limit) throw new Error('Archive download exceeds pinned archive size');
          parts.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      blob = new Blob(parts);
    } else {
      blob = await response.blob();
    }
    source = url;
  }
  if (!(blob instanceof Blob)) throw new Error('Archive source must be a Blob or File');
  if (blob.size > MAX_ARCHIVE_SIZE || (archiveSize !== undefined && blob.size !== archiveSize))
    throw new Error('Archive size mismatch');
  if ((await sha256Blob(blob)).toLowerCase() !== archiveSha256.toLowerCase())
    throw new Error('Archive SHA-256 mismatch');
  const entry = await findMember(blob, memberPath);
  if (entry.uncompressedSize !== payloadSize) throw new Error('ZIP payload size mismatch');
  const compressed = await compressedMember(blob, entry);
  const bytes = await expand(compressed, entry.method, payloadSize);
  if (bytes.length !== payloadSize) throw new Error('ZIP payload size mismatch');
  if ((await sha256Bytes(bytes)).toLowerCase() !== payloadSha256.toLowerCase())
    throw new Error('Payload SHA-256 mismatch');
  return { bytes, source };
}
