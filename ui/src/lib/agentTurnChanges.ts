export interface AgentTurnCheckpoint {
  checkpointId: string;
  headCommitOid: string;
  branchName: string;
  capturedAtUnixMs: number;
  treeSha256: string;
  indexSha256: string;
}
export interface AgentTurnChangedFile {
  filePath: string;
  status: "added" | "modified" | "deleted" | "typeChanged";
  beforeSha256?: string;
  afterSha256?: string;
  preExistingChange: boolean;
  undoSupported: false;
  detail?: string;
}
export interface AgentTurnChanges {
  schemaVersion: 1;
  conversationId: string;
  requestId: string;
  sessionId: string;
  workspaceId: string;
  repositoryId: string;
  sourceContextSha256: string;
  state: "capturing" | "ready" | "incomplete" | "unavailable";
  observation: "normal" | "recovered";
  startedAtUnixMs: number;
  completedAtUnixMs?: number;
  before?: AgentTurnCheckpoint;
  after?: AgentTurnCheckpoint;
  files: AgentTurnChangedFile[];
  omittedFileCount: number;
  detail: string;
  patch: string;
  patchTruncated: boolean;
}

type Fail = (field: string) => never;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function record(value: unknown, field: string, fail: Fail): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(field);
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string, maxBytes: number, fail: Fail, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || new TextEncoder().encode(value).length > maxBytes) fail(field);
}
function number(value: unknown, field: string, fail: Fail) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail(field);
}
function digest(value: unknown, field: string, fail: Fail) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) fail(field);
}
export function validateAgentTurnId(value: unknown, fail: Fail): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) return fail("agentTurnChanges.id");
  return value;
}
function checkpoint(value: unknown, field: string, fail: Fail) {
  const item = record(value, field, fail);
  validateAgentTurnId(item.checkpointId, fail);
  if (typeof item.headCommitOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(item.headCommitOid)) fail(`${field}.headCommitOid`);
  text(item.branchName, `${field}.branchName`, 4096, fail, true);
  number(item.capturedAtUnixMs, `${field}.capturedAtUnixMs`, fail);
  digest(item.treeSha256, `${field}.treeSha256`, fail);
  digest(item.indexSha256, `${field}.indexSha256`, fail);
}
export function normalizeAgentTurnChanges(value: unknown, fail: Fail, conversationId: string, requestId: string): AgentTurnChanges {
  const item = record(value, "agentTurnChanges", fail);
  if (item.schemaVersion !== 1 || item.conversationId !== conversationId || item.requestId !== requestId) fail("agentTurnChanges.identity");
  for (const field of ["conversationId", "requestId", "sessionId", "workspaceId"]) validateAgentTurnId(item[field], fail);
  text(item.repositoryId, "agentTurnChanges.repositoryId", 4096, fail);
  digest(item.sourceContextSha256, "agentTurnChanges.sourceContextSha256", fail);
  if (!["capturing", "ready", "incomplete", "unavailable"].includes(String(item.state))) fail("agentTurnChanges.state");
  if (!["normal", "recovered"].includes(String(item.observation))) fail("agentTurnChanges.observation");
  number(item.startedAtUnixMs, "agentTurnChanges.startedAtUnixMs", fail);
  if (item.completedAtUnixMs !== undefined) number(item.completedAtUnixMs, "agentTurnChanges.completedAtUnixMs", fail);
  for (const field of ["before", "after"]) if (item[field] !== undefined) checkpoint(item[field], `agentTurnChanges.${field}`, fail);
  if (item.state === "ready" && (!item.before || !item.after)) fail("agentTurnChanges.checkpoints");
  if (!Array.isArray(item.files) || item.files.length > 2048) fail("agentTurnChanges.files");
  const paths = new Set<string>();
  for (const raw of item.files as unknown[]) {
    const file = record(raw, "agentTurnChanges.file", fail);
    text(file.filePath, "agentTurnChanges.file.filePath", 4096, fail);
    if (paths.has(file.filePath)) fail("agentTurnChanges.file.duplicate");
    paths.add(file.filePath);
    if (!["added", "modified", "deleted", "typeChanged"].includes(String(file.status))) fail("agentTurnChanges.file.status");
    for (const field of ["beforeSha256", "afterSha256"]) if (file[field] !== undefined) digest(file[field], `agentTurnChanges.file.${field}`, fail);
    if (typeof file.preExistingChange !== "boolean" || file.undoSupported !== false) fail("agentTurnChanges.file.support");
    if (file.detail !== undefined) text(file.detail, "agentTurnChanges.file.detail", 2048, fail, true);
  }
  number(item.omittedFileCount, "agentTurnChanges.omittedFileCount", fail);
  text(item.detail, "agentTurnChanges.detail", 2048, fail, true);
  text(item.patch, "agentTurnChanges.patch", 1024 * 1024, fail, true);
  if (typeof item.patchTruncated !== "boolean") fail("agentTurnChanges.patchTruncated");
  return item as unknown as AgentTurnChanges;
}
