import { loadWorkspaceGitlabMergeRequests } from "./gitlabMergeRequestDiscovery";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitlabDiscussionReplyResult, GitlabDiscussions, GitlabReviewDiscussionComment, GitlabReviewTarget, WorkspaceClient, WorkspaceMaterialization } from "../../lib/wtsClient";
import { useVisiblePolling } from "../../lib/useVisiblePolling";

export interface GitlabConversationTarget {
  key: string;
  repositoryId: string;
  worktreeRepositoryId: string;
  iid: number;
  label: string;
  workspaceId?: string;
  title?: string;
  sourceBranch?: string;
  targetBranch?: string;
  status?: "open" | "merged" | "closed";
  authorLogin?: string;
}

export interface GitlabConversationEntry {
  target: GitlabConversationTarget;
  snapshot?: GitlabDiscussions;
  state: "loading" | "ready" | "error";
  error: string;
  unreadCommentIds: number[];
}

export interface GitlabConversationsController {
  entries: GitlabConversationEntry[];
  loading: boolean;
  error: string;
  unreadCount: number;
  refresh: (targetKey?: string) => void;
  markRead: (targetKey: string, scopeId: string, comments: GitlabReviewDiscussionComment[]) => void;
  acceptReply: (targetKey: string, result: GitlabDiscussionReplyResult, scopeId: string) => void;
}

const STORAGE_KEY = "wts.gitlab-discussion-reads.v1";
const READ_EVENT = "wts:gitlab-discussion-reads";
const POLL_INTERVAL_MS = 60_000;
type ReadMarkers = Record<string, Record<string, string[]>>;
const memoryReadMarkers = new WeakMap<WorkspaceClient, ReadMarkers>();

export function subscribeGitlabDiscussionReads(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) listener(); };
  window.addEventListener(READ_EVENT, listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(READ_EVENT, listener); window.removeEventListener("storage", storage); };
}

export function getUnreadGitlabCommentIds(snapshot: GitlabDiscussions, client: WorkspaceClient): number[] {
  return unreadIds(snapshot, loadMarkers(client));
}

export function gitlabCommentRevision(comment: GitlabReviewDiscussionComment): string {
  return revision(comment);
}

export function gitlabCommentReadChecker(client: WorkspaceClient): (scopeId: string, id: number, commentRevision: string) => boolean {
  const markers = loadMarkers(client);
  return (scopeId, id, commentRevision) => markers[scopeId]?.[id]?.includes(commentRevision) ?? false;
}

const conversationCaches = new WeakMap<WorkspaceClient, Map<string, { entries: GitlabConversationEntry[]; size: number }>>();
const MAX_CACHED_WORKSPACES = 24;
const MAX_CACHED_CHARACTERS = 4_000_000;

function cachedConversations(client: WorkspaceClient, key: string, markers: ReadMarkers): GitlabConversationEntry[] {
  const cache = conversationCaches.get(client);
  const cached = cache?.get(key);
  if (!cached) return [];
  cache!.delete(key);
  cache!.set(key, cached);
  return cached.entries.map((entry) => ({
    ...entry, state: "loading", error: "",
    ...(entry.snapshot ? { snapshot: { ...entry.snapshot, fromCache: true }, unreadCommentIds: unreadIds(entry.snapshot, markers) } : {}),
  }));
}

function cacheConversations(client: WorkspaceClient, key: string, entries: GitlabConversationEntry[]) {
  const cache = conversationCaches.get(client) ?? new Map();
  conversationCaches.set(client, cache);
  cache.delete(key);
  const size = JSON.stringify(entries).length;
  if (size > MAX_CACHED_CHARACTERS || !entries.some((entry) => entry.snapshot)) return;
  cache.set(key, { entries, size });
  let total = [...cache.values()].reduce((sum, item) => sum + item.size, 0);
  while (cache.size > MAX_CACHED_WORKSPACES || total > MAX_CACHED_CHARACTERS) {
    const oldest = cache.keys().next().value!;
    total -= cache.get(oldest)!.size;
    cache.delete(oldest);
  }
}


function mergeMarkers(first: ReadMarkers, second: ReadMarkers): ReadMarkers {
  const merged = { ...first };
  for (const [scope, notes] of Object.entries(second)) {
    merged[scope] = { ...merged[scope] };
    for (const [id, revisions] of Object.entries(notes)) {
      merged[scope]![id] = [...new Set([...(merged[scope]![id] ?? []), ...revisions])].slice(-4);
    }
  }
  return merged;
}

function loadMarkers(client: WorkspaceClient): ReadMarkers {
  const memory = memoryReadMarkers.get(client) ?? {};
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text || text.length > 2_000_000) return memory;
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return mergeMarkers(memory, Object.fromEntries(Object.entries(raw).slice(-64).flatMap(([scope, notes]) => {
      if (!/^[a-f0-9]{64}$/.test(scope) || !notes || typeof notes !== "object" || Array.isArray(notes)) return [];
      return [[scope, Object.fromEntries(Object.entries(notes).slice(-1024).filter((entry): entry is [string, string[]] => {
        const [id, revisions] = entry;
        return /^[1-9]\d{0,15}$/.test(id) && Array.isArray(revisions) && revisions.length <= 4 && revisions.every((revision) => typeof revision === "string" && /^\d+:[a-f0-9]{16}$/.test(revision));
      }))]];
    })));
  } catch {
    return memory;
  }
}

function revision(comment: GitlabReviewDiscussionComment): string {
  const value = JSON.stringify([comment.authorLogin, comment.createdAt, comment.body]);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charCodeAt(index);
    first = Math.imul(first ^ char, 0x01000193);
    second = Math.imul(second ^ char, 0x85ebca6b);
  }
  return `${value.length}:${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function unreadIds(snapshot: GitlabDiscussions, markers: ReadMarkers): number[] {
  const seen = markers[snapshot.scopeId] ?? {};
  return [...new Set(snapshot.discussions.flatMap((thread) => thread.comments)
    .filter((comment) => comment.authorLogin.toLowerCase() !== snapshot.viewerLogin.toLowerCase() && !seen[comment.id]?.includes(revision(comment)))
    .map((comment) => comment.id))];
}

function remember(markers: ReadMarkers, scope: string, comments: GitlabReviewDiscussionComment[], client: WorkspaceClient): ReadMarkers {
  const next = mergeMarkers(markers, loadMarkers(client));
  const notes = { ...next[scope] };
  for (const comment of comments) notes[comment.id] = [...new Set([...(notes[comment.id] ?? []), revision(comment)])].slice(-4);
  delete next[scope];
  next[scope] = Object.fromEntries(Object.entries(notes).slice(-1024));
  const bounded = Object.fromEntries(Object.entries(next).slice(-64));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bounded));
    memoryReadMarkers.delete(client);
  } catch {
    // Keep read markers in memory when local storage is unavailable.
    memoryReadMarkers.set(client, bounded);
  }
  window.dispatchEvent(new Event(READ_EVENT));
  return bounded;
}

interface Options {
  client: WorkspaceClient;
  workspaceId?: string;
  materialization?: WorkspaceMaterialization | null;
  review?: GitlabReviewTarget;
  enabled: boolean;
}

export function useWorkspaceGitlabDiscussions({ client, workspaceId, materialization, review, enabled }: Options): GitlabConversationsController {
  const markersRef = useRef<ReadMarkers | null>(null);
  if (!markersRef.current) markersRef.current = loadMarkers(client);
  const worktreeKey = JSON.stringify((materialization?.worktrees ?? []).map((worktree) => [worktree.repositoryId, worktree.label, worktree.branchName, worktree.gitState?.originUrl]));
  const reviewKey = JSON.stringify(review ? [review.repositoryId, review.number, review.repository] : null);
  const cacheKey = JSON.stringify([workspaceId, worktreeKey, reviewKey]);
  const contextKey = JSON.stringify([enabled, cacheKey]);
  const [entries, setEntries] = useState<GitlabConversationEntry[]>(() => enabled ? cachedConversations(client, cacheKey, markersRef.current!) : []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const entriesRef = useRef(entries);
  const replyRevisionsRef = useRef(new Map<string, number>());
  const refreshRef = useRef<(targetKey?: string) => void>(() => undefined);
  const clientRef = useRef(client);
  clientRef.current = client;
  const [displayedClient, setDisplayedClient] = useState(() => client);
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const [displayedContext, setDisplayedContext] = useState(contextKey);

  const updateEntries = useCallback((next: GitlabConversationEntry[]) => {
    entriesRef.current = next;
    setEntries(next);
    if (enabled) cacheConversations(client, cacheKey, next);
  }, [client, cacheKey, enabled]);

  useEffect(() => {
    const syncReadMarkers = () => {
      markersRef.current = mergeMarkers(markersRef.current!, loadMarkers(client));
      updateEntries(entriesRef.current.map((entry) => entry.snapshot ? { ...entry, unreadCommentIds: unreadIds(entry.snapshot, markersRef.current!) } : entry));
    };
    return subscribeGitlabDiscussionReads(syncReadMarkers);
  }, [updateEntries]);

  useEffect(() => {
    let current = true;
    let inFlight = false;
    const valid = () => current && contextRef.current === contextKey && clientRef.current === client;
    updateEntries(enabled ? cachedConversations(client, cacheKey, markersRef.current!) : []);
    setDisplayedClient(client);
    replyRevisionsRef.current.clear();
    setDisplayedContext(contextKey);
    setError("");
    setLoading(false);
    if (!enabled || !workspaceId || !materialization?.worktrees.length) {
      refreshRef.current = () => undefined;
      return () => { current = false; };
    }
    const refresh = async (targetKey?: string, force = false) => {
      if (!valid() || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      setLoading(true);
      try {
        let targets: GitlabConversationTarget[];
        if (targetKey) {
          targets = entriesRef.current.filter((entry) => entry.target.key === targetKey).map((entry) => entry.target);
        } else if (review) {
          const worktree = materialization.worktrees.find((item) => item.repositoryId === review.repositoryId)
            ?? materialization.worktrees.find((item) => item.label === review.repository.split("/").at(-1));
          targets = worktree ? [{ key: JSON.stringify(["review", review.repositoryId, review.number]), repositoryId: review.repositoryId, worktreeRepositoryId: worktree.repositoryId, iid: review.number, label: `${review.repository} !${review.number}` }] : [];
          setError("");
        } else {
          const inbox = await loadWorkspaceGitlabMergeRequests(client, workspaceId, { force });
          if (!valid()) return;
          if (inbox.state !== "fresh" && inbox.state !== "stale") throw new Error(inbox.detail);
          targets = inbox.mergeRequests.filter((mr) => materialization.worktrees.some((worktree) => worktree.repositoryId === mr.repositoryId))
            .slice(0, 50).map((mr) => ({ key: JSON.stringify([workspaceId, mr.repositoryId, mr.iid]), workspaceId, repositoryId: mr.repositoryId, worktreeRepositoryId: mr.repositoryId, iid: mr.iid, label: `${mr.projectPath} !${mr.iid}`, title: mr.title, sourceBranch: mr.sourceBranch, targetBranch: mr.targetBranch, status: mr.status, authorLogin: mr.authorUsername }));
          setError(inbox.state === "stale" ? inbox.detail : "");
        }
        if (!valid()) return;
        if (!targetKey) {
          const previous = new Map(entriesRef.current.map((entry) => [entry.target.key, entry]));
          updateEntries(targets.map((target) => previous.has(target.key) ? { ...previous.get(target.key)!, target } : { target, state: "loading", error: "", unreadCommentIds: [] }));
        }
        let nextTarget = 0;
        const worker = async () => {
          while (nextTarget < targets.length && valid()) {
            const target = targets[nextTarget++]!;
            const replyRevision = replyRevisionsRef.current.get(target.key) ?? 0;
            try {
              const snapshot = await client.getGitlabDiscussions(target.repositoryId, target.iid, target.workspaceId);
              if (!valid()) return;
              if ((replyRevisionsRef.current.get(target.key) ?? 0) !== replyRevision) continue;
              if (snapshot.repositoryId !== target.repositoryId || snapshot.iid !== target.iid) throw new Error("WTS returned conversations for a different merge request.");
              updateEntries(entriesRef.current.map((entry) => entry.target.key !== target.key ? entry : {
                target, snapshot, state: "ready", error: "", unreadCommentIds: unreadIds(snapshot, markersRef.current!),
              }));
            } catch (cause) {
              if (!valid()) return;
              if ((replyRevisionsRef.current.get(target.key) ?? 0) !== replyRevision) continue;
              updateEntries(entriesRef.current.map((entry) => entry.target.key !== target.key ? entry : {
                ...entry, state: "error", error: cause instanceof Error ? cause.message : "WTS could not load GitLab conversations.",
                ...(entry.snapshot ? { snapshot: { ...entry.snapshot, fromCache: true } } : {}),
              }));
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker));
      } catch (cause) {
        if (valid()) {
          const message = cause instanceof Error ? cause.message : "WTS could not find the workspace merge requests.";
          setError(message);
          updateEntries(entriesRef.current.map((entry) => ({
            ...entry, state: "error", error: message,
            ...(entry.snapshot ? { snapshot: { ...entry.snapshot, fromCache: true } } : {}),
          })));
        }
      } finally {
        inFlight = false;
        if (valid()) setLoading(false);
      }
    };
    refreshRef.current = (targetKey) => { void refresh(targetKey, true); };
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      current = false;
      window.removeEventListener("focus", onFocus);
    };
  // Identity strings keep provider polling independent of materialization refreshes.
  }, [client, contextKey, updateEntries]);

  const refresh = useCallback((targetKey?: string) => refreshRef.current(targetKey), []);
  useVisiblePolling(refresh, POLL_INTERVAL_MS, { enabled: enabled && Boolean(workspaceId) });

  const markRead = useCallback((targetKey: string, scopeId: string, comments: GitlabReviewDiscussionComment[]) => {
    if (document.visibilityState === "hidden") return;
    const entry = entriesRef.current.find((item) => item.target.key === targetKey);
    if (!entry?.snapshot || entry.snapshot.scopeId !== scopeId) return;
    const currentComments = new Map(entry.snapshot.discussions.flatMap((thread) => thread.comments).map((comment) => [comment.id, comment]));
    const displayed = comments.filter((comment) => {
      const latest = currentComments.get(comment.id);
      return latest && revision(latest) === revision(comment);
    });
    if (!displayed.some((comment) => !markersRef.current?.[scopeId]?.[comment.id]?.includes(revision(comment)))) return;
    markersRef.current = remember(markersRef.current!, scopeId, displayed, client);
    updateEntries(entriesRef.current.map((item) => item.snapshot?.scopeId === scopeId ? { ...item, unreadCommentIds: unreadIds(item.snapshot, markersRef.current!) } : item));
  }, [updateEntries]);

  const acceptReply = useCallback((targetKey: string, result: GitlabDiscussionReplyResult, scopeId: string) => {
    const entry = entriesRef.current.find((item) => item.target.key === targetKey);
    if (!entry?.snapshot || entry.snapshot.scopeId !== scopeId || result.repositoryId !== entry.target.repositoryId || result.iid !== entry.target.iid) return;
    if (!entry.snapshot.discussions.some((thread) => thread.id === result.discussionId)) return;
    replyRevisionsRef.current.set(targetKey, (replyRevisionsRef.current.get(targetKey) ?? 0) + 1);
    const snapshot = {
      ...entry.snapshot,
      discussions: entry.snapshot.discussions.map((thread) => thread.id === result.discussionId ? {
        ...thread, comments: [...thread.comments.filter((comment) => comment.id !== result.comment.id), result.comment],
      } : thread),
    };
    markersRef.current = remember(markersRef.current!, snapshot.scopeId, [result.comment], client);
    updateEntries(entriesRef.current.map((item) => item.target.key === targetKey ? { ...item, snapshot, unreadCommentIds: unreadIds(snapshot, markersRef.current!) } : item));
  }, [updateEntries]);

  const visibleEntries = displayedContext === contextKey && displayedClient === client
    ? entries
    : enabled ? cachedConversations(client, cacheKey, markersRef.current!) : [];
  const unreadCount = useMemo(() => {
    const notes = new Set<string>();
    for (const entry of visibleEntries) for (const id of entry.unreadCommentIds) notes.add(`${entry.snapshot?.scopeId}:${id}`);
    return notes.size;
  }, [visibleEntries]);
  return { entries: visibleEntries, loading, error, unreadCount, refresh, markRead, acceptReply };
}
