// Bandwidth Guardian — shared code (single source of truth)
//
// One classic script, loaded everywhere the same logic is needed:
//   • page MAIN world      — listed before prehook.js in manifest content_scripts
//   • isolated world       — listed before content.js in manifest content_scripts
//   • service worker       — importScripts("shared.js") (classic worker; Kiwi/
//                            Cromite do not support module service workers)
//   • popup / options      — `import "./shared.js"` (side-effect import)
//
// Each world gets its own copy. It publishes one frozen object on
// globalThis.__bhShared; the DOM-world consumers (prehook.js, content.js)
// capture it synchronously and delete the global so page scripts never see it.
// Nothing here touches the DOM or chrome.* at load time.
(function () {
  "use strict";

  const DEFAULTS = Object.freeze({
    enabled:        true,
    saveData:       true,
    proxyBase:      "",
    quality:        60,    // matches the original Bandwidth Hero compressionLevel
    grayscale:      true,  // matches the original convertBw: true
    maxWidth:       768,   // 0 = no limit
    excludeDomains: "",
  });

  // bhp2 clamps max_width to 0–8192; the options page enforces the same range.
  const MAX_WIDTH_LIMIT = 8192;

  const sameOpts = (a, b) => !!a && !!b && Object.keys(DEFAULTS).every(k => a[k] === b[k]);

  // Known ad/tracking image URLs (ported from the original shouldCompress.js).
  // Pixel/cleardot only match as the start of a file name: the old
  // `(?:pixel|cleardot)\.*\.(?:gif|jpg|jpeg)` only ever matched "pixel.gif".
  const TRACKING_RE = new RegExp([
    "pagead",
    "\\/(?:pixel|cleardot)[^/?#]*\\.(?:gif|jpe?g)(?:[?#]|$)",
    "google\\.(?:[a-z.]+)\\/(?:ads|generate_204|.*\\/log204)+",
    "google-analytics\\.(?:[a-z.]+)\\/(?:r|collect)+",
    "youtube\\.(?:[a-z.]+)\\/(?:api|ptracking|player_204|live_204)+",
    "doubleclick\\.(?:[a-z.]+)\\/(?:pcs|pixel|r)+",
    "googlesyndication\\.(?:[a-z.]+)\\/ddm",
    "pixel\\.facebook\\.(?:[a-z.]+)",
    "facebook\\.(?:[a-z.]+)\\/(?:impression\\.php|tr)+",
    "ad\\.bitmedia\\.io",
    "yahoo\\.(?:[a-z.]+)\\/pixel",
    "criteo\\.net\\/img",
    "ad\\.doubleclick\\.net",
  ].join("|"), "i");

  // Favicons, .ico and .svg are never proxied (URL-only check).
  const SKIP_URL_RE = /favicon|\.(?:ico|svg)(?:[?#]|$)/i;

  // Generic lazy attributes can point at video/audio/fonts/scripts/documents.
  const NON_IMAGE_EXT_RE = /\.(?:mp4|webm|m3u8|mpd|mp3|ogg|wav|js|mjs|css|json|html?|php|pdf|zip|woff2?|ttf)(?:[?#]|$)/i;

  const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

  // "https://Www.Example.com/path, foo.org" -> ["www.example.com", "foo.org"]
  function parseDomainList(text) {
    return String(text || "").split(/[,\s]+/)
      .map(s => s.trim().toLowerCase()).filter(Boolean)
      .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""))
      .filter(Boolean);
  }

  const isValidHostname = s => HOSTNAME_RE.test(String(s || ""));

  // Returns host => true when host or any parent domain is in the list.
  function makeHostMatcher(list) {
    const set = new Set(list);
    return host => {
      let h = String(host || "").toLowerCase().replace(/\.$/, "");
      while (h) {
        if (set.has(h)) return true;
        const dot = h.indexOf(".");
        if (dot < 0) break;
        h = h.slice(dot + 1);
      }
      return false;
    };
  }

  function parseProxyBase(base) {
    try {
      const u = new URL(String(base || "").trim());
      return u.protocol === "http:" || u.protocol === "https:" ? u : null;
    } catch { return null; }
  }

  // Everything derived from a settings object. `active` is the single
  // definition of "images should be proxied": enabled AND a valid proxy URL.
  function normalizeProxyConfig(opts) {
    const o = opts || DEFAULTS;
    const base = String(o.proxyBase || "").trim();
    const parsed = parseProxyBase(base);
    const quality = Math.max(1, Math.min(100, Math.round(Number(o.quality ?? DEFAULTS.quality)) || DEFAULTS.quality));
    const width = Math.round(Number(o.maxWidth) || 0);
    return Object.freeze({
      base,
      sep: base.includes("?") ? "&" : "?",
      quality,
      maxWidth: width > 0 ? Math.min(width, MAX_WIDTH_LIMIT) : 0,
      grayscale: !!o.grayscale,
      host: parsed ? parsed.hostname.toLowerCase() : "",
      origin: parsed ? parsed.origin : "",
      active: o.enabled !== false && !!parsed,
    });
  }

  const isHttp = u => /^https?:\/\//i.test(String(u || ""));

  // Small LRU of original URL -> proxy URL, per config.
  function createProxyUrlBuilder(limit = 512) {
    const cache = new Map();
    return {
      clear() { cache.clear(); },
      build(config, orig) {
        if (!config || !config.base || !isHttp(orig)) return orig;
        const hit = cache.get(orig);
        if (hit !== undefined) {
          cache.delete(orig);
          cache.set(orig, hit);
          return hit;
        }
        const parts = [
          "url=" + encodeURIComponent(orig),
          "jpeg=0", // every supported browser handles WebP
          "bw=" + (config.grayscale ? "1" : "0"),
          "quality=" + config.quality,
        ];
        if (config.maxWidth) parts.push("max_width=" + config.maxWidth);
        const result = config.base + config.sep + parts.join("&");
        if (cache.size >= limit) cache.delete(cache.keys().next().value);
        cache.set(orig, result);
        return result;
      },
    };
  }

  // Original image URL carried by a configured-proxy URL, or null.
  function originalFromProxyUrl(url, config) {
    if (!config || !config.host) return null;
    try {
      const u = new URL(String(url || ""));
      if (u.hostname.toLowerCase() !== config.host) return null;
      const orig = u.searchParams.get("url");
      return orig && isHttp(orig) ? orig : null;
    } catch { return null; }
  }

  // Spec-style srcset parser: a comma inside a URL (e.g. Cloudinary
  // "w_400,h_300") is part of the URL; only a trailing comma or a comma after
  // descriptors ends a candidate.
  function parseSrcset(ss) {
    const out = [];
    const s = String(ss || "");
    const n = s.length;
    let i = 0;
    while (i < n) {
      while (i < n && /[\s,]/.test(s[i])) i++;
      if (i >= n) break;
      const start = i;
      while (i < n && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let desc = "";
      if (url.endsWith(",")) {
        url = url.replace(/,+$/, "");
      } else {
        const d = i;
        while (i < n && s[i] !== ",") i++;
        desc = s.slice(d, i).trim();
      }
      if (url) out.push({ url, desc });
    }
    return out;
  }

  // Rewrites each candidate URL with fn(url) (return null to keep it).
  function mapSrcset(ss, fn) {
    let touched = false;
    const parts = parseSrcset(ss).map(({ url, desc }) => {
      const next = fn(url);
      if (next != null && next !== url) touched = true;
      return (next ?? url) + (desc ? " " + desc : "");
    });
    return touched ? parts.join(", ") : String(ss || "");
  }

  // srcset with every configured-proxy candidate replaced by its original.
  function unproxySrcset(ss, config) {
    if (!ss || !config || !config.host || !String(ss).includes(config.host)) return String(ss || "");
    return mapSrcset(ss, url => originalFromProxyUrl(url, config));
  }

  // Popup/options writes: storage.sync is authoritative, and the storage.local
  // mirror that content scripts read first is updated in the same step, so a
  // tab reloaded right after a change never reads stale settings.
  async function saveSettings(patch) {
    await chrome.storage.sync.set(patch);
    const all = await chrome.storage.sync.get(DEFAULTS);
    await chrome.storage.local.set({ bhOpts: all });
    return all;
  }

  // ── Cross-world DOM contract ──────────────────────────────────────────────
  // prehook.js (MAIN world) and content.js (isolated world) cannot share JS
  // objects, only the DOM. These names are that contract.
  const FAILED_ATTR = "data-bh-failed";           // proxy failed: never proxy again
  const ORIG_SRCSET_ATTR = "data-bh-orig-srcset"; // original <source> srcset
  const TIMEOUT_EVENT = "bh-proxy-timeout";       // content.js: proxy load stalled
  const BRIDGE_KEY = "__bhBridge";                // settings MessageChannel handshake

  // Per-world proxy-failure fallback. Restores the ORIGINAL URLs (recovered
  // from the proxy URLs themselves, so it works for every path: parser,
  // property setters, lazy loaders, queued elements, <picture> sources) once,
  // then flags the element so neither world proxies it again.
  // Native setters are injected because each world has its own.
  function createFallback({ getConfig, setSrc, setSrcset, setSourceSrcset, setAttr }) {
    const armed = new WeakSet();
    const isFailed = el => !!el && el.nodeType === 1 && el.hasAttribute(FAILED_ATTR);
    const markFailed = el => { try { setAttr.call(el, FAILED_ATTR, ""); } catch {} };

    function pictureSources(img) {
      const p = img.parentElement;
      if (!p || p.tagName !== "PICTURE") return [];
      return Array.from(p.children).filter(c => c.tagName === "SOURCE" && c.hasAttribute(ORIG_SRCSET_ATTR));
    }

    function restore(img) {
      const config = getConfig();
      if (isFailed(img) || !config || !config.host) return;
      const host = config.host;
      const srcAttr = img.getAttribute("src") || "";
      const srcsetAttr = img.getAttribute("srcset") || "";
      const sources = pictureSources(img);
      // Only act when the proxy is actually involved; a page that later points
      // the element at its own broken URL must not be overridden.
      if (!srcAttr.includes(host) && !srcsetAttr.includes(host) &&
          !String(img.currentSrc || "").includes(host) && !sources.length) return;
      markFailed(img);
      for (const source of sources) {
        const original = source.getAttribute(ORIG_SRCSET_ATTR) || "";
        markFailed(source);
        source.removeAttribute(ORIG_SRCSET_ATTR);
        try { setSourceSrcset.call(source, original); } catch {}
      }
      if (srcsetAttr.includes(host)) {
        try { setSrcset.call(img, unproxySrcset(srcsetAttr, config)); } catch {}
      }
      if (srcAttr.includes(host)) {
        let absolute = srcAttr;
        try { absolute = new URL(srcAttr, img.baseURI).href; } catch {}
        const original = originalFromProxyUrl(absolute, config);
        if (original) { try { setSrc.call(img, original); } catch {} }
      }
    }

    function arm(img) {
      if (!img || img.tagName !== "IMG" || isFailed(img) || armed.has(img)) return;
      armed.add(img);
      const handler = () => { try { restore(img); } catch {} };
      img.addEventListener("error", handler, true);
      img.addEventListener(TIMEOUT_EVENT, handler, true);
    }

    // A proxied <source> fails through its <picture>'s <img>.
    function armPicture(source) {
      const p = source && source.parentElement;
      if (!p || p.tagName !== "PICTURE") return;
      for (const c of p.children) if (c.tagName === "IMG") arm(c);
    }

    return { isFailed, markFailed, arm, armPicture, restore };
  }

  globalThis.__bhShared = Object.freeze({
    DEFAULTS, MAX_WIDTH_LIMIT, sameOpts,
    TRACKING_RE, SKIP_URL_RE, NON_IMAGE_EXT_RE,
    parseDomainList, isValidHostname, makeHostMatcher,
    parseProxyBase, normalizeProxyConfig, isHttp,
    createProxyUrlBuilder, originalFromProxyUrl,
    parseSrcset, mapSrcset, unproxySrcset,
    saveSettings,
    FAILED_ATTR, ORIG_SRCSET_ATTR, TIMEOUT_EVENT, BRIDGE_KEY, createFallback,
  });
})();
