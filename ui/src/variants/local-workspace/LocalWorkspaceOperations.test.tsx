import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type {
  GitlabMergeRequestInbox,
  RemoveWorkspaceResult,
  WorkspaceAgentEvidence,
  WorkspaceCliLaunchResult,
  WorkspaceMaterialization,
  WorkspacePreflight,
  WorkspaceRepositorySyncResult,
} from "../../lib/wtsClient";
import { WorkspaceClientError } from "../../lib/wtsClient";
import {
  fakeWorkspaceClient,
  repositoryCatalogFixture,
  setupFixture,
  workspaceEvidenceFixture,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import {
  selectWorkspaceView,
  selectWorkspaceAction,
  deferred,
  assistantMaterialization,
  assistantEvidence,
} from "./localWorkspaceTestHelpers";

describe("personal local workspace registry", () => {
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
        name: /^Open PLATFORM-42.* details$/i,
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
    await user.click(screen.getByRole("button", { name: /^Open AUTH-778.* details$/i }));
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open bmc-api:.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
    expect(await screen.findByRole("status", {
      name: "checkout-api merge request status",
    })).toHaveTextContent("MR form opened");
    expect(screen.queryByRole("button", { name: "Prepare MR" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Check (?:again|MR)/i })).not.toBeInTheDocument();

    const gitlabRefresh = deferred<GitlabMergeRequestInbox>();
    const requestsBeforeFocus = fake.getGitlabMergeRequests.mock.calls.length;
    fake.getGitlabMergeRequests.mockReturnValueOnce(gitlabRefresh.promise);
    act(() => window.dispatchEvent(new Event("focus")));

    expect(fake.getGitlabMergeRequests).toHaveBeenCalledTimes(requestsBeforeFocus + 1);
    expect(screen.getByRole("status", {
      name: "checkout-api merge request status",
    })).toHaveTextContent("WTS checks GitLab for the MR");
    expect(screen.queryByRole("button", { name: "Prepare MR" })).not.toBeInTheDocument();

    await act(async () => {
      gitlabRefresh.resolve({
        schemaVersion: 1,
        state: "fresh",
        mergeRequests: [{
          id: "mr-42",
          repositoryId: "repo_checkout",
          projectPath: "acme/checkout-api",
          webUrl: "https://gitlab.example.com/acme/checkout-api/-/merge_requests/42",
          iid: 42,
          title: "Validate admission",
          authorUsername: "octocat",
          sourceBranch: changeRequestDraft.sourceBranch,
          sourceHeadCommitOid: changeRequestDraft.sourceHeadCommitOid,
          targetBranch: "main",
          updatedAt: "2026-08-14T08:15:00Z",
          draft: false,
          status: "open",
        }],
        fetchedAtUnixMs: 1_776_153_300_000,
        detail: "GitLab returned the new merge request.",
      });
      await gitlabRefresh.promise;
    });

    expect(await screen.findByRole("link", {
      name: /Open checkout-api merge request !42 on GitLab/i,
    })).toHaveTextContent("MR !42 · Open");
    expect(screen.queryByRole("status", {
      name: "checkout-api merge request status",
    })).not.toBeInTheDocument();
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

  it("shows repository delivery status while GitLab checks for merge requests", async () => {
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
      activity: { changedFileCount: 0, commitsAhead: 3 },
    };
    const gitlabRequest = deferred<GitlabMergeRequestInbox>();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      persistedMaterialization: materialization,
    });
    fake.getGitlabMergeRequests.mockReturnValue(gitlabRequest.promise);

    render(<LocalWorkspace client={fake.client} />);
    await user.click(await screen.findByRole("button", {
      name: /^Open PLATFORM-42.* details$/i,
    }));

    expect(await screen.findByRole("status", {
      name: "senzu merge request status",
    })).toHaveTextContent("WTS checks GitLab");
    expect(screen.queryByRole("button", { name: "Prepare MR" })).not.toBeInTheDocument();

    await act(async () => {
      gitlabRequest.resolve({
        schemaVersion: 1,
        state: "fresh",
        mergeRequests: [],
        fetchedAtUnixMs: 1_776_153_300_000,
        detail: "GitLab found no matching merge requests.",
      });
      await gitlabRequest.promise;
    });

    expect(await screen.findByRole("button", { name: "Prepare MR" })).toBeVisible();
    expect(screen.queryByRole("status", {
      name: "senzu merge request status",
    })).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));

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
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
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
    await user.click(await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }));
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Review setup" }),
    );
    await user.click(screen.getByRole("button", { name: /Spaces/i }));
    await user.click(screen.getByRole("button", { name: /^Open AUTH-778.* details$/i }));

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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
