"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface TasksLogViewerProps {
  lines: string[];
  truncated: boolean;
  expanded: boolean;
  onToggle: () => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function TasksLogViewer({
  lines,
  truncated,
  expanded,
  onToggle,
}: TasksLogViewerProps) {
  const scrollRef = useRef<HTMLPreElement>(null);
  const prevLinesRef = useRef(lines.length);

  // Auto-scroll when new lines are added
  useEffect(() => {
    if (expanded && lines.length > prevLinesRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
    prevLinesRef.current = lines.length;
  }, [lines.length, expanded]);

  if (!expanded) {
    return (
      <button
        onClick={onToggle}
        className="text-[9px] text-muted/40 hover:text-subtle/60 transition-colors mt-1"
      >
        {lines.length > 0
          ? `Show logs (${lines.length} lines)`
          : "No logs yet"}
      </button>
    );
  }

  return (
    <div className="mt-1.5 animate-in">
      <div className="flex items-center gap-2 mb-1">
        <button
          onClick={onToggle}
          className="text-[9px] text-muted/40 hover:text-subtle/60 transition-colors"
        >
          Hide logs
        </button>
        {truncated && (
          <span className="text-[8px] text-warn/50">(truncated)</span>
        )}
      </div>
      <pre
        ref={scrollRef}
        className={cn(
          "bg-ink/50 border border-border/30 rounded-lg p-2.5",
          "text-[9px] font-mono leading-relaxed",
          "overflow-x-auto overflow-y-auto",
          lines.length === 0 ? "text-muted/30" : "text-subtle/60",
        )}
        style={{ maxHeight: "240px" }}
      >
        {lines.length > 0
          ? lines.map((line, i) => (
              <span key={i}>
                {line}
                {"\n"}
              </span>
            ))
          : "Waiting for output…"}
      </pre>
    </div>
  );
}
