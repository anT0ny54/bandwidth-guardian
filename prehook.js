// Bandwidth Guardian — prehook (runs at document_start, in the page's MAIN world
// via manifest "world": "MAIN", so page JavaScript actually hits these patches)
// Intercepts <img src>, srcset, <source srcset>, loading, image preloads and
// new Image() assignments so the full-resolution original is never fetched.
//
// shared.js runs immediately before this file in the same world. Its object
// is captured here and the global is deleted before any page script runs.
(() => {
  const BH = globalThis.__bhShared;
  try { delete globalThis.__bhShared; } catch {}
  if (!BH) return;

  // ── State ──────────────────────────────────────────────────────────────────
  // Inactive until content.js delivers settings over the private channel.
  let config = BH.normalizeProxyConfig({ ...BH.DEFAULTS, enabled: false });
  let ready = false;
  let isExcludedHost = () => false;
  let pageExcluded = false;
  const urls = BH.createProxyUrlBuilder();
  const pageHost = location.hostname.toLowerCase();
  let srcsetCache = new WeakMap();
  let destroyed = false;      // the page is navigating away; stop all DOM work
  let preloadObserver = null;

  // Elements assigned before settings arrive are held here, NOT written to the
  // DOM. Nothing is fetched and no about:blank error events fire; the patched
  // getters return the held value so page code reads back what it wrote.
  // Bounded: once full, new values pass through unproxied instead of being
  // held (an element is never left without its image).
  const MAX_PENDING = 1000;
  const pending = new Set();
  const parkedSrc = new WeakMap();
  const parkedSrcset = new WeakMap();
  const parkedLoading = new WeakMap();
  const parkedHref = new WeakMap(); // <link rel=preload as=image> originals
  function queuePending(el) {
    if (pending.has(el)) return true;
    if (pending.size >= MAX_PENDING) return false;
    pending.add(el);
    return true;
  }

  // ── Native descriptors, captured BEFORE patching ───────────────────────────
  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const loadingDesc = Object.getOwnPropertyDescriptor(imgProto, "loading");
  const setAttr = Element.prototype.setAttribute;
  const removeAttr = Element.prototype.removeAttribute;
  const sourceProto = typeof HTMLSourceElement === "function" ? HTMLSourceElement.prototype : null;
  const sourceSrcsetDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;
  const linkProto = HTMLLinkElement.prototype;
  const linkHrefDesc = Object.getOwnPropertyDescriptor(linkProto, "href");

  const nativeSetSrc = (el, v) => srcDesc.set.call(el, v);
  const nativeSetSrcset = (el, v) => srcsetDesc?.set?.call(el, v);
  const nativeSourceSetSrcset = (el, v) => sourceSrcsetDesc?.set?.call(el, v);

  const fallback = BH.createFallback({
    getConfig: () => config,
    setSrc: srcDesc.set,
    setSrcset: srcsetDesc?.set || function (v) { setAttr.call(this, "srcset", v); },
    setSourceSrcset: sourceSrcsetDesc?.set || function (v) { setAttr.call(this, "srcset", v); },
    setAttr,
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = (u, base = document.baseURI) => {
    try { return new URL(u, base); } catch { return null; }
  };
  const resolveHttp = u => {
    const resolved = safeURL(u);
    return resolved && /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  };
  const isConfiguredProxyUrl = u => {
    if (!config.host) return false;
    const parsed = safeURL(u);
    return !!parsed && parsed.hostname.toLowerCase() === config.host;
  };
  // True only while images on this page should go through the proxy.
  const proxying = () => ready && config.active && !pageExcluded;

  function applySettings(next) {
    config = BH.normalizeProxyConfig(next);
    isExcludedHost = BH.makeHostMatcher(BH.parseDomainList(next.excludeDomains));
    pageExcluded = isExcludedHost(pageHost);
    urls.clear();
    srcsetCache = new WeakMap();
    ready = true;
  }

  function skipAbsolute(absolute) {
    if (isConfiguredProxyUrl(absolute) || BH.SKIP_URL_RE.test(absolute) ||
        BH.TRACKING_RE.test(absolute)) return true;
    const u = safeURL(absolute);
    return !u || isExcludedHost(u.hostname);
  }

  // Only ever called while proxying() is true.
  function rewriteSrcset(ss, el) {
    if (!ss) return ss;
    if (el) {
      const cached = srcsetCache.get(el);
      if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    }
    const output = BH.mapSrcset(ss, url => {
      const absolute = resolveHttp(url);
      return !absolute || skipAbsolute(absolute) ? null : urls.build(config, absolute);
    });
    if (el) srcsetCache.set(el, { input: ss, output });
    return output;
  }

  // Original URL behind a (possibly relative) configured-proxy URL, or null.
  const unproxyUrl = v => BH.originalFromProxyUrl(resolveHttp(v) || v, config);

  // Value to assign for an <img>/<link> URL, or null = hold until settings.
  function decideSrc(value) {
    const v = String(value);
    // img.src = "" clears an image; never proxy the page URL.
    if (!v.trim()) return v;
    const absolute = resolveHttp(v);
    if (!absolute) return v;
    // Never wrap a configured-proxy URL a second time (content.js rewrites
    // data-src to proxy URLs, which lazy loaders then copy into src).
    if (isConfiguredProxyUrl(absolute)) return v;
    if (!ready) return null;
    if (!proxying() || skipAbsolute(absolute)) return v;
    return urls.build(config, absolute);
  }

  // ── Assignment paths (property setters, setAttribute, queued flush) ─────────
  function assignSrc(el, value, setNative) {
    let v = String(value);
    // Failed or disabled: never (re)load through the proxy, including proxy
    // URLs a lazy loader copies from a rewritten data-src.
    if (fallback.isFailed(el) || (ready && !proxying())) {
      parkedSrc.delete(el);
      return setNative(unproxyUrl(v) || v);
    }
    const decided = decideSrc(v);
    if (decided === null) {
      if (queuePending(el)) { parkedSrc.set(el, v); return; }
      return setNative(v); // queue full: original, never a blank image
    }
    parkedSrc.delete(el);
    // Arm the fallback whenever the final value is a proxy URL, whether we
    // just built it or it arrived pre-proxied.
    if (isConfiguredProxyUrl(resolveHttp(decided) || "")) fallback.arm(el);
    setNative(decided);
  }

  function assignImgSrcset(el, value, setNative) {
    const v = String(value ?? "");
    if (fallback.isFailed(el) || (ready && !proxying())) {
      parkedSrcset.delete(el);
      return setNative(BH.unproxySrcset(v, config));
    }
    if (!ready) {
      if (queuePending(el)) { parkedSrcset.set(el, v); return; }
      return setNative(v);
    }
    parkedSrcset.delete(el);
    const out = rewriteSrcset(v, el);
    if (config.host && out.includes(config.host)) fallback.arm(el);
    setNative(out);
  }

  function assignSourceSrcset(el, value, setNative) {
    const v = String(value ?? "");
    if (fallback.isFailed(el) || (ready && !proxying())) {
      parkedSrcset.delete(el);
      removeAttr.call(el, BH.ORIG_SRCSET_ATTR);
      return setNative(BH.unproxySrcset(v, config));
    }
    if (!ready) {
      if (queuePending(el)) { parkedSrcset.set(el, v); return; }
      return setNative(v);
    }
    parkedSrcset.delete(el);
    const out = rewriteSrcset(v, el);
    const original = BH.unproxySrcset(v, config);
    if (out !== original) {
      // The original travels in the DOM so either world can restore it.
      setAttr.call(el, BH.ORIG_SRCSET_ATTR, original);
      setNative(out);
      fallback.armPicture(el);
      return;
    }
    removeAttr.call(el, BH.ORIG_SRCSET_ATTR);
    setNative(out);
  }

  // Force lazy loading while proxying so offscreen images are never fetched.
  // Explicit eager requests are respected (carousels, above-the-fold logic).
  function assignLoading(el, value, setNative) {
    const v = String(value ?? "").toLowerCase();
    if (!ready) {
      if (queuePending(el)) { parkedLoading.set(el, v); return setNative("lazy"); }
      return setNative(v);
    }
    parkedLoading.delete(el);
    setNative(proxying() ? (v === "eager" ? "eager" : "lazy") : v);
  }

  // ── <link rel="preload" as="image"> ─────────────────────────────────────────
  // A preload makes the browser fetch the original URL directly, bypassing the
  // <img> patches. Parser-created links have already set href natively, so
  // while settings are pending their href is swapped to about:blank (links do
  // not have the <img> error-event problem) and the original is held.
  const isImagePreloadLink = el =>
    el instanceof HTMLLinkElement &&
    /(?:^|\s)preload(?:\s|$)/i.test(el.rel || "") &&
    (String(el.getAttribute("as") || "").toLowerCase() === "image" ||
     /^image\//i.test(el.getAttribute("type") || ""));

  // Idempotent: called from setAttribute, link.href, the observer and flush.
  function processPreloadLink(el) {
    try {
      if (destroyed || !isImagePreloadLink(el)) return;
      const stashed = parkedHref.get(el);
      const current = el.getAttribute("href");
      const original = stashed || current;
      if (!original || original === "about:blank") return;
      const decided = decideSrc(original);
      if (decided === null) {
        if (!queuePending(el)) return; // queue full: leave the original alone
        if (!stashed) parkedHref.set(el, original);
        // Never rewrite the same value from inside an observed attribute
        // callback; same-value setAttribute still queues a mutation.
        if (current !== "about:blank") setAttr.call(el, "href", "about:blank");
      } else {
        parkedHref.delete(el);
        if (current !== decided) setAttr.call(el, "href", decided);
      }
    } catch {}
  }

  // ── Flush held elements once settings are known ─────────────────────────────
  function flushPending() {
    if (destroyed) return;
    for (const el of pending) {
      pending.delete(el);
      try {
        if (el instanceof HTMLLinkElement) { processPreloadLink(el); continue; }
        if (parkedLoading.has(el) && loadingDesc?.set) {
          const v = parkedLoading.get(el);
          assignLoading(el, v, x => loadingDesc.set.call(el, x));
        }
        if (parkedSrcset.has(el)) {
          const v = parkedSrcset.get(el);
          if (el instanceof HTMLImageElement) assignImgSrcset(el, v, x => nativeSetSrcset(el, x));
          else assignSourceSrcset(el, v, x => nativeSourceSetSrcset(el, x));
        }
        if (parkedSrc.has(el)) {
          const v = parkedSrc.get(el);
          assignSrc(el, v, x => nativeSetSrc(el, x));
        }
      } catch {}
    }
  }

  function stop() {
    if (destroyed) return;
    destroyed = true;
    try { preloadObserver && preloadObserver.disconnect(); } catch {}
    try { pending.clear(); } catch {}
    urls.clear();
    srcsetCache = new WeakMap();
  }

  // ── Settings bridge ────────────────────────────────────────────────────────
  // content.js (isolated world, owns chrome.storage) hands settings over a
  // private MessagePort. The handshake is TWO-WAY because the injection order
  // of MAIN-world and isolated-world document_start scripts is NOT guaranteed
  // (Chromium builds order them differently): whichever script runs first
  // loses its first message on a listener that does not exist yet — in 0.1.8
  // a lost startup handshake left prehook settings-less until the 5-second
  // watchdog, so every JavaScript-assigned image loaded unproxied. Both sides
  // therefore speak: prehook listens for content.js's handshake AND posts a
  // settings request of its own, which content.js answers with a fresh port.
  // At least one direction always lands, under every injection order, before
  // any page script runs.
  //
  // This capture listener takes the first handshake, stops it from reaching
  // page listeners and removes itself; later look-alike messages from the
  // page are ignored. Settings (proxy URL, exclusion list) then travel only
  // over the private port — page scripts can neither read nor spoof them —
  // and the ack that closes the handshake travels over the port itself.
  function onBridge(e) {
    try {
      if (e.source !== window || !e.data || e.data[BH.BRIDGE_KEY] !== 1 || !e.ports || !e.ports[0]) return;
      e.stopImmediatePropagation();
      window.removeEventListener("message", onBridge, true);
      const port = e.ports[0];
      // Tell content.js which port was accepted so it stops offering new ones.
      try { port.postMessage({ [BH.BRIDGE_KEY]: BH.BRIDGE_ACK }); } catch {}
      port.onmessage = m => {
        if (destroyed) return;
        const next = m.data;
        if (!next || typeof next !== "object") return;
        applySettings({
          enabled: next.enabled !== false,
          proxyBase: typeof next.proxyBase === "string" ? next.proxyBase : "",
          quality: next.quality,
          grayscale: next.grayscale,
          maxWidth: next.maxWidth,
          excludeDomains: typeof next.excludeDomains === "string" ? next.excludeDomains : "",
        });
        flushPending();
      };
    } catch {}
  }
  window.addEventListener("message", onBridge, true);
  // Also ASK for settings: if prehook ran first, content.js's startup
  // handshake was already lost; this request makes it re-post one.
  try { window.postMessage({ [BH.BRIDGE_KEY]: BH.BRIDGE_REQ }, "*"); } catch {}

  // Watchdog: if settings never arrive (extension error, storage failure),
  // release held elements unproxied so nothing stays imageless.
  const SETTINGS_WATCHDOG_MS = 5000;
  setTimeout(() => {
    if (!destroyed && !ready) {
      applySettings({ ...BH.DEFAULTS, enabled: false });
      flushPending();
    }
  }, SETTINGS_WATCHDOG_MS);

  // ── Patch <img>.src ────────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get() {
      if (parkedSrc.has(this)) { const v = parkedSrc.get(this); return resolveHttp(v) || v; }
      return srcDesc.get.call(this);
    },
    set(value) {
      try { assignSrc(this, value, v => nativeSetSrc(this, v)); }
      catch { nativeSetSrc(this, value); }
    },
  });

  // ── Patch <img>.srcset ─────────────────────────────────────────────────────
  if (srcsetDesc && srcsetDesc.set) {
    Object.defineProperty(imgProto, "srcset", {
      configurable: true,
      enumerable: srcsetDesc.enumerable,
      get() { return parkedSrcset.has(this) ? parkedSrcset.get(this) : srcsetDesc.get.call(this); },
      set(value) {
        try { assignImgSrcset(this, value, v => nativeSetSrcset(this, v)); }
        catch { nativeSetSrcset(this, value); }
      },
    });
  }

  // ── Patch <source>.srcset inside <picture> ───────────────────────────────
  if (sourceProto && sourceSrcsetDesc && sourceSrcsetDesc.set) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get() { return parkedSrcset.has(this) ? parkedSrcset.get(this) : sourceSrcsetDesc.get.call(this); },
      set(value) {
        try { assignSourceSrcset(this, value, v => nativeSourceSetSrcset(this, v)); }
        catch { nativeSourceSetSrcset(this, value); }
      },
    });
  }

  // ── Patch <img>.loading ──────────────────────────────────────────────────────
  if (loadingDesc && loadingDesc.set) {
    Object.defineProperty(imgProto, "loading", {
      configurable: true,
      enumerable: loadingDesc.enumerable,
      get() { return parkedLoading.has(this) ? parkedLoading.get(this) : loadingDesc.get.call(this); },
      set(value) {
        try { assignLoading(this, value, v => loadingDesc.set.call(this, v)); }
        catch { loadingDesc.set.call(this, value); }
      },
    });
  }

  // ── Patch <link>.href for image preloads ──────────────────────────────────
  if (linkHrefDesc && linkHrefDesc.set) {
    Object.defineProperty(linkProto, "href", {
      configurable: true,
      enumerable: linkHrefDesc.enumerable,
      get() {
        if (parkedHref.has(this)) { const v = parkedHref.get(this); return resolveHttp(v) || v; }
        return linkHrefDesc.get.call(this);
      },
      set(value) {
        try {
          if (isImagePreloadLink(this)) {
            const v = String(value);
            const decided = decideSrc(v);
            if (decided === null && queuePending(this)) {
              parkedHref.set(this, v);
              linkHrefDesc.set.call(this, "about:blank");
              return;
            }
            parkedHref.delete(this);
            linkHrefDesc.set.call(this, decided ?? v);
            return;
          }
        } catch {}
        linkHrefDesc.set.call(this, value);
      },
    });
  }

  // ── Patch Element.prototype.setAttribute ───────────────────────────────────
  Element.prototype.setAttribute = function (name, value) {
    try {
      if (destroyed) return setAttr.call(this, name, value);
      const n = String(name).toLowerCase();
      // Fast path: class, data-*, aria-*, id, … return with no instanceof checks.
      if (n !== "src" && n !== "srcset" && n !== "loading" &&
          n !== "href" && n !== "rel" && n !== "as" && n !== "type") {
        return setAttr.call(this, name, value);
      }
      // <link rel="preload"> attributes must land before inspection.
      if (this instanceof HTMLLinkElement) {
        setAttr.call(this, name, value);
        processPreloadLink(this);
        return;
      }
      if (this instanceof HTMLImageElement) {
        if (n === "loading") return assignLoading(this, value, v => setAttr.call(this, "loading", v));
        if (n === "src") return assignSrc(this, value, v => setAttr.call(this, "src", v));
        if (n === "srcset") return assignImgSrcset(this, value, v => setAttr.call(this, "srcset", v));
      }
      if (sourceProto && this instanceof HTMLSourceElement && n === "srcset") {
        return assignSourceSrcset(this, value, v => setAttr.call(this, "srcset", v));
      }
    } catch {}
    return setAttr.call(this, name, value);
  };

  // ── MutationObserver for parser-created <link rel="preload" as="image"> ────
  preloadObserver = new MutationObserver(mutations => {
    if (destroyed) return;
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          if (n instanceof HTMLLinkElement) processPreloadLink(n);
          if (n.querySelectorAll) n.querySelectorAll('link[rel~="preload"]').forEach(processPreloadLink);
        });
      } else {
        processPreloadLink(m.target);
      }
    }
  });
  // document exists at document_start even before documentElement is parsed.
  preloadObserver.observe(document, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["href", "rel", "as", "type"],
  });

  // Free the outgoing page on normal navigation; keep bfcache restores working.
  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });
})();
