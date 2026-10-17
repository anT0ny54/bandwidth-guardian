#!/usr/bin/env bash
# Bandwidth Guardian — reproducible build (Chrome/Chromium MV3 only)
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(sed -nE 's/.*"version": *"([^"]+)".*/\1/p' manifest.json | head -n1)
STAGE=".build/stage"
# Absolute output path: zipping from inside $STAGE with a relative "../" put
# the zip in .build/ where the cleanup line below deleted it (CI: upload found
# nothing). An absolute path lands at the repo root no matter who invokes us.
ROOT="$(pwd)"
OUT="$ROOT/bandwidth-guardian-main.zip"

INCLUDE=(
  manifest.json defaults.js service-worker.js prehook.js content.js
  popup.html popup.js options.html options.js
  README.md LICENSE CHANGELOG.md
  _locales icons
)

rm -rf .build
mkdir -p "$STAGE"

# Stage only the INCLUDE entries (R11: staging can never contain a stray
# top-level directory, so the old bandwidth-guardian-main/ guard is gone).
for f in "${INCLUDE[@]}"; do
  [ -e "$f" ] && cp -r "$f" "$STAGE/$f"
done

# O10: syntax-check with the correct module semantics. Classic scripts (SW,
# content scripts, MAIN-world prehook) must NOT be validated as modules —
# module rules would wrongly allow top-level await in the classic SW.
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
for f in service-worker.js prehook.js content.js; do
  cp "$STAGE/$f" "$TMP/$(basename "$f" .js).cjs"
  node --check "$TMP/$(basename "$f" .js).cjs"
done
for f in defaults.js popup.js options.js; do
  cp "$STAGE/$f" "$TMP/$(basename "$f" .js).mjs"
  node --check "$TMP/$(basename "$f" .js).mjs"
done

# Manifest sanity: MV3, Chrome-only.
node -e 'const m=require("./'"$STAGE"'/manifest.json");
  if (m.manifest_version !== 3) throw new Error("manifest_version must be 3");
  if (m.browser_specific_settings?.gecko) throw new Error("gecko block must not be present (Chrome-only)");
  if (!m.minimum_chrome_version) throw new Error("minimum_chrome_version missing");'

# O10: normalize file modes so zips are reproducible across machines.
chmod -R u=rwX,go=rX "$STAGE"

# zip to stdout, redirected by the shell from the repo root: a shell
# redirect is interpreted in the invoking directory (some zip builds also
# mangle absolute output paths given after cd-ing elsewhere), so OUT — which
# now lives OUTSIDE .build — is always written correctly and survives cleanup.
( cd "$STAGE" && zip -qr - . ) > "$OUT"
rm -rf .build
echo "Built $(basename "$OUT") (v$VERSION)"
