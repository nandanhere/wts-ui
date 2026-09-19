import { validateConversationSource, type AgentConversationSource, type CreateAgentConversationRequest, type RegionCapture, type SendAgentConversationMessageRequest } from "./agentConversations";

export const FEEDBACK_DRAFT_KEY = "wts.agent-feedback.v1";
export const FEEDBACK_SHELF_KEY = "wts.agent-feedback.shelf.v2";
export const MAX_FEEDBACK_DRAFTS = 64;
export interface QueuedFeedbackEdit {
  body: string;
  expectedBody: string;
  mutation?: { requestId: string; action: "update" | "cancel"; body?: string };
}
export interface AgentFeedbackDraft {
  version: 1; id: string; open: boolean; body: string;
  request: CreateAgentConversationRequest; conversationId?: string;
  attempt?: SendAgentConversationMessageRequest; captureNote?: string; captureId?: string;
  queuedEdits?: Record<string, QueuedFeedbackEdit>;
  retryOrigin?: { conversationId: string; messageId: string; requestId: string };
}
export interface AgentFeedbackShelf { version: 2; open: boolean; selectedId?: string; drafts: AgentFeedbackDraft[] }
export interface FeedbackCaptureStorage {
  put: (id: string, capture: RegionCapture) => Promise<void>;
  get: (id: string) => Promise<RegionCapture | undefined>;
  keys?: () => Promise<string[]>;
  remove?: (id: string) => Promise<void>;
}
let captureDatabase: Promise<IDBDatabase> | undefined;
const pendingCaptureIds = new Set<string>();
let lastCaptureReferences = "";
function openCaptureDatabase() {
  if (!captureDatabase) {
    captureDatabase = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("Image storage is unavailable")); return; }
      const request = indexedDB.open("wts-agent-feedback", 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("captures"); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Image storage is blocked"));
    }).catch(error => { captureDatabase = undefined; throw error; });
  }
  return captureDatabase;
}
const browserCaptures: FeedbackCaptureStorage = {
  async put(id, capture) {
    const db = await openCaptureDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("captures", "readwrite"); transaction.objectStore("captures").put(capture, id);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
  },
  async get(id) {
    const db = await openCaptureDatabase();
    return await new Promise<RegionCapture | undefined>((resolve, reject) => {
      const request = db.transaction("captures", "readonly").objectStore("captures").get(id);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  },
  async keys() {
    const db = await openCaptureDatabase();
    return await new Promise<string[]>((resolve, reject) => {
      const request = db.transaction("captures", "readonly").objectStore("captures").getAllKeys();
      request.onsuccess = () => resolve(request.result.map(String)); request.onerror = () => reject(request.error);
    });
  },
  async remove(id) {
    const db = await openCaptureDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("captures", "readwrite"); transaction.objectStore("captures").delete(id);
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
    });
  },
};
export function newFeedbackDraft(source: AgentConversationSource, body = "", captureNote?: string): AgentFeedbackDraft {
  return { version: 1, id: crypto.randomUUID(), open: true, body, captureNote,
    request: { requestId: crypto.randomUUID(), provider: "codex", source } };
}
function validDraft(value: unknown): value is AgentFeedbackDraft {
  try {
    if (!value || typeof value !== "object") return false;
    const draft = value as AgentFeedbackDraft;
    if (draft.version !== 1 || typeof draft.id !== "string" || !draft.id || typeof draft.open !== "boolean" ||
      typeof draft.body !== "string" || [...draft.body].length > 16_384 ||
      typeof draft.request?.requestId !== "string" || !["codex", "openCode", "hermes", "copilot"].includes(draft.request.provider) ||
      (draft.conversationId !== undefined && typeof draft.conversationId !== "string") ||
      (draft.captureId !== undefined && (typeof draft.captureId !== "string" || draft.captureId.length > 128)) ||
      (draft.attempt !== undefined && (typeof draft.attempt.requestId !== "string" || typeof draft.attempt.body !== "string" || [...draft.attempt.body].length > 16_384))) return false;
    if (draft.retryOrigin !== undefined) {
      if (!draft.retryOrigin || typeof draft.retryOrigin !== "object" || Array.isArray(draft.retryOrigin)) return false;
      for (const field of ["conversationId", "messageId", "requestId"] as const) {
        const value = draft.retryOrigin[field];
        if (typeof value !== "string" || !value.trim() || value.length > 512 || value.includes("\0")) return false;
      }
      if (draft.retryOrigin.conversationId !== draft.conversationId) return false;
    }
    if (draft.queuedEdits !== undefined) {
      if (!draft.queuedEdits || typeof draft.queuedEdits !== "object" || Array.isArray(draft.queuedEdits)) return false;
      for (const edit of Object.values(draft.queuedEdits)) {
        if (typeof edit.body !== "string" || [...edit.body].length > 16_384 || typeof edit.expectedBody !== "string" || [...edit.expectedBody].length > 16_384) return false;
        if (edit.mutation && (typeof edit.mutation.requestId !== "string" || !["update", "cancel"].includes(edit.mutation.action) ||
          (edit.mutation.body !== undefined && (typeof edit.mutation.body !== "string" || [...edit.mutation.body].length > 16_384)))) return false;
      }
    }
    validateConversationSource(draft.request.source, () => { throw new Error("Invalid saved feedback"); });
    return true;
  } catch { return false; }
}
function legacyDraft(): AgentFeedbackDraft | null {
  try {
    const text = localStorage.getItem(FEEDBACK_DRAFT_KEY);
    if (!text || text.length > 4_000_000) return null;
    const value: unknown = JSON.parse(text); return validDraft(value) ? value : null;
  } catch { return null; }
}
export function readFeedbackShelf(): AgentFeedbackShelf {
  try {
    const text = localStorage.getItem(FEEDBACK_SHELF_KEY);
    if (text && text.length <= 4_000_000) {
      const shelf = JSON.parse(text) as AgentFeedbackShelf;
      if (shelf.version === 2 && typeof shelf.open === "boolean" && Array.isArray(shelf.drafts) && shelf.drafts.length <= MAX_FEEDBACK_DRAFTS &&
        shelf.drafts.every(validDraft) && new Set(shelf.drafts.map(draft => draft.id)).size === shelf.drafts.length &&
        (shelf.selectedId === undefined || shelf.drafts.some(draft => draft.id === shelf.selectedId))) return shelf;
    }
  } catch { /* Keep the legacy draft if the new store cannot be read. */ }
  const legacy = legacyDraft();
  return { version: 2, open: legacy?.open ?? false, selectedId: legacy?.id, drafts: legacy ? [legacy] : [] };
}
export function readFeedbackDraft(): AgentFeedbackDraft | null {
  const shelf = readFeedbackShelf(); return shelf.drafts.find(draft => draft.id === shelf.selectedId) ?? null;
}
export function saveFeedbackShelf(shelf: AgentFeedbackShelf): boolean {
  try {
    if (shelf.version !== 2 || typeof shelf.open !== "boolean" || shelf.drafts.length > MAX_FEEDBACK_DRAFTS || shelf.drafts.some(draft => !validDraft(draft)) ||
      new Set(shelf.drafts.map(draft => draft.id)).size !== shelf.drafts.length ||
      (shelf.selectedId !== undefined && !shelf.drafts.some(draft => draft.id === shelf.selectedId))) return false;
    if (shelf.drafts.some(draft => draft.request.source.kind === "ui" && draft.request.source.capture && !draft.captureId)) return false;
    const text = JSON.stringify(shelf, (key, value) => key === "capture" ? undefined : value);
    if (text.length > 4_000_000) return false;
    localStorage.setItem(FEEDBACK_SHELF_KEY, text);
    for (const draft of shelf.drafts) if (draft.captureId) pendingCaptureIds.delete(draft.captureId);
    try { localStorage.removeItem(FEEDBACK_DRAFT_KEY); } catch { /* The new shelf is already durable. */ }
    const references = shelf.drafts.map(draft => draft.captureId ?? "").filter(Boolean).sort().join(",");
    if (references !== lastCaptureReferences) { lastCaptureReferences = references; void cleanupFeedbackCaptures().catch(() => undefined); }
    return true;
  } catch { return false; }
}
export function saveFeedbackDraft(draft: AgentFeedbackDraft | null): boolean {
  const shelf = readFeedbackShelf();
  return saveFeedbackShelf({ ...shelf, open: draft?.open ?? false, selectedId: draft?.id,
    drafts: draft ? [...shelf.drafts.filter(item => item.id !== draft.id), draft] : shelf.drafts.filter(item => item.id !== shelf.selectedId) });
}
export async function persistFeedbackCapture(draft: AgentFeedbackDraft, storage: FeedbackCaptureStorage = browserCaptures): Promise<AgentFeedbackDraft> {
  if (draft.request.source.kind !== "ui" || !draft.request.source.capture || draft.captureId) return draft;
  pendingCaptureIds.add(draft.id);
  try {
    await storage.put(draft.id, draft.request.source.capture);
    return { ...draft, captureId: draft.id };
  } catch {
    pendingCaptureIds.delete(draft.id);
    if (draft.attempt) return draft;
    const { capture: _capture, ...source } = draft.request.source;
    return { ...draft, request: { ...draft.request, source }, captureNote: "WTS could not save the image. This draft includes the selected text and controls." };
  }
}
export async function cleanupFeedbackCaptures(storage: FeedbackCaptureStorage = browserCaptures): Promise<void> {
  if (!storage.keys || !storage.remove) return;
  const keys = await storage.keys();
  const retained = new Set(readFeedbackShelf().drafts.flatMap(draft => [draft.captureId, draft.request.source.kind === "ui" && draft.request.source.capture ? draft.id : undefined]).filter(Boolean));
  for (const id of keys) {
    if (pendingCaptureIds.has(id) || retained.has(id)) continue;
    await storage.remove(id);
  }
}
export async function discardUnstoredFeedbackCapture(id: string): Promise<void> {
  pendingCaptureIds.delete(id);
  await cleanupFeedbackCaptures().catch(() => undefined);
}
export async function hydrateFeedbackCapture(draft: AgentFeedbackDraft, storage: FeedbackCaptureStorage = browserCaptures): Promise<AgentFeedbackDraft> {
  if (!draft.captureId || draft.request.source.kind !== "ui" || draft.request.source.capture) return draft;
  try {
    const capture = await storage.get(draft.captureId);
    if (capture) {
      const source = { ...draft.request.source, capture };
      validateConversationSource(source, () => { throw new Error("Invalid saved image"); });
      return { ...draft, request: { ...draft.request, source } };
    }
  } catch { /* Keep the text if the image cannot be read. */ }
  if (draft.attempt) return draft;
  return { ...draft, captureId: undefined, captureNote: "WTS could not read the image. This draft includes the selected text and controls." };
}
