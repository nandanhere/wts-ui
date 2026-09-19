# Flow verification report

Date: September 18, 2026.

## Result

Two enhancement increments are complete. The final desktop build runs locally. No code was pushed, and no real provider or GitLab message was sent.

The goal remains active for recovery after interrupted setup and further error-flow improvements.

## Fixes

- Native preview requests show read-only guidance without replacing Tauri internals. Native access checks remain the authority.
- Verify follows the host run state after reopening or cancellation. Late cancellation replies cannot replace a newer terminal result.
- Removal excludes WTS-managed agents, queued work, and checks. It retains the operation lock through deletion and registry updates.
- Manual session startup validates the workspace inside its operation lock. It cannot create an active session after removal deletes that workspace.
- Blocked removal opens Workspace or Verify for recovery. Active work cannot use the destructive-file override.
- Plans feedback permits one pending request and preserves newer draft edits.
- MR refresh preserves the selected file. A new conversation selection still selects its exact file.
- Uncertain GitLab replies retain the draft and recovery guidance after reopening.
- Task changes retains its body in the native WebView. Recovery guidance and controls remain visible.

## Automated verification

| Check | Result | Local evidence |
| --- | --- | --- |
| Complete UI suite | 1,641 tests passed in 106 files | `/tmp/wts-flow-ui-final.log` |
| Directed development browser flows | 18 passed | `/tmp/wts-flow-browser.log` |
| Result layout and existing review flows | 13 passed, including Chromium and WebKit | `/tmp/wts-result-layout-green.log` |
| Separate WebKit layout command | 4 passed | `/tmp/wts-result-webkit-final.log` |
| Native preview initialization and permissions | 3 passed | `/tmp/wts-native-preview-initialization-green.log` |
| Native preview client and Verify regressions | 42 passed | `/tmp/wts-preview-verification-green.log` |
| Removal lock order and session startup | 2 passed | `/tmp/wts-removal-guard-final.log` |
| Removal process and filesystem recovery | 4 new and 6 existing cases passed | `/tmp/wts-removal-filesystem-final.log` |
| Removal HTTP and native contracts | Passed | `/tmp/wts-removal-operation-transports.log` |
| App, server, and desktop Clippy | Passed with warnings denied | `/tmp/wts-removal-guard-clippy-final.log` |
| UI production build | Passed | `/tmp/wts-flow-ui-build-final.log` |
| Desktop build | Passed | `/tmp/wts-flow-desktop-build.log` |

Some focused checks overlap the complete suites. One removal subprocess helper is intentionally ignored as a standalone test.

The preview tests execute the installed Tauri core script and resolve the generated native permissions. They reject writes, wrong windows, wrong ports, and local-origin requests.

## Native inspection

The normal native tool failed before connection. The user approved macOS screenshot and accessibility tools for WTS.

Verified in the running window:

- Option highlights the selected region and opens feedback.
- Feedback contains the region image, text, and stable label.
- One transcript contains the saved feedback history.
- Selecting a new region preserves the existing draft.
- Discarding the empty inspection draft restores the existing draft.
- Task changes shows recovery guidance for an old task without a complete record.

The native layout check failed with the preceding CSS and passed with the final CSS. Modern Playwright WebKit passed both versions.

Native failure evidence: `/tmp/wts-native-result-layout-red.log` and `/tmp/wts-native-result-review-confirm.png`.

Native fix evidence: `/tmp/wts-native-result-layout-green.log` and `/tmp/wts-native-result-unavailable-fixed.png`.

Run the native check after opening Task changes for an old task without a complete record:

```sh
osascript scripts/check-native-result-layout.applescript
```

The check reads native accessibility geometry. It verifies that both the recovery message and link remain inside the dialog.

## Restart verification

The restart preserved all three saved conversations and all 21 session IDs. No managed agent or verification process was active before the restart.

Before: `/tmp/wts-flow-before-restart.json`. After: `/tmp/wts-flow-after-restart.json`.

The original saved feedback draft remained intact during native inspection. Inspection did not retry the old failed tasks.

## Limits and next work

The user history has no completed isolated candidate. A separate native fixture now verifies completed results, two alternatives, Plans reads, write rejection, and preview process cleanup.

The native fixture uses three fake provider turns. It verifies app behavior and process boundaries, not the quality of an LLM response.

Terminal handoffs and unrelated external editors do not have WTS-owned processes. The removal lock cannot coordinate those external writers.

Older candidate UIs without the preview client guard still use native access checks. Their original error copy does not change.

The second increment fixed rollback after returned setup errors. The third increment adds a durable record for process termination and retained paths.

## Second increment: setup recovery

The transaction now includes every fallible step after Git creates worktrees. It records generated files and publishes the success receipt last.

Rollback preserves existing files, external files created during checkout, and files edited during setup. Git rollback also preserves ignored files.

Manual and automatic MR creation clear the old setup review after failure. Incomplete cleanup offers “Review remaining files” before another setup review.

Completed checks for this increment:

| Check | Result | Local evidence |
| --- | --- | --- |
| Setup rollback and generated-path conflicts | 6 final cases passed. The original 3 rollback cases failed before the fix. | `/tmp/wts-materialization-filesystem-final.log` |
| Early and final failure cleanup, edits, and restart retry | 2 passed on the final service transaction | `/tmp/wts-materialization-late-final.log` |
| Generated-file identity, mode, and cleanup result | 8 passed. Replacement cases failed before their fixes. | `/tmp/wts-generated-rollback-result-green.log` |
| Full app flow integration suite | 69 passed | `/tmp/wts-materialization-mvp-flow-final.log` |
| Git rollback and ignored files | 17 passed | `/tmp/wts-ignored-rollback-green.log` |
| Setup recovery UI | 6 passed, including manual, automatic, and workspace-conflict paths | `/tmp/wts-setup-target-conflict-green.log` |
| Directed browser suite | 22 passed | `/tmp/wts-directed-pr-browser-final.log` |
| CI command harness | 23 passed | `/tmp/wts-directed-pr-harness-final.log` |
| Rendered candidate preview | Passed | `/tmp/wts-rendered-preview-green.log` |
| Final UI production build | Passed | `/tmp/wts-flow-final-ui-build.log` |
| Final app Clippy | Passed with warnings denied | `/tmp/wts-generated-files-final-clippy.log` |
| Final desktop build | Passed | `/tmp/wts-flow-final-desktop-build.log` |

The rendered preview test executes an imported dependency. It then edits a candidate module and observes the DOM update in the same page.

The HMR-off negative control fails because the DOM retains its original value. This control verifies test sensitivity. It is not a preceding production defect.

The PR gate now executes the directed browser suite and the rendered preview test. The existing browser checks remain in that gate.

Setup review now checks every generated file destination before Git creates worktrees. It permits existing regular parent directories and rejects symbolic links or conflicting file types.

The conflict names the path and explains how to preserve it. Workspace path conflicts offer path copy and guarded inspection.

## Completed native candidate inspection

The fixture uses a separate app identifier, process name, origin, data directory, repository catalog, and incognito main window. Provider CLI stubs reject new requests.

The native checks used macOS accessibility and WTS-window screenshots with the existing user approval.

Verified through the normal interface:

1. Open the completed parent task and inspect its recorded file change.
2. Open the saved alternatives and the Compact candidate preview.
3. Read the parent plan inside the candidate window.
4. Edit the temporary plan buffer and select Save.
5. Confirm read-only guidance, the retained draft, and unchanged file bytes.
6. Close Compact and confirm that its Node process stops.
7. Reopen Compact and confirm a new process.
8. Open Spacious and confirm a separate candidate marker and process.
9. Close Compact and confirm that Spacious remains active.
10. Close Spacious and the fixture host. Confirm that no fixture preview process remains.

Evidence:

- Native Plans view: `/tmp/wts-native-fixture-preview-plans.png`.
- Rejected write and retained buffer: `/tmp/wts-native-fixture-preview-write-denied.png`.
- File-byte check: `/tmp/wts-native-fixture-preview-write-check.log`.
- Process isolation: `/tmp/wts-native-fixture-preview-isolation.log`.
- Native seed: `/tmp/wts-native-candidate-seed.log`.

The retained fixture had an old `/plans` context link. Its recovery link opened the workspace board and then Plans. The fixture generator now uses `/planning`.

Only the fixture generated provider turns. Its launch count stayed at three. The user application did not send a provider message.

To prepare another isolated native fixture:

```sh
WTS_PREPARE_NATIVE_FIXTURE=1 cargo test --locked -p wts-app --test agent_native_preview_fixture -- --ignored --nocapture
node scripts/native-candidate-fixture.mjs build /path/from-test/fixture.json
WTS_NATIVE_FIXTURE_LAUNCH=1 node scripts/native-candidate-fixture.mjs launch /path/from-test/fixture.json
```

The helper needs macOS, Node, installed UI dependencies, and build space. Inspect the manifest before launch. Use only result, preview, and Plans controls during this check.

## Second-increment restart

The second-increment backend build ran in WTS. Its UI updates used Vite.

The restart preserved all three saved conversations, all 21 session IDs, and the exact existing native feedback draft.

Evidence: `/tmp/wts-flow-final-restart-after.json`. Desktop log: `/tmp/wts-flow-final-desktop.log`.

## Third increment: durable setup recovery

Setup saves its plan before Git changes the filesystem. It records confirmed worktrees separately from an unconfirmed Git step.

Generated-file records contain relative paths, file identities, modes, sizes, and content hashes. Publication saves the temporary inode before it creates the final link.

The app preserves changed or replaced paths. It also preserves reused directories and paths with no confirmed receipt.

A shared file lock prevents another WTS process from cleaning active setup. Host termination releases that lock.

After restart, setup review shows the failed attempt. Opening the app does not clean files. Clean setup files requires the current review digest.

Cleanup removes only unchanged attempt files and unchanged initial worktrees and branches. New commits, ignored data, changed files, and unknown paths block cleanup.

After the user preserves blocked files outside the setup, a fresh review can permit cleanup. The saved workspace plan remains available for explicit creation.

A valid success receipt prevents cleanup, including termination between receipt publication and attempt finalization. An old cleanup request cannot remove a later completed workspace.

The review records the original plan selections. A changed base, repository set, runtime, or planning selection invalidates that recovery review.

Native previews now prevent new Plans and source edit sessions. A rejected existing draft offers Copy draft and main-window guidance without an impossible save retry.

### Validation evidence

The initial app crash tests failed because no incomplete attempt appeared after process termination: `/tmp/wts-setup-recovery-red.log`.

Git observer regressions failed before the callback implementation. Final Git results are in `/tmp/wts-materialization-observer-git-final.log`.

Generated-file regressions cover serialized recovery, publication timing, replaced parents, changed modes, unresolved intents, and altered temporary contents.

All 18 generated-file tests passed: `/tmp/wts-generated-snapshot-final-green.log`.

HTTP and native tests check the workspace identity, reviewed digest, request fields, authentication, origin, permissions, and preview restrictions.

Transport results: `/tmp/wts-setup-recovery-http-green.log`, `/tmp/wts-setup-recovery-preview-acl.log`, and `/tmp/wts-durable-setup-transport-validation.md`.

The full UI suite passed 1,690 tests in 108 files before the final path-list disclosure adjustment: `/tmp/wts-setup-final-ui.log`.

After the path-list disclosure change, all 11 affected UI tests passed: `/tmp/wts-setup-paths-green.log`.

The final UI build and TypeScript check passed: `/tmp/wts-setup-final-build.log`.

All 22 directed browser tests passed: `/tmp/wts-setup-final-browser.log`.

Four setup browser cases passed across both themes at 375 and 1,440 pixels: `/tmp/wts-setup-panel-browser.log`.

Those cases check the visible cleanup action, wrapped paths, keyboard disclosure, and the fresh review after fake cleanup. They reject automatic creation.

An additional lock test reproduces a duplicated descriptor that retains the old lock after normal File closure.

The setup guard now releases the lock explicitly on normal completion. All three completion boundary tests pass: `/tmp/wts-setup-lease-duplicate-green.log`.

The earlier concurrent crash run missed its checkpoints under host load. The same limits passed serially: `/tmp/wts-setup-recovery-serial-final.log`.

All 69 app flow tests passed after the lock-release fix: `/tmp/wts-setup-recovery-mvp-final-clean.log`.

The full flow rerun used two test threads and unchanged time limits. Earlier high-concurrency failures remain in the retained logs.

All eight final setup recovery tests passed: `/tmp/wts-setup-recovery-final.log`.

Final app Clippy passed with warnings denied: `/tmp/wts-setup-recovery-final-clippy.log`.

Server and desktop Clippy passed with warnings denied: `/tmp/wts-setup-recovery-transport-clippy.log`.

The final desktop build passed: `/tmp/wts-setup-recovery-desktop-build.log`.

The updated WTS process runs as PID 45745. Its UI uses the existing Vite server.

The restart preserved all three conversations, all 21 session IDs, and the exact saved native draft.

Evidence: `/tmp/wts-recovery-restart-after.json`. Native screenshot: `/tmp/wts-recovery-final-running.png`.

The source review found no further required defect in the stated flows. This verification and enhancement goal is complete.

All changes remain local. The checks did not send messages from the user application or push code.

### Operating limits

Recovery records created by this version cannot prove ownership of older incomplete setups. Those paths retain the existing inspection and preservation guidance.

An unconfirmed Git step does not become a receipt merely because its target exists. WTS preserves that path and branch for inspection.

Recovery reads at most 1,024 filesystem paths. It does not scan inside a confirmed worktree to produce its path list.

The tested platform is macOS. External editors and Git commands do not hold the WTS setup lock.
