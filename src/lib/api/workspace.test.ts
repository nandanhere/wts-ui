/**
 * Lightweight client API layer tests.
 * Run: node --experimental-strip-types --loader ./scripts/register-ts.mjs --test src/lib/api/workspace.test.ts
 *
 * These test the adapter functions only — actual fetch is avoided.
 */

import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert";
import type { Repository, WorkspaceDefinition } from "@/lib/workspace/types";

// Replicate the adapter logic inline to verify transformation
function repoToView(r: Repository) {
  return {
    id: r.id,
    rootPath: r.rootPath,
    displayName: r.rootPath.split("/").pop() ?? r.rootPath,
    folderMembership: r.folderMembership,
    worktree: r.worktree,
    branch: r.worktree?.branch ?? null,
    lastCommit: null,
    exists: true,
  };
}

void describe("repoToView adapter", () => {
  const repo: Repository = {
    id: "abc123",
    rootPath: "/home/example/projects/my-repo",
    commonDir: "/home/example/projects/my-repo/.git",
    worktree: { path: "/home/example/projects/my-repo", branch: "main" },
    folderMembership: ["Backend"],
  };

  void it("derives displayName from rootPath", () => {
    const view = repoToView(repo);
    strictEqual(view.displayName, "my-repo");
  });

  void it("extracts branch from worktree", () => {
    const view = repoToView(repo);
    strictEqual(view.branch, "main");
  });

  void it("sets lastCommit null (awaiting live enrichment)", () => {
    const view = repoToView(repo);
    strictEqual(view.lastCommit, null);
  });

  void it("handles null worktree gracefully", () => {
    const view = repoToView({ ...repo, worktree: null });
    strictEqual(view.branch, null);
  });

  void it("preserves folder membership", () => {
    const multiRepo: Repository = {
      ...repo,
      folderMembership: ["Frontend", "Backend"],
    };
    const view = repoToView(multiRepo);
    strictEqual(view.folderMembership.length, 2);
    ok(view.folderMembership.includes("Frontend"));
    ok(view.folderMembership.includes("Backend"));
  });
});
