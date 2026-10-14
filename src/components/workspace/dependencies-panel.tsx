"use client";

import { GraphifyPanel } from "@/components/graphify";
import { Network, FolderOpen } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface DependenciesPanelProps {
  /** Absolute path to the opened .code-workspace file (null if none) */
  workspacePath: string | null;
  /** Discovered repository IDs from the workspace scan */
  repoIds: string[];
  /** Whether a workspace is currently loaded */
  workspaceLoaded: boolean;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

/**
 * Dependencies panel — mounts the existing GraphifyPanel when a workspace
 * is open, or shows a placeholder.
 */
export function DependenciesPanel({
  workspacePath,
  repoIds,
  workspaceLoaded,
}: DependenciesPanelProps) {
  if (!workspaceLoaded || !workspacePath || repoIds.length === 0) {
    return (
      <div className="animate-in">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
            <Network size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
            Dependencies
          </h2>
        </div>
        <div className="flex flex-col items-center justify-center py-14 text-center bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl">
          <FolderOpen size={32} className="text-muted/20 mb-3" aria-hidden="true" />
          <p className="text-sm text-muted/60">Open a workspace to see dependencies</p>
          <p className="text-[11px] text-muted/40 mt-1 max-w-[280px] leading-relaxed">
            Cross-repository dependency and graphify data becomes available
            once a workspace with repositories is opened.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in">
      <GraphifyPanel
        workspacePath={workspacePath}
        repoIds={repoIds}
      />
    </div>
  );
}
