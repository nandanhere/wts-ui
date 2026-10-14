/**
 * Config inventory — domain types for bounded, read-only configuration discovery.
 *
 * Scans registered Git repositories for deployment/application config files
 * and returns metadata only (never content/values).
 *
 * Part of the snapshot/inventory family — see snapshot/types.ts for patterns.
 */

/* ------------------------------------------------------------------ */
/*  Config file kind classification                                   */
/* ------------------------------------------------------------------ */

export type ConfigKind =
  | "yaml"
  | "yml"
  | "json"
  | "toml"
  | "docker-compose"
  | "helm-chart"
  | "kubernetes"
  | "gitlab-ci"
  | "github-ci"
  | "env-example"
  | "dotenv"
  | "ini"
  | "other";

/* ------------------------------------------------------------------ */
/*  Scan limits                                                       */
/* ------------------------------------------------------------------ */

export interface ScanLimits {
  /** Max directory traversal depth from repo root (default 8) */
  maxDepth: number;
  /** Max config files to return per repo (default 100) */
  maxFiles: number;
  /** Max bytes to read per file for fingerprinting (default 256 KB) */
  maxFileBytes: number;
  /** Total bytes to fingerprint across all files in one scan (default 10 MB) */
  totalBytes: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxDepth: 8,
  maxFiles: 100,
  maxFileBytes: 256 * 1024,
  totalBytes: 10 * 1024 * 1024,
};

/* ------------------------------------------------------------------ */
/*  Per-file metadata                                                 */
/* ------------------------------------------------------------------ */

export interface ConfigFileMetadata {
  /** Stable repository ID (matches git registry) */
  repoId: string;
  /** Path relative to the workspace file's directory */
  workspaceRelativePath: string;
  /** Path relative to the repository root */
  repoRelativePath: string;
  /** Classified configuration kind */
  kind: ConfigKind;
  /** File size in bytes */
  size: number;
  /** Last modification time (ISO-8601 string) */
  mtime: string;
  /** SHA-256 hex fingerprint of file content (up to maxFileBytes) */
  fingerprint: string;
  /** True if the filename suggests it may contain secrets */
  probableSecret: boolean;
  /** Deployment relevance score 0.0–1.0 (heuristic) */
  deploymentRelevance: number;
  /** Likely environment labels — may overlap or be empty */
  likelyEnvironments: string[];
}

/* ------------------------------------------------------------------ */
/*  Scan result                                                       */
/* ------------------------------------------------------------------ */

export interface ConfigInventoryResult {
  /** Repository ID that was scanned */
  repoId: string;
  /** Absolute path to the repository root */
  repoRootPath: string;
  /** Discovered config file metadata (never content) */
  files: ConfigFileMetadata[];
  /** True if limits caused early truncation */
  truncated: boolean;
  /** Elapsed wall-clock time for the scan in milliseconds */
  scanTimeMs: number;
  /** Non-fatal errors encountered during scanning */
  errors: string[];
  /** The limits that were applied */
  limits: ScanLimits;
}

/* ------------------------------------------------------------------ */
/*  Scanner options                                                   */
/* ------------------------------------------------------------------ */

export interface ScannerOptions {
  /** Override default scan limits */
  limits?: Partial<ScanLimits>;
  /** Additional directory name patterns to exclude (regexp source strings) */
  excludeDirPatterns?: string[];
  /** Absolute path to the workspace file (for workspace-relative paths) */
  workspaceFilePath?: string;
}

/* ------------------------------------------------------------------ */
/*  API request / response                                            */
/* ------------------------------------------------------------------ */

export interface ConfigInventoryRequest {
  /** One or more registered repo IDs */
  repoIds: string[];
  /** Optional scan limit overrides */
  limits?: Partial<ScanLimits>;
  /** Optional additional exclude directory patterns */
  excludeDirPatterns?: string[];
}

export interface ConfigInventoryResponse {
  results: ConfigInventoryResult[];
  /** Repo IDs that were requested but not found in the registry */
  unknownRepoIds: string[];
  /** True if any result was truncated */
  anyTruncated: boolean;
}
