# Progress

All five delivery stages are implemented and validated. The rebuilt desktop app is running locally. Nothing was pushed.

## Delivered behavior

- One feedback conversation retains UI selections, MR context, drafts, and queued requests.
- Each completed turn has a private before/after source receipt and its own recorded patch.
- Host checks use saved commands and bind results to the exact source state and check definition.
- Restore shows the file effects, preserves the index and history, and retains an interrupted operation for exact retry.
- Task plans use isolated workspaces. Dependencies receive completed prerequisite results. Independent work can continue after a failed task.
- Child context includes the exact originating request and reply in a private artifact. A later parent message cannot enter that artifact.
- Alternatives start from the same frozen source. Applying one requires explicit file review and matching passed checks.
- WTS UI candidates have separate desktop previews. Preview windows have read permissions, separate Vite caches, and process ownership that survives delayed window-close events.
- Decisions retain a choice, reason, source identity, and available check results. A decision does not apply files or publish changes.

## Validation

| Boundary | Result |
| --- | --- |
| Full UI suite | 1,624 tests passed in 105 files |
| Browser flows | 18 cases passed with controlled HTTP responses |
| Rust app unit tests | 211 passed. 3 optional/helper tests ignored |
| Git unit tests | 33 passed |
| Native unit and command contracts | 43 passed |
| HTTP contracts | 67 passed |
| Receipt and restore process tests | 9 passed |
| Isolated work-set process tests | 6 passed, plus the origin-context regression |
| Binary integration and restore | 5 passed |
| Host-check process tests | 9 passed. 1 subprocess helper ignored |
| Decision persistence | 6 passed |
| Private matching-check proof | 3 passed |
| UI build and TypeScript | Passed |
| Clippy for app, Git, HTTP, and native targets | Passed with warnings denied |

The first unrestricted UI run had eight timing failures while builds ran in parallel. The full suite then passed with four workers and unchanged timeout limits.

A real provider completed three dependent Python fixes in a temporary repository. Three failing behavior tests passed after the changes. The queue ran requests in order, repeated sends did not add work, and complete replies survived a service reopen. The trial preserved the earlier draft, acceptance tests, base checkout, and HEAD. It did not simulate a host crash.

Separate process tests cover host termination, inherited writer leases, exact request replay, partial file effects, stale source rejection, and recovery from saved journals. Binary tests retain exact PNG bytes in isolated workspaces, checked integration, and restore.

Preview tests cover actual HTTP responses from candidate files, distinct ports, the two-process limit, dependency changes, delayed close events, and host death. A separate installed-Vite test exercises a real dependency import, changed candidate HTML, and preservation of the source Vite cache.

Browser screenshots at 375 × 640 pixels show the changed code without an initial scroll. Result details use expandable rows. Candidate integration shows the final result after apply, and queued candidates do not expose a preview action.

The origin-context regression failed before the artifact existed, then passed against actual child process arguments and files. It checks exact request, conversation, and session identities, private permissions, and exclusion of later messages. App Clippy passed again after this final change.

## Desktop restart

The initial desktop restart used PID 25679. Later restarts and preservation checks are recorded in the flow verification report.

After the restart, the saved message hashes matched for all three conversations. All 21 saved agent session identities remained present. The data check is recorded in `/tmp/wts-directed-after-restart.json`.

## Native validation

The normal native connection failed before it connected. The user approved macOS accessibility tools and WTS-window screenshots.

Those checks now cover Option selection, the shared transcript, the native result dialog, candidate previews, Plans reads, write rejection, and process cleanup.

The isolated fixture used temporary repositories and three fake provider turns. It did not send messages from the user application.

See [the flow verification report](../flow-enhancements/REPORT.md) for native evidence, restart checks, and the latest test results.

## Operating limits

A capture supports 2,048 regular files, at most 2 MiB each and 32 MiB in total. It preserves exact UTF-8 and binary bytes. Binary files have an explicit text-patch limit. Symbolic links and unsupported paths remain blocked.

The current WTS checkout contains 865 regular files, about 13.5 MB in total, including 23 binary files. No file exceeds the per-file limit.

Private snapshots retain before and after states. Global retention and deduplication are not implemented. WTS does not silently discard old snapshots. Each capture can use up to 32 MiB of private blobs.

A plan supports eight tasks, with three active or preparing tasks across plans. There are limits of 64 plans per originating turn and 4,096 stored plans overall. A decision history retains up to 64 records per turn. Two live preview processes can run at once.

WTS leases exclude its own competing writers. External editors do not use those leases. Restore and integration check each file before a write, but a multi-file operation is not atomic against external writers. Keep other editors and Git tools idle during these operations.

Supported UI changes use live updates. Native Rust changes require a rebuilt executable and a restart. Candidate previews require the desktop app and compatible installed UI dependencies.

## Evidence

- Real provider queue: `/tmp/wts-real-provider-queue.log`
- Full UI: `/tmp/wts-directed-ui-final.log`
- Browser flows and images: `/tmp/wts-directed-browser-complete.log`, `/tmp/wts-directed-browser-complete`
- Rust unit and transport tests: `/tmp/wts-directed-rust-final.log`
- Receipt and isolated tasks: `/tmp/wts-directed-binary-receipt-worksets-final.log`
- Binary integration and restore: `/tmp/wts-binary-integration-green.log`
- Host checks: `/tmp/wts-binary-host-checks-green.log`
- Decisions: `/tmp/wts-turn-decisions-final.log`
- Real Vite: `/tmp/wts-work-item-preview-real-vite-final.log`
- Clippy: `/tmp/wts-directed-clippy-final.log`
- Final origin context and Clippy: `/tmp/wts-work-set-origin-green.log`, `/tmp/wts-work-set-origin-clippy.log`
- Desktop build and process: `/tmp/wts-directed-desktop-build-final.log`, `/tmp/wts-directed-desktop.log`

Validation uses temporary repositories. No source changes were pushed and no provider replies were published.
