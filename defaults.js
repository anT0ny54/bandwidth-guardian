// Bandwidth Guardian — shared defaults
// Single source of truth for extension settings.

export const DEFAULTS = {
  enabled:        true,
  proxyBase:      "",
  quality:        40,
  grayscale:      true,
  maxWidth:       1920,
  mobileMaxWidth: 1280,
  excludeDomains: "google.com gstatic.com",
  isWebpSupported: false,
  failoverOriginal: true,
};

// BHP2 is deployed as a Netlify function at /api.
// Accept either the exact endpoint or a bare site URL.
export function normalizeProxyBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return raw;

    url.hash = "";
    url.search = "";

    const path = url.pathname.replace(/\/+$/, "");
    if (!path || path === "/") url.pathname = "/api";
    else url.pathname = path;

    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/+$/, "");
  }
}
