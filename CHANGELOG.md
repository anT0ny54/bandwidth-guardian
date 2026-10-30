# Changelog

## [Unreleased] — fourteenth audit pass (no version bump)

### Fixed
- `build.sh` syntax-checked the three classic scripts (`service-worker.js`,
  `prehook.js`, `content.js`) by copying them to `.mjs`, i.e. as ES modules.
  The preflight now checks each file in its real script mode (classic scripts
  as `.js`; `popup.js`/`options.js`/`defaults.js` as `.mjs`), so
  classic-script-only constructs can no longer cause a false build failure
  and the check matches what actually ships.
- `service-worker.js` kept up to 500 queued early `webRequest` events
  (`earlyStatsEvents`) for the worker's whole lifetime when no proxy was
  configured, because the queue was only drained once a proxy origin existed.
  `mirrorToLocal()` now drops the queue whenever the origin resolves to
  empty.

### Maintenance
- Full end-to-end re-read of every shipped source file, HTML page, test,
  workflow and locale file; all "KEEP IN SYNC" contracts (SKIP/CONFLICT/
  private-host patterns, srcset parser, shared defaults, fallback claim
  tokens) re-verified as identical across the DNR, MAIN-world and
  isolated-world layers. No other dead code, conflicts or bugs found.
- No functional changes beyond the two fixes above; no manifest version bump.

## [Unreleased] — thirteenth audit pass (no version bump)

### Fixed
- `content.js` called `sameOpts()` in three `storage.onChanged` paths, but the
  0.2.3 cleanup deleted the helper while leaving every call site — the first
  settings change in any tab threw a ReferenceError and live settings sync
  stopped applying to open pages. The helper is restored with the service
  worker's semantics; the 0.2.3 "Removed" entry and the twelfth-pass
  "free of dead code and bugs" claims were incorrect and are corrected here.
- `service-worker.js` merged stats deltas into `storage.local.get`'s default
  object; when Chromium returns that default by reference it is the shared
  `ZERO_STATS` instance, so the additive merge poisoned every later reset and
  spread built from it. Stats are now cloned before merging (flush path and
  startup crash recovery).

### Maintenance
- Full re-read of every shipped source file; two suspects flagged in earlier
  passes (`statsRevision`, `isHttp`) were re-verified as live and left intact.
- `node --check` passes on all six shipped JavaScript files.
- No functional changes beyond the two fixes above; no manifest version bump.

## [Unreleased] — twelfth audit pass (no version bump)

### Maintenance
- Full end-to-end re-read of every shipped source file; verified all
  "KEEP IN SYNC" contracts between the DNR, MAIN-world and isolated-world
  layers hold and that all captured native descriptors and helpers are live.
- Cleaned up stale pre-fork comments in `defaults.js` (`quality` and
  `grayscale` no longer reference the retired upstream project).
- No functional changes; no manifest version bump.

## [0.2.3] — current release

### Fixed
- Eleventh full code-review pass on every shipped file and supporting test:
  found and fixed a cross-layer casing conflict, one fallback-restore casing
  bug and one session-bypass eviction edge case:
  1. DNR `regexFilter` conflict rules are case-insensitive, but the DOM-layer
     `CONFLICT_RE` patterns in `prehook.js` and `content.js` were case-sensitive.
     Mixed-case proxy parameters such as `&QUALITY=` could be exempted by the
     network layer yet ignored by the DOM layer. Both regexes are now
     case-insensitive, matching DNR behavior.
  2. `content.js` lowercased only `URL.hostname` when deciding whether an
     active `srcset` still pointed at the proxy, while generated proxy URLs
     preserve entered host casing. A proxy URL such as `https://PROXY.example/…`
     could therefore fail to restore its original `srcset` after a proxy error.
     The host used for this check is now fully normalized with `URL.host`.
  3. `service-worker.js` computed session-bypass evictions before checking
     whether new candidates could be installed. A burst of too-long or
     regex-quota-blocked candidates could evict useful existing bypass rules and
     still add nothing. Eviction now happens only when a validated candidate
     needs the slot (and an oldest non-regex rule is no longer discarded for a
     regex candidate that the quota still blocks).

### Removed
- Deleted the unused `sameOpts()` helper from `content.js` (dead code; only the
  service worker needs the settings-equality helper).

### Maintenance
- Added regression coverage for case-insensitive conflict parameters and
  normalized proxy-host casing.
- Updated `README.md` to describe the case-insensitive conflict behavior and
  the latest audit pass.
- Re-ran syntax checks and the interception simulation suite successfully.
- No manifest version bump.
