# MR and local changes

## Status

Implemented locally. The feature covers local source editing and MR conversations. MR title and description editing remain outside this scope.

## Need

An open MR represents the published code. An agent can add commits and local edits after that publication. The user needs both versions beside the review conversations.

As an author, I need to inspect the published MR, change the latest local file, and check my response to each comment. As a reviewer, I need the original comment context when the local file changes.

## Implemented view

Changes retains Code and Conversations under the MR title, status, and branches. Code contains a searchable file list and a full-height patch. The file header opens the local editor or file conversations when needed. Conversations uses a thread feed with replies beneath each thread. Long automated comments stay collapsed by default.

```text
MR title                           MR !16 Open
Code | Conversations
View: Latest work v               Refresh
+-------------------+----------------------+--------------------+
| Find file         | Selected file        | Optional panel     |
| api.rs            | Edit | Conversations | Local editor       |
| internal/api      |                      | OR                 |
|                   | Selected patch       | File conversations |
| retry.rs        M |                      | Original MR lines  |
| internal/client   |                      | Reply to GitLab    |
+-------------------+----------------------+--------------------+
```

| View | Comparison | Purpose |
| --- | --- | --- |
| Latest work | MR base to the current local files | Default view of the complete result |
| In the MR | MR base to the published MR head | Code that reviewers currently see |
| Since the MR | Published MR head to the current local files | Changes added after the last publication |

Since the MR includes unpushed commits, staged edits, unstaged edits, and new files. Latest work and Since the MR use a validated local snapshot. MR references come from one provider snapshot.

File rows show the file name and parent folder. A status mark identifies local changes. The full path and comparison category remain available in the row label. A local reversal remains available from the MR file list.

## Editing and conversations

1. Select a file or MR conversation.
2. Inspect the original MR lines beside the latest local code.
3. Select Edit locally to change the current file.
4. Save the local file.
5. Inspect Since the MR to check the change.

Editing always targets the latest local file. The published MR snapshot stays read-only. A save must reject a stale file revision when the agent changes the same file. The user can then compare and reload the newer content.

Replies use the existing GitLab conversation. Existing comments keep their original MR version, path, and line context. WTS maps a comment to local lines only when that mapping is reliable. Otherwise, it shows the original context with a changed-code notice.

Inline comments are available only in In the MR. Each publication checks the captured MR version and workspace scope before it sends the comment.

Saving a file does not commit or push. After an explicit push and refresh, the published MR head advances and Since the MR updates.

## States

- With no newer changes, Since the MR explains that local work matches the published version.
- With no MR, the current local Changes view remains available.
- During refresh, the view retains the displayed comparison and its version.
- When GitLab is unavailable, the MR snapshot shows its saved state. Local file inspection remains available.
- When local history differs from the published MR, WTS shows both states separately and explains the comparison limit.
- Missing commits, deleted files, renames, binary files, and truncated patches need explicit states.
- A newer MR version or agent edit must not replace an active edit or draft silently.

## Caching

Workspace navigation retains the selected tab, repository, and cached content. Background requests refresh that content without a blank reload. Concurrent reads share one request where applicable.

Caches separate clients and workspace scopes. Mutation generations prevent an old response from replacing a newer save. Dirty drafts survive navigation and refresh. Memory limits apply to cached snapshots and draft capacity.

Local comparisons refresh every 10 seconds while active. Provider comparison snapshots expire after 30 seconds. Manual refresh bypasses the provider cache.

## Implementation boundaries

One provider response supplies the published patch and MR references. The service checks the trusted project and recorded workspace branch before comparison.

Local source saves require an expected content revision. The service permits existing regular UTF-8 files up to 2 MiB on macOS and Linux. It rejects symbolic links, Git metadata, and paths outside the worktree.

The editor retains the draft after a stale save. It shows newer local content for comparison. Saves do not commit or push.

## Validation

Tests exercise filesystem effects, provider process requests, HTTP and native contracts, rendered diffs, and workspace navigation.

- Create an MR snapshot, then add a local commit, tracked edits, and a new file. Check all three comparisons.
- Edit a file already in the MR. Check the saved content and the unchanged published snapshot.
- Let an agent change the file during an edit. Check that a stale save cannot overwrite it.
- Move, rename, or delete commented lines. Check original context and conservative local mapping.
- Advance or rewrite the MR head. Check comparison refresh and draft retention.
- Check unavailable GitLab data, missing commits, and differing histories.
