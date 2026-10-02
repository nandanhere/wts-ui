"use client";

import type { DriftClass } from "@/lib/snapshot/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Drift classification badge colours                                 */
/* ------------------------------------------------------------------ */

const BADGE_CONFIG: Record<
  DriftClass,
  { label: string; bg: string; text: string; border: string }
> = {
  satisfied: {
    label: "Satisfied",
    bg: "rgba(52,211,153,0.12)",
    text: "rgb(52,211,153)",
    border: "rgba(52,211,153,0.25)",
  },
  "safe-switch": {
    label: "Safe Switch",
    bg: "rgba(96,165,250,0.12)",
    text: "rgb(96,165,250)",
    border: "rgba(96,165,250,0.25)",
  },
  "create-worktree": {
    label: "Create Worktree",
    bg: "rgba(167,139,250,0.12)",
    text: "rgb(167,139,250)",
    border: "rgba(167,139,250,0.25)",
  },
  preferred: {
    label: "Preferred",
    bg: "rgba(96,165,250,0.08)",
    text: "rgba(96,165,250,0.6)",
    border: "rgba(96,165,250,0.15)",
  },
  "dirty-blocked": {
    label: "Dirty — Blocked",
    bg: "rgba(248,113,113,0.12)",
    text: "rgb(248,113,113)",
    border: "rgba(248,113,113,0.25)",
  },
  occupied: {
    label: "Occupied",
    bg: "rgba(251,191,36,0.12)",
    text: "rgb(251,191,36)",
    border: "rgba(251,191,36,0.25)",
  },
  "fetch-needed": {
    label: "Fetch Needed",
    bg: "rgba(251,191,36,0.12)",
    text: "rgb(251,191,36)",
    border: "rgba(251,191,36,0.25)",
  },
  "missing-ref": {
    label: "Missing Ref",
    bg: "rgba(248,113,113,0.12)",
    text: "rgb(248,113,113)",
    border: "rgba(248,113,113,0.25)",
  },
  "missing-repo": {
    label: "Missing Repo",
    bg: "rgba(248,113,113,0.18)",
    text: "rgb(248,113,113)",
    border: "rgba(248,113,113,0.35)",
  },
  ambiguous: {
    label: "Ambiguous",
    bg: "rgba(156,163,175,0.12)",
    text: "rgb(156,163,175)",
    border: "rgba(156,163,175,0.25)",
  },
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function DriftBadge({
  classification,
  className,
}: {
  classification: DriftClass;
  className?: string;
}) {
  const cfg = BADGE_CONFIG[classification];
  if (!cfg) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-[.06em] font-mono whitespace-nowrap",
        className
      )}
      style={{
        background: cfg.bg,
        color: cfg.text,
        border: `1px solid ${cfg.border}`,
      }}
    >
      {cfg.label}
    </span>
  );
}
