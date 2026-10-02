import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { WorkspaceClientError, type WorkspaceMaterialization, type WorkspaceView } from "../../lib/wtsClient";
import { fakeWorkspaceClient, workspaceFixture, workspaceListFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { assistantMaterialization, deferred, selectWorkspaceView } from "./localWorkspaceTestHelpers";

describe("workspace return state", () => {
  it("keeps a pending rename scoped to its workspace after navigation", async () => {
    const user = userEvent.setup();
    const first = workspaceFixture();
    const second = workspaceFixture({ workspaceId: "ws_rename_second", title: "Second workspace", intent: { type: "jira", issueKey: "PLATFORM-99" } });
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([first, second]) });
    const pending = deferred<WorkspaceView>();
    fake.renameWorkspace.mockReturnValueOnce(pending.promise);
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await user.dblClick(screen.getByRole("button", { name: first.title }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "Renamed first workspace" } });
    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    expect(fake.renameWorkspace).toHaveBeenCalledExactlyOnceWith(first.workspaceId, "Renamed first workspace");
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-99.* details$/i }));
    expect(screen.queryByRole("textbox", { name: "Workspace name" })).not.toBeInTheDocument();
    await user.dblClick(screen.getByRole("button", { name: second.title }));
    fireEvent.change(screen.getByRole("textbox", { name: "Workspace name" }), { target: { value: "Unfinished second name" } });
    await act(async () => { pending.resolve({ ...first, title: "Renamed first workspace" }); });
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue("Unfinished second name");
    expect(fake.renameWorkspace).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected workspace when an earlier board change causes a registry refresh", async () => {
    const user = userEvent.setup();
    const first = workspaceFixture();
    const second = workspaceFixture({ workspaceId: "ws_keep_selected", title: "Stay on this workspace", intent: { type: "jira", issueKey: "PLATFORM-99" } });
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([first, second]) });
    let rejectPlacement!: (error: Error) => void;
    fake.placeWorkspaceOnBoard.mockReturnValue(new Promise((_resolve, reject) => { rejectPlacement = reject; }));
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: "Move PLATFORM-42" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move to Parked" }));
    await user.click(screen.getByRole("button", { name: /^Open PLATFORM-99.* details$/i }));
    await act(async () => { rejectPlacement(new WorkspaceClientError("The saved placement changed.", { code: "workspace_workflow_conflict" })); });
    await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: second.title })).toBeVisible();
    expect(globalThis.location.pathname).toBe(`/sessions/${second.workspaceId}`);
  });

  it("opens a created workspace without intermediate setup claims or read-success toasts", async () => {
    const user = userEvent.setup();
    const workspace = workspaceFixture();
    const pending = deferred<WorkspaceMaterialization | null>();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]) });
    fake.getWorkspaceMaterialization.mockReturnValue(pending.promise);
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    expect(screen.queryByText(/workspace setup has not run/)).not.toBeInTheDocument();
    expect(screen.queryByText(/plan loaded from the local registry/)).not.toBeInTheDocument();
    expect(screen.queryByText("Opening the local workspace registry…")).not.toBeInTheDocument();
    await act(async () => { pending.resolve(assistantMaterialization(workspace)); });
    expect(await screen.findByLabelText("Workspace facts")).toBeVisible();
    expect(screen.queryByText(/workspace setup has not run/)).not.toBeInTheDocument();
  });

  it("restores each workspace tab's scroll position without copying another workspace", async () => {
    const user = userEvent.setup();
    const first = workspaceFixture();
    const second = workspaceFixture({ workspaceId: "ws_scroll_second", title: "Second workspace", intent: { type: "jira", issueKey: "PLATFORM-99" } });
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([first, second]) });
    const view = render(<LocalWorkspace client={fake.client} />);
    const viewport = () => view.container.querySelector<HTMLElement>('[data-ui="workspace.tab-content"]')!;
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    viewport().scrollTop = 420;
    fireEvent.scroll(viewport());
    await selectWorkspaceView(user, "Plans & Kanban");
    expect(viewport().scrollTop).toBe(0);
    viewport().scrollTop = 180;
    fireEvent.scroll(viewport());
    await user.click(screen.getByRole("tab", { name: "Workspace" }));
    expect(viewport().scrollTop).toBe(420);
    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-99.* details$/i }));
    expect(viewport().scrollTop).toBe(0);
    viewport().scrollTop = 90;
    fireEvent.scroll(viewport());
    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    expect(viewport().scrollTop).toBe(420);
    await selectWorkspaceView(user, "Plans & Kanban");
    expect(viewport().scrollTop).toBe(180);
  });

  it("reuses an active status request after leaving and returning", async () => {
    const user = userEvent.setup();
    const workspace = workspaceFixture();
    const pending = deferred<WorkspaceMaterialization | null>();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]) });
    fake.getWorkspaceMaterialization.mockReturnValue(pending.promise);
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await waitFor(() => expect(fake.getWorkspaceMaterialization).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    expect(fake.getWorkspaceMaterialization).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(assistantMaterialization(workspace)); });
    expect(await screen.findByLabelText("Workspace facts")).toBeVisible();
  });

  it("restores each workspace tab when it is opened from Spaces", async () => {
    const user = userEvent.setup();
    const workspace = workspaceFixture();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]) });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await selectWorkspaceView(user, "Plans & Kanban");
    await act(async () => { await import("./PlanningDocumentsPanel"); });
    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    expect(screen.getByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
  });

  it("caches a late response without replacing another workspace's content", async () => {
    const user = userEvent.setup();
    const first = workspaceFixture();
    const second = workspaceFixture({ workspaceId: "ws_second", title: "Second workspace", intent: { type: "jira", issueKey: "PLATFORM-99" } });
    const firstMaterialization = assistantMaterialization(first);
    const secondMaterialization = assistantMaterialization(second);
    const pending = deferred<WorkspaceMaterialization | null>();
    const refresh = deferred<WorkspaceMaterialization | null>();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([first, second]) });
    let firstReads = 0;
    fake.getWorkspaceMaterialization.mockImplementation((workspaceId) => {
      if (workspaceId === second.workspaceId) return Promise.resolve(secondMaterialization);
      return ++firstReads === 1 ? pending.promise : refresh.promise;
    });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-99.* details$/i }));
    expect(await screen.findByLabelText("Workspace facts")).toHaveTextContent(secondMaterialization.branchName);
    await act(async () => { pending.resolve(firstMaterialization); });
    expect(screen.getByLabelText("Workspace facts")).toHaveTextContent(secondMaterialization.branchName);
    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
    expect(screen.getByLabelText("Workspace facts")).toHaveTextContent(firstMaterialization.branchName);
    await act(async () => { refresh.resolve(firstMaterialization); });
  });
});
