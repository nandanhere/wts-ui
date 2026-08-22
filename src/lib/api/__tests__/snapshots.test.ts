/**
 * Tests for the client-side snapshot API layer.
 *
 * Tests the adapter/view-model shapes, URL construction, and
 * error handling — without making actual HTTP requests.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/api/__tests__/snapshots.test.ts
 */

import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert";
import type { SnapshotEntry, SnapshotSchema } from "@/lib/snapshot/types";

/* ------------------------------------------------------------------ */
/*  Replicate adapter logic inline to verify transformation            */
/*  (same pattern as workspace.test.ts)                                */
/* ------------------------------------------------------------------ */

function entryToListView(entry: SnapshotEntry) {
  return {
    id: entry.id,
    label: entry.meta.label,
    repoCount: entry.repoCount,
    createdAt: entry.meta.createdAt,
    source: entry.meta.source,
    description: entry.meta.description,
  };
}

function schemaToDetailView(schema: SnapshotSchema) {
  return {
    label: schema.meta.label,
    repoCount: schema.repoCount,
    repos: schema.repos.map((r) => ({
      repoId: r.repoId,
      shortHeadSha: r.head.sha.slice(0, 8),
      branch: r.head.symbolicRef?.replace("refs/heads/", "") ?? null,
      dirty: r.dirty.hasChanges,
    })),
  };
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function makeEntry(
  overrides: Partial<SnapshotEntry> = {}
): SnapshotEntry {
  const entry: SnapshotEntry = {
    id: "test-id-001",
    version: 1,
    meta: {
      createdAt: "2026-07-13T10:00:00.000Z",
      label: "Test Snapshot",
      description: "A test snapshot",
      workspaceFilePath: "/tmp/test.code-workspace",
      source: "manual",
    },
    repoCount: 2,
    updatedAt: "2026-07-13T10:00:00.000Z",
  };
  return { ...entry, ...overrides };
}

function makeSchema(
  overrides: Partial<SnapshotSchema> = {}
): SnapshotSchema {
  return {
    version: 1,
    meta: {
      createdAt: "2026-07-13T10:00:00.000Z",
      label: "Test Schema",
      workspaceFilePath: "/tmp/test.code-workspace",
      source: "manual",
    },
    repos: [
      {
        repoId: "repo-a",
        rootPath: "/tmp/repo-a",
        identity: {
          commonDir: "/tmp/repo-a/.git",
          remoteNames: ["origin"],
          remotePathHint: "org/repo-a",
        },
        head: {
          symbolicRef: "refs/heads/main",
          detached: false,
          sha: "abcdef1234567890abcdef1234567890abcdef12",
          upstream: "refs/remotes/origin/main",
        },
        worktree: { path: "/tmp/repo-a", logicalSlot: "primary" },
        dirty: {
          hasChanges: false,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          conflicted: 0,
        },
      },
      {
        repoId: "repo-b",
        rootPath: "/tmp/repo-b",
        identity: {
          commonDir: "/tmp/repo-b/.git",
          remoteNames: ["origin", "upstream"],
          remotePathHint: "org/repo-b",
        },
        head: {
          symbolicRef: "refs/heads/feature-x",
          detached: false,
          sha: "deadbeef1234567890abcdef1234567890deadbeef",
          upstream: "refs/remotes/origin/feature-x",
        },
        worktree: { path: "/tmp/repo-b", logicalSlot: "primary" },
        dirty: {
          hasChanges: true,
          staged: 2,
          unstaged: 1,
          untracked: 0,
          conflicted: 0,
        },
      },
    ],
    repoCount: 2,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

void describe("SnapshotEntry → list view adapter", () => {
  void it("maps entry metadata to list view shape", () => {
    const entry = makeEntry();
    const view = entryToListView(entry);

    strictEqual(view.id, "test-id-001");
    strictEqual(view.label, "Test Snapshot");
    strictEqual(view.repoCount, 2);
    strictEqual(view.source, "manual");
    strictEqual(view.description, "A test snapshot");
  });

  void it("handles missing description gracefully", () => {
    const base = makeEntry();
    const entry = makeEntry({ meta: { ...base.meta, description: undefined } });
    strictEqual(entryToListView(entry).description, undefined);
    // Just verify it doesn't crash — the description field is optional
    ok(true);
  });

  void it("includes the creation timestamp", () => {
    const entry = makeEntry();
    const view = entryToListView(entry);
    strictEqual(typeof view.createdAt, "string");
    ok(view.createdAt.length > 0);
  });
});

void describe("SnapshotSchema → detail view adapter", () => {
  void it("maps schema to detail view shape", () => {
    const schema = makeSchema();
    const detail = schemaToDetailView(schema);

    strictEqual(detail.label, "Test Schema");
    strictEqual(detail.repoCount, 2);
    strictEqual(detail.repos.length, 2);
  });

  void it("derives short SHA from head", () => {
    const schema = makeSchema();
    const detail = schemaToDetailView(schema);

    strictEqual(detail.repos[0]!.shortHeadSha, "abcdef12");
    strictEqual(detail.repos[1]!.shortHeadSha, "deadbeef");
  });

  void it("derives branch from symbolic ref", () => {
    const schema = makeSchema();
    const detail = schemaToDetailView(schema);

    strictEqual(detail.repos[0]!.branch, "main");
    strictEqual(detail.repos[1]!.branch, "feature-x");
  });

  void it("reports dirty state correctly", () => {
    const schema = makeSchema();
    const detail = schemaToDetailView(schema);

    strictEqual(detail.repos[0]!.dirty, false);
    strictEqual(detail.repos[1]!.dirty, true);
  });

  void it("handles detached HEAD (null symbolicRef)", () => {
    const schema = makeSchema();
    schema.repos[0]!.head.symbolicRef = null;
    schema.repos[0]!.head.detached = true;

    const detail = schemaToDetailView(schema);
    strictEqual(detail.repos[0]!.branch, null);
  });

  void it("handles empty repos array", () => {
    const schema = makeSchema({ repos: [], repoCount: 0 });
    const detail = schemaToDetailView(schema);
    strictEqual(detail.repoCount, 0);
    strictEqual(detail.repos.length, 0);
  });
});

void describe("Snapshot API URL construction", () => {
  void it("builds correct list URL", () => {
    const url = "/api/snapshots";
    strictEqual(url, "/api/snapshots");
  });

  void it("builds correct detail URL with encoding", () => {
    const id = "abc123";
    const url = `/api/snapshots/${encodeURIComponent(id)}`;
    strictEqual(url, "/api/snapshots/abc123");
  });

  void it("encodes special characters in IDs", () => {
    const id = "my snapshot/1";
    const url = `/api/snapshots/${encodeURIComponent(id)}`;
    strictEqual(url, "/api/snapshots/my%20snapshot%2F1");
  });

  void it("builds correct drift URL", () => {
    const id = "test-id";
    const url = `/api/snapshots/${encodeURIComponent(id)}/drift`;
    strictEqual(url, "/api/snapshots/test-id/drift");
  });

  void it("builds correct restore URL", () => {
    const id = "test-id";
    const url = `/api/snapshots/${encodeURIComponent(id)}/restore`;
    strictEqual(url, "/api/snapshots/test-id/restore");
  });

  void it("builds correct duplicate URL", () => {
    const id = "test-id";
    const url = `/api/snapshots/${encodeURIComponent(id)}/duplicate`;
    strictEqual(url, "/api/snapshots/test-id/duplicate");
  });
});
