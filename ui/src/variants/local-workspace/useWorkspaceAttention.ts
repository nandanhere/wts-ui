import { useCallback, useRef, useSyncExternalStore } from "react";
import type { WorkspaceAttentionSnapshot, WorkspaceAttentionStore } from "./workspaceAttention";

/** A source update renders only consumers whose selected value changed. */
export function useWorkspaceAttention<T>(store: WorkspaceAttentionStore, select: (snapshot: WorkspaceAttentionSnapshot) => T,
  equal: (previous: T, next: T) => boolean = Object.is): T {
  const selector = useRef(select); selector.current = select;
  const comparison = useRef(equal); comparison.current = equal;
  const cached = useRef<{ store: WorkspaceAttentionStore; value: T } | undefined>(undefined);
  const getSnapshot = useCallback(() => {
    const value = selector.current(store.getSnapshot());
    if (cached.current?.store === store && comparison.current(cached.current.value, value)) return cached.current.value;
    cached.current = { store, value };
    return value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}
