/**
 * Regression tests: snapshot IDs must not escape the snapshots directory.
 *
 * Run: node --experimental-strip-types --loader ../../../scripts/register-ts.mjs \
 *       --test src/lib/snapshot/__tests__/store-traversal.test.ts
 */

import { describe, it, before, after } from "node:test";
import { strictEqual } from "node:assert";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  _setSnapshotsDir,
  _resetSnapshotsDir,
  getSnapshot,
  deleteSnapshot,
  updateSnapshotMeta,
} from "@/lib/snapshot/store";

const BASE = resolve(tmpdir(), "dashboard-snapshot-traversal-test");
const STORE_DIR = resolve(BASE, "snapshots");
const OUTSIDE_FILE = resolve(BASE, "outside.json");

void describe("Snapshot store path traversal", () => {
  before(() => {
    rmSync(BASE, { recursive: true, force: true });
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(
      OUTSIDE_FILE,
      JSON.stringify({
        version: 1,
        meta: {
          createdAt: new Date().toISOString(),
          label: "outside",
          workspaceFilePath: "/tmp/test.code-workspace",
          source: "manual",
        },
        repos: [],
        repoCount: 0,
      }),
      "utf-8"
    );
    _setSnapshotsDir(STORE_DIR);
  });

  after(() => {
    _resetSnapshotsDir();
    rmSync(BASE, { recursive: true, force: true });
  });

  void it("getSnapshot refuses a traversal ID", () => {
    strictEqual(getSnapshot("../outside"), null);
  });

  void it("deleteSnapshot refuses a traversal ID and keeps the outside file", () => {
    strictEqual(deleteSnapshot("../outside"), false);
    strictEqual(existsSync(OUTSIDE_FILE), true);
  });

  void it("updateSnapshotMeta refuses a traversal ID", () => {
    strictEqual(updateSnapshotMeta("../outside", { label: "pwned" }), false);
  });

  void it("getSnapshot refuses IDs with separators or dots", () => {
    strictEqual(getSnapshot("a/b"), null);
    strictEqual(getSnapshot(".."), null);
    strictEqual(getSnapshot("ABCDEF0123456789"), null);
  });
});
