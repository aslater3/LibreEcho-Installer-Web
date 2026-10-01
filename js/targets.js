// Board/target discovery for LibreEcho releases.
//
// A release is either:
//   * combined  — it publishes `libreecho-<TAG>-targets.json` (schema
//     libreecho-combined-release-v1) that names one prefix per board. Every
//     board has its own checksum inventories and its own recovery ZIP, so the
//     page must fetch only the chosen board's files; and
//   * legacy    — no targets.json, a Radar-only (radar_puffin) release whose
//     normal asset prefix is `libreecho-<TAG>`.
//
// Nothing here decides compatibility: it only maps a release to the exact
// names a board owns. Missing or contradictory metadata throws; it never
// guesses.

import { PROFILES, normalBundleMembers, recoveryBundleMembers } from "./profiles.js";

export const COMBINED_SCHEMA = "libreecho-combined-release-v1";

const PROFILE_BY_BOARD = new Map(PROFILES.map((profile) => [profile.board, profile]));

/** The two boards the browser installer can fetch. */
export function installableBoards() {
  return PROFILES.map((profile) => ({
    board: profile.board,
    product: profile.product,
    marketing: profile.marketing,
    slug: profile.slug,
    libreEcho: profile.libreEcho,
  }));
}

export function profileForBoard(board) {
  if (!board) return null;
  return PROFILE_BY_BOARD.get(String(board).trim().toLowerCase()) ?? null;
}

export function isInstallableBoard(board) {
  return Boolean(profileForBoard(board));
}

/** The release-scoped name of the combined-release descriptor. */
export function targetsAssetName(tag) {
  return `libreecho-${tag}-targets.json`;
}

/** True when the GitHub release listing advertises a combined-release descriptor. */
export function releaseDeclaresTargets(release) {
  const name = targetsAssetName(release?.tag ?? "");
  return Boolean(release?.assets?.some((asset) => asset.name === name));
}

/**
 * The boards a release can offer, decided only from the verified GitHub asset
 * listing: a combined release offers boards with a recovery inventory; a legacy release
 * (no targets.json asset) offers only Radar. This decides what the UI *shows*;
 * the authoritative target set is still resolved from the fetched descriptor.
 */
export function offeredBoards(release) {
  return releaseDeclaresTargets(release)
    ? PROFILES.filter(profile => release.assets.some(asset => asset.name === `libreecho-${release.tag}-${profile.slug}-TWRPINSTALL-SHA256SUMS`)).map(profile => profile.board)
    : ["radar_puffin"];
}

export function releaseOffersBoard(release, board) {
  return offeredBoards(release).includes(profileForBoard(board)?.board);
}

/** Parses and validates `libreecho-<TAG>-targets.json`. */
export function parseTargetsJson(text) {
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    throw new Error("the release's targets.json is not valid JSON");
  }
  if (!data || typeof data !== "object" || data.schema !== COMBINED_SCHEMA) {
    throw new Error("the release's targets.json does not use the combined-release schema");
  }
  if (typeof data.release !== "string" || !data.release) {
    throw new Error("the release's targets.json does not name its release");
  }
  if (!Array.isArray(data.targets) || data.targets.length === 0) {
    throw new Error("the release's targets.json lists no targets");
  }
  const boards = new Set();
  const prefixes = new Set();
  const targets = data.targets.map((entry) => {
    if (!entry || typeof entry.board !== "string" || typeof entry.prefix !== "string") {
      throw new Error("the release's targets.json has a malformed target entry");
    }
    const profile = profileForBoard(entry.board);
    if (!profile) throw new Error(`the release's targets.json names an unknown board: ${entry.board}`);
    if (!/^libreecho-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.prefix) || entry.prefix.includes("..")) {
      throw new Error(`the release's targets.json has an invalid prefix for ${profile.board}`);
    }
    if (!entry.prefix.startsWith(`libreecho-${profile.slug}-`)) throw new Error(`target prefix is outside the ${profile.board} namespace`);
    if (boards.has(profile.board)) throw new Error(`the release's targets.json lists ${profile.board} twice`);
    if (prefixes.has(entry.prefix)) throw new Error("the release's targets.json lists a prefix twice");
    boards.add(profile.board);
    prefixes.add(entry.prefix);
    return {
      board: profile.board,
      prefix: entry.prefix,
      slug: profile.slug,
      product: profile.product,
      profileId: profile.id,
      descriptorSha256: typeof entry.target_descriptor_sha256 === "string" ? entry.target_descriptor_sha256 : null,
      legacy: false,
    };
  });
  return { release: data.release, targets };
}

/**
 * The targets a release offers. A combined release is driven entirely by its
 * targets.json (its `release` must match the tag); a release without one offers
 * only the legacy Radar target.
 */
export function targetsForRelease({ tag, targetsJson = null } = {}) {
  if (!tag) throw new Error("a release tag is required to resolve targets");
  if (targetsJson != null) {
    const parsed = typeof targetsJson === "string" ? parseTargetsJson(targetsJson) : targetsJson;
    if (parsed.release !== tag) {
      throw new Error("the release's targets.json names a different release than the one selected");
    }
    return parsed.targets;
  }
  const radar = profileForBoard("radar_puffin");
  return [{
    board: radar.board,
    prefix: `libreecho-${tag}`,
    slug: radar.slug,
    product: radar.product,
    profileId: radar.id,
    descriptorSha256: null,
    legacy: true,
  }];
}

/** Look up one board's target descriptor, failing closed if the release lacks it. */
export function targetForBoard({ tag, board, targetsJson = null } = {}) {
  const profile = profileForBoard(board);
  if (!profile) throw new Error(`unknown install target: ${board ?? "(none)"}`);
  const target = targetsForRelease({ tag, targetsJson }).find((entry) => entry.board === profile.board);
  if (!target) throw new Error(`this release does not offer a build for ${profile.marketing}`);
  return target;
}

// ---------------------------------------------------------------------------
// Names owned by one target
// ---------------------------------------------------------------------------

/**
 * The two checksum inventories a target owns: its normal inventory and its
 * recovery (TWRP) inventory. A legacy release keeps the original names.
 */
export function inventoryNamesForTarget({ tag, target }) {
  const normal = `${target.prefix}-SHA256SUMS`;
  const recovery = target.legacy
    ? [`libreecho-${tag}-TWRPINSTALL-SHA256SUMS`]
    : [`libreecho-${tag}-${target.slug}-TWRPINSTALL-SHA256SUMS`];
  return { normal, recovery };
}

/** The recovery ZIP and its manifest, as named by the recovery inventory. */
export function recoveryMembersForTarget(target) {
  return recoveryBundleMembers({ legacy: target.legacy, slug: target.slug });
}

export function recoveryManifestNameForTarget(target) {
  return target.legacy ? "bundle.manifest" : `libreecho-${target.slug}-bundle.manifest`;
}

/** The normal (non-recovery) members a target's normal inventory must list. */
export function normalMembersForTarget(target) {
  return normalBundleMembers(target.prefix);
}

/** Every member a target needs, grouped by the inventory that must list it. */
export function requiredMembersForTarget(target) {
  return { normal: normalMembersForTarget(target), recovery: recoveryMembersForTarget(target) };
}

/**
 * True when a checksum filename belongs to this target's own namespace. Guards
 * against one target's inventory smuggling in the other board's assets, or a
 * name that has nothing to do with the release.
 */
export function nameBelongsToTarget(name, target) {
  if (typeof name !== "string" || !name) return false;
  if (name.startsWith(`${target.prefix}-`) || name.startsWith(`${target.prefix}.`)) return true;
  if (name.startsWith(`libreecho-${target.slug}-`)) return true;
  // Radar keeps byte-for-byte aliases of its own recovery ZIP/manifest; Biscuit
  // has no such aliases, so an alias is never treated as Biscuit-owned.
  if ((target.legacy || target.slug === "radar-puffin") && (name === "libreecho-install.zip" || name === "bundle.manifest")) return true;
  return false;
}

/**
 * Reads the target/device/fastboot_products lines from a bundle manifest and
 * asserts they describe the selected target. A Dot manifest is never accepted
 * for a Radar device, and vice versa.
 */
export function parseBundleManifest(text, target) {
  const fields = {};
  const staging = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(?<key>[a-z_]+)=(?<value>.*)$/.exec(line);
    if (!match) continue;
    if (match.groups.key === "staging") staging.push(match.groups.value);
    else {
      if (['target', 'device', 'fastboot_products'].includes(match.groups.key) && Object.hasOwn(fields, match.groups.key)) throw new Error(`duplicate bundle manifest field: ${match.groups.key}`);
      fields[match.groups.key] = match.groups.value;
    }
  }
  const board = String(fields.target ?? "").trim().toLowerCase();
  const device = String(fields.device ?? "").trim().toLowerCase();
  const products = String(fields.fastboot_products ?? "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (target.legacy && !board && !device && products.length === 0) return { fields, staging, legacy: true, matches: true };
  if (board !== target.board || device !== target.board) {
    throw new Error(`the bundle manifest describes ${board || device || "an unknown target"}, not ${target.board}`);
  }
  if ((!target.legacy && (products.length !== 1 || products[0] !== target.product)) || (products.length && !products.includes(target.product))) {
    throw new Error(`the bundle manifest is for ${products.join("/")}, not a ${target.product} device`);
  }
  return { fields, staging, legacy: false, matches: true };
}
