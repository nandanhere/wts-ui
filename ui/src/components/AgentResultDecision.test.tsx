import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResultDecision } from "./AgentResultDecision";
import { agentTurnChangesFixture } from "../test/agentTurnChangesFixture";
import { agentTurnDecisionFixture, agentTurnDecisionsFixture } from "../test/agentTurnDecisionsFixture";
import { DECISION_DRAFT_KEY } from "../lib/agentTurnDecisionDraft";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(next => { resolve = next; }); return { promise, resolve }; }
function setup() {
  const receipt = agentTurnChangesFixture(); let ledger = agentTurnDecisionsFixture();
  const get = vi.fn(async () => ledger);
  const post = vi.fn(async (_id, _turn, request) => { ledger = { ...ledger, revision: request.expectedRevision + 1, decisions: [...ledger.decisions, agentTurnDecisionFixture(request)] }; return ledger; });
  const client = { getAgentTurnDecisions: get, recordAgentTurnDecision: post } as unknown as WorkspaceClient;
  return { receipt, get, post, client, props: { client, receipt }, get ledger() { return ledger; }, setLedger(value: typeof ledger) { ledger = value; } };
}
async function open() { fireEvent.click(await screen.findByText(/Decision · (Not set|Not loaded|Accepted|Alternative|Rejected)/)); }
async function prepare(reason = "Keep this reason.") { await open(); fireEvent.click(screen.getByRole("radio", { name: "Accept result" })); fireEvent.change(screen.getByRole("textbox", { name: "Reason (optional)" }), { target: { value: reason } }); }
beforeEach(() => localStorage.clear());
describe("task review decisions", () => {
  it("retains a reason for each result across switches and remounts without submission", async () => {
    const first = setup(); const second = setup(); second.props.receipt = { ...second.receipt, requestId: "77777777-7777-4777-8777-777777777777" }; second.setLedger({ ...second.ledger, requestId: second.props.receipt.requestId });
    const view = render(<AgentResultDecision {...first.props} />); await prepare("First reason.");
    view.rerender(<AgentResultDecision {...second.props} />); await prepare("Second reason.");
    view.rerender(<AgentResultDecision {...first.props} />); await open(); expect(screen.getByRole("textbox", { name: "Reason (optional)" })).toHaveValue("First reason.");
    view.unmount(); render(<AgentResultDecision {...second.props} />); await open(); expect(screen.getByRole("textbox", { name: "Reason (optional)" })).toHaveValue("Second reason.");
    expect(first.post).not.toHaveBeenCalled(); expect(second.post).not.toHaveBeenCalled();
  });
  it("reuses an uncertain mutation after reload and never submits on open", async () => {
    const state = setup(); state.post.mockRejectedValueOnce(new Error("Response lost.")); const view = render(<AgentResultDecision {...state.props} />);
    await prepare(); fireEvent.click(screen.getByRole("button", { name: "Save decision" })); await screen.findByText("Response lost."); const request = state.post.mock.calls[0][2];
    view.unmount(); render(<AgentResultDecision {...state.props} />); await open(); await waitFor(() => expect(state.get).toHaveBeenCalledTimes(2)); expect(state.post).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Retry decision request" })); await screen.findByText("Decision · Accepted");
    expect(state.post.mock.calls[1][2]).toEqual(request); expect(JSON.parse(localStorage.getItem(DECISION_DRAFT_KEY)!)).toEqual([]);
  });
  it("finds a saved receipt through GET after a lost response without a second write", async () => {
    const state = setup(); state.post.mockImplementationOnce(async (_id, _turn, request) => { state.setLedger({ ...state.ledger, revision: 1, decisions: [agentTurnDecisionFixture(request)] }); throw new Error("Response lost."); });
    const view = render(<AgentResultDecision {...state.props} />); await prepare(); fireEvent.click(screen.getByRole("button", { name: "Save decision" })); await screen.findByText("Response lost.");
    view.unmount(); render(<AgentResultDecision {...state.props} />); await open(); await screen.findByText("Decision · Accepted"); expect(state.post).toHaveBeenCalledOnce(); expect(screen.queryByRole("button", { name: "Retry decision request" })).not.toBeInTheDocument();
  });
  it("keeps the reason after a CAS conflict and requires refreshed history plus a new explicit save", async () => {
    const state = setup(); state.post.mockRejectedValueOnce(new WorkspaceClientError("Another decision changed the history.", { code: "agent_conversation_conflict", retryable: false }));
    render(<AgentResultDecision {...state.props} />); await prepare("My choice remains."); fireEvent.click(screen.getByRole("button", { name: "Save decision" })); await screen.findByText("Another decision changed the history.");
    expect(screen.getByRole("textbox", { name: "Reason (optional)" })).toHaveValue("My choice remains."); expect(screen.getByRole("button", { name: "Save decision" })).toBeDisabled();
    const request = { requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: 0, expectedReceiptDigest: state.ledger.receiptDigest, kind: "rejected" as const, reason: "Earlier decision." };
    state.setLedger({ ...state.ledger, revision: 1, decisions: [agentTurnDecisionFixture(request)] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh decisions" })); await screen.findByText("Decision · Rejected"); expect(state.post).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Save decision" })); await screen.findByText("Decision · Accepted"); expect(state.post.mock.calls[1][2]).toMatchObject({ expectedRevision: 1, reason: "My choice remains." }); expect(state.post.mock.calls[1][2].requestId).not.toBe(state.post.mock.calls[0][2].requestId);
  });
  it("retains historical failed checks after acceptance and keeps older reasons visible", async () => {
    const state = setup(); const first = agentTurnDecisionFixture({ requestId: "88888888-8888-4888-8888-888888888888", expectedRevision: 0, expectedReceiptDigest: state.ledger.receiptDigest, kind: "kept", reason: "Original alternative." });
    const second = agentTurnDecisionFixture({ requestId: "99999999-9999-4999-8999-999999999999", expectedRevision: 1, expectedReceiptDigest: state.ledger.receiptDigest, kind: "accepted", reason: "Accept with known failed check." }, { checksState: "ready", checks: [{ runId: "77777777-7777-4777-8777-777777777777", checkId: "unit", status: "failed" }] });
    state.setLedger({ ...state.ledger, revision: 2, decisions: [first, second] }); render(<AgentResultDecision {...state.props} />); await open();
    expect(screen.getByText("unit: Failed")).toBeVisible(); expect(screen.queryByText("unit: Passed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Decision history (1 earlier)")); expect(screen.getByText("Original alternative.")).toBeVisible(); expect(state.post).not.toHaveBeenCalled();
  });
  it("never writes without durable request storage", async () => {
    const state = setup(); render(<AgentResultDecision {...state.props} />); await prepare();
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Full"); });
    try { fireEvent.click(screen.getByRole("button", { name: "Save decision" })); await screen.findByText(/could not save the decision draft/); expect(state.post).not.toHaveBeenCalled(); } finally { write.mockRestore(); }
  });
  it("blocks duplicate clicks while a save is pending", async () => {
    const state = setup(); const pending = deferred<ReturnType<typeof agentTurnDecisionsFixture>>(); state.post.mockReturnValue(pending.promise);
    render(<AgentResultDecision {...state.props} />); await prepare(); const button = screen.getByRole("button", { name: "Save decision" }); fireEvent.click(button); fireEvent.click(button); expect(state.post).toHaveBeenCalledOnce();
  });
  it("preserves an oversized Unicode reason while blocking save", async () => {
    const state = setup(); const view = render(<AgentResultDecision {...state.props} />); await prepare("😀".repeat(1500)); expect(screen.getByRole("button", { name: "Save decision" })).toBeDisabled();
    expect(screen.getByText(/reason exceeds 4096 bytes/)).toBeVisible(); view.unmount(); render(<AgentResultDecision {...state.props} />); await open(); expect(screen.getByRole("textbox", { name: "Reason (optional)" })).toHaveValue("😀".repeat(1500)); expect(state.post).not.toHaveBeenCalled();
  });
  it("retains unsupported control characters for correction without dispatch or corrupting saved drafts", async () => {
    const state = setup(); const view = render(<AgentResultDecision {...state.props} />); await prepare("Reason\u001b with control");
    expect(screen.getByRole("button", { name: "Save decision" })).toBeDisabled(); expect(screen.getByText(/unsupported control character/)).toBeVisible();
    view.unmount(); render(<AgentResultDecision {...state.props} />); await open();
    const input = screen.getByRole("textbox", { name: "Reason (optional)" }); expect(input).toHaveValue("Reason\u001b with control");
    fireEvent.change(input, { target: { value: "Corrected reason." } }); fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
    await screen.findByText("Decision · Accepted"); expect(state.post).toHaveBeenCalledOnce();
  });
  it("ignores late history from a previous client and rejects a different saved source", async () => {
    const first = setup(); const next = setup(); const delayed = deferred<ReturnType<typeof agentTurnDecisionsFixture>>(); first.get.mockReturnValue(delayed.promise);
    const view = render(<AgentResultDecision {...first.props} />); await waitFor(() => expect(first.get).toHaveBeenCalledOnce());
    next.setLedger({ ...next.ledger, sourceContextSha256: `sha256:${"e".repeat(64)}` }); view.rerender(<AgentResultDecision {...next.props} />); await open(); await screen.findByText("The decision history does not match this saved result.");
    await act(async () => delayed.resolve(first.ledger)); expect(screen.getByRole("button", { name: "Save decision" })).toBeDisabled(); expect(screen.queryByText("Decision · Not set")).not.toBeInTheDocument();
  });
  it("retains history when the host disables more decisions and offers refresh", async () => {
    const state = setup(); state.setLedger({ ...state.ledger, state: "unavailable", detail: "This result reached the decision limit." }); render(<AgentResultDecision {...state.props} />); await open();
    expect(screen.getByText("This result reached the decision limit.")).toBeVisible(); expect(screen.getByRole("button", { name: "Save decision" })).toBeDisabled(); expect(screen.getByRole("button", { name: "Refresh decisions" })).toBeEnabled();
  });
});
