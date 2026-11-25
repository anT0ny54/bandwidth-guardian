const $ = id => document.getElementById(id);

// Only plain hostnames can be excluded. KEEP IN SYNC with EXCLUDE_HOST_RE in
// service-worker.js, prehook.js and content.js: the popup must not report a
// site as excluded when the network layer would still compress it.
const EXCLUDE_HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const enabledEl   = $("enabled");
const grayscaleEl = $("grayscale");
const ctrlCard    = $("ctrlCard");
const headerSub   = $("headerSub");
const statusState = $("statusState");
const statusText  = $("statusText");
const nudge       = $("nudge");
const reloadBtn   = $("reloadBtn");
const siteNameEl  = $("siteName");
const sitePillEl  = $("sitePill");
const excludeBtn  = $("excludeBtn");
const settingsBtn = $("settingsBtn");
const presetBtns  = Array.from(document.querySelectorAll("#qualityPresets .preset"));

let state = { ...DEFAULTS };
const settingsRevision = Object.create(null);
let siteUiRevision = 0;
let currentHost  = "";
let currentIsWeb = false;
let currentTabId = null;
let popupStorageWriteInProgress = false;

function setPopupStorageBusy(busy) {
  popupStorageWriteInProgress = busy;
  enabledEl.disabled = busy;
  grayscaleEl.disabled = busy;
  presetBtns.forEach(btn => { btn.disabled = busy; });
  excludeBtn.disabled = busy || !currentIsWeb || !EXCLUDE_HOST_RE.test(currentHost);
}

function markSettingsRevision(key) {
  settingsRevision[key] = (settingsRevision[key] || 0) + 1;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDomains(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map(s => s.toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""))
    .filter(Boolean);
}

function findExcludedDomain(host, domains) {
  return domains.find(domain => EXCLUDE_HOST_RE.test(domain) &&
    (host === domain || host.endsWith(`.${domain}`))) || "";
}

function removeDomainToken(text, excludedDomain) {
  return parseDomains(text).filter(domain => domain !== excludedDomain).join("\n");
}

// B16: exact-match highlighting. "Nearest" matching lied about custom values
// (quality 55 highlighted "60"); when nothing matches the static "Custom" badge
// beside the label is shown. It lives outside the preset grid on purpose.
const qualityCustomEl = $("qualityCustom");

function setActivePreset(q) {
  let matched = false;
  presetBtns.forEach(b => {
    const on = Number(b.dataset.q) === Number(q);
    b.classList.toggle("active", on);
    if (on) matched = true;
  });
  qualityCustomEl.hidden = matched;
}

function showNudge() { nudge.classList.add("show"); }

function showStorageError(message) {
  headerSub.textContent = "Settings unavailable";
  statusState.classList.remove("active");
  statusText.textContent = message;
  ctrlCard.classList.add("card-dim");
}

// Persist an optimistic popup change. If another page publishes a newer value
// while this write is pending, keep that value rather than rolling it back.
async function savePopupSetting(key, value) {
  // Popup controls share one storage write lane. Disabling them synchronously
  // prevents rapid toggles from issuing overlapping writes for stale values.
  if (popupStorageWriteInProgress) return false;
  setPopupStorageBusy(true);
  const previous = state[key];
  markSettingsRevision(key);
  const revision = settingsRevision[key];
  state[key] = value;
  try {
    await chrome.storage.sync.set({ [key]: value });
    return true;
  } catch {
    if (settingsRevision[key] === revision) {
      state[key] = previous;
      applyUI(state);
    }
    showStorageError("Could not save settings");
    return false;
  } finally {
    setPopupStorageBusy(false);
  }
}

// ── UI state ──────────────────────────────────────────────────────────────────

function applyUI(d) {
  enabledEl.checked   = !!d.enabled;
  grayscaleEl.checked = !!d.grayscale;
  setActivePreset(d.quality ?? DEFAULTS.quality);
  updateEnabledUI(!!d.enabled);
}

function updateEnabledUI(enabled) {
  ctrlCard.classList.toggle("card-dim", !enabled);
  // B17: an empty proxyBase (the default install) means nothing can compress.
  const noProxy = !String(state.proxyBase || "").trim();
  headerSub.textContent = !enabled ? "Disabled" : noProxy ? "No proxy" : "Active";
  statusState.classList.toggle("active", enabled && !noProxy);
  statusText.textContent = !enabled
    ? "Compression disabled"
    : noProxy ? "No proxy configured" : "Compression active";
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  const revisions = { ...settingsRevision };
  let stored;
  try { stored = await chrome.storage.sync.get(DEFAULTS); }
  catch {
    applyUI(state);
    showStorageError("Could not load settings");
    loadSiteUI(state);
    return false;
  }
  for (const key of Object.keys(DEFAULTS)) {
    if ((settingsRevision[key] || 0) === (revisions[key] || 0)) {
      state[key] = stored[key] ?? DEFAULTS[key];
    }
  }
  applyUI(state);
  loadSiteUI(state);
  return true;
}
load();

// ── Enable toggle ────────────────────────────────────────────────────────────

enabledEl.addEventListener("change", async () => {
  const enabled = enabledEl.checked;
  if (await savePopupSetting("enabled", enabled)) applyUI(state);
});

// ── Grayscale ─────────────────────────────────────────────────────────────────

grayscaleEl.addEventListener("change", async () => {
  if (await savePopupSetting("grayscale", grayscaleEl.checked)) {
    applyUI(state);
    showNudge();
  }
});

// ── Quality presets ───────────────────────────────────────────────────────────

presetBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    const quality = Number(btn.dataset.q);
    if (!await savePopupSetting("quality", quality)) return;
    applyUI(state);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) await chrome.tabs.reload(tab.id);
    } catch {}
    window.close();
  });
});

// ── Reload current tab ────────────────────────────────────────────────────────

reloadBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await chrome.tabs.reload(tab.id);
  } catch {}
  window.close();
});

// ── Site card ─────────────────────────────────────────────────────────────────

async function loadSiteUI(d) {
  const revision = ++siteUiRevision;
  const setUnavailable = label => {
    siteNameEl.textContent = label;
    sitePillEl.textContent = "";
    sitePillEl.className = "site-pill";
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Not available";
    excludeBtn.disabled = true;
  };

  // Clear the previous tab context while this lookup is pending. A failed or
  // empty result must not leave Settings pointing at a tab that is no longer active.
  currentTabId = null;
  currentHost = "";
  currentIsWeb = false;
  setUnavailable("Checking…");
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch {
    if (revision === siteUiRevision) setUnavailable("Tab unavailable");
    return;
  }
  if (revision !== siteUiRevision) return;

  if (!tab?.url) {
    setUnavailable("No active tab");
    return;
  }

  currentTabId = tab.id ?? null;

  let parsed;
  try { parsed = new URL(tab.url); }
  catch { setUnavailable("Unknown"); return; }

  currentIsWeb = parsed.protocol === "http:" || parsed.protocol === "https:";
  currentHost  = parsed.hostname.toLowerCase();

  if (!currentIsWeb) {
    siteNameEl.textContent = parsed.protocol.replace(":", "") + " page";
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Not a web page";
    excludeBtn.disabled = true;
    return;
  }

  siteNameEl.textContent = currentHost;
  excludeBtn.disabled = popupStorageWriteInProgress;
  if (!EXCLUDE_HOST_RE.test(currentHost)) {
    // Not a plain hostname (e.g. underscores): exclusion cannot apply to it.
    setUnavailable(currentHost);
    return;
  }

  const excluded = parseDomains(d.excludeDomains);
  if (findExcludedDomain(currentHost, excluded)) {
    sitePillEl.textContent = "Excluded";
    sitePillEl.className   = "site-pill excluded";
    sitePillEl.style.display = "";
    excludeBtn.textContent = "✕ Remove exclusion";
  } else {
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Exclude this site";
  }
}

// ── Exclude / re-include current site ─────────────────────────────────────────

async function toggleSiteExclusion() {
  if (!currentIsWeb || !currentHost || popupStorageWriteInProgress ||
      !EXCLUDE_HOST_RE.test(currentHost)) return;
  setPopupStorageBusy(true);
  try {
    const host = currentHost;
    const tabRevision = siteUiRevision;
    markSettingsRevision("excludeDomains");
    const readRevision = settingsRevision.excludeDomains;
    let d;
    try { d = await chrome.storage.sync.get(DEFAULTS); }
    catch {
      showStorageError("Could not load site exclusions");
      return;
    }
    // A tab change while storage was loading must not apply the click to the
    // newly active site. Cross-page settings changes, however, remain current.
    if (tabRevision !== siteUiRevision || !currentIsWeb || currentHost !== host) return;

    // Prefer a newer storage event received while this read was in flight.
    const raw = String((settingsRevision.excludeDomains === readRevision
      ? d.excludeDomains : state.excludeDomains) || "");
    const excludedDomain = findExcludedDomain(host, parseDomains(raw));
    let next;
    if (excludedDomain) {
      // Normalize separators when removing a token so deleting the first or a
      // middle entry cannot leave leading commas or doubled separators.
      next = removeDomainToken(raw, excludedDomain);
    } else {
      next = raw.trim() ? raw.replace(/[\s,]*$/, "") + "\n" + host : host;
    }
    try { await chrome.storage.sync.set({ excludeDomains: next }); }
    catch {
      showStorageError("Could not save site exclusion");
      return;
    }
    // The storage event normally publishes this value to the popup too. Only
    // supply a fallback when no newer cross-page event has changed the state.
    if (state.excludeDomains === raw) state.excludeDomains = next;
    loadSiteUI(state);
    showNudge(); // page must reload for the change to take effect
  } finally {
    setPopupStorageBusy(false);
  }
}
excludeBtn.addEventListener("click", toggleSiteExclusion);

// ── Open settings page ────────────────────────────────────────────────────────
// chrome.runtime.openOptionsPage() breaks on Kiwi/Cromite (popup opens as tab).
// B14: pass the current tab's id so Settings reloads the right tab on save.

settingsBtn.addEventListener("click", () => {
  let url = chrome.runtime.getURL("options.html");
  if (currentTabId != null && currentIsWeb) url += "?tab=" + currentTabId;
  // B20: some Chromium builds return undefined instead of a promise here.
  const maybePromise = chrome.tabs.create({ url });
  if (maybePromise && typeof maybePromise.catch === "function") {
    maybePromise.catch(() => chrome.runtime.openOptionsPage?.());
  }
});

// ── Sync with changes made on the settings page ───────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  let changed = false;
  for (const [k, v] of Object.entries(changes)) {
    if (!(k in DEFAULTS)) continue;
    markSettingsRevision(k);
    state[k] = v.newValue ?? DEFAULTS[k];
    changed = true;
  }
  if (!changed) return;
  applyUI(state);
  if ("excludeDomains" in changes || "enabled" in changes || "proxyBase" in changes) loadSiteUI(state);
});
