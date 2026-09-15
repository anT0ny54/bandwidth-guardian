// Bandwidth Guardian — shared defaults (ES module)
// Used by options.js and popup.js, which load as `type="module"` documents.
// service-worker.js inlines its own copy — classic (non-module) service
// workers can't `import` on Kiwi/Cromite (see the comment there). The
// content-script copy (prehook.js + content.js) now lives once in
// shared.js instead of two independently maintained copies.
//
// Defaults mirror the original extension (ayastreb/bandwidth-hero):
//   convertBw: true  → grayscale: true
//   compressionLevel: 40 → quality: 40

export const DEFAULTS = {
  enabled:        true,
  proxyBase:      "",
  quality:        40,    // matches original compressionLevel default
  grayscale:      true,  // matches original convertBw: true — grayscale ON by default
  maxWidth:       1280,  // 0 = no limit; MV3-specific addition
  // google.com/gstatic.com: reCAPTCHA. challenges.cloudflare.com: Cloudflare
  // Turnstile. Proxying these breaks the challenge widgets, so they're
  // excluded by default rather than something users have to discover.
  excludeDomains: "google.com gstatic.com challenges.cloudflare.com",
  isWebpSupported: false, // detected at install/startup; used to decide jpeg= param
};
