#!/usr/bin/env bash
set -Eeuo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

started_at="$SECONDS"
current_step="initialization"

failed() {
  status="$?"
  printf '\nWTS fast gate: FAILED during %s (%ss)\n' \
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

run_step "Rust formatting" cargo fmt --all -- --check
run_step "Documentation style contract" node --test scripts/lint-docs.test.mjs
run_step "Documentation style" node scripts/lint-docs.mjs
run_step "Interface writing style" node scripts/lint-ui-copy.mjs
run_step \
  "Public-source audit contract" \
  node --test scripts/check-open-source-readiness.test.mjs
run_step "Public-source audit" node scripts/check-open-source-readiness.mjs
run_step \
  "Rust core, store, and Git contracts" \
  cargo test -p wts-core -p wts-store -p wts-git
run_step \
  "Agent report CLI process boundary" \
  cargo test -p wts-app --test wts_report_cli
run_step \
  "Agent report loading and proposal promotion" \
  cargo test -p wts-app --test mvp_flow \
    materializes_once_and_opens_only_the_generated_vscode_workspace
run_step \
  "Persisted verification runner contract" \
  cargo test -p wts-app --test mvp_flow \
    discovers_and_runs_a_persisted_workspace_verification_plan
run_step \
  "Verification HTTP endpoint contract" \
  cargo test -p wts-server \
    graph_agent_and_jira_adapter_routes_return_real_wire_contracts
run_step \
  "Browser driver contract" \
  node --test scripts/wts-browser-driver.test.mjs
run_step \
  "Service fixture contract" \
  node examples/service-stacks/verify-fixtures.mjs
run_step \
  "Parallel-agent manifest validation" \
  cargo run -p wts-app --example parallel_agent_lab -- --validate-only
run_step "React behavior suite" npm --prefix ui test
run_step "Production UI build" npm --prefix ui run build
run_step \
  "CI and self-host harness contract" \
  node --test scripts/continuous-selftest.test.mjs

trap - ERR
printf '\nWTS fast gate: PASSED (%ss)\n' "$((SECONDS - started_at))"
