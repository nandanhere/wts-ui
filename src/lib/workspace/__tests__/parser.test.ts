/**
 * Tests for .code-workspace parser.
 * Run: node --experimental-strip-types --test src/lib/workspace/__tests__/parser.test.ts
 */

import { describe, it, after } from "node:test";
import { ok, strictEqual, deepEqual } from "node:assert";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkspaceFile } from "../parser";

const tmp = resolve(tmpdir(), "dashboard-parser-test");
mkdirSync(tmp, { recursive: true });

// Create a dummy directory that the workspace file can reference
const repoDir = resolve(tmp, "my-repo");
mkdirSync(repoDir, { recursive: true });

const goodWorkspace = resolve(tmp, "test.code-workspace");
const badJson = resolve(tmp, "bad.code-workspace");
const missingFile = resolve(tmp, "nope.code-workspace");

writeFileSync(
  goodWorkspace,
  JSON.stringify(
    {
      folders: [
        { name: "My Repo", path: repoDir },
        "../outside", // string form — will be resolved relative to workspace
      ],
      settings: { "files.exclude": { "**/.git": false } },
      extensions: { recommendations: ["golang.go"] },
    },
    null,
    2
  ),
  "utf-8"
);

writeFileSync(badJson, "not json", "utf-8");

void describe("loadWorkspaceFile", () => {
  void after(() => {
    try {
      unlinkSync(goodWorkspace);
      unlinkSync(badJson);
    } catch {
      /* ignore */
    }
  });

  void it("loads a valid .code-workspace file", () => {
    const ws = loadWorkspaceFile(goodWorkspace);
    strictEqual(ws.name, "test");
    strictEqual(ws.filePath, goodWorkspace);
    ok(ws.folders.length >= 1);
    strictEqual(ws.folders[0].name, "My Repo");
    // macOS resolves /var -> /private/var via realpath, so use ok() with includes
    ok(ws.folders[0].resolvedPath.includes("dashboard-parser-test/my-repo"));
    strictEqual(ws.folders[0].exists, true);
    ok(ws.settings !== undefined);
    ok(ws.extensions !== undefined);
  });

  void it("throws on missing file", () => {
    ok.throws(() => loadWorkspaceFile(missingFile), /not found/);
  });

  void it("throws on invalid JSON", () => {
    ok.throws(() => loadWorkspaceFile(badJson));
  });

  void it("handles string-form folder entries", () => {
    const ws = loadWorkspaceFile(goodWorkspace);
    // The string entry "../outside" should be resolved
    const stringFolder = ws.folders.find((f) => f.rawPath === "../outside");
    ok(stringFolder, "string-form folder should be present");
    ok(stringFolder.resolvedPath.includes("/outside"), "resolved path should contain /outside");
  });

  void it("deduplicates by resolved path", () => {
    // Write a workspace with duplicate entries
    const dupFile = resolve(tmp, "dup.code-workspace");
    writeFileSync(
      dupFile,
      JSON.stringify({
        folders: [
          { name: "First", path: repoDir },
          { name: "Second", path: repoDir },
        ],
      }),
      "utf-8"
    );
    const ws = loadWorkspaceFile(dupFile);
    strictEqual(ws.folders.length, 1, "duplicate folders should be deduplicated");
    unlinkSync(dupFile);
  });

  void it("handles missing folder gracefully", () => {
    const missingFolderFile = resolve(tmp, "missing.code-workspace");
    writeFileSync(
      missingFolderFile,
      JSON.stringify({
        folders: [
          { name: "Missing", path: "/nonexistent/path/xyz" },
        ],
      }),
      "utf-8"
    );
    const ws = loadWorkspaceFile(missingFolderFile);
    strictEqual(ws.folders.length, 1);
    strictEqual(ws.folders[0].exists, false);
    unlinkSync(missingFolderFile);
  });

  void it("handles no folders", () => {
    const emptyFile = resolve(tmp, "empty.code-workspace");
    writeFileSync(emptyFile, JSON.stringify({}), "utf-8");
    const ws = loadWorkspaceFile(emptyFile);
    strictEqual(ws.folders.length, 0);
    unlinkSync(emptyFile);
  });
});
