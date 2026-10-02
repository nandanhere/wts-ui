# Repository Sync PRD

## Overview

Let a user safely advance one clean WTS-managed worktree to the latest commit
on its saved upstream branch, then rebuild the workspace graph before reporting
the sync as complete.

## User Needs

1. See when a managed worktree is behind its saved upstream branch.
2. Update one repository without leaving the workspace or using an implicit
   pull strategy.
3. Preserve every local modification and local commit.
4. Know the exact commit change and whether the graph now covers it.
5. Keep other repositories in the multi-repository workspace unchanged.

## User Stories

- As a developer, I want to sync `jellyfish/develop` so that the managed
  worktree uses the current upstream commit.
- As a developer, I want sync blocked when local work exists so that WTS never
  rebases or overwrites my changes.
- As a developer, I want the graph rebuilt after Git advances so that agent and
  verification evidence cannot use a stale repository graph.
- As a developer, I want the before and after commits shown so that I can audit
  what changed.

## Screens and Flow

1. Repository row — shows the saved branch and current managed commit, with a
   compact **Sync** action.
2. Syncing row — replaces the action with the current trusted phase.
3. Success row — shows the new commit and confirms that the graph was rebuilt.
4. Blocked/error row — explains whether local work, divergence, network access,
   or graph indexing prevented completion.

```text
[Repository row]
      |
      +-- Sync -> Fetch upstream -> Fast-forward clean worktree -> Rebuild graph
      |                                                           |
      |                                                           +-- Success
      |
      +-- local changes/commits/divergence -> Blocked; no Git mutation
```

## ASCII Design

```text
Repository       Base                         Changes       Verification
jellyfish        develop                      Clean         Review checks
                 c10cc79c -> 71806377          [Sync]
```

While running:

```text
jellyfish        develop                      Updating…     Graph pending
                 c10cc79c                     Fetching upstream
```

On success:

```text
jellyfish        develop                      Clean         Review checks
                 71806377                     Synced · graph rebuilt
```

Blocked:

```text
jellyfish        develop                      1 changed     Review changes
                 c10cc79c                     Sync requires a clean worktree
```

## Component Reuse

- Extend the existing managed-worktree table and repository notice.
- Reuse the current secondary button, refresh glyph, state dot, and workspace
  command status patterns.
- Reuse the existing repository diff action when local work blocks sync.
- Reuse the existing graph indexing adapter and evidence manifest.

## Backend Contract

- The caller supplies only workspace and repository identities.
- WTS resolves the trusted worktree path and saved base branch from durable
  workspace state.
- Resolve the saved branch's configured tracking remote and fetch only that
  remote. Do not require the remote name to be `origin`.
- Advance only through a fast-forward of a clean worktree with no commits ahead
  of its registered base.
- Persist the new base and head commits, invalidate old graph evidence, then
  force a graph update.
- Return both commit IDs and the new graph result. Never report success before
  the graph manifest covers current worktree HEADs.

## Error States

- No origin or remote branch: make no change and explain what is missing.
- Dirty worktree: make no change and offer review of local changes.
- Local commits or divergent history: make no change and tell the user to resolve in
  their normal Git tool.
- Fetch failure: make no change and preserve the current graph.
- Graph rebuild failure after a successful fast-forward: keep the repository
  update, mark the graph unavailable/stale, and state that re-index is needed.

## Validation

- A clean worktree fast-forwards to the fetched remote commit.
- Dirty, locally-ahead, and divergent worktrees remain byte-for-byte unchanged.
- Only the selected repository moves.
- The materialization receipt and evidence context record the new base commit.
- The graph manifest records every current repository HEAD before success.
- The UI exposes progress, success, and a useful blocked state.

## Open Questions

None for v1. Sync is intentionally one repository at a time and fast-forward
only.
