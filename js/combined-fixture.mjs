// Synthetic combined-release fixture with the REAL asset names from a verified
// build (tag radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d).
//
// Only the bytes are synthetic (small); the names, the targets.json descriptor,
// the two inventories per board and the recovery names match a real combined
// release so the fetch/verify path is exercised without ~718 MB of downloads.
//
// `protocol2: true` additionally produces the direct-userdata v2 shape: a real
// (stored, single-member) installer ZIP carrying `libreecho-direct-install.sh`,
// a signed OTA manifest with a real Ed25519 signature, the published raw
// ed25519 public key, and the `protocol=2` / `transfer=` / `staging=` lines with
// digests and `transfer_bytes_total` that match the exact transfer set. The
// default (protocol2: false) shape is byte-for-byte the legacy fixture, so
// existing tests are unaffected.
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { normalBundleMembers, recoveryBundleMembers, FEATURES } from './profiles.js';
import { targetsAssetName } from './targets.js';
import { tar, zipBuffer } from './bundle-fixture.mjs';

export const hashBytes = value => createHash('sha256').update(value).digest('hex');

export const REAL_TAG = 'radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d';

/** The exact member name the browser extracts from the verified installer ZIP. */
export const DIRECT_HELPER_MEMBER = 'libreecho-direct-install.sh';
/** A tiny, deterministic shell helper for browser tests (never executed). */
export const DIRECT_HELPER_BYTES = '#!/sbin/sh\n# synthetic direct-userdata v2 recovery helper (browser tests only)\necho libreecho-direct\n';

export const REAL_INVENTORY = {
  radar_puffin: {
    normal: `libreecho-${REAL_TAG}-SHA256SUMS`,
    recovery: `libreecho-${REAL_TAG}-radar-puffin-TWRPINSTALL-SHA256SUMS`,
  },
  biscuit: {
    normal: 'libreecho-biscuit-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d-SHA256SUMS',
    recovery: `libreecho-${REAL_TAG}-biscuit-TWRPINSTALL-SHA256SUMS`,
  },
};

export function combinedFixture({ tag = REAL_TAG, radarAccepted = true, biscuitAccepted = true, protocol2 = false } = {}) {
  const ids = tag.replace(/^radar-puffin-build-/, '');
  const radarPrefix = `libreecho-${tag}`;
  const biscuitPrefix = `libreecho-biscuit-build-${ids}`;

  let metadata;
  let publicKeyHex = null;
  if (protocol2) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    publicKeyHex = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('hex');
    const signedManifest = [
      'format=libreecho-ota-v2',
      'manifest_version=1',
      'board=radar_puffin',
      'soc=mt8163',
      'architecture=armv7',
      'image_profile=ota',
      `feature_ids=${FEATURES.join(',')}`,
      ...FEATURES.map((feature) => `feature_${feature}_action=${feature === 'wakeword' || feature === 'assistant' ? 'replace' : 'preserve'}`),
      'boot_filename=boot.img',
    ].join('\n');
    const manifestBytes = Buffer.from(signedManifest);
    const signatureHex = edSign(null, manifestBytes, privateKey).toString('hex');
    metadata = new Map([['manifest.json', '{}'], ['manifest', manifestBytes], ['manifest.sig', signatureHex]]);
  } else {
    metadata = new Map([['manifest.json', '{}'], ['manifest', 'signed bytes'], ['manifest.sig', 'signature bytes']]);
  }

  const bytes = new Map();
  const normalNames = { radar_puffin: [], biscuit: [] };
  const recoveryNames = { radar_puffin: [], biscuit: [] };

  const valueOf = (name) => (bytes.has(name) ? bytes.get(name) : metadata.get(name));
  const shaOf = (name) => hashBytes(valueOf(name));
  const sizeOf = (name) => Buffer.byteLength(valueOf(name));

  const legacyManifestText = (slug, board, product) => [
    'schema=1', `release=${tag}`, `device=${board}`, `target=${board}`,
    `fastboot_products=${product}`, 'soc=mt8163', 'image_profile=ota',
    'service_profile=production', 'userdata_sectors=2153472',
    `install_manifest=manifest.json:${hashBytes(metadata.get('manifest.json'))}`,
    `payload=manifest:${hashBytes(metadata.get('manifest'))}`,
    `payload=manifest.sig:${hashBytes(metadata.get('manifest.sig'))}`,
    `staging=airplay2:libreecho-${slug}-base-airplay2-${'1'.repeat(64)}.payload.squashfs:${'1'.repeat(64)}:libreecho-${slug}-base-airplay2-${'2'.repeat(64)}.manifest.json:${'2'.repeat(64)}`,
    `local_package=libreecho-${slug}-build-${ids}.ota.tar:${'3'.repeat(64)}`,
  ].join('\n');

  const directManifestText = (prefix, board, product) => {
    const boot = `${prefix}-boot.img`;
    const ota = `${prefix}.ota.tar`;
    const features = FEATURES.map((feature) => ({ feature, payload: `${prefix}-${feature}.squashfs`, manifest: `${prefix}-${feature}.manifest.json` }));
    const total = [boot, 'manifest', 'manifest.sig', ota, ...features.flatMap((f) => [f.payload, f.manifest])]
      .reduce((sum, name) => sum + sizeOf(name), 0);
    return [
      'schema=1', 'protocol=2', `release=${tag}`, `device=${board}`, `target=${board}`,
      `fastboot_products=${product}`, 'soc=mt8163', 'image_profile=ota',
      'service_profile=production', 'userdata_sectors=2153472',
      `transfer_bytes_total=${total}`,
      `install_manifest=manifest.json:${shaOf('manifest.json')}`,
      `boot_image=${boot}`, `boot_image_sha256=${shaOf(boot)}`,
      `payload=${boot}:${shaOf(boot)}`,
      `payload=manifest:${shaOf('manifest')}`,
      `payload=manifest.sig:${shaOf('manifest.sig')}`,
      `transfer=boot:${boot}:${shaOf(boot)}`,
      `transfer=ota-manifest:manifest:${shaOf('manifest')}`,
      `transfer=ota-signature:manifest.sig:${shaOf('manifest.sig')}`,
      `transfer=local-package:${ota}:${shaOf(ota)}`,
      ...features.map((f) => `staging=${f.feature}:${f.payload}:${shaOf(f.payload)}:${f.manifest}:${shaOf(f.manifest)}`),
      `local_package=${ota}:${shaOf(ota)}`,
    ].join('\n');
  };

  const addTarget = (board, prefix, slug, product, accepted) => {
    const addNormal = (name, value) => { bytes.set(name, value); if (!normalNames[board].includes(name)) normalNames[board].push(name); };
    for (const name of normalBundleMembers(prefix)) {
      addNormal(name, name.endsWith('-build.json')
        ? JSON.stringify({ board, hardware_accepted: accepted, target_descriptor_sha256: 'a'.repeat(64) })
        : `bytes ${name}`);
    }
    addNormal(`${prefix}-initial-install.tar`, tar([['manifest.json', metadata.get('manifest.json')]]));
    addNormal(`${prefix}.ota.tar`, tar([['manifest', metadata.get('manifest')], ['manifest.sig', metadata.get('manifest.sig')]]));
    for (const feature of FEATURES) {
      const h = hashBytes(`${slug}-${feature}-base`);
      addNormal(`libreecho-${slug}-base-${feature}-${h}.payload.squashfs`, `base ${feature}`);
      addNormal(`libreecho-${slug}-base-${feature}-${h}.manifest.json`, `basem ${feature}`);
    }
    addNormal(`libreecho-${slug}-release-completeness.json`, JSON.stringify({ board }));
    if (board === 'radar_puffin') {
      for (const feature of ['assistant', 'wakeword']) {
        addNormal(`libreecho-radar-puffin-0.14.0-${feature}.payload.squashfs`, `0.14.0 ${feature}`);
        addNormal(`libreecho-radar-puffin-0.14.0-${feature}.manifest.json`, `0.14.0m ${feature}`);
      }
    }
    if (protocol2) {
      // The published raw ed25519 key overrides the placeholder from the member list.
      bytes.set(`${prefix}-ota-public-key.hex`, publicKeyHex);
    }
    const installZip = `libreecho-${slug}-install.zip`;
    const manifestName = `libreecho-${slug}-bundle.manifest`;
    if (protocol2) {
      bytes.set(installZip, zipBuffer([{ name: DIRECT_HELPER_MEMBER, data: DIRECT_HELPER_BYTES }]));
      bytes.set(manifestName, directManifestText(prefix, board, product));
    } else {
      bytes.set(installZip, `zip ${slug}`);
      bytes.set(manifestName, legacyManifestText(slug, board, product));
    }
    recoveryNames[board].push(installZip);
    recoveryNames[board].push(manifestName);
    if (board === 'radar_puffin') {
      // Radar keeps byte-for-byte legacy aliases of its own recovery ZIP/manifest.
      bytes.set('libreecho-install.zip', bytes.get(installZip)); recoveryNames[board].push('libreecho-install.zip');
      bytes.set('bundle.manifest', bytes.get(manifestName)); recoveryNames[board].push('bundle.manifest');
    }
  };

  addTarget('radar_puffin', radarPrefix, 'radar-puffin', 'RADAR', radarAccepted);
  addTarget('biscuit', biscuitPrefix, 'biscuit', 'BISCUIT', biscuitAccepted);

  for (const board of ['radar_puffin', 'biscuit']) {
    bytes.set(REAL_INVENTORY[board].normal, normalNames[board].map(n => `${hashBytes(bytes.get(n))}  ${n}`).join('\n'));
    bytes.set(REAL_INVENTORY[board].recovery, recoveryNames[board].map(n => `${hashBytes(bytes.get(n))}  ${n}`).join('\n'));
  }

  const targetsJson = JSON.stringify({
    schema: 'libreecho-combined-release-v1',
    release: tag,
    targets: [
      { board: 'radar_puffin', prefix: radarPrefix, target_descriptor_sha256: 'a'.repeat(64) },
      { board: 'biscuit', prefix: biscuitPrefix, target_descriptor_sha256: 'b'.repeat(64) },
    ],
  });
  bytes.set(targetsAssetName(tag), targetsJson);

  const assets = [...bytes].map(([name, value]) => ({ name, size: Buffer.byteLength(value), digest: `sha256:${hashBytes(value)}` }));
  const files = [...bytes].map(([name, value]) => { const blob = new Blob([value]); blob.name = name; return blob; });
  return { tag, bytes, assets, files, targetsJson, radarPrefix, biscuitPrefix, normalNames, recoveryNames, protocol2, publicKeyHex, metadata };
}

/** Convenience wrapper: the combined fixture in its direct-userdata v2 shape. */
export function directFixture(options = {}) {
  return combinedFixture({ protocol2: true, ...options });
}
