#!/usr/bin/env bash
# Bandwidth Guardian — reproducible build script

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTDIR="$ROOT_DIR"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUTDIR="${2:-}"
      shift 2
      ;;
    *)
      echo "Usage: bash build.sh [--out DIR]"
      exit 1
      ;;
  esac
done

mkdir -p "$OUTDIR"

VERSION="$(
  python3 - <<'PY'
import json
with open('manifest.json', 'r', encoding='utf-8') as f:
    print(json.load(f)['version'])
PY
)"

ZIPFILE="$OUTDIR/bandwidth-guardian-$VERSION.zip"
SOURCE_DATE_EPOCH=1709856000

echo "Building Bandwidth Guardian v$VERSION..."

INCLUDE=(
  manifest.json
  defaults.js
  service-worker.js
  content.js
  prehook.js
  popup.html
  popup.js
  options.html
  options.js
  _locales
  icons
)

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

for item in "${INCLUDE[@]}"; do
  if [[ -e "$ROOT_DIR/$item" ]]; then
    cp -R "$ROOT_DIR/$item" "$STAGING/"
  else
    echo "WARNING: missing $item, skipping"
  fi
done

find "$STAGING" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

(
  cd "$STAGING"
  find . -type f | LC_ALL=C sort | zip -X -q -@ "$ZIPFILE"
)

echo "Done: $ZIPFILE"
