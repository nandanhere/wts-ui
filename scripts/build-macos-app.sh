#!/usr/bin/env bash

set -euo pipefail

readonly PINNED_TAURI_CLI_VERSION="2.11.4"
readonly MACOS_TARGET="aarch64-apple-darwin"
readonly DEFAULT_MIN_FREE_MIB="6144"

fail() {
  printf 'WTS macOS QA build: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' was not found."
}

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"

[ "$(uname -s)" = "Darwin" ] ||
  fail "this helper only builds macOS application bundles."

for command_name in awk basename cargo chmod clang codesign cp date df grep lipo mkdir mv node npm plutil rm rustc shasum tr uname xcode-select xcrun; do
  require_command "$command_name"
done

skip_dmg="${WTS_SKIP_DMG:-0}"
case "$skip_dmg" in
  0) require_command hdiutil; bundle_kinds="app,dmg" ;;
  1) bundle_kinds="app" ;;
  *) fail "WTS_SKIP_DMG must be 0 or 1." ;;
esac

[ "$(uname -m)" = "arm64" ] ||
  fail "this QA helper currently supports only an Apple Silicon build host."

developer_dir="$(xcode-select -p 2>/dev/null)" ||
  fail "Xcode Command Line Tools are not configured."
[ -d "$developer_dir" ] ||
  fail "the selected Xcode developer directory does not exist: $developer_dir"
xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 ||
  fail "the selected Xcode installation does not provide a macOS SDK."

for required_path in \
  "$project_root/Cargo.lock" \
  "$project_root/Cargo.toml" \
  "$project_root/src-tauri/tauri.conf.json" \
  "$project_root/scripts/stage-macos-update.mjs" \
  "$project_root/ui/package-lock.json" \
  "$project_root/ui/package.json"; do
  [ -f "$required_path" ] || fail "required project file is missing: $required_path"
done

[ -x "$project_root/ui/node_modules/.bin/tsc" ] &&
  [ -x "$project_root/ui/node_modules/.bin/vite" ] ||
  fail "UI dependencies are unavailable; run 'npm ci --prefix ui' first."

minimum_free_mib="${WTS_MACOS_MIN_FREE_MIB:-$DEFAULT_MIN_FREE_MIB}"
case "$minimum_free_mib" in
  ''|*[!0-9]*) fail "WTS_MACOS_MIN_FREE_MIB must be a positive integer." ;;
esac
[ "$minimum_free_mib" -gt 0 ] ||
  fail "WTS_MACOS_MIN_FREE_MIB must be greater than zero."

check_free_space() {
  available_kib="$(df -Pk "$project_root" | awk 'NR == 2 { print $4 }')"
  case "$available_kib" in
    ''|*[!0-9]*) fail "could not determine free disk space for $project_root." ;;
  esac

  required_kib=$((minimum_free_mib * 1024))
  if [ "$available_kib" -lt "$required_kib" ]; then
    available_mib=$((available_kib / 1024))
    fail "only ${available_mib} MiB is free; at least ${minimum_free_mib} MiB is required."
  fi
}

target_libdir="$(rustc --print target-libdir --target "$MACOS_TARGET" 2>/dev/null)" ||
  fail "Rust could not resolve the $MACOS_TARGET target."
[ -d "$target_libdir" ] ||
  fail "Rust target $MACOS_TARGET is not installed for the active toolchain."

expected_cli_version="${WTS_TAURI_CLI_VERSION:-$PINNED_TAURI_CLI_VERSION}"
printf '%s\n' "$expected_cli_version" |
  grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' ||
  fail "WTS_TAURI_CLI_VERSION must be a semantic version such as 2.11.4."

tauri_command=()
if [ -n "${WTS_TAURI_BIN:-}" ]; then
  case "$WTS_TAURI_BIN" in
    /*) ;;
    *) fail "WTS_TAURI_BIN must be an absolute path." ;;
  esac
  [ -x "$WTS_TAURI_BIN" ] ||
    fail "WTS_TAURI_BIN is not an executable file: $WTS_TAURI_BIN"
  tauri_command=("$WTS_TAURI_BIN")
elif [ -x "$project_root/node_modules/.bin/tauri" ]; then
  tauri_command=("$project_root/node_modules/.bin/tauri")
elif [ -x "$project_root/ui/node_modules/.bin/tauri" ]; then
  tauri_command=("$project_root/ui/node_modules/.bin/tauri")
elif tauri_version_output="$(cargo tauri --version 2>/dev/null)"; then
  tauri_command=(cargo tauri)
else
  fail "Tauri CLI is missing; install pinned tauri-cli $expected_cli_version or set WTS_TAURI_BIN."
fi

if [ -z "${tauri_version_output:-}" ]; then
  tauri_version_output="$("${tauri_command[@]}" --version 2>/dev/null)" ||
    fail "the selected Tauri CLI could not report its version."
fi
tauri_version="$(
  printf '%s\n' "$tauri_version_output" |
    grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' |
    awk 'NR == 1 { print; exit }'
)" || true
[ -n "$tauri_version" ] ||
  fail "could not parse the selected Tauri CLI version."
[ "$tauri_version" = "$expected_cli_version" ] ||
  fail "Tauri CLI $tauri_version is installed; this build requires $expected_cli_version."

bundle_identifier="$(
  node -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (typeof config.identifier !== "string") process.exit(2);
    process.stdout.write(config.identifier);
  ' "$project_root/src-tauri/tauri.conf.json"
)" || fail "could not read the Tauri bundle identifier."
[ -n "$bundle_identifier" ] ||
  fail "the Tauri bundle identifier is empty."

case "${WTS_QA_UPDATE_DIR:-}" in
  '') qa_update_directory="$HOME/Library/Application Support/$bundle_identifier/updates" ;;
  /*) qa_update_directory="$WTS_QA_UPDATE_DIR" ;;
  *) fail "WTS_QA_UPDATE_DIR must be an absolute path." ;;
esac
qa_update_root="$(dirname "$qa_update_directory")"
qa_private_key="$qa_update_root/updater-signing.key"
qa_public_key="$qa_private_key.pub"
mkdir -p "$qa_update_root" "$qa_update_directory"
[ -d "$qa_update_root" ] && [ ! -L "$qa_update_root" ] ||
  fail "the local updater root must be a regular directory."
[ -d "$qa_update_directory" ] && [ ! -L "$qa_update_directory" ] ||
  fail "the local updater directory must be a regular directory."
chmod 700 "$qa_update_root" "$qa_update_directory"
if [ ! -f "$qa_private_key" ] || [ ! -f "$qa_public_key" ]; then
  [ ! -e "$qa_private_key" ] && [ ! -e "$qa_public_key" ] ||
    fail "the local updater signing key pair is incomplete."
  "${tauri_command[@]}" signer generate --ci --write-keys "$qa_private_key"
fi
[ -f "$qa_private_key" ] && [ ! -L "$qa_private_key" ] ||
  fail "the local updater private key is invalid."
[ -f "$qa_public_key" ] && [ ! -L "$qa_public_key" ] ||
  fail "the local updater public key is invalid."
chmod 600 "$qa_private_key" "$qa_public_key"
update_public_key="$(tr -d '\r\n' <"$qa_public_key")"
case "$update_public_key" in
  ''|*[!0-9A-Za-z+/=]*) fail "the local updater public key is invalid." ;;
esac

build_sequence_file="$qa_update_root/build-sequence"
app_version="$(
  node "$project_root/scripts/stage-macos-update.mjs" \
    next-version "$build_sequence_file" "$(date +%s)"
)" || fail "could not create the local update build number."
build_override="$(
  node -e '
    const version = process.argv[1];
    const pubkey = process.argv[2];
    process.stdout.write(JSON.stringify({
      version,
      build: { beforeBuildCommand: null },
      bundle: {
        createUpdaterArtifacts: true,
        externalBin: ["binaries/wts-report"],
        macOS: { signingIdentity: "-" },
      },
      plugins: {
        updater: {
          pubkey,
          endpoints: [],
          dangerousInsecureTransportProtocol: true,
        },
      },
    }));
  ' "$app_version" "$update_public_key"
)" || fail "could not create the local updater build configuration."

check_free_space

printf 'Building the WTS UI...\n'
npm --prefix "$project_root/ui" run build

check_free_space

printf 'Building the trusted wts-report helper...\n'
CARGO_INCREMENTAL=0 \
  CARGO_TARGET_DIR="$project_root/target" \
  cargo build \
  --manifest-path "$project_root/Cargo.toml" \
  --locked \
  --release \
  -p wts-app \
  --bin wts-report

readonly report_helper="$project_root/target/release/wts-report"
[ -x "$report_helper" ] ||
  fail "Cargo completed without producing the trusted wts-report helper."
readonly report_sidecar_directory="$project_root/src-tauri/binaries"
readonly report_sidecar="$report_sidecar_directory/wts-report-$MACOS_TARGET"
mkdir -p "$report_sidecar_directory"
cp "$report_helper" "$report_sidecar"
chmod 755 "$report_sidecar"

check_free_space

printf 'Building ad-hoc signed WTS arm64 QA bundles with Tauri CLI %s...\n' "$tauri_version"
(
  cd "$project_root"
  unset APPLE_API_ISSUER APPLE_API_KEY APPLE_API_KEY_PATH
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
  APPLE_SIGNING_IDENTITY="-" \
  TAURI_SIGNING_PRIVATE_KEY="$qa_private_key" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
  WTS_UPDATE_PUBLIC_KEY="$update_public_key" \
  CARGO_INCREMENTAL=0 \
    CARGO_TARGET_DIR="$project_root/target" \
    "${tauri_command[@]}" build \
    --bundles "$bundle_kinds" \
    --config "$build_override" \
    -- \
    --locked
)

readonly source_app="$project_root/target/release/bundle/macos/WTS.app"
readonly source_dmg="$project_root/target/release/bundle/dmg/WTS_${app_version}_aarch64.dmg"
readonly source_checksum="${source_dmg}.sha256"
readonly source_updater="$project_root/target/release/bundle/macos/WTS.app.tar.gz"
readonly source_updater_signature="${source_updater}.sig"
[ -d "$source_app" ] ||
  fail "Tauri completed without producing the expected application: $source_app"
[ -x "$source_app/Contents/MacOS/wts-desktop" ] ||
  fail "the application bundle does not contain the expected WTS executable."
if [ "$skip_dmg" = "0" ]; then
  [ -f "$source_dmg" ] ||
    fail "Tauri completed without producing the expected disk image: $source_dmg"
fi
[ -f "$source_updater" ] && [ -f "$source_updater_signature" ] ||
  fail "Tauri completed without producing a signed updater artifact."

[ -x "$source_app/Contents/MacOS/wts-report" ] ||
  fail "the application bundle does not contain an executable wts-report helper."

actual_identifier="$(
  plutil -extract CFBundleIdentifier raw -o - "$source_app/Contents/Info.plist" 2>/dev/null
)" || fail "could not read the application bundle identifier."
[ "$actual_identifier" = "$bundle_identifier" ] ||
  fail "application identifier '$actual_identifier' does not match '$bundle_identifier'."

actual_architectures="$(
  lipo -archs "$source_app/Contents/MacOS/wts-desktop" 2>/dev/null
)" || fail "could not inspect the application executable architecture."
[ "$actual_architectures" = "arm64" ] ||
  fail "expected an arm64-only executable, found: $actual_architectures"
report_architectures="$(
  lipo -archs "$source_app/Contents/MacOS/wts-report" 2>/dev/null
)" || fail "could not inspect the wts-report executable architecture."
[ "$report_architectures" = "arm64" ] ||
  fail "expected an arm64-only wts-report helper, found: $report_architectures"

codesign --verify --deep --strict --verbose=2 "$source_app" ||
  fail "the application code signature did not verify."
app_signature="$(
  codesign --display --verbose=4 "$source_app" 2>&1
)" || fail "could not inspect the application code signature."
printf '%s\n' "$app_signature" | grep -q '^Signature=adhoc$' ||
  fail "the application was not signed with the expected ad-hoc identity."

if [ "$skip_dmg" = "0" ]; then
  hdiutil verify "$source_dmg" >/dev/null ||
    fail "the generated disk image failed hdiutil verification."
  codesign --force --sign - "$source_dmg" ||
    fail "the generated disk image could not be ad-hoc signed."
  codesign --verify --strict --verbose=2 "$source_dmg" ||
    fail "the disk-image code signature did not verify."
  dmg_signature="$(
    codesign --display --verbose=4 "$source_dmg" 2>&1
  )" || fail "could not inspect the disk-image code signature."
  printf '%s\n' "$dmg_signature" | grep -q '^Signature=adhoc$' ||
    fail "the disk image was not signed with the expected ad-hoc identity."

  (
    cd "$(dirname "$source_dmg")"
    shasum -a 256 "$(basename "$source_dmg")" >"$(basename "$source_checksum")"
    shasum -a 256 -c "$(basename "$source_checksum")" >/dev/null
  )
fi

published_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
stage_output="$(
  node "$project_root/scripts/stage-macos-update.mjs" stage \
    "$source_updater" \
    "$source_updater_signature" \
    "$qa_update_directory" \
    "$app_version" \
    "$published_at"
)" || fail "could not stage the signed local update."
staged_path="$(printf '%s\n' "$stage_output" | awk 'NR == 1 { print; exit }')"
staged_manifest="$(printf '%s\n' "$stage_output" | awk 'NR == 2 { print; exit }')"
[ -f "$staged_path" ] && [ -f "$staged_manifest" ] ||
  fail "the local update publisher did not return staged files."

printf '\nAd-hoc signed local QA artifacts verified in place:\n'
printf '  %s\n' "$source_app"
if [ "$skip_dmg" = "0" ]; then
  printf '  %s\n' "$source_dmg"
  printf '  %s\n' "$source_checksum"
fi
printf '  %s\n' "$staged_path"
printf '  %s\n' "$staged_manifest"
printf '\nThese artifacts are not Developer ID signed or notarized and are not suitable for public distribution.\n'
