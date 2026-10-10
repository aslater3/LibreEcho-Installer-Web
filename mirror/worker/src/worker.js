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
// If an R2 bucket is bound as ASSETS (later, once R2 is enabled), objects are
// served from R2 first and GitHub is the fallback.

const REPOSITORY = "aslater3/LibreEcho";
const TAG = /^radar-puffin-(v\d+\.\d+\.\d+|nightly-[0-9a-f-]{1,80}|build-[0-9a-f-]{1,80})$/;
const NAME = /^libreecho-[A-Za-z0-9._-]{1,200}$/;
const ORIGINS = new Set([
  "https://install.libreecho.org",
  "https://install.dev.libreecho.org",
  "https://dev.libreecho.org",
  "https://libreecho.org",
  "https://aslater3.github.io",
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

function finish(upstream, request, source) {
  const h = cors(request);
  for (const k of PASS_HEADERS) {
    const v = upstream.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set("Content-Type", "application/octet-stream");
  h.set("Cache-Control", "public, max-age=86400");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-LibreEcho-Source", source);
  return new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "method not allowed", request);
    if (url.pathname === "/" || url.pathname === "/healthz") return plain(200, "libreecho-dl ok", request);

    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (parts.length !== 2 || !TAG.test(parts[0]) || !NAME.test(parts[1])) return plain(404, "not found", request);
    const [tag, name] = parts;
    const range = request.headers.get("Range");

    if (env.ASSETS) {
      const key = `${tag}/${name}`;
      const obj = request.method === "HEAD"
        ? await env.ASSETS.head(key)
        : await env.ASSETS.get(key, range ? { range: request.headers } : {});
      if (obj) {
        const h = new Headers();
        obj.writeHttpMetadata(h);
        const r = obj.range;
        const off = r ? (r.suffix !== undefined ? obj.size - r.suffix : (r.offset ?? 0)) : 0;
        const len = r ? (r.suffix !== undefined ? r.suffix : (r.length ?? obj.size - off)) : obj.size;
        h.set("content-length", String(len));
        h.set("etag", obj.httpEtag);
        h.set("accept-ranges", "bytes");
        if (r) h.set("content-range", `bytes ${off}-${off + len - 1}/${obj.size}`);
        return finish(new Response(obj.body ?? null, { status: r ? 206 : 200, headers: h }), request, "r2");
      }
    }

    const upstreamUrl = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
    const headers = { "User-Agent": "libreecho-dl-mirror" };
    if (range) headers.Range = range;
    const upstream = await fetch(upstreamUrl, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "follow",
      // Release assets are immutable per tag; let Cloudflare cache what it can.
      cf: { cacheEverything: true, cacheTtl: 86400 },
    });
    if (upstream.status === 404) return plain(404, "not found", request);
    if (!upstream.ok && upstream.status !== 206) return plain(502, `upstream HTTP ${upstream.status}`, request);
    return finish(upstream, request, "github");
  },
};
