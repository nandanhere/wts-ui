/**
 * Graphify capability types — lightweight metadata about graphify artifacts
 * for a discovered repository.  No graph.json contents are stored here.
 *
 * This is a read-only metadata layer.  Absence of graphify artifacts is
 * non-fatal and represented as `available: false`.
 */

/** Artifact presence flags for a single repository */
export interface GraphifyArtifacts {
  /** Whether graphify-out/graph.json exists on disk */
  graphJson: boolean;
  /** Whether graphify-out/wiki/index.md exists on disk */
  wikiIndex: boolean;
  /** Whether graphify-out/GRAPH_REPORT.md exists on disk */
  graphReport: boolean;
  /** Whether graphify-out/graph.html exists on disk */
  graphHtml: boolean;
  /** Whether graphify-out/manifest.json exists on disk */
  manifest: boolean;
}

/** Staleness information — deliberately conservative */
export interface GraphifyStaleness {
  /** Always "unknown" unless reliable HEAD metadata is available */
  status: "unknown";
  /** ISO date of the most recent git commit affecting graphify-out/, or null */
  lastGraphCommitDate: string | null;
  /** ISO date of the most recent git commit in the repo, or null */
  lastRepoCommitDate: string | null;
  /** ISO date of graph.json's mtime on disk, or null */
  graphMtime: string | null;
}

/** Safe small-capability operations available on existing graphs */
export interface GraphifyCapabilities {
  /** Available operations — empty array if graph is absent */
  operations: GraphifyOperation[];
}

export type GraphifyOperation =
  | "query"
  | "path"
  | "explain"
  | "wiki"
  | "open-html";

/** Complete graphify metadata for one repo */
export interface GraphifyStatus {
  /** Repository ID (matches workspace Repository.id) */
  repoId: string;
  /** Repository root path */
  repoRoot: string;
  /** Whether graphify is installed and available as a CLI */
  graphifyCliAvailable: boolean;
  /** Artifact presence */
  artifacts: GraphifyArtifacts;
  /** Whether the graph is fully present (graphJson + graphReport or wiki) */
  available: boolean;
  /** Staleness */
  staleness: GraphifyStaleness;
  /** Capabilities */
  capabilities: GraphifyCapabilities;
}

/** API response envelope */
export interface GraphifyStatusResponse {
  /** Repo-level graphify statuses keyed by repo ID */
  repos: Record<string, GraphifyStatus>;
  /** Any non-fatal errors encountered */
  errors: string[];
}

/** Query params for the single-repo endpoint */
export interface GraphifyQueryParams {
  repoId?: string;
  repoRoot?: string;
}
