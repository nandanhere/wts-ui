import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceCliLaunchResult,
  WorkspaceMaterialization,
} from "../../lib/wtsClient";
import { OpenWorkspaceLauncher } from "./OpenWorkspaceLauncher";

const workspaceId = "workspace-123";
const workspacePath = "~/cd/workspaces/task-42";

function materialization(): WorkspaceMaterialization {
  return {
    schemaVersion: 1,
    workspaceId,
    workspaceRecordVersion: 2,
    effectDigest: "sha256:workspace-123",
    workspaceDisplayPath: workspacePath,
    codeWorkspaceDisplayPath: `${workspacePath}/wts.code-workspace`,
    branchName: "wts/task-42",
    worktrees: [],
    graph: {
      status: "ready",
      detail: "Workspace graph is ready.",
    },
  };
}

function launchResult(
  overrides: Partial<WorkspaceCliLaunchResult> = {},
): WorkspaceCliLaunchResult {
  return {
    workspaceId,
    provider: "codex",
    terminal: "terminal",
    accepted: true,
    workspaceDisplayPath: workspacePath,
    ...overrides,
  };
}

function renderLauncher(
  overrides: Partial<React.ComponentProps<typeof OpenWorkspaceLauncher>> = {},
) {
  const onOpenCli =
    overrides.onOpenCli ?? vi.fn().mockResolvedValue(launchResult());
  const onOpenVscode =
    overrides.onOpenVscode ?? vi.fn().mockResolvedValue(true);
  render(
    <OpenWorkspaceLauncher
      materialization={materialization()}
      onOpenCli={onOpenCli}
      onOpenVscode={onOpenVscode}
      preferredProvider="codex"
      trigger={<button type="button">Open workspace</button>}
      workspaceId={workspaceId}
      workspaceKey="TASK-42"
      {...overrides}
    />,
  );
  return { onOpenCli, onOpenVscode };
}

describe("OpenWorkspaceLauncher", () => {
  it("keeps VS Code first when it is the saved workspace preference", async () => {
    const user = userEvent.setup();
    renderLauncher({ preferredProvider: "vsCode" });

    await user.click(screen.getByRole("button", { name: "Open workspace" }));

    const dialog = screen.getByRole("dialog", { name: "Open workspace" });
    const choices = within(dialog).getAllByRole("button", {
      name: /^Open (workspace in VS Code|Codex|OpenCode|Hermes)/,
    });
    expect(choices[0]).toHaveAccessibleName("Open workspace in VS Code");
    expect(
      within(dialog).getByRole("button", { name: "Open Codex" }),
    ).toBeVisible();
  });

  it("puts the preferred provider first and preserves the CLI launch handoff", async () => {
    const user = userEvent.setup();
    const { onOpenCli } = renderLauncher();

    await user.click(screen.getByRole("button", { name: "Open workspace" }));

    const dialog = screen.getByRole("dialog", { name: "Open workspace" });
    expect(within(dialog).getAllByText(workspacePath)[0]).toBeVisible();
    const choices = within(dialog).getAllByRole("button", {
      name: /^Open (Codex|workspace in VS Code)/,
    });
    expect(choices[0]).toHaveAccessibleName("Open Codex");

    await user.click(
      within(dialog).getByRole("button", { name: "Open Codex" }),
    );

    expect(onOpenCli).toHaveBeenCalledWith("codex", "terminal");
    expect(
      await within(dialog).findByRole("status"),
    ).toHaveTextContent("Codex opened in Terminal.");
  });

  it("keeps terminal choice secondary and sends it with alternate agent launches", async () => {
    const user = userEvent.setup();
    const { onOpenCli } = renderLauncher({
      onOpenCli: vi
        .fn()
        .mockResolvedValue(
          launchResult({ provider: "hermes", terminal: "warp" }),
        ),
      integrations: [
        {
          id: "warp",
          category: "terminal",
          status: "ready",
          installation: "detected",
          setup: "ready",
          runtime: "idle",
          wtsSupport: "available",
          verificationKind: "version",
          capabilities: ["terminalSession"],
          lastProbeAt: 1,
          blockingFor: [],
        },
      ],
    });

    await user.click(screen.getByRole("button", { name: "Open workspace" }));
    const dialog = screen.getByRole("dialog", { name: "Open workspace" });
    await user.click(
      within(dialog).getByRole("button", { name: "Terminal" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Warp" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Open Hermes" }),
    );

    expect(onOpenCli).toHaveBeenCalledWith("hermes", "warp");
  });

  it("copies the working path and announces only after clipboard acceptance", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    renderLauncher();

    await user.click(screen.getByRole("button", { name: "Open workspace" }));
    const dialog = screen.getByRole("dialog", { name: "Open workspace" });
    await user.click(
      within(dialog).getByRole("button", { name: "Copy path" }),
    );

    expect(writeText).toHaveBeenCalledWith(workspacePath);
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "Workspace path copied.",
    );
  });

  it("rejects a mismatched trusted-boundary response instead of claiming success", async () => {
    const user = userEvent.setup();
    renderLauncher({
      onOpenCli: vi
        .fn()
        .mockResolvedValue(
          launchResult({ workspaceDisplayPath: "~/cd/workspaces/wrong" }),
        ),
    });

    await user.click(screen.getByRole("button", { name: "Open workspace" }));
    const dialog = screen.getByRole("dialog", { name: "Open workspace" });
    await user.click(
      within(dialog).getByRole("button", { name: "Open Codex" }),
    );

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Received a mismatched CLI launch handoff.",
    );
  });

  it("blocks agent launch until the prepared brief is ready while keeping VS Code available", async () => {
    const user = userEvent.setup();
    const onRetryBrief = vi.fn();
    const { onOpenCli, onOpenVscode } = renderLauncher({
      preparedBrief: {
        prompt: "Investigate retry idempotency.",
        state: "error",
        error: "The brief could not be written.",
      },
      onRetryBrief,
    });

    await user.click(screen.getByRole("button", { name: "Open workspace" }));
    const dialog = screen.getByRole("dialog", { name: "Open workspace" });
    expect(
      within(dialog).getByRole("button", {
        name: "Open Codex with WTS.md",
      }),
    ).toBeDisabled();

    await user.click(
      within(dialog).getByRole("button", {
        name: "Open workspace in VS Code",
      }),
    );
    await waitFor(() => expect(onOpenVscode).toHaveBeenCalledOnce());
    expect(onOpenCli).not.toHaveBeenCalled();

    await user.click(
      within(dialog).getByRole("button", { name: "Save again" }),
    );
    expect(onRetryBrief).toHaveBeenCalledOnce();
  });
});
