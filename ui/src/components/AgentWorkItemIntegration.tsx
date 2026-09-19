import { useCallback, useEffect, useRef, useState } from "react";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
import type { AgentWorkItem, AgentWorkSet, AgentWorkItemIntegrationPreflight, AgentWorkItemIntegrationResult, IntegrateAgentWorkItemRequest } from "../lib/agentWorkSets";
import { readPendingWorkItemIntegration, savePendingWorkItemIntegration } from "../lib/agentWorkItemIntegrationDraft";
import styles from "./AgentResultReview.module.css";
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : "WTS could not complete this integration. Refresh the file effects before you retry."; }
function initial(key: string) { try { return { request: readPendingWorkItemIntegration(key), error: "" }; } catch (cause) { return { request: undefined, error: errorText(cause) }; } }
export function AgentWorkItemIntegration({ client, set, task, onLeaveReview }: { client: WorkspaceClient; set: AgentWorkSet; task: AgentWorkItem; onLeaveReview: () => void }) {
  const key = JSON.stringify([set.workSetId, task.taskId, set.workspaceId, set.repositoryId, set.sourceCheckpointId, task.workspaceId, task.repositoryId, task.afterCheckpointId]);
  const host = useRef({ client, version: 0 }); if (host.current.client !== client) host.current = { client, version: host.current.version + 1 };
  return <Integration key={`${key}:${host.current.version}`} client={client} set={set} task={task} onLeaveReview={onLeaveReview} storageKey={key} />;
}
function Integration({ client, set, task, onLeaveReview, storageKey }: { client: WorkspaceClient; set: AgentWorkSet; task: AgentWorkItem; onLeaveReview: () => void; storageKey: string }) {
  const saved = useRef(initial(storageKey)); const [pending, setPending] = useState(saved.current.request); const pendingRef = useRef(pending); pendingRef.current = pending;
  const [opened, setOpened] = useState(false); const [preflight, setPreflight] = useState<AgentWorkItemIntegrationPreflight>(); const [result, setResult] = useState<AgentWorkItemIntegrationResult>();
  const [error, setError] = useState(saved.current.error); const [busy, setBusy] = useState(false); const busyRef = useRef(false); const generation = useRef(0);
  const persist = (request?: IntegrateAgentWorkItemRequest) => { savePendingWorkItemIntegration(storageKey, request); pendingRef.current = request; setPending(request); };
  const load = useCallback(async () => {
    if (busyRef.current || !client.preflightAgentWorkItemIntegration) return;
    busyRef.current = true; setBusy(true); setError(""); const token = ++generation.current;
    try {
      const value = await client.preflightAgentWorkItemIntegration(set.workSetId, task.taskId); if (token !== generation.current) return;
      if (value.workSetId !== set.workSetId || value.taskId !== task.taskId || value.workspaceId !== set.workspaceId || value.repositoryId !== set.repositoryId || value.sourceConversationId !== set.conversationId || value.sourceRequestId !== set.requestId || value.sourceAfterCheckpointId !== set.sourceCheckpointId || value.candidateConversationId !== task.conversationId || value.candidateRequestId !== task.requestId || value.candidateWorkspaceId !== task.workspaceId || value.candidateAfterCheckpointId !== task.afterCheckpointId) throw new Error("The file effects do not match this candidate. Refresh the task plan before you continue.");
      setPreflight(value);
      if (value.state === "integrated") persist();
      else if (value.resumeRequestId && pendingRef.current && (pendingRef.current.requestId !== value.resumeRequestId || pendingRef.current.effectDigest !== value.effectDigest)) throw new Error("The host has another pending integration. Keep this request and inspect the task workspace.");
    } catch (cause) { if (token === generation.current) setError(errorText(cause)); }
    finally { if (token === generation.current) { busyRef.current = false; setBusy(false); } }
  }, [client, set.workSetId, set.workspaceId, set.repositoryId, set.conversationId, set.requestId, set.sourceCheckpointId, task.taskId, task.conversationId, task.requestId, task.workspaceId, task.afterCheckpointId, storageKey]);
  useEffect(() => { if (opened) void load(); }, [opened, load]);
  useEffect(() => () => { generation.current++; }, []);
  const apply = async () => {
    if (busyRef.current || !client.integrateAgentWorkItem) return;
    const request = pendingRef.current ?? (preflight?.state === "ready" && !error && preflight.checkRunIds.length ? { requestId: preflight.resumeRequestId ?? crypto.randomUUID(), effectDigest: preflight.effectDigest } : undefined);
    if (!request) return;
    try { persist(request); } catch (cause) { setError(errorText(cause)); return; }
    busyRef.current = true; setBusy(true); setError(""); const token = ++generation.current;
    try {
      const value = await client.integrateAgentWorkItem(set.workSetId, task.taskId, request); if (token !== generation.current) return;
      if (value.workSetId !== set.workSetId || value.taskId !== task.taskId || value.workspaceId !== set.workspaceId || value.repositoryId !== set.repositoryId || value.integrationRequestId !== request.requestId) throw new Error("WTS did not confirm this integration request. Refresh its status before you retry.");
      setResult(value); if (value.state !== "incomplete") { persist(); setPreflight(current => current ? { ...current, state: value.state === "integrated" ? "integrated" : "blocked" } : current); }
    } catch (cause) {
      if (token !== generation.current) return;
      if (cause instanceof WorkspaceClientError && ["invalid_agent_conversation", "agent_conversation_conflict", "agent_conversation_storage_full"].includes(cause.code)) { try { persist(); setPreflight(undefined); } catch (storageCause) { setError(errorText(storageCause)); return; } }
      setError(errorText(cause));
    } finally { if (token === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const complete = result?.state === "integrated" || preflight?.state === "integrated";
  return <details className={styles.actionDisclosure} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>Integrate candidate{complete ? " · Applied" : ""}</summary>
    <section aria-label="Candidate integration" role="region">
      <p>Apply the listed candidate files to the original workspace. WTS requires matching passed checks. This action does not commit or publish changes.</p>
      <p>Keep other editors and Git tools idle until the operation finishes.</p>
      <div className={styles.actions}><a href={`/sessions/${encodeURIComponent(task.workspaceId!)}/verification`} onClick={event => { if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return; event.preventDefault(); onLeaveReview(); window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId: task.workspaceId, repositoryId: task.repositoryId, tab: "verification" } })); }}>Open candidate verification</a>
      <a href={`/sessions/${encodeURIComponent(set.workspaceId)}/changes?repository=${encodeURIComponent(set.repositoryId)}`} onClick={event => { if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return; event.preventDefault(); onLeaveReview(); window.dispatchEvent(new CustomEvent("wts:open-agent-workspace", { detail: { workspaceId: set.workspaceId, repositoryId: set.repositoryId } })); }}>View original workspace changes</a>
      {client.preflightAgentWorkItemIntegration && <button type="button" disabled={busy} onClick={() => void load()}>Refresh file effects</button>}</div>
      {!client.preflightAgentWorkItemIntegration && <p>This host cannot inspect candidate integration. Update WTS to continue.</p>}
      {busy && <p role="status">WTS checks or applies the candidate files.</p>}{error && <p role="alert">{error}</p>}
      {preflight && <>{result?.state !== "integrated" && <p>{preflight.detail}</p>}<p>{preflight.checkRunIds.length} recorded checks match this candidate.</p><ul className={styles.restoreFiles}>{preflight.files.map(file => <li key={file.filePath}><code>{file.filePath}</code> · {file.status === "typeChanged" ? "Type changed" : file.status}</li>)}</ul>{preflight.blockers.map((blocker, index) => <p key={index}>{blocker.filePath && <code>{blocker.filePath}: </code>}{blocker.detail}</p>)}</>}
      {result && <div role="status"><p>{result.detail}</p>{result.state === "incomplete" && <><p>WTS applied {result.files.length} files. Retry this request to continue the same operation.</p><ul className={styles.restoreFiles}>{result.files.map(file => <li key={file.filePath}><code>{file.filePath}</code> · {file.status}</li>)}</ul></>}{result.blockers.map((blocker, index) => <p key={index}>{blocker.filePath && <code>{blocker.filePath}: </code>}{blocker.detail}</p>)}</div>}
      {!complete && <div className={styles.actions}>{pending ? <button type="button" disabled={busy || !client.integrateAgentWorkItem} onClick={() => void apply()}>Retry integration request</button> : preflight && <button type="button" disabled={busy || !!error || preflight.state !== "ready" || !preflight.checkRunIds.length || !client.integrateAgentWorkItem} onClick={() => void apply()}>{preflight.resumeRequestId ? "Continue integration" : `Apply ${preflight.files.length} ${preflight.files.length === 1 ? "file" : "files"}`}</button>}</div>}
      {pending && <p>WTS kept this exact request. Refresh file effects to read its status, or retry the same request.</p>}
      {preflight && !client.integrateAgentWorkItem && <p>This host cannot apply candidates. Update WTS to continue.</p>}
    </section>
  </details>;
}
