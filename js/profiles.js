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
    slug: "radar-puffin",
    soc: "MediaTek MT8163V",
    libreEcho: "reference platform",
    archive: { name: "amonet-radar-v1.0.0.zip", size: 58531162,
      sha256: "ecdb07bc05a508532e5ffed77121592d492b1a91572839e0f17545421f398f1a" },
    // Pinned community archives are fetched only from an operator-configured
    // CORS mirror or selected once as a ZIP. The browser extracts and checks the
    // exact build-specific member; it never guesses or trusts a filename alone.
    lkBuildMap: {
      "59779ca-20220524_183401": { payload: "fastbrick-20220524.img", size: 114509028, sha256: "cc78ba7e497b7049361da4e3a85a69ee33e0e6cc5eef89e2752bc8c024f63ffb" },
      "63cb91b-20221007_072309": { payload: "fastbrick.img", size: 114294816, sha256: "d4001739e752149b0e07ed6c2ffa6fc7ff4cbd08e63e7b6d7251d9bce4d4c494", note: "documented BROM-fallback build" },
      // Same member as 072309; declared here too, matching the host installer's
      // pins, so the two installers cannot disagree about this build.
      "63cb91b-20221007_073612": { payload: "fastbrick.img", size: 114294816, sha256: "d4001739e752149b0e07ed6c2ffa6fc7ff4cbd08e63e7b6d7251d9bce4d4c494" },
    },
    // The archive's default member, declared only for the operator-enabled
    // "allow untested LK build" path. It is the image the community host
    // scripts send when no build matches; nothing here claims it unlocks any
    // particular LK, and it is never selected unless the operator opts in.
    fallbackPayload: { payload: "fastbrick.img", size: 114294816,
      sha256: "d4001739e752149b0e07ed6c2ffa6fc7ff4cbd08e63e7b6d7251d9bce4d4c494" },
    userdataContractSectors: [2137088, 2153472],
  },
  {
    id: "biscuit",
    product: "BISCUIT",
    marketing: "Amazon Echo Dot 2nd Generation (2016)",
    board: "biscuit",
    slug: "biscuit",
    soc: "MediaTek MT8163V",
    libreEcho: "requires a Biscuit-targeted published build",
    archive: { name: "amonet-biscuit-v2.0.0.zip", size: 55989416,
      sha256: "98297293701082bc7272efe077f941c56fc7b6e1f27ef6f2e93b6e4c6fc7b62d" },
    lkBuildMap: {
      "63cb91b-20221007_072309": { payload: "fastbrick-20221007.img", size: 114349580, sha256: "1100a16f152d713a3c9794f5954c657075db7a602e42f53b6775d4a7f31a4395" },
    },
    // Same opt-in-only default as Radar; the Biscuit archive ships its own
    // fastbrick.img, so the digest differs from the Radar one.
    fallbackPayload: { payload: "fastbrick.img", size: 114294816,
      sha256: "51947565f2ca1a7fc7c0cd4aa888c3e1bbaadb1b135454a720fff36bbeb2ff9e" },
    userdataContractSectors: [2137088, 2153472],
  },
];

export function profileForProduct(product) {
  if (!product) return null;
  const normalised = String(product).trim().toUpperCase();
  return PROFILES.find((profile) => profile.product === normalised) ?? null;
}

/**
 * Resolves the unlock payload for a device's LK build description.
 *
 * Exact pins always win. `allowUnpinned` is the operator's explicit opt-in to
 * sending the archive's declared fallback payload to a build nobody has pinned
 * or tested: it is never implied, and it is reported as `matched: "fallback"`
 * so every caller can say so before a byte leaves the host.
 */
export function payloadForProfile(profile, lkBuildDesc, { allowUnpinned = false } = {}) {
  if (!profile || !lkBuildDesc) return null;
  const build = String(lkBuildDesc).trim();
  const exact = Object.hasOwn(profile.lkBuildMap, build) ? profile.lkBuildMap[build] : null;
  if (exact) return { ...exact, build, matched: "exact" };
  // The opt-in covers builds we can name but have not pinned. A description the
  // device did not report as a build at all ("unknown", empty, free text) is not
  // an unpinned build — there is nothing to recognise, so it stays refused.
  if (allowUnpinned && profile.fallbackPayload && isBuildDescription(build)) {
    return { ...profile.fallbackPayload, build, matched: "fallback" };
  }
  return null;
}

/**
 * True for an LK build description as the bootloader reports it, e.g.
 * `3c6be74-20210822_210647`. Deliberately shape-only: it says the device named
 * a build, never that the build is supported.
 */
export function isBuildDescription(value) {
  return /^[0-9a-f]{6,}-\d{8}_\d{6}$/i.test(String(value ?? "").trim());
}

/** Recognises the fastbrick payload from a filename the operator supplied. */
export function payloadNameCandidates(profile) {
  if (!profile) return [];
  const names = Object.values(profile.lkBuildMap).map((entry) => entry.payload);
  if (profile.fallbackPayload) names.push(profile.fallbackPayload.payload);
  return [...new Set(names)];
}

export const FEATURES = ["airplay2", "assistant", "stt", "tts", "wakeword"];

/**
 * The normal (non-recovery) files a release build publishes under `prefix`.
 * Shared by the legacy compatibility list and the combined-release target
 * resolution so the two can never drift apart.
 */
export function normalBundleMembers(prefix, { verification = true } = {}) {
  const members = [
    `${prefix}-boot.img`,
    `${prefix}-build.json`,
    `${prefix}-feature-assets.json`,
    `${prefix}-feature-plan.json`,
    `${prefix}-initial-install.tar`,
    `${prefix}-installer.py`,
    `${prefix}-ota-public-key.hex`,
    `${prefix}-release-notes.md`,
    `${prefix}-run-one-shot.sh`,
    `${prefix}.ota.tar`,
  ];
  // Product CI publishes the image-verification report only with development
  // builds; stable releases (radar-puffin-vX.Y.Z) never carry it, and the
  // Python installer accepts it only for dev/nightly tags.
  if (verification) members.push(`${prefix}-verification.txt`);
  for (const feature of FEATURES) {
    members.push(`${prefix}-${feature}.squashfs`, `${prefix}-${feature}.manifest.json`);
  }
  return members;
}

/** The recovery ZIP and manifest names for a target (legacy aliases vs slug names). */
export function recoveryBundleMembers({ legacy = false, slug = "radar-puffin" } = {}) {
  return legacy
    ? ["libreecho-install.zip", "bundle.manifest"]
    : [`libreecho-${slug}-install.zip`, `libreecho-${slug}-bundle.manifest`];
}

/**
 * The bundle files a legacy (Radar-only) recovery install needs. Names come
 * from the release inventory; a bundle directory the operator downloaded
 * satisfies this list. Kept for the legacy layout and its compatibility tests.
 */
export function requiredBundleMembers(tag) {
  const prefix = `libreecho-${tag}`;
  return [
    ...normalBundleMembers(prefix, { verification: !/^radar-puffin-v\d+\.\d+\.\d+$/.test(String(tag)) }),
    `${prefix}-SHA256SUMS`,
    `${prefix}-TWRPINSTALL-SHA256SUMS`,
    ...recoveryBundleMembers({ legacy: true }),
  ];
}
