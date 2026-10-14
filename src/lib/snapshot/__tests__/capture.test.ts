/**
 * Tests for snapshot capture — extracting live repo state into domain models.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/snapshot/__tests__/capture.test.ts
 *
 * Creates disposable temporary git repos for testing capture functions.
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual, notStrictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  captureIdentity,
  captureHead,
  captureWorktree,
  captureDirtySummary,
  captureRepoSnapshot,
  captureSnapshot,
} from "@/lib/snapshot/capture";
import type { Repository } from "@/lib/workspace/types";
import { _clearRepoPaths, _setGitPath, _resetGitPath } from "@/lib/git/runner";
import { clearRepoRegistry, registerRepos } from "@/lib/git/registry";

const TMP = resolve(tmpdir(), "dashboard-capture-test");

function run(dir: string, cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, {
    cwd: dir,
    stdio: "pipe",
    timeout: 10000,
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${r.stderr.toString()}`
    );
  }
}

function initRepo(parent: string, name: string): string {
  const p = resolve(parent, name);
  mkdirSync(p, { recursive: true });
  run(p, "git", ["init", "-b", "main"]);
  writeFileSync(resolve(p, "README.md"), `# ${name}`);
  run(p, "git", ["config", "user.email", "test@example.test"]);
  run(p, "git", ["config", "user.name", "Test"]);
  run(p, "git", ["add", "."]);
  run(p, "git", ["commit", "-m", "initial"]);
  return p;
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

void describe("captureIdentity", () => {
  let repoPath: string;
  let repo: Repository;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    repoPath = initRepo(TMP, "identity-test");
    repo = makeRepo(repoPath, "identity-test");
    registerRepos([repo]);
  });

  after(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("captures commonDir and remoteNames", () => {
    const identity = captureIdentity(repo);
    ok(identity.commonDir.endsWith(".git") || identity.commonDir.includes(".git"));
    strictEqual(identity.remoteNames.length, 0); // no remotes configured
    strictEqual(identity.remotePathHint, null); // no remote URL
  });

  void it("captures remote info when remotes exist", () => {
    run(repoPath, "git", ["remote", "add", "origin", "https://github.com/org/test-repo.git"]);
    const identity = captureIdentity(repo);
    ok(identity.remoteNames.includes("origin"));
    strictEqual(identity.remotePathHint, "org/test-repo");
  });
});

void describe("captureHead", () => {
  let repoPath: string;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    repoPath = initRepo(TMP, "head-test");
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("captures symbolic ref on a branch", () => {
    const head = captureHead(repoPath);
    strictEqual(head.symbolicRef, "refs/heads/main");
    strictEqual(head.detached, false);
    ok(head.sha.length === 40, "SHA should be 40 hex chars");
  });

  void it("captures detached state", () => {
    // Check out a commit detached
    const sha = headSha(repoPath);
    run(repoPath, "git", ["checkout", "--detach", sha]);

    const head = captureHead(repoPath);
    strictEqual(head.symbolicRef, null);
    strictEqual(head.detached, true);
    strictEqual(head.sha, sha);

    // Back to main
    run(repoPath, "git", ["checkout", "main"]);
  });
});

function headSha(repoPath: string): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoPath,
    stdio: "pipe",
    timeout: 5000,
  });
  return r.stdout.toString().trim();
}

void describe("captureDirtySummary", () => {
  let repoPath: string;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    repoPath = initRepo(TMP, "dirty-test");
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("captures clean state", () => {
    const dirty = captureDirtySummary(repoPath);
    strictEqual(dirty.hasChanges, false);
    strictEqual(dirty.staged, 0);
    strictEqual(dirty.unstaged, 0);
    strictEqual(dirty.untracked, 0);
    strictEqual(dirty.conflicted, 0);
  });

  void it("captures dirty state (untracked)", () => {
    writeFileSync(resolve(repoPath, "dirty-file.txt"), "dirty content");
    const dirty = captureDirtySummary(repoPath);
    ok(dirty.hasChanges);
    strictEqual(dirty.untracked, 1);

    // Clean up
    rmSync(resolve(repoPath, "dirty-file.txt"));
  });

  void it("captures dirty state (staged)", () => {
    writeFileSync(resolve(repoPath, "staged-file.txt"), "staged content");
    run(repoPath, "git", ["add", "."]);
    const dirty = captureDirtySummary(repoPath);
    ok(dirty.hasChanges);
    strictEqual(dirty.staged, 1);

    // Clean up
    run(repoPath, "git", ["reset", "HEAD", "staged-file.txt"]);
    rmSync(resolve(repoPath, "staged-file.txt"));
  });
});

void describe("captureRepoSnapshot", () => {
  let repoPath: string;
  let repo: Repository;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    repoPath = initRepo(TMP, "snapshot-test");
    repo = makeRepo(repoPath, "snapshot-test");
    registerRepos([repo]);
  });

  after(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("captures a full repo snapshot", () => {
    const snapshot = captureRepoSnapshot(repo);
    ok(snapshot);
    strictEqual(snapshot.repoId, "snapshot-test");
    strictEqual(snapshot.rootPath, repoPath);
    ok(snapshot.head.sha.length === 40);
    strictEqual(snapshot.head.symbolicRef, "refs/heads/main");
    strictEqual(snapshot.dirty.hasChanges, false);
    ok(snapshot.worktree.path);
  });
});

void describe("captureSnapshot (full)", () => {
  let repoPath: string;
  let repo: Repository;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    repoPath = initRepo(TMP, "full-test");
    repo = makeRepo(repoPath, "full-test");
    registerRepos([repo]);
  });

  after(() => {
    clearRepoRegistry();
    _clearRepoPaths();
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("captures a full multi-repo snapshot", () => {
    const schema = captureSnapshot(
      [repo],
      "my-snapshot",
      "/tmp/test.code-workspace",
      "A test snapshot",
      "manual"
    );

    ok(schema);
    strictEqual(schema.meta.label, "my-snapshot");
    strictEqual(schema.meta.description, "A test snapshot");
    strictEqual(schema.meta.source, "manual");
    strictEqual(schema.repoCount, 1);
    strictEqual(schema.repos.length, 1);
    ok(schema.meta.createdAt);

    const repoSnapshot = schema.repos[0]!;
    strictEqual(repoSnapshot.repoId, "full-test");
    ok(repoSnapshot.head.sha);
  });

  void it("handles auto source type", () => {
    const schema = captureSnapshot(
      [repo],
      "auto-snapshot",
      "/tmp/test.code-workspace",
      undefined,
      "auto"
    );
    strictEqual(schema.meta.source, "auto");
  });

  void it("handles restore-point source type", () => {
    const schema = captureSnapshot(
      [repo],
      "restore-point",
      "/tmp/test.code-workspace",
      undefined,
      "restore-point"
    );
    strictEqual(schema.meta.source, "restore-point");
  });
});
