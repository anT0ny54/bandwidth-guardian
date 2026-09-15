// Bandwidth Guardian — document_start content rewriter.
// Layer 1 (prehook.js) handles JS assignments synchronously. This layer covers
// parser-created markup, lazy attributes, inline backgrounds, and SPA changes.

(function () {
  const DEFAULTS = {
    enabled: true,
    proxyBase: '',
    quality: 40,
    grayscale: true,
    maxWidth: 1280,
    excludeDomains: 'google.com gstatic.com challenges.cloudflare.com',
    isWebpSupported: false
  };

  const LAZY_ATTRS = [
    'data-src', 'data-iurl', 'data-lazy-src', 'data-original',
    'data-url', 'data-hi-res', 'data-lazy', 'data-echo'
  ];

  const TRACKING_PATTERNS = [
    /pagead/i,
    /(pixel|cleardot)[^/]*\.(gif|jpg|jpeg)/i,
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
    /ad\.doubleclick\.net/i
  ];

  const safeURL = value => { try { return new URL(value); } catch { return null; } };
  const isHttp = value => /^https?:\/\//i.test(value);
  const toHttpUrl = value => {
    try {
      const url = new URL(String(value), document.baseURI);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch { return null; }
  };

  function parseDomains(text) {
    return new Set(
      String(text || '')
        .split(/[\s,]+/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .map(s => s.replace(/^https?:\/\//, '').split('/')[0])
    );
  }

  function domainMatches(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  let opts = null;
  let excludedHosts = new Set();
  let proxyHost = '';
  const done = new WeakSet();

  function applyOptions(next) {
    opts = { ...DEFAULTS, ...(next || {}) };
    excludedHosts = parseDomains(opts.excludeDomains);
    proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || '';
  }

  function shouldSkip(url) {
    if (!opts?.enabled || !opts.proxyBase) return true;
    const absolute = toHttpUrl(url);
    if (!absolute) return true;
    const parsed = safeURL(absolute);
    if (!parsed) return true;
    const host = parsed.hostname.toLowerCase();
    const pageHost = location.hostname.toLowerCase();
    if (proxyHost && host === proxyHost) return true;
    for (const domain of excludedHosts) {
      if (domainMatches(host, domain) || domainMatches(pageHost, domain)) return true;
    }

    const lower = absolute.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (path.endsWith('.ico') || path.endsWith('.svg')) return true;
    if (lower.includes('favicon')) return true;
    return TRACKING_PATTERNS.some(pattern => pattern.test(absolute));
  }

  function buildProxyUrl(original) {
    const base = String(opts?.proxyBase || '').trim();
    if (!base || !isHttp(original)) return original;
    const sep = base.endsWith('?') || base.endsWith('&') ? '' : (base.includes('?') ? '&' : '?');
    const parts = [
      'url=' + encodeURIComponent(original),
      'jpeg=' + (opts.isWebpSupported ? '0' : '1'),
      'bw=' + (opts.grayscale ? '1' : '0'),
      'quality=' + encodeURIComponent(String(opts.quality ?? DEFAULTS.quality))
    ];
    if (opts.maxWidth) parts.push('max_width=' + encodeURIComponent(String(opts.maxWidth)));
    return base + sep + parts.join('&');
  }

  const nativeSetAttribute = Element.prototype.setAttribute;
  const imageSrcSetter = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')?.set;
  function setNativeSrc(el, value) {
    if (el instanceof HTMLImageElement) {
      imageSrcSetter?.call(el, value);
    } else {
      nativeSetAttribute.call(el, 'src', value);
    }
  }

  function setNativeSrcset(el, value) {
    nativeSetAttribute.call(el, 'srcset', value);
  }

  function rewriteSrcset(value) {
    return String(value || '').split(',').map(part => {
      const match = part.trim().match(/^(\S+)(\s.*)?$/);
      if (!match) return part;
      const [_, url, descriptor = ''] = match;
      const absolute = toHttpUrl(url);
      if (!absolute || shouldSkip(absolute)) return part;
      return buildProxyUrl(absolute) + descriptor;
    }).join(', ');
  }

  function rewriteImage(el) {
    if (!el || done.has(el) || !opts?.enabled || !opts.proxyBase) return;
    let changed = false;

    const src = el.getAttribute('src');
    const absoluteSrc = src && toHttpUrl(src);
    if (absoluteSrc && !shouldSkip(absoluteSrc)) {
      setNativeSrc(el, buildProxyUrl(absoluteSrc));
      changed = true;
    }

    const srcset = el.getAttribute('srcset');
    if (srcset) {
      const rewritten = rewriteSrcset(srcset);
      if (rewritten !== srcset) {
        setNativeSrcset(el, rewritten);
        changed = true;
      }
    }

    if (changed) done.add(el);
  }

  function rewriteLazy(el) {
    if (!el || done.has(el) || !opts?.enabled || !opts.proxyBase) return;
    let changed = false;

    for (const attr of LAZY_ATTRS) {
      const value = el.getAttribute(attr);
      const absolute = value && toHttpUrl(value);
      if (!absolute || shouldSkip(absolute)) continue;
      nativeSetAttribute.call(el, attr, buildProxyUrl(absolute));
      changed = true;
    }

    const dataSrcset = el.getAttribute('data-srcset');
    if (dataSrcset) {
      const rewritten = rewriteSrcset(dataSrcset);
      if (rewritten !== dataSrcset) {
        nativeSetAttribute.call(el, 'data-srcset', rewritten);
        changed = true;
      }
    }

    if (changed) done.add(el);
  }

  function extractInlineBackground(style) {
    if (!style) return null;
    const match = String(style).match(/^url\((['"]?)(https?:\/\/[^'")]+)\1\)$/i);
    return match?.[2] || null;
  }

  function rewriteBg(el) {
    if (!el || done.has(el) || !opts?.enabled || !opts.proxyBase) return;
    const raw = extractInlineBackground(el.style?.backgroundImage);
    if (!raw || shouldSkip(raw)) return;
    el.style.backgroundImage = `url("${buildProxyUrl(raw)}")`;
    done.add(el);
  }

  const lazySelector = LAZY_ATTRS.concat('data-srcset').map(attr => `[${attr}]`).join(',');
  const bgSelector = '[style*="background"]';

  function scan(root = document) {
    root.querySelectorAll?.('img, picture source').forEach(rewriteImage);
    root.querySelectorAll?.(lazySelector).forEach(rewriteLazy);
    root.querySelectorAll?.(bgSelector).forEach(rewriteBg);
  }

  function injectPreconnect(proxyBase) {
    try {
      const origin = new URL(proxyBase).origin;
      if (!origin || document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
      const root = document.head || document.documentElement;
      if (!root) return;
      const preconnect = document.createElement('link');
      preconnect.rel = 'preconnect';
      preconnect.href = origin;
      preconnect.crossOrigin = 'anonymous';
      root.prepend(preconnect);
      const dns = document.createElement('link');
      dns.rel = 'dns-prefetch';
      dns.href = origin;
      root.prepend(dns);
    } catch {}
  }

  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          rewriteImage(node);
          rewriteLazy(node);
          rewriteBg(node);
          scan(node);
        }
      } else if (mutation.type === 'attributes') {
        const target = mutation.target;
        done.delete(target);
        if (mutation.attributeName === 'src' || mutation.attributeName === 'srcset') rewriteImage(target);
        else if (mutation.attributeName === 'style') rewriteBg(target);
        else if (LAZY_ATTRS.includes(mutation.attributeName) || mutation.attributeName === 'data-srcset') rewriteLazy(target);
      }
    }
  });

  function loadSettings() {
    chrome.storage.local.get({ bhOpts: null }, local => {
      const finish = next => {
        applyOptions(next);
        chrome.storage.local.set({ bhOpts: opts });
        if (opts.enabled && opts.proxyBase) {
          injectPreconnect(opts.proxyBase);
          scan(document);
        }
      };
      if (local.bhOpts) finish(local.bhOpts);
      else chrome.storage.sync.get(DEFAULTS, finish);
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.bhOpts) {
      applyOptions(changes.bhOpts.newValue || DEFAULTS);
      if (opts.enabled && opts.proxyBase) {
        injectPreconnect(opts.proxyBase);
        scan(document);
      }
    } else if (area === 'sync') {
      chrome.storage.sync.get(DEFAULTS, synced => {
        applyOptions(synced);
        chrome.storage.local.set({ bhOpts: opts });
        if (opts.enabled && opts.proxyBase) {
          injectPreconnect(opts.proxyBase);
          scan(document);
        }
      });
    }
  });

  // The parser/native image loader runs independently of the JS setter patch,
  // so this layer remains necessary for markup already carrying src/srcset.
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'style', ...LAZY_ATTRS, 'data-srcset']
  });

  loadSettings();
})();
