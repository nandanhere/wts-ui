import { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import type { AgentConversation } from "../lib/agentConversations";
import type { AgentTurnChanges } from "../lib/agentTurnChanges";
import { matchCreatedAgentWorkSet, validateCreateAgentWorkSet, type AgentWorkItem, type AgentWorkItemPlan, type AgentWorkSet, type AgentWorkItemPreview } from "../lib/agentWorkSets";
import { newWorkItemDraft, newWorkSetDraft, readWorkSetDraft, saveWorkSetDraft, type AgentWorkSetDraft, type PendingWorkItemCancel } from "../lib/agentWorkSetDraft";
import { returnToFeedbackSelection } from "../lib/agentFeedbackNavigation";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
import { AgentWorkItemIntegration } from "./AgentWorkItemIntegration";
import styles from "./AgentResultReview.module.css";
const AgentResultReview = lazy(() => import("./AgentResultReview").then(module => ({ default: module.AgentResultReview })));
const terminal = new Set(["completed", "failed", "blocked", "cancelled"]);
const states = { pending: "Pending", preparing: "Creates workspace", queued: "Queued", running: "Active", completed: "Completed", failed: "Failed", blocked: "Blocked", cancelled: "Cancelled" };
type CalloutScope = { id: string; label: string };
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : "WTS could not complete this task request. Refresh the plans before you retry."; }
function initialDraft(key: string) { try { return { draft: readWorkSetDraft(key), error: "" }; } catch (cause) { return { draft: newWorkSetDraft(key), error: errorText(cause) }; } }
function matches(set: AgentWorkSet, receipt: AgentTurnChanges) { return set.conversationId === receipt.conversationId && set.requestId === receipt.requestId && set.workspaceId === receipt.workspaceId && set.repositoryId === receipt.repositoryId && set.sourceCheckpointId === receipt.after?.checkpointId && set.sourceContextSha256 === receipt.sourceContextSha256; }
export function AgentResultWorkSets({ client, receipt, calloutScope, onLeaveReview }: { client: WorkspaceClient; receipt: AgentTurnChanges; calloutScope?: CalloutScope; onLeaveReview: () => void }) {
  const host = useRef({ client, version: 0 }); if (host.current.client !== client) host.current = { client, version: host.current.version + 1 };
  const key = JSON.stringify([receipt.conversationId, receipt.requestId, receipt.workspaceId, receipt.repositoryId, receipt.sessionId, receipt.after?.checkpointId, receipt.sourceContextSha256]);
  return <WorkSetPanel key={`${key}:${host.current.version}`} client={client} receipt={receipt} draftKey={key} calloutScope={calloutScope} onLeaveReview={onLeaveReview} />;
}
function WorkSetPanel({ client, receipt, draftKey, calloutScope, onLeaveReview }: { client: WorkspaceClient; receipt: AgentTurnChanges; draftKey: string; calloutScope?: CalloutScope; onLeaveReview: () => void }) {
  const initial = useRef(initialDraft(draftKey)); const [draft, setDraft] = useState(initial.current.draft); const draftRef = useRef(draft); draftRef.current = draft;
  const [opened, setOpened] = useState(false); const [sets, setSets] = useState<AgentWorkSet[]>([]); const setsRef = useRef(sets); setsRef.current = sets;
  const [selected, setSelected] = useState(""); const selectedRef = useRef(selected); selectedRef.current = selected;
  const [error, setError] = useState(initial.current.error); const [busy, setBusy] = useState(false); const busyRef = useRef(false); const generation = useRef(0);
  const [cancelErrors, setCancelErrors] = useState<Record<string, string>>({});
  const [child, setChild] = useState<{ set: AgentWorkSet; task: AgentWorkItem; conversation?: AgentConversation; error: string; loading: boolean }>();
  const childGeneration = useRef(0); const groupName = useId();
  const update = (value: AgentWorkSetDraft) => { draftRef.current = value; setDraft(value); };
  const persist = (value: AgentWorkSetDraft) => { saveWorkSetDraft(value); update(value); };
  useEffect(() => () => { generation.current++; childGeneration.current++; }, []);
  const install = useCallback((incoming: AgentWorkSet[]) => {
    if (incoming.some(set => !matches(set, receipt))) throw new Error("The task plan does not match this saved result.");
    const map = new Map(setsRef.current.map(set => [set.workSetId, set])); let changed = false;
    for (const set of incoming) if (!map.has(set.workSetId) || map.get(set.workSetId)!.revision < set.revision) { map.set(set.workSetId, set); changed = true; }
    const merged = [...map.values()]; if (changed) { setsRef.current = merged; setSets(merged); }
    if (!selectedRef.current && merged.length) { selectedRef.current = merged.at(-1)!.workSetId; setSelected(selectedRef.current); }
    const current = draftRef.current; let next = current;
    if (current.pending) {
      const acknowledged = incoming.find(set => set.workSetId === current.pending!.requestId);
      if (acknowledged) { matchCreatedAgentWorkSet(acknowledged, () => { throw new Error("WTS did not confirm the saved task plan."); }, receipt.conversationId, receipt.requestId, current.pending); next = { ...newWorkSetDraft(draftKey), cancellations: current.cancellations }; selectedRef.current = acknowledged.workSetId; setSelected(acknowledged.workSetId); }
    }
    const cancellations = next.cancellations.filter(cancel => { const task = incoming.find(set => set.workSetId === cancel.workSetId)?.tasks.find(task => task.taskId === cancel.taskId); return !task || !terminal.has(task.state); });
    if (cancellations.length !== next.cancellations.length) next = { ...next, cancellations };
    if (next !== current) persist(next);
  }, [receipt, draftKey]);
  const refresh = useCallback(async (setId?: string) => {
    if (busyRef.current || (setId ? !client.getAgentWorkSet : !client.listAgentWorkSets)) return;
    busyRef.current = true; setBusy(true); setError(""); const token = ++generation.current;
    try {
      const incoming = setId ? [await client.getAgentWorkSet!(setId)] : (await client.listAgentWorkSets!(receipt.conversationId, receipt.requestId)).workSets;
      if (token === generation.current) install(incoming);
    } catch (cause) { if (token === generation.current) setError(errorText(cause)); }
    finally { if (token === generation.current) { busyRef.current = false; setBusy(false); } }
  }, [client, receipt.conversationId, receipt.requestId, install]);
  useEffect(() => { if (opened) void refresh(); }, [opened, refresh]);
  const selectedSet = sets.find(set => set.workSetId === selected) ?? sets.at(-1);
  useEffect(() => { if (!opened || !selectedSet?.tasks.some(task => !terminal.has(task.state))) return; const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(selectedSet.workSetId); }, 2000); return () => window.clearInterval(timer); }, [opened, selectedSet, refresh]);
  const edit = (change: Partial<AgentWorkSetDraft>) => { if (draftRef.current.pending) return; const next = { ...draftRef.current, ...change }; update(next); try { saveWorkSetDraft(next); setError(""); } catch (cause) { setError(errorText(cause)); } };
  const editTask = (taskId: string, change: Partial<AgentWorkItemPlan>) => edit({ tasks: draftRef.current.tasks.map(task => task.taskId === taskId ? { ...task, ...change } : task) });
  const start = async () => {
    if (busyRef.current || !client.createAgentWorkSet || !receipt.after) return;
    const current = draftRef.current; const request = current.pending ?? { requestId: crypto.randomUUID(), expectedAfterCheckpointId: receipt.after.checkpointId, kind: current.kind, tasks: current.tasks };
    try { validateCreateAgentWorkSet(request, () => { throw new Error("Check the task titles, prompts, and dependencies before you start."); }); persist({ ...current, pending: request }); } catch (cause) { setError(errorText(cause)); return; }
    busyRef.current = true; setBusy(true); setError(""); const token = ++generation.current;
    try { const result = await client.createAgentWorkSet(receipt.conversationId, receipt.requestId, request); if (token === generation.current) { matchCreatedAgentWorkSet(result, () => { throw new Error("WTS did not confirm the saved task plan."); }, receipt.conversationId, receipt.requestId, request); install([result]); } }
    catch (cause) {
      if (token !== generation.current) return;
      if (cause instanceof WorkspaceClientError && ["invalid_agent_conversation", "agent_conversation_conflict", "agent_conversation_storage_full"].includes(cause.code)) { try { persist({ ...current, pending: undefined }); } catch (storageCause) { setError(errorText(storageCause)); return; } }
      setError(errorText(cause));
    } finally { if (token === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const cancel = async (set: AgentWorkSet, task: AgentWorkItem) => {
    if (busyRef.current || !client.cancelAgentWorkItem) return;
    const current = draftRef.current; const saved = current.cancellations.find(item => item.workSetId === set.workSetId && item.taskId === task.taskId);
    const request: PendingWorkItemCancel = saved ?? { workSetId: set.workSetId, taskId: task.taskId, request: { requestId: crypto.randomUUID(), expectedRevision: set.revision } };
    try { if (!saved) persist({ ...current, cancellations: [...current.cancellations, request] }); else saveWorkSetDraft(current); } catch (cause) { setError(errorText(cause)); return; }
    const key = `${set.workSetId}:${task.taskId}`; setCancelErrors(value => ({ ...value, [key]: "" })); busyRef.current = true; setBusy(true); const token = ++generation.current;
    try {
      const result = await client.cancelAgentWorkItem(set.workSetId, task.taskId, request.request);
      if (token !== generation.current) return;
      if (result.workSetId !== set.workSetId || result.lastMutationRequestId !== request.request.requestId || result.tasks.find(item => item.taskId === task.taskId)?.state !== "cancelled") throw new Error("WTS did not confirm this cancellation. Refresh the plan before you retry.");
      install([result]);
    } catch (cause) {
      if (token !== generation.current) return;
      if (cause instanceof WorkspaceClientError && cause.code === "agent_conversation_conflict") { try { persist({ ...draftRef.current, cancellations: draftRef.current.cancellations.filter(item => item !== request && (item.workSetId !== set.workSetId || item.taskId !== task.taskId)) }); } catch (storageCause) { setError(errorText(storageCause)); return; } }
      setCancelErrors(value => ({ ...value, [key]: errorText(cause) }));
    } finally { if (token === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const readChild = async (set: AgentWorkSet, task: AgentWorkItem) => {
    const token = ++childGeneration.current; setChild({ set, task, loading: true, error: "" });
    if (!client.getAgentConversation) { setChild({ set, task, loading: false, error: "This host cannot read task results. Update WTS to continue." }); return; }
    try {
      const conversation = await client.getAgentConversation(task.conversationId);
      if (token !== childGeneration.current) return;
      const source = conversation.source;
      if (conversation.conversationId !== task.conversationId || !task.workspaceId || conversation.workspaceId !== task.workspaceId || !task.repositoryId || conversation.repositoryId !== task.repositoryId || source.kind !== "workItem" || source.workSetId !== set.workSetId || source.taskId !== task.taskId || source.originConversationId !== receipt.conversationId || source.originRequestId !== receipt.requestId || !conversation.messages.some(message => message.role === "user" && message.requestId === task.requestId)) throw new Error("The candidate result does not match this task.");
      setChild({ set, task, conversation, loading: false, error: "" });
    } catch (cause) { if (token === childGeneration.current) setChild({ set, task, loading: false, error: errorText(cause) }); }
  };
  const valid = (() => { try { validateCreateAgentWorkSet({ requestId: receipt.requestId, expectedAfterCheckpointId: receipt.after?.checkpointId, kind: draft.kind, tasks: draft.tasks }, () => { throw new Error(); }); return true; } catch { return false; } })();
  const dirtyPlan = draft.kind !== "tasks" || draft.tasks.length > 1 || draft.tasks.some(task => task.title || task.prompt || task.dependsOn.length);
  const childScope = child ? { id: `${calloutScope?.id ?? "agent-result"}.work-set.${child.set.workSetId}.${child.task.taskId}`, label: `${calloutScope?.label ?? "Candidate"}: ${child.task.title}` } : undefined;
  return <details className={styles.actionDisclosure} onToggle={event => setOpened(event.currentTarget.open)} data-ui={`${calloutScope?.id ?? "agent-result"}.work-sets`} data-ui-label={`${calloutScope?.label ?? "Task"} plans`}>
    <summary>Tasks and alternatives{sets.length ? ` · ${sets.length} plans` : ""}</summary>
    <section role="region" aria-label="Tasks and alternatives">
      <p>Tasks use separate workspaces. Dependencies add completed task results. Alternatives start from the same saved files.</p>
      {client.listAgentWorkSets ? <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh plans</button> : <p>This WTS host cannot read task plans. Update WTS to use this control.</p>}
      {busy && <p role="status">WTS reads or updates the task plan.</p>}{error && <p role="alert">{error}</p>}
      {draft.pending && <p>WTS kept this plan for an exact retry. Refresh plans to find it. <button type="button" disabled={busy || !client.createAgentWorkSet} onClick={() => void start()}>Retry task plan</button></p>}
      {sets.length > 1 && <label className={styles.decisionReason}>Saved plans<select value={selectedSet?.workSetId} onChange={event => { setSelected(event.currentTarget.value); selectedRef.current = event.currentTarget.value; void refresh(event.currentTarget.value); }}>{sets.map(set => <option key={set.workSetId} value={set.workSetId}>{set.kind === "tasks" ? "Tasks" : "Alternatives"}: {set.tasks[0].title}</option>)}</select></label>}
      {selectedSet && <div className={styles.workSet}>
        <p>{selectedSet.detail}</p>
        <ol className={styles.workItems}>{selectedSet.tasks.map((task, index) => {
          const cancelKey = `${selectedSet.workSetId}:${task.taskId}`; const pendingCancel = draft.cancellations.some(item => item.workSetId === selectedSet.workSetId && item.taskId === task.taskId);
          return <li key={task.taskId}><article aria-label={`Task ${index + 1}: ${task.title}`}><header><strong>{task.title}</strong><span>{states[task.state]}</span></header><p>{task.detail}</p>
            {!!task.dependsOn.length && <p>After: {task.dependsOn.map(id => selectedSet.tasks.find(item => item.taskId === id)?.title ?? id).join(", ")}</p>}
            <details><summary>Task request</summary><p className={styles.savedReason}>{task.prompt}</p></details>
            <div className={styles.actions}>{(!terminal.has(task.state) || pendingCancel) && <button type="button" disabled={busy || !client.cancelAgentWorkItem} onClick={() => void cancel(selectedSet, task)}>{pendingCancel ? "Retry cancellation" : "Cancel task"}</button>}
              {terminal.has(task.state) && task.workspaceId && task.repositoryId && <button type="button" onClick={() => void readChild(selectedSet, task)}>Read task result</button>}
            </div>
            {task.workspaceId && task.repositoryId && <CandidatePreview key={`${selectedSet.workSetId}:${task.taskId}:${task.afterCheckpointId}`} client={client} set={selectedSet} task={task} onLeaveReview={onLeaveReview} />}
            {task.state === "completed" && task.workspaceId && task.repositoryId && task.afterCheckpointId && <AgentWorkItemIntegration client={client} set={selectedSet} task={task} onLeaveReview={onLeaveReview} />}
            {cancelErrors[cancelKey] && <p role="alert">{cancelErrors[cancelKey]}</p>}
          </article></li>;
        })}</ol>
        <button type="button" disabled={!!draft.pending || busy || dirtyPlan} onClick={() => { if (dirtyPlan) return; const ids = new Map(selectedSet.tasks.map(task => [task.taskId, crypto.randomUUID()])); edit({ kind: selectedSet.kind, tasks: selectedSet.tasks.map(task => ({ taskId: ids.get(task.taskId)!, title: task.title, prompt: task.prompt, dependsOn: task.dependsOn.map(id => ids.get(id)!) })) }); }}>Use this plan again</button>{dirtyPlan && <p>Discard the current plan before you use this saved plan again. WTS kept your draft.</p>}
      </div>}
      {child && <div className={styles.childResult} role="region" aria-label={`Result: ${child.task.title}`}>
        <strong>{child.task.title}</strong>{child.loading && <p role="status">WTS reads the candidate result.</p>}{child.error && <p role="alert">{child.error} <button type="button" onClick={() => void readChild(child.set, child.task)}>Retry result</button></p>}
        {child.conversation && <Suspense fallback={<p role="status">WTS opens the candidate review.</p>}><AgentResultReview client={client} conversation={child.conversation} requestId={child.task.requestId} sessionId={child.conversation.messages.find(message => message.role === "assistant" && message.requestId === child.task.requestId)?.sessionId} resultTitle={child.task.title} calloutScope={childScope} onCloseFeedback={onLeaveReview} onReturnToSelection={() => { onLeaveReview(); returnToFeedbackSelection(child.conversation!.source); }} /></Suspense>}
      </div>}
      <fieldset className={styles.decisionChoices} disabled={busy || !!draft.pending || !receipt.after || !client.createAgentWorkSet}>
        <legend>New plan</legend>
        <label><input type="radio" name={groupName} checked={draft.kind === "tasks"} onChange={() => edit({ kind: "tasks" })} />Dependent tasks</label>
        <label><input type="radio" name={groupName} checked={draft.kind === "alternatives"} onChange={() => edit({ kind: "alternatives", tasks: (draft.tasks.length < 2 ? [...draft.tasks, newWorkItemDraft()] : draft.tasks).map(task => ({ ...task, dependsOn: [] })) })} />Alternatives</label>
        {draft.tasks.map((task, index) => <div className={styles.planTask} key={task.taskId}>
          <label className={styles.decisionReason}>Task title {index + 1}<input maxLength={160} value={task.title} onChange={event => editTask(task.taskId, { title: event.currentTarget.value })} /></label>
          <label className={styles.decisionReason}>Task prompt {index + 1}<textarea maxLength={16384} rows={3} value={task.prompt} onChange={event => editTask(task.taskId, { prompt: event.currentTarget.value })} /></label>
          {draft.kind === "tasks" && index > 0 && <fieldset className={styles.dependencies}><legend>Wait for completed tasks</legend>{draft.tasks.slice(0, index).map((other, position) => <label key={other.taskId}><input type="checkbox" checked={task.dependsOn.includes(other.taskId)} onChange={event => editTask(task.taskId, { dependsOn: event.currentTarget.checked ? [...task.dependsOn, other.taskId] : task.dependsOn.filter(id => id !== other.taskId) })} />{other.title || `Task ${position + 1}`}</label>)}</fieldset>}
          {draft.tasks.length > 1 && <button type="button" onClick={() => edit({ tasks: draft.tasks.filter(item => item.taskId !== task.taskId).map(item => ({ ...item, dependsOn: item.dependsOn.filter(id => id !== task.taskId) })) })}>Remove task {index + 1}</button>}
        </div>)}
        <button type="button" disabled={draft.tasks.length >= 8} onClick={() => edit({ tasks: [...draft.tasks, newWorkItemDraft()] })}>Add task</button>
      </fieldset>
      {!receipt.after && <p>This result has no saved files for a new task plan.</p>}
      {!valid && draft.tasks.some(task => task.title || task.prompt) && <p>Complete each title and prompt. Titles allow 160 bytes. Prompts allow 16384 bytes.</p>}
      {sets.length >= 64 && <p>This result reached its limit of 64 task plans. Review the saved plans.</p>}
      <div className={styles.actions}><button type="button" disabled={!valid || busy || !!draft.pending || !client.createAgentWorkSet || sets.length >= 64} onClick={() => void start()}>{draft.kind === "tasks" ? "Start tasks" : "Start alternatives"}</button>
        {!draft.pending && <button type="button" disabled={busy} onClick={() => { try { persist({ ...newWorkSetDraft(draftKey), cancellations: draft.cancellations }); setError(""); } catch (cause) { setError(errorText(cause)); } }}>Discard task plan</button>}
      </div>{!client.createAgentWorkSet && <p>This WTS host cannot start task plans. Update WTS to use this control.</p>}
    </section>
  </details>;
}

function CandidatePreview({ client, set, task, onLeaveReview }: { client: WorkspaceClient; set: AgentWorkSet; task: AgentWorkItem; onLeaveReview: () => void }) {
  const [preview, setPreview] = useState<AgentWorkItemPreview>(); const [error, setError] = useState("");
  const [busy, setBusy] = useState(false); const busyRef = useRef(false); const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, [client]);
  const open = async () => {
    if (busyRef.current) return;
    if (!client.openAgentWorkItemPreview) { setError("This host cannot open a candidate preview. Update WTS, or open the task workspace."); return; }
    busyRef.current = true; setBusy(true); setError(""); const token = ++generation.current;
    try {
      const value = await client.openAgentWorkItemPreview(set.workSetId, task.taskId);
      if (token !== generation.current) return;
      if (value.workSetId !== set.workSetId || value.taskId !== task.taskId || value.workspaceId !== task.workspaceId || value.repositoryId !== task.repositoryId || value.afterCheckpointId !== task.afterCheckpointId) throw new Error("The preview does not match this candidate. Refresh the plan before you retry.");
      setPreview(value);
    } catch (cause) { if (token === generation.current) setError(errorText(cause)); }
    finally { if (token === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  return <div>
    <div className={styles.actions}>
      {task.state === "completed" && task.afterCheckpointId && <button type="button" disabled={busy} onClick={() => void open()}>{error || (preview && preview.state !== "running") ? "Retry preview" : "Open live preview"}</button>}
      <a href={`/sessions/${encodeURIComponent(task.workspaceId!)}/changes?repository=${encodeURIComponent(task.repositoryId!)}`} onClick={event => { if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return; event.preventDefault(); onLeaveReview(); window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId: task.workspaceId, repositoryId: task.repositoryId } })); }}>Open task workspace</a>
    </div>
    {busy && <p role="status">WTS opens the candidate preview.</p>}{error && <p role="alert">{error}</p>}{preview && <p role="status">{preview.detail}</p>}
  </div>;
}
