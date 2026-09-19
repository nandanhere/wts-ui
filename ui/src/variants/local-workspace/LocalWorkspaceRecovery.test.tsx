import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { WorkspaceClientError, type WorkspaceRemovalPreflight } from "../../lib/wtsClient";
import { fakeWorkspaceClient, workspaceFixture, workspaceListFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { assistantMaterialization } from "./localWorkspaceTestHelpers";

vi.mock("@dnd-kit/core", async (original) => {
  const module = await original<typeof import("@dnd-kit/core")>();
  return { ...module, DndContext: (props: ComponentProps<typeof module.DndContext>) => <>
    <button onClick={() => props.onDragEnd?.({ active: { id: `workspace:${document.querySelector("[data-workspace-id]")?.getAttribute("data-workspace-id")}` }, over: { id: "action:delete" } } as Parameters<NonNullable<typeof props.onDragEnd>>[0])}>Drop workspace on removal</button>
    <module.DndContext {...props} />
  </> };
});

function fixture() {
  const workspace = workspaceFixture({ lifecycle: { materializationState: "materialized", worktreeCount: 1, observedAtUnixMs: 1 } });
  const materialization = assistantMaterialization(workspace);
  materialization.worktrees[0]!.activity = { changedFileCount: 0, commitsAhead: 0 };
  materialization.worktrees[0]!.gitState = { headCommitOid: "a".repeat(40) };
  const removalPreflight: WorkspaceRemovalPreflight = { workspaceId: workspace.workspaceId, workspaceDisplayPath: workspace.workspaceDisplayPath, kind: "materializedWorkspace", ready: false, effectDigest: `sha256:${"a".repeat(64)}`, worktrees: [], generatedPaths: [], protectedPaths: [], retainedBranches: [materialization.branchName], warnings: [], blockers: [{ code: "workspaceDrift", message: "The recorded branch differs." }] };
  const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]), persistedMaterialization: materialization, removalPreflight, reindex: { workspaceId: workspace.workspaceId, status: "ready", graphDisplayPath: `${workspace.workspaceDisplayPath}/graphify-out/graph.json`, detail: "Graph ready.", durationMs: 1 } });
  return { workspace, materialization, removalPreflight, fake };
}

async function openWorkspace(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
  await screen.findByRole("button", { name: "Workspace actions" });
}
async function openRemoval(user: ReturnType<typeof userEvent.setup>) {
  await openWorkspace(user);
  await user.click(screen.getByRole("button", { name: "Workspace actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove workspace…" }));
  return screen.findByRole("dialog", { name: /Remove PLATFORM-42 from this Mac/i });
}

describe("Recovery actions through the workspace shell", () => {
  it.each([["Open workspace", "Workspace"], ["Open Verify", "Verify"]])("opens %s from active-work removal without deleting files", async (button, tab) => {
    const user = userEvent.setup();
    const { removalPreflight, fake } = fixture();
    fake.preflightWorkspaceRemoval.mockResolvedValue({ ...removalPreflight, blockers: [{ code: "activeOperation", message: "Work is active in this workspace." }] });
    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i });
    await user.click(screen.getByRole("button", { name: "Drop workspace on removal" }));
    const dialog = await screen.findByRole("dialog", { name: /Remove PLATFORM-42 from this Mac/i });
    expect(within(dialog).getByRole("button", { name: "Remove workspace" })).toBeDisabled();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: button }));
    expect(await screen.findByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog", { name: /Remove PLATFORM-42/ })).not.toBeInTheDocument();
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
  });

  it("keeps a failed registration reason inside the removal dialog and permits another check", async () => {
    const user = userEvent.setup();
    const { fake } = fixture();
    fake.reindexWorkspaceGraph.mockRejectedValue(new Error("Git cannot read this repository."));
    render(<LocalWorkspace client={fake.client} />);
    const dialog = await openRemoval(user);
    await user.click(within(dialog).getByRole("button", { name: "Register changes & re-index" }));
    expect(await within(dialog).findByText("Git cannot read this repository.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Register changes & re-index" })).toBeEnabled();
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
  });

  it("opens Plans from blocked board removal before the workspace was loaded", async () => {
    const user = userEvent.setup();
    const { removalPreflight, fake } = fixture();
    fake.preflightWorkspaceRemoval.mockResolvedValue({ ...removalPreflight, blockers: [{ code: "planningDocumentsPresent", message: "Plans need review." }] });
    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i });
    expect(fake.getWorkspaceMaterialization).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Drop workspace on removal" }));
    const dialog = await screen.findByRole("dialog", { name: /Remove PLATFORM-42 from this Mac/i });
    await user.click(within(dialog).getByRole("button", { name: "Open Plans" }));
    expect(await screen.findByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("dialog", { name: /Remove PLATFORM-42/ })).not.toBeInTheDocument();
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
  });

  it("keeps drift recovery visible when the last materialization remains cached", async () => {
    const user = userEvent.setup();
    const { workspace, fake } = fixture();
    render(<LocalWorkspace client={fake.client} />);
    await openWorkspace(user);
    await screen.findByRole("region", { name: "Workspace facts" });
    fake.getWorkspaceMaterialization.mockRejectedValueOnce(new WorkspaceClientError("The repository branch changed after the last check.", { code: "workspace_git_state_changed", retryable: false }));
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Refresh status" }));
    const recovery = await screen.findByRole("region", { name: "Workspace recovery" });
    expect(within(recovery).getByText("The repository branch changed after the last check.")).toBeVisible();
    expect(screen.getByRole("region", { name: "Workspace facts" })).toBeVisible();
    await user.click(within(recovery).getByRole("button", { name: "Register changes & re-index" }));
    await waitFor(() => expect(fake.reindexWorkspaceGraph).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Workspace recovery" })).not.toBeInTheDocument());
  });

  it("registers Git changes, checks removal again, and requires a fresh deletion confirmation", async () => {
    const user = userEvent.setup();
    const { workspace, removalPreflight, fake } = fixture();
    fake.preflightWorkspaceRemoval.mockResolvedValueOnce(removalPreflight).mockResolvedValue({ ...removalPreflight, ready: true, effectDigest: `sha256:${"b".repeat(64)}`, blockers: [] });
    render(<LocalWorkspace client={fake.client} />);
    const dialog = await openRemoval(user);
    await user.click(within(dialog).getByRole("button", { name: "Register changes & re-index" }));
    await waitFor(() => expect(fake.preflightWorkspaceRemoval).toHaveBeenCalledTimes(2));
    expect(fake.reindexWorkspaceGraph).toHaveBeenCalledExactlyOnceWith(workspace.workspaceId);
    expect(await within(dialog).findByRole("checkbox", { name: /Remove these local worktrees/ })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Remove workspace" })).toBeDisabled();
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
  });

  it("opens integration setup from a Git blocker and leaves the workspace intact", async () => {
    const user = userEvent.setup();
    const { removalPreflight, fake } = fixture();
    fake.preflightWorkspaceRemoval.mockResolvedValue({ ...removalPreflight, blockers: [{ code: "gitUnavailable", message: "Git is unavailable." }] });
    render(<LocalWorkspace client={fake.client} />);
    const dialog = await openRemoval(user);
    await user.click(within(dialog).getByRole("button", { name: "Open integrations" }));
    expect(await screen.findByRole("dialog", { name: "Environment & integrations" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /Remove PLATFORM-42/ })).not.toBeInTheDocument();
    expect(fake.removeWorkspace).not.toHaveBeenCalled();
  });

  it("retries a failed alignment check for the same repository without repeating sync", async () => {
    const user = userEvent.setup();
    const { workspace, materialization, fake } = fixture();
    const repository = materialization.worktrees[0]!;
    fake.syncWorkspaceRepository.mockRejectedValue(new WorkspaceClientError("Review upstream history.", { code: "repository_sync_diverged", retryable: false }));
    fake.preflightWorkspaceRepositoryAlignment.mockRejectedValueOnce(new Error("The upstream check failed.")).mockResolvedValue({ workspaceId: workspace.workspaceId, repositoryId: repository.repositoryId, repositoryLabel: repository.label, baseRef: "main", remoteFullRef: "refs/remotes/origin/main", currentCommitOid: "a".repeat(40), targetCommitOid: "b".repeat(40), backupFullRef: `refs/wts/backups/${"a".repeat(40)}`, effectDigest: `sha256:${"c".repeat(64)}` });
    render(<LocalWorkspace client={fake.client} />);
    await openWorkspace(user);
    await user.click(await screen.findByRole("button", { name: /^Sync .* with upstream/ }));
    const dialog = await screen.findByRole("dialog", { name: "Review repository alignment" });
    await within(dialog).findByText("The upstream check failed.");
    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(fake.preflightWorkspaceRepositoryAlignment).toHaveBeenCalledTimes(2));
    expect(fake.preflightWorkspaceRepositoryAlignment).toHaveBeenLastCalledWith(workspace.workspaceId, repository.repositoryId);
    expect(fake.syncWorkspaceRepository).toHaveBeenCalledOnce();
    expect(fake.alignWorkspaceRepository).not.toHaveBeenCalled();
    expect(await within(dialog).findByRole("checkbox")).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Align and rebuild graph" })).toBeDisabled();
  });
});
