import { forwardRef, useImperativeHandle, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CodeReviewFinding, WorkspaceCodeReviewResult } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";

const scrollTo = vi.fn();
const itemsSeen: Array<Array<{ id: string; version?: number; annotations?: Array<{ side: string; lineNumber: number; metadata: CodeReviewFinding }> }>> = [];

vi.mock("@pierre/diffs/react", () => ({
  CodeView: forwardRef(function FakeCodeView(
    props: {
      items: Array<{ id: string; version?: number; annotations?: Array<{ side: string; lineNumber: number; metadata: CodeReviewFinding }> }>;
      renderAnnotation?: (annotation: { side: string; lineNumber: number; metadata: CodeReviewFinding }, item: { id: string }) => ReactNode;
    },
    ref,
  ) {
    itemsSeen.push(props.items);
    useImperativeHandle(ref, () => ({ scrollTo, setSelectedLines: vi.fn() }));
    const item = props.items[0]!;
    return (
      <div data-testid={`diff-${item.id}`}>
        {item.annotations?.map((annotation) => (
          <div data-line={`${annotation.side}:${annotation.lineNumber}`} key={annotation.metadata.findingId}>
            {props.renderAnnotation?.(annotation, item)}
          </div>
        ))}
      </div>
    );
  }),
}));

import { RepositoryPatchViewer } from "./RepositoryPatchViewer";

const patch = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "--- a/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "@@ -1,2 +1,3 @@",
  " export const a = 1;",
  "-export const ready = false;",
  "+export const ready = true;",
  "+export const retries = 0;",
  "",
].join("\n");

function review(overrides: Partial<WorkspaceCodeReviewResult> = {}): WorkspaceCodeReviewResult {
  return {
    workspaceId: "ws_ai",
    provider: "codex",
    scope: "recentChanges",
    mode: "raptik",
    outcome: "reviewed",
    summary: "Two findings.",
    actionableSteps: [],
    repositories: [{ repositoryId: "repo_checkout", repositoryLabel: "checkout", baseCommitOid: "a".repeat(40), headCommitOid: "b".repeat(40), patchSha256: "sha256:p", changedLines: 3, sizeGateExceeded: false, strictness: "strict" }],
    reviewedAtUnixMs: 1,
    findings: [
      { findingId: "f-retry", severity: "critical", label: "blocking", repositoryId: "repo_checkout", filePath: "src/checkout.ts", line: 3, side: "additions", anchored: true, title: "Zero retries hides failures", explanation: "The retry count is zero.", suggestedComment: "Blocking: set a bounded retry count." },
      { findingId: "f-context", severity: "suggestion", label: "nit", repositoryId: "repo_checkout", filePath: "src/checkout.ts", line: 1, side: "additions", anchored: false, title: "Name the constant", explanation: "Use a clear name." },
      { findingId: "f-other", severity: "warning", label: "issue", repositoryId: "repo_other", filePath: "src/other.ts", line: 4, side: "additions", anchored: true, title: "Other repository", explanation: "Not here." },
    ],
    ...overrides,
  };
}

function renderViewer(aiReview: WorkspaceCodeReviewResult, extra: { aiReviewFocus?: { requestId: number; findingId?: string }; aiReviewStale?: boolean } = {}) {
  const fake = fakeWorkspaceClient();
  fake.listWorkspaceReviewThreads.mockResolvedValue({ workspaceId: "ws_ai", threads: [] });
  return render(
    <RepositoryPatchViewer
      aiReview={aiReview}
      feedback={{ baseCommitOid: "a".repeat(40), headCommitOid: "b".repeat(40), patchSha256: "sha256:p", client: fake.client, workspaceId: "ws_ai", repositoryId: "repo_checkout" }}
      patch={patch}
      theme="dark"
      {...extra}
    />,
  );
}

describe("AI review in the diff viewer", () => {
  it("puts only anchored findings of this repository on their changed lines", () => {
    renderViewer(review());
    const diff = screen.getByTestId(/^diff-/);
    const notes = within(diff).getAllByRole("note");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.closest("[data-line]")).toHaveAttribute("data-line", "additions:3");
    expect(within(notes[0]!).getByText("Blocking")).toBeInTheDocument();
    expect(within(notes[0]!).getByText("Zero retries hides failures")).toBeInTheDocument();
    expect(within(notes[0]!).getByText("Blocking: set a bounded retry count.")).toBeInTheDocument();
    expect(within(diff).queryByText("Name the constant")).not.toBeInTheDocument();
    expect(within(diff).queryByText("Other repository")).not.toBeInTheDocument();
  });

  it("gives CodeView a new item version when the review changes", () => {
    const view = renderViewer(review());
    const firstVersion = itemsSeen.at(-1)![0]!.version;
    view.rerender(
      <RepositoryPatchViewer
        aiReview={review({ findings: [] })}
        patch={patch}
        theme="dark"
      />,
    );
    const last = itemsSeen.at(-1)![0]!;
    expect(last.version).not.toBe(firstVersion);
    expect(last.annotations).toBeUndefined();
  });

  it("lists every finding for this repository in the AI review panel and reveals a line", async () => {
    const user = userEvent.setup();
    renderViewer(review(), { aiReviewFocus: { requestId: 1 }, aiReviewStale: true });
    const panel = await screen.findByRole("list", { name: "AI review findings" });
    const items = within(panel).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[1]!).getByText(/not on a changed line/)).toBeInTheDocument();
    expect(screen.getByText("The code changed after this review. Some lines can be different.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI review/, pressed: true })).toBeInTheDocument();

    scrollTo.mockClear();
    await user.click(within(items[0]!).getByRole("button", { name: /Zero retries hides failures/ }));
    await vi.waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ type: "line", lineNumber: 3, side: "additions" })));
    expect(within(items[0]!).getByText("The retry count is zero.")).toBeInTheDocument();
  });
});
