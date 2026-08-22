/**
 * Snapshot drift analysis — compare a snapshot against live repository state.
 *
 * Never executes restore or destructive operations.
 * Produces a PLAN only with per-repo classification.
 */

import { existsSync, realpathSync } from "node:fs";
import { runGitSync } from "@/lib/git/runner";
import { readPorcelainV2, readWorktrees } from "@/lib/git/status";
import { _registerRepoPath } from "@/lib/git/runner";
import { getRepo, getAllRepos } from "@/lib/git/registry";
import type { Repository } from "@/lib/workspace/types";
import type {
  SnapshotSchema,
  RepoSnapshot,
  DriftResult,
  RepoDriftResult,
  DriftClass,
  DriftSummary,
  RestorePlan,
  RepoRestoreAction,
  RestoreSummary,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getOpts(repoPath: string) {
  return { repoPath, timeout: 10_000, maxOutputBytes: 262_144 };
}

/**
 * Check if a local branch exists.
 */
function localBranchExists(repoPath: string, branchName: string): boolean {
  const r = runGitSync(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    getOpts(repoPath)
  );
  return r.exitCode === 0;
}

/**
 * Check if a remote tracking branch exists.
 */
function remoteBranchExists(repoPath: string, branchName: string): boolean {
  // First try origin, then check all remotes
  const r = runGitSync(
    ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branchName}`],
    getOpts(repoPath)
  );
  if (r.exitCode === 0) return true;

  // Check all remotes
  const remotesR = runGitSync(
    ["remote"],
    getOpts(repoPath)
  );
  if (remotesR.exitCode !== 0) return false;
  const remotes = remotesR.stdout.trim().split("\n").filter(Boolean);
  for (const remote of remotes) {
    const cr = runGitSync(
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branchName}`],
      getOpts(repoPath)
    );
    if (cr.exitCode === 0) return true;
  }
  return false;
}

/**
 * Check if a ref (full or short) exists locally.
 */
function refExists(repoPath: string, ref: string): boolean {
  const r = runGitSync(
    ["show-ref", "--verify", "--quiet", ref],
    getOpts(repoPath)
  );
  return r.exitCode === 0;
}

/**
 * Check if an exact commit exists locally.
 */
function commitExists(repoPath: string, sha: string): boolean {
  const r = runGitSync(
    ["cat-file", "-e", `${sha}^{commit}`],
    getOpts(repoPath)
  );
  return r.exitCode === 0;
}

/**
 * Get current HEAD SHA.
 */
function currentSha(repoPath: string): string | null {
  const r = runGitSync(["rev-parse", "HEAD"], getOpts(repoPath));
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * Get current symbolic ref (e.g. "refs/heads/main") or null if detached.
 */
function currentRef(repoPath: string): string | null {
  const r = runGitSync(["symbolic-ref", "--quiet", "HEAD"], getOpts(repoPath));
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/**
 * Get current branch short name or null.
 */
function currentBranch(repoPath: string): string | null {
  const r = runGitSync(["rev-parse", "--abbrev-ref", "HEAD"], getOpts(repoPath));
  if (r.exitCode !== 0) return null;
  const val = r.stdout.trim();
  return val === "HEAD" ? null : val;
}

/**
 * Check if working tree is clean.
 */
function isClean(repoPath: string): boolean {
  const v2 = readPorcelainV2(repoPath);
  if (!v2) return false;
  return v2.staged === 0 && v2.unstaged === 0 && v2.untracked === 0 && v2.conflicted === 0;
}

/**
 * Find which worktree has a given branch checked out.
 * Returns the worktree path or null.
 */
function findBranchOccupant(repoPath: string, branchName: string): string | null {
  const wts = readWorktrees(repoPath);
  for (const wt of wts) {
    if (wt.branch === branchName) return wt.path;
  }
  return null;
}

/**
 * Resolve snapshot branch name to a short form.
 */
function snapshotBranchName(entry: RepoSnapshot): string | null {
  if (!entry.head.symbolicRef) return null;
  return entry.head.symbolicRef.replace("refs/heads/", "");
}

/**
 * Resolve the working directory for a snapshot repo entry.
 * Checks if the recorded repo is registered in the current workspace.
 */
function resolveRepo(entry: RepoSnapshot): Repository | null {
  // Try by exact repoId first
  const byId = getRepo(entry.repoId);
  if (byId) return byId;

  // Try by rootPath (in case repo ID context changed — workspace re-scan)
  const all = getAllRepos();
  const byPath = all.find(
    (r) =>
      r.rootPath === entry.rootPath ||
      (existsSync(r.rootPath) &&
        existsSync(entry.rootPath) &&
        realpathSync(r.rootPath) === realpathSync(entry.rootPath))
  );
  if (byPath) return byPath;

  // Try by commonDir match
  const byCommon = all.find(
    (r) =>
      r.commonDir === entry.identity.commonDir ||
      (existsSync(r.commonDir) &&
        existsSync(entry.identity.commonDir) &&
        realpathSync(r.commonDir) === realpathSync(entry.identity.commonDir))
  );
  return byCommon ?? null;
}

/* ------------------------------------------------------------------ */
/*  Drift classification                                               */
/* ------------------------------------------------------------------ */

/**
 * Classify drift for a single snapshot entry against live state.
 */
export function classifyRepoDrift(
  entry: RepoSnapshot,
  repo: Repository | null
): RepoDriftResult {
  const repoId = entry.repoId;

  // missing-repo: repository not found on disk at all
  if (!repo) {
    return {
      repoId,
      rootPath: entry.rootPath,
      classification: "missing-repo",
      explanation: `Repository not found in current workspace registry. Path: ${entry.rootPath}`,
      repoExists: false,
      isClean: true,
      currentSha: null,
      snapshotSha: entry.head.sha,
      currentBranch: null,
      snapshotBranch: snapshotBranchName(entry),
      branchMatch: false,
      shaMatch: false,
      occupiedBy: null,
    };
  }

  const repoPath = repo.rootPath;

  // Check if the repo directory actually exists on disk
  if (!existsSync(repoPath)) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "missing-repo",
      explanation: `Repository path does not exist on disk: ${repoPath}`,
      repoExists: false,
      isClean: true,
      currentSha: null,
      snapshotSha: entry.head.sha,
      currentBranch: null,
      snapshotBranch: snapshotBranchName(entry),
      branchMatch: false,
      shaMatch: false,
      occupiedBy: null,
    };
  }

  // Ensure registered for git operations
  try {
    _registerRepoPath(realpathSync(repoPath));
  } catch {
    // Continue anyway
  }

  const snapshotBranch = snapshotBranchName(entry);
  const curBranch = currentBranch(repoPath);
  const curRef = currentRef(repoPath);
  const curSha = currentSha(repoPath);
  const clean = isClean(repoPath);
  const shaMatch = curSha === entry.head.sha;
  const branchMatch = curRef === entry.head.symbolicRef;

  // Check ref existence
  let snapshotRefExists = false;
  let snapshotCommitExists = false;

  if (snapshotBranch) {
    snapshotRefExists = localBranchExists(repoPath, snapshotBranch);
  }
  // Always try to find the commit
  if (entry.head.sha) {
    snapshotCommitExists = commitExists(repoPath, entry.head.sha);
  }

  // ---- Classification logic ----

  // satisfied: repo at same HEAD on same branch, clean tree
  if (branchMatch && shaMatch && clean) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "satisfied",
      explanation: `Repository is at the snapshot state: ${snapshotBranch ?? "detached"} @ ${entry.head.sha.slice(0, 8)}`,
      repoExists: true,
      isClean: true,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch,
      branchMatch: true,
      shaMatch: true,
      occupiedBy: null,
    };
  }

  // safe-switch: same HEAD but different branch, clean tree
  if (shaMatch && clean && snapshotBranch) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "safe-switch",
      explanation: `Same commit (${entry.head.sha.slice(0, 8)}) but different branch. Clean tree allows safe switch.`,
      repoExists: true,
      isClean: true,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch,
      branchMatch: false,
      shaMatch: true,
      occupiedBy: null,
    };
  }

  // dirty-blocked: working tree has changes
  if (!clean && snapshotBranch) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "dirty-blocked",
      explanation: "Working tree has uncommitted changes. Stash or commit before switching.",
      repoExists: true,
      isClean: false,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch,
      branchMatch: false,
      shaMatch,
      occupiedBy: null,
    };
  }

  // dirty-blocked for detached HEAD too
  if (!clean && !snapshotBranch) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "dirty-blocked",
      explanation: "Working tree has uncommitted changes (detached HEAD). Clean up before restore.",
      repoExists: true,
      isClean: false,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch: null,
      branchMatch: false,
      shaMatch,
      occupiedBy: null,
    };
  }

  // occupied: same branch but different commit (cannot switch within same branch)
  if (snapshotBranch && branchMatch && !shaMatch) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "occupied",
      explanation: `Current branch is "${snapshotBranch}" but at a different commit. Tree is clean but switching to a different commit on the same branch would lose the current HEAD.`,
      repoExists: true,
      isClean: clean,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch,
      branchMatch: true,
      shaMatch: false,
      occupiedBy: repoPath,
    };
  }

  // occupied: branch checked out in a different worktree (not this one)
  if (snapshotBranch && !branchMatch) {
    const occupant = findBranchOccupant(repoPath, snapshotBranch);
    if (occupant && occupant !== repoPath) {
      return {
        repoId,
        rootPath: repoPath,
        classification: "occupied",
        explanation: `Branch "${snapshotBranch}" is checked out in another worktree: ${occupant}`,
        repoExists: true,
        isClean: clean,
        currentSha: curSha,
        snapshotSha: entry.head.sha,
        currentBranch: curBranch,
        snapshotBranch,
        branchMatch: false,
        shaMatch,
        occupiedBy: occupant,
      };
    }
  }

  // fetch-needed: snapshot ref not found locally, but exists on remote
  if (!snapshotRefExists && snapshotBranch && remoteBranchExists(repoPath, snapshotBranch)) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "fetch-needed",
      explanation: `Branch "${snapshotBranch}" exists on remote but not locally. A fetch is needed.`,
      repoExists: true,
      isClean: clean,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch,
      branchMatch: false,
      shaMatch: false,
      occupiedBy: null,
    };
  }

  // missing-ref: snapshot ref doesn't exist at all (local or remote)
  if (snapshotBranch && !snapshotRefExists) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "missing-ref",
      explanation: `Branch "${snapshotBranch}" does not exist locally or on any remote.`,
      repoExists: true,
      isClean: clean,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch,
      branchMatch: false,
      shaMatch: false,
      occupiedBy: null,
    };
  }

  // commit may exist even without branch (detached snapshot or deleted branch)
  // create-worktree: branch not occupied, needs worktree creation (preferred path)
  if (snapshotBranch && !shaMatch && clean) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "create-worktree",
      explanation: `Different commit. Clean tree — create a worktree for "${snapshotBranch}" rather than switching current tree.`,
      repoExists: true,
      isClean: true,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch,
      branchMatch: false,
      shaMatch: false,
      occupiedBy: null,
    };
  }

  // ambiguous: multiple possible matches / unclear state
  if (!snapshotBranch && !shaMatch && !clean) {
    return {
      repoId,
      rootPath: repoPath,
      classification: "ambiguous",
      explanation: "Snapshot is detached HEAD at a different commit, and working tree is not clean.",
      repoExists: true,
      isClean: false,
      currentSha: curSha,
      snapshotSha: entry.head.sha,
      currentBranch: curBranch,
      snapshotBranch: null,
      branchMatch: false,
      shaMatch: false,
      occupiedBy: null,
    };
  }

  // Fallback: ambiguous
  return {
    repoId,
    rootPath: repoPath,
    classification: "ambiguous",
    explanation: "Unable to determine precise drift classification.",
    repoExists: true,
    isClean: clean,
    currentSha: curSha,
    snapshotSha: entry.head.sha,
    currentBranch: curBranch,
    snapshotBranch,
    branchMatch,
    shaMatch,
    occupiedBy: null,
  };
}

/* ------------------------------------------------------------------ */
/*  Full drift analysis                                                */
/* ------------------------------------------------------------------ */

/**
 * Analyze drift for a full snapshot against current registered repos.
 */
export function analyzeDrift(snapshot: SnapshotSchema): DriftResult {
  const results: RepoDriftResult[] = [];

  for (const entry of snapshot.repos) {
    const repo = resolveRepo(entry);
    const drift = classifyRepoDrift(entry, repo);
    results.push(drift);
  }

  // Compute summary
  const summary: DriftSummary = {
    satisfied: 0,
    safeSwitch: 0,
    createWorktree: 0,
    preferred: 0,
    dirtyBlocked: 0,
    occupied: 0,
    fetchNeeded: 0,
    missingRef: 0,
    missingRepo: 0,
    ambiguous: 0,
  };

  for (const r of results) {
    switch (r.classification) {
      case "satisfied":
        summary.satisfied++;
        break;
      case "safe-switch":
        summary.safeSwitch++;
        break;
      case "create-worktree":
        summary.createWorktree++;
        break;
      case "preferred":
        summary.preferred++;
        break;
      case "dirty-blocked":
        summary.dirtyBlocked++;
        break;
      case "occupied":
        summary.occupied++;
        break;
      case "fetch-needed":
        summary.fetchNeeded++;
        break;
      case "missing-ref":
        summary.missingRef++;
        break;
      case "missing-repo":
        summary.missingRepo++;
        break;
      case "ambiguous":
        summary.ambiguous++;
        break;
    }
  }

  return {
    snapshotId: snapshot.meta.label, // use label as friendly identifier
    repos: results,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/*  Restore plan generation (PLAN only — never executed)               */
/* ------------------------------------------------------------------ */

/**
 * Generate a restore plan from drift results.
 * This is a PLAN only — never executes any git operation.
 */
export function generateRestorePlan(drift: DriftResult): RestorePlan {
  const actions: RepoRestoreAction[] = [];
  let autoExecutable = 0;
  let requiresManual = 0;

  for (const repo of drift.repos) {
    let steps: string[];
    let canAutoExecute: boolean;
    let prerequisites: string[];

    switch (repo.classification) {
      case "satisfied":
        steps = ["No action needed — repository already at snapshot state."];
        canAutoExecute = true;
        prerequisites = [];
        autoExecutable++;
        break;

      case "safe-switch":
        steps = [
          `Switch to branch "${repo.snapshotBranch}" (same commit, clean tree).`,
          `Command: git checkout ${repo.snapshotBranch}`,
        ];
        canAutoExecute = true;
        prerequisites = [];
        autoExecutable++;
        break;

      case "create-worktree":
        steps = [
          `Create a new worktree for branch "${repo.snapshotBranch}".`,
          `Command: git worktree add ../${repo.rootPath.split("/").pop()}-${repo.snapshotBranch!.replace(/\//g, "-")} ${repo.snapshotBranch}`,
          "This preserves the current worktree state.",
        ];
        canAutoExecute = true;
        prerequisites = ["Fetch if branch is remote-only"];
        autoExecutable++;
        break;

      case "preferred":
        steps = ["Current worktree is acceptable. Optionally create a separate worktree."];
        canAutoExecute = true;
        prerequisites = [];
        autoExecutable++;
        break;

      case "dirty-blocked":
        steps = [
          "Working tree has uncommitted changes.",
          "Option A: Commit changes.",
          "Option B: Stash changes with 'git stash'.",
          "Option C: Discard changes (irreversible).",
        ];
        canAutoExecute = false;
        prerequisites = ["User must resolve dirty state first"];
        requiresManual++;
        break;

      case "occupied":
        steps = [
          `Branch "${repo.snapshotBranch}" is checked out at ${repo.occupiedBy}.`,
          "Option A: Use the existing worktree.",
          "Option B: Switch to a new branch in the current worktree.",
          "Cannot create another worktree with the same branch.",
        ];
        canAutoExecute = false;
        prerequisites = ["User must choose which worktree to use"];
        requiresManual++;
        break;

      case "fetch-needed":
        steps = [
          `Branch "${repo.snapshotBranch}" exists on remote but not locally.`,
          "Run 'git fetch' to update remote refs, then switch or create worktree.",
        ];
        canAutoExecute = false;
        prerequisites = ["Fetch must complete successfully"];
        requiresManual++;
        break;

      case "missing-ref":
        steps = [
          `The snapshot branch "${repo.snapshotBranch}" does not exist locally or on any remote.`,
          "Option A: If the branch was deleted, create it at the recorded commit.",
          `Option B: If the commit ${repo.snapshotSha.slice(0, 8)} is reachable, check it out directly.`,
        ];
        canAutoExecute = false;
        prerequisites = ["User must determine the correct ref"];
        requiresManual++;
        break;

      case "missing-repo":
        steps = [
          `Repository not found at ${repo.rootPath}.`,
          "Option A: Re-clone the repository and re-scan the workspace.",
          "Option B: Update the snapshot if the repo was intentionally removed.",
        ];
        canAutoExecute = false;
        prerequisites = ["Repository must exist on disk"];
        requiresManual++;
        break;

      case "ambiguous":
        steps = [
          "Cannot determine a clear restore path for this repository.",
          "Manual investigation required.",
        ];
        canAutoExecute = false;
        prerequisites = ["User must inspect the repository state"];
        requiresManual++;
        break;

      default:
        steps = ["Unknown classification — manual investigation required."];
        canAutoExecute = false;
        prerequisites = [];
        requiresManual++;
        break;
    }

    actions.push({
      repoId: repo.repoId,
      classification: repo.classification,
      steps,
      canAutoExecute,
      prerequisites,
    });
  }

  const summary: RestoreSummary = {
    total: actions.length,
    autoExecutable,
    requiresManual,
  };

  return {
    snapshotId: drift.snapshotId,
    repos: actions,
    summary,
    canRestoreAll: requiresManual === 0,
  };
}
