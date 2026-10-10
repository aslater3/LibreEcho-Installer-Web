# Release download mirror (`dl.libreecho.org`)

The browser installer cannot read GitHub release downloads directly (no CORS
headers), so it fetches them from `https://dl.libreecho.org/<tag>/<asset>`.

| Piece | Where |
|---|---|
| Worker `libreecho-dl` (custom domain `dl.libreecho.org`) | `mirror/worker/` |
| Private R2 bucket `libreecho-releases` (WEUR, no public `r2.dev` URL) | Cloudflare account |
| Sync job: GitHub releases → R2 | `.github/workflows/sync-r2-mirror.yml` |

The Worker serves `<tag>/<asset>` from R2 when present (`X-LibreEcho-Source: r2`)
and otherwise passes the request through to the GitHub release
(`X-LibreEcho-Source: github`), adding CORS only for the installer origins. It
accepts GET/HEAD/OPTIONS for `radar-puffin-*` tags and `libreecho-*` names only,
and has logs disabled.

The mirror is untrusted transport: the installer checks every file against the
release's `SHA256SUMS` and GitHub's asset digests, and the sync job checks each
download against `SHA256SUMS` before upload.

## Sync job

Runs every 3 hours and on demand (optionally for one tag). It keeps the newest 3
`radar-puffin-*` releases plus the newest stable `vX.Y.Z`, deletes other tags
from the bucket, and fails if the bucket exceeds 9 GiB (the free tier is 10 GB).
A release counts as mirrored once its `.mirror-complete` marker exists, so an
interrupted upload is retried.

Secrets (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) are an
R2 S3 credential scoped to object read/write on this bucket only.

## Deploying the Worker

```bash
cd mirror/worker
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… npx wrangler@4 deploy
```

`mirror/` is excluded from the Pages artifact.
