"use client";

import { useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  useWorkspaceContext,
  WorkspaceProvider,
} from "./workspace-context";
import { WorkspacePicker } from "./workspace-picker";
import { WorkspaceRepos } from "./workspace-repos";
import { WorkspaceDiagnostics } from "./workspace-diagnostics";
import { WorkspaceSummary } from "./workspace-summary";
import { CleanSessionPanel } from "./clean-session-panel";
import { CombinationsPanel } from "./combinations-panel";
import { DeploymentsPanel } from "./deployments-panel";
import { DependenciesPanel } from "./dependencies-panel";
import { IntegrationsPanel } from "@/components/integrations/integrations-panel";
import { SettingsPanel } from "./settings-panel";
import { TasksPanel } from "@/components/tasks/tasks-panel";
import { cn } from "@/lib/utils";
import type { RepoHealthFilter } from "@/lib/api/workspace-summary";
import {
  RefreshCw,
  ArrowLeft,
  FolderGit2,
  FileJson,
  Layers,
  Camera,
  Network,
  Rocket,
  Puzzle,
  Settings,
  AlertTriangle,
  ListChecks,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Tab configuration                                                  */
/* ------------------------------------------------------------------ */

type PrimaryTab = "workspace" | "combinations" | "deployments" | "dependencies" | "integrations" | "tasks" | "settings";

function isPrimaryTab(value: string | null): value is PrimaryTab {
  return PRIMARY_TABS.some((tab) => tab.id === value);
}

interface TabDef {
  id: PrimaryTab;
  label: string;
  icon: React.ReactNode;
}

const PRIMARY_TABS: TabDef[] = [
  { id: "workspace", label: "Workspace", icon: <Layers size={12} aria-hidden="true" /> },
  { id: "combinations", label: "Combinations", icon: <Camera size={12} aria-hidden="true" /> },
  { id: "deployments", label: "Deployments", icon: <Rocket size={12} aria-hidden="true" /> },
  { id: "dependencies", label: "Dependencies", icon: <Network size={12} aria-hidden="true" /> },
  { id: "integrations", label: "Integrations", icon: <Puzzle size={12} aria-hidden="true" /> },
  { id: "tasks", label: "Tasks", icon: <ListChecks size={12} aria-hidden="true" /> },
  { id: "settings", label: "Settings", icon: <Settings size={12} aria-hidden="true" /> },
];

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
    <div className="bg-danger/10 border border-danger/20 rounded-xl p-3.5 flex items-start gap-2.5 animate-in">
      <AlertTriangle
        size={14}
        className="text-danger shrink-0 mt-0.5"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-xs text-danger/80 font-medium">
          Failed to load workspace
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
    <div className="animate-pulse space-y-3">
      <div className="bg-surface/40 rounded-xl h-16" />
      <div className="bg-surface/40 rounded-xl h-40" />
      <div className="bg-surface/40 rounded-xl h-60" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Workspace sub-tabs (shown when a workspace is loaded)              */
/* ------------------------------------------------------------------ */

type WorkspaceSubTab = "repos" | "snapshots" | "graphify" | "diagnostics";

interface WorkspaceSubNavProps {
  subTab: WorkspaceSubTab;
  onSubTabChange: (tab: WorkspaceSubTab) => void;
  onBack: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

function WorkspaceSubNav({
  subTab,
  onSubTabChange,
  onBack,
  onRefresh,
  isRefreshing,
}: WorkspaceSubNavProps) {
  const subTabs: {
    id: WorkspaceSubTab;
    label: string;
    icon: React.ReactNode;
  }[] = [
    { id: "repos", label: "Repositories", icon: <FolderGit2 size={12} aria-hidden="true" /> },
    { id: "snapshots", label: "Snapshots", icon: <Camera size={12} aria-hidden="true" /> },
    { id: "graphify", label: "Graphify", icon: <Network size={12} aria-hidden="true" /> },
    { id: "diagnostics", label: "Diagnostics", icon: <FileJson size={12} aria-hidden="true" /> },
  ];

  return (
    <div className="flex items-center gap-1 mb-3">
      <button
        onClick={onBack}
        className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] text-muted/50 hover:text-accent transition-colors mr-1"
        aria-label="Close workspace"
      >
        <ArrowLeft size={11} aria-hidden="true" />
        Back
      </button>
      {subTabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onSubTabChange(tab.id)}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[10px] font-medium transition-all",
            subTab === tab.id
              ? "bg-accent/15 text-accent border border-accent/20"
              : "text-muted/60 hover:text-white/70 border border-transparent"
          )}
        >
          {tab.icon}
          {tab.label}
        </button>
      ))}
      <button
        onClick={onRefresh}
        disabled={isRefreshing}
        className="ml-auto p-1.5 text-muted/40 hover:text-accent transition-colors rounded-md hover:bg-surface/30 disabled:opacity-30"
        aria-label="Refresh"
        title="Refresh workspace data"
      >
        <RefreshCw
          size={12}
          className={cn(isRefreshing && "animate-spin")}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Inner body (requires context)                                      */
/* ------------------------------------------------------------------ */

function WorkspaceShellBody() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tabFromUrl = searchParams.get("tab");

  const {
    loadState,
    currentPath,
    recents,
    repoIds,
    isWorkspaceLoaded,
    repoCount,
    handleOpen,
    handleRefresh,
    handleBack,
    handleDismissError,
    isRefreshing,
    refreshGitStatuses,
  } = useWorkspaceContext();

  const activeTab: PrimaryTab = isPrimaryTab(tabFromUrl)
    ? tabFromUrl
    : "workspace";
  const [workspaceSubTab, setWorkspaceSubTab] = useState<WorkspaceSubTab>("repos");
  const [repoHealthFilter, setRepoHealthFilter] = useState<RepoHealthFilter>("all");

  const closeWorkspace = useCallback(() => {
    setRepoHealthFilter("all");
    setWorkspaceSubTab("repos");
    handleBack();
  }, [handleBack]);

  // Sync tab from URL
  const setTab = useCallback(
    (tab: PrimaryTab) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", tab);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams]
  );

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--color-background-body)" }}
    >
      {/* Primary navigation */}
      <nav
        className="fixed top-0 left-0 right-0 z-50 h-11 flex items-center px-5 gap-1 overflow-x-auto"
        style={{
          background:
            "color-mix(in srgb, var(--color-background-body) 90%, transparent)",
          backdropFilter: "blur(16px)",
          borderBottom: "1px solid var(--color-border)",
        }}
      >
        <span
          className="text-sm font-bold tracking-tight mr-4 shrink-0"
          style={{ color: "var(--color-accent)" }}
        >
          Workspace State
        </span>
        {PRIMARY_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setTab(tab.id)}
            className="relative text-xs font-medium px-3 py-1.5 rounded-md shrink-0 transition-all duration-150 flex items-center gap-1.5"
            style={{
              color:
                activeTab === tab.id
                  ? "var(--color-text-primary)"
                  : "var(--color-text-secondary)",
              background:
                activeTab === tab.id
                  ? "var(--color-background-elevated)"
                  : "transparent",
            }}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </nav>

      <div
        className="pt-16 pb-4 px-4 md:px-8"
        style={{
          background:
            "radial-gradient(ellipse at 50% 0%, rgba(96,165,250,0.07) 0%, transparent 70%)",
        }}
      >
        <div className="max-w-7xl mx-auto">
          {/* ── WORSPACE TAB ────────────────────────────────── */}
          {activeTab === "workspace" && (
            <div>
              {isWorkspaceLoaded && (
                <>
                  {loadState.status === "success" && (
                    <WorkspaceSummary
                      workspaceName={loadState.data.definition.name}
                      workspacePath={loadState.data.definition.filePath}
                      repositories={loadState.data.repositories}
                      scanErrors={loadState.data.scanErrors}
                      onRefresh={handleRefresh}
                      isRefreshing={isRefreshing}
                      onNavigate={(tab) => setTab(tab as PrimaryTab)}
                      onNavigateSub={(tab) => setWorkspaceSubTab(tab as WorkspaceSubTab)}
                      activeRepoFilter={repoHealthFilter}
                      onRepoFilter={setRepoHealthFilter}
                    />
                  )}
                  <WorkspaceSubNav
                    subTab={workspaceSubTab}
                    onSubTabChange={setWorkspaceSubTab}
                    onBack={closeWorkspace}
                    onRefresh={handleRefresh}
                    isRefreshing={isRefreshing}
                  />

                  {/* Clean session control — shown above content on repos tab */}
                  {workspaceSubTab === "repos" && (
                    <div className="mb-3">
                      <CleanSessionPanel
                        repoIds={repoIds}
                        onSessionComplete={() => void refreshGitStatuses()}
                      />
                    </div>
                  )}
                </>
              )}

              {/* Error */}
              {loadState.status === "error" && (
                <div className="mb-3">
                  <ErrorBanner
                    message={loadState.message}
                    onDismiss={handleDismissError}
                  />
                </div>
              )}

              {/* Loading */}
              {loadState.status === "loading" && <LoadingSkeleton />}

              {/* Picker (idle) */}
              {loadState.status === "idle" && (
                <div className="max-w-2xl mx-auto pt-8">
                  <h2 className="text-sm font-semibold text-white tracking-tight flex items-center gap-1.5 mb-4">
                    <Layers size={14} className="text-accent" aria-hidden="true" />
                    Workspace
                  </h2>
                  <WorkspacePicker
                    recents={{ entries: recents.entries }}
                    onOpen={handleOpen}
                    isLoading={false}
                  />
                </div>
              )}

              {/* Loaded workspace sub-panels */}
              {loadState.status === "success" && workspaceSubTab === "repos" && (
                <WorkspaceRepos
                  repositories={loadState.data.repositories}
                  healthFilter={repoHealthFilter}
                  onHealthFilterChange={setRepoHealthFilter}
                />
              )}
              {loadState.status === "success" &&
                workspaceSubTab === "snapshots" &&
                (repoCount > 0 ? (
                  <CombinationsPanel
                    repoCount={repoCount}
                    workspaceLoaded={isWorkspaceLoaded}
                  />
                ) : (
                  <div className="text-[10px] text-muted/40 font-mono py-4 text-center">
                    Open a workspace with repositories to create and view
                    snapshots.
                  </div>
                ))}
              {loadState.status === "success" &&
                workspaceSubTab === "graphify" &&
                currentPath && (
                  <DependenciesPanel
                    workspacePath={currentPath}
                    repoIds={repoIds}
                    workspaceLoaded={isWorkspaceLoaded}
                  />
                )}
              {loadState.status === "success" && workspaceSubTab === "diagnostics" && (
                <WorkspaceDiagnostics
                  definition={loadState.data.definition}
                  scanErrors={loadState.data.scanErrors}
                />
              )}
            </div>
          )}

          {/* ── COMBINATIONS TAB ───────────────────────────── */}
          {activeTab === "combinations" && (
            <CombinationsPanel
              repoCount={repoCount}
              workspaceLoaded={isWorkspaceLoaded}
            />
          )}

          {/* ── DEPLOYMENTS TAB ────────────────────────────── */}
          {activeTab === "deployments" && (
            <DeploymentsPanel
              workspaceLoaded={isWorkspaceLoaded}
              repoIds={repoIds}
              repoDisplayMap={
                loadState.status === "success"
                  ? Object.fromEntries(
                      loadState.data.repositories.map((r) => [
                        r.id,
                        { displayName: r.displayName },
                      ]),
                    )
                  : {}
              }
            />
          )}

          {/* ── DEPENDENCIES TAB ───────────────────────────── */}
          {activeTab === "dependencies" && (
            <DependenciesPanel
              workspacePath={currentPath}
              repoIds={repoIds}
              workspaceLoaded={isWorkspaceLoaded}
            />
          )}

          {/* ── INTEGRATIONS TAB ──────────────────────────── */}
          {activeTab === "integrations" && (
            <IntegrationsPanel
              key={isWorkspaceLoaded ? "loaded" : "empty"}
              workspaceLoaded={isWorkspaceLoaded}
            />
          )}

          {/* ── TASKS TAB ──────────────────────────────────── */}
          {activeTab === "tasks" && <TasksPanel />}

          {/* ── SETTINGS TAB ───────────────────────────────── */}
          {activeTab === "settings" && <SettingsPanel />}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Export with context wrapper                                        */
/* ------------------------------------------------------------------ */

export function WorkspaceShell() {
  return (
    <WorkspaceProvider>
      <WorkspaceShellBody />
    </WorkspaceProvider>
  );
}
