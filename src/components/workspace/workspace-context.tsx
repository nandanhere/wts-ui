"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import type { RecentsView, WorkspaceLoadState } from "@/lib/api/workspace";
import { fetchRecents, openWorkspace, refreshWorkspace } from "@/lib/api/workspace";
import type { GitStatusView, StatusLoadState } from "@/lib/api/git";
import { fetchRepoStatuses } from "@/lib/api/git";

/* ------------------------------------------------------------------ */
/*  Context shape                                                      */
/* ------------------------------------------------------------------ */

export interface WorkspaceContextValue {
  /** Current load / pick / error state */
  loadState: WorkspaceLoadState;
  /** Absolute path to opened workspace file, or null */
  currentPath: string | null;
  /** Recent workspace entries */
  recents: RecentsView;
  /** Repository IDs from the loaded workspace */
  repoIds: string[];
  /** Whether a workspace is successfully loaded */
  isWorkspaceLoaded: boolean;
  /** Number of repos (0 if none) */
  repoCount: number;
  /** Shared live Git status for the loaded repositories */
  gitStatusMap: Map<string, GitStatusView>;
  /** Shared Git status request state */
  gitStatusState: StatusLoadState;
  /** Refresh all statuses, or only the supplied repository IDs */
  refreshGitStatuses: (repoIds?: string[]) => Promise<void>;
  /** Open a workspace by path */
  handleOpen: (path: string) => Promise<void>;
  /** Refresh current workspace */
  handleRefresh: () => Promise<void>;
  /** Go back to picker */
  handleBack: () => void;
  /** Dismiss error state */
  handleDismissError: () => void;
  /** Whether a refresh is in flight */
  isRefreshing: boolean;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspaceContext(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspaceContext must be used within WorkspaceProvider");
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/*  Provider                                                           */
/* ------------------------------------------------------------------ */

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [loadState, setLoadState] = useState<WorkspaceLoadState>({ status: "idle" });
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [recents, setRecents] = useState<RecentsView>({ entries: [] });
  const [gitStatusMap, setGitStatusMap] = useState<Map<string, GitStatusView>>(
    () => new Map()
  );
  const gitStatusMapRef = useRef<Map<string, GitStatusView>>(new Map());
  const [gitStatusState, setGitStatusState] = useState<StatusLoadState>({
    status: "idle",
  });
  const abortRef = useRef<AbortController | null>(null);
  const gitAbortRef = useRef<AbortController | null>(null);
  const commitGitStatusMap = useCallback((next: Map<string, GitStatusView>) => {
    gitStatusMapRef.current = next;
    setGitStatusMap(next);
  }, []);

  // Derived
  const isWorkspaceLoaded = loadState.status === "success";
  const repoIds =
    loadState.status === "success"
      ? loadState.data.repositories.map((r) => r.id)
      : [];
  const repoCount = repoIds.length;
  const repoIdsKey = [...repoIds].sort().join(",");

  // Load recents on mount
  useEffect(() => {
    let cancelled = false;
    fetchRecents()
      .then((data) => {
        if (!cancelled) setRecents(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const ids = repoIdsKey ? repoIdsKey.split(",") : [];
    gitAbortRef.current?.abort();
    const controller = new AbortController();
    gitAbortRef.current = controller;

    if (ids.length === 0) {
      queueMicrotask(() => {
        if (controller.signal.aborted) return;
        commitGitStatusMap(new Map());
        setGitStatusState({ status: "idle" });
      });
      return () => controller.abort();
    }

    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      commitGitStatusMap(new Map());
      setGitStatusState({ status: "loading" });
    });
    void fetchRepoStatuses(ids, controller.signal).then(
      (map) => {
        if (controller.signal.aborted) return;
        commitGitStatusMap(map);
        setGitStatusState({ status: "loaded", data: map });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : "Unknown error";
        setGitStatusState({ status: "error", message, partial: new Map() });
      }
    );

    return () => controller.abort();
  }, [commitGitStatusMap, repoIdsKey]);

  const refreshGitStatuses = useCallback(
    async (requestedRepoIds?: string[]) => {
      const allRepoIds = repoIdsKey ? repoIdsKey.split(",") : [];
      const ids = requestedRepoIds ?? allRepoIds;
      if (ids.length === 0) return;
      const replaceAll = requestedRepoIds === undefined;
      if (replaceAll) setGitStatusState({ status: "loading" });

      try {
        const updated = await fetchRepoStatuses(ids);
        const next = replaceAll
          ? updated
          : new Map([...gitStatusMapRef.current, ...updated]);
        commitGitStatusMap(next);
        setGitStatusState({ status: "loaded", data: next });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Status refresh failed";
        setGitStatusState({ status: "error", message, partial: gitStatusMapRef.current });
      }
    },
    [commitGitStatusMap, repoIdsKey]
  );

  const handleOpen = useCallback(async (path: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoadState({ status: "loading" });
    setCurrentPath(path);

    try {
      const data = await openWorkspace(path, controller.signal);
      if (controller.signal.aborted) return;
      setLoadState({ status: "success", data });

      // Refresh recents silently
      fetchRecents().then((r) => setRecents(r)).catch(() => {});
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Unknown error";
      if (controller.signal.aborted) return;
      setLoadState({ status: "error", message });
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!currentPath) return;
    setIsRefreshing(true);
    try {
      const data = await refreshWorkspace(currentPath);
      setLoadState({ status: "success", data });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setLoadState({ status: "error", message });
    } finally {
      setIsRefreshing(false);
    }
  }, [currentPath]);

  const handleBack = useCallback(() => {
    abortRef.current?.abort();
    gitAbortRef.current?.abort();
    setLoadState({ status: "idle" });
    setCurrentPath(null);
  }, []);

  const handleDismissError = useCallback(() => {
    abortRef.current?.abort();
    setLoadState({ status: "idle" });
    setCurrentPath(null);
  }, []);

  return (
    <WorkspaceContext.Provider
      value={{
        loadState,
        currentPath,
        recents,
        repoIds,
        isWorkspaceLoaded,
        repoCount,
        gitStatusMap,
        gitStatusState,
        refreshGitStatuses,
        handleOpen,
        handleRefresh,
        handleBack,
        handleDismissError,
        isRefreshing,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}
