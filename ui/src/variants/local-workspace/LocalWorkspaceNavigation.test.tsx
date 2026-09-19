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
import type { WorkspaceMaterialization } from "../../lib/wtsClient";
import {
  fakeWorkspaceClient,
  repositoryCatalogFixture,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { selectWorkspaceView, deferred, assistantMaterialization } from "./localWorkspaceTestHelpers";

describe("personal local workspace registry", () => {
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
      screen.queryByRole("button", { name: /^Open PAY-.* details$/i }),
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
      screen.getByRole("button", { name: /^Open LOAD-1: Scale plan 1.* details$/i }),
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
    expect(screen.getAllByRole("button", { name: /^Open LOAD-.* details$/i })).toHaveLength(
      15,
    );

    await user.click(screen.getByRole("button", { name: "Search spaces" }));
    await user.type(
      screen.getByRole("searchbox", { name: "Search local workspaces" }),
      "LOAD-29",
    );
    expect(
      screen.getByRole("button", { name: /^Open LOAD-29: Scale plan 29.* details$/i }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Open LOAD-2: Scale plan 2.* details$/i }),
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
        .getAllByRole("button", { name: /^Open SORT-.* details$/i })
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
        screen.getByRole("button", { name: /^Open SORT-2.* details$/i }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /^Open SORT-1.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
    );
    await screen.findByRole("button", { name: "Workspace actions" });

    await user.click(screen.getByRole("button", { name: "Open Spaces" }));
    await user.click(
      await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
          name: /^Open SAVE-42: Saved registry plan.* details$/i,
        }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: /^Open WRONG-9.* details$/i }),
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
      name: /^Open KEEP-2: User-selected plan.* details$/i,
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
        await screen.findByRole("button", { name: /^Open PLATFORM-42.* details$/i }),
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
});
