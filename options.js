import { DEFAULTS, normalizeProxyBase } from "./defaults.js";

const $ = (id) => document.getElementById(id);
const enabledEl = $("enabled");
const grayscaleEl = $("grayscale");
const failoverOriginalEl = $("failoverOriginal");
const proxyBaseEl = $("proxyBase");
const testProxyBtn = $("testProxy");
const excludeEl = $("excludeDomains");
const saveBtn = $("save");
const resetAllBtn = $("resetAll");
const resetStatsBtn = $("resetStats");
const statImagesEl = $("statImages");
const statBytesEl = $("statBytes");
const statDirectEl = $("statDirect");
const toastEl = $("toast");
const checkUpdateBtn = $("checkUpdate");
const updateStatusEl = $("updateStatus");
const sourceVersionEl = $("sourceVersion");
const updateCurrentEl = $("updateCurrent");
const customQualityEl = $("customQuality");
const customWidthEl = $("customWidth");
const qualityPresets = [...document.querySelectorAll("#qualityPresets .preset")];
const widthPresets = [...document.querySelectorAll("#widthPresets .preset")];

const QUALITY_PRESETS = new Set([20, 40, 80]);
const WIDTH_PRESETS = new Set([1280, 1920, 0]);
const STATS_DEFAULT = { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 };
let toastTimer;

function showToast(message, type = "") {
  clearTimeout(toastTimer);
  toastEl.textContent = message;
  toastEl.className = ["toast", "show", type].filter(Boolean).join(" ");
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, type === "err" ? 3500 : 1800);
}

function fmtBytes(value) {
  const n = Number(value) || 0;
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(2)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(2)} KB`;
  return `${n} B`;
}


function setQualityUI(value) {
  qualityPresets.forEach((button) => button.classList.toggle("active", Number(button.dataset.q) === value));
  customQualityEl.value = QUALITY_PRESETS.has(value) ? "" : value;
}
function setWidthUI(value) {
  widthPresets.forEach((button) => button.classList.toggle("active", Number(button.dataset.w) === value));
  customWidthEl.value = WIDTH_PRESETS.has(value) ? "" : value;
}
function readQuality() {
  const custom = Number.parseInt(customQualityEl.value, 10);
  if (Number.isInteger(custom) && custom >= 1 && custom <= 100) return custom;
  const active = qualityPresets.find((b) => b.classList.contains("active"));
  return active ? Number(active.dataset.q) : DEFAULTS.quality;
}
function readWidth() {
  const custom = Number.parseInt(customWidthEl.value, 10);
  if (Number.isInteger(custom) && custom >= 0) return custom;
  const active = widthPresets.find((b) => b.classList.contains("active"));
  return active ? Number(active.dataset.w) : DEFAULTS.maxWidth;
}

function renderVersion() {
  const version = String(chrome.runtime.getManifest().version || "0.0.0");
  const label = `v${version}`;
  sourceVersionEl.textContent = label;
  updateCurrentEl.textContent = label;
  updateStatusEl.textContent = `Installed version: ${label}`;
}

function normalizeSettings(raw = {}) {
  const d = { ...DEFAULTS, ...raw };
  d.enabled = d.enabled !== false;
  d.grayscale = d.grayscale !== false;
  d.failoverOriginal = d.failoverOriginal !== false;
  d.quality = Number.isInteger(Number(d.quality)) && Number(d.quality) >= 1 && Number(d.quality) <= 100
    ? Number(d.quality) : DEFAULTS.quality;
  d.maxWidth = Number.isInteger(Number(d.maxWidth)) && Number(d.maxWidth) >= 0
    ? Number(d.maxWidth) : DEFAULTS.maxWidth;
  d.mobileMaxWidth = Number.isInteger(Number(d.mobileMaxWidth)) && Number(d.mobileMaxWidth) > 0
    ? Number(d.mobileMaxWidth) : DEFAULTS.mobileMaxWidth;
  d.proxyBase = normalizeProxyBase(d.proxyBase);
  d.excludeDomains = String(d.excludeDomains ?? DEFAULTS.excludeDomains);
  return d;
}

async function load() {
  renderVersion();
  const raw = await chrome.storage.sync.get(DEFAULTS);
  const d = normalizeSettings(raw);
  enabledEl.checked = d.enabled;
  grayscaleEl.checked = d.grayscale;
  failoverOriginalEl.checked = d.failoverOriginal;
  proxyBaseEl.value = d.proxyBase;
  excludeEl.value = d.excludeDomains;
  proxyBaseEl.classList.remove("invalid");
  setQualityUI(d.quality);
  setWidthUI(d.maxWidth);

  const { stats = STATS_DEFAULT } = await chrome.storage.local.get({ stats: STATS_DEFAULT });
  const saved = Number(stats.bytesSaved) || 0;
  const processed = Number(stats.bytesProcessed) || 0;
  const pct = processed > 0 ? Math.round((saved / processed) * 100) : 0;
  statImagesEl.textContent = (Number(stats.filesProcessed) || 0).toLocaleString();
  statBytesEl.textContent = fmtBytes(saved) + (pct > 0 ? ` (${pct}%)` : "");
  statDirectEl.textContent = fmtBytes(Number(stats.directImageBytes) || 0);
}

function isValidProxyURL(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.hostname;
  } catch {
    return false;
  }
}

function parseCustomInput(input, min, max = Infinity) {
  const value = Number.parseInt(input.value, 10);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

async function save() {
  const proxyBase = normalizeProxyBase(proxyBaseEl.value);
  if (!isValidProxyURL(proxyBase)) {
    proxyBaseEl.classList.add("invalid");
    showToast("Proxy URL must be http:// or https://", "err");
    proxyBaseEl.focus();
    return;
  }

  proxyBaseEl.classList.remove("invalid");
  const settings = {
    enabled: enabledEl.checked,
    grayscale: grayscaleEl.checked,
    failoverOriginal: failoverOriginalEl.checked,
    proxyBase,
    quality: readQuality(),
    maxWidth: readWidth(),
    mobileMaxWidth: DEFAULTS.mobileMaxWidth,
    excludeDomains: excludeEl.value.trim(),
  };
  await chrome.storage.sync.set(settings);
  await load();
  showToast("Settings saved", "ok");
}

async function resetAll() {
  // Remove stale/legacy keys first, then write one complete recommended profile.
  // Stats live in storage.local and are intentionally preserved.
  await chrome.storage.sync.clear();
  await chrome.storage.sync.set({ ...DEFAULTS });
  await load();
  showToast("Restored recommended defaults", "ok");
}

async function resetStats() {
  await chrome.storage.local.set({ stats: { ...STATS_DEFAULT } });
  await load();
  showToast("Stats cleared");
}

async function checkForUpdate() {
  const current = chrome.runtime.getManifest().version;
  checkUpdateBtn.disabled = true;
  updateStatusEl.textContent = `Checking GitHub for a newer version than v${current}…`;
  try {
    const response = await fetchWithTimeout(
      "https://raw.githubusercontent.com/anT0ny54/bandwidth-guardian/main/manifest.json",
      7000
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const remote = await response.json();
    const latest = String(remote.version || "");
    if (!/^\d+(?:\.\d+){1,3}$/.test(latest)) throw new Error("Invalid version");
    const cmp = (a,b) => {
      const aa=a.split(".").map(Number), bb=b.split(".").map(Number);
      for(let i=0;i<Math.max(aa.length,bb.length);i++){ const x=aa[i]||0,y=bb[i]||0; if(x!==y)return x-y; }
      return 0;
    };
    if (cmp(latest, current) > 0) {
      updateStatusEl.textContent = `v${latest} is available. Download it from GitHub Releases.`;
      showToast(`Update available: v${latest}`, "ok");
    } else {
      updateStatusEl.textContent = `You are up to date (v${current}).`;
      showToast("Already up to date", "ok");
    }
  } catch (error) {
    updateStatusEl.textContent = "Could not check GitHub right now. You can check Releases manually.";
    showToast("Update check failed", "err");
  } finally {
    checkUpdateBtn.disabled = false;
  }
}

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function testProxy() {
  const url = normalizeProxyBase(proxyBaseEl.value);
  if (!url) return showToast("Enter a proxy URL first", "err");
  if (!isValidProxyURL(url)) {
    proxyBaseEl.classList.add("invalid");
    return showToast("URL must be http:// or https://", "err");
  }

  const originalText = testProxyBtn.textContent;
  testProxyBtn.textContent = "Testing…";
  testProxyBtn.disabled = true;
  try {
    const response = await fetchWithTimeout(url, 8000);
    const body = await response.text();
    if (response.ok && body.trim() === "bandwidth-hero-proxy") showToast("Proxy is working ✓", "ok");
    else if (response.ok) showToast(`Proxy responded (${response.status}) — identity string not found`);
    else showToast(`Proxy returned HTTP ${response.status}`, "err");
  } catch (error) {
    showToast(error?.name === "AbortError" ? "Timed out — proxy not reachable" : "Connection failed — check URL and CORS", "err");
  } finally {
    testProxyBtn.textContent = originalText;
    testProxyBtn.disabled = false;
  }
}

qualityPresets.forEach((button) => button.addEventListener("click", () => {
  qualityPresets.forEach((b) => b.classList.remove("active"));
  button.classList.add("active");
  customQualityEl.value = "";
}));
customQualityEl.addEventListener("input", () => {
  if (customQualityEl.value === "") return setQualityUI(DEFAULTS.quality);
  if (parseCustomInput(customQualityEl, 1, 100) !== null) qualityPresets.forEach((b) => b.classList.remove("active"));
});

widthPresets.forEach((button) => button.addEventListener("click", () => {
  widthPresets.forEach((b) => b.classList.remove("active"));
  button.classList.add("active");
  customWidthEl.value = "";
}));
customWidthEl.addEventListener("input", () => {
  if (customWidthEl.value === "") return setWidthUI(DEFAULTS.maxWidth);
  if (parseCustomInput(customWidthEl, 0) !== null) widthPresets.forEach((b) => b.classList.remove("active"));
});

// Options page edits are committed by the Save button. This prevents
// partially changed settings when the user is still configuring the page.

saveBtn.addEventListener("click", save);
resetAllBtn.addEventListener("click", resetAll);
resetStatsBtn.addEventListener("click", resetStats);
testProxyBtn.addEventListener("click", testProxy);
checkUpdateBtn.addEventListener("click", () => void checkForUpdate());
proxyBaseEl.addEventListener("input", () => proxyBaseEl.classList.remove("invalid"));

[proxyBaseEl, excludeEl, customQualityEl, customWidthEl].forEach((el) => {
  el.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    }
  });
});

void load();
