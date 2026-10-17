# Changelog

## 0.1.9

### Fixed

- The CSP rule used `name` instead of `header` in its response-header
  condition. Chrome rejected the whole rule update with a synchronous error, so
  **no** dynamic rule (CSP and `Save-Data`) was ever installed and the refresh
  lock stayed held. Rule updates now catch synchronous and asynchronous errors
  and fall back step by step.

### Added

- Network-level interception: a declarativeNetRequest redirect proxies every
  image request before the browser contacts the original host, covering
  stylesheets (including cross-origin), pseudo-elements, shadow roots, SVG
  `<image>`, posters and lazy loaders. A higher-priority allow rule for the
  proxy origin prevents duplicate proxying.
- The DOM layer now only handles URLs the raw proxy contract can't carry
  (`&quality=`, `&l=`, `&bw=`, `&jpeg=`, `&max_width=`), or everything if the
  redirect can't be installed. Shadow roots (open, closed, declarative) are
  observed.
- Fallback: failed proxy responses get a per-tab bypass rule and a one-time
  direct re-request; reloads in the same tab don't retry the proxy.
- Circuit breaker: an unreachable proxy is suspended for 2 minutes.
- Exemptions for localhost, `*.local`, single-label and private-IP hosts.
- Real-Chrome test suite (`tests/browser/`, 17 tests) and extended simulation
  tests; the CI build runs them before packaging.

