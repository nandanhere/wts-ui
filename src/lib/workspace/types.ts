/**
 * Phase 1 — Workspace and repository domain types.
 * These define the canonical data model for a multi-root VS Code workspace.
 * No UI, no mutations, no Graphify — just structure.
 */

/** A single folder entry from a .code-workspace file */
export interface WorkspaceFolder {
  /** Display name (from workspace file or derived from folder name) */
  name: string;
  /** Raw path as written in the .code-workspace file (may be relative) */
  rawPath: string;
  /** Fully resolved canonical absolute path */
  resolvedPath: string;
  /** Whether the resolved path exists on disk */
  exists: boolean;
}

/** Parsed .code-workspace file */
export interface WorkspaceDefinition {
  /** Absolute path to the .code-workspace file */
  filePath: string;
  /** Human-readable name (filename without extension, or "Untitled") */
  name: string;
  /** Resolved folder entries */
  folders: WorkspaceFolder[];
  /** Arbitrary settings blob from the workspace file */
  settings?: Record<string, unknown>;
  /** Extension recommendations */
  extensions?: { recommendations?: string[] };
}

/** A Git worktree associated with a repository */
export interface GitWorktree {
  /** Absolute path to the worktree */
  path: string;
  /** Current branch or null if detached */
  branch: string | null;
}

/**
 * A discovered Git repository.
 * `id` is derived from the canonical common directory + workspace identity
 * so that the same physical repo is not duplicated even if multiple
 * workspace folders point to it.
 */
export interface Repository {
  /** Stable identifier: hex digest of workspace-path + commonDir */
  id: string;
  /** Absolute path to the repository working tree root */
  rootPath: string;
  /** Canonical (realpath-resolved) git common directory — the dedup key */
  commonDir: string;
  /** Primary worktree metadata (this repo's own .git entry) */
  worktree: GitWorktree | null;
  /** Names of workspace folders that contain or equal this repo */
  folderMembership: string[];
}

/** Result of scanning a workspace for Git repositories */
export interface WorkspaceScanResult {
  workspace: WorkspaceDefinition;
  repositories: Repository[];
  errors: string[];
}

/** Options for repository discovery */
export interface DiscoveryOptions {
  /** Max directory depth to search for .git entries (default 4) */
  maxDepth?: number;
  /** Directory name patterns to skip during traversal */
  excludePatterns?: RegExp[];
  /** Additional absolute paths to skip */
  excludePaths?: string[];
}

/** Schema for the local workspace registry file */
export interface RegistryEntry {
  filePath: string;
  label: string;
  lastOpened: string;
  folderCount: number;
  repoCount: number;
}

export interface RegistryData {
  version: 1;
  entries: RegistryEntry[];
}

/** Default exclusions — common dependency/build/cache dirs to skip during traversal.
 *  `.git` is NOT included because it is explicitly detected as a repo marker. */
export const DEFAULT_EXCLUDE_PATTERNS: RegExp[] = [
  /^node_modules$/,
  /^\.gocache$/,
  /^vendor$/,
  /^\.next$/,
  /^out$/,
  /^build$/,
  /^dist$/,
  /^__pycache__$/,
  /^\.venv$/,
  /^venv$/,
  /^env$/,
  /^\.pytest_cache$/,
  /^target$/,
  /^\.bzr$/,
  /^\.hg$/,
  /^\.svn$/,
  /^_darcs$/,
  /^CVS$/,
];
