import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeWorkspaceClient, workspaceListFixture } from "../../test/workspaceClientFake";
import {
  LocalWorkspace,
  repositoryUpstreamsFromIssueContent,
  resolveWorkspaceDropTarget,
  suggestedJiraIssueKeyForReview,
} from "./LocalWorkspace";

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
