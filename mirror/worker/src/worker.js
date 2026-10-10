// libreecho-dl: CORS-enabled read-only mirror of LibreEcho GitHub release assets.
//
//   GET/HEAD https://dl.libreecho.org/<tag>/<asset>
//
// GitHub's release download endpoint sends no Access-Control-Allow-Origin
// header, so the browser installer cannot read assets in-page. This Worker
// fetches the same URL server-side and returns it with CORS headers for the
// installer origins only. It is untrusted transport: the installer verifies
// every byte against the release's own SHA256SUMS.
//
// Objects are served from the R2 bucket bound as ASSETS first; GitHub is the
// fallback for release assets. `amonet/<pinned zip>` is served from R2 only.
//
// Device OTA transport (stable paths, independent of the GitHub owner):
//   /latest/download/<asset>         -> GitHub releases/latest/download/<asset>
//   /download/<tag>/<asset>          -> same as /<tag>/<asset>
//   /download/<slug>-dev-channel/release-pointer*.txt  (mutable dev pointer)
// Mutable responses are never cached here. Devices verify signatures and the
// signed manifest hashes, so this Worker is untrusted transport.

const DEFAULT_REPOSITORY = "aslater3/LibreEcho";
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const POINTER_TAG = /^(radar-puffin|biscuit)-dev-channel$/;
const POINTER_NAME = /^release-pointer(-v3)?\.txt$/;
const TAG = /^radar-puffin-(v\d+\.\d+\.\d+|nightly-[0-9a-f-]{1,80}|build-[0-9a-f-]{1,80})$/;
const NAME = /^libreecho-[A-Za-z0-9._-]{1,200}$/;
const RETIRED = /^radar-puffin-v0\.(?:\d|1[0-3])\.\d+$/;
// Exact names pinned (with size and SHA-256) in the installer's js/profiles.js.
const AMONET = new Set(["amonet-radar-v1.0.0.zip", "amonet-biscuit-v2.0.0.zip"]);
const ORIGINS = new Set([
  "https://install.libreecho.org",
  "https://install.dev.libreecho.org",
  "https://dev.libreecho.org",
  "https://libreecho.org",
  "https://aslater3.github.io",
  "https://libreecho.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const PASS_HEADERS = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"];

function cors(request) {
  const origin = request.headers.get("Origin");
  const h = new Headers({ Vary: "Origin" });
  if (origin && ORIGINS.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    h.set("Access-Control-Allow-Headers", "Range");
    h.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag");
    h.set("Access-Control-Max-Age", "86400");
  }
  return h;
}

function plain(status, text, request) {
  const h = cors(request);
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("Cache-Control", "no-store");
  return new Response(request.method === "HEAD" ? null : text + "\n", { status, headers: h });
}

function finish(upstream, request, source, mutable = false) {
  const h = cors(request);
  for (const k of PASS_HEADERS) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("Content-Type", "application/octet-stream");
  h.set("Cache-Control", mutable ? "no-store" : "public, max-age=86400");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-LibreEcho-Source", source);
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: h });
}

// Serves an R2 object (whole or ranged) with the same headers as the GitHub path.
async function fromR2(env, key, request) {
  const range = request.headers.get("Range");
  const obj = request.method === "HEAD"
    ? await env.ASSETS.head(key)
    : await env.ASSETS.get(key, range ? { range: request.headers } : {});
  if (!obj) return null;
  const h = new Headers();
  // R2 can report a range even for a whole-object read; only answer 206 when
  // the client actually asked for a range.
  const r = range ? obj.range : undefined;
  const off = r ? (r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0)) : 0;
  const len = r ? (r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - off)) : obj.size;
  h.set("content-length", String(len));
  h.set("etag", obj.httpEtag);
  h.set("accept-ranges", "bytes");
  if (r) h.set("content-range", `bytes ${off}-${off + len - 1}/${obj.size}`);
  return finish(new Response(obj.body ?? null, { status: r ? 206 : 200, headers: h }), request, "r2");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "method not allowed", request);
    if (url.pathname === "/" || url.pathname === "/healthz") return plain(200, "libreecho-dl ok", request);

    let parts;
    try {
      parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      return plain(404, "not found", request);
    }
    const repository = REPO.test(env.REPOSITORY || "") ? env.REPOSITORY : DEFAULT_REPOSITORY;

    // Device OTA paths. `latest` and the dev pointers are mutable: GitHub only,
    // never cached, never served from R2.
    if (parts[0] === "latest" && parts[1] === "download" && parts.length === 3) {
      if (!NAME.test(parts[2])) return plain(404, "not found", request);
      return github(`latest/download/${encodeURIComponent(parts[2])}`, repository, request, true);
    }
    if (parts[0] === "download" && parts.length === 3) {
      if (POINTER_TAG.test(parts[1])) {
        if (!POINTER_NAME.test(parts[2])) return plain(404, "not found", request);
        return github(`download/${parts[1]}/${parts[2]}`, repository, request, true);
      }
      parts = parts.slice(1);
    }

    // Pinned Amonet archives (community ZIPs, not GitHub releases): R2 only.
    // The installer checks each against the SHA-256 pinned in profiles.js.
    if (parts.length === 2 && parts[0] === "amonet") {
      if (!AMONET.has(parts[1]) || !env.ASSETS) return plain(404, "not found", request);
      return (await fromR2(env, `amonet/${parts[1]}`, request)) ?? plain(404, "not found", request);
    }
    if (parts.length !== 2 || !TAG.test(parts[0]) || !NAME.test(parts[1])) return plain(404, "not found", request);
    const [tag, name] = parts;
    // 0.13 is retired: not mirrored and not proxied.
    if (RETIRED.test(tag)) return plain(410, "release retired", request);

    if (env.ASSETS) {
      const hit = await fromR2(env, `${tag}/${name}`, request);
      if (hit) return hit;
    }

    return github(`download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, repository, request, false);
  },
};

// Proxies a GitHub release path. Immutable tagged assets may be edge-cached;
// mutable aliases (latest, dev pointers) bypass the cache entirely.
async function github(path, repository, request, mutable) {
  const headers = { "User-Agent": "libreecho-dl-mirror" };
  const range = request.headers.get("Range");
  if (range) headers.Range = range;
  const upstream = await fetch(`https://github.com/${repository}/releases/${path}`, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers,
    redirect: "follow",
    cf: mutable ? { cacheTtl: 0, cacheEverything: false } : { cacheEverything: true, cacheTtl: 86400 },
  });
  if (upstream.status === 404) return plain(404, "not found", request);
  if (!upstream.ok && upstream.status !== 206) return plain(502, `upstream HTTP ${upstream.status}`, request);
  return finish(upstream, request, "github", mutable);
}
