import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { GitlabIntegrationStatus } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { GitlabIntegrationCard } from "./GitlabIntegrationCard";

describe("GitlabIntegrationCard", () => {
  it.each(["workspace", "client"])("ignores an old connection check after the %s changes", async (change) => {
    let resolveOld!: (status: GitlabIntegrationStatus) => void;
    const first = fakeWorkspaceClient();
    const nextStatus: GitlabIntegrationStatus = {
      schemaVersion: 1,
      cliState: "ready",
      accounts: [{ host: "current.example.com", state: "signedIn", username: "current-user" }],
      detail: "Current connection.",
    };
    first.getGitlabIntegrationStatus
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
      .mockResolvedValue(nextStatus);
    const second = fakeWorkspaceClient({ gitlabIntegrationStatus: nextStatus });
    const view = render(<GitlabIntegrationCard client={first.client} workspaceId="ws-old" />);
    view.rerender(<GitlabIntegrationCard client={change === "client" ? second.client : first.client} workspaceId={change === "workspace" ? "ws-current" : "ws-old"} />);
    expect(await screen.findByText("Signed in as current-user")).toBeVisible();
    await act(async () => resolveOld({
      schemaVersion: 1, cliState: "ready",
      accounts: [{ host: "old.example.com", state: "signedOut" }],
      detail: "Old connection.",
    }));
    expect(screen.getByText("Signed in as current-user")).toBeVisible();
    expect(screen.queryByText("old.example.com")).not.toBeInTheDocument();
  });

  it("explains that a trusted workspace is required", () => {
    const { client, getGitlabIntegrationStatus } = fakeWorkspaceClient();
    render(<GitlabIntegrationCard client={client} />);

    expect(screen.getByText("No workspace")).toBeVisible();
    expect(
      screen.getByText("Open a workspace that has a GitLab repository."),
    ).toBeVisible();
    expect(getGitlabIntegrationStatus).not.toHaveBeenCalled();
  });

  it("shows a no-host state for a workspace without GitLab repositories", async () => {
    const { client } = fakeWorkspaceClient({
      gitlabIntegrationStatus: {
        schemaVersion: 1,
        cliState: "ready",
        accounts: [],
        detail: "This workspace does not use a GitLab host.",
      },
    });
    render(<GitlabIntegrationCard client={client} workspaceId="ws-1" />);

    expect(
      await screen.findByText("No GitLab host in this workspace"),
    ).toBeVisible();
    expect(
      screen.getByText(/checks hosts from trusted workspace repositories/),
    ).toBeVisible();
  });

  it("checks again after a GitLab remote is added to the current workspace", async () => {
    const user = userEvent.setup();
    const { client, getGitlabIntegrationStatus } = fakeWorkspaceClient({
      gitlabIntegrationStatus: {
        schemaVersion: 1,
        cliState: "ready",
        accounts: [],
        detail: "This workspace does not use a GitLab host.",
      },
    });
    render(<GitlabIntegrationCard client={client} workspaceId="ws-1" />);
    await screen.findByText("No GitLab host in this workspace");
    getGitlabIntegrationStatus.mockResolvedValue({
      schemaVersion: 1,
      cliState: "ready",
      accounts: [{ host: "gitlab.example.com", state: "signedIn", username: "alex" }],
      detail: "GitLab CLI is ready.",
    });
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Signed in as alex")).toBeVisible();
    expect(getGitlabIntegrationStatus).toHaveBeenCalledTimes(2);
  });

  it("reports the existing glab account without offering sign-in", async () => {
    const user = userEvent.setup();
    const { client, getGitlabIntegrationStatus } = fakeWorkspaceClient({
      gitlabIntegrationStatus: {
        schemaVersion: 1,
        cliState: "ready",
        accounts: [
          {
            host: "gitlab.example.com",
            state: "signedIn",
            username: "alex",
          },
        ],
        detail: "GitLab CLI is ready.",
      },
    });
    getGitlabIntegrationStatus.mockResolvedValue({
      schemaVersion: 1,
      cliState: "ready",
      accounts: [
        {
          host: "gitlab.example.com",
          state: "signedIn",
          username: "alex",
        },
      ],
      detail: "GitLab CLI is ready.",
    });

    render(<GitlabIntegrationCard client={client} workspaceId="ws-1" />);
    expect(await screen.findByText("Signed in as alex")).toBeVisible();
    expect(screen.getByText("Connected")).toBeVisible();
    expect(screen.getByText("Ready")).toBeVisible();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check connection" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(getGitlabIntegrationStatus).toHaveBeenCalledTimes(2));
  });

  it("keeps an unconfigured host visible and directs setup to Terminal", async () => {
    const { client } = fakeWorkspaceClient({
      gitlabIntegrationStatus: {
        schemaVersion: 1,
        cliState: "ready",
        accounts: [{ host: "gitlab.example.com", state: "signedOut" }],
        detail: "GitLab CLI is not configured for this host.",
      },
    });
    render(<GitlabIntegrationCard client={client} workspaceId="ws-1" />);

    expect(await screen.findByText("gitlab.example.com")).toBeVisible();
    expect(screen.getAllByText("CLI not configured")).toHaveLength(2);
    expect(
      screen.getByText(
        (_, element) =>
          element?.textContent === "Configure glab for this host in Terminal.",
        { selector: "small" },
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /reconnect/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check connection" })).toBeEnabled();
  });
});
