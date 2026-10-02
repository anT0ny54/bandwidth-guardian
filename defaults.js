// Bandwidth Guardian — shared defaults
// Imported as an ES module by popup.js and options.js only.
// service-worker.js, content.js and prehook.js inline a copy of DEFAULTS
// (classic scripts can't import) — search "KEEP IN SYNC" when changing a key.
//
// Defaults mirror the original extension (ayastreb/bandwidth-hero):
//   convertBw: true  → grayscale: true
//   compressionLevel: 60 → quality: 60

export const DEFAULTS = {
  enabled:        true,
  proxyBase:      "",
  quality:        60,    // matches original compressionLevel default
  grayscale:      true,  // matches original convertBw: true — grayscale ON by default
  maxWidth:       768,   // 0 = no limit; MV3-specific addition
  excludeDomains: "",
};
