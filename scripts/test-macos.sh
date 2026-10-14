#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

started_at="$SECONDS"
current_step="initialization"

failed() {
  status="$?"
  printf '\nWTS macOS gate: FAILED during %s (%ss)\n' \
    "$current_step" "$((SECONDS - started_at))" >&2
  exit "$status"
}
trap failed ERR

run_step() {
  current_step="$1"
  shift
  step_started="$SECONDS"
  printf '\n==> %s\n' "$current_step"
  "$@"
  printf '<== %s passed (%ss)\n' "$current_step" "$((SECONDS - step_started))"
}

run_step "Production UI build" npm --prefix ui run build
run_step \
  "Desktop setup, installation, and update contracts" \
  node --test scripts/prepare-desktop-dev.test.mjs \
    scripts/install-macos-app.test.mjs scripts/stage-macos-update.test.mjs
run_step \
  "Native application and desktop contracts" \
  cargo test --locked -p wts-app -p wts-desktop
run_step "Native desktop build" cargo build --locked -p wts-desktop

trap - ERR
printf '\nWTS macOS gate: PASSED (%ss)\n' "$((SECONDS - started_at))"
