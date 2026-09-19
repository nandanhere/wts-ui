import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";
import { agentTurnChangesFixture } from "../test/agentTurnChangesFixture";
const receipt = agentTurnChangesFixture();
const setId = "77777777-7777-4777-8777-777777777777"; const taskId = "88888888-8888-4888-8888-888888888888"; const childId = "99999999-9999-4999-8999-999999999999";
const taskRequest = { taskId, title: "Check the layout", prompt: "Keep the composer visible.", dependsOn: [] as string[] };
const create = { requestId: setId, expectedAfterCheckpointId: receipt.after!.checkpointId, kind: "tasks" as const, tasks: [taskRequest] };
const source = { kind: "workItem" as const, workSetId: setId, taskId, label: taskRequest.title, originConversationId: receipt.conversationId, originRequestId: receipt.requestId };
const workSet = () => ({ schemaVersion: 1, workSetId: setId, conversationId: receipt.conversationId, requestId: receipt.requestId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, sourceCheckpointId: receipt.after!.checkpointId, sourceContextSha256: receipt.sourceContextSha256, kind: "tasks", revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 2, tasks: [{ ...taskRequest, state: "pending", conversationId: childId, requestId: taskId, detail: "The task waits." }], detail: "WTS saved the tasks." });
function transport(runtime: "http" | "tauri", result: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/bootstrap") ? { sessionToken: "test-session" } : result), { status: 200, headers: { "Content-Type": "application/json" } })); const invoke = vi.fn(async () => result);
  return { fetch, invoke, client: createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> }) };
}
describe.each(["http", "tauri"] as const)("work sets over %s", runtime => {
  it("reads host work-item provenance but rejects it in public creation", async () => {
    const child = { schemaVersion: 1, conversationId: childId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, workspaceDisplayPath: "/work/child", provider: "codex", revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 1, source, messages: [] };
    const { client } = transport(runtime, child); await expect(client.getAgentConversation!(childId)).resolves.toEqual(child);
    const next = transport(runtime, child); await expect(next.client.createAgentConversation!({ requestId: childId, provider: "codex", source })).rejects.toBeDefined(); expect(next.fetch).not.toHaveBeenCalled(); expect(next.invoke).not.toHaveBeenCalled();
  });
  it("creates the exact task plan from the recorded checkpoint", async () => {
    const result = workSet(); const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.createAgentWorkSet!(receipt.conversationId, receipt.requestId, create)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch.mock.calls[1]).toEqual([`/api/v1/agent-conversations/${receipt.conversationId}/messages/${receipt.requestId}/work-sets`, expect.objectContaining({ method: "POST", body: JSON.stringify(create) })]);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith("create_agent_work_set", { conversationId: receipt.conversationId, turnRequestId: receipt.requestId, request: create });
  });
  it("lists the exact origin and reads a named work set", async () => {
    const result = workSet(); const list = { schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, workSets: [result] };
    const first = transport(runtime, list); await expect(first.client.listAgentWorkSets!(receipt.conversationId, receipt.requestId)).resolves.toEqual(list);
    const second = transport(runtime, result); await expect(second.client.getAgentWorkSet!(setId)).resolves.toEqual(result);
  });
  it("cancels only the exact task with the saved revision and mutation ID", async () => {
    const request = { requestId: childId, expectedRevision: 1 }; const result = { ...workSet(), revision: 2, lastMutationRequestId: childId, tasks: [{ ...workSet().tasks[0], state: "cancelled" }] };
    const { client, fetch, invoke } = transport(runtime, result); await expect(client.cancelAgentWorkItem!(setId, taskId, request)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch.mock.calls[1]).toEqual([`/api/v1/agent-work-sets/${setId}/items/${taskId}/cancel`, expect.objectContaining({ method: "POST", body: JSON.stringify(request) })]);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith("cancel_agent_work_item", { workSetId: setId, taskId, request });
  });
});

it("opens only the exact native candidate preview", async () => {
  const result = { schemaVersion: 1, workSetId: setId, taskId, workspaceId: childId, repositoryId: "candidate", afterCheckpointId: receipt.after!.checkpointId, state: "running", url: "http://127.0.0.1:19422", title: "Candidate layout", detail: "WTS opened this candidate." };
  const { client, invoke } = transport("tauri", result);
  await expect(client.openAgentWorkItemPreview!(setId, taskId)).resolves.toEqual(result);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("open_agent_work_item_preview", { workSetId: setId, taskId });
});
it("offers desktop recovery without starting an HTTP preview or using the parent URL", async () => {
  const { client, fetch } = transport("http", {});
  await expect(client.openAgentWorkItemPreview!(setId, taskId)).rejects.toMatchObject({ code: "preview_desktop_required" }); expect(fetch).not.toHaveBeenCalled();
});

describe.each(["http", "tauri"] as const)("work-set validation over %s", runtime => {
  it.each([
    ["unknown dependency", { ...create, tasks: [{ ...taskRequest, dependsOn: [childId] }] }],
    ["self dependency", { ...create, tasks: [{ ...taskRequest, dependsOn: [taskId] }] }],
    ["cyclic dependencies", { ...create, tasks: [{ ...taskRequest, dependsOn: [childId] }, { ...taskRequest, taskId: childId, dependsOn: [taskId] }] }],
    ["duplicate task", { ...create, tasks: [taskRequest, taskRequest] }],
    ["alternative dependency", { ...create, kind: "alternatives", tasks: [{ ...taskRequest, dependsOn: [childId] }, { ...taskRequest, taskId: childId }] }],
    ["too many tasks", { ...create, tasks: Array.from({ length: 9 }, (_, index) => ({ ...taskRequest, taskId: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}` })) }],
    ["title byte limit", { ...create, tasks: [{ ...taskRequest, title: "é".repeat(81) }] }],
    ["prompt byte limit", { ...create, tasks: [{ ...taskRequest, prompt: "é".repeat(8193) }] }],
    ["title control", { ...create, tasks: [{ ...taskRequest, title: "Bad\nTitle" }] }],
    ["prompt control", { ...create, tasks: [{ ...taskRequest, prompt: "Bad\u0085prompt" }] }],
    ["nil mutation", { ...create, requestId: "00000000-0000-0000-0000-000000000000" }],
    ["unknown request field", { ...create, source: source }],
  ])("rejects %s before dispatch", async (_label, request) => {
    const { client, fetch, invoke } = transport(runtime, workSet());
    await expect(client.createAgentWorkSet!(receipt.conversationId, receipt.requestId, request as typeof create)).rejects.toBeDefined(); expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    ["wrong source checkpoint", () => ({ ...workSet(), sourceCheckpointId: childId })],
    ["changed title", () => ({ ...workSet(), tasks: [{ ...workSet().tasks[0], title: "Changed" }] })],
    ["wrong origin", () => ({ ...workSet(), conversationId: childId })],
    ["wrong mutation", () => ({ ...workSet(), workSetId: childId })],
    ["unknown task state", () => ({ ...workSet(), tasks: [{ ...workSet().tasks[0], state: "starting" }] })],
    ["zero revision", () => ({ ...workSet(), revision: 0 })],
    ["invalid source hash", () => ({ ...workSet(), sourceContextSha256: "wrong" })],
  ])("rejects %s in acknowledgements", async (_label, result) => { const { client } = transport(runtime, result()); await expect(client.createAgentWorkSet!(receipt.conversationId, receipt.requestId, create)).rejects.toBeDefined(); });
  it("rejects a cancellation response without the exact mutation receipt", async () => { const { client } = transport(runtime, { ...workSet(), tasks: [{ ...workSet().tasks[0], state: "cancelled" }] }); await expect(client.cancelAgentWorkItem!(setId, taskId, { requestId: childId, expectedRevision: 1 })).rejects.toBeDefined(); });
  it("omits child conversations from the shared feedback transcript", async () => {
    const child = { schemaVersion: 1, conversationId: childId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, workspaceDisplayPath: "/work/child", provider: "codex", revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 1, source, messages: [] };
    const { client } = transport(runtime, { schemaVersion: 1, conversations: [child] }); await expect(client.listAgentConversations!()).resolves.toEqual({ schemaVersion: 1, conversations: [] });
  });
});
it.each(["https://127.0.0.1:19422", "http://localhost:19422", "http://127.0.0.1", "http://example.com:19422", "http://name:secret@127.0.0.1:19422"])("rejects an untrusted preview URL %s", async url => {
  const { client } = transport("tauri", { schemaVersion: 1, workSetId: setId, taskId, workspaceId: childId, repositoryId: "candidate", afterCheckpointId: receipt.after!.checkpointId, state: "running", url, title: "Candidate", detail: "Ready." }); await expect(client.openAgentWorkItemPreview!(setId, taskId)).rejects.toBeDefined();
});
