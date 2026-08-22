/**
 * Tests for the client-side Git API layer.
 * Run: node --experimental-strip-types --loader ./scripts/register-ts.mjs --test src/lib/api/git.test.ts
 *
 * Tests adapter functions only — actual fetch calls are avoided.
 */

import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert";
import {
  toGitStatusView,
  getSwitchDisabledReason,
  isWorktreeRecommended,
  resetCachedToken,
  executeFetch,
} from "./git";
import type { GitStatusView } from "./git";

void describe("toGitStatusView adapter", () => {
  const baseServerResponse = {
    repoId: "repo-123",
    rootPath: "/home/example/projects/my-repo",
    currentBranch: "main",
    headRef: "refs/heads/main",
    headOid: "abc123def456",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    v2Status: {
      staged: 3,
      unstaged: 1,
      untracked: 5,
      conflicted: 0,
    },
    worktrees: [
      { isPrimary: true, branch: "main" },
      { isPrimary: false, branch: "feature-x" },
      { isPrimary: false, branch: null }, // detached worktree
    ],
    localBranches: [{ name: "main" }, { name: "feature-x" }],
    remotes: [{ name: "origin" }],
    remoteRefs: [{ ref: "refs/remotes/origin/main" }],
    errors: [],
    cachedAt: Date.now(),
  };

  void it("transforms all fields correctly", () => {
    const view = toGitStatusView(baseServerResponse);
    strictEqual(view.repoId, "repo-123");
    strictEqual(view.rootPath, "/home/example/projects/my-repo");
    strictEqual(view.currentBranch, "main");
    strictEqual(view.upstream, "origin/main");
    strictEqual(view.ahead, 2);
    strictEqual(view.behind, 1);
    strictEqual(view.staged, 3);
    strictEqual(view.unstaged, 1);
    strictEqual(view.untracked, 5);
    strictEqual(view.conflicted, 0);
    strictEqual(view.worktreeCount, 3);
  });

  void it("extracts secondary worktree branches", () => {
    const view = toGitStatusView(baseServerResponse);
    strictEqual(view.secondaryWorktreeBranches.length, 2);
    ok(view.secondaryWorktreeBranches.includes("feature-x"));
    ok(view.secondaryWorktreeBranches.includes("(detached)"));
  });

  void it("includes errors array", () => {
    const withErrors = {
      ...baseServerResponse,
      errors: ["Remote 'origin' unreachable"],
    };
    const view = toGitStatusView(withErrors);
    strictEqual(view.errors.length, 1);
    strictEqual(view.errors[0], "Remote 'origin' unreachable");
  });

  void it("handles null v2Status", () => {
    const noV2 = { ...baseServerResponse, v2Status: null };
    const view = toGitStatusView(noV2);
    strictEqual(view.staged, 0);
    strictEqual(view.unstaged, 0);
    strictEqual(view.untracked, 0);
    strictEqual(view.conflicted, 0);
  });

  void it("handles empty worktrees", () => {
    const noWt = { ...baseServerResponse, worktrees: [] };
    const view = toGitStatusView(noWt);
    strictEqual(view.worktreeCount, 0);
    strictEqual(view.secondaryWorktreeBranches.length, 0);
  });

  void it("preserves cachedAt timestamp", () => {
    const ts = 1710000000000;
    const view = toGitStatusView({ ...baseServerResponse, cachedAt: ts });
    strictEqual(view.cachedAt, ts);
  });

  /* ── changedFiles / changesTruncated ───────────────────────── */

  void it("maps changedFiles from v2Status files", () => {
    const withFiles = {
      ...baseServerResponse,
      v2Status: {
        staged: 2,
        unstaged: 1,
        untracked: 1,
        conflicted: 0,
        files: [
          { path: "src/index.ts", origPath: undefined, xy: "M.", stage: "index" as const, staged: true, unstaged: false, conflicted: false },
          { path: "src/styles.css", origPath: undefined, xy: ".M", stage: "worktree" as const, staged: false, unstaged: true, conflicted: false },
          { path: "new.txt", origPath: undefined, xy: "??", stage: "untracked" as const, staged: false, unstaged: false, conflicted: false },
        ],
        truncated: false,
      },
    };
    const view = toGitStatusView(withFiles);
    strictEqual(view.changedFiles.length, 3);
    strictEqual(view.changesTruncated, false);

    const index = view.changedFiles.find((f) => f.path === "src/index.ts");
    ok(index);
    strictEqual(index!.xy, "M.");
    strictEqual(index!.staged, true);
    strictEqual(index!.unstaged, false);
    strictEqual(index!.conflicted, false);

    const styles = view.changedFiles.find((f) => f.path === "src/styles.css");
    ok(styles);
    strictEqual(styles!.xy, ".M");
    strictEqual(styles!.staged, false);
    strictEqual(styles!.unstaged, true);

    const newF = view.changedFiles.find((f) => f.path === "new.txt");
    ok(newF);
    strictEqual(newF!.xy, "??");
    strictEqual(newF!.untracked, true);
  });

  void it("maps originalPath for rename entries", () => {
    const withRename = {
      ...baseServerResponse,
      v2Status: {
        staged: 1,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        files: [
          { path: "new-name.js", origPath: "old-name.js", xy: "R.", stage: "index" as const, staged: true, unstaged: false, conflicted: false },
        ],
        truncated: false,
      },
    };
    const view = toGitStatusView(withRename);
    strictEqual(view.changedFiles.length, 1);
    strictEqual(view.changedFiles[0]!.path, "new-name.js");
    strictEqual(view.changedFiles[0]!.originalPath, "old-name.js");
  });

  void it("sets changesTruncated from v2Status.truncated", () => {
    const truncated = {
      ...baseServerResponse,
      v2Status: {
        staged: 200,
        unstaged: 0,
        untracked: 0,
        conflicted: 0,
        files: [{ path: "big.ts", origPath: undefined, xy: "M.", stage: "index" as const, staged: true, unstaged: false, conflicted: false }],
        truncated: true,
      },
    };
    const view = toGitStatusView(truncated);
    strictEqual(view.changesTruncated, true);
    strictEqual(view.changedFiles.length, 1);
  });

  void it("returns empty changedFiles when no files in v2Status", () => {
    const noFiles = {
      ...baseServerResponse,
      v2Status: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
    };
    const view = toGitStatusView(noFiles);
    strictEqual(view.changedFiles.length, 0);
    strictEqual(view.changesTruncated, false);
  });

  void it("maps conflicted file correctly", () => {
    const withConflict = {
      ...baseServerResponse,
      v2Status: {
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicted: 1,
        files: [
          { path: "conflict.md", origPath: undefined, xy: "UU", stage: "worktree" as const, staged: false, unstaged: false, conflicted: true },
        ],
        truncated: false,
      },
    };
    const view = toGitStatusView(withConflict);
    strictEqual(view.changedFiles.length, 1);
    strictEqual(view.changedFiles[0]!.conflicted, true);
    strictEqual(view.changedFiles[0]!.path, "conflict.md");
    strictEqual(view.changedFiles[0]!.xy, "UU");
  });
});

void describe("getSwitchDisabledReason", () => {
  function makeStatus(overrides: Partial<GitStatusView> = {}): GitStatusView {
    return {
      repoId: "r1",
      rootPath: "/tmp/repo",
      currentBranch: "main",
      headRef: "refs/heads/main",
      headOid: "abc",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      changedFiles: [],
      changesTruncated: false,
      worktreeCount: 1,
      secondaryWorktreeBranches: [],
      localBranches: ["main"],
      remotes: ["origin"],
      remoteRefs: ["refs/remotes/origin/main"],
      secondaryWorktrees: [],
      cachedAt: Date.now(),
      errors: [],
      ...overrides,
    };
  }

  void it("returns null when everything is clean", () => {
    const status = makeStatus();
    strictEqual(getSwitchDisabledReason(status), null);
  });

  void it("returns reason when conflicted", () => {
    const status = makeStatus({ conflicted: 2 });
    const reason = getSwitchDisabledReason(status);
    ok(reason !== null);
    ok(reason!.includes("Conflicts"));
  });

  void it("returns reason when staged changes exist", () => {
    const status = makeStatus({ staged: 1 });
    const reason = getSwitchDisabledReason(status);
    ok(reason !== null);
    ok(reason!.includes("uncommitted"));
  });

  void it("returns reason when unstaged changes exist", () => {
    const status = makeStatus({ unstaged: 3 });
    const reason = getSwitchDisabledReason(status);
    ok(reason !== null);
    ok(reason!.includes("uncommitted"));
  });

  void it("returns reason when untracked files exist", () => {
    const status = makeStatus({ untracked: 1 });
    const reason = getSwitchDisabledReason(status);
    ok(reason !== null);
    ok(reason!.includes("uncommitted"));
  });

  void it("returns reason when status not loaded", () => {
    strictEqual(getSwitchDisabledReason(undefined), "Status not loaded");
  });
});

void describe("isWorktreeRecommended", () => {
  function makeStatus(wtCount: number): GitStatusView {
    return {
      repoId: "r1",
      rootPath: "/tmp/repo",
      currentBranch: "main",
      headRef: "refs/heads/main",
      headOid: "abc",
      upstream: null,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      changedFiles: [],
      changesTruncated: false,
      worktreeCount: wtCount,
      secondaryWorktreeBranches: [],
      localBranches: ["main"],
      remotes: ["origin"],
      remoteRefs: ["refs/remotes/origin/main"],
      secondaryWorktrees: [],
      cachedAt: Date.now(),
      errors: [],
    };
  }

  void it("returns false when no status", () => {
    strictEqual(isWorktreeRecommended(undefined), false);
  });

  void it("returns false when no secondary worktrees", () => {
    strictEqual(isWorktreeRecommended(makeStatus(1)), false);
  });

  void it("returns true when secondary worktrees exist", () => {
    strictEqual(isWorktreeRecommended(makeStatus(2)), true);
  });
});

void describe("module-level state", () => {
  void it("resetCachedToken does not throw", () => {
    resetCachedToken();
    ok(true, "reset completed without error");
  });

  void it("refreshes an expired action token once after a 403", async () => {
    resetCachedToken();
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; token: string | null }> = [];
    const responses = [
      new Response(JSON.stringify({ token: "stale" }), { status: 200 }),
      new Response(JSON.stringify({ error: "expired" }), { status: 403 }),
      new Response(JSON.stringify({ token: "fresh" }), { status: 200 }),
      new Response(
        JSON.stringify({
          result: {
            repoId: "r1",
            remote: "origin",
            success: true,
            output: "",
            durationMs: 1,
          },
        }),
        { status: 200 }
      ),
    ];
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), token: headers.get("x-action-token") });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fetch");
      return response;
    };

    try {
      const result = await executeFetch("r1");
      strictEqual(result.success, true);
      strictEqual(calls.length, 4);
      strictEqual(calls[1].token, "stale");
      strictEqual(calls[3].token, "fresh");
    } finally {
      globalThis.fetch = originalFetch;
      resetCachedToken();
    }
  });
});
