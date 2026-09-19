import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AgentConversation } from "../lib/agentConversations";
import type { WorkspaceClient } from "../lib/wtsClient";
import { agentTurnChangesFixture } from "../test/agentTurnChangesFixture";
import { agentTurnDecisionFixture, agentTurnDecisionsFixture } from "../test/agentTurnDecisionsFixture";
import { getWorkspaceAttentionStore } from "../variants/local-workspace/workspaceAttention";
import { AgentResultDecision } from "./AgentResultDecision";

beforeEach(() => localStorage.clear());

it("keeps an opened result in attention until the host confirms its review decision", async () => {
  const receipt = agentTurnChangesFixture();
  let ledger = agentTurnDecisionsFixture();
  const conversation: AgentConversation = {
    schemaVersion: 1, conversationId: receipt.conversationId, workspaceId: receipt.workspaceId,
    workspaceDisplayPath: "/work/wts", repositoryId: receipt.repositoryId, provider: "codex",
    source: { kind: "ui", route: "/", calloutId: "workspace-board", label: "Workspace board" },
    revision: 3, createdAtUnixMs: 1, updatedAtUnixMs: 3,
    messages: [
      { role: "user", messageId: receipt.requestId, requestId: receipt.requestId, sessionId: receipt.sessionId, body: "Fix the board.", createdAtUnixMs: 1, status: "completed" },
      { role: "assistant", messageId: "result-message", sessionId: receipt.sessionId, body: "The board is ready.", createdAtUnixMs: 3, status: "completed" },
    ],
  };
  const get = vi.fn(async () => ledger);
  const post: WorkspaceClient["recordAgentTurnDecision"] = vi.fn(async (_id, _turn, request) => {
    ledger = { ...ledger, revision: request.expectedRevision + 1, decisions: [...ledger.decisions, agentTurnDecisionFixture(request)] };
    return ledger;
  });
  const client = { getAgentTurnDecisions: get, recordAgentTurnDecision: post,
    listAgentConversations: vi.fn().mockResolvedValue({ schemaVersion: 1, conversations: [conversation] }) } as unknown as WorkspaceClient;
  const store = getWorkspaceAttentionStore(client);
  await store.refresh([{ workspaceId: receipt.workspaceId, materialized: false }]);
  expect(store.getSnapshot().items).toHaveLength(1);
  render(<AgentResultDecision client={client} receipt={receipt} />);
  fireEvent.click(await screen.findByText("Decision · Not set"));
  expect(post).not.toHaveBeenCalled();
  expect(store.getSnapshot().items).toHaveLength(1);
  fireEvent.click(screen.getByRole("radio", { name: "Accept result" }));
  fireEvent.click(screen.getByRole("button", { name: "Save decision" }));
  await screen.findByText("Decision · Accepted");
  await waitFor(() => expect(store.getSnapshot().items).toHaveLength(0));
  expect(store.getSnapshot().history).toEqual([expect.objectContaining({ target: expect.objectContaining({ conversationId: receipt.conversationId, requestId: receipt.requestId, messageId: "result-message", sessionId: receipt.sessionId }) })]);
  expect(post).toHaveBeenCalledTimes(1);
});
