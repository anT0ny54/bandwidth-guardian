// Bandwidth Guardian — optimized content script
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

  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo",
  ];
  const LAZY_SET = new Set(LAZY_ATTRS);
  const OBSERVED_ATTRS = ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset"];
  const IMAGE_SELECTOR = [
    "img", "picture source", "[style]",
    ...LAZY_ATTRS.map((a) => `[${a}]`), "[data-srcset]",
  ].join(",");

  const TRACKING_PATTERNS = [
    /pagead/i,
    /(pixel|cleardot)\.*\.(gif|jpg|jpeg)/i,
    /google\.([a-z.]+)\/(ads|generate_204|.*\/log204)+/i,
    /google-analytics\.([a-z.]+)\/(r|collect)+/i,
    /youtube\.([a-z.]+)\/(api|ptracking|player_204|live_204)+/i,
    /doubleclick\.([a-z.]+)\/(pcs|pixel|r)+/i,
    /googlesyndication\.([a-z.]+)\/ddm/i,
    /pixel\.facebook\.([a-z.]+)/i,
    /facebook\.([a-z.]+)\/(impression\.php|tr)+/i,
    /ad\.bitmedia\.io/i,
    /yahoo\.([a-z.]+)\/pixel/i,
    /criteo\.net\/img/i,
    /ad\.doubleclick\.net/i,
  ];

  const done = new WeakSet();
  const urlCache = new Map();
  const CACHE_LIMIT = 512;
  let opts = { ...DEFAULTS };
  let excluded = new Set();
  let proxyHost = "";
  let rewriteQueued = false;
  let observerStarted = false;

  const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const sourceSrcset = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, "srcset");

  const isHttp = (value) => /^https?:\/\//i.test(String(value || ""));
  const parseURL = (value) => {
    try { return new URL(value); } catch { return null; }
  };

  function setOptions(next) {
    opts = { ...DEFAULTS, ...(next || {}) };
    excluded = parseDomains(opts.excludeDomains);
    proxyHost = parseURL(opts.proxyBase)?.hostname?.toLowerCase() || "";
    urlCache.clear();
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

  function hostExcluded(host) {
    host = host.toLowerCase();
    if (excluded.has(host)) return true;
    // Treat a configured parent domain as covering its subdomains.
    for (const domain of excluded) {
      if (host.endsWith("." + domain)) return true;
    }
    return false;
  }

  function shouldSkip(value) {
    if (!opts.enabled || !opts.proxyBase || !isHttp(value)) return true;
    const url = parseURL(value);
    if (!url) return true;

    const host = url.hostname.toLowerCase();
    if (proxyHost && host === proxyHost) return true;
    if (hostExcluded(host) || hostExcluded(location.hostname)) return true;

    const lower = String(value).toLowerCase();
    const path = url.pathname.toLowerCase();
    return path.endsWith(".ico") ||
      path.endsWith(".svg") ||
      lower.includes("favicon") ||
      TRACKING_PATTERNS.some((pattern) => pattern.test(value));
  }

  function buildProxyUrl(original) {
    const base = String(opts.proxyBase || "").trim();
    if (!base || !isHttp(original)) return original;

    const cached = urlCache.get(original);
    if (cached) return cached;

    const separator = base.includes("?") ? "&" : "?";
    const params = new URLSearchParams({
      url: original,
      jpeg: opts.isWebpSupported ? "0" : "1",
      bw: opts.grayscale ? "1" : "0",
      quality: String(opts.quality ?? 40),
    });
    if (opts.maxWidth) params.set("max_width", String(opts.maxWidth));

    const result = base + separator + params.toString();
    if (urlCache.size >= CACHE_LIMIT) {
      const first = urlCache.keys().next().value;
      if (first !== undefined) urlCache.delete(first);
    }
    urlCache.set(original, result);
    return result;
  }

  function nativeSrc(el, value) {
    imgSrc?.set?.call(el, value);
  }

  function rewriteSrcset(el, attrName) {
    const value = el.getAttribute(attrName);
    if (!value) return false;

    let changed = false;
    const output = value.split(",").map((part) => {
      const match = part.trim().match(/^(\S+)(\s.*)?$/);
      if (!match) return part;
      const [, url, descriptor = ""] = match;
      if (shouldSkip(url)) return part;
      changed = true;
      return buildProxyUrl(url) + descriptor;
    }).join(", ");

    if (changed) el.setAttribute(attrName, output);
    return changed;
  }

  function rewriteImage(el) {
    if (!el || done.has(el) || !opts.enabled || !opts.proxyBase) return;
    const tag = el.tagName;
    if (tag !== "IMG" && tag !== "SOURCE") return;

    let changed = false;
    const src = el.getAttribute("src");
    if (src && !shouldSkip(src)) {
      nativeSrc(el, buildProxyUrl(src));
      changed = true;
    }
    if (rewriteSrcset(el, "srcset")) changed = true;
    if (changed) done.add(el);
  }

  function rewriteLazy(el) {
    if (!el || done.has(el) || !opts.enabled || !opts.proxyBase) return;

    let changed = false;
    for (const attr of LAZY_ATTRS) {
      const value = el.getAttribute(attr);
      if (!value || shouldSkip(value)) continue;
      el.setAttribute(attr, buildProxyUrl(value));
      changed = true;
    }
    if (rewriteSrcset(el, "data-srcset")) changed = true;
    if (changed) done.add(el);
  }

  function rewriteBackground(el) {
    if (!el || done.has(el) || !opts.enabled || !opts.proxyBase) return;
    const bg = el.style?.backgroundImage;
    if (!bg || !/^\s*url\(/i.test(bg)) return;

    // Handle url("...") / url('...') and unquoted URLs without touching
    // gradients or multiple background layers.
    const rewritten = bg.replace(/url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi, (full, quote, url) => {
      if (shouldSkip(url)) return full;
      return `url("${buildProxyUrl(url)}")`;
    });
    if (rewritten !== bg) {
      el.style.backgroundImage = rewritten;
      done.add(el);
    }
  }

  function processElement(el) {
    if (el.nodeType !== 1) return;
    rewriteImage(el);
    rewriteLazy(el);
    rewriteBackground(el);
    el.querySelectorAll?.(IMAGE_SELECTOR).forEach((node) => {
      rewriteImage(node);
      rewriteLazy(node);
      rewriteBackground(node);
    });
  }

  function rewriteAll() {
    if (!document.documentElement || !opts.enabled || !opts.proxyBase) return;
    document.querySelectorAll(IMAGE_SELECTOR).forEach((el) => {
      rewriteImage(el);
      rewriteLazy(el);
      rewriteBackground(el);
    });
  }

  function queueRewrite() {
    if (rewriteQueued) return;
    rewriteQueued = true;
    queueMicrotask(() => {
      rewriteQueued = false;
      rewriteAll();
    });
  }

  function injectPreconnect(base) {
    try {
      const origin = parseURL(base)?.origin;
      if (!origin || !document.head) return;
      if (document.head.querySelector(`link[rel="preconnect"][href="${CSS.escape(origin)}"]`)) return;

      const preconnect = document.createElement("link");
      preconnect.rel = "preconnect";
      preconnect.href = origin;
      preconnect.crossOrigin = "anonymous";
      document.head.prepend(preconnect);

      const dns = document.createElement("link");
      dns.rel = "dns-prefetch";
      dns.href = origin;
      document.head.prepend(dns);
    } catch {}
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) processElement(node);
        continue;
      }

      const target = mutation.target;
      if (!target?.tagName) continue;
      const attr = mutation.attributeName;

      // Our own rewrite triggers mutations. Re-processing a completed node
      // is cheap and WeakSet prevents duplicate work.
      if (attr === "src" || attr === "srcset") {
        done.delete(target);
        rewriteImage(target);
      } else if (attr === "style") {
        done.delete(target);
        rewriteBackground(target);
      } else if (LAZY_SET.has(attr) || attr === "data-srcset") {
        done.delete(target);
        rewriteLazy(target);
      }
    }
  });

  function startObserver() {
    if (observerStarted || !document.documentElement) return;
    observerStarted = true;
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRS,
    });
  }

  function applySettings(next) {
    setOptions(next);
    if (opts.enabled && opts.proxyBase) {
      injectPreconnect(opts.proxyBase);
      queueRewrite();
    }
  }

  chrome.storage.local.get({ bhOpts: null }, (data) => {
    if (data.bhOpts) {
      applySettings(data.bhOpts);
    } else {
      chrome.storage.sync.get(DEFAULTS, (synced) => {
        applySettings(synced);
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      applySettings(changes.bhOpts.newValue);
    } else if (area === "sync") {
      chrome.storage.sync.get(DEFAULTS, (synced) => {
        applySettings(synced);
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  if (document.documentElement) startObserver();
  else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
})();
