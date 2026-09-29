// Bandwidth Guardian — shared content-script constants & helpers
//
// Loaded first — see manifest.json's single `content_scripts` entry:
// "js": ["shared.js", "prehook.js", "content.js"]. All three run in the same
// per-frame isolated world, so the top-level declarations below are ordinary
// globals to prehook.js and content.js.
//
// This file holds the pure logic (defaults, tracking patterns, the "leave this
// URL alone?" decision, proxy-URL builder, srcset parsing/rewriting). The
// storage-backed options loader now lives in content.js, its only consumer
// left; prehook.js is handed options through the small hook it exposes (see
// prehook.js).
//
// service-worker.js and defaults.js (ES module for popup/options) keep their
// own copies of DEFAULTS because they run in contexts that cannot load this
// file. Keep the three in sync.

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

// One combined regex is a single pass per URL instead of 13 separate tests.
const BH_TRACKING_RE = new RegExp(BH_TRACKING_PATTERNS.map(p => p.source).join("|"), "i");

function bhSafeURL(u) { try { return new URL(u); } catch { return null; } }
function bhIsHttp(u) { return /^https?:\/\//i.test(u); }

// Resolves relative ("/img/a.jpg"), protocol-relative ("//cdn.x/a.jpg") and
// absolute URLs against the document base. Returns an absolute http(s) URL
// string, or null for data:/blob:/about:/javascript: and unparsable input.
// Previously only URLs already starting with http(s):// were ever proxied, so
// every relative or protocol-relative image was silently left uncompressed.
function bhAbsUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (bhIsHttp(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // data:, blob:, about:, ...
  try {
    const u = new URL(s, document.baseURI);
    return (u.protocol === "http:" || u.protocol === "https:") ? u.href : null;
  } catch { return null; }
}

const BH_IMG_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
function bhLooksLikeImage(url) {
  const u = bhSafeURL(url);
  return !!u && BH_IMG_EXT_RE.test(u.pathname);
}

function bhDomainSet(text) {
  return new Set(
    String(text || "").split(/[,\s]+/)
      .map(s => s.trim().toLowerCase()).filter(Boolean)
      .map(s => s.replace(/^https?:\/\//, "").split("/")[0])
      .map(s => s.replace(/^\*?\./, "").replace(/\.$/, ""))
      .filter(Boolean)
  );
}

// Image-heavy pages can evaluate this helper thousands of times. Rebuild the
// parsed Set only when the options object or its excludeDomains text changes.
const BH_DOMAIN_SET_CACHE = new WeakMap();
function bhCachedDomainSet(opts) {
  const key  = (opts && typeof opts === "object") ? opts : BH_DEFAULTS;
  const text = String(opts?.excludeDomains || "");
  let cached = BH_DOMAIN_SET_CACHE.get(key);
  if (!cached || cached.text !== text) {
    cached = { text, set: bhDomainSet(text) };
    BH_DOMAIN_SET_CACHE.set(key, cached);
  }
  return cached.set;
}

function bhHostMatchesDomain(hostname, domainSet) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return false;
  for (const domain of domainSet) {
    if (host === domain || host.endsWith("." + domain)) return true;
  }
  return false;
}

// The single decision point for "leave this URL alone": disabled extension,
// excluded image host, excluded *page* host (so "Exclude this site" covers
// subdomains too), an already-proxied URL (same host as the configured proxy —
// avoids double-wrapping a URL content.js already rewrote), tracking-pixel
// patterns, and .ico/.svg/favicon paths.
function bhShouldSkip(url, hostname, opts, pageHostname) {
  if (!opts) return false;
  if (opts.enabled === false) return true;
  const host = String(hostname || "").toLowerCase();
  const ex = bhCachedDomainSet(opts);
  if (bhHostMatchesDomain(host, ex)) return true;
  if (pageHostname && bhHostMatchesDomain(pageHostname, ex)) return true;
  const proxyHost = opts.proxyBase ? bhSafeURL(opts.proxyBase)?.hostname?.toLowerCase() : null;
  if (proxyHost && host === proxyHost) return true;
  const parsed = bhSafeURL(String(url || ""));
  const path = (parsed ? parsed.pathname : String(url || "").split(/[?#]/)[0]).toLowerCase();
  if (path.endsWith(".ico") || path.endsWith(".svg")) return true;
  if (path.includes("favicon")) return true;
  if (BH_TRACKING_RE.test(String(url || ""))) return true;
  return false;
}

// Builds the proxy URL with the full param set, all values properly
// encoded (Chrome's DNR regexSubstitution can't do this — see
// service-worker.js for why that matters).
function bhBuildProxyUrl(orig, opts) {
  if (!opts || opts.enabled === false || !opts.proxyBase || !bhIsHttp(orig)) return orig;
  const base = String(opts.proxyBase).trim();
  if (!base) return orig;

  // Keep any fragment after the generated query string. Appending directly to
  // a proxyBase such as "https://proxy.example/path#section" would otherwise
  // place every parameter inside the fragment where the proxy never sees it.
  const hashAt = base.indexOf("#");
  const hash = hashAt === -1 ? "" : base.slice(hashAt);
  const baseNoHash = hashAt === -1 ? base : base.slice(0, hashAt);
  const sep = baseNoHash.includes("?") ? "&" : "?";

  const jpeg = opts.isWebpSupported ? "0" : "1"; // jpeg=1 when WebP unsupported
  const bw   = opts.grayscale ? "1" : "0";
  const parts = [
    "url="     + encodeURIComponent(orig),
    "jpeg="    + jpeg,
    "bw="      + bw,
    "quality=" + encodeURIComponent(String(opts.quality ?? 40)),
  ];
  if (opts.maxWidth) parts.push("max_width=" + encodeURIComponent(String(opts.maxWidth)));
  return baseNoHash + sep + parts.join("&") + hash;
}

// Spec-style srcset parser. Commas only separate candidates when they are not
// part of the URL token, so Cloudinary/imgix-style URLs such as
// ".../w_300,h_200/a.jpg 1x" and data: URLs are kept intact. The old
// split(",") approach cut those URLs in half and proxied the broken fragment.
function bhParseSrcset(str) {
  const s = String(str || "");
  const out = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i);
    let desc = "";
    if (/,+$/.test(url)) {
      url = url.replace(/,+$/, "");
    } else {
      const dStart = i;
      let depth = 0;
      while (i < n) {
        const c = s[i];
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (c === "," && depth === 0) break;
        i++;
      }
      desc = s.slice(dStart, i).trim();
    }
    if (url) out.push({ url, desc });
  }
  return out;
}

// Single srcset rewriter shared by prehook.js and content.js. Relative URLs
// are resolved to absolute; anything non-http(s) is left as-is.
function bhRewriteSrcset(srcset, opts, pageHostname = location.hostname) {
  if (!srcset || !opts || opts.enabled === false || !opts.proxyBase) return srcset;

  let touched = false;
  const parts = bhParseSrcset(srcset).map(({ url, desc }) => {
    const abs = bhAbsUrl(url);
    const u = abs && bhSafeURL(abs);
    if (!u || bhShouldSkip(abs, u.hostname, opts, pageHostname)) return url + (desc ? " " + desc : "");
    touched = true;
    return bhBuildProxyUrl(abs, opts) + (desc ? " " + desc : "");
  });

  return touched ? parts.join(", ") : srcset;
}
