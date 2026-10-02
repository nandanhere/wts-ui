import { validateAgentTurnId } from "./agentTurnChanges";
import type { AgentProvider, GitlabReviewDiscussionComment, GitlabReviewDiscussion } from "./wtsClient";

export interface RegionCapture { mimeType: "image/png"; dataUrl: string; width: number; height: number }
export type AgentConversationSource = {
  kind: "ui"; route: string; calloutId: string; label: string;
  selectedText?: string; context?: string; capture?: RegionCapture;
} | {
  kind: "workItem"; workSetId: string; taskId: string; label: string; originConversationId: string; originRequestId: string;
} | {
  kind: "gitlabDiscussion"; workspaceId: string; repositoryId: string;
  providerRepositoryId?: string; iid: number; discussionId: string; scopeId?: string;
  title?: string; sourceBranch?: string; targetBranch?: string; filePath?: string;
  side?: "additions" | "deletions"; line?: number;
  position?: GitlabReviewDiscussion["position"]; comments: GitlabReviewDiscussionComment[];
};
export interface CreateAgentConversationRequest {
  requestId: string; provider: AgentProvider; source: AgentConversationSource;
}
export interface SendAgentConversationMessageRequest { requestId: string; body: string }
export interface UpdateAgentConversationMessageRequest { requestId: string; expectedBody: string; body: string }
export interface CancelAgentConversationMessageRequest { requestId: string; expectedBody: string }
export interface AgentConversationMessage {
  messageId: string; requestId?: string; role: "user" | "assistant" | "system";
  body: string; status: "pending" | "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled";
  createdAtUnixMs: number; sessionId?: string; error?: string; progress?: string; diagnostic?: string;
  queueSequence?: number; queuePosition?: number; submittedBody?: string; lastMutationRequestId?: string;
}
export interface AgentConversation {
  schemaVersion: 1; conversationId: string; workspaceId: string; workspaceDisplayPath: string;
  repositoryId: string; provider: AgentProvider; source: AgentConversationSource;
  revision: number; createdAtUnixMs: number; updatedAtUnixMs: number;
  messages: AgentConversationMessage[]; activeSessionId?: string;
  preview?: { url: string; repositoryId: string };
}
export interface AgentConversationList { schemaVersion: 1; conversations: AgentConversation[] }

const providers = ["codex", "openCode", "hermes", "copilot"];
type Fail = (field: string) => never;
function record(value: unknown, fail: Fail): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("conversation");
  return value as Record<string, unknown>;
}
function string(value: unknown, fail: Fail, max = 16_384, empty = false): asserts value is string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || [...value].length > max) fail("conversation.text");
}
function integer(value: unknown, fail: Fail) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail("conversation.number");
}
export function validateConversationSource(value: unknown, fail: Fail): AgentConversationSource {
  const source = record(value, fail);
  if (source.kind === "ui") {
    string(source.route, fail, 2_048); string(source.calloutId, fail, 256); string(source.label, fail, 512);
    if (source.selectedText !== undefined) string(source.selectedText, fail, 16_384);
    if (source.context !== undefined) string(source.context, fail, 16_384);
    if (source.capture !== undefined) normalizeRegionCapture(source.capture, fail);
  } else if (source.kind === "workItem") {
    for (const field of ["workSetId", "taskId", "originConversationId", "originRequestId"]) validateAgentTurnId(source[field], fail);
    string(source.label, fail, 160);
    if (new TextEncoder().encode(source.label).length > 160 || /[\u0000-\u001f\u007f-\u009f]/u.test(source.label)) fail("conversation.workItem.label");
  } else if (source.kind === "gitlabDiscussion") {
    for (const field of ["workspaceId", "repositoryId", "discussionId"]) string(source[field], fail, 512);
    integer(source.iid, fail); if (!source.iid) fail("conversation.iid");
    for (const field of ["providerRepositoryId", "scopeId", "title", "sourceBranch", "targetBranch", "filePath"]) {
      if (source[field] !== undefined) string(source[field], fail, 2_048);
    }
    if (source.side !== undefined && !["additions", "deletions"].includes(String(source.side))) fail("conversation.side");
    if (source.line !== undefined) { integer(source.line, fail); if (!source.line) fail("conversation.line"); }
    if (!Array.isArray(source.comments) || !source.comments.length || source.comments.length > 200) fail("conversation.comments");
    for (const item of source.comments as unknown[]) {
      const comment = record(item, fail);
      integer(comment.id, fail); if (!comment.id) fail("conversation.comment.id"); string(comment.body, fail, 16_384);
      string(comment.authorLogin, fail, 256); string(comment.createdAt, fail, 512);
    }
    if (source.position !== undefined) {
      const position = record(source.position, fail);
      for (const key of ["baseCommitOid", "startCommitOid", "headCommitOid"]) {
        if (typeof position[key] !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(position[key])) fail("conversation.position");
      }
    }
  } else fail("conversation.source");
  return source as unknown as AgentConversationSource;
}
export function normalizeRegionCapture(value: unknown, fail: Fail): RegionCapture {
  const capture = record(value, fail);
  integer(capture.width, fail); integer(capture.height, fail);
  if (!capture.width || !capture.height || Number(capture.width) > 4_096 || Number(capture.height) > 4_096 ||
    Number(capture.width) * Number(capture.height) > 8_388_608 || capture.mimeType !== "image/png" ||
    typeof capture.dataUrl !== "string" || capture.dataUrl.length > 2_800_000 ||
    !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(capture.dataUrl)) fail("conversation.capture");
  return capture as unknown as RegionCapture;
}
export function validateCreateConversation(request: CreateAgentConversationRequest, fail: Fail) {
  string(request.requestId, fail, 128);
  if (!providers.includes(request.provider)) fail("conversation.provider");
  validateConversationSource(request.source, fail);
  if (request.source.kind === "workItem") fail("conversation.source.hostOnly");
  return request;
}
export function validateSendConversation(request: SendAgentConversationMessageRequest, fail: Fail) {
  string(request.requestId, fail, 128); string(request.body, fail);
  return request;
}
export function validateCancelConversationMessage(request: CancelAgentConversationMessageRequest, fail: Fail) {
  string(request.requestId, fail, 128); string(request.expectedBody, fail);
  return request;
}
export function validateUpdateConversationMessage(request: UpdateAgentConversationMessageRequest, fail: Fail) {
  validateCancelConversationMessage(request, fail); string(request.body, fail);
  return request;
}
export function normalizeAgentConversation(value: unknown, fail: Fail, expectedId?: string): AgentConversation {
  const data = record(value, fail);
  if (data.schemaVersion !== 1) fail("conversation.schemaVersion");
  for (const field of ["conversationId", "workspaceId", "repositoryId", "workspaceDisplayPath"]) string(data[field], fail, 4_096);
  if (expectedId !== undefined && data.conversationId !== expectedId) fail("conversation.conversationId");
  if (!providers.includes(String(data.provider))) fail("conversation.provider");
  for (const field of ["revision", "createdAtUnixMs", "updatedAtUnixMs"]) integer(data[field], fail);
  const source = validateConversationSource(data.source, fail);
  if (source.kind === "gitlabDiscussion" && (source.workspaceId !== data.workspaceId || source.repositoryId !== data.repositoryId)) fail("conversation.source.workspaceId");
  if (!Array.isArray(data.messages) || data.messages.length > 2_000) fail("conversation.messages");
  const ids = new Set<string>();
  for (const item of data.messages as unknown[]) {
    const message = record(item, fail);
    string(message.messageId, fail, 512); string(message.body, fail, 16_777_216, true);
    if (ids.has(message.messageId)) fail("conversation.messageId"); ids.add(message.messageId);
    if (!["user", "assistant", "system"].includes(String(message.role)) ||
      !["pending", "queued", "running", "completed", "failed", "interrupted", "cancelled"].includes(String(message.status))) fail("conversation.message");
    integer(message.createdAtUnixMs, fail);
    for (const field of ["requestId", "sessionId", "error"]) if (message[field] !== undefined) string(message[field], fail);
    for (const [field, limit] of [["progress", 65_536], ["diagnostic", 16_384]] as const) if (message[field] !== undefined) {
      string(message[field], fail, limit);
      if (new TextEncoder().encode(message[field]).byteLength > limit) fail(`conversation.${field}`);
    }
    for (const field of ["queueSequence", "queuePosition"]) if (message[field] !== undefined) {
      integer(message[field], fail); if (!message[field]) fail(`conversation.${field}`);
    }
    if (message.submittedBody !== undefined) string(message.submittedBody, fail);
    if (message.lastMutationRequestId !== undefined) string(message.lastMutationRequestId, fail, 128);
    if (message.role !== "user" && (message.status === "queued" || message.status === "cancelled" ||
      message.queueSequence !== undefined || message.queuePosition !== undefined || message.submittedBody !== undefined ||
      message.lastMutationRequestId !== undefined)) fail("conversation.message.queue");
    if (message.queuePosition !== undefined && message.status !== "queued") fail("conversation.message.queuePosition");
  }
  if (data.activeSessionId !== undefined) string(data.activeSessionId, fail, 512);
  if (data.preview !== undefined) {
    const preview = record(data.preview, fail); string(preview.url, fail, 2_048);
    let url: URL; try { url = new URL(preview.url); } catch { return fail("conversation.preview.url"); }
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password ||
      preview.repositoryId !== data.repositoryId) fail("conversation.preview");
  }
  return data as unknown as AgentConversation;
}
export function normalizeConversationList(value: unknown, fail: Fail): AgentConversationList {
  const data = record(value, fail);
  if (data.schemaVersion !== 1 || !Array.isArray(data.conversations) || data.conversations.length > 4_096) fail("conversations");
  return { schemaVersion: 1, conversations: (data.conversations as unknown[]).map((item) => normalizeAgentConversation(item, fail)).filter(conversation => conversation.source.kind !== "workItem") };
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}
export function matchAcceptedMessage(result: AgentConversation, request: SendAgentConversationMessageRequest, fail: Fail) {
  if (!result.messages.some((message) => message.role === "user" && message.requestId === request.requestId &&
    (message.submittedBody ?? message.body) === request.body)) fail("conversation.acceptedMessage");
  return result;
}
export function matchMutatedMessage(result: AgentConversation, messageId: string,
  request: CancelAgentConversationMessageRequest | UpdateAgentConversationMessageRequest, fail: Fail) {
  const message = result.messages.find((item) => item.messageId === messageId && item.role === "user");
  if (!message || message.lastMutationRequestId !== request.requestId ||
    ("body" in request ? message.body !== request.body : message.status !== "cancelled")) fail("conversation.mutatedMessage");
  return result;
}
export function matchCreatedConversation(result: AgentConversation, request: CreateAgentConversationRequest, fail: Fail) {
  const expected = request.source;
  const actual = result.source;
  if (result.conversationId !== request.requestId || result.provider !== request.provider || canonical(expected) !== canonical(actual)) fail("conversation.source");
  return result;
}
