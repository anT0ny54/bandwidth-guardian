# Bandwidth Guardian — prehook (document_start, page MAIN world).
//
// The service worker's declarativeNetRequest redirect proxies every image
// request inside the network stack. This script is the DOM layer for the
// URLs that redirect deliberately exempts (CONFLICT_RE: URLs containing
// `&quality=`, `&l=`, `&bw=`, `&jpeg=` or `&max_width=`, which the proxy's
// raw-URL contract would truncate) and for the rare case where the redirect
// rule is not installed (settings.redirect === false). For every other URL it
// is a pass-through, so a request is never proxied by both layers.
//
// It also owns the one-shot fallback retry (kind:"retry" messages relayed by
// content.js) because only the MAIN world can reach closed shadow roots.
// Chrome-based browsers only.
(() => {