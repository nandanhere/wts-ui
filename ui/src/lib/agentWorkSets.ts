import { validateAgentTurnId } from "./agentTurnChanges";
export type AgentWorkSetKind = "tasks" | "alternatives";
export interface AgentWorkItemPlan { taskId: string; title: string; prompt: string; dependsOn: string[]; }
export interface CreateAgentWorkSetRequest { requestId: string; expectedAfterCheckpointId: string; kind: AgentWorkSetKind; tasks: AgentWorkItemPlan[]; }
export interface CancelAgentWorkItemRequest { requestId: string; expectedRevision: number; }
export interface AgentWorkItem extends AgentWorkItemPlan {
  state: "pending" | "preparing" | "queued" | "running" | "completed" | "failed" | "blocked" | "cancelled";
  conversationId: string; requestId: string; workspaceId?: string; repositoryId?: string; workspaceDisplayPath?: string; afterCheckpointId?: string; detail: string;
}
export interface AgentWorkSet {
  schemaVersion: 1; workSetId: string; conversationId: string; requestId: string; workspaceId: string; repositoryId: string;
  sourceCheckpointId: string; sourceContextSha256: string; kind: AgentWorkSetKind; revision: number; createdAtUnixMs: number; updatedAtUnixMs: number;
  tasks: AgentWorkItem[]; detail: string; lastMutationRequestId?: string;
}
export interface AgentWorkSetList { schemaVersion: 1; conversationId: string; requestId: string; workSets: AgentWorkSet[]; }
type Fail = (field: string) => never;
function object(value: unknown, fail: Fail): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return fail("agentWorkSet.object"); return value as Record<string, unknown>; }
function id(value: unknown, fail: Fail) { const result = validateAgentTurnId(value, fail); if (result === "00000000-0000-0000-0000-000000000000") fail("agentWorkSet.id"); return result; }
function text(value: unknown, max: number, fail: Fail, multiline = false, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()) || new TextEncoder().encode(value).length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u).test(value)) fail("agentWorkSet.text");
}
function integer(value: unknown, fail: Fail, min = 0) { if (!Number.isSafeInteger(value) || Number(value) < min) fail("agentWorkSet.number"); }
function plans(value: unknown, kind: unknown, fail: Fail): AgentWorkItemPlan[] {
  if (!["tasks", "alternatives"].includes(String(kind)) || !Array.isArray(value) || !value.length || value.length > 8) return fail("agentWorkSet.tasks");
  const ids = new Set<string>();
  for (const raw of value) {
    const task = object(raw, fail); const taskId = id(task.taskId, fail); text(task.title, 160, fail); text(task.prompt, 16384, fail, true);
    if (ids.has(taskId)) fail("agentWorkSet.duplicateTask"); ids.add(taskId);
    if (!Array.isArray(task.dependsOn) || task.dependsOn.length > 7 || (kind === "alternatives" && task.dependsOn.length)) fail("agentWorkSet.dependencies");
  }
  const visited = new Set<string>(); const active = new Set<string>(); const tasks = value as AgentWorkItemPlan[];
  for (const task of tasks) {
    const deps = new Set<string>(); for (const dependency of task.dependsOn) { id(dependency, fail); if (!ids.has(dependency) || deps.has(dependency) || dependency === task.taskId) fail("agentWorkSet.dependencies"); deps.add(dependency); }
  }
  const visit = (taskId: string) => { if (active.has(taskId)) fail("agentWorkSet.cycle"); if (visited.has(taskId)) return; active.add(taskId); for (const dependency of tasks.find(task => task.taskId === taskId)!.dependsOn) visit(dependency); active.delete(taskId); visited.add(taskId); };
  for (const task of tasks) visit(task.taskId);
  return tasks;
}
export function validateCreateAgentWorkSet(value: unknown, fail: Fail): asserts value is CreateAgentWorkSetRequest {
  const request = object(value, fail); id(request.requestId, fail); id(request.expectedAfterCheckpointId, fail); const tasks = plans(request.tasks, request.kind, fail);
  if (Object.keys(request).some(key => !["requestId", "expectedAfterCheckpointId", "kind", "tasks"].includes(key)) || tasks.some(task => Object.keys(task).some(key => !["taskId", "title", "prompt", "dependsOn"].includes(key)))) fail("agentWorkSet.request");
}
export function validateCancelAgentWorkItem(value: unknown, fail: Fail): asserts value is CancelAgentWorkItemRequest {
  const request = object(value, fail); id(request.requestId, fail); integer(request.expectedRevision, fail, 1);
  if (Object.keys(request).some(key => !["requestId", "expectedRevision"].includes(key))) fail("agentWorkSet.request");
}
export function normalizeAgentWorkSet(value: unknown, fail: Fail, workSetId?: string): AgentWorkSet {
  const item = object(value, fail);
  if (item.schemaVersion !== 1 || (workSetId !== undefined && item.workSetId !== workSetId)) fail("agentWorkSet.identity");
  for (const field of ["workSetId", "conversationId", "requestId", "workspaceId", "sourceCheckpointId"]) id(item[field], fail);
  if (item.lastMutationRequestId !== undefined) id(item.lastMutationRequestId, fail);
  text(item.repositoryId, 4096, fail); text(item.detail, 2048, fail, true, true);
  if (typeof item.sourceContextSha256 !== "string" || !/^sha256:[0-9a-f]{64}$/.test(item.sourceContextSha256)) fail("agentWorkSet.source");
  integer(item.revision, fail, 1); integer(item.createdAtUnixMs, fail); integer(item.updatedAtUnixMs, fail);
  const tasks = plans(item.tasks, item.kind, fail) as AgentWorkItem[];
  const conversations = new Set<string>();
  for (const task of tasks) {
    id(task.conversationId, fail); id(task.requestId, fail); text(task.detail, 2048, fail, true, true);
    if (conversations.has(task.conversationId)) fail("agentWorkSet.duplicateConversation"); conversations.add(task.conversationId);
    if (!["pending", "preparing", "queued", "running", "completed", "failed", "blocked", "cancelled"].includes(task.state)) fail("agentWorkSet.state");
    for (const field of ["workspaceId", "afterCheckpointId"] as const) if (task[field] !== undefined) id(task[field], fail);
    for (const field of ["repositoryId", "workspaceDisplayPath"] as const) if (task[field] !== undefined) text(task[field], 4096, fail);
  }
  return item as unknown as AgentWorkSet;
}
export function normalizeAgentWorkSetList(value: unknown, fail: Fail, conversationId: string, requestId: string): AgentWorkSetList {
  const item = object(value, fail); if (item.schemaVersion !== 1 || item.conversationId !== conversationId || item.requestId !== requestId || !Array.isArray(item.workSets) || item.workSets.length > 64) fail("agentWorkSetList.identity");
  const ids = new Set<string>(); const workSets = (item.workSets as unknown[]).map(raw => { const set = normalizeAgentWorkSet(raw, fail); if (set.conversationId !== conversationId || set.requestId !== requestId || ids.has(set.workSetId)) fail("agentWorkSetList.identity"); ids.add(set.workSetId); return set; });
  return { schemaVersion: 1, conversationId, requestId, workSets };
}
export function matchCreatedAgentWorkSet(value: AgentWorkSet, fail: Fail, conversationId: string, requestId: string, request: CreateAgentWorkSetRequest) {
  if (value.workSetId !== request.requestId || value.conversationId !== conversationId || value.requestId !== requestId || value.sourceCheckpointId !== request.expectedAfterCheckpointId || value.kind !== request.kind || value.tasks.length !== request.tasks.length || value.tasks.some((task, index) => { const expected = request.tasks[index]; return task.taskId !== expected.taskId || task.title !== expected.title || task.prompt !== expected.prompt || JSON.stringify(task.dependsOn) !== JSON.stringify(expected.dependsOn); })) fail("agentWorkSet.acknowledgement");
  return value;
}
export function matchCancelledAgentWorkItem(value: AgentWorkSet, fail: Fail, taskId: string, request: CancelAgentWorkItemRequest) {
  if (value.lastMutationRequestId !== request.requestId || value.tasks.find(task => task.taskId === taskId)?.state !== "cancelled") fail("agentWorkSet.acknowledgement"); return value;
}
export interface AgentWorkItemPreview { schemaVersion: 1; workSetId: string; taskId: string; workspaceId: string; repositoryId: string; afterCheckpointId: string; state: "running" | "stopped" | "blocked"; url?: string; title: string; detail: string; }
export function normalizeAgentWorkItemPreview(value: unknown, fail: Fail, workSetId: string, taskId: string): AgentWorkItemPreview {
  const item = object(value, fail);
  if (item.schemaVersion !== 1 || item.workSetId !== workSetId || item.taskId !== taskId) fail("agentWorkItemPreview.identity");
  for (const key of ["workSetId", "taskId", "workspaceId", "afterCheckpointId"]) id(item[key], fail);
  text(item.repositoryId, 4096, fail); text(item.title, 512, fail); text(item.detail, 2048, fail, true, true);
  if (!["running", "stopped", "blocked"].includes(String(item.state))) fail("agentWorkItemPreview.state");
  if (item.url !== undefined) {
    text(item.url, 2048, fail); let url: URL; try { url = new URL(item.url); } catch { return fail("agentWorkItemPreview.url"); }
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password) fail("agentWorkItemPreview.url");
  }
  if (item.state === "running" && !item.url) fail("agentWorkItemPreview.url");
  if (item.state === "blocked" && item.url !== undefined) fail("agentWorkItemPreview.url");
  return item as unknown as AgentWorkItemPreview;
}
export interface AgentWorkItemIntegrationFile { filePath: string; status: "added" | "modified" | "deleted" | "typeChanged"; }
export interface AgentWorkItemIntegrationBlocker { code: string; filePath?: string; detail: string; }
export interface AgentWorkItemIntegrationPreflight {
  schemaVersion: 1; workSetId: string; taskId: string; workspaceId: string; repositoryId: string;
  sourceConversationId: string; sourceRequestId: string; sourceAfterCheckpointId: string;
  candidateWorkspaceId: string; candidateConversationId: string; candidateRequestId: string; candidateAfterCheckpointId: string;
  state: "ready" | "blocked" | "integrated"; effectDigest: string; resumeRequestId?: string;
  files: AgentWorkItemIntegrationFile[]; checkRunIds: string[]; blockers: AgentWorkItemIntegrationBlocker[]; detail: string; integratedAtUnixMs?: number;
}
export interface IntegrateAgentWorkItemRequest { requestId: string; effectDigest: string; }
export interface AgentWorkItemIntegrationResult { schemaVersion: 1; workSetId: string; taskId: string; workspaceId: string; repositoryId: string; integrationRequestId: string; state: "integrated" | "conflict" | "incomplete"; files: AgentWorkItemIntegrationFile[]; blockers: AgentWorkItemIntegrationBlocker[]; detail: string; integratedAtUnixMs?: number; }
function digest(value: unknown, fail: Fail) { if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) fail("agentWorkItemIntegration.digest"); }
function filePath(value: unknown, fail: Fail) { text(value, 4096, fail); if (value.startsWith("/") || value.includes("\\") || value.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) fail("agentWorkItemIntegration.path"); }
function integration(value: unknown, fail: Fail, workSetId: string, taskId: string) {
  const item = object(value, fail); if (item.schemaVersion !== 1 || item.workSetId !== workSetId || item.taskId !== taskId) fail("agentWorkItemIntegration.identity");
  for (const key of ["workSetId", "taskId", "workspaceId"]) id(item[key], fail); text(item.repositoryId, 4096, fail); text(item.detail, 2048, fail, true, true);
  if (item.integratedAtUnixMs !== undefined) { integer(item.integratedAtUnixMs, fail); if (Number(item.integratedAtUnixMs) > 8640000000000000) fail("agentWorkItemIntegration.time"); }
  if (!Array.isArray(item.files) || item.files.length > 2048 || !Array.isArray(item.blockers) || item.blockers.length > 64) fail("agentWorkItemIntegration.limits");
  const paths = new Set<string>(); for (const raw of item.files as unknown[]) { const file = object(raw, fail); filePath(file.filePath, fail); if (paths.has(String(file.filePath)) || !["added", "modified", "deleted", "typeChanged"].includes(String(file.status))) fail("agentWorkItemIntegration.file"); paths.add(String(file.filePath)); }
  for (const raw of item.blockers as unknown[]) { const blocker = object(raw, fail); text(blocker.code, 128, fail); text(blocker.detail, 2048, fail, true, true); if (blocker.filePath !== undefined) filePath(blocker.filePath, fail); }
  return item;
}
export function normalizeAgentWorkItemIntegrationPreflight(value: unknown, fail: Fail, workSetId: string, taskId: string): AgentWorkItemIntegrationPreflight {
  const item = integration(value, fail, workSetId, taskId);
  for (const key of ["sourceConversationId", "sourceRequestId", "sourceAfterCheckpointId", "candidateWorkspaceId", "candidateConversationId", "candidateRequestId", "candidateAfterCheckpointId"]) id(item[key], fail);
  if (!["ready", "blocked", "integrated"].includes(String(item.state))) fail("agentWorkItemIntegration.state"); digest(item.effectDigest, fail); if (item.resumeRequestId !== undefined) id(item.resumeRequestId, fail);
  if (!Array.isArray(item.checkRunIds) || item.checkRunIds.length > 64) fail("agentWorkItemIntegration.checks"); const ids = new Set<string>(); for (const runId of item.checkRunIds as unknown[]) { const next = id(runId, fail); if (ids.has(next)) fail("agentWorkItemIntegration.checks"); ids.add(next); }
  if (item.state === "ready" && (!ids.size || (item.blockers as unknown[]).length)) fail("agentWorkItemIntegration.checks");
  return item as unknown as AgentWorkItemIntegrationPreflight;
}
export function validateIntegrateAgentWorkItem(value: unknown, fail: Fail): asserts value is IntegrateAgentWorkItemRequest { const request = object(value, fail); id(request.requestId, fail); digest(request.effectDigest, fail); if (Object.keys(request).some(key => !["requestId", "effectDigest"].includes(key))) fail("agentWorkItemIntegration.request"); }
export function normalizeAgentWorkItemIntegrationResult(value: unknown, fail: Fail, workSetId: string, taskId: string, request: IntegrateAgentWorkItemRequest): AgentWorkItemIntegrationResult {
  const item = integration(value, fail, workSetId, taskId); if (item.integrationRequestId !== request.requestId || !["integrated", "conflict", "incomplete"].includes(String(item.state))) fail("agentWorkItemIntegration.acknowledgement"); id(item.integrationRequestId, fail); return item as unknown as AgentWorkItemIntegrationResult;
}
