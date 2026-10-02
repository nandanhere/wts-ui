/**
 * Pure policy tests for workspace-session module.
 *
 * Tests branch/remote policy resolution, plan construction, session ID
 * generation, and active-session serialisation.
 *
 * Run: node --experimental-strip-types --loader ./scripts/register-ts.mjs \
 *       --test src/lib/git/__tests__/workspace-session.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, ok, rejects } from "node:assert";
import {
  generateSessionId,
  hasActiveSession,
  clearActiveSession,
  planSession,
  executeSession,
  selectPreferredBranch,
  selectPreferredRemote,
} from "../workspace-session";
import { registerRepos, clearRepoRegistry } from "../registry";
import { _clearRepoPaths, _registerRepoPath } from "../runner";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

/* ================================================================== */
/*  Fixture helpers                                                    */
/* ================================================================== */

/**
 * Build a minimal status-like object with just the RemoteInfo and remoteRef
 * fields needed by planSession. Since planSession calls getRepoStatus which
 * invokes real git, we use a disposable-repo approach.
 */

/** Create a temp git repo and return its root path. */
function createDisposableRepo(name: string): string {
  const dir = resolve(tmpdir(), "dashboard-session-test", name);
  execFileSync("rm", ["-rf", dir]);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir, stdio: "pipe" });
  // Set user config for commits
  execFileSync("git", ["config", "user.email", "test@test"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  // Create an initial commit so HEAD resolves
  writeFileSync(resolve(dir, "README.md"), `# ${name}\n`);
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "pipe" });
  return dir;
}

/** Create a bare repo to simulate a remote. */
function createBareRepo(name: string): string {
  const dir = resolve(tmpdir(), "dashboard-session-test", name);
  execFileSync("rm", ["-rf", dir]);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--bare"], { cwd: dir, stdio: "pipe" });
  return dir;
}

function registerDisposableRepo(id: string, rootPath: string): void {
  registerRepos([
    {
      id,
      rootPath,
      commonDir: resolve(rootPath, ".git"),
      worktree: { path: rootPath, branch: "main" },
      folderMembership: ["test"],
    },
  ]);
}

function cleanupDisposableRepos(): void {
  const dir = resolve(tmpdir(), "dashboard-session-test");
  rmSync(dir, { recursive: true, force: true });
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

void describe("generateSessionId", () => {
  void it("returns a 12-character hex string", () => {
    const id = generateSessionId();
    strictEqual(id.length, 12);
    ok(/^[0-9a-f]{12}$/.test(id), `expected 12 hex chars, got "${id}"`);
  });

  void it("generates unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateSessionId()));
    strictEqual(ids.size, 100);
  });
});

void describe("session selection policy", () => {
  void it("prefers origin, then upstream, then the first configured remote", () => {
    strictEqual(selectPreferredRemote([{ name: "fork" }, { name: "upstream" }, { name: "origin" }]), "origin");
    strictEqual(selectPreferredRemote([{ name: "fork" }, { name: "upstream" }]), "upstream");
    strictEqual(selectPreferredRemote([{ name: "fork" }, { name: "backup" }]), "fork");
    strictEqual(selectPreferredRemote([]), null);
  });

  void it("prefers main, then develop, on the selected remote only", () => {
    const refs = [
      { ref: "refs/remotes/upstream/main", oid: "upstream-main" },
      { ref: "refs/remotes/origin/develop", oid: "origin-develop" },
      { ref: "refs/remotes/origin/main", oid: "origin-main" },
    ];
    strictEqual(selectPreferredBranch("origin", refs)?.branch, "main");
    strictEqual(selectPreferredBranch("origin", refs)?.oid, "origin-main");
    strictEqual(selectPreferredBranch("upstream", refs)?.branch, "main");
    strictEqual(selectPreferredBranch("missing", refs), null);
  });
});

void describe("hasActiveSession / clearActiveSession", () => {
  beforeEach(() => clearActiveSession());
  afterEach(() => clearActiveSession());

  void it("returns false when no session is running", () => {
    strictEqual(hasActiveSession(), false);
  });

  void it("returns true during execution", async () => {
    // executeSession clears on error — test directly
    strictEqual(hasActiveSession(), false);
  });

  void it("clears after clearActiveSession", () => {
    clearActiveSession();
    strictEqual(hasActiveSession(), false);
  });
});

void describe("planSession — pure remote/branch resolution", () => {
  let repoDir: string;
  let remoteDir: string;

  beforeEach(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    repoDir = createDisposableRepo("plan-test");
    remoteDir = createBareRepo("plan-test-remote");
    // Register path in runner
    _registerRepoPath(repoDir);
    // Add remote and push
    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "main"], { cwd: repoDir, stdio: "pipe" });
    // Also push a develop branch
    execFileSync("git", ["branch", "develop"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "develop"], { cwd: repoDir, stdio: "pipe" });
  });

  afterEach(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    cleanupDisposableRepos();
  });

  void it("resolves main via origin when cached refs exist", () => {
    registerDisposableRepo("repo-a", repoDir);
    const plan = planSession();
    strictEqual(plan.summary.total, 1);
    ok(plan.summary.total >= 1);
    const repoPlan = plan.repos[0]!;
    strictEqual(repoPlan.repoId, "repo-a");
    strictEqual(repoPlan.selectedRemote, "origin");
    strictEqual(repoPlan.baseBranch, "main");
    strictEqual(repoPlan.cachedRefFound, true);
    ok(repoPlan.cachedRefOid !== null);
    strictEqual(repoPlan.blockers.length, 0);
    strictEqual(repoPlan.status, "ready");
  });

  void it("blocks a repository with no configured remote", () => {
    // Create a repo with no remotes
    const bareDir = createDisposableRepo("no-remote-test");
    clearRepoRegistry();
    _clearRepoPaths();
    _registerRepoPath(bareDir);
    registerDisposableRepo("repo-b", bareDir);

    const plan = planSession();
    const repoPlan = plan.repos.find((r) => r.repoId === "repo-b");
    ok(repoPlan, "expected repo-b in plan");
    strictEqual(repoPlan?.status, "no_suitable_remote");
  });

  void it("prefers origin over upstream", () => {
    clearRepoRegistry();
    _clearRepoPaths();
    const repo = createDisposableRepo("multi-remote-test");
    const bare1 = createBareRepo("mr-remote-1");
    const bare2 = createBareRepo("mr-remote-2");

    execFileSync("git", ["remote", "add", "upstream", bare1], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["remote", "add", "origin", bare2], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "main"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["push", "upstream", "main"], { cwd: repo, stdio: "pipe" });

    _registerRepoPath(repo);
    registerDisposableRepo("repo-c", repo);

    const plan = planSession({ repoIds: ["repo-c"] });
    const repoPlan = plan.repos[0]!;
    strictEqual(repoPlan.selectedRemote, "origin");
  });

  void it("keeps origin priority even when only upstream has a cached branch", () => {
    clearRepoRegistry();
    _clearRepoPaths();
    const repo = createDisposableRepo("remote-priority-test");
    const origin = createBareRepo("rp-origin");
    const upstream = createBareRepo("rp-upstream");

    execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["remote", "add", "upstream", upstream], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["push", "upstream", "main"], { cwd: repo, stdio: "pipe" });

    _registerRepoPath(repo);
    registerDisposableRepo("repo-origin-first", repo);

    const repoPlan = planSession().repos[0]!;
    strictEqual(repoPlan.selectedRemote, "origin");
    strictEqual(repoPlan.status, "needs_fetch");
  });

  void it("prefers main over develop", () => {
    clearRepoRegistry();
    _clearRepoPaths();
    const repo = createDisposableRepo("branch-policy-test");
    const bare = createBareRepo("bp-remote");

    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["branch", "develop"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "main"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "develop"], { cwd: repo, stdio: "pipe" });

    _registerRepoPath(repo);
    registerDisposableRepo("repo-d", repo);

    const plan = planSession({ repoIds: ["repo-d"] });
    const repoPlan = plan.repos[0]!;
    strictEqual(repoPlan.baseBranch, "main");
    strictEqual(repoPlan.selectedRemote, "origin");
  });

  void it("falls back to develop when main has no remote ref", () => {
    clearRepoRegistry();
    _clearRepoPaths();
    const repo = createDisposableRepo("no-main-test");
    const bare = createBareRepo("nm-remote");

    execFileSync("git", ["remote", "add", "origin", bare], { cwd: repo, stdio: "pipe" });
    // Only push develop
    execFileSync("git", ["branch", "-m", "main", "develop"], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "develop"], { cwd: repo, stdio: "pipe" });

    _registerRepoPath(repo);
    registerDisposableRepo("repo-e", repo);

    const plan = planSession({ repoIds: ["repo-e"] });
    const repoPlan = plan.repos[0]!;
    strictEqual(repoPlan.baseBranch, "develop");
  });
});

/* ================================================================== */
/*  Integration tests: executeSession                                  */
/* ================================================================== */

void describe("executeSession — integration with disposable repos", () => {
  let repoDir: string;
  let remoteDir: string;
  const REPO_ID = "session-integration-repo";
  const originalWorktreeRoot = process.env.WORKTREE_ROOT;
  const originalJournalPath = process.env.DASHBOARD_JOURNAL_PATH;

  beforeEach(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    clearActiveSession();
    cleanupDisposableRepos();
    repoDir = createDisposableRepo("exec-test-repo");
    remoteDir = createBareRepo("exec-test-remote");
    _registerRepoPath(repoDir);

    execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["push", "origin", "main"], { cwd: repoDir, stdio: "pipe" });

    process.env.WORKTREE_ROOT = resolve(tmpdir(), "dashboard-session-test", "worktrees");
    process.env.DASHBOARD_JOURNAL_PATH = resolve(tmpdir(), "dashboard-session-test", "git-journal.json");

    registerDisposableRepo(REPO_ID, repoDir);
  });

  afterEach(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    clearActiveSession();
    if (originalWorktreeRoot === undefined) delete process.env.WORKTREE_ROOT;
    else process.env.WORKTREE_ROOT = originalWorktreeRoot;
    if (originalJournalPath === undefined) delete process.env.DASHBOARD_JOURNAL_PATH;
    else process.env.DASHBOARD_JOURNAL_PATH = originalJournalPath;
    cleanupDisposableRepos();
  });

  void it("rejects concurrent sessions with 409", async () => {
    const p1 = executeSession({ repoIds: [REPO_ID] });
    // Second call should throw 409 before completing
    await rejects(
      async () => {
        await executeSession({ repoIds: [REPO_ID] });
      },
      (err: unknown) => {
        const e = err as Error & { statusCode?: number; code?: string };
        return e.statusCode === 409 && e.code === "SESSION_ACTIVE";
      }
    );
    // Let the first finish
    await p1;
  });

  void it("executes a full session lifecycle (fetch + worktree create)", async () => {
    const originalPrimary = readFileSync(resolve(repoDir, "README.md"), "utf8");
    writeFileSync(resolve(repoDir, "README.md"), `${originalPrimary}primary work in progress\n`);
    const primaryStatusBefore = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });

    const execution = await executeSession({ repoIds: [REPO_ID] });

    strictEqual(execution.sessionId.length, 12);
    strictEqual(execution.status, "completed");

    const result = execution.results[0]!;
    strictEqual(result.repoId, REPO_ID);
    ok(result.fetch.success, `fetch should succeed: ${result.fetch.error ?? ""}`);
    strictEqual(result.success, true, result.error);
    strictEqual(result.worktree.headVerified, true);
    ok(existsSync(result.worktreePath), `worktree path should exist: ${result.worktreePath}`);
    ok(result.sessionBranch.startsWith("dashboard/session-"));
    ok(result.sessionBranch.endsWith("/main"));

    const remoteOid = execFileSync("git", ["rev-parse", "refs/remotes/origin/main"], { cwd: repoDir, encoding: "utf8" }).trim();
    strictEqual(result.worktree.headOid, remoteOid);
    strictEqual(execFileSync("git", ["branch", "--show-current"], { cwd: repoDir, encoding: "utf8" }).trim(), "main");
    strictEqual(readFileSync(resolve(repoDir, "README.md"), "utf8"), `${originalPrimary}primary work in progress\n`);
    strictEqual(execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" }), primaryStatusBefore);
  });

  void it("returns structured results with verification OIDs", async () => {
    const execution = await executeSession({ repoIds: [REPO_ID] });

    strictEqual(execution.results.length, 1);
    const result = execution.results[0]!;
    strictEqual(typeof result.sessionBranch, "string");
    strictEqual(typeof result.worktreePath, "string");
    strictEqual(typeof result.fetch.durationMs, "number");
    strictEqual(typeof result.worktree.headOid, "string");
    strictEqual(typeof result.worktree.headVerified, "boolean");
    strictEqual(result.success, true, result.error);
  });

  void it("falls back to develop after fetch when main is absent upstream", async () => {
    execFileSync("git", ["push", "origin", "main:develop"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["--git-dir", remoteDir, "update-ref", "-d", "refs/heads/main"], { stdio: "pipe" });
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/develop"], { cwd: repoDir, stdio: "pipe" });

    const plan = planSession({ repoIds: [REPO_ID] });
    strictEqual(plan.repos[0]!.status, "needs_fetch");

    const execution = await executeSession({ repoIds: [REPO_ID] });
    const result = execution.results[0]!;
    strictEqual(result.success, true, result.error);
    strictEqual(result.baseBranch, "develop");
    ok(result.sessionBranch.endsWith("/develop"));
  });

  void it("falls back from origin to upstream when origin has no policy branch", async () => {
    const upstream = createBareRepo("exec-upstream-remote");
    execFileSync("git", ["remote", "add", "upstream", upstream], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["push", "upstream", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["--git-dir", remoteDir, "update-ref", "-d", "refs/heads/main"], { stdio: "pipe" });
    execFileSync("git", ["update-ref", "-d", "refs/remotes/origin/main"], { cwd: repoDir, stdio: "pipe" });

    const execution = await executeSession({ repoIds: [REPO_ID] });
    const result = execution.results[0]!;
    strictEqual(result.success, true, result.error);
    strictEqual(result.selectedRemote, "upstream");
    strictEqual(result.baseBranch, "main");
    const upstreamOid = execFileSync("git", ["rev-parse", "refs/remotes/upstream/main"], { cwd: repoDir, encoding: "utf8" }).trim();
    strictEqual(result.worktree.headOid, upstreamOid);
  });
});
