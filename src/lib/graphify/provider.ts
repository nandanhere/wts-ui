/**
 * Graphify provider — read-only filesystem detection of graphify artifacts
 * for a single repository.
 *
 * Detects presence of graphify-out/graph.json, wiki/index.md, GRAPH_REPORT.md,
 * graph.html, and manifest.json.  Returns metadata only — never loads the
 * contents of graph.json into memory.
 *
 * Registry/canonical path authorization is enforced: only paths that are
 * registered repos (passed explicitly) are accepted.  No arbitrary path
 * resolution.
 */

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type {
  GraphifyStatus,
  GraphifyArtifacts,
  GraphifyStaleness,
  GraphifyCapabilities,
} from "./types";

/** Name of the graphify output directory */
const GRAPHIFY_OUT = "graphify-out";

/* ------------------------------------------------------------------ */
/*  Authorization guard                                                */
/* ------------------------------------------------------------------ */

/** Assert that a path is in the set of authorized repo roots */
export function assertAuthorizedRepoRoot(
  repoRoot: string,
  authorizedRoots: Set<string>
): void {
  if (!authorizedRoots.has(repoRoot)) {
    throw new Error(
      `Unauthorized path: "${repoRoot}" is not a registered repository root`
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Artifact detection                                                 */
/* ------------------------------------------------------------------ */

/** Detect presence of each graphify artifact in a repo root */
export function detectArtifacts(repoRoot: string): GraphifyArtifacts {
  const out = join(repoRoot, GRAPHIFY_OUT);

  return {
    graphJson: existsSync(join(out, "graph.json")),
    wikiIndex: existsSync(join(out, "wiki", "index.md")),
    graphReport: existsSync(join(out, "GRAPH_REPORT.md")),
    graphHtml: existsSync(join(out, "graph.html")),
    manifest: existsSync(join(out, "manifest.json")),
  };
}

/** Determine whether a graph is "available" (fully present) */
export function isGraphAvailable(artifacts: GraphifyArtifacts): boolean {
  // graphJson is the primary indicator; at least one human-readable
  // artifact (report or wiki) makes it navigable
  return artifacts.graphJson && (artifacts.graphReport || artifacts.wikiIndex);
}

/* ------------------------------------------------------------------ */
/*  Staleness — deliberately conservative                              */
/* ------------------------------------------------------------------ */

/** Get mtime of a file in ISO format, or null */
function fileMtime(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

/** Get the date of the most recent git commit affecting a path */
function gitLastCommitDate(
  repoRoot: string,
  path: string
): string | null {
  try {
    const r = spawnSync(
      "git",
      ["-C", repoRoot, "log", "-1", "--format=%cI", "--", path],
      { stdio: "pipe", timeout: 5000, encoding: "utf-8" }
    );
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** Get the date of the most recent commit in the repo */
function gitHeadCommitDate(repoRoot: string): string | null {
  try {
    const r = spawnSync(
      "git",
      ["-C", repoRoot, "log", "-1", "--format=%cI"],
      { stdio: "pipe", timeout: 5000, encoding: "utf-8" }
    );
    if (r.status === 0 && r.stdout.trim()) {
      return r.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/** Build staleness metadata for a repo */
export function buildStaleness(repoRoot: string): GraphifyStaleness {
  const graphJsonPath = join(repoRoot, GRAPHIFY_OUT, "graph.json");
  const outDir = join(repoRoot, GRAPHIFY_OUT);

  return {
    status: "unknown", // Always unknown — we never claim freshness
    lastGraphCommitDate: gitLastCommitDate(repoRoot, outDir),
    lastRepoCommitDate: gitHeadCommitDate(repoRoot),
    graphMtime: fileMtime(graphJsonPath),
  };
}

/* ------------------------------------------------------------------ */
/*  Capabilities                                                       */
/* ------------------------------------------------------------------ */

/** Determine available read-only operations based on artifacts */
export function buildCapabilities(
  artifacts: GraphifyArtifacts,
  cliAvailable: boolean
): GraphifyCapabilities {
  const operations: GraphifyCapabilities["operations"] = [];

  if (!artifacts.graphJson) {
    return { operations: [] };
  }

  // All of these require graphJson + the CLI tool
  if (cliAvailable) {
    operations.push("query");
    operations.push("path");
    operations.push("explain");
  }

  if (artifacts.wikiIndex) {
    operations.push("wiki");
  }

  if (artifacts.graphHtml) {
    operations.push("open-html");
  }

  return { operations };
}

/* ------------------------------------------------------------------ */
/*  CLI detection                                                      */
/* ------------------------------------------------------------------ */

/** Check whether the `graphify` CLI is available on PATH */
export function isGraphifyCliAvailable(): boolean {
  try {
    const r = spawnSync("which", ["graphify"], {
      stdio: "pipe",
      timeout: 3000,
      encoding: "utf-8",
    });
    return r.status === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Composite status for a single repo                                 */
/* ------------------------------------------------------------------ */

/**
 * Build full GraphifyStatus for a single authorized repository root.
 *
 * @param repoId   — Stable repository ID
 * @param repoRoot — Absolute canonical path to the repo working tree
 */
export function buildGraphifyStatus(
  repoId: string,
  repoRoot: string
): GraphifyStatus {
  const cliAvailable = isGraphifyCliAvailable();
  const artifacts = detectArtifacts(repoRoot);
  const available = isGraphAvailable(artifacts);
  const staleness = available ? buildStaleness(repoRoot) : emptyStaleness();
  const capabilities = buildCapabilities(artifacts, cliAvailable);

  return {
    repoId,
    repoRoot,
    graphifyCliAvailable: cliAvailable,
    artifacts,
    available,
    staleness,
    capabilities,
  };
}

function emptyStaleness(): GraphifyStaleness {
  return {
    status: "unknown",
    lastGraphCommitDate: null,
    lastRepoCommitDate: null,
    graphMtime: null,
  };
}
