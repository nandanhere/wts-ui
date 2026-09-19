# Review workspace changes

WTS provides a full-screen change review for each repository in a materialized
workspace. The screen keeps review separate from the Workbench. It does not
open as a card or a modal.

## Open the review

1. Open a materialized workspace in the Workbench.
2. Find a repository that has local changes.
3. Select its **Review changes** action.

WTS opens this route:

```text
/sessions/<workspace-id>/changes?repository=<repository-id>
```

Use the back action to return to the Workbench. Use **Open in VS Code** when
you want to work in the generated multi-root workspace instead.

## Review the patch

The **Code** filter is active by default. It hides test files so that the main
implementation path stays visible. Select **Tests** to inspect only tests, or
select **All** to inspect the complete patch.

Select a changed file to move to its patch. Use the unified or split control to
change the patch layout. Line wrapping is optional.

Command-click an identifier on macOS, or Control-click it on other platforms,
to inspect changed references. Select a changed reference to move to that file.
The context rail also shows related changed tests.

## Merge request conversations

Open **Changes → Conversations** to read the GitLab comments for a workspace repository. Select the merge request when the repository has several matches. Conversations remain available when the local diff is empty.

The MR heading shows its title, status, and branches above the Code and Conversations tabs.

Conversations appear as a thread feed. Long automated comments stay collapsed until you select **Show automated comment**.

The Changes badge counts unread comments and replies from other users. Select a conversation to acknowledge its displayed comments. New replies stay unread until you select **Show new replies**. Your own replies do not increase the badge. Read markers persist across WTS restarts.

The badge labels unread comments across the workspace. The unread row names each repository and MR with unread comments. Repository and MR selectors also show unread counts. The Conversations tab count covers the selected MR.

Select an unread link to open its first unread thread. WTS selects the repository, MR, and Conversations view. It shows the thread even when a status filter previously hid it. Keyboard focus moves to the thread heading. Other threads remain unread.

Use **Reply to GitLab** to publish a reply to the selected thread. WTS retains drafts when you change tabs or a request fails. Drafts remain in memory while WTS is open. WTS does not retry a failed reply automatically. If WTS cannot confirm a reply, refresh the conversation before you try again.

WTS checks for new comments every 60 seconds while visible and when the window regains focus. **Refresh conversations** checks the selected MR immediately. Saved comments show a notice when GitLab is unavailable. WTS disables replies until the conversation refresh succeeds. A limit notice identifies partial history, and its counts cover only the loaded comments.

WTS displays open and resolved thread states. Thread resolution remains in GitLab.

## Compare the MR with local work

When a merge request (MR) is open, **Changes → Code** offers three views:

| View | Content |
| --- | --- |
| Latest work | Changes from the MR base to the current local files |
| In the MR | The published MR patch that reviewers see |
| Since the MR | Changes from the published MR head to the current local files |

**Latest work** is the default. Local views include unpushed commits, staged edits, unstaged edits, and new files. The file list also retains published files that a local edit reverts.

Code and Conversations share the selected MR. Select a file, then select **Conversations** in its header to open the file conversations beside the patch. Comments retain their original version, file path, and line. A notice identifies comments from an older or unknown version.

Add inline GitLab comments from **In the MR**. WTS checks the captured MR version before publication. If the MR changes, refresh the comparison before you retry.

If local commits are missing or histories differ, the published MR remains available. WTS explains why it cannot show the local comparison. WTS does not change branches or fetch commits automatically.

## Edit the local file

1. Select **Latest work** or **Since the MR**.
2. Select a file.
3. Select **Edit locally**.
4. Change the content.
5. Select **Save local file**.

The editor opens beside the patch. **Close editor** hides the editor and retains your draft. File conversations and the editor use the same panel, so the patch retains its space.

The editor changes the existing local file. It does not commit or push. **In the MR** keeps the published code read-only.

WTS checks the file revision before each save. If an agent changes the file, WTS retains your draft and offers the newer content for comparison. Inspect the newer content before you retry.

The editor supports regular UTF-8 files up to 2 MiB on macOS and Linux. It rejects binary files, symbolic links, Git metadata, and paths outside the selected worktree. Deleted files need an external editor or a restore operation.

## Return to a workspace

WTS retains workspace details, the selected tab and repository, Plans content, and Changes snapshots in memory. When you return, saved content appears while WTS refreshes it. Requests already in progress serve the returning view.

Source edits, reply drafts, and Plans drafts remain intact during navigation and background refresh. These drafts remain in memory while WTS is open. The cache separates workspaces and client sessions. Workspace and repository removal invalidate the related snapshots.

While Changes is active, local comparisons refresh every 10 seconds. WTS reuses MR comparison metadata for up to 30 seconds. The refresh action requests a new provider snapshot.

## Optional integration check

Use a disposable workspace with an open GitLab MR for this check. Automated tests use temporary repositories and fake provider processes.

1. Add an unpushed commit and a local edit after the MR head.
2. Compare the three views in Changes.
3. Edit a local file while another process changes that file.
4. Check that the stale save retains the draft and offers the newer file.
5. Switch workspaces, then return to check the selected view and draft.

To test publication, publish a reply or inline comment only in the disposable MR. Check the published thread in GitLab.

## Graphify context

The review works without Graphify. In that state, reference navigation and
test suggestions use the changed patch only.

When the workspace has a trusted Graphify snapshot, WTS validates its evidence
digest before it reads graph data. It then:

- keeps nodes that belong to the selected repository.
- returns at most 4,000 nodes and 12,000 links.
- reports when the graph context was truncated.
- uses graph relationships to add repository references and related tests.

Graph results outside the changed patch appear as context. They do not replace
the patch and are not yet direct file-opening actions. Re-index the workspace
from **Workspace actions** when the graph snapshot is missing or stale.

## Trust boundary

The browser sends a workspace ID and repository ID. Rust resolves the trusted
workspace and repository paths. The browser does not send an arbitrary file
path as authority.

The diff and graph responses are bounded. Invalid graph evidence does not
silently become review context. WTS returns the patch without graph context and
keeps the deterministic review available.
