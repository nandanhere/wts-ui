/**
 * Built-in Graphify provider — read-only integration summarizing graphify
 * artifact presence across registered repositories.
 *
 * Contract:
 * - Read-only. Never loads graph.json, never generates graphs, never spawns git.
 * - Detects filesystem artifacts (graphify-out/ dir) for each registered repo root.
 * - Returns repo-level counts (available/partial/absent) and artifact presence.
 * - Does NOT expose repo paths, graph contents, or perform mutations.
 * - No external URLs (links omitted for built-in Graphify).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  IntegrationProvider,
  WorkspaceIntegrationContext,
  UiBlock,
  ProviderState,
} from "../types";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const PROVIDER_ID = "built-in-graphify";

/* ------------------------------------------------------------------ */
/*  Provider implementation                                            */
/* ------------------------------------------------------------------ */

export const graphifyProvider: IntegrationProvider = {
  id: PROVIDER_ID,
  name: "Graphify",
  description:
    "Repository graph artifact inventory — detects graphify-out files across workspace repos.",
  capabilities: ["dependencies", "documentation"],
  riskLevel: "readonly",
  tools: [],

  getState(ctx: WorkspaceIntegrationContext): ProviderState {
    if (ctx.repos.length === 0) return "unavailable";
    return "available";
  },

  getBlocks(ctx: WorkspaceIntegrationContext): UiBlock[] {
    return buildGraphifyBlocks(ctx);
  },
};

/* ------------------------------------------------------------------ */
/*  Artifact detection (lightweight, filesystem-only)                  */
/* ------------------------------------------------------------------ */

interface RepoGraphSummary {
  repoId: string;
  displayName: string;
  hasGraphJson: boolean;
  hasWiki: boolean;
  hasReport: boolean;
}

function scanRepoGraphs(ctx: WorkspaceIntegrationContext): RepoGraphSummary[] {
  // Use try/catch per repo to keep failures isolated
  return ctx.repos.map((repo) => {
    try {
      // Minimal filesystem detection — just check artifact existence
      const graphDir = join(repo.rootPath, "graphify-out");
      const hasGraphJson = fileExists(join(graphDir, "graph.json"));
      const hasWiki = fileExists(join(graphDir, "wiki", "index.md"));
      const hasReport = fileExists(join(graphDir, "GRAPH_REPORT.md"));

      return {
        repoId: repo.id,
        displayName: repo.displayName,
        hasGraphJson,
        hasWiki,
        hasReport,
      };
    } catch {
      // Isolated failure — mark as unknown/absent
      return {
        repoId: repo.id,
        displayName: repo.displayName,
        hasGraphJson: false,
        hasWiki: false,
        hasReport: false,
      };
    }
  });
}

function fileExists(filePath: string): boolean {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Block builder                                                      */
/* ------------------------------------------------------------------ */

function buildGraphifyBlocks(ctx: WorkspaceIntegrationContext): UiBlock[] {
  const summaries = scanRepoGraphs(ctx);

  // ── Summary metric block ──
  const available = summaries.filter(
    (s) => s.hasGraphJson && (s.hasReport || s.hasWiki)
  ).length;
  const partial = summaries.filter(
    (s) => s.hasGraphJson && !s.hasReport && !s.hasWiki
  ).length;
  const absent = summaries.length - available - partial;

  const blocks: UiBlock[] = [
    {
      type: "metric-list",
      id: "graphify-summary",
      title: "Graph Coverage",
      items: [
        {
          label: "Total repos",
          value: String(summaries.length),
          color: "default",
        },
        ...(available > 0
          ? [
              {
                label: "Available",
                value: String(available),
                color: "success" as const,
              },
            ]
          : []),
        ...(partial > 0
          ? [
              {
                label: "Partial",
                value: String(partial),
                color: "warn" as const,
              },
            ]
          : []),
        ...(absent > 0
          ? [
              {
                label: "Absent",
                value: String(absent),
                color: "default" as const,
              },
            ]
          : []),
      ],
    },
  ];

  // ── Per-repo status list ──
  const statusItems = summaries.map((s) => ({
    label: s.displayName,
    status: (s.hasGraphJson && (s.hasReport || s.hasWiki)
      ? "ok"
      : s.hasGraphJson
        ? "warn"
        : "unknown") as "ok" | "warn" | "unknown",
    detail: s.hasGraphJson
      ? s.hasWiki && s.hasReport
        ? "graph + wiki + report"
        : s.hasWiki
          ? "graph + wiki"
          : s.hasReport
            ? "graph + report"
            : "graph only"
      : "no graph",
  }));

  blocks.push({
    type: "status-list",
    id: "graphify-repos",
    title: "Repository Graphs",
    items: statusItems,
  });

  // ── Wiki/report counts (if any exist) ──
  const wikiCount = summaries.filter((s) => s.hasWiki).length;
  const reportCount = summaries.filter((s) => s.hasReport).length;

  if (wikiCount > 0 || reportCount > 0) {
    blocks.push({
      type: "metric-list",
      id: "graphify-artifacts",
      title: "Artifacts",
      items: [
        ...(wikiCount > 0
          ? [
              {
                label: "Wikis",
                value: String(wikiCount),
                color: "default" as const,
              },
            ]
          : []),
        ...(reportCount > 0
          ? [
              {
                label: "Reports",
                value: String(reportCount),
                color: "default" as const,
              },
            ]
          : []),
      ],
    });
  }

  return blocks;
}
