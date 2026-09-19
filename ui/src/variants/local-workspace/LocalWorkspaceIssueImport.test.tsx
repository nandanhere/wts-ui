import {
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { JiraIssueImport, OpenProjectWorkPackageImport } from "../../lib/wtsClient";
import { fakeWorkspaceClient, workspaceFixture, workspaceListFixture } from "../../test/workspaceClientFake";
import { LocalWorkspace } from "./LocalWorkspace";
import { deferred } from "./localWorkspaceTestHelpers";

describe("personal local workspace registry", () => {
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
});
