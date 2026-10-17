// Bandwidth Guardian — content script (document_start, isolated world)
//
// ══ ARCHITECTURE ══════════════════════════════════════════════════════════════
//
// Layer 0 — service-worker.js declarativeNetRequest redirect
//   Proxies EVERY image request (any element, any stylesheet, any shadow
//   root) inside the network stack before the original host is contacted.
//   The DOM layers below therefore only rewrite URLs that redirect exempts
//   (CONFLICT_RE) — or everything, if the redirect rule is not installed —
//   so one image is never proxied by two layers.
//
// Layer 1 — prehook.js (document_start, page MAIN world)
//   Patches image URL setters before the HTML parser runs, so JS-assigned
//   DOM-layer URLs are proxied before a request fires; owns the fallback retry.
//   Lazy data-* values are not rewritten in advance: they can contain templates
//   (for example, lazysizes {width}) and are only meaningful when the page's
//   loader promotes them to a real src/srcset URL.
//
// Layer 2 — THIS FILE (document_start, isolated world, async after storage)
//   Catches what prehook cannot:
//   A) HTML-parser-created <img>/<source> nodes — the C++ parser bypasses JS
//      setters; rewriting cancels the in-flight original request.
//   B) Inline CSS background-image via el.style.backgroundImage.
//   Parser-created <link rel=preload as=image> hrefs are handled by prehook's
//   MutationObserver (registered first), so no preload handling is needed here.
//
// The old DNR regexSubstitution redirect was removed because DNR cannot
// encodeURIComponent the captured URL; content scripts can.
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";
  // KEEP IN SYNC WITH defaults.js.
  const DEFAULTS = {
    enabled:         true,
    saveData:        true,
    proxyBase:       "",
    quality:         60,
    grayscale:       true,
    maxWidth:        768,
    excludeDomains:  ""
  };
  // KEEP IN SYNC with prehook.js.
  const DEFAULT_SETTINGS_EVENT = "bh-settings-update";
  // Written by the service worker: is the network redirect live, and is the
  // circuit breaker open? Missing (fresh install) = assume the redirect is live.
  let runtime = { redirect: true, suspended: false };
  // Originals whose proxy request already failed in this tab (from the worker).
  let failedUrls = new Set();
  const stripHash = u => { try { const r = new URL(u); r.hash = ""; return r.href; } catch { return u; } };
  const settingsEventName = () => (document.documentElement && document.documentElement.dataset &&
    document.documentElement.dataset.bhSettingsEvent) || DEFAULT_SETTINGS_EVENT;
  function sendToPrehook(payload) {
    try { document.dispatchEvent(new CustomEvent(settingsEventName(), { detail: JSON.stringify(payload) })); } catch {}
  }

  // prehook.js runs in the page MAIN world and cannot use extension APIs.
  // O7: publish ONLY the fields prehook needs, on a per-load random event name
  // (falling back to the default name when prehook could not expose one).
  function publishPrehookSettings(next) {
    sendToPrehook({
      enabled: next?.enabled !== false,
      proxyBase: typeof next?.proxyBase === "string" ? next.proxyBase : "",
      quality: next?.quality,
      grayscale: !!next?.grayscale,
      maxWidth: next?.maxWidth,
      excludeDomains: typeof next?.excludeDomains === "string" ? next.excludeDomains : "",
      redirect: runtime.redirect !== false,
      suspended: !!runtime.suspended,
      failed: Array.from(failedUrls)
    });
  }

  // Anchored tracking-pixel patterns (B13). KEEP IN SYNC with prehook.js.
  const TRACKING_RE = /(?:\/|\.)pagead(?:[/?#]|$)|(?:pixel|cleardot)\.*\.(?:gif|jpe?g)(?:[?#]|$)|google\.[a-z.]+\/(?:ads|generate_204|.*\/log204)(?:[?#]|$)|google-analytics\.[a-z.]+\/(?:r|collect)(?:[?#]|$)|youtube\.[a-z.]+\/(?:api|ptracking|player_204|live_204)(?:[?#]|$)|doubleclick\.[a-z.]+\/(?:pcs|pixel|r)(?:[?#]|$)|googlesyndication\.[a-z.]+\/ddm(?:[?#]|$)|pixel\.facebook\.[a-z.]+|facebook\.[a-z.]+\/(?:tr|impression\.php)(?:[?#]|$)|ad\.bitmedia\.io(?:[/?#]|$)|yahoo\.[a-z.]+\/pixel(?:[?#]|$)|criteo\.net\/img(?:[?#]|$)|ad\.doubleclick\.net(?:[/?#]|$)/i;

  // Favicons, .ico and .svg are never proxied.
  const SKIP_URL_RE = /favicon|\.(?:ico|svg)(?:[?#]|$)/i;
  // URLs the raw-URL network redirect cannot carry. KEEP IN SYNC with prehook.js
  // and CONFLICT_PATTERN in service-worker.js.
  const CONFLICT_RE = /&(?:quality|l|bw|jpeg|max_width)=/;

  // Known lazy-loader attributes. These are signals only: their values are
  // never changed or proxied directly. The loader's eventual src/srcset write
  // is intercepted by prehook, after any template tokens have been resolved.
  const DEFERRED_SOURCE_ATTRS = [
    "data-src", "data-srcset", "data-lazy-src", "data-lazy-srcset",
    "data-original", "data-original-src", "data-original-set",
    "data-image-src", "data-image-srcset", "data-bg", "data-bgset"
  ];
  const DEFERRED_URL_ATTRS = {
    src: ["data-src", "data-lazy-src", "data-original", "data-original-src", "data-image-src"],
    srcset: ["data-srcset", "data-lazy-srcset", "data-original-set", "data-image-srcset"]
  };
  const TEMPLATE_SOURCE_RE = /(?:\$\{[^}]*\}|\{\{?[^}]*\}\}?|%7b[^%]*%7d|__[^_\s]+__)/i;

  let opts = null;
  let active = false; // enabled && proxyBase set && !pageExcluded (O1)
  let proxyConfig = null;
  let proxyOrigin = "";  // C2: origin-based identity, matching the worker
  let proxyHost = "";    // hostname only, for srcset substring checks
  let destroyed = false;
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const doneImg = new WeakSet();
  const doneBg = new WeakSet();
  const fallbackHandlers = new WeakSet();
  const fallbackMeta = new WeakMap();
  // prehook lives in the MAIN world; failed elements are flagged with a DOM
  // attribute both worlds can read. This duck-typed set mirrors WeakSet.
  const FAILED_ATTR = "data-bh-failed";
  const RESTORED_ATTR = "data-bh-restored"; // KEEP IN SYNC with prehook.js (B5)
  const failedEls = {
    has: el => !!el && el.nodeType === 1 && el.hasAttribute(FAILED_ATTR),
    add(el) { try { el.setAttribute(FAILED_ATTR, ""); } catch {} }
  };

  let excludedDomains = new Set();
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;
  let srcsetCache = new WeakMap();

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = (u, base = document.baseURI) => { try { return new URL(u, base); } catch { return null; } };
  const resolveHttp = u => {
    const r = safeURL(u);
    return r && /^https?:$/.test(r.protocol) ? r.href : null;
  };

  function domainSet(text) {
    return new Set(
      String(text || "").split(/[,\s]+/)
        .map(s => s.trim().toLowerCase()).filter(Boolean)
        .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""))
    );
  }

  function excludedHost(host) {
    let h = String(host || "").toLowerCase().replace(/\.$/, "");
    while (h) {
      if (excludedDomains.has(h)) return true;
      const dot = h.indexOf(".");
      if (dot < 0) break;
      h = h.slice(dot + 1);
    }
    return false;
  }

  // Skip decision for a RESOLVED absolute http(s) URL (O4: parsed once here).
  function shouldSkip(absolute) {
    if (!active) return true;
    const u = safeURL(absolute);
    if (!u) return true;
    if (SKIP_URL_RE.test(absolute) || TRACKING_RE.test(absolute)) return true;
    if (u.origin === proxyOrigin) return true; // already proxied
    if (failedUrls.size && failedUrls.has(stripHash(absolute))) return true; // proxy failed before
    // The network redirect owns every non-conflict URL; rewriting it here too
    // would proxy the same image twice.
    if (runtime.redirect !== false && !CONFLICT_RE.test(absolute)) return true;
    if (excludedHost(u.hostname)) return true;
    return false;
  }

  function updateProxyConfig(next) {
    opts = next;
    const base = String(opts.proxyBase || "").trim();
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
    const maxWidth = Number(opts.maxWidth) || 0;
    proxyConfig = { base, sep: base.includes("?") ? "&" : "?", quality,
      maxWidth: maxWidth > 0 ? maxWidth : 0, grayscale: !!opts.grayscale };
    const parsed = safeURL(base);
    proxyOrigin = parsed ? parsed.origin : "";
    proxyHost = parsed ? parsed.hostname.toLowerCase() : "";
  }

  function applyOpts(next) {
    publishPrehookSettings(next);
    updateProxyConfig(next);
    srcsetCache = new WeakMap();
    proxyUrlCache.clear();
    excludedDomains = domainSet(opts.excludeDomains);
    pageExcluded = excludedHost(pageHost);
    active = !!opts.enabled && !!proxyConfig.base && !pageExcluded && !runtime.suspended;
    if (destroyed) return;
    if (active) {
      ensureObserver();
      scheduleInitialRewrite();
    } else if (mo) {
      mo.disconnect(); // O1: do no work at all while idle
    }
  }

  const sameOpts = (a, b) => !!a && !!b && Object.keys(DEFAULTS).every(k => a[k] === b[k]);

  // Callers pass resolveHttp() output, so no re-validation is needed (R7).
  function buildProxyUrl(orig) {
    if (!proxyConfig || !proxyConfig.base) return orig;
    const cached = proxyUrlCache.get(orig);
    if (cached !== undefined) {
      proxyUrlCache.delete(orig); // refresh insertion order (LRU-ish)
      proxyUrlCache.set(orig, cached);
      return cached;
    }
    const { base, sep, quality, maxWidth, grayscale } = proxyConfig;
    const parts = [
      "url=" + encodeURIComponent(orig),
      "jpeg=0", // every supported browser handles WebP
      "bw=" + (grayscale ? "1" : "0"),
      "quality=" + quality
    ];
    if (maxWidth) parts.push("max_width=" + encodeURIComponent(String(maxWidth)));
    const result = base + sep + parts.join("&");
    if (proxyUrlCache.size >= PROXY_CACHE_LIMIT) proxyUrlCache.delete(proxyUrlCache.keys().next().value);
    proxyUrlCache.set(orig, result);
    return result;
  }

  // Spec-style srcset parser (KEEP IN SYNC with prehook.js).
  function parseSrcset(ss) {
    const out = [];
    const n = ss.length;
    let i = 0;
    while (i < n) {
      while (i < n && /[\s,]/.test(ss[i])) i++;
      if (i >= n) break;
      const s = i;
      while (i < n && !/\s/.test(ss[i])) i++;
      let url = ss.slice(s, i);
      let desc = "";
      if (url.endsWith(",")) { url = url.replace(/,+$/, ""); }
      else { const d = i; while (i < n && ss[i] !== ",") i++; desc = ss.slice(d, i).trim(); }
      if (url) out.push({ url, desc });
    }
    return out;
  }

  function hasCustomLazySource(el) {
    return DEFERRED_SOURCE_ATTRS.some(name => {
      const value = el.getAttribute(name);
      return typeof value === "string" && value.trim() !== "";
    });
  }

  // Return true when an unresolved/custom lazy source should take precedence
  // over the active src/srcset. This lets us leave a placeholder alone but
  // still lets prehook proxy the real URL as soon as the site promotes it.
  // Template values are signals only and are never rewritten.
  function hasDeferredLazySource(el, kind) {
    const current = el.getAttribute(kind) || "";
    const currentUrls = kind === "src"
      ? new Set([resolveHttp(current)].filter(Boolean))
      : new Set(parseSrcset(current).map(({ url }) => resolveHttp(url)).filter(Boolean));
    for (const name of DEFERRED_URL_ATTRS[kind] || []) {
      const value = String(el.getAttribute(name) || "").trim();
      if (!value) continue;
      // The presence of an unresolved template is enough to identify a
      // placeholder-backed image. Leave the active placeholder untouched;
      // the site loader will resolve the template before assigning src/srcset.
      if (TEMPLATE_SOURCE_RE.test(value)) return true;
      const candidateUrls = kind === "src"
        ? [resolveHttp(value)]
        : parseSrcset(value).map(({ url }) => resolveHttp(url));
      for (const candidate of candidateUrls) {
        if (candidate && !currentUrls.has(candidate)) return true;
      }
    }
    return false;
  }

  function rewriteSrcsetValue(ss, el) {
    const cached = srcsetCache.get(el);
    if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    let touched = false;
    const parts = parseSrcset(ss).map(({ url, desc }) => {
      const absolute = resolveHttp(url);
      if (!absolute || shouldSkip(absolute)) return url + (desc ? " " + desc : "");
      touched = true;
      return buildProxyUrl(absolute) + (desc ? " " + desc : "");
    });
    const output = touched ? parts.join(", ") : ss;
    srcsetCache.set(el, { input: ss, output });
    return output;
  }

  // In the isolated world these descriptors ARE the untouched native setters —
  // exactly what the fallback restore needs to bypass re-proxying.
  const nativeImgSrcSetter =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;
  const nativeImgSrcsetSetter =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "srcset")?.set;

  // Restore the original URL once when the PROXY load fails (B5).
  function armProxyFallback(el, originalSrc, originalSrcset) {
    if (!el || el.tagName !== "IMG" || failedEls.has(el)) return;
    const prev = fallbackMeta.get(el) || {};
    fallbackMeta.set(el, {
      originalSrc: originalSrc || prev.originalSrc || "",
      originalSrcset: originalSrcset || prev.originalSrcset || ""
    });
    if (fallbackHandlers.has(el)) return;
    fallbackHandlers.add(el);
    el.addEventListener("error", () => {
      const cur = el.currentSrc || el.src || "";
      let curURL = null;
      try { curURL = new URL(cur); } catch { return; }
      if (!proxyOrigin || curURL.origin !== proxyOrigin) return; // B5
      if (el.hasAttribute(RESTORED_ATTR)) return; // prehook already restored
      const meta = fallbackMeta.get(el);
      if (!meta) return;
      fallbackMeta.delete(el);
      try { el.setAttribute(RESTORED_ATTR, ""); } catch {}
      failedEls.add(el);
      try {
        if (meta.originalSrcset && proxyHost && (el.getAttribute("srcset") || "").includes(proxyHost)) {
          nativeImgSrcsetSetter?.call(el, meta.originalSrcset);
        }
      } catch {}
      try { if (meta.originalSrc) nativeImgSrcSetter?.call(el, meta.originalSrc); } catch {}
    }, true);
    el.addEventListener("load", () => fallbackMeta.delete(el), { capture: true, once: true });
  }

  // ── A) Parser-created <img src> / <source srcset> ──────────────────────────
  function rewriteImg(el) {
    if (!el || doneImg.has(el) || failedEls.has(el)) return;
    if (!active) return; // R6: single active gate (shouldSkip checks it too)

    // Respect site-owned lazy loaders. For these elements, do not inject native
    // loading=lazy or proxy the placeholder src/srcset while a separate concrete
    // data-* candidate is waiting to be promoted. The MAIN-world hook still
    // intercepts the resolved src/srcset assignment when the loader runs.
    const customLazy = hasCustomLazySource(el);
    if (el.tagName === "IMG" && !el.hasAttribute("loading") && !customLazy) {
      el.setAttribute("loading", "lazy");
    }

    let rewrote = false;

    if (el.tagName === "IMG" && !hasDeferredLazySource(el, "src")) {
      const src = el.getAttribute("src");
      const absoluteSrc = src ? resolveHttp(src) : null;
      if (absoluteSrc && !shouldSkip(absoluteSrc) && nativeImgSrcSetter) {
        armProxyFallback(el, absoluteSrc, "");
        nativeImgSrcSetter.call(el, buildProxyUrl(absoluteSrc));
        rewrote = true;
      }
    }

    if ((el.tagName === "IMG" || el.tagName === "SOURCE") && !hasDeferredLazySource(el, "srcset")) {
      const ss = el.getAttribute("srcset");
      if (ss) {
        const output = rewriteSrcsetValue(ss, el);
        if (output !== ss) {
          if (el.tagName === "IMG") armProxyFallback(el, "", ss);
          el.setAttribute("srcset", output);
          rewrote = true;
        }
      }
    }

    if (rewrote) doneImg.add(el);
  }

  // ── B) Inline background-image ──────────────────────────────────────────────
  function rewriteBg(el) {
    if (!el || doneBg.has(el) || failedEls.has(el)) return;
    if (!active) return;
    const bg = el.style.backgroundImage;
    if (!bg) return;

    const urlRe = /url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi;
    let touched = false;
    const output = bg.replace(urlRe, (full, quote, quoted, bare) => {
      const raw = String(quote ? quoted : bare || "").trim();
      const absolute = raw ? resolveHttp(raw) : null;
      if (!absolute || shouldSkip(absolute)) return full;
      touched = true;
      return `url("${buildProxyUrl(absolute)}")`;
    });
    if (!touched || output === bg) return;
    el.style.backgroundImage = output;
    doneBg.add(el);
  }

  function processCandidate(el) {
    rewriteImg(el);
    rewriteBg(el);
  }

  const CANDIDATE_SELECTOR = "img,source";
  // #17: the [style*='url(' i] scan is kept out of the per-flush hot path; the
  // full-page scan and added-subtree checks below scope it to real candidates.
  const STYLE_SELECTOR = "[style*='url(' i]";

  function rewriteAll() {
    if (destroyed || !active) return;
    document.querySelectorAll(CANDIDATE_SELECTOR).forEach(processCandidate);
    document.querySelectorAll(STYLE_SELECTOR).forEach(rewriteBg);
  }

  function scheduleInitialRewrite() {
    if (destroyed || !active) return;
    setTimeout(() => { if (!destroyed && active) rewriteAll(); }, 0);
  }

  // ── MutationObserver ───────────────────────────────────────────────────────
  let pendingMutations = [];
  let mutationFlushQueued = false;
  let mutationOverflow = false;

  const addedRoots = [];
  const imageTargets = new Set();
  const bgTargets = new Set();

  function processMutations(mutations) {
    if (destroyed || !active) return;
    // R8: reusable collections, cleared once at the start of each flush.
    addedRoots.length = 0;
    imageTargets.clear();
    bgTargets.clear();

    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => { if (n.nodeType === 1) addedRoots.push(n); });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;
        if ((m.attributeName === "src" || m.attributeName === "srcset") &&
            (t.tagName === "IMG" || t.tagName === "SOURCE")) {
          if (failedEls.has(t)) continue;
          if (m.attributeName === "src") {
            // Ignore mutations produced by our own proxy writes.
            const cur = t.getAttribute("src");
            const abs = cur ? resolveHttp(cur) : null;
            if (abs && !shouldSkip(abs)) { doneImg.delete(t); imageTargets.add(t); }
          } else {
            doneImg.delete(t);
            imageTargets.add(t);
          }
        } else if (m.attributeName === "style") {
          if (t.style && t.style.backgroundImage) { doneBg.delete(t); bgTargets.add(t); }
        }
      }
    }

    for (const root of addedRoots) {
      processCandidate(root);
      root.querySelectorAll(CANDIDATE_SELECTOR).forEach(processCandidate);
      // #17: style-attribute candidates from THIS batch only (R5: nodeType is
      // always 1 here — it was filtered on push — so no re-checks are needed).
      if (root.hasAttribute("style") && String(root.getAttribute("style")).includes("url(")) {
        rewriteBg(root);
      }
      root.querySelectorAll(STYLE_SELECTOR).forEach(rewriteBg);
    }
    imageTargets.forEach(rewriteImg);
    bgTargets.forEach(rewriteBg);
  }

  const MUTATION_RECORD_LIMIT = 2000;

  function queueMutationFlush(mutations) {
    if (destroyed || !active) return;
    // B15: check the limit BEFORE pushing — previously the array grew one past
    // the limit and silently dropped everything after it.
    for (const m of mutations) {
      if (pendingMutations.length >= MUTATION_RECORD_LIMIT) { mutationOverflow = true; break; }
      pendingMutations.push(m);
    }
    if (mutationFlushQueued) return;
    mutationFlushQueued = true;
    const flush = () => {
      mutationFlushQueued = false;
      if (destroyed) return;
      const batch = pendingMutations;
      pendingMutations = [];
      processMutations(batch);
      // O6/B15: on overflow, one full rescan recovers the dropped records
      // instead of leaving those images unproxied.
      if (mutationOverflow && !destroyed && active) {
        mutationOverflow = false;
        rewriteAll();
      }
    };
    setTimeout(flush, 0); // macrotask: never starve navigation commit
  }

  function stop() {
    if (destroyed) return;
    destroyed = true;
    try { mo && mo.disconnect(); } catch {}
    pendingMutations = [];
    proxyUrlCache.clear();
  }

  let mo = null;
  function ensureObserver() {
    if (!mo) mo = new MutationObserver(queueMutationFlush);
    try {
      mo.observe(document, {
        childList:       true,
        subtree:         true,
        attributes:      true,
        // href/rel/as omitted (see review C1): prehook intercepts page-driven
        // preload changes in the MAIN world; parser-created links arrive via
        // childList. Lazy attributes are intentionally not rewritten; actual
        // src/srcset promotion is caught by prehook (R1 compatibility fix).
        attributeFilter: ["src", "srcset", "style"]
      });
    } catch {}
  }

  // ── Settings load ──────────────────────────────────────────────────────────
  // Fast path: bhOpts mirror in storage.local (~5 ms). Cold path: storage.sync,
  // then write the mirror — the service worker is the mirror's sole writer in
  // steady state (B4); this is the only content-script write, on the cold path.
  // The known-failed list is fetched in parallel with settings (bounded wait),
  // so the first publish already carries it.
  const failedListReady = new Promise(resolve => {
    const timer = setTimeout(resolve, 400);
    try {
      chrome.runtime.sendMessage({ type: "bh-failed-list" }, res => {
        void chrome.runtime.lastError;
        if (res && Array.isArray(res.urls)) failedUrls = new Set(res.urls.filter(u => typeof u === "string"));
        clearTimeout(timer); resolve();
      });
    } catch { clearTimeout(timer); resolve(); }
  });
  chrome.storage.local.get({ bhOpts: null, bhRuntime: null }, d => failedListReady.then(() => {
    if (destroyed) return;
    if (d.bhRuntime && typeof d.bhRuntime === "object") runtime = d.bhRuntime;
    if (d.bhOpts) {
      applyOpts(d.bhOpts);
    } else {
      chrome.storage.sync.get(DEFAULTS, synced => {
        if (destroyed) return;
        applyOpts(synced);
        try { chrome.storage.local.set({ bhOpts: synced }); } catch {}
      });
    }
  }));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (destroyed) return;
    if (area === "local" && (changes.bhOpts || changes.bhRuntime)) {
      if (changes.bhRuntime) runtime = changes.bhRuntime.newValue || { redirect: true, suspended: false };
      const next = changes.bhOpts ? (changes.bhOpts.newValue || DEFAULTS) : opts;
      if (next && (changes.bhRuntime || !sameOpts(next, opts))) applyOpts(next);
    } else if (area === "sync") {
      // B4: apply in memory only — no mirror write (the worker owns it).
      if (!opts) {
        chrome.storage.sync.get(DEFAULTS, next => {
          if (!destroyed && !sameOpts(next, opts)) applyOpts(next);
        });
        return;
      }
      const next = { ...opts };
      for (const [k, c] of Object.entries(changes)) if (k in DEFAULTS) next[k] = c.newValue ?? DEFAULTS[k];
      if (!sameOpts(next, opts)) applyOpts(next);
    }
  });

  // Fallback relay: the service worker reports proxy failures (after it has
  // installed a per-tab bypass rule) and prehook — which can reach closed
  // shadow roots — re-requests the affected elements once.
  try {
    chrome.runtime.onMessage.addListener(msg => {
      if (destroyed || !msg || msg.type !== "bh-retry" || !Array.isArray(msg.items)) return;
      const items = msg.items
        .filter(it => it && typeof it.original === "string")
        .map(it => ({ original: it.original, proxyUrl: typeof it.proxyUrl === "string" ? it.proxyUrl : "" }));
      for (const it of items) failedUrls.add(stripHash(it.original));
      if (items.length) sendToPrehook({ kind: "retry", items });
    });
  } catch {}

  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });
})();
