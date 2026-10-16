# 🛡️ Bandwidth Guardian

> Reduce image bandwidth by routing supported image requests through a configurable image-compression proxy.

**Bandwidth Guardian** is a Manifest V3 browser extension for Chromium-based browsers (Chrome 111 or newer, and Chromium derivatives such as Kiwi and Cromite). It rewrites eligible image URLs to a proxy you control, while preserving the original URL as a fallback if the proxied image fails.

The extension is intentionally **proxy-agnostic**: it does not require a built-in third-party image service. You provide the proxy endpoint in Settings.

## Extension at a glance

- Early page-JavaScript interception in the **MAIN world**.
- Extension storage access stays in the **isolated world**.
- A private `MessageChannel` passes settings from `content.js` to `prehook.js`; page scripts can neither read nor spoof them.
- Page-created images are held in memory (not written to the DOM) until settings are available, then processed.
- One shared module (`shared.js`) provides defaults, URL building, srcset parsing, filters and the fallback logic to every context; no JavaScript objects or `chrome.*` APIs are shared across execution worlds.
- Supports normal images, `srcset`, `<picture>` sources, lazy-loading attributes, image preloads, inline background images, and dynamically inserted elements.
- Automatic per-image fallback to the original URL when a proxy request fails **or stalls** — for every path, including lazy-loaded images and `<picture>` sources.
- Configurable quality, grayscale, maximum width, and excluded domains.
- Local settings mirror for fast content-script startup.
- Usage statistics collected from proxy response headers by the service worker.
- CSP response-header handling through Declarative Net Request, active only while a proxy is configured.
- Optional `Save-Data: on` request header for every request, including page navigations.
- Reproducible deterministic build.

## Architecture

`prehook.js` runs in the page's **MAIN world** so page JavaScript can hit its native DOM property hooks. MAIN-world code must not depend on extension APIs such as `chrome.storage` in this design.

The current flow is:

```text
Page JavaScript / HTML parser
          │
          ▼
   shared.js + prehook.js — MAIN world
   synchronous DOM hooks
          ▲
          │ private MessageChannel (settings)
          │
   shared.js + content.js — ISOLATED world
   chrome.storage + DOM processing + stall guard
          │
          ▼
   shared.js + service-worker.js
   settings mirror / DNR rules / stats / icon
```

At `document_start`, `prehook.js` installs its hooks synchronously, and the two layers establish a private `MessageChannel` with a **two-way handshake**: `content.js` posts a handshake carrying a `MessagePort`, and `prehook.js` also posts a settings request of its own. This is required because the injection order of MAIN-world and isolated-world `document_start` scripts is **not guaranteed** (Chromium builds order them differently): whichever script runs first loses its first message on a listener that does not exist yet, so both directions speak until one lands. A transferred `MessagePort` is one-shot, so every retry uses a fresh channel. `prehook.js`'s capture listener takes the first handshake, stops it from reaching page listeners, and removes itself; the accepted port is then acknowledged **over the port itself** (pages cannot read or spoof ports), after which no further bridge messages are honored. Settings (proxy URL, exclusion list) then travel only over that port.

Until settings arrive, eligible page-created URLs are **held in memory** instead of being written to the DOM: nothing downloads, no `about:blank` error events fire, and the patched getters (`img.src`, `img.srcset`, …) return the value the page wrote. Up to 1000 elements are held; beyond that, values pass through unproxied so no image is ever left blank. If settings never arrive, a 5-second watchdog releases everything unproxied.

The two worlds do **not** exchange JavaScript objects. They share a small DOM contract: `data-bh-failed` (proxy failed, never proxy again), `data-bh-orig-srcset` (original `<source>` srcset) and the `bh-proxy-timeout` event.

## Features

### Image interception

Guardian handles eligible image URLs from multiple paths:

- `<img src>`
- `<img srcset>`
- `<source srcset>` inside responsive images
- JavaScript assignments such as `image.src = ...`
- `new Image().src`
- `HTMLImageElement.srcset`
- `HTMLImageElement.loading`
- image-related `setAttribute()` calls
- lazy-loading attributes used by common sites
- `data-srcset`
- `<link rel="preload" as="image">`
- inline CSS `background-image` URLs
- dynamically inserted DOM content

A batched `MutationObserver` handles dynamic changes without continuously scanning the entire document. The general content observer is deliberately not watching `href`, `rel`, or `as`; preload-specific handling is performed by the early MAIN-world prehook where required.

### Automatic fallback

Every image whose `src`, `srcset` or `<picture>` source points at the proxy gets a fallback — whether Guardian built the proxy URL itself, a lazy loader copied a rewritten `data-src` into `src`, or the element was held while settings loaded. When the proxied image fails (`error`) or stalls, Guardian:

1. recovers the original URLs from the proxy URLs themselves (the `url` parameter);
2. restores `src`, `srcset`, and every proxied `<source>` in the parent `<picture>` (from `data-bh-orig-srcset`);
3. marks the element `data-bh-failed`, so neither world proxies it again — later page writes of proxy URLs to it are unwrapped to the original.

A fallback only fires while the proxy is actually involved; if the page later points the element at its own broken URL, Guardian leaves it alone.

**Stall guard.** A slow proxy (cold start, slow upstream) used to leave an image blank for the proxy's whole time budget. `content.js` watches proxied images with an `IntersectionObserver`; once an image is within ~1250 px of the viewport (where the browser actually loads it) and has not finished within **15 seconds**, the original is loaded instead.

### Requests that are intentionally skipped

Guardian does not proxy URLs that are not appropriate image candidates, including:

- already-proxied URLs
- configured excluded domains and their subdomains
- favicons
- `.ico` and `.svg` resources
- known advertising/tracking URL patterns, and `pixel*`/`cleardot*` GIF/JPEG files
- invalid or unsupported URLs

This reduces unnecessary proxy traffic and avoids interfering with common browser/site infrastructure.

## Proxy URL format

Set **Proxy URL** in the Options page to an `http://` or `https://` endpoint — for bhp2, `https://<your-site>.netlify.app/api/index`. Leave it **empty to turn image proxying off**; quality, exclusions and Save-Data can still be saved.

Guardian appends parameters equivalent to:

```text
?url=<encoded-image-url>&jpeg=0&bw=<0|1>&quality=<1-100>&max_width=<pixels>
```

If the proxy URL already contains a query string, Guardian uses `&` instead of `?`.

The source image URL is encoded with `encodeURIComponent()` before being placed in the proxy request.

### Parameter meanings

| Parameter | Meaning |
|---|---|
| `url` | Original image URL, URL-encoded by Guardian |
| `jpeg` | Sent as `0`; the configured proxy can use this to select its non-JPEG/WebP-oriented output path |
| `bw` | `1` when grayscale is enabled, otherwise `0` |
| `quality` | Compression quality from `1` to `100` |
| `max_width` | Maximum requested image width (1–8192); omitted when unlimited |

The proxy is responsible for interpreting these parameters and returning the compressed image. Guardian does not perform image compression inside the browser.

### Proxy connection test

The **Test** button calls the configured endpoint without a `url` parameter. A compatible proxy responds with the text:

```text
bandwidth-hero-proxy
```

It then reads the `health` endpoint next to the proxy URL (for bhp2, `/api/health`) and shows the proxy version and API level, or an error if the proxy's image engine (Sharp) is unavailable. Proxies without a health endpoint are still reported as working.

## Settings

Fresh-install defaults are:

| Setting | Default |
|---|---:|
| Enabled | `true` |
| Proxy URL | empty — proxying is off until configured |
| Quality | `60` |
| Grayscale | `true` |
| Maximum width | `768` px |
| Save-Data header | `true` |
| Excluded domains | empty |

### Quality presets

| Preset | Quality |
|---|---:|
| Small | `45` |
| Normal | `60` |
| Sharp | `80` |

A custom quality from `1` to `100` is also supported. A custom value highlights no preset (in both the popup and the Options page).

### Maximum width presets

| Preset | Width |
|---|---:|
| HD | `768` px |
| Full HD | `1024` px |
| No limit | `0` / original size |

A custom width from `0` to `8192` px can also be entered (bhp2's maximum). `0` means no width limit.

### Excluded domains

Enter domains separated by spaces or commas. Exclusions apply to the configured domain and its subdomains.

The toolbar popup can also exclude or re-include the current website. Excluded sites are never proxied and keep their own CSP; Save-Data is not sent to them or to requests they initiate.

### Applying changes

Popup and Options writes update `storage.sync` and the local settings mirror together, before any reload, so a reloaded page never reads stale settings. Turning Guardian on (or adding a proxy URL) starts proxying new images on open pages immediately; images already on the page, and turning it off, need a reload — the popup shows a reload prompt. An open Options page picks up changes made elsewhere (for example **Exclude this site** in the popup) for every field you have not edited.

### Save-Data

When enabled, `Save-Data: on` is sent with every request type **including top-level page navigations** (DNR rules without an explicit type list skip `main_frame`, so the types are listed explicitly).

### CSP handling

Page `Content-Security-Policy` response headers are removed for pages and frames so proxy-host images are not blocked by `img-src`. This rule is installed **only while proxying is active** (enabled and a valid proxy URL); with no proxy configured — the fresh-install state — no site's CSP is touched. Excluded sites always keep their CSP. `Content-Security-Policy-Report-Only` is never modified.

## Usage statistics

The Options page reports:

- **Images** — completed successful proxy image responses that carry proxy size headers.
- **Proxy bytes** — estimated bytes delivered by the configured proxy.
- **Data saved** — estimated bytes saved compared with the original image size when the proxy supplies the required size information.

Statistics are collected from `webRequest.onCompleted` response headers. Cached responses are excluded, and only successful HTTP 2xx image responses matching the configured proxy origin are counted.

The service worker understands these header families, preferring the `x-bh-*` names and supporting legacy names:

```text
x-bh-compressed-size   / x-compressed-size
x-bh-original-size     / x-original-size
x-bh-bytes-saved       / x-bytes-saved
```

Responses with none of these headers are not counted (for example, a proxy URL pointing at a site root that answers with an HTML page). If only the original size or bytes saved is provided, `Content-Length` is used for the delivered size.

Statistics are kept in memory and written to `storage.local` in 750 ms batches. Image responses that arrive while the service worker is waking (before it has loaded the proxy origin) are queued and counted rather than dropped. Sizes are shown in binary units (KiB, MiB, GiB).

### Resetting statistics

Use **Reset stats** in the Options page. This clears the local counters without changing your extension settings.

## Installation

### Chromium / Kiwi / Cromite

Requires Chrome 111 or newer (`world: "MAIN"` content scripts); the manifest declares `minimum_chrome_version: "111"`.

1. Download or clone the project.
2. Open the browser's extensions page:
   - Chrome: `chrome://extensions`
   - Kiwi: `kiwi://extensions`
   - Chromium-based equivalents may use their normal extensions URL.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the project directory containing `manifest.json`.
6. Open Bandwidth Guardian settings.
7. Enter a compatible image proxy URL.
8. Reload the target page after changing URL-shaping settings if necessary.

### Firefox

Firefox is **not supported**. Firefox does not support `background.service_worker`, and the statistics listener uses the Chromium-only `extraHeaders` option, so the manifest no longer declares Firefox metadata.

## Build from source

Requirements:

- Bash
- Node.js
- Python 3 (used by build.sh for manifest/version handling)
- standard ZIP tooling (`zip` and `unzip`)

Run:

```bash
bash build.sh
```

The build script:

1. reads the version from `manifest.json`;
2. stages only runtime extension files;
3. validates shipped JavaScript with Node syntax checks;
4. checks manifest-referenced files;
5. uses fixed timestamps and deterministic ordering; and
6. produces a deterministic ZIP in `dist/`.

The artifact is `dist/bandwidth-guardian-<version>.zip`.


## Runtime architecture

### `prehook.js`

Runs at `document_start` in the **MAIN world**. It installs synchronous native DOM hooks for:

- `HTMLImageElement.prototype.src`
- `HTMLImageElement.prototype.srcset`
- `HTMLImageElement.prototype.loading`
- `HTMLSourceElement.prototype.srcset`
- `HTMLLinkElement.prototype.href`
- `Element.prototype.setAttribute`

It also handles image preloads, held (pending) work, proxy-failure fallback, exclusion checks, and already-proxied detection. It receives settings only over the private `MessageChannel`.

It contains **no executable `chrome.*` extension API dependency**.

### `shared.js`

The single source of truth for defaults, the 8192 px width cap, the settings comparison, tracking/skip filters, domain-list parsing, proxy-config normalization (`active` = enabled **and** valid proxy URL), proxy-URL building with an LRU cache, original-URL recovery, srcset parsing, the cross-world DOM contract names, and the fallback implementation. It is a classic script loaded before `prehook.js` and `content.js` in their own worlds, via `importScripts` in the service worker, and as a side-effect import in the popup and Options pages. The content scripts capture it and delete the global immediately.

### `content.js`

Runs at `document_start` in the extension's **isolated world**. It owns extension storage access and the broader DOM processing layer.

Responsibilities include:

- loading settings from the local mirror with sync fallback;
- publishing settings to `prehook.js` over the private `MessageChannel` (two-way, race-proof handshake);
- reacting to settings changes (without writing the local mirror — the service worker and the popup/Options pages own it);
- parser-created image processing;
- lazy attributes and `data-srcset`;
- responsive `<source>` handling;
- preload handling;
- inline background images;
- dynamic DOM processing;
- rewrite caching and mutation batching (on overflow — over 2000 queued records — one full rescan replaces the dropped records);
- the stall guard;
- navigation cleanup; and
- arming the fallback for parser-created, already-proxied and `<picture>` images.

### `service-worker.js`

Handles:

- `storage.sync` → `storage.local` settings mirroring;
- missing-setting initialization;
- CSP and Save-Data rules through Declarative Net Request;
- enabled/disabled extension icon state;
- proxy response-header statistics; and
- batched local statistics writes.

Dynamic DNR rules persist, so rules, icon and mirror are refreshed only on install/update, browser startup and settings changes — not on every worker wake. The image-statistics listener is registered for `<all_urls>` at top level because MV3 only wakes a stopped worker for listeners registered synchronously, while the proxy origin is known only after an async storage read; non-proxy URLs are rejected with a single string comparison.

Image URL rewriting itself is **not** performed with a DNR redirect rule. The content scripts need normal JavaScript URL handling so the original image URL can be safely encoded.

### `popup.js`

Provides quick controls for:

- enabling/disabling Guardian (with a reload prompt, and a "No proxy URL set" status when no proxy is configured);
- grayscale;
- quality presets; and
- excluding/re-including the current site.

The popup listens for storage changes so its state stays synchronized with the Options page.

### `options.js`

Provides full configuration, proxy connection testing, custom quality/width controls, excluded domains, statistics, and statistics reset.

Proxy URL validation parses the complete URL and accepts only `http:` or `https:` URLs, or an empty value (proxying off).

## Project structure

```text
bandwidth-guardian/
├── manifest.json
├── shared.js
├── prehook.js
├── content.js
├── service-worker.js
├── popup.html
├── popup.js
├── options.html
├── options.js
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   ├── icon-128.png
│   └── disabled variants
├── _locales/en/messages.json
├── build.sh
├── .github/
│   ├── dependabot.yml
│   └── workflows/build.yml
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Store settings and local usage statistics |
| `tabs` | Read the current tab's site for the popup and reload tabs after relevant settings changes |
| `declarativeNetRequestWithHostAccess` | CSP response-header handling and the Save-Data request header |
| `webRequest` | Read proxy response headers for usage statistics |
| `<all_urls>` host access | Process eligible images on web pages |

These permissions are required by the current implementation. `webRequest` is observe-only (no blocking). The extension does not use a remote web service for its own settings or statistics.

## Privacy and data flow

Bandwidth Guardian does not need a central account or analytics server for its core operation.

When an image is proxied, the configured proxy receives the image URL and the compression parameters described above. Therefore, **the proxy operator can see the URLs that are sent through the proxy** and should be trusted accordingly.

Settings are stored through browser extension storage. Usage statistics are stored locally with the extension. Web pages cannot read your settings: they reach the page-world script only over a private message channel.

Do not configure a proxy you do not trust for private or sensitive image URLs.

## Compatible proxy

A compatible Bandwidth Hero-style proxy implementation can be used. One example is:

- https://github.com/anT0ny54/bhp2

The proxy must support the request format and response behavior expected by this extension, including the optional statistics headers if accurate usage statistics are desired.

## Validation status — extension 

The extension source/build has been validated with:

- JavaScript syntax checks for shipped scripts;
- logic checks of `shared.js`, `prehook.js`, `content.js` and `service-worker.js` against minimal DOM/`chrome.*` stubs (held elements, fallback paths, picture sources, stall guard, settings bridge, DNR rule contents, statistics);
- a two-world integration test of the settings bridge under BOTH injection orders (MAIN-world first and isolated-world first), including the disabled case;
- ZIP integrity validation;
- reproducible build verification; and
- manifest/runtime-file consistency checks.

The validation confirms the extension code/build paths described above.

**Real-browser smoke testing remains a separate qualification step.** A full Chrome + Kiwi/Cromite device test should verify actual page JavaScript interception, proxy requests, failed-image fallback, CSP behavior, statistics, and browser-specific behavior before calling the release fully field-tested.

## Repository

Source repository:

https://github.com/anT0ny54/bandwidth-guardian

Proxy example:

https://github.com/anT0ny54/bhp2

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
