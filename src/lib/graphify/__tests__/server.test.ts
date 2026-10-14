/**
 * Tests for Graphify server — enrichment of workspace scan results.
 * Run: node --experimental-strip-types --loader ../../scripts/register-ts.mjs \
 *       --test src/lib/graphify/__tests__/server.test.ts
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual, match } from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { enrichReposWithGraphify, enrichSingleRepo } from "../server";
import type { WorkspaceScanResult } from "@/lib/workspace/types";

const TMP = resolve(tmpdir(), "dashboard-graphify-server-test");

function gitInit(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync("git", ["init", "-b", "main"], {
    cwd: dir,
    stdio: "pipe",
    timeout: 10000,
  });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);
  writeFileSync(join(dir, "README.md"), "# test");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "pipe", timeout: 5000 });
  spawnSync("git", ["commit", "-m", "initial"], {
    cwd: dir,
    stdio: "pipe",
    timeout: 5000,
  });
  return dir;
}

void describe("enrichReposWithGraphify", () => {
  let repoA: string;
  let repoB: string;

  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    repoA = gitInit(resolve(TMP, "repo-a"));
    repoB = gitInit(resolve(TMP, "repo-b"));

    // Add graphify artifacts to repo A only
    const outA = join(repoA, "graphify-out");
    mkdirSync(outA, { recursive: true });
    writeFileSync(join(outA, "graph.json"), "{}");
    writeFileSync(join(outA, "GRAPH_REPORT.md"), "# Report A");
    spawnSync("git", ["add", "."], { cwd: repoA, stdio: "pipe", timeout: 5000 });
    spawnSync("git", ["commit", "-m", "add graph"], {
      cwd: repoA,
      stdio: "pipe",
      timeout: 5000,
    });
  });

  after(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("enriches all repos with graphify status", () => {
    const scanResult: WorkspaceScanResult = {
      workspace: {
        filePath: resolve(TMP, "test.code-workspace"),
        name: "test",
        folders: [],
      },
      repositories: [
        {
          id: "repo-a-id",
          rootPath: repoA,
          commonDir: join(repoA, ".git"),
          worktree: { path: repoA, branch: "main" },
          folderMembership: ["Repo A"],
        },
        {
          id: "repo-b-id",
          rootPath: repoB,
          commonDir: join(repoB, ".git"),
          worktree: { path: repoB, branch: "main" },
          folderMembership: ["Repo B"],
        },
      ],
      errors: [],
    };

    const result = enrichReposWithGraphify(scanResult);

    // Both repos present in result
    ok("repo-a-id" in result.repos);
    ok("repo-b-id" in result.repos);

    // Repo A has graph available
    strictEqual(result.repos["repo-a-id"].available, true);
    strictEqual(result.repos["repo-a-id"].artifacts.graphJson, true);
    strictEqual(result.repos["repo-a-id"].artifacts.graphReport, true);

    // Repo B has no graph
    strictEqual(result.repos["repo-b-id"].available, false);
    strictEqual(result.repos["repo-b-id"].artifacts.graphJson, false);

    // Staleness is "unknown" for both
    strictEqual(result.repos["repo-a-id"].staleness.status, "unknown");
    strictEqual(result.repos["repo-b-id"].staleness.status, "unknown");
  });

  void it("returns non-fatal errors for repos that fail", () => {
    const scanResult: WorkspaceScanResult = {
      workspace: {
        filePath: resolve(TMP, "test.code-workspace"),
        name: "test",
        folders: [],
      },
      repositories: [],
      errors: ["Some previous error"],
    };

    const result = enrichReposWithGraphify(scanResult);
    ok(result.errors.length >= 1);
    strictEqual(Object.keys(result.repos).length, 0);
  });
});

void describe("enrichSingleRepo", () => {
  let repoDir: string;

  before(() => {
    repoDir = resolve(TMP, "single-repo");
    gitInit(repoDir);
  });

  void it("returns status for an authorized repo", () => {
    const authorized = new Set([repoDir]);
    const result = enrichSingleRepo("my-repo", repoDir, authorized);
    ok("my-repo" in result.repos);
    strictEqual(result.errors.length, 0);
  });

  void it("returns error for unauthorized repo", () => {
    const authorized = new Set(["/other/repo"]);
    const result = enrichSingleRepo("my-repo", repoDir, authorized);
    strictEqual(Object.keys(result.repos).length, 0);
    ok(result.errors.length > 0);
    ok(result.errors[0].includes("Unauthorized path"));
  });
});
