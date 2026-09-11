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

---

## Installation

### From source (sideload)

**BHP2 backend:** this extension is compatible with [anT0ny54/bhp2](https://github.com/anT0ny54/bhp2). **No proxy is configured by default**. Set the proxy to your deployed BHP2 `/api` endpoint, for example `https://your-site.netlify.app/api`. The extension also accepts a bare Netlify site URL and normalizes it to `/api`.

1. Clone or download this repository
2. Open `chrome://extensions` (or `kiwi://extensions`)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the repo folder
5. Open the extension settings and set your proxy URL

### Reproducible build (zip for Chrome Web Store)

```bash
bash build.sh
# outputs: bandwidth-guardian-0.0.1.zip
```

The build script produces a deterministic zip using a fixed timestamp so the output is byte-for-byte reproducible on any machine.

---

## Proxy setup

Bandwidth Guardian requires a compatible compression proxy. The recommended proxy is:

**[BHP2 / bandwidth-hero-proxy2](https://github.com/anT0ny54/bhp2)** — deploy free on Netlify in one click.

The proxy must:
- Accept `?url=<encoded>&quality=<n>&bw=0or1&jpeg=0or1&max_width=<n>`
- Return `bandwidth-hero-proxy` when called with no `url` parameter (used for URL validation)
- Return `x-bytes-saved` and `x-original-size` response headers for stats tracking

---

## Architecture

Image interception uses two content scripts injected at `document_start`:

| Script | Role |
|---|---|
| `prehook.js` | Patches `HTMLImageElement.prototype.src`, `srcset`, `setAttribute`, and `Image()` before the HTML parser runs. Catches all JS-set images with zero wasted bytes. |
| `content.js` | Rewrites HTML-parsed `<img src>`, srcset, lazy `data-*` attributes, and inline `background-image` after settings load. Also injects `<link rel="preconnect">` to warm the proxy connection. |

Settings are mirrored from `storage.sync` to `storage.local` by the service worker so content scripts can read them in ~5 ms instead of ~30–80 ms.

DNR is used only to strip CSP headers — image redirection is done in content scripts because Chrome's `regexSubstitution` cannot `encodeURIComponent`, which breaks any image URL containing query parameters.

---

## Project structure

```
bandwidth-guardian/
├── _locales/en/messages.json   # Extension name and description (i18n)
├── icons/                      # 16 / 32 / 48 / 128 px, active + disabled
├── content.js                  # Layer 2 image rewriter
├── defaults.js                 # Single source of truth for default settings
├── manifest.json
├── options.html / options.js   # Full settings page
├── popup.html / popup.js       # Toolbar popup
├── prehook.js                  # Layer 1 prototype patcher
├── service-worker.js           # DNR rules, storage mirror, icon, stats
├── build.sh                    # Reproducible zip builder
└── .github/workflows/build.yml # CI: build + attach zip to every release tag
```

---

## Contributing

Pull requests are welcome. Please open an issue first for anything beyond a small bug fix.

---

## Credits

Based on [bandwidth-hero](https://github.com/ayastreb/bandwidth-hero) by Anatoliy Yastreb (MIT) and the serverless proxy port [bandwidth-hero-proxy2](https://github.com/himshim/bandwidth-hero-proxy2).

---

## License

MIT — see [LICENSE](LICENSE)


## 🌐 Free DNS Services

High-performance DNS utilizing HaGeZi Blocklists (Multi Pro + TIF).

| Blocklist | DNS-over-HTTPS (DoH) |
| :--- | :--- |
| Multi Pro + TIF | `https://freedns.koyeb.app/dns-query` (Recommended) |
| Multi Pro + TIF | `https://freedns-six.vercel.app/api/doh/dns-query` (Recommended) |
| Multi Pro + TIF | `https://dnssix.netlify.app/api/doh/dns-query` |

---

# ⚡ Bandwidth Hero Server

A lightweight image optimization proxy designed to slash bandwidth usage and accelerate web browsing.

Bandwidth Hero Server fetches remote images, compresses them on the fly, and delivers optimized versions to the client. This significantly reduces data consumption while improving page load performance.

🖥️ **Live Demo:** [Bandwidth Hero](https://bhserv.netlify.app/).


# ⚡ User Script Bandwidth Hero

This alternative Bandwidth Guardian extension.
Run User Script Bandwidth Hero Proxy for [Violentmonkey](https://violentmonkey.github.io/) and [Tampermonkey](https://www.tampermonkey.net/). Download [UserScript Bandwidth Hero](https://github.com/anT0ny54/Legacy-bromite-adblocklist/raw/main/BandwidthHero.zip).


## Supporting the Project

If you find this project useful, donations are appreciated:
- **Bitcoin**: `1HntwKxyqGCfnSGvGLMUTRAqLnTvLarAQP`
  
