import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitlabDiscussions, GitlabMergeRequestInbox, WorkspaceClient, WorkspaceMaterialization } from "../../lib/wtsClient";
import type { AgentConversation } from "../../lib/agentConversations";
import { workspaceEvidenceFixture } from "../../test/workspaceClientFake";
import { useWorkspaceGitlabDiscussions } from "./gitlabDiscussions";
import { getWorkspaceAttentionStore, notifyAgentResultReviewed, observeWorkspaceVerificationSummary } from "./workspaceAttention";

function verificationFixture() { const evidence = workspaceEvidenceFixture(); return { ...evidence, schemaVersion: 1 as const, workspaceId: evidence.context.workspaceId, verificationHistory: evidence.verificationHistory ?? [] }; }

const workspaceId = "ws_01J_PERSISTED";
const workspaces = [{ workspaceId, materialized: true }];
function conversation(body = "The fix is ready."): AgentConversation {
  return { schemaVersion: 1, conversationId: "conversation-1", workspaceId, repositoryId: "repo_checkout", workspaceDisplayPath: "/work", provider: "codex", revision: 3, createdAtUnixMs: 1, updatedAtUnixMs: 3,
    source: { kind: "ui", route: "/", calloutId: "workspace", label: "Workspace board", capture: { mimeType: "image/png", dataUrl: "data:image/png;base64,private", width: 1, height: 1 } },
    messages: [{ messageId: "request-1", requestId: "request-1", role: "user", body: "Private request", status: "completed", createdAtUnixMs: 1, sessionId: "session-1" }, { messageId: "reply-1", role: "assistant", body, status: "completed", createdAtUnixMs: 3, sessionId: "session-1" }] };
}
function discussions(body = "Please change the return value."): GitlabDiscussions {
  return { schemaVersion: 1, repositoryId: "repo_checkout", iid: 16, scopeId: "a".repeat(64), viewerLogin: "me", fetchedAtUnixMs: 4, fromCache: false, truncated: false,
    discussions: [{ id: "thread-1", resolvable: true, resolved: false, automated: false, filePath: "src/main.rs", comments: [{ id: 1, body, authorLogin: "reviewer", createdAt: "2026-09-19T00:00:00Z" }, { id: 2, body: "My own reply", authorLogin: "me", createdAt: "2026-09-18T23:59:59Z" }] }] };
}
function harness() {
  const inbox = { schemaVersion: 1, state: "fresh", detail: "Ready", fetchedAtUnixMs: 4,
    mergeRequests: [{ repositoryId: "repo_checkout", iid: 16, projectPath: "team/checkout", status: "open" }] } as GitlabMergeRequestInbox;
  const client = { listAgentConversations: vi.fn().mockResolvedValue({ schemaVersion: 1, conversations: [conversation()] }),
    getWorkspaceVerificationSummary: vi.fn().mockResolvedValue(verificationFixture()),
    getGitlabMergeRequests: vi.fn().mockResolvedValue(inbox), getGitlabDiscussions: vi.fn().mockResolvedValue(discussions()) } as unknown as WorkspaceClient;
  return { client, inbox, store: getWorkspaceAttentionStore(client) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe("workspace attention", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("lists exact agent results, failed checks, and unread threads without loading workspace materialization", async () => {
    const { store, client } = harness();
    await store.refresh(workspaces);
    const snapshot = store.getSnapshot();
    expect(snapshot.items.map(item => item.kind).sort()).toEqual(["agent", "gitlab", "verification"]);
    expect(snapshot.items.find(item => item.kind === "agent")?.target).toMatchObject({ conversationId: "conversation-1", requestId: "request-1", messageId: "reply-1" });
    expect(snapshot.items.find(item => item.kind === "gitlab")?.count).toBe(1);
    expect(snapshot.items.find(item => item.kind === "verification")?.target).toMatchObject({ checkId: "checkout-unit", planRevision: 1 });
    expect(snapshot.sources[workspaceId]?.agent.detail).toMatch(/recent.*50/i);
    expect(client.getWorkspaceVerificationSummary!).toHaveBeenCalledTimes(1);
  });


  it("clears earlier thread attention after a GitLab reply and restores it for a later comment", async () => {
    const { store, client } = harness();
    await store.refresh(workspaces);
    expect(store.getSnapshot().items.find(item => item.kind === "gitlab")?.count).toBe(1);
    const replied = discussions();
    replied.discussions[0]!.comments[1]!.createdAt = "2026-09-19T00:00:01Z";
    vi.mocked(client.getGitlabDiscussions).mockResolvedValue(replied);
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(false);
    replied.discussions[0]!.comments.push({ id: 3, body: "One more change", authorLogin: "reviewer", createdAt: "2026-09-19T00:00:02Z" });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.find(item => item.kind === "gitlab")?.count).toBe(1);
  });

  it("clears attention immediately after a reply from WTS without a provider refresh", async () => {
    const { store, client } = harness();
    await store.refresh(workspaces);
    const unsubscribe = store.subscribe(() => {});
    const materialization = { worktrees: [{ repositoryId: "repo_checkout", label: "checkout", branchName: "feature" }] } as WorkspaceMaterialization;
    const view = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId, materialization, enabled: true }));
    await waitFor(() => expect(view.result.current.unreadCount).toBe(1));
    act(() => view.result.current.acceptReply(view.result.current.entries[0]!.target.key, {
      schemaVersion: 1, repositoryId: "repo_checkout", iid: 16, discussionId: "thread-1",
      comment: { id: 3, body: "Fixed", authorLogin: "me", createdAt: "2026-09-19T00:00:01Z" },
    }, "a".repeat(64)));
    expect(view.result.current.unreadCount).toBe(0);
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(false);
    view.unmount();
    unsubscribe();
  });

  it("shares pending reads and keeps cached items visible on a failed refresh", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    const before = store.getSnapshot().items;
    const pending = deferred<ReturnType<typeof verificationFixture>>();
    vi.mocked(client.getWorkspaceVerificationSummary!).mockReturnValueOnce(pending.promise);
    vi.mocked(client.listAgentConversations!).mockRejectedValueOnce(new Error("offline"));
    const refresh = store.refresh(workspaces, { force: true });
    const same = store.refresh(workspaces, { force: true });
    expect(refresh).toBe(same);
    expect(store.getSnapshot().items).toEqual(before);
    pending.resolve(verificationFixture()); await refresh;
    expect(store.getSnapshot().items.find(item => item.kind === "agent")).toBeTruthy();
    expect(store.getSnapshot().sources[workspaceId]?.agent).toMatchObject({ status: "stale", error: expect.any(String) });
  });

  it("does not repeat reads within 30 seconds and separates client caches", async () => {
    const { store, client } = harness(); await store.refresh(workspaces); await store.refresh(workspaces);
    expect(client.listAgentConversations).toHaveBeenCalledTimes(1);
    expect(client.getWorkspaceVerificationSummary!).toHaveBeenCalledTimes(1);
    expect(getWorkspaceAttentionStore(client)).toBe(store);
    const other = harness(); expect(other.store.getSnapshot().items).toEqual([]);
  });

  it("keeps an acknowledgement through an older in-flight response and stores no message or capture content", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    const agent = store.getSnapshot().items.find(item => item.kind === "agent")!;
    const pending = deferred<{ schemaVersion: 1; conversations: AgentConversation[] }>();
    vi.mocked(client.listAgentConversations!).mockReturnValueOnce(pending.promise);
    const refresh = store.refresh(workspaces, { force: true });
    store.acknowledge(agent.id, agent.revision);
    pending.resolve({ schemaVersion: 1, conversations: [conversation()] }); await refresh;
    expect(store.getSnapshot().items.some(item => item.kind === "agent")).toBe(false);
    expect(store.getSnapshot().history).toEqual(expect.arrayContaining([expect.objectContaining({ id: agent.id, revision: agent.revision })]));
    const stored = Array.from({ length: localStorage.length }, (_, index) => localStorage.getItem(localStorage.key(index)!)).join("");
    expect(stored).not.toMatch(/Private request|The fix is ready|data:image|Please change/);
    const restarted = harness(); await restarted.store.refresh(workspaces);
    expect(restarted.store.getSnapshot().items.some(item => item.kind === "agent")).toBe(false);
  });

  it("does not acknowledge a changed result with an older revision", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    const before = store.getSnapshot().items.find(item => item.kind === "agent")!;
    vi.mocked(client.listAgentConversations!).mockResolvedValue({ schemaVersion: 1, conversations: [conversation("A different result.")] });
    await store.refresh(workspaces, { force: true }); store.acknowledge(before.id, before.revision);
    expect(store.getSnapshot().items.find(item => item.kind === "agent")?.revision).not.toBe(before.revision);
  });

  it("does not clear a failed check when a different check passes and the failed check was skipped", async () => {
    const { store, client } = harness(); const evidence = verificationFixture();
    evidence.verificationPlan.checks.push({ ...evidence.verificationPlan.checks[0]!, id: "other", label: "Other check" });
    vi.mocked(client.getWorkspaceVerificationSummary!).mockResolvedValue(evidence); await store.refresh(workspaces);
    const previous = evidence.verificationResult;
    const passed = { ...previous, status: "passed" as const, startedAtUnixMs: previous.startedAtUnixMs! + 10_000,
      checks: [{ ...previous.checks[0]!, status: "skipped" as const }, { ...previous.checks[0]!, checkId: "other", status: "passed" as const }] };
    vi.mocked(client.getWorkspaceVerificationSummary!).mockResolvedValue({ ...evidence, verificationResult: passed, verificationHistory: [previous, passed] });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.filter(item => item.kind === "verification")).toHaveLength(1);
    const recovered = { ...passed, startedAtUnixMs: passed.startedAtUnixMs + 10_000, checks: [{ ...previous.checks[0]!, status: "passed" as const }] };
    vi.mocked(client.getWorkspaceVerificationSummary!).mockResolvedValue({ ...evidence, verificationResult: recovered, verificationHistory: [previous, passed, recovered] });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.filter(item => item.kind === "verification")).toHaveLength(0);
    expect(store.getSnapshot().history.some(item => item.kind === "verification")).toBe(true);
  });

  it("keeps a known failed check when it falls outside the bounded evidence history", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    const evidence = verificationFixture(); evidence.verificationResult = { ...evidence.verificationResult, status: "passed", checks: [] };
    vi.mocked(client.getWorkspaceVerificationSummary!).mockResolvedValue(evidence); await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.filter(item => item.kind === "verification")).toHaveLength(1);
  });

  it("updates unread attention immediately from another view and exposes edited comments again", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    const unsubscribe = store.subscribe(() => {});
    const materialization = { worktrees: [{ repositoryId: "repo_checkout", label: "checkout", branchName: "feature" }] } as WorkspaceMaterialization;
    const view = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId, materialization, enabled: true }));
    await waitFor(() => expect(view.result.current.unreadCount).toBe(1));
    act(() => view.result.current.markRead(view.result.current.entries[0]!.target.key, "a".repeat(64), discussions().discussions[0]!.comments));
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(false);
    vi.mocked(client.getGitlabDiscussions).mockResolvedValue(discussions("The reviewer edited this comment."));
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(true);
    view.unmount();
    unsubscribe();
  });

  it("does not turn a truncated or stale discussion response into a complete all-clear", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    vi.mocked(client.getGitlabDiscussions).mockResolvedValue({ ...discussions(), discussions: [], truncated: true, fromCache: true });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(true);
    expect(store.getSnapshot().sources[workspaceId]?.gitlab.status).toBe("stale");
  });

  it("caps all concurrent reads at four across a board of workspaces", async () => {
    const { store, client } = harness(); let active = 0; let maximum = 0;
    const observe = async <T,>(value: T) => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 1)); active--; return value; };
    vi.mocked(client.getWorkspaceVerificationSummary!).mockImplementation(async id => { const evidence = verificationFixture(); return observe({ ...evidence, workspaceId: id, context: { ...evidence.context, workspaceId: id }, verificationPlan: { ...evidence.verificationPlan, workspaceId: id }, verificationResult: { ...evidence.verificationResult, workspaceId: id } }); });
    vi.mocked(client.getGitlabMergeRequests).mockImplementation(() => observe({ schemaVersion: 1, state: "fresh", detail: "Ready", fetchedAtUnixMs: 4, mergeRequests: [] }));
    await store.refresh(Array.from({ length: 20 }, (_, index) => ({ workspaceId: `workspace-${index}`, materialized: true })));
    expect(maximum).toBeLessThanOrEqual(4); expect(maximum).toBeGreaterThan(1);
  });

  it("removes absent threads only after a complete current response", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    vi.mocked(client.getGitlabDiscussions).mockResolvedValue({ ...discussions(), discussions: [], fetchedAtUnixMs: 5 });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(false);
    expect(store.getSnapshot().history.some(item => item.kind === "gitlab")).toBe(true);
  });

  it("archives a removed merge request only after complete discovery", async () => {
    const { store, client, inbox } = harness(); await store.refresh(workspaces);
    vi.mocked(client.getGitlabMergeRequests).mockResolvedValue({ ...inbox, state: "stale", mergeRequests: [] });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(true);
    vi.mocked(client.getGitlabMergeRequests).mockResolvedValue({ ...inbox, fetchedAtUnixMs: 5, mergeRequests: [] });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(false);
  });

  it("queues the latest workspace scope and hides removed workspaces while the first read is pending", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    const before = store.getSnapshot();
    const pending = deferred<ReturnType<typeof verificationFixture>>();
    vi.mocked(client.getWorkspaceVerificationSummary!).mockReturnValueOnce(pending.promise);
    const first = store.refresh(workspaces, { force: true });
    const second = store.refresh([{ workspaceId: "new-workspace", materialized: false }]);
    expect(store.getSnapshot().items).toHaveLength(0);
    expect(Object.keys(store.getSnapshot().inboxes)).toEqual([]);
    expect(Object.keys(before.sources)).toEqual([workspaceId]);
    pending.resolve(verificationFixture()); await Promise.all([first, second]);
    expect(Object.keys(store.getSnapshot().sources)).toEqual(["new-workspace"]);
    expect(client.listAgentConversations).toHaveBeenCalledTimes(3);
  });

  it("does not read full evidence when the host lacks a verification summary endpoint", async () => {
    const { client } = harness(); client.getWorkspaceVerificationSummary = undefined;
    client.getWorkspaceEvidence = vi.fn().mockResolvedValue(verificationFixture());
    const store = getWorkspaceAttentionStore(client); await store.refresh(workspaces);
    expect(client.getWorkspaceEvidence).not.toHaveBeenCalled();
    expect(store.getSnapshot().sources[workspaceId]?.verification.status).toBe("error");
  });

  it("honors a receipt-bound decision before an in-flight result becomes visible, including after reload", async () => {
    const { store, client } = harness();
    const pending = deferred<{ schemaVersion: 1; conversations: AgentConversation[] }>();
    vi.mocked(client.listAgentConversations!).mockReturnValueOnce(pending.promise);
    const refresh = store.refresh(workspaces);
    notifyAgentResultReviewed(client, { conversationId: "conversation-1", requestId: "request-1", sessionId: "session-1" });
    pending.resolve({ schemaVersion: 1, conversations: [conversation()] }); await refresh;
    expect(store.getSnapshot().items.some(item => item.kind === "agent")).toBe(false);
    const restarted = harness(); await restarted.store.refresh(workspaces);
    expect(restarted.store.getSnapshot().items.some(item => item.kind === "agent")).toBe(false);
    const unrelated = conversation(); unrelated.messages[0]!.sessionId = "session-2"; unrelated.messages[1]!.sessionId = "session-2";
    vi.mocked(client.listAgentConversations!).mockResolvedValue({ schemaVersion: 1, conversations: [unrelated] });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.some(item => item.kind === "agent")).toBe(true);
  });

  it("rejects an older unknown failed check after the current view reports a newer passing check", async () => {
    const { store, client } = harness();
    const pending = deferred<ReturnType<typeof verificationFixture>>();
    vi.mocked(client.getWorkspaceVerificationSummary!).mockReturnValueOnce(pending.promise);
    const refresh = store.refresh(workspaces);
    const newer = verificationFixture();
    newer.verificationResult = { ...newer.verificationResult, status: "passed", startedAtUnixMs: newer.verificationResult.startedAtUnixMs! + 10_000,
      checks: newer.verificationResult.checks.map(check => ({ ...check, status: "passed" })) };
    observeWorkspaceVerificationSummary(client, newer);
    pending.resolve(verificationFixture()); await refresh;
    expect(store.getSnapshot().items.some(item => item.kind === "verification")).toBe(false);
  });

  it("keeps item arrays and storage unchanged for a source-only refresh", async () => {
    const { store } = harness(); await store.refresh(workspaces);
    const previous = store.getSnapshot();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items).toBe(previous.items);
    expect(store.getSnapshot().history).toBe(previous.history);
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps newer thread metadata when an older complete provider response omits that thread", async () => {
    const { store, client } = harness();
    vi.mocked(client.getGitlabDiscussions).mockResolvedValue({ ...discussions(), fetchedAtUnixMs: 100 });
    await store.refresh(workspaces);
    vi.mocked(client.getGitlabDiscussions).mockResolvedValue({ ...discussions(), discussions: [], fetchedAtUnixMs: 50 });
    await store.refresh(workspaces, { force: true });
    expect(store.getSnapshot().items.some(item => item.kind === "gitlab")).toBe(true);
    expect(store.getSnapshot().sources[workspaceId]?.gitlab.refreshing).toBe(false);
  });

  it("replaces an old account scope with the current account without combining their unread counts", async () => {
    const { store, client } = harness(); await store.refresh(workspaces);
    vi.mocked(client.getGitlabDiscussions).mockResolvedValue({ ...discussions(), scopeId: "b".repeat(64), fetchedAtUnixMs: 5 });
    await store.refresh(workspaces, { force: true });
    const threads = store.getSnapshot().items.filter(item => item.kind === "gitlab");
    expect(threads).toHaveLength(1);
    expect(threads[0]!.target).toMatchObject({ scopeId: "b".repeat(64) });
  });

  it("batches a portfolio refresh into one notification and one metadata write before the next frame", async () => {
    const { store, client } = harness();
    const listener = vi.fn(); const unsubscribe = store.subscribe(listener);
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const writes = vi.spyOn(Storage.prototype, "setItem");
    vi.mocked(client.getWorkspaceVerificationSummary!).mockImplementation(async id => ({ ...verificationFixture(), workspaceId: id,
      verificationPlan: { ...verificationFixture().verificationPlan, workspaceId: id }, verificationResult: { ...verificationFixture().verificationResult, workspaceId: id } }));
    vi.mocked(client.getGitlabMergeRequests).mockResolvedValue({ schemaVersion: 1, state: "fresh", detail: "Ready", fetchedAtUnixMs: 4, mergeRequests: [] });
    await store.refresh(Array.from({ length: 50 }, (_, index) => ({ workspaceId: `workspace-${index}`, materialized: true })));
    expect(store.getSnapshot().items).toHaveLength(50);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("retains explicit review state when new results exceed the 1024-record display limit", async () => {
    const { store, client } = harness();
    const batch = (id: string, turns: number): AgentConversation => ({ ...conversation(), conversationId: id,
      messages: Array.from({ length: turns }, (_, index) => [
        { messageId: `request-${index}`, requestId: `request-${index}`, role: "user" as const, status: "completed" as const, body: "Fix this.", createdAtUnixMs: index * 2, sessionId: `session-${index}` },
        { messageId: `reply-${index}`, role: "assistant" as const, status: "completed" as const, body: "The fix is ready.", createdAtUnixMs: index * 2 + 1, sessionId: `session-${index}` },
      ]).flat() });
    vi.mocked(client.listAgentConversations!).mockResolvedValue({ schemaVersion: 1, conversations: [batch("one", 512), batch("two", 512)] });
    await store.refresh([{ workspaceId, materialized: false }]);
    expect(store.getSnapshot().items).toHaveLength(1024);
    const reviewed = store.getSnapshot().items[0]!; store.acknowledge(reviewed.id, reviewed.revision);
    vi.mocked(client.listAgentConversations!).mockResolvedValue({ schemaVersion: 1, conversations: [batch("one", 513), batch("two", 512)] });
    await store.refresh([{ workspaceId, materialized: false }], { force: true });
    await store.refresh([{ workspaceId, materialized: false }], { force: true });
    expect(store.getSnapshot().items.some(item => item.id === reviewed.id && item.revision === reviewed.revision)).toBe(false);
    const restarted = getWorkspaceAttentionStore({ ...client });
    await restarted.refresh([{ workspaceId, materialized: false }]);
    expect(restarted.getSnapshot().items.some(item => item.id === reviewed.id && item.revision === reviewed.revision)).toBe(false);
  });

  it("keeps the result visible when the explicit review state cannot be saved", async () => {
    const { store } = harness(); await store.refresh(workspaces);
    const item = store.getSnapshot().items.find(item => item.kind === "agent")!;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage is full"); });
    store.acknowledge(item.id, item.revision);
    expect(store.getSnapshot().items.some(value => value.id === item.id)).toBe(true);
    expect(store.getSnapshot().sources[workspaceId]!.agent.error).toContain("Reviewed");
    write.mockRestore(); store.acknowledge(item.id, item.revision);
    expect(store.getSnapshot().items.some(value => value.id === item.id)).toBe(false);
  });
});
