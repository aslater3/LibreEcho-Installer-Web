// Signed-manifest precheck (WebCrypto Ed25519).
//
// Boundary: this is a HOST-SIDE PRECHECK only. It binds the release's signed OTA
// manifest to the published raw ed25519 public key before any device mutation,
// so a bundle whose signature does not verify is refused on the computer. It
// does NOT replace the authoritative adoption: the booted OS updater still
// verifies the staged transaction with its trusted key. It is deliberately
// fail-closed: if WebCrypto Ed25519 is unavailable the precheck refuses rather
// than silently passing.

const HEX_SIGNATURE = /^[0-9a-f]{128}$/i;
const HEX_PUBLIC_KEY = /^[0-9a-f]{64}$/i;

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function asBytes(message) {
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  return null;
}

/**
 * Verifies a raw ed25519 signature over `message` with the pinned published
 * key. Returns true; throws (never silently passes) on a malformed input, a
 * mismatch, or unavailable WebCrypto Ed25519.
 */
export async function verifyEd25519Signature({ message, signatureHex, publicKeyHex, subtle = globalThis.crypto?.subtle } = {}) {
  if (typeof signatureHex !== "string" || !HEX_SIGNATURE.test(signatureHex.trim())) {
    throw new Error("signed manifest: signature must be 64 hex-encoded bytes");
  }
  if (typeof publicKeyHex !== "string" || !HEX_PUBLIC_KEY.test(publicKeyHex.trim())) {
    throw new Error("signed manifest: public key must be 32 hex-encoded bytes");
  }
  const bytes = asBytes(message);
  if (!bytes) throw new Error("signed manifest: message bytes are required");
  if (!subtle || typeof subtle.importKey !== "function" || typeof subtle.verify !== "function") {
    throw new Error("signed manifest: WebCrypto Ed25519 verification is unavailable; refusing (precheck only, never a silent pass)");
  }
  let key;
  try {
    key = await subtle.importKey("raw", hexToBytes(publicKeyHex.trim()), { name: "Ed25519" }, false, ["verify"]);
  } catch (error) {
    throw new Error(`signed manifest: WebCrypto Ed25519 is unavailable (${error.message})`);
  }
  const ok = await subtle.verify({ name: "Ed25519" }, key, hexToBytes(signatureHex.trim()), bytes);
  if (!ok) throw new Error("signed manifest: Ed25519 signature does not verify against the pinned published key");
  return true;
}
