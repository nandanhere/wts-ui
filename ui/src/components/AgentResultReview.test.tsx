import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AgentConversation } from "../lib/agentConversations";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
import { agentTurnChangesFixture, TURN_CONVERSATION_ID, TURN_REQUEST_ID, TURN_WORKSPACE_ID, TURN_SESSION_ID } from "../test/agentTurnChangesFixture";
import { agentTurnChecksFixture, agentTurnRestoreFixture } from "../test/agentTurnActionsFixture";
import { AgentResultReview } from "./AgentResultReview";

const viewer = vi.hoisted(() => vi.fn());
vi.mock("../variants/local-workspace/RepositoryPatchViewer", () => ({ RepositoryPatchViewer: (props: { patch: string }) => { viewer(props); return <pre data-testid="recorded-patch">{props.patch}</pre>; } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}
const conversation: AgentConversation = { schemaVersion: 1, conversationId: TURN_CONVERSATION_ID, workspaceId: TURN_WORKSPACE_ID, repositoryId: "repo-wts", workspaceDisplayPath: "/work/wts", provider: "codex", source: { kind: "ui", route: "/", calloutId: "title", label: "Title" }, revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 2, messages: [] };
function setup() {
  const get = vi.fn().mockResolvedValue(agentTurnChangesFixture());
  const client = { getAgentTurnChanges: get } as unknown as WorkspaceClient;
  return { get, client, props: { client, conversation, requestId: TURN_REQUEST_ID, sessionId: TURN_SESSION_ID } };
}

describe("task result review", () => {
  it("offers one return action for a same-origin UI preview", async () => {
    const user = userEvent.setup(); const { props } = setup(); const onReturn = vi.fn();
    render(<AgentResultReview {...props} conversation={{ ...conversation, preview: { url: `${window.location.origin}/preview`, repositoryId: conversation.repositoryId } }} onReturnToSelection={onReturn} />);
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByTestId("recorded-patch");
    expect(screen.queryByRole("button", { name: "Preview in WTS" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Return to selection" }));
    expect(onReturn).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Task changes" })).not.toBeInTheDocument();
  });

  it("starts alternatives only after explicit task prompts and preserves the recorded source", async () => {
    const user = userEvent.setup(); const { props, client } = setup(); const receipt = agentTurnChangesFixture();
    client.listAgentWorkSets = vi.fn().mockResolvedValue({ schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, workSets: [] });
    client.createAgentWorkSet = vi.fn().mockImplementation(async (_conversation, _turn, request) => ({ schemaVersion: 1, workSetId: request.requestId, conversationId: receipt.conversationId, requestId: receipt.requestId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, sourceCheckpointId: request.expectedAfterCheckpointId, sourceContextSha256: receipt.sourceContextSha256, kind: request.kind, revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 1, detail: "WTS started the alternatives.", tasks: request.tasks.map((task: import("../lib/agentWorkSets").AgentWorkItemPlan, index: number) => ({ ...task, conversationId: `child-${index}`, requestId: task.taskId, state: "queued", detail: "The task is queued." })) }));
    render(<AgentResultReview {...props} />); await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(await screen.findByText("Tasks and alternatives"));
    expect(client.createAgentWorkSet).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "Alternatives" }));
    await user.type(screen.getByRole("textbox", { name: "Task title 1" }), "Compact layout"); await user.type(screen.getByRole("textbox", { name: "Task prompt 1" }), "Use a compact header.");
    await user.type(screen.getByRole("textbox", { name: "Task title 2" }), "Roomy layout"); await user.type(screen.getByRole("textbox", { name: "Task prompt 2" }), "Use larger controls.");
    expect(client.createAgentWorkSet).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Start alternatives" })); await screen.findByText("WTS started the alternatives.");
    expect(client.createAgentWorkSet).toHaveBeenCalledExactlyOnceWith(TURN_CONVERSATION_ID, TURN_REQUEST_ID, expect.objectContaining({ kind: "alternatives", expectedAfterCheckpointId: receipt.after!.checkpointId, tasks: [expect.objectContaining({ title: "Compact layout", dependsOn: [] }), expect.objectContaining({ title: "Roomy layout", dependsOn: [] })] }));
  });

  it("records a review decision only after an explicit choice and save", async () => {
    const user = userEvent.setup(); const { props, client } = setup();
    const receipt = agentTurnChangesFixture();
    const ledger = { schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, afterCheckpointId: receipt.after!.checkpointId, receiptDigest: `sha256:${"d".repeat(64)}`, sourceContextSha256: receipt.sourceContextSha256, revision: 0, state: "ready", checksState: "noChecks", detail: "No decision is recorded.", decisions: [] };
    client.getAgentTurnDecisions = vi.fn().mockResolvedValue(ledger);
    client.recordAgentTurnDecision = vi.fn().mockImplementation(async (_id, _turn, request) => ({ ...ledger, revision: 1, decisions: [{ decisionId: request.requestId, revision: 1, kind: request.kind, reason: request.reason, createdAtUnixMs: 2, afterCheckpointId: receipt.after!.checkpointId, receiptDigest: ledger.receiptDigest, sourceContextSha256: receipt.sourceContextSha256, checksState: "noChecks", checks: [] }] }));
    render(<AgentResultReview {...props} />); expect(client.getAgentTurnDecisions).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(await screen.findByText("Decision · Not set"));
    expect(client.recordAgentTurnDecision).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: "Keep as alternative" }));
    await user.type(screen.getByRole("textbox", { name: "Reason (optional)" }), "Compare this option later.");
    expect(client.recordAgentTurnDecision).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save decision" }));
    await screen.findByText("Decision · Alternative");
    expect(client.recordAgentTurnDecision).toHaveBeenCalledExactlyOnceWith(TURN_CONVERSATION_ID, TURN_REQUEST_ID, expect.objectContaining({ expectedRevision: 0, expectedReceiptDigest: ledger.receiptDigest, kind: "kept", reason: "Compare this option later." }));
  });

  it("reads host checks only when requested and runs the exact saved check once", async () => {
    const user = userEvent.setup(); const { props, client } = setup();
    client.getAgentTurnChecks = vi.fn().mockResolvedValue(agentTurnChecksFixture());
    client.runAgentTurnCheck = vi.fn().mockImplementation(async (_conversation, _turn, request) => agentTurnChecksFixture({ runs: [{ runId: request.requestId, checkId: request.checkId, status: "passed", startedAtUnixMs: 1, output: "1 test passed.", outputTruncated: false, detail: "The check passed." }] }));
    render(<AgentResultReview {...props} />);
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByTestId("recorded-patch");
    expect(client.getAgentTurnChecks).not.toHaveBeenCalled(); expect(client.runAgentTurnCheck).not.toHaveBeenCalled();
    await user.click(screen.getByText("Host checks"));
    await user.click(await screen.findByRole("button", { name: "Run Unit tests" }));
    await screen.findByText("The check passed.");
    expect(client.runAgentTurnCheck).toHaveBeenCalledExactlyOnceWith(TURN_CONVERSATION_ID, TURN_REQUEST_ID, expect.objectContaining({ checkId: "unit", expectedAfterCheckpointId: agentTurnChangesFixture().after!.checkpointId, expectedPlanRevision: 1 }));
  });

  it("shows exact restore effects before an explicit restore request", async () => {
    const user = userEvent.setup(); const { props, client } = setup();
    const preflight = agentTurnRestoreFixture();
    client.preflightAgentTurnRestore = vi.fn().mockResolvedValue(preflight);
    client.restoreAgentTurn = vi.fn().mockImplementation(async (_conversation, _turn, request) => ({ schemaVersion: 1, conversationId: TURN_CONVERSATION_ID, requestId: TURN_REQUEST_ID, restoreRequestId: request.requestId, state: "restored", files: preflight.files, blockers: [], detail: "WTS restored the listed files." }));
    render(<AgentResultReview {...props} />);
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByTestId("recorded-patch");
    expect(client.preflightAgentTurnRestore).not.toHaveBeenCalled(); expect(client.restoreAgentTurn).not.toHaveBeenCalled();
    await user.click(screen.getByText("Restore task changes"));
    await screen.findByText("WTS can restore the listed files.");
    const section = screen.getByRole("region", { name: "Restore task changes" });
    expect(section).toHaveTextContent("src/title.ts");
    await user.click(within(section).getByRole("button", { name: "Restore 1 file" }));
    await screen.findByText("WTS restored the listed files.");
    expect(client.restoreAgentTurn).toHaveBeenCalledExactlyOnceWith(TURN_CONVERSATION_ID, TURN_REQUEST_ID, expect.objectContaining({ effectDigest: preflight.effectDigest }));
  });

  it("keeps the exact bounded patch read-only and lists baseline changes separately", async () => {
    const user = userEvent.setup(); const { props, get } = setup();
    const receipt = agentTurnChangesFixture({ state: "incomplete", observation: "recovered", omittedFileCount: 2, patchTruncated: true });
    get.mockResolvedValue(receipt); render(<AgentResultReview {...props} />);
    expect(get).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByTestId("recorded-patch");
    expect(viewer).toHaveBeenLastCalledWith(expect.objectContaining({ patch: receipt.patch, disableFullFile: true, calloutPrefix: { id: "agent-result-review", label: "Task result" } }));
    expect(viewer.mock.calls.at(-1)![0].feedback).toBeUndefined();
    expect(viewer.mock.calls.at(-1)![0].lineCommentProvider).toBeUndefined();
    const dialog = screen.getByRole("dialog", { name: "Task changes" });
    expect(dialog).toHaveTextContent("Host checks");
    expect(dialog).toHaveTextContent("Some files had local changes before this task.");
    expect(dialog).toHaveTextContent("It can include changes from outside this task.");
    expect(dialog).toHaveTextContent("The patch is incomplete.");
    await user.click(within(dialog).getByText("1 file changed · 2 omitted"));
    expect(within(dialog).getByText("src/title.ts")).toBeVisible();
    expect(within(dialog).getByText("Local changes before task")).toBeVisible();
  });

  it("retries the same failed read and keeps a displayed record after a refresh error", async () => {
    const user = userEvent.setup(); const { props, get } = setup();
    get.mockRejectedValueOnce(new WorkspaceClientError("The record is not available yet.", { code: "agent_turn_changes_unavailable" }));
    render(<AgentResultReview {...props} />);
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByText("The record is not available yet.");
    await user.click(screen.getByRole("button", { name: "Retry record" }));
    const patch = await screen.findByTestId("recorded-patch");
    get.mockRejectedValueOnce(new Error("Connection lost."));
    await user.click(screen.getByRole("button", { name: "Refresh record" }));
    await screen.findByText("Connection lost. The displayed record remains available.");
    expect(patch).toBeVisible();
    expect(get.mock.calls).toEqual(Array.from({ length: 3 }, () => [TURN_CONVERSATION_ID, TURN_REQUEST_ID]));
  });

  it("offers current changes when an older host has no receipt capability", async () => {
    const user = userEvent.setup(); const { props } = setup();
    const open = vi.fn(); window.addEventListener("wts:open-agent-workspace", open);
    try {
      render(<AgentResultReview {...props} client={{} as WorkspaceClient} />);
      await user.click(screen.getByRole("button", { name: "Review changes" }));
      expect(await screen.findByText(/This WTS host cannot show task change records/)).toBeVisible();
      expect(screen.queryByRole("button", { name: /Refresh record|Retry record/ })).not.toBeInTheDocument();
      await user.click(screen.getByRole("link", { name: "View current local changes" }));
      expect(open).toHaveBeenCalledOnce();
      expect(open.mock.calls[0][0].detail).toEqual({ workspaceId: TURN_WORKSPACE_ID, repositoryId: "repo-wts" });
    } finally { window.removeEventListener("wts:open-agent-workspace", open); }
  });

  it.each(["capturing", "unavailable"] as const)("keeps a %s record honest without inventing a successful empty result", async (state) => {
    const { props, get } = setup();
    get.mockResolvedValue(agentTurnChangesFixture({ state, before: undefined, after: undefined, files: [], patch: "" }));
    render(<AgentResultReview {...props} />); fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByText("No file changes are available in this record.");
    expect(screen.queryByText("WTS observed no file changes during this task.")).not.toBeInTheDocument();
  });

  it.each(["conversationId", "requestId", "workspaceId", "repositoryId", "sessionId"] as const)("rejects a record from another %s", async (field) => {
    const { props, get } = setup(); get.mockResolvedValue({ ...agentTurnChangesFixture(), [field]: "another" });
    render(<AgentResultReview {...props} />); fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByText("The task change record does not match this result.");
    expect(screen.queryByTestId("recorded-patch")).not.toBeInTheDocument();
  });

  it("ignores an old client read and hides its record when the client changes", async () => {
    const first = setup(); const second = setup();
    const pending = deferred<ReturnType<typeof agentTurnChangesFixture>>(); first.get.mockReturnValue(pending.promise);
    second.get.mockResolvedValue(agentTurnChangesFixture({ detail: "Current host record.", patch: "current host patch" }));
    const view = render(<AgentResultReview {...first.props} />);
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await waitFor(() => expect(first.get).toHaveBeenCalledOnce());
    view.rerender(<AgentResultReview {...second.props} />);
    await screen.findByText("Current host record.");
    await act(async () => pending.resolve(agentTurnChangesFixture({ detail: "Obsolete host record." })));
    expect(screen.queryByText("Obsolete host record.")).not.toBeInTheDocument();
    expect(screen.getByTestId("recorded-patch")).toHaveTextContent("current host patch");
  });

  it("does not install a late record after close and reopen", async () => {
    const user = userEvent.setup(); const { props, get } = setup();
    const pending = deferred<ReturnType<typeof agentTurnChangesFixture>>(); get.mockReturnValueOnce(pending.promise);
    render(<AgentResultReview {...props} />);
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await user.click(screen.getByRole("button", { name: "Close task changes" }));
    await user.click(screen.getByRole("button", { name: "Review changes" }));
    await screen.findByTestId("recorded-patch");
    await act(async () => pending.resolve(agentTurnChangesFixture({ detail: "Obsolete record." })));
    expect(screen.queryByText("Obsolete record.")).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  });
});
