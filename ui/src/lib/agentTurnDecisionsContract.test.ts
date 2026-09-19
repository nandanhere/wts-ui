import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";
import { agentTurnChangesFixture, TURN_CONVERSATION_ID as conversationId, TURN_REQUEST_ID as turnRequestId } from "../test/agentTurnChangesFixture";
const receipt = agentTurnChangesFixture();
const mutationId = "99999999-9999-4999-8999-999999999999";
const digest = `sha256:${"d".repeat(64)}`;
const ledger = () => ({ schemaVersion: 1, conversationId, requestId: turnRequestId, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, afterCheckpointId: receipt.after!.checkpointId, receiptDigest: digest, sourceContextSha256: receipt.sourceContextSha256, revision: 0, state: "ready", checksState: "noChecks", detail: "No decision is recorded.", decisions: [] as unknown[] });
const request = { requestId: mutationId, expectedRevision: 0, expectedReceiptDigest: digest, kind: "kept" as const, reason: "Keep this option for comparison." };
const decision = () => ({ decisionId: mutationId, revision: 1, kind: request.kind, reason: request.reason, createdAtUnixMs: 5, afterCheckpointId: receipt.after!.checkpointId, receiptDigest: digest, sourceContextSha256: receipt.sourceContextSha256, checksState: "stale", checks: [] });
function transport(runtime: "http" | "tauri", result: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async url => new Response(JSON.stringify(String(url).endsWith("/bootstrap") ? { sessionToken: "test-session" } : result), { status: 200, headers: { "Content-Type": "application/json" } }));
  const invoke = vi.fn(async () => result);
  return { fetch, invoke, client: createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> }) };
}
describe.each(["http", "tauri"] as const)("task decisions over %s", runtime => {
  it("reads only the exact saved task history", async () => {
    const result = ledger(); const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.getAgentTurnDecisions!(conversationId, turnRequestId)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch.mock.calls[1]).toEqual([`/api/v1/agent-conversations/${conversationId}/messages/${turnRequestId}/decisions`, expect.objectContaining({ headers: expect.objectContaining({ "X-WTS-Session": "test-session" }) })]);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith("get_agent_turn_decisions", { conversationId, requestId: turnRequestId });
  });
  it("records the exact choice and receipt revision without inventing a passed check", async () => {
    const result = { ...ledger(), revision: 1, decisions: [decision()] }; const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.recordAgentTurnDecision!(conversationId, turnRequestId, request)).resolves.toEqual(result);
    if (runtime === "http") expect(fetch.mock.calls[1]).toEqual([`/api/v1/agent-conversations/${conversationId}/messages/${turnRequestId}/decisions`, expect.objectContaining({ method: "POST", body: JSON.stringify(request) })]);
    else expect(invoke).toHaveBeenCalledExactlyOnceWith("record_agent_turn_decision", { conversationId, turnRequestId, request });
  });
  it.each([
    ["identity", { requestId: conversationId }], ["schema", { schemaVersion: 2 }], ["session", { sessionId: "session" }],
    ["checkpoint", { afterCheckpointId: undefined }], ["receipt digest", { receiptDigest: "d".repeat(64) }],
    ["source digest", { sourceContextSha256: "bad" }], ["state", { state: "accepted" }], ["checks state", { checksState: "passed" }],
    ["ledger revision", { revision: -1 }], ["missing history", { revision: 1 }], ["history bound", { decisions: Array.from({ length: 65 }, () => decision()) }],
    ["detail bytes", { detail: "😀".repeat(513) }],
  ])("rejects malformed ledger %s", async (_name, change) => {
    await expect(transport(runtime, { ...ledger(), ...(change as object) }).client.getAgentTurnDecisions!(conversationId, turnRequestId)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([
    { decisionId: "bad" }, { revision: 2 }, { kind: "merged" }, { reason: "😀".repeat(1025) }, { reason: "x\0y" }, { reason: "x\u001by" }, { reason: "x\u0085y" },
    { createdAtUnixMs: -1 }, { createdAtUnixMs: Number.MAX_SAFE_INTEGER }, { afterCheckpointId: conversationId },
    { receiptDigest: `sha256:${"e".repeat(64)}` }, { sourceContextSha256: `sha256:${"e".repeat(64)}` }, { checksState: "passed" },
    { checks: Array.from({ length: 65 }, () => ({ runId: mutationId, checkId: "unit", status: "passed" })) },
    { checks: [{ runId: "bad", checkId: "unit", status: "passed" }] },
    { checks: [{ runId: mutationId, checkId: "unit;exit", status: "passed" }] },
    { checks: [{ runId: mutationId, checkId: "unit", status: "accepted" }] },
  ])("rejects malformed decision %j", async change => {
    await expect(transport(runtime, { ...ledger(), revision: 1, decisions: [{ ...decision(), ...change }] }).client.getAgentTurnDecisions!(conversationId, turnRequestId)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each([
    { requestId: "bad" }, { expectedRevision: -1 }, { expectedRevision: 64 }, { expectedReceiptDigest: "bad" }, { kind: "approved" }, { reason: "😀".repeat(1025) }, { reason: "x\0y" }, { reason: "x\u001by" }, { reason: "x\u0085y" }, { force: true },
  ])("rejects invalid decision requests before transport %j", async change => {
    const { client, fetch, invoke } = transport(runtime, {});
    await expect(client.recordAgentTurnDecision!(conversationId, turnRequestId, { ...request, ...change } as typeof request)).rejects.toBeDefined(); expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it.each([
    { decisionId: conversationId }, { kind: "accepted" }, { reason: "Changed reason." },
  ])("rejects a different mutation acknowledgement %j", async change => {
    await expect(transport(runtime, { ...ledger(), revision: 1, decisions: [{ ...decision(), ...change }] }).client.recordAgentTurnDecision!(conversationId, turnRequestId, request)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("accepts exact UTF-8 reason bounds and a current ledger that includes the saved replay", async () => {
    const textRequest = { ...request, reason: "😀".repeat(1024) };
    const result = { ...ledger(), revision: 2, decisions: [{ ...decision(), reason: textRequest.reason }, { ...decision(), decisionId: conversationId, revision: 2, kind: "accepted" }] };
    await expect(transport(runtime, result).client.recordAgentTurnDecision!(conversationId, turnRequestId, textRequest)).resolves.toEqual(result);
  });
  it("rejects duplicate history and check identities", async () => {
    await expect(transport(runtime, { ...ledger(), revision: 2, decisions: [decision(), { ...decision(), revision: 2 }] }).client.getAgentTurnDecisions!(conversationId, turnRequestId)).rejects.toMatchObject({ code: "invalid_response" });
    const check = { runId: mutationId, checkId: "unit", status: "passed" };
    await expect(transport(runtime, { ...ledger(), revision: 1, decisions: [{ ...decision(), checks: [check, check] }] }).client.getAgentTurnDecisions!(conversationId, turnRequestId)).rejects.toMatchObject({ code: "invalid_response" });
  });

});
