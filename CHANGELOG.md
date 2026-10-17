# Changelog

## Unreleased

### Fixed

- Reduce the window in which parser-created image and source elements can
  start direct requests before the extension has loaded its settings. The
  early main-world observer holds URL attributes until settings are ready;
  this is best-effort and is not a browser-wide DNS leak protection mechanism.
- Match Content Security Policy header values with the wildcard syntax
  supported by Chrome declarative network rules.

### Documentation

- Correct the release workflow description: an existing versioned release has
  its asset replaced rather than being skipped entirely.
