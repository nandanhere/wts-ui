# Navigation and recovery audit

All edits remain local. Tests use fake clients and temporary browser state. No test called a real provider or removed a user workspace.

## Navigation and saved state

| Defect | Current behavior | Regression evidence |
| --- | --- | --- |
| A pending planning Save replaced newer text. A return to Plans could retain an old digest. | Save retains later text, advances its expected digest, and reaches a panel that returns before the acknowledgment. | PlanningDocumentsPanel.test.tsx:699 covers stay, leave, and early return. Red: /tmp/wts-polish-planning-save-red.log and /tmp/wts-polish-planning-save-remount-red.log. Green: /tmp/wts-polish-planning-save-green.log, 44 tests. |
| Tabs shared scroll position, then lost it after Spaces navigation. | The client, workspace, and tab each have a scroll record. Removal clears that workspace's records. | LocalWorkspaceCache.test.tsx:65. Red: /tmp/wts-polish-workspace-scroll-red.log. Browser baseline also lost 180px: /tmp/wts-polish-before-boundaries.log. The same browser test passes on current source: /tmp/wts-polish-after-boundaries.log. It restores 180px after both returns. |
| Navigation announced absent setup before the materialization read finished and accumulated successful-read notices. | Navigation uses the page's loading state and keeps error or mutation notices. | LocalWorkspaceCache.test.tsx:49. Red: /tmp/wts-polish-navigation-notices-red.log. |
| A failed earlier board move caused a registry refresh to select another workspace. | A registry refresh keeps the current workspace when it still exists. | LocalWorkspaceCache.test.tsx:32. Red: /tmp/wts-polish-navigation-selection-red.log. |
| A pending rename left the old name editor visible in another workspace. Its result could close a new edit. | Rename responses update their workspace record and affect only the matching edit. | LocalWorkspaceCache.test.tsx:10. Red: /tmp/wts-polish-navigation-rename-red.log. |

Navigation validation: /tmp/wts-polish-workspace-navigation-final.log contains 81 passes and one old test assumption about navigation notices. The corrected clipboard test passed in /tmp/wts-polish-workspace-copy-green.log. TypeScript and git diff --check passed.

## Recovery paths

| Area | Finding and change | Validation |
| --- | --- | --- |
| GitLab integration | A slow check for a previous workspace or client replaced the current account. Responses now require the current request generation. A scope change clears the old status. | GitlabIntegrationCard.test.tsx:9 covers both identities. Red: /tmp/wts-polish-recovery-races-red.log. Final green: /tmp/wts-polish-recovery-races-final.log. |
| Agent sessions | A slow automatic read allowed further polls and manual refreshes to overlap. Old responses could restore obsolete session state. Those reads now share one pending request per client generation. | AgentSessionsPanel.test.tsx:124 advances timers and uses the visible Refresh sessions button. It proves request sharing, completion, and later polling. Same red and green logs as GitLab. |
| Verification graph | A graph build that finished after a workspace switch invoked the previous workspace loader or showed its error. Its continuation now requires the original workspace scope. | VerificationPanel.test.tsx:942 covers success and failure. Red: /tmp/wts-polish-verification-scope-red.log. |
| Verification proposed check | A late acceptance replaced the new workspace's evidence with the previous workspace's checks. It now requires the original workspace scope. | VerificationPanel.test.tsx:972 checks the visible current check after the old request finishes. Same Verification red log. |

Final recovery gates:

- /tmp/wts-polish-recovery-races-final.log: 26 passes, GitLab integration 7 and agent sessions 19.
- /tmp/wts-polish-recovery-final.log: 56 passes, Verification 33, My Reviews 11, removal dialog 6, shell recovery 6.
- /tmp/wts-polish-recovery-types-final.log: final TypeScript check.
- git diff --check passed.

Existing behavior checked in this pass includes failed progress-read retries, rejected verification cancellation, completed-run precedence, manual session refresh, Jira-only retry with retained assignments, and clipboard fallback. Review tests cover one-provider failure, saved rows after a background failure, authentication routes, and explicit refresh. Removal tests cover blocked-path guidance, manual copy fallback, failed registration retry, fresh confirmation after registration, and routes to Plans or integrations. No new removal or review defect was reproduced in this bounded pass.

Limits: the checks use deterministic UI boundaries. They do not certify provider availability, native focus behavior, or all runtime scroll geometry. Browser geometry validation is separate. The UI package has no lint script. An ad-hoc ESLint run inherited the root Next.js configuration and reported existing React compiler rules. It is not a clean gate for this Vite package, and this pass did not change that configuration.
