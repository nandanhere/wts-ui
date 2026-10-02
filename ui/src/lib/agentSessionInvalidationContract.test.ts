import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type AgentSession, type WorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";
import { loadAgentSessions } from "./agentSessionDiscovery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function transport(runtime: "http" | "tauri") {
  let session: AgentSession = { schemaVersion: 1, sessionId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", provider: "codex", terminal: "terminal",
    category: "implementation", status: "running", startedAtUnixMs: 1, lastHeartbeatAtUnixMs: 100, endedAtUnixMs: null, failure: null };
  let reads = 0;
  let mutation = async (): Promise<unknown> => { session = { ...session, lastHeartbeatAtUnixMs: 200 }; return session; };
  const list = () => { reads++; return { schemaVersion: 1, sessions: [session], observedSessions: [] }; };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const value = String(url).endsWith("/bootstrap") ? { sessionToken: "test-session" }
      : !init?.method || init.method === "GET" ? list() : await mutation();
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const invoke = vi.fn(async (command: string) => command === "list_agent_sessions" ? list() : mutation());
  const client = createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> });
  return { client, fetch, invoke, reads: () => reads, setMutation: (next: () => Promise<unknown>) => { mutation = next; }, update: (value: number) => { session = { ...session, lastHeartbeatAtUnixMs: value }; return session; } };
}
const mutations: Array<[string, (client: WorkspaceClient) => Promise<unknown>]> = [
  ["start", client => client.startAgentSessionPrototype("22222222-2222-4222-8222-222222222222")],
  ["launch", client => client.launchAgentSession("22222222-2222-4222-8222-222222222222", { provider: "codex", category: "implementation", prompt: "Use the fixture." })],
  ["stop", client => client.stopAgentSession("11111111-1111-4111-8111-111111111111")],
  ["complete", client => client.completeAgentSession("11111111-1111-4111-8111-111111111111")],
  ["fail", client => client.failAgentSession("11111111-1111-4111-8111-111111111111")],
  ["heartbeat", client => client.heartbeatAgentSession("11111111-1111-4111-8111-111111111111")],
];

describe.each(["http", "tauri"] as const)("agent session cache invalidation over %s", runtime => {
  it.each(mutations)("refreshes global and scoped session state after %s", async (_name, mutate) => {
    const fake = transport(runtime);
    await loadAgentSessions(fake.client); await loadAgentSessions(fake.client, "22222222-2222-4222-8222-222222222222");
    await mutate(fake.client);
    expect((await loadAgentSessions(fake.client)).sessions[0]!.lastHeartbeatAtUnixMs).toBe(200);
    expect((await loadAgentSessions(fake.client, "22222222-2222-4222-8222-222222222222")).sessions[0]!.lastHeartbeatAtUnixMs).toBe(200);
    expect(fake.reads()).toBe(4);
  });

  it("invalidates before dispatch and after an uncertain failed stop", async () => {
    const fake = transport(runtime); const started = deferred<void>(); const finish = deferred<void>();
    fake.setMutation(async () => { fake.update(150); started.resolve(); await finish.promise; fake.update(200); throw new Error("Connection lost after stop"); });
    await loadAgentSessions(fake.client);
    const operation = fake.client.stopAgentSession("11111111-1111-4111-8111-111111111111");
    const rejected = expect(operation).rejects.toMatchObject({ retryable: true });
    await started.promise;
    try { expect((await loadAgentSessions(fake.client)).sessions[0]!.lastHeartbeatAtUnixMs).toBe(150); }
    finally { finish.resolve(); await rejected; }
    expect((await loadAgentSessions(fake.client)).sessions[0]!.lastHeartbeatAtUnixMs).toBe(200);
    expect(fake.reads()).toBe(3);
  });

  it("refreshes session state after the host accepts a queued conversation message", async () => {
    const fake = transport(runtime);
    const request = { requestId: "33333333-3333-4333-8333-333333333333", body: "Run this fixture after the current task." };
    const conversationId = "44444444-4444-4444-8444-444444444444";
    fake.setMutation(async () => {
      fake.update(200);
      return { schemaVersion: 1, conversationId, workspaceId: "22222222-2222-4222-8222-222222222222", repositoryId: "repo", workspaceDisplayPath: "/work/fixture", provider: "codex",
        source: { kind: "ui", route: "/", calloutId: "spaces.board", label: "Spaces board" }, revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 2,
        messages: [{ messageId: request.requestId, ...request, role: "user", status: "queued", createdAtUnixMs: 2 }] };
    });
    await loadAgentSessions(fake.client);
    await fake.client.sendAgentConversationMessage!(conversationId, request);
    expect((await loadAgentSessions(fake.client)).sessions[0]!.lastHeartbeatAtUnixMs).toBe(200);
    expect(fake.reads()).toBe(2);
    if (runtime === "tauri") expect(fake.invoke).toHaveBeenCalledWith("send_agent_conversation_message", { conversationId, request });
    else expect(fake.fetch).toHaveBeenCalledWith(`/api/v1/agent-conversations/${conversationId}/messages`, expect.objectContaining({ method: "POST", body: JSON.stringify(request) }));
  });
});
