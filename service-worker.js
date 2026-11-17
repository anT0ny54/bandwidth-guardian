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

// Shared frozen defaults for every extension context. Relative to this service
// worker script, so no chrome.runtime.getURL() is needed during startup.
importScripts("defaults.js");
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
  "^https?://\\[(?:::1|f[cd][0-9a-f]*:[0-9a-f:]*|fe[89ab][0-9a-f]:[0-9a-f:%.a-z]*|::ffff:(?:7f[0-9a-f]{2}|a[0-9a-f]{2}|c0a8|ac1[0-9a-f]|a9fe):[0-9a-f]{1,4})\\](?::[0-9]+)?(?:[/?#]|$)"
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
// Invalidates local-mirror observer restores when a newer sync snapshot wins.
let proxyObserverRevision = 0;
let proxyObserverReady = false;
let restoringProxyObserver = false;

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

// ── Settings storage recovery ──────────────────────────────────────────────────
// A failed sync read must not be mistaken for missing settings: doing so could
// replace the local mirror with defaults and remove a working redirect rule.
// Chrome alarms provide a bounded retry after transient storage failures.
const SETTINGS_READ_RETRY_ALARM = "bh-settings-read-retry";
const SETTINGS_READ_RETRY_DELAY_MS = 30000; // Chrome's minimum alarm interval
function scheduleSettingsReadRetry() {
  try {
    const created = chrome.alarms?.create(SETTINGS_READ_RETRY_ALARM, {
      when: Date.now() + SETTINGS_READ_RETRY_DELAY_MS
    });
    if (created && typeof created.catch === "function") created.catch(() => {});
  } catch {}
}

// ── Local settings mirror ─────────────────────────────────────────────────────
// The service worker is the SOLE writer of the bhOpts mirror (B4): every
// content script writing it on each sync change produced O(tabs × frames)
// write/event storms and could clobber the mirror with stale partial state.
// Sync callbacks can complete out of order. Keep only the newest snapshot, and
// serialize local writes so an older in-flight write cannot finish last.
let mirrorReadRevision = 0;
let mirrorRevision = 0;
let mirrorWriteInFlight = false;
let pendingMirrorWrite = null;
function mirrorToLocal() {
  // A newer read request supersedes older reads, but a failed read must not
  // cancel a previously confirmed snapshot that is still waiting to mirror.
  const readRevision = ++mirrorReadRevision;
  const onSyncSettings = opts => {
    if (readRevision !== mirrorReadRevision) return;
    if (chrome.runtime?.lastError || !opts || typeof opts !== "object") {
      scheduleSettingsReadRetry();
      // Keep response/error handling alive across a transient sync-storage
      // failure. The local mirror is the last settings snapshot that the worker
      // successfully published, and DNR rules are deliberately left untouched.
      restoreProxyObserverFromLocalMirror();
      return;
    }
    const revision = ++mirrorRevision;
    // Once a trusted settings snapshot has configured the observer, a later
    // transient sync read failure must not restore an older local mirror over it.
    proxyObserverReady = true;
    // A successful sync snapshot supersedes any older local-mirror recovery read.
    proxyObserverRevision++;
    setProxyOrigin(opts.proxyBase);
    // Without an origin the queued early events can never match (they are only
    // replayed once an origin exists); drop them so the queue cannot hold
    // stale entries for the worker's whole lifetime on a proxy-less install.
    if (!configuredProxyOrigin && earlyStatsEvents.length) earlyStatsEvents.length = 0;
    // B9: stats events that arrived before the origin was known are queued.
    if (configuredProxyOrigin && earlyStatsEvents.length) {
      const queued = earlyStatsEvents.splice(0);
      queued.forEach(handleProxyCompleted);
    }
    updateWebRequestListener(configuredProxyOrigin);
    // Only write when different: every write makes every open tab rebuild
    // its caches via storage.onChanged. Queue one latest snapshot while a write
    // is in flight, so callback ordering cannot leave an older mirror last.
    pendingMirrorWrite = { opts, revision };
    const persistNext = () => {
      if (mirrorWriteInFlight) return;
      const next = pendingMirrorWrite;
      pendingMirrorWrite = null;
      if (!next || next.revision !== mirrorRevision) return;
      mirrorWriteInFlight = true;
      const finish = () => {
        mirrorWriteInFlight = false;
        if (pendingMirrorWrite) persistNext();
      };
      try {
        chrome.storage.local.get({ bhOpts: null }, d => {
          if (next.revision !== mirrorRevision) { finish(); return; }
          if (chrome.runtime?.lastError) {
            scheduleSettingsReadRetry();
            finish();
            return;
          }
          if (sameOpts(d?.bhOpts, next.opts)) { finish(); return; }
          try {
            chrome.storage.local.set({ bhOpts: next.opts }, () => {
              if (next.revision === mirrorRevision && chrome.runtime?.lastError) {
                scheduleSettingsReadRetry();
              }
              finish();
            });
          } catch {
            if (next.revision === mirrorRevision) scheduleSettingsReadRetry();
            finish();
          }
        });
      } catch {
        if (next.revision === mirrorRevision) scheduleSettingsReadRetry();
        finish();
      }
    };
    persistNext();
  };
  try { chrome.storage.sync.get(DEFAULTS, onSyncSettings); }
  catch { scheduleSettingsReadRetry(); }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

function initializeMissingSettings() {
  try {
    chrome.storage.sync.get(null, function(all) {
      if (chrome.runtime?.lastError || !all || typeof all !== "object") {
        scheduleSettingsReadRetry();
        return;
      }
      const missing = {};
      for (const key in DEFAULTS) if (!(key in all)) missing[key] = DEFAULTS[key];
      if (!Object.keys(missing).length) return;
      try {
        chrome.storage.sync.set(missing, () => {
          if (chrome.runtime?.lastError) scheduleSettingsReadRetry();
        });
      } catch { scheduleSettingsReadRetry(); }
    });
  } catch { scheduleSettingsReadRetry(); }
}
chrome.runtime.onInstalled.addListener(initializeMissingSettings);

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

// ── Extension icon ────────────────────────────────────────────────────────────
const ICONS_ON  = { 16: "icons/icon-16.png", 32: "icons/icon-32.png", 48: "icons/icon-48.png", 128: "icons/icon-128.png" };
const ICONS_OFF = { 16: "icons/icon-16-disabled.png", 32: "icons/icon-32-disabled.png", 48: "icons/icon-48-disabled.png", 128: "icons/icon-128-disabled.png" };
let iconRevision = 0;
function updateIcon() {
  const revision = ++iconRevision;
  try {
    chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, d => {
      if (revision !== iconRevision) return;
      if (chrome.runtime?.lastError || !d) {
        scheduleSettingsReadRetry();
        return;
      }
      if (!chrome.action || typeof chrome.action.setIcon !== "function") return;
      try {
        const maybePromise = chrome.action.setIcon({ path: d.enabled ? ICONS_ON : ICONS_OFF });
        if (maybePromise && typeof maybePromise.catch === "function") maybePromise.catch(() => {});
      } catch {}
    });
  } catch { scheduleSettingsReadRetry(); }
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
  const s = String(url || "");
  // Cheap prefilter: the webRequest listener is already narrowed to this
  // origin, so nearly every candidate matches; skip the URL parse otherwise.
  if (!s.startsWith(configuredProxyOrigin + "/")) return false;
  try {
    return new URL(s).searchParams.has("url"); // R9: parse once
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
let statsMirrorRetryDelay = 1000;
let statsStartupWriteInProgress = true; // startup recovery's first storage read/write
let statsStartupRetryTimer = null;
let statsStartupRetryDelay = 1000;
let statsResetPending = false;
let statsResetInProgress = false;
const statsResetResponders = [];

const hasPendingStats = () => !!(pendingStats.filesProcessed || pendingStats.bytesProcessed || pendingStats.bytesSaved);

function restorePendingStats(delta) {
  pendingStats = {
    filesProcessed: pendingStats.filesProcessed + delta.filesProcessed,
    bytesProcessed: pendingStats.bytesProcessed + delta.bytesProcessed,
    bytesSaved: pendingStats.bytesSaved + delta.bytesSaved
  };
  mirrorPendingStats();
  scheduleStatsFlush();
}

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
  statsMirrorRetryDelay = 1000;
  if (typeof sendResponse === "function") statsResetResponders.push(sendResponse);
  statsResetPending = true;
  // A queued startup retry has no storage operation in flight. Reset supersedes
  // recovery in that case and can safely clear the journal immediately.
  if (statsStartupRetryTimer) {
    clearTimeout(statsStartupRetryTimer);
    statsStartupRetryTimer = null;
    statsStartupWriteInProgress = false;
  }
  finishStatsResetIfReady();
}

function flushStats() {
  if (statsResetPending || statsResetInProgress) return;
  // Startup recovery and ordinary flushes must not race each other's read/modify/write.
  if (statsStartupWriteInProgress) return;
  if (statsFlushInProgress) { scheduleStatsFlush(); return; }
  // The write-ahead mirror must finish before a flush clears it. Otherwise a
  // worker shutdown between the flush read and commit can lose this batch.
  if (statsMirrorTimer || statsMirrorWriteInProgress) return;
  if (!hasPendingStats()) return;
  statsFlushInProgress = true;
  const delta = pendingStats;
  pendingStats = { ...ZERO_STATS };

  const restoreDelta = () => {
    statsFlushInProgress = false;
    if (statsResetPending || statsResetInProgress) {
      finishStatsResetIfReady();
      return;
    }
    // Storage read/write failures must not silently discard the in-memory
    // batch. The journal is refreshed before the next flush attempt.
    restorePendingStats(delta);
  };

  try {
    chrome.storage.local.get({ stats: ZERO_STATS }, d => {
      // A reset requested during the read wins over this stale delta.
      if (statsResetPending || statsResetInProgress) {
        statsFlushInProgress = false;
        finishStatsResetIfReady();
        return;
      }
      if (chrome.runtime?.lastError) {
        restoreDelta();
        return;
      }
      // Clone before merging: when `stats` is missing, Chromium can hand back
      // the very ZERO_STATS object passed as the default — mutating it would
      // poison every later spread/reset built from it.
      const s = { ...(d?.stats || ZERO_STATS) };
      s.filesProcessed += delta.filesProcessed;
      s.bytesProcessed += delta.bytesProcessed;
      s.bytesSaved     += delta.bytesSaved;
      // B8: commit stats and clear the crash mirror in ONE atomic write — a
      // worker kill between two writes can no longer strand the delta.
      try {
        chrome.storage.local.set({ stats: s, statsPending: { ...ZERO_STATS } }, () => {
          const writeFailed = !!chrome.runtime?.lastError;
          statsFlushInProgress = false;
          if (statsResetPending) {
            finishStatsResetIfReady();
          } else if (writeFailed) {
            restorePendingStats(delta);
          } else if (hasPendingStats()) {
            mirrorPendingStats();
            scheduleStatsFlush();
          }
        });
      } catch {
        restoreDelta();
      }
    });
  } catch {
    restoreDelta();
  }
}

function scheduleStatsFlush() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => { statsFlushTimer = null; flushStats(); }, 750);
}

function mirrorPendingStats(delay = 250) {
  if (statsMirrorTimer || statsMirrorWriteInProgress || statsFlushInProgress ||
      statsStartupWriteInProgress || statsResetPending || statsResetInProgress) return;
  statsMirrorTimer = setTimeout(() => {
    statsMirrorTimer = null;
    if (!hasPendingStats() || statsFlushInProgress || statsResetPending || statsResetInProgress) return;
    statsMirrorWriteInProgress = true;
    const snapshot = { ...pendingStats };
    try {
      chrome.storage.local.set({ statsPending: snapshot }, () => {
        statsMirrorWriteInProgress = false;
        if (statsResetPending) {
          finishStatsResetIfReady();
        } else if (chrome.runtime?.lastError) {
          // The journal is the crash-safe copy of this in-memory batch. Keep
          // retrying with bounded backoff rather than letting the later flush
          // clear a journal that never reached storage.
          if (hasPendingStats()) {
            const retryDelay = statsMirrorRetryDelay;
            statsMirrorRetryDelay = Math.min(statsMirrorRetryDelay * 2, 30000);
            mirrorPendingStats(retryDelay);
          }
        } else {
          statsMirrorRetryDelay = 1000;
          // New activity may have arrived while this snapshot was being written.
          // Don't rewrite an unchanged snapshot: the normal flush will clear it.
          if (hasPendingStats()) {
            if (pendingStats.filesProcessed !== snapshot.filesProcessed ||
                pendingStats.bytesProcessed !== snapshot.bytesProcessed ||
                pendingStats.bytesSaved !== snapshot.bytesSaved) {
              mirrorPendingStats();
            } else {
              // The normal flush may have fired while this journal write was
              // pending. Resume it now rather than polling every 750 ms.
              scheduleStatsFlush();
            }
          }
        }
      });
    } catch {
      statsMirrorWriteInProgress = false;
      if (statsResetPending) {
        finishStatsResetIfReady();
      } else if (hasPendingStats()) {
        const retryDelay = statsMirrorRetryDelay;
        statsMirrorRetryDelay = Math.min(statsMirrorRetryDelay * 2, 30000);
        mirrorPendingStats(retryDelay);
      }
    }
  }, delay);
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
  if (statsStartupRetryTimer) {
    clearTimeout(statsStartupRetryTimer);
    statsStartupRetryTimer = null;
  }
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

function retryStatsStartup() {
  if (statsStartupRetryTimer) return;
  const delay = statsStartupRetryDelay;
  statsStartupRetryDelay = Math.min(statsStartupRetryDelay * 2, 30000);
  statsStartupRetryTimer = setTimeout(() => {
    statsStartupRetryTimer = null;
    recoverStatsStartup();
  }, delay);
}

function recoverStatsStartup() {
  try {
    chrome.storage.local.get({ stats: ZERO_STATS, statsPending: null }, d => {
      if (chrome.runtime?.lastError || !d) {
        // Do not enable writes while an older journal may still be on disk:
        // a new mirror could otherwise overwrite the only recoverable copy.
        if (startupStatsRevision !== statsRevision || statsResetPending) finishStatsStartup();
        else retryStatsStartup();
        return;
      }
      statsStartupRetryDelay = 1000;
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
      // Clone for the same reason as flushStats: the default object can be the
      // shared ZERO_STATS instance; never merge into it in place.
      const s = { ...(d.stats || ZERO_STATS) };
      s.filesProcessed += files;
      s.bytesProcessed += bytes;
      s.bytesSaved     += saved;
      const finishRecovery = () => {
        if (chrome.runtime?.lastError && startupStatsRevision === statsRevision && !statsResetPending) {
          restorePendingStats({ filesProcessed: files, bytesProcessed: bytes, bytesSaved: saved });
        }
        finishStatsStartup();
      };
      try {
        chrome.storage.local.set({ stats: s, statsPending: { ...ZERO_STATS } }, finishRecovery);
      } catch {
        if (startupStatsRevision === statsRevision && !statsResetPending) {
          restorePendingStats({ filesProcessed: files, bytesProcessed: bytes, bytesSaved: saved });
        }
        finishStatsStartup();
      }
    });
  } catch {
    if (startupStatsRevision !== statsRevision || statsResetPending) finishStatsStartup();
    else retryStatsStartup();
  }
}

recoverStatsStartup();

// Observe proxy responses, narrowed to the configured proxy origin (O3) and
// re-registered whenever proxyBase changes. onCompleted feeds statistics and
// fallback; onErrorOccurred feeds fallback and the circuit breaker.
// "extraHeaders" is not needed for custom x-bh-* headers (B10).
let webRequestRegistered = false;
let webRequestOrigin = null; // origin the current registration targets
const PROXY_REQUEST_TYPES = ["image", "object"];
function updateWebRequestListener(origin) {
  if (!chrome.webRequest || typeof chrome.webRequest.onCompleted !== "object") return;
  const key = origin === "*" ? "*" : String(origin || "");
  // The startup observer uses <all_urls> only until settings are available.
  // Once a proxy origin is known, narrow the filter; with no configured proxy,
  // remove the observer entirely.
  if (webRequestRegistered && key === webRequestOrigin) return;
  if (webRequestRegistered) {
    try { chrome.webRequest.onCompleted.removeListener(onProxyCompleted); } catch {}
    try { chrome.webRequest.onErrorOccurred?.removeListener(onProxyError); } catch {}
    webRequestRegistered = false;
    webRequestOrigin = null;
  }
  if (!key) return;
  const urls = key === "*" ? ["<all_urls>"] : [key + "/*"];
  let completedAdded = false;
  let errorAdded = false;
  try {
    chrome.webRequest.onCompleted.addListener(
      onProxyCompleted,
      { urls, types: PROXY_REQUEST_TYPES },
      ["responseHeaders"]
    );
    completedAdded = true;
    if (typeof chrome.webRequest.onErrorOccurred?.addListener === "function") {
      chrome.webRequest.onErrorOccurred.addListener(onProxyError, { urls, types: PROXY_REQUEST_TYPES });
      errorAdded = true;
    }
    webRequestRegistered = true;
    webRequestOrigin = key;
  } catch {
    // Roll back a partial registration; otherwise a retry can add duplicate
    // listeners when only one of the two event subscriptions failed.
    if (completedAdded) { try { chrome.webRequest.onCompleted.removeListener(onProxyCompleted); } catch {} }
    if (errorAdded) { try { chrome.webRequest.onErrorOccurred.removeListener(onProxyError); } catch {} }
    webRequestRegistered = false;
    webRequestOrigin = null;
  }
}
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
  // Any completed HTTP response proves the proxy endpoint was reachable,
  // regardless of status. Reset the connection-failure window before deciding
  // whether this particular image needs a direct retry.
  noteProxyResponse();
  const ok = typeof statusCode !== "number" || (statusCode >= 200 && statusCode < 300);

  if (!ok) {
    // HTTP errors still get a direct retry for this image, but are not
    // themselves connection-level failures.
    scheduleFallback(details);
    return;
  }
  // A 2xx that is not an image at all (HTML error page, handshake text, …)
  // cannot render; fall back. image/* types outside the strict list (AVIF
  // passthrough, etc.) still render, they are just not counted below.
  if (contentType && !contentType.startsWith("image/")) { scheduleFallback(details); return; }
  if (fromCache) return;

  // STRICT detected image types only: count the response only when its actual
  // Content-Type is one of the supported image types.
  if (!IMAGE_CONTENT_TYPES.has(contentType)) return;

  const st = getProxyResponseStats(headers);
  recordStats(st.received, st.saved);
}

// Errors that do not indicate a failed proxy connection: the page cancelled
// the request, another extension/policy blocked it, or the client's cache or
// network changed. They do not need a fallback retry or breaker accounting.
const IGNORED_NET_ERRORS = new Set([
  "net::ERR_ABORTED", "net::ERR_BLOCKED_BY_CLIENT", "net::ERR_BLOCKED_BY_ADMINISTRATOR",
  "net::ERR_CACHE_MISS", "net::ERR_NETWORK_CHANGED"
]);
// Only errors that indicate proxy reachability / transport failure may open
// the global breaker. Chromium also reports TLS, certificate, CSP, policy,
// generic and upstream-response errors through webRequest; those must not be
// mistaken for an unreachable proxy. Unknown errors still get per-image
// recovery below, but are deliberately not promoted to global failures.
const CONNECTION_NET_ERRORS = new Set([
  // Socket/connection failures.
  "net::ERR_CONNECTION_CLOSED", "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_REFUSED", "net::ERR_CONNECTION_ABORTED",
  "net::ERR_CONNECTION_FAILED", "net::ERR_CONNECTION_TIMED_OUT",
  "net::ERR_ADDRESS_UNREACHABLE", "net::ERR_INTERNET_DISCONNECTED",
  // Proxy-path failures and DNS resolution failures.
  "net::ERR_PROXY_CONNECTION_FAILED", "net::ERR_SOCKS_CONNECTION_FAILED",
  "net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE", "net::ERR_NAME_NOT_RESOLVED",
  "net::ERR_NAME_RESOLUTION_FAILED", "net::ERR_DNS_TIMED_OUT",
  "net::ERR_DNS_MALFORMED_RESPONSE", "net::ERR_DNS_SERVER_FAILED"
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
  if (CONNECTION_NET_ERRORS.has(error)) noteGlobalProxyFailure();
  scheduleFallback(details);
}

// Re-establish the observer from the last confirmed settings snapshot when
// synced storage is temporarily unavailable. This never writes settings or
// changes DNR rules; it only restores the proxy-origin filter used for response
// accounting and per-image fallback. A successful sync snapshot invalidates an
// in-flight local read, so an older mirror can never roll the observer back.
function restoreProxyObserverFromLocalMirror() {
  // The local mirror is only a startup recovery source. Once a trusted sync
  // snapshot or local restore has configured the observer, keep that last-known
  // origin during later sync failures instead of risking a stale mirror rollback.
  // Coalesce startup reads; a newer successful sync snapshot invalidates them.
  if (proxyObserverReady || restoringProxyObserver) return;
  restoringProxyObserver = true;
  const revision = ++proxyObserverRevision;
  const finish = () => { restoringProxyObserver = false; };
  try {
    chrome.storage.local.get({ bhOpts: null }, data => {
      if (revision !== proxyObserverRevision) { finish(); return; }
      if (chrome.runtime?.lastError) {
        scheduleSettingsReadRetry();
        finish();
        return;
      }
      const opts = data?.bhOpts;
      if (!opts || typeof opts !== "object" || Array.isArray(opts)) { finish(); return; }
      try {
        proxyObserverReady = true;
        setProxyOrigin(opts.proxyBase);
        if (!configuredProxyOrigin && earlyStatsEvents.length) earlyStatsEvents.length = 0;
        if (configuredProxyOrigin && earlyStatsEvents.length) {
          const queued = earlyStatsEvents.splice(0);
          queued.forEach(handleProxyCompleted);
        }
        updateWebRequestListener(configuredProxyOrigin);
      } catch {
        if (revision === proxyObserverRevision) scheduleSettingsReadRetry();
      } finally {
        finish();
      }
    });
  } catch {
    if (revision === proxyObserverRevision) scheduleSettingsReadRetry();
    finish();
  }
}

// MV3 event handlers must be registered synchronously at top level. Settings
// are loaded asynchronously, so begin with a bounded startup observer and
// narrow it to the configured proxy origin as soon as a trusted snapshot is
// available. Without this bootstrap, the first webRequest event after a worker
// restart can be dispatched before the async storage callback adds its filter.
updateWebRequestListener("*");

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
let bypassChain      = Promise.resolve(); // serializes all session-rule operations
let bypassInitialized = false;
let bypassInitPromise = null;

// Session rules survive service-worker restarts. A transient read failure must
// not be cached as an empty ruleset: retry initialization on the next queued
// operation instead of allocating IDs that may already exist in Chrome.
function bypassReady() {
  if (bypassInitialized) return Promise.resolve(true);
  if (bypassInitPromise) return bypassInitPromise;
  let initialization;
  initialization = (async () => {
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
      bypassInitialized = true;
      return true;
    } catch {
      return false;
    } finally {
      if (bypassInitPromise === initialization) bypassInitPromise = null;
    }
  })();
  bypassInitPromise = initialization;
  return initialization;
}

function queueBypassOperation(operation, notReadyValue) {
  const queued = bypassChain.catch(() => {}).then(async () => {
    if (!await bypassReady()) {
      return typeof notReadyValue === "function" ? notReadyValue() : notReadyValue;
    }
    return operation();
  });
  bypassChain = queued.catch(() => {});
  return queued;
}

// Browser request URLs are ASCII after URL canonicalization. Most URLs can use
// urlFilter's exact start/end anchors; URLs containing its wildcard or separator
// metacharacters need a literal-escaped regex instead.
const BYPASSABLE_URL_RE = /^https?:\/\/[\x21-\x7e]+$/;
const MAX_BYPASS_REGEX_LENGTH = 1900;
function bypassCondition(url) {
  // Reserve room for the two urlFilter anchors so plain filters remain below the
  // same conservative limit used for escaped regex filters.
  if (url.length > MAX_BYPASS_REGEX_LENGTH - 2) return null;
  if (!/[|*^]/.test(url)) return { urlFilter: "|" + url + "|", isUrlFilterCaseSensitive: true };
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
  // Session allow rules without tabIds are global. A request without a real tab
  // cannot be retried safely, so never turn an unknown tab (-1) into a global bypass.
  if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve([]);
  const tab = tabId;
  return queueBypassOperation(async () => {
    const candidates = [];
    const candidateKeys = new Set();
    const alreadyPresent = new Set();
    for (const url of urls) {
      if (!BYPASSABLE_URL_RE.test(url)) continue;
      const key = tab + " " + url;
      if (bypassRules.has(key)) { alreadyPresent.add(url); continue; }
      if (candidateKeys.has(key)) continue;
      const baseCondition = bypassCondition(url);
      if (!baseCondition) continue;
      candidateKeys.add(key);
      candidates.push({ key, url, baseCondition });
      if (candidates.length >= BYPASS_LIMIT) break;
    }

    // Build evictions WITHOUT mutating the live map, and only evict when a
    // validated candidate actually needs the slot. Otherwise a burst of
    // too-long / regex-quota-exceeded candidates could discard useful older
    // bypasses and still install nothing.
    const removeRuleIds = [];
    const nextRules = new Map(bypassRules);
    const nextRegexRules = new Set(bypassRegexRules);
    const addRules = [];
    const addedKeys = new Map();
    for (const c of candidates) {
      // Evict only when the table itself is full. nextRules already counts this
      // batch's additions, so comparing against the remaining headroom evicted
      // live bypasses at half capacity.
      const needsSlot = nextRules.size >= BYPASS_LIMIT;
      if (needsSlot) {
        const oldest = nextRules.entries().next().value;
        // No entry can be evicted, so leave this candidate uninstalled.
        if (!oldest) continue;
        // Evicting a non-regex oldest rule cannot make room under the regex
        // quota, so skip a quota-blocked regex candidate instead of discarding
        // a useful rule for nothing. An oldest regex rule does free one slot.
        if (c.baseCondition.regexFilter && nextRegexRules.size >= BYPASS_REGEX_LIMIT &&
            !nextRegexRules.has(oldest[0])) continue;
        nextRules.delete(oldest[0]);
        nextRegexRules.delete(oldest[0]);
        removeRuleIds.push(oldest[1]);
      }
      if (c.baseCondition.regexFilter && nextRegexRules.size >= BYPASS_REGEX_LIMIT) continue;
      const id = bypassNextId++;
      const condition = { ...c.baseCondition, resourceTypes: PROXY_REQUEST_TYPES, tabIds: [tab] };
      addRules.push({ id, priority: PRIORITY_BYPASS, action: { type: "allow" }, condition });
      addedKeys.set(c.key, { id, url: c.url });
      nextRules.set(c.key, id);
      if (c.baseCondition.regexFilter) nextRegexRules.add(c.key);
    }
    if (!addRules.length) return Array.from(alreadyPresent);

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
  }, []);
}

// Drop a closed tab's bypass rules (they can never match again).
chrome.tabs?.onRemoved?.addListener(tabId => {
  // A tab may close while its 250 ms fallback batch is still queued. Drop that
  // work before it reaches addBypass(), otherwise a dead tab can consume a
  // session-rule slot after the removal handler has already run.
  clearQueuedFallbacks(tabId);
  queueBypassOperation(async () => {
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
  }, undefined);
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
  queueBypassOperation(() => {
    const urls = [];
    for (const k of bypassRules.keys()) if (k.startsWith(prefix)) urls.push(k.slice(prefix.length));
    // BYPASS_LIMIT bounds this list; returning all active entries ensures a
    // reloaded document also knows about failed URLs older than the last 1,000.
    sendResponse({ urls });
  }, () => sendResponse({ urls: [] }));
  return true;
});

// Failures are batched per tab because DNR bypass rules are tab-scoped and the
// retry notification must update every frame's MAIN-world failed-URL set.
const fallbackSeen    = new Set();  // "tabId url": a URL is retried once per tab
const fallbackPending = new Set();  // URLs queued or being installed; prevents overlapping flushes
const fallbackBatch   = new Map();  // tabId -> { tabId, items: Map(original -> proxyUrl) }
let fallbackTimer     = null;

function clearQueuedFallbacks(tabId) {
  const prefix = tabId + " ";
  for (const key of fallbackSeen) {
    if (key.startsWith(prefix)) fallbackSeen.delete(key);
  }
  for (const key of fallbackPending) {
    if (key.startsWith(prefix)) fallbackPending.delete(key);
  }
  fallbackBatch.delete(tabId);
  // The timer is shared by all tabs; keep it while any other tab still has
  // queued work, and cancel it once the queue is empty.
  if (!fallbackBatch.size && fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

function scheduleFallback(details) {
  const original = originalFromProxyUrl(details.url);
  if (!original || !Number.isInteger(details.tabId) || details.tabId < 0) return;
  const tabId = details.tabId;
  const key = tabId + " " + original;
  if (fallbackSeen.has(key) || fallbackPending.has(key)) return;
  // Reserve the URL while it is queued or being installed. Without this
  // in-flight guard, a second batch can pass the dedupe check before the first
  // DNR update completes and broadcast the same retry twice.
  fallbackPending.add(key);
  // Do not consume the retry yet. Only a confirmed DNR bypass makes the retry
  // safe; a failed update must leave the URL eligible for a later attempt.
  if (!fallbackBatch.has(tabId)) fallbackBatch.set(tabId, { tabId, items: new Map() });
  fallbackBatch.get(tabId).items.set(original, details.url);
  // 250 ms lets the renderer finish the failed response first; a CSS rule
  // re-inserted while the failed load is still settling can reuse it.
  if (!fallbackTimer) fallbackTimer = setTimeout(flushFallbacks, 250);
}

function markFallbackSeen(tabId, original) {
  const key = tabId + " " + original;
  if (fallbackSeen.has(key)) return false;
  fallbackSeen.add(key);
  if (fallbackSeen.size > 20000) fallbackSeen.delete(fallbackSeen.values().next().value);
  return true;
}

function flushFallbacks() {
  fallbackTimer = null;
  const batches = Array.from(fallbackBatch.values());
  fallbackBatch.clear();
  for (const b of batches) {
    const originals = Array.from(b.items.keys());
    addBypass(b.tabId, originals).then(bypassed => {
      // Release each reservation after the DNR result is known. Failed or
      // capacity-limited entries remain eligible for a later request.
      for (const original of originals) fallbackPending.delete(b.tabId + " " + original);
      if (!chrome.tabs?.sendMessage || !bypassed?.length) return;
      const allowed = new Set(bypassed);
      const items = Array.from(b.items, ([original, proxyUrl]) => ({ original, proxyUrl }))
        .filter(item => allowed.has(item.original) && markFallbackSeen(b.tabId, item.original));
      if (!items.length) return;
      try {
        // The bypass is tab-scoped. Broadcast to every frame so conflict URLs
        // are also remembered by each frame's prehook (not just the failing one).
        const p = chrome.tabs.sendMessage(b.tabId, { type: "bh-retry", items });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {}
    }).catch(() => {
      // A rejected update must not strand the reservation or consume the retry.
      for (const original of originals) fallbackPending.delete(b.tabId + " " + original);
    });
  }
}

// ── Circuit breaker ───────────────────────────────────────────────────────────
// Connection-level failures (proxy down, DNS failure, connection timeout) are
// counted; any completed HTTP response resets the count because it proves the
// proxy was reachable. HTTP errors and response-body blocking use per-image
// fallback without opening the breaker.
// Two BREAKER_THRESHOLD failures within BREAKER_WINDOW_MS remove the redirect
// for BREAKER_COOLDOWN_MS so the web keeps working.
// The suspension lives in storage.session, so a browser restart clears it.
const BREAKER_THRESHOLD   = 2;
const BREAKER_WINDOW_MS   = 10000;
const BREAKER_COOLDOWN_MS = 40000;
const BREAKER_ALARM       = "bh-breaker-resume";
const BREAKER_READ_RETRY_ALARM = "bh-breaker-read-retry";
const RUNTIME_PUBLISH_RETRY_ALARM = "bh-runtime-publish-retry";
let breakerFailures = [];
let breakerReadRetryDelay = 1000;

function scheduleBreakerReadRetry() {
  const delay = breakerReadRetryDelay;
  breakerReadRetryDelay = Math.min(delay * 2, 30000);
  try {
    const created = chrome.alarms?.create(BREAKER_READ_RETRY_ALARM, { when: Date.now() + delay });
    if (created && typeof created.catch === "function") created.catch(() => {});
  } catch {}
}

function noteProxyResponse() { breakerFailures = []; }
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
function scheduleBreakerResume(when) {
  try { chrome.alarms?.create(BREAKER_ALARM, { when }); } catch {}
}
function resumeBreakerIfExpired() {
  const retry = () => scheduleBreakerResume(Date.now() + 1000);
  try {
    chrome.storage.session.get({ bhSuspendedUntil: 0 }, data => {
      if (chrome.runtime?.lastError) { retry(); return; }
      const until = Number(data?.bhSuspendedUntil) || 0;
      if (!until) return; // Another alarm or lifecycle event already cleared it.
      if (until > Date.now()) {
        // An older alarm can fire after an in-flight request extends the
        // suspension. Keep the newer deadline and replace the stale alarm.
        scheduleBreakerResume(until + 50);
        return;
      }
      try {
        chrome.storage.session.remove("bhSuspendedUntil", () => {
          if (chrome.runtime?.lastError) { retry(); return; }
          refreshRules();
        });
      } catch { retry(); }
    });
  } catch { retry(); }
}
chrome.alarms?.onAlarm?.addListener(alarm => {
  if (alarm.name === SETTINGS_READ_RETRY_ALARM) {
    initializeMissingSettings();
    mirrorToLocal();
    refreshRules();
    updateIcon();
  } else if (alarm.name === BREAKER_ALARM) resumeBreakerIfExpired();
  else if (alarm.name === BREAKER_READ_RETRY_ALARM) refreshRules();
  else if (alarm.name === RUNTIME_PUBLISH_RETRY_ALARM) retryPendingRuntimePublication();
});

function readSuspended(cb) {
  const unavailable = () => {
    // An unreadable suspension must never be interpreted as an expired one:
    // keep proxying disabled for this refresh, then retry rule setup separately
    // from the cooldown alarm so neither timer can overwrite the other.
    scheduleBreakerReadRetry();
    cb(true);
  };
  try {
    chrome.storage.session.get({ bhSuspendedUntil: 0 }, d => {
      if (chrome.runtime?.lastError) { unavailable(); return; }
      breakerReadRetryDelay = 1000;
      try {
        const cleared = chrome.alarms?.clear(BREAKER_READ_RETRY_ALARM);
        if (cleared && typeof cleared.catch === "function") cleared.catch(() => {});
      } catch {}
      cb(Number(d?.bhSuspendedUntil) > Date.now());
    });
  } catch { unavailable(); }
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
    if (!/^https?:$/.test(u.protocol) || u.searchParams.has("url")) return "";
    u.hash = "";
    // A trailing empty "?" survives in href and would make the separator
    // logic emit "?&jpeg=0…" — normalize it away.
    const href = u.href;
    return href.endsWith("?") ? href.slice(0, -1) : href;
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
      condition: redirectCondition(OBJECT_IMAGE_PATTERN, ["object"])
    });
    // Loop guard: anything already addressed to the proxy is left alone.
    addRules.push({
      id: RULE_ID_ALLOW_PROXY, priority: PRIORITY_PROXY, action: { type: "allow" },
      condition: { urlFilter: "|" + proxyOrigin + "/", resourceTypes: PROXY_REQUEST_TYPES }
    });
    // These regex filters are case-insensitive by design; DNR's
    // isUrlFilterCaseSensitive option applies only to urlFilter conditions.
    addRules.push({
      id: RULE_ID_ALLOW_SKIP, priority: PRIORITY_EXEMPT, action: { type: "allow" },
      condition: { regexFilter: SKIP_PATTERN, resourceTypes: PROXY_REQUEST_TYPES }
    });
    addRules.push({
      id: RULE_ID_ALLOW_CONFLICT, priority: PRIORITY_EXEMPT, action: { type: "allow" },
      condition: { regexFilter: CONFLICT_PATTERN, resourceTypes: PROXY_REQUEST_TYPES }
    });
    PRIVATE_HOST_PATTERNS.forEach(function(p, i) {
      addRules.push({
        id: RULE_ID_ALLOW_PRIVATE + i, priority: PRIORITY_EXEMPT, action: { type: "allow" },
        condition: { regexFilter: p, resourceTypes: PROXY_REQUEST_TYPES }
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
let lastRuntime = null; // last state confirmed in storage
let pendingRuntime = null; // newest desired state until storage confirms it
let runtimePublishRevision = 0;
let runtimeWriteQueue = Promise.resolve();
const RUNTIME_PUBLISH_RETRY_INITIAL_DELAY_MS = 30000; // Chrome alarms have a 30s minimum interval
const RUNTIME_PUBLISH_RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
let runtimePublishRetryDelay = RUNTIME_PUBLISH_RETRY_INITIAL_DELAY_MS;

function clearRuntimePublishRetry(resetBackoff = false) {
  try {
    const cleared = chrome.alarms?.clear(RUNTIME_PUBLISH_RETRY_ALARM);
    if (cleared && typeof cleared.catch === "function") cleared.catch(() => {});
  } catch {}
  if (resetBackoff) runtimePublishRetryDelay = RUNTIME_PUBLISH_RETRY_INITIAL_DELAY_MS;
}

function scheduleRuntimePublishRetry(revision) {
  if (revision !== runtimePublishRevision || !pendingRuntime) return;
  const delay = runtimePublishRetryDelay;
  runtimePublishRetryDelay = Math.min(delay * 2, RUNTIME_PUBLISH_RETRY_MAX_DELAY_MS);
  try {
    const created = chrome.alarms?.create(RUNTIME_PUBLISH_RETRY_ALARM, { when: Date.now() + delay });
    if (created && typeof created.catch === "function") created.catch(() => {});
  } catch {}
}

function enqueueRuntimePublication(next) {
  const revision = ++runtimePublishRevision;
  // Serialize the read/compare/write sequence. Overlapping storage callbacks
  // could otherwise finish out of order and leave content scripts with a stale
  // redirect state after a quick settings or circuit-breaker transition.
  runtimeWriteQueue = runtimeWriteQueue.then(() => new Promise(resolve => {
    const fail = () => {
      // Keep the newest desired state pending: without another settings/rule
      // event, it still needs a retry after a transient storage failure.
      if (revision === runtimePublishRevision) scheduleRuntimePublishRetry(revision);
      resolve();
    };
    const confirm = () => {
      if (revision === runtimePublishRevision) {
        lastRuntime = next;
        pendingRuntime = null;
        clearRuntimePublishRetry(true);
      }
      resolve();
    };
    try {
      chrome.storage.local.get({ bhRuntime: null }, d => {
        if (revision !== runtimePublishRevision) { resolve(); return; }
        if (chrome.runtime?.lastError) { fail(); return; }
        const cur = d?.bhRuntime;
        if (cur && cur.redirect === next.redirect && cur.suspended === next.suspended) {
          confirm();
          return;
        }
        try {
          chrome.storage.local.set({ bhRuntime: next }, () => {
            if (revision === runtimePublishRevision && chrome.runtime?.lastError) fail();
            else confirm();
          });
        } catch { fail(); }
      });
    } catch { fail(); }
  })).catch(() => {
    if (revision === runtimePublishRevision) scheduleRuntimePublishRetry(revision);
  });
}

function retryPendingRuntimePublication() {
  if (!pendingRuntime) return;
  enqueueRuntimePublication(pendingRuntime);
}

function publishRuntime(runtime) {
  const next = { redirect: !!runtime.redirect, suspended: !!runtime.suspended };
  const same = state => state && state.redirect === next.redirect && state.suspended === next.suspended;
  // A pending transition takes precedence over the last confirmed state. In
  // particular, a request to return to `lastRuntime` must not be dropped while
  // a different state is still being written.
  if (same(pendingRuntime)) return;
  if (!pendingRuntime && same(lastRuntime)) {
    clearRuntimePublishRetry(true);
    return;
  }
  pendingRuntime = next;
  clearRuntimePublishRetry();
  enqueueRuntimePublication(next);
}

function doRefreshRules(done) {
  const finish = () => { if (typeof done === "function") done(); };
  if (!chrome.declarativeNetRequest || typeof chrome.declarativeNetRequest.updateDynamicRules !== "function") {
    // Without DNR, the DOM interception layer must own all eligible URLs.
    // Preserve the circuit-breaker state while publishing that no redirect is live.
    readSuspended(suspended => {
      publishRuntime({ redirect: false, suspended });
      finish();
    });
    return;
  }
  // updateDynamicRules can fail asynchronously (lastError) OR throw
  // synchronously on a schema error; both paths must release the lock.
  const update = (addRules, cb) => {
    try {
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ALL_RULE_IDS, addRules }, () => cb(chrome.runtime.lastError || null));
    } catch (e) { cb(e); }
  };
  const onSyncSettings = function(opts) {
    if (chrome.runtime?.lastError || !opts || typeof opts !== "object") {
      scheduleSettingsReadRetry();
      finish();
      return;
    }
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
          // suspended=true here means "no redirect and no CSP removal": only the
          // Save-Data header rule is installed, so pages keep their CSP.
          const headersOnly = buildRules(opts, true, true);
          update(headersOnly, function(err3) {
            if (!err3) { installed(headersOnly); return; }

            // A rejected update is atomic: Chrome keeps the previously installed
            // dynamic rules. Do not publish the uninstalled fallback shape, or
            // the DOM layer can choose the wrong mode (and double-proxy images).
            // Read the live rules and publish only what Chrome actually retained.
            const publishCurrentRules = rules => {
              if (!chrome.runtime.lastError && Array.isArray(rules)) {
                publishRuntime({
                  redirect: rules.some(rule => rule.id === RULE_ID_REDIRECT_IMAGE),
                  suspended
                });
              }
              // If inspection also fails, preserve the last known runtime state.
              finish();
            };
            try {
              if (typeof chrome.declarativeNetRequest.getDynamicRules === "function") {
                chrome.declarativeNetRequest.getDynamicRules(publishCurrentRules);
              } else {
                finish();
              }
            } catch {
              finish();
            }
          });
        });
      });
    });
  };
  try { chrome.storage.sync.get(DEFAULTS, onSyncSettings); }
  catch {
    scheduleSettingsReadRetry();
    finish();
  }
}

// Bootstrap only after every declaration above has been initialized; storage
// callbacks must never observe temporal dead-zone state, even when a mock or
// future implementation invokes them synchronously. updateIcon() reads the
// ICONS_* consts, and relying on the async storage callback to dodge the TDZ
// window is fragile.
mirrorToLocal();
refreshRules();
updateIcon();
