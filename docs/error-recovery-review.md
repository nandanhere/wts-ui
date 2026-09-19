# Error recovery review

Date: September 17, 2026.

The review traced errors, disabled controls, retries, saved state, and recovery actions across the desktop application. It found and fixed the defects below. Tests use controlled failures at UI, transport, and filesystem boundaries. No real workspace removal or provider message occurred during the review.

## Removal

The dialog now shows the affected path, known expected and actual values, and specific recovery steps. It offers these actions when applicable:

- Register changed Git state, then check removal again.
- Open Changes to inspect local work.
- Open Plans to inspect planning files.
- Open integrations to check Git.
- Copy a path or the full recovery details.

Clipboard failure exposes selected text for manual copying. These actions also work when removal starts from the board before the workspace details load. A failed registration keeps its error inside the dialog.

Two backend defects caused false blockers. Removal checked the shared workspace branch instead of each worktree's recorded branch. A failed worktree check also produced a duplicate unknown-path warning. Both checks now use the trusted worktree records correctly.

Unsafe or unreadable Plans entries now produce specific path blockers. Transport tests cover the added path, expected value, actual value, and recovery steps. Malformed fields fail validation.

Unknown paths and invalid ownership still block removal. Registration does not delete files. A successful repair triggers a fresh removal check and requires a new deletion confirmation.

## Other fixes

| Flow | Previous failure | Current recovery |
| --- | --- | --- |
| Workspace details | Cached details hid a failed refresh and its Git drift action. | Keep the details and show the error with registration, refresh, or integration actions. |
| Repository alignment | Check again did nothing after the first alignment request failed. | Keep the repository identity and repeat only the alignment check. |
| My reviews | One failed provider could disappear behind another provider's empty results. | Show each provider failure, keep saved rows, and link authentication failures to integrations. |
| Changes | Local and GitLab errors gave little direction. | Open workspace status for local failures and integrations for GitLab failures. Refresh the account before line comments. |
| Conversations and review comments | A failed send gave no way to check whether GitLab accepted it. | Keep the draft and offer Open MR before another explicit send. Never resend automatically. |
| Local review feedback | A stale local resolution had no refresh action. | Refresh the feedback before another resolution attempt. |
| Source editor | Permanent file errors repeated the same failed read. | Open VS Code for unavailable, binary, oversized, or invalid files. Keep failed edits and offer manual copying. |
| Plans | Empty, missing, or unreadable files led to ineffective retries. | Create supported planning files, refresh the list, or open VS Code. Keep unfinished drafts. |
| Work items | Stale Jira previews, links, and unlink conflicts lacked a fresh check. | Refresh the preview or link state. Create a new request identity only after an explicit new preview. Keep manual proposals. |
| My time and agent sessions | ActivityWatch, notification, Jira, and clipboard failures gave incomplete next steps. | Explain the missing setup, open integrations, refresh sessions, and retry Jira without discarding assignments. Offer manual brief copying. |
| AI review | An unsupported review action remained enabled. | Explain the missing capability and offer VS Code for manual review. |
| Verification | Failed cancellation or progress reads hid the active run. Late errors could overwrite its result. | Keep the run and cancellation action. Preserve the original completion and reject stale request results. |
| Jira setup | Fresh authentication failures could leave a disabled Connected action. | Reset the connection state so the user can connect again. |
| GitLab setup | A missing host had no check action after remote changes. | Check the current workspace again. |
| App updates | Installation and relaunch failures hid the relevant recovery action. | Restore the install action or retain Relaunch WTS. |

## Existing recovery checked

Creation and import flows retain editable inputs and retry actions. Failed runtime analysis permits another attempt or continuation without services. Failed saves retain their request identity. Pending clones can return to the board.

Registry and workspace lookup failures offer retry and navigation actions. Materialization failures return to setup review. Missing bases permit another branch selection. Ordinary sync failures restore the sync action.

Workspace launch failures retain provider choices. VS Code remains available after a prepared brief fails. Setup checks can run again after tool, signing, or connection failures.

These checks traced source handlers and existing tests. They do not represent live end-to-end checks of every external tool.

## Validation

- The full UI run covered 965 tests across 79 files. It passed 964 tests and found one duplicate sync error message.
- After that fix, all 35 workspace operation and recovery tests passed. The other 78 files passed in the full run.
- The UI now includes 61 additional regression cases for this review.
- Rust checks passed 185 tests, with one existing ignored test. This includes six new filesystem tests and six existing removal tests.
- Type checking, the production build, strict Clippy, formatting, interface prose, callout contracts, and whitespace checks passed.

The main removal tests are [the shell recovery tests](../ui/src/variants/local-workspace/LocalWorkspaceRecovery.test.tsx), [the dialog tests](../ui/src/variants/local-workspace/WorkspaceRemovalRecovery.test.tsx), [the transport tests](../ui/src/lib/workspaceRemovalContract.test.ts), and [the filesystem tests](../crates/wts-app/tests/removal_recovery.rs).

New regression tests failed before their corresponding fixes. One additional filesystem test preserves the existing root-symlink protection.

Browser checks covered desktop and narrow layouts in both themes. Long paths wrapped without overflow. The footer stayed visible. Blocked removal stayed disabled. Clipboard failure retained keyboard focus inside the dialog.

## Limits and optional integration checks

Provider authentication, ActivityWatch installation, system permissions, and manual file repair still need user action. The interface now supplies a supported route or instructions for these cases.

A failure after filesystem deletion starts can still return the general removal error. Check again recomputes the remaining effects. Retries tolerate worktrees and generated files that the earlier attempt removed. Showing the exact failed path at this stage remains a possible improvement.

Optional checks with a disposable workspace and test accounts:

1. Change a worktree branch, then check the removal recovery actions.
2. Restore a failed provider connection, then refresh its screen.
3. Check an uncertain GitLab send in the MR before another explicit send.
4. Retry an update installation or relaunch after a controlled failure.

These checks are optional because they depend on external applications and permissions. The automated checks cover deterministic behavior without real provider messages or user-data removal.
