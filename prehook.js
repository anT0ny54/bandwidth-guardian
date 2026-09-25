// Bandwidth Guardian — MAIN-world prehook (document_start)
//
// This file must run in the page's MAIN world. Patching DOM prototypes from an
// ISOLATED content-script world does not affect the page's JavaScript.
//
// chrome.* APIs are intentionally not used here. shared.js runs in the
// extension's isolated world and sends the current (non-secret) settings over
// a small window.postMessage bridge. Until the settings arrive, HTTP image
// assignments are held without starting a network request.
//
// MAIN-world code is inherently visible to and modifiable by the host page.
// Keep state private inside this IIFE and avoid exposing extension globals.

(() => {
  "use strict";

  const CHANNEL = "__bandwidth_guardian_v1__";
  const FALLBACK_EVENT = "__bandwidth_guardian_fallback__";

  const DEFAULTS = {
    enabled: true,
    proxyBase: "",
    quality: 40,
    grayscale: true,
    maxWidth: 1280,
    excludeDomains: "google.com gstatic.com challenges.cloudflare.com",
    isWebpSupported: false,
  };

  // If an extension/browser edge case prevents the isolated-world settings
  // bridge from answering, release queued URLs rather than leaving page code
  // permanently stuck. Normal loads resolve much sooner than this fallback.
  const SETTINGS_TIMEOUT_MS = 1500;

  let opts = null;
  let ready = false;
  let fallbackTimer = null;
  let excludedDomains = new Set();

  const pendingSrc = new WeakMap();
  const pendingSrcset = new WeakMap();
  const pendingLinkHref = new WeakMap();

  // A resource element gets at most one direct-origin retry for the current
  // page-assigned resource. Error events can be duplicated while currentSrc
  // still reports the failed proxy candidate, so URL inspection alone is not
  // sufficient to enforce a true one-retry guarantee.
  const fallbackRetried = new WeakSet();

  const proxySignatures = new Set();

  const imgProto = HTMLImageElement.prototype;
  const srcDesc = Object.getOwnPropertyDescriptor(imgProto, "src");
  const srcsetDesc = Object.getOwnPropertyDescriptor(imgProto, "srcset");
  const setAttr = Element.prototype.setAttribute;
  const removeAttr = Element.prototype.removeAttribute;

  const sourceProto =
    typeof HTMLSourceElement !== "undefined" ? HTMLSourceElement.prototype : null;
  const sourceSrcsetDesc =
    sourceProto ? Object.getOwnPropertyDescriptor(sourceProto, "srcset") : null;

  const linkProto =
    typeof HTMLLinkElement !== "undefined" ? HTMLLinkElement.prototype : null;
  const linkHrefDesc =
    linkProto ? Object.getOwnPropertyDescriptor(linkProto, "href") : null;
  const linkRelDesc =
    linkProto ? Object.getOwnPropertyDescriptor(linkProto, "rel") : null;
  const linkAsDesc =
    linkProto ? Object.getOwnPropertyDescriptor(linkProto, "as") : null;

  if (!srcDesc?.set || !srcsetDesc?.set ||
      srcDesc.configurable !== true || srcsetDesc.configurable !== true) return;

  function safeURL(value, base = document.baseURI || location.href) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    try {
      const u = new URL(raw, base);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u;
    } catch {
      return null;
    }
  }

  function isValidProxyBase(value) {
    try {
      const u = new URL(String(value || "").trim());
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }

  function domainSet(text) {
    if (Array.isArray(text)) return new Set(text);
    return new Set(
      String(text || "").split(/[,\s]+/)
        .map(s => s.trim().toLowerCase()).filter(Boolean)
        .map(s => s.replace(/^https?:\/\//, "").split("/")[0])
        .map(s => s.replace(/^\*?\./, "").replace(/\.$/, ""))
        .filter(Boolean)
    );
  }

  function hostMatches(hostname, domains) {
    const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
    if (!host) return false;
    for (const domain of domains) {
      if (host === domain || host.endsWith("." + domain)) return true;
    }
    return false;
  }

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

  function proxySignature(base) {
    const u = safeURL(base);
    return u ? u.origin + u.pathname : "";
  }

  function registerProxy(base) {
    const signature = proxySignature(base);
    if (signature) proxySignatures.add(signature);
  }

  function looksLikeGeneratedProxy(url) {
    const u = safeURL(url);
    if (!u || !u.searchParams.has("url")) return false;
    const signature = u.origin + u.pathname;
    if (!proxySignatures.has(signature)) return false;
    return u.searchParams.has("quality") &&
           u.searchParams.has("bw") &&
           u.searchParams.has("jpeg");
  }

  function shouldSkip(url, hostname, settings, pageHostname) {
    if (!settings) return false;
    if (settings.enabled === false) return true;

    const host = String(hostname || "").toLowerCase();
    if (hostMatches(host, excludedDomains)) return true;
    if (pageHostname && hostMatches(pageHostname, excludedDomains)) return true;
    if (looksLikeGeneratedProxy(url)) return true;

    let path = String(url || "").toLowerCase();
    try {
      path = new URL(url, document.baseURI || location.href).pathname.toLowerCase();
    } catch {}
    if (path.endsWith(".ico") || path.endsWith(".svg")) return true;
    if (path.includes("favicon")) return true;
    if (TRACKING_PATTERNS.some(p => p.test(String(url || "")))) return true;
    return false;
  }

  function buildProxyUrl(raw, settings, absoluteTarget) {
    if (!settings?.enabled || !settings.proxyBase) return raw;

    const target = absoluteTarget || safeURL(raw);
    if (!target || shouldSkip(target.href, target.hostname, settings, location.hostname)) {
      return raw;
    }

    const base = String(settings.proxyBase).trim();
    if (!isValidProxyBase(base)) return raw;

    try {
      const proxy = new URL(base);
      proxy.hash = "";

      const quality = Number(settings.quality);
      const maxWidth = Number(settings.maxWidth);

      proxy.searchParams.set("url", target.href);
      proxy.searchParams.set(
        "jpeg",
        settings.isWebpSupported === true ? "0" : "1"
      );
      proxy.searchParams.set("bw", settings.grayscale === true ? "1" : "0");
      proxy.searchParams.set(
        "quality",
        Number.isInteger(quality) && quality >= 1 && quality <= 100
          ? String(quality)
          : String(DEFAULTS.quality)
      );

      if (Number.isInteger(maxWidth) && maxWidth > 0) {
        proxy.searchParams.set("max_width", String(maxWidth));
      } else {
        proxy.searchParams.delete("max_width");
      }

      return proxy.href;
    } catch {
      return raw;
    }
  }

  function normalizeOptions(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const quality = Number(source.quality);
    const maxWidth = Number(source.maxWidth);
    const proxyBase = String(source.proxyBase ?? "").trim();

    return {
      enabled:
        source.enabled === undefined ? DEFAULTS.enabled : source.enabled === true,
      proxyBase: isValidProxyBase(proxyBase) ? proxyBase : "",
      quality:
        Number.isInteger(quality) && quality >= 1 && quality <= 100
          ? quality
          : DEFAULTS.quality,
      grayscale:
        source.grayscale === undefined ? DEFAULTS.grayscale : source.grayscale === true,
      maxWidth:
        Number.isInteger(maxWidth) && maxWidth >= 0
          ? maxWidth
          : DEFAULTS.maxWidth,
      excludeDomains:
        String(source.excludeDomains ?? DEFAULTS.excludeDomains).trim(),
      isWebpSupported:
        source.isWebpSupported === undefined
          ? DEFAULTS.isWebpSupported
          : source.isWebpSupported === true,
    };
  }

  function decide(raw) {
    const original = String(raw ?? "");
    const target = safeURL(original);

    // Empty/data/blob/etc. values are intentionally passed through untouched.
    if (!target) return { hold: false, value: original };

    if (!ready) return { hold: true, value: original };
    if (!opts?.enabled || !opts.proxyBase) {
      return { hold: false, value: original };
    }

    if (shouldSkip(target.href, target.hostname, opts, location.hostname)) {
      return { hold: false, value: original };
    }

    return {
      hold: false,
      value: buildProxyUrl(original, opts, target),
    };
  }

  // A proxy failure is not necessarily an origin-image failure. Hotlink rules,
  // bot protection, expired signed URLs, or transient proxy errors can make the
  // optimized request fail even though the page can still load the original.
  // Because every URL generated by this extension contains the original URL in
  // the `url` query parameter, a failed generated image can be retried directly
  // without storing per-element state or downloading the image twice up front.
  function notifyFallbackMutation(element) {
    try {
      element.dispatchEvent(new Event(FALLBACK_EVENT));
    } catch {}
  }

  function originalUrlFromProxy(value) {
    const proxy = safeURL(value);
    if (!proxy || !looksLikeGeneratedProxy(proxy.href)) return null;
    const original = proxy.searchParams.get("url");
    return safeURL(original)?.href || null;
  }

  function restoreProxySrcset(raw) {
    const value = String(raw || "");
    if (!value) return { changed: false, value };

    let changed = false;
    const restored = value.split(",").map(part => {
      const m = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) return part;

      const original = originalUrlFromProxy(m[1]);
      if (!original) return part;

      changed = true;
      return original + (m[2] || "");
    }).join(", ");

    return { changed, value: restored };
  }

  function restoreFailedImage(img) {
    if (!(img instanceof HTMLImageElement)) return false;
    if (fallbackRetried.has(img)) return false;

    let changed = false;

    // Restore <img srcset> and any <picture><source srcset> candidates first.
    // This matters when currentSrc is the failing proxy candidate rather than
    // the image's plain `src` attribute.
    const rawImgSrcset = img.getAttribute("srcset");
    if (rawImgSrcset) {
      const restored = restoreProxySrcset(rawImgSrcset);
      if (restored.changed) {
        nativeSetSrcset(img, restored.value, false);
        notifyFallbackMutation(img);
        changed = true;
      }
    }

    const picture = img.parentElement?.tagName === "PICTURE"
      ? img.parentElement
      : null;
    if (picture) {
      for (const source of picture.querySelectorAll("source[srcset]")) {
        const raw = source.getAttribute("srcset");
        const restored = restoreProxySrcset(raw);
        if (restored.changed) {
          nativeSetSrcset(source, restored.value, true);
          notifyFallbackMutation(source);
          changed = true;
        }
      }
    }

    const rawSrc = img.getAttribute("src") || "";
    const originalSrc = originalUrlFromProxy(rawSrc) ||
      originalUrlFromProxy(img.currentSrc || "");
    if (originalSrc) {
      // Use the saved native descriptor so the MAIN-world hook cannot wrap the
      // fallback back through the proxy. The error handler removes the proxy
      // candidate, so this is a single direct retry.
      pendingSrc.delete(img);
      srcDesc.set.call(img, originalSrc);
      notifyFallbackMutation(img);
      changed = true;
    }

    if (changed) fallbackRetried.add(img);
    return changed;
  }

  function restoreFailedPreload(link) {
    if (!link || link.tagName !== "LINK") return false;
    if (fallbackRetried.has(link)) return false;

    const original = originalUrlFromProxy(link.getAttribute("href") || "");
    if (!original) return false;
    pendingLinkHref.delete(link);
    linkHrefDesc?.set?.call(link, original);
    notifyFallbackMutation(link);
    fallbackRetried.add(link);
    return true;
  }

  // Catch network failures from parser-created images too. The listener is in
  // the MAIN world and uses capture because `error` does not bubble from images.
  // If the failed resource was generated by this extension, retry that resource
  // once from its original URL. Successful proxy responses are unaffected.
  document.addEventListener("error", event => {
    const target = event.target;
    try {
      if (target instanceof HTMLImageElement) {
        restoreFailedImage(target);
      } else if (target?.tagName === "LINK") {
        restoreFailedPreload(target);
      }
    } catch {}
  }, true);


  function nativeSetSrcset(el, value, isSource) {
    const desc = isSource ? sourceSrcsetDesc : srcsetDesc;
    desc?.set?.call(el, value);
  }

  function clearAndSetNativeSrcset(el, value, isSource) {
    pendingSrcset.delete(el);
    nativeSetSrcset(el, value, isSource);
    unqueueIfIdle(el);
  }

  function nativeSetLinkHref(el, value) {
    pendingLinkHref.delete(el);
    linkHrefDesc?.set?.call(el, value);
    unqueueIfIdle(el);
  }



  function rewriteSrcset(raw) {
    const value = String(raw || "");
    if (!value) return value;
    return value.split(",").map(part => {
      const m = part.trim().match(/^(\S+)(\s+.+)?$/);
      if (!m) return part;

      const token = m[1];
      const desc = m[2] || "";
      const target = safeURL(token);
      if (!target) return part;

      if (!ready) return part;
      if (!opts?.enabled || !opts.proxyBase) return part;
      if (shouldSkip(target.href, target.hostname, opts, location.hostname)) return part;

      return buildProxyUrl(token, opts, target) + desc;
    }).join(", ");
  }


  function isImagePreload(link, relOverride, asOverride) {
    if (!link || link.tagName !== "LINK") return false;
    const rel = String(relOverride ?? link.getAttribute("rel") ?? "").toLowerCase();
    const as = String(asOverride ?? link.getAttribute("as") ?? "").toLowerCase();
    return /\bpreload\b/.test(rel) && as === "image";
  }

  function linkRawHref(link) {
    if (pendingLinkHref.has(link)) return pendingLinkHref.get(link);
    try { return link.getAttribute("href") || ""; } catch { return ""; }
  }

  function decideLinkHref(link, raw, holdIfNotReady = true) {
    const original = String(raw ?? "");
    if (!isImagePreload(link)) {
      pendingLinkHref.delete(link);
      nativeSetLinkHref(link, original);
      return;
    }

    const target = safeURL(original);
    if (!target) {
      pendingLinkHref.delete(link);
      nativeSetLinkHref(link, original);
      return;
    }

    if (!ready && holdIfNotReady) {
      pendingLinkHref.set(link, original);
      // Removing href while rel=preload/as=image keeps the browser from
      // starting a preload with the unmodified URL.
      linkHrefDesc?.set?.call(link, "");
      return;
    }

    const value =
      opts?.enabled && opts.proxyBase &&
      !shouldSkip(target.href, target.hostname, opts, location.hostname)
        ? buildProxyUrl(original, opts, target)
        : original;

    nativeSetLinkHref(link, value);
  }

  function prepareLinkActivation(link, relValue, asValue) {
    if (!isImagePreload(link, relValue, asValue)) return;

    const raw = linkRawHref(link);
    if (!raw) return;

    const target = safeURL(raw);
    if (!target) return;

    if (!ready) {
      pendingLinkHref.set(link, raw);
      linkHrefDesc?.set?.call(link, "");
      return;
    }

    const value =
      opts?.enabled && opts.proxyBase &&
      !shouldSkip(target.href, target.hostname, opts, location.hostname)
        ? buildProxyUrl(raw, opts, target)
        : raw;

    linkHrefDesc?.set?.call(link, value);
  }

  function flushPending(forcePassthrough = false) {
    const images = [];
    // WeakMaps are intentionally not iterable. Pending elements are tracked
    // through a small strong Set so they can be flushed when settings arrive.
    for (const item of pendingElements) images.push(item);

    pendingElements.clear();

    for (const el of images) {
      try {
        if (pendingSrc.has(el)) {
          const raw = pendingSrc.get(el);
          pendingSrc.delete(el);
          const target = safeURL(raw);
          if (!forcePassthrough && ready && opts?.enabled && opts.proxyBase && target &&
              !shouldSkip(target.href, target.hostname, opts, location.hostname)) {
            srcDesc.set.call(el, buildProxyUrl(raw, opts, target));
          } else {
            srcDesc.set.call(el, raw);
          }
        }

        if (pendingSrcset.has(el)) {
          const raw = pendingSrcset.get(el);
          pendingSrcset.delete(el);
          if (forcePassthrough || !ready) {
            clearAndSetNativeSrcset(el, raw, el.tagName === "SOURCE");
          } else {
            clearAndSetNativeSrcset(el, rewriteSrcset(raw), el.tagName === "SOURCE");
          }
        }

        if (pendingLinkHref.has(el)) {
          const raw = pendingLinkHref.get(el);
          pendingLinkHref.delete(el);
          if (forcePassthrough || !ready) {
            nativeSetLinkHref(el, raw);
          } else {
            decideLinkHref(el, raw, false);
          }
        }
      } catch {}
    }
  }

  // WeakMap-only state cannot be enumerated, so keep the set minimal: only
  // elements currently waiting on settings are retained here.
  const pendingElements = new Set();

  function queueElement(el) {
    pendingElements.add(el);
  }

  function unqueueIfIdle(el) {
    if (!pendingSrc.has(el) && !pendingSrcset.has(el) && !pendingLinkHref.has(el)) {
      pendingElements.delete(el);
    }
  }

  // Patch <img>.src.
  Object.defineProperty(imgProto, "src", {
    configurable: srcDesc.configurable,
    enumerable: srcDesc.enumerable,
    get() {
      if (!pendingSrc.has(this)) return srcDesc.get.call(this);
      const raw = pendingSrc.get(this);
      return safeURL(raw)?.href || raw;
    },
    set(value) {
      try {
        const raw = String(value);
        fallbackRetried.delete(this);
        const decision = decide(raw);
        if (decision.hold) {
          pendingSrc.set(this, raw);
          queueElement(this);
          // Cancel any previous native src without creating a request for the
          // document URL (src="") while the storage bridge is still pending.
          removeAttr.call(this, "src");
          return;
        }
        pendingSrc.delete(this);
        srcDesc.set.call(this, decision.value);
      } catch {
        pendingSrc.delete(this);
        srcDesc.set.call(this, value);
      }
    }
  });

  // Patch <img>.srcset.
  Object.defineProperty(imgProto, "srcset", {
    configurable: srcsetDesc.configurable,
    enumerable: srcsetDesc.enumerable,
    get() {
      return pendingSrcset.has(this)
        ? pendingSrcset.get(this)
        : srcsetDesc.get.call(this);
    },
    set(value) {
      try {
        const raw = String(value);
        fallbackRetried.delete(this);
        if (!ready) {
          pendingSrcset.set(this, raw);
          queueElement(this);
          nativeSetSrcset(this, "");
          return;
        }
        clearAndSetNativeSrcset(this, rewriteSrcset(raw), false);
      } catch {
        clearAndSetNativeSrcset(this, value, false);
      }
    }
  });

  // Patch <source>.srcset for dynamic <picture> sources.
  if (sourceProto && sourceSrcsetDesc?.set && sourceSrcsetDesc.configurable === true) {
    Object.defineProperty(sourceProto, "srcset", {
      configurable: sourceSrcsetDesc.configurable,
      enumerable: sourceSrcsetDesc.enumerable,
      get() {
        return pendingSrcset.has(this)
          ? pendingSrcset.get(this)
          : sourceSrcsetDesc.get.call(this);
      },
      set(value) {
        try {
          const raw = String(value);
          fallbackRetried.delete(this);
          if (!ready) {
            pendingSrcset.set(this, raw);
            queueElement(this);
            nativeSetSrcset(this, "", true);
            return;
          }
          pendingSrcset.delete(this);
          nativeSetSrcset(this, rewriteSrcset(raw), true);
        } catch {
          pendingSrcset.delete(this);
          nativeSetSrcset(this, value, true);
        }
      }
    });
  }

  // Patch the small attribute surface used by JS-created images, picture
  // sources and image preloads. Fast-return for unrelated attributes so normal
  // setAttribute-heavy frameworks pay only a cheap string check.
  Element.prototype.setAttribute = function(name, value) {
    const n = String(name).toLowerCase();

    if (n === "src" && this instanceof HTMLImageElement) {
      const raw = String(value);
      fallbackRetried.delete(this);
      const decision = decide(raw);
      if (decision.hold) {
        pendingSrc.set(this, raw);
        queueElement(this);
        removeAttr.call(this, "src");
        return;
      }
      pendingSrc.delete(this);
      return setAttr.call(this, "src", decision.value);
    }

    if (n === "srcset" &&
        (this instanceof HTMLImageElement ||
         (sourceProto && sourceProto.isPrototypeOf(this)))) {
      const raw = String(value);
      fallbackRetried.delete(this);
      if (!ready) {
        pendingSrcset.set(this, raw);
        queueElement(this);
        return setAttr.call(this, "srcset", "");
      }
      pendingSrcset.delete(this);
      return setAttr.call(this, "srcset", rewriteSrcset(raw));
    }

    if (n === "href" && linkProto && linkProto.isPrototypeOf(this)) {
      const raw = String(value);
      fallbackRetried.delete(this);
      if (isImagePreload(this)) {
        decideLinkHref(this, raw);
        return;
      }
      pendingLinkHref.delete(this);
      return setAttr.call(this, "href", raw);
    }

    if ((n === "rel" || n === "as") && linkProto && linkProto.isPrototypeOf(this)) {
      fallbackRetried.delete(this);
      if (n === "rel") prepareLinkActivation(this, String(value), undefined);
      else prepareLinkActivation(this, undefined, String(value));
      return setAttr.call(this, n, value);
    }

    return setAttr.call(this, name, value);
  };

  // Avoid stale queued values when page code removes an intercepted attribute.
  Element.prototype.removeAttribute = function(name) {
    const n = String(name).toLowerCase();
    if (n === "src" && this instanceof HTMLImageElement) {
      fallbackRetried.delete(this);
      pendingSrc.delete(this);
      unqueueIfIdle(this);
    } else if (n === "srcset" &&
               (this instanceof HTMLImageElement ||
                (sourceProto && sourceProto.isPrototypeOf(this)))) {
      fallbackRetried.delete(this);
      pendingSrcset.delete(this);
      unqueueIfIdle(this);
    } else if (n === "href" && linkProto && linkProto.isPrototypeOf(this)) {
      fallbackRetried.delete(this);
      pendingLinkHref.delete(this);
      unqueueIfIdle(this);
    }
    return removeAttr.call(this, name);
  };

  // Patch dynamic <link rel="preload" as="image" href="..."> property writes.
  if (linkProto && linkHrefDesc?.set && linkHrefDesc.configurable === true) {
    Object.defineProperty(linkProto, "href", {
      configurable: linkHrefDesc.configurable,
      enumerable: linkHrefDesc.enumerable,
      get() {
        if (!pendingLinkHref.has(this)) return linkHrefDesc.get.call(this);
        const raw = pendingLinkHref.get(this);
        return safeURL(raw)?.href || raw;
      },
      set(value) {
        try {
          const raw = String(value ?? "");
          fallbackRetried.delete(this);
          if (isImagePreload(this)) {
            decideLinkHref(this, raw);
          } else {
            pendingLinkHref.delete(this);
            linkHrefDesc.set.call(this, raw);
          }
        } catch {
          pendingLinkHref.delete(this);
          linkHrefDesc.set.call(this, value);
        }
      }
    });
  }

  if (linkProto && linkRelDesc?.set && linkRelDesc.configurable === true) {
    Object.defineProperty(linkProto, "rel", {
      configurable: linkRelDesc.configurable,
      enumerable: linkRelDesc.enumerable,
      get() { return linkRelDesc.get.call(this); },
      set(value) {
        try {
          fallbackRetried.delete(this);
          prepareLinkActivation(this, String(value ?? ""), undefined);
          linkRelDesc.set.call(this, value);
          if (ready && isImagePreload(this)) {
            decideLinkHref(this, linkRawHref(this), false);
          }
        } catch {
          linkRelDesc.set.call(this, value);
        }
      }
    });
  }

  if (linkProto && linkAsDesc?.set && linkAsDesc.configurable === true) {
    Object.defineProperty(linkProto, "as", {
      configurable: linkAsDesc.configurable,
      enumerable: linkAsDesc.enumerable,
      get() { return linkAsDesc.get.call(this); },
      set(value) {
        try {
          fallbackRetried.delete(this);
          prepareLinkActivation(this, undefined, String(value ?? ""));
          linkAsDesc.set.call(this, value);
          if (ready && isImagePreload(this)) {
            decideLinkHref(this, linkRawHref(this), false);
          }
        } catch {
          linkAsDesc.set.call(this, value);
        }
      }
    });
  }

  // Receive current settings from the isolated-world bridge.
  function applyOptions(raw) {
    opts = normalizeOptions(raw);
    excludedDomains = domainSet(opts.excludeDomains);
    registerProxy(opts.proxyBase);
    ready = true;

    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    flushPending(false);
  }

  window.addEventListener("message", event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.type !== "config") return;
    applyOptions(data.opts);
  }, false);

  // Request the current settings in case shared.js published them before this
  // MAIN-world listener was installed.
  try {
    window.postMessage({ channel: CHANNEL, type: "request" }, "*");
  } catch {}

  fallbackTimer = setTimeout(() => {
    if (!ready) {
      ready = true;
      opts = { ...DEFAULTS, excludeDomains: DEFAULTS.excludeDomains };
      flushPending(true);
    }
    fallbackTimer = null;
  }, SETTINGS_TIMEOUT_MS);

  // Send the request again after the page microtask queue has had a chance to
  // settle. This covers browsers that inject the two content-script worlds in
  // either order at document_start.
  Promise.resolve().then(() => {
    if (!ready) {
      try {
        window.postMessage({ channel: CHANNEL, type: "request" }, "*");
      } catch {}
    }
  });
})();

