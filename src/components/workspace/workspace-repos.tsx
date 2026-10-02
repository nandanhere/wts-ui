"use client";

import { useState, useMemo, useCallback } from "react";
import type { RepoView } from "@/lib/api/workspace";
import type { GitStatusView, StatusLoadState } from "@/lib/api/git";
import { useWorkspaceContext } from "./workspace-context";
import { GitRepoStatus, GitRepoStatusSkeleton } from "./git-repo-status";
import { GitRepoActions } from "./git-repo-actions";
import {
  Search,
  FolderGit2,
  GitBranch,
  Layers,
  Workflow,
  AlertTriangle,
  RefreshCw,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  CircleOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  matchesRepoHealthFilter,
  REPO_HEALTH_FILTER_LABELS,
  type RepoHealthFilter,
} from "@/lib/api/workspace-summary";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface WorkspaceReposProps {
  repositories: RepoView[];
  healthFilter: RepoHealthFilter;
  onHealthFilterChange: (filter: RepoHealthFilter) => void;
}

/* ------------------------------------------------------------------ */
/*  Grouped view                                                       */
/* ------------------------------------------------------------------ */

interface RepoGroup {
  label: string;
  repos: RepoView[];
}

function groupRepos(repos: RepoView[]): RepoGroup[] {
  if (repos.length === 0) return [];

  const folderMap = new Map<string, RepoView[]>();
  const ungrouped: RepoView[] = [];

  for (const repo of repos) {
    if (repo.folderMembership.length === 0) {
      ungrouped.push(repo);
      continue;
    }
    const folder = repo.folderMembership[0];
    if (!folderMap.has(folder)) folderMap.set(folder, []);
    folderMap.get(folder)!.push(repo);
  }

  const groups: RepoGroup[] = [];
  for (const [label, groupRepos] of folderMap) {
    groups.push({ label, repos: groupRepos });
  }
  if (ungrouped.length > 0) {
    groups.push({ label: "Other", repos: ungrouped });
  }

  return groups;
}

/* ------------------------------------------------------------------ */
/*  Repo row sub-component (collapsible)                               */
/* ------------------------------------------------------------------ */

function RepoRow({
  repo,
  isExpanded,
  onToggle,
  status,
  statusState,
  onActionComplete,
}: {
  repo: RepoView;
  isExpanded: boolean;
  onToggle: () => void;
  status: GitStatusView | undefined;
  statusState: StatusLoadState;
  onActionComplete: (repoId: string) => void;
}) {
  const isLoading = statusState.status === "loading";
  const hasStatus =
    statusState.status === "loaded" || statusState.status === "error";
  const isError = statusState.status === "error";
  const isDetached = status?.currentBranch === "(detached)";

  return (
    <div>
      {/* Clickable row header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-surface/30 transition-colors text-left"
        aria-expanded={isExpanded}
        aria-label={`${repo.displayName} — ${status?.currentBranch ?? repo.branch ?? "no branch"}`}
      >
        <span className="text-muted/30 shrink-0">
          {isExpanded ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronRight size={12} aria-hidden="true" />
          )}
        </span>

        {/* Status dot */}
        <span
          className={cn(
            "w-2 h-2 rounded-full shrink-0",
            isError
              ? "bg-danger/60"
              : hasStatus && status && status.conflicted > 0
                ? "bg-danger/60"
                : hasStatus && status && (status.staged > 0 || status.unstaged > 0 || status.untracked > 0)
                  ? "bg-warn/60"
                  : repo.exists
                    ? "bg-success/60"
                    : "bg-muted/30"
          )}
          title={
            isError
              ? "Status error"
              : hasStatus && status && status.conflicted > 0
                ? "Has conflicts"
                : hasStatus && status && (status.staged > 0 || status.unstaged > 0 || status.untracked > 0)
                  ? "Has changes"
                  : repo.exists
                    ? "Clean"
                    : "Missing"
          }
          aria-hidden="true"
        />

        <FolderGit2 size={14} className="text-accent/50 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-white/80 truncate">
              {repo.displayName}
            </span>
          </div>
          <div className="text-[9px] text-muted/50 font-mono truncate mt-px">
            {repo.rootPath}
          </div>
          {repo.folderMembership.length > 1 && (
            <div className="flex flex-wrap gap-1 mt-1">
              {repo.folderMembership.map((f) => (
                <span
                  key={f}
                  className="text-[8px] text-accent/50 bg-accent/8 px-1.5 py-0.5 rounded font-mono"
                >
                  {f}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Branch */}
        <span
          className={cn(
            "hidden sm:flex items-center gap-1 text-[9px] font-mono shrink-0",
            isDetached ? "text-warn/60" : "text-muted/50"
          )}
        >
          <GitBranch size={10} aria-hidden="true" />
          {isLoading ? (
            <span className="text-muted/30">loading...</span>
          ) : status ? (
            isDetached ? (
              <>detached</>
            ) : (
              status.currentBranch
            )
          ) : (
            repo.branch ?? "?"
          )}
        </span>

        {/* Worktree indicator */}
        {!isLoading && status && status.worktreeCount > 1 && (
          <span
            className="hidden md:flex items-center gap-1 text-[9px] text-accent/40 font-mono shrink-0"
            title={`${status.worktreeCount} worktrees`}
          >
            <Workflow size={10} aria-hidden="true" />
            {status.worktreeCount}
          </span>
        )}

        {/* Quick dirty count */}
        {!isLoading &&
          status &&
          status.staged + status.unstaged + status.untracked + status.conflicted > 0 && (
            <span className="text-[9px] text-warn/60 font-mono shrink-0">
              ~{status.staged + status.unstaged}
              {status.untracked > 0 && ` ?${status.untracked}`}
              {status.conflicted > 0 && ` !${status.conflicted}`}
            </span>
          )}
      </button>

      {/* Expanded detail panel */}
      {isExpanded && (
        <div className="px-3 pb-3 pt-0 pl-9 border-t border-border/10 animate-in">
          {isLoading && <GitRepoStatusSkeleton />}
          {isError && (
            <div className="flex items-center gap-1.5 py-2">
              <AlertTriangle size={11} className="text-danger shrink-0" aria-hidden="true" />
              <span className="text-[10px] text-danger/70 font-mono">Failed to load status</span>
            </div>
          )}
          {hasStatus && status && (
            <div className="space-y-2">
              <GitRepoStatus status={status} isExpanded />
              <GitRepoActions repoId={repo.id} status={status} onActionComplete={() => onActionComplete(repo.id)} />
            </div>
          )}
          {!repo.exists && (
            <div className="flex items-center gap-1.5 py-2">
              <CircleOff size={11} className="text-muted/40 shrink-0" aria-hidden="true" />
              <span className="text-[10px] text-muted/50 font-mono">
                Repository path does not exist on disk
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );

}

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

function EmptyReposState({ search, healthFilter }: { search: string; healthFilter: RepoHealthFilter }) {
  if (search) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Search size={28} className="text-muted/20 mb-3" aria-hidden="true" />
        <p className="text-sm text-muted/60">
          No repositories match &quot;{search}&quot;
        </p>
      </div>
    );
  }

  if (healthFilter !== "all") {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <CircleOff size={28} className="text-muted/20 mb-3" aria-hidden="true" />
        <p className="text-sm text-muted/60">
          No repositories match {REPO_HEALTH_FILTER_LABELS[healthFilter].toLowerCase()}
        </p>
        <p className="text-[10px] text-muted/40 mt-1">
          Clear the active filter to see all repositories.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <FolderOpen size={32} className="text-muted/20 mb-3" aria-hidden="true" />
      <p className="text-sm text-muted/60">No repositories discovered</p>
      <p className="text-[11px] text-muted/40 mt-1 max-w-[260px] leading-relaxed">
        The workspace folders were scanned but no Git repositories were found.
        Repos may be nested deeper than the scan depth, or they may not exist
        yet.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function WorkspaceRepos({
  repositories,
  healthFilter,
  onHealthFilterChange,
}: WorkspaceReposProps) {
  const [search, setSearch] = useState("");
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null);
  const {
    gitStatusMap: statusMap,
    gitStatusState: statusState,
    refreshGitStatuses,
  } = useWorkspaceContext();

  // Refresh a single repo's status after an action completes
  const handleActionComplete = useCallback(
    async (repoId: string) => {
      await refreshGitStatuses([repoId]);
    },
    [refreshGitStatuses]
  );

  const handleRefreshStatuses = useCallback(async () => {
    await refreshGitStatuses();
  }, [refreshGitStatuses]);

  const filtered = useMemo(
    () =>
      repositories.filter(
        (r) => {
          const matchesHealth = matchesRepoHealthFilter(r, statusMap.get(r.id), healthFilter);
          const query = search.toLowerCase();
          const matchesSearch =
            !query ||
            r.displayName.toLowerCase().includes(query) ||
            r.rootPath.toLowerCase().includes(query) ||
            r.branch?.toLowerCase().includes(query) ||
            r.folderMembership.some((f) => f.toLowerCase().includes(query));
          return matchesHealth && matchesSearch;
        }
      ),
    [repositories, search, statusMap, healthFilter]
  );

  const groups = useMemo(() => groupRepos(filtered), [filtered]);

  const multiMembershipCount = useMemo(
    () => repositories.filter((r) => r.folderMembership.length > 1).length,
    [repositories]
  );

  const dirtyCount = useMemo(() => {
    let count = 0;
    for (const [, s] of statusMap) {
      if (s.conflicted === 0 && (s.staged > 0 || s.unstaged > 0 || s.untracked > 0)) count++;
    }
    return count;
  }, [statusMap]);

  return (
    <div className="animate-in">
      {/* Toolbar */}
      <div className="flex items-center gap-2.5 mb-3">
        <div className="relative grow max-w-[200px]">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted/40 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full h-8 bg-surface/50 border border-border/50 rounded-lg pl-8 pr-2.5 text-[11px] text-white placeholder-muted/30 outline-none focus:border-accent/30 transition-colors"
            placeholder="Search repos..."
            aria-label="Search repositories"
          />
        </div>

        <span className="text-[10px] text-muted/50 font-mono shrink-0">
          {filtered.length}{healthFilter !== "all" && ` of ${repositories.length}`} repo
          {filtered.length !== 1 ? "s" : ""}
        </span>

        {healthFilter !== "all" && (
          <button
            type="button"
            onClick={() => onHealthFilterChange("all")}
            className="text-[9px] text-accent/70 bg-accent/10 border border-accent/20 rounded-md px-1.5 py-1 hover:bg-accent/15 transition-colors shrink-0"
            aria-label="Clear repository health filter"
          >
            {REPO_HEALTH_FILTER_LABELS[healthFilter]} ×
          </button>
        )}

        {dirtyCount > 0 && (
          <span
            className="text-[9px] text-warn/60 font-mono shrink-0"
            title={`${dirtyCount} repo(s) with uncommitted changes`}
          >
            <AlertTriangle size={9} className="inline mr-0.5" aria-hidden="true" />
            {dirtyCount} dirty
          </span>
        )}

        {multiMembershipCount > 0 && (
          <span
            className="text-[9px] text-accent/50 font-mono shrink-0 hidden sm:inline"
            title="Repositories belonging to multiple workspace folders"
          >
            <Layers size={10} className="inline mr-1" aria-hidden="true" />
            {multiMembershipCount} shared
          </span>
        )}

        <button
          onClick={handleRefreshStatuses}
          disabled={statusState.status === "loading"}
          className="p-1.5 text-muted/50 hover:text-accent transition-colors rounded-md hover:bg-surface/50 disabled:opacity-30"
          aria-label="Refresh Git statuses"
          title="Refresh Git statuses"
        >
          <RefreshCw
            size={13}
            className={cn(
              statusState.status === "loading" && "animate-spin"
            )}
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Repo list with grouping */}
      {groups.length > 0 ? (
        <div className="bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl overflow-hidden divide-y divide-border/20">
          {groups.map((group) => (
            <div key={group.label}>
              {/* Group header */}
              <div className="flex items-center gap-1.5 px-3 py-2 bg-surface/30">
                <Layers
                  size={10}
                  className="text-muted/30 shrink-0"
                  aria-hidden="true"
                />
                <span className="text-[9px] font-semibold text-muted/50 uppercase tracking-wider">
                  {group.label}
                </span>
                <span className="text-[8px] text-muted/30 font-mono ml-auto">
                  {group.repos.length}
                </span>
              </div>
              {/* Repo rows */}
              <div className="divide-y divide-border/10">
                {group.repos.map((repo) => (
                  <RepoRow
                    key={repo.id}
                    repo={repo}
                    isExpanded={expandedRepo === repo.id}
                    onToggle={() =>
                      setExpandedRepo(
                        expandedRepo === repo.id ? null : repo.id
                      )
                    }
                    status={statusMap.get(repo.id)}
                    statusState={statusState}
                    onActionComplete={handleActionComplete}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyReposState search={search} healthFilter={healthFilter} />
      )}
    </div>
  );
}
