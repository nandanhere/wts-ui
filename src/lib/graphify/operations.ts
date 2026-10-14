/**
 * Safe lazy read-only operations for existing graphify graphs.
 *
 * These operations are small, fast, and safe:
 *   - metadata   — return lightweight metadata from graph.json (node/link/community counts)
 *   - open-html  — return the file:// URL to graph.html (does not serve the file)
 *   - wiki       — return the first N lines of wiki/index.md (capped)
 *
 * IMPORTANT: This module NEVER loads the full graph.json into memory
 * for content exploration.  Only counts and paths are extracted.
 * Graph generation, updates, watchers, and expensive commands are
 * explicitly out of scope.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GraphifyArtifacts } from "./types";

const GRAPHIFY_OUT = "graphify-out";
const MAX_GRAPH_META_BYTES = 10 * 1024 * 1024;
const MAX_COMMUNITY_SCAN_NODES = 100_000;

/* ------------------------------------------------------------------ */
/*  Safe read operations                                               */
/* ------------------------------------------------------------------ */

/** Lightweight graph metadata from graph.json (no full contents loaded) */
export interface GraphMeta {
  nodeCount: number;
  linkCount: number;
  /** Number of distinct communities, if available */
  communityCount: number | null;
  /** File size of graph.json in bytes */
  sizeBytes: number;
}

/**
 * Extract lightweight metadata from graph.json.
 * Reads only the top-level keys (nodes, links lengths) — does NOT
 * enumerate or return individual node/link contents.
 *
 * Returns null if graph.json is absent or unparseable.
 */
export function getGraphMeta(repoRoot: string): GraphMeta | null {
  const graphPath = join(repoRoot, GRAPHIFY_OUT, "graph.json");
  if (!existsSync(graphPath)) return null;

  try {
    const sizeBytes = statSync(graphPath).size;
    if (sizeBytes > MAX_GRAPH_META_BYTES) return null;
    const raw = readFileSync(graphPath, "utf-8");

    // Minimal parse — just counts, not contents
    const parsed = JSON.parse(raw);
    const nodes = parsed.nodes;
    const links = parsed.links;

    if (!Array.isArray(nodes) || !Array.isArray(links)) return null;

    // Count distinct communities without iterating node contents deeply
    const communityCount = nodes.length > 0 ? countCommunities(nodes) : null;

    return {
      nodeCount: nodes.length,
      linkCount: links.length,
      communityCount,
      sizeBytes,
    };
  } catch {
    return null;
  }
}

/** Count distinct communities (minimal iteration, no label/content access) */
function countCommunities(nodes: unknown[]): number | null {
  if (nodes.length > MAX_COMMUNITY_SCAN_NODES) return null;
  const seen = new Set<number>();
  for (const node of nodes) {
    if (node && typeof node === "object" && "community" in node) {
      const c = (node as Record<string, unknown>).community;
      if (typeof c === "number") seen.add(c);
    }
  }
  return seen.size > 0 ? seen.size : null;
}

/**
 * Get the file:// URI for graph.html.
 * The caller is responsible for opening this via a client-side action;
 * this module does NOT serve or open the file.
 */
export function getGraphHtmlUrl(repoRoot: string): string | null {
  const htmlPath = join(repoRoot, GRAPHIFY_OUT, "graph.html");
  if (!existsSync(htmlPath)) return null;
  return `file://${htmlPath}`;
}

/** Capped content from wiki/index.md (first N lines, returns raw text) */
export function getWikiSnippet(
  repoRoot: string,
  maxLines = 50
): string | null {
  const wikiPath = join(repoRoot, GRAPHIFY_OUT, "wiki", "index.md");
  if (!existsSync(wikiPath)) return null;

  try {
    const content = readFileSync(wikiPath, "utf-8");
    const lines = content.split("\n").slice(0, maxLines);
    return lines.join("\n");
  } catch {
    return null;
  }
}

/** Available read-only operations for a given set of artifacts */
export interface LazyOpAvailability {
  meta: boolean;
  openHtml: boolean;
  wiki: boolean;
}

export function getLazyOpAvailability(
  artifacts: GraphifyArtifacts
): LazyOpAvailability {
  return {
    meta: artifacts.graphJson,
    openHtml: artifacts.graphHtml,
    wiki: artifacts.wikiIndex,
  };
}
