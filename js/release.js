// Release metadata, checksums and payload bytes for the browser installer.
//
// What a page on a GitHub Pages origin can and cannot do, measured rather than
// assumed (verified 2026-09-23 from https://dev.libreecho.org):
//
//   * api.github.com          — readable (release metadata, asset names/sizes)
//   * raw.githubusercontent    — readable
//   * github.com/.../releases/download/<tag>/<asset>
//                             — NOT readable: the redirect response carries no
//                               Access-Control-Allow-Origin, so fetch() fails
//                               before the bytes arrive. The network path works
//                               (a no-cors request succeeds) but the response
//                               cannot be read.
//
// So the installer supports two payload sources:
//   1. an operator-supplied bundle (a folder or files downloaded from the
//      release page). Every file is hashed in the browser and checked against
//      the release's own SHA256SUMS before anything is written.
//   2. a CORS-enabled mirror, configured by the operator, base URL in
//      `mirrorBase`. When one is configured the installer downloads assets
//      in-page with progress.
//
// A release page can also be opened for a manual download; that never blocks
// the install because the operator-supplied bundle path is always available.

import { sha256Blob, sha256Bytes } from "./sha256.js";

export const DEFAULT_REPOSITORY = "aslater3/LibreEcho";

const TAG_PATTERN = /^radar-puffin-(?<kind>v\d+\.\d+\.\d+|nightly-[0-9a-f-]+|build-[0-9a-f-]+)$/;

export function installerConfig() {
  const global = typeof window !== "undefined" ? window.LIBREECHO_INSTALLER_CONFIG ?? {} : {};
  let query = {};
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    query = {
      mirror: params.get("mirror") ?? undefined,
      release: params.get("release") ?? undefined,
    };
  }
  return {
    repository: query.repository ?? global.repository ?? DEFAULT_REPOSITORY,
    mirrorBase: (query.mirror ?? global.mirrorBase ?? "").replace(/\/+$/, ""),
    releaseTag: query.release ?? global.releaseTag ?? "",
  };
}

export function releaseAssetUrl(tag, name, repository = DEFAULT_REPOSITORY) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

export function releasePageUrl(tag, repository = DEFAULT_REPOSITORY) {
  return `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`;
}

export function assetPrefix(tag) {
  return `libreecho-${tag}`;
}

export async function fetchReleaseIndex(repository = DEFAULT_REPOSITORY) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=30`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
  }
  const releases = await response.json();
  return releases
    .map((release) => {
      const match = TAG_PATTERN.exec(release.tag_name ?? "");
      return {
        tag: release.tag_name,
        name: release.name,
        publishedAt: release.published_at,
        prerelease: Boolean(release.prerelease),
        draft: Boolean(release.draft),
        kind: match?.groups?.kind?.startsWith("v") ? "stable" : "development",
        htmlUrl: release.html_url,
        assets: (release.assets ?? []).map((asset) => ({
          name: asset.name,
          size: asset.size,
          url: asset.browser_download_url,
          digest: asset.digest,
        })),
      };
    })
    .filter((release) => release.tag && !release.draft);
}

export function pickLatestStable(releases) {
  const stable = releases.filter((release) => release.kind === "stable" && !release.prerelease);
  stable.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return stable[0] ?? null;
}

export function pickLatestDevelopment(releases) {
  const dev = releases.filter((release) => release.kind === "development");
  dev.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  return dev[0] ?? null;
}

/** Parses a `SHA256SUMS` file into a Map of filename -> lowercase digest. */
export function parseSums(text) {
  const sums = new Map();
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(?<hash>[0-9a-fA-F]{64})\s+\*?(?<name>.+)$/.exec(line);
    if (!match) throw new Error(`invalid SHA256SUMS line: ${line.slice(0, 80)}`);
    const name = match.groups.name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === '.' || name === '..') {
      throw new Error(`invalid checksum filename: ${name.slice(0, 80)}`);
    }
    if (sums.has(name)) throw new Error(`duplicate checksum filename: ${name}`);
    sums.set(name, match.groups.hash.toLowerCase());
  }
  if (sums.size === 0) throw new Error("no usable digests found in SHA256SUMS");
  return sums;
}

export async function sha256OfBlob(blob, onProgress) {
  return sha256Blob(blob, { onProgress });
}

export async function sha256OfBytes(bytes) {
  return sha256Bytes(bytes);
}

/**
 * Reads the release's SHA256SUMS. Tries the direct release URL first (it will
 * fail from a browser origin unless a mirror is configured), then the mirror.
 */
export async function fetchSums(tag, { repository = DEFAULT_REPOSITORY, mirrorBase = "" } = {}) {
  const name = `${assetPrefix(tag)}-SHA256SUMS`;
  const attempts = [releaseAssetUrl(tag, name, repository)];
  if (mirrorBase) attempts.unshift(`${mirrorBase}/${tag}/${name}`);
  const failures = [];
  for (const url of attempts) {
    try {
      const response = await fetch(url, { mode: "cors", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      return { sums: parseSums(text), source: url };
    } catch (error) {
      failures.push(`${url} → ${error.message}`);
    }
  }
  const error = new Error(
    "could not read the release checksum file over HTTP. " +
      failures.join("; ") +
      ". Provide the bundle files directly instead — they are verified against the same digests.",
  );
  error.failures = failures;
  throw error;
}

/**
 * Downloads one asset. `bytes` is only reachable when a CORS-enabled mirror is
 * configured or the asset is served from the same origin.
 */
export async function downloadAsset(tag, name, { repository = DEFAULT_REPOSITORY, mirrorBase = "", onProgress } = {}) {
  const attempts = [releaseAssetUrl(tag, name, repository)];
  if (mirrorBase) attempts.unshift(`${mirrorBase}/${tag}/${name}`);
  const failures = [];
  for (const url of attempts) {
    try {
      const response = await fetch(url, { mode: "cors", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const total = Number(response.headers.get("content-length") ?? 0);
      if (!response.body) {
        const buffer = await response.arrayBuffer();
        return new Blob([buffer]);
      }
      const reader = response.body.getReader();
      const parts = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.byteLength;
        if (onProgress) onProgress(total ? received / total : 0, received, total);
      }
      return new Blob(parts);
    } catch (error) {
      failures.push(`${url} → ${error.message}`);
    }
  }
  const error = new Error(
    `could not download ${name} in the browser (${failures.join("; ")}). ` +
      "The release download endpoint does not send CORS headers, so download the asset from the release page and provide it here.",
  );
  error.failures = failures;
  throw error;
}

/** Verifies a bundle from an operator-supplied file list against the sums. */
export async function verifyBundleFiles(files, { sums, onProgress, onFile }) {
  const byName = new Map();
  for (const file of files) {
    byName.set(file.name, file);
    // Some browsers expose only the relative path; index both.
    const base = file.webkitRelativePath ? file.webkitRelativePath.split("/").pop() : null;
    if (base && !byName.has(base)) byName.set(base, file);
  }
  const checked = [];
  const verified = new Map();
  const missing = [];
  const failed = [];
  let index = 0;
  for (const [name, expected] of sums) {
    const file = byName.get(name);
    index += 1;
    if (!file) {
      missing.push(name);
      continue;
    }
    const actual = await sha256Blob(file, {
      onProgress: (fraction) => onProgress && onProgress(index / sums.size, name, fraction),
    });
    if (onFile) onFile(name, file, actual, expected);
    if (actual === expected) {
      checked.push({ name, size: file.size, sha256: actual });
      verified.set(name, file);
    } else failed.push({ name, expected, actual, file });
  }
  return { checked, missing, failed, byName: verified };
}
