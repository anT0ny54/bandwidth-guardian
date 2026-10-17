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
const customWidthEl  = $("customWidth");

const qualityPresets = Array.from(document.querySelectorAll("#qualityPresets .preset"));
const widthPresets   = Array.from(document.querySelectorAll("#widthPresets  .preset"));

const QUALITY_PRESETS = [45, 60, 80];
const WIDTH_PRESETS   = [768, 1024, 0];
const WIDTH_MAX       = 16384; // mirrors the customWidth input's max attribute
let savedQuality = DEFAULTS.quality;
let savedWidth   = DEFAULTS.maxWidth;

// B2: track fields the user has edited since load/save so incoming sync
// changes (e.g. the popup's "Exclude this site") never clobber unsaved edits.
// quality and maxWidth gate ONLY on their own dirty flag — they are
// independent fields, and an unsaved width edit must not block an incoming
// quality change (or vice versa).
const dirty = { proxyBase: false, excludeDomains: false, quality: false, width: false };

// B14: Settings remembers the tab that opened it (?tab=<id> from the popup).
// Number.isInteger rejects values like "1.5" that Number() would pass.
const openerTabId = (() => {
  const raw = new URLSearchParams(location.search).get("tab");
  const v = Number(raw);
  return raw !== null && Number.isInteger(v) && v > 0 ? v : null;
})();

versionEl.textContent = `v${chrome.runtime.getManifest().version}`;

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
  const own = chrome.runtime.getURL(""); // this extension's own pages
  // Own pages (options.html) are skipped by PREFIX, not by a bare
  // /options\.html$/ suffix — a real website ending in options.html must
  // still reload.
  const isHttpPage = url => /^https?:\/\//i.test(String(url || "")) && !String(url || "").startsWith(own);
  // B14: prefer the tab that opened Settings.
  if (openerTabId != null) {
    try {
      const t = await chrome.tabs.get(openerTabId);
      if (t?.id != null && isHttpPage(t.url)) { await chrome.tabs.reload(t.id); return; }
    } catch {}
  }
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id && isHttpPage(active.url)) { await chrome.tabs.reload(active.id); return; }
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const page = tabs
      .filter(tab => tab.id != null && isHttpPage(tab.url))
      .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
    if (page?.id) await chrome.tabs.reload(page.id);
  } catch {}
}

// ── Preset helpers ────────────────────────────────────────────────────────────

// B16: exact match, or a visible "Custom" badge. One badge PER CONTAINER via a
// WeakMap: the quality row and the width row each keep their own badge, and
// clearing one never removes the other's.
const badges = new WeakMap();
function setCustomBadge(container, show) {
  if (!container) return;
  const badge = badges.get(container);
  if (show && !badge) {
    const el = document.createElement("span");
    el.textContent = "Custom";
    el.style.cssText = "font-size:11px;opacity:.65;margin-left:8px;vertical-align:middle;";
    container.appendChild(el);
    badges.set(container, el);
  } else if (!show && badge) {
    badge.remove();
    badges.delete(container);
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
  if (!isNaN(v) && v >= 0 && v <= WIDTH_MAX) return v;
  const active = widthPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.w ?? 0) : savedWidth;
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  let d, s;
  try {
    [d, s] = await Promise.all([
      chrome.storage.sync.get(DEFAULTS),
      chrome.storage.local.get({ stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } })
    ]);
  } catch { showToast("Could not load settings", "err"); return; }
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

// Live stats counter while this page is open (worker flushes in batches).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stats) renderStats(changes.stats.newValue);
});

// B2: stay in sync with changes made elsewhere (popup toggles, popup
// exclusions, second Settings window). Fields with unsaved edits win; each
// field gates ONLY on its own dirty flag (quality vs. width are independent).
chrome.storage.onChanged.addListener((changes, area) => {
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
  if (!isNaN(v) && v >= 0 && v <= WIDTH_MAX) {
    widthPresets.forEach(b => b.classList.remove("active"));
    setCustomBadge($("widthPresets"), true);
  } else if (customWidthEl.value === "") {
    dirty.width = false;
    setWidthUI(savedWidth);
  }
});

proxyBaseEl.addEventListener("input", () => { dirty.proxyBase = true; proxyBaseEl.classList.remove("invalid"); });
excludeEl.addEventListener("input", () => { dirty.excludeDomains = true; });

// Surface the tracked dirty flag as an unsaved-changes warning.
window.addEventListener("beforeunload", e => {
  if (Object.values(dirty).some(Boolean)) { e.preventDefault(); e.returnValue = ""; }
});

// ── Auto-save: enable + grayscale + saveData ──────────────────────────────────

enabledEl.addEventListener("change", async () => {
  try { await chrome.storage.sync.set({ enabled: !!enabledEl.checked }); }
  catch { showToast("Save failed", "err"); return; }
  showToast(enabledEl.checked ? "Compression enabled" : "Compression disabled", "ok");
});

grayscaleEl.addEventListener("change", async () => {
  try { await chrome.storage.sync.set({ grayscale: !!grayscaleEl.checked }); }
  catch { showToast("Save failed", "err"); return; }
  showToast("Reload the page to apply", "warn");
});

saveDataEl.addEventListener("change", async () => {
  try { await chrome.storage.sync.set({ saveData: !!saveDataEl.checked }); }
  catch { showToast("Save failed", "err"); return; }
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
  if (cw !== "" && (!/^\d+$/.test(cw) || +cw < 0 || +cw > WIDTH_MAX)) {
    showToast(`Width must be 0–${WIDTH_MAX}`, "err");
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
  let current;
  try { current = await chrome.storage.sync.get(DEFAULTS); }
  catch { showToast("Save failed", "err"); return; }

  try { await chrome.storage.sync.set({ proxyBase, quality, maxWidth, excludeDomains }); }
  catch { showToast("Save failed", "err"); return; }

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
    // Read with a hard 64 KB cap: the probe only needs the marker string, and
    // an unbounded res.text() would download whatever the server streams.
    let body = "";
    const reader = res.body?.getReader?.();
    if (reader) {
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        body += dec.decode(value, { stream: true });
        if (body.length > 65536) { try { await reader.cancel(); } catch {} break; }
      }
    }
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
  if (!confirm("Reset ALL settings to defaults?")) return;
  try {
    await chrome.storage.sync.set(DEFAULTS);
    await load();
    await reloadCurrentPage();
  } catch { showToast("Reset failed", "err"); return; }
  showToast("Reset to defaults");
}

async function resetStats() {
  if (!confirm("Clear all saved-bandwidth statistics?")) return;
  // Only touch the stats: load() would also overwrite unsaved form edits.
  try {
    await chrome.storage.local.set({ stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } });
  } catch { showToast("Clear failed", "err"); return; }
  renderStats(null);
  showToast("Stats cleared");
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
