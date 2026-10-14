import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "../lib/agentConversations";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
import { newFeedbackDraft, readFeedbackShelf, saveFeedbackShelf } from "../lib/agentFeedbackDraft";
import { AgentFeedbackBubble } from "./AgentFeedbackBubble";
import userEvent from "@testing-library/user-event";
function record(id: string, at: number): AgentConversation { return { schemaVersion: 1, conversationId: id, workspaceId: "workspace", repositoryId: id, workspaceDisplayPath: "/work", provider: "codex", revision: 1, createdAtUnixMs: at, updatedAtUnixMs: at,
  source: { kind: "ui", route: "/", calloutId: id, label: id }, messages: [
    { messageId: `${id}-user`, requestId: `${id}-request`, role: "user", body: `Fix ${id}`, status: "failed", createdAtUnixMs: at },
    { messageId: `${id}-reply`, requestId: `${id}-request`, role: "assistant", body: "", error: `${id} failed`, status: "failed", createdAtUnixMs: at + 1 }] }; }
function setup() {
  const records = new Map([["First", record("First", 1)], ["Second", record("Second", 3)]]);
  const draft = { ...newFeedbackDraft(records.get("Second")!.source, "Keep this unrelated draft."), conversationId: "Second" };
  saveFeedbackShelf({ version: 2, open: true, selectedId: draft.id, drafts: [draft] });
  const send = vi.fn(async (id: string, request: { requestId: string; body: string }) => {
    const current = records.get(id)!; const next = { ...current, revision: current.revision + 1, messages: [...current.messages,
      { messageId: request.requestId, requestId: request.requestId, role: "user" as const, body: request.body, status: "queued" as const, createdAtUnixMs: 10, queuePosition: 1 }] };
    records.set(id, next); return next;
  });
  const client = { createAgentConversation: vi.fn(), sendAgentConversationMessage: send, listAgentConversations: vi.fn(async () => ({ schemaVersion: 1, conversations: [...records.values()].reverse() })),
    getAgentConversation: vi.fn(async (id: string) => records.get(id)), stopAgentSession: vi.fn() } as unknown as WorkspaceClient;
  return { client, send, records };
}
function failedArticle(text: string) { return screen.getByText(text).closest("article")!; }
beforeEach(() => localStorage.clear());
describe("one feedback transcript", () => {
  it("keeps only review and retry beside a failed result and shows a fixed provider as text", async () => {
    const { client, records } = setup();
    const first = records.get("First")!;
    records.set("First", { ...first, preview: { url: `${window.location.origin}/preview`, repositoryId: first.repositoryId } });
    render(<AgentFeedbackBubble client={client} />);
    const result = (await screen.findByText("First failed")).closest("article")!;
    expect(within(result).getAllByRole("button").map(button => button.textContent)).toEqual(["Review changes", "Retry"]);
    expect(within(result).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Feedback agent" })).not.toBeInTheDocument();
    expect(screen.getByText("Codex", { selector: "footer span" })).toBeVisible();
    expect(screen.queryByText("0 active · 0 queued")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Saved drafts/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this unrelated draft.");
    expect(client.sendAgentConversationMessage).not.toHaveBeenCalled();
  });

  it("uses the options menu with keyboard Escape and discards only the current draft", async () => {
    const user = userEvent.setup(); const { client, records } = setup(); const shelf = readFeedbackShelf();
    const other = { ...newFeedbackDraft(records.get("First")!.source, "Keep the other draft."), conversationId: "First" };
    saveFeedbackShelf({ ...shelf, drafts: [...shelf.drafts, other] });
    render(<AgentFeedbackBubble client={client} />); await screen.findByText("First failed");
    const trigger = screen.getByRole("button", { name: "Feedback options" });
    trigger.focus(); await user.keyboard("{Enter}");
    expect(await screen.findByRole("menuitem", { name: "Refresh tasks" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Agent feedback" })).toBeVisible();
    expect(trigger).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitem", { name: "Discard current draft" }));
    expect(readFeedbackShelf().drafts.find(item => item.id === shelf.selectedId)?.body).toBe("");
    expect(readFeedbackShelf().drafts.find(item => item.id === other.id)?.body).toBe("Keep the other draft.");
    expect(client.sendAgentConversationMessage).not.toHaveBeenCalled();
  });

  it.each([
    "The provider stopped with exit code 1. Review the diagnostic details and local changes before you continue from saved work.",
    "The agent turn stopped or failed. Check the provider and review the files before you retry.",
  ])("keeps generic failure details available without repeating %s", async original => {
    const { client, records } = setup(); const first = records.get("First")!;
    records.set("First", { ...first, messages: first.messages.map(message => message.role === "assistant" ? { ...message, error: original } : message) });
    render(<AgentFeedbackBubble client={client} />);
    expect(await screen.findByText("The agent stopped before it finished.")).toBeVisible();
    const details = screen.getByText(original).closest("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(within(details).getByText("Details"));
    expect(screen.getByText(original)).toBeVisible();
    expect(screen.getByText("Second failed")).toBeVisible();
  });

  it("groups failed progress, unverified output, and diagnostics in one disclosure", async () => {
    const { client, records } = setup(); const first = records.get("First")!;
    records.set("First", { ...first, messages: first.messages.map(message => message.role === "assistant" ? { ...message, progress: "Read the title component.", body: "The provider reported a possible edit.", diagnostic: "Process exited with code 1." } : message) });
    render(<AgentFeedbackBubble client={client} />);
    const result = (await screen.findByText("First failed")).closest("article")!;
    expect([...result.querySelectorAll("summary")].map(summary => summary.textContent)).toEqual(["Details"]);
    const disclosure = result.querySelector("details")!;
    expect(disclosure).not.toHaveAttribute("open");
    fireEvent.click(within(disclosure).getByText("Details"));
    expect(within(disclosure).getByText("Read the title component.")).toBeVisible();
    expect(within(disclosure).getByText("Unverified provider output")).toBeVisible();
    expect(within(disclosure).getByText("The provider reported a possible edit.")).toBeVisible();
    expect(within(disclosure).getByText("Process exited with code 1.")).toBeVisible();
  });

  it("shows each user state once and gives queued text room beside compact named actions", async () => {
    const { client, records } = setup();
    const first = records.get("First")!;
    records.set("First", { ...first, messages: [...first.messages, { messageId: "queued-polish", requestId: "queued-request", role: "user", body: "Keep the complete request readable beside its actions.", status: "queued", createdAtUnixMs: 8, queuePosition: 1 }] });
    render(<AgentFeedbackBubble client={client} />);
    const request = (await screen.findByText("Fix First")).closest("article")!;
    expect(within(request).getAllByText(/Failed/)).toHaveLength(1);
    const queue = screen.getByRole("region", { name: "Queued requests" });
    expect(within(queue).getByRole("button", { name: "Edit queued request" })).toHaveTextContent(/^Edit$/);
    expect(within(queue).getByRole("button", { name: "Cancel request" })).toHaveTextContent(/^Cancel$/);
    fireEvent.click(within(queue).getByRole("button", { name: "Edit queued request" }));
    expect(within(queue).getByRole("textbox", { name: "Queued request" })).toHaveValue("Keep the complete request readable beside its actions.");
    expect(within(queue).getByRole("textbox", { name: "Queued request" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this unrelated draft.");
  });

  it("closes Saved drafts with Escape or a selection while keeping the chat and both texts", async () => {
    const { client, records } = setup();
    const shelf = readFeedbackShelf();
    const other = { ...newFeedbackDraft(records.get("First")!.source, "Keep the earlier draft."), conversationId: "First" };
    saveFeedbackShelf({ ...shelf, drafts: [...shelf.drafts, other] });
    render(<AgentFeedbackBubble client={client} />);
    await screen.findByText("Fix First");
    const summary = screen.getByText("Saved drafts (1)");
    const disclosure = summary.closest("details")!;
    fireEvent.click(summary);
    expect(disclosure).toHaveAttribute("open");
    fireEvent.keyDown(summary, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Agent feedback" })).toBeVisible();
    expect(disclosure).not.toHaveAttribute("open");
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    fireEvent.click(within(screen.getByRole("group", { name: "Saved drafts" })).getByRole("button", { name: /First Keep the earlier draft/ }));
    expect(disclosure).not.toHaveAttribute("open");
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep the earlier draft.");
    expect(readFeedbackShelf().drafts.some(item => item.body === "Keep this unrelated draft.")).toBe(true);
    expect(client.sendAgentConversationMessage).not.toHaveBeenCalled();
  });

  it("shows all accepted messages in chronological order without a Chats sidebar", async () => {
    const { client } = setup(); render(<AgentFeedbackBubble client={client} />);
    await screen.findByText("Fix First");
    expect(screen.queryByRole("navigation", { name: "Agent tasks" })).not.toBeInTheDocument();
    expect(screen.queryByText("Chats")).not.toBeInTheDocument();
    const log = screen.getByRole("log", { name: "Agent messages" });
    expect(within(log).getAllByRole("article").map(item => item.textContent)).toEqual([
      expect.stringContaining("Fix First"), expect.stringContaining("First failed"), expect.stringContaining("Fix Second"), expect.stringContaining("Second failed")]);
    expect(screen.getAllByRole("textbox", { name: "Message to agent" })).toHaveLength(1);
  });
  it("sends one continuation from its original context without changing the composer", async () => {
    const { client, send } = setup(); render(<AgentFeedbackBubble client={client} />); await screen.findByText("First failed");
    const retry = within(failedArticle("First failed")).getByRole("button", { name: "Retry" });
    fireEvent.click(retry); await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0][0]).toBe("First"); expect(send.mock.calls[0][1].body).toContain("Fix First");
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this unrelated draft.");
    expect(readFeedbackShelf().drafts.some(item => item.body === "Keep this unrelated draft.")).toBe(true);
    fireEvent.click(retry); expect(send).toHaveBeenCalledOnce();
    expect(within(failedArticle("First failed")).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    const queue = screen.getByRole("region", { name: "Queued requests" }); expect(queue).toHaveTextContent("Fix First");
    expect(queue.compareDocumentPosition(screen.getByRole("textbox", { name: "Message to agent" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it("reuses a rejected continuation identity after explicit draft discard", async () => {
    const { client, send } = setup(); send.mockRejectedValueOnce(new WorkspaceClientError("The queue is full.", { code: "agent_conversation_queue_full" }));
    render(<AgentFeedbackBubble client={client} />); await screen.findByText("First failed");
    fireEvent.click(within(failedArticle("First failed")).getByRole("button", { name: "Retry" }));
    const alert = await screen.findByRole("alert"); fireEvent.click(within(alert).getByRole("button", { name: "Discard draft" }));
    fireEvent.click(within(failedArticle("First failed")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2)); expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });
  it("keeps a retry accepted after local receipt loss from becoming a second task", async () => {
    const { client, send } = setup(); const view = render(<AgentFeedbackBubble client={client} />); await screen.findByText("First failed");
    fireEvent.click(within(failedArticle("First failed")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    view.unmount(); localStorage.clear(); render(<AgentFeedbackBubble client={client} />); fireEvent.click(screen.getByRole("button", { name: "Open agent feedback" }));
    await screen.findByText("First failed"); expect(within(failedArticle("First failed")).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument(); expect(send).toHaveBeenCalledOnce();
  });
  it("clears only an exact legacy continuation after its retry is accepted", async () => {
    const { client } = setup();
    const body = "Continue this task from its saved local work:\n\nFix First\n\nInspect the existing changes before you edit. Preserve the saved work. Complete the remaining work. Run the remaining checks. Explain the result and any failed checks.";
    const old = { ...newFeedbackDraft(record("First", 1).source, body), conversationId: "First" };
    saveFeedbackShelf({ version: 2, open: true, selectedId: old.id, drafts: [old] });
    render(<AgentFeedbackBubble client={client} />); await screen.findByText("First failed");
    fireEvent.click(within(failedArticle("First failed")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue(""));
  });
  it("reconciles every accepted internal retry without changing the normal composer draft", async () => {
    const { client, records } = setup(); const first = records.get("First")!;
    const normal = { ...newFeedbackDraft(first.source, "Keep this draft."), conversationId: "First" };
    const retries = ["retry-one", "retry-two"].map(id => ({ ...newFeedbackDraft(first.source), conversationId: "First", retryOrigin: { conversationId: "First", messageId: id, requestId: id }, attempt: { requestId: id, body: `Continue ${id}` } }));
    saveFeedbackShelf({ version: 2, open: true, selectedId: normal.id, drafts: [normal, ...retries] });
    records.set("First", { ...first, revision: 2, messages: [...first.messages, ...retries.map((item, index) => ({ messageId: item.id, role: "user" as const, requestId: item.attempt.requestId, body: item.attempt.body, status: "queued" as const, createdAtUnixMs: 10 + index, queuePosition: index + 1 }))] });
    render(<AgentFeedbackBubble client={client} />);
    await waitFor(() => expect(readFeedbackShelf().drafts.every(item => !item.attempt)).toBe(true));
    expect(screen.queryByRole("button", { name: "Retry send" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this draft.");
  });
  it("edits and cancels a queued row in its original conversation while another context owns the composer", async () => {
    const { client, records } = setup(); const first = records.get("First")!;
    records.set("First", { ...first, messages: [...first.messages, { messageId: "queued-one", requestId: "queued-send", role: "user", body: "Queued original", status: "queued", createdAtUnixMs: 6, queuePosition: 1 }] });
    const update = vi.fn(async (id: string, messageId: string, request: { requestId: string; expectedBody: string; body: string }) => {
      const item = records.get(id)!; const next = { ...item, revision: item.revision + 1, messages: item.messages.map(message => message.messageId === messageId ? { ...message, body: request.body, lastMutationRequestId: request.requestId } : message) }; records.set(id, next); return next;
    });
    const cancel = vi.fn(async (id: string, messageId: string, request: { requestId: string; expectedBody: string }) => {
      const item = records.get(id)!; return { ...item, revision: item.revision + 1, messages: item.messages.map(message => message.messageId === messageId ? { ...message, status: "cancelled" as const, queuePosition: undefined, lastMutationRequestId: request.requestId } : message) };
    });
    client.updateAgentConversationMessage = update; client.cancelAgentConversationMessage = cancel;
    render(<AgentFeedbackBubble client={client} />); fireEvent.click(await screen.findByRole("button", { name: "Edit queued request" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Queued request" }), { target: { value: "Edited queued request" } });
    fireEvent.click(screen.getByRole("button", { name: "Save queued edit" })); await waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update.mock.calls[0]).toEqual(["First", "queued-one", expect.objectContaining({ expectedBody: "Queued original", body: "Edited queued request" })]);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel request" })); await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(cancel.mock.calls[0]).toEqual(["First", "queued-one", expect.objectContaining({ expectedBody: "Edited queued request" })]);
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this unrelated draft.");
  });
  it("blocks a repeated pointer action without blocking keyboard context selection", async () => {
    const { client } = setup(); render(<AgentFeedbackBubble client={client} />);
    const context = await screen.findByRole("button", { name: "First · Failed" });
    fireEvent.click(context, { detail: 2 });
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this unrelated draft.");
    fireEvent.click(context, { detail: 0 });
    expect(readFeedbackShelf().drafts.find(item => item.id === readFeedbackShelf().selectedId)?.conversationId).toBe("First");
    expect(readFeedbackShelf().drafts.some(item => item.body === "Keep this unrelated draft.")).toBe(true);
  });
  it("retains an uncertain continuation identity on reload and never sends by itself", async () => {
    const { client, send } = setup(); send.mockRejectedValueOnce(new Error("Connection lost"));
    const view = render(<AgentFeedbackBubble client={client} />); await screen.findByText("First failed");
    fireEvent.click(within(failedArticle("First failed")).getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Retry send" }); const first = send.mock.calls[0];
    view.unmount(); render(<AgentFeedbackBubble client={client} />);
    await screen.findByRole("button", { name: "Retry send" }); expect(send).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry send" })); await waitFor(() => expect(send).toHaveBeenCalledTimes(2)); expect(send.mock.calls[1]).toEqual(first);
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this unrelated draft.");
  });
});
