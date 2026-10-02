import { forwardRef, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";

vi.mock("@pierre/diffs/react", () => ({
  CodeView: forwardRef(function FakeCodeView(
    props: {
      items: Array<{ id: string }>;
      onSelectedLinesChange?: (selection: {
        id: string;
        range: { start: number; side: "additions" };
      }) => void;
      renderGutterUtility?: (
        getHoveredLine: () => { lineNumber: number; side: "additions" },
        item: { id: string },
      ) => ReactNode;
      options?: { enableGutterUtility?: boolean };
    },
    _ref,
  ) {
    return (
      <>
        {props.options?.enableGutterUtility
          ? props.renderGutterUtility?.(
              () => ({ lineNumber: 1, side: "additions" }),
              props.items[0]!,
            )
          : null}
      </>
    );
  }),
}));

import { RepositoryPatchViewer } from "./RepositoryPatchViewer";
import { MergeRequestWorkingChanges } from "./MergeRequestWorkingChanges";
import type { GitlabConversationsController } from "./gitlabDiscussions";

describe("GitLab line comment affordance", () => {
  it("opens the shared agent chat from an existing inline thread without publishing", async () => {
    const fake = fakeWorkspaceClient();
    const workspaceId = "ws_inline_agent";
    fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId, threads: [] });
    const comments = [{ id: 41, body: "Fix the retry guard.", authorLogin: "priya", createdAt: "2026-09-18T09:00:00Z" }];
    const position = { baseCommitOid: "d".repeat(40), startCommitOid: "e".repeat(40), headCommitOid: "f".repeat(40) };
    const listener = vi.fn();
    window.addEventListener("wts:agent-feedback-requested", listener);
    try {
      render(<RepositoryPatchViewer feedback={{ baseCommitOid: "a".repeat(40), headCommitOid: "b".repeat(40), patchSha256: "provider", client: fake.client, workspaceId, repositoryId: "repo_checkout", gitlabReview: { repositoryId: "provider_checkout", iid: 17, scopeId: "c".repeat(64), discussions: [{ id: "retry-thread", resolvable: true, resolved: false, automated: false, filePath: "src/checkout.ts", side: "additions", line: 1, position, comments }] } }} lineCommentProvider="GitLab" patch="diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-export const ready = false;\n+export const ready = true;\n" theme="dark" />);
      fireEvent.click(await screen.findByRole("button", { name: "Ask agent to fix" }));
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]![0].detail).toEqual({ kind: "gitlabDiscussion", workspaceId, repositoryId: "repo_checkout", providerRepositoryId: "provider_checkout", iid: 17, scopeId: "c".repeat(64), discussionId: "retry-thread", filePath: "src/checkout.ts", side: "additions", line: 1, position, resolved: false, automated: false, comments });
      expect(fake.publishGitlabReviewComment).not.toHaveBeenCalled();
    } finally { window.removeEventListener("wts:agent-feedback-requested", listener); }
  });

  it("publishes version-bound line comments only from In the MR", async () => {
    const fake = fakeWorkspaceClient();
    const workspaceId = "workspace-review";
    const repositoryId = "repo_checkout";
    const expectedPosition = { baseCommitOid: "a".repeat(40), startCommitOid: "a".repeat(40), headCommitOid: "b".repeat(40) };
    const patch = "diff --git a/src/checkout.ts b/src/checkout.ts\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-export const ready = false;\n+export const ready = true;\n";
    const diff = { schemaVersion: 1, workspaceId, repositoryId, repositoryLabel: "checkout", baseCommitOid: expectedPosition.baseCommitOid, headCommitOid: expectedPosition.headCommitOid, patch, patchSha256: `sha256:${"c".repeat(64)}`, patchTruncated: false, untrackedPaths: [], untrackedPathsTruncated: false };
    const target = { key: "checkout-17", repositoryId, worktreeRepositoryId: repositoryId, workspaceId, iid: 17, label: "Checkout !17" };
    const controller: GitlabConversationsController = { entries: [{ target, state: "ready", error: "", unreadCommentIds: [], snapshot: { schemaVersion: 1, repositoryId, iid: 17, scopeId: "e".repeat(64), viewerLogin: "me", discussions: [], fetchedAtUnixMs: 1, fromCache: true, truncated: false } }], loading: false, error: "", unreadCount: 0, refresh: vi.fn(), markRead: vi.fn(), acceptReply: vi.fn() };
    fake.getWorkspaceGitlabComparison.mockResolvedValue({ schemaVersion: 1, workspaceId, repositoryId, repositoryLabel: "checkout", iid: 17, localHeadCommitOid: expectedPosition.headCommitOid, status: "ready", published: { schemaVersion: 1, repositoryId, iid: 17, ...expectedPosition, commits: [], discussions: [], patch, patchTruncated: false, fromCache: false, fetchedAtUnixMs: 1 }, latestWork: diff, sinceMr: { ...diff, baseCommitOid: expectedPosition.headCommitOid } });
    fake.getWorkspaceRepositorySource.mockResolvedValue({ schemaVersion: 1, workspaceId, repositoryId, filePath: "src/checkout.ts", content: "export const ready = true;", revision: `sha256:${"d".repeat(64)}` });
    fake.publishGitlabReviewComment.mockRejectedValue(new Error("The MR changed."));
    const screenView = render(<MergeRequestWorkingChanges active client={fake.client} workspaceId={workspaceId} repositoryId={repositoryId} target={target} controller={controller} />);
    await screen.findByRole("button", { name: "Edit locally" });
    expect(screen.queryByRole("button", { name: "Comment on added line 1" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Code comparison" }), { target: { value: "inMr" } });
    expect(screen.queryByRole("button", { name: "Comment on added line 1" })).not.toBeInTheDocument();
    const freshController = { ...controller, entries: controller.entries.map((entry) => ({ ...entry, snapshot: { ...entry.snapshot!, fromCache: false } })) };
    screenView.rerender(<MergeRequestWorkingChanges active client={fake.client} workspaceId={workspaceId} repositoryId={repositoryId} target={target} controller={freshController} />);
    fireEvent.click(await screen.findByRole("button", { name: "Comment on added line 1" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Review comment" }), { target: { value: "Check the published line." } });
    fireEvent.click(screen.getByRole("button", { name: "Publish to GitLab" }));
    await waitFor(() => expect(fake.publishGitlabReviewComment).toHaveBeenCalledWith(repositoryId, 17, { body: "Check the published line.", filePath: "src/checkout.ts", side: "additions", line: 1, expectedPosition, workspaceId }));
    expect(screen.queryByRole("checkbox", { name: "Full file" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Code comparison" }), { target: { value: "sinceMr" } });
    expect(screen.queryByRole("button", { name: "Comment on added line 1" })).not.toBeInTheDocument();
  });

  it("shows a line comment control and opens the focused composer", async () => {
    const fake = fakeWorkspaceClient();
    fake.listWorkspaceReviewThreads.mockResolvedValue({
      workspaceId: "workspace-review",
      threads: [],
    });

    render(
      <RepositoryPatchViewer
        feedback={{
          baseCommitOid: "a".repeat(40),
          client: fake.client,
          gitlabReview: {
            repositoryId: "repo_checkout",
            iid: 17,
            discussions: [],
          },
          headCommitOid: "b".repeat(40),
          patchSha256: "provider",
          repositoryId: "repo_checkout",
          workspaceId: "workspace-review",
        }}
        lineCommentProvider="GitLab"
        patch={[
          "diff --git a/src/checkout.ts b/src/checkout.ts",
          "--- a/src/checkout.ts",
          "+++ b/src/checkout.ts",
          "@@ -1 +1 @@",
          "-export const ready = false;",
          "+export const ready = true;",
          "",
        ].join("\n")}
        theme="dark"
      />,
    );

    expect(screen.getByRole("complementary", { name: "Review context" })).toBeVisible();
    expect(screen.getByText("Select a changed line")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Comment on added line 1" }));

    const composer = await screen.findByRole("textbox", { name: "Review comment" });
    await waitFor(() => expect(composer).toHaveFocus());
    expect(screen.getByText("src/checkout.ts:+1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish to GitLab" })).toBeVisible();
  });
});
