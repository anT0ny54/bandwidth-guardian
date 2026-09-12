# Bandwidth Guardian v0.1.0 — BHP2 v2.2.3 MAX-SAVINGS

- Dynamic lazy-image attributes: data-src, data-iurl, data-lazy-src, data-original, data-url, data-hi-res, data-lazy, data-echo, data-image, data-original-src.
- Responsive images: native Chromium selection is preserved; only the currently selected `currentSrc` candidate is rewritten when possible.
- Framework images: early MAIN-world src/setAttribute hooks plus isolated MutationObserver fallback.
- Background images: inline style scans plus guarded CSSStyleDeclaration background/backgroundImage setters.
- Duplicate suppression: shared URL->proxy cache/dedupe across elements.
- LCP safety: preload is untouched; no loading-mode changes; proxy fail-open remains 1.8s for high/eager and 4.5s normal in the isolated layer, with MAIN-world 1.8/4.5s escape hatches.
- Metrics: BHP2 original/compressed/saved bytes plus observed direct image bytes are stored locally. Direct bytes are an observation, not a perfect leakage metric because intentionally excluded images also count.
