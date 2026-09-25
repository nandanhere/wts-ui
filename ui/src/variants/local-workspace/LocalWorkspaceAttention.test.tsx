import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeWorkspaceClient, workspaceFixture, workspaceListFixture, workspaceEvidenceFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { assistantMaterialization } from "./localWorkspaceTestHelpers";
import type { WorkspaceAttentionItem, WorkspaceAttentionSnapshot } from "./workspaceAttention";
import { AGENT_FEEDBACK_RESULT_REQUESTED_EVENT } from "../../lib/agentFeedbackEvents";

const harness = vi.hoisted(() => ({
  snapshot: { items: [], history: [], sources: {}, inboxes: {}, refreshing: false } as WorkspaceAttentionSnapshot,
  refresh: vi.fn().mockResolvedValue(undefined), acknowledge: vi.fn(), listeners: new Set<() => void>(),
}));
const store = vi.hoisted(() => ({
  getSnapshot: () => harness.snapshot,
  subscribe: (listener: () => void) => { harness.listeners.add(listener); return () => { harness.listeners.delete(listener); }; },
  refresh: harness.refresh, acknowledge: harness.acknowledge,
}));
vi.mock("./workspaceAttention", () => ({ getWorkspaceAttentionStore: () => store, observeWorkspaceVerificationSummary: vi.fn() }));
const workspaces = Array.from({ length: 5 }, (_, index) => workspaceFixture({ workspaceId: `space-${index}`, title: `Project ${index}`,
  intent: { type: "repositorySet", label: `Project ${index}` },
  lifecycle: { materializationState: "materialized", worktreeCount: 1, observedAtUnixMs: 1 },
}));
function result(index: number): WorkspaceAttentionItem {
  return { id: `item-${index}`, revision: `revision-${index}`, workspaceId: `space-${index}`, kind: "agent", label: `Review result ${index}`,
    detail: `Saved task ${index}`, occurredAt: 1, count: 1,
    target: { kind: "agent", conversationId: `conversation-${index}`, requestId: `request-${index}`, messageId: `message-${index}`, repositoryId: "repo_checkout" } };
}
function setup() {
  const evidence = workspaceEvidenceFixture();
  evidence.context.workspaceId = workspaces[2]!.workspaceId;
  evidence.verificationResult.workspaceId = evidence.context.workspaceId;
  const fake = fakeWorkspaceClient({ list: workspaceListFixture(workspaces), evidence });
  fake.getWorkspaceMaterialization.mockImplementation(async id => assistantMaterialization(workspaces.find(item => item.workspaceId === id)!));
  return { fake, evidence };
}
beforeEach(() => {
  localStorage.clear();
  harness.refresh.mockClear(); harness.acknowledge.mockClear();
  harness.snapshot = { items: workspaces.map((_, i) => result(i)), history: [], sources: {}, inboxes: {}, refreshing: false };
});

describe("workspace board attention", () => {
  it("shows exact actions across five workspaces and opens an agent result without reviewing it", async () => {
    const { fake } = setup();
    const opened = vi.fn();
    window.addEventListener(AGENT_FEEDBACK_RESULT_REQUESTED_EVENT, opened);
    try {
      render(<LocalWorkspace client={fake.client} />);
      for (let i = 0; i < 5; i++) expect(await screen.findByRole("button", { name: `Review result ${i} Saved task ${i}` })).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Review result 3 Saved task 3" }));
      expect(opened).toHaveBeenCalledOnce();
      expect((opened.mock.calls[0]![0] as CustomEvent).detail).toMatchObject({ conversationId: "conversation-3", requestId: "request-3", messageId: "message-3" });
      expect(harness.acknowledge).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Mark Review result 3 as reviewed" }));
      expect(harness.acknowledge).toHaveBeenCalledWith("item-3", "revision-3");
    } finally { window.removeEventListener(AGENT_FEEDBACK_RESULT_REQUESTED_EVENT, opened); }
  });

  it("opens the exact failed check from its workspace card without running it", async () => {
    const { fake, evidence } = setup();
    harness.snapshot.items[2] = { ...result(2), kind: "verification", label: "Inspect checkout failure", detail: "Unit tests",
      target: { kind: "verification", checkId: "checkout-unit", planRevision: 1, runStartedAt: evidence.verificationResult.startedAtUnixMs! } };
    render(<LocalWorkspace client={fake.client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Inspect checkout failure Unit tests" }));
    const selected = await screen.findByRole("region", { name: "Selected check result" });
    expect(within(selected).getByText("Expected one capture, received two.")).toBeVisible();
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });

  it("retains actions during failed refresh and exposes source details and retry", async () => {
    const { fake } = setup();
    const fresh = { status: "fresh" as const, refreshing: false, updatedAt: Date.now(), error: "", detail: "" };
    harness.snapshot.sources["space-0"] = { agent: fresh, verification: fresh, gitlab: { ...fresh, status: "stale", error: "GitLab connection failed." } };
    render(<LocalWorkspace client={fake.client} />);
    const card = await screen.findByRole("region", { name: "Project 0 attention" });
    expect(within(card).getByRole("button", { name: "Review result 0 Saved task 0" })).toBeVisible();
    expect(within(card).getByText(/GitLab status is unavailable/)).toBeVisible();
    const banner = screen.getByRole("note");
    expect(banner).toHaveTextContent("GitLab status is unavailable for 1 workspace.");
    fireEvent.click(within(banner).getByRole("button", { name: "Retry status" }));
    await waitFor(() => expect(harness.refresh).toHaveBeenCalledWith(expect.any(Array), { force: true }));
    harness.refresh.mockClear();
    fireEvent.click(within(card).getByRole("button", { name: "Retry status" }));
    await waitFor(() => expect(harness.refresh).toHaveBeenCalledWith(expect.any(Array), { force: true }));
    act(() => { harness.snapshot = { ...harness.snapshot, refreshing: true }; harness.listeners.forEach(listener => listener()); });
    expect(within(card).getByRole("button", { name: "Review result 0 Saved task 0" })).toBeVisible();
  });

  it("keeps a quiet workspace card free of status rows", async () => {
    const { fake } = setup();
    const fresh = { status: "fresh" as const, refreshing: true, updatedAt: Date.now(), error: "", detail: "" };
    harness.snapshot.items = harness.snapshot.items.filter(item => item.workspaceId !== "space-1");
    harness.snapshot.sources["space-1"] = { agent: fresh, verification: fresh, gitlab: fresh };
    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("region", { name: "Project 0 attention" });
    expect(screen.queryByRole("region", { name: "Project 1 attention" })).not.toBeInTheDocument();
  });
  it("opens the exact unread MR thread in Changes", async () => {
    const { fake } = setup();
    const workspace = workspaces[4]!;
    harness.snapshot.items[4] = { ...result(4), kind: "gitlab", label: "Read return-value thread", detail: "Unread comments and replies.",
      target: { kind: "gitlab", repositoryId: "repo_checkout", iid: 16, discussionId: "exact-thread", scopeId: "c".repeat(64) } };
    fake.getGitlabMergeRequests.mockResolvedValue({ schemaVersion: 1, state: "fresh", fetchedAtUnixMs: Date.now(), detail: "Ready", mergeRequests: [{
      id: "mr-16", repositoryId: "repo_checkout", iid: 16, projectPath: "team/api", webUrl: "https://gitlab.example.com/team/api/-/merge_requests/16",
      title: "Fix return values", sourceBranch: `wts/${workspace.workspaceId}`, targetBranch: "main", authorUsername: "me", updatedAt: "2026-09-19T00:00:00Z", draft: false, status: "open",
    }] });
    fake.getGitlabDiscussions.mockResolvedValue({ schemaVersion: 1, repositoryId: "repo_checkout", iid: 16, scopeId: "c".repeat(64), viewerLogin: "me", fetchedAtUnixMs: Date.now(), fromCache: false, truncated: false,
      discussions: [
        { id: "other-thread", resolvable: false, resolved: false, automated: false, comments: [{ id: 1, authorLogin: "reviewer", body: "Another unrelated thread.", createdAt: "2026-09-19T00:00:00Z" }] },
        { id: "exact-thread", resolvable: false, resolved: false, automated: false, comments: [{ id: 2, authorLogin: "reviewer", body: "The exact thread from the board.", createdAt: "2026-09-19T00:01:00Z" }] },
      ] });
    render(<LocalWorkspace client={fake.client} />);
    fireEvent.click(await screen.findByRole("button", { name: /Read return-value thread/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Changes/ })).toHaveAttribute("data-state", "active"));
    expect(await screen.findByRole("textbox", { name: /reply/i })).toBeVisible();
    expect(screen.getAllByText("The exact thread from the board.").some(element => element.closest("[data-ui='gitlab-conversations.thread']"))).toBe(true);
    expect(fake.replyGitlabDiscussion).not.toHaveBeenCalled();
    expect(harness.acknowledge).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged lane transition when another workspace refresh arrives", async () => {
    const { fake } = setup();
    let resolve!: (value: Awaited<ReturnType<typeof fake.client.transitionWorkspaceWorkflow>>) => void;
    fake.transitionWorkspaceWorkflow.mockReturnValue(new Promise(done => { resolve = done; }));
    const inbox = { schemaVersion: 1 as const, state: "fresh" as const, detail: "Ready", fetchedAtUnixMs: Date.now(), mergeRequests: [{
      id: "mr-16", repositoryId: "repo_checkout", iid: 16, projectPath: "team/api", webUrl: "https://gitlab.example.com/team/api/-/merge_requests/16",
      title: "Open MR", sourceBranch: "feature", targetBranch: "main", authorUsername: "me", updatedAt: "2026-09-19T00:00:00Z", draft: false, status: "open" as const,
    }] };
    harness.snapshot.inboxes["space-0"] = inbox;
    const { container } = render(<LocalWorkspace client={fake.client} />);
    await waitFor(() => expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledWith("space-0", "parked", 1));
    act(() => { harness.snapshot = { ...harness.snapshot, inboxes: { ...harness.snapshot.inboxes, "space-1": { ...inbox, mergeRequests: [] } } }; harness.listeners.forEach(listener => listener()); });
    await act(async () => resolve({ state: "parked", revision: 2, updatedAtUnixMs: Date.now() }));
    await waitFor(() => expect(container.querySelector('[data-workspace-id="space-0"] article')).toHaveAttribute("data-lane", "suspended"));
  });

});
