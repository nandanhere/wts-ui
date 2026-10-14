import type { AgentTurnChanges } from "../lib/agentTurnChanges";

export const TURN_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
export const TURN_REQUEST_ID = "22222222-2222-4222-8222-222222222222";
export const TURN_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
export const TURN_SESSION_ID = "44444444-4444-4444-8444-444444444444";
export function agentTurnChangesFixture(overrides: Partial<AgentTurnChanges> = {}): AgentTurnChanges {
  const checkpoint = { checkpointId: "55555555-5555-4555-8555-555555555555", headCommitOid: "a".repeat(40), branchName: "wts/fix", capturedAtUnixMs: 1, treeSha256: `sha256:${"a".repeat(64)}`, indexSha256: `sha256:${"b".repeat(64)}` };
  return {
    schemaVersion: 1, conversationId: TURN_CONVERSATION_ID, requestId: TURN_REQUEST_ID,
    sessionId: TURN_SESSION_ID, workspaceId: TURN_WORKSPACE_ID, repositoryId: "repo-wts",
    sourceContextSha256: `sha256:${"c".repeat(64)}`, state: "ready", observation: "normal",
    startedAtUnixMs: 1, completedAtUnixMs: 2, before: checkpoint,
    after: { ...checkpoint, checkpointId: "66666666-6666-4666-8666-666666666666", capturedAtUnixMs: 2, treeSha256: `sha256:${"d".repeat(64)}` },
    files: [{ filePath: "src/title.ts", status: "modified", beforeSha256: `sha256:${"e".repeat(64)}`, afterSha256: `sha256:${"f".repeat(64)}`, preExistingChange: true, undoSupported: false }],
    omittedFileCount: 0, detail: "WTS recorded changes during this task.",
    patch: "diff --git a/src/title.ts b/src/title.ts\n--- a/src/title.ts\n+++ b/src/title.ts\n@@ -1 +1 @@\n-export const title = 'Old';\n+export const title = 'New';\n",
    patchTruncated: false, ...overrides,
  };
}
