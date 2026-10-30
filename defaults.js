// Bandwidth Guardian — shared defaults
// Imported as an ES module by popup.js and options.js only.
// service-worker.js and content.js inline copies of DEFAULTS (classic scripts
// can't import) — search "KEEP IN SYNC".

export const DEFAULTS = {
  enabled:        true,
  saveData:       true,
  proxyBase:      "",
  quality:        60,    // default compression quality (1–100)
  grayscale:      true,  // grayscale ON by default (bw=1)
  maxWidth:       768,   // 0 = no limit; MV3-specific addition
  excludeDomains: "",
};
