import type { GitlabMergeRequestInbox, WorkspaceClient } from "../../lib/wtsClient";

const FRESH_MS = 30_000;
const MAX_CACHED_WORKSPACES = 128;
const MAX_ACTIVE_READS = 3;
interface Entry { pending?: Promise<GitlabMergeRequestInbox>; value?: GitlabMergeRequestInbox; loadedAt?: number }
interface DiscoveryCache { entries: Map<string, Entry>; active: number; queue: Array<() => void> }
const caches = new WeakMap<WorkspaceClient, DiscoveryCache>();
function cacheFor(client: WorkspaceClient) {
  let cache = caches.get(client);
  if (!cache) { cache = { entries: new Map(), active: 0, queue: [] }; caches.set(client, cache); }
  return cache;
}

/** Reuse recent reads and bound concurrent Git inspections across workspace views. */
export function loadWorkspaceGitlabMergeRequests(client: WorkspaceClient, workspaceId: string,
  options: { force?: boolean } = {}): Promise<GitlabMergeRequestInbox> {
  const cache = cacheFor(client);
  const existing = cache.entries.get(workspaceId);
  if (existing?.pending) return existing.pending;
  if (!options.force && existing?.value && Date.now() - (existing.loadedAt ?? 0) < FRESH_MS) {
    cache.entries.delete(workspaceId); cache.entries.set(workspaceId, existing);
    return Promise.resolve(existing.value);
  }
  const entry: Entry = {};
  let resolve!: (value: GitlabMergeRequestInbox) => void;
  let reject!: (cause: unknown) => void;
  const pending = new Promise<GitlabMergeRequestInbox>((yes, no) => { resolve = yes; reject = no; });
  entry.pending = pending;
  cache.entries.set(workspaceId, entry);
  const release = () => {
    entry.pending = undefined;
    cache.active -= 1;
    if (!entry.value && cache.entries.get(workspaceId) === entry) cache.entries.delete(workspaceId);
    const settled = [...cache.entries].filter(([, value]) => !value.pending);
    for (const [key] of settled.slice(0, Math.max(0, settled.length - MAX_CACHED_WORKSPACES))) cache.entries.delete(key);
    cache.queue.shift()?.();
  };
  const start = () => {
    cache.active += 1;
    let read: Promise<GitlabMergeRequestInbox>;
    try { read = client.getGitlabMergeRequests(workspaceId); }
    catch (cause) { release(); reject(cause); return; }
    const followCurrent = () => {
      release();
      void loadWorkspaceGitlabMergeRequests(client, workspaceId).then(resolve, reject);
    };
    void read.then(value => {
      if (cache.entries.get(workspaceId) !== entry) { followCurrent(); return; }
      if (value.state === "fresh" && cache.entries.get(workspaceId) === entry) {
        entry.value = value; entry.loadedAt = Date.now();
      }
      release(); resolve(value);
    }, cause => {
      if (cache.entries.get(workspaceId) !== entry) { followCurrent(); return; }
      release(); reject(cause);
    });
  };
  if (cache.active < MAX_ACTIVE_READS) start(); else cache.queue.push(start);
  return pending;
}

/** A local repository change supersedes any earlier discovery read. */
export function invalidateWorkspaceGitlabMergeRequests(client: WorkspaceClient, workspaceId: string): void {
  caches.get(client)?.entries.delete(workspaceId);
}
