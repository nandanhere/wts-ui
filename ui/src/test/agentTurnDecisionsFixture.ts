import type { AgentTurnDecision, AgentTurnDecisions, RecordAgentTurnDecisionRequest } from "../lib/agentTurnDecisions";
import { agentTurnChangesFixture } from "./agentTurnChangesFixture";
export function agentTurnDecisionsFixture(change: Partial<AgentTurnDecisions> = {}): AgentTurnDecisions {
  const receipt = agentTurnChangesFixture();
  return { schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, afterCheckpointId: receipt.after!.checkpointId, receiptDigest: `sha256:${"d".repeat(64)}`, sourceContextSha256: receipt.sourceContextSha256, revision: 0, state: "ready", checksState: "noChecks", detail: "No decision is recorded.", decisions: [], ...change };
}
export function agentTurnDecisionFixture(request: RecordAgentTurnDecisionRequest, change: Partial<AgentTurnDecision> = {}): AgentTurnDecision {
  const ledger = agentTurnDecisionsFixture();
  return { decisionId: request.requestId, revision: request.expectedRevision + 1, kind: request.kind, reason: request.reason, createdAtUnixMs: 5, afterCheckpointId: ledger.afterCheckpointId!, receiptDigest: request.expectedReceiptDigest, sourceContextSha256: ledger.sourceContextSha256, checksState: "stale", checks: [], ...change };
}
