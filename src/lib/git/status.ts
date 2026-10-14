/**
 * Live Git repository status reader.
 *
 * Reads porcelain-v2 status, branch list (with ahead/behind), remotes,
 * remote refs, and worktree occupancy.  Bounded, shell-free, cached.
 */

import { realpathSync, existsSync } from "node:fs";
import { runGitSync } from "./runner";
import { _registerRepoPath } from "./runner";
import type {
  RepoStatus,
  V2Status,
  V2BranchEntry,
  V2ChangedFile,
  LocalBranch,
  RemoteInfo,
  RemoteRef,
  WorktreeEntry,
  CacheEntry,
} from "./types";
import type { Repository } from "@/lib/workspace/types";

/* ------------------------------------------------------------------ */
/*  Cache                                                              */
/* ------------------------------------------------------------------ */

const cache = new Map<string, CacheEntry<RepoStatus>>();
const DEFAULT_TTL_MS = 5_000; // 5 seconds
const MAX_CACHE_ENTRIES = 200;

function cacheKey(repoId: string): string {
  return `status:${repoId}`;
}

function getCached(repoId: string, ttlMs?: number): RepoStatus | null {
  const key = cacheKey(repoId);
  const entry = cache.get(key);
  if (!entry) return null;
  const effectiveTtl = ttlMs ?? entry.ttlMs;
  if (Date.now() - entry.cachedAt > effectiveTtl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(repoId: string, data: RepoStatus, ttlMs = DEFAULT_TTL_MS): void {
  const key = cacheKey(repoId);
  cache.delete(key);
  cache.set(key, { data, cachedAt: Date.now(), ttlMs });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/** Clear entire status cache */
export function clearStatusCache(): void {
  cache.clear();
}

/** Clear status cache for a specific repo */
export function clearRepoStatusCache(repoId: string): void {
  cache.delete(cacheKey(repoId));
}

/* ------------------------------------------------------------------ */
/*  Parsers                                                            */
/* ------------------------------------------------------------------ */

function parseV2BranchLine(line: string): V2BranchEntry {
  // # branch.oid <oid>
  // # branch.head <ref>
  // # branch.upstream <ref>
  // # branch.ab +<ahead> -<behind>
  const entry: V2BranchEntry = {
    headOid: "",
    ref: "(detached)",
    upstream: "",
    ahead: 0,
    behind: 0,
  };

  for (const part of line.split("\n")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("# branch.oid ")) {
      entry.headOid = trimmed.slice("# branch.oid ".length).trim();
    } else if (trimmed.startsWith("# branch.head ")) {
      const val = trimmed.slice("# branch.head ".length).trim();
      entry.ref = val === "(detached)" ? "(detached)" : `refs/heads/${val}`;
    } else if (trimmed.startsWith("# branch.upstream ")) {
      entry.upstream = trimmed.slice("# branch.upstream ".length).trim();
    } else if (trimmed.startsWith("# branch.ab ")) {
      const parts = trimmed.slice("# branch.ab ".length).trim().split(" ");
      entry.ahead = parseInt(parts[0]?.slice(1) ?? "0", 10) || 0;
      entry.behind = parseInt(parts[1]?.slice(1) ?? "0", 10) || 0;
    }
  }

  return entry;
}

/** Exported for testing — simulates a v2 changed-file record. */
export function changedFile(
  xy: string,
  submodule: string,
  path: string,
  origPath?: string,
  conflicted = false
): V2ChangedFile {
  const untracked = xy === "??";
  const staged = !untracked && !conflicted && xy[0] !== "." && xy[0] !== " ";
  const unstaged = !untracked && !conflicted && xy[1] !== "." && xy[1] !== " ";
  return {
    xy,
    submodule,
    stage: untracked ? "untracked" : staged ? "index" : "worktree",
    path,
    ...(origPath ? { origPath } : {}),
    staged,
    unstaged,
    conflicted,
  };
}

export function parsePorcelainV2(stdout: string): V2Status | null {
  if (!stdout.trim()) return null;

  const entries = stdout.includes("\0") ? stdout.split("\0") : stdout.split("\n");
  const branchLines: string[] = [];
  const files: V2ChangedFile[] = [];

  for (let index = 0; index < entries.length; index++) {
    const line = entries[index] ?? "";
    if (line.startsWith("#")) {
      branchLines.push(line);
    } else if (line.startsWith("1 ") && line.length > 2) {
      const match = line.match(/^1 (\S{2}) (\S+) \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (match) files.push(changedFile(match[1]!, match[2]!, match[3]!));
    } else if (line.startsWith("2 ") && line.length > 2) {
      const match = line.match(/^2 (\S{2}) (\S+) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (match) {
        let path = match[3]!;
        let origPath: string | undefined;
        if (stdout.includes("\0")) {
          origPath = entries[++index] || undefined;
        } else {
          [path, origPath] = path.split("\t", 2);
        }
        files.push(changedFile(match[1]!, match[2]!, path, origPath));
      }
    } else if (line.startsWith("u ") && line.length > 2) {
      const match = line.match(/^u (\S{2}) (\S+) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/);
      if (match) files.push(changedFile(match[1]!, match[2]!, match[3]!, undefined, true));
    } else if (line.startsWith("? ") && line.length > 2) {
      const path = line.slice(2);
      if (path) files.push(changedFile("??", ".", path));
    }
  }

  const branch = parseV2BranchLine(branchLines.join("\n"));

  const staged = files.filter((file) => file.staged).length;
  const unstaged = files.filter((file) => file.unstaged).length;
  const untracked = files.filter((file) => file.stage === "untracked").length;
  const conflicted = files.filter((file) => file.conflicted).length;

  return {
    branch,
    staged,
    unstaged,
    untracked,
    conflicted,
    files,
    truncated: false,
  };
}

/* ------------------------------------------------------------------ */
/*  Read operations                                                    */
/* ------------------------------------------------------------------ */

function getRepoOptions(repoPath: string, timeout?: number) {
  return {
    repoPath,
    timeout: timeout ?? 15_000,
    maxOutputBytes: 1_048_576,
  };
}

export function readPorcelainV2(repoPath: string): V2Status | null {
  const r = runGitSync(
    ["status", "--porcelain=v2", "--branch", "-z", "-u"],
    getRepoOptions(repoPath)
  );
  if (r.exitCode !== 0) return null;
  return parsePorcelainV2(r.stdout);
}

function readLocalBranches(repoPath: string): LocalBranch[] {
  const r = runGitSync(
    ["branch", "--format=%(refname:short)|%(objectname)|%(upstream:short)|%(upstream:track)", "--list"],
    getRepoOptions(repoPath)
  );
  if (r.exitCode !== 0) return [];

  const currentR = runGitSync(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    getRepoOptions(repoPath)
  );
  const currentBranch = currentR.exitCode === 0 ? currentR.stdout.trim() : "HEAD";

  const branches: LocalBranch[] = [];
  for (const line of r.stdout.trim().split("\n")) {
    if (!line) continue;
    const [name, oid, upstreamShort, track] = line.split("|");
    if (!name || !oid) continue;

    let ahead = 0;
    let behind = 0;
    if (track && track.includes("[")) {
      const trackInfo = track.split("[")[1]?.replace("]", "") ?? "";
      const a = trackInfo.match(/ahead (\d+)/);
      const b = trackInfo.match(/behind (\d+)/);
      ahead = a ? parseInt(a[1], 10) : 0;
      behind = b ? parseInt(b[1], 10) : 0;
    }

    const upstream = upstreamShort && upstreamShort !== "(upstream)" ? upstreamShort : "";

    branches.push({
      name,
      ref: `refs/heads/${name}`,
      headOid: oid,
      upstream,
      ahead,
      behind,
      isCurrent: name === currentBranch,
    });
  }

  return branches;
}

export function readRemotes(repoPath: string): RemoteInfo[] {
  const r = runGitSync(
    ["remote", "-v"],
    getRepoOptions(repoPath)
  );
  if (r.exitCode !== 0) return [];

  const remotes = new Map<string, RemoteInfo>();
  for (const line of r.stdout.trim().split("\n")) {
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const name = parts[0]!;
    const url = parts[1]!;
    const type = parts[2] ?? "";

    if (!remotes.has(name)) {
      remotes.set(name, { name, pushUrl: "", fetchUrl: "" });
    }
    const entry = remotes.get(name)!;
    if (type === "(fetch)") entry.fetchUrl = url;
    if (type === "(push)") entry.pushUrl = url;
    if (!type) entry.fetchUrl = url;
  }

  return Array.from(remotes.values());
}

/**
 * Read locally-cached remote refs (no network — reads refs/remotes/* from
 * the local git store populated by previous fetches).
 */
function readCachedRemoteRefs(repoPath: string): RemoteRef[] {
  const r = runGitSync(
    ["for-each-ref", "--format=%(refname)|%(objectname)", "refs/remotes/"],
    getRepoOptions(repoPath, 10_000)
  );
  if (r.exitCode !== 0) return [];

  const refs: RemoteRef[] = [];
  for (const line of r.stdout.trim().split("\n")) {
    if (!line) continue;
    const sep = line.indexOf("|");
    if (sep === -1) continue;
    const ref = line.slice(0, sep);
    const oid = line.slice(sep + 1);
    if (ref && oid) refs.push({ ref, oid });
  }
  return refs;
}

function readRemoteRefs(repoPath: string, remote: string): RemoteRef[] {
  const r = runGitSync(
    ["ls-remote", "--heads", "--refs", remote],
    getRepoOptions(repoPath, 10_000)
  );
  if (r.exitCode !== 0) return [];

  const refs: RemoteRef[] = [];
  for (const line of r.stdout.trim().split("\n")) {
    if (!line) continue;
    const [oid, ref] = line.split(/\s+/);
    if (oid && ref) {
      refs.push({ ref, oid });
    }
  }
  return refs;
}

function readAllRemotesRefs(repoPath: string, remotes: RemoteInfo[]): RemoteRef[] {
  const all: RemoteRef[] = [];
  for (const remote of remotes) {
    const refs = readRemoteRefs(repoPath, remote.name);
    all.push(...refs);
    if (all.length > 500) break;
  }
  return all.slice(0, 500);
}

export function readWorktrees(repoPath: string): WorktreeEntry[] {
  const r = runGitSync(
    ["worktree", "list", "--porcelain"],
    getRepoOptions(repoPath)
  );
  if (r.exitCode !== 0) return [];

  const wts: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};

  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (t.startsWith("worktree ")) {
      if (current.path) {
        wts.push(finalizeWorktree(current));
      }
      current = { path: t.slice("worktree ".length) };
    } else if (t.startsWith("HEAD ")) {
      current.headOid = t.slice("HEAD ".length);
    } else if (t.startsWith("branch ")) {
      const ref = t.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (t === "detached") {
      current.branch = null;
    } else if (t.startsWith("locked")) {
      current.locked = true;
    } else if (t.startsWith("prunable")) {
      current.prunable = true;
    }
  }

  if (current.path) {
    wts.push(finalizeWorktree(current));
  }

  markPrimaryWorktree(wts);
  return wts;
}

function finalizeWorktree(wt: Partial<WorktreeEntry>): WorktreeEntry {
  return {
    path: wt.path ?? "",
    branch: wt.branch ?? null,
    headOid: wt.headOid ?? "",
    isPrimary: wt.isPrimary ?? false, // will set below
    locked: wt.locked ?? false,
    prunable: wt.prunable ?? false,
  };
}

function markPrimaryWorktree(wts: WorktreeEntry[]): void {
  // The first worktree (by convention) is the primary one
  // which is located at the repo root
  if (wts.length > 0) {
    wts[0]!.isPrimary = true;
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Get full live status for a single repository.
 * Returns cached data if within TTL.
 */
export function getRepoStatus(
  repo: Repository,
  opts?: { ttlMs?: number; timeout?: number }
): RepoStatus {
  // Check cache
  const cached = getCached(repo.id, opts?.ttlMs);
  if (cached) return cached;

  const errors: string[] = [];

  // Ensure repo path exists and is registered
  if (!existsSync(repo.rootPath)) {
    return {
      repoId: repo.id,
      rootPath: repo.rootPath,
      currentBranch: "(error)",
      headRef: "",
      headOid: "",
      upstream: null,
      ahead: 0,
      behind: 0,
      v2Status: null,
      localBranches: [],
      remotes: [],
      remoteRefs: [],
      worktrees: [],
      errors: [`Repository path does not exist: ${repo.rootPath}`],
      cachedAt: Date.now(),
    };
  }

  try {
    const canonical = realpathSync(repo.rootPath);
    _registerRepoPath(canonical);
  } catch {
    errors.push(`Cannot resolve canonical path: ${repo.rootPath}`);
  }

  const repoPath = repo.rootPath;
  const timeout = opts?.timeout;

  // Gather all data (catch individual failures)
  let v2Status: V2Status | null = null;
  let localBranches: LocalBranch[] = [];
  let remotes: RemoteInfo[] = [];
  let worktrees: WorktreeEntry[] = [];

  let remoteRefs: RemoteRef[] = [];

  try { v2Status = readPorcelainV2(repoPath); } catch (e) { errors.push(`v2 status: ${String(e)}`); }
  try { localBranches = readLocalBranches(repoPath); } catch (e) { errors.push(`branches: ${String(e)}`); }
  try { remotes = readRemotes(repoPath); } catch (e) { errors.push(`remotes: ${String(e)}`); }
  try { worktrees = readWorktrees(repoPath); markPrimaryWorktree(worktrees); } catch (e) { errors.push(`worktrees: ${String(e)}`); }
  // Populate remote refs from local cache (no network) so the UI can
  // offer them as discoverable branch/ref options.
  try { remoteRefs = readCachedRemoteRefs(repoPath); } catch (e) { errors.push(`remote refs: ${String(e)}`); }

  let headRef = "(detached)";
  let currentBranch = "(detached)";
  let headOid = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (v2Status) {
    headRef = v2Status.branch.ref;
    headOid = v2Status.branch.headOid;
    upstream = v2Status.branch.upstream || null;
    ahead = v2Status.branch.ahead;
    behind = v2Status.branch.behind;

    if (headRef.startsWith("refs/heads/")) {
      currentBranch = headRef.slice("refs/heads/".length);
    }
  }

  // Try to get current branch via rev-parse as fallback
  if (currentBranch === "(detached)") {
    const br = runGitSync(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      getRepoOptions(repoPath, timeout)
    );
    if (br.exitCode === 0 && br.stdout.trim() !== "HEAD") {
      currentBranch = br.stdout.trim();
      headRef = `refs/heads/${currentBranch}`;
    }
  }

  // Get HEAD OID fallback
  if (!headOid) {
    const oidR = runGitSync(
      ["rev-parse", "HEAD"],
      getRepoOptions(repoPath, timeout)
    );
    if (oidR.exitCode === 0) {
      headOid = oidR.stdout.trim();
    }
  }

  const status: RepoStatus = {
    repoId: repo.id,
    rootPath: repo.rootPath,
    currentBranch,
    headRef,
    headOid,
    upstream,
    ahead,
    behind,
    v2Status,
    localBranches,
    remotes,
    remoteRefs, // populated from local git cache (no network)
    worktrees,
    errors,
    cachedAt: Date.now(),
  };

  setCached(repo.id, status, opts?.ttlMs);
  return status;
}

/**
 * Get remote refs for a repo (lazy, not cached in status).
 */
export function getRepoRemoteRefs(
  repo: Repository,
  remote?: string
): RemoteRef[] {
  const repoPath = repo.rootPath;
  if (remote) {
    return readRemoteRefs(repoPath, remote);
  }
  const remotes = readRemotes(repoPath);
  return readAllRemotesRefs(repoPath, remotes);
}

/**
 * Get status for multiple repos (aggregated, with individual error handling).
 */
export function getWorkspaceStatus(
  repos: Repository[],
  opts?: { ttlMs?: number; timeout?: number }
): RepoStatus[] {
  return repos.map((repo) => {
    try {
      return getRepoStatus(repo, opts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        repoId: repo.id,
        rootPath: repo.rootPath,
        currentBranch: "(error)",
        headRef: "",
        headOid: "",
        upstream: null,
        ahead: 0,
        behind: 0,
        v2Status: null,
        localBranches: [],
        remotes: [],
        remoteRefs: [],
        worktrees: [],
        errors: [msg],
        cachedAt: Date.now(),
      } as RepoStatus;
    }
  });
}
