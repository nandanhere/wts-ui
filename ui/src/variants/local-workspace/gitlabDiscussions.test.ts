import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitlabDiscussions, GitlabMergeRequestInbox, GitlabReviewDiscussionComment, WorkspaceClient, WorkspaceMaterialization } from "../../lib/wtsClient";
import { useWorkspaceGitlabDiscussions } from "./gitlabDiscussions";

const comment = (id: number, body = `Comment ${id}`, authorLogin = "reviewer"): GitlabReviewDiscussionComment => ({ id, body, authorLogin, createdAt: "2026-09-17T08:00:00Z" });
const snapshot = (comments = [comment(1)], extra: Partial<GitlabDiscussions> = {}): GitlabDiscussions => ({
  schemaVersion: 1, repositoryId: "repo-api", iid: 16, scopeId: "a".repeat(64), viewerLogin: "me",
  discussions: [{ id: "thread-1", automated: false, resolvable: true, resolved: false, comments }],
  fetchedAtUnixMs: 1, fromCache: false, truncated: false, ...extra,
});
const materialization = { worktrees: [{ repositoryId: "repo-api", label: "api", branchName: "feature" }] } as WorkspaceMaterialization;
function harness(read = vi.fn().mockResolvedValue(snapshot())) {
  const client = {
    getGitlabMergeRequests: vi.fn().mockResolvedValue({ schemaVersion: 1, state: "fresh", detail: "Ready", fetchedAtUnixMs: 1, mergeRequests: [{ repositoryId: "repo-api", iid: 16, projectPath: "team/api", status: "open" }] }),
    getGitlabDiscussions: read,
  } as unknown as WorkspaceClient;
  return { client, read };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("workspace GitLab conversation activity", () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it("does not count automated bot notes as unread review work", async () => {
    const read = vi.fn().mockResolvedValue(snapshot([comment(1)], {
      discussions: [
        { id: "bot", automated: true, resolvable: false, resolved: false, comments: [comment(9, "hello from cibot", "cibot")] },
        { id: "human", automated: false, resolvable: true, resolved: false, comments: [comment(1, "log the error")] },
      ],
    }));
    const { client } = harness(read);
    const hook = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(hook.result.current.entries[0]?.snapshot).toBeTruthy());
    expect(hook.result.current.unreadCount).toBe(1);
    expect(hook.result.current.entries[0]!.unreadCommentIds).toEqual([1]);
  });

  it("updates another mounted view when a comment is read in the same window", async () => {
    const { client } = harness();
    const options = { client, workspaceId: "workspace-1", materialization, enabled: true };
    const first = renderHook(() => useWorkspaceGitlabDiscussions(options));
    const second = renderHook(() => useWorkspaceGitlabDiscussions(options));
    await waitFor(() => expect(second.result.current.unreadCount).toBe(1));
    await waitFor(() => expect(first.result.current.unreadCount).toBe(1));
    act(() => first.result.current.markRead(first.result.current.entries[0]!.target.key, "a".repeat(64), [comment(1)]));
    expect(second.result.current.unreadCount).toBe(0);
  });

  it("updates MR header metadata from discovery without losing conversations or read markers", async () => {
    const original = snapshot([comment(1), comment(2)]);
    const { client, read } = harness(vi.fn().mockResolvedValue(original));
    const inbox: GitlabMergeRequestInbox = {
      schemaVersion: 1, state: "fresh", detail: "Ready", fetchedAtUnixMs: 1,
      mergeRequests: [{
        id: "gitlab-api-16", repositoryId: "repo-api", projectPath: "team/api", iid: 16,
        webUrl: "https://gitlab.example.test/team/api/-/merge_requests/16",
        title: "Add one-time boot profiles", sourceBranch: "feature/boot-profiles", targetBranch: "main",
        authorUsername: "priya", updatedAt: "2026-09-17T08:00:00Z", draft: false, status: "open",
      }],
    };
    vi.mocked(client.getGitlabMergeRequests).mockResolvedValue(inbox);
    const options = { client, workspaceId: "workspace-1", materialization, enabled: true };
    const first = renderHook(() => useWorkspaceGitlabDiscussions(options));
    await waitFor(() => expect(first.result.current.unreadCount).toBe(2));
    const target = first.result.current.entries[0]!.target;
    expect(client.getGitlabMergeRequests).toHaveBeenCalledWith("workspace-1");
    expect(target).toEqual({
      key: JSON.stringify(["workspace-1", "repo-api", 16]), workspaceId: "workspace-1",
      repositoryId: "repo-api", worktreeRepositoryId: "repo-api", iid: 16, label: "team/api !16",
      title: "Add one-time boot profiles", sourceBranch: "feature/boot-profiles", targetBranch: "main",
      status: "open", authorLogin: "priya",
    });
    act(() => first.result.current.markRead(target.key, original.scopeId, [comment(1)]));
    expect(first.result.current.entries[0]?.unreadCommentIds).toEqual([2]);

    const discovery = deferred<GitlabMergeRequestInbox>();
    const nextRead = deferred<GitlabDiscussions>();
    vi.mocked(client.getGitlabMergeRequests).mockReturnValueOnce(discovery.promise);
    read.mockReturnValueOnce(nextRead.promise);
    act(() => first.result.current.refresh());
    await waitFor(() => expect(client.getGitlabMergeRequests).toHaveBeenCalledTimes(2));
    expect(first.result.current.entries[0]?.snapshot).toBe(original);
    expect(first.result.current.entries[0]?.target).toEqual(target);

    await act(async () => discovery.resolve({
      ...inbox, fetchedAtUnixMs: 2,
      mergeRequests: [{ ...inbox.mergeRequests[0]!, title: "Document boot profile recovery", sourceBranch: "fix/profile-recovery", targetBranch: "release/2026.09", status: "merged", authorUsername: "alex" }],
    }));
    expect(read).toHaveBeenLastCalledWith("repo-api", 16, "workspace-1");
    expect(read).toHaveBeenCalledTimes(2);
    const updatedTarget = {
      ...target, title: "Document boot profile recovery", sourceBranch: "fix/profile-recovery",
      targetBranch: "release/2026.09", status: "merged", authorLogin: "alex",
    };
    expect(first.result.current.entries[0]?.target).toEqual(updatedTarget);
    expect(first.result.current.entries[0]?.snapshot).toBe(original);
    expect(first.result.current.entries[0]?.unreadCommentIds).toEqual([2]);
    expect(first.result.current.unreadCount).toBe(1);

    const refreshed = snapshot([comment(1), comment(2), comment(3)], { fetchedAtUnixMs: 2 });
    await act(async () => nextRead.resolve(refreshed));
    expect(first.result.current.entries[0]?.target).toEqual(updatedTarget);
    expect(first.result.current.entries[0]?.snapshot).toBe(refreshed);
    expect(first.result.current.entries[0]?.unreadCommentIds).toEqual([2, 3]);
    first.unmount();
    vi.mocked(client.getGitlabMergeRequests).mockReturnValue(new Promise(() => {}));
    const restored = renderHook(() => useWorkspaceGitlabDiscussions(options));
    expect(restored.result.current.entries[0]?.target).toEqual(updatedTarget);
    expect(restored.result.current.entries[0]?.snapshot?.discussions).toEqual(refreshed.discussions);
    expect(restored.result.current.entries[0]?.snapshot?.fromCache).toBe(true);
    expect(restored.result.current.entries[0]?.unreadCommentIds).toEqual([2, 3]);
  });

  it("shows saved conversations and their badge immediately on return while refreshing", async () => {
    const next = deferred<GitlabDiscussions>();
    const { client, read } = harness(vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValueOnce(snapshot([comment(8)], { scopeId: "b".repeat(64) })).mockReturnValueOnce(next.promise));
    const { result, rerender } = renderHook(({ workspaceId }) => useWorkspaceGitlabDiscussions({ client, workspaceId, materialization, enabled: true }), { initialProps: { workspaceId: "workspace-1" } });
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    rerender({ workspaceId: "workspace-2" });
    await waitFor(() => expect(result.current.entries[0]?.snapshot?.scopeId).toBe("b".repeat(64)));
    rerender({ workspaceId: "workspace-1" });
    expect(result.current.entries[0]?.snapshot?.discussions[0]?.comments[0]?.id).toBe(1);
    expect(result.current.unreadCount).toBe(1);
    expect(result.current.entries[0]?.snapshot?.fromCache).toBe(true);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    await act(async () => next.resolve(snapshot([comment(1), comment(2)])));
    expect(result.current.unreadCount).toBe(2);
    expect(result.current.entries[0]?.snapshot?.fromCache).toBe(false);
  });

  it("restores conversations after a panel remount but never shares a different client cache", async () => {
    const { client, read } = harness();
    const first = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(first.result.current.unreadCount).toBe(1));
    first.unmount();
    read.mockImplementation(() => new Promise(() => {}));
    const restored = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    expect(restored.result.current.entries[0]?.snapshot?.discussions[0]?.comments[0]?.id).toBe(1);
    const otherClient = harness(vi.fn(() => new Promise(() => {}))).client;
    const separate = renderHook(() => useWorkspaceGitlabDiscussions({ client: otherClient, workspaceId: "workspace-1", materialization, enabled: true }));
    expect(separate.result.current.entries.some((entry) => entry.snapshot)).toBe(false);
  });

  it("keeps cached conversations retryable when MR discovery fails on return", async () => {
    const { client } = harness();
    const first = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(first.result.current.unreadCount).toBe(1));
    first.unmount();
    vi.mocked(client.getGitlabMergeRequests).mockRejectedValueOnce(new Error("GitLab is unavailable."));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    const restored = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(restored.result.current.error).toBe("GitLab is unavailable."));
    expect(restored.result.current.entries[0]?.snapshot?.discussions[0]?.comments[0]?.id).toBe(1);
    expect(restored.result.current.entries[0]?.state).toBe("error");
    act(() => restored.result.current.refresh());
    await waitFor(() => expect(restored.result.current.entries[0]?.state).toBe("ready"));
  });

  it("finds a branch MR and counts unread replies without opening Changes", async () => {
    const { client, read } = harness();
    const { result } = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    expect(read).toHaveBeenCalledWith("repo-api", 16, "workspace-1");
    read.mockResolvedValue(snapshot([comment(1), comment(2), comment(3, "My reply", "me")]));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.unreadCount).toBe(0));
  });


  it("treats an existing GitLab reply as read only in its own thread and account", async () => {
    const original = snapshot([
      { ...comment(3, "My reply", "ME"), createdAt: "2026-09-18T08:00:00Z" },
      comment(1),
      { ...comment(4), createdAt: "2026-09-19T08:00:00Z" },
      comment(2),
    ]);
    original.discussions.push({ ...original.discussions[0]!, id: "thread-2", comments: [comment(5)] });
    const { client, read } = harness(vi.fn().mockResolvedValue(original));
    const options = { client, workspaceId: "workspace-1", materialization, enabled: true };
    const first = renderHook(() => useWorkspaceGitlabDiscussions(options));
    await waitFor(() => expect(first.result.current.entries[0]?.state).toBe("ready"));
    expect(first.result.current.entries[0]?.unreadCommentIds).toEqual([4, 5]);
    first.unmount();
    const restored = renderHook(() => useWorkspaceGitlabDiscussions(options));
    expect(restored.result.current.entries[0]?.unreadCommentIds).toEqual([4, 5]);
    await waitFor(() => expect(restored.result.current.entries[0]?.state).toBe("ready"));
    read.mockResolvedValue({ ...original, viewerLogin: "another", scopeId: "b".repeat(64) });
    act(() => restored.result.current.refresh());
    await waitFor(() => expect(restored.result.current.unreadCount).toBe(5));
  });

  it("keeps comments unread when reply timestamps cannot establish their order", async () => {
    const { client } = harness(vi.fn().mockResolvedValue(snapshot([
      { ...comment(1), createdAt: "invalid" },
      { ...comment(2, "My reply", "me"), createdAt: "invalid" },
      comment(3),
    ])));
    const { result } = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(result.current.entries[0]?.state).toBe("ready"));
    expect(result.current.entries[0]?.unreadCommentIds).toEqual([1, 3]);
  });

  it("acknowledges only displayed revisions and restores markers after remount", async () => {
    const { client, read } = harness();
    const first = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(first.result.current.unreadCount).toBe(1));
    const entry = first.result.current.entries[0]!;
    act(() => first.result.current.markRead(entry.target.key, entry.snapshot!.scopeId, [comment(1)]));
    expect(first.result.current.unreadCount).toBe(0);
    first.unmount();
    const second = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(second.result.current.entries[0]?.snapshot).toBeDefined());
    expect(second.result.current.unreadCount).toBe(0);
    read.mockResolvedValue(snapshot([comment(1, "Edited comment"), comment(2)]));
    act(() => second.result.current.refresh());
    await waitFor(() => expect(second.result.current.unreadCount).toBe(2));
    act(() => second.result.current.markRead(entry.target.key, entry.snapshot!.scopeId, [comment(1)]));
    expect(second.result.current.unreadCount).toBe(2);
    act(() => second.result.current.refresh());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    expect(second.result.current.unreadCount).toBe(2);
  });

  it("acknowledges earlier comments after a confirmed reply but keeps later comments unread", async () => {
    const { client, read } = harness();
    const { result } = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    const entry = result.current.entries[0]!;
    act(() => result.current.acceptReply(entry.target.key, { schemaVersion: 1, repositoryId: "repo-api", iid: 16, discussionId: "thread-1", comment: comment(2, "Reply", "me") }, entry.snapshot!.scopeId));
    expect(result.current.unreadCount).toBe(0);
    expect(result.current.entries[0]?.snapshot?.discussions[0]?.comments).toHaveLength(2);
    const updated = snapshot([comment(1), comment(2, "Reply", "me"), comment(3)]);
    updated.discussions[0]!.resolved = true;
    read.mockResolvedValue(updated);
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
  });

  it("keeps account scopes separate and rejects acknowledgements from the old account", async () => {
    const { client, read } = harness();
    const { result } = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    const entry = result.current.entries[0]!;
    act(() => result.current.markRead(entry.target.key, entry.snapshot!.scopeId, [comment(1)]));
    read.mockResolvedValue(snapshot([comment(1)], { scopeId: "b".repeat(64), viewerLogin: "another" }));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    act(() => result.current.markRead(entry.target.key, entry.snapshot!.scopeId, [comment(1)]));
    expect(result.current.unreadCount).toBe(1);
    act(() => result.current.acceptReply(entry.target.key, { schemaVersion: 1, repositoryId: "repo-api", iid: 16, discussionId: "thread-1", comment: comment(2, "Old account reply", "me") }, entry.snapshot!.scopeId));
    expect(result.current.entries[0]?.snapshot?.discussions[0]?.comments).toHaveLength(1);
  });

  it("keeps cached activity during provider errors and storage failures", async () => {
    const { client, read } = harness();
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Quota"); });
    const { result } = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    const entry = result.current.entries[0]!;
    act(() => result.current.markRead(entry.target.key, entry.snapshot!.scopeId, [comment(1)]));
    expect(result.current.unreadCount).toBe(0);
    read.mockRejectedValue(new Error("GitLab is unavailable."));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.entries[0]?.error).toBe("GitLab is unavailable."));
    expect(result.current.entries[0]?.snapshot?.discussions).toHaveLength(1);
    expect(result.current.unreadCount).toBe(0);
    storage.mockRestore();
  });

  it("ignores late reads after a workspace switch", async () => {
    const old = deferred<GitlabDiscussions>();
    const { client, read } = harness(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(snapshot([comment(2)])));
    const { result, rerender } = renderHook(({ workspaceId }) => useWorkspaceGitlabDiscussions({ client, workspaceId, materialization, enabled: true }), { initialProps: { workspaceId: "workspace-1" } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    rerender({ workspaceId: "workspace-2" });
    await waitFor(() => expect(result.current.entries[0]?.snapshot?.discussions[0]?.comments[0]?.id).toBe(2));
    await act(async () => old.resolve(snapshot([comment(99)])));
    expect(result.current.entries[0]?.snapshot?.discussions[0]?.comments[0]?.id).toBe(2);
  });

  it("keeps a confirmed reply when an earlier provider read completes later", async () => {
    const old = deferred<GitlabDiscussions>();
    const { client, read } = harness(vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValueOnce(old.promise));
    const { result } = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(result.current.unreadCount).toBe(1));
    const entry = result.current.entries[0]!;
    act(() => result.current.refresh());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    act(() => result.current.acceptReply(entry.target.key, { schemaVersion: 1, repositoryId: "repo-api", iid: 16, discussionId: "thread-1", comment: comment(2, "Confirmed reply", "me") }, entry.snapshot!.scopeId));
    await act(async () => old.resolve(snapshot()));
    expect(result.current.entries[0]?.snapshot?.discussions[0]?.comments.map((item) => item.id)).toEqual([1, 2]);
    expect(result.current.unreadCount).toBe(0);
  });

  it("refreshes on focus without parallel requests or acknowledging hidden content", async () => {
    const slow = deferred<GitlabDiscussions>();
    const { client, read } = harness(vi.fn().mockReturnValueOnce(slow.promise).mockResolvedValue(snapshot([comment(1), comment(2)])));
    const { result } = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => slow.resolve(snapshot()));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(result.current.unreadCount).toBe(2));
  });

  it("merges read markers from separate windows without losing either acknowledgement", async () => {
    const { client } = harness(vi.fn().mockResolvedValue(snapshot([comment(1), comment(2)])));
    const first = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    const second = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(first.result.current.unreadCount).toBe(2));
    await waitFor(() => expect(second.result.current.unreadCount).toBe(2));
    const entry = first.result.current.entries[0]!;
    act(() => first.result.current.markRead(entry.target.key, entry.snapshot!.scopeId, [comment(1)]));
    act(() => second.result.current.markRead(entry.target.key, entry.snapshot!.scopeId, [comment(2)]));
    expect(second.result.current.unreadCount).toBe(0);
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: "wts.gitlab-discussion-reads.v1" })));
    expect(first.result.current.unreadCount).toBe(0);
    first.unmount();
    second.unmount();
    const restored = renderHook(() => useWorkspaceGitlabDiscussions({ client, workspaceId: "workspace-1", materialization, enabled: true }));
    await waitFor(() => expect(restored.result.current.entries[0]?.snapshot).toBeDefined());
    expect(restored.result.current.unreadCount).toBe(0);
  });
});
