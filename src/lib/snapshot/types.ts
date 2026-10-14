/**
 * Snapshot foundation — schema and domain types for named workspace snapshots.
 *
 * Snapshots capture selected/all registered repos with versioned local-only
 * schema stored atomically outside any managed repository.
 *
 * NO secrets, NO remote URLs as stored content, NO file diffs, NO content.
 * Path/repo authorization through opened workspace only.
 */

/* ------------------------------------------------------------------ */
/*  Identity hints (no secrets, no URLs)                              */
/* ------------------------------------------------------------------ */

/**
 * Repository identity hints — derived from the repo itself.
 * No secrets, no full remote URLs, no credentials.
 */
export interface RepoIdentity {
  /** Canonical git common directory (dedup key) */
  commonDir: string;
  /** Remote names (e.g. ["origin", "upstream"]) — no URLs */
  remoteNames: string[];
  /**
   * Path component of the first remote fetch URL (for identification only).
   * e.g. "org/repo" from "https://github.com/org/repo.git"
   * Null if no remotes or URL cannot be parsed.
   */
  remotePathHint: string | null;
}

/* ------------------------------------------------------------------ */
/*  HEAD state                                                        */
/* ------------------------------------------------------------------ */

export interface RepoHead {
  /** Symbolic ref (e.g. "refs/heads/main") or null if detached */
  symbolicRef: string | null;
  /** Whether HEAD is detached */
  detached: boolean;
  /** Exact HEAD SHA */
  sha: string;
  /** Upstream ref (e.g. "refs/remotes/origin/main") or null */
  upstream: string | null;
}

/* ------------------------------------------------------------------ */
/*  Worktree                                                          */
/* ------------------------------------------------------------------ */

export interface RepoWorktree {
  /** Absolute path to the worktree */
  path: string;
  /**
   * Logical slot identifier.
   * "primary" for the main worktree, otherwise the absolute path.
   */
  logicalSlot: string;
}

/* ------------------------------------------------------------------ */
/*  Dirty summary (no content, no file names)                         */
/* ------------------------------------------------------------------ */

export interface DirtySummary {
  /** Whether the working tree has any changes */
  hasChanges: boolean;
  /** Number of staged changes */
  staged: number;
  /** Number of unstaged changes */
  unstaged: number;
  /** Number of untracked files */
  untracked: number;
  /** Number of conflicted files */
  conflicted: number;
}

/* ------------------------------------------------------------------ */
/*  Per-repo snapshot entry                                           */
/* ------------------------------------------------------------------ */

export interface RepoSnapshot {
  /** Stable repo ID (matches workspace.repository.id) */
  repoId: string;
  /** Absolute path to repo root */
  rootPath: string;
  /** Identity hints (no secrets) */
  identity: RepoIdentity;
  /** HEAD state */
  head: RepoHead;
  /** Worktree info */
  worktree: RepoWorktree;
  /** Dirty summary only (no content) */
  dirty: DirtySummary;
}

/* ------------------------------------------------------------------ */
/*  Snapshot metadata                                                  */
/* ------------------------------------------------------------------ */

export interface SnapshotMeta {
  /** ISO-8601 timestamp when created */
  createdAt: string;
  /** Human-readable label */
  label: string;
  /** Optional description */
  description?: string;
  /** Absolute path to the workspace file at capture time */
  workspaceFilePath: string;
  /** How this snapshot was created */
  source: "manual" | "auto" | "restore-point";
}

/* ------------------------------------------------------------------ */
/*  Snapshot (v1 schema)                                              */
/* ------------------------------------------------------------------ */

export interface SnapshotSchema {
  /** Schema version — for future migration */
  version: 1;
  /** Snapshot metadata */
  meta: SnapshotMeta;
  /** Repo snapshots */
  repos: RepoSnapshot[];
  /** Total repo count captured */
  repoCount: number;
}

/* ------------------------------------------------------------------ */
/*  Store entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * A snapshot entry in the local store.
 * The schema is stored as a JSON file on disk.
 */
export interface SnapshotEntry {
  /** Unique snapshot ID (derived from timestamp + label hash) */
  id: string;
  /** Schema version */
  version: 1;
  /** Metadata only (no repo data in list view) */
  meta: SnapshotMeta;
  /** Count of repos captured */
  repoCount: number;
  /** ISO-8601 last updated */
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/*  Snapshot store index                                              */
/* ------------------------------------------------------------------ */

export interface SnapshotIndex {
  version: 1;
  entries: SnapshotEntry[];
}

/* ------------------------------------------------------------------ */
/*  Drift / restore types                                             */
/* ------------------------------------------------------------------ */

/**
 * Drift classification for a single repo within a snapshot.
 *
 * satisfied       — repo at same HEAD on same branch, clean tree
 * safe-switch     — same HEAD but different branch, clean tree
 * create-worktree — branch not occupied, needs creation or different slot
 * preferred       — has alternatives, current is acceptable
 * dirty-blocked   — working tree has changes preventing switch
 * occupied        — desired branch checked out in a different worktree
 * fetch-needed    — snapshot ref not found locally, needs fetch
 * missing-ref     — snapshot ref doesn't exist at all
 * missing-repo    — repository not found on disk
 * ambiguous       — multiple possible matches / unclear
 */
export type DriftClass =
  | "satisfied"
  | "safe-switch"
  | "create-worktree"
  | "preferred"
  | "dirty-blocked"
  | "occupied"
  | "fetch-needed"
  | "missing-ref"
  | "missing-repo"
  | "ambiguous";

export interface DriftResult {
  /** Snapshot ID this drift is computed against */
  snapshotId: string;
  /** Repo-specific drift results */
  repos: RepoDriftResult[];
  /** Summary counts */
  summary: DriftSummary;
}

export interface RepoDriftResult {
  /** Repo ID from the snapshot */
  repoId: string;
  /** Repo path from the snapshot */
  rootPath: string;
  /** Drift classification */
  classification: DriftClass;
  /** Human-readable explanation */
  explanation: string;
  /** Whether the repo exists on disk */
  repoExists: boolean;
  /** Whether the working tree is clean */
  isClean: boolean;
  /** Current HEAD SHA (null if repo missing) */
  currentSha: string | null;
  /** Snapshot HEAD SHA */
  snapshotSha: string;
  /** Current branch (null if repo missing or detached) */
  currentBranch: string | null;
  /** Snapshot branch */
  snapshotBranch: string | null;
  /** Whether local branch matches snapshot */
  branchMatch: boolean;
  /** Whether SHA matches snapshot */
  shaMatch: boolean;
  /** Worktree occupancy info */
  occupiedBy: string | null;
}

export interface DriftSummary {
  satisfied: number;
  safeSwitch: number;
  createWorktree: number;
  preferred: number;
  dirtyBlocked: number;
  occupied: number;
  fetchNeeded: number;
  missingRef: number;
  missingRepo: number;
  ambiguous: number;
}

/**
 * Restore plan — what to do for each repo to reach the snapshot state.
 * NOT executed in this milestone; a PLAN only.
 */
export interface RestorePlan {
  /** Snapshot ID */
  snapshotId: string;
  /** Per-repo restore actions */
  repos: RepoRestoreAction[];
  /** Summary */
  summary: RestoreSummary;
  /** Whether all repos can be restored without manual intervention */
  canRestoreAll: boolean;
}

export interface RepoRestoreAction {
  /** Repo ID */
  repoId: string;
  /** Drift classification (determines action type) */
  classification: DriftClass;
  /** Human-readable steps */
  steps: string[];
  /** Whether this action can be auto-executed */
  canAutoExecute: boolean;
  /** Prerequisite action needed before this one */
  prerequisites: string[];
}

export interface RestoreSummary {
  total: number;
  autoExecutable: number;
  requiresManual: number;
}

/* ------------------------------------------------------------------ */
/*  Combination activation                                            */
/* ------------------------------------------------------------------ */

export type ActivationAction = "none" | "switch" | "create-worktree";

export type ActivationRepoStatus =
  | "already-satisfied"
  | "success"
  | "blocked"
  | "failed";

export interface RepoActivationPlan {
  repoId: string;
  classification: DriftClass;
  action: ActivationAction;
  branch: string | null;
  snapshotSha: string;
  executable: boolean;
  explanation: string;
}

export interface RepoActivationResult extends RepoActivationPlan {
  status: ActivationRepoStatus;
  message: string;
  durationMs: number;
  worktreePath?: string;
}

export interface ActivationSummary {
  total: number;
  succeeded: number;
  alreadySatisfied: number;
  blocked: number;
  failed: number;
}

export interface ActivationResult {
  snapshotId: string;
  startedAt: string;
  finishedAt: string;
  repos: RepoActivationResult[];
  summary: ActivationSummary;
}
