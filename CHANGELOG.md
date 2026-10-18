# Changelog

## 0.2.2 - 2026-10-18

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

### Tests

- Added regression tests for domain tokenizing, proxy-origin validation and
  proxy statistics header parsing.
