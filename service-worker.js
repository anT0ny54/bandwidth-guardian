// Bandwidth Guardian — service worker

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

let refreshing = false;
let pendingRefresh = false;

function refreshRules() {
  if (refreshing) {
    pendingRefresh = true;
    return;
  }
  refreshing = true;
  doRefreshRules();
  refreshing = false;
  if (pendingRefresh) {
    pendingRefresh = false;
    refreshRules();
  }
}

function checkWebpSupport(callback) {
  if (!self.createImageBitmap) {
    callback(false);
    return;
  }

  try {
    const webpData =
      "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";

    fetch(webpData)
      .then((r) => r.blob())
      .then((blob) => self.createImageBitmap(blob))
      .then(() => callback(true))
      .catch(() => callback(false));
  } catch {
    callback(false);
  }
}

function mirrorToLocal() {
  chrome.storage.sync.get(DEFAULTS, (opts) => {
    chrome.storage.local.set({ bhOpts: opts });
  });
}

function updateIcon() {
  chrome.storage.sync.get({ enabled: DEFAULTS.enabled }, (d) => {
    const base = d.enabled ? "icons/icon" : "icons/icon-disabled";
    chrome.action.setIcon({
      path: {
        16: `${base}-16.png`,
        32: `${base}-32.png`,
        48: `${base}-48.png`,
        128: `${base}-128.png`,
      },
    });
  });
}

function getHeaderInt(headers, name) {
  if (!Array.isArray(headers)) return false;
  const header = headers.find(
    (h) => h?.name && h.name.toLowerCase() === name.toLowerCase()
  );
  if (!header) return false;
  const n = parseInt(header.value, 10);
  return Number.isNaN(n) ? false : n;
}

function onProxyCompleted({ responseHeaders, fromCache }) {
  if (fromCache) return;

  const bytesSaved = getHeaderInt(responseHeaders, "x-bytes-saved");
  const bytesOriginal = getHeaderInt(responseHeaders, "x-original-size");
  if (bytesSaved === false || bytesOriginal === false) return;

  chrome.storage.local.get(
    { stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } },
    (d) => {
      const s = d.stats || { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
      s.filesProcessed += 1;
      s.bytesProcessed += bytesOriginal;
      s.bytesSaved += bytesSaved;
      chrome.storage.local.set({ stats: s });
    }
  );
}

function doRefreshRules() {
  chrome.storage.sync.get(DEFAULTS, (opts) => {
    const removeRuleIds = ALL_RULE_IDS;

    if (!opts.enabled) {
      chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      return;
    }

    const addRules = [
      {
        id: RULE_ID_CSP,
        priority: 1,
        action: {
          type: "modifyHeaders",
          responseHeaders: [
            { header: "content-security-policy", operation: "remove" },
            { header: "content-security-policy-report-only", operation: "remove" },
          ],
        },
        condition: {
          resourceTypes: ["main_frame", "sub_frame"],
        },
      },
    ];

    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULTS, (d) => chrome.storage.sync.set(d));
  chrome.storage.local.get(
    { stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } },
    (d) => chrome.storage.local.set(d)
  );

  checkWebpSupport((isWebpSupported) => {
    chrome.storage.sync.set({ isWebpSupported });
    mirrorToLocal();
    refreshRules();
    updateIcon();
  });
});

chrome.runtime.onStartup.addListener(() => {
  checkWebpSupport((isWebpSupported) => {
    chrome.storage.sync.set({ isWebpSupported });
    mirrorToLocal();
    refreshRules();
    updateIcon();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  mirrorToLocal();
  refreshRules();
  if ("enabled" in changes || "excludeDomains" in changes) updateIcon();
});

if (chrome.webRequest && chrome.webRequest.onCompleted) {
  chrome.webRequest.onCompleted.addListener(
    onProxyCompleted,
    { urls: ["<all_urls>"], types: ["image"] },
    ["responseHeaders"]
  );
}

mirrorToLocal();
refreshRules();
updateIcon();
