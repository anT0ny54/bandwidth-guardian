import { DEFAULTS } from "./defaults.js";

const $ = (id) => document.getElementById(id);
const enabledEl = $("enabled");
const grayscaleEl = $("grayscale");
const ctrlCard = $("ctrlCard");
const headerSub = $("headerSub");
const nudge = $("nudge");
const reloadBtn = $("reloadBtn");
const siteNameEl = $("siteName");
const sitePillEl = $("sitePill");
const excludeBtn = $("excludeBtn");
const settingsBtn = $("settingsBtn");
const presetBtns = [...document.querySelectorAll("#qualityPresets .preset")];
const PRESETS = [20, 40, 80];

let currentHost = "";
let currentIsWeb = false;

function parseDomains(text) {
  const set = new Set();
  for (const token of String(text || "").split(/[\s,]+/)) {
    const value = token.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
    if (value) set.add(value);
  }
  return set;
}

function nearestPreset(value) {
  return PRESETS.reduce(
    (best, candidate) =>
      Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
    PRESETS[0],
  );
}

function setActivePreset(value) {
  const match = nearestPreset(Number(value) || DEFAULTS.quality);
  presetBtns.forEach((button) =>
    button.classList.toggle("active", Number(button.dataset.q) === match),
  );
}

function showNudge() {
  nudge.classList.add("show");
}

function updateEnabledUI(enabled) {
  ctrlCard.classList.toggle("card-dim", !enabled);
  headerSub.textContent = enabled ? "Active" : "Disabled";
}

function applyUI(settings) {
  const d = { ...DEFAULTS, ...settings };
  enabledEl.checked = !!d.enabled;
  grayscaleEl.checked = !!d.grayscale;
  setActivePreset(d.quality);
  updateEnabledUI(!!d.enabled);
}

async function getActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  } catch {
    return null;
  }
}

async function loadSiteUI(settings) {
  const tab = await getActiveTab();
  if (!tab?.url) {
    siteNameEl.textContent = "No active tab";
    excludeBtn.disabled = true;
    return;
  }

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    siteNameEl.textContent = "Unknown";
    excludeBtn.disabled = true;
    return;
  }

  currentIsWeb = url.protocol === "http:" || url.protocol === "https:";
  currentHost = currentIsWeb ? url.hostname.toLowerCase() : "";

  if (!currentIsWeb) {
    siteNameEl.textContent = `${url.protocol.replace(":", "")} page`;
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Not a web page";
    excludeBtn.disabled = true;
    return;
  }

  siteNameEl.textContent = currentHost;
  excludeBtn.disabled = false;

  const excluded = parseDomains(settings.excludeDomains);
  const isExcluded = excluded.has(currentHost);
  sitePillEl.textContent = isExcluded ? "Excluded" : "";
  sitePillEl.className = isExcluded ? "site-pill excluded" : "site-pill";
  sitePillEl.style.display = isExcluded ? "" : "none";
  excludeBtn.textContent = isExcluded ? "✕ Remove exclusion" : "Exclude this site";
}

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  applyUI(settings);
  await loadSiteUI(settings);
}

enabledEl.addEventListener("change", async () => {
  const enabled = enabledEl.checked;
  await chrome.storage.sync.set({ enabled });
  updateEnabledUI(enabled);
  await loadSiteUI(await chrome.storage.sync.get(DEFAULTS));
});

grayscaleEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ grayscale: grayscaleEl.checked });
  showNudge();
});

presetBtns.forEach((button) => button.addEventListener("click", async () => {
  const quality = Number(button.dataset.q);
  setActivePreset(quality);
  await chrome.storage.sync.set({ quality });
  showNudge();
}));

reloadBtn.addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (tab?.id) {
    try { await chrome.tabs.reload(tab.id); } catch {}
  }
  window.close();
});

excludeBtn.addEventListener("click", async () => {
  if (!currentIsWeb || !currentHost) return;
  const settings = await chrome.storage.sync.get(DEFAULTS);
  const domains = parseDomains(settings.excludeDomains);
  if (domains.has(currentHost)) domains.delete(currentHost);
  else domains.add(currentHost);

  await chrome.storage.sync.set({ excludeDomains: [...domains].join(" ") });
  await loadSiteUI(await chrome.storage.sync.get(DEFAULTS));
});

settingsBtn.addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
  } catch {
    chrome.runtime.openOptionsPage?.();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  chrome.storage.sync.get(DEFAULTS).then((settings) => {
    applyUI(settings);
    loadSiteUI(settings);
  });
});

void load();
