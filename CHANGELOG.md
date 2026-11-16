# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.7] — current release

### Changed
- Keep `build.sh` executable for direct use from POSIX checkouts, and document
  `bash ./build.sh` as the portable build command. Some source ZIP archives do
  not preserve Unix executable metadata, so the README no longer depends on
  that file mode; the CI workflow already invokes the script through Bash.
- Tightened the connection-level circuit breaker: only recognized Chromium
  transport, DNS and proxy-path failures count toward the two-failure,
  rolling 10-second threshold that suspends image redirects for 40 seconds.
  SOCKS proxy-path and DNS server failures are included. TLS/certificate,
  CSP/policy, upstream-tunnel, generic and unrecognized errors
  retain per-image direct fallback where appropriate but cannot suspend all
  redirects. HTTP error responses and ORB/response-blocking errors also use
  per-image fallback only. Any completed HTTP response, including an error
  status, confirms proxy reachability and resets the failure window.

### Fixed
- A failed content-script settings read could dereference an empty storage
  callback result and abort initialization. Local and sync reads now check
  `runtime.lastError` and synchronous API exceptions; the script falls back from
  the local mirror to sync settings and uses disabled/no-proxy DOM defaults if
  both stores are unavailable. Successful sync fallback still refreshes the
  local mirror.
- The custom max-width field accepted digit strings beyond JavaScript's safe
  integer range. Those values could be rounded before being written into proxy
  and DNR rules; custom widths now accept only non-negative safe whole numbers.
- The fallback browser fixture reused the `fps` ID on a `<source>` and a `<div>`.
  Removed the unused duplicate ID and added a simulation check that all browser
  fixture pages keep their DOM IDs unique.
- The fallback retry for `<img>` elements restored `src`/`srcset` from the
  attribute as it stood. When that attribute still held a proxy URL (a DOM-layer
  rewrite whose proxy request failed), the "direct" retry re-requested the proxy
  instead. Retries now map proxy URLs back to their originals first, for both
  `src` and every `srcset` candidate.
- The extension-wide DNR bypass table evicted working tab-scoped rules at half
  of its 3,000-rule capacity: the eviction check compared against the remaining
  headroom after the current batch was added. Eviction now starts only when the
  global table is full, so up to 3,000 active bypasses across all tabs are kept.
  Each rule remains restricted to the tab that produced the failed request.
- A lazy-loaded image whose `srcset` was rewritten and whose `src` was then
  assigned by page script recorded the rewritten (proxy) `srcset` as its
  original. After a proxy failure the restore put proxy URLs back into
  `srcset`, so the image never received its one direct retry. The original
  `srcset` is now kept across `src` assignments.
- The "Custom" quality and width badges were appended as children of the
  three-column preset grids, occupying an extra grid cell beneath the preset
  buttons. They are now static, hidden-by-default labels beside each section
  title in both the popup and the settings page.
- The statistics flush timer ran before the crash-recovery journal timer, so
  normal activity could be committed without ever being journaled. The journal
  is now written first, the flush waits for any pending journal write, and new
  activity arriving during a journal write receives an updated snapshot.
- A failed local-storage read or commit during a stats flush could discard the
  in-memory batch. Failed batches are now restored to the pending queue, startup
  recovery reads retry with increasing backoff without allowing new journal
  writes to overwrite the previous snapshot, and failed recovery commits
  requeue the journal for the regular flush.
- A failed crash-journal write cleared its in-flight flag but did not retry,
  leaving pending activity vulnerable before the normal flush. Journal writes
  now retry with capped exponential backoff, and a stats reset clears the
  backoff. While a journal write or retry is pending, the normal flush waits
  without polling every 750 ms; a successful journal write resumes the flush.
- A repeated failure for the same tab-scoped URL could enter a second fallback
  batch while its first DNR bypass update was still pending, causing duplicate
  retry notifications. In-flight reservations now deduplicate those requests
  and are released after the DNR result, so failed updates remain retryable.
- Rapid runtime transitions could complete their asynchronous storage callbacks
  out of order and leave an older redirect state persisted last. Runtime-state
  read/compare/write operations are now serialized, and obsolete queued
  revisions are skipped. A transient local-storage read/write failure could also
  mark an unpublished state as current and suppress later identical updates;
  the worker now records only storage-confirmed states, retains the newest
  pending state and retries failed reads/writes through a dedicated Chrome
  alarm with exponential backoff from 30 seconds up to 10 minutes. A successful
  publication clears the alarm and resets the delay. A queued return to the
  last confirmed state is still preserved while another transition is in flight.
- Closing a tab while its 250 ms fallback batch was queued could leave stale
  retry work available for a later DNR update. Tab teardown now drops that
  tab's queued batch and retry reservations, while preserving the shared timer
  for other tabs and cancelling it when the queue becomes empty.
- A failed conflict URL selected through `<picture><source srcset>` could remain
  stuck on its proxy URL because the `<source>` has no independent error target.
  The MAIN-world retry now maps that proxy candidate back to its original URL
  and restores it through the tab's confirmed DNR bypass. Replacing a picture
  source also clears stale failure state on its parent image.
- Settings changes received from another extension view now update the saved
  quality and width reset baselines even while those fields contain unsaved
  edits. The active edit is left untouched, and clearing it restores the latest
  stored value instead of a stale one.
- Fallback cleanup now remains armed across successful loads on a reused image
  element. Previously, a one-shot `load` listener was removed after the first
  success while its registration marker remained set, leaving later fallback
  timers uncleared.
- Inline style interception now rewrites `url()` references in every
  `style`-attribute declaration, not only `background-image`. This also covers
  conflict-parameter URLs in declarations such as `border-image-source`,
  `list-style-image`, `mask-image` and `cursor`.
- When all three dynamic-rule installation attempts failed, the service worker
  published a guessed fallback state even though Chrome atomically retained the
  previous rules. It now reads the live dynamic rules and publishes the actual
  redirect state; if that inspection also fails, it preserves the last known
  state rather than allowing the DOM layer to make an unsafe interception
  decision.
- A configured proxy base could already contain `url=`, while each proxied URL
  appends its own `url` parameter. This made the proxy target ambiguous. The
  service worker, both DOM interception layers and the options page now reject
  proxy bases containing that reserved query parameter, while allowing other
  query parameters such as access tokens.
- CSS function names are case-insensitive. The stylesheet fallback retry gate
  now recognizes uppercase and mixed-case `URL()` references instead of
  skipping their rules.
- Corrected a duplicated command line in the README browser-test instructions.
- Failed-element markers are now cleared when an image node is reused for a
  different URL, including while a retry is pending. The MAIN-world hook now
  notifies the isolated world to clear its separate fallback state, and
  timer-ownership checks prevent queued stale callbacks from restoring over a
  newer source. The exact failed responsive candidate is recorded, and a failed
  inline CSS URL no longer permanently blacklists its containing element.
- A failed circuit-breaker session-storage read was treated as an inactive
  suspension, which could reinstall proxy redirects before the cooldown ended.
  Unreadable state now keeps redirects disabled and schedules a separate,
  exponentially backed-off rule-refresh alarm; the normal cooldown alarm remains
  independent and successful reads clear the retry alarm.
- Fallback retries are batched per tab and broadcast to all frames, matching the
  tab-scoped DNR bypass. Invalid/unknown tab IDs are rejected so they cannot
  create a global allow rule. Newly loaded documents receive the complete
  bounded bypass list rather than only its last 1,000 entries.
- The service worker now publishes `redirect: false` when the DNR API is
  unavailable, while preserving circuit-breaker suspension state.
- Private-network exclusions now cover IPv4-mapped private IPv6 addresses and
  the full IPv6 link-local `fe80::/10` range in all three interception layers.

### Removed
- An always-true guard around the options page version label.
- Runtime creation of the "Custom" badge elements (`setCustomBadge`,
  `customBadges`) in `popup.js` and `options.js`, replaced by static markup.
- A duplicate inline-style pass in the content script. Each mutated or
  rescanned `<img>`/`<source>` was processed for `url()` styles twice, and
  added roots had a redundant style re-check. Inline styles are now handled
  once per element by the style selector pass.

### Maintenance
- The real-Chrome fallback test derives its expected statistics count from the
  proxied requests it actually made (every request not designed to fail is a
  counted success), instead of a hard-coded number. Its failure message lists
  the proxied requests.
- Removed unused bypass bookkeeping and duplicate eviction scans; eviction
  now safely skips a candidate when no oldest entry exists.
- Prevented an outdated breaker alarm from clearing a newer 40-second
  suspension when in-flight proxy requests fail after redirects have stopped.
  Resume alarms now check the current stored deadline and reschedule when it
  has been extended. Added SOCKS proxy-path and DNS-server failures to the
  connection-level allowlist based on Chromium's current network error types.
- Kept shared URL patterns synchronized across the service worker and both DOM
  interception layers. Added regression tests for the bypass eviction
  threshold, the `src`-after-`srcset` restore, the static badge placement and
  the proxy-to-original retry mapping. Expanded the HTML-ID guard to cover the
  popup and settings pages and verify their static JavaScript selectors exist.
  Added a regression test for successful proxy responses without `Content-Type`:
  unknown MIME types remain uncounted and do not trigger a redundant direct retry,
  while explicit non-image types still fall back. Runtime publication tests now
  cover automatic alarm retries, capped backoff, failed storage reads/writes and
  transitions back to the last confirmed state while another write is pending.
  The bypass-capacity test now verifies the 3,000-rule limit across multiple tabs.
  Added a regression test for content-script storage callback errors,
  synchronous storage API throws and successful settings reads. A further
  service-worker settings-read failure path now preserves the last known local
  mirror and installed DNR rules, avoids writing defaults after a failed read,
  and retries initialization/mirroring/rule refresh with a Chrome alarm. Added
  regression coverage for failed sync reads across those paths. MV3 proxy
  response/error observers are now registered synchronously at worker startup,
  then narrowed to the configured proxy origin; if synced settings are
  unavailable, the last confirmed local mirror restores that filter and queued
  early events are replayed. Added regression coverage for registration,
  narrowing and recovery. The README now explicitly warns that the CSP DNR rule
  removes all `Content-Security-Policy` response-header entries on a matching
  response (including unrelated directives), not just `img-src`/`default-src`,
  and identifies the
  security trade-off. It also corrects the object/embed browser-test table.
  The real-browser harness removes Playwright's default
  `--disable-extensions` argument, which otherwise prevents its explicit
  unpacked-extension flags from loading the worker. All 61 simulation tests,
  shipped-script syntax checks, unused-local/parameter checks and two clean
  reproducible builds pass. The updated browser suite was retried with the
  available Playwright package and system Chromium, but that Chromium build
  still did not expose the extension service worker during startup, so its 17
  browser test cases remain unverified here. The CI workflow's Playwright-managed
  Chromium remains the intended environment for that suite. The manifest
  version remains `0.2.7`.
