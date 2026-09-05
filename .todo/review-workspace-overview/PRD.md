# Review Workspace Overview PRD

## Overview

Use a review-specific overview for workspaces that WTS created from a GitLab merge request. Show the merge request result and the next review action before local workspace details.

## User Needs

1. See the current merge request result immediately.
2. Know whether the review needs another action.
3. Open the merge request in GitLab.
4. Review local changes without searching through workspace controls.
5. See issue and repository context that relates to the review.

## User Stories

- As a reviewer, I want to distinguish an approved merge request from a merged merge request.
- As a reviewer, I want to see new commits that arrive after my approval.
- As a reviewer, I want to open GitLab or local changes from the review summary.
- As a reviewer, I do not want setup facts or agent controls on a completed review.
- As a reviewer, I want WTS to show Jira keys that it can detect in merge request metadata.

## Screen and Flow

The Review tab replaces the generic Workspace tab for a matched GitLab review workspace.

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Review  Plans  Changes  Verify                                      │
├──────────────────────────────────────────────────────────────────────┤
│ GITLAB MR !22                                      MERGED            │
│ Fix health endpoint fallback                                         │
│ GitLab merged this change. No review action remains.                 │
│ sre-tools/ppxe-verify · vikram.kangotra                              │
│                                   [Open in GitLab] [View changes]     │
├──────────────────────────────────────────────────────────────────────┤
│ Linked work                                                          │
│ SRETOOLS-6349 · From merge request metadata                           │
├──────────────────────────────────────────────────────────────────────┤
│ Review scope                                                         │
│ ppxe-verify   fix/health-endpoint-fallback → main   62 changed files │
│                                                    [View changes]     │
└──────────────────────────────────────────────────────────────────────┘
```

## State Text

- Requested: `GitLab requests your review.`
- Draft: `This merge request is a draft.`
- Approved: `Your approval is recorded. GitLab has not merged this change.`
- New changes: `The author added commits after your approval.`
- Merged: `GitLab merged this change. No review action remains.`
- Closed: `GitLab closed this change. No review action remains.`

## Component Reuse

- Use the trusted `openGitlabMergeRequest` client action.
- Use `RepositoryReviewScreen` for local change review.
- Keep the existing workspace actions menu for maintenance actions.
- Keep the existing repository and setup panels for non-review workspaces.

## API and Data

The GitLab review contract includes the title, source branch, target branch, author, review state, and merge state. It does not include the merge request description or GitLab-linked issues.

WTS can detect Jira-style keys in the title and source branch. The interface must identify this context as detected metadata. WTS must not save an issue link without the existing Jira validation and confirmation flow.

## States

- If full review metadata is available, show the review result, author, branches, and detected Jira keys.
- If only the saved merge request identity is available, show the repository and merge request number.
- If no Jira key is detected, omit the linked-work section.
- Do not show workspace facts, the generic work-items panel, or agent sessions on the review overview.

## Validation

- Verify the exact merged, closed, approved, requested, draft, and new-change messages.
- Verify that review workspaces omit workspace facts and agent sessions.
- Verify that the GitLab action uses the trusted client boundary.
- Verify that Jira key detection does not save a work-item link.

## Open Questions

- Add GitLab-linked issue references when the integration contract provides them.
- Add a compact validated Jira preview when the product defines an explicit link action.
