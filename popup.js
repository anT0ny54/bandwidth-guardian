import { DEFAULTS } from "./defaults.js";

const $ = id => document.getElementById(id);

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

const PRESETS = [45, 60, 80];

let state = { ...DEFAULTS };
let currentHost  = "";
let currentIsWeb = false;
let currentTabId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDomains(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase()).filter(Boolean)
    .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/\.$/, ""));
}

function findExcludedDomain(host, domains) {
  return domains.find(domain => host === domain || host.endsWith(`.${domain}`)) || "";
}

// B16: exact-match highlighting. "Nearest" matching lied about custom values
// (quality 55 highlighted "60"); when nothing matches we show a "Custom" badge.
let customBadgeEl = null;
function setCustomBadge(container, show) {
  if (!container) return;
  if (show && !customBadgeEl) {
    customBadgeEl = document.createElement("span");
    customBadgeEl.textContent = "Custom";
    customBadgeEl.style.cssText = "font-size:11px;opacity:.65;margin-left:8px;vertical-align:middle;";
    container.appendChild(customBadgeEl);
  } else if (!show && customBadgeEl) {
    customBadgeEl.remove();
    customBadgeEl = null;
  }
}

function setActivePreset(q) {
  let matched = false;
  presetBtns.forEach(b => {
    const on = Number(b.dataset.q) === Number(q);
    b.classList.toggle("active", on);
    if (on) matched = true;
  });
  setCustomBadge($("qualityPresets"), !matched);
}

function showNudge() { nudge.classList.add("show"); }

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
  state = await chrome.storage.sync.get(DEFAULTS);
  applyUI(state);
  loadSiteUI(state);
}
load();

// ── Enable toggle ─────────────────────────────────────────────────────────────

enabledEl.addEventListener("change", async () => {
  const enabled = enabledEl.checked;
  state.enabled = enabled;
  await chrome.storage.sync.set({ enabled });
  updateEnabledUI(enabled);
});

// ── Grayscale ─────────────────────────────────────────────────────────────────

grayscaleEl.addEventListener("change", async () => {
  state.grayscale = grayscaleEl.checked;
  await chrome.storage.sync.set({ grayscale: grayscaleEl.checked });
  showNudge();
});

// ── Quality presets ───────────────────────────────────────────────────────────

presetBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    const quality = Number(btn.dataset.q);
    state.quality = quality;
    await chrome.storage.sync.set({ quality });
    setActivePreset(quality);
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
    if (tab?.id) chrome.tabs.reload(tab.id);
  } catch {}
  window.close();
});

// ── Site card ─────────────────────────────────────────────────────────────────

async function loadSiteUI(d) {
  let tab;
  try { [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); }
  catch { return; }

  if (!tab?.url) {
    siteNameEl.textContent = "No active tab";
    excludeBtn.disabled = true;
    return;
  }

  currentTabId = tab.id ?? null;

  let parsed;
  try { parsed = new URL(tab.url); }
  catch { siteNameEl.textContent = "Unknown"; excludeBtn.disabled = true; return; }

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
  excludeBtn.disabled = false;

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

// ── Exclude / re-include current site ────────────────────────────────────────

excludeBtn.addEventListener("click", async () => {
  if (!currentIsWeb || !currentHost) return;
  const d    = await chrome.storage.sync.get(DEFAULTS);
  const raw  = String(d.excludeDomains || "");
  const list = new Set(parseDomains(raw));
  const excludedDomain = findExcludedDomain(currentHost, Array.from(list));
  let next;
  if (excludedDomain) {
    // B21: remove only the matching token, preserving the user's separators
    // and formatting (no lowercase + space-join rewrite of the whole field).
    next = raw.split(/([,\s]+)/)
      .filter(tok => /[,\s]/.test(tok) || parseDomains(tok)[0] !== excludedDomain)
      .join("");
  } else {
    list.add(currentHost);
    next = raw.trim() ? raw.replace(/[\s,]*$/, "") + "\n" + currentHost : currentHost;
  }
  state.excludeDomains = next;
  await chrome.storage.sync.set({ excludeDomains: next });
  loadSiteUI(state);
  showNudge(); // page must reload for the change to take effect
});

// ── Open settings page ────────────────────────────────────────────────────────
// chrome.runtime.openOptionsPage() breaks on Kiwi/Cromite (popup opens as tab).
// B14: pass the current tab's id so Settings reloads the right tab on save.

settingsBtn.addEventListener("click", () => {
  let url = chrome.runtime.getURL("options.html");
  if (currentTabId != null) url += "?tab=" + currentTabId;
  // B20: some Chromium builds return undefined instead of a promise here.
  const maybePromise = chrome.tabs.create({ url });
  if (maybePromise && typeof maybePromise.catch === "function") {
    maybePromise.catch(() => chrome.runtime.openOptionsPage?.());
  }
});

// ── Sync with changes made on the settings page ───────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [k, v] of Object.entries(changes)) state[k] = v.newValue ?? DEFAULTS[k];
  applyUI(state);
  if ("excludeDomains" in changes || "enabled" in changes || "proxyBase" in changes) loadSiteUI(state);
});
