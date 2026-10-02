/**
 * Versioned local-only snapshot store.
 *
 * Snapshots stored atomically outside any managed repository:
 *   ~/.config/dashboard/snapshots/<id>.json
 *   ~/.config/dashboard/snapshots/index.json
 *
 * Each snapshot is a standalone JSON file (self-describing schema v1).
 * The index is a lightweight list for list/get operations.
 *
 * Operations: create, list, get, delete, duplicate, update metadata.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes } from "node:crypto";
import type {
  SnapshotSchema,
  SnapshotIndex,
  SnapshotEntry,
  SnapshotMeta,
} from "./types";

/* ------------------------------------------------------------------ */
/*  Paths                                                             */
/* ------------------------------------------------------------------ */

const SNAPSHOTS_REL = ".config/dashboard/snapshots";

/** Overridable for testing */
let _overriddenDir: string | null = null;

export function _setSnapshotsDir(dir: string): void {
  _overriddenDir = dir;
}

export function _resetSnapshotsDir(): void {
  _overriddenDir = null;
}

function snapshotsDir(): string {
  if (_overriddenDir) return _overriddenDir;
  return resolve(homedir(), SNAPSHOTS_REL);
}

function snapshotPath(id: string): string {
  return resolve(snapshotsDir(), `${id}.json`);
}

function indexPath(): string {
  return resolve(snapshotsDir(), "index.json");
}

/* ------------------------------------------------------------------ */
/*  Directory/file helpers                                            */
/* ------------------------------------------------------------------ */

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function generateId(label: string): string {
  const hash = createHash("sha256");
  hash.update(label);
  hash.update("\0");
  hash.update(randomBytes(8));
  hash.update(Date.now().toString());
  return hash.digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ */
/*  Atomic write                                                      */
/* ------------------------------------------------------------------ */

/**
 * Write a JSON file atomically by writing to a temp file then renaming.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp." + randomBytes(4).toString("hex");
  ensureDir(filePath);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

/* ------------------------------------------------------------------ */
/*  Index operations                                                   */
/* ------------------------------------------------------------------ */

function loadIndex(): SnapshotIndex {
  const path = indexPath();
  if (!existsSync(path)) {
    return { version: 1, entries: [] };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as SnapshotIndex;
    if (data?.version === 1 && Array.isArray(data?.entries)) {
      return data;
    }
    return { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveIndex(index: SnapshotIndex): void {
  atomicWriteJson(indexPath(), index);
}

function entryFromSchema(schema: SnapshotSchema, id: string): SnapshotEntry {
  return {
    id,
    version: 1,
    meta: schema.meta,
    repoCount: schema.repoCount,
    updatedAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

/**
 * Create a new snapshot from a schema and persist it.
 * Returns the generated snapshot ID.
 */
export function createSnapshot(schema: Omit<SnapshotSchema, "version">): SnapshotEntry {
  const id = generateId(schema.meta.label);
  const fullSchema: SnapshotSchema = {
    ...schema,
    version: 1,
  };

  // Write schema file
  atomicWriteJson(snapshotPath(id), fullSchema);

  // Update index
  const index = loadIndex();
  const entry = entryFromSchema(fullSchema, id);
  index.entries.unshift(entry);
  saveIndex(index);

  return entry;
}

/**
 * List all snapshots (metadata only, no repo data).
 * Most recent first.
 */
export function listSnapshots(): SnapshotEntry[] {
  return loadIndex().entries;
}

/**
 * Get a full snapshot schema by ID.
 * Returns null if not found.
 */
export function getSnapshot(id: string): SnapshotSchema | null {
  const path = snapshotPath(id);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as SnapshotSchema;
    if (data?.version === 1 && Array.isArray(data?.repos)) {
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete a snapshot by ID.
 * Returns true if deleted, false if not found.
 */
export function deleteSnapshot(id: string): boolean {
  // Remove schema file
  const path = snapshotPath(id);
  if (existsSync(path)) {
    unlinkSync(path);
  } else {
    return false;
  }

  // Update index
  const index = loadIndex();
  const before = index.entries.length;
  index.entries = index.entries.filter((e) => e.id !== id);
  if (index.entries.length !== before) {
    saveIndex(index);
  }

  return true;
}

/**
 * Duplicate a snapshot with a new label.
 * Returns the new snapshot entry, or null if source not found.
 */
export function duplicateSnapshot(id: string, newLabel: string): SnapshotEntry | null {
  const source = getSnapshot(id);
  if (!source) return null;

  const dup: Omit<SnapshotSchema, "version"> = {
    meta: {
      ...source.meta,
      label: newLabel,
      createdAt: new Date().toISOString(),
      source: "manual",
    },
    repos: source.repos.map((r) => ({ ...r })),
    repoCount: source.repoCount,
  };

  return createSnapshot(dup);
}

/**
 * Update snapshot metadata (label, description).
 * Returns true if updated, false if not found.
 */
export function updateSnapshotMeta(
  id: string,
  updates: { label?: string; description?: string }
): boolean {
  const schema = getSnapshot(id);
  if (!schema) return false;

  if (updates.label !== undefined) {
    schema.meta.label = updates.label;
  }
  if (updates.description !== undefined) {
    schema.meta.description = updates.description;
  }

  atomicWriteJson(snapshotPath(id), schema);

  // Update index entry
  const index = loadIndex();
  const idx = index.entries.findIndex((e) => e.id === id);
  if (idx >= 0) {
    index.entries[idx] = entryFromSchema(schema, id);
    saveIndex(index);
  }

  return true;
}

/**
 * Repair index by scanning snapshot files on disk.
 * Useful if index becomes out of sync.
 */
export function rebuildIndex(): SnapshotEntry[] {
  const dir = snapshotsDir();
  if (!existsSync(dir)) {
    saveIndex({ version: 1, entries: [] });
    return [];
  }

  const entries: SnapshotEntry[] = [];
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      if (!file.endsWith(".json") || file === "index.json") continue;
      const id = file.replace(/\.json$/, "");
      const schema = getSnapshot(id);
      if (schema) {
        entries.push(entryFromSchema(schema, id));
      }
    }
  } catch {
    // Ignore read errors
  }

  // Sort most-recent first
  entries.sort(
    (a, b) => new Date(b.meta.createdAt).getTime() - new Date(a.meta.createdAt).getTime()
  );

  const index: SnapshotIndex = { version: 1, entries };
  saveIndex(index);
  return entries;
}

/**
 * Total count of snapshots stored.
 */
export function snapshotCount(): number {
  return loadIndex().entries.length;
}
