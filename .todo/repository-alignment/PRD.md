# Repository Alignment PRD

## Overview

Let a user align a clean managed worktree with a rewritten tracking branch
after normal fast-forward sync detects divergent history. WTS must preview the
exact effect, preserve the current commit, and rebuild commit-bound evidence.

## User Needs

1. Know whether sync is blocked by local work or divergent history.
2. See the exact current and upstream commits before moving a managed branch.
3. Preserve the current workspace commit through a durable Git reference.
4. Update only the selected managed worktree.
5. Rebuild the graph before WTS reports the workspace as ready.

## User Stories

- As a developer, I want WTS to explain divergence so that I do not search for
  local file changes that do not exist.
- As a developer, I want to review an upstream alignment before applying it so
  that a force-pushed branch cannot move silently.
- As a developer, I want the old commit preserved so that I can recover or
  compare it later.

## Screens and Flows

1. Sync blocker — identifies divergent history and offers **Review alignment**.
2. Alignment review — shows repository, tracking ref, current commit, new
   commit, backup ref, and graph effect.
3. Applying — disables dismissal and reports the active trusted operation.
4. Success — updates the repository row and confirms graph status.
5. Stale or blocked — asks the user to review again without moving Git.

```text
Sync
  |
  +-- fast-forward available --------------------> Sync normally
  |
  +-- local work --------------------------------> Review local work
  |
  +-- divergent and clean -> Review alignment -> Confirm -> Preserve old ref
                                                        -> Align branch
                                                        -> Rebuild graph
```

## ASCII Design

```text
┌──────────────────────────────────────────────────────────┐
│ Align senzu with upstream/develop                    [×] │
├──────────────────────────────────────────────────────────┤
│ The tracking branch has different history.              │
│                                                          │
│ Current workspace commit       1401ce0c                  │
│ New upstream commit            51fcd9c                   │
│ Preserved as                   refs/wts/backups/1401...  │
│                                                          │
│ WTS will move only this managed worktree. It will then   │
│ rebuild the workspace graph and reset verification.      │
│                                                          │
│ [Cancel]                         [Align with upstream]    │
└──────────────────────────────────────────────────────────┘
```

Applying:

```text
┌──────────────────────────────────────────────────────────┐
│ Align senzu with upstream/develop                        │
├──────────────────────────────────────────────────────────┤
│ ◌ Preserves 1401ce0c and rebuilds the graph…             │
│                                           [Working…]     │
└──────────────────────────────────────────────────────────┘
```

## Component Reuse

- Reuse the current Radix dialog shell and removal-review layout.
- Reuse repository row notices, command-state locking, commit typography, and
  primary and secondary buttons.
- Reuse graph evidence recording and verification invalidation from repository
  sync.

## API and Backend

- A preflight accepts only workspace and repository identities.
- Rust resolves the trusted worktree, saved base branch, tracking remote,
  current commit, and fetched remote commit.
- The preflight returns a digest bound to those values and the backup ref.
- Apply repeats every check under the materialization and adapter locks.
- Apply rejects a stale digest, dirty worktree, active agent, or active
  verification operation.
- Git creates `refs/wts/backups/<current-commit>` before moving the clean
  managed branch to the reviewed remote commit.
- WTS updates the receipt and context, invalidates verification, and rebuilds
  the graph with current repository HEADs.

## Open Questions

None for v1. Alignment applies to one clean managed worktree and requires an
explicit review.
