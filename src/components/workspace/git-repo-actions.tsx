"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import type {
  GitStatusView,
  ActionProgress,
  PreflightResult,
} from "@/lib/api/git";
import {
  preflightAction,
  executeFetch,
  executeSwitch,
  executeWorktreeCreate,
  executeWorktreeRemove,
  getSwitchDisabledReason,
} from "@/lib/api/git";
import {
  createVSCodeFileUri,
  displayRef,
  normalizeSwitchInput,
} from "@/lib/git/uri-helpers";
import {
  GitPullRequest,
  GitBranch,
  Workflow,
  Trash2,
  ExternalLink,
  AlertTriangle,
  CheckCircle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface GitRepoActionsProps {
  repoId: string;
  status: GitStatusView | undefined;
  onActionComplete: () => void;
}

/* ------------------------------------------------------------------ */
/*  Action button sub-component with progress                          */
/* ------------------------------------------------------------------ */

interface ActionButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
  progress: ActionProgress;
  variant?: "primary" | "secondary" | "danger";
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled = false,
  disabledReason,
  progress,
  variant = "secondary",
}: ActionButtonProps) {
  const isBusy =
    progress.status === "preflighting" || progress.status === "executing";
  const isError = progress.status === "error";
  const isSuccess = progress.status === "success";

  return (
    <div>
      <button
        onClick={onClick}
        disabled={disabled || isBusy}
        title={disabledReason ?? undefined}
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium transition-all",
          "disabled:opacity-30 disabled:cursor-not-allowed",
          isBusy && "opacity-60 cursor-wait",
          variant === "primary" &&
            "bg-accent/15 text-accent border border-accent/20 hover:bg-accent/25",
          variant === "secondary" &&
            "bg-surface/40 text-muted/70 border border-border/40 hover:bg-surface/60 hover:text-white/80",
          variant === "danger" &&
            "bg-danger/10 text-danger/70 border border-danger/20 hover:bg-danger/20"
        )}
        aria-label={label}
      >
        {isBusy ? (
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        ) : isSuccess ? (
          <CheckCircle size={11} className="text-success" aria-hidden="true" />
        ) : (
          icon
        )}
        {isBusy ? "Working..." : label}
      </button>
      {disabledReason && !isBusy && (
        <p className="text-[8px] text-muted/40 mt-0.5 font-mono max-w-[180px] leading-tight">
          {disabledReason}
        </p>
      )}
      {isError && (
        <p className="text-[8px] text-danger/60 mt-0.5 font-mono max-w-[200px] leading-tight">
          {progress.message}
        </p>
      )}
      {isSuccess && (
        <p className="text-[8px] text-success/60 mt-0.5 font-mono leading-tight">
          {progress.message}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Confirmation dialog                                                */
/* ------------------------------------------------------------------ */

function ConfirmationDialog({
  preflight,
  onConfirm,
  onCancel,
}: {
  preflight: PreflightResult;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-2 p-2.5 rounded-lg bg-surface/60 border border-border/40 animate-in">
      <div className="flex items-start gap-1.5 mb-2">
        <AlertTriangle size={11} className="text-warn shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <p className="text-[10px] font-semibold text-white/80">
            Confirm {preflight.action.replace("-", " ")}
          </p>
          <p className="text-[9px] text-muted/60 mt-0.5 leading-relaxed">
            {preflight.desiredState}
          </p>
        </div>
      </div>

      {/* Warnings */}
      {preflight.warnings.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {preflight.warnings.map((w, i) => (
            <p key={i} className="text-[9px] text-warn/60 font-mono leading-relaxed">
              ⚠ {w}
            </p>
          ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={onConfirm}
          className="px-3 py-1.5 rounded-md text-[10px] font-semibold bg-accent/20 text-accent border border-accent/30 hover:bg-accent/30 transition-colors"
        >
          Proceed
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md text-[10px] text-muted/60 hover:text-white/80 border border-border/40 hover:bg-surface/40 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function GitRepoActions({
  repoId,
  status,
  onActionComplete,
}: GitRepoActionsProps) {
  const [fetchProgress, setFetchProgress] = useState<ActionProgress>({
    status: "idle",
  });
  const [switchProgress, setSwitchProgress] = useState<ActionProgress>({
    status: "idle",
  });
  const [wtCreateProgress, setWtCreateProgress] = useState<ActionProgress>({
    status: "idle",
  });
  const [wtRemoveProgress, setWtRemoveProgress] = useState<ActionProgress>({
    status: "idle",
  });
  const [targetBranch, setTargetBranch] = useState("");
  const [selectedRemote, setSelectedRemote] = useState("");
  const [removingPath, setRemovingPath] = useState<string | null>(null);

  const orderedRemotes = useMemo(() => {
    const remotes = [...(status?.remotes ?? [])];
    return remotes.sort((left, right) => {
      if (left === "origin") return -1;
      if (right === "origin") return 1;
      return left.localeCompare(right);
    });
  }, [status?.remotes]);
  const activeRemote = orderedRemotes.includes(selectedRemote)
    ? selectedRemote
    : (orderedRemotes[0] ?? "");
  const remoteBranchOptions = useMemo(() => {
    if (!activeRemote) return [];
    const prefix = `refs/remotes/${activeRemote}/`;
    return (status?.remoteRefs ?? [])
      .filter((ref) => ref.startsWith(prefix) && ref !== `${prefix}HEAD`)
      .map(displayRef);
  }, [activeRemote, status?.remoteRefs]);

  const [confirmAction, setConfirmAction] = useState<{
    type: "switch" | "worktree-create" | "worktree-remove";
    preflight: PreflightResult;
  } | null>(null);

  /* ── Fetch (no confirmation needed) ──────────────────────── */

  const handleFetch = useCallback(async () => {
    setFetchProgress({ status: "preflighting" });
    try {
      const remote = activeRemote;
      if (!remote) {
        setFetchProgress({ status: "error", message: "No configured remote" });
        return;
      }
      const pf = await preflightAction("fetch", repoId, remote);
      if (!pf.allowed) {
        setFetchProgress({
          status: "error",
          message: pf.blockers.join("; "),
        });
        return;
      }
      setFetchProgress({ status: "executing" });
      const result = await executeFetch(repoId, remote);
      if (result.success) {
        setFetchProgress({
          status: "success",
          message: `Fetched from ${remote} (${result.durationMs}ms)`,
        });
        onActionComplete();
      } else {
        setFetchProgress({
          status: "error",
          message: result.error ?? "Fetch failed",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setFetchProgress({ status: "error", message: msg });
    }
  }, [repoId, onActionComplete, activeRemote]);

  /* ── Switch (preflight → confirm → execute) ─────────────── */

  const switchDisabledReason = getSwitchDisabledReason(status);

  const handleSwitchClick = useCallback(async () => {
    if (!status || !targetBranch.trim()) return;
    setSwitchProgress({ status: "preflighting" });
    try {
      const { target, createTracking } = normalizeSwitchInput(
        targetBranch.trim(),
        status.remotes
      );
      const pf = await preflightAction(
        "switch",
        repoId,
        target,
        undefined,
        createTracking
      );
      if (!pf.allowed) {
        setSwitchProgress({
          status: "error",
          message: pf.blockers.join("; "),
        });
        return;
      }
      if (pf.requiresConfirmation) {
        setConfirmAction({ type: "switch", preflight: pf });
        setSwitchProgress({ status: "confirming", preflight: pf });
      } else {
        setSwitchProgress({ status: "executing" });
        const result = await executeSwitch(repoId, target, createTracking);
        if (result.success) {
          setSwitchProgress({
            status: "success",
            message: `Switched to ${result.newBranch}`,
          });
          onActionComplete();
        } else {
          setSwitchProgress({
            status: "error",
            message: result.error ?? "Switch failed",
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setSwitchProgress({ status: "error", message: msg });
    }
  }, [repoId, status, targetBranch, onActionComplete]);

  const handleSwitchConfirm = useCallback(async () => {
    if (!confirmAction || confirmAction.type !== "switch") return;
    setConfirmAction(null);
    setSwitchProgress({ status: "executing" });
    try {
      const target = confirmAction.preflight.target;
      const result = await executeSwitch(
        repoId,
        target,
        confirmAction.preflight.target.startsWith("refs/remotes/")
      );
      if (result.success) {
        setSwitchProgress({
          status: "success",
          message: `Switched to ${result.newBranch}`,
        });
        onActionComplete();
      } else {
        setSwitchProgress({
          status: "error",
          message: result.error ?? "Switch failed",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setSwitchProgress({ status: "error", message: msg });
    }
  }, [confirmAction, repoId, onActionComplete]);

  /* ── Worktree create (preflight → confirm → execute) ────── */

  /**
   * Detect if the input looks like a remote-prefixed ref (e.g. "origin/feature/foo")
   * and extract the plain branch name + baseRef for worktree creation.
   */
  function normalizeWorktreeInput(
    input: string,
    knownRemotes: string[]
  ): { branch: string; baseRef?: string } {
    for (const remote of knownRemotes) {
      const prefix = `${remote}/`;
      if (input.startsWith(prefix)) {
        return { branch: input.slice(prefix.length), baseRef: input };
      }
    }
    return { branch: input };
  }

  const wtBaseRefRef = useRef<string | undefined>(undefined);
  const [lastWorktreePath, setLastWorktreePath] = useState<string | null>(null);

  const handleWorktreeCreateClick = useCallback(async () => {
    if (!status || !targetBranch.trim()) return;
    setLastWorktreePath(null);
    setWtCreateProgress({ status: "preflighting" });
    try {
      const raw = targetBranch.trim();
      const { branch, baseRef } = normalizeWorktreeInput(raw, status.remotes);
      const pf = await preflightAction("worktree-create", repoId, branch);
      if (!pf.allowed) {
        setWtCreateProgress({
          status: "error",
          message: pf.blockers.join("; "),
        });
        return;
      }
      wtBaseRefRef.current = baseRef;
      setConfirmAction({ type: "worktree-create", preflight: pf });
      setWtCreateProgress({ status: "confirming", preflight: pf });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setWtCreateProgress({ status: "error", message: msg });
    }
  }, [repoId, status, targetBranch]);

  const handleWtCreateConfirm = useCallback(async () => {
    if (!confirmAction || confirmAction.type !== "worktree-create") return;
    const baseRef = wtBaseRefRef.current;
    wtBaseRefRef.current = undefined;
    setConfirmAction(null);
    setWtCreateProgress({ status: "executing" });
    try {
      const branch = confirmAction.preflight.target;
      const result = await executeWorktreeCreate(repoId, branch, undefined, baseRef);
      if (result.success) {
        setLastWorktreePath(result.path);
        setWtCreateProgress({
          status: "success",
          message: `Worktree created at ${result.path}`,
        });
        onActionComplete();
      } else {
        setWtCreateProgress({
          status: "error",
          message: result.error ?? "Worktree create failed",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setWtCreateProgress({ status: "error", message: msg });
    }
  }, [confirmAction, repoId, onActionComplete]);

  /* ── Worktree remove (preflight → confirm → execute) ────── */

  const handleWorktreeRemoveClick = useCallback(
    async (wtPath: string) => {
      setWtRemoveProgress({ status: "preflighting" });
      setRemovingPath(wtPath);
      try {
        const pf = await preflightAction("worktree-remove", repoId, wtPath);
        if (!pf.allowed) {
          setWtRemoveProgress({
            status: "error",
            message: pf.blockers.join("; "),
          });
          return;
        }
        setConfirmAction({ type: "worktree-remove", preflight: pf });
        setWtRemoveProgress({ status: "confirming", preflight: pf });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setWtRemoveProgress({ status: "error", message: msg });
      }
    },
    [repoId]
  );

  const handleWtRemoveConfirm = useCallback(async () => {
    if (!confirmAction || confirmAction.type !== "worktree-remove") return;
    setConfirmAction(null);
    setWtRemoveProgress({ status: "executing" });
    try {
      const path = confirmAction.preflight.target;
      const result = await executeWorktreeRemove(repoId, path);
      if (result.success) {
        setWtRemoveProgress({
          status: "success",
          message: `Worktree removed`,
        });
        onActionComplete();
      } else {
        setWtRemoveProgress({
          status: "error",
          message: result.error ?? "Worktree remove failed",
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setWtRemoveProgress({ status: "error", message: msg });
    }
  }, [confirmAction, repoId, onActionComplete]);

  /* ── Cancel confirmation ────────────────────────────────── */

  const handleCancelConfirm = useCallback(() => {
    setConfirmAction(null);
    // Reset the relevant progress state
    setSwitchProgress({ status: "idle" });
    setWtCreateProgress({ status: "idle" });
    setWtRemoveProgress({ status: "idle" });
    setRemovingPath(null);
  }, []);

  /* ── Render ─────────────────────────────────────────────── */

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {status && orderedRemotes.length > 0 && (
          <label className="flex items-center gap-1.5">
            <span className="text-[8px] uppercase tracking-wide text-muted/40">Remote</span>
            <select
              value={activeRemote}
              onChange={(event) => {
                setSelectedRemote(event.target.value);
                setTargetBranch("");
              }}
              aria-label="Fetch remote"
              className="h-7 rounded-md border border-border/40 bg-surface/40 px-2 text-[10px] font-mono text-white outline-none focus:border-accent/40"
            >
              {orderedRemotes.map((remote) => <option key={remote} value={remote}>{remote}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-1.5 min-w-[220px] grow max-w-[360px]">
          <span className="text-[8px] uppercase tracking-wide text-muted/40">Branch</span>
        <input
          value={targetBranch}
          onChange={(event) => setTargetBranch(event.target.value)}
          list={`branches-${repoId}`}
          placeholder={activeRemote ? `Branch on ${activeRemote} or local ref` : "Local branch or ref"}
          aria-label="Target branch or remote ref"
          className="h-7 min-w-[180px] rounded-md border border-border/40 bg-surface/40 px-2 text-[10px] font-mono text-white outline-none focus:border-accent/40"
        />
        <datalist id={`branches-${repoId}`}>
          {remoteBranchOptions.map((branch) => <option key={`remote-${branch}`} value={branch} />)}
          {status?.localBranches.map((branch) => <option key={`local-${branch}`} value={branch} />)}
        </datalist>
        </label>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <a
          href={status ? createVSCodeFileUri(status.rootPath) : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium border transition-all",
            status ? "bg-surface/40 text-muted/70 border-border/40 hover:text-white/80" : "pointer-events-none opacity-30"
          )}
          aria-label="Open checkout in VS Code"
        >
          <ExternalLink size={10} aria-hidden="true" />
          Open Checkout
        </a>
        {/* Fetch */}
        <ActionButton
          label="Fetch"
          icon={<GitPullRequest size={10} aria-hidden="true" />}
          onClick={handleFetch}
          progress={fetchProgress}
          variant="secondary"
        />

        {/* Worktree create (primary action) */}
        <ActionButton
          label="Create Worktree"
          icon={<Workflow size={10} aria-hidden="true" />}
          onClick={handleWorktreeCreateClick}
          disabled={!status || !targetBranch.trim()}
          disabledReason={!status ? "Status not loaded" : !targetBranch.trim() ? "Choose a branch" : undefined}
          progress={wtCreateProgress}
          variant="primary"
        />

        {/* Switch (secondary — disabled when unsafe) */}
        <ActionButton
          label="Switch Branch"
          icon={<GitBranch size={10} aria-hidden="true" />}
          onClick={handleSwitchClick}
          disabled={!!switchDisabledReason || !status || !targetBranch.trim()}
          disabledReason={switchDisabledReason ?? (!targetBranch.trim() ? "Choose a branch" : undefined)}
          progress={switchProgress}
          variant="secondary"
        />
      </div>

      {/* "Open in VS Code" action after successful worktree create */}
      {lastWorktreePath && wtCreateProgress.status === "success" && (
        <div className="flex items-center gap-1.5 pt-1">
          <a
            href={createVSCodeFileUri(lastWorktreePath)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-md border border-accent/20 bg-accent/10 px-2 py-1 text-[9px] text-accent hover:bg-accent/20 transition-colors"
            aria-label={`Open worktree in VS Code`}
          >
            <ExternalLink size={9} aria-hidden="true" />
            Open in VS Code
          </a>
        </div>
      )}

      {status && status.secondaryWorktrees.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[9px] text-muted/50 font-mono mr-0.5">
            Secondary worktrees:
          </span>
          {status.secondaryWorktrees.map((worktree) => (
            <div
              key={worktree.path}
              className="inline-flex items-center gap-1 rounded-md border border-border/30 px-1.5 py-1"
            >
              <span className="text-[9px] text-accent/60 font-mono max-w-[120px] truncate">
                {worktree.branch ?? "(detached)"}
              </span>
              {/* Open in VS Code */}
              <a
                href={createVSCodeFileUri(worktree.path)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent/50 hover:text-accent transition-colors"
                aria-label={`Open ${worktree.branch ?? "worktree"} in VS Code`}
                title="Open in VS Code"
              >
                <ExternalLink size={9} aria-hidden="true" />
              </a>
              {/* Remove */}
              <button
                onClick={() => handleWorktreeRemoveClick(worktree.path)}
                disabled={wtRemoveProgress.status === "preflighting" || wtRemoveProgress.status === "executing"}
                className="text-danger/50 hover:text-danger transition-colors"
                aria-label={`Remove worktree ${worktree.branch ?? "detached"}`}
                title="Remove worktree"
              >
                {removingPath === worktree.path && (wtRemoveProgress.status === "preflighting" || wtRemoveProgress.status === "executing")
                  ? <Loader2 size={9} className="animate-spin" aria-hidden="true" />
                  : <Trash2 size={9} aria-hidden="true" />}
              </button>
            </div>
          ))}
        </div>
      )}

      {wtRemoveProgress.status === "error" && (
        <p className="text-[8px] text-danger/60 font-mono">{wtRemoveProgress.message}</p>
      )}
      {wtRemoveProgress.status === "success" && (
        <p className="text-[8px] text-success/60 font-mono">{wtRemoveProgress.message}</p>
      )}

      {/* Confirmation dialog */}
      {confirmAction && (
        <ConfirmationDialog
          preflight={confirmAction.preflight}
          onConfirm={
            confirmAction.type === "switch"
              ? handleSwitchConfirm
              : confirmAction.type === "worktree-create"
                ? handleWtCreateConfirm
                : handleWtRemoveConfirm
          }
          onCancel={handleCancelConfirm}
        />
      )}
    </div>
  );
}
