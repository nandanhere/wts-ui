import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { GitlabDiscussions } from "../../lib/wtsClient";
import { fakeWorkspaceClient, workspaceFixture, workspaceListFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { assistantMaterialization, deferred } from "./localWorkspaceTestHelpers";

it("shows new MR replies on the Changes tab while the workspace overview stays active", async () => {
  localStorage.clear();
  const workspace = workspaceFixture({ lifecycle: { materializationState: "materialized", worktreeCount: 1, observedAtUnixMs: 1 } });
  const materialization = assistantMaterialization(workspace);
  const repositoryId = materialization.worktrees[0]!.repositoryId;
  const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]), get: workspace, persistedMaterialization: materialization });
  fake.getGitlabMergeRequests.mockResolvedValue({ schemaVersion: 1, state: "fresh", fetchedAtUnixMs: 1, detail: "Ready", mergeRequests: [{ id: "mr-16", repositoryId, iid: 16, projectPath: "team/api", webUrl: "https://gitlab.example.com/team/api/-/merge_requests/16", title: "Feature", sourceBranch: materialization.branchName, targetBranch: "main", authorUsername: "me", updatedAt: "2026-09-17T08:00:00Z", draft: false, status: "open" }] });
  const snapshot: GitlabDiscussions = { schemaVersion: 1, repositoryId, iid: 16, scopeId: "c".repeat(64), viewerLogin: "me", fetchedAtUnixMs: 1, fromCache: false, truncated: false, discussions: [{ id: "discussion-1", resolvable: false, resolved: false, automated: false, comments: [{ id: 1, body: "Please check this.", authorLogin: "reviewer", createdAt: "2026-09-17T08:00:00Z" }] }] };
  const initialRead = deferred<GitlabDiscussions>();
  const nextRead = deferred<GitlabDiscussions>();
  const read = vi.fn().mockReturnValueOnce(initialRead.promise).mockReturnValue(nextRead.promise);
  fake.client.getGitlabDiscussions = read;
  render(<LocalWorkspace client={fake.client} initialView="workbench" initialWorkspaceId={workspace.workspaceId} />);
  await waitFor(() => expect(read).toHaveBeenCalledWith(repositoryId, 16, workspace.workspaceId));
  await act(async () => { initialRead.resolve(snapshot); await initialRead.promise; });
  const changes = screen.getByRole("tab", { name: /Changes.*1 unread merge request comment/i });
  expect(changes).toHaveTextContent("1 unread");
  expect(changes).toHaveAttribute("data-state", "inactive");
  expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute("data-state", "active");
  expect(screen.getByRole("tab", { name: "Plans" })).toBeVisible();
  expect(screen.getByRole("tab", { name: "Verify" })).toBeVisible();
  expect(read).toHaveBeenCalledWith(repositoryId, 16, workspace.workspaceId);
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  await act(async () => {
    nextRead.resolve({ ...snapshot, discussions: [{ ...snapshot.discussions[0]!, comments: [...snapshot.discussions[0]!.comments, { id: 2, body: "Another question.", authorLogin: "reviewer", createdAt: "2026-09-17T08:01:00Z" }] }] });
    await nextRead.promise;
  });
  expect(screen.getByRole("tab", { name: /Changes.*2 unread merge request comments/i })).toHaveAttribute("data-state", "inactive");
});
