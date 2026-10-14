"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  IntegrationsLoadState,
} from "@/lib/api/integrations";
import { fetchIntegrationsManifest } from "@/lib/api/integrations";
import type {
  ProviderManifestEntry,
  UiBlock,
  NoticeBlock,
  MetricListBlock,
  StatusListBlock,
  LinkListBlock,
} from "@/lib/integrations/types";
import { cn } from "@/lib/utils";
import {
  Puzzle,
  RefreshCw,
  AlertTriangle,
  FolderOpen,
  ShieldCheck,
  Shield,
  ShieldAlert,
  Layers,
  CheckCircle,
  AlertCircle,
  HelpCircle,
  ExternalLink,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface IntegrationsPanelProps {
  /** Whether a workspace is currently loaded. */
  workspaceLoaded: boolean;
}

/* ------------------------------------------------------------------ */
/*  UI block renderers (exhaustive switch)                             */
/* ------------------------------------------------------------------ */

function BlockNotice({ block }: { block: NoticeBlock }) {
  const severityStyles = {
    info: "bg-accent/8 border-accent/15 text-accent/80",
    warn: "bg-warn/8 border-warn/15 text-warn/80",
    error: "bg-danger/8 border-danger/15 text-danger/80",
  };

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2 text-[10px] leading-relaxed",
        severityStyles[block.severity ?? "info"]
      )}
    >
      {block.message}
    </div>
  );
}

function BlockMetricList({ block }: { block: MetricListBlock }) {
  const colorMap = {
    default: "text-muted/60",
    success: "text-success/70",
    warn: "text-warn/70",
    danger: "text-danger/70",
  };

  return (
    <div className="flex flex-wrap gap-2">
      {block.items.map((item, i) => (
        <div
          key={i}
          className="flex items-baseline gap-1.5 bg-surface/20 border border-border/20 rounded-lg px-2.5 py-1.5"
        >
          <span className={cn("text-xs font-semibold tabular-nums", colorMap[item.color ?? "default"])}>
            {item.value}
          </span>
          <span className="text-[9px] text-muted/50">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function BlockStatusList({ block }: { block: StatusListBlock }) {
  const iconMap = {
    ok: <CheckCircle size={10} className="text-success/70 shrink-0 mt-0.5" aria-hidden="true" />,
    warn: <AlertTriangle size={10} className="text-warn/70 shrink-0 mt-0.5" aria-hidden="true" />,
    error: <AlertCircle size={10} className="text-danger/70 shrink-0 mt-0.5" aria-hidden="true" />,
    unknown: <HelpCircle size={10} className="text-muted/40 shrink-0 mt-0.5" aria-hidden="true" />,
  };

  return (
    <div className="space-y-1">
      {block.items.map((item, i) => (
        <div
          key={i}
          className="flex items-start gap-2 py-1.5 px-2 rounded-lg bg-surface/10 border border-border/10"
        >
          {iconMap[item.status]}
          <div className="min-w-0 flex-1">
            <span className="text-[10px] font-medium text-white/70">
              {item.label}
            </span>
            {item.detail && (
              <span className="text-[9px] text-muted/50 ml-2">
                {item.detail}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function BlockLinkList({ block }: { block: LinkListBlock }) {
  return (
    <div className="space-y-1">
      {block.items.map((item, i) => (
        <a
          key={i}
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-[10px] text-accent/70 hover:text-accent transition-colors py-1 px-2 rounded hover:bg-accent/5"
        >
          <ExternalLink size={10} aria-hidden="true" />
          {item.label}
        </a>
      ))}
    </div>
  );
}

function renderBlock(block: UiBlock) {
  switch (block.type) {
    case "notice":
      return <BlockNotice block={block} />;
    case "metric-list":
      return <BlockMetricList block={block} />;
    case "status-list":
      return <BlockStatusList block={block} />;
    case "link-list":
      return <BlockLinkList block={block} />;
    default:
      return assertNever(block);
  }
}

/** Exhaustiveness check — ensures all UiBlock variants are handled at compile time. */
function assertNever(block: never): never {
  return block;
}

/* ------------------------------------------------------------------ */
/*  Capability chip                                                    */
/* ------------------------------------------------------------------ */

function CapabilityChip({ cap }: { cap: string }) {
  return (
    <span className="text-[9px] text-accent/60 bg-accent/8 px-1.5 py-0.5 rounded font-mono border border-accent/10">
      {cap}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Risk badge                                                         */
/* ------------------------------------------------------------------ */

function RiskBadge({ risk }: { risk: string }) {
  const colorMap: Record<string, string> = {
    readonly: "text-info/70 border-info/20 bg-info/8",
    low: "text-success/70 border-success/20 bg-success/8",
    medium: "text-warn/70 border-warn/20 bg-warn/8",
    high: "text-danger/70 border-danger/20 bg-danger/8",
  };

  const iconMap: Record<string, React.ReactNode> = {
    readonly: <ShieldCheck size={10} aria-hidden="true" />,
    low: <Shield size={10} aria-hidden="true" />,
    medium: <Shield size={10} aria-hidden="true" />,
    high: <ShieldAlert size={10} aria-hidden="true" />,
  };

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium border",
        colorMap[risk] ?? "text-muted/50 border-border/20 bg-surface/20"
      )}
    >
      {iconMap[risk] ?? null}
      {risk}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Provider card                                                      */
/* ------------------------------------------------------------------ */

function ProviderCard({ entry }: { entry: ProviderManifestEntry }) {
  const stateColor = {
    available: "text-success/60",
    unavailable: "text-muted/40",
    degraded: "text-warn/60",
  };

  return (
    <div className="bg-surface/20 backdrop-blur-sm border border-border/30 rounded-xl p-4 space-y-3 animate-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold text-white/80 flex items-center gap-1.5">
            <Puzzle size={12} className="text-accent shrink-0" aria-hidden="true" />
            {entry.name}
          </h3>
          <p className="text-[10px] text-muted/50 mt-0.5 leading-relaxed">
            {entry.description}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <RiskBadge risk={entry.riskLevel} />
          <span
            className={cn(
              "text-[9px] font-medium",
              stateColor[entry.state]
            )}
          >
            {entry.state}
          </span>
        </div>
      </div>

      {/* Capabilities */}
      {entry.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.capabilities.map((cap) => (
            <CapabilityChip key={cap} cap={cap} />
          ))}
        </div>
      )}

      {/* Tool descriptors — compact risk + approval metadata */}
      {entry.tools.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-[9px] font-medium text-muted/50 uppercase tracking-wider">
            Tools ({entry.tools.length})
          </h4>
          <div className="space-y-1">
            {entry.tools.map((tool) => (
              <div
                key={tool.id}
                className="flex items-center gap-2 py-1 px-1.5 rounded bg-surface/10 border border-border/10 text-[10px]"
              >
                <span className="text-white/70 font-medium min-w-0 truncate">
                  {tool.label}
                </span>
                <span className="ml-auto flex items-center gap-1 shrink-0">
                  <span
                    className={cn(
                      "text-[9px] px-1 py-0.5 rounded font-mono",
                      tool.risk === "readonly" && "text-info/60 bg-info/8",
                      tool.risk === "low" && "text-success/60 bg-success/8",
                      tool.risk === "medium" && "text-warn/60 bg-warn/8",
                      tool.risk === "high" && "text-danger/60 bg-danger/8"
                    )}
                  >
                    {tool.risk}
                  </span>
                  {tool.requiresApproval && (
                    <span className="text-[9px] text-warn/50 font-medium" title="Requires explicit approval" data-risk={tool.risk} data-approval="required">
                      approval required
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Blocks */}
      {entry.blocks.length > 0 && (
        <div className="space-y-2">
          {entry.blocks.map((block, i) => (
            <div key={i}>
              {block.title && (
                <h4 className="text-[10px] font-medium text-muted/60 mb-1.5">
                  {block.title}
                </h4>
              )}
              {renderBlock(block)}
            </div>
          ))}
        </div>
      )}

      {/* Error info */}
      {entry.state !== "available" && entry.errorMessage && (
        <div className="bg-danger/8 border border-danger/15 rounded-lg px-2.5 py-1.5">
          <p className="text-[9px] text-danger/60 font-mono">
            {entry.errorCode ? `[${entry.errorCode}] ` : ""}
            {entry.errorMessage}
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  States                                                             */
/* ------------------------------------------------------------------ */

function IntegrationsLoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      {[1, 2].map((i) => (
        <div
          key={i}
          className="bg-surface/30 border border-border/20 rounded-xl h-32"
        />
      ))}
    </div>
  );
}

function IntegrationsEmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-center bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl">
      <FolderOpen size={32} className="text-muted/20 mb-3" aria-hidden="true" />
      <p className="text-sm text-muted/60">
        Open a workspace to see integrations
      </p>
      <p className="text-[11px] text-muted/40 mt-1 max-w-[280px] leading-relaxed">
        Integration providers become available once a workspace with
        repositories is opened. They summarize repository artifacts,
        dependencies, and capabilities.
      </p>
    </div>
  );
}

function IntegrationsErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
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
          Failed to load integrations
        </p>
        <p className="text-[10px] text-danger/60 mt-0.5 font-mono leading-relaxed">
          {message}
        </p>
        <button
          onClick={onRetry}
          className="mt-2 text-[10px] text-accent/70 hover:text-accent transition-colors"
        >
          Retry
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared header                                                      */
/* ------------------------------------------------------------------ */

function HeaderBar({ hasData, onRetry }: { hasData: boolean; onRetry: () => void }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <h2
        className="text-sm font-semibold tracking-tight flex items-center gap-1.5"
        style={{ color: "var(--color-text-primary)" }}
      >
        <Layers size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
        Integrations
      </h2>
      {hasData && (
        <button
          onClick={onRetry}
          className="ml-auto p-1 text-muted/40 hover:text-accent transition-colors rounded hover:bg-surface/30"
          aria-label="Refresh integrations"
          title="Refresh"
        >
          <RefreshCw size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function IntegrationsPanel({
  workspaceLoaded,
}: IntegrationsPanelProps) {
  const [loadState, setLoadState] = useState<IntegrationsLoadState>(() =>
    workspaceLoaded ? { status: "loading" as const } : { status: "idle" as const }
  );
  // Track in-flight AbortController so retry can abort previous request
  const fetchControllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    // Abort any previous in-flight request before starting a new one
    if (fetchControllerRef.current) {
      fetchControllerRef.current.abort();
    }
    const controller = new AbortController();
    fetchControllerRef.current = controller;
    const signal = controller.signal;

    setLoadState({ status: "loading" });
    try {
      const data = await fetchIntegrationsManifest(signal);
      if (signal.aborted) return;
      setLoadState({ status: "success", data });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      const message = err instanceof Error ? err.message : "Unknown error";
      if (signal.aborted) return;
      setLoadState({ status: "error", message });
    }
  }, []);

  const handleRetry = useCallback(() => {
    void load();
  }, [load]);

  // Fetch on mount when workspace is loaded; abort on unmount or replacement
  useEffect(() => {
    if (!workspaceLoaded) return;

    const timer = window.setTimeout(() => void load(), 0);

    return () => {
      window.clearTimeout(timer);
      if (fetchControllerRef.current) {
        fetchControllerRef.current.abort();
        fetchControllerRef.current = null;
      }
    };
  }, [load, workspaceLoaded]);

  /* ── Render ────────────────────────────────────────────────── */

  // Empty state — no workspace
  if (!workspaceLoaded) {
    return (
      <div className="animate-in">
        <HeaderBar hasData={false} onRetry={handleRetry} />
        <IntegrationsEmptyState />
      </div>
    );
  }

  const hasData = loadState.status === "success";

  return (
    <div className="animate-in">
      <HeaderBar hasData={hasData} onRetry={handleRetry} />

      {/* Error state */}
      {loadState.status === "error" && (
        <IntegrationsErrorState
          message={loadState.message}
          onRetry={handleRetry}
        />
      )}

      {/* Loading state */}
      {loadState.status === "loading" && <IntegrationsLoadingSkeleton />}

      {/* Idle state */}
      {loadState.status === "idle" && (
        <div className="text-[10px] text-muted/40 font-mono py-4 text-center">
          Loading integrations...
        </div>
      )}

      {/* Success state */}
      {hasData && (
        <>
          {loadState.data.providers.length === 0 ? (
            <div className="text-[10px] text-muted/40 font-mono py-4 text-center">
              No integration providers available for this workspace.
            </div>
          ) : (
            <div className="space-y-3">
              {loadState.data.providers.map((entry) => (
                <ProviderCard key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
