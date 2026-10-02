#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace_count="${1:-30}"
output="${2:-$project_root/target/wts-profile-${workspace_count}.json}"

cd "$project_root"
cargo run --release -p wts-app --example many_workspace_profile -- \
  --workspaces "$workspace_count" \
  --output "$output"
