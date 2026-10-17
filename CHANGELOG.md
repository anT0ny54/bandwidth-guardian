# Changelog

## Unreleased

### Fixed

- Reduce the window in which parser-created image and source elements can
  start direct requests before the extension has loaded its settings. The
  early main-world observer holds URL attributes until settings are ready;
  this is best-effort and is not a browser-wide DNS leak protection mechanism.
- Remove the 1,000-element pending-queue cap. The cap could let later parser-
  created images fetch directly, or leave setter-created images blank while
  settings were loading. Add regression simulations for parser-created images,
  preload links, responsive `srcset`, and 2,005 queued images.
- Match Content Security Policy header values with the wildcard syntax
  supported by Chrome declarative network rules.

### Documentation

- Correct the release workflow description: an existing versioned release has
  its asset replaced rather than being skipped entirely.
