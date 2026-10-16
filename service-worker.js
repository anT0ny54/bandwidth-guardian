// Bandwidth Guardian — service worker
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
//  encodeURIComponent. DNR rule 2 (CSP) and rule 3 (Save-Data) remain.
//
// ══════════════════════════════════════════════════════════════════════════════

// Kiwi/Cromite do not support ES module service workers ("type": "module"),
// so shared code is loaded with importScripts from the classic shared.js.
importScripts("shared.js");
const BH = self.__bhShared;
const { DEFAULTS, sameOpts } = BH;

const RULE_ID_CSP       = 2; // removes page CSP so proxy-host images can load
const RULE_ID_SAVE_DATA = 3; // sends "Save-Data: on"
const ALL_RULE_IDS      = [RULE_ID_CSP, RULE_ID_SAVE_DATA];

// Every DNR resource type the Save-Data header is useful for, listed
// explicitly: with no resourceTypes, DNR matches everything EXCEPT
// main_frame, so page navigations — where servers most often honor
// Save-Data — would never get it. All types exist in Chrome 111+.
const SAVE_DATA_RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other",
];

// ── Concurrency guard ─────────────────────────────────────────────────────────
let refreshing     = false;
let pendingRefresh = false;

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

// ── Proxy origin (for statistics) ─────────────────────────────────────────────
let configuredProxyOrigin = "";
let originLoaded = false;
// webRequest events that arrive before the origin is known. The event that
// wakes a terminated worker is delivered before any storage read completes;
// it used to be dropped, losing a stat on almost every wake.
const earlyEvents = [];
const EARLY_EVENT_LIMIT = 200;

function setProxyOrigin(base) {
  configuredProxyOrigin = BH.normalizeProxyConfig({ ...DEFAULTS, proxyBase: base }).origin;
}

function loadProxyOrigin() {
  const done = base => {
    setProxyOrigin(base);
    originLoaded = true;
    const queued = earlyEvents.splice(0);
    for (const details of queued) onProxyCompleted(details);
  };
  // Mirror first (fast): content scripts read it at startup. chrome.storage.sync
  // is authoritative — the mirror can go stale on builds where storage.onChanged
  // does not reliably wake the MV3 worker (v0.1.7 read sync directly, which is why
  // it kept working). Reconcile with sync and rewrite the mirror so it self-heals.
  chrome.storage.local.get({ bhOpts: null }, d => {
    if (d && d.bhOpts) done(d.bhOpts.proxyBase);
    chrome.storage.sync.get(DEFAULTS, s => {
      if (!d || !d.bhOpts || !sameOpts(d.bhOpts, s)) {
        chrome.storage.local.set({ bhOpts: s });
        if (!d || !d.bhOpts || d.bhOpts.proxyBase !== s.proxyBase) done(s.proxyBase);
      }
    });
  });
}

// ── Local settings mirror ─────────────────────────────────────────────────────
// Content scripts read from storage.local (key "bhOpts") rather than
// storage.sync. Local reads take ~5 ms vs ~30-80 ms for sync — every ms saved
// here is a window where the browser might start fetching an original image
// before prehook can intercept it. The worker, popup and options page keep
// bhOpts current; content scripts never write it on changes.
function mirrorToLocal() {
  chrome.storage.sync.get(DEFAULTS, opts => {
    setProxyOrigin(opts.proxyBase);
    originLoaded = true;
    // Only write when different: every write makes every open tab rebuild its
    // caches via storage.onChanged.
    chrome.storage.local.get({ bhOpts: null }, d => {
      if (!sameOpts(d.bhOpts, opts)) chrome.storage.local.set({ bhOpts: opts });
    });
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
// Dynamic DNR rules persist across worker restarts and browser sessions, so
// rules, icon and mirror are refreshed only when something can have changed:
// install/update, browser startup (the action icon does not persist), and
// settings changes. The worker wakes for every image request (see the
// webRequest note below), so nothing heavy runs at top level.

function refreshAll() {
  mirrorToLocal();
  refreshRules();
  updateIcon();
}

chrome.runtime.onInstalled.addListener(function() {
  // get(null), not get(DEFAULTS, ...) — the latter merges defaults into the
  // result, making every key "present" and the follow-up set unconditional.
  chrome.storage.sync.get(null, function(all) {
    all = all || {};
    var missing = {};
    for (var k in DEFAULTS) if (!(k in all)) missing[k] = DEFAULTS[k];
    if (Object.keys(missing).length) chrome.storage.sync.set(missing, refreshAll);
    else refreshAll(); // updates: rule logic may have changed
  });
});

if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(refreshAll);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  mirrorToLocal();
  if ("enabled" in changes || "saveData" in changes || "excludeDomains" in changes || "proxyBase" in changes) refreshRules();
  if ("enabled" in changes) updateIcon();
});

loadProxyOrigin();

// ── Extension icon ────────────────────────────────────────────────────────────
function updateIcon() {
  chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, d => {
    if (!chrome.action || typeof chrome.action.setIcon !== "function") return;
    const on = d.enabled;
    const path = on
      ? { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" }
      : { 16: "icons/icon-16-disabled.png", 32: "icons/icon-32-disabled.png", 48: "icons/icon-48-disabled.png", 128: "icons/icon-128-disabled.png" };
    try {
      const maybePromise = chrome.action.setIcon({ path });
      if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
    } catch {}
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

function isGuardianProxyUrl(url) {
  try { return new URL(url).searchParams.has("url"); } catch { return false; }
}

// Returns null when the response carries no proxy size headers at all: that
// is not a proxied image (e.g. the proxy URL points at a site root and
// Netlify answered with index.html), so it must not be counted.
function getProxyResponseStats(responseHeaders) {
  const compressed = getHeaderInt(responseHeaders, "x-bh-compressed-size") ??
    getHeaderInt(responseHeaders, "x-compressed-size");
  const original = getHeaderInt(responseHeaders, "x-bh-original-size") ??
    getHeaderInt(responseHeaders, "x-original-size");
  const savedHeader = getHeaderInt(responseHeaders, "x-bh-bytes-saved") ??
    getHeaderInt(responseHeaders, "x-bytes-saved");
  if (compressed === null && original === null && savedHeader === null) return null;

  let received = compressed;
  // `known` tracks whether `received` is an actual measurement, so a missing
  // compressed size never reports the whole original as saved.
  let known = received !== null;
  if (!known && original !== null && savedHeader !== null) {
    received = Math.max(0, original - Math.min(savedHeader, original));
    known = true;
  }
  if (!known) received = getHeaderInt(responseHeaders, "content-length") ?? 0;

  let saved = savedHeader;
  if (saved === null) saved = known && original !== null ? Math.max(0, original - received) : 0;

  return { received, saved };
}

// Stats are batched in memory and committed every 750 ms. An idle MV3 worker
// lives ~30 s, so the timer always fires first; the old per-image
// statsPending crash-recovery write (one storage write per image) is gone.
let pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
let statsFlushTimer = null;
let statsFlushInProgress = false;
const hasPending = () => pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved;

function flushStats() {
  if (statsFlushInProgress || !hasPending()) return;
  statsFlushInProgress = true;
  const delta = pendingStats;
  pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
  chrome.storage.local.get({ stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } }, d => {
    const s = d.stats || {};
    const next = {
      filesProcessed: (Number(s.filesProcessed) || 0) + delta.filesProcessed,
      bytesProcessed: (Number(s.bytesProcessed) || 0) + delta.bytesProcessed,
      bytesSaved:     (Number(s.bytesSaved) || 0) + delta.bytesSaved,
    };
    chrome.storage.local.set({ stats: next }, () => {
      statsFlushInProgress = false;
      if (hasPending()) scheduleStatsFlush();
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

// One-time migration: fold any statsPending scratch value left by 0.1.7.
chrome.storage.local.get({ statsPending: null }, d => {
  const p = d && d.statsPending;
  if (!p) return;
  try { chrome.storage.local.remove("statsPending"); } catch {}
  pendingStats.filesProcessed += Number(p.filesProcessed) || 0;
  pendingStats.bytesProcessed += Math.max(0, Number(p.bytesProcessed) || 0);
  pendingStats.bytesSaved     += Math.max(0, Number(p.bytesSaved) || 0);
  scheduleStatsFlush();
});

// Observe completed image requests and read the response headers.
// The filter must stay <all_urls>: MV3 only wakes a terminated worker for
// listeners registered synchronously at top level, and the proxy origin is
// only known after an async storage read. A listener re-registered later
// with a narrower filter would not wake the worker, and stats would be lost.
// The handler therefore rejects non-proxy URLs with one string comparison.
// `extraHeaders` makes response headers available consistently on Chromium.
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
  if (!originLoaded) {
    if (earlyEvents.length < EARLY_EVENT_LIMIT) earlyEvents.push({ url, responseHeaders, fromCache, statusCode });
    return;
  }
  if (!configuredProxyOrigin || !url.startsWith(configuredProxyOrigin + "/")) return;
  if (!isGuardianProxyUrl(url)) return;

  // A successful Guardian proxy response is one processed image. The proxy's
  // compressed-size header is authoritative for the bytes actually delivered;
  // original-minus-delivered gives the bytes saved vs. fetching directly.
  const st = getProxyResponseStats(responseHeaders);
  if (st) recordStats(st.received, st.saved);
}

// ── DNR rules ─────────────────────────────────────────────────────────────────
// Uses callback form throughout — the Promise-returning form of chrome APIs
// (e.g. await chrome.storage.sync.get()) is not available in classic
// (non-module) service workers on Kiwi/Cromite and causes Status code: 2.

function doRefreshRules(done) {
  // Cromite/Kiwi-class Chromium builds can lag desktop API surface. DNR is the
  // only optional dependency here; image URL encoding happens in content/prehook.
  if (!chrome.declarativeNetRequest || typeof chrome.declarativeNetRequest.updateDynamicRules !== "function") {
    if (typeof done === "function") done();
    return;
  }
  chrome.storage.sync.get(DEFAULTS, function(opts) {
    const proxyActive = BH.normalizeProxyConfig(opts).active;
    // DNR rejects the whole update on an invalid domain, so only well-formed
    // hostnames are passed.
    const excludedDomains = Array.from(new Set(BH.parseDomainList(opts.excludeDomains).filter(BH.isValidHostname)));
    const addRules = [];

    // Rule 2: remove the page CSP so proxy-host images are not blocked by
    // img-src. Only while images are actually being proxied (enabled AND a
    // valid proxy URL) — a fresh install or "Reset defaults" has no proxy and
    // must not weaken every site's CSP. Excluded sites keep their CSP. The
    // report-only header is left alone: it never blocks anything.
    if (proxyActive) {
      const cspCondition = { resourceTypes: ["main_frame", "sub_frame"] };
      if (excludedDomains.length) cspCondition.excludedRequestDomains = excludedDomains;
      addRules.push({
        id: RULE_ID_CSP,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [{ header: "content-security-policy", operation: "remove" }],
        },
        condition: cspCondition,
      });
    }

    // Rule 3: send "Save-Data: on" with every request type, including page
    // navigations. Requests to excluded sites, and requests those sites
    // initiate (their CDNs/image hosts), are left untouched.
    if (opts.saveData) {
      const saveDataCondition = { resourceTypes: SAVE_DATA_RESOURCE_TYPES };
      if (excludedDomains.length) {
        saveDataCondition.excludedRequestDomains = excludedDomains;
        saveDataCondition.excludedInitiatorDomains = excludedDomains;
      }
      addRules.push({
        id: RULE_ID_SAVE_DATA,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [{ header: "save-data", operation: "set", value: "on" }],
        },
        condition: saveDataCondition,
      });
    }

    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_RULE_IDS, addRules }, done);
  });
}
