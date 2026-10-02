/**
 * Tests for snapshot drift analysis and restore plan generation.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/snapshot/__tests__/drift.test.ts
 *
 * Creates disposable temporary git repos for live drift testing.
 * NOTE: Capture tests require real git repos; these test drift
 * classification logic with both real repos and synthetic inputs.
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  classifyRepoDrift,
  analyzeDrift,
  generateRestorePlan,
} from "@/lib/snapshot/drift";
import type {
  RepoSnapshot,
  SnapshotSchema,
  DriftResult,
  RestorePlan,
} from "@/lib/snapshot/types";
import type { Repository } from "@/lib/workspace/types";
import { clearRepoRegistry, registerRepos } from "@/lib/git/registry";
import { _clearRepoPaths, _resetGitPath } from "@/lib/git/runner";

const TMP = resolve(tmpdir(), "dashboard-drift-test");

function run(dir: string, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, {
    cwd: dir,
    stdio: "pipe",
    timeout: 10000,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
}

function initRepo(parent: string, name: string): string {
  const p = resolve(parent, name);
  mkdirSync(p, { recursive: true });
  run(p, "git", ["init", "-b", "main"]);
  writeFileSync(resolve(p, "README.md"), `# ${name}`);
  run(p, "git", ["add", "."]);
  run(p, "git", ["commit", "-m", "initial"]);
  return p;
}

function getHeadSha(repoPath: string): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    stdio: "pipe",
    timeout: 5000,
  });
  return r.stdout.toString().trim();
}

function getBranch(repoPath: string): string {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoPath,
    stdio: "pipe",
    timeout: 5000,
  });
  return r.stdout.toString().trim();
}

function makeSnapshotEntry(
  repoPath: string,
  branch: string,
  sha: string,
  detached = false
): RepoSnapshot {
  return {
    repoId: `test-${branch}`,
    rootPath: repoPath,
    identity: {
      commonDir: `${repoPath}/.git`,
      remoteNames: [],
      remotePathHint: null,
    },
    head: {
      symbolicRef: detached ? null : `refs/heads/${branch}`,
      detached,
      sha,
      upstream: null,
    },
    worktree: { path: repoPath, logicalSlot: "primary" },
    dirty: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  };
}

function makeRepo(repoPath: string, id: string): Repository {
  return {
    id,
    rootPath: repoPath,
    commonDir: `${repoPath}/.git`,
    worktree: { path: repoPath, branch: "main" },
    folderMembership: ["Test"],
  };
}

void describe("classifyRepoDrift", () => {
  let repoPath: string;
  let headSha: string;
  let repo: Repository;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });

    repoPath = initRepo(TMP, "drift-target");
    headSha = getHeadSha(repoPath);
    repo = makeRepo(repoPath, "drift-target");
    registerRepos([repo]);
  });

  after(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    _resetGitPath();
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("classifies satisfied when repo matches snapshot exactly", () => {
    const entry = makeSnapshotEntry(repoPath, "main", headSha);
    const result = classifyRepoDrift(entry, repo);
    strictEqual(result.classification, "satisfied");
    ok(result.shaMatch);
    ok(result.branchMatch);
    ok(result.isClean);
  });

  void it("classifies safe-switch when same SHA but different branch", () => {
    // Create another branch at same commit
    run(repoPath, "git", ["branch", "feature-a", "main"]);

    // Switch to a different branch
    run(repoPath, "git", ["checkout", "feature-a"]);

    const entry = makeSnapshotEntry(repoPath, "main", headSha);
    const result = classifyRepoDrift(entry, repo);
    strictEqual(result.classification, "safe-switch");
    ok(result.shaMatch);
    ok(!result.branchMatch);
    ok(result.isClean);

    // Switch back
    run(repoPath, "git", ["checkout", "main"]);
  });

  void it("classifies dirty-blocked when tree is dirty", () => {
    writeFileSync(resolve(repoPath, "untracked.txt"), "dirty");
    const entry = makeSnapshotEntry(repoPath, "main", headSha);
    const result = classifyRepoDrift(entry, repo);
    strictEqual(result.classification, "dirty-blocked");
    ok(!result.isClean);

    // Clean up
    rmSync(resolve(repoPath, "untracked.txt"));
  });

  void it("classifies missing-repo when repo is null", () => {
    const entry = makeSnapshotEntry("/nonexistent/repo", "main", "abc123");
    const result = classifyRepoDrift(entry, null);
    strictEqual(result.classification, "missing-repo");
    ok(!result.repoExists);
  });

  void it("classifies occupied when different commit on occupied branch", () => {
    // Make a new commit on main so SHA differs
    writeFileSync(resolve(repoPath, "new-file.txt"), "new content");
    run(repoPath, "git", ["add", "."]);
    run(repoPath, "git", ["commit", "-m", "new commit"]);

    // Snapshot points to old headSha on main — but main IS the current branch
    const entry = makeSnapshotEntry(repoPath, "main", headSha);
    const result = classifyRepoDrift(entry, repo);

    strictEqual(result.classification, "occupied");
    ok(result.isClean);
    ok(!result.shaMatch);
    strictEqual(result.occupiedBy, repoPath);

    // Reset back
    run(repoPath, "git", ["reset", "--hard", "HEAD~1"]);
  });

  void it("classifies create-worktree when different commit on a different clean branch", () => {
    // Create branch 'feature-b' at headSha
    run(repoPath, "git", ["branch", "feature-b", headSha]);
    // Make a new commit on main so SHA differs
    writeFileSync(resolve(repoPath, "another-file.txt"), "more content");
    run(repoPath, "git", ["add", "."]);
    run(repoPath, "git", ["commit", "-m", "another commit"]);

    // Snapshot points to feature-b at headSha; main is current at new SHA
    // feature-b is NOT occupied and tree is clean
    const entry = makeSnapshotEntry(repoPath, "feature-b", headSha);
    const result = classifyRepoDrift(entry, repo);

    strictEqual(result.classification, "create-worktree");
    ok(result.isClean);
    ok(!result.shaMatch);
    strictEqual(result.occupiedBy, null);

    // Reset
    run(repoPath, "git", ["reset", "--hard", "HEAD~1"]);
    run(repoPath, "git", ["branch", "-D", "feature-b"]);
  });

  void it("classifies dirty-blocked for detached HEAD with dirty tree", () => {
    // Go detached
    run(repoPath, "git", ["checkout", "--detach", "HEAD"]);

    // Dirty the tree
    writeFileSync(resolve(repoPath, "ambiguous-file.txt"), "ambiguous");

    const bogusSha = "0000000000000000000000000000000000000000";
    const entry = makeSnapshotEntry(repoPath, "main", bogusSha);
    const result = classifyRepoDrift(entry, repo);

    strictEqual(result.classification, "dirty-blocked");
    ok(!result.shaMatch);
    ok(!result.isClean);

    // Clean up and get back
    rmSync(resolve(repoPath, "ambiguous-file.txt"));
    run(repoPath, "git", ["checkout", "main"]);
  });
});

void describe("analyzeDrift", () => {
  let repoPath: string;
  let headSha: string;
  let repo: Repository;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });

    repoPath = initRepo(TMP, "analyze-target");
    headSha = getHeadSha(repoPath);
    repo = makeRepo(repoPath, "analyze-target");
    registerRepos([repo]);
  });

  after(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    _resetGitPath();
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("analyzes drift for a snapshot", () => {
    const snapshot: SnapshotSchema = {
      version: 1,
      meta: {
        createdAt: new Date().toISOString(),
        label: "test-snapshot",
        workspaceFilePath: "/tmp/test.code-workspace",
        source: "manual",
      },
      repos: [makeSnapshotEntry(repoPath, "main", headSha)],
      repoCount: 1,
    };

    const drift = analyzeDrift(snapshot);
    ok(drift);
    strictEqual(drift.repos.length, 1);
    strictEqual(drift.repos[0]!.repoId, "test-main");
  });
});

void describe("generateRestorePlan", () => {
  void it("generates a plan from drift results", () => {
    const drift: DriftResult = {
      snapshotId: "test-snapshot",
      repos: [
        {
          repoId: "repo-a",
          rootPath: "/tmp/repo-a",
          classification: "satisfied",
          explanation: "Already at snapshot state",
          repoExists: true,
          isClean: true,
          currentSha: "abc",
          snapshotSha: "abc",
          currentBranch: "main",
          snapshotBranch: "main",
          branchMatch: true,
          shaMatch: true,
          occupiedBy: null,
        },
        {
          repoId: "repo-b",
          rootPath: "/tmp/repo-b",
          classification: "safe-switch",
          explanation: "Different branch, same commit",
          repoExists: true,
          isClean: true,
          currentSha: "abc",
          snapshotSha: "abc",
          currentBranch: "feature",
          snapshotBranch: "main",
          branchMatch: false,
          shaMatch: true,
          occupiedBy: null,
        },
        {
          repoId: "repo-c",
          rootPath: "/tmp/repo-c",
          classification: "dirty-blocked",
          explanation: "Dirty tree",
          repoExists: true,
          isClean: false,
          currentSha: "def",
          snapshotSha: "abc",
          currentBranch: "main",
          snapshotBranch: "main",
          branchMatch: false,
          shaMatch: false,
          occupiedBy: null,
        },
      ],
      summary: {
        satisfied: 1,
        safeSwitch: 1,
        createWorktree: 0,
        preferred: 0,
        dirtyBlocked: 1,
        occupied: 0,
        fetchNeeded: 0,
        missingRef: 0,
        missingRepo: 0,
        ambiguous: 0,
      },
    };

    const plan = generateRestorePlan(drift);
    ok(plan);
    strictEqual(plan.repos.length, 3);
    strictEqual(plan.summary.total, 3);
    strictEqual(plan.summary.autoExecutable, 2);
    strictEqual(plan.summary.requiresManual, 1);
    ok(!plan.canRestoreAll);

    // Check individual actions
    const satisfiedAction = plan.repos.find((r) => r.repoId === "repo-a");
    ok(satisfiedAction);
    strictEqual(satisfiedAction!.classification, "satisfied");
    ok(satisfiedAction!.canAutoExecute);

    const blockedAction = plan.repos.find((r) => r.repoId === "repo-c");
    ok(blockedAction);
    strictEqual(blockedAction!.classification, "dirty-blocked");
    ok(!blockedAction!.canAutoExecute);
  });

  void it("reports canRestoreAll when no manual steps needed", () => {
    const drift: DriftResult = {
      snapshotId: "test-snapshot",
      repos: [
        {
          repoId: "repo-a",
          rootPath: "/tmp/repo-a",
          classification: "satisfied",
          explanation: "Done",
          repoExists: true,
          isClean: true,
          currentSha: "abc",
          snapshotSha: "abc",
          currentBranch: "main",
          snapshotBranch: "main",
          branchMatch: true,
          shaMatch: true,
          occupiedBy: null,
        },
      ],
      summary: {
        satisfied: 1,
        safeSwitch: 0,
        createWorktree: 0,
        preferred: 0,
        dirtyBlocked: 0,
        occupied: 0,
        fetchNeeded: 0,
        missingRef: 0,
        missingRepo: 0,
        ambiguous: 0,
      },
    };

    const plan = generateRestorePlan(drift);
    ok(plan.canRestoreAll);
  });
});
