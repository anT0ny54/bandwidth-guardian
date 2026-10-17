# Changelog

## 0.1.10

### Fixed

- Options page: the "Custom" badge is now one element per preset row — a custom
  quality and a custom width no longer steal each other's badge, and clearing
  one row keeps the other's (WeakMap-keyed, popup included).
- content.js: images inserted via a `DocumentFragment` (the standard
  batch-insert pattern) are now scanned; previously only the fragment itself
  was seen and its children went unproxied.
- content.js: the known-failed URL list is merged into the Set instead of
  replaced — an early `bh-retry` arriving before the initial `bh-failed-list`
  response is no longer silently dropped (fragments stripped on both paths).
- content.js/prehook.js: the srcset cache no longer re-proxies an intentional
  site restore (a previously-seen input is left untouched), and a one-shot
  `load` listener can no longer erase a newer fallback arm's metadata.
- options.js: an incoming quality change is no longer blocked by an unsaved
  width edit (and vice versa) — each field gates only on its own dirty flag.
- options.js: `?tab=` rejects non-integer ids (`1.5` no longer passes); own
  pages are matched by URL prefix, so a real website ending in `options.html`
  still reloads; the proxy test caps the downloaded body at 64 KB; reset
  buttons ask for confirmation; custom width is bounded (0–16384, `max`
  attribute added); the tracked `dirty` flag now warns about unsaved changes.
- popup.js: one reload pattern for ALL settings — the "reload to apply" nudge;
  preset clicks no longer auto-reload unconditionally and the enabled toggle
  finally shows the hint; storage failures show feedback, not a blank popup;
  `parseDomains` strips ports.
- service-worker.js: a proxy failure with no associated tab (`tabId < 0`) no
  longer creates a session-scoped allow for that URL in every tab.
- popup.html: title is "Bandwidth Guardian", matching the manifest and locales.

### Changed

- service-worker.js is now an ES module (`"type": "module"`) importing
  `DEFAULTS`/`IMAGE_CONTENT_TYPES` from `defaults.js` — one source of truth
  instead of a third hand-duplicated copy.
- content.js: quality/maxWidth reach prehook pre-clamped; `failed` is omitted
  from unchanged settings publishes; one combined selector pass per rescan;
  mutation overflow skips straight to the full rescan; saveData-only sync
  changes no longer restart the observer/rescan; URLs are parsed once on the
  hot path; `rewriteBg` skips `none`; `DEFERRED_SOURCE_ATTRS` is derived from
  `DEFERRED_URL_ATTRS`; the cold-path sync read is one shared helper.
- prehook.js: `setAttribute("href"/"rel"/"as"/"type")` on non-`<link>`
  elements bails before the instanceof chain.

### Removed

- Stale "old DNR redirect was removed" comment in content.js; dead `data-width`
  fallbacks, `versionEl` guard, unused `excluded`/`test` CSS classes; double
  quality defaults (content/prehook/worker); prehook's stale hard-queue-cap
  comment.

## 0.1.9

### Fixed

- The CSP rule used `name` instead of `header` in its response-header
  condition. Chrome rejected the whole rule update with a
  synchronous error, so **no** dynamic rule (CSP and `Save-Data`) was ever
  installed and the refresh lock stayed held. Rule updates now catch
  synchronous and asynchronous errors and fall back step by step.

### Added

- Network-level interception: a declarativeNetRequest redirect proxies every
  image request before the browser contacts the original host, covering
  stylesheets (including cross-origin), pseudo-elements, shadow roots, SVG
  `<image>`, posters and lazy loaders. A higher-priority allow rule for the
  proxy origin prevents duplicate proxying.
- The DOM layer now only handles URLs the raw proxy contract can't carry
  (`&quality=`, `&l=`, `&bw=`, `&jpeg=`, `&max_width=`), or everything if the
  redirect can't be installed. Shadow roots (open, closed, declarative) are
  observed.
- Fallback: failed proxy responses get a per-tab bypass rule and a one-time
  direct re-request; reloads in the same tab don't retry the proxy.
- Circuit breaker: an unreachable proxy is suspended for 2 minutes.
- Exemptions for localhost, `*.local`, single-label and private-IP hosts.
- Real-Chrome test suite (`tests/browser/`, 16 tests) and extended simulation
  tests; the CI build runs them before packaging.
