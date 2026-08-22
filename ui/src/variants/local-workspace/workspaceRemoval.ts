import type { WorkspaceRemovalPreflight } from "../../lib/wtsClient";

const reviewedDestructiveBlockers = new Set([
  "planningDocumentsPresent",
  "worktreeChanges",
  "ignoredFiles",
]);

export function canAssertDestructiveWorkspaceRemoval(
  preflight: WorkspaceRemovalPreflight | null,
): boolean {
  return Boolean(
    preflight &&
      !preflight.ready &&
      preflight.blockers.length > 0 &&
      preflight.blockers.every((blocker) =>
        reviewedDestructiveBlockers.has(blocker.code),
      ),
  );
}
