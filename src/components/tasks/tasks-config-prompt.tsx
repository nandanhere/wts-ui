"use client";

import { FileCode, AlertTriangle } from "lucide-react";

interface TasksConfigPromptProps {
  /** "missing" if no config file, "invalid" if file exists but can't parse */
  state: "missing" | "invalid";
  /** Parsing error message, if any */
  error?: string;
}

/**
 * Prompt shown when a repo has no valid .dash-tasks.yaml config.
 */
export function TasksConfigPrompt({ state, error }: TasksConfigPromptProps) {
  if (state === "invalid") {
    return (
      <div className="flex flex-col items-center justify-center py-6 text-center bg-danger/5 border border-danger/20 rounded-xl">
        <AlertTriangle size={22} className="text-warn/40 mb-2" aria-hidden="true" />
        <p className="text-xs text-danger/70">Invalid task configuration</p>
        {error && (
          <p className="text-[10px] text-muted/50 mt-1 font-mono max-w-[400px] leading-relaxed">
            {error}
          </p>
        )}
        <p className="text-[9px] text-muted/40 mt-2">
          Fix the syntax in <code className="text-accent/70 bg-accent/10 px-1 rounded">.dash-tasks.yaml</code> or remove it to start fresh.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center py-8 text-center bg-panel/20 border border-border/40 rounded-xl">
      <FileCode size={28} className="text-muted/20 mb-2" aria-hidden="true" />
      <p className="text-xs text-muted/60">No task configuration</p>
      <p className="text-[10px] text-muted/40 mt-1 max-w-[320px] leading-relaxed">
        Create a <code className="text-accent/70 bg-accent/10 px-1 rounded text-[9px]">.dash-tasks.yaml</code> file in the repo root to define
        processes that can be started and stopped from this tab.
      </p>
      <div className="mt-3 bg-surface/30 rounded-lg p-2.5 text-left w-full max-w-[340px]">
        <p className="text-[9px] text-subtle/60 mb-1.5 font-medium">Example:</p>
        <pre className="text-[9px] text-muted/40 leading-relaxed font-mono">{`processes:
  - name: dev
    command: "pnpm dev"
    description: "Dev server"`}</pre>
      </div>
    </div>
  );
}
