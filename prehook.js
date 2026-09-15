// Bandwidth Guardian — prehook (document_start, synchronous)
// Patches image URL setters before the HTML parser runs. JavaScript-assigned
// images therefore receive the proxy URL before a network request can start.

(() => {
  // Content scripts cannot import defaults.js, so keep this compact mirror in sync.
  const DEFAULTS = {
    enabled: true,
    proxyBase: "",
    quality: 40,
    grayscale: true,
    maxWidth: 1280,
    excludeDomains: "google.com gstatic.com challenges.cloudflare.com",
    isWebpSupported: false
  };

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
      String(text || "")
        .split(/[\s,]+/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean)
        .map(s => s.replace(/^https?:\/\//, "").split('/')[0])
    );
  }

  function domainMatches(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  let opts = null;
  let ready = false;
  let excludedHosts = new Set();
  let proxyHost = "";
  const pending = new Map(); // Element -> { src?, srcset? }

  function applyOptions(next) {
    opts = { ...DEFAULTS, ...(next || {}) };
    ready = true;
    excludedHosts = parseDomains(opts.excludeDomains);
    proxyHost = safeURL(opts.proxyBase)?.hostname?.toLowerCase() || "";
  }

  function excludedHost(host) {
    host = String(host || '').toLowerCase();
    for (const domain of excludedHosts) {
      if (domainMatches(host, domain)) return true;
    }
    return false;
  }

  function shouldSkipUrl(url, hostname) {
    if (!opts?.enabled || !opts.proxyBase) return true;
    const host = String(hostname || "").toLowerCase();
    if (!host || (proxyHost && host === proxyHost)) return true;
    if (excludedHost(host) || excludedHost(location.hostname)) return true;

    const lower = url.toLowerCase();
    const pathname = safeURL(url)?.pathname?.toLowerCase() || lower;
    if (pathname.endsWith('.ico') || pathname.endsWith('.svg')) return true;
    if (lower.includes('favicon')) return true;
    return TRACKING_PATTERNS.some(pattern => pattern.test(url));
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

  const imgProto = HTMLImageElement.prototype;
  const imgSrcDesc = Object.getOwnPropertyDescriptor(imgProto, 'src');
  const imgSrcsetDesc = Object.getOwnPropertyDescriptor(imgProto, 'srcset');
  const nativeSetAttribute = Element.prototype.setAttribute;
  const sourceProto = typeof HTMLSourceElement !== 'undefined' ? HTMLSourceElement.prototype : null;
  const sourceSrcsetDesc = sourceProto
    ? Object.getOwnPropertyDescriptor(sourceProto, 'srcset')
    : null;

  const nativeSetSrc = (el, value) => imgSrcDesc?.set?.call(el, value);
  const nativeSetSrcset = (el, value) => imgSrcsetDesc?.set?.call(el, value);
  const nativeSetSourceSrcset = (el, value) => sourceSrcsetDesc?.set?.call(el, value);

  function rewriteSrcset(value) {
    if (!value) return value;
    return String(value).split(',').map(part => {
      const match = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!match) return part;
      const [_, url, descriptor = ''] = match;
      const absolute = toHttpUrl(url);
      const parsed = absolute && safeURL(absolute);
      if (!absolute || !parsed || shouldSkipUrl(absolute, parsed.hostname)) return part;
      return buildProxyUrl(absolute) + descriptor;
    }).join(', ');
  }

  function decideSrc(original) {
    original = String(original);
    const absolute = toHttpUrl(original);
    if (!absolute) return original;
    const parsed = safeURL(absolute);
    if (!parsed) return original;
    if (ready) return shouldSkipUrl(absolute, parsed.hostname) ? original : buildProxyUrl(absolute);
    return null;
  }

  function queue(el, field, value) {
    const item = pending.get(el) || {};
    item[field] = value;
    pending.set(el, item);
  }

  function flushPending() {
    for (const [el, item] of pending) {
      pending.delete(el);
      try {
        if ('src' in item && el instanceof HTMLImageElement) {
          const absolute = toHttpUrl(item.src);
          const parsed = absolute && safeURL(absolute);
          nativeSetSrc(
            el,
            parsed && !shouldSkipUrl(absolute, parsed.hostname)
              ? buildProxyUrl(absolute)
              : item.src
          );
        }
        if ('srcset' in item) {
          if (el instanceof HTMLImageElement) nativeSetSrcset(el, rewriteSrcset(item.srcset));
          else if (sourceProto && el instanceof HTMLSourceElement) nativeSetSourceSrcset(el, rewriteSrcset(item.srcset));
        }
      } catch {}
    }
  }

  // Storage is read after the synchronous patches are installed below.
  const loadSettings = () => {
    chrome.storage.local.get({ bhOpts: null }, local => {
      if (local.bhOpts) {
        applyOptions(local.bhOpts);
        flushPending();
        return;
      }
      chrome.storage.sync.get(DEFAULTS, synced => {
        applyOptions(synced);
        flushPending();
        chrome.storage.local.set({ bhOpts: opts });
      });
    });
  };

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.bhOpts) {
      applyOptions(changes.bhOpts.newValue || DEFAULTS);
      flushPending();
    } else if (area === 'sync') {
      chrome.storage.sync.get(DEFAULTS, synced => {
        applyOptions(synced);
        chrome.storage.local.set({ bhOpts: opts });
        flushPending();
      });
    }
  });

  if (imgSrcDesc?.set) {
    Object.defineProperty(imgProto, 'src', {
      configurable: true,
      enumerable: imgSrcDesc.enumerable,
      get: imgSrcDesc.get,
      set(value) {
        try {
          const original = String(value);
          const decided = decideSrc(original);
          if (decided === null) {
            queue(this, 'src', original);
            nativeSetSrc(this, 'about:blank');
          } else {
            nativeSetSrc(this, decided);
          }
        } catch {
          nativeSetSrc(this, value);
        }
      }
    });
  }

  if (imgSrcsetDesc?.set) {
    Object.defineProperty(imgProto, 'srcset', {
      configurable: true,
      enumerable: imgSrcsetDesc.enumerable,
      get: imgSrcsetDesc.get,
      set(value) {
        try {
          const original = String(value || '');
          if (!ready) {
            queue(this, 'srcset', original);
            nativeSetSrcset(this, '');
          } else {
            nativeSetSrcset(this, rewriteSrcset(original));
          }
        } catch {
          nativeSetSrcset(this, value);
        }
      }
    });
  }

  if (sourceProto && sourceSrcsetDesc?.set) {
    Object.defineProperty(sourceProto, 'srcset', {
      configurable: true,
      enumerable: sourceSrcsetDesc.enumerable,
      get: sourceSrcsetDesc.get,
      set(value) {
        try {
          const original = String(value || '');
          if (!ready) {
            queue(this, 'srcset', original);
            nativeSetSourceSrcset(this, '');
          } else {
            nativeSetSourceSrcset(this, rewriteSrcset(original));
          }
        } catch {
          nativeSetSourceSrcset(this, value);
        }
      }
    });
  }

  Element.prototype.setAttribute = function(name, value) {
    try {
      const attr = String(name).toLowerCase();
      if (this instanceof HTMLImageElement && attr === 'src') {
        const original = String(value);
        const decided = decideSrc(original);
        if (decided === null) {
          queue(this, 'src', original);
          return nativeSetAttribute.call(this, 'src', 'about:blank');
        }
        return nativeSetAttribute.call(this, 'src', decided);
      }
      if (this instanceof HTMLImageElement && attr === 'srcset') {
        const original = String(value || '');
        if (!ready) {
          queue(this, 'srcset', original);
          return nativeSetAttribute.call(this, 'srcset', '');
        }
        return nativeSetAttribute.call(this, 'srcset', rewriteSrcset(original));
      }
      if (sourceProto && this instanceof HTMLSourceElement && attr === 'srcset') {
        const original = String(value || '');
        if (!ready) {
          queue(this, 'srcset', original);
          return nativeSetAttribute.call(this, 'srcset', '');
        }
        return nativeSetAttribute.call(this, 'srcset', rewriteSrcset(original));
      }
    } catch {}
    return nativeSetAttribute.call(this, name, value);
  };

  // new Image() returns a native HTMLImageElement, whose patched src setter
  // above performs the actual interception.
  const NativeImage = window.Image;
  function PatchedImage(width, height) {
    return new NativeImage(width, height);
  }
  PatchedImage.prototype = NativeImage.prototype;
  Object.defineProperty(window, 'Image', {
    configurable: true,
    writable: true,
    value: PatchedImage
  });

  loadSettings();
})();
