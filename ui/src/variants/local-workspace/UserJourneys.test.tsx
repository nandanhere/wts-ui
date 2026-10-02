import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  WorkspaceClient,
  WorkspaceTestRunDetail,
  WorkspaceTestRunSummary,
} from "../../lib/wtsClient";
import { UserJourneys } from "./UserJourneys";

const workspaceId = "ws-local-journey";

function run(
  overrides: Partial<WorkspaceTestRunSummary> = {},
): WorkspaceTestRunSummary {
  return {
    schemaVersion: 1,
    runId: "run-help-001",
    workspaceId,
    journeyId: "wts-help-preferences",
    title: "Help and Preferences",
    state: "passed",
    startedAtUnixMs: 1_721_776_401_000,
    completedAtUnixMs: 1_721_776_402_240,
    durationMs: 1_240,
    passedSteps: 12,
    failedSteps: 0,
    totalSteps: 12,
    failedStepId: null,
    message: null,
    artifactsDisplayPath: "/tmp/wts/runs/run-help-001",
    graphSha256: null,
    ...overrides,
  };
}

function detail(
  summary: WorkspaceTestRunSummary = run(),
): WorkspaceTestRunDetail {
  return {
    schemaVersion: 1,
    runId: summary.runId,
    workspaceId: summary.workspaceId,
    journeyId: summary.journeyId,
    state: summary.state === "running" ? "cancelled" : summary.state,
    startedAtUnixMs: summary.startedAtUnixMs,
    completedAtUnixMs: summary.completedAtUnixMs ?? summary.startedAtUnixMs,
    durationMs: summary.durationMs ?? 0,
    steps: [],
    consoleErrors: [],
    requests: [],
    artifacts: [
      {
        artifactId: "failure-screenshot",
        kind: "failureScreenshot",
        relativePath: "failure.png",
        displayPath: `${summary.artifactsDisplayPath}/failure.png`,
        bytes: 128,
        sha256: "a".repeat(64),
      },
    ],
    failure:
      summary.state === "passed"
        ? null
        : {
            failedStepId: summary.failedStepId,
            failedStepKind: "assertVisible",
            name: "AssertionError",
            message: summary.message ?? "Journey failed.",
            consoleErrors: [],
            failedRequests: [],
            artifactIds: ["failure-screenshot"],
          },
    graphSha256: summary.graphSha256,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function clientWithJourneys(options: {
  runs?: WorkspaceTestRunSummary[];
  result?: WorkspaceTestRunSummary;
  detail?: WorkspaceTestRunDetail;
}) {
  const listWorkspaceTestRuns = vi
    .fn()
    .mockResolvedValue({
      schemaVersion: 1,
      workspaceId,
      runs: options.runs ?? [],
    });
  const runWorkspaceTestJourney = vi
    .fn()
    .mockResolvedValue(options.result ?? run());
  const getWorkspaceTestRun = vi
    .fn()
    .mockResolvedValue(
      options.detail ??
        detail(options.result ?? options.runs?.[0] ?? run()),
    );
  return {
    client: {
      listWorkspaceTestRuns,
      getWorkspaceTestRun,
      runWorkspaceTestJourney,
    } as unknown as WorkspaceClient,
    listWorkspaceTestRuns,
    getWorkspaceTestRun,
    runWorkspaceTestJourney,
  };
}

describe("UserJourneys", () => {
  it("runs the built-in deterministic journey against the current loopback origin", async () => {
    const user = userEvent.setup();
    const fake = clientWithJourneys({ result: run() });
    const onNotice = vi.fn();

    render(
      <UserJourneys
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
        onNotice={onNotice}
      />,
    );

    expect(
      await screen.findByRole("heading", {
        name: "Test the workflow a user sees",
      }),
    ).toBeVisible();
    expect(screen.getByText("Local")).toBeVisible();
    expect(screen.getByText("Deterministic")).toBeVisible();
    expect(screen.getByText("12 fixed steps")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(fake.runWorkspaceTestJourney).toHaveBeenCalledWith(workspaceId, {
      journeyId: "wts-help-preferences",
      baseUrl: window.location.origin,
    });
    expect(await screen.findByText("Passed")).toBeVisible();
    expect(screen.getByText(/12 of 12 steps passed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Rerun" })).toBeEnabled();

    await user.click(screen.getByText("Run evidence"));
    expect(
      screen.getAllByText("/tmp/wts/runs/run-help-001").at(-1),
    ).toBeVisible();
  });

  it("keeps deterministic failure evidence separate and prepares a provider-neutral assistant handoff", async () => {
    const user = userEvent.setup();
    const failed = run({
      state: "failed",
      completedAtUnixMs: 1_721_776_402_000,
      durationMs: 1_000,
      passedSteps: 2,
      failedSteps: 1,
      failedStepId: "preferences-visible",
      message: "Preferences dialog did not become visible.",
      graphSha256: "graph-digest-123",
    });
    const fake = clientWithJourneys({
      runs: [failed],
      detail: detail(failed),
    });
    const onSendToAssistant = vi.fn();

    render(
      <UserJourneys
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
        onNotice={vi.fn()}
        onSendToAssistant={onSendToAssistant}
      />,
    );

    expect(await screen.findByText("Failed")).toBeVisible();
    expect(screen.getByText(/2 of 12 steps passed/)).toBeVisible();
    await user.click(screen.getByText("Run evidence"));
    expect(
      screen.getByText("Preferences dialog did not become visible."),
    ).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Review with Assistant" }),
    );

    expect(fake.getWorkspaceTestRun).toHaveBeenCalledWith(
      workspaceId,
      failed.runId,
    );
    expect(onSendToAssistant).toHaveBeenCalledOnce();
    expect(onSendToAssistant.mock.calls[0]?.[0]).toContain(
      "Failed step: preferences-visible",
    );
    expect(onSendToAssistant.mock.calls[0]?.[0]).toContain(
      "deterministic local evidence",
    );
    expect(onSendToAssistant.mock.calls[0]?.[0]).toContain(
      "1 artifact SHA-256 verified",
    );
  });

  it("discards a successful assistant handoff after switching workspaces", async () => {
    const user = userEvent.setup();
    const workspaceA = "ws-journey-a";
    const workspaceB = "ws-journey-b";
    const failedA = run({
      workspaceId: workspaceA,
      runId: "run-a",
      state: "failed",
      failedSteps: 1,
      failedStepId: "step-a",
      message: "Workspace A failed.",
    });
    const failedB = run({
      workspaceId: workspaceB,
      runId: "run-b",
      state: "failed",
      failedSteps: 1,
      failedStepId: "step-b",
      message: "Workspace B failed.",
    });
    const pendingA = deferred<WorkspaceTestRunDetail>();
    const fake = clientWithJourneys({});
    fake.listWorkspaceTestRuns.mockImplementation(
      async (requestedWorkspaceId: string) => ({
        schemaVersion: 1,
        workspaceId: requestedWorkspaceId,
        runs: [requestedWorkspaceId === workspaceA ? failedA : failedB],
      }),
    );
    fake.getWorkspaceTestRun.mockImplementation(
      async (requestedWorkspaceId: string) =>
        requestedWorkspaceId === workspaceA
          ? pendingA.promise
          : detail(failedB),
    );
    const onNotice = vi.fn();
    const onSendToAssistant = vi.fn();
    const { rerender } = render(
      <UserJourneys
        client={fake.client}
        workspaceId={workspaceA}
        workspaceKey="A-1"
        onNotice={onNotice}
        onSendToAssistant={onSendToAssistant}
      />,
    );

    expect(await screen.findByText("Failed")).toBeVisible();
    await user.click(screen.getByText("Run evidence"));
    expect(screen.getByText("Workspace A failed.")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Review with Assistant" }),
    );
    rerender(
      <UserJourneys
        client={fake.client}
        workspaceId={workspaceB}
        workspaceKey="B-2"
        onNotice={onNotice}
        onSendToAssistant={onSendToAssistant}
      />,
    );
    expect(await screen.findByText("Workspace B failed.")).toBeInTheDocument();
    await user.click(screen.getByText("Run evidence"));
    expect(screen.getByText("Workspace B failed.")).toBeVisible();

    await act(async () => {
      pendingA.resolve(detail(failedA));
      await pendingA.promise;
    });

    expect(onSendToAssistant).not.toHaveBeenCalled();
    expect(onNotice).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Review with Assistant" }),
    ).toBeEnabled();
  });

  it("cannot let a stale handoff rejection reset the next workspace handoff", async () => {
    const user = userEvent.setup();
    const workspaceA = "ws-journey-a";
    const workspaceB = "ws-journey-b";
    const failedA = run({
      workspaceId: workspaceA,
      runId: "run-a",
      state: "failed",
      failedSteps: 1,
      message: "Workspace A failed.",
    });
    const failedB = run({
      workspaceId: workspaceB,
      runId: "run-b",
      state: "failed",
      failedSteps: 1,
      message: "Workspace B failed.",
    });
    const pendingA = deferred<WorkspaceTestRunDetail>();
    const pendingB = deferred<WorkspaceTestRunDetail>();
    const fake = clientWithJourneys({});
    fake.listWorkspaceTestRuns.mockImplementation(
      async (requestedWorkspaceId: string) => ({
        schemaVersion: 1,
        workspaceId: requestedWorkspaceId,
        runs: [requestedWorkspaceId === workspaceA ? failedA : failedB],
      }),
    );
    fake.getWorkspaceTestRun.mockImplementation(
      async (requestedWorkspaceId: string) =>
        requestedWorkspaceId === workspaceA
          ? pendingA.promise
          : pendingB.promise,
    );
    const onNotice = vi.fn();
    const onSendToAssistant = vi.fn();
    const { rerender } = render(
      <UserJourneys
        client={fake.client}
        workspaceId={workspaceA}
        workspaceKey="A-1"
        onNotice={onNotice}
        onSendToAssistant={onSendToAssistant}
      />,
    );

    expect(await screen.findByText("Failed")).toBeVisible();
    await user.click(screen.getByText("Run evidence"));
    expect(screen.getByText("Workspace A failed.")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Review with Assistant" }),
    );
    rerender(
      <UserJourneys
        client={fake.client}
        workspaceId={workspaceB}
        workspaceKey="B-2"
        onNotice={onNotice}
        onSendToAssistant={onSendToAssistant}
      />,
    );
    expect(await screen.findByText("Workspace B failed.")).toBeInTheDocument();
    await user.click(screen.getByText("Run evidence"));
    expect(screen.getByText("Workspace B failed.")).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Review with Assistant" }),
    );

    await act(async () => {
      pendingA.reject(new Error("stale A evidence failure"));
      try {
        await pendingA.promise;
      } catch {
        // The component owns the rejection; this await only drains the test promise.
      }
    });

    expect(
      screen.getByRole("button", { name: "Checking evidence…" }),
    ).toBeDisabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onNotice).not.toHaveBeenCalled();

    await act(async () => {
      pendingB.resolve(detail(failedB));
      await pendingB.promise;
    });
    expect(onSendToAssistant).toHaveBeenCalledOnce();
    expect(onSendToAssistant.mock.calls[0]?.[0]).toContain(
      `Workspace ID: ${workspaceB}`,
    );
    expect(onNotice).toHaveBeenCalledWith(
      "B-2 · verified journey evidence loaded in Assistant",
    );
  });

  it("keeps Run disabled and points to Preferences when browser prerequisites are missing", async () => {
    const user = userEvent.setup();
    const fake = clientWithJourneys({});
    const onOpenPreferences = vi.fn();

    render(
      <UserJourneys
        client={fake.client}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
        onNotice={vi.fn()}
        onOpenPreferences={onOpenPreferences}
        readiness={{
          ready: false,
          node: {
            status: "ready",
            detail: "Node is ready.",
          },
          fixedHelper: {
            status: "ready",
            detail: "The fixed helper is ready.",
          },
          playwright: {
            status: "unavailable",
            detail: "Playwright does not resolve beside the fixed helper.",
          },
          chromium: {
            status: "blocked",
            detail: "Chromium cannot be checked until Playwright is ready.",
          },
        }}
      />,
    );

    expect(await screen.findByRole("button", { name: "Run" })).toBeDisabled();
    expect(
      screen.getByText("Playwright does not resolve beside the fixed helper."),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Open Environment & integrations",
      }),
    );
    expect(onOpenPreferences).toHaveBeenCalledOnce();
  });

  it("refreshes an active run started by another local window until it is terminal", async () => {
    vi.useFakeTimers();
    try {
      const running = run({
        state: "running",
        completedAtUnixMs: null,
        durationMs: null,
        passedSteps: 3,
      });
      const fake = clientWithJourneys({ runs: [running] });
      fake.listWorkspaceTestRuns.mockResolvedValueOnce({
        schemaVersion: 1,
        workspaceId,
        runs: [running],
      });
      fake.listWorkspaceTestRuns.mockResolvedValueOnce({
        schemaVersion: 1,
        workspaceId,
        runs: [run()],
      });

      render(
        <UserJourneys
          client={fake.client}
          workspaceId={workspaceId}
          workspaceKey="PLATFORM-42"
          onNotice={vi.fn()}
        />,
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByText("Active")).toBeVisible();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });

      expect(screen.getByText("Passed")).toBeVisible();
      expect(fake.listWorkspaceTestRuns).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays absent for older workspace clients instead of breaking existing mocks", () => {
    const { container } = render(
      <UserJourneys
        client={{} as WorkspaceClient}
        workspaceId={workspaceId}
        workspaceKey="PLATFORM-42"
        onNotice={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
