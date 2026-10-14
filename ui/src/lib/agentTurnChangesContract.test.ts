import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";
import { agentTurnChangesFixture, TURN_CONVERSATION_ID, TURN_REQUEST_ID } from "../test/agentTurnChangesFixture";

function transport(runtime: "http" | "tauri", result: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => new Response(JSON.stringify(
    String(url).endsWith("/bootstrap") ? { sessionToken: "test-session" } : result,
  ), { status: 200, headers: { "Content-Type": "application/json" } }));
  const invoke = vi.fn(async () => result);
  return { fetch, invoke, client: createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> }) };
}

describe.each(["http", "tauri"] as const)("agent turn changes over %s", (runtime) => {
  it("reads the exact task receipt through the authenticated boundary", async () => {
    const result = agentTurnChangesFixture();
    const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.getAgentTurnChanges!(TURN_CONVERSATION_ID, TURN_REQUEST_ID)).resolves.toEqual(result);
    if (runtime === "http") {
      expect(fetch.mock.calls[1]).toEqual([
        `/api/v1/agent-conversations/${TURN_CONVERSATION_ID}/messages/${TURN_REQUEST_ID}/changes`,
        expect.objectContaining({ headers: expect.objectContaining({ "X-WTS-Session": "test-session" }) }),
      ]);
      expect(invoke).not.toHaveBeenCalled();
    } else {
      expect(invoke).toHaveBeenCalledExactlyOnceWith("get_agent_turn_changes", { conversationId: TURN_CONVERSATION_ID, requestId: TURN_REQUEST_ID });
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each(["capturing", "incomplete", "unavailable"] as const)("accepts %s observations without invented checkpoints", async (state) => {
    const result = agentTurnChangesFixture({ state, before: undefined, after: undefined, completedAtUnixMs: undefined, files: [], patch: "" });
    await expect(transport(runtime, result).client.getAgentTurnChanges!(TURN_CONVERSATION_ID, TURN_REQUEST_ID)).resolves.toEqual(result);
  });

  it.each([
    ["wrong conversation", { conversationId: TURN_REQUEST_ID }],
    ["wrong request", { requestId: TURN_CONVERSATION_ID }],
    ["wrong schema", { schemaVersion: 2 }],
    ["invalid session", { sessionId: "session" }],
    ["invalid workspace", { workspaceId: "workspace" }],
    ["empty repository", { repositoryId: "" }],
    ["invalid source digest", { sourceContextSha256: "c".repeat(64) }],
    ["unknown state", { state: "complete" }],
    ["unknown observation", { observation: "agentReported" }],
    ["negative start", { startedAtUnixMs: -1 }],
    ["fractional completion", { completedAtUnixMs: 1.1 }],
    ["missing ready baseline", { before: undefined }],
    ["missing ready result", { after: undefined }],
    ["null checkpoint", { before: null }],
    ["negative omitted count", { omittedFileCount: -1 }],
    ["invalid patch flag", { patchTruncated: "false" }],
    ["oversized UTF-8 detail", { detail: "😀".repeat(513) }],
    ["oversized UTF-8 patch", { patch: "😀".repeat(262145) }],
    ["NUL patch", { patch: "unsafe\0text" }],
    ["non-array files", { files: {} }],
    ["too many files", { files: Array.from({ length: 2049 }, (_, index) => ({ filePath: `${index}.ts`, status: "added", preExistingChange: false, undoSupported: false })) }],
  ])("rejects %s at the response boundary", async (_label, change) => {
    await expect(transport(runtime, { ...agentTurnChangesFixture(), ...(change as object) }).client.getAgentTurnChanges!(TURN_CONVERSATION_ID, TURN_REQUEST_ID)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { checkpointId: "checkpoint" }, { headCommitOid: "A".repeat(40) }, { branchName: null },
    { capturedAtUnixMs: Number.MAX_SAFE_INTEGER + 1 }, { treeSha256: "a".repeat(64) }, { indexSha256: "sha256:short" },
  ])("rejects malformed checkpoint fields %j", async (change) => {
    const result = agentTurnChangesFixture();
    await expect(transport(runtime, { ...result, after: { ...result.after, ...change } }).client.getAgentTurnChanges!(TURN_CONVERSATION_ID, TURN_REQUEST_ID)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it.each([
    { filePath: "" }, { filePath: "😀".repeat(1025) }, { status: "renamed" }, { beforeSha256: "bad" },
    { afterSha256: null }, { preExistingChange: 1 }, { undoSupported: true }, { detail: "😀".repeat(513) },
  ])("rejects malformed file fields %j", async (change) => {
    const result = agentTurnChangesFixture();
    await expect(transport(runtime, { ...result, files: [{ ...result.files[0], ...change }] }).client.getAgentTurnChanges!(TURN_CONVERSATION_ID, TURN_REQUEST_ID)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("accepts exact UTF-8 bounds and future optional metadata without changing text", async () => {
    const result = { ...agentTurnChangesFixture({ detail: "😀".repeat(512), patch: "😀".repeat(262144) }), futureMetadata: { value: true } };
    await expect(transport(runtime, result).client.getAgentTurnChanges!(TURN_CONVERSATION_ID, TURN_REQUEST_ID)).resolves.toEqual(result);
  });

  it("rejects duplicate file identities", async () => {
    const result = agentTurnChangesFixture(); result.files.push(result.files[0]);
    await expect(transport(runtime, result).client.getAgentTurnChanges!(TURN_CONVERSATION_ID, TURN_REQUEST_ID)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects invalid IDs before transport", async () => {
    const { client, fetch, invoke } = transport(runtime, agentTurnChangesFixture());
    for (const value of ["", "../another", "not-a-uuid"]) {
      await expect(client.getAgentTurnChanges!(value, TURN_REQUEST_ID)).rejects.toBeDefined();
      await expect(client.getAgentTurnChanges!(TURN_CONVERSATION_ID, value)).rejects.toBeDefined();
    }
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
});
