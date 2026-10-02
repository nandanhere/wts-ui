"use client";

import { SnapshotPanel } from "@/components/snapshots";
import { Camera, FolderOpen } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface CombinationsPanelProps {
  /** Number of repos in the currently opened workspace (0 or undefined if none) */
  repoCount: number;
  /** Whether a workspace is currently loaded */
  workspaceLoaded: boolean;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

/**
 * Combinations panel — mounts the existing SnapshotPanel UI when a
 * workspace is open, or shows a placeholder asking the user to open one.
 */
export function CombinationsPanel({
  repoCount,
  workspaceLoaded,
}: CombinationsPanelProps) {
  if (!workspaceLoaded || repoCount === 0) {
    return (
      <div className="animate-in">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
            <Camera size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
            Combinations
          </h2>
        </div>
        <div className="flex flex-col items-center justify-center py-14 text-center bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl">
          <FolderOpen size={32} className="text-muted/20 mb-3" aria-hidden="true" />
          <p className="text-sm text-muted/60">No workspace open</p>
          <p className="text-[11px] text-muted/40 mt-1 max-w-[280px] leading-relaxed">
            Open a workspace from the Workspace tab and its snapshot
            combinations will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in">
      <SnapshotPanel repoCount={repoCount} />
    </div>
  );
}
