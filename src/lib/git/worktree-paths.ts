import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export function getWorktreeRoot(): string {
  return resolve(
    process.env.WORKTREE_ROOT ??
      resolve(homedir(), ".local", "share", "dashboard", "worktrees")
  );
}

export function isWithinWorktreeRoot(candidate: string): boolean {
  if (!isAbsolute(candidate)) return false;
  const rel = relative(getWorktreeRoot(), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function defaultWorktreePath(repoId: string, branch: string): string {
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
  return resolve(getWorktreeRoot(), `${repoId}-${safeBranch}`);
}
