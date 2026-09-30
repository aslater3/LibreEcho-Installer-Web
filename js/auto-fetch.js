// No direct GitHub byte fallback: release assets require a readable mirror.
import { assetPrefix, parseSums, sha256OfBlob, DEFAULT_REPOSITORY } from './release.js';
import { requiredBundleMembers } from './profiles.js';

export async function discoverMirror({ mirrorBase = '', origin = '', fetcher = globalThis.fetch } = {}) {
  if (mirrorBase) return { mirrorBase, amonetMirrorBase: '' };
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname)) return null;
    const response = await fetcher(`${origin}/mirror/health`, { mode: 'same-origin', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const health = response.ok && await response.json();
    if (health?.repository !== DEFAULT_REPOSITORY || health.mirror !== true) return null;
    return { mirrorBase: `${origin}/mirror`, amonetMirrorBase: health.amonet === true ? `${origin}/amonet` : '' };
  } catch { return null; } // Ordinary static server => manual selection remains available.
}

/** Each session owns only its own OPFS directory; File is already an ADB Blob source.
 * Storage failure is not silently retried in RAM. When OPFS is unavailable,
 * Response.blob() uses the browser's Blob backing store, not a JS chunk array.
 */
export async function createBundleStore(storage = globalThis.navigator?.storage) {
  let root, dir, id;
  if (storage?.getDirectory) {
    root = await storage.getDirectory();
    id = `libreecho-download-${crypto.randomUUID()}`;
    dir = await root.getDirectoryHandle(id, { create: true });
  }
  return {
    async receive(response, name, { signal, onProgress, expectedSize } = {}) {
      let received = 0;
      const count = chunk => {
        received += chunk.byteLength;
        if (received > expectedSize) throw new Error(`${name}: download exceeds API size`);
        onProgress?.(name, received, expectedSize);
      };
      const handle = dir && await dir.getFileHandle(name, { create: true });
      const writer = handle && await handle.createWritable();
      const progress = new TransformStream({ transform(chunk, controller) { signal?.throwIfAborted(); count(chunk); controller.enqueue(chunk); } });
      let file;
      try {
        signal?.throwIfAborted();
        if (!response.body) throw new Error(`${name}: missing response body`);
        const stream = response.body.pipeThrough(progress);
        if (writer) { await stream.pipeTo(writer, { signal }); file = await handle.getFile(); }
        else { file = await new Response(stream).blob(); Object.defineProperty(file, 'name', { value: name }); }
        signal?.throwIfAborted();
        if (file.size !== expectedSize) throw new Error(`${name}: download size differs from API`);
        return file;
      } catch (error) {
        if (writer) { try { await writer.abort(); } catch { /* pipeTo may already have aborted it */ } }
        throw error;
      }
    },
    async dispose() { if (root && id) { await root.removeEntry(id, { recursive: true }); id = null; } },
  };
}

export async function downloadVerifiedAsset(release, name, { mirrorBase, fetcher = globalThis.fetch, signal, onProgress, store, expected } = {}) {
  signal?.throwIfAborted();
  if (!mirrorBase) throw new Error('no readable mirror: select bundle files manually');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) throw new Error('invalid asset name');
  const asset = release.assets.find(a => a.name === name);
  if (!asset) throw new Error(`${name}: missing release asset`);
  if (!/^sha256:[0-9a-f]{64}$/.test(asset.digest ?? '') || !Number.isSafeInteger(asset.size) || asset.size < 0) throw new Error(`${name}: missing API digest or size`);
  if (expected && asset.digest !== `sha256:${expected}`) throw new Error(`${name}: API digest differs from checksum inventory`);
  const response = await fetcher(`${mirrorBase}/${encodeURIComponent(release.tag)}/${encodeURIComponent(name)}`, { mode: 'cors', cache: 'no-store', signal });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const file = await store.receive(response, name, { signal, onProgress, expectedSize: asset.size });
  const actual = await sha256OfBlob(file, f => onProgress?.(name, file.size, file.size, f));
  signal?.throwIfAborted();
  if (actual !== asset.digest.slice(7) || (expected && actual !== expected)) throw new Error(`${name}: digest mismatch against API/checksum inventory`);
  return file;
}

export async function fetchReleaseBundle(release, options = {}) {
  const store = options.store ?? await createBundleStore();
  try {
    const prefix = assetPrefix(release.tag);
    const files = [];
    const inventories = [];
    for (const name of [`${prefix}-SHA256SUMS`, `${prefix}-TWRPINSTALL-SHA256SUMS`]) {
      const file = await downloadVerifiedAsset(release, name, { ...options, store });
      files.push(file); inventories.push(parseSums(await file.text()));
    }
    const [normal, twrp] = inventories;
    for (const name of requiredBundleMembers(release.tag).filter(n => !n.endsWith('SHA256SUMS'))) {
      const correct = ['libreecho-install.zip', 'bundle.manifest'].includes(name) ? twrp : normal;
      if (!correct.has(name)) throw new Error(`${name}: missing from correct checksum inventory`);
    }
    const sums = new Map(normal);
    for (const [name, hash] of twrp) {
      if (sums.has(name) && sums.get(name) !== hash) throw new Error(`${name}: conflicting checksum inventories`);
      sums.set(name, hash);
    }
    // Refuse malformed/missing metadata before starting the large downloads.
    for (const [name, hash] of sums) {
      const asset = release.assets.find(a => a.name === name);
      if (!asset) throw new Error(`${name}: missing release asset`);
      if (asset.digest !== `sha256:${hash}`) throw new Error(`${name}: API digest differs from checksum inventory`);
    }
    for (const [name, expected] of sums) {
      const existing = files.find(f => f.name === name);
      if (existing) { if (await sha256OfBlob(existing) !== expected) throw new Error(`${name}: checksum digest mismatch`); }
      else files.push(await downloadVerifiedAsset(release, name, { ...options, store, expected }));
    }
    return { files, sums, store, dispose: () => store.dispose() };
  } catch (error) { await store.dispose(); throw error; }
}

