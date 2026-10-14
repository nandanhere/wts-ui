/**
 * Safe repository mutation operations.
 *
 * Every function:
 * 1. Calls preflight first
 * 2. Acquires a per-repo lock
 * 3. Executes bounded git commands (argument arrays, no shell)
 * 4. Writes to the audit journal
 * 5. Invalidates relevant status cache entries
 * 6. Returns structured result
 */

import { runGitSync } from "./runner";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { clearRepoStatusCache } from "./status";
import { findRemotesWithBranch, preflightFetch, preflightSwitch, preflightWorktreeCreate, preflightWorktreeRemove } from "./preflight";
import { writeJournalEntry } from "./journal";
import type {
  FetchRequest,
  FetchResult,
  SwitchRequest,
  SwitchResult,
  WorktreeCreateRequest,
  WorktreeCreateResult,
  WorktreeRemoveRequest,
  WorktreeRemoveResult,
} from "./types";
import type { Repository } from "@/lib/workspace/types";
import { defaultWorktreePath, getWorktreeRoot } from "./worktree-paths";

/* ------------------------------------------------------------------ */
/*  Per-repo mutation locks                                            */
/* ------------------------------------------------------------------ */

const locks = new Map<string, Promise<unknown>>();

async function withLock<T>(repoId: string, fn: () => T): Promise<T> {
  const existing = locks.get(repoId) ?? Promise.resolve();
  const next = existing.then(() => fn()).finally(() => {
    if (locks.get(repoId) === next) {
      locks.delete(repoId);
    }
  });
  locks.set(repoId, next);
  return next;
}

export function _getLockCount(): number {
  return locks.size;
}

export function _clearLocks(): void {
  locks.clear();
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getOpts(repoPath: string, timeout?: number) {
  return {
    repoPath,
    timeout: timeout ?? 30_000,
    maxOutputBytes: 524_288, // 512 KB for mutations
  };
}

/* ------------------------------------------------------------------ */
/*  Fetch                                                              */
/* ------------------------------------------------------------------ */

export async function fetchRepo(
  repo: Repository,
  req: FetchRequest
): Promise<FetchResult> {
  return withLock(repo.id, async () => {
    const remote = req.remote ?? "origin";

    // Preflight
    const check = preflightFetch(repo, remote);
    if (!check.allowed) {
      const result: FetchResult = {
        repoId: repo.id,
        remote,
        success: false,
        output: "",
        error: check.blockers.join("; "),
        durationMs: 0,
      };
      await writeJournal("fetch", repo, req, result);
      return result;
    }

    const start = Date.now();

    // Build args — NO shell, array only
    const args: string[] = ["fetch", remote];
    if (req.prune) args.push("--prune");
    // Bounded: no tags by default, no progress
    args.push("--no-tags", "--no-recurse-submodules");

    const r = runGitSync(args, getOpts(repo.rootPath, 60_000));
    const durationMs = Date.now() - start;

    const success = r.exitCode === 0;
    const result: FetchResult = {
      repoId: repo.id,
      remote,
      success,
      output: r.stderr.trim() || r.stdout.trim(),
      error: success ? undefined : (r.stderr.trim() || `Exit code ${r.exitCode}`),
      durationMs,
    };

    // Invalidate cache
    if (success) clearRepoStatusCache(repo.id);

    // Journal
    await writeJournal("fetch", repo, req, result);

    return result;
  });
}

/* ------------------------------------------------------------------ */
/*  Switch                                                             */
/* ------------------------------------------------------------------ */

export async function switchBranch(
  repo: Repository,
  req: SwitchRequest
): Promise<SwitchResult> {
  return withLock(repo.id, async () => {
    const target = req.target;
    const createTracking = req.createTracking ?? false;

    // Get previous branch for result
    const prevR = runGitSync(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      getOpts(repo.rootPath)
    );
    const previousBranch = prevR.exitCode === 0 ? prevR.stdout.trim() : "(unknown)";

    // Preflight
    const check = preflightSwitch(repo, target, createTracking);
    if (!check.allowed) {
      const result: SwitchResult = {
        repoId: repo.id,
        target,
        success: false,
        previousBranch,
        newBranch: previousBranch,
        output: "",
        error: check.blockers.join("; "),
        durationMs: 0,
      };
      await writeJournal("switch", repo, req, result);
      return result;
    }

    const start = Date.now();
    const args: string[] = ["checkout"];
    const branchName = target
      .replace(/^refs\/heads\//, "")
      .replace(/^refs\/remotes\/[^/]+\//, "");

    // If creating tracking branch from remote
    const isRemoteRef = target.startsWith("refs/remotes/");
    let newBranch = branchName;

    if (isRemoteRef && createTracking) {
      // e.g. refs/remotes/origin/feature -> checkout -b feature origin/feature
      const parts = target.slice("refs/remotes/".length).split("/");
      const remoteName = parts[0]!;
      args.push("-b", branchName, `${remoteName}/${branchName}`);
      newBranch = branchName;
    } else if (createTracking && !isRemoteRef) {
      // Branch doesn't exist locally, create from remote
      const remote = findRemotesWithBranch(repo.rootPath, branchName)[0]!;
      args.push("-b", branchName, `${remote}/${branchName}`);
    } else {
      args.push(branchName);
    }

    const r = runGitSync(args, getOpts(repo.rootPath, 30_000));
    const durationMs = Date.now() - start;

    const success = r.exitCode === 0;
    const result: SwitchResult = {
      repoId: repo.id,
      target,
      success,
      previousBranch,
      newBranch: success ? newBranch : previousBranch,
      output: r.stderr.trim() || r.stdout.trim(),
      error: success ? undefined : (r.stderr.trim() || `Exit code ${r.exitCode}`),
      durationMs,
    };

    if (success) clearRepoStatusCache(repo.id);
    await writeJournal("switch", repo, req, result);

    return result;
  });
}

/* ------------------------------------------------------------------ */
/*  Worktree Create                                                    */
/* ------------------------------------------------------------------ */

export async function createWorktree(
  repo: Repository,
  req: WorktreeCreateRequest
): Promise<WorktreeCreateResult> {
  return withLock(repo.id, async () => {
    const branch = req.branch;
    const branchName = branch.replace(/^refs\/heads\//, "");

    // Preflight
    const check = preflightWorktreeCreate(repo, branch, req.targetPath);
    if (!check.allowed) {
      const result: WorktreeCreateResult = {
        repoId: repo.id,
        branch: branchName,
        path: req.targetPath ?? "",
        success: false,
        output: "",
        error: check.blockers.join("; "),
        durationMs: 0,
      };
      await writeJournal("worktree-create", repo, req, result);
      return result;
    }

    const start = Date.now();
    const args: string[] = ["worktree", "add"];

    // Determine path
    const wtPath = req.targetPath ?? defaultWorktreePath(repo.id, branchName);
    mkdirSync(getWorktreeRoot(), { recursive: true });

    const baseRef = req.baseRef ?? `origin/${branchName}`;

    // Check if branch exists locally
    const existsR = runGitSync(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
      getOpts(repo.rootPath)
    );
    const localExists = existsR.exitCode === 0;

    if (localExists) {
      args.push("--checkout", wtPath, branchName);
    } else {
      // Create new branch from baseRef
      args.push("--checkout", "-b", branchName, wtPath, baseRef);
    }

    const r = runGitSync(args, getOpts(repo.rootPath, 30_000));
    const durationMs = Date.now() - start;

    const success = r.exitCode === 0;
    const result: WorktreeCreateResult = {
      repoId: repo.id,
      branch: branchName,
      path: success ? wtPath : (req.targetPath ?? ""),
      success,
      output: r.stderr.trim() || r.stdout.trim(),
      error: success ? undefined : (r.stderr.trim() || `Exit code ${r.exitCode}`),
      durationMs,
    };

    if (success) clearRepoStatusCache(repo.id);
    await writeJournal("worktree-create", repo, req, result);

    return result;
  });
}

/* ------------------------------------------------------------------ */
/*  Worktree Remove                                                    */
/* ------------------------------------------------------------------ */

export async function removeWorktree(
  repo: Repository,
  req: WorktreeRemoveRequest
): Promise<WorktreeRemoveResult> {
  return withLock(repo.id, async () => {
    // Preflight
    const check = preflightWorktreeRemove(repo, req.path);
    if (!check.allowed) {
      const result: WorktreeRemoveResult = {
        repoId: repo.id,
        path: req.path,
        success: false,
        output: "",
        error: check.blockers.join("; "),
        durationMs: 0,
      };
      await writeJournal("worktree-remove", repo, req, result);
      return result;
    }

    const canonicalPath = existsSync(req.path) ? realpathSync(req.path) : req.path;
    const start = Date.now();

    // Remove worktree (no force in release 1)
    const r = runGitSync(
      ["worktree", "remove", canonicalPath],
      getOpts(repo.rootPath, 30_000)
    );
    const durationMs = Date.now() - start;

    const success = r.exitCode === 0;
    const result: WorktreeRemoveResult = {
      repoId: repo.id,
      path: req.path,
      success,
      output: r.stderr.trim() || r.stdout.trim(),
      error: success ? undefined : (r.stderr.trim() || `Exit code ${r.exitCode}`),
      durationMs,
    };

    if (success) clearRepoStatusCache(repo.id);
    await writeJournal("worktree-remove", repo, req, result);

    return result;
  });
}

/* ------------------------------------------------------------------ */
/*  Journal helper                                                     */
/* ------------------------------------------------------------------ */

async function writeJournal(
  action: string,
  repo: Repository,
  req: unknown,
  result: { success: boolean; error?: string; durationMs: number }
): Promise<void> {
  try {
    const source = req && typeof req === "object" ? req as Record<string, unknown> : {};
    const allowedKeys: Record<string, string[]> = {
      fetch: ["repoId", "remote", "prune"],
      switch: ["repoId", "target", "createTracking"],
      "worktree-create": ["repoId", "branch", "targetPath", "baseRef"],
      "worktree-remove": ["repoId", "path"],
    };
    const params = Object.fromEntries(
      (allowedKeys[action] ?? []).flatMap((key) =>
        Object.prototype.hasOwnProperty.call(source, key) ? [[key, source[key]]] : []
      )
    );
    writeJournalEntry({
      workspaceFilePath: "", // set by API route
      repoId: repo.id,
      action,
      params,
      result: result.success ? "success" : "failure",
      error: result.error,
      durationMs: result.durationMs,
    });
  } catch {
    // Non-fatal: journal write should not crash the operation
  }
}
