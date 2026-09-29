// Bandwidth Guardian — content script
//
// ══ ARCHITECTURE ══════════════════════════════════════════════════════════════
//
//  Image interception is split across two layers, sharing constants and
//  URL-decision logic from shared.js (loaded first — see manifest.json):
//
//  Layer 1 — prehook.js (document_start, synchronous)
//    Patches HTMLImageElement.prototype.src, srcset, setAttribute, and Image()
//    BEFORE the HTML parser runs. Catches all images set via JavaScript.
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
//       receives the (already) proxy URL. bhShouldSkip()'s "already proxied"
//       check (shared.js) means prehook recognizes that and leaves it alone
//       instead of wrapping it in the proxy a second time.
//
//    C) Inline CSS background-image — rewritten via el.style.backgroundImage.
//       Best-effort: stylesheet-defined backgrounds may already be loading.
//
//  Options are loaded once, in this file (see "Options loader" below), and
//  pushed to prehook.js through bhPrehookSetOpts().
//
//  The previous approach of using DNR regexSubstitution for image redirects
//  was removed because DNR cannot call encodeURIComponent. Any image URL
//  with query params (e.g. tvguide.com/img.jpg?auto=webp&width=1092) would
//  produce a malformed proxy URL with the original query params orphaned into
//  the proxy's own query string, silently breaking compression for those images.
//
// ══════════════════════════════════════════════════════════════════════════════

(function () {
  // ── Options loader ─────────────────────────────────────────────────────────
  // Try storage.local first (bhOpts mirror written by the service worker,
  // ~5 ms); fall back to storage.sync when the mirror is missing (fresh
  // install, worker not yet run) so we never run with empty defaults.
  // Stored values are merged over BH_DEFAULTS so a mirror written by an older
  // version (missing newer keys) can't yield `undefined` settings.
  const withDefaults = o => Object.assign({}, BH_DEFAULTS, o || {});
  const sameOpts = (a, b) => !!a && !!b && Object.keys(BH_DEFAULTS).every(k => a[k] === b[k]);

  let opts = null;
  let ready = false;

  function applyOpts(next) {
    const first = !ready;
    if (!first && sameOpts(opts, next)) return; // the local + sync listeners both fire for one change
    opts = next;
    ready = true;
    globalThis.bhPrehookSetOpts?.(opts);
    // Pages whose own host is excluded get no observer, no scan and no
    // preconnect — every URL on them would be skipped anyway.
    const active = !!(opts.enabled && opts.proxyBase &&
      !bhHostMatchesDomain(location.hostname, bhCachedDomainSet(opts)));
    setObserverEnabled(active);
    if (active) {
      injectPreconnect(opts.proxyBase);
      rewriteAll();
    }
  }

  // Lazy-load attributes used by common image libraries
  const LAZY_ATTRS = [
    "data-src", "data-iurl", "data-lazy-src", "data-original",
    "data-url", "data-hi-res", "data-lazy", "data-echo"
  ];

  // Elements whose inline style could carry a background-image. Matching on
  // the attribute directly — instead of every div/section/article/header/
  // footer/aside/main/figure/li/a/span/td/th on the page — keeps the full-page
  // scan cheap even on large, image-heavy pages: the broad tag list this used
  // to include walked thousands of elements that could never have an inline
  // background. The "i" flag also catches style="Background-Image:...".
  const BG_SELECTOR = "[style*='background' i]";
  const LAZY_SELECTOR = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");

  // Keep independent processing markers: an <img> can legitimately need all
  // three passes (src/srcset, lazy attrs, and inline background) at once.
  const doneImg = new WeakSet();
  const doneLazy = new WeakSet();
  const doneBg = new WeakSet();

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements.
  function rewriteImg(el) {
    if (!el || doneImg.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    // <source> only carries an image "src" inside <picture>; the same tag is
    // reused by <audio>/<video> for media files, where "src" is a video/audio
    // URL, not an image. The MutationObserver scan below uses a broad "img,
    // source" selector for simplicity, so guard here rather than narrowing
    // the selector everywhere it's used.
    const isPictureSource = el.tagName === "SOURCE" && el.parentElement?.tagName === "PICTURE";

    if (el.tagName === "IMG") {
      // Relative / protocol-relative URLs are resolved to absolute first;
      // previously only URLs literally starting with http(s):// were proxied.
      const abs = bhAbsUrl(el.getAttribute("src"));
      const u = abs && bhSafeURL(abs);
      if (u && !bhShouldSkip(abs, u.hostname, opts, location.hostname)) {
        el.setAttribute("src", bhBuildProxyUrl(abs, opts));
        rewrote = true;
      }
    }

    if (el.tagName === "IMG" || isPictureSource) {
      // srcset
      const ss = el.getAttribute("srcset");
      if (ss) {
        const rewritten = bhRewriteSrcset(ss, opts, location.hostname);
        if (rewritten !== ss) { el.setAttribute("srcset", rewritten); rewrote = true; }
      }
    }

    if (rewrote) doneImg.add(el);
  }

  // ── B) Lazy-attr rewriting ─────────────────────────────────────────────────
  // Rewrites data-src etc. so lazy-loaders pass proxy URLs to prehook.
  function rewriteLazy(el) {
    if (!el || doneLazy.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;

    let rewrote = false;

    // <img>/<picture><source> take any image URL. Other elements (divs used for
    // lazy backgrounds, <video data-src>, <a data-url>…) are only rewritten
    // when the URL actually looks like an image — data-url / data-lazy often
    // hold page links or media files, and proxying those breaks them.
    const imgLike = el.tagName === "IMG" ||
      (el.tagName === "SOURCE" && el.parentElement?.tagName === "PICTURE");

    for (const attr of LAZY_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val) continue;
      const abs = bhAbsUrl(val);
      if (!abs || (!imgLike && !bhLooksLikeImage(abs))) continue;
      const u = bhSafeURL(abs);
      if (!u || bhShouldSkip(abs, u.hostname, opts, location.hostname)) continue;
      el.setAttribute(attr, bhBuildProxyUrl(abs, opts));
      rewrote = true;
    }

    // data-srcset
    const dss = (imgLike || el.hasAttribute("data-srcset")) ? el.getAttribute("data-srcset") : null;
    if (dss) {
      const rewritten = bhRewriteSrcset(dss, opts, location.hostname);
      if (rewritten !== dss) { el.setAttribute("data-srcset", rewritten); rewrote = true; }
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
    if (!bg || !bg.includes("url(")) return;
    // Rewrite every url(...) in the value. The old slice(4, -1) approach
    // mangled multi-layer values like `linear-gradient(...), url(a)`.
    let touched = false;
    const out = bg.replace(/url\((["']?)(.*?)\1\)/g, (m, _q, raw) => {
      const abs = bhAbsUrl(raw);
      const u = abs && bhSafeURL(abs);
      if (!u || bhShouldSkip(abs, u.hostname, opts, location.hostname)) return m;
      touched = true;
      return `url("${bhBuildProxyUrl(abs, opts)}")`;
    });
    if (!touched) return;
    el.style.backgroundImage = out;
    doneBg.add(el);
  }

  // ── Full-page scan ────────────────────────────────────────────────────────
  function rewriteAll() {
    // Images and picture sources
    document.querySelectorAll("img, picture source").forEach(rewriteImg);

    // Lazy-loaded images
    document.querySelectorAll(LAZY_SELECTOR).forEach(rewriteLazy);

    // Inline backgrounds
    document.querySelectorAll(BG_SELECTOR).forEach(rewriteBg);
  }

  // ── MutationObserver ───────────────────────────────────────────────────────
  // Catches images added or changed after initial load (infinite scroll, SPAs…)
  const mo = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach(n => {
          if (n.nodeType !== 1) return;
          rewriteImg(n);
          if (n.matches?.(LAZY_SELECTOR)) rewriteLazy(n);
          rewriteBg(n);
          // "picture source" here (not the broader "img, source" used
          // elsewhere) skips <audio>/<video><source> elements outright —
          // matches rewriteAll()'s initial-scan selector; rewriteImg()
          // already no-ops on them via isPictureSource, so this just
          // avoids visiting them at all.
          n.querySelectorAll?.("img, picture source").forEach(rewriteImg);
          n.querySelectorAll?.(LAZY_SELECTOR).forEach(rewriteLazy);
          n.querySelectorAll?.(BG_SELECTOR).forEach(rewriteBg);
        });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;
        if (m.attributeName === "src" || m.attributeName === "srcset") {
          if (t.tagName === "IMG" || t.tagName === "SOURCE") {
            doneImg.delete(t); // allow re-rewrite when src changes
            rewriteImg(t);
          }
        } else if (m.attributeName === "style") {
          // Animation-heavy pages mutate `style` constantly; skip cheaply
          // unless the attribute text mentions a background.
          if (!/background/i.test(t.getAttribute("style") || "")) continue;
          doneBg.delete(t);
          rewriteBg(t);
        } else if (LAZY_ATTRS.includes(m.attributeName) || m.attributeName === "data-srcset") {
          doneLazy.delete(t);
          rewriteLazy(t);
        }
      }
    }
  });

  const observerConfig = {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset"]
  };
  let observing = false;

  function setObserverEnabled(enabled) {
    if (enabled === observing) return;
    if (enabled) {
      // Observe the document node so this remains safe even at document_start,
      // before document.documentElement exists on slower navigations.
      mo.observe(document, observerConfig);
    } else {
      mo.disconnect();
    }
    observing = enabled;
  }

  // ── Preconnect to proxy ───────────────────────────────────────────────────
  // Injecting <link rel="preconnect"> opens the TCP+TLS connection to the proxy
  // in parallel with HTML parsing, so the first image request doesn't pay the
  // full handshake cost (~100-300 ms on mobile).
  // dns-prefetch is a lighter fallback for browsers that ignore preconnect.
  function injectPreconnect(proxyBase) {
    try {
      const origin = new URL(proxyBase).origin;
      if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
      const root = document.head || document.documentElement;
      if (!root) return;
      // No crossorigin attribute: <img> requests are credentialed no-cors
      // fetches, and a crossorigin="anonymous" preconnect opens a *separate*
      // connection pool that image requests can't reuse. dns-prefetch was
      // dropped as redundant — preconnect already resolves DNS.
      const pc = document.createElement("link");
      pc.rel  = "preconnect";
      pc.href = origin;
      root.prepend(pc);
    } catch {}
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  // Kicked off last so every const/let above is initialized before any
  // storage callback can run applyOpts().
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (d.bhOpts) {
      applyOpts(withDefaults(d.bhOpts));
    } else {
      chrome.storage.sync.get(BH_DEFAULTS, synced => {
        applyOpts(withDefaults(synced));
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  // Stay current: local mirror (instant) primary, sync as fallback for
  // browsers where the service worker may be asleep (Kiwi/Cromite).
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      applyOpts(withDefaults(changes.bhOpts.newValue));
    } else if (area === "sync") {
      chrome.storage.sync.get(BH_DEFAULTS, synced => {
        chrome.storage.local.set({ bhOpts: synced });
        applyOpts(withDefaults(synced));
      });
    }
  });
})();
