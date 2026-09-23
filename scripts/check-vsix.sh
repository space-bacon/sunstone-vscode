#!/usr/bin/env bash
# Fails if the VSIX carries anything outside the four things that ship.
#
# The rule alone did not hold: .vscodeignore was a denylist and 14 assessment artifacts from
# .sunstone/ went into the package, 2.5 MB of absolute home paths, private register content and
# shell commands from past sessions. The allowlist fixed that instance. This fails the build on
# the next one, which is the difference between a rule and a check.
set -euo pipefail

vsix="${1:-}"
if [[ -z "$vsix" ]]; then
  vsix=$(ls -t out/*.vsix 2>/dev/null | head -1)
fi
[[ -f "$vsix" ]] || { echo "check-vsix: no VSIX at '${vsix:-out/*.vsix}'" >&2; exit 1; }

# Anything not matching one of these is a defect. Extend it deliberately, never to silence a failure.
allowed='^extension/(out/extension\.js|out/extension\.js\.map|media/|resources/|docs/GUIDE\.md|package\.json|readme\.md|changelog\.md|LICENSE\.txt)|^\[Content_Types\]\.xml$|^extension\.vsixmanifest$'

unexpected=$(unzip -Z1 "$vsix" | grep -Ev "$allowed" || true)
if [[ -n "$unexpected" ]]; then
  echo "check-vsix: $vsix carries files that do not ship:" >&2
  echo "$unexpected" | sed 's/^/  /' >&2
  echo "Add them to the allowlist in .vscodeignore only if they genuinely belong in the package." >&2
  exit 1
fi

# A secret in the package is worse than a stray file, so look for one whatever its path.
if unzip -p "$vsix" 'extension/out/extension.js' 'extension/media/*' 2>/dev/null \
   | grep -qiE 'sunstone\.key:|-----BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{32}'; then
  echo "check-vsix: $vsix appears to contain a key or key material" >&2
  exit 1
fi

# A resource named in the manifest or the bundle but absent from the package is a broken icon at
# runtime and nothing at build time. Renaming resources/sunstone.svg left src/chat.ts pointing at a
# file that no longer existed, and only a grep caught it.
present=$(unzip -Z1 "$vsix" | sed -n 's|^extension/||p')
missing=""
for ref in $(unzip -p "$vsix" 'extension/package.json' 'extension/out/extension.js' 2>/dev/null \
             | grep -oE '"resources", "[A-Za-z0-9._-]+"|resources/[A-Za-z0-9._-]+' \
             | sed -e 's|", "|/|' -e 's|"||g' | sort -u); do
  grep -qxF "$ref" <<<"$present" || missing="$missing $ref"
done
if [[ -n "$missing" ]]; then
  echo "check-vsix: referenced but not packaged:$missing" >&2
  exit 1
fi

count=$(unzip -Z1 "$vsix" | wc -l | tr -d ' ')
size=$(du -h "$vsix" | cut -f1)
echo "check-vsix: $vsix is clean, $count files, $size"
