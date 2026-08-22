/**
 * Capture live repository state into snapshot-compatible domain models.
 *
 * Safe, bounded reads using the existing git runner / status layers.
 * No mutations. No secrets. No content. No diffs.
 */

import { existsSync, realpathSync } from "node:fs";
import { runGitSync } from "@/lib/git/runner";
import { readPorcelainV2, readRemotes, readWorktrees } from "@/lib/git/status";
import { _registerRepoPath } from "@/lib/git/runner";
import type { Repository } from "@/lib/workspace/types";
import type {
  RepoSnapshot,
  RepoIdentity,
  RepoHead,
  RepoWorktree,
  DirtySummary,
  SnapshotMeta,
  SnapshotSchema,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getOpts(repoPath: string) {
  return { repoPath, timeout: 10_000, maxOutputBytes: 262_144 };
}

/**
 * Ensure a repo path is registered with the git runner for canonical checks.
 */
function ensureRegistered(repo: Repository): void {
  try {
    if (existsSync(repo.rootPath)) {
      _registerRepoPath(realpathSync(repo.rootPath));
    }
  } catch {
    // non-fatal
  }
}

/* ------------------------------------------------------------------ */
/*  Identity hints                                                     */
/* ------------------------------------------------------------------ */

/**
 * Extract identity hints from a repository.
 * No URLs, no secrets — only remote names and a hint path.
 */
export function captureIdentity(repo: Repository): RepoIdentity {
  const remotes = readRemotes(repo.rootPath);
  const remoteNames = remotes.map((r) => r.name);
  const firstFetchUrl = remotes.find((r) => r.fetchUrl)?.fetchUrl ?? null;

  let remotePathHint: string | null = null;
  if (firstFetchUrl) {
    // Extract "org/repo" from various URL formats
    const match = firstFetchUrl.match(
      /(?:github\.com|gitlab\.com|bitbucket\.org)[:/]([^/]+\/[^/]+?)(?:\.git)?$/
    );
    if (match) {
      remotePathHint = match[1];
    }
  }

  return {
    commonDir: repo.commonDir,
    remoteNames,
    remotePathHint,
  };
}

/* ------------------------------------------------------------------ */
/*  HEAD state                                                         */
/* ------------------------------------------------------------------ */

/**
 * Capture the current HEAD state of a repository.
 */
export function captureHead(repoPath: string): RepoHead {
  // Get symbolic ref (e.g. "refs/heads/main") or detect detached
  const symR = runGitSync(
    ["symbolic-ref", "--quiet", "HEAD"],
    getOpts(repoPath)
  );
  const detached = symR.exitCode !== 0;
  const symbolicRef = detached ? null : symR.stdout.trim();

  // Get exact SHA
  const shaR = runGitSync(
    ["rev-parse", "HEAD"],
    getOpts(repoPath)
  );
  const sha = shaR.exitCode === 0 ? shaR.stdout.trim() : "";

  // Get upstream tracking ref
  let upstream: string | null = null;
  if (symbolicRef) {
    const branchName = symbolicRef.replace("refs/heads/", "");
    const upR = runGitSync(
      ["rev-parse", "--abbrev-ref", `--symbolic-full-name`, `${branchName}@{upstream}`],
      getOpts(repoPath)
    );
    if (upR.exitCode === 0) {
      upstream = upR.stdout.trim() || null;
    }
  }

  return { symbolicRef, detached, sha, upstream };
}

/* ------------------------------------------------------------------ */
/*  Worktree                                                           */
/* ------------------------------------------------------------------ */

/**
 * Capture the current worktree information for the primary worktree.
 */
export function captureWorktree(repo: Repository): RepoWorktree {
  const wts = readWorktrees(repo.rootPath);
  // Find the primary (main) worktree or the one matching our rootPath
  const primary = wts.find(
    (w) =>
      w.isPrimary ||
      (existsSync(w.path) && realpathSync(w.path) === realpathSync(repo.rootPath))
  );

  if (primary) {
    return {
      path: primary.path,
      logicalSlot: primary.isPrimary ? "primary" : primary.path,
    };
  }

  // Fallback: use repo root as primary worktree
  return {
    path: repo.rootPath,
    logicalSlot: "primary",
  };
}

/* ------------------------------------------------------------------ */
/*  Dirty summary                                                      */
/* ------------------------------------------------------------------ */

/**
 * Capture a dirty summary (counts only) from the repository worktree.
 * No file names, no content.
 */
export function captureDirtySummary(repoPath: string): DirtySummary {
  const v2 = readPorcelainV2(repoPath);

  if (!v2) {
    return { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
  }

  return {
    hasChanges: v2.staged > 0 || v2.unstaged > 0 || v2.untracked > 0 || v2.conflicted > 0,
    staged: v2.staged,
    unstaged: v2.unstaged,
    untracked: v2.untracked,
    conflicted: v2.conflicted,
  };
}

/* ------------------------------------------------------------------ */
/*  Full repo snapshot                                                 */
/* ------------------------------------------------------------------ */

/**
 * Capture a complete `RepoSnapshot` from a live repository.
 * Uses the existing `_registerRepoPath` to ensure the runner allows it.
 */
export function captureRepoSnapshot(repo: Repository): RepoSnapshot {
  ensureRegistered(repo);

  return {
    repoId: repo.id,
    rootPath: repo.rootPath,
    identity: captureIdentity(repo),
    head: captureHead(repo.rootPath),
    worktree: captureWorktree(repo),
    dirty: captureDirtySummary(repo.rootPath),
  };
}

/* ------------------------------------------------------------------ */
/*  Full snapshot capture                                              */
/* ------------------------------------------------------------------ */

/**
 * Capture a snapshot from all registered repositories.
 *
 * @param repos          - repositories to capture
 * @param label          - human-readable label
 * @param description    - optional description
 * @param workspaceFilePath - the workspace file path at capture time
 * @param source         - how this snapshot was created
 */
export function captureSnapshot(
  repos: Repository[],
  label: string,
  workspaceFilePath: string,
  description?: string,
  source: SnapshotMeta["source"] = "manual"
): Omit<SnapshotSchema, "version"> {
  const repoSnapshots: RepoSnapshot[] = repos.map((r) => {
    try {
      return captureRepoSnapshot(r);
    } catch {
      // If a repo fails, capture what we can
      return {
        repoId: r.id,
        rootPath: r.rootPath,
        identity: { commonDir: r.commonDir, remoteNames: [], remotePathHint: null },
        head: { symbolicRef: null, detached: false, sha: "", upstream: null },
        worktree: { path: r.rootPath, logicalSlot: "primary" },
        dirty: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      };
    }
  });

  return {
    meta: {
      createdAt: new Date().toISOString(),
      label,
      ...(description ? { description } : {}),
      workspaceFilePath,
      source,
    },
    repos: repoSnapshots,
    repoCount: repoSnapshots.length,
  };
}
