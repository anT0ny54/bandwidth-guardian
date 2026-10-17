# Changelog

## Unreleased

### Fixed
- Use Chromium DNR glob patterns for CSP response-header matching.
- Keep quality and maximum-width settings synchronized independently when the other field has unsaved edits.
- Ignore proxy-response statistics when the `Content-Type` header is missing, duplicated, ambiguous, or outside the exact six-type allowlist.

### Documentation
- Clarify that the extension's MIME allowlist checks proxy responses, not the original upstream MIME type. Strict source-MIME enforcement also requires validation in the separate proxy before image decoding or conversion.
