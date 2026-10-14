import type { AgentWorkItemIntegrationPreflight } from "../lib/agentWorkSets";
import { agentWorkSetFixture } from "./agentWorkSetsFixture";
export function agentWorkItemIntegrationFixture(overrides: Partial<AgentWorkItemIntegrationPreflight> = {}): AgentWorkItemIntegrationPreflight {
  const set = agentWorkSetFixture(); const task = set.tasks[0];
  return { schemaVersion: 1, workSetId: set.workSetId, taskId: task.taskId, workspaceId: set.workspaceId, repositoryId: set.repositoryId, sourceConversationId: set.conversationId, sourceRequestId: set.requestId, sourceAfterCheckpointId: set.sourceCheckpointId, candidateWorkspaceId: task.workspaceId!, candidateConversationId: task.conversationId, candidateRequestId: task.requestId, candidateAfterCheckpointId: task.afterCheckpointId!, state: "ready", effectDigest: `sha256:${"e".repeat(64)}`, files: [{ filePath: "src/title.ts", status: "modified" }], checkRunIds: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], blockers: [], detail: "WTS can apply these candidate files.", ...overrides };
}
