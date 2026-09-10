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

  function rewriteSrcset(value) {
    if (!value) return value;
    return String(value).split(",").map((part) => {
      const match = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!match) return part;
      const [, url, descriptor = ""] = match;
      return shouldBypass(url) ? part : proxy(url) + descriptor;
    }).join(", ");
  }

  function isImagePreload(link) {
    if (!(link instanceof HTMLLinkElement)) return false;
    return /(?:^|\s)preload(?:\s|$)/i.test(link.getAttribute("rel") || "") &&
      String(link.getAttribute("as") || "").toLowerCase() === "image";
  }

  function rewriteLinkHref(link, value) {
    return isImagePreload(link) ? proxy(value) : value;
  }

  function decideSrc(value) {
    if (!ready) return null;
    if (!opts.enabled || !opts.proxyBase) return value;
    return shouldBypass(value) ? value : proxy(value);
  }

  function nativeSrc(el, value) { srcDesc?.set?.call(el, value); }
  function nativeSrcset(el, value) { srcsetDesc?.set?.call(el, value); }
  function nativeSourceSrcset(el, value) { sourceSrcsetDesc?.set?.call(el, value); }
  function nativeLinkHref(el, value) { linkHrefDesc?.set?.call(el, value); }

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
          if (el instanceof HTMLImageElement) nativeSrcset(el, rewriteSrcset(record.srcset));
          else if (el instanceof HTMLSourceElement) nativeSourceSrcset(el, rewriteSrcset(record.srcset));
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
          nativeSrc(this, "about:blank");
        } else nativeSrc(this, decided);
      } catch { nativeSrc(this, value); }
    },
  });

  if (srcsetDesc?.set) Object.defineProperty(imgProto, "srcset", {
    configurable: true, enumerable: srcsetDesc.enumerable, get: srcsetDesc.get,
    set(value) {
      try {
        const original = String(value || "");
        if (!ready) { queue(this, { srcset: original }); nativeSrcset(this, ""); }
        else nativeSrcset(this, (!opts.enabled || !opts.proxyBase) ? original : rewriteSrcset(original));
      } catch { nativeSrcset(this, value); }
    },
  });

  if (sourceSrcsetDesc?.set) Object.defineProperty(sourceProto, "srcset", {
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
        if (!ready) { queue(this, { href: original }); nativeLinkHref(this, "about:blank"); }
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
          if (decided === null) { queue(this, { src: original }); return nativeSetAttribute.call(this, "src", "about:blank"); }
          return nativeSetAttribute.call(this, "src", decided);
        }
        if (attr === "srcset") {
          const original = String(value || "");
          if (!ready) { queue(this, { srcset: original }); return nativeSetAttribute.call(this, "srcset", ""); }
          return nativeSetAttribute.call(this, "srcset", (!opts.enabled || !opts.proxyBase) ? original : rewriteSrcset(original));
        }
      }
      if (this instanceof HTMLSourceElement && attr === "srcset") {
        const original = String(value || "");
        if (!ready) { queue(this, { srcset: original }); return nativeSetAttribute.call(this, "srcset", ""); }
        return nativeSetAttribute.call(this, "srcset", (!opts.enabled || !opts.proxyBase) ? original : rewriteSrcset(original));
      }
      if (this instanceof HTMLLinkElement && (attr === "href" || attr === "rel" || attr === "as")) {
        const rel = attr === "rel" ? String(value) : this.getAttribute("rel") || "";
        const as = attr === "as" ? String(value) : this.getAttribute("as") || "";
        if (attr === "href" && /(?:^|\s)preload(?:\s|$)/i.test(rel) && as.toLowerCase() === "image") {
          const original = String(value);
          if (!ready) { queue(this, { href: original }); return nativeSetAttribute.call(this, "href", "about:blank"); }
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
