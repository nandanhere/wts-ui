import type { AgentSessionList, WorkspaceClient } from "./wtsClient";

const FRESH_MS = 5_000;
const MAX_SCOPES = 32;
interface Entry {
  pending?: Promise<AgentSessionList>;
  value?: AgentSessionList;
  loadedAt?: number;
  invalidated: boolean;
}
const caches = new WeakMap<WorkspaceClient, Map<string | undefined, Entry>>();
const mutationVersions = new WeakMap<WorkspaceClient, number>();

/** Share recent session reads across views without retaining failed requests. */
export function loadAgentSessions(client: WorkspaceClient, workspaceId?: string, options: { force?: boolean } = {}): Promise<AgentSessionList> {
  let cache = caches.get(client);
  if (!cache) { cache = new Map(); caches.set(client, cache); }
  const existing = cache.get(workspaceId);
  if (existing?.pending) return existing.pending;
  const age = existing?.loadedAt === undefined ? Infinity : Date.now() - existing.loadedAt;
  if (!options.force && existing?.value && age >= 0 && age < FRESH_MS) {
    cache.delete(workspaceId); cache.set(workspaceId, existing);
    return Promise.resolve(existing.value);
  }
  const entry: Entry = { invalidated: false };
  const mutationVersion = mutationVersions.get(client);
  cache.delete(workspaceId); cache.set(workspaceId, entry);
  while (cache.size > MAX_SCOPES) cache.delete(cache.keys().next().value);
  let read: Promise<AgentSessionList>;
  try { read = workspaceId === undefined ? client.listAgentSessions() : client.listAgentSessions(workspaceId); }
  catch (cause) { read = Promise.reject(cause); }
  const superseded = () => entry.invalidated || mutationVersions.get(client) !== mutationVersion;
  const readCurrent = () => {
    if (cache.get(workspaceId) === entry) cache.delete(workspaceId);
    return loadAgentSessions(client, workspaceId);
  };
  const pending = read.then(value => {
    if (superseded()) return readCurrent();
    if (cache.get(workspaceId) === entry) { entry.value = value; entry.loadedAt = Date.now(); }
    return value;
  }, cause => {
    if (superseded()) return readCurrent();
    if (cache.get(workspaceId) === entry) cache.delete(workspaceId);
    throw cause;
  }).finally(() => { entry.pending = undefined; });
  entry.pending = pending;
  return pending;
}

/** A session mutation supersedes prior reads for its workspace and the global view. */
export function invalidateAgentSessions(client: WorkspaceClient, workspaceId?: string): void {
  mutationVersions.set(client, (mutationVersions.get(client) ?? 0) + 1);
  const cache = caches.get(client);
  if (!cache) return;
  for (const [key, entry] of cache) {
    if (workspaceId !== undefined && key !== undefined && key !== workspaceId) continue;
    entry.invalidated = true;
    cache.delete(key);
  }
}
