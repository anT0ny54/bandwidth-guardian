// Bandwidth Guardian — conservative mobile image rewriter
// v0.1.0: MAIN-world prehook + isolated DOM fallback; LCP-safe stable build.
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true, proxyBase: "", quality: 40, grayscale: true,
    maxWidth: 1280, excludeDomains: "google.com gstatic.com", isWebpSupported: false,
    failoverOriginal: true,
    mobileMaxWidth: 1280,
  };

  const LAZY_ATTRS = ["data-src", "data-iurl", "data-lazy-src", "data-original", "data-url", "data-hi-res", "data-lazy", "data-echo"];
  const LAZY_SET = new Set(LAZY_ATTRS);
  const OBSERVED_ATTRS = ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset"];
  const IMAGE_SELECTOR = ["img", "picture source", "[style]", ...LAZY_ATTRS.map(a => `[${a}]`), "[data-srcset]"].join(",");
  const TRACKING_PATTERNS = [
    /pagead/i, /(pixel|cleardot)\.*\.(gif|jpg|jpeg)/i,
    /google\.([a-z.]+)\/(ads|generate_204|.*\/log204)+/i,
    /google-analytics\.([a-z.]+)\/(r|collect)+/i,
    /youtube\.([a-z.]+)\/(api|ptracking|player_204|live_204)+/i,
    /doubleclick\.([a-z.]+)\/(pcs|pixel|r)+/i,
    /googlesyndication\.([a-z.]+)\/ddm/i,
    /pixel\.facebook\.([a-z.]+)/i,
    /facebook\.([a-z.]+)\/(impression\.php|tr)+/i,
    /ad\.bitmedia\.io/i, /yahoo\.([a-z.]+)\/pixel/i,
    /criteo\.net\/img/i, /ad\.doubleclick\.net/i,
  ];

  const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const nativeSetAttribute = Element.prototype.setAttribute;
  const nativeRemoveAttribute = Element.prototype.removeAttribute;

  // State belongs to the extension's isolated world and is never written into page markup.
  const imageState = new WeakMap();
  const lazyState = new WeakMap();
  const writing = new WeakSet();
  const failed = new WeakSet();
  const doneLazy = new WeakSet();
  const doneBackground = new WeakSet();
  const urlCache = new Map();
  const CACHE_LIMIT = 768;
  const PROXY_TIMEOUT_NORMAL = 2500;
  const PROXY_TIMEOUT_LCP = 1200;

  let opts = { ...DEFAULTS };
  let excluded = new Set();
  let proxyHost = "";
  let rewriteQueued = false;
  let observerStarted = false;

  const parseURL = value => { try { return new URL(value, document.baseURI); } catch { return null; } };
  const resolveHTTP = value => {
    const u = parseURL(String(value || "").trim());
    return u && /^https?:$/.test(u.protocol) ? u : null;
  };
  const normalizeProxyBase = value => {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) return raw;
      u.hash = ""; u.search = "";
      const p = u.pathname.replace(/\/+$/, "");
      u.pathname = (!p || p === "/") ? "/api" : p;
      return u.toString().replace(/\/$/, "");
    } catch { return raw.replace(/\/+$/, ""); }
  };
  const parseDomains = text => {
    const set = new Set();
    for (const token of String(text || "").split(/[\s,]+/)) {
      const h = token.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, "");
      if (h) set.add(h);
    }
    return set;
  };
  const hostExcluded = host => {
    host = String(host || "").toLowerCase();
    if (excluded.has(host)) return true;
    for (const d of excluded) if (host.endsWith("." + d)) return true;
    return false;
  };
  const shouldSkip = value => {
    if (!opts.enabled || !opts.proxyBase) return true;
    const u = resolveHTTP(value); if (!u) return true;
    const host = u.hostname.toLowerCase(), lower = u.href.toLowerCase(), path = u.pathname.toLowerCase();
    if ((proxyHost && host === proxyHost) || hostExcluded(host) || hostExcluded(location.hostname)) return true;
    return path.endsWith(".ico") || path.endsWith(".svg") || lower.includes("favicon") || TRACKING_PATTERNS.some(p => p.test(u.href));
  };
  const buildProxyUrl = original => {
    const u = resolveHTTP(original); if (!u || shouldSkip(u.href)) return original;
    const mobile = !!matchMedia?.("(max-width: 900px)")?.matches;
    const configuredMaxWidth = Number(opts.maxWidth) || 0;
    const mobileCap = Number(opts.mobileMaxWidth) || 0;
    const effectiveMaxWidth = mobile && configuredMaxWidth > 0 && mobileCap > 0
      ? Math.min(configuredMaxWidth, mobileCap)
      : configuredMaxWidth;
    const key = `${u.href}|mw:${effectiveMaxWidth}|fmt:${opts.isWebpSupported ? "webp" : "jpeg"}|q:${opts.quality}|bw:${opts.grayscale ? 1 : 0}`;
    const cached = urlCache.get(key); if (cached) return cached;
    const params = new URLSearchParams({
      url: u.href,
      jpeg: opts.isWebpSupported ? "0" : "1",
      bw: opts.grayscale ? "1" : "0",
      quality: String(opts.quality ?? 40),
    });
    // On mobile, cap the requested proxy width for additional savings, but never
    // touch the browser's srcset/picture candidate selection. Desktop behavior stays
    // exactly at the configured maxWidth.
    if (effectiveMaxWidth > 0) params.set("max_width", String(Math.round(effectiveMaxWidth)));
    const result = `${opts.proxyBase}?${params.toString()}`;
    if (urlCache.size >= CACHE_LIMIT) urlCache.delete(urlCache.keys().next().value);
    urlCache.set(key, result);
    return result;
  };
  // IMPORTANT: never rewrite srcset or <picture>/<source> candidates.
  // Chromium owns responsive candidate selection and exposes the winner through
  // HTMLImageElement.currentSrc. Fighting that selection can cause duplicate
  // downloads, wrong DPR candidates, broken art-direction, and LCP regressions.
  const hasSrcset = img => !!img?.getAttribute?.("srcset") || !!img?.getAttribute?.("data-srcset");
  const hasPictureCandidate = img => !!img?.closest?.("picture");

  function setNativeSrc(img, value) {
    writing.add(img);
    try { imgSrc?.set?.call(img, value); } finally { queueMicrotask(() => writing.delete(img)); }
  }
  function setNativeAttr(el, name, value) {
    writing.add(el);
    try { nativeSetAttribute.call(el, name, value); } finally { queueMicrotask(() => writing.delete(el)); }
  }
  function removeNativeAttr(el, name) {
    writing.add(el);
    try { nativeRemoveAttribute.call(el, name); } finally { queueMicrotask(() => writing.delete(el)); }
  }

  function proxyPlainSrc(img, original) {
    if (!(img instanceof HTMLImageElement) || !original || shouldSkip(original)) return false;
    // Do not touch src when native candidate selection is active. This is the key
    // compatibility rule for sites using srcset/picture (including Twkan variants).
    if (hasSrcset(img) || hasPictureCandidate(img)) return false;
    const proxied = buildProxyUrl(original);
    if (!proxied || proxied === original) return false;
    const old = imageState.get(img);
    if (old?.original === original && old?.proxied === proxied && !old.failedOnce) return false;
    imageState.set(img, { original: String(original), proxied: String(proxied), failedOnce: false });
    setNativeSrc(img, proxied);
    return true;
  }

  function restoreImage(img) {
    if (!(img instanceof HTMLImageElement) || !opts.failoverOriginal) return false;
    const st = imageState.get(img);
    if (!st || st.failedOnce) return false;
    const current = img.currentSrc || img.getAttribute("src") || "";
    if (current !== st.proxied && img.getAttribute("src") !== st.proxied) return false;
    st.failedOnce = true;
    failed.add(img);
    setNativeSrc(img, st.original);
    return true;
  }

  function armDecodeCheck(img, proxied) {
    if (!(img instanceof HTMLImageElement) || !opts.failoverOriginal) return;
    const priority = String(img.getAttribute("fetchpriority") || "").toLowerCase();
    const lcpLike = priority === "high" || img.loading === "eager";
    const timeout = lcpLike ? PROXY_TIMEOUT_LCP : PROXY_TIMEOUT_NORMAL;
    setTimeout(() => {
      const st = imageState.get(img);
      if (st?.proxied === proxied && !st.failedOnce && !img.complete) restoreImage(img);
    }, timeout);
    const check = () => {
      const st = imageState.get(img);
      if (!st || st.proxied !== proxied || st.failedOnce) return;
      const current = img.currentSrc || img.getAttribute("src") || "";
      if (current !== proxied || !img.complete) return;
      if (img.naturalWidth === 0 || img.naturalHeight === 0) {
        setTimeout(() => {
          const latest = imageState.get(img);
          if (latest?.proxied === proxied && !latest.failedOnce && img.complete && (img.naturalWidth === 0 || img.naturalHeight === 0)) restoreImage(img);
        }, 100);
        return;
      }
      if (typeof img.decode === "function") Promise.resolve(img.decode()).catch(() => restoreImage(img));
    };
    if (img.complete) queueMicrotask(check);
    else img.addEventListener("load", check, { once: true });
  }

  function handleImageMutation(img) {
    if (!(img instanceof HTMLImageElement)) return;
    if (writing.has(img)) return;
    const src = img.getAttribute("src") || "";
    const st = imageState.get(img);
    if (st?.failedOnce && src === st.original) return;

    // A genuine page-side URL change starts a new attempt. A previous failed proxy
    // must never block the site's own subsequent image URL update.
    if (st && src !== st.proxied && src !== st.original) imageState.delete(img);
    if (failed.has(img) && src !== imageState.get(img)?.original) failed.delete(img);

    if (!src || shouldSkip(src)) return;
    if (hasSrcset(img) || hasPictureCandidate(img)) return;
    if (src.startsWith(opts.proxyBase)) return;
    if (proxyPlainSrc(img, src)) {
      const next = imageState.get(img);
      armDecodeCheck(img, next.proxied);
    }
  }

  function rewriteLazy(el) {
    if (!el || doneLazy.has(el) || !opts.enabled || !opts.proxyBase) return;
    // Do not proxy lazy candidates belonging to an IMG with srcset/picture. Let the
    // page choose its candidate normally; otherwise a later promotion can be broken.
    if (el instanceof HTMLImageElement && (hasSrcset(el) || hasPictureCandidate(el))) return;
    let changed = false;
    const originals = {};
    for (const attr of LAZY_ATTRS) {
      const value = el.getAttribute(attr);
      if (value && !shouldSkip(value)) {
        originals[attr] = value;
        setNativeAttr(el, attr, buildProxyUrl(value));
        changed = true;
      }
    }
    if (changed) lazyState.set(el, { originals });
  }

  function restoreLazy(el) {
    const st = lazyState.get(el);
    if (!st) return;
    for (const [attr, value] of Object.entries(st.originals || {})) setNativeAttr(el, attr, value);
    lazyState.delete(el);
  }

  function rewriteBackground(el) {
    if (!el || doneBackground.has(el) || !opts.enabled || !opts.proxyBase) return;
    const bg = el.style?.backgroundImage;
    if (!bg || !/url\(/i.test(bg)) return;
    const rewritten = bg.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full, quote, url) => shouldSkip(url) ? full : `url("${buildProxyUrl(url)}")`);
    if (rewritten !== bg) { writing.add(el); try { el.style.backgroundImage = rewritten; } finally { queueMicrotask(() => writing.delete(el)); } doneBackground.add(el); }
  }

  function processElement(el) {
    if (!el || el.nodeType !== 1) return;
    if (el instanceof HTMLImageElement) handleImageMutation(el);
    rewriteLazy(el); rewriteBackground(el);
    el.querySelectorAll?.(IMAGE_SELECTOR).forEach(node => {
      if (node instanceof HTMLImageElement) handleImageMutation(node);
      rewriteLazy(node); rewriteBackground(node);
    });
  }

  function rewriteAll() {
    if (!document.documentElement || !opts.enabled || !opts.proxyBase) return;
    document.querySelectorAll("img").forEach(handleImageMutation);
    document.querySelectorAll(IMAGE_SELECTOR).forEach(el => { rewriteLazy(el); rewriteBackground(el); });
  }
  function queueRewrite() {
    if (rewriteQueued) return;
    rewriteQueued = true;
    queueMicrotask(() => { rewriteQueued = false; rewriteAll(); });
  }
  function injectPreconnect(base) {
    try {
      const origin = parseURL(base)?.origin;
      if (!origin || !document.head) return;
      const exists = [...document.head.querySelectorAll("link[rel='preconnect']")].some(l => l.href === origin || l.href === origin + "/");
      if (!exists) { const l = document.createElement("link"); l.rel = "preconnect"; l.href = origin; l.crossOrigin = "anonymous"; document.head.prepend(l); }
    } catch {}
  }

  window.addEventListener("error", event => {
    const img = event.target;
    if (img instanceof HTMLImageElement) {
      restoreImage(img);
    }
  }, true);

  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const n of m.addedNodes) if (n.nodeType === 1) processElement(n);
        continue;
      }
      const t = m.target, a = m.attributeName;
      if (!t?.tagName || writing.has(t)) continue;
      if (a === "src") handleImageMutation(t);
      else if (a === "srcset" || a === "data-srcset") {
        // Deliberately untouched. Native Chromium candidate selection must remain
        // the source of truth for srcset/<picture>.
        if (t instanceof HTMLImageElement) {
          failed.delete(t);
          imageState.delete(t);
        }
      } else if (LAZY_SET.has(a)) {
        doneLazy.delete(t); rewriteLazy(t);
        // If a lazy loader promotes a data-* URL into src, handle it immediately.
        if (t instanceof HTMLImageElement) handleImageMutation(t);
      } else if (a === "style") { doneBackground.delete(t); rewriteBackground(t); }
    }
  });

  function startObserver() {
    if (observerStarted) return;
    const root = document.documentElement || document;
    if (!root) return;
    observerStarted = true;
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: OBSERVED_ATTRS });
  }

  function applySettings(next) {
    opts = { ...DEFAULTS, ...(next || {}) };
    opts.proxyBase = normalizeProxyBase(opts.proxyBase);
    excluded = parseDomains(opts.excludeDomains);
    proxyHost = parseURL(opts.proxyBase)?.hostname?.toLowerCase() || "";
    urlCache.clear();
    if (opts.enabled && opts.proxyBase) { injectPreconnect(opts.proxyBase); queueRewrite(); }
  }

  chrome.storage.local.get({ bhOpts: null }, data => {
    if (data?.bhOpts) { applySettings(data.bhOpts); return; }
    chrome.storage.sync.get(DEFAULTS, synced => { applySettings(synced); chrome.storage.local.set({ bhOpts: synced }); });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) applySettings(changes.bhOpts.newValue);
    else if (area === "sync") chrome.storage.sync.get(DEFAULTS, synced => { applySettings(synced); chrome.storage.local.set({ bhOpts: synced }); });
  });

  startObserver();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { startObserver(); queueRewrite(); }, { once: true });
  else queueRewrite();
})();
