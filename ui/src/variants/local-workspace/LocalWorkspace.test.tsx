import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  CodeWorkspaceFileImportResult,
  CreateWorkspaceResult,
  GitlabMergeRequestInbox,
  JiraIssueImport,
  OpenProjectWorkPackageImport,
  RemoveWorkspaceResult,
  RepositoryCatalog,
  RuntimeAnalysisResult,
  WorkspaceAgentEvidence,
  WorkspaceCliLaunchResult,
  WorkspaceEvidence,
  WorkspaceIntent,
  WorkspaceMaterialization,
  WorkspacePreflight,
  WorkspaceRepositorySyncResult,
} from "../../lib/wtsClient";
import { WorkspaceClientError } from "../../lib/wtsClient";
import {
  fakeWorkspaceClient,
  repositoryCatalogFixture,
  runtimeAnalysisFixture,
  setupFixture,
  workspaceEvidenceFixture,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import {
  LocalWorkspace,
  repositoryUpstreamsFromIssueContent,
  resolveWorkspaceDropTarget,
  suggestedJiraIssueKeyForReview,
} from "./LocalWorkspace";
import { loadActivityWatchReviewSnapshot } from "./activityWatchReviewCache";
import { saveTimeReviewSchedule } from "./timeReviewSchedule";

async function selectWorkspaceView(
  user: ReturnType<typeof userEvent.setup>,
  name: "Plans & Kanban" | "Changes" | "Verification",
) {
  const label =
    name === "Plans & Kanban"
      ? "Plans"
      : name === "Verification"
        ? "Verify"
        : name;
  await user.click(screen.getByRole("tab", { name: label }));
}

async function selectWorkspaceAction(
  user: ReturnType<typeof userEvent.setup>,
  name: "Open workspace" | "Open with…",
) {
  await user.click(
    await screen.findByRole("button", { name: "Workspace actions" }),
  );
  await user.click(screen.getByRole("menuitem", { name }));
}

describe("Jira repository upstream discovery", () => {
  it("extracts cloneable Git URLs without retaining credential-bearing URLs", () => {
    expect(
      repositoryUpstreamsFromIssueContent(`
        {"repository":"https://github.com/acme/jellyfish.git"}
        Mirror: git@gitlab.example.com:platform/senzu.git.
        Jira issue: https://jira.example.test/browse/PLATFORM-42
        Ignore: https://token@example.com/acme/private.git
      `),
    ).toEqual([
      {
        label: "jellyfish",
        remoteUrl: "https://github.com/acme/jellyfish.git",
      },
      {
        label: "senzu",
        remoteUrl: "git@gitlab.example.com:platform/senzu.git",
      },
    ]);
  });

});

describe("review Jira issue discovery", () => {
  it("returns one exact uppercase Jira key from merge request metadata", () => {
    expect(suggestedJiraIssueKeyForReview({
      title: "[PLATFORM-7197] Fix checkout retries",
      sourceBranch: "feat/PLATFORM-7197-checkout-retries",
    })).toBe("PLATFORM-7197");
  });

  it("does not guess when metadata is ambiguous or malformed", () => {
    expect(suggestedJiraIssueKeyForReview({
      title: "PLATFORM-7197 Fix checkout retries",
      sourceBranch: "feat/PAYMENTS-42-checkout-retries",
    })).toBeUndefined();
    expect(suggestedJiraIssueKeyForReview({
      title: "platform-7197 Fix checkout retries",
      sourceBranch: "feat/health-endpoint-fallback",
    })).toBeUndefined();
  });
});

describe("workspace board drop targets", () => {
  it("maps lane, archive, and delete drops to durable board actions", () => {
    expect(resolveWorkspaceDropTarget("lane:attention")).toEqual({
      type: "move",
      lane: "attention",
    });
    expect(resolveWorkspaceDropTarget("action:archive")).toEqual({
      type: "move",
      lane: "suspended",
    });
    expect(resolveWorkspaceDropTarget("action:delete")).toEqual({ type: "delete" });
    expect(resolveWorkspaceDropTarget("workspace:unknown")).toBeNull();
  });
});

describe("workspace creation keyboard navigation", () => {
  it("moves through the source grid and issue providers with arrow keys", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({ list: workspaceListFixture() });
    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await user.click(screen.getAllByRole("button", { name: /New workspace/i })[0]!);
    const dialog = screen.getByRole("dialog", { name: "New workspace" });

    const issue = within(dialog).getByRole("radio", { name: /^Issue/i });
    issue.focus();
    await user.keyboard("{ArrowDown}");
    const repositories = within(dialog).getByRole("radio", {
      name: /^Repositories/i,
    });
    expect(repositories).toHaveFocus();
    expect(repositories).toBeChecked();

    await user.keyboard("{ArrowRight}");
    const codeWorkspace = within(dialog).getByRole("radio", {
      name: /^VS Code workspace file/i,
    });
    expect(codeWorkspace).toHaveFocus();
    expect(codeWorkspace).toBeChecked();

    await user.keyboard("{ArrowUp}");
    const savedPlan = within(dialog).getByRole("radio", {
      name: /^Saved WTS plan/i,
    });
    expect(savedPlan).toHaveFocus();
    expect(savedPlan).toBeChecked();

    await user.keyboard("{Home}");
    expect(issue).toBeChecked();
    const jira = within(dialog).getByRole("radio", { name: "Jira" });
    jira.focus();
    await user.keyboard("{ArrowRight}");
    const openProject = within(dialog).getByRole("radio", {
      name: "OpenProject",
    });
    expect(openProject).toHaveFocus();
    expect(openProject).toHaveAttribute("aria-checked", "true");
    expect(
      within(dialog).getByRole("textbox", {
        name: "OpenProject work package",
      }),
    ).toBeVisible();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function assistantMaterialization(
  workspace: ReturnType<typeof workspaceFixture>,
  graphStatus: WorkspaceMaterialization["graph"]["status"] = "ready",
): WorkspaceMaterialization {
  const repository = workspace.repositories[0]!;
  return {
    schemaVersion: 1,
    workspaceId: workspace.workspaceId,
    workspaceRecordVersion: workspace.recordVersion,
    effectDigest: `sha256:${workspace.workspaceId}`,
    workspaceDisplayPath: workspace.workspaceDisplayPath,
    codeWorkspaceDisplayPath: `${workspace.workspaceDisplayPath}/wts.code-workspace`,
    branchName: `wts/${workspace.workspaceId}`,
    worktrees: [
      {
        repositoryId: repository.repositoryId ?? repository.requestId,
        label: repository.label,
        targetDisplayPath: `${workspace.workspaceDisplayPath}/${repository.worktreeLeaf}`,
        branchName: `wts/${workspace.workspaceId}`,
        baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
      },
    ],
    graph: {
      status: graphStatus,
      detail:
        graphStatus === "ready"
          ? "Workspace graph is ready."
          : "Workspace graph has not been built.",
    },
  };
}

function assistantEvidence(
  workspace: ReturnType<typeof workspaceFixture>,
  agentRuns: WorkspaceAgentEvidence[],
): WorkspaceEvidence {
  const evidence = workspaceEvidenceFixture();
  return {
    ...evidence,
    context: {
      ...evidence.context,
      workspaceId: workspace.workspaceId,
      title: workspace.title,
      workspaceDisplayPath: workspace.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${workspace.workspaceDisplayPath}/wts.code-workspace`,
      evidenceDisplayPath: `${workspace.workspaceDisplayPath}/.wts`,
    },
    graphManifest: {
      ...evidence.graphManifest,
      workspaceId: workspace.workspaceId,
      graphDisplayPath: `${workspace.workspaceDisplayPath}/graphify-out/graph.json`,
    },
    verificationPlan: {
      ...evidence.verificationPlan,
      workspaceId: workspace.workspaceId,
    },
    verificationResult: {
      ...evidence.verificationResult,
      workspaceId: workspace.workspaceId,
    },
    agentRuns,
  };
}

async function reachJiraManifest(
  user: ReturnType<typeof userEvent.setup>,
  issueKey: string,
  repositories: string,
) {
  await user.click(
    screen.getAllByRole("button", { name: /New workspace/i })[0]!,
  );
  const dialog = screen.getByRole("dialog", { name: "New workspace" });

  await user.type(
    within(dialog).getByRole("textbox", {
      name: /Jira issue key or URL/i,
    }),
    issueKey,
  );
  await user.type(
    within(dialog).getByRole("textbox", {
      name: "Repositories for this plan",
    }),
    repositories,
  );
  await user.click(
    within(dialog).getByRole("button", {
      name: /Review repositories/i,
    }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: /Analyze services/i }),
  );
  await waitFor(() => {
    expect(
      within(dialog).queryByRole("button", { name: /Review plan/i }) ??
        within(dialog).queryByRole("button", {
          name: "Continue without services",
        }),
    ).not.toBeNull();
  });
  const continueWithoutServices = within(dialog).queryByRole("button", {
    name: "Continue without services",
  });
  await user.click(
    continueWithoutServices ??
      within(dialog).getByRole("button", { name: /Review plan/i }),
  );

  return dialog;
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
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(5_000);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(3);
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
      name: /Open flow-review/i,
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
      name: /Open flow-review/i,
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
      await screen.findByRole("button", { name: /Open .*Ready workspace/i }),
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
      await screen.findByRole("button", { name: /Open flow-review/i }),
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
      name: /Open PLATFORM-42: Checkout retries create duplicate captures/i,
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
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await selectWorkspaceView(user, "Plans & Kanban");
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
        name: /Open PLATFORM-42: Checkout retries create duplicate captures/i,
      }),
    );

    await user.click(
      screen.getByRole("button", { name: "Copy workspace path" }),
    );
    expect(writeText).toHaveBeenCalledWith(persisted.workspaceDisplayPath);
    expect(
      screen.getAllByRole("status").every(
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
        name: /Open PLATFORM-42: Checkout retries create duplicate captures/i,
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
      name: /Open PLATFORM-42:/i,
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
    fake.getGitlabReviewPatch.mockResolvedValue({
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
    });

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
    expect(await screen.findByText("acme/checkout-api changes")).toBeVisible();
    expect(fake.getGitlabReviewPatch).toHaveBeenCalledWith("repo_checkout", 17);
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
    fake.getGitlabReviewPatch.mockResolvedValue({
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
    });

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
    expect(await screen.findByText("sre-tools/obx-api changes")).toBeVisible();
    expect(fake.getGitlabReviewPatch).toHaveBeenCalledWith("repo_obx_api", 9);
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

      expect(await screen.findByText("Codex has a question")).toBeVisible();
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

  it("reviews exact Git effects, materializes, and explicitly opens VS Code", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      preferredProvider: "vsCode",
      repositories: [
        {
          requestId: "repo_checkout",
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
    });
    const preflight = {
      workspaceId: persisted.workspaceId,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${persisted.workspaceDisplayPath}/wts.code-workspace`,
      branchName: "wts/platform-42-7fd1cafe",
      ready: true,
      effectDigest: "sha256:effect",
      repositories: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          sourceDisplayPath: "~/cd/checkout-api",
          requestedBaseRef: "main",
          resolvedBaseRef: "refs/heads/main",
          baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
          targetDisplayPath: `${persisted.workspaceDisplayPath}/checkout-api--012345`,
        },
      ],
      blockers: [],
      warnings: [],
      graph: { status: "notStarted" as const, detail: "Not started." },
    };
    const materialization = {
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      workspaceRecordVersion: 1,
      effectDigest: preflight.effectDigest,
      workspaceDisplayPath: preflight.workspaceDisplayPath,
      codeWorkspaceDisplayPath: preflight.codeWorkspaceDisplayPath,
      branchName: preflight.branchName,
      worktrees: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          targetDisplayPath: preflight.repositories[0]!.targetDisplayPath,
          branchName: preflight.branchName,
          baseCommitOid: preflight.repositories[0]!.baseCommitOid,
        },
      ],
      graph: preflight.graph,
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      preflight,
      materialize: { replayed: false, materialization },
      open: {
        provider: "vsCode",
        accepted: true,
        workspaceId: persisted.workspaceId,
        codeWorkspaceDisplayPath: preflight.codeWorkspaceDisplayPath,
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", {
        name: /Open PLATFORM-42:/i,
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review setup" }),
    );

    expect(
      await screen.findByRole("table", {
        name: "Workspace creation effects",
      }),
    ).toBeVisible();
    expect(screen.getByText(/01234567/)).toBeVisible();
    expect(fake.preflightWorkspace).toHaveBeenCalledWith(persisted.workspaceId);

    await user.click(
      screen.getAllByRole("button", { name: "Create workspace" })[0]!,
    );
    const workspaceFacts = await screen.findByRole("region", {
      name: "Workspace facts",
    });
    expect(within(workspaceFacts).getByText("Repositories")).toBeVisible();
    expect(within(workspaceFacts).getByText("1 resolved")).toBeVisible();
    expect(within(workspaceFacts).getByText("Worktrees")).toBeVisible();
    expect(within(workspaceFacts).getByText("1 created")).toBeVisible();
    expect(within(workspaceFacts).getByText("Graph")).toBeVisible();
    expect(within(workspaceFacts).getByText("Not indexed")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Managed worktrees" }),
    ).toBeVisible();
    expect(
      screen.getByRole("table", { name: "Managed worktrees" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy workspace path" }),
    ).toBeVisible();
    expect(screen.queryByText("Workspace ready")).not.toBeInTheDocument();
    expect(screen.getByText("Ready", { exact: true })).toBeVisible();
    expect(screen.queryByText("LOCAL WORKSPACE READY")).not.toBeInTheDocument();
    expect(screen.queryByText(/created safely/i)).not.toBeInTheDocument();
    expect(screen.queryByText("LOCAL STATUS")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Repository requests" }),
    ).not.toBeInTheDocument();
    expect(fake.materializeWorkspace).toHaveBeenCalledWith(
      persisted.workspaceId,
      preflight.effectDigest,
      expect.any(String),
    );

    await selectWorkspaceAction(user, "Open with…");
    const launcher = await screen.findByRole("dialog", {
      name: "Open workspace",
    });
    await user.click(
      within(launcher).getByRole("button", {
        name: "Open workspace in VS Code",
      }),
    );
    expect(fake.openWorkspaceInVscode).toHaveBeenCalledWith(
      persisted.workspaceId,
    );
  });

  it("refreshes a missing base and opens a revised plan on an existing branch", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_checkout",
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "develop",
          worktreeLeaf: "checkout-api",
        },
      ],
    });
    const catalog = repositoryCatalogFixture();
    const checkout = {
      ...catalog.repositories[0]!,
      originUrl: "https://github.com/example/checkout-api.git",
      availableBranches: [
        {
          name: "main",
          fullRef: "refs/remotes/origin/main",
          commitOid: "0123456789abcdef0123456789abcdef01234567",
          remote: true,
        },
      ],
    };
    const refreshedCheckout = {
      ...checkout,
      availableBranches: [
        ...checkout.availableBranches,
        {
          name: "dev-local",
          fullRef: "refs/remotes/origin/dev-local",
          commitOid: "1123456789abcdef0123456789abcdef01234567",
          remote: true,
        },
      ],
    };
    const blocked: WorkspacePreflight = {
      workspaceId: persisted.workspaceId,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${persisted.workspaceDisplayPath}/wts.code-workspace`,
      branchName: "wts/platform-42-7fd1cafe",
      ready: false,
      effectDigest: "",
      repositories: [],
      blockers: [
        {
          code: "baseReferenceUnavailable",
          message: "Base `develop` does not exist in the currently known refs.",
          repositoryLabel: "checkout-api",
          repositoryId: "repo_checkout",
          requestedBaseRef: "develop",
        },
      ],
      warnings: [],
      graph: { status: "notStarted", detail: "Not started." },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      repositories: {
        ...catalog,
        repositories: [checkout],
      },
      repositoryRefresh: refreshedCheckout,
      preflight: blocked,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Open PLATFORM-42: Checkout retries create duplicate captures details",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review setup" }),
    );

    const replacement = await screen.findByRole("combobox", {
      name: "Replacement base for checkout-api",
    });
    expect(replacement).toHaveValue("main");
    await user.click(screen.getByRole("button", { name: "Refresh branches" }));
    await waitFor(() =>
      expect(fake.refreshRepositoryBranches).toHaveBeenCalledWith(
        "repo_checkout",
      ),
    );
    fireEvent.change(replacement, { target: { value: "dev-local" } });
    await user.click(screen.getByRole("button", { name: "Revise saved plan" }));

    const dialog = await screen.findByRole("dialog", {
      name: "Revise PLATFORM-42",
    });
    expect(
      within(dialog).getByRole("combobox", {
        name: "Base branch for checkout-api [repo_checkout]",
      }),
    ).toHaveValue("dev-local");
    expect(
      within(dialog).getAllByText("Original retained").length,
    ).toBeGreaterThan(0);
  });

  it("resolves an existing workspace branch by opening a safe revised plan", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const blocked: WorkspacePreflight = {
      workspaceId: persisted.workspaceId,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${persisted.workspaceDisplayPath}/wts.code-workspace`,
      branchName: "wts/platform-42-7fd1cafe",
      ready: false,
      effectDigest: "",
      repositories: [],
      blockers: [
        {
          code: "branchConflict",
          message:
            "The workspace branch already exists locally. WTS will not overwrite or delete it; create a revised plan to use a new branch.",
        },
      ],
      warnings: [],
      graph: { status: "notStarted", detail: "Not started." },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      preflight: blocked,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Open PLATFORM-42: Checkout retries create duplicate captures details",
      }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review setup" }),
    );

    expect(
      await screen.findByText(
        "The workspace branch already exists locally. WTS will not overwrite or delete it; create a revised plan to use a new branch.",
      ),
    ).toBeVisible();
    expect(screen.getByText("wts/platform-42-7fd1cafe")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Create with a new branch" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Revise PLATFORM-42",
    });
    expect(
      within(dialog).getByRole("textbox", { name: "New plan title" }),
    ).toHaveValue("Checkout retries create duplicate captures · revised");
    expect(within(dialog).getAllByText("checkout-api").length).toBeGreaterThan(
      0,
    );
    expect(within(dialog).getAllByText("Base main").length).toBeGreaterThan(0);
    expect(
      within(dialog).getAllByText("Original retained").length,
    ).toBeGreaterThan(0);
  });

  it("shows only usable manual commands for a saved plan", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await screen.findByRole("heading", { name: "Repository requests" });

    expect(
      screen.queryByRole("button", { name: /VS Code pending/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy workspace path" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    expect(
      screen.getByRole("menuitem", { name: "Refresh status" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Create revised workspace…" }),
    ).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Remove workspace…" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Open in VS Code" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /workspace graph/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Park · lifecycle adapter pending/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Terminal · adapter pending/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Finder · path not created/i),
    ).not.toBeInTheDocument();
  });

  it("releases command busy state when a pending refresh is superseded by another workspace", async () => {
    const user = userEvent.setup();
    const first = workspaceFixture({
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
    const second = workspaceFixture({
      workspaceId: "ws_02_SECOND",
      intent: { type: "jira", issueKey: "AUTH-778" },
      title: "Restore authenticated sessions",
      workspaceLeaf: "auth-778-2b71",
      workspaceDisplayPath: "~/cd/auth-778-2b71",
    });
    const materialization: WorkspaceMaterialization = {
      schemaVersion: 1,
      workspaceId: first.workspaceId,
      workspaceRecordVersion: 1,
      effectDigest: "sha256:materialized",
      workspaceDisplayPath: first.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${first.workspaceDisplayPath}/wts.code-workspace`,
      branchName: "wts/platform-42-7fd1cafe",
      worktrees: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          targetDisplayPath: `${first.workspaceDisplayPath}/checkout-api`,
          branchName: "wts/platform-42-7fd1cafe",
          baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
        },
      ],
      graph: {
        status: "notStarted",
        detail: "Workspace graph has not been built.",
      },
    };
    let resolveRefresh!: (value: WorkspaceMaterialization | null) => void;
    const pendingRefresh = new Promise<WorkspaceMaterialization | null>(
      (resolve) => {
        resolveRefresh = resolve;
      },
    );
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([first, second]),
      get: first,
    });
    fake.getWorkspaceMaterialization
      .mockResolvedValueOnce(materialization)
      .mockReturnValueOnce(pendingRefresh)
      .mockResolvedValueOnce(null);

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await screen.findByRole("button", { name: "Workspace actions" });

    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Refresh status" }));
    expect(
      await screen.findByRole("button", {
        name: "Workspace actions, command in progress",
      }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      screen.queryByRole("button", { name: "Open Codex in Terminal" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Spaces/ }));
    await user.click(screen.getByRole("button", { name: /Open AUTH-778/i }));
    expect(
      await screen.findByRole("button", { name: "Workspace actions" }),
    ).toHaveAttribute("aria-busy", "false");

    await act(async () => {
      resolveRefresh(materialization);
      await pendingRefresh;
    });
    expect(
      screen.getByRole("button", { name: "Workspace actions" }),
    ).toHaveAttribute("aria-busy", "false");
  });

  it.each([
    {
      label: "Jira",
      key: "PLATFORM-42",
      intent: { type: "jira", issueKey: "PLATFORM-42" },
    },
    {
      label: "OpenProject",
      key: "APP-42",
      intent: {
        type: "openProject",
        workPackageId: 42,
        displayId: "APP-42",
      },
    },
    {
      label: "repository set",
      key: "payments-local",
      intent: { type: "repositorySet", label: "payments-local" },
    },
  ] satisfies Array<{
    label: string;
    key: string;
    intent: WorkspaceIntent;
  }>)(
    "saves a separate $label revision with its exact source intent",
    async ({ label, key, intent }) => {
      const user = userEvent.setup();
      const source = workspaceFixture({
        workspaceId: `ws_revision_source_${label}`,
        intent,
        title: `${label} original plan`,
        preferredProvider: "vsCode",
        repositories: [
          {
            requestId: "repo_checkout",
            repositoryId: "catalog_checkout",
            label: "checkout-api",
            baseRef: "release/2026.07",
            worktreeLeaf: "checkout-api",
          },
          {
            requestId: "repo_sdk",
            repositoryId: "catalog_payments_sdk",
            label: "payments-sdk",
            baseRef: "develop",
            worktreeLeaf: "payments-sdk",
          },
        ],
      });
      const customTitle = `${label} revised plan`;
      const extraRepository = {
        id: "catalog_senzu",
        label: "senzu",
        checkoutLeaf: "senzu",
        displayPath: "~/cd/senzu",
        defaultBranch: {
          name: "develop",
          fullRef: "refs/heads/develop",
          commitOid: "3".repeat(40),
        },
        availableBranches: [{
          name: "develop",
          fullRef: "refs/heads/develop",
          commitOid: "3".repeat(40),
          remote: false,
        }],
      };
      const saved = workspaceFixture({
        workspaceId: `ws_revision_saved_${label}`,
        intent,
        title: customTitle,
        preferredProvider: "vsCode",
        repositories: label === "Jira"
          ? [
              ...source.repositories,
              {
                requestId: "catalog_senzu",
                repositoryId: "catalog_senzu",
                label: "senzu",
                baseRef: "develop",
                worktreeLeaf: "senzu",
              },
            ]
          : source.repositories,
        workspaceLeaf: `revision-${label}`,
        workspaceDisplayPath: `~/cd/revision-${label}`,
      });
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture([source]),
        create: { workspace: saved, replayed: false },
        repositories: {
          ...repositoryCatalogFixture(),
          repositories: [
            ...repositoryCatalogFixture().repositories,
            extraRepository,
          ],
        },
      });

      render(<LocalWorkspace client={fake.client} />);
      await user.click(
        await screen.findByRole("button", {
          name: new RegExp(`Open ${key}:`, "i"),
        }),
      );
      await user.click(
        screen.getByRole("button", { name: "Workspace actions" }),
      );
      await user.click(
        screen.getByRole("menuitem", { name: "Create revised workspace…" }),
      );

      const dialog = screen.getByRole("dialog", { name: `Revise ${key}` });
      expect(
        within(dialog).queryByRole("radiogroup", {
          name: "Workspace source",
        }),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).queryByRole("combobox", {
          name: "Saved plan to copy",
        }),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).getAllByText("Original retained").length,
      ).toBeGreaterThan(0);
      expect(within(dialog).getByText("VS Code")).toBeVisible();
      if (label === "Jira") {
        fireEvent.change(
          within(dialog).getByRole("combobox", {
            name: "Repository to add to copied plan",
          }),
          { target: { value: "catalog_senzu" } },
        );
        await user.click(
          within(dialog).getByRole("button", { name: "Add repository" }),
        );
        expect(
          within(dialog).getByRole("list", {
            name: "Additional repositories in copied plan",
          }),
        ).toHaveTextContent("senzu");
      }

      const titleInput = within(dialog).getByRole("textbox", {
        name: "New plan title",
      });
      expect(titleInput).toHaveValue(`${source.title} · revised`);
      expect(titleInput).toHaveAttribute("maxlength", "240");
      expect(titleInput).toBeRequired();
      await user.clear(titleInput);
      await user.type(titleInput, customTitle);

      await user.click(
        within(dialog).getByRole("button", {
          name: /Review revised setup/i,
        }),
      );
      expect(within(dialog).getByText("Original retained")).toBeVisible();
      expect(within(dialog).getByText(customTitle)).toBeVisible();

      await user.click(
        within(dialog).getByRole("button", {
          name: /Analyze services/i,
        }),
      );
      await user.click(
        await within(dialog).findByRole("button", {
          name: /Review revised plan/i,
        }),
      );
      expect(within(dialog).getByText("Original retained")).toBeVisible();
      expect(
        within(dialog).getByText(new RegExp(`${key} remains unchanged`)),
      ).toBeVisible();

      await user.click(
        within(dialog).getByRole("button", {
          name: /Save revised plan/i,
        }),
      );
      expect(
        await within(dialog).findByText(`Revised ${key} plan is saved`),
      ).toBeVisible();
      expect(
        within(dialog).getByText(
          new RegExp(`Original retained: ${key} remains unchanged`),
        ),
      ).toBeVisible();
      expect(fake.createWorkspace).toHaveBeenCalledWith(
        {
          intent,
          title: customTitle,
          preferredProvider: "vsCode",
          repositories: [
            {
              repositoryId: "catalog_checkout",
              label: "checkout-api",
              baseRef: "release/2026.07",
            },
            {
              repositoryId: "catalog_payments_sdk",
              label: "payments-sdk",
              baseRef: "develop",
            },
            ...(label === "Jira"
              ? [{
                  repositoryId: "catalog_senzu",
                  label: "senzu",
                  baseRef: "develop",
                }]
              : []),
          ],
        },
        expect.any(String),
      );
      expect(fake.removeWorkspace).not.toHaveBeenCalled();

      await user.click(
        within(dialog).getByRole("button", {
          name: /Open revised plan/i,
        }),
      );
      await user.click(screen.getByRole("button", { name: /Spaces/i }));
      const matchingCards = screen.getAllByRole("button", {
        name: new RegExp(`Open ${key}:`, "i"),
      });
      expect(matchingCards).toHaveLength(2);
      expect(
        matchingCards.some(
          (card) =>
            card.getAttribute("aria-label") ===
              `Open ${key}: ${source.title} details`,
        ),
      ).toBe(true);
      expect(
        matchingCards.some(
          (card) =>
            card.getAttribute("aria-label") ===
              `Open ${key}: ${customTitle} details`,
        ),
      ).toBe(true);
    },
  );

  it("refuses a revision response that returns the original workspace", async () => {
    const user = userEvent.setup();
    const source = workspaceFixture({
      workspaceId: "ws_revision_original",
      intent: { type: "jira", issueKey: "REV-12" },
      title: "Original revision source",
      repositories: [
        {
          requestId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([source]),
      create: { workspace: source, replayed: false },
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open REV-12:/i }),
    );
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Create revised workspace…" }),
    );

    const dialog = screen.getByRole("dialog", { name: "Revise REV-12" });
    const title = within(dialog).getByRole("textbox", {
      name: "New plan title",
    });
    await user.clear(title);
    await user.type(title, "Separate revised plan");
    await user.click(
      within(dialog).getByRole("button", {
        name: /Review revised setup/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Analyze services/i,
      }),
    );
    await user.click(
      await within(dialog).findByRole("button", {
        name: /Review revised plan/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save revised plan/i,
      }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "WTS did not return a separate revised workspace",
    );
    expect(dialog).toHaveAccessibleName("Save needs attention");
    expect(
      within(dialog).queryByRole("button", { name: "Open revised plan" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("Revised REV-12 plan is saved"),
    ).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "Close new workspace" }),
    );
    await user.click(screen.getByRole("button", { name: /Spaces/i }));
    expect(
      screen.getAllByRole("button", {
        name: "Open REV-12: Original revision source details",
      }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("button", {
        name: "Open REV-12: Separate revised plan details",
      }),
    ).not.toBeInTheDocument();
  });

  it("re-indexes and manually removes a reviewed materialized workspace", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api--012345",
        },
      ],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization: WorkspaceMaterialization = {
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      workspaceRecordVersion: 1,
      effectDigest: "sha256:materialized",
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${persisted.workspaceDisplayPath}/wts.code-workspace`,
      branchName: "wts/platform-42-7fd1cafe",
      worktrees: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          targetDisplayPath: `${persisted.workspaceDisplayPath}/checkout-api--012345`,
          branchName: "wts/platform-42-7fd1cafe",
          baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
        },
      ],
      graph: {
        status: "ready",
        detail: "Workspace graph is ready.",
      },
    };
    const removalPreflight = {
      workspaceId: persisted.workspaceId,
      kind: "materializedWorkspace" as const,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      ready: true,
      effectDigest: "sha256:remove",
      worktrees: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          targetDisplayPath: materialization.worktrees[0]!.targetDisplayPath,
          branchName: materialization.branchName,
          headCommitOid: "89abcdef0123456789abcdef0123456789abcdef",
          present: true,
        },
      ],
      generatedPaths: [
        `${persisted.workspaceDisplayPath}/.wts`,
        materialization.codeWorkspaceDisplayPath,
      ],
      protectedPaths: [],
      retainedBranches: [materialization.branchName],
      blockers: [],
      warnings: ["Close editors before removing this workspace."],
    };
    const removalResult: RemoveWorkspaceResult = {
      workspaceId: persisted.workspaceId,
      replayed: false,
      removedWorktreeCount: 1,
      retainedBranches: [materialization.branchName],
      removedGeneratedPaths: removalPreflight.generatedPaths,
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      evidence: assistantEvidence(persisted, []),
      reindex: {
        workspaceId: persisted.workspaceId,
        status: "ready",
        graphDisplayPath: `${persisted.workspaceDisplayPath}/graphify-out/graph.json`,
        detail: "Workspace graph refreshed.",
        durationMs: 184,
      },
      removalPreflight,
      remove: removalResult,
    });
    fake.indexWorkspaceGraph.mockResolvedValue({
      workspaceId: persisted.workspaceId,
      status: "ready",
      graphDisplayPath: `${persisted.workspaceDisplayPath}/graphify-out/graph.json`,
      detail: "Workspace graph refreshed.",
      durationMs: 184,
    });
    let resolveRemoval!: (value: RemoveWorkspaceResult) => void;
    const pendingRemoval = new Promise<RemoveWorkspaceResult>((resolve) => {
      resolveRemoval = resolve;
    });
    fake.removeWorkspace.mockReturnValue(pendingRemoval);

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await screen.findByRole("button", { name: "Workspace actions" });

    await selectWorkspaceView(user, "Verification");
    await user.click(await screen.findByText("Improve coverage"));
    await user.click(
      screen.getByRole("button", { name: "Rebuild graph" }),
    );
    await waitFor(() =>
      expect(fake.indexWorkspaceGraph).toHaveBeenCalledWith(
        persisted.workspaceId,
      ),
    );
    expect(
      screen.getByRole("button", { name: "Prepare verification brief" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove workspace…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Remove PLATFORM-42 from this Mac/i,
    });
    expect(within(dialog).getByText("always retained")).toBeVisible();
    expect(
      within(dialog).getByText("Local worktrees").parentElement,
    ).toHaveTextContent(`branch ${materialization.branchName} stays`);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(dialog).toBeVisible();
    expect(
      screen.queryByRole("dialog", {
        name: "Environment & integrations",
      }),
    ).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /Remove these local worktrees/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Remove workspace" }),
    );

    await waitFor(() =>
      expect(fake.removeWorkspace).toHaveBeenCalledWith(
        persisted.workspaceId,
        removalPreflight.effectDigest,
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        false,
      ),
    );
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Close removal dialog" }),
    ).toBeDisabled();
    await waitFor(() =>
      expect(
        within(dialog)
          .getByText("Removing reviewed local effects")
          .closest("[tabindex='-1']"),
      ).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();

    await act(async () => {
      resolveRemoval(removalResult);
      await pendingRemoval;
    });
    expect(
      await screen.findByRole("heading", {
        name: "No local workspaces found",
      }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("status").slice(-1)[0],
    ).toHaveTextContent("PLATFORM-42 removed · 1 local branch retained");
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /New workspace/i }),
      ).toContain(document.activeElement),
    );
  });

  it("deletes reviewed local changes and planning files after confirmation", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      workspaceId: "ws_destructive_removal",
      intent: { type: "repositorySet", label: "bmc-api" },
      title: "Remove reviewed local data",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    const removalPreflight = {
      workspaceId: persisted.workspaceId,
      kind: "materializedWorkspace" as const,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      ready: false,
      effectDigest: "sha256:remove-local-data",
      worktrees: [{
        repositoryId: "repo_checkout",
        label: "bmc-api",
        targetDisplayPath: materialization.worktrees[0]!.targetDisplayPath,
        branchName: materialization.branchName,
        headCommitOid: "a".repeat(40),
        present: true,
      }],
      generatedPaths: [],
      protectedPaths: [{
        displayPath: `${persisted.workspaceDisplayPath}/plans-and-kanban`,
        entries: ["PLAN.md"],
        entriesTruncated: false,
        filePreviews: [{
          relativePath: "PLAN.md",
          contents: "# Plan\n",
        }],
      }],
      retainedBranches: [materialization.branchName],
      blockers: [
        {
          code: "worktreeChanges" as const,
          message: "Tracked, staged, or untracked files must be saved or removed first.",
          repositoryLabel: "bmc-api",
        },
        {
          code: "planningDocumentsPresent" as const,
          message: "The workspace contains user-owned planning files.",
        },
      ],
      warnings: [],
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      removalPreflight,
      remove: {
        workspaceId: persisted.workspaceId,
        replayed: false,
        removedWorktreeCount: 1,
        retainedBranches: [materialization.branchName],
        removedGeneratedPaths: [
          `${persisted.workspaceDisplayPath}/plans-and-kanban`,
        ],
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open bmc-api:/i }),
    );
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove workspace…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Remove bmc-api from this Mac/i,
    });
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /Delete local changes, planning files, and this workspace/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Delete local data and workspace",
      }),
    );

    await waitFor(() =>
      expect(fake.removeWorkspace).toHaveBeenCalledWith(
        persisted.workspaceId,
        removalPreflight.effectDigest,
        expect.any(String),
        true,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "No local workspaces found" }),
    ).toBeVisible();
  });

  it("registers expected Git drift and re-indexes from the recovery state", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_checkout",
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
      lifecycle: {
        materializationState: "needsAttention",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted, "ready");
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      branchName: "manual-drift",
      gitState: {
        headCommitOid: "89abcdef0123456789abcdef0123456789abcdef",
        originUrl: "https://github.com/example/checkout-api.git",
        upstreamFullRef: "refs/remotes/origin/main",
      },
      activity: { changedFileCount: 3, commitsAhead: 2 },
    };
    const repositories = repositoryCatalogFixture();
    repositories.repositories.push({
      id: "repo_web",
      label: "checkout-web",
      checkoutLeaf: "checkout-web",
      displayPath: "~/cd/checkout-web",
      defaultBranch: {
        name: "main",
        fullRef: "refs/heads/main",
        commitOid: "1123456789abcdef0123456789abcdef01234567",
      },
      availableBranches: [{
        name: "main",
        fullRef: "refs/heads/main",
        commitOid: "1123456789abcdef0123456789abcdef01234567",
        remote: false,
      }],
    });
    const addedMaterialization = {
      ...materialization,
      worktrees: [...materialization.worktrees, {
        repositoryId: "repo_web",
        label: "checkout-web",
        targetDisplayPath: `${materialization.workspaceDisplayPath}/checkout-web`,
        branchName: materialization.branchName,
        baseCommitOid: "1123456789abcdef0123456789abcdef01234567",
      }],
    };
    const addedView = workspaceFixture({
      repositories: [...persisted.repositories, {
        requestId: "repo_web_request",
        repositoryId: "repo_web",
        label: "checkout-web",
        baseRef: "main",
        worktreeLeaf: "checkout-web",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 2,
        observedAtUnixMs: 1_721_776_500_100,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      get: addedView,
      repositories,
      persistedMaterialization: materialization,
      repositoryAdditionPreflight: {
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_web",
        repositoryLabel: "checkout-web",
        baseRef: "main",
        resolvedBaseRef: "refs/heads/main",
        baseCommitOid: "1123456789abcdef0123456789abcdef01234567",
        targetDisplayPath: `${materialization.workspaceDisplayPath}/checkout-web`,
        branchName: materialization.branchName,
        effectDigest: `sha256:${"a".repeat(64)}`,
      },
      repositoryAddition: {
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_web",
        repositoryLabel: "checkout-web",
        replayed: false,
        graphRefreshed: false,
        graphDetail: "Graph indexing is not configured.",
        materialization: addedMaterialization,
      },
      repositoryRemoval: {
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_web",
        repositoryLabel: "checkout-web",
        graphRefreshed: false,
        graphDetail: "Graph indexing is not configured.",
        materialization,
      },
      reindex: {
        workspaceId: persisted.workspaceId,
        status: "ready",
        graphDisplayPath: `${persisted.workspaceDisplayPath}/graphify-out/graph.json`,
        detail: "Workspace graph refreshed.",
        durationMs: 42,
      },
    });
    fake.getWorkspace
      .mockResolvedValueOnce(addedView)
      .mockResolvedValueOnce(persisted);
    fake.getWorkspaceMaterialization.mockRejectedValueOnce(
      new WorkspaceClientError(
        "The managed worktrees changed since WTS last registered their Git state.",
        {
          code: "workspace_git_state_changed",
        },
      ),
    );

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "Register the current Git state",
      }),
    ).toBeVisible();
    expect(
      screen.getByText(
        /current branches, HEAD commits, origins, and upstreams/i,
      ),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Register changes & re-index" }),
    );

    await waitFor(() =>
      expect(fake.reindexWorkspaceGraph).toHaveBeenCalledWith(
        persisted.workspaceId,
      ),
    );
    expect(
      await screen.findByRole("columnheader", { name: "Base" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("columnheader", { name: "Work" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("columnheader", { name: "Verification" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("3 changed files · 2 commits ahead")).toBeVisible();
    expect(screen.queryByText(materialization.worktrees[0]!.targetDisplayPath)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: "Register the current Git state",
      }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add repositories" }));
    const addDialog = await screen.findByRole("dialog", {
      name: "Add repository to PLATFORM-42",
    });
    const repositoryPicker = within(addDialog).getByRole("combobox", {
      name: "Repository to add",
    });
    expect(repositoryPicker).toHaveValue("checkout-web · main · checkout-web");
    await user.clear(repositoryPicker);
    await user.type(repositoryPicker, "checkout-web");
    await user.click(
      screen.getByRole("option", { name: /checkout-web · main/i }),
    );
    expect(repositoryPicker).toHaveValue("checkout-web · main · checkout-web");
    expect(screen.queryByRole("dialog", { name: /Revise / })).not.toBeInTheDocument();
    await user.click(within(addDialog).getByRole("button", { name: "Review repository" }));
    await waitFor(() => expect(fake.preflightWorkspaceRepositoryAddition).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_web",
      "main",
    ));
    await user.click(await within(addDialog).findByRole("button", { name: "Add to workspace" }));
    await waitFor(() => expect(fake.addWorkspaceRepository).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_web",
      "main",
      `sha256:${"a".repeat(64)}`,
    ));
    expect(fake.createWorkspace).not.toHaveBeenCalled();
    expect(await screen.findByText("checkout-web")).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: "Remove checkout-web from this workspace",
      }),
    );
    const removePrompt = screen.getByRole("alertdialog", {
      name: "Remove checkout-web from this workspace",
    });
    expect(removePrompt).toHaveTextContent("The source checkout and retained branch stay on disk.");
    await user.click(
      within(removePrompt).getByRole("button", { name: "Remove repository" }),
    );
    await waitFor(() =>
      expect(fake.removeWorkspaceRepository).toHaveBeenCalledWith(
        persisted.workspaceId,
        "repo_web",
      ),
    );
    expect(
      screen.queryByRole("button", {
        name: "Remove checkout-web from this workspace",
      }),
    ).not.toBeInTheDocument();
    expect(fake.createWorkspace).not.toHaveBeenCalled();
  });

  it("opens the current workspace directly from provider and editor buttons", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const running: WorkspaceAgentEvidence = {
      schemaVersion: 1,
      runId: "0198d9d3-55d5-7000-8000-000000000001",
      workspaceId: persisted.workspaceId,
      provider: "openCode",
      state: "running",
      startedAtUnixMs: 1_721_776_450_000,
      completedAtUnixMs: null,
      durationMs: null,
      promptSha256: "sha256:prompt-running",
      outputSha256: null,
      failure: null,
    };
    const failed: WorkspaceAgentEvidence = {
      schemaVersion: 1,
      runId: "0198d9d3-55d5-7000-8000-000000000002",
      workspaceId: persisted.workspaceId,
      provider: "codex",
      state: "failed",
      startedAtUnixMs: 1_721_776_430_000,
      completedAtUnixMs: 1_721_776_431_250,
      durationMs: 1_250,
      promptSha256: "sha256:prompt-failed",
      outputSha256: "sha256:output-failed",
      failure: "timedOut",
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: assistantMaterialization(persisted),
      evidence: assistantEvidence(persisted, [running, failed]),
    });
    fake.openWorkspaceCli.mockResolvedValue({
      workspaceId: persisted.workspaceId,
      provider: "codex",
      terminal: "terminal",
      accepted: true,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
    });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await selectWorkspaceAction(user, "Open workspace");
    expect(fake.openWorkspaceCli).toHaveBeenCalledWith(
      persisted.workspaceId,
      "codex",
      "terminal",
    );

    await selectWorkspaceAction(user, "Open with…");

    const panel = await screen.findByRole("dialog", {
      name: "Open workspace",
    });
    expect(
      within(panel).getAllByText(persisted.workspaceDisplayPath)[0],
    ).toBeVisible();
    expect(
      within(panel).queryByText(/workspace index/i),
    ).not.toBeInTheDocument();
    expect(
      within(panel).getByRole("heading", {
        name: "Continue with your preferred tool",
      }),
    ).toBeVisible();
    expect(
      within(panel).getByRole("group", { name: "Terminal application" }),
    ).toBeVisible();
    expect(
      within(panel).queryByText(/foreground session, not a hidden job/i),
    ).not.toBeInTheDocument();
    expect(within(panel).queryByText("WHAT WTS DOES")).not.toBeInTheDocument();
    await user.click(
      within(panel).getByRole("button", { name: "Open workspace in VS Code" }),
    );
    expect(fake.openWorkspaceInVscode).toHaveBeenCalledWith(
      persisted.workspaceId,
    );
    expect(within(panel).queryByText("Running")).not.toBeInTheDocument();
    expect(
      within(panel).queryByRole("button", { name: /Stop/i }),
    ).not.toBeInTheDocument();
    expect(fake.runWorkspaceAgent).not.toHaveBeenCalled();
    expect(fake.getWorkspaceEvidence).not.toHaveBeenCalled();
  });

  it("opens a trusted repository and shows its bounded local diff", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_checkout",
          repositoryId: "repo_checkout",
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
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      gitState: {
        headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
        originUrl: "git@gitlab.example.com:acme/checkout-api.git",
      },
      activity: { changedFileCount: 1, commitsAhead: 2 },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      repositoryBaseOpen: {
        repositoryId: "repo_checkout",
        forge: "gitlab",
        host: "gitlab.example.com",
        baseRef: "main",
        commitOid: materialization.worktrees[0]!.baseCommitOid,
        accepted: true,
      },
      repositoryDiff: {
        schemaVersion: 1,
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_checkout",
        repositoryLabel: "checkout-api",
        baseCommitOid: materialization.worktrees[0]!.baseCommitOid,
        headCommitOid: materialization.worktrees[0]!.gitState!.headCommitOid,
        patchSha256: `sha256:${"a".repeat(64)}`,
        patch:
          "diff --git a/src/checkout.ts b/src/checkout.ts\nindex 1111111..2222222 100644\n--- a/src/checkout.ts\n+++ b/src/checkout.ts\n@@ -1 +1 @@\n-export const checkout = false\n+export const checkout = true\ndiff --git a/src/checkout.test.ts b/src/checkout.test.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/checkout.test.ts\n@@ -0,0 +1 @@\n+expect(checkout).toBe(true)\n",
        patchTruncated: false,
        untrackedPaths: ["notes.txt"],
        untrackedPathsTruncated: false,
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Open PLATFORM-42: Checkout retries create duplicate captures details",
      }),
    );
    expect(screen.queryByText("Configuration")).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Base" })).toBeVisible();
    expect(screen.getByText("01234567")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Open checkout-api on GitLab" }),
    );
    expect(fake.openRepositoryBase).toHaveBeenCalledWith("repo_checkout", "main");
    await user.click(
      screen.getByRole("button", { name: /Review changes in checkout-api/i }),
    );

    const review = await screen.findByRole("region", {
      name: "Change review",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(globalThis.location.pathname).toBe(
      `/sessions/${persisted.workspaceId}/changes`,
    );
    expect(globalThis.location.search).toBe("?repository=repo_checkout");
    const changedFiles = await within(review).findByLabelText("Changed files");
    const source = within(changedFiles).getByRole("button", {
      name: "src/checkout.ts, modified, 1 addition, 1 deletion",
    });
    expect(source).toBeVisible();
    const changeSearch = within(review).getByRole("searchbox", {
      name: "Search changed code",
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    await waitFor(() => expect(changeSearch).toHaveFocus());
    await user.type(changeSearch, "does not exist");
    expect(
      within(review).getByText(/No changed code matches/),
    ).toHaveTextContent("No changed code matches");
    await user.keyboard("{Escape}");
    expect(changeSearch).toHaveValue("");
    expect(
      within(changedFiles).queryByRole("button", {
        name: /src\/checkout\.test\.ts, added/i,
      }),
    ).not.toBeInTheDocument();
    expect(within(review).queryByText("checkout.test.ts")).not.toBeInTheDocument();

    await user.click(
      within(changedFiles).getByRole("button", { name: /Show tests:/i }),
    );
    expect(
      within(changedFiles).getByRole("button", {
        name: /src\/checkout\.test\.ts, added/i,
      }),
    ).toBeVisible();

    const codeChanges = within(review).getByLabelText("Code changes");
    const scrollContainer = codeChanges.querySelector<HTMLElement>(
      '[tabindex="-1"]',
    );
    expect(scrollContainer).not.toBeNull();
    expect(getComputedStyle(scrollContainer!).overflow).toBe("auto");
    const split = within(review).getByRole("button", { name: "Split" });
    expect(split).toHaveAttribute("aria-pressed", "false");
    await user.click(split);
    expect(split).toHaveAttribute("aria-pressed", "true");
    const wrapLines = within(review).getByRole("button", {
      name: "Wrap lines",
    });
    await user.click(wrapLines);
    expect(wrapLines).toHaveAttribute("aria-pressed", "true");
    expect(fake.getWorkspaceRepositoryDiff).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_checkout",
    );
  });

  it("prepares a repository-scoped merge request and opens the reviewed draft", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [{
        requestId: "repo_checkout",
        repositoryId: "repo_checkout",
        label: "checkout-api",
        baseRef: "main",
        worktreeLeaf: "checkout-api",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      gitState: {
        headCommitOid: "0123456789abcdef0123456789abcdef01234567",
        originUrl: "git@gitlab.example.com:acme/checkout-api.git",
        upstreamFullRef: "refs/remotes/upstream/feat/PLATFORM-7197",
      },
      activity: { changedFileCount: 0, commitsAhead: 1 },
    };
    const changeRequestDraft = {
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      repositoryId: "repo_checkout",
      repositoryLabel: "checkout-api",
      forge: "gitlab" as const,
      host: "gitlab.example.com",
      sourceRemoteName: "upstream",
      sourceBranch: "feat/PLATFORM-7197",
      sourceHeadCommitOid: "0123456789abcdef0123456789abcdef01234567",
      targetBranch: "main",
      commitSubject: "feat: validate admission",
      proposedBySessionId: "33333333-3333-4333-8333-333333333333",
      proposedByProvider: "codex" as const,
      commits: [{
        commitOid: "0123456789abcdef0123456789abcdef01234567",
        subject: "feat: validate admission",
      }],
      changedFiles: ["src/admission.rs", "tests/admission.test.rs"],
      worktreeClean: true,
      remoteMatches: true,
      title: "PLATFORM-7197: Validate admission",
      body: "## Summary\n\n- Validate admission",
      workItems: [{
        linkId: "22222222-2222-4222-8222-222222222222",
        issueKey: "PLATFORM-7197",
        summary: "Validate admission",
      }],
      verificationStatus: "passed" as const,
      verificationSummary: "8 verification checks passed",
      effectDigest: `sha256:${"a".repeat(64)}`,
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      changeRequestDraft,
      changeRequestOpen: {
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_checkout",
        forge: "gitlab",
        host: "gitlab.example.com",
        sourceBranch: changeRequestDraft.sourceBranch,
        targetBranch: "main",
        sourceHeadCommitOid: changeRequestDraft.sourceHeadCommitOid,
        accepted: true,
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", {
      name: "Open PLATFORM-42: Checkout retries create duplicate captures details",
    }));
    await user.click(screen.getByRole("button", { name: "Prepare MR" }));
    expect(fake.prepareWorkspaceChangeRequest).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_checkout",
    );
    expect(await screen.findByRole("dialog", { name: /Prepare merge request/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Continue in GitLab/ }));
    expect(fake.openWorkspaceChangeRequestDraft).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_checkout",
      changeRequestDraft.effectDigest,
      changeRequestDraft.title,
      changeRequestDraft.body,
    );
    expect(await screen.findByText("checkout-api · merge request form opened.")).toBeVisible();
  });

  it("publishes an untracked branch and retries change-request preparation", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [{
        requestId: "repo_checkout",
        repositoryId: "repo_checkout",
        label: "checkout-api",
        baseRef: "main",
        worktreeLeaf: "checkout-api",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      gitState: {
        headCommitOid: "0123456789abcdef0123456789abcdef01234567",
        originUrl: "git@gitlab.example.com:acme/checkout-api.git",
      },
      activity: { changedFileCount: 0, commitsAhead: 1 },
    };
    const draft = {
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      repositoryId: "repo_checkout",
      repositoryLabel: "checkout-api",
      forge: "gitlab" as const,
      host: "gitlab.example.com",
      sourceRemoteName: "origin",
      sourceBranch: "feat/PLATFORM-7197",
      sourceHeadCommitOid: "0123456789abcdef0123456789abcdef01234567",
      targetBranch: "main",
      commitSubject: "feat: validate admission",
      proposedBySessionId: "33333333-3333-4333-8333-333333333333",
      proposedByProvider: "codex" as const,
      commits: [{
        commitOid: "0123456789abcdef0123456789abcdef01234567",
        subject: "feat: validate admission",
      }],
      changedFiles: ["src/admission.rs"],
      worktreeClean: true,
      remoteMatches: true,
      title: "PLATFORM-7197: Validate admission",
      body: "## Summary\n\n- Validate admission",
      workItems: [],
      verificationStatus: "passed" as const,
      verificationSummary: "Checks passed.",
      effectDigest: `sha256:${"a".repeat(64)}`,
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      changeRequestDraft: draft,
      branchPublication: {
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_checkout",
        repositoryLabel: "checkout-api",
        remoteName: "origin",
        branchName: "feat/PLATFORM-7197",
        headCommitOid: draft.sourceHeadCommitOid,
      },
    });
    fake.prepareWorkspaceChangeRequest.mockRejectedValueOnce(
      new WorkspaceClientError(
        "Publish this branch and set its upstream before you prepare a change request.",
        { code: "change_request_branch_not_published", retryable: true },
      ),
    );

    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", {
      name: "Open PLATFORM-42: Checkout retries create duplicate captures details",
    }));
    await user.click(screen.getByRole("button", { name: "Prepare MR" }));
    expect(await screen.findByRole("button", { name: "Publish branch" })).toBeVisible();
    const branchName = screen.getByRole("textbox", { name: "Branch name" });
    expect(branchName).toHaveValue(materialization.worktrees[0]!.branchName);
    await user.clear(branchName);
    await user.type(branchName, "feat/PLATFORM-7197");

    await user.click(screen.getByRole("button", { name: "Publish branch" }));

    expect(fake.publishWorkspaceChangeRequestBranch).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_checkout",
      "feat/PLATFORM-7197",
    );
    expect(fake.prepareWorkspaceChangeRequest).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("dialog", { name: /Prepare merge request/ })).toBeVisible();
    expect(screen.getByText("checkout-api · branch published.")).toBeVisible();
  });

  it("starts an agent when the current commit has no change-request proposal", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [{
        requestId: "repo_checkout",
        repositoryId: "repo_checkout",
        label: "checkout-api",
        baseRef: "main",
        worktreeLeaf: "checkout-api",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      gitState: {
        headCommitOid: "0123456789abcdef0123456789abcdef01234567",
        originUrl: "git@gitlab.example.com:acme/checkout-api.git",
        upstreamFullRef: "refs/remotes/origin/feat/PLATFORM-7197",
      },
      activity: { changedFileCount: 0, commitsAhead: 1 },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
    });
    fake.prepareWorkspaceChangeRequest.mockRejectedValue(
      new WorkspaceClientError(
        "No agent session prepared a change request for this repository commit. Select Ask agent to prepare.",
        { code: "change_request_agent_proposal_unavailable", retryable: true },
      ),
    );
    fake.launchAgentSession.mockResolvedValue({
      schemaVersion: 1,
      sessionId: "99999999-9999-4999-8999-999999999999",
      workspaceId: persisted.workspaceId,
      provider: "codex",
      terminal: "terminal",
      category: "review",
      status: "launching",
      startedAtUnixMs: 1_721_776_500_000,
      lastHeartbeatAtUnixMs: 1_721_776_500_000,
      endedAtUnixMs: null,
      failure: null,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", {
      name: "Open PLATFORM-42: Checkout retries create duplicate captures details",
    }));
    await user.click(screen.getByRole("button", { name: "Prepare MR" }));
    await user.click(await screen.findByRole("button", { name: "Ask agent to prepare" }));

    expect(fake.launchAgentSession).toHaveBeenCalledWith(
      persisted.workspaceId,
      expect.objectContaining({
        provider: "codex",
        category: "review",
        prompt: expect.stringContaining("WTS_CHANGE_REQUEST_PROPOSAL"),
      }),
    );
    expect(await screen.findByText(
      "checkout-api · Codex started. Prepare the change request again after the agent finishes.",
    )).toBeVisible();
  });

  it("shows matching GitLab merge requests and uses the trusted open action", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [{
        requestId: "repo_senzu",
        repositoryId: "repo_senzu",
        label: "senzu",
        baseRef: "develop",
        worktreeLeaf: "senzu",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      gitState: {
        headCommitOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        originUrl: "git@gitlab.example.com:acme/senzu.git",
        upstreamFullRef: "refs/remotes/origin/feat/PLATFORM-7197",
      },
      activity: { changedFileCount: 0, commitsAhead: 3 },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      gitlabMergeRequestInbox: {
        schemaVersion: 1,
        state: "fresh",
        mergeRequests: [
          {
            id: "mr-42",
            repositoryId: "repo_senzu",
            projectPath: "acme/senzu",
            webUrl: "https://gitlab.example.com/acme/senzu/-/merge_requests/42",
            iid: 42,
            title: "Validate admission",
            authorUsername: "octocat",
            sourceBranch: "feat/PLATFORM-7197",
            sourceHeadCommitOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            targetBranch: "develop",
            updatedAt: "2026-08-14T08:15:00Z",
            draft: false,
            status: "merged",
          },
          {
            id: "mr-43",
            repositoryId: "repo_senzu",
            projectPath: "acme/senzu",
            webUrl: "https://gitlab.example.com/acme/senzu/-/merge_requests/43",
            iid: 43,
            title: "Follow-up draft",
            authorUsername: "octocat",
            sourceBranch: "feat/PLATFORM-7197",
            targetBranch: "develop",
            updatedAt: "2026-08-14T09:15:00Z",
            draft: true,
            status: "open",
          },
        ],
        fetchedAtUnixMs: 1_776_153_300_000,
        detail: "GitLab returned current merge requests.",
      },
    });
    fake.openGitlabMergeRequest.mockResolvedValue({
      repositoryId: "repo_senzu",
      iid: 42,
      accepted: true,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /Open PLATFORM-42:/i }));

    const current = await screen.findByRole("link", {
      name: /Open senzu merge request !42 on GitLab: Validate admission/i,
    });
    expect(current).toHaveAttribute(
      "href",
      "https://gitlab.example.com/acme/senzu/-/merge_requests/42",
    );
    expect(current).toHaveTextContent("MR !42 · Merged · New local work");
    expect(
      screen.getByRole("link", {
        name: /Open senzu merge request !43 on GitLab: Follow-up draft/i,
      }),
    ).toHaveTextContent("Draft MR !43 · Open");
    expect(screen.queryByRole("button", { name: "Prepare MR" })).not.toBeInTheDocument();

    await user.click(current);
    expect(fake.openGitlabMergeRequest).toHaveBeenCalledWith("repo_senzu", 42);
    expect(
      await screen.findByText("senzu · merge request !42 opened."),
    ).toBeVisible();
  });

  it("does not offer a merge request for a clean repository", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [{
        requestId: "repo_senzu",
        repositoryId: "repo_senzu",
        label: "senzu",
        baseRef: "develop",
        worktreeLeaf: "senzu",
      }],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      gitState: {
        headCommitOid: "b".repeat(40),
        originUrl: "git@gitlab.example.com:acme/senzu.git",
        upstreamFullRef: "refs/remotes/origin/feat/PLATFORM-7197",
      },
      activity: { changedFileCount: 0, commitsAhead: 0 },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      gitlabMergeRequestInbox: {
        schemaVersion: 1,
        state: "fresh",
        mergeRequests: [],
        fetchedAtUnixMs: 1_776_153_300_000,
        detail: "GitLab found no matching merge requests.",
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /Open PLATFORM-42:/i }));
    await waitFor(() => expect(fake.getGitlabMergeRequests).toHaveBeenCalled());
    expect(screen.getByText("Clean")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Prepare MR" })).not.toBeInTheDocument();
  });

  it("keeps GitLab setup out of workspace repository rows", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_senzu",
          repositoryId: "repo_senzu",
          label: "senzu",
          baseRef: "develop",
          worktreeLeaf: "senzu",
        },
        {
          requestId: "repo_reporting",
          repositoryId: "repo_reporting",
          label: "reporting",
          baseRef: "develop",
          worktreeLeaf: "reporting",
        },
      ],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      gitState: {
        headCommitOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        originUrl: "git@gitlab.example.com:acme/senzu.git",
        upstreamFullRef: "refs/remotes/origin/feat/PLATFORM-7197",
      },
    };
    materialization.worktrees[1] = {
      ...materialization.worktrees[0]!,
      repositoryId: "repo_reporting",
      label: "reporting",
      targetDisplayPath: `${persisted.workspaceDisplayPath}/reporting`,
      gitState: {
        headCommitOid: "cccccccccccccccccccccccccccccccccccccccc",
        originUrl: "git@gitlab.example.com:acme/reporting.git",
        upstreamFullRef: "refs/remotes/origin/feat/PLATFORM-7197",
      },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      gitlabMergeRequestInbox: {
        schemaVersion: 1,
        state: "auth",
        mergeRequests: [],
        fetchedAtUnixMs: null,
        detail: "Sign in to GitLab with glab auth login.",
        diagnosticCode: "authenticationRequired",
      },
    });
    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", { name: /Open PLATFORM-42:/i }));
    await waitFor(() => expect(fake.getGitlabMergeRequests).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Prepare MR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check MR/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/glab auth login/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Connect GitLab/i)).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-overview.gitlab-delivery")).not.toBeInTheDocument();
  });

  it("opens the first repository with local changes instead of a clean repository", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_clean",
          repositoryId: "repo_clean",
          label: "clean-api",
          baseRef: "main",
          worktreeLeaf: "clean-api",
        },
        {
          requestId: "repo_changed",
          repositoryId: "repo_changed",
          label: "changed-api",
          baseRef: "main",
          worktreeLeaf: "changed-api",
        },
      ],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 2,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees = persisted.repositories.map((repository) => ({
      repositoryId: repository.repositoryId!,
      label: repository.label,
      targetDisplayPath: `${persisted.workspaceDisplayPath}/${repository.worktreeLeaf}`,
      branchName: materialization.branchName,
      baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
    }));
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
    });
    fake.getWorkspaceRepositoryDiff.mockImplementation(
      async (workspaceId, repositoryId) => ({
        schemaVersion: 1,
        workspaceId,
        repositoryId,
        repositoryLabel:
          repositoryId === "repo_changed" ? "changed-api" : "clean-api",
        baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
        headCommitOid: "fedcba9876543210fedcba9876543210fedcba98",
        patchSha256: `sha256:${"a".repeat(64)}`,
        patch:
          repositoryId === "repo_changed"
            ? "diff --git a/src/change.ts b/src/change.ts\nindex 1111111..2222222 100644\n--- a/src/change.ts\n+++ b/src/change.ts\n@@ -1 +1 @@\n-export const changed = false\n+export const changed = true\n"
            : "",
        patchTruncated: false,
        untrackedPaths: [],
        untrackedPathsTruncated: false,
      }),
    );

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", {
        name: "Open PLATFORM-42: Checkout retries create duplicate captures details",
      }),
    );
    await selectWorkspaceView(user, "Changes");

    const review = await screen.findByRole("region", {
      name: "Change review",
    });
    expect(within(review).getByText("changed-api changes")).toBeVisible();
    expect(within(review).queryByText("No local changes")).not.toBeInTheDocument();
    expect(fake.getWorkspaceRepositoryDiff.mock.calls).toEqual([
      [persisted.workspaceId, "repo_clean"],
      [persisted.workspaceId, "repo_changed"],
    ]);
  });

  it("syncs a managed repository without an origin-named remote and waits for the graph result", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_jellyfish",
          repositoryId: "repo_jellyfish",
          label: "jellyfish",
          baseRef: "develop",
          worktreeLeaf: "jellyfish",
        },
      ],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      baseCommitOid: "c10cc79c11111111111111111111111111111111",
      gitState: {
        headCommitOid: "c10cc79c11111111111111111111111111111111",
      },
      activity: { changedFileCount: 0, commitsAhead: 0 },
    };
    const updatedMaterialization: WorkspaceMaterialization = {
      ...materialization,
      worktrees: [
        {
          ...materialization.worktrees[0]!,
          baseCommitOid: "718063770fb21d18f5fe92aac26da4ce18f52f48",
          gitState: {
            ...materialization.worktrees[0]!.gitState!,
            headCommitOid: "718063770fb21d18f5fe92aac26da4ce18f52f48",
          },
        },
      ],
      graph: { status: "ready", detail: "Workspace graph refreshed." },
    };
    const pending = deferred<WorkspaceRepositorySyncResult>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
    });
    fake.syncWorkspaceRepository.mockReturnValue(pending.promise);

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Sync jellyfish with upstream develop",
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "Sync jellyfish with upstream develop",
      }),
    ).toHaveTextContent("Syncing…");
    expect(screen.getByText(/fetching upstream and rebuilding the graph/i)).toBeVisible();

    await act(async () => {
      pending.resolve({
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_jellyfish",
        repositoryLabel: "jellyfish",
        previousBaseCommitOid: materialization.worktrees[0]!.baseCommitOid,
        baseCommitOid: "718063770fb21d18f5fe92aac26da4ce18f52f48",
        updated: true,
        graphRefreshed: true,
        graphDetail: "Workspace graph refreshed.",
        materialization: updatedMaterialization,
      });
      await pending.promise;
    });

    expect(fake.syncWorkspaceRepository).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_jellyfish",
    );
    expect(await screen.findByText("71806377")).toBeVisible();
    expect(
      screen.getByText("jellyfish updated c10cc79c → 71806377. Graph refreshed."),
    ).toBeVisible();
  });

  it("offers recovery actions when local work blocks repository sync", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_jellyfish",
          repositoryId: "repo_jellyfish",
          label: "jellyfish",
          baseRef: "develop",
          worktreeLeaf: "jellyfish",
        },
      ],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      gitState: {
        headCommitOid: materialization.worktrees[0]!.baseCommitOid,
        originUrl: "git@gitlab.example.com:acme/jellyfish.git",
      },
      activity: { changedFileCount: 0, commitsAhead: 0 },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
    });
    fake.syncWorkspaceRepository.mockRejectedValue(
      new WorkspaceClientError(
        "Sync cannot change a worktree that has local work. Review or save the local work before you retry.",
        { code: "repository_sync_blocked", retryable: false },
      ),
    );

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Sync jellyfish with upstream develop",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "jellyfish has local changes or commits",
    );
    expect(
      screen.getByRole("button", { name: "Open workspace" }),
    ).toBeVisible();
    expect(screen.getByText("01234567")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review work" }));
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("blocks sync up front when the repository has known local work", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_jellyfish",
          repositoryId: "repo_jellyfish",
          label: "jellyfish",
          baseRef: "develop",
          worktreeLeaf: "jellyfish",
        },
      ],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      activity: { changedFileCount: 1, commitsAhead: 0 },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );

    expect(
      screen.getByRole("button", {
        name: "Sync jellyfish with upstream develop",
      }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", {
        name: "Review changes in jellyfish: 1 changed file",
      }),
    );
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(fake.syncWorkspaceRepository).not.toHaveBeenCalled();
  });

  it("reviews divergent history, preserves a backup, and aligns only after confirmation", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_senzu",
          repositoryId: "repo_senzu",
          label: "senzu",
          baseRef: "develop",
          worktreeLeaf: "senzu",
        },
      ],
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    materialization.worktrees[0] = {
      ...materialization.worktrees[0]!,
      baseCommitOid: "1401ce0c2ac772dd7378f396fbf84691e70838ef",
      gitState: {
        headCommitOid: "1401ce0c2ac772dd7378f396fbf84691e70838ef",
      },
      activity: { changedFileCount: 0, commitsAhead: 0 },
    };
    const updatedMaterialization: WorkspaceMaterialization = {
      ...materialization,
      worktrees: [
        {
          ...materialization.worktrees[0]!,
          baseCommitOid: "51fcd9c2767e66b0d456ca8153eb9c9314097a93",
          gitState: {
            headCommitOid: "51fcd9c2767e66b0d456ca8153eb9c9314097a93",
            originUrl: "git@gitlab.example.com:platform/senzu.git",
          },
        },
      ],
      graph: { status: "ready", detail: "Workspace graph refreshed." },
    };
    const effectDigest = `sha256:${"a".repeat(64)}`;
    const backupFullRef =
      "refs/wts/backups/1401ce0c2ac772dd7378f396fbf84691e70838ef";
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      repositoryAlignmentPreflight: {
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_senzu",
        repositoryLabel: "senzu",
        baseRef: "develop",
        remoteFullRef: "refs/remotes/upstream/develop",
        currentCommitOid: "1401ce0c2ac772dd7378f396fbf84691e70838ef",
        targetCommitOid: "51fcd9c2767e66b0d456ca8153eb9c9314097a93",
        backupFullRef,
        effectDigest,
      },
      repositoryAlignment: {
        workspaceId: persisted.workspaceId,
        repositoryId: "repo_senzu",
        repositoryLabel: "senzu",
        previousBaseCommitOid: "1401ce0c2ac772dd7378f396fbf84691e70838ef",
        baseCommitOid: "51fcd9c2767e66b0d456ca8153eb9c9314097a93",
        backupFullRef,
        graphRefreshed: true,
        graphDetail: "Workspace graph refreshed.",
        materialization: updatedMaterialization,
      },
    });
    fake.syncWorkspaceRepository.mockRejectedValue(
      new WorkspaceClientError(
        "The tracking branch has different history. Review alignment before moving this clean worktree.",
        { code: "repository_sync_diverged", retryable: false },
      ),
    );

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await user.click(
      screen.getByRole("button", { name: "Sync senzu with upstream develop" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Align senzu with upstream/develop?",
    });
    expect(within(dialog).getByText("1401ce0c2ac772dd7378f396fbf84691e70838ef")).toBeVisible();
    expect(within(dialog).getByText("51fcd9c2767e66b0d456ca8153eb9c9314097a93")).toBeVisible();
    expect(within(dialog).getByText(backupFullRef)).toBeVisible();
    const align = within(dialog).getByRole("button", {
      name: "Align and rebuild graph",
    });
    expect(align).toBeDisabled();
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /I understand that WTS will change the worktree commit/i,
      }),
    );
    await user.click(align);

    expect(fake.preflightWorkspaceRepositoryAlignment).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_senzu",
    );
    expect(fake.alignWorkspaceRepository).toHaveBeenCalledWith(
      persisted.workspaceId,
      "repo_senzu",
      effectDigest,
    );
    expect(await screen.findByText("51fcd9c2")).toBeVisible();
    expect(screen.getByText(/Backup saved and graph refreshed/i)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Open senzu on GitLab" }),
    ).toBeVisible();
  });

  it("reports a Terminal handoff without claiming that the CLI is running", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    const cliRequest = deferred<WorkspaceCliLaunchResult>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
    });
    fake.openWorkspaceCli.mockReturnValue(cliRequest.promise);

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await screen.findByRole("button", { name: "Workspace actions" });
    await selectWorkspaceAction(user, "Open with…");

    const panel = await screen.findByRole("dialog", {
      name: "Open workspace",
    });
    await user.click(within(panel).getByRole("button", { name: "Open Codex" }));

    expect(panel).toHaveAttribute("aria-busy", "true");
    expect(
      within(panel).getByRole("button", { name: "Open Codex" }),
    ).toBeDisabled();
    expect(
      within(panel).getByRole("button", { name: "Open OpenCode" }),
    ).toBeDisabled();
    expect(within(panel).getByRole("status")).toHaveTextContent(
      /Opening Codex in Terminal/i,
    );

    await act(async () => {
      cliRequest.resolve({
        workspaceId: persisted.workspaceId,
        provider: "codex",
        terminal: "terminal",
        accepted: true,
        workspaceDisplayPath: persisted.workspaceDisplayPath,
      });
      await cliRequest.promise;
    });

    expect(panel).not.toHaveAttribute("aria-busy");
    expect(
      within(panel).getByRole("button", { name: "Open OpenCode" }),
    ).toBeEnabled();
    expect(within(panel).getByRole("status")).toHaveTextContent(
      /Codex opened in Terminal/i,
    );
    expect(within(panel).queryByText("Running")).not.toBeInTheDocument();
    expect(fake.runWorkspaceAgent).not.toHaveBeenCalled();
    expect(fake.getWorkspaceEvidence).not.toHaveBeenCalled();
  });

  it("prefers an installed Warp app for a workspace CLI handoff", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const setup = setupFixture();
    setup.integrations = setup.integrations.map((integration) =>
      integration.id === "warp"
        ? {
            ...integration,
            status: "ready",
            installation: "detected",
            setup: "notRequired",
            detail:
              "Warp.app is installed and can accept workspace CLI handoffs.",
            diagnosticCode: undefined,
            blockingFor: [],
          }
        : integration,
    );
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: assistantMaterialization(persisted),
      setup,
    });
    fake.openWorkspaceCli.mockResolvedValue({
      workspaceId: persisted.workspaceId,
      provider: "codex",
      terminal: "warp",
      accepted: true,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await selectWorkspaceAction(user, "Open with…");
    const panel = await screen.findByRole("dialog", {
      name: "Open workspace",
    });
    expect(
      within(panel).getByRole("button", { name: "Warp" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.click(within(panel).getByRole("button", { name: "Open Codex" }));

    expect(fake.openWorkspaceCli).toHaveBeenCalledWith(
      persisted.workspaceId,
      "codex",
      "warp",
    );
    expect(within(panel).getByRole("status")).toHaveTextContent(
      /Codex opened in Warp/i,
    );
  });

  it("builds the workspace graph from Verification without cluttering CLI", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const missing = assistantMaterialization(persisted, "notStarted");
    const ready = assistantMaterialization(persisted, "ready");
    const notStartedEvidence = assistantEvidence(persisted, []);
    notStartedEvidence.graphManifest = {
      ...notStartedEvidence.graphManifest,
      status: "notStarted",
      graphDisplayPath: null,
      graphSha256: null,
      indexedAtUnixMs: null,
      indexedRepositories: [],
      detail: "Workspace graph has not been built.",
    };
    const readyEvidence = assistantEvidence(persisted, []);
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: missing,
      evidence: notStartedEvidence,
    });
    fake.getWorkspaceMaterialization
      .mockResolvedValueOnce(missing)
      .mockResolvedValue(ready);
    fake.getWorkspaceEvidence
      .mockResolvedValueOnce(notStartedEvidence)
      .mockResolvedValue(readyEvidence);
    fake.indexWorkspaceGraph.mockResolvedValue({
      workspaceId: persisted.workspaceId,
      status: "ready",
      graphDisplayPath: `${persisted.workspaceDisplayPath}/graphify-out/graph.json`,
      detail: "Workspace-only structural graph built.",
      durationMs: 184,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await screen.findByRole("button", { name: "Workspace actions" });
    expect(screen.queryByRole("tab", { name: "CLI" })).not.toBeInTheDocument();

    await selectWorkspaceView(user, "Verification");
    await user.click(
      await screen.findByRole("button", { name: "Build graph" }),
    );
    expect(fake.indexWorkspaceGraph).toHaveBeenCalledWith(
      persisted.workspaceId,
    );
    expect(
      await screen.findByRole("button", {
        name: "Prepare verification brief",
      }),
    ).toBeEnabled();
  });

  it("requires a fresh removal review after a destructive request fails", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const removalPreflight = {
      workspaceId: persisted.workspaceId,
      kind: "savedPlan" as const,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      ready: true,
      effectDigest: "sha256:remove-draft",
      worktrees: [],
      generatedPaths: [],
      protectedPaths: [],
      retainedBranches: [],
      blockers: [],
      warnings: [],
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      removalPreflight,
    });
    fake.removeWorkspace.mockRejectedValueOnce(
      new Error("Workspace state changed after review."),
    );

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove workspace…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Remove the PLATFORM-42 plan/i,
    });
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /Remove this saved plan/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Remove workspace" }),
    );

    expect(
      await within(dialog).findByText("Workspace state changed after review."),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Remove workspace" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Check again" }),
    ).toBeEnabled();

    await user.click(
      within(dialog).getByRole("button", { name: "Check again" }),
    );
    const confirmation = await within(dialog).findByRole("checkbox", {
      name: /Remove this saved plan/i,
    });
    expect(confirmation).not.toBeChecked();
    expect(
      within(dialog).getByRole("button", { name: "Remove workspace" }),
    ).toBeDisabled();
    expect(fake.preflightWorkspaceRemoval).toHaveBeenCalledTimes(2);
    expect(fake.removeWorkspace).toHaveBeenCalledOnce();
  });

  it("discards an in-flight preflight after switching workspaces", async () => {
    const user = userEvent.setup();
    const first = workspaceFixture();
    const second = workspaceFixture({
      workspaceId: "ws_02_SECOND",
      intent: { type: "jira", issueKey: "AUTH-778" },
      title: "Second local plan",
      workspaceLeaf: "auth-778-2b71",
      workspaceDisplayPath: "~/cd/auth-778-2b71",
    });
    let resolvePreflight!: (value: WorkspacePreflight) => void;
    const pendingPreflight = new Promise<WorkspacePreflight>((resolve) => {
      resolvePreflight = resolve;
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([first, second]),
    });
    fake.preflightWorkspace.mockReturnValue(pendingPreflight);

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review setup" }),
    );
    await user.click(screen.getByRole("button", { name: /Spaces/i }));
    await user.click(screen.getByRole("button", { name: /Open AUTH-778/i }));

    await act(async () => {
      resolvePreflight({
        workspaceId: first.workspaceId,
        workspaceDisplayPath: first.workspaceDisplayPath,
        codeWorkspaceDisplayPath: `${first.workspaceDisplayPath}/wts.code-workspace`,
        branchName: "wts/platform-42-7fd1cafe",
        ready: true,
        effectDigest: "sha256:stale-ui-result",
        repositories: [],
        blockers: [],
        warnings: [],
        graph: { status: "notStarted", detail: "Not started." },
      });
      await pendingPreflight;
    });

    expect(
      screen.getByRole("heading", { name: /Second local plan/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole("table", { name: "Workspace creation effects" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review setup" })).toBeVisible();
  });

  it("shows a first-plan empty state from an empty Rust registry", async () => {
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });

    render(<LocalWorkspace client={fake.client} />);

    expect(
      await screen.findByRole("heading", {
        name: "No local workspaces found",
      }),
    ).toBeVisible();
    expect(screen.getByText(/Create the first local plan/i)).toBeVisible();
    expect(
      screen.queryByRole("note", { name: /Workspace summary/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Open PAY-/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps a 30-workspace portfolio cheap to scan, filter, and search", async () => {
    const user = userEvent.setup();
    const plans = Array.from({ length: 30 }, (_, index) =>
      workspaceFixture({
        workspaceId: `ws_scale_${index}`,
        intent: { type: "jira", issueKey: `LOAD-${index + 1}` },
        title: `Scale plan ${index + 1}`,
        workflow: {
          state: index % 2 === 0 ? "review" : "ready",
          revision: 1,
          updatedAtUnixMs: 1_721_776_500_000 + index,
        },
        lifecycle:
          index % 2 === 0
            ? {
                materializationState: "materialized",
                worktreeCount: 2,
                observedAtUnixMs: 1_721_776_500_000 + index,
              }
            : {
                materializationState: "notMaterialized",
                worktreeCount: 0,
                observedAtUnixMs: 1_721_776_500_000 + index,
              },
      }),
    );
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(plans),
    });

    render(<LocalWorkspace client={fake.client} />);

    expect(
      await screen.findByRole("heading", { name: "Spaces" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: /Open LOAD-1: Scale plan 1/i }),
    ).toBeVisible();
    expect(
      screen.getAllByText("Last known · 2 worktrees created"),
    ).toHaveLength(15);
    expect(
      screen.queryByRole("region", { name: "Workspace focus" }),
    ).not.toBeInTheDocument();
    expect(fake.listWorkspaces).toHaveBeenCalledTimes(1);
    expect(fake.getWorkspaceMaterialization).not.toHaveBeenCalled();
    expect(fake.indexWorkspaceGraph).not.toHaveBeenCalled();
    expect(fake.runWorkspaceAgent).not.toHaveBeenCalled();
    expect(fake.listWorkspaceTestRuns).not.toHaveBeenCalled();
    expect(fake.runWorkspaceTestJourney).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /All workspaces/i }),
    );
    await user.click(screen.getByRole("menuitem", { name: /Review/i }));
    expect(screen.getAllByRole("button", { name: /Open LOAD-\d+: /i })).toHaveLength(
      15,
    );

    await user.click(screen.getByRole("button", { name: "Search spaces" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search local workspaces" }),
      "LOAD-29",
    );
    expect(
      screen.getByRole("button", { name: /Open LOAD-29: Scale plan 29/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Open LOAD-2: Scale plan 2/i }),
    ).not.toBeInTheDocument();
    expect(fake.getWorkspaceMaterialization).not.toHaveBeenCalled();
    expect(fake.listWorkspaceTestRuns).not.toHaveBeenCalled();
  });

  it("sorts by persisted update time and searches provider and repository facts", async () => {
    const user = userEvent.setup();
    const older = workspaceFixture({
      workspaceId: "ws_older",
      intent: { type: "jira", issueKey: "SORT-1" },
      title: "Older checkout plan",
      updatedAtUnixMs: 1_721_776_400_000,
    });
    const newer = workspaceFixture({
      workspaceId: "ws_newer",
      intent: { type: "jira", issueKey: "SORT-2" },
      title: "Newer analytics plan",
      preferredProvider: "hermes",
      repositories: [
        {
          requestId: "repo_analytics",
          repositoryId: "repo_analytics",
          label: "analytics-engine",
          baseRef: "release/candidate",
          worktreeLeaf: "analytics-engine",
        },
      ],
      updatedAtUnixMs: 1_721_776_900_000,
    });
    const catalog = repositoryCatalogFixture();
    catalog.repositories.push({
      id: "repo_analytics",
      label: "analytics-engine",
      checkoutLeaf: "analytics-engine",
      displayPath: "~/projects/data-platform/analytics-engine",
      originUrl: "git@gitlab.example.com:devx/analytics-engine.git",
      defaultBranch: {
        name: "main",
        fullRef: "refs/heads/main",
        commitOid: "1123456789abcdef0123456789abcdef01234567",
      },
      availableBranches: [
        {
          name: "release/candidate",
          fullRef: "refs/remotes/origin/release/candidate",
          commitOid: "2123456789abcdef0123456789abcdef01234567",
          remote: true,
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([older, newer]),
      repositories: catalog,
    });

    render(<LocalWorkspace client={fake.client} />);
    const board = await screen.findByLabelText("Local workspace board");
    expect(
      within(board)
        .getAllByRole("button", { name: /Open SORT-/i })
        .map((card) => card.getAttribute("aria-label")),
    ).toEqual([
      "Open SORT-2: Newer analytics plan details",
      "Open SORT-1: Older checkout plan details",
    ]);

    await user.click(screen.getByRole("button", { name: "Search spaces" }));
    const searchbox = screen.getByRole("searchbox", {
      name: "Search local workspaces",
    });
    for (const query of [
      "Hermes",
      "analytics-engine",
      "release candidate GitLab",
      "data-platform",
    ]) {
      await user.clear(searchbox);
      await user.type(searchbox, query);
      expect(
        screen.getByRole("button", { name: /Open SORT-2/i }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /Open SORT-1/i }),
      ).not.toBeInTheDocument();
    }
  });

  it("keeps last-known materialization truthful while current details load", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 2,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });
    fake.getWorkspaceMaterialization.mockReturnValue(
      new Promise<WorkspaceMaterialization | null>(() => undefined),
    );

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );

    const refresh = await screen.findByRole("status", {
      name: "Refreshing workspace status",
    });
    expect(within(refresh).getByText("Refreshing")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Repository requests" }),
    ).toBeVisible();
    expect(screen.queryByText("LOCAL STATUS")).not.toBeInTheDocument();
    expect(screen.queryByText("Recorded")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Turn this saved plan into isolated worktrees"),
    ).not.toBeInTheDocument();
  });

  it("reopens cached workspace facts immediately while refreshing in the background", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 1,
        observedAtUnixMs: 1_721_776_500_000,
      },
    });
    const materialization = assistantMaterialization(persisted);
    const backgroundRefresh = deferred<WorkspaceMaterialization | null>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
    });
    fake.getWorkspaceMaterialization
      .mockResolvedValueOnce(materialization)
      .mockReturnValueOnce(backgroundRefresh.promise);

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await screen.findByRole("button", { name: "Workspace actions" });

    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );

    expect(screen.getByLabelText("Workspace facts")).toBeVisible();
    expect(
      screen.getByRole("status", { name: "Refreshing workspace status" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", {
        name: /Checking .* from the last observation/i,
      }),
    ).not.toBeInTheDocument();

    await act(async () => {
      backgroundRefresh.resolve(materialization);
      await backgroundRefresh.promise;
    });
  });

  it("shows a registry error and retries through the same client", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.listWorkspaces
      .mockRejectedValueOnce(new Error("registry file is locked"))
      .mockResolvedValueOnce(workspaceListFixture());

    render(<LocalWorkspace client={fake.client} />);

    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByRole("heading", {
        name: "Couldn’t open the workspace registry",
      }),
    ).toBeVisible();
    expect(within(alert).getByText("registry file is locked")).toBeVisible();

    await user.click(
      within(alert.parentElement!).getByRole("button", {
        name: /Retry connection/i,
      }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "No local workspaces found",
      }),
    ).toBeVisible();
    expect(fake.listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("uses a listed deep-linked workspace without fetching it again", async () => {
    const persisted = workspaceFixture({
      workspaceId: "ws_listed_deep_link",
      intent: { type: "jira", issueKey: "AUTH-778" },
      title: "Listed deep-link plan",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });

    render(
      <LocalWorkspace
        client={fake.client}
        initialView="workbench"
        initialWorkspaceId={persisted.workspaceId}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Repository requests" }),
    ).toBeVisible();
    expect(screen.getAllByText("Listed deep-link plan").length).toBeGreaterThan(
      0,
    );
    expect(fake.getWorkspace).not.toHaveBeenCalled();
  });

  it("shows linked work items in the workspace overview", async () => {
    const persisted = workspaceFixture({
      workspaceId: "ws_link_later",
      intent: { type: "repositorySet", label: "Define requirements" },
      title: "Define requirements before Jira",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });

    render(
      <LocalWorkspace
        client={fake.client}
        initialView="workbench"
        initialWorkspaceId={persisted.workspaceId}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Linked Jira issues" }),
    ).toBeVisible();
    expect(fake.listWorkspaceWorkItemLinks).toHaveBeenCalledWith(
      persisted.workspaceId,
    );
    expect(screen.getByRole("button", { name: "Add Jira" })).toBeVisible();
  });

  it.each(["failed", "mismatched"] as const)(
    "keeps the saved workspace board available when a deep lookup is %s",
    async (result) => {
      const user = userEvent.setup();
      const listed = workspaceFixture({
        workspaceId: "ws_saved_plan",
        intent: { type: "jira", issueKey: "SAVE-42" },
        title: "Saved registry plan",
      });
      const mismatched = workspaceFixture({
        workspaceId: "ws_wrong_plan",
        intent: { type: "jira", issueKey: "WRONG-9" },
        title: "Wrong returned plan",
      });
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture([listed]),
      });
      if (result === "failed") {
        fake.getWorkspace.mockRejectedValue(
          new Error("linked workspace was removed"),
        );
      } else {
        fake.getWorkspace.mockResolvedValue(mismatched);
      }

      render(
        <LocalWorkspace
          client={fake.client}
          initialView="workbench"
          initialWorkspaceId="ws_requested_plan"
        />,
      );

      const alert = await screen.findByRole("alert");
      const recovery = alert.parentElement;
      expect(recovery).not.toBeNull();
      expect(
        within(alert).getByRole("heading", {
          name: "Couldn’t open linked workspace",
        }),
      ).toBeVisible();
      expect(
        within(recovery!).getByRole("button", { name: /Retry workspace/i }),
      ).toBeVisible();
      expect(
        within(recovery!).getByRole("button", { name: /New workspace/i }),
      ).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Repository requests" }),
      ).not.toBeInTheDocument();

      await user.click(
        within(recovery!).getByRole("button", { name: "Spaces" }),
      );

      expect(
        await screen.findByRole("button", {
          name: /Open SAVE-42: Saved registry plan/i,
        }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /Open WRONG-9/i }),
      ).not.toBeInTheDocument();
      expect(fake.listWorkspaces).toHaveBeenCalledOnce();
      expect(fake.getWorkspace).toHaveBeenCalledWith("ws_requested_plan");
    },
  );

  it("retries only the failed deep lookup and opens the exact workspace", async () => {
    const user = userEvent.setup();
    const requested = workspaceFixture({
      workspaceId: "ws_retry_deep_link",
      intent: { type: "jira", issueKey: "RETRY-7" },
      title: "Recovered linked plan",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.getWorkspace
      .mockRejectedValueOnce(new Error("workspace lookup timed out"))
      .mockResolvedValueOnce(requested);

    render(
      <LocalWorkspace
        client={fake.client}
        initialView="workbench"
        initialWorkspaceId={requested.workspaceId}
      />,
    );

    const alert = await screen.findByRole("alert");
    const recovery = alert.parentElement;
    expect(recovery).not.toBeNull();
    await user.click(
      within(recovery!).getByRole("button", { name: /Retry workspace/i }),
    );

    expect(
      await screen.findByRole("heading", { name: "Repository requests" }),
    ).toBeVisible();
    expect(screen.getAllByText("Recovered linked plan").length).toBeGreaterThan(
      0,
    );
    expect(fake.listWorkspaces).toHaveBeenCalledOnce();
    expect(fake.getWorkspace).toHaveBeenCalledTimes(2);
  });

  it("ignores a pending deep lookup after the user opens another workspace", async () => {
    const user = userEvent.setup();
    const requested = workspaceFixture({
      workspaceId: "ws_late_deep_link",
      intent: { type: "jira", issueKey: "LATE-9" },
      title: "Late linked plan",
    });
    const saved = workspaceFixture({
      workspaceId: "ws_user_selected",
      intent: { type: "jira", issueKey: "KEEP-2" },
      title: "User-selected plan",
    });
    const lookup = deferred<ReturnType<typeof workspaceFixture>>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([saved]),
    });
    fake.getWorkspace.mockReturnValue(lookup.promise);

    render(
      <LocalWorkspace
        client={fake.client}
        initialView="workbench"
        initialWorkspaceId={requested.workspaceId}
      />,
    );

    const recoveryHeading = await screen.findByRole("heading", {
      name: "Opening linked workspace",
    });
    const recovery = recoveryHeading.closest("[role='status']");
    expect(recovery).not.toBeNull();
    await user.click(
      within(recovery!.parentElement!).getByRole("button", {
        name: "Spaces",
      }),
    );
    const savedCard = await screen.findByRole("button", {
      name: /Open KEEP-2: User-selected plan/i,
    });
    await waitFor(() => expect(savedCard).toHaveFocus());
    await user.click(savedCard);

    await act(async () => {
      lookup.resolve(requested);
      await lookup.promise;
    });

    expect(
      screen.getByRole("heading", {
        name: /User-selected plan/,
      }),
    ).toBeVisible();
    expect(screen.queryByText("KEEP-2")).not.toBeInTheDocument();
    expect(screen.queryByText("Late linked plan")).not.toBeInTheDocument();
    expect(fake.getWorkspace).toHaveBeenCalledOnce();
  });

  it("does not resolve an initial deep link again after removing it", async () => {
    const user = userEvent.setup();
    const linked = workspaceFixture({
      workspaceId: "ws_remove_deep_link",
      intent: { type: "jira", issueKey: "DONE-8" },
      title: "Completed linked plan",
    });
    const removalPreflight = {
      workspaceId: linked.workspaceId,
      kind: "savedPlan" as const,
      workspaceDisplayPath: linked.workspaceDisplayPath,
      ready: true,
      effectDigest: "sha256:remove-linked-plan",
      worktrees: [],
      generatedPaths: [],
      protectedPaths: [],
      retainedBranches: [],
      blockers: [],
      warnings: [],
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([linked]),
      removalPreflight,
      remove: {
        workspaceId: linked.workspaceId,
        replayed: false,
        removedWorktreeCount: 0,
        retainedBranches: [],
        removedGeneratedPaths: [],
      },
    });

    render(
      <LocalWorkspace
        client={fake.client}
        initialView="workbench"
        initialWorkspaceId={linked.workspaceId}
      />,
    );

    await screen.findByRole("heading", { name: "Repository requests" });
    await user.click(screen.getByRole("button", { name: "Workspace actions" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Remove workspace…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Remove the DONE-8 plan?",
    });
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: /Remove this saved plan from WTS/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Remove workspace" }),
    );

    expect(
      await screen.findByRole("heading", {
        name: "No local workspaces found",
      }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("status").slice(-1)[0],
    ).toHaveTextContent("DONE-8 removed");
    expect(fake.getWorkspace).not.toHaveBeenCalled();
  });

  it("shows trusted repository names and remotes while choosing issue and repository-set sources", async () => {
    const user = userEvent.setup();
    const catalogRequest = deferred<RepositoryCatalog>();
    const catalog: RepositoryCatalog = {
      repositoryRootDisplayPath: "~/repos",
      repositories: [
        {
          id: "repo_checkout",
          label: "checkout-api",
          checkoutLeaf: "checkout-service",
          displayPath: "~/repos/checkout-service",
          originUrl: "git@gitlab.example.com:acme/checkout-api.git",
          defaultBranch: {
            name: "develop",
            fullRef: "refs/remotes/origin/develop",
            commitOid: "a".repeat(40),
          },
          availableBranches: [
            {
              name: "develop",
              fullRef: "refs/remotes/origin/develop",
              commitOid: "a".repeat(40),
              remote: true,
            },
          ],
        },
      ],
      skippedEntries: 0,
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      repositoryBaseOpen: {
        repositoryId: "repo_checkout",
        forge: "gitlab",
        host: "gitlab.example.com",
        baseRef: "develop",
        commitOid: "a".repeat(40),
        accepted: true,
      },
    });
    fake.listRepositories.mockReturnValueOnce(catalogRequest.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", { name: /^Repositories/i }),
    );
    expect(
      within(dialog).getByRole("combobox", { name: "Repository to add" }),
    ).toBeDisabled();

    await act(async () => catalogRequest.resolve(catalog));
    const repositoryPicker = within(dialog).getByRole("combobox", {
      name: "Repository to add",
    });
    await waitFor(() => expect(repositoryPicker).toBeEnabled());
    fireEvent.change(repositoryPicker, { target: { value: "repo_checkout" } });
    await user.click(
      within(dialog).getByRole("button", { name: "Add repository" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    );
    expect(
      within(dialog).getByRole("combobox", {
        name: "Base branch for checkout-api [repo_checkout]",
      }),
    ).toHaveValue("develop");

    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await waitFor(() =>
      expect(fake.analyzeWorkspaceRuntime).toHaveBeenCalledWith({
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "develop",
          },
        ],
      }),
    );
  });

  it("offers to clone a Jira upstream when no local repository matches", async () => {
    const user = userEvent.setup();
    const clonedRepository = {
      id: "repo_jellyfish",
      label: "jellyfish",
      checkoutLeaf: "jellyfish",
      displayPath: "~/cd/jellyfish",
      originUrl: "https://github.com/acme/jellyfish.git",
      defaultBranch: {
        name: "main",
        fullRef: "refs/remotes/origin/main",
        commitOid: "a".repeat(40),
      },
      availableBranches: [
        {
          name: "main",
          fullRef: "refs/remotes/origin/main",
          commitOid: "a".repeat(40),
          remote: true,
        },
      ],
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      repositories: {
        repositoryRootDisplayPath: "~/cd",
        repositories: [],
        skippedEntries: 0,
      },
      repositoryClone: {
        repository: clonedRepository,
        repositoryRootDisplayPath: "~/cd",
        reusedExisting: false,
      },
    });
    fake.importJiraIssue.mockResolvedValue({
      issueKey: "OPS-42",
      summary: "Repair jellyfish polling",
      content:
        "Upstream repository: https://github.com/acme/jellyfish.git",
      suggestedRepositories: [],
      repositoryRecommendations: [],
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Jira issue key or URL" }),
      "OPS-42",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    expect(
      await within(dialog).findByText("https://github.com/acme/jellyfish.git"),
    ).toBeVisible();
    expect(within(dialog).getByText("Upstream found")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Clone jellyfish from its Jira upstream",
      }),
    );

    expect(fake.cloneRepository).toHaveBeenCalledWith({
      remoteUrl: "https://github.com/acme/jellyfish.git",
    });
    expect(await within(dialog).findByText("Base main")).toBeVisible();
    expect(
      within(dialog).getByText(
        "Cloned jellyfish into the trusted repository root.",
      ),
    ).toBeVisible();
  });

  it("lets the user select a discovered local remote when an issue has no Git remote", async () => {
    const user = userEvent.setup();
    const localRepository = {
      id: "repo_jellyfish",
      label: "jellyfish",
      checkoutLeaf: "jellyfish",
      displayPath: "~/cd/jellyfish",
      originUrl: "git@github.com:acme/jellyfish.git",
      defaultBranch: {
        name: "main",
        fullRef: "refs/remotes/origin/main",
        commitOid: "a".repeat(40),
      },
      availableBranches: [],
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      repositories: {
        repositoryRootDisplayPath: "~/cd",
        repositories: [localRepository],
        skippedEntries: 0,
      },
    });
    fake.importJiraIssue.mockResolvedValue({
      issueKey: "PLATFORM-42",
      summary: "Review the service",
      content: "https://jira.example.test/browse/PLATFORM-42",
      suggestedRepositories: ["PLATFORM-42"],
      repositoryRecommendations: [],
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await user.click(screen.getAllByRole("button", { name: /New workspace/i })[0]!);
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", { name: "Jira issue key or URL" }),
      "PLATFORM-42",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    expect(within(dialog).queryByText("Upstream found")).not.toBeInTheDocument();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "Show all local remotes for PLATFORM-42",
      }),
    );
    const remotePicker = within(dialog).getByRole("combobox", {
      name: "Select local remote for PLATFORM-42",
    });
    fireEvent.change(remotePicker, { target: { value: localRepository.id } });

    expect(await within(dialog).findByText("Base main")).toBeVisible();
    expect(
      within(dialog).getByText("git@github.com:acme/jellyfish.git"),
    ).toBeVisible();
  });

  it("saves an exact Jira request and opens the opaque returned workspace", async () => {
    const user = userEvent.setup();
    const saved = workspaceFixture({
      workspaceId: "ws_01J_OPAQUE_7KQ9",
      intent: { type: "jira", issueKey: "BILL-204" },
      title: "Canonical plan returned by Rust",
      workspaceLeaf: "bill-204-3af8",
      workspaceDisplayPath: "~/cd/bill-204-3af8",
      repositories: [
        {
          requestId: "repo_api_one",
          label: "api-one",
          baseRef: "main",
          worktreeLeaf: "api-one",
        },
        {
          requestId: "repo_lib_two",
          label: "lib-two",
          baseRef: "main",
          worktreeLeaf: "lib-two",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      create: { workspace: saved, replayed: false },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    const dialog = await reachJiraManifest(
      user,
      "BILL-204",
      "api-one, lib-two",
    );

    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );

    expect(await within(dialog).findByText("BILL-204 is saved")).toBeVisible();
    expect(fake.createWorkspace).toHaveBeenCalledOnce();
    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: { type: "jira", issueKey: "BILL-204" },
        title: "Work on BILL-204",
        preferredProvider: "codex",
        repositories: [
          { label: "api-one", baseRef: "main" },
          { label: "lib-two", baseRef: "main" },
        ],
      },
      expect.any(String),
    );

    await user.click(
      within(dialog).getByRole("button", { name: /Open saved plan/i }),
    );

    expect(
      screen.getAllByText("Canonical plan returned by Rust").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("~/cd/bill-204-3af8").length).toBeGreaterThan(0);
    expect(screen.getAllByText("api-one").length).toBeGreaterThan(0);
    expect(fake.getWorkspace).not.toHaveBeenCalled();
  });

  it("adds an explicit editable planning home to the saved workspace plan", async () => {
    const user = userEvent.setup();
    const saved = workspaceFixture({
      workspaceId: "ws_planning_home",
      intent: { type: "jira", issueKey: "PLAN-42" },
      title: "Work on PLAN-42",
      planning: { folder: "plans", format: "notes" },
      repositories: [
        {
          requestId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      create: { workspace: saved, replayed: false },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    const dialog = await reachJiraManifest(user, "PLAN-42", "checkout-api");

    await user.click(
      within(dialog).getByRole("radio", {
        name: /Create a starter kit/i,
      }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Planning folder" }),
      { target: { value: "plans" } },
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Planning starter" }),
      { target: { value: "notes" } },
    );
    expect(within(dialog).getByText(/plans\/ · notes kit/i)).toBeVisible();

    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );
    await within(dialog).findByText("PLAN-42 is saved");

    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: { type: "jira", issueKey: "PLAN-42" },
        title: "Work on PLAN-42",
        preferredProvider: "codex",
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "main",
          },
        ],
        planning: { folder: "plans", format: "notes" },
      },
      expect.any(String),
    );
  });

  it("enables repository selection after trusted discovery finishes", async () => {
    const user = userEvent.setup();
    const catalogRequest = deferred<RepositoryCatalog>();
    const catalog = repositoryCatalogFixture();
    const checkout = catalog.repositories[0]!;
    checkout.defaultBranch = checkout.availableBranches!.find(
      (branch) => branch.name === "develop",
    )!;
    checkout.availableBranches = checkout.availableBranches!.filter(
      (branch) => branch.name === "develop",
    );
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.listRepositories.mockReturnValueOnce(catalogRequest.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", { name: /^Repositories/i }),
    );
    expect(
      within(dialog).getByRole("combobox", { name: "Repository to add" }),
    ).toBeDisabled();

    await act(async () => catalogRequest.resolve(catalog));
    const repositoryPicker = within(dialog).getByRole("combobox", {
      name: "Repository to add",
    });
    await waitFor(() => expect(repositoryPicker).toBeEnabled());
    fireEvent.change(repositoryPicker, { target: { value: "repo_checkout" } });
    await user.click(
      within(dialog).getByRole("button", { name: "Add repository" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    );
    expect(
      within(dialog).getByRole("combobox", {
        name: "Base branch for checkout-api [repo_checkout]",
      }),
    ).toHaveValue("develop");

    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await waitFor(() =>
      expect(fake.analyzeWorkspaceRuntime).toHaveBeenCalledWith({
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "develop",
          },
        ],
      }),
    );
  });

  it("preserves reviewed branch choices when revisiting the source step", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await waitFor(() => expect(fake.listRepositories).toHaveBeenCalledOnce());
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", { name: /^Repositories/i }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Repository to add" }),
      { target: { value: "repo_checkout" } },
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add repository" }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Review repositories/i,
      }),
    );

    const baseBranch = within(dialog).getByRole("combobox", {
      name: "Base branch for checkout-api [repo_checkout]",
    });
    fireEvent.change(baseBranch, { target: { value: "release/2026.07" } });
    expect(baseBranch).toHaveValue("release/2026.07");

    await user.click(within(dialog).getByRole("button", { name: "Source" }));
    expect(
      within(dialog).getByRole("list", {
        name: "Repositories in this workspace plan",
      }),
    ).toHaveTextContent("checkout-api");
    const revisitRepositories = within(dialog).getByRole("button", {
      name: "Repositories",
    });
    expect(revisitRepositories).toBeEnabled();
    await user.click(revisitRepositories);

    expect(
      within(dialog).getByRole("combobox", {
        name: "Base branch for checkout-api [repo_checkout]",
      }),
    ).toHaveValue("release/2026.07");
    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await waitFor(() =>
      expect(fake.analyzeWorkspaceRuntime).toHaveBeenCalledWith({
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "release/2026.07",
          },
        ],
      }),
    );
  });

  it("reviews inferred services, preserves port edits, and saves the exact runtime selection", async () => {
    const user = userEvent.setup();
    const analysis: RuntimeAnalysisResult = runtimeAnalysisFixture({
      services: [
        {
          candidateId: "candidate_checkout_api",
          serviceId: "checkout-api",
          displayName: "Checkout API",
          repositoryId: "repo_checkout",
          repositoryLabel: "checkout-api",
          commitOid: "0123456789abcdef0123456789abcdef01234567",
          workingDirectory: "apps/api",
          command: ["npm", "run", "dev"],
          dependencies: [],
          ports: [
            {
              portId: "http",
              environment: "PORT",
              preferredPort: 3_000,
              policy: "prefer",
              confidence: "declared",
              evidence: [
                {
                  repositoryId: "repo_checkout",
                  commitOid: "0123456789abcdef0123456789abcdef01234567",
                  path: "package.json",
                  detector: "package-script",
                  detail: "The dev script declares port 3000.",
                },
              ],
            },
          ],
          confidence: "corroborated",
          evidence: [
            {
              repositoryId: "repo_checkout",
              commitOid: "0123456789abcdef0123456789abcdef01234567",
              path: "apps/api/src/server.ts",
              detector: "listen-call",
              detail: "The server reads PORT before listening.",
            },
          ],
          includedByDefault: true,
        },
      ],
      graph: {
        status: "ready",
        detail: "Graph evidence corroborates the declared service.",
      },
    });
    const runtime = {
      analysisDigest: analysis.analysisDigest,
      services: [
        {
          candidateId: "candidate_checkout_api",
          ports: [
            {
              portId: "http",
              preferredPort: 4_100,
              policy: "fixed" as const,
            },
          ],
        },
      ],
    };
    const saved = workspaceFixture({
      workspaceId: "ws_runtime_plan",
      intent: { type: "jira", issueKey: "PORT-42" },
      title: "Work on PORT-42",
      repositories: [
        {
          requestId: "repo_checkout_request",
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
      runtime,
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      runtimeAnalysis: analysis,
      create: { workspace: saved, replayed: false },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await waitFor(() => expect(fake.listRepositories).toHaveBeenCalledOnce());
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", {
        name: /Jira issue key or URL/i,
      }),
      "PORT-42",
    );
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "Repositories for this plan",
      }),
      "checkout-api",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Review repositories/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );

    expect(
      await within(dialog).findByRole("heading", {
        name: "Choose what this workspace should run",
      }),
    ).toBeVisible();
    expect(await within(dialog).findByText("npm run dev")).toBeVisible();
    expect(within(dialog).getByText("apps/api")).toBeVisible();
    expect(within(dialog).getByText("Included in this plan")).toBeVisible();
    expect(within(dialog).getByText("Can start immediately")).toBeVisible();
    expect(fake.analyzeWorkspaceRuntime).toHaveBeenCalledWith({
      repositories: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
        },
      ],
    });

    const portInput = within(dialog).getByRole("spinbutton", {
      name: "Preferred port for Checkout API http",
    });
    await user.clear(portInput);
    const portError = within(dialog).getByText(
      "Enter a port from 1024 to 65535.",
    );
    expect(portError).toBeVisible();
    expect(portInput).toHaveAttribute(
      "aria-describedby",
      portError.getAttribute("id"),
    );
    expect(
      within(dialog).getByRole("button", { name: /Review plan/i }),
    ).toBeDisabled();
    await user.type(portInput, "4100");
    fireEvent.change(
      within(dialog).getByRole("combobox", {
        name: "Port allocation policy for Checkout API http",
      }),
      { target: { value: "fixed" } },
    );

    await user.click(within(dialog).getByRole("button", { name: /^Back$/i }));
    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    expect(fake.analyzeWorkspaceRuntime).toHaveBeenCalledOnce();
    expect(
      within(dialog).getByRole("spinbutton", {
        name: "Preferred port for Checkout API http",
      }),
    ).toHaveValue(4_100);
    expect(
      within(dialog).getByRole("combobox", {
        name: "Port allocation policy for Checkout API http",
      }),
    ).toHaveValue("fixed");

    await user.click(
      within(dialog).getByRole("button", { name: /Review plan/i }),
    );
    expect(
      within(dialog).getByRole("heading", {
        name: "Does this plan match the task?",
      }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Edit repositories" }),
    ).toBeVisible();
    expect(within(dialog).getByText("http: 4100 · fixed")).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: "Edit services" }),
    );
    expect(
      within(dialog).getByRole("heading", {
        name: "Choose what this workspace should run",
      }),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: /Review plan/i }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );
    await within(dialog).findByText("PORT-42 is saved");

    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: { type: "jira", issueKey: "PORT-42" },
        title: "Work on PORT-42",
        preferredProvider: "codex",
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "main",
          },
        ],
        runtime,
      },
      expect.any(String),
    );
  });

  it("allows a zero-service plan and omits runtime authority from the save request", async () => {
    const user = userEvent.setup();
    const analysis = runtimeAnalysisFixture({
      services: [
        {
          candidateId: "candidate_checkout_api",
          serviceId: "checkout-api",
          displayName: "Checkout API",
          repositoryId: "repo_checkout",
          repositoryLabel: "checkout-api",
          commitOid: "0123456789abcdef0123456789abcdef01234567",
          workingDirectory: ".",
          command: ["npm", "start"],
          dependencies: [],
          ports: [],
          confidence: "inferred",
          evidence: [],
          includedByDefault: true,
        },
      ],
    });
    const saved = workspaceFixture({
      workspaceId: "ws_without_runtime",
      intent: { type: "jira", issueKey: "PORT-43" },
      title: "Work on PORT-43",
      repositories: [
        {
          requestId: "repo_checkout_request",
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      runtimeAnalysis: analysis,
      create: { workspace: saved, replayed: false },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    const dialog = await reachJiraManifest(user, "PORT-43", "checkout-api");
    await user.click(within(dialog).getByRole("button", { name: /^Back$/i }));
    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Include Checkout API in runtime plan",
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Review plan/i }),
    );
    expect(
      within(dialog).getByText(
        "This workspace will not start any runtime services.",
      ),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );
    await within(dialog).findByText("PORT-43 is saved");

    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: { type: "jira", issueKey: "PORT-43" },
        title: "Work on PORT-43",
        preferredProvider: "codex",
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "main",
          },
        ],
      },
      expect.any(String),
    );
  });

  it("keeps service-analysis failure optional with an explicit no-services path", async () => {
    const user = userEvent.setup();
    const saved = workspaceFixture({
      workspaceId: "ws_analysis_bypassed",
      intent: { type: "jira", issueKey: "PORT-44" },
      title: "Work on PORT-44",
      repositories: [
        {
          requestId: "repo_checkout_request",
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([saved]),
      create: { workspace: saved, replayed: false },
    });
    fake.analyzeWorkspaceRuntime.mockRejectedValueOnce(
      new Error("Exact-commit inspection timed out."),
    );

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("button", { name: /Work on PORT-44/i });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", {
        name: /Jira issue key or URL/i,
      }),
      "PORT-44",
    );
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "Repositories for this plan",
      }),
      "checkout-api",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Review repositories/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    expect(
      await within(dialog).findByText("Exact-commit inspection timed out."),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", {
        name: "Continue without services",
      }),
    );
    expect(
      within(dialog).getByText(
        "This workspace will not start any runtime services.",
      ),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );
    await within(dialog).findByText("PORT-44 is saved");

    expect(fake.createWorkspace.mock.calls[0]?.[0]).not.toHaveProperty(
      "runtime",
    );
  });

  it("copies a saved workspace setup into a new repository-set plan", async () => {
    const user = userEvent.setup();
    const source = workspaceFixture({
      preferredProvider: "vsCode",
      repositories: [
        {
          requestId: "repo_checkout",
          repositoryId: "catalog_checkout",
          label: "service",
          baseRef: "release/2026.07",
          worktreeLeaf: "service-checkout",
        },
        {
          requestId: "repo_sdk",
          repositoryId: "catalog_payments_sdk",
          label: "service",
          baseRef: "develop",
          worktreeLeaf: "service-sdk",
        },
      ],
    });
    const saved = workspaceFixture({
      workspaceId: "ws_01J_COPIED",
      intent: { type: "repositorySet", label: "Copy of PLATFORM-42" },
      title: `${source.title} · copy`,
      preferredProvider: "vsCode",
      workspaceLeaf: "copy-of-platform-42-4d2a",
      workspaceDisplayPath: "~/cd/copy-of-platform-42-4d2a",
      repositories: source.repositories,
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([source]),
      create: { workspace: saved, replayed: false },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "Spaces" });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });

    await user.click(
      within(dialog).getByRole("radio", { name: /^Saved WTS plan/i }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", {
        name: "Saved plan to copy",
      }),
      { target: { value: source.workspaceId } },
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Review copied setup/i,
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: /Review plan/i }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );

    expect(
      await within(dialog).findByText("Copy of PLATFORM-42 is saved"),
    ).toBeVisible();
    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: { type: "repositorySet", label: "Copy of PLATFORM-42" },
        title: `${source.title} · copy`,
        preferredProvider: "vsCode",
        repositories: [
          {
            repositoryId: "catalog_checkout",
            label: "service",
            baseRef: "release/2026.07",
          },
          {
            repositoryId: "catalog_payments_sdk",
            label: "service",
            baseRef: "develop",
          },
        ],
      },
      expect.any(String),
    );
  });

  it("imports a VS Code workspace file, surfaces partial matches, and saves the reviewed plan", async () => {
    const user = userEvent.setup();
    const contents = JSON.stringify({
      folders: [
        { name: "Checkout API", path: "../checkout-api" },
        { name: "Payments SDK", path: "../payments-sdk" },
        { name: "Legacy dashboard", path: "../legacy-dashboard" },
      ],
      settings: { "editor.formatOnSave": true },
      tasks: { version: "2.0.0", tasks: [] },
    });
    const imported: CodeWorkspaceFileImportResult = {
      importId: "0198-0188-payments-import",
      fileName: "payments.code-workspace",
      suggestedTitle: "Payments workspace",
      suggestedRepositorySetLabel: "VS Code · payments",
      folders: [
        {
          name: "Checkout API",
          rawPath: "../checkout-api",
          status: "matched",
          repositoryId: "repo_checkout",
          repositoryLabel: "checkout-api",
          repositoryDisplayPath: "~/repos/platform/payments/checkout-api",
          baseRef: "develop",
        },
        {
          name: "Payments SDK",
          rawPath: "../payments-sdk",
          status: "matched",
          repositoryId: "repo_payments_sdk",
          repositoryLabel: "payments-sdk",
          repositoryDisplayPath: "~/repos/payments-sdk",
          baseRef: "main",
        },
        {
          name: "Legacy dashboard",
          rawPath: "../legacy-dashboard",
          status: "missing",
          message: "No configured local repository matched this folder.",
        },
      ],
      repositories: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "develop",
        },
        {
          repositoryId: "repo_payments_sdk",
          label: "payments-sdk",
          baseRef: "main",
        },
      ],
      warnings: [
        {
          code: "folderMissing",
          message: "Legacy dashboard was not added to the plan.",
          folderName: "Legacy dashboard",
        },
        {
          code: "configurationIgnored",
          message: "Workspace settings and tasks were ignored.",
        },
      ],
    };
    const repositories = {
      repositoryRootDisplayPath: "~/repos",
      repositories: [
        {
          id: "repo_checkout",
          label: "checkout-api",
          checkoutLeaf: "checkout-api",
          displayPath: "~/repos/platform/payments/checkout-api",
          defaultBranch: {
            name: "develop",
            fullRef: "refs/heads/develop",
            commitOid: "0123456789abcdef0123456789abcdef01234567",
          },
        },
        {
          id: "repo_payments_sdk",
          label: "payments-sdk",
          checkoutLeaf: "payments-sdk",
          displayPath: "~/repos/payments-sdk",
          defaultBranch: {
            name: "main",
            fullRef: "refs/heads/main",
            commitOid: "123456789abcdef0123456789abcdef012345678",
          },
        },
        {
          id: "repo_runbooks",
          label: "payments-runbooks",
          checkoutLeaf: "runbooks",
          displayPath: "~/repos/operations/runbooks",
          defaultBranch: {
            name: "main",
            fullRef: "refs/heads/main",
            commitOid: "23456789abcdef0123456789abcdef0123456789",
          },
        },
      ],
      skippedEntries: 0,
    };
    const saved = workspaceFixture({
      workspaceId: "ws_01J_VSCODE_IMPORT",
      intent: { type: "repositorySet", label: "VS Code · payments" },
      title: "Payments workspace",
      preferredProvider: "vsCode",
      workspaceLeaf: "vs-code-payments-7fd1",
      workspaceDisplayPath: "~/cd/vs-code-payments-7fd1",
      repositories: [
        {
          requestId: "repo_checkout",
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "develop",
          worktreeLeaf: "checkout-api",
        },
        {
          requestId: "repo_sdk",
          repositoryId: "repo_payments_sdk",
          label: "payments-sdk",
          baseRef: "main",
          worktreeLeaf: "payments-sdk",
        },
        {
          requestId: "repo_runbooks",
          repositoryId: "repo_runbooks",
          label: "payments-runbooks",
          baseRef: "main",
          worktreeLeaf: "payments-runbooks",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      repositories,
      codeWorkspaceImport: imported,
      create: { workspace: saved, replayed: false },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    const fileInput = within(dialog).getByLabelText("VS Code workspace file");
    expect(fileInput).toHaveAttribute(
      "accept",
      ".code-workspace,application/json",
    );

    await user.upload(
      fileInput,
      new File([contents], "payments.code-workspace", {
        type: "application/json",
      }),
    );

    expect(
      await within(dialog).findByText(
        "Imported 2 of 3 folders from payments.code-workspace. 1 not added.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).queryByText("Developer diagnostics"),
    ).not.toBeInTheDocument();
    expect(fake.importCodeWorkspaceFile).toHaveBeenCalledWith({
      fileName: "payments.code-workspace",
      contents,
    });
    expect(within(dialog).getByText("../legacy-dashboard")).toBeVisible();
    expect(
      within(dialog).getByText("Legacy dashboard was not added to the plan."),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("heading", {
        name: "Local source → managed worktree",
      }),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /cloning happens only when you explicitly choose Clone from URL/i,
      ),
    ).toBeVisible();
    expect(fileInput).toHaveValue("");

    fireEvent.change(
      within(dialog).getByRole("combobox", {
        name: "Add local repository folder",
      }),
      { target: { value: "repo_runbooks" } },
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add folder" }),
    );
    expect(
      within(dialog).getByRole("list", {
        name: "Additional repository folders",
      }),
    ).toHaveTextContent("payments-runbooks");
    expect(
      within(dialog).getByText("~/repos/operations/runbooks"),
    ).toBeVisible();

    let downloadedWorkspace: { download: string; href: string } | undefined;
    const downloadClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function captureDownload(this: HTMLAnchorElement) {
        downloadedWorkspace = {
          download: this.download,
          href: this.href,
        };
      });
    await user.click(
      within(dialog).getByRole("button", {
        name: "Download edited copy",
      }),
    );
    expect(downloadedWorkspace?.download).toBe(
      "payments.edited.code-workspace",
    );
    const editedWorkspace = JSON.parse(
      decodeURIComponent(downloadedWorkspace!.href.split(",")[1]!),
    );
    expect(editedWorkspace).toEqual({
      folders: [
        { name: "Checkout API", path: "../checkout-api" },
        { name: "Payments SDK", path: "../payments-sdk" },
        { name: "Legacy dashboard", path: "../legacy-dashboard" },
        {
          name: "payments-runbooks",
          path: "~/repos/operations/runbooks",
        },
      ],
    });
    expect(editedWorkspace).not.toHaveProperty("settings");
    expect(
      within(dialog).getByText("Downloaded payments.edited.code-workspace."),
    ).toHaveTextContent("payments.edited.code-workspace");
    downloadClick.mockRestore();

    await user.click(
      within(dialog).getByRole("button", {
        name: /Review imported repositories/i,
      }),
    );
    expect(within(dialog).getAllByText("Matched locally")).toHaveLength(2);
    expect(within(dialog).getByText("Added from catalog")).toBeVisible();
    expect(
      within(dialog).getByText("File read · original unchanged"),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("combobox", {
        name: "Base branch for checkout-api [repo_checkout]",
      }),
    ).toHaveValue("develop");
    expect(
      within(dialog).getByText(
        /Creating the workspace later adds separate managed worktrees/i,
      ),
    ).toHaveTextContent(
      /preflight does not fetch or edit the source checkouts/i,
    );

    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: /Review plan/i }),
    );
    expect(within(dialog).getByText("VS CODE FILE")).toBeVisible();
    expect(within(dialog).getByText("payments.code-workspace")).toBeVisible();
    expect(within(dialog).getAllByText("VS Code").length).toBeGreaterThan(0);
    expect(
      within(dialog).getByText(/The source file and trusted checkouts/i),
    ).toHaveTextContent(/Saving performs no Git operation/i);
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );

    expect(
      await within(dialog).findByText("VS Code · payments is saved"),
    ).toBeVisible();
    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: {
          type: "repositorySet",
          label: "VS Code · payments",
        },
        title: "Payments workspace",
        preferredProvider: "vsCode",
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "develop",
          },
          {
            repositoryId: "repo_payments_sdk",
            label: "payments-sdk",
            baseRef: "main",
          },
          {
            repositoryId: "repo_runbooks",
            label: "payments-runbooks",
            baseRef: "main",
          },
        ],
      },
      expect.any(String),
    );
  });

  it("clones a Git URL while editing an imported VS Code workspace and adds it to the plan", async () => {
    const user = userEvent.setup();
    const imported: CodeWorkspaceFileImportResult = {
      importId: "0198-0188-clone-import",
      fileName: "infra.code-workspace",
      suggestedTitle: "Infra",
      suggestedRepositorySetLabel: "VS Code · infra",
      folders: [],
      repositories: [],
      warnings: [],
    };
    const repository = {
      id: "repo_new_api",
      label: "new-api",
      checkoutLeaf: "new-api",
      displayPath: "~/repos/new-api",
      defaultBranch: {
        name: "main",
        fullRef: "refs/heads/main",
        commitOid: "23456789abcdef0123456789abcdef0123456789",
      },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      repositories: {
        repositoryRootDisplayPath: "~/repos",
        repositories: [],
        skippedEntries: 0,
      },
      codeWorkspaceImport: imported,
      repositoryClone: {
        repository,
        repositoryRootDisplayPath: "~/repos",
        reusedExisting: false,
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    await user.upload(
      within(dialog).getByLabelText("VS Code workspace file"),
      new File(['{"folders":[]}'], "infra.code-workspace", {
        type: "application/json",
      }),
    );
    await within(dialog).findByText(
      /No trusted local repositories matched infra.code-workspace/i,
    );

    const existingTab = within(dialog).getByRole("tab", {
      name: "Existing local",
    });
    existingTab.focus();
    await user.keyboard("{ArrowRight}");
    const cloneTab = within(dialog).getByRole("tab", {
      name: "Clone from URL",
      selected: true,
    });
    expect(cloneTab).toHaveFocus();
    expect(cloneTab).toHaveAttribute("aria-controls");
    expect(
      document.getElementById(cloneTab.getAttribute("aria-controls")!),
    ).toHaveAttribute("role", "tabpanel");
    const remoteUrl = "git@gitlab.example.com:platform/new-api.git";
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "Git repository URL",
      }),
      remoteUrl,
    );
    expect(
      within(dialog).getByText("Clone target", { exact: false }),
    ).toHaveTextContent("~/repos/new-api");

    await user.click(
      within(dialog).getByRole("button", { name: "Clone and add" }),
    );
    expect(fake.cloneRepository).toHaveBeenCalledWith({
      remoteUrl,
    });
    expect(
      await within(dialog).findByText(
        "Cloned new-api and added it to this workspace plan.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("list", {
        name: "Additional repository folders",
      }),
    ).toHaveTextContent("new-api");
    expect(
      within(dialog).getByRole("button", {
        name: /Review imported repositories/i,
      }),
    ).toBeEnabled();

    await user.click(
      within(dialog).getByRole("button", {
        name: /Review imported repositories/i,
      }),
    );
    expect(within(dialog).getByText("Cloned from URL")).toBeVisible();
    expect(
      within(dialog).getByRole("combobox", {
        name: "Base branch for new-api [repo_new_api]",
      }),
    ).toHaveValue("main");
  });

  it("creates a repository plan from any Git URL and retains its branch when navigating back", async () => {
    const user = userEvent.setup();
    const catalog = repositoryCatalogFixture();
    const repository = {
      ...catalog.repositories[0]!,
      id: "repo_new_api",
      label: "new-api",
      checkoutLeaf: "new-api",
      displayPath: "~/cd/new-api",
      originUrl: "git@gitlab.example.com:platform/new-api.git",
    };
    const saved = workspaceFixture({
      workspaceId: "ws_new_api",
      intent: {
        type: "repositorySet",
        label: "Local repositories · new-api",
      },
      title: "Repositories: new-api",
      repositories: [
        {
          requestId: "repo_new_api",
          repositoryId: "repo_new_api",
          label: "new-api",
          baseRef: "develop",
          worktreeLeaf: "new-api",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      repositories: catalog,
      repositoryClone: {
        repository,
        repositoryRootDisplayPath: "~/cd",
        reusedExisting: false,
      },
      runtimeAnalysis: runtimeAnalysisFixture({ services: [] }),
      create: { workspace: saved, replayed: false },
    });
    fake.cloneRepository.mockRejectedValueOnce(
      new Error("Git authentication failed. Check your SSH agent."),
    );

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", { name: /^Repositories/i }),
    );
    expect(
      within(dialog).getByText(
        "Choose at least one local repository to continue.",
      ),
    ).toBeVisible();

    await user.click(
      within(dialog).getByRole("tab", { name: "Clone Git URL" }),
    );
    const remoteUrl = "git@gitlab.example.com:platform/new-api.git";
    await user.type(
      within(dialog).getByRole("textbox", { name: "Git repository URL" }),
      remoteUrl,
    );
    expect(within(dialog).getByText("Clone target", { exact: false }))
      .toHaveTextContent("~/cd/new-api");
    await user.click(
      within(dialog).getByRole("button", { name: "Clone and add" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Git authentication failed. Check your SSH agent.",
    );
    expect(
      within(dialog).getByRole("textbox", { name: "Git repository URL" }),
    ).toHaveValue(remoteUrl);
    await user.click(
      within(dialog).getByRole("button", { name: "Clone and add" }),
    );
    expect(fake.cloneRepository).toHaveBeenNthCalledWith(1, { remoteUrl });
    expect(fake.cloneRepository).toHaveBeenNthCalledWith(2, { remoteUrl });
    expect(
      await within(dialog).findByRole("list", {
        name: "Repositories in this workspace plan",
      }),
    ).toHaveTextContent("new-api");
    await user.click(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    );
    const branch = within(dialog).getByRole("combobox", {
      name: "Base branch for new-api [repo_new_api]",
    });
    fireEvent.change(branch, { target: { value: "develop" } });
    expect(branch).toHaveValue("develop");

    await user.click(within(dialog).getByRole("button", { name: "Back" }));
    expect(
      within(dialog).getByRole("list", {
        name: "Repositories in this workspace plan",
      }),
    ).toHaveTextContent("new-api");
    await user.click(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    );
    expect(
      within(dialog).getByRole("combobox", {
        name: "Base branch for new-api [repo_new_api]",
      }),
    ).toHaveValue("develop");
    expect(within(dialog).getByText("Local repositories · new-api"))
      .toBeVisible();

    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: /Review plan/i }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Save workspace plan/i }),
    );
    await within(dialog).findByText("Local repositories · new-api is saved");
    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: {
          type: "repositorySet",
          label: "Local repositories · new-api",
        },
        title: "Repositories: new-api",
        preferredProvider: "codex",
        repositories: [
          {
            repositoryId: "repo_new_api",
            label: "new-api",
            baseRef: "develop",
          },
        ],
      },
      expect.any(String),
    );
  });

  it("opens the selected trusted base on its Git host without including the repository", async () => {
    const user = userEvent.setup();
    const imported: CodeWorkspaceFileImportResult = {
      importId: "0198-0188-base-review",
      fileName: "infra.code-workspace",
      suggestedTitle: "Infra",
      suggestedRepositorySetLabel: "VS Code · infra",
      folders: [
        {
          name: "Checkout API",
          rawPath: "../checkout-api",
          status: "matched",
          repositoryId: "repo_checkout",
          repositoryLabel: "checkout-api",
          repositoryDisplayPath: "~/repos/platform/payments/checkout-api",
          baseRef: "develop",
        },
        {
          name: "Internal mirror",
          rawPath: "../internal-mirror",
          status: "matched",
          repositoryId: "repo_internal",
          repositoryLabel: "internal-mirror",
          repositoryDisplayPath: "~/repos/internal-mirror",
          baseRef: "main",
        },
      ],
      repositories: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          baseRef: "develop",
        },
        {
          repositoryId: "repo_internal",
          label: "internal-mirror",
          baseRef: "main",
        },
      ],
      warnings: [],
    };
    const repositoryBaseOpen = {
      repositoryId: "repo_checkout",
      forge: "gitlab" as const,
      host: "gitlab.example.test",
      baseRef: "release/2026.07",
      commitOid: "a".repeat(40),
      accepted: true,
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      codeWorkspaceImport: imported,
      repositories: {
        repositoryRootDisplayPath: "~/repos",
        repositories: [
          {
            id: "repo_checkout",
            label: "checkout-api",
            checkoutLeaf: "checkout-api",
            displayPath: "~/repos/platform/payments/checkout-api",
            originUrl: "git@gitlab.example.test:acme/checkout-api.git",
            defaultBranch: {
              name: "develop",
              fullRef: "refs/remotes/origin/develop",
              commitOid: "1".repeat(40),
            },
            availableBranches: [
              {
                name: "develop",
                fullRef: "refs/remotes/origin/develop",
                commitOid: "1".repeat(40),
                remote: true,
              },
              {
                name: "release/2026.07",
                fullRef: "refs/remotes/origin/release/2026.07",
                commitOid: "3".repeat(40),
                remote: true,
              },
            ],
          },
          {
            id: "repo_internal",
            label: "internal-mirror",
            checkoutLeaf: "internal-mirror",
            displayPath: "~/repos/internal-mirror",
            defaultBranch: {
              name: "main",
              fullRef: "refs/remotes/origin/main",
              commitOid: "2".repeat(40),
            },
          },
        ],
        skippedEntries: 0,
      },
      repositoryBaseOpen,
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    await user.upload(
      within(dialog).getByLabelText("VS Code workspace file"),
      new File(
        [
          JSON.stringify({
            folders: [{ path: "../checkout-api" }, { path: "../payments-sdk" }],
          }),
        ],
        "infra.code-workspace",
        { type: "application/json" },
      ),
    );

    await within(dialog).findByText(
      "Imported 2 repositories from infra.code-workspace.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: /Review imported repositories/i }),
    );

    const baseSelect = within(dialog).getByRole("combobox", {
      name: "Base branch for checkout-api [repo_checkout]",
    });
    expect(
      within(baseSelect).queryByRole("option", { name: /^main/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(baseSelect, { target: { value: "release/2026.07" } });
    const openBase = within(dialog).getByRole("button", {
      name: "Open checkout-api base release/2026.07 on GitLab (gitlab.example.test) in browser",
    });
    expect(openBase).toBeEnabled();
    expect(
      within(dialog).queryByRole("button", {
        name: "Cannot open internal-mirror base in browser: no trusted GitHub or GitLab origin",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "GitLab" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("checkbox", {
        name: "Include checkout-api [repo_checkout]",
      }),
    );
    expect(baseSelect).toBeDisabled();
    expect(openBase).toBeEnabled();
    const pendingOpen = deferred<typeof repositoryBaseOpen>();
    fake.openRepositoryBase.mockReturnValueOnce(pendingOpen.promise);
    await user.click(openBase);

    expect(fake.openRepositoryBase).toHaveBeenCalledWith(
      "repo_checkout",
      "release/2026.07",
    );
    expect(openBase).toHaveAccessibleName(
      "Opening checkout-api base release/2026.07 on GitLab (gitlab.example.test) in browser",
    );
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Resolving checkout-api at release/2026.07 locally, then opening GitLab",
    );
    await act(async () => {
      pendingOpen.resolve(repositoryBaseOpen);
      await pendingOpen.promise;
    });
    await waitFor(() =>
      expect(within(dialog).getByRole("status")).toHaveTextContent(
        /Browser handoff accepted for checkout-api at release\/2026\.07 \(aaaaaaaaaaaa\) on GitLab/i,
      ),
    );
    expect(dialog).not.toHaveTextContent("git@");
  });

  it("rejects an oversized VS Code workspace file before calling the client", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    await user.upload(
      within(dialog).getByLabelText("VS Code workspace file"),
      new File(["x".repeat(48 * 1024 + 1)], "oversized.code-workspace", {
        type: "application/json",
      }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "That file is larger than 48 KiB. Choose a smaller .code-workspace file.",
    );
    expect(fake.importCodeWorkspaceFile).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole("button", {
        name: /Review imported repositories/i,
      }),
    ).toBeDisabled();
  });

  it("keeps a no-match VS Code workspace import polite and non-actionable", async () => {
    const user = userEvent.setup();
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const sourceContents =
      '{"folders":[{"path":"../missing-api"}],"settings":{"secret":"never-copy-me"},"tasks":{"token":"session-secret"},"extensions":{"recommendations":["private-extension"]}}';
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      codeWorkspaceImport: {
        importId: "0198-0188-missing-import",
        fileName: "missing.code-workspace",
        suggestedTitle: "Missing workspace",
        suggestedRepositorySetLabel: "VS Code · missing",
        folders: [
          {
            name: "missing-api",
            rawPath: "../missing-api",
            status: "missing",
            message: "No local repository matched this folder.",
          },
        ],
        repositories: [],
        warnings: [
          {
            code: "folderMissing",
            message: "missing-api was not added to the plan.",
            folderName: "missing-api",
          },
        ],
        diagnostics: {
          catalog: {
            repositoryRootDisplayPath: "/Users/test/repos",
            repositoryCount: 2,
            skippedEntries: 1,
            repositories: [
              {
                label: "dashboard",
                displayPath: "/Users/test/repos/dashboard",
              },
              {
                label: "wts-ui",
                displayPath: "/Users/test/repos/wts-ui",
              },
            ],
            repositoriesTruncated: false,
          },
          folders: [
            {
              folderIndex: 0,
              status: "missing",
              reason: "noCatalogMatch",
              attempts: [
                {
                  basis: "pathBasename",
                  value: "missing-api",
                  candidateCount: 0,
                },
              ],
              candidates: [],
              candidatesTruncated: false,
              duplicateRepository: false,
            },
          ],
        },
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    await user.upload(
      within(dialog).getByLabelText("VS Code workspace file"),
      new File([sourceContents], "missing.code-workspace", {
        type: "application/json",
      }),
    );

    const status = await within(dialog).findByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent(
      "No trusted local repositories matched missing.code-workspace. Open Developer diagnostics to inspect the bounded nested scan and folder reasons.",
    );
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(dialog).getByText(/treats its folder paths as lookup hints/i),
    ).toHaveTextContent(/bounded search under your trusted repository roots/i);

    await user.click(within(dialog).getByText("Developer diagnostics"));
    expect(
      within(dialog).getByText("Nested repositories · bounded scan"),
    ).toBeVisible();
    expect(
      within(dialog).getByText("Primary trusted source root"),
    ).toBeVisible();
    expect(
      within(dialog).getByText("1 during bounded discovery"),
    ).toBeVisible();
    expect(within(dialog).getByText("0198-0188-missing-import")).toBeVisible();
    expect(within(dialog).getByText("/Users/test/repos")).toBeVisible();
    expect(within(dialog).getByText("dashboard")).toBeVisible();
    expect(
      within(dialog).getByText(
        "No discovered checkout folder or repository label matched this folder",
      ),
    ).toBeVisible();
    expect(within(dialog).getByText("noCatalogMatch")).toBeVisible();

    await user.click(
      within(dialog).getByRole("button", { name: "Copy diagnostics" }),
    );
    expect(
      within(dialog).getByRole("button", { name: "Diagnostics copied" }),
    ).toBeVisible();
    const copied = await navigator.clipboard.readText();
    const copiedPayload = JSON.parse(copied) as Record<string, unknown>;
    expect(copiedPayload).toMatchObject({
      fileName: "missing.code-workspace",
      importId: "0198-0188-missing-import",
      catalog: {
        repositoryRootDisplayPath: "/Users/test/repos",
        repositoryCount: 2,
      },
    });
    expect(copied).toContain("missing-api");
    expect(copied).not.toContain("never-copy-me");
    expect(copied).not.toContain("session-secret");
    expect(copied).not.toContain('"settings"');
    expect(copied).not.toContain('"tasks"');
    expect(copied).not.toContain('"extensions"');
    expect(copied).not.toContain("private-extension");
    expect(copied).not.toContain('"contents"');
    expect(debug).toHaveBeenCalledWith(
      "[WTS] VS Code workspace import completed",
      expect.objectContaining({
        importId: "0198-0188-missing-import",
      }),
    );
    const debugPayload = JSON.stringify(debug.mock.calls[0]?.[1]);
    expect(debugPayload).not.toContain("never-copy-me");
    expect(debugPayload).not.toContain("session-secret");
    expect(debugPayload).not.toContain("private-extension");
    debug.mockRestore();
    expect(
      within(dialog).getByRole("button", {
        name: /Review imported repositories/i,
      }),
    ).toBeDisabled();
  });

  it("shows relative suffix resolution before basename while keeping same-label identity pins distinct", async () => {
    const user = userEvent.setup();
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const firstRelativePath = "team-a/service";
    const firstPath = "/Users/test/repos/team-a/service";
    const secondPath = "/Users/test/repos/team-b/service";
    const saved = workspaceFixture({
      workspaceId: "ws_01J_SAME_LABEL",
      intent: { type: "repositorySet", label: "VS Code · same-label" },
      title: "Same label",
      preferredProvider: "vsCode",
      repositories: [
        {
          requestId: "request_team_a",
          repositoryId: "repo_team_a",
          label: "service",
          baseRef: "release/2026.07",
          worktreeLeaf: "service-team-a",
        },
        {
          requestId: "request_team_b",
          repositoryId: "repo_team_b",
          label: "service",
          baseRef: "develop",
          worktreeLeaf: "service-team-b",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      create: { workspace: saved, replayed: false },
      codeWorkspaceImport: {
        importId: "0198-0188-same-label-import",
        fileName: "same-label.code-workspace",
        suggestedTitle: "Same label",
        suggestedRepositorySetLabel: "VS Code · same-label",
        folders: [
          {
            name: "Team A service",
            rawPath: firstRelativePath,
            status: "matched",
            repositoryId: "repo_team_a",
            repositoryLabel: "service",
            repositoryDisplayPath: firstPath,
            baseRef: "main",
          },
          {
            name: "Team B service",
            rawPath: secondPath,
            status: "matched",
            repositoryId: "repo_team_b",
            repositoryLabel: "service",
            repositoryDisplayPath: secondPath,
            baseRef: "develop",
          },
        ],
        repositories: [
          {
            repositoryId: "repo_team_a",
            label: "service",
            baseRef: "main",
          },
          {
            repositoryId: "repo_team_b",
            label: "service",
            baseRef: "develop",
          },
        ],
        warnings: [],
        diagnostics: {
          catalog: {
            repositoryRootDisplayPath: "/Users/test/repos",
            repositoryCount: 2,
            skippedEntries: 0,
            repositories: [
              {
                label: "service",
                displayPath: firstPath,
              },
              {
                label: "service",
                displayPath: secondPath,
              },
            ],
            repositoriesTruncated: false,
          },
          folders: [
            {
              folderIndex: 0,
              status: "matched",
              reason: "matchedRelativePathSuffix",
              resolutionBasis: "relativePathSuffix",
              attempts: [
                {
                  basis: "relativePathSuffix",
                  value: firstRelativePath,
                  candidateCount: 1,
                },
                {
                  basis: "pathBasename",
                  value: "service",
                  candidateCount: 1,
                },
              ],
              candidates: [{ label: "service", displayPath: firstPath }],
              candidatesTruncated: false,
              duplicateRepository: false,
            },
            {
              folderIndex: 1,
              status: "matched",
              reason: "matchedExactPath",
              resolutionBasis: "absolutePath",
              attempts: [
                {
                  basis: "absolutePath",
                  value: secondPath,
                  candidateCount: 1,
                },
              ],
              candidates: [{ label: "service", displayPath: secondPath }],
              candidatesTruncated: false,
              duplicateRepository: false,
            },
          ],
        },
      },
      repositories: {
        repositoryRootDisplayPath: "/Users/test/repos",
        repositories: [
          {
            id: "repo_team_a",
            label: "service",
            checkoutLeaf: "service",
            displayPath: firstPath,
            defaultBranch: {
              name: "main",
              fullRef: "refs/heads/main",
              commitOid: "1".repeat(40),
            },
            availableBranches: [
              {
                name: "main",
                fullRef: "refs/heads/main",
                commitOid: "1".repeat(40),
                remote: false,
              },
              {
                name: "release/2026.07",
                fullRef: "refs/remotes/origin/release/2026.07",
                commitOid: "2".repeat(40),
                remote: true,
              },
            ],
          },
          {
            id: "repo_team_b",
            label: "service",
            checkoutLeaf: "service",
            displayPath: secondPath,
            defaultBranch: {
              name: "develop",
              fullRef: "refs/heads/develop",
              commitOid: "3".repeat(40),
            },
            availableBranches: [
              {
                name: "develop",
                fullRef: "refs/heads/develop",
                commitOid: "3".repeat(40),
                remote: false,
              },
            ],
          },
        ],
        skippedEntries: 0,
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    await user.upload(
      within(dialog).getByLabelText("VS Code workspace file"),
      new File(
        [
          JSON.stringify({
            folders: [{ path: firstRelativePath }, { path: secondPath }],
          }),
        ],
        "same-label.code-workspace",
        { type: "application/json" },
      ),
    );

    await within(dialog).findByText(
      "Imported 2 repositories from same-label.code-workspace.",
    );
    await user.click(within(dialog).getByText("Developer diagnostics"));
    expect(
      within(dialog).getByText(
        "Matched the relative folder path to a discovered checkout",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /relative paths remain non-authoritative lookup hints/i,
      ),
    ).toHaveTextContent(
      /never grants filesystem authority outside those roots/i,
    );
    const teamAAttempts = within(dialog).getByRole("list", {
      name: "Matching attempts for Team A service",
    });
    const orderedAttempts = within(teamAAttempts).getAllByRole("listitem");
    expect(orderedAttempts[0]).toHaveTextContent("Relative path suffix");
    expect(orderedAttempts[0]).toHaveTextContent(firstRelativePath);
    expect(orderedAttempts[1]).toHaveTextContent("Final folder name");
    expect(orderedAttempts[1]).toHaveTextContent("service");
    await user.click(
      within(dialog).getByRole("button", { name: "Copy diagnostics" }),
    );

    const copied = JSON.parse(await navigator.clipboard.readText()) as {
      folders: Array<{ repository: { repositoryId: string } }>;
    };
    expect(
      copied.folders.map((folder) => folder.repository.repositoryId),
    ).toEqual(["repo_team_a", "repo_team_b"]);
    const logged = debug.mock.calls[0]?.[1] as {
      folders: Array<{ repository: { repositoryId: string } }>;
    };
    expect(
      logged.folders.map((folder) => folder.repository.repositoryId),
    ).toEqual(["repo_team_a", "repo_team_b"]);

    expect(dialog.className).toMatch(/portalSurface/);
    const sourceBody = dialog.querySelector<HTMLElement>(
      "[data-workspace-dialog-body]",
    );
    expect(sourceBody).not.toBeNull();
    sourceBody!.scrollTop = 180;

    await user.click(
      within(dialog).getByRole("button", {
        name: /Review imported repositories/i,
      }),
    );
    const evidenceBody = dialog.querySelector<HTMLElement>(
      "[data-workspace-dialog-body]",
    );
    expect(evidenceBody).not.toBe(sourceBody);
    expect(evidenceBody).toHaveProperty("scrollTop", 0);

    const progress = within(dialog).getByRole("list", {
      name: "Workspace creation progress",
    });
    const progressSteps = within(progress).getAllByRole("listitem");
    expect(progressSteps[0]).toHaveAttribute("data-complete", "true");
    expect(progressSteps[1]).toHaveAttribute("data-active", "true");
    expect(progressSteps[1]).toHaveAttribute("aria-current", "step");
    expect(within(dialog).getByRole("button", { name: "Back" })).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    ).toBeVisible();

    const includeTeamA = within(dialog).getByRole("checkbox", {
      name: "Include service [repo_team_a]",
    });
    const includeTeamB = within(dialog).getByRole("checkbox", {
      name: "Include service [repo_team_b]",
    });
    expect(includeTeamA).toBeChecked();
    expect(includeTeamB).toBeChecked();

    await user.click(includeTeamA);
    expect(includeTeamA).not.toBeChecked();
    expect(includeTeamB).toBeChecked();
    await user.click(includeTeamA);

    const baseTeamA = within(dialog).getByRole("combobox", {
      name: "Base branch for service [repo_team_a]",
    });
    const baseTeamB = within(dialog).getByRole("combobox", {
      name: "Base branch for service [repo_team_b]",
    });
    expect(baseTeamA).toHaveValue("main");
    expect(baseTeamB).toHaveValue("develop");
    fireEvent.change(baseTeamA, { target: { value: "release/2026.07" } });
    expect(baseTeamA).toHaveValue("release/2026.07");
    expect(baseTeamB).toHaveValue("develop");

    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: /Review plan/i }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );
    expect(
      await within(dialog).findByText("VS Code · same-label is saved"),
    ).toBeVisible();
    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: {
          type: "repositorySet",
          label: "VS Code · same-label",
        },
        title: "Same label",
        preferredProvider: "vsCode",
        repositories: [
          {
            repositoryId: "repo_team_a",
            label: "service",
            baseRef: "release/2026.07",
          },
          {
            repositoryId: "repo_team_b",
            label: "service",
            baseRef: "develop",
          },
        ],
      },
      expect.any(String),
    );
    debug.mockRestore();
  });

  it("redacts URI credentials and query data from copied and logged diagnostics", async () => {
    const user = userEvent.setup();
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const sensitiveUri =
      "vscode-remote://build-user:private-password@example.test/worktree?token=query-secret#private-fragment";
    const sensitiveSafePathName =
      "ssh://name-user:name-password@example.test/repository?token=name-query-secret";
    const sensitiveMissingPathName =
      "https://missing-user:missing-password@example.test/repository?token=missing-query-secret";
    const sensitiveNonStringPathName =
      "custom+remote://number-user:number-password@example.test/repository?token=number-query-secret";
    const imported: CodeWorkspaceFileImportResult = {
      importId: "0198-0188-uri-import",
      fileName: "remote.code-workspace",
      suggestedTitle: "Remote workspace",
      suggestedRepositorySetLabel: "VS Code · remote",
      folders: [
        {
          name: "Remote repository",
          rawPath: sensitiveUri,
          status: "unsupported",
          message: "URI-based workspace folders are unsupported.",
        },
        {
          name: sensitiveSafePathName,
          rawPath: "../safe-repository",
          status: "unsupported",
          repositoryLabel: sensitiveSafePathName,
          repositoryDisplayPath: "/Users/test/repos/safe-repository",
          message: "This folder name is not supported.",
        },
        {
          name: sensitiveMissingPathName,
          rawPath: "",
          status: "unsupported",
          message: "This workspace folder does not contain a path.",
        },
        {
          name: sensitiveNonStringPathName,
          rawPath: 404 as unknown as string,
          status: "unsupported",
          message: "This workspace folder path is not a string.",
        },
      ],
      repositories: [],
      warnings: [
        {
          code: "folderUnsupported",
          message: "Remote repository was not added to the plan.",
          folderName: "Remote repository",
        },
      ],
      diagnostics: {
        catalog: {
          repositoryRootDisplayPath: "/Users/test/repos",
          repositoryCount: 1,
          skippedEntries: 0,
          repositories: [
            {
              label: "local-api",
              displayPath: "/Users/test/repos/local-api",
            },
          ],
          repositoriesTruncated: false,
        },
        folders: [
          {
            folderIndex: 0,
            status: "unsupported",
            reason: "unsupportedFolder",
            attempts: [
              {
                basis: "pathBasename",
                value: "worktree?token=query-secret#private-fragment",
                candidateCount: 0,
              },
              {
                basis: "explicitName",
                value: sensitiveUri,
                candidateCount: 0,
              },
            ],
            candidates: [],
            candidatesTruncated: false,
            duplicateRepository: false,
          },
          {
            folderIndex: 1,
            status: "unsupported",
            reason: "unsupportedFolder",
            attempts: [
              {
                basis: "explicitName",
                value: "repository?token=name-derived-query-secret",
                candidateCount: 1,
              },
            ],
            candidates: [
              {
                label: sensitiveSafePathName,
                displayPath: "/Users/test/repos/safe-repository",
              },
            ],
            candidatesTruncated: false,
            duplicateRepository: false,
          },
          {
            folderIndex: 2,
            status: "unsupported",
            reason: "unsupportedFolder",
            attempts: [
              {
                basis: "explicitName",
                value: sensitiveMissingPathName,
                candidateCount: 0,
              },
            ],
            candidates: [],
            candidatesTruncated: false,
            duplicateRepository: false,
          },
          {
            folderIndex: 3,
            status: "unsupported",
            reason: "unsupportedFolder",
            attempts: [
              {
                basis: "explicitName",
                value: "repository?token=number-derived-query-secret",
                candidateCount: 0,
              },
            ],
            candidates: [],
            candidatesTruncated: false,
            duplicateRepository: false,
          },
        ],
      },
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      codeWorkspaceImport: imported,
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    await user.upload(
      within(dialog).getByLabelText("VS Code workspace file"),
      new File(
        [
          JSON.stringify({
            folders: [
              { uri: sensitiveUri },
              { name: sensitiveSafePathName, path: "../safe-repository" },
              { name: sensitiveMissingPathName },
              { name: sensitiveNonStringPathName, path: 404 },
            ],
          }),
        ],
        "remote.code-workspace",
        { type: "application/json" },
      ),
    );

    await within(dialog).findByText(
      /No trusted local repositories matched remote.code-workspace/i,
    );
    await user.click(within(dialog).getByText("Developer diagnostics"));
    await user.click(
      within(dialog).getByRole("button", { name: "Copy diagnostics" }),
    );
    expect(
      within(dialog).getByText("Copied—review local paths before sharing."),
    ).toBeVisible();

    const copied = await navigator.clipboard.readText();
    const logged = JSON.stringify(debug.mock.calls[0]?.[1]);
    const copiedPayload = JSON.parse(copied) as {
      folders: Array<{
        name: string;
        path: string;
        repository: unknown;
        resolution: { candidates: unknown[] };
      }>;
    };
    expect(copiedPayload.folders[1]).toMatchObject({
      name: "<unsupported-uri>",
      path: "../safe-repository",
      repository: null,
      resolution: { candidates: [] },
    });
    expect(copiedPayload.folders[2]).toMatchObject({
      name: "<unsupported-uri>",
      path: "<missing-path>",
    });
    expect(copiedPayload.folders[3]).toMatchObject({
      name: "<unsupported-uri>",
      path: "<unsupported-value>",
    });
    for (const payload of [copied, logged]) {
      expect(payload).toContain("<unsupported-uri>");
      expect(payload).not.toContain("build-user");
      expect(payload).not.toContain("private-password");
      expect(payload).not.toContain("query-secret");
      expect(payload).not.toContain("private-fragment");
      expect(payload).not.toContain("token=");
      expect(payload).not.toContain("vscode-remote://");
      expect(payload).not.toContain("name-user");
      expect(payload).not.toContain("name-password");
      expect(payload).not.toContain("name-query-secret");
      expect(payload).not.toContain("missing-user");
      expect(payload).not.toContain("missing-password");
      expect(payload).not.toContain("missing-query-secret");
      expect(payload).not.toContain("number-user");
      expect(payload).not.toContain("number-password");
      expect(payload).not.toContain("number-query-secret");
      expect(payload).not.toContain("name-derived-query-secret");
      expect(payload).not.toContain("number-derived-query-secret");
    }

    const clipboardFailure = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValueOnce(new Error("Clipboard denied"));
    await user.click(
      within(dialog).getByRole("button", { name: "Diagnostics copied" }),
    );
    const copyAlert = await within(dialog).findByRole("alert");
    expect(copyAlert).toHaveAttribute("aria-live", "assertive");
    expect(copyAlert).toHaveTextContent(
      "Clipboard unavailable. Copy from this panel instead.",
    );
    clipboardFailure.mockRestore();
    debug.mockRestore();
  });

  it("ignores a stale diagnostics clipboard completion after a newer import", async () => {
    const user = userEvent.setup();
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const clipboardWrite = deferred<void>();
    const diagnosticImport = (
      importId: string,
      fileName: string,
      repositoryLabel: string,
    ): CodeWorkspaceFileImportResult => ({
      importId,
      fileName,
      suggestedTitle: repositoryLabel,
      suggestedRepositorySetLabel: `VS Code · ${repositoryLabel}`,
      folders: [
        {
          name: repositoryLabel,
          rawPath: `../${repositoryLabel}`,
          status: "matched",
          repositoryLabel,
          repositoryDisplayPath: `/Users/test/repos/${repositoryLabel}`,
          baseRef: "main",
        },
      ],
      repositories: [{ label: repositoryLabel, baseRef: "main" }],
      warnings: [],
      diagnostics: {
        catalog: {
          repositoryRootDisplayPath: "/Users/test/repos",
          repositoryCount: 2,
          skippedEntries: 0,
          repositories: [
            {
              label: "old-api",
              displayPath: "/Users/test/repos/old-api",
            },
            {
              label: "current-api",
              displayPath: "/Users/test/repos/current-api",
            },
          ],
          repositoriesTruncated: false,
        },
        folders: [
          {
            folderIndex: 0,
            status: "matched",
            reason: "matchedPathBasename",
            resolutionBasis: "pathBasename",
            attempts: [
              {
                basis: "pathBasename",
                value: repositoryLabel,
                candidateCount: 1,
              },
            ],
            candidates: [
              {
                label: repositoryLabel,
                displayPath: `/Users/test/repos/${repositoryLabel}`,
              },
            ],
            candidatesTruncated: false,
            duplicateRepository: false,
          },
        ],
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.importCodeWorkspaceFile
      .mockResolvedValueOnce(
        diagnosticImport(
          "0198-0188-old-copy-import",
          "old.code-workspace",
          "old-api",
        ),
      )
      .mockResolvedValueOnce(
        diagnosticImport(
          "0198-0188-current-copy-import",
          "current.code-workspace",
          "current-api",
        ),
      );

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    const fileInput = within(dialog).getByLabelText("VS Code workspace file");
    await user.upload(
      fileInput,
      new File(["{}"], "old.code-workspace", {
        type: "application/json",
      }),
    );
    await within(dialog).findByText(
      "Imported 1 repository from old.code-workspace.",
    );
    await user.click(within(dialog).getByText("Developer diagnostics"));
    const clipboard = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockReturnValueOnce(clipboardWrite.promise);
    await user.click(
      within(dialog).getByRole("button", { name: "Copy diagnostics" }),
    );
    expect(clipboard).toHaveBeenCalledOnce();

    await user.upload(
      fileInput,
      new File(["{}"], "current.code-workspace", {
        type: "application/json",
      }),
    );
    await within(dialog).findByText(
      "Imported 1 repository from current.code-workspace.",
    );

    await act(async () => {
      clipboardWrite.resolve();
      await clipboardWrite.promise;
    });

    expect(
      within(dialog).queryByRole("button", { name: "Diagnostics copied" }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByText("Developer diagnostics"));
    expect(
      within(dialog).getByRole("button", { name: "Copy diagnostics" }),
    ).toBeVisible();
    expect(
      within(dialog).queryByText("Copied—review local paths before sharing."),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByText("0198-0188-current-copy-import"),
    ).toBeVisible();
    clipboard.mockRestore();
    debug.mockRestore();
  });

  it("does not upload stale VS Code workspace contents when a newer file wins during reading", async () => {
    const user = userEvent.setup();
    const staleRead = deferred<string>();
    const currentContents = '{"folders":[{"path":"../current-api"}]}';
    const currentImport: CodeWorkspaceFileImportResult = {
      importId: "0198-0188-current-import",
      fileName: "current.code-workspace",
      suggestedTitle: "Current workspace",
      suggestedRepositorySetLabel: "VS Code · current",
      folders: [
        {
          name: "current-api",
          rawPath: "../current-api",
          status: "matched",
          repositoryLabel: "current-api",
          baseRef: "main",
        },
      ],
      repositories: [{ label: "current-api", baseRef: "main" }],
      warnings: [],
    };
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.importCodeWorkspaceFile.mockResolvedValue(currentImport);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    const fileInput = within(dialog).getByLabelText("VS Code workspace file");
    const staleFile = new File(["stale"], "stale.code-workspace", {
      type: "application/json",
    });
    Object.defineProperty(staleFile, "text", {
      value: () => staleRead.promise,
    });

    await user.upload(fileInput, staleFile);
    expect(
      within(dialog).getByText("Reading stale.code-workspace…"),
    ).toBeVisible();
    expect(fake.importCodeWorkspaceFile).not.toHaveBeenCalled();

    await user.upload(
      fileInput,
      new File([currentContents], "current.code-workspace", {
        type: "application/json",
      }),
    );
    expect(
      await within(dialog).findByText(
        "Imported 1 repository from current.code-workspace.",
      ),
    ).toBeVisible();
    expect(fake.importCodeWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(fake.importCodeWorkspaceFile).toHaveBeenCalledWith({
      fileName: "current.code-workspace",
      contents: currentContents,
    });

    await act(async () => {
      staleRead.resolve('{"folders":[{"path":"../stale-api"}]}');
      await staleRead.promise;
      await Promise.resolve();
    });

    expect(fake.importCodeWorkspaceFile).toHaveBeenCalledTimes(1);
    expect(
      within(dialog).getByRole("textbox", {
        name: "Workspace plan title",
      }),
    ).toHaveValue("Current workspace");
    expect(within(dialog).queryByText("stale-api")).not.toBeInTheDocument();
  });

  it("ignores a stale VS Code workspace result after a newer file is selected", async () => {
    const user = userEvent.setup();
    const staleImport = deferred<CodeWorkspaceFileImportResult>();
    const currentImport = deferred<CodeWorkspaceFileImportResult>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.importCodeWorkspaceFile
      .mockReturnValueOnce(staleImport.promise)
      .mockReturnValueOnce(currentImport.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", {
        name: /^VS Code workspace file/i,
      }),
    );
    const fileInput = within(dialog).getByLabelText("VS Code workspace file");
    await user.upload(
      fileInput,
      new File(["{}"], "old.code-workspace", {
        type: "application/json",
      }),
    );
    await waitFor(() =>
      expect(fake.importCodeWorkspaceFile).toHaveBeenCalledTimes(1),
    );
    await user.upload(
      fileInput,
      new File(["{}"], "current.code-workspace", {
        type: "application/json",
      }),
    );
    await waitFor(() =>
      expect(fake.importCodeWorkspaceFile).toHaveBeenCalledTimes(2),
    );

    await act(async () => {
      currentImport.resolve({
        importId: "0198-0188-current-import",
        fileName: "current.code-workspace",
        suggestedTitle: "Current workspace",
        suggestedRepositorySetLabel: "VS Code · current",
        folders: [
          {
            name: "current-api",
            rawPath: "../current-api",
            status: "matched",
            repositoryLabel: "current-api",
            baseRef: "main",
          },
        ],
        repositories: [{ label: "current-api", baseRef: "main" }],
        warnings: [],
      });
      await currentImport.promise;
    });
    expect(
      await within(dialog).findByText(
        "Imported 1 repository from current.code-workspace.",
      ),
    ).toBeVisible();

    await act(async () => {
      staleImport.resolve({
        importId: "0198-0188-stale-import",
        fileName: "old.code-workspace",
        suggestedTitle: "Stale workspace",
        suggestedRepositorySetLabel: "VS Code · stale",
        folders: [
          {
            name: "stale-api",
            rawPath: "../stale-api",
            status: "matched",
            repositoryLabel: "stale-api",
            baseRef: "develop",
          },
        ],
        repositories: [{ label: "stale-api", baseRef: "develop" }],
        warnings: [],
      });
      await staleImport.promise;
    });

    expect(
      within(dialog).getByRole("textbox", {
        name: "Workspace plan title",
      }),
    ).toHaveValue("Current workspace");
    expect(within(dialog).getByText("current.code-workspace")).toBeVisible();
    expect(
      within(dialog).queryByText("Stale workspace"),
    ).not.toBeInTheDocument();
    expect(within(dialog).queryByText("stale-api")).not.toBeInTheDocument();
  });

  it("rejects a mismatched Jira response without injecting its context", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.importJiraIssue.mockResolvedValue({
      issueKey: "WRONG-9",
      summary: "Wrong issue title",
      content: "wrong-api",
      suggestedRepositories: ["wrong-api"],
      repositoryRecommendations: [],
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "Jira issue key or URL",
      }),
      "RIGHT-8",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Jira returned WRONG-9 while WTS was importing RIGHT-8",
    );
    expect(
      within(dialog).getByRole("textbox", {
        name: "Repositories for this plan",
      }),
    ).toHaveValue("");
    expect(
      within(dialog).queryByText("Wrong issue title"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    ).toBeDisabled();
  });

  it("clears Jira suggestions when the key changes without clearing manual scope", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.importJiraIssue.mockResolvedValue({
      issueKey: "SCOPE-1",
      summary: "First issue",
      status: "In progress",
      content: JSON.stringify({
        fields: {
          description: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Retry checkout without creating duplicate captures.",
                  },
                ],
              },
            ],
          },
        },
      }),
      suggestedRepositories: ["suggested-api"],
      repositoryRecommendations: [
        {
          repositoryId: "repo_suggested",
          label: "suggested-api",
          confidence: 96,
          reason:
            "The imported issue references this repository's local checkout name.",
          sources: ["checkoutLeaf"],
        },
      ],
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    const reference = within(dialog).getByRole("textbox", {
      name: "Jira issue key or URL",
    });
    const repositories = within(dialog).getByRole("textbox", {
      name: "Repositories for this plan",
    });

    await user.type(reference, "SCOPE-1");
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    await waitFor(() => {
      expect(repositories).toHaveValue("suggested-api");
    });
    expect(
      within(dialog).getByRole("heading", { name: "Imported SCOPE-1" }),
    ).toBeVisible();
    expect(within(dialog).getByText("First issue")).toBeVisible();
    expect(within(dialog).getByText("In progress")).toBeVisible();
    expect(
      within(dialog).getByText(
        "Retry checkout without creating duplicate captures.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        "The imported issue references this repository's local checkout name.",
      ),
    ).toBeVisible();
    expect(within(dialog).getByText(/no LLM was used/i)).toBeVisible();

    await user.clear(reference);
    await user.type(reference, "SCOPE-2");
    expect(repositories).toHaveValue("");

    await user.type(repositories, "manual-api");
    await user.clear(reference);
    await user.type(reference, "SCOPE-3");
    expect(repositories).toHaveValue("manual-api");
  });

  it("ignores a stale Jira result after the issue reference and provider change", async () => {
    const user = userEvent.setup();
    const staleJira = deferred<JiraIssueImport>();
    const currentOpenProject = deferred<OpenProjectWorkPackageImport>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.importJiraIssue.mockReturnValue(staleJira.promise);
    fake.importOpenProjectWorkPackage.mockReturnValue(
      currentOpenProject.promise,
    );

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    const jiraReference = within(dialog).getByRole("textbox", {
      name: "Jira issue key or URL",
    });

    await user.type(jiraReference, "OLD-41");
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(fake.importJiraIssue).toHaveBeenCalledWith("OLD-41");

    await user.clear(jiraReference);
    await user.type(jiraReference, "NEW-42");
    await user.click(
      within(dialog).getByRole("radio", { name: "OpenProject" }),
    );
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "OpenProject work package",
      }),
      "#42",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    await act(async () => {
      staleJira.resolve({
        issueKey: "OLD-41",
        summary: "Stale Jira title",
        content: "stale-api",
        suggestedRepositories: ["stale-api"],
        repositoryRecommendations: [],
      });
      await staleJira.promise;
    });

    expect(
      within(dialog).getByRole("button", { name: "Importing…" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("textbox", {
        name: "Repositories for this plan",
      }),
    ).toHaveValue("");
    expect(
      within(dialog).queryByText("Stale Jira title"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText(/Imported issue context/i),
    ).not.toBeInTheDocument();

    await act(async () => {
      currentOpenProject.resolve({
        workPackageId: 42,
        displayId: "APP-42",
        subject: "Current OpenProject title",
        content: "current-api",
        suggestedRepositories: ["current-api"],
        repositoryRecommendations: [],
      });
      await currentOpenProject.promise;
    });

    expect(
      within(dialog).getByText(
        "Imported APP-42 and matched 1 local repositories.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("textbox", {
        name: "Repositories for this plan",
      }),
    ).toHaveValue("current-api");
  });

  it("keeps repository edits made during import while accepting current Jira context", async () => {
    const user = userEvent.setup();
    const jiraImport = deferred<JiraIssueImport>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.importJiraIssue.mockReturnValue(jiraImport.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "Jira issue key or URL",
      }),
      "SCOPE-7",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    const repositories = within(dialog).getByRole("textbox", {
      name: "Repositories for this plan",
    });
    await user.type(repositories, "manual-api");
    expect(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    ).toBeEnabled();

    await act(async () => {
      jiraImport.resolve({
        issueKey: "SCOPE-7",
        summary: "Imported issue title",
        content: "suggested-api",
        suggestedRepositories: ["suggested-api"],
        repositoryRecommendations: [
          {
            repositoryId: "repo_suggested",
            label: "suggested-api",
            confidence: 100,
            reason:
              "The imported issue references this repository's repository label.",
            sources: ["label"],
          },
        ],
      });
      await jiraImport.promise;
    });

    expect(repositories).toHaveValue("manual-api");
    expect(
      within(dialog).getByText(
        "Imported issue context. Kept the repositories you edited while the import was running.",
      ),
    ).toBeVisible();

    await user.click(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    );
    expect(within(dialog).getByText("Imported issue title")).toBeVisible();
    expect(within(dialog).getByText("manual-api")).toBeVisible();
    expect(within(dialog).queryByText("suggested-api")).not.toBeInTheDocument();
  });

  it("imports OpenProject context before creating a canonical workspace intent", async () => {
    const user = userEvent.setup();
    const saved = workspaceFixture({
      workspaceId: "ws_01J_OPENPROJECT",
      intent: {
        type: "openProject",
        workPackageId: 42,
        displayId: "APP-42",
      },
      title: "Keep checkout state in sync",
      workspaceLeaf: "app-42-8b7f",
      workspaceDisplayPath: "~/cd/app-42-8b7f",
      repositories: [
        {
          requestId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      create: { workspace: saved, replayed: false },
    });
    fake.importOpenProjectWorkPackage.mockResolvedValue({
      workPackageId: 42,
      displayId: "APP-42",
      subject: "Keep checkout state in sync",
      status: "In progress",
      project: "Checkout",
      content: "checkout-api",
      suggestedRepositories: ["checkout-api"],
      repositoryRecommendations: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          confidence: 100,
          reason:
            "The imported issue references this repository's repository label.",
          sources: ["label"],
        },
      ],
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    expect(
      within(
        within(dialog).getByRole("radiogroup", {
          name: "Workspace source",
        }),
      ).getAllByRole("radio"),
    ).toHaveLength(4);
    expect(
      within(dialog).getByRole("radio", { name: /^Issue/i }),
    ).toBeChecked();
    await user.click(
      within(dialog).getByRole("radio", { name: "OpenProject" }),
    );
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "OpenProject work package",
      }),
      "https://projects.example.test/work_packages/42/activity",
    );

    expect(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    ).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Import" }));
    expect(fake.importOpenProjectWorkPackage).toHaveBeenCalledWith("42");
    expect(
      await within(dialog).findByText(
        "Imported APP-42 and matched 1 local repositories.",
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("textbox", {
        name: "Repositories for this plan",
      }),
    ).toHaveValue("checkout-api");
    expect(
      within(dialog).getByRole("heading", { name: "Imported APP-42" }),
    ).toBeVisible();
    expect(
      within(dialog).getByText("Keep checkout state in sync"),
    ).toBeVisible();
    expect(within(dialog).getByText("In progress")).toBeVisible();
    expect(within(dialog).getByText("Checkout")).toBeVisible();
    expect(
      within(dialog).getByText(
        "The imported issue references this repository's repository label.",
      ),
    ).toBeVisible();

    await user.click(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    );
    expect(within(dialog).getByText("APP-42")).toBeVisible();
    expect(
      within(dialog).getByText("Keep checkout state in sync"),
    ).toBeVisible();
    await user.click(
      within(dialog).getByRole("button", { name: /Analyze services/i }),
    );
    await user.click(
      await within(dialog).findByRole("button", { name: /Review plan/i }),
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );

    expect(await within(dialog).findByText("APP-42 is saved")).toBeVisible();
    expect(fake.createWorkspace).toHaveBeenCalledWith(
      {
        intent: {
          type: "openProject",
          workPackageId: 42,
          displayId: "APP-42",
        },
        title: "Keep checkout state in sync",
        preferredProvider: "codex",
        repositories: [
          {
            repositoryId: "repo_checkout",
            label: "checkout-api",
            baseRef: "main",
          },
        ],
      },
      expect.any(String),
    );
  });

  it.each([
    ["42", "42"],
    ["#42", "42"],
    ["app-42", "APP-42"],
  ])(
    "normalizes the OpenProject reference %s before import",
    async (reference, expectedReference) => {
      const user = userEvent.setup();
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture(),
      });
      fake.importOpenProjectWorkPackage.mockResolvedValue({
        workPackageId: 42,
        displayId: "#42",
        subject: "Keep checkout state in sync",
        content: "No repository suggestion",
        suggestedRepositories: [],
        repositoryRecommendations: [],
      });

      render(<LocalWorkspace client={fake.client} />);
      await screen.findByRole("heading", {
        name: "No local workspaces found",
      });
      await user.click(
        screen.getAllByRole("button", { name: /New workspace/i })[0]!,
      );
      const dialog = screen.getByRole("dialog", { name: "New workspace" });
      await user.click(
        within(dialog).getByRole("radio", { name: "OpenProject" }),
      );
      await user.type(
        within(dialog).getByRole("textbox", {
          name: "OpenProject work package",
        }),
        reference,
      );
      await user.click(within(dialog).getByRole("button", { name: "Import" }));

      await waitFor(() => {
        expect(fake.importOpenProjectWorkPackage).toHaveBeenCalledWith(
          expectedReference,
        );
      });
    },
  );

  it("keeps OpenProject import failures in the creation dialog", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.importOpenProjectWorkPackage.mockRejectedValue(
      new Error("OpenProject authentication failed."),
    );

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", { name: "OpenProject" }),
    );
    await user.type(
      within(dialog).getByRole("textbox", {
        name: "OpenProject work package",
      }),
      "#42",
    );
    await user.click(within(dialog).getByRole("button", { name: "Import" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "OpenProject authentication failed.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Import" }),
    ).toBeEnabled();
  });

  it("stops waiting without accepting a late save and retries with the same key", async () => {
    const user = userEvent.setup();
    const lateSave = deferred<CreateWorkspaceResult>();
    const retriedSave = deferred<CreateWorkspaceResult>();
    const saved = workspaceFixture({
      workspaceId: "ws_01J_STOPPED_WAIT",
      intent: { type: "jira", issueKey: "WAIT-42" },
      title: "Work on WAIT-42",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.createWorkspace
      .mockReturnValueOnce(lateSave.promise)
      .mockReturnValueOnce(retriedSave.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    const dialog = await reachJiraManifest(user, "WAIT-42", "checkout-api");
    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );

    await user.click(
      within(dialog).getByRole("button", { name: "Stop waiting" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "the original save may still complete",
    );
    expect(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    ).toBeEnabled();

    await act(async () => {
      lateSave.resolve({ workspace: saved, replayed: false });
      await lateSave.promise;
    });
    expect(
      within(dialog).queryByText("WAIT-42 is saved"),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Retry from this dialog to reconcile it",
    );

    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );
    expect(fake.createWorkspace).toHaveBeenCalledTimes(2);
    const firstRequest = fake.createWorkspace.mock.calls[0]!;
    const retriedRequest = fake.createWorkspace.mock.calls[1]!;
    expect(firstRequest[0]).toEqual(retriedRequest[0]);
    expect(firstRequest[1]).toEqual(retriedRequest[1]);

    await act(async () => {
      retriedSave.resolve({ workspace: saved, replayed: true });
      await retriedSave.promise;
    });
    expect(await within(dialog).findByText("WAIT-42 is saved")).toBeVisible();
  });

  it("blocks dismissal during an active save and reopens cleanly after failure", async () => {
    const user = userEvent.setup();
    const save = deferred<CreateWorkspaceResult>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.createWorkspace.mockReturnValue(save.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    const dialog = await reachJiraManifest(user, "LOCK-77", "checkout-api");

    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );
    expect(within(dialog).getByText("Saving LOCK-77")).toBeVisible();
    const close = within(dialog).getByRole("button", {
      name: "Close new workspace",
    });
    expect(close).toBeDisabled();

    await user.click(close);
    await user.keyboard("{Escape}");
    expect(
      screen.getByRole("dialog", { name: "Saving workspace plan" }),
    ).toBeVisible();

    await act(async () => {
      save.reject(new Error("registry write failed"));
      await expect(save.promise).rejects.toThrow("registry write failed");
    });

    expect(
      await within(dialog).findByText("registry write failed"),
    ).toBeVisible();
    expect(close).toBeEnabled();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const reopened = screen.getByRole("dialog", { name: "New workspace" });
    expect(
      within(reopened).getByRole("textbox", {
        name: "Jira issue key or URL",
      }),
    ).toHaveValue("");
    expect(
      within(reopened).getByRole("textbox", {
        name: "Repositories for this plan",
      }),
    ).toHaveValue("");
    expect(
      within(reopened).queryByText("registry write failed"),
    ).not.toBeInTheDocument();
  });

  it("retries a failed create with the same idempotency key", async () => {
    const user = userEvent.setup();
    const saved = workspaceFixture({
      workspaceId: "ws_01J_RETRIED",
      intent: { type: "jira", issueKey: "AUTH-778" },
      title: "Work on AUTH-778",
    });
    const firstSave = deferred<CreateWorkspaceResult>();
    const retriedSave = deferred<CreateWorkspaceResult>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    fake.createWorkspace
      .mockReturnValueOnce(firstSave.promise)
      .mockReturnValueOnce(retriedSave.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    const dialog = await reachJiraManifest(
      user,
      "AUTH-778",
      "auth-api, session-store",
    );

    await user.click(
      within(dialog).getByRole("button", {
        name: /Save workspace plan/i,
      }),
    );
    await act(async () => {
      firstSave.reject(new Error("registry fsync failed"));
      await expect(firstSave.promise).rejects.toThrow("registry fsync failed");
    });
    expect(
      await within(dialog).findByText("registry fsync failed"),
    ).toBeVisible();

    await user.click(
      within(dialog).getByRole("button", { name: /Retry save/i }),
    );

    expect(fake.createWorkspace).toHaveBeenCalledTimes(2);
    const firstRequest = fake.createWorkspace.mock.calls[0]!;
    const retriedRequest = fake.createWorkspace.mock.calls[1]!;
    expect(firstRequest[0]).toEqual(retriedRequest[0]);
    expect(firstRequest[1]).toEqual(retriedRequest[1]);
    expect(firstRequest[1]).toEqual(expect.any(String));
    expect(firstRequest[1]).not.toHaveLength(0);

    await act(async () => {
      retriedSave.resolve({ workspace: saved, replayed: true });
      await retriedSave.promise;
    });
    expect(await within(dialog).findByText("AUTH-778 is saved")).toBeVisible();
  });

  it("opens Environment and integrations from chrome and health status and reruns all checks", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });
    await waitFor(() => {
      expect(fake.getSetupSnapshot).toHaveBeenCalledOnce();
      expect(fake.listRepositories).toHaveBeenCalledOnce();
    });

    await user.click(
      screen.getByRole("button", {
        name: "Open Environment and integrations",
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Environment & integrations" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Integrations" })).toBeVisible();

    await user.click(
      screen.getByRole("button", {
        name: "Close environment and integrations",
      }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Open Environment and integrations",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Verify all" }));

    await waitFor(() => {
      expect(fake.getSetupSnapshot).toHaveBeenCalledTimes(2);
      expect(fake.listRepositories).toHaveBeenCalledTimes(2);
    });
  });

  it("opens Environment and integrations with either desktop shortcut without stacking dialogs", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", {
      name: "No local workspaces found",
    });

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(
      screen.getByRole("dialog", { name: "Environment & integrations" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Close environment and integrations",
      }),
    );

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    expect(
      screen.getByRole("dialog", { name: "Environment & integrations" }),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Close environment and integrations",
      }),
    );

    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    expect(screen.getByRole("dialog", { name: "New workspace" })).toBeVisible();
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(
      screen.queryByRole("dialog", {
        name: "Environment & integrations",
      }),
    ).not.toBeInTheDocument();
  });

  it("searches and runs commands from the command palette without navigating early", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      get: persisted,
    });

    render(
      <LocalWorkspace
        client={fake.client}
        initialView="workbench"
        initialWorkspaceId={persisted.workspaceId}
      />,
    );
    await screen.findByRole("heading", { name: "Repository requests" });
    const pathBeforePalette = globalThis.location.pathname;

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const palette = screen.getByRole("dialog", { name: "Commands" });
    expect(palette).toBeVisible();
    expect(globalThis.location.pathname).toBe(pathBeforePalette);
    const commandSearch = within(palette).getByRole("textbox", {
      name: "Search workspaces and commands",
    });
    expect(commandSearch).toHaveFocus();
    await user.type(commandSearch, "verification");
    expect(
      within(palette).queryByRole("button", { name: /Spaces/i }),
    ).not.toBeInTheDocument();
    expect(
      within(palette).getByRole("button", { name: /Verification/i }),
    ).toBeVisible();
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("dialog", { name: "Commands" }),
    ).not.toBeInTheDocument();
    expect(globalThis.location.pathname).toBe(
      `/sessions/${persisted.workspaceId}/verification`,
    );
  });

  it("opens a command palette workspace result in VS Code without navigating", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      workspaceId: "ws_wts_saved",
      title: "WTS",
      lifecycle: {
        materializationState: "materialized",
        worktreeCount: 2,
        observedAtUnixMs: 1_721_776_400_000,
      },
    });
    const pathBeforePalette = globalThis.location.pathname;
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      get: persisted,
      open: {
        provider: "vsCode",
        accepted: true,
        workspaceId: persisted.workspaceId,
        codeWorkspaceDisplayPath: `${persisted.workspaceDisplayPath}/wts.code-workspace`,
      },
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "Spaces" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    const palette = screen.getByRole("dialog", { name: "Commands" });
    const commandSearch = within(palette).getByRole("textbox", {
      name: "Search workspaces and commands",
    });
    await user.type(commandSearch, "wts");
    expect(
      within(palette).getByRole("button", {
        name: /WTS.*Open in VS Code/i,
      }),
    ).toBeVisible();
    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(fake.openWorkspaceInVscode).toHaveBeenCalledWith(
        persisted.workspaceId,
      ),
    );
    expect(globalThis.location.pathname).toBe(pathBeforePalette);
    expect(
      screen.queryByRole("heading", { name: "Repository requests" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Commands" }),
    ).not.toBeInTheDocument();
  });

  it("writes the active workspace tab to an addressable URL", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      get: persisted,
    });

    render(
      <LocalWorkspace
        client={fake.client}
        initialView="workbench"
        initialWorkspaceId={persisted.workspaceId}
      />,
    );
    await screen.findByRole("heading", { name: "Repository requests" });

    await selectWorkspaceView(user, "Verification");

    expect(globalThis.location.pathname).toBe(
      `/sessions/${persisted.workspaceId}/verification`,
    );
  });

  it("uses browser-style shortcuts for backward and forward navigation", async () => {
    const fake = fakeWorkspaceClient();
    const back = vi.spyOn(globalThis.history, "back").mockImplementation(() => {});
    const forward = vi
      .spyOn(globalThis.history, "forward")
      .mockImplementation(() => {});

    try {
      render(<LocalWorkspace client={fake.client} />);
      await screen.findByRole("heading", { name: "No local workspaces found" });

      fireEvent.keyDown(window, { key: "[", metaKey: true });
      fireEvent.keyDown(window, { key: "]", metaKey: true });
      fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
      fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });

      expect(back).toHaveBeenCalledTimes(2);
      expect(forward).toHaveBeenCalledTimes(2);
    } finally {
      back.mockRestore();
      forward.mockRestore();
    }
  });

  it("uses horizontal trackpad swipes for browser history navigation", async () => {
    const fake = fakeWorkspaceClient();
    const back = vi.spyOn(globalThis.history, "back").mockImplementation(() => {});
    const forward = vi
      .spyOn(globalThis.history, "forward")
      .mockImplementation(() => {});

    try {
      const firstRender = render(<LocalWorkspace client={fake.client} />);
      await screen.findByRole("heading", { name: "No local workspaces found" });

      fireEvent.wheel(window, {
        clientX: window.innerWidth / 2,
        deltaX: -60,
        deltaY: 2,
      });
      fireEvent.wheel(window, {
        clientX: window.innerWidth / 2,
        deltaX: -60,
        deltaY: 1,
      });
      expect(back).not.toHaveBeenCalled();
      fireEvent.wheel(window, {
        clientX: window.innerWidth / 2,
        deltaX: -60,
        deltaY: 0,
      });

      expect(back).toHaveBeenCalledOnce();
      expect(forward).not.toHaveBeenCalled();
      firstRender.unmount();

      render(<LocalWorkspace client={fake.client} />);
      await screen.findByRole("heading", { name: "No local workspaces found" });

      fireEvent.wheel(window, {
        clientX: window.innerWidth - 8,
        deltaX: 80,
        deltaY: 3,
      });
      fireEvent.wheel(window, {
        clientX: window.innerWidth - 8,
        deltaX: 80,
        deltaY: 2,
      });

      expect(forward).toHaveBeenCalledOnce();
    } finally {
      back.mockRestore();
      forward.mockRestore();
    }
  });

  it("uses direct touch swipes for browser history navigation", async () => {
    const fake = fakeWorkspaceClient();
    const back = vi.spyOn(globalThis.history, "back").mockImplementation(() => {});

    try {
      render(<LocalWorkspace client={fake.client} />);
      await screen.findByRole("heading", { name: "No local workspaces found" });

      fireEvent.touchStart(window, {
        touches: [{ clientX: 24, clientY: 120 }],
      });
      fireEvent.touchMove(window, {
        touches: [{ clientX: 72, clientY: 122 }],
      });
      fireEvent.touchEnd(window, {
        changedTouches: [{ clientX: 130, clientY: 123 }],
      });

      expect(back).toHaveBeenCalledOnce();
    } finally {
      back.mockRestore();
    }
  });

  it("keeps vertical gestures and nested horizontal scrolling out of browser history", async () => {
    const fake = fakeWorkspaceClient();
    const back = vi.spyOn(globalThis.history, "back").mockImplementation(() => {});
    const forward = vi
      .spyOn(globalThis.history, "forward")
      .mockImplementation(() => {});

    try {
      render(
        <>
          <LocalWorkspace client={fake.client} />
          <div data-testid="horizontal-scroller" />
          <div data-history-swipe-block data-testid="code-review-surface" />
        </>,
      );
      await screen.findByRole("heading", { name: "No local workspaces found" });

      fireEvent.wheel(window, { deltaX: -100, deltaY: 140 });
      fireEvent.wheel(window, { deltaX: 100, deltaY: 140 });
      const scroller = screen.getByTestId("horizontal-scroller");
      Object.defineProperties(scroller, {
        clientWidth: { configurable: true, value: 200 },
        scrollLeft: { configurable: true, value: 50 },
        scrollWidth: { configurable: true, value: 500 },
      });
      fireEvent.wheel(scroller, { deltaX: -100, deltaY: 0 });
      fireEvent.wheel(screen.getByTestId("code-review-surface"), {
        clientX: window.innerWidth / 2,
        deltaX: -240,
        deltaY: 0,
      });

      expect(back).not.toHaveBeenCalled();
      expect(forward).not.toHaveBeenCalled();
    } finally {
      back.mockRestore();
      forward.mockRestore();
    }
  });

  it("restores the matching screen when browser history changes", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      get: persisted,
    });
    globalThis.history.replaceState(null, "", "/");

    try {
      render(<LocalWorkspace client={fake.client} />);
      await user.click(
        await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
      );

      expect(globalThis.location.pathname).toBe(
        `/sessions/${persisted.workspaceId}`,
      );
      expect(
        screen.getByRole("heading", { name: "Repository requests" }),
      ).toBeVisible();

      globalThis.history.pushState(null, "", "/");
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(
        await screen.findByRole("heading", { name: "Spaces" }),
      ).toBeVisible();

      globalThis.history.pushState(
        null,
        "",
        `/sessions/${persisted.workspaceId}/verification`,
      );
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(
        await screen.findByRole("tab", { name: "Verify" }),
      ).toHaveAttribute("aria-selected", "true");
    } finally {
      globalThis.history.replaceState(null, "", "/");
    }
  });

  it("leaves editable controls focused when the workspace shortcut is pressed", async () => {
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      get: persisted,
    });

    render(
      <>
        <LocalWorkspace
          client={fake.client}
          initialView="workbench"
          initialWorkspaceId={persisted.workspaceId}
        />
        <input aria-label="Inline input" />
        <textarea aria-label="Inline textarea" />
        <select aria-label="Inline select" defaultValue="one">
          <option value="one">One</option>
        </select>
        <div
          aria-label="Inline editable"
          contentEditable
          role="textbox"
          tabIndex={0}
        />
      </>,
    );
    await screen.findByRole("heading", { name: "Repository requests" });

    const editables = [
      screen.getByRole("textbox", { name: "Inline input" }),
      screen.getByRole("textbox", { name: "Inline textarea" }),
      screen.getByRole("combobox", { name: "Inline select" }),
      screen.getByRole("textbox", { name: "Inline editable" }),
    ];

    editables.forEach((editable, index) => {
      editable.focus();
      expect(editable).toHaveFocus();

      fireEvent.keyDown(editable, {
        key: "k",
        ...(index % 2 === 0 ? { metaKey: true } : { ctrlKey: true }),
      });

      expect(editable).toHaveFocus();
      expect(
        screen.getByRole("heading", { name: "Repository requests" }),
      ).toBeVisible();
    });
  });

  it("shows honest verification evidence, expands failure detail, and reruns it", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture({
      repositories: [
        {
          requestId: "repo_checkout",
          label: "checkout-api",
          baseRef: "main",
          worktreeLeaf: "checkout-api",
        },
      ],
    });
    const materialization: WorkspaceMaterialization = {
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      workspaceRecordVersion: persisted.recordVersion,
      effectDigest: "sha256:durable",
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${persisted.workspaceDisplayPath}/wts.code-workspace`,
      branchName: "wts/platform-42-durable",
      worktrees: [
        {
          repositoryId: "repo_checkout",
          label: "checkout-api",
          targetDisplayPath: `${persisted.workspaceDisplayPath}/checkout-api`,
          branchName: "wts/platform-42-durable",
          baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
        },
      ],
      graph: { status: "ready", detail: "Workspace graph ready." },
    };
    const failedEvidence = workspaceEvidenceFixture();
    const passedEvidence = workspaceEvidenceFixture({
      verificationResult: {
        ...failedEvidence.verificationResult,
        status: "passed",
        durationMs: 932,
        checks: [
          {
            ...failedEvidence.verificationResult.checks[0]!,
            status: "passed",
            exitCode: 0,
            durationMs: 932,
            detail: "All checkout unit tests passed.",
          },
        ],
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      evidence: failedEvidence,
      verificationRun: passedEvidence,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await selectWorkspaceView(user, "Verification");

    expect(
      await screen.findByRole("heading", { name: "Failed" }),
    ).toBeVisible();
    expect(screen.getByText("0 of 1 checks passed")).toBeVisible();
    expect(
      screen.getByText(/Checkout unit tests needs attention/i),
    ).toBeVisible();

    await user.click(screen.getByText("Checkout unit tests"));
    expect(
      screen.getByLabelText("Checkout unit tests result detail"),
    ).toHaveTextContent("Expected one capture, received two.");
    expect(screen.getByText("1 acceptance file pinned")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Rerun all" }));
    expect(fake.runWorkspaceVerification).toHaveBeenCalledWith(
      persisted.workspaceId,
    );
    expect(
      await screen.findByRole("heading", { name: "Passed" }),
    ).toBeVisible();
    expect(screen.getByText("1 of 1 checks passed")).toBeVisible();
  }, 10_000);

  it("does not invent verification checks when the evidence plan is empty", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const materialization: WorkspaceMaterialization = {
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      workspaceRecordVersion: persisted.recordVersion,
      effectDigest: "sha256:durable",
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${persisted.workspaceDisplayPath}/wts.code-workspace`,
      branchName: "wts/platform-42-durable",
      worktrees: [],
      graph: { status: "notStarted", detail: "Not indexed." },
    };
    const evidence = workspaceEvidenceFixture();
    const emptyEvidence = workspaceEvidenceFixture({
      graphManifest: {
        ...evidence.graphManifest,
        status: "notStarted",
        graphDisplayPath: null,
        graphSha256: null,
        indexedAtUnixMs: null,
        indexedRepositories: [],
        detail: "Workspace graph has not been built.",
      },
      verificationPlan: {
        ...evidence.verificationPlan,
        checks: [],
      },
      verificationResult: {
        ...evidence.verificationResult,
        status: "notRun",
        checks: [],
        startedAtUnixMs: null,
        completedAtUnixMs: null,
        durationMs: null,
      },
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      evidence: emptyEvidence,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await selectWorkspaceView(user, "Verification");

    expect(
      await screen.findByRole("heading", {
        name: "No runnable checks discovered",
      }),
    ).toBeVisible();
    expect(screen.getByText(/build the workspace graph/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Build graph" })).toBeEnabled();
    expect(screen.queryAllByRole("button", { name: "Run all" })).toHaveLength(
      0,
    );
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });

  it("persists a graph-informed WTS.md brief before opening the workspace agent", async () => {
    const user = userEvent.setup();
    const persisted = workspaceFixture();
    const materialization: WorkspaceMaterialization = {
      schemaVersion: 1,
      workspaceId: persisted.workspaceId,
      workspaceRecordVersion: persisted.recordVersion,
      effectDigest: "sha256:durable",
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      codeWorkspaceDisplayPath: `${persisted.workspaceDisplayPath}/wts.code-workspace`,
      branchName: "wts/platform-42-durable",
      worktrees: [],
      graph: { status: "ready", detail: "Workspace graph ready." },
    };
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
      evidence,
      open: {
        provider: "vsCode",
        accepted: true,
        workspaceId: persisted.workspaceId,
        codeWorkspaceDisplayPath: materialization.codeWorkspaceDisplayPath,
      },
    });
    fake.openWorkspaceCli.mockResolvedValue({
      workspaceId: persisted.workspaceId,
      provider: "codex",
      terminal: "terminal",
      accepted: true,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
    });
    fake.writeWorkspaceAgentBrief.mockResolvedValue({
      workspaceId: persisted.workspaceId,
      workspaceDisplayPath: persisted.workspaceDisplayPath,
      briefDisplayPath: `${persisted.workspaceDisplayPath}/WTS.md`,
    });

    render(<LocalWorkspace client={fake.client} />);
    await user.click(
      await screen.findByRole("button", { name: /Open PLATFORM-42:/i }),
    );
    await selectWorkspaceView(user, "Verification");
    await user.click(
      await screen.findByRole("button", {
        name: "Prepare verification brief",
      }),
    );

    expect(
      screen.getByRole("tab", { name: "Verify" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.queryByRole("dialog", { name: "Open workspace" }),
    ).not.toBeInTheDocument();
    const preparedTask = await screen.findByLabelText(
      "Prepared verification brief",
    );
    expect(preparedTask).toHaveTextContent(
      "Read graphify-out/graph.json from the workspace root",
    );
    expect(preparedTask).toHaveTextContent(
      "identify the actual workspace-specific user-facing entry points",
    );
    expect(preparedTask).toHaveTextContent(
      "Do not assume WTS Help, WTS Preferences",
    );
    expect(preparedTask).toHaveTextContent(
      "Do not run project commands, modify repository files",
    );
    expect(preparedTask).toHaveTextContent(
      "`wts-report --input <candidate.json>`",
    );
    await waitFor(() =>
      expect(screen.getByText("Verification brief ready")).toBeVisible(),
    );
    expect(
      screen.getByRole("button", { name: "Open Codex with brief" }),
    ).toBeEnabled();
    expect(fake.openWorkspaceCli).not.toHaveBeenCalled();
    expect(fake.openWorkspaceInVscode).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: "Open Codex with brief" }),
    );
    const cliPanel = await screen.findByRole("dialog", {
      name: "Open workspace",
    });
    expect(
      within(cliPanel).getByRole("button", {
        name: "Open workspace in VS Code",
      }),
    ).toBeVisible();
    expect(
      within(cliPanel).getByRole("button", { name: "Open Codex with WTS.md" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("list", { name: "Verification CLI handoff steps" }),
    ).not.toBeInTheDocument();
    expect(within(cliPanel).getByText(/Agents opened here read the brief/i)).toBeVisible();
    expect(fake.listWorkspaceTestRuns).not.toHaveBeenCalled();
    expect(fake.getWorkspaceTestRun).not.toHaveBeenCalled();
    expect(fake.runWorkspaceTestJourney).not.toHaveBeenCalled();
    expect(fake.indexWorkspaceGraph).not.toHaveBeenCalled();
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
    expect(fake.runWorkspaceAgent).not.toHaveBeenCalled();
    expect(fake.writeWorkspaceAgentBrief).toHaveBeenCalledWith(
      persisted.workspaceId,
      expect.stringContaining("Read WTS.md from the workspace root first."),
    );

    await user.click(
      within(cliPanel).getByRole("button", {
        name: "Open workspace in VS Code",
      }),
    );
    expect(fake.openWorkspaceInVscode).toHaveBeenCalledWith(
      persisted.workspaceId,
    );

    await user.click(
      within(cliPanel).getByRole("button", { name: "Open Codex with WTS.md" }),
    );

    expect(fake.openWorkspaceCli).toHaveBeenCalledWith(
      persisted.workspaceId,
      "codex",
      "terminal",
    );
    expect(
      screen.getByText(
        /Codex opened in Terminal\. It can read WTS\.md from the workspace root/i,
      ),
    ).toBeVisible();
  }, 10_000);
});
