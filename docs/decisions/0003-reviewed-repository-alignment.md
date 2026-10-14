# 0003 — Reviewed repository alignment

- **Status:** Accepted
- **Date:** 2026-08-04
- **Related plan:** `/.todo/repository-alignment/PRD.md`

## Context

A tracking branch can replace its history after a force push. Normal Sync
cannot advance the worktree because the current commit is not its ancestor.
The old blocked message combined this state with local changes. It did not give
the user a safe recovery action in WTS.

## Decision

WTS reports divergent history with the `repository_sync_diverged` code. The UI
then requests an alignment preview. The preview shows these exact facts:

- The current worktree commit.
- The fetched tracking ref and target commit.
- The backup ref that will preserve the current commit.

The user must select the confirmation checkbox before WTS enables alignment.
The apply request contains the workspace ID, repository ID, and preview digest.
It does not contain a path, tracking ref, or target commit.

WTS fetches the configured tracking remote again before it applies the change.
WTS rejects the request if the preview facts changed. WTS also rejects the
request if the worktree is not clean or its HEAD differs from the saved commit.

WTS creates `refs/wts/backups/<old-commit>` before it changes HEAD. It then moves
the clean managed worktree to the reviewed target commit. WTS disables Git hooks
for this operation.

After alignment, WTS updates the materialization receipt and context evidence.
It invalidates the old graph and verification result. WTS then rebuilds the
graph from the new commit. A graph failure produces a partial success because
the Git change and backup remain valid.

## Consequences

- Normal Sync remains a fast-forward-only action.
- Alignment never overwrites tracked, untracked, or ignored local work.
- The user can recover the old commit from the displayed backup ref.
- A stale confirmation cannot move the worktree to a new unseen target.
- The UI does not ask the user to copy a destructive Git command.
- WTS changes only the selected managed worktree.

## Validation

Tests create a real divergent Git history and verify the backup ref, final HEAD,
graph evidence, and verification reset. Transport tests verify the digest-only
apply contract. UI tests verify the facts, confirmation, result, and graph state.
