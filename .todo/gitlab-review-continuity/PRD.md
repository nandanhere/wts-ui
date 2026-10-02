# GitLab Review Continuity PRD

## Overview

WTS tracks the exact GitLab merge request head that the user approved. A new
head makes the review actionable again. A review workspace can open the live
merge request patch and publish a comment through the configured `glab`
session.

This local desktop feature has no billing behavior.

## User Needs

1. The user needs to know when an author pushes changes after an approval.
2. The user needs the changed merge request to return to the work queue.
3. The user needs a direct path from a review workspace to the provider patch.
4. The user needs to publish an explicit comment from the Changes screen.

## User Stories

- As a reviewer, I want WTS to remember the approved head so that a new commit
  does not remain hidden behind an old approval.
- As a reviewer, I want a changed review in Ready so that I can act on it.
- As a reviewer, I want my existing review workspace in Review so that I can
  continue the same task.
- As a reviewer, I want to open MR changes from Workspace content so that I do
  not need to find the Changes tab first.
- As a reviewer, I want to select a changed line and publish a comment so that
  GitLab contains the review feedback.

## Flow

```text
[GitLab review is approved at head A]
                  |
                  v
           [WTS stores head A]
                  |
          author pushes head B
                  |
                  v
 [Ready: New changes after approval]
                  |
       +----------+-----------+
       |                      |
       v                      v
[Review workspace]     [Open merge request]
       |
       v
[Workspace content: MR !9 - Review changes]
       |
       v
[Changes: provider patch]
       |
       v
[Select changed line] -> [Write comment] -> [Publish to GitLab]
```

## Workspace Content

```text
+-------------------------------------------------------------+
| REPOSITORIES                                                |
| obx-api    SRETOOLS-6349    Clean   MR !9 - Review changes  |
+-------------------------------------------------------------+
```

The review link opens the Changes tab and selects the matching repository.
The link remains available when the local worktree is clean.

## Changes

```text
+-------------------------------------------------------------+
| obx-api changes     MR !9 - New changes after approval      |
| Select a changed line to comment in GitLab.                  |
+----------------+-------------------------+------------------+
| Files          | Patch                   | Review comment   |
| src/query.go   | + return error          | [Comment       ] |
|                |                         | [Publish]        |
+----------------+-------------------------+------------------+
```

The user must select an added or deleted line before WTS shows the composer.
WTS publishes only after the user selects **Publish to GitLab**.

## State Rules

- WTS refreshes reviews at startup, every 60 seconds, and when WTS regains
  focus.
- WTS records the verified head when GitLab reports the user approval.
- WTS checks the newest bounded GitLab approval or commit system event for an
  approved open merge request.
- A different open head has the state `changesAfterApproval`.
- A review without a workspace appears in Ready.
- A matching review workspace moves from Parked to Review.
- A merged or closed merge request keeps its provider lifecycle state.
- Stale provider data cannot change a workspace lane.

## Contracts

Extend `GitlabReview` with the optional verified `headCommitOid` field. Rust
gets this value from the GitLab merge request response. The WebView cannot
supply it.

The UI stores only the merge request ID, the last approved head, and the last
head that GitLab returned as requested. It does not store a token, URL, patch,
comment, or provider response.

Existing trusted operations remain unchanged:

```text
getGitlabReviewPatch(repositoryId, iid)
publishGitlabReviewComment(repositoryId, iid, request)
openGitlabMergeRequest(repositoryId, iid)
```

## Component Reuse

- Reuse `WorkspaceOverview` and its repository table.
- Reuse `RepositoryReviewScreen` for the Changes screen.
- Reuse `RepositoryPatchViewer` for file and line selection.
- Reuse `CodeReviewFeedbackPanel` for the explicit GitLab publish action.
- Reuse the shared background review controller.

## Validation

- Verify that the GitLab adapter returns a validated head commit OID.
- Verify that a new head after approval becomes `changesAfterApproval`.
- Verify that a requested new head can become the new approved baseline.
- Verify that a changed review appears in Ready.
- Verify that a matching Parked review workspace moves to Review.
- Verify that Workspace content opens the provider patch in Changes.
- Verify that Changes explains how to publish a GitLab comment.
- Verify that the existing comment transport retains a failed draft.

## Deferred Scope

- GitHub review continuity.
- Provider inline discussions and replies.
- Approval submission from WTS.
- Automatic related-repository selection.
