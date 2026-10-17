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

let state = { ...DEFAULTS };
let currentHost  = "";
let currentIsWeb = false;
let currentTabId = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Ports are stripped like every other domain normalizer in the project
// (prehook/content/worker) — "example.com:8080" would never match a hostname.
function parseDomains(text) {
  return String(text || "")
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase()).filter(Boolean)
    .map(s => s.replace(/^https?:\/\//, "").split("/")[0].replace(/:\d+$/, "").replace(/\.$/, ""));
}

function findExcludedDomain(host, domains) {
  return domains.find(domain => host === domain || host.endsWith(`.${domain}`)) || "";
}

// B16: exact-match highlighting. "Nearest" matching lied about custom values
// (quality 55 highlighted "60"); when nothing matches we show a "Custom" badge.
// One badge PER CONTAINER (WeakMap) — quality and width rows can never steal
// each other's badge.
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

// One reload pattern everywhere: settings show the "reload to apply" nudge;
// nothing auto-reloads. This helper is used by the nudge's Reload button and
// refuses non-web pages (chrome://, the Web Store, …), where a reload either
// silently no-ops or throws.
async function reloadActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    let proto = "";
    try { proto = new URL(tab.url).protocol; } catch { return; }
    if (proto !== "http:" && proto !== "https:") return;
    await chrome.tabs.reload(tab.id);
  } catch {}
}

// A storage failure must not leave the popup blank with no feedback.
function reportStorageError() {
  showNudge();
  statusText.textContent = "Storage error — retry";
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
  try {
    state = await chrome.storage.sync.get(DEFAULTS);
  } catch { reportStorageError(); return; }
  applyUI(state);
  loadSiteUI(state);
}
load();

// ── Enable toggle ────────────────────────────────────────────────────────────

enabledEl.addEventListener("change", async () => {
  const enabled = enabledEl.checked;
  try { await chrome.storage.sync.set({ enabled }); }
  catch { enabledEl.checked = !enabled; reportStorageError(); return; } // switch must not show an unsaved value
  state.enabled = enabled;
  updateEnabledUI(enabled);
  showNudge(); // same "reload to apply" pattern as every other setting
});

// ── Grayscale ─────────────────────────────────────────────────────────────────

grayscaleEl.addEventListener("change", async () => {
  const grayscale = grayscaleEl.checked;
  try { await chrome.storage.sync.set({ grayscale }); }
  catch { grayscaleEl.checked = !grayscale; reportStorageError(); return; }
  state.grayscale = grayscale;
  showNudge();
});

// ── Quality presets ───────────────────────────────────────────────────────────

presetBtns.forEach(btn => {
  btn.addEventListener("click", async () => {
    const quality = Number(btn.dataset.q);
    if (quality === Number(state.quality)) return; // unchanged: nothing to apply
    try { await chrome.storage.sync.set({ quality }); }
    catch { reportStorageError(); return; }
    state.quality = quality; // only after a successful write: a failed click stays retryable
    setActivePreset(quality);
    showNudge(); // unified pattern: no unconditional auto-reload
  });
});

// ── Reload current tab (nudge button) ─────────────────────────────────────────

reloadBtn.addEventListener("click", async () => {
  await reloadActiveTab();
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
    sitePillEl.className   = "site-pill"; // the "excluded" class had no CSS
    sitePillEl.style.display = "";
    excludeBtn.textContent = "✕ Remove exclusion";
  } else {
    sitePillEl.style.display = "none";
    excludeBtn.textContent = "Exclude this site";
  }
}

// ── Exclude / re-include current site ─────────────────────────────────────────

excludeBtn.addEventListener("click", async () => {
  if (!currentIsWeb || !currentHost) return;
  let d;
  try { d = await chrome.storage.sync.get(DEFAULTS); }
  catch { reportStorageError(); return; }
  const raw  = String(d.excludeDomains || "");
  const excludedDomain = findExcludedDomain(currentHost, parseDomains(raw));
  let next;
  if (excludedDomain) {
    // B21: remove only the matching token, preserving the user's separators
    // and formatting (no lowercase + space-join rewrite of the whole field).
    next = raw.split(/([,\s]+)/)
      .filter(tok => /[,\s]/.test(tok) || parseDomains(tok)[0] !== excludedDomain)
      .join("");
  } else {
    next = raw.trim() ? raw.replace(/[\s,]*$/, "") + "\n" + currentHost : currentHost;
  }
  state.excludeDomains = next;
  try { await chrome.storage.sync.set({ excludeDomains: next }); }
  catch { reportStorageError(); return; }
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
  // The site card depends only on the exclusion list; enabled/proxyBase are
  // already rendered by applyUI() above.
  if ("excludeDomains" in changes) loadSiteUI(state);
});
