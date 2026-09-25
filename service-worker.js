// Bandwidth Guardian — service worker
//
// ══ WHY DNR RULE 1 (image redirect) WAS REMOVED ══════════════════════════════
//
//  Chrome's DNR regexSubstitution inserts the captured URL RAW — there is no
//  way to call encodeURIComponent on it. So for any image URL that contains
//  query parameters the substitution produces a malformed proxy URL:
//
//    Original URL:  https://tvguide.com/img/photo.jpg?auto=webp&width=1092
//    DNR produces:  https://proxy.com?url=https://tvguide.com/img/photo.jpg?auto=webp&width=1092&jpeg=1
//                                                                            ^^^^ starts a NEW query param
//
//  The proxy receives url= truncated at the first unencoded &, so it fetches
//  the wrong URL. This causes silent failures on sites like tvguide.com where
//  every image URL has query params.
//
//  The original MV2 extension used webRequest.onBeforeRequest + encodeURIComponent
//  which has no this limitation. MV3 removed webRequestBlocking.
//
//  Fix: image src rewriting is now done entirely in content scripts (content.js
//  and prehook.js) which CAN call encodeURIComponent. This is the only correct
//  approach in MV3.
//
//  DNR Rule 2 (CSP header stripping) is kept — it does not need URL encoding.
//
// ══════════════════════════════════════════════════════════════════════════════

// Kiwi/Cromite compatibility: keep the service worker classic (non-module),
// so this small defaults copy remains local to the worker.
const DEFAULTS = {
  enabled:         true,
  proxyBase:       "",
  quality:         40,
  grayscale:       true,
  maxWidth:        1280,
  excludeDomains:  "google.com gstatic.com challenges.cloudflare.com",
  isWebpSupported: false,
  directFallback:  false,
};

function isValidProxyBase(value) {
  try {
    const u = new URL(String(value || "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeOptions(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const quality = Number(d.quality);
  const maxWidth = Number(d.maxWidth);
  const proxyBase = String(d.proxyBase ?? "").trim();

  return {
    enabled:         d.enabled === undefined ? DEFAULTS.enabled : d.enabled === true,
    proxyBase:       isValidProxyBase(proxyBase) ? proxyBase : "",
    quality:         Number.isInteger(quality) && quality >= 1 && quality <= 100
                       ? quality : DEFAULTS.quality,
    grayscale:       d.grayscale === undefined ? DEFAULTS.grayscale : d.grayscale === true,
    maxWidth:        Number.isInteger(maxWidth) && maxWidth >= 0
                       ? maxWidth : DEFAULTS.maxWidth,
    excludeDomains:  String(d.excludeDomains ?? DEFAULTS.excludeDomains).trim(),
    isWebpSupported:
      d.isWebpSupported === undefined
        ? DEFAULTS.isWebpSupported
        : d.isWebpSupported === true,
    directFallback:
      d.directFallback === undefined
        ? DEFAULTS.directFallback
        : d.directFallback === true,
  };
}

function parseExcludedDomains(text) {
  return Array.from(new Set(
    String(text || "").split(/[,\s]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
      .map(s => s.replace(/^https?:\/\//, "").split("/")[0])
      .map(s => s.replace(/^\*?\./, "").replace(/\.$/, ""))
      .filter(Boolean)
  ));
}

// Rule 1 is no longer added, but we still remove it on every refresh so any
// leftover rule from a previous version of the extension is cleaned up.
const RULE_ID_REDIRECT = 1;  // legacy — removed, never re-added
const RULE_ID_CSP      = 2;  // strips CSP headers so proxy images can load
const ALL_RULE_IDS     = [RULE_ID_REDIRECT, RULE_ID_CSP];

// ── Concurrency guard ─────────────────────────────────────────────────────────
// doRefreshRules() is async (chrome.storage.sync.get's callback fires on a
// later tick), so a flag that's set true then immediately set back to false
// around a bare call to it — the previous approach — guards nothing: the
// flag is already false again before the callback that matters ever runs.
// Two overlapping refreshRules() calls (e.g. onInstalled and a storage
// change firing close together) could then race their updateDynamicRules()
// calls. Chaining onto one promise instead genuinely serializes every call,
// each one's storage read finishing before the next one starts.
let refreshChain = Promise.resolve();
function refreshRules() {
  refreshChain = refreshChain.then(doRefreshRules, doRefreshRules);
  return refreshChain;
}

// ── WebP detection ────────────────────────────────────────────────────────────
// Uses a callback so no async/await is needed at the call site.
function checkWebpSupport(callback) {
  if (!self.createImageBitmap) { callback(false); return; }
  try {
    var webpData = "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
    fetch(webpData)
      .then(function(r) { return r.blob(); })
      .then(function(blob) { return self.createImageBitmap(blob); })
      .then(function() { callback(true); })
      .catch(function() { callback(false); });
  } catch(e) { callback(false); }
}

// ── Local settings mirror ─────────────────────────────────────────────────────
// Content scripts read from storage.local (key "bhOpts") rather than
// storage.sync. Local reads take ~5 ms vs ~30-80 ms for sync — every ms saved
// here is a window where the browser might start fetching an original image
// before prehook can intercept it. The service worker keeps bhOpts current.
function mirrorToLocal() {
  chrome.storage.sync.get(DEFAULTS, opts => {
    chrome.storage.local.set({ bhOpts: normalizeOptions(opts) }, () => {});
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function() {
  chrome.storage.sync.get(DEFAULTS, function(d) {
    chrome.storage.sync.set(normalizeOptions(d));
  });
  chrome.storage.local.get(
    { stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } },
    function(d) { chrome.storage.local.set(d); }
  );
  checkWebpSupport(function(isWebpSupported) {
    chrome.storage.sync.set({ isWebpSupported: isWebpSupported });
    mirrorToLocal();
    refreshRules();
    updateIcon();
  });
});

chrome.runtime.onStartup.addListener(function() {
  checkWebpSupport(function(isWebpSupported) {
    chrome.storage.sync.set({ isWebpSupported: isWebpSupported });
    mirrorToLocal();
    refreshRules();
    updateIcon();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  mirrorToLocal();
  refreshRules();
  if ("enabled" in changes) updateIcon();
});

mirrorToLocal();
refreshRules();
updateIcon();

// ── Extension icon ────────────────────────────────────────────────────────────
function updateIcon() {
  chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, d => {
    const on = d.enabled;
    const path = on
      ? { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" }
      : { 16: "icons/icon-16-disabled.png", 32: "icons/icon-32-disabled.png", 48: "icons/icon-48-disabled.png", 128: "icons/icon-128-disabled.png" };
    // chrome.action.setIcon() returns a Promise on modern Chrome, but some
    // Chromium forks (older Kiwi/Cromite builds) only support the
    // callback-style API and return undefined — calling .catch on that
    // would throw. Guard properly instead of chaining blindly.
    try {
      const p = chrome.action.setIcon({ path });
      if (p && typeof p.then === "function") p.catch(() => {});
    } catch (e) { /* ignore — icon update is best-effort */ }
  });
}

// ── Stats via webRequest response headers ─────────────────────────────────────
// Reads x-bytes-saved and x-original-size from proxy responses.
// Non-blocking — only observes, never delays requests.
function getHeaderInt(headers, name) {
  if (!Array.isArray(headers)) return false;
  const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  if (!h) return false;
  const n = parseInt(h.value, 10);
  return isNaN(n) ? false : n;
}

if (chrome.webRequest && !chrome.webRequest.onCompleted.hasListener(onProxyCompleted)) {
  chrome.webRequest.onCompleted.addListener(
    onProxyCompleted,
    { urls: ["<all_urls>"], types: ["image"] },
    ["responseHeaders"]
  );
}

let statsWriteBusy = false;
let pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };

function flushStats() {
  if (statsWriteBusy || pendingStats.filesProcessed === 0) return;
  statsWriteBusy = true;

  const delta = pendingStats;
  pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };

  // Batch completions that arrive while storage is busy. This both prevents
  // read-modify-write races and reduces local-storage writes on image-heavy pages.
  chrome.storage.local.get(
    { stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } },
    function(d) {
      const s = d.stats || { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
      s.filesProcessed += delta.filesProcessed;
      s.bytesProcessed += delta.bytesProcessed;
      s.bytesSaved     += delta.bytesSaved;
      chrome.storage.local.set({ stats: s }, function() {
        statsWriteBusy = false;
        flushStats();
      });
    }
  );
}

function onProxyCompleted({ responseHeaders, fromCache }) {
  if (fromCache) return;
  const bytesSaved    = getHeaderInt(responseHeaders, "x-bytes-saved");
  const bytesOriginal = getHeaderInt(responseHeaders, "x-original-size");
  if (bytesSaved === false || bytesOriginal === false) return;

  pendingStats.filesProcessed += 1;
  pendingStats.bytesProcessed += bytesOriginal;
  pendingStats.bytesSaved     += bytesSaved;
  flushStats();
}


// ── DNR rules ─────────────────────────────────────────────────────────────────
// Only Rule 2 (CSP stripping) is active. Rule 1 (redirect) is intentionally
// not added — see top-of-file explanation.
//
// Uses callback form throughout — the Promise-returning form of chrome APIs
// (e.g. await chrome.storage.sync.get()) is not available in classic
// (non-module) service workers on Kiwi/Cromite and causes Status code: 2.

function doRefreshRules() {
  return new Promise(function(resolve) {
    chrome.storage.sync.get(DEFAULTS, function(raw) {
      var opts = normalizeOptions(raw);
      var removeRuleIds = ALL_RULE_IDS;

      if (!opts.enabled || !opts.proxyBase) {
        chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeRuleIds }, resolve);
        return;
      }

      // Rule 2: Strip CSP headers so proxy-domain images aren't blocked by the page.
      var condition = { resourceTypes: ["main_frame", "sub_frame"] };
      var excludedInitiatorDomains = parseExcludedDomains(opts.excludeDomains);
      if (excludedInitiatorDomains.length) {
        condition.excludedInitiatorDomains = excludedInitiatorDomains;
      }

      var addRules = [{
        id: RULE_ID_CSP,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "content-security-policy",             operation: "remove" },
            { header: "content-security-policy-report-only", operation: "remove" }
          ]
        },
        condition: condition
      }];

      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeRuleIds, addRules: addRules }, resolve);
    });
  });
}
