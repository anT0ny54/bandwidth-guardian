// Bandwidth Guardian — prehook (document_start, page MAIN world).
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
  "use strict";

  // KEEP IN SYNC WITH content.js: FAILED_ATTR / RESTORED_ATTR, event contract.
  const DEFAULT_SETTINGS_EVENT = "bh-settings-update";

  let opts = null;
  let ready = false;
  let active = false; // ready && enabled && proxyBase set && !pageExcluded (O1)
  let excludedDomains = new Set();
  let proxyConfig = null;
  let proxyOrigin = "";
  let redirectLive = true; // network redirect owns non-conflict URLs
  let suspended = false;   // circuit breaker open: proxy nothing
  let failedUrls = new Set(); // originals whose proxy request failed in this tab
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;

  // Keep every element waiting for settings. A hard queue cap lets later
  // parser-created images fall through with their original URL (and setter-
  // queued images can remain blank forever). The queue is temporary: settings
  // normally arrive quickly, and the watchdog releases it after five seconds.
  const pending = new Set();
  function queuePending(el) {
    if (el) pending.add(el);
  }

  const fallbackHandlers = new WeakSet();
  const fallbackMeta = new WeakMap();

  const FAILED_ATTR = "data-bh-failed";
  const RESTORED_ATTR = "data-bh-restored"; // cross-world one-shot restore dedupe (B5)
  const isFailed = el => !!el && el.nodeType === 1 && el.hasAttribute(FAILED_ATTR);
  const markFailed = el => { try { el.setAttribute(FAILED_ATTR, ""); } catch {} };

  const safeURL = (u, base = document.baseURI) => { try { return new URL(u, base); } catch { return null; } };
  const resolveHttp = u => {
    const r = safeURL(u);
    return r && /^https?:$/.test(r.protocol) ? r.href : null;
  };
  const isHttp = u => /^https?:\/\//i.test(u);
  const toDomainSet = text => new Set(
    String(text || "").split(/[, \n\r\t]+/)
      .map(s => s.trim().toLowerCase()).filter(Boolean)
      .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""))
  );

  // Anchored tracking-pixel patterns (B13): boundaries prevent false hits like
  // facebook.com/tracy.jpg or /products/pagead-banner.jpg; the useless `(…)+`
  // quantifiers are gone. KEEP IN SYNC with content.js.
  const SKIP_URL_RE = /favicon|\.(?:ico|svg)(?:[?#]|$)/i;
  // URLs the raw-URL redirect cannot carry (KEEP IN SYNC with CONFLICT_PATTERN
  // in service-worker.js and PROXY_PARAMETER in bandwidth-hero-proxy2).
  const CONFLICT_RE = /&(?:quality|l|bw|jpeg|max_width)=/;
  // true when THIS layer (not the network redirect) must proxy the URL.
  const domHandles = absolute => !redirectLive || CONFLICT_RE.test(absolute);
  // Before settings arrive, only URLs that the DOM layer would have to proxy
  // are held; everything else is already covered by the network redirect.
  const mustHold = absolute => !!absolute && CONFLICT_RE.test(absolute);
  const srcsetNeedsHold = ss => parseSrcset(String(ss || "")).some(c => mustHold(resolveHttp(c.url)));
  const TRACKING_RE = /(?:\/|\.)pagead(?:[/?#]|$)|(?:pixel|cleardot)\.*\.(?:gif|jpe?g)(?:[?#]|$)|google\.[a-z.]+\/(?:ads|generate_204|.*\/log204)(?:[?#]|$)|google-analytics\.[a-z.]+\/(?:r|collect)(?:[?#]|$)|youtube\.[a-z.]+\/(?:api|ptracking|player_204|live_204)(?:[?#]|$)|doubleclick\.[a-z.]+\/(?:pcs|pixel|r)(?:[?#]|$)|googlesyndication\.[a-z.]+\/ddm(?:[?#]|$)|pixel\.facebook\.[a-z.]+|facebook\.[a-z.]+\/(?:tr|impression\.php)(?:[?#]|$)|ad\.bitmedia\.io(?:\/?#|$)|yahoo\.[a-z.]+\/pixel(?:[?#]|$)|criteo\.net\/img(?:[?#]|$)|ad\.doubleclick\.net(?:\/?#|$)/i;

  // C2: proxy identity is ORIGIN-based, matching the service worker.
  const isConfiguredProxyUrl = u => {
    try { return !!proxyOrigin && new URL(u).origin === proxyOrigin; } catch { return false; }
  };

  let srcsetCache = new WeakMap();
  let destroyed = false;
  let preloadObserver = null;
  let linkAttrObserver = null;

  function armProxyFallback(el, originalSrc, originalSrcset) {
    if (!el || !(el instanceof HTMLImageElement) || isFailed(el)) return;
    // Merge: src and srcset are armed by separate calls; one must not erase the other.
    const prev = fallbackMeta.get(el) || {};
    fallbackMeta.set(el, {
      originalSrc: originalSrc || prev.originalSrc || "",
      originalSrcset: originalSrcset || prev.originalSrcset || ""
    });
    if (fallbackHandlers.has(el)) return;
    fallbackHandlers.add(el);
    el.addEventListener("error", () => {
      // B5: restore ONLY when the URL that failed is actually a proxy URL.
      const cur = el.currentSrc || el.src || "";
      if (!isConfiguredProxyUrl(cur)) return;
      if (el.hasAttribute(RESTORED_ATTR)) return; // the other world already restored
      const meta = fallbackMeta.get(el);
      if (!meta) return;
      fallbackMeta.delete(el);
      try { el.setAttribute(RESTORED_ATTR, ""); } catch {}
      // Never proxy this element again, otherwise the restored original is
      // re-proxied and a failing proxy is hit in an endless loop.
      markFailed(el);
      try { if (meta.originalSrcset) nativeSetSrcset(el, meta.originalSrcset); } catch {}
      try { if (meta.originalSrc) nativeSetSrc(el, meta.originalSrc); } catch {}
    }, true);
    // B5: a successful load disarms the fallback (a later, unrelated failing
    // src must not trigger a restore).
    el.addEventListener("load", () => fallbackMeta.delete(el), { capture: true, once: true });
  }

  function updateProxyConfig(next) {
    opts = next;
    const base = String(opts.proxyBase || "").trim();
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
    const maxWidth = Number(opts.maxWidth) || 0;
    proxyConfig = { base, sep: base.includes("?") ? "&" : "?", quality,
      maxWidth: maxWidth > 0 ? maxWidth : 0, grayscale: !!opts.grayscale };
    try { proxyOrigin = new URL(base).origin; } catch { proxyOrigin = ""; }
  }

  function applyOpts(next) {
    updateProxyConfig(next);
    srcsetCache = new WeakMap();
    excludedDomains = toDomainSet(opts.excludeDomains);
    proxyUrlCache.clear();
    pageExcluded = excludedHost(pageHost);
    redirectLive = next.redirect !== false;
    failedUrls = new Set(Array.isArray(next.failed) ? next.failed : []);
    suspended = !!next.suspended;
    ready = true;
    active = !!opts.enabled && !!proxyConfig.base && !pageExcluded && !suspended;
  }

  function buildProxyUrl(orig) {
    if (!proxyConfig || !proxyConfig.base || !isHttp(orig)) return orig;
    const cached = proxyUrlCache.get(orig);
    if (cached !== undefined) {
      proxyUrlCache.delete(orig); // true LRU: refresh insertion order on hit
      proxyUrlCache.set(orig, cached);
      return cached;
    }
    const { base, sep, quality, maxWidth, grayscale } = proxyConfig;
    const parts = [
      "url=" + encodeURIComponent(orig),
      "jpeg=0", // every supported browser handles WebP
      "bw=" + (grayscale ? "1" : "0"),
      "quality=" + quality
    ];
    if (maxWidth) parts.push("max_width=" + encodeURIComponent(String(maxWidth)));
    const result = base + sep + parts.join("&");
    if (proxyUrlCache.size >= PROXY_CACHE_LIMIT) proxyUrlCache.delete(proxyUrlCache.keys().next().value);
    proxyUrlCache.set(orig, result);
    return result;
  }

  function excludedHost(host) {
    let h = String(host || "").toLowerCase().replace(/\.$/, "");
    while (h) {
      if (excludedDomains.has(h)) return true;
      const dot = h.indexOf(".");
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    return false;
  }

  function stop() {
    if (destroyed) return;
    destroyed = true;
    try { preloadObserver && preloadObserver.disconnect(); } catch {}
    try { linkAttrObserver && linkAttrObserver.disconnect(); } catch {}
    try { settingsRetryMo && settingsRetryMo.disconnect(); } catch {}
    try { document.removeEventListener(settingsEvent, onSettings); } catch {}
    try { pending.clear(); } catch {}
    try { proxyUrlCache.clear(); } catch {}
    clearTimeout(settingsWatchdogTimer);
    srcsetCache = new WeakMap();
  }

  function flushPending() {
    if (destroyed) return;
    // Snapshot then clear so this function is safe if restoring an element
    // triggers another setter. Every queued element is processed, including
    // pages containing far more than 1,000 images.
    const toFlush = Array.from(pending);
    pending.clear();
    for (const el of toFlush) {
      try {
        if (el instanceof HTMLLinkElement) { processPreloadLink(el); continue; }
        if (el instanceof HTMLImageElement && loadingDesc && loadingDesc.set) {
          const pendingLoading = el.dataset.bhPendingLoading;
          if (pendingLoading !== undefined) {
            el.removeAttribute("data-bh-pending-loading");
            loadingDesc.set.call(el, !active
              ? pendingLoading
              : (pendingLoading === "eager" ? "eager" : "lazy"));
          }
        }
        const pendingSrc = el.dataset.bhPendingSrc;
        if (pendingSrc && el instanceof HTMLImageElement) {
          el.removeAttribute("data-bh-pending-src");
          const decided = decideSrc(pendingSrc);
          // B7: queued values get the same treatment as live-set ones,
          // including an armed fallback.
          if (decided !== null && decided !== pendingSrc) {
            armProxyFallback(el, resolveHttp(pendingSrc) || pendingSrc, el.getAttribute("srcset") || "");
          }
          nativeSetSrc(el, decided ?? pendingSrc);
        }
        const pendingSrcset = el.dataset.bhPendingSrcset;
        if (pendingSrcset) {
          el.removeAttribute("data-bh-pending-srcset");
          if (!active) { // B7: honor `enabled`
            if (el instanceof HTMLImageElement) nativeSetSrcset(el, pendingSrcset);
            else if (sourceProto && el instanceof HTMLSourceElement) nativeSourceSetSrcset(el, pendingSrcset);
          } else {
            const rewritten = rewriteSrcset(pendingSrcset, el);
            if (el instanceof HTMLImageElement) {
              if (rewritten !== pendingSrcset) armProxyFallback(el, "", pendingSrcset);
              nativeSetSrcset(el, rewritten);
            } else if (sourceProto && el instanceof HTMLSourceElement) {
              nativeSourceSetSrcset(el, rewritten);
            }
          }
        }
      } catch {}
    }
  }

  // ── Settings channel ────────────────────────────────────────────────────────
  // A per-load random event name keeps settings updates off
  // the well-known default name (which this script's own DEFAULT_SETTINGS_EVENT
  // fallback would accept anyway). The name is exposed through a DOM attribute
  // set at document_start and read by content.js at publish time — so it is an
  // obfuscation measure only: a page that reads the attribute can forge
  // updates. Falls back to the default name when documentElement is missing.
  function onSettings(event) {
    if (destroyed) return;
    try {
      const raw = event?.detail;
      const next = typeof raw === "string" ? JSON.parse(raw) : null;
      if (!next || typeof next !== "object") return;
      if (next.kind === "retry") { retryFailed(Array.isArray(next.items) ? next.items : []); return; }
      applyOpts({
        enabled: next.enabled !== false,
        proxyBase: typeof next.proxyBase === "string" ? next.proxyBase : "",
        quality: next.quality,
        grayscale: next.grayscale,
        maxWidth: next.maxWidth,
        excludeDomains: typeof next.excludeDomains === "string" ? next.excludeDomains : "",
        redirect: next.redirect !== false,
        suspended: !!next.suspended,
        failed: Array.isArray(next.failed) ? next.failed.filter(u => typeof u === "string") : []
      });
      flushPending();
    } catch {}
  }

  const RANDOM_SETTINGS_EVENT = "bh-settings-" + Math.random().toString(36).slice(2, 10);
  let settingsEvent = DEFAULT_SETTINGS_EVENT;
  let settingsRetryMo = null;
  try {
    if (document.documentElement) {
      document.documentElement.dataset.bhSettingsEvent = RANDOM_SETTINGS_EVENT;
      settingsEvent = RANDOM_SETTINGS_EVENT;
    }
  } catch {}
  document.addEventListener(settingsEvent, onSettings);
  if (settingsEvent === DEFAULT_SETTINGS_EVENT) {
    // documentElement not parsed yet at injection: switch to the random name
    // as soon as <html> appears (always before content.js's first publish,
    // which is behind an async storage read).
    settingsRetryMo = new MutationObserver(() => {
      try {
        if (document.documentElement) {
          document.documentElement.dataset.bhSettingsEvent = RANDOM_SETTINGS_EVENT;
          document.removeEventListener(DEFAULT_SETTINGS_EVENT, onSettings);
          document.addEventListener(RANDOM_SETTINGS_EVENT, onSettings);
          settingsEvent = RANDOM_SETTINGS_EVENT;
          settingsRetryMo.disconnect();
        }
      } catch {}
    });
    settingsRetryMo.observe(document, { childList: true });
  }

  // #7: watchdog — if settings never arrive, release queued elements with
  // proxying OFF (previously this applied the install defaults, which have
  // enabled:true). R4: no full `defaults` object is kept for this.
  const SETTINGS_WATCHDOG_MS = 5000;
  const settingsWatchdogTimer = setTimeout(() => {
    if (!destroyed && !ready) {
      applyOpts({ enabled: false, proxyBase: "", quality: 60, grayscale: true, maxWidth: 768, excludeDomains: "" });
      flushPending();
    }
  }, SETTINGS_WATCHDOG_MS);

  // ── Capture native property descriptors BEFORE patching ────────────────────
  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const setAttr = Element.prototype.setAttribute;
  const sourceProto = HTMLSourceElement?.prototype;
  const sourceSrcsetDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;
  const loadingDesc = Object.getOwnPropertyDescriptor(imgProto, "loading");
  const linkProto = HTMLLinkElement.prototype;
  const linkHrefDesc = Object.getOwnPropertyDescriptor(linkProto, "href");

  function nativeSetSrc(el, v) { srcDesc.set.call(el, v); }
  function nativeSetSrcset(el, v) { srcsetDesc?.set?.call(el, v); }
  function nativeSourceSetSrcset(el, v) { sourceSrcsetDesc?.set?.call(el, v); }

  // Spec-style srcset parser (KEEP IN SYNC with content.js): commas inside a
  // URL (Cloudinary "w_400,h_300") belong to the URL, not the candidate list.
  function parseSrcset(ss) {
    const out = [];
    const n = ss.length;
    let i = 0;
    while (i < n) {
      while (i < n && /[\s,]/.test(ss[i])) i++;
      if (i >= n) break;
      const s = i;
      while (i < n && !/\s/.test(ss[i])) i++;
      let url = ss.slice(s, i);
      let desc = "";
      if (url.endsWith(",")) { url = url.replace(/,+$/, ""); }
      else { const d = i; while (i < n && ss[i] !== ",") i++; desc = ss.slice(d, i).trim(); }
      if (url) out.push({ url, desc });
    }
    return out;
  }

  function skipAbsolute(absolute) {
    if (isConfiguredProxyUrl(absolute) || SKIP_URL_RE.test(absolute) ||
        TRACKING_RE.test(absolute)) return true;
    const u = safeURL(absolute);
    if (!u) return true;
    if (failedUrls.size) { const h = u.hash; u.hash = ""; const bad = failedUrls.has(u.href); u.hash = h; if (bad) return true; }
    return excludedHost(u.hostname);
  }

  function rewriteSrcset(ss, el) {
    if (!ss) return ss;
    if (pageExcluded) return ss;
    if (el) {
      const cached = srcsetCache.get(el);
      if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    }
    const cands = parseSrcset(ss);
    let touched = false;
    const parts = cands.map(({ url, desc }) => {
      const absolute = resolveHttp(url);
      // Non-conflict candidates stay untouched: the network redirect proxies
      // them, and rewriting them here as well would proxy them twice.
      if (!absolute || !domHandles(absolute) || skipAbsolute(absolute)) return url + (desc ? " " + desc : "");
      touched = true;
      return buildProxyUrl(absolute) + (desc ? " " + desc : "");
    });
    const output = touched ? parts.join(", ") : ss;
    if (el) srcsetCache.set(el, { input: ss, output });
    return output;
  }

  function decideSrc(original) {
    if (!original || !String(original).trim()) return original; // clearing src
    const absolute = resolveHttp(original);
    if (!absolute) return original;
    if (isConfiguredProxyUrl(absolute)) return original; // don't double-wrap
    if (!ready || !opts) return mustHold(absolute) ? null : original; // queue only DOM-layer URLs
    if (!active) return original;
    if (!domHandles(absolute) || skipAbsolute(absolute)) return original;
    return buildProxyUrl(absolute);
  }
  
  // ── <link rel="preload" as="image"> ───────────────────────────────────────
  const isImagePreloadLink = el =>
    el instanceof HTMLLinkElement &&
    /(?:^|\s)preload(?:\s|$)/i.test(el.rel || "") &&
    (String(el.getAttribute("as") || "").toLowerCase() === "image" ||
     /^image\//i.test(el.getAttribute("type") || ""));

  function processPreloadLink(el) {
    try {
      if (destroyed) return;
      if (!isImagePreloadLink(el)) return;
      const stashed = el.dataset.bhPreloadHref;
      const current = el.getAttribute("href");
      const original = stashed || current;
      if (!original) return;
      const decided = decideSrc(original);
      if (decided === null) {
        // Settings not loaded yet: stash the original and drop href so the
        // browser cannot start downloading the full-resolution image.
        if (!stashed) el.dataset.bhPreloadHref = original;
        queuePending(el);
        // B6: remove the attribute instead of writing about:blank — no fake
        // error event, and reads see "absent" rather than a bogus URL.
        if (current !== null) el.removeAttribute("href");
      } else {
        if (stashed) el.removeAttribute("data-bh-preload-href");
        if (current !== decided) setAttr.call(el, "href", decided);
      }
      // Responsive preloads: candidates in imagesrcset get the same per-URL
      // treatment as <img srcset> (only DOM-layer candidates are rewritten).
      const iss = el.getAttribute("imagesrcset");
      if (iss && ready && active) {
        const out = rewriteSrcset(iss, el);
        if (out !== iss) setAttr.call(el, "imagesrcset", out);
      }
    } catch {}
  }

  // HTML parsing bypasses JavaScript property setters. Watch inserted media
  // nodes in MAIN world as early as possible; while settings are pending, stash
  // and remove their URLs so the normal queue can apply the final settings.
  // MutationObserver delivery is asynchronous, so this only narrows the race:
  // it cannot guarantee that the parser has not already started a DNS lookup.
  function processParserImage(el) {
    try {
      if (destroyed || isFailed(el)) return;
      const isImg = el instanceof HTMLImageElement;
      const isSource = !!sourceProto && el instanceof HTMLSourceElement;
      if (!isImg && !isSource) return;

      if (!ready || !opts) {
        if (isImg) {
          const src = el.getAttribute("src");
          if (src && el.dataset.bhPendingSrc === undefined && mustHold(resolveHttp(src))) {
            queuePending(el);
            el.dataset.bhPendingSrc = src;
            el.removeAttribute("src");
          }
        }
        const srcset = el.getAttribute("srcset");
        if (srcset && el.dataset.bhPendingSrcset === undefined && srcsetNeedsHold(srcset)) {
          queuePending(el);
          el.dataset.bhPendingSrcset = srcset;
          el.removeAttribute("srcset");
        }
        return;
      }

      if (!active) return;
      if (isImg) {
        const src = el.getAttribute("src");
        if (src && el.dataset.bhPendingSrc === undefined) {
          const decided = decideSrc(src);
          if (decided !== null && decided !== src) {
            armProxyFallback(el, resolveHttp(src) || src, el.getAttribute("srcset") || "");
            nativeSetSrc(el, decided);
          }
        }
      }
      const srcset = el.getAttribute("srcset");
      if (srcset && el.dataset.bhPendingSrcset === undefined) {
        const rewritten = rewriteSrcset(srcset, el);
        if (rewritten !== srcset) {
          if (isImg) armProxyFallback(el, "", srcset);
          if (isImg) nativeSetSrcset(el, rewritten);
          else nativeSourceSetSrcset(el, rewritten);
        }
      }
    } catch {}
  }

  // ── Patch <img>.src ─────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      try {
        const decided = isFailed(this) ? String(value) : decideSrc(String(value));
        if (decided === null) {
          this.dataset.bhPendingSrc = String(value);