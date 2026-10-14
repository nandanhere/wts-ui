# Releasing WTS

Releases are built by GitHub Actions for the supported Apple Silicon macOS
target. A release does not require a local Tauri build.

To publish a version, create and push a semantic-version tag from `main`:

```sh
git tag v0.6.1
git push origin v0.6.1
```

The `Release WTS` workflow builds the arm64 `.app` and `.dmg` bundles on
`macos-15`, stamps the Tauri bundle with the tag version, verifies that
artifacts exist, and creates the GitHub Release with generated notes.

The same workflow can be started manually from GitHub Actions by supplying an
existing tag such as `v0.6.1`. The selected tag is checked out and published
without requiring a local rebuild.

Release signing and notarization are intentionally not claimed by this
workflow until the repository has configured the corresponding GitHub Actions
secrets and Apple credentials.
