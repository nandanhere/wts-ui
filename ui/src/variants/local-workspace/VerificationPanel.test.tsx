import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  fakeWorkspaceClient,
  workspaceEvidenceFixture,
} from "../../test/workspaceClientFake";
import {
  buildGraphVerificationPlanningPrompt,
  VerificationPanel,
} from "./VerificationPanel";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function expandOptionalSection(
  user: ReturnType<typeof userEvent.setup>,
  name: "Evidence and history" | "Improve coverage",
) {
  const label = await screen.findByText(name);
  const disclosure = label.closest("details");
  expect(disclosure).not.toBeNull();
  if (!disclosure!.hasAttribute("open")) {
    await user.click(label);
  }
  return disclosure!;
}

async function expandReportSection(
  user: ReturnType<typeof userEvent.setup>,
  report: HTMLElement,
  name:
    | "Environment"
    | "Suggested checks"
    | "System behavior (agent-reported)",
) {
  const label = within(report).getByText(name);
  const disclosure = label.closest("details");
  expect(disclosure).not.toBeNull();
  if (!disclosure!.hasAttribute("open")) {
    await user.click(label);
  }
  return disclosure!;
}

describe("VerificationPanel", () => {
  it("restores cached evidence immediately while refreshing it in the background", async () => {
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient({ evidence });
    const first = render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await screen.findByRole("heading", { name: "Failed" });
    expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(1);
    first.unmount();

    const backgroundRefresh = deferred<typeof evidence>();
    fake.getWorkspaceEvidence.mockReturnValueOnce(backgroundRefresh.promise);
    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    expect(
      screen.queryByRole("status", { name: "Loading verification" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failed" })).toBeVisible();
    expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2);

    await act(async () => {
      backgroundRefresh.resolve(evidence);
      await backgroundRefresh.promise;
    });
  });

  it("shows persisted recent verification runs on demand", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const evidence = workspaceEvidenceFixture({
      verificationHistory: [
        {
          ...base.verificationResult,
          status: "passed",
          startedAtUnixMs: 1_721_776_400_000,
          completedAtUnixMs: 1_721_776_401_250,
          durationMs: 1_250,
        },
        {
          ...base.verificationResult,
          status: "failed",
          startedAtUnixMs: 1_721_776_300_000,
          completedAtUnixMs: 1_721_776_301_900,
          durationMs: 1_900,
        },
      ],
    });
    const fake = fakeWorkspaceClient({ evidence });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Evidence and history");
    const summary = await screen.findByText("Recent verification runs");
    const history = summary.closest("details");
    expect(history).not.toBeNull();
    await user.click(summary);
    expect(within(history!).getByText("Passed")).toBeVisible();
    expect(within(history!).getByText("Failed")).toBeVisible();
    expect(within(history!).getByText("1.3 s")).toBeVisible();
  });

  it("places runnable checks before optional planning and agent analysis", async () => {
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient({ evidence });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const checks = await screen.findByRole("heading", { name: "Checks" });
    const planning = screen.getByText("Improve coverage");
    const agentAnalysis = screen.getByText("Evidence and history");

    expect(
      checks.compareDocumentPosition(planning) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      planning.compareDocumentPosition(agentAnalysis) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(planning.closest("details")).not.toHaveAttribute("open");
    expect(agentAnalysis.closest("details")).not.toHaveAttribute("open");
    expect(
      screen.queryByRole("region", { name: "Supporting evidence" }),
    ).not.toBeInTheDocument();
  });

  it("uses decision-first disclosures instead of nested report tabs", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const evidence = workspaceEvidenceFixture({
      agentReport: {
        ...base.agentReport,
        status: "ready",
      },
    });
    const fake = fakeWorkspaceClient({ evidence });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Evidence and history");
    const report = await screen.findByRole("region", {
      name: "Supporting evidence",
    });
    expect(within(report).queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(report).queryByRole("tab")).not.toBeInTheDocument();
    expect(
      within(report).getByText("Findings and next actions").closest("details"),
    ).toHaveAttribute("open");
    expect(
      within(report)
        .getByText("System behavior (agent-reported)")
        .closest("details"),
    ).not.toHaveAttribute("open");
  });

  it("prepares a graph-informed proposal without running a check or provider", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient({ evidence });
    const onNotice = vi.fn();
    const onPrepareCliTask = vi.fn();

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={onNotice}
        onPrepareCliTask={onPrepareCliTask}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Improve coverage");
    const planning = await screen.findByRole("region", {
      name: "Find gaps in verification",
    });
    expect(within(planning).queryByText("Index available")).not.toBeInTheDocument();
    expect(
      within(planning).getByText(
        "The graph may not include your latest local changes.",
      ),
    ).toBeVisible();
    await user.click(
      within(planning).getByRole("button", {
        name: "Prepare verification brief",
      }),
    );

    expect(onPrepareCliTask).toHaveBeenCalledOnce();
    const prompt = onPrepareCliTask.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain(
      "Read WTS.md from the workspace root first.",
    );
    expect(prompt).toContain(
      "Read graphify-out/graph.json from the workspace root before proposing anything.",
    );
    expect(prompt).toContain(
      "identify the actual workspace-specific user-facing entry points",
    );
    expect(prompt).toContain(
      "Do not assume WTS Help, WTS Preferences, or any other WTS application chrome belongs to this workspace.",
    );
    expect(prompt).toContain(
      "Do not run project commands, modify repository files, install dependencies, or start services.",
    );
    expect(prompt).toContain("`wts-report --input <candidate.json>`");
    expect(prompt).toContain(
      "Do not modify verification plans, assertions, logs, graph output, or .wts files directly",
    );
    expect(prompt).toContain(
      "include summary, scope, environment, flows, findings, nextActions, proposedChecks, and validationFlows",
    );
    expect(prompt).toContain(
      "Report secret names only—never values.",
    );
    expect(prompt).toContain(
      "Classify each exactly once as reviewed, unresolved, or skipped",
    );
    expect(prompt).toContain(
      "do not substitute an endpoint list for a flow map",
    );
    expect(prompt).toContain(
      "Each flows item must contain id, title, kind, actors, entryPoints, steps, expectedOutcome, risks, existingCoverage, and verificationCandidateIds",
    );
    expect(prompt).toContain("including its sha256: prefix");
    expect(prompt).not.toContain("worktree=~/cd/platform-42-7fd1/checkout-api");
    expect(prompt).not.toContain("command=cargo test");
    expect(prompt).toContain(
      "An index exists, but WTS has not asserted that it is fresh for the current working tree.",
    );
    expect(onNotice).toHaveBeenCalledWith(
      "PLATFORM-42 · graph-informed task prepared for the workspace CLI",
    );
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
    expect(fake.runWorkspaceAgent).not.toHaveBeenCalled();
    expect(fake.listWorkspaceTestRuns).not.toHaveBeenCalled();
    expect(fake.runWorkspaceTestJourney).not.toHaveBeenCalled();
  });

  it("refreshes and renders agent-authored findings without presenting them as verification", async () => {
    const user = userEvent.setup();
    const initial = workspaceEvidenceFixture();
    const reported = workspaceEvidenceFixture({
      agentReport: {
        ...initial.agentReport,
        status: "ready",
        updatedAtUnixMs: 1_721_776_500_000,
        summary: "The retry path can create a second capture.",
        findings: [
          {
            id: "retry-idempotency",
            title: "Retry bypasses the idempotency guard",
            detail: "Capture creation happens before the prior key is restored.",
            severity: "warning",
            repositoryId: "repo_checkout",
            evidence: ["checkout-api/src/retry.rs:84"],
          },
        ],
        nextActions: ["Add a retry regression test."],
        detail:
          "Agent-authored notes loaded. WTS has not independently verified them.",
      },
    });
    const fake = fakeWorkspaceClient({ evidence: initial });
    fake.getWorkspaceEvidence
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(reported);
    const onNotice = vi.fn();

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={onNotice}
        workspaceId={initial.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Evidence and history");
    const emptyReport = await screen.findByRole("region", {
      name: "No agent findings yet",
    });
    expect(
      within(emptyReport).getByText(/agent-report\.json/),
    ).toBeVisible();
    await user.click(
      within(emptyReport).getByRole("button", {
        name: "Refresh findings",
      }),
    );

    const report = await screen.findByRole("region", {
      name: "Supporting evidence",
    });
    expect(
      within(report).getByText("AGENT-REPORTED · NOT VERIFIED"),
    ).toBeVisible();
    expect(
      within(report).getByText("Retry bypasses the idempotency guard"),
    ).toBeVisible();
    expect(
      within(report).getByText("checkout-api/src/retry.rs:84"),
    ).toBeVisible();
    expect(within(report).getByText("Add a retry regression test.")).toBeVisible();
    expect(onNotice).toHaveBeenCalledWith(
      "PLATFORM-42 · agent findings refreshed",
    );
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });

  it("leads with workspace flows and reports repository and graph coverage honestly", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const otherRepository = {
      ...base.context.repositories[0]!,
      repositoryId: "repo_notifications",
      label: "notifications",
      worktreeDisplayPath: "~/cd/platform-42-7fd1/notifications",
    };
    const evidence = workspaceEvidenceFixture({
      context: {
        ...base.context,
        repositories: [...base.context.repositories, otherRepository],
        allowedRepositoryIds: [
          ...base.context.allowedRepositoryIds,
          otherRepository.repositoryId,
        ],
      },
      agentReport: {
        ...base.agentReport,
        status: "ready",
        summary: "Checkout retries cross the API and capture service.",
        scope: {
          coverage: "partial",
          graphStatus: "ready",
          graphSha256: "older-graph-digest",
          reviewedRepositoryIds: ["repo_checkout"],
          unresolvedRepositoryIds: ["repo_notifications"],
          skippedRepositories: [],
        },
        environment: {
          status: "needsInput",
          summary:
            "Graph relationships connect the API manifest to its configuration template.",
          requirements: [
            {
              id: "node-toolchain",
              repositoryId: "repo_checkout",
              kind: "toolchain",
              name: "Node.js 22",
              required: true,
              source: "repository",
              detail: "Use the version declared by the checkout service.",
              evidence: [
                {
                  repositoryId: "repo_checkout",
                  path: ".tool-versions",
                  line: 1,
                },
              ],
            },
            {
              id: "checkout-token",
              repositoryId: "repo_checkout",
              kind: "secret",
              name: "CHECKOUT_API_TOKEN",
              required: true,
              source: "user",
              detail: "Supply the value outside WTS.",
              evidence: [
                {
                  repositoryId: "repo_checkout",
                  path: ".env.example",
                  line: 3,
                },
              ],
            },
          ],
          setupSteps: [
            {
              id: "install-checkout",
              repositoryId: "repo_checkout",
              workingDirectory: "~/cd/platform-42-7fd1/checkout-api",
              action: "Install locked dependencies.",
              command: ["npm", "ci"],
              evidence: [
                {
                  repositoryId: "repo_checkout",
                  path: "package-lock.json",
                  line: 1,
                },
              ],
            },
          ],
          unresolved: ["CHECKOUT_API_TOKEN must be supplied by the user."],
        },
        flows: [
          {
            id: "checkout-retry",
            title: "Retry a checkout capture",
            kind: "user",
            actors: ["Checkout client"],
            entryPoints: ["POST /captures"],
            steps: [
              {
                id: "accept-request",
                repositoryId: "repo_checkout",
                component: "Capture route",
                action: "Accept the idempotent capture request.",
                evidence: [
                  {
                    repositoryId: "repo_checkout",
                    path: "checkout-api/src/retry.rs",
                    line: 84,
                  },
                ],
              },
            ],
            expectedOutcome: "The original capture is returned.",
            risks: ["The restored key can race with capture creation."],
            existingCoverage: ["checkout-unit"],
            verificationCandidateIds: [],
          },
        ],
        findings: [
          {
            id: "retry-race",
            title: "Retry may create a second capture",
            detail: "The key is restored after capture creation.",
            severity: "warning",
            repositoryId: "repo_checkout",
            evidence: ["checkout-api/src/retry.rs:84"],
            flowIds: ["checkout-retry"],
          },
        ],
      },
    });
    const fake = fakeWorkspaceClient({ evidence });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Evidence and history");
    const report = await screen.findByRole("region", {
      name: "Supporting evidence",
    });
    expect(within(report).queryByRole("tablist")).not.toBeInTheDocument();
    expect(within(report).getByText("partial · 1/2 reviewed")).toBeVisible();
    expect(within(report).getByText("Snapshot changed")).toBeVisible();
    await expandReportSection(
      user,
      report,
      "System behavior (agent-reported)",
    );
    expect(within(report).getByText("Retry a checkout capture")).toBeVisible();
    expect(
      within(report).getByText("Accept the idempotent capture request."),
    ).toBeVisible();
    expect(
      within(report).getByText("checkout-api/src/retry.rs:84"),
    ).toBeVisible();
    expect(
      within(report).getByText("Retry may create a second capture"),
    ).toBeVisible();

    await expandReportSection(user, report, "Environment");
    expect(within(report).getByText("Environment setup")).toBeVisible();
    expect(within(report).getByText("Node.js 22")).toBeVisible();
    expect(within(report).getByText("CHECKOUT_API_TOKEN")).toBeVisible();
    expect(within(report).getByText("npm ci")).toBeVisible();
    expect(
      within(report).getByText(
        "CHECKOUT_API_TOKEN must be supplied by the user.",
      ),
    ).toBeVisible();

    await expandReportSection(user, report, "Suggested checks");
    expect(within(report).getByText("Repository accounting")).toBeVisible();
    expect(within(report).getByText("notifications")).toBeVisible();
    expect(within(report).getByText("unresolved")).toBeVisible();

    expect(
      within(report).getByText(/No unattached findings were reported/),
    ).toBeVisible();
  });

  it("distinguishes an unavailable graph from a changed ready snapshot", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const evidence = workspaceEvidenceFixture({
      agentReport: {
        ...base.agentReport,
        status: "ready",
        scope: {
          coverage: "partial",
          graphStatus: "failed",
          reviewedRepositoryIds: [],
          unresolvedRepositoryIds: ["repo_checkout"],
          skippedRepositories: [],
        },
      },
    });
    const fake = fakeWorkspaceClient({ evidence });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Evidence and history");
    expect(await screen.findByText("Index failed")).toBeVisible();
    expect(screen.queryByText("Snapshot changed")).not.toBeInTheDocument();
  });

  it("automatically refreshes agent evidence while the panel is visible", async () => {
    vi.useFakeTimers();
    try {
      const initial = workspaceEvidenceFixture();
      const reported = workspaceEvidenceFixture({
        agentReport: {
          ...initial.agentReport,
          status: "ready",
          summary: "The agent published a live finding.",
          findings: [
            {
              id: "live-finding",
              title: "Live evidence arrived",
              detail: "The mounted panel picked up the report.",
              severity: "info",
              repositoryId: "repo_checkout",
              evidence: ["checkout-api/src/lib.rs:12"],
            },
          ],
          detail:
            "Agent-authored notes loaded. WTS has not independently verified them.",
        },
      });
      const fake = fakeWorkspaceClient({ evidence: initial });
      fake.getWorkspaceEvidence
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(reported);
      const onNotice = vi.fn();

      render(
        <VerificationPanel
          client={fake.client}
          materialized
          onNotice={onNotice}
          workspaceId={initial.context.workspaceId}
          workspaceKey="PLATFORM-42"
        />,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2);
      expect(screen.getByText("Available")).toBeVisible();
      expect(onNotice).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never overlaps automatic or manual evidence refresh requests", async () => {
    vi.useFakeTimers();
    try {
      const evidence = workspaceEvidenceFixture();
      const pendingRefresh = deferred<typeof evidence>();
      const fake = fakeWorkspaceClient({ evidence });
      fake.getWorkspaceEvidence
        .mockResolvedValueOnce(evidence)
        .mockImplementationOnce(() => pendingRefresh.promise)
        .mockResolvedValue(evidence);

      render(
        <VerificationPanel
          client={fake.client}
          materialized
          onNotice={vi.fn()}
          workspaceId={evidence.context.workspaceId}
          workspaceKey="PLATFORM-42"
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status")).toHaveTextContent(
        "Live · checking…",
      );
      expect(
        screen.getByRole("region", { name: "No agent findings yet" }),
      ).toHaveAttribute("aria-busy", "true");

      await act(async () => {
        screen.getByRole("button", { name: "Refresh findings" }).click();
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2);

      await act(async () => {
        pendingRefresh.resolve(evidence);
        await pendingRefresh.promise;
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses live refresh while hidden and checks immediately when visible", async () => {
    vi.useFakeTimers();
    const ownVisibility = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    try {
      const evidence = workspaceEvidenceFixture();
      const fake = fakeWorkspaceClient({ evidence });

      render(
        <VerificationPanel
          client={fake.client}
          materialized
          onNotice={vi.fn()}
          workspaceId={evidence.context.workspaceId}
          workspaceKey="PLATFORM-42"
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(1);

      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2);
    } finally {
      if (ownVisibility) {
        Object.defineProperty(document, "visibilityState", ownVisibility);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
      vi.useRealTimers();
    }
  });

  it("explains how to recover from an invalid agent report", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const invalid = workspaceEvidenceFixture({
      agentReport: {
        ...base.agentReport,
        status: "invalid",
        detail: "findings[0].severity must be info, warning, or critical.",
      },
    });
    const fake = fakeWorkspaceClient({ evidence: invalid });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={invalid.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Evidence and history");
    const alert = await screen.findByRole("alert");
    expect(
      within(alert).getByText("WTS could not use this report."),
    ).toBeVisible();
    expect(within(alert).getByText(invalid.agentReport.detail)).toBeVisible();
    expect(within(alert).getByText(invalid.agentReport.displayPath)).toBeVisible();
    expect(
      within(alert).getByText(/save valid report JSON, then refresh/i),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Refresh findings" }),
    ).toBeEnabled();
  });

  it("cleans up the live-refresh timer when the panel unmounts", async () => {
    vi.useFakeTimers();
    try {
      const evidence = workspaceEvidenceFixture();
      const fake = fakeWorkspaceClient({ evidence });
      const view = render(
        <VerificationPanel
          client={fake.client}
          materialized
          onNotice={vi.fn()}
          workspaceId={evidence.context.workspaceId}
          workspaceKey="PLATFORM-42"
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });

      view.unmount();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("promotes a reviewed agent check and keeps validation flows review-only", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const proposal = {
      id: "retry-cargo-test",
      label: "Checkout retry unit tests",
      kind: "unit" as const,
      repositoryId: "repo_checkout",
      workingDirectory: base.context.repositories[0]!.worktreeDisplayPath,
      executable: "cargo",
      args: ["test", "--quiet"],
      timeoutMs: 120_000,
      environmentNames: ["CI"],
      reason: "The retry behavior is owned by the checkout API crate.",
      evidence: ["checkout-api/src/retry.rs:84"],
    };
    const reported = workspaceEvidenceFixture({
      agentReport: {
        ...base.agentReport,
        status: "ready",
        updatedAtUnixMs: 1_721_776_500_000,
        summary: "A deterministic retry check and a manual flow are available.",
        proposedChecks: [proposal],
        validationFlows: [
          {
            id: "retry-flow",
            title: "Repeat a checkout capture",
            goal: "Confirm the retry remains idempotent.",
            prerequisites: ["A checkout with an idempotency key."],
            steps: [
              {
                id: "submit-twice",
                action: "Submit the same capture request twice.",
                expected: "The original capture is returned.",
                evidence: ["checkout-api/src/retry.rs:84"],
              },
            ],
          },
        ],
        detail:
          "Agent-authored notes loaded. WTS has not independently verified them.",
      },
    });
    const promoted = workspaceEvidenceFixture({
      agentReport: reported.agentReport,
      verificationPlan: {
        ...reported.verificationPlan,
        revision: reported.verificationPlan.revision + 1,
        checks: [
          ...reported.verificationPlan.checks,
          {
            id: "agent-retry-cargo-test",
            label: proposal.label,
            kind: proposal.kind,
            repositoryId: proposal.repositoryId,
            workingDirectory: proposal.workingDirectory,
            executable: proposal.executable,
            args: proposal.args,
            timeoutMs: proposal.timeoutMs,
            outputLimitBytes: 1_048_576,
            required: true,
            environmentNames: proposal.environmentNames,
            acceptanceFiles: [],
          },
        ],
      },
      verificationResult: {
        ...reported.verificationResult,
        planRevision: reported.verificationPlan.revision + 1,
        status: "notRun",
        startedAtUnixMs: null,
        completedAtUnixMs: null,
        durationMs: null,
        checks: [],
      },
    });
    const fake = fakeWorkspaceClient({ evidence: reported });
    fake.promoteAgentVerificationCheck.mockResolvedValue(promoted);
    const onNotice = vi.fn();

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={onNotice}
        workspaceId={reported.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Evidence and history");
    const report = await screen.findByRole("region", {
      name: "Supporting evidence",
    });
    await expandReportSection(user, report, "Suggested checks");
    expect(within(report).getByText("Proposed checks")).toBeVisible();
    expect(within(report).getByText("cargo test --quiet")).toBeVisible();
    await expandReportSection(
      user,
      report,
      "System behavior (agent-reported)",
    );
    expect(within(report).getByText("System behavior")).toBeVisible();
    await user.click(
      within(report).getByText("Repeat a checkout capture"),
    );
    expect(
      within(report).getByText("Expected: The original capture is returned."),
    ).toBeVisible();
    await user.click(
      within(report).getByRole("button", {
        name: "Add to verification",
      }),
    );

    expect(fake.promoteAgentVerificationCheck).toHaveBeenCalledWith(
      reported.context.workspaceId,
      "retry-cargo-test",
    );
    expect(
      await within(report).findByRole("button", { name: "Added to plan" }),
    ).toBeDisabled();
    expect(onNotice).toHaveBeenCalledWith(
      "PLATFORM-42 · reviewed check added; ready to run",
    );
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])("ignores a graph build that finishes after changing workspace (%s)", async (outcome) => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const previous = workspaceEvidenceFixture({
      graphManifest: { ...base.graphManifest, status: "notStarted" },
    });
    const current = workspaceEvidenceFixture({
      context: { ...base.context, workspaceId: "workspace-current" },
    });
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceEvidence.mockImplementation(async (id) => id === current.context.workspaceId ? current : previous);
    const graph = deferred<unknown>();
    const onNotice = vi.fn();
    const props = { client: fake.client, materialized: true, onNotice, onIndexGraph: () => graph.promise, onPrepareCliTask: vi.fn() };
    const view = render(<VerificationPanel {...props} workspaceId={previous.context.workspaceId} workspaceKey="PREVIOUS" />);
    await expandOptionalSection(user, "Improve coverage");
    await user.click(screen.getByRole("button", { name: "Build graph" }));
    view.rerender(<VerificationPanel {...props} workspaceId={current.context.workspaceId} workspaceKey="CURRENT" />);
    await screen.findByRole("button", { name: "Prepare verification brief" });
    await act(async () => {
      if (outcome === "resolve") graph.resolve(undefined);
      else graph.reject(new Error("Previous workspace graph failed."));
    });
    expect(screen.getByRole("button", { name: "Prepare verification brief" })).toBeEnabled();
    expect(screen.queryByText("Previous workspace graph failed.")).not.toBeInTheDocument();
    expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2);
    expect(onNotice).not.toHaveBeenCalledWith("PREVIOUS · workspace graph ready");
    expect(onNotice).not.toHaveBeenCalledWith("PREVIOUS · workspace graph could not be built");
  });

  it("keeps an accepted check in its original workspace after navigation", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const previous = workspaceEvidenceFixture({ agentReport: {
      ...base.agentReport,
      status: "ready",
      proposedChecks: [{
        id: "previous-check", label: "Previous workspace check", kind: "unit",
        repositoryId: "repo_checkout", workingDirectory: base.context.repositories[0]!.worktreeDisplayPath,
        executable: "cargo", args: ["test"], timeoutMs: 120_000, environmentNames: [],
        reason: "Check the previous workspace.", evidence: ["src/lib.rs"],
      }],
    } });
    const current = workspaceEvidenceFixture({
      context: { ...base.context, workspaceId: "workspace-current" },
      verificationPlan: { ...base.verificationPlan, checks: [{ ...base.verificationPlan.checks[0]!, label: "Current workspace check" }] },
    });
    const fake = fakeWorkspaceClient();
    fake.getWorkspaceEvidence.mockImplementation(async (id) => id === current.context.workspaceId ? current : previous);
    const promotion = deferred<typeof previous>();
    fake.promoteAgentVerificationCheck.mockReturnValue(promotion.promise);
    const props = { client: fake.client, materialized: true, onNotice: vi.fn() };
    const view = render(<VerificationPanel {...props} workspaceId={previous.context.workspaceId} workspaceKey="PREVIOUS" />);
    await expandOptionalSection(user, "Evidence and history");
    const report = await screen.findByRole("region", { name: "Supporting evidence" });
    await expandReportSection(user, report, "Suggested checks");
    await user.click(within(report).getByRole("button", { name: "Add to verification" }));
    view.rerender(<VerificationPanel {...props} workspaceId={current.context.workspaceId} workspaceKey="CURRENT" />);
    await screen.findByText("Current workspace check");
    await act(async () => promotion.resolve(previous));
    expect(screen.getByText("Current workspace check")).toBeVisible();
    expect(props.onNotice).not.toHaveBeenCalledWith("PREVIOUS · reviewed check added; ready to run");
  });

  it("builds and reloads graph evidence before offering an agent brief", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const evidence = workspaceEvidenceFixture({
      graphManifest: {
        schemaVersion: 1,
        workspaceId: base.context.workspaceId,
        status: "notStarted",
        graphDisplayPath: null,
        graphSha256: null,
        indexedAtUnixMs: null,
        indexedRepositories: [],
        detail: "Workspace-local Graphify indexing has not started.",
      },
    });
    const fake = fakeWorkspaceClient({ evidence });
    const readyEvidence = workspaceEvidenceFixture();
    fake.getWorkspaceEvidence
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce(readyEvidence)
      .mockResolvedValue(readyEvidence);
    const onPrepareCliTask = vi.fn();
    const onIndexGraph = vi.fn().mockResolvedValue(undefined);

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onIndexGraph={onIndexGraph}
        onNotice={vi.fn()}
        onPrepareCliTask={onPrepareCliTask}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await expandOptionalSection(user, "Improve coverage");
    const planning = await screen.findByRole("region", {
      name: "Find gaps in verification",
    });
    const buildGraphButton = within(planning).getByRole("button", {
      name: "Build graph",
    });
    expect(buildGraphButton).toBeEnabled();
    expect(
      within(planning).queryByRole("button", {
        name: "Prepare verification brief",
      }),
    ).not.toBeInTheDocument();
    await user.click(buildGraphButton);

    expect(onIndexGraph).toHaveBeenCalledOnce();
    const readyPlanning = await screen.findByRole("region", {
      name: "Find gaps in verification",
    });
    const actions = within(readyPlanning).getByRole("group", {
      name: "Coverage actions",
    });
    expect(
      within(actions).getByRole("button", {
        name: "Prepare verification brief",
      }),
    ).toBeEnabled();
    await user.click(
      within(actions).getByRole("button", {
        name: "Rebuild graph",
      }),
    );
    expect(onIndexGraph).toHaveBeenCalledTimes(2);
    expect(onPrepareCliTask).not.toHaveBeenCalled();
    expect(fake.indexWorkspaceGraph).not.toHaveBeenCalled();
    expect(fake.runWorkspaceAgent).not.toHaveBeenCalled();
  });

  it("turns an empty verification plan into one actionable next step", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const evidence = workspaceEvidenceFixture({
      graphManifest: {
        schemaVersion: 1,
        workspaceId: base.context.workspaceId,
        status: "notStarted",
        graphDisplayPath: null,
        graphSha256: null,
        indexedAtUnixMs: null,
        indexedRepositories: [],
        detail: "Workspace-local Graphify indexing has not started.",
      },
      verificationPlan: {
        ...base.verificationPlan,
        checks: [],
      },
      verificationResult: {
        ...base.verificationResult,
        checks: [],
      },
    });
    const fake = fakeWorkspaceClient({ evidence });
    const onIndexGraph = vi.fn().mockResolvedValue(undefined);

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onIndexGraph={onIndexGraph}
        onNotice={vi.fn()}
        onPrepareCliTask={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const discovery = await screen.findByRole("region", {
      name: "No runnable checks discovered",
    });
    expect(
      within(discovery).getByText(
        "Build the workspace graph, then ask an agent to identify candidate commands from repository evidence.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Run all" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Add a supported verification check"),
    ).not.toBeInTheDocument();

    await user.click(
      within(discovery).getByRole("button", { name: "Build graph" }),
    );

    expect(onIndexGraph).toHaveBeenCalledOnce();
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });

  it("offers a verification brief directly when an empty plan already has a graph", async () => {
    const user = userEvent.setup();
    const base = workspaceEvidenceFixture();
    const evidence = workspaceEvidenceFixture({
      verificationPlan: {
        ...base.verificationPlan,
        checks: [],
      },
      verificationResult: {
        ...base.verificationResult,
        checks: [],
      },
    });
    const fake = fakeWorkspaceClient({ evidence });
    const onPrepareCliTask = vi.fn();

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        onPrepareCliTask={onPrepareCliTask}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    const discovery = await screen.findByRole("region", {
      name: "No runnable checks discovered",
    });
    await user.click(
      within(discovery).getByRole("button", {
        name: "Prepare verification brief",
      }),
    );

    expect(onPrepareCliTask).toHaveBeenCalledOnce();
    expect(onPrepareCliTask.mock.calls[0]?.[0]).toContain(
      "Prefer existing scripts and the checks in `.wts/verification-plan.json`",
    );
  });

  it("runs the discovered deterministic checks from Run all", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const verificationRun = workspaceEvidenceFixture({
      verificationResult: {
        ...evidence.verificationResult,
        status: "passed",
        checks: evidence.verificationResult.checks.map((check) => ({
          ...check,
          status: "passed",
          exitCode: 0,
          detail: "Passed.",
        })),
      },
    });
    const fake = fakeWorkspaceClient({ evidence, verificationRun });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Run all" }));

    expect(fake.runWorkspaceVerification).toHaveBeenCalledWith(
      evidence.context.workspaceId,
    );
    expect(
      await screen.findByRole("heading", { name: "Passed" }),
    ).toBeVisible();
  });

  it("sends a notification when a verification run finishes with a failed check", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient({ evidence, verificationRun: evidence });
    const onVerificationFailed = vi.fn();
    const notifications: Array<{
      title: string;
      options?: NotificationOptions;
    }> = [];
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      static async requestPermission() {
        return FakeNotification.permission;
      }
      constructor(title: string, options?: NotificationOptions) {
        notifications.push({ title, options });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    localStorage.setItem(
      "wts.time-review-schedule.v1",
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        intervalHours: 4,
        startedAtUnixMs: 0,
        lastSuccessfulAtUnixMs: null,
        notificationsEnabled: true,
      }),
    );
    try {
      render(
        <VerificationPanel
          client={fake.client}
          materialized
          onNotice={vi.fn()}
          onVerificationFailed={onVerificationFailed}
          workspaceId={evidence.context.workspaceId}
          workspaceKey="PLATFORM-42"
        />,
      );

      await user.click(await screen.findByRole("button", { name: "Run all" }));

      await waitFor(() =>
        expect(notifications).toEqual([
          {
            title: "PLATFORM-42 verification failed",
            options: {
              body: "Checkout unit tests: Expected one capture, received two.",
              tag: `wts-verification-${evidence.context.workspaceId}`,
            },
          },
        ]),
      );
      expect(onVerificationFailed).toHaveBeenCalledOnce();
    } finally {
      localStorage.removeItem("wts.time-review-schedule.v1");
      vi.unstubAllGlobals();
    }
  });

  it("refreshes visible check progress while the run request is pending", async () => {
    vi.useFakeTimers();
    try {
      const evidence = workspaceEvidenceFixture();
      const pendingRun = deferred<typeof evidence>();
      const active = workspaceEvidenceFixture({
        verificationResult: {
          ...evidence.verificationResult,
          status: "running",
          startedAtUnixMs: Date.now(),
          completedAtUnixMs: null,
          checks: evidence.verificationResult.checks.map((check, index) => ({
            ...check,
            status: index === 0 ? "running" : "pending",
            exitCode: null,
            detail: index === 0 ? "WTS runs this check." : "This check waits.",
          })),
        },
      });
      const fake = fakeWorkspaceClient({ evidence });
      fake.runWorkspaceVerification.mockReturnValue(pendingRun.promise);
      fake.getWorkspaceEvidence
        .mockResolvedValueOnce(evidence)
        .mockResolvedValue(active);

      render(
        <VerificationPanel
          client={fake.client}
          materialized
          onNotice={vi.fn()}
          workspaceId={evidence.context.workspaceId}
          workspaceKey="PLATFORM-42"
        />,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole("button", { name: "Run all" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("heading", { name: "Active" })).toBeVisible();

      pendingRun.resolve(active);
      await act(async () => {
        await pendingRun.promise;
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replace a completed run with an older progress response", async () => {
    vi.useFakeTimers();
    try {
      const evidence = workspaceEvidenceFixture();
      const staleProgress = deferred<typeof evidence>();
      const pendingRun = deferred<typeof evidence>();
      const active = workspaceEvidenceFixture({
        verificationResult: {
          ...evidence.verificationResult,
          status: "running",
          startedAtUnixMs: Date.now(),
          completedAtUnixMs: null,
          checks: evidence.verificationResult.checks.map((check, index) => ({
            ...check,
            status: index === 0 ? "running" : "pending",
            exitCode: null,
            detail: index === 0 ? "WTS runs this check." : "This check waits.",
          })),
        },
      });
      const passed = workspaceEvidenceFixture({
        verificationResult: {
          ...evidence.verificationResult,
          status: "passed",
          checks: evidence.verificationResult.checks.map((check) => ({
            ...check,
            status: "passed",
            exitCode: 0,
            detail: "Passed.",
          })),
        },
      });
      const fake = fakeWorkspaceClient({ evidence });
      fake.runWorkspaceVerification.mockReturnValue(pendingRun.promise);
      fake.getWorkspaceEvidence
        .mockResolvedValueOnce(evidence)
        .mockReturnValueOnce(staleProgress.promise);

      render(
        <VerificationPanel
          client={fake.client}
          materialized
          onNotice={vi.fn()}
          workspaceId={evidence.context.workspaceId}
          workspaceKey="PLATFORM-42"
        />,
      );

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole("button", { name: "Run all" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2);

      await act(async () => {
        pendingRun.resolve(passed);
        await pendingRun.promise;
      });
      expect(screen.getByRole("heading", { name: "Passed" })).toBeVisible();

      await act(async () => {
        staleProgress.resolve(active);
        await staleProgress.promise;
      });
      expect(screen.getByRole("heading", { name: "Passed" })).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Active" }),
      ).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs one check or only failed checks when the client supports it", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const rerunFailedWorkspaceVerification = vi
      .fn()
      .mockResolvedValue(evidence);
    const passed = workspaceEvidenceFixture({
      verificationResult: {
        ...evidence.verificationResult,
        status: "passed",
        checks: evidence.verificationResult.checks.map((check) => ({
          ...check,
          status: "passed",
          exitCode: 0,
          detail: "Passed.",
        })),
      },
    });
    const runWorkspaceVerificationCheck = vi.fn().mockResolvedValue(passed);
    const fake = fakeWorkspaceClient({ evidence });

    render(
      <VerificationPanel
        client={{
          ...fake.client,
          rerunFailedWorkspaceVerification,
          runWorkspaceVerificationCheck,
        }}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(
      await screen.findByRole("button", { name: "Rerun failed" }),
    );
    expect(rerunFailedWorkspaceVerification).toHaveBeenCalledWith(
      evidence.context.workspaceId,
    );

    await user.click(screen.getByRole("button", { name: "Run again" }));
    expect(runWorkspaceVerificationCheck).toHaveBeenCalledWith(
      evidence.context.workspaceId,
      "checkout-unit",
    );
    expect(
      await screen.findByRole("heading", { name: "Passed" }),
    ).toBeVisible();
  });

  it("cancels an in-progress verification run and preserves a cancelled state", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const pendingRun = deferred<typeof evidence>();
    const cancelled = workspaceEvidenceFixture({
      verificationResult: {
        ...evidence.verificationResult,
        status: "cancelled",
        checks: evidence.verificationResult.checks.map((check) => ({
          ...check,
          status: "cancelled",
          exitCode: null,
          detail: "Cancelled by the user.",
        })),
      },
    });
    const fake = fakeWorkspaceClient({ evidence });
    fake.runWorkspaceVerification.mockImplementation(() => pendingRun.promise);
    const cancelWorkspaceVerification = vi.fn().mockResolvedValue(cancelled);

    render(
      <VerificationPanel
        client={{ ...fake.client, cancelWorkspaceVerification }}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Run all" }));
    expect(
      screen.getByRole("button", { name: "Cancel run" }),
    ).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel run" }));

    expect(cancelWorkspaceVerification).toHaveBeenCalledWith(
      evidence.context.workspaceId,
    );
    expect(
      await screen.findByRole("heading", { name: "Cancelled" }),
    ).toBeVisible();
    expect(screen.getByText(/completed check evidence is preserved/i)).toBeVisible();
  });

  it("keeps a reopened host run cancellable until a terminal progress read", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const running = workspaceEvidenceFixture({ verificationResult: { ...evidence.verificationResult, status: "running" } });
    const cancelled = workspaceEvidenceFixture({ verificationResult: { ...evidence.verificationResult, status: "cancelled" } });
    const fake = fakeWorkspaceClient({ evidence: running });
    const cancelWorkspaceVerification = vi.fn().mockResolvedValue(running);
    render(<VerificationPanel client={{ ...fake.client, cancelWorkspaceVerification }} materialized onNotice={vi.fn()} workspaceId={evidence.context.workspaceId} workspaceKey="PLATFORM-42" />);

    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    expect(screen.getByRole("button", { name: "Run in progress" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel in progress" })).toBeDisabled();
    fake.getWorkspaceEvidence.mockResolvedValue(cancelled);
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByRole("heading", { name: "Cancelled" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled();
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });

  it.each(["running acknowledgement", "rejected acknowledgement"] as const)("keeps newer terminal progress after a late %s", async (outcome) => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const running = workspaceEvidenceFixture({ verificationResult: { ...evidence.verificationResult, status: "running" } });
    const cancelled = workspaceEvidenceFixture({ verificationResult: { ...evidence.verificationResult, status: "cancelled" } });
    const pendingCancellation = deferred<typeof evidence>();
    const fake = fakeWorkspaceClient({ evidence: running });
    const cancelWorkspaceVerification = vi.fn().mockReturnValue(pendingCancellation.promise);
    render(<VerificationPanel client={{ ...fake.client, cancelWorkspaceVerification }} materialized onNotice={vi.fn()} workspaceId={evidence.context.workspaceId} workspaceKey="PLATFORM-42" />);

    await user.click(await screen.findByRole("button", { name: "Cancel run" }));
    expect(screen.getByRole("button", { name: "Cancel in progress" })).toBeDisabled();
    fake.getWorkspaceEvidence.mockResolvedValue(cancelled);
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByRole("heading", { name: "Cancelled" })).toBeVisible();
    await act(async () => {
      if (outcome === "running acknowledgement") pendingCancellation.resolve(running);
      else pendingCancellation.reject(new Error("The old cancellation request failed."));
      await pendingCancellation.promise.catch(() => undefined);
    });
    expect(screen.getByRole("heading", { name: "Cancelled" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Cancel (run|in progress)/ })).not.toBeInTheDocument();
    expect(screen.queryByText("The old cancellation request failed.")).not.toBeInTheDocument();
    expect(fake.runWorkspaceVerification).not.toHaveBeenCalled();
  });

  it("rejects pre-cancel progress after a terminal cancellation acknowledgement", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const running = workspaceEvidenceFixture({ verificationResult: { ...evidence.verificationResult, status: "running" } });
    const cancelled = workspaceEvidenceFixture({ verificationResult: { ...evidence.verificationResult, status: "cancelled" } });
    const pendingProgress = deferred<typeof evidence>();
    const fake = fakeWorkspaceClient({ evidence: running });
    const cancelWorkspaceVerification = vi.fn().mockResolvedValue(cancelled);
    render(<VerificationPanel client={{ ...fake.client, cancelWorkspaceVerification }} materialized onNotice={vi.fn()} workspaceId={evidence.context.workspaceId} workspaceKey="PLATFORM-42" />);

    await screen.findByRole("button", { name: "Cancel run" });
    fake.getWorkspaceEvidence.mockReturnValueOnce(pendingProgress.promise);
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByRole("heading", { name: "Cancelled" })).toBeVisible();
    await act(async () => { pendingProgress.resolve(running); await pendingProgress.promise; });
    expect(screen.getByRole("heading", { name: "Cancelled" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled();
  });

  it("accepts the original completion when cancellation returns a running snapshot", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const pendingRun = deferred<typeof evidence>();
    const running = workspaceEvidenceFixture({ verificationResult: { ...evidence.verificationResult, status: "running" } });
    const cancelled = workspaceEvidenceFixture({ verificationResult: { ...evidence.verificationResult, status: "cancelled" } });
    const fake = fakeWorkspaceClient({ evidence });
    fake.runWorkspaceVerification.mockReturnValue(pendingRun.promise);
    const cancelWorkspaceVerification = vi.fn().mockResolvedValue(running);
    render(<VerificationPanel client={{ ...fake.client, cancelWorkspaceVerification }} materialized onNotice={vi.fn()} workspaceId={evidence.context.workspaceId} workspaceKey="PLATFORM-42" />);

    await user.click(await screen.findByRole("button", { name: "Run all" }));
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(screen.getByRole("button", { name: "Cancel in progress" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Run in progress" })).toBeDisabled();
    await act(async () => { pendingRun.resolve(cancelled); await pendingRun.promise; });
    expect(await screen.findByRole("heading", { name: "Cancelled" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled();
  });

  it("keeps tracking an active run when a failed progress read is retried", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const pendingRun = deferred<typeof evidence>();
    const passed = workspaceEvidenceFixture({
      verificationResult: {
        ...evidence.verificationResult,
        status: "passed",
        checks: evidence.verificationResult.checks.map((check) => ({ ...check, status: "passed", exitCode: 0, detail: "Passed." })),
      },
    });
    const fake = fakeWorkspaceClient({ evidence });
    fake.runWorkspaceVerification.mockReturnValue(pendingRun.promise);
    fake.getWorkspaceEvidence
      .mockResolvedValueOnce(evidence)
      .mockRejectedValueOnce(new Error("Progress could not be read."))
      .mockResolvedValueOnce(evidence);
    render(<VerificationPanel client={fake.client} materialized onNotice={vi.fn()} workspaceId={evidence.context.workspaceId} workspaceKey="PLATFORM-42" />);

    await user.click(await screen.findByRole("button", { name: "Run all" }));
    fireEvent(document, new Event("visibilitychange"));
    await screen.findByText("Progress could not be read.");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(fake.getWorkspaceEvidence).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "All checks are active" })).toBeDisabled();
    await act(async () => { pendingRun.resolve(passed); await pendingRun.promise; });
    expect(await screen.findByRole("heading", { name: "Passed" })).toBeVisible();
    expect(fake.runWorkspaceVerification).toHaveBeenCalledOnce();
  });

  it("keeps an active run cancellable after a rejected cancellation", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const pendingRun = deferred<typeof evidence>();
    const cancelled = workspaceEvidenceFixture({
      verificationResult: { ...evidence.verificationResult, status: "cancelled" },
    });
    const fake = fakeWorkspaceClient({ evidence });
    fake.runWorkspaceVerification.mockReturnValue(pendingRun.promise);
    const cancelWorkspaceVerification = vi.fn()
      .mockRejectedValueOnce(new Error("The cancellation request failed."))
      .mockResolvedValueOnce(cancelled);
    render(<VerificationPanel client={{ ...fake.client, cancelWorkspaceVerification }} materialized onNotice={vi.fn()} workspaceId={evidence.context.workspaceId} workspaceKey="PLATFORM-42" />);

    await user.click(await screen.findByRole("button", { name: "Run all" }));
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(await screen.findByText("The cancellation request failed.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel run" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "All checks are active" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(cancelWorkspaceVerification).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("heading", { name: "Cancelled" })).toBeVisible();
    expect(screen.queryByText("The cancellation request failed.")).not.toBeInTheDocument();
  });

  it("does not restore an active run after run failure overtakes a pending cancellation", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const pendingRun = deferred<typeof evidence>();
    const pendingCancellation = deferred<typeof evidence>();
    const fake = fakeWorkspaceClient({ evidence });
    fake.runWorkspaceVerification.mockReturnValue(pendingRun.promise);
    const cancelWorkspaceVerification = vi.fn().mockReturnValue(pendingCancellation.promise);
    render(<VerificationPanel client={{ ...fake.client, cancelWorkspaceVerification }} materialized onNotice={vi.fn()} workspaceId={evidence.context.workspaceId} workspaceKey="PLATFORM-42" />);

    await user.click(await screen.findByRole("button", { name: "Run all" }));
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    await act(async () => { pendingRun.reject(new Error("The run request failed.")); });
    expect(await screen.findByText("The run request failed.")).toBeVisible();
    await act(async () => { pendingCancellation.reject(new Error("The cancellation request failed.")); });
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled();
    expect(screen.getByText("The run request failed.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Cancel run" })).not.toBeInTheDocument();
  });

  it("accepts the original run completion after a rejected cancellation", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const pendingRun = deferred<typeof evidence>();
    const passed = workspaceEvidenceFixture({
      verificationResult: {
        ...evidence.verificationResult,
        status: "passed",
        checks: evidence.verificationResult.checks.map((check) => ({ ...check, status: "passed", exitCode: 0, detail: "Passed." })),
      },
    });
    const fake = fakeWorkspaceClient({ evidence });
    fake.runWorkspaceVerification.mockReturnValue(pendingRun.promise);
    const cancelWorkspaceVerification = vi.fn().mockRejectedValue(new Error("The cancellation request failed."));
    render(<VerificationPanel client={{ ...fake.client, cancelWorkspaceVerification }} materialized onNotice={vi.fn()} workspaceId={evidence.context.workspaceId} workspaceKey="PLATFORM-42" />);

    await user.click(await screen.findByRole("button", { name: "Run all" }));
    await user.click(screen.getByRole("button", { name: "Cancel run" }));
    await screen.findByText("The cancellation request failed.");
    await act(async () => { pendingRun.resolve(passed); await pendingRun.promise; });
    expect(await screen.findByRole("heading", { name: "Passed" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Run all" })).toBeEnabled();
    expect(screen.queryByText("The cancellation request failed.")).not.toBeInTheDocument();
  });

  it("keeps command output and bounded log details disclosed on demand", async () => {
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient({ evidence });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await screen.findByText("Checkout unit tests");
    expect(
      screen.getByLabelText("Checkout unit tests result detail"),
    ).not.toBeVisible();
    await user.click(screen.getByText("Checkout unit tests"));
    expect(
      screen.getByLabelText("Checkout unit tests result detail"),
    ).toBeVisible();
    expect(
      screen.getByText(evidence.verificationResult.checks[0]!.logDisplayPath!),
    ).toBeVisible();
  });

  it("lets the user opt in to automatic agent review", async () => {
    localStorage.removeItem("wts.workspace-automation.v1");
    const user = userEvent.setup();
    const evidence = workspaceEvidenceFixture();
    const fake = fakeWorkspaceClient({ evidence });

    render(
      <VerificationPanel
        client={fake.client}
        materialized
        onNotice={vi.fn()}
        workspaceId={evidence.context.workspaceId}
        workspaceKey="PLATFORM-42"
      />,
    );

    await screen.findByRole("heading", { name: "Failed" });
    await user.click(screen.getByText("After agent work"));
    const checks = screen.getByRole("checkbox", {
      name: /Run deterministic checks/i,
    });
    const agentReview = screen.getByRole("checkbox", {
      name: /Ask an agent for review guidance/i,
    });
    expect(checks).toBeChecked();
    expect(agentReview).not.toBeChecked();

    await user.click(agentReview);

    expect(
      JSON.parse(localStorage.getItem("wts.workspace-automation.v1") ?? "{}"),
    ).toMatchObject({
      automaticVerification: true,
      automaticAgentReview: true,
    });
    localStorage.removeItem("wts.workspace-automation.v1");
  });

  it("keeps the prepared CLI task within the legacy prompt budget", () => {
    const base = workspaceEvidenceFixture();
    const longValue = "界".repeat(800);
    const repositories = Array.from({ length: 16 }, (_, index) => ({
      ...base.context.repositories[0]!,
      repositoryId: `repo_${index}_${longValue}`,
      label: `repository-${index}-${longValue}`,
      worktreeDisplayPath: `/workspace/repository-${index}-${longValue}`,
    }));
    const checks = Array.from({ length: 16 }, (_, index) => ({
      ...base.verificationPlan.checks[0]!,
      id: `check-${index}`,
      label: `check-${index}-${longValue}`,
      repositoryId: repositories[index]!.repositoryId,
      workingDirectory: repositories[index]!.worktreeDisplayPath,
      args: ["test", longValue],
    }));
    const evidence = workspaceEvidenceFixture({
      context: {
        ...base.context,
        repositories,
        allowedRepositoryIds: repositories.map(
          (repository) => repository.repositoryId,
        ),
      },
      verificationPlan: {
        ...base.verificationPlan,
        checks,
      },
    });

    const prompt = buildGraphVerificationPlanningPrompt(evidence);

    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(4 * 1024);
    expect(prompt).toContain("Read WTS.md from the workspace root first.");
    expect(prompt).not.toContain(longValue);
    expect(prompt).toMatch(
      /Do not modify verification plans, assertions, logs, graph output, or \.wts files directly; publish findings through wts-report\.$/,
    );
  });
});
