/**
 * Safe "Start clean workspace session" — plan, execute, and summary.
 *
 * ── BRANCH POLICY ─────────────────────────────────────────────
 * 1. Try "main"
 * 2. If no remote ref exists for main, try "develop"
 *
 * ── REMOTE POLICY ─────────────────────────────────────────────
 * 1. "origin"
 * 2. "upstream"
 * 3. First configured remote
 *
 * ── SAFETY ────────────────────────────────────────────────────
 * - Plan is read-only / no network (uses cached remote refs).
 * - Never switches/resets/stashes/discards/pulls/rewrites the primary checkout.
 * - Dirty primary checkouts do NOT block.
 * - Each repo gets a new session-specific branch in a confined worktree.
 * - Worktree HEAD is verified against the fetched remote SHA.
 * - Concurrent session execution is serialised; returns 409 when active.
 * - Per-repo failures do not abort the batch.
 *
 * ── BRANCH NAMING ─────────────────────────────────────────────
 *   dashboard/session-<safeSessionId>/<baseBranch>
 */

import { randomBytes } from "node:crypto";
import { getRepoStatus, readWorktrees } from "./status";
import { getAllRepos, getRepo } from "./registry";
import { fetchRepo, createWorktree } from "./operations";
import { defaultWorktreePath } from "./worktree-paths";
import { runGitSync } from "./runner";
import type { Repository } from "@/lib/workspace/types";
import type { RemoteInfo, RemoteRef } from "./types";

/* ================================================================== */
/*  Types                                                              */
/* ================================================================== */

/** Per-repo entry in a session plan (read-only, local cache only). */
export interface RepoSessionPlan {
  repoId: string;
  displayName: string;
  rootPath: string;
  selectedRemote: string;
  baseBranch: string;
  /** OID from local cached refs, or null */
  cachedRefOid: string | null;
  /** Whether the cached ref was found at all */
  cachedRefFound: boolean;
  /** True if a fetch is required first */
  needsFetch: boolean;
  /** Blockers preventing this repo from being session-ready */
  blockers: string[];
  status: "ready" | "needs_fetch" | "no_remote_ref" | "no_suitable_remote";
}

/** Plan for a full session execution (returned by GET). */
export interface SessionPlan {
  /** Null before execution starts; set on POST. */
  sessionId: string | null;
  repos: RepoSessionPlan[];
  summary: {
    total: number;
    ready: number;
    needsFetch: number;
    blocked: number;
  };
}

/** Outcome for one repo after execution. */
export interface RepoSessionResult {
  repoId: string;
  displayName: string;
  rootPath: string;
  selectedRemote: string;
  baseBranch: string;
  sessionBranch: string;
  worktreePath: string;
  fetch: {
    success: boolean;
    durationMs: number;
    error?: string;
  };
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

/** Full session execution state. */
export interface SessionExecution {
  sessionId: string;
  status: "running" | "completed" | "failed";
  results: RepoSessionResult[];
  startedAt: string;
  completedAt?: string;
  error?: string;
}

/* ================================================================== */
/*  Session serialisation (concurrent-execution guard)                 */
/* ================================================================== */

let activeSession: SessionExecution | null = null;

/** Check whether a session is currently running. */
export function hasActiveSession(): boolean {
  return activeSession !== null && activeSession.status === "running";
}

/** Get the current active session, if any. */
export function getActiveSession(): SessionExecution | null {
  return activeSession;
}

/** Clear active session (for tests / recovery). */
export function clearActiveSession(): void {
  activeSession = null;
}

function setActiveSession(session: SessionExecution): void {
  activeSession = session;
}

/* ================================================================== */
/*  Session ID generation                                              */
/* ================================================================== */

const SESSION_ID_BYTES = 6; // 12 hex chars

/** Generate a short, safe session identifier. */
export function generateSessionId(): string {
  return randomBytes(SESSION_ID_BYTES).toString("hex");
}

/* ================================================================== */
/*  Remote / branch policy helpers                                     */
/* ================================================================== */

/** Order configured remotes using the policy: origin → upstream → remaining. */
export function orderPreferredRemotes(remotes: Pick<RemoteInfo, "name">[]): string[] {
  const names = remotes.map((r) => r.name);
  return ["origin", "upstream", ...names].filter(
    (name, index, ordered) => names.includes(name) && ordered.indexOf(name) === index
  );
}

/** Select one remote using the policy: origin → upstream → first configured. */
export function selectPreferredRemote(remotes: Pick<RemoteInfo, "name">[]): string | null {
  return orderPreferredRemotes(remotes)[0] ?? null;
}

/** Ordered base-branch candidates (policy: main → develop). */
const BASE_BRANCH_CANDIDATES = ["main", "develop"];

/** Resolve main first, then develop, on the already-selected remote. */
export function selectPreferredBranch(
  remote: string,
  refs: Pick<RemoteRef, "ref" | "oid">[]
): { branch: string; oid: string } | null {
  for (const branch of BASE_BRANCH_CANDIDATES) {
    const match = refs.find((ref) => ref.ref === `refs/remotes/${remote}/${branch}`);
    if (match) return { branch, oid: match.oid };
  }
  return null;
}

/**
 * Resolve the best remote + base-branch pair from cached remote refs.
 * Returns the chosen remote, branch, and the cached OID (if found).
 */
function resolveRemoteBranch(
  remotes: RemoteInfo[],
  cachedRefs: Array<{ ref: string; oid: string }>
): {
  remote: string;
  branch: string;
  oid: string | null;
  found: boolean;
  error: string | null;
} {
  const remote = selectPreferredRemote(remotes);
  if (!remote) {
    return { remote: "", branch: "", oid: null, found: false, error: "No remotes configured" };
  }

  const resolved = selectPreferredBranch(remote, cachedRefs);
  if (resolved) {
    return { remote, branch: resolved.branch, oid: resolved.oid, found: true, error: null };
  }

  return {
    remote,
    branch: BASE_BRANCH_CANDIDATES[0]!,
    oid: null,
    found: false,
    error: `No cached remote ref found for ${BASE_BRANCH_CANDIDATES.join(" or ")} on any remote`,
  };
}

/* ================================================================== */
/*  Plan (read-only, no network)                                       */
/* ================================================================== */

/**
 * Build a session plan from registered repos (or a subset).
 * Uses only local cached refs — no network calls.
 */
export function planSession(request?: { repoIds?: string[] }): SessionPlan {
  const allRepos = request?.repoIds
    ? request.repoIds.map((id) => getRepo(id)).filter((r): r is Repository => r !== undefined)
    : getAllRepos();

  const repoPlans: RepoSessionPlan[] = allRepos.map((repo) => {
    const displayName = repo.rootPath.split("/").pop() ?? repo.id;
    try {
      const status = getRepoStatus(repo, { ttlMs: 5_000 });

      const remotes = status.remotes;
      const cachedRefs = status.remoteRefs;

      if (remotes.length === 0) {
        return {
          repoId: repo.id,
          displayName,
          rootPath: repo.rootPath,
          selectedRemote: "",
          baseBranch: "",
          cachedRefOid: null,
          cachedRefFound: false,
          needsFetch: false,
          blockers: ["No remotes configured"],
          status: "no_suitable_remote",
        };
      }

      const resolved = resolveRemoteBranch(remotes, cachedRefs);

      if (!resolved.found) {
        return {
          repoId: repo.id,
          displayName,
          rootPath: repo.rootPath,
          selectedRemote: resolved.remote,
          baseBranch: resolved.branch,
          cachedRefOid: null,
          cachedRefFound: false,
          needsFetch: true,
          blockers: [resolved.error ?? "Remote ref not cached; fetch required"],
          status: "needs_fetch",
        };
      }

      return {
        repoId: repo.id,
        displayName,
        rootPath: repo.rootPath,
        selectedRemote: resolved.remote,
        baseBranch: resolved.branch,
        cachedRefOid: resolved.oid,
        cachedRefFound: true,
        needsFetch: true,
        blockers: [],
        status: "ready",
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        repoId: repo.id,
        displayName,
        rootPath: repo.rootPath,
        selectedRemote: "",
        baseBranch: "",
        cachedRefOid: null,
        cachedRefFound: false,
        needsFetch: false,
        blockers: [message],
        status: "no_suitable_remote",
      };
    }
  });

  const total = repoPlans.length;
  const ready = repoPlans.filter((p) => p.status === "ready").length;
  const needsFetch = repoPlans.filter((p) => p.needsFetch).length;
  const blocked = repoPlans.filter(
    (p) => p.status === "no_remote_ref" || p.status === "no_suitable_remote"
  ).length;

  return {
    sessionId: null,
    repos: repoPlans,
    summary: { total, ready, needsFetch, blocked },
  };
}

/* ================================================================== */
/*  Execute                                                            */
/* ================================================================== */

/**
 * Execute a clean session start.
 *
 * 1. Validates no concurrent session is running.
 * 2. Fetches the selected remote for each repo (unless cached ref is enough).
 * 3. Re-resolves the remote branch ref after fetch.
 * 4. Creates a session-specific branch in a new worktree from that exact ref.
 * 5. Verifies worktree HEAD matches the fetched SHA.
 *
 * Never switches/resets/stashes/discards/pulls the primary checkout.
 * Dirty primary checkouts do NOT block.
 * Per-repo failures continue the batch.
 */
export async function executeSession(
  request?: { repoIds?: string[] }
): Promise<SessionExecution> {
  // Serialisation guard
  if (hasActiveSession()) {
    throw Object.assign(
      new Error("A workspace session is already active"),
      { statusCode: 409, code: "SESSION_ACTIVE" }
    );
  }

  const sessionId = generateSessionId();
  const startedAt = new Date().toISOString();

  const execution: SessionExecution = {
    sessionId,
    status: "running",
    results: [],
    startedAt,
  };
  setActiveSession(execution);

  try {
    // Get the plan first
    const plan = planSession(request);
    const results = execution.results;

    for (const repoPlan of plan.repos) {
      const repo = getRepo(repoPlan.repoId);
      if (!repo) {
        results.push({
          repoId: repoPlan.repoId,
          displayName: repoPlan.displayName,
          rootPath: repoPlan.rootPath,
          selectedRemote: repoPlan.selectedRemote,
          baseBranch: repoPlan.baseBranch,
          sessionBranch: "",
          worktreePath: "",
          fetch: { success: false, durationMs: 0, error: "Repository not in registry" },
          worktree: { success: false, path: "", headOid: "", headVerified: false, error: "Repository not in registry" },
          success: false,
          error: "Repository not in registry",
        });
        continue;
      }

      try {
        const result = await executeRepoSession(repo, repoPlan, sessionId);
        results.push(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          repoId: repo.id,
          displayName: repoPlan.displayName,
          rootPath: repo.rootPath,
          selectedRemote: repoPlan.selectedRemote,
          baseBranch: repoPlan.baseBranch,
          sessionBranch: "",
          worktreePath: "",
          fetch: { success: false, durationMs: 0, error: msg },
          worktree: { success: false, path: "", headOid: "", headVerified: false, error: msg },
          success: false,
          error: msg,
        });
      }
    }

    const allOk = results.length > 0 && results.every((r) => r.success);
    execution.status = allOk ? "completed" : "failed";
    execution.results = results;
    execution.completedAt = new Date().toISOString();
    return execution;
  } catch (err: unknown) {
    execution.status = "failed";
    execution.completedAt = new Date().toISOString();
    execution.error = err instanceof Error ? err.message : String(err);
    return execution;
  } finally {
    if (activeSession === execution) activeSession = null;
  }
}

/**
 * Execute session for a single repository.
 */
async function executeRepoSession(
  repo: Repository,
  repoPlan: RepoSessionPlan,
  sessionId: string
): Promise<RepoSessionResult> {
  const displayName = repoPlan.displayName;
  let remote = repoPlan.selectedRemote;
  let baseBranch = repoPlan.baseBranch;

  if (!remote) {
    const message = repoPlan.blockers[0] ?? "No suitable remote is configured";
    return {
      repoId: repo.id,
      displayName,
      rootPath: repo.rootPath,
      selectedRemote: "",
      baseBranch: "",
      sessionBranch: "",
      worktreePath: "",
      fetch: { success: false, durationMs: 0, error: message },
      worktree: { success: false, path: "", headOid: "", headVerified: false, error: message },
      success: false,
      error: message,
    };
  }

  // 1. Fetch remotes in policy order until main or develop resolves. This
  // handles fork setups where origin lacks a default branch but upstream has it.
  const initialStatus = getRepoStatus(repo, { ttlMs: 0 });
  const remoteCandidates = orderPreferredRemotes(initialStatus.remotes);
  let fetchDurationMs = 0;
  let resolvedOid: string | null = null;
  let anyFetchSucceeded = false;
  const fetchErrors: string[] = [];

  for (const candidate of remoteCandidates) {
    const fetchStart = Date.now();
    try {
      const fetchResult = await fetchRepo(repo, {
        repoId: repo.id,
        remote: candidate,
        prune: true,
      });
      fetchDurationMs += Date.now() - fetchStart;
      if (!fetchResult.success) {
        fetchErrors.push(`${candidate}: ${fetchResult.error ?? "fetch failed"}`);
        continue;
      }
      anyFetchSucceeded = true;
    } catch (err: unknown) {
      fetchDurationMs += Date.now() - fetchStart;
      fetchErrors.push(`${candidate}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const freshStatus = getRepoStatus(repo, { ttlMs: 0 });
    const freshBranch = selectPreferredBranch(candidate, freshStatus.remoteRefs);
    if (freshBranch) {
      remote = candidate;
      baseBranch = freshBranch.branch;
      resolvedOid = freshBranch.oid;
      break;
    }
    fetchErrors.push(`${candidate}: neither main nor develop exists after fetch`);
  }

  const targetRef = baseBranch
    ? `refs/remotes/${remote}/${baseBranch}`
    : "main or develop on a configured remote";

  if (!resolvedOid) {
    const message = fetchErrors.join("; ") || `Remote ref "${targetRef}" not found after fetch`;
    return {
      repoId: repo.id,
      displayName,
      rootPath: repo.rootPath,
      selectedRemote: remote,
      baseBranch,
      sessionBranch: "",
      worktreePath: "",
      fetch: { success: anyFetchSucceeded, durationMs: fetchDurationMs, error: message },
      worktree: { success: false, path: "", headOid: "", headVerified: false, error: message },
      success: false,
      error: message,
    };
  }

  // 3. Create session branch and worktree
  const sessionBranch = `dashboard/session-${sessionId}/${baseBranch}`;
  const wtPath = defaultWorktreePath(repo.id, sessionBranch);

  try {
    const wtResult = await createWorktree(repo, {
      repoId: repo.id,
      branch: sessionBranch,
      targetPath: wtPath,
      baseRef: resolvedOid,
    });

    if (!wtResult.success) {
      return {
        repoId: repo.id,
        displayName,
        rootPath: repo.rootPath,
        selectedRemote: remote,
        baseBranch,
        sessionBranch,
        worktreePath: wtPath,
        fetch: { success: true, durationMs: fetchDurationMs },
        worktree: {
          success: false,
          path: wtPath,
          headOid: "",
          headVerified: false,
          error: wtResult.error ?? "Worktree creation failed",
        },
        success: false,
        error: wtResult.error ?? "Worktree creation failed",
      };
    }

    // 4. Verify HEAD matches the fetched remote SHA
    const headCheck = runGitSync(
      ["rev-parse", "--verify", `refs/heads/${sessionBranch}^{commit}`],
      { repoPath: repo.rootPath, timeout: 10_000, maxOutputBytes: 1024 }
    );
    const actualHeadOid = headCheck.exitCode === 0 ? headCheck.stdout.trim() : "";
    const worktree = readWorktrees(repo.rootPath).find(
      (entry) => entry.branch === sessionBranch
    );
    const headVerified =
      actualHeadOid === resolvedOid && worktree?.headOid === resolvedOid;

    return {
      repoId: repo.id,
      displayName,
      rootPath: repo.rootPath,
      selectedRemote: remote,
      baseBranch,
      sessionBranch,
      worktreePath: wtPath,
      fetch: { success: true, durationMs: fetchDurationMs },
      worktree: {
        success: true,
        path: wtPath,
        headOid: actualHeadOid,
        headVerified,
        error: headVerified ? undefined : `HEAD mismatch: expected ${resolvedOid}, got ${actualHeadOid}`,
      },
      success: headVerified,
      error: headVerified ? undefined : `HEAD mismatch: expected ${resolvedOid}, got ${actualHeadOid}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      repoId: repo.id,
      displayName,
      rootPath: repo.rootPath,
      selectedRemote: remote,
      baseBranch,
      sessionBranch,
      worktreePath: wtPath,
      fetch: { success: true, durationMs: fetchDurationMs },
      worktree: { success: false, path: wtPath, headOid: "", headVerified: false, error: msg },
      success: false,
      error: msg,
    };
  }
}
