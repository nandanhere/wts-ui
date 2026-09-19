import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "../lib/agentConversations";
import { newFeedbackDraft, readFeedbackShelf, saveFeedbackShelf } from "../lib/agentFeedbackDraft";
import type { WorkspaceClient } from "../lib/wtsClient";
import { openAgentFeedbackResult } from "../lib/agentFeedbackEvents";
import { AgentFeedbackBubble } from "./AgentFeedbackBubble";

function conversation(id: string): AgentConversation {
  return {
    schemaVersion: 1, conversationId: id, workspaceId: `workspace-${id}`, repositoryId: `repo-${id}`,
    workspaceDisplayPath: `/work/${id}`, provider: "codex", revision: 4, createdAtUnixMs: 1, updatedAtUnixMs: 4,
    source: { kind: "ui", route: "/", calloutId: "spaces.board", label: `Source ${id}` },
    messages: [
      { messageId: `${id}-user`, requestId: `${id}-request`, role: "user", status: "completed", body: `Request ${id}`, createdAtUnixMs: 1 },
      { messageId: `${id}-answer`, requestId: `${id}-request`, role: "assistant", status: "completed", body: `Exact result ${id}`, createdAtUnixMs: 2 },
      { messageId: `${id}-later-user`, requestId: `${id}-later-request`, role: "user", status: "completed", body: `Later request ${id}`, createdAtUnixMs: 3 },
      { messageId: `${id}-later-answer`, requestId: `${id}-later-request`, role: "assistant", status: "completed", body: `Later result ${id}`, createdAtUnixMs: 4 },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function jump(conversationId: string, requestId = `${conversationId}-request`, messageId?: string) {
  act(() => openAgentFeedbackResult({ conversationId, requestId, messageId }));
}
function setup() {
  const draft = newFeedbackDraft({ kind: "ui", route: "/settings", calloutId: "environment.settings", label: "My current settings draft" }, "Keep this unsent draft.");
  draft.queuedEdits = { "queued-message": { body: "Keep this queued edit.", expectedBody: "Original request" } };
  saveFeedbackShelf({ version: 2, open: false, selectedId: draft.id, drafts: [draft] });
  const get = vi.fn(async (id: string) => conversation(id));
  const send = vi.fn(); const create = vi.fn(); const decision = vi.fn();
  const client = { getAgentConversation: get, listAgentConversations: vi.fn(async () => ({ schemaVersion: 1, conversations: [] })),
    sendAgentConversationMessage: send, createAgentConversation: create, recordAgentTurnDecision: decision } as unknown as WorkspaceClient;
  return { client, get, send, create, decision, saved: readFeedbackShelf() };
}

beforeEach(() => { localStorage.clear(); vi.mocked(Element.prototype.scrollIntoView).mockClear(); });
afterEach(() => vi.restoreAllMocks());

describe("exact agent result navigation", () => {
  it("opens an older completed result without changing the composer, queued edits, or review state", async () => {
    const { client, get, send, create, decision, saved } = setup();
    render(<AgentFeedbackBubble client={client} />);
    jump("older", "older-request", "older-answer");
    const result = (await screen.findByText("Exact result older")).closest("article")!;
    await waitFor(() => expect(result).toHaveFocus());
    expect(result.scrollIntoView).toHaveBeenCalled();
    expect(screen.getByText("Later result older").closest("article")).not.toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this unsent draft.");
    expect(readFeedbackShelf()).toEqual({ ...saved, open: true });
    expect(get).toHaveBeenCalledWith("older");
    expect(send).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(decision).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("button", { name: "Feedback options" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh tasks" }));
    await waitFor(() => expect(client.listAgentConversations).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Exact result older")).toBeVisible();
  });

  it("keeps the latest requested result when an earlier lookup finishes last", async () => {
    const { client, get } = setup(); const first = deferred<AgentConversation>(); const second = deferred<AgentConversation>();
    get.mockImplementation(id => id === "first" ? first.promise : second.promise);
    render(<AgentFeedbackBubble client={client} />);
    jump("first"); jump("second");
    await act(async () => second.resolve(conversation("second")));
    const result = (await screen.findByText("Exact result second")).closest("article")!;
    await waitFor(() => expect(result).toHaveFocus());
    await act(async () => first.resolve(conversation("first")));
    expect(screen.queryByText("Exact result first")).not.toBeInTheDocument();
    expect(result).toHaveFocus();
  });

  it.each(["conversation", "message", "status"])("rejects a mismatched %s and offers a read retry without sending", async mismatch => {
    const { client, get, send } = setup();
    const value = conversation("target");
    if (mismatch === "conversation") value.conversationId = "wrong";
    if (mismatch === "message") value.messages[1]!.messageId = "different-answer";
    if (mismatch === "status") value.messages[1]!.status = "running";
    get.mockResolvedValueOnce(value);
    render(<AgentFeedbackBubble client={client} />);
    jump("target", "target-request", "target-answer");
    expect(await screen.findByRole("alert")).toHaveTextContent("saved result");
    expect(screen.queryByText("Exact result target")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry result" }));
    expect(await screen.findByText("Exact result target")).toBeVisible();
    expect(send).not.toHaveBeenCalled();
  });

  it("does not reopen or focus a result after the user closes the transcript", async () => {
    const { client, get } = setup(); const pending = deferred<AgentConversation>(); get.mockReturnValue(pending.promise);
    render(<AgentFeedbackBubble client={client} />);
    jump("target");
    fireEvent.click(await screen.findByRole("button", { name: "Close agent feedback" }));
    await act(async () => pending.resolve(conversation("target")));
    expect(screen.queryByRole("dialog", { name: "Agent feedback" })).not.toBeInTheDocument();
    expect(screen.queryByText("Exact result target")).not.toBeInTheDocument();
  });

  it("does not take focus from the composer when a background task list arrives after a result error", async () => {
    const { client, get } = setup();
    const list = deferred<{ schemaVersion: 1; conversations: AgentConversation[] }>();
    client.listAgentConversations = vi.fn(() => list.promise);
    get.mockRejectedValueOnce(new Error("The saved result is offline."));
    render(<AgentFeedbackBubble client={client} />);
    jump("target");
    await screen.findByRole("alert");
    const composer = screen.getByRole("textbox", { name: "Message to agent" }); composer.focus();
    await act(async () => list.resolve({ schemaVersion: 1, conversations: [conversation("background")] }));
    expect(composer).toHaveFocus();
  });

  it("does not install a previous client's result after the connection changes", async () => {
    const first = setup(); const pending = deferred<AgentConversation>(); first.get.mockReturnValue(pending.promise);
    const view = render(<AgentFeedbackBubble client={first.client} />);
    jump("first");
    const second = setup(); view.rerender(<AgentFeedbackBubble client={second.client} />);
    jump("second");
    const result = (await screen.findByText("Exact result second")).closest("article")!;
    await act(async () => pending.resolve(conversation("first")));
    expect(result).toHaveFocus();
    expect(screen.queryByText("Exact result first")).not.toBeInTheDocument();
  });

  it("does not create or select a composer draft when opening a result from an empty shelf", async () => {
    const { client } = setup(); saveFeedbackShelf({ version: 2, open: false, drafts: [] });
    render(<AgentFeedbackBubble client={client} />);
    jump("target");
    expect(await screen.findByText("Exact result target")).toBeVisible();
    expect(readFeedbackShelf()).toEqual({ version: 2, open: true, drafts: [] });
    expect(screen.queryByRole("textbox", { name: "Message to agent" })).not.toBeInTheDocument();
  });
});
