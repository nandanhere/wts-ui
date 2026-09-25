import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceCodeReviewCard } from "./WorkspaceCodeReviewCard";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import type { WorkspaceCodeReviewResult } from "../../lib/wtsClient";

const raptikReview: WorkspaceCodeReviewResult = {
  schemaVersion: 2,
  workspaceId: "ws_test",
  provider: "codex",
  scope: "recentChanges",
  model: "gpt-5.5",
  mode: "raptik",
  outcome: "reviewed",
  summary: "One blocking problem.",
  findings: [
    {
      findingId: "f-1",
      severity: "critical",
      label: "blocking",
      repositoryId: "repo_checkout",
      filePath: "src/auth.ts",
      line: 23,
      side: "additions",
      anchored: true,
      title: "Hardcoded secret",
      explanation: "JWT secret is hardcoded in source.",
      suggestedComment: "Blocking: move the secret to the environment.",
      precedent: { body: "Do not keep secrets in code.", url: "https://gitlab.example/sre/mr/4#note_1", score: 6 },
    },
  ],
  actionableSteps: [{ stepNumber: 1, instruction: "Move secret to environment variable." }],
  repositories: [{ repositoryId: "repo_checkout", repositoryLabel: "checkout", baseCommitOid: "a", headCommitOid: "b", patchSha256: "sha256:old", changedLines: 12, sizeGateExceeded: false, strictness: "strict" }],
  reviewedAtUnixMs: 1_726_000_000_000,
};

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

  it("infers the installed agent and its configured model, then runs the review with that default", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    const onNotice = vi.fn();
    render(<WorkspaceCodeReviewCard client={fake.client} onNotice={onNotice} workspaceId="ws_test" workspaceKey="TEST-1" />);

    const provider = screen.getByRole("combobox", { name: "Code review provider" });
    await waitFor(() => expect(provider).toHaveTextContent("Codex"));
    expect(screen.getByRole("combobox", { name: "Code review model" })).toHaveTextContent("Default · gpt-5.5");
    expect(screen.getByText("From ~/.codex/config.toml")).toBeInTheDocument();
    expect(screen.getByText("Raptik rules", { selector: "[data-ui='verification.code-review-mode']" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Changes" })).toHaveAttribute("aria-checked", "true");

    await user.click(provider);
    const options = screen.getAllByRole("option").map((option) => option.textContent);
    expect(options).toEqual(["Codex", "Copilot"]);
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "Review code" }));
    await waitFor(() => expect(fake.runWorkspaceCodeReview).toHaveBeenCalledWith("ws_test", "codex", "recentChanges", undefined, { skill: "raptik-review" }));
    expect(await screen.findByText("Review completed with 0 warnings.")).toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith("TEST-1 · The AI code review is complete.");
  });

  it("sends a chosen model and repository, and lists the models of the new agent", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    render(<WorkspaceCodeReviewCard client={fake.client} repositoryId="repo_checkout" workspaceId="ws_test" workspaceKey="TEST-1" />);
    const provider = screen.getByRole("combobox", { name: "Code review provider" });
    await waitFor(() => expect(provider).toHaveTextContent("Codex"));

    await user.click(provider);
    await user.click(screen.getByRole("option", { name: "Copilot" }));
    const model = screen.getByRole("combobox", { name: "Code review model" });
    expect(model).toHaveTextContent("Default · auto");
    await user.click(model);
    await user.click(screen.getByRole("option", { name: "claude-sonnet-4.5" }));

    await user.click(screen.getByRole("button", { name: "Review code" }));
    await waitFor(() => expect(fake.runWorkspaceCodeReview).toHaveBeenCalledWith(
      "ws_test", "copilot", "recentChanges", "claude-sonnet-4.5", { repositoryId: "repo_checkout", skill: "raptik-review" },
    ));
  });

  it("shows Raptik findings with labels, the MR comment, and the earlier comment of Pratik", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    fake.runWorkspaceCodeReview.mockResolvedValue(raptikReview);
    const reveal = vi.fn();
    render(<WorkspaceCodeReviewCard client={fake.client} onRevealFinding={reveal} workspaceId="ws_test" workspaceKey="TEST-1" />);
    await user.click(await screen.findByRole("button", { name: "Review code" }));

    const findings = await screen.findByRole("list", { name: "Code review findings" });
    expect(within(findings).getByText("Blocking")).toBeInTheDocument();
    expect(within(findings).getByText("Hardcoded secret")).toBeInTheDocument();
    expect(within(findings).getByText("Blocking: move the secret to the environment.")).toBeInTheDocument();
    expect(within(findings).getByRole("link", { name: /Open the earlier comment/ })).toHaveAttribute("href", "https://gitlab.example/sre/mr/4#note_1");
    await user.click(within(findings).getByRole("button", { name: "Show src/auth.ts line 23 in the diff" }));
    expect(within(findings).getByText("Pratik said this before")).toBeInTheDocument();
    // Without an MR, WTS has nowhere to post the comment.
    expect(within(findings).queryByRole("button", { name: /Post to GitLab/ })).toBeNull();
    expect(reveal).toHaveBeenCalledWith(expect.objectContaining({ findingId: "f-1" }));
    expect(screen.getByText("Move secret to environment variable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review again" })).toBeEnabled();
  });

  it("loads the saved review and marks it old when the patch on screen changed", async () => {
    const fake = fakeWorkspaceClient({});
    fake.getWorkspaceCodeReview.mockResolvedValue(raptikReview);
    render(<WorkspaceCodeReviewCard client={fake.client} currentPatch={{ repositoryId: "repo_checkout", patchSha256: "sha256:new" }} workspaceId="ws_test" workspaceKey="TEST-1" />);
    expect(await screen.findByText("Hardcoded secret")).toBeInTheDocument();
    expect(screen.getByText("The code changed after this review")).toBeInTheDocument();
  });

  it("explains the size gate and runs again past it only on request", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    fake.runWorkspaceCodeReview.mockResolvedValueOnce({
      ...raptikReview,
      outcome: "sizeGateStopped",
      findings: [],
      summary: "This change has 812 changed lines. Pratik stops at 500.",
      actionableSteps: [{ stepNumber: 1, instruction: "checkout has 812 changed lines. Split it by concern or layer." }],
    });
    render(<WorkspaceCodeReviewCard client={fake.client} repositoryId="repo_checkout" workspaceId="ws_test" workspaceKey="TEST-1" />);
    await user.click(await screen.findByRole("button", { name: "Review code" }));
    expect(await screen.findByText("The change is too large for one review")).toBeInTheDocument();
    expect(screen.getByText("checkout has 812 changed lines. Split it by concern or layer.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review anyway" }));
    await waitFor(() => expect(fake.runWorkspaceCodeReview).toHaveBeenLastCalledWith(
      "ws_test", "codex", "recentChanges", undefined, { repositoryId: "repo_checkout", ignoreSizeGate: true, skill: "raptik-review" },
    ));
  });

  it("shows the agent output when WTS cannot read structured findings", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    fake.runWorkspaceCodeReview.mockResolvedValue({ ...raptikReview, outcome: "unstructured", findings: [], summary: "The agent answered in free text.", rawOutput: "Looks fine to me." });
    render(<WorkspaceCodeReviewCard client={fake.client} workspaceId="ws_test" workspaceKey="TEST-1" />);
    await user.click(await screen.findByRole("button", { name: "Review code" }));
    await user.click(await screen.findByText("WTS could not read findings from the agent. Show the agent output."));
    expect(screen.getByText("Looks fine to me.")).toBeVisible();
  });

  it("stops the run when no agent CLI is installed", async () => {
    const fake = fakeWorkspaceClient({});
    fake.listAgentModels.mockResolvedValue({ raptikSkillLoaded: false, providers: [{ provider: "codex", installed: false, models: [], modelSelectable: true }] });
    render(<WorkspaceCodeReviewCard client={fake.client} workspaceId="ws_test" workspaceKey="TEST-1" />);
    expect(await screen.findByText(/WTS did not find Codex, Copilot, OpenCode, or Hermes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review code" })).toBeDisabled();
    expect(screen.getByText("General rules")).toBeInTheDocument();
  });
  it("shows the live agent steps while the review runs and keeps them after it finishes", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    let finish!: (value: WorkspaceCodeReviewResult) => void;
    fake.runWorkspaceCodeReview.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const startedAt = Date.now();
    const base = { workspaceId: "ws_test", runId: "run-1", provider: "codex" as const, state: "running" as const, startedAtUnixMs: startedAt, droppedSteps: 0 };
    fake.getWorkspaceCodeReviewTrace
      .mockResolvedValueOnce({ ...base, steps: [{ sequence: 1, kind: "status", text: "Codex reads the review request.", running: false, atUnixMs: startedAt }] })
      .mockResolvedValue({ ...base, steps: [
        { sequence: 1, kind: "status", text: "Codex reads the review request.", running: false, atUnixMs: startedAt },
        { sequence: 2, kind: "command", text: "rg -n cfg src", running: true, atUnixMs: startedAt + 1_000 },
      ] });
    render(<WorkspaceCodeReviewCard client={fake.client} workspaceId="ws_test" workspaceKey="TEST-1" />);
    await user.click(await screen.findByRole("button", { name: "Review code" }));

    const steps = await screen.findByRole("list", { name: "Agent steps" });
    expect(within(steps).getByText("Codex reads the review request.")).toBeInTheDocument();
    expect(await within(steps).findByText("rg -n cfg src")).toBeInTheDocument();
    expect(screen.getByText("Codex reviews the changes")).toBeInTheDocument();
    expect(fake.getWorkspaceCodeReviewTrace).toHaveBeenCalledWith("ws_test", undefined);
    await waitFor(() => expect(fake.getWorkspaceCodeReviewTrace).toHaveBeenCalledWith("ws_test", 1), { timeout: 3_000 });

    finish(raptikReview);
    expect(await screen.findByText("Hardcoded secret")).toBeInTheDocument();
    await user.click(await screen.findByText(/Show agent activity/));
    expect(screen.getByRole("list", { name: "Agent steps" })).toBeVisible();
  });

  it("lists every model that the agent config names, with search for long lists", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    const models = ["github-copilot/gpt-6-luna", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "github-copilot/claude-opus-5", "github-copilot/claude-haiku-4.5"];
    fake.listAgentModels.mockResolvedValue({ raptikSkillLoaded: true, providers: [{ provider: "codex", installed: true, defaultModel: models[0], defaultSource: "~/.codex/config.toml", models, modelSelectable: true }] });
    render(<WorkspaceCodeReviewCard client={fake.client} workspaceId="ws_test" workspaceKey="TEST-1" />);
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Code review model" })).toHaveValue("Default · github-copilot/gpt-6-luna"));
    const model = screen.getByRole("combobox", { name: "Code review model" });
    await user.click(model);
    await user.clear(model);
    await user.type(model, "opus");
    await user.click(screen.getByRole("option", { name: "github-copilot/claude-opus-5" }));
    await user.click(screen.getByRole("button", { name: "Review code" }));
    await waitFor(() => expect(fake.runWorkspaceCodeReview).toHaveBeenCalledWith("ws_test", "codex", "recentChanges", "github-copilot/claude-opus-5"));
  });

  it("runs the skill that the user selects and names its reviewer, or runs without a skill", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    render(<WorkspaceCodeReviewCard client={fake.client} workspaceId="ws_test" workspaceKey="TEST-1" />);
    const skill = await screen.findByRole("combobox", { name: "Code review skill" });
    await waitFor(() => expect(skill).toHaveTextContent("Raptik rules"));
    expect(screen.getByText("Review the changes with the rules that Pratik uses. The agent can read files but cannot change them.")).toBeInTheDocument();

    await user.click(skill);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Raptik rules", "Team review", "No skill · general rules"]);
    await user.click(screen.getByRole("option", { name: "Team review" }));
    expect(screen.getByText("Team review", { selector: "[data-ui='verification.code-review-mode']" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review code" }));
    await waitFor(() => expect(fake.runWorkspaceCodeReview).toHaveBeenLastCalledWith("ws_test", "codex", "recentChanges", undefined, { skill: "team-review" }));

    await user.click(skill);
    await user.click(screen.getByRole("option", { name: "No skill · general rules" }));
    expect(screen.getByText("General rules")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review again" }));
    await waitFor(() => expect(fake.runWorkspaceCodeReview).toHaveBeenLastCalledWith("ws_test", "codex", "recentChanges", undefined, { skill: "none" }));
  });

  it("reviews the published MR, lists agent questions, and posts a finding on its MR line", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({});
    const version = { iid: 16, baseCommitOid: "a".repeat(40), startCommitOid: "c".repeat(40), headCommitOid: "b".repeat(40) };
    fake.runWorkspaceCodeReview.mockResolvedValue({
      ...raptikReview,
      mode: "skill",
      skill: { id: "team-review", label: "Team review", reviewer: "Asha" },
      findings: [
        raptikReview.findings[0]!,
        { findingId: "q-1", severity: "suggestion", label: "question", repositoryId: "repo_checkout", filePath: "src/retry.ts", line: 9, side: "additions", anchored: true, title: "Is the retry bounded?", explanation: "The loop has no visible limit.", suggestedComment: "Question: what stops this retry loop?" },
        { findingId: "q-2", severity: "suggestion", label: "question", repositoryId: "repo_checkout", filePath: "src/config.ts", anchored: false, title: "Is this flag still used?", explanation: "No caller found.", suggestedComment: "Question: can we drop this flag?" },
      ],
      repositories: [{ ...raptikReview.repositories![0]!, mergeRequest: version }],
    });
    fake.publishGitlabReviewComment.mockResolvedValue({ schemaVersion: 1, repositoryId: "provider_checkout", iid: 16, accepted: true });
    render(<WorkspaceCodeReviewCard client={fake.client} mergeRequest={{ worktreeRepositoryId: "repo_checkout", providerRepositoryId: "provider_checkout", iid: 16, canPost: true }} workspaceId="ws_test" workspaceKey="TEST-1" />);
    expect(screen.queryByRole("radiogroup", { name: "Code review scope" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: "Review code" }));
    await waitFor(() => expect(fake.runWorkspaceCodeReview).toHaveBeenCalledWith("ws_test", "codex", "recentChanges", undefined, { repositoryId: "repo_checkout", mergeRequestIid: 16, skill: "raptik-review" }));

    const questions = await screen.findByRole("list", { name: "Agent questions" });
    expect(within(questions).getAllByRole("listitem")).toHaveLength(2);
    expect(within(screen.getByRole("list", { name: "Code review findings" })).getByText("Asha said this before")).toBeInTheDocument();

    await user.click(within(questions).getByRole("button", { name: "Post to GitLab on line 9" }));
    await waitFor(() => expect(fake.publishGitlabReviewComment).toHaveBeenCalledWith("provider_checkout", 16, {
      body: "Question: what stops this retry loop?", filePath: "src/retry.ts", side: "additions", line: 9, workspaceId: "ws_test",
      expectedPosition: { baseCommitOid: version.baseCommitOid, startCommitOid: version.startCommitOid, headCommitOid: version.headCommitOid },
    }));
    expect(await within(questions).findByRole("button", { name: "Posted to GitLab" })).toBeDisabled();

    // A finding off the changed lines goes to the MR as a general comment.
    await user.click(within(questions).getByRole("button", { name: "Post to GitLab as an MR comment" }));
    await waitFor(() => expect(fake.publishGitlabReviewComment).toHaveBeenLastCalledWith("provider_checkout", 16, { body: "Question: can we drop this flag?" }));
  });

  it("keeps the post button off until WTS checks the MR with GitLab", async () => {
    const fake = fakeWorkspaceClient({});
    fake.getWorkspaceCodeReview.mockResolvedValue({ ...raptikReview, repositories: [{ ...raptikReview.repositories![0]!, mergeRequest: { iid: 16, baseCommitOid: "a".repeat(40), startCommitOid: "a".repeat(40), headCommitOid: "b".repeat(40) } }] });
    render(<WorkspaceCodeReviewCard client={fake.client} mergeRequest={{ worktreeRepositoryId: "repo_checkout", providerRepositoryId: "provider_checkout", iid: 16, canPost: false }} workspaceId="ws_test" workspaceKey="TEST-1" />);
    expect(await screen.findByRole("button", { name: "Post to GitLab on line 23" })).toBeDisabled();
    expect(fake.publishGitlabReviewComment).not.toHaveBeenCalled();
  });
});
