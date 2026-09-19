import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_STORAGE_KEY, ThemeProvider } from "../../theme";
import { WORKSPACE_CARD_CLICK_STORAGE_KEY } from "./workspaceCardPreference";
import {
  SetupSheet,
  type RepositoryCatalog,
  type SetupSnapshot,
} from "./SetupSheet";

const snapshot: SetupSnapshot = {
  checkedAtUnixMs: 1_721_234_567_890,
  repositoryCount: 1,
  gitSigning: {
    ready: true,
    commitSigningEnabled: true,
    signingKeyConfigured: true,
    gpgAvailable: true,
    privateKeyAvailable: true,
    detail: "Git commit signing and the configured private key are ready.",
  },
  integrations: [
    {
      id: "git",
      category: "sourceControl",
      status: "ready",
      installation: "detected",
      setup: "notRequired",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "version",
      capabilities: ["worktreeMaterialization"],
      version: "2.49.0",
      lastProbeAt: 1_721_234_567_890,
      blockingFor: [],
    },
    {
      id: "jiraMcp",
      category: "issueTracker",
      status: "notConfigured",
      installation: "missing",
      setup: "needsDependency",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "configurationSignal",
      capabilities: ["jiraIssueImport"],
      detail: "Configure a host-managed Jira MCP endpoint.",
      diagnosticCode: "jiraMcpEndpointNotConfigured",
      lastProbeAt: 1_721_234_567_890,
      blockingFor: ["jiraIssueImport"],
    },
    {
      id: "openProject",
      category: "issueTracker",
      status: "notConfigured",
      installation: "detected",
      setup: "unverified",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "configurationSignal",
      capabilities: ["openProjectWorkPackageImport"],
      detail:
        "OpenProject URL and API token are available from the WTS environment.",
      diagnosticCode: "authenticationNotVerified",
      lastProbeAt: 1_721_234_567_890,
      blockingFor: [],
    },
    {
      id: "graphify",
      category: "knowledgeGraph",
      status: "notFound",
      installation: "missing",
      setup: "needsDependency",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "version",
      capabilities: ["graphIndexing"],
      detail: "Executable was not found on PATH.",
      diagnosticCode: "executableMissing",
      lastProbeAt: 1_721_234_567_890,
      blockingFor: ["graphIndexing"],
    },
    {
      id: "codex",
      category: "agent",
      status: "notConfigured",
      installation: "detected",
      setup: "unverified",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "version",
      capabilities: ["agentSession"],
      version: "0.42.0",
      diagnosticCode: "authenticationNotVerified",
      lastProbeAt: 1_721_234_567_890,
      blockingFor: [],
    },
    {
      id: "openCode",
      category: "agent",
      status: "notFound",
      installation: "missing",
      setup: "needsDependency",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "version",
      capabilities: ["agentSession"],
      diagnosticCode: "executableMissing",
      lastProbeAt: 1_721_234_567_890,
      blockingFor: ["openCodeLaunch"],
    },
    {
      id: "hermes",
      category: "agent",
      status: "notFound",
      installation: "missing",
      setup: "needsDependency",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "version",
      capabilities: ["agentSession"],
      diagnosticCode: "executableMissing",
      lastProbeAt: 1_721_234_567_890,
      blockingFor: ["hermesLaunch"],
    },
    {
      id: "vscode",
      category: "editor",
      status: "ready",
      installation: "detected",
      setup: "notRequired",
      runtime: "idle",
      wtsSupport: "available",
      verificationKind: "version",
      capabilities: ["workspaceLaunch"],
      version: "1.102.0",
      lastProbeAt: 1_721_234_567_890,
      blockingFor: [],
    },
  ],
  browserJourneyReadiness: {
    ready: true,
    node: {
      status: "ready",
      source: "configured",
      detail: "Configured Node executable answered a fixed version probe.",
    },
    fixedHelper: {
      status: "ready",
      source: "configured",
      detail: "Configured fixed browser helper is a regular local file.",
    },
    playwright: {
      status: "ready",
      detail: "Playwright resolves beside the fixed browser helper.",
    },
    chromium: {
      status: "ready",
      detail: "Playwright reports an installed Chromium executable.",
    },
  },
};

const repositories: RepositoryCatalog = {
  repositoryRootDisplayPath: "~/cd",
  skippedEntries: 0,
  repositories: [
    {
      id: "repo_checkout",
      label: "checkout-api-main",
      checkoutLeaf: "checkout-api",
      displayPath: "~/cd/checkout-api",
      originUrl: "github.com/acme/checkout-api",
      defaultBranch: {
        name: "main",
        fullRef: "refs/heads/main",
        commitOid: "0123456789abcdef",
      },
    },
  ],
};

afterEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
  localStorage.removeItem(WORKSPACE_CARD_CLICK_STORAGE_KEY);
  document.documentElement.dataset.theme = "light";
});

describe("SetupSheet", () => {
  it("changes and persists the application color theme from General preferences", async () => {
    const user = userEvent.setup();
    localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.dataset.theme = "light";

    render(
      <ThemeProvider>
        <SetupSheet
          loading={false}
          onOpenChange={vi.fn()}
          onRefresh={vi.fn()}
          open
          repositories={repositories}
          snapshot={snapshot}
        />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /General/ }));
    const darkTheme = screen.getByRole("radio", { name: /Dark/ });
    await user.click(screen.getByText("Dark").closest("label")!);

    expect(darkTheme).toBeChecked();
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("persists the primary workspace card action", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <SetupSheet
          loading={false}
          onOpenChange={vi.fn()}
          onRefresh={vi.fn()}
          open
          repositories={repositories}
          snapshot={snapshot}
        />
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("tab", { name: /General/ }));
    expect(screen.getByRole("radio", { name: /Details first/ })).toBeChecked();
    await user.click(screen.getByText("Workspace first").closest("label")!);

    expect(
      screen.getByRole("radio", { name: /Workspace first/ }),
    ).toBeChecked();
    expect(localStorage.getItem(WORKSPACE_CARD_CLICK_STORAGE_KEY)).toBe(
      "workspace",
    );
  });

  it("presents a dismissible environment and integrations dialog", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(
      <SetupSheet
        loading={false}
        onOpenChange={onOpenChange}
        onRefresh={vi.fn()}
        open
        repositories={repositories}
        snapshot={snapshot}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "Environment & integrations",
    });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveAttribute("aria-modal", "true");

    await user.click(
      within(dialog).getByRole("button", {
        name: "Close environment and integrations",
      }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens on integrations and distinguishes probes, auth, and WTS support", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(
      <SetupSheet
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={onRefresh}
        open
        repositories={repositories}
        snapshot={snapshot}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Environment & integrations" }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Integrations" }),
    ).toBeVisible();
    expect(screen.getByText("v2.49.0")).toBeVisible();
    const signingRow = screen.getByText("GPG commit signing").closest("li");
    expect(signingRow).not.toBeNull();
    expect(signingRow).toHaveAttribute("data-ui", "environment.git-signing");
    expect(within(signingRow!).getByText("Ready")).toBeVisible();
    await user.click(within(signingRow!).getByText("Verification details"));
    expect(within(signingRow!).getByText("All checks passed")).toBeVisible();
    expect(screen.getAllByText("Version probe passed").length).toBeGreaterThan(
      0,
    );
    const codexRow = screen.getByText("Codex").closest("li");
    expect(codexRow).not.toBeNull();
    expect(within(codexRow!).getByText("Auth not checked")).toBeVisible();
    await user.click(
      within(codexRow!).getByText("Verification details"),
    );
    expect(
      within(codexRow!).getByText("Authentication not checked"),
    ).toBeVisible();
    expect(within(codexRow!).getByText("WTS adapter ready")).toBeVisible();
    const jiraRow = screen.getByText("Jira via MCP").closest("li");
    expect(jiraRow).not.toBeNull();
    await user.click(
      within(jiraRow!).getByText("Verification details"),
    );
    expect(
      within(jiraRow!)
        .getAllByText("Configuration signal missing")
        .every((element) => element.closest("details")?.open),
    ).toBe(true);
    expect(
      within(jiraRow!).getAllByText("Jira issue import is unavailable"),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("button", { name: /connect|install|sign in/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Verify all" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("navigates to repositories and general environment details", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(
      <SetupSheet
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={onRefresh}
        open
        repositories={repositories}
        snapshot={snapshot}
      />,
    );

    await user.click(
      screen.getByRole("tab", { name: /^Repositories/ }),
    );
    expect(
      screen.getByRole("heading", { name: "Repositories" }),
    ).toBeVisible();
    expect(
      screen.getByText(
        /bounded nested scan across configured trusted local roots/i,
      ),
    ).toBeVisible();
    expect(screen.getByText("Primary trusted repository root")).toBeVisible();
    expect(screen.getByText("checkout-api-main")).toBeVisible();
    expect(
      screen.getByText("Checkout folder · checkout-api"),
    ).toBeVisible();
    expect(screen.getByText("~/cd/checkout-api")).toBeVisible();
    expect(screen.getByText("01234567")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Rescan" }));
    expect(onRefresh).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("tab", { name: /^General/ }));
    expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
    expect(screen.getByText("Ready to create worktrees")).toBeVisible();
    expect(
      screen.getByText(
        "Git is ready, and 1 local repository is available.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Read-only")).toBeVisible();
    expect(screen.getByText("Browser journeys")).toBeVisible();
    expect(screen.getByText("Node executable")).toBeVisible();
    expect(screen.getAllByText("Configured")).toHaveLength(2);
    expect(screen.getByText("Playwright module")).toBeVisible();
    expect(screen.getByText("Chromium build")).toBeVisible();
    expect(
      screen.getByText(
        "This check does not open a browser or contact the network.",
        { exact: false },
      ),
    ).toBeVisible();
  });

  it("preserves the selected section across close and reopen", async () => {
    const user = userEvent.setup();
    const props = {
      loading: false,
      onOpenChange: vi.fn(),
      onRefresh: vi.fn(),
      repositories,
      snapshot,
    };
    const { rerender } = render(<SetupSheet {...props} open />);

    await user.click(screen.getByRole("tab", { name: /^Repositories/ }));
    expect(
      screen.getByRole("tab", { name: /^Repositories/ }),
    ).toHaveAttribute("aria-selected", "true");

    rerender(<SetupSheet {...props} open={false} />);
    rerender(<SetupSheet {...props} open />);

    expect(
      screen.getByRole("tab", { name: /^Repositories/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: "Repositories" }),
    ).toBeVisible();
  });

  it("supports arrow-key navigation between environment sections", async () => {
    const user = userEvent.setup();

    render(
      <SetupSheet
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        open
        repositories={repositories}
        snapshot={snapshot}
      />,
    );

    const integrationsTab = screen.getByRole("tab", {
      name: /^Integrations/,
    });
    integrationsTab.focus();
    await user.keyboard("{ArrowUp}");

    const repositoriesTab = screen.getByRole("tab", {
      name: /^Repositories/,
    });
    expect(repositoriesTab).toHaveFocus();
    expect(repositoriesTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("heading", { name: "Repositories" }),
    ).toBeVisible();

    await user.keyboard("{Home}");
    const generalTab = screen.getByRole("tab", { name: /^General/ });
    expect(generalTab).toHaveFocus();
    expect(generalTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
  });

  it("shows which browser-journey prerequisite needs setup", async () => {
    const user = userEvent.setup();
    const unavailableSnapshot: SetupSnapshot = {
      ...snapshot,
      browserJourneyReadiness: {
        ready: false,
        node: snapshot.browserJourneyReadiness!.node,
        fixedHelper: snapshot.browserJourneyReadiness!.fixedHelper,
        playwright: {
          status: "unavailable",
          detail: "Playwright does not resolve beside the fixed browser helper.",
          diagnosticCode: "playwrightUnavailable",
        },
        chromium: {
          status: "blocked",
          detail:
            "Check skipped until Node and the fixed browser helper are available.",
          diagnosticCode: "prerequisiteUnavailable",
        },
      },
    };

    render(
      <SetupSheet
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        open
        repositories={repositories}
        snapshot={unavailableSnapshot}
      />,
    );

    await user.click(screen.getByRole("tab", { name: /^General/ }));
    expect(screen.getByText("Needs setup")).toBeVisible();
    expect(
      screen.getByText(
        "Playwright does not resolve beside the fixed browser helper.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Waiting for prerequisite")).toBeVisible();
  });

  it("does not claim readiness while the first verification is running", () => {
    render(
      <SetupSheet
        loading
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        open
      />,
    );

    expect(screen.getByText("Running checks")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Verifying…" }),
    ).toBeDisabled();
    expect(screen.getAllByText("Checking").length).toBeGreaterThan(0);
    expect(screen.queryByText("Available in this MVP")).not.toBeInTheDocument();
  });

  it("keeps stale results visible and offers an honest retry on errors", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();

    render(
      <SetupSheet
        error="The local service did not respond."
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={onRefresh}
        open
        repositories={repositories}
        snapshot={snapshot}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Previous results remain visible",
    );
    expect(screen.getByText("v2.49.0")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("verifies an externally configured Jira MCP through a WTS-owned process", async () => {
    const user = userEvent.setup();
    const onVerifyJira = vi.fn().mockResolvedValue({
      connected: true,
      serverName: "mcp-atlassian",
      serverVersion: "0.21.1",
      issueTool: "jira_get_issue",
    });
    const externalJiraSnapshot: SetupSnapshot = {
      ...snapshot,
      integrations: snapshot.integrations.map((integration) =>
        integration.id === "jiraMcp"
          ? {
              ...integration,
              installation: "detected",
              setup: "unverified",
              blockingFor: [],
              detail:
                "Jira MCP is configured and running in VS Code over stdio. WTS will start a separate process when you explicitly verify or import.",
            }
          : integration,
      ),
    };

    render(
      <SetupSheet
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onVerifyJira={onVerifyJira}
        open
        repositories={repositories}
        snapshot={externalJiraSnapshot}
      />,
    );

    const jiraRow = screen.getByText("Jira via MCP").closest("li");
    expect(jiraRow).not.toBeNull();
    const connectionNotice = within(jiraRow!)
      .getAllByText(
        "Jira MCP is configured and running in VS Code over stdio. WTS will start a separate process when you explicitly verify or import.",
      )
      .find((element) => !element.closest("details"));
    expect(connectionNotice).toBeVisible();
    expect(within(jiraRow!).getByText("WTS adapter ready")).toBeVisible();
    await user.click(
      within(jiraRow!).getByRole("button", { name: "Connect Jira" }),
    );
    expect(onVerifyJira).toHaveBeenCalledOnce();
    expect(
      await within(jiraRow!).findByText(
        "mcp-atlassian 0.21.1 exposed jira_get_issue.",
      ),
    ).toBeVisible();
    expect(
      within(jiraRow!).getByRole("button", { name: "Connected" }),
    ).toBeDisabled();
  });

  it("allows Jira to connect again after refreshed setup reports an authentication failure", async () => {
    const user = userEvent.setup();
    const onVerifyJira = vi.fn().mockResolvedValue({
      connected: true,
      serverName: "mcp-atlassian",
      serverVersion: "0.21.1",
      issueTool: "jira_get_issue",
    });
    const externalJiraSnapshot: SetupSnapshot = {
      ...snapshot,
      integrations: snapshot.integrations.map((integration) =>
        integration.id === "jiraMcp"
          ? { ...integration, installation: "detected", setup: "unverified", blockingFor: [] }
          : integration,
      ),
    };
    const props = { loading: false, onOpenChange: vi.fn(), onRefresh: vi.fn(), onVerifyJira, open: true, repositories };
    const { rerender } = render(<SetupSheet {...props} snapshot={externalJiraSnapshot} />);
    const jiraRow = () => within(screen.getByText("Jira via MCP").closest("li")!);
    await user.click(jiraRow().getByRole("button", { name: "Connect Jira" }));
    expect(await jiraRow().findByRole("button", { name: "Connected" })).toBeDisabled();

    rerender(<SetupSheet {...props} snapshot={{
      ...externalJiraSnapshot,
      checkedAtUnixMs: snapshot.checkedAtUnixMs + 1,
      integrations: externalJiraSnapshot.integrations.map((integration) =>
        integration.id === "jiraMcp"
          ? { ...integration, setup: "needsAuth", blockingFor: ["jiraIssueImport"] }
          : integration,
      ),
    }} />);
    expect(jiraRow().getByRole("button", { name: "Connect Jira" })).toBeEnabled();
    await user.click(jiraRow().getByRole("button", { name: "Connect Jira" }));
    expect(onVerifyJira).toHaveBeenCalledTimes(2);
    expect(await jiraRow().findByRole("button", { name: "Connected" })).toBeDisabled();
  });

  it("gives Jira startup failures a direct retry action", async () => {
    const user = userEvent.setup();
    const onVerifyJira = vi.fn().mockRejectedValue(
      new Error(
        "WTS could not start Jira. Start Podman, then try again.",
      ),
    );
    const externalJiraSnapshot: SetupSnapshot = {
      ...snapshot,
      integrations: snapshot.integrations.map((integration) =>
        integration.id === "jiraMcp"
          ? {
              ...integration,
              installation: "detected",
              setup: "unverified",
              blockingFor: [],
            }
          : integration,
      ),
    };

    render(
      <SetupSheet
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onVerifyJira={onVerifyJira}
        open
        repositories={repositories}
        snapshot={externalJiraSnapshot}
      />,
    );

    const jiraRow = screen.getByText("Jira via MCP").closest("li");
    expect(jiraRow).not.toBeNull();
    await user.click(
      within(jiraRow!).getByRole("button", { name: "Connect Jira" }),
    );

    expect(await within(jiraRow!).findByRole("alert")).toHaveTextContent(
      "WTS could not start Jira. Start Podman, then try again.",
    );
    expect(
      within(jiraRow!).getByRole("button", { name: "Try again" }),
    ).toBeEnabled();
  });

  it("verifies env-managed OpenProject without collecting credentials", async () => {
    const user = userEvent.setup();
    const onVerifyOpenProject = vi.fn().mockResolvedValue({
      connected: true,
      instanceName: "Acme OpenProject",
      apiVersion: "v3",
      authenticatedUser: "Ada Developer",
    });

    render(
      <SetupSheet
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onVerifyOpenProject={onVerifyOpenProject}
        open
        repositories={repositories}
        snapshot={snapshot}
      />,
    );

    const openProjectRow = screen.getByText("OpenProject").closest("li");
    expect(openProjectRow).not.toBeNull();
    expect(
      within(openProjectRow!)
        .getAllByText(
        "OpenProject URL and API token are available from the WTS environment.",
        )
        .find((element) => !element.closest("details")),
    ).toBeVisible();
    expect(
      within(openProjectRow!).queryByRole("textbox"),
    ).not.toBeInTheDocument();
    await user.click(
      within(openProjectRow!).getByRole("button", {
        name: "Verify connection",
      }),
    );

    expect(onVerifyOpenProject).toHaveBeenCalledOnce();
    expect(
      await within(openProjectRow!).findByText(
        "Acme OpenProject answered OpenProject v3 as Ada Developer.",
      ),
    ).toBeVisible();
  });

  it("does not offer OpenProject verification while its API token is missing", async () => {
    const user = userEvent.setup();
    const tokenMissingSnapshot: SetupSnapshot = {
      ...snapshot,
      integrations: snapshot.integrations.map((integration) =>
        integration.id === "openProject"
          ? {
              ...integration,
              setup: "needsAuth",
              detail:
                "Configure an OpenProject API token before importing work packages.",
              diagnosticCode: "openProjectTokenNotConfigured",
              blockingFor: ["openProjectWorkPackageImport"],
            }
          : integration,
      ),
    };

    render(
      <SetupSheet
        loading={false}
        onOpenChange={vi.fn()}
        onRefresh={vi.fn()}
        onVerifyOpenProject={vi.fn()}
        open
        repositories={repositories}
        snapshot={tokenMissingSnapshot}
      />,
    );

    const openProjectRow = screen.getByText("OpenProject").closest("li");
    expect(openProjectRow).not.toBeNull();
    expect(
      within(openProjectRow!).queryByRole("button", {
        name: "Verify connection",
      }),
    ).not.toBeInTheDocument();
    await user.click(
      within(openProjectRow!).getByText("Verification details"),
    );
    expect(
      within(openProjectRow!).getByText("API token not configured"),
    ).toBeVisible();
  });
});
