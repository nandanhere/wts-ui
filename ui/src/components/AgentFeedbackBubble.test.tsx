import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
import type { AgentConversation, CreateAgentConversationRequest } from "../lib/agentConversations";
import { AgentFeedbackBubble } from "./AgentFeedbackBubble";
import { UI_REGION_SELECTED_EVENT, type UiRegionSelection } from "./uiRegionSelection";
import { openAgentFeedback, requestAgentTask } from "../lib/agentFeedbackEvents";
import { readFeedbackDraft } from "../lib/agentFeedbackDraft";

const region: UiRegionSelection = { schemaVersion: 1, id: "plan.description", label: "Plan description", route: "/sessions/project", capturedAtUnixMs: 1, rect: { x: 10, y: 40, width: 200, height: 100 }, viewport: { width: 1200, height: 800, devicePixelRatio: 2 }, visibleText: "Imported description", controls: [], ancestors: [] };
function setup() {
  let conversation: AgentConversation;
  const create = vi.fn(async (request: CreateAgentConversationRequest) => {
    conversation = { schemaVersion: 1, conversationId: "chat", workspaceId: request.source.kind === "gitlabDiscussion" ? request.source.workspaceId : "wts-dev",
      repositoryId: "repo", workspaceDisplayPath: "/work/wts", source: request.source, provider: request.provider, revision: 1,
      createdAtUnixMs: 1, updatedAtUnixMs: 1, messages: [] };
    return conversation;
  });
  const send = vi.fn(async (_id, request) => {
    conversation = { ...conversation, revision: conversation.revision + 1, messages: [...conversation.messages,
      { messageId: request.requestId, requestId: request.requestId, role: "user", body: request.body, createdAtUnixMs: 2, status: "completed" },
      { messageId: `reply-${request.requestId}`, role: "assistant", body: "The source now renders the description as Markdown.", createdAtUnixMs: 3, status: "completed" }] };
    return conversation;
  });
  const get = vi.fn(async () => conversation);
  const client = { createAgentConversation: create, sendAgentConversationMessage: send, getAgentConversation: get,
    listAgentConversations: vi.fn(async () => ({ schemaVersion: 1, conversations: conversation ? [conversation] : [] })), stopAgentSession: vi.fn() } as unknown as WorkspaceClient;
  return { client, create, send, get, list: client.listAgentConversations as ReturnType<typeof vi.fn> };
}
function selectRegion(detail = region) { act(() => window.dispatchEvent(new CustomEvent(UI_REGION_SELECTED_EVENT, { detail }))); }
function taskButton(label: string) {
  const direct = screen.queryAllByRole("button", { name: new RegExp(label) }).find(item => item.closest("article") || item.closest('[aria-label="Queued requests"]'));
  if (direct) return direct;
  const menu = screen.getByText(/^Saved drafts \(/).closest("details")!; if (!menu.open) fireEvent.click(menu.querySelector("summary")!);
  return within(screen.getByRole("group", { name: "Saved drafts" })).getByRole("button", { name: new RegExp(label) });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const capture = { mimeType: "image/png" as const, dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ahtsAAAAASUVORK5CYII=", width: 1, height: 1 };
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());
describe("contextual agent chat", () => {
  it("opens a prepared WTS task as a draft and sends it only on request", async () => {
    const { client, create, send } = setup();
    render(<AgentFeedbackBubble client={client} />);
    act(() => requestAgentTask({ calloutId: "planning.plan-starter", label: "Plan · Review zeno !41", body: "Write a review plan in PLAN.md." }));
    expect(await screen.findByRole("dialog", { name: "Agent feedback" })).toHaveTextContent("Plan · Review zeno !41");
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Write a review plan in PLAN.md.");
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]![0].source).toMatchObject({ kind: "ui", calloutId: "planning.plan-starter", label: "Plan · Review zeno !41" });
  });

  it("creates a WTS source conversation only on send and preserves it across a remount", async () => {
    const { client, create, send } = setup();
    const view = render(<AgentFeedbackBubble client={client} />);
    selectRegion();
    expect(await screen.findByRole("dialog", { name: "Agent feedback" })).toHaveTextContent("Plan description");
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Parse the description." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(await screen.findByText("The source now renders the description as Markdown.")).toBeVisible();
    expect(create.mock.calls[0][0].source).toMatchObject({ kind: "ui", calloutId: "plan.description", selectedText: "Imported description" });
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(screen.getByRole("link", { name: "View current local changes" })).toHaveAttribute("href", "/sessions/wts-dev/changes?repository=repo");
    fireEvent.click(screen.getByRole("button", { name: "Close task changes" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Also fix the spacing." } });
    view.unmount(); render(<AgentFeedbackBubble client={client} />);
    expect(await screen.findByRole("textbox", { name: "Message to agent" })).toHaveValue("Also fix the spacing.");
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("retries an uncertain send with the same request ID and retained text", async () => {
    const { client, send } = setup(); send.mockRejectedValueOnce(new Error("transport lost"));
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(await screen.findByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Retry");
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Fix this.");
    fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });
  it("opens MR feedback in its project workspace without replying to GitLab", async () => {
    const { client, create } = setup(); const reply = vi.fn(); client.replyGitlabDiscussion = reply;
    render(<AgentFeedbackBubble client={client} />);
    act(() => openAgentFeedback({ kind: "gitlabDiscussion", workspaceId: "project", repositoryId: "repo", providerRepositoryId: "gitlab-repo", iid: 16, discussionId: "thread", filePath: "src/file.go", line: 55, side: "additions", resolved: false, automated: false,
      comments: [{ id: 2, authorLogin: "reviewer", body: "Log the error before returning", createdAt: "2026-09-18" }] }));
    fireEvent.click(await screen.findByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].source).toMatchObject({ workspaceId: "project", providerRepositoryId: "gitlab-repo", discussionId: "thread" });
    expect(create.mock.calls[0][0].source).not.toHaveProperty("automated");
    expect(reply).not.toHaveBeenCalled();
  });

  it("preserves text entered while a new region image is pending", async () => {
    const { client } = setup(); const pending = deferred<typeof capture>(); client.captureUiRegion = vi.fn(() => pending.promise);
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    selectRegion({ ...region, id: "workspace.title", label: "Workspace title", captureAllowed: true });
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Keep this draft." } });
    await act(async () => pending.resolve(capture));
    fireEvent.click(taskButton("Plan description"));
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep this draft.");
    expect(readFeedbackDraft()?.request.source).toMatchObject({ calloutId: "plan.description" });
  });

  it("keeps the dialog closed when an earlier image capture completes", async () => {
    const { client } = setup(); const pending = deferred<typeof capture>(); client.captureUiRegion = vi.fn(() => pending.promise);
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    selectRegion({ ...region, captureAllowed: true });
    fireEvent.click(screen.getByRole("button", { name: "Close agent feedback" }));
    await act(async () => pending.resolve(capture));
    expect(screen.queryByRole("dialog", { name: "Agent feedback" })).not.toBeInTheDocument();
  });

  it("drops an image when a private field appears over the region during capture", async () => {
    const { client, create } = setup(); const pending = deferred<typeof capture>(); client.captureUiRegion = vi.fn(() => pending.promise);
    render(<AgentFeedbackBubble client={client} />); selectRegion({ ...region, captureAllowed: true });
    const input = document.createElement("input"); input.type = "password"; input.value = "secret"; document.body.append(input);
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({ x: 10, y: 40, left: 10, top: 40, right: 100, bottom: 100, width: 90, height: 60, toJSON() {} });
    try {
      await act(async () => pending.resolve(capture));
      fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this region." } });
      fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
      await waitFor(() => expect(create).toHaveBeenCalled());
      expect(create.mock.calls[0][0].source).not.toHaveProperty("capture");
      expect(JSON.stringify(readFeedbackDraft())).not.toContain(capture.dataUrl);
    } finally { input.remove(); }
  });

  it("omits empty selected text at the create boundary", async () => {
    const { client, create } = setup(); render(<AgentFeedbackBubble client={client} />); selectRegion({ ...region, visibleText: "  " });
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this region." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0].source).not.toHaveProperty("selectedText");
  });

  it("restores focus to the region control after Escape closes the dialog", async () => {
    const { client } = setup(); render(<><button>Region control</button><AgentFeedbackBubble client={client} /></>);
    const control = screen.getByRole("button", { name: "Region control" }); control.focus(); selectRegion();
    const textarea = await screen.findByRole("textbox", { name: "Message to agent" }); expect(textarea).toHaveFocus();
    fireEvent.keyDown(textarea, { key: "Escape" }); expect(control).toHaveFocus();
  });

  it("retries a send after local storage recovers without a no-op refresh", async () => {
    const { client, send } = setup(); render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Keep this request." } });
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" })); expect(send).not.toHaveBeenCalled();
    storage.mockRestore(); fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  });

  it("explains missing source configuration and retries the same create request", async () => {
    const { client, create } = setup(); create.mockRejectedValueOnce(new WorkspaceClientError("WTS needs its source repository. Start WTS with WTS_UI_REPOSITORY_ROOT set to the source checkout.", { code: "agent_conversation_source_unavailable", retryable: true }));
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("WTS_UI_REPOSITORY_ROOT");
    expect(screen.queryByRole("button", { name: "Open Settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
  });

  it("lets a user discard a source rejection and select another region", async () => {
    const { client, create, send } = setup();
    create.mockRejectedValueOnce(new WorkspaceClientError("WTS needs its source repository.", { code: "agent_conversation_source_unavailable" }));
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByText("WTS needs its source repository.");
    const request = readFeedbackDraft()?.request;
    selectRegion({ ...region, id: "workspace.title", label: "Workspace title" });
    fireEvent.click(taskButton("Plan description"));
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Fix this.");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(readFeedbackDraft()?.attempt).toBeUndefined();
    selectRegion({ ...region, id: "workspace.title", label: "Workspace title" });
    expect(screen.getByRole("dialog", { name: "Agent feedback" })).toHaveTextContent("Workspace title");
    expect(readFeedbackDraft()?.request.requestId).not.toBe(request?.requestId);
    expect(send).not.toHaveBeenCalled();
  });

  it("lets a user discard a storage-limit rejection and open an existing chat", async () => {
    const { client, create } = setup();
    const existing = await create({ requestId: crypto.randomUUID(), provider: "codex", source: { kind: "ui", route: "/", calloutId: "saved.region", label: "Saved region" } });
    create.mockClear(); create.mockRejectedValueOnce(new WorkspaceClientError("Conversation storage is full. Open an existing conversation to continue.", { code: "agent_conversation_storage_full" }));
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByText(/Conversation storage is full/);
    fireEvent.click(taskButton("Saved region"));
    expect(readFeedbackDraft()?.conversationId).toBe(existing.conversationId);
    fireEvent.click(taskButton("Plan description"));
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.getByText("Saved region", { selector: "footer summary" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("");
    expect(readFeedbackDraft()?.conversationId).toBe(existing.conversationId);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each(["invalid_agent_conversation", "agent_conversation_source_unavailable", "agent_conversation_storage_full", "agent_conversation_limit", "agent_conversation_platform_unavailable", "agent_conversation_not_found", "agent_conversation_conflict", "agent_conversation_busy"])("permits explicit discard after the definitive send rejection %s", async (code) => {
    const { client, send } = setup(); send.mockRejectedValueOnce(new WorkspaceClientError("WTS rejected this request before execution.", { code }));
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByRole("button", { name: "Retry send" });
    expect(screen.getByRole("button", { name: "Retry send" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(readFeedbackDraft()?.attempt).toBeUndefined();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("");
  });

  it.each(["agent_conversation_unavailable", "invalid_response", "transport_error"])("retains the uncertain send after %s and still exposes retry after a region switch", async (code) => {
    const { client, send } = setup(); send.mockRejectedValueOnce(new WorkspaceClientError("WTS could not confirm the request.", { code }));
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Keep this request." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByText("WTS could not confirm the request.");
    selectRegion({ ...region, id: "workspace.title", label: "Workspace title" });
    fireEvent.click(taskButton("Plan description"));
    expect(screen.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });

  it("revokes discard permission when a retry has an uncertain outcome", async () => {
    const { client, send } = setup();
    send.mockRejectedValueOnce(new WorkspaceClientError("WTS rejected this request before execution.", { code: "agent_conversation_busy" })).mockRejectedValueOnce(new Error("Transport lost"));
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Keep this request." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    expect(await screen.findByRole("button", { name: "Discard draft" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await screen.findByText(/WTS could not confirm this send/);
    expect(screen.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
    expect(readFeedbackDraft()?.attempt?.body).toBe("Keep this request.");
  });

  it("does not dispatch until the created conversation identity is saved", async () => {
    const { client, send, create } = setup(); render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Save the chat identity first." } });
    const original = Storage.prototype.setItem;
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (JSON.parse(value).drafts?.some((item: { conversationId?: string }) => item.conversationId)) throw new Error("Storage is full");
      original.call(this, key, value);
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1)); await act(async () => {});
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Discard draft" })).not.toBeInTheDocument();
    storage.mockRestore(); fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not send a pending create result through a replaced client", async () => {
    const first = setup(); const second = setup(); const pending = deferred<AgentConversation>();
    const realCreate = first.create.getMockImplementation()!; first.create.mockImplementationOnce(() => pending.promise);
    const view = render(<AgentFeedbackBubble client={first.client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Retain this request." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    const request = first.create.mock.calls[0][0]; view.rerender(<AgentFeedbackBubble client={second.client} />);
    await act(async () => pending.resolve(await realCreate(request)));
    expect(first.send).not.toHaveBeenCalled(); expect(second.send).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Retain this request.");
    fireEvent.click(screen.getByRole("button", { name: "Retry send" }));
    await waitFor(() => expect(second.create).toHaveBeenCalledTimes(1));
    expect(second.create.mock.calls[0][0]).toEqual(request);
  });

  it("announces new conversation messages through a polite chat log", async () => {
    const { client } = setup(); render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    const log = screen.getByRole("log", { name: "Agent messages" }); expect(log).toHaveAttribute("aria-live", "polite");
    await waitFor(() => expect(log).toHaveTextContent("The source now renders the description as Markdown."));
  });

  it("does not write the persisted image again for an unchanged conversation read", async () => {
    const { client, list } = setup(); render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByText("The source now renders the description as Markdown.");
    await act(async () => {});
    const storage = vi.spyOn(Storage.prototype, "setItem"); const previousReads = list.mock.calls.length;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(previousReads + 1));
    await act(async () => {}); expect(storage).not.toHaveBeenCalled();
  });

  it("does not read a restored completed chat while the document is hidden", async () => {
    const { client, get } = setup(); const view = render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Fix this." } });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));
    await screen.findByText("The source now renders the description as Markdown."); view.unmount(); get.mockClear();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(<AgentFeedbackBubble client={client} />); await act(async () => {});
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps the selected draft usable when the task-list read fails", async () => {
    const { client } = setup(); let reject!: (error: Error) => void;
    client.listAgentConversations = vi.fn(() => new Promise<{ schemaVersion: 1; conversations: AgentConversation[] }>((_resolve, fail) => { reject = fail; }));
    render(<AgentFeedbackBubble client={client} />); selectRegion();
    fireEvent.change(screen.getByRole("textbox", { name: "Message to agent" }), { target: { value: "Keep current text" } });
    await act(async () => reject(new Error("offline")));
    expect(screen.getByRole("alert")).toHaveTextContent("task list");
    expect(screen.getByRole("textbox", { name: "Message to agent" })).toHaveValue("Keep current text");
    expect(screen.getByRole("button", { name: "Retry task list" })).toBeEnabled();
  });
});
