import type { AgentWorkSet } from "../lib/agentWorkSets";
import type { AgentConversation } from "../lib/agentConversations";
import { agentTurnChangesFixture } from "./agentTurnChangesFixture";
export const WORK_SET_ID = "77777777-7777-4777-8777-777777777777";
export const WORK_TASK_ID = "88888888-8888-4888-8888-888888888888";
export const WORK_CHILD_ID = "99999999-9999-4999-8999-999999999999";
export const WORK_CHILD_WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export function agentWorkSetFixture(overrides: Partial<AgentWorkSet> = {}): AgentWorkSet {
  const receipt = agentTurnChangesFixture();
  return { schemaVersion: 1, workSetId: WORK_SET_ID, conversationId: receipt.conversationId, requestId: receipt.requestId, workspaceId: receipt.workspaceId, repositoryId: receipt.repositoryId, sourceCheckpointId: receipt.after!.checkpointId, sourceContextSha256: receipt.sourceContextSha256, kind: "tasks", revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 2, detail: "WTS saved this task plan.", tasks: [{ taskId: WORK_TASK_ID, title: "Compact layout", prompt: "Keep the composer visible.", dependsOn: [], state: "completed", conversationId: WORK_CHILD_ID, requestId: WORK_TASK_ID, workspaceId: WORK_CHILD_WORKSPACE, repositoryId: "candidate-repo", afterCheckpointId: receipt.after!.checkpointId, detail: "The candidate is ready." }], ...overrides };
}
export function agentWorkChildFixture(set = agentWorkSetFixture()): AgentConversation {
  const task = set.tasks[0];
  return { schemaVersion: 1, conversationId: task.conversationId, workspaceId: task.workspaceId!, repositoryId: task.repositoryId!, workspaceDisplayPath: "/work/candidate", provider: "codex", source: { kind: "workItem", workSetId: set.workSetId, taskId: task.taskId, label: task.title, originConversationId: set.conversationId, originRequestId: set.requestId }, revision: 1, createdAtUnixMs: 1, updatedAtUnixMs: 2, messages: [{ messageId: WORK_SET_ID, requestId: task.requestId, role: "user", body: task.prompt, status: "completed", createdAtUnixMs: 1 }] };
}
