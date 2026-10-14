import { describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentConversationSource } from "./agentConversations";
import { resolveFeedbackSelectionOrigin } from "./agentFeedbackNavigation";

const source: AgentConversationSource = { kind: "workItem", workSetId: "set", taskId: "task", label: "Option A", originConversationId: "origin", originRequestId: "request" };
function origin(overrides: Partial<AgentConversation> = {}): AgentConversation {
  return { schemaVersion: 1, conversationId: "origin", workspaceId: "workspace", repositoryId: "repository", workspaceDisplayPath: "/work", provider: "codex", revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 2,
    source: { kind: "ui", route: "/reviews", calloutId: "reviews.list", label: "Reviews" },
    messages: [
      { messageId: "user", requestId: "request", role: "user", status: "completed", body: "Change the layout.", createdAtUnixMs: 1 },
      { messageId: "assistant", requestId: "request", role: "assistant", status: "completed", body: "The layout changed.", createdAtUnixMs: 2 },
    ], ...overrides };
}

describe("isolated task selection origins", () => {
  it("resolves the saved parent request to its original UI or review selection", async () => {
    const ui = origin();
    const load = vi.fn().mockResolvedValue(ui);
    expect(await resolveFeedbackSelectionOrigin(source, load)).toEqual(ui.source);
    expect(load).toHaveBeenCalledExactlyOnceWith("origin");
    const review: AgentConversationSource = { kind: "gitlabDiscussion", workspaceId: "original-workspace", repositoryId: "original-repository", iid: 16, discussionId: "thread", comments: [] };
    load.mockResolvedValue(origin({ source: review }));
    expect(await resolveFeedbackSelectionOrigin(source, load)).toEqual(review);
  });

  it("rejects another conversation or a missing parent turn", async () => {
    for (const record of [origin({ conversationId: "different" }), origin({ messages: [] }), origin({ messages: [origin().messages[0]!] })]) {
      await expect(resolveFeedbackSelectionOrigin(source, vi.fn().mockResolvedValue(record))).rejects.toThrow("does not match");
    }
  });

  it("rejects a cycle and bounds nested origin reads", async () => {
    const repeated = vi.fn().mockResolvedValue(origin({ source }));
    await expect(resolveFeedbackSelectionOrigin(source, repeated)).rejects.toThrow("not valid");
    expect(repeated).toHaveBeenCalledTimes(1);
    let count = 0;
    const nested = vi.fn(async (conversationId: string) => origin({ conversationId, source: { ...source, originConversationId: `origin-${++count}` } as AgentConversationSource }));
    await expect(resolveFeedbackSelectionOrigin(source, nested)).rejects.toThrow("not valid");
    expect(nested).toHaveBeenCalledTimes(8);
  });
});
