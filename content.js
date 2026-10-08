// Bandwidth Guardian — content script
//
// ══ ARCHITECTURE ══════════════════════════════════════════════════════════════
//
//  Image interception is now split across two layers:
//
//  Layer 1 — prehook.js (document_start, synchronous, page MAIN world)
//    Patches HTMLImageElement.prototype.src/srcset/loading,
//    HTMLSourceElement.prototype.srcset, HTMLLinkElement.prototype.href and
//    Element.prototype.setAttribute BEFORE the HTML parser runs — inside the
//    page's MAIN world so page JavaScript actually hits these setters.
//    Catches all images set via JavaScript (including new Image().src).
//    Zero wasted bytes — proxy URL is set before any network request fires.
//
//  Layer 2 — THIS FILE (document_start, async after storage read)
//    Catches three categories that prehook cannot:
//
//    A) HTML-parsed <img src="..."> attributes — the browser's C++ HTML parser
//       sets src natively, bypassing our JS property-setter patch. By the time
//       this script's storage callback fires (~5–50ms), the browser may have
//       already started fetching the original image. Rewriting src here causes
//       the browser to cancel the in-flight original request and fetch from the
//       proxy instead. A tiny amount of the original image's bytes may already
//       be in flight — this is unavoidable in MV3 (webRequestBlocking was
//       removed). The alternative (DNR redirect) cannot URL-encode the captured
//       URL, producing malformed proxy requests for any URL with query params.
//
//    B) Lazy-load data attributes (data-src, data-lazy-src…) — rewritten so
//       that when a lazy-loader later does img.src = img.dataset.src, prehook
//       receives the proxy URL and the browser never fetches the original.
//
//    C) Inline CSS background-image — rewritten via el.style.backgroundImage.
//       Best-effort: stylesheet-defined backgrounds may already be loading.
//
//  The previous approach of using DNR regexSubstitution for image redirects
//  was removed because DNR cannot call encodeURIComponent. Any image URL
//  with query params (e.g. tvguide.com/img.jpg?auto=webp&width=1092) would
//  produce a malformed proxy URL with the original query params orphaned into
//  the proxy's own query string, silently breaking compression for those images.
//
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  // KEEP IN SYNC WITH defaults.js.
  // Bandwidth Guardian deliberately uses its configurable custom image-proxy
  // protocol (url/quality/bw/jpeg/max_width), not a third-party fixed proxy.
  const DEFAULTS = {
    enabled:         true,
    saveData:        true,
    proxyBase:       "",
    quality:         60,
    grayscale:       true,
    maxWidth:        768,
    excludeDomains:  ""
  };
  // ──────────────────────────────────────────────────────────────────────────

  // prehook.js runs in the page MAIN world and cannot use extension APIs.
  // Publish only the serializable settings it needs through a DOM event.
  // JSON avoids passing extension-world object wrappers across worlds.
  const SETTINGS_EVENT = "bh-settings-update";
  function publishPrehookSettings(next) {
    try {
      document.dispatchEvent(new CustomEvent(SETTINGS_EVENT, {
        detail: JSON.stringify({
          enabled: next?.enabled !== false,
          proxyBase: typeof next?.proxyBase === "string" ? next.proxyBase : "",
          quality: next?.quality,
          grayscale: !!next?.grayscale,
          maxWidth: next?.maxWidth,
          excludeDomains: typeof next?.excludeDomains === "string" ? next.excludeDomains : ""
        })
      }));
    } catch {}
  }

  // Lazy-load attributes used by common image libraries
  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo"
  ];

  // Tracking pixel URL patterns (ported from original shouldCompress.js)
  // Catches tracking pixels by URL pattern, regardless of domain.
  // KEEP IN SYNC with TRACKING_RE in prehook.js. Combined into one regex so each
  // candidate URL is tested once instead of running 13 separate patterns.
  const TRACKING_RE = new RegExp([
    "pagead",
    "(?:pixel|cleardot)\\.*\\.(?:gif|jpg|jpeg)",
    "google\\.(?:[a-z.]+)\\/(?:ads|generate_204|.*\\/log204)+",
    "google-analytics\\.(?:[a-z.]+)\\/(?:r|collect)+",
    "youtube\\.(?:[a-z.]+)\\/(?:api|ptracking|player_204|live_204)+",
    "doubleclick\\.(?:[a-z.]+)\\/(?:pcs|pixel|r)+",
    "googlesyndication\\.(?:[a-z.]+)\\/ddm",
    "pixel\\.facebook\\.(?:[a-z.]+)",
    "facebook\\.(?:[a-z.]+)\\/(?:impression\\.php|tr)+",
    "ad\\.bitmedia\\.io",
    "yahoo\\.(?:[a-z.]+)\\/pixel",
    "criteo\\.net\\/img",
    "ad\\.doubleclick\\.net"
  ].join("|"), "i");


  // Favicons, .ico and .svg are never proxied (cheap URL-only check; never load
  // the original image just to inspect it).
  const SKIP_URL_RE = /favicon|\.(?:ico|svg)(?:[?#]|$)/i;

  let opts = null;
  let proxyConfig = null;
  let destroyed = false;      // set on real navigation away from this document
  const proxyUrlCache = new Map();
  const PROXY_CACHE_LIMIT = 512;
  const doneImg = new WeakSet();
  const doneLazy = new WeakSet();
  const doneBg = new WeakSet();
  const fallbackHandlers = new WeakSet();
  const fallbackMeta = new WeakMap();
  // prehook.js runs in the page's MAIN world (see manifest) while this script
  // runs in the extension's isolated world — JS objects cannot cross. Failed
  // elements are flagged with a DOM attribute both worlds can read; this
  // duck-typed set mirrors WeakSet's has/add surface. The attribute is in
  // neither script's MutationObserver filter, so marking cannot loop back.
  const FAILED_ATTR = "data-bh-failed";
  const failedEls = {
    has: el => !!el && el.nodeType === 1 && el.hasAttribute(FAILED_ATTR),
    add(el) { try { el.setAttribute(FAILED_ATTR, ""); } catch {} }
  };

  // If the custom proxy cannot fetch/transform a particular image, restore the
  // original URL once. This preserves page rendering instead of leaving a
  // broken image icon. The restored URL bypasses our patched setter because we
  // use the native descriptor directly.
  function armProxyFallback(el, originalSrc, originalSrcset) {
    if (!el || el.tagName !== "IMG" || failedEls.has(el)) return;
    // Merge: src and srcset are armed by separate calls; one must not erase the other.
    const prev = fallbackMeta.get(el) || {};
    fallbackMeta.set(el, {
      originalSrc: originalSrc || prev.originalSrc || "",
      originalSrcset: originalSrcset || prev.originalSrcset || ""
    });
    if (fallbackHandlers.has(el)) return;
    fallbackHandlers.add(el);
    el.addEventListener("error", () => {
      const meta = fallbackMeta.get(el);
      if (!meta) return;
      fallbackMeta.delete(el);
      // Stop re-proxying this element, or the restored original is rewritten
      // again by the observer and a failing proxy is hit in an endless loop.
      failedEls.add(el);
      try {
        if (meta.originalSrcset && proxyHost && el.getAttribute("srcset")?.includes(proxyHost)) {
          nativeImgSrcsetSetter?.call(el, meta.originalSrcset);
        }
      } catch {}
      try {
        if (meta.originalSrc) nativeImgSrcSetter?.call(el, meta.originalSrc);
      } catch {}
    }, true);
  }
  let excludedDomains = new Set();
  let proxyHost = "";
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;   // cached excludedHost(pageHost), rebuilt on settings change
  const lazyAttrSet = new Set(LAZY_ATTRS);
  // Cache the last srcset transformation per element. Dynamic sites often
  // write the same srcset repeatedly while hydrating/re-rendering.
  let srcsetCache = new WeakMap();
  let dataSrcsetCache = new WeakMap();
  const LAZY_SELECTOR = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = (u, base = document.baseURI) => {
    try { return new URL(u, base); } catch { return null; }
  };
  const resolveHttp = u => {
    const resolved = safeURL(u);
    return resolved && /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  };
  const isHttp  = u => /^https?:\/\//i.test(u);

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

  function shouldSkip(url) {
    if (!opts?.enabled || !opts?.proxyBase) return true;

    const absolute = resolveHttp(url);
    if (!absolute) return true;

    // Fast exits before URL parsing. These checks run for every candidate image.
    // Keep them conservative so valid image URLs are never skipped accidentally.
    if (pageExcluded) return true;
    if (SKIP_URL_RE.test(absolute) || TRACKING_RE.test(absolute)) return true;

    const u = safeURL(absolute);
    if (!u) return true;

    // Already proxied (handles non-https/case variations safely).
    if (u.hostname.toLowerCase() === proxyHost) return true;

    // Excluded image host, including subdomains.
    const host = u.hostname.toLowerCase();
    if (excludedHost(host)) return true;

    return false;
  }

  // Builds the proxy URL with full param set, all values properly encoded.
  // Mirrors original buildCompressUrl() plus himshim proxy2 additions.
  function updateProxyConfig(next) {
    opts = next;
    const base = String(opts.proxyBase || "").trim();
    const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
    const maxWidth = Number(opts.maxWidth) || 0;
    proxyConfig = { base, sep: base.includes("?") ? "&" : "?", quality,
      maxWidth: maxWidth > 0 ? maxWidth : 0, grayscale: !!opts.grayscale };
    proxyHost = safeURL(base)?.hostname?.toLowerCase() || "";
  }

  function applyOpts(next) {
    publishPrehookSettings(next);
    updateProxyConfig(next);
    srcsetCache = new WeakMap();
    dataSrcsetCache = new WeakMap();
    proxyUrlCache.clear();
    excludedDomains = domainSet(opts.excludeDomains);
    pageExcluded = excludedHost(pageHost);
  }

  const sameOpts = (a, b) => !!a && !!b && Object.keys(DEFAULTS).every(k => a[k] === b[k]);

  function buildProxyUrl(orig) {
    if (!proxyConfig || !isHttp(orig)) return orig;

    const cached = proxyUrlCache.get(orig);
    if (cached) return cached;

    const { base, sep, quality, maxWidth, grayscale } = proxyConfig;
    const bw = grayscale ? "1" : "0";
    const parts = [
      "url=" + encodeURIComponent(orig),
      "jpeg=0", // every supported browser handles WebP
      "bw=" + bw,
      "quality=" + quality
    ];
    if (maxWidth) parts.push("max_width=" + encodeURIComponent(String(maxWidth)));
    const result = base + sep + parts.join("&");
    if (proxyUrlCache.size >= PROXY_CACHE_LIMIT) proxyUrlCache.delete(proxyUrlCache.keys().next().value);
    proxyUrlCache.set(orig, result);
    return result;
  }

  // Spec-style srcset parser (KEEP IN SYNC with prehook.js): commas inside a URL
  // (e.g. Cloudinary "w_400,h_300") belong to the URL, not the candidate list.
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
      if (url.endsWith(",")) {
        url = url.replace(/,+$/, "");
      } else {
        const d = i;
        while (i < n && ss[i] !== ",") i++;
        desc = ss.slice(d, i).trim();
      }
      if (url) out.push({ url, desc });
    }
    return out;
  }

  // Rewrites a srcset string; cached per element. A rewritten value maps to itself
  // so the mutation our own write triggers is a cache hit, not a re-parse.
  function rewriteSrcsetValue(ss, el, cache) {
    const cached = cache.get(el);
    if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    let touched = false;
    const parts = parseSrcset(ss).map(({ url, desc }) => {
      const absolute = resolveHttp(url);
      if (!absolute || shouldSkip(absolute)) return url + (desc ? " " + desc : "");
      touched = true;
      return buildProxyUrl(absolute) + (desc ? " " + desc : "");
    });
    const output = touched ? parts.join(", ") : ss;
    cache.set(el, { input: ss, output });
    return output;
  }

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements.
  // In this isolated world these descriptors ARE the untouched native setters
  // (prehook's patches live in the page's MAIN world, not here) — exactly what
  // the fallback restore needs to bypass re-proxying.
  const nativeImgSrcSetter =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;
  const nativeImgSrcsetSetter =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "srcset")?.set;

  function rewriteImg(el) {
    if (!el || doneImg.has(el) || failedEls.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled || pageExcluded) return; // excluded pages: don't even force lazy-loading

    // Force lazy loading on <img> elements that don't specify it. The HTML
    // parser sets the loading attribute natively, bypassing prehook's
    // HTMLImageElement.prototype.loading patch, so layer 2 handles it here.
    if (el.tagName === "IMG" && !el.hasAttribute("loading")) {
      el.setAttribute("loading", "lazy");
    }

    let rewrote = false;

    if (el.tagName === "IMG" || el.tagName === "SOURCE") {
      // src
      if (el.tagName === "IMG") {
        const src = el.getAttribute("src");
        const absoluteSrc = src ? resolveHttp(src) : null;
        if (absoluteSrc && !shouldSkip(absoluteSrc) && nativeImgSrcSetter) {
          const proxyUrl = buildProxyUrl(absoluteSrc);
          armProxyFallback(el, absoluteSrc, "");
          nativeImgSrcSetter.call(el, proxyUrl);
          rewrote = true;
        }
      }

      // srcset — cache the last value for this element.
      const ss = el.getAttribute("srcset");
      if (ss) {
        const output = rewriteSrcsetValue(ss, el, srcsetCache);
        if (output !== ss) {
          armProxyFallback(el, "", ss);
          el.setAttribute("srcset", output);
          rewrote = true;
        }
      }
    }

    if (rewrote) doneImg.add(el);
  }

  // ── B) Lazy-attr rewriting ─────────────────────────────────────────────────
  // STRICT IMAGE-ONLY: lazy attributes are rewritten only on actual image
  // elements. Generic data-src/data-url attributes are also used by iframes,
  // videos, scripts, links, downloads and other non-image content; an image
  // proxy must never receive those URLs.
  //
  // Background images are handled separately by rewriteBg(), so keeping this
  // strict does not lose CSS background-image support.
  const IMAGE_LAZY_TAGS = new Set(["IMG", "SOURCE"]);

  function rewriteLazy(el) {
    if (!el || doneLazy.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;
    if (!IMAGE_LAZY_TAGS.has(el.tagName)) return;

    let rewrote = false;

    // Inspect only attributes that actually exist instead of calling
    // getAttribute() for every possible lazy attribute on every element.
    for (const attr of el.attributes) {
      if (!lazyAttrSet.has(attr.name)) continue;
      const val = attr.value;
      const absolute = val ? resolveHttp(val) : null;
      if (!absolute || NON_IMAGE_EXT_RE.test(absolute) || shouldSkip(absolute)) continue;
      el.setAttribute(attr.name, buildProxyUrl(absolute));
      rewrote = true;
    }

    // data-srcset — same per-element cache as normal srcset.
    const dss = el.getAttribute("data-srcset");
    if (dss) {
      const output = rewriteSrcsetValue(dss, el, dataSrcsetCache);
      if (output !== dss) {
        el.setAttribute("data-srcset", output);
        rewrote = true;
      }
    }

    if (rewrote) doneLazy.add(el);
  }

  // ── C) Inline background-image rewriting ──────────────────────────────────
  // Handles elements with style="background-image: url(...)".
  // CSS stylesheet backgrounds can't be intercepted without getComputedStyle,
  // but overriding inline style is enough for most dynamic content.
  function rewriteBg(el) {
    if (!el || doneBg.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;
    const bg = el.style?.backgroundImage;
    if (!bg) return;

    // Rewrite every HTTP(S) url(...) token while preserving gradients, CSS
    // variables, quoted URLs, and non-HTTP resources.
    const urlRe = /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi;
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

  // ── D) <link rel="preload" as="image"> rewriting ──────────────────────────
  // Parser-created preload links bypass prehook's JS patches. Rewrite the href
  // to the proxy URL so the preloaded bytes are compressed instead of the
  // original full-resolution image.
  function rewritePreload(el) {
    if (!el || el.tagName !== "LINK") return;
    if (!opts?.proxyBase || !opts?.enabled) return;
    if (!/(?:^|\s)preload(?:\s|$)/i.test(el.rel || "")) return;
    if (String(el.getAttribute("as") || "").toLowerCase() !== "image" &&
        !/^image\//i.test(el.getAttribute("type") || "")) return;

    const href = el.getAttribute("href");
    const absolute = href ? resolveHttp(href) : null;
    if (!absolute || shouldSkip(absolute)) return;
    el.setAttribute("href", buildProxyUrl(absolute));
  }

  const CANDIDATE_SELECTOR = ["img", "source", LAZY_SELECTOR, "[style*='url(' i]", 'link[rel~="preload"]'].join(",");

  // ── Full-page scan ────────────────────────────────────────────────────────
  function processCandidate(el) {
    rewriteImg(el);
    rewriteLazy(el);
    rewriteBg(el);
    rewritePreload(el);
  }

  function rewriteAll() {
    if (destroyed) return;
    document.querySelectorAll(CANDIDATE_SELECTOR).forEach(processCandidate);
  }

  function scheduleInitialRewrite() {
    if (destroyed) return;
    // Yield once before a full-page scan so navigation/rendering is not blocked
    // behind querySelectorAll plus attribute writes on huge documents.
    setTimeout(() => {
      if (destroyed) return;
      rewriteAll();
    }, 0);
  }

  // ── MutationObserver ───────────────────────────────────────────────────────
  // Batch synchronous DOM churn into one macrotask. This prevents repeated
  // scans while still yielding to Chrome's navigation/rendering work.
  let pendingMutations = [];
  let mutationFlushQueued = false;

  function processMutations(mutations) {
    const addedRoots = [];
    const imageTargets = new Set();
    const lazyTargets = new Set();
    const bgTargets = new Set();

    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n.nodeType === 1) addedRoots.push(n);
        });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;
        if ((m.attributeName === "src" || m.attributeName === "srcset") &&
            (t.tagName === "IMG" || t.tagName === "SOURCE")) {
          if (failedEls.has(t)) continue;
          if (m.attributeName === "src") {
            // Ignore mutations produced by our own proxy writes. Reprocessing a
            // configured-proxy/excluded value only creates more observer work.
            const cur = t.getAttribute("src");
            const abs = cur ? resolveHttp(cur) : null;
            if (abs && !shouldSkip(abs)) {
              doneImg.delete(t);
              imageTargets.add(t);
            }
          } else {
            // srcset is a candidate list, not a URL; rewriteSrcsetValue's cache
            // makes our own writes a cheap no-op.
            doneImg.delete(t);
            imageTargets.add(t);
          }
        } else if (m.attributeName === "style") {
          doneBg.delete(t);
          bgTargets.add(t);
        } else if (lazyAttrSet.has(m.attributeName) || m.attributeName === "data-srcset") {
          doneLazy.delete(t);
          lazyTargets.add(t);
        }
      }
    }

    for (const root of addedRoots) {
      processCandidate(root);
      root.querySelectorAll?.(CANDIDATE_SELECTOR).forEach(processCandidate);
    }
    imageTargets.forEach(rewriteImg);
    lazyTargets.forEach(rewriteLazy);
    bgTargets.forEach(rewriteBg);
  }

  const MUTATION_RECORD_LIMIT = 2000;

  function queueMutationFlush(mutations) {
    if (destroyed) return;
    // Bound memory during pathological DOM churn. A bounded loss here is safer
    // than an unbounded array that can pin the main thread until navigation.
    for (const m of mutations) {
      pendingMutations.push(m);
      if (pendingMutations.length >= MUTATION_RECORD_LIMIT) break;
    }
    if (mutationFlushQueued) return;
    mutationFlushQueued = true;
    const flush = () => {
      mutationFlushQueued = false;
      if (destroyed) return;
      const batch = pendingMutations;
      pendingMutations = [];
      processMutations(batch);
    };
    // Use a macrotask, not a microtask. Microtask chains can starve Chrome's
    // navigation commit when a page keeps mutating during click-to-navigation.
    setTimeout(flush, 0);
  }

  function stop() {
    if (destroyed) return;
    destroyed = true;
    try { mo && mo.disconnect(); } catch {}
    pendingMutations = [];
  }

  let mo = null;
  mo = new MutationObserver(queueMutationFlush);

  mo.observe(document, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    // href/rel/as intentionally omitted: document-wide watching enqueued a
    // record for every <a href> change on dynamic pages, almost all discarded
    // here. MAIN-world prehook intercepts page-driven preload-link changes
    // before they reach the network, and added <link> nodes still arrive via
    // childList (processCandidate → rewritePreload).
    attributeFilter: ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset"]
  });

  // Usage statistics are authoritative in service-worker.js. The worker reads
  // bhp2's x-original-size/x-bytes-saved response headers, so page-side timing
  // events are intentionally not used for accounting.

  // ── Load settings then process page ───────────────────────────────────────
  // Try storage.local first (bhOpts mirror, ~5 ms). If bhOpts isn't there yet
  // (fresh install, service worker hasn't run, browser restart) fall back to
  // storage.sync and write the mirror so subsequent pages are fast.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (destroyed) return;
    if (d.bhOpts) {
      applyOpts(d.bhOpts);
      if (opts.enabled && opts.proxyBase) scheduleInitialRewrite();
    } else {
      chrome.storage.sync.get(DEFAULTS, synced => {
        if (destroyed) return;
        applyOpts(synced);
        // Write mirror so next page load takes the fast path
        chrome.storage.local.set({ bhOpts: synced });
        if (opts.enabled && opts.proxyBase) scheduleInitialRewrite();
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror updated by service worker, instant).
  // Fallback: sync area — catches changes when the service worker is inactive,
  // restarting, or not supported (Kiwi/Cromite). Both paths update opts.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (destroyed) return;
    if (area === "local" && changes.bhOpts) {
      const next = changes.bhOpts.newValue || DEFAULTS;
      if (!sameOpts(next, opts)) applyOpts(next); // skip echo of our own mirror write
    } else if (area === "sync") {
      const apply = next => {
        if (destroyed || sameOpts(next, opts)) return;
        applyOpts(next);
        // The service worker normally refreshes the mirror; harmless if it already did.
        chrome.storage.local.set({ bhOpts: next });
      };
      if (!opts) { chrome.storage.sync.get(DEFAULTS, apply); return; } // initial load still pending
      const next = { ...opts };
      for (const [k, c] of Object.entries(changes)) if (k in DEFAULTS) next[k] = c.newValue ?? DEFAULTS[k];
      apply(next);
    }
  });

  // On a real navigation, disconnect immediately so the outgoing page cannot
  // keep scheduling image-rewrite work while Chrome is trying to commit the
  // next URL. Persisted bfcache pages are left connected.
  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });
})();
