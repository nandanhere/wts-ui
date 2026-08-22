/**
 * Tests for snapshot API routes.
 *
 * Run: node --experimental-strip-types --loader ../../../../scripts/register-ts.mjs \
 *       --test src/app/api/snapshots/__tests__/routes.test.ts
 *
 * Uses a in-memory approach by directly testing the store functions
 * that the routes depend on. Full HTTP tests require a running server.
 */

import { describe, it, before, after } from "node:test";
import { ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  _setSnapshotsDir,
  _resetSnapshotsDir,
  createSnapshot,
  listSnapshots,
  getSnapshot,
  deleteSnapshot,
  updateSnapshotMeta,
  duplicateSnapshot,
} from "@/lib/snapshot/store";
import type { SnapshotSchema } from "@/lib/snapshot/types";

const TMP = resolve(tmpdir(), "dashboard-snapshot-api-test");

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
        repoId: "api-test-repo",
        rootPath: "/tmp/api-test-repo",
        identity: {
          commonDir: "/tmp/api-test-repo/.git",
          remoteNames: ["origin"],
          remotePathHint: "org/api-test",
        },
        head: {
          symbolicRef: "refs/heads/main",
          detached: false,
          sha: "deadbeef1234567890abcdef1234567890abcdef",
          upstream: "refs/remotes/origin/main",
        },
        worktree: { path: "/tmp/api-test-repo", logicalSlot: "primary" },
        dirty: { hasChanges: false, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      },
    ],
    repoCount: 1,
  };
}

void describe("Snapshot API operations (via store)", () => {
  before(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    _setSnapshotsDir(TMP);
  });

  after(() => {
    _resetSnapshotsDir();
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("GET /api/snapshots equivalent — lists snapshots", () => {
    const entries = listSnapshots();
    strictEqual(Array.isArray(entries), true);
  });

  void it("POST /api/snapshots equivalent — creates a snapshot", () => {
    const entry = createSnapshot(makeSnapshot("api-create-test"));
    ok(entry.id);
    strictEqual(entry.meta.label, "api-create-test");
    strictEqual(entry.repoCount, 1);

    // Verify via list
    const all = listSnapshots();
    ok(all.some((e) => e.id === entry.id));
  });

  void it("GET /api/snapshots/:id equivalent — gets full snapshot", () => {
    const entry = createSnapshot(makeSnapshot("api-get-test"));
    const schema = getSnapshot(entry.id);
    ok(schema !== null);
    strictEqual(schema!.meta.label, "api-get-test");
    strictEqual(schema!.repos.length, 1);
  });

  void it("GET /api/snapshots/:id — returns null for missing", () => {
    const schema = getSnapshot("nonexistent");
    strictEqual(schema, null);
  });

  void it("DELETE /api/snapshots/:id equivalent — deletes snapshot", () => {
    const entry = createSnapshot(makeSnapshot("api-delete-test"));
    const deleted = deleteSnapshot(entry.id);
    strictEqual(deleted, true);

    const all = listSnapshots();
    strictEqual(all.some((e) => e.id === entry.id), false);
  });

  void it("DELETE /api/snapshots/:id — returns false for missing", () => {
    const deleted = deleteSnapshot("nonexistent");
    strictEqual(deleted, false);
  });

  void it("PATCH /api/snapshots/:id equivalent — updates label", () => {
    const entry = createSnapshot(makeSnapshot("api-patch-test"));
    const updated = updateSnapshotMeta(entry.id, { label: "patched-label" });
    strictEqual(updated, true);

    const schema = getSnapshot(entry.id);
    ok(schema !== null);
    strictEqual(schema!.meta.label, "patched-label");
  });

  void it("PATCH /api/snapshots/:id equivalent — updates description", () => {
    const entry = createSnapshot(makeSnapshot("api-patch-desc"));
    const updated = updateSnapshotMeta(entry.id, { description: "New description" });
    strictEqual(updated, true);

    const schema = getSnapshot(entry.id);
    ok(schema !== null);
    strictEqual(schema!.meta.description, "New description");
  });

  void it("PATCH /api/snapshots/:id — returns false for missing", () => {
    const updated = updateSnapshotMeta("nonexistent", { label: "x" });
    strictEqual(updated, false);
  });

  void it("POST /api/snapshots/:id/duplicate equivalent — duplicates snapshot", () => {
    const orig = createSnapshot(makeSnapshot("api-dup-orig"));
    const dup = duplicateSnapshot(orig.id, "api-dup-copy");
    ok(dup !== null);
    notEqual(dup!.id, orig.id);
    strictEqual(dup!.meta.label, "api-dup-copy");

    // Verify content matches
    const origSchema = getSnapshot(orig.id);
    const dupSchema = getSnapshot(dup!.id);
    ok(origSchema !== null);
    ok(dupSchema !== null);
    strictEqual(origSchema!.repos[0]!.head.sha, dupSchema!.repos[0]!.head.sha);
  });

  void it("POST /api/snapshots/:id/duplicate — returns null for missing", () => {
    const dup = duplicateSnapshot("nonexistent", "new-label");
    strictEqual(dup, null);
  });
});

function notEqual(a: unknown, b: unknown) {
  if (a === b) throw new Error(`Expected not equal: ${a}`);
}
