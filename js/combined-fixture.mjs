// Synthetic combined-release fixture with the REAL asset names from a verified
// build (tag radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d).
//
// Only the bytes are synthetic (small); the names, the targets.json descriptor,
// the two inventories per board and the recovery names match a real combined
// release so the fetch/verify path is exercised without ~718 MB of downloads.
import { createHash } from 'node:crypto';
import { normalBundleMembers, recoveryBundleMembers, FEATURES } from './profiles.js';
import { targetsAssetName } from './targets.js';
import { tar } from './bundle-fixture.mjs';

export const hashBytes = value => createHash('sha256').update(value).digest('hex');

export const REAL_TAG = 'radar-puffin-build-8de9f9d-fa9c63a7c9141865-34617fcfdeda992d';

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

export function combinedFixture({ tag = REAL_TAG, radarAccepted = true, biscuitAccepted = true } = {}) {
  const ids = tag.replace(/^radar-puffin-build-/, '');
  const radarPrefix = `libreecho-${tag}`;
  const biscuitPrefix = `libreecho-biscuit-build-${ids}`;
  const metadata = new Map([['manifest.json', '{}'], ['manifest', 'signed bytes'], ['manifest.sig', 'signature bytes']]);
  const bytes = new Map();
  const normalNames = { radar_puffin: [], biscuit: [] };
  const recoveryNames = { radar_puffin: [], biscuit: [] };

  const manifestText = (slug, board, product) => [
    'schema=1', `release=${tag}`, `device=${board}`, `target=${board}`,
    `fastboot_products=${product}`, 'soc=mt8163', 'image_profile=ota',
    'service_profile=production', 'userdata_sectors=2153472',
    `install_manifest=manifest.json:${hashBytes(metadata.get('manifest.json'))}`,
    `payload=manifest:${hashBytes(metadata.get('manifest'))}`,
    `payload=manifest.sig:${hashBytes(metadata.get('manifest.sig'))}`,
    `staging=airplay2:libreecho-${slug}-base-airplay2-${'1'.repeat(64)}.payload.squashfs:${'1'.repeat(64)}:libreecho-${slug}-base-airplay2-${'2'.repeat(64)}.manifest.json:${'2'.repeat(64)}`,
    `local_package=libreecho-${slug}-build-${ids}.ota.tar:${'3'.repeat(64)}`,
  ].join('\n');

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
    const installZip = `libreecho-${slug}-install.zip`;
    const manifestName = `libreecho-${slug}-bundle.manifest`;
    bytes.set(installZip, `zip ${slug}`); recoveryNames[board].push(installZip);
    bytes.set(manifestName, manifestText(slug, board, product)); recoveryNames[board].push(manifestName);
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
  return { tag, bytes, assets, files, targetsJson, radarPrefix, biscuitPrefix, normalNames, recoveryNames };
}
