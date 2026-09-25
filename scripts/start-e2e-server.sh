#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="$(mktemp -d "${TMPDIR:-/tmp}/wts-browser-e2e.XXXXXX")"
repository_root="$runtime_root/repositories"
workspace_root="$runtime_root/workspaces"
data_root="$runtime_root/data"
address="${WTS_E2E_ADDR:-127.0.0.1:43210}"

cleanup() {
  case "$runtime_root" in
    "${TMPDIR:-/tmp}"/wts-browser-e2e.*) rm -rf "$runtime_root" ;;
  esac
}
trap cleanup EXIT INT TERM

mkdir -p "$repository_root" "$workspace_root" "$data_root"
cp -R "$project_root/examples/fullstack-lab/templates/storefront-ui" \
  "$repository_root/storefront-ui"
cp -R "$project_root/examples/fullstack-lab/templates/checkout-api" \
  "$repository_root/checkout-api"

for repository in "$repository_root/storefront-ui" "$repository_root/checkout-api"; do
  git -C "$repository" init --quiet
  git -C "$repository" config user.name "WTS Browser Test"
  git -C "$repository" config user.email "wts-browser-test@localhost"
  git -C "$repository" config commit.gpgSign false
  git -C "$repository" add .
  git -C "$repository" commit --quiet -m "Create browser test fixture"
  git -C "$repository" branch -M main
done

export WTS_REPOSITORY_ROOT="$repository_root"
export WTS_WORKSPACE_ROOT="$workspace_root"
export WTS_DATA_DIR="$data_root"
export WTS_ADDR="$address"
export WTS_UI_DIR="$project_root/ui/dist"
export WTS_BROWSER_DRIVER="$project_root/scripts/wts-browser-driver.mjs"
# The AI code review uses a fixture Raptik skill and a fake Codex CLI.
export WTS_RAPTIK_SKILL_DIR="$project_root/ui/e2e/fixtures/raptik-review"
export WTS_CODEX_EXECUTABLE="$project_root/ui/e2e/fixtures/bin/fake-codex-review"
export WTS_E2E_AGENT_RECORD_DIR="$runtime_root"
export CODEX_HOME="$runtime_root/codex-home"
mkdir -p "$CODEX_HOME"
printf 'model = "gpt-e2e-review"\n' > "$CODEX_HOME/config.toml"
printf '%s\n' '{"models":[{"slug":"gpt-e2e-review","visibility":"list"},{"slug":"gpt-e2e-mini","visibility":"list"}]}' > "$CODEX_HOME/models_cache.json"

cd "$project_root"
cargo run --quiet -p wts-server
