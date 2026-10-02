#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_marker="$(mktemp "${TMPDIR:-/tmp}/wts-selfhost-marker.XXXXXX")"
test_status=0
cleanup_status=0
evidence_collected=0
evidence_root="${WTS_SELFHOST_E2E_EVIDENCE_DIR:-$project_root/ui/test-results/selfhost-evidence}"

runtime_root_from_marker() {
  sed -n '1p' "$runtime_marker" 2>/dev/null || true
}

collect_failure_evidence() {
  local runtime_root="$1"
  local run_leaf
  if [[ "$evidence_collected" -eq 1 || ! -d "$runtime_root" ]]; then
    return
  fi
  run_leaf="run-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  if node "$project_root/scripts/collect-selfhost-evidence.mjs" \
    "$runtime_root" "$evidence_root/$run_leaf"; then
    printf 'Sanitized self-host evidence: %s\n' "$evidence_root/$run_leaf" >&2
  else
    printf 'Could not prepare sanitized self-host evidence.\n' >&2
  fi
  evidence_collected=1
}

remove_runtime() {
  local runtime_root="$1"
  if [[ -z "$runtime_root" || ! -e "$runtime_root" ]]; then
    return
  fi
  case "$runtime_root" in
    "${TMPDIR:-/tmp}"/wts-selfhost-e2e.*)
      rm -rf "$runtime_root"
      if [[ -e "$runtime_root" ]]; then
        cleanup_status=1
      fi
      ;;
    *)
      printf 'Refusing to clean unexpected self-host runtime: %s\n' \
        "$runtime_root" >&2
      cleanup_status=1
      ;;
  esac
}

cleanup() {
  local status="$?"
  local runtime_root
  runtime_root="$(runtime_root_from_marker)"
  if [[ "$status" -ne 0 || "$test_status" -ne 0 ]]; then
    collect_failure_evidence "$runtime_root"
  fi
  remove_runtime "$runtime_root"
  rm -f "$runtime_marker"
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status="$cleanup_status"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'test_status=130; exit 130' INT
trap 'test_status=143; exit 143' TERM

export WTS_SELFHOST_E2E_RUNTIME_MARKER="$runtime_marker"
export WTS_SELFHOST_E2E_DEFER_CLEANUP=1
cd "$project_root/ui"
npx playwright test --config playwright.selfhost.config.ts || test_status="$?"

runtime_root="$(runtime_root_from_marker)"
if [[ -n "$runtime_root" ]]; then
  for _ in {1..50}; do
    if [[ -e "$runtime_root" ]]; then
      break
    fi
    sleep 0.1
  done
  if [[ "$test_status" -ne 0 ]]; then
    collect_failure_evidence "$runtime_root"
  fi
  remove_runtime "$runtime_root"
fi

if [[ "$test_status" -ne 0 ]]; then
  exit "$test_status"
fi
exit "$cleanup_status"
