# Changelog

All notable changes to Bandwidth Guardian are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

---

## [0.0.4] — 2026-09-15

### Fixed
- **`<picture><source srcset>` elements set via JavaScript before settings
  finished loading could end up with no image at all.** `prehook.js`
  patches `HTMLSourceElement.prototype.srcset` and `Element.setAttribute`
  separately from the `<img>` versions, but only the `<img>` paths queued
  the element in `pending` for `flushPending()` to revisit once options
  arrived:
  - The `srcset` **property** setter on `<source>` just stored the pending
    value on `dataset` and returned — the native setter was never called,
    so the attribute stayed empty forever. The `<picture>` fell back to
    whatever the browser could infer, often nothing.
  - The `setAttribute("srcset", …)` path on `<source>` did the opposite:
    it wrote the **original, unproxied** URL immediately (so the original
    image downloaded uncompressed) and, like the property path, never
    added the element to `pending`, so it was never corrected.

  Both paths now blank the attribute and queue the element exactly like
  `<img>` does, and `flushPending()` dispatches to the correct native
  setter (`HTMLSourceElement` vs `HTMLImageElement`) by tag name instead
  of always calling the `<img>` one — calling an `<img>` accessor on a
  `<source>` element throws `TypeError: Illegal invocation`, which was
  being silently swallowed by the surrounding `try/catch`.
- **`content.js` could throw on `<source>` elements that aren't part of a
  `<picture>`.** The `<source>` tag is reused by `<audio>`/`<video>` for
  media files with a `src` attribute that isn't an image URL. The
  `MutationObserver` scan uses a broad `"img, source"` selector, so a
  dynamically-inserted `<video><source src="clip.mp4"></video>` reached
  `rewriteImg()`, which called `HTMLImageElement`'s native `src` setter on
  it — an illegal invocation with no surrounding `try/catch`. Rewriting
  `src` is now restricted to actual `<img>` elements, `srcset` rewriting
  is restricted to `<source>` elements whose parent is a `<picture>`, and
  the remaining native-setter call is wrapped in `try/catch` as a safety
  net against any other unexpected element shape.

### Housekeeping
- Bumped `manifest.json` version to `0.0.4`.
- Synced `README.md`'s version badge and build-output example.

---

## [0.0.3] — 2026-09-15

### Fixed
- **`prehook.js` didn't filter tracking pixels.** Only `content.js` (Layer 2,
  HTML-parsed `<img>`) applied `TRACKING_PATTERNS` and the `.ico`/`.svg`/
  favicon skips. `prehook.js` (Layer 1, which patches `HTMLImageElement.src`
  and runs *before* `content.js` ever sees the element) had no such filter,
  so any tracking pixel set the classic way — `new Image().src = "..."` —
  was proxied anyway, unconditionally. Ported the same pattern list into
  `prehook.js` as a shared `shouldSkipUrl()` check used by `decideSrc()`,
  `rewriteSrcset()`, and `flushPending()`, so both layers now agree on what
  to skip.
- **Overly narrow tracking-pixel regex.** `/(pixel|cleardot)\.*\.(gif|jpg|jpeg)/i`
  used an escaped, repeated literal dot (`\.*`) between the keyword and the
  extension, which only matched exact strings like `pixel.gif` — it missed
  realistic paths such as `tracking-pixel-123.gif`. Changed to
  `[^/]*` so any filename characters in between are matched.

### Changed
- **Default max image width: 1920px → 1280px.** Lower default bandwidth
  footprint out of the box; users who want full-HD images can still pick the
  1920 preset.
- **Default excluded domains** now include `challenges.cloudflare.com`
  alongside `google.com` and `gstatic.com` — proxying Cloudflare Turnstile's
  challenge images breaks the widget, same reasoning as the existing
  reCAPTCHA exclusions.
- **Settings page footer version** is now read from `chrome.runtime.getManifest().version`
  instead of a hardcoded string in `options.html`, so it can't drift from
  `manifest.json` again.
- **"Need a proxy?" and "Source" links** in Settings now point at this
  fork (`anT0ny54/bhp2` and `anT0ny54/bandwidth-guardian`) instead of the
  upstream `himshim` repos.

### Verified (no code changes required)
- Confirmed the tracking-pixel filter is not redundant with `excludeDomains`:
  the default exclusion list only covers two exact hostnames, while
  `TRACKING_PATTERNS` catches ad/analytics *paths* across many different
  domains (`doubleclick.net`, `google-analytics.com`, `facebook.com`,
  `criteo.net`, etc.) that aren't in that list. Removing it would route ad
  beacon requests through the user's own proxy for no bandwidth benefit.

### Housekeeping
- Bumped `manifest.json` version to `0.0.3`.
- Synced `README.md`'s version badge, build-output example, and proxy
  recommendation.

---

## [0.0.2] — 2026-09-15

### Fixed
- **Icon update crash on some Chromium forks.** `updateIcon()` called
  `chrome.action.setIcon(...).catch?.()` directly on the return value.
  `chrome.action.setIcon` returns a `Promise` on modern Chrome, but older
  Kiwi/Cromite builds implement it as callback-only and return `undefined`
  — chaining `.catch` onto that throws a `TypeError` before the optional
  chaining operator gets a chance to help. The icon (enabled/disabled state)
  now updates safely on every supported browser: the return value is
  checked for a `.then` before it's ever touched.

### Removed
- **Dead code in `service-worker.js`.** `hostnameOf()` and `parseDomains()`
  were left over from an earlier version of the exclusion-list logic and
  were never called — domain parsing for the exclude list already happens
  client-side in `popup.js` and `options.js`. Removed both functions and
  the now-empty `Helpers` section.

### Verified (no code changes required)
- Confirmed query-parameter compatibility with both proxy variants
  referenced in project docs:
  - [`himshim/bandwidth-hero-proxy2`](https://github.com/himshim/bandwidth-hero-proxy2)
  - [`anT0ny54/bhp2`](https://github.com/anT0ny54/bhp2) (a fork of the above
    with extra hardening — private-IP blocking, DNS-rebinding protection,
    a health-check endpoint)

  Both accept the same `url` / `jpeg` / `bw` / `quality` / `max_width`
  parameters this extension already sends from `prehook.js` and
  `content.js` — no request-format changes were needed.
- Re-checked the two-layer interception design (`prehook.js` +
  `content.js`), the `storage.local` "bhOpts" mirror for fast reads, and
  the DNR CSP-stripping rule against current MV3 behavior on Chromium-based
  Android browsers (Kiwi Browser, Cromite). All still correct; no
  regressions found.

### Housekeeping
- Bumped `manifest.json` version to `0.0.2`.
- Synced the version string shown in the Settings page footer and the
  README version badge with `manifest.json`.

---

## [0.0.1] — 2024-03-08

Initial Manifest V3 release.

### Added
- Two-layer image interception:
  - `prehook.js` (`document_start`, synchronous) — patches
    `HTMLImageElement.prototype.src` / `srcset`, `Element.setAttribute`,
    and `Image()` before the HTML parser runs, so JS-set images are
    proxied with zero wasted bytes.
  - `content.js` (`document_start`, async after settings load) —
    rewrites HTML-parsed `<img src>` / `<source srcset>`, lazy-load
    `data-*` attributes, and inline `background-image`, plus a
    `MutationObserver` for infinite-scroll / SPA content.
- `storage.sync` → `storage.local` settings mirror (written by the
  service worker) so content scripts read options in ~5 ms instead of
  ~30–80 ms, minimizing the window where an original image could start
  downloading before it's caught.
- WebP-support auto-detection at install/startup, used to decide the
  `jpeg=` proxy parameter.
- Declarative Net Request rule to strip `Content-Security-Policy` /
  `-Report-Only` headers on `main_frame`/`sub_frame` responses so
  proxy-served images aren't blocked by the original page's CSP.
- Usage stats (images processed, bytes saved) read from the proxy's
  `x-bytes-saved` / `x-original-size` response headers via a
  non-blocking `webRequest.onCompleted` observer.
- Per-site exclusions, grayscale toggle, quality presets (Small / Normal
  / Sharp + custom 1–100), and max-width presets (HD / Full HD / no
  limit) — popup and full Settings page.
- Tracking-pixel URL filtering ported from the original
  `bandwidth-hero` project's `shouldCompress.js`.
- `<link rel="preconnect">` / `dns-prefetch` injection to the proxy
  origin to hide TLS handshake latency behind HTML parsing.
- Reproducible build script (`build.sh`) with a fixed timestamp so the
  Chrome Web Store zip is byte-for-byte reproducible.
- Verified working on Chrome, Kiwi Browser, and Cromite (Android).

### Known limitation (by design)
- Rule-based (DNR `regexSubstitution`) image redirection was evaluated
  and rejected: Chrome's DNR cannot `encodeURIComponent` the captured
  URL, so any image URL containing its own query string (e.g.
  `?auto=webp&width=1092`) produces a malformed proxy request. Image
  rewriting is done in content scripts instead, which can encode
  correctly. DNR is used only for the CSP-header rule, which needs no
  encoding.
