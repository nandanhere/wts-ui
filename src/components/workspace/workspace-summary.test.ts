/**
 * Tests for WorkspaceSummary pure aggregation helpers.
 *
 * Run: node --experimental-strip-types --loader ../../scripts/register-ts.mjs \
 *       --test src/components/workspace/workspace-summary.test.ts
 */

import { describe, it } from "node:test";
import { strictEqual } from "node:assert";
import {
  computeSummaryMetrics,
  matchesRepoHealthFilter,
  type WorkspaceSummaryMetrics,
} from "@/lib/api/workspace-summary";
import type { RepoView } from "@/lib/api/workspace";
import type { GitStatusView } from "@/lib/api/git";

/* ------------------------------------------------------------------ */
/*  Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

function makeRepo(overrides: Partial<RepoView> & { id: string }): RepoView {
  return {
    rootPath: `/tmp/${overrides.id}`,
    displayName: overrides.id,
    folderMembership: ["test"],
    worktree: { path: `/tmp/${overrides.id}`, branch: "main" },
    branch: "main",
    lastCommit: null,
    exists: true,
    ...overrides,
  };
}

function makeStatus(
  repoId: string,
  overrides: Partial<GitStatusView> = {}
): GitStatusView {
  return {
    repoId,
    rootPath: `/tmp/${repoId}`,
    currentBranch: "main",
    headRef: "refs/heads/main",
    headOid: "abc123",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    changedFiles: [],
    changesTruncated: false,
    worktreeCount: 1,
    secondaryWorktreeBranches: [],
    localBranches: ["main"],
    remotes: ["origin"],
    remoteRefs: ["refs/remotes/origin/main"],
    secondaryWorktrees: [],
    cachedAt: Date.now(),
    errors: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

void describe("computeSummaryMetrics", () => {
  void it("returns all zeros for empty repos and empty status map", () => {
    const metrics = computeSummaryMetrics([], new Map());
    strictEqual(metrics.totalRepos, 0);
    strictEqual(metrics.dirtyRepos, 0);
    strictEqual(metrics.conflictedRepos, 0);
    strictEqual(metrics.aheadTotal, 0);
    strictEqual(metrics.behindTotal, 0);
    strictEqual(metrics.secondaryWorktreeCount, 0);
    strictEqual(metrics.reposWithStatusErrors, 0);
    strictEqual(metrics.missingFolderCount, 0);
    strictEqual(metrics.scanErrorCount, 0);
  });

  void it("counts total repos only for existing repos", () => {
    const repos: RepoView[] = [
      makeRepo({ id: "r1" }),
      makeRepo({ id: "r2", exists: true }),
      makeRepo({ id: "r3", exists: false }),
    ];
    const statusMap = new Map<string, GitStatusView>();
    statusMap.set("r1", makeStatus("r1"));
    statusMap.set("r2", makeStatus("r2"));

    const metrics = computeSummaryMetrics(repos, statusMap);
    strictEqual(metrics.totalRepos, 2);
    strictEqual(metrics.missingFolderCount, 1);
  });

  void it("counts dirty repos (staged, unstaged, or untracked; excluding conflicted)", () => {
    const repos: RepoView[] = [
      makeRepo({ id: "r1" }),
      makeRepo({ id: "r2" }),
      makeRepo({ id: "r3" }),
      makeRepo({ id: "r4" }),
    ];
    const statusMap = new Map<string, GitStatusView>([
      ["r1", makeStatus("r1", { untracked: 2, conflicted: 0 })],
      ["r2", makeStatus("r2", { staged: 3, unstaged: 1, conflicted: 0 })],
      ["r3", makeStatus("r3", { staged: 0, unstaged: 0, conflicted: 2 })],
      ["r4", makeStatus("r4", { staged: 1, unstaged: 0, conflicted: 0 })],
    ]);

    const metrics = computeSummaryMetrics(repos, statusMap);
    // r1, r2 and r4 are dirty; r3 is conflicted (separate category)
    strictEqual(metrics.dirtyRepos, 3);
    strictEqual(metrics.conflictedRepos, 1);
  });

  void it("counts conflicted repos separately from dirty", () => {
    const repos: RepoView[] = [
      makeRepo({ id: "r1" }),
      makeRepo({ id: "r2" }),
    ];
    const statusMap = new Map<string, GitStatusView>([
      ["r1", makeStatus("r1", { conflicted: 5, staged: 0, unstaged: 0 })],
      ["r2", makeStatus("r2", { conflicted: 1, staged: 2, unstaged: 3 })],
    ]);

    const metrics = computeSummaryMetrics(repos, statusMap);
    // Both have conflicts — conflicts take precedence over dirty
    strictEqual(metrics.conflictedRepos, 2);
    strictEqual(metrics.dirtyRepos, 0);
  });

  void it("sums ahead and behind across all repos", () => {
    const repos: RepoView[] = [
      makeRepo({ id: "r1" }),
      makeRepo({ id: "r2" }),
      makeRepo({ id: "r3" }),
    ];
    const statusMap = new Map<string, GitStatusView>([
      ["r1", makeStatus("r1", { ahead: 5, behind: 2 })],
      ["r2", makeStatus("r2", { ahead: 0, behind: 10 })],
      ["r3", makeStatus("r3", { ahead: 3, behind: 1 })],
    ]);

    const metrics = computeSummaryMetrics(repos, statusMap);
    strictEqual(metrics.aheadTotal, 8);
    strictEqual(metrics.behindTotal, 13);
  });

  void it("counts secondary worktrees (total - 1 per repo)", () => {
    const repos: RepoView[] = [makeRepo({ id: "r1" }), makeRepo({ id: "r2" })];
    const statusMap = new Map<string, GitStatusView>([
      ["r1", makeStatus("r1", { worktreeCount: 1 })],
      ["r2", makeStatus("r2", { worktreeCount: 4 })],
    ]);

    const metrics = computeSummaryMetrics(repos, statusMap);
    // r1: 0, r2: 3
    strictEqual(metrics.secondaryWorktreeCount, 3);
  });

  void it("counts repos with status errors", () => {
    const repos: RepoView[] = [
      makeRepo({ id: "r1" }),
      makeRepo({ id: "r2" }),
      makeRepo({ id: "r3" }),
    ];
    const statusMap = new Map<string, GitStatusView>([
      ["r1", makeStatus("r1", { errors: [] })],
      [
        "r2",
        makeStatus("r2", { errors: ["Remote 'origin' unreachable"] }),
      ],
      [
        "r3",
        makeStatus("r3", { errors: ["Fetch failed", "Timeout"] }),
      ],
    ]);

    const metrics = computeSummaryMetrics(repos, statusMap);
    strictEqual(metrics.reposWithStatusErrors, 2);
  });

  void it("counts missing folders from RepoView.exists", () => {
    const repos: RepoView[] = [
      makeRepo({ id: "r1", exists: true }),
      makeRepo({ id: "r2", exists: false }),
      makeRepo({ id: "r3", exists: false }),
      makeRepo({ id: "r4", exists: true }),
    ];
    const statusMap = new Map<string, GitStatusView>([
      ["r1", makeStatus("r1")],
      ["r4", makeStatus("r4")],
    ]);

    const metrics = computeSummaryMetrics(repos, statusMap);
    strictEqual(metrics.missingFolderCount, 2);
    strictEqual(metrics.totalRepos, 2);
  });

  void it("ignores non-existent repos in live status aggregation", () => {
    // A non-existent repo should not contribute to dirty/conflicted/ahead/etc
    const repos: RepoView[] = [
      makeRepo({ id: "r1", exists: false }),
      makeRepo({ id: "r2", exists: true }),
    ];
    // Even if we somehow have status for r1, it shouldn't be counted
    const statusMap = new Map<string, GitStatusView>([
      [
        "r1",
        makeStatus("r1", { staged: 5, ahead: 99, conflicted: 3 }),
      ],
      ["r2", makeStatus("r2", { staged: 2, conflicted: 0 })],
    ]);

    const metrics = computeSummaryMetrics(repos, statusMap);
    strictEqual(metrics.missingFolderCount, 1);
    strictEqual(metrics.totalRepos, 1);
    strictEqual(metrics.dirtyRepos, 1); // only r2
    strictEqual(metrics.aheadTotal, 0); // r1 is missing, excluded
  });

  void it("handles repos with no matching status in the map", () => {
    const repos: RepoView[] = [
      makeRepo({ id: "r1" }),
      makeRepo({ id: "r2" }),
    ];
    // Only r1 has status
    const statusMap = new Map<string, GitStatusView>([
      ["r1", makeStatus("r1", { ahead: 2 })],
    ]);

    const metrics = computeSummaryMetrics(repos, statusMap);
    strictEqual(metrics.totalRepos, 2);
    strictEqual(metrics.aheadTotal, 2); // only r1 counted
    strictEqual(metrics.dirtyRepos, 0);
  });

  void it("returns consistent shape", () => {
    const metrics = computeSummaryMetrics([], new Map());
    const keys: (keyof WorkspaceSummaryMetrics)[] = [
      "totalRepos",
      "dirtyRepos",
      "conflictedRepos",
      "aheadTotal",
      "behindTotal",
      "secondaryWorktreeCount",
      "reposWithStatusErrors",
      "missingFolderCount",
      "scanErrorCount",
    ];
    for (const key of keys) {
      strictEqual(
        typeof metrics[key],
        "number",
        `${key} should be a number`
      );
    }
  });
});

void describe("matchesRepoHealthFilter", () => {
  const repo = makeRepo({ id: "r1" });
  const status = makeStatus("r1", {
    staged: 2,
    ahead: 3,
    behind: 4,
    worktreeCount: 2,
    errors: ["status failed"],
  });

  void it("matches actionable live Git states", () => {
    strictEqual(matchesRepoHealthFilter(repo, status, "dirty"), true);
    strictEqual(matchesRepoHealthFilter(repo, status, "ahead"), true);
    strictEqual(matchesRepoHealthFilter(repo, status, "behind"), true);
    strictEqual(matchesRepoHealthFilter(repo, status, "worktrees"), true);
    strictEqual(matchesRepoHealthFilter(repo, status, "errors"), true);
  });

  void it("keeps conflicts separate from dirty repositories", () => {
    const conflicted = makeStatus("r1", { staged: 2, conflicted: 1 });
    strictEqual(matchesRepoHealthFilter(repo, conflicted, "dirty"), false);
    strictEqual(matchesRepoHealthFilter(repo, conflicted, "conflicts"), true);
  });

  void it("matches missing repositories without live status", () => {
    const missing = makeRepo({ id: "missing", exists: false });
    strictEqual(matchesRepoHealthFilter(missing, undefined, "all"), true);
    strictEqual(matchesRepoHealthFilter(missing, undefined, "missing"), true);
    strictEqual(matchesRepoHealthFilter(missing, undefined, "ahead"), false);
  });

  void it("matches untracked files and rejects unavailable or inactive states", () => {
    strictEqual(matchesRepoHealthFilter(repo, undefined, "dirty"), false);
    strictEqual(
      matchesRepoHealthFilter(repo, makeStatus("r1", { untracked: 2 }), "dirty"),
      true
    );
    strictEqual(matchesRepoHealthFilter(repo, makeStatus("r1"), "worktrees"), false);
    strictEqual(matchesRepoHealthFilter(repo, makeStatus("r1"), "errors"), false);
  });
});
