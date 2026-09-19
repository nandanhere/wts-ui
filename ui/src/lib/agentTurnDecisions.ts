import { validateAgentTurnId } from "./agentTurnChanges";
import type { AgentTurnCheckRun } from "./agentTurnActions";
export type AgentTurnDecisionKind = "accepted" | "kept" | "rejected";
export type AgentTurnDecisionChecksState = "ready" | "stale" | "unavailable" | "noChecks";
export interface RecordAgentTurnDecisionRequest {
  requestId: string; expectedRevision: number; expectedReceiptDigest: string; kind: AgentTurnDecisionKind; reason: string;
}
export interface AgentTurnDecision {
  decisionId: string; revision: number; kind: AgentTurnDecisionKind; reason: string; createdAtUnixMs: number;
  afterCheckpointId: string; receiptDigest: string; sourceContextSha256: string; checksState: AgentTurnDecisionChecksState;
  checks: { runId: string; checkId: string; status: AgentTurnCheckRun["status"] }[];
}
export interface AgentTurnDecisions {
  schemaVersion: 1; conversationId: string; requestId: string; sessionId: string; workspaceId: string; repositoryId: string;
  afterCheckpointId?: string; receiptDigest: string; sourceContextSha256: string; revision: number;
  state: "ready" | "unavailable"; checksState: AgentTurnDecisionChecksState; detail: string; decisions: AgentTurnDecision[];
}
export function hasUnsupportedDecisionReason(value: string) { return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value); }
type Fail = (field: string) => never;
function object(value: unknown, fail: Fail): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) return fail("agentTurnDecisions.object"); return value as Record<string, unknown>; }
function text(value: unknown, max: number, fail: Fail, empty = false) { if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || new TextEncoder().encode(value).length > max) fail("agentTurnDecisions.text"); }
function digest(value: unknown, fail: Fail) { if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) fail("agentTurnDecisions.digest"); }
function integer(value: unknown, min: number, max: number, fail: Fail) { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail("agentTurnDecisions.revision"); }
function kind(value: unknown, fail: Fail) { if (!["accepted", "kept", "rejected"].includes(String(value))) fail("agentTurnDecisions.kind"); }
function checksState(value: unknown, fail: Fail) { if (!["ready", "stale", "unavailable", "noChecks"].includes(String(value))) fail("agentTurnDecisions.checksState"); }
export function validateRecordAgentTurnDecision(value: unknown, fail: Fail): asserts value is RecordAgentTurnDecisionRequest {
  const item = object(value, fail); validateAgentTurnId(item.requestId, fail); integer(item.expectedRevision, 0, 63, fail); digest(item.expectedReceiptDigest, fail); kind(item.kind, fail); text(item.reason, 4096, fail, true); if (hasUnsupportedDecisionReason(item.reason as string)) fail("agentTurnDecisions.reason");
  if (Object.keys(item).some(key => !["requestId", "expectedRevision", "expectedReceiptDigest", "kind", "reason"].includes(key))) fail("agentTurnDecisions.request");
}
export function normalizeAgentTurnDecisions(value: unknown, fail: Fail, conversationId: string, requestId: string, request?: RecordAgentTurnDecisionRequest): AgentTurnDecisions {
  const item = object(value, fail);
  if (item.schemaVersion !== 1 || item.conversationId !== conversationId || item.requestId !== requestId) fail("agentTurnDecisions.identity");
  for (const field of ["conversationId", "requestId", "sessionId", "workspaceId"]) validateAgentTurnId(item[field], fail);
  text(item.repositoryId, 4096, fail); text(item.detail, 2048, fail, true);
  if (item.afterCheckpointId !== undefined) validateAgentTurnId(item.afterCheckpointId, fail);
  if (!["ready", "unavailable"].includes(String(item.state)) || (item.state === "ready" && !item.afterCheckpointId)) fail("agentTurnDecisions.state");
  digest(item.receiptDigest, fail); digest(item.sourceContextSha256, fail); integer(item.revision, 0, 64, fail); checksState(item.checksState, fail);
  if (!Array.isArray(item.decisions) || item.decisions.length > 64) fail("agentTurnDecisions.history");
  const history = item.decisions as unknown[]; const ids = new Set<string>(); let revision = 0;
  for (const raw of history) {
    const decision = object(raw, fail); const id = validateAgentTurnId(decision.decisionId, fail);
    if (ids.has(id)) fail("agentTurnDecisions.duplicate"); ids.add(id);
    integer(decision.revision, revision + 1, revision + 1, fail); revision = Number(decision.revision);
    kind(decision.kind, fail); text(decision.reason, 4096, fail, true); if (hasUnsupportedDecisionReason(decision.reason as string)) fail("agentTurnDecisions.reason"); integer(decision.createdAtUnixMs, 0, 8640000000000000, fail);
    validateAgentTurnId(decision.afterCheckpointId, fail); digest(decision.receiptDigest, fail); digest(decision.sourceContextSha256, fail); checksState(decision.checksState, fail);
    if (decision.afterCheckpointId !== item.afterCheckpointId || decision.receiptDigest !== item.receiptDigest || decision.sourceContextSha256 !== item.sourceContextSha256) fail("agentTurnDecisions.receipt");
    if (!Array.isArray(decision.checks) || decision.checks.length > 64) fail("agentTurnDecisions.checks");
    const runs = new Set<string>();
    for (const rawCheck of decision.checks as unknown[]) {
      const check = object(rawCheck, fail); const runId = validateAgentTurnId(check.runId, fail);
      if (runs.has(runId)) fail("agentTurnDecisions.duplicateCheck"); runs.add(runId);
      if (typeof check.checkId !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(check.checkId)) fail("agentTurnDecisions.checkId");
      if (!["running", "passed", "failed", "timedOut", "cancelled", "interrupted", "stale", "blocked"].includes(String(check.status))) fail("agentTurnDecisions.checkStatus");
    }
  }
  if (revision !== item.revision) fail("agentTurnDecisions.revision");
  if (request && !history.some(raw => { const decision = raw as AgentTurnDecision; return decision.decisionId === request.requestId && decision.revision === request.expectedRevision + 1 && decision.kind === request.kind && decision.reason === request.reason && decision.receiptDigest === request.expectedReceiptDigest; })) fail("agentTurnDecisions.acknowledgement");
  return item as unknown as AgentTurnDecisions;
}
