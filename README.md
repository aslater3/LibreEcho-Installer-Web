# LibreEcho browser installer (publication site)

Static GitHub Pages publication of the LibreEcho browser one-shot installer:
verify a published release, talk to the device over USB with the browser's own
WebUSB permission prompt, and run the install stages with a terminal progress
monitor.

Intended to be served at **`install.dev.libreecho.org`** (development) and later
`install.libreecho.org` (production). Until those DNS records exist it is also
reachable at its GitHub Pages URL.

## What is in here

| Path | Purpose |
|---|---|
| `index.html` | The installer |
| `NOTES.html` | Operator notes: route, limitations, browser requirements, mirror configuration |
| `css/installer.css` | Page styles |
| `js/` | Installer UI, stage orchestration, release verification, SHA-256, terminal |
| `lib/fastboot/` | Fastboot protocol + WebUSB transport + unit tests |
| `lib/adb/` | ADB protocol (shell, sync push) + WebUSB transport + unit tests |
| `assets/images/` | The two artwork files the page uses |

## Source of truth

The installer is developed in
[`aslater3/LibreEcho-Docs-dev`](https://github.com/aslater3/LibreEcho-Docs-dev)
under `install/`, and published from there at `dev.libreecho.org/install/`.
This repository is its publication home for its own hostname.

`sync-installer.yml` copies `install/` from that repository into this one on a
daily schedule or on demand, rewriting the two artwork references that are
parent-relative in the development tree. Run it (or the equivalent manual copy)
whenever the installer changes upstream; do not edit the published copy by hand
unless the change is meant to exist only here.

## Deployment

Pages is configured with **build_type: workflow**, `.github/workflows/pages.yml`
uploads the repository root as the site artifact, and the custom domain
(`install.dev.libreecho.org`) is applied only **after** the DNS record exists —
adding a custom domain makes the `github.io` URL redirect to it, so the plain
Pages URL stops working as a fallback at that moment.

DNS, in Cloudflare, DNS-only (not proxied):

```text
CNAME  install.dev  →  aslater3.github.io
```

## Current state

* Preview: the page carries `noindex`, and `robots.txt` denies crawling. Both
  should be flipped when the installer is announced publicly.
* The installer is a fail-closed preview: **Run is disabled** until the exact
  target board has a hardware-accepted, marker-safe boot image. Biscuit has no
  qualified image yet. Rehearse performs no device writes.
* The sync and Pages jobs run protocol tests **and** the browser stage safety
  tests before publication. These are scripted-device/host checks, not a WebUSB
  hardware install or proof that an oversized fastbrick is accepted by the LK.
* The installer has not been run against Echo hardware from a browser. Protocol
  layers are unit-tested against scripted devices; the rest is browser-tested
  only without granting USB access.
* Licence: MIT for the website source, as in the development repository. See
  `LICENSE` and `THIRD_PARTY_NOTICES.md`.
