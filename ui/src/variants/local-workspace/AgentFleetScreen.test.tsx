import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
