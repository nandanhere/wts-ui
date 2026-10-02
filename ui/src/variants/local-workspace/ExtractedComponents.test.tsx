import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Glyph } from "./Glyph";
import { GuideDialog } from "./GuideDialog";
import { ToastStack } from "./ToastStack";
import { WorkspaceCard } from "./WorkspaceCard";
import { ProtectedFilePreviewBoundary } from "./ProtectedFilePreviewBoundary";
import { WorkspaceRemovalDialog } from "./WorkspaceRemovalDialog";
import { CommandPalette } from "./CommandPalette";
import type { Workspace } from "./LocalWorkspace";

describe("Extracted presentational components in isolation", () => {
  const sampleWorkspace: Workspace = {
    id: "ws-test-1",
    intent: { type: "jira", issueKey: "WS-1" },
    key: "WS-1",
    kind: "Jira",
    title: "Test Workspace Title",
    lane: "active",
    workflowState: "active",
    workflowRevision: 1,
    workflowUpdatedAtUnixMs: Date.now(),
    workflowPersisted: true,
    lifecycleState: "materialized",
    knownWorktreeCount: 1,
    observedAtUnixMs: Date.now(),
    provider: "VS Code",
    repos: 1,
    repositoryPlans: [
      {
        label: "test-repo",
        baseRef: "main",
        worktreeLeaf: "test-repo",
      },
    ],
    observedWorkItems: [],
    path: "/tmp/ws-1",
    updated: "2m ago",
    updatedAtUnixMs: Date.now(),
    summary: "1 repository · branch main",
  };

  it("renders Glyph icon", () => {
    const { container } = render(<Glyph name="check" size={20} />);
    expect(container.querySelector("svg")).toBeTruthy();
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("20");
  });

  it("renders GuideDialog in isolation", () => {
    render(
      <GuideDialog
        open={true}
        onOpenChange={vi.fn()}
        onCreateWorkspace={vi.fn()}
      />,
    );
    expect(screen.getByText("How to use WTS")).toBeTruthy();
    expect(screen.getByText("The working loop")).toBeTruthy();
  });

  it("renders ToastStack in isolation", () => {
    render(
      <ToastStack
        toasts={[
          { id: "toast-1", message: "Workspace updated successfully", kind: "info" },
        ]}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText("Workspace updated successfully")).toBeTruthy();
  });

  it("renders WorkspaceCard in isolation", () => {
    render(<WorkspaceCard workspace={sampleWorkspace} onOpen={vi.fn()} />);
    expect(
      screen.getByRole("button", {
        name: "Open WS-1: Test Workspace Title",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Test Workspace Title")).toBeTruthy();
  });

  it("puts one next step on each card, with a question from the agent first", () => {
    const agent = { workspaceId: "ws-test-1", provider: "codex" as const, headline: "Codex needs attention", activity: "Asks a question",
      lastEventAtUnixMs: 1, observedLocally: false };
    const review = { id: "r", repositoryId: "repo", repository: "team/api", number: 4, title: "Fix", authorLogin: "a", sourceBranch: "s", targetBranch: "main", updatedAt: "2026-09-01T00:00:00Z", draft: false, reviewState: "requested" as const, status: "open" as const };
    const { rerender } = render(<WorkspaceCard workspace={sampleWorkspace} agent={{ ...agent, state: "attention", needsInput: "question" }} gitlabReview={review} onOpen={vi.fn()} />);
    expect(screen.getByText("Answer the agent")).toBeVisible();
    rerender(<WorkspaceCard workspace={sampleWorkspace} agent={{ ...agent, state: "idle" }} gitlabReview={review} onOpen={vi.fn()} />);
    expect(screen.getByText("Review the MR")).toBeVisible();
    rerender(<WorkspaceCard workspace={sampleWorkspace} agent={{ ...agent, state: "working" }} onOpen={vi.fn()} />);
    expect(screen.getByText("Agent works")).toBeVisible();
    rerender(<WorkspaceCard workspace={sampleWorkspace} agent={{ ...agent, state: "idle", updateKind: "completion" }} onOpen={vi.fn()} />);
    expect(screen.getByText("Check the agent result")).toBeVisible();
    rerender(<WorkspaceCard workspace={sampleWorkspace} onOpen={vi.fn()} />);
    expect(screen.queryByText(/Answer the agent|Review the MR|Agent works|Check the agent result/)).not.toBeInTheDocument();
  });

  it("keeps only distinct workspace actions in one keyboard-accessible row", async () => {
    const user = userEvent.setup();
    const openWorkspace = vi.fn();
    const openWorkspaceInVscode = vi.fn();
    const openJira = vi.fn();
    const moveToParked = vi.fn();

    render(
      <WorkspaceCard
        workspace={sampleWorkspace}
        onOpen={openWorkspace}
        onOpenWorkspace={openWorkspaceInVscode}
        primaryActionLabel="Open WS-1 workspace details"
        issueAction={{ label: "Open Jira issue", onPress: openJira }}
        moveActions={[
          { label: "Move to Parked", onPress: moveToParked },
        ]}
      />,
    );

    const actions = screen.getByRole("group", { name: "WS-1 actions" });
    const issueLink = screen.getByRole("button", { name: "Open Jira issue" });
    expect(issueLink).toHaveTextContent("WS-1");
    expect(
      within(actions).queryByRole("button", { name: "Open Jira issue" }),
    ).toBeNull();
    expect(screen.queryByText("Open Jira")).toBeNull();
    expect(within(actions).queryByText("Open in VS Code")).toBeNull();

    await user.click(
      within(actions).getByRole("button", { name: "Open WS-1 in VS Code" }),
    );
    expect(openWorkspaceInVscode).toHaveBeenCalledOnce();
    expect(openWorkspace).not.toHaveBeenCalled();

    await user.click(issueLink);
    expect(openJira).toHaveBeenCalledOnce();

    await user.click(
      within(actions).getByRole("button", { name: "Move WS-1" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Move to Parked" }),
    );
    expect(moveToParked).toHaveBeenCalledOnce();

  });

  it("renders WorkspaceRemovalDialog in isolation", () => {
    render(
      <WorkspaceRemovalDialog
        open={true}
        onOpenChange={vi.fn()}
        workspace={sampleWorkspace}
        preflight={{
          workspaceId: "ws-test-1",
          workspaceDisplayPath: "/tmp/ws-1",
          kind: "materializedWorkspace",
          ready: true,
          worktrees: [],
          generatedPaths: [],
          protectedPaths: [],
          retainedBranches: [],
          blockers: [],
          warnings: [],
          effectDigest: "digest-123",
        }}
        state="ready"
        error=""
        onRetry={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Remove WS-1 from this Mac?"),
    ).toBeTruthy();
  });

  it("keeps protected file text visible if the rich reader fails", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    function BrokenReader(): never {
      throw new Error("The rich reader failed.");
    }

    render(
      <ProtectedFilePreviewBoundary
        fallback={<pre># Protected planning content</pre>}
      >
        <BrokenReader />
      </ProtectedFilePreviewBoundary>,
    );

    expect(screen.getByText("# Protected planning content")).toBeVisible();
    consoleError.mockRestore();
  });

  it("previews protected files and requires a deletion checkbox", async () => {
    const onConfirm = vi.fn();
    render(
      <WorkspaceRemovalDialog
        open={true}
        onOpenChange={vi.fn()}
        workspace={sampleWorkspace}
        preflight={{
          workspaceId: sampleWorkspace.id,
          workspaceDisplayPath: "/tmp/ws-1",
          kind: "materializedWorkspace",
          ready: false,
          worktrees: [],
          generatedPaths: [],
          protectedPaths: [
            {
              displayPath: "/tmp/ws-1/plans-and-kanban",
              entries: ["FINDINGS.md", "plans/", "plans/PLAN.md"],
              entriesTruncated: false,
              filePreviews: [
                {
                  relativePath: "FINDINGS.md",
                  contents: "# Protected planning content\n",
                },
                {
                  relativePath: "plans/PLAN.md",
                  contents: "# Protected nested plan\n",
                },
              ],
            },
          ],
          retainedBranches: [],
          blockers: [
            {
              code: "planningDocumentsPresent",
              message: "The folder contains user-owned planning files.",
            },
          ],
          warnings: [],
          effectDigest: "digest-protected",
        }}
        state="ready"
        error=""
        onRetry={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText("plans-and-kanban")).toBeVisible();
    expect(within(screen.getByText("Protected planning files").closest("section")!).getByText("/tmp/ws-1")).toBeVisible();
    expect(screen.getByText("FINDINGS.md")).toBeVisible();
    expect(screen.getByText("plans/PLAN.md")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Read FINDINGS.md" }),
    );
    expect(
      screen.getByRole("region", { name: "Preview FINDINGS.md" }),
    ).toBeVisible();
    expect(
      screen.getByRole("navigation", { name: "Protected files" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Delete files and workspace" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to removal review" }),
    );
    const remove = screen.getByRole("button", {
      name: "Delete local data and workspace",
    });
    expect(remove).toBeDisabled();

    const assertion = screen.getByRole("checkbox", {
      name: /Delete the listed planning files and this workspace/i,
    });
    fireEvent.click(assertion);
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("allows reviewed removal of a workspace with local changes", () => {
    const onConfirm = vi.fn();
    render(
      <WorkspaceRemovalDialog
        open={true}
        onOpenChange={vi.fn()}
        workspace={sampleWorkspace}
        preflight={{
          workspaceId: sampleWorkspace.id,
          workspaceDisplayPath: "/tmp/ws-1",
          kind: "materializedWorkspace",
          ready: false,
          worktrees: [{
            repositoryId: "repo-1",
            label: "checkout-api",
            targetDisplayPath: "/tmp/ws-1/checkout-api",
            branchName: "wts/local-change",
            headCommitOid: "a".repeat(40),
            present: true,
          }],
          generatedPaths: [],
          protectedPaths: [],
          retainedBranches: ["wts/local-change"],
          blockers: [{
            code: "worktreeChanges",
            message: "The worktree contains local changes.",
            repositoryLabel: "checkout-api",
          }],
          warnings: [],
          effectDigest: "digest-local-changes",
        }}
        state="ready"
        error=""
        onRetry={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText("Removal needs confirmation")).toBeVisible();
    const assertion = screen.getByRole("checkbox", {
      name: /Delete local changes and this workspace/i,
    });
    const remove = screen.getByRole("button", {
      name: "Delete local data and workspace",
    });
    expect(remove).toBeDisabled();
    fireEvent.click(assertion);
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it("renders CommandPalette in isolation", () => {
    render(
      <CommandPalette
        open={true}
        onOpenChange={vi.fn()}
        commandQuery=""
        onCommandQueryChange={vi.fn()}
        activeCommandIndex={0}
        onActiveCommandIndexChange={vi.fn()}
        inputRef={{ current: null }}
        matchingCommandItems={[
          {
            id: "cmd-1",
            label: "Test Command",
            description: "Test description",
            group: "Actions",
            icon: "settings",
            run: vi.fn(),
          },
        ]}
        commandGroups={["Actions"]}
      />,
    );
    expect(
      screen.getByLabelText("Search workspaces and commands"),
    ).toBeTruthy();
    expect(screen.getByText("Test Command")).toBeTruthy();
  });
});
