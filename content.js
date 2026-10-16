// Bandwidth Guardian — content script (isolated world)
// Owns extension storage and publishes settings to prehook.js (MAIN world) over
// a private MessageChannel. Handles parser-created elements, lazy-loading
// attributes, responsive sources, preloads, inline background images, dynamic
// DOM, the stall guard and navigation cleanup.
//
// Shared code (shared.js) is loaded before both layers in their own worlds.
// Settings reach layer 1 over a private MessageChannel (see the bridge
// section); nothing is exposed to page scripts.
(() => {
  const BH = globalThis.__bhShared;
  try { delete globalThis.__bhShared; } catch {}
  if (!BH) return;
  const { DEFAULTS } = BH;

  // ── State ──────────────────────────────────────────────────────────────────
  // From the local mirror first (fast startup), falling back to sync.
  let opts = null; // raw settings object from storage
  let config = BH.normalizeProxyConfig(null);
  const isExcludedHost = host => {
    if (!opts) return false;
    return BH.makeHostMatcher(BH.parseDomainList(opts.excludeDomains))(host);
  };
  let destroyed = false;
  const urls = BH.createProxyUrlBuilder();
  let doneImg = new WeakSet();    // IMG/SOURCE fully processed at least once
  let doneLazy = new WeakSet();
  let doneBg = new WeakSet();
  const pageHost = location.hostname.toLowerCase();
  const pageExcluded = isExcludedHost(pageHost);
  // data-src/data-original/… plus source[data-srcset].
  const lazyAttrSet = new Set(["data-src", "data-original", "data-lazy-src", "data-url"]);
  let srcsetCache = new WeakMap();
  let dataSrcsetCache = new WeakMap();
  const LAZY_SELECTOR = "img[data-src],img[data-original],img[data-lazy-src],img[data-url],source[data-srcset]";
  const MUTATION_RECORD_LIMIT = 2000;
  // General content observer: img/src/srcset/loading, source/srcset,
  // background images. NOT href/rel/as: preloads are handled by the early
  // MAIN-world prehook instead of here, including mutation-driven ones.
  const CONTENT_ATTR_FILTER = ["src", "srcset", "loading", "style", "data-src", "data-original", "data-lazy-src", "data-url", "data-srcset"];
  const NATIVE_GET_SRC = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.get;
  const nativeImgSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")?.set;
  const nativeImgSrcsetSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "srcset")?.set;
  const nativeSourceSrcsetSetter = (typeof HTMLSourceElement === "function"
    ? Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, "srcset")?.set
    : null);
  const setAttr = Element.prototype.setAttribute;
  const fallback = BH.createFallback({
    getConfig: () => config,
    setSrc: nativeImgSrcSetter || function (v) { setAttr.call(this, "src", v); },
    setSrcset: nativeImgSrcsetSetter || function (v) { setAttr.call(this, "srcset", v); },
    setSourceSrcset: nativeSourceSrcsetSetter || function (v) { setAttr.call(this, "srcset", v); },
    setAttr,
  });

  // ── Private settings channel to prehook.js (page MAIN world) ─────────────
  // The injection order of MAIN-world and isolated-world document_start scripts
  // is NOT guaranteed (Chromium builds order them differently). A one-shot
  // handshake posted at document_start can therefore fire before prehook's
  // listener exists and be lost — which in 0.1.8 left prehook settings-less
  // until the 5-second watchdog, so every JavaScript-assigned image loaded
  // unproxied. The handshake is TWO-WAY instead:
  //
  //   • content.js posts a handshake (value 1) with a fresh transferred port,
  //     immediately and again for every settings request it receives;
  //   • prehook.js listens for handshakes AND posts a settings request
  //     (value BRIDGE_REQ) of its own at startup;
  //   • prehook accepts exactly one handshake, and the accepted port is
  //     acknowledged over the port itself (value BRIDGE_ACK), which page
  //     scripts cannot read or spoof.
  //
  // Whichever script runs second finds the first already listening, so at
  // least one direction always lands and the bridge is established before any
  // page script runs. A transferred MessagePort is one-shot, so every retry
  // uses a fresh channel; channels are kept until one is acknowledged.
  let bridgePort = null;        // port1 of the acknowledged channel (settings out)
  let bridgeReady = false;
  const bridgeChannels = [];

  function postHandshake() {
    if (bridgeReady || destroyed) return;
    const channel = new MessageChannel();
    bridgeChannels.push(channel);
    channel.port1.onmessage = onBridgeAck;
    try { window.postMessage({ [BH.BRIDGE_KEY]: 1 }, "*", [channel.port2]); } catch {}
  }

  function onBridgeRequest(e) {
    try {
      if (bridgeReady || destroyed) return;
      if (e.source !== window || !e.data || e.data[BH.BRIDGE_KEY] !== BH.BRIDGE_REQ) return;
      postHandshake(); // fresh channel each time: a transferred port is one-shot
    } catch {}
  }

  function onBridgeAck(m) {
    try {
      if (bridgeReady || destroyed || !m.data || m.data[BH.BRIDGE_KEY] !== BH.BRIDGE_ACK) return;
      bridgeReady = true;
      bridgePort = m.target; // port1 of the acknowledged channel
      window.removeEventListener("message", onBridgeRequest, true);
      if (opts) publishPrehookSettings(opts); // settings that arrived pre-ack
    } catch {}
  }

  postHandshake();
  window.addEventListener("message", onBridgeRequest, true);

  function publishPrehookSettings(next) {
    try {
      // Before the ack, settings are re-published from onBridgeAck.
      if (!bridgePort) return;
      bridgePort.postMessage({
        enabled: next.enabled !== false,
        proxyBase: typeof next.proxyBase === "string" ? next.proxyBase : "",
        quality: next.quality,
        grayscale: next.grayscale,
        maxWidth: next.maxWidth,
        excludeDomains: typeof next.excludeDomains === "string" ? next.excludeDomains : "",
      });
    } catch {}
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const safeURL = u => {
    try { return new URL(u, document.baseURI); } catch { return null; }
  };
  const resolveHttp = u => {
    const resolved = safeURL(u);
    return resolved && /^https?:$/.test(resolved.protocol) ? resolved.href : null;
  };
  // True only while images on this page should go through the proxy.
  const proxying = () => !!opts && config.active && !pageExcluded;

  function shouldSkip(url) {
    if (!proxying()) return true;
    const absolute = resolveHttp(url);
    if (!absolute) return true;
    if (BH.SKIP_URL_RE.test(absolute) || BH.TRACKING_RE.test(absolute)) return true;
    const u = safeURL(absolute);
    if (!u) return true;
    const host = u.hostname.toLowerCase();
    if (host === config.host) return true;
    return isExcludedHost(host);
  }

  function applyOpts(next) {
    publishPrehookSettings(next);
    const wasProxying = proxying();
    opts = next;
    config = BH.normalizeProxyConfig(next);
    // Fresh config: drop cached proxy/original URL pairs.
    urls.clear();
    srcsetCache = new WeakMap();
    dataSrcsetCache = new WeakMap();
    if (!wasProxying && proxying()) scheduleInitialRewrite();
  }

  const buildProxyUrl = orig => urls.build(config, orig);

  // srcset -> proxied srcset (unchanged when nothing is eligible).
  function rewriteSrcsetValue(ss, el, cache) {
    if (!proxying() || !ss) return String(ss || "");
    return BH.mapSrcset(ss, url => {
      const absolute = resolveHttp(url);
      if (!absolute || shouldSkip(absolute)) return null;
      return buildProxyUrl(absolute);
    });
  }

  // ── Stall guard ────────────────────────────────────────────────────────────
  // A slow proxy (cold start, slow upstream) would otherwise leave a proxied
  // image blank for the proxy's whole time budget. Once a proxied image is
  // within ~1250 px of the viewport (where the browser actually loads it) and
  // has not finished within STALL_TIMEOUT_MS, fall back to the original.
  const STALL_OBSERVER_MARGIN = "1250px";
  const STALL_TIMEOUT_MS = 15000;
  let stallObserver = null;
  const stalled = new WeakSet(); // fired once; never re-proxied

  function watchStall(img) {
    if (!img || stalled.has(img)) return;
    if (typeof IntersectionObserver !== "function") return;
    stallObserver ||= new IntersectionObserver(entries => {
      for (const entry of entries) {
        const el = entry.target;
        stallObserver.unobserve(el);
        if (!entry.isIntersecting) continue;
        if (stalled.has(el)) continue;
        stalled.add(el);
        setTimeout(() => {
          if (destroyed || stalled.has(el) && !el.__bhStallScheduled) return;
          try {
            const src = el.getAttribute("src") || "";
            const currentSrc = el.currentSrc || "";
            if (src.includes(config.host) && currentSrc && !currentSrc.includes(config.host)) {
              el.dispatchEvent(new Event(BH.TIMEOUT_EVENT));
            } else if (src.includes(config.host) && !currentSrc) {
              el.dispatchEvent(new Event(BH.TIMEOUT_EVENT));
            }
          } catch {}
        }, STALL_TIMEOUT_MS);
      }
    }, { rootMargin: STALL_OBSERVER_MARGIN });
    stallObserver.observe(img);
  }

  function involvesProxy(el) {
    const src = el.getAttribute && el.getAttribute("src");
    const srcset = el.getAttribute && el.getAttribute("srcset");
    return (src && src.includes(config.host)) || (srcset && srcset.includes(config.host)) ||
           (el.tagName === "PICTURE" &&
            !!el.querySelector(`:scope > source[${BH.ORIG_SRCSET_ATTR}]`));
  }

  // Arm the fallback for an image whose final value is a proxy URL.
  function guardImg(img) {
    if (!img || img.tagName !== "IMG") return;
    const src = img.getAttribute("src") || "";
    const srcset = img.getAttribute("srcset") || "";
    const current = img.currentSrc || "";
    if ((src && src.includes(config.host)) ||
        (srcset && srcset.includes(config.host)) ||
        (current && current.includes(config.host))) {
      fallback.arm(img);
      watchStall(img);
    }
  }

  // ── Element rewriting ──────────────────────────────────────────────────────
  function rewriteImg(el) {
    if (!el || doneImg.has(el) || fallback.isFailed(el)) return;
    if (!proxying()) return;
    const isImg = el.tagName === "IMG";
    if (!isImg && el.tagName !== "SOURCE") return;
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
        if (!isImg) el.setAttribute(BH.ORIG_SRCSET_ATTR, BH.unproxySrcset(ss, config));
        el.setAttribute("srcset", output);
        rewrote = true;
      } else if (!isImg && config.host && ss.includes(config.host) && !el.hasAttribute(BH.ORIG_SRCSET_ATTR)) {
        // Already proxied (e.g. by a mutation re-check) but the original was
        // never recorded: record it now so the fallback can restore it.
        el.setAttribute(BH.ORIG_SRCSET_ATTR, BH.unproxySrcset(ss, config));
      }
    }
    if (isImg) guardImg(el);
    else if (el.parentElement && el.parentElement.tagName === "PICTURE") {
      for (const c of el.parentElement.children) if (c.tagName === "IMG") { guardImg(c); break; }
    }
    if (rewrote) doneImg.add(el);
  }

  function rewriteLazy(el) {
    if (!el || doneLazy.has(el) || fallback.isFailed(el)) return;
    if (!proxying()) return;
    const isImg = el.tagName === "IMG";
    const isSource = el.tagName === "SOURCE";
    if (!isImg && !isSource) return;
    const attr = isImg
      ? ["data-src", "data-original", "data-lazy-src", "data-url"].find(a => el.hasAttribute(a))
      : "data-srcset";
    if (!attr) return;
    const raw = el.getAttribute(attr);
    if (!raw || raw.startsWith("data:")) { doneLazy.add(el); return; }
    if (isSource) {
      if (BH.NON_IMAGE_EXT_RE.test(raw)) { doneLazy.add(el); return; }
      const out = rewriteSrcsetValue(raw, el, dataSrcsetCache);
      if (out !== raw) {
        el.setAttribute(BH.ORIG_SRCSET_ATTR, BH.unproxySrcset(raw, config));
        el.setAttribute("data-srcset", out);
        if (el.parentElement && el.parentElement.tagName === "PICTURE") {
          for (const c of el.parentElement.children) if (c.tagName === "IMG") fallback.arm(c);
        }
        doneLazy.add(el);
      }
      return;
    }
    if (BH.NON_IMAGE_EXT_RE.test(raw)) { doneLazy.add(el); return; }
    const absolute = resolveHttp(raw);
    if (!absolute || shouldSkip(absolute)) return;
    if (nativeImgSrcSetter) nativeImgSrcSetter.call(el, buildProxyUrl(absolute));
    doneLazy.add(el);
  }

  // Inline background images: rewrite the first eligible URL per element.
  const BG_URL_RE = /url\((['"]?)(.*?)\1\)/gi;
  const STYLE_SELECTOR = "[style*='background' i],[style*='background-image' i],[style*='url(' i]";

  function rewriteBg(el) {
    if (!el || doneBg.has(el)) return;
    if (!proxying()) return;
    const style = el.getAttribute && el.getAttribute("style");
    if (!style || !style.includes("url(")) { doneBg.add(el); return; }
    let rewrote = false;
    const next = style.replace(BG_URL_RE, (match, quote, url) => {
      if (rewrote || !url || url.startsWith("data:") || url.startsWith("#")) return match;
      const absolute = resolveHttp(url.trim());
      if (!absolute || shouldSkip(absolute)) return match;
      rewrote = true;
      return "url(" + (quote || "") + buildProxyUrl(absolute) + (quote || "") + ")";
    });
    if (rewrote) {
      el.setAttribute("style", next);
      doneBg.add(el);
    }
  }

  function rewritePreload(el) {
    if (!el || el.tagName !== "LINK") return;
    if (!proxying()) return;
    const rel = el.getAttribute("rel") || "";
    if (!/(?:^|\s)preload(?:\s|$)/i.test(rel)) return;
    const as = (el.getAttribute("as") || "").toLowerCase();
    if (as !== "image") return;
    // If prehook didn't already park it, process it here as a fallback.
    const href = el.getAttribute("href");
    if (!href || href === "about:blank") return;
    const absolute = resolveHttp(href);
    if (!absolute || shouldSkip(absolute)) return;
    el.setAttribute("href", buildProxyUrl(absolute));
  }

  // ── Selectors and dispatch ─────────────────────────────────────────────
  const IMG_SELECTOR = "img[src],img[srcset],img[data-src],img[data-original],img[data-lazy-src],img[data-url],source[srcset],source[data-srcset]";
  const PRELOAD_SELECTOR = 'link[rel~="preload"]';

  function processCandidate(el) {
    if (!el || el.nodeType !== 1) return;
    if (el.matches && el.matches(IMG_SELECTOR)) rewriteImg(el);
    if (el.matches && el.matches(LAZY_SELECTOR)) rewriteLazy(el);
    if (el.matches && el.matches(STYLE_SELECTOR)) rewriteBg(el);
    if (el.matches && el.matches(PRELOAD_SELECTOR)) rewritePreload(el);
    if (el.querySelectorAll) {
      el.querySelectorAll(IMG_SELECTOR).forEach(rewriteImg);
      el.querySelectorAll(LAZY_SELECTOR).forEach(rewriteLazy);
      el.querySelectorAll(STYLE_SELECTOR).forEach(rewriteBg);
      el.querySelectorAll(PRELOAD_SELECTOR).forEach(rewritePreload);
    }
  }

  function rewriteAll() {
    // Done-sets are per pass; a mutation overflow reset them on purpose.
    doneImg = new WeakSet();
    doneLazy = new WeakSet();
    doneBg = new WeakSet();
    document.querySelectorAll(IMG_SELECTOR).forEach(rewriteImg);
    document.querySelectorAll(LAZY_SELECTOR).forEach(rewriteLazy);
    document.querySelectorAll(STYLE_SELECTOR).forEach(rewriteBg);
    document.querySelectorAll(PRELOAD_SELECTOR).forEach(rewritePreload);
  }

  function scheduleInitialRewrite() {
    // Enough for parser-created images to exist; first natural batch runs soon.
    setTimeout(() => { if (!destroyed) rewriteAll(); }, 0);
  }

  // ── Mutation batching ────────────────────────────────────────────────────────
  // One callback per microtask-turn of mutations; each entry is tried once.
  let pendingMutations = [];
  let flushScheduled = false;
  let mutationOverflow = false; // more than MUTATION_RECORD_LIMIT records: rescan all

  function queueMutationFlush(mutations) {
    if (!mutationOverflow) {
      if (pendingMutations.length + mutations.length > MUTATION_RECORD_LIMIT) {
        mutationOverflow = true;
        pendingMutations = [];
      } else {
        for (const m of mutations) pendingMutations.push(m);
      }
    }
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      if (destroyed) { pendingMutations = []; return; }
      if (mutationOverflow) {
        mutationOverflow = false;
        pendingMutations = [];
        rewriteAll(); // one rescan replaces dropped records
        return;
      }
      const batch = pendingMutations;
      pendingMutations = [];
      for (const m of batch) {
        if (m.type === "attributes") {
          const t = m.target;
          if (t.nodeType !== 1) continue;
          // Skip proxy-URL writes we already made (same-value sets still
          // queue mutations). Any other change (including the page's own
          // writes) re-queues the element, and a page overwrite of a proxy
          // value (e.g. lazy loader copying data-src) is re-processed.
          if (doneImg.has(t) && involvesProxy(t)) continue;
          doneImg.delete(t);
          doneLazy.delete(t);
          doneBg.delete(t);
          processCandidate(t);
        } else {
          m.addedNodes.forEach(n => {
            if (n.nodeType === 1) processCandidate(n);
          });
        }
      }
    });
  }

  function stop() {
    destroyed = true;
    try { mo && mo.disconnect(); } catch {}
    try { stallObserver && stallObserver.disconnect(); } catch {}
    try { window.removeEventListener("message", onBridgeRequest, true); } catch {}
    pendingMutations = [];
    urls.clear();
  }

  // ── Observers and startup ──────────────────────────────────────────────────
  const mo = new MutationObserver(queueMutationFlush);
  mo.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: CONTENT_ATTR_FILTER,
  });

  // Free the outgoing page on normal navigation; keep bfcache restores working.
  window.addEventListener("pagehide", e => {
    if (e.persisted) return;
    stop();
  });

  // The local mirror written by the service worker and by saveSettings() is
  // authoritative here. Sync fallback only if the worker has not run yet.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (destroyed) return;
    if (d.bhOpts) {
      applyOpts(d.bhOpts);
    } else {
      chrome.storage.sync.get(DEFAULTS, synced => {
        if (destroyed) return;
        applyOpts(synced);
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  // Settings changes made in the popup/options pages; sync is authoritative.
  // The service worker mirrors sync -> local, so the local handler mostly
  // just applies the worker's mirror write (and skips the echo of our own
  // mirror write, which carries the same values).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      const next = changes.bhOpts?.newValue || changes.proxyBase?.newValue && { ...opts, proxyBase: changes.proxyBase.newValue };
      if (next) applyOpts(next);
    } else if (area === "local") {
      const next = changes.bhOpts?.newValue;
      if (next && !BH.sameOpts(next, opts)) applyOpts(next);
    }
  });
})();
