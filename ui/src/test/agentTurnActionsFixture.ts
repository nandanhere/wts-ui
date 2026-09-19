import type { AgentTurnChecks, AgentTurnRestorePreflight } from "../lib/agentTurnActions";
import { agentTurnChangesFixture } from "./agentTurnChangesFixture";
export function agentTurnChecksFixture(change: Partial<AgentTurnChecks> = {}): AgentTurnChecks {
  const receipt = agentTurnChangesFixture();
  return { schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, afterCheckpointId: receipt.after!.checkpointId, state: "ready", detail: "WTS can run the saved checks.", checks: [{ checkId: "unit", label: "Unit tests", kind: "unit", planRevision: 1 }], runs: [], ...change };
}
export function agentTurnRestoreFixture(change: Partial<AgentTurnRestorePreflight> = {}): AgentTurnRestorePreflight {
  const receipt = agentTurnChangesFixture();
  return { schemaVersion: 1, conversationId: receipt.conversationId, requestId: receipt.requestId, sessionId: receipt.sessionId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, afterCheckpointId: receipt.after!.checkpointId, state: "ready", effectDigest: `sha256:${"e".repeat(64)}`, files: [{ filePath: "src/title.ts", action: "restore" }], blockers: [], detail: "WTS can restore the listed files.", ...change };
}
