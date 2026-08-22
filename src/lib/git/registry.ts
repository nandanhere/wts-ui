/**
 * In-memory repository registry shared between workspace/open and git/* routes.
 *
 * Populated when a workspace is opened; consulted by status/preflight/mutation
 * routes to resolve repo IDs to Repository objects without re-scanning.
 */

import type { Repository } from "@/lib/workspace/types";
import { _clearRepoPaths, _setRepoPaths } from "@/lib/git/runner";
import { existsSync, realpathSync } from "node:fs";

interface RepoRegistryState {
  repos: Map<string, Repository>;
  openedWorkspaceFilePath: string | null;
}

const globalRegistry = globalThis as typeof globalThis & {
  __wtsUiRepoRegistry?: RepoRegistryState;
};

const registryState = globalRegistry.__wtsUiRepoRegistry ??= {
  repos: new Map<string, Repository>(),
  openedWorkspaceFilePath: null,
};

/**
 * Register repositories for status/mutation lookups.
 * Also registers canonical paths in the git runner for safety checks.
 */
export function registerRepos(repos: Repository[], workspaceFilePath?: string): void {
  registryState.repos.clear();
  registryState.openedWorkspaceFilePath = workspaceFilePath ?? null;
  const canonicalPaths: string[] = [];
  for (const repo of repos) {
    registryState.repos.set(repo.id, repo);
    try {
      if (existsSync(repo.rootPath)) {
        canonicalPaths.push(realpathSync(repo.rootPath));
      }
    } catch {
      // Skip if path doesn't exist
    }
  }
  _setRepoPaths(canonicalPaths);
}

/** Clear all registered repos. */
export function clearRepoRegistry(): void {
  registryState.repos.clear();
  registryState.openedWorkspaceFilePath = null;
  _clearRepoPaths();
}

/** Get a single repository by ID. */
export function getRepo(id: string): Repository | undefined {
  return registryState.repos.get(id);
}

/** Get all registered repositories. */
export function getAllRepos(): Repository[] {
  return Array.from(registryState.repos.values());
}

/** Check if a repo ID is registered. */
export function hasRepo(id: string): boolean {
  return registryState.repos.has(id);
}

/** Absolute path of the workspace that populated the current registry. */
export function getOpenedWorkspaceFilePath(): string | null {
  return registryState.openedWorkspaceFilePath;
}
