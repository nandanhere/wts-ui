/**
 * Tests for task process working-directory confinement.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/tasks/__tests__/paths.test.ts
 */

import { describe, it } from "node:test";
import { strictEqual } from "node:assert";
import { resolve } from "node:path";
import { resolveProcessCwd, isPathInside } from "@/lib/tasks/paths";

void describe("resolveProcessCwd", () => {
  void it("uses the worktree root when no workdir is given", () => {
    strictEqual(resolveProcessCwd("/repo/wt", undefined), resolve("/repo/wt"));
  });

  void it("joins a nested workdir inside the worktree", () => {
    strictEqual(
      resolveProcessCwd("/repo/wt", "apps/api"),
      resolve("/repo/wt", "apps/api")
    );
  });

  void it("rejects a workdir that escapes the worktree", () => {
    strictEqual(resolveProcessCwd("/repo/wt", "../outside"), null);
    strictEqual(resolveProcessCwd("/repo/wt", "apps/../../outside"), null);
  });

  void it("rejects an absolute workdir outside the worktree", () => {
    strictEqual(resolveProcessCwd("/repo/wt", "/etc"), null);
  });
});

void describe("isPathInside", () => {
  void it("accepts the root itself and descendants", () => {
    strictEqual(isPathInside("/repo", "/repo"), true);
    strictEqual(isPathInside("/repo", "/repo/a/b"), true);
  });

  void it("rejects siblings and escapes", () => {
    strictEqual(isPathInside("/repo", "/repo-other"), false);
    strictEqual(isPathInside("/repo", "/repo/../etc"), false);
  });
});
