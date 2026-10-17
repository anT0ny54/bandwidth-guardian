# Changelog

## Unreleased

### Fixed
- Fail closed when a proxied image cannot load: mark the element as failed and leave it unavailable instead of restoring or retrying its original URL.
- Keep quality and maximum-width custom badges independent so updating one setting cannot remove or move the other setting's badge.
- Treat quality and maximum-width preset clicks as unsaved edits during live settings synchronization.
- Use Chromium DNR glob patterns for CSP response-header matching.
- Keep quality and maximum-width settings synchronized independently when the other field has unsaved edits.
- Ignore proxy-response statistics when the `Content-Type` header is missing, duplicated, ambiguous, or outside the exact six-type allowlist.

### Documentation
- Document fail-closed proxy behavior: failed proxied images remain unavailable instead of falling back to the original URL.
- Clarify that the extension's MIME allowlist checks proxy responses, not the original upstream MIME type. Strict source-MIME enforcement also requires validation in the separate proxy before image decoding or conversion.
