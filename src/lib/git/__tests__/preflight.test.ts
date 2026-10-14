/**
 * Tests for preflight checks — validate blockers, warnings, allowed state.
 *
 * Creates disposable repos with bare remotes to test:
 * - Clean vs dirty tree
 * - Branch occupancy across worktrees
 * - Remote tracking branch detection
 * - Ref validation
 *
 * Run: node --experimental-strip-types --test src/lib/git/__tests__/preflight.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { preflightFetch, preflightSwitch, preflightWorktreeCreate, preflightWorktreeRemove, validateRef } from "../preflight";
import { _registerRepoPath, _clearRepoPaths } from "../runner";
import { clearStatusCache } from "../status";
import type { Repository } from "@/lib/workspace/types";

const TMP = resolve(tmpdir(), "dashboard-git-preflight-test");

function run(cwd: string, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd, stdio: "pipe", timeout: 15000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  run(dir, "git", ["init", "-b", "main"]);
  run(dir, "git", ["config", "user.email", "test@example.test"]);
  run(dir, "git", ["config", "user.name", "Test"]);
  writeFileSync(resolve(dir, "README.md"), "# test");
  run(dir, "git", ["add", "."]);
  run(dir, "git", ["commit", "-m", "initial"]);
  return dir;
}

function initBareRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  run(dir, "git", ["init", "--bare"]);
  return dir;
}

function makeRepo(id: string, rootPath: string): Repository {
  return {
    id,
    rootPath,
    commonDir: resolve(rootPath, ".git"),
    worktree: { path: rootPath, branch: "main" },
    folderMembership: ["test"],
  };
}

void describe("Preflight", () => {
  let repoPath: string;
  let barePath: string;
  let repo: Repository;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    clearStatusCache();
    _clearRepoPaths();

    repoPath = initRepo(resolve(TMP, "preflight-repo"));
    barePath = initBareRepo(resolve(TMP, "preflight-remote.git"));

    // Add remote
    run(repoPath, "git", ["remote", "add", "origin", barePath]);
    run(repoPath, "git", ["push", "origin", "main"]);

    const canonical = realpathSync(repoPath);
    _registerRepoPath(canonical);
    repo = makeRepo("preflight-repo", repoPath);
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
    _clearRepoPaths();
  });

  /* ---- Fetch ---- */

  void it("allows fetch to known remote", () => {
    const check = preflightFetch(repo, "origin");
    strictEqual(check.allowed, true);
    strictEqual(check.action, "fetch");
    strictEqual(check.target, "origin");
    strictEqual(check.blockers.length, 0);
  });

  void it("blocks fetch to unknown remote", () => {
    const check = preflightFetch(repo, "nonexistent");
    strictEqual(check.allowed, false);
    ok(check.blockers.some((b) => b.includes("not configured")));
  });

  /* ---- Switch ---- */

  void it("allows switch to existing local branch", () => {
    // Create another branch
    run(repoPath, "git", ["branch", "develop"]);

    const check = preflightSwitch(repo, "develop");
    strictEqual(check.allowed, true);
    strictEqual(check.blockers.length, 0);
  });

  void it("blocks switch to non-existent branch without createTracking", () => {
    const check = preflightSwitch(repo, "nonexistent-branch");
    strictEqual(check.allowed, false);
    ok(check.blockers.some((b) => b.includes("does not exist")));
  });

  void it("allows switch with createTracking for remote-existing branch", () => {
    // Create a branch on remote
    run(repoPath, "git", ["checkout", "-b", "feature-from-remote"]);
    run(repoPath, "git", ["push", "origin", "feature-from-remote"]);
    run(repoPath, "git", ["checkout", "main"]);

    // Delete local branch
    run(repoPath, "git", ["branch", "-D", "feature-from-remote"]);

    const check = preflightSwitch(repo, "feature-from-remote", true);
    strictEqual(check.allowed, true);
    ok(check.warnings.some((w) => w.includes("tracking")), "should warn about tracking branch creation");
  });

  void it("blocks switch when tree is dirty", () => {
    // Make a dirty tree
    writeFileSync(resolve(repoPath, "dirty.txt"), "dirty");

    const check = preflightSwitch(repo, "main");
    strictEqual(check.allowed, false);
    ok(check.blockers.some((b) => b.includes("not clean")), "should block due to dirty tree");

    // Clean up
    run(repoPath, "git", ["clean", "-f"]);
  });

  void it("rejects switch to invalid ref names", () => {
    const check = preflightSwitch(repo, "branch; rm -rf /");
    strictEqual(check.allowed, false);
    ok(check.blockers.some((b) => b.includes("Invalid ref")));
  });

  /* ---- Worktree Create ---- */

  void it("allows worktree create for new branch", () => {
    const check = preflightWorktreeCreate(repo, "worktree-feature");
    strictEqual(check.allowed, true);
  });

  void it("blocks worktree create for occupied branch", () => {
    const check = preflightWorktreeCreate(repo, "main");
    strictEqual(check.allowed, false);
    ok(check.blockers.some((b) => b.includes("already checked out")));
  });

  void it("rejects worktree create with invalid branch names", () => {
    const check = preflightWorktreeCreate(repo, "branch; ls");
    strictEqual(check.allowed, false);
    ok(check.blockers.some((b) => b.includes("Invalid ref") || b.includes("disallowed")));
  });

  /* ---- Worktree Remove ---- */

  void it("blocks removal of primary worktree", () => {
    const check = preflightWorktreeRemove(repo, repoPath);
    strictEqual(check.allowed, false);
    ok(check.blockers.some((b) => b.includes("primary")), "should block primary worktree removal");
  });

  void it("blocks removal of unknown worktree path", () => {
    const check = preflightWorktreeRemove(repo, "/nonexistent/path");
    strictEqual(check.allowed, false);
    ok(check.blockers.some((b) => b.includes("not a registered worktree")));
  });

  /* ---- Ref validation ---- */

  void it("validateRef rejects shell injection", () => {
    ok(validateRef("main; rm -rf /") !== null);
    ok(validateRef("$(cat /etc/passwd)") !== null);
    ok(validateRef("`echo pwned`") !== null);
    ok(validateRef("") !== null);
  });

  void it("validateRef allows valid branch names", () => {
    strictEqual(validateRef("main"), null);
    strictEqual(validateRef("feature/my-feature"), null);
    strictEqual(validateRef("fix/SHARP-123"), null);
    strictEqual(validateRef("v1.2.3"), null);
  });
});
