"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import type { GraphifyStatus, GraphifyStatusResponse } from "@/lib/graphify/types";
import { fetchGraphifyStatus } from "@/lib/api/graphify";
import { GraphifyRepoRow } from "./graphify-repo-row";
import { cn } from "@/lib/utils";
import {
  Network,
  Search,
  RefreshCw,
  AlertTriangle,
  FileQuestion,
  BarChart3,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Props for integration agent                                        */
/* ------------------------------------------------------------------ */

export interface GraphifyPanelProps {
  /** Absolute path to the opened .code-workspace file */
  workspacePath: string;
  /** Discovered repository IDs (from workspace scan) to show */
  repoIds: string[];
  /** Optional className for styling */
  className?: string;
}

/** Load state for the GraphifyPanel */
type PanelLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: GraphifyStatusResponse }
  | { status: "error"; message: string };

/* ------------------------------------------------------------------ */
/*  Empty / no-graph state                                             */
/* ------------------------------------------------------------------ */

function NoGraphState({
  totalRepos,
  hasGraphCount,
}: {
  totalRepos: number;
  hasGraphCount: number;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center animate-in">
      <FileQuestion size={28} className="text-muted/20 mb-3" aria-hidden="true" />
      <p className="text-sm text-muted/60">
        {hasGraphCount === 0
          ? "No graphify graphs found in any repository"
          : `${hasGraphCount} of ${totalRepos} repos have graphs`}
      </p>
      <p className="text-[10px] text-muted/40 mt-1 max-w-[280px] leading-relaxed">
        Generate a graph by running <code className="text-accent/60">/graphify</code> in
        a repository to see architectural insights here.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Summary bar                                                        */
/* ------------------------------------------------------------------ */

function SummaryBar({
  statuses,
  filteredCount,
}: {
  statuses: GraphifyStatus[];
  filteredCount: number;
}) {
  const total = statuses.length;
  const available = statuses.filter((s) => s.available).length;
  const partial = statuses.filter(
    (s) => !s.available && s.artifacts.graphJson
  ).length;
  const absent = total - available - partial;

  return (
    <div className="flex flex-wrap items-center gap-2.5 text-[9px] font-mono text-muted/50 mb-3">
      <BarChart3 size={11} className="text-accent/50" aria-hidden="true" />
      <span>
        {total} repo{total !== 1 ? "s" : ""}
      </span>
      {available > 0 && (
        <span className="text-success/60">{available} available</span>
      )}
      {partial > 0 && (
        <span className="text-warn/60">{partial} partial</span>
      )}
      {absent > 0 && (
        <span className="text-muted/40">{absent} absent</span>
      )}
      {filteredCount < total && (
        <span className="text-muted/40">
          · showing {filteredCount}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Error banner                                                       */
/* ------------------------------------------------------------------ */

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="bg-danger/10 border border-danger/20 rounded-xl p-3 flex items-start gap-2.5 animate-in mb-3">
      <AlertTriangle
        size={14}
        className="text-danger shrink-0 mt-0.5"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-danger/80 font-medium">
          Failed to load Graphify status
        </p>
        <p className="text-[10px] text-danger/60 mt-0.5 font-mono leading-relaxed">
          {message}
        </p>
      </div>
      <button
        onClick={onDismiss}
        className="text-xs text-muted/50 hover:text-muted transition-colors shrink-0"
        aria-label="Dismiss error"
      >
        Dismiss
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                   */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="bg-surface/30 border border-border/20 rounded-lg h-10"
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

/**
 * GraphifyPanel — optional capability UI showing per-repo graphify
 * artifact metadata for an opened workspace.
 *
 * **Mounting props:**
 * ```tsx
 * import { GraphifyPanel } from "@/components/graphify/graphify-panel";
 *
 * // Inside your component:
 * <GraphifyPanel
 *   workspacePath={currentWorkspacePath}
 *   repoIds={discoveredRepoIds}
 * />
 * ```
 *
 * The component handles its own loading/error/empty states, exposes
 * lazy per-repo operations (meta, wiki, open-html) on user action,
 * and never loads graph.json on the client.
 *
 * Low-overhead: no watchers, no polling, no graph generation.
 */
export function GraphifyPanel({
  workspacePath,
  repoIds,
  className,
}: GraphifyPanelProps) {
  const [loadState, setLoadState] = useState<PanelLoadState>({ status: "idle" });
  const [search, setSearch] = useState("");

  // Fetch on mount / workspace change
  const load = useCallback(async () => {
    if (!workspacePath || repoIds.length === 0) return;
    setLoadState({ status: "loading" });
    try {
      const data = await fetchGraphifyStatus(workspacePath);
      setLoadState({ status: "success", data });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setLoadState({ status: "error", message });
    }
  }, [workspacePath, repoIds.length]);

  // Retry
  const handleRetry = useCallback(() => {
    load();
  }, [load]);

  // Dismiss error
  const handleDismiss = useCallback(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  /* ── Derived data ────────────────────────────────────────── */

  const statuses = useMemo(() => {
    if (loadState.status !== "success") return [];
    // Intersect with requested repo IDs
    return repoIds
      .map((id) => loadState.data.repos[id])
      .filter((s): s is GraphifyStatus => s !== undefined);
  }, [loadState, repoIds]);

  const filteredStatuses = useMemo(
    () =>
      statuses.filter(
        (s) =>
          !search ||
          s.repoId.toLowerCase().includes(search.toLowerCase()) ||
          s.repoRoot.toLowerCase().includes(search.toLowerCase())
      ),
    [statuses, search]
  );

  const hasGraphCount = useMemo(
    () => statuses.filter((s) => s.available || s.artifacts.graphJson).length,
    [statuses]
  );

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div className={cn(className)}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold text-white/80 tracking-tight flex items-center gap-1.5">
          <Network size={13} className="text-accent" aria-hidden="true" />
          Graphify
        </h3>
        {loadState.status === "success" && (
          <button
            onClick={handleRetry}
            className="ml-auto p-1 text-muted/40 hover:text-accent transition-colors rounded hover:bg-surface/30"
            aria-label="Refresh graphify status"
            title="Refresh"
          >
            <RefreshCw size={11} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Error banner */}
      {loadState.status === "error" && (
        <ErrorBanner message={loadState.message} onDismiss={handleDismiss} />
      )}

      {/* Loading state */}
      {loadState.status === "loading" && <LoadingSkeleton />}

      {/* Idle / not yet loaded — nothing to show */}
      {loadState.status === "idle" && (
        <div className="text-[10px] text-muted/40 font-mono py-4 text-center">
          {workspacePath ? "Loading..." : "Open a workspace to view graphify status"}
        </div>
      )}

      {/* Success state */}
      {loadState.status === "success" && (
        <>
          {/* Summary */}
          <SummaryBar statuses={statuses} filteredCount={filteredStatuses.length} />

          {/* Search */}
          <div className="relative mb-2">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted/40 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-7 bg-surface/40 border border-border/40 rounded-md pl-7 pr-2 text-[10px] text-white placeholder-muted/30 outline-none focus:border-accent/20 transition-colors"
              placeholder="Search repos..."
              aria-label="Search graphify repos"
            />
          </div>

          {/* Repo list */}
          <div className="space-y-1">
            {filteredStatuses.map((s) => (
              <GraphifyRepoRow key={s.repoId} status={s} />
            ))}
          </div>

          {/* Empty states */}
          {filteredStatuses.length === 0 && statuses.length > 0 && (
            <div className="flex flex-col items-center justify-center py-6 text-center animate-in">
              <Search size={20} className="text-muted/20 mb-2" aria-hidden="true" />
              <p className="text-xs text-muted/60">
                No repos match &quot;{search}&quot;
              </p>
            </div>
          )}

          {statuses.length === 0 && (
            <NoGraphState
              totalRepos={repoIds.length}
              hasGraphCount={hasGraphCount}
            />
          )}
        </>
      )}
    </div>
  );
}
