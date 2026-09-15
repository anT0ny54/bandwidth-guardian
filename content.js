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

  let opts = null;
  const done = new WeakSet(); // elements already processed — no double-rewrites

  // ── A) <img src> and <source srcset> rewriting ────────────────────────────
  // Handles images whose src was set by the HTML parser (bypasses prehook).
  // Also handles srcset entries on both <img> and <source> elements.
  function rewriteImg(el) {
    if (!el || done.has(el)) return;
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
            // Use native src setter to avoid triggering prehook's patch again.
            Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")
              ?.set?.call(el, bhBuildProxyUrl(src, opts));
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

    if (rewrote) done.add(el);
  }

  // ── B) Lazy-attr rewriting ─────────────────────────────────────────────────
  // Rewrites data-src etc. so lazy-loaders pass proxy URLs to prehook.
  function rewriteLazy(el) {
    if (!el || done.has(el)) return;
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

    if (rewrote) done.add(el);
  }

  // ── C) Inline background-image rewriting ──────────────────────────────────
  // Handles elements with style="background-image: url(...)".
  // CSS stylesheet backgrounds can't be intercepted without getComputedStyle,
  // but overriding inline style is enough for most dynamic content.
  function rewriteBg(el) {
    if (!el || done.has(el)) return;
    if (!opts?.proxyBase || !opts?.enabled) return;
    const bg = el.style?.backgroundImage;
    if (!bg || !bg.startsWith("url(")) return;
    const raw = bg.slice(4, -1).replace(/['"]/g, "").trim();
    if (!raw || !bhIsHttp(raw)) return;
    const u = bhSafeURL(raw);
    if (!u || bhShouldSkip(raw, u.hostname, opts, location.hostname)) return;
    el.style.backgroundImage = `url("${bhBuildProxyUrl(raw, opts)}")`;
    done.add(el);
  }

  // ── Full-page scan ────────────────────────────────────────────────────────
  function rewriteAll() {
    // Images and picture sources
    document.querySelectorAll("img, picture source").forEach(rewriteImg);

    // Lazy-loaded images
    const lazySel = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");
    document.querySelectorAll(lazySel).forEach(rewriteLazy);

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
          n.querySelectorAll?.("img, source").forEach(rewriteImg);
          const lazySel = LAZY_ATTRS.concat(["data-srcset"]).map(a => `[${a}]`).join(",");
          n.querySelectorAll?.(lazySel).forEach(rewriteLazy);
          n.querySelectorAll?.(BG_SELECTOR).forEach(rewriteBg);
        });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;
        if (m.attributeName === "src" || m.attributeName === "srcset") {
          if (t.tagName === "IMG" || t.tagName === "SOURCE") {
            done.delete(t); // allow re-rewrite when src changes
            rewriteImg(t);
          }
        } else if (m.attributeName === "style") {
          done.delete(t);
          rewriteBg(t);
        } else if (LAZY_ATTRS.includes(m.attributeName) || m.attributeName === "data-srcset") {
          done.delete(t);
          rewriteLazy(t);
        }
      }
    }
  });

  mo.observe(document.documentElement, {
    childList:       true,
    subtree:         true,
    attributes:      true,
    attributeFilter: ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset"]
  });

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
  // Try storage.local first (bhOpts mirror, ~5 ms). If bhOpts isn't there yet
  // (fresh install, service worker hasn't run, browser restart) fall back to
  // storage.sync and write the mirror so subsequent pages are fast.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (d.bhOpts) {
      opts = d.bhOpts;
      if (opts.enabled && opts.proxyBase) {
        injectPreconnect(opts.proxyBase);
        rewriteAll();
      }
    } else {
      chrome.storage.sync.get(BH_DEFAULTS, synced => {
        opts = synced;
        // Write mirror so next page load takes the fast path
        chrome.storage.local.set({ bhOpts: synced });
        if (opts.enabled && opts.proxyBase) {
          injectPreconnect(opts.proxyBase);
          rewriteAll();
        }
      });
    }
  });

  // Stay current when settings change.
  // Primary: local area (bhOpts mirror updated by service worker, instant).
  // Fallback: sync area — catches changes when the service worker is inactive,
  // restarting, or not supported (Kiwi/Cromite). Both paths update opts.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      opts = changes.bhOpts.newValue || BH_DEFAULTS;
    } else if (area === "sync") {
      // Rebuild opts from the sync change and also refresh the local mirror
      chrome.storage.sync.get(BH_DEFAULTS, synced => {
        opts = synced;
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });
})();
