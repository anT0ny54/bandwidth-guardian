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
const editableSettingsControls = [
  enabledEl, grayscaleEl, saveDataEl, proxyBaseEl, excludeEl,
  customQualityEl, customWidthEl, testProxyBtn, ...qualityPresets, ...widthPresets
];
function setSettingsControlsDisabled(disabled) {
  editableSettingsControls.forEach(control => {
    control.disabled = disabled || (control === testProxyBtn && testProxyInProgress);
  });
}

let testProxyInProgress = false;

// Preset values come from the buttons themselves, so HTML and JS cannot drift.
const QUALITY_PRESETS = qualityPresets.map(b => Number(b.dataset.q));
const WIDTH_PRESETS   = widthPresets.map(b => Number(b.dataset.w));
let savedQuality = DEFAULTS.quality;
let savedWidth   = DEFAULTS.maxWidth;

// B2: track fields the user has edited since load/save so incoming sync
// changes (e.g. the popup's "Exclude this site") never clobber unsaved edits.
const dirty = { proxyBase: false, excludeDomains: false, quality: false, width: false };
// User edits made while storage.sync.set() is pending must remain visible and
// dirty when that older save completes. Revisions distinguish those edits from
// the values included in the submitted snapshot.
const editRevision = { proxyBase: 0, excludeDomains: 0, quality: 0, width: 0 };
let saveInProgress = false;
let resetInProgress = false;
function markEdit(field) {
  editRevision[field]++;
  dirty[field] = true;
}
const settingsRevision = Object.create(null);
// Keep the latest observed sync snapshot so a cross-page change arriving while
// Save is pending is not replaced by the older values submitted by this page.
let latestSyncSettings = { ...DEFAULTS };
let statsRevision = 0;
let pendingAutoSaveWrites = Promise.resolve();
const autoSaveRevision = { enabled: 0, grayscale: 0, saveData: 0 };
function markSettingsRevision(key) {
  settingsRevision[key] = (settingsRevision[key] || 0) + 1;
}
function queueAutoSave(values) {
  const write = pendingAutoSaveWrites.catch(() => {}).then(() => chrome.storage.sync.set(values));
  pendingAutoSaveWrites = write;
  return write;
}
async function persistAutoSetting(key, element, successMessage, successType = "ok") {
  const revision = ++autoSaveRevision[key];
  const value = !!element.checked;
  markSettingsRevision(key);
  try {
    await queueAutoSave({ [key]: value });
    if (revision === autoSaveRevision[key]) showToast(successMessage(value), successType);
  } catch {
    if (revision !== autoSaveRevision[key]) return;
    let latest;
    try { latest = await chrome.storage.sync.get({ [key]: DEFAULTS[key] }); }
    catch {}
    // Reset may have started while the recovery read was pending. Its newer
    // default snapshot wins; an older failed-toggle callback must not repaint it.
    if (revision !== autoSaveRevision[key]) return;
    if (latest) element.checked = !!latest[key];
    showToast("Could not save setting", "err");
  }
}

// Keep the latest stored value as the reset baseline even while an input is
// dirty. The UI remains untouched until the user clears their custom edit.
function mergeIncomingSetting(change, field, fallback, apply) {
  const value = change.newValue ?? fallback;
  if (!dirty[field]) apply(value);
  return value;
}

// B14: Settings remembers the tab that opened it (?tab=<id> from the popup).
const openerTabId = (() => {
  const raw = new URLSearchParams(location.search).get("tab");
  const v = Number(raw);
  return raw !== null && raw !== "" && Number.isInteger(v) && v >= 0 ? v : null;
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

// The extension appends its own `url=` query parameter to every proxy URL.
// A pre-existing `url` parameter would be ambiguous to the proxy's parser.
function isValidProxyBase(value) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.searchParams.has("url");
  } catch { return false; }
}

async function reloadCurrentPage() {
  const isHttpUrl = url => /^https?:\/\//i.test(String(url || ""));
  // B14: prefer the tab that opened Settings. Only http(s) tabs qualify below,
  // so this page itself (chrome-extension://) can never be reloaded by mistake.
  if (openerTabId != null) {
    try {
      const opener = await chrome.tabs.get(openerTabId);
      if (isHttpUrl(opener.url)) {
        await chrome.tabs.reload(openerTabId);
        return;
      }
    } catch {}
  }
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active?.id != null && isHttpUrl(active.url)) {
      await chrome.tabs.reload(active.id);
      return;
    }
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const page = tabs
      .filter(tab => tab.id != null && isHttpUrl(tab.url))
      .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0];
    if (page?.id != null) await chrome.tabs.reload(page.id);
  } catch {}
}

// ── Preset helpers ────────────────────────────────────────────────────────────

// B16: exact match, or a visible "Custom" badge. The badges are static markup
// beside each section title (never grid children of the preset buttons), so
// quality and width are customized independently and toggle with `hidden`.
const qualityCustomEl = $("qualityCustom");
const widthCustomEl   = $("widthCustom");

function setQualityUI(q) {
  q = Number(q);
  const matched = QUALITY_PRESETS.includes(q);
  qualityPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.q) === q));
  qualityCustomEl.hidden = matched;
  customQualityEl.value = matched ? "" : String(q ?? "");
}

function setWidthUI(w) {
  w = Number(w) || 0;
  const matched = WIDTH_PRESETS.includes(w);
  widthPresets.forEach(b => b.classList.toggle("active", Number(b.dataset.w) === w));
  widthCustomEl.hidden = matched;
  customWidthEl.value = matched ? "" : String(w);
}

function readQuality() {
  const v = parseInt(customQualityEl.value, 10);
  if (!isNaN(v) && v >= 1 && v <= 100) return v;
  const active = qualityPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.q) : savedQuality;
}

function parseCustomWidth(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const width = Number(text);
  return Number.isSafeInteger(width) ? width : null;
}

function readWidth() {
  const custom = parseCustomWidth(customWidthEl.value);
  if (custom !== null) return custom;
  const active = widthPresets.find(b => b.classList.contains("active"));
  return active ? Number(active.dataset.w ?? 0) : savedWidth;
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  const revisions = { ...settingsRevision };
  const initialStatsRevision = statsRevision;
  const [settingsResult, statsResult] = await Promise.allSettled([
    Promise.resolve().then(() => chrome.storage.sync.get(DEFAULTS)),
    Promise.resolve().then(() => chrome.storage.local.get({ stats: null }))
  ]);
  if (settingsResult.status !== "fulfilled") {
    showToast("Could not load saved settings", "err");
    return false;
  }
  const d = settingsResult.value || DEFAULTS;
  const unchanged = key => (settingsRevision[key] || 0) === (revisions[key] || 0);
  for (const key of Object.keys(DEFAULTS)) {
    if (unchanged(key)) latestSyncSettings[key] = d[key] ?? DEFAULTS[key];
  }
  if (unchanged("enabled")) enabledEl.checked = !!d.enabled;
  if (unchanged("grayscale")) grayscaleEl.checked = !!d.grayscale;
  if (unchanged("saveData")) saveDataEl.checked = !!d.saveData;
  if (unchanged("proxyBase") && !dirty.proxyBase) {
    proxyBaseEl.value = d.proxyBase || "";
    proxyBaseEl.classList.remove("invalid");
  }
  if (unchanged("excludeDomains") && !dirty.excludeDomains) {
    excludeEl.value = d.excludeDomains || "";
  }
  if (unchanged("quality")) {
    savedQuality = d.quality ?? DEFAULTS.quality;
    if (!dirty.quality) setQualityUI(savedQuality);
  }
  if (unchanged("maxWidth")) {
    savedWidth = d.maxWidth ?? DEFAULTS.maxWidth;
    if (!dirty.width) setWidthUI(savedWidth);
  }
  if (statsResult.status === "fulfilled" && statsRevision === initialStatsRevision) {
    renderStats(statsResult.value?.stats);
  }
  return true;
}
const initialLoadPromise = load();

function renderStats(st) {
  st = st || {};
  statImagesEl.textContent = Number(st.filesProcessed || 0).toLocaleString();
  statBytesEl.textContent  = fmtBytes(Number(st.bytesProcessed || 0));
  statSavedEl.textContent  = fmtBytes(Number(st.bytesSaved || 0));
}

// Apply only settings owned by this extension; keep the latest observed values
// even when a dirty control must remain untouched by a cross-page update.
function applySyncSettingsChanges(changes) {
  for (const [key, change] of Object.entries(changes)) {
    if (!(key in DEFAULTS)) continue;
    markSettingsRevision(key);
    latestSyncSettings[key] = change.newValue ?? DEFAULTS[key];
  }
  if (changes.enabled)    enabledEl.checked   = !!(changes.enabled.newValue ?? DEFAULTS.enabled);
  if (changes.grayscale)  grayscaleEl.checked = !!(changes.grayscale.newValue ?? DEFAULTS.grayscale);
  if (changes.saveData)   saveDataEl.checked  = !!(changes.saveData.newValue ?? DEFAULTS.saveData);
  if (changes.proxyBase && !dirty.proxyBase) {
    proxyBaseEl.value = changes.proxyBase.newValue || "";
    proxyBaseEl.classList.remove("invalid");
  }
  if (changes.excludeDomains && !dirty.excludeDomains) {
    excludeEl.value = changes.excludeDomains.newValue || "";
  }
  if (changes.quality) {
    savedQuality = mergeIncomingSetting(changes.quality, "quality", DEFAULTS.quality, setQualityUI);
  }
  if (changes.maxWidth) {
    savedWidth = mergeIncomingSetting(changes.maxWidth, "width", DEFAULTS.maxWidth, setWidthUI);
  }
}

// Live stats counter while this page is open (worker flushes in batches), and
// B2: stay in sync with changes made elsewhere (popup toggles, popup
// exclusions, second Settings window). Fields with unsaved edits win.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") {
    if (changes.stats) {
      statsRevision++;
      renderStats(changes.stats.newValue);
    }
    return;
  }
  if (area === "sync") applySyncSettingsChanges(changes);
});

// ── Preset buttons ────────────────────────────────────────────────────────────

qualityPresets.forEach(btn => {
  btn.addEventListener("click", () => {
    markEdit("quality"); // Preset changes are unsaved edits too.
    qualityPresets.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    customQualityEl.value = ""; // preset takes priority; clear custom
    qualityCustomEl.hidden = true;
  });
});

customQualityEl.addEventListener("input", () => {
  markEdit("quality");
  const v = parseInt(customQualityEl.value, 10);
  if (!isNaN(v) && v >= 1 && v <= 100) {
    qualityPresets.forEach(b => b.classList.remove("active"));
    qualityCustomEl.hidden = false;
  } else if (customQualityEl.value === "") {
    dirty.quality = false;
    setQualityUI(savedQuality);
  }
});

widthPresets.forEach(btn => {
  btn.addEventListener("click", () => {
    markEdit("width"); // Preset changes are unsaved edits too.
    widthPresets.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    customWidthEl.value = "";
    widthCustomEl.hidden = true;
  });
});

customWidthEl.addEventListener("input", () => {
  markEdit("width");
  const v = parseCustomWidth(customWidthEl.value);
  if (v !== null) {
    widthPresets.forEach(b => b.classList.remove("active"));
    widthCustomEl.hidden = false;
  } else if (customWidthEl.value === "") {
    dirty.width = false;
    setWidthUI(savedWidth);
  }
});

proxyBaseEl.addEventListener("input", () => { markEdit("proxyBase"); proxyBaseEl.classList.remove("invalid"); });
excludeEl.addEventListener("input", () => { markEdit("excludeDomains"); });

// ── Auto-save: enable + grayscale + saveData ──────────────────────────────────

enabledEl.addEventListener("change", () => persistAutoSetting(
  "enabled", enabledEl, value => value ? "Compression enabled" : "Compression disabled"
));

grayscaleEl.addEventListener("change", () => persistAutoSetting(
  "grayscale", grayscaleEl, () => "Reload the page to apply", "warn"
));

saveDataEl.addEventListener("change", () => persistAutoSetting(
  "saveData", saveDataEl, value => value ? "Save-Data header enabled" : "Save-Data header disabled"
));

// ── Save ──────────────────────────────────────────────────────────────────────

async function save() {
  // Enter and repeated clicks can submit the same UI more than once. Keep one
  // write in flight so an older snapshot cannot complete after a newer save.
  if (saveInProgress || resetInProgress) return;
  saveInProgress = true;
  saveBtn.disabled = true;
  resetAllBtn.disabled = true;
  try {
    // Saving before the startup snapshot arrives could submit HTML defaults
    // over a user's existing settings. Wait for a successful initial load.
    if (!await initialLoadPromise) {
      showToast("Could not save because settings failed to load", "err");
      return;
    }
    // Read the baseline first. Cross-page storage events can update untouched
    // controls while this request is pending, so sample the controls afterwards.
    let current;
    try { current = await chrome.storage.sync.get(DEFAULTS); }
    catch {
      showToast("Could not read saved settings", "err");
      return;
    }
    const cq = customQualityEl.value.trim();
    const cw = customWidthEl.value.trim();
    if (cq !== "" && !(/^\d+$/.test(cq) && +cq >= 1 && +cq <= 100)) {
      showToast("Quality must be 1–100", "err");
      return;
    }
    if (cw !== "" && parseCustomWidth(cw) === null) {
      showToast("Width must be a non-negative safe whole number", "err");
      return;
    }
    const proxyBase = (proxyBaseEl.value || "").trim();
    // B3: an empty proxyBase is allowed — it means "proxying disabled". Validate
    // only when a value was entered, so quality/width/exclusions are savable
    // without a proxy and the proxy can actually be cleared.
    if (proxyBase !== "" && !isValidProxyBase(proxyBase)) {
      proxyBaseEl.classList.add("invalid");
      showToast("Use a valid http(s) proxy URL without a ?url= parameter", "err");
      proxyBaseEl.focus();
      return;
    }
    const quality = readQuality();
    const maxWidth = readWidth();
    const excludeDomains = (excludeEl.value || "").trim();
    const snapshotRevisions = { ...editRevision };
    const settingsSnapshotRevisions = { ...settingsRevision };
    const submitted = { proxyBase, quality, maxWidth, excludeDomains };

    try { await chrome.storage.sync.set(submitted); }
    catch {
      showToast("Could not save settings", "err");
      return;
    }

    // A different extension page may publish newer values while this write is
    // pending. Storage events update latestSyncSettings; prefer those observed
    // values over our older submission for any affected key.
    const committedValue = key =>
      (settingsRevision[key] || 0) !== (settingsSnapshotRevisions[key] || 0)
        ? (latestSyncSettings[key] ?? submitted[key])
        : submitted[key];
    const committed = {
      proxyBase: committedValue("proxyBase"),
      quality: committedValue("quality"),
      maxWidth: committedValue("maxWidth"),
      excludeDomains: committedValue("excludeDomains")
    };

    // Commit the latest observed baseline immediately after the write, before
    // any optional tab reload awaits. Preserve controls edited after the
    // submitted snapshot; those newer local values still need an explicit Save.
    savedQuality = committed.quality;
    savedWidth = committed.maxWidth;
    const changedDuringWrite = field => editRevision[field] !== snapshotRevisions[field];
    for (const field of ["proxyBase", "excludeDomains"]) {
      if (changedDuringWrite(field)) {
        dirty[field] = true;
      } else {
        dirty[field] = false;
        if ((settingsRevision[field] || 0) !== (settingsSnapshotRevisions[field] || 0)) {
          (field === "proxyBase" ? proxyBaseEl : excludeEl).value = String(committed[field] ?? "");
        }
      }
    }
    for (const [field, value, apply] of [
      ["quality", committed.quality, setQualityUI],
      ["width", committed.maxWidth, setWidthUI]
    ]) {
      if (changedDuringWrite(field)) {
        dirty[field] = true;
      } else {
        dirty[field] = false;
        apply(value);
      }
    }

    // Reload against the values that actually won the write race, not the
    // submitted snapshot: a newer cross-page update may be the committed value.
    if (committed.proxyBase !== String(current.proxyBase || "") ||
        committed.quality !== Number(current.quality ?? DEFAULTS.quality) ||
        committed.maxWidth !== Number(current.maxWidth ?? DEFAULTS.maxWidth) ||
        committed.excludeDomains !== String(current.excludeDomains || "")) {
      await reloadCurrentPage();
    }

    const hasNewerEdits = Object.values(dirty).some(Boolean);
    showToast(hasNewerEdits ? "Saved; newer edits remain unsaved" : "Saved",
      hasNewerEdits ? "warn" : "ok");
  } finally {
    saveInProgress = false;
    saveBtn.disabled = false;
    resetAllBtn.disabled = false;
  }
}

async function testProxy() {
  if (testProxyInProgress || resetInProgress) return;
  const url = (proxyBaseEl.value || "").trim();
  if (!isValidProxyBase(url)) {
    showToast("Enter a valid http(s) proxy URL without a ?url= parameter", "err");
    return;
  }
  testProxyInProgress = true;
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
    testProxyBtn.textContent = orig;
    testProxyInProgress = false;
    testProxyBtn.disabled = resetInProgress;
  }
}

testProxyBtn.addEventListener("click", testProxy);

// ── Reset ────────────────────────────────────────────────────────────────────

async function resetAll() {
  // Reset writes the complete settings object, so it must not race a partial
  // Save. Freeze editable controls until the reset and UI refresh have finished.
  if (saveInProgress || resetInProgress) return;
  resetInProgress = true;
  // Invalidate both pending toggle recoveries and the original startup read:
  // none may repaint pre-reset settings after Reset defaults has started.
  for (const key of Object.keys(autoSaveRevision)) autoSaveRevision[key]++;
  for (const key of Object.keys(DEFAULTS)) markSettingsRevision(key);
  setSettingsControlsDisabled(true);
  saveBtn.disabled = true;
  resetAllBtn.disabled = true;
  try {
    // Auto-save switches use their own quick writes; drain those first so none
    // can complete after the full DEFAULTS write and undo the reset.
    await pendingAutoSaveWrites.catch(() => {});
    await chrome.storage.sync.set(DEFAULTS);
    for (const key in dirty) dirty[key] = false;
    const loaded = await load();
    await reloadCurrentPage();
    showToast(loaded ? "Reset to defaults" : "Defaults saved; settings could not be refreshed",
      loaded ? "ok" : "warn");
  } catch {
    // A failed reset invalidates older optimistic-toggle recovery callbacks too;
    // refresh the persisted switches while load() preserves dirty text/presets.
    try { await load(); } catch {}
    showToast("Could not reset settings", "err");
  } finally {
    resetInProgress = false;
    setSettingsControlsDisabled(false);
    saveBtn.disabled = false;
    resetAllBtn.disabled = false;
  }
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
