Bandwidth Guardian v0.0.9.6 — conservative Android Chromium build

Built from the tested v0.0.9.5 baseline.

Changes:
- LRU behavior for the bounded proxy URL cache, keeping frequently reused image variants hot.
- Cache capacity increased modestly to 1536 entries for better reuse without unbounded memory growth.
- No srcset interception.
- No picture/source interception.
- No preload interception.
- No MAIN-world hook.
- Original-image failover preserved.
- Conservative DNS/network behavior preserved.

## Version 0.1.0
Promoted from the verified v0.0.9.6 build without changing runtime behavior.
