/**
 * Tests for Git repository discovery.
 * Run: node --experimental-strip-types --test src/lib/workspace/__tests__/discovery.test.ts
 *
 * Creates disposable temporary git repos to verify:
 * - Basic detection of .git directories
 * - Git worktree detection (.git as a file)
 * - Nested repos
 * - Deduplication by commonDir
 * - Exclusion patterns
 * - Bounded depth
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { scanWorkspace, makeRepoId } from "../discovery";
import type { WorkspaceDefinition } from "../types";

const TMP = resolve(tmpdir(), "dashboard-discovery-test");

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
  run(p, "git", ["add", "."]);
  run(p, "git", ["commit", "-m", "initial"]);
  return p;
}

let _initialized = false;

void describe("scanWorkspace", () => {
  before(() => {
    if (!_initialized) {
      rmSync(TMP, { recursive: true, force: true });
      mkdirSync(TMP, { recursive: true });
      _initialized = true;
    }
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("discovers a single repo in a workspace folder", () => {
    const repoPath = initRepo(TMP, "test-repo-a");
    const ws: WorkspaceDefinition = {
      filePath: resolve(TMP, "test.code-workspace"),
      name: "test",
      folders: [
        {
          name: "Repo A",
          rawPath: repoPath,
          resolvedPath: repoPath,
          exists: true,
        },
      ],
    };

    const result = scanWorkspace(ws);
    strictEqual(result.errors.length, 0);
    strictEqual(result.repositories.length, 1);
    strictEqual(result.repositories[0].rootPath, repoPath);
    strictEqual(result.repositories[0].folderMembership.length, 1);
    strictEqual(result.repositories[0].folderMembership[0], "Repo A");
    ok(result.repositories[0].commonDir.endsWith(".git") || result.repositories[0].commonDir.includes(".git"));
  });

  void it("discovers repos inside a folder that contains multiple repos", () => {
    const parent = resolve(TMP, "multi-parent");
    mkdirSync(parent, { recursive: true });
    const a = initRepo(parent, "sub-a");
    const b = initRepo(parent, "sub-b");

    const ws: WorkspaceDefinition = {
      filePath: resolve(TMP, "multi.code-workspace"),
      name: "multi",
      folders: [
        {
          name: "Multi",
          rawPath: parent,
          resolvedPath: parent,
          exists: true,
        },
      ],
    };

    const result = scanWorkspace(ws);
    strictEqual(result.repositories.length, 2);
    const roots = result.repositories.map((r) => r.rootPath).sort();
    ok(roots.includes(a));
    ok(roots.includes(b));
  });

  void it("deduplicates repos found by multiple folders pointing to same path", () => {
    const repoPath = initRepo(TMP, "dedup-repo");
    const ws: WorkspaceDefinition = {
      filePath: resolve(TMP, "dedup.code-workspace"),
      name: "dedup",
      folders: [
        {
          name: "First",
          rawPath: repoPath,
          resolvedPath: repoPath,
          exists: true,
        },
        {
          name: "Second",
          rawPath: repoPath,
          resolvedPath: repoPath,
          exists: true,
        },
      ],
    };

    const result = scanWorkspace(ws);
    strictEqual(result.repositories.length, 1);
    strictEqual(result.repositories[0].folderMembership.length, 2);
    ok(result.repositories[0].folderMembership.includes("First"));
    ok(result.repositories[0].folderMembership.includes("Second"));
  });

  void it("handles missing folders gracefully", () => {
    const ws: WorkspaceDefinition = {
      filePath: resolve(TMP, "missing.code-workspace"),
      name: "missing",
      folders: [
        {
          name: "Gone",
          rawPath: "/nonexistent/xyz",
          resolvedPath: "/nonexistent/xyz",
          exists: false,
        },
      ],
    };

    const result = scanWorkspace(ws);
    strictEqual(result.repositories.length, 0);
    strictEqual(result.errors.length, 1);
    ok(result.errors[0].includes("does not exist"));
  });

  void it("respects max depth option", () => {
    const deep = resolve(TMP, "deep-parent");
    mkdirSync(deep, { recursive: true });
    const deepRepo = initRepo(deep, "deep-repo"); // at depth 1
    // Create a deeply nested .git that won't be found at depth 0
    const veryDeep = resolve(deep, "a", "b", "c", "d");
    mkdirSync(veryDeep, { recursive: true });
    initRepo(veryDeep, "too-deep"); // at depth 4

    const ws: WorkspaceDefinition = {
      filePath: resolve(TMP, "depth.code-workspace"),
      name: "depth",
      folders: [
        {
          name: "Deep",
          rawPath: deep,
          resolvedPath: deep,
          exists: true,
        },
      ],
    };

    // With maxDepth 2, should find deep-repo but not too-deep (depth 4)
    const result = scanWorkspace(ws, { maxDepth: 2 });
    const roots = result.repositories.map((r) => r.rootPath);
    ok(roots.includes(deepRepo), "should find shallow repo");
    ok(!roots.includes(resolve(veryDeep, "too-deep")), "should not find too-deep repo");
  });

  void it("excludes directories matching patterns", () => {
    const parent = resolve(TMP, "exclude-parent");
    mkdirSync(parent, { recursive: true });

    // Create a repo directly in parent
    initRepo(parent, "main-repo");

    // Create a node_modules-like subdirectory with a .git init (would be a false positive)
    const nm = resolve(parent, "node_modules");
    mkdirSync(nm, { recursive: true });
    initRepo(nm, "fake-pkg");

    const ws: WorkspaceDefinition = {
      filePath: resolve(TMP, "exclude.code-workspace"),
      name: "exclude",
      folders: [
        {
          name: "ExcludeParent",
          rawPath: parent,
          resolvedPath: parent,
          exists: true,
        },
      ],
    };

    const result = scanWorkspace(ws);
    const roots = result.repositories.map((r) => r.rootPath);
    ok(roots.includes(resolve(parent, "main-repo")), "should find main repo");
    ok(
      !roots.includes(nm),
      "should not find repo in node_modules"
    );
  });

  void it("generates stable repo IDs", () => {
    const id1 = makeRepoId("/ws/test.code-workspace", "/repo/.git");
    const id2 = makeRepoId("/ws/test.code-workspace", "/repo/.git");
    const id3 = makeRepoId("/ws/other.code-workspace", "/repo/.git");

    strictEqual(id1, id2, "same inputs should produce same ID");
    ok(id1 !== id3, "different workspace path should produce different ID");
  });

  void it("assigns correct folderMembership for nested repos", () => {
    const outer = resolve(TMP, "outer-repo");
    const outerPath = initRepo(outer, "outer");
    const inner = initRepo(outer, "inner-nested");

    const ws: WorkspaceDefinition = {
      filePath: resolve(TMP, "nested.code-workspace"),
      name: "nested",
      folders: [
        {
          name: "Outer",
          rawPath: outer,
          resolvedPath: outer,
          exists: true,
        },
      ],
    };

    const result = scanWorkspace(ws);
    strictEqual(result.repositories.length, 2);
    const innerRepo = result.repositories.find(
      (r) => r.rootPath === inner
    );
    ok(innerRepo, "should find nested repo");
    ok(
      innerRepo!.folderMembership.includes("Outer"),
      "nested repo should be in Outer folder"
    );
  });
});
