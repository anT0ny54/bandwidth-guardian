# 🛡️ Bandwidth Guardian

> Save mobile data by compressing images through a self-hosted proxy before they load.


Bandwidth Guardian is a Manifest V3 Chrome extension that routes every image through a compression proxy before the browser downloads it. It supports WebP output, grayscale mode, per-site exclusions, and configurable quality and max-width.

Works on **Chrome**, **Kiwi Browser**, **Cromite**, and any Chromium-based browser that supports MV3.

---

## Features

- **WebP / JPEG output** — automatically uses WebP when the browser supports it
- **Grayscale mode** — black-and-white images use significantly less bandwidth
- **Quality presets** — Small / Normal / Sharp, plus a custom 1–100 input
- **Max image width** — downscale oversized images before compressing (HD / Full HD / No limit)
- **Per-site exclusions** — skip domains that shouldn't be proxied
- **Usage stats** — tracks images processed and bytes saved via proxy response headers
- **CSP stripping** — removes Content-Security-Policy headers that would block proxy-served images
- **Proxy-only failure rescue** — when a transformed image fails, the extension first retries through the proxy with a compatibility profile (JPEG, color, no max-width limit). This avoids turning a proxy error into a direct-origin request by default

---

## Installation

### From source (sideload)

1. Clone or download this repository
2. Open `chrome://extensions` (or `kiwi://extensions`)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder
5. Open the extension settings and set your proxy URL

### Reproducible build (zip for Chrome Web Store)

```bash
bash build.sh
# outputs: bandwidth-guardian-*.zip
```

The build script produces a deterministic zip using a fixed timestamp so the output is byte-for-byte reproducible on any machine.

---

## Proxy setup

Bandwidth Guardian requires a compatible compression proxy. The recommended proxy is:

**[bhp2](https://github.com/anT0ny54/bhp2)** — a hardened fork of [bandwidth-hero-proxy2](https://github.com/himshim/bandwidth-hero-proxy2) (private-IP blocking, DNS-rebinding protection, a health-check endpoint). Deploy free on Netlify in one click.

The proxy must:
- Accept `?url=<encoded>&quality=<n>&bw=0or1&jpeg=0or1&max_width=<n>`
- Return `bandwidth-hero-proxy` when called with no `url` parameter (used for URL validation)
- Return `x-bytes-saved` and `x-original-size` response headers for stats tracking

---

## Architecture

Image interception uses two execution worlds at `document_start`:

| Script | World | Role |
|---|---|---|
| `prehook.js` | `MAIN` | Installs synchronous hooks for page JavaScript: `HTMLImageElement.src`, `srcset`, `Element.setAttribute()`, dynamic `<picture><source srcset>`, and image preloads (`<link rel="preload" as="image">`). HTTP URLs are held briefly until settings arrive, so JS-created images do not start as original full-size requests. |
| `shared.js` | `ISOLATED` | Owns the extension-side URL decision/build logic and storage loader. It bridges the current settings to the MAIN-world prehook without exposing `chrome.*` APIs to page code. |
| `content.js` | `ISOLATED` | Handles parser-created `<img>` / `<picture>` markup after settings load, lazy `data-*` attributes, inline CSS backgrounds, dynamic DOM additions, and parser-created image preloads. It also warms the proxy connection with `preconnect` / `dns-prefetch`. |

Chrome documents `ISOLATED` and `MAIN` as separate execution worlds; a prototype patch made in an isolated content-script world does not patch the page's own JavaScript environment. The MAIN-world hook is therefore necessary for true JavaScript-assignment interception. The manifest-level `world: "MAIN"` declaration is supported on Chrome 111+. See the [Chrome content scripts documentation](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts).

Settings are mirrored from `storage.sync` to `storage.local` by the service worker so the isolated scripts can normally load them quickly, with a sync-storage fallback for startup/compatibility edge cases. If the MAIN-world settings bridge times out, held HTTP image URLs are not released directly by default.

DNR is used only to strip CSP headers — image redirection remains in content scripts because MV3 `regexSubstitution` cannot safely URL-encode the captured source URL.

### Important limitations

Parser-created images and preloads can begin loading before the asynchronous storage callback is available. The extension minimizes this window with `document_start`, the local settings mirror, and the synchronous MAIN-world prehook for JavaScript-created resources. It cannot provide the same zero-byte guarantee for every resource emitted directly by the HTML parser because MV3 does not provide a blocking `webRequest` path for this use case.

Some origins reject server-side image fetches with HTTP 403 or otherwise make the proxy request fail even though the image loads normally in the browser. Bandwidth Guardian first retries the generated proxy URL with a compatibility profile (`jpeg=1`, `bw=0`, and no `max_width`) so common transform/format failures can recover without contacting the original host directly. A final direct-origin retry is available as the **Direct fallback** option, but it is disabled by default because that path can expose the origin DNS lookup and request to the browser.

### Privacy / DNS limitation

The extension no longer creates a direct-origin retry by default, and the settings-timeout path no longer releases held HTTP URLs directly. This closes the extension-controlled direct fallback DNS leak while preserving a proxy-only recovery path.

Manifest V3 still does not provide a general blocking `webRequest` path to synchronously rewrite every parser-created image request. Because of that platform limitation, this extension cannot honestly guarantee zero original-host DNS/network visibility for every HTML/CSS resource without using a broad network block that would also break resources the content script cannot safely rewrite (for example some stylesheet background images). The implementation therefore avoids that web-breaking trade-off.

---

## Project structure

```
bandwidth-guardian/
├── _locales/en/messages.json   # Extension name and description (i18n)
├── icons/                      # 16 / 32 / 48 / 128 px, active + disabled
├── shared.js                   # Isolated-world settings + URL logic
├── prehook.js                  # MAIN-world synchronous image/preload hook
├── content.js                  # Isolated-world parser/DOM rewriter
├── defaults.js                 # Defaults for popup.js / options.js (ES module)
├── manifest.json
├── options.html / options.js   # Full settings page
├── popup.html / popup.js       # Toolbar popup
├── service-worker.js           # DNR rules, storage mirror, icon, stats
├── build.sh                    # Reproducible zip builder
├── CHANGELOG.md                # Version history
└── .github/workflows/build.yml # CI: build on main; publish releases on v* tags
```

---

## Contributing

Pull requests are welcome. Please open an issue first for anything beyond a small bug fix.

---

## Credits

Based on [bandwidth-hero](https://github.com/ayastreb/bandwidth-hero) by Anatoliy Yastreb (MIT) and the serverless proxy port [bandwidth-hero-proxy2](https://github.com/himshim/bandwidth-hero-proxy2).

---

## 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dns-pi.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |
| Multi Pro + TIF | `https://dns-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not use in 15 minute) |
| Multi Pro + TIF | `https://doh-93aca.containers.snapdeploy.app/dns-query` (Recommended, but will sleep if not use in 15 minute) |

---

# ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).

## Supporting the Project

If you find this project useful, donations are appreciated:
- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`



## License

MIT — see [LICENSE](LICENSE)
