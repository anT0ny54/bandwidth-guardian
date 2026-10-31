# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] — current release

### Changed
- Removed a dead bypass-slot assignment; the decision is immutable after the
  capacity check and eviction step.

### Fixed
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

### Maintenance
- Added simulation regressions for element reuse during pending and completed
  retries, stale timeout callbacks, delayed failure-list synchronization,
  unknown-tab bypass protection, cross-frame retry batching, unavailable DNR
  APIs, mapped IPv6 and link-local addresses. Added a real-Chrome regression
  that reuses a failed image node for a new conflict URL, plus simulation
  regressions for repeated load cleanup and non-background inline CSS URL
  declarations.
- Re-read the complete project before modification. Syntax checks and build
  validation pass; all 32 simulation tests pass. The real-Chrome suite remains
  unexecuted because `playwright-core` is not installed in this environment;
  the browser regression is included for a configured browser-test environment.
- Updated this existing release entry and README only; no version bump.
