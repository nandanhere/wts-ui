import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MaterializedWorktree, WorkspaceMaterialization, WorkspaceRepositoryDiff } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { RepositoryReviewScreen } from "./RepositoryReviewScreen";

vi.mock("./RepositoryPatchViewer", () => ({
  RepositoryPatchViewer: ({ patch }: { patch: string }) => <pre aria-label="Local patch">{patch}</pre>,
  summarizeRepositoryPatch: () => ({ files: [] }),
}));

const base = "a".repeat(40);
const head = "b".repeat(40);
const workspaceId = "workspace-cache";
function worktree(repositoryId = "api", baseCommitOid = base): MaterializedWorktree {
  return { repositoryId, label: repositoryId, baseCommitOid, branchName: "wts/cache", targetDisplayPath: `/tmp/cache/${repositoryId}` };
}
function materialization(trees = [worktree()], id = workspaceId): WorkspaceMaterialization {
  return { schemaVersion: 1, workspaceId: id, workspaceRecordVersion: 1, effectDigest: "sha256:cache", workspaceDisplayPath: "/tmp/cache", codeWorkspaceDisplayPath: "/tmp/cache/workspace.code-workspace", branchName: "wts/cache", worktrees: trees, graph: { status: "notStarted", detail: "Not indexed" } };
}
function diff(repositoryId = "api", patch = "cached local patch", id = workspaceId): WorkspaceRepositoryDiff {
  return { schemaVersion: 1, workspaceId: id, repositoryId, repositoryLabel: repositoryId, baseCommitOid: base, headCommitOid: head, patch, patchTruncated: false, untrackedPaths: [], untrackedPathsTruncated: false };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

describe("ordinary workspace Changes cache", () => {
  it("shows the last local patch immediately after remount while a refresh is pending", async () => {
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValueOnce(diff());
    const props = { client: fake.client, workspaceId, initialRepositoryId: "api", materialization: materialization(), onRepositoryChange: vi.fn() };
    const first = render(<RepositoryReviewScreen {...props} />);
    expect(await screen.findByLabelText("Local patch")).toHaveTextContent("cached local patch");
    first.unmount();
    const refresh = deferred<WorkspaceRepositoryDiff>();
    fake.getWorkspaceRepositoryDiff.mockReturnValueOnce(refresh.promise);
    render(<RepositoryReviewScreen {...props} />);
    expect(screen.getByLabelText("Local patch")).toHaveTextContent("cached local patch");
    await waitFor(() => expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledTimes(2));
    await act(async () => { refresh.resolve(diff("api", "fresh local patch")); });
    expect(screen.getByLabelText("Local patch")).toHaveTextContent("fresh local patch");
  });

  it("retains the patch after a failed refresh and retries without clearing it", async () => {
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValueOnce(diff());
    const props = { client: fake.client, workspaceId, initialRepositoryId: "api", materialization: materialization(), onRepositoryChange: vi.fn() };
    const first = render(<RepositoryReviewScreen {...props} />);
    await screen.findByLabelText("Local patch");
    first.unmount();
    fake.getWorkspaceRepositoryDiff.mockRejectedValueOnce(new Error("Git is busy"));
    render(<RepositoryReviewScreen {...props} />);
    await screen.findByText(/Git is busy/);
    expect(screen.getByLabelText("Local patch")).toHaveTextContent("cached local patch");
    const retry = deferred<WorkspaceRepositoryDiff>();
    fake.getWorkspaceRepositoryDiff.mockReturnValueOnce(retry.promise);
    fireEvent.click(screen.getByRole("button", { name: "Retry changes" }));
    expect(screen.getByLabelText("Local patch")).toHaveTextContent("cached local patch");
    await act(async () => { retry.resolve(diff("api", "recovered local patch")); });
    expect(screen.getByLabelText("Local patch")).toHaveTextContent("recovered local patch");
  });

  it.each(["client", "workspace", "repository", "base"])("does not show a patch cached under another %s", async (scope) => {
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValueOnce(diff());
    const props = { client: fake.client, workspaceId, initialRepositoryId: "api", materialization: materialization(), onRepositoryChange: vi.fn() };
    const first = render(<RepositoryReviewScreen {...props} />);
    await screen.findByLabelText("Local patch");
    first.unmount();
    const nextFake = scope === "client" ? fakeWorkspaceClient() : fake;
    nextFake.getWorkspaceRepositoryDiff.mockReturnValue(new Promise(() => {}));
    const nextWorkspaceId = scope === "workspace" ? "other-workspace" : workspaceId;
    const repositoryId = scope === "repository" ? "other-repository" : "api";
    const tree = worktree(repositoryId, scope === "base" ? "c".repeat(40) : base);
    render(<RepositoryReviewScreen {...props} client={nextFake.client} workspaceId={nextWorkspaceId} initialRepositoryId={repositoryId} materialization={materialization([tree], nextWorkspaceId)} />);
    expect(screen.queryByLabelText("Local patch")).not.toBeInTheDocument();
  });

  it.each(["client", "base"])("discards the displayed patch when its %s changes in place", async (scope) => {
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValueOnce(diff());
    const props = { client: fake.client, workspaceId, initialRepositoryId: "api", materialization: materialization(), onRepositoryChange: vi.fn() };
    const view = render(<RepositoryReviewScreen {...props} />);
    await screen.findByLabelText("Local patch");
    const nextFake = scope === "client" ? fakeWorkspaceClient() : fake;
    nextFake.getWorkspaceRepositoryDiff.mockReturnValue(new Promise(() => {}));
    view.rerender(<RepositoryReviewScreen {...props} client={nextFake.client} materialization={materialization([worktree("api", scope === "base" ? "c".repeat(40) : base)])} />);
    expect(screen.queryByLabelText("Local patch")).not.toBeInTheDocument();
    await waitFor(() => expect(nextFake.getWorkspaceRepositoryDiff).toHaveBeenCalledTimes(scope === "client" ? 1 : 2));
  });

  it("caches late reads without replacing the newly selected repository", async () => {
    const fake = fakeWorkspaceClient();
    const late = deferred<WorkspaceRepositoryDiff>();
    fake.getWorkspaceRepositoryDiff.mockImplementation((_workspace, repository) => repository === "api" ? late.promise : Promise.resolve(diff("worker", "worker patch")));
    const props = { client: fake.client, workspaceId, initialRepositoryId: "api", materialization: materialization([worktree(), worktree("worker")]), onRepositoryChange: vi.fn() };
    const view = render(<RepositoryReviewScreen {...props} />);
    await waitFor(() => expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledWith(workspaceId, "api"));
    view.rerender(<RepositoryReviewScreen {...props} initialRepositoryId="worker" />);
    expect(await screen.findByLabelText("Local patch")).toHaveTextContent("worker patch");
    await act(async () => { late.resolve(diff()); });
    expect(screen.getByLabelText("Local patch")).toHaveTextContent("worker patch");
    fake.getWorkspaceRepositoryDiff.mockReturnValue(new Promise(() => {}));
    view.rerender(<RepositoryReviewScreen {...props} />);
    expect(screen.getByLabelText("Local patch")).toHaveTextContent("cached local patch");
  });
});
