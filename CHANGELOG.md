# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file keeps only the latest release and modification log.

## [0.2.8] - 2026-11-25

### Fixed
- The settings page said that saving always reloads the page that opened it. The
  page is now reloaded only when a saved value differs from the stored one, and the
  hint says so.
- Inline `style` URLs that contain a conflict parameter (`&quality=`, `&bw=`, …) could
  be fetched directly when the page wrote them before compression settings reached the
  MAIN-world script. They are now held until settings arrive, then proxied once. A
  pending style keeps its other declarations, and disabling compression restores the
  page's own URL. This made the real-browser shadow-root test fail in CI.
- A failed session-bypass initialization was cached permanently when the
  `declarativeNetRequest.getSessionRules()` call threw synchronously, so per-tab
  bypass rules were never installed until the worker restarted. The failure is now
  retried on the next operation.

### Changed
- The release job reads the version from the build job's output instead of reading
  `manifest.json` again. The bhp2 checkout fetches only its working tree.
- The proxy-origin recovery steps that were duplicated between the synced-settings
  path and the local-mirror recovery path are now a single helper in the service
  worker. Behaviour is unchanged: both paths mark the observer ready, replay queued
  stats events, clear them when no proxy is configured, and re-target the webRequest
  filter.
- The README documents that, while compression is active, images without a
  `loading` attribute are given `loading="lazy"`. An explicit `eager` is kept, and
  sites with their own lazy-loader attributes are left alone.
- The package version is 0.2.8. The release workflow replaces the asset of an
  existing release that has the same manifest version, so changes of this size need
  a new version. Shipping them as 0.2.7 would have overwritten the published 0.2.7
  package.

### Removed
- An unused `controls` class on the popup's controls card.
- A duplicate `button, input` rule in the popup stylesheet, merged into one.
- An unused `legacy` flag from the browser test's mock URL parser. The mock returns
  only the original URL, which is the only field any caller reads.

### Maintenance
- The README distinguishes a skipped real-browser suite from a passing browser
  validation and states that both Playwright Core and a Chrome/Chromium executable
  are required. CI installs these prerequisites before the browser tests.
- DNR regex conditions now explicitly set `isUrlFilterCaseSensitive: false`,
  matching the documented case-insensitive behavior for skip, conflict, private-host
  and redirect filters. A regression test checks every generated regex rule.
- The README clarifies that conflict-query matching is explicitly configured as
  case-insensitive in the network rules.
- A regression test checks that the proxy origin is applied through the shared
  helper and that no caller sets it directly.
- The simulation test helper `functionFrom()` accepts several function names, so a
  test can load a helper together with the function that calls it.
- The MAIN-world DOM layer now rewrites conflict-query URLs in inline `style`
  attributes inside observed open and closed attached shadow roots. It also watches
  later style-attribute changes, discovers inserted open declarative roots, and
  scans known roots when settings become active. Stylesheet CSSOM rules remain
  outside this attribute-level fallback.
