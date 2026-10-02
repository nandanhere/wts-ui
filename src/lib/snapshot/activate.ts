/**
 * Safe activation of a saved multi-repository combination.
 *
 * Only two existing mutation primitives are used: clean branch switches and
 * confined secondary-worktree creation. Dirty, occupied, missing, detached,
 * remote-only, or ambiguous states remain blocked. There is deliberately no
 * stash, reset, discard, force, branch rewrite, or automatic network fetch.
 */

import { runGitSync } from "@/lib/git/runner";
import { getRepo } from "@/lib/git/registry";
import { createWorktree, switchBranch } from "@/lib/git/operations";
import { defaultWorktreePath } from "@/lib/git/worktree-paths";
import { analyzeDrift } from "./drift";
import type {
  ActivationResult,
  ActivationSummary,
  DriftResult,
  RepoActivationPlan,
  RepoActivationResult,
  RepoSnapshot,
  SnapshotSchema,
} from "./types";

const activationLocks = new Map<string, Promise<unknown>>();

async function withActivationLock<T>(snapshotId: string, fn: () => Promise<T>): Promise<T> {
  const previous = activationLocks.get(snapshotId) ?? Promise.resolve();
  const next = previous.then(fn).finally(() => {
    if (activationLocks.get(snapshotId) === next) activationLocks.delete(snapshotId);
  });
  activationLocks.set(snapshotId, next);
  return next;
}

function branchAtSnapshot(repoPath: string, branch: string, sha: string): boolean {
  const result = runGitSync(
    ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
    { repoPath, timeout: 10_000, maxOutputBytes: 65_536 }
  );
  return result.exitCode === 0 && result.stdout.trim() === sha;
}

function worktreeAtSnapshot(repoPath: string, branch: string, sha: string): boolean {
  const head = runGitSync(["rev-parse", "HEAD"], {
    repoPath,
    timeout: 10_000,
    maxOutputBytes: 65_536,
  });
  const symbolic = runGitSync(["symbolic-ref", "--quiet", "HEAD"], {
    repoPath,
    timeout: 10_000,
    maxOutputBytes: 65_536,
  });
  return (
    head.exitCode === 0 &&
    head.stdout.trim() === sha &&
    symbolic.exitCode === 0 &&
    symbolic.stdout.trim() === `refs/heads/${branch}`
  );
}

export function planActivation(
  snapshot: SnapshotSchema,
  drift: DriftResult
): RepoActivationPlan[] {
  const snapshotByRepo = new Map(snapshot.repos.map((repo) => [repo.repoId, repo]));

  return drift.repos.map((repo): RepoActivationPlan => {
    const entry = snapshotByRepo.get(repo.repoId);
    const base = {
      repoId: repo.repoId,
      classification: repo.classification,
      branch: repo.snapshotBranch,
      snapshotSha: repo.snapshotSha,
      explanation: repo.explanation,
    };

    if (!entry) {
      return { ...base, action: "none", executable: false, explanation: "Repository is not present in the snapshot." };
    }

    switch (repo.classification) {
      case "satisfied":
      case "preferred":
        return { ...base, action: "none", executable: true };
      case "safe-switch":
        return repo.snapshotBranch
          ? { ...base, action: "switch", executable: true }
          : { ...base, action: "none", executable: false, explanation: "Detached snapshot states require manual handling." };
      case "create-worktree":
        return repo.snapshotBranch
          ? { ...base, action: "create-worktree", executable: true }
          : { ...base, action: "none", executable: false, explanation: "Detached snapshot states require manual handling." };
      case "fetch-needed":
        return {
          ...base,
          action: "none",
          executable: false,
          explanation: "Remote-only branch requires an explicit fetch before activation.",
        };
      default:
        return { ...base, action: "none", executable: false };
    }
  });
}

function blocked(plan: RepoActivationPlan, message = plan.explanation): RepoActivationResult {
  return { ...plan, status: "blocked", message, durationMs: 0 };
}

function snapshotEntry(snapshot: SnapshotSchema, repoId: string): RepoSnapshot | undefined {
  return snapshot.repos.find((repo) => repo.repoId === repoId);
}

export async function activateSnapshot(
  snapshotId: string,
  snapshot: SnapshotSchema,
  requestedRepoIds?: string[]
): Promise<ActivationResult> {
  return withActivationLock(snapshotId, async () => {
  const startedAt = new Date().toISOString();
  const selected = requestedRepoIds ? new Set(requestedRepoIds) : null;
  const drift = analyzeDrift(snapshot);
  const plans = planActivation(snapshot, drift).filter((plan) => !selected || selected.has(plan.repoId));
  const results: RepoActivationResult[] = [];

  for (const plan of plans) {
    if (!plan.executable) {
      results.push(blocked(plan));
      continue;
    }

    if (plan.action === "none") {
      const repo = getRepo(plan.repoId);
      const entry = snapshotEntry(snapshot, plan.repoId);
      if (
        !repo ||
        !entry ||
        !plan.branch ||
        !worktreeAtSnapshot(repo.rootPath, plan.branch, entry.head.sha)
      ) {
        results.push(blocked(plan, "Repository state changed after activation planning; refresh and try again."));
        continue;
      }
      results.push({
        ...plan,
        status: "already-satisfied",
        message: "No Git operation was needed.",
        durationMs: 0,
      });
      continue;
    }

    const repo = getRepo(plan.repoId);
    const entry = snapshotEntry(snapshot, plan.repoId);
    if (!repo || !entry || !plan.branch) {
      results.push(blocked(plan, "Repository is no longer registered in the open workspace."));
      continue;
    }

    if (plan.action === "switch") {
      if (!branchAtSnapshot(repo.rootPath, plan.branch, entry.head.sha)) {
        results.push(blocked(plan, `Branch "${plan.branch}" no longer points to snapshot commit ${entry.head.sha.slice(0, 8)}.`));
        continue;
      }
      const result = await switchBranch(repo, {
        repoId: repo.id,
        target: plan.branch,
        createTracking: false,
      });
      results.push({
        ...plan,
        status: result.success ? "success" : "failed",
        message: result.success ? `Switched to ${result.newBranch}.` : (result.error ?? "Branch switch failed."),
        durationMs: result.durationMs,
      });
      continue;
    }

    // A branch name alone is insufficient: it may have moved since capture.
    // Never create a worktree unless the local branch still points exactly to
    // the recorded snapshot commit.
    if (!branchAtSnapshot(repo.rootPath, plan.branch, entry.head.sha)) {
      results.push(blocked(plan, `Branch "${plan.branch}" no longer points to snapshot commit ${entry.head.sha.slice(0, 8)}.`));
      continue;
    }

    const targetPath = defaultWorktreePath(repo.id, plan.branch);
    const result = await createWorktree(repo, {
      repoId: repo.id,
      branch: plan.branch,
      targetPath,
    });
    results.push({
      ...plan,
      status: result.success ? "success" : "failed",
      message: result.success ? `Created worktree for ${plan.branch}.` : (result.error ?? "Worktree creation failed."),
      durationMs: result.durationMs,
      ...(result.success ? { worktreePath: result.path } : {}),
    });
  }

  const summary: ActivationSummary = {
    total: results.length,
    succeeded: results.filter((result) => result.status === "success").length,
    alreadySatisfied: results.filter((result) => result.status === "already-satisfied").length,
    blocked: results.filter((result) => result.status === "blocked").length,
    failed: results.filter((result) => result.status === "failed").length,
  };

  return {
    snapshotId,
    startedAt,
    finishedAt: new Date().toISOString(),
    repos: results,
    summary,
  };
  });
}