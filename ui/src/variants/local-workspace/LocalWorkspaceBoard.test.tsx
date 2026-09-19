import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { GitlabMergeRequestInbox, GitlabReviewPatch, WorkspacePreflight } from "../../lib/wtsClient";
import { WorkspaceClientError } from "../../lib/wtsClient";
import {
  fakeWorkspaceClient,
  repositoryCatalogFixture,
  workspaceEvidenceFixture,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { loadActivityWatchReviewSnapshot } from "./activityWatchReviewCache";
import { saveTimeReviewSchedule } from "./timeReviewSchedule";
import { selectWorkspaceView, deferred, assistantMaterialization } from "./localWorkspaceTestHelpers";

function mockReviewComparison(
  fake: ReturnType<typeof fakeWorkspaceClient>,
  workspace: ReturnType<typeof workspaceFixture>,
  published: GitlabReviewPatch,
  sourceContent: string,
) {
  const latestWork = {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    repositoryId: published.repositoryId,
    repositoryLabel: workspace.repositories[0]!.label,
    baseCommitOid: published.baseCommitOid,
    headCommitOid: published.headCommitOid,
    patchSha256: `sha256:${"c".repeat(64)}`,
    patch: published.patch,
    patchTruncated: false,
    untrackedPaths: [],
    untrackedPathsTruncated: false,
  };
  fake.getWorkspaceGitlabComparison.mockResolvedValue({
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    repositoryId: published.repositoryId,
    repositoryLabel: latestWork.repositoryLabel,
    iid: published.iid,
    localHeadCommitOid: published.headCommitOid,
    status: "ready",
    published,
    latestWork,
    sinceMr: { ...latestWork, baseCommitOid: published.headCommitOid, patchSha256: `sha256:${"d".repeat(64)}`, patch: "" },
  });
  fake.getGitlabDiscussions.mockResolvedValue({
    schemaVersion: 1,
    repositoryId: published.repositoryId,
    iid: published.iid,
    scopeId: "e".repeat(64),
    viewerLogin: "reviewer",
    discussions: published.discussions,
    fetchedAtUnixMs: published.fetchedAtUnixMs,
    fromCache: false,
    truncated: false,
  });
  fake.getWorkspaceRepositorySource.mockImplementation(async (workspaceId, repositoryId, filePath) => ({
    schemaVersion: 1,
    workspaceId,
    repositoryId,
    filePath,
    content: sourceContent,
    revision: `sha256:${"f".repeat(64)}`,
  }));
}

describe("personal local workspace registry", () => {
  it("runs a due My time review while Spaces is open", async () => {
    localStorage.clear();
    const now = Date.now();
    const lastSuccessfulAtUnixMs = now - 5 * 60 * 60 * 1_000;
    saveTimeReviewSchedule({
      schemaVersion: 1,
      enabled: true,
      intervalHours: 4,
      startedAtUnixMs: lastSuccessfulAtUnixMs,
      lastSuccessfulAtUnixMs,
      notificationsEnabled: false,
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      },
    });
    fake.getActivityWatchDailyReview.mockImplementation(
      async (startedAtUnixMs, endedAtUnixMs) => ({
        schemaVersion: 1,
        startedAtUnixMs,
        endedAtUnixMs,
        totalActiveSeconds: 0,
        sessions: [],
        detail: "No activity was selected.",
      }),
    );

    render(<LocalWorkspace client={fake.client} />);

    expect(
      await screen.findByRole("heading", { name: "Spaces" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Local workspace board")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Work activity" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(fake.getActivityWatchDailyReview).toHaveBeenCalledTimes(1);
    });
    expect(fake.getActivityWatchDailyReview).toHaveBeenCalledWith(
      lastSuccessfulAtUnixMs,
      expect.any(Number),
    );
    expect(loadActivityWatchReviewSnapshot()).not.toBeNull();
    localStorage.clear();
  });

  it("stops the Spaces session poller after My time opens", async () => {
    vi.useFakeTimers();
    try {
      localStorage.clear();
      const workspace = workspaceFixture();
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture([workspace]),
        agentSessions: {
          schemaVersion: 1,
          sessions: [],
          observedSessions: [
            {
              schemaVersion: 1,
              sessionId: "observed-my-time",
              workspaceId: workspace.workspaceId,
              provider: "codex",
              source: "codexVscodeRollout",
              status: "working",
              activity: "editing",
              updateKind: "progress",
              startedAtUnixMs: Date.now() - 10_000,
              lastEventAtUnixMs: Date.now(),
            },
          ],
        },
      });

      render(<LocalWorkspace client={fake.client} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole("button", { name: "My time" }));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(
        screen.getByRole("heading", { name: "Work activity" }),
      ).toBeVisible();
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(2);
    } finally {
      localStorage.clear();
      vi.useRealTimers();
    }
  });

  it("opens the configured Jira issue from its workspace card", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      workspaceId: "ws_jira_card",
      intent: { type: "jira", issueKey: "PLATFORM-42" },
      title: "Prevent bare-metal scheduling",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    fake.previewWorkspaceJiraLink.mockResolvedValue({
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      provider: "jira",
      role: "primary",
      snapshot: {
        issueKey: "PLATFORM-42",
        content: "Open https://evil.example/browse/PLATFORM-42 instead.",
        browserUrl: "https://jira.example.test/browse/PLATFORM-42",
        fetchedAtUnixMs: 1_721_776_500_000,
      },
      previewDigest: `sha256:${"a".repeat(64)}`,
    });
    fake.openWorkspaceJiraPreview.mockResolvedValue({
      workspaceId: persisted.workspaceId,
      issueKey: "PLATFORM-42",
      accepted: true,
    });
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    render(<LocalWorkspace client={fake.client} />);

    const issueLink = await screen.findByRole("button", {
      name: "Open Jira issue PLATFORM-42",
    });
    const card = issueLink.closest(
      '[data-workspace-id="ws_jira_card"]',
    ) as HTMLElement;
    expect(card).not.toBeNull();
    expect(issueLink).toHaveTextContent("PLATFORM-42");
    expect(within(card).queryByText(/Open Jira/i)).not.toBeInTheDocument();

    await user.click(issueLink);

    await waitFor(() => {
      expect(fake.previewWorkspaceJiraLink).toHaveBeenCalledWith(
        persisted.workspaceId,
        "PLATFORM-42",
        "primary",
      );
      expect(fake.openWorkspaceJiraPreview).toHaveBeenCalledWith(
        persisted.workspaceId,
        "PLATFORM-42",
        "primary",
        `sha256:${"a".repeat(64)}`,
      );
      expect(open).not.toHaveBeenCalled();
    });
    open.mockRestore();
  });

  it("shows Jira keys observed in a repository workspace planning home", async () => {
    const persisted = workspaceFixture({
      intent: { type: "repositorySet", label: "flow-review" },
      title: "flow-review",
      observedWorkItems: [
        {
          issueKey: "PAY-2190",
          sourceFiles: ["PLAN.md", "FINDINGS.md"],
          observedAtUnixMs: 1_721_776_500_000,
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    render(<LocalWorkspace client={fake.client} />);

    const card = await screen.findByRole("button", {
      name: /^Open flow-review.* details$/i,
    });
    const issueReference = within(card).getByText("PAY-2190");
    expect(within(card).queryByText("Jira PAY-2190")).not.toBeInTheDocument();
    fireEvent.pointerMove(issueReference);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Observed in PLAN.md, FINDINGS.md",
    );
  });

  it("uses a task-oriented workbench header without exposing repository-set internals", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      intent: { type: "repositorySet", label: "flow-review" },
      title: "flow-review",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });

    render(<LocalWorkspace client={fake.client} />);

    const card = await screen.findByRole("button", {
      name: /^Open flow-review.* details$/i,
    });
    expect(within(card).queryByText("Workspace")).not.toBeInTheDocument();
    expect(within(card).queryByText("Repositories")).not.toBeInTheDocument();
    expect(within(card).queryByText("2 repositories")).not.toBeInTheDocument();
    expect(within(card).queryByText("Set")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Filter workspaces" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Workspace focus" }),
    ).not.toBeInTheDocument();

    await user.click(card);

    expect(screen.getByRole("tab", { name: "Workspace" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Plans" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Verify" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /More workspace views/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "CLI" })).not.toBeInTheDocument();
    expect(screen.queryByText("SET")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Created from selected repositories/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ repositories?/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Review & create workspace" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy workspace path" }),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Workspace actions" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "Refresh status" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Create revised workspace…" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Copy workspace path" }),
    ).not.toBeInTheDocument();
  });

  it("uses one compact actions menu after workspace creation", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({ title: "Ready workspace" });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: assistantMaterialization(persisted),
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /^Open .*Ready workspace.* details$/i }),
    );

    expect(
      screen.queryByRole("button", { name: "Open with…" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Open Codex in/i }),
    ).not.toBeInTheDocument();
    const actions = await screen.findByRole("button", {
      name: "Workspace actions",
    });
    expect(actions).toHaveTextContent("Actions");

    await user.click(actions);
    expect(
      screen.getByRole("menuitem", { name: "Open workspace" }),
    ).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Open with…" })).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Refresh status" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Create revised workspace…" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Remove workspace…" }),
    ).toBeVisible();
  });

  it("renames a workspace inline on double-click and persists the display name", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      intent: { type: "repositorySet", label: "flow-review" },
      title: "flow-review",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    const renamedPath = `${persisted.workspaceDisplayPath}-renamed`;
    fake.renameWorkspace.mockResolvedValue({
      ...persisted,
      displayName: "Release readiness",
      workspaceLeaf: `${persisted.workspaceLeaf}-renamed`,
      workspaceDisplayPath: renamedPath,
      updatedAtUnixMs: persisted.updatedAtUnixMs + 1,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /^Open flow-review.* details$/i }),
    );
    await user.dblClick(
      screen.getByRole("button", { name: "flow-review" }),
    );
    const input = screen.getByRole("textbox", { name: "Workspace name" });
    expect(input).toHaveValue("flow-review");
    await user.clear(input);
    await user.type(input, "Release readiness{Enter}");

    await waitFor(() =>
      expect(fake.renameWorkspace).toHaveBeenCalledWith(
        persisted.workspaceId,
        "Release readiness",
      ),
    );
    expect(
      await screen.findByRole("button", {
        name: "Release readiness",
      }),
    ).toBeVisible();
    expect(screen.getAllByText(renamedPath).length).toBeGreaterThan(0);
    expect(screen.queryByText(persisted.workspaceDisplayPath)).not.toBeInTheDocument();
  });

  it("loads a persisted draft on the board and opens its workbench", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });

    render(<LocalWorkspace client={fake.client} />);

    const card = await screen.findByRole("button", {
      name: /^Open PLATFORM-42: Checkout retries create duplicate captures.* details$/i,
    });
    const cardSurface = card.closest("article") as HTMLElement;
    expect(within(cardSurface).getByText("Codex")).toBeVisible();
    expect(within(cardSurface).getByText(/Plan saved/i)).toBeVisible();
    expect(fake.listWorkspaces).toHaveBeenCalledOnce();
    expect(fake.getWorkspace).not.toHaveBeenCalled();

    await user.click(card);

    expect(
      screen.getByRole("heading", { name: "Repository requests" }),
    ).toBeVisible();
    expect(
      screen.getByRole("table", { name: "Repository requests" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy workspace path" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", {
        name: "Turn this saved plan into isolated worktrees",
      }),
    ).toBeVisible();
    expect(screen.getAllByText("~/cd/platform-42-7fd1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("checkout-api").length).toBeGreaterThan(0);
  });

  it("starts a revised workspace with a planning home from the Plans empty state", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    fake.listWorkspacePlanningDocuments.mockRejectedValue(
      new WorkspaceClientError("This workspace does not have a planning home.", {
        code: "planning_not_configured",
      }),
    );

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
    );
    await selectWorkspaceView(user, "Plans & Kanban");
    // Wait for the lazy Plans module before checking its API result.
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await user.click(
      await screen.findByRole("button", { name: "Create planning home" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("New plan title")).toHaveValue(
      `${persisted.title} · revised`,
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Review revised setup/i }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await user.click(
      await within(dialog).findByRole("button", {
        name: "Continue without services",
      }),
    );
    expect(
      within(dialog).getByRole("radio", { name: /Create a starter kit/i }),
    ).toBeChecked();
  });

  it("announces a copied workspace path only after the clipboard write succeeds", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    const clipboardWrite = deferred<void>();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValueOnce(clipboardWrite.promise);

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", {
        name: /^Open PLATFORM-42: Checkout retries create duplicate captures.* details$/i,
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Copy workspace path" }),
    );
    expect(writeText).toHaveBeenCalledWith(persisted.workspaceDisplayPath);
    expect(
      screen.queryAllByRole("status").every(
        (element) =>
          !element.textContent?.includes(`${persisted.workspaceDisplayPath} copied`),
      ),
    ).toBe(true);

    await act(async () => {
      clipboardWrite.resolve();
      await clipboardWrite.promise;
    });
    expect(
      screen.getAllByRole("status").slice(-1)[0],
    ).toHaveTextContent(`${persisted.workspaceDisplayPath} copied`);
    writeText.mockRestore();
  });

  it("reports rejected and unavailable workspace clipboard writes", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "clipboard",
    );
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard denied"));

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", {
        name: /^Open PLATFORM-42: Checkout retries create duplicate captures.* details$/i,
      }),
    );
    const copyPath = screen.getByRole("button", {
      name: "Copy workspace path",
    });

    await user.click(copyPath);
    await waitFor(() =>
      expect(
        screen.getAllByRole("status").slice(-1)[0],
      ).toHaveTextContent("Clipboard denied · Could not copy workspace path"),
    );

    writeText.mockRestore();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    try {
      fireEvent.click(copyPath);
      expect(
        screen.getAllByRole("status").slice(-1)[0],
      ).toHaveTextContent(
        "Clipboard unavailable · Could not copy workspace path",
      );
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      }
    }
  });

  it("provides keyboard-accessible tooltips for the header icon controls", async () => {
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });

    const controls = [
      {
        button: screen.getByRole("button", { name: "Switch to dark mode" }),
        tooltip: "Use dark mode",
      },
      {
        button: screen.getByRole("button", { name: "Open How to use WTS" }),
        tooltip: "How to use WTS",
      },
      {
        button: screen.getByRole("button", {
          name: "Open Environment and integrations",
        }),
        tooltip: "Environment & integrations (⌘,)",
      },
    ];

    for (const { button, tooltip } of controls) {
      expect(button).not.toHaveAttribute("title");
      fireEvent.pointerMove(button);
      fireEvent.focus(button);
      expect(await screen.findByRole("tooltip")).toHaveTextContent(tooltip);
      fireEvent.blur(button);
      await waitFor(() =>
        expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
      );
    }
  });

  it("shows one clear primary creation action on an empty board", async () => {
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });

    expect(
      screen.getAllByRole("button", { name: "New workspace" }),
    ).toHaveLength(1);
  });

  it("explains why the creation action is unavailable", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: "New workspace" }),
    );

    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    expect(
      within(dialog).getByText(
        "Choose at least one local repository to continue.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    ).toBeDisabled();
  });

  it("renders last-known materialization without deeply validating every board card", async () => {
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });

    render(<LocalWorkspace client={fake.client} />);

    const card = await screen.findByRole("button", {
      name: /^Open PLATFORM-42.* details$/i,
    });
    const cardSurface = card.closest("article") as HTMLElement;
    expect(
      within(screen.getByLabelText("Local workspace board")).getByText("Ready"),
    ).toBeVisible();
    expect(
      within(cardSurface).getByText("Last known · 1 worktree created"),
    ).toBeVisible();
    expect(
      within(cardSurface).queryByText("Not scanned"),
    ).not.toBeInTheDocument();
    expect(fake.getWorkspaceMaterialization).not.toHaveBeenCalled();
  });

  it("shows assigned reviews in Ready and prepares a source-branch review workspace", async () => {
    const user = userEvent.setup();
    const catalog = repositoryCatalogFixture();
    const repository = catalog.repositories[0]!;
    const reviewWorkspace = workspaceFixture({
      workspaceId: "ws_review_checkout_17",
      intent: { type: "repositorySet", label: "Review acme/checkout-api !17" },
      title: "Review acme/checkout-api !17",
      preferredProvider: "codex",
      repositories: [{
        requestId: repository.id,
        repositoryId: repository.id,
        label: repository.label,
        baseRef: "feat/review-checkout",
        worktreeLeaf: "checkout-api",
      }],
      planning: { folder: "plansAndKanban", format: "kanban" },
    });
    const materialization = assistantMaterialization(reviewWorkspace);
    const preflight: WorkspacePreflight = {
      workspaceId: reviewWorkspace.workspaceId,
      workspaceDisplayPath: reviewWorkspace.workspaceDisplayPath,
      codeWorkspaceDisplayPath: materialization.codeWorkspaceDisplayPath,
      branchName: materialization.branchName,
      ready: true,
      effectDigest: materialization.effectDigest,
      repositories: [{
        repositoryId: repository.id,
        label: repository.label,
        sourceDisplayPath: "/repos/checkout-api",
        requestedBaseRef: "feat/review-checkout",
        resolvedBaseRef: "refs/heads/feat/review-checkout",
        baseCommitOid: materialization.worktrees[0]!.baseCommitOid,
        targetDisplayPath: materialization.worktrees[0]!.targetDisplayPath,
      }],
      blockers: [],
      warnings: [],
      graph: { status: "notStarted", detail: "Not started." },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      repositories: catalog,
      create: { workspace: reviewWorkspace, replayed: false },
      preflight,
      materialize: { replayed: false, materialization },
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "fresh",
        reviews: [
          {
            id: "1017",
            repositoryId: repository.id,
            repository: "acme/checkout-api",
            number: 17,
            title: "Review checkout delivery",
            authorLogin: "bob",
            sourceBranch: "feat/review-checkout",
            targetBranch: "main",
            updatedAt: "2026-08-17T09:00:00Z",
            draft: false,
            reviewState: "requested",
            status: "open",
            commentCount: 3,
            discussionsResolved: false,
          },
          {
            id: "1016",
            repositoryId: repository.id,
            repository: "acme/checkout-api",
            number: 16,
            title: "Approved checkout cleanup",
            authorLogin: "dana",
            sourceBranch: "feat/approved-cleanup",
            targetBranch: "main",
            updatedAt: "2026-08-16T09:00:00Z",
            draft: false,
            reviewState: "approved",
            status: "open",
          },
        ],
        fetchedAtUnixMs: 1_776_585_600_000,
        detail: "GitLab returned the current individual review requests.",
      },
    });
    fake.prepareGitlabReviewRepository.mockResolvedValue({
      repository,
      repositoryRootDisplayPath: catalog.repositoryRootDisplayPath,
      reusedExisting: true,
    });
    fake.openGitlabMergeRequest.mockResolvedValue({
      repositoryId: repository.id,
      iid: 17,
      accepted: true,
    });
    fake.launchAgentSession.mockResolvedValue({
      schemaVersion: 1,
      sessionId: "99999999-9999-4999-8999-999999999999",
      workspaceId: reviewWorkspace.workspaceId,
      provider: "codex",
      terminal: "terminal",
      category: "review",
      status: "launching",
      startedAtUnixMs: 1_776_585_600_000,
      lastHeartbeatAtUnixMs: 1_776_585_600_000,
      endedAtUnixMs: null,
      failure: null,
    });

    render(<LocalWorkspace client={fake.client} />);

    await screen.findByText("Review checkout delivery");
    const board = screen.getByLabelText("Local workspace board");
    expect(
      within(board)
        .getAllByRole("region")
        .map(
          (region) =>
            within(region).getByRole("heading", { level: 2 }).textContent,
        ),
    ).toEqual(["Ready", "Review", "Active", "Parked"]);
    for (const region of within(board).getAllByRole("region")) {
      const header = within(region).getByRole("heading", { level: 2 })
        .parentElement?.parentElement;
      expect(header?.querySelector("em")).toBeNull();
      expect(header?.querySelector("small")).toBeNull();
    }
    const ready = within(board).getByRole("region", { name: "Ready" });
    expect(within(ready).getByText("acme/checkout-api")).toBeVisible();
    expect(within(ready).getByText("MR !17")).toBeVisible();
    expect(within(ready).queryByText("Create workspace")).toBeNull();
    expect(within(ready).queryByText("Approved checkout cleanup")).toBeNull();
    expect(within(ready).getByText("3 comments")).toBeVisible();
    expect(
      ready.querySelector('[data-ui="spaces.review.1017"]'),
    ).toHaveAttribute("data-status", "discussion");

    await user.click(
      within(ready).getByRole("button", {
        name: "Open acme/checkout-api merge request !17",
      }),
    );
    expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith(
      repository.id,
      17,
    );

    await user.click(
      within(ready).getByRole("button", {
        name: "Start review",
      }),
    );
    expect(fake.prepareGitlabReviewRepository).toHaveBeenCalledWith(
      repository.id,
      17,
    );
    expect(screen.queryByRole("dialog", { name: "New workspace" })).toBeNull();
    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: {
          type: "repositorySet",
          label: "Review acme/checkout-api !17",
        },
        title: "Review acme/checkout-api !17",
        preferredProvider: "codex",
        repositories: [
          {
            repositoryId: repository.id,
            label: repository.label,
            baseRef: "feat/review-checkout",
          },
        ],
        planning: { folder: "plansAndKanban", format: "kanban" },
      },
      expect.any(String),
    );
    expect(fake.preflightWorkspace).toHaveBeenCalledWith(reviewWorkspace.workspaceId);
    expect(fake.materializeWorkspace).toHaveBeenCalledWith(
      reviewWorkspace.workspaceId,
      materialization.effectDigest,
      expect.any(String),
    );
    expect(fake.launchAgentSession).toHaveBeenCalledWith(
      reviewWorkspace.workspaceId,
      expect.objectContaining({
        provider: "codex",
        category: "review",
        prompt: expect.stringContaining("Write the durable initial review"),
      }),
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Review",
      "Agent review",
      "Code review",
    ]);
    expect(screen.getByRole("tab", { name: "Code review" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.getByRole("tab", { name: "Agent review" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Verify" })).toBeNull();
    expect(screen.getByRole("button", { name: "Workspace actions" })).toBeVisible();
  });

  it("shows one existing review workspace and opens its provider changes", async () => {
    const user = userEvent.setup();
    const reviewWorkspace = workspaceFixture({
      workspaceId: "ws_review_checkout_17",
      intent: { type: "repositorySet", label: "Review acme/checkout-api !17" },
      title: "Review acme/checkout-api !17",
      repositories: [{
        requestId: "repo_checkout",
        repositoryId: "repo_checkout",
        label: "checkout-api",
        baseRef: "feat/review-checkout",
        worktreeLeaf: "checkout-api",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_776_585_600_000,
      },
      workflow: {
        state: "ready",
        revision: 2,
        updatedAtUnixMs: 1_776_585_600_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([reviewWorkspace]),
      persistedMaterialization: assistantMaterialization(reviewWorkspace),
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "fresh",
        reviews: [{
          id: "1017",
          repositoryId: "repo_checkout",
          repository: "acme/checkout-api",
          number: 17,
          title: "Review checkout delivery",
          authorLogin: "bob",
          sourceBranch: "feat/review-checkout",
          targetBranch: "main",
          updatedAt: "2026-08-19T09:00:00Z",
          draft: false,
          reviewState: "requested",
          status: "open",
        }],
        fetchedAtUnixMs: 1_776_585_600_000,
        detail: "GitLab returned current review requests.",
      },
    });
    fake.transitionWorkspaceWorkflow.mockResolvedValue({
      state: "review",
      revision: 3,
      updatedAtUnixMs: 1_776_585_700_000,
    });
    mockReviewComparison(fake, reviewWorkspace, {
      schemaVersion: 1,
      repositoryId: "repo_checkout",
      iid: 17,
      baseCommitOid: "a".repeat(40),
      startCommitOid: "a".repeat(40),
      headCommitOid: "b".repeat(40),
      commits: [],
      discussions: [],
      patch: [
        "diff --git a/src/checkout.ts b/src/checkout.ts",
        "--- a/src/checkout.ts",
        "+++ b/src/checkout.ts",
        "@@ -1 +1 @@",
        "-export const ready = false;",
        "+export const ready = true;",
        "",
      ].join("\n"),
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1_787_134_945_000,
    }, "export const ready = true;\n");

    render(<LocalWorkspace client={fake.client} />);

    await waitFor(() => expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledWith(
      "ws_review_checkout_17",
      "review",
      2,
    ));
    expect(document.querySelector('[data-ui="spaces.review.1017"]')).toBeNull();
    expect(screen.getAllByText("Review acme/checkout-api !17")).toHaveLength(1);

    await user.click(screen.getByRole("button", {
      name: "Open Review acme/checkout-api !17: Review acme/checkout-api !17 details",
    }));
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    const reviewHeader = await screen.findByTestId("repository-review-toolbar");
    expect(await within(reviewHeader).findByText("acme/checkout-api !17")).toBeVisible();
    expect(within(reviewHeader).getByRole("heading", { name: "Review checkout delivery" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Code comparison" })).toHaveValue("latestWork");
    expect(await screen.findByRole("button", { name: "src/checkout.ts In MR" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Edit locally" })).toBeVisible();
    await user.click(screen.getByRole("combobox", { name: "Code comparison" }));
    await user.click(screen.getByRole("option", { name: "In the MR" }));
    expect(screen.getByRole("combobox", { name: "Code comparison" })).toHaveValue("inMr");
    expect(screen.getByText("Published code")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit locally" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Local file editor" })).not.toBeInTheDocument();
    expect(fake.getWorkspaceGitlabComparison).toHaveBeenCalledWith(reviewWorkspace.workspaceId, "repo_checkout", 17, false);
    expect(fake.prepareGitlabReviewRepository).not.toHaveBeenCalled();
  });

  it("redirects a review workspace verification link to a visible review view", async () => {
    const reviewWorkspace = workspaceFixture({
      workspaceId: "ws_review_checkout_17",
      intent: { type: "repositorySet", label: "Review acme/checkout-api !17" },
      title: "Review acme/checkout-api !17",
      repositories: [{
        requestId: "repo_checkout",
        repositoryId: "repo_checkout",
        label: "checkout-api",
        baseRef: "feat/review-checkout",
        worktreeLeaf: "checkout-api",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_776_585_600_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([reviewWorkspace]),
      persistedMaterialization: assistantMaterialization(reviewWorkspace),
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "fresh",
        reviews: [{
          id: "1017",
          repositoryId: "repo_checkout",
          repository: "acme/checkout-api",
          number: 17,
          title: "Review checkout delivery",
          authorLogin: "bob",
          sourceBranch: "feat/review-checkout",
          targetBranch: "main",
          updatedAt: "2026-08-19T09:00:00Z",
          draft: false,
          reviewState: "requested",
          status: "open",
        }],
        fetchedAtUnixMs: 1_776_585_600_000,
        detail: "GitLab returned current review requests.",
      },
    });

    render(
      <LocalWorkspace
        client={fake.client}
        initialView="workbench"
        initialWorkspaceId={reviewWorkspace.workspaceId}
        initialWorkbenchTab="verification"
      />,
    );

    expect(await screen.findByRole("tab", { name: "Review" })).toHaveAttribute(
      "data-state",
      "active",
    );
    expect(screen.queryByRole("tab", { name: "Verify" })).toBeNull();
  });

  it("moves a workspace with a fresh open merge request to Parked", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      workspaceId: "ws_pending_mr",
      intent: { type: "repositorySet", label: "Pending MR" },
      title: "Wait for merge",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
      workflow: {
        state: "review",
        revision: 4,
        updatedAtUnixMs: 1_721_776_500_000,
      },
    });
    const newerParked = workspaceFixture({
      workspaceId: "ws_newer_parked",
      intent: { type: "repositorySet", label: "Newer parked" },
      title: "Wait for another reason",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_776_153_400_000,
      },
      workflow: {
        state: "parked",
        revision: 2,
        updatedAtUnixMs: 1_776_153_400_000,
      },
      updatedAtUnixMs: 1_776_153_400_000,
    });
    const pendingMergeRequestInbox: GitlabMergeRequestInbox = {
      schemaVersion: 1,
      state: "fresh",
      mergeRequests: [{
        id: "mr-42",
        repositoryId: "repo_checkout",
        projectPath: "acme/checkout-api",
        webUrl: "https://gitlab.example.com/acme/checkout-api/-/merge_requests/42",
        iid: 42,
        title: "Wait for delivery",
        authorUsername: "alice",
        sourceBranch: "feat/pending",
        targetBranch: "main",
        updatedAt: "2026-08-17T12:00:00Z",
        draft: false,
        status: "open",
      }],
      fetchedAtUnixMs: 1_776_153_300_000,
      detail: "GitLab returned current merge requests.",
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted, newerParked]),
    });
    fake.getGitlabMergeRequests.mockImplementation(async (workspaceId) =>
      workspaceId === "ws_pending_mr"
        ? pendingMergeRequestInbox
        : {
            schemaVersion: 1,
            state: "fresh",
            mergeRequests: [],
            fetchedAtUnixMs: 1_776_153_400_000,
            detail: "GitLab returned no matching merge requests.",
          },
    );
    fake.transitionWorkspaceWorkflow.mockResolvedValue({
      state: "parked",
      revision: 5,
      updatedAtUnixMs: 1_776_153_300_000,
    });
    fake.openGitlabMergeRequest.mockResolvedValue({
      repositoryId: "repo_checkout",
      iid: 42,
      accepted: true,
    });

    render(<LocalWorkspace client={fake.client} />);

    await waitFor(() =>
      expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledWith(
        "ws_pending_mr",
        "parked",
        4,
      ),
    );
    const parkedLane = screen.getByRole("region", { name: "Parked" });
    const pendingCard = within(parkedLane).getByRole("button", {
      name: "Open Pending MR: Wait for merge details",
    });
    const pendingCardSurface = pendingCard.closest("article") as HTMLElement;
    expect(within(pendingCardSurface).getByText("MR !42")).toBeVisible();
    expect(within(pendingCardSurface).getByText("Open")).toBeVisible();
    await user.click(within(pendingCardSurface).getByRole("link", {
      name: "Open merge request !42 in GitLab",
    }));
    expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith(
      "repo_checkout",
      42,
    );
    expect(pendingCard.closest("article")).toHaveAttribute(
      "data-delivery-status",
      "open",
    );
    const workspaceCards = within(parkedLane)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-label")?.startsWith("Open "));
    expect(workspaceCards[0]).toBe(pendingCard);
  });

  it("tracks a merge request after the workspace branch changes", async () => {
    const workspace = workspaceFixture({
      workspaceId: "ws_changed_branch",
      intent: { type: "repositorySet", label: "Changed branch" },
      title: "Track the published branch",
      lifecycle: {
        materializationState: "needsAttention",
        worktreeCount: 0,
        observedAtUnixMs: 1_776_153_300_000,
      },
      workflow: {
        state: "review",
        revision: 4,
        updatedAtUnixMs: 1_776_153_300_000,
        placement: { mode: "pinned", rank: 0 },
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([workspace]),
    });
    fake.getGitlabMergeRequests.mockResolvedValue({
      schemaVersion: 1,
      state: "fresh",
      mergeRequests: [{
        id: "mr-43132",
        repositoryId: "repo_checkout",
        projectPath: "Ops/salt-config",
        webUrl: "https://gitlab.example.com/Ops/salt-config/-/merge_requests/43132",
        iid: 43132,
        title: "Track the published branch",
        authorUsername: "alice",
        sourceBranch: "feat/SRETOOLS-7179",
        targetBranch: "master",
        sourceHeadCommitOid: "f4f012b9b03199866581c6449a20c22912b5ed0a",
        updatedAt: "2026-09-11T15:15:51+05:30",
        draft: false,
        status: "open",
      }],
      fetchedAtUnixMs: 1_776_153_300_000,
      detail: "GitLab returned the current merge request.",
    });

    render(<LocalWorkspace client={fake.client} />);

    await waitFor(() =>
      expect(fake.getGitlabMergeRequests).toHaveBeenCalledWith(
        "ws_changed_branch",
      ),
    );
    const board = screen.getByLabelText("Local workspace board");
    expect(await within(board).findByText("MR !43132")).toBeVisible();
    expect(within(board).getByText("Open")).toBeVisible();
  });

  it("refreshes merge request state on the Kanban board", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      workspaceId: "ws_live_mr",
      intent: { type: "repositorySet", label: "Live MR" },
      title: "Watch merge request state",
      repositories: [{
        requestId: "repo_checkout",
        repositoryId: "repo_checkout",
        label: "checkout-api",
        baseRef: "feat/PLATFORM-42",
        worktreeLeaf: "checkout-api",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_776_153_300_000,
      },
      workflow: {
        state: "parked",
        revision: 5,
        updatedAtUnixMs: 1_776_153_300_000,
        placement: { mode: "pinned", rank: 0 },
      },
    });
    const mergeRequest = {
      id: "mr-live-42",
      repositoryId: "repo_checkout",
      projectPath: "acme/checkout-api",
      webUrl: "https://gitlab.example.com/acme/checkout-api/-/merge_requests/42",
      iid: 42,
      title: "Watch delivery",
      authorUsername: "alice",
      sourceBranch: "feat/PLATFORM-42",
      targetBranch: "main",
      updatedAt: "2026-08-28T08:00:00Z",
      draft: false,
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    fake.getGitlabMergeRequests
      .mockResolvedValueOnce({
        schemaVersion: 1,
        state: "fresh",
        mergeRequests: [{ ...mergeRequest, status: "open" }],
        fetchedAtUnixMs: 1_776_153_300_000,
        detail: "GitLab returned an open merge request.",
      })
      .mockResolvedValue({
        schemaVersion: 1,
        state: "fresh",
        mergeRequests: [{ ...mergeRequest, status: "merged" }],
        fetchedAtUnixMs: 1_776_153_360_000,
        detail: "GitLab returned a merged merge request.",
      });

    render(<LocalWorkspace client={fake.client} />);
    const board = await screen.findByLabelText("Local workspace board");
    expect(await within(board).findByText("Open")).toBeVisible();

    await user.click(screen.getByRole("button", {
      name: "Refresh review status",
    }));

    expect(await within(board).findByText("Merged")).toBeVisible();
    expect(fake.getGitlabMergeRequests).toHaveBeenCalledTimes(2);
  });

  it("moves the exact review workspace to Parked after the user approves", async () => {
    const user = userEvent.setup();
    const reviewWorkspace = workspaceFixture({
      workspaceId: "ws_review_obx_9",
      intent: {
        type: "repositorySet",
        label: "Review sre-tools/obx-api !9",
      },
      title: "Review sre-tools/obx-api !9",
      repositories: [{
        requestId: "repo_obx_api",
        repositoryId: "repo_obx_api",
        label: "obx-api",
        baseRef: "SRETOOLS-6349",
        worktreeLeaf: "obx-api",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_787_029_200_000,
      },
      workflow: {
        state: "review",
        revision: 6,
        updatedAtUnixMs: 1_787_029_200_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([reviewWorkspace]),
      persistedMaterialization: assistantMaterialization(reviewWorkspace),
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "fresh",
        reviews: [{
          id: "887185",
          repositoryId: "repo_obx_api",
          repository: "sre-tools/obx-api",
          number: 9,
          title: "Validate the LogQL time range",
          authorLogin: "priya",
          sourceBranch: "SRETOOLS-6349",
          targetBranch: "develop",
          updatedAt: "2026-08-18T05:05:48Z",
          draft: false,
          reviewState: "approved",
          status: "open",
          commentCount: 1,
        }],
        fetchedAtUnixMs: 1_787_029_200_000,
        detail: "GitLab returned current review requests and approved merge requests.",
      },
    });
    fake.transitionWorkspaceWorkflow.mockResolvedValue({
      state: "parked",
      revision: 7,
      updatedAtUnixMs: 1_787_029_300_000,
    });
    mockReviewComparison(fake, reviewWorkspace, {
      schemaVersion: 1,
      repositoryId: "repo_obx_api",
      iid: 9,
      baseCommitOid: "a".repeat(40),
      startCommitOid: "a".repeat(40),
      headCommitOid: "b".repeat(40),
      commits: [],
      discussions: [],
      patch: [
        "diff --git a/src/query.go b/src/query.go",
        "--- a/src/query.go",
        "+++ b/src/query.go",
        "@@ -1 +1 @@",
        "-return nil",
        "+return error",
        "",
      ].join("\n"),
      patchTruncated: false,
      fromCache: false,
      fetchedAtUnixMs: 1_787_134_945_000,
    }, "return error\n");

    render(<LocalWorkspace client={fake.client} />);

    await waitFor(() =>
      expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledWith(
        "ws_review_obx_9",
        "parked",
        6,
      ),
    );
    expect(
      within(screen.getByRole("region", { name: "Parked" })).getByText(
        "Review sre-tools/obx-api !9",
      ),
    ).toBeVisible();
    await user.click(
      within(screen.getByRole("region", { name: "Parked" })).getByRole(
        "button",
        {
          name: "Open Review sre-tools/obx-api !9: Review sre-tools/obx-api !9 details",
        },
      ),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Review changes",
      }),
    );
    const reviewHeader = await screen.findByTestId("repository-review-toolbar");
    expect(await within(reviewHeader).findByText("sre-tools/obx-api !9")).toBeVisible();
    expect(within(reviewHeader).getByRole("heading", { name: "Validate the LogQL time range" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Code comparison" })).toHaveValue("latestWork");
    expect(await screen.findByRole("button", { name: "src/query.go In MR" })).toBeVisible();
    expect(fake.getWorkspaceGitlabComparison).toHaveBeenCalledWith(reviewWorkspace.workspaceId, "repo_obx_api", 9, false);
  });

  it("shows a merged review state and opens its trusted GitLab link", async () => {
    const user = userEvent.setup();
    const reviewWorkspace = workspaceFixture({
      workspaceId: "ws_review_merged_22",
      intent: { type: "repositorySet", label: "Review sre-tools/ppxe-verify !22" },
      title: "Review sre-tools/ppxe-verify !22",
      repositories: [{
        requestId: "repo_ppxe_verify",
        repositoryId: "repo_ppxe_verify",
        label: "ppxe-verify",
        baseRef: "fix/health-endpoint-fallback",
        worktreeLeaf: "ppxe-verify",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_787_029_200_000,
      },
      workflow: {
        state: "parked",
        revision: 7,
        updatedAtUnixMs: 1_787_029_300_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([reviewWorkspace]),
      persistedMaterialization: assistantMaterialization(reviewWorkspace),
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "fresh",
        reviews: [{
          id: "merge-22",
          repositoryId: "repo_ppxe_verify",
          repository: "sre-tools/ppxe-verify",
          number: 22,
          title: "[SRETOOLS-6349] Fix health endpoint fallback",
          authorLogin: "vikram.kangotra",
          sourceBranch: "fix/health-endpoint-fallback",
          targetBranch: "main",
          updatedAt: "2026-08-18T05:05:48Z",
          draft: false,
          reviewState: "approved",
          status: "merged",
        }],
        fetchedAtUnixMs: 1_787_029_200_000,
        detail: "GitLab returned approved merge requests.",
      },
    });
    fake.openGitlabMergeRequest.mockResolvedValue({
      repositoryId: "repo_ppxe_verify",
      iid: 22,
      accepted: true,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", {
      name: "Open Review sre-tools/ppxe-verify !22: Review sre-tools/ppxe-verify !22 details",
    }));

    const reviewAction = await screen.findByRole("region", {
      name: "Workspace review action",
    });
    expect(within(reviewAction).getByText("Merged")).toBeVisible();
    expect(within(reviewAction).getByRole("heading", {
      name: "[SRETOOLS-6349] Fix health endpoint fallback",
    })).toBeVisible();
    expect(reviewAction).toHaveTextContent(
      "GitLab merged this change. No review action remains.",
    );
    expect(screen.getByRole("tab", { name: "Review" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Review scope" })).toBeVisible();
    expect(screen.getByRole("region", {
      name: "Review issue context",
    })).toHaveTextContent("SRETOOLS-6349");
    expect(screen.queryByRole("region", { name: "Workspace facts" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Linked Jira issues" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agent sessions" })).toBeNull();
    expect(screen.queryByText("Managed worktrees")).toBeNull();
    await user.click(within(reviewAction).getByRole("link", {
      name: "Open merge request !22 in GitLab",
    }));
    expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith(
      "repo_ppxe_verify",
      22,
    );
    expect(fake.confirmWorkspaceJiraLink).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "requested",
      draft: false,
      reviewState: "requested" as const,
      status: "open" as const,
      workflowState: "review" as const,
      label: "Review requested",
      detail: "GitLab requests your review.",
    },
    {
      name: "draft",
      draft: true,
      reviewState: "requested" as const,
      status: "open" as const,
      workflowState: "review" as const,
      label: "Draft",
      detail: "This merge request is a draft.",
    },
    {
      name: "approved",
      draft: false,
      reviewState: "approved" as const,
      status: "open" as const,
      workflowState: "parked" as const,
      label: "Approved",
      detail: "Your approval is recorded. GitLab has not merged this change.",
    },
    {
      name: "new changes",
      draft: false,
      reviewState: "changesAfterApproval" as const,
      status: "open" as const,
      workflowState: "review" as const,
      label: "New changes",
      detail: "The author added commits after your approval.",
    },
    {
      name: "closed",
      draft: false,
      reviewState: "approved" as const,
      status: "closed" as const,
      workflowState: "active" as const,
      label: "Closed",
      detail: "GitLab closed this change. No review action remains.",
    },
  ])("shows the exact $name review result", async ({
    draft,
    reviewState,
    status,
    workflowState,
    label,
    detail,
  }) => {
    const user = userEvent.setup();
    const reviewWorkspace = workspaceFixture({
      workspaceId: `ws_review_${status}_${reviewState}`,
      intent: { type: "repositorySet", label: "Review sre-tools/ppxe-verify !22" },
      title: "Review sre-tools/ppxe-verify !22",
      repositories: [{
        requestId: "repo_ppxe_verify",
        repositoryId: "repo_ppxe_verify",
        label: "ppxe-verify",
        baseRef: "fix/health-endpoint-fallback",
        worktreeLeaf: "ppxe-verify",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_787_029_200_000,
      },
      workflow: {
        state: workflowState,
        revision: 7,
        updatedAtUnixMs: 1_787_029_300_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([reviewWorkspace]),
      persistedMaterialization: assistantMaterialization(reviewWorkspace),
      gitlabReviewInbox: {
        schemaVersion: 1,
        state: "fresh",
        reviews: [{
          id: "merge-22",
          repositoryId: "repo_ppxe_verify",
          repository: "sre-tools/ppxe-verify",
          number: 22,
          title: "Fix health endpoint fallback",
          authorLogin: "vikram.kangotra",
          sourceBranch: "fix/health-endpoint-fallback",
          targetBranch: "main",
          updatedAt: "2026-08-18T05:05:48Z",
          draft,
          reviewState,
          status,
        }],
        fetchedAtUnixMs: 1_787_029_200_000,
        detail: "GitLab returned the current merge request state.",
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", {
      name: "Open Review sre-tools/ppxe-verify !22: Review sre-tools/ppxe-verify !22 details",
    }));

    const reviewAction = await screen.findByRole("region", {
      name: "Workspace review action",
    });
    expect(within(reviewAction).getByText(label)).toBeVisible();
    expect(reviewAction).toHaveTextContent(detail);
  });

  it("shows an open VS Code session without letting finished WTS history mask live work", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const active = workspaceFixture({
      workspaceId: "ws_active",
      intent: { type: "jira", issueKey: "RUN-1" },
      title: "Update the checkout flow",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: now - 60_000,
      },
    });
    const idle = workspaceFixture({
      workspaceId: "ws_idle",
      intent: { type: "jira", issueKey: "IDLE-1" },
      title: "Review account settings",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: now - 120_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([active, idle]),
      open: {
        provider: "vsCode",
        accepted: true,
        workspaceId: active.workspaceId,
        codeWorkspaceDisplayPath: `${active.workspaceDisplayPath}/wts.code-workspace`,
      },
      agentSessions: {
        schemaVersion: 1,
        sessions: [
          {
            schemaVersion: 1,
            sessionId: "22222222-2222-4222-8222-222222222222",
            workspaceId: active.workspaceId,
            provider: "codex",
            terminal: "terminal",
            category: "implementation",
            status: "completed",
            startedAtUnixMs: now - 400_000,
            lastHeartbeatAtUnixMs: now - 1_000,
            endedAtUnixMs: now - 1_000,
            failure: null,
          },
        ],
        observedSessions: [
          {
            schemaVersion: 1,
            sessionId: "33333333-3333-4333-8333-333333333333",
            workspaceId: active.workspaceId,
            provider: "codex",
            source: "codexVscodeRollout",
            status: "working",
            activity: "runningCommand",
            latestUpdate:
              "Updated the checkout flow and started the focused tests.",
            updateKind: "progress",
            startedAtUnixMs: now - 300_000,
            lastEventAtUnixMs: now - 5_000,
          },
          {
            schemaVersion: 1,
            sessionId: "44444444-4444-4444-8444-444444444444",
            workspaceId: idle.workspaceId,
            provider: "codex",
            source: "codexVscodeRollout",
            status: "idle",
            activity: null,
            latestUpdate:
              "Finished the [account settings review](/private/workspace/review.md). All checks passed.",
            updateKind: "completion",
            startedAtUnixMs: now - 600_000,
            lastEventAtUnixMs: now - 120_000,
          },
        ],
      },
    });

    render(<LocalWorkspace client={fake.client} />);

    await screen.findByRole("button", {
      name: /Open RUN-1.*details/i,
    });
    await waitFor(() => {
      expect(fake.listAgentSessions).toHaveBeenCalledWith();
    });
    expect(await screen.findByText("Codex is working")).toBeVisible();
    const activeCard = screen.getByRole("button", {
      name: /Open RUN-1.*details/i,
    });
    const activeCardSurface = activeCard.closest("article") as HTMLElement;
    expect(
      within(activeCardSurface).getByText("Runs a command"),
    ).toBeVisible();
    expect(
      within(activeCardSurface).getByText(
        "Updated the checkout flow and started the focused tests.",
      ),
    ).toBeVisible();
    expect(
      within(activeCardSurface).getByText("VS Code session"),
    ).toBeVisible();
    expect(
      within(activeCardSurface).queryByText(/Updated just now/i),
    ).not.toBeInTheDocument();
    expect(
      within(activeCardSurface).queryByText(/\d+ repos?/i),
    ).not.toBeInTheDocument();
    expect(
      within(activeCardSurface).queryByText(/\d+ worktrees?/i),
    ).not.toBeInTheDocument();
    expect(
      within(activeCardSurface).queryByText("Session finished"),
    ).not.toBeInTheDocument();

    const idleCard = screen.getByRole("button", {
      name: /Open IDLE-1.*details/i,
    });
    const idleCardSurface = idleCard.closest("article") as HTMLElement;
    expect(
      within(idleCardSurface).getByText(
        "Finished the account settings review. All checks passed.",
      ),
    ).toBeVisible();
    expect(
      within(idleCardSurface).getByText("Codex is open in VS Code"),
    ).toBeVisible();
    expect(
      within(idleCardSurface).getByText("Last task finished"),
    ).toBeVisible();
    expect(
      within(idleCardSurface).getByText("VS Code session"),
    ).toBeVisible();
    expect(
      within(idleCardSurface).queryByText(/private\/workspace/),
    ).not.toBeInTheDocument();

    const board = screen.getByLabelText("Local workspace board");
    expect(within(board).getByRole("heading", { name: "Active" })).toBeVisible();
    expect(within(board).getByRole("heading", { name: "Review" })).toBeVisible();
    expect(within(board).getByRole("heading", { name: "Ready" })).toBeVisible();
    expect(screen.queryByText("1 workspace needs review")).not.toBeInTheDocument();
    expect(fake.listAgentSessions).toHaveBeenCalledTimes(1);

    const boardPath = globalThis.location.pathname;
    fireEvent.click(activeCard, { metaKey: true });

    expect(fake.openWorkspaceInVscode).toHaveBeenCalledWith(active.workspaceId);
    expect(globalThis.location.pathname).toBe(boardPath);
    expect(
      screen.getByRole("heading", { name: "Spaces" }),
    ).toBeVisible();

    await user.click(activeCard);

    expect(globalThis.location.pathname).toBe(`/sessions/${active.workspaceId}`);
    expect(
      screen.getByRole("button", { name: "Update the checkout flow" }),
    ).toBeVisible();
  });

  it("orders automatic workspace cards by their latest agent ping", async () => {
    const now = Date.now();
    const oldPing = workspaceFixture({
      workspaceId: "ws_old_ping",
      intent: { type: "repositorySet", label: "Old ping" },
      title: "Older agent activity",
      workflow: {
        state: "active",
        revision: 2,
        updatedAtUnixMs: now,
        placement: { mode: "automatic", rank: 0 },
      },
    });
    const recentPing = workspaceFixture({
      workspaceId: "ws_recent_ping",
      intent: { type: "repositorySet", label: "Recent ping" },
      title: "Latest agent activity",
      workflow: {
        state: "active",
        revision: 2,
        updatedAtUnixMs: now - 60_000,
        placement: { mode: "automatic", rank: 1 },
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([oldPing, recentPing]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [
          {
            schemaVersion: 1,
            sessionId: "11111111-1111-4111-8111-111111111111",
            workspaceId: oldPing.workspaceId,
            provider: "codex",
            terminal: "terminal",
            category: "implementation",
            status: "running",
            startedAtUnixMs: now - 120_000,
            lastHeartbeatAtUnixMs: now - 30_000,
            endedAtUnixMs: null,
            failure: null,
          },
          {
            schemaVersion: 1,
            sessionId: "22222222-2222-4222-8222-222222222222",
            workspaceId: recentPing.workspaceId,
            provider: "codex",
            terminal: "terminal",
            category: "implementation",
            status: "running",
            startedAtUnixMs: now - 120_000,
            lastHeartbeatAtUnixMs: now - 1_000,
            endedAtUnixMs: null,
            failure: null,
          },
        ],
      },
    });

    render(<LocalWorkspace client={fake.client} />);

    const activeLane = await screen.findByRole("region", { name: "Active" });
    await waitFor(() => {
      expect(
        [...activeLane.querySelectorAll("[data-workspace-id]")].map(
          (card) => card.getAttribute("data-workspace-id"),
        ),
      ).toEqual([recentPing.workspaceId, oldPing.workspaceId]);
    });
  });

  it("keeps the workspace toolbar focused on actions", async () => {
    const workspace = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([workspace]),
    });

    render(<LocalWorkspace client={fake.client} />);

    const toolbar = (await screen.findByText("My time")).closest(
      '[data-ui="spaces.toolbar"]',
    );
    expect(toolbar).toContainElement(
      screen.getByRole("button", { name: /New workspace/i }),
    );
    expect(
      screen.queryByRole("note", { name: /Workspace summary/i }),
    ).not.toBeInTheDocument();
  });

  it("moves an agent question to Review and sends one safe notification", async () => {
    localStorage.clear();
    saveTimeReviewSchedule({
      schemaVersion: 1,
      enabled: true,
      intervalHours: 4,
      startedAtUnixMs: Date.now(),
      lastSuccessfulAtUnixMs: null,
      notificationsEnabled: true,
    });
    const notifications: Array<{ title: string; body?: string }> = [];
    class TestNotification {
      static permission = "granted" as NotificationPermission;
      static async requestPermission() {
        return TestNotification.permission;
      }
      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, body: options?.body });
      }
      close() {}
    }
    vi.stubGlobal("Notification", TestNotification);
    const workspace = workspaceFixture({
      workspaceId: "ws-agent-question",
      title: "Confirm the rollout scope",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: Date.now() - 10_000,
      },
    });
    const eventAtUnixMs = Date.now() - 1_000;
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([workspace]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [],
        observedSessions: [
          {
            schemaVersion: 1,
            sessionId: "55555555-5555-4555-8555-555555555555",
            workspaceId: workspace.workspaceId,
            provider: "codex",
            source: "codexVscodeRollout",
            status: "working",
            activity: null,
            needsInput: {
              kind: "question",
              detail: "Agent has a question.",
            },
            startedAtUnixMs: eventAtUnixMs - 20_000,
            lastEventAtUnixMs: eventAtUnixMs,
          },
        ],
      },
    });
    fake.transitionWorkspaceWorkflow.mockResolvedValue({
      state: "review",
      revision: 2,
      updatedAtUnixMs: eventAtUnixMs,
    });

    try {
      render(<LocalWorkspace client={fake.client} />);

      await waitFor(() => {
        const lane = screen.getByRole("heading", { name: "Review" }).closest("section");
        expect(within(lane!).getByText("Codex has a question")).toBeVisible();
      });
      const reviewLane = screen
        .getByRole("heading", { name: "Review" })
        .closest("section");
      expect(reviewLane).not.toBeNull();
      expect(
        within(reviewLane!).getByRole("button", {
          name: /Open PLATFORM-42.*details/i,
        }),
      ).toBeVisible();
      await waitFor(() => {
        expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledWith(
          workspace.workspaceId,
          "review",
          1,
        );
        expect(notifications).toEqual([
          {
            title: "Confirm the rollout scope needs your answer",
            body: "Agent has a question. Open WTS to review it.",
          },
        ]);
      });
    } finally {
      vi.unstubAllGlobals();
      localStorage.clear();
    }
  });

  it("retries an agent notification after the first send fails", async () => {
    vi.useFakeTimers();
    localStorage.clear();
    saveTimeReviewSchedule({
      schemaVersion: 1,
      enabled: false,
      intervalHours: 4,
      startedAtUnixMs: Date.now(),
      lastSuccessfulAtUnixMs: null,
      notificationsEnabled: true,
    });
    let attempts = 0;
    const delivered: string[] = [];
    class TestNotification {
      static permission = "granted" as NotificationPermission;
      static async requestPermission() {
        return TestNotification.permission;
      }
      constructor(title: string) {
        attempts += 1;
        if (attempts === 1) throw new Error("Temporary notification failure");
        delivered.push(title);
      }
      close() {}
    }
    vi.stubGlobal("Notification", TestNotification);
    const workspace = workspaceFixture({
      workspaceId: "ws-agent-notification-retry",
      title: "Retry agent notification",
      workflow: {
        state: "review",
        revision: 2,
        updatedAtUnixMs: Date.now() - 10_000,
      },
    });
    const eventAtUnixMs = Date.now() - 1_000;
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([workspace]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [],
        observedSessions: [
          {
            schemaVersion: 1,
            sessionId: "66666666-6666-4666-8666-666666666666",
            workspaceId: workspace.workspaceId,
            provider: "codex",
            source: "codexVscodeRollout",
            status: "working",
            activity: null,
            needsInput: {
              kind: "access",
              detail: "Agent needs access.",
            },
            startedAtUnixMs: eventAtUnixMs - 20_000,
            lastEventAtUnixMs: eventAtUnixMs,
          },
        ],
      },
    });

    try {
      render(<LocalWorkspace client={fake.client} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(attempts).toBe(1);
      expect(delivered).toEqual([]);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(attempts).toBe(2);
      expect(delivered).toEqual(["Retry agent notification needs access"]);
    } finally {
      vi.unstubAllGlobals();
      localStorage.clear();
      vi.useRealTimers();
    }
  });

  it("renders each persisted lifecycle observation without upgrading its truth", async () => {
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([
        workspaceFixture({
          workspaceId: "ws_attention",
          intent: { type: "jira", issueKey: "STATE-1" },
          lifecycle: {
            materializationState: "needsAttention",
            worktreeCount: 1,
            observedAtUnixMs: 1_721_776_500_000,
          },
        }),
        workspaceFixture({
          workspaceId: "ws_unknown",
          intent: { type: "jira", issueKey: "STATE-2" },
          lifecycle: {
            materializationState: "unknown",
            worktreeCount: 0,
            observedAtUnixMs: null,
          },
        }),
        workspaceFixture({
          workspaceId: "ws_draft",
          intent: { type: "jira", issueKey: "STATE-3" },
        }),
      ]),
    });

    render(<LocalWorkspace client={fake.client} />);

    expect(
      await screen.findByText("Last check found local state to review"),
    ).toBeVisible();
    expect(
      screen.getByText("Local state has not been observed yet"),
    ).toBeVisible();
    expect(
      screen.getByText("Plan saved · worktree setup is waiting"),
    ).toBeVisible();
  });

  it("keeps the complete workflow visible when some stages are empty", async () => {
    const ready = workspaceFixture({
      workspaceId: "ws_ready",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const needsInput = workspaceFixture({
      workspaceId: "ws_needs_input",
      intent: { type: "jira", issueKey: "AUTH-778" },
      title: "Restore authenticated sessions",
      workspaceLeaf: "auth-778-2b71",
      workspaceDisplayPath: "~/cd/auth-778-2b71",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([ready, needsInput]),
    });

    render(<LocalWorkspace client={fake.client} />);

    await screen.findByRole("heading", { name: "Spaces" });
    const board = screen.getByLabelText("Local workspace board");

    expect(screen.queryByText("ON THIS MAC")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Plan issue-scoped work/),
    ).not.toBeInTheDocument();
    expect(within(board).getAllByText("Ready").length).toBeGreaterThan(0);
    expect(within(board).getAllByText("Review").length).toBeGreaterThan(0);
    expect(within(board).getByRole("heading", { name: "Active" })).toBeVisible();
    expect(within(board).getByRole("heading", { name: "Parked" })).toBeVisible();
    expect(
      within(board).getByText("Agent work appears here while it is active."),
    ).toBeVisible();
    expect(within(board).getByText("Move paused workspaces here.")).toBeVisible();
  });

  it("uses horizontal arrow keys to skip empty stages", async () => {
    const user = userEvent.setup();
    const ready = workspaceFixture({
      workspaceId: "ws_arrow_ready",
      intent: { type: "repositorySet", label: "Arrow ready" },
      title: "Ready keyboard target",
    });
    const parked = workspaceFixture({
      workspaceId: "ws_arrow_parked",
      intent: { type: "repositorySet", label: "Arrow parked" },
      title: "Parked keyboard target",
      workflow: {
        state: "parked",
        revision: 2,
        updatedAtUnixMs: 1_721_776_500_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([ready, parked]),
    });

    render(<LocalWorkspace client={fake.client} />);

    const readyCard = await screen.findByRole("button", {
      name: "Open Arrow ready: Ready keyboard target details",
    });
    const parkedCard = screen.getByRole("button", {
      name: "Open Arrow parked: Parked keyboard target details",
    });

    readyCard.focus();
    await user.keyboard("{ArrowRight}");
    expect(parkedCard).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(readyCard).toHaveFocus();
  });

  it("moves a workspace with the accessible action menu", async () => {
    localStorage.removeItem("wts.workspace-lanes.v1");
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      workspaceId: "ws_move_menu",
      intent: { type: "repositorySet", label: "Move menu" },
      title: "Move by keyboard",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    fake.placeWorkspaceOnBoard.mockResolvedValue({
      state: "parked",
      revision: 2,
      updatedAtUnixMs: 1_721_776_500_000,
      placement: { mode: "pinned", rank: 0 },
    });

    render(<LocalWorkspace client={fake.client} />);

    await user.click(
      await screen.findByRole("button", { name: "Move Move menu" }),
    );
    const parkedAction = await screen.findByRole("menuitem", {
      name: "Move to Parked",
    });
    parkedAction.focus();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(fake.placeWorkspaceOnBoard).toHaveBeenCalledWith(
        "ws_move_menu",
        {
          state: "parked",
          expectedRevision: 1,
        },
      ),
    );

    const parkedLane = await screen.findByRole("region", { name: "Parked" });
    expect(
      await within(parkedLane).findByRole("button", {
        name: "Open Move menu: Move by keyboard details",
      }),
    ).toBeVisible();
    expect(localStorage.getItem("wts.workspace-lanes.v1")).toBeNull();
    expect(screen.getByText("Move menu moved to Parked.")).toBeVisible();
    localStorage.removeItem("wts.workspace-lanes.v1");
  });

  it("persists completed agent work in Review", async () => {
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
    const persisted = workspaceFixture({
      workspaceId: "ws_completed_review",
      intent: { type: "repositorySet", label: "Completed agent" },
      title: "Review completed work",
      workflow: {
        state: "active",
        revision: 4,
        updatedAtUnixMs: 1_721_776_400_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [
          {
            schemaVersion: 1,
            sessionId: "session-completed-review",
            workspaceId: persisted.workspaceId,
            provider: "codex",
            terminal: "terminal",
            category: "implementation",
            status: "completed",
            startedAtUnixMs: 1_721_776_400_000,
            lastHeartbeatAtUnixMs: 1_721_776_500_000,
            endedAtUnixMs: 1_721_776_500_000,
            failure: null,
          },
        ],
      },
    });
    fake.transitionWorkspaceWorkflow.mockResolvedValue({
      state: "review",
      revision: 5,
      updatedAtUnixMs: 1_721_776_500_000,
    });

    render(<LocalWorkspace client={fake.client} />);

    await waitFor(() =>
      expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledWith(
        "ws_completed_review",
        "review",
        4,
      ),
    );
    const reviewLane = screen.getByRole("region", { name: "Review" });
    expect(
      await within(reviewLane).findByRole("button", {
        name: "Open Completed agent: Review completed work details",
      }),
    ).toBeVisible();
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
  });

  it("retries an automatic workflow transition after a transient failure", async () => {
    vi.useFakeTimers();
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
    try {
      const persisted = workspaceFixture({
        workspaceId: "ws_retry_review",
        intent: { type: "repositorySet", label: "Retry review" },
        title: "Retry the review transition",
        workflow: {
          state: "active",
          revision: 3,
          updatedAtUnixMs: 1_721_776_400_000,
        },
      });
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture([persisted]),
        agentSessions: {
          schemaVersion: 1,
          sessions: [
            {
              schemaVersion: 1,
              sessionId: "session-retry-review",
              workspaceId: persisted.workspaceId,
              provider: "codex",
              terminal: "terminal",
              category: "implementation",
              status: "completed",
              startedAtUnixMs: 1_721_776_400_000,
              lastHeartbeatAtUnixMs: 1_721_776_500_000,
              endedAtUnixMs: 1_721_776_500_000,
              failure: null,
            },
          ],
        },
      });
      fake.transitionWorkspaceWorkflow
        .mockRejectedValueOnce(new Error("Temporary workflow conflict"))
        .mockResolvedValueOnce({
          state: "review",
          revision: 4,
          updatedAtUnixMs: 1_721_776_500_000,
        });

      render(<LocalWorkspace client={fake.client} />);
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledTimes(2);
      expect(fake.transitionWorkspaceWorkflow).toHaveBeenLastCalledWith(
        persisted.workspaceId,
        "review",
        3,
      );
      const reviewLane = screen.getByRole("region", { name: "Review" });
      expect(
        within(reviewLane).getByRole("button", {
          name: "Open Retry review: Retry the review transition details",
        }),
      ).toBeVisible();
    } finally {
      localStorage.removeItem("wts.workspace-workflow-signals.v1");
      vi.useRealTimers();
    }
  });

  it("keeps a Parked workspace parked when an agent is observed", async () => {
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
    const now = Date.now();
    const persisted = workspaceFixture({
      workspaceId: "ws_parked_agent",
      intent: { type: "repositorySet", label: "Parked agent" },
      title: "Keep this workspace parked",
      workflow: {
        state: "parked",
        revision: 3,
        updatedAtUnixMs: now,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [
          {
            schemaVersion: 1,
            sessionId: "session-parked-agent",
            workspaceId: persisted.workspaceId,
            provider: "codex",
            terminal: "terminal",
            category: "implementation",
            status: "running",
            startedAtUnixMs: now - 1_000,
            lastHeartbeatAtUnixMs: now,
            endedAtUnixMs: null,
            failure: null,
          },
        ],
      },
    });

    render(<LocalWorkspace client={fake.client} />);

    const parkedLane = await screen.findByRole("region", { name: "Parked" });
    expect(
      await within(parkedLane).findByRole("button", {
        name: "Open Parked agent: Keep this workspace parked details",
      }),
    ).toBeVisible();
    expect(fake.transitionWorkspaceWorkflow).not.toHaveBeenCalled();
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
  });

  it("keeps the durable lane visible until an agent transition succeeds", async () => {
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
    const now = Date.now();
    const workspace = workspaceFixture({
      workspaceId: "ws-durable-lane",
      intent: { type: "repositorySet", label: "Durable lane" },
      title: "Keep the saved lane visible",
      workflow: {
        state: "ready",
        revision: 4,
        updatedAtUnixMs: now - 10_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([workspace]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [],
        observedSessions: [
          {
            schemaVersion: 1,
            sessionId: "77777777-7777-4777-8777-777777777777",
            workspaceId: workspace.workspaceId,
            provider: "codex",
            source: "codexVscodeRollout",
            status: "working",
            activity: "editing",
            startedAtUnixMs: now - 20_000,
            lastEventAtUnixMs: now,
          },
        ],
      },
    });
    fake.transitionWorkspaceWorkflow.mockImplementation(
      () => new Promise(() => undefined),
    );

    render(<LocalWorkspace client={fake.client} />);

    const ready = await screen.findByRole("region", { name: "Ready" });
    const active = screen.getByRole("region", { name: "Active" });
    expect(
      within(ready).getByRole("button", {
        name: "Open Durable lane: Keep the saved lane visible details",
      }),
    ).toBeVisible();
    expect(
      within(active).queryByRole("button", {
        name: "Open Durable lane: Keep the saved lane visible details",
      }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledWith(
        workspace.workspaceId,
        "active",
        4,
      ),
    );
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
  });

  it("unpins a workspace and applies its current agent activity immediately", async () => {
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
    const user = userEvent.setup();
    const now = Date.now();
    const workspace = workspaceFixture({
      workspaceId: "ws-follow-agent",
      intent: { type: "repositorySet", label: "Pinned work" },
      title: "Follow active agent work",
      workflow: {
        state: "parked",
        revision: 6,
        updatedAtUnixMs: now - 10_000,
        placement: { mode: "pinned", rank: 0 },
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([workspace]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [],
        observedSessions: [
          {
            schemaVersion: 1,
            sessionId: "88888888-8888-4888-8888-888888888888",
            workspaceId: workspace.workspaceId,
            provider: "codex",
            source: "codexVscodeRollout",
            status: "working",
            activity: "editing",
            startedAtUnixMs: now - 20_000,
            lastEventAtUnixMs: now,
          },
        ],
      },
    });
    fake.followWorkspaceAgent.mockResolvedValue({
      state: "parked",
      revision: 7,
      updatedAtUnixMs: now,
      placement: { mode: "automatic", rank: 0 },
    });
    fake.transitionWorkspaceWorkflow.mockResolvedValue({
      state: "active",
      revision: 8,
      updatedAtUnixMs: now + 1,
      placement: { mode: "automatic", rank: 0 },
    });

    render(<LocalWorkspace client={fake.client} />);

    expect(await screen.findByText("Codex is working")).toBeVisible();
    expect(fake.transitionWorkspaceWorkflow).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Move Pinned work" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Follow agent activity" }),
    );

    await waitFor(() => {
      expect(fake.followWorkspaceAgent).toHaveBeenCalledWith(
        workspace.workspaceId,
        6,
      );
      expect(fake.transitionWorkspaceWorkflow).toHaveBeenCalledWith(
        workspace.workspaceId,
        "active",
        7,
      );
    });
    expect(
      fake.followWorkspaceAgent.mock.invocationCallOrder[0],
    ).toBeLessThan(fake.transitionWorkspaceWorkflow.mock.invocationCallOrder[0]!);
    const active = screen.getByRole("region", { name: "Active" });
    expect(
      within(active).getByRole("button", {
        name: "Open Pinned work: Follow active agent work details",
      }),
    ).toBeVisible();
    expect(screen.getByText("Pinned work now follows agent activity.")).toBeVisible();
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
  });

  it("runs trusted verification after recent agent work completes", async () => {
    const completedAtUnixMs = Date.now();
    localStorage.setItem(
      "wts.workspace-automation.v1",
      JSON.stringify({
        schemaVersion: 1,
        automaticVerification: true,
        automaticAgentReview: false,
        quietPeriodSeconds: 0,
      }),
    );
    localStorage.removeItem("wts.workspace-automation-events.v1");
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
    const persisted = workspaceFixture({
      workspaceId: "ws_automatic_verification",
      intent: { type: "repositorySet", label: "Automatic verification" },
      title: "Verify completed agent work",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 2,
        observedAtUnixMs: completedAtUnixMs,
      },
      workflow: {
        state: "review",
        revision: 5,
        updatedAtUnixMs: completedAtUnixMs,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [
          {
            schemaVersion: 1,
            sessionId: "session-automatic-verification",
            workspaceId: persisted.workspaceId,
            provider: "codex",
            terminal: "terminal",
            category: "implementation",
            status: "completed",
            startedAtUnixMs: completedAtUnixMs - 60_000,
            lastHeartbeatAtUnixMs: completedAtUnixMs,
            endedAtUnixMs: completedAtUnixMs,
            failure: null,
          },
        ],
      },
      verificationRun: workspaceEvidenceFixture(),
    });

    render(
      <LocalWorkspace
        client={fake.client}
        initialWorkspaceId={persisted.workspaceId}
      />,
    );

    await waitFor(() =>
      expect(fake.runWorkspaceVerification).toHaveBeenCalledWith(
        persisted.workspaceId,
      ),
    );
    expect(fake.runWorkspaceVerification).toHaveBeenCalledTimes(1);
    expect(fake.runWorkspaceAgent).not.toHaveBeenCalled();

    localStorage.removeItem("wts.workspace-automation.v1");
    localStorage.removeItem("wts.workspace-automation-events.v1");
    localStorage.removeItem("wts.workspace-workflow-signals.v1");
  });

  it("expands the compact space search and keeps an active query visible", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([workspaceFixture()]),
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "Spaces" });

    expect(
      screen.getByPlaceholderText("Search workspaces, issues, or repositories"),
    ).toHaveAttribute("aria-hidden", "true");

    expect(screen.getByRole("button", { name: "Search spaces" })).toHaveProperty(
      "tabIndex",
      0,
    );
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = screen.getByPlaceholderText(
      "Search workspaces, issues, or repositories",
    );
    await waitFor(() => expect(input).toHaveFocus());

    await user.type(input, "PLATFORM-42");
    await user.tab();
    expect(input).toHaveValue("PLATFORM-42");
    expect(input).not.toHaveAttribute("aria-hidden", "true");

    await user.click(screen.getByRole("button", { name: "Clear search" }));
    input.focus();
    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByRole("button", { name: "Search spaces" })).toHaveFocus();
  });

  it("opens a concise usage guide and starts the creation flow from it", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });

    await user.click(
      screen.getByRole("button", { name: "Open How to use WTS" }),
    );
    const guide = screen.getByRole("dialog", { name: "How to use WTS" });
    expect(guide).toBeVisible();
    expect(within(guide).getByText("The working loop")).toBeVisible();
    expect(within(guide).getByText("Retries are safe")).toBeVisible();
    expect(
      within(guide).getByText(/After a restart, WTS reloads the manifest/i),
    ).toBeVisible();

    await user.click(
      within(guide).getByRole("button", { name: "New workspace" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "How to use WTS" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeVisible();
  });
});
