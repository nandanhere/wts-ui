import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CodeChangeReviewTarget,
  GitlabReviewPatch,
  WorkspaceReviewThread,
} from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { CodeReviewFeedbackPanel } from "./CodeReviewFeedbackPanel";
import { gitlabDiscussionDrafts } from "./gitlabDiscussionDrafts";

afterEach(() => gitlabDiscussionDrafts.clear());

const workspaceId = "11111111-1111-4111-8111-111111111111";
const target: CodeChangeReviewTarget = {
  kind: "codeChange",
  repositoryId: "repo_checkout",
  baseCommitOid: "a".repeat(40),
  headCommitOid: "b".repeat(40),
  patchSha256: `sha256:${"c".repeat(64)}`,
  filePath: "src/checkout.ts",
  side: "additions",
  line: 12,
};

function thread(
  overrides: Partial<WorkspaceReviewThread> = {},
): WorkspaceReviewThread {
  return {
    threadId: "22222222-2222-4222-8222-222222222222",
    workspaceId,
    target,
    anchorState: "current",
    state: "open",
    revision: 1,
    comments: [
      {
        commentId: "33333333-3333-4333-8333-333333333333",
        author: "user",
        body: "Explain the retry branch.",
        createdAtUnixMs: 10,
      },
    ],
    createdAtUnixMs: 10,
    updatedAtUnixMs: 10,
    ...overrides,
  };
}

describe("CodeReviewFeedbackPanel", () => {
  it.each(["mr", "scope", "client"] as const)("ignores an old publication refresh before handing the current %s context to the agent", async (change) => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });
    const onAskAgentToFix = vi.fn();
    const expectedPosition = { baseCommitOid: target.baseCommitOid, startCommitOid: target.baseCommitOid, headCommitOid: target.headCommitOid };
    const comment = { id: 41, body: "Old MR request.", authorLogin: "priya", createdAt: "2026-09-18T09:00:00Z" };
    const oldThread = { id: "old-thread", resolvable: true, resolved: false, automated: false, filePath: target.filePath, side: target.side, line: target.line, position: expectedPosition, comments: [comment] };
    const previous = { repositoryId: "provider_checkout", iid: 9, scopeId: "a".repeat(64), expectedPosition, discussions: [oldThread] };
    let resolvePatch!: (patch: GitlabReviewPatch) => void;
    fake.publishGitlabReviewComment.mockResolvedValue({ schemaVersion: 1, repositoryId: previous.repositoryId, iid: previous.iid, accepted: true });
    fake.getGitlabReviewPatch.mockReturnValue(new Promise((resolve) => { resolvePatch = resolve; }));
    const props = { client: fake.client, repositoryId: target.repositoryId, workspaceId, selectedTarget: target, onAskAgentToFix };
    const { rerender } = render(<CodeReviewFeedbackPanel {...props} gitlabReview={previous} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Publish on the old thread." } });
    fireEvent.click(screen.getByRole("button", { name: "Publish to GitLab" }));
    await waitFor(() => expect(fake.getGitlabReviewPatch).toHaveBeenCalledOnce());
    const next = { ...previous, ...(change === "mr" ? { iid: 10 } : change === "scope" ? { scopeId: "b".repeat(64) } : {}), discussions: [{ ...oldThread, id: "new-thread", comments: [{ ...comment, id: 51, body: "Current MR request." }] }] };
    const nextClient = change === "client" ? fakeWorkspaceClient().client : fake.client;
    rerender(<CodeReviewFeedbackPanel {...props} client={nextClient} gitlabReview={next} />);
    expect(await screen.findByText("Current MR request.")).toBeVisible();
    await act(async () => { resolvePatch({ schemaVersion: 1, repositoryId: previous.repositoryId, iid: previous.iid, ...expectedPosition, commits: [], discussions: [oldThread], patch: "", patchTruncated: false, fromCache: false, fetchedAtUnixMs: 1 }); });
    fireEvent.click(screen.getByRole("button", { name: "Ask agent to fix" }));
    expect(onAskAgentToFix).toHaveBeenLastCalledWith(expect.objectContaining({ iid: next.iid, scopeId: next.scopeId, discussionId: "new-thread", comments: next.discussions[0]!.comments }));
    expect(screen.queryByText("Old MR request.")).not.toBeInTheDocument();
    expect(fake.publishGitlabReviewComment).toHaveBeenCalledOnce();
  });

  it.each([false, true])("hands an existing inline GitLab thread to the agent with the thread's original version (automated=%s)", async (automated) => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });
    const onAskAgentToFix = vi.fn();
    const originalPosition = { baseCommitOid: "d".repeat(40), startCommitOid: "e".repeat(40), headCommitOid: "f".repeat(40) };
    const comments = [{ id: 41, body: "Fix the original retry branch.", authorLogin: automated ? "review-bot" : "priya", createdAt: "2026-09-18T09:00:00Z" }, { id: 42, body: "Include this follow-up case.", authorLogin: "alex", createdAt: "2026-09-18T09:01:00Z" }];
    render(<CodeReviewFeedbackPanel client={fake.client} repositoryId={target.repositoryId} selectedTarget={target} workspaceId={workspaceId} onAskAgentToFix={onAskAgentToFix} gitlabReview={{ repositoryId: "provider_checkout", iid: 9, scopeId: "a".repeat(64), expectedPosition: { baseCommitOid: target.baseCommitOid, startCommitOid: target.baseCommitOid, headCommitOid: target.headCommitOid }, discussions: [{ id: "original-thread", resolvable: !automated, resolved: false, automated, filePath: target.filePath, side: target.side, line: target.line, position: originalPosition, comments }] }} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Keep this pending GitLab comment." } });
    if (automated) fireEvent.click((await screen.findByText("Show")).closest("summary")!);
    fireEvent.click(await screen.findByRole("button", { name: "Ask agent to fix" }));
    expect(onAskAgentToFix).toHaveBeenCalledOnce();
    expect(onAskAgentToFix).toHaveBeenCalledWith(expect.objectContaining({ kind: "gitlabDiscussion", workspaceId, repositoryId: target.repositoryId, providerRepositoryId: "provider_checkout", iid: 9, scopeId: "a".repeat(64), discussionId: "original-thread", filePath: target.filePath, side: target.side, line: target.line, position: originalPosition, automated, comments }));
    expect(screen.getByRole("textbox", { name: "Review comment" })).toHaveValue("Keep this pending GitLab comment.");
    expect(fake.publishGitlabReviewComment).not.toHaveBeenCalled();
    expect(fake.createWorkspaceReviewThread).not.toHaveBeenCalled();
    expect(fake.resolveWorkspaceReviewThread).not.toHaveBeenCalled();
  });

  it("refreshes a changed local thread before another explicit resolve action", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValueOnce({ workspaceId, threads: [thread()] }).mockResolvedValueOnce({ workspaceId, threads: [thread({ revision: 2 })] });
    fake.resolveWorkspaceReviewThread.mockRejectedValueOnce(new Error("This feedback changed. Reload it first.")).mockResolvedValueOnce(thread({ revision: 3, state: "resolved" }));
    render(<CodeReviewFeedbackPanel client={fake.client} repositoryId={target.repositoryId} workspaceId={workspaceId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    fireEvent.click(await screen.findByRole("button", { name: "Refresh feedback" }));
    await waitFor(() => expect(fake.listWorkspaceReviewThreads).toHaveBeenCalledTimes(2));
    expect(fake.resolveWorkspaceReviewThread).toHaveBeenCalledOnce();
    fireEvent.click(await screen.findByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(fake.resolveWorkspaceReviewThread).toHaveBeenLastCalledWith(workspaceId, thread().threadId, 2));
  });

  it("opens GitLab after an ambiguous line-comment failure without repeating publication", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });
    fake.publishGitlabReviewComment.mockRejectedValue(new Error("The request timed out."));
    render(<CodeReviewFeedbackPanel client={fake.client} gitlabReview={{ repositoryId: target.repositoryId, iid: 9, discussions: [] }} repositoryId={target.repositoryId} selectedTarget={target} workspaceId={workspaceId} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Retain this line comment." } });
    fireEvent.click(screen.getByRole("button", { name: "Publish to GitLab" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open MR in GitLab" }));
    expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith(target.repositoryId, 9);
    expect(fake.publishGitlabReviewComment).toHaveBeenCalledOnce();
    expect(screen.getByRole("textbox", { name: "Review comment" })).toHaveValue("Retain this line comment.");
    expect(screen.getByText("Check GitLab before you send this comment again. Your draft is saved here.")).toBeVisible();
  });

  it("keeps separate line-comment drafts when a published version unmounts or changes", () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });
    const review = { repositoryId: target.repositoryId, iid: 9, discussions: [], expectedPosition: { baseCommitOid: target.baseCommitOid, startCommitOid: target.baseCommitOid, headCommitOid: target.headCommitOid } };
    const props = { client: fake.client, gitlabReview: review, repositoryId: target.repositoryId, selectedTarget: target, workspaceId };
    const first = render(<CodeReviewFeedbackPanel {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Keep the original line draft." } });
    first.unmount();
    const second = render(<CodeReviewFeedbackPanel {...props} gitlabReview={{ ...review, expectedPosition: { ...review.expectedPosition, headCommitOid: "d".repeat(40) } }} />);
    expect(screen.getByRole("textbox", { name: "Review comment" })).toHaveValue("");
    second.unmount();
    render(<CodeReviewFeedbackPanel {...props} />);
    expect(screen.getByRole("textbox", { name: "Review comment" })).toHaveValue("Keep the original line draft.");
  });

  it("binds a published line comment to the displayed MR version and retains a rejected draft", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });
    const expectedPosition = { baseCommitOid: target.baseCommitOid, startCommitOid: "a".repeat(40), headCommitOid: target.headCommitOid };
    fake.publishGitlabReviewComment.mockRejectedValueOnce(new Error("The MR changed. Refresh before publishing this line comment."));
    render(<CodeReviewFeedbackPanel client={fake.client} gitlabReview={{ repositoryId: target.repositoryId, iid: 9, discussions: [], expectedPosition }} repositoryId={target.repositoryId} selectedTarget={target} workspaceId={workspaceId} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), { target: { value: "Comment on the displayed code." } });
    fireEvent.click(screen.getByRole("button", { name: "Publish to GitLab" }));
    await waitFor(() => expect(fake.publishGitlabReviewComment).toHaveBeenCalledWith(target.repositoryId, 9, { body: "Comment on the displayed code.", filePath: target.filePath, side: target.side, line: target.line, expectedPosition, workspaceId }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The MR changed");
    expect(screen.getByRole("textbox", { name: "Review comment" })).toHaveValue("Comment on the displayed code.");
    expect(fake.publishGitlabReviewComment).toHaveBeenCalledTimes(1);
  });

  it("publishes the selected changed line to GitLab", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });
    fake.publishGitlabReviewComment.mockResolvedValue({
      schemaVersion: 1,
      repositoryId: target.repositoryId,
      iid: 9,
      accepted: true,
    });
    fake.getGitlabReviewPatch.mockResolvedValue({
      schemaVersion: 1,
      repositoryId: target.repositoryId,
      iid: 9,
      baseCommitOid: "a".repeat(40),
      startCommitOid: "a".repeat(40),
      headCommitOid: "b".repeat(40),
      commits: [],
      discussions: [{
        id: "discussion-1",
        resolvable: true,
        resolved: false,
        automated: false,
        filePath: target.filePath,
        side: target.side,
        line: target.line,
        comments: [{
          id: 41,
          body: "Check this retry condition.",
          authorLogin: "nandan",
          createdAt: "2026-08-20T09:00:00Z",
        }],
      }],
      patch: "diff --git a/src/checkout.ts b/src/checkout.ts\n",
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1,
    });

    render(
      <CodeReviewFeedbackPanel
        client={fake.client}
        gitlabReview={{ repositoryId: target.repositoryId, iid: 9, discussions: [] }}
        repositoryId={target.repositoryId}
        selectedTarget={target}
        workspaceId={workspaceId}
      />,
    );

    fireEvent.change(await screen.findByRole("textbox", { name: "Review comment" }), {
      target: { value: "Check this retry condition." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish to GitLab" }));

    await waitFor(() => expect(fake.publishGitlabReviewComment).toHaveBeenCalledWith(
      target.repositoryId,
      9,
      {
        body: "Check this retry condition.",
        filePath: target.filePath,
        side: target.side,
        line: target.line,
      },
    ));
    expect(await screen.findByText("Comment published to GitLab.")).toBeVisible();
    expect(await screen.findByText("Check this retry condition.")).toBeVisible();
    expect(fake.getGitlabReviewPatch).toHaveBeenCalledWith(
      target.repositoryId,
      9,
      undefined,
      true,
    );
    expect(screen.getByRole("textbox", { name: "Review comment" })).toHaveValue("");
    expect(fake.createWorkspaceReviewThread).not.toHaveBeenCalled();
  });

  it("shows existing GitLab discussion threads at their changed lines", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });

    render(
      <CodeReviewFeedbackPanel
        client={fake.client}
        gitlabReview={{
          repositoryId: target.repositoryId,
          iid: 9,
          discussions: [{
            id: "discussion-existing",
            resolvable: true,
            resolved: false,
            automated: false,
            filePath: target.filePath,
            side: target.side,
            line: target.line,
            comments: [{
              id: 51,
              body: "Can this be configuration driven?",
              authorLogin: "priya",
              createdAt: "2026-08-20T08:30:00Z",
            }],
          }],
        }}
        repositoryId={target.repositoryId}
        selectedTarget={target}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("Can this be configuration driven?")).toBeVisible();
    expect(screen.getByText("@priya")).toBeVisible();
    expect(screen.getByText("Open 1")).toBeVisible();
  });

  it("keeps automated notes compact and formats their content on demand", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });

    render(
      <CodeReviewFeedbackPanel
        client={fake.client}
        gitlabReview={{
          repositoryId: target.repositoryId,
          iid: 9,
          discussions: [{
            id: "cibot-note",
            resolvable: false,
            resolved: false,
            automated: true,
            comments: [{
              id: 52,
              body: "**hello from cibot** <details><summary>How to review</summary>Use `/review` for feedback.</details>",
              authorLogin: "cibot",
              createdAt: "2026-08-20T08:31:00Z",
            }],
          }],
        }}
        repositoryId={target.repositoryId}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("1 automated note")).toBeVisible();
    expect(screen.getByText("Open 0")).toBeVisible();
    expect(screen.getByText("Resolved 0")).toBeVisible();
    expect(screen.getByText("hello from cibot")).not.toBeVisible();

    fireEvent.click(screen.getByText("Automated note"));

    expect(screen.getByText("hello from cibot")).toBeVisible();
    expect(screen.getByText(/Use/)).toBeVisible();
    expect(screen.queryByText(/<details>/)).not.toBeInTheDocument();
  });

  it("creates feedback for the exact selected changed line", async () => {
    const created = thread();
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });
    fake.createWorkspaceReviewThread.mockResolvedValue(created);

    render(
      <CodeReviewFeedbackPanel
        client={fake.client}
        repositoryId={target.repositoryId}
        selectedTarget={target}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("No code review feedback exists for this repository.")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), {
      target: { value: "Explain the retry branch." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to agent" }));

    await waitFor(() =>
      expect(fake.createWorkspaceReviewThread).toHaveBeenCalledWith(
        workspaceId,
        target,
        "Explain the retry branch.",
        "user",
      ),
    );
    expect(await screen.findAllByText("src/checkout.ts:+12")).toHaveLength(2);
    expect(screen.getByText("Explain the retry branch.")).toBeVisible();
  });

  it("shows stale feedback and resolves an open thread with its revision", async () => {
    const stale = thread({ anchorState: "stale", revision: 4 });
    const resolved = thread({
      anchorState: "stale",
      state: "resolved",
      revision: 5,
      resolvedAtUnixMs: 20,
      updatedAtUnixMs: 20,
    });
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({
      workspaceId,
      threads: [stale],
    });
    fake.resolveWorkspaceReviewThread.mockResolvedValue(resolved);

    render(
      <CodeReviewFeedbackPanel
        client={fake.client}
        repositoryId={target.repositoryId}
        workspaceId={workspaceId}
      />,
    );

    expect(await screen.findByText("Old patch")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await waitFor(() =>
      expect(fake.resolveWorkspaceReviewThread).toHaveBeenCalledWith(
        workspaceId,
        stale.threadId,
        4,
      ),
    );
    expect(await screen.findByText("Resolved 1")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument();
  });
});
