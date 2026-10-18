# Changelog

## 0.2.1 - 2026-10-18

### Fixed

- CSP stripping is disabled while the proxy circuit breaker is open, so pages
  keep their content security policy while image requests bypass the proxy.
- Failed-request bypass rules now match URLs containing DNR filter metacharacters
  exactly, survive service-worker restarts, and avoid retries when Chrome rejects
  a rule update. Regex-backed bypass rules stay below Chrome's regex-rule quota.
- Startup statistics recovery is serialized with pending mirrors and normal
  flushes, preventing concurrent storage writes from overwriting newer activity.
- Removing the current host from the exclusion field normalizes separators,
  avoiding leftover leading or doubled commas.
- Early responsive image preloads now hold conflicting `imagesrcset` candidates
  until settings arrive, then restore or proxy them together with `href`.
