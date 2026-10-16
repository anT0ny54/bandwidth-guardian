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
//  Shared code (shared.js) is loaded before both layers in their own worlds.
//  Settings reach layer 1 over a private MessageChannel (see publish()).
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
//    It also owns the stall guard: proxied images that enter the viewport but
//    do not finish within PROXY_STALL_MS fall back to the original.
//
//  The previous approach of using DNR regexSubstitution for image redirects
//  was removed because DNR cannot call encodeURIComponent. Any image URL
//  with query params (e.g. tvguide.com/img.jpg?auto=webp&width=1092) would
//  produce a malformed proxy URL with the original query params orphaned into
//  the proxy's own query string, silently breaking compression for those images.
//
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  const BH = globalThis.__bhShared;
  try { delete globalThis.__bhShared; } catch {}
  if (!BH) return;
  const { DEFAULTS } = BH;

  // ── Private settings channel to prehook.js (page MAIN world) ───────────────
  // Posted synchronously at document_start, before any page script runs, so
  // prehook's capture listener receives it first and keeps the port. Settings
  // then travel only over the port: pages cannot read the proxy URL or the
  // exclusion list, and cannot inject their own settings.
  const channel = new MessageChannel();
  try { window.postMessage({ [BH.BRIDGE_KEY]: 1 }, "*", [channel.port2]); } catch {}
  function publishPrehookSettings(next) {
    try {
      channel.port1.postMessage({
        enabled: next?.enabled !== false,
        proxyBase: typeof next?.proxyBase === "string" ? next.proxyBase : "",
        quality: next?.quality,
        grayscale: !!next?.grayscale,
        maxWidth: next?.maxWidth,
        excludeDomains: typeof next?.excludeDomains === "string" ? next.excludeDomains : "",
      });
    } catch {}
  }

  // Lazy-load attributes used by common image libraries
  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo"
  ];

  let opts = null;
  let config = BH.normalizeProxyConfig({ ...DEFAULTS, enabled: false });
  let isExcludedHost = () => false;
  let destroyed = false;      // set on real navigation away from this document
  const urls = BH.createProxyUrlBuilder();
  // `let`: reset after a mutation overflow so the full rescan sees everything.
  let doneImg = new WeakSet();
  let doneLazy = new WeakSet();
  let doneBg = new WeakSet();
  const pageHost = location.hostname.toLowerCase();
  let pageExcluded = false;
  const lazyAttrSet = new Set(LAZY_ATTRS);
  // Cache the last srcset transformation per element. Dynamic sites often
  // write the same srcset repeatedly while hydrating/re-rendering.
  let srcsetCache = new WeakMap();
  let dataSrcsetCache = new WeakMap();
  const LAZY_SELECTOR = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");

  // In this isolated world these descriptors ARE the untouched native setters
  // (prehook's patches live in the page's MAIN world) — exactly what the
  // fallback restore needs to bypass re-proxying.
  const nativeImgSrcSetter =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;
  const nativeImgSrcsetSetter =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "srcset")?.set;
  const nativeSourceSrcsetSetter = typeof HTMLSourceElement === "function"
    ? Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, "srcset")?.set
    : null;
  const setAttr = Element.prototype.setAttribute;

  // Shared fallback (same implementation as prehook.js, this world's setters).
  // Failed elements are flagged with data-bh-failed so both worlds agree.
  const fallback = BH.createFallback({
    getConfig: () => config,
    setSrc: nativeImgSrcSetter,
    setSrcset: nativeImgSrcsetSetter || function (v) { setAttr.call(this, "srcset", v); },
    setSourceSrcset: nativeSourceSrcsetSetter || function (v) { setAttr.call(this, "srcset", v); },
    setAttr,
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = (u, base = document.baseURI) => {
    try { return new URL(u, base); } catch { return null; }
  };
  const resolveHttp = u => {
    const resolved = safeURL(u);
    return resolved && /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  };
  const proxying = () => !!opts && config.active && !pageExcluded;

  function shouldSkip(url) {
    if (!proxying()) return true;
    const absolute = resolveHttp(url);
    if (!absolute) return true;
    // Fast exits before URL parsing; these run for every candidate image.
    if (BH.SKIP_URL_RE.test(absolute) || BH.TRACKING_RE.test(absolute)) return true;
    const u = safeURL(absolute);
    if (!u) return true;
    const host = u.hostname.toLowerCase();
    if (host === config.host) return true; // already proxied
    return isExcludedHost(host);           // excluded image host or parent
  }

  function applyOpts(next) {
    publishPrehookSettings(next);
    const wasProxying = proxying();
    opts = next;
    config = BH.normalizeProxyConfig(next);
    isExcludedHost = BH.makeHostMatcher(BH.parseDomainList(next.excludeDomains));
    pageExcluded = isExcludedHost(pageHost);
    srcsetCache = new WeakMap();
    dataSrcsetCache = new WeakMap();
    urls.clear();
    // Covers the first load and turning the extension on (or adding a proxy)
    // while this page is open.
    if (!wasProxying && proxying()) scheduleInitialRewrite();
  }

  const buildProxyUrl = orig => urls.build(config, orig);

  // Rewrites a srcset string; cached per element. A rewritten value maps to itself
  // so the mutation our own write triggers is a cache hit, not a re-parse.
  function rewriteSrcsetValue(ss, el, cache) {
    const cached = cache.get(el);
    if (cached && (cached.input === ss || cached.output === ss)) return cached.output;
    const output = BH.mapSrcset(ss, url => {
      const absolute = resolveHttp(url);
      return !absolute || shouldSkip(absolute) ? null : buildProxyUrl(absolute);
    });
    cache.set(el, { input: ss, output });
    return output;
  }

  // ── Stall guard ────────────────────────────────────────────────────────────
  // A proxy that hangs (cold start, slow upstream, up to bhp2's 20 s budget)
  // previously left the image blank for the whole wait. Proxied images are
  // watched; once one is near the viewport (where the browser actually loads
  // it, lazy or not) and has not finished within PROXY_STALL_MS, a
  // TIMEOUT_EVENT is dispatched and the fallback in either world restores
  // the original.
  const PROXY_STALL_MS = 15000;
  const watched = new WeakSet();
  let stallObserver = null;
  const involvesProxy = img => {
    const host = config.host;
    if (!host) return false;
    if ((img.getAttribute("src") || "").includes(host) ||
        (img.getAttribute("srcset") || "").includes(host) ||
        String(img.currentSrc || "").includes(host)) return true;
    const p = img.parentElement;
    return !!p && p.tagName === "PICTURE" &&
      !!p.querySelector(`:scope > source[${BH.ORIG_SRCSET_ATTR}]`);
  };
  function onStallEntries(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target;
      stallObserver.unobserve(img);
      setTimeout(() => {
        if (destroyed || !img.isConnected || img.complete || fallback.isFailed(img)) return;
        if (!involvesProxy(img)) return;
        try { img.dispatchEvent(new CustomEvent(BH.TIMEOUT_EVENT)); } catch {}
      }, PROXY_STALL_MS);
    }
  }
  function watchStall(img) {
    if (watched.has(img) || typeof IntersectionObserver !== "function") return;
    watched.add(img);
    // ~Chromium's lazy-load distance, so the timer starts when loading does.
    stallObserver ||= new IntersectionObserver(onStallEntries, { rootMargin: "1250px 0px" });
    stallObserver.observe(img);
  }
  function guardImg(img) {
    if (img.tagName !== "IMG" || fallback.isFailed(img) || !involvesProxy(img)) return;
    fallback.arm(img);
    watchStall(img);
  }

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements, and arms
  // the fallback for images that arrive already proxied (lazy loaders,
  // prehook-set values), so every proxied image can fall back.
  function rewriteImg(el) {
    if (!el || doneImg.has(el) || fallback.isFailed(el)) return;
    if (!proxying()) return; // excluded pages: don't even force lazy-loading
    const isImg = el.tagName === "IMG";
    if (!isImg && el.tagName !== "SOURCE") return;

    // Force lazy loading on <img> elements that don't specify it. The HTML
    // parser sets the loading attribute natively, bypassing prehook's
    // HTMLImageElement.prototype.loading patch, so layer 2 handles it here.
    if (isImg && !el.hasAttribute("loading")) el.setAttribute("loading", "lazy");

    let rewrote = false;
    if (isImg) {
      const src = el.getAttribute("src");
      const absoluteSrc = src ? resolveHttp(src) : null;
      if (absoluteSrc && !shouldSkip(absoluteSrc) && nativeImgSrcSetter) {
        nativeImgSrcSetter.call(el, buildProxyUrl(absoluteSrc));
        rewrote = true;
      }
    }

    const ss = el.getAttribute("srcset");
    if (ss) {
      const output = rewriteSrcsetValue(ss, el, srcsetCache);
      if (output !== ss) {
        // <source> originals travel in the DOM so either world can restore them.
        if (!isImg) el.setAttribute(BH.ORIG_SRCSET_ATTR, BH.unproxySrcset(ss, config));
        el.setAttribute("srcset", output);
        rewrote = true;
      } else if (!isImg && config.host && ss.includes(config.host) && !el.hasAttribute(BH.ORIG_SRCSET_ATTR)) {
        el.setAttribute(BH.ORIG_SRCSET_ATTR, BH.unproxySrcset(ss, config));
      }
    }

    if (isImg) {
      guardImg(el);
    } else if (el.hasAttribute(BH.ORIG_SRCSET_ATTR)) {
      const p = el.parentElement;
      if (p && p.tagName === "PICTURE") for (const c of p.children) if (c.tagName === "IMG") guardImg(c);
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
    if (!el || doneLazy.has(el) || fallback.isFailed(el)) return;
    if (!proxying()) return;
    if (!IMAGE_LAZY_TAGS.has(el.tagName)) return;

    let rewrote = false;

    // Inspect only attributes that actually exist instead of calling
    // getAttribute() for every possible lazy attribute on every element.
    for (const attr of el.attributes) {
      if (!lazyAttrSet.has(attr.name)) continue;
      const val = attr.value;
      const absolute = val ? resolveHttp(val) : null;
      if (!absolute || BH.NON_IMAGE_EXT_RE.test(absolute) || shouldSkip(absolute)) continue;
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
    if (!proxying()) return;
    const bg = el.style.backgroundImage;
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
    if (!proxying()) return;
    if (!/(?:^|\s)preload(?:\s|$)/i.test(el.rel || "")) return;
    if (String(el.getAttribute("as") || "").toLowerCase() !== "image" &&
        !/^image\//i.test(el.getAttribute("type") || "")) return;

    const href = el.getAttribute("href");
    const absolute = href ? resolveHttp(href) : null;
    if (!absolute || shouldSkip(absolute)) return;
    el.setAttribute("href", buildProxyUrl(absolute));
  }

  // #17: the [style*='url(' i] substring scan is expensive on huge documents.
  // The initial full-page scan runs it document-wide once; mutation flushes
  // run it only inside each subtree added in that batch.
  const CANDIDATE_SELECTOR = ["img", "source", LAZY_SELECTOR, 'link[rel~="preload"]'].join(",");
  const STYLE_SELECTOR = "[style*='url(' i]";

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
    // Initial scan only: this C++-level substring check is too broad for the
    // per-mutation-flush path.
    document.querySelectorAll(STYLE_SELECTOR).forEach(rewriteBg);
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

  // #18: module-level reusable collections, cleared between flushes, instead
  // of allocating four new containers per mutation batch on churn-heavy pages.
  const addedRoots = [];
  const imageTargets = new Set();
  const lazyTargets = new Set();
  const bgTargets = new Set();

  function processMutations(mutations) {
    addedRoots.length = 0;
    imageTargets.clear();
    lazyTargets.clear();
    bgTargets.clear();

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
          if (fallback.isFailed(t)) continue;
          if (m.attributeName === "src") {
            // Reprocess when the new src needs proxying, or is a proxy URL set
            // by the page/prehook (so its fallback and stall guard get armed).
            // Excluded or non-http values are ignored.
            const cur = t.getAttribute("src");
            const abs = cur ? resolveHttp(cur) : null;
            if (abs && (!shouldSkip(abs) || (config.host && abs.includes(config.host)))) {
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
          // #19: most style mutations (color, display, …) don't touch
          // background-image. Gate here so those elements never reach
          // rewriteBg's doomed early return.
          if (t.style && t.style.backgroundImage) {
            doneBg.delete(t);
            bgTargets.add(t);
          }
        } else if (lazyAttrSet.has(m.attributeName) || m.attributeName === "data-srcset") {
          doneLazy.delete(t);
          lazyTargets.add(t);
        }
      }
    }

    for (const root of addedRoots) {
      processCandidate(root);
      root.querySelectorAll?.(CANDIDATE_SELECTOR).forEach(processCandidate);
      // #17: style-attribute candidates from THIS batch only.
      if (root.nodeType === 1) {
        if (root.hasAttribute?.("style") && String(root.getAttribute("style")).includes("url(")) {
          rewriteBg(root);
        }
        root.querySelectorAll?.(STYLE_SELECTOR).forEach(rewriteBg);
      }
    }
    imageTargets.forEach(rewriteImg);
    lazyTargets.forEach(rewriteLazy);
    bgTargets.forEach(rewriteBg);

    addedRoots.length = 0;
    imageTargets.clear();
    lazyTargets.clear();
    bgTargets.clear();
  }

  const MUTATION_RECORD_LIMIT = 2000;

  let mutationOverflow = false;

  function queueMutationFlush(mutations) {
    if (destroyed) return;
    // Bound memory during pathological DOM churn. Past the limit, records are
    // dropped and ONE full rescan replaces them, so no image is missed.
    if (!mutationOverflow) {
      if (pendingMutations.length + mutations.length > MUTATION_RECORD_LIMIT) {
        mutationOverflow = true;
        pendingMutations = [];
      } else {
        for (const m of mutations) pendingMutations.push(m);
      }
    }
    if (mutationFlushQueued) return;
    mutationFlushQueued = true;
    const flush = () => {
      mutationFlushQueued = false;
      if (destroyed) return;
      if (mutationOverflow) {
        mutationOverflow = false;
        // Dropped records may include src changes on already-processed
        // elements, so forget what was done; rewrites are idempotent.
        doneImg = new WeakSet();
        doneLazy = new WeakSet();
        doneBg = new WeakSet();
        rewriteAll();
        return;
      }
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
    try { stallObserver && stallObserver.disconnect(); } catch {}
    urls.clear(); // parity with prehook.js stop()
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
  // bhp2's x-bh-* (and legacy) size headers, so page-side timing events are
  // intentionally not used for accounting.

  // ── Load settings then process page ───────────────────────────────────────
  // Try storage.local first (bhOpts mirror, ~5 ms). If bhOpts isn't there yet
  // (fresh install, service worker hasn't run, browser restart) fall back to
  // storage.sync and write the mirror so subsequent pages are fast.
  // applyOpts schedules the initial full-page rewrite when proxying is active.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (destroyed) return;
    if (d.bhOpts) {
      applyOpts(d.bhOpts);
    } else {
      chrome.storage.sync.get(DEFAULTS, synced => {
        if (destroyed) return;
        applyOpts(synced);
        // One-time mirror write (only when it is missing) so the next page
        // load takes the fast path even if the service worker never ran.
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror updated by service worker, instant).
  // Fallback: sync area — catches changes when the service worker is inactive
  // or restarting. Content scripts never write the mirror on changes: with N
  // tabs that was N extra writes per change, each fanning out to every tab.
  // The service worker and the popup/options pages own the mirror.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (destroyed) return;
    if (area === "local" && changes.bhOpts) {
      const next = changes.bhOpts.newValue || DEFAULTS;
      if (!BH.sameOpts(next, opts)) applyOpts(next); // skip echo of our own mirror write
    } else if (area === "sync") {
      const apply = next => {
        if (destroyed || BH.sameOpts(next, opts)) return;
        applyOpts(next);
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
