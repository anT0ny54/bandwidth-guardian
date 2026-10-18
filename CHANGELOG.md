# Changelog

## 0.2.1

### Fixed

- DOM fallback now applies the same localhost, single-label, private IPv4 and
  private IPv6 exemptions as the network redirect, preventing intranet URLs
  from being sent to a public proxy if redirect-rule installation fails.
- Proxy URLs are validated and normalized in both DOM layers. Fragments are
  removed before query parameters are appended, and invalid/non-HTTP(S) proxy
  values no longer activate malformed fallback rewrites.
- If response-header matching is rejected, rule setup no longer retries by
  stripping CSP from every document. The extension preserves site policy rather
  than weakening unrelated script, connection, or frame restrictions.
- Resetting usage statistics clears the worker's buffered counters and
  crash-recovery mirror as well as persisted totals. It serializes concurrent
  resets with startup recovery and preserves activity recorded afterward.
- A failed cross-origin stylesheet retry removes only the failed clone; it no
  longer removes the original stylesheet when replacement loading fails.
- Quality and max-width settings now synchronize independently: an unsaved edit
  to one field no longer blocks a remote change to the other.
- The build explicitly normalizes staged directories to mode `755` and files to
  `644`, making archive permission bits independent of the source checkout.
