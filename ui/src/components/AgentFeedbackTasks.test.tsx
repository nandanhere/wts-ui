import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentFeedbackBubble } from "./AgentFeedbackBubble";
import { UI_REGION_SELECTED_EVENT, type UiRegionSelection } from "./uiRegionSelection";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
import type { AgentConversation, CreateAgentConversationRequest } from "../lib/agentConversations";
import { newFeedbackDraft, readFeedbackShelf, saveFeedbackShelf } from "../lib/agentFeedbackDraft";
const region: UiRegionSelection = { schemaVersion: 1, id: "plan.description", label: "Plan description", route: "/", capturedAtUnixMs: 1, rect: { x: 1, y: 1, width: 200, height: 100 }, viewport: { width: 1200, height: 800, devicePixelRatio: 1 }, visibleText: "Plan", controls: [], ancestors: [] };
function select(label: string) { act(() => window.dispatchEvent(new CustomEvent(UI_REGION_SELECTED_EVENT, { detail: { ...region, id: label.toLowerCase().replaceAll(" ", "."), label } }))); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const records = new Map<string, AgentConversation>(); let sequence = 0;
  const create = vi.fn(async (request: CreateAgentConversationRequest) => {
    const existing = records.get(request.requestId); if (existing) return existing;
    const item: AgentConversation = { schemaVersion: 1, conversationId: request.requestId, source: request.source, provider: request.provider,
      workspaceId: "wts-dev", repositoryId: "repo", workspaceDisplayPath: "/work/wts", revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 1, messages: [] };
    records.set(item.conversationId, item); return item;
  });
  const send = vi.fn(async (id: string, request: { requestId: string; body: string }) => {
    const current = records.get(id)!; const previous = current.messages.find(message => message.requestId === request.requestId); if (previous) return current;
    const running = [...records.values()].some(item => item.activeSessionId);
    const status = running ? "queued" as const : "running" as const;
    const item = { ...current, revision: current.revision + 1, activeSessionId: running ? current.activeSessionId : "active-session",
      messages: [...current.messages, { messageId: `message-${++sequence}`, requestId: request.requestId, submittedBody: request.body, role: "user" as const, body: request.body,
        createdAtUnixMs: sequence, status, queueSequence: sequence, ...(running ? { queuePosition: sequence - 1 } : {}) }] };
    records.set(id, item); return item;
  });
  const update = vi.fn(async (id: string, messageId: string, request: { requestId: string; expectedBody: string; body: string }) => {
    const current = records.get(id)!; const message = current.messages.find(item => item.messageId === messageId)!;
    if (message.status !== "queued") throw new WorkspaceClientError("This task already started. Refresh its state.", { code: "agent_conversation_message_started" });
    const item = { ...current, revision: current.revision + 1, messages: current.messages.map(item => item.messageId === messageId ? { ...item, body: request.body, lastMutationRequestId: request.requestId } : item) };
    records.set(id, item); return item;
  });
  const cancel = vi.fn(async (id: string, messageId: string, request: { requestId: string; expectedBody: string }) => {
    const current = records.get(id)!;
    const item = { ...current, revision: current.revision + 1, messages: current.messages.map(item => item.messageId === messageId ? { ...item, status: "cancelled" as const, lastMutationRequestId: request.requestId } : item) };
    records.set(id, item); return item;
  });
  const client = { createAgentConversation: create, sendAgentConversationMessage: send, getAgentConversation: vi.fn(async id => records.get(id)),
    listAgentConversations: vi.fn(async () => ({ schemaVersion: 1, conversations: [...records.values()] })), updateAgentConversationMessage: update,
    cancelAgentConversationMessage: cancel, stopAgentSession: vi.fn(async () => ({})) } as unknown as WorkspaceClient;
  return { client, records, create, send, update, cancel };
}
async function submit(body: string) { fireEvent.change(await screen.findByRole("textbox", { name: "Message to agent" }), { target: { value: body } }); fireEvent.click(screen.getByRole("button", { name: /Send to agent|Queue request/ })); }
function task(label: string) {
  const direct = screen.queryAllByRole("button", { name: new RegExp(label) }).find(item => item.closest("article") || item.closest('[aria-label="Queued requests"]'));
  if (direct) return direct;
  const menu = screen.getByText(/^Saved drafts \(/).closest("details")!; if (!menu.open) fireEvent.click(menu.querySelector("summary")!);
  return within(screen.getByRole("group", { name: "Saved drafts" })).getByRole("button", { name: new RegExp(label) });
}
beforeEach(() => localStorage.clear());
describe("parallel feedback tasks", () => {
  it("queues another fix while a task is active and keeps the list visible", async () => {
    const { client, send } = setup(); render(<AgentFeedbackBubble client={client} />); select("Plan description"); await submit("First fix");
    await waitFor(() => expect(task("Plan description")).toHaveTextContent("Active"));
    select("Workspace title"); await submit("Second fix");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(task("Plan description")).toHaveTextContent("Active"); expect(task("Workspace title")).toHaveTextContent("Queued");
    expect(screen.queryByText(/Wait for the active agent/)).not.toBeInTheDocument();
    fireEvent.click(task("Plan description")); await submit("Follow-up fix");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
  });
  it("retains unsent drafts across context switches and a remount without submitting them", async () => {
    const { client, send } = setup(); const view = render(<AgentFeedbackBubble client={client} />);
    select("Plan description"); fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Draft one" } });
    select("Workspace title"); fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Draft two" } });
    fireEvent.click(task("Plan description")); expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Draft one");
    view.unmount(); render(<AgentFeedbackBubble client={client} />); fireEvent.click(task("Workspace title"));
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Draft two"); expect(send).not.toHaveBeenCalled();
    expect(readFeedbackShelf().drafts).toHaveLength(2);
  });
  it("keeps an uncertain request on its own task and retries it after another task was sent", async () => {
    const { client, send } = setup(); send.mockRejectedValueOnce(new Error("Transport lost")); render(<AgentFeedbackBubble client={client} />);
    select("Plan description"); await submit("Uncertain fix"); await screen.findByRole("button", { name: "Retry send" });
    select("Workspace title"); await submit("Independent fix"); await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    fireEvent.click(task("Plan description")); expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Uncertain fix");
    fireEvent.click(screen.getByRole("button", { name: "Retry send" })); await waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    expect(send.mock.calls[2]).toEqual(send.mock.calls[0]);
  });
  it("applies a delayed acknowledgement to its original task after a switch", async () => {
    const { client, send } = setup(); const pending = deferred<AgentConversation>(); const realSend = send.getMockImplementation()!;
    send.mockImplementationOnce(() => pending.promise); render(<AgentFeedbackBubble client={client} />);
    select("Plan description"); await submit("First fix"); await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    select("Workspace title"); fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Keep second text" } });
    await act(async () => pending.resolve(await realSend(...send.mock.calls[0])));
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep second text");
    fireEvent.click(task("Plan description")); expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("");
    expect(task("Plan description")).toHaveTextContent("Active");
  });
  it("edits and cancels a queued request through explicit actions", async () => {
    const { client, update, cancel } = setup(); render(<AgentFeedbackBubble client={client} />);
    select("Plan description"); await submit("First fix"); await waitFor(() => expect(task("Plan description")).toHaveTextContent("Active"));
    select("Workspace title"); await submit("Queued fix"); fireEvent.click(await screen.findByRole("button", { name: "Edit queued request" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Queued request" }), { target: { value: "Edited fix" } });
    fireEvent.click(screen.getByRole("button", { name: "Save queued edit" })); await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0][2]).toMatchObject({ expectedBody: "Queued fix", body: "Edited fix" });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel request" })); await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
    expect(cancel.mock.calls[0][2].expectedBody).toBe("Edited fix"); await waitFor(() => expect(task("Workspace title")).toHaveTextContent("Cancelled"));
  });
  it("retains queued edit text when the task starts before the edit arrives", async () => {
    const { client, records, update } = setup(); render(<AgentFeedbackBubble client={client} />);
    select("Plan description"); await submit("First fix"); await waitFor(() => expect(task("Plan description")).toHaveTextContent("Active"));
    select("Workspace title"); await submit("Queued fix"); fireEvent.click(await screen.findByRole("button", { name: "Edit queued request" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Queued request" }), { target: { value: "Keep this edit" } });
    for (const [id, item] of records) if (item.source.kind === "ui" && item.source.label === "Workspace title") records.set(id, { ...item, revision: item.revision + 1, activeSessionId: "next-session", messages: item.messages.map(message => ({ ...message, status: "running" })) });
    fireEvent.click(screen.getByRole("button", { name: "Save queued edit" })); await waitFor(() => expect(update).toHaveBeenCalled());
    expect(await screen.findByRole("textbox", { name: "Queued request" })).toHaveValue("Keep this edit");
    expect(screen.getByRole("button", { name: "Refresh task" })).toBeEnabled();
  });
  it("retains both drafts when a queued edit exceeds the follow-up text limit", async () => {
    const { client } = setup(); render(<AgentFeedbackBubble client={client} />);
    select("Plan description"); await submit("First fix"); await waitFor(() => expect(task("Plan description")).toHaveTextContent("Active"));
    select("Workspace title"); await submit("Queued fix"); fireEvent.click(await screen.findByRole("button", { name: "Edit queued request" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Queued request" }), { target: { value: "a".repeat(10_000) } });
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "b".repeat(10_000) } });
    fireEvent.click(screen.getByRole("button", { name: "Use as follow-up" }));
    expect(screen.getByRole("textbox", { name: "Queued request" })).toHaveValue("a".repeat(10_000));
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("b".repeat(10_000));
    expect(screen.getByRole("alert")).toHaveTextContent("16,384");
  });
  it("can discard an ordinary draft to free a full draft list", async () => {
    const { client } = setup();
    const drafts = Array.from({ length: 64 }, (_, index) => newFeedbackDraft({ kind: "ui", route: "/", calloutId: `draft.${index}`, label: `Draft ${index}` }, `Request ${index}`));
    saveFeedbackShelf({ version: 2, open: true, selectedId: drafts[0].id, drafts });
    render(<AgentFeedbackBubble client={client} />); select("Another region");
    expect(await screen.findByText(/draft list is full/)).toBeVisible();
    fireEvent.keyDown(screen.getByRole("button", { name: "Feedback options" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Discard current draft" }));
    select("Another region"); expect(screen.getByText("Another region", { selector: "footer summary" })).toBeVisible();
    expect(readFeedbackShelf().drafts).toHaveLength(64);
  });
  it("updates queue position at the same conversation revision", async () => {
    const { client, records } = setup(); render(<AgentFeedbackBubble client={client} />);
    select("Plan description"); await submit("First fix"); await waitFor(() => expect(task("Plan description")).toHaveTextContent("Active"));
    select("Workspace title"); await submit("Queued fix"); await screen.findByRole("button", { name: "Workspace title · Queued · 1 in workspace queue" });
    for (const [id, item] of records) if (item.messages.some(message => message.status === "queued")) records.set(id, { ...item, messages: item.messages.map(message => ({ ...message, queuePosition: 2 })) });
    fireEvent.keyDown(screen.getByRole("button", { name: "Feedback options" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh tasks" }));
    expect(await screen.findByRole("button", { name: "Workspace title · Queued · 2 in workspace queue" })).toBeVisible();
    for (const [id, item] of records) if (item.messages.some(message => message.status === "queued")) records.set(id, { ...item, messages: item.messages.map(message => ({ ...message, queuePosition: 1 })) });
    fireEvent.keyDown(screen.getByRole("button", { name: "Feedback options" }), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh tasks" }));
    expect(await screen.findByRole("button", { name: "Workspace title · Queued · 1 in workspace queue" })).toBeVisible();
  });
  it("retries an uncertain queued edit with the same mutation ID after a remount", async () => {
    const { client, update } = setup(); const view = render(<AgentFeedbackBubble client={client} />);
    select("Plan description"); await submit("First fix"); await waitFor(() => expect(task("Plan description")).toHaveTextContent("Active"));
    select("Workspace title"); await submit("Queued fix"); fireEvent.click(await screen.findByRole("button", { name: "Edit queued request" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Queued request" }), { target: { value: "Retained edit" } });
    update.mockRejectedValueOnce(new Error("Transport lost")); fireEvent.click(screen.getByRole("button", { name: "Save queued edit" }));
    await screen.findByRole("button", { name: "Retry queued change" });
    view.unmount(); render(<AgentFeedbackBubble client={client} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry queued change" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update.mock.calls[1]).toEqual(update.mock.calls[0]);
  });
});
