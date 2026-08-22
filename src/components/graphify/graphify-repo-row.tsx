"use client";

import { useState, useCallback } from "react";
import type { GraphifyStatus } from "@/lib/graphify/types";
import { cn } from "@/lib/utils";
import {
  fetchGraphMeta,
  fetchGraphHtmlUrl,
  fetchWikiSnippet,
} from "@/lib/api/graphify";
import type { GraphMetaDto } from "@/lib/api/graphify";
import type { LucideIcon } from "lucide-react";
import {
  Database,
  FileText,
  Globe,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Loader,
  AlertTriangle,
  BookOpen,
  BarChart3,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Coverage indicator                                                 */
/* ------------------------------------------------------------------ */

function CoverageDot({
  available,
  label,
}: {
  available: boolean | null;
  label: string;
}) {
  const color =
    available === true
      ? "bg-success/60"
      : available === false
        ? "bg-muted/20"
        : "bg-warn/50";

  const title =
    available === true
      ? `${label} — available`
      : available === false
        ? `${label} — absent`
        : `${label} — unknown`;

  return (
    <span
      className={cn("w-1.5 h-1.5 rounded-full shrink-0 inline-block", color)}
      title={title}
      aria-label={title}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Capability badges                                                  */
/* ------------------------------------------------------------------ */

function CapabilityBadge({
  op,
}: {
  op: GraphifyStatus["capabilities"]["operations"][number];
}) {
  const labels: Record<string, string> = {
    query: "query",
    path: "path",
    explain: "explain",
    wiki: "wiki",
    "open-html": "HTML viz",
  };

  return (
    <span className="text-[9px] text-accent/60 bg-accent/8 px-1.5 py-0.5 rounded font-mono border border-accent/10">
      {labels[op] ?? op}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Props                                                              */
/* ------------------------------------------------------------------ */

interface GraphifyRepoRowProps {
  status: GraphifyStatus;
}

/* ------------------------------------------------------------------ */
/*  Lazy meta detail                                                   */
/* ------------------------------------------------------------------ */

function MetaDetail({ meta }: { meta: GraphMetaDto }) {
  return (
    <div className="flex flex-wrap gap-2 mt-1.5 text-[9px] font-mono text-muted/60">
      <span title="Nodes">{meta.nodeCount.toLocaleString()} nodes</span>
      <span className="text-muted/30">·</span>
      <span title="Links">{meta.linkCount.toLocaleString()} links</span>
      {meta.communityCount !== null && (
        <>
          <span className="text-muted/30">·</span>
          <span title="Communities">{meta.communityCount} communities</span>
        </>
      )}
      <span className="text-muted/30">·</span>
      <span title="Graph file size">{fmtSize(meta.sizeBytes)}</span>
    </div>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/*  Artifact icons                                                     */
/* ------------------------------------------------------------------ */

function ArtifactIcon({
  present,
  label,
  icon: Icon,
}: {
  present: boolean;
  label: string;
  icon: LucideIcon;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[9px]",
        present ? "text-muted/60" : "text-muted/20"
      )}
      title={label}
      aria-label={label}
    >
      <Icon size={10} aria-hidden="true" />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export function GraphifyRepoRow({ status }: GraphifyRepoRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [lazyState, setLazyState] = useState<
    { kind: "idle" } | { kind: "loading"; op: string } | { kind: "meta"; data: GraphMetaDto } | { kind: "wiki"; data: string } | { kind: "html"; data: string } | { kind: "error"; op: string; message: string }
  >({ kind: "idle" });

  const repoId = status.repoId;
  const repoName = status.repoRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? repoId;
  const { artifacts, capabilities, available, staleness } = status;

  const toggleExpand = useCallback(() => {
    setExpanded((v) => !v);
    setLazyState({ kind: "idle" });
  }, []);

  const handleLazyOp = useCallback(
    async (op: "meta" | "wiki" | "open-html") => {
      if (lazyState.kind === "loading") return;
      setLazyState({ kind: "loading", op });

      try {
        switch (op) {
          case "meta": {
            const res = await fetchGraphMeta(repoId);
            setLazyState({ kind: "meta", data: res.meta });
            break;
          }
          case "wiki": {
            const res = await fetchWikiSnippet(repoId);
            setLazyState({ kind: "wiki", data: res.snippet });
            break;
          }
          case "open-html": {
            const res = await fetchGraphHtmlUrl(repoId);
            setLazyState({ kind: "html", data: res.url });
            const filePath = res.url.replace(/^file:\/\/+/, "");
            window.location.href = `vscode://file/${filePath
              .split("/")
              .map(encodeURIComponent)
              .join("/")}`;
            break;
          }
        }
      } catch (err) {
        setLazyState({
          kind: "error",
          op,
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    [repoId, lazyState.kind]
  );

  return (
    <div
      className={cn(
        "border border-border/30 rounded-lg transition-colors",
        "hover:bg-surface/20",
        expanded && "bg-surface/10"
      )}
    >
      {/* Header row — always visible */}
      <button
        onClick={toggleExpand}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left"
        aria-expanded={expanded}
        aria-label={`Graphify status for ${repoName}`}
      >
        {/* Coverage dot */}
        <CoverageDot
          available={available}
          label={available ? "Graph available" : "Graph absent"}
        />

        {/* Repo name */}
        <span
          className="text-xs font-medium text-white/80 truncate min-w-0"
          title={repoId}
        >
          {repoName}
        </span>

        {/* Available / absent / unknown label */}
        <span
          className={cn(
            "text-[9px] font-mono shrink-0",
            available
              ? "text-success/60"
              : status.artifacts.graphJson
                ? "text-warn/60"
                : "text-muted/30"
          )}
        >
          {available
            ? "available"
            : status.artifacts.graphJson
              ? "partial"
              : "absent"}
        </span>

        {/* Artifact presence chips (condensed) */}
        <span className="hidden sm:flex items-center gap-1.5 ml-auto shrink-0">
          <ArtifactIcon
            present={artifacts.graphJson}
            label="JSON"
            icon={Database}
          />
          <ArtifactIcon
            present={artifacts.wikiIndex}
            label="Wiki"
            icon={BookOpen}
          />
          <ArtifactIcon
            present={artifacts.graphReport}
            label="Report"
            icon={FileText}
          />
          <ArtifactIcon
            present={artifacts.graphHtml}
            label="HTML"
            icon={Globe}
          />
        </span>

        {/* Capabilities (condensed) */}
        {capabilities.operations.length > 0 && (
          <div className="hidden lg:flex items-center gap-1 shrink-0">
            {capabilities.operations.slice(0, 3).map((op) => (
              <CapabilityBadge key={op} op={op} />
            ))}
            {capabilities.operations.length > 3 && (
              <span className="text-[9px] text-muted/40 font-mono">
                +{capabilities.operations.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Expand indicator */}
        {expanded ? (
          <ChevronUp size={12} className="text-muted/40 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown size={12} className="text-muted/40 shrink-0" aria-hidden="true" />
        )}
      </button>

      {/* Expanded detail section */}
      {expanded && (
        <div className="px-3 pb-3 border-t border-border/20 pt-2 animate-in space-y-2">
          {/* Artifact detail */}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono text-muted/50">
            <span className={artifacts.graphJson ? "text-muted/70" : "text-muted/20"}>
              graph.json: {artifacts.graphJson ? "✓" : "✗"}
            </span>
            <span className={artifacts.graphReport ? "text-muted/70" : "text-muted/20"}>
              GRAPH_REPORT.md: {artifacts.graphReport ? "✓" : "✗"}
            </span>
            <span className={artifacts.wikiIndex ? "text-muted/70" : "text-muted/20"}>
              wiki/index.md: {artifacts.wikiIndex ? "✓" : "✗"}
            </span>
            <span className={artifacts.graphHtml ? "text-muted/70" : "text-muted/20"}>
              graph.html: {artifacts.graphHtml ? "✓" : "✗"}
            </span>
            <span className={artifacts.manifest ? "text-muted/70" : "text-muted/20"}>
              manifest.json: {artifacts.manifest ? "✓" : "✗"}
            </span>
          </div>

          {/* Staleness */}
          <div className="text-[10px] font-mono text-muted/40">
            Staleness: {staleness.status}
            {staleness.graphMtime && (
              <span className="ml-2">
                · mtime: {new Date(staleness.graphMtime).toLocaleDateString("en-CA")}
              </span>
            )}
            {staleness.lastRepoCommitDate && (
              <span className="ml-2">
                · HEAD: {new Date(staleness.lastRepoCommitDate).toLocaleDateString("en-CA")}
              </span>
            )}
          </div>

          {/* Capabilities */}
          {capabilities.operations.length > 0 && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[10px] text-muted/50 font-mono mr-1">
                Operations:
              </span>
              {capabilities.operations.map((op) => (
                <CapabilityBadge key={op} op={op} />
              ))}
            </div>
          )}

          {/* Lazy operation buttons */}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {capabilities.operations.includes("wiki") && (
              <LazyButton
                label="View Wiki"
                op="wiki"
                onClick={() => handleLazyOp("wiki")}
                loading={lazyState}
                icon={BookOpen}
              />
            )}
            {capabilities.operations.includes("open-html") && (
              <LazyButton
                label="Open HTML Viz"
                op="open-html"
                onClick={() => handleLazyOp("open-html")}
                loading={lazyState}
                icon={ExternalLink}
              />
            )}
            {artifacts.graphJson && (
              <LazyButton
                label="Graph Stats"
                op="meta"
                onClick={() => handleLazyOp("meta")}
                loading={lazyState}
                icon={BarChart3}
              />
            )}
          </div>

          {/* Lazy loaded content */}
          {lazyState.kind === "loading" && (
            <div className="flex items-center gap-2 text-[10px] text-muted/50 font-mono mt-1">
              <Loader size={11} className="animate-spin" aria-hidden="true" />
              Loading {lazyState.op}...
            </div>
          )}

          {lazyState.kind === "meta" && (
            <div className="mt-1">
              <MetaDetail meta={lazyState.data} />
            </div>
          )}

          {lazyState.kind === "wiki" && (
            <div className="mt-1 bg-panel/20 rounded-lg p-2.5 max-h-[200px] overflow-y-auto">
              <pre className="text-[9px] font-mono text-muted/60 whitespace-pre-wrap leading-relaxed">
                {lazyState.data}
              </pre>
            </div>
          )}

          {lazyState.kind === "html" && (
            <div className="flex items-center gap-1.5 mt-1 text-[10px] text-success/60 font-mono">
              <ExternalLink size={10} aria-hidden="true" />
              Opened in new tab
            </div>
          )}

          {lazyState.kind === "error" && (
            <div className="flex items-center gap-1.5 mt-1 text-[9px] text-danger/70 font-mono">
              <AlertTriangle size={10} aria-hidden="true" />
              {lazyState.op}: {lazyState.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Lazy action button                                                 */
/* ------------------------------------------------------------------ */

function LazyButton({
  label,
  op,
  onClick,
  loading,
  icon: Icon,
}: {
  label: string;
  op: string;
  onClick: () => void;
  loading: { kind: string; op?: string };
  icon: LucideIcon;
}) {
  const isLoading = loading.kind === "loading" && loading.op === op;

  return (
    <button
      onClick={onClick}
      disabled={isLoading}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-mono
        bg-accent/10 text-accent/70 border border-accent/15
        hover:bg-accent/20 hover:text-accent transition-colors
        disabled:opacity-40 disabled:cursor-not-allowed"
      aria-label={label}
    >
      {isLoading ? (
        <Loader size={10} className="animate-spin" aria-hidden="true" />
      ) : (
        <Icon size={10} aria-hidden="true" />
      )}
      {label}
    </button>
  );
}
