# Review, feedback, and Plans coverage

The assigned source is stable. All seven full-app visual checks pass. The quality reviewer owns the final timing measurements.

## Completed changes

| Surface | Result | Evidence |
| --- | --- | --- |
| Shared comment and agent Markdown | JSX, generic types, HTML examples, and blank lines remain intact inside code. Raw HTML does not execute. | `GitlabDiscussionBody.test.tsx`: two code-preservation cases failed before the fix. All three now pass. The related group passed 48 tests. |
| MR conversation feed | Explicit Reply focuses its field. Cached freshness guidance stays in the toolbar. Only Reply to GitLab has primary weight. Metadata uses 12px text. | `GitlabDiscussionsPanel.test.tsx`: focus failed before the fix. All 32 tests pass. The full-app baseline showed a 76px shift when cached notices disappeared. The current full-app geometry check passes. |
| MR file list | Local changes use a truthful Local marker. A modified tracked file no longer appears as an added file. | `MergeRequestWorkingChanges.test.tsx`: the new rendered-label and file-selection case failed before the fix. All 14 tests pass. |
| Local diff | Each file has one WTS heading. The real diff renderer uses WTS surfaces. Collapse, search, navigation, and line comments remain available. | `RepositoryPatchViewerRendering.test.tsx`: the ordinary-mode case failed before the fix. All 31 related tests pass. |
| Agent feedback | One transcript and composer remain. Each user state appears once. Queue actions are compact. Results use 14px text. Edit focuses its queued field. Escape closes Saved drafts before the chat. | The new status and keyboard cases failed before the fixes. All 60 feedback tests pass. Six browser cases passed after the visual changes. Later focus changes passed the behavior tests. |
| Plans | Controls and guidance use at least 12px text. Feedback uses 13px text. Narrow file rows cannot overlap. The filename has a separate toolbar row. | Baseline screenshots show overlapping file targets and a compressed filename. Full-app geometry and typography checks pass. Keyboard End reveals the last file in the horizontal list. The separate save-state fix remains intact. |

| Plans imported description | A matching Jira JSON envelope displays decoded Markdown in Preview. Source, Edit, the digest, and feedback lines remain unchanged. Unknown, mismatched, and fenced content stays intact. | Two rendered paragraph/list cases failed before the fix. All 61 panel and parser tests pass. |
| Help | Escape and Close return focus to the opener. New workspace keeps focus in the new dialog. Current Actions and workspace-tab guidance replaces old copy. | Two focus cases failed before the fix. All three Guide tests pass. |
| App updates | Late download progress cannot replace the ready state or hide Relaunch. | The late-event case failed before the fix. All eight update tests pass. |

## Feedback state audit

Normal and empty views have one composer and an explicit send action. New UI and MR contexts preserve other drafts.

Failed results show the exact cause before collapsed progress and unverified output. Retry uses the original conversation and stable request identity. It preserves unrelated text.

Disconnected reads retain the transcript and drafts. Uncertain sends and queued changes retain their identities. Reload checks receipts and does not send work.

Active work permits a separate queued request. Edit and Cancel use the row's original conversation. A dispatch conflict retains the edit. Stop affects the active task.

Keyboard context selection, focus return, reply focus, and Saved drafts dismissal have behavior tests. Physical repeated-click checks cover immediate replies, uncertain retries, and queue cancellation.

## Logs and limits

Logs use the `/tmp/wts-polish-` prefix: `markdown-red`, `markdown-green`, `reply-focus-red`, `discussions-green`, `local-marker-red`, `local-marker-green`, `diff-heading-red`, `diff-heading-green`, `feedback-red`, `feedback-keyboard-red`, `feedback-keyboard-green`, and `feedback-browser`.

Guide and update evidence is in `/tmp/wts-polish-guide-updates-{red,green}.log`. Jira preview evidence is in `/tmp/wts-polish-jira-preview-{red,green}.log`.

Typecheck passed. The diff whitespace check passed. Feedback screenshots are in `/tmp/wts-polish-feedback-screenshots`.

This pass used fake transports and local browser fixtures. It did not send live agent work or GitLab comments. Native window behavior and live provider availability remain separate checks.

The current narrow Plans screenshot is `/tmp/wts-product-polish-after-browser/product-polish-narrow-keyboard-navigation-and-reduced-motion-chromium/04-narrow-plans.png`. The filename and actions are separate. File targets do not overlap.

The command palette already focuses its search field and returns focus to the opener. Its empty result state keeps search available. Disabled commands cannot run through Enter. Existing navigation tests cover search and the VS Code action. No command-palette code changed in this scope.

Imported descriptions support strings and explicit null or blank values. Unknown document objects, including Atlassian document format, remain raw. The preview does not write files. The backend reviewer owns extraction for newly created planning files.

## Final narrow MR adjustment

At 375×640, the baseline comparison toolbar started at 452px and no code was visible. The MR header now omits a selector with one choice. Multiple MR and repository choices remain available. Unread links use one horizontal row. The shorter file rail keeps search and file selection available. The diff toolbar uses one horizontal scroll row on narrow screens.

A new single-MR case failed before the change. All 36 screen and comparison cases now pass, including exact unread routing and restored MR selection. Typecheck and the diff check pass. The real browser now shows 93px of code at 375×640. The comparison toolbar starts at 343px. Exact unread routing, horizontal file selection, and retained reply drafts pass.

Evidence: `/tmp/wts-polish-narrow-mr-red.log`, `/tmp/wts-polish-narrow-mr-green.log`, and `/tmp/wts-polish-narrow-mr-typecheck.log`.
