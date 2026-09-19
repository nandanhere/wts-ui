import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResultActions } from "./AgentResultActions";
import type { WorkspaceClient } from "../lib/wtsClient";
import { agentTurnChangesFixture } from "../test/agentTurnChangesFixture";
import { agentTurnChecksFixture, agentTurnRestoreFixture } from "../test/agentTurnActionsFixture";
import { TURN_ACTION_STORAGE_KEY } from "../lib/agentTurnActionStorage";
import type { AgentTurnCheckRun } from "../lib/agentTurnActions";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; }
const receipt = agentTurnChangesFixture();
function setup() {
  const get = vi.fn().mockResolvedValue(agentTurnChecksFixture());
  const run = vi.fn().mockImplementation(async (_id, _turn, request) => agentTurnChecksFixture({ runs: [{ runId: request.requestId, checkId: request.checkId, status: "passed", startedAtUnixMs: 1, output: "Done", outputTruncated: false, detail: "Check complete." }] }));
  const preflight = vi.fn().mockResolvedValue(agentTurnRestoreFixture());
  const restore = vi.fn().mockImplementation(async (_id, _turn, request) => ({ schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, restoreRequestId: request.requestId, state: "restored", files: agentTurnRestoreFixture().files, blockers: [], detail: "Restore complete." }));
  const client = { getAgentTurnChecks: get, runAgentTurnCheck: run, preflightAgentTurnRestore: preflight, restoreAgentTurn: restore } as unknown as WorkspaceClient;
  return { get, run, preflight, restore, client, props: { client, receipt, onOpenVerification: vi.fn() } };
}
beforeEach(() => localStorage.clear());
describe("task action recovery", () => {
  it("retains an uncertain check ID across remount and retries only after a click", async () => {
    const user = userEvent.setup(); const state = setup(); state.run.mockRejectedValueOnce(new Error("Connection lost."));
    const first = render(<AgentResultActions {...state.props} />);
    await user.click(screen.getByText("Host checks")); await user.click(await screen.findByRole("button", { name: "Run Unit tests" }));
    await screen.findByText("Connection lost."); const request = state.run.mock.calls[0][2];
    first.unmount(); render(<AgentResultActions {...state.props} />);
    await user.click(screen.getByText("Host checks"));
    await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2));
    expect(state.run).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Retry check request" }));
    await screen.findByText("Check complete.");
    expect(state.run.mock.calls.map(call => call[2])).toEqual([request, request]);
    expect(JSON.parse(localStorage.getItem(TURN_ACTION_STORAGE_KEY)!)).toEqual([]);
  });
  it("reconciles an acknowledged check from GET without another execution", async () => {
    const user = userEvent.setup(); const state = setup(); state.run.mockRejectedValueOnce(new Error("Response lost."));
    const view = render(<AgentResultActions {...state.props} />); await user.click(screen.getByText("Host checks"));
    await user.click(await screen.findByRole("button", { name: "Run Unit tests" })); await screen.findByText("Response lost.");
    const request = state.run.mock.calls[0][2];
    state.get.mockResolvedValue(agentTurnChecksFixture({ runs: [{ runId: request.requestId, checkId: request.checkId, status: "running", startedAtUnixMs: 1, output: "", outputTruncated: false, detail: "The check is active." }] }));
    view.unmount(); render(<AgentResultActions {...state.props} />); await user.click(screen.getByText("Host checks"));
    await screen.findByText("The check is active."); expect(state.run).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry check request" })).not.toBeInTheDocument();
  });
  it("blocks duplicate check clicks before acknowledgement", async () => {
    const state = setup(); const pending = deferred<ReturnType<typeof agentTurnChecksFixture>>(); state.run.mockReturnValue(pending.promise);
    render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Host checks"));
    const button = await screen.findByRole("button", { name: "Run Unit tests" }); fireEvent.click(button); fireEvent.click(button);
    expect(state.run).toHaveBeenCalledOnce();
  });
  it("does not run a second command from a physical double-click after a fast acknowledgement", async () => {
    const state = setup(); render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Host checks"));
    const button = await screen.findByRole("button", { name: "Run Unit tests" });
    fireEvent.click(button, { detail: 1 }); await screen.findByText("Check complete.");
    fireEvent.click(button, { detail: 2 }); expect(state.run).toHaveBeenCalledOnce();
    fireEvent.click(button, { detail: 0 }); await waitFor(() => expect(state.run).toHaveBeenCalledTimes(2));
  });
  it.each(["stale", "unavailable", "noChecks"] as const)("keeps historical evidence and disables %s execution", async stateValue => {
    const state = setup(); state.get.mockResolvedValue(agentTurnChecksFixture({ state: stateValue, detail: "The saved files changed." }));
    render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Host checks"));
    expect(await screen.findByRole("button", { name: "Run Unit tests" })).toBeDisabled(); expect(state.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("link", { name: "Open workspace verification" })); expect(state.props.onOpenVerification).toHaveBeenCalledOnce();
  });
  it("does not execute when durable request storage fails", async () => {
    const state = setup(); render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Host checks"));
    const button = await screen.findByRole("button", { name: "Run Unit tests" });
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    try { fireEvent.click(button); await screen.findByText(/could not save the request for a safe retry/); expect(state.run).not.toHaveBeenCalled(); }
    finally { write.mockRestore(); }
  });
  it("rejects another task's checks and ignores the previous client's late read", async () => {
    const first = setup(); const next = setup(); const pending = deferred<ReturnType<typeof agentTurnChecksFixture>>(); first.get.mockReturnValue(pending.promise);
    const view = render(<AgentResultActions {...first.props} />); fireEvent.click(screen.getByText("Host checks"));
    await waitFor(() => expect(first.get).toHaveBeenCalledOnce());
    next.get.mockResolvedValue(agentTurnChecksFixture({ sessionId: "other" })); view.rerender(<AgentResultActions {...next.props} />);
    fireEvent.click(screen.getByText("Host checks")); await screen.findByText("The check results do not match this task.");
    await act(async () => pending.resolve(agentTurnChecksFixture())); expect(screen.queryByRole("button", { name: "Run Unit tests" })).not.toBeInTheDocument();
  });
  it("shows restore blockers and never exposes a write for changed files", async () => {
    const state = setup(); state.preflight.mockResolvedValue(agentTurnRestoreFixture({ state: "blocked", files: [], blockers: [{ code: "changed", filePath: "src/title.ts", detail: "The file changed after this task." }] }));
    render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Restore task changes"));
    await screen.findByText(/The file changed after this task/);
    expect(screen.queryByRole("button", { name: /^Restore \d/ })).not.toBeInTheDocument(); expect(state.restore).not.toHaveBeenCalled();
  });
  it("retains uncertain restore effects across remount and reuses the exact request", async () => {
    const user = userEvent.setup(); const state = setup(); state.restore.mockRejectedValueOnce(new Error("Response lost."));
    const view = render(<AgentResultActions {...state.props} />); await user.click(screen.getByText("Restore task changes"));
    await user.click(await screen.findByRole("button", { name: "Restore 1 file" })); await screen.findByText("Response lost.");
    const request = state.restore.mock.calls[0][2]; view.unmount(); render(<AgentResultActions {...state.props} />);
    await user.click(screen.getByText("Restore task changes")); await waitFor(() => expect(state.preflight).toHaveBeenCalledTimes(2));
    expect(state.restore).toHaveBeenCalledOnce(); await user.click(screen.getByRole("button", { name: "Retry restore request" }));
    await screen.findByText("Restore complete."); expect(state.restore.mock.calls.map(call => call[2])).toEqual([request, request]);
  });
  it("shows actual partial restore effects and keeps the exact request for continuation", async () => {
    const state = setup(); state.restore.mockImplementation(async (_id, _turn, request) => ({ schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, restoreRequestId: request.requestId, state: "incomplete", files: [], blockers: [{ code: "changed", detail: "No file was restored." }], detail: "Restore stopped." }));
    const view = render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Restore task changes"));
    fireEvent.click(await screen.findByRole("button", { name: "Restore 1 file" })); await screen.findByText("Restore stopped.");
    expect(screen.getByRole("region", { name: "Restore task changes" })).toHaveTextContent("No file was restored.");
    expect(screen.queryByRole("button", { name: "Restore 1 file" })).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Retry restore request" })).toBeEnabled();
    const first = state.restore.mock.calls[0][2];
    view.unmount(); state.preflight.mockResolvedValue(agentTurnRestoreFixture({ state: "blocked", detail: "An earlier restore is incomplete." }));
    render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Restore task changes"));
    await screen.findByText("An earlier restore is incomplete."); expect(state.restore).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry restore request" }));
    await waitFor(() => expect(state.restore).toHaveBeenCalledTimes(2)); expect(state.restore.mock.calls[1][2]).toEqual(first);
  });
  it("continues an incomplete restore with the host ID when browser storage is empty", async () => {
    const state = setup(); const resumeRequestId = "77777777-7777-4777-8777-777777777777";
    state.preflight.mockResolvedValue({ ...agentTurnRestoreFixture(), resumeRequestId });
    render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Restore task changes"));
    expect(state.restore).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Continue restore" }));
    await screen.findByText("Restore complete.");
    expect(state.restore).toHaveBeenCalledExactlyOnceWith(receipt.conversationId, receipt.requestId, { requestId: resumeRequestId, effectDigest: agentTurnRestoreFixture().effectDigest });
  });
  it("keeps command output and its real failure separate from an agent claim", async () => {
    const state = setup(); const run: AgentTurnCheckRun = { runId: "99999999-9999-4999-8999-999999999999", checkId: "unit", status: "timedOut", startedAtUnixMs: 1, durationMs: 300000, exitCode: 124, output: "Agent said passed.\nActual timeout.", outputTruncated: true, detail: "The command reached its time limit." };
    state.get.mockResolvedValue(agentTurnChecksFixture({ runs: [run] })); render(<AgentResultActions {...state.props} />); fireEvent.click(screen.getByText("Host checks"));
    fireEvent.click(await screen.findByText("Unit tests · Time limit reached"));
    expect(screen.getByText("Agent said passed. Actual timeout.")).toBeVisible(); expect(screen.getByText("WTS omitted part of the command output.")).toBeVisible();
    expect(screen.queryByText("Unit tests · Passed")).not.toBeInTheDocument();
  });
});
