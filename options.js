import { DEFAULTS } from "./defaults.js";

const $ = (id) => document.getElementById(id);
const enabledEl = $("enabled");
const grayscaleEl = $("grayscale");
const proxyBaseEl = $("proxyBase");
const testProxyBtn = $("testProxy");
const excludeEl = $("excludeDomains");
const saveBtn = $("save");
const resetAllBtn = $("resetAll");
const resetStatsBtn = $("resetStats");
const statImagesEl = $("statImages");
const statBytesEl = $("statBytes");
const toastEl = $("toast");
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

async function load() {
  const d = await chrome.storage.sync.get(DEFAULTS);
  enabledEl.checked = !!d.enabled;
  grayscaleEl.checked = !!d.grayscale;
  proxyBaseEl.value = d.proxyBase || "";
  excludeEl.value = d.excludeDomains || "";
  proxyBaseEl.classList.remove("invalid");
  setQualityUI(Number.isFinite(d.quality) ? d.quality : DEFAULTS.quality);
  setWidthUI(Number.isFinite(d.maxWidth) ? d.maxWidth : DEFAULTS.maxWidth);

  const { stats = STATS_DEFAULT } = await chrome.storage.local.get({ stats: STATS_DEFAULT });
  const saved = Number(stats.bytesSaved) || 0;
  const processed = Number(stats.bytesProcessed) || 0;
  const pct = processed > 0 ? Math.round((saved / processed) * 100) : 0;
  statImagesEl.textContent = (Number(stats.filesProcessed) || 0).toLocaleString();
  statBytesEl.textContent = fmtBytes(saved) + (pct > 0 ? ` (${pct}%)` : "");
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
  const proxyBase = proxyBaseEl.value.trim();
  if (!isValidProxyURL(proxyBase)) {
    proxyBaseEl.classList.add("invalid");
    showToast("Proxy URL must be http:// or https://", "err");
    proxyBaseEl.focus();
    return;
  }

  proxyBaseEl.classList.remove("invalid");
  await chrome.storage.sync.set({
    proxyBase,
    quality: readQuality(),
    maxWidth: readWidth(),
    excludeDomains: excludeEl.value.trim(),
  });
  showToast("Saved", "ok");
}

async function resetAll() {
  await chrome.storage.sync.set(DEFAULTS);
  await load();
  showToast("Reset to defaults");
}

async function resetStats() {
  await chrome.storage.local.set({ stats: { ...STATS_DEFAULT } });
  await load();
  showToast("Stats cleared");
}

function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function testProxy() {
  const url = proxyBaseEl.value.trim();
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

enabledEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: enabledEl.checked });
  showToast(enabledEl.checked ? "Compression enabled" : "Compression disabled", "ok");
});
grayscaleEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ grayscale: grayscaleEl.checked });
  showToast("Reload the page to apply", "warn");
});

saveBtn.addEventListener("click", save);
resetAllBtn.addEventListener("click", resetAll);
resetStatsBtn.addEventListener("click", resetStats);
testProxyBtn.addEventListener("click", testProxy);
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
