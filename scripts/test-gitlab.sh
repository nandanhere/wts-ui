#!/usr/bin/env bash
set -Eeuo pipefail

project_root="${CI_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$project_root"
mode="${1:-}"

fail() {
  printf 'WTS GitLab setup: %s\n' "$1" >&2
  exit 1
}

case "$mode:$(uname -s):$(uname -m)" in
  linux:Linux:x86_64) node_platform="linux-x64"; rust_host="x86_64-unknown-linux-gnu" ;;
  macos:Darwin:arm64) node_platform="darwin-arm64"; rust_host="aarch64-apple-darwin" ;;
  *) fail "The runner must use Linux x64 or macOS ARM64 with the matching gate." ;;
esac

mkdir -p "$project_root/artifacts/ci"
exec > >(tee "$project_root/artifacts/ci/$mode.log") 2>&1

if [[ "$mode" == "linux" ]]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    ca-certificates curl git build-essential pkg-config file xz-utils \
    libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev
fi

node_version="22.13.1"
rust_version="1.95.0"
tools_root="$project_root/.tools/gitlab-ci"
node_root="$tools_root/node-v$node_version-$node_platform"
node_staging=""
rust_staging=""
mkdir -p "$tools_root"

cleanup() {
  if [[ -n "$node_staging" && -d "$node_staging" ]]; then
    rm -rf "$node_staging"
  fi
  if [[ -n "$rust_staging" && -d "$rust_staging" ]]; then
    rm -rf "$rust_staging"
  fi
}
trap cleanup EXIT

if [[ ! -x "$node_root/bin/node" ]]; then
  node_staging="$(mktemp -d "$tools_root/node-install.XXXXXX")"
  node_archive="node-v$node_version-$node_platform.tar.gz"
  node_url="https://nodejs.org/dist/v$node_version"
  printf 'Download %s.\n' "$node_url/$node_archive"
  curl --fail --location --silent --show-error --retry 3 \
    --output "$node_staging/$node_archive" "$node_url/$node_archive"
  printf 'Download %s.\n' "$node_url/SHASUMS256.txt"
  curl --fail --location --silent --show-error --retry 3 \
    --output "$node_staging/SHASUMS256.txt" "$node_url/SHASUMS256.txt"
  expected_checksum="$(awk -v archive="$node_archive" '$2 == archive { print $1 }' "$node_staging/SHASUMS256.txt")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_checksum="$(sha256sum "$node_staging/$node_archive" | awk '{ print $1 }')"
  else
    actual_checksum="$(shasum -a 256 "$node_staging/$node_archive" | awk '{ print $1 }')"
  fi
  [[ -n "$expected_checksum" && "$actual_checksum" == "$expected_checksum" ]] ||
    fail "The Node archive checksum does not match."
  mkdir -p "$node_staging/runtime"
  tar -xzf "$node_staging/$node_archive" -C "$node_staging/runtime" --strip-components=1
  rm -rf "$node_root"
  mv "$node_staging/runtime" "$node_root"
  rm -rf "$node_staging"
  node_staging=""
fi

export CARGO_HOME="$tools_root/cargo"
export RUSTUP_HOME="$tools_root/rustup"
export RUSTUP_TOOLCHAIN="$rust_version"
export CARGO_TARGET_DIR="$project_root/target"
export npm_config_cache="$tools_root/npm-cache"
export PATH="$node_root/bin:$CARGO_HOME/bin:$PATH"

if [[ ! -x "$CARGO_HOME/bin/rustup" ]]; then
  rust_staging="$(mktemp -d "$tools_root/rust-install.XXXXXX")"
  rust_url="https://static.rust-lang.org/rustup/dist/$rust_host/rustup-init"
  printf 'Download %s.\n' "$rust_url"
  curl --fail --location --silent --show-error --retry 3 \
    --output "$rust_staging/rustup-init" "$rust_url"
  printf 'Download %s.\n' "$rust_url.sha256"
  curl --fail --location --silent --show-error --retry 3 \
    --output "$rust_staging/rustup-init.sha256" "$rust_url.sha256"
  expected_checksum="$(awk 'NR == 1 { print $1 }' "$rust_staging/rustup-init.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_checksum="$(sha256sum "$rust_staging/rustup-init" | awk '{ print $1 }')"
  else
    actual_checksum="$(shasum -a 256 "$rust_staging/rustup-init" | awk '{ print $1 }')"
  fi
  [[ -n "$expected_checksum" && "$actual_checksum" == "$expected_checksum" ]] ||
    fail "The Rust installer checksum does not match."
  chmod +x "$rust_staging/rustup-init"
  RUSTUP_INIT_SKIP_PATH_CHECK=yes "$rust_staging/rustup-init" \
    -y --no-modify-path --default-toolchain none --profile minimal
  rm -rf "$rust_staging"
  rust_staging=""
fi
rustup toolchain install "$rust_version" --profile minimal \
  --component clippy --component rustfmt

[[ "$(node --version)" == "v$node_version" ]] || fail "Node does not match the pinned version."
case "$(rustc --version)" in
  "rustc $rust_version "*) ;;
  *) fail "Rust does not match the pinned version." ;;
esac

npm ci --prefix ui
if [[ "$mode" == "linux" ]]; then
  npm --prefix ui exec -- playwright install --with-deps chromium
  bash scripts/test-pr.sh
else
  bash scripts/test-macos.sh
fi
