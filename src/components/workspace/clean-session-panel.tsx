"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  SessionPlan,
  RepoSessionPlan,
  RepoSessionResult,
  SessionExecution,
} from "@/lib/api/git";
import { fetchSessionPlan, executeSessionStart } from "@/lib/api/git";
import { createVSCodeFileUri } from "@/lib/git/uri-helpers";
import {
  Play,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface CleanSessionPanelProps {
  repoIds: string[];
  onSessionComplete: () => void;
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

type PanelState =
  | { status: "idle" }
  | { status: "loading-plan" }
  | { status: "preview"; plan: SessionPlan }
  | { status: "error"; message: string }
  | { status: "executing" }
  | { status: "done"; execution: SessionExecution };

/* ------------------------------------------------------------------ */
/*  Status badge helper                                                */
/* ------------------------------------------------------------------ */

function StatusBadge({
  status,
}: {
  status: RepoSessionPlan["status"];
}) {
  const styles: Record<string, string> = {
    ready: "text-success/70 bg-success/10 border-success/20",
    needs_fetch: "text-warn/70 bg-warn/10 border-warn/20",
    no_remote_ref: "text-danger/70 bg-danger/10 border-danger/20",
    no_suitable_remote: "text-danger/70 bg-danger/10 border-danger/20",
  };
  const labels: Record<string, string> = {
    ready: "Policy resolved",
    needs_fetch: "Needs fetch",
    no_remote_ref: "No ref",
    no_suitable_remote: "No remote",
  };
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[8px] font-semibold border",
        styles[status] ?? "text-muted/50 bg-surface/30 border-border/30"
      )}
    >
      {labels[status] ?? status}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Collapsible plan list                                              */
/* ------------------------------------------------------------------ */

function RepoPlanList({ repos }: { repos: RepoSessionPlan[] }) {
  const [expanded, setExpanded] = useState(false);
  const needsExpand = repos.length > 5;
  const visible = expanded || !needsExpand ? repos : repos.slice(0, 5);

  return (
    <div className="space-y-1">
      {visible.map((r) => (
        <div
          key={r.repoId}
          className="flex items-center gap-2 px-2 py-1.5 rounded bg-surface/20 border border-border/20"
        >
          <span className="text-[9px] font-mono text-white/70 truncate flex-1 min-w-0">
            {r.displayName}
          </span>
          <span className="text-[8px] text-muted/50 font-mono whitespace-nowrap">
            {r.selectedRemote}/{r.baseBranch}
          </span>
          <StatusBadge status={r.status} />
          {r.blockers.length > 0 && (
            <span
              className="text-[7px] text-danger/50 font-mono max-w-[120px] truncate"
              title={r.blockers.join("; ")}
            >
              {r.blockers[0]}
            </span>
          )}
        </div>
      ))}
      {needsExpand && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="flex items-center gap-1 text-[8px] text-accent/60 hover:text-accent px-2 py-1"
        >
          <ChevronDown size={10} aria-hidden="true" />
          Show all {repos.length} repos
        </button>
      )}
      {needsExpand && expanded && (
        <button
          onClick={() => setExpanded(false)}
          className="flex items-center gap-1 text-[8px] text-accent/60 hover:text-accent px-2 py-1"
        >
          <ChevronRight size={10} aria-hidden="true" />
          Collapse
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Result row                                                         */
/* ------------------------------------------------------------------ */

function ResultRow({ result }: { result: RepoSessionResult }) {
  const [expanded, setExpanded] = useState(false);
  const hasError = !result.success || !result.worktree.headVerified;
  const vscodeUri = result.success
    ? createVSCodeFileUri(result.worktreePath)
    : null;

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-surface/20 border border-border/20 hover:bg-surface/30 transition-colors text-left"
      >
        {result.success ? (
          <CheckCircle size={12} className="text-success shrink-0" aria-hidden="true" />
        ) : (
          <XCircle size={12} className="text-danger shrink-0" aria-hidden="true" />
        )}
        <span className="text-[9px] font-mono text-white/70 truncate flex-1 min-w-0">
          {result.displayName}
        </span>
        <span className="text-[8px] text-muted/50 font-mono">
          {result.sessionBranch || `${result.baseBranch}`}
        </span>
        {vscodeUri && (
          <a
            href={vscodeUri}
            onClick={(e) => e.stopPropagation()}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent/60 hover:text-accent transition-colors"
            title="Open in VS Code"
            aria-label={`Open ${result.displayName} session worktree in VS Code`}
          >
            <ExternalLink size={10} aria-hidden="true" />
          </a>
        )}
        {!expanded && hasError && (
          <AlertTriangle size={10} className="text-warn shrink-0" aria-hidden="true" />
        )}
      </button>
      {expanded && (
        <div className="ml-4 mt-1 p-2 rounded bg-surface/10 border border-border/20 space-y-1">
          <div className="flex items-center gap-2 text-[8px] text-muted/50 font-mono">
            <span>Remote: {result.selectedRemote}</span>
            <span>Branch: {result.baseBranch}</span>
          </div>
          <div className="flex items-center gap-2 text-[8px] text-muted/50 font-mono">
            <span>Fetch: {result.fetch.success ? `${result.fetch.durationMs}ms` : "Failed"}</span>
            <span>
              HEAD: {result.worktree.headOid.slice(0, 8)}
              {result.worktree.headVerified ? " ✓" : " ⚠"}
            </span>
          </div>
          {result.fetch.error && (
            <p className="text-[7px] text-danger/50 font-mono">{result.fetch.error}</p>
          )}
          {result.worktree.error && (
            <p className="text-[7px] text-danger/50 font-mono">{result.worktree.error}</p>
          )}
          <p className="text-[7px] text-muted/40 font-mono truncate">{result.worktreePath}</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Summary bar for results                                            */
/* ------------------------------------------------------------------ */

function ResultSummary({ execution }: { execution: SessionExecution }) {
  const total = execution.results.length;
  const ok = execution.results.filter((r) => r.success).length;
  const failed = total - ok;
  return (
    <div className="flex items-center gap-2 text-[9px] text-muted/60">
      <span>
        {ok}/{total} repos
      </span>
      {ok > 0 && (
        <span className="text-success/60">{ok} created</span>
      )}
      {failed > 0 && (
        <span className="text-danger/60">{failed} failed</span>
      )}
      <span className="text-muted/30">·</span>
      <span className="font-mono text-[8px]">
        {execution.sessionId.slice(0, 8)}
      </span>
    </div>
  );
}

/* ================================================================== */
/*  Main component                                                     */
/* ================================================================== */

export function CleanSessionPanel({
  repoIds,
  onSessionComplete,
}: CleanSessionPanelProps) {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /* ── Load plan ────────────────────────────────────────────── */

  const loadPlan = useCallback(async () => {
    if (repoIds.length === 0) return;
    setState({ status: "loading-plan" });
    try {
      const response = await fetchSessionPlan(repoIds);
      if (!mountedRef.current) return;
      setState({ status: "preview", plan: response.plan });
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : "Failed to load plan";
      setState({ status: "error", message: msg });
    }
  }, [repoIds]);

  /* ── Execute ───────────────────────────────────────────────── */

  const handleExecute = useCallback(async () => {
    if (state.status !== "preview") return;
    setState({ status: "executing" });
    try {
      const response = await executeSessionStart(repoIds);
      if (!mountedRef.current) return;
      setState({ status: "done", execution: response.execution });
      onSessionComplete();
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : "Execution failed";
      setState({ status: "error", message: msg });
    }
  }, [state, repoIds, onSessionComplete]);

  /* ── Reset ──────────────────────────────────────────────────── */

  const reset = useCallback(() => {
    setState({ status: "idle" });
  }, []);

  /* ============================================================== */
  /*  Render                                                         */
  /* ============================================================== */

  // If executed recently, show results
  if (state.status === "done") {
    const execution = state.execution;
    const successCount = execution.results.filter((result) => result.success).length;
    const allSucceeded = successCount === execution.results.length && successCount > 0;
    return (
      <div
        className="rounded-lg bg-surface/40 border border-border/40 p-3 space-y-2 animate-in"
        aria-label="Clean session results"
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {allSucceeded ? (
              <CheckCircle size={13} className="text-success" aria-hidden="true" />
            ) : (
              <AlertTriangle size={13} className="text-warn" aria-hidden="true" />
            )}
            <span className="text-[10px] font-semibold text-white/80">
              {allSucceeded ? "Clean session created" : "Session completed with issues"}
            </span>
          </div>
          <button
            onClick={reset}
            className="text-[8px] text-muted/40 hover:text-accent transition-colors"
          >
            Dismiss
          </button>
        </div>
        <ResultSummary execution={execution} />
        <div className="space-y-1 mt-2">
          {execution.results.map((r) => (
            <ResultRow key={r.repoId} result={r} />
          ))}
        </div>
      </div>
    );
  }

  // When idle, show a compact button
  if (state.status === "idle") {
    return (
      <button
        onClick={loadPlan}
        disabled={repoIds.length === 0}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all",
          "border hover:border-accent/30",
          repoIds.length > 0
            ? "text-accent border-accent/20 bg-accent/8 hover:bg-accent/15 cursor-pointer"
            : "text-muted/40 border-border/30 bg-surface/20 cursor-not-allowed"
        )}
        title="Prepare isolated worktrees at latest upstream state for every registered repo"
        aria-label="Start clean session"
      >
        <Play size={11} aria-hidden="true" />
        Start clean session
      </button>
    );
  }

  // Loading plan
  if (state.status === "loading-plan") {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[9px] text-muted/50">
        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        Building session plan...
      </div>
    );
  }

  if (state.status === "executing") {
    return (
      <div
        className="flex items-center gap-2 rounded-lg border border-accent/20 bg-accent/8 px-3 py-2 text-[9px] text-accent/70"
        aria-live="polite"
      >
        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        Fetching remotes and creating isolated worktrees…
      </div>
    );
  }

  // Error
  if (state.status === "error") {
    return (
      <div className="rounded-lg bg-danger/8 border border-danger/20 p-3 space-y-1.5 animate-in">
        <div className="flex items-center gap-1.5">
          <AlertTriangle size={11} className="text-danger/60 shrink-0" aria-hidden="true" />
          <span className="text-[9px] font-medium text-danger/70">Session error</span>
        </div>
        <p className="text-[8px] text-danger/50 font-mono leading-relaxed">
          {state.message}
        </p>
        <div className="flex items-center gap-2">
          <button
            onClick={reset}
            className="text-[8px] px-2 py-1 rounded text-muted/60 hover:text-white/80 border border-border/30 hover:bg-surface/30 transition-colors"
          >
            Dismiss
          </button>
          <button
            onClick={loadPlan}
            className="flex items-center gap-1 text-[8px] px-2 py-1 rounded text-accent border border-accent/20 hover:bg-accent/10 transition-colors"
          >
            <RefreshCw size={9} aria-hidden="true" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Preview: show the plan with confirm button
  const plan = (state as { status: "preview"; plan: SessionPlan }).plan;
  const canExecute =
    plan.summary.ready > 0 || plan.summary.needsFetch > 0;

  return (
    <div
      className="rounded-lg bg-surface/40 border border-border/40 p-3 space-y-2.5 animate-in"
      aria-label="Clean session preview"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Play size={12} className="text-accent" aria-hidden="true" />
          <span className="text-[10px] font-semibold text-white/80">
            Clean session preview
          </span>
        </div>
        <button
          onClick={reset}
          className="text-[8px] text-muted/40 hover:text-accent transition-colors"
        >
          Cancel
        </button>
      </div>

      {/* Disclosure text */}
      <div className="text-[8px] text-muted/50 leading-relaxed bg-surface/10 rounded px-2 py-1.5 border border-border/20">
        This will <strong className="text-white/70">fetch</strong> the selected remote,
        then create a <strong className="text-white/70">new branch</strong> in an isolated worktree for each repo.
        Branch policy: <strong className="text-white/70">main → develop</strong>.
        Remote policy: <strong className="text-white/70">origin → upstream → first</strong>.
        Dirty primary checkouts are left untouched.
      </div>

      {/* Summary badges */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[8px] text-muted/60 bg-surface/30 px-1.5 py-0.5 rounded border border-border/30">
          {plan.summary.total} repos
        </span>
        {plan.summary.ready > 0 && (
          <span className="text-[8px] text-success/60 bg-success/8 px-1.5 py-0.5 rounded border border-success/20">
            {plan.summary.ready} ready
          </span>
        )}
        {plan.summary.needsFetch > 0 && (
          <span className="text-[8px] text-warn/60 bg-warn/8 px-1.5 py-0.5 rounded border border-warn/20">
            {plan.summary.needsFetch} needs fetch
          </span>
        )}
        {plan.summary.blocked > 0 && (
          <span className="text-[8px] text-danger/60 bg-danger/8 px-1.5 py-0.5 rounded border border-danger/20">
            {plan.summary.blocked} blocked
          </span>
        )}
      </div>

      {/* Repo plan list (collapsible) */}
      <RepoPlanList repos={plan.repos} />

      {/* Action button */}
      {canExecute && (
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleExecute}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[10px] font-semibold bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors"
          >
            <Play size={11} aria-hidden="true" />
            Start session
          </button>
        </div>
      )}
    </div>
  );
}
