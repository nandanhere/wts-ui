#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_root="${1:-$project_root/target/profiles/macos-arm64}"

# Run sequentially. Parallel profiles multiply Git worktrees and compiler
# memory, which can exhaust a developer laptop even when each run is small.
mkdir -p "$output_root"
export WTS_PROFILE_SKIP_GRAPH=1
for count in 1 10 20 30; do
  echo "==> profiling ${count} workspaces"
  bash "$project_root/scripts/profile-many-workspaces.sh" "$count" \
    "$output_root/${count}-workspaces.json"
done

echo "Profiles written to $output_root"
