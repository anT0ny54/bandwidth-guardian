// Bandwidth Guardian — prehook (runs at document_start)
//
// Intercepts <img src>, srcset, and new Image() assignments before the page
// can trigger full-resolution image requests.
//
// Logic unchanged; comments cleaned up and typo fixed.

(() => {
  const defaults = {
    enabled: true,
    proxyBase: "",
    quality: 40,
    grayscale: true,
    maxWidth: 1920,
    excludeDomains: "google.com gstatic.com",
    isWebpSupported: false,
  };

  let opts = null;
  let ready = false;
  const pending = new Set();

  const safeURL = (u) => {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  };

  const toDomainSet = (text) =>
    new Set(
      String(text || "")
        .split(/[, \n\r\t]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((s) => s.replace(/^https?:\/\//, "").split("/")[0])
    );

  const isHttp = (u) => /^https?:\/\//i.test(u);

  function buildProxyUrl(orig) {
    if (!opts || !opts.proxyBase || !isHttp(orig)) return orig;

    const base = opts.proxyBase.trim();
    if (!base) return orig;

    const sep = base.includes("?") ? "&" : "?";
    const jpeg = opts.isWebpSupported ? "0" : "1";
    const bw = opts.grayscale ? "1" : "0";

    const parts = [
      "url=" + encodeURIComponent(orig),
      "jpeg=" + jpeg,
      "bw=" + bw,
      "quality=" + encodeURIComponent(String(opts.quality ?? 40)),
    ];
    if (opts.maxWidth) {
      parts.push("max_width=" + encodeURIComponent(String(opts.maxWidth)));
    }

    return base + sep + parts.join("&");
  }

  function excludedHost(host) {
    if (!opts) return false;
    const ex = toDomainSet(opts.excludeDomains);
    return ex.has(host.toLowerCase());
  }

  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const setAttr = Element.prototype.setAttribute;
  const sourceProto = HTMLSourceElement?.prototype;
  const sourceSrcsetDesc = sourceProto
    ? Object.getOwnPropertyDescriptor(sourceProto, "srcset")
    : null;

  function nativeSetSrc(el, v) {
    srcDesc.set.call(el, v);
  }

  function nativeSetSrcset(el, v) {
    srcsetDesc?.set?.call(el, v);
  }

  function nativeSourceSetSrcset(el, v) {
    sourceSrcsetDesc?.set?.call(el, v);
  }

  function rewriteSrcset(ss) {
    if (!ss) return ss;

    return ss
      .split(",")
      .map((part) => {
        const m = part.trim().match(/^(\S+)(\s+.+)?$/);
        if (!m) return part;

        const url = m[1];
        const desc = m[2] || "";
        if (!isHttp(url)) return part;

        const u = safeURL(url);
        if (!u) return part;
        if (opts && excludedHost(u.hostname)) return part;

        return buildProxyUrl(url) + desc;
      })
      .join(", ");
  }

  function decideSrc(original) {
    if (!isHttp(original)) return original;

    const u = safeURL(original);
    if (!u) return original;
    if (opts && excludedHost(u.hostname)) return original;

    if (!ready || !opts || !opts.proxyBase) {
      return null;
    }
    return buildProxyUrl(original);
  }

  function flushPending() {
    for (const img of Array.from(pending)) {
      pending.delete(img);
      try {
        const orig = img.dataset.bhPendingSrc;
        if (orig) {
          const u = safeURL(orig);
          if (u && !excludedHost(u.hostname)) {
            img.removeAttribute("data-bh-pending-src");
            nativeSetSrc(img, buildProxyUrl(orig));
          } else {
            nativeSetSrc(img, orig);
          }
        }

        const pendingSrcset = img.dataset.bhPendingSrcset;
        if (pendingSrcset) {
          img.removeAttribute("data-bh-pending-srcset");
          nativeSetSrcset(img, rewriteSrcset(pendingSrcset));
        }
      } catch {}
    }
  }

  chrome.storage.local.get({ bhOpts: null }, (d) => {
    if (d.bhOpts) {
      opts = d.bhOpts;
      ready = true;
      flushPending();
    } else {
      chrome.storage.sync.get(defaults, (synced) => {
        opts = synced;
        ready = true;
        flushPending();
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      opts = changes.bhOpts.newValue || defaults;
      ready = true;
      flushPending();
    } else if (area === "sync") {
      chrome.storage.sync.get(defaults, (synced) => {
        opts = synced;
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
        const decided = decideSrc(String(value));
        if (decided === null) {
          this.dataset.bhPendingSrc = String(value);
          pending.add(this);
          nativeSetSrc(this, "about:blank");
        } else {
          nativeSetSrc(this, decided);
        }
      } catch {
        nativeSetSrc(this, value);
      }
    },
  });

  if (srcsetDesc && srcsetDesc.set) {
    Object.defineProperty(imgProto, "srcset", {
      configurable: true,
      enumerable: srcsetDesc.enumerable,
      get: srcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          if (!ready || !opts || !opts.proxyBase) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            nativeSetSrcset(this, "");
          } else {
            nativeSetSrcset(this, rewriteSrcset(v));
          }
        } catch {
          nativeSetSrcset(this, value);
        }
      },
    });
  }

  if (sourceProto && sourceSrcsetDesc && sourceSrcsetDesc.set) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get: sourceSrcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          if (!ready || !opts || !opts.proxyBase) {
            this.dataset.bhPendingSrcset = v;
          } else {
            nativeSourceSetSrcset(this, rewriteSrcset(v));
          }
        } catch {
          nativeSourceSetSrcset(this, value);
        }
      },
    });
  }

  Element.prototype.setAttribute = function (name, value) {
    try {
      const n = String(name).toLowerCase();

      if (this instanceof HTMLImageElement && (n === "src" || n === "srcset")) {
        if (n === "src") {
          const decided = decideSrc(String(value));
          if (decided === null) {
            this.dataset.bhPendingSrc = String(value);
            pending.add(this);
            return setAttr.call(this, "src", "about:blank");
          }
          return setAttr.call(this, "src", decided);
        }

        const v = String(value || "");
        if (!ready || !opts || !opts.proxyBase) {
          this.dataset.bhPendingSrcset = v;
          pending.add(this);
          return setAttr.call(this, "srcset", "");
        }
        return setAttr.call(this, "srcset", rewriteSrcset(v));
      }

      if (this instanceof HTMLSourceElement && n === "srcset") {
        const v = String(value || "");
        if (!ready || !opts || !opts.proxyBase) {
          this.dataset.bhPendingSrcset = v;
          return setAttr.call(this, "srcset", v);
        }
        return setAttr.call(this, "srcset", rewriteSrcset(v));
      }
    } catch {}

    return setAttr.call(this, name, value);
  };

  const NativeImage = window.Image;
  function PatchedImage(width, height) {
    return new NativeImage(width, height);
  }
  PatchedImage.prototype = NativeImage.prototype;
  Object.defineProperty(window, "Image", {
    configurable: true,
    writable: true,
    value: PatchedImage,
  });
})();
