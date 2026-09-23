#!/bin/sh
# Copies the Black Window engine build (blackwidow/engine/dist) into media/ and records the commit it came from.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
bw=${BLACKWIDOW:-"$here/../blackwidow"}
[ -d "$bw/engine/dist" ] || { echo "no engine build at $bw/engine/dist (run blackwidow/engine/stage.sh first)"; exit 1; }
rm -rf "$here/media" && mkdir -p "$here/media"
rsync -a --exclude bench --exclude '*.py' "$bw/engine/dist/" "$here/media/"
# The reader's mean vector (anisotropy centring) is served from /libs on the site, outside engine/dist.
mkdir -p "$here/media/libs" && cp "$bw/research/results/bge_mu.json" "$here/media/libs/bge_mu.json"
(cd "$bw" && git rev-parse --short HEAD) > "$here/media/ENGINE_COMMIT"
echo "engine $(cat "$here/media/ENGINE_COMMIT") -> media/ ($(du -sh "$here/media" | cut -f1))"
