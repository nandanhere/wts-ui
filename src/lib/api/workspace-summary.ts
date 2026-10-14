/**
 * Pure aggregation helpers for workspace command-center summary.
 *
 * Extracted from the React component so tests can import without JSX.
 * No DOM, no React, no side effects.
 */

import type { RepoView } from "@/lib/api/workspace";
import type { GitStatusView } from "@/lib/api/git";

/* ------------------------------------------------------------------ */
/*  Metrics shape                                                      */
/* ------------------------------------------------------------------ */

export interface WorkspaceSummaryMetrics {
  totalRepos: number;
  dirtyRepos: number;
  conflictedRepos: number;
  aheadTotal: number;
  behindTotal: number;
  secondaryWorktreeCount: number;
  reposWithStatusErrors: number;
  missingFolderCount: number;
  scanErrorCount: number;
}

export type RepoHealthFilter =
  | "all"
  | "dirty"
  | "conflicts"
  | "ahead"
  | "behind"
  | "worktrees"
  | "errors"
  | "missing";

export const REPO_HEALTH_FILTER_LABELS: Record<RepoHealthFilter, string> = {
  all: "All repositories",
  dirty: "Dirty",
  conflicts: "Conflicts",
  ahead: "Ahead",
  behind: "Behind",
  worktrees: "Worktrees",
  errors: "Status errors",
  missing: "Missing",
};

/** Return whether a repository belongs in an actionable health view. */
export function matchesRepoHealthFilter(
  repo: RepoView,
  status: GitStatusView | undefined,
  filter: RepoHealthFilter
): boolean {
  if (filter === "all") return true;
  if (filter === "missing") return !repo.exists;
  if (!repo.exists || !status) return false;

  switch (filter) {
    case "dirty":
      return status.conflicted === 0 &&
        (status.staged > 0 || status.unstaged > 0 || status.untracked > 0);
    case "conflicts":
      return status.conflicted > 0;
    case "ahead":
      return status.ahead > 0;
    case "behind":
      return status.behind > 0;
    case "worktrees":
      return status.worktreeCount > 1;
    case "errors":
      return status.errors.length > 0;
  }
}

/**
 * Aggregate Git status data into actionable summary metrics.
 *
 * Pure function — no side effects, no dependencies on React or DOM.
 * - `dirtyRepos`: repos with staged + unstaged > 0 (NOT conflicted — separate)
 * - `conflictedRepos`: repos with conflicted > 0
 * - `aheadTotal`: sum of ahead counts across all repos
 * - `behindTotal`: sum of behind counts across all repos
 * - `secondaryWorktreeCount`: total non-primary worktrees across all repos
 * - `reposWithStatusErrors`: repos whose .errors array is non-empty
 * - `missingFolderCount`: repos (via RepoView.exists) that don't exist on disk
 * - `scanErrorCount`: scan-level errors (from workspace scan, not per-repo)
 */
export function computeSummaryMetrics(
  repositories: RepoView[],
  statusMap: ReadonlyMap<string, GitStatusView>
): WorkspaceSummaryMetrics {
  let dirtyRepos = 0;
  let conflictedRepos = 0;
  let aheadTotal = 0;
  let behindTotal = 0;
  let secondaryWorktreeCount = 0;
  let reposWithStatusErrors = 0;
  let missingFolderCount = 0;

  for (const repo of repositories) {
    // Track missing folders from scan data
    if (!repo.exists) {
      missingFolderCount++;
      continue; // skip live status for non-existent repos
    }

    const status = statusMap.get(repo.id);
    if (!status) continue;

    if (status.conflicted > 0) {
      conflictedRepos++;
    } else if (status.staged > 0 || status.unstaged > 0 || status.untracked > 0) {
      dirtyRepos++;
    }

    aheadTotal += status.ahead;
    behindTotal += status.behind;

    if (status.worktreeCount > 1) {
      secondaryWorktreeCount += status.worktreeCount - 1;
    }

    if (status.errors.length > 0) {
      reposWithStatusErrors++;
    }
  }

  return {
    totalRepos: repositories.filter((r) => r.exists).length,
    dirtyRepos,
    conflictedRepos,
    aheadTotal,
    behindTotal,
    secondaryWorktreeCount,
    reposWithStatusErrors,
    missingFolderCount,
    scanErrorCount: 0, // supplied by caller via scanErrors
  };
}
