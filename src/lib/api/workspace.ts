/**
 * Client-side API layer for workspace endpoints.
 *
 * Anticipates optional live git detail fields:
 * - `branch`, `worktree`, `lastCommit` are always present from the scan
 * - Future live endpoints may enrich them (e.g., ahead/behind, status, upstream)
 *
 * No mutations. No server-side edits.
 */

import type {
  WorkspaceDefinition,
  WorkspaceFolder,
  Repository,
  GitWorktree,
  WorkspaceScanResult,
  RegistryEntry,
} from "@/lib/workspace/types";

/* ------------------------------------------------------------------ */
/*  Client-only UI types  (thin envelope over server types)            */
/* ------------------------------------------------------------------ */

/** Workspace load state used by UI components */
export type WorkspaceLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: WorkspaceViewData }
  | { status: "error"; message: string };

/** Aggregated view model for the workspace UI */
export interface WorkspaceViewData {
  definition: WorkspaceDefinition;
  repositories: RepoView[];
  scanErrors: string[];
}

/**
 * Repository view model used by the UI.
 *
 * Fields marked "future live" may be enriched by a separate live-git
 * fetch later. For now they come from the static scan.
 */
export interface RepoView {
  id: string;
  /** Absolute path to the repository root */
  rootPath: string;
  /** Short display name (last path segment) */
  displayName: string;
  /** Workspace folders this repo belongs to */
  folderMembership: string[];

  /* ── Worktree info (from scan, may be enriched live) ───── */
  worktree: GitWorktree | null;

  /* ── Future live-enrichable fields ──────────────────────── */
  // Currently populated from scan; a separate
  // GET /api/workspace/live?path=... endpoint could later enrich
  // these with ahead/behind, status, upstream URL, etc.
  branch: string | null;
  lastCommit: string | null;

  /* ── Folder-level diagnostics ───────────────────────────── */
  exists: boolean;
}

/** Recents list view model */
export interface RecentsView {
  entries: RegistryEntry[];
}

/* ------------------------------------------------------------------ */
/*  Adapters                                                           */
/* ------------------------------------------------------------------ */

function repoToView(r: Repository): RepoView {
  return {
    id: r.id,
    rootPath: r.rootPath,
    displayName: r.rootPath.split("/").pop() ?? r.rootPath,
    folderMembership: r.folderMembership,
    worktree: r.worktree,
    branch: r.worktree?.branch ?? null,
    lastCommit: null, // not yet available from static scan
    exists: true,
  };
}

/* ------------------------------------------------------------------ */
/*  API calls                                                         */
/* ------------------------------------------------------------------ */

/** Base URL for API calls (works in both dev and production) */
function apiBase(): string {
  if (typeof window === "undefined") return "http://localhost:3000";
  return "";
}

async function apiFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/** GET /api/workspace — list recently opened workspaces */
export async function fetchRecents(
  signal?: AbortSignal
): Promise<RecentsView> {
  const data = await apiFetch<{ entries: RegistryEntry[] }>(
    "/api/workspace",
    signal
  );
  return { entries: data.entries };
}

/**
 * GET /api/workspace/open?path=<path> — open a .code-workspace file.
 *
 * Returns the full scan result. Accepts absolute paths or ~-prefixed paths.
 */
export async function openWorkspace(
  path: string,
  signal?: AbortSignal
): Promise<WorkspaceViewData> {
  const data = await apiFetch<{
    workspace: WorkspaceDefinition;
    repositories: Repository[];
    scanErrors: string[];
  }>(`/api/workspace/open?path=${encodeURIComponent(path)}`, signal);

  return {
    definition: data.workspace,
    repositories: data.repositories.map(repoToView),
    scanErrors: data.scanErrors ?? [],
  };
}

/** Re-fetch workspace data (same path) — useful for refresh */
export async function refreshWorkspace(
  path: string,
  signal?: AbortSignal
): Promise<WorkspaceViewData> {
  return openWorkspace(path, signal);
}
