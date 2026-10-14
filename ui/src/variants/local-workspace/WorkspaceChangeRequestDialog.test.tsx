import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceChangeRequestDraft } from "../../lib/wtsClient";
import { WorkspaceChangeRequestDialog } from "./WorkspaceChangeRequestDialog";

const stylesheet = readFileSync(
  resolve("src/variants/local-workspace/WorkspaceChangeRequestDialog.module.css"),
  "utf8",
);

const draft: WorkspaceChangeRequestDraft = {
  schemaVersion: 1,
  workspaceId: "11111111-1111-4111-8111-111111111111",
  repositoryId: "repo_orders",
  repositoryLabel: "orders-api",
  forge: "gitlab",
  host: "gitlab.example.test",
  sourceRemoteName: "upstream",
  sourceBranch: "feat/TASK-7197",
  sourceHeadCommitOid: "0123456789abcdef0123456789abcdef01234567",
  targetBranch: "main",
  commitSubject: "feat: validate admission",
  proposedBySessionId: "33333333-3333-4333-8333-333333333333",
  proposedByProvider: "codex",
  commits: [{
    commitOid: "0123456789abcdef0123456789abcdef01234567",
    subject: "feat: validate admission",
  }],
  changedFiles: ["src/admission.rs", "tests/admission.test.rs"],
  worktreeClean: true,
  remoteMatches: true,
  title: "TASK-7197: Validate admission",
  body: "## Summary\n\n- Validate admission",
  workItems: [{
    linkId: "22222222-2222-4222-8222-222222222222",
    issueKey: "TASK-7197",
    summary: "Validate admission",
  }],
  verificationStatus: "passed",
  verificationSummary: "8 verification checks passed",
  effectDigest: `sha256:${"a".repeat(64)}`,
};

describe("WorkspaceChangeRequestDialog", () => {
  it("keeps the action footer visible while long proposal content scrolls", () => {
    expect(stylesheet).toMatch(
      /\.dialog\s*\{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto;/s,
    );
    expect(stylesheet).toMatch(
      /\.content\s*\{[^}]*min-height:\s*0;[^}]*overflow:\s*auto;/s,
    );
  });

  it("reviews and submits editable provider-prefilled content", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <WorkspaceChangeRequestDialog
        draft={draft}
        error=""
        opening={false}
        requestingVerification={false}
        onOpenChange={vi.fn()}
        onRequestVerification={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole("dialog")).toHaveAttribute(
      "data-ui",
      "workspace.change-request-dialog",
    );
    expect(screen.getByText("upstream/feat/TASK-7197")).toBeVisible();
    expect(screen.getByText("Codex proposal")).toBeVisible();
    expect(screen.getByRole("region", { name: "Complete change inventory" })).toBeVisible();
    expect(screen.getByText("1 commit")).toBeVisible();
    expect(screen.getByText("feat: validate admission")).toBeVisible();
    expect(screen.getByText("2 changed files")).toBeVisible();
    expect(screen.getByText("TASK-7197")).toBeVisible();
    expect(screen.getByText("8 verification checks passed")).toBeVisible();
    expect(screen.getByText("Opens the form. GitLab creates the merge request.")).toBeVisible();

    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "TASK-7197: Reviewed title");
    await user.click(screen.getByRole("button", { name: /Continue in GitLab/ }));
    expect(onSubmit).toHaveBeenCalledWith(
      "TASK-7197: Reviewed title",
      draft.body,
    );
  });

  it("disables handoff while opening", () => {
    render(
      <WorkspaceChangeRequestDialog
        draft={draft}
        error=""
        opening
        requestingVerification={false}
        onOpenChange={vi.fn()}
        onRequestVerification={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();
  });

  it("shows failed verification as a failure instead of a success", () => {
    render(
      <WorkspaceChangeRequestDialog
        draft={{
          ...draft,
          verificationStatus: "failed",
          verificationSummary: "Targeted admission tests failed.",
        }}
        error=""
        opening={false}
        requestingVerification={false}
        onOpenChange={vi.fn()}
        onRequestVerification={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText("Targeted admission tests failed.").closest("p")).toHaveAttribute(
      "data-status",
      "failed",
    );
    expect(screen.getByText("Agent verification")).toBeVisible();
  });

  it("offers a bounded agent recovery action when verification was not reported", async () => {
    const user = userEvent.setup();
    const onRequestVerification = vi.fn();
    render(
      <WorkspaceChangeRequestDialog
        draft={{
          ...draft,
          verificationStatus: "notReported",
          verificationSummary: "The agent did not report verification.",
        }}
        error=""
        opening={false}
        requestingVerification={false}
        onOpenChange={vi.fn()}
        onRequestVerification={onRequestVerification}
        onSubmit={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Ask Codex to verify" }));
    expect(onRequestVerification).toHaveBeenCalledOnce();
  });
});
