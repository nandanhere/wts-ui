# Agent-assisted commit flow PRD

## Overview

WTS lets an agent propose a local commit after it finishes meaningful work.
WTS owns the exact Git state, verification facts, review digest, and commit effect.
The user reviews and creates each commit.

This flow is part of the existing repository change review. It is not a new
workbench destination. It does not push a branch or create a merge request.

## Product principles

1. The agent proposes. WTS verifies. The user commits.
2. WTS never presents agent text as trusted Git or verification evidence.
3. WTS creates one commit in one repository at a time.
4. WTS never opens the commit dialog without a user action.
5. WTS rejects a stale review instead of committing changed content.
6. WTS keeps remote push and merge request creation in a separate flow.

## User needs

1. Move completed agent work into clear local Git history.
2. Review the exact content that the next commit will contain.
3. Use the agent's understanding without trusting it as machine evidence.
4. See verification results before the commit.
5. Revise the changes or message with the agent when the proposal is not ready.
6. Preserve repository scope, local work, and existing Git state.
7. Understand what WTS did after the commit.

## User stories

- As a developer, I want an agent to prepare a commit proposal after it finishes.
- As a developer, I want WTS to show the exact uncommitted changes before it commits.
- As a developer, I want to edit the proposed message before I create the commit.
- As a developer, I want to ask the agent for a revision from the same review.
- As a developer, I want verification failures to remain visible without blocking a work-in-progress commit.
- As a developer, I want each repository to produce an independent commit and receipt.
- As a developer, I want WTS to reject the action when files change during review.

## Authority model

### Agent-owned proposal

The agent can publish:

- a repository ID
- a suggested subject
- an optional body
- a short rationale
- references to its report, findings, and proposed checks
- an optional Jira key from reviewed workspace context

The proposal is agent-reported. It cannot assert that checks passed. It cannot
supply a worktree path, stage files, create a commit, or push a branch.

### WTS-owned facts

WTS supplies:

- the trusted repository and worktree
- current `HEAD`
- staged, unstaged, deleted, and untracked file state
- the exact dirty-only patch
- the complete review digest
- current verification state and revision
- active managed-agent and verification state
- the commit receipt

### User-owned decisions

The user selects **Review and commit**, edits the message, accepts any warning,
and selects **Create commit**.

## Entry points

Use the same repository-scoped review from each entry point:

1. Agent completion shows **Review and commit** when a valid proposal exists.
2. A ready-to-review Hub card shows **Review changes**.
3. A changed repository row shows **Review changes**.
4. The current diff viewer shows **Prepare commit** when uncommitted work exists.

The agent publication changes the workspace state to **Ready to review**. It
does not open a dialog and does not create a commit.

## Primary flow

```text
Agent finishes meaningful work
        |
        v
Agent publishes summary and optional commit proposal
        |
        v
WTS shows Ready to review · N uncommitted files
        |
        v
User selects Review and commit
        |
        v
WTS creates a dirty-only preflight and review digest
        |
        v
User reviews changes, message, agent proposal, and checks
        |
        +---- Ask agent to revise ----> Agent session ----+
        |                                                 |
        |<--------------- New proposal and preflight <----+
        |
        v
User selects Create commit
        |
        v
WTS revalidates the digest under repository mutation locks
        |
        +---- Stale or active writer ----> Refresh review
        |
        v
WTS creates one local commit and updates workspace state
        |
        v
Commit receipt · Review next repository
```

## Screen 1: Ready to review

Reuse the repository row and agent status area.

```text
checkout-api    develop · 51fcd9c    4 uncommitted    6 checks passed
Agent proposal: Fix refresh-token rotation and add regression coverage.

                         [Review changes] [Review and commit]
```

Rules:

- Show **Review and commit** only for uncommitted work.
- Show **Review history** when the repository only has commits ahead.
- Label the proposal as agent-reported.
- Keep observed editor sessions visible.

## Screen 2: Commit review

Extend the current full-window diff dialog. Keep the file rail and diff controls.
Add a thin review header and a fixed action footer.

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Commit changes in checkout-api                                      [×]     │
│ AUTH-91 · Intermittent session expiry · HEAD 51fcd9c                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Agent proposal · not verified                                                │
│ Fix refresh-token rotation and add regression coverage.        [Ask agent]   │
├───────────────────┬──────────────────────────────────────────────────────────┤
│ 4 changed         │ [Unified] [Split] [Wrap lines]                           │
│ +82  -17          ├──────────────────────────────────────────────────────────┤
│                   │ src/session.ts                                           │
│ M session.ts      │  84  - return rotate(oldToken)                           │
│ M session.test.ts │  84  + return rotate(currentToken)                       │
│ M package.json    │                                                          │
│ A fixture.json    │                                                          │
│                   │                                                          │
├───────────────────┴──────────────────────────────────────────────────────────┤
│ Checks: 6 passed · current                                                   │
│ Commit message                                                               │
│ [AUTH-91: Fix refresh-token rotation______________________________________] │
│ [________________________________________________________________________] │
│                                                                              │
│ [Cancel]                                      [Ask agent] [Create commit]    │
└──────────────────────────────────────────────────────────────────────────────┘
```

The first thin release commits all current uncommitted changes in the repository.
It shows the complete candidate file list. It does not offer file checkboxes.

File selection is the next release. It requires an index-aware status contract,
path-safe selection, and explicit preservation of existing staged changes.

## Ask-agent revision flow

The user can ask for one of these bounded revisions:

- revise the commit message
- split the work into smaller commits
- remove an unrelated change
- add or revise tests
- investigate a selected file or line

```text
┌──────────────────────────────────────────────────────────────┐
│ Ask the agent to revise                                [×]   │
├──────────────────────────────────────────────────────────────┤
│ Request                                                      │
│ [Split the test fixture change into a separate commit.____] │
│                                                              │
│ Context                                                      │
│ checkout-api · 4 files · review 8c91…                       │
│ Selected lines: src/session.ts:84-91                         │
│                                                              │
│ [Cancel]                                  [Start revision]   │
└──────────────────────────────────────────────────────────────┘
```

WTS starts or continues a managed `review` session. It passes only the bounded
request, repository identity, review digest, and selected file or line references.

The commit action stays unavailable while a WTS-managed agent can edit files.
For an observed external session, WTS shows a warning and revalidates at apply.

Any file change makes the old proposal and review stale. WTS keeps the user's
message draft, but it requires a new preflight.

## Verification states

Verification stays separate from the agent proposal.

| State | Commit behavior |
| --- | --- |
| Passed and current | Show a positive WTS-owned fact. |
| Not run | Allow the commit after one direct confirmation. |
| Failed | Allow the commit through **Commit with failed checks**. |
| Running | Disable commit until the run finishes or stops. |
| Stale | Allow **Run checks** or require a direct stale-check confirmation. |
| Review truncated | Block commit and explain that WTS cannot review the full candidate. |

WTS does not add verification claims to the commit message. WTS records the
verification revision and result in its local commit receipt.

## Stale review

```text
┌──────────────────────────────────────────────────────────────┐
│ Review changed                                               │
│ Files changed after WTS created this review.                 │
│ WTS did not create a commit.                                 │
│                                                              │
│ [Close]                                      [Refresh review]│
└──────────────────────────────────────────────────────────────┘
```

The stale response must never partially stage or commit files.

## Commit progress

```text
Creating commit

Revalidates the reviewed changes
Creates the local commit
Updates workspace Git state
Refreshes commit-derived evidence
```

Disable close and competing repository actions during the mutation. Do not show
speculative progress. Show only completed or active trusted phases.

## Commit receipt

```text
┌──────────────────────────────────────────────────────────────┐
│ Commit created                                               │
├──────────────────────────────────────────────────────────────┤
│ AUTH-91: Fix refresh-token rotation                          │
│ 8f4c7d2 · 4 files · +82 -17                                 │
│                                                              │
│ Checks        6 passed · bound to reviewed content           │
│ Agent input   Codex proposal · session 3d2…                  │
│ Remaining     No uncommitted changes                         │
│                                                              │
│ [Copy commit ID] [Open repository] [Done]                    │
└──────────────────────────────────────────────────────────────┘
```

The receipt is a WTS-owned record. It contains the old and new `HEAD`, committed
paths, message, review digest, verification reference, and optional agent session.

Do not add an agent co-author trailer by default. WTS can record agent assistance
without changing repository authorship.

## Multi-repository flow

WTS does not present a multi-repository commit as atomic.

```text
Ready to commit

checkout-api      4 files      Agent proposal ready     [Review]
checkout-web      2 files      No proposal              [Review]

Each repository creates a separate local commit.
```

After success, show **Review next repository**. A failure in one repository does
not change another repository.

## Jira context

Use a reviewed imported issue as optional message context.

- Suggested subject: `AUTH-91: Fix refresh-token rotation`
- Show the issue key and title above the message.
- Store the issue reference in the WTS receipt.
- Do not update Jira status, comments, or worklogs during commit.

A key detected in a planning file is a suggestion. WTS requires confirmation
before it uses that key in the default message.

## Backend contracts

### Agent proposal

Add a bounded `commitProposal` section to the validated agent report or expose a
WTS-owned `propose_commit` tool.

```text
workspaceId
repositoryId
subject
body?
rationale
agentSessionId?
reportRevision
evidenceRefs[]
```

### Commit preflight

Add `preflight_workspace_repository_commit(workspaceId, repositoryId)`.

The response contains:

- exact current `HEAD` and saved base
- dirty-only file state and patch
- staged, unstaged, deleted, and untracked classifications
- patch and file-list truncation state
- current verification revision and result
- active managed writer state
- agent proposal revision when present
- an `effectDigest`

The digest binds workspace and repository identity, `HEAD`, complete file state,
content state, verification revision, and proposal revision. The commit message
is bound at apply or through a second preview after the user edits it.

### Commit apply

Add `commit_workspace_repository` with:

```text
workspaceId
repositoryId
expectedEffectDigest
subject
body?
verificationOverrideReason?
```

Rust resolves the trusted worktree from materialization state. Rust repeats the
preflight under repository and workspace locks. It rejects stale state, an active
managed writer, an active verification run, an invalid message, or truncation.

The first release stages and commits all current uncommitted changes. Git commands
use typed arguments without a shell. WTS must define hook and signing behavior.

On success, WTS:

1. Verifies the new commit and tree.
2. Updates the saved materialization `headCommitOid` atomically.
3. Keeps the saved base unchanged.
4. Refreshes repository activity.
5. Invalidates or rebuilds commit-derived graph evidence.
6. Marks verification current only when a reviewed-tree digest proves equivalence.
7. Writes a bounded commit receipt.

### Commit result

Return:

```text
workspaceId
repositoryId
previousHeadCommitOid
headCommitOid
baseCommitOid
subject
committedPaths[]
committedFileCount
remainingChangedFileCount
verificationState
agentSessionId?
receiptId
materialization
```

## Component reuse

- Extend `RepositoryDiffDialog` instead of adding a destination.
- Reuse `RepositoryPatchViewer` for the candidate diff.
- Reuse verification status vocabulary and revision handling.
- Reuse the reviewed alignment preflight and stale-digest pattern.
- Reuse managed `review` agent sessions and their current status strip.
- Reuse the fixed dialog footer and mutation-lock behavior.
- Reuse repository-specific success, error, retry, and notice patterns.

## Error states

- No uncommitted changes: show **No changes to commit**.
- Commits ahead only: offer **Review history**. Do not offer commit.
- Patch truncated: block commit and explain the 1 MB review limit.
- Agent still edits: block a managed writer. Warn for an observed external writer.
- Verification runs: wait or stop the run before commit.
- Review stale: make no Git change and offer **Refresh review**.
- Hook or signing failure: preserve the worktree and show the Git diagnostic.
- Git identity missing: show the exact configuration that is missing.
- Commit succeeds but evidence refresh fails: keep the commit and mark evidence stale.
- Materialization update fails: treat this as a recovery state and preserve the commit ID.

## First release

Include:

- agent proposal publication
- three explicit entry points
- one repository at a time
- dirty-only complete review
- commit all current uncommitted changes
- editable subject and body
- verification facts and explicit override
- stale-digest rejection
- local commit receipt
- materialization and evidence update

Exclude:

- file and hunk selection
- amend and undo
- automatic commits
- push
- merge request creation
- Jira mutation
- agent co-author trailers

## Follow-on releases

### File selection

Add file checkboxes after WTS has an index-aware state contract. Preserve existing
staged changes. Bind selected paths and content to the effect digest.

### Publish branch

Add a separate reviewed push preflight. Resolve the saved remote and branch. Never
push as part of local commit creation.

### Prepare merge request

Draft the title and body from reviewed Jira context, commit receipts, trusted
verification, and clearly labeled agent summary. Require explicit remote approval.

## Validation plan

- Git boundary test proves the exact dirty tree becomes one commit.
- Git boundary test proves committed-ahead changes are not recommitted.
- Git boundary test proves stale content creates no commit.
- Git boundary test proves untracked and deleted files are included.
- Service test proves paths come only from trusted materialization state.
- Service test proves active managed work and verification block apply.
- Service test proves the manifest records the new `HEAD` and keeps the base.
- Service test proves evidence becomes current or explicitly stale.
- HTTP and Tauri tests prove exact request and response contracts.
- UI test proves the proposal is labeled as agent-reported.
- UI test proves failed checks require an explicit override.
- UI test proves stale review keeps the previous Git state.
- UI test proves multi-repository work stays repository-scoped.

## Open questions

1. Should the first release run repository commit hooks?
2. Should WTS honor configured commit signing in the desktop process?
3. Should failed verification use a typed reason or one confirmation action?
4. Should a managed agent become idle automatically after it publishes a proposal?
5. Which reviewed-tree digest can preserve verification across the new commit ID?
6. When should file selection replace commit-all behavior?
