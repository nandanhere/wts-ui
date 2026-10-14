/**
 * Local sanitized bounded audit journal.
 *
 * Records all mutation operations with structured metadata.
 * Stored in ~/.config/dashboard/git-journal.json
 * Capped at 500 entries (oldest pruned first).
 *
 * Does NOT record:
 * - Credentials, secret URLs, or tokens
 * - File diffs or content
 * - Arbitrary output that might contain secrets
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import type { JournalEntry, JournalData } from "./types";

const JOURNAL_REL = ".config/dashboard/git-journal.json";
const MAX_ENTRIES = 500;

function journalPath(): string {
  return process.env.DASHBOARD_JOURNAL_PATH
    ? resolve(process.env.DASHBOARD_JOURNAL_PATH)
    : resolve(homedir(), JOURNAL_REL);
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function generateId(): string {
  const hash = createHash("sha256");
  hash.update(randomBytes(16));
  hash.update(Date.now().toString());
  return hash.digest("hex").slice(0, 16);
}

function loadRaw(): JournalData {
  const path = journalPath();
  if (!existsSync(path)) {
    return { version: 1, entries: [] };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as JournalData;
    if (data?.version === 1 && Array.isArray(data?.entries)) {
      return data;
    }
    return { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveRaw(data: JournalData): void {
  const path = journalPath();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Write a journal entry. Timestamp and ID are auto-generated.
 * The entry is prepended; old entries beyond MAX_ENTRIES are pruned.
 */
export function writeJournalEntry(
  entry: Omit<JournalEntry, "id" | "timestamp">
): JournalEntry {
  const data = loadRaw();

  const full: JournalEntry = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  data.entries.unshift(full);

  if (data.entries.length > MAX_ENTRIES) {
    data.entries.length = MAX_ENTRIES;
  }

  saveRaw(data);
  return full;
}

/** Return all journal entries, most-recent-first. */
export function listJournalEntries(limit = 100): JournalEntry[] {
  const data = loadRaw();
  return data.entries.slice(0, limit);
}

/** Get a single journal entry by ID. */
export function getJournalEntry(id: string): JournalEntry | undefined {
  return loadRaw().entries.find((e) => e.id === id);
}

/** Clear all journal entries. */
export function clearJournal(): void {
  saveRaw({ version: 1, entries: [] });
}
