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
`Content-Type` is one of the above. Favicons, `.ico`, `.svg`, known
tracking-pixel URLs, excluded domains and private-network hosts are never
proxied.

## How it works

Interception happens in two layers, so an image request is rewritten exactly
once and before Chrome starts it.

1. **Network layer (primary), `service-worker.js`.** A declarativeNetRequest
   `redirect` rule (`regexFilter ^https?://.+`, resource type `image`, plus
   `object` requests whose URL ends in an image extension) rewrites every image
   request to
   `<proxy>?jpeg=0&bw=N&quality=N[&max_width=N]&url=<original, unencoded>`
   inside the browser's network stack, **before any connection or DNS lookup to
   the original host**. It covers every way a page can ask for an image:
   `<img>`, `srcset`/`<picture>`, preload links, lazy loaders, all CSS
   (inline, same-origin, cross-origin, `@import`, pseudo-elements,
   `image-set()`), shadow roots, SVG `<image>`, video posters, `new Image()`.
   The raw `url=` form relies on the bandwidth-hero-proxy2 contract: an
   unencoded `url` starting with `http` is taken verbatim up to the first
   `&quality=`, `&l=`, `&bw=`, `&jpeg=` or `&max_width=`.
   - **No duplicate proxying:** an allow rule with higher priority matches the
     proxy origin itself, so a proxied URL is never redirected again.
   - **Exemptions** (higher priority than the redirect): excluded domains
     (both as request host and page/initiator), favicons, `.ico`/`.svg`,
     known tracking pixels, `data:`/`blob:` (never matched), localhost,
     `*.local`, single-label intranet hosts and private/link-local IP
     literals (a public proxy cannot reach them; bandwidth-hero-proxy2 answers
     403 for them).
   - **Conflict URLs:** URLs containing `&quality=`, `&l=`, `&bw=`, `&jpeg=` or
     `&max_width=` would be truncated by the raw contract, so the network rule
     skips them and the DOM layer proxies them URL-encoded instead.
2. **DOM layer, `prehook.js` (MAIN world, `document_start`) and `content.js`.**
   Patches `src`/`srcset`/`href`/`poster`/`setAttribute` and observes the
   document and every open, closed and declarative shadow root. When the
   network rule is live it only handles conflict URLs, and hands everything else
   to the network layer untouched (so nothing is wrapped twice). If the network
   rule could not be installed, it falls back to rewriting every eligible URL
   itself (the pre-0.1.9 behaviour).

### Fallback, loops and the circuit breaker

- A proxied request that fails (HTTP error, wrong type, network error) is
  reported by `webRequest`; the original URL gets a **per-tab session bypass
  rule** and the page is asked to re-request that one URL **directly, once**
  (`<img>`, `<picture>`, poster, SVG `<image>`, `<object>/<embed>`, inline
  styles, same-origin CSS rules; cross-origin `<link>` sheets are reloaded once
  when the URL was not found anywhere accessible). The bypass list is also
  given to new documents in that tab, so a reload does not try the proxy again.
  Bypass rules are removed when the tab closes.
- If the proxy itself is unreachable (6 connection-level failures within 30 s),
  the redirect is suspended for 2 minutes and pages load images directly; it
  then resumes automatically.
- Usage statistics are counted only from successful proxy responses of the
  strict image types above; failed and fallback requests are never counted.

`service-worker.js` also injects `Save-Data: on` and strips CSP **only while a
valid proxy is configured** (only on documents whose CSP references
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
other. The options page reloads the tab that opened it after a save. The
service worker only reacts to `storage.sync` changes for the settings keys it
manages, so unrelated sync writes never trigger rule refreshes.

## Interception coverage and tests

| Image mechanism | How it is covered | Browser test |
|---|---|---|
| `<img src>`, JS-assigned, `setAttribute`, `innerHTML`, URL changes, mutation bursts | Network redirect; DOM layer for conflict URLs | 2,500-image burst, URL changes |
| `srcset`, `sizes`, `<picture>`, `<source>` | Network redirect applies to whichever candidate Chrome selects; DOM layer rewrites every candidate and keeps descriptors | viewport growth, media switching |
| `<link rel="preload" as="image">`, `imagesrcset` | Network redirect; preload and `<img>` share one proxied request | attribute changes, de-duplication |
| Lazy loading (`loading=lazy`, `data-src`, `data-srcset`, framework loaders) | The URL is redirected when the loader actually activates it | nothing requested early |
| Inline, same-origin, cross-origin and `@import` stylesheet backgrounds, multiple backgrounds, `image-set()`, `@media` | Network redirect (no CSSOM access needed, so cross-origin sheets are covered) | each case |
| CSS pseudo-elements `::before`/`::after` | Network redirect | computed-style + request check |
| Open, closed and declarative shadow roots | Network redirect; `attachShadow` is wrapped so the DOM layer also observes roots | all three |
| SVG `<image href>` / `xlink:href` | Redirected; `<use>` sprite references and `.svg` files are left alone, fragments intact | fragments preserved |
| `<video poster>` | Redirected | poster renders |
| `<object>`/`<embed>` image URLs | Redirected only when the URL has an image extension; documents in `<object>` untouched | |
| `<canvas>` | Images drawn from proxied `<img>` are proxied; the proxy sends `Access-Control-Allow-Origin: *`, so `crossorigin="anonymous"` images stay untainted | |

Every browser test checks the actual URL Chrome requested (logged by a local
mock origin and a mock proxy built from bandwidth-hero-proxy2's own URL parser),
that the image loaded, fallback behaviour and that no request was proxied twice.
Further tests cover a 600-image responsive, lazy, infinite-scroll page with
viewport changes, dynamically loaded content, exclusions and private hosts,
page CSP, enable/disable and settings changes, statistics and the circuit
breaker.

### Running the tests

```sh
# Unit/simulation tests (no browser needed)
node --test tests/interception-simulation.test.cjs

# Real-Chrome tests
npm i --no-save playwright-core
npx playwright-core install chromium          # or use an existing Chrome/Chromium
git clone https://github.com/anT0ny54/bhp2 ../bhp2   # optional: real URL parser
CHROME_PATH="$(node -e "console.log(require('playwright-core').chromium.executablePath())")" \
BHP2_DIR=../bhp2 node --test --test-concurrency=1 tests/
```

### Known limits

- Requests Chrome does not classify as `image` are not proxied: `fetch()`/XHR
  image downloads, images fetched by a page's own service worker (untested),
  media Chrome loads as `media`, and `blob:`/`data:` URLs.
- `crossorigin="use-credentials"` images fail through the proxy (credentialed
  CORS cannot use `Access-Control-Allow-Origin: *`) and Chrome reports no
  network error for it, so no automatic fallback occurs. Exclude such sites.
- Same-origin images become cross-origin through the proxy; a canvas drawing
  them without `crossorigin` becomes tainted for `getImageData()`/`toDataURL()`.
- Conflict URLs (containing `&quality=` and similar) are proxied by the DOM
  layer only; when referenced from stylesheets they load directly.
- Fallback can't re-request images inside closed declarative shadow roots or
  `new Image()` objects not attached to the document; a reload loads them
  directly because the bypass rule is already installed.
- Browser-internal pages, the Web Store and other extensions' pages are never
  touched by Chrome.

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
