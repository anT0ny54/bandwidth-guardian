// Bandwidth Guardian — shared defaults
// Single source of truth. service-worker.js, options.js, popup.js import this.
// content.js and prehook.js inline a copy (search "KEEP IN SYNC").
//
// Defaults mirror the original extension (ayastreb/bandwidth-hero):
//   convertBw: true  → grayscale: true
//   compressionLevel: 40 → quality: 40

export const DEFAULTS = {
  enabled:        true,
  proxyBase:      "",
  quality:        40,    // matches original compressionLevel default
  grayscale:      true,  // matches original convertBw: true — grayscale ON by default
  maxWidth:       1920,  // 0 = no limit; MV3-specific addition
  excludeDomains: "google.com gstatic.com",
  isWebpSupported: false, // detected at install/startup; used to decide jpeg= param
};


// BHP2/Netlify accepts the proxy through /api/*; accept a bare site URL too.
export function normalizeProxyBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
    const path = url.pathname.replace(/\/+$/, "");
    if (!path || path === "") url.pathname = "/api";
    else if (path === "/api") url.pathname = "/api";
    else url.pathname = path;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}
