# 0002 — Managed repository sync

- **Status:** Accepted
- **Date:** 2026-08-04
- **Related plan:** `/.todo/repository-sync/PRD.md`

## Context

A managed worktree can remain on an older commit after its upstream branch
advances. Refreshing workspace status checks local state, but it does not fetch
or update the repository. A graph built from the older commit must not remain
ready after the repository changes.

## Decision

WTS provides an explicit **Sync** action for each managed repository. The UI
sends only the workspace ID and repository ID. The Rust service resolves the
trusted worktree path, saved base branch, and current commit.

Sync resolves the saved branch's configured tracking remote and fetches its
matching remote ref. The remote can have a name such as `origin` or `upstream`.
WTS advances the worktree only when all of these conditions are true:

- The worktree has no tracked, untracked, or ignored changes.
- The worktree HEAD equals the commit recorded by WTS.
- The worktree has no local commits.
- The upstream commit is a fast-forward from the current commit.
- No managed agent or verification operation is active.

Sync does not merge divergent history, rebase, reset, or run repository hooks.
WTS reports divergence as a separate state. Decision 0003 defines the explicit
alignment flow for a clean divergent worktree.

After Git advances, WTS records the new base and head commits. It invalidates
the old graph and verification result. WTS then rebuilds the graph. A graph is
ready only when its manifest records the current HEAD of every managed
repository.

If Graphify fails after Git advances, WTS keeps the new commit and reports a
partial result. The graph stays failed or unavailable until a later index
attempt succeeds.

## Consequences

- Sync cannot overwrite local work.
- One sync changes only the selected repository.
- The displayed commit comes from the trusted service response.
- Verification and agent planning cannot treat an old graph as current.
- A graph failure does not roll back a valid Git fast-forward.

## Validation

Tests cover the Git process boundary, workspace evidence files, HTTP and Tauri
transport contracts, desktop permissions, and user-visible progress and error
states.

## Related decisions

- [0003 — Reviewed repository alignment](0003-reviewed-repository-alignment.md)
