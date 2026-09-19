import { notifyAgentResultReviewed } from "../variants/local-workspace/workspaceAttention";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { AgentTurnChanges } from "../lib/agentTurnChanges";
import { hasUnsupportedDecisionReason } from "../lib/agentTurnDecisions";
import type { AgentTurnDecision, AgentTurnDecisionKind, AgentTurnDecisions } from "../lib/agentTurnDecisions";
import { readAgentTurnDecisionDraft, saveAgentTurnDecisionDraft, type AgentTurnDecisionDraft } from "../lib/agentTurnDecisionDraft";
import { WorkspaceClientError, type WorkspaceClient } from "../lib/wtsClient";
import styles from "./AgentResultReview.module.css";
const choices: { value: AgentTurnDecisionKind; label: string; status: string }[] = [
  { value: "accepted", label: "Accept result", status: "Accepted" },
  { value: "kept", label: "Keep as alternative", status: "Alternative" },
  { value: "rejected", label: "Reject result", status: "Rejected" },
];
const checkStates = { ready: "Recorded checks", stale: "Files changed", unavailable: "Checks unavailable", noChecks: "No checks configured" };
const runStates = { running: "Active", passed: "Passed", failed: "Failed", timedOut: "Time limit reached", cancelled: "Cancelled", interrupted: "Interrupted", stale: "Files changed", blocked: "Blocked" };
function errorText(cause: unknown) { return cause instanceof Error ? cause.message : "WTS could not save this decision. Refresh decisions before you retry."; }
function initialDraft(key: string) { try { return { draft: readAgentTurnDecisionDraft(key), error: "" }; } catch (cause) { return { draft: { key, reason: "" }, error: errorText(cause) }; } }
function matchingDecision(ledger: AgentTurnDecisions, draft: AgentTurnDecisionDraft) {
  const request = draft.pending;
  return request && ledger.decisions.some(decision => decision.decisionId === request.requestId && decision.kind === request.kind && decision.reason === request.reason && decision.receiptDigest === request.expectedReceiptDigest && decision.revision === request.expectedRevision + 1);
}
export function AgentResultDecision({ client, receipt, calloutScope }: { client: WorkspaceClient; receipt: AgentTurnChanges; calloutScope?: { id: string; label: string } }) {
  const host = useRef({ client, version: 0 });
  if (host.current.client !== client) host.current = { client, version: host.current.version + 1 };
  const scopeKey = JSON.stringify([receipt.conversationId, receipt.requestId, receipt.workspaceId, receipt.repositoryId, receipt.sessionId, receipt.sourceContextSha256, receipt.after?.checkpointId]);
  return <DecisionForm key={`${scopeKey}:${host.current.version}`} client={client} receipt={receipt} scopeKey={scopeKey} calloutScope={calloutScope} />;
}
function DecisionForm({ client, receipt, scopeKey, calloutScope }: { client: WorkspaceClient; receipt: AgentTurnChanges; scopeKey: string; calloutScope?: { id: string; label: string } }) {
  const initial = useRef(initialDraft(scopeKey));
  const [draft, setDraft] = useState<AgentTurnDecisionDraft>(initial.current.draft); const draftRef = useRef(draft); draftRef.current = draft;
  const [ledger, setLedger] = useState<AgentTurnDecisions>(); const ledgerRef = useRef(ledger); ledgerRef.current = ledger;
  const [error, setError] = useState(initial.current.error);
  const [busy, setBusy] = useState(false); const busyRef = useRef(false); const generation = useRef(0);
  const name = useId();
  const update = (value: AgentTurnDecisionDraft) => { draftRef.current = value; setDraft(value); };
  const persist = (value: AgentTurnDecisionDraft) => { saveAgentTurnDecisionDraft(value); update(value); };
  const install = useCallback((value: AgentTurnDecisions, fromRead: boolean) => {
    if (value.conversationId !== receipt.conversationId || value.requestId !== receipt.requestId || value.workspaceId !== receipt.workspaceId || value.repositoryId !== receipt.repositoryId || value.sessionId !== receipt.sessionId || value.sourceContextSha256 !== receipt.sourceContextSha256 || (value.afterCheckpointId !== receipt.after?.checkpointId && (value.state === "ready" || value.afterCheckpointId))) throw new Error("The decision history does not match this saved result.");
    if (ledgerRef.current && (ledgerRef.current.receiptDigest !== value.receiptDigest || value.revision < ledgerRef.current.revision)) {
      if (ledgerRef.current.receiptDigest !== value.receiptDigest) throw new Error("The saved result changed. Close this review, then open it again.");
    } else { ledgerRef.current = value; setLedger(value); }
    if (value.decisions.length > 0) notifyAgentResultReviewed(client, {
      conversationId: receipt.conversationId, requestId: receipt.requestId, sessionId: receipt.sessionId,
    });
    const current = draftRef.current;
    if (matchingDecision(value, current)) persist({ key: scopeKey, reason: "" });
    else if (fromRead && current.needsRefresh) persist({ ...current, needsRefresh: false });
  }, [client, receipt, scopeKey]);
  const load = useCallback(async () => {
    if (busyRef.current || !client.getAgentTurnDecisions) return;
    busyRef.current = true; setBusy(true); setError(""); const request = ++generation.current;
    try { const value = await client.getAgentTurnDecisions(receipt.conversationId, receipt.requestId); if (request === generation.current) install(value, true); }
    catch (cause) { if (request === generation.current) setError(errorText(cause)); }
    finally { if (request === generation.current) { busyRef.current = false; setBusy(false); } }
  }, [client, receipt.conversationId, receipt.requestId, install]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const edit = (value: Partial<AgentTurnDecisionDraft>) => {
    if (draftRef.current.pending) return;
    const next = { ...draftRef.current, ...value }; update(next);
    try { saveAgentTurnDecisionDraft(next); setError(""); } catch (cause) { setError(errorText(cause)); }
  };
  const save = async () => {
    if (busyRef.current || !client.recordAgentTurnDecision) return;
    const current = draftRef.current; const saved = ledgerRef.current;
    if (!current.pending && (!current.kind || current.needsRefresh || !saved || saved.state !== "ready" || saved.revision >= 64 || new TextEncoder().encode(current.reason).length > 4096 || hasUnsupportedDecisionReason(current.reason))) return;
    const request = current.pending ?? { requestId: crypto.randomUUID(), expectedRevision: saved!.revision, expectedReceiptDigest: saved!.receiptDigest, kind: current.kind!, reason: current.reason };
    try { persist({ ...current, pending: request }); } catch (cause) { setError(errorText(cause)); return; }
    busyRef.current = true; setBusy(true); setError(""); const token = ++generation.current;
    try {
      const result = await client.recordAgentTurnDecision(receipt.conversationId, receipt.requestId, request);
      if (token !== generation.current) return;
      if (!matchingDecision(result, { ...current, pending: request })) throw new Error("WTS did not confirm this decision. Refresh decisions before you retry.");
      install(result, false);
    } catch (cause) {
      if (token !== generation.current) return;
      if (cause instanceof WorkspaceClientError && ["agent_conversation_conflict", "agent_conversation_storage_full"].includes(cause.code)) {
        try { persist({ ...current, pending: undefined, needsRefresh: true }); } catch (storageCause) { setError(errorText(storageCause)); return; }
      }
      setError(errorText(cause));
    } finally { if (token === generation.current) { busyRef.current = false; setBusy(false); } }
  };
  const latest = ledger?.decisions.at(-1);
  const tooLong = new TextEncoder().encode(draft.reason).length > 4096;
  const unsupportedReason = hasUnsupportedDecisionReason(draft.reason);
  const canSave = !!draft.kind && !draft.pending && !draft.needsRefresh && ledger?.state === "ready" && ledger.revision < 64 && !tooLong && !unsupportedReason && !busy && !!client.recordAgentTurnDecision;
  return <details className={styles.actionDisclosure} data-ui={`${calloutScope?.id ?? "agent-result"}.decision`} data-ui-label={`${calloutScope?.label ?? "Task"} review decision`}>
    <summary>Decision · {latest ? choices.find(choice => choice.value === latest.kind)!.status : ledger ? "Not set" : "Not loaded"}</summary>
    <section role="region" aria-label="Task review decision">
      <p>Record your review choice for this saved result. A choice does not change the recorded check results.</p>
      {client.getAgentTurnDecisions ? <button type="button" disabled={busy} onClick={() => void load()}>Refresh decisions</button> : <p>This WTS host cannot read decision history. Update WTS to use this control.</p>}
      {busy && <p role="status">WTS reads or saves the decision.</p>}
      {error && <p role="alert">{error}</p>}
      {draft.needsRefresh && <p>Refresh decisions to review the latest history. Then save your choice again.</p>}
      {draft.pending && <p>WTS kept this request for an exact retry. Refresh decisions to check its status. <button type="button" disabled={busy || !client.recordAgentTurnDecision} onClick={() => void save()}>Retry decision request</button></p>}
      {ledger && <p>{ledger.detail}</p>}
      {latest && <DecisionEntry decision={latest} />}
      {ledger && ledger.decisions.length > 1 && <details className={styles.decisionHistory}><summary>Decision history ({ledger.decisions.length - 1} earlier)</summary><ol>{ledger.decisions.slice(0, -1).reverse().map(decision => <li key={decision.decisionId}><DecisionEntry decision={decision} /></li>)}</ol></details>}
      <fieldset className={styles.decisionChoices} disabled={busy || !!draft.pending || !client.recordAgentTurnDecision || ledger?.state !== "ready"}>
        <legend>Review choice</legend>
        {choices.map(choice => <label key={choice.value}><input type="radio" name={name} value={choice.value} checked={draft.kind === choice.value} onChange={() => edit({ kind: choice.value })} />{choice.label}</label>)}
      </fieldset>
      <label className={styles.decisionReason}>Reason (optional)<textarea maxLength={4096} rows={3} value={draft.reason} readOnly={ledger?.state !== "ready" || !client.recordAgentTurnDecision} disabled={busy || !!draft.pending} onChange={event => edit({ reason: event.currentTarget.value })} /></label>
      {unsupportedReason && <p role="alert">The reason contains an unsupported control character. Remove it before you save.</p>}
      {tooLong && <p role="alert">The reason exceeds 4096 bytes. Shorten it before you save.</p>}
      <div className={styles.actions}><button type="button" disabled={!canSave} onClick={() => void save()}>Save decision</button>
        {!draft.pending && (draft.kind || draft.reason) && <button type="button" disabled={busy} onClick={() => { try { persist({ key: scopeKey, reason: "" }); setError(""); } catch (cause) { setError(errorText(cause)); } }}>Discard decision draft</button>}
      </div>
      {!client.recordAgentTurnDecision && <p>This WTS host cannot save decisions. Update WTS to use this control.</p>}
    </section>
  </details>;
}
function DecisionEntry({ decision }: { decision: AgentTurnDecision }) {
  return <div className={styles.decisionEntry}>
    <p><strong>{choices.find(choice => choice.value === decision.kind)!.status}</strong> · <time dateTime={new Date(decision.createdAtUnixMs).toISOString()}>{new Date(decision.createdAtUnixMs).toLocaleString()}</time></p>
    {decision.reason && <p className={styles.savedReason}>{decision.reason}</p>}
    <p>Checks at decision: {checkStates[decision.checksState]}</p>
    {decision.checks.length > 0 && <ul>{decision.checks.map(check => <li key={check.runId}>{check.checkId}: {runStates[check.status]}</li>)}</ul>}
  </div>;
}
