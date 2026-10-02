import { afterEach, describe, it } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activateSnapshot, planActivation } from "@/lib/snapshot/activate";
import { clearRepoRegistry, registerRepos } from "@/lib/git/registry";
import type {
  DriftClass,
  DriftResult,
  RepoSnapshot,
  SnapshotSchema,
} from "@/lib/snapshot/types";
import type { Repository } from "@/lib/workspace/types";

const cleanupPaths: string[] = [];
const originalWorktreeRoot = process.env.WORKTREE_ROOT;
const originalJournalPath = process.env.DASHBOARD_JOURNAL_PATH;

afterEach(() => {
  clearRepoRegistry();
  if (originalWorktreeRoot === undefined) delete process.env.WORKTREE_ROOT;
  else process.env.WORKTREE_ROOT = originalWorktreeRoot;
  if (originalJournalPath === undefined) delete process.env.DASHBOARD_JOURNAL_PATH;
  else process.env.DASHBOARD_JOURNAL_PATH = originalJournalPath;
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

function snapshotEntry(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return {
    repoId: "repo-a",
    rootPath: "/repos/repo-a",
    identity: { commonDir: "/repos/repo-a/.git", remoteNames: [], remotePathHint: null },
    head: {
      symbolicRef: "refs/heads/feature",
      detached: false,
      sha: "a".repeat(40),
      upstream: null,
    },
    worktree: { path: "/repos/repo-a", logicalSlot: "primary" },
    dirty: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    ...overrides,
  };
}

function snapshot(entry = snapshotEntry()): SnapshotSchema {
  return {
    version: 1,
    meta: {
      createdAt: "2026-07-14T00:00:00.000Z",
      label: "test combination",
      workspaceFilePath: "/workspaces/test.code-workspace",
      source: "manual",
    },
    repos: [entry],
    repoCount: 1,
  };
}

function drift(classification: DriftClass): DriftResult {
  return {
    snapshotId: "snapshot-a",
    repos: [
      {
        repoId: "repo-a",
        rootPath: "/repos/repo-a",
        classification,
        explanation: `${classification} explanation`,
        repoExists: classification !== "missing-repo",
        isClean: classification !== "dirty-blocked",
        currentSha: "b".repeat(40),
        snapshotSha: "a".repeat(40),
        currentBranch: "main",
        snapshotBranch: "feature",
        branchMatch: false,
        shaMatch: classification === "satisfied" || classification === "safe-switch",
        occupiedBy: classification === "occupied" ? "/worktrees/feature" : null,
      },
    ],
    summary: {
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
    },
  };
}

function git(repoPath: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
}

function disposableRepo(): { repo: Repository; snapshot: SnapshotSchema; featureSha: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dashboard-activate-")));
  cleanupPaths.push(root);
  process.env.DASHBOARD_JOURNAL_PATH = join(root, "git-journal.json");
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "dashboard@example.invalid");
  git(root, "config", "user.name", "Dashboard Test");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt");
  git(root, "commit", "-m", "base");
  git(root, "branch", "feature");
  const featureSha = git(root, "rev-parse", "feature");
  writeFileSync(join(root, "main.txt"), "main\n");
  git(root, "add", "main.txt");
  git(root, "commit", "-m", "main advance");

  const commonDir = realpathSync(join(root, ".git"));
  const repo: Repository = {
    id: "repo-a",
    rootPath: root,
    commonDir,
    worktree: { path: root, branch: "main" },
    folderMembership: ["repo-a"],
  };
  const entry = snapshotEntry({
    rootPath: root,
    identity: { commonDir, remoteNames: [], remotePathHint: null },
    head: { symbolicRef: "refs/heads/feature", detached: false, sha: featureSha, upstream: null },
    worktree: { path: root, logicalSlot: "primary" },
  });
  return { repo, snapshot: snapshot(entry), featureSha };
}

void describe("planActivation", () => {
  void it("maps satisfied state to an idempotent no-op", () => {
    const [plan] = planActivation(snapshot(), drift("satisfied"));
    deepStrictEqual(
      { action: plan.action, executable: plan.executable },
      { action: "none", executable: true }
    );
  });

  void it("maps a safe switch to the existing switch primitive", () => {
    const [plan] = planActivation(snapshot(), drift("safe-switch"));
    strictEqual(plan.action, "switch");
    strictEqual(plan.executable, true);
  });

  void it("maps divergent clean state to confined worktree creation", () => {
    const [plan] = planActivation(snapshot(), drift("create-worktree"));
    strictEqual(plan.action, "create-worktree");
    strictEqual(plan.executable, true);
  });

  for (const classification of [
    "dirty-blocked",
    "occupied",
    "missing-ref",
    "missing-repo",
    "ambiguous",
  ] as const) {
    void it(`blocks ${classification} without a mutation`, () => {
      const [plan] = planActivation(snapshot(), drift(classification));
      strictEqual(plan.action, "none");
      strictEqual(plan.executable, false);
    });
  }

  void it("blocks remote-only branches instead of fetching automatically", () => {
    const [plan] = planActivation(snapshot(), drift("fetch-needed"));
    strictEqual(plan.executable, false);
    strictEqual(plan.explanation, "Remote-only branch requires an explicit fetch before activation.");
  });
});

void describe("activateSnapshot", () => {
  void it("reports an exact current snapshot state as already satisfied", async () => {
    const fixture = disposableRepo();
    git(fixture.repo.rootPath, "checkout", "feature");
    registerRepos([fixture.repo]);

    const result = await activateSnapshot("snapshot-a", fixture.snapshot);

    strictEqual(result.summary.alreadySatisfied, 1);
    strictEqual(result.summary.succeeded, 0);
    strictEqual(result.repos[0]!.status, "already-satisfied");
  });

  void it("switches branches only when the target remains at the captured commit", async () => {
    const fixture = disposableRepo();
    registerRepos([fixture.repo]);
    git(fixture.repo.rootPath, "reset", "--hard", fixture.featureSha);

    const result = await activateSnapshot("snapshot-a", fixture.snapshot);

    strictEqual(result.summary.succeeded, 1);
    strictEqual(result.repos[0]!.action, "switch");
    strictEqual(result.repos[0]!.status, "success");
    strictEqual(git(fixture.repo.rootPath, "branch", "--show-current"), "feature");
    strictEqual(git(fixture.repo.rootPath, "rev-parse", "HEAD"), fixture.featureSha);
  });

  void it("blocks a safe-switch candidate when the target branch moved", async () => {
    const fixture = disposableRepo();
    const advancedMain = git(fixture.repo.rootPath, "rev-parse", "main");
    git(fixture.repo.rootPath, "branch", "-f", "feature", advancedMain);
    git(fixture.repo.rootPath, "reset", "--hard", fixture.featureSha);
    registerRepos([fixture.repo]);

    const result = await activateSnapshot("snapshot-a", fixture.snapshot);

    strictEqual(result.summary.succeeded, 0);
    strictEqual(result.summary.blocked, 1);
    strictEqual(result.repos[0]!.status, "blocked");
    strictEqual(git(fixture.repo.rootPath, "branch", "--show-current"), "main");
  });

  void it("creates a confined worktree only at the exact captured commit", async () => {
    const fixture = disposableRepo();
    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "dashboard-worktrees-")));
    cleanupPaths.push(worktreeRoot);
    process.env.WORKTREE_ROOT = worktreeRoot;
    registerRepos([fixture.repo]);

    const result = await activateSnapshot("snapshot-a", fixture.snapshot);

    strictEqual(result.summary.succeeded, 1);
    strictEqual(result.summary.failed, 0);
    strictEqual(result.repos[0]!.action, "create-worktree");
    strictEqual(result.repos[0]!.status, "success");
    ok(result.repos[0]!.worktreePath?.startsWith(worktreeRoot));
    strictEqual(git(result.repos[0]!.worktreePath!, "rev-parse", "HEAD"), fixture.featureSha);
  });

  void it("blocks worktree creation when the branch moved after capture", async () => {
    const fixture = disposableRepo();
    const worktreeRoot = realpathSync(mkdtempSync(join(tmpdir(), "dashboard-worktrees-")));
    cleanupPaths.push(worktreeRoot);
    process.env.WORKTREE_ROOT = worktreeRoot;
    registerRepos([fixture.repo]);
    git(fixture.repo.rootPath, "branch", "-f", "feature", "main");

    const result = await activateSnapshot("snapshot-a", fixture.snapshot);

    strictEqual(result.summary.succeeded, 0);
    strictEqual(result.summary.blocked, 1);
    strictEqual(result.repos[0]!.status, "blocked");
    ok(result.repos[0]!.message.includes("no longer points"));
  });
});
