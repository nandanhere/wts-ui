/**
 * Tests for snapshot store (CRUD operations + atomic storage).
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/snapshot/__tests__/store.test.ts
 *
 * Uses a temporary directory as the snapshot store root.
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual, notStrictEqual } from "node:assert";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  _setSnapshotsDir,
  _resetSnapshotsDir,
  createSnapshot,
  listSnapshots,
  getSnapshot,
  deleteSnapshot,
  duplicateSnapshot,
  updateSnapshotMeta,
  rebuildIndex,
  snapshotCount,
} from "@/lib/snapshot/store";
import type { SnapshotSchema } from "@/lib/snapshot/types";

const TMP = resolve(tmpdir(), "dashboard-snapshot-store-test");

function makeSnapshot(label: string): Omit<SnapshotSchema, "version"> {
  return {
    meta: {
      createdAt: new Date().toISOString(),
      label,
      workspaceFilePath: "/tmp/test.code-workspace",
      source: "manual",
    },
    repos: [
      {
        repoId: "repo-1",
        rootPath: "/tmp/repo-1",
        identity: {
          commonDir: "/tmp/repo-1/.git",
          remoteNames: ["origin"],
          remotePathHint: "org/repo-one",
        },
        head: {
          symbolicRef: "refs/heads/main",
          detached: false,
          sha: "abc123def456",
          upstream: "refs/remotes/origin/main",
        },
        worktree: {
          path: "/tmp/repo-1",
          logicalSlot: "primary",
        },
        dirty: {
          hasChanges: false,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
        },
      },
    ],
    repoCount: 1,
  };
}

void describe("Snapshot store", () => {
  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    _setSnapshotsDir(TMP);
  });

  after(() => {
    _resetSnapshotsDir();
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("creates a snapshot and returns an entry", () => {
    const entry = createSnapshot(makeSnapshot("test-create"));
    ok(entry.id, "should have an id");
    strictEqual(entry.meta.label, "test-create");
    strictEqual(entry.repoCount, 1);
    strictEqual(entry.version, 1);
    ok(entry.updatedAt);
  });

  void it("lists snapshots (most recent first)", () => {
    createSnapshot(makeSnapshot("list-first"));
    createSnapshot(makeSnapshot("list-second"));

    const entries = listSnapshots();
    ok(entries.length >= 2);
    // Most recent should be first
    const idx1 = entries.findIndex((e) => e.meta.label === "list-first");
    const idx2 = entries.findIndex((e) => e.meta.label === "list-second");
    ok(idx2 < idx1, "list-second should appear before list-first");
  });

  void it("gets a full snapshot by ID", () => {
    const entry = createSnapshot(makeSnapshot("get-test"));
    const schema = getSnapshot(entry.id);
    ok(schema !== null);
    strictEqual(schema!.meta.label, "get-test");
    strictEqual(schema!.repos.length, 1);
    strictEqual(schema!.repos[0]!.repoId, "repo-1");
    strictEqual(schema!.repos[0]!.head.sha, "abc123def456");
  });

  void it("returns null for unknown snapshot ID", () => {
    const schema = getSnapshot("nonexistent-id");
    strictEqual(schema, null);
  });

  void it("deletes a snapshot", () => {
    const entry = createSnapshot(makeSnapshot("delete-test"));
    ok(existsSync(resolve(TMP, `${entry.id}.json`)), "snapshot file should exist");

    const deleted = deleteSnapshot(entry.id);
    strictEqual(deleted, true);

    // File should be removed
    ok(!existsSync(resolve(TMP, `${entry.id}.json`)), "snapshot file should be removed");
    // Should not appear in list
    const entries = listSnapshots();
    ok(!entries.some((e) => e.id === entry.id), "should not appear in list");
  });

  void it("returns false when deleting non-existent snapshot", () => {
    const deleted = deleteSnapshot("nonexistent-id");
    strictEqual(deleted, false);
  });

  void it("duplicates a snapshot with a new label", () => {
    const orig = createSnapshot(makeSnapshot("original"));
    const dup = duplicateSnapshot(orig.id, "duplicated");
    ok(dup !== null);
    strictEqual(dup!.meta.label, "duplicated");
    notStrictEqual(dup!.id, orig.id);

    // Verify content is the same
    const origSchema = getSnapshot(orig.id);
    const dupSchema = getSnapshot(dup!.id);
    ok(origSchema !== null);
    ok(dupSchema !== null);
    strictEqual(origSchema!.repos.length, dupSchema!.repos.length);
    strictEqual(origSchema!.repos[0]!.head.sha, dupSchema!.repos[0]!.head.sha);
  });

  void it("returns null when duplicating non-existent snapshot", () => {
    const dup = duplicateSnapshot("nonexistent-id", "new-label");
    strictEqual(dup, null);
  });

  void it("updates snapshot metadata (label)", () => {
    const entry = createSnapshot(makeSnapshot("update-label"));
    const updated = updateSnapshotMeta(entry.id, { label: "updated-label" });
    strictEqual(updated, true);

    const schema = getSnapshot(entry.id);
    ok(schema !== null);
    strictEqual(schema!.meta.label, "updated-label");
  });

  void it("updates snapshot metadata (description)", () => {
    const entry = createSnapshot(makeSnapshot("update-desc"));
    const updated = updateSnapshotMeta(entry.id, { description: "A new description" });
    strictEqual(updated, true);

    const schema = getSnapshot(entry.id);
    ok(schema !== null);
    strictEqual(schema!.meta.description, "A new description");
  });

  void it("returns false when updating non-existent snapshot", () => {
    const updated = updateSnapshotMeta("nonexistent-id", { label: "new-label" });
    strictEqual(updated, false);
  });

  void it("rebuilds index from disk", () => {
    // Create a snapshot and then manually delete the index
    const entry = createSnapshot(makeSnapshot("rebuild-test"));
    const indexPath = resolve(TMP, "index.json");
    ok(existsSync(indexPath), "index should exist");

    // Remove index manually
    rmSync(indexPath);
    ok(!existsSync(indexPath));

    // Rebuild
    const entries = rebuildIndex();
    ok(entries.length > 0);
    ok(entries.some((e) => e.id === entry.id), "should include our snapshot");
  });

  void it("reports correct snapshot count", () => {
    const before = snapshotCount();
    createSnapshot(makeSnapshot("count-test"));
    strictEqual(snapshotCount(), before + 1);
  });

  void it("handles empty store gracefully", () => {
    // Use a fresh directory
    const emptyDir = resolve(TMP, "empty");
    mkdirSync(emptyDir, { recursive: true });
    _setSnapshotsDir(emptyDir);

    const entries = listSnapshots();
    strictEqual(entries.length, 0);
    strictEqual(snapshotCount(), 0);

    const schema = getSnapshot("anything");
    strictEqual(schema, null);
  });

  void it("handles corrupted index gracefully", () => {
    const corruptDir = resolve(TMP, "corrupt");
    mkdirSync(corruptDir, { recursive: true });
    _setSnapshotsDir(corruptDir);

    // Write invalid JSON to index
    writeFileSync(resolve(corruptDir, "index.json"), "not valid json{{{}}}");

    // Should fall back to empty
    const entries = listSnapshots();
    strictEqual(entries.length, 0);
  });

  void it("handles multiple repos in a snapshot", () => {
    const multiRepoSchema: Omit<SnapshotSchema, "version"> = {
      meta: {
        createdAt: new Date().toISOString(),
        label: "multi-repo",
        workspaceFilePath: "/tmp/multi.code-workspace",
        source: "manual",
      },
      repos: [
        {
          repoId: "repo-a",
          rootPath: "/tmp/repo-a",
          identity: { commonDir: "/tmp/repo-a/.git", remoteNames: ["origin"], remotePathHint: "org/repo-a" },
          head: { symbolicRef: "refs/heads/main", detached: false, sha: "aaa", upstream: "refs/remotes/origin/main" },
          worktree: { path: "/tmp/repo-a", logicalSlot: "primary" },
          dirty: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        },
        {
          repoId: "repo-b",
          rootPath: "/tmp/repo-b",
          identity: { commonDir: "/tmp/repo-b/.git", remoteNames: ["origin", "upstream"], remotePathHint: "org/repo-b" },
          head: { symbolicRef: "refs/heads/develop", detached: false, sha: "bbb", upstream: null },
          worktree: { path: "/tmp/repo-b", logicalSlot: "primary" },
          dirty: { hasChanges: true, staged: 1, unstaged: 2, untracked: 3, conflicted: 0 },
        },
      ],
      repoCount: 2,
    };

    const entry = createSnapshot(multiRepoSchema);
    const schema = getSnapshot(entry.id);
    ok(schema !== null);
    strictEqual(schema!.repos.length, 2);
    strictEqual(schema!.repoCount, 2);
  });
});
