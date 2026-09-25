import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { buildFeedbackTimeline } from "../lib/agentFeedbackTimeline";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { WorkspaceClientError, type AgentProvider, type WorkspaceClient } from "../lib/wtsClient";
import type { AgentConversation, AgentConversationMessage, AgentConversationSource } from "../lib/agentConversations";
import { cleanupFeedbackCaptures, discardUnstoredFeedbackCapture, hydrateFeedbackCapture, MAX_FEEDBACK_DRAFTS, newFeedbackDraft, persistFeedbackCapture, readFeedbackShelf, saveFeedbackShelf,
  type AgentFeedbackDraft, type AgentFeedbackShelf, type QueuedFeedbackEdit } from "../lib/agentFeedbackDraft";
import { AGENT_FEEDBACK_REQUESTED_EVENT, AGENT_FEEDBACK_RESULT_REQUESTED_EVENT, AGENT_TASK_REQUESTED_EVENT, type AgentFeedbackResultTarget, type AgentTaskRequest } from "../lib/agentFeedbackEvents";
import { canCaptureUiRegion, UI_REGION_SELECTED_EVENT, type UiRegionSelection } from "./uiRegionSelection";
import { GitlabDiscussionBody } from "../variants/local-workspace/GitlabDiscussionBody";
import type { GitlabDiscussionFixContext } from "../variants/local-workspace/gitlabDiscussionFixContext";
import { SelectMenu } from "./SelectMenu";
import { AgentResultReview } from "./AgentResultReview";
import { returnToFeedbackSelection } from "../lib/agentFeedbackNavigation";
import styles from "./AgentFeedbackBubble.module.css";

type ChatError = { text: string; retry?: "send" | "refresh" | "mutation"; messageId?: string; settings?: boolean };
type TaskOperation = { busy?: boolean; capturePending?: boolean; error?: ChatError; rejectedRequestId?: string };
const uncertainSend: ChatError = { text: "WTS could not confirm this send. Your draft is saved. Retry send checks the same request.", retry: "send" };
const storageBeforeSend: ChatError = { text: "WTS could not save this request. Free local storage, then select Retry send.", retry: "send" };
const rejectedBeforeExecution = new Set(["invalid_agent_conversation", "agent_conversation_source_unavailable", "agent_conversation_storage_full",
  "agent_conversation_limit", "agent_conversation_platform_unavailable", "agent_conversation_not_found", "agent_conversation_conflict", "agent_conversation_busy", "agent_conversation_queue_full"]);
function sourceLabel(source: AgentConversationSource) {
  return source.kind === "ui" || source.kind === "workItem" ? source.label : `${source.filePath ?? "General discussion"}${source.line ? `:${source.line}` : ""} · MR !${source.iid}`;
}
function mrSource(context: GitlabDiscussionFixContext): AgentConversationSource {
  const { kind, workspaceId, repositoryId, providerRepositoryId, iid, discussionId, scopeId, title,
    sourceBranch, targetBranch, filePath, side, line, position, comments } = context;
  return { kind, workspaceId, repositoryId, providerRepositoryId, iid, discussionId, scopeId, title,
    sourceBranch, targetBranch, filePath, side, line, position, comments };
}
function hasActiveTask(conversation?: AgentConversation) {
  return !!conversation?.activeSessionId || !!conversation?.messages.some(message => message.status === "pending" || message.status === "running");
}
function queuedCount(conversation?: AgentConversation) { return conversation?.messages.filter(message => message.role === "user" && message.status === "queued").length ?? 0; }
function providerLabel(provider: AgentProvider) {
  return { codex: "Codex", openCode: "OpenCode", hermes: "Hermes", copilot: "Copilot" }[provider];
}
function withoutImage(source: AgentConversationSource): AgentConversationSource {
  if (source.kind !== "ui") return source;
  const { capture: _capture, ...text } = source; return text;
}
function queuePositions(conversation: AgentConversation) { return conversation.messages.map(message => message.queuePosition ?? "").join(","); }
function sameSnapshot(previous: AgentConversation | undefined, next: AgentConversation) {
  return previous && (previous.revision > next.revision || (previous.revision === next.revision && queuePositions(previous) === queuePositions(next)));
}
function genericFailure(error: string) {
  return error === "The agent turn stopped or failed. Check the provider and review the files before you retry."
    || /^The provider stopped(?: with exit code -?\d+)?\. Review the diagnostic details and local changes before you continue from saved work\.$/.test(error);
}

export function AgentFeedbackBubble({ client }: { client: WorkspaceClient }) {
  const [shelf, setShelfState] = useState<AgentFeedbackShelf>(readFeedbackShelf);
  const shelfRef = useRef(shelf);
  const [snapshots, setSnapshots] = useState<Record<string, AgentConversation>>({});
  const snapshotsRef = useRef(snapshots);
  const [operations, setOperations] = useState<Record<string, TaskOperation>>({});
  const operationsRef = useRef(operations);
  const [storageError, setStorageError] = useState(false);
  const [listError, setListError] = useState("");
  const [listPending, setListPending] = useState(false);
  const [selectionPending, setSelectionPending] = useState(false);
  const selectionGeneration = useRef(0);
  const [resultNavigation, setResultNavigation] = useState<{ target: AgentFeedbackResultTarget; pending: boolean; error: string }>();
  const resultNavigationGeneration = useRef(0);
  const resultTargetRef = useRef<AgentFeedbackResultTarget | undefined>(undefined);
  const resultFocusRef = useRef<string | undefined>(undefined);
  const resultElements = useRef(new Map<string, HTMLElement>());
  const resultErrorRef = useRef<HTMLDivElement>(null);
  const clientScope = useRef({ client, version: 0 });
  if (clientScope.current.client !== client) clientScope.current = { client, version: clientScope.current.version + 1 };
  const clientVersion = clientScope.current.version;
  const mounted = useRef(true);
  const isCurrentClient = useCallback(() => mounted.current && clientScope.current.version === clientVersion, [clientVersion]);
  const rootRef = useRef<HTMLDivElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const savedDraftsRef = useRef<HTMLDetailsElement>(null);
  const queuedFocusRef = useRef<string | null>(null);
  const queuedInputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const contentRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const resultSummaryRef = useRef<HTMLElement>(null);
  const focusedSelectionRef = useRef<string | undefined>(undefined);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const listRequest = useRef(0);
  const draft = shelf.drafts.find(item => item.id === shelf.selectedId);
  const conversation = draft?.conversationId ? snapshots[draft.conversationId] : undefined;
  const operation = draft ? operations[draft.id] ?? {} : {};
  const latestAssistant = conversation?.messages.slice().reverse().find(message => message.role === "assistant");
  const failedTurn = latestAssistant && ["failed", "interrupted"].includes(latestAssistant.status) ? latestAssistant : undefined;
  const rememberFocus = () => {
    if (document.activeElement instanceof HTMLElement && !rootRef.current?.contains(document.activeElement)) returnFocus.current = document.activeElement;
  };
  const updateShelf = useCallback((next: AgentFeedbackShelf) => {
    const stored = saveFeedbackShelf(next); shelfRef.current = next; setShelfState(next); setStorageError(!stored); return stored;
  }, []);
  const clearResultNavigation = useCallback(() => {
    resultNavigationGeneration.current += 1;
    resultTargetRef.current = undefined;
    resultFocusRef.current = undefined;
    setResultNavigation(undefined);
  }, []);
  const openResult = useCallback(async (target: AgentFeedbackResultTarget) => {
    const validId = (value: unknown) => typeof value === "string" && Boolean(value.trim()) && value.length <= 512 && !value.includes("\0");
    if (!target || !validId(target.conversationId) || !validId(target.requestId) || (target.messageId !== undefined && !validId(target.messageId))) return;
    const generation = ++resultNavigationGeneration.current;
    resultTargetRef.current = target;
    resultFocusRef.current = undefined;
    ++selectionGeneration.current; setSelectionPending(false); rememberFocus();
    followLatestRef.current = false;
    updateShelf({ ...shelfRef.current, open: true });
    setResultNavigation({ target, pending: true, error: "" });
    try {
      if (!client.getAgentConversation) throw new Error("This WTS connection cannot read saved results. Update WTS, then open the result again.");
      const loaded = await client.getAgentConversation(target.conversationId);
      if (!isCurrentClient() || generation !== resultNavigationGeneration.current) return;
      if (loaded.conversationId !== target.conversationId) throw new Error("The saved result does not match this task. Select Retry result to read it again.");
      const previous = snapshotsRef.current[target.conversationId];
      const result = previous && previous.revision > loaded.revision ? previous : loaded;
      const requests = result.messages.filter(message => message.role === "user" && message.requestId === target.requestId);
      const answers = result.messages.filter(message => message.role === "assistant" && message.requestId === target.requestId &&
        message.status === "completed" && (target.messageId === undefined || message.messageId === target.messageId));
      if (requests.length !== 1 || answers.length !== 1 || requests[0]!.status !== "completed") {
        throw new Error("This saved result is not available in the current task. Select Retry result to check again.");
      }
      const next = { ...snapshotsRef.current, [result.conversationId]: result };
      snapshotsRef.current = next; setSnapshots(next);
      resultFocusRef.current = `${result.conversationId}/${answers[0]!.messageId}`;
      setResultNavigation({ target, pending: false, error: "" });
    } catch (cause) {
      if (isCurrentClient() && generation === resultNavigationGeneration.current) {
        setResultNavigation({ target, pending: false, error: cause instanceof Error ? cause.message : "WTS could not read this saved result. Select Retry result." });
      }
    }
  }, [client, isCurrentClient, updateShelf]);
  useEffect(() => {
    const open = ({ detail }: CustomEvent<AgentFeedbackResultTarget>) => { void openResult(detail); };
    window.addEventListener(AGENT_FEEDBACK_RESULT_REQUESTED_EVENT, open);
    return () => { clearResultNavigation(); window.removeEventListener(AGENT_FEEDBACK_RESULT_REQUESTED_EVENT, open); };
  }, [openResult, clearResultNavigation]);
  const updateDraft = useCallback((id: string, patch: Partial<AgentFeedbackDraft>) => {
    const current = shelfRef.current; if (!current.drafts.some(item => item.id === id)) return false;
    return updateShelf({ ...current, drafts: current.drafts.map(item => item.id === id ? { ...item, ...patch } : item) });
  }, [updateShelf]);
  const updateOperation = useCallback((id: string, patch: Partial<TaskOperation>) => {
    const next = { ...operationsRef.current, [id]: { ...operationsRef.current[id], ...patch } };
    operationsRef.current = next; setOperations(next);
  }, []);
  const acceptConversation = useCallback((result: AgentConversation, draftId?: string) => {
    if (!isCurrentClient()) return false;
    if (!sameSnapshot(snapshotsRef.current[result.conversationId], result)) {
      const next = { ...snapshotsRef.current, [result.conversationId]: result }; snapshotsRef.current = next; setSnapshots(next);
    }
    let stored = true;
    const matching = shelfRef.current.drafts.filter(item => item.id === draftId || (item.conversationId ?? item.request.requestId) === result.conversationId);
    for (const current of matching) {
      const accepted = current.attempt && result.messages.some(message => message.role === "user" && message.requestId === current.attempt?.requestId && (message.submittedBody ?? message.body) === current.attempt?.body);
      const legacyAccepted = !current.retryOrigin && !current.attempt && current.body && matching.some(retry => retry.retryOrigin && result.messages.some(message => message.role === "user" && message.requestId === retry.retryOrigin?.requestId && (message.submittedBody ?? message.body) === current.body));
      const edits = { ...current.queuedEdits }; let changedEdit = false;
      for (const [messageId, edit] of Object.entries(edits)) if (edit.mutation && result.messages.some(message => message.messageId === messageId && message.lastMutationRequestId === edit.mutation?.requestId)) { delete edits[messageId]; changedEdit = true; }
      if (accepted) updateOperation(current.id, { error: undefined, rejectedRequestId: undefined });
      if (current.conversationId !== result.conversationId || accepted || legacyAccepted || changedEdit || current.captureId) {
        stored = updateDraft(current.id, { conversationId: result.conversationId,
          captureId: undefined, request: { ...current.request, source: withoutImage(current.request.source) },
          ...(legacyAccepted ? { body: "" } : {}),
          ...(accepted ? { body: current.body === current.attempt?.body ? "" : current.body, attempt: undefined } : {}),
          ...(changedEdit ? { queuedEdits: edits } : {}) }) && stored;
      }
    }
    return stored;
  }, [isCurrentClient, updateDraft, updateOperation]);
  const refreshTask = useCallback(async (id: string) => {
    const current = shelfRef.current.drafts.find(item => item.id === id); if (!current || !client.getAgentConversation) return;
    try {
      const result = await client.getAgentConversation(current.conversationId ?? current.request.requestId);
      if (!isCurrentClient()) return;
      if (result.conversationId !== (current.conversationId ?? current.request.requestId)) throw new Error("Task identity changed");
      acceptConversation(result, id);
      if (!current.attempt) updateOperation(id, { error: undefined });
    } catch { if (isCurrentClient()) updateOperation(id, { error: current.attempt ? operationsRef.current[id]?.error ?? uncertainSend : { text: "WTS could not refresh this task. Your draft is saved. Select Refresh task to check again.", retry: "refresh" } }); }
  }, [client, isCurrentClient, acceptConversation, updateOperation]);
  const refreshList = useCallback(async () => {
    const generation = ++listRequest.current;
    if (!client.listAgentConversations) { setListError("This WTS connection cannot list tasks. Update WTS to restore the task list."); return; }
    setListPending(true);
    try {
      const result = await client.listAgentConversations();
      if (!isCurrentClient() || generation !== listRequest.current) return;
      for (const item of result.conversations) acceptConversation(item);
      const returnedIds = new Set(result.conversations.map(item => item.conversationId));
      const keep = Object.fromEntries(Object.entries(snapshotsRef.current).filter(([id, item]) => returnedIds.has(id) || id === resultTargetRef.current?.conversationId || hasActiveTask(item) || queuedCount(item) ||
        shelfRef.current.drafts.some(draft => (draft.conversationId ?? draft.request.requestId) === id)));
      if (Object.keys(keep).length !== Object.keys(snapshotsRef.current).length) { snapshotsRef.current = keep; setSnapshots(keep); }
      setListError(current => current.startsWith("The draft list is full") ? current : "");
    } catch { if (isCurrentClient() && generation === listRequest.current) setListError("WTS could not refresh the task list. Your drafts remain available."); }
    finally { if (isCurrentClient() && generation === listRequest.current) setListPending(false); }
  }, [acceptConversation, client, isCurrentClient]);
  useEffect(() => {
    void cleanupFeedbackCaptures().catch(() => undefined);
    mounted.current = true; operationsRef.current = {}; setOperations({}); snapshotsRef.current = {}; setSnapshots({}); setListError(""); setSelectionPending(false);
    return () => { mounted.current = false; ++selectionGeneration.current; ++listRequest.current; };
  }, [client]);
  useEffect(() => {
    for (const item of shelfRef.current.drafts) {
      if (!item.captureId && !(item.request.source.kind === "ui" && item.request.source.capture)) continue;
      updateOperation(item.id, { capturePending: true });
      void hydrateFeedbackCapture(item).then(persistFeedbackCapture).then(restored => {
        if (!isCurrentClient()) return;
        const current = shelfRef.current.drafts.find(draft => draft.id === item.id);
        if (current && !current.conversationId) updateDraft(item.id, { captureId: restored.captureId, captureNote: restored.captureNote, request: { ...current.request, source: restored.request.source } });
      }).finally(() => { if (isCurrentClient()) updateOperation(item.id, { capturePending: false }); });
    }
  }, [isCurrentClient, updateDraft, updateOperation]);
  useEffect(() => {
    let pending = false; let lastRead = 0;
    const poll = async (force = false) => {
      if (pending || document.visibilityState === "hidden") return;
      const active = Object.values(snapshotsRef.current).some(item => hasActiveTask(item) || queuedCount(item)) || shelfRef.current.drafts.some(item => item.attempt);
      if (!force && Date.now() - lastRead < (active ? 2_000 : 15_000)) return;
      pending = true; lastRead = Date.now();
      try { await refreshList();
        for (const item of shelfRef.current.drafts) if (!operationsRef.current[item.id]?.busy && (item.attempt || (item.conversationId && !snapshotsRef.current[item.conversationId]))) await refreshTask(item.id);
      } finally { pending = false; }
    };
    void poll(true);
    const interval = window.setInterval(() => void poll(), 2_000);
    const visible = () => { if (document.visibilityState === "visible") void poll(true); };
    document.addEventListener("visibilitychange", visible);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [refreshList, refreshTask]);
  const addDraft = useCallback((next: AgentFeedbackDraft) => {
    const current = shelfRef.current;
    let drafts = current.drafts;
    if (drafts.length >= MAX_FEEDBACK_DRAFTS) {
      const clean = drafts.find(item => item.conversationId && !item.body && !item.attempt && !Object.keys(item.queuedEdits ?? {}).length && !operationsRef.current[item.id]?.busy);
      if (!clean) { if (next.captureId) void discardUnstoredFeedbackCapture(next.captureId); setListError("The draft list is full. Send or discard an existing draft before you select another region."); return; }
      drafts = drafts.filter(item => item.id !== clean.id);
    }
    updateShelf({ version: 2, open: true, selectedId: next.id, drafts: [...drafts, next] });
  }, [updateShelf]);
  useEffect(() => {
    const select = async ({ detail }: CustomEvent<UiRegionSelection>) => {
      clearResultNavigation();
      const generation = ++selectionGeneration.current; rememberFocus(); setSelectionPending(true);
      const route = window.location.href;
      let capture; let captureNote = "WTS included the selected text and controls. An image is unavailable in this view.";
      if (detail.captureAllowed === true && client.captureUiRegion && canCaptureUiRegion(detail.rect)) {
        try { capture = await client.captureUiRegion({ rect: detail.rect, viewport: detail.viewport }); captureNote = ""; }
        catch { captureNote = "WTS could not capture an image. You can send the selected text and controls."; }
      }
      if (!isCurrentClient() || generation !== selectionGeneration.current) return;
      if (capture && (route !== window.location.href || !canCaptureUiRegion(detail.rect))) { capture = undefined; captureNote = "The region changed during capture. WTS included only the selected text and controls."; }
      const source: AgentConversationSource = { kind: "ui", route: detail.route, calloutId: detail.id, label: detail.label,
        ...(detail.visibleText.trim() ? { selectedText: detail.visibleText } : {}), context: JSON.stringify({ rect: detail.rect, viewport: detail.viewport, ancestors: detail.ancestors, controls: detail.controls, capturedAtUnixMs: detail.capturedAtUnixMs }), ...(capture ? { capture } : {}) };
      const fresh = newFeedbackDraft(source, "", captureNote);
      const next = capture ? await persistFeedbackCapture(fresh) : fresh;
      if (!isCurrentClient() || generation !== selectionGeneration.current) { if (next.captureId) void discardUnstoredFeedbackCapture(next.captureId); return; }
      setSelectionPending(false); addDraft(next);
    };
    const review = ({ detail }: CustomEvent<GitlabDiscussionFixContext>) => {
      clearResultNavigation();
      ++selectionGeneration.current; setSelectionPending(false); rememberFocus();
      addDraft(newFeedbackDraft(mrSource(detail), "Address this review feedback in the local source. Run the relevant checks and explain the changes."));
    };
    const task = ({ detail }: CustomEvent<AgentTaskRequest>) => {
      clearResultNavigation();
      ++selectionGeneration.current; setSelectionPending(false); rememberFocus();
      addDraft(newFeedbackDraft({ kind: "ui", route: window.location.href, calloutId: detail.calloutId, label: detail.label,
        ...(detail.selectedText?.trim() ? { selectedText: detail.selectedText } : {}) }, detail.body));
    };
    window.addEventListener(UI_REGION_SELECTED_EVENT, select); window.addEventListener(AGENT_FEEDBACK_REQUESTED_EVENT, review); window.addEventListener(AGENT_TASK_REQUESTED_EVENT, task);
    return () => { ++selectionGeneration.current; window.removeEventListener(UI_REGION_SELECTED_EVENT, select); window.removeEventListener(AGENT_FEEDBACK_REQUESTED_EVENT, review); window.removeEventListener(AGENT_TASK_REQUESTED_EVENT, task); };
  }, [client, isCurrentClient, addDraft, clearResultNavigation]);
  useEffect(() => {
    if (!shelf.open) {
      focusedSelectionRef.current = undefined;
      if (restoreFocus.current) { restoreFocus.current = false; (returnFocus.current?.isConnected ? returnFocus.current : launcherRef.current)?.focus(); }
      return;
    }
    if (resultTargetRef.current || !draft || (draft.conversationId && !conversation)) return;
    const selectionKey = `${clientVersion}:${draft.id}`;
    if (focusedSelectionRef.current === selectionKey) return;
    focusedSelectionRef.current = selectionKey;
    if (failedTurn) resultSummaryRef.current?.focus();
    else inputRef.current?.focus();
  }, [shelf.open, draft?.id, Boolean(conversation), failedTurn?.messageId, clientVersion]);
  const send = async (id: string) => {
    let current = shelfRef.current.drafts.find(item => item.id === id);
    if (!current || operationsRef.current[id]?.busy || operationsRef.current[id]?.capturePending || (!current.attempt && !current.body.trim())) return;
    if (!client.createAgentConversation || !client.sendAgentConversationMessage) { updateOperation(id, { error: { text: "This WTS connection does not support agent chat. Update WTS, then select Retry send.", retry: "send" } }); return; }
    if (!current.conversationId && current.captureId && current.request.source.kind === "ui" && !current.request.source.capture) { updateOperation(id, { error: { text: "WTS cannot read this request image. Select Refresh task to find the saved conversation. Other drafts remain available.", retry: "refresh" } }); return; }
    followLatestRef.current = !current.retryOrigin;
    const attempt = current.attempt ?? { requestId: crypto.randomUUID(), body: current.body };
    if (!updateDraft(id, { attempt })) { updateOperation(id, { error: storageBeforeSend }); return; }
    updateOperation(id, { busy: true, error: undefined, rejectedRequestId: undefined });
    try {
      current = shelfRef.current.drafts.find(item => item.id === id)!;
      let conversationId = current.conversationId;
      if (!conversationId) {
        const created = await client.createAgentConversation(current.request);
        if (!isCurrentClient()) return;
        conversationId = created.conversationId;
        if (!acceptConversation(created, id)) { updateOperation(id, { error: storageBeforeSend }); return; }
        if (!shelfRef.current.drafts.find(item => item.id === id)?.attempt) return;
      }
      const result = await client.sendAgentConversationMessage(conversationId, attempt);
      if (isCurrentClient()) acceptConversation(result, id);
    } catch (cause) {
      if (isCurrentClient()) {
        const error: ChatError = cause instanceof WorkspaceClientError ? { text: cause.code === "agent_conversation_busy"
          ? "This WTS host cannot queue this request yet. Update WTS, then select Retry send. Other drafts remain available."
          : cause.message, retry: "send", settings: cause.code.startsWith("agent_provider_") || cause.code === "agent_cli_unavailable" } : uncertainSend;
        updateOperation(id, { error, rejectedRequestId: cause instanceof WorkspaceClientError && rejectedBeforeExecution.has(cause.code) ? attempt.requestId : undefined });
      }
    } finally { if (isCurrentClient()) updateOperation(id, { busy: false }); }
  };
  const selectTask = (item: AgentFeedbackDraft | AgentConversation) => {
    clearResultNavigation();
    ++selectionGeneration.current; setSelectionPending(false);
    if ("request" in item) updateShelf({ ...shelfRef.current, open: true, selectedId: item.id });
    else {
      const existing = shelfRef.current.drafts.find(draft => draft.conversationId === item.conversationId && !draft.retryOrigin);
      if (existing) updateShelf({ ...shelfRef.current, open: true, selectedId: existing.id });
      else { const next = newFeedbackDraft(withoutImage(item.source)); addDraft({ ...next, conversationId: item.conversationId, request: { ...next.request, provider: item.provider } }); }
    }
  };
  const storeInternalDraft = (item: AgentConversation, retryOrigin?: AgentFeedbackDraft["retryOrigin"]) => {
    const current = shelfRef.current;
    let drafts = current.drafts;
    if (drafts.length >= MAX_FEEDBACK_DRAFTS) {
      const clean = drafts.find(value => value.id !== current.selectedId && value.conversationId && !value.body && !value.attempt && !Object.keys(value.queuedEdits ?? {}).length && !operationsRef.current[value.id]?.busy);
      if (!clean) { setListError("The draft list is full. Send or discard an existing draft before you add a request."); return undefined; }
      drafts = drafts.filter(value => value.id !== clean.id);
    }
    const next = { ...newFeedbackDraft(withoutImage(item.source)), conversationId: item.conversationId, retryOrigin };
    next.request.provider = item.provider;
    return updateShelf({ ...current, drafts: [...drafts, next] }) ? next : undefined;
  };
  const draftForConversation = (item: AgentConversation, messageId?: string) => shelfRef.current.drafts.find(value => value.conversationId === item.conversationId && messageId && value.queuedEdits?.[messageId])
    ?? shelfRef.current.drafts.find(value => value.conversationId === item.conversationId && !value.retryOrigin)
;
  const closeSavedDrafts = () => {
    const menu = savedDraftsRef.current;
    if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
  };
  const selectSavedDraft = (item: AgentFeedbackDraft | AgentConversation) => { closeSavedDrafts(); selectTask(item); };
  useEffect(() => {
    const messageId = queuedFocusRef.current;
    if (!messageId) return;
    const input = queuedInputRefs.current.get(messageId);
    if (input) { input.focus(); queuedFocusRef.current = null; }
  }, [shelf]);
  const editQueued = (item: AgentConversation, message: AgentConversationMessage) => {
    const target = draftForConversation(item, message.messageId) ?? storeInternalDraft(item); if (!target) return;
    queuedFocusRef.current = message.messageId;
    updateDraft(target.id, { queuedEdits: { ...target.queuedEdits, [message.messageId]: { body: message.body, expectedBody: message.body } } });
  };
  const mutateQueued = async (id: string, messageId: string, action: "update" | "cancel") => {
    const current = shelfRef.current.drafts.find(item => item.id === id); if (!current?.conversationId || operationsRef.current[id]?.busy) return;
    const message = snapshotsRef.current[current.conversationId]?.messages.find(item => item.messageId === messageId); if (!message) return;
    if (!client.updateAgentConversationMessage || !client.cancelAgentConversationMessage) { updateOperation(id, { error: { text: "This WTS host cannot change queued requests. Update WTS, then refresh this task.", retry: "refresh" } }); return; }
    const edit: QueuedFeedbackEdit = current.queuedEdits?.[messageId] ?? { body: message.body, expectedBody: message.body };
    const mutation = edit.mutation ?? { requestId: crypto.randomUUID(), action, ...(action === "update" ? { body: edit.body } : {}) };
    if (mutation.action === "update" && !mutation.body?.trim()) return;
    if (!updateDraft(id, { queuedEdits: { ...current.queuedEdits, [messageId]: { ...edit, mutation } } })) { updateOperation(id, { error: { text: "WTS could not save the queued edit. Free local storage before you retry.", retry: "mutation", messageId } }); return; }
    updateOperation(id, { busy: true, error: undefined });
    try {
      const result = mutation.action === "update"
        ? await client.updateAgentConversationMessage(current.conversationId, messageId, { requestId: mutation.requestId, expectedBody: edit.expectedBody, body: mutation.body! })
        : await client.cancelAgentConversationMessage(current.conversationId, messageId, { requestId: mutation.requestId, expectedBody: edit.expectedBody });
      if (isCurrentClient()) acceptConversation(result, id);
    } catch (cause) {
      if (isCurrentClient()) {
        const definitive = cause instanceof WorkspaceClientError && (rejectedBeforeExecution.has(cause.code) || cause.code === "agent_conversation_message_started");
        if (definitive) {
          const latest = shelfRef.current.drafts.find(item => item.id === id)!;
          updateDraft(id, { queuedEdits: { ...latest.queuedEdits, [messageId]: { ...edit, mutation: undefined } } });
        }
        updateOperation(id, { error: { text: cause instanceof WorkspaceClientError ? `${cause.message} WTS kept your edit.` : "WTS could not confirm this change. Retry the same queued change to check its result.", retry: definitive ? "refresh" : "mutation", messageId } });
      }
    } finally { if (isCurrentClient()) updateOperation(id, { busy: false }); }
  };
  const close = () => { clearResultNavigation(); ++selectionGeneration.current; setSelectionPending(false); restoreFocus.current = true; updateShelf({ ...shelfRef.current, open: false }); };
  const discardDraft = (item: AgentFeedbackDraft) => {
    if (operationsRef.current[item.id]?.busy || (item.attempt && operationsRef.current[item.id]?.rejectedRequestId !== item.attempt.requestId)) return;
    if (item.conversationId) updateDraft(item.id, { body: "", attempt: undefined });
    else {
      const drafts = shelfRef.current.drafts.filter(draft => draft.id !== item.id);
      updateShelf({ ...shelfRef.current, drafts, selectedId: drafts.at(-1)?.id });
    }
    updateOperation(item.id, { error: undefined, rejectedRequestId: undefined });
    if (listError.startsWith("The draft list is full")) setListError("");
  };
  const allConversations = Object.values(snapshots);
  const activeCount = allConversations.filter(hasActiveTask).length;
  const waitingCount = allConversations.reduce((count, item) => count + queuedCount(item), 0);
  const source = conversation?.source ?? draft?.request.source;
  const targetActive = allConversations.some(item => hasActiveTask(item) && (conversation ? item.workspaceId === conversation.workspaceId : source?.kind === "gitlabDiscussion" ? item.workspaceId === source.workspaceId : source?.kind === "ui" && item.source.kind === "ui"));
  const { timeline, queued } = buildFeedbackTimeline(allConversations);
  useLayoutEffect(() => {
    if (!shelf.open || resultNavigation?.pending) return;
    const element = resultFocusRef.current ? resultElements.current.get(resultFocusRef.current) : undefined;
    if (element) {
      resultFocusRef.current = undefined;
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "nearest" });
    } else if (resultNavigation?.error) resultErrorRef.current?.focus();
  }, [shelf.open, resultNavigation]);
  useLayoutEffect(() => {
    if (!shelf.open || !followLatestRef.current) return;
    const content = contentRef.current; const chat = chatRef.current;
    if (content && getComputedStyle(content).overflowY !== "visible") content.scrollTop = content.scrollHeight;
    else if (chat) chat.scrollTop = chat.scrollHeight;
  }, [snapshots, shelf.open, operations]);
  const rememberScroll = (element: HTMLDivElement) => {
    if (element.scrollHeight > element.clientHeight) followLatestRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  };
  const savedDrafts = shelf.drafts.filter(item => item.id !== shelf.selectedId && !item.retryOrigin && (item.body || !item.conversationId || !snapshots[item.conversationId]?.messages.length));
  const emptyContexts = allConversations.filter(item => !item.messages.length && !shelf.drafts.some(draft => draft.conversationId === item.conversationId && !draft.retryOrigin));
  useEffect(() => {
    if (!shelf.open || resultTargetRef.current || draft || !allConversations.length) return;
    const latest = allConversations.slice().sort((left, right) => right.updatedAtUnixMs - left.updatedAtUnixMs)[0]!;
    const existing = shelfRef.current.drafts.find(item => item.conversationId === latest.conversationId && !item.retryOrigin);
    if (existing) updateShelf({ ...shelfRef.current, selectedId: existing.id });
    else { const next = newFeedbackDraft(withoutImage(latest.source)); addDraft({ ...next, conversationId: latest.conversationId, request: { ...next.request, provider: latest.provider } }); }
  }, [shelf.open, draft?.id, snapshots, addDraft, updateShelf]);
  const localChangesLink = (item: AgentConversation) => <a href={`/sessions/${encodeURIComponent(item.workspaceId)}/changes?repository=${encodeURIComponent(item.repositoryId)}`}
    onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId: item.workspaceId, repositoryId: item.repositoryId } })); }}>View local changes</a>;
  const continueFromSavedWork = (item: AgentConversation, failed: AgentConversationMessage, request?: AgentConversationMessage) => {
    const current = snapshotsRef.current[item.conversationId]; if (!current) return;
    followLatestRef.current = false;
    if (current.messages.some(message => message.role === "user" && message.requestId === failed.messageId)) return;
    const existing = shelfRef.current.drafts.find(value => value.retryOrigin?.conversationId === item.conversationId && value.retryOrigin.messageId === failed.messageId);
    if (existing && operationsRef.current[existing.id]?.busy) return;
    if (existing?.attempt) { void send(existing.id); return; }
    const instruction = "Inspect the existing changes before you edit. Preserve the saved work. Complete the remaining work. Run the remaining checks. Explain the result and any failed checks.";
    const taskContext = request && [...request.body].length <= 8_000 ? request.body : request ? `Read the full user request with ID ${request.requestId ?? request.messageId} in the conversation history.` : "";
    const body = `Continue this task from its saved local work:${taskContext ? `\n\n${taskContext}` : ""}\n\n${instruction}`;
    const target = existing ?? storeInternalDraft(item, { conversationId: item.conversationId, messageId: failed.messageId, requestId: failed.messageId });
    if (target && updateDraft(target.id, { attempt: { requestId: failed.messageId, body } })) void send(target.id);
  };
  const visibleErrorFor = (item: AgentFeedbackDraft): ChatError | undefined => {
    const state = operations[item.id] ?? {}; const mutation = Object.entries(item.queuedEdits ?? {}).find(([, edit]) => edit.mutation);
    return state.error ?? (!state.busy && item.attempt ? uncertainSend : !state.busy && mutation ? { text: "WTS did not confirm this queued change. Retry the same change to check its result.", retry: "mutation", messageId: mutation[0] } : undefined);
  };
  const errorRows = shelf.drafts.flatMap(item => { const error = visibleErrorFor(item); return error ? [{ item, error }] : []; });
  const canDiscardCurrentDraft = draft && !visibleErrorFor(draft) && !draft.attempt && !operation.busy && (!draft.conversationId || draft.body.trim());
  const queueRows = [...queued, ...timeline.filter(row => row.message.role === "user" && row.message.status !== "queued" && shelf.drafts.some(item => item.conversationId === row.conversation.conversationId && item.queuedEdits?.[row.message.messageId]))];
  const renderContext = (context: AgentConversationSource) => context.kind === "ui" ? <>{context.capture && <img src={context.capture.dataUrl} alt={`Selected region: ${context.label}`} />}<p>{context.selectedText || context.label}</p><code>{context.calloutId}</code></> : context.kind === "workItem" ? <p>{context.label}</p> : context.comments.map(comment => <blockquote key={comment.id}><strong>@{comment.authorLogin}</strong><GitlabDiscussionBody body={comment.body} className={styles.body} /></blockquote>);
  const statusLabel = (message: AgentConversationMessage) => message.status === "queued" ? `Queued${message.queuePosition ? ` · ${message.queuePosition} in workspace queue` : ""}` : message.status === "running" ? "Active" : message.status === "pending" ? "Request accepted" : message.status === "cancelled" ? "Cancelled" : message.status === "interrupted" ? "Stopped" : message.status === "failed" ? "Failed" : "Completed";
  return <div ref={rootRef} className={styles.root} data-ui-context="exclude">
    {!shelf.open && <Button ref={launcherRef} className={styles.launcher} onPress={() => { rememberFocus(); updateShelf({ ...shelfRef.current, open: true }); }} aria-label="Open agent feedback">
      {selectionPending ? "WTS captures the region…" : "Agent feedback"}{!!(activeCount + waitingCount) && ` · ${activeCount} active · ${waitingCount} queued`}
    </Button>}
    {shelf.open && <section role="dialog" aria-label="Agent feedback" className={styles.bubble} data-ui="agent.feedback" data-ui-label="Agent feedback chat"
      onClickCapture={event => { if (event.detail > 1 && event.target instanceof Element && event.target.closest("button, a, [role=button], [role=menuitem]")) { event.preventDefault(); event.stopPropagation(); } }}
      onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <header className={styles.header}><div><strong>Agent feedback</strong>{!!(activeCount + waitingCount) && <span>{activeCount} active · {waitingCount} queued</span>}</div>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger aria-label="Feedback options" title="Feedback options">⋯</DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className={styles.optionsMenu} align="end" sideOffset={6} onEscapeKeyDown={event => event.stopPropagation()}>
            <DropdownMenu.Item className={styles.option} onSelect={() => void refreshList()}>Refresh tasks</DropdownMenu.Item>
            {canDiscardCurrentDraft && <DropdownMenu.Item className={styles.option} onSelect={() => discardDraft(draft)}>Discard current draft</DropdownMenu.Item>}
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
        <Button onPress={close} aria-label="Close agent feedback">×</Button></header>
      {listError && <div role="alert" className={styles.error}>{listError}<Button onPress={() => void refreshList()}>Retry task list</Button></div>}
      <div ref={chatRef} className={styles.chat} onScroll={event => { if (event.target === event.currentTarget) rememberScroll(event.currentTarget); }}>
        <div ref={contentRef} className={styles.content} onScroll={event => { if (event.target === event.currentTarget) rememberScroll(event.currentTarget); }}>
          {resultNavigation?.pending && <p role="status">WTS opens the saved result…</p>}
          {resultNavigation?.error && <div ref={resultErrorRef} role="alert" tabIndex={-1} className={styles.error}>{resultNavigation.error}{client.getAgentConversation && <Button onPress={() => void openResult(resultNavigation.target)}>Retry result</Button>}</div>}
          {selectionPending && <p role="status">WTS captures the selected region…</p>}
          {listPending && !timeline.length && <p role="status">WTS reads saved messages…</p>}
          {!timeline.length && <p className={styles.intro}>Describe the change. Hold Option and select a region to include its context.</p>}
          <div role="log" aria-label="Agent messages" aria-live="polite" aria-relevant="additions text">
            {timeline.map(({ key, conversation: item, message, request }) => {
              const isFailure = message.role === "assistant" && ["failed", "interrupted"].includes(message.status);
              const retry = shelf.drafts.find(value => value.retryOrigin?.conversationId === item.conversationId && value.retryOrigin.messageId === message.messageId);
              const retried = item.messages.find(value => value.role === "user" && value.requestId === (retry?.retryOrigin?.requestId ?? message.messageId));
              return <article key={key} className={styles.message} data-role={message.role} ref={element => { if (element) resultElements.current.set(key, element); else resultElements.current.delete(key); if (message.messageId === failedTurn?.messageId && item.conversationId === conversation?.conversationId) resultSummaryRef.current = element; }} tabIndex={message.role === "assistant" ? -1 : undefined}>
                <div className={styles.messageHeading}><strong>{message.role === "user" ? "You" : message.role === "assistant" ? providerLabel(item.provider) : "WTS"}</strong>{message.role !== "user" && <span>{statusLabel(message)}</span>}</div>
                {message.role === "user" && <div className={styles.contextChips}><Button className={styles.sourceChip} onPress={() => selectTask(item)}>{sourceLabel(item.source)} · {statusLabel(message)}</Button>
                  <details className={styles.context}><summary>Context</summary>{renderContext(item.source)}</details></div>}
                {message.role === "user" && ["pending", "running"].includes(message.status) && <div className={styles.actions}>{localChangesLink(item)}{item.activeSessionId && <Button onPress={() => { void client.stopAgentSession(item.activeSessionId!).then(() => { if (isCurrentClient()) return refreshList(); }).catch(() => { const target = draftForConversation(item) ?? storeInternalDraft(item); if (isCurrentClient() && target) updateOperation(target.id, { error: { text: "WTS could not stop this task. Refresh the task to check its state.", retry: "refresh" } }); }); }}>Stop current task</Button>}</div>}
                {message.error && <p className={styles.messageError}>{isFailure && genericFailure(message.error) ? "The agent stopped before it finished." : message.error}</p>}
                {isFailure ? <>
                  {(message.progress || message.body || message.diagnostic || (message.error && genericFailure(message.error))) && <details className={styles.outputDetails}>
                    <summary>Details</summary>
                    {message.error && genericFailure(message.error) && <p>{message.error}</p>}
                    {message.progress && <><strong>Progress</strong><GitlabDiscussionBody body={message.progress} className={styles.body} /></>}
                    {message.body && <><strong>Unverified provider output</strong><GitlabDiscussionBody body={message.body} className={styles.body} /></>}
                    {message.diagnostic && <><strong>Provider diagnostics</strong><pre>{message.diagnostic}</pre></>}
                  </details>}
                </> : <>
                  {message.progress && <details className={styles.outputDetails}><summary>Progress</summary><GitlabDiscussionBody body={message.progress} className={styles.body} /></details>}
                  {message.body && (message.role === "assistant" && message.status !== "completed" ? <details className={styles.outputDetails}><summary>Provider output</summary><GitlabDiscussionBody body={message.body} className={styles.body} /></details> : <GitlabDiscussionBody body={message.body} className={styles.body} />)}
                  {message.diagnostic && <details className={styles.outputDetails}><summary>Provider diagnostics</summary><pre>{message.diagnostic}</pre></details>}
                </>}
                {message.role === "assistant" && ["completed", "failed", "interrupted"].includes(message.status) && <div className={styles.actions}>
                  {request?.requestId && <AgentResultReview onCloseFeedback={close} client={client} conversation={item} requestId={request.requestId} sessionId={message.sessionId ?? request.sessionId} onReturnToSelection={() => { close(); returnToFeedbackSelection(item.source); }} />}
                  {!request?.requestId && localChangesLink(item)}
                  {isFailure && <><Button className={styles.retryAction} isDisabled={!!retried || !!retry?.attempt} onPress={() => continueFromSavedWork(item, message, request)}>{retried ? "Sent" : retry?.attempt ? "Send pending" : "Retry"}</Button>{retried && <span className={styles.muted}>Continuation {statusLabel(retried).toLowerCase()}</span>}</>}
                </div>}
              </article>;
            })}
          </div>
        {storageError && <p role="alert" className={styles.error}>WTS could not save all drafts on this device. Keep this window open. Free local storage before you send.</p>}
        {errorRows.map(({ item, error }) => <div role="alert" key={item.id} className={styles.error}><strong>{sourceLabel(item.request.source)}</strong> {error.text}<div className={styles.actions}>
          {error.retry && <Button isDisabled={operations[item.id]?.busy} onPress={() => error.retry === "send" ? void send(item.id) : error.retry === "mutation" && error.messageId ? void mutateQueued(item.id, error.messageId, item.queuedEdits?.[error.messageId]?.mutation?.action ?? "update") : void refreshTask(item.id)}>{error.retry === "send" ? "Retry send" : error.retry === "mutation" ? "Retry queued change" : "Refresh task"}</Button>}
          {error.settings && <Button onPress={() => window.dispatchEvent(new CustomEvent("wts:open-agent-settings"))}>Open Settings</Button>}
          {(!item.attempt || operations[item.id]?.rejectedRequestId === item.attempt.requestId) && !operations[item.id]?.busy && <Button onPress={() => discardDraft(item)}>Discard draft</Button>}
        </div></div>)}
        </div>
        {!!queueRows.length && <section role="region" aria-label="Queued requests" className={styles.queue}>
          <strong>{queued.length} queued</strong>
          {queueRows.map(({ key, conversation: item, message }) => {
            const target = draftForConversation(item, message.messageId); const edit = target?.queuedEdits?.[message.messageId]; const busy = target ? operations[target.id]?.busy : false;
            return <div key={key} className={styles.queueRow}><div className={styles.queueSummary}><Button className={styles.sourceChip} onPress={() => selectTask(item)}>{sourceLabel(item.source)} · {statusLabel(message)}</Button><p>{message.body}</p></div>
              {!edit && <div className={styles.actions}><Button aria-label="Edit queued request" onPress={() => editQueued(item, message)} isDisabled={busy}>Edit</Button><Button aria-label="Cancel request" isDisabled={busy} onPress={() => { const owner = target ?? storeInternalDraft(item); if (owner) void mutateQueued(owner.id, message.messageId, "cancel"); }}>Cancel</Button></div>}
              {edit && target && <div className={styles.queuedEdit}><label htmlFor={`queued-${message.messageId}`}>Queued request</label><textarea ref={input => { if (input) queuedInputRefs.current.set(message.messageId, input); else queuedInputRefs.current.delete(message.messageId); }} id={`queued-${message.messageId}`} value={edit.body} disabled={busy || !!edit.mutation} onChange={event => updateDraft(target.id, { queuedEdits: { ...target.queuedEdits, [message.messageId]: { ...edit, body: [...event.target.value].slice(0, 16_384).join("") } } })} />
                <div className={styles.actions}>{message.status === "queued" && !edit.mutation && <Button isDisabled={busy || !edit.body.trim()} onPress={() => void mutateQueued(target.id, message.messageId, "update")}>Save queued edit</Button>}
                  {!edit.mutation && <Button isDisabled={busy} onPress={() => { const body = [target.body, edit.body].filter(Boolean).join("\n\n"); if ([...body].length > 16_384) { updateOperation(target.id, { error: { text: "The combined message exceeds 16,384 characters. Shorten either text before you use it as a follow-up. WTS kept both drafts." } }); return; } const edits = { ...target.queuedEdits }; delete edits[message.messageId]; updateDraft(target.id, { queuedEdits: edits, body }); selectTask(target); updateOperation(target.id, { error: undefined }); }}>Use as follow-up</Button>}
                  {!edit.mutation && <Button isDisabled={busy} onPress={() => { const edits = { ...target.queuedEdits }; delete edits[message.messageId]; updateDraft(target.id, { queuedEdits: edits }); }}>Discard queued edit</Button>}</div></div>}
            </div>;
          })}
        </section>}
        {draft && <footer className={styles.footer}>
          <div className={styles.composerContext}><details className={styles.context}><summary title={source ? sourceLabel(source) : undefined}>{source ? sourceLabel(source) : "Selected context"}</summary>{source && renderContext(source)}{draft.captureNote && <p>{draft.captureNote}</p>}</details>
            {!!(savedDrafts.length + emptyContexts.length) && <details ref={savedDraftsRef} className={styles.savedDrafts} onKeyDown={event => { if (event.key === "Escape" && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); closeSavedDrafts(); } }}><summary>Saved drafts ({savedDrafts.length + emptyContexts.length})</summary><div role="group" aria-label="Saved drafts">{savedDrafts.map(item => <Button key={item.id} onPress={() => selectSavedDraft(item)}>{sourceLabel(item.request.source)}<span>{item.body || "New request"}</span><small>Draft</small></Button>)}{emptyContexts.map(item => <Button key={item.conversationId} onPress={() => selectSavedDraft(item)}>{sourceLabel(item.source)}<span>New request</span></Button>)}</div></details>}
          </div>

          {!!waitingCount && <small>Queued requests start in order. Stop current task does not cancel them.</small>}
          <label className={styles.srOnly} htmlFor="agent-feedback-message">Message to agent</label><textarea ref={inputRef} id="agent-feedback-message" placeholder="What needs to change?" value={draft.body} disabled={operation.busy || !!draft.attempt} onChange={event => updateDraft(draft.id, { body: [...event.target.value].slice(0, 16_384).join("") })} onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(draft.id); } }} />
          <div className={styles.actions}>{draft.conversationId ? <span className={styles.provider}>{providerLabel(conversation?.provider ?? draft.request.provider)}</span> : <SelectMenu aria-label="Feedback agent" value={draft.request.provider} disabled={operation.busy || !!draft.attempt} onChange={provider => updateDraft(draft.id, { request: { ...draft.request, provider: provider as AgentProvider } })}><option value="codex">Codex</option><option value="openCode">OpenCode</option><option value="hermes">Hermes</option><option value="copilot">Copilot</option></SelectMenu>}<Button className={styles.send} isDisabled={operation.busy || operation.capturePending || !!draft.attempt || !draft.body.trim()} onPress={() => void send(draft.id)}>{targetActive ? "Queue request" : "Send to agent"}</Button></div>
          <small>Changes stay local.</small>
        </footer>}
      </div>
    </section>}
  </div>;
}
