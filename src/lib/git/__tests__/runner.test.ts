/**
 * Tests for Git runner — shell-free execution, timeout, error normalisation.
 *
 * Run: node --experimental-strip-types --test src/lib/git/__tests__/runner.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  runGitSync,
  _resetGitPath,
  _registerRepoPath,
  _clearRepoPaths,
  normaliseError,
} from "../runner";
import type { GitResult, GitError } from "../types";

const TMP = resolve(tmpdir(), "dashboard-git-runner-test");

function run(cwd: string, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd, stdio: "pipe", timeout: 10000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  run(dir, "git", ["init", "-b", "main"]);
  writeFileSync(resolve(dir, "README.md"), "# test");
  run(dir, "git", ["add", "."]);
  run(dir, "git", ["commit", "-m", "initial"]);
  return dir;
}

void describe("GitRunner", () => {
  let repoPath: string;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    _resetGitPath();
    _clearRepoPaths();

    repoPath = resolve(TMP, "test-repo");
    initRepo(repoPath);
    // Use the canonical (realpath-resolved) path to match assertCanonical
    const canonical = realpathSync(repoPath);
    _registerRepoPath(canonical);
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
    _clearRepoPaths();
  });

  void it("runs a basic git command with argument array", () => {
    const r = runGitSync(["rev-parse", "HEAD"], {
      repoPath,
      timeout: 5000,
    });
    strictEqual(r.exitCode, 0);
    ok(r.stdout.trim().length > 0, "should output a commit hash");
    ok(typeof r.durationMs === "number");
  });

  void it("allows commands with registered paths", () => {
    _clearRepoPaths();
    const canonical = realpathSync(repoPath);
    _registerRepoPath(canonical);

    const r = runGitSync(["rev-parse", "HEAD"], {
      repoPath,
      timeout: 5000,
    });
    strictEqual(r.exitCode, 0);
  });

  void it("rejects non-existent repo path", () => {
    _clearRepoPaths();
    try {
      runGitSync(["status"], {
        repoPath: "/nonexistent/path",
        timeout: 5000,
      });
      ok(false, "should have thrown");
    } catch (err) {
      const e = err as GitError;
      strictEqual(e.code, "REPO_NOT_FOUND");
    }
  });

  void it("rejects unregistered path when other paths are registered", () => {
    _clearRepoPaths();
    const otherPath = resolve(TMP, "other-registered");
    mkdirSync(otherPath, { recursive: true });
    _registerRepoPath(realpathSync(otherPath));

    try {
      runGitSync(["status"], {
        repoPath,
        timeout: 5000,
      });
      ok(false, "should have thrown for unregistered path");
    } catch (err) {
      const e = err as GitError;
      strictEqual(e.code, "CANONICAL_PATH_MISMATCH");
    }
    _clearRepoPaths();
  });

  void it("allows commands when no paths registered (no restriction)", () => {
    _clearRepoPaths();
    const r = runGitSync(["rev-parse", "HEAD"], {
      repoPath,
      timeout: 5000,
    });
    strictEqual(r.exitCode, 0);
  });

  // Re-register for remaining tests
  function ensureRegistered() {
    _clearRepoPaths();
    _registerRepoPath(realpathSync(repoPath));
  }

  void it("handles git errors with non-zero exit", () => {
    ensureRegistered();
    const r = runGitSync(["log", "--invalid-flag"], {
      repoPath,
      timeout: 5000,
    });
    ok(r.exitCode !== 0);
    ok(r.stderr.length > 0 || r.stdout.length > 0);
  });

  void it("returns structured result with duration", () => {
    ensureRegistered();
    const r = runGitSync(["status", "--porcelain=v2", "--branch"], {
      repoPath,
      timeout: 5000,
    });
    strictEqual(r.exitCode, 0);
    ok(r.durationMs >= 0);
    ok(r.command.startsWith("git "));
  });

  void it("supports extra env vars", () => {
    ensureRegistered();
    const r = runGitSync(["config", "user.name"], {
      repoPath,
      timeout: 5000,
      env: { GIT_CONFIG_COUNT: "0" },
    });
    // Should still work (fallback to system config or repo config)
    ok(r.exitCode === 0 || r.exitCode === 1);
  });

  void it("normalises errors correctly", () => {
    const result: GitResult = {
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
      command: "git status",
      durationMs: 10,
    };
    const err = normaliseError(result);
    strictEqual(err.code, "REPO_NOT_FOUND");
  });

  void it("normalises dirty tree errors", () => {
    const result: GitResult = {
      exitCode: 1,
      stdout: "",
      stderr: "local changes detected; needs merge",
      command: "git checkout",
      durationMs: 10,
    };
    const err = normaliseError(result);
    strictEqual(err.code, "DIRTY_TREE");
  });

  void it("normalises worktree exists errors", () => {
    const result: GitResult = {
      exitCode: 1,
      stdout: "",
      stderr: "worktree 'foo' already exists",
      command: "git worktree add",
      durationMs: 10,
    };
    const err = normaliseError(result);
    strictEqual(err.code, "WORKTREE_EXISTS");
  });
});
