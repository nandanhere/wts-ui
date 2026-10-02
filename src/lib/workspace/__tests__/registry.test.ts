/**
 * Tests for workspace registry persistence.
 * Run: node --experimental-strip-types --test src/lib/workspace/__tests__/registry.test.ts
 *
 * Uses a temporary directory via environment variable override to
 * avoid polluting the user's real registry.
 */

import { describe, it, before, after } from "node:test";
import { strictEqual, ok } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  upsertRegistryEntry,
  listRegistryEntries,
  getRegistryEntry,
  removeRegistryEntry,
} from "../registry";

// Override registry location by setting HOME to a temp dir
const _origHOME = process.env.HOME;
const TMP = resolve(tmpdir(), "dashboard-registry-test");

void describe("registry", () => {
  before(() => {
    process.env.HOME = TMP;
    // Clean any leftover state from previous runs
    rmSync(resolve(TMP, ".config"), { recursive: true, force: true });
  });

  after(() => {
    process.env.HOME = _origHOME;
    rmSync(resolve(TMP, ".config"), { recursive: true, force: true });
  });

  void it("starts empty", () => {
    const entries = listRegistryEntries();
    strictEqual(entries.length, 0);
  });

  void it("upserts and lists entries", () => {
    const entry = upsertRegistryEntry(
      "/home/test/code-workspace",
      "Test Workspace",
      3,
      5
    );
    strictEqual(entry.label, "Test Workspace");
    strictEqual(entry.folderCount, 3);
    strictEqual(entry.repoCount, 5);
    ok(entry.lastOpened.length > 0);

    const list = listRegistryEntries();
    strictEqual(list.length, 1);
    strictEqual(list[0].filePath, "/home/test/code-workspace");
  });

  void it("updates existing entry on re-upsert", () => {
    upsertRegistryEntry(
      "/home/test/code-workspace",
      "Test Workspace",
      10,
      20
    );
    const entry = getRegistryEntry("/home/test/code-workspace");
    ok(entry);
    strictEqual(entry.folderCount, 10);
    strictEqual(entry.repoCount, 20);
  });

  void it("lists most-recently-opened first", () => {
    upsertRegistryEntry("/home/test/ws2", "Workspace 2", 1, 0);
    const entries = listRegistryEntries();
    strictEqual(entries.length, 2);
    // ws2 should be first (most recently opened)
    strictEqual(entries[0].filePath, "/home/test/ws2");
    strictEqual(entries[1].filePath, "/home/test/code-workspace");
  });

  void it("removes entry", () => {
    const removed = removeRegistryEntry("/home/test/ws2");
    strictEqual(removed, true);
    strictEqual(listRegistryEntries().length, 1);
    strictEqual(getRegistryEntry("/home/test/ws2"), undefined);
  });

  void it("returns false when removing non-existent entry", () => {
    const removed = removeRegistryEntry("/nonexistent");
    strictEqual(removed, false);
  });

  void it("persists to disk", () => {
    const regPath = resolve(TMP, ".config/dashboard/workspace-registry.json");
    ok(existsSync(regPath), "registry file should exist on disk");
    const raw = JSON.parse(readFileSync(regPath, "utf-8"));
    strictEqual(raw.version, 1);
    ok(Array.isArray(raw.entries));
  });
});
