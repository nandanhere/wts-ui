/**
 * Working-directory confinement for task processes.
 *
 * A task process must run inside its worktree. A configured `workdir`
 * that escapes the worktree is rejected instead of being spawned.
 */

import { resolve, sep } from "node:path";

/** True when `child` is `parent` itself or a descendant of it. */
export function isPathInside(parent: string, child: string): boolean {
  const resolvedParent = resolve(parent);
  const resolvedChild = resolve(child);
  return (
    resolvedChild === resolvedParent ||
    resolvedChild.startsWith(resolvedParent + sep)
  );
}

/**
 * Resolve the spawn cwd for a process.
 *
 * Returns the worktree root when no workdir is configured, the joined
 * path for a nested workdir, and null when the workdir escapes the
 * worktree (relative `..` segments or an absolute path elsewhere).
 */
export function resolveProcessCwd(
  worktreePath: string,
  workdir?: string
): string | null {
  const root = resolve(worktreePath);
  if (!workdir) return root;
  const cwd = resolve(root, workdir);
  return isPathInside(root, cwd) ? cwd : null;
}
