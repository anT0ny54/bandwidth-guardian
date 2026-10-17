# Changelog

All notable changes to **Bandwidth Guardian** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.9] — 2026-10-17

### Fixed
- **DNS leak through speculative image preloads.** Chromium's speculative
  preload scanner fetches parser-discovered `<img src>` URLs during HTML
  parsing — before `document_start` scripts or any MutationObserver microtask
  can rewrite them. The content scripts canceled the in-flight download, but
  the DNS query to the origin image host had already been sent, leaking the
  hostname to the local resolver (observable on dnsleaktest.com when the
  browser is expected to resolve everything via the VPN/proxy). Guardian now
  installs Declarative Net Request image-guard rules (IDs 4–6) that run before
  the network stack: responses from the configured proxy are allowed,
  favicons/`.ico` are allowed, excluded domains (with subdomains) are allowed,
  and every other direct image request is blocked — so no connection or DNS
  lookup to origin image hosts ever occurs. Rules are installed only while
  compression is enabled and a proxy is configured, and are now also
  refreshed when `proxyBase` changes.
- **Broken images when a parked parser-created image's proxy request failed.**
  `flushPending()` assigned proxied URLs without arming the error fallback;
  `content.js` never arms one for those elements either (it skips
  already-proxied URLs). Both the pending-`src` and pending-`srcset` flush
  paths now arm `armProxyFallback()` before assigning.
- **Settings-event spoofing in the MAIN-world prehook.** Any page script could
  dispatch `bh-settings-update` with an attacker-controlled `proxyBase` and
  hijack every image. After the initial settings event, later events may tune
  quality/grayscale/exclusions but can no longer change the proxy host.
- **Malformed proxy URL when the proxy base ended in `?` or `&`** (e.g.
  `https://proxy/?` produced `…/?&url=…`). Trailing separators are now trimmed
  in both `prehook.js` and `content.js`.

### Removed
- Redundant per-batch cleanup at the end of `content.js` `processMutations()`
  (the module-level collections are already cleared at batch entry).

### Notes
- Stylesheet-defined CSS `background-image` URLs cannot be rewritten in MV3
  and are now blocked (not leaked) on non-excluded sites. Inline
  `style="background-image: …"` images are proxied as before. Add a site to
  the excluded domains if its backgrounds must load directly.
- An extension can only prevent browser-side leaks. If dnsleaktest.com still
  shows your ISP's resolver after this update, the leak is at the OS/VPN
  configuration level, outside this extension's reach.
