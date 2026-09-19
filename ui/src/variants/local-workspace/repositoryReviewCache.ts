import {
  WorkspaceClientError,
  type MaterializedWorktree,
  type WorkspaceClient,
  type WorkspaceRepositoryDiff,
} from "../../lib/wtsClient";
import { WorkspaceMemoryCache } from "./workspaceMemoryCache";

const clients = new WeakMap<WorkspaceClient, WorkspaceMemoryCache<WorkspaceRepositoryDiff>>();

function cacheFor(client: WorkspaceClient) {
  let cache = clients.get(client);
  if (!cache) {
    cache = new WorkspaceMemoryCache<WorkspaceRepositoryDiff>(24);
    clients.set(client, cache);
  }
  return cache;
}

function keyFor(workspaceId: string, worktree: MaterializedWorktree): string {
  return JSON.stringify([
    workspaceId,
    worktree.repositoryId,
    worktree.baseCommitOid,
    worktree.branchName,
    worktree.targetDisplayPath,
  ]);
}

export function getCachedRepositoryReview(
  client: WorkspaceClient,
  workspaceId: string,
  worktree: MaterializedWorktree,
): WorkspaceRepositoryDiff | undefined {
  return cacheFor(client).get(keyFor(workspaceId, worktree));
}

export function loadRepositoryReview(
  client: WorkspaceClient,
  workspaceId: string,
  worktree: MaterializedWorktree,
): Promise<WorkspaceRepositoryDiff> {
  return cacheFor(client).load(keyFor(workspaceId, worktree), async () => {
    const result = await client.getWorkspaceRepositoryDiff(workspaceId, worktree.repositoryId);
    if (result.workspaceId !== workspaceId || result.repositoryId !== worktree.repositoryId) {
      throw new WorkspaceClientError("WTS returned changes for a different repository.", { code: "invalid_response" });
    }
    if (result.baseCommitOid !== worktree.baseCommitOid) {
      throw new WorkspaceClientError("The workspace base changed. Refresh workspace status before you open Changes.", { code: "workspace_git_state_changed" });
    }
    return result;
  });
}

export function invalidateRepositoryReview(
  client: WorkspaceClient,
  workspaceId: string,
  repositoryId?: string,
): void {
  const fields = repositoryId === undefined ? [workspaceId] : [workspaceId, repositoryId];
  const prefix = `${JSON.stringify(fields).slice(0, -1)},`;
  clients.get(client)?.deletePrefix(prefix);
}
