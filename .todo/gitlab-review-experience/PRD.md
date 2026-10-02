# GitLab Review Experience PRD

## Overview

WTS reuses one workspace for each GitLab merge request. The workspace makes code review the primary task, supports commit navigation, and publishes inline GitLab discussions from selected changed lines.

## User Needs

1. Open an existing review workspace instead of creating a duplicate.
2. See that a workspace needs code review from Workspace content.
3. Review the complete merge request or one commit at a time.
4. Select a changed line and publish an inline GitLab discussion.
5. Return to Review when GitLab adds changes after approval.
6. Reopen the last complete merge request changes without a network connection.
7. Read existing GitLab discussion threads beside the review composer.

## User Stories

- As a reviewer, I want one workspace for one merge request so that review context does not split across duplicate workspaces.
- As a reviewer, I want Workspace content to show the pending review action so that I can start the correct task.
- As a reviewer, I want to select a commit so that I can understand an incremental update.
- As a reviewer, I want a visible line-comment action so that I can publish feedback without guessing the interaction.
- As a reviewer, I want a saved offline copy so that a network interruption does not stop code reading.
- As a reviewer, I want existing discussion replies in WTS so that review context does not split between WTS and GitLab.

## Screens and Flows

1. Ready review card: create a workspace only when no matching workspace exists.
2. Existing review workspace: open the matching workspace in Changes.
3. Workspace content: show a compact review callout with the MR state and a Review changes action.
4. Changes: show All changes, bounded commit choices, and Check for new commits.
5. Changed line: show a comment bubble in the number gutter. Open the Feedback panel and focus the comment field when the user selects it.
6. Published comment: create an inline GitLab discussion for the current MR diff.
7. Offline review: show the saved full-MR patch, commit history, and saved-state label. Keep provider mutations unavailable.
8. Existing feedback: show bounded GitLab discussion threads, authors, line anchors, and resolved state in the Feedback panel.

## ASCII Designs

```text
Ready
┌ Review acme/api · MR !17 ─────────────────────┐
│ Review requested                    [folder +] │
└───────────────────────────────────────────────┘
        │ no workspace                 │ existing workspace
        v                              v
 Create workspace                Open workspace > Changes
```

```text
Workspace content
┌ Review requested · GitLab MR !17 ───────────────────────────┐
│ Bob requested your review. The MR has 3 commits.            │
│                                      [Review changes →]      │
└──────────────────────────────────────────────────────────────┘
```

```text
Changes
┌ acme/api · MR !17 ── [All changes v] [Check new commits] ──┐
│ Point to a changed line, then select its comment bubble.    │
├ files ────────────────┬ diff ───────────────────┬ Feedback ─┤
│ src/log.ts            │ (comment) +42 message  │ src/log:42│
│                       │   [selected line]       │ [comment] │
│                       │                         │ [Publish] │
└───────────────────────┴─────────────────────────┴────────────┘
```

## Component Reuse

- Reuse `AssignedReviewCard` for an unmatched review request.
- Reuse `DraftOverviewPanel` for the Workspace content review callout.
- Reuse `RepositoryReviewScreen` and `RepositoryPatchViewer` for all changes and commit patches.
- Reuse `CodeReviewFeedbackPanel` for the focused inline comment composer.

## API and Backend

- Extend `GitlabReviewPatch` with a bounded commit list and the selected commit identity.
- Include at most 100 validated GitLab discussions and 200 comments in the saved patch contract.
- Let `get_gitlab_review_patch` accept an optional verified commit OID.
- Verify that a selected commit belongs to the trusted merge request before WTS fetches its diff.
- Publish positional comments through the GitLab discussions API with trusted MR diff refs.
- Keep repository origins, provider URLs, credentials, and command details outside the WebView contract.
- Limit commit history to 50 items and provider output to the existing command bound.
- Save at most 64 validated provider patches in one bounded app-data file.
- Use atomic replacement and reject non-regular cache paths.
- Do not store credentials, provider URLs, or command data in the review cache.
- Return saved data when GitLab is unavailable. Mark saved data in the WebView contract.

Billing does not apply to this local provider flow.

## States

- No workspace: show the compact Ready request card.
- Workspace exists: hide the request card and show the workspace once.
- Review requested: move an automatic review workspace to Review.
- New changes after approval: move an automatic review workspace to Review.
- Approved and open: move an automatic review workspace to Parked.
- Commit load error: retain the last patch and offer Try again.
- Comment error: retain the draft and show the provider error.
- Saved offline copy: show the full merge request changes, commit history, and saved discussion threads. Disable commit switching until GitLab reconnects.

## Validation

- A matching workspace suppresses the duplicate request card.
- The start-review action opens the existing workspace Changes tab.
- Selecting a changed line opens and focuses the comment composer.
- A selected commit uses only an OID returned by the trusted MR commit list.
- A line comment uses the GitLab discussions endpoint and exact diff refs.
- Existing non-system GitLab discussions appear with their authors, anchors, and resolved state.
- A provider publishing failure does not appear as an unsupported repository origin.
- The full MR patch remains the default.
- A forced refresh bypasses the process cache and reports a changed provider head.
- A new adapter process can reopen a bounded saved patch when the provider command fails.
