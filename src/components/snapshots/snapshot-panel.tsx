"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { SnapshotEntry, DriftSummary } from "@/lib/snapshot/types";
import type {
  SnapshotsLoadState,
  SnapshotDetailState,
  CreateSnapshotPayload,
} from "@/lib/api/snapshots";
import {
  fetchSnapshots,
  createSnapshot as apiCreateSnapshot,
  deleteSnapshot as apiDeleteSnapshot,
  duplicateSnapshot as apiDuplicateSnapshot,
  fetchSnapshotWithAnalysis,
  fetchDrift,
} from "@/lib/api/snapshots";
import { SnapshotCreateForm } from "./snapshot-create-form";
import { SnapshotList } from "./snapshot-list";
import { SnapshotDetail } from "./snapshot-detail";
import { Camera, FileWarning } from "lucide-react";

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
    <div
      className="flex items-start gap-2.5 p-3 rounded-xl animate-in mb-3"
      style={{
        background: "rgba(248,113,113,0.06)",
        border: "1px solid rgba(248,113,113,0.15)",
      }}
    >
      <FileWarning size={14} className="shrink-0 mt-0.5" style={{ color: "var(--danger)" }} />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold" style={{ color: "rgb(248,113,113)" }}>
          Snapshot error
        </p>
        <p className="text-[10px] mt-px font-mono" style={{ color: "rgba(248,113,113,0.7)" }}>
          {message}
        </p>
      </div>
      <button
        onClick={onDismiss}
        className="text-[10px] shrink-0 transition-colors"
        style={{ color: "rgba(248,113,113,0.5)" }}
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  SnapshotPanel — exported for integration agent to mount            */
/* ------------------------------------------------------------------ */

export interface SnapshotPanelProps {
  /** Callback when the user wants to mount the panel */
  className?: string;
  repoCount: number;
}

export function SnapshotPanel({ className, repoCount }: SnapshotPanelProps) {
  const [listState, setListState] = useState<SnapshotsLoadState>({
    status: "idle",
  });
  const [detailState, setDetailState] = useState<SnapshotDetailState>({
    status: "idle",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [driftSummaries, setDriftSummaries] = useState<
    Record<string, DriftSummary | null> | null
  >(null);
  const abortRef = useRef<AbortController | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const loadDriftSummaries = useCallback(
    async (snapshots: SnapshotEntry[], signal?: AbortSignal) => {
      const summaries: Record<string, DriftSummary | null> = {};
      let next = 0;
      const workers = Array.from({ length: Math.min(4, snapshots.length) }, async () => {
        while (next < snapshots.length && !signal?.aborted) {
          const entry = snapshots[next++];
          try {
            const drift = await fetchDrift(entry.id, signal);
            summaries[entry.id] = drift.summary;
          } catch {
            summaries[entry.id] = null;
          }
        }
      });
      await Promise.all(workers);
      if (!signal?.aborted) {
        setDriftSummaries(summaries);
      }
    },
    []
  );

  /* ── Load snapshots list ──────────────────────────────────── */

  const loadSnapshots = useCallback(async (signal?: AbortSignal) => {
    setListState({ status: "loading" });
    try {
      const data = await fetchSnapshots(signal);
      if (signal?.aborted) return;
      setListState({ status: "success", data });
      if (data.snapshots.length > 0) {
        void loadDriftSummaries(data.snapshots, signal);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Unknown error";
      if (signal?.aborted) return;
      setListState({ status: "error", message });
    }
  }, [loadDriftSummaries]);

  /* ── Initial load ─────────────────────────────────────────── */

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => void loadSnapshots(controller.signal),
      0
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadSnapshots]);

  /* ── Select / load detail ─────────────────────────────────── */

  const handleSelect = useCallback(
    async (id: string) => {
      // Cancel previous detail fetch
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setSelectedId(id);
      setDetailState({ status: "loading" });

      try {
        const data = await fetchSnapshotWithAnalysis(id, controller.signal);
        if (controller.signal.aborted) return;
        setDetailState({ status: "success", data });
        setError(null);
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Unknown error";
        if (controller.signal.aborted) return;
        setDetailState({ status: "error", message });
      }
    },
    []
  );

  /* ── Create snapshot ──────────────────────────────────────── */

  const handleCreate = useCallback(
    async (label: string, description?: string) => {
      const payload: CreateSnapshotPayload = {
        label,
        description,
        source: "manual",
      };

      await apiCreateSnapshot(payload);
      await loadSnapshots();
      setShowCreateForm(false);
    },
    [loadSnapshots]
  );

  /* ── Delete ───────────────────────────────────────────────── */

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await apiDeleteSnapshot(id);
        if (selectedId === id) {
          setSelectedId(null);
          setDetailState({ status: "idle" });
        }
        await loadSnapshots();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [selectedId, loadSnapshots]
  );

  /* ── Duplicate ────────────────────────────────────────────── */

  const handleDuplicate = useCallback(
    async (id: string) => {
      try {
        await apiDuplicateSnapshot(id, `${new Date().toISOString().slice(0, 10)} copy`);
        await loadSnapshots();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
      }
    },
    [loadSnapshots]
  );

  /* ── Refresh ──────────────────────────────────────────────── */

  const handleRefresh = useCallback(async () => {
    await loadSnapshots();
    if (selectedId) {
      setDetailState({ status: "loading" });
      try {
        const data = await fetchSnapshotWithAnalysis(selectedId);
        setDetailState({ status: "success", data });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        setDetailState({ status: "error", message });
      }
    }
  }, [loadSnapshots, selectedId]);

  const handleActivated = useCallback(async (activatedId: string) => {
    if (selectedIdRef.current !== activatedId) return;
    try {
      const data = await fetchSnapshotWithAnalysis(activatedId);
      if (selectedIdRef.current !== activatedId) return;
      setDetailState({ status: "success", data });
    } catch (err: unknown) {
      if (selectedIdRef.current !== activatedId) return;
      const message = err instanceof Error ? err.message : "Failed to refresh snapshot";
      setDetailState({ status: "error", message });
    }
  }, []);

  const isRefreshing = listState.status === "loading";

  return (
    <div className={className}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <h2
          className="text-sm font-semibold tracking-tight flex items-center gap-1.5"
          style={{ color: "var(--color-text-primary)" }}
        >
          <Camera size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
          Snapshots
        </h2>
        <button
          onClick={() => setShowCreateForm(true)}
          disabled={listState.status !== "success"}
          className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded-lg text-[10px] font-semibold transition-all"
          style={{
            background: "rgba(96,165,250,0.12)",
            color: "var(--accent)",
            border: "1px solid rgba(96,165,250,0.2)",
          }}
          aria-label="Create new snapshot"
        >
          <Camera size={11} aria-hidden="true" />
          Capture
        </button>
      </div>

      {/* Error */}
      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      {/* Layout: list and detail side by side when there's space */}
      <div className="flex flex-col gap-3 lg:flex-row lg:gap-4">
        {/* List column */}
        <div className="lg:w-[280px] shrink-0">
          {listState.status === "loading" && (
            <div className="animate-pulse space-y-2">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-16 rounded-xl"
                  style={{ background: "var(--color-background-surface)" }}
                />
              ))}
            </div>
          )}
          {listState.status === "error" && (
            <ErrorBanner
              message={listState.message}
              onDismiss={() => void loadSnapshots()}
            />
          )}
          {listState.status === "success" && (
            <SnapshotList
              snapshots={listState.data.snapshots}
              selectedId={selectedId}
              onSelect={handleSelect}
              onDelete={handleDelete}
              onDuplicate={handleDuplicate}
              onRefresh={handleRefresh}
              isRefreshing={isRefreshing}
              driftSummaries={driftSummaries}
            />
          )}
        </div>

        {/* Detail column */}
        <div className="flex-1 min-w-0">
          <SnapshotDetail
            snapshotId={selectedId}
            schema={
              detailState.status === "success" ? detailState.data.schema : null
            }
            drift={
              detailState.status === "success" ? detailState.data.drift : null
            }
            plan={
              detailState.status === "success" ? detailState.data.plan : null
            }
            isLoading={detailState.status === "loading"}
            error={detailState.status === "error" ? detailState.message : null}
            onActivated={handleActivated}
          />
        </div>
      </div>

      {/* Create form dialog */}
      {showCreateForm && (
        <SnapshotCreateForm
          isOpen={showCreateForm}
          onClose={() => setShowCreateForm(false)}
          onSubmit={handleCreate}
          repoCount={repoCount}
        />
      )}
    </div>
  );
}
