#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

started_at="$SECONDS"
current_step="initialization"

failed() {
  status="$?"
  printf '\nWTS pull-request gate: FAILED during %s (%ss)\n' \
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

run_step "Fast deterministic gate" bash scripts/test-fast.sh
run_step "Complete Rust workspace" cargo test --workspace
run_step \
  "Rust lint" \
  cargo clippy --workspace --all-targets --all-features -- -D warnings
run_step \
  "Full-stack fixture validation" \
  cargo run -p wts-app --example fullstack_lab -- --validate-only
run_step "Full-stack fixture" cargo run -p wts-app --example fullstack_lab
run_step \
  "Two-workspace runtime isolation" \
  cargo run -p wts-app --example simultaneous_workspace_lab -- --copies 2
run_step "Parallel-agent lab" cargo run -p wts-app --example parallel_agent_lab
run_step \
  "Critical, responsive, and board browser flows" \
  npm --prefix ui exec -- playwright test critical-path.spec.ts \
    responsive-polish.spec.ts workspace-board-dnd.spec.ts \
    --config ui/playwright.config.ts
run_step \
  "Directed feedback, results, alternatives, and recovery browser flows" \
  npm --prefix ui exec -- playwright test \
    --config ui/playwright.feedback.config.ts
run_step \
  "Workspace attention and recovery browser flows" \
  npm --prefix ui exec -- playwright test \
    --config ui/playwright.attention.config.ts
run_step \
  "Workspace request budgets and cached navigation" \
  npm --prefix ui exec -- playwright test \
    --config ui/playwright.performance.config.ts
run_step \
  "Rendered candidate preview and live module updates" \
  cargo test --locked -p wts-app --lib \
    installed_vite_serves_candidate_files_and_hot_updates \
    -- --ignored --nocapture

trap - ERR
printf '\nWTS pull-request gate: PASSED (%ss)\n' "$((SECONDS - started_at))"
