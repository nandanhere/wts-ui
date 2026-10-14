"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { Play, Square, RotateCw, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { TasksLogViewer } from "./tasks-log-viewer";
import type { TaskProcessStatus } from "@/lib/tasks/types";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface TasksProcessRowProps {
  process: TaskProcessStatus;
  repoId: string;
  worktreePath: string;
  onStart: (repoId: string, worktreePath: string, processName: string) => void;
  onStop: (repoId: string, worktreePath: string, processName: string) => void;
  actionInFlight: string | null;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TasksProcessRow({
  process,
  repoId,
  worktreePath,
  onStart,
  onStop,
  actionInFlight,
}: TasksProcessRowProps) {
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logTruncated, setLogTruncated] = useState(false);
  const logPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchLogs = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        repoId,
        worktreePath,
        processName: process.name,
        lines: "200",
      });
      const res = await fetch(`/api/tasks/logs?${params}`);
      if (res.ok) {
        const data = await res.json();
        setLogLines(data.lines ?? []);
        setLogTruncated(data.truncated ?? false);
      }
    } catch {
      // ignore
    }
  }, [repoId, worktreePath, process.name]);

  useEffect(() => {
    if (logsExpanded) {
      fetchLogs();
      logPollRef.current = setInterval(fetchLogs, 2000);
    }
    return () => {
      if (logPollRef.current) {
        clearInterval(logPollRef.current);
        logPollRef.current = null;
      }
    };
  }, [logsExpanded, fetchLogs]);

  const handleStart = useCallback(() => {
    onStart(repoId, worktreePath, process.name);
  }, [onStart, repoId, worktreePath, process.name]);

  const handleStop = useCallback(() => {
    onStop(repoId, worktreePath, process.name);
  }, [onStop, repoId, worktreePath, process.name]);

  const isRunning = process.running;
  const isBusy = actionInFlight === process.name;

  return (
    <div className="pl-5 border-l border-border/20 ml-2">
      <div className="flex items-center gap-2 py-1.5">
        {/* Status dot */}
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full shrink-0",
            isRunning ? "bg-success shadow-[0_0_4px_var(--success)]" : "bg-muted/30",
          )}
        />

        {/* Name + description */}
        <div className="min-w-0 flex-1">
          <span className="text-[10px] font-medium text-subtle/80">
            {process.name}
          </span>
          {process.description && (
            <span className="text-[9px] text-muted/40 ml-1.5">
              {process.description}
            </span>
          )}
        </div>

        {/* Command preview */}
        <code className="text-[8px] text-muted/30 font-mono hidden sm:inline max-w-[200px] truncate">
          {process.command}
        </code>

        {/* Actions */}
        <div className="flex items-center gap-0.5 shrink-0">
          {isRunning ? (
            <button
              onClick={handleStop}
              disabled={isBusy}
              className="p-1 rounded text-[9px] text-danger/60 hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-30"
              title={`Stop ${process.name}`}
              aria-label={`Stop ${process.name}`}
            >
              {isBusy ? (
                <RotateCw size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <Square size={11} aria-hidden="true" />
              )}
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={isBusy}
              className="p-1 rounded text-[9px] text-success/60 hover:text-success hover:bg-success/10 transition-colors disabled:opacity-30"
              title={`Start ${process.name}`}
              aria-label={`Start ${process.name}`}
            >
              {isBusy ? (
                <RotateCw size={11} className="animate-spin" aria-hidden="true" />
              ) : (
                <Play size={11} aria-hidden="true" />
              )}
            </button>
          )}

          <button
            onClick={() => setLogsExpanded((v) => !v)}
            className={cn(
              "p-1 rounded text-[9px] transition-colors",
              logsExpanded
                ? "text-accent bg-accent/10"
                : "text-muted/40 hover:text-subtle/60",
            )}
            title="Toggle logs"
            aria-label="Toggle logs"
          >
            <Terminal size={11} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Logs */}
      <TasksLogViewer
        lines={logLines}
        truncated={logTruncated}
        expanded={logsExpanded}
        onToggle={() => setLogsExpanded((v) => !v)}
      />
    </div>
  );
}
