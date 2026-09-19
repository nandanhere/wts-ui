import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type {
  MaterializedWorktree,
  GitlabReviewPatch,
  WorkspaceEvidence,
  WorkspaceMaterialization,
  WorkspaceRepositoryDiff,
} from "../../lib/wtsClient";
import {
  fakeWorkspaceClient,
  workspaceEvidenceFixture,
} from "../../test/workspaceClientFake";
import {
  RepositoryReviewScreen,
  REVIEW_PATCH_POLL_INTERVAL_MS,
} from "./RepositoryReviewScreen";
import type { GitlabConversationsController } from "./gitlabDiscussions";
import { reviewSession } from "./workingChangesState";
import { gitlabDiscussionDrafts } from "./gitlabDiscussionDrafts";

afterEach(() => gitlabDiscussionDrafts.clear());

const baseCommitOid = "0123456789abcdef0123456789abcdef01234567";
const headCommitOid = "fedcba9876543210fedcba9876543210fedcba98";

function worktree(
  repositoryId: string,
  activity?: MaterializedWorktree["activity"],
): MaterializedWorktree {
  return {
    repositoryId,
    label: repositoryId,
    targetDisplayPath: `/tmp/workspace/${repositoryId}`,
    branchName: "wts/review",
    baseCommitOid,
    ...(activity ? { activity } : {}),
  };
}

function materialization(
  workspaceId: string,
  worktrees: MaterializedWorktree[],
): WorkspaceMaterialization {
  return {
    schemaVersion: 1,
    workspaceId,
    workspaceRecordVersion: 1,
    effectDigest: `sha256:${workspaceId}`,
    workspaceDisplayPath: `/tmp/${workspaceId}`,
    codeWorkspaceDisplayPath: `/tmp/${workspaceId}/workspace.code-workspace`,
    branchName: "wts/review",
    worktrees,
    graph: {
      status: "notStarted",
      detail: "The graph is not ready.",
    },
  };
}

function repositoryDiff(
  workspaceId: string,
  repositoryId: string,
  changed = true,
): WorkspaceRepositoryDiff {
  return {
    schemaVersion: 1,
    workspaceId,
    repositoryId,
    repositoryLabel: repositoryId,
    baseCommitOid,
    headCommitOid,
    patchSha256: `sha256:${"a".repeat(64)}`,
    patch: changed
      ? `diff --git a/src/${repositoryId}.ts b/src/${repositoryId}.ts
index 1111111..2222222 100644
--- a/src/${repositoryId}.ts
+++ b/src/${repositoryId}.ts
@@ -1 +1 @@
-export const changed = false;
+export const changed = true;
`
      : "",
    patchTruncated: false,
    untrackedPaths: [],
    untrackedPathsTruncated: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

describe("RepositoryReviewScreen repository selection", () => {
  function unreadController(workspaceId: string): GitlabConversationsController {
    return {
      entries: [15, 16].map((iid) => ({
        target: { key: `nimbus-${iid}`, repositoryId: "provider_nimbus", worktreeRepositoryId: "nimbus-api", iid, label: `team/nimbus-api !${iid}`, workspaceId },
        state: "ready", error: "", unreadCommentIds: iid === 16 ? [160, 161, 162, 163, 164, 165, 166] : [],
        snapshot: {
          schemaVersion: 1, repositoryId: "provider_nimbus", iid, scopeId: String(iid).repeat(32), viewerLogin: "me", fetchedAtUnixMs: 1, fromCache: false, truncated: false,
          discussions: [{ id: `thread-${iid}`, resolvable: true, resolved: true, automated: false, filePath: "src/api.ts", line: 34, side: "additions", comments: Array.from({ length: iid === 16 ? 7 : 1 }, (_, index) => ({ id: iid * 10 + index, body: `MR ${iid} reply ${index + 1}`, authorLogin: "reviewer", createdAt: "2026-09-17T09:00:00Z" })) }],
        },
      })),
      loading: false, error: "", unreadCount: 7, refresh: vi.fn(), markRead: vi.fn(), acceptReply: vi.fn(),
    };
  }

  it("returns to the unread thread file after the user selects another code file", async () => {
    const workspaceId = "ws_unread_return_file"; const fake = fakeWorkspaceClient(); const controller = unreadController(workspaceId); controller.entries = controller.entries.filter(entry => entry.target.iid === 16);
    const local = repositoryDiff(workspaceId, "nimbus-api"); local.patch = local.patch.replaceAll("src/nimbus-api.ts", "src/api.ts") + local.patch.replaceAll("src/nimbus-api.ts", "src/other.ts");
    fake.getWorkspaceGitlabComparison.mockResolvedValue({ schemaVersion: 1, workspaceId, repositoryId: "nimbus-api", repositoryLabel: "nimbus-api", iid: 16, localHeadCommitOid: headCommitOid, status: "ready", published: { schemaVersion: 1, repositoryId: "nimbus-api", iid: 16, baseCommitOid, startCommitOid: baseCommitOid, headCommitOid, patch: local.patch, patchTruncated: false, fromCache: false, fetchedAtUnixMs: 1, commits: [], discussions: [] }, latestWork: local, sinceMr: local });
    reviewSession(fake.client, workspaceId).files["nimbus-api:nimbus-16"] = "src/api.ts";
    render(<RepositoryReviewScreen client={fake.client} workspaceId={workspaceId} materialization={materialization(workspaceId, [worktree("nimbus-api")])} initialRepositoryId="nimbus-api" onOpenVerification={vi.fn()} onRepositoryChange={vi.fn()} gitlabConversations={controller} />);
    fireEvent.click(await screen.findByRole("button", { name: /^src\/other.ts In MR/ })); expect(screen.getByRole("button", { name: /^src\/other.ts In MR/ })).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByRole("button", { name: "Open 7 unread comments in nimbus-api !16" })); await screen.findByRole("button", { name: /src\/api.ts:\+34/ }); fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByRole("button", { name: /^src\/api.ts In MR/ })).toHaveAttribute("aria-current", "true");
  });

  it("omits the single MR selector while keeping repository choice and the exact unread conversation reachable", async () => {
    const workspaceId = "ws_single_mr_controls";
    const fake = fakeWorkspaceClient();
    const controller = unreadController(workspaceId);
    controller.entries = [controller.entries[1]!];
    const onRepositoryChange = vi.fn();
    render(<RepositoryReviewScreen client={fake.client} gitlabConversations={controller} initialRepositoryId="nimbus-api" materialization={materialization(workspaceId, [worktree("jellyfish"), worktree("nimbus-api")])} onRepositoryChange={onRepositoryChange} workspaceId={workspaceId} />);
    expect(screen.queryByRole("combobox", { name: "Merge request" })).not.toBeInTheDocument();
    expect(within(screen.getByTestId("repository-review-toolbar")).getByText("team/nimbus-api !16")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Repository to review" })).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Repository to review" }), { target: { value: "jellyfish" } });
    expect(screen.getByRole("combobox", { name: "Repository to review" })).toHaveValue("jellyfish");
    fireEvent.click(screen.getByRole("button", { name: "Open 7 unread comments in nimbus-api !16" }));
    expect(screen.getByRole("combobox", { name: "Repository to review" })).toHaveValue("nimbus-api");
    expect(await screen.findByText("MR 16 reply 7", { selector: "article p" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Conversations, 7 unread comments" })).toHaveAttribute("aria-selected", "true");
    expect(onRepositoryChange).toHaveBeenLastCalledWith("nimbus-api", "user");
    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    expect(screen.getByRole("combobox", { name: "Code comparison" })).toBeVisible();
  });

  it("returns from an agent result to its exact MR thread instead of the first MR", async () => {
    const workspaceId = "ws_return_feedback_thread";
    const fake = fakeWorkspaceClient();
    const controller = unreadController(workspaceId);
    const target = controller.entries[1]!;
    render(<RepositoryReviewScreen client={fake.client} gitlabConversations={controller}
      initialRepositoryId="jellyfish" materialization={materialization(workspaceId, [worktree("jellyfish"), worktree("nimbus-api")])}
      onRepositoryChange={vi.fn()} workspaceId={workspaceId} feedbackSelectionReturn={{ requestId: "return-16", source: {
        kind: "gitlabDiscussion", workspaceId, repositoryId: "nimbus-api", providerRepositoryId: "provider_nimbus",
        iid: 16, discussionId: "thread-16", scopeId: target.snapshot!.scopeId, comments: target.snapshot!.discussions[0]!.comments,
      } }} />);
    expect(await screen.findByText("MR 16 reply 7", { selector: "article p" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Repository to review" })).toHaveValue("nimbus-api");
    expect(screen.getByRole("combobox", { name: "Merge request" })).toHaveValue("nimbus-16");
    expect(screen.getByRole("tab", { name: "Conversations, 7 unread comments" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("MR 15 reply 1", { selector: "article p" })).not.toBeInTheDocument();
  });

  it("keeps the current review when a saved thread belongs to a different GitLab scope", async () => {
    const workspaceId = "ws_return_changed_scope";
    const fake = fakeWorkspaceClient();
    const controller = unreadController(workspaceId);
    const notice = vi.fn();
    render(<RepositoryReviewScreen client={fake.client} gitlabConversations={controller}
      initialRepositoryId="nimbus-api" materialization={materialization(workspaceId, [worktree("nimbus-api")])}
      onRepositoryChange={vi.fn()} onNotice={notice} workspaceId={workspaceId} feedbackSelectionReturn={{ requestId: "return-old-scope", source: {
        kind: "gitlabDiscussion", workspaceId, repositoryId: "nimbus-api", providerRepositoryId: "provider_nimbus",
        iid: 16, discussionId: "thread-16", scopeId: "old-account", comments: controller.entries[1]!.snapshot!.discussions[0]!.comments,
      } }} />);
    await waitFor(() => expect(notice).toHaveBeenCalledWith(expect.stringContaining("saved conversation is not available"), "error"));
    expect(screen.getByRole("tab", { name: "Code" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "Merge request" })).toHaveValue("nimbus-15");
  });

  it("opens the shared agent chat from a repository conversation with the exact workspace and MR source", async () => {
    const workspaceId = "ws_agent_handoff";
    const fake = fakeWorkspaceClient();
    const controller = unreadController(workspaceId);
    const source = controller.entries[1]!;
    delete source.target.workspaceId;
    source.target.title = "Fix API retries";
    const position = { baseCommitOid: "a".repeat(40), startCommitOid: "b".repeat(40), headCommitOid: "c".repeat(40) };
    source.snapshot!.discussions[0]!.position = position;
    const listener = vi.fn();
    window.addEventListener("wts:agent-feedback-requested", listener);
    try {
      render(<RepositoryReviewScreen client={fake.client} gitlabConversations={controller} initialRepositoryId="jellyfish" materialization={materialization(workspaceId, [worktree("jellyfish"), worktree("nimbus-api")])} onRepositoryChange={vi.fn()} workspaceId={workspaceId} />);
      fireEvent.click(screen.getByRole("button", { name: "Open 7 unread comments in nimbus-api !16" }));
      fireEvent.click(await screen.findByRole("button", { name: "Ask agent to fix" }));
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]![0].detail).toEqual({
        kind: "gitlabDiscussion", workspaceId, repositoryId: "nimbus-api", providerRepositoryId: "provider_nimbus", iid: 16, discussionId: "thread-16", scopeId: "16".repeat(32), mergeRequestLabel: "team/nimbus-api !16", title: "Fix API retries", filePath: "src/api.ts", side: "additions", line: 34, position,
        resolved: true, automated: false, comments: source.snapshot!.discussions[0]!.comments, fetchedAtUnixMs: 1, fromCache: false, truncated: false,
      });
      expect(fake.replyGitlabDiscussion).not.toHaveBeenCalled();
      expect(fake.publishGitlabReviewComment).not.toHaveBeenCalled();
    } finally { window.removeEventListener("wts:agent-feedback-requested", listener); }
  });

  it.each(["jellyfish", "nimbus-api"])("opens the exact unread MR from %s without changing code selection first", async (selectedRepository) => {
    const user = userEvent.setup();
    const workspaceId = `ws_unread_${selectedRepository}`;
    const fake = fakeWorkspaceClient();
    const controller = unreadController(workspaceId);
    const onRepositoryChange = vi.fn();
    render(<RepositoryReviewScreen client={fake.client} gitlabConversations={controller} initialRepositoryId={selectedRepository} materialization={materialization(workspaceId, [worktree("jellyfish"), worktree("nimbus-api")])} onRepositoryChange={onRepositoryChange} workspaceId={workspaceId} />);
    const inbox = screen.getByRole("navigation", { name: "Unread MR comments" });
    expect(inbox).toHaveTextContent("7 unread comments");
    expect(screen.getByRole("combobox", { name: "Repository to review" })).toHaveValue(selectedRepository);
    await user.click(screen.getByRole("combobox", { name: "Repository to review" }));
    expect(await screen.findByRole("option", { name: "nimbus-api · 7 unread" })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("tab", { name: "Conversations" })).not.toHaveTextContent("7");
    expect(controller.markRead).not.toHaveBeenCalled();
    fireEvent.click(within(inbox).getByRole("button", { name: "Open 7 unread comments in nimbus-api !16" }));
    expect(screen.getByRole("combobox", { name: "Repository to review" })).toHaveValue("nimbus-api");
    expect(screen.getByRole("combobox", { name: "Merge request" })).toHaveValue("nimbus-16");
    expect(screen.getByRole("tab", { name: "Conversations, 7 unread comments" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("MR 16 reply 7", { selector: "article p" })).toBeVisible();
    expect(onRepositoryChange).toHaveBeenCalledWith("nimbus-api", "user");
    await waitFor(() => expect(controller.markRead).toHaveBeenCalled());
    for (const [target, scope, comments] of vi.mocked(controller.markRead).mock.calls) {
      expect(target).toBe("nimbus-16");
      expect(scope).toBe("16".repeat(32));
      expect(comments.map((comment) => comment.id)).toEqual([160, 161, 162, 163, 164, 165, 166]);
    }
  });

  it("keeps saved unread comments reachable after a refresh fails without marking them read", async () => {
    const workspaceId = "ws_unread_cached";
    const fake = fakeWorkspaceClient();
    const controller = unreadController(workspaceId);
    const entry = controller.entries[1]!;
    entry.state = "error";
    entry.error = "GitLab is unavailable.";
    entry.snapshot!.fromCache = true;
    render(<RepositoryReviewScreen client={fake.client} gitlabConversations={controller} initialRepositoryId="jellyfish" materialization={materialization(workspaceId, [worktree("jellyfish"), worktree("nimbus-api")])} onRepositoryChange={vi.fn()} workspaceId={workspaceId} />);
    fireEvent.click(screen.getByRole("button", { name: "Open 7 unread comments in nimbus-api !16" }));
    expect(await screen.findByText("MR 16 reply 7", { selector: "article p" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reply to GitLab" })).toBeDisabled();
    expect(controller.markRead).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Refresh conversations" })).toBeEnabled();
  });

  it("offers workspace repair after a local changes read fails", async () => {
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockRejectedValue(new Error("The worktree moved or changed."));
    const onOpenWorkspaceStatus = vi.fn();
    render(<RepositoryReviewScreen client={fake.client} materialization={materialization("ws_repair", [worktree("repo_api")])} onRepositoryChange={vi.fn()} workspaceId="ws_repair" onOpenWorkspaceStatus={onOpenWorkspaceStatus} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open workspace status" }));
    expect(onOpenWorkspaceStatus).toHaveBeenCalledOnce();
    expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledOnce();
  });

  it("keeps the MR title and branch context while switching review tabs", async () => {
    const fake = fakeWorkspaceClient();
    const target = { key: "mr16", repositoryId: "repo_api", worktreeRepositoryId: "repo_api", iid: 16, label: "team/api !16", title: "Add one-time boot profiles", sourceBranch: "feat/boot", targetBranch: "main", status: "open" as const, authorLogin: "nandan" };
    const controller: GitlabConversationsController = { entries: [{ target, state: "error", error: "Unavailable", unreadCommentIds: [] }], loading: false, error: "", unreadCount: 0, refresh: vi.fn(), markRead: vi.fn(), acceptReply: vi.fn() };
    render(<RepositoryReviewScreen client={fake.client} gitlabConversations={controller} materialization={materialization("ws_title", [worktree("repo_api")])} onRepositoryChange={vi.fn()} workspaceId="ws_title" />);
    expect(screen.getByRole("heading", { name: target.title })).toBeVisible();
    expect(screen.getByText("feat/boot")).toBeVisible();
    expect(screen.getByText("main")).toBeVisible();
    const conversations = screen.getByRole("tab", { name: "Conversations" });
    expect(conversations).not.toHaveTextContent("0");
    fireEvent.click(conversations);
    expect(screen.getByRole("heading", { name: target.title })).toBeVisible();
  });

  it("shares the MR selection between code and conversations and restores it on return", async () => {
    const workspaceId = "ws_shared_mr";
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceGitlabComparison.mockImplementation(async (workspace, repository, iid) => ({
      schemaVersion: 1, workspaceId: workspace, repositoryId: repository, repositoryLabel: repository, iid,
      localHeadCommitOid: headCommitOid, status: "ready",
      published: { schemaVersion: 1, repositoryId: repository, iid, baseCommitOid, startCommitOid: baseCommitOid, headCommitOid, commits: [], discussions: [], patch: repositoryDiff(workspace, repository).patch, patchTruncated: false, fromCache: false, fetchedAtUnixMs: 1 },
      latestWork: repositoryDiff(workspace, repository),
      sinceMr: { ...repositoryDiff(workspace, repository), baseCommitOid: headCommitOid },
    }));
    const conversations: GitlabConversationsController = {
      entries: [9, 10].map((iid) => ({
        target: { key: `checkout-${iid}`, repositoryId: "provider_checkout", worktreeRepositoryId: "repo_checkout", iid, label: `Checkout !${iid}`, workspaceId }, state: "ready", error: "", unreadCommentIds: [],
        snapshot: { schemaVersion: 1, repositoryId: "provider_checkout", iid, scopeId: "a".repeat(64), viewerLogin: "me", fetchedAtUnixMs: 1, fromCache: false, truncated: false, discussions: [{ id: `thread-${iid}`, resolvable: false, resolved: false, automated: false, comments: [{ id: iid, body: `MR ${iid} conversation`, authorLogin: "priya", createdAt: "2026-09-17T09:00:00Z" }] }] },
      })), loading: false, error: "", unreadCount: 0, refresh: vi.fn(), markRead: vi.fn(), acceptReply: vi.fn(),
    };
    const props = { client: fake.client, gitlabConversations: conversations, initialRepositoryId: "repo_checkout", materialization: materialization(workspaceId, [worktree("repo_checkout")]), onRepositoryChange: vi.fn(), workspaceId };
    const first = render(<RepositoryReviewScreen {...props} />);
    await waitFor(() => expect(fake.getWorkspaceGitlabComparison).toHaveBeenCalledWith(workspaceId, "repo_checkout", 9, false));
    fireEvent.change(screen.getByRole("combobox", { name: "Merge request" }), { target: { value: "checkout-10" } });
    await waitFor(() => expect(fake.getWorkspaceGitlabComparison).toHaveBeenCalledWith(workspaceId, "repo_checkout", 10, false));
    fireEvent.click(screen.getByRole("tab", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: /General discussion/ }));
    expect(screen.getByText("MR 10 conversation", { selector: "article p" })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value: "Keep the shared MR reply." } });
    first.unmount();
    render(<RepositoryReviewScreen {...props} />);
    expect(screen.getByRole("tab", { name: "Conversations" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("combobox", { name: "Merge request" })).toHaveValue("checkout-10");
    fireEvent.click(screen.getByRole("button", { name: /General discussion/ }));
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Keep the shared MR reply.");
    const ids = [...document.querySelectorAll("[data-ui]")].map((element) => element.getAttribute("data-ui"));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ignores discussions from an obsolete provider request after switching merge requests", async () => {
    const workspaceId = "ws_review_race";
    const fake = fakeWorkspaceClient();
    const old = deferred<GitlabReviewPatch>();
    const patch = (repositoryId: string, iid: number, body: string): GitlabReviewPatch => ({
      schemaVersion: 1, repositoryId, iid, baseCommitOid, startCommitOid: baseCommitOid, headCommitOid,
      commits: [],
      discussions: [{ id: `discussion-${iid}`, resolvable: false, resolved: false, automated: false, comments: [{ id: iid, body, authorLogin: "priya", createdAt: "2026-09-17T09:00:00Z" }] }],
      patch: repositoryDiff(workspaceId, "repo_review").patch,
      patchTruncated: false, fromCache: false, fetchedAtUnixMs: 1,
    });
    fake.getGitlabReviewPatch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(patch("provider_new", 10, "New MR feedback"));
    const props = { client: fake.client, initialRepositoryId: "repo_review", materialization: materialization(workspaceId, [worktree("repo_review")]), onRepositoryChange: () => undefined, workspaceId };
    const { rerender } = render(<RepositoryReviewScreen {...props} gitlabReview={{ repositoryId: "provider_old", number: 9, repository: "platform/repo_review" }} />);
    await waitFor(() => expect(fake.getGitlabReviewPatch).toHaveBeenCalledWith("provider_old", 9));
    rerender(<RepositoryReviewScreen {...props} gitlabReview={{ repositoryId: "provider_new", number: 10, repository: "platform/repo_review" }} />);
    expect(await screen.findByText("New MR feedback")).toBeVisible();
    await act(async () => { old.resolve(patch("provider_old", 9, "Old MR feedback")); await old.promise; });
    expect(screen.getByText("New MR feedback")).toBeVisible();
    expect(screen.queryByText("Old MR feedback")).not.toBeInTheDocument();
  });

  it.each(["loading", "empty", "error"] as const)("opens GitLab conversations while the local diff is %s", async (diffState) => {
    const workspaceId = "ws_conversations";
    const fake = fakeWorkspaceClient();
    const pendingLocalDiff = deferred<WorkspaceRepositoryDiff>();
    if (diffState === "loading") {
      fake.getWorkspaceRepositoryDiff.mockImplementation((_, repositoryId) => repositoryId === "repo_checkout"
        ? pendingLocalDiff.promise
        : Promise.resolve(repositoryDiff(workspaceId, repositoryId)));
    } else if (diffState === "error") {
      fake.getWorkspaceRepositoryDiff.mockRejectedValue(new Error("Local diff unavailable"));
    } else {
      fake.getWorkspaceRepositoryDiff.mockResolvedValue(repositoryDiff(workspaceId, "repo_checkout", false));
    }
    const conversations: GitlabConversationsController = {
      entries: [{
        target: { key: "checkout-9", repositoryId: "provider_checkout", worktreeRepositoryId: "repo_checkout", iid: 9, label: "Checkout !9", workspaceId },
        state: "ready",
        error: "",
        unreadCommentIds: [41],
        snapshot: {
          schemaVersion: 1,
          repositoryId: "provider_checkout",
          iid: 9,
          scopeId: "a".repeat(64),
          viewerLogin: "nandan",
          fetchedAtUnixMs: 1,
          fromCache: false,
          truncated: false,
          discussions: [{
            id: "discussion-general",
            resolvable: false,
            resolved: false,
            automated: false,
            comments: [{ id: 41, body: "Please explain the retry limit.", authorLogin: "priya", createdAt: "2026-09-17T09:00:00Z" }],
          }],
        },
      }],
      loading: false,
      error: "",
      unreadCount: 1,
      refresh: vi.fn(),
      markRead: vi.fn(),
      acceptReply: vi.fn(),
    };
    render(<RepositoryReviewScreen
      client={fake.client}
      gitlabConversations={conversations}
      initialRepositoryId={diffState === "loading" ? undefined : "repo_checkout"}
      materialization={materialization(workspaceId, [worktree("repo_checkout"), worktree("repo_other")])}
      onRepositoryChange={() => undefined}
      workspaceId={workspaceId}
    />);
    expect(conversations.markRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: /Conversations.*1 unread/i }));
    fireEvent.click(await screen.findByRole("button", { name: /General discussion/i }));
    expect(await screen.findByRole("textbox", { name: "Reply" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Reply to GitLab" })).toBeDisabled();
    await waitFor(() => expect(conversations.markRead).toHaveBeenCalledWith(
      "checkout-9", "a".repeat(64), conversations.entries[0]!.snapshot!.discussions[0]!.comments,
    ));
    if (diffState === "loading") {
      await act(async () => { pendingLocalDiff.resolve(repositoryDiff(workspaceId, "repo_checkout", false)); await pendingLocalDiff.promise; });
      expect(screen.getByRole("combobox", { name: "Repository to review" })).toHaveValue("repo_checkout");
      expect(screen.getByRole("textbox", { name: "Reply" })).toBeVisible();
    }
    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), { target: { value: "Keep my reply draft." } });
    fireEvent.keyDown(screen.getByRole("tab", { name: /Conversations/ }), { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Code" })).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Reply" })).not.toBeInTheDocument();
    vi.mocked(conversations.markRead).mockClear();
    fireEvent(document, new Event("visibilitychange"));
    expect(conversations.markRead).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Code" }), { key: "ArrowRight" });
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue("Keep my reply draft.");
  });

  it("keeps the loaded review mounted while the background poll checks GitLab", async () => {
    const workspaceId = "ws_stable_gitlab_review";
    const fake = fakeWorkspaceClient();
    let poll: (() => void) | undefined;
    const interval = vi
      .spyOn(window, "setInterval")
      .mockImplementation(
        ((handler: unknown, timeout?: number) => {
          if (
            timeout === REVIEW_PATCH_POLL_INTERVAL_MS &&
            typeof handler === "function"
          ) {
            poll = handler as () => void;
          }
          return 1;
        }) as unknown as typeof window.setInterval,
      );
    const firstPatch: GitlabReviewPatch = {
      schemaVersion: 1,
      repositoryId: "provider_bmc_api",
      iid: 24,
      baseCommitOid,
      startCommitOid: baseCommitOid,
      headCommitOid,
      commits: [],
      discussions: [],
      patch: repositoryDiff(workspaceId, "repo_review").patch,
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1_787_134_945_000,
    };
    fake.getGitlabReviewPatch.mockResolvedValueOnce(firstPatch);

    render(
      <RepositoryReviewScreen
        client={fake.client}
        gitlabReview={{
          id: "review-24",
          repositoryId: "provider_bmc_api",
          repository: "sre-tools/bmc-api",
          number: 24,
          title: "Validate Redfish sessions",
          authorLogin: "priya",
          sourceBranch: "SRETOOLS-7217",
          targetBranch: "develop",
          updatedAt: "2026-08-21T06:00:00Z",
          draft: false,
          reviewState: "requested",
          status: "open",
        }}
        initialRepositoryId="repo_review"
        materialization={materialization(workspaceId, [
          { ...worktree("repo_review"), label: "bmc-api" },
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("sre-tools/bmc-api changes")).toBeVisible();
    expect(screen.getByTestId("patch-review-scroll")).toBeVisible();

    const refresh = deferred<GitlabReviewPatch>();
    fake.getGitlabReviewPatch.mockReturnValueOnce(refresh.promise);
    act(() => poll?.());

    await waitFor(() => expect(fake.getGitlabReviewPatch).toHaveBeenCalledTimes(2));
    expect(screen.getByText("sre-tools/bmc-api changes")).toBeVisible();
    expect(screen.getByTestId("patch-review-scroll")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Checking GitLab" }),
    ).toBeDisabled();

    refresh.resolve(firstPatch);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check for new commits" }),
      ).toBeEnabled(),
    );
    interval.mockRestore();
  });

  it("loads the provider patch for a matching GitLab review workspace", async () => {
    const workspaceId = "ws_gitlab_review";
    const fake = fakeWorkspaceClient();
    fake.getGitlabReviewPatch.mockResolvedValue({
      schemaVersion: 1,
      repositoryId: "provider_obx_api",
      iid: 9,
      baseCommitOid,
      startCommitOid: baseCommitOid,
      headCommitOid,
      commits: [{
        oid: "c".repeat(40),
        parentOid: baseCommitOid,
        shortId: "cccccccc",
        title: "Refactor logging",
        authorName: "Priya",
        authoredAt: "2026-08-19T09:00:00Z",
      }],
      discussions: [],
      patch: repositoryDiff(workspaceId, "repo_review").patch,
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1_787_134_945_000,
    });

    render(
      <RepositoryReviewScreen
        client={fake.client}
        gitlabReview={{
          id: "99",
          repositoryId: "provider_obx_api",
          repository: "sre-tools/obx-api",
          number: 9,
          title: "Validate offset",
          authorLogin: "priya",
          sourceBranch: "SRETOOLS-6349",
          targetBranch: "develop",
          updatedAt: "2026-08-18T06:00:00Z",
          draft: false,
          reviewState: "requested",
          status: "open",
        }}
        initialRepositoryId="repo_review"
        materialization={materialization(workspaceId, [
          { ...worktree("repo_review"), label: "obx-api" },
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("sre-tools/obx-api changes")).toBeVisible();
    expect(fake.getGitlabReviewPatch).toHaveBeenCalledWith(
      "provider_obx_api",
      9,
    );
    expect(fake.getWorkspaceRepositoryDiff).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "GitLab MR !9 · Select a changed line to comment in GitLab.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Comment on a changed line.")).toBeVisible();
    fake.getGitlabReviewPatch.mockResolvedValueOnce({
      schemaVersion: 1,
      repositoryId: "provider_obx_api",
      iid: 9,
      baseCommitOid,
      startCommitOid: baseCommitOid,
      headCommitOid: "d".repeat(40),
      commits: [
        {
          oid: "d".repeat(40),
          parentOid: "c".repeat(40),
          shortId: "dddddddd",
          title: "Adjust logging again",
          authorName: "Priya",
          authoredAt: "2026-08-20T09:00:00Z",
        },
        {
          oid: "c".repeat(40),
          parentOid: baseCommitOid,
          shortId: "cccccccc",
          title: "Refactor logging",
          authorName: "Priya",
          authoredAt: "2026-08-19T09:00:00Z",
        },
      ],
      discussions: [],
      patch: repositoryDiff(workspaceId, "repo_review").patch,
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1_787_221_345_000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for new commits" }));
    await waitFor(() => expect(fake.getGitlabReviewPatch).toHaveBeenLastCalledWith(
      "provider_obx_api",
      9,
      undefined,
      true,
    ));
    expect(await screen.findByText("New changes loaded at dddddddd.")).toBeVisible();
    expect(screen.getByText("2 commits")).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Merge request changes" }), {
      target: { value: "c".repeat(40) },
    });
    await waitFor(() => expect(fake.getGitlabReviewPatch).toHaveBeenLastCalledWith(
      "provider_obx_api",
      9,
      "c".repeat(40),
    ));
  });

  it("requests the first repository with observed activity without probing a clean repo", async () => {
    const workspaceId = "ws_activity";
    const fake = fakeWorkspaceClient();
    const onRepositoryChange = vi.fn();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (requestedWorkspaceId, repositoryId) =>
        repositoryDiff(requestedWorkspaceId, repositoryId),
    );

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization(workspaceId, [
          worktree("repo_clean", { changedFileCount: 0, commitsAhead: 0 }),
          worktree("repo_changed", { changedFileCount: 3, commitsAhead: 0 }),
        ])}
        onRepositoryChange={onRepositoryChange}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("repo_changed changes")).toBeVisible();
    expect(fake.getWorkspaceRepositoryDiff.mock.calls).toEqual([
      [workspaceId, "repo_changed"],
    ]);
    expect(onRepositoryChange).toHaveBeenCalledOnce();
    expect(onRepositoryChange).toHaveBeenCalledWith("repo_changed", "automatic");
    expect(
      screen.getByRole("combobox", { name: "Repository to review" }),
    ).toHaveValue("repo_changed");
  });

  it("checks every repository when the activity snapshot reports no changes", async () => {
    const workspaceId = "ws_clean";
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (requestedWorkspaceId, repositoryId) =>
        repositoryDiff(requestedWorkspaceId, repositoryId, false),
    );

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization(workspaceId, [
          worktree("repo_one", { changedFileCount: 0, commitsAhead: 0 }),
          worktree("repo_two", { changedFileCount: 0, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("No local changes")).toBeVisible();
    expect(fake.getWorkspaceRepositoryDiff.mock.calls).toEqual([
      [workspaceId, "repo_one"],
      [workspaceId, "repo_two"],
    ]);
  });

  it("does not report an untracked-only repository as clean", async () => {
    const workspaceId = "ws_untracked";
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValue({
      ...repositoryDiff(workspaceId, "repo_untracked", false),
      untrackedPaths: ["src/new-worker.ts"],
    });

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization(workspaceId, [
          worktree("repo_untracked", { changedFileCount: 1, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("Untracked files need review")).toBeVisible();
    expect(screen.getByText("src/new-worker.ts")).toBeVisible();
    expect(screen.queryByText("No local changes")).not.toBeInTheDocument();
  });

  it("stops an obsolete repository probe when the workspace changes", async () => {
    const oldRequest = deferred<WorkspaceRepositoryDiff>();
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (workspaceId, repositoryId) => {
        if (workspaceId === "ws_old" && repositoryId === "repo_old_one") {
          return oldRequest.promise;
        }
        return repositoryDiff(workspaceId, repositoryId);
      },
    );
    const { rerender } = render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization("ws_old", [
          worktree("repo_old_one"),
          worktree("repo_old_two"),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId="ws_old"
      />,
    );

    await waitFor(() =>
      expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledWith(
        "ws_old",
        "repo_old_one",
      ),
    );
    rerender(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization("ws_new", [
          worktree("repo_new", { changedFileCount: 1, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId="ws_new"
      />,
    );

    expect(await screen.findByText("repo_new changes")).toBeVisible();
    await act(async () => {
      oldRequest.resolve(repositoryDiff("ws_old", "repo_old_one", false));
      await oldRequest.promise;
    });

    expect(fake.getWorkspaceRepositoryDiff).not.toHaveBeenCalledWith(
      "ws_old",
      "repo_old_two",
    );
    expect(screen.getByText("repo_new changes")).toBeVisible();
  });

  it("stops an obsolete probe after its in-flight request fails", async () => {
    const oldRequest = deferred<WorkspaceRepositoryDiff>();
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (workspaceId, repositoryId) => {
        if (workspaceId === "ws_old" && repositoryId === "repo_old_one") {
          return oldRequest.promise;
        }
        return repositoryDiff(workspaceId, repositoryId);
      },
    );
    const { rerender } = render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization("ws_old", [
          worktree("repo_old_one"),
          worktree("repo_old_two"),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId="ws_old"
      />,
    );

    await waitFor(() =>
      expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledWith(
        "ws_old",
        "repo_old_one",
      ),
    );
    rerender(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization("ws_new", [
          worktree("repo_new", { changedFileCount: 1, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId="ws_new"
      />,
    );

    expect(await screen.findByText("repo_new changes")).toBeVisible();
    await act(async () => {
      oldRequest.reject(new Error("The old request failed."));
      await oldRequest.promise.catch(() => undefined);
    });

    expect(fake.getWorkspaceRepositoryDiff).not.toHaveBeenCalledWith(
      "ws_old",
      "repo_old_two",
    );
    expect(screen.getByText("repo_new changes")).toBeVisible();
  });

  it("keeps review context in one compact toolbar without a second brief surface", async () => {
    const workspaceId = "ws_review_brief";
    const evidenceRequest = deferred<WorkspaceEvidence | null>();
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (requestedWorkspaceId, repositoryId) =>
        repositoryDiff(requestedWorkspaceId, repositoryId),
    );
    fake.getWorkspaceEvidence.mockReturnValue(evidenceRequest.promise);
    const evidence = workspaceEvidenceFixture();

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={materialization(workspaceId, [
          worktree("repo_changed", { changedFileCount: 1, commitsAhead: 0 }),
        ])}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("repo_changed changes")).toBeVisible();
    expect(screen.getByTestId("repository-review-toolbar")).toBeVisible();
    expect(await screen.findByText("WTS checks review context")).toBeVisible();
    expect(screen.queryByLabelText("Agent review brief")).not.toBeInTheDocument();

    await act(async () => {
      evidenceRequest.resolve({
        ...evidence,
        agentReport: {
          ...evidence.agentReport,
          status: "ready",
          summary: "Review the retry boundary before the formatter change.",
          nextActions: [
            "Review the request retry state first.",
            "Should this fallback remain enabled for old clients?",
          ],
          findings: [
            {
              id: "retry-risk",
              title: "A retry can submit the request twice",
              detail: "The timeout branch retains the old request token.",
              severity: "warning",
              repositoryId: "repo_changed",
              evidence: ["src/repo_changed.ts:12"],
            },
          ],
        },
      });
      await evidenceRequest.promise;
    });

    expect(await screen.findByLabelText("1 reported risk")).toBeVisible();
    expect(screen.getByTestId("repository-review-toolbar")).toContainElement(
      screen.getByLabelText("1 reported risk"),
    );
    expect(screen.queryByText("Agent review brief")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show brief" })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Review the request retry state first."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("A retry can submit the request twice"),
    ).not.toBeInTheDocument();

  });

  it("requests graph context only after the selected patch is visible", async () => {
    const workspaceId = "ws_lazy_graph";
    const patchRequest = deferred<WorkspaceRepositoryDiff>();
    const graphRequest = deferred<null>();
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockReturnValue(patchRequest.promise);
    fake.getWorkspaceRepositoryReviewGraph.mockReturnValue(graphRequest.promise);
    const readyMaterialization = {
      ...materialization(workspaceId, [
        worktree("repo_changed", { changedFileCount: 1, commitsAhead: 0 }),
      ]),
      graph: {
        status: "ready" as const,
        detail: "The graph is ready.",
      },
    };

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={readyMaterialization}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(fake.getWorkspaceRepositoryReviewGraph).not.toHaveBeenCalled();
    await act(async () => {
      patchRequest.resolve(repositoryDiff(workspaceId, "repo_changed"));
      await patchRequest.promise;
    });

    expect(await screen.findByText("repo_changed changes")).toBeVisible();
    expect(screen.getAllByText("src/repo_changed.ts")).not.toHaveLength(0);
    expect(fake.getWorkspaceRepositoryReviewGraph).toHaveBeenCalledWith(
      workspaceId,
      "repo_changed",
    );

    await act(async () => {
      graphRequest.resolve(null);
      await graphRequest.promise;
    });
  });

  it("keeps graph context returned with the patch without requesting it twice", async () => {
    const workspaceId = "ws_inline_graph";
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceRepositoryDiff.mockResolvedValue({
      ...repositoryDiff(workspaceId, "repo_changed"),
      reviewGraph: {
        graphSha256: "sha256:inline-graph",
        nodes: [
          {
            id: "retry-request",
            label: "Retry request",
            sourceFile: "src/repo_changed.ts",
            sourceLocation: "src/repo_changed.ts:1",
          },
        ],
        links: [],
        truncated: false,
      },
    });

    render(
      <RepositoryReviewScreen
        client={fake.client}
        materialization={{
          ...materialization(workspaceId, [
            worktree("repo_changed", { changedFileCount: 1, commitsAhead: 0 }),
          ]),
          graph: {
            status: "ready",
            detail: "The graph is ready.",
          },
        }}
        onRepositoryChange={() => undefined}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("repo_changed changes")).toBeVisible();
    expect(fake.getWorkspaceRepositoryReviewGraph).not.toHaveBeenCalled();
  });
});
