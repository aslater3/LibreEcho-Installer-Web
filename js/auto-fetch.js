// Release bundle download for the browser installer.
//
// No direct GitHub byte fallback: release assets require a readable mirror
// (a configured CORS mirror, this site's own releases/<tag>/ directory, or the
// loopback development helper).
//
// The fetch is target-scoped. A combined release publishes one inventory per
// board, so the page downloads only the chosen board's checksum inventories and
// only the files they list. Every byte is verified against both the checksum
// inventory and the GitHub API digest/size before it can be staged; a foreign or
// unexpected name, a missing asset, a conflicting inventory or a digest mismatch
// all fail closed.
import { parseSums, sha256OfBlob, DEFAULT_REPOSITORY } from './release.js';
import {
  targetsForRelease,
  inventoryNamesForTarget,
  requiredMembersForTarget,
  nameBelongsToTarget,
  targetsAssetName,
} from './targets.js';

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
 * Response.blob() uses the browser's Blob backing store (disk-spooled), not a JS
 * chunk array; nothing here ever materialises a whole asset in a JS array.
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

/**
 * Downloads and verifies the combined-release descriptor if the release
 * publishes one, and returns its text (or null for a legacy release). The
 * descriptor is checked against the API digest/size like any other asset.
 */
export async function fetchTargetsJson(release, { mirrorBase, fetcher = globalThis.fetch, signal, store, onEvent } = {}) {
  const name = targetsAssetName(release.tag);
  if (!release.assets.some(a => a.name === name)) return null;
  const ownStore = !store;
  const activeStore = store ?? await createBundleStore();
  try {
    const file = await downloadVerifiedAsset(release, name, { mirrorBase, fetcher, signal, store: activeStore,
      onProgress: (n, received, total) => onEvent?.({ phase: 'preparing', name: n, fileBytes: received, fileTotal: total }) });
    return file.text();
  } finally {
    if (ownStore) await activeStore.dispose();
  }
}

/**
 * Fetches and verifies one target's bundle.
 *
 * @param {object} release     release from fetchReleaseIndex (assets carry API digest+size)
 * @param {object} options
 *   board        board whose assets to fetch (radar_puffin | biscuit)
 *   targetsJson  verified targets.json text, or null for a legacy release
 *   mirrorBase   readable mirror base
 *   onEvent      progress events: { phase, name, index, count, fileBytes, fileTotal, done, total }
 */
export async function fetchReleaseBundle(release, options = {}) {
  const { board = 'radar_puffin', targetsJson = null, onEvent, onProgress } = options;
  const store = options.store ?? await createBundleStore();
  let allocated = 0, done = 0, index = 0, count = 0;
  const emit = (phase, name, fileBytes, fileTotal) => onEvent?.({
    phase, name, index, count, fileBytes, fileTotal, done, total: allocated,
  });
  const trackDownload = (name, size) => {
    index += 1;
    const base = done;
    emit('downloading', name, 0, size);
    return (n, received, fileTotal, hashing) => {
      if (hashing === undefined) {
        done = base + Math.min(received, size);
        emit('downloading', n, received, size);
        onProgress?.(n, received, size);
      } else {
        emit('verifying', n, size, size);
        onProgress?.(n, size, size, hashing);
      }
    };
  };
  try {
    if (new Set(release.assets.map(a => a.name)).size !== release.assets.length) throw new Error('duplicate API asset name');
    const targets = targetsForRelease({ tag: release.tag, targetsJson });
    const target = targets.find(entry => entry.board === board);
    if (!target) throw new Error(`this release does not offer a build for ${board}`);

    const { normal: normalInventory, recovery: recoveryInventories } = inventoryNamesForTarget({ tag: release.tag, target });
    const files = [];
    const inventoryText = new Map();

    const inventoryNames = [normalInventory, ...recoveryInventories];
    for (const name of inventoryNames) {
      const file = await downloadVerifiedAsset(release, name, { ...options, store,
        onProgress: (n, received, total) => emit('preparing', n, received, total) });
      files.push(file);
      inventoryText.set(name, parseSums(await file.text()));
    }
    const normal = inventoryText.get(normalInventory);
    const recovery = new Map();
    for (const name of recoveryInventories) {
      for (const [entry, hash] of inventoryText.get(name)) {
        if (recovery.has(entry) && recovery.get(entry) !== hash) throw new Error(`${entry}: conflicting recovery checksum inventories`);
        recovery.set(entry, hash);
      }
    }

    // Every required member must be listed by the inventory that owns it.
    const required = requiredMembersForTarget(target);
    for (const name of required.normal) {
      if (!normal.has(name)) throw new Error(`${name}: missing from the normal checksum inventory`);
    }
    for (const name of required.recovery) {
      if (!recovery.has(name)) throw new Error(`${name}: missing from the recovery checksum inventory`);
    }

    const sums = new Map(normal);
    for (const [name, hash] of recovery) {
      if (sums.has(name) && sums.get(name) !== hash) throw new Error(`${name}: conflicting checksum inventories`);
      sums.set(name, hash);
    }

    // Never fetch another board's files, even if an inventory somehow lists them.
    const foreign = targets.filter(entry => entry.board !== target.board);
    for (const name of sums.keys()) {
      if (foreign.some(entry => !nameBelongsToTarget(name, target)
        && (name.startsWith(`${entry.prefix}-`) || name.startsWith(`${entry.prefix}.`) || name.startsWith(`libreecho-${entry.slug}-`)))) {
        throw new Error(`${name}: this release lists another target's asset in the ${target.board} inventory`);
      }
    }

    // Refuse malformed/missing metadata before starting the large downloads.
    for (const [name, hash] of sums) {
      const asset = release.assets.find(a => a.name === name);
      if (!asset) throw new Error(`${name}: missing release asset`);
      if (!Number.isSafeInteger(asset.size) || asset.size < 0) throw new Error(`${name}: invalid API size`);
      if (asset.digest !== `sha256:${hash}`) throw new Error(`${name}: API digest differs from checksum inventory`);
    }

    // Inventories are a preparation phase. Freeze the entire union before any
    // payload starts, counting the already verified inventory bytes once.
    const plan = new Set([...inventoryNames, ...sums.keys()]);
    allocated = [...plan].reduce((total, name) => total + release.assets.find(a => a.name === name).size, 0);
    if (!Number.isSafeInteger(allocated)) throw new Error('download plan size exceeds safe integer range');
    count = plan.size; index = files.length; done = files.reduce((total, file) => total + file.size, 0);
    for (const [name, expected] of sums) {
      const existing = files.find(f => f.name === name);
      if (existing) { if (await sha256OfBlob(existing) !== expected) throw new Error(`${name}: checksum digest mismatch`); }
      else files.push(await downloadVerifiedAsset(release, name, { ...options, store, expected,
        onProgress: trackDownload(name, release.assets.find(a => a.name === name)?.size ?? 0) }));
    }
    emit('complete', null, allocated, allocated);
    return { files, sums, target, targets, store, totalBytes: allocated, fileCount: count, dispose: () => store.dispose() };
  } catch (error) {
    await store.dispose();
    throw error;
  }
}
