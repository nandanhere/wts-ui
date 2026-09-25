import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitlabDiscussionReplyResult, GitlabReviewDiscussionComment } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import type { GitlabConversationEntry, GitlabConversationsController } from "./gitlabDiscussions";
import { GitlabDiscussionsPanel } from "./GitlabDiscussionsPanel";
import { gitlabDiscussionDrafts } from "./gitlabDiscussionDrafts";

const scopeId = "a".repeat(64);
const comment = (id: number, body: string, authorLogin = "priya"): GitlabReviewDiscussionComment => ({
  id, body, authorLogin, createdAt: "2026-09-17T09:00:00Z",
});

function entry(iid = 9, worktreeRepositoryId = "repo_checkout"): GitlabConversationEntry {
  return {
    target: { key: `checkout-${iid}`, repositoryId: "provider_checkout", worktreeRepositoryId, iid, label: `Checkout !${iid}`, workspaceId: "ws_checkout" },
    state: "ready",
    error: "",
    unreadCommentIds: [41, 51],
    snapshot: {
      schemaVersion: 1, repositoryId: "provider_checkout", iid, scopeId, viewerLogin: "nandan",
      fetchedAtUnixMs: 1, fromCache: false, truncated: false,
      discussions: [
        { id: "general", resolvable: false, resolved: false, automated: false, comments: [comment(41, `Please explain **retry ${iid}**.`)] },
        { id: "file", resolvable: true, resolved: true, automated: false, filePath: "src/checkout.ts", side: "additions", line: 12, comments: [comment(51, "The retry path has a test.", "alex")] },
      ],
    },
  };
}

function controller(entries = [entry()]): GitlabConversationsController {
  return { entries, loading: false, error: "", unreadCount: 2, refresh: vi.fn(), markRead: vi.fn(), acceptReply: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

function replyResult(iid = 9): GitlabDiscussionReplyResult {
  return { schemaVersion: 1, repositoryId: "provider_checkout", iid, discussionId: "general", comment: comment(43, "The retry limit is three.", "nandan") };
}

function openGeneral() { fireEvent.click(screen.getByRole("button", { name: /General discussion/ })); }
function draft(value: string) { fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value } }); }
function selectMr(key: string) { fireEvent.change(screen.getByRole("combobox", { name: "Merge request for conversations" }), { target: { value: key } }); }

afterEach(() => { vi.restoreAllMocks(); gitlabDiscussionDrafts.clear(); });

describe("GitLab conversations", () => {
  it("lists human review threads before automated bot notes", () => {
    const fake = fakeWorkspaceClient();
    const base = entry();
    const withBot: GitlabConversationEntry = {
      ...base,
      snapshot: { ...base.snapshot!, discussions: [
        { id: "bot", resolvable: false, resolved: false, automated: true, comments: [comment(61, "hello from cibot", "cibot")] },
        ...base.snapshot!.discussions,
      ] },
    };
    render(<GitlabDiscussionsPanel active client={fake.client} controller={controller([withBot])} repositoryId="repo_checkout" />);
    const threads = within(screen.getByRole("list", { name: "Conversations" })).getAllByRole("listitem");
    expect(threads[0]).toHaveTextContent("Please explain");
    expect(threads.at(-1)).toHaveTextContent("hello from cibot");
  });

  it("retains uncertain reply guidance when the response fails after unmount", async () => {
    const fake = fakeWorkspaceClient(); let reject!: (cause: Error) => void; const response = new Promise<GitlabDiscussionReplyResult>((_resolve, fail) => { reject = fail; }); fake.replyGitlabDiscussion.mockReturnValue(response);
    const props = { active: true, client: fake.client, controller: controller(), repositoryId: "repo_checkout" }; const first = render(<GitlabDiscussionsPanel {...props} />); openGeneral(); draft("Check this reply before repeating it."); fireEvent.click(screen.getByRole("button", { name: "Reply to GitLab" })); first.unmount();
    await act(async () => { reject(new Error("The GitLab response was lost.")); await response.catch(() => {}); }); render(<GitlabDiscussionsPanel {...props} />); openGeneral();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Check this reply before repeating it."); expect(screen.getByRole("alert")).toHaveTextContent("The GitLab response was lost."); expect(screen.getByRole("alert")).toHaveTextContent("Check GitLab before you send this reply again."); expect(screen.getByRole("button", { name: "Open MR in GitLab" })).toBeVisible(); expect(fake.replyGitlabDiscussion).toHaveBeenCalledTimes(1);
  });

  it("focuses an explicit reply and keeps its draft and focus during a background refresh", () => {
    const fake = fakeWorkspaceClient();
    const state = controller();
    const props = { active: true, client: fake.client, controller: state, repositoryId: "repo_checkout" };
    const { rerender } = render(<GitlabDiscussionsPanel {...props} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Reply" })[0]!);
    const input = screen.getByRole("textbox", { name: "Reply" });
    expect(input).toHaveFocus();
    draft("Keep this reply while GitLab refreshes.");
    rerender(<GitlabDiscussionsPanel {...props} controller={{ ...state, entries: [{ ...state.entries[0]!, state: "loading" }] }} />);
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Keep this reply while GitLab refreshes.");
    expect(screen.getByRole("button", { name: "Refresh conversations" })).toBeDisabled();
    expect(fake.replyGitlabDiscussion).not.toHaveBeenCalled();
    rerender(<GitlabDiscussionsPanel {...props} />);
    expect(input).toHaveFocus();
    expect(screen.getByRole("button", { name: "Reply to GitLab" })).toBeEnabled();
  });

  it("hands the complete selected conversation and its original MR line to the agent without publishing or reading another thread", () => {
    const fake = fakeWorkspaceClient();
    const first = entry();
    first.snapshot!.discussions[1]!.position = { baseCommitOid: "b".repeat(40), startCommitOid: "c".repeat(40), headCommitOid: "d".repeat(40) };
    const state = controller([first]);
    const onAskAgentToFix = vi.fn();
    const props = { active: true, client: fake.client, controller: state, repositoryId: "repo_checkout", onAskAgentToFix };
    const { rerender } = render(<GitlabDiscussionsPanel {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "src/checkout.ts:+12 by @alex" }));
    draft("Keep my GitLab reply draft.");
    const incoming = comment(52, "Check the new edge case before changing the code.");
    const refreshed = { ...first, snapshot: { ...first.snapshot!, discussions: first.snapshot!.discussions.map((discussion) => discussion.id === "file" ? { ...discussion, comments: [...discussion.comments, incoming] } : discussion) } };
    rerender(<GitlabDiscussionsPanel {...props} controller={{ ...state, entries: [refreshed] }} />);
    vi.mocked(state.markRead).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Ask agent to fix" }));
    expect(onAskAgentToFix).toHaveBeenCalledOnce();
    expect(onAskAgentToFix).toHaveBeenCalledWith(expect.objectContaining({ kind: "gitlabDiscussion", workspaceId: "ws_checkout", repositoryId: "repo_checkout", providerRepositoryId: "provider_checkout", iid: 9, scopeId, discussionId: "file", filePath: "src/checkout.ts", side: "additions", line: 12, position: first.snapshot!.discussions[1]!.position, comments: [comment(51, "The retry path has a test.", "alex"), incoming] }));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Keep my GitLab reply draft.");
    expect(state.markRead).not.toHaveBeenCalled();
    expect(fake.replyGitlabDiscussion).not.toHaveBeenCalled();
    expect(fake.publishGitlabReviewComment).not.toHaveBeenCalled();
    expect(fake.resolveWorkspaceReviewThread).not.toHaveBeenCalled();
    expect(screen.queryByText(incoming.body)).not.toBeInTheDocument();
  });

  it("uses the explicit workspace fallback to discuss cached MR feedback", () => {
    const fake = fakeWorkspaceClient();
    const cached = entry();
    delete cached.target.workspaceId;
    cached.state = "error"; cached.error = "GitLab is offline.";
    cached.snapshot = { ...cached.snapshot!, fromCache: true, truncated: true };
    const onAskAgentToFix = vi.fn();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={controller([cached])} repositoryId="repo_checkout" workspaceId="ws_existing_project" onAskAgentToFix={onAskAgentToFix} />);
    openGeneral();
    fireEvent.click(screen.getByRole("button", { name: "Ask agent to fix" }));
    expect(onAskAgentToFix).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws_existing_project", fromCache: true, truncated: true, discussionId: "general" }));
    expect(screen.getByRole("button", { name: "Reply to GitLab" })).toBeDisabled();
    expect(fake.replyGitlabDiscussion).not.toHaveBeenCalled();
  });

  it("requires a known workspace for the agent handoff", () => {
    const fake = fakeWorkspaceClient();
    const first = entry(); delete first.target.workspaceId;
    const onAskAgentToFix = vi.fn();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={controller([first])} repositoryId="repo_checkout" onAskAgentToFix={onAskAgentToFix} />);
    openGeneral();
    expect(screen.queryByRole("button", { name: "Ask agent to fix" })).not.toBeInTheDocument();
    expect(screen.getByText("Open an existing project workspace to ask an agent to fix this conversation.")).toBeVisible();
    expect(onAskAgentToFix).not.toHaveBeenCalled();
  });

  it("focuses the revealed thread when acknowledgement removes its unread action, without stealing focus on polling", () => {
    const fake = fakeWorkspaceClient();
    const state = controller();
    const request = { requestId: 1, targetKey: "checkout-9", scopeId, discussionId: "general" };
    function Harness({ current }: { current: GitlabConversationsController }) {
      const [reveal, setReveal] = useState<typeof request>();
      const [unread, setUnread] = useState(true);
      return <>
        {unread && <button onClick={() => setReveal(request)} type="button">Read unread comments</button>}
        <GitlabDiscussionsPanel active client={fake.client} controller={{ ...current, markRead: (...args) => { current.markRead(...args); setUnread(false); } }} repositoryId="repo_checkout" revealConversation={reveal} />
      </>;
    }
    const { rerender } = render(<Harness current={state} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation status" }), { target: { value: "resolved" } });
    const action = screen.getByRole("button", { name: "Read unread comments" });
    action.focus();
    fireEvent.click(action);
    expect(screen.queryByRole("button", { name: "Read unread comments" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "General discussion by @priya" })).toHaveFocus();
    const reply = screen.getByRole("textbox", { name: "Reply" });
    reply.focus();
    draft("Keep focus while I write.");
    const first = state.entries[0]!;
    const refreshed = { ...first, snapshot: { ...first.snapshot!, discussions: first.snapshot!.discussions.map((discussion) => discussion.id === "general" ? { ...discussion, comments: [...discussion.comments, comment(42, "A later reply.")] } : discussion) } };
    rerender(<Harness current={{ ...state, entries: [refreshed] }} />);
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveFocus();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Keep focus while I write.");
    expect(screen.queryByText("A later reply.")).not.toBeInTheDocument();
  });

  it.each([
    { filter: "open", discussionId: "file", heading: "src/checkout.ts:+12 by @alex", draftText: "Keep the file reply.", newId: 52 },
    { filter: "resolved", discussionId: "general", heading: "General discussion by @priya", draftText: "Keep the general reply.", newId: 42 },
  ])("reveals the latest requested thread through the retained $filter filter once and preserves drafts", ({ filter, discussionId, heading, draftText, newId }) => {
    const fake = fakeWorkspaceClient();
    const first = entry();
    const state = controller([first]);
    const onSelectConversation = vi.fn();
    const props = { active: true, client: fake.client, controller: state, repositoryId: "repo_checkout", onSelectConversation };
    const { rerender } = render(<GitlabDiscussionsPanel {...props} />);
    openGeneral(); draft("Keep the general reply.");
    fireEvent.click(screen.getByRole("button", { name: "src/checkout.ts:+12 by @alex" }));
    draft("Keep the file reply.");
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation status" }), { target: { value: filter } });
    const incoming = comment(newId, "The latest unread reply.");
    const refreshed = { ...first, snapshot: { ...first.snapshot!, discussions: first.snapshot!.discussions.map((discussion) => discussion.id === discussionId ? { ...discussion, comments: [...discussion.comments, incoming] } : discussion) } };
    const revealConversation = { requestId: 1, targetKey: first.target.key, scopeId, discussionId };
    onSelectConversation.mockClear(); vi.mocked(state.markRead).mockClear();
    rerender(<GitlabDiscussionsPanel {...props} controller={{ ...state, entries: [refreshed] }} revealConversation={revealConversation} />);
    expect(screen.getByRole("combobox", { name: "Conversation status" })).toHaveValue("all");
    expect(screen.getByRole("button", { name: heading })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(incoming.body)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(draftText);
    expect(onSelectConversation).toHaveBeenCalledOnce();
    const requestedComments = refreshed.snapshot.discussions.find((discussion) => discussion.id === discussionId)!.comments;
    expect(state.markRead).toHaveBeenLastCalledWith(first.target.key, scopeId, requestedComments);
    expect(vi.mocked(state.markRead).mock.calls.every((call) => call[2].every((note) => requestedComments.some((requested) => requested.id === note.id)))).toBe(true);

    const later = comment(newId + 1, "A reply after the explicit request.");
    const polled = { ...refreshed, snapshot: { ...refreshed.snapshot, discussions: refreshed.snapshot.discussions.map((discussion) => discussion.id === discussionId ? { ...discussion, comments: [...discussion.comments, later] } : discussion) } };
    vi.mocked(state.markRead).mockClear();
    rerender(<GitlabDiscussionsPanel {...props} controller={{ ...state, entries: [polled] }} revealConversation={{ ...revealConversation }} />);
    expect(screen.queryByText(later.body)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show new replies" })).toBeVisible();
    expect(onSelectConversation).toHaveBeenCalledOnce();
    expect(state.markRead).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation status" }), { target: { value: filter } });
    rerender(<GitlabDiscussionsPanel {...props} controller={{ ...state, entries: [polled] }} revealConversation={{ ...revealConversation }} />);
    expect(screen.getByRole("combobox", { name: "Conversation status" })).toHaveValue(filter);
    expect(gitlabDiscussionDrafts.read(JSON.stringify([first.target.key, scopeId, "general"]))).toBe("Keep the general reply.");
    expect(gitlabDiscussionDrafts.read(JSON.stringify([first.target.key, scopeId, "file"]))).toBe("Keep the file reply.");
    rerender(<GitlabDiscussionsPanel {...props} controller={{ ...state, entries: [polled] }} revealConversation={{ ...revealConversation, requestId: 2 }} />);
    expect(screen.getByRole("combobox", { name: "Conversation status" })).toHaveValue("all");
    expect(screen.getByText(later.body)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(draftText);
    expect(onSelectConversation).toHaveBeenCalledTimes(2);
    expect(state.markRead).toHaveBeenLastCalledWith(first.target.key, scopeId, [...requestedComments, later]);
  });

  it.each(["inactive", "target", "scope", "missing"] as const)("ignores an unavailable reveal context (%s) until the exact active thread is available", (reason) => {
    const fake = fakeWorkspaceClient();
    const state = controller([entry(), entry(10)]);
    const onSelectConversation = vi.fn();
    const props = { active: true, client: fake.client, controller: state, repositoryId: "repo_checkout", selectedTargetKey: "checkout-9", onSelectConversation };
    const { rerender } = render(<GitlabDiscussionsPanel {...props} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation status" }), { target: { value: "resolved" } });
    const request = { requestId: 1, targetKey: "checkout-9", scopeId, discussionId: "general" };
    const mismatch = { ...request, ...(reason === "target" ? { targetKey: "checkout-10" } : reason === "scope" ? { scopeId: "b".repeat(64) } : reason === "missing" ? { discussionId: "missing" } : {}) };
    rerender(<GitlabDiscussionsPanel {...props} active={reason !== "inactive"} revealConversation={mismatch} />);
    expect(screen.getByRole("combobox", { name: "Conversation status" })).toHaveValue("resolved");
    expect(onSelectConversation).not.toHaveBeenCalled();
    expect(state.markRead).not.toHaveBeenCalled();
    rerender(<GitlabDiscussionsPanel {...props} revealConversation={request} />);
    expect(screen.getByRole("button", { name: "General discussion by @priya" })).toHaveAttribute("aria-pressed", "true");
    expect(onSelectConversation).toHaveBeenCalledOnce();
    expect(state.markRead).toHaveBeenLastCalledWith(request.targetKey, scopeId, state.entries[0]!.snapshot!.discussions[0]!.comments);
  });

  it("offers connection settings for an unavailable conversation read", () => {
    const fake = fakeWorkspaceClient();
    const failed = { ...entry(), snapshot: undefined, state: "error" as const, error: "GitLab authentication is required." };
    const onOpenIntegrations = vi.fn();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={controller([failed])} repositoryId="repo_checkout" onOpenIntegrations={onOpenIntegrations} />);
    fireEvent.click(screen.getByRole("button", { name: "Check GitLab connection" }));
    expect(onOpenIntegrations).toHaveBeenCalledOnce();
  });

  it("retries a busy conversation read in place without GitLab settings", () => {
    const fake = fakeWorkspaceClient();
    const failed = { ...entry(), snapshot: undefined, state: "error" as const, error: "WTS is already running the maximum number of local operations. Retry shortly." };
    const state = controller([failed]);
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" onOpenIntegrations={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Check GitLab connection" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry conversations" }));
    expect(state.refresh).toHaveBeenCalledWith(failed.target.key);
  });

  it("opens GitLab to check an uncertain reply without resending the draft", async () => {
    const fake = fakeWorkspaceClient();
    fake.replyGitlabDiscussion.mockRejectedValueOnce(new Error("The response timed out."));
    fake.openGitlabMergeRequest.mockResolvedValue({ repositoryId: "provider_checkout", iid: 9, accepted: true });
    render(<GitlabDiscussionsPanel active client={fake.client} controller={controller()} repositoryId="repo_checkout" />);
    openGeneral(); draft("Check whether this reply arrived.");
    fireEvent.click(screen.getByRole("button", { name: "Reply to GitLab" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open MR in GitLab" }));
    expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith("provider_checkout", 9);
    expect(fake.replyGitlabDiscussion).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Check whether this reply arrived.");
    expect(screen.getByText("Check GitLab before you send this reply again. Your draft is saved here.")).toBeVisible();
  });

  it("shows rendered comments and their replies in a thread feed before selection", () => {
    const fake = fakeWorkspaceClient();
    const first = entry();
    first.snapshot!.discussions[0]!.comments.push(comment(42, "The **retry limit** is three.", "alex"));
    const state = controller([first]);
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    const feed = screen.getByRole("list", { name: "Conversations" });
    const threads = within(feed).getAllByRole("listitem");
    expect(threads).toHaveLength(2);
    expect(within(threads[0]!).getByRole("button", { name: "General discussion by @priya" })).toBeVisible();
    expect(within(threads[0]!).getByText("retry 9")).toHaveProperty("tagName", "STRONG");
    expect(within(threads[0]!).getByText("retry limit")).toHaveProperty("tagName", "STRONG");
    expect(within(threads[1]!).getByText("The retry path has a test.")).toBeVisible();
    expect(screen.queryByText("Please explain **retry 9**.")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
    expect(state.markRead).not.toHaveBeenCalled();
    openGeneral();
    expect(within(threads[0]!).getByRole("textbox", { name: "Reply" })).toBeVisible();
    expect(state.markRead).toHaveBeenLastCalledWith("checkout-9", scopeId, first.snapshot!.discussions[0]!.comments);
  });

  it("previews an unread long automated comment as plain text before it expands", () => {
    const fake = fakeWorkspaceClient();
    const first = entry();
    first.snapshot!.discussions[0] = {
      ...first.snapshot!.discussions[0]!, automated: true,
      comments: [comment(41, `## Automated findings\n\nThe **retry guard** misses a timeout.\n${"More detail. ".repeat(80)}`, "review-bot")],
    };
    first.unreadCommentIds = [41];
    render(<GitlabDiscussionsPanel active client={fake.client} controller={controller([first])} repositoryId="repo_checkout" />);
    expect(screen.getByText(/Automated findings The retry guard misses a timeout\./)).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Automated findings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show automated comment" })).toBeVisible();
  });

  it("collapses a long automated comment until the reader expands its rendered body", () => {
    const fake = fakeWorkspaceClient();
    const first = entry();
    first.snapshot!.discussions[0] = {
      ...first.snapshot!.discussions[0]!, automated: true,
      comments: [comment(41, `<details><summary>Review summary</summary>\n\n## Automated findings\n\n${"The retry guard has a test. ".repeat(30)}\n\n[Unsafe](javascript:alert(1))<script>unsafe()</script></details>`, "review-bot")],
    };
    const state = controller([first]);
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    const toggle = screen.getByRole("button", { name: "Show automated comment" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("heading", { name: "Automated findings" })).not.toBeInTheDocument();
    expect(state.markRead).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(screen.getByRole("heading", { name: "Automated findings" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide automated comment" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("link", { name: "Unsafe" })).not.toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByText(/<details>/)).not.toBeInTheDocument();
    expect(state.markRead).toHaveBeenLastCalledWith("checkout-9", scopeId, first.snapshot!.discussions[0]!.comments);
  });

  it("keeps new replies behind an explicit action in an unselected thread", () => {
    const fake = fakeWorkspaceClient();
    const first = entry();
    const state = controller([first]);
    const { rerender } = render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    const incoming = comment(42, "A new review question.");
    const refreshed = { ...first, snapshot: { ...first.snapshot!, discussions: first.snapshot!.discussions.map((discussion) => discussion.id === "general" ? { ...discussion, comments: [...discussion.comments, incoming] } : discussion) } };
    rerender(<GitlabDiscussionsPanel active client={fake.client} controller={{ ...state, entries: [refreshed] }} repositoryId="repo_checkout" />);
    expect(screen.queryByText(incoming.body)).not.toBeInTheDocument();
    expect(state.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show new replies" }));
    expect(screen.getByText(incoming.body)).toBeVisible();
    expect(state.markRead).toHaveBeenLastCalledWith("checkout-9", scopeId, [comment(41, "Please explain **retry 9**."), incoming]);
  });

  it.each([false, true])("shows one failed-read message without zero counts (compact=%s)", (compact) => {
    const fake = fakeWorkspaceClient();
    const failed = { ...entry(), snapshot: undefined, state: "error" as const, error: "GitLab could not load conversations." };
    const state = controller([failed]);
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" compact={compact} hideTargetSelector />);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(failed.error);
    expect(screen.queryByText(/0 conversations/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Conversations are unavailable/)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Conversation status" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh conversations" }));
    expect(state.refresh).toHaveBeenCalledWith("checkout-9");
  });

  it("counts only this file's conversations and unread comments in compact mode", () => {
    const fake = fakeWorkspaceClient();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={controller()} repositoryId="repo_checkout" filePath="src/checkout.ts" compact hideTargetSelector />);
    expect(screen.getByText("1 conversation · 1 unread comment")).toBeVisible();
    expect(screen.queryByText("2 conversations · 2 unread comments")).not.toBeInTheDocument();
    expect(screen.getByText("The retry path has a test.")).toBeVisible();
  });

  it("closes the compact panel without discarding the reply draft", () => {
    const fake = fakeWorkspaceClient();
    const state = controller();
    const onClose = vi.fn();
    const props = { active: true, client: fake.client, controller: state, repositoryId: "repo_checkout", compact: true, onClose };
    const first = render(<GitlabDiscussionsPanel {...props} />);
    openGeneral();
    draft("Keep this file reply.");
    fireEvent.click(screen.getByRole("button", { name: "Close file conversations" }));
    expect(onClose).toHaveBeenCalledOnce();
    first.unmount();
    render(<GitlabDiscussionsPanel {...props} />);
    openGeneral();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Keep this file reply.");
  });

  it("retains existing reply drafts when the draft limit is reached", () => {
    for (let index = 0; index < 128; index += 1) gitlabDiscussionDrafts.write(`saved-${index}`, `Reply draft ${index}`);
    const fake = fakeWorkspaceClient();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={controller()} repositoryId="repo_checkout" />);
    openGeneral(); draft("A new draft");
    expect(screen.getByRole("alert")).toHaveTextContent("WTS retained your drafts");
    expect(gitlabDiscussionDrafts.read("saved-0")).toBe("Reply draft 0");
    gitlabDiscussionDrafts.write("saved-0", "");
    draft("A new draft");
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("A new draft");
  });

  it("uses the shared MR selection and keeps replies scoped when it changes", () => {
    const fake = fakeWorkspaceClient();
    const state = controller([entry(), entry(10)]);
    const onTargetChange = vi.fn();
    const props = { active: true, client: fake.client, controller: state, repositoryId: "repo_checkout", onTargetChange };
    const { rerender } = render(<GitlabDiscussionsPanel {...props} selectedTargetKey="checkout-10" />);
    openGeneral(); draft("Keep the second MR draft.");
    expect(screen.getByText("retry 10")).toBeVisible();
    selectMr("checkout-9");
    expect(onTargetChange).toHaveBeenCalledWith("checkout-9");
    rerender(<GitlabDiscussionsPanel {...props} selectedTargetKey="checkout-9" />);
    openGeneral();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
    rerender(<GitlabDiscussionsPanel {...props} selectedTargetKey="checkout-10" />);
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Keep the second MR draft.");
  });

  it("shows only the selected file in the code conversation rail", () => {
    const fake = fakeWorkspaceClient();
    const state = controller();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" filePath="src/checkout.ts" compact />);
    expect(screen.queryByRole("button", { name: /General discussion/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /src\/checkout.ts:\+12/ })).toBeVisible();
    expect(state.markRead).not.toHaveBeenCalled();
  });

  it("does not send a second reply after the panel remounts during a pending write", async () => {
    const fake = fakeWorkspaceClient();
    const pending = deferred<GitlabDiscussionReplyResult>();
    fake.replyGitlabDiscussion.mockReturnValueOnce(pending.promise);
    const state = controller();
    const first = render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    openGeneral(); draft("The retry limit is three.");
    fireEvent.click(screen.getByRole("button", { name: "Reply to GitLab" }));
    first.unmount();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    openGeneral();
    expect(screen.getByRole("button", { name: "WTS publishes reply" })).toBeDisabled();
    await act(async () => { pending.resolve(replyResult()); await pending.promise; });
    expect(fake.replyGitlabDiscussion).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
    expect(state.acceptReply).toHaveBeenCalledWith("checkout-9", replyResult(), scopeId);
  });

  it("retains a draft when the Changes view unmounts and remounts", () => {
    const fake = fakeWorkspaceClient();
    const state = controller();
    const first = render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    openGeneral(); draft("Continue this reply after checking the workspace.");
    first.unmount();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    openGeneral();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Continue this reply after checking the workspace.");
    expect(fake.replyGitlabDiscussion).not.toHaveBeenCalled();
  });

  it("shows general and file conversations and acknowledges only the selected snapshot", async () => {
    const fake = fakeWorkspaceClient();
    const state = controller();
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    expect(screen.getByText("2 conversations · 2 unread comments")).toBeVisible();
    const fileThread = screen.getByRole("button", { name: /src\/checkout.ts:\+12/ }).closest("section")!;
    expect(within(fileThread).getByText("Resolved")).toBeVisible();
    expect(within(fileThread).getByText("@alex")).toBeVisible();
    expect(state.markRead).not.toHaveBeenCalled();
    openGeneral();
    expect(screen.getByText("retry 9")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByText("@priya", { selector: "article b" })).toBeVisible();
    expect(document.querySelector("time")).toHaveAttribute("datetime", "2026-09-17T09:00:00Z");
    expect(state.markRead).toHaveBeenCalledWith("checkout-9", scopeId, [comment(41, "Please explain **retry 9**.")]);
    expect(fake.replyGitlabDiscussion).not.toHaveBeenCalled();
  });

  it("retains separate drafts by MR and conversation and retains a failed reply", async () => {
    const fake = fakeWorkspaceClient();
    fake.replyGitlabDiscussion.mockRejectedValueOnce(new Error("GitLab is unavailable."));
    const state = controller([entry(), entry(10), entry(11, "repo_other")]);
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    expect(screen.queryByRole("option", { name: "Checkout !11" })).not.toBeInTheDocument();
    openGeneral();
    draft("My first MR draft");
    fireEvent.click(screen.getByRole("button", { name: /src\/checkout.ts:\+12/ }));
    draft("My file discussion draft");
    openGeneral();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("My first MR draft");
    selectMr("checkout-10");
    openGeneral();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
    draft("My second MR draft");
    selectMr("checkout-9");
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("My first MR draft");
    fireEvent.click(screen.getByRole("button", { name: "Reply to GitLab" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitLab is unavailable.");
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("My first MR draft");
    expect(fake.replyGitlabDiscussion).toHaveBeenCalledTimes(1);
    expect(fake.replyGitlabDiscussion).toHaveBeenCalledWith("provider_checkout", 9, { discussionId: "general", body: "My first MR draft", workspaceId: "ws_checkout" });
    expect(state.acceptReply).not.toHaveBeenCalled();
    selectMr("checkout-10");
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("My second MR draft");
  });

  it("adds an own reply without acknowledging concurrent incoming replies", async () => {
    const fake = fakeWorkspaceClient();
    const pending = deferred<GitlabDiscussionReplyResult>();
    fake.replyGitlabDiscussion.mockReturnValueOnce(pending.promise);
    const original = entry();
    const state = controller([original]);
    const { rerender } = render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    openGeneral();
    vi.mocked(state.markRead).mockClear();
    draft("The retry limit is three.");
    fireEvent.click(screen.getByRole("button", { name: "Reply to GitLab" }));
    const incoming = comment(42, "Please also check the timeout.");
    const refreshed: GitlabConversationEntry = { ...original, unreadCommentIds: [42, 51], snapshot: { ...original.snapshot!, discussions: original.snapshot!.discussions.map((discussion) => discussion.id === "general" ? { ...discussion, comments: [...discussion.comments, incoming] } : discussion) } };
    rerender(<GitlabDiscussionsPanel active client={fake.client} controller={{ ...state, entries: [refreshed] }} repositoryId="repo_checkout" />);
    await act(async () => { pending.resolve(replyResult()); await pending.promise; });
    expect(state.acceptReply).toHaveBeenCalledWith("checkout-9", replyResult(), scopeId);
    expect(screen.getByText("Reply published to GitLab.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
    expect(vi.mocked(state.markRead).mock.calls.flatMap((call) => call[2].map((note) => note.id))).not.toContain(42);
    expect(screen.queryByText(incoming.body)).not.toBeInTheDocument();
    const withOwnReply = { ...refreshed, snapshot: { ...refreshed.snapshot!, discussions: refreshed.snapshot!.discussions.map((discussion) => discussion.id === "general" ? { ...discussion, comments: [...discussion.comments, replyResult().comment] } : discussion) } };
    rerender(<GitlabDiscussionsPanel active client={fake.client} controller={{ ...state, entries: [withOwnReply] }} repositoryId="repo_checkout" />);
    fireEvent.click(screen.getByRole("button", { name: "Show new replies" }));
    expect(screen.getByText(incoming.body)).toBeVisible();
    expect(state.markRead).toHaveBeenLastCalledWith("checkout-9", scopeId, [comment(41, "Please explain **retry 9**."), incoming, replyResult().comment]);
  });

  it("does not acknowledge a hidden document, inactive view, or filtered conversation", () => {
    const fake = fakeWorkspaceClient();
    const state = controller();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { rerender } = render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    openGeneral();
    expect(state.markRead).not.toHaveBeenCalled();
    rerender(<GitlabDiscussionsPanel active={false} client={fake.client} controller={state} repositoryId="repo_checkout" />);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    expect(state.markRead).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation status" }), { target: { value: "resolved" } });
    rerender(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    expect(state.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /src\/checkout.ts:\+12/ }));
    expect(state.markRead).toHaveBeenCalledWith("checkout-9", scopeId, [comment(51, "The retry path has a test.", "alex")]);
  });

  it("keeps a late reply scoped to the original MR and leaves the new draft intact", async () => {
    const fake = fakeWorkspaceClient();
    const pending = deferred<GitlabDiscussionReplyResult>();
    fake.replyGitlabDiscussion.mockReturnValueOnce(pending.promise);
    const state = controller([entry(), entry(10)]);
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    openGeneral(); draft("The retry limit is three.");
    fireEvent.click(screen.getByRole("button", { name: "Reply to GitLab" }));
    selectMr("checkout-10"); openGeneral(); draft("Keep this new draft.");
    await act(async () => { pending.resolve(replyResult()); await pending.promise; });
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Keep this new draft.");
    expect(screen.queryByText("Reply published to GitLab.")).not.toBeInTheDocument();
    expect(state.acceptReply).toHaveBeenCalledWith("checkout-9", replyResult(), scopeId);
    selectMr("checkout-9");
    expect(screen.getByText("Reply published to GitLab.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("");
  });

  it("ignores an old reply after the account scope changes", async () => {
    const fake = fakeWorkspaceClient();
    const pending = deferred<GitlabDiscussionReplyResult>();
    fake.replyGitlabDiscussion.mockReturnValueOnce(pending.promise);
    const state = controller();
    const { rerender } = render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    openGeneral(); draft("The retry limit is three.");
    fireEvent.click(screen.getByRole("button", { name: "Reply to GitLab" }));
    const switched = entry();
    switched.snapshot = { ...switched.snapshot!, scopeId: "b".repeat(64), viewerLogin: "alex" };
    rerender(<GitlabDiscussionsPanel active client={fake.client} controller={{ ...state, entries: [switched] }} repositoryId="repo_checkout" />);
    openGeneral(); draft("The new account draft.");
    await act(async () => { pending.resolve(replyResult()); await pending.promise; });
    expect(state.acceptReply).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("The new account draft.");
    expect(screen.queryByText("Reply published to GitLab.")).not.toBeInTheDocument();
  });

  it("shows stale and partial history without acknowledging it or enabling a reply", () => {
    const fake = fakeWorkspaceClient();
    const stale = entry();
    stale.snapshot = { ...stale.snapshot!, fromCache: true, truncated: true };
    const state = controller([stale]);
    render(<GitlabDiscussionsPanel active client={fake.client} controller={state} repositoryId="repo_checkout" />);
    expect(screen.getByText("Saved comments · Refresh before reply")).toBeVisible();
    expect(screen.getByText("GitLab returned part of this conversation history.")).toBeVisible();
    openGeneral(); draft("Try later.");
    expect(state.markRead).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reply to GitLab" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Refresh conversations" }));
    expect(state.refresh).toHaveBeenCalledWith("checkout-9");
  });
});
