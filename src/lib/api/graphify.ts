/**
 * Client-side API layer for Graphify endpoints.
 *
 * Two endpoints:
 *   GET /api/graphify?workspace=<path>       — per-repo artifact/capability metadata
 *   GET /api/graphify/lazy?repoId=<id>&op=X — single small operation (meta, open-html, wiki)
 *
 * This module is pure data-fetching — no UI, no state, no React.
 */

import type { GraphifyStatusResponse } from "@/lib/graphify/types";

/* ------------------------------------------------------------------ */
/*  Lightweight DTO types (mirrors server-side interfaces)              */
/* ------------------------------------------------------------------ */

/** Lightweight graph metadata returned by the lazy meta endpoint */
export interface GraphMetaDto {
  nodeCount: number;
  linkCount: number;
  communityCount: number | null;
  sizeBytes: number;
}

/* ------------------------------------------------------------------ */
/*  API helpers                                                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  GET /api/graphify                                                  */
/* ------------------------------------------------------------------ */

/**
 * Fetch graphify capability status for all repos in a workspace.
 *
 * @param workspacePath — Absolute path to a .code-workspace file
 * @param signal        — Optional AbortSignal for request cancellation
 */
export async function fetchGraphifyStatus(
  workspacePath: string,
  signal?: AbortSignal
): Promise<GraphifyStatusResponse> {
  return apiFetch<GraphifyStatusResponse>(
    `/api/graphify?workspace=${encodeURIComponent(workspacePath)}`,
    signal
  );
}

/**
 * Fetch graphify status for a single repo within a workspace.
 *
 * @param workspacePath — Absolute path to a .code-workspace file
 * @param repoId        — Repository ID (returned by workspace scan)
 * @param signal        — Optional AbortSignal
 * @returns The repo's GraphifyStatus, or null if not found
 */
export async function fetchGraphifyStatusForRepo(
  workspacePath: string,
  repoId: string,
  signal?: AbortSignal
): Promise<GraphifyStatusResponse["repos"][string] | null> {
  const res = await apiFetch<GraphifyStatusResponse>(
    `/api/graphify?workspace=${encodeURIComponent(workspacePath)}&repoId=${encodeURIComponent(repoId)}`,
    signal
  );
  return res.repos[repoId] ?? null;
}

/* ------------------------------------------------------------------ */
/*  GET /api/graphify/lazy?op=...                                      */
/* ------------------------------------------------------------------ */

/**
 * Fetch lightweight graph metadata (node/link/community counts, size).
 * Only available when graph.json exists and is under 10 MB.
 */
export async function fetchGraphMeta(
  repoId: string,
  signal?: AbortSignal
): Promise<{ repoId: string; meta: GraphMetaDto }> {
  return apiFetch<{ repoId: string; meta: GraphMetaDto }>(
    `/api/graphify/lazy?repoId=${encodeURIComponent(repoId)}&op=meta`,
    signal
  );
}

/**
 * Fetch the file:// URI for graph.html.
 * The caller should open it in a new tab/window.
 */
export async function fetchGraphHtmlUrl(
  repoId: string,
  signal?: AbortSignal
): Promise<{ repoId: string; url: string }> {
  return apiFetch<{ repoId: string; url: string }>(
    `/api/graphify/lazy?repoId=${encodeURIComponent(repoId)}&op=open-html`,
    signal
  );
}

/**
 * Fetch the first ~50 lines of wiki/index.md as plain text.
 */
export async function fetchWikiSnippet(
  repoId: string,
  signal?: AbortSignal
): Promise<{ repoId: string; snippet: string }> {
  return apiFetch<{ repoId: string; snippet: string }>(
    `/api/graphify/lazy?repoId=${encodeURIComponent(repoId)}&op=wiki`,
    signal
  );
}
