"use client";

import type { GitStatusView } from "@/lib/api/git";
import {
  GitBranch,
  GitFork,
  ArrowUp,
  ArrowDown,
  FileEdit,
  FilePlus,
  AlertTriangle,
  Layers,
  Clock,
  XCircle,
  Workflow,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { createVSCodeFileUri } from "@/lib/git/uri-helpers";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface GitRepoStatusProps {
  status: GitStatusView;
  isExpanded?: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function StatusBadge({
  count,
  label,
  icon,
  variant = "neutral",
  title,
}: {
  count: number;
  label: string;
  icon: React.ReactNode;
  variant?: "neutral" | "warn" | "danger" | "success";
  title?: string;
}) {
  if (count === 0 && variant !== "danger") return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono font-medium",
        variant === "neutral" && "text-muted/50 bg-surface/40",
        variant === "warn" && "text-warn/70 bg-warn/10",
        variant === "danger" && "text-danger/70 bg-danger/10",
        variant === "success" && "text-success/70 bg-success/10"
      )}
      title={title ?? `${count} ${label}`}
    >
      {icon}
      {count}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function GitRepoStatus({
  status,
  isExpanded = false,
  onRefresh,
  isRefreshing = false,
}: GitRepoStatusProps) {
  const isDetached = status.currentBranch === "(detached)";
  const hasUpstream = !!status.upstream;
  const hasDiverged = status.ahead > 0 || status.behind > 0;
  const hasChanges =
    status.staged > 0 ||
    status.unstaged > 0 ||
    status.untracked > 0 ||
    status.conflicted > 0;
  const hasWt = status.worktreeCount > 1;
  const hasErrors = status.errors.length > 0;

  return (
    <div className="animate-in">
      {/* Error banner */}
      {hasErrors && (
        <div className="flex items-start gap-1.5 mb-2 p-2 rounded-lg bg-danger/10 border border-danger/20">
          <AlertTriangle
            size={11}
            className="text-danger shrink-0 mt-0.5"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            {status.errors.map((err, i) => (
              <p
                key={i}
                className="text-[10px] text-danger/70 font-mono leading-relaxed"
              >
                {err}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Branch + upstream row */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Branch name */}
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs font-mono font-medium",
            isDetached ? "text-warn" : "text-white/80"
          )}
          title={status.headRef}
        >
          <GitBranch size={12} aria-hidden="true" />
          {isDetached ? (
            <>
              (detached)
              <span className="text-[9px] text-muted/50 font-mono ml-1">
                {status.headOid.slice(0, 8)}
              </span>
            </>
          ) : (
            status.currentBranch
          )}
        </span>

        {/* Upstream */}
        {hasUpstream && (
          <span
            className="inline-flex items-center gap-1 text-[9px] text-muted/50 font-mono"
            title={`Tracking ${status.upstream}`}
          >
            <GitFork size={9} aria-hidden="true" />
            {status.upstream}
          </span>
        )}

        {/* Ahead / Behind */}
        {hasUpstream && hasDiverged && (
          <span className="inline-flex items-center gap-1.5">
            {status.ahead > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-[9px] text-success/70 font-mono"
                title={`${status.ahead} commit(s) ahead of ${status.upstream}`}
              >
                <ArrowUp size={9} aria-hidden="true" />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span
                className="inline-flex items-center gap-0.5 text-[9px] text-warn/70 font-mono"
                title={`${status.behind} commit(s) behind ${status.upstream}`}
              >
                <ArrowDown size={9} aria-hidden="true" />
                {status.behind}
              </span>
            )}
          </span>
        )}

        {/* Worktree count */}
        {hasWt && (
          <span
            className="inline-flex items-center gap-1 text-[9px] text-accent/60 font-mono"
            title={`${status.worktreeCount} worktree(s) total`}
          >
            <Workflow size={9} aria-hidden="true" />
            {status.worktreeCount}
          </span>
        )}
      </div>

      {/* Status badges row */}
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <StatusBadge
          count={status.conflicted}
          label="conflicted"
          icon={<XCircle size={9} aria-hidden="true" />}
          variant="danger"
          title={`${status.conflicted} conflicted file(s)`}
        />
        <StatusBadge
          count={status.staged}
          label="staged"
          icon={<FileEdit size={9} aria-hidden="true" />}
          variant="warn"
          title={`${status.staged} staged change(s)`}
        />
        <StatusBadge
          count={status.unstaged}
          label="unstaged"
          icon={<FileEdit size={9} aria-hidden="true" />}
          variant="warn"
          title={`${status.unstaged} unstaged change(s)`}
        />
        <StatusBadge
          count={status.untracked}
          label="untracked"
          icon={<FilePlus size={9} aria-hidden="true" />}
          variant="neutral"
          title={`${status.untracked} untracked file(s)`}
        />
        <StatusBadge
          count={status.worktreeCount}
          label={status.worktreeCount === 1 ? "worktree" : "worktrees"}
          icon={<Layers size={9} aria-hidden="true" />}
          variant="success"
          title={`${status.worktreeCount} worktree(s)`}
        />
        {!hasChanges && !hasErrors && (
          <span className="text-[9px] text-success/50 font-mono">
            Clean
          </span>
        )}

        {/* Status age */}
        <span
          className="text-[8px] text-muted/30 font-mono ml-auto"
          title={`Status gathered at ${new Date(status.cachedAt).toISOString()}`}
        >
          <Clock size={8} className="inline mr-0.5" aria-hidden="true" />
          updated
        </span>

        {/* Refresh */}
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            className="p-0.5 text-muted/30 hover:text-accent transition-colors disabled:opacity-30"
            aria-label="Refresh status"
            title="Refresh Git status"
          >
            <RefreshCw
              size={9}
              className={cn(isRefreshing && "animate-spin")}
              aria-hidden="true"
            />
          </button>
        )}
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="mt-2 pt-2 border-t border-border/20 space-y-1.5">
          {/* HEAD OID */}
          <div className="flex items-center gap-2 text-[9px] font-mono text-muted/50">
            <span className="shrink-0">HEAD</span>
            <code className="text-accent/60">{status.headOid.slice(0, 12)}...</code>
          </div>

          {/* Secondary worktree branches */}
          {status.secondaryWorktreeBranches.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] text-muted/50 font-mono shrink-0">
                Worktree branches:
              </span>
              {status.secondaryWorktreeBranches.map((branch) => (
                <span
                  key={branch}
                  className="text-[8px] text-accent/50 bg-accent/10 px-1.5 py-0.5 rounded font-mono"
                >
                  {branch}
                </span>
              ))}
            </div>
          )}

          {/* Status note about switch safety */}
          {status.staged === 0 &&
            status.unstaged === 0 &&
            status.untracked === 0 &&
            status.conflicted === 0 && (
              <p className="text-[9px] text-success/40 font-mono">
                Working tree is clean — safe to switch branches
              </p>
            )}
          {(status.staged > 0 || status.unstaged > 0 || status.untracked > 0) && (
            <p className="text-[9px] text-warn/50 font-mono">
              Uncommitted changes — direct switch disabled
            </p>
          )}
          {status.conflicted > 0 && (
            <p className="text-[9px] text-danger/50 font-mono font-semibold">
              Conflicts must be resolved before switching
            </p>
          )}

          {status.changedFiles.length > 0 && (
            <div className="pt-1.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="text-[9px] text-muted/50 font-mono">
                  Changed files ({status.changedFiles.length}{status.changesTruncated ? "+" : ""})
                </span>
                <span className="text-[8px] text-muted/30">Open to inspect</span>
              </div>
              <div className="max-h-44 overflow-y-auto rounded-lg border border-border/20 divide-y divide-border/10 bg-surface/20">
                {status.changedFiles.map((file, index) => {
                  const absolutePath = `${status.rootPath.replace(/\/$/, "")}/${file.path}`;
                  return (
                    <a
                      key={`${file.path}-${file.xy}-${index}`}
                      href={createVSCodeFileUri(absolutePath)}
                      className="flex items-center gap-2 px-2 py-1.5 hover:bg-accent/8 transition-colors group"
                      aria-label={`Open changed file ${file.path} in VS Code`}
                      title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
                    >
                      <span className={cn(
                        "w-5 shrink-0 text-[8px] font-mono font-semibold",
                        file.conflicted ? "text-danger/80" : file.untracked ? "text-muted/50" : "text-warn/70"
                      )}>
                        {file.xy}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[9px] font-mono text-white/60">
                        {file.path}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        {file.conflicted && <span className="text-[7px] text-danger/70">conflict</span>}
                        {file.staged && <span className="text-[7px] text-accent/60">staged</span>}
                        {file.unstaged && <span className="text-[7px] text-warn/60">unstaged</span>}
                        {file.untracked && <span className="text-[7px] text-muted/50">new</span>}
                        <ExternalLink size={8} className="text-muted/20 group-hover:text-accent/60" aria-hidden="true" />
                      </span>
                    </a>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Loading/Skeleton state                                             */
/* ------------------------------------------------------------------ */

export function GitRepoStatusSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      <div className="flex items-center gap-2">
        <div className="w-20 h-3 bg-surface/40 rounded" />
        <div className="w-32 h-3 bg-surface/40 rounded" />
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-8 h-3 bg-surface/40 rounded" />
        <div className="w-8 h-3 bg-surface/40 rounded" />
        <div className="w-8 h-3 bg-surface/40 rounded" />
      </div>
    </div>
  );
}
