# Merge request conversations in Changes

## Overview

The Changes tab shows GitLab conversations for the workspace repositories. The user can read comments and reply to an existing thread. A badge counts unread comments and replies from other users.

## User needs and stories

- As an author, I need review conversations beside my work so that I can answer feedback from WTS.
- As a reviewer, I need general and file discussions so that I can continue the same GitLab conversation.
- As a user, I need a badge for unread replies so that activity remains visible while another workspace tab is active.
- As a user, I need drafts and cached comments during a provider error so that a connection failure does not discard my work.

## Screens and flow

```text
Workspace    Plans    Changes [3]    Verify
                         |
                         v
+---------------------------------------------------------------+
| Repository: nimbus-api             Code | Conversations [3]   |
+---------------------------------------------------------------+
| MR !16: Feature                          [Refresh]             |
+--------------------------+------------------------------------+
| General discussion [1]   | @reviewer                       2h |
| src/api.rs:42 [2]        | Please check the error path.       |
| Resolved discussion      |                                    |
|                          | @author                         1h |
|                          | I added a regression test.         |
|                          |                                    |
|                          | [Write a reply                   ] |
|                          |                  [Reply to GitLab] |
+--------------------------+------------------------------------+
```

1. Open Changes.
2. Select Conversations.
3. Select the merge request and discussion.
4. Read the comments.
5. Select Reply to GitLab to send a reply.

The Conversations view remains available when the local patch is empty or unavailable. Repository selection controls the available merge requests. A selector handles several merge requests for one repository. General discussions show their thread context. File discussions also show the file and line.

## Read state

- The badge counts unread comment content, including replies. The user selected this behavior.
- Existing comments from other users are unread when WTS first observes them.
- Own comments do not increase the badge. System events do not increase it.
- An edited comment becomes unread again. Repeated reads of the same provider snapshot do not increase the count.
- WTS acknowledges only the displayed conversation snapshot while the view and window are visible.
- Selecting Changes alone does not acknowledge hidden conversations.
- Resolved state does not acknowledge unread comments.
- Read markers persist locally by verified host, project, MR, and GitLab account identity.
- Read markers contain comment IDs and content fingerprints. They do not contain comment bodies or credentials.
- A failed storage write retains markers in memory.

## Refresh and errors

WTS checks conversations when the workspace opens, every 60 seconds while visible, and when the window regains focus. A manual refresh checks the selected MR. An in-flight guard prevents overlapping refreshes. An obsolete response cannot change another workspace or account.

The provider returns freshness and truncation separately from the patch. Cached content retains its fetch time and a visible stale state. An incomplete list shows a limit notice. Counts describe the loaded comments when the provider limit applies.

A failed reply retains its draft. WTS sends each reply once and does not retry automatically. A successful reply returns the created note. WTS adds that note to the selected thread without acknowledging other unread replies. A reply completion cannot change a different MR or account.

## Component reuse

- LocalWorkspace owns the background controller and Changes badge.
- RepositoryReviewScreen owns the Code and Conversations views.
- GitlabDiscussionsPanel owns MR selection, discussion selection, and reply drafts.
- The shared discussion body retains the existing safe Markdown rendering.
- useVisiblePolling controls visibility-aware refresh.
- SelectMenu, existing theme tokens, and paired callout attributes keep the current interface patterns.

## Provider and transport

Rust resolves the provider scope from the workspace worktree or verified review target. For an authored MR, Rust checks the tracking remote, project, source branch, and current author. The UI supplies opaque local IDs and a numeric MR IID.

```text
getGitlabDiscussions(repositoryId, iid, workspaceId?)
replyGitlabDiscussion(repositoryId, iid, { discussionId, body, workspaceId? })
```

The read response includes discussions, an opaque account-specific scope ID, viewer login, fetch time, cache state, and truncation. The reply response includes the exact MR, discussion, and created comment. HTTP and Tauri expose the same contract.

The adapter uses the configured glab process without a shell. It validates the thread within the exact MR before a reply. It bounds pagination, output, comment bodies, and the cache. GitLab documents the read and reply operations in the [Discussions API](https://docs.gitlab.com/api/discussions/).

This local feature has no billing or background server job.

## Validation

Automated tests must fail against the preceding behavior. Tests cover the actual UI, serialized transport, trusted service, and provider process boundaries.

- Ordinary workspace MR conversations, including an empty local patch.
- Badge changes while another workspace tab is active.
- New replies without a new commit, repeated snapshots, edits, and own replies.
- Read persistence, storage failure, stale data, and truncated data.
- MR, workspace, repository, and account switches during pending requests.
- Explicit replies, draft retention, and a single provider write.
- Exact HTTP paths, Tauri arguments, protected routes, and malformed payload rejection.
- Trusted project and thread resolution, pagination, account isolation, and bounded provider results.
- Keyboard access, visible focus, theme contrast, and narrow layouts.

An optional integration check uses a test GitLab MR. Read its existing comments in Changes, add a reply in GitLab, and return to WTS. Check the badge and conversation. Send a test reply from WTS only after the tester selects Reply to GitLab.

## Scope

The feature reads conversations and replies to existing threads. It displays GitLab resolution state. Thread resolution, approvals, comment deletion, GitHub conversations, and native notifications remain separate work.
