# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.7]

### Security
- GitHub Actions now grants repository write access only to the release job.
  Test and build jobs inherit read-only permissions, reducing the impact of
  test-time dependency execution.
- The separate Keep-Fork-Alive workflow now scopes `contents: write` to its
  commit job instead of granting it at workflow scope.

### Fixed
- The popup's site-exclusion action could become enabled after an unrelated
  settings write completed, even when the active hostname contained invalid
  characters and could not be excluded. The storage lock now rechecks the
  hostname before enabling that action.
- Same-document CSS/SVG fragment references such as `url(#mask)` could be
  mistaken for remote images when DOM fallback was active. Both interception
  layers now preserve fragment-only references in `src`, `srcset`, inline CSS
  and CSS retry scanning while continuing to proxy real remote images.
- Exclusion lists were interpreted differently by the network rules, the DOM
  layers and the popup. Entries that are not plain hostnames (for example names
  with underscores) were dropped by the network rules but still honored by the
  content script and prehook, so the same site could be excluded for some
  requests and not others, and the popup reported it as "Excluded" while images
  were still compressed. All layers now use one hostname rule. The popup shows a
  site that cannot be excluded as "Not available".
- If `storage.session.set()` failed while opening the circuit breaker, a later
  rule refresh could treat the empty storage value as an expired breaker and
  restore proxy redirects immediately. The worker now establishes a fail-safe
  in-memory deadline before the async write; the resume alarm rebuilds rules
  after the cooldown, including if the service worker restarts first.
- CSP response rules excluded a configured host only when it was the requested
  resource. A page on an excluded host could still have CSP removed from an
  embedded subframe on another host. CSP rules now honor exclusions for both
  request and initiator domains.

### Changed
- The settings page and README state that only plain hostnames are used.

### Maintenance
- Circuit-breaker resume-alarm scheduling now handles rejected Promise results
  from Chrome's alarms API as well as synchronous errors, matching the other
  worker retry helpers. Added a focused regression test.
- Removed duplicated default values from the prehook's settings watchdog and
  duplicated lazy-attribute lists in the content script; both are now derived
  from a single definition.
- The CSS `url()` matcher is a constant instead of being rebuilt per style
  element, and the proxy-response path no longer allocates on every image.
- Added regression coverage for local CSS/SVG fragments, failed breaker
  storage writes, and excluded initiators in CSP rules; the hostname rule is
  also verified across the network rules, DOM layer and popup.
