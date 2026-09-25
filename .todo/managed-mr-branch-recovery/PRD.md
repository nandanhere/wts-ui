# Managed MR branch recovery

## Status

Agent MR hints now replace manual MR discovery for an unlinked repository.
WTS still checks GitLab before it saves a link. Branch changes and agent
redirection remain deferred. Run the optional integration check in
`docs/how-to-use-wts.md` after the updated app starts.

## Decision

Implement verified MR linking first. Do not switch the managed Senzu branch or move its local changes. A later action can let an agent use the existing MR worktree after a separate review. This is the selected scope, not an open question.

## Problem

WTS finds merge requests (MRs) only for the exact managed worktree branch. Senzu MR !43 uses `review/senzu-complete-flow`, while the managed Senzu worktree uses `wts/local-repositories-jellyfish-e2dfa9a6`. WTS therefore shows **Prepare MR**. The managed worktree has 119 changed paths. Another worktree has the MR branch checked out. A direct branch switch cannot preserve both worktrees safely.

## User needs

1. See an existing MR for the same trusted GitLab project without mistaking a different branch for the managed branch.
2. Link the correct MR to the workspace without changing local files.
3. Move agent work to the MR branch only after an explicit review of worktree and file effects.
4. Preserve local edits, commits, branch refs, agent context, and evidence when a move is blocked.
5. Recover after stale GitLab data, branch movement, or an interrupted operation.

## User stories

- As a developer, I want to select an existing MR so WTS does not offer a duplicate MR.
- As a developer, I want to see which branch an agent will edit before the agent starts.
- As a developer, I want WTS to refuse a branch switch that risks local work.
- As a developer, I want to keep the original worktree when I move work to an MR branch.

## Screens and flows

1. **Repository delivery** shows **Link agent MR !43** when an agent proposes an MR for that repository.
2. **MR selection** uses the numeric hint. WTS checks the trusted GitLab project before it saves a link.
3. **Linked MR** shows the MR status and a clear branch mismatch notice. It does not claim that the local worktree is the MR source.
4. **Branch review** compares both worktrees, local changes, commits, and active agent sessions before a move.
5. **Blocked state** explains the exact blocker and keeps the link available without changing Git.

```text
Senzu · 119 changed paths                       Prepare MR
No MR matches wts/local-repositories-jellyfish-e2dfa9a6.
[Link agent MR !43]
            |
            v
+---------------------------------------------------------+
| Link an existing Senzu MR                            [x] |
| !43 Draft · review/senzu-complete-flow -> develop       |
| This MR uses a different branch.                        |
| [Cancel]                                     [Link MR]    |
+---------------------------------------------------------+
            |
            v
Senzu · MR !43 Draft · Different local branch
[Open MR] [Review branch options]
```

```text
+---------------------------------------------------------+
| Review Senzu branch options                          [x] |
| Managed branch: wts/local-repositories-jellyfish-...    |
| MR branch:      review/senzu-complete-flow               |
| 119 changed paths exist in the managed worktree.        |
| Another worktree already uses the MR branch.            |
| WTS will not switch this worktree.                       |
| [Keep both worktrees]                     [Open MR worktree] |
+---------------------------------------------------------+
```

## Component reuse

Use the repository delivery row, the existing change-request dialog, the alignment review pattern, and the repository notice. Add callout labels to new interactive regions under the UI callout guide.

## API and backend

- Resolve the host and project from the trusted catalog and current worktree. Treat a pasted URL or agent text only as an MR hint.
- Re-fetch an MR by numeric IID from the trusted project. Check its source project, state, author, and branch before a link or agent action.
- Save a workspace-to-repository-to-MR association separately from the exact branch discovery result. Revalidate it on refresh. Show a mismatch when the source branch differs.
- Do not reuse the current exact-branch publication authority for a linked MR on another branch.
- For agent work on the MR branch, prefer the existing worktree that owns the branch after repository and path checks. Do not silently redirect an agent from the managed worktree.
- Any future move needs a preflight digest, a second check under operation locks, a clean-worktree rule, a backup ref, receipt updates, and evidence invalidation. Reject active agents and a branch already checked out in another worktree.
- Never stash, reset, force-checkout, remove a worktree, or move uncommitted files as part of automatic MR discovery.

## First release

1. Let the agent propose MR !43 for the trusted Senzu repository. Let the user link it with one action.
2. Re-fetch the MR from GitLab by its IID. Check its project, source branch, state, and URL.
3. Save the verified link to the workspace and repository. Keep exact-branch discovery separate.
4. Show **MR !43 · Different local branch** instead of **Prepare MR**. Open the verified MR from this row.
5. Show the managed and MR branches. Do not say the managed worktree contains the MR code.
6. Keep the 119 changed paths and both existing worktrees untouched.

The first release does not redirect agents, switch branches, or publish the managed branch to MR !43.

## Validation

- A deterministic service test links an MR with a different branch but the same trusted project and keeps the worktree unchanged.
- A service test rejects an MR from another project, a stale IID, and a forged URL.
- A UI test shows **MR !43** with a branch mismatch instead of **Prepare MR** after a verified link.
- A branch preflight test refuses dirty worktrees, active agents, and a target branch used by another worktree.
- An optional integration check uses disposable GitLab and worktree fixtures. It must not use the live Senzu MR.

## Later release

Add an explicit **Review branch options** action. After the user reviews the target worktree and local changes, allow an agent to work in the existing MR worktree. Do not switch the dirty managed worktree.
