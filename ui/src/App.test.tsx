import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";
import type { WorkspaceClient } from "./lib/wtsClient";
import {
  fakeWorkspaceClient,
  workspaceFixture,
  workspaceListFixture,
} from "./test/workspaceClientFake";
import { App } from "./App";
import { THEME_STORAGE_KEY } from "./theme";

function renderAt(path: string, workspaceClient: WorkspaceClient) {
  return render(<App initialPath={path} workspaceClient={workspaceClient} />);
}

afterEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  document.documentElement.dataset.theme = "light";
  globalThis.history.replaceState(null, "", "/");
});

describe("unified WTS routes", () => {
  it(
    "offers a compact dark-mode switch and restores the choice",
    async () => {
      const user = userEvent.setup();
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture(),
      });
      localStorage.removeItem(THEME_STORAGE_KEY);
      document.documentElement.dataset.theme = "light";

      const firstRender = renderAt("/", fake.client);
      const switchToDark = await screen.findByRole(
        "button",
        { name: "Switch to dark mode" },
        { timeout: 5_000 },
      );
      await user.click(switchToDark);

      expect(document.documentElement).toHaveAttribute("data-theme", "dark");
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
      firstRender.unmount();

      renderAt("/", fake.client);
      expect(
        await screen.findByRole("button", { name: "Switch to light mode" }),
      ).toBeVisible();
    },
    10_000,
  );

  it("opens the persisted workspace board at the product root", async () => {
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
    });

    renderAt("/", fake.client);

    expect(
      await screen.findByRole(
        "heading",
        { name: "Spaces" },
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(
      await screen.findByRole("button", {
        name: /Open TASK-42: Orders retries/i,
      }),
    ).toBeVisible();
    expect(fake.listWorkspaces).toHaveBeenCalledOnce();
  });

  it("loads a deep link by opaque workspaceId", async () => {
    const deepLinked = workspaceFixture({
      workspaceId: "ws_01J_DEEP_LINK_9F2",
      intent: { type: "jira", issueKey: "AUTH-778" },
      title: "Refresh token race",
      workspaceLeaf: "auth-778-a91d",
      workspaceDisplayPath: "~/cd/auth-778-a91d",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      get: deepLinked,
    });

    renderAt("/sessions/ws_01J_DEEP_LINK_9F2", fake.client);

    expect(
      await screen.findByRole(
        "heading",
        { name: "Repository requests" },
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(
      screen.getAllByText("Refresh token race").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("~/cd/auth-778-a91d").length).toBeGreaterThan(0);
    expect(fake.getWorkspace).toHaveBeenCalledOnce();
    expect(fake.getWorkspace).toHaveBeenCalledWith(
      "ws_01J_DEEP_LINK_9F2",
    );
  });

  it("restores Verification from its canonical deep link", async () => {
    const deepLinked = workspaceFixture({
      workspaceId: "ws_01J_DEEP_LINK_TAB",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      get: deepLinked,
    });

    renderAt("/sessions/ws_01J_DEEP_LINK_TAB/verification", fake.client);

    expect(
      await screen.findByRole("tab", {
        name: "Verify",
        selected: true,
      }),
    ).toBeVisible();
    expect(fake.getWorkspace).toHaveBeenCalledWith("ws_01J_DEEP_LINK_TAB");
  });

  it("restores Plans and Kanban from its canonical deep link", async () => {
    const deepLinked = workspaceFixture({
      workspaceId: "ws_01J_PLANNING_LINK",
    });
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      get: deepLinked,
    });
    fake.listWorkspacePlanningDocuments.mockResolvedValue({
      workspaceId: deepLinked.workspaceId,
      documents: [{ documentId: "plan", fileName: "PLAN.md" }],
    });
    fake.readWorkspacePlanningDocument.mockResolvedValue({
      workspaceId: deepLinked.workspaceId,
      documentId: "plan",
      fileName: "PLAN.md",
      contents: "# Linked plan",
      sha256: `sha256:${"a".repeat(64)}`,
    });

    renderAt(
      `/sessions/${deepLinked.workspaceId}/planning`,
      fake.client,
    );

    expect(
      await screen.findByRole("tab", {
        name: "Plans",
        selected: true,
      }, { timeout: 5_000 }),
    ).toBeVisible();
    const preview = await screen.findByRole(
      "article",
      { name: "PLAN.md preview" },
      { timeout: 5_000 },
    );
    expect(
      within(preview).getByRole("heading", { name: "Linked plan" }),
    ).toBeVisible();
    expect(preview).not.toHaveTextContent("# Linked plan");
    expect(fake.getWorkspace).toHaveBeenCalledWith(deepLinked.workspaceId);
  });

  it.each(["overview", "agent", "cli"])(
    "safely maps the legacy /%s deep link to the canonical Workspace destination",
    async (legacyDestination) => {
      const deepLinked = workspaceFixture({
        workspaceId: "ws_01J_LEGACY_ROUTE",
      });
      const fake = fakeWorkspaceClient({
        list: workspaceListFixture(),
        get: deepLinked,
      });

      renderAt(
        `/sessions/ws_01J_LEGACY_ROUTE/${legacyDestination}`,
        fake.client,
      );

      expect(
        await screen.findByRole(
          "heading",
          { name: "Repository requests" },
          { timeout: 5_000 },
        ),
      ).toBeVisible();
      expect(
        screen.queryByRole("tab", { name: "CLI", selected: true }),
      ).not.toBeInTheDocument();
      expect(globalThis.location.pathname).toBe(
        "/sessions/ws_01J_LEGACY_ROUTE",
      );
      expect(fake.getWorkspace).toHaveBeenCalledWith(
        "ws_01J_LEGACY_ROUTE",
      );
    },
  );

  it("opens the creation flow only after the injected registry connects", async () => {
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
    });
    let resolveRegistry!: (
      value: ReturnType<typeof workspaceListFixture>,
    ) => void;
    const pendingRegistry = new Promise<
      ReturnType<typeof workspaceListFixture>
    >((resolve) => {
      resolveRegistry = resolve;
    });
    fake.listWorkspaces.mockReturnValue(pendingRegistry);

    renderAt("/sessions/new", fake.client);

    expect(
      screen.queryByRole("dialog", { name: "New workspace" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Opening the local registry" }),
    ).toBeVisible();

    await act(async () => {
      resolveRegistry(workspaceListFixture());
      await pendingRegistry;
    });

    expect(
      await screen.findByRole("dialog", { name: "New workspace" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        /Start from an issue, a saved workspace, or repositories/i,
      ),
    ).toBeVisible();
    expect(fake.listWorkspaces).toHaveBeenCalledOnce();
  });

  it("opens the global time review route and joins sessions to Jira workspaces", async () => {
    const persisted = workspaceFixture();
    const fake = fakeWorkspaceClient({
      list: workspaceListFixture([persisted]),
      agentSessions: {
        schemaVersion: 1,
        sessions: [
          {
            schemaVersion: 1,
            sessionId: "session-time-route",
            workspaceId: persisted.workspaceId,
            provider: "codex",
            terminal: "warp",
            category: "implementation",
            status: "handoffAccepted",
            startedAtUnixMs: 1_721_776_400_000,
            lastHeartbeatAtUnixMs: 1_721_776_400_000,
            endedAtUnixMs: 1_721_776_400_000,
            failure: null,
          },
        ],
      },
    });

    renderAt("/time", fake.client);

    expect(
      await screen.findByRole(
        "heading",
        { name: "My time" },
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(await screen.findByText("TASK-42")).toBeVisible();
    expect(
      screen.getByText("Orders retries create duplicate captures"),
    ).toBeVisible();
    expect(screen.getByRole("navigation", { name: "WTS sections" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Spaces" })).toBeVisible();
    const topBar = screen.getByRole("button", { name: "Open Spaces" }).parentElement;
    expect(topBar?.querySelector('[data-ui="wts.home"]')).toBeInTheDocument();
    expect(fake.listAgentSessions).toHaveBeenCalledWith();
  });
});
