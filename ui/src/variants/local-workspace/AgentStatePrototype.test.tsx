import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../lib/wtsClient";
import { fakeWorkspaceClient } from "../../test/workspaceClientFake";
import { AgentStatePrototype } from "./AgentStatePrototype";

const launchingSession: AgentSession = {
  schemaVersion: 1,
  sessionId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "ws_01J_PERSISTED",
  provider: "codex",
  terminal: "terminal",
  category: "implementation",
  status: "launching",
  startedAtUnixMs: 1_785_500_000_000,
  lastHeartbeatAtUnixMs: 1_785_500_000_000,
  endedAtUnixMs: null,
  failure: null,
};

describe("managed agent connection", () => {
  it("shows local editor activity as a separate inspectable session", async () => {
    const fake = fakeWorkspaceClient();
    fake.listAgentSessions.mockResolvedValue({
      schemaVersion: 1,
      sessions: [],
      observedSessions: [
        {
          schemaVersion: 1,
          sessionId: "22222222-2222-4222-8222-222222222222",
          workspaceId: launchingSession.workspaceId,
          provider: "codex",
          source: "codexVscodeRollout",
          status: "working",
          activity: "runningCommand",
          latestUpdate: "Updated the workspace cards and started validation.",
          updateKind: "progress",
          startedAtUnixMs: 1_785_500_000_000,
          lastEventAtUnixMs: 1_785_500_003_000,
        },
      ],
    });

    render(
      <AgentStatePrototype
        client={fake.client}
        materialized
        workspaceId={launchingSession.workspaceId}
      />,
    );

    expect(await screen.findByText("Codex is working")).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Agent sessions" }),
    ).toBeVisible();
    expect(
      screen.getByText("Updated the workspace cards and started validation."),
    ).toBeVisible();
    expect(screen.getByText(/Codex · VS Code · Running a command/)).toBeVisible();
    expect(screen.getByText("Selected by Codex")).toBeVisible();
    expect(screen.getByText("1 active")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Run Codex in background" }),
    ).toBeVisible();
    expect(
      screen.getByText(/It does not show hidden reasoning/),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Stop task" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Start a background task" }),
    ).toBeVisible();
  });

  it("shows a fixed question signal without showing question content", async () => {
    const fake = fakeWorkspaceClient();
    fake.listAgentSessions.mockResolvedValue({
      schemaVersion: 1,
      sessions: [],
      observedSessions: [
        {
          schemaVersion: 1,
          sessionId: "33333333-3333-4333-8333-333333333333",
          workspaceId: launchingSession.workspaceId,
          provider: "codex",
          source: "codexVscodeRollout",
          status: "working",
          activity: null,
          needsInput: {
            kind: "question",
            detail: "Agent has a question.",
          },
          startedAtUnixMs: 1_785_500_000_000,
          lastEventAtUnixMs: 1_785_500_003_000,
        },
      ],
    });

    render(
      <AgentStatePrototype
        client={fake.client}
        materialized
        workspaceId={launchingSession.workspaceId}
      />,
    );

    expect(await screen.findByText("Codex has a question")).toBeVisible();
    expect(screen.getByText(/VS Code · Agent has a question\./)).toBeVisible();
    expect(screen.queryByText(/private question/i)).not.toBeInTheDocument();
  });

  it("runs and stops a task with task-focused language", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient({
      agentSessionDetail: {
        schemaVersion: 1,
        sessionId: launchingSession.sessionId,
        workspaceId: launchingSession.workspaceId,
        provider: "codex",
        task: "Review the current workspace changes.",
        modelSelection: {
          authority: "providerDefault",
        },
        events: [
          {
            sequence: 1,
            observedAtUnixMs: launchingSession.startedAtUnixMs + 1_000,
            kind: "editsFiles",
            summary: "Codex edits files.",
          },
        ],
        eventsTruncated: false,
      },
    });
    fake.launchAgentSession.mockResolvedValue({
      ...launchingSession,
      status: "running",
    });
    fake.stopAgentSession.mockResolvedValue({
      ...launchingSession,
      status: "interrupted",
      endedAtUnixMs: launchingSession.startedAtUnixMs + 2_000,
      lastHeartbeatAtUnixMs: launchingSession.startedAtUnixMs + 2_000,
      failure: "userStopped",
    });

    render(
      <AgentStatePrototype
        client={fake.client}
        materialized
        provider="codex"
        workspaceId={launchingSession.workspaceId}
      />,
    );

    expect(await screen.findByText("No agent session is visible in this workspace.")).toBeVisible();
    await user.clear(screen.getByRole("textbox", { name: "Start a background task" }));
    await user.type(
      screen.getByRole("textbox", { name: "Start a background task" }),
      "Review the current workspace changes.",
    );
    await user.click(
      screen.getByRole("button", { name: "Run Codex in background" }),
    );

    expect(
      await screen.findByText("Codex is working in the background"),
    ).toBeVisible();
    expect(screen.getByText("Task")).toBeVisible();
    expect(screen.getByText("Review the current workspace changes.")).toBeVisible();
    expect(screen.getByText(/Codex · WTS background/)).toBeVisible();
    expect(screen.getByText("Provider default")).toBeVisible();
    expect(screen.getByText("Codex edits files.")).toBeVisible();
    expect(fake.launchAgentSession).toHaveBeenCalledWith(
      launchingSession.workspaceId,
      {
        provider: "codex",
        prompt: "Review the current workspace changes.",
        category: "implementation",
      },
    );

    await user.click(screen.getByRole("button", { name: "Stop task" }));
    expect(
      await screen.findByText("Codex stopped the background task"),
    ).toBeVisible();
    expect(fake.stopAgentSession).toHaveBeenCalledWith(
      launchingSession.sessionId,
    );
    expect(screen.getByText(/Stopped by you/)).toBeVisible();
  });

  it("keeps the task available after a failed launch", async () => {
    const user = userEvent.setup();
    const fake = fakeWorkspaceClient();
    fake.launchAgentSession.mockRejectedValue(new Error("Codex is not installed."));
    render(
      <AgentStatePrototype
        client={fake.client}
        materialized
        workspaceId={launchingSession.workspaceId}
      />,
    );

    await screen.findByText("No agent session is visible in this workspace.");
    const task = screen.getByRole("textbox", { name: "Start a background task" });
    await user.clear(task);
    await user.type(task, "Keep this task for retry.");
    await user.click(
      screen.getByRole("button", { name: "Run Codex in background" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Codex is not installed.",
    );
    expect(task).toHaveValue("Keep this task for retry.");
  });

  it("pauses background polling when document is hidden and resumes when visible", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeWorkspaceClient();
      fake.listAgentSessions.mockResolvedValue({
        schemaVersion: 1,
        sessions: [launchingSession],
        observedSessions: [],
      });

      render(
        <AgentStatePrototype
          client={fake.client}
          materialized
          workspaceId={launchingSession.workspaceId}
        />,
      );

      // Wait for initial load on mount
      await act(async () => {
        await Promise.resolve();
      });
      const initialCallCount = fake.listAgentSessions.mock.calls.length;
      expect(initialCallCount).toBeGreaterThanOrEqual(1);

      // Advance timers by 5s while visible -> polling should trigger
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      const visibleCallCount = fake.listAgentSessions.mock.calls.length;
      expect(visibleCallCount).toBeGreaterThan(initialCallCount);

      // Hide document
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      // Advance timers by 20s while hidden -> no new calls should happen
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      const hiddenCallCount = fake.listAgentSessions.mock.calls.length;
      expect(hiddenCallCount).toBe(visibleCallCount);

      // Make document visible again -> should refire immediately and resume polling
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.resolve();
      });
      expect(fake.listAgentSessions.mock.calls.length).toBeGreaterThan(
        hiddenCallCount,
      );
    } finally {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "visible",
      });
      vi.useRealTimers();
    }
  });
});
