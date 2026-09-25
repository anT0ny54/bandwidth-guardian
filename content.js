// Bandwidth Guardian — isolated-world content script
//
// The MAIN-world prehook handles synchronous JavaScript assignments. This
// isolated script handles parser-created markup after settings load, lazy
// attributes, inline backgrounds, dynamic DOM additions, and image preloads.
// Keeping DOM scans here avoids exposing the extension's chrome.* APIs to page
// code while still catching the parser path that JavaScript hooks cannot see.

(() => {
  "use strict";

  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo"
  ];

  // Cheap selectors: only inspect nodes that can actually contain our targets.
  const BG_SELECTOR = "[style*='background' i]";
  const LAZY_SELECTOR =
    LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");
  const PRELOAD_SELECTOR = "link[rel][as][href]";

  const nativeImgSrcDesc =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const nativeImgSrcsetDesc =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "srcset");
  const nativeSourceSrcsetDesc =
    typeof HTMLSourceElement !== "undefined"
      ? Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, "srcset")
      : null;
  const nativeSetAttr = Element.prototype.setAttribute;

  let opts = null;

  // Independent markers because an element can need several transformations.
  const doneImg = new WeakSet();
  const doneLazy = new WeakSet();
  const doneBg = new WeakSet();
  const donePreload = new WeakSet();

  // Ignore the next MutationObserver record caused by our own write. This
  // prevents an unnecessary second URL decision/rewrite pass.
  const internalWrites = new WeakMap();

  function markInternal(el, attr) {
    let attrs = internalWrites.get(el);
    if (!attrs) {
      attrs = new Set();
      internalWrites.set(el, attrs);
    }
    attrs.add(attr);
  }

  function consumeInternal(el, attr) {
    const attrs = internalWrites.get(el);
    if (!attrs || !attrs.delete(attr)) return false;
    if (!attrs.size) internalWrites.delete(el);
    return true;
  }

  function setNativeAttr(el, name, value) {
    markInternal(el, name);
    nativeSetAttr.call(el, name, value);
  }

  function rewriteSrcsetValue(value) {
    const ss = String(value || "");
    if (!ss || !opts?.proxyBase || !opts?.enabled) return ss;

    let touched = false;
    const rewritten = ss.split(",").map(part => {
      const m = part.trim().match(/^(\S+)(\s.*)?$/);
      if (!m) return part;

      const raw = m[1];
      const desc = m[2] || "";
      const target = bhResolveHttpURL(raw);
      if (!target) return part;
      if (bhShouldSkip(target.href, target.hostname, opts, location.hostname)) {
        return part;
      }

      touched = true;
      return bhBuildProxyUrl(target.href, opts) + desc;
    }).join(", ");

    return touched ? rewritten : ss;
  }

  function rewriteImg(el) {
    if (!el || doneImg.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;
    const isImg = el.tagName === "IMG";
    const isPictureSource =
      el.tagName === "SOURCE" && el.parentElement?.tagName === "PICTURE";

    if (isImg) {
      const raw = el.getAttribute("src");
      const target = bhResolveHttpURL(raw);

      if (target && !bhShouldSkip(target.href, target.hostname, opts, location.hostname)) {
        try {
          markInternal(el, "src");
          nativeImgSrcDesc?.set?.call(el, bhBuildProxyUrl(target.href, opts));
          rewrote = true;
        } catch {}
      }
    }

    if (isImg || isPictureSource) {
      const rawSrcset = el.getAttribute("srcset");
      if (rawSrcset) {
        const rewritten = rewriteSrcsetValue(rawSrcset);
        if (rewritten !== rawSrcset) {
          setNativeAttr(el, "srcset", rewritten);
          rewrote = true;
        }
      }
    }

    if (rewrote) doneImg.add(el);
  }

  function rewriteLazy(el) {
    if (!el || doneLazy.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    for (const attr of LAZY_ATTRS) {
      const raw = el.getAttribute(attr);
      const target = bhResolveHttpURL(raw);
      if (!target) continue;
      if (bhShouldSkip(target.href, target.hostname, opts, location.hostname)) continue;

      setNativeAttr(el, attr, bhBuildProxyUrl(target.href, opts));
      rewrote = true;
    }

    const rawSrcset = el.getAttribute("data-srcset");
    if (rawSrcset) {
      const rewritten = rewriteSrcsetValue(rawSrcset);
      if (rewritten !== rawSrcset) {
        setNativeAttr(el, "data-srcset", rewritten);
        rewrote = true;
      }
    }

    if (rewrote) doneLazy.add(el);
  }

  function rewriteBg(el) {
    if (!el || doneBg.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    const css = el.style?.backgroundImage;
    if (!css || !/\burl\(/i.test(css)) return;

    let touched = false;
    const rewritten = css.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
      (full, doubleQuoted, singleQuoted, unquoted) => {
        const raw = String(doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
        const target = bhResolveHttpURL(raw);
        if (!target ||
            bhShouldSkip(target.href, target.hostname, opts, location.hostname)) {
          return full;
        }

        touched = true;
        const proxy = bhBuildProxyUrl(target.href, opts);
        return `url("${proxy.replace(/"/g, '\\"')}")`;
      }
    );

    if (touched) {
      markInternal(el, "style");
      el.style.backgroundImage = rewritten;
      doneBg.add(el);
    }
  }

  function isImagePreload(el) {
    if (!el || el.tagName !== "LINK") return false;
    const rel = String(el.getAttribute("rel") || "").toLowerCase();
    const as = String(el.getAttribute("as") || "").toLowerCase();
    return /\bpreload\b/.test(rel) && as === "image";
  }

  function rewritePreload(el) {
    if (!el || donePreload.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled || !isImagePreload(el)) return;

    const raw = el.getAttribute("href");
    const target = bhResolveHttpURL(raw);
    if (!target ||
        bhShouldSkip(target.href, target.hostname, opts, location.hostname)) {
      return;
    }

    setNativeAttr(el, "href", bhBuildProxyUrl(target.href, opts));
    donePreload.add(el);
  }

  function rewriteAll() {
    document.querySelectorAll("img, picture source").forEach(rewriteImg);
    document.querySelectorAll(LAZY_SELECTOR).forEach(rewriteLazy);
    document.querySelectorAll(BG_SELECTOR).forEach(rewriteBg);
    document.querySelectorAll(PRELOAD_SELECTOR).forEach(rewritePreload);
  }

  function clearPreconnects() {
    document.querySelectorAll("link[data-bh-preconnect]").forEach(el => el.remove());
  }

  function injectPreconnect(proxyBase) {
    try {
      const origin = new URL(proxyBase).origin;
      const existing = Array.from(
        document.querySelectorAll("link[data-bh-preconnect]")
      );
      const same = existing.some(el => {
        try { return new URL(el.href).origin === origin; } catch { return false; }
      });

      for (const el of existing) {
        try {
          if (new URL(el.href).origin !== origin) el.remove();
        } catch {
          el.remove();
        }
      }
      if (same) return;

      const root = document.head || document.documentElement;
      if (!root) return;

      const dns = document.createElement("link");
      dns.rel = "dns-prefetch";
      dns.href = origin;
      dns.setAttribute("data-bh-preconnect", "dns");

      const pc = document.createElement("link");
      pc.rel = "preconnect";
      pc.href = origin;
      pc.crossOrigin = "anonymous";
      pc.setAttribute("data-bh-preconnect", "preconnect");

      root.prepend(dns);
      root.prepend(pc);
    } catch {}
  }

  const mo = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;

          rewriteImg(node);
          rewriteLazy(node);
          rewriteBg(node);
          rewritePreload(node);

          node.querySelectorAll?.("img, picture source").forEach(rewriteImg);
          node.querySelectorAll?.(LAZY_SELECTOR).forEach(rewriteLazy);
          node.querySelectorAll?.(BG_SELECTOR).forEach(rewriteBg);
          node.querySelectorAll?.(PRELOAD_SELECTOR).forEach(rewritePreload);
        }
        continue;
      }

      const target = m.target;
      if (!target) continue;
      if (consumeInternal(target, m.attributeName)) continue;

      if (m.attributeName === "src" || m.attributeName === "srcset") {
        if (target.tagName === "IMG" || target.tagName === "SOURCE") {
          doneImg.delete(target);
          rewriteImg(target);
        }
      } else if (m.attributeName === "style") {
        doneBg.delete(target);
        rewriteBg(target);
      } else if (
        LAZY_ATTRS.includes(m.attributeName) ||
        m.attributeName === "data-srcset"
      ) {
        doneLazy.delete(target);
        rewriteLazy(target);
      } else if (
        (m.attributeName === "href" ||
         m.attributeName === "rel" ||
         m.attributeName === "as") &&
        target.tagName === "LINK"
      ) {
        donePreload.delete(target);
        rewritePreload(target);
      }
    }
  });

  const observerConfig = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "src", "srcset", "style",
      ...LAZY_ATTRS, "data-srcset",
      "href", "rel", "as"
    ]
  };

  let observing = false;

  function setObserverEnabled(enabled) {
    if (enabled === observing) return;
    observing = enabled;
    if (enabled) mo.observe(document, observerConfig);
    else mo.disconnect();
  }

  function applyOptions(o) {
    opts = o;
    const active = !!(opts?.enabled && opts?.proxyBase);
    setObserverEnabled(active);

    if (active) {
      injectPreconnect(opts.proxyBase);
      rewriteAll();
    } else {
      clearPreconnects();
    }
  }

  bhOnReady(applyOptions);
  bhOnOptsChange(applyOptions);
})();

