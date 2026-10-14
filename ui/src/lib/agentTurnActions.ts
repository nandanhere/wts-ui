import { validateAgentTurnId } from "./agentTurnChanges";

export interface AgentTurnCheck {
  checkId: string; label: string; kind: "unit" | "integration" | "ui" | "contract" | "lint" | "build" | "custom"; planRevision: number;
}
export interface AgentTurnCheckRun {
  runId: string; checkId: string;
  status: "running" | "passed" | "failed" | "timedOut" | "cancelled" | "interrupted" | "stale" | "blocked";
  startedAtUnixMs: number; completedAtUnixMs?: number; durationMs?: number; exitCode?: number;
  output: string; outputTruncated: boolean; detail: string;
}
interface TurnIdentity { schemaVersion: 1; conversationId: string; requestId: string; sessionId: string; workspaceId: string; repositoryId: string; }
export interface AgentTurnChecks extends TurnIdentity {
  afterCheckpointId?: string; state: "ready" | "stale" | "unavailable" | "noChecks"; detail: string;
  checks: AgentTurnCheck[]; runs: AgentTurnCheckRun[];
}
export interface RunAgentTurnCheckRequest { requestId: string; checkId: string; expectedAfterCheckpointId: string; expectedPlanRevision: number; }
export interface AgentTurnRestoreFile { filePath: string; action: "restore" | "remove"; }
export interface AgentTurnRestoreBlocker { code: string; filePath?: string; detail: string; }
export interface AgentTurnRestorePreflight extends TurnIdentity {
  afterCheckpointId?: string; resumeRequestId?: string; state: "ready" | "blocked" | "restored"; effectDigest: string;
  files: AgentTurnRestoreFile[]; blockers: AgentTurnRestoreBlocker[]; detail: string; restoredAtUnixMs?: number;
}
export interface RestoreAgentTurnRequest { requestId: string; effectDigest: string; }
export interface AgentTurnRestoreResult {
  schemaVersion: 1; conversationId: string; requestId: string; restoreRequestId: string; state: "restored" | "conflict" | "incomplete";
  restoredAtUnixMs?: number; files: AgentTurnRestoreFile[]; blockers: AgentTurnRestoreBlocker[]; detail: string;
}
type Fail = (field: string) => never;
function record(value: unknown, fail: Fail): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("agentTurnActions.object");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, fail: Fail, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || new TextEncoder().encode(value).length > max) fail("agentTurnActions.text");
}
function integer(value: unknown, fail: Fail, minimum = 0) { if (!Number.isSafeInteger(value) || Number(value) < minimum) fail("agentTurnActions.number"); }
function digest(value: unknown, fail: Fail) { if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) fail("agentTurnActions.digest"); }
function checkId(value: unknown, fail: Fail) { if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) fail("agentTurnActions.checkId"); }
function list(value: unknown, limit: number, fail: Fail): unknown[] { if (!Array.isArray(value) || value.length > limit) return fail("agentTurnActions.list"); return value; }
function identity(value: unknown, fail: Fail, conversationId: string, requestId: string, full = true) {
  const item = record(value, fail);
  if (item.schemaVersion !== 1 || item.conversationId !== conversationId || item.requestId !== requestId) fail("agentTurnActions.identity");
  validateAgentTurnId(item.conversationId, fail); validateAgentTurnId(item.requestId, fail);
  if (full) { validateAgentTurnId(item.sessionId, fail); validateAgentTurnId(item.workspaceId, fail); text(item.repositoryId, 4096, fail); }
  if (item.afterCheckpointId !== undefined) validateAgentTurnId(item.afterCheckpointId, fail);
  text(item.detail, 2048, fail, true);
  return item;
}
export function validateRunAgentTurnCheck(request: unknown, fail: Fail): asserts request is RunAgentTurnCheckRequest {
  const item = record(request, fail); validateAgentTurnId(item.requestId, fail); checkId(item.checkId, fail); validateAgentTurnId(item.expectedAfterCheckpointId, fail); integer(item.expectedPlanRevision, fail, 1);
  if (Object.keys(item).some(key => !["requestId", "checkId", "expectedAfterCheckpointId", "expectedPlanRevision"].includes(key))) fail("agentTurnActions.request");
}
export function normalizeAgentTurnChecks(value: unknown, fail: Fail, conversationId: string, requestId: string, request?: RunAgentTurnCheckRequest): AgentTurnChecks {
  const item = identity(value, fail, conversationId, requestId);
  if (!["ready", "stale", "unavailable", "noChecks"].includes(String(item.state))) fail("agentTurnActions.state");
  if (item.state === "ready" && !item.afterCheckpointId) fail("agentTurnActions.checkpoint");
  const checks = list(item.checks, 64, fail); const ids = new Set<string>();
  for (const raw of checks) {
    const check = record(raw, fail); checkId(check.checkId, fail); text(check.label, 512, fail); integer(check.planRevision, fail, 1);
    if (!["unit", "integration", "ui", "contract", "lint", "build", "custom"].includes(String(check.kind))) fail("agentTurnActions.kind");
    if (ids.has(String(check.checkId))) fail("agentTurnActions.duplicateCheck"); ids.add(String(check.checkId));
  }
  const runs = list(item.runs, 64, fail); const runIds = new Set<string>();
  for (const raw of runs) {
    const run = record(raw, fail); validateAgentTurnId(run.runId, fail); checkId(run.checkId, fail);
    if (!["running", "passed", "failed", "timedOut", "cancelled", "interrupted", "stale", "blocked"].includes(String(run.status))) fail("agentTurnActions.status");
    if (runIds.has(String(run.runId))) fail("agentTurnActions.duplicateRun"); runIds.add(String(run.runId));
    integer(run.startedAtUnixMs, fail);
    for (const field of ["completedAtUnixMs", "durationMs"]) if (run[field] !== undefined) integer(run[field], fail);
    if (run.exitCode !== undefined && (!Number.isInteger(run.exitCode) || Number(run.exitCode) < -2147483648 || Number(run.exitCode) > 2147483647)) fail("agentTurnActions.exitCode");
    text(run.output, 65536, fail, true); text(run.detail, 2048, fail, true);
    if (typeof run.outputTruncated !== "boolean") fail("agentTurnActions.outputTruncated");
  }
  if (request && !runs.some(raw => { const run = raw as Record<string, unknown>; return run.runId === request.requestId && run.checkId === request.checkId; })) fail("agentTurnActions.acknowledgement");
  return item as unknown as AgentTurnChecks;
}
function restoreEffects(item: Record<string, unknown>, fail: Fail) {
  const paths = new Set<string>();
  for (const raw of list(item.files, 2048, fail)) {
    const file = record(raw, fail); text(file.filePath, 4096, fail);
    if (!["restore", "remove"].includes(String(file.action)) || paths.has(file.filePath)) fail("agentTurnActions.effect");
    paths.add(file.filePath);
  }
  for (const raw of list(item.blockers, 2048, fail)) { const blocker = record(raw, fail); text(blocker.code, 128, fail); if (blocker.filePath !== undefined) text(blocker.filePath, 4096, fail); text(blocker.detail, 2048, fail, true); }
  if (item.restoredAtUnixMs !== undefined) integer(item.restoredAtUnixMs, fail);
}
export function normalizeAgentTurnRestorePreflight(value: unknown, fail: Fail, conversationId: string, requestId: string): AgentTurnRestorePreflight {
  const item = identity(value, fail, conversationId, requestId); restoreEffects(item, fail); digest(item.effectDigest, fail);
  if (item.resumeRequestId !== undefined) validateAgentTurnId(item.resumeRequestId, fail);
  if (!["ready", "blocked", "restored"].includes(String(item.state))) fail("agentTurnActions.state");
  if (item.state === "ready" && (!item.afterCheckpointId || (item.blockers as unknown[]).length)) fail("agentTurnActions.preflight");
  return item as unknown as AgentTurnRestorePreflight;
}
export function validateRestoreAgentTurn(request: unknown, fail: Fail): asserts request is RestoreAgentTurnRequest {
  const item = record(request, fail); validateAgentTurnId(item.requestId, fail); digest(item.effectDigest, fail);
  if (Object.keys(item).some(key => !["requestId", "effectDigest"].includes(key))) fail("agentTurnActions.request");
}
export function normalizeAgentTurnRestoreResult(value: unknown, fail: Fail, conversationId: string, requestId: string, request: RestoreAgentTurnRequest): AgentTurnRestoreResult {
  const item = identity(value, fail, conversationId, requestId, false); restoreEffects(item, fail); validateAgentTurnId(item.restoreRequestId, fail);
  if (!["restored", "conflict", "incomplete"].includes(String(item.state)) || item.restoreRequestId !== request.requestId) fail("agentTurnActions.acknowledgement");
  return item as unknown as AgentTurnRestoreResult;
}
