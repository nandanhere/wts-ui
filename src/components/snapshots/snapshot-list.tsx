"use client";

import { useState, useCallback } from "react";
import type { SnapshotEntry } from "@/lib/snapshot/types";
import { cn, timeAgo, formatDate } from "@/lib/utils";
import {
  Camera,
  Trash2,
  Copy,
  Eye,
  ChevronRight,
  Layers,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { DriftBadge } from "./snapshot-badge";
import type { DriftSummary } from "@/lib/snapshot/types";

/* ------------------------------------------------------------------ */
/*  Source label                                                       */
/* ------------------------------------------------------------------ */

function SourceBadge({ source }: { source: string }) {
  const cfg: Record<string, { label: string; color: string }> = {
    manual: { label: "Manual", color: "var(--accent)" },
    auto: { label: "Auto", color: "var(--warn)" },
    "restore-point": { label: "Restore Pt", color: "var(--accent2)" },
  };
  const c = cfg[source] ?? { label: source, color: "var(--muted)" };
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded text-[8px] font-semibold uppercase tracking-[.08em] font-mono"
      style={{
        background: `${c.color}12`,
        color: c.color,
        border: `1px solid ${c.color}20`,
      }}
    >
      {c.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Drift summary chips                                                */
/* ------------------------------------------------------------------ */

function DriftSummaryChips({ summary }: { summary: DriftSummary | null }) {
  if (!summary) return null;
  const chips: { label: string; value: number; color: string }[] = [
    { label: "OK", value: summary.satisfied, color: "rgb(52,211,153)" },
    { label: "Drifted", value: summary.safeSwitch + summary.createWorktree + summary.preferred, color: "rgb(96,165,250)" },
    { label: "Blocked", value: summary.dirtyBlocked + summary.occupied + summary.fetchNeeded + summary.missingRef + summary.missingRepo + summary.ambiguous, color: "rgb(248,113,113)" },
  ];
  return (
    <div className="flex gap-2 mt-2">
      {chips.map((c) =>
        c.value > 0 ? (
          <span
            key={c.label}
            className="text-[9px] font-mono font-semibold"
            style={{ color: c.color }}
          >
            {c.value} {c.label}
          </span>
        ) : null
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface SnapshotListProps {
  snapshots: SnapshotEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onRefresh?: () => void;
  isRefreshing?: boolean;
  driftSummaries?: Record<string, DriftSummary | null> | null;
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

function EmptyState({ onCreate }: { onCreate?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-10">
      <Camera size={28} className="mb-3" style={{ color: "var(--muted)", opacity: 0.3 }} />
      <p className="text-sm font-medium" style={{ color: "var(--ink-muted)" }}>
        No snapshots yet
      </p>
      <p className="text-[10px] mt-1" style={{ color: "var(--ink-muted)", opacity: 0.6 }}>
        Capture workspace state after opening a workspace
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                   */
/* ------------------------------------------------------------------ */

function ListSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="rounded-xl p-3"
          style={{ background: "var(--color-background-surface)" }}
        >
          <div className="h-3 w-2/5 rounded" style={{ background: "rgba(255,255,255,0.06)" }} />
          <div className="h-2 w-3/5 rounded mt-2" style={{ background: "rgba(255,255,255,0.04)" }} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Snapshot list                                                      */
/* ------------------------------------------------------------------ */

export function SnapshotList({
  snapshots,
  selectedId,
  onSelect,
  onDelete,
  onDuplicate,
  onRefresh,
  isRefreshing = false,
  driftSummaries,
}: SnapshotListProps) {
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const handleDelete = useCallback(
    (id: string) => {
      onDelete(id);
      setConfirmDelete(null);
    },
    [onDelete]
  );

  if (snapshots.length === 0) {
    return <EmptyState />;
  }

  const needsConfirm = (id: string) => confirmDelete === id;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-2 mb-2.5">
        <h3
          className="text-[11px] font-semibold uppercase tracking-[.08em] flex items-center gap-1.5"
          style={{ color: "var(--color-text-secondary)" }}
        >
          <Layers size={12} aria-hidden="true" />
          Snapshots
        </h3>
        <span
          className="text-[9px] font-mono"
          style={{ color: "var(--color-text-secondary)", opacity: 0.5 }}
        >
          {snapshots.length}
        </span>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className="ml-auto p-1 text-muted/40 hover:text-accent transition-colors rounded disabled:opacity-30"
            aria-label="Refresh snapshots"
          >
            <RefreshCw
              size={11}
              className={cn(isRefreshing && "animate-spin")}
              aria-hidden="true"
            />
          </button>
        )}
      </div>

      {/* List */}
      <div className="space-y-1.5 max-h-[40vh] overflow-y-auto pr-1">
        {snapshots.map((entry) => (
          <div
            key={entry.id}
            className={cn(
              "rounded-xl border transition-all duration-150",
              selectedId === entry.id
                ? "border-accent/30 bg-accent/5"
                : "border-transparent hover:bg-white/[0.02]"
            )}
            style={
              selectedId !== entry.id
                ? { background: "var(--color-background-surface)" }
                : undefined
            }
          >
            {/* Clickable row */}
            <button
              onClick={() => onSelect(entry.id)}
              className="w-full text-left p-3"
              aria-current={selectedId === entry.id ? "true" : undefined}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12px] font-semibold truncate text-white/90">
                      {entry.meta.label}
                    </span>
                    <SourceBadge source={entry.meta.source} />
                  </div>
                  {entry.meta.description && (
                    <p
                      className="text-[10px] mt-0.5 line-clamp-1"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {entry.meta.description}
                    </p>
                  )}
                  <div
                    className="flex items-center gap-2.5 mt-1.5 text-[9px] font-mono"
                    style={{ color: "var(--color-text-secondary)", opacity: 0.6 }}
                  >
                    <span>{entry.repoCount} repos</span>
                    <span className="w-px h-2.5" style={{ background: "var(--color-border)" }} />
                    <span>{formatDate(entry.meta.createdAt)}</span>
                    {timeAgo(entry.meta.createdAt) && (
                      <span>{timeAgo(entry.meta.createdAt)}</span>
                    )}
                  </div>
                  {driftSummaries?.[entry.id] && (
                    <DriftSummaryChips summary={driftSummaries[entry.id]} />
                  )}
                </div>
                <ChevronRight
                  size={13}
                  className="shrink-0 mt-0.5"
                  style={{
                    color:
                      selectedId === entry.id
                        ? "var(--accent)"
                        : "var(--color-text-secondary)",
                    opacity: 0.4,
                  }}
                  aria-hidden="true"
                />
              </div>
            </button>

            {/* Actions bar */}
            <div className="flex gap-1 px-3 pb-2.5">
              <button
                onClick={() => onDuplicate(entry.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-medium transition-all hover:bg-white/[0.05]"
                style={{ color: "var(--color-text-secondary)" }}
                aria-label={`Duplicate ${entry.meta.label}`}
              >
                <Copy size={10} aria-hidden="true" />
                Duplicate
              </button>
              {needsConfirm(entry.id) ? (
                <div className="flex items-center gap-1 ml-auto">
                  <span
                    className="text-[8px] font-medium"
                    style={{ color: "var(--danger)" }}
                  >
                    Delete?
                  </span>
                  <button
                    onClick={() => handleDelete(entry.id)}
                    className="px-2 py-1 rounded-md text-[9px] font-semibold transition-all"
                    style={{
                      background: "rgba(248,113,113,0.15)",
                      color: "var(--danger)",
                    }}
                  >
                    Confirm
                  </button>
                  <button
                    onClick={() => setConfirmDelete(null)}
                    className="px-2 py-1 rounded-md text-[9px] font-medium transition-all hover:bg-white/[0.05]"
                    style={{ color: "var(--color-text-secondary)" }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmDelete(entry.id)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-[9px] font-medium transition-all hover:bg-white/[0.05] ml-auto"
                  style={{ color: "var(--color-text-secondary)" }}
                  aria-label={`Delete ${entry.meta.label}`}
                >
                  <Trash2 size={10} aria-hidden="true" />
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
