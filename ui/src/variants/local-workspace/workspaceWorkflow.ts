import type {
  GitlabReview,
  GitlabReviewTarget,
  WorkspaceIntent,
  WorkspaceWorkflowState,
} from "../../lib/wtsClient";

export type WorkspaceBoardLane =
  | "planned"
  | "active"
  | "attention"
  | "suspended";

export interface WorkflowAgentSignal {
  state: "working" | "idle" | "attention";
  updateKind?: "progress" | "completion";
}

export interface WorkflowMergeRequestSignal {
  status: "open" | "merged" | "closed";
  updatedAt: string;
}

export interface ReviewWorkspaceSignalSource {
  intent: WorkspaceIntent;
  title?: string;
  repositoryPlans: readonly {
    repositoryId?: string;
    label?: string;
    baseRef: string;
  }[];
}

const WORKFLOW_SIGNAL_KEY = "wts.workspace-workflow-signals.v1";

const laneByState: Record<WorkspaceWorkflowState, WorkspaceBoardLane> = {
  ready: "planned",
  active: "active",
  review: "attention",
  parked: "suspended",
};

const stateByLane: Record<WorkspaceBoardLane, WorkspaceWorkflowState> = {
  planned: "ready",
  active: "active",
  attention: "review",
  suspended: "parked",
};

export function laneForWorkflowState(
  state: WorkspaceWorkflowState,
): WorkspaceBoardLane {
  return laneByState[state];
}

export function workflowStateForLane(
  lane: WorkspaceBoardLane,
): WorkspaceWorkflowState {
  return stateByLane[lane];
}

/**
 * Convert agent activity into a durable workflow suggestion.
 *
 * Parked workspaces never move automatically. An idle observation without an
 * explicit completion does not change the user's selected state.
 */
export function suggestedWorkflowState(
  current: WorkspaceWorkflowState,
  signal: WorkflowAgentSignal | undefined,
  options: { allowUnpark?: boolean } = {},
): WorkspaceWorkflowState | null {
  if (!signal || (current === "parked" && !options.allowUnpark)) return null;
  if (signal.state === "working") {
    return current === "active" ? null : "active";
  }
  if (signal.state === "attention" || signal.updateKind === "completion") {
    return current === "review" ? null : "review";
  }
  return null;
}

/**
 * Convert fresh provider MR state into a durable workflow suggestion.
 *
 * Any open MR means that work is waiting outside WTS. After delivery, merged
 * work returns for final review. A closed, unmerged MR makes the work active
 * again. The caller must ignore stale provider data and pinned workspaces.
 */
export function suggestedWorkflowStateForMergeRequests(
  current: WorkspaceWorkflowState,
  mergeRequests: readonly WorkflowMergeRequestSignal[],
): WorkspaceWorkflowState | null {
  if (!mergeRequests.length) return null;
  const target = mergeRequests.some((mergeRequest) => mergeRequest.status === "open")
    ? "parked"
    : [...mergeRequests].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      )[0]?.status === "merged"
      ? "review"
      : "active";
  return target === current ? null : target;
}

/**
 * Match only review workspaces that WTS created from a verified GitLab review.
 *
 * The saved review label identifies the provider item. A cloned review
 * repository gets a new local ID, so its repository label and source branch
 * provide the stable association after the clone.
 */
export function gitlabReviewForWorkspace(
  workspace: ReviewWorkspaceSignalSource,
  reviews: readonly GitlabReview[],
): GitlabReview | undefined {
  const reference = gitlabReviewReferenceForWorkspace(workspace);
  if (!reference) return undefined;
  return reviews.find(
    (review) =>
      review.repository === reference.repository &&
      review.number === reference.number &&
      workspace.repositoryPlans.some(
        (repository) =>
          repository.baseRef === review.sourceBranch &&
          (repository.repositoryId === review.repositoryId ||
            repository.label === reference.repositoryLabel),
      ),
  );
}

/**
 * Resolve the provider identity retained by a review workspace.
 *
 * Completed reviews disappear from the pending-review inbox. Their saved
 * workspace title and catalog-owned local repository remain sufficient for a
 * trusted patch request.
 */
export function gitlabReviewTargetForWorkspace(
  workspace: ReviewWorkspaceSignalSource,
  reviews: readonly GitlabReview[],
): GitlabReviewTarget | undefined {
  const current = gitlabReviewForWorkspace(workspace, reviews);
  if (current) return current;
  const reference = gitlabReviewReferenceForWorkspace(workspace);
  if (!reference) return undefined;
  const repository = workspace.repositoryPlans.find(
    (candidate) =>
      candidate.repositoryId && candidate.label === reference.repositoryLabel,
  );
  if (!repository?.repositoryId) return undefined;
  return {
    repositoryId: repository.repositoryId,
    repository: reference.repository,
    number: reference.number,
  };
}

function gitlabReviewReferenceForWorkspace(
  workspace: ReviewWorkspaceSignalSource,
): { repository: string; repositoryLabel: string; number: number } | undefined {
  if (workspace.intent.type !== "repositorySet") return undefined;
  const match = [workspace.intent.label, workspace.title]
    .filter((value): value is string => Boolean(value))
    .map((value) => /^Review (.+) !([1-9][0-9]*)$/.exec(value))
    .find((value) => value !== null);
  if (!match) return undefined;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number)) return undefined;
  const repository = match[1];
  const repositoryLabel = repository?.split("/").at(-1);
  if (!repository || !repositoryLabel) return undefined;
  return { repository, repositoryLabel, number };
}

/**
 * Move a completed review workspace while GitLab remains the fresh authority.
 * Approval parks an open MR. Delivery and closure use the existing MR states.
 */
export function suggestedWorkflowStateForGitlabReview(
  current: WorkspaceWorkflowState,
  review: GitlabReview | undefined,
): WorkspaceWorkflowState | null {
  if (!review) return null;
  if (
    review.reviewState === "changesAfterApproval" &&
    review.status === "open"
  ) {
    return current === "review" ? null : "review";
  }
  if (review.reviewState === "requested" && review.status === "open") {
    return current === "review" ? null : "review";
  }
  if (review.reviewState !== "approved") return null;
  const target =
    review.status === "open"
      ? "parked"
      : review.status === "merged"
        ? "review"
        : "active";
  return target === current ? null : target;
}

export function workspaceWorkflowSignalHandled(
  workspaceId: string,
  eventAtUnixMs: number,
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): boolean {
  if (!storage) return false;
  try {
    const current = JSON.parse(
      storage.getItem(WORKFLOW_SIGNAL_KEY) ?? "{}",
    ) as Record<string, unknown>;
    const handledAt = current[workspaceId];
    return typeof handledAt === "number" && handledAt >= eventAtUnixMs;
  } catch {
    return false;
  }
}

export function markWorkspaceWorkflowSignalHandled(
  workspaceId: string,
  eventAtUnixMs: number,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined =
    globalThis.localStorage,
): boolean {
  if (!storage || !workspaceId.trim() || eventAtUnixMs < 0) return false;
  try {
    const current = JSON.parse(
      storage.getItem(WORKFLOW_SIGNAL_KEY) ?? "{}",
    ) as Record<string, unknown>;
    storage.setItem(
      WORKFLOW_SIGNAL_KEY,
      JSON.stringify({ ...current, [workspaceId]: eventAtUnixMs }),
    );
    return true;
  } catch {
    return false;
  }
}
