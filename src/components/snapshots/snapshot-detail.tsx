"use client";

import { useState } from "react";
import type {
  SnapshotSchema,
  DriftResult,
  RestorePlan,
  RepoDriftResult,
  DriftSummary,
  RepoRestoreAction,
  ActivationResult,
} from "@/lib/snapshot/types";
import { activateSnapshot as apiActivateSnapshot } from "@/lib/api/snapshots";
import { DriftBadge } from "./snapshot-badge";
import { formatDate, cn } from "@/lib/utils";
import {
  GitBranch,
  GitCommit,
  FolderGit2,
  AlertTriangle,
  CircleCheck,
  ArrowRight,
  Info,
  FileWarning,
  TriangleAlert,
  Loader2,
  Play,
  X,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function shortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}

function DriftStat({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-1.5">
      <div
        className="w-[6px] h-[6px] rounded-full shrink-0"
        style={{ background: color }}
      />
      <span className="text-[11px] font-medium" style={{ color }}>
        {count} {label}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Summary row                                                        */
/* ------------------------------------------------------------------ */

function SnapshotSummary({ schema }: { schema: SnapshotSchema }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-semibold text-white tracking-tight">
        {schema.meta.label}
      </h3>
      {schema.meta.description && (
        <p className="text-[11px] mt-0.5" style={{ color: "var(--color-text-secondary)" }}>
          {schema.meta.description}
        </p>
      )}
      <div
        className="flex items-center gap-2.5 mt-1.5 text-[9px] font-mono"
        style={{ color: "var(--color-text-secondary)", opacity: 0.6 }}
      >
        <span>{schema.repoCount} repos</span>
        <span className="w-px h-2.5" style={{ background: "var(--color-border)" }} />
        <span>{formatDate(schema.meta.createdAt)}</span>
        <span className="w-px h-2.5" style={{ background: "var(--color-border)" }} />
        <span className="capitalize">{schema.meta.source}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Drift summary bar                                                  */
/* ------------------------------------------------------------------ */

function DriftSummaryBar({ summary }: { summary: DriftSummary }) {
  const items: { label: string; count: number; color: string }[] = [
    { label: "Satisfied", count: summary.satisfied, color: "rgb(52,211,153)" },
    { label: "Safe Switch", count: summary.safeSwitch, color: "rgb(96,165,250)" },
    { label: "Create Worktree", count: summary.createWorktree, color: "rgb(167,139,250)" },
    { label: "Dirty Blocked", count: summary.dirtyBlocked, color: "rgb(248,113,113)" },
    { label: "Occupied", count: summary.occupied, color: "rgb(251,191,36)" },
    { label: "Fetch Needed", count: summary.fetchNeeded, color: "rgb(251,191,36)" },
    { label: "Missing Ref", count: summary.missingRef, color: "rgb(248,113,113)" },
    { label: "Missing Repo", count: summary.missingRepo, color: "rgb(248,113,113)" },
    { label: "Ambiguous", count: summary.ambiguous, color: "rgb(156,163,175)" },
  ];

  const visible = items.filter((i) => i.count > 0);
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 p-2.5 rounded-lg" style={{ background: "var(--color-background-surface)" }}>
      {visible.map((item) => (
        <DriftStat key={item.label} {...item} />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Repo drift item                                                    */
/* ------------------------------------------------------------------ */

function RepoDriftCard({ result }: { result: RepoDriftResult }) {
  const isProblem =
    result.classification === "dirty-blocked" ||
    result.classification === "occupied" ||
    result.classification === "missing-ref" ||
    result.classification === "missing-repo" ||
    result.classification === "ambiguous";

  const displayName = result.rootPath.split("/").pop() ?? result.rootPath;

  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-all",
        isProblem
          ? "border-danger/15"
          : result.classification === "satisfied"
            ? "border-success/10"
            : "border-accent/10"
      )}
      style={{
        background: isProblem
          ? "rgba(248,113,113,0.04)"
          : "var(--color-background-surface)",
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <FolderGit2 size={12} aria-hidden="true" style={{ color: "var(--accent)" }} />
            <span className="text-[12px] font-semibold truncate text-white/90">
              {displayName}
            </span>
            <DriftBadge classification={result.classification} />
          </div>
          {result.explanation && (
            <p
              className="text-[10px] mt-1 leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {result.explanation}
            </p>
          )}
        </div>
      </div>

      {/* Details */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[9px] font-mono" style={{ color: "var(--color-text-secondary)" }}>
        <span className="flex items-center gap-1">
          <GitBranch size={9} aria-hidden="true" style={{ opacity: 0.5 }} />
          {result.snapshotBranch ?? "(detached)"}
        </span>
        <span className="flex items-center gap-1">
          <GitCommit size={9} aria-hidden="true" style={{ opacity: 0.5 }} />
          {shortSha(result.snapshotSha)}
        </span>
        {result.currentBranch && result.currentBranch !== result.snapshotBranch && (
          <>
            <ArrowRight size={9} aria-hidden="true" style={{ opacity: 0.3 }} />
            <span style={{ color: "var(--warn)" }}>{result.currentBranch}</span>
          </>
        )}
        {result.currentSha && result.currentSha !== result.snapshotSha && (
          <>
            <ArrowRight size={9} aria-hidden="true" style={{ opacity: 0.3 }} />
            <span style={{ color: "var(--warn)" }}>{shortSha(result.currentSha)}</span>
          </>
        )}
      </div>

      {/* Blockers */}
      {isProblem && (
        <div
          className="mt-2 flex items-start gap-1.5 text-[9px] rounded-lg p-2"
          style={{ background: "rgba(248,113,113,0.06)" }}
        >
          <TriangleAlert size={10} className="shrink-0 mt-px" style={{ color: "var(--danger)" }} />
          <span style={{ color: "rgb(248,113,113)" }}>
            {result.classification === "dirty-blocked" && "Dirty working tree — stash or commit changes before switching."}
            {result.classification === "occupied" && `Branch occupied at ${result.occupiedBy ?? "another worktree"}.`}
            {result.classification === "missing-ref" && "Snapshot branch not found locally or on any remote."}
            {result.classification === "missing-repo" && "Repository path not found on disk."}
            {result.classification === "ambiguous" && "Unclear state — manual investigation required."}
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Restore plan section                                               */
/* ------------------------------------------------------------------ */

function RestorePlanSection({ plan }: { plan: RestorePlan }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-[.08em]" style={{ color: "var(--color-text-secondary)" }}>
          Restore Plan{" "}
          <span style={{ opacity: 0.5 }}>(preview)</span>
        </h4>
        {plan.canRestoreAll ? (
          <span
            className="text-[8px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-[.06em]"
            style={{
              background: "rgba(52,211,153,0.12)",
              color: "rgb(52,211,153)",
            }}
          >
            All auto
          </span>
        ) : (
          <span
            className="text-[8px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-[.06em]"
            style={{
              background: "rgba(251,191,36,0.12)",
              color: "rgb(251,191,36)",
            }}
          >
            {plan.summary.autoExecutable} auto / {plan.summary.requiresManual} manual
          </span>
        )}
      </div>

      {/* Auto banner */}
      <div
        className="flex items-start gap-2 p-2.5 mb-2.5 rounded-lg text-[10px]"
        style={{
          background: "rgba(251,191,36,0.06)",
          border: "1px solid rgba(251,191,36,0.15)",
        }}
      >
        <Info size={12} className="shrink-0 mt-0.5" style={{ color: "var(--warn)" }} />
        <span style={{ color: "var(--color-text-secondary)" }}>
          This is a <strong>preview of the restore plan</strong>. Review each
          repository before using the separately confirmed activation control.
        </span>
      </div>

      {/* Action list */}
      <div className="space-y-2">
        {plan.repos.map((action) => (
          <RestoreActionCard key={action.repoId} action={action} />
        ))}
      </div>
    </div>
  );
}

function RestoreActionCard({ action }: { action: RepoRestoreAction }) {
  const isBlocked =
    action.classification === "dirty-blocked" ||
    action.classification === "occupied" ||
    action.classification === "missing-ref" ||
    action.classification === "missing-repo" ||
    action.classification === "ambiguous";

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        background: "var(--color-background-surface)",
        borderColor: isBlocked ? "rgba(248,113,113,0.15)" : "var(--color-border)",
      }}
    >
      <div className="flex items-start gap-2.5">
        {isBlocked ? (
          <FileWarning size={13} className="shrink-0 mt-0.5" style={{ color: "var(--danger)" }} />
        ) : action.canAutoExecute ? (
          <CircleCheck size={13} className="shrink-0 mt-0.5" style={{ color: "rgb(52,211,153)" }} />
        ) : (
          <Info size={13} className="shrink-0 mt-0.5" style={{ color: "var(--warn)" }} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-semibold text-white/90">
              {action.repoId}
            </span>
            <DriftBadge classification={action.classification} />
          </div>
          {action.steps.length > 0 && (
            <ol className="list-decimal list-inside space-y-0.5 mb-1">
              {action.steps.map((step, i) => (
                <li
                  key={i}
                  className="text-[10px] leading-relaxed"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {step}
                </li>
              ))}
            </ol>
          )}
          {action.prerequisites.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {action.prerequisites.map((pr, i) => (
                <span
                  key={i}
                  className="text-[8px] px-1.5 py-0.5 rounded font-medium"
                  style={{
                    background: "rgba(251,191,36,0.1)",
                    color: "rgb(251,191,36)",
                    border: "1px solid rgba(251,191,36,0.15)",
                  }}
                >
                  {pr}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Safe activation controls                                          */
/* ------------------------------------------------------------------ */

function ActivationControls({
  snapshotId,
  plan,
  onActivated,
}: {
  snapshotId: string;
  plan: RestorePlan;
  onActivated?: (snapshotId: string) => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<ActivationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runActivation = async () => {
    setIsRunning(true);
    setError(null);
    try {
      const activation = await apiActivateSnapshot(snapshotId);
      setResult(activation);
      setConfirming(false);
      await onActivated?.(snapshotId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Activation failed");
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div
      className="rounded-xl border border-accent/20 p-3 space-y-2"
      style={{ background: "rgba(96,165,250,0.05)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-[11px] font-semibold text-white/90">Activate combination</h4>
          <p className="text-[9px] text-muted/60 mt-0.5 leading-relaxed">
            Live state is re-checked before clean branch switches or confined worktree creation.
            Blocked repositories remain untouched. No fetch, stash, reset, discard, force, or branch rewrite.
          </p>
        </div>
        {!confirming && (
          <button
            onClick={() => setConfirming(true)}
            disabled={isRunning || plan.summary.autoExecutable === 0}
            className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-semibold bg-accent/15 text-accent border border-accent/25 disabled:opacity-30"
            aria-label="Activate combination"
          >
            <Play size={11} aria-hidden="true" />
            Activate
          </button>
        )}
      </div>

      {confirming && (
        <div className="rounded-lg border border-warn/20 bg-warn/5 p-2.5">
          <p className="text-[10px] text-warn/80 font-medium">
            Check {plan.summary.autoExecutable} safe entr{plan.summary.autoExecutable === 1 ? "y" : "ies"} and apply only the required mutations.
            {plan.summary.requiresManual > 0 && ` ${plan.summary.requiresManual} blocked entries will be skipped.`}
          </p>
          <div className="flex gap-1.5 mt-2">
            <button
              onClick={() => void runActivation()}
              disabled={isRunning}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold bg-accent/20 text-accent border border-accent/25 disabled:opacity-40"
              aria-label="Confirm combination activation"
            >
              {isRunning ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Play size={11} aria-hidden="true" />}
              {isRunning ? "Activating…" : "Confirm activation"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={isRunning}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] text-muted/60 border border-border/30 disabled:opacity-40"
            >
              <X size={10} aria-hidden="true" /> Cancel
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-[9px] text-danger/80 font-mono">{error}</p>}

      {result && (
        <div className="space-y-1.5" aria-live="polite">
          <p className="text-[10px] text-muted/70">
            {result.summary.succeeded} changed · {result.summary.alreadySatisfied} already satisfied · {result.summary.blocked} blocked · {result.summary.failed} failed
          </p>
          {result.repos.map((repo) => (
            <div key={repo.repoId} className="flex items-start justify-between gap-2 rounded-md bg-surface/30 px-2 py-1.5">
              <div className="min-w-0">
                <span className="text-[10px] font-medium text-white/80">{repo.repoId}</span>
                <p className="text-[9px] text-muted/50 truncate">{repo.message}</p>
              </div>
              <span
                className={cn(
                  "text-[8px] uppercase tracking-wide shrink-0",
                  repo.status === "success" || repo.status === "already-satisfied"
                    ? "text-success/80"
                    : repo.status === "blocked"
                      ? "text-warn/80"
                      : "text-danger/80"
                )}
              >
                {repo.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Loading / Error states                                             */
/* ------------------------------------------------------------------ */

export function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-2.5">
      <div className="h-4 w-2/3 rounded" style={{ background: "rgba(255,255,255,0.06)" }} />
      <div className="h-2 w-1/2 rounded" style={{ background: "rgba(255,255,255,0.04)" }} />
      <div className="h-20 rounded-xl" style={{ background: "rgba(255,255,255,0.04)" }} />
      <div className="h-20 rounded-xl" style={{ background: "rgba(255,255,255,0.04)" }} />
    </div>
  );
}

export function DetailError({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2.5 p-3 rounded-xl animate-in"
      style={{
        background: "rgba(248,113,113,0.06)",
        border: "1px solid rgba(248,113,113,0.15)",
      }}
    >
      <AlertTriangle size={14} className="shrink-0 mt-0.5" style={{ color: "var(--danger)" }} />
      <div>
        <p className="text-[11px] font-semibold" style={{ color: "rgb(248,113,113)" }}>
          Failed to load snapshot
        </p>
        <p className="text-[10px] mt-0.5 font-mono" style={{ color: "rgba(248,113,113,0.7)" }}>
          {message}
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main detail component                                              */
/* ------------------------------------------------------------------ */

export interface SnapshotDetailProps {
  snapshotId: string | null;
  schema: SnapshotSchema | null;
  drift: DriftResult | null;
  plan: RestorePlan | null;
  isLoading: boolean;
  error: string | null;
  onActivated?: (snapshotId: string) => void | Promise<void>;
}

export function SnapshotDetail({
  snapshotId,
  schema,
  drift,
  plan,
  isLoading,
  error,
  onActivated,
}: SnapshotDetailProps) {
  if (isLoading) return <DetailSkeleton />;

  if (error) return <DetailError message={error} />;

  if (!schema) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-xs" style={{ color: "var(--ink-muted)" }}>
          Select a snapshot to view details
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary */}
      <SnapshotSummary schema={schema} />

      {/* Drift summary */}
      {drift && <DriftSummaryBar summary={drift.summary} />}

      {/* Repo drift list */}
      {drift && drift.repos.length > 0 && (
        <div>
          <h4
            className="text-[10px] font-semibold uppercase tracking-[.08em] mb-2"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Repository Drift
          </h4>
          <div className="space-y-1.5 max-h-[35vh] overflow-y-auto pr-1">
            {drift.repos.map((result) => (
              <RepoDriftCard key={result.repoId} result={result} />
            ))}
          </div>
        </div>
      )}

      {/* Restore plan */}
      {plan && plan.repos.length > 0 && (
        <>
          <hr
            className="border-0 h-px"
            style={{ background: "var(--color-border)" }}
          />
          <RestorePlanSection plan={plan} />
          {snapshotId && (
            <ActivationControls
              snapshotId={snapshotId}
              plan={plan}
              onActivated={onActivated}
            />
          )}
        </>
      )}
    </div>
  );
}
