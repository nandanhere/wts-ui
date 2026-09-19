import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceClient } from "../lib/wtsClient";
import type { AgentConversation, AgentConversationMessage } from "../lib/agentConversations";
import { newFeedbackDraft, readFeedbackShelf, saveFeedbackShelf } from "../lib/agentFeedbackDraft";
import { AgentFeedbackBubble } from "./AgentFeedbackBubble";
import userEvent from "@testing-library/user-event";
import { agentTurnChangesFixture, TURN_CONVERSATION_ID, TURN_REQUEST_ID, TURN_WORKSPACE_ID, TURN_SESSION_ID } from "../test/agentTurnChangesFixture";
import { RepositoryPatchViewer } from "../variants/local-workspace/RepositoryPatchViewer";
import { RETURN_FEEDBACK_SELECTION_EVENT } from "../lib/agentFeedbackNavigation";

const failure = "Codex exceeded the 15-minute limit. Review the saved changes before you continue.";
function setup(assistant: Partial<AgentConversationMessage> = {}, body = "") {
  let conversation: AgentConversation = { schemaVersion: 1, conversationId: "chat", workspaceId: "workspace", repositoryId: "repo", workspaceDisplayPath: "/work/wts",
    provider: "codex", source: { kind: "ui", route: "/", calloutId: "plan.title", label: "Plan title" }, revision: 2, createdAtUnixMs: 1, updatedAtUnixMs: 2,
    messages: [{ messageId: "user", requestId: "old-request", role: "user", body: "Fix the selected title", status: "failed", createdAtUnixMs: 1 },
      { messageId: "assistant", requestId: "old-request", role: "assistant", body: "Unverified provider output.\n".repeat(200), status: "failed", error: failure, createdAtUnixMs: 2, ...assistant }] };
  const draft = { ...newFeedbackDraft(conversation.source, body), conversationId: conversation.conversationId };
  saveFeedbackShelf({ version: 2, open: true, selectedId: draft.id, drafts: [draft] });
  const send = vi.fn(async (_id, request) => {
    conversation = { ...conversation, revision: conversation.revision + 1, messages: [...conversation.messages,
      { messageId: "follow-up", requestId: request.requestId, role: "user", body: request.body, status: "queued", createdAtUnixMs: 3, queuePosition: 1 }] };
    return conversation;
  });
  const client = { createAgentConversation: vi.fn(), sendAgentConversationMessage: send, getAgentConversation: vi.fn(async () => conversation),
    listAgentConversations: vi.fn(async () => ({ schemaVersion: 1, conversations: [conversation] })), stopAgentSession: vi.fn() } as unknown as WorkspaceClient;
  return { client, send, setConversation(next: AgentConversation) { conversation = next; }, get conversation() { return conversation; } };
}
beforeEach(() => localStorage.clear());
describe("agent task results", () => {
  it("reviews one result lazily with its original task identity and retains the unrelated composer", async () => {
    const user = userEvent.setup();
    const state = setup({ status: "completed", body: "The title changed.", error: undefined }, "Keep my next request.");
    const original = { ...state.conversation, conversationId: TURN_CONVERSATION_ID, workspaceId: TURN_WORKSPACE_ID, repositoryId: "repo-wts", messages: state.conversation.messages.map(message => ({ ...message, requestId: TURN_REQUEST_ID, sessionId: TURN_SESSION_ID })), preview: { url: "http://localhost:1420/original", repositoryId: "repo-wts" } };
    const other = { ...state.conversation, conversationId: "77777777-7777-4777-8777-777777777777", repositoryId: "other-repo", source: { kind: "ui" as const, route: "/other", calloutId: "other.panel", label: "Other panel" }, preview: { url: "http://localhost:1421/other", repositoryId: "other-repo" }, messages: [] };
    const draft = { ...newFeedbackDraft(other.source, "Keep my next request."), conversationId: other.conversationId };
    saveFeedbackShelf({ version: 2, open: true, selectedId: draft.id, drafts: [draft] });
    state.client.listAgentConversations = vi.fn().mockResolvedValue({ schemaVersion: 1, conversations: [original, other] });
    const getChanges = vi.fn().mockResolvedValue(agentTurnChangesFixture());
    state.client.getAgentTurnChanges = getChanges;
    render(<><RepositoryPatchViewer patch={agentTurnChangesFixture().patch} theme="light" /><AgentFeedbackBubble client={state.client} /></>);
    const originalSearch = screen.getByRole("searchbox", { name: "Search changed code" });
    const originalFocus = vi.spyOn(originalSearch, "focus");
    const result = (await screen.findByText("The title changed.")).closest("article")!;
    expect(getChanges).not.toHaveBeenCalled();
    expect(within(result).queryByRole("link", { name: "Open live preview" })).not.toBeInTheDocument();
    await user.click(within(result).getByRole("button", { name: "Review changes" }));
    const review = await screen.findByRole("dialog", { name: "Task changes" });
    expect(within(review).getByRole("link", { name: "Open live preview" })).toHaveAttribute("href", original.preview.url);
    await within(review).findByText("WTS recorded changes during this task.");
    expect(getChanges).toHaveBeenCalledExactlyOnceWith(TURN_CONVERSATION_ID, TURN_REQUEST_ID);
    expect(review).toHaveTextContent("Host checks");
    expect(review).toHaveTextContent("Some files had local changes before this task.");
    expect(within(review).queryByRole("button", { name: /Undo|Restore/ })).not.toBeInTheDocument();
    expect(within(review).queryByRole("button", { name: "Edit locally" })).not.toBeInTheDocument();
    await within(review).findByRole("searchbox", { name: "Search changed code" });
    await user.keyboard("{Control>}f{/Control}");
    expect(within(review).getByRole("searchbox", { name: "Search changed code" })).toHaveFocus();
    expect(originalFocus).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Task changes" })).not.toBeInTheDocument();
    expect(within(result).getByRole("button", { name: "Review changes" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep my next request.");
    expect(state.send).not.toHaveBeenCalled();
    const returned = vi.fn(); window.addEventListener(RETURN_FEEDBACK_SELECTION_EVENT, returned);
    try {
      await user.click(within(result).getByRole("button", { name: "Review changes" }));
      const reopened = await screen.findByRole("dialog", { name: "Task changes" });
      await user.click(within(reopened).getByRole("button", { name: "Return to selection" }));
      expect(returned).toHaveBeenCalledOnce();
      expect(returned.mock.calls[0][0].detail.source).toEqual(original.source);
      expect(screen.queryByRole("dialog", { name: "Task changes" })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: "Agent feedback" })).not.toBeInTheDocument();
      expect(readFeedbackShelf().drafts.find(item => item.id === draft.id)?.body).toBe("Keep my next request.");
      expect(state.send).not.toHaveBeenCalled();
    } finally { window.removeEventListener(RETURN_FEEDBACK_SELECTION_EVENT, returned); }
  });

  it("previews a current-origin UI result in WTS without replacing its draft", async () => {
    const state = setup({ status: "completed", body: "The UI changed.", error: undefined }, "Keep my draft.");
    state.setConversation({ ...state.conversation, preview: { url: `${window.location.origin}/preview`, repositoryId: "repo" } });
    const returned = vi.fn(); window.addEventListener(RETURN_FEEDBACK_SELECTION_EVENT, returned);
    try {
      render(<AgentFeedbackBubble client={state.client} />);
      fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
      fireEvent.click(await screen.findByRole("button", { name: "Return to selection" }));
      expect(returned.mock.calls[0][0].detail.source).toEqual(state.conversation.source);
      expect(screen.queryByRole("dialog", { name: "Agent feedback" })).not.toBeInTheDocument();
      expect(readFeedbackShelf().drafts.some(item => item.body === "Keep my draft.")).toBe(true);
      expect(state.send).not.toHaveBeenCalled();
    } finally { window.removeEventListener(RETURN_FEEDBACK_SELECTION_EVENT, returned); }
  });

  it("does not offer recorded changes for a running result or an unpaired legacy response", async () => {
    const state = setup({ status: "running", body: "", error: undefined });
    state.client.getAgentTurnChanges = vi.fn();
    render(<AgentFeedbackBubble client={state.client} />);
    await screen.findByText("Active");
    expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
    state.setConversation({ ...state.conversation, revision: 3, messages: [{ messageId: "legacy", requestId: "unpaired", role: "assistant", status: "completed", body: "Legacy reply", createdAtUnixMs: 3 }] });
    fireEvent.keyDown(screen.getByRole("button", { name: "Feedback options" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh tasks" }));
    await screen.findByText("Legacy reply");
    expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View local changes" })).toHaveAttribute("href", "/sessions/workspace/changes?repository=repo");
    expect(state.client.getAgentTurnChanges).not.toHaveBeenCalled();
  });

  it("keeps the exact failure above long unverified output with working recovery actions", async () => {
    const state = setup({ diagnostic: "Provider process exited with code 124." } as Partial<AgentConversationMessage>);
    const openChanges = vi.fn(); window.addEventListener("wts:open-agent-workspace", openChanges);
    try {
      render(<AgentFeedbackBubble client={state.client} />);
      const summary = (await screen.findByText(failure)).closest("article")!;
      expect(summary).toHaveTextContent("CodexFailed"); expect(summary).toHaveTextContent(failure);
      expect(screen.getByRole("log", { name: "Agent messages" })).toContainElement(summary);
      const output = screen.getByText(/Unverified provider output\./);
      expect(output.closest("details")).not.toHaveAttribute("open");
      expect(screen.getByText("Provider process exited with code 124.").closest("details")).not.toHaveAttribute("open");
      fireEvent.click(within(summary).getByRole("button", { name: "Review changes" }));
      fireEvent.click(screen.getByRole("link", { name: "View current local changes" }));
      expect(openChanges).toHaveBeenCalledOnce(); expect(openChanges.mock.calls[0][0].detail).toEqual({ workspaceId: "workspace", repositoryId: "repo" });
      expect(state.send).not.toHaveBeenCalled();
    } finally { window.removeEventListener("wts:open-agent-workspace", openChanges); }
  });
  it("focuses the failed result when a saved chat opens instead of scrolling to its composer", async () => {
    const state = setup(); render(<AgentFeedbackBubble client={state.client} />);
    expect((await screen.findByText(failure)).closest("article")).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).not.toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Close agent feedback" }));
    fireEvent.click(screen.getByRole("button", { name: "Open agent feedback" }));
    expect(screen.getByText(failure).closest("article")).toHaveFocus();
  });
  it("sends a continuation immediately without replacing an existing draft", async () => {
    const state = setup({}, "Keep the accessibility check."); render(<AgentFeedbackBubble client={state.client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(state.send).toHaveBeenCalledOnce());
    const input = screen.getByRole("textbox", { name: "Message to agent" }); expect(input).toHaveValue("Keep the accessibility check.");
    expect(state.send.mock.calls[0][1].body).toContain("Inspect the existing changes before you edit.");
    expect(state.send.mock.calls[0][1].body).toContain("Run the remaining checks.");
    expect(readFeedbackShelf().drafts.some(item => item.body === "Keep the accessibility check.")).toBe(true);
    expect(state.send.mock.calls[0][1].requestId).not.toBe("old-request");
  });
  it("separates progress from a completed final response", async () => {
    const state = setup({ status: "completed", body: "The title now uses the selected workspace name.", error: undefined,
      progress: "The agent reads the source.\n".repeat(200) } as Partial<AgentConversationMessage>);
    render(<AgentFeedbackBubble client={state.client} />);
    expect(await screen.findByText("The title now uses the selected workspace name.")).toBeVisible();
    const progress = screen.getByText(/The agent reads the source/);
    expect(progress.closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });
  it("keeps the composer focus when a running task fails during an edit", async () => {
    const state = setup({ status: "running", body: "", error: undefined });
    render(<AgentFeedbackBubble client={state.client} />);
    const input = await screen.findByRole("textbox", { name: "Message to agent" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "Keep my next request." } });
    state.setConversation({ ...state.conversation, revision: 3, messages: state.conversation.messages.map(message => ({ ...message, status: "failed", error: message.role === "assistant" ? failure : undefined })) });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await screen.findByText(failure);
    expect(input).toHaveFocus(); expect(input).toHaveValue("Keep my next request.");
  });
  it("shows current progress without presenting it as a final response", async () => {
    const state = setup({ status: "running", body: "", error: undefined, progress: "Checks the workspace tests." } as Partial<AgentConversationMessage>);
    render(<AgentFeedbackBubble client={state.client} />);
    expect(await screen.findByText("Checks the workspace tests.")).toBeInTheDocument();
    expect(screen.getByText("Checks the workspace tests.").closest("details")).not.toHaveAttribute("open");
    expect(screen.queryByText(failure)).not.toBeInTheDocument();
  });
  it("keeps an older failed message visible when a newer turn starts", async () => {
    const state = setup(); render(<AgentFeedbackBubble client={state.client} />); await screen.findByText(failure);
    state.setConversation({ ...state.conversation, revision: 3, activeSessionId: "active", messages: [...state.conversation.messages,
      { messageId: "new-assistant", role: "assistant", body: "", status: "running", createdAtUnixMs: 3 }] });
    fireEvent.keyDown(screen.getByRole("button", { name: "Feedback options" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh tasks" }));
    await screen.findByText("Active"); expect(screen.getByText(failure)).toBeVisible();
  });
  it("can continue a maximum-length request through its exact saved identity", async () => {
    const state = setup();
    state.setConversation({ ...state.conversation, messages: state.conversation.messages.map(message => message.role === "user" ? { ...message, body: "a".repeat(16_384) } : message) });
    render(<AgentFeedbackBubble client={state.client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(state.send).toHaveBeenCalledOnce()); expect(state.send.mock.calls[0][1].body).toContain("old-request");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("preserves a full unrelated draft when a continuation is sent", async () => {
    const body = "a".repeat(16_380); const state = setup({}, body); render(<AgentFeedbackBubble client={state.client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue(body);
    await waitFor(() => expect(state.send).toHaveBeenCalledOnce()); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
