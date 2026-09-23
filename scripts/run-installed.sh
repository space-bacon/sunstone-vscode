#!/usr/bin/env bash
# Installs the built VSIX into a throwaway profile and runs test/installed.ts against it.
#
# Every other run uses extensionDevelopmentPath, which loads the source tree. That proves the code works
# and says nothing about the package: it was a denylist package for months and carried 2.5 MB of
# assessment artifacts (C53) without a single run noticing. This is the only path that exercises what a
# Marketplace user downloads.
set -euo pipefail
cd "$(dirname "$0")/.."

udd="${SUNSTONE_INSTALLED_UDD:-/tmp/sunstone-installed-udd}"
ext="${SUNSTONE_INSTALLED_EXT:-/tmp/sunstone-installed-ext}"
code="${SUNSTONE_CODE:-/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code}"
version=$(node -p "require('./package.json').version")
vsix="out/sunstone-${version}.vsix"

[[ -x "$code" ]] || { echo "no code CLI at '$code'; set SUNSTONE_CODE" >&2; exit 1; }

npm run package

# Throwaway, so a stale install from a previous run cannot be what the test actually loads.
rm -rf "$udd" "$ext"
mkdir -p "$udd" "$ext"

"$code" --install-extension "$vsix" --user-data-dir "$udd" --extensions-dir "$ext" --force
"$code" --list-extensions --show-versions --user-data-dir "$udd" --extensions-dir "$ext"

# What executes is the unpacked VSIX, not this checkout. The test runner needs a development path to load the
# test module at all, so it gets the installed copy's own directory rather than the source tree.
unpacked=$(ls -d "$ext"/sunstonenorth.sunstone-* | head -1)
[[ -d "$unpacked" ]] || { echo "install produced no unpacked extension under $ext" >&2; exit 1; }
[[ -f "$unpacked/out/extension.js" ]] || { echo "$unpacked carries no out/extension.js" >&2; exit 1; }
echo "running against $unpacked"

SUNSTONE_TEST=installed \
SUNSTONE_UDD="$udd" \
SUNSTONE_EXT="$ext" \
SUNSTONE_DEV_PATH="$unpacked" \
SUNSTONE_INSTALLED=1 \
node out/test/run.js

echo
echo "installed-package run:"
node -e "const j=require('./out/test/installed.json');for(const k of Object.keys(j))console.log('  '+k+': '+JSON.stringify(j[k]));"
