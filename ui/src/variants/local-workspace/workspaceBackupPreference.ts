import { useSyncExternalStore } from "react";

export const WORKSPACE_BACKUP_STORAGE_KEY =
  "wts.workspace-backup-path.v1";

const listeners = new Set<() => void>();

function availableStorage(): Pick<Storage, "getItem" | "setItem"> | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadWorkspaceBackupPreference(
  storage: Pick<Storage, "getItem"> | undefined = availableStorage(),
): string {
  if (!storage) return "";
  try {
    return storage.getItem(WORKSPACE_BACKUP_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setWorkspaceBackupPreference(preference: string) {
  try {
    availableStorage()?.setItem(
      WORKSPACE_BACKUP_STORAGE_KEY,
      preference.trim(),
    );
  } catch {
    // A private or locked-down webview can reject local persistence.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  globalThis.addEventListener?.("storage", listener);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", listener);
  };
}

export function useWorkspaceBackupPreference() {
  const backupPath = useSyncExternalStore<string>(
    subscribe,
    loadWorkspaceBackupPreference,
    () => "",
  );
  return {
    backupPath,
    setBackupPath: setWorkspaceBackupPreference,
  };
}
