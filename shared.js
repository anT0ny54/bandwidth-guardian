// Bandwidth Guardian — shared content-script constants & helpers
//
// Loaded first — see manifest.json's single `content_scripts` entry:
// "js": ["shared.js", "prehook.js", "content.js"]. All three run in the
// same per-frame isolated world for this extension, so the top-level
// `const`/`function` declarations below are ordinary globals to both
// prehook.js and content.js.
//
// This used to be two independently maintained ("KEEP IN SYNC") copies of
// the same DEFAULTS / TRACKING_PATTERNS / skip-URL / build-proxy-URL logic,
// one in each file. That duplication had already drifted apart in two
// ways that are now fixed by having exactly one copy:
//   1. prehook.js's skip check only compared the *image's* hostname
//      against excludeDomains, never the current *page's* hostname the
//      way content.js already did. So "Exclude this site" (popup.js)
//      silently only worked for HTML-parsed images — any image assigned
//      via JavaScript (lazy-loaders, SPA frameworks, `new Image()`) on an
//      excluded page still went through the proxy.
//   2. prehook.js had no "already proxied" guard. content.js rewrites lazy
//      attributes (data-src, etc.) to the *proxy* URL so that when a
//      lazy-loader later runs `img.src = img.dataset.src`, prehook.js
//      would see an already-correct URL. Lacking the guard, prehook.js
//      wrapped that URL in the proxy a second time — `proxy?url=<proxy
//      URL>` — breaking every lazy-loaded image on any site using the
//      common data-src pattern.
//
// service-worker.js still inlines its own copy of DEFAULTS — classic
// (non-module) service workers on Kiwi/Cromite run in a separate context
// that can't load this file the way content scripts do. defaults.js (an
// ES module) is the copy used by popup.js/options.js for the same reason.
// Three "sources of truth" still exist, but each is now used by exactly
// one context instead of two files silently doing the same job.

const BH_DEFAULTS = {
  enabled:         true,
  proxyBase:       "",
  quality:         40,
  grayscale:       true,
  maxWidth:        1280,
  excludeDomains:  "google.com gstatic.com challenges.cloudflare.com",
  isWebpSupported: false,
};

// Tracking-pixel URL patterns (ported from the original bandwidth-hero's
// shouldCompress.js). Not redundant with excludeDomains: these match
// ad/analytics *paths* across many hosts that aren't in the (short,
// user-editable) domain list.
const BH_TRACKING_PATTERNS = [
  /pagead/i,
  /(pixel|cleardot)[^/]*\.(gif|jpg|jpeg)/i,
  /google\.([a-z.]+)\/(ads|generate_204|.*\/log204)+/i,
  /google-analytics\.([a-z.]+)\/(r|collect)+/i,
  /youtube\.([a-z.]+)\/(api|ptracking|player_204|live_204)+/i,
  /doubleclick\.([a-z.]+)\/(pcs|pixel|r)+/i,
  /googlesyndication\.([a-z.]+)\/ddm/i,
  /pixel\.facebook\.([a-z.]+)/i,
  /facebook\.([a-z.]+)\/(impression\.php|tr)+/i,
  /ad\.bitmedia\.io/i,
  /yahoo\.([a-z.]+)\/pixel/i,
  /criteo\.net\/img/i,
  /ad\.doubleclick\.net/i
];

function bhSafeURL(u) { try { return new URL(u); } catch { return null; } }
function bhIsHttp(u) { return /^https?:\/\//i.test(u); }

function bhDomainSet(text) {
  return new Set(
    String(text || "").split(/[,\s]+/)
      .map(s => s.trim().toLowerCase()).filter(Boolean)
      .map(s => s.replace(/^https?:\/\//, "").split("/")[0])
  );
}

// The single decision point for "leave this URL alone": excluded image
// host, excluded *page* host (so "Exclude this site" covers every image on
// the page, not just ones sharing the page's own hostname), an
// already-proxied URL (same host as the configured proxy — avoids
// double-wrapping a URL content.js already rewrote, e.g. a lazy-load
// attribute, when it's later assigned via JS), the tracking-pixel patterns
// above, and .ico/.svg/favicon paths.
function bhShouldSkip(url, hostname, opts, pageHostname) {
  if (!opts) return false;
  const host = String(hostname || "").toLowerCase();
  const ex = bhDomainSet(opts.excludeDomains);
  if (ex.has(host)) return true;
  if (pageHostname && ex.has(String(pageHostname).toLowerCase())) return true;
  const proxyHost = opts.proxyBase ? bhSafeURL(opts.proxyBase)?.hostname?.toLowerCase() : null;
  if (proxyHost && host === proxyHost) return true;
  const path = url.toLowerCase();
  if (path.endsWith(".ico") || path.endsWith(".svg")) return true;
  if (path.includes("favicon")) return true;
  if (BH_TRACKING_PATTERNS.some(p => p.test(url))) return true;
  return false;
}

// Builds the proxy URL with the full param set, all values properly
// encoded (Chrome's DNR regexSubstitution can't do this — see
// service-worker.js for why that matters).
function bhBuildProxyUrl(orig, opts) {
  if (!opts || !opts.proxyBase || !bhIsHttp(orig)) return orig;
  const base = String(opts.proxyBase).trim();
  if (!base) return orig;
  const sep  = base.includes("?") ? "&" : "?";
  const jpeg = opts.isWebpSupported ? "0" : "1"; // jpeg=1 when WebP unsupported
  const bw   = opts.grayscale ? "1" : "0";
  const parts = [
    "url="     + encodeURIComponent(orig),
    "jpeg="    + jpeg,
    "bw="      + bw,
    "quality=" + encodeURIComponent(String(opts.quality ?? 40)),
  ];
  if (opts.maxWidth) parts.push("max_width=" + encodeURIComponent(String(opts.maxWidth)));
  return base + sep + parts.join("&");
}
