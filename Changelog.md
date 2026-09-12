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

## Version 0.1.1
Mobile UI + Chromium-fork fixes. No changes to the interception/proxy logic.

- Popup now renders correctly on Android forks that lack a floating toolbar
  popup (Kiwi, Cromite's experimental extension support), which open
  `popup.html` as a normal full-width tab instead of an anchored window.
  It previously shipped with the viewport hard-pinned to 320px, so it
  rendered as a narrow, letterboxed column on a phone screen.
- Fixed by switching the popup viewport to `width=device-width` (matching
  the options page) and adding a `min-width:360px` CSS rule that only
  applies when the page is genuinely rendered at phone width or wider —
  it cannot be triggered by a real anchored desktop popup, since Chrome's
  popup auto-sizing already fits the window to the fixed 320px layout used
  below that breakpoint. Desktop popup rendering (Chrome, Brave, Edge,
  Vivaldi, and other desktop Chromium forks) is unchanged.
- Added a `color-scheme` meta tag to the options page (already present on
  the popup) so native form controls (checkboxes, scrollbars) theme
  consistently with light/dark mode across Chromium forks.
