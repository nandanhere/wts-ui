import { describe, expect, it } from "vitest";
import type { AgentConversation, AgentConversationMessage } from "./agentConversations";
import { buildFeedbackTimeline } from "./agentFeedbackTimeline";

function message(id: string, role: AgentConversationMessage["role"], time: number, patch: Partial<AgentConversationMessage> = {}): AgentConversationMessage {
  return { messageId: id, role, body: id, status: "completed", createdAtUnixMs: time, ...patch };
}
function conversation(id: string, messages: AgentConversationMessage[], workspaceId = "wts"): AgentConversation {
  return { schemaVersion: 1, conversationId: id, workspaceId, repositoryId: "repo", workspaceDisplayPath: "/work/wts", provider: "codex", revision: 1,
    createdAtUnixMs: 1, updatedAtUnixMs: 1, source: { kind: "ui", route: "/", calloutId: id, label: id }, messages };
}

describe("one feedback transcript", () => {
  it("keeps replies with their requests across contexts and moves queued work into the transcript at dispatch", () => {
    const first = conversation("description", [message("one", "user", 10, { requestId: "r1" }), message("reply-one", "assistant", 11, { requestId: "r1" })]);
    const second = conversation("toolbar", [message("two", "user", 12, { requestId: "r2", status: "queued", queuePosition: 1 })]);
    const later = conversation("review", [message("three", "user", 20, { requestId: "r3" }), message("reply-three", "assistant", 21, { requestId: "r3" })]);
    const waiting = buildFeedbackTimeline([later, second, first]);
    expect(waiting.timeline.map(row => row.message.messageId)).toEqual(["one", "reply-one", "three", "reply-three"]);
    expect(waiting.queued.map(row => row.message.messageId)).toEqual(["two"]);
    const dispatched = { ...second, messages: [{ ...second.messages[0], status: "running" as const }, message("reply-two", "assistant", 30, { requestId: "r2", status: "running" })] };
    const active = buildFeedbackTimeline([dispatched, first, later]);
    expect(active.timeline.map(row => row.message.messageId)).toEqual(["one", "reply-one", "three", "reply-three", "two", "reply-two"]);
    expect(active.queued).toEqual([]);
  });

  it("retains each message's original conversation and pairs legacy responses without crossing context boundaries", () => {
    const ui = conversation("ui", [message("same", "user", 1), message("old-answer", "assistant", 2, { status: "failed" })]);
    const mr = conversation("mr", [message("same", "user", 3, { requestId: "mr-request" }), message("answer", "assistant", 4, { requestId: "mr-request" })]);
    const rows = buildFeedbackTimeline([mr, ui]).timeline;
    expect(rows.map(row => row.key)).toEqual(["ui/same", "ui/old-answer", "mr/same", "mr/answer"]);
    expect(rows[1].request).toBe(ui.messages[0]);
    expect(rows[3].request).toBe(mr.messages[0]);
    expect(rows[3].conversation).toBe(mr);
  });

  it("does not assign an explicitly unmatched response to another request", () => {
    const chat = conversation("ui", [message("one", "user", 1, { requestId: "one" }), message("orphan", "assistant", 2, { requestId: "missing" })]);
    expect(buildFeedbackTimeline([chat]).timeline[1].request).toBeUndefined();
  });

  it("uses host queue positions within each workspace without mixing workspace-local sequence numbers", () => {
    const one = conversation("one", [message("q2", "user", 1, { status: "queued", queuePosition: 2, queueSequence: 20 })]);
    const two = conversation("two", [message("q1", "user", 2, { status: "queued", queuePosition: 1, queueSequence: 10 })]);
    const other = conversation("other", [message("other-q1", "user", 3, { status: "queued", queuePosition: 1, queueSequence: 1 })], "other-workspace");
    expect(buildFeedbackTimeline([other, one, two]).queued.map(row => row.key)).toEqual(["two/q1", "one/q2", "other/other-q1"]);
  });

  it("keeps cancelled requests in history and does not change stored messages or input order", () => {
    const cancelled = conversation("cancelled", [message("cancelled", "user", 1, { status: "cancelled" })]);
    const waiting = conversation("waiting", [message("queued", "user", 2, { status: "queued" })]);
    const input = [waiting, cancelled];
    const original = JSON.stringify(input);
    expect(buildFeedbackTimeline(input).timeline.map(row => row.message.status)).toEqual(["cancelled"]);
    expect(JSON.stringify(input)).toBe(original);
  });
});
