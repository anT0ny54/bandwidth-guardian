# Changelog

## 0.1.11

Full read-through of every shipped and test file (service worker, prehook,
content script, popup, options, manifest, build/CI, tests, README). Findings
that were fixed are below; findings that were reviewed and deliberately left
alone are listed under "Reviewed, not changed".

### Fixed

- service-worker.js: a failed `storage.sync.get` inside `doRefreshRules()`
  handed `undefined` to `buildRules()`, which threw inside the callback. `done`
  never ran, so `refreshing` stayed `true` for the life of the worker and **no
  later settings change could rebuild the DNR rules** (the same failure class
  as the 0.1.10 stats-flush fix). A failed read now keeps the installed rules and
  releases the lock; a throwing `buildRules()` installs an empty rule set (no
  redirect, no CSP strip) instead of wedging the lock.
- service-worker.js: the other storage callbacks (`mirrorToLocal`, `updateIcon`,
  `publishRuntime`) dereferenced their result without a guard and threw on a
  failed read; they now bail out or use optional chaining.
- Quality handling disagreed between layers: a non-numeric or empty quality made
  the DNR redirect emit `quality=NaN`, while prehook (the value had gone through
  JSON, `NaN` → `null`) silently used 60. All three layers now share one
  `normQuality()` (clamp to 1–100, missing/non-numeric → default), pinned by a
  test so the copies cannot drift.
- popup.js: a failed quality save left `state.quality` already updated, so the
  "unchanged" early-return swallowed the retry the error message asked for. The
  enabled/grayscale switches also kept showing the unsaved value. State is now
  updated only after a successful write and the switches revert on failure.
- options.js: the enabled/grayscale/save-data switches stayed in the new
  position when saving failed ("Save failed" toast, nothing persisted); they now
  revert. The "enabled" toast now carries the same "reload the page to apply"
  hint as the grayscale toast and the popup.
- options.js: a proxy URL saved with a `#fragment` made the DOM layers build
  `…#frag?url=…` (every parameter ends up in the fragment) while the service
  worker stripped it, so the layers produced different requests. The fragment
  is now stripped on save and the field shows the stored value.

### Changed

- tests: `redirectSubstitution` test sandbox updated for `normQuality`; three new
  regression tests — `normQuality` equivalence across the three files,
  `content.js` `DEFAULTS` vs `defaults.js` drift guard (previously only
  commented "KEEP IN SYNC"), and the refresh-lock release on a failed storage
  read / throwing `buildRules`. The quality and lock tests fail on 0.1.10.
- options.js: the zero-statistics literal that appeared three times is one
  `ZERO_STATS` constant.
- manifest.json: version bumped to `0.1.11` (the manifest is the release
  source of truth).

### Removed

- content.js: dead fallback branches in `publishPrehookSettings()` — it is only
  called from `applyOpts()` right after `updateProxyConfig()`, so `proxyConfig`
  is never null there; quality/maxWidth are read from it directly.
- prehook.js: the unused `return true` of `queuePending()` (no caller reads it).

### Reviewed, not changed

These were found while reading and are intentionally left for a maintainer
decision or a browser-verified follow-up:

- Save-Data rule (`RULE_ID_SAVE_DATA`) sets no `resourceTypes`. Chrome's DNR
  default for a rule without `resourceTypes` is every type **except
  `main_frame`**, so the header is probably not attached to top-level
  navigations (the CSP rule lists `main_frame` explicitly). Not verified in a
  browser here; adding `main_frame` (and the other types) changes what servers
  see, so it needs a deliberate decision and a browser test.
- A failed original URL that contains a literal `|` cannot get a bypass session
  rule (`BYPASSABLE_URL_RE`), yet the page is still told to retry it; the retry
  is redirected to the proxy again and the element stays broken (no loop —
  `fallbackSeen` stops it). Documented under "Known limits".
- The `tabs` permission is redundant with `<all_urls>` for reading `tab.url`;
  removing it would only change the popup text on `chrome://` pages
  ("No active tab" instead of "chrome page") and drop one install warning.
- `content.js` still walks every added node / `style` mutation only to skip it
  while the network redirect is live (`loading=lazy` is the only effect). A
  cheap early-out in `rewriteBg()`/`rewriteImg()` is possible but needs the
  browser suite to validate.
- `setCustomBadge()` is duplicated verbatim in popup.js and options.js (a shared
  module would also have to be added to `build.sh`'s `INCLUDE`).
- prehook's per-load random settings-event name is readable from the DOM
  (`data-bh-settings-event`), so it deters accidental collisions, not a hostile
  page — which can only affect its own tab.
- Options "Save" reloads the tab immediately; if the worker has not finished
  rebuilding the DNR rules by then, the first load can use the old rules.

