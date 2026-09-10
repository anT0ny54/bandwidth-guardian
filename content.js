// Bandwidth Guardian — document/image rewriter
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true, proxyBase: "", quality: 40, grayscale: true,
    maxWidth: 1920, excludeDomains: "google.com gstatic.com", isWebpSupported: false,
  };
  const LAZY_ATTRS = ["data-src", "data-iurl", "data-lazy-src", "data-original", "data-url", "data-hi-res", "data-lazy", "data-echo"];
  const LAZY_SET = new Set(LAZY_ATTRS);
  const OBSERVED_ATTRS = ["src", "srcset", "style", "href", "rel", "as", ...LAZY_ATTRS, "data-srcset"];
  const IMAGE_SELECTOR = ["img", "picture source", "link[rel~='preload'][as='image']", "[style]", ...LAZY_ATTRS.map((a) => `[${a}]`), "[data-srcset]"].join(",");
  const TRACKING_PATTERNS = [
    /pagead/i, /(pixel|cleardot)\.*\.(gif|jpg|jpeg)/i,
    /google\.([a-z.]+)\/(ads|generate_204|.*\/log204)+/i,
    /google-analytics\.([a-z.]+)\/(r|collect)+/i, /youtube\.([a-z.]+)\/(api|ptracking|player_204|live_204)+/i,
    /doubleclick\.([a-z.]+)\/(pcs|pixel|r)+/i, /googlesyndication\.([a-z.]+)\/ddm/i,
    /pixel\.facebook\.([a-z.]+)/i, /facebook\.([a-z.]+)\/(impression\.php|tr)+/i,
    /ad\.bitmedia\.io/i, /yahoo\.([a-z.]+)\/pixel/i, /criteo\.net\/img/i, /ad\.doubleclick\.net/i,
  ];

  const doneImages = new WeakSet(), doneLazy = new WeakSet(), doneBackground = new WeakSet(), doneLinks = new WeakSet();
  const urlCache = new Map();
  const CACHE_LIMIT = 768;
  let opts = { ...DEFAULTS }, excluded = new Set(), proxyHost = "", rewriteQueued = false, observerStarted = false;

  const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const imgSrcset = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "srcset");
  const sourceSrcset = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, "srcset");
  const linkHref = Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype, "href");

  const parseURL = (value) => { try { return new URL(value, document.baseURI); } catch { return null; } };
  const isHTTP = (value) => { const u = parseURL(value); return !!u && (u.protocol === "http:" || u.protocol === "https:"); };

  function normalizeProxyBase(value) {
    const raw = String(value || "").trim(); if (!raw) return "";
    try { const u = new URL(raw); if (!/^https?:$/.test(u.protocol)) return raw; u.hash = ""; u.search = ""; const p = u.pathname.replace(/\/+$/, ""); u.pathname = (!p || p === "/") ? "/api" : p; return u.toString().replace(/\/$/, ""); }
    catch { return raw.replace(/\/+$/, ""); }
  }
  function parseDomains(text) {
    const set = new Set();
    for (const token of String(text || "").split(/[\s,]+/)) { const h = token.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""); if (h) set.add(h); }
    return set;
  }
  function setOptions(next) { opts = { ...DEFAULTS, ...(next || {}) }; opts.proxyBase = normalizeProxyBase(opts.proxyBase); excluded = parseDomains(opts.excludeDomains); proxyHost = parseURL(opts.proxyBase)?.hostname?.toLowerCase() || ""; urlCache.clear(); }
  function hostExcluded(host) { host = String(host || "").toLowerCase(); if (excluded.has(host)) return true; for (const d of excluded) if (host.endsWith("." + d)) return true; return false; }

  function resolveHTTP(value) {
    const u = parseURL(String(value || "").trim());
    if (!u || !/^https?:$/.test(u.protocol)) return null;
    return u;
  }
  function shouldSkip(value) {
    if (!opts.enabled || !opts.proxyBase) return true;
    const u = resolveHTTP(value); if (!u) return true;
    const host = u.hostname.toLowerCase(), lower = u.href.toLowerCase(), path = u.pathname.toLowerCase();
    if ((proxyHost && host === proxyHost) || hostExcluded(host) || hostExcluded(location.hostname)) return true;
    return path.endsWith(".ico") || path.endsWith(".svg") || lower.includes("favicon") || TRACKING_PATTERNS.some((p) => p.test(u.href));
  }
  function buildProxyUrl(original) {
    const u = resolveHTTP(original); if (!u || shouldSkip(u.href)) return original;
    const key = u.href;
    const cached = urlCache.get(key); if (cached) return cached;
    const params = new URLSearchParams({ url: key, jpeg: opts.isWebpSupported ? "0" : "1", bw: opts.grayscale ? "1" : "0", quality: String(opts.quality ?? 40) });
    if (opts.maxWidth) params.set("max_width", String(opts.maxWidth));
    const result = `${opts.proxyBase}?${params.toString()}`;
    if (urlCache.size >= CACHE_LIMIT) urlCache.delete(urlCache.keys().next().value);
    urlCache.set(key, result); return result;
  }

  function nativeImageSrc(el, value) { imgSrc?.set?.call(el, value); }
  function nativeImageSrcset(el, value) { imgSrcset?.set?.call(el, value); }
  function nativeSourceSrcset(el, value) { sourceSrcset?.set?.call(el, value); }
  function nativeLinkHref(el, value) { linkHref?.set?.call(el, value); }

  function rewriteSrcset(el, attrName) {
    const value = el.getAttribute(attrName); if (!value) return false;
    let changed = false;
    const out = value.split(",").map((part) => {
      const m = part.trim().match(/^(\S+)(\s.*)?$/); if (!m) return part;
      const [, url, descriptor = ""] = m; if (shouldSkip(url)) return part;
      changed = true; return buildProxyUrl(url) + descriptor;
    }).join(", ");
    if (changed) el.setAttribute(attrName, out); return changed;
  }
  function rewriteImage(el) {
    if (!el || doneImages.has(el) || !opts.enabled || !opts.proxyBase) return;
    const tag = el.tagName; if (tag !== "IMG" && tag !== "SOURCE") return;
    let changed = false;
    if (tag === "IMG") {
      const src = el.getAttribute("src"); if (src && !shouldSkip(src)) { nativeImageSrc(el, buildProxyUrl(src)); changed = true; }
      if (rewriteSrcset(el, "srcset")) changed = true;
    } else if (rewriteSrcset(el, "srcset")) changed = true;
    if (changed) doneImages.add(el);
  }
  function rewriteLazy(el) {
    if (!el || doneLazy.has(el) || !opts.enabled || !opts.proxyBase) return;
    let changed = false;
    for (const attr of LAZY_ATTRS) { const value = el.getAttribute(attr); if (value && !shouldSkip(value)) { el.setAttribute(attr, buildProxyUrl(value)); changed = true; } }
    if (rewriteSrcset(el, "data-srcset")) changed = true;
    if (changed) doneLazy.add(el);
  }
  function rewriteBackground(el) {
    if (!el || doneBackground.has(el) || !opts.enabled || !opts.proxyBase) return;
    const bg = el.style?.backgroundImage; if (!bg || !/url\(/i.test(bg)) return;
    const rewritten = bg.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (full, quote, url) => shouldSkip(url) ? full : `url("${buildProxyUrl(url)}")`);
    if (rewritten !== bg) { el.style.backgroundImage = rewritten; doneBackground.add(el); }
  }
  function rewritePreload(el) {
    if (!(el instanceof HTMLLinkElement) || doneLinks.has(el) || !opts.enabled || !opts.proxyBase) return;
    const rel = el.getAttribute("rel") || "", as = (el.getAttribute("as") || "").toLowerCase();
    if (!/(?:^|\s)preload(?:\s|$)/i.test(rel) || as !== "image") return;
    const href = el.getAttribute("href"); if (!href || shouldSkip(href)) return;
    nativeLinkHref(el, buildProxyUrl(href)); doneLinks.add(el);
  }
  function processElement(el) {
    if (el?.nodeType !== 1) return;
    rewriteImage(el); rewriteLazy(el); rewriteBackground(el); rewritePreload(el);
    el.querySelectorAll?.(IMAGE_SELECTOR).forEach((node) => { rewriteImage(node); rewriteLazy(node); rewriteBackground(node); rewritePreload(node); });
  }
  function rewriteAll() { if (!document.documentElement || !opts.enabled || !opts.proxyBase) return; document.querySelectorAll(IMAGE_SELECTOR).forEach((el) => { rewriteImage(el); rewriteLazy(el); rewriteBackground(el); rewritePreload(el); }); }
  function queueRewrite() { if (rewriteQueued) return; rewriteQueued = true; queueMicrotask(() => { rewriteQueued = false; rewriteAll(); }); }
  function injectPreconnect(base) {
    try { const origin = parseURL(base)?.origin; if (!origin || !document.head) return; if (!document.head.querySelector(`link[rel="preconnect"][href="${CSS.escape(origin)}"]`)) { const l=document.createElement("link"); l.rel="preconnect"; l.href=origin; l.crossOrigin="anonymous"; document.head.prepend(l); } } catch {}
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") { for (const n of m.addedNodes) processElement(n); continue; }
      const t = m.target, a = m.attributeName; if (!t?.tagName) continue;
      if (a === "src" || a === "srcset") { doneImages.delete(t); rewriteImage(t); }
      else if (a === "style") { doneBackground.delete(t); rewriteBackground(t); }
      else if (a === "href" || a === "rel" || a === "as") { doneLinks.delete(t); rewritePreload(t); }
      else if (LAZY_SET.has(a) || a === "data-srcset") { doneLazy.delete(t); rewriteLazy(t); }
    }
  });
  function startObserver() { if (observerStarted || !document.documentElement) return; observerStarted = true; observer.observe(document.documentElement, { subtree:true, childList:true, attributes:true, attributeFilter:OBSERVED_ATTRS }); }
  function applySettings(next) { setOptions(next); if (opts.enabled && opts.proxyBase) { injectPreconnect(opts.proxyBase); queueRewrite(); } }

  chrome.storage.local.get({ bhOpts:null }, (data) => {
    if (data?.bhOpts) { applySettings(data.bhOpts); return; }
    chrome.storage.sync.get(DEFAULTS, (synced) => { applySettings(synced); chrome.storage.local.set({ bhOpts:synced }); });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) applySettings(changes.bhOpts.newValue);
    else if (area === "sync") chrome.storage.sync.get(DEFAULTS, (synced) => { applySettings(synced); chrome.storage.local.set({ bhOpts:synced }); });
  });
  if (document.documentElement) startObserver(); else document.addEventListener("DOMContentLoaded", startObserver, { once:true });
})();
