// Extract only three digest-pinned metadata members from verified tar Blobs.
import { sha256OfBlob } from "./release.js";
async function recoveryTarMembers(archive, wanted) {
  if (!archive) throw new Error('missing verified recovery metadata archive');
  const decode = bytes => new TextDecoder().decode(bytes).split('\0')[0];
  const octal = bytes => {
    const value = decode(bytes).trim();
    if (!/^[0-7]+$/.test(value)) throw new Error('invalid tar numeric field');
    return Number.parseInt(value, 8);
  };
  const result = new Map();
  let offset = 0;
  let headers = 0;
  while (offset + 512 <= archive.size) {
    if (++headers > 4096) throw new Error('recovery tar header limit exceeded');
    const header = new Uint8Array(await archive.slice(offset, offset + 512).arrayBuffer());
    if (header.every(byte => byte === 0)) break;
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== octal(header.subarray(148, 156))) throw new Error('recovery tar header checksum mismatch');
    const prefix = decode(header.subarray(345, 500));
    const name = (prefix ? `${prefix}/` : '') + decode(header.subarray(0, 100));
    const size = octal(header.subarray(124, 136));
    const start = offset + 512;
    const end = start + size;
    if (!Number.isSafeInteger(end) || end > archive.size) throw new Error('truncated recovery tar member');
    if (wanted.includes(name)) {
      if (result.has(name)) throw new Error(`duplicate recovery tar member: ${name}`);
      if (![0, 48].includes(header[156]) || size > 1048576) throw new Error(`invalid recovery metadata member: ${name}`);
      const blob = archive.slice(start, end);
      result.set(name, blob);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  for (const name of wanted) if (!result.has(name)) throw new Error(`missing recovery tar member: ${name}`);
  return result;
}

/**
 * The ZIP needs these alongside it; they are inside API-verified archives, not
 * standalone release assets. Bind each extracted byte to verified bundle.manifest.
 * This extraction never confers device/image qualification.
 *
 * `target` is either the legacy release tag (string) or
 * `{ prefix, manifestName }` for a combined release, where the normal asset
 * prefix and the recovery manifest name both differ from the legacy names.
 */
export async function extractRecoveryMetadata(verifiedFiles, target) {
  const options = typeof target === "string"
    ? { prefix: `libreecho-${target}`, manifestName: "bundle.manifest" }
    : { prefix: target?.prefix, manifestName: target?.manifestName ?? "bundle.manifest" };
  if (!options.prefix || !options.manifestName) throw new Error("missing target prefix or manifest name");
  const bundle = verifiedFiles.get(options.manifestName);
  if (!bundle) throw new Error(`missing verified ${options.manifestName}`);
  const text = await bundle.text();
  const expected = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(?:install_manifest|payload)=([^:]+):([0-9a-f]{64})$/.exec(line);
    if (match && ['manifest.json', 'manifest', 'manifest.sig'].includes(match[1])) {
      if (expected.has(match[1])) throw new Error(`duplicate recovery digest pin: ${match[1]}`);
      expected.set(match[1], match[2]);
    }
  }
  const files = new Map([
    ...await recoveryTarMembers(verifiedFiles.get(`${options.prefix}-initial-install.tar`), ['manifest.json']),
    ...await recoveryTarMembers(verifiedFiles.get(`${options.prefix}.ota.tar`), ['manifest', 'manifest.sig']),
  ]);
  for (const [name, blob] of files) {
    if (!expected.has(name)) throw new Error(`${name}: recovery digest pin missing`);
    if (await sha256OfBlob(blob) !== expected.get(name)) throw new Error(`${name}: derived digest mismatch`);
  }
  return { files, sums: expected };
}

