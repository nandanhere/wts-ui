import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceCodeReviewCard } from "./WorkspaceCodeReviewCard";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";

describe("WorkspaceCodeReviewCard", () => {
  it("offers manual review in VS Code when this client has no AI review capability", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.openWorkspaceInVscode.mockResolvedValue({ workspaceId: "ws_test", provider: "vsCode", accepted: true, codeWorkspaceDisplayPath: "/tmp/workspace.code-workspace" });
    render(<WorkspaceCodeReviewCard client={{ ...fake.client, runWorkspaceCodeReview: undefined }} workspaceId="ws_test" workspaceKey="TEST-1" />);
    expect(screen.getByRole("button", { name: "Review code" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Open workspace in VS Code" }));
    expect(fake.openWorkspaceInVscode).toHaveBeenCalledWith("ws_test");
    expect(fake.runWorkspaceCodeReview).not.toHaveBeenCalled();
  });

  it("renders review scope and model options and runs review on click", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    const onNotice = vi.fn();

    render(
      <WorkspaceCodeReviewCard
        client={fake.client}
        onNotice={onNotice}
        workspaceId="ws_test"
        workspaceKey="TEST-1"
      />,
    );

    expect(screen.getByText("AI Code Review")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Code review scope" }),
    ).toHaveValue("recentChanges");
    expect(
      screen.getByRole("combobox", { name: "Code review provider" }),
    ).toHaveValue("copilot");
    expect(
      screen.getByRole("combobox", { name: "Code review model" }),
    ).toHaveValue("auto");

    const reviewBtn = screen.getByRole("button", { name: "Review code" });
    await user.click(reviewBtn);

    await waitFor(() => {
      expect(fake.runWorkspaceCodeReview).toHaveBeenCalledWith(
        "ws_test",
        "copilot",
        "recentChanges",
        "auto",
      );
    });

    expect(
      screen.getByText("Review completed with 0 warnings."),
    ).toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith("TEST-1 · Code review finished");
  });

  it("displays findings and actionable steps when returned", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    fake.runWorkspaceCodeReview.mockResolvedValue({
      workspaceId: "ws_test",
      provider: "codex",
      scope: "recentChanges",
      summary: "Found 1 security risk.",
      findings: [
        {
          findingId: "f-1",
          severity: "critical",
          filePath: "src/auth.ts",
          line: 23,
          title: "Hardcoded secret",
          explanation: "JWT secret is hardcoded in source.",
          suggestedPatch: "- const SECRET = '123';\n+ const SECRET = process.env.JWT_SECRET;",
        },
      ],
      actionableSteps: [
        {
          stepNumber: 1,
          instruction: "Move secret to environment variable.",
        },
      ],
      reviewedAtUnixMs: 1_726_000_000_000,
    });

    render(
      <WorkspaceCodeReviewCard
        client={fake.client}
        onNotice={vi.fn()}
        workspaceId="ws_test"
        workspaceKey="TEST-1"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Review code" }));

    expect(await screen.findByText("Found 1 security risk.")).toBeInTheDocument();
    expect(screen.getByText("Hardcoded secret")).toBeInTheDocument();
    expect(screen.getByText("src/auth.ts:23")).toBeInTheDocument();
    expect(screen.getByText("critical")).toBeInTheDocument();
    expect(
      screen.getByText("Move secret to environment variable."),
    ).toBeInTheDocument();
  });

  it("allows selecting VS Code Copilot and configuring a custom review model", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    fake.runWorkspaceCodeReview.mockResolvedValue({
      workspaceId: "ws_test",
      provider: "copilot",
      scope: "recentChanges",
      model: "claude-3.7-sonnet",
      summary: "Security scan completed with 0 issues.",
      findings: [],
      actionableSteps: [],
      reviewedAtUnixMs: 1_726_000_000_000,
    });

    render(
      <WorkspaceCodeReviewCard
        client={fake.client}
        onNotice={vi.fn()}
        workspaceId="ws_test"
        workspaceKey="TEST-1"
      />,
    );

    // Select VS Code Copilot
    const providerSelect = screen.getByRole("combobox", {
      name: "Code review provider",
    });
    await user.selectOptions(providerSelect, "copilot");

    // Model input should have default "auto"
    const modelInput = screen.getByRole("combobox", {
      name: "Code review model",
    });
    expect(modelInput).toHaveValue("auto");

    // Change model to "claude-3.7-sonnet"
    await user.clear(modelInput);
    await user.type(modelInput, "claude-3.7-sonnet");

    // Run review
    await user.click(screen.getByRole("button", { name: "Review code" }));

    await waitFor(() => {
      expect(fake.runWorkspaceCodeReview).toHaveBeenCalledWith(
        "ws_test",
        "copilot",
        "recentChanges",
        "claude-3.7-sonnet",
      );
    });

    expect(
      await screen.findByText(
        "Reviewed by VS Code Copilot (model: claude-3.7-sonnet) · Recent changes",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Security scan completed with 0 issues."),
    ).toBeInTheDocument();
  });
});
