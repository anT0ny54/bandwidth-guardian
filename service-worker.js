// Bandwidth Guardian — optimized MV3 service worker
"use strict";

const DEFAULTS = {
  enabled: true,
  proxyBase: "",
  quality: 40,
  grayscale: true,
  maxWidth: 1920,
  excludeDomains: "google.com gstatic.com",
  isWebpSupported: false,
};

const RULE_ID_CSP = 2;
const ALL_RULE_IDS = [1, RULE_ID_CSP];
const EMPTY_STATS = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };

let ruleRefreshTimer = 0;
let stats = { ...EMPTY_STATS };
let statsLoaded = false;
let statsDirty = false;
let statsFlushTimer = 0;
let statsWrite = Promise.resolve();

function getSync(keys) {
  return new Promise((resolve) => chrome.storage.sync.get(keys, resolve));
}
function setSync(value) {
  return chrome.storage.sync.set(value);
}
function getLocal(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function setLocal(value) {
  return chrome.storage.local.set(value);
}

async function mirrorToLocal() {
  const opts = await getSync(DEFAULTS);
  await setLocal({ bhOpts: opts });
}

function updateIcon(enabled) {
  const base = enabled ? "icons/icon" : "icons/icon-disabled";
  return chrome.action.setIcon({
    path: {
      16: `${base}-16.png`,
      32: `${base}-32.png`,
      48: `${base}-48.png`,
      128: `${base}-128.png`,
    },
  });
}

function scheduleRulesRefresh() {
  clearTimeout(ruleRefreshTimer);
  ruleRefreshTimer = setTimeout(refreshRules, 50);
}

async function refreshRules() {
  const opts = await getSync(DEFAULTS);
  const addRules = opts.enabled ? [{
    id: RULE_ID_CSP,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" },
      ],
    },
    condition: { resourceTypes: ["main_frame", "sub_frame"] },
  }] : [];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ALL_RULE_IDS,
      addRules,
    });
  } catch (error) {
    console.warn("Bandwidth Guardian: failed to refresh DNR rules", error);
  }
}

async function checkWebpSupport() {
  if (!self.createImageBitmap) return false;
  try {
    const data = "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
    const response = await fetch(data);
    const blob = await response.blob();
    const bitmap = await self.createImageBitmap(blob);
    bitmap.close?.();
    return true;
  } catch {
    return false;
  }
}

function parseHeaderInt(headers, name) {
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const header of headers) {
    if (header?.name?.toLowerCase() !== wanted) continue;
    const value = Number.parseInt(header.value, 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  return null;
}

async function ensureStatsLoaded() {
  if (statsLoaded) return;
  const data = await getLocal({ stats: EMPTY_STATS });
  stats = { ...EMPTY_STATS, ...(data.stats || {}) };
  statsLoaded = true;
}

function queueStatsWrite() {
  if (statsFlushTimer) return;
  statsFlushTimer = setTimeout(() => {
    statsFlushTimer = 0;
    if (!statsDirty) return;
    const snapshot = { ...stats };
    statsDirty = false;
    statsWrite = statsWrite.then(() => setLocal({ stats: snapshot })).catch((error) => {
      statsDirty = true;
      console.warn("Bandwidth Guardian: failed to save stats", error);
    });
  }, 250);
}

async function recordProxyStats(responseHeaders, fromCache) {
  if (fromCache) return;
  const saved = parseHeaderInt(responseHeaders, "x-bytes-saved");
  const original = parseHeaderInt(responseHeaders, "x-original-size");
  if (saved === null || original === null) return;

  await ensureStatsLoaded();
  stats.filesProcessed += 1;
  stats.bytesProcessed += original;
  stats.bytesSaved += saved;
  statsDirty = true;
  queueStatsWrite();
}

async function initialize() {
  const opts = await getSync(DEFAULTS);
  // Fill missing sync keys without overwriting user values.
  await setSync(opts);

  await ensureStatsLoaded();
  await setLocal({ stats });

  const webp = await checkWebpSupport();
  await setSync({ isWebpSupported: webp });
  await mirrorToLocal();
  await refreshRules();
  await updateIcon(webp && opts.enabled ? true : opts.enabled);
}

chrome.runtime.onInstalled.addListener(() => {
  initialize().catch((error) => console.warn("Bandwidth Guardian: initialization failed", error));
});

chrome.runtime.onStartup.addListener(() => {
  initialize().catch((error) => console.warn("Bandwidth Guardian: startup failed", error));
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;

  const relevant = Object.keys(changes);
  if (!relevant.length) return;

  mirrorToLocal().catch((error) => console.warn("Bandwidth Guardian: mirror failed", error));

  if ("enabled" in changes) {
    updateIcon(!!changes.enabled.newValue).catch(() => {});
    scheduleRulesRefresh();
  }
  // excludeDomains/proxyBase/quality/grayscale/maxWidth only affect content scripts.
  // Avoid waking/rebuilding DNR rules for those settings.
});

if (chrome.webRequest?.onCompleted) {
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      recordProxyStats(details.responseHeaders, details.fromCache).catch((error) => {
        console.warn("Bandwidth Guardian: stats update failed", error);
      });
    },
    { urls: ["<all_urls>"], types: ["image"] },
    ["responseHeaders"],
  );
}

// Keep the local mirror available after browser updates/restarts.
mirrorToLocal().catch(() => {});
refreshRules().catch(() => {});
getSync({ enabled: DEFAULTS.enabled })
  .then((d) => updateIcon(!!d.enabled))
  .catch(() => {});
