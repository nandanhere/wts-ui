# Review Workspaces PRD

## Overview

Show an assigned code review as compact actionable work in Spaces. A user can prepare a dedicated workspace from the review and can add related repositories before WTS saves or materializes the workspace. A user can also start a safe revised workspace from the repository table when related repositories become necessary later.

The first release supports direct GitLab review requests. GitHub review-workspace creation and automatic related-repository suggestions are deferred.

## User Needs

1. See assigned reviews beside other work that can start.
2. Distinguish an assigned review from a saved WTS workspace.
3. Create an isolated workspace at the merge request source branch.
4. Add related local repositories before creating worktrees.
5. Keep provider URLs and repository paths behind trusted native boundaries.
6. Keep review cards current without requiring manual refresh.
7. See whether an assigned review is open, a draft, commented, or has unresolved discussions.
8. Scan repository work without a redundant verification column.
9. Track an approved merge request until GitLab reports that it merged or closed.
10. Park a review workspace after the user approves its open merge request.

## User Stories

- As a reviewer, I want an assigned merge request in Ready so that I can start it from my normal work queue.
- As a reviewer, I want WTS to reuse a trusted local repository or clone the reviewed project so that setup is short.
- As a reviewer, I want the merge request source branch selected so that the workspace contains the code under review.
- As a reviewer, I want to add related repositories so that I can inspect cross-service behavior.
- As a reviewer, I want the provider review request to remain separate from durable workspace state until I create a workspace.
- As a reviewer, I want My Reviews to retain my approvals so that I can follow delivery after my review ends.
- As a reviewer, I want my review workspace parked after approval so that Ready and Review contain actionable work.

## Information Architecture

The Spaces columns use this order:

1. Ready
2. Review
3. Active
4. Parked

Assigned reviews appear before saved workspace cards in Ready. They are provider tasks, not draggable workspaces. After the user creates a workspace, the saved workspace follows the existing durable workflow.

Ready shows only open reviews that still need the user action. My Reviews also shows approved merge requests. An approved merge request has an `Approved`, `Merged`, or `Closed` status. WTS keeps it until it leaves the bounded GitLab review history.

An automatic review workspace follows the verified review lifecycle:

```text
[Review requested] -> Ready or Review
          |
          | User comments and approves in GitLab
          v
[Approved and open] -> Parked
          |
          +-- merged -> Review
          |
          +-- closed without merge -> Active
```

GitLab approval is the completion signal. WTS does not require a comment because GitLab does not identify the current user's comment in the bounded inbox contract.

## Main Flow

```text
[Background review refresh]
          |
          v
[Ready: assigned review card]
          |
          | Create review workspace
          v
[WTS validates cached host, project, and MR]
          |
          +---- local repository exists ----+
          |                                  |
          +---- clone into trusted root -----+
                                             v
                              [Workspace setup: Repositories]
                                             |
                              [MR repository selected]
                              [MR source branch selected]
                                             |
                              [Add related repositories]
                                             v
                              [Review and save workspace]
```

## ASCII Designs

### Spaces

```text
┌──────────────── Ready · 3 ────────────────┐
│ GITLAB REVIEW              senzu · !36     │
│ Validate the evaluation flow              │
│ By nandan · 3 comments  [Create workspace]│
├───────────────────────────────────────────┤
│ Existing saved workspace card             │
└───────────────────────────────────────────┘

┌──────── Review ────────┐ ┌──── Active ────┐ ┌──── Parked ───┐
│ Saved workspace cards │ │ Saved cards     │ │ Saved cards   │
└────────────────────────┘ └─────────────────┘ └───────────────┘
```

### Repository preparation

```text
┌─────────────────────────────────────────────┐
│ Prepare review workspace                    │
├─────────────────────────────────────────────┤
│ WTS prepares senzu for merge request !36.  │
│                                             │
│ [spinner] Checking the trusted repository…  │
└─────────────────────────────────────────────┘
```

On success, WTS opens the existing New workspace dialog. The Repositories source is selected. The reviewed repository is already in the plan, and its merge request source branch is the selected base. The user can add local repositories or clone another Git URL through the existing controls.

The branch field must use `sourceBranch` from the verified merge request contract. WTS must apply this value before it shows the repository review step. The repository default branch must not replace it.

### Add related repositories later

The Workspace repositories panel has an `Add repositories` action. The action opens the existing revision flow with the current repository set selected. The user can add a discovered local repository or clone a Git URL. WTS saves a separate revised workspace and retains the original materialized workspace. WTS builds the revised workspace graph after materialization.

The repository table contains `Repository`, `Base`, and `Work`. It does not contain a per-repository `Verification` column because verification is a workspace-level activity.

### Failure

```text
┌──────────────── Ready ─────────────────────┐
│ GITLAB REVIEW              senzu · !36     │
│ WTS could not prepare this repository.    │
│                         [Try again]        │
└───────────────────────────────────────────┘
```

## Component Reuse

- Use `WorkspaceBoardDnd` lane shells and `LocalWorkspace.module.css` tokens.
- Add a compact assigned-review card beside `DraggableWorkspaceCard`.
- Use `NewWorkspaceDialog` for repository selection, branch review, runtime analysis, and plan saving.
- Use the existing repository clone implementation. Do not duplicate clone behavior.
- Use `useGithubReviewInbox` as the shared background review controller. Its name can be generalized later.

## Provider and Native Contract

Extend `GitlabReview` with `sourceBranch`, `targetBranch`, bounded `commentCount`, optional `discussionsResolved`, `reviewState`, and `status` from the verified GitLab response.

`reviewState` is `requested` or `approved`. `status` is `open`, `merged`, or `closed`. Rust gets the current GitLab user ID from the trusted `glab` session. Rust uses the bounded `reviewer_username` and `approved_by_ids[]` queries. The WebView must not supply the user ID or approval state.

Add this operation:

```text
prepareGitlabReviewRepository(repositoryId, iid)
  -> CloneRepositoryResult
```

The UI supplies only the opaque review repository ID and MR IID. Rust must resolve the exact pair from the current in-memory review cache. The cache key must contain both values so that several assigned reviews from one repository remain actionable. Rust must reject an unknown ID, a mismatched IID, a stale target, an invalid origin, or a target outside a trusted authenticated GitLab host. Rust then reuses the existing catalog repository or clones the validated origin into the configured trusted repository root.

The response can include the normal repository summary. It must not include the cached provider MR URL, access tokens, commands, or credential data.

## Background Behavior

- Load assigned reviews when WTS starts.
- Refresh every 60 seconds while WTS is open.
- Refresh when WTS regains focus.
- Preserve the last safe inbox during a transient failure.
- Remove a pending review card from Ready after GitLab reports the user approval.
- Retain the item in My Reviews while it remains in the bounded GitLab review history.
- Show the current `Approved`, `Merged`, or `Closed` state from fresh provider data.
- Match a saved review workspace by its generated review label, pinned repository ID, MR IID, and source branch.
- Move an automatically placed review workspace to Parked after a fresh approval result.
- Do not move a pinned workspace automatically.

## Security and Privacy

- Treat provider data as untrusted until Rust validates it.
- Do not accept a clone URL from the review card.
- Resolve the clone origin only from the exact cached review target.
- Use the configured Git credential helper or SSH agent. WTS must not store credentials.
- Keep repository writes behind the explicit Create review workspace action.
- Keep clone operations bounded and serialized through the existing repository clone lock.

## Validation

- Verify the board order is Ready, Review, Active, Parked.
- Verify a fresh assigned GitLab review appears in Ready.
- Verify an approved GitLab review does not appear in Ready.
- Verify My Reviews shows an approved open merge request.
- Verify My Reviews updates an approved merge request to Merged or Closed.
- Verify an approved open MR moves the exact matching review workspace to Parked.
- Verify a different repository ID or source branch cannot move a workspace.
- Verify a pending review cannot move a workspace to Parked.
- Verify the Ready count includes assigned reviews.
- Verify the review card is not draggable.
- Verify the action calls the opaque prepare operation and opens workspace setup with the returned repository and source branch.
- Verify the selected source branch differs from the repository default branch in the behavior test.
- Verify two reviews from one repository retain separate trusted preparation targets.
- Verify comment and discussion metadata selects the visible card tone.
- Verify the existing repository controls can add another repository.
- Verify `Add repositories` in the repository table opens a revision with the current repositories.
- Verify the repository table does not show a Verification column.
- Verify malformed provider URLs and mismatched review IDs cannot prepare or clone a repository.
- Verify loading and failure states remain visible and retryable.

## Deferred Scope

- GitHub pull-request workspace creation.
- Fork merge requests whose source branch is not present on the target-project remote.
- Automatic related-repository recommendations from dependency graphs, code search, work items, or runtime manifests.
- Durable relationships between one review workspace and several provider reviews.
- Automatic comment publishing or review submission from WTS.
- Billing. This local desktop feature has no billing behavior.
