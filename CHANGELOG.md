# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.5] — current release

### Changed
- Removed a dead bypass-slot assignment; the decision is immutable after the
  capacity check and eviction step.
- Marked `build.sh` executable so the documented `./build.sh` command works
  from a fresh checkout as well as the CI workflow's `bash ./build.sh` call.

### Fixed
- A repeated failure for the same tab-scoped URL could enter a second fallback
  batch while its first DNR bypass update was still pending, causing duplicate
  retry notifications. In-flight reservations now deduplicate those requests
  and are released after the DNR result, so failed updates remain retryable.
- Rapid runtime transitions could complete their asynchronous storage callbacks
  out of order and leave an older redirect state persisted last. Runtime-state
  read/compare/write operations are now serialized, and obsolete queued
  revisions are skipped.
- Closing a tab while its 250 ms fallback batch was queued could leave stale
  retry work available for a later DNR update. Tab teardown now drops that
  tab's queued batch and retry reservations, while preserving the shared timer
  for other tabs and cancelling it when the queue becomes empty.
- A failed conflict URL selected through `<picture><source srcset>` could remain
  stuck on its proxy URL because the `<source>` has no independent error target.
  The MAIN-world retry now maps that proxy candidate back to its original URL
  and restores it through the tab's confirmed DNR bypass. Replacing a picture
  source also clears stale failure state on its parent image.
- Settings changes received from another extension view now update the saved
  quality and width reset baselines even while those fields contain unsaved
  edits. The active edit is left untouched, and clearing it restores the latest
  stored value instead of a stale one.
- Fallback cleanup now remains armed across successful loads on a reused image
  element. Previously, a one-shot `load` listener was removed after the first
  success while its registration marker remained set, leaving later fallback
  timers uncleared.
- Inline style interception now rewrites `url()` references in every
  `style`-attribute declaration, not only `background-image`. This also covers
  conflict-parameter URLs in declarations such as `border-image-source`,
  `list-style-image`, `mask-image` and `cursor`.
- When all three dynamic-rule installation attempts failed, the service worker
  published a guessed fallback state even though Chrome atomically retained the
  previous rules. It now reads the live dynamic rules and publishes the actual
  redirect state; if that inspection also fails, it preserves the last known
  state rather than allowing the DOM layer to make an unsafe interception
  decision.
- A configured proxy base could already contain `url=`, while each proxied URL
  appends its own `url` parameter. This made the proxy target ambiguous. The
  service worker, both DOM interception layers and the options page now reject
  proxy bases containing that reserved query parameter, while allowing other
  query parameters such as access tokens.
- CSS function names are case-insensitive. The stylesheet fallback retry gate
  now recognizes uppercase and mixed-case `URL()` references instead of
  skipping their rules.
- Corrected a duplicated command line in the README browser-test instructions.
- Failed-element markers are now cleared when an image node is reused for a
  different URL, including while a retry is pending. The MAIN-world hook now
  notifies the isolated world to clear its separate fallback state, and
  timer-ownership checks prevent queued stale callbacks from restoring over a
  newer source. The exact failed responsive candidate is recorded, and a failed
  inline CSS URL no longer permanently blacklists its containing element.
- Fallback retries are batched per tab and broadcast to all frames, matching the
  tab-scoped DNR bypass. Invalid/unknown tab IDs are rejected so they cannot
  create a global allow rule. Newly loaded documents receive the complete
  bounded bypass list rather than only its last 1,000 entries.
- The service worker now publishes `redirect: false` when the DNR API is
  unavailable, while preserving circuit-breaker suspension state.
- Private-network exclusions now cover IPv4-mapped private IPv6 addresses and
  the full IPv6 link-local `fe80::/10` range in all three interception layers.

### Changed
- Service worker: merged the duplicate oldest-bypass lookup in the session-rule
  eviction path into a single iterator step; removed the never-read `isRegex`
  bookkeeping field, an always-true `tab >= 0` conditional on tab-scoped bypass
  conditions, and a dead `tabId < 0` guard in the retry broadcast (tab IDs are
  validated before batching reaches it).

### Fixed
- The bypass eviction path read `oldest[0]` on a map that was only non-empty by
  an arithmetic coincidence; an explicit empty-map guard now skips the candidate
  instead of risking a TypeError if the capacity constants ever change.

### Maintenance
- Re-audited every shipped file end to end (manifest, service worker, both DOM
  layers, popup, options, build script): verified cross-layer pattern sync
  (conflict/skip/private-host patterns, proxy-base validation, quality clamp),
  all DOM ids against both HTML pages, and script load order. No changes were
  needed in content.js, prehook.js, popup.js, options.js, popup.html,
  options.html, build.sh, defaults.js or the manifest. `isGuardianProxyUrl`
  gained an origin string-prefix prefilter, avoiding a full `URL` parse for the
  rare non-proxy candidate event. All 38 simulation tests and JavaScript syntax
  checks pass. No version bump.
- Added simulation regressions for element reuse during pending and completed
  retries, stale timeout callbacks, delayed failure-list synchronization,
  unknown-tab bypass protection, cross-frame retry batching, unavailable DNR
  APIs, mapped IPv6 and link-local addresses. Added a real-Chrome regression
  that reuses a failed image node for a new conflict URL, plus simulation
  regressions for repeated load cleanup, non-background inline CSS URL
  declarations, picture-source proxy recovery/re-arming, external settings
  updates while custom quality/width inputs are dirty, overlapping fallback
  batches, tab-close cleanup of queued fallback batches, and out-of-order
  runtime-state storage callbacks.
- Re-audited the complete patch and its runtime dependencies. All 38 simulation
  tests, JavaScript syntax checks and the reproducible build pass. The real-Chrome
  suite remains unexecuted because `playwright-core` is unavailable in this
  environment; its regressions now wait for the actual picture-source requests
  and cover a second source failure after re-arming.
- Updated this existing release entry and README; no version bump.
