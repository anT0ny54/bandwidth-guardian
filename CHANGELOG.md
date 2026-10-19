# Changelog

## 0.2.3 - 2026-10-18

### Modified (post-release audit, no version bump)

- Fixed: the one-shot fallback retry for inline `style` attributes still used
  a case-sensitive `url(` pre-check, so uppercase `URL(...)` was selected by
  the case-insensitive matcher but skipped before restoration. The retry gate
  is now case-insensitive.
- Verified end-to-end: no tracking pixels or tracking code exist anywhere in
  the extension; the only outbound traffic is image data to the
  user-configured proxy (and the settings page's manual "Test proxy" fetch).
- Fixed: an added subtree root whose inline `style` attribute used an
  uppercase `URL(` was never scanned for background-image proxying, because
  the fast pre-check was case-sensitive while the descendant selector
  `[style*='url(' i]` is not. The pre-check is now case-insensitive and reads
  the attribute once instead of twice.
- Verified permissions (`webRequest`, `alarms`, `tabs`, `storage`, DNR) are
  all exercised by live code paths, and all cross-layer KEEP-IN-SYNC
  contracts (defaults, conflict pattern, private-host patterns, srcset
  parser, settings-event name, failure attributes) are consistent. No dead
  code or conflicts were found in that audit; no other code was changed.


### Fixed

- A proxy URL with a non-http(s) scheme (for example `ftp://` or `javascript:`)
  no longer produces a bogus origin in the service worker, which made the
  `webRequest` filter registration throw. The worker now validates the proxy
  exactly like the network rules do.
- The MAIN-world hook split excluded domains on a narrower whitespace class than
  the service worker, content script and popup, so a pasted non-breaking space
  could glue two domains together and exclude neither. All layers now tokenize
  on commas and any whitespace.
- A rejected bypass-rule operation can no longer wedge later fallback handling
  in the service worker.
- The settings page hint about reloading after a quality change described the
  old behaviour; saving now reloads the opener tab and the hint says so.
- Test instructions and CI used `node --test tests/`, which Node 21+ rejects;
  both now pass the test files explicitly. Release builds are serialized so two
  quick pushes cannot race on the same GitHub release.
- The stale header comment in `content.js` claiming the network redirect had
  been removed now describes the current two-layer design.

### Changed

- Proxy response headers are parsed once per response instead of up to seven
  times, and the `webRequest` observer is no longer torn down and re-registered
  on every unrelated settings change.
- The service worker derives its published runtime state from the rule set it
  just installed, removing a `getDynamicRules` round trip and a second storage
  read that could disagree with what was built.
- Settings-page preset values are read from the buttons instead of a duplicated
  constant list, and its two storage listeners are merged.

### Removed

- Dead code: the unused `IMAGE_CONTENT_TYPES` export in `defaults.js`, a
  write-only `Set` in the popup's exclude handler, redundant `trim()`/space
  patterns in domain parsing, an unreachable `options.html` URL check, unused
  CSS (`.btn.full`, popup anchor rules, duplicated light-theme variables) and
  test-only "patch ZIP" guards and unused mock-server fields.

- The built-in tracking-pixel pattern lists (`TRACKING_PATTERNS` in the service
  worker, `TRACKING_RE` in the DOM layers) and the per-pattern DNR allow rules
  that exempted known tracking pixels from proxying. Tracking images are now
  routed through the proxy like any other image; the retired rule IDs 30-42 are
  removed from installed browsers on the next rule refresh.

### Tests

- Added regression tests for domain tokenizing, proxy-origin validation and
  proxy statistics header parsing.
- Removed the tracking-pattern sync assertions and the tracking-exemption rule
  check (rule IDs 30-42); the `skip.html` pixel URL is now asserted proxied.
