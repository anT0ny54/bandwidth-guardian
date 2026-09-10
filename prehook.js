// Bandwidth Guardian — optimized document_start prehook
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

  let opts = { ...DEFAULTS };
  let ready = false;
  let excluded = new Set();
  let proxyHost = "";
  const pending = new Map();

  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const sourceProto = HTMLSourceElement.prototype;
  const sourceSrcsetDesc = Object.getOwnPropertyDescriptor(sourceProto, "srcset");
  const nativeSetAttribute = Element.prototype.setAttribute;

  function parseURL(value) {
    try { return new URL(value, document.baseURI); } catch { return null; }
  }

  function isHttp(value) {
    const url = parseURL(value);
    return !!url && (url.protocol === "http:" || url.protocol === "https:");
  }

  function absoluteHttp(value) {
    const url = parseURL(value);
    return url && (url.protocol === "http:" || url.protocol === "https:") ? url.href : String(value || "");
  }

  function parseDomains(text) {
    const set = new Set();
    for (const token of String(text || "").split(/[\s,]+/)) {
      const value = token.trim().toLowerCase();
      if (!value) continue;
      const host = value.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
      if (host) set.add(host);
    }
    return set;
  }

  function configure(next) {
    opts = { ...DEFAULTS, ...(next || {}) };
    excluded = parseDomains(opts.excludeDomains);
    proxyHost = parseURL(opts.proxyBase)?.hostname?.toLowerCase() || "";
  }

  function excludedHost(host) {
    host = host.toLowerCase();
    if (excluded.has(host)) return true;
    for (const domain of excluded) {
      if (host.endsWith("." + domain)) return true;
    }
    return false;
  }

  function shouldBypass(value) {
    if (!isHttp(value)) return true;
    const url = parseURL(value);
    if (!url) return true;
    const host = url.hostname.toLowerCase();
    if (proxyHost && host === proxyHost) return true;
    if (excludedHost(host) || excludedHost(location.hostname)) return true;
    return false;
  }

  function proxy(value) {
    if (!ready || !opts.enabled || !opts.proxyBase || shouldBypass(value)) return value;
    const base = opts.proxyBase.trim();
    if (!base) return value;

    const original = absoluteHttp(value);
    const params = new URLSearchParams({
      url: original,
      jpeg: opts.isWebpSupported ? "0" : "1",
      bw: opts.grayscale ? "1" : "0",
      quality: String(opts.quality ?? 40),
    });
    if (opts.maxWidth) params.set("max_width", String(opts.maxWidth));
    return base + (base.includes("?") ? "&" : "?") + params.toString();
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

  function decideSrc(value) {
    if (!isHttp(value)) return value;
    const original = absoluteHttp(value);
    if (!ready || !opts.enabled || !opts.proxyBase) return null;
    return shouldBypass(original) ? original : proxy(original);
  }

  function nativeSrc(el, value) {
    srcDesc?.set?.call(el, value);
  }

  function nativeSrcset(el, value) {
    srcsetDesc?.set?.call(el, value);
  }

  function nativeSourceSrcset(el, value) {
    sourceSrcsetDesc?.set?.call(el, value);
  }

  function queuePending(el, src, srcset) {
    const previous = pending.get(el) || {};
    if (src !== undefined) previous.src = src;
    if (srcset !== undefined) previous.srcset = srcset;
    pending.set(el, previous);
  }

  function flushPending() {
    for (const [el, values] of pending) {
      pending.delete(el);
      try {
        if (values.src !== undefined) {
          nativeSrc(el, decideSrc(values.src) ?? values.src);
        }

        if (values.srcset !== undefined) {
          const setter = el instanceof HTMLSourceElement ? nativeSourceSrcset : nativeSrcset;
          setter(el, rewriteSrcset(values.srcset));
        }
      } catch {}
    }
  }

  chrome.storage.local.get({ bhOpts: null }, (data) => {
    if (data.bhOpts) {
      configure(data.bhOpts);
      ready = true;
      flushPending();
    } else {
      chrome.storage.sync.get(DEFAULTS, (synced) => {
        configure(synced);
        ready = true;
        flushPending();
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

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

  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      try {
        const original = String(value);
        const decided = decideSrc(original);
        if (decided === null) {
          queuePending(this, original);
          nativeSrc(this, "about:blank");
        } else {
          nativeSrc(this, decided);
        }
      } catch {
        nativeSrc(this, value);
      }
    },
  });

  if (srcsetDesc?.set) {
    Object.defineProperty(imgProto, "srcset", {
      configurable: true,
      enumerable: srcsetDesc.enumerable,
      get: srcsetDesc.get,
      set(value) {
        try {
          const original = String(value || "");
          if (!ready || !opts.enabled || !opts.proxyBase) {
            queuePending(this, undefined, original);
            nativeSrcset(this, "");
          } else {
            nativeSrcset(this, rewriteSrcset(original));
          }
        } catch {
          nativeSrcset(this, value);
        }
      },
    });
  }

  if (sourceSrcsetDesc?.set) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get: sourceSrcsetDesc.get,
      set(value) {
        try {
          const original = String(value || "");
          if (!ready || !opts.enabled || !opts.proxyBase) {
            queuePending(this, undefined, original);
            nativeSourceSrcset(this, "");
          } else {
            nativeSourceSrcset(this, rewriteSrcset(original));
          }
        } catch {
          nativeSourceSrcset(this, value);
        }
      },
    });
  }

  Element.prototype.setAttribute = function (name, value) {
    try {
      const attr = String(name).toLowerCase();

      if (this instanceof HTMLImageElement) {
        if (attr === "src") {
          const original = String(value);
          const decided = decideSrc(original);
          if (decided === null) {
            queuePending(this, original);
            return nativeSetAttribute.call(this, "src", "about:blank");
          }
          return nativeSetAttribute.call(this, "src", decided);
        }
        if (attr === "srcset") {
          const original = String(value || "");
          if (!ready || !opts.enabled || !opts.proxyBase) {
            queuePending(this, undefined, original);
            return nativeSetAttribute.call(this, "srcset", "");
          }
          return nativeSetAttribute.call(this, "srcset", rewriteSrcset(original));
        }
      }

      if (this instanceof HTMLSourceElement && attr === "srcset") {
        const original = String(value || "");
        if (!ready || !opts.enabled || !opts.proxyBase) {
          queuePending(this, undefined, original);
          return nativeSetAttribute.call(this, "srcset", "");
        }
        return nativeSetAttribute.call(this, "srcset", rewriteSrcset(original));
      }
    } catch {}

    return nativeSetAttribute.call(this, name, value);
  };

  // Preserve the normal Image constructor shape as closely as possible while
  // ensuring new Image().src uses the patched prototype setter.
  const NativeImage = window.Image;
  function PatchedImage(width, height) {
    return new NativeImage(width, height);
  }
  PatchedImage.prototype = NativeImage.prototype;
  try {
    Object.setPrototypeOf(PatchedImage, NativeImage);
  } catch {}
  Object.defineProperty(window, "Image", {
    configurable: true,
    writable: true,
    value: PatchedImage,
  });
})();
