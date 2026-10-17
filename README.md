# Bandwidth Guardian

An MV3 browser extension that routes images through your own
[bandwidth-hero](https://github.com/anT0ny54/bhp2) compatible proxy,
recompressing them (quality cap, optional grayscale, max-width downscale)
before they reach the browser — and optionally sends `Save-Data: on` with every
request.

## Platform support

**Chrome / Chromium-based browsers only** (Chrome, Edge, Brave, Opera, Arc,
Cromite, …). Minimum Chrome version: **128** (uses DNR response-header
matching). Firefox is **not** supported: MV3 `background.service_worker` and
the DNR features used here are Chromium-only, so the manifest no longer ships a
`browser_specific_settings.gecko` block.

## What gets proxied

Only **strictly detected image types** are ever treated as images:

| Type | MIME |
|---|---|
| JPEG | `image/jpeg` |
| PNG | `image/png` |
| WebP | `image/webp` |
| GIF | `image/gif` |
| TIFF | `image/tiff` |
| JPEG XL | `image/jxl` |

Usage statistics are counted only for proxy responses whose actual
`Content-Type` is one of the above. Favicons, `.ico`, `.svg`, and known
tracking-pixel URLs are never proxied.

## How it works

- **prehook.js** (`document_start`, page MAIN world): patches
  `HTMLImageElement.src/srcset/loading`, `HTMLSourceElement.srcset`,
  `HTMLLinkElement.href` and `Element.prototype.setAttribute` before page
  scripts run, so JS-assigned image URLs (including every lazy loader's
  `img.src = dataset.src`) are proxied before any network request fires.
- **content.js** (isolated world): catches HTML-parser-created `<img>`/`<source>`
  nodes and inline CSS `background-image`. When idle (extension disabled, no
  proxy configured, or an excluded page) its MutationObserver disconnects and
  it does no per-mutation work.
- **service-worker.js**: keeps the fast `storage.local` settings mirror, counts
  stats from the proxy's `x-bh-*` response headers (only for the strict image
  types above), injects `Save-Data: on` via DNR, and strips CSP **only while a
  valid proxy is configured** (and only on documents whose CSP references
  `img-src`/`default-src`). Excluded domains always keep their own CSP.

## Settings

| Setting | Default | Notes |
|---|---|---|
| `enabled` | `true` | Master switch for image compression |
| `saveData` | `true` | Send `Save-Data: on` on requests (applies even when compression is off) |
| `proxyBase` | `""` | Your proxy URL; empty = no proxy configured (nothing is compressed) |
| `quality` | `60` | 1–100 |
| `grayscale` | `true` | Server-side grayscale (`bw=1`) |
| `maxWidth` | `768` | `0` = no limit |
| `excludeDomains` | `""` | Comma/space/newline separated; subdomains match |

Settings changed on one surface (popup vs. options page) stay in sync on the
other. The options page reloads the tab that opened it after a save.

## Stats

Processed images, bytes processed and bytes saved are read from the proxy's
response headers and flushed in batches. The **Reset stats** button clears the
counters.

## Build

```sh
./build.sh
```

The build stages the tracked files, syntax-checks the classic scripts as
CommonJS (`.cjs`) and the ES-module pages as `.mjs`, validates the manifest
(MV3, Chrome-only), normalizes file modes, and writes
`bandwidth-guardian-main.zip` reproducibly.

Releasing is handled by `.github/workflows/build.yml`: a release (and its tag)
is created only when the version in `manifest.json` has not been released yet —
bump the version to publish a new one.

## 🔗 Related projects (not part of this repository)

The services below are maintained separately and are **not** part of this repository, its build pipeline, or its release cycle. They are listed here for convenience only.

### 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns.mydoh.workers.dev/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` |

### ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
