import { describe, expect, it, vi } from "vitest";
import { createWorkspaceClient, type WorkspaceClientOptions } from "./wtsClient";
import type { AgentConversation, CreateAgentConversationRequest } from "./agentConversations";

export const conversationFixture = (): AgentConversation => ({
  schemaVersion: 1, conversationId: "chat/+one", workspaceId: "workspace", repositoryId: "local-repo",
  workspaceDisplayPath: "/work/wts", provider: "codex", revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 1,
  source: { kind: "ui", route: "/sessions/workspace", calloutId: "plan.description", label: "Plan description" }, messages: [],
});
function transport(runtime: "http" | "tauri", result: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url) => new Response(JSON.stringify(
    String(url).endsWith("/bootstrap") ? { sessionToken: "session-123" } : result,
  ), { status: 200, headers: { "Content-Type": "application/json" } }));
  const invoke = vi.fn(async () => result);
  return { fetch, invoke, client: createWorkspaceClient({ runtime, fetch, invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]> }) };
}
describe.each(["http", "tauri"] as const)("agent conversations over %s", (runtime) => {
  it("creates, resumes, and sends through the exact authenticated conversation route", async () => {
    const result = conversationFixture();
    const { client, invoke, fetch } = transport(runtime, result);
    const request: CreateAgentConversationRequest = { requestId: result.conversationId, provider: "codex", source: result.source };
    await expect(client.createAgentConversation!(request)).resolves.toEqual(result);
    await expect(client.getAgentConversation!(result.conversationId)).resolves.toEqual(result);
    const message = { requestId: "message-id", body: "Keep **all** the source context.\nThen fix the parser." };
    result.messages.push({ messageId: "user", requestId: message.requestId, body: message.body, role: "user", status: "pending", createdAtUnixMs: 2 });
    await expect(client.sendAgentConversationMessage!(result.conversationId, message)).resolves.toEqual(result);
    if (runtime === "tauri") {
      expect(invoke.mock.calls).toEqual([
        ["create_agent_conversation", { request }], ["get_agent_conversation", { conversationId: result.conversationId }],
        ["send_agent_conversation_message", { conversationId: result.conversationId, request: message }],
      ]);
      expect(fetch).not.toHaveBeenCalled();
    } else {
      expect(fetch.mock.calls.slice(1).map(([url]) => url)).toEqual([
        "/api/v1/agent-conversations", "/api/v1/agent-conversations/chat%2F%2Bone", "/api/v1/agent-conversations/chat%2F%2Bone/messages",
      ]);
      expect(fetch.mock.calls[3][1]).toMatchObject({ method: "POST", body: JSON.stringify(message), headers: { "X-WTS-Session": "session-123" } });
    }
  });
  it("rejects another conversation, wrong source, and non-local preview before rendering", async () => {
    await expect(transport(runtime, conversationFixture()).client.getAgentConversation!("different")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(transport(runtime, { ...conversationFixture(), preview: { url: "https://evil.test", repositoryId: "local-repo" } }).client.getAgentConversation!("chat/+one")).rejects.toMatchObject({ code: "invalid_response" });
    await expect(transport(runtime, conversationFixture()).client.createAgentConversation!({ requestId: "id", provider: "codex", source: { kind: "ui", label: "Other", calloutId: "different", route: "/" } })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("keeps full assistant replies and lists durable conversations", async () => {
    const result = conversationFixture(); result.messages = [{ messageId: "reply", role: "assistant", status: "completed", createdAtUnixMs: 2, body: "Complete reply.\n".repeat(900) }];
    await expect(transport(runtime, { schemaVersion: 1, conversations: [result] }).client.listAgentConversations!()).resolves.toEqual({ schemaVersion: 1, conversations: [result] });
  });
  it("retains separate progress and diagnostics and rejects invalid provider text", async () => {
    const result = conversationFixture();
    const message = { messageId: "reply", role: "assistant", status: "failed", createdAtUnixMs: 2, body: "", progress: "Checks the source", diagnostic: "Provider exited with code 124." };
    await expect(transport(runtime, { ...result, messages: [message] }).client.getAgentConversation!(result.conversationId)).resolves.toMatchObject({ messages: [message] });
    for (const [field, max] of [["progress", 65_536], ["diagnostic", 16_384]] as const) {
      await expect(transport(runtime, { ...result, messages: [{ ...message, [field]: "😀".repeat(max / 4) }] }).client.getAgentConversation!(result.conversationId)).resolves.toBeDefined();
    }
    for (const [field, max] of [["progress", 65_536], ["diagnostic", 16_384]] as const) for (const value of [42, null, " ", "invalid\0text", "😀".repeat(max / 4 + 1)]) {
      await expect(transport(runtime, { ...result, messages: [{ ...message, [field]: value }] }).client.getAgentConversation!(result.conversationId)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("rejects blank and oversized messages without a transport call", async () => {
    const { client, fetch, invoke } = transport(runtime, conversationFixture());
    for (const body of [" ", "😀".repeat(16_385)]) await expect(client.sendAgentConversationMessage!("chat", { requestId: "id", body })).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it("rejects a creation for another request or changed quoted context", async () => {
    const result = conversationFixture();
    await expect(transport(runtime, result).client.createAgentConversation!({ requestId: "different-request", provider: "codex", source: result.source })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(transport(runtime, result).client.createAgentConversation!({ requestId: result.conversationId, provider: "codex", source: { ...result.source, selectedText: "Another selected text" } as typeof result.source })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects a send response that does not contain the accepted exact message", async () => {
    const result = conversationFixture();
    const request = { requestId: "message", body: "Preserve this exact request" };
    await expect(transport(runtime, result).client.sendAgentConversationMessage!(result.conversationId, request)).rejects.toMatchObject({ code: "invalid_response" });
    result.messages = [{ messageId: "user", requestId: request.requestId, role: "user", body: "Different body", status: "pending", createdAtUnixMs: 2 }];
    await expect(transport(runtime, result).client.sendAgentConversationMessage!(result.conversationId, request)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("accepts a durable queued request while another turn is active", async () => {
    const result = conversationFixture();
    const request = { requestId: "next-fix", body: "Fix the other selected issue after this task." };
    const queued = { ...result, activeSessionId: "active-turn", messages: [
      { messageId: "active", role: "assistant", body: "The agent checks the source.", status: "running", createdAtUnixMs: 1 },
      { messageId: "next", role: "user", ...request, status: "queued", createdAtUnixMs: 2 },
    ] };
    await expect(transport(runtime, queued).client.sendAgentConversationMessage!(result.conversationId, request)).resolves.toEqual(queued);
  });
  it("edits and cancels the exact queued message with its saved request identity", async () => {
    const result = conversationFixture();
    const original = "Fix the selected parser.";
    const edit = { requestId: "edit-id", expectedBody: original, body: "Fix the parser and check nested lists." };
    result.messages = [{ messageId: "message/+queued", requestId: "send-id", role: "user", body: edit.body,
      submittedBody: original, status: "queued", queueSequence: 5, queuePosition: 2, lastMutationRequestId: edit.requestId, createdAtUnixMs: 2 }];
    const { client, fetch, invoke } = transport(runtime, result);
    await expect(client.updateAgentConversationMessage!(result.conversationId, result.messages[0].messageId, edit)).resolves.toEqual(result);
    const cancel = { requestId: "cancel-id", expectedBody: edit.body };
    result.messages[0] = { ...result.messages[0], status: "cancelled", queuePosition: undefined, lastMutationRequestId: cancel.requestId };
    await expect(client.cancelAgentConversationMessage!(result.conversationId, result.messages[0].messageId, cancel)).resolves.toEqual(result);
    if (runtime === "tauri") {
      expect(invoke.mock.calls).toEqual([
        ["update_agent_conversation_message", { conversationId: result.conversationId, messageId: "message/+queued", request: edit }],
        ["cancel_agent_conversation_message", { conversationId: result.conversationId, messageId: "message/+queued", request: cancel }],
      ]);
    } else {
      expect(fetch.mock.calls[1]).toEqual([
        "/api/v1/agent-conversations/chat%2F%2Bone/messages/message%2F%2Bqueued",
        expect.objectContaining({ method: "PATCH", body: JSON.stringify(edit), headers: expect.objectContaining({ "X-WTS-Session": "session-123" }) }),
      ]);
      expect(fetch.mock.calls[2]).toEqual([
        "/api/v1/agent-conversations/chat%2F%2Bone/messages/message%2F%2Bqueued/cancel",
        expect.objectContaining({ method: "POST", body: JSON.stringify(cancel), headers: expect.objectContaining({ "X-WTS-Session": "session-123" }) }),
      ]);
    }
  });
  it("reconciles a send retry after the accepted queued body changes", async () => {
    const result = conversationFixture();
    const request = { requestId: "original-send", body: "Original instructions" };
    result.messages = [{ messageId: "queued", requestId: request.requestId, role: "user", status: "queued",
      body: "Revised instructions", submittedBody: request.body, createdAtUnixMs: 2 }];
    await expect(transport(runtime, result).client.sendAgentConversationMessage!(result.conversationId, request)).resolves.toEqual(result);
    result.messages[0].submittedBody = "Another original request";
    await expect(transport(runtime, result).client.sendAgentConversationMessage!(result.conversationId, request)).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects mismatched mutation receipts and a cancellation that did not take effect", async () => {
    const result = conversationFixture();
    const edit = { requestId: "edit", expectedBody: "Before", body: "After" };
    result.messages = [{ messageId: "target", role: "user", body: edit.body, status: "queued", createdAtUnixMs: 1, lastMutationRequestId: "different-edit" }];
    await expect(transport(runtime, result).client.updateAgentConversationMessage!(result.conversationId, "target", edit)).rejects.toMatchObject({ code: "invalid_response" });
    result.messages[0].lastMutationRequestId = edit.requestId;
    await expect(transport(runtime, result).client.updateAgentConversationMessage!(result.conversationId, "other-message", edit)).rejects.toMatchObject({ code: "invalid_response" });
    result.messages[0].body = "Unexpected change";
    await expect(transport(runtime, result).client.updateAgentConversationMessage!(result.conversationId, "target", edit)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(transport(runtime, result).client.cancelAgentConversationMessage!(result.conversationId, "target", { requestId: "edit", expectedBody: "Unexpected change" })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects invalid edits and cancel comparisons before transport", async () => {
    const { client, fetch, invoke } = transport(runtime, conversationFixture());
    for (const body of [" ", "😀".repeat(16_385)]) {
      await expect(client.updateAgentConversationMessage!("chat", "message", { requestId: "edit", expectedBody: "Before", body })).rejects.toBeDefined();
      await expect(client.cancelAgentConversationMessage!("chat", "message", { requestId: "cancel", expectedBody: body })).rejects.toBeDefined();
    }
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
  it("keeps pending work beyond the old fifty-chat history limit", async () => {
    const conversations = Array.from({ length: 64 }, (_, index) => ({ ...conversationFixture(), conversationId: `queued-${index}` }));
    await expect(transport(runtime, { schemaVersion: 1, conversations }).client.listAgentConversations!()).resolves.toMatchObject({ conversations });
  });
  it("rejects invalid queue metadata rather than showing the wrong state", async () => {
    const result = conversationFixture();
    for (const extra of [{ queuePosition: -1 }, { queueSequence: 0 }, { status: "running", queuePosition: 1 }, { role: "assistant" }]) {
      const payload = { ...result, messages: [{ messageId: "queued", role: "user", body: "Request", status: "queued", createdAtUnixMs: 1, ...extra }] };
      await expect(transport(runtime, payload).client.getAgentConversation!(result.conversationId)).rejects.toMatchObject({ code: "invalid_response" });
    }
  });
  it("preserves the original MR position and rejects invalid commit identities", async () => {
    const result = conversationFixture();
    result.source = { kind: "gitlabDiscussion", workspaceId: result.workspaceId, repositoryId: result.repositoryId,
      providerRepositoryId: "gitlab-repo", iid: 16, discussionId: "thread", filePath: "src/code.go", line: 55,
      position: { baseCommitOid: "a".repeat(40), startCommitOid: "b".repeat(40), headCommitOid: "c".repeat(40) },
      comments: [{ id: 42, authorLogin: "reviewer", body: "Use a guard here", createdAt: "2026-09-18" }] };
    await expect(transport(runtime, result).client.createAgentConversation!({ requestId: result.conversationId, provider: "codex", source: result.source })).resolves.toEqual(result);
    result.source.position!.headCommitOid = "current-local-head";
    const { client, invoke, fetch } = transport(runtime, result);
    await expect(client.createAgentConversation!({ requestId: result.conversationId, provider: "codex", source: result.source })).rejects.toMatchObject({ code: "invalid_response" });
    expect(invoke).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

it("captures only through the native webview command and rejects an invalid image result", async () => {
  const request = { rect: { x: 10, y: 20, width: 100, height: 60 }, viewport: { width: 1000, height: 800, devicePixelRatio: 2 } };
  const result = { mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 100, height: 60 };
  const { client, invoke } = transport("tauri", result);
  await expect(client.captureUiRegion!(request)).resolves.toEqual(result);
  expect(invoke.mock.calls).toEqual([["capture_ui_region", { request }]]);
  expect(transport("http", result).client.captureUiRegion).toBeUndefined();
  await expect(transport("tauri", { ...result, dataUrl: "https://example.test/image.png" }).client.captureUiRegion!(request)).rejects.toMatchObject({ code: "invalid_response" });
});
