# Changelog

## [0.1.8] — 2026-10-17

### Security
- **B1** CSP is no longer stripped when no proxy is configured (a fresh install
  previously removed `Content-Security-Policy` from every page for no benefit);
  the CSP rule also only fires on documents whose CSP references `img-src` /
  `default-src` (Chrome 128+ DNR response-header matching, with a fallback),
  and `content-security-policy-report-only` is left intact.
- **B5** The error fallback now restores the original URL only when the URL
  that actually failed is a proxy URL; a successful `load` disarms the
  fallback, and the two worlds (prehook/content) dedupe restores via a shared
  attribute — no more stale "original" restores or double fetches.
- **B12** Removed the GPL-licensed Save-Data derivation and its nonexistent
  `LICENSE-GPL-3.0` reference; the Save-Data DNR rule is original code.
- **O7** Prehook settings now travel on a per-load random event name (with a
  one-time channel handshake) and only the required fields are published.

### Fixed
- **B2** The options page listens to sync storage changes: popup exclusions
  and toggles are no longer overwritten by a stale Settings "Save"; fields with
  unsaved edits are protected by dirty-tracking.
- **B3** The proxy URL can be cleared, and quality/width/exclusions can be
  saved without entering a proxy URL.
- **B4** The service worker is now the sole writer of the `bhOpts` mirror;
  content scripts write it only on the cold path. Eliminates the O(tabs ×
  frames) write/event storm and the stale-mirror clobber.
- **B6** Pending elements are no longer assigned `about:blank` (no fake `error`
  events, no bogus `img.src` readbacks); pending preload links get
  `removeAttribute("href")` instead.
- **B7** `flushPending` honors `enabled`/empty proxy for srcset and arms
  fallbacks for queued values.
- **B8** Stats and the crash-recovery mirror are committed in one atomic
  write; startup recovery merges both keys atomically instead of racing a
  newer mirror.
- **B9** Stats events arriving before the proxy origin is loaded are queued
  and replayed, instead of silently dropped after every worker wake.
- **B10 / platform** Firefox support removed — Chrome/Chromium only (MV3
  `background.service_worker` and DNR response-header matching are
  Chromium-only). `extraHeaders` dropped from the webRequest listener (O3).
- **B11** CI release jobs are concurrency-guarded and skip (never clobber) an
  existing release; the manifest version must be bumped to publish.
- **B13** `TRACKING_RE` anchored with real boundaries: no more matching
  `facebook.com/tracy.jpg` or `/products/pagead-banner.jpg`; useless `(…)+`
  quantifiers removed.
- **B14** Settings reloads the tab that opened it (`?tab=<id>` from the popup)
  instead of an arbitrary recently-used tab.
- **B15/O6** The mutation queue checks its limit before pushing; on overflow a
  full `rewriteAll()` rescan recovers instead of silently dropping images.
- **B16** Quality highlighting is exact-match in both UIs, with a visible
  "Custom" badge when no preset matches.
- **B17** The popup says "No proxy configured" when `proxyBase` is empty.
- **B18** The proxy Test button clears its timeout in a `finally`; the error
  message no longer blames CORS (extension pages aren't CORS-restricted).
- **B19** Enter in the excluded-domains textarea inserts a newline instead of
  saving.
- **B20** The popup guards `chrome.tabs.create` for builds that don't return a
  promise.
- **B21** Removing an exclusion preserves the user's original formatting and
  separators.
- **C2** Proxy-URL identity is origin-based in both content scripts and the
  service worker.
- **C5** The Save-Data rule's behavior when compression is disabled is
  documented.
- **C7** `build.yml` and `Keep-Alive.yml` now use the same checkout version
  (`@v5`).
- **R12** The keep-alive workflow's impossible `git diff --cached --quiet`
  guard (the timestamp always changes) is removed.

### Removed (dead/redundant code)
- **R1** Lazy-attribute pre-proxying (`rewriteLazy`, `LAZY_ATTRS`,
  `dataSrcsetCache`, `NON_IMAGE_EXT_RE`, `IMAGE_LAZY_TAGS`): prehook already
  intercepts the MAIN-world assignments; pre-proxying broke templated URLs and
  left images without a fallback.
- **R2** `rewritePreload` in content.js — prehook's observer handles
  parser-created preload links.
- **R3/R4** Dead `sameOpts` and full `defaults` copy in prehook.
- **R5–R9** Simplified redundant checks, single URL parse per candidate, single
  collection-clear per flush, origin comparison without re-parsing.
- **R13** This changelog was empty; now it isn't.

### Changed
- **O1** Idle short-circuit: with the extension disabled, no proxy, or an
  excluded page, content.js disconnects its observer and prehook short-circuits
  — pages pay nothing.
- **O2** The `statsPending` crash mirror is throttled to at most one write per
  second instead of one per image.
- **O3** The webRequest listener is narrowed to the configured proxy origin and
  re-registered when `proxyBase` changes.
- **O5/C1** Prehook attribute observation is limited to `rel`/`as` on `<link>`
  elements; document-wide `href` watching is gone.
- **O9** Manifest hardening: `minimum_chrome_version: 128`,
  `match_about_blank` + `match_origin_as_fallback` on both content scripts, and
  legacy DNR rule ID 1 stays in `removeRuleIds` for very old installs.
- **O10** `build.sh` syntax-checks classic scripts as `.cjs` (module rules
  would wrongly allow top-level await in the classic SW), validates the
  manifest, and normalizes file modes for reproducible zips; CI passes the
  version between jobs and never clobbers an existing release.
- **Strict image types** Stats (and "was this an image") are strictly limited
  to detected types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`,
  `image/tiff`, `image/jxl`.

### Added
- CHANGELOG.md filled in; README corrected (saveData default, "Reset stats",
  build order, Chrome-only support, strict image types, `Keep-Alive.yml`
  checkout-version note).
