// Bandwidth Guardian — service worker (Chrome / Chromium-based browsers only)
//
// Save-Data is injected with a DNR modifyHeaders rule — the MV3 replacement
// for webRequestBlocking. This implementation is original to this project.
//
// ══ WHY DNR RULE 1 (image redirect) WAS REMOVED ══════════════════════════════
//  Chrome's DNR regexSubstitution inserts the captured URL RAW — there is no
//  way to call encodeURIComponent on it, so any image URL with query params
//  produces a malformed proxy URL. Image src rewriting is done in the content
//  scripts instead. DNR Rule 2 (CSP) and Rule 3 (Save-Data) remain.
// ══════════════════════════════════════════════════════════════════════════════

// KEEP IN SYNC with defaults.js.
const DEFAULTS = {
  enabled:         true,
  saveData:        true,
  proxyBase:       "",
  quality:         60,
  grayscale:       true,
  maxWidth:        768,
  excludeDomains:  "",
};
// STRICT detected image types (KEEP IN SYNC with defaults.js).
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/jxl"]);
const ZERO_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };

const sameOpts = (a, b) => !!a && !!b && Object.keys(DEFAULTS).every(k => a[k] === b[k]);

// Rule 1 is retired but kept in removeRuleIds so very old installs lose the
// legacy redirect rule (O9). Rule 2 strips CSP; Rule 3 adds Save-Data.
const RULE_ID_CSP       = 2;
const RULE_ID_SAVE_DATA = 3;
const ALL_RULE_IDS      = [1, RULE_ID_CSP, RULE_ID_SAVE_DATA];

// ── Concurrency guard ─────────────────────────────────────────────────────────
let refreshing     = false;
let pendingRefresh = false;
let configuredProxyOrigin = "";

function setProxyOrigin(base) {
  try { configuredProxyOrigin = new URL(String(base || "").trim()).origin; }
  catch { configuredProxyOrigin = ""; }
}

function refreshRules() {
  if (refreshing) { pendingRefresh = true; return; }
  refreshing = true;
  doRefreshRules(function() {
    refreshing = false;
    if (pendingRefresh) { pendingRefresh = false; refreshRules(); }
  });
}

// ── Local settings mirror ─────────────────────────────────────────────────────
// The service worker is the SOLE writer of the bhOpts mirror (B4): every
// content script writing it on each sync change produced O(tabs × frames)
// write/event storms and could clobber the mirror with stale partial state.
function mirrorToLocal() {
  chrome.storage.sync.get(DEFAULTS, opts => {
    setProxyOrigin(opts.proxyBase);
    // B9: stats events that arrived before the origin was known are queued.
    if (configuredProxyOrigin && earlyStatsEvents.length) {
      const queued = earlyStatsEvents.splice(0);
      queued.forEach(handleProxyCompleted);
    }
    updateWebRequestListener(configuredProxyOrigin);
    // Only write when different: every write makes every open tab rebuild
    // its caches via storage.onChanged.
    chrome.storage.local.get({ bhOpts: null }, d => {
      if (!sameOpts(d.bhOpts, opts)) chrome.storage.local.set({ bhOpts: opts });
    });
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(function() {
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
  // B1: proxyBase gates the CSP rule, so rule refresh must trigger on it too.
  if ("enabled" in changes || "saveData" in changes || "excludeDomains" in changes || "proxyBase" in changes) refreshRules();
  if ("enabled" in changes) updateIcon();
});

mirrorToLocal();
refreshRules();
updateIcon();

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
function getHeaderValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const wanted = String(name).toLowerCase();
  const h = headers.find(x => String(x.name || "").toLowerCase() === wanted);
  return h ? String(h.value ?? "") : null;
}
function getHeaderInt(headers, name) {
  const v = getHeaderValue(headers, name);
  if (v === null) return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isGuardianProxyUrl(url) {
  if (!configuredProxyOrigin) return false;
  try {
    const u = new URL(String(url || ""));
    return u.origin === configuredProxyOrigin && u.searchParams.has("url"); // R9: parse once
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
  let known = received !== null;
  if (!known && original !== null && savedHeader !== null) {
    received = Math.max(0, original - Math.min(savedHeader, original));
    known = true;
  }
  // Note: without "extraHeaders", Chromium may withhold Content-Length on
  // responses; the proxy's x-bh-compressed-size header is authoritative.
  if (!known) received = getHeaderInt(responseHeaders, "content-length") ?? 0;

  let saved = savedHeader;
  if (saved === null) saved = known && original !== null ? Math.max(0, original - received) : 0;
  return { received, saved };
}

let pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
let statsFlushTimer = null;
let statsFlushInProgress = false;
let statsMirrorTimer = null;

function flushStats() {
  if (statsFlushInProgress) { scheduleStatsFlush(); return; }
  if (!pendingStats.filesProcessed && !pendingStats.bytesProcessed && !pendingStats.bytesSaved) return;
  statsFlushInProgress = true;
  const delta = pendingStats;
  pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
  chrome.storage.local.get({ stats: ZERO_STATS }, d => {
    const s = d.stats || ZERO_STATS;
    s.filesProcessed += delta.filesProcessed;
    s.bytesProcessed += delta.bytesProcessed;
    s.bytesSaved     += delta.bytesSaved;
    // B8: commit stats and clear the crash mirror in ONE atomic write — a
    // worker kill between two writes can no longer strand the delta.
    chrome.storage.local.set({ stats: s, statsPending: ZERO_STATS }, () => {
      statsFlushInProgress = false;
      if (pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved) scheduleStatsFlush();
    });
  });
}

function scheduleStatsFlush() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => { statsFlushTimer = null; flushStats(); }, 750);
}

function mirrorPendingStats() {
  if (statsMirrorTimer) return; // O2: crash mirror is throttled to ≤1 write/sec
  statsMirrorTimer = setTimeout(() => {
    statsMirrorTimer = null;
    if (pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved) {
      try { chrome.storage.local.set({ statsPending: pendingStats }); } catch {}
    }
  }, 1000);
}

function recordStats(bytes, saved) {
  pendingStats.filesProcessed += 1;
  pendingStats.bytesProcessed += Math.max(0, Number(bytes) || 0);
  pendingStats.bytesSaved     += Math.max(0, Number(saved) || 0);
  mirrorPendingStats(); // #6: MV3 workers can be killed before flushStats runs
  scheduleStatsFlush();
}

// Startup recovery: merge a stranded crash mirror into stats atomically. The
// single get of both keys avoids deleting a newer mirror written between the
// read and the remove (B8 related race).
chrome.storage.local.get({ stats: ZERO_STATS, statsPending: null }, d => {
  const p = d.statsPending;
  if (!p) return;
  const files = Number(p.filesProcessed) || 0;
  const bytes = Math.max(0, Number(p.bytesProcessed) || 0);
  const saved = Math.max(0, Number(p.bytesSaved) || 0);
  if (!files && !bytes && !saved) { try { chrome.storage.local.remove("statsPending"); } catch {}; return; }
  const s = d.stats || ZERO_STATS;
  s.filesProcessed += files;
  s.bytesProcessed += bytes;
  s.bytesSaved     += saved;
  chrome.storage.local.set({ stats: s, statsPending: ZERO_STATS }, () => {
    // If recordStats() ran while we were reading, re-mirror the fresh delta.
    if (pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved) mirrorPendingStats();
  });
});

// Observe completed image responses, narrowed to the configured proxy origin
// (O3) and re-registered whenever proxyBase changes. "extraHeaders" is dropped:
// custom x-bh-* headers don't need it, and Firefox (which rejects it) is no
// longer a target (B10).
let webRequestRegistered = false;
function updateWebRequestListener(origin) {
  if (!chrome.webRequest || typeof chrome.webRequest.onCompleted !== "object") return;
  try {
    if (webRequestRegistered) chrome.webRequest.onCompleted.removeListener(onProxyCompleted);
  } catch {}
  const urls = origin ? [origin + "/*"] : ["https://bandwidth-guardian.invalid/*"]; // never matches
  try {
    chrome.webRequest.onCompleted.addListener(
      onProxyCompleted,
      { urls: urls, types: ["image"] },
      ["responseHeaders"]
    );
    webRequestRegistered = true;
  } catch {}
}
updateWebRequestListener("");

// B9: events can wake the worker before the async origin lookup finishes.
const earlyStatsEvents = [];
function onProxyCompleted(details) {
  if (!configuredProxyOrigin) {
    if (earlyStatsEvents.length < 500) earlyStatsEvents.push(details);
    return;
  }
  handleProxyCompleted(details);
}

function handleProxyCompleted(details) {
  const { url, responseHeaders, fromCache, statusCode } = details || {};
  if (!url || fromCache) return;
  if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) return;
  if (!isGuardianProxyUrl(url)) return;

  // STRICT detected image types only: count the response only when its actual
  // Content-Type is one of the supported image types.
  const contentType = (getHeaderValue(responseHeaders, "content-type") || "")
    .split(";")[0].trim().toLowerCase();
  if (!IMAGE_CONTENT_TYPES.has(contentType)) return;

  const st = getProxyResponseStats(responseHeaders);
  recordStats(st.received, st.saved);
}

// ── DNR rules ─────────────────────────────────────────────────────────────────
function buildRules(opts, noHeaderMatch) {
  // DNR rejects the whole update on an invalid domain — pass only valid hosts.
  var excluded = String(opts.excludeDomains || "").split(/[,\s]+/)
    .map(function(s) { return s.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""); })
    .filter(function(s) { return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s); });
  var excludedDomains = Array.from(new Set(excluded));
  var addRules = [];

  // B1: CSP is stripped ONLY when a usable proxy is configured. Chrome 128+
  // DNR response-header matching narrows the rule to documents whose CSP
  // actually contains img-src/default-src (falls back to the broad rule on
  // older Chromium). Report-only CSP is left alone (R15): it blocks nothing.
  var proxyOk = false;
  try { proxyOk = /^https?:$/.test(new URL(String(opts.proxyBase || "").trim()).protocol); } catch (e) { proxyOk = false; }
  if (opts.enabled && proxyOk) {
    var cspCondition = { resourceTypes: ["main_frame", "sub_frame"] };
    if (!noHeaderMatch) {
      cspCondition.responseHeaders = [{ name: "content-security-policy", values: ["/img-src/i", "/default-src/i"] }];
    }
    if (excludedDomains.length) cspCondition.excludedRequestDomains = excludedDomains;
    addRules.push({
      id: RULE_ID_CSP,
      priority: 1,
      action: { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "remove" }] },
      condition: cspCondition
    });
  }

  if (opts.saveData) {
    var saveDataCondition = {};
    if (excludedDomains.length) {
      saveDataCondition.excludedRequestDomains = excludedDomains;
      saveDataCondition.excludedInitiatorDomains = excludedDomains;
    }
    addRules.push({
      id: RULE_ID_SAVE_DATA,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "save-data", operation: "set", value: "on" }] },
      condition: saveDataCondition
    });
  }
  return addRules;
}

function doRefreshRules(done) {
  if (!chrome.declarativeNetRequest || typeof chrome.declarativeNetRequest.updateDynamicRules !== "function") {
    if (typeof done === "function") done();
    return;
  }
  chrome.storage.sync.get(DEFAULTS, function(opts) {
    var addRules = buildRules(opts, false);
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_RULE_IDS, addRules: addRules }, function() {
      if (chrome.runtime.lastError && addRules.some(function(r) { return r.condition && r.condition.responseHeaders; })) {
        addRules = buildRules(opts, true); // retry without response-header matching
        chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_RULE_IDS, addRules: addRules }, done);
        return;
      }
      if (typeof done === "function") done();
    });
  });
}
