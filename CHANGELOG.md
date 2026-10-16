# Changelog

All notable changes to Bandwidth Guardian are documented here. The project
uses [Semantic Versioning](https://semver.org/).

## [0.1.8] - 2026-10-17

Requires Chrome 111 or newer. Pairs with bhp2 2.2.21 (works with any
Bandwidth Hero-compatible proxy).

### Security

- **CSP is no longer removed when no proxy is configured.** The CSP rule was
  installed whenever Guardian was enabled. Fresh installs, and **Reset
  defaults**, have an empty proxy URL, so every site's
  `Content-Security-Policy` was removed while nothing was being proxied. The
  rule is now installed only while proxying is active (enabled and a valid
  proxy URL), and it is refreshed when the proxy URL changes.
  `Content-Security-Policy-Report-Only` is no longer touched, because it
  never blocks anything.
- **Pages can no longer read or spoof settings.** Settings used to be sent
  to `prehook.js` as a `bh-settings-update` DOM event that any page could
  listen to (exposing the proxy URL and the excluded-domains list) or
  dispatch itself. They now travel over a private `MessageChannel`. The
  handshake is two-way (either world's startup message can be the one that
  lands, because cross-world injection order is not guaranteed), is accepted
  once, is acknowledged over the port itself so pages cannot spoof the
  acknowledgment, and is hidden from page listeners.

### Fixed

- **Proxy configured but nothing was proxied (0.1.8 regression).** Settings
  reached `prehook.js` over a `MessagePort` handed over in a one-shot
  handshake posted synchronously at `document_start`. The injection order of
  MAIN-world and isolated-world `document_start` scripts is not guaranteed
  (Chromium builds order them differently); when the isolated-world script
  ran first, the handshake fired before `prehook.js` registered its listener
  and was lost. `prehook.js` then stayed without settings until the
  5-second watchdog, after which every JavaScript-assigned image
  (`img.src`, `new Image()`, framework hydration) loaded unproxied. In
  0.1.7 the settings event was dispatched asynchronously after the storage
  read, so both listeners were always registered in time. The handshake is
  now two-way: `prehook.js` also posts a settings request, and `content.js`
  answers requests with a fresh port (a transferred port is one-shot) until
  the accepted port is acknowledged over the port itself. At least one
  direction always lands, under every injection order, before any page
  script runs. Verified with a two-world integration test in both orders.
- **Queued `srcset` was proxied while disabled.** A `srcset` set before
  settings arrived was always proxied, even with Guardian turned off.
- **Lazy-loaded images had no fallback.** `data-src` is rewritten to a proxy
  URL, so when a lazy loader copied it into `src` the value was "already
  proxied" and no fallback was attached. A failing proxy left these images
  broken on most lazy-loading sites. A fallback is now attached whenever the
  final value is a proxy URL.
- **Queued images had no fallback.** Images released after settings arrived
  are now covered.
- **Failed elements were proxied again.** The `srcset` setters and
  `setAttribute("srcset")` ignored `data-bh-failed`, so a failing proxy was
  retried on every re-render. Failed elements, and elements on disabled
  pages, now also have proxy URLs that a page writes into them turned back
  into the original URL.
- **`<picture>` sources had no fallback.** The original `<source srcset>` is
  now kept in `data-bh-orig-srcset`. When the `<img>` fails, every proxied
  source in its `<picture>` is restored, so the browser does not pick the
  broken proxied source again.
- **Images could stay blank forever.** Once 1000 elements were waiting for
  settings, further elements were already set to `about:blank` and never
  restored. They now load their original URL straight away.
- **No more `about:blank` while settings load.** Waiting `src`/`srcset`
  values are held in memory instead of being swapped for `about:blank`.
  Pages no longer get spurious `error` events, and `img.src` reads back the
  value the page wrote. Preload `<link>` elements still use `about:blank`,
  because the parser has already set their `href`.
- **Slow proxies left images blank.** A new stall guard loads the original
  when a proxied image near the viewport has not finished within 15 seconds.
- **Save-Data was not sent on page navigations.** A DNR rule without
  `resourceTypes` matches everything except `main_frame`. The types are now
  listed explicitly.
- **Proxying stopped when the local settings mirror went stale (0.1.8
  regression).** `content.js` and the service worker read a `storage.local`
  mirror before `storage.sync`. The mirror was refreshed only when the MV3
  service worker observed a `storage.onChanged` event; on browsers where that
  wake-up is not reliable, the mirror kept old values (for example an empty
  proxy URL), so pages loaded unproxied and statistics stayed at zero. v0.1.7
  read `storage.sync` directly, which is why it kept working there. The mirror
  is now only a fast first paint: both layers reconcile against
  `chrome.storage.sync` (authoritative) on startup and rewrite the mirror, so
  a stale mirror self-heals within milliseconds. Verified with a stale-mirror
  integration test: proxying and grayscale (`bw=1`) are applied from sync.
- **The stat for the event that woke the service worker was lost.** Image
  responses that arrive before the proxy origin has loaded are now queued and
  counted.
- **HTML responses were counted as images.** Only responses that carry
  `x-bh-*` (or legacy) size headers are counted. A proxy URL pointing at a
  site root, which Netlify answers with HTML, is no longer counted.
- **Pending stats could be lost.** The batched stats delta used to be
  cleared before it was committed to storage.
- **Options page overwrote changes made in the popup.** The Options page now
  follows `storage.sync` and updates every field you have not edited. For
  example, a site excluded from the popup no longer disappears on the next
  **Save**.
- **Stale settings after a reload.** Popup and Options now write
  `storage.sync` and the local mirror together before reloading, so the
  reloaded page cannot read old settings.
- **Turning Guardian on or adding a proxy took effect only after a reload.**
  Open pages now start processing straight away. The popup also shows the
  reload prompt when the enable toggle changes.
- **Mutation overflow missed images.** Past 2000 queued mutation records,
  records were silently dropped. A single full rescan now replaces them.
- **Tracking filter.** `(?:pixel|cleardot)\.*\.(?:gif|jpg|jpeg)` only ever
  matched `pixel.gif`. It now matches `pixel*` and `cleardot*` GIF/JPEG file
  names, without catching hosts such as `pixel-cdn.example`.
- **Wrong preset highlighted for custom quality.** The popup highlighted the
  nearest preset for a custom quality such as 55. Like the Options page, it
  now highlights none.

### Changed

- **`shared.js` replaces `defaults.js` and four "KEEP IN SYNC" copies.**
  `prehook.js`, `content.js`, `service-worker.js`, popup and options now
  share one copy of the following:
  - defaults
  - settings comparison
  - filters
  - domain parsing
  - proxy-config normalization
  - proxy-URL building
  - srcset parsing
  - the fallback

  It is listed first in both `content_scripts` entries (each world gets its
  own copy), loaded with `importScripts` in the classic service worker, and
  imported by the popup and options pages.
- **Lighter service worker.** Dynamic DNR rules persist, so rules, icon and
  mirror are refreshed only on install/update, `runtime.onStartup` and
  settings changes, not on every wake. The worker wakes for every image
  request.
  - **Statistics:** the per-image `statsPending` storage write is gone (an
    old value is folded in once), and non-proxy URLs are rejected with a
    single string comparison.
  - **Kept as is:** the `<all_urls>` listener stays, because MV3 only wakes
    the worker for listeners registered synchronously at top level. This is
    documented in the code.
- **Content scripts no longer write the settings mirror on every change.**
  With N tabs that meant N extra writes per change, each one fanning out to
  every tab. The service worker, popup and options pages own the mirror.
- **Options page:**
  - **Proxy URL:** may be left empty to turn proxying off.
  - **Custom width:** capped at 8192 px, matching bhp2.
  - **Test:** also reads the proxy's `/api/health` and shows version, API
    level and Sharp status.
  - **Sizes:** use KiB/MiB/GiB labels.
- **Popup:** shows "No proxy URL set" when enabled without a proxy.
- **Manifest:**
  - `minimum_chrome_version: "111"`, which `world: "MAIN"` requires.
  - Version 0.1.8.
- **Release workflow:** an existing `v<version>` release is no longer
  modified. `--clobber` used to pair an old tag with a zip built from newer
  code. Bump the manifest version to publish.
- **Dependabot:** added for GitHub Actions (weekly).
- **Save-Data rule:** rewritten for this project. The previous GPL-3.0
  attribution and the reference to a `LICENSE-GPL-3.0` file that did not
  exist were removed. The repository is MIT-licensed.

### Removed

- `defaults.js`, replaced by `shared.js`.
- Firefox metadata (`browser_specific_settings`). Firefox does not support
  `background.service_worker`, and the stats listener uses the Chromium-only
  `extraHeaders`, so the manifest could not load there.
- Stale comments, such as "KEEP IN SYNC with bandwidth-saver" and the
  description of the style-attribute scan.

### Housekeeping

- **`shared.js`: dropped the redundant `+` quantifiers in `TRACKING_RE`.**
  The filter is always used with an unanchored `.test()` search, so a
  repeated alternation group could never extend a match — the quantifiers
  only added backtracking overhead. Matching behavior is unchanged.
