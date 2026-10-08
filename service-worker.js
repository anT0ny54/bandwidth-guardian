// Bandwidth Guardian — service worker
// Save-Data request-header behavior adapted from Daniel Aleksandersen's
// Save-Data WebExtension (GPL-3.0). See LICENSE-GPL-3.0.
//
// ══ WHY DNR RULE 1 (image redirect) WAS REMOVED ══════════════════════════════
//
//  Chrome's DNR regexSubstitution inserts the captured URL RAW — there is no
//  way to call encodeURIComponent on it. So for any image URL that contains
//  query parameters the substitution produces a malformed proxy URL:
//
//    Original URL:  https://tvguide.com/img/photo.jpg?auto=webp&width=1092
//    DNR cannot safely encode the captured source URL for its replacement.
//
//  Image src rewriting is therefore done in the content scripts, which CAN call
//  encodeURIComponent. DNR Rule 2 (CSP header stripping) is kept.
//
// ══════════════════════════════════════════════════════════════════════════════

// Kiwi/Cromite do not support ES module service workers ("type": "module"),
// so DEFAULTS is inlined here rather than imported from defaults.js.
// KEEP IN SYNC with defaults.js, prehook.js and content.js.
const DEFAULTS = {
  enabled:         true,
  saveData:        true,
  proxyBase:       "",
  quality:         60,
  grayscale:       true,
  maxWidth:        768,
  excludeDomains:  "",
};
const sameOpts = (a, b) => !!a && !!b && Object.keys(DEFAULTS).every(k => a[k] === b[k]);

// Rule 1 is no longer added, but we still remove it on every refresh so any
// leftover rule from a previous version of the extension is cleaned up.
const RULE_ID_REDIRECT = 1;  // legacy — removed, never re-added
const RULE_ID_CSP      = 2;  // strips CSP headers so proxy images can load
const RULE_ID_SAVE_DATA = 3; // adds Save-Data: on to requests
const ALL_RULE_IDS     = [RULE_ID_REDIRECT, RULE_ID_CSP, RULE_ID_SAVE_DATA];

// ── Concurrency guard ─────────────────────────────────────────────────────────
let refreshing     = false;
let pendingRefresh = false;
let configuredProxyOrigin = "";

function setProxyOrigin(base) {
  try { configuredProxyOrigin = new URL(String(base || "").trim()).origin; } catch { configuredProxyOrigin = ""; }
}

function refreshRules() {
  if (refreshing) { pendingRefresh = true; return; }
  refreshing = true;
  doRefreshRules(function() {
    refreshing = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      refreshRules();
    }
  });
}

// ── Local settings mirror ─────────────────────────────────────────────────────
// Content scripts read from storage.local (key "bhOpts") rather than
// storage.sync. Local reads take ~5 ms vs ~30-80 ms for sync — every ms saved
// here is a window where the browser might start fetching an original image
// before prehook can intercept it. The service worker keeps bhOpts current.
function mirrorToLocal() {
  chrome.storage.sync.get(DEFAULTS, opts => {
    setProxyOrigin(opts.proxyBase);
    // Only write when different: the worker wakes often, and every write makes
    // every open tab rebuild its caches via storage.onChanged.
    chrome.storage.local.get({ bhOpts: null }, d => {
      if (!sameOpts(d.bhOpts, opts)) chrome.storage.local.set({ bhOpts: opts });
    });
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function() {
  // Top-level mirrorToLocal()/refreshRules()/updateIcon() already ran on this
  // same worker start; only seed missing sync keys here. Any resulting change
  // fires storage.onChanged, which refreshes the local mirror.
  // NOTE: get(null), not get(DEFAULTS, ...) — the latter merges defaults into
  // the result, making every key "present" and the follow-up set unconditional
  // (a redundant write + mirror/rules/icon refresh cascade on every install).
  chrome.storage.sync.get(null, function(all) {
    all = all || {};
    var missing = {};
    for (var k in DEFAULTS) if (!(k in all)) missing[k] = DEFAULTS[k];
    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  mirrorToLocal();
  if ("enabled" in changes || "saveData" in changes || "excludeDomains" in changes) refreshRules();
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
    Promise.resolve(chrome.action.setIcon({ path })).catch(() => {});
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
// Count statistics (images, received bytes, saved bytes) from the configured
// proxy's completed network response.
// bhp2 returns x-bh-compressed-size (the exact response-body size), plus the
// legacy x-compressed-size / x-original-size / x-bytes-saved headers.
function getHeaderInt(headers, name) {
  if (!Array.isArray(headers)) return null;
  const wanted = String(name).toLowerCase();
  const h = headers.find(h => String(h.name || "").toLowerCase() === wanted);
  if (!h) return null;
  const n = Number.parseInt(String(h.value || ""), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function proxyOriginMatches(url) {
  if (!configuredProxyOrigin) return false;
  try { return new URL(String(url || "")).origin === configuredProxyOrigin; }
  catch { return false; }
}

function isGuardianProxyUrl(url) {
  try {
    const u = new URL(String(url || ""));
    return proxyOriginMatches(u.href) && u.searchParams.has("url");
  } catch { return false; }
}

function getProxyResponseStats(responseHeaders) {
  const compressed = getHeaderInt(responseHeaders, "x-bh-compressed-size") ??
    getHeaderInt(responseHeaders, "x-compressed-size");
  const original = getHeaderInt(responseHeaders, "x-bh-original-size") ??
    getHeaderInt(responseHeaders, "x-original-size");
  const savedHeader = getHeaderInt(responseHeaders, "x-bh-bytes-saved") ??
    getHeaderInt(responseHeaders, "x-bytes-saved");

  let received = compressed;
  if (received === null && original !== null && savedHeader !== null) {
    received = Math.max(0, original - Math.min(savedHeader, original));
  }
  if (received === null) received = getHeaderInt(responseHeaders, "content-length") ?? 0;

  let saved = savedHeader;
  if (saved === null && original !== null) saved = Math.max(0, original - received);
  if (saved === null) saved = 0;

  return { received, saved };
}

let pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
let statsFlushTimer = null;
let statsFlushInProgress = false;

function flushStats() {
  if (statsFlushInProgress || (!pendingStats.filesProcessed && !pendingStats.bytesProcessed && !pendingStats.bytesSaved)) return;
  statsFlushInProgress = true;
  const delta = pendingStats;
  pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
  chrome.storage.local.get({ stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } }, d => {
    const s = d.stats || { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
    s.filesProcessed = Number(s.filesProcessed) || 0;
    s.bytesProcessed = Number(s.bytesProcessed) || 0;
    s.bytesSaved     = Number(s.bytesSaved) || 0;
    s.filesProcessed += delta.filesProcessed;
    s.bytesProcessed += delta.bytesProcessed;
    s.bytesSaved     += delta.bytesSaved;
    chrome.storage.local.set({ stats: s }, () => {
      statsFlushInProgress = false;
      if (pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved) scheduleStatsFlush();
    });
  });
}

function scheduleStatsFlush() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => {
    statsFlushTimer = null;
    flushStats();
  }, 750);
}

function recordStats(bytes, saved) {
  pendingStats.filesProcessed += 1;
  pendingStats.bytesProcessed += Math.max(0, Number(bytes) || 0);
  pendingStats.bytesSaved     += Math.max(0, Number(saved) || 0);
  scheduleStatsFlush();
}

// Observe completed image requests and read the response headers.
// `types: ["image"]` limits listener overhead to image responses only.
// `extraHeaders` makes the response-header event available consistently on
// Chromium implementations that gate response headers.
if (chrome.webRequest) {
  chrome.webRequest.onCompleted.addListener(
    onProxyCompleted,
    { urls: ["<all_urls>"], types: ["image"] },
    ["responseHeaders", "extraHeaders"]
  );
}

function onProxyCompleted(details) {
  const { url, responseHeaders, fromCache, statusCode } = details || {};
  if (!url || fromCache) return;
  if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) return;
  if (!configuredProxyOrigin || !isGuardianProxyUrl(url)) return;

  // A successful Guardian proxy response is one processed image. The proxy's
  // compressed-size header is authoritative for the bytes actually delivered;
  // original-minus-delivered gives the bytes saved vs. fetching directly.
  const st = getProxyResponseStats(responseHeaders);
  recordStats(st.received, st.saved);
}

// ── DNR rules ─────────────────────────────────────────────────────────────────
// Only Rule 2 (CSP stripping) is active. Rule 1 (redirect) is intentionally
// not added — see top-of-file explanation.
//
// Uses callback form throughout — the Promise-returning form of chrome APIs
// (e.g. await chrome.storage.sync.get()) is not available in classic
// (non-module) service workers on Kiwi/Cromite and causes Status code: 2.

function doRefreshRules(done) {
  chrome.storage.sync.get(DEFAULTS, function(opts) {
    var removeRuleIds = ALL_RULE_IDS;

    if (!opts.enabled && !opts.saveData) {
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeRuleIds }, done);
      return;
    }

    // Excluded sites are never proxied, so they keep their own CSP. DNR rejects the
    // whole update on an invalid domain, so only well-formed hostnames are passed.
    var excluded = String(opts.excludeDomains || "").split(/[,\s]+/)
      .map(function(s) { return s.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""); })
      .filter(function(s) { return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s); });
    var excludedDomains = Array.from(new Set(excluded));
    var addRules = [];

    // Rule 2: Strip CSP headers so proxy-domain images aren't blocked by the page.
    // CSP only matters for top-level/frame documents, so keep this rule narrow.
    if (opts.enabled) {
      var cspCondition = { resourceTypes: ["main_frame", "sub_frame"] };
      if (excludedDomains.length) cspCondition.excludedRequestDomains = excludedDomains;
      addRules.push({
        id: RULE_ID_CSP,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "content-security-policy",             operation: "remove" },
            { header: "content-security-policy-report-only", operation: "remove" }
          ]
        },
        condition: cspCondition
      });
    }

    // Save-Data: on — migrated from the original MV2 extension. DNR is used
    // because MV3 cannot use webRequestBlocking for normal extensions. No
    // resourceTypes filter is used, matching the original all-requests behavior.
    if (opts.saveData) {
      var saveDataCondition = {};
      if (excludedDomains.length) {
        // Exclude both the destination itself and subresources initiated by an
        // excluded site (for example, its CDN/image host).
        saveDataCondition.excludedRequestDomains = excludedDomains;
        saveDataCondition.excludedInitiatorDomains = excludedDomains;
      }
      addRules.push({
        id: RULE_ID_SAVE_DATA,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "save-data", operation: "set", value: "on" }
          ]
        },
        condition: saveDataCondition
      });
    }

    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeRuleIds, addRules: addRules }, done);
  });
}

