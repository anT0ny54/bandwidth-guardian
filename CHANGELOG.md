# Changelog

## 0.2.0

### Fixed

- Preload `<link>` elements created by the HTML parser were inspected twice by
  the preload observer. The second call was harmless (processing is
  idempotent) but wasted work on every page load.
- The prehook's page-teardown path (`stop()`) now disconnects the settings
  retry observer, removes the settings event listener and cancels the
  five-second watchdog timer; the content script now removes its
  `storage.onChanged` and `runtime.onMessage` listeners as well. Previously
  only the two mutation observers were disconnected.
- The warning colour on the settings page's toasts used a hard-coded amber
  instead of the `--warn` variable, which was defined but unused; the popup's
  reload bar also hard-coded its amber palette. Both now use a consistent
  warn palette that adapts to the colour scheme.

### Changed

- Comment accuracy: the random settings event name between content.js and
  prehook.js is described as an obfuscation measure, not a protection against
  forged settings — the name is published in a DOM attribute any page script
  can read.
- Stale branding removed: the popup title and header no longer say
  "+ Save-Data" (the popup has no Save-Data control; the setting lives on the
  settings page).
- The service worker ignores `storage.sync` changes to keys it does not
  consume, instead of re-reading settings and refreshing rules on every
  unrelated change.
- The fallback retry's shadow-root discovery no longer scans every element in
  the document; it scans only elements that can host a shadow root
  (`img, video, image, object, embed, input, [style]`), and the preload
  observer no longer re-processes link nodes.

## 0.1.9

### Fixed

- The CSP rule used `name` instead of `header` in its response-header
  condition. Chrome rejected the whole rule update with a synchronous error, so
  **no** dynamic rule (CSP and `Save-Data`) was ever installed and the refresh
  lock stayed held. Rule updates now catch synchronous and asynchronous errors
  and fall back step by step.

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
- Real-Chrome test suite (`tests/browser/`, 17 tests) and extended simulation
  tests; the CI build runs them before packaging.

