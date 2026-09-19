import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityWatchStatus } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { AgentSessionsPanel } from "./AgentSessionsPanel";
import { loadAgentSessions } from "../../lib/agentSessionDiscovery";
import {
  activityWatchReviewIntervalId,
  saveActivityWatchReviewHistorySnapshot,
  saveActivityWatchReviewSnapshot,
  type ActivityWatchReviewIntervalSnapshot,
} from "./activityWatchReviewCache";

function savedInterval(
  startedAtUnixMs: number,
  endedAtUnixMs: number,
  description: string,
): ActivityWatchReviewIntervalSnapshot {
  return {
    schemaVersion: 1,
    intervalId: activityWatchReviewIntervalId(
      startedAtUnixMs,
      endedAtUnixMs,
    ),
    source: "automatic",
    startedAtUnixMs,
    endedAtUnixMs,
    builtAtUnixMs: endedAtUnixMs + 1,
    review: {
      schemaVersion: 1,
      startedAtUnixMs,
      endedAtUnixMs,
      totalActiveSeconds: 60,
      sessions: [
        {
          id: `session-${startedAtUnixMs}`,
          kind: "coding",
          startedAtUnixMs,
          endedAtUnixMs,
          durationSeconds: 60,
          description,
          application: "Visual Studio Code",
          sourceEventCount: 1,
        },
      ],
      detail: "WTS built an automatic summary.",
    },
    jiraIssues: {
      schemaVersion: 1,
      issues: [],
      detail: "No active Jira tickets.",
    },
  };
}

describe("AgentSessionsPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("reuses the board session read across ten immediate returns to My time", async () => {
    const fake = fakeWorkspaceClient();
    await loadAgentSessions(fake.client);
    for (let cycle = 0; cycle < 10; cycle++) {
      const panel = render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
      await act(async () => {});
      panel.unmount();
    }
    expect(fake.listAgentSessions).toHaveBeenCalledTimes(1);
  });

  it("checks notification permission after the user changes browser settings", async () => {
    const user = userEvent.setup();
    const requestPermission = vi.fn().mockResolvedValue("granted");
    vi.stubGlobal("Notification", { permission: "denied", requestPermission });
    try {
      render(<AgentSessionsPanel client={fakeWorkspaceClient().client} workspaceLabels={{}} />);
      expect(screen.getByText("Allow notifications in your browser or system settings, then select Check notification permission.")).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Check notification permission" }));
      expect(requestPermission).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Notifications on" })).toBeVisible();
    } finally { vi.unstubAllGlobals(); }
  });

  it("explains where to read summaries when notifications are unavailable", () => {
    vi.stubGlobal("Notification", undefined);
    try {
      render(<AgentSessionsPanel client={fakeWorkspaceClient().client} workspaceLabels={{}} />);
      expect(screen.getByRole("button", { name: "Notifications unavailable" })).toBeDisabled();
      expect(screen.getByText("This app cannot show notifications. Open My time to read completed summaries.")).toBeVisible();
    } finally { vi.unstubAllGlobals(); }
  });

  it("explains a stopped ActivityWatch connection and offers its settings", async () => {
    const fake = fakeWorkspaceClient({ activityWatchStatus: { state: "unavailable", installation: "detected", endpoint: "http://127.0.0.1:5600", capabilities: [], detail: "The local server is stopped." } });
    const onOpenIntegrations = vi.fn();
    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} onOpenIntegrations={onOpenIntegrations} />);
    expect(await screen.findByText("Start ActivityWatch, then select Check connection.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Build today’s review" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Open integrations" }));
    expect(onOpenIntegrations).toHaveBeenCalledOnce();
  });

  it("retries only Jira after a failed refresh and retains reviewed assignments", async () => {
    const user = userEvent.setup();
    const cached = savedInterval(Date.now() - 60_000, Date.now(), "Review work");
    cached.jiraIssues.issues = [{ issueKey: "WTS-42", summary: "Retain assignments", status: "In Progress" }];
    const sessionId = cached.review.sessions[0]!.id;
    saveActivityWatchReviewSnapshot({ schemaVersion: 1, dateKey: new Date().toLocaleDateString("en-CA"), builtAtUnixMs: Date.now(), review: cached.review, jiraIssues: cached.jiraIssues, assignments: { [sessionId]: "WTS-42" } });
    const fake = fakeWorkspaceClient({ activityWatchStatus: { state: "running", installation: "detected", endpoint: "http://127.0.0.1:5600", capabilities: ["dailyReview"], detail: "Ready" }, activityWatchDailyReview: cached.review });
    fake.listActiveJiraIssues.mockRejectedValueOnce(new Error("Jira connection failed.")).mockResolvedValue(cached.jiraIssues);
    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
    await screen.findByText("ActivityWatch · Connected");
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Jira connection failed.");
    await user.click(screen.getByRole("button", { name: "Retry Jira tickets" }));
    await waitFor(() => expect(fake.listActiveJiraIssues).toHaveBeenCalledTimes(2));
    expect(fake.getActivityWatchDailyReview).toHaveBeenCalledOnce();
    expect(screen.getByRole("combobox", { name: "Jira ticket for Review work" })).toHaveValue("WTS-42");
  });

  it("offers the agent brief as selectable text when clipboard access fails", async () => {
    const user = userEvent.setup();
    const cached = savedInterval(Date.now() - 60_000, Date.now(), "Copy this reviewed work");
    saveActivityWatchReviewSnapshot({ schemaVersion: 1, dateKey: new Date().toLocaleDateString("en-CA"), builtAtUnixMs: Date.now(), review: cached.review, jiraIssues: cached.jiraIssues, assignments: {} });
    const fake = fakeWorkspaceClient();
    const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Permission denied"));
    try {
      render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
      await user.click(screen.getByRole("button", { name: "Copy agent brief" }));
      expect((await screen.findByRole("textbox", { name: "Agent brief to copy" }) as HTMLTextAreaElement).value).toContain("Copy this reviewed work");
    } finally { clipboard.mockRestore(); }
  });

  it("shares a slow session read with manual refresh and later polls", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeWorkspaceClient();
      let resolvePoll!: (value: Awaited<ReturnType<typeof fake.client.listAgentSessions>>) => void;
      fake.listAgentSessions
        .mockResolvedValueOnce({ schemaVersion: 1, sessions: [] })
        .mockImplementationOnce(() => new Promise((resolve) => { resolvePoll = resolve; }));
      render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
      await act(async () => { await Promise.resolve(); });
      fireEvent.mouseDown(screen.getByRole("tab", { name: "Agent activity" }), { button: 0, ctrlKey: false });
      await act(async () => { vi.advanceTimersByTime(5_000); });
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));
      await act(async () => { vi.advanceTimersByTime(15_000); });
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(2);
      await act(async () => resolvePoll({ schemaVersion: 1, sessions: [] }));
      expect(screen.getByText("No agent sessions are visible.")).toBeVisible();
      await act(async () => { vi.advanceTimersByTime(5_000); });
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("provides a manual refresh for the session list", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
    await user.click(screen.getByRole("tab", { name: "Agent activity" }));
    await user.click(await screen.findByRole("button", { name: "Refresh sessions" }));
    expect(fake.listAgentSessions).toHaveBeenCalledTimes(2);
  });

  it("collates transcript-free sessions across workspaces and keeps attention distinct", async () => {
    const user = userEvent.setup();
    const startedAtUnixMs = Date.now() - 75_000;
    const fake = fakeWorkspaceClient({
      agentSessions: {
        schemaVersion: 1,
        sessions: [
          {
            schemaVersion: 1,
            sessionId: "session-accepted",
            workspaceId: "ws_01J_PERSISTED",
            provider: "codex",
            terminal: "warp",
            category: "verification",
            status: "handoffAccepted",
            startedAtUnixMs,
            lastHeartbeatAtUnixMs: startedAtUnixMs,
            endedAtUnixMs: startedAtUnixMs,
            failure: null,
          },
          {
            schemaVersion: 1,
            sessionId: "session-unassigned",
            workspaceId: "ws_removed",
            provider: "hermes",
            terminal: "terminal",
            category: "ideation",
            status: "launching",
            startedAtUnixMs: startedAtUnixMs - 120_000,
            lastHeartbeatAtUnixMs: startedAtUnixMs - 60_000,
            endedAtUnixMs: null,
            failure: null,
          },
        ],
        observedSessions: [
          {
            schemaVersion: 1,
            sessionId: "codex-vscode-session",
            workspaceId: "ws_01J_PERSISTED",
            provider: "copilot",
            source: "copilotVscodeSnapshot",
            status: "working",
            activity: "editing",
            model: "claude-sonnet-4.5",
            latestUpdate: "Updated the workspace session view.",
            updateKind: "progress",
            startedAtUnixMs,
            lastEventAtUnixMs: startedAtUnixMs + 30_000,
          },
        ],
      },
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is reachable on loopback.",
      },
    });

    render(
      <AgentSessionsPanel
        client={fake.client}
        workspaceLabels={{
          ws_01J_PERSISTED: {
            key: "PLATFORM-42",
            title: "Checkout retries create duplicate captures",
          },
        }}
      />,
    );

    const activityTab = screen.getByRole("tab", { name: "Activity review" });
    const agentTab = screen.getByRole("tab", { name: /Agent activity/ });
    expect(activityTab).toHaveAttribute("aria-selected", "true");
    expect(
      await screen.findByText("ActivityWatch · Connected · 0.13.2"),
    ).toBeVisible();
    expect(
      screen.queryByRole("list", {
        name: "Current and recent agent sessions",
      }),
    ).not.toBeInTheDocument();

    activityTab.focus();
    await user.keyboard("{ArrowRight}");
    expect(agentTab).toHaveFocus();
    expect(agentTab).toHaveAttribute("aria-selected", "true");

    const list = await screen.findByRole("list", {
      name: "Current and recent agent sessions",
    });
    expect(within(list).getByText("Codex")).toBeVisible();
    expect(within(list).getByText("GitHub Copilot")).toBeVisible();
    expect(within(list).getByText("VS Code · claude-sonnet-4.5")).toBeVisible();
    expect(within(list).getByText("Working in VS Code")).toBeVisible();
    expect(within(list).getByText("editing")).toBeVisible();
    expect(within(list).getByText("Warp · Verification")).toBeVisible();
    expect(within(list).getAllByText("PLATFORM-42")).toHaveLength(2);
    expect(
      within(list).getAllByText("Checkout retries create duplicate captures"),
    ).toHaveLength(2);
    expect(within(list).getByText("Hermes")).toBeVisible();
    expect(within(list).getByText("Unassigned workspace")).toBeVisible();
    expect(within(list).getByText("Terminal launch pending")).toBeVisible();
    expect(
      within(list).getByText("Terminal handoff accepted"),
    ).toBeVisible();
    expect(within(list).getAllByText("Not observed")).toHaveLength(2);
    expect(screen.getByText("1 open · refreshes every 5 seconds")).toBeVisible();

    await user.keyboard("{ArrowLeft}");
    expect(activityTab).toHaveFocus();
    expect(activityTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No activity yet.")).toBeVisible();
    expect(fake.listAgentSessions).toHaveBeenCalledWith();
    expect(fake.getActivityWatchStatus).toHaveBeenCalledWith();
    expect(fake.getActivityWatchDailyReview).not.toHaveBeenCalled();
    expect(fake.listActiveJiraIssues).not.toHaveBeenCalled();
  });

  it("builds an explicit privacy-safe daily review and matches detected Jira keys", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready for an explicit local review.",
      },
      activityWatchDailyReview: {
        schemaVersion: 1,
        startedAtUnixMs: 1_785_402_000_000,
        endedAtUnixMs: 1_785_406_200_000,
        totalActiveSeconds: 4_200,
        sessions: [
          {
            id: "aw-0001",
            kind: "coding",
            startedAtUnixMs: 1_785_402_000_000,
            endedAtUnixMs: 1_785_406_200_000,
            durationSeconds: 4_200,
            description: "Coding work for PLATFORM-42",
            jiraIssueKey: "PLATFORM-42",
            application: "Visual Studio Code",
            activityEvidence: "Checkout retries in the payment workspace",
            sourceEventCount: 3,
          },
          {
            id: "aw-0002",
            kind: "other",
            startedAtUnixMs: 1_785_402_000_000,
            endedAtUnixMs: 1_785_402_120_000,
            durationSeconds: 120,
            description: "Other active work",
            suggestedJiraIssueKey: "OPS-41",
            jiraSuggestionConfidence: 78,
            jiraSuggestionReason:
              "Activity context matches 2 distinctive words in the Jira summary",
            application: "Terminal",
            activityEvidence: "repair CI environment",
            sourceEventCount: 1,
          },
        ],
        detail:
          "Derived locally. Raw ActivityWatch titles, URLs, paths, and payloads were not retained.",
      },
      activeJiraIssues: {
        schemaVersion: 1,
        issues: [
          {
            issueKey: "OPS-41",
            summary: "Repair CI environment",
            status: "Open",
          },
          {
            issueKey: "PLATFORM-42",
            summary: "Retry duplicate captures",
            status: "In Progress",
          },
        ],
        detail: "Assigned active Jira issues.",
      },
    });

    render(
      <AgentSessionsPanel
        client={fake.client}
        workspaceLabels={{
          workspace_1: {
            key: "PLATFORM-42",
            title: "Retry duplicate captures",
          },
        }}
      />,
    );

    await screen.findByText("ActivityWatch · Connected · 0.13.2");
    expect(fake.getActivityWatchDailyReview).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Build today’s review" }),
    );

    const review = await screen.findByRole("list", {
      name: "Today’s ActivityWatch review",
    });
    expect(
      within(review).getByText("Checkout retries in the payment workspace"),
    ).toBeVisible();
    expect(within(review).getByText("coding")).toBeVisible();
    expect(
      within(review).getAllByText("PLATFORM-42 · Retry duplicate captures"),
    ).toHaveLength(3);
    expect(screen.getAllByText("1h 10m")).toHaveLength(3);
    expect(screen.getByText("2 blocks")).toBeVisible();
    const activityOverview = screen.getByRole("region", {
      name: "Activity overview",
    });
    expect(
      within(activityOverview).getByRole("list", {
        name: "Application activity totals",
      }),
    ).toBeVisible();
    expect(
      within(activityOverview).getByRole("list", {
        name: "Daily activity timeline",
      }),
    ).toBeVisible();
    expect(
      within(activityOverview).getByRole("img", {
        name: "Visual Studio Code, 1h 10m",
      }),
    ).toBeVisible();
    expect(within(activityOverview).getByText("Terminal")).toBeVisible();
    expect(screen.queryByText("ACTIVITYWATCH REVIEW")).not.toBeInTheDocument();
    expect(screen.queryByText(/matched to WTS workspaces/)).not.toBeInTheDocument();
    expect(screen.queryByText(/assigned active Jira tickets/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Review only/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Raw ActivityWatch titles/)).not.toBeInTheDocument();
    const assignment = screen.getByRole("combobox", {
      name: "Jira ticket for Checkout retries in the payment workspace",
    });
    expect(assignment).toHaveValue("PLATFORM-42");
    expect(screen.getByText("Jira key detected in local activity")).toBeVisible();
    expect(screen.getByText(/Jira · 100% match/)).toBeVisible();
    const semanticAssignment = screen.getByRole("combobox", {
      name: "Jira ticket for repair CI environment",
    });
    expect(semanticAssignment).toHaveValue("OPS-41");
    expect(screen.getByText(/Jira · 78% match/)).toBeVisible();
    expect(
      screen.getByText(
        "Activity context matches 2 distinctive words in the Jira summary",
      ),
    ).toBeVisible();
    await user.click(assignment);
    await user.click(screen.getByRole("option", {
      name: "OPS-41 · Repair CI environment",
    }));
    expect(assignment).toHaveValue("OPS-41");
    expect(
      within(assignment.closest("label")!).getByText("Open"),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Copy agent brief" }),
    );
    expect(
      screen.getByRole("button", { name: "Agent brief copied" }),
    ).toBeVisible();
    expect(await navigator.clipboard.readText()).toContain(
      "propose a new Jira ticket",
    );
    expect(await navigator.clipboard.readText()).toContain(
      "Checkout retries in the payment workspace",
    );
    expect(fake.getActivityWatchDailyReview).toHaveBeenCalledTimes(1);
    expect(fake.listActiveJiraIssues).toHaveBeenCalledTimes(1);
    const [start, end] = fake.getActivityWatchDailyReview.mock.calls[0];
    expect(end).toBeGreaterThan(start);
    expect(end - start).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
  });

  it("keeps generic activity unassigned instead of guessing from ticket status", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready for an explicit local review.",
      },
      activityWatchDailyReview: {
        schemaVersion: 1,
        startedAtUnixMs: 1_785_402_000_000,
        endedAtUnixMs: 1_785_402_120_000,
        totalActiveSeconds: 120,
        sessions: [
          {
            id: "aw-other",
            kind: "other",
            startedAtUnixMs: 1_785_402_000_000,
            endedAtUnixMs: 1_785_402_120_000,
            durationSeconds: 120,
            description: "Other active work",
            application: "Dialog",
            sourceEventCount: 1,
          },
        ],
        detail: "Derived locally without retaining raw activity.",
      },
      activeJiraIssues: {
        schemaVersion: 1,
        issues: [
          {
            issueKey: "PLATFORM-6264",
            summary: "Under eval flow check and optimisation",
            status: "In Progress",
          },
        ],
        detail: "Assigned active Jira issues.",
      },
    });

    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
    await screen.findByText("ActivityWatch · Connected · 0.13.2");
    await user.click(
      screen.getByRole("button", { name: "Build today’s review" }),
    );

    const assignment = await screen.findByRole("combobox", {
      name: "Jira ticket for Other active work",
    });
    expect(assignment).toHaveValue("");
    expect(
      screen.queryByText("No activity evidence matches an assigned ticket"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Jira")).toBeVisible();
    await user.click(assignment);
    expect(screen.getByRole("option", {
      name: "PLATFORM-6264 · Under eval flow check and optimisation",
    })).toBeVisible();
  });

  it("keeps loginwindow out of the review and agent brief until the user includes it", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      },
      activityWatchDailyReview: {
        schemaVersion: 1,
        startedAtUnixMs: now - 120_000,
        endedAtUnixMs: now,
        totalActiveSeconds: 120,
        sessions: [
          {
            id: "login",
            kind: "other",
            startedAtUnixMs: now - 120_000,
            endedAtUnixMs: now - 60_000,
            durationSeconds: 60,
            description: "Other active work",
            application: "loginwindow",
            activityEvidence: "Login",
            sourceEventCount: 1,
          },
          {
            id: "code",
            kind: "coding",
            startedAtUnixMs: now - 60_000,
            endedAtUnixMs: now,
            durationSeconds: 60,
            description: "Coding work",
            application: "Visual Studio Code",
            activityEvidence: "WTS daily review",
            sourceEventCount: 3,
          },
        ],
        detail: "Sanitized local activity.",
      },
      activeJiraIssues: {
        schemaVersion: 1,
        issues: [],
        detail: "No active issues.",
      },
    });

    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
    await screen.findByText(/Connected/);
    await user.click(
      screen.getByRole("button", { name: "Build today’s review" }),
    );

    expect(screen.queryByText("Login")).not.toBeInTheDocument();
    expect(screen.getByText("WTS daily review")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Copy agent brief" }));
    expect(await navigator.clipboard.readText()).not.toContain("loginwindow");

    await user.click(screen.getByRole("button", { name: "1 ignored" }));
    expect(screen.getByText("Login")).toBeVisible();
    await user.click(
      screen.getByRole("button", {
        name: "Include activity from loginwindow",
      }),
    );
    expect(localStorage.getItem("wts.activity-watch.ignored-applications.v1"))
      .toBe("[]");
  });

  it("persists a user-ignored application across remounts and lets them restore it", async () => {
    const user = userEvent.setup();
    const now = Date.now();
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      },
      activityWatchDailyReview: {
        schemaVersion: 1,
        startedAtUnixMs: now - 60_000,
        endedAtUnixMs: now,
        totalActiveSeconds: 60,
        sessions: [
          {
            id: "dialog",
            kind: "other",
            startedAtUnixMs: now - 60_000,
            endedAtUnixMs: now,
            durationSeconds: 60,
            description: "Other active work",
            application: "Dialog",
            activityEvidence: "Transient dialog activity",
            sourceEventCount: 1,
          },
        ],
        detail: "Sanitized local activity.",
      },
      activeJiraIssues: {
        schemaVersion: 1,
        issues: [],
        detail: "No active issues.",
      },
    });

    const firstView = render(
      <AgentSessionsPanel client={fake.client} workspaceLabels={{}} />,
    );
    await screen.findByText(/Connected/);
    await user.click(
      screen.getByRole("button", { name: "Build today’s review" }),
    );
    expect(await screen.findByText("Transient dialog activity")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Ignore activity from Dialog" }),
    );
    expect(screen.queryByText("Transient dialog activity")).not.toBeInTheDocument();
    expect(localStorage.getItem("wts.activity-watch.ignored-applications.v1"))
      .toBe('["dialog","loginwindow"]');
    firstView.unmount();

    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
    expect(await screen.findByRole("button", { name: "1 ignored" })).toBeVisible();
    expect(screen.queryByText("Transient dialog activity")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "1 ignored" }));
    await user.click(
      screen.getByRole("button", { name: "Include activity from Dialog" }),
    );
    expect(screen.getByText("Transient dialog activity")).toBeVisible();
    expect(localStorage.getItem("wts.activity-watch.ignored-applications.v1"))
      .toBe('["loginwindow"]');
  });

  it("restores today’s review and assignments after the global time view remounts", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      },
      activityWatchDailyReview: {
        schemaVersion: 1,
        startedAtUnixMs: Date.now() - 60_000,
        endedAtUnixMs: Date.now(),
        totalActiveSeconds: 60,
        sessions: [
          {
            id: "persisted-session",
            kind: "coding",
            startedAtUnixMs: Date.now() - 60_000,
            endedAtUnixMs: Date.now(),
            durationSeconds: 60,
            description: "Coding work",
            application: "Visual Studio Code",
            sourceEventCount: 1,
          },
        ],
        detail: "Derived locally.",
      },
      activeJiraIssues: {
        schemaVersion: 1,
        issues: [
          {
            issueKey: "WTS-42",
            summary: "Persist time review",
            status: "In Progress",
          },
        ],
        detail: "Assigned active Jira issues.",
      },
    });

    const firstView = render(
      <AgentSessionsPanel client={fake.client} workspaceLabels={{}} />,
    );
    await screen.findByText("ActivityWatch · Connected · 0.13.2");
    await user.click(
      screen.getByRole("button", { name: "Build today’s review" }),
    );
    const assignment = await screen.findByRole("combobox", {
      name: "Jira ticket for Coding work",
    });
    await user.click(assignment);
    await user.click(screen.getByRole("option", {
      name: "WTS-42 · Persist time review",
    }));
    await waitFor(() => {
      const values = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) ?? ""),
      );
      expect(values.some((value) => value?.includes('"WTS-42"'))).toBe(true);
    });
    firstView.unmount();

    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);

    expect(await screen.findByText("Coding work")).toBeVisible();
    expect(
      screen.getByRole("combobox", {
        name: "Jira ticket for Coding work",
      }),
    ).toHaveValue("WTS-42");
    expect(screen.getByRole("button", { name: "Refresh" })).toBeVisible();
    expect(fake.getActivityWatchDailyReview).toHaveBeenCalledTimes(1);
    expect(fake.listActiveJiraIssues).toHaveBeenCalledTimes(1);
  });

  it("renders an honest empty state and retries a failed session read", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.listAgentSessions
      .mockRejectedValueOnce(new Error("Session ledger is locked"))
      .mockResolvedValueOnce({ schemaVersion: 1, sessions: [] });

    render(
      <AgentSessionsPanel
        client={fake.client}
        workspaceLabels={{}}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Agent activity" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Session ledger is locked");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "No agent sessions are visible.",
        ),
      ).toBeVisible();
    });
    expect(fake.listAgentSessions).toHaveBeenCalledTimes(2);
  });

  it("announces ActivityWatch refresh progress and its resolved status", async () => {
    const user = userEvent.setup();
    let resolveRefresh: ((status: ActivityWatchStatus) => void) | undefined;
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      },
    });
    fake.getActivityWatchStatus
      .mockResolvedValueOnce({
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);

    const status = await screen.findByRole("status", {
      name: "ActivityWatch connection status",
    });
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).not.toHaveAttribute("aria-busy");
    expect(status).toHaveTextContent("Connected · 0.13.2");

    await user.click(
      within(status).getByRole("button", { name: "Check connection" }),
    );
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("WTS checks the connection…");
    expect(
      within(status).getByRole("button", { name: "WTS checks…" }),
    ).toBeDisabled();

    await act(async () => {
      resolveRefresh?.({
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.3",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch refresh completed.",
      });
    });

    await waitFor(() => {
      expect(status).not.toHaveAttribute("aria-busy");
      expect(status).toHaveTextContent("Connected · 0.13.3");
      expect(status).not.toHaveTextContent("ActivityWatch refresh completed.");
    });
  });

  it("stops automatic refresh when the global time view unmounts", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeWorkspaceClient();
      const view = render(
        <AgentSessionsPanel client={fake.client} workspaceLabels={{}} />,
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(1);

      view.unmount();
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(fake.listAgentSessions).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists the selected automatic summary interval", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);

    const interval = await screen.findByRole("combobox", {
      name: "Automatic summary interval",
    });
    await user.click(interval);
    await user.click(screen.getByRole("option", { name: "Manual" }));
    expect(
      JSON.parse(localStorage.getItem("wts.time-review-schedule.v1") ?? "{}"),
    ).toMatchObject({ enabled: false, intervalHours: 4 });

    await user.click(interval);
    await user.click(screen.getByRole("option", { name: "Every 6 hours" }));
    expect(
      JSON.parse(localStorage.getItem("wts.time-review-schedule.v1") ?? "{}"),
    ).toMatchObject({ enabled: true, intervalHours: 6 });
  });

  it("does not start a second automatic scheduler inside My time", async () => {
    const now = Date.now();
    localStorage.setItem(
      "wts.time-review-schedule.v1",
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        intervalHours: 4,
        startedAtUnixMs: now - 5 * 60 * 60 * 1_000,
        lastSuccessfulAtUnixMs: now - 5 * 60 * 60 * 1_000,
        notificationsEnabled: false,
      }),
    );
    const fake = fakeWorkspaceClient({
      activityWatchStatus: {
        state: "running",
        installation: "detected",
        endpoint: "http://127.0.0.1:5600",
        apiVersion: "v0",
        serverVersion: "0.13.2",
        capabilities: ["status", "dailyReview"],
        detail: "ActivityWatch is ready.",
      },
    });

    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);

    expect(
      await screen.findByText("ActivityWatch · Connected · 0.13.2"),
    ).toBeVisible();
    expect(fake.getActivityWatchDailyReview).not.toHaveBeenCalled();
  });

  it("restores same-day summaries and selects them with arrow keys", async () => {
    const user = userEvent.setup();
    const dayStart = new Date(2026, 7, 12, 8, 0).getTime();
    const first = savedInterval(
      dayStart,
      dayStart + 2 * 60 * 60 * 1_000,
      "Reviewed the first interval",
    );
    const second = savedInterval(
      first.endedAtUnixMs,
      first.endedAtUnixMs + 2 * 60 * 60 * 1_000,
      "Reviewed the second interval",
    );
    saveActivityWatchReviewHistorySnapshot(first);
    saveActivityWatchReviewHistorySnapshot(second);
    saveActivityWatchReviewSnapshot({
      schemaVersion: 1,
      dateKey: "2026-08-12",
      builtAtUnixMs: second.builtAtUnixMs,
      review: second.review,
      jiraIssues: second.jiraIssues,
      assignments: {},
    });
    const fake = fakeWorkspaceClient();

    const firstView = render(
      <AgentSessionsPanel client={fake.client} workspaceLabels={{}} />,
    );
    const summaries = await screen.findByRole("listbox", {
      name: "Recent automatic summaries",
    });
    const options = within(summaries).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[1]).toHaveAttribute("aria-selected", "false");

    options[1].focus();
    await user.keyboard("{ArrowRight}");
    expect(options[2]).toHaveFocus();
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Reviewed the first interval")).toBeVisible();
    expect(screen.queryByText("Reviewed the second interval")).not.toBeInTheDocument();

    firstView.unmount();
    render(<AgentSessionsPanel client={fake.client} workspaceLabels={{}} />);
    const restoredSummaries = await screen.findByRole("listbox", {
      name: "Recent automatic summaries",
    });
    expect(restoredSummaries).toBeVisible();
    expect(within(restoredSummaries).getAllByRole("option")).toHaveLength(3);
  });
});
