# GitLab Review in Workspace PRD

## Overview

WTS loads the verified GitLab merge request patch inside a review workspace.
The user can inspect the patch and publish a comment through the configured
`glab` session.

This local desktop feature has no billing behavior.

## User Needs

1. The user needs the MR patch before local analysis starts.
2. The user needs to review the MR without leaving the workspace.
3. The user needs a clear action that publishes a comment to GitLab.
4. The user needs WTS to keep provider credentials and URLs outside the UI.

## User Stories

- As a reviewer, I want WTS to load the MR patch so that I can review the
  provider changes.
- As a reviewer, I want to select a changed line so that my comment includes
  useful file and line context.
- As a reviewer, I want an explicit publish action so that WTS does not send a
  draft comment by mistake.
- As a reviewer, I want the same comment in GitLab so that other reviewers can
  see it.

## Screens and Flow

```text
[Review request]
       |
       v
[Create review workspace] -- WTS loads the MR patch before setup analysis
       |
       v
[Workspace > Changes] -- provider patch, files, hunks, and graph context
       |
       +--> [Select changed line]
                 |
                 v
          [Write comment] -- [Publish to GitLab]
                 |
                 +--> success: comment is visible in GitLab
                 +--> error: draft stays in WTS and the user can retry
```

### Changes view

```text
┌──────────────────────────────────────────────────────────────┐
│ Changes   obx-api                     GitLab MR !9 · Open     │
├───────────────┬──────────────────────────────┬───────────────┤
│ Files         │ Patch                        │ Review context│
│ src/query.go  │  41  if offset < 0 {        │ src/query.go  │
│ tests/...     │ +42    return error          │ +42           │
│               │  43  }                      │               │
│               │                              │ [Comment...]  │
│               │                              │ [Publish]     │
└───────────────┴──────────────────────────────┴───────────────┘
```

## States

- Loading: `WTS loads the GitLab patch.`
- Ready: Show the provider patch in the existing repository patch viewer.
- Empty: `This merge request has no text changes.`
- Error: Keep the workspace available and show `Try again`.
- Publishing: Disable the publish action and retain the draft.
- Published: Clear the draft and show `Comment published to GitLab.`
- Publish error: Retain the draft and show a retryable error.

## Component Reuse

- Reuse `RepositoryReviewScreen` for the Changes screen.
- Reuse `RepositoryPatchViewer` for files, hunks, search, and graph context.
- Extend `CodeReviewFeedbackPanel` with a GitLab publish mode.
- Keep local review threads for agent feedback. Do not present a local thread as
  a GitLab comment.

## Provider and Native Contract

The UI supplies only an opaque repository ID, an MR IID, and bounded comment
content. Rust resolves the MR from the verified review cache.

```text
getGitlabReviewPatch(repositoryId, iid)
  -> { repositoryId, iid, baseCommitOid, headCommitOid, patch, patchTruncated }

publishGitlabReviewComment(repositoryId, iid, request)
  -> { repositoryId, iid, accepted }
```

The comment request can contain a verified changed-line target. Rust formats
the target as comment context. The first release publishes a general MR note.
Inline GitLab discussion positions and discussion resolution are deferred.

Rust must use the configured `glab` executable. Rust must not use a shell.
Rust must validate the cached host and project for every request. The UI must
not receive a provider URL, token, executable path, or command.

## Prefetch

- Load the patch when WTS prepares the review repository.
- Cache the bounded patch by repository ID, MR IID, and provider head SHA.
- Load the cached patch when the user opens the review workspace Changes tab.
- Retry the provider read when the user selects `Try again`.
- Do not block workspace creation if patch prefetch fails.

## Validation

- Verify that WTS rejects an unknown repository ID or MR IID.
- Verify that WTS builds a bounded patch from provider change records.
- Verify that comment text does not enter a shell.
- Verify that the UI uses the provider patch for the matching review workspace.
- Verify that the publish action retains a failed draft.
- Verify that a successful publish clears the draft.
- Verify that ordinary workspaces still use the local repository diff.

## Deferred Scope

- Inline GitLab discussions with provider position objects.
- Reply and resolve actions for provider discussions.
- GitHub pull request comments.
- Cross-provider review threads.
