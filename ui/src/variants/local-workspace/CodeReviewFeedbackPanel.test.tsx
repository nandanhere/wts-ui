import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  CodeChangeReviewTarget,
  WorkspaceReviewThread,
} from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { CodeReviewFeedbackPanel } from "./CodeReviewFeedbackPanel";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const target: CodeChangeReviewTarget = {
  kind: "codeChange",
  repositoryId: "repo_orders",
  baseCommitOid: "a".repeat(40),
  headCommitOid: "b".repeat(40),
  patchSha256: `sha256:${"c".repeat(64)}`,
  filePath: "src/orders.ts",
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
          authorLogin: "sam",
          createdAt: "2026-08-20T09:00:00Z",
        }],
      }],
      patch: "diff --git a/src/orders.ts b/src/orders.ts\n",
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
              authorLogin: "dave",
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
    expect(screen.getByText("@dave")).toBeVisible();
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
    expect(await screen.findAllByText("src/orders.ts:+12")).toHaveLength(2);
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
