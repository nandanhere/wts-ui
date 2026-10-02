/**
 * Local workspace registry — persists recently opened workspace files,
 * labels, and metadata *outside* any managed repository.
 *
 * Storage: `~/.config/dashboard/workspace-registry.json`
 * in the user's home directory (XDG-compatible, macOS-friendly).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import type { RegistryData, RegistryEntry } from "./types";

const REGISTRY_REL = ".config/dashboard/workspace-registry.json";
const MAX_ENTRIES = 50;

function registryPath(): string {
  return resolve(homedir(), REGISTRY_REL);
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadRaw(): RegistryData {
  const path = registryPath();
  if (!existsSync(path)) {
    return { version: 1, entries: [] };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as RegistryData;
    if (data?.version === 1 && Array.isArray(data?.entries)) {
      return data;
    }
    return { version: 1, entries: [] };
  } catch {
    return { version: 1, entries: [] };
  }
}

function saveRaw(data: RegistryData): void {
  const path = registryPath();
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

/**
 * Add or update a registry entry.
 * If the filePath already exists, updates label + lastOpened.
 * Otherwise prepends a new entry, capped at MAX_ENTRIES.
 */
export function upsertRegistryEntry(
  filePath: string,
  label: string,
  folderCount: number,
  repoCount: number
): RegistryEntry {
  const data = loadRaw();
  const idx = data.entries.findIndex((e) => e.filePath === filePath);
  const now = new Date().toISOString();

  const entry: RegistryEntry = {
    filePath,
    label,
    lastOpened: now,
    folderCount,
    repoCount,
  };

  if (idx >= 0) {
    data.entries[idx] = { ...data.entries[idx], ...entry };
  } else {
    data.entries.unshift(entry);
    if (data.entries.length > MAX_ENTRIES) {
      data.entries.length = MAX_ENTRIES;
    }
  }

  saveRaw(data);
  return entry;
}

/** Return all registry entries, most-recently-opened first. */
export function listRegistryEntries(): RegistryEntry[] {
  return loadRaw().entries;
}

/** Get a single registry entry by filePath, or undefined. */
export function getRegistryEntry(
  filePath: string
): RegistryEntry | undefined {
  return loadRaw().entries.find((e) => e.filePath === filePath);
}

/** Remove a registry entry by filePath. */
export function removeRegistryEntry(filePath: string): boolean {
  const data = loadRaw();
  const before = data.entries.length;
  data.entries = data.entries.filter((e) => e.filePath !== filePath);
  if (data.entries.length !== before) {
    saveRaw(data);
    return true;
  }
  return false;
}
