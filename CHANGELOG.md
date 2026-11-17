# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.7] — current release

### Changed
- Keep `build.sh` executable in POSIX checkouts and explicitly restore mode
  `755` after checkout in both CI jobs. The permission test now checks only real
  Git checkouts, so source ZIPs that omit Unix metadata remain testable;
  `bash ./build.sh` remains the portable archive command.
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
- When a boolean setting was removed from `storage.sync`, the options page could
  render its checkbox as unchecked even though the shared default was `true`.
  The `enabled`, `grayscale` and `saveData` controls now consistently fall back
  to their shared defaults, matching the settings baseline and other extension
  contexts. Added regression coverage for all three removed keys.
- Reset defaults could race an in-flight partial Save or an auto-saved switch
  write. Reset now refuses to overlap Save, drains queued switch writes, invalidates
  older failed-toggle recovery reads, and disables setting controls through the
  reset and refresh. If the reset write fails, persisted switch values are
  reloaded while dirty text/preset edits remain intact. Auto-saved switch writes
  are serialized, overlapping toggles do not show stale completion messages, and
  failed writes restore the latest stored value when it can be read. Initial
  settings-read failures are surfaced without making an independent stats read
  block the settings page. Added regression coverage for reset serialization,
  pending auto-saves, duplicate reset attempts, late recovery callbacks and
  failed reads/writes.
- The fallback browser test inferred successful statistics from proxy request
  URLs alone. A request can reach the mock server and then be cancelled while
  Chrome replaces an image candidate, so the test now counts only completed
  2xx responses with a strict image `Content-Type`; the mock records final
  response metadata for that assertion.
- A failed content-script settings read could dereference an empty storage
  callback result and abort initialization. Local and sync reads now check
  `runtime.lastError` and synchronous API exceptions; the script falls back from
  the local mirror to sync settings and uses disabled/no-proxy DOM defaults if
  both stores are unavailable. The content script applies synced fallback
  settings in memory only; the service worker remains the sole writer of the
  shared local mirror and updates it after its own successful sync-settings read.
- A `storage.sync` change arriving before the content script's initial settings
  load used a separate, unchecked read. Callback failures or synchronous API
  throws could pass an empty value to `applyOpts()`, while partial results could
  omit defaults. The change handler now uses the guarded reader and merges the
  shared defaults before applying settings. Revision checks now also discard
  stale local/sync startup snapshots, and overlapping reads for one revision
  share a single callback, preventing older values from rolling settings or
  runtime state backwards. Content scripts no longer write the shared mirror;
  the service worker remains its sole writer. Partial local settings and
  runtime mirror events are normalized with their respective defaults, and
  invalid runtime mirror values fall back to the known default runtime state.
- The service worker could receive `storage.sync.get()` callbacks out of order,
  then publish an older `bhOpts` snapshot after a newer settings change. Mirror
  reads now carry revisions, obsolete callbacks are ignored, and local mirror
  writes are serialized with only the newest pending snapshot retained. Toolbar
  icon reads also discard stale callbacks. Added regression tests for reversed
  sync-read completion, an older local write already in flight, and stale icon
  callbacks.
- A local-mirror recovery read for the proxy `webRequest` observer could finish
  after a newer sync snapshot had already selected a different proxy origin,
  re-registering the observer against stale settings. Observer restores now
  coalesce overlapping reads and use a shared revision that every successful
  sync snapshot invalidates; late local callbacks are ignored. Added out-of-order
  callback and read-coalescing regression assertions.
- A later failed sync read could trigger local-mirror recovery after a newer sync
  snapshot had already configured the proxy observer, allowing an older mirror
  to roll the observer back while the confirmed mirror write was still pending.
  Observer recovery is now limited to startup (until a trusted sync or local
  snapshot is loaded), and failed read requests no longer invalidate a previously
  confirmed snapshot's pending mirror write. Added a regression for the failed-
  newer-read / pending-write ordering.
- Repeated Save clicks or Enter presses could overlap multiple settings writes,
  and Save was initially available before the first settings read completed.
  The options page now waits for a successful startup settings read before
  writing, serializes saves, disables the Save button while a write is pending,
  and reports storage read/write failures without clearing unsaved edits. Added
  regression coverage for a fast Save click during startup, duplicate
  submissions and a rejected storage write.
- A newer cross-page setting could arrive while `storage.sync.set()` was pending.
  Save completion now preserves that newer observed value and decides whether to
  reload the page from the final committed snapshot rather than the older
  submitted values. Locally edited fields remain dirty when changed during the
  write. Added regressions for both cross-page updates during Save and the
  resulting reload decision.
- The Proxy Test request could finish during Reset defaults and re-enable its
  button while the rest of the settings UI was still locked. Test Proxy now
  refuses to start during reset and its completion respects the reset lock;
  added a regression for the overlapping operation.
- An options-page save could complete after newer edits were made while
  `storage.sync.set()` was pending, then clear their dirty flags and reset custom
  controls to the older submitted values. Per-field edit revisions now ensure
  that save completion only normalizes fields untouched since its snapshot;
  newer edits remain visible and explicitly unsaved. Added a regression test for
  edits made during the write.
- The popup could retain an old excluded-site badge after its active-tab query
  failed or returned an invalid URL, even though its internal tab context had
  been cleared. Unavailable states now clear the badge and disable the action.
  An exclusion toggle also captures the active-site revision and aborts if the
  user changes tabs while its storage read is pending, preventing a click on one
  site from changing the newly active site. Added regressions for both cases.
- Popup settings and site-exclusion storage reads/writes could reject without
  reporting an error, leaving controls in a stale or optimistic state. The popup
  now reports these failures, rolls back a failed optimistic setting only when no
  newer cross-page change has arrived, and ignores unrelated sync keys. Added
  regression coverage for failed reads/writes and newer settings events arriving
  while a write is pending.
- Reset defaults could finish while the original options-page settings snapshot
  was still pending; that older callback could repaint pre-reset values after
  defaults had been committed. Reset now advances every settings revision before
  its first asynchronous wait, invalidating the stale startup snapshot. Added a
  regression that resolves the initial read after a completed reset.
- Rapid popup controls changes could issue overlapping `storage.sync.set()` calls
  for different settings, allowing an earlier click to complete after a later
  intent. Popup settings and site-exclusion actions now share a short write lock
  that disables writable controls until the current operation settles. Added
  regression coverage for duplicate setting writes and exclusion attempts during
  a pending save.
- When a boolean sync setting was removed, the options page updated its stored
  baseline to the shared default but rendered the missing `newValue` as `false`.
  The enabled, grayscale and Save-Data checkboxes now use their shared defaults
  for removed keys, matching the popup and content-script fallback behavior.
  Added a regression for all three boolean settings.
- A transient `getSessionRules()` failure during worker wake was cached as an
  empty initialized bypass table. Later fallbacks could then allocate session
  rule IDs without first discovering rules that Chrome still owned. Session-rule
  initialization now has its own retryable single-flight promise, separate from
  the serialized DNR operation queue; bypass operations are skipped when rule
  enumeration fails and the next queued operation retries it. Added a regression
  for failed initialization followed by successful recovery.
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
- Popup and options-page startup reads could complete after newer cross-page
  updates and roll controls back to stale values. Their initial snapshots now
  update only settings untouched since the read began; the popup also ignores
  stale active-tab lookups, and the options page discards old startup statistics
  after a newer live update. Options saves now sample controls after the async
  baseline read so cross-page changes arriving during that read are included.
- Private-network exclusions now cover IPv4-mapped private IPv6 addresses and
  the full IPv6 link-local `fe80::/10` range in all three interception layers.

### Removed
- Removed the content script's cold-start write to `storage.local.bhOpts`. That
  fallback ran independently in every frame and duplicated the service worker's
  mirror writer; content scripts now apply the sync fallback in memory only.
- An always-true guard around the options page version label.
- Runtime creation of the "Custom" badge elements (`setCustomBadge`,
  `customBadges`) in `popup.js` and `options.js`, replaced by static markup.
- A duplicate inline-style pass in the content script. Each mutated or
  rescanned `<img>`/`<source>` was processed for `url()` styles twice, and
  added roots had a redundant style re-check. Inline styles are now handled
  once per element by the style selector pass.

### Maintenance
- The source-archive permission test now verifies that the project directory is
  the Git checkout root before checking its executable bit. Extracting a source
  ZIP inside an unrelated Git worktree no longer triggers a false failure. A
  regression assertion also verifies that both CI jobs restore mode `755` after
  checkout before using the build script.
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
  synchronous storage API throws and successful settings reads. A new
  regression covers sync changes arriving during startup, including default
  normalization and failed callback/throw paths. A further
  service-worker settings-read failure path now preserves the last known local
  mirror and installed DNR rules, avoids writing defaults after a failed read,
  and retries initialization/mirroring/rule refresh with a Chrome alarm. Added
  regression coverage for failed sync reads across those paths. MV3 proxy
  response/error observers are now registered synchronously at worker startup,
  then narrowed to the configured proxy origin; if synced settings are
  unavailable, the last confirmed local mirror restores that filter and queued
  early events are replayed. Revision guards also invalidate a pending local
  restore when a newer sync snapshot succeeds, preventing stale proxy origins
  from being re-registered. Added regression coverage for registration,
  narrowing, recovery and out-of-order restores. The README now explicitly
  warns that the CSP DNR rule removes all `Content-Security-Policy` response-header entries on a matching
  response (including unrelated directives), not just `img-src`/`default-src`,
  and identifies the
  security trade-off. It also corrects the object/embed browser-test table.
  The real-browser harness removes Playwright's default
  `--disable-extensions` argument, which otherwise prevents its explicit
  unpacked-extension flags from loading the worker. All 91 simulation tests,
  shipped-script syntax checks and two independent byte-identical reproducible
  builds pass. The local rerun without `playwright-core` and a configured
  `CHROME_PATH` skips the browser suite; the workflow installs
  Playwright-managed Chromium and runs all 17 Chrome browser cases. The
  manifest version remains `0.2.7`.
