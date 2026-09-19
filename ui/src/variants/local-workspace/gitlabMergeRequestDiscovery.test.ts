import { describe, expect, it, vi } from "vitest";
import type { GitlabMergeRequestInbox, WorkspaceClient } from "../../lib/wtsClient";
import { loadWorkspaceGitlabMergeRequests, invalidateWorkspaceGitlabMergeRequests } from "./gitlabMergeRequestDiscovery";

const inbox: GitlabMergeRequestInbox = { schemaVersion: 1, state: "fresh", detail: "Ready", fetchedAtUnixMs: 1, mergeRequests: [] };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function client(read = vi.fn().mockResolvedValue(inbox)) { return { value: { getGitlabMergeRequests: read } as unknown as WorkspaceClient, read }; }
describe("shared workspace MR discovery", () => {
  it("shares one pending read and exact result across concurrent consumers", async () => {
    const pending = deferred<GitlabMergeRequestInbox>(); const source = client(vi.fn().mockReturnValue(pending.promise));
    const first = loadWorkspaceGitlabMergeRequests(source.value, "workspace");
    const second = loadWorkspaceGitlabMergeRequests(source.value, "workspace");
    expect(source.read).toHaveBeenCalledOnce(); expect(first).toBe(second);
    pending.resolve(inbox); expect(await first).toBe(inbox); expect(await second).toBe(inbox);
  });
  it("keeps different workspaces and client connections separate", async () => {
    const first = client(); const second = client();
    await Promise.all([loadWorkspaceGitlabMergeRequests(first.value, "workspace-one"), loadWorkspaceGitlabMergeRequests(first.value, "workspace-two"), loadWorkspaceGitlabMergeRequests(second.value, "workspace-one")]);
    expect(first.read.mock.calls).toEqual([["workspace-one"], ["workspace-two"]]); expect(second.read).toHaveBeenCalledOnce();
  });
  it("reuses a recent completed read and honors an explicit refresh", async () => {
    const source = client(); await loadWorkspaceGitlabMergeRequests(source.value, "workspace");
    const next = { ...inbox, fetchedAtUnixMs: 2 }; source.read.mockResolvedValueOnce(next);
    expect(await loadWorkspaceGitlabMergeRequests(source.value, "workspace")).toBe(inbox);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(await loadWorkspaceGitlabMergeRequests(source.value, "workspace", { force: true })).toBe(next); expect(source.read).toHaveBeenCalledTimes(2);
  });
  it("releases a failed read so an explicit retry can recover", async () => {
    const pending = deferred<GitlabMergeRequestInbox>(); const source = client(vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(inbox));
    const first = loadWorkspaceGitlabMergeRequests(source.value, "workspace");
    const second = loadWorkspaceGitlabMergeRequests(source.value, "workspace");
    const failure = new Error("GitLab is unavailable."); const outcomes = Promise.allSettled([first, second]); pending.reject(failure);
    expect(await outcomes).toEqual([{ status: "rejected", reason: failure }, { status: "rejected", reason: failure }]);
    expect(await loadWorkspaceGitlabMergeRequests(source.value, "workspace")).toBe(inbox); expect(source.read).toHaveBeenCalledTimes(2);
  });
  it("limits workspace discovery to three concurrent reads", async () => {
    const reads = Array.from({ length: 8 }, () => deferred<GitlabMergeRequestInbox>());
    let next = 0;
    const source = client(vi.fn(() => reads[next++]!.promise));
    const requests = reads.map((_, index) => loadWorkspaceGitlabMergeRequests(source.value, `workspace-${index}`));
    expect(source.read).toHaveBeenCalledTimes(3);
    for (const read of reads) { read.resolve(inbox); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
    await Promise.all(requests);
    expect(source.read).toHaveBeenCalledTimes(8);
  });
  it("expires recent reads and invalidates a read after local changes", async () => {
    vi.useFakeTimers();
    try {
      const source = client();
      await loadWorkspaceGitlabMergeRequests(source.value, "workspace");
      await vi.advanceTimersByTimeAsync(30_001);
      await loadWorkspaceGitlabMergeRequests(source.value, "workspace");
      expect(source.read).toHaveBeenCalledTimes(2);
      invalidateWorkspaceGitlabMergeRequests(source.value, "workspace");
      await loadWorkspaceGitlabMergeRequests(source.value, "workspace");
      expect(source.read).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
  it("returns the current snapshot when a local change overtakes a pending read", async () => {
    const old = deferred<GitlabMergeRequestInbox>();
    const current = { ...inbox, fetchedAtUnixMs: 2 };
    const source = client(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(current));
    const read = loadWorkspaceGitlabMergeRequests(source.value, "workspace");
    invalidateWorkspaceGitlabMergeRequests(source.value, "workspace");
    expect(await loadWorkspaceGitlabMergeRequests(source.value, "workspace")).toBe(current);
    old.resolve(inbox);
    expect(await read).toBe(current);
  });

});
