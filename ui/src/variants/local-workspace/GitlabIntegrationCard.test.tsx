import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { GitlabIntegrationCard } from "./GitlabIntegrationCard";

describe("GitlabIntegrationCard", () => {
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
            username: "noah",
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
          username: "noah",
        },
      ],
      detail: "GitLab CLI is ready.",
    });

    render(<GitlabIntegrationCard client={client} workspaceId="ws-1" />);
    expect(await screen.findByText("Signed in as noah")).toBeVisible();
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
