// Bandwidth Guardian — service worker (Chrome / Chromium-based browsers only)
//
// ══ INTERCEPTION ARCHITECTURE ═════════════════════════════════════════════════
//  Layer 0 (this file) — declarativeNetRequest REDIRECT.
//   Every GET request whose destination is an image (img/srcset/<picture>,
//   preload, CSS from ANY stylesheet origin, pseudo-elements, SVG <image>,
//   video poster, shadow DOM, lazy loaders, new Image(), …) is redirected to
//   the proxy inside the network stack, before DNS/connection work for the
//   original host starts. This is the only layer that can give a
//   "before the request starts" guarantee, and it is the single interception
//   point for those URLs, so nothing is proxied twice.
//
//   The original URL is appended RAW as the LAST query parameter
//   (…&url=<original>). DNR cannot percent-encode a capture group; the
//   bandwidth-hero-proxy2 contract ("unencoded legacy url") reads such a value
//   verbatim up to the first `&quality=|&l=|&bw=|&jpeg=|&max_width=`. URLs that
//   contain one of those sequences would be truncated, so a higher-priority
//   allow rule exempts them and the content-script layer proxies them with
//   an encodeURIComponent()-ed URL instead (it never touches other URLs).
//
//  Loop/duplicate guards:
//   • requests to the proxy origin are never redirected (allow rule);
//   • a failed proxy response adds a per-tab session "bypass" allow rule for
//     that original URL, then asks the page to retry it once — the retry goes
//     direct and can never reach the proxy again in that tab;
//   • repeated connection-level proxy failures trip a circuit breaker that
//     removes the redirect for a cool-down period.
//
//  DNR Rule 2 (CSP) and Rule 3 (Save-Data) are unchanged in purpose.
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
// STRICT detected image types: a proxy response is only ever accounted when its
// Content-Type is one of these (documented in README "What gets proxied").
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/jxl"]);
const ZERO_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };

const sameOpts = (a, b) => !!a && !!b && Object.keys(DEFAULTS).every(k => a[k] === b[k]);

// Rule 1 is the retired, unencoded-regex redirect; it stays in removeRuleIds so
// very old installs lose it (O9). Rule 2 strips CSP; Rule 3 adds Save-Data.
const RULE_ID_CSP             = 2;
const RULE_ID_SAVE_DATA       = 3;
const RULE_ID_REDIRECT_IMAGE  = 10;  // resourceType "image"
const RULE_ID_REDIRECT_OBJECT = 11;  // <object>/<embed> with an image extension
const RULE_ID_ALLOW_PROXY     = 20;  // never redirect the proxy itself (loop guard)
const RULE_ID_ALLOW_SKIP      = 21;  // favicon / .ico / .svg
const RULE_ID_ALLOW_CONFLICT  = 22;  // URLs the raw proxy contract would truncate
const RULE_ID_ALLOW_PRIVATE   = 23;  // 23–25: localhost / private-network / single-label hosts

// Priorities: modifyHeaders rules sit above every allow rule so Save-Data and
// CSP handling still apply to exempted/bypassed requests.
const PRIORITY_REDIRECT = 1;
const PRIORITY_EXEMPT   = 2;
const PRIORITY_PROXY    = 3;
const PRIORITY_BYPASS   = 4;   // session rules (per-tab fallback)
const PRIORITY_HEADERS  = 10;

// KEEP IN SYNC with SKIP_URL_RE in prehook.js / content.js.
const SKIP_PATTERN = "favicon|\\.(?:ico|svg)(?:[?#]|$)";
// KEEP IN SYNC with CONFLICT_RE in prehook.js / content.js and with
// PROXY_PARAMETER in bandwidth-hero-proxy2 functions/index.js.
const CONFLICT_PATTERN = "&(?:quality|l|bw|jpeg|max_width)=";
// Hosts a public proxy cannot (and must not) reach: bandwidth-hero-proxy2
// rejects them with 403, so redirecting them would only add a failed round
// trip and leak intranet URLs. localhost, *.localhost, *.local, single-label
// names (http://nas/), IPv4 loopback/RFC 1918/link-local, IPv6 loopback/ULA/
// link-local literals.
const PRIVATE_HOST_PATTERNS = [
  // Split in three: one combined regex exceeds the 2KB RE2 memory limit.
  "^https?://(?:localhost|[^/?#:]*\\.localhost|[^/?#:]*\\.local|[^/?#:.\\[]+)(?::[0-9]+)?(?:[/?#]|$)",
  "^https?://(?:127|10|192\\.168|172\\.(?:1[6-9]|2[0-9]|3[01])|169\\.254)\\.[0-9.]+(?::[0-9]+)?(?:[/?#]|$)",
  "^https?://\\[(?:::1|f[cd][0-9a-f]*:[0-9a-f:]*|fe80:[0-9a-f:%.a-z]*)\\](?::[0-9]+)?(?:[/?#]|$)"
];
// <object>/<embed> are only redirected when the URL clearly names one of the
// strictly supported raster types — documents/plugins must never be proxied.
const OBJECT_IMAGE_PATTERN = "^https?://[^?#]*\\.(?:jpe?g|png|webp|gif|tiff?|jxl)(?:[?#]|$)";

const ALL_RULE_IDS = [1, RULE_ID_CSP, RULE_ID_SAVE_DATA, RULE_ID_REDIRECT_IMAGE,
  RULE_ID_REDIRECT_OBJECT, RULE_ID_ALLOW_PROXY, RULE_ID_ALLOW_SKIP, RULE_ID_ALLOW_CONFLICT,
  ...PRIVATE_HOST_PATTERNS.map((_, i) => RULE_ID_ALLOW_PRIVATE + i)];

// ── Concurrency guard ─────────────────────────────────────────────────────────
let refreshing     = false;
let pendingRefresh = false;
let configuredProxyOrigin = "";

// Same validation as the DNR rules (http/https only): an "ftp://" or
// "javascript:" value must never yield an origin ("null") that would make
// the webRequest filter registration throw.
function setProxyOrigin(base) {
  const usable = usableProxyBase(base);
  configuredProxyOrigin = usable ? new URL(usable).origin : "";
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

// The keys below are the only ones the worker consumes: mirroring on any
// other sync change (popup-only keys, future keys) would trigger a full
// re-read and rule refresh for nothing.
const MANAGED_KEYS = ["enabled", "saveData", "excludeDomains", "proxyBase", "quality", "grayscale", "maxWidth"];
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (!MANAGED_KEYS.some(k => k in changes)) return;
  mirrorToLocal();
  // B1: proxyBase gates the CSP rule, so rule refresh must trigger on it too.
  // The redirect rule embeds quality/grayscale/maxWidth, so those refresh too.
  refreshRules();
  if ("enabled" in changes) updateIcon();
});

mirrorToLocal();
refreshRules();
updateIcon();

// ── Extension icon ────────────────────────────────────────────────────────────
const ICONS_ON  = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };
const ICONS_OFF = { 16: "icons/icon-16-disabled.png", 32: "icons/icon-32-disabled.png", 48: "icons/icon-48-disabled.png", 128: "icons/icon-128-disabled.png" };
function updateIcon() {
  chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, d => {
    if (!chrome.action || typeof chrome.action.setIcon !== "function") return;
    try {
      const maybePromise = chrome.action.setIcon({ path: d.enabled ? ICONS_ON : ICONS_OFF });
      if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
    } catch {}
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────
// Lower-cased name -> value, built once per response (the stats path used to
// rescan the whole header array for each of its seven lookups).
function headerMap(headers) {
  const map = new Map();
  if (Array.isArray(headers)) {
    for (const h of headers) {
      const name = String(h?.name || "").toLowerCase();
      if (name && !map.has(name)) map.set(name, String(h.value ?? ""));
    }
  }
  return map;
}
function headerInt(map, name) {
  const v = map.get(name);
  if (v === undefined) return null;
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

function getProxyResponseStats(headers) {
  const compressed = headerInt(headers, "x-bh-compressed-size") ??
    headerInt(headers, "x-compressed-size");
  const original = headerInt(headers, "x-bh-original-size") ??
    headerInt(headers, "x-original-size");
  const savedHeader = headerInt(headers, "x-bh-bytes-saved") ??
    headerInt(headers, "x-bytes-saved");

  let received = compressed;
  let known = received !== null;
  if (!known && original !== null && savedHeader !== null) {
    received = Math.max(0, original - Math.min(savedHeader, original));
    known = true;
  }
  // Note: without "extraHeaders", Chromium may withhold Content-Length on
  // responses; the proxy's x-bh-compressed-size header is authoritative.
  if (!known) received = headerInt(headers, "content-length") ?? 0;

  let saved = savedHeader;
  if (saved === null) saved = known && original !== null ? Math.max(0, original - received) : 0;
  return { received, saved };
}

let pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
let statsFlushTimer = null;
let statsFlushInProgress = false;
let statsMirrorTimer = null;
let statsMirrorWriteInProgress = false;
let statsStartupWriteInProgress = true; // startup recovery's first storage read/write
let statsResetPending = false;
let statsResetInProgress = false;
const statsResetResponders = [];

const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);

function finishStatsResetIfReady() {
  if (!statsResetPending || statsFlushInProgress || statsMirrorWriteInProgress ||
      statsStartupWriteInProgress || statsResetInProgress) return;
  statsResetPending = false;
  statsResetInProgress = true;
  const finish = () => {
    const ok = !chrome.runtime.lastError;
    statsResetInProgress = false;
    // Serialize concurrent reset requests: finish the newest reset before
    // acknowledging any waiter or allowing new counter writes to flush.
    if (statsResetPending) {
      finishStatsResetIfReady();
      return;
    }
    for (const respond of statsResetResponders.splice(0)) {
      try { respond({ ok }); } catch {}
    }
    // Images that completed after the reset request count as new activity.
    if (hasPendingStats()) {
      mirrorPendingStats();
      scheduleStatsFlush();
    }
  };
  try {
    chrome.storage.local.set({ stats: { ...ZERO_STATS }, statsPending: { ...ZERO_STATS } }, finish);
  } catch {
    statsResetInProgress = false;
    if (statsResetPending) {
      finishStatsResetIfReady();
      return;
    }
    for (const respond of statsResetResponders.splice(0)) {
      try { respond({ ok: false }); } catch {}
    }
  }
}

function resetStatsCounters(sendResponse) {
  pendingStats = { ...ZERO_STATS };
  if (statsFlushTimer) { clearTimeout(statsFlushTimer); statsFlushTimer = null; }
  if (statsMirrorTimer) { clearTimeout(statsMirrorTimer); statsMirrorTimer = null; }
  if (typeof sendResponse === "function") statsResetResponders.push(sendResponse);
  statsResetPending = true;
  finishStatsResetIfReady();
}

function flushStats() {
  if (statsResetPending || statsResetInProgress) return;
  // Startup recovery and ordinary flushes must not race each other's read/modify/write.
  if (statsStartupWriteInProgress) return;
  if (statsFlushInProgress) { scheduleStatsFlush(); return; }
  if (!hasPendingStats()) return;
  statsFlushInProgress = true;
  const delta = pendingStats;
  pendingStats = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
  chrome.storage.local.get({ stats: ZERO_STATS }, d => {
    // A reset requested during the read wins over this stale delta.
    if (statsResetPending || statsResetInProgress) {
      statsFlushInProgress = false;
      finishStatsResetIfReady();
      return;
    }
    const s = d.stats || { ...ZERO_STATS };
    s.filesProcessed += delta.filesProcessed;
    s.bytesProcessed += delta.bytesProcessed;
    s.bytesSaved     += delta.bytesSaved;
    // B8: commit stats and clear the crash mirror in ONE atomic write — a
    // worker kill between two writes can no longer strand the delta.
    chrome.storage.local.set({ stats: s, statsPending: { ...ZERO_STATS } }, () => {
      statsFlushInProgress = false;
      if (statsResetPending) {
        finishStatsResetIfReady();
      } else if (hasPendingStats()) {
        scheduleStatsFlush();
      }
    });
  });
}

function scheduleStatsFlush() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => { statsFlushTimer = null; flushStats(); }, 750);
}

function mirrorPendingStats() {
  if (statsMirrorTimer || statsMirrorWriteInProgress || statsStartupWriteInProgress ||
      statsResetPending || statsResetInProgress) return;
  statsMirrorTimer = setTimeout(() => {
    statsMirrorTimer = null;
    if (!hasPendingStats() || statsResetPending || statsResetInProgress) return;
    statsMirrorWriteInProgress = true;
    const snapshot = { ...pendingStats };
    try {
      chrome.storage.local.set({ statsPending: snapshot }, () => {
        statsMirrorWriteInProgress = false;
        if (statsResetPending) finishStatsResetIfReady();
        else if (hasPendingStats()) mirrorPendingStats();
      });
    } catch {
      statsMirrorWriteInProgress = false;
      if (statsResetPending) finishStatsResetIfReady();
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

// Startup recovery: merge a stranded crash mirror into stats atomically.
// Mirror writes and ordinary flushes pause until recovery completes, so an
// in-flight recovery cannot overwrite newer pending activity.
let statsRevision = 0;
const startupStatsRevision = statsRevision;
function finishStatsStartup() {
  statsStartupWriteInProgress = false;
  if (statsResetPending) {
    finishStatsResetIfReady();
    return;
  }
  if (hasPendingStats()) {
    mirrorPendingStats();
    scheduleStatsFlush();
  }
}
chrome.storage.local.get({ stats: ZERO_STATS, statsPending: null }, d => {
  if (startupStatsRevision !== statsRevision) {
    finishStatsStartup();
    return;
  }
  const p = d.statsPending;
  if (!p) {
    finishStatsStartup();
    return;
  }
  const files = Number(p.filesProcessed) || 0;
  const bytes = Math.max(0, Number(p.bytesProcessed) || 0);
  const saved = Math.max(0, Number(p.bytesSaved) || 0);
  if (!files && !bytes && !saved) {
    try {
      chrome.storage.local.remove("statsPending", finishStatsStartup);
    } catch {
      finishStatsStartup();
    }
    return;
  }
  const s = d.stats || { ...ZERO_STATS };
  s.filesProcessed += files;
  s.bytesProcessed += bytes;
  s.bytesSaved     += saved;
  try {
    chrome.storage.local.set({ stats: s, statsPending: { ...ZERO_STATS } }, finishStatsStartup);
  } catch {
    finishStatsStartup();
  }
});

// Observe proxy responses, narrowed to the configured proxy origin (O3) and
// re-registered whenever proxyBase changes. onCompleted feeds statistics and
// fallback; onErrorOccurred feeds fallback and the circuit breaker.
// "extraHeaders" is not needed for custom x-bh-* headers (B10).
let webRequestRegistered = false;
let webRequestOrigin = null; // origin the current registration targets
const PROXY_REQUEST_TYPES = ["image", "object"];
function updateWebRequestListener(origin) {
  if (!chrome.webRequest || typeof chrome.webRequest.onCompleted !== "object") return;
  // Every settings change (quality, grayscale, …) calls this through
  // mirrorToLocal(); re-registering is only needed when the origin changed.
  if (webRequestRegistered && origin === webRequestOrigin) return;
  try {
    if (webRequestRegistered) {
      chrome.webRequest.onCompleted.removeListener(onProxyCompleted);
      chrome.webRequest.onErrorOccurred?.removeListener(onProxyError);
    }
  } catch {}
  const urls = origin ? [origin + "/*"] : ["https://bandwidth-guardian.invalid/*"]; // never matches
  try {
    chrome.webRequest.onCompleted.addListener(
      onProxyCompleted,
      { urls: urls, types: PROXY_REQUEST_TYPES },
      ["responseHeaders"]
    );
    chrome.webRequest.onErrorOccurred?.addListener(onProxyError, { urls: urls, types: PROXY_REQUEST_TYPES });
    webRequestRegistered = true;
    webRequestOrigin = origin;
  } catch { webRequestRegistered = false; }
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
  if (details && details.error) { handleProxyError(details); return; } // queued error event
  const { url, responseHeaders, fromCache, statusCode } = details || {};
  if (!url || !isGuardianProxyUrl(url)) return;

  const headers = headerMap(responseHeaders);
  const contentType = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const ok = typeof statusCode !== "number" || (statusCode >= 200 && statusCode < 300);

  if (!ok) {
    // 503 (Sharp unavailable), 429 and Cloudflare-style 52x mean the proxy as
    // a whole is unhealthy; other statuses are specific to this image.
    if (statusCode === 503 || statusCode === 429 || (statusCode >= 520 && statusCode <= 530)) noteGlobalProxyFailure();
    scheduleFallback(details);
    return;
  }
  // A 2xx that is not an image at all (HTML error page, handshake text, …)
  // cannot render; fall back. image/* types outside the strict list (AVIF
  // passthrough, etc.) still render, they are just not counted below.
  if (contentType && !contentType.startsWith("image/")) { scheduleFallback(details); return; }
  noteProxySuccess();
  if (fromCache) return;

  // STRICT detected image types only: count the response only when its actual
  // Content-Type is one of the supported image types.
  if (!IMAGE_CONTENT_TYPES.has(contentType)) return;

  const st = getProxyResponseStats(headers);
  recordStats(st.received, st.saved);
}

// Network errors that say nothing about the proxy: the page cancelled the
// request (navigation, element removed), or another extension/policy blocked it.
const IGNORED_NET_ERRORS = new Set([
  "net::ERR_ABORTED", "net::ERR_BLOCKED_BY_CLIENT", "net::ERR_BLOCKED_BY_ADMINISTRATOR",
  "net::ERR_BLOCKED_BY_RESPONSE", "net::ERR_BLOCKED_BY_ORB", "net::ERR_CACHE_MISS",
  "net::ERR_NETWORK_CHANGED"
]);
function onProxyError(details) {
  if (!configuredProxyOrigin) {
    if (earlyStatsEvents.length < 500) earlyStatsEvents.push(details);
    return;
  }
  handleProxyError(details);
}
function handleProxyError(details) {
  const { url, error } = details || {};
  if (!url || !isGuardianProxyUrl(url) || IGNORED_NET_ERRORS.has(error)) return;
  noteGlobalProxyFailure();
  scheduleFallback(details);
}

// ── Original URL recovery (mirror of bandwidth-hero-proxy2 getImageUrl) ───────
const PROXY_PARAMETER_RE = new RegExp(CONFLICT_PATTERN);
function originalFromProxyUrl(proxyUrl) {
  let u;
  try { u = new URL(proxyUrl); } catch { return null; }
  if (u.origin !== configuredProxyOrigin) return null;
  const raw = u.search.replace(/^\?/, "");
  const m = /(?:^|&)url=/.exec(raw);
  if (!m) return null;
  let value = raw.slice(m.index + m[0].length);
  if (/^https?:\/\//i.test(value)) {
    const end = value.search(PROXY_PARAMETER_RE);
    if (end >= 0) value = value.slice(0, end);
  } else {
    const end = value.indexOf("&");
    if (end >= 0) value = value.slice(0, end);
    try { value = decodeURIComponent(value.replace(/\+/g, " ")); } catch { return null; }
  }
  try {
    const orig = new URL(value);
    if (!/^https?:$/.test(orig.protocol)) return null;
    orig.hash = "";
    return orig.href;
  } catch { return null; }
}

// ── Per-tab bypass (fallback) ─────────────────────────────────────────────────
// A failed proxy response installs a session-scoped allow rule for exactly
// that original URL in that tab, then the page is asked to retry the URL once.
// Because the retry can no longer be redirected, a proxy loop is impossible:
// at most one proxied attempt and one direct attempt per URL per tab.
const BYPASS_BASE_ID = 100000;
const BYPASS_LIMIT   = 3000;    // well under DNR's session-rule cap
// Chrome allows at most 1000 regex rules per session ruleset. Keep headroom
// for other rules and avoid rejecting an entire batch after a burst of failures.
const BYPASS_REGEX_LIMIT = 900;
const bypassRules    = new Map(); // "tabId url" -> ruleId (insertion order = age)
const bypassRegexRules = new Set(); // keys whose exact URL uses regexFilter
let bypassNextId     = BYPASS_BASE_ID;
let bypassChain      = null;    // serializes updateSessionRules calls

function bypassReady() {
  if (bypassChain) return bypassChain;
  bypassChain = (async () => {
    try {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      for (const r of rules) {
        if (r.id < BYPASS_BASE_ID) continue;
        const url = bypassUrlFromRule(r);
        if (!url) continue;
        const tab = r.condition?.tabIds?.[0] ?? -1;
        const key = tab + " " + url;
        bypassRules.set(key, r.id);
        if (r.condition?.regexFilter) bypassRegexRules.add(key);
        bypassNextId = Math.max(bypassNextId, r.id + 1);
      }
    } catch {}
  })();
  return bypassChain;
}

// Browser request URLs are ASCII after URL canonicalization. Most URLs can use
// urlFilter's exact start/end anchors; URLs containing its wildcard or separator
// metacharacters need a literal-escaped regex instead.
const BYPASSABLE_URL_RE = /^https?:\/\/[\x21-\x7e]+$/;
const MAX_BYPASS_REGEX_LENGTH = 1900;
function bypassCondition(url) {
  if (!/[|*^]/.test(url)) return { urlFilter: "|" + url + "|" };
  const regexFilter = "^" + url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
  if (regexFilter.length > MAX_BYPASS_REGEX_LENGTH) return null;
  return { regexFilter, isUrlFilterCaseSensitive: true };
}

// Reconstruct original URLs from persisted session rules after a worker wake.
// Regex filters are generated only by bypassCondition and contain escaped
// literal URLs bounded by ^ and $, so consuming one escape at a time is safe.
function bypassUrlFromRule(rule) {
  const filter = rule?.condition?.urlFilter;
  if (typeof filter === "string") return filter.replace(/^\||\|$/g, "");
  const regex = rule?.condition?.regexFilter;
  if (typeof regex !== "string" || regex.length < 2 || regex[0] !== "^" || regex[regex.length - 1] !== "$") return "";
  const body = regex.slice(1, -1);
  let url = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) url += body[++i];
    else url += body[i];
  }
  return url;
}

function addBypass(tabId, urls) {
  const tab = Number.isInteger(tabId) && tabId >= 0 ? tabId : -1;
  const operation = bypassReady().then(async () => {
    const addRules = [];
    const addedKeys = new Map();
    const alreadyPresent = new Set();
    let regexesToAdd = 0;
    for (const url of urls) {
      if (!BYPASSABLE_URL_RE.test(url)) continue;
      const key = tab + " " + url;
      if (bypassRules.has(key)) { alreadyPresent.add(url); continue; }
      if (addedKeys.has(key) || addRules.length >= BYPASS_LIMIT) continue;
      const baseCondition = bypassCondition(url);
      if (!baseCondition) continue;
      if (baseCondition.regexFilter && bypassRegexRules.size + regexesToAdd >= BYPASS_REGEX_LIMIT) continue;
      const id = bypassNextId++;
      const condition = { ...baseCondition, resourceTypes: PROXY_REQUEST_TYPES };
      if (tab >= 0) condition.tabIds = [tab];
      addRules.push({ id, priority: PRIORITY_BYPASS, action: { type: "allow" }, condition });
      addedKeys.set(key, { id, url, isRegex: !!baseCondition.regexFilter });
      if (baseCondition.regexFilter) regexesToAdd++;
    }
    if (!addRules.length) return Array.from(alreadyPresent);

    // Compute evictions without mutating the live map. Commit the map only after
    // Chrome confirms the rule update, and never evict a newly added rule here.
    const removeRuleIds = [];
    const nextRules = new Map(bypassRules);
    const nextRegexRules = new Set(bypassRegexRules);
    const existingToKeep = Math.max(0, BYPASS_LIMIT - addRules.length);
    while (nextRules.size > existingToKeep) {
      const [oldKey, oldId] = nextRules.entries().next().value;
      nextRules.delete(oldKey);
      nextRegexRules.delete(oldKey);
      removeRuleIds.push(oldId);
    }
    for (const [key, { id, isRegex }] of addedKeys) {
      nextRules.set(key, id);
      if (isRegex) nextRegexRules.add(key);
    }

    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    } catch {
      // Failed updates leave the old rules intact; don't tell the page to retry
      // unless a direct-load bypass rule is known to exist.
      return Array.from(alreadyPresent);
    }
    bypassRules.clear();
    for (const entry of nextRules) bypassRules.set(...entry);
    bypassRegexRules.clear();
    for (const key of nextRegexRules) bypassRegexRules.add(key);
    const bypassed = Array.from(alreadyPresent).filter(url => nextRules.has(tab + " " + url));
    for (const [key, item] of addedKeys) {
      if (nextRules.has(key) && nextRules.get(key) === item.id) bypassed.push(item.url);
    }
    return bypassed;
  });
  // A rejected link would wedge every later bypassReady() caller; the chain
  // only serializes, results flow through `operation`.
  bypassChain = operation.catch(() => {});
  return operation;
}

// Drop a closed tab's bypass rules (they can never match again).
chrome.tabs?.onRemoved?.addListener(tabId => {
  bypassChain = bypassReady().then(async () => {
    const keys = [];
    const removeRuleIds = [];
    for (const [key, id] of bypassRules) {
      if (key.startsWith(tabId + " ")) {
        keys.push(key);
        removeRuleIds.push(id);
      }
    }
    if (!removeRuleIds.length) return;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds });
    } catch {
      return; // Keep the in-memory index aligned with rules Chrome still owns.
    }
    for (const key of keys) {
      bypassRules.delete(key);
      bypassRegexRules.delete(key);
    }
  }).catch(() => {});
});

// Content scripts ask for this tab's known-bad originals at page start, so the
// DOM layer does not send them to the proxy again after a reload.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "bh-reset-stats") {
    statsRevision++;
    resetStatsCounters(sendResponse);
    return true;
  }
  if (msg.type !== "bh-failed-list") return;
  const prefix = (sender?.tab?.id ?? -1) + " ";
  bypassReady().then(() => {
    const urls = [];
    for (const k of bypassRules.keys()) if (k.startsWith(prefix)) urls.push(k.slice(prefix.length));
    sendResponse({ urls: urls.slice(-1000) });
  });
  return true;
});

// Failures are batched per frame so an image-heavy page sends one message.
const fallbackSeen  = new Set();  // "tabId url": a URL is retried once per tab
const fallbackBatch = new Map();  // "tabId:frameId" -> { tabId, frameId, items: Map(original -> proxyUrl) }
let fallbackTimer   = null;

function scheduleFallback(details) {
  const original = originalFromProxyUrl(details.url);
  if (!original) return;
  const tabId = typeof details.tabId === "number" ? details.tabId : -1;
  const key = tabId + " " + original;
  if (fallbackSeen.has(key)) return;
  fallbackSeen.add(key);
  if (fallbackSeen.size > 20000) fallbackSeen.delete(fallbackSeen.values().next().value);
  const frameId = typeof details.frameId === "number" ? details.frameId : 0;
  const bk = tabId + ":" + frameId;
  if (!fallbackBatch.has(bk)) fallbackBatch.set(bk, { tabId, frameId, items: new Map() });
  fallbackBatch.get(bk).items.set(original, details.url);
  // 250 ms lets the renderer finish the failed response first; a CSS rule
  // re-inserted while the failed load is still settling can reuse it.
  if (!fallbackTimer) fallbackTimer = setTimeout(flushFallbacks, 250);
}

function flushFallbacks() {
  fallbackTimer = null;
  const batches = Array.from(fallbackBatch.values());
  fallbackBatch.clear();
  for (const b of batches) {
    const originals = Array.from(b.items.keys());
    addBypass(b.tabId, originals).then(bypassed => {
      if (b.tabId < 0 || !chrome.tabs?.sendMessage || !bypassed?.length) return;
      const allowed = new Set(bypassed);
      const items = Array.from(b.items, ([original, proxyUrl]) => ({ original, proxyUrl }))
        .filter(item => allowed.has(item.original));
      if (!items.length) return;
      try {
        const p = chrome.tabs.sendMessage(b.tabId, { type: "bh-retry", items }, { frameId: b.frameId });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {}
    }).catch(() => {});
  }
}

// ── Circuit breaker ───────────────────────────────────────────────────────────
// Connection-level failures (proxy down, DNS failure, 503) are counted; a
// success resets the count. BREAKER_THRESHOLD failures within BREAKER_WINDOW_MS
// remove the redirect for BREAKER_COOLDOWN_MS so the web keeps working.
// The suspension lives in storage.session, so a browser restart clears it.
const BREAKER_THRESHOLD   = 6;
const BREAKER_WINDOW_MS   = 30000;
const BREAKER_COOLDOWN_MS = 120000;
const BREAKER_ALARM       = "bh-breaker-resume";
let breakerFailures = [];

function noteProxySuccess() { breakerFailures = []; }
function noteGlobalProxyFailure() {
  const now = Date.now();
  breakerFailures = breakerFailures.filter(t => now - t < BREAKER_WINDOW_MS);
  breakerFailures.push(now);
  if (breakerFailures.length < BREAKER_THRESHOLD) return;
  breakerFailures = [];
  const until = now + BREAKER_COOLDOWN_MS;
  const done = () => refreshRules();
  try { chrome.storage.session.set({ bhSuspendedUntil: until }, done); } catch { done(); }
  try { chrome.alarms?.create(BREAKER_ALARM, { when: until + 50 }); } catch {}
}
chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm.name !== BREAKER_ALARM) return;
  try { chrome.storage.session.remove("bhSuspendedUntil", () => refreshRules()); } catch { refreshRules(); }
});

function readSuspended(cb) {
  try {
    chrome.storage.session.get({ bhSuspendedUntil: 0 }, d => cb(Number(d?.bhSuspendedUntil) > Date.now()));
  } catch { cb(false); }
}

// ── DNR rules ─────────────────────────────────────────────────────────────────
function parseExcluded(text) {
  // DNR rejects the whole update on an invalid domain — pass only valid hosts.
  var excluded = String(text || "").split(/[,\s]+/)
    .map(function(s) { return s.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""); })
    .filter(function(s) { return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s); });
  return Array.from(new Set(excluded));
}

// Returns the validated proxy base (no fragment) or "" when unusable.
function usableProxyBase(proxyBase) {
  try {
    const u = new URL(String(proxyBase || "").trim());
    if (!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    return u.href;
  } catch { return ""; }
}

// Raw-URL redirect target. The proxy parameters come FIRST and url= LAST, so
// the proxy reads the original URL verbatim to the end of the query string.
// Exported shape (KEEP IN SYNC with tests): base[?|&]jpeg=0&bw=N&quality=N[&max_width=N]&url=\0
function redirectSubstitution(opts, base) {
  const quality = Math.max(1, Math.min(100, Number(opts.quality ?? 60) || 60));
  const maxWidth = Number(opts.maxWidth) || 0;
  const parts = ["jpeg=0", "bw=" + (opts.grayscale ? "1" : "0"), "quality=" + quality];
  if (maxWidth > 0) parts.push("max_width=" + maxWidth);
  // In regexSubstitution "\" introduces a group reference; escape literals.
  const safeBase = base.replace(/\\/g, "\\\\");
  return safeBase + (base.includes("?") ? "&" : "?") + parts.join("&") + "&url=\\0";
}

function buildRules(opts, noHeaderMatch, suspended) {
  var excludedDomains = parseExcluded(opts.excludeDomains);
  var addRules = [];
  var base = usableProxyBase(opts.proxyBase);
  var proxyOk = !!base;

  // B1: CSP is stripped only when the proxy is configured AND Chrome accepts
  // response-header matching. Never fall back to removing CSP from every
  // document: if this condition is unsupported, preserving page policy is safer
  // than silently weakening script/connect/frame restrictions. Report-only CSP
  // is left alone (R15): it blocks nothing. CSP also applies to redirect targets.
  if (opts.enabled && proxyOk && !noHeaderMatch && !suspended) {
    // DNR HeaderInfo.values uses case-insensitive wildcard patterns, not regex.
    // The key is `header` (HeaderInfo), not `name`.
    var cspCondition = {
      resourceTypes: ["main_frame", "sub_frame"],
      responseHeaders: [{ header: "content-security-policy", values: ["*img-src*", "*default-src*"] }]
    };
    if (excludedDomains.length) cspCondition.excludedRequestDomains = excludedDomains;
    addRules.push({
      id: RULE_ID_CSP,
      priority: PRIORITY_HEADERS,
      action: { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "remove" }] },
      condition: cspCondition
    });
  }

  if (opts.enabled && proxyOk && !suspended) {
    var proxyOrigin = new URL(base).origin;
    var substitution = redirectSubstitution(opts, base);
    var redirectCondition = function(regexFilter, resourceTypes) {
      var c = { regexFilter: regexFilter, resourceTypes: resourceTypes, requestMethods: ["get"] };
      if (excludedDomains.length) {
        c.excludedRequestDomains = excludedDomains;   // excluded image hosts
        c.excludedInitiatorDomains = excludedDomains; // excluded pages / frames
      }
      return c;
    };
    addRules.push({
      id: RULE_ID_REDIRECT_IMAGE, priority: PRIORITY_REDIRECT,
      action: { type: "redirect", redirect: { regexSubstitution: substitution } },
      condition: redirectCondition("^https?://.+", ["image"])
    });
    addRules.push({
      id: RULE_ID_REDIRECT_OBJECT, priority: PRIORITY_REDIRECT,
      action: { type: "redirect", redirect: { regexSubstitution: substitution } },
      condition: Object.assign(redirectCondition(OBJECT_IMAGE_PATTERN, ["object"]), { isUrlFilterCaseSensitive: false })
    });
    // Loop guard: anything already addressed to the proxy is left alone.
    addRules.push({
      id: RULE_ID_ALLOW_PROXY, priority: PRIORITY_PROXY, action: { type: "allow" },
      condition: { urlFilter: "|" + proxyOrigin + "/", resourceTypes: PROXY_REQUEST_TYPES }
    });
    addRules.push({
      id: RULE_ID_ALLOW_SKIP, priority: PRIORITY_EXEMPT, action: { type: "allow" },
      condition: { regexFilter: SKIP_PATTERN, isUrlFilterCaseSensitive: false, resourceTypes: PROXY_REQUEST_TYPES }
    });
    addRules.push({
      id: RULE_ID_ALLOW_CONFLICT, priority: PRIORITY_EXEMPT, action: { type: "allow" },
      condition: { regexFilter: CONFLICT_PATTERN, isUrlFilterCaseSensitive: true, resourceTypes: PROXY_REQUEST_TYPES }
    });
    PRIVATE_HOST_PATTERNS.forEach(function(p, i) {
      addRules.push({
        id: RULE_ID_ALLOW_PRIVATE + i, priority: PRIORITY_EXEMPT, action: { type: "allow" },
        condition: { regexFilter: p, isUrlFilterCaseSensitive: false, resourceTypes: PROXY_REQUEST_TYPES }
      });
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
      priority: PRIORITY_HEADERS,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "save-data", operation: "set", value: "on" }] },
      condition: saveDataCondition
    });
  }
  return addRules;
}

// Content scripts read bhRuntime to learn whether the network redirect is
// live. While it is, they proxy ONLY CONFLICT_PATTERN URLs (no duplicates);
// if it is not (rule rejected), they fall back to full DOM rewriting; while
// the breaker is open they proxy nothing.
let lastRuntime = null;
function publishRuntime(runtime) {
  const same = lastRuntime && lastRuntime.redirect === runtime.redirect && lastRuntime.suspended === runtime.suspended;
  if (same) return;
  lastRuntime = runtime;
  chrome.storage.local.get({ bhRuntime: null }, d => {
    const cur = d.bhRuntime;
    if (cur && cur.redirect === runtime.redirect && cur.suspended === runtime.suspended) return;
    chrome.storage.local.set({ bhRuntime: runtime });
  });
}

function doRefreshRules(done) {
  const finish = () => { if (typeof done === "function") done(); };
  if (!chrome.declarativeNetRequest || typeof chrome.declarativeNetRequest.updateDynamicRules !== "function") {
    finish();
    return;
  }
  // updateDynamicRules can fail asynchronously (lastError) OR throw
  // synchronously on a schema error; both paths must release the lock.
  const update = (addRules, cb) => {
    try {
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_RULE_IDS, addRules }, () => cb(chrome.runtime.lastError || null));
    } catch (e) { cb(e); }
  };
  chrome.storage.sync.get(DEFAULTS, function(opts) {
    readSuspended(function(suspended) {
      // The published runtime reflects exactly the rule set Chrome accepted.
      const installed = addRules => {
        publishRuntime({ redirect: addRules.some(r => r.id === RULE_ID_REDIRECT_IMAGE), suspended });
        finish();
      };
      const full = buildRules(opts, false, suspended);
      update(full, function(err) {
        if (!err) { installed(full); return; }
        // Retry without response-header matching (older Chromium), then with
        // the header rules only, so Save-Data/CSP survive a redirect problem.
        const noHeaderMatch = buildRules(opts, true, suspended);
        update(noHeaderMatch, function(err2) {
          if (!err2) { installed(noHeaderMatch); return; }
          const headersOnly = buildRules(opts, true, true);
          update(headersOnly, function() { installed(headersOnly); });
        });
      });
    });
  });
}
