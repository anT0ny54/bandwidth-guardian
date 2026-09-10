#!/usr/bin/env bash
# Bandwidth Guardian — reproducible MV3 build script
# Usage: bash build.sh [--out DIR]

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OUTDIR="$ROOT_DIR"

usage() {
  echo "Usage: bash build.sh [--out DIR]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "ERROR: --out requires a directory." >&2
        usage >&2
        exit 2
      fi
      OUTDIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v python3 >/dev/null 2>&1 || { echo "ERROR: python3 is required." >&2; exit 1; }
command -v zip >/dev/null 2>&1 || { echo "ERROR: zip is required." >&2; exit 1; }

mkdir -p -- "$OUTDIR"
OUTDIR="$(cd -- "$OUTDIR" && pwd -P)"

cd -- "$ROOT_DIR"

if [[ ! -f manifest.json ]]; then
  echo "ERROR: manifest.json not found in $ROOT_DIR" >&2
  exit 1
fi

VERSION="$(python3 - <<'PY'
import json
from pathlib import Path

path = Path("manifest.json")
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception as exc:
    raise SystemExit(f"ERROR: invalid manifest.json: {exc}")

version = data.get("version")
if not isinstance(version, str) or not version.strip():
    raise SystemExit("ERROR: manifest.json has no valid version")
print(version.strip())
PY
)"

ZIPFILE="$OUTDIR/bandwidth-guardian-$VERSION.zip"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1709856000}"

# Files/directories intentionally shipped in the extension package.
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

echo "Building Bandwidth Guardian v$VERSION..."
echo "Source: $ROOT_DIR"
echo "Output: $ZIPFILE"

# Fail on missing package files instead of silently producing a broken extension.
for item in "${INCLUDE[@]}"; do
  if [[ ! -e "$ROOT_DIR/$item" ]]; then
    echo "ERROR: required build item is missing: $item" >&2
    exit 1
  fi
done

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/bandwidth-guardian-build.XXXXXX")"
cleanup() {
  rm -rf -- "$STAGING"
}
trap cleanup EXIT

for item in "${INCLUDE[@]}"; do
  cp -R -- "$ROOT_DIR/$item" "$STAGING/"
done

# Normalize source mtimes for deterministic archives.
find "$STAGING" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

# Do not accidentally append to an old archive.
rm -f -- "$ZIPFILE"

(
  cd -- "$STAGING"
  find . -type f -print | LC_ALL=C sort | zip -X -q -@ "$ZIPFILE"
)

echo "Done: $ZIPFILE"
