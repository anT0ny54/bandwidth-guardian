#!/usr/bin/env bash
# Bandwidth Guardian — reproducible extension build

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTDIR="$ROOT_DIR/dist"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 ]] || { echo "ERROR: --out requires a directory" >&2; exit 2; }
      OUTDIR="$2"
      shift 2
      ;;
    *)
      echo "Usage: bash build.sh [--out DIR]" >&2
      exit 2
      ;;
  esac
done

OUTDIR="$(mkdir -p "$OUTDIR" && cd "$OUTDIR" && pwd)"

VERSION="$(python3 - "$ROOT_DIR/manifest.json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    print(json.load(f)['version'])
PY
)"

[[ "$VERSION" == "0.0.5" ]] || {
  echo "ERROR: expected version 0.0.5, found $VERSION" >&2
  exit 1
}

ZIPFILE="$OUTDIR/bandwidth-guardian-$VERSION.zip"
SOURCE_DATE_EPOCH=1709856000

INCLUDE=(
  manifest.json
  defaults.js
  service-worker.js
  content.js
  prehook.js
  popup.html
  popup.css
  popup.js
  options.html
  options.css
  options.js
  shield.svg
  _locales
  icons
)

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

for item in "${INCLUDE[@]}"; do
  if [[ ! -e "$ROOT_DIR/$item" ]]; then
    echo "ERROR: required build file is missing: $item" >&2
    exit 1
  fi
  cp -R "$ROOT_DIR/$item" "$STAGING/"
done

python3 - "$STAGING/manifest.json" "${INCLUDE[@]}" <<'PY'
import json, os, sys
manifest_path = sys.argv[1]
with open(manifest_path, encoding='utf-8') as f:
    manifest = json.load(f)
assert manifest.get('manifest_version') == 3, 'Manifest V3 required'
assert manifest.get('version') == '0.0.5', 'Version must be 0.0.5'
for item in sys.argv[2:]:
    if not os.path.exists(os.path.join(os.path.dirname(manifest_path), item)):
        raise SystemExit(f'Missing staged item: {item}')
PY

find "$STAGING" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
rm -f "$ZIPFILE"
(
  cd "$STAGING"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort | zip -X -q "$ZIPFILE" -@
)

unzip -tq "$ZIPFILE" >/dev/null
unzip -Z1 "$ZIPFILE" | grep -Fxq 'manifest.json'
unzip -Z1 "$ZIPFILE" | grep -Fxq 'popup.css'
unzip -Z1 "$ZIPFILE" | grep -Fxq 'options.css'
unzip -Z1 "$ZIPFILE" | grep -Fxq 'shield.svg'
! unzip -Z1 "$ZIPFILE" | grep -q '^bandwidth-guardian-main/'

echo "Built: $ZIPFILE"
echo "SHA256: $(sha256sum "$ZIPFILE" | awk '{print $1}')"
