# WTS flow recovery and verification

Status: Complete. Three verified increments are recorded in [the report](REPORT.md).

## Goal

Verify the directed development features in the running app. Improve the other WTS flows in bounded steps with tests.

Keep changes local. Preserve repository files, saved sessions, drafts, and queued work. Do not push code or send provider messages.

## Current scope

| Flow | Confirmed defect | Required behavior |
| --- | --- | --- |
| Native candidate preview | The preview script tries to replace an immutable Tauri function. The client shows a connection error for a blocked write. | Keep native access checks. Show read-only guidance before a prohibited client request. Test the installed Tauri script contract. |
| Verification | Reopening an active run loses Cancel. A cancellation response can report that checks still run. | Follow the host state. Keep new runs disabled until checks stop. Accept the final run result. |
| Workspace removal | Removal can overlap an agent or verification process. | Hold the shared workspace operation lock through removal. Show recovery actions for active work. Do not permit a deletion override. |
| Plans | Editing feedback during a send permits a second request. The first response can erase the new draft. | Keep one request in progress. Preserve edits made after that request starts. |
| MR and local changes | Refreshing the file list restores an earlier selection. | Preserve the current file during refresh. Honor a new explicit conversation selection. |
| MR replies | An uncertain delivery state disappears when the conversation closes. | Preserve both the draft and delivery guidance. Let the user check GitLab before a retry. |
| Workspace setup | Late failures bypass cleanup or delete existing files. A retry can reuse an old review. | Track each created file. Preserve changed and unknown files. Require a fresh review and provide file inspection. |
| Task changes | The native WebView collapses the dialog body and hides its recovery actions. | Give the scroll body an explicit content basis. Keep the recovery message and link inside the dialog. |

## Review coverage

The review includes workspace creation, materialization, switching, imported plans, MR code, discussions, verification, agent failures, and removal.

The existing tests cover imported Markdown, cached workspace content, draft recovery, and the shared agent queue. Add regressions for the defects above.

## Acceptance checks

1. Reproduce each defect with a behavior or trusted-boundary test.
2. Run the affected tests after each fix.
3. Run TypeScript checks and the UI production build.
4. Run the affected Rust tests and Clippy checks.
5. Check the browser flows for feedback, results, and work sets.
6. Check the native WTS window when native control is available.

## Native inspection status

The normal native control tool fails before it connects. The user approved macOS screenshot and accessibility tools for WTS.

Native inspection verified Option selection, the region image, captured text, and the shared feedback transcript. The original saved draft remained intact.

The Task changes body failed native inspection. Its fix passed both visual inspection and an automated native geometry check.

The geometry check failed with the preceding CSS and passed with the final CSS. Modern Playwright WebKit did not reproduce the original collapse.

See [the verification report](REPORT.md) for test evidence and limits.

## Setup recovery increment

Setup must check for conflicting file paths before Git creates worktrees. If a later step fails, remove only unchanged files from that attempt.

Track file and directory identities. Preserve existing files, edited files, replaced paths, and ignored worktree files. Publish the success receipt last.

Both manual creation and automatic MR creation must require a fresh review after failure. If files remain, provide a read-only path inspection.

Test early and late failures, external files created during checkout, retry after service restart, and incomplete cleanup guidance.

## Durable setup recovery

The app persists an incomplete setup attempt separately from a successful workspace receipt. A retained worktree and branch remain visible after WTS restarts.

Setup review shows confirmed and unconfirmed paths. Cleanup preserves dirty files, ignored files, committed branches, and unknown files. It rechecks state before each action.

Process and filesystem tests cover host termination, cleanup after restart, safe retry, and retained user files. A shared file lock excludes concurrent setup and cleanup.

Blocked preview writes retain the draft and offer Copy draft with main-window guidance. Known previews do not start an edit session.

## Optional later work

Use verified failures to choose each later increment. Keep one clear next action for each recoverable error.

Later work can address cache freshness and a shared record of failed operations. Each feature needs a concrete behavior test.
