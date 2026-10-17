// Bandwidth Guardian — prehook (document_start, page MAIN world).
// Patches HTMLImageElement/HTMLSourceElement/HTMLLinkElement setters and
// Element.prototype.setAttribute before page JS runs, so JS-assigned image
// URLs (including every lazy loader's img.src = dataset.src) are proxied
// before any network request fires. Chrome-based browsers only.
(() => {
  "use strict";

  // KEEP IN SYNC WITH content.js: FAILED_ATTR and proxy-failure event contract.
  const DEFAULT_SETTINGS_EVENT = "bh-settings-update";

  let opts = null;
  let ready = false;
  let active = false; // ready && enabled && proxyBase set && !pageExcluded (O1)
  let excludedDomains = new Set();
  let proxyConfig = null;
  let proxyOrigin = "";
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;

  const pending = new Set(); // elements waiting for opts; bounded (see #7)
  const MAX_PENDING = 1000;
  function queuePending(el) { if (pending.size < MAX_PENDING) pending.add(el); }

  const failureHandlers = new WeakSet();

  const FAILED_ATTR = "data-bh-failed";
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
  const TRACKING_RE = /(?:\/|\.)pagead(?:[/?#]|$)|(?:pixel|cleardot)\.*\.(?:gif|jpe?g)(?:[?#]|$)|google\.[a-z.]+\/(?:ads|generate_204|.*\/log204)(?:[?#]|$)|google-analytics\.[a-z.]+\/(?:r|collect)(?:[?#]|$)|youtube\.[a-z.]+\/(?:api|ptracking|player_204|live_204)(?:[?#]|$)|doubleclick\.[a-z.]+\/(?:pcs|pixel|r)(?:[?#]|$)|googlesyndication\.[a-z.]+\/ddm(?:[?#]|$)|pixel\.facebook\.[a-z.]+|facebook\.[a-z.]+\/(?:tr|impression\.php)(?:[?#]|$)|ad\.bitmedia\.io(?:[/?#]|$)|yahoo\.[a-z.]+\/pixel(?:[?#]|$)|criteo\.net\/img(?:[?#]|$)|ad\.doubleclick\.net(?:[/?#]|$)/i;

  // C2: proxy identity is ORIGIN-based, matching the service worker.
  const isConfiguredProxyUrl = u => {
    try { return !!proxyOrigin && new URL(u).origin === proxyOrigin; } catch { return false; }
  };

  let srcsetCache = new WeakMap();
  let destroyed = false;
  let preloadObserver = null;
  let linkAttrObserver = null;

  function armProxyFailureGuard(el) {
    if (!el || !(el instanceof HTMLImageElement) || isFailed(el)) return;
    if (failureHandlers.has(el)) return;
    failureHandlers.add(el);

    el.addEventListener("error", () => {
      // Fail closed: never restore or retry the original URL after a proxy
      // failure. Mark the element so future writes are not proxied again.
      const cur = el.currentSrc || el.src || "";
      if (!isConfiguredProxyUrl(cur)) return;
      markFailed(el);
    }, true);
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
    ready = true;
    active = !!opts.enabled && !!proxyConfig.base && !pageExcluded;
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
    try { pending.clear(); } catch {}
    try { proxyUrlCache.clear(); } catch {}
    srcsetCache = new WeakMap();
  }

  function flushPending() {
    if (destroyed) return;
    for (const el of pending) {
      pending.delete(el);
      try {
        if (el instanceof HTMLLinkElement) { processPreloadLink(el); continue; }
        if (el instanceof HTMLImageElement && loadingDesc && loadingDesc.set) {
          const pendingLoading = el.dataset.bhPendingLoading;
          if (pendingLoading !== undefined) {
            el.removeAttribute("data-bh-pending-loading");
            loadingDesc.set.call(el, (!opts.enabled || !opts.proxyBase || pageExcluded)
              ? pendingLoading
              : (pendingLoading === "eager" ? "eager" : "lazy"));
          }
        }
        const pendingSrc = el.dataset.bhPendingSrc;
        if (pendingSrc && el instanceof HTMLImageElement) {
          el.removeAttribute("data-bh-pending-src");
          const decided = decideSrc(pendingSrc, el);
          // B7: queued values get the same treatment as live-set ones,
          // including a proxy-failure guard.
          if (decided !== null && decided !== pendingSrc) {
            armProxyFailureGuard(el);
          }
          nativeSetSrc(el, decided ?? pendingSrc);
        }
        const pendingSrcset = el.dataset.bhPendingSrcset;
        if (pendingSrcset) {
          el.removeAttribute("data-bh-pending-srcset");
          if (!opts.enabled || !opts.proxyBase || pageExcluded) { // B7: honor `enabled`
            if (el instanceof HTMLImageElement) nativeSetSrcset(el, pendingSrcset);
            else if (sourceProto && el instanceof HTMLSourceElement) nativeSourceSetSrcset(el, pendingSrcset);
          } else {
            const rewritten = rewriteSrcset(pendingSrcset, el);
            if (el instanceof HTMLImageElement) {
              if (rewritten !== pendingSrcset) armProxyFailureGuard(el);
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
  // O7: use a per-load random event name so page scripts cannot forge settings
  // updates over a well-known channel. The name is exposed through a DOM
  // attribute set at document_start; content.js reads it at publish time.
  // Falls back to the default name when documentElement does not exist yet.
  function onSettings(event) {
    if (destroyed) return;
    try {
      const raw = event?.detail;
      const next = typeof raw === "string" ? JSON.parse(raw) : null;
      if (!next || typeof next !== "object") return;
      applyOpts({
        enabled: next.enabled !== false,
        proxyBase: typeof next.proxyBase === "string" ? next.proxyBase : "",
        quality: next.quality,
        grayscale: next.grayscale,
        maxWidth: next.maxWidth,
        excludeDomains: typeof next.excludeDomains === "string" ? next.excludeDomains : ""
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
  setTimeout(() => {
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
    return !u || excludedHost(u.hostname);
  }

  function rewriteSrcset(ss, el) {
    if (!ss) return ss;
    if (pageExcluded || (el && isFailed(el))) return ss;
    if (el) {
      const cached = srcsetCache.get(el);
      if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    }
    const cands = parseSrcset(ss);
    let touched = false;
    const parts = cands.map(({ url, desc }) => {
      const absolute = resolveHttp(url);
      if (!absolute || skipAbsolute(absolute)) return url + (desc ? " " + desc : "");
      touched = true;
      return buildProxyUrl(absolute) + (desc ? " " + desc : "");
    });
    const output = touched ? parts.join(", ") : ss;
    if (el) srcsetCache.set(el, { input: ss, output });
    return output;
  }

  function decideSrc(original, el) {
    if (el && isFailed(el)) return original;
    if (!original || !String(original).trim()) return original; // clearing src
    const absolute = resolveHttp(original);
    if (!absolute) return original;
    if (isConfiguredProxyUrl(absolute)) return original; // don't double-wrap
    if (!ready || !opts) return null; // queue until settings are known
    if (!opts.enabled || !opts.proxyBase) return original;
    if (pageExcluded) return original;
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
    } catch {}
  }

  // ── Patch <img>.src ─────────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      try {
        const decided = decideSrc(String(value), this);
        if (decided === null) {
          this.dataset.bhPendingSrc = String(value);
          queuePending(this);
          // B6: write nothing while pending — no about:blank fake error.
        } else {
          if (decided !== String(value)) armProxyFailureGuard(this);
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
            this.dataset.bhPendingSrcset = v;
            queuePending(this);
            // B6: no native write while pending.
          } else if (!opts.enabled || !opts.proxyBase) {
            nativeSetSrcset(this, v);
          } else {
            const rewritten = rewriteSrcset(v, this);
            if (rewritten !== v) armProxyFailureGuard(this);
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
            this.dataset.bhPendingSrcset = v;
            queuePending(this);
          } else if (!opts.enabled || !opts.proxyBase) {
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
          } else if (!opts.enabled || !opts.proxyBase || pageExcluded) {
            loadingDesc.set.call(this, v);
          } else {
            loadingDesc.set.call(this, v === "eager" ? "eager" : "lazy");
          }
        } catch { loadingDesc.set.call(this, value); }
      }
    });
  }

  // ── Patch <link>.href property for image preloads ───────────────────────────
  if (linkHrefDesc && linkHrefDesc.set) {
    Object.defineProperty(linkProto, "href", {
      configurable: true,
      enumerable: linkHrefDesc.enumerable,
      get: linkHrefDesc.get,
      set(value) {
        try {
          if (isImagePreloadLink(this)) {
            const decided = decideSrc(String(value), this);
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
      if (n !== "src" && n !== "srcset" && n !== "loading" &&
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
        if (!opts.enabled || !opts.proxyBase || pageExcluded) return setAttr.call(this, "loading", v);
        return setAttr.call(this, "loading", v === "eager" ? "eager" : "lazy");
      }

      if (this instanceof HTMLImageElement && (n === "src" || n === "srcset")) {
        if (n === "src") {
          const decided = decideSrc(String(value), this);
          if (decided === null) {
            this.dataset.bhPendingSrc = String(value);
            queuePending(this);
            return; // B6: write nothing while pending
          }
          if (decided !== String(value)) armProxyFailureGuard(this);
          return setAttr.call(this, "src", decided);
        }
        const v = String(value || "");
        if (!ready || !opts) {
          this.dataset.bhPendingSrcset = v;
          queuePending(this);
          return; // B6
        }
        if (!opts.enabled || !opts.proxyBase) return setAttr.call(this, "srcset", v);
        const rewritten = rewriteSrcset(v, this);
        if (rewritten !== v) armProxyFailureGuard(this);
        return setAttr.call(this, "srcset", rewritten);
      }

      if (this instanceof HTMLSourceElement && n === "srcset") {
        const v = String(value || "");
        if (!ready || !opts) {
          this.dataset.bhPendingSrcset = v;
          queuePending(this);
          return; // B6
        }
        if (!opts.enabled || !opts.proxyBase) return setAttr.call(this, "srcset", v);
        return setAttr.call(this, "srcset", rewriteSrcset(v, this));
      }
    } catch {}
    return setAttr.call(this, name, value);
  };

  // ── MutationObservers for parser-created preload links ──────────────────────
  // C1/O5: two observers. (1) childList catches parser-inserted links — the
  // HTML parser bypasses all JS patches. (2) attribute watching is limited to
  // rel/as on <link> elements: relList.add() is unpatchable, while href changes
  // made by JS already flow through the patched href setter / setAttribute.
  // Document-wide <a href> observation (the old cost) is gone.
  const linkObserverGuard = () => destroyed || (ready && !active);
  preloadObserver = new MutationObserver(mutations => {
    if (linkObserverGuard()) return;
    for (const m of mutations) {
      if (m.type !== "childList") continue;
      m.addedNodes.forEach(n => {
        if (n.nodeType !== 1) return;
        if (n instanceof HTMLLinkElement) processPreloadLink(n);
        if (n.querySelectorAll) n.querySelectorAll('link[rel~="preload"]').forEach(processPreloadLink);
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
    attributeFilter: ["rel", "as"]
  });

  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });
})();
