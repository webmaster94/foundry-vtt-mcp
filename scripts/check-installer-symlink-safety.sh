#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd -P)
BUILD_MAC="$REPO_ROOT/installer/build-mac-pkg.js"
LEGACY_POSTINSTALL="$REPO_ROOT/installer/mac/scripts/postinstall"
MAC_UNINSTALL="$REPO_ROOT/installer/Uninstall.tool"
WINDOWS_NSIS="$REPO_ROOT/installer/nsis/foundry-mcp-server.nsi"

fail() {
  echo "[installer-symlink-safety] FAIL: $*" >&2
  exit 1
}

first_line() {
  local file=$1
  local needle=$2
  local match
  match=$(grep -nF -m 1 -- "$needle" "$file" || true)
  [ -n "$match" ] || fail "missing guard/mutation '$needle' in $file"
  printf '%s\n' "${match%%:*}"
}

assert_before() {
  local file=$1
  local guard=$2
  local mutation=$3
  local guard_line mutation_line
  guard_line=$(first_line "$file" "$guard")
  mutation_line=$(first_line "$file" "$mutation")
  [ "$guard_line" -lt "$mutation_line" ] ||
    fail "guard '$guard' must precede '$mutation' in $file"
}

# Static ordering checks tie the executable fixture below to every production
# installer path. None may mutate the module target before rejecting links.
assert_before "$BUILD_MAC" 'if [ -L "$MODULE_DEST" ]; then' 'mkdir -p "$MODULE_DEST"'
assert_before "$BUILD_MAC" 'if [ -L "$MODULE_DEST" ]; then' 'rm -f -- "$WORLD_DIR/enhanced-creature-index.json"'
assert_before "$BUILD_MAC" 'if [ -L "$MODULE_DEST" ]; then' 'rm -rf "$MODULE_DEST/dist"'
assert_before "$BUILD_MAC" 'if [ -L "$MODULE_DEST" ]; then' 'if cp -R "$MODULE_SOURCE/." "$MODULE_DEST/"; then'
assert_before "$LEGACY_POSTINSTALL" 'if [ -L "$MODULE_DEST" ]; then' 'mkdir -p "$MODULE_DEST"'
assert_before "$LEGACY_POSTINSTALL" 'if [ -L "$MODULE_DEST" ]; then' 'rm -f -- "$WORLD_DIR/enhanced-creature-index.json"'
assert_before "$LEGACY_POSTINSTALL" 'if [ -L "$MODULE_DEST" ]; then' 'rm -rf "$MODULE_DEST/dist"'
assert_before "$LEGACY_POSTINSTALL" 'if [ -L "$MODULE_DEST" ]; then' 'cp -R "$MODULE_SOURCE/." "$MODULE_DEST/"'
assert_before "$MAC_UNINSTALL" 'if [ -L "$MODULE_PATH" ]; then' 'if [ -f "$MODULE_PATH/module.json" ]; then'
assert_before "$MAC_UNINSTALL" 'if [ -L "$MODULE_PATH" ]; then' 'rm -f -- "$WORLD_DIR/enhanced-creature-index.json"'
assert_before "$MAC_UNINSTALL" 'if [ -L "$MODULE_PATH" ]; then' 'rm -rf "$MODULE_PATH/dist"'
assert_before "$WINDOWS_NSIS" 'Call IsFoundryModuleTargetSafe' 'CreateDirectory "$FoundryPath\foundry-mcp-bridge"'
assert_before "$WINDOWS_NSIS" 'Call CleanFoundryModulePayload' 'CreateDirectory "$FoundryPath\foundry-mcp-bridge"'
assert_before "$WINDOWS_NSIS" 'Call IsFoundryModuleTargetSafe' 'SetOutPath "$FoundryPath\foundry-mcp-bridge"'

if grep -Fq 'RMDir /r "$FoundryPath\foundry-mcp-bridge' "$WINDOWS_NSIS" ||
  grep -Fq 'RMDir /r "$un.FoundryPath\foundry-mcp-bridge' "$WINDOWS_NSIS"; then
  fail 'Windows installer must delegate recursive module cleanup to its no-follow helper'
fi
grep -Fq 'Call un.CleanFoundryModulePayload' "$WINDOWS_NSIS" ||
  fail 'Windows uninstall must use guarded module cleanup'

reparse_checks=$(grep -Fc 'IntOp $6 $5 & 0x400' "$WINDOWS_NSIS" || true)
[ "$reparse_checks" -ge 2 ] || fail 'Windows install and uninstall both need reparse-point checks'

TMP_BASE=${TMPDIR:-/tmp}
TMP_BASE=${TMP_BASE%/}
FIXTURE_ROOT=$(mktemp -d "$TMP_BASE/foundry-mcp-module-safety.XXXXXX")

cleanup() {
  case "$FIXTURE_ROOT" in
    "$TMP_BASE"/foundry-mcp-module-safety.*)
      rm -rf -- "$FIXTURE_ROOT"
      ;;
    *)
      echo "Refusing to clean unexpected fixture path: $FIXTURE_ROOT" >&2
      ;;
  esac
}
trap cleanup EXIT

replace_module_safely() {
  local module_source=$1
  local module_dest=$2
  if [ -L "$module_dest" ]; then
    return 20
  fi
  mkdir -p "$module_dest"
  rm -rf "$module_dest/dist" "$module_dest/lang" "$module_dest/scripts" \
    "$module_dest/styles" "$module_dest/templates"
  cp -R "$module_source/." "$module_dest/"
}

remove_module_safely() {
  local module_path=$1
  if [ -L "$module_path" ]; then
    return 20
  fi
  rm -rf "$module_path/dist" "$module_path/lang" "$module_path/scripts" \
    "$module_path/styles" "$module_path/templates"
  rm -f "$module_path/module.json"
  rmdir "$module_path" 2>/dev/null || true
}

MODULES="$FIXTURE_ROOT/data/modules"
EXTERNAL="$FIXTURE_ROOT/external-target"
PAYLOAD="$FIXTURE_ROOT/payload"
MODULE_TARGET="$MODULES/foundry-mcp-bridge"
mkdir -p "$MODULES" "$EXTERNAL" "$PAYLOAD/dist"
printf 'external sentinel\n' > "$EXTERNAL/sentinel.txt"
printf 'new runtime\n' > "$PAYLOAD/dist/main.js"
printf '{"id":"foundry-mcp-bridge"}\n' > "$PAYLOAD/module.json"
ln -s "$EXTERNAL" "$MODULE_TARGET"

if replace_module_safely "$PAYLOAD" "$MODULE_TARGET"; then
  fail 'replacement followed a symlinked module target'
elif [ "$?" -ne 20 ]; then
  fail 'replacement failed for a reason other than the symlink guard'
fi
if remove_module_safely "$MODULE_TARGET"; then
  fail 'uninstall followed a symlinked module target'
elif [ "$?" -ne 20 ]; then
  fail 'uninstall failed for a reason other than the symlink guard'
fi
[ -L "$MODULE_TARGET" ] || fail 'module symlink was modified'
[ -f "$EXTERNAL/sentinel.txt" ] || fail 'external sentinel was modified through the symlink'

rm "$MODULE_TARGET"
mkdir -p "$MODULE_TARGET/dist" "$MODULE_TARGET/generated-maps"
printf 'old runtime\n' > "$MODULE_TARGET/dist/old.js"
printf 'user map\n' > "$MODULE_TARGET/generated-maps/map.webp"
printf 'user note\n' > "$MODULE_TARGET/user-note.txt"

replace_module_safely "$PAYLOAD" "$MODULE_TARGET"
[ ! -e "$MODULE_TARGET/dist/old.js" ] || fail 'old module-owned runtime survived replacement'
[ -f "$MODULE_TARGET/dist/main.js" ] || fail 'new module runtime was not installed'
[ -f "$MODULE_TARGET/generated-maps/map.webp" ] || fail 'generated map was removed during replacement'
[ -f "$MODULE_TARGET/user-note.txt" ] || fail 'user content was removed during replacement'

remove_module_safely "$MODULE_TARGET"
[ ! -e "$MODULE_TARGET/dist" ] || fail 'module-owned runtime survived uninstall'
[ -f "$MODULE_TARGET/generated-maps/map.webp" ] || fail 'generated map was removed during uninstall'
[ -f "$MODULE_TARGET/user-note.txt" ] || fail 'user content was removed during uninstall'

echo '[installer-symlink-safety] PASS: linked targets are refused and user content is preserved.'
