/**
 * Client-side API layer for config inventory (deployment readiness).
 *
 * All data is metadata-only — file contents are never fetched or displayed.
 * Aggregation helpers are pure functions exported for unit testing.
 */

import type {
  ConfigInventoryResult,
  ConfigFileMetadata,
} from "@/lib/config-inventory/types";

/* ------------------------------------------------------------------ */
/*  Public API call                                                    */
/* ------------------------------------------------------------------ */

export interface ScanRequest {
  repoIds: string[];
}

export interface ScanResponse {
  results: ConfigInventoryResult[];
  unknownRepoIds: string[];
  anyTruncated: boolean;
}

/**
 * POST /api/config-inventory — scan registered repos for config files.
 * Returns metadata only, never content/values.
 */
export async function scanReposForConfig(
  repoIds: string[],
  signal?: AbortSignal,
): Promise<ScanResponse> {
  const res = await fetch("/api/config-inventory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoIds } satisfies ScanRequest),
    signal,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `API error ${res.status}`,
    );
  }
  return res.json() as Promise<ScanResponse>;
}

/* ------------------------------------------------------------------ */
/*  View models                                                        */
/* ------------------------------------------------------------------ */

export interface RepoConfigSummary {
  repoId: string;
  displayName: string;
  totalFiles: number;
  highRelevanceFiles: number;
  secretFiles: string[];
  environments: string[];
  truncated: boolean;
  errors: string[];
  scanTimeMs: number;
  files: ConfigFileMetadata[];
}

export interface DeploymentsView {
  summaries: RepoConfigSummary[];
  totalConfigFiles: number;
  totalHighRelevance: number;
  totalSecretFiles: number;
  allEnvironments: string[];
  anyTruncated: boolean;
  anyErrors: boolean;
  unknownRepoIds: string[];
}

/* ------------------------------------------------------------------ */
/*  Pure aggregation helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Shorten a SHA-256 hex fingerprint for compact display.
 * Shows first 8 hex chars + ellipsis.
 */
export function shortenFingerprint(fp: string): string {
  if (!fp || fp.length < 8) return fp;
  return `${fp.slice(0, 8)}…`;
}

/**
 * Aggregate a raw ConfigInventoryResult into a repo summary.
 * The `displayName` is the last path segment of the repo root.
 */
export function summarizeRepoResult(
  result: ConfigInventoryResult,
  displayName: string,
): RepoConfigSummary {
  const highRelevance = result.files.filter(
    (f) => f.deploymentRelevance >= 0.7,
  );
  const secretFiles = result.files
    .filter((f) => f.probableSecret)
    .map((f) => f.repoRelativePath);
  const environments = [
    ...new Set(result.files.flatMap((f) => f.likelyEnvironments)),
  ].sort();

  return {
    repoId: result.repoId,
    displayName,
    totalFiles: result.files.length,
    highRelevanceFiles: highRelevance.length,
    secretFiles,
    environments,
    truncated: result.truncated,
    errors: result.errors,
    scanTimeMs: result.scanTimeMs,
    files: result.files,
  };
}

/**
 * Aggregate per-repo summaries into a top-level deployments view.
 */
export function aggregateDeploymentsView(
  results: ConfigInventoryResult[],
  displayMap: Record<string, string>,
  unknownRepoIds: string[],
): DeploymentsView {
  const summaries = results.map((r) =>
    summarizeRepoResult(r, displayMap[r.repoId] ?? r.repoId),
  );

  const totalConfigFiles = summaries.reduce(
    (acc, s) => acc + s.totalFiles,
    0,
  );
  const totalHighRelevance = summaries.reduce(
    (acc, s) => acc + s.highRelevanceFiles,
    0,
  );
  const totalSecretFiles = summaries.reduce(
    (acc, s) => acc + s.secretFiles.length,
    0,
  );
  const allEnvironments = [
    ...new Set(summaries.flatMap((s) => s.environments)),
  ].sort();
  const anyTruncated = summaries.some((s) => s.truncated);
  const anyErrors = summaries.some((s) => s.errors.length > 0);

  return {
    summaries,
    totalConfigFiles,
    totalHighRelevance,
    totalSecretFiles,
    allEnvironments,
    anyTruncated,
    anyErrors,
    unknownRepoIds,
  };
}

/**
 * Group config files by kind for a repo, sorted by count descending.
 */
export function groupFilesByKind(
  files: ConfigFileMetadata[],
): Array<{ kind: string; count: number }> {
  const map = new Map<string, number>();
  for (const f of files) {
    map.set(f.kind, (map.get(f.kind) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
}
