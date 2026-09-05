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

const qualityPresets = Array.from(document.querySelectorAll("#qualityPresets .preset"));
const widthPresets = Array.from(document.querySelectorAll("#widthPresets .preset"));

const QUALITY_PRESETS = [20, 40, 80];
const WIDTH_PRESETS = [1280, 1920, 0];

let toastTimer;

function showToast(msg, type = "") {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = ["toast", "show", type].filter(Boolean).join(" ");
  toastTimer = setTimeout(() => {
    toastEl.className = "toast";
  }, type === "err" ? 3500 : 1800);
}

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(2) + " KB";
  return n + " B";
}

function setQualityUI(q) {
  qualityPresets.forEach((b) => b.classList.toggle("active", Number(b.dataset.q) === q));
  customQualityEl.value = QUALITY_PRESETS.includes(q) ? "" : q;
}

function setWidthUI(w) {
  widthPresets.forEach((b) => b.classList.toggle("active", Number(b.dataset.w) === w));
  customWidthEl.value = WIDTH_PRESETS.includes(w) ? "" : w;
}

function readQuality() {
  const custom = parseInt(customQualityEl.value, 10);
  if (!Number.isNaN(custom) && custom >= 1 && custom <= 100) return custom;
  const active = qualityPresets.find((b) => b.classList.contains("active"));
  return active ? Number(active.dataset.q) : DEFAULTS.quality;
}

function readWidth() {
  const custom = parseInt(customWidthEl.value, 10);
  if (!Number.isNaN(custom) && custom >= 0) return custom;
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
  setQualityUI(d.quality ?? DEFAULTS.quality);
  setWidthUI(d.maxWidth ?? DEFAULTS.maxWidth);

  const s = await chrome.storage.local.get({
    stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 },
  });
  const st = s.stats || {};
  const pct = st.bytesProcessed > 0 ? Math.round((st.bytesSaved / st.bytesProcessed) * 100) : 0;
  statImagesEl.textContent = (st.filesProcessed || 0).toLocaleString();
  statBytesEl.textContent = fmtBytes(st.bytesSaved) + (pct > 0 ? ` (${pct}%)` : "");
}

load();

qualityPresets.forEach((btn) => {
  btn.addEventListener("click", () => {
    qualityPresets.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    customQualityEl.value = "";
  });
});

customQualityEl.addEventListener("input", () => {
  const v = parseInt(customQualityEl.value, 10);
  if (!Number.isNaN(v) && v >= 1 && v <= 100) {
    qualityPresets.forEach((b) => b.classList.remove("active"));
  } else if (customQualityEl.value === "") {
    setQualityUI(DEFAULTS.quality);
  }
});

widthPresets.forEach((btn) => {
  btn.addEventListener("click", () => {
    widthPresets.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    customWidthEl.value = "";
  });
});

customWidthEl.addEventListener("input", () => {
  const v = parseInt(customWidthEl.value, 10);
  if (!Number.isNaN(v) && v >= 0) {
    widthPresets.forEach((b) => b.classList.remove("active"));
  } else if (customWidthEl.value === "") {
    setWidthUI(DEFAULTS.maxWidth);
  }
});

enabledEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: !!enabledEl.checked });
  showToast(enabledEl.checked ? "Compression enabled" : "Compression disabled", "ok");
});

grayscaleEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ grayscale: !!grayscaleEl.checked });
  showToast("Reload the page to apply", "warn");
});

function isValidUrl(str) {
  if (!str) return true;
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function save() {
  const proxyBase = (proxyBaseEl.value || "").trim();

  if (!isValidUrl(proxyBase)) {
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
    excludeDomains: (excludeEl.value || "").trim(),
  });

  showToast("Saved", "ok");
}

async function resetAll() {
  await chrome.storage.sync.set(DEFAULTS);
  await load();
  showToast("Reset to defaults");
}

async function resetStats() {
  await chrome.storage.local.set({
    stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 },
  });
  await load();
  showToast("Stats cleared");
}

function fetchWithTimeout(url, ms) {
  if (typeof AbortSignal?.timeout === "function") {
    return fetch(url, { signal: AbortSignal.timeout(ms) });
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function testProxy() {
  const url = (proxyBaseEl.value || "").trim();
  if (!url) {
    showToast("Enter a proxy URL first", "err");
    return;
  }
  if (!isValidUrl(url)) {
    proxyBaseEl.classList.add("invalid");
    showToast("URL must be http:// or https://", "err");
    return;
  }

  proxyBaseEl.classList.remove("invalid");

  const orig = testProxyBtn.textContent;
  testProxyBtn.textContent = "Testing…";
  testProxyBtn.disabled = true;

  try {
    const res = await fetchWithTimeout(url, 8000);
    const body = await res.text();

    if (res.ok && body.trim() === "bandwidth-hero-proxy") {
      showToast("Proxy is working ✓", "ok");
    } else if (res.ok) {
      showToast(`Proxy responded (${res.status}) — identity string not found`, "");
    } else {
      showToast(`Proxy returned HTTP ${res.status}`, "err");
    }
  } catch (e) {
    if (e.name === "AbortError" || e.name === "TimeoutError") {
      showToast("Timed out — proxy not reachable", "err");
    } else {
      showToast("Connection failed — check URL and CORS", "err");
    }
  } finally {
    testProxyBtn.textContent = orig;
    testProxyBtn.disabled = false;
  }
}

saveBtn.addEventListener("click", save);
resetAllBtn.addEventListener("click", resetAll);
resetStatsBtn.addEventListener("click", resetStats);
testProxyBtn.addEventListener("click", testProxy);

proxyBaseEl.addEventListener("input", () => proxyBaseEl.classList.remove("invalid"));

[proxyBaseEl, excludeEl, customQualityEl, customWidthEl].forEach((el) => {
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  });
});
