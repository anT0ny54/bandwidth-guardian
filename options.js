const BH = globalThis.__bhShared;
const { DEFAULTS, MAX_WIDTH_LIMIT } = BH;

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
const versionEl       = $("extensionVersion");
const customQualityEl = $("customQuality");
const customWidthEl   = $("customWidth");

const qualityPresets = Array.from(document.querySelectorAll("#qualityPresets .preset"));
const widthPresets   = Array.from(document.querySelectorAll("#widthPresets  .preset"));

const QUALITY_PRESETS = [45, 60, 80];
const WIDTH_PRESETS   = [768, 1024, 0];
// Last values loaded from storage, used to restore preset highlights when a
// custom input is cleared (previously this wrongly restored DEFAULTS).
let savedQuality = DEFAULTS.quality;
let savedWidth   = DEFAULTS.maxWidth;
// Fields edited here but not saved yet. Changes made elsewhere (popup
// "Exclude this site", another options tab) update every field that is NOT
// dirty, so Save never writes a stale value back over them.
const dirty = new Set();

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

// Binary (1024-based) sizes, labelled as such.
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1 << 30) return (n / (1 << 30)).toFixed(2) + " GiB";
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(2) + " MiB";
  if (n >= 1 << 10) return (n / (1 << 10)).toFixed(2) + " KiB";
  return n + " B";
}

async function reloadCurrentPage() {
  const isHttpUrl = url => /^https?:\/\//i.test(String(url || ""));
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id && isHttpUrl(active.url)) {
      await chrome.tabs.reload(active.id);
      return;
    }

    // When settings are opened in a new tab, the settings tab itself is active.
    // Prefer the most recently accessed HTTP(S) tab in the same window.
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const page = tabs
      .filter(tab => tab.id != null && isHttpUrl(tab.url))
      .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
    if (page?.id) await chrome.tabs.reload(page.id);
  } catch {}
}

// ── Preset helpers ────────────────────────────────────────────────────────────

// Quality presets: highlight the button whose value matches, or none for custom.
function setQualityUI(q) {
  qualityPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.q) === q));
  // Keep custom field in sync
  if (!QUALITY_PRESETS.includes(q)) {
    customQualityEl.value = q;
  } else {
    customQualityEl.value = "";
  }
}

// Width presets: same pattern.
function setWidthUI(w) {
  widthPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.w) === w));
  if (!WIDTH_PRESETS.includes(w)) {
    customWidthEl.value = w;
  } else {
    customWidthEl.value = "";
  }
}

// Read the currently selected quality value (preset or custom).
function readQuality() {
  const custom = parseInt(customQualityEl.value, 10);
  if (!isNaN(custom) && custom >= 1 && custom <= 100) return custom;
  const active = qualityPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.q) : DEFAULTS.quality;
}

// Read the currently selected width value (preset or custom).
function readWidth() {
  const custom = parseInt(customWidthEl.value, 10);
  if (!isNaN(custom) && custom >= 0) return custom;
  const active = widthPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.w) : DEFAULTS.maxWidth;
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  const [d, s] = await Promise.all([
    chrome.storage.sync.get(DEFAULTS),
    chrome.storage.local.get({ stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } })
  ]);
  enabledEl.checked   = !!d.enabled;
  grayscaleEl.checked = !!d.grayscale;
  saveDataEl.checked   = !!d.saveData;
  proxyBaseEl.value   = d.proxyBase || "";
  proxyBaseEl.classList.remove("invalid");
  excludeEl.value     = d.excludeDomains || "";
  savedQuality = d.quality  ?? DEFAULTS.quality;
  savedWidth   = d.maxWidth ?? DEFAULTS.maxWidth;
  setQualityUI(savedQuality);
  setWidthUI(savedWidth);
  dirty.clear();

  renderStats(s.stats);
}
load();

function renderStats(st) {
  st = st || {};
  statImagesEl.textContent = Number(st.filesProcessed || 0).toLocaleString();
  statBytesEl.textContent  = fmtBytes(Number(st.bytesProcessed || 0));
  statSavedEl.textContent  = fmtBytes(Number(st.bytesSaved || 0));
}

// Keep the counters live while this page is open (the service worker flushes in batches).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stats) renderStats(changes.stats.newValue);
  if (area !== "sync") return;
  const val = k => changes[k].newValue ?? DEFAULTS[k];
  if ("enabled" in changes)   enabledEl.checked   = !!val("enabled");
  if ("grayscale" in changes) grayscaleEl.checked = !!val("grayscale");
  if ("saveData" in changes)  saveDataEl.checked  = !!val("saveData");
  if ("proxyBase" in changes && !dirty.has("proxyBase")) proxyBaseEl.value = val("proxyBase") || "";
  if ("excludeDomains" in changes && !dirty.has("excludeDomains")) excludeEl.value = val("excludeDomains") || "";
  if ("quality" in changes && !dirty.has("quality")) { savedQuality = val("quality"); setQualityUI(savedQuality); }
  if ("maxWidth" in changes && !dirty.has("maxWidth")) { savedWidth = val("maxWidth"); setWidthUI(savedWidth); }
});

// ── Quality preset buttons ────────────────────────────────────────────────────

qualityPresets.forEach(btn => {
  btn.addEventListener("click", () => {
    qualityPresets.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    customQualityEl.value = ""; // preset takes priority; clear custom
    dirty.add("quality");
  });
});

// Custom quality input — deselects all presets when user types a value.
customQualityEl.addEventListener("input", () => {
  dirty.add("quality");
  const v = parseInt(customQualityEl.value, 10);
  if (!isNaN(v) && v >= 1 && v <= 100) {
    qualityPresets.forEach(b => b.classList.remove("active"));
  } else if (customQualityEl.value === "") {
    // Restore the saved value's highlight when field is cleared
    setQualityUI(savedQuality);
  }
});

// ── Max-width preset buttons ──────────────────────────────────────────────────

widthPresets.forEach(btn => {
  btn.addEventListener("click", () => {
    widthPresets.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    customWidthEl.value = "";
    dirty.add("maxWidth");
  });
});

customWidthEl.addEventListener("input", () => {
  dirty.add("maxWidth");
  const v = parseInt(customWidthEl.value, 10);
  if (!isNaN(v) && v >= 0) {
    widthPresets.forEach(b => b.classList.remove("active"));
  } else if (customWidthEl.value === "") {
    setWidthUI(savedWidth);
  }
});

// ── Auto-save: enable + grayscale ────────────────────────────────────────────
// These two feel like instant switches; everything else uses the Save button.

enabledEl.addEventListener("change", async () => {
  await BH.saveSettings({ enabled: !!enabledEl.checked });
  showToast(enabledEl.checked ? "Compression enabled" : "Compression disabled", "ok");
});

grayscaleEl.addEventListener("change", async () => {
  await BH.saveSettings({ grayscale: !!grayscaleEl.checked });
  showToast("Reload the page to apply", "warn");
});

saveDataEl.addEventListener("change", async () => {
  await BH.saveSettings({ saveData: !!saveDataEl.checked });
  showToast(saveDataEl.checked ? "Save-Data header enabled" : "Save-Data header disabled", "ok");
});

// ── Save ──────────────────────────────────────────────────────────────────────

async function save() {
  // Reject invalid custom values instead of silently falling back to a preset.
  const cq = customQualityEl.value.trim();
  const cw = customWidthEl.value.trim();
  if (cq !== "" && !(/^\d+$/.test(cq) && +cq >= 1 && +cq <= 100)) {
    showToast("Quality must be 1–100", "err");
    return;
  }
  if (cw !== "" && !(/^\d+$/.test(cw) && +cw <= MAX_WIDTH_LIMIT)) {
    showToast(`Width must be 0–${MAX_WIDTH_LIMIT}`, "err");
    return;
  }
  const proxyBase = (proxyBaseEl.value || "").trim();
  // Empty = image proxying off (quality, exclusions and Save-Data can still
  // be saved). Otherwise fully parse the URL — a scheme-prefix check let
  // values like "https://not a url" through.
  if (proxyBase && !BH.parseProxyBase(proxyBase)) {
    proxyBaseEl.classList.add("invalid");
    showToast("Proxy URL must be a valid http:// or https:// URL", "err");
    proxyBaseEl.focus();
    return;
  }
  const quality = readQuality();
  const maxWidth = readWidth();
  const excludeDomains = (excludeEl.value || "").trim();
  const current = await chrome.storage.sync.get(DEFAULTS);

  // Writes sync and the local mirror together, before any reload below.
  await BH.saveSettings({
    proxyBase,
    quality,
    maxWidth,
    excludeDomains,
  });
  dirty.clear();

  // Reload whenever a URL-shaping setting changed — including excluded
  // domains, whose effect is only visible after a reload restores the page's
  // already-proxied images (or stops proxying a newly excluded site).
  if (proxyBase !== String(current.proxyBase || "") ||
      quality  !== Number(current.quality  ?? DEFAULTS.quality) ||
      maxWidth !== Number(current.maxWidth ?? DEFAULTS.maxWidth) ||
      excludeDomains !== String(current.excludeDomains || "")) {
    await reloadCurrentPage();
  }

  // Keep the "restore on clear" values and preset highlights in step with storage.
  savedQuality = quality;
  savedWidth   = maxWidth;
  setQualityUI(quality);
  setWidthUI(maxWidth);
  showToast(proxyBase ? "Saved" : "Saved — image proxying is off (no proxy URL)", proxyBase ? "ok" : "warn");
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { signal: ctrl.signal, cache: "no-store" }); }
  finally { clearTimeout(timer); }
}

// bhp2 serves /api/health next to /api/index; "health" resolved against the
// proxy URL finds it for both /api/index and /.netlify/functions/index.
async function readHealth(base) {
  try {
    const res = await fetchWithTimeout(new URL("health", base).href, 8000);
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.service === "bandwidth-hero-proxy" ? data : null;
  } catch { return null; }
}

async function testProxy() {
  const url = (proxyBaseEl.value || "").trim();
  if (!BH.parseProxyBase(url)) { showToast("Enter a valid proxy URL first", "err"); return; }
  const orig = testProxyBtn.textContent;
  testProxyBtn.textContent = "Testing…"; testProxyBtn.disabled = true;
  try {
    const res = await fetchWithTimeout(url, 8000);
    const body = await res.text();
    if (res.ok && body.trim() === "bandwidth-hero-proxy") {
      const health = await readHealth(url);
      if (!health) showToast("Proxy is working ✓ (no /health endpoint)", "ok");
      else if (health.sharp && health.sharp.available === false) showToast(`Proxy v${health.version}: image engine (Sharp) unavailable`, "err");
      else showToast(`Proxy is working ✓ v${health.version} · API ${health.api}`, "ok");
    }
    else if (res.ok) showToast(`Proxy responded (${res.status}) but is not a Bandwidth Hero proxy`, "warn");
    else showToast(`Proxy returned HTTP ${res.status}`, "err");
  } catch (e) {
    showToast(e?.name === "AbortError" ? "Timed out — proxy not reachable" : "Connection failed — check URL and CORS", "err");
  } finally {
    testProxyBtn.textContent = orig; testProxyBtn.disabled = false;
  }
}

testProxyBtn.addEventListener("click", testProxy);
proxyBaseEl.addEventListener("input", () => { proxyBaseEl.classList.remove("invalid"); dirty.add("proxyBase"); });
excludeEl.addEventListener("input", () => dirty.add("excludeDomains"));

// ── Reset ─────────────────────────────────────────────────────────────────────

async function resetAll() {
  await BH.saveSettings(DEFAULTS);
  await load();
  // Resetting clears the proxy URL; without a reload the current page keeps
  // serving proxied images from the old proxy until manually refreshed.
  await reloadCurrentPage();
  showToast("Reset to defaults");
}

async function resetStats() {
  // Only touch the stats: load() would also overwrite unsaved edits in the form.
  await chrome.storage.local.set({ stats: { filesProcessed: 0, bytesProcessed: 0, bytesSaved: 0 } });
  renderStats(null);
  showToast("Stats cleared");
}

// ── Event wiring ──────────────────────────────────────────────────────────────

saveBtn.addEventListener("click", save);
resetAllBtn.addEventListener("click", resetAll);
resetStatsBtn.addEventListener("click", resetStats);


[proxyBaseEl, excludeEl, customQualityEl, customWidthEl].forEach(el => {
  el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } });
});
