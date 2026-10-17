// Bandwidth Guardian — shared defaults
// Imported as an ES module by popup.js, options.js and service-worker.js
// ("type": "module"). content.js is a classic script (it can't import), so it
// keeps an inline copy of DEFAULTS — search "KEEP IN SYNC". prehook.js runs in
// the page's MAIN world and gets its settings over a DOM event instead.
// IMAGE_CONTENT_TYPES is only used by service-worker.js.

export const DEFAULTS = {
  enabled:        true,
  saveData:       true,
  proxyBase:      "",
  quality:        60,    // matches original compressionLevel default
  grayscale:      true,  // matches original convertBw: true — grayscale ON by default
  maxWidth:       768,   // 0 = no limit; MV3-specific addition
  excludeDomains: "",
};

// STRICT detected image types: a proxy response is only ever accounted (and
// treated as an image result) when its Content-Type is one of these.
export const IMAGE_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/tiff", "image/jxl"];
