/**
 * Tests for audit journal.
 *
 * Uses an explicit temporary journal path.
 * Run: node --experimental-strip-types --test src/lib/git/__tests__/journal.test.ts
 */

import { describe, it, before, after } from "node:test";
import { strictEqual, ok } from "node:assert";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  writeJournalEntry,
  listJournalEntries,
  getJournalEntry,
  clearJournal,
} from "../journal";

const TMP = resolve(tmpdir(), "dashboard-journal-test");
const JOURNAL_PATH = resolve(TMP, "git-journal.json");
const originalJournalPath = process.env.DASHBOARD_JOURNAL_PATH;

void describe("Journal", () => {
  before(() => {
    process.env.DASHBOARD_JOURNAL_PATH = JOURNAL_PATH;
    rmSync(TMP, { recursive: true, force: true });
  });

  after(() => {
    if (originalJournalPath === undefined) delete process.env.DASHBOARD_JOURNAL_PATH;
    else process.env.DASHBOARD_JOURNAL_PATH = originalJournalPath;
    rmSync(TMP, { recursive: true, force: true });
  });

  void it("starts empty", () => {
    const entries = listJournalEntries();
    strictEqual(entries.length, 0);
  });

  void it("writes a journal entry", () => {
    const entry = writeJournalEntry({
      workspaceFilePath: "/home/test/test.code-workspace",
      repoId: "test-repo",
      action: "fetch",
      params: { remote: "origin" },
      result: "success",
      durationMs: 150,
    });

    ok(entry.id.length > 0, "should generate an ID");
    ok(entry.timestamp.length > 0, "should have a timestamp");
    strictEqual(entry.action, "fetch");
    strictEqual(entry.result, "success");
    strictEqual(entry.durationMs, 150);
  });

  void it("lists entries most-recent-first", () => {
    writeJournalEntry({
      workspaceFilePath: "",
      repoId: "repo-a",
      action: "switch",
      params: { target: "main" },
      result: "success",
      durationMs: 200,
    });

    const entries = listJournalEntries();
    strictEqual(entries.length, 2);
    strictEqual(entries[0]!.action, "switch");
  });

  void it("retrieves entry by ID", () => {
    const entry = writeJournalEntry({
      workspaceFilePath: "",
      repoId: "repo-b",
      action: "worktree-create",
      params: { branch: "feature" },
      result: "success",
      durationMs: 300,
    });

    const found = getJournalEntry(entry.id);
    ok(found, "should find entry by ID");
    strictEqual(found!.action, "worktree-create");
  });

  void it("returns undefined for unknown ID", () => {
    const found = getJournalEntry("nonexistent-id");
    strictEqual(found, undefined);
  });

  void it("clears all entries", () => {
    clearJournal();
    const entries = listJournalEntries();
    strictEqual(entries.length, 0);
  });

  void it("persists to disk", () => {
    const jPath = JOURNAL_PATH;
    // Write one entry first
    writeJournalEntry({
      workspaceFilePath: "",
      repoId: "persist-test",
      action: "fetch",
      params: {},
      result: "success",
      durationMs: 50,
    });
    ok(existsSync(jPath), "journal file should exist on disk");
    const raw = JSON.parse(readFileSync(jPath, "utf-8"));
    strictEqual(raw.version, 1);
    ok(Array.isArray(raw.entries));
  });
});
