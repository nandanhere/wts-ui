import { useSyncExternalStore } from "react";

export type WorkspaceCardClickPreference = "details" | "workspace";
export type WorkspaceCardAction = "details" | "workspace";

export const WORKSPACE_CARD_CLICK_STORAGE_KEY =
  "wts.workspace-card-click.v1";

const listeners = new Set<() => void>();

function availableStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function normalizeWorkspaceCardClickPreference(
  value: string | null | undefined,
): WorkspaceCardClickPreference {
  return value === "workspace" ? "workspace" : "details";
}

export function loadWorkspaceCardClickPreference(
  storage: Pick<Storage, "getItem"> | undefined = availableStorage(),
): WorkspaceCardClickPreference {
  if (!storage) return "details";
  try {
    return normalizeWorkspaceCardClickPreference(
      storage.getItem(WORKSPACE_CARD_CLICK_STORAGE_KEY),
    );
  } catch {
    return "details";
  }
}

export function setWorkspaceCardClickPreference(
  preference: WorkspaceCardClickPreference,
) {
  try {
    availableStorage()?.setItem(WORKSPACE_CARD_CLICK_STORAGE_KEY, preference);
  } catch {
    // A private or locked-down webview can reject local persistence.
  }
  listeners.forEach((listener) => listener());
}

export function resolveWorkspaceCardAction(
  preference: WorkspaceCardClickPreference,
  modified: boolean,
  workspaceAvailable: boolean,
): WorkspaceCardAction {
  if (!workspaceAvailable) return "details";
  if (!modified) return preference;
  return preference === "details" ? "workspace" : "details";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  globalThis.addEventListener?.("storage", listener);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", listener);
  };
}

export function useWorkspaceCardClickPreference() {
  const preference = useSyncExternalStore<WorkspaceCardClickPreference>(
    subscribe,
    loadWorkspaceCardClickPreference,
    () => "details",
  );
  return {
    preference,
    setPreference: setWorkspaceCardClickPreference,
  };
}
