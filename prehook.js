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

  // Elements waiting for settings. The queue is temporary: settings normally
  // arrive quickly, and the watchdog releases it after five seconds.
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
  // Same tokenizer as service-worker.js / content.js / popup.js: split on commas
  // and ANY whitespace (a narrower class here let a pasted non-breaking space
  // glue two domains together, so this layer disagreed with the network rules).
  const toDomainSet = text => new Set(
    String(text || "").split(/[,\s]+/)
      .map(s => s.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""))
      .filter(Boolean)
  );

  // Anchored tracking-pixel patterns (B13): boundaries prevent false hits like
  // facebook.com/tracy.jpg or /products/pagead-banner.jpg; the useless `(…)+`
  // quantifiers are gone. KEEP IN SYNC with content.js.
  const SKIP_URL_RE = /favicon|\.(?:ico|svg)(?:[?#]|$)/i;
  // Keep these URL patterns in sync with PRIVATE_HOST_PATTERNS in service-worker.js.
  // The DOM fallback must never send private/intranet URLs to a public proxy.
  const PRIVATE_HOST_PATTERNS = [
    "^https?://(?:localhost|[^/?#:]*\\.localhost|[^/?#:]*\\.local|[^/?#:.\\[]+)(?::[0-9]+)?(?:[/?#]|$)",
    "^https?://(?:127|10|192\\.168|172\\.(?:1[6-9]|2[0-9]|3[01])|169\\.254)\\.[0-9.]+(?::[0-9]+)?(?:[/?#]|$)",
    "^https?://\\[(?:::1|f[cd][0-9a-f]*:[0-9a-f:]*|fe80:[0-9a-f:%.a-z]*)\\](?::[0-9]+)?(?:[/?#]|$)"
  ];
  const PRIVATE_HOST_RE = PRIVATE_HOST_PATTERNS.map(pattern => new RegExp(pattern, "i"));
  const isPrivateHttpUrl = absolute => PRIVATE_HOST_RE.some(pattern => pattern.test(absolute));
  // URLs the raw-URL redirect cannot carry (KEEP IN SYNC with CONFLICT_PATTERN
  // in service-worker.js and PROXY_PARAMETER in bandwidth-hero-proxy2).
  const CONFLICT_RE = /&(?:quality|l|bw|jpeg|max_width)=/;
  // true when THIS layer (not the network redirect) must proxy the URL.
  const domHandles = absolute => !redirectLive || CONFLICT_RE.test(absolute);
  // Before settings arrive, only URLs that the DOM layer would have to proxy
  // are held; everything else is already covered by the network redirect.
  const mustHold = absolute => !!absolute && CONFLICT_RE.test(absolute);
  const srcsetNeedsHold = ss => parseSrcset(String(ss || "")).some(c => mustHold(resolveHttp(c.url)));
  const TRACKING_RE = /(?:\/|\.)pagead(?:[/?#]|$)|(?:pixel|cleardot)\.*\.(?:gif|jpe?g)(?:[?#]|$)|google\.[a-z.]+\/(?:ads|generate_204|.*\/log204)(?:[?#]|$)|google-analytics\.[a-z.]+\/(?:r|collect)(?:[?#]|$)|youtube\.[a-z.]+\/(?:api|ptracking|player_204|live_204)(?:[?#]|$)|doubleclick\.[a-z.]+\/(?:pcs|pixel|r)(?:[?#]|$)|googlesyndication\.[a-z.]+\/ddm(?:[?#]|$)|pixel\.facebook\.[a-z.]+|facebook\.[a-z.]+\/(?:tr|impression\.php)(?:[?#]|$)|ad\.bitmedia\.io(?:[/?#]|$)|yahoo\.[a-z.]+\/pixel(?:[?#]|$)|criteo\.net\/img(?:[?#]|$)|ad\.doubleclick\.net(?:[/?#]|$)/i;

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
    let base = String(opts.proxyBase || "").trim();
    try {
      const parsed = new URL(base);
      if (!/^https?:$/.test(parsed.protocol)) base = "";
      else { parsed.hash = ""; base = parsed.href; }
    } catch { base = ""; }
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
    const maxWidth = Number(opts.maxWidth) || 0;
    proxyConfig = { base, sep: base.includes("?") ? "&" : "?", quality,
      maxWidth: maxWidth > 0 ? maxWidth : 0, grayscale: !!opts.grayscale };
    try { proxyOrigin = base ? new URL(base).origin : ""; } catch { proxyOrigin = ""; }
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
    if (!u || isPrivateHttpUrl(absolute)) return true;
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
    if (!domHandles(absolute)) return original; // the network redirect owns it
    if (skipAbsolute(absolute)) return original;
    return buildProxyUrl(absolute);
  }

  // ── <link rel="preload" as="image"> ─────────────────────────────────────────
  const isImagePreloadLink = el =>
    el instanceof HTMLLinkElement &&
    /(?:^|\s)preload(?:\s|$)/i.test(el.rel || "") &&
    (String(el.getAttribute("as") || "").toLowerCase() === "image" ||
     /^image\//i.test(el.getAttribute("type") || ""));

  function processPreloadLink(el) {
    try {
      if (destroyed) return;
      if (!isImagePreloadLink(el)) return;

      const stashedHref = el.dataset.bhPreloadHref;
      const stashedSrcset = el.dataset.bhPreloadSrcset;
      const currentHref = el.getAttribute("href");
      const currentSrcset = el.getAttribute("imagesrcset");
      const originalHref = stashedHref || currentHref;
      const originalSrcset = stashedSrcset || currentSrcset;
      if (!originalHref && !originalSrcset) return;

      if (!ready || !opts) {
        // Settings not loaded yet: stash conflict URLs and drop the attributes
        // so the browser cannot start an unproxied request.
        if (originalHref && mustHold(resolveHttp(originalHref))) {
          if (!stashedHref) el.dataset.bhPreloadHref = originalHref;
          queuePending(el);
          // B6: remove the attribute instead of writing about:blank — no fake
          // error event, and reads see "absent" rather than a bogus URL.
          if (currentHref !== null) el.removeAttribute("href");
        }
        if (originalSrcset && srcsetNeedsHold(originalSrcset)) {
          if (!stashedSrcset) el.dataset.bhPreloadSrcset = originalSrcset;
          queuePending(el);
          if (currentSrcset !== null) el.removeAttribute("imagesrcset");
        }
        return;
      }

      if (stashedHref) el.removeAttribute("data-bh-preload-href");
      if (originalHref) {
        const decided = decideSrc(originalHref);
        if (decided === null) {
          if (!stashedHref) el.dataset.bhPreloadHref = originalHref;
          queuePending(el);
          if (currentHref !== null) el.removeAttribute("href");
        } else if (currentHref !== decided) {
          setAttr.call(el, "href", decided);
        }
      }

      if (stashedSrcset) el.removeAttribute("data-bh-preload-srcset");
      // Responsive preloads: candidates in imagesrcset get the same per-URL
      // treatment as <img srcset> (only DOM-layer candidates are rewritten).
      if (originalSrcset) {
        if (!active) {
          if (currentSrcset !== originalSrcset) setAttr.call(el, "imagesrcset", originalSrcset);
        } else {
          const out = rewriteSrcset(originalSrcset, el);
          if (currentSrcset !== out) setAttr.call(el, "imagesrcset", out);
        }
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

  // ── Patch <img>.src ─────────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      try {
        const decided = isFailed(this) ? String(value) : decideSrc(String(value));
        if (decided === null) {
          this.dataset.bhPendingSrc = String(value);
          queuePending(this);
          // B6: write nothing while pending — no about:blank fake error.
        } else {
          if (decided !== String(value)) armProxyFallback(this, resolveHttp(String(value)), this.getAttribute("srcset") || "");
          nativeSetSrc(this, decided);
        }
      } catch { nativeSetSrc(this, value); }
    }
  });

  // ── Patch <img>.srcset ──────────────────────────────────────────────────────
  if (srcsetDesc && srcsetDesc.set) {
    Object.defineProperty(imgProto, "srcset", {
      configurable: true,
      enumerable: srcsetDesc.enumerable,
      get: srcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          if (!ready || !opts) {
            if (!srcsetNeedsHold(v)) { nativeSetSrcset(this, v); return; }
            this.dataset.bhPendingSrcset = v;
            queuePending(this);
            // B6: no native write while pending.
          } else if (!active || isFailed(this)) {
            nativeSetSrcset(this, v);
          } else {
            const rewritten = rewriteSrcset(v, this);
            if (rewritten !== v) armProxyFallback(this, "", v);
            nativeSetSrcset(this, rewritten);
          }
        } catch { nativeSetSrcset(this, value); }
      }
    });
  }

  // ── Patch <source>.srcset inside <picture> ──────────────────────────────────
  if (sourceProto && sourceSrcsetDesc && sourceSrcsetDesc.set) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get: sourceSrcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          if (!ready || !opts) {
            if (!srcsetNeedsHold(v)) { nativeSourceSetSrcset(this, v); return; }
            this.dataset.bhPendingSrcset = v;
            queuePending(this);
          } else if (!active) {
            nativeSourceSetSrcset(this, v);
          } else {
            nativeSourceSetSrcset(this, rewriteSrcset(v, this));
          }
        } catch { nativeSourceSetSrcset(this, value); }
      }
    });
  }

  // ── Patch <img>.loading (force lazy while active) ───────────────────────────
  if (loadingDesc && loadingDesc.set) {
    Object.defineProperty(imgProto, "loading", {
      configurable: true,
      enumerable: loadingDesc.enumerable,
      get: loadingDesc.get,
      set(value) {
        try {
          const v = String(value || "").toLowerCase();
          if (!ready || !opts) {
            this.dataset.bhPendingLoading = v;
            queuePending(this);
            loadingDesc.set.call(this, "lazy");
          } else if (!active) {
            loadingDesc.set.call(this, v);
          } else {
            loadingDesc.set.call(this, v === "eager" ? "eager" : "lazy");
          }
        } catch { loadingDesc.set.call(this, value); }
      }
    });
  }

  // ── Patch <link>.href property for image preloads ────────────────────────────
  if (linkHrefDesc && linkHrefDesc.set) {
    Object.defineProperty(linkProto, "href", {
      configurable: true,
      enumerable: linkHrefDesc.enumerable,
      get: linkHrefDesc.get,
      set(value) {
        try {
          if (isImagePreloadLink(this)) {
            const decided = decideSrc(String(value));
            if (decided === null) {
              this.dataset.bhPreloadHref = String(value);
              queuePending(this);
              return; // B6: leave href unset instead of about:blank
            }
            linkHrefDesc.set.call(this, decided);
            return;
          }
        } catch {}
        linkHrefDesc.set.call(this, value);
      }
    });
  }

  // ── Patch Element.prototype.setAttribute ────────────────────────────────────
  Element.prototype.setAttribute = function(name, value) {
    try {
      if (destroyed) return setAttr.call(this, name, value);
      const n = String(name).toLowerCase();

      // #21: fast path first — class/data-*/aria-*/id/etc. return immediately.
      if (n !== "src" && n !== "srcset" && n !== "loading" && n !== "imagesrcset" &&
          n !== "href" && n !== "rel" && n !== "as" && n !== "type") {
        return setAttr.call(this, name, value);
      }

      if (this instanceof HTMLLinkElement) {
        setAttr.call(this, name, value);
        processPreloadLink(this);
        return;
      }

      if (this instanceof HTMLImageElement && n === "loading") {
        const v = String(value || "").toLowerCase();
        if (!ready || !opts) {
          this.dataset.bhPendingLoading = v;
          queuePending(this);
          return setAttr.call(this, "loading", "lazy");
        }
        if (!active) return setAttr.call(this, "loading", v);
        return setAttr.call(this, "loading", v === "eager" ? "eager" : "lazy");
      }

      if (this instanceof HTMLImageElement && (n === "src" || n === "srcset")) {
        if (n === "src") {
          const decided = isFailed(this) ? String(value) : decideSrc(String(value));
          if (decided === null) {
            this.dataset.bhPendingSrc = String(value);
            queuePending(this);
            return; // B6: write nothing while pending
          }
          if (decided !== String(value)) armProxyFallback(this, resolveHttp(String(value)), this.getAttribute("srcset") || "");
          return setAttr.call(this, "src", decided);
        }
        const v = String(value || "");
        if (!ready || !opts) {
          if (!srcsetNeedsHold(v)) return setAttr.call(this, "srcset", v);
          this.dataset.bhPendingSrcset = v;
          queuePending(this);
          return; // B6
        }
        if (!active || isFailed(this)) return setAttr.call(this, "srcset", v);
        const rewritten = rewriteSrcset(v, this);
        if (rewritten !== v) armProxyFallback(this, "", v);
        return setAttr.call(this, "srcset", rewritten);
      }

      if (this instanceof HTMLSourceElement && n === "srcset") {
        const v = String(value || "");
        if (!ready || !opts) {
          if (!srcsetNeedsHold(v)) return setAttr.call(this, "srcset", v);
          this.dataset.bhPendingSrcset = v;
          queuePending(this);
          return; // B6
        }
        if (!active) return setAttr.call(this, "srcset", v);
        return setAttr.call(this, "srcset", rewriteSrcset(v, this));
      }
    } catch {}
    return setAttr.call(this, name, value);
  };

  // ── MutationObservers for parser-created media and preload links ──────────────
  // C1/O5: childList catches parser-inserted links, images and sources — the
  // parser bypasses JavaScript setters. Watch the attributes that can turn a
  // link into an image preload or introduce responsive candidates: rel/as/type
  // are not fully patchable, and imagesrcset can change without href.
  const linkObserverGuard = () => destroyed || (ready && !active);
  preloadObserver = new MutationObserver(mutations => {
    if (linkObserverGuard()) return;
    for (const m of mutations) {
      if (m.type !== "childList") continue;
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        processParserImage(n);
        if (n instanceof HTMLLinkElement) processPreloadLink(n);
        if (n.querySelectorAll) {
          n.querySelectorAll("img,source").forEach(processParserImage);
          n.querySelectorAll('link[rel~="preload"]').forEach(processPreloadLink);
        }
      });
    }
  });
  preloadObserver.observe(document, { childList: true, subtree: true });

  linkAttrObserver = new MutationObserver(mutations => {
    if (linkObserverGuard()) return;
    for (const m of mutations) {
      if (m.target instanceof HTMLLinkElement) processPreloadLink(m.target);
    }
  });
  linkAttrObserver.observe(document, {
    subtree: true,
    attributes: true,
    attributeFilter: ["rel", "as", "type", "imagesrcset"]
  });

  // ── Shadow roots ────────────────────────────────────────────────────────────
  // attachShadow() is wrapped (mode is never changed) so both open and closed
  // roots are observed for DOM-layer media and can be reached by the fallback
  // retry. Declarative shadow roots do not go through attachShadow; open ones
  // are found via element.shadowRoot during retry, closed ones are unreachable.
  const shadowRefs = [];
  const nativeAttachShadow = Element.prototype.attachShadow;
  if (typeof nativeAttachShadow === "function") {
    Element.prototype.attachShadow = function(init) {
      const root = nativeAttachShadow.call(this, init);
      try {
        if (!destroyed && root) {
          shadowRefs.push(new WeakRef(root));
          preloadObserver.observe(root, { childList: true, subtree: true });
        }
      } catch {}
      return root;
    };
  }

  // ── One-shot fallback retry ───────────────────────────────────────────────
  // The service worker saw the PROXY fail for these original URLs and has
  // already installed a per-tab bypass rule for each, so re-requesting them now
  // goes straight to the origin and can never reach the proxy again. Every
  // element is retried at most once (FAILED_ATTR) — no loops.
  const RELOADED_ATTR = "data-bh-reloaded";
  const CSS_URL_RE = /url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi;
  const stripHash = u => { const r = safeURL(u); if (!r) return null; r.hash = ""; return r.href; };

  function collectRoots() {
    const roots = new Set([document]);
    for (let i = shadowRefs.length - 1; i >= 0; i--) {
      const r = shadowRefs[i].deref();
      if (r) roots.add(r); else shadowRefs.splice(i, 1);
    }
    const CANDIDATE = "img,video,image,object,embed,input,[style]";
    const queue = Array.from(roots);
    while (queue.length) {
      const root = queue.pop();
      try {
        root.querySelectorAll(CANDIDATE).forEach(el => {
          const sr = el.shadowRoot; // open roots, including declarative ones
          if (sr && !roots.has(sr)) { roots.add(sr); queue.push(sr); }
        });
      } catch {}
    }
    return roots;
  }

  function cssUrls(text, base) {
    const out = [];
    String(text || "").replace(CSS_URL_RE, (_f, q, quoted, bare) => {
      const raw = String(q ? quoted : bare || "").trim();
      const r = raw ? safeURL(raw, base || document.baseURI) : null;
      const abs = r && /^https?:$/.test(r.protocol) ? stripHash(r.href) : null;
      if (abs) out.push(abs);
      return _f;
    });
    return out;
  }

  // Re-parse CSS rules (including @media/@supports/@layer/@container groups,
  // pseudo-element rules and @import-ed sheets) whose url() references a
  // failed URL. Re-insertion creates fresh image values, so Chrome re-requests
  // them — now bypassing the proxy.
  function retryRules(container, base, has, seen) {
    let rules;
    try { rules = container.cssRules; } catch { return false; } // cross-origin
    let hit = false;
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      try {
        if (r.styleSheet) { // @import
          if (!seen.has(r.styleSheet)) { seen.add(r.styleSheet); hit = retryRules(r.styleSheet, r.styleSheet.href || base, has, seen) || hit; }
          continue;
        }
        const text = r.cssText;
        if (!text || text.indexOf("url(") < 0) continue;
        if (r.constructor && r.constructor.name !== "CSSStyleRule" && r.cssRules) {
          hit = retryRules(r, base, has, seen) || hit;
          continue;
        }
        if (cssUrls(text, base).some(has)) {
          container.deleteRule(i);
          container.insertRule(text, i);
          hit = true;
        }
      } catch {}
    }
    return hit;
  }

  function retryFailed(items) {
    if (destroyed || !items.length) return;
    const originals = new Set();
    const proxyToOriginal = new Map();
    for (const it of items) {
      const o = it && typeof it.original === "string" ? stripHash(it.original) : null;
      if (!o) continue;
      originals.add(o);
      if (typeof it.proxyUrl === "string") proxyToOriginal.set(it.proxyUrl, o);
      failedUrls.add(o); // never hand it to the proxy again on this page
    }
    if (!originals.size) return;
    const matched = new Set(); // originals located in an accessible place
    const has = abs => { if (!abs || !originals.has(abs)) return false; matched.add(abs); return true; };
    const hasRel = (v, base) => { const r = v ? safeURL(v, base || document.baseURI) : null; if (!r) return false; r.hash = ""; return has(r.href); };
    const reset = (el, name) => { const v = el.getAttribute(name); if (v !== null) setAttr.call(el, name, v); };
    const crossOrigin = [];

    for (const root of collectRoots()) {
      let nodes;
      try { nodes = root.querySelectorAll("img,video[poster],image,object[data],embed[src],input[type=image][src],[style*='url(' i]"); }
      catch { continue; }
      for (const el of nodes) {
        try {
          const tag = el.localName;
          if (tag === "img") {
            // An element already restored by its own DOM-layer fallback is done.
            if (el.hasAttribute(RESTORED_ATTR) || el.hasAttribute(FAILED_ATTR)) continue;
            const src = el.getAttribute("src");
            const ss = el.getAttribute("srcset");
            let hit = (src && hasRel(src, el.baseURI)) || (el.currentSrc && hasRel(el.currentSrc)) ||
              (ss && parseSrcset(ss).some(c => hasRel(c.url, el.baseURI)));
            const pic = el.parentElement && el.parentElement.localName === "picture" ? el.parentElement : null;
            if (!hit && pic) {
              hit = Array.from(pic.querySelectorAll("source")).some(s =>
                parseSrcset(s.getAttribute("srcset") || "").some(c => hasRel(c.url, el.baseURI)));
            }
            if (!hit) continue;
            markFailed(el);
            if (ss !== null) setAttr.call(el, "srcset", ss);
            if (src !== null) setAttr.call(el, "src", src);
          } else if (tag === "video") {
            if (hasRel(el.getAttribute("poster"), el.baseURI) && !el.hasAttribute(FAILED_ATTR)) { markFailed(el); reset(el, "poster"); }
          } else if (tag === "image" && el.namespaceURI === "http://www.w3.org/2000/svg") {
            if (el.hasAttribute(FAILED_ATTR)) continue;
            const XLINK = "http://www.w3.org/1999/xlink";
            const href = el.getAttribute("href");
            const xhref = el.getAttributeNS(XLINK, "href");
            if (href && hasRel(href, el.baseURI)) { markFailed(el); setAttr.call(el, "href", href); }
            else if (xhref && hasRel(xhref, el.baseURI)) { markFailed(el); el.setAttributeNS(XLINK, "xlink:href", xhref); }
          } else if (tag === "object" || tag === "embed" || tag === "input") {
            const name = tag === "object" ? "data" : "src";
            if (hasRel(el.getAttribute(name), el.baseURI) && !el.hasAttribute(FAILED_ATTR)) { markFailed(el); reset(el, name); }
          }
          // Inline styles (any element, including the ones above).
          const style = el.getAttribute("style");
          if (style && style.indexOf("url(") >= 0 && !el.hasAttribute(FAILED_ATTR + "-style")) {
            let next = style;
            for (const [p, o] of proxyToOriginal) if (next.includes(p)) next = next.split(p).join(o); // DOM-layer rewrite
            if (next !== style || cssUrls(style, el.baseURI).some(has)) {
              try { el.setAttribute(FAILED_ATTR + "-style", ""); } catch {}
              markFailed(el);
              // Chrome skips re-parsing an identical style string, so toggle
              // insignificant trailing whitespace to force fresh image values.
              if (next === style) next = /\s$/.test(style) ? style.replace(/\s+$/, "") : style + " ";
              setAttr.call(el, "style", next); // re-parse → fresh request
            }
          }
        } catch {}
      }

      // Stylesheets reachable from this root.
      const sheets = [];
      try { for (const sh of root.styleSheets || []) sheets.push(sh); } catch {}
      try { for (const sh of root.adoptedStyleSheets || []) sheets.push(sh); } catch {}
      const seen = new Set(sheets);
      for (const sh of sheets) {
        let readable = true;
        try { void sh.cssRules; } catch { readable = false; }
        if (!readable) { crossOrigin.push(sh); continue; }
        retryRules(sh, sh.href || document.baseURI, has, seen);
      }
    }

    // Cross-origin sheets cannot be inspected. When some failed URL was not
    // found anywhere accessible, re-load each such <link> once (normally from
    // HTTP cache) so its url() values are re-requested; the old link is
    // removed only after the clone has loaded, so nothing flashes unstyled.
    if (crossOrigin.length && Array.from(originals).some(o => !matched.has(o))) {
      for (const sh of crossOrigin) {
        const link = sh.ownerNode;
        if (!link || link.localName !== "link" || link.hasAttribute(RELOADED_ATTR)) continue;
        try {
          const clone = link.cloneNode(true);
          setAttr.call(clone, RELOADED_ATTR, "");
          setAttr.call(link, RELOADED_ATTR, "");
          clone.addEventListener("load", () => { try { link.remove(); } catch {} }, { once: true });
          clone.addEventListener("error", () => { try { clone.remove(); } catch {} }, { once: true });
          link.after(clone);
        } catch {}
      }
    }
  }

  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });
})();
