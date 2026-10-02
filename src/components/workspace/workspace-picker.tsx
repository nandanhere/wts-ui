"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { RecentsView } from "@/lib/api/workspace";
import { X, Clock, FolderOpen, ChevronRight } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface WorkspacePickerProps {
  recents: RecentsView;
  onOpen: (path: string) => void;
  isLoading: boolean;
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function PathInput({
  value,
  onChange,
  onSubmit,
  isLoading,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  isLoading: boolean;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex items-center gap-2"
    >
      <div className="relative flex-1">
        <FolderOpen
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted/40 pointer-events-none"
          aria-hidden="true"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="~/.config/code/workspace.code-workspace"
          className="w-full h-9 bg-surface/60 border border-border/50 rounded-lg pl-9 pr-3 text-xs text-white placeholder-muted/30 outline-none focus:border-accent/30 transition-colors font-mono"
          disabled={isLoading}
          aria-label="Workspace file path"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <button
        type="submit"
        disabled={isLoading || !value.trim()}
        className="h-9 px-3.5 rounded-lg text-xs font-semibold bg-accent/15 text-accent border border-accent/20 hover:bg-accent/25 disabled:opacity-30 disabled:cursor-not-allowed transition-all shrink-0"
      >
        {isLoading ? (
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-3 border-[2px] border-current border-t-transparent rounded-full animate-spin" />
            Loading
          </span>
        ) : (
          "Open"
        )}
      </button>
    </form>
  );
}

function RecentEntry({
  entry,
  onSelect,
}: {
  entry: RecentsView["entries"][number];
  onSelect: (path: string) => void;
}) {
  const lastOpened = new Date(entry.lastOpened);
  const dateStr = lastOpened.toLocaleDateString("en-CA");
  const label = entry.filePath.split("/").pop() ?? entry.label;

  return (
    <button
      onClick={() => onSelect(entry.filePath)}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors hover:bg-surface/60 group"
    >
      <Clock size={14} className="text-muted/30 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-white/80 truncate">
          {entry.label || label}
        </div>
        <div className="text-[10px] text-muted/50 truncate font-mono mt-px">
          {entry.filePath}
        </div>
        <div className="text-[9px] text-muted/40 mt-0.5">
          {entry.folderCount} folder{entry.folderCount !== 1 ? "s" : ""}
          {entry.repoCount > 0 && ` · ${entry.repoCount} repo${entry.repoCount !== 1 ? "s" : ""}`}
          {" · "}
          {dateStr}
        </div>
      </div>
      <ChevronRight
        size={14}
        className="text-muted/20 group-hover:text-muted/50 transition-colors shrink-0"
        aria-hidden="true"
      />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function WorkspacePicker({
  recents,
  onOpen,
  isLoading,
}: WorkspacePickerProps) {
  const [path, setPath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = path.trim();
    if (trimmed) onOpen(trimmed);
  }, [path, onOpen]);

  // Focus input on mount
  useEffect(() => {
    // Small delay so the animation doesn't fight focus
    const t = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="animate-in">
      {/* Path input */}
      <div className="bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl p-4 mb-4">
        <label className="text-[10px] font-semibold text-muted uppercase tracking-wider mb-2 block">
          Workspace File Path
        </label>
        <p className="text-[11px] text-muted/60 mb-3 leading-relaxed">
          Enter the absolute path to a <code className="text-accent/80 bg-accent/10 px-1 rounded text-[10px] font-mono">.code-workspace</code> file.
          Browser file pickers cannot expose arbitrary local paths reliably,
          so type or paste instead (e.g., <code className="text-accent/60 bg-accent/10 px-1 rounded text-[10px] font-mono">~/.config/senzu.code-workspace</code>).
        </p>
        <PathInput
          value={path}
          onChange={setPath}
          onSubmit={handleSubmit}
          isLoading={isLoading}
        />
      </div>

      {/* Recents */}
      {recents.entries.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Clock size={11} className="text-muted/40" aria-hidden="true" />
            <span className="text-[10px] font-semibold text-muted uppercase tracking-wider">
              Recently Opened
            </span>
          </div>
          <div className="bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl overflow-hidden divide-y divide-border/20">
            {recents.entries.map((entry) => (
              <RecentEntry
                key={entry.filePath}
                entry={entry}
                onSelect={onOpen}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state when no recents */}
      {recents.entries.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FolderOpen size={32} className="text-muted/20 mb-3" aria-hidden="true" />
          <p className="text-sm text-muted/60">No recent workspaces</p>
          <p className="text-[11px] text-muted/40 mt-1 max-w-[280px] leading-relaxed">
            Type a path above or open a workspace from this dashboard to get started.
          </p>
        </div>
      )}
    </div>
  );
}
