"use client";

import { useMemo, useCallback } from "react";
import type { RepoView } from "@/lib/api/workspace";
import { useWorkspaceContext } from "./workspace-context";
import { cn } from "@/lib/utils";
import {
  FolderGit2,
  RefreshCw,
  GitBranch,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Workflow,
  FolderOpen,
  Layers,
  Camera,
  Rocket,
  Network,
  FileJson,
} from "lucide-react";
import {
  computeSummaryMetrics,
  type RepoHealthFilter,
} from "@/lib/api/workspace-summary";

/* ------------------------------------------------------------------ */
/*  Metric badge sub-component                                        */
/* ------------------------------------------------------------------ */

interface MetricBadgeProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  variant?: "default" | "warn" | "danger" | "info";
  detail?: string;
  filter?: RepoHealthFilter;
  active?: boolean;
  onSelect?: (filter: RepoHealthFilter) => void;
}

function MetricBadge({
  icon,
  label,
  value,
  variant = "default",
  detail,
  filter,
  active = false,
  onSelect,
}: MetricBadgeProps) {
  const colorStyles = {
    default: "text-muted/60",
    warn: "text-warn/70",
    danger: "text-danger/70",
    info: "text-accent/70",
  };

  const className = cn(
    "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-all",
    filter && "cursor-pointer hover:-translate-y-px hover:border-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
    active
      ? "bg-accent/15 border-accent/35 shadow-[0_0_0_1px_rgba(96,165,250,0.08)]"
      : variant === "danger"
        ? "bg-danger/8 border-danger/15"
        : variant === "warn"
          ? "bg-warn/8 border-warn/15"
          : variant === "info"
            ? "bg-accent/8 border-accent/12"
            : "bg-surface/30 border-border/30"
  );
  const content = (
    <>
      <span className={cn("shrink-0", colorStyles[variant])} aria-hidden="true">
        {icon}
      </span>
      <span className="text-[11px] font-semibold tabular-nums text-white/90">
        {value}
      </span>
      <span className="text-[9px] text-muted/50 hidden sm:inline">{label}</span>
    </>
  );

  if (filter && onSelect) {
    return (
      <button
        type="button"
        className={className}
        title={`${detail || label}. Filter repository list.`}
        aria-label={`Filter repositories: ${label}`}
        aria-pressed={active}
        onClick={() => onSelect(filter)}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={className}
      title={detail || label}
    >
      {content}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Quick link sub-component                                          */
/* ------------------------------------------------------------------ */

interface QuickLinkProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}

function QuickLink({ icon, label, onClick }: QuickLinkProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium text-muted/60 hover:text-accent hover:bg-accent/8 border border-transparent hover:border-accent/15 transition-all"
    >
      {icon}
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

export interface WorkspaceSummaryProps {
  /** Display name of the current workspace */
  workspaceName: string;
  /** Absolute path to the .code-workspace file (shown de-emphasized) */
  workspacePath: string;
  /** All discovered repositories from the workspace scan */
  repositories: RepoView[];
  /** Scan-level errors from workspace loading */
  scanErrors: string[];
  /** Called when the user clicks the refresh button */
  onRefresh: () => void;
  /** Whether a parent-level refresh is currently in flight */
  isRefreshing: boolean;
  /** Navigate to a primary tab. Tab ids: "workspace", "combinations", "deployments", "dependencies" */
  onNavigate: (tab: string) => void;
  /** Navigate to a workspace sub-tab (e.g. "repos" sub-tab when tab="workspace") */
  onNavigateSub?: (subTab: string) => void;
  activeRepoFilter: RepoHealthFilter;
  onRepoFilter: (filter: RepoHealthFilter) => void;
}

/* ------------------------------------------------------------------ */
/*  Summary component                                                  */
/* ------------------------------------------------------------------ */

export function WorkspaceSummary({
  workspaceName,
  workspacePath,
  repositories,
  scanErrors,
  onRefresh,
  isRefreshing,
  onNavigate,
  onNavigateSub,
  activeRepoFilter,
  onRepoFilter,
}: WorkspaceSummaryProps) {
  const { gitStatusMap } = useWorkspaceContext();

  /* ── Derived metrics ──────────────────────────────────────────── */
  const metrics = useMemo(
    () => ({
      ...computeSummaryMetrics(repositories, gitStatusMap),
      scanErrorCount: scanErrors.length,
    }),
    [repositories, gitStatusMap, scanErrors]
  );

  const hasAnythingToShow =
    metrics.totalRepos > 0 ||
    metrics.missingFolderCount > 0 ||
    metrics.scanErrorCount > 0;

  /* ── Navigation helpers ───────────────────────────────────────── */
  const goToRepos = useCallback(() => {
    onNavigateSub?.("repos");
    onNavigate("workspace");
  }, [onNavigate, onNavigateSub]);

  const selectRepoFilter = useCallback((filter: RepoHealthFilter) => {
    onRepoFilter(filter);
    goToRepos();
  }, [goToRepos, onRepoFilter]);

  const goToCombinations = useCallback(
    () => onNavigate("combinations"),
    [onNavigate]
  );
  const goToDeployments = useCallback(
    () => onNavigate("deployments"),
    [onNavigate]
  );
  const goToDependencies = useCallback(
    () => onNavigate("dependencies"),
    [onNavigate]
  );

  /* ── Render ───────────────────────────────────────────────────── */
  return (
    <div className="animate-in">
      {/* Header: workspace name + path */}
      <div className="flex items-center justify-between mb-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Layers
              size={14}
              className="text-accent shrink-0"
              aria-hidden="true"
            />
            <h2 className="text-sm font-semibold text-white tracking-tight truncate">
              {workspaceName}
            </h2>
          </div>
          <p className="text-[10px] text-muted/40 font-mono truncate mt-0.5 ml-[22px]">
            {workspacePath}
          </p>
        </div>

        {/* Refresh */}
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="ml-2 p-1.5 text-muted/40 hover:text-accent transition-colors rounded-md hover:bg-surface/30 disabled:opacity-30"
          aria-label="Refresh workspace"
          title="Refresh workspace data"
        >
          <RefreshCw
            size={13}
            className={cn(isRefreshing && "animate-spin")}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Metrics bar — only when there's data */}
      {hasAnythingToShow && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
          {/* Total repos */}
          <MetricBadge
            icon={<FolderGit2 size={12} aria-hidden="true" />}
            label="repos"
            value={metrics.totalRepos}
            detail={`${metrics.totalRepos} Git ${metrics.totalRepos === 1 ? "repository" : "repositories"} discovered`}
            filter="all"
            active={activeRepoFilter === "all"}
            onSelect={selectRepoFilter}
          />

          {/* Dirty repos */}
          {metrics.dirtyRepos > 0 && (
            <MetricBadge
              icon={<GitBranch size={12} aria-hidden="true" />}
              label="dirty"
              value={metrics.dirtyRepos}
              variant="warn"
              detail={`${metrics.dirtyRepos} ${metrics.dirtyRepos === 1 ? "repo has" : "repos have"} uncommitted changes`}
              filter="dirty"
              active={activeRepoFilter === "dirty"}
              onSelect={selectRepoFilter}
            />
          )}

          {/* Conflicted repos */}
          {metrics.conflictedRepos > 0 && (
            <MetricBadge
              icon={<AlertTriangle size={12} aria-hidden="true" />}
              label="conflicts"
              value={metrics.conflictedRepos}
              variant="danger"
              detail={`${metrics.conflictedRepos} ${metrics.conflictedRepos === 1 ? "repo has" : "repos have"} merge conflicts`}
              filter="conflicts"
              active={activeRepoFilter === "conflicts"}
              onSelect={selectRepoFilter}
            />
          )}

          {/* Ahead total */}
          {metrics.aheadTotal > 0 && (
            <MetricBadge
              icon={<ArrowUp size={12} aria-hidden="true" />}
              label="ahead"
              value={metrics.aheadTotal}
              variant="info"
              detail={`${metrics.aheadTotal} commits ahead across all repos`}
              filter="ahead"
              active={activeRepoFilter === "ahead"}
              onSelect={selectRepoFilter}
            />
          )}

          {/* Behind total */}
          {metrics.behindTotal > 0 && (
            <MetricBadge
              icon={<ArrowDown size={12} aria-hidden="true" />}
              label="behind"
              value={metrics.behindTotal}
              variant="warn"
              detail={`${metrics.behindTotal} commits behind across all repos`}
              filter="behind"
              active={activeRepoFilter === "behind"}
              onSelect={selectRepoFilter}
            />
          )}

          {/* Secondary worktrees */}
          {metrics.secondaryWorktreeCount > 0 && (
            <MetricBadge
              icon={<Workflow size={12} aria-hidden="true" />}
              label="worktrees"
              value={metrics.secondaryWorktreeCount}
              variant="info"
              detail={`${metrics.secondaryWorktreeCount} secondary ${metrics.secondaryWorktreeCount === 1 ? "worktree" : "worktrees"}`}
              filter="worktrees"
              active={activeRepoFilter === "worktrees"}
              onSelect={selectRepoFilter}
            />
          )}

          {/* Status errors */}
          {metrics.reposWithStatusErrors > 0 && (
            <MetricBadge
              icon={<AlertTriangle size={12} aria-hidden="true" />}
              label="errors"
              value={metrics.reposWithStatusErrors}
              variant="danger"
              detail={`${metrics.reposWithStatusErrors} ${metrics.reposWithStatusErrors === 1 ? "repo has" : "repos have"} status errors`}
              filter="errors"
              active={activeRepoFilter === "errors"}
              onSelect={selectRepoFilter}
            />
          )}

          {/* Missing folders */}
          {metrics.missingFolderCount > 0 && (
            <MetricBadge
              icon={<FolderOpen size={12} aria-hidden="true" />}
              label="missing"
              value={metrics.missingFolderCount}
              variant="danger"
              detail={`${metrics.missingFolderCount} folder${metrics.missingFolderCount !== 1 ? "s" : ""} not found on disk`}
              filter="missing"
              active={activeRepoFilter === "missing"}
              onSelect={selectRepoFilter}
            />
          )}

          {/* Scan errors */}
          {metrics.scanErrorCount > 0 && (
            <MetricBadge
              icon={<FileJson size={12} aria-hidden="true" />}
              label="scan errors"
              value={metrics.scanErrorCount}
              variant="danger"
              detail={`${metrics.scanErrorCount} scan-level ${metrics.scanErrorCount === 1 ? "error" : "errors"} from workspace loading`}
            />
          )}

        </div>
      )}

      {/* Quick links */}
      <div className="flex flex-wrap items-center gap-1">
        <QuickLink
          icon={<FolderGit2 size={11} aria-hidden="true" />}
          label="Repositories"
          onClick={goToRepos}
        />
        <QuickLink
          icon={<Camera size={11} aria-hidden="true" />}
          label="Combinations"
          onClick={goToCombinations}
        />
        <QuickLink
          icon={<Rocket size={11} aria-hidden="true" />}
          label="Deployments"
          onClick={goToDeployments}
        />
        <QuickLink
          icon={<Network size={11} aria-hidden="true" />}
          label="Dependencies"
          onClick={goToDependencies}
        />
      </div>
    </div>
  );
}
