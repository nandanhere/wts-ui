/**
 * Preflight checks for Git repository mutations.
 *
 * Every mutation route must call the relevant preflight function first.
 * Preflight returns blockers, warnings, and a confirmation level.
 * Mutations MUST NOT proceed if `allowed` is false.
 */

import { runGitSync } from "./runner";
import { existsSync, realpathSync } from "node:fs";
import { readPorcelainV2, readWorktrees, readRemotes } from "./status";
import { isWithinWorktreeRoot } from "./worktree-paths";
import type {
  PreflightCheck,
  PreflightAction,
  WorktreeEntry,
} from "./types";
import type { Repository } from "@/lib/workspace/types";

function getOpts(repoPath: string) {
  return { repoPath, timeout: 10_000, maxOutputBytes: 262_144 };
}

/**
 * Check whether the repo exists and is accessible.
 */
function repoAccessible(repoPath: string): string | null {
  const r = runGitSync(
    ["rev-parse", "--git-dir"],
    getOpts(repoPath)
  );
  if (r.exitCode !== 0) {
    return "Repository not accessible or not a git repository";
  }
  return null;
}

/**
 * Check if the working tree is clean (no staged, unstaged, or untracked).
 */
function isTreeClean(repoPath: string): { clean: boolean; issues: string[] } {
  const status = readPorcelainV2(repoPath);
  if (!status) return { clean: false, issues: ["Cannot read repository status"] };

  const issues: string[] = [];
  if (status.staged > 0) issues.push(`${status.staged} staged change(s)`);
  if (status.unstaged > 0) issues.push(`${status.unstaged} unstaged change(s)`);
  if (status.untracked > 0) issues.push(`${status.untracked} untracked file(s)`);
  if (status.conflicted > 0) issues.push(`${status.conflicted} conflicted file(s)`);

  return { clean: issues.length === 0, issues };
}

/**
 * Find which worktree (if any) has a given branch checked out.
 */
function findBranchOccupancy(
  repoPath: string,
  branchName: string,
  worktrees?: WorktreeEntry[]
): WorktreeEntry | null {
  const wts = worktrees ?? readWorktrees(repoPath);
  for (const wt of wts) {
    if (wt.branch === branchName) return wt;
  }
  return null;
}

/**
 * Check whether a branch exists locally.
 */
function localBranchExists(repoPath: string, branchName: string): boolean {
  const r = runGitSync(
    ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
    getOpts(repoPath)
  );
  return r.exitCode === 0;
}

/**
 * Check whether a remote tracking branch exists.
 */
function remoteRefExists(repoPath: string, remote: string, branchName: string): boolean {
  const r = runGitSync(
    ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branchName}`],
    getOpts(repoPath)
  );
  return r.exitCode === 0;
}

export function findRemotesWithBranch(repoPath: string, branchName: string): string[] {
  return readRemotes(repoPath)
    .map((remote) => remote.name)
    .filter((remote) => remoteRefExists(repoPath, remote, branchName));
}

/**
 * Validate a branch/ref name for safety (no injection, no path traversal).
 */
function validateRef(target: string): string | null {
  if (!target || target.length > 256) {
    return "Invalid ref: empty or too long";
  }
  // Reject anything that isn't a simple branch name or ref
  if (/[;|&$`'"()<>\n\r]/.test(target)) {
    return "Invalid ref: contains shell-special characters";
  }
  if (/^[-.]/.test(target)) {
    return "Invalid ref: starts with a dash or dot";
  }
  if (/\.\./.test(target)) {
    return "Invalid ref: contains double-dot sequence";
  }
  if (/^refs\//.test(target) && !/^refs\/heads\//.test(target) && !/^refs\/remotes\//.test(target)) {
    return "Invalid ref: unsupported ref namespace";
  }
  // Ref must match git's allowed ref pattern
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\-\/]*$/.test(target) && !/^refs\//.test(target)) {
    // But allow slashes in branch names e.g. "feature/foo"
    if (!/^[a-zA-Z0-9_.\-\/]+$/.test(target)) {
      return "Invalid ref: contains disallowed characters";
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Public preflight functions                                         */
/* ------------------------------------------------------------------ */

/**
 * Preflight a fetch operation.
 */
export function preflightFetch(
  repo: Repository,
  remote: string
): PreflightCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Validate remote name
  const refErr = validateRef(remote);
  if (refErr) {
    blockers.push(refErr);
  }

  // Access check
  const accessErr = repoAccessible(repo.rootPath);
  if (accessErr) blockers.push(accessErr);

  // Check remote exists
  const remotes = readRemotes(repo.rootPath);
  if (!remotes.some((r) => r.name === remote)) {
    blockers.push(`Remote "${remote}" is not configured for this repository`);
  }

  return {
    action: "fetch",
    repoId: repo.id,
    target: remote,
    allowed: blockers.length === 0,
    blockers,
    warnings,
    currentState: "Unknown",
    desiredState: `Fetch from remote "${remote}"`,
    requiresFetch: false,
    requiresConfirmation: false,
  };
}

/**
 * Preflight a branch switch operation.
 *
 * Rules:
 * - Working tree must be clean (no staged/unstaged/conflicted changes)
 * - Target branch must not be occupied by another worktree
 * - If target doesn't exist locally but exists on remote,
 *   `createTracking` is required
 * - Detached HEAD switch is allowed only to an existing ref
 */
export function preflightSwitch(
  repo: Repository,
  target: string,
  createTracking?: boolean
): PreflightCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Validate target ref
  const refErr = validateRef(target);
  if (refErr) {
    blockers.push(refErr);
  }

  // Access check
  const accessErr = repoAccessible(repo.rootPath);
  if (accessErr) blockers.push(accessErr);

  // Clean tree check
  const treeStatus = isTreeClean(repo.rootPath);
  if (!treeStatus.clean) {
    blockers.push(`Working tree is not clean: ${treeStatus.issues.join(", ")}`);
    blockers.push("Stash, commit, or discard changes before switching branches");
  }

  // Parse target as branch name (strip refs/heads/ if needed)
  const localBranchName = target.replace(/^refs\/heads\//, "");
  const remoteTarget = target.startsWith("refs/remotes/");
  const remoteParts = remoteTarget
    ? target.slice("refs/remotes/".length).split("/")
    : [];
  const explicitRemote = remoteParts[0] ?? "";
  const branchName = remoteTarget
    ? remoteParts.slice(1).join("/")
    : localBranchName;

  // Check local existence
  const localExists = localBranchExists(repo.rootPath, branchName);

  if (remoteTarget) {
    // Remote ref specified directly
    if (branchName && remoteRefExists(repo.rootPath, explicitRemote, branchName)) {
      if (!createTracking) {
        blockers.push(`"${target}" is a remote ref. Use createTracking=true to create a local tracking branch`);
      }
      warnings.push(`Will create local branch "${branchName}" tracking "${explicitRemote}/${branchName}"`);
    } else {
      blockers.push(`Remote ref "${target}" not found`);
    }
  } else if (!localExists) {
    // Check if there's a remote tracking branch
    const matchingRemotes = findRemotesWithBranch(repo.rootPath, branchName);
    if (matchingRemotes.length === 1) {
      const remote = matchingRemotes[0]!;
      if (!createTracking) {
        blockers.push(
          `Branch "${branchName}" does not exist locally but exists on "${remote}/${branchName}". ` +
          "Set createTracking=true to create a local tracking branch"
        );
      } else {
        warnings.push(`Will create local tracking branch "${branchName}" tracking "${remote}/${branchName}"`);
      }
    } else if (matchingRemotes.length > 1) {
      blockers.push(`Branch "${branchName}" exists on multiple remotes; use an explicit refs/remotes/<remote>/<branch> target`);
    } else {
      blockers.push(`Branch "${branchName}" does not exist locally or on any remote`);
    }
  }

  // Check branch occupancy
  if (localExists) {
    const occupant = findBranchOccupancy(repo.rootPath, branchName);
    if (occupant) {
      const primary = occupant.isPrimary ? "" : ` (worktree: ${occupant.path})`;
      blockers.push(`Branch "${branchName}" is already checked out${primary}`);
    }
  }

  // If we got here with no blockers, determine state description
  const currentState = localExists ? `Local branch "${branchName}" exists` : `Will create tracking branch "${branchName}"`;
  const desiredState = `Switch to branch "${branchName}"`;

  return {
    action: "switch",
    repoId: repo.id,
    target,
    allowed: blockers.length === 0,
    blockers,
    warnings,
    currentState,
    desiredState,
    requiresFetch: false,
    requiresConfirmation: !localExists,
  };
}

/**
 * Preflight a worktree create operation.
 */
export function preflightWorktreeCreate(
  repo: Repository,
  branch: string,
  targetPath?: string
): PreflightCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Validate branch name
  const refErr = validateRef(branch);
  if (refErr) blockers.push(refErr);

  if (targetPath && !isWithinWorktreeRoot(targetPath)) {
    blockers.push("Worktree target must be an absolute path within the configured worktree root");
  }

  // Access check
  const accessErr = repoAccessible(repo.rootPath);
  if (accessErr) blockers.push(accessErr);

  // Check branch doesn't already have a worktree
  const branchName = branch.replace(/^refs\/heads\//, "");
  const wts = readWorktrees(repo.rootPath);
  const occupant = findBranchOccupancy(repo.rootPath, branchName, wts);
  if (occupant) {
    blockers.push(`Branch "${branchName}" is already checked out at ${occupant.path}`);
  }

  // Check local branch existence
  const localExists = localBranchExists(repo.rootPath, branchName);
  if (!localExists) {
    // Check remote
    const defaultRemote = "origin";
    if (remoteRefExists(repo.rootPath, defaultRemote, branchName)) {
      warnings.push(`Branch "${branchName}" exists on remote but not locally. It will be created from "${defaultRemote}/${branchName}"`);
    } else {
      // Will need to create a new branch
      warnings.push(`Branch "${branchName}" does not exist. A new branch will be created`);
    }
  }

  return {
    action: "worktree-create",
    repoId: repo.id,
    target: branch,
    allowed: blockers.length === 0,
    blockers,
    warnings,
    currentState: localExists ? `Branch "${branchName}" exists locally` : `Branch "${branchName}" will be created`,
    desiredState: `Create worktree for branch "${branchName}"${targetPath ? ` at ${targetPath}` : ""}`,
    requiresFetch: false,
    requiresConfirmation: !localExists,
  };
}

/**
 * Preflight a worktree remove operation.
 */
export function preflightWorktreeRemove(
  repo: Repository,
  path: string
): PreflightCheck {
  const blockers: string[] = [];
  const warnings: string[] = [];

  // Access check
  const accessErr = repoAccessible(repo.rootPath);
  if (accessErr) blockers.push(accessErr);

  // Verify the path is a registered worktree of this repo
  const wts = readWorktrees(repo.rootPath);
  const resolvedPath = existsSync(path) ? realpathSync(path) : path;
  const wt = wts.find((w) => {
    try {
      return existsSync(w.path) ? realpathSync(w.path) === resolvedPath : w.path === path;
    } catch {
      return w.path === path;
    }
  });

  if (!wt) {
    blockers.push(`Path "${path}" is not a registered worktree of this repository`);
  } else {
    if (wt.isPrimary) {
      blockers.push("Cannot remove the primary (main) worktree");
    }
    if (wt.locked) {
      blockers.push("Worktree is locked. Unlock before removing");
    }
    if (wt.prunable) {
      blockers.push("Worktree is prunable; use a separate confirmed prune operation");
    }
  }

  return {
    action: "worktree-remove",
    repoId: repo.id,
    target: path,
    allowed: blockers.length === 0,
    blockers,
    warnings,
    currentState: wt ? `Worktree at "${path}" (${wt.branch ?? "detached"})` : `Unknown worktree "${path}"`,
    desiredState: `Remove worktree at "${path}"`,
    requiresFetch: false,
    requiresConfirmation: true,
  };
}

export { validateRef };
