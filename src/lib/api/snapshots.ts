/**
 * Client-side API layer for snapshot endpoints.
 *
 * Wraps all snapshot REST endpoints with typed interfaces.
 * No remote URLs, no secrets, no content.
 */

import type {
  SnapshotEntry,
  SnapshotSchema,
  DriftResult,
  RestorePlan,
  ActivationResult,
} from "@/lib/snapshot/types";
import { ensureActionToken, resetCachedToken } from "@/lib/api/git";

/* ------------------------------------------------------------------ */
/*  Client view models                                                */
/* ------------------------------------------------------------------ */

export type SnapshotsLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: SnapshotListViewData }
  | { status: "error"; message: string };

export type SnapshotDetailState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: SnapshotDetailViewData }
  | { status: "error"; message: string };

export interface SnapshotListViewData {
  snapshots: SnapshotEntry[];
}

export interface SnapshotDetailViewData {
  schema: SnapshotSchema;
  drift: DriftResult | null;
  plan: RestorePlan | null;
}

/** Minimal create payload sent to the API */
export interface CreateSnapshotPayload {
  label: string;
  description?: string;
  source?: "manual" | "auto" | "restore-point";
}

/* ------------------------------------------------------------------ */
/*  API helpers                                                        */
/* ------------------------------------------------------------------ */

function apiBase(): string {
  if (typeof window === "undefined") return "http://localhost:3000";
  return "";
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/* ------------------------------------------------------------------ */
/*  Snapshot list / create                                             */
/* ------------------------------------------------------------------ */

/** GET /api/snapshots — list all snapshots */
export async function fetchSnapshots(
  signal?: AbortSignal
): Promise<SnapshotListViewData> {
  const data = await apiFetch<{ snapshots: SnapshotEntry[] }>(
    "/api/snapshots",
    { signal }
  );
  return { snapshots: data.snapshots };
}

/** POST /api/snapshots — create a new snapshot */
export async function createSnapshot(
  payload: CreateSnapshotPayload,
  signal?: AbortSignal
): Promise<SnapshotEntry> {
  const data = await apiFetch<{ snapshot: SnapshotEntry }>("/api/snapshots", {
    method: "POST",
    body: JSON.stringify(payload),
    signal,
  });
  return data.snapshot;
}

/* ------------------------------------------------------------------ */
/*  Single snapshot operations                                         */
/* ------------------------------------------------------------------ */

/** GET /api/snapshots/[id] — get full snapshot schema */
export async function fetchSnapshotDetail(
  id: string,
  signal?: AbortSignal
): Promise<SnapshotSchema> {
  const data = await apiFetch<{ snapshot: SnapshotSchema }>(
    `/api/snapshots/${encodeURIComponent(id)}`,
    { signal }
  );
  return data.snapshot;
}

/** DELETE /api/snapshots/[id] — delete a snapshot */
export async function deleteSnapshot(
  id: string
): Promise<{ deleted: boolean }> {
  return apiFetch<{ deleted: boolean; id: string }>(
    `/api/snapshots/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  );
}

/** PATCH /api/snapshots/[id] — update snapshot metadata */
export async function updateSnapshotMeta(
  id: string,
  updates: { label?: string; description?: string }
): Promise<{ updated: boolean }> {
  return apiFetch<{ updated: boolean; id: string }>(
    `/api/snapshots/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify(updates),
    }
  );
}

/* ------------------------------------------------------------------ */
/*  Drift / restore / duplicate                                        */
/* ------------------------------------------------------------------ */

/** GET /api/snapshots/[id]/drift — analyze drift (read-only) */
export async function fetchDrift(
  id: string,
  signal?: AbortSignal
): Promise<DriftResult> {
  const data = await apiFetch<{ drift: DriftResult }>(
    `/api/snapshots/${encodeURIComponent(id)}/drift`,
    { signal }
  );
  return data.drift;
}

/** GET /api/snapshots/[id]/restore — generate restore plan (preview only) */
export async function fetchRestorePlan(
  id: string,
  signal?: AbortSignal
): Promise<RestorePlan> {
  const data = await apiFetch<{ plan: RestorePlan }>(
    `/api/snapshots/${encodeURIComponent(id)}/restore`,
    { signal }
  );
  return data.plan;
}

/**
 * POST /api/snapshots/[id]/restore — explicitly activate safe combination
 * entries. Unsafe repositories are returned as blocked and left untouched.
 */
export async function activateSnapshot(
  id: string,
  repoIds?: string[],
  retryToken = true
): Promise<ActivationResult> {
  const token = await ensureActionToken();
  const res = await fetch(
    `${apiBase()}/api/snapshots/${encodeURIComponent(id)}/restore`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-action-token": token,
      },
      body: JSON.stringify({ confirm: "activate", repoIds }),
    }
  );

  if (res.status === 403 && retryToken) {
    resetCachedToken();
    return activateSnapshot(id, repoIds, false);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `API error ${res.status}`);
  }
  const data = (await res.json()) as { activation: ActivationResult };
  return data.activation;
}

/** POST /api/snapshots/[id]/duplicate — duplicate a snapshot */
export async function duplicateSnapshot(
  id: string,
  label: string
): Promise<SnapshotEntry> {
  const data = await apiFetch<{ snapshot: SnapshotEntry }>(
    `/api/snapshots/${encodeURIComponent(id)}/duplicate`,
    {
      method: "POST",
      body: JSON.stringify({ label }),
    }
  );
  return data.snapshot;
}

/** Load full detail (schema + drift + plan) in parallel */
export async function fetchSnapshotWithAnalysis(
  id: string,
  signal?: AbortSignal
): Promise<SnapshotDetailViewData> {
  const [schema, drift, plan] = await Promise.all([
    fetchSnapshotDetail(id, signal),
    fetchDrift(id, signal),
    fetchRestorePlan(id, signal),
  ]);
  return { schema, drift, plan };
}
