// Bandwidth Guardian — prehook (runs at document_start)
// Intercepts <img src>, srcset, and new Image() assignments to prevent the
// original full-resolution images from ever being downloaded.
//
// Shared constants and the URL-skip / proxy-URL-building logic (defaults,
// tracking patterns, bhShouldSkip, bhBuildProxyUrl) live in shared.js,
// loaded immediately before this file — see manifest.json's content_scripts
// entry and the notice at the top of shared.js for why that file exists.

(() => {
  let opts = null;        // loaded options (null until storage responds)
  let ready = false;      // true once options have loaded
  const pending = new Set(); // <img>/<source> elements waiting for opts to be ready

  // Try storage.local first (bhOpts mirror written by the service worker, ~5 ms).
  // If bhOpts is missing — fresh install, service worker not yet run, or browser
  // restart before onStartup fired — fall back to storage.sync so we never
  // silently use empty defaults and let original images through.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (d.bhOpts) {
      opts = d.bhOpts;
      ready = true;
      flushPending();
    } else {
      chrome.storage.sync.get(BH_DEFAULTS, synced => {
        opts = synced;
        ready = true;
        flushPending();
        // Write the mirror so subsequent pages load fast
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror, instant).
  // Fallback: sync area — catches changes when the service worker is inactive
  // or not supported (Kiwi/Cromite).
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      opts = changes.bhOpts.newValue || BH_DEFAULTS;
      ready = true;
    } else if (area === "sync") {
      chrome.storage.sync.get(BH_DEFAULTS, synced => {
        opts = synced;
        ready = true;
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  // Capture native property descriptors BEFORE we patch them
  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const setAttr = Element.prototype.setAttribute;
  const sourceProto = HTMLSourceElement?.prototype;
  const sourceSrcsetDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;

  function nativeSetSrc(el, v) { srcDesc.set.call(el, v); }
  function nativeSetSrcset(el, v) { srcsetDesc?.set?.call(el, v); }
  function nativeSourceSetSrcset(el, v) { sourceSrcsetDesc?.set?.call(el, v); }

  function rewriteSrcset(ss) {
    if (!ss) return ss;
    return ss.split(",").map(part => {
      const m = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) return part;
      const url = m[1];
      const desc = m[2] || "";
      if (!bhIsHttp(url)) return part;
      const u = bhSafeURL(url);
      if (!u) return part;
      if (opts && bhShouldSkip(url, u.hostname, opts, location.hostname)) return part;
      return bhBuildProxyUrl(url, opts) + desc;
    }).join(", ");
  }

  function decideSrc(original) {
    if (!bhIsHttp(original)) return original;
    const u = bhSafeURL(original);
    if (!u) return original;
    if (opts && bhShouldSkip(original, u.hostname, opts, location.hostname)) return original;
    if (!ready || !opts || !opts.proxyBase) {
      return null; // signal to queue this element
    }
    return bhBuildProxyUrl(original, opts);
  }

  // Flush any <img>/<source> elements that were queued before opts loaded.
  function flushPending() {
    for (const img of Array.from(pending)) {
      pending.delete(img);
      try {
        const orig = img.dataset.bhPendingSrc;
        if (orig) {
          const u = bhSafeURL(orig);
          if (u && !bhShouldSkip(orig, u.hostname, opts, location.hostname)) {
            img.removeAttribute("data-bh-pending-src");
            nativeSetSrc(img, bhBuildProxyUrl(orig, opts));
          } else {
            nativeSetSrc(img, orig);
          }
        }
        const pendingSrcset = img.dataset.bhPendingSrcset;
        if (pendingSrcset) {
          img.removeAttribute("data-bh-pending-srcset");
          // <source> (inside <picture>) and <img> use different native
          // accessors — calling the wrong one throws "Illegal invocation"
          // and is silently swallowed by the outer try/catch, so the
          // element's srcset would never be restored. Dispatch by tag.
          if (img.tagName === "SOURCE") {
            nativeSourceSetSrcset(img, rewriteSrcset(pendingSrcset));
          } else {
            nativeSetSrcset(img, rewriteSrcset(pendingSrcset));
          }
        }
      } catch {}
    }
  }

  // ── Patch <img>.src ────────────────────────────────────────────────────────
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
    }
  });

  // ── Patch <img>.srcset ─────────────────────────────────────────────────────
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
      }
    });
  }

  // ── Patch <source>.srcset inside <picture> ────────────────────────────────
  if (sourceProto && sourceSrcsetDesc && sourceSrcsetDesc.set) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get: sourceSrcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          if (!ready || !opts || !opts.proxyBase) {
            // Queue it, same as <img>.srcset above — without this the
            // native setter is never called, so the attribute stays empty
            // forever and the <picture> element never gets an image.
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            nativeSourceSetSrcset(this, "");
          } else {
            nativeSourceSetSrcset(this, rewriteSrcset(v));
          }
        } catch {
          nativeSourceSetSrcset(this, value);
        }
      }
    });
  }

  // ── Patch Element.prototype.setAttribute for attribute-based src assignment ─
  Element.prototype.setAttribute = function(name, value) {
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
        } else if (n === "srcset") {
          const v = String(value || "");
          if (!ready || !opts || !opts.proxyBase) {
            this.dataset.bhPendingSrcset = v;
            pending.add(this);
            return setAttr.call(this, "srcset", "");
          }
          return setAttr.call(this, "srcset", rewriteSrcset(v));
        }
      }
      if (this instanceof HTMLSourceElement && n === "srcset") {
        const v = String(value || "");
        if (!ready || !opts || !opts.proxyBase) {
          // Was setting the raw (unproxied) URL immediately and never
          // revisiting it — the original image loaded uncompressed and
          // flushPending() had no record of the element. Queue it instead,
          // same as every other pending case.
          this.dataset.bhPendingSrcset = v;
          pending.add(this);
          return setAttr.call(this, "srcset", "");
        }
        return setAttr.call(this, "srcset", rewriteSrcset(v));
      }
    } catch {}
    return setAttr.call(this, name, value);
  };

  // ── Patch Image() constructor ──────────────────────────────────────────────
  // new Image().src = "..." also goes through the patched src setter above.
  const NativeImage = window.Image;
  function PatchedImage(width, height) {
    const img = new NativeImage(width, height);
    return img;
  }
  PatchedImage.prototype = NativeImage.prototype;
  Object.defineProperty(window, "Image", { configurable: true, writable: true, value: PatchedImage });
})();
