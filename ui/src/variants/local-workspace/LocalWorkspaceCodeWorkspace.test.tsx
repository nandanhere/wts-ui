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
import type { CodeWorkspaceFileImportResult } from "../../lib/wtsClient";
import { fakeWorkspaceClient, workspaceFixture, workspaceListFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { deferred } from "./localWorkspaceTestHelpers";

describe("personal local workspace registry", () => {
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
      shallow: true,
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
});
