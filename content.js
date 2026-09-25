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
//  The previous approach of using DNR regexSubstitution for image redirects
//  was removed because DNR cannot call encodeURIComponent. Any image URL
//  with query params (e.g. tvguide.com/img.jpg?auto=webp&width=1092) would
//  produce a malformed proxy URL with the original query params orphaned into
//  the proxy's own query string, silently breaking compression for those images.
//
// ══════════════════════════════════════════════════════════════════════════════

(function () {
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

  let opts = null;
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
      // src — only real <img> elements have one that means "image URL".
      const src = el.getAttribute("src");
      if (src && bhIsHttp(src)) {
        const u = bhSafeURL(src);
        if (u && !bhShouldSkip(src, u.hostname, opts, location.hostname)) {
          try {
            // bhNativeSetImgSrc (shared.js) is the descriptor captured before
            // prehook.js patched HTMLImageElement.prototype.src. Querying the
            // prototype for it here instead would return prehook's *patched*
            // setter — silently re-entering it with an already-proxied URL —
            // since prehook.js has already run by the time this file does.
            bhNativeSetImgSrc(el, bhBuildProxyUrl(src, opts));
            rewrote = true;
          } catch { /* illegal invocation on an unexpected element type */ }
        }
      }
    }

    if (el.tagName === "IMG" || isPictureSource) {
      // srcset
      const ss = el.getAttribute("srcset");
      if (ss) {
        let touched = false;
        const rewritten = ss.split(",").map(part => {
          const m = part.trim().match(/^(\S+)(\s.*)?$/);
          if (!m) return part;
          const [, url, desc = ""] = m;
          if (!bhIsHttp(url)) return part;
          const u = bhSafeURL(url);
          if (!u || bhShouldSkip(url, u.hostname, opts, location.hostname)) return part;
          touched = true;
          return bhBuildProxyUrl(url, opts) + desc;
        }).join(", ");
        if (touched) { el.setAttribute("srcset", rewritten); rewrote = true; }
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

    for (const attr of LAZY_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val || !bhIsHttp(val)) continue;
      const u = bhSafeURL(val);
      if (!u || bhShouldSkip(val, u.hostname, opts, location.hostname)) continue;
      el.setAttribute(attr, bhBuildProxyUrl(val, opts));
      rewrote = true;
    }

    // data-srcset
    const dss = el.getAttribute("data-srcset");
    if (dss) {
      let touched = false;
      const rewritten = dss.split(",").map(part => {
        const m = part.trim().match(/^(\S+)(\s.*)?$/);
        if (!m) return part;
        const [, url, desc = ""] = m;
        if (!bhIsHttp(url)) return part;
        const u = bhSafeURL(url);
        if (!u || bhShouldSkip(url, u.hostname, opts, location.hostname)) return part;
        touched = true;
        return bhBuildProxyUrl(url, opts) + desc;
      }).join(", ");
      if (touched) { el.setAttribute("data-srcset", rewritten); rewrote = true; }
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
    if (!bg || !bg.startsWith("url(")) return;
    const raw = bg.slice(4, -1).replace(/['"]/g, "").trim();
    if (!raw || !bhIsHttp(raw)) return;
    const u = bhSafeURL(raw);
    if (!u || bhShouldSkip(raw, u.hostname, opts, location.hostname)) return;
    el.style.backgroundImage = `url("${bhBuildProxyUrl(raw, opts)}")`;
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
          rewriteLazy(n);
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
      if (document.querySelector(`link[href="${origin}"]`)) return; // already injected
      const root = document.head || document.documentElement;
      if (!root) return;
      const pc = document.createElement("link");
      pc.rel  = "preconnect";
      pc.href = origin;
      pc.crossOrigin = "anonymous";
      root.prepend(pc);
      const dns = document.createElement("link");
      dns.rel  = "dns-prefetch";
      dns.href = origin;
      root.prepend(dns);
    } catch {}
  }

  // ── Load settings then process page ───────────────────────────────────────
  // Options are loaded once, in shared.js, and shared with prehook.js via
  // bhOnReady/bhOnOptsChange — see the v0.0.6 note at the top of shared.js.
  bhOnReady(o => {
    opts = o;
    const active = !!(opts.enabled && opts.proxyBase);
    setObserverEnabled(active);
    if (active) {
      injectPreconnect(opts.proxyBase);
      rewriteAll();
    }
  });
  bhOnOptsChange(o => {
    opts = o;
    const active = !!(opts.enabled && opts.proxyBase);
    setObserverEnabled(active);
    if (active) {
      injectPreconnect(opts.proxyBase);
      rewriteAll();
    }
  });
})();
