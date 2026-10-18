// Bandwidth Guardian — shared defaults
// Imported as an ES module by popup.js and options.js only.
// service-worker.js and content.js inline copies of DEFAULTS (classic scripts
// can't import) — search "KEEP IN SYNC".

export const DEFAULTS = {
  enabled:        true,
  saveData:       true,
  proxyBase:      "",
  quality:        60,    // matches original compressionLevel default
  grayscale:      true,  // matches original convertBw: true — grayscale ON by default
  maxWidth:       768,   // 0 = no limit; MV3-specific addition
  excludeDomains: "",
};
