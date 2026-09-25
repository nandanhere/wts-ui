import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceGitlabComparison } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { MergeRequestWorkingChanges } from "./MergeRequestWorkingChanges";
import type { GitlabConversationsController } from "./gitlabDiscussions";
import { workingChangesStore } from "./workingChangesState";

const workingChangesStylesheet = readFileSync(
  resolve(__dirname, "./MergeRequestWorkingChanges.module.css"),
  "utf8",
);

vi.mock("./RepositoryPatchViewer", async (original) => ({ ...await original<typeof import("./RepositoryPatchViewer")>(), RepositoryPatchViewer: ({ patch, singleFileActions, aiReview }: { patch: string; singleFileActions?: ReactNode; aiReview?: { findings: unknown[] } | null }) => <>{singleFileActions}<pre aria-label="Displayed comparison" data-ai-findings={aiReview ? aiReview.findings.length : undefined}>{patch}</pre></> }));
const oid = (letter: string) => letter.repeat(40);
const patch = (path: string, before: string, after: string) => `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
function fixture(status: WorkspaceGitlabComparison["status"] = "ready") {
  const fake = fakeWorkspaceClient();
  const target = { key: "checkout-9", repositoryId: "provider_checkout", worktreeRepositoryId: "repo_checkout", iid: 9, label: "Checkout !9", workspaceId: "ws_checkout" };
  const published = { schemaVersion: 1 as const, repositoryId: target.worktreeRepositoryId, iid: 9, baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("b"), commits: [], discussions: [], patch: patch("src/checkout.ts", "base", "published") + patch("src/reverted.ts", "base", "published"), patchTruncated: false, fromCache: false, fetchedAtUnixMs: 1 };
  const local = { schemaVersion: 1, workspaceId: target.workspaceId, repositoryId: target.worktreeRepositoryId, repositoryLabel: "checkout", baseCommitOid: oid("a"), headCommitOid: oid("c"), patchSha256: `sha256:${"d".repeat(64)}`, patch: patch("src/checkout.ts", "base", "latest") + patch("src/new.ts", "", "new local file"), patchTruncated: false, untrackedPaths: [], untrackedPathsTruncated: false };
  const comparison: WorkspaceGitlabComparison = { schemaVersion: 1, workspaceId: target.workspaceId, repositoryId: target.worktreeRepositoryId, repositoryLabel: "checkout", iid: 9, localHeadCommitOid: oid("c"), status, published, ...(status === "ready" ? { latestWork: local, sinceMr: { ...local, baseCommitOid: oid("b"), patch: patch("src/checkout.ts", "published", "latest") + patch("src/reverted.ts", "published", "base") + patch("src/new.ts", "", "new local file") } } : {}) };
  const getWorkspaceGitlabComparison = vi.fn().mockResolvedValue(comparison);
  const getWorkspaceRepositorySource = vi.fn().mockImplementation(async (_workspace, _repository, filePath) => ({ schemaVersion: 1, workspaceId: target.workspaceId, repositoryId: target.worktreeRepositoryId, filePath, content: "latest local content", revision: `sha256:${"e".repeat(64)}` }));
  const client = { ...fake.client, getWorkspaceGitlabComparison, getWorkspaceRepositorySource };
  const controller: GitlabConversationsController = { entries: [{ target, state: "ready", error: "", unreadCommentIds: [], snapshot: { schemaVersion: 1, repositoryId: target.repositoryId, iid: 9, scopeId: "f".repeat(64), viewerLogin: "me", discussions: [], fetchedAtUnixMs: 1, fromCache: false, truncated: false } }], loading: false, error: "", unreadCount: 0, refresh: vi.fn(), markRead: vi.fn(), acceptReply: vi.fn() };
  const props = { client, workspaceId: target.workspaceId, repositoryId: target.worktreeRepositoryId, target, controller, active: true };
  return { ...props, props, comparison, getWorkspaceGitlabComparison, getWorkspaceRepositorySource };
}
function changeView(value: string) { fireEvent.change(screen.getByRole("combobox", { name: "Code comparison" }), { target: { value } }); }

describe("MR and local code comparisons", () => {
  it("shows the AI review of the published MR on In the MR and opens the file of a focused finding", async () => {
    const f = fixture();
    const review = {
      workspaceId: f.workspaceId, provider: "codex" as const, scope: "recentChanges" as const, mode: "skill" as const, summary: "One question.", actionableSteps: [], reviewedAtUnixMs: 1,
      findings: [{ findingId: "q-1", severity: "suggestion" as const, label: "question" as const, repositoryId: "repo_checkout", filePath: "src/reverted.ts", line: 1, side: "additions" as const, anchored: true, title: "Why revert?", explanation: "Unclear." }],
      repositories: [{ repositoryId: "repo_checkout", repositoryLabel: "checkout", baseCommitOid: oid("a"), headCommitOid: oid("b"), patchSha256: "sha256:x", changedLines: 2, sizeGateExceeded: false, strictness: "normal" as const, mergeRequest: { iid: 9, baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("b") } }],
    };
    const onFileChange = vi.fn();
    const view = render(<MergeRequestWorkingChanges {...f.props} aiReview={review} onFileChange={onFileChange} />);
    expect(await screen.findByLabelText("Displayed comparison")).not.toHaveAttribute("data-ai-findings");
    expect(screen.getByText(/The AI review of the published MR has 1 finding/)).toBeVisible();

    view.rerender(<MergeRequestWorkingChanges {...f.props} aiReview={review} onFileChange={onFileChange} aiReviewFocus={{ requestId: 1, findingId: "q-1" }} />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Code comparison" })).toHaveValue("inMr"));
    expect(screen.getByRole("button", { name: /^src\/reverted.ts/ })).toHaveAttribute("aria-current", "true");
    expect(within(screen.getByRole("button", { name: /^src\/reverted.ts/ })).getByText("AI 1")).toBeVisible();
    expect(screen.getByLabelText("Displayed comparison")).toHaveAttribute("data-ai-findings", "1");
    expect(onFileChange).toHaveBeenCalledWith("src/reverted.ts");

    // A review of another MR version does not attach to this MR.
    view.rerender(<MergeRequestWorkingChanges {...f.props} aiReview={{ ...review, repositories: [{ ...review.repositories[0]!, mergeRequest: { ...review.repositories[0]!.mergeRequest, iid: 10 } }] }} />);
    await waitFor(() => expect(screen.getByLabelText("Displayed comparison")).not.toHaveAttribute("data-ai-findings"));
  });

  it("keeps the user-selected file and its draft after a fresh comparison response", async () => {
    const f = fixture(); const onFileChange = vi.fn(); const view = render(<MergeRequestWorkingChanges {...f.props} initialFile="src/checkout.ts" onFileChange={onFileChange} />); await screen.findByLabelText("Displayed comparison");
    fireEvent.click(screen.getByRole("button", { name: "src/new.ts Local only" })); fireEvent.click(screen.getByRole("button", { name: "Edit locally" })); fireEvent.change(await screen.findByRole("textbox", { name: "Local file editor" }), { target: { value: "Keep this new file draft" } });
    f.getWorkspaceGitlabComparison.mockResolvedValue(structuredClone(f.comparison)); fireEvent.click(screen.getByRole("button", { name: "Refresh changes" })); await waitFor(() => expect(f.getWorkspaceGitlabComparison).toHaveBeenCalledTimes(2)); await waitFor(() => expect(screen.getByRole("button", { name: "Refresh changes" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "src/new.ts Local only" })).toHaveAttribute("aria-current", "true"); expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue("Keep this new file draft"); expect(onFileChange).toHaveBeenCalledExactlyOnceWith("src/new.ts");
    view.rerender(<MergeRequestWorkingChanges {...f.props} initialFile="src/reverted.ts" onFileChange={onFileChange} />); await waitFor(() => expect(screen.getByRole("button", { name: "src/reverted.ts In MR + local" })).toHaveAttribute("aria-current", "true"));
  });

  it("identifies a modified local-only file without claiming it was added", async () => {
    const f = fixture();
    const modified = patch("src/existing.ts", "previous content", "local edit");
    f.comparison.latestWork!.patch += modified;
    f.comparison.sinceMr!.patch += modified;
    render(<MergeRequestWorkingChanges {...f.props} />);
    const file = await screen.findByRole("button", { name: "src/existing.ts Local only" });
    expect(within(file).getByText("Local")).toBeVisible();
    expect(within(file).queryByText("A", { exact: true })).not.toBeInTheDocument();
    fireEvent.click(file);
    expect(screen.getByLabelText("Displayed comparison")).toHaveTextContent("-previous content +local edit");
  });

  it("keeps the file rail as a bounded scroll viewport", () => {
    const fileListRule = workingChangesStylesheet.match(/\.fileList\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(fileListRule).toMatch(/flex:\s*1 1 0/);
    expect(fileListRule).toMatch(/overflow-y:\s*auto/);
    expect(fileListRule).toMatch(/overscroll-behavior:\s*contain/);
    expect(fileListRule).toMatch(/scrollbar-gutter:\s*stable/);
  });

  it("opens the shared agent chat from file conversations with the active workspace fallback", async () => {
    const f = fixture();
    const original = { baseCommitOid: "1".repeat(40), startCommitOid: "2".repeat(40), headCommitOid: "3".repeat(40) };
    const comments = [{ id: 41, body: "Fix the original retry condition.", authorLogin: "priya", createdAt: "2026-09-18T09:00:00Z" }];
    const controller = { ...f.controller, entries: f.controller.entries.map((entry) => ({ ...entry, target: { ...entry.target, workspaceId: undefined }, snapshot: { ...entry.snapshot!, discussions: [{ id: "retry-thread", resolvable: true, resolved: false, automated: false, filePath: "src/checkout.ts", side: "additions" as const, line: 1, position: original, comments }] } })) };
    const listener = vi.fn();
    window.addEventListener("wts:agent-feedback-requested", listener);
    try {
      render(<MergeRequestWorkingChanges {...f.props} controller={controller} />);
      fireEvent.click(await screen.findByRole("button", { name: /File conversations/ }));
      fireEvent.click(screen.getByRole("button", { name: "src/checkout.ts:+1 by @priya" }));
      fireEvent.click(screen.getByRole("button", { name: "Ask agent to fix" }));
      expect(listener).toHaveBeenCalledOnce();
      expect(listener.mock.calls[0]![0].detail).toEqual({ kind: "gitlabDiscussion", workspaceId: f.workspaceId, repositoryId: f.repositoryId, providerRepositoryId: f.target.repositoryId, iid: f.target.iid, scopeId: "f".repeat(64), discussionId: "retry-thread", mergeRequestLabel: f.target.label, filePath: "src/checkout.ts", side: "additions", line: 1, position: original, comments, resolved: false, automated: false, fetchedAtUnixMs: 1, fromCache: false, truncated: false });
    } finally { window.removeEventListener("wts:agent-feedback-requested", listener); }
  });

  it("offers a conversation refresh when the account check blocks line comments", async () => {
    const f = fixture();
    f.controller.entries[0]!.snapshot!.fromCache = true;
    const onOpenIntegrations = vi.fn();
    render(<MergeRequestWorkingChanges {...f.props} onOpenIntegrations={onOpenIntegrations} />);
    await screen.findByLabelText("Displayed comparison");
    changeView("inMr");
    fireEvent.click(screen.getByRole("button", { name: "Refresh conversations" }));
    expect(f.controller.refresh).toHaveBeenCalledWith(f.target.key);
    fireEvent.click(screen.getByRole("button", { name: "Check GitLab connection" }));
    expect(onOpenIntegrations).toHaveBeenCalledOnce();
  });

  it("keeps source and discussions out of the diff until requested", async () => {
    const f = fixture();
    render(<MergeRequestWorkingChanges {...f.props} />);
    await screen.findByLabelText("Displayed comparison");
    expect(screen.queryByLabelText("Current local file")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Conversations for this file" })).not.toBeInTheDocument();
    expect(f.getWorkspaceRepositorySource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit locally" }));
    const editor = await screen.findByRole("textbox", { name: "Local file editor" });
    fireEvent.change(editor, { target: { value: "Retain this drawer draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(screen.queryByRole("textbox", { name: "Local file editor" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit locally" }));
    expect(await screen.findByRole("textbox", { name: "Local file editor" })).toHaveValue("Retain this drawer draft");
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    fireEvent.click(screen.getByRole("button", { name: /File conversations/ }));
    expect(screen.getByRole("complementary", { name: "Conversations for this file" })).toBeVisible();
  });

  it("filters file paths without losing the selected diff", async () => {
    const f = fixture();
    render(<MergeRequestWorkingChanges {...f.props} />);
    await screen.findByLabelText("Displayed comparison");
    fireEvent.change(screen.getByRole("searchbox", { name: "Find file" }), { target: { value: "new.ts" } });
    expect(screen.getByRole("button", { name: /src\/new.ts Local only/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /src\/checkout.ts In MR/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Displayed comparison")).toHaveTextContent("+latest");
  });

  it("labels a renamed MR file and keeps binary files explicit", async () => {
    const f = fixture();
    const rename = "diff --git a/src/checkout.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/checkout.ts\nrename to src/renamed.ts\n";
    const binary = "diff --git a/logo.png b/logo.png\nindex 1111111..2222222 100644\nBinary files a/logo.png and b/logo.png differ\n";
    f.comparison.sinceMr!.patch = rename + binary;
    f.comparison.latestWork!.patch = patch("src/renamed.ts", "base", "latest") + binary;
    render(<MergeRequestWorkingChanges {...f.props} />);
    expect(await screen.findByRole("button", { name: /src\/renamed.ts In MR \+ local.*Renamed from src\/checkout.ts/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /src\/checkout.ts In MR \+ local/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /logo.png/ }));
    expect(screen.getByText("This binary file cannot be shown as text.")).toBeVisible();
  });

  it("bounds pending MR snapshots and ignores a response after its cache entry expires", async () => {
    const f = fixture();
    const replies: Array<() => void> = [];
    f.getWorkspaceGitlabComparison.mockImplementation((_workspace, _repository, iid) => new Promise((resolve) => { replies.push(() => resolve({ ...f.comparison, iid, published: { ...f.comparison.published, iid } })); }));
    for (let iid = 1; iid <= 18; iid += 1) {
      const view = render(<MergeRequestWorkingChanges {...f.props} target={{ ...f.target, iid, key: `checkout-${iid}` }} />);
      view.unmount();
    }
    expect(workingChangesStore(f.client).entries.size).toBeLessThanOrEqual(16);
    await act(async () => { for (const reply of replies) reply(); });
    expect(workingChangesStore(f.client).entries.size).toBeLessThanOrEqual(16);
    expect([...workingChangesStore(f.client).entries.values()].some((entry) => entry.comparison?.iid === 1)).toBe(false);
  });

  it("refreshes after a save even when an older comparison request is pending", async () => {
    const f = fixture();
    f.client.saveWorkspaceRepositorySource = vi.fn().mockImplementation(async (_workspace, _repository, request) => ({ schemaVersion: 1, workspaceId: f.workspaceId, repositoryId: f.repositoryId, filePath: request.filePath, content: request.content, revision: `sha256:${"e".repeat(64)}` }));
    render(<MergeRequestWorkingChanges {...f.props} />);
    await screen.findByLabelText("Displayed comparison");
    fireEvent.click(await screen.findByRole("button", { name: "Edit locally" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Local file editor" }), { target: { value: "saved during refresh" } });
    let resolve!: (value: WorkspaceGitlabComparison) => void;
    const oldRead = new Promise<WorkspaceGitlabComparison>((next) => { resolve = next; });
    const fresh = { ...f.comparison, latestWork: { ...f.comparison.latestWork!, patch: patch("src/checkout.ts", "base", "saved during refresh") } };
    f.getWorkspaceGitlabComparison.mockReturnValueOnce(oldRead).mockResolvedValueOnce(fresh);
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    fireEvent.click(screen.getByRole("button", { name: "Save local file" }));
    await screen.findByText("Local file saved. The MR is unchanged.");
    await act(async () => { resolve(f.comparison); await oldRead; });
    await waitFor(() => expect(screen.getByLabelText("Displayed comparison")).toHaveTextContent("+saved during refresh"));
    expect(f.getWorkspaceGitlabComparison).toHaveBeenCalledTimes(3);
  });

  it("shows latest work by default and switches the actual comparison while retaining reversed MR files", async () => {
    const f = fixture(); render(<MergeRequestWorkingChanges {...f.props} />);
    expect(await screen.findByLabelText("Displayed comparison")).toHaveTextContent("-base +latest");
    expect(screen.getByRole("button", { name: /src\/checkout.ts In MR \+ local/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /src\/new.ts Local only/ })).toBeVisible();
    expect(screen.getByText("MR changes and local changes")).toBeVisible();
    changeView("inMr");
    expect(screen.getByLabelText("Displayed comparison")).toHaveTextContent("-base +published");
    expect(screen.getByText(/^MR at [0-9a-f]{8}$/)).toBeVisible();
    // The file count states how many files the selected view changes.
    expect(screen.getByTitle(/changed in this view · \d+ in the review/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit locally" })).not.toBeInTheDocument();
    changeView("sinceMr");
    expect(screen.getByLabelText("Displayed comparison")).toHaveTextContent("-published +latest");
    changeView("latestWork");
    fireEvent.click(screen.getByRole("button", { name: /src\/reverted.ts/ }));
    expect(screen.getByText("This file has no local change. It remains in the published MR.")).toBeVisible();
    expect(f.getWorkspaceGitlabComparison).toHaveBeenCalledWith("ws_checkout", "repo_checkout", 9, false);
  });

  it.each(["missingCommits", "diverged"] as const)("keeps the published MR accessible when local history is %s", async (status) => {
    const f = fixture(status); render(<MergeRequestWorkingChanges {...f.props} />);
    // The first read opens the published MR, so the reviewer never lands on an empty diff.
    expect(await screen.findByLabelText("Displayed comparison")).toHaveTextContent("+published");
    expect(screen.getByText(/WTS shows the published changes at bbbbbbbb/)).toBeVisible();
    expect(screen.getByText(status === "missingCommits" ? /The MR commits are not in this local checkout/ : /The local history differs from the published MR/)).toBeVisible();
    changeView("latestWork");
    expect(await screen.findByRole("alert")).toHaveTextContent(status === "missingCommits" ? "The MR commits are not in this local checkout." : "The local history differs from the published MR.");
    expect(screen.getByText("Local comparison unavailable")).toBeVisible();
    expect(screen.queryByText("No changes since the MR")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Displayed comparison")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show published changes" }));
    expect(screen.getByLabelText("Displayed comparison")).toHaveTextContent("+published");
    expect(screen.queryByRole("button", { name: "Show published changes" })).not.toBeInTheDocument();
  });

  it("explains a slow first comparison while GitLab answers", async () => {
    const f = fixture();
    let resolve!: (value: WorkspaceGitlabComparison) => void;
    f.getWorkspaceGitlabComparison.mockReturnValueOnce(new Promise((next) => { resolve = next; }));
    render(<MergeRequestWorkingChanges {...f.props} />);
    expect(await screen.findByRole("status")).toHaveTextContent("WTS reads MR !9 from GitLab and compares it with the local work.");
    await act(async () => resolve(f.comparison));
    expect(await screen.findByLabelText("Displayed comparison")).toBeVisible();
  });

  it("retries a failed comparison in place and keeps GitLab settings out of a local host limit", async () => {
    const f = fixture();
    const busy = Object.assign(new Error("WTS is already running the maximum number of local operations. Retry shortly."), { code: "operation_capacity_exhausted" });
    f.getWorkspaceGitlabComparison.mockRejectedValueOnce(busy);
    const onOpenIntegrations = vi.fn();
    render(<MergeRequestWorkingChanges {...f.props} onOpenIntegrations={onOpenIntegrations} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("maximum number of local operations");
    expect(screen.queryByRole("button", { name: "Check GitLab connection" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry changes" }));
    expect(await screen.findByLabelText("Displayed comparison")).toBeVisible();
    expect(f.getWorkspaceGitlabComparison).toHaveBeenLastCalledWith("ws_checkout", "repo_checkout", 9, true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the displayed comparison through refresh and restores the view and draft on return", async () => {
    const f = fixture();
    const first = render(<MergeRequestWorkingChanges {...f.props} />);
    await screen.findByLabelText("Displayed comparison");
    changeView("sinceMr");
    fireEvent.click(await screen.findByRole("button", { name: "Edit locally" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Local file editor" }), { target: { value: "Unfinished local change" } });
    let resolve!: (value: WorkspaceGitlabComparison) => void;
    const pending = new Promise<WorkspaceGitlabComparison>((next) => { resolve = next; });
    f.getWorkspaceGitlabComparison.mockReturnValueOnce(pending);
    fireEvent.click(screen.getByRole("button", { name: "Refresh changes" }));
    expect(screen.getByLabelText("Displayed comparison")).toHaveTextContent("-published +latest");
    first.unmount();
    render(<MergeRequestWorkingChanges {...f.props} />);
    expect(screen.getByRole("combobox", { name: "Code comparison" })).toHaveValue("sinceMr");
    expect(screen.getByLabelText("Displayed comparison")).toHaveTextContent("-published +latest");
    expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue("Unfinished local change");
    await act(async () => { resolve(f.comparison); await pending; });
    expect(screen.getByRole("textbox", { name: "Local file editor" })).toHaveValue("Unfinished local change");
  });

  it("shows an old MR location without attaching its conversation to newer local lines", async () => {
    const f = fixture();
    f.controller.entries[0]!.snapshot!.discussions = [{ id: "old-thread", resolvable: true, resolved: false, automated: false, filePath: "src/checkout.ts", side: "additions", line: 1, position: { baseCommitOid: oid("a"), startCommitOid: oid("a"), headCommitOid: oid("d") }, comments: [{ id: 7, authorLogin: "priya", body: "Please handle retries.", createdAt: "2026-09-17T09:00:00Z" }] }];
    render(<MergeRequestWorkingChanges {...f.props} />);
    await screen.findByLabelText("Displayed comparison");
    fireEvent.click(screen.getByRole("button", { name: /File conversations/ }));
    fireEvent.click(screen.getByRole("button", { name: /src\/checkout.ts:\+1/ }));
    expect(screen.getByText("WTS cannot map this conversation to this MR version. Its local line is not mapped.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reply to GitLab" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Publish to GitLab" })).not.toBeInTheDocument();
  });
});
