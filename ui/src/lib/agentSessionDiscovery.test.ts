import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionList, WorkspaceClient } from "./wtsClient";
import { invalidateAgentSessions, loadAgentSessions } from "./agentSessionDiscovery";

const empty: AgentSessionList = { schemaVersion: 1, sessions: [] };
function client() {
  const list = vi.fn(async (_workspaceId?: string): Promise<AgentSessionList> => empty);
  return { list, client: { listAgentSessions: list } as unknown as WorkspaceClient };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe("agent session discovery", () => {
  it("shares one pending read and ten warm navigation returns, then reads at the five-second boundary", async () => {
    const fake = client(); const pending = deferred<AgentSessionList>();
    let now = 100; vi.spyOn(Date, "now").mockImplementation(() => now);
    fake.list.mockReturnValueOnce(pending.promise);
    const first = loadAgentSessions(fake.client);
    expect(loadAgentSessions(fake.client)).toBe(first);
    pending.resolve(empty); await first;
    for (let cycle = 0; cycle < 10; cycle++) { now += 400; expect(await loadAgentSessions(fake.client)).toBe(empty); }
    expect(fake.list).toHaveBeenCalledTimes(1);
    now = 5100; await loadAgentSessions(fake.client);
    expect(fake.list).toHaveBeenCalledTimes(2);
    expect(fake.list).toHaveBeenLastCalledWith();
  });

  it("keeps separate clients and workspace scopes independent", async () => {
    const first = client(); const second = client();
    await Promise.all([loadAgentSessions(first.client), loadAgentSessions(first.client, "workspace-a"), loadAgentSessions(first.client, "workspace-b"), loadAgentSessions(second.client)]);
    await loadAgentSessions(first.client, "workspace-a");
    expect(first.list.mock.calls).toEqual([[], ["workspace-a"], ["workspace-b"]]);
    expect(second.list).toHaveBeenCalledTimes(1);
  });

  it("forces an explicit refresh but shares an already active read", async () => {
    const fake = client(); await loadAgentSessions(fake.client);
    const pending = deferred<AgentSessionList>(); fake.list.mockReturnValueOnce(pending.promise);
    const refresh = loadAgentSessions(fake.client, undefined, { force: true });
    expect(loadAgentSessions(fake.client, undefined, { force: true })).toBe(refresh);
    expect(fake.list).toHaveBeenCalledTimes(2);
    pending.resolve(empty); await refresh;
  });

  it("does not retain a failed read or return old success after a failed explicit refresh", async () => {
    const fake = client(); await loadAgentSessions(fake.client);
    fake.list.mockRejectedValueOnce(new Error("Host unavailable"));
    await expect(loadAgentSessions(fake.client, undefined, { force: true })).rejects.toThrow("Host unavailable");
    await loadAgentSessions(fake.client);
    expect(fake.list).toHaveBeenCalledTimes(3);
  });

  it("replaces a read from before a mutation with current session state", async () => {
    const fake = client(); const old = deferred<AgentSessionList>();
    fake.list.mockReturnValueOnce(old.promise);
    const beforeMutation = loadAgentSessions(fake.client, "workspace-a");
    invalidateAgentSessions(fake.client, "workspace-a");
    const latest: AgentSessionList = { ...empty, observedSessions: [] }; fake.list.mockResolvedValue(latest);
    expect(await loadAgentSessions(fake.client, "workspace-a")).toBe(latest);
    old.resolve(empty);
    expect(await beforeMutation).toBe(latest);
    expect(await loadAgentSessions(fake.client, "workspace-a")).toBe(latest);
    expect(fake.list).toHaveBeenCalledTimes(2);
  });

  it("invalidates the global view and affected workspace without discarding another scope", async () => {
    const fake = client();
    await Promise.all([loadAgentSessions(fake.client), loadAgentSessions(fake.client, "workspace-a"), loadAgentSessions(fake.client, "workspace-b")]);
    invalidateAgentSessions(fake.client, "workspace-a");
    await Promise.all([loadAgentSessions(fake.client), loadAgentSessions(fake.client, "workspace-a"), loadAgentSessions(fake.client, "workspace-b")]);
    expect(fake.list.mock.calls).toEqual([[], ["workspace-a"], ["workspace-b"], [], ["workspace-a"]]);
    invalidateAgentSessions(fake.client);
    await loadAgentSessions(fake.client, "workspace-b");
    expect(fake.list).toHaveBeenCalledTimes(6);
  });

  it("bounds retained scope entries and preserves recently used scopes", async () => {
    const fake = client();
    for (let index = 0; index < 32; index++) await loadAgentSessions(fake.client, `workspace-${index}`);
    await loadAgentSessions(fake.client, "workspace-0");
    await loadAgentSessions(fake.client, "workspace-32");
    await loadAgentSessions(fake.client, "workspace-0");
    expect(fake.list).toHaveBeenCalledTimes(33);
    await loadAgentSessions(fake.client, "workspace-1");
    expect(fake.list).toHaveBeenCalledTimes(34);
  });

  it("supersedes an old pending read even after capacity eviction", async () => {
    const fake = client(); const pending = deferred<AgentSessionList>(); fake.list.mockReturnValueOnce(pending.promise);
    const old = loadAgentSessions(fake.client, "old-workspace");
    for (let index = 0; index < 32; index++) await loadAgentSessions(fake.client, `workspace-${index}`);
    invalidateAgentSessions(fake.client, "old-workspace");
    const latest: AgentSessionList = { ...empty, observedSessions: [] }; fake.list.mockResolvedValue(latest);
    pending.resolve(empty);
    expect(await old).toBe(latest);
  });
});
