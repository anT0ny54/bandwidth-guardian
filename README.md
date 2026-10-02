# 🛡️ Bandwidth Guardian

> Save bandwidth by compressing images through your own image proxy before they load.


Bandwidth Guardian is a Manifest V3 Chromium extension that rewrites image URLs so images are fetched through a configurable, self-hosted compression proxy before the browser downloads them. It supports WebP output, grayscale mode, quality presets, maximum image width, per-site exclusions, and usage statistics.

Works with **Chrome**, **Kiwi Browser**, **Cromite**, and other Chromium-based browsers that support Manifest V3. Firefox support is declared in the manifest (`browser_specific_settings.gecko`, minimum version 128).

## Features

- **Custom image proxy** — use your own compatible proxy; Guardian does not depend on a fixed third-party image service.
- **WebP output** — proxy requests are always sent with `jpeg=0`; every supported browser handles WebP.
- **Grayscale mode** — optionally request black-and-white images from the proxy (`bw=1`). **On by default.**
- **Quality presets** — **Small** (45, Most saving), **Normal** (60, Balanced), and **Sharp** (80, More detail), plus custom quality from 1–100. Default is **60**.
- **Maximum image width** — **HD** (768 px, default), **Full HD** (1024 px), or **No limit** (original size). Larger images are resized before compression. A custom width is also accepted; `0` means no limit.
- **Per-site exclusions** — skip domains that should not be proxied (none excluded by default).
- **Usage stats** — tracks processed images, bytes received from the configured image proxy, and estimated bytes saved.
- **CSP handling** — removes restrictive CSP response headers that can prevent proxy-served images from loading.
- **Early image interception** — a `document_start` prehook catches JavaScript-created images before the browser downloads the original image.
- **Dynamic image handling** — covers normal `src`, `srcset`, lazy-loading attributes, preload images, inline background images, and dynamically inserted content.
- **Automatic fallback** — if a proxied image fails to load, Guardian restores the original image URL so pages do not stay broken.
- **Local settings mirror** — keeps a fast `storage.local` copy of synchronized settings so interception can happen with minimal delay.

## Installation

### From source (sideload)

1. Clone or download this repository.
2. Open `chrome://extensions` (or `kiwi://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the repository folder.
5. Open Bandwidth Guardian settings and enter your image proxy URL.

### Reproducible build

```bash
bash build.sh
# outputs: bandwidth-guardian-0.0.11.zip
```

The build script reads the version from `manifest.json`, stages only extension runtime files (no README/LICENSE), applies a fixed timestamp, sorts the archive entries, and creates a deterministic ZIP.

## Recommended proxy

Need a proxy? → **[bandwidth-hero-proxy2](https://github.com/anT0ny54/bhp2)**

Bandwidth Guardian is designed around a configurable proxy rather than a hard-coded proxy service. The configured endpoint should accept the source image URL and compression parameters in its query string.

Guardian sends parameters equivalent to:

```text
?url=<encoded-image-url>&quality=<1-100>&bw=<0|1>&jpeg=<0|1>&max_width=<pixels>
```

The proxy should return `bandwidth-hero-proxy` when called without a `url` parameter; Guardian uses that response for the proxy connection test.

## Settings

Defaults on a fresh install:

| Setting | Default |
|---|---|
| Enabled | `true` |
| Proxy URL | *(empty — must be set)* |
| Quality | `60` (Normal) |
| Grayscale | `true` |
| Max width | `768` (HD) |
| Excluded domains | *(empty)* |

### Quality

| Preset | Quality | Meaning |
|---|---:|---|
| Small | 45 | Most saving |
| Normal | 60 | Balanced |
| Sharp | 80 | More detail |

Changing a quality preset in the toolbar popup reloads the current tab so already-loaded images are processed with the new setting. A custom quality value from **1–100** can be entered under Advanced settings.

### Maximum image width

| Preset | Width |
|---|---:|
| HD | 768 px |
| Full HD | 1024 px |
| No limit | Original size |

Larger images are resized before compression. A custom maximum width can also be entered; `0` means no limit.

## Usage statistics

The Usage section on the settings page reports three counters:

- **Images** — completed requests to the configured proxy. Counted by the service worker via `chrome.webRequest.onCompleted`, matching the configured proxy origin with an encoded `url=` parameter. Only successful (HTTP 2xx) responses count; cached responses are excluded.
- **Proxy bytes** — bytes received from the proxy for those images. The worker reads response headers, preferring `x-bh-compressed-size` (or legacy `x-compressed-size`), then derives the delivered size from `x-original-size` / `x-bytes-saved`, and finally falls back to `Content-Length`. MV3 does not expose response bodies, so a proxy that returns none of these headers reports `0 B`.
- **Data saved** — estimated bytes saved versus fetching the original images directly, from the proxy's `x-bytes-saved` / `x-original-size` headers (or original-minus-received when only the original size is reported).

Initial values are **0**, **0 B** and **0 B**. Statistics are stored locally on the device and can be reset from Settings.

The service worker accumulates deltas and flushes them to `storage.local` in batches (250 ms) instead of writing once per image. Page-side Resource Timing is intentionally **not** used for accounting — the service worker's response-header data is authoritative.

These counters are not a full bandwidth-savings calculation. They describe the data delivered by the configured proxy.

## Architecture

Image interception uses two content scripts injected at `document_start`. Failed proxy image loads automatically fall back to the original image URL so pages do not remain broken:

| Script | Role |
|---|---|
| `prehook.js` | Patches `HTMLImageElement.prototype.src`, `srcset`, `setAttribute`, and `Image()` before the HTML parser runs. This catches JavaScript-created images as early as possible. Also arms the per-image error fallback. |
| `content.js` | Handles parser-created images, `srcset`, lazy `data-*` attributes, preload images, inline `background-image` values, dynamic DOM changes, caching, and navigation cleanup. |

The service worker mirrors `storage.sync` settings to `storage.local` so content scripts can read the current configuration quickly. It also manages CSP response-header rules, the extension icon state, and batched usage-stat updates collected from proxy response headers.

DNR is used for CSP handling only. Image URL rewriting stays in the content scripts because the proxy source URL must be safely `encodeURIComponent`-encoded; DNR regex substitution cannot perform that encoding.

## Project structure

```text
bandwidth-guardian/
├── _locales/en/messages.json   # Extension name and description
├── icons/                      # Active + disabled extension icons
├── content.js                  # Main image rewriter
├── defaults.js                 # Shared default settings (KEEP IN SYNC with inlined copies)
├── manifest.json               # MV3 extension manifest
├── options.html / options.js   # Full settings page
├── popup.html / popup.js       # Toolbar popup
├── prehook.js                  # Early image interception
├── service-worker.js           # DNR, settings mirror, icon, usage stats
├── build.sh                    # Reproducible ZIP builder
├── LICENSE
└── README.md
```

## Repository

**Source:** [github.com/himshim/bandwidth-guardian](https://github.com/himshim/bandwidth-guardian)

**Proxy:** [github.com/anT0ny54/bhp2](https://github.com/anT0ny54/bhp2)

## 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not used in 15 minutes) |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not used in 15 minutes) |

## ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:

- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`

## License

See [`LICENSE`](LICENSE).
