# macOS application updates PRD

## Overview

WTS detects a newer local QA build, installs its signed updater artifact, and
lets the user relaunch the app. The user does not need to rebuild and replace
`/Applications/WTS.app` for each QA version.

The first release uses one fixed per-user local feed. It does not claim public
distribution trust. A later public release can add Developer ID signing,
notarization, and an HTTPS feed without changing the UI contract.

## Current state

WTS currently has:

- an Apple Silicon Tauri `.app` and `.dmg` QA build
- an ad-hoc Apple code signature for local QA
- a SHA-256 sidecar for the QA DMG
- an atomic installer for `/Applications/WTS.app`
- a static Tauri application version of `0.1.0`
- `createUpdaterArtifacts` set to `false`

The first release must create a Tauri updater artifact, sign it with the local
QA updater key, and give each build a greater semantic version.

## Product decisions

1. Add a global **App updates** page at `/updates`.
2. Check after WTS starts, when its window gains focus, every five minutes,
   and when the user selects **Check for updates**.
3. Use a fixed per-user local QA feed.
4. Require the Tauri updater signature for every artifact.
5. Keep the current app unchanged after a check or download error.
6. Let the updater plugin install the verified artifact.
7. Install verified updates automatically and let the user choose when WTS
   restarts.
8. Keep update URLs, file paths, signatures, and hashes outside the UI contract.
9. Replace the static `0.1.0` version with a monotonic QA version.
10. Do not add billing.

## User needs

1. Know whether a newer local WTS build is available.
2. Install the build without replacing the app manually.
3. See download progress.
4. Know when the update is ready for relaunch.
5. Keep the current WTS app after a failed check or installation.
6. Trust that only an artifact signed by the configured QA key can install.

## User stories

- As a developer, I want WTS to detect the newest local QA build.
- As a developer, I want WTS to install a verified build without another
  action.
- As a developer, I want to see exact download progress.
- As a developer, I want to choose when WTS relaunches.
- As a developer, I want a useful error and retry action after failure.
- As a security reviewer, I want mandatory updater-signature verification.

## Screens and flow

The first release uses a global **App updates** page. The top bar and command
palette open `/updates`. It does not add another settings row, restart queue, or
recovery screen.

```text
WTS starts and checks for a newer local QA build
        |
        v
The Updates badge appears when an update is available or ready
        |
        v
User opens Updates from the top bar or command palette
        |
        +---- Not configured ----> Updates are not configured
        |
        v
User selects Check for updates
        |
        +---- No newer build ----> WTS is up to date
        |
        +---- Invalid manifest --> Show error and Check again
        |
        v
Download and install WTS <version> automatically
        |
        +---- Download fails ----> Keep current app and show Try again
        |
        +---- Signature fails ---> Reject artifact and show Check again
        |
        +---- Install fails -----> Keep current app and show Try again
        |
        v
Show update installed and ready
        |
        v
User selects Relaunch WTS
        |
        v
The updater plugin relaunches the installed application
```

## App updates page states

### Disabled

```text
┌────────────────────────────────────────────────────────────────────┐
│ WTS                                             [Check for updates]│
│ App updates                                                        │
│ Keep this WTS installation current.                               │
├────────────────────────────────────────────────────────────────────┤
│ Installed version 0.1.1723622400                                  │
│ Updates are not available                                         │
│ This WTS build does not contain an update verification key.       │
└────────────────────────────────────────────────────────────────────┘
```

Use this state when the build has no embedded update verification key.

### Up to date

```text
┌────────────────────────────────────────────────────────────────────┐
│ WTS                                             [Check for updates]│
│ App updates                                                        │
├────────────────────────────────────────────────────────────────────┤
│ Installed version 0.1.1723622400                                  │
│ WTS is up to date                                                  │
└────────────────────────────────────────────────────────────────────┘
```

### Available

```text
┌────────────────────────────────────────────────────────────────────┐
│ WTS                                             [Check for updates]│
│ App updates                                                        │
├────────────────────────────────────────────────────────────────────┤
│ Installed version 0.1.1723622400                                  │
│ WTS 0.1.1723622500 is available                                   │
│ Local QA build · Published Aug 20, 2026                           │
│ Update the GitLab MR delivery flow.                               │
│                                                       [Update WTS]│
└────────────────────────────────────────────────────────────────────┘
```

Bound the release note to a short plain-text value. Do not render release HTML
or a feed-supplied link.

### Downloading

```text
┌────────────────────────────────────────────────────────────────────┐
│ WTS                                             [Check for updates]│
│ App updates                                                        │
├────────────────────────────────────────────────────────────────────┤
│ Installed version 0.1.1723622400                                  │
│ WTS downloads 0.1.1723622500                                      │
│ ███████████████████░░░░░░░░░░░░░░░░░░░  46%                     │
│ 22.2 MB of 48.2 MB                                               │
└────────────────────────────────────────────────────────────────────┘
```

The first release does not add pause, resume, or cancel controls.

### Ready

```text
┌────────────────────────────────────────────────────────────────────┐
│ WTS                                             [Check for updates]│
│ App updates                                                        │
├────────────────────────────────────────────────────────────────────┤
│ Installed version 0.1.1723622400                                  │
│ WTS 0.1.1723622500 is ready                         [Relaunch WTS]│
│ WTS installed the verified update. Relaunch WTS to use it.        │
└────────────────────────────────────────────────────────────────────┘
```

### Error

```text
┌────────────────────────────────────────────────────────────────────┐
│ WTS                                             [Check for updates]│
│ App updates                                                        │
├────────────────────────────────────────────────────────────────────┤
│ WTS could not update                                              │
│ WTS could not verify and install the update.                      │
└────────────────────────────────────────────────────────────────────┘
```

Use the status `detail` as bounded user-facing text. Do not show raw plugin,
network, signature, command, or filesystem output.

## Complete state map

```text
                   [disabled]
                       |
               valid configuration
                       |
                       v
                  [upToDate]
                       |
              Check for updates
                       |
       +---------------+---------------+
       |                               |
   no update                         update
       |                               |
       v                               v
  [upToDate]                      [available]
                                       |
                                  Update WTS
                                       |
                                       v
                                [downloading]
                                  |         |
                                failure   installed
                                  |         |
                                  v         v
                               [error]    [ready]
                                  |         |
                              Try again   Relaunch WTS
                                  |         |
                                  +---------+

Any manifest or signature failure -> [error]
Any command before configuration  -> [disabled]
```

## Exact first-release contract

The Rust and TypeScript contracts must use these names and fields.

```text
AppUpdateState
  disabled
  upToDate
  available
  downloading
  ready
  error

AppUpdateDiagnosticCode
  notConfigured
  networkUnavailable
  manifestInvalid
  signatureInvalid
  downloadFailed
  installFailed

AppUpdateStatus
  schemaVersion: 1
  state
  currentVersion
  availableVersion?
  publishedAt?
  notes?
  downloadedBytes?
  totalBytes?
  detail
  diagnosticCode?

AppUpdateProgress
  version
  downloadedBytes
  totalBytes?

RelaunchUpdatedAppResult
  accepted
```

Contract rules:

- `available`, `downloading`, and `ready` require `availableVersion`.
- `publishedAt` must be a valid provider timestamp.
- Byte counts must be nonnegative integers.
- `downloadedBytes` must not exceed `totalBytes`.
- `schemaVersion` must equal `1`.
- Unknown states, diagnostics, and fields must fail normalization.
- Bound `currentVersion`, `availableVersion`, `notes`, and `detail`.
- Do not add `phase`, `channel`, URL, path, hash, signature, or receipt fields.

## Exact Tauri commands

```text
get_update_status() -> AppUpdateStatus
check_for_update() -> AppUpdateStatus
download_and_install_update() -> AppUpdateStatus
relaunch_updated_app() -> RelaunchUpdatedAppResult
```

`get_update_status` reads process-owned state without a feed request. The UI
uses the same update controller to start one check after application startup.

`check_for_update` reads the fixed local feed through the configured updater.
It stores the verified pending update in native state.

`download_and_install_update` can install only that stored pending update. The
UI cannot submit a version, endpoint, artifact, path, signature, or hash.

`relaunch_updated_app` can run only after the state is `ready`. An accepted
result means that the native relaunch request was accepted.

Add generated allow and deny permissions for all four commands. Add only the
required allow permissions to the default desktop capability.

## Client behavior

Add these methods to `WorkspaceClient`:

```text
getUpdateStatus(): Promise<AppUpdateStatus>
checkForUpdate(): Promise<AppUpdateStatus>
downloadAndInstallUpdate(): Promise<AppUpdateStatus>
relaunchUpdatedApp(): Promise<RelaunchUpdatedAppResult>
```

The browser-host implementation reports `disabled` with `notConfigured`. The
loopback HTTP host does not expose an application replacement endpoint.

The UI must serialize actions. It must ignore an older result after a newer
action starts. It must check at startup, on window focus, and every five
minutes. It must not start a second operation while one is active.

## Local QA feed

Use this fixed per-user directory:

```text
Application Support/dev.wts.desktop/updates/
  latest.json
  WTS_<version>_aarch64.app.tar.gz
```

Resolve the Application Support directory through the macOS platform API. Do
not let an environment variable, WebView value, symlink, or manifest choose the
feed root.

The local feed is not a public release channel. The QA app must not contact a
remote update server.

The staged manifest uses this exact bounded shape:

```text
StagedUpdateManifest
  schemaVersion: 1
  version
  notes
  pubDate
  artifactFile
  signature
  sha256
  size
```

The updater signature is embedded in `latest.json`. The staged feed does not
contain a separate `.sig` file or an `artifacts` subdirectory.

## Local feed trust model

The local filesystem is not update authority. A process with the same user
account can write files. The updater signature remains mandatory.

The QA build creates this permission-restricted local key material outside the
repository:

```text
Application Support/dev.wts.desktop/
  updater-signing.key
  updater-signing.key.pub
  build-sequence
  updates/
```

The build embeds the updater public key. The private key uses mode `0600` and
never enters the app bundle, staged feed, UI, logs, or repository.

The native updater must:

1. Read only the fixed local feed manifest.
2. Reject a missing or malformed manifest.
3. Require a version greater than `currentVersion`.
4. Require `artifactFile` to match `WTS_<version>_aarch64.app.tar.gz`.
5. Reject absolute paths, traversal, symlinks, and control characters.
6. Require the Tauri updater signature before installation.
7. Require the expected bundle identifier and Apple Silicon architecture.
8. Keep updater errors free of keys, paths, and raw artifact content.

The current QA app uses an ad-hoc Apple code signature. The first release can
verify that local signature and bundle identity. It must not claim Developer ID
or notarization trust.

## Monotonic QA version

The tracked static version `0.1.0` is not sufficient for repeated updates. Use
the UTC epoch sequence as the numeric patch version:

```text
0.1.1723622400
0.1.1723622401
0.1.1723622500
```

`stage-macos-update.mjs` stores the last sequence. It selects the larger value
of the current epoch seconds or the prior sequence plus one. It rejects a
symlinked, malformed, or unsafe sequence file.

Pass the version to Tauri as a build override. Embed the same value in the app,
updater artifact, and local manifest. Do not edit a tracked version file for
each QA build.

## QA build and publish flow

Extend the existing macOS QA build rather than adding a second application
builder.

```text
npm run build:macos:qa
        |
        v
Run stage-macos-update.mjs next-version
        |
        v
Derive 0.1.<monotonic epoch sequence>
        |
        v
Build WTS.app + updater artifact
        |
        v
Apply the existing ad-hoc Apple signature
        |
        v
Sign the updater artifact with the local QA updater key
        |
        v
Run stage-macos-update.mjs stage
        |
        v
Verify the artifact and manifest
        |
        v
Publish through a hidden staging directory and atomic rename
```

`stage-macos-update.mjs` copies the artifact through a hidden staging file. It
embeds the signature, SHA-256, size, version, date, notes, and artifact filename
in `latest.json`. It replaces the manifest only after the artifact is present.
It then removes the prior versioned artifact.

The initial app still uses `npm run install:macos:qa`. Later QA builds publish
to the local feed. The installed WTS app then checks, installs, and relaunches.

## Component reuse

- Use `AppUpdateScreen.tsx` for the global page.
- Use `useAppUpdate` as the shared startup and action controller.
- Add **Updates** to the top bar with an available-or-ready badge.
- Add **App updates** to the command palette Navigate group.
- Route both actions to `/updates`.
- Reuse existing status, button, alert, glyph, and progress styles.
- Keep the surface global. Do not place it in a workspace tab or settings.

Suggested callout:

```text
data-ui="updates.page"
data-ui-label="App updates page"

data-ui="updates.header"
data-ui-label="App updates header"

data-ui="updates.status"
data-ui-label="Update status"

data-ui="updates.actions"
data-ui-label="Update actions"
```

Read `docs/ui-callouts.md` before implementation. Pair the machine ID with the
spoken label.

## Accessibility and responsive behavior

- Keep all interface text at 12 px or larger.
- Give progress a visible label and numeric accessible value.
- Announce state changes with a status region.
- Use an alert for errors.
- Keep visible focus on every action.
- Disable an action while its native command runs.
- Do not use color as the only state signal.
- Respect reduced-motion settings.
- Keep the page usable at 320, 768, and 1440 pixel widths.

## Automated validation

Each feature or defect needs a behavior or trusted-boundary test. A test that
only constructs a value does not satisfy the project validation rule.

### Local feed and build tests

- Prove two consecutive calls produce `0.1.<increasing epoch sequence>`.
- Prove an equal or earlier epoch still produces the prior sequence plus one.
- Prove every version source in the built artifact matches.
- Prove the build produces the updater artifact and signature.
- Prove `stage-macos-update.mjs` rejects a missing or invalid signature input.
- Prove publication leaves the prior feed intact after a failure.
- Prove `latest.json` changes only after complete artifact publication.
- Prove the staged directory contains only `latest.json` and the newest
  `WTS_<version>_aarch64.app.tar.gz`.
- Prove the manifest embeds the signature, SHA-256, size, and artifact filename.
- Prove a symlinked sequence, artifact, signature, or manifest fails.
- Prove the installed QA build does not contact a remote update endpoint.

### Native trust tests

- Prove only the fixed per-user feed root is read.
- Prove absolute paths, traversal, symlinks, and control characters fail.
- Prove missing, malformed, and older manifests fail.
- Prove a bad updater signature returns `signatureInvalid`.
- Prove a valid signed newer artifact reaches the updater install boundary.
- Prove the UI cannot select an endpoint, artifact, path, or signature.
- Prove update errors keep the current app available.
- Prove relaunch is rejected before `ready`.
- Prove the temporary loopback server uses a random server-owned route and
  serves only the prepared manifest and artifact.
- Prove only one update operation can run at a time.

### Contract and permission tests

- Prove all six states and all six diagnostic codes serialize exactly.
- Prove each conditional field rule.
- Prove malformed timestamps and byte counts fail.
- Prove unknown states, diagnostics, and fields fail.
- Prove exact command names and method calls.
- Prove the browser client returns `disabled` and exposes no update endpoint.
- Prove generated allow and deny permissions for all four commands.
- Prove the default capability contains only the required allow permissions.

### UI behavior tests

- Cover disabled, up-to-date, available, downloading, ready, and error states.
- Prove **Check for updates** checks and installs an available update.
- Prove the app checks and installs an available update after startup.
- Prove window focus checks for an update that arrived in the background.
- Prove rerenders and workspace navigation do not start another check.
- Prove only one automatic download and installation runs at a time.
- Prove **Relaunch WTS** calls only `relaunchUpdatedApp`.
- Prove the progress value uses `downloadedBytes` and `totalBytes`.
- Prove errors use an alert and expose the retry action.
- Prove controls remain disabled during an active command.
- Prove an older result cannot replace a newer state.
- Prove keyboard focus, status announcements, and narrow layouts.
- Prove `/updates`, the top-bar action, and command-palette action show the same
  global page.
- Prove the badge appears only for `available` or `ready`.
- Prove the feature does not add a workspace tab or settings row.

### Manual local QA check

1. Install `0.1.1723622400` with `npm run install:macos:qa`.
2. Build and publish `0.1.1723622500` to the fixed local feed.
3. Focus the installed WTS window.
4. Confirm that WTS installs `0.1.1723622500` and shows the ready state.
5. Restart WTS when convenient.
6. Confirm that Applications opens version `0.1.1723622500`.

## Billing

Billing does not apply. The feature reads a local QA artifact and updates the
installed application. It creates no hosted job, subscription, metered action,
or recurring billing record.

## First release

Include:

- fixed per-user local QA feed
- numeric `0.1.<monotonic epoch sequence>` versions after static `0.1.0`
- mandatory updater artifact signature
- ad-hoc Apple signature and bundle identity check for local QA
- global `/updates` page
- **Updates** top-bar action and badge
- **App updates** command-palette action
- manual check on the App updates page
- automatic checks after startup, on window focus, and every five minutes
- automatic verified download and installation
- exact disabled, up-to-date, available, downloading, ready, and error states
- download progress
- Tauri updater flow
- explicit relaunch action
- exact native and client contracts in this document
- generated Tauri permissions
- keyboard, screen-reader, and narrow-width behavior

## Deferred scope

- available-update banner
- download cancel, pause, or resume
- app-wide safe-restart queue for non-update operations
- rollback bundle and launch-health receipt
- application data snapshot and migration rollback
- Developer ID signing and Apple notarization
- first-party HTTPS stable release feed
- stable and preview channel selection
- public release key rotation and revocation
- installer authorization fallback
- release notes link
- automatic relaunch
- differential updates
- update telemetry
- Windows and Linux updates
- Mac App Store distribution

## Open questions

None for the first release.
