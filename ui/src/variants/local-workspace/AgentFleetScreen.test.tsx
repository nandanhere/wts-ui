import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { AgentSession, WorkspaceClient } from "../../lib/wtsClient";
import { AgentFleetScreen, buildFleetCards } from "./AgentFleetScreen";
const now = Date.now();
const session: AgentSession = { schemaVersion: 1, sessionId: "live", workspaceId: "workspace", provider: "codex", terminal: "terminal", category: "verification", status: "running", startedAtUnixMs: now - 60_000, lastHeartbeatAtUnixMs: now, endedAtUnixMs: null, failure: null };
it("opens the workspace and asks before stopping a live session", async () => {
  const listAgentSessions = vi.fn(async () => ({ schemaVersion: 1, sessions: [session], observedSessions: [] }));
  const stopAgentSession = vi.fn(async () => ({}));
  const open = vi.fn();
  const client = { listAgentSessions, stopAgentSession } as unknown as WorkspaceClient;
  render(<AgentFleetScreen client={client} workspaceLabels={{ workspace: { key: "WTS", title: "UI polish" } }} onOpenWorkspace={open} onOpenInVscode={vi.fn()} onOpenTime={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Open workspace" }));
  expect(open).toHaveBeenCalledWith("workspace");
  fireEvent.click(screen.getByRole("button", { name: "Stop Codex" }));
  expect(stopAgentSession).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stop agent" }));
  await waitFor(() => expect(stopAgentSession).toHaveBeenCalledWith("live"));
});
it("explains a stopped background agent, and Dismiss moves it to Earlier sessions after a reload", async () => {
  localStorage.clear();
  const stopped: AgentSession = { ...session, sessionId: "stopped", status: "interrupted", failure: "processExited", endedAtUnixMs: now - 3_600_000, lastHeartbeatAtUnixMs: now - 3_600_000 };
  const listAgentSessions = vi.fn(async () => ({ schemaVersion: 1, sessions: [stopped], observedSessions: [] }));
  const getAgentSessionDetail = vi.fn(async () => {
    throw Object.assign(new Error("The requested agent session was not found."), { code: "agent_session_not_found" });
  });
  const client = { listAgentSessions, getAgentSessionDetail } as unknown as WorkspaceClient;
  const props = { client, workspaceLabels: { workspace: { key: "WTS", title: "Review apex-go-sdk" } }, onOpenWorkspace: vi.fn(), onOpenInVscode: vi.fn(), onOpenTime: vi.fn() };
  const first = render(<AgentFleetScreen {...props} />);
  const live = await screen.findByRole("list", { name: "Agent sessions" });
  expect(within(live).getByText(/Open the workspace to check the files, then start the task again/)).toBeVisible();

  fireEvent.click(within(live).getByRole("button", { name: "Inspect log" }));
  expect(await screen.findByText(/The log of a background agent stays in memory only until the app restarts/)).toBeVisible();
  expect(screen.queryByText("Cannot read the session log.")).not.toBeInTheDocument();

  fireEvent.click(within(live).getByRole("button", { name: "Dismiss the Codex error" }));
  expect(await screen.findByText("No agent works or needs you now.")).toBeVisible();
  first.unmount();

  render(<AgentFleetScreen {...props} />);
  expect(await screen.findByRole("button", { name: /Review apex-go-sdk.*1 session/ })).toBeVisible();
  expect(screen.queryByRole("list", { name: "Agent sessions" })).not.toBeInTheDocument();
  localStorage.clear();
});

it("keeps old errors and unconfirmed launches out of the live counts", () => {
  const old = now - 3 * 86_400_000;
  const cards = buildFleetCards([
    { ...session, sessionId: "failed", status: "failed", endedAtUnixMs: old, lastHeartbeatAtUnixMs: old },
    { ...session, sessionId: "launch", status: "handoffAccepted", lastHeartbeatAtUnixMs: old },
    session,
  ], [], now);
  expect(cards.filter(card => card.health === "working")).toHaveLength(1);
  expect(cards.filter(card => card.health === "finished")).toHaveLength(2);
});

it("shows live sessions as cards and folds earlier sessions into one row per workspace", async () => {
  const old = now - 2 * 86_400_000;
  const observed = (id: string, workspaceId: string, status: "idle" | "working", at: number) => ({
    schemaVersion: 1, sessionId: id, workspaceId, provider: "codex", source: "codexVscodeRollout", status, activity: null,
    latestUpdate: "Update " + id, updateKind: "completion", startedAtUnixMs: at - 1_000, lastEventAtUnixMs: at,
  });
  const listAgentSessions = vi.fn(async () => ({
    schemaVersion: 1,
    sessions: [],
    observedSessions: [
      observed("live", "ui", "working", now),
      observed("old-1", "ui", "idle", old),
      observed("old-2", "ui", "idle", old - 1_000),
      observed("old-3", "api", "idle", old - 2_000),
    ],
  }));
  const client = { listAgentSessions } as unknown as WorkspaceClient;
  render(<AgentFleetScreen client={client} workspaceLabels={{ ui: { key: "UI", title: "wts-ui" }, api: { key: "API", title: "api" } }} onOpenWorkspace={vi.fn()} onOpenInVscode={vi.fn()} onOpenTime={vi.fn()} />);

  const live = await screen.findByRole("list", { name: "Agent sessions" });
  expect(within(live).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.queryByText("Update old-1")).not.toBeInTheDocument();
  const groups = screen.getByRole("list", { name: "Earlier sessions by workspace" });
  const toggle = within(groups).getByRole("button", { name: /wts-ui.*2 sessions/ });
  expect(within(groups).getByRole("button", { name: /api.*1 session/ })).toBeVisible();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(within(screen.getByRole("list", { name: "Earlier sessions in wts-ui" })).getAllByRole("listitem")).toHaveLength(2);
});
