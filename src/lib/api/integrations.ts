/**
 * Client-side API layer for the integrations endpoint.
 *
 * Fetches the workspace integration manifest from GET /api/integrations.
 * No workspace/path query parameters — endpoint is authoritative server-side.
 *
 * The caller should pass an AbortSignal from an AbortController to
 * avoid stale UI fetches after component unmount or workspace changes.
 */

import type { WorkspaceManifest } from "@/lib/integrations/types";

/* ------------------------------------------------------------------ */
/*  Load state                                                         */
/* ------------------------------------------------------------------ */

/** Load state for the integrations panel. */
export type IntegrationsLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: WorkspaceManifest }
  | { status: "error"; message: string };

/* ------------------------------------------------------------------ */
/*  API call                                                           */
/* ------------------------------------------------------------------ */

function apiBase(): string {
  if (typeof window === "undefined") return "http://localhost:3000";
  return "";
}

/**
 * Fetch the workspace integration manifest.
 *
 * GET /api/integrations — no query params, no path input from client.
 * The endpoint authoritatively determines the workspace context server-side.
 */
export async function fetchIntegrationsManifest(
  signal?: AbortSignal
): Promise<WorkspaceManifest> {
  const res = await fetch(`${apiBase()}/api/integrations`, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `API error ${res.status}`);
  }

  return res.json() as Promise<WorkspaceManifest>;
}
