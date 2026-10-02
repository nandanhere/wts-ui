import { describe, expect, it, vi } from "vitest";
import {
  GET_GITLAB_INTEGRATION_STATUS_TAURI_COMMAND,
  gitlabIntegrationStatusHttpPath,
  createWorkspaceClient,
  normalizeGitlabIntegrationStatus,
} from "./wtsClient";
import type { WorkspaceClientOptions } from "./wtsClient";

describe("GitLab integration transport contract", () => {
  it("keeps the desktop and HTTP transport names stable", () => {
    expect(GET_GITLAB_INTEGRATION_STATUS_TAURI_COMMAND).toBe(
      "get_gitlab_integration_status",
    );
    expect(gitlabIntegrationStatusHttpPath("workspace id")).toBe(
      "/api/v1/workspaces/workspace%20id/integrations/gitlab",
    );
  });

  it("accepts account state without credentials or provider commands", () => {
    expect(
      normalizeGitlabIntegrationStatus({
        schemaVersion: 1,
        cliState: "ready",
        accounts: [
          {
            host: "gitlab.example.com",
            state: "signedIn",
            username: "alex",
          },
        ],
        detail: "GitLab is connected.",
      }),
    ).toEqual({
      schemaVersion: 1,
      cliState: "ready",
      accounts: [
        {
          host: "gitlab.example.com",
          state: "signedIn",
          username: "alex",
        },
      ],
      detail: "GitLab is connected.",
    });
  });

  it("rejects duplicate hosts, URLs, credentials, and unknown fields", () => {
    const status = (accounts: unknown[]) => ({
      schemaVersion: 1,
      cliState: "ready",
      accounts,
      detail: "GitLab state.",
    });
    expect(() =>
      normalizeGitlabIntegrationStatus(
        status([
          { host: "gitlab.com", state: "signedOut" },
          { host: "GITLAB.COM", state: "signedIn" },
        ]),
      ),
    ).toThrow(/invalid/i);
    expect(() =>
      normalizeGitlabIntegrationStatus(
        status([{ host: "https://gitlab.com", state: "signedOut" }]),
      ),
    ).toThrow(/invalid/i);
    expect(() =>
      normalizeGitlabIntegrationStatus(
        status([{ host: "gitlab.com", state: "signedIn", token: "secret" }]),
      ),
    ).toThrow(/invalid/i);
  });

  it("sends only the trusted workspace identity", async () => {
    const invoke = vi.fn(async (command: string): Promise<unknown> => {
      if (command === GET_GITLAB_INTEGRATION_STATUS_TAURI_COMMAND) {
        return {
          schemaVersion: 1,
          cliState: "ready",
          accounts: [{ host: "gitlab.com", state: "signedOut" }],
          detail: "Sign in to GitLab.",
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const client = createWorkspaceClient({
      runtime: "tauri",
      invoke: invoke as NonNullable<WorkspaceClientOptions["invoke"]>,
    });

    await client.getGitlabIntegrationStatus(" ws-1 ");

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      "get_gitlab_integration_status",
      { workspaceId: "ws-1" },
    );
  });
});
