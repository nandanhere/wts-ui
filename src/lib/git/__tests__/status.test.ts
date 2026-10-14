/**
 * Tests for Git status reader — porcelain-v2, branches, remotes, worktrees.
 *
 * Creates disposable repos with controlled state.
 * Run: node --experimental-strip-types --test src/lib/git/__tests__/status.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { getRepoStatus, clearStatusCache, readPorcelainV2 } from "../status";
import { _registerRepoPath, _clearRepoPaths } from "../runner";
import type { Repository } from "@/lib/workspace/types";

const TMP = resolve(tmpdir(), "dashboard-git-status-test");

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

function makeRepo(id: string, rootPath: string): Repository {
  return {
    id,
    rootPath,
    commonDir: resolve(rootPath, ".git"),
    worktree: { path: rootPath, branch: "main" },
    folderMembership: ["test"],
  };
}

void describe("Status Reader", () => {
  let repoPath: string;
  let repo: Repository;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    clearStatusCache();
    _clearRepoPaths();

    repoPath = initRepo(resolve(TMP, "status-repo"));
    // Use realpath-resolved path for canonical check
    const canonical = realpathSync(repoPath);
    _registerRepoPath(canonical);

    repo = makeRepo("status-test-repo", repoPath);
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
    _clearRepoPaths();
  });

  void it("reads basic status with porcelain v2", () => {
    const status = getRepoStatus(repo);
    strictEqual(status.repoId, "status-test-repo");
    strictEqual(status.currentBranch, "main");
    ok(status.headOid.length > 0, "should have HEAD oid");
    ok(Array.isArray(status.localBranches));
    ok(Array.isArray(status.remotes));
    ok(Array.isArray(status.worktrees));
  });

  void it("detects staged changes", () => {
    // Create a change and stage it
    writeFileSync(resolve(repoPath, "staged.txt"), "staged content");
    run(repoPath, "git", ["add", "staged.txt"]);

    const status = getRepoStatus(repo, { ttlMs: 0 }); // bypass cache
    ok(status.v2Status !== null);
    ok(status.v2Status.staged >= 1);

    // Clean up
    run(repoPath, "git", ["reset", "HEAD", "staged.txt"]);
  });

  void it("detects unstaged changes", () => {
    // Modify a tracked file
    writeFileSync(resolve(repoPath, "README.md"), "# modified");

    const status = getRepoStatus(repo, { ttlMs: 0 });
    ok(status.v2Status !== null);
    ok(status.v2Status.unstaged >= 1);

    // Clean up
    run(repoPath, "git", ["checkout", "README.md"]);
  });

  void it("detects untracked files", () => {
    writeFileSync(resolve(repoPath, "untracked.txt"), "new file");

    const status = getRepoStatus(repo, { ttlMs: 0 });
    ok(status.v2Status !== null);
    ok(status.v2Status.untracked >= 1);

    // Clean up
    run(repoPath, "git", ["clean", "-f"]);
  });

  void it("reads local branches", () => {
    const status = getRepoStatus(repo, { ttlMs: 0 });
    const mains = status.localBranches.filter((b) => b.name === "main");
    ok(mains.length >= 1);
    strictEqual(mains[0]!.isCurrent, true);
  });

  void it("reads worktrees (at least the primary)", () => {
    const status = getRepoStatus(repo, { ttlMs: 0 });
    ok(status.worktrees.length >= 1);
    const primary = status.worktrees.find((w) => w.isPrimary);
    ok(primary, "should have primary worktree");
    ok(primary!.path.length > 0);
  });

  void it("returns cache hit on repeated calls", () => {
    const status1 = getRepoStatus(repo);
    const status2 = getRepoStatus(repo);
    strictEqual(status1.cachedAt, status2.cachedAt, "should return cached data");
  });

  void it("reads porcelain v2 directly", () => {
    const v2 = readPorcelainV2(repoPath);
    ok(v2 !== null);
    ok(v2.branch.headOid.length > 0);
    ok(v2.branch.ref.includes("main") || v2.branch.ref === "(detached)");
  });

  void it("handles errors gracefully for invalid repos", () => {
    _clearRepoPaths();
    const badRepo: Repository = {
      id: "bad",
      rootPath: resolve(TMP, "nonexistent"),
      commonDir: "",
      worktree: null,
      folderMembership: [],
    };
    const status = getRepoStatus(badRepo);
    ok(status.errors.length > 0, "should have error entries");
    // Re-register
    const canonical = realpathSync(repoPath);
    _registerRepoPath(canonical);
  });
});
