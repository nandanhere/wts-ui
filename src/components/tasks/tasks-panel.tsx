"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  FolderOpen,
  Terminal,
} from "lucide-react";
import { useWorkspaceContext } from "@/components/workspace/workspace-context";
import { TasksWorktreeRow } from "./tasks-worktree-row";
import { TasksConfigPrompt } from "./tasks-config-prompt";
import type {
  TaskRepoStatus,
} from "@/lib/tasks/types";

/* ------------------------------------------------------------------ */
/*  Key builder for action tracking                                    */
/* ------------------------------------------------------------------ */

function actionKey(repoId: string, worktreePath: string, processName: string): string {
  return `${repoId}::${worktreePath}::${processName}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TasksPanel() {
  const { isWorkspaceLoaded, repoIds, loadState } = useWorkspaceContext();

  const [statuses, setStatuses] = useState<Map<string, TaskRepoStatus>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Get X-Action-Token ─────────────────────────────────── */
  const getActionToken = useCallback(async (): Promise<string> => {
    try {
      const res = await fetch("/api/git/token");
      if (res.ok) {
        const data = await res.json();
        return data.token ?? "";
      }
    } catch {
      // ignore
    }
    return "";
  }, []);

  /* ── Fetch status for all repos ────────────────────────────── */
  const fetchAll = useCallback(async () => {
    if (repoIds.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        repoIds.map((id) =>
          fetch(`/api/tasks/status?repoId=${encodeURIComponent(id)}`).then(
            (r) => (r.ok ? r.json() : Promise.reject(r.statusText)),
          ),
        ),
      );

      const next = new Map<string, TaskRepoStatus>(statuses);
      let hadFailure = false;

      for (const result of results) {
        if (result.status === "fulfilled") {
          const data = result.value as TaskRepoStatus;
          next.set(data.repoId, data);
        } else {
          hadFailure = true;
        }
      }

      if (!hadFailure) {
        setStatuses(next);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [repoIds]);

  /* ── Start a process ──────────────────────────────────────── */
  const handleStart = useCallback(
    async (repoId: string, worktreePath: string, processName: string) => {
      const key = actionKey(repoId, worktreePath, processName);
      setActionInFlight(key);
      try {
        const token = await getActionToken();
        const res = await fetch(
          `/api/tasks/processes?repoId=${encodeURIComponent(repoId)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-action-token": token },
            body: JSON.stringify({ worktreePath, processName }),
          },
        );
        if (!res.ok) {
          const err = await res.json();
          console.error("[tasks] start failed:", err.error);
        }
        await fetchAll();
      } catch (err) {
        console.error("[tasks] start error:", err);
      } finally {
        setActionInFlight(null);
      }
    },
    [fetchAll, getActionToken],
  );

  /* ── Stop a process ───────────────────────────────────────── */
  const handleStop = useCallback(
    async (repoId: string, worktreePath: string, processName: string) => {
      const key = actionKey(repoId, worktreePath, processName);
      setActionInFlight(key);
      try {
        const token = await getActionToken();
        const res = await fetch(
          `/api/tasks/processes?repoId=${encodeURIComponent(repoId)}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json", "x-action-token": token },
            body: JSON.stringify({ worktreePath, processName }),
          },
        );
        if (!res.ok) {
          const err = await res.json();
          console.error("[tasks] stop failed:", err.error);
        }
        await fetchAll();
      } catch (err) {
        console.error("[tasks] stop error:", err);
      } finally {
        setActionInFlight(null);
      }
    },
    [fetchAll, getActionToken],
  );

  /* ── Start all processes in a worktree ────────────────────── */
  const handleStartAll = useCallback(
    async (repoId: string, worktreePath: string) => {
      const status = statuses.get(repoId);
      if (!status?.config) return;

      const names = status.config.processes.map((p) => p.name);
      const token = await getActionToken();

      for (const name of names) {
        const key = actionKey(repoId, worktreePath, name);
        setActionInFlight(key);
        try {
          await fetch(
            `/api/tasks/processes?repoId=${encodeURIComponent(repoId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-action-token": token },
              body: JSON.stringify({ worktreePath, processName: name }),
            },
          );
        } catch (err) {
          console.error("[tasks] startAll error:", err);
        }
      }
      setActionInFlight(null);
      await fetchAll();
    },
    [fetchAll, statuses, getActionToken],
  );

  /* ── Stop all processes in a worktree ─────────────────────── */
  const handleStopAll = useCallback(
    async (repoId: string, worktreePath: string) => {
      const status = statuses.get(repoId);
      if (!status?.config) return;

      try {
        const token = await getActionToken();
        await fetch(
          `/api/tasks/processes?repoId=${encodeURIComponent(repoId)}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json", "x-action-token": token },
            body: JSON.stringify({ worktreePath, all: true }),
          },
        );
        await fetchAll();
      } catch (err) {
        console.error("[tasks] stopAll error:", err);
      }
    },
    [fetchAll, statuses, getActionToken],
  );

  /* ── Fetch on mount and poll ──────────────────────────────── */
  useEffect(() => {
    if (isWorkspaceLoaded && repoIds.length > 0) {
      fetchAll();
      pollRef.current = setInterval(fetchAll, 5000);
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isWorkspaceLoaded, repoIds, fetchAll]);

  /* ── Empty / no workspace ─────────────────────────────────── */
  if (!isWorkspaceLoaded || repoIds.length === 0) {
    return (
      <div className="animate-in">
        <div className="flex items-center gap-2 mb-3">
          <h2
            className="text-sm font-semibold tracking-tight flex items-center gap-1.5"
            style={{ color: "var(--color-text-primary)" }}
          >
            <Terminal size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
            Tasks
          </h2>
        </div>
        <div className="flex flex-col items-center justify-center py-14 text-center bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl">
          <FolderOpen size={32} className="text-muted/20 mb-3" aria-hidden="true" />
          <p className="text-sm text-muted/60">No workspace open</p>
          <p className="text-[11px] text-muted/40 mt-1 max-w-[280px] leading-relaxed">
            Open a workspace from the Workspace tab to manage
            per-repo task processes.
          </p>
        </div>
      </div>
    );
  }

  /* ── Compute summary counts ───────────────────────────────── */
  const reposConfigured = Array.from(statuses.values()).filter(
    (s) => s.configState === "valid",
  ).length;
  const processesRunning = Array.from(statuses.values()).reduce(
    (acc, s) =>
      acc +
      s.worktrees.reduce(
        (wa, wt) => wa + wt.processes.filter((p) => p.running).length,
        0,
      ),
    0,
  );

  return (
    <div className="animate-in">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <h2
          className="text-sm font-semibold tracking-tight flex items-center gap-1.5"
          style={{ color: "var(--color-text-primary)" }}
        >
          <Terminal size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
          Tasks
        </h2>

        {/* Summary bar */}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[9px] text-muted/40 font-mono">
            {reposConfigured}/{repoIds.length} configured
          </span>
          {processesRunning > 0 && (
            <span className="flex items-center gap-1 text-[9px] text-success/70 font-mono bg-success/10 px-1.5 py-0.5 rounded">
              <span className="w-1 h-1 rounded-full bg-success shadow-[0_0_3px_var(--success)]" />
              {processesRunning} running
            </span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-3 bg-danger/10 border border-danger/20 rounded-xl p-2.5">
          <p className="text-[10px] text-danger/70">{error}</p>
        </div>
      )}

      {/* Loading */}
      {loading && statuses.size === 0 && (
        <div className="space-y-2 animate-pulse">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-surface/30 rounded-xl h-16" />
          ))}
        </div>
      )}

      {/* Per-repo sections */}
      {loadState.status === "success" && (
        <div className="space-y-3">
          {loadState.data.repositories.map((repoView) => {
            const status = statuses.get(repoView.id);
            return (
              <div
                key={repoView.id}
                className="bg-panel/20 border border-border/40 rounded-xl p-3"
              >
                {/* Repo header */}
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-medium text-subtle/80">
                    {repoView.displayName}
                  </span>
                  <span className="text-[8px] text-muted/30 font-mono truncate hidden sm:inline">
                    {repoView.rootPath}
                  </span>
                </div>

                {!status || status.configState !== "valid" ? (
                  <TasksConfigPrompt
                    state={(status?.configState === "invalid" ? "invalid" : "missing")}
                    error={status?.configError}
                  />
                ) : (
                  <div className="space-y-1">
                    {status.worktrees.map((wt) => (
                      <TasksWorktreeRow
                        key={wt.path}
                        worktree={wt}
                        repoId={repoView.id}
                        onStart={handleStart}
                        onStop={handleStop}
                        onStartAll={handleStartAll}
                        onStopAll={handleStopAll}
                        actionInFlight={actionInFlight}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
