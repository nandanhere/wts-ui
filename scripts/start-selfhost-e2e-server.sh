#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/wts-selfhost-e2e.XXXXXX")"
repository_root="$runtime_root/repositories"
workspace_root="$runtime_root/workspaces"
data_root="$runtime_root/data"
source_snapshot="$repository_root/wts-ui"
address="${WTS_SELFHOST_E2E_ADDR:-127.0.0.1:43211}"
server_pid=""

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [[ "${WTS_SELFHOST_E2E_DEFER_CLEANUP:-0}" != "1" ]]; then
    case "$runtime_root" in
      "${TMPDIR:-/tmp}"/wts-selfhost-e2e.*) rm -rf "$runtime_root" ;;
    esac
  fi
}
trap cleanup EXIT INT TERM

if [[ -n "${WTS_SELFHOST_E2E_RUNTIME_MARKER:-}" ]]; then
  printf '%s\n' "$runtime_root" > "$WTS_SELFHOST_E2E_RUNTIME_MARKER"
fi

mkdir -p "$source_snapshot" "$workspace_root" "$data_root"
rsync -a \
  --exclude .git \
  --exclude .wts \
  --exclude target \
  --exclude node_modules \
  --exclude dist \
  --exclude graphify-out \
  --exclude playwright-report \
  --exclude test-results \
  "$project_root/" "$source_snapshot/"

git -C "$source_snapshot" init --quiet --initial-branch=main
git -C "$source_snapshot" config user.name "WTS Self-Host Test"
git -C "$source_snapshot" config user.email "wts-selfhost@localhost"
git -C "$source_snapshot" config commit.gpgSign false
git -C "$source_snapshot" add .
git -C "$source_snapshot" commit --quiet -m "Snapshot WTS for self-hosting acceptance"

export WTS_REPOSITORY_ROOT="$repository_root"
export WTS_WORKSPACE_ROOT="$workspace_root"
export WTS_DATA_DIR="$data_root"
export WTS_ADDR="$address"
export WTS_UI_DIR="$project_root/ui/dist"
export WTS_BROWSER_DRIVER="$project_root/scripts/wts-browser-driver.mjs"

cd "$project_root"
cargo run --quiet -p wts-server &
server_pid="$!"
wait "$server_pid"
