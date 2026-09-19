import { validateCancelAgentWorkItem, validateCreateAgentWorkSet, type AgentWorkItemPlan, type AgentWorkSetKind, type CancelAgentWorkItemRequest, type CreateAgentWorkSetRequest } from "./agentWorkSets";
export const WORK_SET_DRAFT_KEY = "wts.agent-work-set-drafts.v1";
export interface PendingWorkItemCancel { workSetId: string; taskId: string; request: CancelAgentWorkItemRequest; }
export interface AgentWorkSetDraft { key: string; kind: AgentWorkSetKind; tasks: AgentWorkItemPlan[]; pending?: CreateAgentWorkSetRequest; cancellations: PendingWorkItemCancel[]; }
export function newWorkItemDraft(): AgentWorkItemPlan { return { taskId: crypto.randomUUID(), title: "", prompt: "", dependsOn: [] }; }
export function newWorkSetDraft(key: string): AgentWorkSetDraft { return { key, kind: "tasks", tasks: [newWorkItemDraft()], cancellations: [] }; }
const storageError = () => { throw new Error("WTS could not save this task plan. Check browser storage before you start tasks."); };
function validateDraft(value: AgentWorkSetDraft) {
  if (!value || typeof value.key !== "string" || !value.key || value.key.length > 16384 || !["tasks", "alternatives"].includes(value.kind) || !Array.isArray(value.tasks) || !value.tasks.length || value.tasks.length > 8 || !Array.isArray(value.cancellations) || value.cancellations.length > 512) storageError();
  const ids = new Set<string>();
  for (const task of value.tasks) {
    if (!task || typeof task.taskId !== "string" || !task.taskId || ids.has(task.taskId) || typeof task.title !== "string" || new TextEncoder().encode(task.title).length > 640 || typeof task.prompt !== "string" || new TextEncoder().encode(task.prompt).length > 65536 || !Array.isArray(task.dependsOn) || task.dependsOn.length > 7 || task.dependsOn.some(id => typeof id !== "string")) storageError();
    ids.add(task.taskId);
  }
  if (value.pending) validateCreateAgentWorkSet(value.pending, storageError);
  const cancels = new Set<string>();
  for (const cancel of value.cancellations) {
    if (!cancel || typeof cancel.workSetId !== "string" || typeof cancel.taskId !== "string" || cancels.has(`${cancel.workSetId}:${cancel.taskId}`)) storageError();
    cancels.add(`${cancel.workSetId}:${cancel.taskId}`); validateCancelAgentWorkItem(cancel.request, storageError);
  }
}
function drafts(): AgentWorkSetDraft[] {
  try { const raw = localStorage.getItem(WORK_SET_DRAFT_KEY); if (!raw) return []; const items = JSON.parse(raw); if (!Array.isArray(items) || items.length > 64) return storageError(); const keys = new Set<string>(); for (const item of items) { validateDraft(item); if (keys.has(item.key)) return storageError(); keys.add(item.key); } return items; } catch { return storageError(); }
}
export function readWorkSetDraft(key: string) { return drafts().find(draft => draft.key === key) ?? newWorkSetDraft(key); }
export function saveWorkSetDraft(draft: AgentWorkSetDraft) {
  validateDraft(draft); const items = drafts().filter(item => item.key !== draft.key);
  if (draft.pending || draft.cancellations.length || draft.kind !== "tasks" || draft.tasks.some(task => task.title || task.prompt || task.dependsOn.length)) {
    if (items.length >= 64) throw new Error("Discard an earlier task plan before you start another one. WTS kept your saved plans."); items.push(draft);
  }
  try { localStorage.setItem(WORK_SET_DRAFT_KEY, JSON.stringify(items)); } catch { storageError(); }
}
