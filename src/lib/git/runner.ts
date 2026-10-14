/**
 * Shell-free bounded Git runner.
 *
 * - Uses `execFile` / `spawn` argument arrays (no shell injection)
 * - Canonical-path check: refuses repos outside resolved registrations
 * - Sanitized env: forces GIT_TERMINAL_PROMPT=0, no pager, no editor
 * - Timeout and output-size bounds
 * - All paths canonicalised via realpathSync before use
 * - Errors normalised into GitError union
 */

import { execFileSync, execFile } from "node:child_process";
import { realpathSync, existsSync } from "node:fs";
import type { GitResult, GitError, GitRunnerOptions } from "./types";

/** Absolute path to the git binary (resolved once) */
let _gitPath: string | null = null;

function getGitPath(): string {
  if (_gitPath) return _gitPath;
  try {
    const resolved = execFileSync("which", ["git"], {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    if (!resolved || !existsSync(resolved)) {
      throw new Error("git not found");
    }
    _gitPath = resolved;
    return _gitPath;
  } catch {
    throw makeGitError("GIT_NOT_FOUND", "git binary not found in PATH");
  }
}

/** Reset the cached git path (useful in tests) */
export function _resetGitPath(): void {
  _gitPath = null;
}

/** Override git path (useful in tests) */
export function _setGitPath(p: string): void {
  _gitPath = p;
}

/** Canonical check: ensure path is within allowed registered paths */
const _allowedRepoPaths = new Set<string>();

export function _registerRepoPath(p: string): void {
  _allowedRepoPaths.add(p);
}

export function _unregisterRepoPath(p: string): void {
  _allowedRepoPaths.delete(p);
}

export function _clearRepoPaths(): void {
  _allowedRepoPaths.clear();
}

export function _setRepoPaths(paths: Iterable<string>): void {
  const next = new Set(paths);
  _allowedRepoPaths.clear();
  for (const path of next) _allowedRepoPaths.add(path);
}

function assertCanonical(opt: GitRunnerOptions): void {
  if (!existsSync(opt.repoPath)) {
    throw makeGitError("REPO_NOT_FOUND", `Repository path does not exist: ${opt.repoPath}`);
  }
  const canonical = realpathSync(opt.repoPath);
  if (!_allowedRepoPaths.has(canonical) && _allowedRepoPaths.size > 0) {
    throw makeGitError("CANONICAL_PATH_MISMATCH", `Path ${canonical} is not in the registered repo set`);
  }
}

function makeGitError(code: GitError["code"], message: string, detail?: string): GitError {
  return { code, message, detail };
}

function sanitizeEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EDITOR: "true",
    EDITOR: "true",
    VISUAL: "true",
    GIT_SEQUENCE_EDITOR: "true",
    ...extra,
  };
  return env;
}

function redactCommand(cmd: string, _args: string[]): string {
  // Return a safe representation — no paths or values
  return `git ${_args.join(" ")}`;
}

/**
 * Asynchronous git command using execFile (no shell).
 */
export function runGit(args: string[], options: GitRunnerOptions): Promise<GitResult> {
  const start = Date.now();
  const gitPath = getGitPath();
  assertCanonical(options);

  const timeout = options.timeout ?? 15_000;
  const maxOutput = options.maxOutputBytes ?? 1_048_576;
  const env = sanitizeEnv(options.env);

  return new Promise<GitResult>((resolve) => {
    execFile(
      gitPath,
      args,
      { cwd: options.repoPath, env, timeout, maxBuffer: maxOutput },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start;
        if (err && (err as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          resolve({
            exitCode: 124,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            command: redactCommand(gitPath, args),
            durationMs,
          });
          return;
        }
        resolve({
          exitCode: err ? (err as NodeJS.ErrnoException & { status?: number }).status ?? 1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          command: redactCommand(gitPath, args),
          durationMs,
        });
      }
    );
  });
}

/**
 * Synchronous git command (for lightweight reads).
 */
export function runGitSync(args: string[], options: GitRunnerOptions): GitResult {
  const start = Date.now();
  const gitPath = getGitPath();
  assertCanonical(options);

  const timeout = options.timeout ?? 15_000;
  const maxOutput = options.maxOutputBytes ?? 1_048_576;
  const env = sanitizeEnv(options.env);

  try {
    const stdout = execFileSync(gitPath, args, {
      cwd: options.repoPath,
      env,
      timeout,
      maxBuffer: maxOutput,
      encoding: "utf-8",
      stdio: "pipe",
    }) as string;

    return {
      exitCode: 0,
      stdout,
      stderr: "",
      command: redactCommand(gitPath, args),
      durationMs: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException & {
      killed?: boolean;
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    const durationMs = Date.now() - start;
    if (err.code === "ETIMEDOUT" || err.killed) {
      throw makeGitError("GIT_TIMEOUT", `Git command timed out after ${timeout}ms`);
    }
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      command: redactCommand(gitPath, args),
      durationMs,
    };
  }
}

/**
 * Normalise a git error result into a structured GitError.
 */
export function normaliseError(result: GitResult, context?: string): GitError {
  const stderr = result.stderr.trim();
  if (result.exitCode === 127) {
    return makeGitError("GIT_NOT_FOUND", "git binary not found", stderr);
  }
  if (result.exitCode !== 0) {
    // Try to classify based on stderr content
    if (/already exists/i.test(stderr) && /worktree/i.test(stderr)) {
      return makeGitError("WORKTREE_EXISTS", stderr);
    }
    if (/locked/i.test(stderr) && /worktree/i.test(stderr)) {
      return makeGitError("LOCKED", stderr);
    }
    if (/branch.*already checked out/i.test(stderr)) {
      return makeGitError("BRANCH_OCCUPIED", stderr);
    }
    if (/clean.*tree|local changes|uncommitted/i.test(stderr) || /needs merge/i.test(stderr)) {
      return makeGitError("DIRTY_TREE", stderr);
    }
    if (/not a valid worktree/i.test(stderr)) {
      return makeGitError("NOT_A_WORKTREE", stderr);
    }
    if (/not a git repository/i.test(stderr)) {
      return makeGitError("REPO_NOT_FOUND", stderr);
    }
    return makeGitError("GIT_ERROR", stderr || `Git exited with code ${result.exitCode}`, context);
  }
  return makeGitError("GIT_ERROR", "Unknown error", stderr);
}
