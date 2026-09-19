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
  CloneRepositoryResult,
  CreateWorkspaceResult,
  RepositoryCatalog,
  RuntimeAnalysisResult,
  WorkspaceIntent,
} from "../../lib/wtsClient";
import {
  fakeWorkspaceClient,
  repositoryCatalogFixture,
  runtimeAnalysisFixture,
  workspaceFixture,
  workspaceListFixture,
} from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { deferred, reachJiraManifest } from "./localWorkspaceTestHelpers";

describe("personal local workspace registry", () => {
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
      await screen.findByRole("button", { name: /^Open REV-12:.* details$/i }),
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

  it("auto-allocates free ports for services without preferred ports or when auto button is clicked", async () => {
    const user = userEvent.setup();
    const analysis: RuntimeAnalysisResult = runtimeAnalysisFixture({
      services: [
        {
          candidateId: "candidate_command_api",
          serviceId: "command-api",
          displayName: "command api",
          repositoryId: "repo_checkout",
          repositoryLabel: "checkout-api",
          commitOid: "0123456789abcdef0123456789abcdef01234567",
          workingDirectory: "examples/service-stacks/event-driven/command-api",
          command: ["cargo", "run", "-p", "command-api"],
          dependencies: [],
          ports: [
            {
              portId: "command",
              environment: "COMMAND_API_PORT",
              policy: "prefer",
              confidence: "declared",
              evidence: [],
            },
          ],
          confidence: "declared",
          evidence: [],
          includedByDefault: true,
        },
      ],
      graph: {
        status: "ready",
        detail: "Declared stack manifest service.",
      },
    });

    const fake = fakeWorkspaceClient({
      list: workspaceListFixture(),
      runtimeAnalysis: analysis,
    });

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
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

    // Verify port has been automatically assigned a valid port instead of empty
    const portInput = within(dialog).getByRole("spinbutton", {
      name: "Preferred port for command api command",
    });
    expect(portInput).toHaveValue(48_000);
    expect(
      within(dialog).queryByText("Enter a port from 1024 to 65535."),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /Review plan/i }),
    ).toBeEnabled();

    // Clear port and ensure error displays
    await user.clear(portInput);
    expect(
      within(dialog).getByText("Enter a port from 1024 to 65535."),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: /Review plan/i }),
    ).toBeDisabled();

    // Click the Auto button to re-allocate a free port
    const autoButton = within(dialog).getByRole("button", {
      name: "Auto-allocate free port for command api command",
    });
    await user.click(autoButton);

    expect(portInput).toHaveValue(48_000);
    expect(
      within(dialog).queryByText("Enter a port from 1024 to 65535."),
    ).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: /Review plan/i }),
    ).toBeEnabled();
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
    await user.type(
      within(dialog).getByRole("textbox", { name: "Branch to clone" }),
      "master",
    );
    expect(
      within(dialog).getByRole("checkbox", { name: /Limit the clone/i }),
    ).toBeChecked();
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
    expect(fake.cloneRepository).toHaveBeenNthCalledWith(1, {
      remoteUrl,
      branch: "master",
      shallow: true,
    });
    expect(fake.cloneRepository).toHaveBeenNthCalledWith(2, {
      remoteUrl,
      branch: "master",
      shallow: true,
    });
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

  it("keeps repository selection available while a large repository clone runs", async () => {
    const user = userEvent.setup();
    const catalog = repositoryCatalogFixture();
    const clonedRepository = {
      ...catalog.repositories[0]!,
      id: "repo_large_clone",
      label: "large-service",
      checkoutLeaf: "large-service",
      displayPath: "~/cd/large-service",
    };
    const pendingClone = deferred<CloneRepositoryResult>();
    const fake = fakeWorkspaceClient({ repositories: catalog });
    fake.cloneRepository.mockReturnValueOnce(pendingClone.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", { name: /^Repositories/i }),
    );
    await user.click(
      within(dialog).getByRole("tab", { name: "Clone Git URL" }),
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: "Git repository URL" }),
      "https://git.example.test/platform/large-service.git",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Clone and add" }),
    );

    const cloneTask = within(dialog).getByRole("status");
    expect(cloneTask).toHaveAttribute(
      "data-ui",
      "workspace-create.clone-task",
    );
    expect(cloneTask).toHaveTextContent(
      "You can add other repositories while this clone runs.",
    );
    const existingTab = within(dialog).getByRole("tab", {
      name: "Existing local",
    });
    expect(existingTab).toBeEnabled();
    await user.click(existingTab);
    expect(cloneTask).toBeVisible();

    const localRepository = catalog.repositories[0]!;
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Repository to add" }),
      { target: { value: localRepository.id } },
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Add repository" }),
    );
    expect(
      within(dialog).getByRole("list", {
        name: "Repositories in this workspace plan",
      }),
    ).toHaveTextContent(localRepository.label);
    await user.click(
      within(dialog).getByRole("button", { name: /Review repositories/i }),
    );
    expect(
      within(dialog).getByRole("combobox", {
        name: new RegExp(`Base branch for ${localRepository.label}`),
      }),
    ).toBeVisible();
    const backgroundCloneTask = within(dialog).getByRole("status");
    expect(backgroundCloneTask).toHaveTextContent(
      "You can continue workspace setup while this clone runs.",
    );

    await act(async () => {
      pendingClone.resolve({
        repository: clonedRepository,
        repositoryRootDisplayPath: "~/cd",
        reusedExisting: false,
      });
      await pendingClone.promise;
    });
    expect(backgroundCloneTask).toHaveTextContent(
      "Cloned large-service and added it to this workspace plan.",
    );
    expect(
      within(dialog).getByRole("combobox", {
        name: /Base branch for large-service/,
      }),
    ).toBeVisible();
  });

  it("moves a running repository clone to Kanban and resumes it from Ready", async () => {
    const user = userEvent.setup();
    const catalog = repositoryCatalogFixture();
    const clonedRepository = {
      ...catalog.repositories[0]!,
      id: "repo_large_clone",
      label: "large-service",
      checkoutLeaf: "large-service",
      displayPath: "~/cd/large-service",
    };
    const pendingClone = deferred<CloneRepositoryResult>();
    const fake = fakeWorkspaceClient({ repositories: catalog });
    fake.cloneRepository.mockReturnValueOnce(pendingClone.promise);

    render(<LocalWorkspace client={fake.client} />);
    await screen.findByRole("heading", { name: "No local workspaces found" });
    await user.click(
      screen.getAllByRole("button", { name: /New workspace/i })[0]!,
    );
    const dialog = screen.getByRole("dialog", { name: "New workspace" });
    await user.click(
      within(dialog).getByRole("radio", { name: /^Repositories/i }),
    );
    await user.click(
      within(dialog).getByRole("tab", { name: "Clone Git URL" }),
    );
    const remoteUrl = "https://git.example.test/platform/large-service.git";
    await user.type(
      within(dialog).getByRole("textbox", { name: "Git repository URL" }),
      remoteUrl,
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Clone and add" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Move to Kanban" }),
    );

    expect(screen.queryByRole("dialog", { name: "New workspace" }))
      .not.toBeInTheDocument();
    const board = screen.getByRole("region", {
      name: "Local workspace board",
    });
    expect(
      within(board).queryByRole("heading", {
        name: "No local workspaces found",
      }),
    ).not.toBeInTheDocument();
    const active = within(board).getByRole("region", { name: "Active" });
    const activeCard = within(active)
      .getByText("large-service")
      .closest("article");
    expect(activeCard).toHaveAttribute(
      "data-ui",
      expect.stringMatching(/^spaces\.creation\.repository-clone-/),
    );
    expect(within(active).getByRole("button", { name: "Clone is active" }))
      .toBeDisabled();

    await act(async () => {
      pendingClone.resolve({
        repository: clonedRepository,
        repositoryRootDisplayPath: "~/cd",
        reusedExisting: false,
      });
      await pendingClone.promise;
    });

    expect(within(active).queryByText("large-service")).not.toBeInTheDocument();
    const ready = within(board).getByRole("region", { name: "Ready" });
    expect(
      within(ready).getByText(
        "Git cloned large-service. Continue workspace setup.",
      ),
    ).toBeVisible();
    await user.click(
      within(ready).getByRole("button", { name: "Continue setup" }),
    );

    const resumedDialog = screen.getByRole("dialog", { name: "New workspace" });
    expect(
      within(resumedDialog).getByRole("list", {
        name: "Repositories in this workspace plan",
      }),
    ).toHaveTextContent("large-service");
    expect(
      within(resumedDialog).getByRole("button", {
        name: /Review repositories/i,
      }),
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
});
