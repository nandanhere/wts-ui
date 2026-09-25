import type { GitlabDiscussions, GitlabMergeRequestInbox, WorkspaceClient, WorkspaceEvidence, WorkspaceVerificationCheckResult, WorkspaceVerificationResult, WorkspaceVerificationSummary } from "../../lib/wtsClient";
import type { AgentConversationList } from "../../lib/agentConversations";
import { buildFeedbackTimeline } from "../../lib/agentFeedbackTimeline";
import { gitlabCommentsAfterOwnReply, gitlabCommentRevision, gitlabCommentReadChecker, subscribeGitlabDiscussionReads } from "./gitlabDiscussions";
import { loadWorkspaceGitlabMergeRequests } from "./gitlabMergeRequestDiscovery";

export interface WorkspaceAttentionWorkspace { workspaceId: string; materialized: boolean }

export type WorkspaceAttentionKind = "agent" | "verification" | "gitlab";
export type WorkspaceAttentionTarget =
  | { kind: "agent"; conversationId: string; requestId: string; messageId: string; repositoryId: string; sessionId?: string }
  | { kind: "verification"; checkId: string; planRevision: number; runStartedAt: number; repositoryId?: string }
  | { kind: "gitlab"; repositoryId: string; iid: number; discussionId: string; scopeId: string; filePath?: string };
export interface WorkspaceAttentionItem {
  id: string;
  revision: string;
  workspaceId: string;
  kind: WorkspaceAttentionKind;
  label: string;
  detail: string;
  occurredAt: number;
  count: number;
  target: WorkspaceAttentionTarget;
}
export interface WorkspaceAttentionHistoryItem extends WorkspaceAttentionItem { resolvedAt: number }
export interface WorkspaceAttentionSource {
  status: "idle" | "loading" | "fresh" | "stale" | "error";
  refreshing: boolean;
  updatedAt: number | null;
  error: string;
  detail: string;
}
export interface WorkspaceAttentionSnapshot {
  items: WorkspaceAttentionItem[];
  history: WorkspaceAttentionHistoryItem[];
  sources: Record<string, Record<WorkspaceAttentionKind, WorkspaceAttentionSource>>;
  inboxes: Record<string, GitlabMergeRequestInbox>;
  refreshing: boolean;
}
export interface WorkspaceAttentionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): WorkspaceAttentionSnapshot;
  refresh(workspaces: readonly WorkspaceAttentionWorkspace[], options?: { force?: boolean }): Promise<void>;
  acknowledge(itemId: string, revision: string): void;
}

const STORAGE_KEY = "wts.workspace-attention.v1";
const DECISIONS_STORAGE_KEY = "wts.workspace-agent-reviewed.v1";
const REVIEWS_STORAGE_KEY = "wts.workspace-attention-reviewed.v1";
const MAX_REVIEWS = 4096;
const REVIEW_SAVE_ERROR = "WTS could not save the review state. Free local storage, then select Reviewed again.";
const MAX_RECORDS = 1024;
const MAX_WORKSPACES = 96;
const MAX_THREADS = 4096;
const MAX_AGE_MS = 30_000;
const kinds: WorkspaceAttentionKind[] = ["agent", "verification", "gitlab"];
const stores = new WeakMap<WorkspaceClient, AttentionStore>();
type SavedItem = Omit<WorkspaceAttentionItem, "label" | "detail"> & { resolvedAt?: number };
type VerificationSummary = Pick<WorkspaceEvidence, "verificationPlan" | "verificationResult" | "verificationHistory">;
interface ThreadSummary {
  item: WorkspaceAttentionItem;
  comments: { id: number; revision: string }[];
  fetchedAt: number;
}
interface AgentResultReviewed { conversationId: string; requestId: string; sessionId: string }
function decisionKey(decision: AgentResultReviewed): string { return JSON.stringify([decision.conversationId, decision.requestId, decision.sessionId]); }
function readDecisions(): Set<string> {
  try {
    const text = localStorage.getItem(DECISIONS_STORAGE_KEY);
    if (!text || text.length > 500_000) return new Set();
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.slice(-512).filter((key): key is string => {
      if (typeof key !== "string" || key.length > 8192) return false;
      try { const parts: unknown = JSON.parse(key); return Array.isArray(parts) && parts.length === 3 && parts.every(part => typeof part === "string" && part.length > 0 && part.length <= 2048); } catch { return false; }
    }));
  } catch { return new Set(); }
}
function readReviews(): Set<string> {
  try {
    const text = localStorage.getItem(REVIEWS_STORAGE_KEY);
    if (!text || text.length > 2_000_000) return new Set();
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return new Set();
    return new Set(value.slice(-MAX_REVIEWS).filter((key): key is string => {
      if (typeof key !== "string" || key.length > 9000) return false;
      try {
        const parts: unknown = JSON.parse(key);
        return Array.isArray(parts) && parts.length === 2 && typeof parts[0] === "string" && parts[0].length <= 8192 && typeof parts[1] === "string" && /^\d+:[a-f0-9]{2,16}$/.test(parts[1]);
      } catch { return false; }
    }));
  } catch { return new Set(); }
}

function hash(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index++) {
    const char = text.charCodeAt(index);
    first = Math.imul(first ^ char, 0x01000193);
    second = Math.imul(second ^ char, 0x85ebca6b);
  }
  return `${text.length}:${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}
function recordKey(item: Pick<WorkspaceAttentionItem, "id" | "revision">): string { return JSON.stringify([item.id, item.revision]); }
function idle(): WorkspaceAttentionSource { return { status: "idle", refreshing: false, updatedAt: null, error: "", detail: "" }; }
function restoredLabel(item: SavedItem): string {
  return item.target.kind === "agent" ? "Agent result" : item.target.kind === "verification" ? `Check ${item.target.checkId}` : `MR !${item.target.iid} conversation`;
}
function savedItem(item: WorkspaceAttentionItem, resolvedAt?: number): SavedItem {
  const { id, revision, workspaceId, kind, occurredAt, count, target } = item;
  return { id, revision, workspaceId, kind, occurredAt, count, target, ...(resolvedAt === undefined ? {} : { resolvedAt }) };
}
function readSaved(): SavedItem[] {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text || text.length > 2_000_000) return [];
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    const boundedText = (value: unknown, max = 2048): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
    const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
    return value.slice(-MAX_RECORDS).flatMap(raw => {
      if (!raw || typeof raw !== "object") return [];
      const item = raw as SavedItem;
      if (!boundedText(item.id, 8192) || !boundedText(item.revision, 256) || !boundedText(item.workspaceId) || !kinds.includes(item.kind) || !integer(item.occurredAt) || !integer(item.count) || (item.resolvedAt !== undefined && !integer(item.resolvedAt))) return [];
      const target = item.target;
      if (!target || target.kind !== item.kind) return [];
      let cleanTarget: WorkspaceAttentionTarget;
      if (target.kind === "agent" && boundedText(target.conversationId) && boundedText(target.requestId) && boundedText(target.messageId) && boundedText(target.repositoryId)) {
        cleanTarget = { kind: "agent", conversationId: target.conversationId, requestId: target.requestId, messageId: target.messageId, repositoryId: target.repositoryId, ...(boundedText(target.sessionId) ? { sessionId: target.sessionId } : {}) };
      } else if (target.kind === "verification" && boundedText(target.checkId, 128) && integer(target.planRevision) && integer(target.runStartedAt) && (target.repositoryId === undefined || boundedText(target.repositoryId))) {
        cleanTarget = { kind: "verification", checkId: target.checkId, planRevision: target.planRevision, runStartedAt: target.runStartedAt, ...(target.repositoryId ? { repositoryId: target.repositoryId } : {}) };
      } else if (target.kind === "gitlab" && boundedText(target.repositoryId) && boundedText(target.discussionId) && /^[a-f0-9]{64}$/.test(target.scopeId) && integer(target.iid) && target.iid > 0 && (target.filePath === undefined || boundedText(target.filePath, 4096))) {
        cleanTarget = { kind: "gitlab", repositoryId: target.repositoryId, discussionId: target.discussionId, scopeId: target.scopeId, iid: target.iid, ...(target.filePath ? { filePath: target.filePath } : {}) };
      } else return [];
      return [savedItem({ ...item, label: "", detail: "", target: cleanTarget }, item.resolvedAt)];
    });
  } catch { return []; }
}

class AttentionStore implements WorkspaceAttentionStore {
  private snapshot: WorkspaceAttentionSnapshot = { items: [], history: [], sources: {}, inboxes: {}, refreshing: false };
  private readonly listeners = new Set<() => void>();
  private readonly records = new Map<string, SavedItem>();
  private readonly display = new Map<string, WorkspaceAttentionItem>();
  private readonly threads = new Map<string, ThreadSummary>();
  private readonly decisions = readDecisions();
  private reviews = readReviews();
  private readonly conversationRevisions = new Map<string, number>();
  private readonly checkRevisions = new Map<string, number>();
  private readonly planRevisions = new Map<string, number>();
  private readonly discoveryRevisions = new Map<string, number>();
  private readonly discussionRevisions = new Map<string, number>();
  private workspaceIds = new Set<string>();
  private unsubscribeReads?: () => void;
  private pending?: Promise<void>;
  private queued?: { workspaces: readonly WorkspaceAttentionWorkspace[]; force?: boolean };
  private queuedPromise?: Promise<void>;
  private lastRefresh = -Infinity;
  private lastScope = "";
  private activeReads = 0;
  private readonly readQueue: (() => void)[] = [];
  private recordsChanged = false;
  private itemsChanged = true;
  private notificationFrame?: number;

  constructor(private readonly client: WorkspaceClient) {
    for (const item of readSaved()) this.records.set(recordKey(item), item);
  }

  getSnapshot = (): WorkspaceAttentionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.unsubscribeReads) this.unsubscribeReads = subscribeGitlabDiscussionReads(() => { this.syncReadMarkers(); this.publish(true); });
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { this.unsubscribeReads?.(); this.unsubscribeReads = undefined; }
    };
  };

  acknowledge = (id: string, revision: string): void => {
    const item = this.snapshot.items.find(value => value.id === id && value.revision === revision && value.kind === "agent");
    if (!item) return;
    const key = recordKey(item);
    const reviews = [...new Set([...this.reviews, ...readReviews()].filter(value => value !== key)), key].slice(-MAX_REVIEWS);
    let serialized = JSON.stringify(reviews);
    while (serialized.length > 2_000_000 && reviews.length > 1) { reviews.shift(); serialized = JSON.stringify(reviews); }
    try { localStorage.setItem(REVIEWS_STORAGE_KEY, serialized); }
    catch {
      this.failSource(item.workspaceId, "agent", REVIEW_SAVE_ERROR, false);
      this.publish(true);
      return;
    }
    this.reviews = new Set(reviews);
    this.resolve(item);
    const source = this.snapshot.sources[item.workspaceId]?.agent;
    if (source?.error === REVIEW_SAVE_ERROR) this.setSource(item.workspaceId, "agent", { ...source, error: "", status: source.updatedAt !== null && Date.now() - source.updatedAt < MAX_AGE_MS ? "fresh" : "stale" });
    this.publish(true);
  };

  reviewAgent(decision: AgentResultReviewed): void {
    this.decisions.add(decisionKey(decision));
    while (this.decisions.size > 512) this.decisions.delete(this.decisions.values().next().value!);
    try { localStorage.setItem(DECISIONS_STORAGE_KEY, JSON.stringify([...this.decisions])); } catch { /* Retain this decision in the current view. */ }
    this.resolveWhere(item => item.target.kind === "agent" && item.target.conversationId === decision.conversationId && item.target.requestId === decision.requestId && item.target.sessionId === decision.sessionId);
    this.publish(true);
  }

  observeVerification(summary: WorkspaceVerificationSummary): void {
    if (summary.workspaceId !== summary.verificationPlan.workspaceId || summary.workspaceId !== summary.verificationResult.workspaceId) return;
    this.applyVerification(summary.workspaceId, summary);
    if (this.workspaceIds.has(summary.workspaceId)) this.finishSource(summary.workspaceId, "verification");
    this.publish(true);
  }

  refresh = (workspaces: readonly WorkspaceAttentionWorkspace[], options: { force?: boolean } = {}): Promise<void> => {
    const scope = JSON.stringify(workspaces.map(item => [item.workspaceId, item.materialized]).sort());
    if (this.pending) {
      if (scope === this.lastScope && !this.queued) return this.pending;
      this.queued = { workspaces: [...workspaces], force: options.force };
      this.applyScope(workspaces);
      this.publish(true);
      this.queuedPromise ??= this.pending.then(() => {
        const next = this.queued!;
        this.queued = undefined;
        this.queuedPromise = undefined;
        return this.refresh(next.workspaces, { force: next.force });
      });
      return this.queuedPromise;
    }
    if (!options.force && scope === this.lastScope && Date.now() - this.lastRefresh < MAX_AGE_MS) return Promise.resolve();
    this.lastScope = scope;
    this.applyScope(workspaces);
    const visible = workspaces.slice(0, MAX_WORKSPACES);
    for (const workspace of workspaces) {
      for (const kind of kinds) this.startSource(workspace.workspaceId, kind);
    }
    this.snapshot = { ...this.snapshot, refreshing: true };
    this.publish();
    const run = async () => {
      const reads: Promise<void>[] = [this.refreshAgents(visible)];
      for (const workspace of visible) {
        if (!workspace.materialized) {
          this.finishSource(workspace.workspaceId, "verification", "Create this workspace to check verification.");
          this.finishSource(workspace.workspaceId, "gitlab", "Create this workspace to check merge requests.");
          continue;
        }
        reads.push(this.refreshVerification(workspace.workspaceId), this.refreshGitlab(workspace.workspaceId, options.force));
      }
      for (const workspace of workspaces.slice(MAX_WORKSPACES)) {
        for (const kind of kinds) this.failSource(workspace.workspaceId, kind, "WTS checks up to 96 workspaces on the board. Open this workspace to check its state.");
      }
      await Promise.all(reads);
      this.lastRefresh = Date.now();
    };
    this.pending = run().finally(() => {
      this.pending = undefined;
      this.snapshot = { ...this.snapshot, refreshing: false };
      this.syncReadMarkers();
      this.publish(true);
    });
    return this.pending;
  };

  private applyScope(workspaces: readonly WorkspaceAttentionWorkspace[]): void {
    const changed = this.workspaceIds.size !== workspaces.length || workspaces.some(item => !this.workspaceIds.has(item.workspaceId));
    this.workspaceIds = new Set(workspaces.map(item => item.workspaceId));
    this.snapshot = { ...this.snapshot,
      sources: Object.fromEntries(workspaces.map(workspace => [workspace.workspaceId, this.snapshot.sources[workspace.workspaceId] ?? { agent: idle(), verification: idle(), gitlab: idle() }])),
      inboxes: Object.fromEntries(Object.entries(this.snapshot.inboxes).filter(([id]) => this.workspaceIds.has(id))),
    };
    for (const [id, thread] of this.threads) if (!this.workspaceIds.has(thread.item.workspaceId)) this.threads.delete(id);
    for (const id of this.planRevisions.keys()) if (!this.workspaceIds.has(id)) this.planRevisions.delete(id);
    for (const id of this.discoveryRevisions.keys()) if (!this.workspaceIds.has(id)) this.discoveryRevisions.delete(id);
    if (changed) this.itemsChanged = true;
  }

  private read<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.activeReads++;
        Promise.resolve().then(operation).then(resolve, reject).finally(() => {
          this.activeReads--;
          this.readQueue.shift()?.();
        });
      };
      if (this.activeReads < 4) start(); else this.readQueue.push(start);
    });
  }

  private startSource(workspaceId: string, kind: WorkspaceAttentionKind): void {
    const previous = this.snapshot.sources[workspaceId]![kind];
    this.setSource(workspaceId, kind, { ...previous, status: previous.updatedAt === null ? "loading" : Date.now() - previous.updatedAt >= MAX_AGE_MS ? "stale" : previous.status, refreshing: true, error: "" });
  }
  private setSource(workspaceId: string, kind: WorkspaceAttentionKind, source: WorkspaceAttentionSource): void {
    if (!this.workspaceIds.has(workspaceId)) return;
    this.snapshot = { ...this.snapshot, sources: { ...this.snapshot.sources, [workspaceId]: { ...this.snapshot.sources[workspaceId]!, [kind]: source } } };
  }
  private finishSource(workspaceId: string, kind: WorkspaceAttentionKind, detail = "", stale = false, updatedAt = Date.now(), publish = true): void {
    this.setSource(workspaceId, kind, { status: stale ? "stale" : "fresh", refreshing: false, updatedAt, error: "", detail });
    if (publish) this.publish();
  }
  private failSource(workspaceId: string, kind: WorkspaceAttentionKind, error: string, publish = true): void {
    if (!this.workspaceIds.has(workspaceId)) return;
    const previous = this.snapshot.sources[workspaceId]![kind];
    this.setSource(workspaceId, kind, { ...previous, status: previous.updatedAt === null ? "error" : "stale", refreshing: false, error });
    if (publish) this.publish();
  }
  private remember(item: WorkspaceAttentionItem): void {
    const key = recordKey(item);
    const previous = this.display.get(key);
    if (!previous || previous.label !== item.label || previous.count !== item.count || previous.detail !== item.detail) {
      this.display.set(key, item);
      this.itemsChanged = true;
    }
    if (!this.records.has(key)) { this.records.set(key, savedItem(item)); this.recordsChanged = true; this.itemsChanged = true; }
    if (item.kind === "agent" && this.reviews.has(key)) this.resolve(item);
  }
  private resolve(item: WorkspaceAttentionItem): void {
    const key = recordKey(item);
    const previous = this.records.get(key);
    if (previous?.resolvedAt !== undefined) return;
    this.records.set(key, savedItem(item, Date.now()));
    this.recordsChanged = true;
    this.itemsChanged = true;
  }
  private resolveWhere(match: (item: SavedItem) => boolean): void {
    for (const item of this.records.values()) {
      if (item.resolvedAt === undefined && match(item)) this.resolve(this.display.get(recordKey(item)) ?? { ...item, label: restoredLabel(item), detail: "" });
    }
  }
  private publish(immediate = false): void {
    if (this.records.size > MAX_RECORDS) {
      const sorted = [...this.records.entries()].sort((a, b) => (a[1].resolvedAt === undefined ? 1 : 0) - (b[1].resolvedAt === undefined ? 1 : 0) || a[1].occurredAt - b[1].occurredAt);
      for (const [key] of sorted.slice(0, this.records.size - MAX_RECORDS)) { this.records.delete(key); this.display.delete(key); }
    }
    if (this.itemsChanged) {
      const items: WorkspaceAttentionItem[] = [];
      const history: WorkspaceAttentionHistoryItem[] = [];
      for (const record of this.records.values()) {
        if (!this.workspaceIds.has(record.workspaceId)) continue;
        const item = this.display.get(recordKey(record)) ?? { ...record, label: restoredLabel(record), detail: "Saved from an earlier check." };
        if (record.resolvedAt === undefined) items.push(item); else history.push({ ...item, resolvedAt: record.resolvedAt });
      }
      items.sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id));
      history.sort((a, b) => b.resolvedAt - a.resolvedAt);
      this.snapshot = { ...this.snapshot, items, history: history.slice(0, 128) };
      this.itemsChanged = false;
    }
    if (immediate) {
      if (this.notificationFrame !== undefined) window.cancelAnimationFrame(this.notificationFrame);
      this.notificationFrame = undefined;
      this.notify();
    } else if (this.notificationFrame === undefined) {
      this.notificationFrame = window.requestAnimationFrame(() => { this.notificationFrame = undefined; this.notify(); });
    }
  }
  private notify(): void {
    if (this.recordsChanged) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.records.values()])); } catch { /* The current view retains the metadata when storage is full. */ }
      this.recordsChanged = false;
    }
    for (const listener of this.listeners) listener();
  }

  private async refreshAgents(workspaces: readonly WorkspaceAttentionWorkspace[]): Promise<void> {
    try {
      if (!this.client.listAgentConversations) throw new Error("unsupported");
      const list: AgentConversationList = await this.read(() => this.client.listAgentConversations!());
      const conversations = list.conversations.filter(conversation => {
        if (conversation.revision < (this.conversationRevisions.get(conversation.conversationId) ?? -1)) return false;
        this.conversationRevisions.set(conversation.conversationId, conversation.revision);
        return this.workspaceIds.has(conversation.workspaceId);
      });
      while (this.conversationRevisions.size > 4096) this.conversationRevisions.delete(this.conversationRevisions.keys().next().value!);
      for (const { conversation, message, request } of buildFeedbackTimeline(conversations).timeline) {
        if (!this.workspaceIds.has(conversation.workspaceId) || message.role !== "assistant" || message.status !== "completed" || !request?.requestId) continue;
        const item: WorkspaceAttentionItem = {
          id: JSON.stringify(["agent", conversation.workspaceId, conversation.conversationId, message.messageId]),
          revision: hash(JSON.stringify([message.body, message.sessionId, message.createdAtUnixMs])),
          workspaceId: conversation.workspaceId, kind: "agent", label: conversation.source.kind === "ui" || conversation.source.kind === "workItem" ? conversation.source.label : conversation.source.title ?? `MR !${conversation.source.iid} result`,
          detail: "Agent result awaits review.", occurredAt: message.createdAtUnixMs, count: 1,
          target: { kind: "agent", conversationId: conversation.conversationId, requestId: request.requestId, messageId: message.messageId, repositoryId: conversation.repositoryId, ...(message.sessionId ?? request.sessionId ? { sessionId: message.sessionId ?? request.sessionId } : {}) },
        };
        this.resolveWhere(previous => previous.id === item.id && previous.revision !== item.revision);
        this.remember(item);
        if (item.target.kind === "agent" && item.target.sessionId && this.decisions.has(decisionKey({ conversationId: item.target.conversationId, requestId: item.target.requestId, sessionId: item.target.sessionId }))) this.resolve(item);
      }
      const updatedAt = Date.now();
      for (const workspace of workspaces) this.finishSource(workspace.workspaceId, "agent", "Recent results from up to 50 saved conversations. The board keeps up to 1,024 items and 4,096 review choices.", false, updatedAt, false);
      this.publish();
    } catch {
      for (const workspace of workspaces) this.failSource(workspace.workspaceId, "agent", "WTS could not refresh agent results. Select Refresh status to retry.", false);
      this.publish();
    }
  }

  private async refreshVerification(workspaceId: string): Promise<void> {
    try {
      if (!this.client.getWorkspaceVerificationSummary) {
        this.failSource(workspaceId, "verification", "This WTS host cannot read verification summaries. Open Verify to check this workspace.");
        return;
      }
      const evidence = await this.read(() => this.client.getWorkspaceVerificationSummary!(workspaceId));
      if (evidence) {
        if (evidence.workspaceId !== workspaceId || evidence.verificationPlan.workspaceId !== workspaceId || evidence.verificationResult.workspaceId !== workspaceId) throw new Error("identity");
        this.applyVerification(workspaceId, evidence);
      }
      this.finishSource(workspaceId, "verification");
    } catch { this.failSource(workspaceId, "verification", "WTS could not refresh verification. Select Refresh status to retry."); }
  }
  private applyVerification(workspaceId: string, evidence: VerificationSummary): void {
    if (evidence.verificationPlan.revision < (this.planRevisions.get(workspaceId) ?? -1)) return;
    this.planRevisions.set(workspaceId, evidence.verificationPlan.revision);
    const checks = new Map(evidence.verificationPlan.checks.map(check => [check.id, check]));
    const latest = new Map<string, { check: WorkspaceVerificationCheckResult; run: WorkspaceVerificationResult }>();
    const runs = [...(evidence.verificationHistory ?? []), evidence.verificationResult].filter(run => run.workspaceId === workspaceId && run.planRevision === evidence.verificationPlan.revision)
      .sort((a, b) => (a.startedAtUnixMs ?? 0) - (b.startedAtUnixMs ?? 0));
    for (const run of runs) for (const check of run.checks) if (!["skipped", "pending", "running", "cancelled"].includes(check.status)) latest.set(check.checkId, { check, run });
    this.resolveWhere(item => item.workspaceId === workspaceId && item.target.kind === "verification" && (!checks.has(item.target.checkId) || item.target.planRevision !== evidence.verificationPlan.revision));
    for (const [checkId, { check, run }] of latest) {
      const plan = checks.get(checkId);
      if (!plan) continue;
      const id = JSON.stringify(["verification", workspaceId, checkId, run.planRevision]);
      const startedAt = run.startedAtUnixMs ?? check.startedAtUnixMs ?? 0;
      if (startedAt < (this.checkRevisions.get(id) ?? -1)) continue;
      this.checkRevisions.set(id, startedAt);
      while (this.checkRevisions.size > 8192) this.checkRevisions.delete(this.checkRevisions.keys().next().value!);
      if (check.status === "passed") {
        this.resolveWhere(item => item.id === id && item.target.kind === "verification" && item.target.runStartedAt <= startedAt);
      } else if (check.status === "failed" || check.status === "timedOut") {
        const revision = hash(JSON.stringify([startedAt, check.completedAtUnixMs, check.status]));
        this.resolveWhere(item => item.id === id && item.revision !== revision && item.target.kind === "verification" && item.target.runStartedAt <= startedAt);
        this.remember({ id, revision, workspaceId, kind: "verification", label: plan.label, detail: check.status === "timedOut" ? "The check exceeded its time limit." : "The check failed.", count: 1,
          occurredAt: check.completedAtUnixMs ?? startedAt,
          target: { kind: "verification", checkId, planRevision: run.planRevision, runStartedAt: startedAt, ...(plan.repositoryId ? { repositoryId: plan.repositoryId } : {}) } });
      }
    }
  }

  private async refreshGitlab(workspaceId: string, force = false): Promise<void> {
    try {
      const inbox = await this.read(() => loadWorkspaceGitlabMergeRequests(this.client, workspaceId, { force }));
      if (!this.workspaceIds.has(workspaceId)) return;
      if (inbox.state !== "fresh" && inbox.state !== "stale") throw new Error("unavailable");
      if ((inbox.fetchedAtUnixMs ?? 0) < (this.discoveryRevisions.get(workspaceId) ?? -1)) {
        this.finishSource(workspaceId, "gitlab", "WTS kept a newer merge request response. Select Refresh status to retry.", true, this.snapshot.sources[workspaceId]!.gitlab.updatedAt ?? 0);
        return;
      }
      this.discoveryRevisions.set(workspaceId, inbox.fetchedAtUnixMs ?? 0);
      this.snapshot = { ...this.snapshot, inboxes: { ...this.snapshot.inboxes, [workspaceId]: inbox } };
      if (inbox.state === "fresh" && inbox.mergeRequests.length <= 50) {
        const targets = new Set(inbox.mergeRequests.map(mr => JSON.stringify([mr.repositoryId, mr.iid])));
        const removed = (item: SavedItem) => item.workspaceId === workspaceId && item.target.kind === "gitlab" && !targets.has(JSON.stringify([item.target.repositoryId, item.target.iid]));
        this.resolveWhere(removed);
        for (const [id, thread] of this.threads) if (removed(thread.item)) this.threads.delete(id);
      }
      let stale = inbox.state === "stale" || inbox.mergeRequests.length > 50;
      let updatedAt = inbox.fetchedAtUnixMs ?? Date.now();
      let failed = false;
      await Promise.all(inbox.mergeRequests.slice(0, 50).map(async mr => {
        try {
          const snapshot = await this.read(() => this.client.getGitlabDiscussions(mr.repositoryId, mr.iid, workspaceId));
          if (snapshot.repositoryId !== mr.repositoryId || snapshot.iid !== mr.iid) throw new Error("identity");
          stale ||= snapshot.fromCache || snapshot.truncated;
          updatedAt = Math.min(updatedAt, snapshot.fetchedAtUnixMs);
          if (!this.applyDiscussions(workspaceId, snapshot)) stale = true;
        } catch { failed = true; }
      }));
      if (failed) this.failSource(workspaceId, "gitlab", "WTS could not refresh some conversations. Select Refresh status to retry.");
      else this.finishSource(workspaceId, "gitlab", stale ? "Some conversations are cached or incomplete. Open Changes to check the merge request." : "", stale, updatedAt);
    } catch { this.failSource(workspaceId, "gitlab", "WTS could not refresh merge requests. Select Refresh status to retry."); }
  }
  private applyDiscussions(workspaceId: string, snapshot: GitlabDiscussions): boolean {
    if (!this.workspaceIds.has(workspaceId)) return false;
    const targetKey = JSON.stringify([workspaceId, snapshot.repositoryId, snapshot.iid]);
    if (snapshot.fetchedAtUnixMs < (this.discussionRevisions.get(targetKey) ?? -1)) return false;
    this.discussionRevisions.set(targetKey, snapshot.fetchedAtUnixMs);
    while (this.discussionRevisions.size > MAX_THREADS) this.discussionRevisions.delete(this.discussionRevisions.keys().next().value!);
    if (!snapshot.fromCache && !snapshot.truncated) {
      const ids = new Set(snapshot.discussions.map(thread => thread.id));
      const absent = (item: SavedItem) => item.workspaceId === workspaceId && item.target.kind === "gitlab" && item.target.repositoryId === snapshot.repositoryId && item.target.iid === snapshot.iid && (item.target.scopeId !== snapshot.scopeId || !ids.has(item.target.discussionId));
      this.resolveWhere(absent);
      for (const [id, thread] of this.threads) if (absent(thread.item) && thread.fetchedAt <= snapshot.fetchedAtUnixMs) this.threads.delete(id);
    }
    for (const thread of snapshot.discussions) {
      const id = JSON.stringify(["gitlab", workspaceId, snapshot.scopeId, thread.id]);
      const previous = this.threads.get(id);
      if (previous && previous.fetchedAt > snapshot.fetchedAtUnixMs) continue;
      let comments = gitlabCommentsAfterOwnReply(thread.comments, snapshot.viewerLogin)
        .map(comment => ({ id: comment.id, revision: gitlabCommentRevision(comment) }));
      if ((snapshot.fromCache || snapshot.truncated) && previous) comments = [...new Map([...previous.comments, ...comments].map(comment => [comment.id, comment])).values()];
      const item: WorkspaceAttentionItem = { id, revision: "", workspaceId, kind: "gitlab", label: thread.filePath ?? `MR !${snapshot.iid} conversation`, detail: "Unread comments and replies.",
        occurredAt: Math.max(0, ...thread.comments.map(comment => Date.parse(comment.createdAt) || 0)), count: 0,
        target: { kind: "gitlab", repositoryId: snapshot.repositoryId, iid: snapshot.iid, discussionId: thread.id, scopeId: snapshot.scopeId, ...(thread.filePath ? { filePath: thread.filePath } : {}) } };
      this.threads.delete(id);
      this.threads.set(id, { item, comments, fetchedAt: snapshot.fetchedAtUnixMs });
    }
    while (this.threads.size > MAX_THREADS) this.threads.delete(this.threads.keys().next().value!);
    this.syncReadMarkers();
    return true;
  }
  private syncReadMarkers(): void {
    const isRead = gitlabCommentReadChecker(this.client);
    for (const { item, comments } of this.threads.values()) {
      if (item.target.kind !== "gitlab") continue;
      const scopeId = item.target.scopeId;
      const unread = comments.filter(comment => !isRead(scopeId, comment.id, comment.revision));
      const revision = hash(JSON.stringify(unread));
      this.resolveWhere(previous => previous.id === item.id && (!unread.length || previous.revision !== revision));
      if (unread.length) this.remember({ ...item, revision, count: unread.length });
    }
  }
}

export function getWorkspaceAttentionStore(client: WorkspaceClient): WorkspaceAttentionStore {
  let store = stores.get(client);
  if (!store) { store = new AttentionStore(client); stores.set(client, store); }
  return store;
}

export function notifyAgentResultReviewed(client: WorkspaceClient, decision: AgentResultReviewed): void {
  getWorkspaceAttentionStore(client);
  stores.get(client)!.reviewAgent(decision);
}

export function observeWorkspaceVerificationSummary(client: WorkspaceClient, summary: WorkspaceVerificationSummary): void {
  getWorkspaceAttentionStore(client);
  stores.get(client)!.observeVerification(summary);
}
