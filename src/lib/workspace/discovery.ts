/**
 * Bounded Git repository discovery within workspace folders.
 *
 * For each folder in a WorkspaceDefinition, walk the directory tree
 * (respecting max depth and exclusions) looking for `.git` entries.
 * Detects nested repositories and deduplicates by canonical git common
 * directory.  Shell-free — uses `fs` and `realpath` only.
 */

import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type {
  Repository,
  WorkspaceDefinition,
  WorkspaceScanResult,
  DiscoveryOptions,
  GitWorktree,
} from "./types";
import { DEFAULT_EXCLUDE_PATTERNS } from "./types";

/* ------------------------------------------------------------------ */
/*  Git root detection                                                 */
/* ------------------------------------------------------------------ */

/**
 * Determine whether a directory entry looks like `.git` and resolve
 * its canonical common directory.
 *
 * Returns `null` if the entry is not a valid git directory.
 */
function resolveGitCommonDir(entryPath: string): string | null {
  try {
    const stat = statSync(entryPath);

    if (stat.isDirectory()) {
      // Bare or regular repository — verify it has the expected structure
      if (
        existsSync(join(entryPath, "HEAD")) &&
        (existsSync(join(entryPath, "objects")) ||
          // Shallow repos may be missing objects; also accept config
          existsSync(join(entryPath, "config")))
      ) {
        return realpathSync(entryPath);
      }
      return null;
    }

    if (stat.isFile()) {
      // Worktree: .git is a file containing "gitdir: <path>"
      const content = readFileSync(entryPath, "utf-8").trim();
      const prefix = "gitdir: ";
      if (!content.startsWith(prefix)) return null;
      const linkedGitDir = content.slice(prefix.length).trim();
      if (!linkedGitDir) return null;

      const resolved = resolve(
        dirname(entryPath),
        linkedGitDir
      );
      if (!existsSync(resolved)) return null;

      // The common dir is the resolved path's parent chain until
      // we find a directory with HEAD.
      // Usually the worktree link points to .git/worktrees/<name>.
      // The common .git is the ancestor that has HEAD, objects, refs.
      let candidate: string | undefined = resolved;
      while (candidate && candidate.length > 1) {
        if (
          existsSync(join(candidate, "HEAD")) &&
          (existsSync(join(candidate, "objects")) ||
            existsSync(join(candidate, "config")))
        ) {
          return realpathSync(candidate);
        }
        const parent = dirname(candidate);
        if (parent === candidate) break;
        candidate = parent;
      }
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Locate the repository root (the working tree) from a `.git` path.
 * For a regular repo this is the parent of `.git`.
 * For a worktree we walk up from the `.git` file's parent.
 */
function repoRootFromGit(gitPath: string): string {
  const stat = statSync(gitPath);
  if (stat.isDirectory()) {
    return resolve(gitPath, "..");
  }
  // Worktree: .git is a file, its parent is the worktree root
  return resolve(gitPath, "..");
}

function dirname(p: string): string {
  const i = p.lastIndexOf(sep);
  if (i === -1) return p;
  return p.slice(0, i) || sep;
}

function extractWorktree(gitPath: string): GitWorktree | null {
  try {
    const root = repoRootFromGit(gitPath);
    const headFile = join(root, ".git", "HEAD");
    const headContent = existsSync(headFile)
      ? readFileSync(headFile, "utf-8").trim()
      : "";

    let branch: string | null = null;
    if (headContent.startsWith("ref: refs/heads/")) {
      branch = headContent.slice("ref: refs/heads/".length);
    }

    return { path: root, branch };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Scanning                                                           */
/* ------------------------------------------------------------------ */

/** Internal result from a single folder scan */
interface GitEntry {
  /** The path to .git (file or directory) */
  gitPath: string;
  /** The canonical common directory (dedup key) */
  commonDir: string;
  /** The folder name this entry was found under */
  folderName: string;
}

function isExcluded(
  name: string,
  abspath: string,
  opts: Required<DiscoveryOptions>
): boolean {
  if (opts.excludePatterns.some((re) => re.test(name))) return true;
  if (opts.excludePaths.some((p) => abspath.startsWith(p + sep) || abspath === p))
    return true;
  return false;
}

function getDefaults(opts?: DiscoveryOptions): Required<DiscoveryOptions> {
  return {
    maxDepth: opts?.maxDepth ?? 4,
    excludePatterns: opts?.excludePatterns ?? DEFAULT_EXCLUDE_PATTERNS,
    excludePaths: opts?.excludePaths ?? [],
  };
}

/**
 * Walk a directory tree (bounded) and collect all `.git` entries.
 */
function collectGitEntries(
  startPath: string,
  folderName: string,
  opts: Required<DiscoveryOptions>,
  depth = 0
): GitEntry[] {
  if (depth > opts.maxDepth) return [];
  const results: GitEntry[] = [];

  let entries: string[];
  try {
    entries = readdirSync(startPath);
  } catch {
    return [];
  }

  for (const name of entries) {
    const abspath = join(startPath, name);

    // Skip excluded patterns
    if (isExcluded(name, abspath, opts)) continue;

    let stat: import("node:fs").Stats;
    try {
      stat = statSync(abspath);
    } catch {
      continue;
    }

    if (name === ".git") {
      const commonDir = resolveGitCommonDir(abspath);
      if (commonDir) {
        results.push({ gitPath: abspath, commonDir, folderName });
        // Don't recurse into .git
        continue;
      }
    }

    if (stat.isDirectory()) {
      try {
        results.push(...collectGitEntries(abspath, folderName, opts, depth + 1));
      } catch {
        // permission denied, skip
      }
    }
  }

  return results;
}

/**
 * Generate a stable repository ID.
 *
 * Combines the workspace file path and the canonical commonDir,
 * then SHA-256 hashes them so the result is deterministic and
 * independent of which folder discovered the repo.
 */
export function makeRepoId(
  workspaceFilePath: string,
  commonDir: string
): string {
  const hash = createHash("sha256");
  hash.update(workspaceFilePath);
  hash.update("\0");
  hash.update(commonDir);
  return hash.digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Scan a workspace definition and discover all Git repositories.
 *
 * Deduplication: if two different workspace folders (or nested paths)
 * resolve to the same canonical git common directory, only one
 * Repository object is returned — both folder names appear in
 * `folderMembership`.
 */
export function scanWorkspace(
  ws: WorkspaceDefinition,
  opts?: DiscoveryOptions
): WorkspaceScanResult {
  const options = getDefaults(opts);
  const errors: string[] = [];

  // Collect all git entries across all folders
  const allEntries: GitEntry[] = [];

  for (const folder of ws.folders) {
    if (!folder.exists) {
      errors.push(`Folder does not exist: ${folder.resolvedPath} (${folder.name})`);
      continue;
    }

    try {
      const entries = collectGitEntries(
        folder.resolvedPath,
        folder.name,
        options
      );
      allEntries.push(...entries);
    } catch (err) {
      errors.push(
        `Error scanning ${folder.resolvedPath}: ${String(err)}`
      );
    }
  }

  // Deduplicate by commonDir — first wins
  const seen = new Map<string, Repository>();

  for (const entry of allEntries) {
    if (seen.has(entry.commonDir)) {
      // Add folder membership
      const existing = seen.get(entry.commonDir)!;
      if (!existing.folderMembership.includes(entry.folderName)) {
        existing.folderMembership.push(entry.folderName);
      }
      continue;
    }

    const rootPath = repoRootFromGit(entry.gitPath);
    const worktree = extractWorktree(entry.gitPath);

    const repo: Repository = {
      id: makeRepoId(ws.filePath, entry.commonDir),
      rootPath,
      commonDir: entry.commonDir,
      worktree,
      folderMembership: [entry.folderName],
    };

    seen.set(entry.commonDir, repo);
  }

  return {
    workspace: ws,
    repositories: Array.from(seen.values()),
    errors,
  };
}
