#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'WTS desktop development setup: %s\n' "$*" >&2
  exit 1
}

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
target_dir="${CARGO_TARGET_DIR:-$project_root/target}"
bin_dir="${WTS_DEV_BIN_DIR:-${XDG_BIN_HOME:-${HOME:?HOME is required}/.local/bin}}"

case "$target_dir" in
  /*) ;;
  *) target_dir="$project_root/$target_dir" ;;
esac
case "$bin_dir" in
  /*) ;;
  *) fail "WTS_DEV_BIN_DIR must be an absolute path." ;;
esac

printf 'Building the WTS agent-report helper...\n'
(
  cd "$project_root"
  CARGO_TARGET_DIR="$target_dir" cargo build --locked -p wts-app --bin wts-report
)

source_binary="$target_dir/debug/wts-report"
[ -x "$source_binary" ] ||
  fail "Cargo completed without producing $source_binary."

target_triple="$(
  rustc -vV |
    awk '/^host: / { print $2 }'
)"
[ -n "$target_triple" ] ||
  fail "could not determine the Rust host target."
sidecar_directory="$project_root/src-tauri/binaries"
mkdir -p "$sidecar_directory"
cp "$source_binary" "$sidecar_directory/wts-report-$target_triple"
chmod 755 "$sidecar_directory/wts-report-$target_triple"

mkdir -p "$bin_dir"
temporary_binary="$bin_dir/.wts-report.$$"
trap 'rm -f "$temporary_binary"' EXIT
cp "$source_binary" "$temporary_binary"
chmod 755 "$temporary_binary"
mv -f "$temporary_binary" "$bin_dir/wts-report"
trap - EXIT

"$bin_dir/wts-report" --help >/dev/null
printf 'Installed the WTS agent-report helper at %s\n' "$bin_dir/wts-report"
printf 'Prepared the trusted desktop sidecar at %s\n' \
  "$sidecar_directory/wts-report-$target_triple"
