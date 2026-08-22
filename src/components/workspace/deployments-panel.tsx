"use client";

import { useState, useCallback } from "react";
import { scanReposForConfig } from "@/lib/api/deployments";
import type {
  DeploymentsView,
  RepoConfigSummary,
} from "@/lib/api/deployments";
import {
  aggregateDeploymentsView,
  shortenFingerprint,
  groupFilesByKind,
} from "@/lib/api/deployments";
import {
  Rocket,
  ShieldOff,
  FileSearch,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  FileText,
  Key,
  Layers,
  EyeOff,
  XCircle,
  CircleOff,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Props                                                             */
/* ------------------------------------------------------------------ */

interface DeploymentsPanelProps {
  /** Whether a workspace is currently loaded */
  workspaceLoaded: boolean;
  /** Registered repository IDs from the loaded workspace */
  repoIds: string[];
  /** Display metadata per repo (repoId → displayName). Never contains absolute paths. */
  repoDisplayMap: Record<string, { displayName: string }>;
}

/* ------------------------------------------------------------------ */
/*  Scan state                                                        */
/* ------------------------------------------------------------------ */

type ScanState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "loaded"; view: DeploymentsView }
  | { status: "error"; message: string }
  | { status: "empty"; view: DeploymentsView };

/* ------------------------------------------------------------------ */
/*  Repo detail sub-component                                         */
/* ------------------------------------------------------------------ */

function RepoConfigDetail({
  summary,
  defaultOpen,
}: {
  summary: RepoConfigSummary;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const kindGroups = groupFilesByKind(summary.files);

  return (
    <div className="border border-border/30 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-surface/20 transition-colors"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown size={12} className="text-muted/40 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight size={12} className="text-muted/40 shrink-0" aria-hidden="true" />
        )}
        <span className="text-xs font-medium text-white/80">{summary.displayName}</span>
        <div className="flex items-center gap-2 ml-auto text-[10px] text-muted/50 font-mono">
          <span title="Config files">{summary.totalFiles}</span>
          {summary.highRelevanceFiles > 0 && (
            <span className="text-accent/70" title="High deployment relevance">
              ★{summary.highRelevanceFiles}
            </span>
          )}
          {summary.secretFiles.length > 0 && (
            <span className="text-warn/60" title="Probable secret files">
              ◆{summary.secretFiles.length}
            </span>
          )}
          {summary.truncated && (
            <span className="text-danger/60" title="Truncated">⚠</span>
          )}
        </div>
      </button>

      {/* Expanded content */}
      {open && (
        <div className="px-3 pb-3 space-y-2.5 border-t border-border/20">
          {/* Metrics row */}
          <div className="flex flex-wrap gap-2 pt-2">
            <MetricChip
              icon={<FileText size={10} aria-hidden="true" />}
              label="Config files"
              value={String(summary.totalFiles)}
            />
            <MetricChip
              icon={<Layers size={10} aria-hidden="true" />}
              label="High relevance"
              value={String(summary.highRelevanceFiles)}
              accent
            />
            {summary.environments.length > 0 && (
              <MetricChip
                icon={<Layers size={10} aria-hidden="true" />}
                label="Environments"
                value={summary.environments.join(", ")}
              />
            )}
            <MetricChip
              icon={<FileSearch size={10} aria-hidden="true" />}
              label="Scan time"
              value={`${summary.scanTimeMs}ms`}
            />
          </div>

          {/* Probable-secret files (names only) */}
          {summary.secretFiles.length > 0 && (
            <div>
              <span className="text-[10px] font-medium text-warn/70 flex items-center gap-1 mb-1">
                <Key size={10} aria-hidden="true" />
                Probable secret files
              </span>
              <ul className="space-y-0.5">
                {summary.secretFiles.map((f) => (
                  <li
                    key={f}
                    className="text-[10px] text-warn/50 font-mono truncate pl-3"
                  >
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Config files by kind */}
          <div>
            <span className="text-[10px] font-medium text-muted/60 flex items-center gap-1 mb-1">
              <FileText size={10} aria-hidden="true" />
              Config by kind
            </span>
            <div className="flex flex-wrap gap-1">
              {kindGroups.map((g) => (
                <span
                  key={g.kind}
                  className="text-[9px] text-muted/50 bg-surface/30 px-1.5 py-0.5 rounded font-mono"
                >
                  {g.kind}: {g.count}
                </span>
              ))}
            </div>
          </div>

          {/* File listing (fingerprints shortened) */}
          {summary.files.length > 0 && (
            <div>
              <span className="text-[10px] font-medium text-muted/60 flex items-center gap-1 mb-1">
                <FileSearch size={10} aria-hidden="true" />
                Files
              </span>
              <div className="max-h-32 overflow-y-auto space-y-0.5 text-[9px] font-mono text-muted/40">
                {summary.files.map((f) => {
                  const envTag =
                    f.likelyEnvironments.length > 0
                      ? f.likelyEnvironments.join(",")
                      : null;
                  return (
                    <div
                      key={f.repoRelativePath}
                      className="flex items-center gap-2 truncate"
                      title={`${f.repoRelativePath} (${f.kind}, ${(f.size / 1024).toFixed(1)} KB)`}
                    >
                      <span
                        className={cn(
                          "shrink-0 w-1.5 h-1.5 rounded-full",
                          f.probableSecret
                            ? "bg-warn/50"
                            : f.deploymentRelevance >= 0.7
                              ? "bg-accent/50"
                              : "bg-muted/20",
                        )}
                      />
                      <span className="truncate">{f.repoRelativePath}</span>
                      <span className="shrink-0 text-muted/30">{shortenFingerprint(f.fingerprint)}</span>
                      {envTag && (
                        <span className="shrink-0 text-accent/40">{envTag}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Errors */}
          {summary.errors.length > 0 && (
            <div className="text-[10px] text-danger/60 space-y-0.5">
              {summary.errors.map((err, i) => (
                <div key={i} className="flex items-start gap-1">
                  <AlertTriangle size={10} className="shrink-0 mt-0.5" aria-hidden="true" />
                  <span>{err}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Metric chip                                                       */
/* ------------------------------------------------------------------ */

function MetricChip({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-mono",
        accent
          ? "bg-accent/10 text-accent/80"
          : "bg-surface/30 text-muted/50",
      )}
    >
      {icon}
      <span className="font-medium">{value}</span>
      <span className="text-muted/40 hidden sm:inline">{label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

/**
 * Deployments panel — scans registered repos for config inventory and
 * shows actionable deployment readiness metrics.
 *
 * Read-only: never reads/displays file content/values.
 * No deployment execution available.
 * On explicit user click only, scans all registered repos.
 */
export function DeploymentsPanel({
  workspaceLoaded,
  repoIds,
  repoDisplayMap,
}: DeploymentsPanelProps) {
  const [scanState, setScanState] = useState<ScanState>({ status: "idle" });

  const handleScan = useCallback(async () => {
    if (repoIds.length === 0) return;
    setScanState({ status: "scanning" });

    try {
      const response = await scanReposForConfig(repoIds);
      const view = aggregateDeploymentsView(
        response.results,
        Object.fromEntries(
          Object.entries(repoDisplayMap).map(([id, meta]) => [id, meta.displayName]),
        ),
        response.unknownRepoIds,
      );

      if (view.totalConfigFiles === 0 && !view.anyErrors) {
        setScanState({ status: "empty", view });
      } else {
        setScanState({ status: "loaded", view });
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown error";
      setScanState({ status: "error", message });
    }
  }, [repoIds, repoDisplayMap]);

  const handleRetry = useCallback(() => {
    void handleScan();
  }, [handleScan]);

  const handleReset = useCallback(() => {
    setScanState({ status: "idle" });
  }, []);

  if (!workspaceLoaded || repoIds.length === 0) {
    return (
      <div className="animate-in">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-semibold tracking-tight flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
            <Rocket size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
            Deployments
          </h2>
        </div>
        <div className="flex flex-col items-center justify-center py-14 text-center bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl">
          <CircleOff size={32} className="text-muted/20 mb-3" aria-hidden="true" />
          <p className="text-sm text-muted/60">No workspace open</p>
          <p className="text-[11px] text-muted/40 mt-1 max-w-[280px] leading-relaxed">
            Open a workspace with repositories to scan for deployment
            configuration.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-in space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-1">
        <h2 className="text-sm font-semibold tracking-tight flex items-center gap-1.5" style={{ color: "var(--color-text-primary)" }}>
          <Rocket size={14} style={{ color: "var(--accent)" }} aria-hidden="true" />
          Deployments
        </h2>

        <div className="flex items-center gap-1.5">
          {scanState.status !== "idle" && scanState.status !== "scanning" && (
            <button
              onClick={handleReset}
              className="text-[10px] text-muted/50 hover:text-muted transition-colors px-2 py-1 rounded"
            >
              Clear
            </button>
          )}
          <button
            onClick={handleScan}
            disabled={scanState.status === "scanning"}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all bg-accent/15 text-accent border border-accent/20 hover:bg-accent/25 disabled:opacity-40"
          >
            {scanState.status === "scanning" ? (
              <RefreshCw size={11} className="animate-spin" aria-hidden="true" />
            ) : (
              <FileSearch size={11} aria-hidden="true" />
            )}
            {scanState.status === "scanning" ? "Scanning…" : "Scan repos"}
          </button>
        </div>
      </div>

      {/* Safety notice */}
      <div className="flex items-start gap-2 px-3 py-2 bg-warn/8 border border-warn/15 rounded-lg">
        <ShieldOff size={12} className="text-warn/60 shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-[10px] text-warn/60 leading-relaxed">
          <strong className="font-medium">Metadata only.</strong> Non-secret
          config files are read only to calculate fingerprints; contents and
          secret values are never returned or displayed. Suspected secret files
          are not fingerprinted. Deployment execution is unavailable.
        </p>
      </div>

      {/* Scanning state */}
      {scanState.status === "scanning" && (
        <div className="flex flex-col items-center justify-center py-10 text-center bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl">
          <RefreshCw size={24} className="text-accent/40 animate-spin mb-3" aria-hidden="true" />
          <p className="text-xs text-muted/60">Scanning {repoIds.length} repos for config files…</p>
        </div>
      )}

      {/* Error state */}
      {scanState.status === "error" && (
        <div className="bg-danger/10 border border-danger/20 rounded-xl p-4 flex items-start gap-2.5">
          <XCircle size={14} className="text-danger shrink-0 mt-0.5" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-xs text-danger/80 font-medium">Scan failed</p>
            <p className="text-[10px] text-danger/60 mt-0.5 font-mono">{scanState.message}</p>
          </div>
          <button
            onClick={handleRetry}
            className="text-[10px] text-accent/70 hover:text-accent transition-colors shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {scanState.status === "empty" && (
        <div className="flex flex-col items-center justify-center py-10 text-center bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl">
          <FileSearch size={24} className="text-muted/20 mb-3" aria-hidden="true" />
          <p className="text-xs text-muted/60">No config files found</p>
          <p className="text-[10px] text-muted/40 mt-1 max-w-[300px] leading-relaxed">
            Scanned {repoIds.length} repos — no deployment or configuration files
            were detected. This may be expected for utility or library repositories.
          </p>
        </div>
      )}

      {/* Loaded state */}
      {scanState.status === "loaded" && (
        <>
          {/* Summary bar */}
          <div className="flex flex-wrap gap-2">
            <MetricChip
              icon={<FileText size={11} aria-hidden="true" />}
              label="Config files"
              value={String(scanState.view.totalConfigFiles)}
              accent
            />
            <MetricChip
              icon={<Layers size={11} aria-hidden="true" />}
              label="High relevance"
              value={String(scanState.view.totalHighRelevance)}
              accent
            />
            <MetricChip
              icon={<Key size={11} aria-hidden="true" />}
              label="Probable secrets"
              value={String(scanState.view.totalSecretFiles)}
            />
            <MetricChip
              icon={<Layers size={11} aria-hidden="true" />}
              label="Environments"
              value={scanState.view.allEnvironments.join(", ") || "none"}
            />
            {scanState.view.anyTruncated && (
              <MetricChip
                icon={<AlertTriangle size={11} aria-hidden="true" />}
                label="Truncated"
                value="Yes"
              />
            )}
            {scanState.view.anyErrors && (
              <MetricChip
                icon={<AlertTriangle size={11} aria-hidden="true" />}
                label="Errors"
                value="Yes"
              />
            )}
            {scanState.view.unknownRepoIds.length > 0 && (
              <MetricChip
                icon={<XCircle size={11} aria-hidden="true" />}
                label="Unknown repos"
                value={String(scanState.view.unknownRepoIds.length)}
              />
            )}
          </div>

          {/* Per-repo detail */}
          <div className="space-y-2">
            {scanState.view.summaries.map((s, i) => (
              <RepoConfigDetail
                key={s.repoId}
                summary={s}
                defaultOpen={i === 0}
              />
            ))}
          </div>

          {/* Unknown repo IDs */}
          {scanState.view.unknownRepoIds.length > 0 && (
            <div className="border border-border/30 rounded-lg p-3">
              <span className="text-[10px] font-medium text-danger/70 flex items-center gap-1 mb-1">
                <AlertTriangle size={10} aria-hidden="true" />
                Unknown repository IDs
              </span>
              <p className="text-[9px] text-muted/40 font-mono">
                {scanState.view.unknownRepoIds.join(", ")}
              </p>
            </div>
          )}
        </>
      )}

      {/* Idle state: prompt to scan */}
      {scanState.status === "idle" && (
        <div className="flex flex-col items-center justify-center py-10 text-center bg-panel/30 backdrop-blur-sm border border-border/40 rounded-xl">
          <EyeOff size={24} className="text-muted/20 mb-3" aria-hidden="true" />
          <p className="text-xs text-muted/60">No scan data</p>
          <p className="text-[10px] text-muted/40 mt-1 max-w-[300px] leading-relaxed">
            Click <strong className="text-accent/80 font-medium">Scan repos</strong> above to
            discover configuration files across {repoIds.length} registered
            repositories. File contents are never exposed.
          </p>
        </div>
      )}
    </div>
  );
}
