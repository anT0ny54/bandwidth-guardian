// Bandwidth Guardian — shared defaults
// Loaded as a classic script by the service worker (importScripts), the isolated
// content script, and the extension pages. Keep this file free of imports and
// exports so all of those contexts can share one frozen definition.

var DEFAULTS = Object.freeze({
  enabled:         true,
  saveData:        true,
  proxyBase:       "",
  quality:         60,    // default compression quality (1–100)
  grayscale:       true,  // grayscale ON by default (bw=1)
  maxWidth:        768,   // 0 = no limit; MV3-specific addition
  excludeDomains:  "",
});

// True when two settings objects agree on every key in DEFAULTS. Used by the
// worker and the isolated content script to skip redundant re-applies.
function sameOpts(a, b) {
  return !!a && !!b && Object.keys(DEFAULTS).every(k => a[k] === b[k]);
}
