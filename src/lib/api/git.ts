/**
 * Client-side API layer for live Git repository status and actions.
 *
 * All mutation routes require:
 * 1. Same-origin browser fetch headers (Origin, Referer — sent naturally)
 * 2. X-Action-Token header obtained from GET /api/git/token
 *
 * Action pattern: GET preflight → user confirmation → POST mutation
 */

/* ------------------------------------------------------------------ */
/*  Client-side types (UI envelope over server response types)         */
/* ------------------------------------------------------------------ */

export interface GitStatusView {
  repoId: string;
  rootPath: string;
  currentBranch: string;
  /** "(detached)" when in detached HEAD state */
  headRef: string;
  headOid: string;
  /** Upstream tracking ref (e.g. "origin/main") or null */
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Status counts */
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  changedFiles: GitChangedFileView[];
  changesTruncated: boolean;
  /** Number of worktrees (including primary) */
  worktreeCount: number;
  /** Names of non-primary worktree branches */
  secondaryWorktreeBranches: string[];
  localBranches: string[];
  remotes: string[];
  /** Remote refs from local git cache (e.g. "refs/remotes/origin/main") */
  remoteRefs: string[];
  secondaryWorktrees: Array<{ path: string; branch: string | null }>;
  /** Timestamp of when status was gathered */
  cachedAt: number;
  /** Any errors from gathering status */
  errors: string[];
}

export interface GitChangedFileView {
  path: string;
  originalPath?: string;
  xy: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface PreflightResult {
  action: "fetch" | "switch" | "worktree-create" | "worktree-remove";
  repoId: string;
  target: string;
  allowed: boolean;
  blockers: string[];
  warnings: string[];
  currentState: string;
  desiredState: string;
  requiresFetch: boolean;
  requiresConfirmation: boolean;
}

export interface FetchResult {
  repoId: string;
  remote: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
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

export interface WorktreeCreateResult {
  repoId: string;
  branch: string;
  path: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export interface WorktreeRemoveResult {
  repoId: string;
  path: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export interface ActionTokenResponse {
  token: string;
}

/** Represents the progress state of an action */
export type ActionProgress =
  | { status: "idle" }
  | { status: "preflighting" }
  | { status: "confirming"; preflight: PreflightResult }
  | { status: "executing" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

/* ------------------------------------------------------------------ */
/*  API helpers                                                        */
/* ------------------------------------------------------------------ */

/** In-memory cached action token (obtained once per session) */
let _cachedToken: string | null = null;

function apiBase(): string {
  if (typeof window === "undefined") return "http://localhost:3000";
  return "";
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function apiFetchWithToken<T>(
  path: string,
  init?: RequestInit,
  retryToken = true
): Promise<T> {
  const token = await ensureActionToken();
  const res = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...init?.headers,
      "x-action-token": token,
    },
  });
  if (res.status === 403 && retryToken) {
    resetCachedToken();
    return apiFetchWithToken<T>(path, init, false);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function ensureActionToken(): Promise<string> {
  if (_cachedToken) return _cachedToken;
  const res = await apiFetch<ActionTokenResponse>("/api/git/token");
  _cachedToken = res.token;
  return res.token;
}

/** Reset the cached token (e.g. after a 403) */
export function resetCachedToken(): void {
  _cachedToken = null;
}

/* ------------------------------------------------------------------ */
/*  Adapter: server RepoStatus → client GitStatusView                  */
/* ------------------------------------------------------------------ */

export function toGitStatusView(serverStatus: {
  repoId: string;
  rootPath: string;
  currentBranch: string;
  headRef: string;
  headOid: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  v2Status: {
    staged: number;
    unstaged: number;
    untracked: number;
    conflicted: number;
    files?: Array<{
      path: string;
      origPath?: string;
      xy: string;
      stage: "index" | "worktree" | "untracked";
      staged?: boolean;
      unstaged?: boolean;
      conflicted?: boolean;
    }>;
    truncated?: boolean;
  } | null;
  worktrees: Array<{
    isPrimary: boolean;
    branch: string | null;
    path?: string;
  }>;
  localBranches?: Array<{ name: string }>;
  remotes?: Array<{ name: string }>;
  remoteRefs?: Array<{ ref: string }>;
  errors: string[];
  cachedAt: number;
}): GitStatusView {
  return {
    repoId: serverStatus.repoId,
    rootPath: serverStatus.rootPath,
    currentBranch: serverStatus.currentBranch,
    headRef: serverStatus.headRef,
    headOid: serverStatus.headOid,
    upstream: serverStatus.upstream,
    ahead: serverStatus.ahead,
    behind: serverStatus.behind,
    staged: serverStatus.v2Status?.staged ?? 0,
    unstaged: serverStatus.v2Status?.unstaged ?? 0,
    untracked: serverStatus.v2Status?.untracked ?? 0,
    conflicted: serverStatus.v2Status?.conflicted ?? 0,
    changedFiles:
      serverStatus.v2Status?.files?.map((file) => ({
        path: file.path,
        ...(file.origPath ? { originalPath: file.origPath } : {}),
        xy: file.xy,
        staged: file.staged ?? file.stage === "index",
        unstaged: file.unstaged ?? file.stage === "worktree",
        untracked: file.stage === "untracked",
        conflicted: file.conflicted ?? file.xy.includes("U"),
      })) ?? [],
    changesTruncated: serverStatus.v2Status?.truncated ?? false,
    worktreeCount: serverStatus.worktrees?.length ?? 0,
    secondaryWorktreeBranches:
      serverStatus.worktrees
        ?.filter((w) => !w.isPrimary)
        .map((w) => w.branch ?? "(detached)")
        .filter(Boolean) ?? [],
    localBranches: serverStatus.localBranches?.map((branch) => branch.name) ?? [],
    remotes: serverStatus.remotes?.map((remote) => remote.name) ?? [],
    remoteRefs: serverStatus.remoteRefs?.map((ref) => ref.ref) ?? [],
    secondaryWorktrees:
      serverStatus.worktrees
        ?.filter((worktree) => !worktree.isPrimary && !!worktree.path)
        .map((worktree) => ({ path: worktree.path!, branch: worktree.branch })) ?? [],
    cachedAt: serverStatus.cachedAt,
    errors: serverStatus.errors ?? [],
  };
}

/* ------------------------------------------------------------------ */
/*  Status fetch                                                       */
/* ------------------------------------------------------------------ */

export type StatusLoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; data: Map<string, GitStatusView> }
  | { status: "error"; message: string; partial: Map<string, GitStatusView> };

/**
 * GET /api/git/status?repoIds=id1,id2,...
 *
 * Fetches live Git status for a batch of repository IDs.
 * Returns a map of repoId → GitStatusView.
 */
export async function fetchRepoStatuses(
  repoIds: string[],
  signal?: AbortSignal
): Promise<Map<string, GitStatusView>> {
  if (repoIds.length === 0) return new Map();

  const data = await apiFetch<{
    repos: Array<{
      repoId: string;
      rootPath: string;
      currentBranch: string;
      headRef: string;
      headOid: string;
      upstream: string | null;
      ahead: number;
      behind: number;
      v2Status: {
        staged: number;
        unstaged: number;
        untracked: number;
        conflicted: number;
        files?: Array<{
          path: string;
          origPath?: string;
          xy: string;
          stage: "index" | "worktree" | "untracked";
          staged?: boolean;
          unstaged?: boolean;
          conflicted?: boolean;
        }>;
        truncated?: boolean;
      } | null;
      worktrees: Array<{
        isPrimary: boolean;
        branch: string | null;
        path: string;
      }>;
      localBranches: Array<{ name: string }>;
      remotes: Array<{ name: string }>;
      remoteRefs: Array<{ ref: string }>;
      errors: string[];
      cachedAt: number;
    }>;
  }>(`/api/git/status?repoIds=${encodeURIComponent(repoIds.join(","))}`, {
    signal,
  });

  const map = new Map<string, GitStatusView>();
  for (const repo of data.repos ?? []) {
    map.set(repo.repoId, toGitStatusView(repo));
  }
  return map;
}

/* ------------------------------------------------------------------ */
/*  Preflight                                                          */
/* ------------------------------------------------------------------ */

/**
 * GET /api/git/preflight?action=...&repoId=...&target=...
 */
export async function preflightAction(
  action: PreflightResult["action"],
  repoId: string,
  target: string,
  signal?: AbortSignal,
  createTracking = false
): Promise<PreflightResult> {
  const params = new URLSearchParams({
    action,
    repoId,
    target,
    ...(createTracking ? { createTracking: "true" } : {}),
  });
  const data = await apiFetch<{ preflight: PreflightResult }>(
    `/api/git/preflight?${params.toString()}`,
    { signal }
  );
  return data.preflight;
}

/* ------------------------------------------------------------------ */
/*  Fetch action                                                       */
/* ------------------------------------------------------------------ */

/**
 * POST /api/git/fetch
 */
export async function executeFetch(
  repoId: string,
  remote = "origin",
  prune = false
): Promise<FetchResult> {
  const data = await apiFetchWithToken<{ result: FetchResult }>(
    "/api/git/fetch",
    {
      method: "POST",
      body: JSON.stringify({ repoId, remote, prune }),
      headers: { "Content-Type": "application/json" },
    }
  );
  return data.result;
}

/* ------------------------------------------------------------------ */
/*  Switch action                                                      */
/* ------------------------------------------------------------------ */

/**
 * POST /api/git/switch
 */
export async function executeSwitch(
  repoId: string,
  target: string,
  createTracking = false
): Promise<SwitchResult> {
  const data = await apiFetchWithToken<{ result: SwitchResult }>(
    "/api/git/switch",
    {
      method: "POST",
      body: JSON.stringify({ repoId, target, createTracking }),
      headers: { "Content-Type": "application/json" },
    }
  );
  return data.result;
}

/* ------------------------------------------------------------------ */
/*  Worktree actions                                                   */
/* ------------------------------------------------------------------ */

/**
 * POST /api/git/worktree (action=create)
 */
export async function executeWorktreeCreate(
  repoId: string,
  branch: string,
  targetPath?: string,
  baseRef?: string
): Promise<WorktreeCreateResult> {
  const data = await apiFetchWithToken<{ result: WorktreeCreateResult }>(
    "/api/git/worktree",
    {
      method: "POST",
      body: JSON.stringify({
        action: "create",
        repoId,
        branch,
        ...(targetPath ? { targetPath } : {}),
        ...(baseRef ? { baseRef } : {}),
      }),
      headers: { "Content-Type": "application/json" },
    }
  );
  return data.result;
}

/**
 * POST /api/git/worktree (action=remove)
 */
export async function executeWorktreeRemove(
  repoId: string,
  path: string
): Promise<WorktreeRemoveResult> {
  const data = await apiFetchWithToken<{ result: WorktreeRemoveResult }>(
    "/api/git/worktree",
    {
      method: "POST",
      body: JSON.stringify({ action: "remove", repoId, path }),
      headers: { "Content-Type": "application/json" },
    }
  );
  return data.result;
}

/* ------------------------------------------------------------------ */
/*  Action progress helpers                                            */
/* ------------------------------------------------------------------ */

/** Determine whether direct switch is unsafe/disabled */
export function getSwitchDisabledReason(
  status: GitStatusView | undefined
): string | null {
  if (!status) return "Status not loaded";
  if (status.conflicted > 0) return "Conflicts must be resolved first";
  if (status.staged > 0 || status.unstaged > 0 || status.untracked > 0)
    return "Working tree has uncommitted changes";
  return null;
}

/** Determine whether create-worktree is the recommended action */
export function isWorktreeRecommended(status: GitStatusView | undefined): boolean {
  if (!status) return false;
  // Worktree is always recommended when the repo already has secondary worktrees
  // or when the user is likely to want concurrent contexts
  return status.worktreeCount > 1;
}

/* ================================================================== */
/*  Workspace session (clean session) types                             */
/* ================================================================== */

export interface RepoSessionPlan {
  repoId: string;
  displayName: string;
  rootPath: string;
  selectedRemote: string;
  baseBranch: string;
  cachedRefOid: string | null;
  cachedRefFound: boolean;
  needsFetch: boolean;
  blockers: string[];
  status: "ready" | "needs_fetch" | "no_remote_ref" | "no_suitable_remote";
}

export interface SessionPlan {
  sessionId: string | null;
  repos: RepoSessionPlan[];
  summary: {
    total: number;
    ready: number;
    needsFetch: number;
    blocked: number;
  };
}

export interface RepoSessionResult {
  repoId: string;
  displayName: string;
  rootPath: string;
  selectedRemote: string;
  baseBranch: string;
  sessionBranch: string;
  worktreePath: string;
  fetch: { success: boolean; durationMs: number; error?: string };
  worktree: {
    success: boolean;
    path: string;
    headOid: string;
    headVerified: boolean;
    error?: string;
  };
  success: boolean;
  error?: string;
}

export interface SessionExecution {
  sessionId: string;
  status: "running" | "completed" | "failed";
  results: RepoSessionResult[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface SessionPlanResponse {
  plan: SessionPlan;
  active: SessionExecution | null;
}

export interface SessionExecuteResponse {
  execution: SessionExecution;
}

/* ------------------------------------------------------------------ */
/*  Session API: GET plan                                               */
/* ------------------------------------------------------------------ */

/**
 * GET /api/git/session?repoIds=...
 *
 * Read-only plan using cached remote refs. No network.
 */
export async function fetchSessionPlan(
  repoIds?: string[],
  signal?: AbortSignal
): Promise<SessionPlanResponse> {
  const params = new URLSearchParams();
  if (repoIds && repoIds.length > 0) {
    params.set("repoIds", repoIds.join(","));
  }
  const qs = params.toString();
  return apiFetch<SessionPlanResponse>(
    `/api/git/session${qs ? `?${qs}` : ""}`,
    { signal }
  );
}

/* ------------------------------------------------------------------ */
/*  Session API: POST execute                                           */
/* ------------------------------------------------------------------ */

/**
 * POST /api/git/session
 *
 * Execute a clean session start. Requires token retry via existing helper.
 */
export async function executeSessionStart(
  repoIds?: string[]
): Promise<SessionExecuteResponse> {
  return apiFetchWithToken<SessionExecuteResponse>("/api/git/session", {
    method: "POST",
    body: JSON.stringify({ confirm: "start", ...(repoIds ? { repoIds } : {}) }),
    headers: { "Content-Type": "application/json" },
  });
}
