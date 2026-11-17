# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- The fallback browser test intermittently failed on CI with one more expected
  statistics count than the extension recorded. The test counted a proxy response
  as completed as soon as the mock server had written its bytes, but Chrome can
  still cancel an image candidate after that point, for example when a `<picture>`
  source changes. Completion is now taken from Chrome's own network events
  (DevTools `loadingFinished` with a 2xx status and a strict image MIME type).
  Each candidate change in the fallback test also waits until the element has
  actually loaded the new candidate before the next change, so an in-flight
  request is no longer replaced mid-load.

### Maintenance
- The mock server no longer records final status and `Content-Type` per response,
  since no assertion relies on that anymore.
