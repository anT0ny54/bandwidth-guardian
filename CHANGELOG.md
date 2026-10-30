# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4] — current release

### Changed
- Centralized the extension defaults into one frozen, classic `defaults.js`.
  The service worker imports it, the isolated content script loads it before
  `content.js`, and the popup/options pages load it before their module
  scripts. This removes the duplicated defaults blocks from `service-worker.js`
  and `content.js` while preserving one shared source of truth.

### Fixed
- `service-worker.js` marked a failed URL as already retried before the
  session-scoped DNR bypass update completed. If `updateSessionRules()` failed,
  the page never received a retry but later failures were incorrectly
  suppressed. Retry bookkeeping is now committed only after the bypass rule is
  confirmed.
- Plain bypass URLs that did not require an escaped regex were not checked
  against the conservative DNR filter-length limit. Oversized `urlFilter`
  values are now rejected before the update, matching the existing regex-filter
  guard and preventing an entire bypass batch from failing on one long URL.
- `build.sh` and the simulation test classified `defaults.js` as an ES module.
  It is now validated and shipped as a classic shared script, alongside the
  service worker, prehook and content script.

### Maintenance
- Added simulation coverage for the shared-default loading contract,
  oversized plain bypass filters and retry bookkeeping across failed and
  successful DNR updates.
- Updated `README.md` to document the shared defaults, conservative bypass
  limits, retry bookkeeping and latest audit changes.
- Full project re-read completed before modification. Syntax checks, the build,
  and all 23 simulation tests pass; the real-Chrome suite remains clean-skip
  when `playwright-core`/`CHROME_PATH` are unavailable.
- No manifest version bump.

