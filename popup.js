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
const presetBtns = Array.from(document.querySelectorAll("#qualityPresets .preset"));

const PRESETS = [20, 40, 80];

let currentHost = "";
let currentIsWeb = false;

function parseDomains(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => s.replace(/^https?:\/\//, "").split("/")[0]);
}

function nearestPreset(q) {
  return PRESETS.reduce(
    (best, v) => (Math.abs(v - q) < Math.abs(best - q) ? v : best),
    PRESETS[0],
  );
}

function setActivePreset(q) {
  const match = nearestPreset(q);
  presetBtns.forEach((b) => b.classList.toggle("active", Number(b.dataset.q) === match));
}

function showNudge() {
  nudge.classList.add("show");
}

function updateEnabledUI(enabled) {
  ctrlCard.classList.toggle("card-dim", !enabled);
  headerSub.textContent = enabled ? "Active" : "Disabled";
}

function applyUI(d) {
  enabledEl.checked = !!d.enabled;
  grayscaleEl.checked = !!d.grayscale;
  setActivePreset(d.quality ?? DEFAULTS.quality);
  updateEnabledUI(!!d.enabled);
}

async function loadSiteUI(d) {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return;
  }

  if (!tab?.url) {
    siteNameEl.textContent = "No active tab";
    excludeBtn.disabled = true;
    return;
  }

  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    siteNameEl.textContent = "Unknown";
    excludeBtn.disabled = true;
    return;
  }

  currentIsWeb = parsed.protocol === "http:" || parsed.protocol === "https:";
  currentHost = parsed.hostname.toLowerCase();

  if (!currentIsWeb) {
    siteNameEl.textContent = parsed.protocol.replace(":", "") + " page";
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Not a web page";
    excludeBtn.disabled = true;
    return;
  }

  siteNameEl.textContent = currentHost;
  excludeBtn.disabled = false;

  const excluded = parseDomains(d.excludeDomains);
  if (excluded.includes(currentHost)) {
    sitePillEl.textContent = "Excluded";
    sitePillEl.className = "site-pill excluded";
    sitePillEl.style.display = "";
    excludeBtn.textContent = "✕ Remove exclusion";
  } else {
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Exclude this site";
  }
}

async function load() {
  const d = await chrome.storage.sync.get(DEFAULTS);
  applyUI(d);
  loadSiteUI(d);
}

load();

enabledEl.addEventListener("change", async () => {
  const enabled = enabledEl.checked;
  await chrome.storage.sync.set({ enabled });
  updateEnabledUI(enabled);
  loadSiteUI(await chrome.storage.sync.get(DEFAULTS));
});

grayscaleEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ grayscale: grayscaleEl.checked });
  showNudge();
});

presetBtns.forEach((btn) => {
  btn.addEventListener("click", async () => {
    presetBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    await chrome.storage.sync.set({ quality: Number(btn.dataset.q) });
    showNudge();
  });
});

reloadBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.reload(tab.id);
  } catch {}
  window.close();
});

excludeBtn.addEventListener("click", async () => {
  if (!currentIsWeb || !currentHost) return;

  const d = await chrome.storage.sync.get(DEFAULTS);
  const list = new Set(parseDomains(d.excludeDomains));
  if (list.has(currentHost)) list.delete(currentHost);
  else list.add(currentHost);

  await chrome.storage.sync.set({ excludeDomains: Array.from(list).join(" ") });
  loadSiteUI(await chrome.storage.sync.get(DEFAULTS));
});

settingsBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html") }).catch(() => chrome.runtime.openOptionsPage?.());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  chrome.storage.sync.get(DEFAULTS, applyUI);
});
