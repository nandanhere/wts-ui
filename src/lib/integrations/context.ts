/**
 * Workspace integration context builder.
 *
 * Constructs the authoritative WorkspaceIntegrationContext from server-side
 * sources only: getOpenedWorkspaceFilePath() and getAllRepos().
 *
 * NEVER accepts browser-supplied paths or values.
 */

import type {
  WorkspaceIntegrationContext,
  WorkspaceRepoInfo,
} from "./types";
import type { Repository } from "@/lib/workspace/types";

/**
 * Build the integration context from the workspace registry.
 *
 * @param openedFilePath - Absolute path from getOpenedWorkspaceFilePath() (may be null).
 * @param repos          - All registered repos from getAllRepos().
 * @param workspaceName  - Optional display name override (defaults to file name).
 * @returns A context object, or null if no workspace is open.
 */
export function buildContext(
  openedFilePath: string | null,
  repos: Repository[],
  workspaceName?: string
): WorkspaceIntegrationContext | null {
  if (!openedFilePath) return null;

  const name =
    workspaceName ??
    openedFilePath.split("/").pop()?.replace(/\.code-workspace$/i, "") ??
    "Untitled";

  const repoInfos: WorkspaceRepoInfo[] = repos.map((r) => ({
    id: r.id,
    rootPath: r.rootPath,
    displayName: r.rootPath.split("/").pop() ?? r.id,
  }));

  return {
    workspaceFilePath: openedFilePath,
    workspaceName: name,
    repos: repoInfos,
  };
}
