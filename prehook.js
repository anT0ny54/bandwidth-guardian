// Bandwidth Guardian — early image URL prehook
// Goal: proxy JS-created image URLs before a network request starts,
// while failing open quickly enough to avoid hurting LCP/preload behavior.
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    proxyBase: "",
    quality: 40,
    grayscale: true,
    maxWidth: 1920,
    excludeDomains: "google.com gstatic.com",
    isWebpSupported: false,
    failoverOriginal: true,
  };

  const imgProto = HTMLImageElement.prototype;
  const sourceProto = HTMLSourceElement.prototype;
  const linkProto = HTMLLinkElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const sourceSrcsetDesc = Object.getOwnPropertyDescriptor(sourceProto, "srcset");
  const linkHrefDesc = Object.getOwnPropertyDescriptor(linkProto, "href");
  const nativeSetAttribute = Element.prototype.setAttribute;
  const nativeGetAttribute = Element.prototype.getAttribute;
  const nativeRemoveAttribute = Element.prototype.removeAttribute;
  const NativeImage = window.Image;

  let opts = { ...DEFAULTS };
  let ready = false;
  let excluded = new Set();
  let proxyHost = "";
  let readyTimer = 0;

  // WeakMap avoids polluting page DOM with data-bh-* attributes.
  const pending = new WeakMap();
  const pendingElements = new Set();

  // One-shot proxy -> original failover. WeakMaps keep page DOM clean.
  const failoverState = new WeakMap();
  const FAILOVER_MARK = "__bgFailoverDone";
  function rememberFailover(el, original, proxied) {
    if (!el || !opts.failoverOriginal || !original || !proxied || original === proxied) return;
    const state = failoverState.get(el) || { restored: false };
    state.originalSrc = original;
    state.proxiedSrc = proxied;
    state.originalSrcset = state.originalSrcset ?? null;
    failoverState.set(el, state);
  }
  function rememberSrcsetFailover(el, original) {
    if (!el || !opts.failoverOriginal || !original) return;
    const state = failoverState.get(el) || { restored: false };
    state.originalSrcset = original;
    failoverState.set(el, state);
  }
  function restoreOriginal(el) {
    const state = failoverState.get(el);
    if (!el || !state || state.restored || !opts.failoverOriginal) return false;
    state.restored = true;
    try { Object.defineProperty(el, FAILOVER_MARK, { configurable: true, value: true }); } catch {}
    try {
      const current = el.currentSrc || el.src || "";
      const proxied = state.proxiedSrc || "";
      // Restore the original src only if the currently selected resource is the proxy
      // (or the element's src is the proxy). This avoids clobbering a site-selected
      // srcset candidate that has already changed underneath us.
      if (state.originalSrc != null && (current === proxied || el.src === proxied || !proxied)) {
        srcDesc?.set?.call(el, state.originalSrc);
      }
      if (state.originalSrcset != null && el.getAttribute("srcset") !== state.originalSrcset) {
        srcsetDesc?.set?.call(el, state.originalSrcset);
      }
      return true;
    } catch { return false; }
  }
  function maybeFailover(el) {
    if (!(el instanceof HTMLImageElement) || !opts.failoverOriginal) return;
    const state = failoverState.get(el);
    if (!state || state.restored) return;
    // Error is sufficient for HTTP/decode failures; decode rejection catches corrupt/undecodable responses.
    restoreOriginal(el);
  }
  function armDecodeCheck(el) {
    if (!(el instanceof HTMLImageElement) || !opts.failoverOriginal) return;
    const state = failoverState.get(el);
    if (!state || state.restored) return;
    const token = state.proxiedSrc;
    const check = () => {
      const current = el.currentSrc || el.src || "";
      if (current !== token && el.src !== token) return;
      const fail = () => {
        const latest = failoverState.get(el);
        if (latest?.proxiedSrc === token && !latest.restored) restoreOriginal(el);
      };
      if (!el.complete) return;
      // A completed image with no decoded dimensions is invalid. Delay one task so
      // Chromium/Cromite has a chance to publish naturalWidth/naturalHeight.
      if (el.naturalWidth === 0 || el.naturalHeight === 0) {
        setTimeout(() => {
          if (el.complete && (el.naturalWidth === 0 || el.naturalHeight === 0)) fail();
        }, 80);
        return;
      }
      if (typeof el.decode === "function") Promise.resolve(el.decode()).catch(fail);
    };
    if (el.complete) queueMicrotask(check);
    else el.addEventListener("load", check, { once: true });
  }
  window.addEventListener("error", (event) => {
    if (event.target instanceof HTMLImageElement) maybeFailover(event.target);
  }, true);

  const isHttp = (v) => /^https?:\/\//i.test(String(v || ""));
  const parseURL = (v) => { try { return new URL(v, document.baseURI); } catch { return null; } };

  function parseDomains(text) {
    const set = new Set();
    for (const token of String(text || "").split(/[\s,]+/)) {
      const host = token.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
      if (host) set.add(host);
    }
    return set;
  }

  function normalizeProxyBase(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw);
      if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
      url.hash = "";
      url.search = "";
      const path = url.pathname.replace(/\/+$/, "");
      url.pathname = (!path || path === "/") ? "/api" : path;
      return url.toString().replace(/\/$/, "");
    } catch { return raw.replace(/\/+$/, ""); }
  }

  function configure(next) {
    opts = { ...DEFAULTS, ...(next || {}) };
    opts.proxyBase = normalizeProxyBase(opts.proxyBase);
    excluded = parseDomains(opts.excludeDomains);
    proxyHost = parseURL(opts.proxyBase)?.hostname?.toLowerCase() || "";
  }

  function excludedHost(host) {
    host = String(host || "").toLowerCase();
    if (excluded.has(host)) return true;
    for (const domain of excluded) if (host.endsWith("." + domain)) return true;
    return false;
  }

  function absoluteHTTP(value) {
    const raw = String(value || "").trim();
    if (!raw || /^(?:data|blob|javascript|mailto|tel|about):/i.test(raw)) return null;
    const url = parseURL(raw);
    return url && /^https?:$/.test(url.protocol) ? url : null;
  }

  function shouldBypass(value) {
    const url = absoluteHTTP(value);
    if (!url) return true;
    const host = url.hostname.toLowerCase();
    if (proxyHost && host === proxyHost) return true;
    if (excludedHost(host) || excludedHost(location.hostname)) return true;
    const path = url.pathname.toLowerCase();
    return path.endsWith(".ico") || path.endsWith(".svg") || path.includes("favicon");
  }

  function proxy(value) {
    const url = absoluteHTTP(value);
    if (!url || !opts.enabled || !opts.proxyBase || shouldBypass(url.href)) return value;
    const params = new URLSearchParams({
      url: url.href,
      jpeg: opts.isWebpSupported ? "0" : "1",
      bw: opts.grayscale ? "1" : "0",
      quality: String(opts.quality ?? 40),
    });
    if (opts.maxWidth) params.set("max_width", String(opts.maxWidth));
    return opts.proxyBase + "?" + params.toString();
  }

  function rewriteSrcset(value) { return value; }

  function isImagePreload(link) {
    if (!(link instanceof HTMLLinkElement)) return false;
    return /(?:^|\s)preload(?:\s|$)/i.test(link.getAttribute("rel") || "") &&
      String(link.getAttribute("as") || "").toLowerCase() === "image";
  }

  function rewriteLinkHref(link, value) { return value; }

  function decideSrc(value) {
    if (!ready) return null;
    if (!opts.enabled || !opts.proxyBase) return value;
    return shouldBypass(value) ? value : proxy(value);
  }

  function nativeSrc(el, value) { srcDesc?.set?.call(el, value); }
  function nativeSrcset(el, value) { srcsetDesc?.set?.call(el, value); }
  function nativeSourceSrcset(el, value) { sourceSrcsetDesc?.set?.call(el, value); }
  function nativeLinkHref(el, value) { linkHrefDesc?.set?.call(el, value); }

  // Fail-open helpers: while settings are loading, never replace a real URL with about:blank.
  // That was a major source of blank images on sites such as twkan.com.
  function recordSafeOriginal(el, original) {
    if (el && original != null) {
      const state = failoverState.get(el) || { restored: false };
      state.originalSrc = String(original);
      state.proxiedSrc = null;
      state.restored = false;
      failoverState.set(el, state);
    }
    return String(original ?? "");
  }
  function recordSafeSrcset(el, original) {
    if (el && original != null) {
      const state = failoverState.get(el) || { restored: false };
      state.originalSrcset = String(original);
      state.restored = false;
      failoverState.set(el, state);
    }
    return String(original ?? "");
  }

  function queue(el, record) {
    pending.set(el, { ...(pending.get(el) || {}), ...record });
    pendingElements.add(el);
  }

  function flushPending() {
    for (const el of pendingElements) {
      const record = pending.get(el);
      pending.delete(el);
      pendingElements.delete(el);
      if (!record) continue;
      try {
        if (record.src !== undefined && el instanceof HTMLImageElement) nativeSrc(el, decideSrc(record.src) ?? record.src);
        if (record.srcset !== undefined) {
          if (el instanceof HTMLImageElement) nativeSrcset(el, record.srcset);
          else if (el instanceof HTMLSourceElement) nativeSourceSrcset(el, record.srcset);
        }
        if (record.href !== undefined && el instanceof HTMLLinkElement) nativeLinkHref(el, rewriteLinkHref(el, record.href));
      } catch {}
    }
  }

  function failOpen() {
    if (ready) return;
    ready = true;
    flushPending();
  }

  // Storage is normally fast because the service worker mirrors sync -> local.
  // Never hold a critical image request indefinitely if storage is unavailable.
  readyTimer = setTimeout(failOpen, 180);

  function loadOptions() {
    chrome.storage.local.get({ bhOpts: null }, (data) => {
      if (data?.bhOpts) {
        configure(data.bhOpts);
        ready = true;
        clearTimeout(readyTimer);
        flushPending();
        return;
      }
      chrome.storage.sync.get(DEFAULTS, (synced) => {
        configure(synced);
        ready = true;
        clearTimeout(readyTimer);
        flushPending();
        chrome.storage.local.set({ bhOpts: synced });
      });
    });
  }
  loadOptions();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      configure(changes.bhOpts.newValue);
      ready = true;
      flushPending();
    } else if (area === "sync") {
      chrome.storage.sync.get(DEFAULTS, (synced) => {
        configure(synced);
        ready = true;
        flushPending();
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  if (srcDesc?.set) Object.defineProperty(imgProto, "src", {
    configurable: true, enumerable: srcDesc.enumerable, get: srcDesc.get,
    set(value) {
      try {
        const original = String(value);
        const decided = decideSrc(original);
        if (decided === null) {
          queue(this, { src: original });
          nativeSrc(this, recordSafeOriginal(this, original));
        } else {
          try { delete this[FAILOVER_MARK]; } catch {}
          if (decided !== original) rememberFailover(this, original, decided);
          else failoverState.delete(this);
          nativeSrc(this, decided);
          if (decided !== original) armDecodeCheck(this);
        }
      } catch { nativeSrc(this, value); }
    },
  });

  if (srcsetDesc?.set) Object.defineProperty(imgProto, "srcset", {
    configurable: true, enumerable: srcsetDesc.enumerable, get: srcsetDesc.get,
    set(value) {
      try {
        const original = String(value || "");
        if (!ready) { queue(this, { srcset: original }); nativeSrcset(this, recordSafeSrcset(this, original)); }
        else nativeSrcset(this, original);
      } catch { nativeSrcset(this, value); }
    },
  });

  if (false && sourceSrcsetDesc?.set) Object.defineProperty(sourceProto, "srcset", {
    configurable: true, enumerable: sourceSrcsetDesc.enumerable, get: sourceSrcsetDesc.get,
    set(value) {
      try {
        const original = String(value || "");
        if (!ready) { queue(this, { srcset: original }); nativeSourceSrcset(this, ""); }
        else nativeSourceSrcset(this, (!opts.enabled || !opts.proxyBase) ? original : rewriteSrcset(original));
      } catch { nativeSourceSrcset(this, value); }
    },
  });

  if (linkHrefDesc?.set) Object.defineProperty(linkProto, "href", {
    configurable: true, enumerable: linkHrefDesc.enumerable, get: linkHrefDesc.get,
    set(value) {
      try {
        const original = String(value);
        if (!isImagePreload(this) && !/preload/i.test(this.getAttribute?.("rel") || "")) {
          nativeLinkHref(this, value); return;
        }
        if (!ready) { queue(this, { href: original }); nativeLinkHref(this, recordSafeOriginal(this, original)); }
        else nativeLinkHref(this, rewriteLinkHref(this, original));
      } catch { nativeLinkHref(this, value); }
    },
  });

  Element.prototype.setAttribute = function(name, value) {
    try {
      const attr = String(name).toLowerCase();
      if (this instanceof HTMLImageElement) {
        if (attr === "src") {
          const original = String(value);
          const decided = decideSrc(original);
          if (decided === null) { queue(this, { src: original }); return nativeSetAttribute.call(this, "src", recordSafeOriginal(this, original)); }
          try { delete this[FAILOVER_MARK]; } catch {}
          if (decided !== original) { rememberFailover(this, original, decided); armDecodeCheck(this); }
          else failoverState.delete(this);
          return nativeSetAttribute.call(this, "src", decided);
        }
        if (attr === "srcset") {
          const original = String(value || "");
          if (!ready) { queue(this, { srcset: original }); return nativeSetAttribute.call(this, "srcset", recordSafeSrcset(this, original)); }
          try { delete this[FAILOVER_MARK]; } catch {}
          // Responsive candidate selection stays native. The content script applies
          // a narrow, fail-safe width-descriptor optimization after DOM insertion.
          return nativeSetAttribute.call(this, "srcset", original);
        }
      }
      if (this instanceof HTMLSourceElement && attr === "srcset") {
        const original = String(value || "");
        if (!ready) { queue(this, { srcset: original }); return nativeSetAttribute.call(this, "srcset", recordSafeSrcset(this, original)); }
        return nativeSetAttribute.call(this, "srcset", original);
      }
      if (this instanceof HTMLLinkElement && (attr === "href" || attr === "rel" || attr === "as")) {
        const rel = attr === "rel" ? String(value) : this.getAttribute("rel") || "";
        const as = attr === "as" ? String(value) : this.getAttribute("as") || "";
        if (attr === "href" && /(?:^|\s)preload(?:\s|$)/i.test(rel) && as.toLowerCase() === "image") {
          const original = String(value);
          if (!ready) { queue(this, { href: original }); return nativeSetAttribute.call(this, "href", recordSafeOriginal(this, original)); }
          return nativeSetAttribute.call(this, "href", rewriteLinkHref(this, original));
        }
      }
    } catch {}
    return nativeSetAttribute.call(this, name, value);
  };

  // Preserve Image() behavior/shape as closely as possible.
  function PatchedImage(width, height) { return new NativeImage(width, height); }
  PatchedImage.prototype = NativeImage.prototype;
  try { Object.setPrototypeOf(PatchedImage, NativeImage); } catch {}
  Object.defineProperty(window, "Image", { configurable: true, writable: true, value: PatchedImage });
})();
