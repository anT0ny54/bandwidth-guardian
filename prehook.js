// Bandwidth Guardian — prehook (runs at document_start)
// Intercepts <img src>, srcset and setAttribute assignments so JS-set images
// are proxied before a request is made.
//
// Shared logic (bhShouldSkip, bhBuildProxyUrl, bhRewriteSrcset, bhAbsUrl…)
// lives in shared.js, loaded immediately before this file. Options are pushed
// in by content.js through the global bhPrehookSetOpts(opts) defined below —
// there is no second storage read here.
//
// NOTE: content scripts run in an *isolated world* by default, and prototype
// patches made there are not visible to page scripts. This file only
// intercepts calls made from the isolated world unless it is registered with
// `"world": "MAIN"` (see the review notes). content.js's MutationObserver is
// the layer that actually covers page-script assignments today.

(() => {
  let opts = null;
  let ready = false;         // true once options have been pushed in
  const pending = new Set(); // elements waiting for options (only before `ready`)

  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const setAttr = Element.prototype.setAttribute;
  const sourceProto = typeof HTMLSourceElement !== "undefined" ? HTMLSourceElement.prototype : null;
  const sourceSrcsetDesc = sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;

  const nativeSetSrc = (el, v) => srcDesc.set.call(el, v);
  const nativeSetSrcset = (el, v) => srcsetDesc?.set?.call(el, v);
  const nativeSourceSetSrcset = (el, v) => sourceSrcsetDesc?.set?.call(el, v);

  const active = () => !!(opts && opts.enabled !== false && opts.proxyBase);

  // Returns the URL to use, or null to queue the element until options load.
  // Once options are known the answer is never null — the previous version
  // kept queuing (and replaced src with about:blank) forever when no proxy
  // was configured, permanently blanking every JS-set image.
  function decideSrc(original) {
    const abs = bhAbsUrl(original);
    if (!abs) return original;
    if (!ready) return null;
    if (!active()) return original;
    const u = bhSafeURL(abs);
    if (!u || bhShouldSkip(abs, u.hostname, opts, location.hostname)) return original;
    return bhBuildProxyUrl(abs, opts);
  }

  // Same contract for srcset: null = queue.
  function decideSrcset(v) {
    if (!ready) return null;
    return active() ? bhRewriteSrcset(v, opts, location.hostname) : v;
  }

  function queue(el, key, value, nativeBlank) {
    el.dataset[key] = value;
    pending.add(el);
    nativeBlank();
  }

  function flushPending() {
    for (const el of Array.from(pending)) {
      pending.delete(el);
      try {
        const origSrc = el.dataset.bhPendingSrc;
        if (origSrc != null) {
          delete el.dataset.bhPendingSrc;
          nativeSetSrc(el, decideSrc(origSrc) ?? origSrc);
        }
        const origSrcset = el.dataset.bhPendingSrcset;
        if (origSrcset != null) {
          delete el.dataset.bhPendingSrcset;
          const out = decideSrcset(origSrcset) ?? origSrcset;
          // <source> and <img> have different native accessors.
          if (el.tagName === "SOURCE") nativeSourceSetSrcset(el, out);
          else nativeSetSrcset(el, out);
        }
      } catch {}
    }
  }

  // Called by content.js on first load and on every later options change.
  globalThis.bhPrehookSetOpts = o => {
    opts = o;
    ready = true;
    flushPending();
  };

  // ── <img>.src ───────────────────────────────────────────────────────────────
  Object.defineProperty(imgProto, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get: srcDesc.get,
    set(value) {
      try {
        const v = String(value);
        const decided = decideSrc(v);
        if (decided === null) queue(this, "bhPendingSrc", v, () => nativeSetSrc(this, "about:blank"));
        else nativeSetSrc(this, decided);
      } catch {
        nativeSetSrc(this, value);
      }
    }
  });

  // ── <img>.srcset ────────────────────────────────────────────────────────────
  if (srcsetDesc?.set) {
    Object.defineProperty(imgProto, "srcset", {
      configurable: true,
      enumerable: srcsetDesc.enumerable,
      get: srcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          const decided = decideSrcset(v);
          if (decided === null) queue(this, "bhPendingSrcset", v, () => nativeSetSrcset(this, ""));
          else nativeSetSrcset(this, decided);
        } catch {
          nativeSetSrcset(this, value);
        }
      }
    });
  }

  // ── <source>.srcset (inside <picture>) ──────────────────────────────────────
  if (sourceSrcsetDesc?.set) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get: sourceSrcsetDesc.get,
      set(value) {
        try {
          const v = String(value || "");
          const decided = decideSrcset(v);
          if (decided === null) queue(this, "bhPendingSrcset", v, () => nativeSourceSetSrcset(this, ""));
          else nativeSourceSetSrcset(this, decided);
        } catch {
          nativeSourceSetSrcset(this, value);
        }
      }
    });
  }

  // ── Element.prototype.setAttribute ──────────────────────────────────────────
  // Only wraps the three cases that matter; everything else falls straight
  // through to the native implementation.
  Element.prototype.setAttribute = function (name, value) {
    try {
      const n = String(name).toLowerCase();
      if (n === "src" && this instanceof HTMLImageElement) {
        const v = String(value);
        const decided = decideSrc(v);
        if (decided === null) {
          queue(this, "bhPendingSrc", v, () => setAttr.call(this, "src", "about:blank"));
          return;
        }
        return setAttr.call(this, "src", decided);
      }
      if (n === "srcset" && (this instanceof HTMLImageElement || (sourceProto && sourceProto.isPrototypeOf(this)))) {
        const v = String(value || "");
        const decided = decideSrcset(v);
        if (decided === null) {
          queue(this, "bhPendingSrcset", v, () => setAttr.call(this, "srcset", ""));
          return;
        }
        return setAttr.call(this, "srcset", decided);
      }
    } catch {}
    return setAttr.call(this, name, value);
  };

  // The former PatchedImage wrapper was a no-op — `new Image()` already goes
  // through the patched src/srcset setters above — so it was removed.
})();
