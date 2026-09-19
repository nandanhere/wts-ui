import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTurnChanges } from "../lib/agentTurnChanges";
import type { AgentTurnChecks, AgentTurnCheck, AgentTurnRestorePreflight, AgentTurnRestoreResult } from "../lib/agentTurnActions";
import { clearPendingTurnAction, readPendingTurnAction, savePendingTurnAction, type PendingTurnAction } from "../lib/agentTurnActionStorage";
import type { WorkspaceClient } from "../lib/wtsClient";
import { AgentResultWorkSets } from "./AgentResultWorkSets";
import { AgentResultDecision } from "./AgentResultDecision";
import styles from "./AgentResultReview.module.css";

function errorText(cause: unknown) { return cause instanceof Error ? cause.message : "WTS could not complete this request. Refresh its status before you retry."; }
function matches(value: { conversationId: string; requestId: string; workspaceId: string; repositoryId: string; sessionId: string }, receipt: AgentTurnChanges) {
  return ["conversationId", "requestId", "workspaceId", "repositoryId", "sessionId"].every(key => value[key as keyof typeof value] === receipt[key as keyof AgentTurnChanges]);
}
function readPending(key: string, kind: PendingTurnAction["kind"]): { action?: PendingTurnAction; error: string } {
  try { return { action: readPendingTurnAction(key, kind), error: "" }; } catch (cause) { return { error: errorText(cause) }; }
}
const runLabels = { running: "Active", passed: "Passed", failed: "Failed", timedOut: "Time limit reached", cancelled: "Cancelled", interrupted: "Interrupted", stale: "Files changed", blocked: "Blocked" };
export function AgentResultActions({ client, receipt, onOpenVerification, calloutScope, onLeaveReview = () => {} }: { client: WorkspaceClient; receipt: AgentTurnChanges; onOpenVerification: () => void; calloutScope?: { id: string; label: string }; onLeaveReview?: () => void }) {
  const host = useRef({ client, version: 0 });
  if (host.current.client !== client) host.current = { client, version: host.current.version + 1 };
  const key = JSON.stringify([receipt.conversationId, receipt.requestId, receipt.workspaceId, receipt.repositoryId, receipt.sessionId, receipt.after?.checkpointId]);
  return <div className={styles.taskActions} data-ui={`${calloutScope?.id ?? "agent-result"}.actions`} data-ui-label={`${calloutScope?.label ?? "Task"} actions`} key={`${key}:${host.current.version}`} onClickCapture={event => { if (event.detail > 1 && event.target instanceof Element && event.target.closest("button, a, [role=button]")) { event.preventDefault(); event.stopPropagation(); } }}>
    <AgentResultDecision client={client} receipt={receipt} calloutScope={calloutScope} />
    <AgentResultWorkSets client={client} receipt={receipt} calloutScope={calloutScope} onLeaveReview={onLeaveReview} />
    <HostChecks client={client} receipt={receipt} actionKey={key} onOpenVerification={onOpenVerification} />
    <TaskRestore client={client} receipt={receipt} actionKey={key} />
  </div>;
}
function HostChecks({ client, receipt, actionKey, onOpenVerification }: { client: WorkspaceClient; receipt: AgentTurnChanges; actionKey: string; onOpenVerification: () => void }) {
  const [opened, setOpened] = useState(false);
  const [checks, setChecks] = useState<AgentTurnChecks>();
  const initial = useRef(readPending(actionKey, "check"));
  const [pending, setPending] = useState(initial.current.action);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [error, setError] = useState(initial.current.error);
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const generation = useRef(0);
  const scope = useRef(client);
  if (scope.current !== client) { scope.current = client; generation.current++; }
  useEffect(() => () => { generation.current++; }, [client]);
  const install = useCallback((value: AgentTurnChecks) => {
    if (!matches(value, receipt)) throw new Error("The check results do not match this task.");
    setChecks(value);
    const saved = pendingRef.current;
    if (saved?.kind === "check" && value.runs.some(run => run.runId === saved.request.requestId && run.checkId === saved.request.checkId)) {
      clearPendingTurnAction(saved); pendingRef.current = undefined; setPending(undefined);
    }
  }, [receipt]);
  const load = useCallback(async () => {
    if (busyRef.current || !client.getAgentTurnChecks) return;
    const request = ++generation.current; busyRef.current = true; setBusy(true); setError("");
    try { const value = await client.getAgentTurnChecks(receipt.conversationId, receipt.requestId); if (request === generation.current) install(value); }
    catch (cause) { if (request === generation.current) setError(errorText(cause)); }
    finally { if (request === generation.current) { busyRef.current = false; setBusy(false); } }
  }, [client, receipt, install]);
  useEffect(() => { if (opened) void load(); }, [opened, load]);
  useEffect(() => { if (!opened || !checks?.runs.some(run => run.status === "running")) return; const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 2000); return () => window.clearInterval(timer); }, [opened, checks, load]);
  const run = async (check?: AgentTurnCheck) => {
    if (busyRef.current || !client.runAgentTurnCheck) return;
    const attempt = pendingRef.current ?? (check && checks?.state === "ready" && checks.afterCheckpointId === receipt.after?.checkpointId ? { key: actionKey, kind: "check" as const, request: { requestId: crypto.randomUUID(), checkId: check.checkId, expectedAfterCheckpointId: checks.afterCheckpointId!, expectedPlanRevision: check.planRevision } } : undefined);
    if (!attempt || attempt.kind !== "check") return;
    try { savePendingTurnAction(attempt); } catch (cause) { setError(errorText(cause)); return; }
    pendingRef.current = attempt; setPending(attempt); busyRef.current = true; setBusy(true); setError(""); const request = ++generation.current;
    try { const value = await client.runAgentTurnCheck(receipt.conversationId, receipt.requestId, attempt.request); if (request === generation.current) {
      if (!value.runs.some(item => item.runId === attempt.request.requestId && item.checkId === attempt.request.checkId)) throw new Error("WTS did not confirm this check request. Refresh its status before you retry.");
      install(value);
    } } catch (cause) { if (request === generation.current) setError(errorText(cause)); }
    finally { if (request === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const fresh = !error && checks?.state === "ready" && checks.afterCheckpointId === receipt.after?.checkpointId;
  return <details className={styles.actionDisclosure} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>Host checks{checks && ` · ${checks.runs.filter(run => run.status === "passed").length} passed`}</summary>
    <section aria-label="Host checks" role="region">
      <p>These results come from commands that WTS ran. Agent text does not change their status.</p>
      <a href={`/sessions/${encodeURIComponent(receipt.workspaceId)}/verification`} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); onOpenVerification(); }}>Open workspace verification</a>
      {!client.getAgentTurnChecks && <p>This WTS host cannot read task checks. Update WTS to use this control.</p>}
      {client.getAgentTurnChecks && <button type="button" disabled={busy} onClick={() => void load()}>Refresh checks</button>}
      {busy && <p role="status">WTS reads or runs the selected check.</p>}
      {error && <p role="alert">{error}</p>}
      {pending && <p>WTS kept this request for an exact retry. Refresh checks to read its status. <button type="button" disabled={busy || !client.runAgentTurnCheck} onClick={() => void run()}>Retry check request</button></p>}
      {checks && <><p>{checks.detail}</p>{checks.state === "ready" && checks.afterCheckpointId !== receipt.after?.checkpointId && <p>The check record uses another checkpoint. Refresh the task record before you run a check.</p>}
        <ul className={styles.checks}>{checks.checks.map(check => <li key={check.checkId}><span>{check.label}</span><button type="button" disabled={!fresh || busy || !!pending || !client.runAgentTurnCheck || checks.runs.some(run => run.status === "running")} onClick={() => void run(check)}>Run {check.label}</button></li>)}</ul>
        {!client.runAgentTurnCheck && checks.checks.length > 0 && <p>This WTS host cannot run task checks. Update WTS to use this control.</p>}
        {checks.runs.map(run => <details key={run.runId} className={styles.run}><summary>{checks.checks.find(check => check.checkId === run.checkId)?.label ?? run.checkId} · {runLabels[run.status]}</summary><p>{run.detail}</p><p>{run.durationMs !== undefined && `${run.durationMs} ms`}{run.exitCode !== undefined && ` · Exit ${run.exitCode}`}</p>{run.output && <pre>{run.output}</pre>}{run.outputTruncated && <p>WTS omitted part of the command output.</p>}</details>)}
      </>}
    </section>
  </details>;
}
function TaskRestore({ client, receipt, actionKey }: { client: WorkspaceClient; receipt: AgentTurnChanges; actionKey: string }) {
  const [opened, setOpened] = useState(false);
  const [preflight, setPreflight] = useState<AgentTurnRestorePreflight>();
  const [result, setResult] = useState<AgentTurnRestoreResult>();
  const initial = useRef(readPending(actionKey, "restore"));
  const [pending, setPending] = useState(initial.current.action);
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const [error, setError] = useState(initial.current.error);
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const generation = useRef(0); const scope = useRef(client);
  if (scope.current !== client) { scope.current = client; generation.current++; }
  useEffect(() => () => { generation.current++; }, [client]);
  const load = useCallback(async () => {
    if (busyRef.current || !client.preflightAgentTurnRestore) return;
    busyRef.current = true; setBusy(true); setError(""); const request = ++generation.current;
    try {
      const value = await client.preflightAgentTurnRestore(receipt.conversationId, receipt.requestId);
      if (request !== generation.current) return;
      if (!matches(value, receipt)) throw new Error("The restore details do not match this task.");
      setPreflight(value); setResult(undefined);
      if (value.state === "restored" && pendingRef.current) { clearPendingTurnAction(pendingRef.current); pendingRef.current = undefined; setPending(undefined); }
    } catch (cause) { if (request === generation.current) setError(errorText(cause)); }
    finally { if (request === generation.current) { busyRef.current = false; setBusy(false); } }
  }, [client, receipt]);
  useEffect(() => { if (opened) void load(); }, [opened, load]);
  const restore = async () => {
    if (busyRef.current || !client.restoreAgentTurn) return;
    const attempt = pendingRef.current ?? (preflight?.state === "ready" && preflight.afterCheckpointId === receipt.after?.checkpointId && !preflight.blockers.length ? { key: actionKey, kind: "restore" as const, request: { requestId: preflight.resumeRequestId ?? crypto.randomUUID(), effectDigest: preflight.effectDigest } } : undefined);
    if (!attempt || attempt.kind !== "restore") return;
    try { savePendingTurnAction(attempt); } catch (cause) { setError(errorText(cause)); return; }
    pendingRef.current = attempt; setPending(attempt); busyRef.current = true; setBusy(true); setError(""); const request = ++generation.current;
    try {
      const value = await client.restoreAgentTurn(receipt.conversationId, receipt.requestId, attempt.request);
      if (request !== generation.current) return;
      if (value.conversationId !== receipt.conversationId || value.requestId !== receipt.requestId || value.restoreRequestId !== attempt.request.requestId) throw new Error("WTS did not confirm this restore request. Refresh its status before you retry.");
      setResult(value); setPreflight(undefined);
      if (value.state !== "incomplete") { clearPendingTurnAction(attempt); pendingRef.current = undefined; setPending(undefined); }
    } catch (cause) { if (request === generation.current) setError(errorText(cause)); }
    finally { if (request === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const effects = result ?? preflight;
  const ready = !error && preflight?.state === "ready" && preflight.afterCheckpointId === receipt.after?.checkpointId && !preflight.blockers.length;
  return <details className={styles.actionDisclosure} onToggle={event => setOpened(event.currentTarget.open)}>
    <summary>Restore task changes</summary>
    <section aria-label="Restore task changes" role="region">
      <p>WTS can restore only the listed files to their state before this task. It checks for later edits before each restore.</p><p>Keep other editors and Git tools idle until the restore finishes.</p>
      {!client.preflightAgentTurnRestore && <p>This WTS host cannot inspect a restore. Update WTS to use this control.</p>}
      {client.preflightAgentTurnRestore && <button type="button" disabled={busy} onClick={() => void load()}>Refresh restore details</button>}
      {busy && <p role="status">WTS checks or restores the listed files.</p>}
      {error && <p role="alert">{error}</p>}
      {pending && <p>WTS kept this request for an exact retry. Refresh restore details to read its status. A retry does not approve new file changes. <button type="button" disabled={busy || !client.restoreAgentTurn} onClick={() => void restore()}>Retry restore request</button></p>}
      {effects && <><p>{effects.detail}</p><ul className={styles.restoreFiles}>{effects.files.map(file => <li key={file.filePath}><strong>{file.action === "remove" ? "Remove" : "Restore"}</strong> <code>{file.filePath}</code></li>)}</ul>
        {effects.blockers.length > 0 && <ul>{effects.blockers.map((blocker, index) => <li key={`${blocker.code}:${blocker.filePath}:${index}`}>{blocker.filePath && <code>{blocker.filePath}: </code>}{blocker.detail}</li>)}</ul>}
        {preflight?.state === "ready" && preflight.afterCheckpointId !== receipt.after?.checkpointId && <p>The restore details use another checkpoint. Refresh the task record before you continue.</p>}
        {ready && !pending && <button type="button" disabled={busy || !client.restoreAgentTurn} onClick={() => void restore()}>{preflight!.resumeRequestId ? "Continue restore" : `Restore ${preflight!.files.length} ${preflight!.files.length === 1 ? "file" : "files"}`}</button>}
        {ready && !client.restoreAgentTurn && <p>This WTS host cannot restore task changes. Update WTS to use this control.</p>}
      </>}
    </section>
  </details>;
}
