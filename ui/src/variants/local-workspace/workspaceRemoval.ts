import type { RemovalBlocker, RemovalBlockerCode, WorkspaceRemovalPreflight } from "../../lib/wtsClient";

const recoverySteps: Record<RemovalBlockerCode, string[]> = {
  activeOperation: [
    "Open the workspace to review active agents and queued messages.",
    "Open Verify to review or cancel active checks.",
    "Wait for the work to stop. Then select Check again.",
  ],
  workspaceDrift: [
    "Open the workspace and inspect the repository, branch, and path shown here.",
    "If the change is expected, select Register changes & re-index.",
    "If removal stays blocked, restore the recorded location or repository. Then select Check again.",
  ],
  unexpectedPath: [
    "Inspect this path in Finder with Go to Folder.",
    "Move files you want to keep outside the workspace.",
    "Select Check again after you resolve the listed path.",
  ],
  worktreeChanges: [
    "Review the local changes before removal.",
    "Commit the work you want to keep, or copy it outside the workspace.",
    "To delete it, use the explicit deletion confirmation below.",
  ],
  ignoredFiles: [
    "Inspect the ignored files at this path. Copy files you want to keep outside the workspace.",
    "To delete it, use the explicit deletion confirmation below.",
  ],
  planningDocumentsPresent: [
    "Open Plans to inspect the planning files. Copy files you want to keep outside the workspace.",
    "To delete it, use the explicit deletion confirmation below.",
  ],
  gitUnavailable: [
    "Open Environment & integrations to check Git.",
    "Restore Git access, then select Check again.",
  ],
};

export function removalRecoverySteps(blocker: RemovalBlocker) {
  return blocker.recoverySteps?.length ? blocker.recoverySteps : recoverySteps[blocker.code];
}

export function removalRecoveryReport(preflight: WorkspaceRemovalPreflight) {
  return [preflight.workspaceDisplayPath, ...preflight.blockers.flatMap((blocker) => [
    `${blocker.repositoryLabel ?? "Workspace"}: ${blocker.message}`,
    ...(blocker.displayPath ? [blocker.displayPath] : []),
    ...(blocker.expected ? [`Expected: ${blocker.expected}`] : []),
    ...(blocker.observed ? [`Found: ${blocker.observed}`] : []),
    ...removalRecoverySteps(blocker).map((step, index) => `${index + 1}. ${step}`),
  ])].join("\n");
}

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
