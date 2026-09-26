// Device profiles for the browser installer.
//
// Everything here is a *declaration* read from public project research:
//   * product strings are baked into the LK image, so `fastboot getvar product`
//     reports the bootloader's identity, not the silicon's;
//   * the unlock payload is selected by the device's own LK build description;
//   * the userdata sizes are the values the LibreEcho image contract accepts.
//
// Nothing in this file claims a device is compatible: the installer reads the
// device and compares it with what is declared here, and stops on a mismatch.

export const SUPPORTED_RELEASES = {
  // Asset layout is shared by every radar-puffin release; the tag is the identity.
  tagPattern: /^radar-puffin-(v\d+\.\d+\.\d+)$/,
};

export const PROFILES = [
  {
    id: "radar",
    product: "RADAR",
    marketing: "Amazon Echo 2nd Generation (2017)",
    board: "radar_puffin",
    soc: "MediaTek MT8163V",
    libreEcho: "reference platform",
    // fastbrick payloads are shipped inside the community unlock archive, not in
    // any repository, so the browser never downloads them on its own: the
    // operator supplies the payload file and the installer verifies the hash.
    lkBuildMap: {
      "59779ca-20220524_183401": { payload: "fastbrick-20220524.img", size: 114509028, sha256: "cc78ba7e497b7049361da4e3a85a69ee33e0e6cc5eef89e2752bc8c024f63ffb" },
      "63cb91b-20221007_072309": { payload: "fastbrick.img", size: 114294816, sha256: "d4001739e752149b0e07ed6c2ffa6fc7ff4cbd08e63e7b6d7251d9bce4d4c494", note: "documented BROM-fallback build" },
    },
    userdataContractSectors: [2137088, 2153472],
  },
  {
    id: "biscuit",
    product: "BISCUIT",
    marketing: "Amazon Echo Dot 2nd Generation (2016)",
    board: "biscuit",
    soc: "MediaTek MT8163V",
    libreEcho: "Radar image runs experimentally; no qualified Biscuit one-shot image",
    lkBuildMap: {
      "63cb91b-20221007_072309": { payload: "fastbrick-20221007.img", size: 114349580, sha256: "1100a16f152d713a3c9794f5954c657075db7a602e42f53b6775d4a7f31a4395" },
    },
    userdataContractSectors: [2137088, 2153472],
  },
];

export function profileForProduct(product) {
  if (!product) return null;
  const normalised = String(product).trim().toUpperCase();
  return PROFILES.find((profile) => profile.product === normalised) ?? null;
}

export function payloadForProfile(profile, lkBuildDesc) {
  if (!profile || !lkBuildDesc) return null;
  const build = String(lkBuildDesc).trim();
  const exact = Object.hasOwn(profile.lkBuildMap, build) ? profile.lkBuildMap[build] : null;
  return exact ? { ...exact, build, matched: "exact" } : null;
}

/** Recognises the fastbrick payload from a filename the operator supplied. */
export function payloadNameCandidates(profile) {
  if (!profile) return [];
  return [...new Set(Object.values(profile.lkBuildMap).map((entry) => entry.payload))];
}

/**
 * The bundle files a recovery install needs. Names come from the release
 * inventory; a bundle directory the operator downloaded satisfies this list.
 */
export function requiredBundleMembers(tag) {
  const prefix = `libreecho-${tag}`;
  const features = ["airplay2", "assistant", "stt", "tts", "wakeword"];
  const members = [
    `${prefix}-SHA256SUMS`,
    `${prefix}-boot.img`,
    `${prefix}-ota-public-key.hex`,
    `${prefix}-build.json`,
    `${prefix}-TWRPINSTALL-SHA256SUMS`,
    'libreecho-install.zip',
    'bundle.manifest',
  ];
  for (const feature of features) {
    members.push(`${prefix}-${feature}.squashfs`, `${prefix}-${feature}.manifest.json`);
  }
  return members;
}
