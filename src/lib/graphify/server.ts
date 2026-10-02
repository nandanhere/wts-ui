/**
 * Graphify server — composition layer that accepts scan results from
 * workspace discovery and produces per-repo GraphifyStatus metadata.
 *
 * This is the only module that knows about workspace scan contracts.
 * It does NOT import dashboard-page.tsx or any UI code.
 */

import type { WorkspaceScanResult } from "@/lib/workspace/types";
import type {
  GraphifyStatus,
  GraphifyStatusResponse,
} from "./types";
import { buildGraphifyStatus } from "./provider";

/**
 * Enrich a workspace scan result with graphify capability metadata
 * for each discovered repository.
 *
 * @param scanResult — output of workspace scanWorkspace()
 * @returns a GraphifyStatusResponse keyed by repo ID
 */
export function enrichReposWithGraphify(
  scanResult: WorkspaceScanResult
): GraphifyStatusResponse {
  const repos: Record<string, GraphifyStatus> = {};
  const errors: string[] = [...scanResult.errors];

  // Build an authorization set from the scan's own repositories
  const authorizedRoots = new Set(
    scanResult.repositories.map((r) => r.rootPath)
  );

  for (const repo of scanResult.repositories) {
    try {
      repos[repo.id] = buildGraphifyStatus(repo.id, repo.rootPath);
    } catch (err) {
      // Non-fatal per-repo error
      errors.push(
        `graphify status for ${repo.id} (${repo.rootPath}): ${String(err)}`
      );
    }
  }

  return { repos, errors };
}

/**
 * Build a GraphifyStatusResponse for a single repo given its ID and root.
 * This is a convenience for single-repo lookups (API endpoint).
 *
 * @param repoId     — Stable repository ID
 * @param repoRoot   — Absolute canonical repo root path
 * @param authorized — Set of authorized repo roots for access control
 */
export function enrichSingleRepo(
  repoId: string,
  repoRoot: string,
  authorized: Set<string>
): GraphifyStatusResponse {
  const errors: string[] = [];

  if (!authorized.has(repoRoot)) {
    return {
      repos: {},
      errors: [
        `Unauthorized path: "${repoRoot}" is not a registered repository root`,
      ],
    };
  }

  const status = buildGraphifyStatus(repoId, repoRoot);
  return { repos: { [repoId]: status }, errors };
}

/** Re-export types for convenience */
export type { GraphifyStatus, GraphifyStatusResponse } from "./types";
