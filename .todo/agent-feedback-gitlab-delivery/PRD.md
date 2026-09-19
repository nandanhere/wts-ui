# Agent feedback GitLab delivery PRD

## Overview

WTS lets a user publish completed agent work to the source branch of an existing GitLab merge request (MR). The agent still edits only local files. WTS requires a separate review and a user-confirmed push.

The first release supports open, authored, same-project MRs. It does not support fork MRs, automatic commits, force pushes, or provider replies.

## User needs

1. Continue a review thread in a side chat while the agent fixes the local source.
2. Review and commit the agent changes before any remote action.
3. Know the exact local commit, provider head, and source branch before a push.
4. Keep a GitLab reply separate from source publication.
5. Recover safely when the worktree, MR, branch, or network changes.

## User stories

- As an MR author, I want to send a selected thread to an agent so that it can fix the current local source.
- As an MR author, I want WTS to show when the changes still need a commit.
- As an MR author, I want to confirm the exact commit and branch before WTS pushes.
- As an MR author, I want WTS to reject a stale or diverged review instead of pushing another commit.
- As a reviewer, I want the existing reply action to stay independent from local source work.

## Screens and flow

1. Selected conversation — starts the existing agent chat with the verified thread context.
2. Agent feedback chat — shows the result, local changes link, and GitLab update action.
3. Publication check — re-reads the worktree and GitLab MR without a Git mutation.
4. Publication confirmation — shows the exact commit and source branch.
5. Publication result — reports the pushed commit or a specific recovery action.

```text
Selected MR thread
        |
        v
Agent side chat -> local edits -> agent result
        |
        v
Prepare GitLab update
        |
        +-- uncommitted files -> View local changes -> user commits -> check again
        |
        +-- MR or history changed -> stop and refresh
        |
        +-- exact clean commit -> confirmation -> non-force push -> result
```

## ASCII designs

### Completed agent task

```text
+------------------------------------------------------+
| Agent feedback                                       |
|------------------------------------------------------|
| Codex                                                |
| Updated the early return and added a regression test.|
|                                                      |
| [View local changes] [Prepare GitLab update]          |
|                                                      |
| [Ask for another change___________________________]  |
|                                      [Send to agent] |
+------------------------------------------------------+
```

### Changes need a commit

```text
+------------------------------------------------------+
| GitLab update                                        |
| 2 local files still need a commit.                   |
| Review and commit the files before you push.         |
|                                                      |
| [View local changes]                    [Check again] |
+------------------------------------------------------+
```

### Ready to publish

```text
+------------------------------------------------------+
| Push the reviewed commit to GitLab?                  |
| MR       !16                                         |
| Branch   feature/ipxe-guard                          |
| From     a41c9e2                                     |
| Push     c83d10a · 1 commit                          |
|                                                      |
| [Cancel]                               [Push to GitLab]|
+------------------------------------------------------+
```

### Success

```text
+------------------------------------------------------+
| GitLab now has c83d10a on feature/ipxe-guard.        |
|                                                      |
| [Open MR in GitLab]                                  |
+------------------------------------------------------+
```

## States and recovery

| State | Behavior | User action |
| --- | --- | --- |
| Agent active or queued | Disable publication for that workspace | Wait or stop the task |
| Uncommitted files | Make no remote change | Review and commit the files |
| No commits after the MR head | Report that GitLab is current | Continue the review |
| Clean descendant commit | Show the exact preflight | Confirm the push |
| MR head changed | Reject the old digest | Refresh the publication check |
| Diverged history | Make no remote change | Synchronize the branch outside this flow |
| Fork MR | Make no remote change | Use the fork remote outside this release |
| Remote rejects the update | Keep the local commit | Read the error and synchronize |
| Uncertain response | Do not claim success | Check GitLab before a retry |

## Component reuse

- Extend `AgentFeedbackBubble` for the publication check and confirmation.
- Keep `GitlabDiscussionsPanel` as the thread and reply owner.
- Reuse **View local changes** for the commit handoff.
- Reuse the existing browser handoff for **Open MR in GitLab**.
- Reuse the existing Git error mapping for authentication, network, and non-fast-forward failures.

## API and trusted boundary

The publication check accepts only an agent conversation ID. The host loads the saved conversation and its verified GitLab binding. The renderer cannot supply a worktree path, remote, branch, provider head, or local commit.

The host re-fetches the MR and requires all of these facts:

- the MR is open
- the current GitLab user authored the MR
- the source and target projects are the same
- the saved workspace and repository still match the thread
- the local head contains the current provider head
- the worktree has no uncommitted files before publication
- no managed conversation task can still edit the workspace

The check returns the provider head, local head, source branch, commit count, status, and effect digest. The apply request returns only the conversation ID and the reviewed digest.

The host repeats the check before the push. It uses the exact reviewed local commit as the refspec source. It never uses a mutable `HEAD` name and never adds a force option.

## Validation

- A Git boundary test proves that apply pushes the exact reviewed commit to the verified MR source ref.
- A stale-digest test proves that a changed provider or local head causes no push.
- A dirty-worktree test proves that local edits cause no push.
- An identity test rejects a fork, another author, another project, or another thread.
- A UI test proves that preparation has no push side effect and confirmation sends the reviewed digest.
- A UI test proves that uncommitted changes lead to **View local changes** instead of a push action.

## Open questions

1. When WTS adds its reviewed commit flow, should this chat open that review directly?
2. Should WTS offer the same publication action for review workspaces where the user can push to another author's branch?
3. Should a successful push offer a draft GitLab reply that cites the pushed commit?
