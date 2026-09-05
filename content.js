// Bandwidth Guardian — content script
(function () {
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
    "data-src",
    "data-iurl",
    "data-lazy-src",
    "data-original",
    "data-url",
    "data-hi-res",
    "data-lazy",
    "data-echo",
  ];

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
  let opts = null;
  const lazySelector = LAZY_ATTRS.concat(["data-srcset"])
    .map((a) => `[${a}]`)
    .join(",");

  const safeURL = (u) => {
    try {
      return new URL(u);
    } catch {
      return null;
    }
  };

  const isHttp = (u) => /^https?:\/\//i.test(u);

  function domainSet(text) {
    return new Set(
      String(text || "")
        .split(/[, \s]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((s) => s.replace(/^https?:\/\//, "").split("/")[0])
    );
  }

  function shouldSkip(url) {
    if (!opts?.enabled || !opts?.proxyBase) return true;
    if (!isHttp(url)) return true;

    const u = safeURL(url);
    if (!u) return true;

    const proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase();
    if (proxyHost && u.hostname.toLowerCase() === proxyHost) return true;

    const ex = domainSet(opts.excludeDomains);
    if (ex.has(u.hostname.toLowerCase())) return true;
    if (ex.has(location.hostname.toLowerCase())) return true;

    const path = u.pathname.toLowerCase();
    if (path.endsWith(".ico") || path.endsWith(".svg")) return true;
    if (url.toLowerCase().includes("favicon")) return true;
    if (TRACKING_PATTERNS.some((p) => p.test(url))) return true;

    return false;
  }

  function buildProxyUrl(orig) {
    const base = (opts.proxyBase || "").trim();
    const sep = base.includes("?") ? "&" : "?";
    const jpeg = opts.isWebpSupported ? "0" : "1";
    const bw = opts.grayscale ? "1" : "0";

    const parts = [
      "url=" + encodeURIComponent(orig),
      "jpeg=" + jpeg,
      "bw=" + bw,
      "quality=" + (opts.quality ?? 40),
    ];
    if (opts.maxWidth) parts.push("max_width=" + opts.maxWidth);

    return base + sep + parts.join("&");
  }

  function setNativeSrc(el, value) {
    const desc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
    desc?.set?.call(el, value);
  }

  function rewriteSrcset(el, attrName) {
    const ss = el.getAttribute(attrName);
    if (!ss) return false;

    let touched = false;
    const rewritten = ss
      .split(",")
      .map((part) => {
        const m = part.trim().match(/^(\S+)(\s.*)?$/);
        if (!m) return part;
        const [, url, desc = ""] = m;
        if (!isHttp(url) || shouldSkip(url)) return part;
        touched = true;
        return buildProxyUrl(url) + desc;
      })
      .join(", ");

    if (touched) el.setAttribute(attrName, rewritten);
    return touched;
  }

  function rewriteImg(el) {
    if (!el || done.has(el)) return;
    if (!opts?.enabled || !opts?.proxyBase) return;
    if (el.tagName !== "IMG" && el.tagName !== "SOURCE") return;

    let rewrote = false;

    const src = el.getAttribute("src");
    if (src && isHttp(src) && !shouldSkip(src)) {
      setNativeSrc(el, buildProxyUrl(src));
      rewrote = true;
    }

    if (rewriteSrcset(el, "srcset")) rewrote = true;

    if (rewrote) done.add(el);
  }

  function rewriteLazy(el) {
    if (!el || done.has(el)) return;
    if (!opts?.enabled || !opts?.proxyBase) return;

    let rewrote = false;

    for (const attr of LAZY_ATTRS) {
      const val = el.getAttribute(attr);
      if (!val || !isHttp(val) || shouldSkip(val)) continue;
      el.setAttribute(attr, buildProxyUrl(val));
      rewrote = true;
    }

    if (rewriteSrcset(el, "data-srcset")) rewrote = true;

    if (rewrote) done.add(el);
  }

  function rewriteBg(el) {
    if (!el || done.has(el)) return;
    if (!opts?.enabled || !opts?.proxyBase) return;

    const bg = el.style?.backgroundImage;
    if (!bg || !bg.startsWith("url(")) return;

    const raw = bg.slice(4, -1).replace(/['"]/g, "").trim();
    if (!raw || !isHttp(raw) || shouldSkip(raw)) return;

    el.style.backgroundImage = `url("${buildProxyUrl(raw)}")`;
    done.add(el);
  }

  function rewriteAll(root = document) {
    root.querySelectorAll("img, picture source").forEach(rewriteImg);
    root.querySelectorAll(lazySelector).forEach(rewriteLazy);
    root
      .querySelectorAll(
        "div, section, article, header, footer, aside, main, figure, li, a, span, td, th, [style*='background']"
      )
      .forEach(rewriteBg);
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          rewriteImg(n);
          rewriteLazy(n);
          rewriteBg(n);
          n.querySelectorAll?.("img, picture source").forEach(rewriteImg);
          n.querySelectorAll?.(lazySelector).forEach(rewriteLazy);
          n.querySelectorAll?.("[style*='background']").forEach(rewriteBg);
        });
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!t) continue;

        if (m.attributeName === "src" || m.attributeName === "srcset") {
          if (t.tagName === "IMG" || t.tagName === "SOURCE") {
            done.delete(t);
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

  function injectPreconnect(proxyBase) {
    try {
      const origin = new URL(proxyBase).origin;
      if (document.querySelector(`link[href="${origin}"]`)) return;

      const root = document.head || document.documentElement;
      if (!root) return;

      const pc = document.createElement("link");
      pc.rel = "preconnect";
      pc.href = origin;
      pc.crossOrigin = "anonymous";
      root.prepend(pc);

      const dns = document.createElement("link");
      dns.rel = "dns-prefetch";
      dns.href = origin;
      root.prepend(dns);
    } catch {}
  }

  function applySettings(nextOpts) {
    opts = nextOpts || DEFAULTS;
    if (opts.enabled && opts.proxyBase) {
      injectPreconnect(opts.proxyBase);
      rewriteAll();
    }
  }

  function startObserver() {
    if (!document.documentElement) return;
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "style", ...LAZY_ATTRS, "data-srcset"],
    });
  }

  chrome.storage.local.get({ bhOpts: null }, (d) => {
    if (d.bhOpts) {
      applySettings(d.bhOpts);
    } else {
      chrome.storage.sync.get(DEFAULTS, (synced) => {
        chrome.storage.local.set({ bhOpts: synced });
        applySettings(synced);
      });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.bhOpts) {
      opts = changes.bhOpts.newValue || DEFAULTS;
      if (opts.enabled && opts.proxyBase) rewriteAll();
    } else if (area === "sync") {
      chrome.storage.sync.get(DEFAULTS, (synced) => {
        applySettings(synced);
        chrome.storage.local.set({ bhOpts: synced });
      });
    }
  });

  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  }
})();
