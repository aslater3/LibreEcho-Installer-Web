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

/**
 * The only recovery install protocol this browser speaks. A bundle that carries
 * no `protocol` line is a legacy `/cache`-staging bundle: it is parsed (so a
 * caller can still inspect it) but its `protocol` is `null` and the browser
 * refuses to install it.
 */
export const PROTOCOL_DIRECT = 2;

/** Fixed v2 roles; each is located in `incoming/` on the device by digest. */
export const TRANSFER_ROLES = ["boot", "ota-manifest", "ota-signature", "local-package"];

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A bare filename: no separators, no traversal, no hidden/control names. */
function safeMemberName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 200
    && !name.includes("/") && !name.includes("\\") && !name.includes("..")
    && !name.startsWith(".") && !/[\u0000-\u001f\u007f]/.test(name);
}


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
 *
 * When a `protocol` line is present the v2 shape is validated and the transfer
 * plan is returned: `protocol`, `transfers` (fixed roles), `staging` and
 * `transferBytesTotal`. A protocol other than 2 fails closed; an absent protocol
 * is a legacy bundle (`protocol: null`, no v2 plan).
 */
export function parseBundleManifest(text, target) {
  const fields = {};
  const staging = [];
  const transfers = [];
  const transferRoles = new Set();
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^(?<key>[a-z_]+)=(?<value>.*)$/.exec(line);
    if (!match) continue;
    const key = match.groups.key;
    if (key === "staging") { staging.push(match.groups.value); continue; }
    if (key === "transfer") {
      const parts = match.groups.value.split(":");
      if (parts.length !== 3) throw new Error(`malformed bundle manifest transfer line: ${match.groups.value}`);
      const [role, name, sha256] = parts;
      if (!TRANSFER_ROLES.includes(role)) throw new Error(`unknown bundle manifest transfer role: ${role}`);
      if (!safeMemberName(name)) throw new Error(`unsafe bundle manifest transfer name: ${name}`);
      if (!SHA256_HEX.test(sha256)) throw new Error(`bundle manifest transfer ${role} is not sha256-pinned`);
      if (transferRoles.has(role)) throw new Error(`duplicate bundle manifest transfer role: ${role}`);
      transferRoles.add(role);
      transfers.push({ role, name, sha256 });
      continue;
    }
    if (["target", "device", "fastboot_products", "protocol", "transfer_bytes_total"].includes(key) && Object.hasOwn(fields, key)) {
      throw new Error(`duplicate bundle manifest field: ${key}`);
    }
    fields[key] = match.groups.value;
  }

  let protocol = null;
  if (Object.hasOwn(fields, "protocol")) {
    if (!/^[0-9]+$/.test(fields.protocol)) throw new Error(`bundle manifest protocol is not a number: ${fields.protocol}`);
    protocol = Number(fields.protocol);
    if (protocol !== PROTOCOL_DIRECT) throw new Error(`unsupported bundle manifest protocol: ${fields.protocol}`);
  }
  let transferBytesTotal = null;
  if (Object.hasOwn(fields, "transfer_bytes_total")) {
    if (!/^[0-9]+$/.test(fields.transfer_bytes_total) || !Number.isSafeInteger(Number(fields.transfer_bytes_total))) {
      throw new Error(`bundle manifest transfer_bytes_total is not a byte count: ${fields.transfer_bytes_total}`);
    }
    transferBytesTotal = Number(fields.transfer_bytes_total);
    if (protocol !== PROTOCOL_DIRECT) throw new Error("bundle manifest declares transfer_bytes_total without protocol 2");
  }

  const board = String(fields.target ?? "").trim().toLowerCase();
  const device = String(fields.device ?? "").trim().toLowerCase();
  const products = String(fields.fastboot_products ?? "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  if (target.legacy && !board && !device && products.length === 0) {
    return { fields, staging, transfers, protocol, transferBytesTotal, legacy: true, matches: true };
  }
  if (board !== target.board || device !== target.board) {
    throw new Error(`the bundle manifest describes ${board || device || "an unknown target"}, not ${target.board}`);
  }
  if ((!target.legacy && (products.length !== 1 || products[0] !== target.product)) || (products.length && !products.includes(target.product))) {
    throw new Error(`the bundle manifest is for ${products.join("/")}, not a ${target.product} device`);
  }
  return { fields, staging, transfers, protocol, transferBytesTotal, legacy: false, matches: true };
}
