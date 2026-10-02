import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceCodeReviewResult } from "../../lib/wtsClient";
import type { GitlabConversationsController } from "./gitlabDiscussions";
import { ReviewAttentionStrip, ReviewHomePanel, unreadHumanThreads } from "./ReviewHomePanel";

const controller = {
  entries: [{
    target: { key: "t", repositoryId: "prov", worktreeRepositoryId: "repo", iid: 41, label: "zeno !41", workspaceId: "ws" },
    state: "ready", error: "", unreadCommentIds: [1, 2],
    snapshot: {
      schemaVersion: 1, repositoryId: "prov", iid: 41, scopeId: "s", viewerLogin: "me", fetchedAtUnixMs: 1, fromCache: false, truncated: false,
      discussions: [
        { id: "bot", automated: true, resolvable: false, resolved: false, comments: [{ id: 1, body: "hello from cibot", authorLogin: "cibot", createdAt: "2026-09-03T00:00:00Z" }] },
        { id: "human", automated: false, resolvable: true, resolved: false, filePath: "internal/scheduler/jobs.go", line: 133, comments: [{ id: 2, body: "log the error before returning", authorLogin: "pratik.anurag", createdAt: "2026-09-18T00:00:00Z" }] },
      ],
    },
  }],
  loading: false, error: "", unreadCount: 1, refresh: vi.fn(), markRead: vi.fn(), acceptReply: vi.fn(),
} as unknown as GitlabConversationsController;

const review: WorkspaceCodeReviewResult = {
  workspaceId: "ws", provider: "codex", scope: "recentChanges", model: "gpt-5", summary: "One blocking bug.",
  skill: { id: "raptik-review", label: "Raptik rules" },
  findings: [{ findingId: "f1", severity: "critical", filePath: "internal/scheduler/jobs.go", line: 131, title: "The error is not logged", explanation: "x" }],
  actionableSteps: [], reviewedAtUnixMs: 1,
};

describe("review home", () => {
  it("lists only unread human threads with their file and line", () => {
    const threads = unreadHumanThreads(controller);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: "human", location: "internal/scheduler/jobs.go:133", author: "pratik.anurag", unread: 1 });
  });

  it("puts threads to answer before agent findings as the next step", () => {
    const onOpenConversations = vi.fn();
    const { rerender } = render(<ReviewAttentionStrip onOpenAgentReview={vi.fn()} onOpenCode={vi.fn()} onOpenConversations={onOpenConversations} review={review} threads={unreadHumanThreads(controller)} />);
    fireEvent.click(screen.getByRole("button", { name: /Reply to 1 thread/ }));
    expect(onOpenConversations).toHaveBeenCalled();
    const onOpenAgentReview = vi.fn();
    rerender(<ReviewAttentionStrip onOpenAgentReview={onOpenAgentReview} onOpenCode={vi.fn()} onOpenConversations={vi.fn()} review={null} threads={[]} />);
    expect(screen.getByText("Not run")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Run the agent review/ }));
    expect(onOpenAgentReview).toHaveBeenCalled();
  });

  it("offers no review action for a merged MR", () => {
    const onOpenCode = vi.fn();
    render(<ReviewAttentionStrip finished onOpenAgentReview={vi.fn()} onOpenCode={onOpenCode} onOpenConversations={vi.fn()} review={null} threads={[]} />);
    expect(screen.queryByRole("button", { name: /Run the agent review/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Read the final changes/ }));
    expect(onOpenCode).toHaveBeenCalled();
  });

  it("tells the reviewer that a closed MR needs no review action", () => {
    render(<ReviewHomePanel finished onOpenFindings={vi.fn()} onOpenThread={vi.fn()} onRunReview={vi.fn()} planning={null} review={null} threads={[]} />);
    expect(screen.getByText(/No review action remains/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run review" })).not.toBeVisible();
    fireEvent.click(screen.getByText("Review for follow-up"));
    expect(screen.getByRole("button", { name: "Run review" })).toBeVisible();
  });

  it("shows the saved agent findings and opens the selected thread", () => {
    const onOpenThread = vi.fn();
    const onRunReview = vi.fn();
    render(<ReviewHomePanel onOpenFindings={vi.fn()} onOpenThread={onOpenThread} onRunReview={onRunReview} planning={<p>PLAN.md</p>} review={review} threads={unreadHumanThreads(controller)} />);
    expect(screen.getByRole("heading", { name: "1 finding" })).toBeVisible();
    expect(within(screen.getByRole("list", { name: "Agent findings" })).getByText("The error is not logged")).toBeVisible();
    expect(screen.getByText("PLAN.md")).not.toBeVisible();
    fireEvent.click(within(screen.getByRole("list", { name: "Threads that need a reply" })).getByRole("button"));
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ id: "human", targetKey: "t", scopeId: "s", worktreeRepositoryId: "repo" }));
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));
    expect(onRunReview).toHaveBeenCalled();
  });
});
