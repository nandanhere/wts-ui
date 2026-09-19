import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { WorkspaceRepositoryDiff } from "../../lib/wtsClient";
import { fakeWorkspaceClient, workspaceFixture, workspaceListFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { assistantMaterialization, deferred } from "./localWorkspaceTestHelpers";

describe("agent feedback navigation", () => {
  it("returns an isolated task to the exact parent selection", async () => {
    window.history.replaceState({}, "", "/");
    const workspace = workspaceFixture();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]), get: workspace, persistedMaterialization: assistantMaterialization(workspace) });
    const parent = { conversationId: "origin", source: { kind: "ui", route: `/sessions/${workspace.workspaceId}/planning`, calloutId: "workspace.tab-content", label: "Workspace content" }, messages: [{ role: "user", requestId: "request" }, { role: "assistant", requestId: "request" }] };
    const getAgentConversation = vi.fn().mockResolvedValue(parent);
    render(<LocalWorkspace client={{ ...fake.client, getAgentConversation }} />);
    await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalled());
    act(() => window.dispatchEvent(new CustomEvent("wts:return-feedback-selection", { detail: { requestId: "return-child", source: { kind: "workItem", workSetId: "set", taskId: "task", label: "Option A", originConversationId: "origin", originRequestId: "request" } } })));
    expect(await screen.findByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
    expect(getAgentConversation).toHaveBeenCalledExactlyOnceWith("origin");
    expect(location.pathname).toBe(`/sessions/${workspace.workspaceId}/planning`);
  });

  it("keeps newer navigation when an isolated task origin arrives late", async () => {
    window.history.replaceState({}, "", "/");
    const workspace = workspaceFixture();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]), get: workspace });
    const parent = { conversationId: "origin", source: { kind: "ui", route: `/sessions/${workspace.workspaceId}/planning`, calloutId: "workspace.tab-content", label: "Workspace content" }, messages: [{ role: "user", requestId: "request" }, { role: "assistant", requestId: "request" }] };
    const pending = deferred<typeof parent>();
    const getAgentConversation = vi.fn().mockReturnValue(pending.promise);
    render(<LocalWorkspace client={{ ...fake.client, getAgentConversation }} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "New workspace" })).toBeEnabled());
    act(() => window.dispatchEvent(new CustomEvent("wts:return-feedback-selection", { detail: { requestId: "return-child", source: { kind: "workItem", workSetId: "set", taskId: "task", label: "Option A", originConversationId: "origin", originRequestId: "request" } } })));
    await waitFor(() => expect(getAgentConversation).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "My reviews" }));
    await act(async () => { pending.resolve(parent); await pending.promise; });
    expect(location.pathname).toBe("/reviews");
    expect(screen.queryByRole("tab", { name: "Plans" })).not.toBeInTheDocument();
  });

  it("returns to the original UI page without opening the agent source workspace", async () => {
    window.history.replaceState({}, "", "/");
    const workspace = workspaceFixture();
    const materialization = assistantMaterialization(workspace);
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([workspace]), get: workspace, persistedMaterialization: materialization });
    render(<LocalWorkspace client={fake.client} />);
    await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalled());
    act(() => window.dispatchEvent(new CustomEvent("wts:return-feedback-selection", { detail: {
      requestId: "return-original",
      source: { kind: "ui", route: `/sessions/${workspace.workspaceId}/planning`, calloutId: "workspace.tab-content", label: "Workspace content" },
    } })));
    expect(await screen.findByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
    expect(location.pathname).toBe(`/sessions/${workspace.workspaceId}/planning`);
  });

  it("rejects an external saved UI location without changing the current page", async () => {
    window.history.replaceState({}, "", "/");
    const fake = fakeWorkspaceClient();
    render(<LocalWorkspace client={fake.client} />);
    await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalled());
    act(() => window.dispatchEvent(new CustomEvent("wts:return-feedback-selection", { detail: {
      requestId: "return-external",
      source: { kind: "ui", route: "https://example.invalid/", calloutId: "workspace.tab-content", label: "Workspace content" },
    } })));
    expect(await screen.findByText("The saved selection does not have a supported WTS page. Its context remains in Agent feedback.")).toBeVisible();
    expect(location.pathname).toBe("/");
    expect(fake.getWorkspace).not.toHaveBeenCalled();
  });

  it("keeps newer navigation when a saved selection needs a delayed workspace lookup", async () => {
    window.history.replaceState({}, "", "/");
    const workspace = workspaceFixture();
    const pending = deferred<typeof workspace>();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([]) });
    fake.getWorkspace.mockReturnValue(pending.promise);
    render(<LocalWorkspace client={fake.client} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "New workspace" })).toBeEnabled());
    act(() => window.dispatchEvent(new CustomEvent("wts:return-feedback-selection", { detail: {
      requestId: "return-delayed",
      source: { kind: "ui", route: `/sessions/${workspace.workspaceId}/planning`, calloutId: "workspace.tab-content", label: "Workspace content" },
    } })));
    await waitFor(() => expect(fake.getWorkspace).toHaveBeenCalledWith(workspace.workspaceId));
    fireEvent.click(screen.getByRole("button", { name: "My reviews" }));
    expect(location.pathname).toBe("/reviews");
    await act(async () => { pending.resolve(workspace); await pending.promise; });
    expect(location.pathname).toBe("/reviews");
    expect(screen.queryByRole("tab", { name: "Plans" })).not.toBeInTheDocument();
  });

  it("opens a newly created agent workspace in Changes without reloading the app", async () => {
    const workspace = workspaceFixture();
    const materialization = assistantMaterialization(workspace);
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([]), get: workspace, persistedMaterialization: materialization });
    render(<LocalWorkspace client={fake.client} />);
    await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalled());
    act(() => window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId: workspace.workspaceId, repositoryId: materialization.worktrees[0].repositoryId } })));
    expect(await screen.findByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
    expect(location.pathname).toBe(`/sessions/${workspace.workspaceId}/changes`);
    expect(new URLSearchParams(location.search).get("repository")).toBe(materialization.worktrees[0].repositoryId);
    expect(fake.getWorkspace).toHaveBeenCalledWith(workspace.workspaceId);
  });
  it("rejects a workspace response for another conversation target", async () => {
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([]), get: workspaceFixture() });
    render(<LocalWorkspace client={fake.client} />);
    await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalled());
    act(() => window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId: "different", repositoryId: "repo" } })));
    await waitFor(() => expect(fake.getWorkspace).toHaveBeenCalledWith("different"));
    expect(await screen.findByText("WTS could not open the agent workspace. Select View local changes to try again.")).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();
  });
  it("keeps the user's newer navigation when a workspace lookup finishes late", async () => {
    const workspace = workspaceFixture();
    const pending = deferred<typeof workspace>();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture([]) });
    fake.getWorkspace.mockReturnValue(pending.promise);
    render(<LocalWorkspace client={fake.client} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "New workspace" })).toBeEnabled());
    act(() => window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId: workspace.workspaceId, repositoryId: "repo" } })));
    await waitFor(() => expect(fake.getWorkspace).toHaveBeenCalledWith(workspace.workspaceId));
    fireEvent.click(screen.getByRole("button", { name: "My reviews" }));
    expect(location.pathname).toBe("/reviews");
    await act(async () => { pending.resolve(workspace); await pending.promise; });
    expect(location.pathname).toBe("/reviews");
    expect(screen.queryByRole("tab", { name: "Changes" })).not.toBeInTheDocument();
  });
  it("opens the existing setup flow from agent recovery", async () => {
    const fake = fakeWorkspaceClient();
    render(<LocalWorkspace client={fake.client} />);
    await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalled());
    act(() => window.dispatchEvent(new CustomEvent("wts:open-agent-settings")));
    expect(await screen.findByRole("dialog", { name: "Environment & integrations" })).toBeVisible();
  });
});

it("keeps a newer workspace tab when an agent workspace lookup finishes late", async () => {
  const user = userEvent.setup();
  const workspace = workspaceFixture();
  const agentWorkspace = workspaceFixture({ workspaceId: "agent-workspace" });
  const pending = deferred<typeof workspace>();
  const materialization = assistantMaterialization(workspace);
  const fake = fakeWorkspaceClient({
    list: workspaceListFixture([workspace]),
    get: workspace,
    persistedMaterialization: materialization,
  });
  fake.getWorkspace.mockImplementation((id) => id === agentWorkspace.workspaceId
    ? pending.promise
    : Promise.resolve(workspace));
  render(<LocalWorkspace client={fake.client} initialView="workbench" initialWorkspaceId={workspace.workspaceId} />);
  await waitFor(() => expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true"));
  act(() => window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", {
    detail: { workspaceId: agentWorkspace.workspaceId, repositoryId: materialization.worktrees[0].repositoryId },
  })));
  await waitFor(() => expect(fake.getWorkspace).toHaveBeenCalledWith(agentWorkspace.workspaceId));
  await user.click(screen.getByRole("tab", { name: "Plans" }));
  const chosenPath = `/sessions/${workspace.workspaceId}/planning`;
  expect(location.pathname).toBe(chosenPath);
  await act(async () => { pending.resolve(agentWorkspace); await pending.promise; });
  expect(location.pathname).toBe(chosenPath);
  expect(screen.getByRole("tab", { name: "Plans" })).toHaveAttribute("aria-selected", "true");
});

function reviewNavigationFixture() {
  window.history.replaceState({}, "", "/");
  const workspace = workspaceFixture();
  const agentWorkspace = workspaceFixture({ workspaceId: "agent-workspace" });
  const pending = deferred<typeof workspace>();
  const materialization = assistantMaterialization(workspace);
  materialization.worktrees.push({
    ...materialization.worktrees[0],
    repositoryId: "repo_sdk",
    label: "payments-sdk",
    targetDisplayPath: `${workspace.workspaceDisplayPath}/payments-sdk`,
  });
  const fake = fakeWorkspaceClient({
    list: workspaceListFixture([workspace]),
    get: workspace,
    persistedMaterialization: materialization,
  });
  fake.getWorkspace.mockImplementation((id) => id === agentWorkspace.workspaceId
    ? pending.promise
    : Promise.resolve(workspace));
  const diff = (repositoryId: string, changed = false): WorkspaceRepositoryDiff => ({
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    repositoryId,
    repositoryLabel: repositoryId,
    baseCommitOid: materialization.worktrees[0].baseCommitOid,
    headCommitOid: "b".repeat(40),
    patchSha256: "a".repeat(64),
    patch: "",
    patchTruncated: false,
    untrackedPaths: changed ? ["local-note.txt"] : [],
    untrackedPathsTruncated: false,
  });
  fake.getWorkspaceRepositoryDiff.mockImplementation(async (_workspaceId, repositoryId) => diff(repositoryId, true));
  const openAgentWorkspace = async () => {
    act(() => window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", {
      detail: { workspaceId: agentWorkspace.workspaceId, repositoryId: "repo_sdk" },
    })));
    await waitFor(() => expect(fake.getWorkspace).toHaveBeenCalledWith(agentWorkspace.workspaceId));
  };
  const finishAgentLookup = async () => {
    await act(async () => { pending.resolve(agentWorkspace); await pending.promise; });
  };
  const renderChanges = () => render(<LocalWorkspace client={fake.client}
    initialView="workbench" initialWorkspaceId={workspace.workspaceId} initialWorkbenchTab="changes" />);
  return { workspace, agentWorkspace, fake, diff, renderChanges, openAgentWorkspace, finishAgentLookup };
}

it.each(["repository", "verification"] as const)(
  "keeps the newer %s choice in Changes when an agent workspace lookup finishes late",
  async (choice) => {
    const fixture = reviewNavigationFixture();
    fixture.renderChanges();
    await screen.findByRole("combobox", { name: "Repository to review" });
    await waitFor(() => expect(fixture.fake.getWorkspaceEvidence).toHaveBeenCalled());
    await screen.findByRole("button", { name: "Verification" });
    await fixture.openAgentWorkspace();
    if (choice === "repository") {
      fireEvent.change(screen.getByRole("combobox", { name: "Repository to review" }), {
        target: { value: "repo_sdk" },
      });
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Verification" }));
    }
    const chosenPath = `/sessions/${fixture.workspace.workspaceId}/${choice === "repository" ? "changes" : "verification"}`;
    expect(location.pathname).toBe(chosenPath);
    if (choice === "repository") expect(new URLSearchParams(location.search).get("repository")).toBe("repo_sdk");
    await fixture.finishAgentLookup();
    expect(location.pathname).toBe(chosenPath);
    if (choice === "repository") {
      expect(screen.getByRole("combobox", { name: "Repository to review" })).toHaveValue("repo_sdk");
      expect(new URLSearchParams(location.search).get("repository")).toBe("repo_sdk");
    } else {
      expect(screen.getByRole("tab", { name: "Verify" })).toHaveAttribute("aria-selected", "true");
    }
  },
);

it("keeps an explicit agent workspace request when an automatic diff probe selects a repository", async () => {
  const fixture = reviewNavigationFixture();
  const probe = deferred<WorkspaceRepositoryDiff>();
  fixture.fake.getWorkspaceRepositoryDiff.mockImplementation(async (_workspaceId, repositoryId) =>
    repositoryId === "repo_sdk" ? probe.promise : fixture.diff(repositoryId));
  fixture.renderChanges();
  await waitFor(() => expect(fixture.fake.getWorkspaceRepositoryDiff).toHaveBeenCalledWith(fixture.workspace.workspaceId, "repo_sdk"));
  await fixture.openAgentWorkspace();
  await act(async () => { probe.resolve(fixture.diff("repo_sdk", true)); await probe.promise; });
  await waitFor(() => expect(new URLSearchParams(location.search).get("repository")).toBe("repo_sdk"));
  expect(location.pathname).toBe(`/sessions/${fixture.workspace.workspaceId}/changes`);
  await fixture.finishAgentLookup();
  expect(location.pathname).toBe(`/sessions/${fixture.agentWorkspace.workspaceId}/changes`);
  expect(new URLSearchParams(location.search).get("repository")).toBe("repo_sdk");
});

it("keeps an agent workspace lookup when a pending registry read replaces the workspace list", async () => {
  window.history.replaceState({}, "", "/");
  const workspace = workspaceFixture();
  const agentWorkspace = workspaceFixture({ workspaceId: "agent-workspace" });
  const registry = deferred<ReturnType<typeof workspaceListFixture>>();
  const pending = deferred<typeof workspace>();
  const fake = fakeWorkspaceClient();
  fake.listWorkspaces.mockReturnValue(registry.promise);
  fake.getWorkspace.mockReturnValue(pending.promise);
  render(<LocalWorkspace client={fake.client} />);
  await waitFor(() => expect(fake.listWorkspaces).toHaveBeenCalled());
  act(() => window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", {
    detail: { workspaceId: agentWorkspace.workspaceId, repositoryId: "repo_sdk" },
  })));
  await waitFor(() => expect(fake.getWorkspace).toHaveBeenCalledWith(agentWorkspace.workspaceId));
  await act(async () => { registry.resolve(workspaceListFixture([workspace])); await registry.promise; });
  await act(async () => { pending.resolve(agentWorkspace); await pending.promise; });
  expect(location.pathname).toBe(`/sessions/${agentWorkspace.workspaceId}/changes`);
  expect(new URLSearchParams(location.search).get("repository")).toBe("repo_sdk");
});
