# Bandwidth Guardian

An MV3 browser extension that routes eligible images through your own
[bandwidth-hero-compatible-proxy](https://github.com/anT0ny54/bhp2), recompressing
them (quality cap, optional grayscale, max-width downscale) before they reach
the browser — and optionally sends `Save-Data: on` with requests.

## Platform support

**Chrome / Chromium-based browsers only** (Chrome, Edge, Brave, Opera, Arc,
Cromite, …). Minimum Chrome version: **128** (uses DNR response-header
matching). Firefox is **not** supported: MV3 `background.service_worker` and the
DNR features used here are Chromium-only, so the manifest no longer ships a
`browser_specific_settings.gecko` block.


## What gets proxied

Only **strictly detected image types** are ever treated as images for usage
statistics:

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
tracking-pixel URLs are never proxied by the URL rewriters.

## How it works

- **prehook.js** (`document_start`, page MAIN world): patches
  `HTMLImageElement.src/srcset/loading`, `HTMLSourceElement.srcset`,
  `HTMLLinkElement.href` and `Element.prototype.setAttribute` before page
  scripts run, so JS-assigned image URLs (including every lazy loader's
  `img.src = dataset.src`) are proxied before any network request fires. A
  child-list observer also catches parser-created `<img>`/`<source>` elements
  and holds their URL attributes until settings are available, which reduces
  the initial direct-request race but cannot undo DNS work that already began.
- **content.js** (isolated world): catches HTML-parser-created `<img>`/`<source>`
  nodes and inline CSS `background-image`. When idle (extension disabled, no
  proxy configured, or an excluded page) its MutationObserver disconnects and
  it does no per-mutation work.
- **service-worker.js**: keeps the fast `storage.local` settings mirror, counts
  stats from the proxy's `x-bh-*` response headers (only for the strict image
  types above), injects `Save-Data: on` via DNR, and strips CSP **only while a
  valid proxy is configured** (and only on documents whose CSP references
  `img-src`/`default-src`, where the browser supports the header condition).
  Excluded domains always keep their own CSP.

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

## Interception coverage and tests

The interceptor covers JavaScript `img.src`/`img.srcset` writes, `setAttribute`
updates, parser-created `<img>` and `<source>` nodes, `<picture>` responsive
sources, image preload links, and **inline** CSS `background-image` URLs. The
prehook now queues every element while settings are loading rather than
silently dropping elements after a 1,000-item cap. This matters on long feeds
and image-heavy pages.

Run the regression simulation from the repository root with Node.js:

```sh
node --test tests/interception-simulation.test.cjs
```

The simulation checks URL encoding, `srcset` parsing, the main-world setters,
parser-created images, preload links, and more than 2,000 queued images. The
inline-CSS test exercises the existing content-script rewrite routine.

This is not proof that every web page can be intercepted. Images referenced by
external stylesheets or CSS pseudo-elements, external SVG `<image>` elements,
`<video poster>`, browser-internal pages, and `data:`/`blob:` resources are not
covered by the same interception paths. Stylesheet images may begin loading
before a content script can inspect computed styles, and MutationObserver
callbacks are asynchronous. Use Chromium DevTools **Network** on the target
site to confirm each intended image request actually goes to your configured
proxy; compare requests from the proxy origin with requests to the original
image hosts. A site-specific test can establish coverage for that site's
current markup, but cannot certify all websites.

## Stats

Processed images, bytes processed and bytes saved are read from the proxy's
response headers and flushed in batches. The **Reset stats** button clears the
counters.

## Build

```sh
./build.sh
```

The build stages the shipped files, syntax-checks the JavaScript, validates the
manifest (MV3, Chrome-only), normalizes file modes, and writes a reproducible
`bandwidth-guardian-<version>.zip`.

Releasing is handled by `.github/workflows/build.yml`. Every push to `main`
builds the extension. If a release for the manifest version does not exist, the
workflow creates it; if that release already exists, it replaces the release
asset. Bump `manifest.json`'s version when publishing a distinct release.

## 🔗 Related projects (not part of this repository)

The services below are maintained separately and are **not** part of this
repository, its build pipeline, or its release cycle. They are listed here for
convenience only; listing them does not configure the browser to use them.

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

A lightweight image optimization proxy designed to slash bandwidth usage and
accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and
delivers optimized versions to the client. This significantly reduces data
consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
