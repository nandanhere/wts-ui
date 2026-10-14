"use client";

import { GitBranch, FolderGit2, Play, Square } from "lucide-react";
import { TasksProcessRow } from "./tasks-process-row";
import type { TaskWorktreeStatus } from "@/lib/tasks/types";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface TasksWorktreeRowProps {
  worktree: TaskWorktreeStatus;
  repoId: string;
  onStart: (repoId: string, worktreePath: string, processName: string) => void;
  onStop: (repoId: string, worktreePath: string, processName: string) => void;
  onStartAll: (repoId: string, worktreePath: string) => void;
  onStopAll: (repoId: string, worktreePath: string) => void;
  actionInFlight: string | null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TasksWorktreeRow({
  worktree,
  repoId,
  onStart,
  onStop,
  onStartAll,
  onStopAll,
  actionInFlight,
}: TasksWorktreeRowProps) {
  const anyRunning = worktree.processes.some((p) => p.running);
  const allRunning = worktree.processes.length > 0 && worktree.processes.every((p) => p.running);

  return (
    <div className="animate-in">
      {/* Worktree header */}
      <div className="flex items-center gap-2 py-1.5">
        <FolderGit2 size={11} className="text-muted/30 shrink-0" aria-hidden="true" />
        {worktree.isPrimary ? (
          <span className="text-[10px] font-medium text-subtle/70">Primary</span>
        ) : (
          <span className="text-[10px] text-subtle/70 truncate max-w-[160px]">
            {worktree.path.split("/").pop()}
          </span>
        )}
        {worktree.branch && (
          <span className="flex items-center gap-1 text-[9px] text-muted/40 font-mono bg-surface/20 px-1.5 py-0.5 rounded">
            <GitBranch size={8} aria-hidden="true" />
            {worktree.branch}
          </span>
        )}
        <span className="text-[8px] text-muted/20 font-mono truncate flex-1 hidden sm:inline">
          {worktree.path}
        </span>

        {/* Group actions */}
        {worktree.processes.length > 1 && (
          <div className="flex items-center gap-0.5 shrink-0 ml-auto">
            {allRunning ? (
              <button
                onClick={() => onStopAll(repoId, worktree.path)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] text-danger/50 hover:text-danger hover:bg-danger/10 transition-colors"
                title="Stop all processes"
                aria-label="Stop all processes"
              >
                <Square size={8} aria-hidden="true" />
                Stop all
              </button>
            ) : (
              <button
                onClick={() => onStartAll(repoId, worktree.path)}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] text-success/50 hover:text-success hover:bg-success/10 transition-colors"
                title="Start all processes"
                aria-label="Start all processes"
              >
                <Play size={8} aria-hidden="true" />
                Start all
              </button>
            )}
          </div>
        )}
      </div>

      {/* Processes */}
      {worktree.processes.length > 0 ? (
        <div className="space-y-0.5">
          {worktree.processes.map((proc) => (
            <TasksProcessRow
              key={proc.name}
              process={proc}
              repoId={repoId}
              worktreePath={worktree.path}
              onStart={onStart}
              onStop={onStop}
              actionInFlight={actionInFlight}
            />
          ))}
        </div>
      ) : (
        <p className="text-[9px] text-muted/30 pl-5 py-1">
          No processes defined
        </p>
      )}
    </div>
  );
}
