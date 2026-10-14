/**
 * Phase 2 — Git backend domain types.
 *
 * Read models for live Git repository state and safe mutation contracts.
 * Shell-free, bounded, canonical-path-only.
 */

import type { Repository } from "@/lib/workspace/types";

/* ------------------------------------------------------------------ */
/*  Git runner configuration                                           */
/* ------------------------------------------------------------------ */

export interface GitRunnerOptions {
  /** Absolute path to the repository working tree */
  repoPath: string;
  /** Timeout in milliseconds for each git invocation (default 15_000) */
  timeout?: number;
  /** Max stdout bytes to capture (default 1 MB) */
  maxOutputBytes?: number;
  /** Extra environment variables (sanitized — TERMINAL_PROMPT etc. forced) */
  env?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  Git execution result                                               */
/* ------------------------------------------------------------------ */

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string; // redacted — no credentials or paths
  durationMs: number;
}

export interface GitError {
  code: "GIT_NOT_FOUND" | "GIT_TIMEOUT" | "GIT_ERROR" | "REPO_NOT_FOUND" | "INVALID_REF" | "LOCKED" | "DIRTY_TREE" | "BRANCH_OCCUPIED" | "WORKTREE_EXISTS" | "NOT_A_WORKTREE" | "CANONICAL_PATH_MISMATCH" | "UNSUPPORTED_OPERATION";
  message: string;
  detail?: string;
}

/* ------------------------------------------------------------------ */
/*  Porcelain-v2 status model                                          */
/* ------------------------------------------------------------------ */

export interface V2BranchEntry {
  /** oid of the HEAD commit */
  headOid: string;
  /** HEAD branch ref (e.g. "refs/heads/main") or "(detached)" */
  ref: string;
  /** Upstream branch (e.g. "refs/remotes/origin/main") or "" */
  upstream: string;
  /** Ahead count relative to upstream */
  ahead: number;
  /** Behind count relative to upstream */
  behind: number;
}

export interface V2ChangedFile {
  /** XY status code (e.g. " M", "M ", "MM", "??") */
  xy: string;
  /** Submodule status (space, "S", etc.) */
  submodule: string;
  /** Working-tree/Index change type */
  stage: "index" | "worktree" | "untracked";
  /** File path relative to repo root */
  path: string;
  /** Original path for renames */
  origPath?: string;
  /** Whether the index contains a change for this path */
  staged: boolean;
  /** Whether the working tree contains a change for this path */
  unstaged: boolean;
  /** Whether this is an unmerged/conflicted path */
  conflicted: boolean;
}

export interface V2Status {
  branch: V2BranchEntry;
  /** Number of staged changes */
  staged: number;
  /** Number of unstaged changes */
  unstaged: number;
  /** Number of untracked files */
  untracked: number;
  /** Number of conflicted files */
  conflicted: number;
  /** Changed files (truncated at limit) */
  files: V2ChangedFile[];
  /** True if files list was truncated */
  truncated: boolean;
}

/* ------------------------------------------------------------------ */
/*  Branch / ref information                                           */
/* ------------------------------------------------------------------ */

export interface LocalBranch {
  name: string; // short name, e.g. "main"
  ref: string; // full ref, e.g. "refs/heads/main"
  headOid: string;
  upstream: string; // full upstream ref or ""
  ahead: number;
  behind: number;
  /** True if HEAD points to this branch */
  isCurrent: boolean;
}

export interface RemoteInfo {
  name: string;
  pushUrl: string;
  fetchUrl: string;
}

export interface RemoteRef {
  ref: string; // e.g. "refs/remotes/origin/main"
  oid: string;
}

/* ------------------------------------------------------------------ */
/*  Full repository status (read model)                                */
/* ------------------------------------------------------------------ */

export interface RepoStatus {
  repoId: string;
  rootPath: string;
  /** Current branch name or "(detached)" */
  currentBranch: string;
  /** Full HEAD ref */
  headRef: string;
  /** HEAD commit OID */
  headOid: string;
  /** Upstream tracking ref, or null */
  upstream: string | null;
  /** Ahead count (or 0 if no upstream) */
  ahead: number;
  /** Behind count (or 0 if no upstream) */
  behind: number;
  /** Parsed v2 status summary */
  v2Status: V2Status | null;
  /** All local branches */
  localBranches: LocalBranch[];
  /** Configured remotes */
  remotes: RemoteInfo[];
  /** Remote refs (heads only, truncated) */
  remoteRefs: RemoteRef[];
  /** Worktree list */
  worktrees: WorktreeEntry[];
  /** Errors encountered during gathering */
  errors: string[];
  /** Cache timestamp */
  cachedAt: number;
}

/* ------------------------------------------------------------------ */
/*  Worktree model                                                     */
/* ------------------------------------------------------------------ */

export interface WorktreeEntry {
  path: string;
  branch: string | null; // null if detached
  headOid: string;
  /** Whether this is the primary (main) worktree */
  isPrimary: boolean;
  /** Whether the worktree is locked */
  locked: boolean;
  /** Whether the worktree is prunable */
  prunable: boolean;
}

/* ------------------------------------------------------------------ */
/*  Mutation preflight                                                 */
/* ------------------------------------------------------------------ */

export type PreflightAction =
  | "fetch"
  | "switch"
  | "worktree-create"
  | "worktree-remove";

export interface PreflightCheck {
  /** The action being preflighted */
  action: PreflightAction;
  /** Repository ID */
  repoId: string;
  /** Target ref or name for the action */
  target: string;
  /** Whether the action can proceed */
  allowed: boolean;
  /** Reasons the action is blocked */
  blockers: string[];
  /** Warnings that don't block but should be acknowledged */
  warnings: string[];
  /** Current vs desired state description */
  currentState: string;
  /** Desired state description */
  desiredState: string;
  /** True if remote refs need fetching first */
  requiresFetch: boolean;
  /** True if confirmation is required before proceeding */
  requiresConfirmation: boolean;
}

/* ------------------------------------------------------------------ */
/*  Mutation request / result                                          */
/* ------------------------------------------------------------------ */

export interface FetchRequest {
  repoId: string;
  remote?: string; // defaults to "origin"
  prune?: boolean;
}

export interface FetchResult {
  repoId: string;
  remote: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export interface SwitchRequest {
  repoId: string;
  target: string; // branch name or ref
  createTracking?: boolean; // create local tracking branch from remote ref
}

export interface SwitchResult {
  repoId: string;
  target: string;
  success: boolean;
  previousBranch: string;
  newBranch: string;
  output: string;
  error?: string;
  durationMs: number;
}

export interface WorktreeCreateRequest {
  repoId: string;
  branch: string; // local branch to check out in the worktree
  targetPath?: string; // optional explicit path
  baseRef?: string; // optional base ref (defaults to branch if remote tracking)
}

export interface WorktreeCreateResult {
  repoId: string;
  branch: string;
  path: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export interface WorktreeRemoveRequest {
  repoId: string;
  path: string; // worktree path to remove
}

export interface WorktreeRemoveResult {
  repoId: string;
  path: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

/* ------------------------------------------------------------------ */
/*  Journal entry                                                      */
/* ------------------------------------------------------------------ */

export interface JournalEntry {
  id: string;
  timestamp: string;
  workspaceFilePath: string;
  repoId: string;
  action: string;
  params: Record<string, unknown>;
  result: "success" | "failure";
  error?: string;
  durationMs: number;
}

export interface JournalData {
  version: 1;
  entries: JournalEntry[];
}

/* ------------------------------------------------------------------ */
/*  Cache entry                                                        */
/* ------------------------------------------------------------------ */

export interface CacheEntry<T> {
  data: T;
  cachedAt: number;
  ttlMs: number;
}
