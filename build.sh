#!/usr/bin/env bash
# Bandwidth Guardian — production-grade reproducible MV3 build
# Usage: bash build.sh [--out DIR] [--check-only]

set -Eeuo pipefail
IFS=$'\n\t'

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OUTDIR="$ROOT_DIR"
EXPECTED_VERSION="${EXPECTED_VERSION:-0.0.5}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1709856000}"
CHECK_ONLY=0

usage() {
  cat <<USAGE
Usage: bash build.sh [--out DIR] [--check-only]

Environment:
  EXPECTED_VERSION=0.0.5  Release version guard (default: 0.0.5)
  SOURCE_DATE_EPOCH=...   Reproducible archive timestamp
USAGE
}

fail() { echo "ERROR: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ $# -ge 2 && -n "${2:-}" ]] || fail "--out requires a directory."
      OUTDIR="$2"; shift 2 ;;
    --check-only)
      CHECK_ONLY=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      usage >&2; fail "unknown argument: $1" ;;
  esac
done

command -v python3 >/dev/null 2>&1 || fail "python3 is required."
command -v zip >/dev/null 2>&1 || fail "zip is required."
command -v unzip >/dev/null 2>&1 || fail "unzip is required."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."

[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || fail "SOURCE_DATE_EPOCH must be an integer."
[[ -d "$ROOT_DIR" ]] || fail "source directory does not exist: $ROOT_DIR"
cd -- "$ROOT_DIR"
[[ -f manifest.json ]] || fail "manifest.json not found in $ROOT_DIR"

# Keep this allow-list explicit. Development files, CI metadata, README files,
# .git data, and stale archives cannot leak into the release package.
INCLUDE=(
  manifest.json defaults.js service-worker.js content.js prehook.js
  popup.html popup.css popup.js
  options.html options.css options.js
  shield.svg _locales icons
)

VERSION="$(EXPECTED_VERSION="$EXPECTED_VERSION" python3 - <<'PY'
import json, os
from pathlib import Path

root = Path.cwd()
try:
    data = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
except Exception as exc:
    raise SystemExit(f"invalid manifest.json: {exc}")

if data.get("manifest_version") != 3:
    raise SystemExit("manifest_version must be 3")

version = data.get("version")
if not isinstance(version, str) or not version.strip():
    raise SystemExit("manifest.json has no valid version")
version = version.strip()
expected = os.environ.get("EXPECTED_VERSION", "0.0.5")
if version != expected:
    raise SystemExit(f"version is {version!r}; expected {expected!r}")

# Validate package-relative files referenced by the manifest.
refs = []
def add(value, label):
    if isinstance(value, str) and value:
        refs.append((value, label))

def add_map(mapping, label):
    if isinstance(mapping, dict):
        for key, value in mapping.items():
            add(value, f"{label}[{key!r}]")

action = data.get("action")
if isinstance(action, dict):
    add(action.get("default_popup"), "action.default_popup")
    add_map(action.get("default_icon"), "action.default_icon")

options = data.get("options_ui")
if isinstance(options, dict):
    add(options.get("page"), "options_ui.page")
add(data.get("options_page"), "options_page")

background = data.get("background")
if isinstance(background, dict):
    add(background.get("service_worker"), "background.service_worker")
add_map(data.get("icons"), "icons")

for i, script in enumerate(data.get("content_scripts", []) or []):
    if not isinstance(script, dict):
        continue
    for j, value in enumerate(script.get("js", []) or []):
        add(value, f"content_scripts[{i}].js[{j}]")
    for j, value in enumerate(script.get("css", []) or []):
        add(value, f"content_scripts[{i}].css[{j}]")

for i, item in enumerate(data.get("web_accessible_resources", []) or []):
    if isinstance(item, dict):
        for j, value in enumerate(item.get("resources", []) or []):
            add(value, f"web_accessible_resources[{i}].resources[{j}]")

errors = []
for value, label in refs:
    if "://" in value or value.startswith(("/", "\\")):
        continue
    p = Path(value)
    if p.is_absolute() or ".." in p.parts:
        errors.append(f"{label}: unsafe path {value!r}")
        continue
    target = (root / p).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        errors.append(f"{label}: path escapes project root: {value!r}")
        continue
    if not target.is_file():
        errors.append(f"{label}: missing file: {value!r}")

default_locale = data.get("default_locale")
if default_locale:
    locale = root / "_locales" / str(default_locale) / "messages.json"
    if not locale.is_file():
        errors.append(f"default_locale messages file missing: {locale.relative_to(root)}")

if errors:
    raise SystemExit("manifest validation failed:\n  - " + "\n  - ".join(errors))

print(version)
PY
)" || exit 1

# Validate all declared package inputs before creating anything.
for item in "${INCLUDE[@]}"; do
  path="$ROOT_DIR/$item"
  [[ -e "$path" ]] || fail "required build item is missing: $item"
  [[ ! -L "$path" ]] || fail "top-level package item must not be a symlink: $item"
done

[[ -d _locales/en ]] || fail "_locales/en is required."
[[ -d icons ]] || fail "icons directory is required."
[[ -f popup.css ]] || fail "popup.css is required."
[[ -f options.css ]] || fail "options.css is required."
[[ -f shield.svg ]] || fail "shield.svg is required."

# Catch symlinks anywhere under package directories.
while IFS= read -r -d '' link; do
  fail "symlink found in package tree: ${link#$ROOT_DIR/}"
done < <(find _locales icons -type l -print0)

# HTML policy for the clean UI: styles are externalized.
python3 - <<'PY'
from html.parser import HTMLParser
from pathlib import Path

class Parser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.style_tags = 0
        self.inline_styles = 0
        self.stylesheets = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag.lower() == "style": self.style_tags += 1
        if "style" in attrs: self.inline_styles += 1
        if tag.lower() == "link" and attrs.get("rel", "").lower() == "stylesheet":
            self.stylesheets.append(attrs.get("href", ""))

for name in ("popup.html", "options.html"):
    p = Path(name)
    parser = Parser()
    parser.feed(p.read_text(encoding="utf-8"))
    if parser.style_tags:
        raise SystemExit(f"{name}: inline <style> blocks are not allowed")
    if parser.inline_styles:
        raise SystemExit(f"{name}: inline style attributes are not allowed")
    for href in parser.stylesheets:
        if href and not href.startswith(("/", "http:", "https:")):
            target = (p.parent / href).resolve()
            if not target.is_file():
                raise SystemExit(f"{name}: missing stylesheet: {href}")
PY

if (( CHECK_ONLY )); then
  echo "OK: validation passed for Bandwidth Guardian v$VERSION."
  exit 0
fi

mkdir -p -- "$OUTDIR"
OUTDIR="$(cd -- "$OUTDIR" && pwd -P)"
ZIPFILE="$OUTDIR/bandwidth-guardian-$VERSION.zip"

STAGING="$(mktemp -d "${TMPDIR:-/tmp}/bandwidth-guardian-build.XXXXXX")"
TMP_LIST="$(mktemp)"
cleanup() { rm -rf -- "$STAGING"; rm -f -- "$TMP_LIST"; }
trap cleanup EXIT HUP INT TERM

for item in "${INCLUDE[@]}"; do
  cp -R -- "$ROOT_DIR/$item" "$STAGING/"
done

if find "$STAGING" -type l -print -quit | grep -q .; then
  fail "staged package contains a symlink"
fi

# Normalize mtimes and create the ZIP from inside staging so manifest.json is
# always at archive root. No wrapper directory can be produced by this method.
find "$STAGING" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
rm -f -- "$ZIPFILE"
(
  cd -- "$STAGING"
  find . -type f -print | sed 's#^\./##' | LC_ALL=C sort | zip -X -q "$ZIPFILE" -@
)

[[ -s "$ZIPFILE" ]] || fail "ZIP was not created: $ZIPFILE"
unzip -Z1 "$ZIPFILE" > "$TMP_LIST"

python3 - "$ZIPFILE" "$TMP_LIST" "$EXPECTED_VERSION" <<'PY'
import json, sys, zipfile
from pathlib import PurePosixPath

zip_path, list_path, expected = sys.argv[1:]
names = [x.strip() for x in open(list_path, encoding="utf-8") if x.strip()]

if names.count("manifest.json") != 1:
    raise SystemExit("manifest.json must appear exactly once at ZIP root")
if any(n.startswith("bandwidth-guardian-main/") for n in names):
    raise SystemExit("forbidden top-level bandwidth-guardian-main/ wrapper detected")
if any(n.startswith("./") for n in names):
    raise SystemExit("unsafe ./ ZIP entry detected")
if any(PurePosixPath(n).is_absolute() or ".." in PurePosixPath(n).parts for n in names):
    raise SystemExit("unsafe ZIP path detected")

with zipfile.ZipFile(zip_path) as z:
    if len(names) != len(set(names)):
        raise SystemExit("duplicate ZIP entries detected")
    manifest = json.loads(z.read("manifest.json"))
    if manifest.get("manifest_version") != 3:
        raise SystemExit("packaged manifest_version is not 3")
    if manifest.get("version") != expected:
        raise SystemExit(f"packaged version is {manifest.get('version')!r}; expected {expected!r}")
    if any(n.endswith("/") for n in z.namelist()):
        raise SystemExit("unexpected directory entry detected")

print(f"Validated {len(names)} ZIP files")
PY

unzip -tq "$ZIPFILE" >/dev/null
zip -T "$ZIPFILE" >/dev/null
SHA256="$(sha256sum "$ZIPFILE" | awk '{print $1}')"
SIZE="$(wc -c < "$ZIPFILE" | tr -d ' ')"
COUNT="$(wc -l < "$TMP_LIST" | tr -d ' ')"

printf 'Release validation: PASS\n'
printf '  Version : %s\n' "$VERSION"
printf '  Files   : %s\n' "$COUNT"
printf '  Size    : %s bytes\n' "$SIZE"
printf '  SHA256  : %s\n' "$SHA256"
printf '  Output  : %s\n' "$ZIPFILE"
