#!/usr/bin/env bash
# Bandwidth Guardian — safe production build
# Packages the existing source files without modifying extension logic.
# Usage: bash build.sh [--out DIR] [--version VERSION]

set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OUTDIR="$ROOT_DIR"
OVERRIDE_VERSION=""
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1709856000}"

usage() {
  echo "Usage: bash build.sh [--out DIR] [--version VERSION]"
}

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 && -n "${2:-}" ]] || fail "--out requires a directory"
      OUTDIR="$2"
      shift 2
      ;;
    --version)
      [[ $# -ge 2 && -n "${2:-}" ]] || fail "--version requires a version string"
      OVERRIDE_VERSION="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown argument: $1"
      ;;
  esac
done

command -v python3 >/dev/null 2>&1 || fail "python3 is required"
command -v zip >/dev/null 2>&1 || fail "zip is required"
command -v unzip >/dev/null 2>&1 || fail "unzip is required"

[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || fail "SOURCE_DATE_EPOCH must be an integer"
[[ -f "$ROOT_DIR/manifest.json" ]] || fail "manifest.json not found"

cd -- "$ROOT_DIR"

VERSION="$(python3 - <<'PY'
import json
from pathlib import Path

p = Path("manifest.json")
data = json.loads(p.read_text(encoding="utf-8"))

if data.get("manifest_version") != 3:
    raise SystemExit("manifest_version must be 3")

version = data.get("version")
if not isinstance(version, str) or not version.strip():
    raise SystemExit("manifest.json has no valid version")

# This project is intentionally still on 0.0.5.
if version != "0.0.5":
    raise SystemExit(f"expected version 0.0.5, found {version!r}")

print(version)
PY
)"

# Allow override for dev/release builds
if [[ -n "$OVERRIDE_VERSION" ]]; then
  VERSION="$OVERRIDE_VERSION"
fi

# Exact runtime package. Keep this list explicit so source/CI files cannot
# accidentally enter the extension ZIP.
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

for item in "${INCLUDE[@]}"; do
  [[ -e "$ROOT_DIR/$item" ]] || fail "required file/directory missing: $item"
done

mkdir -p -- "$OUTDIR"
OUTDIR="$(cd -- "$OUTDIR" && pwd -P)"
ZIPFILE="$OUTDIR/bandwidth-guardian-$VERSION.zip"

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/bandwidth-guardian.XXXXXX")"
LISTFILE="$(mktemp "${TMPDIR:-/tmp}/bandwidth-guardian-list.XXXXXX")"
cleanup() {
  rm -rf -- "$STAGING"
  rm -f -- "$LISTFILE"
}
trap cleanup EXIT HUP INT TERM

# Copy only runtime files. Nothing in the source tree is changed.
for item in "${INCLUDE[@]}"; do
  cp -R -- "$ROOT_DIR/$item" "$STAGING/"
done

# Normalize only the temporary staging tree for reproducible ZIPs.
find "$STAGING" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +

# Always build from inside staging. This guarantees manifest.json is at ZIP root.
rm -f -- "$ZIPFILE"
(
  cd -- "$STAGING"
  find . -type f -print0 \
    | LC_ALL=C sort -z \
    | tr '\0' '\n' \
    | sed 's#^\./##' \
    > "$LISTFILE"
  zip -X -q "$ZIPFILE" -@ < "$LISTFILE"
)

[[ -s "$ZIPFILE" ]] || fail "failed to create $ZIPFILE"

# Release-package sanity checks. These inspect the ZIP; they do not modify it.
unzip -tq "$ZIPFILE" >/dev/null
unzip -Z1 "$ZIPFILE" > "$LISTFILE"

python3 - "$ZIPFILE" "$LISTFILE" <<'PY'
import json
import sys
import zipfile

zip_path, list_path = sys.argv[1:]
names = [x.strip() for x in open(list_path, encoding="utf-8") if x.strip()]

if names.count("manifest.json") != 1:
    raise SystemExit("manifest.json is not exactly once at ZIP root")

if any(name.startswith("bandwidth-guardian-main/") for name in names):
    raise SystemExit("top-level bandwidth-guardian-main/ wrapper detected")

if any(name.startswith("./") for name in names):
    raise SystemExit("invalid ./ ZIP entry detected")

with zipfile.ZipFile(zip_path) as z:
    if len(z.namelist()) != len(set(z.namelist())):
        raise SystemExit("duplicate ZIP entries detected")

    manifest = json.loads(z.read("manifest.json"))
    if manifest.get("manifest_version") != 3:
        raise SystemExit("packaged manifest_version is not 3")
    if manifest.get("version") != "0.0.5":
        raise SystemExit("packaged version is not 0.0.5")

    # Every manifest-local reference that should be a packaged file must exist.
    refs = []
    def add(value):
        if isinstance(value, str) and value and not value.startswith(("http:", "https:", "/")):
            refs.append(value)

    action = manifest.get("action", {})
    if isinstance(action, dict):
        add(action.get("default_popup"))
        icons = action.get("default_icon", {})
        if isinstance(icons, dict):
            for value in icons.values(): add(value)

    add(manifest.get("options_page"))
    background = manifest.get("background", {})
    if isinstance(background, dict): add(background.get("service_worker"))

    icons = manifest.get("icons", {})
    if isinstance(icons, dict):
        for value in icons.values(): add(value)

    for script in manifest.get("content_scripts", []) or []:
        if isinstance(script, dict):
            for value in script.get("js", []) or []: add(value)
            for value in script.get("css", []) or []: add(value)

    packaged = set(z.namelist())
    missing = sorted({r for r in refs if r not in packaged})
    if missing:
        raise SystemExit("manifest references missing package files: " + ", ".join(missing))
PY

if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$ZIPFILE" | awk '{print $1}')"
else
  SHA256="unavailable"
fi

SIZE="$(wc -c < "$ZIPFILE" | tr -d ' ')"
COUNT="$(wc -l < "$LISTFILE" | tr -d ' ')"

echo "Build OK: Bandwidth Guardian v$VERSION"
echo "  Files : $COUNT"
echo "  Size  : $SIZE bytes"
echo "  SHA256: $SHA256"
echo "  ZIP   : $ZIPFILE"
