import { describe, expect, it } from "vitest";
import type { MaterializedWorktree, WorkspaceRepositoryDiff } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { getCachedRepositoryReview, invalidateRepositoryReview, loadRepositoryReview } from "./repositoryReviewCache";

const workspace = "workspace-cache";
const base = "a".repeat(40);
function tree(repositoryId = "api"): MaterializedWorktree {
  return { repositoryId, label: repositoryId, baseCommitOid: base, branchName: "wts/cache", targetDisplayPath: `/tmp/${repositoryId}` };
}
function diff(repositoryId = "api"): WorkspaceRepositoryDiff {
  return { schemaVersion: 1, workspaceId: workspace, repositoryId, repositoryLabel: repositoryId, baseCommitOid: base, headCommitOid: "b".repeat(40), patch: "patch", patchTruncated: false, untrackedPaths: [], untrackedPathsTruncated: false };
}

describe("repository diff memory", () => {
  it("shares an active read and retains its result for a returning view", async () => {
    const fake = fakeWorkspaceClient();
    let resolve!: (value: WorkspaceRepositoryDiff) => void;
    fake.getWorkspaceRepositoryDiff.mockReturnValue(new Promise((accept) => { resolve = accept; }));
    const first = loadRepositoryReview(fake.client, workspace, tree());
    const second = loadRepositoryReview(fake.client, workspace, tree());
    await Promise.resolve();
    expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledExactlyOnceWith(workspace, "api");
    resolve(diff());
    await Promise.all([first, second]);
    expect(getCachedRepositoryReview(fake.client, workspace, tree())).toEqual(diff());
  });

  it.each([
    { workspaceId: "other" },
    { repositoryId: "other" },
    { baseCommitOid: "c".repeat(40) },
  ])("rejects a read for another scope before caching it: %j", async (override) => {
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValue({ ...diff(), ...override });
    await expect(loadRepositoryReview(fake.client, workspace, tree())).rejects.toThrow();
    expect(getCachedRepositoryReview(fake.client, workspace, tree())).toBeUndefined();
  });

  it("keeps 24 recent snapshots and invalidates only the requested repository", async () => {
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(async (_workspace, repositoryId) => diff(repositoryId));
    for (let index = 0; index < 25; index += 1) {
      await loadRepositoryReview(fake.client, workspace, tree(`repo-${index}`));
    }
    expect(getCachedRepositoryReview(fake.client, workspace, tree("repo-0"))).toBeUndefined();
    expect(getCachedRepositoryReview(fake.client, workspace, tree("repo-1"))).toBeDefined();
    invalidateRepositoryReview(fake.client, workspace, "repo-1");
    expect(getCachedRepositoryReview(fake.client, workspace, tree("repo-1"))).toBeUndefined();
    expect(getCachedRepositoryReview(fake.client, workspace, tree("repo-2"))).toBeDefined();
    invalidateRepositoryReview(fake.client, workspace);
    expect(getCachedRepositoryReview(fake.client, workspace, tree("repo-2"))).toBeUndefined();
  });
});
