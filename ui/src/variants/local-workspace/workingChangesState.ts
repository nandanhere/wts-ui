import type { WorkspaceClient, WorkspaceGitlabComparison } from "../../lib/wtsClient";

export type WorkingComparisonView = "latestWork" | "inMr" | "sinceMr";
export interface WorkingComparisonState {
  comparison?: WorkspaceGitlabComparison;
  view: WorkingComparisonView;
  selectedFile: string;
  panel?: "editor" | "conversations";
  pending: boolean;
  refreshQueued?: boolean;
  requestToken?: object;
  error: string;
  revision: number;
}
interface ReviewSession {
  mode: "code" | "conversations";
  targets: Record<string, string>;
  files: Record<string, string>;
  discussions: Record<string, string>;
}
interface Store {
  entries: Map<string, WorkingComparisonState>;
  sessions: Map<string, ReviewSession>;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => number;
  update: (key: string, update: (current: WorkingComparisonState) => WorkingComparisonState) => void;
}
const clients = new WeakMap<WorkspaceClient, Store>();
export function workingChangesStore(client: WorkspaceClient): Store {
  const previous = clients.get(client);
  if (previous) return previous;
  const listeners = new Set<() => void>();
  let revision = 0;
  const store: Store = {
    entries: new Map(), sessions: new Map(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => revision,
    update(key, update) {
      const old = store.entries.get(key) ?? { view: "latestWork", selectedFile: "", pending: false, error: "", revision: 0 };
      store.entries.delete(key);
      store.entries.set(key, update(old));
      while (store.entries.size > 16) {
        const removable = [...store.entries.keys()].find((other) => other !== key);
        if (!removable) break;
        store.entries.delete(removable);
      }
      revision += 1;
      for (const listener of listeners) listener();
    },
  };
  clients.set(client, store);
  return store;
}
export function reviewSession(client: WorkspaceClient, workspaceId: string): ReviewSession {
  const store = workingChangesStore(client);
  const previous = store.sessions.get(workspaceId);
  if (previous) return previous;
  const session: ReviewSession = { mode: "code", targets: {}, files: {}, discussions: {} };
  store.sessions.set(workspaceId, session);
  if (store.sessions.size > 24) store.sessions.delete(store.sessions.keys().next().value!);
  return session;
}
