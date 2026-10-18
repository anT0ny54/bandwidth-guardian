import { DEFAULTS } from "./defaults.js";

const $ = id => document.getElementById(id);

const enabledEl      = $("enabled");
const grayscaleEl    = $("grayscale");
const saveDataEl     = $("saveData");
const proxyBaseEl    = $("proxyBase");
const testProxyBtn   = $("testProxy");
const excludeEl      = $("excludeDomains");
const saveBtn        = $("save");
const resetAllBtn    = $("resetAll");
const resetStatsBtn  = $("resetStats");
const statImagesEl   = $("statImages");
const statBytesEl    = $("statBytes");
const statSavedEl    = $("statSaved");
const toastEl        = $("toast");
const versionEl      = $("extensionVersion");
const customQualityEl = $("customQuality");
const customWidthEl   = $("customWidth");

const qualityPresets = Array.from(document.querySelectorAll("#qualityPresets .preset"));
const widthPresets   = Array.from(document.querySelectorAll("#widthPresets  .preset"));

// Preset values come from the buttons themselves, so HTML and JS cannot drift.
const QUALITY_PRESETS = qualityPresets.map(b => Number(b.dataset.q));
const WIDTH_PRESETS   = widthPresets.map(b => Number(b.dataset.w));
let savedQuality = DEFAULTS.quality;
let savedWidth   = DEFAULTS.maxWidth;

// B2: track fields the user has edited since load/save so incoming sync
// changes (e.g. the popup's "Exclude this site") never clobber unsaved edits.
const dirty = { proxyBase: false, excludeDomains: false, quality: false, width: false };

// B14: Settings remembers the tab that opened it (?tab=<id> from the popup).
const openerTabId = (() => {
  const v = Number(new URLSearchParams(location.search).get("tab"));
  return Number.isFinite(v) && v > 0 ? v : null;
})();

if (versionEl) {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
}

// ── Toast ─────────────────────────────────────────────────────────────────────

let toastTimer;
function showToast(msg, type = "") {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className   = ["toast", "show", type].filter(Boolean).join(" ");
  toastTimer = setTimeout(() => { toastEl.className = "toast"; }, type === "err" ? 3500 : 1800);
}

// ── Formatting ────────────────────────────────────────────────────────────────

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + " GB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + " MB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(2) + " KB";
  return n + " B";
}

async function reloadCurrentPage() {
  const isHttpUrl = url => /^https?:\/\//i.test(String(url || ""));
  // B14: prefer the tab that opened Settings. Only http(s) tabs qualify below,
  // so this page itself (chrome-extension://) can never be reloaded by mistake.
  if (openerTabId != null) {
    try { await chrome.tabs.reload(openerTabId); return; } catch {}
  }
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id && isHttpUrl(active.url)) {
      await chrome.tabs.reload(active.id);
      return;
    }
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const page = tabs
      .filter(tab => tab.id != null && isHttpUrl(tab.url))
      .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
    if (page?.id) await chrome.tabs.reload(page.id);
  } catch {}
}

// ── Preset helpers ────────────────────────────────────────────────────────────

// B16: exact match, or a visible "Custom" badge — the popup and options page
// now agree, and custom values no longer highlight a nearby preset.
// One badge per container: quality and width are customized independently.
const customBadges = new WeakMap();
function setCustomBadge(container, show) {
  if (!container) return;
  let badge = customBadges.get(container);
  if (show && !badge) {
    badge = document.createElement("span");
    badge.textContent = "Custom";
    badge.style.cssText = "font-size:11px;opacity:.65;margin-left:8px;vertical-align:middle;";
    container.appendChild(badge);
    customBadges.set(container, badge);
  } else if (!show && badge) {
    badge.remove();
    customBadges.delete(container);
  }
}

function setQualityUI(q) {
  q = Number(q);
  const matched = QUALITY_PRESETS.includes(q);
  qualityPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.q) === q));
  setCustomBadge($("qualityPresets"), !matched);
  customQualityEl.value = matched ? "" : String(q ?? "");
}

function setWidthUI(w) {
  w = Number(w) || 0;
  const matched = WIDTH_PRESETS.includes(w);
  widthPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.w) === w));
  setCustomBadge($("widthPresets"), !matched);
  customWidthEl.value = matched ? "" : String(w);
}

function readQuality() {
  const v = parseInt(customQualityEl.value, 10);
  if (!isNaN(v) && v >= 1 && v <= 100) return v;
  const active = qualityPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.q) : savedQuality;
}

function readWidth() {
  const v = parseInt(customWidthEl.value, 10);
  if (!isNaN(v) && v >= 0) return v;
  const active = widthPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.w ?? 0) : savedWidth;
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  const [d, s] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ stats: null })
  ]);
  enabledEl.checked    = !!d.enabled;
  grayscaleEl.checked  = !!d.grayscale;
  saveDataEl.checked   = !!d.saveData;
  proxyBaseEl.value    = d.proxyBase || "";
  proxyBaseEl.classList.remove("invalid");
  excludeEl.value      = d.excludeDomains || "";
  savedQuality = d.quality  ?? DEFAULTS.quality;
  savedWidth   = d.maxWidth ?? DEFAULTS.maxWidth;
  setQualityUI(savedQuality);
  setWidthUI(savedWidth);
  renderStats(s.stats);
  for (const k in dirty) dirty[k] = false;
}
load();

function renderStats(st) {
  st = st || {};
  statImagesEl.textContent = Number(st.filesProcessed || 0).toLocaleString();
  statBytesEl.textContent  = fmtBytes(Number(st.bytesProcessed || 0));
  statSavedEl.textContent  = fmtBytes(Number(st.bytesSaved || 0));
}

// Live stats counter while this page is open (worker flushes in batches), and
// B2: stay in sync with changes made elsewhere (popup toggles, popup
// exclusions, second Settings window). Fields with unsaved edits win.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.stats) renderStats(changes.stats.newValue);
    return;
  }
  if (area !== "sync") return;
  if (changes.enabled)    enabledEl.checked   = !!changes.enabled.newValue;
  if (changes.grayscale)  grayscaleEl.checked = !!changes.grayscale.newValue;
  if (changes.saveData)   saveDataEl.checked  = !!changes.saveData.newValue;
  if (changes.proxyBase && !dirty.proxyBase) {
    proxyBaseEl.value = changes.proxyBase.newValue || "";
    proxyBaseEl.classList.remove("invalid");
  }
  if (changes.excludeDomains && !dirty.excludeDomains) {
    excludeEl.value = changes.excludeDomains.newValue || "";
  }
  if (changes.quality && !dirty.quality) {
    savedQuality = changes.quality.newValue ?? DEFAULTS.quality;
    setQualityUI(savedQuality);
  }
  if (changes.maxWidth && !dirty.width) {
    savedWidth = changes.maxWidth.newValue ?? DEFAULTS.maxWidth;
    setWidthUI(savedWidth);
  }
});

// ── Preset buttons ────────────────────────────────────────────────────────────

qualityPresets.forEach(btn => {
  btn.addEventListener("click", () => {
    dirty.quality = true; // Preset changes are unsaved edits too.
    qualityPresets.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    customQualityEl.value = ""; // preset takes priority; clear custom
    setCustomBadge($("qualityPresets"), false);
  });
});

customQualityEl.addEventListener("input", () => {
  dirty.quality = true;
  const v = parseInt(customQualityEl.value, 10);
  if (!isNaN(v) && v >= 1 && v <= 100) {
    qualityPresets.forEach(b => b.classList.remove("active"));
    setCustomBadge($("qualityPresets"), true);
  } else if (customQualityEl.value === "") {
    dirty.quality = false;
    setQualityUI(savedQuality);
  }
});

widthPresets.forEach(btn => {
  btn.addEventListener("click", () => {
    dirty.width = true; // Preset changes are unsaved edits too.
    widthPresets.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    customWidthEl.value = "";
    setCustomBadge($("widthPresets"), false);
  });
});

customWidthEl.addEventListener("input", () => {
  dirty.width = true;
  const v = parseInt(customWidthEl.value, 10);
  if (!isNaN(v) && v >= 0) {
    widthPresets.forEach(b => b.classList.remove("active"));
    setCustomBadge($("widthPresets"), true);
  } else if (customWidthEl.value === "") {
    dirty.width = false;
    setWidthUI(savedWidth);
  }
});

proxyBaseEl.addEventListener("input", () => { dirty.proxyBase = true; proxyBaseEl.classList.remove("invalid"); });
excludeEl.addEventListener("input", () => { dirty.excludeDomains = true; });

// ── Auto-save: enable + grayscale + saveData ──────────────────────────────────

enabledEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ enabled: !!enabledEl.checked });
  showToast(enabledEl.checked ? "Compression enabled" : "Compression disabled", "ok");
});

grayscaleEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ grayscale: !!grayscaleEl.checked });
  showToast("Reload the page to apply", "warn");
});

saveDataEl.addEventListener("change", async () => {
  await chrome.storage.sync.set({ saveData: !!saveDataEl.checked });
  showToast(saveDataEl.checked ? "Save-Data header enabled" : "Save-Data header disabled", "ok");
});

// ── Save ──────────────────────────────────────────────────────────────────────

async function save() {
  const cq = customQualityEl.value.trim();
  const cw = customWidthEl.value.trim();
  if (cq !== "" && !(/^\d+$/.test(cq) && +cq >= 1 && +cq <= 100)) {
    showToast("Quality must be 1–100", "err");
    return;
  }
  if (cw !== "" && !/^\d+$/.test(cw)) {
    showToast("Width must be 0 or a positive number", "err");
    return;
  }
  const proxyBase = (proxyBaseEl.value || "").trim();
  // B3: an empty proxyBase is allowed — it means "proxying disabled". Validate
  // only when a value was entered, so quality/width/exclusions are savable
  // without a proxy and the proxy can actually be cleared.
  if (proxyBase !== "") {
    try {
      const parsedProxy = new URL(proxyBase);
      if (parsedProxy.protocol !== "http:" && parsedProxy.protocol !== "https:") throw new Error("bad protocol");
    } catch {
      proxyBaseEl.classList.add("invalid");
      showToast("Proxy URL must be a valid http:// or https:// URL", "err");
      proxyBaseEl.focus();
      return;
    }
  }
  const quality = readQuality();
  const maxWidth = readWidth();
  const excludeDomains = (excludeEl.value || "").trim();
  const current = await chrome.storage.sync.get(DEFAULTS);

  await chrome.storage.sync.set({ proxyBase, quality, maxWidth, excludeDomains });

  if (proxyBase !== String(current.proxyBase || "") ||
      quality  !== Number(current.quality  ?? DEFAULTS.quality) ||
      maxWidth !== Number(current.maxWidth ?? DEFAULTS.maxWidth) ||
      excludeDomains !== String(current.excludeDomains || "")) {
    await reloadCurrentPage();
  }

  savedQuality = quality;
  savedWidth   = maxWidth;
  setQualityUI(quality);
  setWidthUI(maxWidth);
  for (const k in dirty) dirty[k] = false;
  showToast("Saved", "ok");
}

async function testProxy() {
  const url = (proxyBaseEl.value || "").trim();
  try {
    const parsedTest = new URL(url);
    if (parsedTest.protocol !== "http:" && parsedTest.protocol !== "https:") throw new Error("bad protocol");
  } catch { showToast("Enter a valid proxy URL first", "err"); return; }
  const orig = testProxyBtn.textContent;
  testProxyBtn.textContent = "Testing…"; testProxyBtn.disabled = true;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const body = await res.text();
    if (res.ok && body.trim() === "bandwidth-hero-proxy") showToast("Proxy is working ✓", "ok");
    else if (res.ok) showToast(`Proxy responded (${res.status})`, "warn");
    else showToast(`Proxy returned HTTP ${res.status}`, "err");
  } catch (e) {
    // B18: extension pages with <all_urls> are not CORS-restricted — say what
    // actually went wrong.
    showToast(e?.name === "AbortError" ? "Timed out — proxy not reachable" : "Connection failed — check the URL and that the proxy is running", "err");
  } finally {
    // B18: clear the timeout even on slow bodies and thrown errors.
    clearTimeout(timer);
    testProxyBtn.textContent = orig; testProxyBtn.disabled = false;
  }
}

testProxyBtn.addEventListener("click", testProxy);

// ── Reset ────────────────────────────────────────────────────────────────────

async function resetAll() {
  await chrome.storage.sync.set(DEFAULTS);
  await load();
  await reloadCurrentPage();
  showToast("Reset to defaults");
}

async function resetStats() {
  // The worker owns buffered deltas as well as the crash mirror; resetting only
  // storage.local.stats could make old counts reappear on the next flush.
  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "bh-reset-stats" }, response => {
        const error = chrome.runtime.lastError;
        if (error) reject(new Error(error.message));
        else if (!response?.ok) reject(new Error("Stats reset failed"));
        else resolve(response);
      });
    });
    renderStats(null);
    showToast("Stats cleared");
  } catch {
    showToast("Could not reset stats", "err");
  }
}

// ── Event wiring ──────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", save);
resetAllBtn.addEventListener("click", resetAll);
resetStatsBtn.addEventListener("click", resetStats);

// B19: Enter in the excluded-domains textarea inserts a newline; only the
// single-line fields submit the form.
[proxyBaseEl, customQualityEl, customWidthEl].forEach(el => {
  el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } });
});
