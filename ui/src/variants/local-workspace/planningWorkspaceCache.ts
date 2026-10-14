import type { WorkspaceClient, WorkspacePlanningDocument, WorkspacePlanningDocumentDescriptor, WorkspacePlanningDocumentId, WorkspaceReviewThread } from "../../lib/wtsClient";
import { WorkspaceMemoryCache } from "./workspaceMemoryCache";

export interface PlanningView {
  selectedId: WorkspacePlanningDocumentId | null;
  document: WorkspacePlanningDocument | null;
  documentView: "preview" | "source";
  editing: boolean;
  draft: string;
  query: string;
  filter: "current" | "old" | "all";
  feedbackDraft: string;
  selectedLine: number | null;
  collapsedFolders?: string[];
}

export type PlanningSaveEvent =
  | { state: "saving" }
  | { state: "saved"; document: WorkspacePlanningDocument; previousSha256: string; submittedContents: string }
  | { state: "error"; error: unknown };

let nextClientId = 0;
const clients = new WeakMap<WorkspaceClient, ReturnType<typeof createCache>>();

function createCache() {
  return {
    id: ++nextClientId,
    lists: new WorkspaceMemoryCache<WorkspacePlanningDocumentDescriptor[]>(),
    documents: new WorkspaceMemoryCache<WorkspacePlanningDocument>(48),
    threads: new WorkspaceMemoryCache<WorkspaceReviewThread[]>(),
    views: new WorkspaceMemoryCache<PlanningView>(),
    drafts: new Map<string, PlanningView>(),
    saves: new Set<string>(),
    saveListeners: new Map<string, Set<(event: PlanningSaveEvent) => void>>(),
  };
}

export function publishPlanningSave(client: WorkspaceClient, workspaceId: string, documentId: WorkspacePlanningDocumentId, event: PlanningSaveEvent) {
  const cache = planningCacheFor(client);
  const key = planningDocumentCacheKey(workspaceId, documentId);
  if (event.state === "saving") cache.saves.add(key);
  else cache.saves.delete(key);
  cache.saveListeners.get(key)?.forEach(listener => listener(event));
}

export function observePlanningSave(client: WorkspaceClient, workspaceId: string, documentId: WorkspacePlanningDocumentId, listener: (event: PlanningSaveEvent) => void) {
  const cache = planningCacheFor(client);
  const key = planningDocumentCacheKey(workspaceId, documentId);
  const listeners = cache.saveListeners.get(key) ?? new Set();
  listeners.add(listener);
  cache.saveListeners.set(key, listeners);
  if (cache.saves.has(key)) listener({ state: "saving" });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) cache.saveListeners.delete(key);
  };
}

export function planningViewFor(client: WorkspaceClient, workspaceId: string) {
  const cache = planningCacheFor(client);
  return cache.drafts.get(workspaceId) ?? cache.views.get(workspaceId);
}

export function rememberPlanningView(client: WorkspaceClient, workspaceId: string, view: PlanningView): boolean {
  const cache = planningCacheFor(client);
  if (view.editing || view.feedbackDraft.trim()) {
    if (!cache.drafts.has(workspaceId) && cache.drafts.size >= 24) return false;
    cache.drafts.set(workspaceId, view);
  } else {
    cache.drafts.delete(workspaceId);
  }
  cache.views.set(workspaceId, view);
  return true;
}

export function planningCacheFor(client: WorkspaceClient) {
  let cache = clients.get(client);
  if (!cache) {
    cache = createCache();
    clients.set(client, cache);
  }
  return cache;
}

export function planningDocumentCacheKey(workspaceId: string, documentId: WorkspacePlanningDocumentId) {
  return `${workspaceId}\0${documentId}`;
}

export function clearPlanningWorkspaceCache(client: WorkspaceClient, workspaceId: string) {
  const cache = clients.get(client);
  cache?.lists.delete(workspaceId);
  cache?.threads.delete(workspaceId);
  cache?.views.delete(workspaceId);
  cache?.drafts.delete(workspaceId);
  cache?.documents.deletePrefix(`${workspaceId}\0`);
}
