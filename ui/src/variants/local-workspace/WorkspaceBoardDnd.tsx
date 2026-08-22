import {
  useCallback,
  type MouseEventHandler,
  type ReactNode,
  type TouchEventHandler,
} from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import type { Lane, Workspace, WorkspaceAgentSnapshot } from "./LocalWorkspace";
import type { GitlabMergeRequest, GitlabReview } from "../../lib/wtsClient";
import { Glyph } from "./Glyph";
import { WorkspaceCard } from "./WorkspaceCard";
import styles from "./LocalWorkspace.module.css";

export const WORKSPACE_BOARD_ORDER_STORAGE_KEY = "wts.workspace-board-order.v1";

const BOARD_LANES: Lane[] = [
  "planned",
  "attention",
  "active",
  "suspended",
];

export interface WorkspaceBoardOrder {
  schemaVersion: 1;
  lanes: Record<Lane, string[]>;
}

export interface WorkspaceBoardPlacement {
  workspaceId: string;
  sourceLane: Lane;
  targetLane: Lane;
  targetWorkspaceId: string | null;
  edge: "before" | "after";
}

function emptyWorkspaceBoardOrder(): WorkspaceBoardOrder {
  return {
    schemaVersion: 1,
    lanes: {
      planned: [],
      active: [],
      attention: [],
      suspended: [],
    },
  };
}

export function loadWorkspaceBoardOrder(
  storage: Pick<Storage, "getItem"> = localStorage,
): WorkspaceBoardOrder {
  try {
    const parsed = JSON.parse(
      storage.getItem(WORKSPACE_BOARD_ORDER_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
    ) {
      return emptyWorkspaceBoardOrder();
    }
    const rawLanes = (parsed as { lanes?: unknown }).lanes;
    if (!rawLanes || typeof rawLanes !== "object") {
      return emptyWorkspaceBoardOrder();
    }
    const seen = new Set<string>();
    const order = emptyWorkspaceBoardOrder();
    for (const lane of BOARD_LANES) {
      const values = (rawLanes as Record<string, unknown>)[lane];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (typeof value !== "string" || !value.trim() || seen.has(value)) {
          continue;
        }
        seen.add(value);
        order.lanes[lane].push(value);
      }
    }
    return order;
  } catch {
    return emptyWorkspaceBoardOrder();
  }
}

export function saveWorkspaceBoardOrder(
  order: WorkspaceBoardOrder,
  storage: Pick<Storage, "setItem"> = localStorage,
) {
  storage.setItem(WORKSPACE_BOARD_ORDER_STORAGE_KEY, JSON.stringify(order));
}

export function reconcileWorkspaceBoardOrder(
  order: WorkspaceBoardOrder,
  workspaceLanes: ReadonlyMap<string, Lane>,
  fallbackWorkspaceIds: readonly string[],
): WorkspaceBoardOrder {
  const reconciled = emptyWorkspaceBoardOrder();
  const placed = new Set<string>();
  for (const lane of BOARD_LANES) {
    for (const workspaceId of order.lanes[lane]) {
      if (workspaceLanes.get(workspaceId) !== lane || placed.has(workspaceId)) {
        continue;
      }
      placed.add(workspaceId);
      reconciled.lanes[lane].push(workspaceId);
    }
  }
  for (const workspaceId of fallbackWorkspaceIds) {
    const lane = workspaceLanes.get(workspaceId);
    if (!lane || placed.has(workspaceId)) continue;
    placed.add(workspaceId);
    reconciled.lanes[lane].push(workspaceId);
  }
  return reconciled;
}

export function placeWorkspaceOnBoard(
  order: WorkspaceBoardOrder,
  placement: WorkspaceBoardPlacement,
): WorkspaceBoardOrder {
  const next: WorkspaceBoardOrder = {
    schemaVersion: 1,
    lanes: {
      planned: order.lanes.planned.filter(
        (workspaceId) => workspaceId !== placement.workspaceId,
      ),
      active: order.lanes.active.filter(
        (workspaceId) => workspaceId !== placement.workspaceId,
      ),
      attention: order.lanes.attention.filter(
        (workspaceId) => workspaceId !== placement.workspaceId,
      ),
      suspended: order.lanes.suspended.filter(
        (workspaceId) => workspaceId !== placement.workspaceId,
      ),
    },
  };
  const target = next.lanes[placement.targetLane];
  const targetIndex = placement.targetWorkspaceId
    ? target.indexOf(placement.targetWorkspaceId)
    : -1;
  const insertionIndex =
    targetIndex < 0
      ? target.length
      : targetIndex + (placement.edge === "after" ? 1 : 0);
  target.splice(insertionIndex, 0, placement.workspaceId);
  return next;
}

export function workspaceBoardPosition(
  order: WorkspaceBoardOrder,
  lane: Lane,
  workspaceId: string,
): number {
  const index = order.lanes[lane].indexOf(workspaceId);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function workspacePlacementNeighbor(
  placement: WorkspaceBoardPlacement,
): { beforeWorkspaceId?: string; afterWorkspaceId?: string } {
  if (!placement.targetWorkspaceId) return {};
  return placement.edge === "before"
    ? { beforeWorkspaceId: placement.targetWorkspaceId }
    : { afterWorkspaceId: placement.targetWorkspaceId };
}

export function WorkspaceLaneDropTarget({
  children,
  lane,
}: {
  children: ReactNode;
  lane: Lane;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `lane:${lane}`,
    data: { type: "column", lane },
  });
  return (
    <section
      aria-labelledby={`workspace-lane-${lane}`}
      className={styles.lane}
      data-drop-active={isOver || undefined}
      data-ui={`spaces.lane.${lane}`}
      data-ui-label={`${lane[0]!.toUpperCase()}${lane.slice(1)} column`}
      ref={setNodeRef}
    >
      {children}
    </section>
  );
}

export function AssignedReviewCard({
  error,
  onOpen,
  onPrepare,
  opening,
  preparing,
  review,
}: {
  error?: string;
  onOpen: () => void;
  onPrepare: () => void;
  opening: boolean;
  preparing: boolean;
  review: GitlabReview;
}) {
  const commentCount = review.commentCount ?? 0;
  const status = review.reviewState === "changesAfterApproval"
    ? "changed"
    : review.draft
    ? "draft"
    : review.discussionsResolved === false
      ? "discussion"
      : commentCount > 0
        ? "commented"
        : "open";
  return (
    <article
      className={styles.assignedReviewCard}
      data-status={status}
      data-ui={`spaces.review.${review.id}`}
      data-ui-label={`${review.repository} review request`}
    >
      <button
        aria-label="Create review workspace"
        className={styles.assignedReviewBody}
        disabled={preparing}
        onClick={onPrepare}
        type="button"
      >
        <header>
          <strong>{review.repository}</strong>
        </header>
        <h3>{review.title}</h3>
        <footer>
          <span>
            {review.reviewState === "changesAfterApproval"
              ? "New changes after approval"
              : `Requested by ${review.authorLogin}`}
          </span>
          {review.draft && <b>Draft</b>}
          {commentCount > 0 && (
            <span aria-label={`${commentCount} comments`}>
              {commentCount} {commentCount === 1 ? "comment" : "comments"}
            </span>
          )}
          <strong
            aria-hidden="true"
            className={styles.assignedReviewCreateIcon}
          >
            <Glyph name={preparing ? "refresh" : "folder"} size={14} />
          </strong>
        </footer>
      </button>
      <button
        aria-label={`Open ${review.repository} merge request !${review.number}`}
        className={styles.assignedReviewLink}
        disabled={opening}
        onClick={onOpen}
        type="button"
      >
        {opening ? "Opening…" : `MR !${review.number}`}
      </button>
      {error && <small role="alert">{error}</small>}
    </article>
  );
}

export function DraggableWorkspaceCard({
  agent,
  buttonRef,
  displayLane,
  dropIndicator,
  index,
  onOpen,
  placementLabel,
  primaryActionLabel,
  reorderDisabled = false,
  issueAction,
  mergeRequests,
  moveActions,
  workspace,
}: {
  agent?: WorkspaceAgentSnapshot;
  buttonRef?: (element: HTMLButtonElement | null) => void;
  displayLane: Lane;
  dropIndicator?: "before" | "after";
  index: number;
  onOpen: (modified: boolean) => void;
  placementLabel?: string;
  primaryActionLabel?: string;
  reorderDisabled?: boolean;
  issueAction?: {
    label: string;
    onPress: () => void;
  };
  mergeRequests?: readonly GitlabMergeRequest[];
  moveActions?: Array<{
    label: string;
    onPress: () => void;
  }>;
  workspace: Workspace;
}) {
  const {
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef: setDraggableNodeRef,
    transform,
  } = useDraggable({
    id: `workspace:${workspace.id}`,
    disabled: reorderDisabled,
    data: {
      type: "card",
      workspaceId: workspace.id,
      lane: displayLane,
      index,
    },
    });
  const { setNodeRef: setDroppableNodeRef } = useDroppable({
    id: `workspace:${workspace.id}`,
    data: {
      type: "card",
      workspaceId: workspace.id,
      lane: displayLane,
      index,
    },
  });
  const setNodeRef = useCallback(
    (element: HTMLDivElement | null) => {
      setDraggableNodeRef(element);
      setDroppableNodeRef(element);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );
  return (
    <div
      className={styles.draggableWorkspace}
      data-dragging={isDragging || undefined}
      data-drop-position={dropIndicator}
      data-ui={`spaces.workspace.${workspace.id}`}
      data-ui-label={`${workspace.key} workspace card`}
      data-workspace-id={workspace.id}
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform) }}
    >
      <WorkspaceCard
        agent={agent}
        buttonRef={(element) => {
          setActivatorNodeRef(element);
          buttonRef?.(element);
        }}
        dragProps={{
          onMouseDown: listeners?.onMouseDown as
            | MouseEventHandler<HTMLButtonElement>
            | undefined,
          onTouchStart: listeners?.onTouchStart as
            | TouchEventHandler<HTMLButtonElement>
            | undefined,
        }}
        onOpen={onOpen}
        primaryActionLabel={primaryActionLabel}
        issueAction={issueAction}
        mergeRequests={mergeRequests}
        moveActions={moveActions}
        workspace={
          workspace.lane === displayLane
            ? workspace
            : { ...workspace, lane: displayLane }
        }
      />
      {placementLabel && (
        <span className={styles.workspacePlacementBadge}>{placementLabel}</span>
      )}
    </div>
  );
}

export function WorkspaceActionDropTarget({
  action,
  children,
}: {
  action: "archive" | "delete";
  children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({
    id: `action:${action}`,
    data: { type: "action", action },
  });
  return (
    <div
      className={styles.workspaceActionDrop}
      data-action={action}
      data-drop-active={isOver || undefined}
      data-ui={`spaces.drop-action.${action}`}
      data-ui-label={`${action === "archive" ? "Archive" : "Delete"} drop area`}
      ref={setNodeRef}
    >
      {children}
    </div>
  );
}
