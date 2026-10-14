#!/usr/bin/env bash
# Rates one UX tour with an independent agent. Usage: rate.sh <tour-dir>
set -euo pipefail
tour_dir="$1"
here="$(cd "$(dirname "$0")" && pwd)"
images=()
for image in "$tour_dir"/*.png; do images+=(-i "$image"); done
prompt="$(cat "$here/prompt.md")

notes.json:
$(cat "$tour_dir/notes.json")"
codex exec --skip-git-repo-check -s read-only "${images[@]}" -o "$tour_dir/rating.json" "$prompt" > "$tour_dir/rater.log" 2>&1
cat "$tour_dir/rating.json"
