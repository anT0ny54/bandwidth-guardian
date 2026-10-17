# Changelog

## 0.1.8 — 2026-10-17

### Fixed

- Statistics: the batched flush no longer commits an empty `statsPending` mirror. A delta recorded by `recordStats()` between the flush read and the flush commit previously had its crash-recovery mirror zeroed out, defeating the MV3 worker-kill recovery path.
- Declarative Net Request: the `Save-Data` header rule now always includes `urlFilter: "*"`. An empty rule condition is rejected by Chromium DNR validators, which failed the entire `updateDynamicRules` update — including the CSP-stripping rule in the same batch.

### Removed

- Removed the unused `saveData` key from the `prehook.js` defaults copy (the service worker owns the Save-Data header; the MAIN-world script never reads it).
- Removed the unused keyed `DETECTED_IMAGE_TYPES` map in `service-worker.js`; the statistics allowlist is now a plain `Set` of media types.

### Changed

- The popup's quality-preset click no longer re-renders the highlight manually — the `storage.onChanged` listener already re-renders from the change payload, and the popup closes immediately after the reload.

