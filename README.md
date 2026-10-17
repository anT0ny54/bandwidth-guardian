# 🛡️ Bandwidth Guardian

> Reduce image bandwidth by routing supported image requests through a configurable image-compression proxy.

**Bandwidth Guardian** is a Manifest V3 browser extension for Chromium-based browsers. It rewrites eligible image URLs to a proxy you control, while preserving the original URL as a fallback if the proxied image fails.

The extension is intentionally **proxy-agnostic**: it does not require a built-in third-party image service. You provide the proxy endpoint in Settings.

## Extension at a glance

- Early page-JavaScript interception in the **MAIN world**.
- Extension storage access stays in the **isolated world**.
- A small JSON/DOM-event bridge passes settings from `content.js` to `prehook.js`.
- Page-created images are safely parked until settings are available, then processed.
- No JavaScript objects or `chrome.*` APIs are shared across execution worlds.
- Supports normal images, `srcset`, `<picture>` sources, lazy-loading attributes, image preloads, inline background images, and dynamically inserted elements.
- Automatic per-image fallback to the original URL when a proxy request fails.
- Configurable quality, grayscale, maximum width, and excluded domains.
- Local settings mirror for fast content-script startup.
- Usage statistics collected from proxy response headers by the service worker.
- CSP response-header handling through Declarative Net Request.
- Reproducible deterministic build.

## Important extension architecture fix

Extension fixes the execution-world boundary used by the early interception layer.

`prehook.js` runs in the page's **MAIN world** so page JavaScript can hit its native DOM property hooks. MAIN-world code must not depend on extension APIs such as `chrome.storage` in this design.

The current flow is:

```text
Page JavaScript / HTML parser
          │
          ▼
   prehook.js — MAIN world
   synchronous DOM hooks
          │
          │ settings event (JSON)
          ▼
   content.js — ISOLATED world
   chrome.storage + DOM processing
          │
          ▼
   service-worker.js
   settings mirror / CSP / stats / icon
```

At `document_start`, `prehook.js` installs its hooks synchronously. If settings have not arrived yet, eligible page-created URLs are temporarily parked instead of being allowed to download unprocessed. `content.js` reads the settings and publishes a JSON-serialized settings event; `prehook.js` then applies the configuration and flushes pending work.

The two worlds do **not** exchange JavaScript objects. Proxy-failure state is communicated with the `data-bh-failed` DOM attribute.

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

When a proxied image fails, Guardian restores the original URL. The failure is marked with `data-bh-failed` so the isolated and MAIN-world handlers can coordinate without sharing JavaScript objects.

### Requests that are intentionally skipped

Guardian does not proxy URLs that are not appropriate image candidates, including:

- already-proxied URLs
- configured excluded domains and their subdomains
- favicons
- `.ico` and `.svg` resources
- known advertising/tracking/pixel URL patterns
- invalid or unsupported URLs

This reduces unnecessary proxy traffic and avoids interfering with common browser/site infrastructure.

## Proxy URL format

Set **Proxy URL** in the Options page to an `http://` or `https://` endpoint.

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
| `max_width` | Maximum requested image width; omitted when unlimited |

The proxy is responsible for interpreting these parameters and returning the compressed image. Guardian does not perform image compression inside the browser.

### Proxy connection test

The Options page can test the configured endpoint. A compatible proxy should respond with the text:

```text
bandwidth-hero-proxy
```

when called without a `url` parameter.

## Settings

Fresh-install defaults are:

| Setting | Default |
|---|---:|
| Enabled | `true` |
| Proxy URL | empty — must be configured |
| Quality | `60` |
| Grayscale | `true` |
| Maximum width | `768` px |
| Excluded domains | empty |

### Quality presets

| Preset | Quality |
|---|---:|
| Small | `45` |
| Normal | `60` |
| Sharp | `80` |

A custom quality from `1` to `100` is also supported.

### Maximum width presets

| Preset | Width |
|---|---:|
| HD | `768` px |
| Full HD | `1024` px |
| No limit | `0` / original size |

A custom positive width can also be entered. `0` means no width limit.

### Excluded domains

Enter domains separated by spaces or commas. Exclusions apply to the configured domain and its subdomains.

The toolbar popup can also exclude or re-include the current website.

## Usage statistics

The Options page reports:

- **Images** — completed successful proxy image responses counted by the service worker.
- **Proxy bytes** — estimated bytes delivered by the configured proxy.
- **Data saved** — estimated bytes saved compared with the original image size when the proxy supplies the required size information.

Statistics are collected from `webRequest.onCompleted` response headers. Cached responses are excluded, and only successful HTTP 2xx image responses matching the configured proxy origin are counted.

The service worker understands these header families, preferring the `x-bh-*` names and supporting legacy names:

```text
x-bh-compressed-size   / x-compressed-size
x-bh-original-size     / x-original-size
x-bh-bytes-saved       / x-bytes-saved
```

If compressed size is not provided, `Content-Length` can be used as a fallback. If the proxy does not provide usable size headers, the corresponding statistics may remain `0` or be less complete.

Statistics are stored in `storage.local` and written in batches (750 ms) rather than once for every image response.

### Resetting statistics

Use **Reset statistics** in the Options page. This clears the local counters without changing your extension settings.

## Installation

### Chromium / Kiwi / Cromite

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

The manifest declares Firefox metadata with a minimum Gecko version of 128. The project has not been certified here as a full Firefox release; browser-specific smoke testing should be performed before treating Firefox as a supported production target.

## Build from source

Requirements:

- Bash
- Node.js
- Python 3 (used by build.sh for manifest/version handling)
- standard ZIP tooling

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

For extension, the validated reproducible artifact is:

```text
bandwidth-guardian-*.zip
```

## Runtime architecture

### `prehook.js`

Runs at `document_start` in the **MAIN world**. It installs synchronous native DOM hooks for:

- `HTMLImageElement.prototype.src`
- `HTMLImageElement.prototype.srcset`
- `HTMLImageElement.prototype.loading`
- `HTMLSourceElement.prototype.srcset`
- `HTMLLinkElement.prototype.href`
- `Element.prototype.setAttribute`

It also handles image preloads, pending work, proxy-failure fallback, exclusion checks, and already-proxied detection.

It contains **no executable `chrome.*` extension API dependency**.

### `content.js`

Runs at `document_start` in the extension's **isolated world**. It owns extension storage access and the broader DOM processing layer.

Responsibilities include:

- loading settings from the local mirror with sync fallback;
- publishing settings to `prehook.js` through the JSON event bridge;
- reacting to settings changes;
- parser-created image processing;
- lazy attributes and `data-srcset`;
- responsive `<source>` handling;
- preload handling;
- inline background images;
- dynamic DOM processing;
- rewrite caching and mutation batching;
- navigation cleanup; and
- reading the `data-bh-failed` fallback state.

### `service-worker.js`

Handles:

- `storage.sync` → `storage.local` settings mirroring;
- missing-setting initialization;
- CSP response-header rules through Declarative Net Request;
- enabled/disabled extension icon state;
- proxy response-header statistics; and
- batched local statistics writes.

Image URL rewriting itself is **not** performed with a DNR redirect rule. The content scripts need normal JavaScript URL handling so the original image URL can be safely encoded.

### `popup.js`

Provides quick controls for:

- enabling/disabling Guardian;
- grayscale;
- quality presets; and
- excluding/re-including the current site.

The popup listens for storage changes so its state stays synchronized with the Options page.

### `options.js`

Provides full configuration, proxy connection testing, custom quality/width controls, excluded domains, statistics, and statistics reset.

Proxy URL validation parses the complete URL and accepts only `http:` or `https:` URLs.

## Project structure

```text
bandwidth-guardian/
├── manifest.json
├── defaults.js
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
├── LICENSE
└── README.md
```

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Store settings and local usage statistics |
| `tabs` | Reload tabs after relevant settings changes |
| `declarativeNetRequestWithHostAccess` | Manage CSP response-header handling |
| `webRequest` | Read proxy response headers for usage statistics |
| `<all_urls>` host access | Process eligible images on web pages |

These permissions are required by the current implementation. The extension does not use a remote web service for its own settings or statistics.

## Privacy and data flow

Bandwidth Guardian does not need a central account or analytics server for its core operation.

When an image is proxied, the configured proxy receives the image URL and the compression parameters described above. Therefore, **the proxy operator can see the URLs that are sent through the proxy** and should be trusted accordingly.

Settings are stored through browser extension storage. Usage statistics are stored locally with the extension.

Do not configure a proxy you do not trust for private or sensitive image URLs.

## Compatible proxy

A compatible Bandwidth Hero-style proxy implementation can be used. One example is:

- https://github.com/anT0ny54/bhp2

The proxy must support the request format and response behavior expected by this extension, including the optional statistics headers if accurate usage statistics are desired.

## Validation status — extension 

The extension source/build has been validated with:

- JavaScript syntax checks for shipped scripts;
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

## License

See [`LICENSE`](LICENSE).
