import { useWorkspaceAttention } from "./useWorkspaceAttention";
import { openAgentFeedbackResult } from "../../lib/agentFeedbackEvents";
import { loadAgentSessions } from "../../lib/agentSessionDiscovery";
import type { AgentMrLinkProposal } from "../../lib/wtsClient";
import { returnToFeedbackSelection } from "../../lib/agentFeedbackNavigation";
import { getWorkspaceAttentionStore, type WorkspaceAttentionItem } from "./workspaceAttention";
import { ConnectedWorkspaceAttentionCard, ConnectedBoardAttentionStatus } from "./WorkspaceAttentionCard";
import { nativePreviewAllowsCommand, NATIVE_PREVIEW_READ_ONLY_MESSAGE } from "../../lib/nativePreview";
import { highlightFeedbackSelection, resolveFeedbackSelectionOrigin, RETURN_FEEDBACK_SELECTION_EVENT, type FeedbackSelectionReturn } from "../../lib/agentFeedbackNavigation";
import { loadWorkspaceGitlabMergeRequests, invalidateWorkspaceGitlabMergeRequests } from "./gitlabMergeRequestDiscovery";
import { invalidateRepositoryReview } from "./repositoryReviewCache";
import { WorkspaceMemoryCache } from "./workspaceMemoryCache";
import { clearPlanningWorkspaceCache } from "./planningWorkspaceCache";
import {
  lazy,
  Suspense,
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { snapCenterToCursor } from "@dnd-kit/modifiers";
import { Button, Checkbox, Input, Label, SearchField } from "react-aria-components";
import {
  defaultWorkspaceClient,
  type AgentProvider,
  type AgentRunResult,
  type AgentSessionList,
  type CloneRepositoryRequest,
  type CloneRepositoryResult,
  type GraphIndexResult,
  type GitlabMergeRequest,
  type GitlabMergeRequestInbox,
  type GitlabReview,
  type GitlabReviewTarget,
  type MaterializedWorktree,
  type RemoveWorkspaceResult,
  type WorkspaceRemovalPreflight,
  type RepositoryCatalog,
  type RepositorySummary,
  type SetupSnapshot,
  type TerminalProvider,
  type WorkspaceAgentEvidence,
  type WorkspaceGraphManifest,
  type WorkspaceMaterialization,
  type WorkspacePreflight,
  type WorkspaceRepositoryAlignmentPreflight,
  type WorkspaceRepositoryAlignmentResult,
  type WorkspaceRepositoryAdditionPreflight,
  type WorkspaceRepositoryAdditionResult,
  type WorkspaceRepositoryRemovalResult,
  type WorkspaceRepositorySyncResult,
  type WorkspaceClient,
  type WorkspaceChangeRequestDraft,
  WorkspaceClientError,
  type WorkspaceCliLaunchResult,
  type WorkspaceProvider,
  type WorkspaceView,
} from "../../lib/wtsClient";
import { useTheme } from "../../theme";
import { useVisiblePolling } from "../../lib/useVisiblePolling";
import { useWorkspaceGitlabDiscussions } from "./gitlabDiscussions";
import { reviewSession } from "./workingChangesState";
import {
  ReviewAttentionStrip,
  ReviewHomePanel,
  unreadHumanThreads,
  useSavedCodeReview,
  type ReviewThreadSummary,
} from "./ReviewHomePanel";
import { SelectMenu } from "../../components/SelectMenu";
import { SetupSheet } from "./SetupSheet";
import { VerificationPanel, type VerificationAttentionSelection } from "./VerificationPanel";
import { AgentSessionsPanel } from "./AgentSessionsPanel";
import { TimeReviewScheduler } from "./TimeReviewScheduler";
import { AgentStatePrototype } from "./AgentStatePrototype";
import { WorkspaceWorkItemsPanel } from "./WorkspaceWorkItemsPanel";
import { OpenWorkspaceLauncher } from "./OpenWorkspaceLauncher";
import { Glyph } from "./Glyph";
import { HowToGuide } from "./GuideDialog";
import { ToastStack, type NoticeToast } from "./ToastStack";
import {
  AssignedReviewCard,
  DraggableWorkspaceCard,
  loadWorkspaceBoardOrder,
  placeWorkspaceOnBoard,
  reconcileWorkspaceBoardOrder,
  saveWorkspaceBoardOrder,
  workspaceBoardPosition,
  workspacePlacementNeighbor,
  type WorkspaceBoardOrder,
  type WorkspaceBoardPlacement,
  WorkspaceActionDropTarget,
  WorkspaceLaneDropTarget,
} from "./WorkspaceBoardDnd";
import { WorkspaceRemovalDialog } from "./WorkspaceRemovalDialog";
import { RecoveryCopyButton } from "./RecoveryCopyButton";
import { canAssertDestructiveWorkspaceRemoval } from "./workspaceRemoval";
import { WorkspaceChangeRequestDialog } from "./WorkspaceChangeRequestDialog";
import { CommandPalette } from "./CommandPalette";
import { MyReviewsScreen, useGithubReviewInbox } from "./MyReviewsScreen";
import { AppUpdateScreen, useAppUpdate } from "./AppUpdateScreen";
import {
  resolveWorkspaceCardAction,
  useWorkspaceCardClickPreference,
} from "./workspaceCardPreference";
import { sendDesktopNotification } from "./desktopNotifications";
import { loadTimeReviewSchedule } from "./timeReviewSchedule";
import {
  laneForWorkflowState,
  gitlabReviewForWorkspace,
  gitlabReviewTargetForWorkspace,
  markWorkspaceWorkflowSignalHandled,
  suggestedWorkflowState,
  suggestedWorkflowStateForGitlabReview,
  suggestedWorkflowStateForMergeRequests,
  workflowStateForLane,
  workspaceWorkflowSignalHandled,
} from "./workspaceWorkflow";
import {
  markWorkspaceNotificationSent,
  notificationForWorkspaceAgent,
  notificationForWorkspaceVerification,
  workspaceNotificationWasSent,
} from "./workspaceNotifications";
import {
  claimWorkspaceAutomation,
  loadWorkspaceAutomation,
  runWorkspaceCompletionAutomation,
  workspaceCompletionIsRecent,
} from "./workspaceAutomation";
import styles from "./LocalWorkspace.module.css";
import { type Lane, type Provider, type Workspace } from "./workspaceTypes";
import {
  type RepositoryCloneHandle,
  type DeferredWorkspaceCreation,
  repositoryEvidenceKey,
  type RepositoryForgeTarget,
  repositoryForgeTarget,
  forgeDisplayName,
  newIdempotencyKey,
  providerToRequest,
  providerMarks,
  type ReviewWorkspaceSeed,
  type DeferredCloneRequest,
} from "./workspaceCreation";
import { InfoTooltip } from "./InfoTooltip";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";
export type { Lane, Workspace } from "./workspaceTypes";
export type { InfoTooltipProps } from "./InfoTooltip";
export { InfoTooltip } from "./InfoTooltip";
export type { IssueRepositoryUpstream } from "./workspaceCreation";
export { repositoryUpstreamsFromIssueContent } from "./workspaceCreation";
export type { NoticeToast };

const RepositoryReviewScreen = lazy(() =>
  import("./RepositoryReviewScreen").then((module) => ({
    default: module.RepositoryReviewScreen,
  })),
);

const PlanningDocumentsPanel = lazy(() =>
  import("./PlanningDocumentsPanel").then((module) => ({
    default: module.PlanningDocumentsPanel,
  })),
);
const WORKSPACE_LANE_STORAGE_KEY = "wts.workspace-lanes.v1";
const WORKSPACE_LANE_ORDER: Lane[] = [
  "planned",
  "attention",
  "active",
  "suspended",
];

const workspaceDropCollision: CollisionDetection = (args) => {
  const prioritized = (collisions: ReturnType<typeof pointerWithin>) => {
    if (
      args.pointerCoordinates &&
      collisions.some((collision) => collision.id === args.active.id)
    ) {
      return collisions.filter((collision) => collision.id === args.active.id);
    }
    const candidates = collisions.filter(
      (collision) => collision.id !== args.active.id,
    );
    for (const type of ["action", "card", "column"] as const) {
      const matches = candidates.filter(
        (collision) =>
          collision.data?.droppableContainer.data.current?.type === type,
      );
      if (matches.length) return matches;
    }
    return candidates;
  };
  const pointerTargets = pointerWithin(args);
  if (pointerTargets.length) return prioritized(pointerTargets);
  return prioritized(rectIntersection(args));
};

const workspaceBoardKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { active, currentCoordinates, context },
) => {
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
    return undefined;
  }
  const activeRect = context.droppableRects.get(active);
  if (!activeRect) return undefined;
  const origin = {
    x: activeRect.left + activeRect.width / 2,
    y: activeRect.top + activeRect.height / 2,
  };
  const vertical = event.code === "ArrowUp" || event.code === "ArrowDown";
  const forward = event.code === "ArrowDown" || event.code === "ArrowRight";
  const candidates = context.droppableContainers
    .getEnabled()
    .filter((container) => container.id !== active)
    .map((container) => ({
      container,
      rect: context.droppableRects.get(container.id),
    }))
    .filter(
      (candidate): candidate is typeof candidate & { rect: NonNullable<typeof candidate.rect> } =>
        Boolean(candidate.rect && candidate.container.data.current?.type === "card"),
    )
    .map(({ rect }) => ({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    }))
    .filter((point) => {
      const delta = vertical ? point.y - origin.y : point.x - origin.x;
      return forward ? delta > 0 : delta < 0;
    })
    .sort((left, right) => {
      const leftPrimary = Math.abs(
        vertical ? left.y - origin.y : left.x - origin.x,
      );
      const rightPrimary = Math.abs(
        vertical ? right.y - origin.y : right.x - origin.x,
      );
      const leftCross = Math.abs(
        vertical ? left.x - origin.x : left.y - origin.y,
      );
      const rightCross = Math.abs(
        vertical ? right.x - origin.x : right.y - origin.y,
      );
      return leftPrimary - rightPrimary || leftCross - rightCross;
    });
  const target = candidates[0];
  if (!target) return undefined;
  return {
    x: currentCoordinates.x + target.x - origin.x,
    y: currentCoordinates.y + target.y - origin.y,
  };
};

function readSavedWorkspaceLane(workspaceId: string): Lane | undefined {
  try {
    const value = JSON.parse(
      localStorage.getItem(WORKSPACE_LANE_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    return value[workspaceId] === "planned" ||
      value[workspaceId] === "active" ||
      value[workspaceId] === "attention" ||
      value[workspaceId] === "suspended"
      ? value[workspaceId]
      : undefined;
  } catch {
    return undefined;
  }
}

function saveWorkspaceLane(workspaceId: string, lane: Lane) {
  try {
    const current = JSON.parse(
      localStorage.getItem(WORKSPACE_LANE_STORAGE_KEY) ?? "{}",
    ) as Record<string, unknown>;
    localStorage.setItem(
      WORKSPACE_LANE_STORAGE_KEY,
      JSON.stringify({ ...current, [workspaceId]: lane }),
    );
  } catch {
    // The board still updates for this session when storage is unavailable.
  }
}

export function resolveWorkspaceDropTarget(
  target: string,
): { type: "move"; lane: Lane } | { type: "delete" } | null {
  if (target === "action:delete") return { type: "delete" };
  if (target === "action:archive") return { type: "move", lane: "suspended" };
  if (!target.startsWith("lane:")) return null;
  const lane = target.slice("lane:".length);
  return lane === "planned" ||
    lane === "active" ||
    lane === "attention" ||
    lane === "suspended"
    ? { type: "move", lane }
    : null;
}
type WorkbenchTab = "overview" | "planning" | "changes" | "verification";
type Filter = "all" | Lane;
type RegistryState = "loading" | "ready" | "error";
type DeepLinkState = "idle" | "loading" | "ready" | "error";

interface RepositoryCloneRecord extends RepositoryCloneHandle {
  status: "cloning" | "ready" | "error";
  result?: CloneRepositoryResult;
  error?: string;
}

function workspaceCreationLane(task: DeferredWorkspaceCreation): Lane {
  if (task.status === "ready") return "planned";
  if (task.status === "error") return "attention";
  return "active";
}

function WorkspaceCreationTaskCard({
  task,
  onContinue,
}: {
  task: DeferredWorkspaceCreation;
  onContinue: () => void;
}) {
  const ready = task.status === "ready";
  const failed = task.status === "error";
  return (
    <article
      className={styles.workspaceCreationTaskCard}
      data-status={task.status}
      data-ui={`spaces.creation.${task.id}`}
      data-ui-label={`Workspace creation ${task.repositoryLabel}`}
    >
      <header>
        <span><Glyph name={failed ? "warning" : ready ? "check" : "refresh"} size={14} /></span>
        <strong>{task.repositoryLabel}</strong>
        <small>{failed ? "Needs review" : ready ? "Ready" : "Git clone"}</small>
      </header>
      <h3>{task.title}</h3>
      <p>{task.message}</p>
      <footer>
        <span>Workspace setup</span>
        <button disabled={task.status === "cloning"} onClick={onContinue} type="button">
          {failed ? "Review clone" : ready ? "Continue setup" : "Clone is active"}
        </button>
      </footer>
    </article>
  );
}
type WorkspaceActionState =
  | "idle"
  | "checking"
  | "ready"
  | "blocked"
  | "materializing"
  | "materialized"
  | "opening"
  | "error";
type WorkspaceCommandState =
  | "idle"
  | "refreshing"
  | "reindexing"
  | "syncing"
  | "aligning"
  | "recoveringSetup"
  | "removing";

export interface WorkspaceAgentSnapshot {
  workspaceId: string;
  provider: AgentProvider | "copilot";
  state: "working" | "idle" | "attention";
  headline: string;
  activity: string;
  latestUpdate?: string;
  updateKind?: "progress" | "completion";
  needsInput?: "question" | "access";
  lastEventAtUnixMs: number;
  observedLocally: boolean;
}

const workspaceMaterializationCaches = new WeakMap<
  WorkspaceClient,
  WorkspaceMemoryCache<WorkspaceMaterialization | null>
>();

function materializationCacheFor(
  client: WorkspaceClient,
): WorkspaceMemoryCache<WorkspaceMaterialization | null> {
  const existing = workspaceMaterializationCaches.get(client);
  if (existing) return existing;
  const created = new WorkspaceMemoryCache<WorkspaceMaterialization | null>();
  workspaceMaterializationCaches.set(client, created);
  return created;
}

const workspaceNavigationCaches = new WeakMap<WorkspaceClient, WorkspaceMemoryCache<{
  tab: WorkbenchTab;
  repositoryId: string;
}>>();

const workspaceScrollCaches = new WeakMap<WorkspaceClient, WorkspaceMemoryCache<{ top: number; left: number }>>();

function scrollCacheFor(client: WorkspaceClient) {
  let cache = workspaceScrollCaches.get(client);
  if (!cache) {
    cache = new WorkspaceMemoryCache<{ top: number; left: number }>(96);
    workspaceScrollCaches.set(client, cache);
  }
  return cache;
}

function navigationCacheFor(client: WorkspaceClient) {
  let cache = workspaceNavigationCaches.get(client);
  if (!cache) {
    cache = new WorkspaceMemoryCache<{ tab: WorkbenchTab; repositoryId: string }>();
    workspaceNavigationCaches.set(client, cache);
  }
  return cache;
}

function repositoryCatalogIdentity(repository: RepositorySummary): string {
  const origin = repository.originUrl?.trim();
  if (!origin) return repository.checkoutLeaf;
  let path = "";
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(origin)) {
      path = new URL(origin).pathname;
    } else {
      path = origin.match(/^(?:[^@/:\\]+@)?[^/:\\]+:(.+)$/)?.[1] ?? "";
    }
  } catch {
    return repository.checkoutLeaf;
  }
  const project = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return project.includes("/") ? project : repository.checkoutLeaf;
}

const providerFromView: Record<WorkspaceProvider, Provider> = {
  codex: "Codex",
  openCode: "OpenCode",
  hermes: "Hermes",
  vsCode: "VS Code",
  copilot: "Copilot",
};

function preferredAgentProvider(provider: Provider): AgentProvider | null {
  switch (provider) {
    case "Codex":
      return "codex";
    case "OpenCode":
      return "openCode";
    case "Hermes":
      return "hermes";
    case "Copilot":
      return "copilot";
    case "VS Code":
      return null;
  }
}

function preferredTerminalProvider(
  integrations?: SetupSnapshot["integrations"],
): TerminalProvider {
  const warp = integrations?.find((item) => item.id === "warp");
  return warp?.installation === "detected" && warp.status !== "error"
    ? "warp"
    : "terminal";
}

function workspaceKey(view: WorkspaceView) {
  switch (view.intent.type) {
    case "jira":
      return view.intent.issueKey;
    case "openProject":
      return view.intent.displayId;
    case "repositorySet":
      return view.intent.label;
  }
}

function workspaceKind(view: WorkspaceView): Workspace["kind"] {
  switch (view.intent.type) {
    case "jira":
      return "Jira";
    case "openProject":
      return "OpenProject";
    case "repositorySet":
      return "Repositories";
  }
}

function relativeUpdate(unixMs: number) {
  const elapsed = Math.max(0, Date.now() - unixMs);
  if (elapsed < 60_000) return "Saved just now";
  if (elapsed < 3_600_000) {
    return `Saved ${Math.max(1, Math.floor(elapsed / 60_000))} min ago`;
  }
  return `Saved ${new Date(unixMs).toLocaleDateString()}`;
}

export const agentProviderLabels: Record<AgentProvider | "copilot", string> = {
  codex: "Codex",
  copilot: "GitHub Copilot",
  openCode: "OpenCode",
  hermes: "Hermes",
};

const liveAgentActivityLabels = {
  thinking: "Reviews the task",
  usingTools: "Uses a tool",
  editing: "Edits files",
  runningCommand: "Runs a command",
  searching: "Searches",
  delegating: "Uses subagents",
} as const;

function readableAgentUpdate(value: string) {
  return value
    .replace(/\[([^\]\n]+)\]\([^\n)]*\)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");
}

function buildWorkspaceAgentSnapshots(list: AgentSessionList) {
  const snapshots = new Map<string, WorkspaceAgentSnapshot>();
  const snapshotPriority = (snapshot: WorkspaceAgentSnapshot) => {
    if (snapshot.needsInput) return 5;
    if (snapshot.state === "working") return 4;
    if (snapshot.state === "attention") return 3;
    if (snapshot.updateKind === "completion") return 2;
    return 1;
  };
  const keepLatest = (snapshot: WorkspaceAgentSnapshot) => {
    const current = snapshots.get(snapshot.workspaceId);
    const lastEventAtUnixMs = Math.max(
      current?.lastEventAtUnixMs ?? 0,
      snapshot.lastEventAtUnixMs,
    );
    if (
      !current ||
      snapshotPriority(snapshot) > snapshotPriority(current) ||
      (snapshotPriority(snapshot) === snapshotPriority(current) &&
        snapshot.lastEventAtUnixMs > current.lastEventAtUnixMs)
    ) {
      snapshots.set(snapshot.workspaceId, { ...snapshot, lastEventAtUnixMs });
    } else if (lastEventAtUnixMs !== current.lastEventAtUnixMs) {
      snapshots.set(snapshot.workspaceId, { ...current, lastEventAtUnixMs });
    }
  };

  for (const session of list.sessions) {
    const provider = agentProviderLabels[session.provider];
    const needsInput = session.needsInput;
    const active =
      !needsInput && ["launching", "running"].includes(session.status);
    const attention =
      Boolean(needsInput) ||
      ["stopping", "failed", "interrupted"].includes(session.status);
    const completed = ["completed", "handoffAccepted"].includes(
      session.status,
    );
    const activity = needsInput
      ? needsInput.detail
      : session.status === "launching"
        ? "WTS starts the agent"
        : session.status === "running"
          ? `${session.category === "uncategorized" ? "Agent" : session.category} session is active`
          : completed
            ? "Agent work is ready for review"
          : session.status === "stopping"
            ? "WTS stops the agent"
            : "Review the session";
    keepLatest({
      workspaceId: session.workspaceId,
      provider: session.provider,
      state: active ? "working" : attention ? "attention" : "idle",
      headline: active
        ? `${provider} is active`
        : needsInput?.kind === "question"
          ? `${provider} has a question`
          : needsInput?.kind === "access"
            ? `${provider} needs access`
        : attention
          ? `${provider} needs attention`
          : completed
            ? `${provider} finished the task`
            : `${provider} is idle`,
      activity,
      ...(completed ? { updateKind: "completion" as const } : {}),
      ...(needsInput ? { needsInput: needsInput.kind } : {}),
      lastEventAtUnixMs: session.lastHeartbeatAtUnixMs,
      observedLocally: false,
    });
  }

  for (const session of list.observedSessions ?? []) {
    if (
      session.status !== "working" &&
      session.status !== "idle" &&
      session.status !== "interrupted" &&
      session.status !== "stale"
    ) {
      continue;
    }
    const needsInput = session.needsInput;
    const working = session.status === "working" && !needsInput;
    const attention =
      Boolean(needsInput) ||
      session.status === "interrupted" ||
      session.status === "stale";
    keepLatest({
      workspaceId: session.workspaceId,
      provider: session.provider,
      state: working ? "working" : attention ? "attention" : "idle",
      headline: working
        ? `${agentProviderLabels[session.provider]} is working`
        : needsInput?.kind === "question"
          ? `${agentProviderLabels[session.provider]} has a question`
          : needsInput?.kind === "access"
            ? `${agentProviderLabels[session.provider]} needs access`
        : attention
          ? `${agentProviderLabels[session.provider]} needs attention`
        : `${agentProviderLabels[session.provider]} is open in VS Code`,
      activity: working
        ? session.activity === null
          ? "Works in the workspace"
          : liveAgentActivityLabels[session.activity]
        : needsInput
          ? needsInput.detail
        : attention
          ? "Review the interrupted agent session"
          : "Last task finished",
      ...(session.latestUpdate === undefined || session.updateKind === undefined
        ? {}
        : {
            latestUpdate: readableAgentUpdate(session.latestUpdate),
            updateKind: session.updateKind,
          }),
      ...(needsInput ? { needsInput: needsInput.kind } : {}),
      lastEventAtUnixMs: session.lastEventAtUnixMs,
      observedLocally: true,
    });
  }

  return snapshots;
}

function workspaceOverviewLane(
  workspace: Workspace,
  _agent: WorkspaceAgentSnapshot | undefined,
): Lane {
  return workspace.lane;
}

function worktreeCount(count: number) {
  return `${count} ${count === 1 ? "worktree" : "worktrees"}`;
}

function compareWorkspaceRecency(left: Workspace, right: Workspace) {
  return (
    right.updatedAtUnixMs - left.updatedAtUnixMs ||
    left.id.localeCompare(right.id)
  );
}

function orderWorkspacesByBoardActivity(
  workspaces: readonly Workspace[],
  workspaceAgents: ReadonlyMap<string, WorkspaceAgentSnapshot>,
) {
  const durableOrder = [...workspaces].sort((left, right) => {
    const lanePosition =
      WORKSPACE_LANE_ORDER.indexOf(left.lane) -
      WORKSPACE_LANE_ORDER.indexOf(right.lane);
    if (lanePosition !== 0) return lanePosition;
    if (
      left.workflowPlacementRank !== undefined &&
      right.workflowPlacementRank !== undefined
    ) {
      const rank = left.workflowPlacementRank - right.workflowPlacementRank;
      if (rank !== 0) return rank;
    }
    return compareWorkspaceRecency(left, right);
  });

  for (const lane of WORKSPACE_LANE_ORDER) {
    const automaticPositions: number[] = [];
    const automaticWorkspaces: Workspace[] = [];
    durableOrder.forEach((workspace, index) => {
      if (
        workspace.lane !== lane ||
        workspace.workflowPlacementMode === "pinned"
      ) {
        return;
      }
      automaticPositions.push(index);
      automaticWorkspaces.push(workspace);
    });
    automaticWorkspaces.sort((left, right) => {
      const activityRecency =
        (workspaceAgents.get(right.id)?.lastEventAtUnixMs ??
          right.updatedAtUnixMs) -
        (workspaceAgents.get(left.id)?.lastEventAtUnixMs ??
          left.updatedAtUnixMs);
      return activityRecency || compareWorkspaceRecency(left, right);
    });
    automaticPositions.forEach((position, index) => {
      durableOrder[position] = automaticWorkspaces[index]!;
    });
  }

  return durableOrder;
}

function workspaceCommandSearchFields(workspace: Workspace) {
  const pathLeaf = workspace.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return [
    workspace.title,
    workspace.key,
    pathLeaf,
    ...workspace.repositoryPlans.map((repository) => repository.label),
  ].map((value) => value.trim().toLocaleLowerCase());
}

function workspaceCommandMatchScore(workspace: Workspace, query: string) {
  const fields = workspaceCommandSearchFields(workspace);
  if (fields.some((field) => field === query)) return 0;
  if (fields.some((field) => field.startsWith(query))) return 1;
  if (fields.some((field) => field.includes(query))) return 2;
  const terms = query.split(/\s+/).filter(Boolean);
  const searchable = fields.join(" ");
  return terms.length > 1 && terms.every((term) => searchable.includes(term))
    ? 3
    : null;
}

function workspaceCommandDescription(workspace: Workspace) {
  const repositories = workspace.repositoryPlans
    .map((repository) => repository.label)
    .join(", ");
  const pathLeaf = workspace.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  return [workspace.key, repositories || pathLeaf].filter(Boolean).join(" · ");
}

function workspaceFromView(view: WorkspaceView): Workspace {
  const key = workspaceKey(view);
  const lifecycle = view.lifecycle;
  const isMaterialized = lifecycle.materializationState === "materialized";
  const legacyLane =
    readSavedWorkspaceLane(view.workspaceId) ??
    (view as { lane?: Lane }).lane ??
    (isMaterialized ? "planned" : "attention");
  const workflowState =
    view.workflow?.state ?? workflowStateForLane(legacyLane);
  const summary = isMaterialized
    ? `Last known · ${worktreeCount(lifecycle.worktreeCount)} created`
    : lifecycle.materializationState === "needsAttention"
      ? "Last check found local state to review"
      : lifecycle.materializationState === "unknown"
        ? "Local state has not been observed yet"
        : "Plan saved · worktree setup is waiting";
  return {
    id: view.workspaceId,
    intent: view.intent,
    key,
    kind: workspaceKind(view),
    title: view.displayName ?? view.title,
    lane: laneForWorkflowState(workflowState),
    workflowState,
    workflowRevision: view.workflow?.revision ?? 0,
    workflowUpdatedAtUnixMs:
      view.workflow?.updatedAtUnixMs ?? view.updatedAtUnixMs,
    workflowPersisted: view.workflow !== undefined,
    workflowPlacementMode: view.workflow?.placement?.mode,
    workflowPlacementRank: view.workflow?.placement?.rank,
    lifecycleState: lifecycle.materializationState,
    knownWorktreeCount: lifecycle.worktreeCount,
    observedAtUnixMs: lifecycle.observedAtUnixMs,
    provider: providerFromView[view.preferredProvider],
    repos: view.repositories.length,
    repositoryPlans: view.repositories.map((repository) => ({
      ...(repository.repositoryId === undefined
        ? {}
        : { repositoryId: repository.repositoryId }),
      label: repository.label,
      baseRef: repository.baseRef,
      worktreeLeaf: repository.worktreeLeaf,
    })),
    ...(view.runtime === undefined ? {} : { runtime: view.runtime }),
    ...(view.planning === undefined ? {} : { planning: view.planning }),
    observedWorkItems: view.observedWorkItems ?? [],
    path: view.workspaceDisplayPath,
    updated: relativeUpdate(view.updatedAtUnixMs),
    updatedAtUnixMs: view.updatedAtUnixMs,
    summary,
  };
}

const laneDetails: Record<
  Lane,
  {
    label: string;
    description: string;
    emptyTitle: string;
    emptyMessage: string;
    tone: string;
  }
> = {
  planned: {
    label: "Ready",
    description: "Work that can start",
    emptyTitle: "No ready workspaces",
    emptyMessage: "New workspace plans appear here.",
    tone: "neutral",
  },
  active: {
    label: "Active",
    description: "Work in progress",
    emptyTitle: "No active workspaces",
    emptyMessage: "Agent work appears here while it is active.",
    tone: "blue",
  },
  attention: {
    label: "Review",
    description: "Work that needs your review",
    emptyTitle: "No workspaces need review",
    emptyMessage: "Finished work and decisions appear here.",
    tone: "amber",
  },
  suspended: {
    label: "Parked",
    description: "Paused work",
    emptyTitle: "No parked workspaces",
    emptyMessage: "Move paused workspaces here.",
    tone: "gray",
  },
};

export function StateDot({ state }: { state: Lane }) {
  return (
    <span className={styles.stateDot} data-state={state} aria-hidden="true" />
  );
}

function isEditableShortcutTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.matches("input, textarea, select, [contenteditable='true']")
  );
}

type HistoryNavigationTarget =
  | { view: "board" }
  | { view: "time" }
  | { view: "reviews" }
  | { view: "workbench"; workspaceId: string; tab: WorkbenchTab };

function historyNavigationTarget(
  pathname: string,
): HistoryNavigationTarget | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/" || path === "/sessions") return { view: "board" };
  if (path === "/time") return { view: "time" };
  if (path === "/reviews") return { view: "reviews" };

  const match = path.match(
    /^\/sessions\/([^/]+)(?:\/(overview|planning|changes|verification|agent|cli))?$/,
  );
  if (!match) return null;

  try {
    return {
      view: "workbench",
      workspaceId: decodeURIComponent(match[1]!),
      tab:
        match[2] === "planning"
          ? "planning"
          : match[2] === "changes"
          ? "changes"
          : match[2] === "verification"
            ? "verification"
            : "overview",
    };
  } catch {
    return null;
  }
}

function pushNavigationPath(path: string) {
  if (globalThis.location?.pathname === path) return;
  globalThis.history?.pushState(null, "", path);
}

const HISTORY_SWIPE_THRESHOLD_PX = 140;
const HISTORY_TOUCH_THRESHOLD_PX = 96;
const HISTORY_SWIPE_SEQUENCE_GAP_MS = 180;
const HISTORY_SWIPE_COOLDOWN_MS = 650;
const HISTORY_SWIPE_EDGE_PX = 72;
const HISTORY_SWIPE_AXIS_RATIO = 1.75;

function historySwipeBlockedTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [contenteditable="true"], [role="textbox"], [role="slider"], [data-history-swipe-block]',
    ),
  );
}

function horizontalScrollConsumesSwipe(
  target: EventTarget | null,
  deltaX: number,
) {
  let element = target instanceof HTMLElement ? target : null;
  while (element && element !== document.body) {
    const hasHorizontalOverflow = element.scrollWidth > element.clientWidth;
    if (
      hasHorizontalOverflow &&
      ((deltaX < 0 && element.scrollLeft > 0) ||
        (deltaX > 0 &&
          element.scrollLeft + element.clientWidth < element.scrollWidth))
    ) {
      return true;
    }
    element = element.parentElement;
  }
  return false;
}

function AddWorkspaceRepositoryDialog({
  open,
  onOpenChange,
  onComplete,
  client,
  workspace,
  repositoryCatalog,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (result: WorkspaceRepositoryAdditionResult) => void;
  client: WorkspaceClient;
  workspace: Workspace;
  repositoryCatalog: RepositoryCatalog | null;
}) {
  const [clonedRepositories, setClonedRepositories] = useState<RepositoryCatalog["repositories"]>([]);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const availableRepositories = useMemo(() => {
    const currentIds = new Set(
      workspace.repositoryPlans.flatMap((repository) =>
        repository.repositoryId ? [repository.repositoryId] : [],
      ),
    );
    const currentLabels = new Set(
      workspace.repositoryPlans.map((repository) => repository.label.toLowerCase()),
    );
    const catalog = repositoryCatalog?.repositories ?? [];
    const catalogIds = new Set(catalog.map((repository) => repository.id));
    return [
      ...catalog,
      ...clonedRepositories.filter((repository) => !catalogIds.has(repository.id)),
    ].filter(
      (repository) =>
        !currentIds.has(repository.id) &&
        !currentLabels.has(repository.label.toLowerCase()),
    );
  }, [repositoryCatalog, clonedRepositories, workspace.repositoryPlans]);
  const [repositoryId, setRepositoryId] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [preflight, setPreflight] =
    useState<WorkspaceRepositoryAdditionPreflight | null>(null);
  const [state, setState] = useState<"idle" | "reviewing" | "ready" | "adding">("idle");
  const [error, setError] = useState("");
  const selectedRepository = availableRepositories.find(
    (repository) => repository.id === repositoryId,
  );

  useEffect(() => {
    if (!open) return;
    setRepositoryId((current) => {
      const kept = availableRepositories.find((repository) => repository.id === current);
      const repository = kept ?? availableRepositories[0];
      if (!kept) setBaseRef(repository?.defaultBranch.name ?? "");
      return repository?.id ?? "";
    });
    setPreflight(null);
    setState("idle");
    setError("");
  }, [open, availableRepositories]);

  useEffect(() => {
    if (!open) {
      setRemoteUrl("");
      setRepositoryId("");
    }
  }, [open]);

  const cloneFromUrl = async () => {
    const url = remoteUrl.trim();
    if (!url || cloning || state !== "idle") return;
    setCloning(true);
    setError("");
    try {
      const result = await client.cloneRepository({ remoteUrl: url });
      const repository = result.repository;
      setClonedRepositories((current) => [
        ...current.filter((item) => item.id !== repository.id),
        repository,
      ]);
      setRepositoryId(repository.id);
      setBaseRef(result.selectedBaseRef ?? repository.defaultBranch.name);
      setRemoteUrl("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WTS could not clone this repository.");
    } finally {
      setCloning(false);
    }
  };

  const review = async () => {
    if (!repositoryId || !baseRef || state !== "idle") return;
    setState("reviewing");
    setError("");
    try {
      const result = await client.preflightWorkspaceRepositoryAddition(
        workspace.id,
        repositoryId,
        baseRef,
      );
      if (result.workspaceId !== workspace.id || result.repositoryId !== repositoryId) {
        throw new Error("WTS returned a repository review for another workspace.");
      }
      setPreflight(result);
      setState("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WTS could not review this repository.");
      setState("idle");
    }
  };

  const add = async () => {
    if (!preflight || state !== "ready") return;
    setState("adding");
    setError("");
    try {
      const result = await client.addWorkspaceRepository(
        workspace.id,
        preflight.repositoryId,
        preflight.baseRef,
        preflight.effectDigest,
      );
      if (result.workspaceId !== workspace.id) {
        throw new Error("WTS added the repository to another workspace.");
      }
      onComplete(result);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "WTS could not add this repository.");
      setState("ready");
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => state !== "adding" && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          aria-describedby="add-workspace-repository-description"
          className={`${styles.portalSurface} ${styles.createDialog} ${styles.addRepositoryDialog}`}
          data-ui="workspace.add-repository-dialog"
          data-ui-label="Add repository dialog"
        >
          <div className={styles.dialogHeader}>
            <div>
              <span className={styles.dialogEyebrow}>CURRENT WORKSPACE</span>
              <Dialog.Title className={styles.dialogTitle}>
                Add repository to {workspace.key}
              </Dialog.Title>
              <Dialog.Description className={styles.dialogDescription} id="add-workspace-repository-description">
                WTS adds one managed worktree here. Existing work and local changes stay in place.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close add repository" className={styles.iconButton} disabled={state === "adding"}>
              <Glyph name="close" />
            </Dialog.Close>
          </div>
          <div className={styles.dialogBody}>
            <form className={styles.sourceForm} onSubmit={(event) => { event.preventDefault(); void review(); }}>
              <div className={styles.field}>
                <Label>Repository</Label>
                <div className={styles.inputWithIcon}>
                  <Glyph name="folder" size={16} />
                  <SelectMenu
                    aria-label="Repository to add"
                    disabled={availableRepositories.length === 0 || state !== "idle"}
                    onChange={(nextRepositoryId) => {
                      const repository = availableRepositories.find((item) => item.id === nextRepositoryId);
                      setRepositoryId(nextRepositoryId);
                      setBaseRef(repository?.defaultBranch.name ?? "");
                      setPreflight(null);
                      setError("");
                    }}
                    searchable
                    searchPlaceholder="Search repositories"
                    value={repositoryId}
                  >
                    {availableRepositories.length === 0 && <option value="">No repositories available</option>}
                    {availableRepositories.map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repositoryCatalogIdentity(repository)} · {repository.defaultBranch.name} · {repository.checkoutLeaf}
                      </option>
                    ))}
                  </SelectMenu>
                </div>
              </div>
              <div className={styles.field}>
                <Label htmlFor="add-workspace-repository-url">Or clone from URL</Label>
                <div
                  className={styles.inputWithIcon}
                  data-ui="workspace.add-repository-url"
                  data-ui-label="Repository URL"
                >
                  <Glyph name="branch" size={16} />
                  <input
                    aria-label="Repository URL"
                    disabled={cloning || state !== "idle"}
                    id="add-workspace-repository-url"
                    onChange={(event) => setRemoteUrl(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void cloneFromUrl();
                      }
                    }}
                    placeholder="https://gitlab.example.com/group/repo.git"
                    type="url"
                    value={remoteUrl}
                  />
                  <Button
                    className={styles.secondaryButton}
                    isDisabled={!remoteUrl.trim() || cloning || state !== "idle"}
                    onPress={() => void cloneFromUrl()}
                  >
                    {cloning ? "Cloning…" : "Clone"}
                  </Button>
                </div>
              </div>
              {selectedRepository && (
                <dl className={styles.repositoryIdentityReview}>
                  <div><dt>Namespace</dt><dd>{repositoryCatalogIdentity(selectedRepository)}</dd></div>
                  <div><dt>Checkout</dt><dd>{selectedRepository.checkoutLeaf}</dd></div>
                  <div><dt>Selected branch</dt><dd>{baseRef}</dd></div>
                  <div><dt>Remote</dt><dd>{selectedRepository.originUrl ?? "No remote reported"}</dd></div>
                </dl>
              )}
              <div className={styles.field}>
                <Label>Base branch</Label>
                <div className={styles.inputWithIcon}>
                  <Glyph name="branch" size={16} />
                  <SelectMenu
                    aria-label="Base branch"
                    disabled={!selectedRepository || state !== "idle"}
                    onChange={(value) => { setBaseRef(value); setPreflight(null); setError(""); }}
                    value={baseRef}
                  >
                    {(selectedRepository?.availableBranches?.length
                      ? selectedRepository.availableBranches
                      : selectedRepository ? [selectedRepository.defaultBranch] : []
                    ).map((branch) => (
                      <option key={branch.fullRef} value={branch.name}>
                        {branch.name} · {"remote" in branch && branch.remote ? "remote" : "local"} · {branch.commitOid.slice(0, 8)}
                      </option>
                    ))}
                  </SelectMenu>
                </div>
              </div>
              {preflight && (
                <div className={styles.repositoryAdditionReview} role="status">
                  <strong>{preflight.repositoryLabel}</strong>
                  <span>{preflight.resolvedBaseRef}</span>
                  <small>New managed worktree · {preflight.branchName}</small>
                </div>
              )}
              {availableRepositories.length === 0 && <p>No additional local repositories are available. Enter a URL to clone one.</p>}
              {error && <p className={styles.sourceImportMessage} data-error>{error}</p>}
            </form>
          </div>
          <div className={styles.dialogFooter}>
            <span className={styles.dialogFootnote}><Glyph name="check" size={13} /> The workspace ID and existing worktrees do not change.</span>
            <span className={styles.dialogActions}>
              <Dialog.Close className={styles.secondaryButton} disabled={state === "adding"}>Cancel</Dialog.Close>
              {!preflight ? (
                <Button className={styles.primaryButton} isDisabled={!repositoryId || !baseRef || state !== "idle"} onPress={() => void review()}>
                  {state === "reviewing" ? "Reviewing…" : "Review repository"}
                </Button>
              ) : (
                <Button className={styles.primaryButton} isDisabled={state !== "ready"} onPress={() => void add()}>
                  {state === "adding" ? "Adding…" : "Add to workspace"}
                </Button>
              )}
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WorkspaceActionsMenu({
  busy,
  materialized = false,
  onOpenPrimary,
  onOpenWith,
  onRefresh,
  onCreateRevisedCopy,
  onRemove,
}: {
  busy: boolean;
  materialized?: boolean;
  onOpenPrimary?: () => void;
  onOpenWith?: () => void;
  onRefresh: () => void;
  onCreateRevisedCopy: () => void;
  onRemove: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-busy={busy ? "true" : "false"}
          aria-label={
            busy
              ? "Workspace actions, command in progress"
              : "Workspace actions"
          }
          className={`${styles.secondaryButton} ${styles.actionsTrigger}`}
          data-busy={busy || undefined}
          type="button"
        >
          <Glyph name={busy ? "refresh" : "more"} size={15} />
          <span>
            {busy ? "In progress…" : materialized ? "Actions" : "More"}
          </span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className={`${styles.portalSurface} ${styles.menuContent}`}
          data-ui="workspace.actions-menu"
          data-ui-label="Workspace actions menu"
          sideOffset={6}
        >
          <DropdownMenu.Label className={styles.menuLabel}>
            WORKSPACE ACTIONS
          </DropdownMenu.Label>
          {materialized && onOpenPrimary && onOpenWith && (
            <>
              <DropdownMenu.Item
                className={styles.menuItem}
                disabled={busy}
                onSelect={onOpenPrimary}
              >
                <Glyph name="terminal" size={14} />
                Open workspace
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={styles.menuItem}
                disabled={busy}
                onSelect={onOpenWith}
              >
                <Glyph name="chevron" size={14} />
                Open with…
              </DropdownMenu.Item>
              <DropdownMenu.Separator className={styles.menuSeparator} />
            </>
          )}
          <DropdownMenu.Item
            className={styles.menuItem}
            disabled={busy}
            onSelect={onRefresh}
          >
            <Glyph name="refresh" size={14} />
            Refresh status
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={styles.menuItem}
            disabled={busy}
            onSelect={onCreateRevisedCopy}
          >
            <Glyph name="copy" size={14} />
            Create revised workspace…
          </DropdownMenu.Item>
          <DropdownMenu.Separator className={styles.menuSeparator} />
          <DropdownMenu.Item
            className={styles.menuItem}
            data-danger
            disabled={busy}
            onSelect={onRemove}
          >
            <Glyph name="trash" size={14} />
            Remove workspace…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PreparedVerificationBrief({
  draft,
  preferredProviderName,
  onOpen,
  onRetry,
}: {
  draft: {
    prompt: string;
    briefState: "saving" | "ready" | "error";
    briefDisplayPath?: string;
    briefError?: string;
  };
  preferredProviderName: string;
  onOpen: () => void;
  onRetry: () => void;
}) {
  return (
    <section
      aria-labelledby="prepared-verification-brief-title"
      className={styles.preparedVerificationBrief}
      data-ui="verification.handoff"
      data-ui-label="Verification handoff"
      data-state={draft.briefState}
    >
      <span aria-hidden="true" className={styles.preparedVerificationBriefMark}>
        {draft.briefState === "ready"
          ? "✓"
          : draft.briefState === "error"
            ? "!"
            : "…"}
      </span>
      <div className={styles.preparedVerificationBriefCopy}>
        <small>PREPARED HANDOFF</small>
        <h3 id="prepared-verification-brief-title">
          {draft.briefState === "ready"
            ? "Verification brief ready"
            : draft.briefState === "error"
              ? "Verification brief could not be saved"
              : "Saving verification brief…"}
        </h3>
        <p>
          {draft.briefState === "ready"
            ? `WTS.md is saved at ${draft.briefDisplayPath ?? "the workspace root"}. Choose an agent when you are ready to continue.`
            : draft.briefState === "error"
              ? draft.briefError
              : "WTS is saving the workspace-owned brief before an agent can use it."}
        </p>
        <details>
          <summary>Review prepared brief</summary>
          <pre aria-label="Prepared verification brief">{draft.prompt}</pre>
        </details>
      </div>
      <div className={styles.preparedVerificationBriefActions}>
        {draft.briefState === "error" && (
          <button className={styles.secondaryButton} onClick={onRetry} type="button">
            Save again
          </button>
        )}
        <button
          className={styles.primaryButton}
          disabled={draft.briefState !== "ready"}
          onClick={onOpen}
          type="button"
        >
          Open {preferredProviderName} with brief
        </button>
      </div>
    </section>
  );
}

function RepositoryAlignmentDialog({
  open,
  onOpenChange,
  preflight,
  state,
  error,
  onRetry,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preflight: WorkspaceRepositoryAlignmentPreflight | null;
  state: "loading" | "ready" | "aligning" | "error";
  error: string;
  onRetry: () => void;
  onConfirm: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    setConfirmed(false);
  }, [preflight?.effectDigest, open]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && state === "aligning") return;
        onOpenChange(nextOpen);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          aria-describedby="repository-alignment-description"
          className={`${styles.portalSurface} ${styles.removalDialog}`}
          data-ui="repository-alignment.dialog"
          data-ui-label="Repository alignment dialog"
        >
          <header className={styles.removalHeader}>
            <span className={styles.removalIcon}>
              <Glyph name="branch" size={18} />
            </span>
            <div>
              <span className={styles.dialogEyebrow}>HISTORY CHANGE</span>
              <Dialog.Title>
                {preflight
                  ? `Align ${preflight.repositoryLabel} with ${preflight.remoteFullRef.replace("refs/remotes/", "")}?`
                  : "Review repository alignment"}
              </Dialog.Title>
              <Dialog.Description id="repository-alignment-description">
                The tracking branch no longer contains the workspace commit.
                WTS cannot use a fast-forward update.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Close alignment dialog"
              className={styles.iconButton}
              disabled={state === "aligning"}
            >
              <Glyph name="close" size={15} />
            </Dialog.Close>
          </header>
          <div className={styles.removalBody}>
            {state === "loading" && (
              <div className={styles.removalLoading} role="status">
                <Glyph name="refresh" size={18} />
                <span>
                  <b>Checking upstream history</b>
                  <small>WTS fetches and compares the trusted commits…</small>
                </span>
              </div>
            )}
            {state === "aligning" && (
              <div className={styles.removalProgress} role="status">
                <Glyph name="refresh" size={16} />
                <span>
                  <b>Preserving the old commit and aligning the worktree</b>
                  <small>WTS rebuilds the graph after Git changes.</small>
                </span>
              </div>
            )}
            {preflight && (
              <>
                <div className={styles.removalWorktrees}>
                  <h3>Reviewed Git effect</h3>
                  <div>
                    <span><b>Current worktree</b></span>
                    <code>{preflight.currentCommitOid}</code>
                  </div>
                  <div>
                    <span><b>Tracking branch</b></span>
                    <code>{preflight.targetCommitOid}</code>
                    <small>{preflight.remoteFullRef}</small>
                  </div>
                  <div>
                    <span><b>Backup reference</b></span>
                    <code>{preflight.backupFullRef}</code>
                  </div>
                </div>
                <Checkbox
                  className={styles.confirmationCheck}
                  isSelected={confirmed}
                  onChange={setConfirmed}
                >
                  <span className={styles.confirmationIndicator}>
                    <Glyph name="check" size={12} />
                  </span>
                  <span>
                    <b>I understand that WTS will change the worktree commit</b>
                    <small>The backup reference keeps the current commit.</small>
                  </span>
                </Checkbox>
              </>
            )}
            {error && (
              <p className={styles.removalError} role="alert">
                <Glyph name="warning" size={14} />
                {error}
              </p>
            )}
          </div>
          <footer className={styles.removalFooter}>
            <span>WTS changes only this clean managed worktree.</span>
            <div>
              {state === "error" && (
                <Button className={styles.secondaryButton} onPress={onRetry}>
                  <Glyph name="refresh" size={14} />
                  Check again
                </Button>
              )}
              <Dialog.Close
                className={styles.secondaryButton}
                disabled={state === "aligning"}
              >
                Cancel
              </Dialog.Close>
              <Button
                className={styles.dangerButton}
                isDisabled={!preflight || !confirmed || state !== "ready"}
                onPress={onConfirm}
              >
                {state === "aligning" ? "Aligning…" : "Align and rebuild graph"}
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function BaseReferenceRecovery({
  repository,
  requestedBaseRef,
  busy,
  onFetchBranches,
  onReviseBase,
}: {
  repository: RepositorySummary | undefined;
  requestedBaseRef: string | undefined;
  busy: boolean;
  onFetchBranches: () => void;
  onReviseBase: (baseRef: string) => void;
}) {
  const branches = useMemo(
    () =>
      [...(repository?.availableBranches ?? [])]
        .filter((branch) => branch.name !== requestedBaseRef)
        .sort(
          (left, right) =>
            Number(right.remote) - Number(left.remote) ||
            left.name.localeCompare(right.name),
        ),
    [repository, requestedBaseRef],
  );
  const [selectedBaseRef, setSelectedBaseRef] = useState("");

  useEffect(() => {
    if (branches.some((branch) => branch.name === selectedBaseRef)) return;
    setSelectedBaseRef(
      branches.find((branch) => branch.remote)?.name ?? branches[0]?.name ?? "",
    );
  }, [branches, selectedBaseRef]);

  return (
    <div className={styles.baseRecovery}>
      <p>
        <code>{requestedBaseRef ?? "The saved base"}</code> is not on the
        current branch list. Refresh the remote refs, or revise this saved plan
        to a branch that exists.
      </p>
      <div className={styles.baseRecoveryControls}>
        <label>
          <span>Existing base</span>
          <SelectMenu
            aria-label={`Replacement base for ${repository?.label ?? "repository"}`}
            disabled={busy || branches.length === 0}
            onChange={setSelectedBaseRef}
            value={selectedBaseRef}
          >
            {branches.length === 0 ? (
              <option value="">Refresh to discover branches</option>
            ) : (
              branches.map((branch) => (
                <option key={branch.fullRef} value={branch.name}>
                  {branch.name}
                  {branch.remote ? " · origin" : " · local"}
                </option>
              ))
            )}
          </SelectMenu>
        </label>
        <InfoTooltip
          content={
            busy
              ? "Workspace operation in progress"
              : repository?.originUrl
                ? "Fetch current branch heads from origin"
                : "This repository has no configured origin URL"
          }
        >
          <Button
            className={styles.repositoryBaseLink}
            isDisabled={busy || !repository?.originUrl}
            onPress={onFetchBranches}
          >
            <b>Refresh branches</b>
            <Glyph name="refresh" size={11} />
          </Button>
        </InfoTooltip>
        <InfoTooltip
          content={
            busy
              ? "Workspace operation in progress"
              : !selectedBaseRef
                ? "Select an existing base branch to revise saved plan"
                : undefined
          }
        >
          <Button
            className={styles.baseRecoveryAction}
            isDisabled={busy || !selectedBaseRef}
            onPress={() => onReviseBase(selectedBaseRef)}
          >
            Revise saved plan
            <Glyph name="arrow" size={11} />
          </Button>
        </InfoTooltip>
      </div>
      <small>
        The original plan, source checkout, and Git remote stay unchanged. The
        revised plan will still create an isolated worktree during setup.
      </small>
    </div>
  );
}

function WorkspaceProvisionPanel({
  workspace,
  state,
  commandBusy,
  preflight,
  materialization,
  repositoryCatalog,
  error,
  errorCode,
  driftDetected,
  onReview,
  onFetchBranches,
  onReviseBase,
  onCreateRevisedCopy,
  onReconcile,
  onMaterialize,
  onReviewRemainingFiles,
  onRecoverSetup,
}: {
  workspace: Workspace;
  state: WorkspaceActionState;
  commandBusy: boolean;
  preflight: WorkspacePreflight | null;
  materialization: WorkspaceMaterialization | null;
  repositoryCatalog: RepositoryCatalog | null;
  error: string;
  errorCode: string;
  driftDetected: boolean;
  onReview: () => void;
  onFetchBranches: (repositoryId: string) => void;
  onReviseBase: (repositoryId: string, baseRef: string) => void;
  onCreateRevisedCopy: () => void;
  onReconcile: () => void;
  onMaterialize: () => void;
  onReviewRemainingFiles: () => void;
  onRecoverSetup: () => void;
}) {
  const isCheckingRecordedMaterialization =
    !materialization &&
    state === "checking" &&
    workspace.lifecycleState === "materialized";

  if (materialization) {
    return (
      <section
        aria-label="Workspace facts"
        className={styles.workspaceReadyBar}
        data-ui="workspace-overview.facts"
        data-ui-label="Workspace facts"
      >
        <div className={styles.workspaceReadyIcon}>
          <Glyph name="branch" size={16} />
        </div>
        <dl className={styles.workspaceReadyFacts}>
          <div>
            <dt>Branch</dt>
            <dd>
              <code>{materialization.branchName}</code>
            </dd>
          </div>
          <div>
            <dt>Repositories</dt>
            <dd>{workspace.repos} resolved</dd>
          </div>
          <div>
            <dt>Worktrees</dt>
            <dd>{materialization.worktrees.length} created</dd>
          </div>
          <div>
            <dt>Graph</dt>
            <dd>
              {materialization.graph.status === "ready"
                ? "Index available"
                : "Not indexed"}
            </dd>
          </div>
        </dl>
      </section>
    );
  }

  if (isCheckingRecordedMaterialization) {
    return (
      <div
        className={styles.workbenchSkeleton}
        aria-label="Loading workspace details"
        role="status"
        aria-busy="true"
        data-testid="workbench-skeleton"
      >
        <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
        <div className={`${styles.skeletonLine} ${styles.skeletonLineLong}`} />
        <div className={`${styles.skeletonLine} ${styles.skeletonLineMedium}`} />
      </div>
    );
  }

  const busy = commandBusy || state === "checking" || state === "materializing";
  const setupRecovery = preflight?.setupRecovery;
  const creationReady = preflight?.ready && !setupRecovery;
  const blocked = preflight && (!preflight.ready || Boolean(setupRecovery));
  const recoveryReadOnly = !nativePreviewAllowsCommand("recover_workspace_setup");
  const cleanupIncomplete = Boolean(error) && (
    errorCode === "generated_workspace_cleanup_incomplete" ||
    errorCode === "materialization_cleanup_incomplete"
  );
  const workspacePathConflict = blocked && preflight.blockers.some((blocker) =>
    blocker.code === "targetConflict" && !blocker.repositoryId && !blocker.repositoryLabel,
  );
  return (
    <section
      className={styles.provisionCard}
      data-ui="workspace-overview.setup"
      data-ui-label="Workspace setup"
      data-state={blocked || error ? "attention" : "pending"}
    >
      <div className={styles.provisionCardIcon}>
        <Glyph
          name={blocked || error ? "warning" : busy ? "refresh" : "branch"}
          size={19}
        />
      </div>
      <div className={styles.provisionCardCopy}>
        <small>
          {driftDetected
            ? "WORKSPACE CHANGES DETECTED"
            : "CREATE LOCAL WORKSPACE"}
        </small>
        <h2>
          {driftDetected
            ? "Register the current Git state"
            : setupRecovery
              ? "Review the files from the failed setup"
              : cleanupIncomplete
              ? "Inspect the remaining workspace files"
              : state === "checking"
                ? "Checking the exact Git effects"
                : state === "materializing"
                  ? `Creating ${workspace.key}`
                  : blocked
                    ? "Resolve the blockers before creating worktrees"
                    : creationReady
                      ? "Review complete · ready to create"
                      : "Turn this saved plan into isolated worktrees"}
        </h2>
        <p>
          {driftDetected
            ? "WTS can safely re-read the managed worktrees, register their current branches, HEAD commits, origins, and upstreams, then rebuild the workspace graph."
            : setupRecovery
              ? "WTS keeps your saved plan. Review the paths below before you clean setup files."
              : cleanupIncomplete
              ? "WTS could not finish cleanup. Inspect the preserved files before you review setup again."
              : state === "checking"
                ? "WTS is resolving local repositories, base commits, branch names, and target paths."
                : state === "materializing"
                  ? "WTS is creating the worktrees transactionally and writing the VS Code workspace."
                  : creationReady
                    ? "Review these exact effects. WTS checks them again before creation."
                    : "WTS will inspect only the configured local repository catalog. Preflight itself does not write to Git."}
        </p>
        {error && (
          <div className={styles.provisionError} role="alert">
            <Glyph name="warning" size={14} />
            {error}
          </div>
        )}
        {!setupRecovery && (cleanupIncomplete || workspacePathConflict) && (
          <div className={styles.branchRecovery}>
            <button className={styles.baseRecoveryAction} disabled={busy} onClick={onReviewRemainingFiles} type="button">
              Review remaining files
              <Glyph name="arrow" size={11} />
            </button>
            <RecoveryCopyButton label="Copy setup path" text={preflight?.workspaceDisplayPath ?? workspace.path} disabled={busy} />
            <small>WTS checks the remaining paths and shows recovery steps. This check does not remove files.</small>
          </div>
        )}
        {setupRecovery && (
          <section className={styles.branchRecovery} aria-label="Setup file recovery" data-ui="workspace-overview.setup-recovery" data-ui-label="Setup file recovery">
            <p>WTS removes only unchanged files from the failed setup and its unchanged worktrees and branches.</p>
            <p>WTS preserves changed files, ignored files, and new commits. Inspect the paths that block cleanup.</p>
            {setupRecovery.blockers.length > 0 && (
              <ul className={styles.blockerList} aria-label="Setup cleanup blockers">
                {setupRecovery.blockers.map((blocker, index) => <li key={`${index}-${blocker}`}>{blocker}</li>)}
              </ul>
            )}
            {recoveryReadOnly && <p role="status">{NATIVE_PREVIEW_READ_ONLY_MESSAGE}</p>}
            <button className={styles.baseRecoveryAction} disabled={busy || !setupRecovery.ready || setupRecovery.blockers.length > 0 || recoveryReadOnly} onClick={onRecoverSetup} type="button">
              Clean setup files
            </button>
            <small>After cleanup, WTS shows a fresh setup review. Select Create workspace only after you review it.</small>
            {setupRecovery.paths.length > 0 && (
              <details>
                <summary>Review {setupRecovery.paths.length} setup path{setupRecovery.paths.length === 1 ? "" : "s"}</summary>
              <ul className={styles.blockerList} aria-label="Setup recovery paths">
                {setupRecovery.paths.map((path) => (
                  <li key={path}>
                    <div className={`${styles.blockerCopy} ${styles.removalRecoveryActions}`}>
                      <code>{path}</code>
                      <RecoveryCopyButton label={`Copy path ${path}`} text={path}>Copy path</RecoveryCopyButton>
                    </div>
                  </li>
                ))}
              </ul>
              </details>
            )}
          </section>
        )}
        {driftDetected && (
          <div className={styles.branchRecovery}>
            <p>
              Repository contents are user-owned. WTS keeps the workspace root,
              generated files, and repository identities protected while
              accepting normal Git evolution.
            </p>
            <button
              className={styles.baseRecoveryAction}
              disabled={busy}
              onClick={onReconcile}
              type="button"
            >
              Register changes &amp; re-index
              <Glyph name="refresh" size={11} />
            </button>
            <small>
              This does not reset, checkout, fetch, pull, or modify repository
              content.
            </small>
          </div>
        )}
        {blocked && (
          <ul className={styles.blockerList}>
            {preflight.blockers.map((blocker, index) => (
              <li key={`${blocker.code}-${index}`}>
                <Glyph name="warning" size={13} />
                <div className={styles.blockerCopy}>
                  <b>{blocker.repositoryLabel ?? "Workspace"}</b>
                  {blocker.message}
                  {blocker.code === "baseReferenceUnavailable" &&
                    blocker.repositoryId && (
                      <BaseReferenceRecovery
                        busy={busy}
                        onFetchBranches={() =>
                          onFetchBranches(blocker.repositoryId!)
                        }
                        onReviseBase={(baseRef) =>
                          onReviseBase(blocker.repositoryId!, baseRef)
                        }
                        repository={repositoryCatalog?.repositories.find(
                          (repository) =>
                            repository.id === blocker.repositoryId,
                        )}
                        requestedBaseRef={blocker.requestedBaseRef}
                      />
                    )}
                  {blocker.code === "branchConflict" && (
                    <div className={styles.branchRecovery}>
                      <p>
                        Existing branch <code>{preflight.branchName}</code>{" "}
                        stays unchanged.
                      </p>
                      <button
                        className={styles.baseRecoveryAction}
                        disabled={busy}
                        onClick={onCreateRevisedCopy}
                        type="button"
                      >
                        Create with a new branch
                        <Glyph name="arrow" size={11} />
                      </button>
                      <small>
                        WTS will prefill a separate plan with the same
                        repositories and bases. Saving it allocates a new
                        workspace branch.
                      </small>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {creationReady && (
          <div
            className={styles.effectTable}
            role="table"
            aria-label="Workspace creation effects"
          >
            <div role="row">
              <span role="columnheader">Repository</span>
              <span role="columnheader">Base commit</span>
              <span role="columnheader">Worktree</span>
            </div>
            {preflight.repositories.map((repository) => (
              <div role="row" key={repository.repositoryId}>
                <b role="cell">{repository.label}</b>
                <code role="cell">
                  {repository.resolvedBaseRef} ·{" "}
                  {repository.baseCommitOid.slice(0, 8)}
                </code>
                <code role="cell">{repository.targetDisplayPath}</code>
              </div>
            ))}
          </div>
        )}
      </div>
      <Button
        className={
          creationReady ? styles.primaryButton : styles.secondaryButton
        }
        onPress={creationReady ? onMaterialize : onReview}
        isDisabled={busy}
      >
        {busy && <Glyph name="refresh" size={14} />}
        {state === "checking"
          ? "Checking…"
          : state === "materializing"
            ? "Creating…"
            : creationReady
              ? "Create workspace"
              : blocked
                ? "Check again"
                : "Review setup"}
      </Button>
    </section>
  );
}

export function suggestedJiraIssueKeyForReview(
  review: Partial<Pick<GitlabReview, "sourceBranch" | "title">>,
): string | undefined {
  const keys = new Set<string>();
  const jiraKey = /[A-Z0-9_]{1,32}-[0-9]{1,16}/g;
  for (const value of [review.title, review.sourceBranch]) {
    if (!value) continue;
    for (const match of value.matchAll(jiraKey)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const previous = value[start - 1];
      const next = value[end];
      if (
        (previous && /[A-Za-z0-9_]/.test(previous)) ||
        (next && /[A-Za-z0-9_]/.test(next))
      ) {
        continue;
      }
      keys.add(match[0]);
    }
  }
  return keys.size === 1 ? [...keys][0] : undefined;
}

function DraftOverviewPanel({
  client,
  workspace,
  actionState,
  commandBusy,
  preflight,
  materialization,
  repositoryCatalog,
  actionError,
  actionErrorCode,
  driftDetected,
  onReview,
  onFetchBranches,
  onReviseBase,
  onCreateRevisedCopy,
  onAddRepositories,
  onRemoveRepository,
  onReconcile,
  onSyncRepository,
  onAlignRepository,
  onMaterialize,
  onReviewChanges,
  onOpenWorkspace,
  onNotice,
  onOpenIntegrations,
  onRefreshWorkspace,
  onReviewRemainingFiles,
  onRecoverSetup,
  gitlabReview,
  onRetryReviewStatus,
  reviewInboxFresh = false,
  reviewInboxLoading = false,
  reviewAttention,
}: {
  client: WorkspaceClient;
  workspace: Workspace;
  actionState: WorkspaceActionState;
  commandBusy: boolean;
  preflight: WorkspacePreflight | null;
  materialization: WorkspaceMaterialization | null;
  repositoryCatalog: RepositoryCatalog | null;
  actionError: string;
  actionErrorCode: string;
  driftDetected: boolean;
  onReview: () => void;
  onFetchBranches: (repositoryId: string) => void;
  onReviseBase: (repositoryId: string, baseRef: string) => void;
  onCreateRevisedCopy: () => void;
  onAddRepositories: () => void;
  onRemoveRepository: (repositoryId: string) => Promise<WorkspaceRepositoryRemovalResult>;
  onReconcile: () => void;
  onSyncRepository: (
    repositoryId: string,
  ) => Promise<WorkspaceRepositorySyncResult>;
  onAlignRepository: (
    repositoryId: string,
    effectDigest: string,
  ) => Promise<WorkspaceRepositoryAlignmentResult>;
  onMaterialize: () => void;
  onReviewChanges: (repositoryId: string) => void;
  onOpenWorkspace: () => void;
  onNotice: (message: string, kind?: "info" | "error") => void;
  onOpenIntegrations?: () => void;
  onRefreshWorkspace: () => void;
  onReviewRemainingFiles: () => void;
  onRecoverSetup: () => void;
  gitlabReview?: GitlabReviewTarget & Partial<GitlabReview>;
  onRetryReviewStatus?: () => void;
  /** True when GitLab answered the review inbox read. A missing MR is then not an error. */
  reviewInboxFresh?: boolean;
  /** True while the first review inbox read waits for GitLab. */
  reviewInboxLoading?: boolean;
  /** Review counts and the next review step. It shows below the MR summary. */
  reviewAttention?: ReactNode;
}) {
  type GitlabInboxView =
    | { state: "loading" }
    | { state: "ready"; inbox: GitlabMergeRequestInbox }
    | { state: "error"; detail: string };
  type GitlabHandoffView = {
    repositoryId: string;
    headCommitOid: string;
    state: "formOpened" | "checking";
  };
  const [openingRepositoryId, setOpeningRepositoryId] = useState<string | null>(null);
  const [syncingRepositoryId, setSyncingRepositoryId] = useState<string | null>(null);
  const [repositoryNotice, setRepositoryNotice] = useState("");
  const [repositoryNoticeError, setRepositoryNoticeError] = useState(false);
  const [changeRequestPublishRepositoryId, setChangeRequestPublishRepositoryId] =
    useState<string | null>(null);
  const [changeRequestBranchName, setChangeRequestBranchName] = useState("");
  const [publishingChangeRequestId, setPublishingChangeRequestId] =
    useState<string | null>(null);
  const [changeRequestProposalRepositoryId, setChangeRequestProposalRepositoryId] =
    useState<string | null>(null);
  const [requestingChangeRequestProposalId, setRequestingChangeRequestProposalId] =
    useState<string | null>(null);
  const [repositoryToRemove, setRepositoryToRemove] = useState<MaterializedWorktree | null>(null);
  const [removingRepositoryId, setRemovingRepositoryId] = useState<string | null>(null);
  const [syncBlockedRepositoryId, setSyncBlockedRepositoryId] = useState<
    string | null
  >(null);
  const removeRepository = async () => {
    if (!repositoryToRemove || removingRepositoryId) return;
    setRemovingRepositoryId(repositoryToRemove.repositoryId);
    setRepositoryNotice("");
    try {
      const result = await onRemoveRepository(repositoryToRemove.repositoryId);
      setRepositoryNotice(`${result.repositoryLabel} was removed from this workspace.`);
      setRepositoryNoticeError(false);
      setRepositoryToRemove(null);
    } catch (cause) {
      setRepositoryNotice(
        cause instanceof Error ? cause.message : "WTS could not remove this repository.",
      );
      setRepositoryNoticeError(true);
    } finally {
      setRemovingRepositoryId(null);
    }
  };
  const [changeRequestDraft, setChangeRequestDraft] =
    useState<WorkspaceChangeRequestDraft | null>(null);
  const [preparingChangeRequestId, setPreparingChangeRequestId] = useState<string | null>(null);
  const [openingChangeRequest, setOpeningChangeRequest] = useState(false);
  const [requestingChangeRequestVerification, setRequestingChangeRequestVerification] = useState(false);
  const [changeRequestError, setChangeRequestError] = useState("");
  const [gitlabInbox, setGitlabInbox] = useState<GitlabInboxView>({
    state: "loading",
  });
  const [gitlabHandoff, setGitlabHandoff] =
    useState<GitlabHandoffView | null>(null);
  const gitlabHandoffRef = useRef(gitlabHandoff);
  gitlabHandoffRef.current = gitlabHandoff;
  const [openingGitlabMergeRequestId, setOpeningGitlabMergeRequestId] =
    useState<string | null>(null);
  const [linkingMergeRequestWorktree, setLinkingMergeRequestWorktree] =
    useState<MaterializedWorktree | null>(null);
  const [mergeRequestHint, setMergeRequestHint] = useState("");
  const [mergeRequestLinkError, setMergeRequestLinkError] = useState("");
  const [openBranchNoteId, setOpenBranchNoteId] = useState<string | null>(null);
  const [linkingMergeRequest, setLinkingMergeRequest] = useState(false);
  const [agentMrHints, setAgentMrHints] = useState<AgentMrLinkProposal[]>([]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void loadAgentSessions(client, workspace.id).then((list: AgentSessionList) => {
        if (!active) return;
        setAgentMrHints([
          ...list.sessions.filter((session) => session.workspaceId === workspace.id),
          ...(list.observedSessions ?? []).filter((session) => session.workspaceId === workspace.id),
        ].sort((left, right) =>
          ("lastEventAtUnixMs" in right ? right.lastEventAtUnixMs : right.lastHeartbeatAtUnixMs)
          - ("lastEventAtUnixMs" in left ? left.lastEventAtUnixMs : left.lastHeartbeatAtUnixMs)
        ).flatMap((session) => session.mrLinkProposals ?? []));
      }, () => { if (active) setAgentMrHints([]); });
    };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [client, workspace.id]);
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const [alignmentRepositoryId, setAlignmentRepositoryId] = useState<string | null>(null);
  const alignmentGeneration = useRef(0);
  const alignmentWorkspaceId = useRef(workspace.id);
  alignmentWorkspaceId.current = workspace.id;
  const [alignmentPreflight, setAlignmentPreflight] =
    useState<WorkspaceRepositoryAlignmentPreflight | null>(null);
  const [alignmentState, setAlignmentState] =
    useState<"loading" | "ready" | "aligning" | "error">("loading");
  const [alignmentError, setAlignmentError] = useState("");
  useEffect(() => {
    alignmentGeneration.current += 1;
    setAlignmentOpen(false);
    setAlignmentRepositoryId(null);
    setAlignmentPreflight(null);
    return () => { alignmentGeneration.current += 1; };
  }, [workspace.id]);

  const reviewRepositoryAlignment = async (repositoryId: string) => {
    if (alignmentWorkspaceId.current !== workspace.id) return;
    const generation = ++alignmentGeneration.current;
    setAlignmentRepositoryId(repositoryId);
    setAlignmentOpen(true);
    setAlignmentState("loading");
    setAlignmentError("");
    setAlignmentPreflight(null);
    try {
      const preflight = await client.preflightWorkspaceRepositoryAlignment(workspace.id, repositoryId);
      if (generation !== alignmentGeneration.current) return;
      if (preflight.workspaceId !== workspace.id || preflight.repositoryId !== repositoryId) {
        throw new Error("WTS returned alignment details for another repository.");
      }
      setAlignmentPreflight(preflight);
      setAlignmentState("ready");
    } catch (cause) {
      if (generation !== alignmentGeneration.current) return;
      setAlignmentError(cause instanceof Error ? cause.message : "WTS could not review repository alignment.");
      setAlignmentState("error");
    }
  };
  const materializedById = new Map(
    materialization?.worktrees.map((worktree) => [
      worktree.repositoryId,
      worktree,
    ]),
  );
  const materializedByLabel = new Map(
    materialization?.worktrees.map((worktree) => [
      worktree.label.toLowerCase(),
      worktree,
    ]),
  );
  const reviewWorktree = gitlabReview
    ? materialization?.worktrees.find(
        (worktree) =>
          worktree.repositoryId === gitlabReview.repositoryId ||
          worktree.label === gitlabReview.repository.split("/").at(-1),
      )
    : undefined;
  const suggestedJiraIssueKey = gitlabReview
    ? suggestedJiraIssueKeyForReview(gitlabReview)
    : undefined;
  const reviewStatusLabel = gitlabReview
    ? !gitlabReview.status
      ? reviewInboxFresh
        ? "Not in your reviews"
        : reviewInboxLoading
          ? "Checking status"
          : "Status unavailable"
      : gitlabReview.status === "merged"
      ? "Merged"
      : gitlabReview.status === "closed"
        ? "Closed"
        : gitlabReview.reviewState === "changesAfterApproval"
          ? "New changes"
          : gitlabReview.reviewState === "approved"
            ? "Approved"
            : gitlabReview.draft
              ? "Draft"
              : "Review requested"
    : "";
  const reviewStatusDetail = gitlabReview
    ? !gitlabReview.status
      ? reviewInboxFresh
        ? "GitLab no longer asks you to review this MR. It can be approved, merged, or given to another reviewer. Open the MR in GitLab to see its state."
        : reviewInboxLoading
          ? "WTS reads the MR status from GitLab. You can review the changes now."
          : "WTS cannot read the current status of this MR from GitLab. Retry the status check or open the MR in GitLab."
      : gitlabReview.status === "merged"
      ? "GitLab merged this change. No review action remains."
      : gitlabReview.status === "closed"
        ? "GitLab closed this change. No review action remains."
        : gitlabReview.reviewState === "changesAfterApproval"
          ? "The author added commits after your approval."
          : gitlabReview.reviewState === "approved"
            ? "Your approval is recorded. GitLab has not merged this change."
            : gitlabReview.draft
              ? "This merge request is a draft."
              : "GitLab requests your review."
    : "";
  const isCheckingRecordedMaterialization =
    !materialization &&
    actionState === "checking" &&
    workspace.lifecycleState === "materialized";
  const localWorkSummary = (
    created: WorkspaceMaterialization["worktrees"][number] | undefined,
  ) => {
    if (!created) {
      return isCheckingRecordedMaterialization ? "Checking…" : "Not created";
    }
    if (!created.activity) return "Checking…";
    const parts: string[] = [];
    if (created.activity.changedFileCount) {
      parts.push(
        `${created.activity.changedFileCount} changed ${created.activity.changedFileCount === 1 ? "file" : "files"}`,
      );
    }
    if (created.activity.commitsAhead) {
      parts.push(
        `${created.activity.commitsAhead} ${created.activity.commitsAhead === 1 ? "commit" : "commits"} ahead`,
      );
    }
    return parts.length ? parts.join(" · ") : "Clean";
  };
  const gitlabDeliveryTargets = (materialization?.worktrees ?? []).flatMap(
    (worktree) => {
      const target = repositoryForgeTarget(worktree.gitState?.originUrl);
      return target?.forge === "gitlab" ? [{ worktree, target }] : [];
    },
  );
  const gitlabDeliveryTargetKey = gitlabDeliveryTargets
    .map(({ worktree }) =>
      [
        worktree.repositoryId,
        worktree.branchName,
        worktree.gitState?.headCommitOid ?? "",
      ].join(":"),
    )
    .sort()
    .join("\n");
  const workspaceMergeRequests =
    gitlabInbox.state === "ready"
      ? gitlabInbox.inbox.mergeRequests.filter(
          (mergeRequest) =>
            mergeRequest.status === "open" &&
            materialization?.worktrees.some((worktree) =>
              worktree.repositoryId === mergeRequest.repositoryId &&
              worktree.branchName === mergeRequest.sourceBranch
            ),
        )
      : [];
  const workItemDeliveryLabel =
    workspaceMergeRequests.length === 1
      ? `Workspace · MR !${workspaceMergeRequests[0]!.iid}`
      : workspaceMergeRequests.length > 1
        ? `Workspace · ${workspaceMergeRequests.length} MRs`
        : undefined;
  useEffect(() => {
    let active = true;
    if (!gitlabDeliveryTargetKey) {
      return () => {
        active = false;
      };
    }
    setGitlabHandoff(null);
    setGitlabInbox({ state: "loading" });
    void loadWorkspaceGitlabMergeRequests(client, workspace.id).then(
      (inbox) => {
        if (active) {
          setGitlabInbox({ state: "ready", inbox });
        }
      },
      (cause: unknown) => {
        if (!active) return;
        setGitlabInbox({
          state: "error",
          detail:
            cause instanceof Error
              ? cause.message
              : "WTS could not check GitLab for merge requests.",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [client, gitlabDeliveryTargetKey, workspace.id]);
  useEffect(() => {
    let active = true;
    let requestPending = false;
    let requestGeneration = 0;
    const refreshAfterHandoff = () => {
      const handoff = gitlabHandoffRef.current;
      if (
        !active ||
        requestPending ||
        !handoff ||
        handoff.state !== "formOpened"
      ) return;
      requestPending = true;
      const generation = ++requestGeneration;
      setGitlabHandoff((current) =>
        current?.repositoryId === handoff.repositoryId &&
        current.headCommitOid === handoff.headCommitOid
          ? { ...current, state: "checking" }
          : current,
      );
      void loadWorkspaceGitlabMergeRequests(client, workspace.id, { force: true }).then(
        (inbox) => {
          requestPending = false;
          const current = gitlabHandoffRef.current;
          if (
            !active ||
            generation !== requestGeneration ||
            current?.repositoryId !== handoff.repositoryId ||
            current.headCommitOid !== handoff.headCommitOid
          ) return;
          setGitlabInbox({ state: "ready", inbox });
          setGitlabHandoff((latest) => {
            if (
              latest?.repositoryId !== handoff.repositoryId ||
              latest.headCommitOid !== handoff.headCommitOid
            ) return latest;
            return inbox.state === "fresh"
              ? null
              : { ...latest, state: "formOpened" };
          });
        },
        () => {
          requestPending = false;
          if (!active || generation !== requestGeneration) return;
          setGitlabHandoff((latest) =>
            latest?.repositoryId === handoff.repositoryId &&
            latest.headCommitOid === handoff.headCommitOid
              ? { ...latest, state: "formOpened" }
              : latest,
          );
        },
      );
    };
    window.addEventListener("focus", refreshAfterHandoff);
    return () => {
      active = false;
      requestGeneration += 1;
      window.removeEventListener("focus", refreshAfterHandoff);
    };
  }, [client, gitlabDeliveryTargetKey, workspace.id]);
  const openRepositoryUpstream = async (
    repository: Workspace["repositoryPlans"][number],
    repositoryId: string,
    target: RepositoryForgeTarget,
  ) => {
    if (openingRepositoryId) return;
    setOpeningRepositoryId(repositoryId);
    setRepositoryNotice("");
    try {
      const result = await client.openRepositoryBase(
        repositoryId,
        repository.baseRef,
      );
      if (
        result.repositoryId !== repositoryId ||
        result.baseRef !== repository.baseRef ||
        result.forge !== target.forge ||
        result.host !== target.host ||
        !result.accepted
      ) {
        throw new Error("WTS returned a different repository link.");
      }
      setRepositoryNotice(
        `${repository.label} opened on ${forgeDisplayName(target.forge)}.`,
      );
    } catch (cause) {
      setRepositoryNotice(
        cause instanceof Error
          ? cause.message
          : "WTS could not open the repository.",
      );
    } finally {
      setOpeningRepositoryId(null);
    }
  };
  const reviewRepositoryChanges = (
    created: WorkspaceMaterialization["worktrees"][number],
  ) => {
    onReviewChanges(created.repositoryId);
  };
  const openGitlabMergeRequest = async (
    created: WorkspaceMaterialization["worktrees"][number],
    mergeRequest: Pick<GitlabMergeRequest, "iid">,
  ) => {
    if (openingGitlabMergeRequestId) return;
    setOpeningGitlabMergeRequestId(created.repositoryId);
    setRepositoryNotice("");
    setRepositoryNoticeError(false);
    try {
      const result = await client.openGitlabMergeRequest(
        created.repositoryId,
        mergeRequest.iid,
      );
      if (
        !result.accepted ||
        result.repositoryId !== created.repositoryId ||
        result.iid !== mergeRequest.iid
      ) {
        throw new Error("WTS returned a different merge request link.");
      }
      setRepositoryNotice(
        `${created.label} · merge request !${mergeRequest.iid} opened.`,
      );
      onNotice("GitLab merge request opened");
    } catch (cause) {
      setRepositoryNoticeError(true);
      setRepositoryNotice(
        cause instanceof Error
          ? cause.message
          : "WTS could not open this merge request.",
      );
    } finally {
      setOpeningGitlabMergeRequestId(null);
    }
  };
  const linkExistingMergeRequest = async (
    created: MaterializedWorktree, iid: number, fromDialog = false,
  ) => {
    if (linkingMergeRequest) return;
    setLinkingMergeRequest(true);
    setMergeRequestLinkError("");
    const workspaceId = workspace.id;
    try {
      const linked = await client.linkWorkspaceGitlabMergeRequest(
        workspaceId, created.repositoryId, iid,
      );
      if (linked.repositoryId !== created.repositoryId || linked.iid !== iid) {
        throw new Error("WTS returned a different merge request.");
      }
      if (alignmentWorkspaceId.current !== workspaceId) return;
      setGitlabInbox((current) => {
        const inbox = current.state === "ready"
          ? current.inbox
          : {
              schemaVersion: 1 as const,
              state: "stale" as const,
              mergeRequests: [],
              fetchedAtUnixMs: null,
              detail: "WTS linked the MR. Other MR status is not current.",
            };
        return {
          state: "ready",
          inbox: {
            ...inbox,
            mergeRequests: [
              ...inbox.mergeRequests.filter((item) =>
                item.repositoryId !== linked.repositoryId ||
                item.sourceBranch === created.branchName
              ),
              linked,
            ],
          },
        };
      });
      setLinkingMergeRequestWorktree(null);
      setMergeRequestHint("");
      setRepositoryNotice(`${created.label} · MR !${iid} linked. The local branch did not change.`);
      setRepositoryNoticeError(false);
      invalidateWorkspaceGitlabMergeRequests(client, workspaceId);
      void loadWorkspaceGitlabMergeRequests(client, workspaceId, { force: true }).then(
        (inbox) => {
          if (alignmentWorkspaceId.current !== workspaceId) return;
          setGitlabInbox({
            state: "ready",
            inbox: {
              ...inbox,
              mergeRequests: inbox.mergeRequests.some((item) =>
                item.repositoryId === linked.repositoryId && item.iid === linked.iid
              ) ? inbox.mergeRequests : [
                ...inbox.mergeRequests.filter((item) =>
                  item.repositoryId !== linked.repositoryId ||
                  item.sourceBranch === created.branchName
                ),
                linked,
              ],
            },
          });
        },
        () => {
          if (alignmentWorkspaceId.current !== workspaceId) return;
          setRepositoryNotice(
            `${created.label} · MR !${iid} linked. WTS could not refresh other MRs.`,
          );
        },
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : "WTS could not link this merge request.";
      if (fromDialog) setMergeRequestLinkError(detail);
      else {
        setRepositoryNotice(detail);
        setRepositoryNoticeError(true);
      }
    } finally {
      setLinkingMergeRequest(false);
    }
  };
  const prepareChangeRequest = async (
    created: WorkspaceMaterialization["worktrees"][number],
  ) => {
    if (preparingChangeRequestId || openingChangeRequest) return;
    setPreparingChangeRequestId(created.repositoryId);
    setRepositoryNotice("");
    setRepositoryNoticeError(false);
    setChangeRequestPublishRepositoryId(null);
    setChangeRequestProposalRepositoryId(null);
    try {
      const draft = await client.prepareWorkspaceChangeRequest(
        workspace.id,
        created.repositoryId,
      );
      setChangeRequestError("");
      setChangeRequestDraft(draft);
    } catch (cause) {
      setRepositoryNoticeError(true);
      if (
        cause instanceof WorkspaceClientError &&
        (cause.code === "change_request_branch_not_published" ||
          cause.code === "change_request_remote_mismatch")
      ) {
        setChangeRequestPublishRepositoryId(created.repositoryId);
        setChangeRequestBranchName(created.branchName);
      }
      if (
        cause instanceof WorkspaceClientError &&
        cause.code === "change_request_agent_proposal_unavailable"
      ) {
        setChangeRequestProposalRepositoryId(created.repositoryId);
      }
      setRepositoryNotice(
        cause instanceof Error
          ? cause.message
          : "WTS could not prepare this change request.",
      );
    } finally {
      setPreparingChangeRequestId(null);
    }
  };
  const publishChangeRequestBranch = async () => {
    if (!changeRequestPublishRepositoryId || publishingChangeRequestId) return;
    const created = materialization?.worktrees.find(
      (worktree) => worktree.repositoryId === changeRequestPublishRepositoryId,
    );
    if (!created) return;
    setPublishingChangeRequestId(created.repositoryId);
    setRepositoryNoticeError(false);
    setRepositoryNotice(`${created.label} · publishing branch…`);
    let published = false;
    try {
      const publication = await client.publishWorkspaceChangeRequestBranch(
        workspace.id,
        created.repositoryId,
        changeRequestBranchName.trim() || undefined,
      );
      setRepositoryNotice(
        `${publication.repositoryLabel} · published to ${publication.remoteName}/${publication.branchName}. Preparing change request…`,
      );
      published = true;
      setChangeRequestPublishRepositoryId(null);
      setChangeRequestBranchName("");
      const draft = await client.prepareWorkspaceChangeRequest(
        workspace.id,
        created.repositoryId,
      );
      setChangeRequestError("");
      setChangeRequestDraft(draft);
      setRepositoryNotice(`${publication.repositoryLabel} · branch published.`);
      onNotice("Branch published");
    } catch (cause) {
      if (
        !published &&
        cause instanceof WorkspaceClientError &&
        cause.code === "change_request_worktree_dirty"
      ) {
        setChangeRequestPublishRepositoryId(null);
        setSyncBlockedRepositoryId(created.repositoryId);
      }
      setRepositoryNoticeError(true);
      setRepositoryNotice(
        `${published ? "Branch published. " : ""}${
          cause instanceof Error
            ? cause.message
            : "WTS could not publish this branch."
        }`,
      );
    } finally {
      setPublishingChangeRequestId(null);
    }
  };
  const requestChangeRequestProposal = async () => {
    if (!changeRequestProposalRepositoryId || requestingChangeRequestProposalId) return;
    const created = materialization?.worktrees.find(
      (worktree) => worktree.repositoryId === changeRequestProposalRepositoryId,
    );
    if (!created) return;
    const provider = preferredAgentProvider(workspace.provider) ?? "codex";
    setRequestingChangeRequestProposalId(created.repositoryId);
    setRepositoryNoticeError(false);
    setRepositoryNotice(`${created.label} · starting agent…`);
    try {
      await client.launchAgentSession(workspace.id, {
        provider,
        category: "review",
        prompt: [
          `Prepare a change-request proposal for repository ${created.repositoryId} at its current published HEAD.`,
          "Read WTS.md and the trusted workspace context before you start.",
          "Inspect the complete branch change. Do not modify repository files.",
          "Report the complete change-request proposal in your final response using the exact WTS_CHANGE_REQUEST_PROPOSAL format from WTS.md.",
          "Include only linked Jira issues that this repository change directly serves.",
        ].join(" "),
      });
      const agentName =
        provider === "codex" ? "Codex" : provider === "openCode" ? "OpenCode" : "Hermes";
      setChangeRequestProposalRepositoryId(null);
      setRepositoryNotice(
        `${created.label} · ${agentName} started. Prepare the change request again after the agent finishes.`,
      );
      onNotice(`${agentName} started change-request preparation`);
    } catch (cause) {
      setRepositoryNoticeError(true);
      setRepositoryNotice(
        cause instanceof Error
          ? cause.message
          : "WTS could not start the change-request agent.",
      );
    } finally {
      setRequestingChangeRequestProposalId(null);
    }
  };
  const openChangeRequest = async (title: string, body: string) => {
    if (!changeRequestDraft || openingChangeRequest) return;
    setOpeningChangeRequest(true);
    setChangeRequestError("");
    try {
      const result = await client.openWorkspaceChangeRequestDraft(
        workspace.id,
        changeRequestDraft.repositoryId,
        changeRequestDraft.effectDigest,
        title,
        body,
      );
      if (!result.accepted || result.sourceHeadCommitOid !== changeRequestDraft.sourceHeadCommitOid) {
        throw new Error("WTS returned a different change-request handoff.");
      }
      setChangeRequestDraft(null);
      const requestName = result.forge === "github" ? "pull request" : "merge request";
      if (result.forge === "gitlab") {
        setGitlabHandoff({
          repositoryId: changeRequestDraft.repositoryId,
          headCommitOid: changeRequestDraft.sourceHeadCommitOid,
          state: "formOpened",
        });
        setRepositoryNotice("");
      } else {
        setRepositoryNotice(`${changeRequestDraft.repositoryLabel} · ${requestName} form opened.`);
      }
      onNotice(`${requestName === "pull request" ? "GitHub" : "GitLab"} form opened`);
    } catch (cause) {
      setChangeRequestError(
        cause instanceof Error
          ? cause.message
          : "WTS could not open this change-request form.",
      );
    } finally {
      setOpeningChangeRequest(false);
    }
  };
  const requestChangeRequestVerification = async () => {
    if (!changeRequestDraft || requestingChangeRequestVerification) return;
    setRequestingChangeRequestVerification(true);
    setChangeRequestError("");
    const provider = changeRequestDraft.proposedByProvider;
    try {
      await client.launchAgentSession(workspace.id, {
        provider,
        category: "verification",
        prompt: [
          `Verify the pushed change for repository ${changeRequestDraft.repositoryId} at exact HEAD ${changeRequestDraft.sourceHeadCommitOid}.`,
          "Read WTS.md and the trusted workspace context before you start.",
          "Inspect the complete branch change and run the relevant checks. Do not modify code.",
          "Report blocked or incomplete checks as partial.",
          "Refresh the complete change-request proposal for this repository and HEAD in your final response, including the structured verification result required by WTS.md.",
          "Include only linked Jira issues that this repository change directly serves.",
        ].join(" "),
      });
      const agentName = provider === "codex" ? "Codex" : provider === "openCode" ? "OpenCode" : "Hermes";
      setChangeRequestDraft(null);
      setRepositoryNotice(`${changeRequestDraft.repositoryLabel} · ${agentName} started verification. Prepare the change request again after the agent finishes.`);
      onNotice(`${agentName} started change-request verification`);
    } catch (cause) {
      setChangeRequestError(
        cause instanceof Error
          ? cause.message
          : "WTS could not start change-request verification.",
      );
    } finally {
      setRequestingChangeRequestVerification(false);
    }
  };
  const syncRepository = async (
    created: WorkspaceMaterialization["worktrees"][number],
  ) => {
    if (syncingRepositoryId || openingRepositoryId) return;
    setSyncingRepositoryId(created.repositoryId);
    setSyncBlockedRepositoryId(null);
    setRepositoryNoticeError(false);
    setRepositoryNotice(`${created.label} · fetching upstream and rebuilding the graph…`);
    try {
      const result = await onSyncRepository(created.repositoryId);
      if (
        result.workspaceId !== workspace.id ||
        result.repositoryId !== created.repositoryId
      ) {
        throw new Error("WTS returned a sync result for another repository.");
      }
      const commit = result.baseCommitOid.slice(0, 8);
      if (!result.graphRefreshed) {
        setRepositoryNoticeError(true);
        setRepositoryNotice(
          `${result.repositoryLabel} updated to ${commit}, but the graph needs a re-index.`,
        );
      } else if (result.updated) {
        setRepositoryNotice(
          `${result.repositoryLabel} updated ${result.previousBaseCommitOid.slice(0, 8)} → ${commit}. Graph refreshed.`,
        );
      } else {
        setRepositoryNotice(
          `${result.repositoryLabel} is current at ${commit}. Graph refreshed.`,
        );
      }
    } catch (cause) {
      if (
        cause instanceof WorkspaceClientError &&
        cause.code === "repository_sync_blocked"
      ) {
        setSyncBlockedRepositoryId(created.repositoryId);
        setRepositoryNoticeError(true);
        setRepositoryNotice(
          `${created.label} has local changes or commits. Sync only updates a worktree before local work starts.`,
        );
        return;
      }
      if (
        cause instanceof WorkspaceClientError &&
        cause.code === "repository_sync_diverged"
      ) {
        setRepositoryNoticeError(false);
        setRepositoryNotice(
          `${created.label} has different upstream history. Review alignment before moving the worktree.`,
        );
        await reviewRepositoryAlignment(created.repositoryId);
        return;
      }
      setRepositoryNoticeError(true);
      setRepositoryNotice(
        cause instanceof Error
          ? cause.message
          : "WTS could not sync this repository.",
      );
    } finally {
      setSyncingRepositoryId(null);
    }
  };
  const alignRepository = async () => {
    if (!alignmentPreflight || alignmentState !== "ready") return;
    setAlignmentState("aligning");
    setAlignmentError("");
    try {
      const result = await onAlignRepository(
        alignmentPreflight.repositoryId,
        alignmentPreflight.effectDigest,
      );
      setAlignmentOpen(false);
      setRepositoryNoticeError(!result.graphRefreshed);
      setRepositoryNotice(
        result.graphRefreshed
          ? `${result.repositoryLabel} aligned ${result.previousBaseCommitOid.slice(0, 8)} → ${result.baseCommitOid.slice(0, 8)}. Backup saved and graph refreshed.`
          : `${result.repositoryLabel} now uses ${result.baseCommitOid.slice(0, 8)}. Backup saved, but the graph needs a re-index.`,
      );
      setAlignmentState("ready");
    } catch (cause) {
      setAlignmentError(
        cause instanceof Error
          ? cause.message
          : "WTS could not align this repository.",
      );
      setAlignmentState("error");
    }
  };

  return (
    <div
      className={styles.overviewGrid}
      data-ui="workspace-overview.page"
      data-ui-label="Workspace overview"
    >
      {actionError && (materialization || gitlabReview) &&
        !(repositoryNoticeError && (
          repositoryNotice === actionError ||
          (syncBlockedRepositoryId && actionErrorCode === "repository_sync_blocked")
        )) && <section
        aria-label="Workspace recovery"
        className={styles.workspaceRecovery}
        data-ui="workspace-overview.recovery"
        data-ui-label="Workspace status recovery"
      >
        <p role="alert">{actionError}</p>
        {driftDetected && <p>If the change is expected, register it before you continue.</p>}
        <div>
          <button disabled={commandBusy} className={styles.secondaryButton} onClick={driftDetected ? onReconcile : onRefreshWorkspace} type="button">{driftDetected ? "Register changes & re-index" : "Refresh workspace"}</button>
          {onOpenIntegrations && <button disabled={commandBusy} className={styles.secondaryButton} onClick={onOpenIntegrations} type="button">Open integrations</button>}
        </div>
      </section>}
      <div className={styles.mainColumn}>
        {gitlabReview && reviewWorktree && (
          <section
            aria-label="Workspace review action"
            className={styles.reviewWorkspaceCallout}
            data-status={gitlabReview.status}
            data-ui="workspace-overview.review"
            data-ui-label="Workspace review action"
          >
            <div className={styles.reviewWorkspaceSummary}>
              <span className={styles.reviewWorkspaceMeta}>
                <button
                  aria-label={`Open merge request !${gitlabReview.number} in GitLab`}
                  className={styles.reviewWorkspaceLink}
                  disabled={openingGitlabMergeRequestId !== null}
                  onClick={() =>
                    void openGitlabMergeRequest(reviewWorktree, {
                      iid: gitlabReview.number,
                    })
                  }
                  role="link"
                  type="button"
                >
                  GITLAB MR !{gitlabReview.number}
                  <Glyph name="external" size={10} />
                </button>
                <span
                  className={styles.reviewWorkspaceStatus}
                  data-status={gitlabReview.status}
                >
                  {reviewStatusLabel}
                </span>
              </span>
              <h2>{gitlabReview.title ?? `Review ${gitlabReview.repository}`}</h2>
              <p className={styles.reviewWorkspaceOutcome}>{reviewStatusDetail}</p>
              <p className={styles.reviewWorkspaceByline}>
                {gitlabReview.repository}
                {gitlabReview.authorLogin ? ` · ${gitlabReview.authorLogin}` : ""}
              </p>
              {gitlabReview.sourceBranch && gitlabReview.targetBranch && (
                <p className={styles.reviewWorkspaceBranches}>
                  <code>{gitlabReview.sourceBranch}</code>
                  <Glyph name="arrow" size={11} />
                  <code>{gitlabReview.targetBranch}</code>
                </p>
              )}
            </div>
            <div className={styles.reviewWorkspaceActions}>
              {!gitlabReview.status && !reviewInboxFresh && !reviewInboxLoading && onRetryReviewStatus && (
                <button
                  className={styles.reviewWorkspaceSecondaryAction}
                  data-ui="workspace-overview.review-retry"
                  data-ui-label="Retry MR status"
                  onClick={onRetryReviewStatus}
                  type="button"
                >
                  <Glyph name="refresh" size={12} />
                  Retry status
                </button>
              )}
              <button
                className={styles.reviewWorkspaceSecondaryAction}
                disabled={openingGitlabMergeRequestId !== null}
                onClick={() =>
                  void openGitlabMergeRequest(reviewWorktree, {
                    iid: gitlabReview.number,
                  })
                }
                type="button"
              >
                Open in GitLab
                <Glyph name="external" size={11} />
              </button>
              <button
                className={styles.reviewWorkspacePrimaryAction}
                onClick={() => onReviewChanges(reviewWorktree.repositoryId)}
                type="button"
              >
                {gitlabReview.reviewState === "changesAfterApproval"
                  ? "Review new changes"
                  : gitlabReview.status === "merged"
                    ? "View merged changes"
                    : "Review changes"}
                <Glyph name="arrow" size={12} />
              </button>
            </div>
          </section>
        )}
        {gitlabReview && reviewWorktree && reviewAttention}
        {gitlabReview && reviewWorktree ? (
          <>
            {suggestedJiraIssueKey && (
              <section
                aria-label="Review issue context"
                className={styles.reviewContextPanel}
                data-ui="workspace-overview.review-context"
                data-ui-label="Review issue context"
              >
                <span className={styles.reviewContextIcon} aria-hidden="true">
                  <Glyph name="issue" size={15} />
                </span>
                <span>
                  <small>LINKED WORK</small>
                  <strong>{suggestedJiraIssueKey}</strong>
                </span>
                <p>Detected in the merge request title or source branch.</p>
              </section>
            )}
            <section
              aria-label="Review scope"
              className={styles.reviewScopePanel}
              data-ui="workspace-overview.review-scope"
              data-ui-label="Review scope"
            >
              <header>
                <span>
                  <small>REVIEW SCOPE</small>
                  <h2>Repository changes</h2>
                </span>
              </header>
              <div className={styles.reviewScopeRow}>
                <span className={styles.reviewScopeRepository}>
                  <span className={styles.repoGlyph} aria-hidden="true">
                    <Glyph name="branch" size={15} />
                  </span>
                  <span>
                    <strong>{reviewWorktree.label}</strong>
                    <small>
                      {gitlabReview?.sourceBranch ?? reviewWorktree.branchName}
                      {gitlabReview?.targetBranch
                        ? ` → ${gitlabReview.targetBranch}`
                        : ""}
                    </small>
                  </span>
                </span>
                <span className={styles.reviewScopeWork}>
                  {localWorkSummary(reviewWorktree)}
                </span>
                <button
                  onClick={() => onReviewChanges(reviewWorktree.repositoryId)}
                  type="button"
                >
                  View changes
                  <Glyph name="arrow" size={11} />
                </button>
              </div>
            </section>
          </>
        ) : (
          <>
            <WorkspaceProvisionPanel
              workspace={workspace}
              state={actionState}
              commandBusy={commandBusy}
              preflight={preflight}
              materialization={materialization}
              repositoryCatalog={repositoryCatalog}
              error={actionError}
              errorCode={actionErrorCode}
              driftDetected={driftDetected}
              onReview={onReview}
              onFetchBranches={onFetchBranches}
              onReviseBase={onReviseBase}
              onCreateRevisedCopy={onCreateRevisedCopy}
              onReconcile={onReconcile}
              onMaterialize={onMaterialize}
              onReviewRemainingFiles={onReviewRemainingFiles}
              onRecoverSetup={onRecoverSetup}
            />
            <WorkspaceWorkItemsPanel
              client={client}
              onOpenIntegrations={onOpenIntegrations}
              deliveryLabel={workItemDeliveryLabel}
              workspaceId={workspace.id}
              workspaceKey={workspace.key}
              onNotice={onNotice}
            />
            <section
          className={styles.panel}
          data-ui="workspace-overview.repositories"
          data-ui-label="Workspace repositories"
        >
          <div className={styles.panelHeading}>
            <span>
              <small>REPOSITORIES</small>
              <h2>
                {materialization ? "Managed worktrees" : "Repository requests"}
              </h2>
            </span>
            <button
              className={styles.panelInlineAction}
              onClick={onAddRepositories}
              type="button"
            >
              <Glyph name="plus" size={12} />
              Add repositories
            </button>
          </div>
          <div
            className={styles.repoTable}
            role="table"
            aria-label={
              materialization ? "Managed worktrees" : "Repository requests"
            }
          >
            <div className={styles.repoTableHeader} role="row">
              <span role="columnheader">Repository</span>
              <span role="columnheader">Base</span>
              <span role="columnheader">Work</span>
            </div>
            {workspace.repositoryPlans.map((repository) =>
              (() => {
                const created = repository.repositoryId
                  ? materializedById.get(repository.repositoryId)
                  : materializedByLabel.get(repository.label.toLowerCase());
                const catalogMatches = (repositoryCatalog?.repositories ?? []).filter(
                  (item) =>
                    repository.repositoryId
                      ? item.id === repository.repositoryId
                      : item.label.toLowerCase() === repository.label.toLowerCase(),
                );
                const catalogRepository =
                  catalogMatches.length === 1 ? catalogMatches[0] : undefined;
                const upstreamRepositoryId =
                  created?.repositoryId ?? catalogRepository?.id;
                const forgeTarget = repositoryForgeTarget(
                  created?.gitState?.originUrl ?? catalogRepository?.originUrl,
                );
                const workSummary = localWorkSummary(created);
                const mergeRequests =
                  created &&
                  forgeTarget?.forge === "gitlab" &&
                  gitlabInbox.state === "ready"
                    ? gitlabInbox.inbox.mergeRequests.filter(
                        (mergeRequest) =>
                          mergeRequest.repositoryId === created.repositoryId,
                      )
                    : [];
                const reviewForRepository =
                  created &&
                  gitlabReview &&
                  (created.repositoryId === gitlabReview.repositoryId ||
                    created.label === gitlabReview.repository.split("/").at(-1))
                    ? gitlabReview
                    : undefined;
                return (
                  <div
                    className={styles.repoTableRow}
                    role="row"
                    key={repositoryEvidenceKey(
                      repository.repositoryId,
                      repository.label,
                    )}
                  >
                    <span role="cell">
                      <span className={styles.repoGlyph}>
                        <Glyph name="branch" size={15} />
                      </span>
                      {upstreamRepositoryId && forgeTarget ? (
                        <button
                          aria-label={`Open ${repository.label} on ${forgeDisplayName(forgeTarget.forge)}`}
                          className={styles.repositoryLink}
                          disabled={openingRepositoryId !== null}
                          onClick={() =>
                            void openRepositoryUpstream(
                              repository,
                              upstreamRepositoryId,
                              forgeTarget,
                            )
                          }
                          type="button"
                        >
                          {repository.label}
                          <Glyph name="external" size={11} />
                        </button>
                      ) : (
                        <b>{repository.label}</b>
                      )}
                      {created && (materialization?.worktrees.length ?? 0) > 1 && (
                        <button
                          aria-label={`Remove ${repository.label} from this workspace`}
                          className={styles.repoRemoveButton}
                          disabled={commandBusy || removingRepositoryId !== null}
                          onClick={() => setRepositoryToRemove(created)}
                          type="button"
                        >
                          <Glyph name="trash" size={11} />
                        </button>
                      )}
                    </span>
                    <span className={styles.repoBase} role="cell">
                      <span className={styles.repoBaseMeta}>
                        <code>{repository.baseRef}</code>
                        {created && (
                          <>
                          <small>{created.baseCommitOid.slice(0, 8)}</small>
                          <InfoTooltip
                            content={
                              syncingRepositoryId === created.repositoryId
                                ? "Sync in progress"
                                : commandBusy
                                  ? "Workspace command in progress"
                                  : workSummary !== "Clean"
                                    ? "Sync is only available before local work starts. Review this repository instead."
                                  : `Fetch the tracking remote for ${repository.baseRef}, fast-forward this clean worktree, and rebuild the graph`
                            }
                          >
                            <Button
                              aria-label={`Sync ${repository.label} with upstream ${repository.baseRef}`}
                              className={styles.repoSyncButton}
                              isDisabled={
                                commandBusy ||
                                workSummary !== "Clean" ||
                                syncingRepositoryId !== null ||
                                openingRepositoryId !== null
                              }
                              onPress={() => void syncRepository(created)}
                            >
                              <Glyph name="refresh" size={10} />
                              {syncingRepositoryId === created.repositoryId
                                ? "Syncing…"
                                : "Sync"}
                            </Button>
                          </InfoTooltip>
                          </>
                        )}
                      </span>
                    </span>
                    <div className={styles.repoWorkCell} role="cell">
                      <div className={styles.repoLocalWork} role="group" aria-label={`Local work in ${repository.label}`}>
                        <span className={styles.repoWorkLabel}>Local</span>
                        {created?.activity && workSummary !== "Clean" ? (
                          <button
                            aria-label={`Review changes in ${repository.label}: ${workSummary}`}
                            className={styles.repoChangesLink}
                            onClick={() => void reviewRepositoryChanges(created)}
                            type="button"
                          >
                            <StateDot state="attention" />
                            {workSummary}
                            <Glyph name="arrow" size={11} />
                          </button>
                        ) : (
                          <span className={styles.repoSignal}>
                            <StateDot
                              state={created?.activity ? "active" : "planned"}
                            />
                            {workSummary}
                          </span>
                        )}
                      </div>
                      {created && reviewForRepository ? (
                        <span className={styles.repoReviewLinks}>
                          <button
                            aria-label={`Open merge request !${reviewForRepository.number} in GitLab`}
                            className={styles.repoDeliveryLink}
                            disabled={openingGitlabMergeRequestId !== null}
                            onClick={() =>
                              void openGitlabMergeRequest(created, {
                                iid: reviewForRepository.number,
                              })
                            }
                            role="link"
                            type="button"
                          >
                            <Glyph name="external" size={11} />
                            MR !{reviewForRepository.number} ·{
                              reviewForRepository.status === "merged"
                                ? " Merged"
                                : reviewForRepository.status === "closed"
                                  ? " Closed"
                                  : " Open"
                            }
                          </button>
                          <button
                            aria-label={`Review merge request !${reviewForRepository.number} changes in ${repository.label}`}
                            className={styles.repoReviewChangesLink}
                            onClick={() => void reviewRepositoryChanges(created)}
                            type="button"
                          >
                            Review changes
                          </button>
                        </span>
                      ) : created &&
                      workSummary !== "Clean" &&
                      forgeTarget?.forge === "github" ? (
                        <button
                          className={styles.repoDeliveryLink}
                          disabled={
                            commandBusy ||
                            preparingChangeRequestId !== null ||
                            openingChangeRequest
                          }
                          onClick={() => void prepareChangeRequest(created)}
                          type="button"
                        >
                          <Glyph name="branch" size={11} />
                          {preparingChangeRequestId === created.repositoryId
                            ? "Checking…"
                            : "Prepare PR"}
                        </button>
                      ) : created && forgeTarget?.forge === "gitlab" ? (
                          gitlabHandoff?.repositoryId === created.repositoryId ? (
                            <span
                              aria-label={`${repository.label} merge request status`}
                              className={styles.repoDeliveryStatus}
                              data-state={gitlabHandoff.state}
                              role="status"
                            >
                              <span
                                aria-hidden="true"
                                className={styles.repoDeliveryStatusIcon}
                                data-animated={
                                  gitlabHandoff.state === "checking" || undefined
                                }
                              >
                                <Glyph
                                  name={
                                    gitlabHandoff.state === "checking"
                                      ? "refresh"
                                      : "check"
                                  }
                                  size={9}
                                />
                              </span>
                              {gitlabHandoff.state === "checking"
                                ? "WTS checks GitLab for the MR"
                                : "MR form opened"}
                            </span>
                          ) : gitlabInbox.state === "loading" ? (
                            <span
                              aria-label={`${repository.label} merge request status`}
                              className={styles.repoDeliveryStatus}
                              role="status"
                            >
                              <span
                                aria-hidden="true"
                                className={styles.repoDeliveryStatusIcon}
                                data-animated="true"
                              >
                                <Glyph name="refresh" size={9} />
                              </span>
                              WTS checks GitLab
                            </span>
                          ) : mergeRequests.length > 0 ? (
                            <div className={styles.repoDeliveryFallback}>
                              {mergeRequests.map((mergeRequest) => {
                                const hasNewLocalWork = Boolean(
                                  mergeRequest.sourceBranch === created.branchName &&
                                  mergeRequest.sourceHeadCommitOid &&
                                  created.gitState?.headCommitOid &&
                                  mergeRequest.sourceHeadCommitOid !==
                                    created.gitState.headCommitOid,
                                );
                                return (
                                  <div
                                    aria-label={`Linked MR !${mergeRequest.iid} for ${repository.label}`}
                                    className={styles.repoLinkedMr}
                                    key={mergeRequest.id}
                                    role="group"
                                  >
                                    <span className={styles.repoWorkLabel}>Linked MR</span>
                                    <a
                                      aria-label={`Open ${repository.label} merge request !${mergeRequest.iid} on GitLab: ${mergeRequest.title}`}
                                      className={styles.repoDeliveryLink}
                                      aria-disabled={commandBusy || openingGitlabMergeRequestId !== null}
                                      data-status={mergeRequest.status}
                                      href={mergeRequest.webUrl}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        if (commandBusy || openingGitlabMergeRequestId !== null) return;
                                        void openGitlabMergeRequest(created, mergeRequest);
                                      }}
                                      rel="noreferrer"
                                      target="_blank"
                                    >
                                      <Glyph name="external" size={11} />
                                      {openingGitlabMergeRequestId === created.repositoryId
                                        ? "Opening MR…"
                                        : `${mergeRequest.draft ? "Draft " : ""}MR !${mergeRequest.iid} · ${
                                            mergeRequest.status === "merged"
                                              ? "Merged"
                                              : mergeRequest.status === "closed"
                                                ? "Closed"
                                                : "Open"
                                          }`}
                                      {hasNewLocalWork ? " · New local work" : ""}
                                    </a>
                                    {mergeRequest.sourceBranch !== created.branchName && (
                                      <button
                                        aria-controls={`branch-note-${mergeRequest.id}`}
                                        aria-expanded={openBranchNoteId === mergeRequest.id}
                                        className={styles.repoMrBranchToggle}
                                        data-ui="workspace.repo-branch-mismatch"
                                        data-ui-label="Different branches"
                                        onClick={() =>
                                          setOpenBranchNoteId((current) =>
                                            current === mergeRequest.id ? null : mergeRequest.id,
                                          )
                                        }
                                        type="button"
                                      >
                                        Different branches
                                        <Glyph name="chevron" size={9} />
                                      </button>
                                    )}
                                    {mergeRequest.sourceBranch !== created.branchName &&
                                      openBranchNoteId === mergeRequest.id && (
                                        <div
                                          className={styles.repoMrBranchDetails}
                                          id={`branch-note-${mergeRequest.id}`}
                                        >
                                          <p>WTS does not compare or publish this MR from this worktree.</p>
                                          <dl>
                                            <dt>MR</dt>
                                            <dd><code title={mergeRequest.sourceBranch}>{mergeRequest.sourceBranch}</code></dd>
                                            <dt>Local</dt>
                                            <dd><code title={created.branchName}>{created.branchName}</code></dd>
                                          </dl>
                                          <button
                                            className={styles.repoDeliveryLink}
                                            disabled={commandBusy || linkingMergeRequest}
                                            onClick={() => {
                                              setLinkingMergeRequestWorktree(created);
                                              setMergeRequestHint("");
                                              setMergeRequestLinkError("");
                                            }}
                                            type="button"
                                          >
                                            Change MR link
                                          </button>
                                        </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (workSummary !== "Clean" || agentMrHints.some((proposal) => proposal.repositoryId === created.repositoryId)) &&
                            gitlabInbox.state === "ready" &&
                            gitlabInbox.inbox.state === "fresh" ? (
                            <span className={styles.repoDeliveryActions}>
                              <button
                                className={styles.repoDeliveryLink}
                                disabled={
                                  commandBusy ||
                                  preparingChangeRequestId !== null ||
                                  openingChangeRequest
                                }
                                onClick={() => void prepareChangeRequest(created)}
                                type="button"
                              >
                                <Glyph name="branch" size={11} />
                                {preparingChangeRequestId === created.repositoryId
                                  ? "Checking…"
                                  : "Prepare MR"}
                              </button>
                              {agentMrHints.filter((proposal) =>
                                proposal.repositoryId === created.repositoryId
                              ).slice(0, 1).map((proposal) => (
                                <button
                                  className={styles.repoDeliveryLink}
                                  disabled={commandBusy || linkingMergeRequest}
                                  key={`${proposal.repositoryId}:${proposal.iid}`}
                                  onClick={() => void linkExistingMergeRequest(created, proposal.iid)}
                                  type="button"
                                >
                                  {linkingMergeRequest ? "Checking MR…" : `Link agent MR !${proposal.iid}`}
                                </button>
                              ))}
                            </span>
                          ) : null
                        ) : null}
                    </div>
                  </div>
                );
              })(),
            )}
          </div>
          {repositoryToRemove && (
            <div className={styles.repositoryRemoveConfirm} role="alertdialog" aria-label={`Remove ${repositoryToRemove.label} from this workspace`}>
              <span>
                <strong>Remove {repositoryToRemove.label}?</strong>
                <small>WTS removes its clean managed worktree. The source checkout and retained branch stay on disk.</small>
              </span>
              <span>
                <Button className={styles.secondaryButton} isDisabled={removingRepositoryId !== null} onPress={() => setRepositoryToRemove(null)}>Cancel</Button>
                <Button className={styles.dangerButton} isDisabled={removingRepositoryId !== null} onPress={() => void removeRepository()}>
                  {removingRepositoryId ? "Removing…" : "Remove repository"}
                </Button>
              </span>
            </div>
          )}
          {repositoryNotice && (
            <div
              className={styles.repositoryNotice}
              data-error={repositoryNoticeError || undefined}
              role={repositoryNoticeError ? "alert" : "status"}
            >
              <span>{repositoryNotice}</span>
              {syncBlockedRepositoryId && (
                <span className={styles.repositoryNoticeActions}>
                  <Button
                    className={styles.secondaryButton}
                    onPress={() => {
                      const created = materialization?.worktrees.find(
                        (worktree) =>
                          worktree.repositoryId === syncBlockedRepositoryId,
                      );
                      if (created) void reviewRepositoryChanges(created);
                    }}
                  >
                    Review work
                  </Button>
                  <Button
                    className={styles.secondaryButton}
                    onPress={onOpenWorkspace}
                  >
                    Open workspace
                  </Button>
                </span>
              )}
              {changeRequestPublishRepositoryId && (
                <span className={styles.repositoryNoticeActions}>
                  <Label className={styles.publishBranchField}>
                    <span>Branch name</span>
                    <Input
                      autoCapitalize="none"
                      autoComplete="off"
                      className={styles.publishBranchInput}
                      maxLength={240}
                      spellCheck={false}
                      value={changeRequestBranchName}
                      onChange={(event) => setChangeRequestBranchName(event.target.value)}
                    />
                  </Label>
                  <Button
                    className={styles.primaryButton}
                    isDisabled={publishingChangeRequestId !== null}
                    onPress={() => void publishChangeRequestBranch()}
                  >
                    <Glyph name="branch" size={11} />
                    {publishingChangeRequestId ? "Publishing…" : "Publish branch"}
                  </Button>
                  <Button
                    className={styles.secondaryButton}
                    onPress={onOpenWorkspace}
                  >
                    Open workspace
                  </Button>
                </span>
              )}
              {changeRequestProposalRepositoryId && (
                <span className={styles.repositoryNoticeActions}>
                  <Button
                    className={styles.primaryButton}
                    isDisabled={requestingChangeRequestProposalId !== null}
                    onPress={() => void requestChangeRequestProposal()}
                  >
                    <Glyph name="play" size={11} />
                    {requestingChangeRequestProposalId
                      ? "Starting agent…"
                      : "Ask agent to prepare"}
                  </Button>
                  <Button
                    className={styles.secondaryButton}
                    onPress={onOpenWorkspace}
                  >
                    Open workspace
                  </Button>
                </span>
              )}
            </div>
          )}
            </section>
            <AgentStatePrototype
              client={client}
              materialized={Boolean(materialization)}
              provider={preferredAgentProvider(workspace.provider) ?? "codex"}
              workspaceId={workspace.id}
            />
          </>
        )}
      </div>
      <RepositoryAlignmentDialog
        error={alignmentError}
        onConfirm={() => void alignRepository()}
        onOpenChange={(open) => {
          setAlignmentOpen(open);
          if (!open) alignmentGeneration.current += 1;
        }}
        onRetry={() => {
          if (alignmentRepositoryId) void reviewRepositoryAlignment(alignmentRepositoryId);
        }}
        open={alignmentOpen}
        preflight={alignmentPreflight}
        state={alignmentState}
      />
      <WorkspaceChangeRequestDialog
        draft={changeRequestDraft}
        error={changeRequestError}
        opening={openingChangeRequest}
        requestingVerification={requestingChangeRequestVerification}
        onOpenChange={(open) => {
          if (!open && !openingChangeRequest) {
            setChangeRequestDraft(null);
            setChangeRequestError("");
          }
        }}
        onRequestVerification={() => void requestChangeRequestVerification()}
        onSubmit={(title, body) => void openChangeRequest(title, body)}
      />
      <Dialog.Root
        open={linkingMergeRequestWorktree !== null}
        onOpenChange={(open) => {
          if (!open && !linkingMergeRequest) {
            setLinkingMergeRequestWorktree(null);
            setMergeRequestLinkError("");
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className={styles.dialogOverlay} />
          <Dialog.Content
            className={`${styles.portalSurface} ${styles.existingMergeRequestDialog}`}
            data-ui="workspace.link-merge-request-dialog"
            data-ui-label="Link merge request dialog"
          >
            <Dialog.Title>Find existing MR for {linkingMergeRequestWorktree?.label}</Dialog.Title>
            <Dialog.Description>
              WTS checks this MR in GitLab. This does not change the local branch or worktree.
            </Dialog.Description>
            <form onSubmit={(event) => {
              event.preventDefault();
              const input = mergeRequestHint.trim();
              const iid = Number(input);
              if (!/^[1-9]\d*$/.test(input) || !Number.isSafeInteger(iid)) {
                setMergeRequestLinkError("Enter a valid MR number.");
                return;
              }
              if (linkingMergeRequestWorktree) {
                void linkExistingMergeRequest(linkingMergeRequestWorktree, iid, true);
              }
            }}>
              <label htmlFor="existing-merge-request-hint">MR number</label>
              <input
                autoCapitalize="none"
                autoComplete="off"
                autoFocus
                id="existing-merge-request-hint"
                inputMode="numeric"
                maxLength={16}
                onChange={(event) => {
                  setMergeRequestHint(event.target.value);
                  setMergeRequestLinkError("");
                }}
                placeholder="43"
                value={mergeRequestHint}
              />
              {mergeRequestLinkError && <p role="alert">{mergeRequestLinkError}</p>}
              <div className={styles.dialogActions}>
                <Dialog.Close className={styles.secondaryButton} disabled={linkingMergeRequest}>Cancel</Dialog.Close>
                <button className={styles.primaryButton} disabled={linkingMergeRequest || !mergeRequestHint.trim()} type="submit">
                  {linkingMergeRequest ? "Checking MR…" : "Link MR"}
                </button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function AdapterPlaceholder({
  eyebrow,
  title,
  description,
  next,
}: {
  eyebrow: string;
  title: string;
  description: string;
  next: string;
}) {
  return (
    <div className={styles.adapterPlaceholder}>
      <span className={styles.adapterIcon}>
        <Glyph name="plug" size={22} />
      </span>
      <small>{eyebrow}</small>
      <h2>{title}</h2>
      <p>{description}</p>
      <span className={styles.adapterNext}>{next}</span>
    </div>
  );
}

const AGENT_EVIDENCE_POLL_INTERVAL_MS = 1_000;
const AGENT_EVIDENCE_POLL_LIMIT = 120;
const RECENT_AGENT_RUN_LIMIT = 8;

type AgentRequestState =
  "idle" | "graphRequestPending" | "agentRequestPending" | "complete" | "error";

function agentDurationLabel(durationMs: number | null): string {
  if (durationMs === null) return "Pending";
  if (durationMs < 1_000) return `${durationMs} ms`;
  const seconds = durationMs / 1_000;
  return seconds < 60
    ? `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
    : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function agentTimestampLabel(unixMs: number): string {
  return new Date(unixMs).toLocaleString();
}

function agentTimestampValue(unixMs: number): string {
  return new Date(unixMs).toISOString();
}

function agentRunStateLabel(state: WorkspaceAgentEvidence["state"]): string {
  switch (state) {
    case "running":
      return "Accepted / preparing";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
  }
}

function agentRunFailureLabel(
  failure: WorkspaceAgentEvidence["failure"],
): string | null {
  switch (failure) {
    case "unavailable":
      return "Provider unavailable";
    case "spawnFailed":
      return "Provider could not be started";
    case "timedOut":
      return "Timed out";
    case "outputTooLarge":
      return "Output limit exceeded";
    case "providerFailed":
      return "Provider reported failure";
    case null:
      return null;
  }
}

function AgentWorkspacePanel({
  workspace,
  materialization,
  onIndexGraph,
  onRunAgent,
  draft,
  client,
}: {
  workspace: Workspace;
  materialization: WorkspaceMaterialization | null;
  onIndexGraph: () => Promise<GraphIndexResult>;
  onRunAgent: (
    provider: AgentProvider,
    prompt: string,
  ) => Promise<AgentRunResult>;
  draft: { prompt: string; revision: number } | null;
  client: WorkspaceClient;
}) {
  const preferred = preferredAgentProvider(workspace.provider) ?? "codex";
  const [provider, setProvider] = useState<AgentProvider>(preferred);
  const [prompt, setPrompt] = useState("");
  const [requestState, setRequestState] = useState<AgentRequestState>("idle");
  const [requestStartedAt, setRequestStartedAt] = useState<number | null>(null);
  const [requestElapsedMs, setRequestElapsedMs] = useState(0);
  const [result, setResult] = useState<AgentRunResult | null>(null);
  const [message, setMessage] = useState("");
  const [evidenceRuns, setEvidenceRuns] = useState<WorkspaceAgentEvidence[]>(
    [],
  );
  const [graphEvidence, setGraphEvidence] =
    useState<WorkspaceGraphManifest | null>(null);
  const [evidenceState, setEvidenceState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [evidenceError, setEvidenceError] = useState("");
  const [activityOpen, setActivityOpen] = useState(false);
  const requestGenerationRef = useRef(0);
  const evidenceReadGenerationRef = useRef(0);
  const graphReady = materialization?.graph.status === "ready";
  const requestPending =
    requestState === "graphRequestPending" ||
    requestState === "agentRequestPending";
  const canRun = Boolean(
    materialization && graphReady && prompt.trim() && !requestPending,
  );

  const promptStarters = useMemo(
    () => [
      {
        label: "Verify workspace index",
        prompt: `Verify the local structural index for workspace ${workspace.key}. Read graphify-out/graph.json directly and summarize the repositories, important relationships, and any obvious gaps. Do not run commands, tests, or tools, and do not modify any files.`,
      },
      {
        label: "Plan workspace checks",
        prompt: `For workspace ${workspace.key}, read graphify-out/graph.json directly and identify evidence-backed, workspace-specific user journeys and checks. Do not assume WTS application chrome is part of the workspace. Do not run commands, tests, or tools, and do not modify any files.`,
      },
      {
        label: "Review current changes",
        prompt: `Review the current changes in workspace ${workspace.key}. Call out correctness risks, missing tests, and any workspace-boundary concerns before proposing fixes.`,
      },
    ],
    [workspace.key],
  );

  const refreshEvidence = useCallback(
    async (showLoading: boolean) => {
      const generation = ++evidenceReadGenerationRef.current;
      if (showLoading) {
        setEvidenceState("loading");
        setEvidenceError("");
      }
      try {
        const evidence = await client.getWorkspaceEvidence(workspace.id);
        if (generation !== evidenceReadGenerationRef.current) return;
        setEvidenceRuns(evidence?.agentRuns ?? []);
        setGraphEvidence(evidence?.graphManifest ?? null);
        setEvidenceState("ready");
        setEvidenceError("");
      } catch (error) {
        if (generation !== evidenceReadGenerationRef.current) return;
        setEvidenceState("error");
        setEvidenceError(
          error instanceof Error
            ? error.message
            : "Durable activity could not be read.",
        );
      }
    },
    [client, workspace.id],
  );

  useEffect(() => {
    requestGenerationRef.current += 1;
    setProvider(preferred);
    setPrompt(draft?.prompt ?? "");
    setResult(null);
    setMessage("");
    setRequestState("idle");
    setRequestStartedAt(null);
    setRequestElapsedMs(0);
    setActivityOpen(false);
    return () => {
      requestGenerationRef.current += 1;
    };
  }, [draft?.prompt, draft?.revision, preferred, workspace.id]);

  useEffect(() => {
    evidenceReadGenerationRef.current += 1;
    if (!materialization) {
      setEvidenceRuns([]);
      setGraphEvidence(null);
      setEvidenceState("idle");
      setEvidenceError("");
      return;
    }
    void refreshEvidence(true);
    return () => {
      evidenceReadGenerationRef.current += 1;
    };
  }, [materialization, refreshEvidence]);

  useEffect(() => {
    if (requestState !== "agentRequestPending" || !materialization) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    let timeoutId: number | undefined;
    const poll = async () => {
      attempts += 1;
      await refreshEvidence(false);
      if (!cancelled && attempts < AGENT_EVIDENCE_POLL_LIMIT) {
        timeoutId = window.setTimeout(
          () => void poll(),
          AGENT_EVIDENCE_POLL_INTERVAL_MS,
        );
      }
    };
    timeoutId = window.setTimeout(
      () => void poll(),
      AGENT_EVIDENCE_POLL_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [materialization, refreshEvidence, requestState]);

  useEffect(() => {
    if (requestPending && requestStartedAt !== null) {
      setRequestElapsedMs(Math.max(0, Date.now() - requestStartedAt));
    }
  }, [requestPending, requestStartedAt]);

  useVisiblePolling(
    () => {
      if (requestPending && requestStartedAt !== null) {
        setRequestElapsedMs(Math.max(0, Date.now() - requestStartedAt));
      }
    },
    1000,
    { enabled: Boolean(requestPending && requestStartedAt !== null) },
  );

  const indexGraph = async () => {
    if (requestPending) return;
    const generation = ++requestGenerationRef.current;
    const startedAt = Date.now();
    setRequestState("graphRequestPending");
    setRequestStartedAt(startedAt);
    setRequestElapsedMs(0);
    setResult(null);
    setMessage("");
    setActivityOpen(true);
    try {
      const indexed = await onIndexGraph();
      if (generation !== requestGenerationRef.current) return;
      const elapsed = Math.max(0, Date.now() - startedAt);
      setRequestElapsedMs(elapsed);
      setMessage(
        `Index request returned after ${agentDurationLabel(elapsed)}. ${indexed.detail}`,
      );
      setRequestState("complete");
      void refreshEvidence(false);
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      const elapsed = Math.max(0, Date.now() - startedAt);
      setRequestElapsedMs(elapsed);
      setMessage(
        `Index request returned an error after ${agentDurationLabel(elapsed)}. ${
          error instanceof Error ? error.message : "Graph indexing failed."
        }`,
      );
      setRequestState("error");
      void refreshEvidence(false);
    }
  };

  const runAgent = async (event: FormEvent) => {
    event.preventDefault();
    if (!canRun) return;
    const generation = ++requestGenerationRef.current;
    const startedAt = Date.now();
    const requestedProvider = provider;
    setRequestState("agentRequestPending");
    setRequestStartedAt(startedAt);
    setRequestElapsedMs(0);
    setResult(null);
    setMessage("");
    setActivityOpen(true);
    try {
      const next = await onRunAgent(requestedProvider, prompt);
      if (generation !== requestGenerationRef.current) return;
      const elapsed = Math.max(0, Date.now() - startedAt);
      setRequestElapsedMs(elapsed);
      setResult(next);
      setRequestState(next.succeeded ? "complete" : "error");
      setMessage(
        next.succeeded
          ? `Current response returned after ${agentDurationLabel(elapsed)}. WTS recorded ${agentDurationLabel(next.durationMs)} for the adapter run.`
          : `Current response returned after ${agentDurationLabel(elapsed)}. WTS reports that ${providerFromView[requestedProvider]} did not complete successfully.`,
      );
      void refreshEvidence(false);
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      const elapsed = Math.max(0, Date.now() - startedAt);
      setRequestElapsedMs(elapsed);
      setMessage(
        `Run request returned an error after ${agentDurationLabel(elapsed)}. ${
          error instanceof Error ? error.message : "The agent request failed."
        } Durable evidence may still update if backend work continued.`,
      );
      setRequestState("error");
      void refreshEvidence(false);
    }
  };

  const recentRuns = useMemo(
    () =>
      [...evidenceRuns]
        .sort(
          (left, right) =>
            right.startedAtUnixMs - left.startedAtUnixMs ||
            right.runId.localeCompare(left.runId),
        )
        .slice(0, RECENT_AGENT_RUN_LIMIT),
    [evidenceRuns],
  );
  const requestStatus =
    requestState === "graphRequestPending"
      ? `Index request sent from this view · ${agentDurationLabel(requestElapsedMs)} elapsed. WTS has no persisted indexing phase, and Graphify admission or process start are not reported by this API.`
      : requestState === "agentRequestPending"
        ? `Run request sent from this view · ${agentDurationLabel(requestElapsedMs)} elapsed. Provider admission and process start are not reported by this API.`
        : message;
  const providerBoundary =
    provider === "codex"
      ? "Codex runs with WTS workspace-write sandboxing. Provider sign-in still remains Codex-owned."
      : `${providerFromView[provider]} keeps provider-owned confinement and permission behavior; WTS sets this workspace as its working directory.`;

  if (!materialization) {
    return (
      <AdapterPlaceholder
        eyebrow="WORKSPACE ASSISTANT"
        title="Create the worktrees before delegating"
        description="The assistant only starts an agent after WTS has a verified, materialized workspace boundary."
        next="Review and create the workspace in Overview, then return to Assistant."
      />
    );
  }

  return (
    <section
      aria-busy={requestPending || undefined}
      aria-labelledby="workspace-assistant-title"
      className={styles.agentWorkspacePanel}
      data-ui="workspace-overview.assistant"
      data-ui-label="Workspace assistant"
    >
      <header className={styles.agentPanelHeader}>
        <span className={styles.adapterIcon}>
          <Glyph name="terminal" size={22} />
        </span>
        <div>
          <small>ON-DEMAND WORKSPACE ASSISTANT</small>
          <h2 id="workspace-assistant-title">
            Work with an agent inside {workspace.key}
          </h2>
          <p>
            WTS starts the selected provider with this workspace as its working
            directory only after you submit. The local index is not injected
            automatically; ask the provider to read{" "}
            <code>graphify-out/graph.json</code> when you want it used.
          </p>
        </div>
        {graphReady && (
          <span
            aria-label="Workspace index available at graphify-out/graph.json"
            className={styles.agentBoundaryBadge}
          >
            Index available
          </span>
        )}
      </header>

      {!graphReady && (
        <section
          aria-labelledby="assistant-index-required-title"
          className={styles.graphActionCard}
        >
          <span className={styles.graphTile}>
            <Glyph name="code" size={17} />
          </span>
          <div>
            <b id="assistant-index-required-title">Workspace index required</b>
            <small>
              Graphify writes a local structural index to{" "}
              <code>graphify-out/graph.json</code> without calling an LLM.
            </small>
          </div>
          <button
            className={styles.secondaryAction}
            disabled={requestPending}
            onClick={() => void indexGraph()}
            type="button"
          >
            {requestState === "graphRequestPending"
              ? "Request pending…"
              : "Build index"}
          </button>
        </section>
      )}

      <form className={styles.agentComposer} onSubmit={runAgent}>
        <fieldset disabled={requestPending}>
          <legend>Provider</legend>
          <div className={styles.agentProviderPicker}>
            {(["codex", "openCode", "hermes"] as const).map((item) => (
              <button
                aria-pressed={provider === item}
                key={item}
                onClick={() => setProvider(item)}
                type="button"
              >
                <span>{providerMarks[providerFromView[item]]}</span>
                {providerFromView[item]}
              </button>
            ))}
          </div>
        </fieldset>
        <label htmlFor="agent-prompt">Task for the agent</label>
        <div
          aria-label="Quick prompt starters"
          className={styles.agentPromptStarters}
          role="group"
        >
          {promptStarters.map((starter) => (
            <button
              disabled={requestPending}
              key={starter.label}
              onClick={() => setPrompt(starter.prompt)}
              type="button"
            >
              {starter.label}
            </button>
          ))}
        </div>
        <textarea
          disabled={requestPending}
          id="agent-prompt"
          maxLength={16_384}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Describe the change, investigation, or test you want completed…"
          rows={6}
          value={prompt}
        />
        <div className={styles.agentComposerFooter}>
          <span>
            <Glyph name="warning" size={13} />
            {providerBoundary}
          </span>
          <button
            className={styles.primaryAction}
            disabled={!canRun}
            type="submit"
          >
            <Glyph name="play" size={13} />
            {requestState === "agentRequestPending"
              ? "Request pending…"
              : `Run ${providerFromView[provider]}`}
          </button>
        </div>
      </form>

      {requestStatus && (
        <p
          aria-atomic="true"
          aria-live={requestState === "error" ? "assertive" : "polite"}
          className={styles.agentMessage}
          data-error={requestState === "error" || undefined}
          role={requestState === "error" ? "alert" : "status"}
        >
          {requestStatus}
        </p>
      )}

      <details
        aria-labelledby="assistant-activity-title"
        className={styles.agentActivity}
        onToggle={(event) => setActivityOpen(event.currentTarget.open)}
        open={activityOpen}
      >
        <summary>
          <div>
            <small>VERBOSE LOCAL EVIDENCE</small>
            <h3 id="assistant-activity-title">Activity</h3>
          </div>
          <span>
            {evidenceState === "loading"
              ? "Reading…"
              : `${graphEvidence ? "1 index · " : ""}${recentRuns.length} run${recentRuns.length === 1 ? "" : "s"}`}
          </span>
        </summary>
        {graphEvidence && (
          <article
            className={styles.agentGraphEvidence}
            data-state={graphEvidence.status}
          >
            <header>
              <span className={styles.graphTile}>
                <Glyph name="code" size={15} />
              </span>
              <div>
                <h4>Graph index</h4>
                <p>{graphEvidence.detail}</p>
              </div>
              <strong>
                {graphEvidence.status === "ready"
                  ? "Available"
                  : graphEvidence.status === "failed"
                    ? "Failed"
                    : "Not started"}
              </strong>
            </header>
            <dl>
              <div>
                <dt>Indexed</dt>
                <dd>
                  {graphEvidence.indexedAtUnixMs === null ? (
                    "Not recorded"
                  ) : (
                    <time
                      dateTime={agentTimestampValue(
                        graphEvidence.indexedAtUnixMs,
                      )}
                    >
                      {agentTimestampLabel(graphEvidence.indexedAtUnixMs)}
                    </time>
                  )}
                </dd>
              </div>
              <div>
                <dt>Graph path</dt>
                <dd>
                  <code>
                    {graphEvidence.graphDisplayPath ?? "Not recorded"}
                  </code>
                </dd>
              </div>
              <div>
                <dt>Graph SHA-256</dt>
                <dd>
                  <code>{graphEvidence.graphSha256 ?? "Not recorded"}</code>
                </dd>
              </div>
            </dl>
            <p className={styles.agentGraphFreshness}>
              This is the latest retained index evidence. Current worktree
              freshness is not asserted here.
            </p>
          </article>
        )}
        {evidenceState === "error" && (
          <p className={styles.agentActivityEmpty} data-error>
            Durable activity is unavailable. {evidenceError}
          </p>
        )}
        {evidenceState !== "error" && recentRuns.length === 0 && (
          <p className={styles.agentActivityEmpty}>
            {evidenceState === "loading"
              ? "Reading retained run summaries from this workspace…"
              : "No retained agent runs for this workspace yet."}
          </p>
        )}
        {recentRuns.length > 0 && (
          <ol
            aria-label="Recent durable agent runs"
            className={styles.agentActivityList}
          >
            {recentRuns.map((run) => {
              const failure = agentRunFailureLabel(run.failure);
              return (
                <li data-state={run.state} key={run.runId}>
                  <span
                    aria-hidden="true"
                    className={styles.agentActivityDot}
                  />
                  <div className={styles.agentActivityRun}>
                    <div className={styles.agentActivityTitle}>
                      <b>{providerFromView[run.provider]}</b>
                      <span>{agentRunStateLabel(run.state)}</span>
                      {failure && <em>{failure}</em>}
                    </div>
                    <dl>
                      <div>
                        <dt>Run ID</dt>
                        <dd>
                          <code>{run.runId}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Started</dt>
                        <dd>
                          <time
                            dateTime={agentTimestampValue(run.startedAtUnixMs)}
                          >
                            {agentTimestampLabel(run.startedAtUnixMs)}
                          </time>
                        </dd>
                      </div>
                      <div>
                        <dt>Completed</dt>
                        <dd>
                          {run.completedAtUnixMs === null ? (
                            "Not recorded"
                          ) : (
                            <time
                              dateTime={agentTimestampValue(
                                run.completedAtUnixMs,
                              )}
                            >
                              {agentTimestampLabel(run.completedAtUnixMs)}
                            </time>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Duration</dt>
                        <dd>{agentDurationLabel(run.durationMs)}</dd>
                      </div>
                      <div>
                        <dt>Prompt SHA-256</dt>
                        <dd>
                          <code>{run.promptSha256}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Output SHA-256</dt>
                        <dd>
                          <code>{run.outputSha256 ?? "Not recorded"}</code>
                        </dd>
                      </div>
                    </dl>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p className={styles.agentActivityNote}>
          <Glyph name="file" size={13} />
          “Accepted / preparing” is durable WTS evidence. It does not confirm
          that a provider process has spawned.
        </p>
      </details>

      {result && (
        <section
          aria-labelledby="agent-current-output-title"
          className={styles.agentOutput}
          data-ui="workspace-overview.agent-output"
          data-ui-label="Agent response"
        >
          <header>
            <span aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <h3 id="agent-current-output-title">
              Current response — not retained
            </h3>
            <small>{providerFromView[result.provider]}</small>
          </header>
          <pre
            aria-label={`${providerFromView[result.provider]} current response, not retained`}
            role="region"
            tabIndex={0}
          >
            {result.output}
          </pre>
        </section>
      )}
    </section>
  );
}

type CliPanelState =
  "idle" | "launching" | "openingVscode" | "accepted" | "error";

const cliProviderCommands: Record<AgentProvider, string> = {
  codex: "codex --sandbox workspace-write --ask-for-approval on-request",
  openCode: "opencode .",
  hermes: "hermes chat --tui",
  copilot: "copilot",
};

const terminalNames: Record<TerminalProvider, string> = {
  terminal: "Terminal",
  warp: "Warp",
};

function providerSetupLabel(
  provider: AgentProvider,
  integrations: SetupSnapshot["integrations"] | undefined,
): string {
  const integration = integrations?.find((item) => item.id === provider);
  if (!integration) return "Setup not checked";
  if (integration.installation === "missing") return "Not detected";
  if (integration.setup === "needsAuth") return "Sign-in handled by CLI";
  if (integration.status === "ready") {
    return integration.version
      ? `Detected · ${integration.version}`
      : "Detected";
  }
  return integration.detail || "Detected · setup may be required";
}

function WorkspaceCliPanel({
  workspace,
  materialization,
  onOpenCli,
  onOpenVscode,
  draft,
  onRetryBrief,
  focusRevision,
  integrations,
}: {
  workspace: Workspace;
  materialization: WorkspaceMaterialization | null;
  onOpenCli: (
    provider: AgentProvider,
    terminal: TerminalProvider,
  ) => Promise<WorkspaceCliLaunchResult>;
  onOpenVscode: () => Promise<boolean>;
  draft: {
    prompt: string;
    revision: number;
    briefState: "saving" | "ready" | "error";
    briefDisplayPath?: string;
    briefError?: string;
  } | null;
  onRetryBrief: () => void;
  focusRevision: number;
  integrations?: SetupSnapshot["integrations"];
}) {
  const preferred: AgentProvider =
    workspace.provider === "OpenCode"
      ? "openCode"
      : workspace.provider === "Hermes"
        ? "hermes"
        : workspace.provider === "Copilot"
          ? "copilot"
          : "codex";
  const [provider, setProvider] = useState<AgentProvider>(preferred);
  const warpIntegration = integrations?.find((item) => item.id === "warp");
  const warpAvailable =
    warpIntegration?.installation === "detected" &&
    warpIntegration.status !== "error";
  const preferredTerminal = preferredTerminalProvider(integrations);
  const [terminal, setTerminal] = useState<TerminalProvider>(preferredTerminal);
  const [state, setState] = useState<CliPanelState>("idle");
  const [message, setMessage] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pending = state === "launching" || state === "openingVscode";

  useEffect(() => {
    setProvider(preferred);
    setTerminal(preferredTerminal);
    setState("idle");
    setMessage("");
  }, [preferred, preferredTerminal, workspace.id]);

  useEffect(() => {
    if (focusRevision > 0) {
      headingRef.current?.focus();
    }
  }, [focusRevision]);

  const copyValue = async (value: string, success: string, announce = true) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(value);
      if (announce) {
        setState("idle");
        setMessage(success);
      }
      return true;
    } catch {
      setState("error");
      setMessage("Could not copy. Select the text manually.");
      return false;
    }
  };

  const openCli = async (requestedProvider: AgentProvider) => {
    if (!materialization || pending) return;
    const requestedTerminal = terminal;
    const terminalName = terminalNames[requestedTerminal];
    setProvider(requestedProvider);
    setState("launching");
    setMessage(
      `Requesting a new ${terminalName} window for ${providerFromView[requestedProvider]}…`,
    );
    try {
      const result = await onOpenCli(requestedProvider, requestedTerminal);
      if (
        result.workspaceId !== workspace.id ||
        result.provider !== requestedProvider ||
        result.terminal !== requestedTerminal ||
        result.workspaceDisplayPath !== materialization.workspaceDisplayPath ||
        !result.accepted
      ) {
        throw new Error("WTS returned a mismatched CLI launch handoff.");
      }
      setState("accepted");
      setMessage(
        draft
          ? `${providerFromView[requestedProvider]} opened in ${terminalName}. The agent can read WTS.md from the workspace root.`
          : `${providerFromView[requestedProvider]} opened in ${terminalName} at the workspace root.`,
      );
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error
          ? error.message
          : `${terminalName} did not accept the CLI launch.`,
      );
    }
  };

  const openVscode = async () => {
    if (pending) return;
    setState("openingVscode");
    setMessage("Opening the workspace in VS Code…");
    const opened = await onOpenVscode();
    if (!opened) {
      setState("error");
      setMessage(
        draft
          ? "VS Code could not open the workspace. WTS.md remains saved at the workspace root."
          : "VS Code could not open the workspace.",
      );
      return;
    }
    setState("accepted");
    setMessage(
      draft
        ? "Workspace opened in VS Code. WTS.md remains the durable agent brief at the workspace root."
        : "Workspace opened in VS Code.",
    );
  };

  if (!materialization) {
    return (
      <AdapterPlaceholder
        eyebrow="WORKSPACE CLI"
        title="Create the worktrees before opening a CLI"
        description="WTS launches an interactive provider only after it has validated the materialized workspace boundary."
        next="Review and create the workspace in Overview, then return to CLI."
      />
    );
  }

  return (
    <section
      aria-busy={pending || undefined}
      aria-labelledby="workspace-cli-title"
      className={styles.workspaceCliPanel}
      data-ui="workspace-launcher.panel"
      data-ui-label="Workspace launcher"
    >
      <header className={styles.cliPanelHeader}>
        <span className={styles.cliPanelIcon}>
          <Glyph name="terminal" size={22} />
        </span>
        <div>
          <small>WORKSPACE CLI</small>
          <h2 id="workspace-cli-title" ref={headingRef} tabIndex={-1}>
            Start an agent in {workspace.key}
          </h2>
          <p>
            Reopen this workspace directly in an editor or agent. Every launch
            uses the same workspace root.
          </p>
        </div>
      </header>

      <div
        className={styles.cliWorkspaceContext}
        data-ui="workspace-launcher.location"
        data-ui-label="Workspace location"
      >
        <span>
          <small>WORKING DIRECTORY</small>
          <InfoTooltip content={materialization.workspaceDisplayPath}>
            <code tabIndex={0}>
              {materialization.workspaceDisplayPath}
            </code>
          </InfoTooltip>
        </span>
        <Button
          isDisabled={pending}
          onPress={() =>
            void copyValue(
              materialization.workspaceDisplayPath,
              "Workspace path copied.",
            )
          }
        >
          <Glyph name="copy" size={13} /> Copy path
        </Button>
      </div>

      <div className={styles.cliLaunchLayout}>
        <section
          aria-labelledby="cli-provider-title"
          className={styles.cliLaunchCard}
          data-ui="workspace-launcher.apps"
          data-ui-label="Open workspace options"
        >
          <div className={styles.cliSectionHeading}>
            <span>
              <small>OPEN WITH</small>
              <h3 id="cli-provider-title">Open this workspace</h3>
            </span>
            <small>Agents open in {terminalNames[terminal]}</small>
          </div>

          <div
            aria-label="Open workspace with"
            className={styles.cliProviderPicker}
            role="group"
          >
            <button
              aria-label={
                draft
                  ? `Open ${providerFromView[preferred]} with WTS.md`
                  : `Open ${providerFromView[preferred]}`
              }
              data-primary
              disabled={
                pending || (draft !== null && draft.briefState !== "ready")
              }
              onClick={() => void openCli(preferred)}
              type="button"
            >
              <span>{providerMarks[providerFromView[preferred]]}</span>
              <b>
                {state === "launching" && provider === preferred
                  ? `Opening ${providerFromView[preferred]}…`
                  : `Open ${providerFromView[preferred]} in ${terminalNames[terminal]}`}
              </b>
              <small>{providerSetupLabel(preferred, integrations)}</small>
            </button>
            <button
              aria-label="Open workspace in VS Code"
              data-editor
              disabled={pending}
              onClick={() => void openVscode()}
              type="button"
            >
              <span>{providerMarks["VS Code"]}</span>
              <b>
                {state === "openingVscode"
                  ? "Opening VS Code…"
                  : "Open VS Code"}
              </b>
              <small>Existing multi-root workspace</small>
            </button>
            <div className={styles.cliAlternatives}>
              <small>OTHER AGENTS</small>
              {(["codex", "openCode", "hermes"] as const)
                .filter((item) => item !== preferred)
                .map((item) => (
                  <button
                    aria-label={
                      draft
                        ? `Open ${providerFromView[item]} with WTS.md`
                        : `Open ${providerFromView[item]}`
                    }
                    disabled={
                      pending ||
                      (draft !== null && draft.briefState !== "ready")
                    }
                    key={item}
                    onClick={() => void openCli(item)}
                    type="button"
                  >
                    <span>{providerMarks[providerFromView[item]]}</span>
                    <b>
                      {state === "launching" && provider === item
                        ? `Opening ${providerFromView[item]}…`
                        : `Open ${providerFromView[item]}`}
                    </b>
                    <small>{providerSetupLabel(item, integrations)}</small>
                  </button>
                ))}
            </div>
          </div>

          <div className={styles.cliTerminalRow}>
            <span>
              <small>TERMINAL</small>
              <b>Open the session in</b>
            </span>
            <div aria-label="Terminal application" role="group">
              {(["warp", "terminal"] as const).map((item) => (
                <InfoTooltip
                  key={item}
                  content={
                    item === "warp" && !warpAvailable
                      ? "Warp.app was not detected in Applications"
                      : pending
                        ? "CLI launch in progress"
                        : undefined
                  }
                >
                  <Button
                    aria-pressed={terminal === item}
                    isDisabled={pending || (item === "warp" && !warpAvailable)}
                    onPress={() => {
                      setTerminal(item);
                      setMessage("");
                      setState("idle");
                    }}
                  >
                    {item === "warp" ? "WP" : ">_"}
                    <span>{terminalNames[item]}</span>
                    {item === "warp" && warpAvailable && <small>Detected</small>}
                  </Button>
                </InfoTooltip>
              ))}
            </div>
          </div>

          <p className={styles.cliLaunchNote}>
            Agent buttons open a foreground {terminalNames[terminal]} session.
            VS Code reopens the existing multi-root workspace.
          </p>
        </section>
      </div>

      {draft && (
        <section
          aria-labelledby="prepared-cli-task-title"
          className={styles.cliPreparedTask}
          data-ui="workspace-launcher.task"
          data-ui-label="Prepared agent task"
        >
          <span className={styles.cliPreparedTaskIcon}>
            <Glyph name="code" size={17} />
          </span>
          <div className={styles.cliPreparedTaskCopy}>
            <small>PREPARED FROM VERIFICATION</small>
            <h3 id="prepared-cli-task-title">
              {draft.briefState === "saving"
                ? "Saving WTS.md…"
                : draft.briefState === "error"
                  ? "WTS.md could not be saved"
                  : "WTS.md is ready"}
            </h3>
            <p>
              {draft.briefState === "ready"
                ? `The durable brief is saved outside the repository worktrees at ${draft.briefDisplayPath ?? "the workspace root"}. Agents opened here read it first.`
                : draft.briefState === "error"
                  ? draft.briefError
                  : "WTS is atomically updating the workspace-owned agent brief."}
            </p>
            <details className={styles.cliPreparedTaskPreview}>
              <summary>Review prepared prompt</summary>
              <pre aria-label="Prepared CLI task">{draft.prompt}</pre>
            </details>
          </div>
          {draft.briefState === "error" && (
            <div className={styles.cliPreparedTaskActions}>
              <button
                className={styles.secondaryAction}
                disabled={pending}
                onClick={onRetryBrief}
                type="button"
              >
                Save WTS.md again
              </button>
            </div>
          )}
        </section>
      )}

      {message && (
        <div className={styles.cliPanelMessages}>
          <p
            aria-live={state === "error" ? "assertive" : "polite"}
            data-error={state === "error" || undefined}
            role={state === "error" ? "alert" : "status"}
          >
            {message}
          </p>
        </div>
      )}

      <details className={styles.cliLaunchDetails}>
        <summary>Launch details</summary>
        <dl>
          <div>
            <dt>Provider command</dt>
            <dd>
              <code>{cliProviderCommands[provider]}</code>
            </dd>
          </div>
          <div>
            <dt>Process owner</dt>
            <dd>{terminalNames[terminal]} after handoff</dd>
          </div>
          <div>
            <dt>WTS lifecycle visibility</dt>
            <dd>Launch accepted or rejected only</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

export interface LocalWorkspaceProps {
  initialView?: "board" | "workbench" | "time" | "reviews" | "updates";
  initialWorkspaceId?: string;
  initialWorkbenchTab?: WorkbenchTab;
  initialCreateOpen?: boolean;
  client?: WorkspaceClient;
}

export function LocalWorkspace({
  initialView = "board",
  initialWorkspaceId,
  initialWorkbenchTab = "overview",
  initialCreateOpen = false,
  client = defaultWorkspaceClient,
}: LocalWorkspaceProps = {}) {
  const { resolvedTheme, toggleTheme } = useTheme();
  const { preference: workspaceCardClickPreference } =
    useWorkspaceCardClickPreference();
  const materializationCache = useMemo(
    () => materializationCacheFor(client),
    [client],
  );
  const navigationCache = useMemo(() => navigationCacheFor(client), [client]);
  const scrollCache = useMemo(() => scrollCacheFor(client), [client]);
  const workbenchScrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<
    "board" | "workbench" | "time" | "reviews" | "updates"
  >(initialView);
  const myReviews = useGithubReviewInbox(client);
  const assignedReviewCount =
    (myReviews.inbox?.reviews.length ?? 0) +
    (myReviews.gitlabInbox?.reviews.length ?? 0);
  const appUpdate = useAppUpdate(client);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const agentNavigationWorkspacesRef = useRef(workspaces);
  agentNavigationWorkspacesRef.current = workspaces;
  const [draggedWorkspaceId, setDraggedWorkspaceId] = useState<string | null>(null);
  const [workspaceDropPreview, setWorkspaceDropPreview] =
    useState<WorkspaceBoardPlacement | null>(null);
  const workspaceDropPreviewRef = useRef<WorkspaceBoardPlacement | null>(null);
  const workspaceDragPointerYRef = useRef<number | null>(null);
  const [legacyWorkspaceBoardOrder, setLegacyWorkspaceBoardOrder] =
    useState<WorkspaceBoardOrder>(() => loadWorkspaceBoardOrder());
  const [workspaceBoardSessionOrder, setWorkspaceBoardSessionOrder] =
    useState<WorkspaceBoardOrder | null>(null);
  const boardSensors = useSensors(
    useSensor(KeyboardSensor, {
      coordinateGetter: workspaceBoardKeyboardCoordinates,
    }),
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );
  const [workspaceAgents, setWorkspaceAgents] = useState(
    () => new Map<string, WorkspaceAgentSnapshot>(),
  );
  const attentionStore = useMemo(() => getWorkspaceAttentionStore(client), [client]);
  const attentionInboxes = useWorkspaceAttention(attentionStore,
    snapshot => Object.fromEntries(Object.entries(snapshot.inboxes).filter(([, inbox]) => inbox.mergeRequests.length > 0)),
    (left, right) => Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([id, inbox]) =>
      right[id]?.state === inbox.state && JSON.stringify(right[id]?.mergeRequests) === JSON.stringify(inbox.mergeRequests)));
  const workspaceGitlabInboxes = useMemo(() => new Map(Object.entries(attentionInboxes)), [attentionInboxes]);
  const attentionClientRef = useRef(client);
  attentionClientRef.current = client;
  const [verificationSelection, setVerificationSelection] = useState<VerificationAttentionSelection>();
  const attentionInputKey = JSON.stringify(workspaces.map(workspace => [workspace.id,
    workspace.lifecycleState === "materialized" || workspace.lifecycleState === "needsAttention"]));
  const attentionWorkspaces = useMemo(() => (JSON.parse(attentionInputKey) as [string, boolean][])
    .map(([workspaceId, materialized]) => ({ workspaceId, materialized })), [attentionInputKey]);

  const [workspaceNameEditing, setWorkspaceNameEditing] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [workspaceNameSaving, setWorkspaceNameSaving] = useState(false);
  const [workspaceNameError, setWorkspaceNameError] = useState("");
  const [selectedId, setSelectedId] = useState(initialWorkspaceId ?? "");
  const [registryState, setRegistryState] = useState<RegistryState>("loading");
  const [registryError, setRegistryError] = useState("");
  const refreshAttention = useCallback((force = false) => {
    if (view !== "board" || registryState !== "ready" || document.visibilityState === "hidden") return;
    void attentionStore.refresh(attentionWorkspaces, { force });
  }, [attentionStore, attentionWorkspaces, registryState, view]);
  useEffect(() => {
    refreshAttention();
    const onFocus = () => refreshAttention();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refreshAttention]);
  useVisiblePolling(refreshAttention, 60_000, { enabled: view === "board" && registryState === "ready" });

  const [deepLinkState, setDeepLinkState] = useState<DeepLinkState>(
    initialWorkspaceId ? "loading" : "idle",
  );
  const [deepLinkError, setDeepLinkError] = useState("");
  const [deepLinkRevision, setDeepLinkRevision] = useState(0);
  const [workspaceRootDisplayPath, setWorkspaceRootDisplayPath] = useState(
    "Configured local root",
  );
  const [reloadRevision, setReloadRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [searchExpanded, setSearchExpanded] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [createOpen, setCreateOpen] = useState(initialCreateOpen);
  const [feedbackSelectionReturn, setFeedbackSelectionReturn] = useState<FeedbackSelectionReturn>();
  const feedbackReturnNavigationRef = useRef(-1);
  const [deferredWorkspaceCreations, setDeferredWorkspaceCreations] = useState<
    DeferredWorkspaceCreation[]
  >([]);
  const [resumedWorkspaceCreationId, setResumedWorkspaceCreationId] =
    useState("");
  const repositoryCloneRecordsRef = useRef(
    new Map<string, RepositoryCloneRecord>(),
  );
  const repositoryCloneSequenceRef = useRef(0);
  const [addRepositoryOpen, setAddRepositoryOpen] = useState(false);
  const [createTemplateWorkspaceId, setCreateTemplateWorkspaceId] =
    useState("");
  const [createRepositoryBaseOverrides, setCreateRepositoryBaseOverrides] =
    useState<Record<string, string>>({});
  const [createPlanningEnabled, setCreatePlanningEnabled] = useState<
    boolean | undefined
  >(undefined);
  const [reviewWorkspaceSeed, setReviewWorkspaceSeed] =
    useState<ReviewWorkspaceSeed | null>(null);
  const [preparingReviewId, setPreparingReviewId] = useState("");
  const [openingAssignedReviewId, setOpeningAssignedReviewId] = useState("");
  const [reviewWorkspaceErrors, setReviewWorkspaceErrors] = useState(
    () => new Map<string, string>(),
  );
  const preparingReviewIdRef = useRef("");
  const reviewWorkspaceHydrationSkipsRef = useRef(new Set<string>());
  const reviewWorkspaceCreationKeysRef = useRef(new Map<string, string>());
  const reviewWorkspaceMaterializationKeysRef = useRef(
    new Map<string, string>(),
  );
  const [guideOpen, setGuideOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandActiveIndex, setCommandActiveIndex] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const [removalOpen, setRemovalOpen] = useState(false);
  const [removalState, setRemovalState] = useState<
    "loading" | "ready" | "repairing" | "removing" | "error"
  >("loading");
  const [removalPreflight, setRemovalPreflight] =
    useState<WorkspaceRemovalPreflight | null>(null);
  const [removalError, setRemovalError] = useState("");
  const [workspaceCommandState, setWorkspaceCommandState] =
    useState<WorkspaceCommandState>("idle");
  const [setupSnapshot, setSetupSnapshot] = useState<SetupSnapshot | null>(
    null,
  );
  const [repositoryCatalog, setRepositoryCatalog] =
    useState<RepositoryCatalog | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);
  const [setupError, setSetupError] = useState("");
  const [setupRevision, setSetupRevision] = useState(0);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>(initialWorkbenchTab);
  // The Changes view puts the MR title and selectors here when the workspace reviews an MR.
  const [identitySlot, setIdentitySlot] = useState<HTMLElement | null>(null);
  const [reviewRepositoryId, setReviewRepositoryId] = useState(
    () => new URLSearchParams(globalThis.location?.search ?? "").get("repository") ?? "",
  );
  const [openWorkspaceLauncherOpen, setOpenWorkspaceLauncherOpen] =
    useState(false);
  const [cliDraft, setCliDraft] = useState<{
    workspaceId: string;
    prompt: string;
    revision: number;
    briefState: "saving" | "ready" | "error";
    briefDisplayPath?: string;
    briefError?: string;
  } | null>(null);
  const [toasts, setToasts] = useState<NoticeToast[]>([
    {
      id: "init",
      message: "Opening the local workspace registry…",
      kind: "info",
    },
  ]);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const pushNotice = useCallback(
    (message: string, kind: "info" | "error" = "info") => {
      if (!message) return;
      const id =
        Math.random().toString(36).substring(2) + Date.now().toString(36);
      setToasts((current) => [...current, { id, message, kind }].slice(-3));
    },
    [],
  );

  const setNotice = useCallback(
    (message: string, kind: "info" | "error" = "info") => {
      pushNotice(message, kind);
    },
    [pushNotice],
  );
  const [workspaceActionState, setWorkspaceActionState] =
    useState<WorkspaceActionState>("idle");
  const [workspacePreflight, setWorkspacePreflight] =
    useState<WorkspacePreflight | null>(null);
  const [materializationState, setMaterializationState] = useState<{
    client: WorkspaceClient;
    value: WorkspaceMaterialization | null;
  }>({ client, value: null });
  const workspaceMaterialization =
    materializationState.client === client &&
    materializationState.value?.workspaceId === selectedId
      ? materializationState.value
      : materializationCache.get(selectedId) ?? null;
  const setWorkspaceMaterialization = useCallback((value: WorkspaceMaterialization | null) => {
    setMaterializationState({ client, value });
  }, [client]);
  const [workspaceEvidenceRefreshing, setWorkspaceEvidenceRefreshing] =
    useState(false);
  const [workspaceActionError, setWorkspaceActionError] = useState("");
  const [workspaceActionErrorCode, setWorkspaceActionErrorCode] = useState("");
  const cliDraftRevisionRef = useRef(0);
  const materializationKeyRef = useRef<{
    digest: string;
    key: string;
  } | null>(null);
  const workspaceActionGenerationRef = useRef(0);
  const setupRecoveryPendingRef = useRef(new Set<string>());
  const removalGenerationRef = useRef(0);
  const removalKeyRef = useRef<{
    digest: string;
    key: string;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const commandInputRef = useRef<HTMLInputElement>(null);
  const commandReturnFocusRef = useRef<HTMLElement>(null);
  const newWorkspaceButtonRef = useRef<HTMLButtonElement>(null);
  const boardHeadingRef = useRef<HTMLHeadingElement>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null);
  const workbenchHeadingRef = useRef<HTMLHeadingElement>(null);
  const workspaceCardRefs = useRef(new Map<string, HTMLButtonElement>());
  const scheduledAutomationEventsRef = useRef(new Set<string>());
  const pendingWorkspaceNotificationsRef = useRef(new Set<string>());
  const gitlabWorkflowObservationsRef = useRef(new Map<string, string>());
  const gitlabReviewWorkflowObservationsRef = useRef(new Map<string, string>());
  const pendingGitlabWorkflowTransitionsRef = useRef(new Set<string>());
  const pendingBoardFocusRef = useRef<string | null | undefined>(undefined);
  const cancelWorkspaceRenameRef = useRef(false);
  const workspaceRenameGenerationRef = useRef(0);
  const workspaceRenamePendingRef = useRef(false);
  const workspaceRenameClientRef = useRef(client);
  workspaceRenameClientRef.current = client;
  const deepLinkGenerationRef = useRef(0);
  const agentNavigationGenerationRef = useRef(0);
  const deepLinkEnabledRef = useRef(Boolean(initialWorkspaceId));
  const deepLinkTargetRef = useRef(initialWorkspaceId);
  const pendingRecoveryFocusRef = useRef(false);
  const historySwipeRef = useRef({
    deltaX: 0,
    lastEventAt: 0,
    lastNavigationAt: 0,
  });
  const historyTouchRef = useRef({
    active: false,
    edge: null as "left" | "right" | null,
    lastX: 0,
    lastY: 0,
    startX: 0,
    startY: 0,
    target: null as EventTarget | null,
  });
  const closeCommandPalette = useCallback(() => {
    setCommandOpen(false);
    setCommandQuery("");
    setCommandActiveIndex(0);
  }, []);
  const openCommandPalette = useCallback(() => {
    const activeElement = globalThis.document?.activeElement;
    commandReturnFocusRef.current =
      activeElement instanceof HTMLElement ? activeElement : null;
    setCommandQuery("");
    setCommandActiveIndex(0);
    setCommandOpen(true);
  }, []);
  const workspaceIdsKey = workspaces
    .map(
      (workspace) =>
        `${workspace.id}:${workspace.workflowState}:${workspace.workflowRevision}`,
    )
    .sort()
    .join(",");

  const invalidateDeepLinkLookup = () => {
    agentNavigationGenerationRef.current += 1;
    if (!initialWorkspaceId) return;
    deepLinkEnabledRef.current = false;
    deepLinkGenerationRef.current += 1;
    setDeepLinkError("");
    setDeepLinkState("idle");
  };

  useLayoutEffect(() => {
    workspaceRenameGenerationRef.current += 1;
    workspaceRenamePendingRef.current = false;
    cancelWorkspaceRenameRef.current = false;
    setWorkspaceNameEditing(false);
    setWorkspaceNameSaving(false);
    setWorkspaceNameDraft("");
    setWorkspaceNameError("");
  }, [client, selectedId, view]);

  useEffect(() => {
    let current = true;
    if (deepLinkTargetRef.current !== initialWorkspaceId) {
      deepLinkTargetRef.current = initialWorkspaceId;
      deepLinkEnabledRef.current = Boolean(initialWorkspaceId);
      deepLinkGenerationRef.current += 1;
    }
    const shouldResolveDeepLink = Boolean(
      initialWorkspaceId && deepLinkEnabledRef.current,
    );
    setRegistryState("loading");
    setRegistryError("");
    setDeepLinkError("");
    setDeepLinkState(shouldResolveDeepLink ? "loading" : "idle");

    const loadRegistry = async () => {
      try {
        const list = await client.listWorkspaces();
        if (!current) return;

        const nextWorkspaces = list.workspaces.map((workspace) =>
          workspaceFromView(workspace),
        );
        const resolveDeepLinkNow = Boolean(
          shouldResolveDeepLink &&
          deepLinkEnabledRef.current &&
          deepLinkTargetRef.current === initialWorkspaceId,
        );
        const listedWorkspace = resolveDeepLinkNow
          ? nextWorkspaces.find(
              (workspace) => workspace.id === initialWorkspaceId,
            )
          : undefined;
        const selected = resolveDeepLinkNow
          ? listedWorkspace
          : nextWorkspaces[0];

        setWorkspaceRootDisplayPath(list.workspaceRootDisplayPath);
        setWorkspaceBoardSessionOrder(null);
        setWorkspaces(nextWorkspaces);
        setSelectedId((currentId) =>
          resolveDeepLinkNow
            ? (initialWorkspaceId ?? "")
            : nextWorkspaces.some((workspace) => workspace.id === currentId)
              ? currentId
              : (selected?.id ?? ""),
        );
        setDeepLinkState(
          resolveDeepLinkNow ? (listedWorkspace ? "ready" : "loading") : "idle",
        );
        setToasts((current) => current.filter((toast) => toast.id !== "init"));
        setRegistryState("ready");
        if (resolveDeepLinkNow) setView("workbench");
      } catch (error) {
        if (!current) return;
        setRegistryError(
          error instanceof Error
            ? error.message
            : "The local workspace registry could not be opened.",
        );
        setRegistryState("error");
        setToasts((current) => current.filter((toast) => toast.id !== "init"));
        setNotice("Local registry unavailable");
      }
    };

    void loadRegistry();
    return () => {
      current = false;
    };
  }, [client, initialWorkspaceId, reloadRevision]);

  useEffect(() => {
    if (view === "time" || registryState !== "ready" || !workspaceIdsKey) {
      return;
    }

    let current = true;
    let refreshTimer: number | undefined;
    const automationTimers = new Set<number>();
    const scheduleAgentRefresh = () => {
      if (!current || refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refreshAgentOverview();
      }, 5_000);
    };
    const refreshAgentOverview = async () => {
      try {
        const sessions = await loadAgentSessions(client);
        if (current) {
          const snapshots = buildWorkspaceAgentSnapshots(sessions);
          setWorkspaceAgents(snapshots);
          for (const [workspaceId, snapshot] of snapshots) {
            const workspace = workspaces.find(
              (candidate) => candidate.id === workspaceId,
            );
            if (!workspace) continue;
            const notification = notificationForWorkspaceAgent(
              workspace.title,
              snapshot,
            );
            if (
              notification &&
              loadTimeReviewSchedule().notificationsEnabled &&
              !workspaceNotificationWasSent(
                workspaceId,
                snapshot.lastEventAtUnixMs,
              ) &&
              !pendingWorkspaceNotificationsRef.current.has(
                `${workspaceId}:${snapshot.lastEventAtUnixMs}`,
              )
            ) {
              const notificationKey = `${workspaceId}:${snapshot.lastEventAtUnixMs}`;
              pendingWorkspaceNotificationsRef.current.add(notificationKey);
              void sendDesktopNotification(
                notification.title,
                notification.body,
                `wts-workspace-${workspaceId}`,
              ).then((sent) => {
                pendingWorkspaceNotificationsRef.current.delete(
                  notificationKey,
                );
                if (sent) {
                  markWorkspaceNotificationSent(
                    workspaceId,
                    snapshot.lastEventAtUnixMs,
                  );
                } else {
                  scheduleAgentRefresh();
                }
              });
            }
            const automation = loadWorkspaceAutomation();
            const automationEventKey = `${workspaceId}:${snapshot.lastEventAtUnixMs}`;
            if (
              snapshot.updateKind === "completion" &&
              workspace.lifecycleState === "materialized" &&
              workspace.workflowState !== "parked" &&
              (automation.automaticVerification ||
                automation.automaticAgentReview) &&
              workspaceCompletionIsRecent(
                snapshot.lastEventAtUnixMs,
                Date.now(),
              ) &&
              !scheduledAutomationEventsRef.current.has(automationEventKey)
            ) {
              scheduledAutomationEventsRef.current.add(automationEventKey);
              const timer = window.setTimeout(() => {
                automationTimers.delete(timer);
                scheduledAutomationEventsRef.current.delete(automationEventKey);
                if (
                  !claimWorkspaceAutomation(
                    workspaceId,
                    snapshot.lastEventAtUnixMs,
                  )
                ) {
                  return;
                }
                const provider =
                  snapshot.provider === "copilot"
                    ? preferredAgentProvider(workspace.provider)
                    : snapshot.provider;
                void runWorkspaceCompletionAutomation(
                  client,
                  workspaceId,
                  provider,
                  automation,
                ).then((result) => {
                  if (!current) return;
                  const verificationNotification = result.verificationEvidence
                    ? notificationForWorkspaceVerification(
                        workspace.title,
                        result.verificationEvidence,
                      )
                    : null;
                  if (
                    verificationNotification &&
                    loadTimeReviewSchedule().notificationsEnabled
                  ) {
                    void sendDesktopNotification(
                      verificationNotification.title,
                      verificationNotification.body,
                      `wts-verification-${workspaceId}`,
                    );
                  }
                  if (result.verification === "failed") {
                    setNotice(
                      `${workspace.key} · automatic verification could not run`,
                      "error",
                    );
                  } else if (result.agentReview === "failed") {
                    setNotice(
                      `${workspace.key} · automatic agent review could not run`,
                      "error",
                    );
                  } else {
                    setNotice(`${workspace.key} · automatic review is ready`);
                  }
                });
              }, automation.quietPeriodSeconds * 1_000);
              automationTimers.add(timer);
            }
            const suggested = suggestedWorkflowState(
              workspace.workflowState,
              snapshot,
            );
            if (
              !workspace.workflowPersisted ||
              workspace.workflowPlacementMode === "pinned" ||
              !suggested ||
              workspaceWorkflowSignalHandled(
                workspaceId,
                snapshot.lastEventAtUnixMs,
              )
            ) {
              continue;
            }
            void client
              .transitionWorkspaceWorkflow(
                workspaceId,
                suggested,
                workspace.workflowRevision,
              )
              .then((workflow) => {
                markWorkspaceWorkflowSignalHandled(
                  workspaceId,
                  snapshot.lastEventAtUnixMs,
                );
                if (!current) return;
                setWorkspaces((existing) =>
                  existing.map((candidate) =>
                    candidate.id === workspaceId
                      ? {
                          ...candidate,
                          lane: laneForWorkflowState(workflow.state),
                          workflowState: workflow.state,
                          workflowRevision: workflow.revision,
                          workflowUpdatedAtUnixMs: workflow.updatedAtUnixMs,
                          workflowPersisted: true,
                          workflowPlacementMode: workflow.placement?.mode,
                          workflowPlacementRank: workflow.placement?.rank,
                        }
                      : candidate,
                  ),
                );
              })
              .catch(() => {
                scheduleAgentRefresh();
              });
          }
          if (
            Array.from(snapshots.values()).some(
              (snapshot) =>
                snapshot.state === "working" || snapshot.observedLocally,
            )
          ) {
            scheduleAgentRefresh();
          }
        }
      } catch {
        // Keep the last safe snapshot during a transient local observation error.
      }
    };

    void refreshAgentOverview();
    return () => {
      current = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      for (const timer of automationTimers) window.clearTimeout(timer);
      automationTimers.clear();
      scheduledAutomationEventsRef.current.clear();
    };
  }, [client, registryState, setNotice, view, workspaceIdsKey, workspaces]);

  useEffect(() => {
    if (view !== "board" || registryState !== "ready") return;
    const candidates = workspaces.filter(
      (workspace) =>
        (workspace.lifecycleState === "materialized" ||
          workspace.lifecycleState === "needsAttention") &&
        workspace.workflowPersisted,
    );
    if (!candidates.length) return;

    let current = true;
    const refreshMergeRequestWorkflow = async () => {
      await Promise.all(
        candidates.map(async (workspace) => {
          if (pendingGitlabWorkflowTransitionsRef.current.has(workspace.id)) {
            return;
          }
          try {
            const inbox = attentionInboxes[workspace.id];
            if (!current || !inbox) return;
            if (inbox.state !== "fresh") return;
            const observation = inbox.mergeRequests
              .map(
                (mergeRequest) =>
                  `${mergeRequest.id}:${mergeRequest.status}:${mergeRequest.updatedAt}`,
              )
              .sort()
              .join("|");
            if (
              gitlabWorkflowObservationsRef.current.get(workspace.id) ===
              observation
            ) {
              return;
            }
            const suggested = suggestedWorkflowStateForMergeRequests(
              workspace.workflowState,
              inbox.mergeRequests,
            );
            if (
              !suggested ||
              workspace.workflowPlacementMode === "pinned"
            ) {
              gitlabWorkflowObservationsRef.current.set(
                workspace.id,
                observation,
              );
              return;
            }
            pendingGitlabWorkflowTransitionsRef.current.add(workspace.id);
            const workflow = await client.transitionWorkspaceWorkflow(
              workspace.id,
              suggested,
              workspace.workflowRevision,
            );
            if (attentionClientRef.current !== client) return;
            gitlabWorkflowObservationsRef.current.set(workspace.id, observation);
            setWorkspaces((existing) =>
              existing.map((candidate) =>
                candidate.id === workspace.id && candidate.workflowRevision <= workflow.revision
                  ? {
                      ...candidate,
                      lane: laneForWorkflowState(workflow.state),
                      workflowState: workflow.state,
                      workflowRevision: workflow.revision,
                      workflowUpdatedAtUnixMs: workflow.updatedAtUnixMs,
                      workflowPersisted: true,
                      workflowPlacementMode: workflow.placement?.mode,
                      workflowPlacementRank: workflow.placement?.rank,
                    }
                  : candidate,
              ),
            );
          } catch {
            // Keep the durable lane when GitLab or the workflow transition fails.
          } finally {
            pendingGitlabWorkflowTransitionsRef.current.delete(workspace.id);
          }
        }),
      );
    };

    void refreshMergeRequestWorkflow();
    return () => { current = false; };
  }, [
    attentionInboxes,
    client,
    registryState,
    view,
    workspaceIdsKey,
    workspaces,
  ]);

  useEffect(() => {
    const inbox = myReviews.gitlabInbox;
    if (
      view !== "board" ||
      registryState !== "ready" ||
      inbox?.state !== "fresh"
    ) {
      return;
    }
    let current = true;
    for (const workspace of workspaces) {
      const review = gitlabReviewForWorkspace(workspace, inbox.reviews);
      if (!review) continue;
      const observation = `${review.id}:${review.reviewState}:${review.status}:${review.updatedAt}`;
      if (
        gitlabReviewWorkflowObservationsRef.current.get(workspace.id) ===
          observation ||
        pendingGitlabWorkflowTransitionsRef.current.has(workspace.id)
      ) {
        continue;
      }
      const suggested = suggestedWorkflowStateForGitlabReview(
        workspace.workflowState,
        review,
      );
      if (!suggested || workspace.workflowPlacementMode === "pinned") {
        gitlabReviewWorkflowObservationsRef.current.set(
          workspace.id,
          observation,
        );
        continue;
      }
      pendingGitlabWorkflowTransitionsRef.current.add(workspace.id);
      void client
        .transitionWorkspaceWorkflow(
          workspace.id,
          suggested,
          workspace.workflowRevision,
        )
        .then((workflow) => {
          gitlabReviewWorkflowObservationsRef.current.set(
            workspace.id,
            observation,
          );
          if (!current) return;
          setWorkspaces((existing) =>
            existing.map((candidate) =>
              candidate.id === workspace.id
                ? {
                    ...candidate,
                    lane: laneForWorkflowState(workflow.state),
                    workflowState: workflow.state,
                    workflowRevision: workflow.revision,
                    workflowUpdatedAtUnixMs: workflow.updatedAtUnixMs,
                    workflowPersisted: true,
                    workflowPlacementMode: workflow.placement?.mode,
                    workflowPlacementRank: workflow.placement?.rank,
                  }
                : candidate,
            ),
          );
        })
        .catch(() => {
          // Keep the durable lane when the provider transition fails.
        })
        .finally(() => {
          pendingGitlabWorkflowTransitionsRef.current.delete(workspace.id);
        });
    }
    return () => {
      current = false;
    };
  }, [
    client,
    myReviews.gitlabInbox,
    registryState,
    view,
    workspaceIdsKey,
    workspaces,
  ]);

  const selectedWorkspace = selectedId
    ? workspaces.find((workspace) => workspace.id === selectedId)
    : workspaces[0];
  const listedDeepLink = Boolean(
    initialWorkspaceId &&
    workspaces.some((workspace) => workspace.id === initialWorkspaceId),
  );
  const selectedWorkspaceIsReady =
    registryState === "ready" &&
    !(
      initialWorkspaceId &&
      selectedId === initialWorkspaceId &&
      deepLinkEnabledRef.current &&
      deepLinkState !== "ready"
    );

  useEffect(() => {
    if (
      registryState !== "ready" ||
      !initialWorkspaceId ||
      !deepLinkEnabledRef.current ||
      deepLinkState !== "loading" ||
      listedDeepLink ||
      selectedId !== initialWorkspaceId ||
      view !== "workbench" ||
      createOpen
    ) {
      if (
        registryState === "ready" &&
        initialWorkspaceId &&
        deepLinkEnabledRef.current &&
        listedDeepLink
      ) {
        setDeepLinkError("");
        setDeepLinkState("ready");
      }
      return;
    }

    let current = true;
    const requestGeneration = ++deepLinkGenerationRef.current;
    setDeepLinkError("");

    void client
      .getWorkspace(initialWorkspaceId)
      .then((workspaceView) => {
        if (
          !current ||
          requestGeneration !== deepLinkGenerationRef.current ||
          !deepLinkEnabledRef.current
        ) {
          return;
        }
        if (workspaceView.workspaceId !== initialWorkspaceId) {
          throw new Error("WTS returned another workspace for this link.");
        }
        const workspace = workspaceFromView(workspaceView);
        setWorkspaces((existing) => [
          ...existing.filter((item) => item.id !== workspace.id),
          workspace,
        ]);
        setSelectedId(workspace.id);
        setDeepLinkState("ready");
      })
      .catch((error) => {
        if (
          !current ||
          requestGeneration !== deepLinkGenerationRef.current ||
          !deepLinkEnabledRef.current
        ) {
          return;
        }
        setDeepLinkError(
          error instanceof Error
            ? error.message
            : "The linked workspace could not be opened.",
        );
        setDeepLinkState("error");
        setNotice(
          "Linked workspace unavailable · saved workspace plans are still available",
        );
      });

    return () => {
      current = false;
    };
  }, [
    client,
    createOpen,
    deepLinkRevision,
    deepLinkState,
    initialWorkspaceId,
    listedDeepLink,
    registryState,
    selectedId,
    view,
  ]);

  useEffect(() => {
    let current = true;
    setSetupLoading(true);
    setSetupError("");

    const loadSetup = async () => {
      const [snapshotResult, catalogResult] = await Promise.allSettled([
        client.getSetupSnapshot(),
        client.listRepositories(),
      ]);
      if (!current) return;

      const failures: string[] = [];
      if (snapshotResult.status === "fulfilled") {
        setSetupSnapshot(snapshotResult.value);
      } else {
        failures.push(
          snapshotResult.reason instanceof Error
            ? snapshotResult.reason.message
            : "Integration checks could not finish.",
        );
      }
      if (catalogResult.status === "fulfilled") {
        setRepositoryCatalog(catalogResult.value);
      } else {
        failures.push(
          catalogResult.reason instanceof Error
            ? catalogResult.reason.message
            : "Repository discovery could not finish.",
        );
      }
      setSetupError(failures.join(" "));
      setSetupLoading(false);
    };

    void loadSetup();
    return () => {
      current = false;
    };
  }, [client, setupRevision]);

  useEffect(() => {
    if (
      view !== "workbench" ||
      !selectedWorkspace ||
      !selectedWorkspaceIsReady
    ) {
      return;
    }
    if (reviewWorkspaceHydrationSkipsRef.current.delete(selectedWorkspace.id)) {
      return;
    }
    let current = true;
    const workspaceId = selectedWorkspace.id;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    const hasCachedMaterialization = materializationCache.has(workspaceId);
    const cachedMaterialization = hasCachedMaterialization
      ? (materializationCache.get(workspaceId) ?? null)
      : null;
    setWorkspaceCommandState("idle");
    setWorkspacePreflight(null);
    setWorkspaceMaterialization(cachedMaterialization);
    setWorkspaceActionError("");
    setWorkspaceActionErrorCode("");
    setWorkspaceActionState(
      hasCachedMaterialization
        ? cachedMaterialization
          ? "materialized"
          : "idle"
        : "checking",
    );
    setWorkspaceEvidenceRefreshing(true);

    void materializationCache.load(workspaceId, async () => {
      const result = await client.getWorkspaceMaterialization(workspaceId);
      if (result && result.workspaceId !== workspaceId) {
        throw new Error("WTS returned status for another workspace.");
      }
      return result;
    }).then((materialization) => {
        if (
          !current ||
          actionGeneration !== workspaceActionGenerationRef.current
        ) {
          return;
        }
        setWorkspaceMaterialization(materialization);
        setWorkspaceActionErrorCode("");
        setWorkspaceActionState(materialization ? "materialized" : "idle");
      })
      .catch((error) => {
        if (
          !current ||
          actionGeneration !== workspaceActionGenerationRef.current
        ) {
          return;
        }
        setWorkspaceActionError(
          error instanceof Error
            ? error.message
            : "Workspace state could not be checked.",
        );
        setWorkspaceActionErrorCode(
          error instanceof WorkspaceClientError ? error.code : "",
        );
        setWorkspaceActionState(
          cachedMaterialization ? "materialized" : "error",
        );
      })
      .finally(() => {
        if (
          current &&
          actionGeneration === workspaceActionGenerationRef.current
        ) {
          setWorkspaceEvidenceRefreshing(false);
        }
      });
    return () => {
      current = false;
    };
  }, [
    client,
    materializationCache,
    selectedWorkspace?.id,
    selectedWorkspaceIsReady,
    view,
  ]);

  useEffect(() => {
    if (view !== "board" || pendingBoardFocusRef.current === undefined) return;
    const workspaceId = pendingBoardFocusRef.current;
    pendingBoardFocusRef.current = undefined;
    const frame = window.requestAnimationFrame(() => {
      const nextCard = workspaceId
        ? workspaceCardRefs.current.get(workspaceId)
        : null;
      const fallback =
        registryState === "ready"
          ? newWorkspaceButtonRef.current
          : boardHeadingRef.current;
      (nextCard ?? fallback ?? boardHeadingRef.current)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [registryState, view, workspaces]);

  useEffect(() => {
    if (!pendingRecoveryFocusRef.current || view !== "workbench") return;
    const recovered = Boolean(selectedWorkspace && selectedWorkspaceIsReady);
    const terminalError =
      registryState === "error" || deepLinkState === "error";
    const target = recovered
      ? workbenchHeadingRef.current
      : recoveryHeadingRef.current;
    if (!target) return;

    const frame = window.requestAnimationFrame(() => {
      target.focus();
      if (recovered || terminalError) {
        pendingRecoveryFocusRef.current = false;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    deepLinkState,
    registryState,
    selectedWorkspace,
    selectedWorkspaceIsReady,
    view,
  ]);

  const reconciledLegacyBoardOrder = useMemo(() => {
    const byDurablePosition = orderWorkspacesByBoardActivity(
      workspaces,
      workspaceAgents,
    );
    const legacyOnlyOrder: WorkspaceBoardOrder = {
      schemaVersion: 1,
      lanes: {
        planned: legacyWorkspaceBoardOrder.lanes.planned.filter((id) =>
          workspaces.some(
            (workspace) =>
              workspace.id === id &&
              workspace.workflowPlacementRank === undefined,
          ),
        ),
        active: legacyWorkspaceBoardOrder.lanes.active.filter((id) =>
          workspaces.some(
            (workspace) =>
              workspace.id === id &&
              workspace.workflowPlacementRank === undefined,
          ),
        ),
        attention: legacyWorkspaceBoardOrder.lanes.attention.filter((id) =>
          workspaces.some(
            (workspace) =>
              workspace.id === id &&
              workspace.workflowPlacementRank === undefined,
          ),
        ),
        suspended: legacyWorkspaceBoardOrder.lanes.suspended.filter((id) =>
          workspaces.some(
            (workspace) =>
              workspace.id === id &&
              workspace.workflowPlacementRank === undefined,
          ),
        ),
      },
    };
    return reconcileWorkspaceBoardOrder(
      workspaceBoardSessionOrder ?? legacyOnlyOrder,
      new Map(workspaces.map((workspace) => [workspace.id, workspace.lane])),
      byDurablePosition.map((workspace) => workspace.id),
    );
  }, [
    legacyWorkspaceBoardOrder,
    workspaceAgents,
    workspaceBoardSessionOrder,
    workspaces,
  ]);
  const visibleWorkspaces = useMemo(() => {
    const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const repositoriesById = new Map(
      (repositoryCatalog?.repositories ?? []).map((repository) => [
        repository.id,
        repository,
      ]),
    );
    return workspaces
      .filter((workspace) => {
        const agent = workspaceAgents.get(workspace.id);
        const matchesFilter =
          filter === "all" || workspaceOverviewLane(workspace, agent) === filter;
        const searchableWorkspace = [
          workspace.key,
          workspace.title,
          workspace.path,
          workspace.kind,
          workspace.provider,
          agent?.headline,
          agent?.activity,
          ...workspace.repositoryPlans.flatMap((repository) => [
            repository.label,
            repository.baseRef,
            ...(repository.repositoryId
              ? (() => {
                  const catalogRepository = repositoriesById.get(
                    repository.repositoryId,
                  );
                  return catalogRepository
                    ? [
                        catalogRepository.label,
                        catalogRepository.displayPath,
                        catalogRepository.originUrl,
                        catalogRepository.defaultBranch.name,
                        ...(catalogRepository.availableBranches ?? []).map(
                          (branch) => branch.name,
                        ),
                      ]
                    : [];
                })()
              : []),
          ]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return (
          matchesFilter &&
          terms.every((term) => searchableWorkspace.includes(term))
        );
      })
      .sort((left, right) => {
        if (left.lane === right.lane) {
          if (left.lane === "suspended") {
            const leftHasOpenMergeRequest = Boolean(
              workspaceGitlabInboxes
                .get(left.id)
                ?.mergeRequests.some(
                  (mergeRequest) => mergeRequest.status === "open",
                ),
            );
            const rightHasOpenMergeRequest = Boolean(
              workspaceGitlabInboxes
                .get(right.id)
                ?.mergeRequests.some(
                  (mergeRequest) => mergeRequest.status === "open",
                ),
            );
            if (leftHasOpenMergeRequest !== rightHasOpenMergeRequest) {
              return leftHasOpenMergeRequest ? -1 : 1;
            }
          }
          const pinnedPosition =
            workspaceBoardPosition(
              reconciledLegacyBoardOrder,
              left.lane,
              left.id,
            ) -
            workspaceBoardPosition(
              reconciledLegacyBoardOrder,
              right.lane,
              right.id,
            );
          if (pinnedPosition !== 0) return pinnedPosition;
        }
        return compareWorkspaceRecency(left, right);
      });
  }, [
    filter,
    reconciledLegacyBoardOrder,
    repositoryCatalog,
    search,
    workspaceAgents,
    workspaceGitlabInboxes,
    workspaces,
  ]);
  const assignedGitlabReviews = useMemo(
    () =>
      (myReviews.gitlabInbox?.reviews ?? []).filter(
        (review) =>
          review.reviewState !== "approved" && review.status === "open",
      ),
    [myReviews.gitlabInbox?.reviews],
  );
  const unmatchedAssignedGitlabReviews = useMemo(
    () =>
      assignedGitlabReviews.filter(
        (review) =>
          !workspaces.some(
            (workspace) =>
              gitlabReviewForWorkspace(workspace, [review]) !== undefined,
          ),
      ),
    [assignedGitlabReviews, workspaces],
  );
  const visibleAssignedGitlabReviews = useMemo(() => {
    if (filter !== "all" && filter !== "planned") return [];
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return unmatchedAssignedGitlabReviews;
    return unmatchedAssignedGitlabReviews.filter((review) => {
      const searchable = [
        review.repository,
        review.title,
        review.authorLogin,
        review.sourceBranch,
        `!${review.number}`,
      ]
        .join(" ")
        .toLocaleLowerCase();
      return terms.every((term) => searchable.includes(term));
    });
  }, [filter, search, unmatchedAssignedGitlabReviews]);
  const workspaceCounts = useMemo(
    () => {
      const counts = workspaces.reduce(
        (counts, workspace) => {
          counts[
            workspaceOverviewLane(workspace, workspaceAgents.get(workspace.id))
          ] += 1;
          counts.all += 1;
          return counts;
        },
        {
          all: 0,
          planned: 0,
          active: 0,
          attention: 0,
          suspended: 0,
        } satisfies Record<Filter, number>,
      );
      counts.planned += unmatchedAssignedGitlabReviews.length;
      counts.all += unmatchedAssignedGitlabReviews.length;
      for (const task of deferredWorkspaceCreations) {
        counts[workspaceCreationLane(task)] += 1;
        counts.all += 1;
      }
      return counts;
    },
    [
      deferredWorkspaceCreations,
      unmatchedAssignedGitlabReviews.length,
      workspaceAgents,
      workspaces,
    ],
  );
  const visibleByLane = useMemo(() => {
    const grouped: Record<Lane, Workspace[]> = {
      planned: [],
      active: [],
      attention: [],
      suspended: [],
    };
    for (const workspace of visibleWorkspaces) {
      grouped[
        workspaceOverviewLane(workspace, workspaceAgents.get(workspace.id))
      ].push(workspace);
    }
    return grouped;
  }, [visibleWorkspaces, workspaceAgents]);
  const visibleLanes: Lane[] =
    filter === "all" ? [...WORKSPACE_LANE_ORDER] : [filter];
  const visibleDeferredWorkspaceCreations = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase();
    return deferredWorkspaceCreations.filter(
      (task) =>
        (filter === "all" || workspaceCreationLane(task) === filter) &&
        (!terms ||
          `${task.title} ${task.repositoryLabel}`
            .toLocaleLowerCase()
            .includes(terms)),
    );
  }, [deferredWorkspaceCreations, filter, search]);

  useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      const historyDirection =
        event.metaKey && !event.ctrlKey && !event.altKey && event.key === "["
          ? "back"
          : event.metaKey &&
              !event.ctrlKey &&
              !event.altKey &&
              event.key === "]"
            ? "forward"
            : event.altKey &&
                !event.metaKey &&
                !event.ctrlKey &&
                event.key === "ArrowLeft"
              ? "back"
              : event.altKey &&
                  !event.metaKey &&
                  !event.ctrlKey &&
                  event.key === "ArrowRight"
                ? "forward"
                : null;
      if (historyDirection) {
        event.preventDefault();
        if (historyDirection === "back") {
          globalThis.history?.back();
        } else {
          globalThis.history?.forward();
        }
        return;
      }
      if (isEditableShortcutTarget(event.target)) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        if (createOpen || guideOpen || setupOpen || removalOpen) return;
        event.preventDefault();
        if (!commandOpen) openCommandPalette();
        return;
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "f" &&
        view === "board"
      ) {
        if (createOpen || guideOpen || setupOpen || removalOpen || commandOpen) {
          return;
        }
        event.preventDefault();
        setSearchExpanded(true);
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
        return;
      }

      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey
      ) {
        const key = event.key.toLowerCase();
        if (event.key === ",") {
          event.preventDefault();
          if (createOpen || guideOpen || removalOpen) return;
          setSetupOpen(true);
          return;
        }
        if (key === "n" && view === "board") {
          event.preventDefault();
          if (guideOpen || setupOpen || removalOpen || commandOpen) return;
          if (!createOpen) setResumedWorkspaceCreationId("");
          setCreateOpen(true);
          return;
        }
        if (view === "workbench") {
          if (key === "1") {
            event.preventDefault();
            openWorkbenchTab("overview");
            return;
          }
          if (key === "2" && workspaceMaterialization) {
            event.preventDefault();
            openWorkbenchTab("changes");
            return;
          }
          if (key === "3") {
            event.preventDefault();
            openWorkbenchTab("verification");
            return;
          }
          if (key === "4") {
            event.preventDefault();
            openWorkbenchTab("planning");
            return;
          }
        }
      }

      if (
        view === "board" &&
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(
          event.key,
        ) &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey
      ) {
        const focusedId = Array.from(
          workspaceCardRefs.current.entries(),
        ).find(
          ([_, el]) => el === event.target || el?.contains(event.target as Node),
        )?.[0];

        if (focusedId) {
          let currentLaneIndex = -1;
          let currentCardIndex = -1;

          for (let l = 0; l < visibleLanes.length; l++) {
            const lane = visibleLanes[l]!;
            const items = visibleByLane[lane] ?? [];
            const idx = items.findIndex((item) => item.id === focusedId);
            if (idx !== -1) {
              currentLaneIndex = l;
              currentCardIndex = idx;
              break;
            }
          }

          if (currentLaneIndex !== -1 && currentCardIndex !== -1) {
            const currentLane = visibleLanes[currentLaneIndex]!;
            const currentItems = visibleByLane[currentLane] ?? [];

            let targetWorkspace: Workspace | undefined;

            if (event.key === "ArrowDown") {
              if (currentCardIndex < currentItems.length - 1) {
                targetWorkspace = currentItems[currentCardIndex + 1];
              }
            } else if (event.key === "ArrowUp") {
              if (currentCardIndex > 0) {
                targetWorkspace = currentItems[currentCardIndex - 1];
              }
            } else if (event.key === "ArrowRight") {
              for (
                let targetLaneIndex = currentLaneIndex + 1;
                targetLaneIndex < visibleLanes.length;
                targetLaneIndex += 1
              ) {
                const targetLane = visibleLanes[targetLaneIndex]!;
                const targetItems = visibleByLane[targetLane] ?? [];
                if (targetItems.length > 0) {
                  targetWorkspace =
                    targetItems[
                      Math.min(currentCardIndex, targetItems.length - 1)
                    ];
                  break;
                }
              }
            } else if (event.key === "ArrowLeft") {
              for (
                let targetLaneIndex = currentLaneIndex - 1;
                targetLaneIndex >= 0;
                targetLaneIndex -= 1
              ) {
                const targetLane = visibleLanes[targetLaneIndex]!;
                const targetItems = visibleByLane[targetLane] ?? [];
                if (targetItems.length > 0) {
                  targetWorkspace =
                    targetItems[
                      Math.min(currentCardIndex, targetItems.length - 1)
                    ];
                  break;
                }
              }
            }

            if (targetWorkspace) {
              event.preventDefault();
              workspaceCardRefs.current.get(targetWorkspace.id)?.focus();
            }
          }
        }
      }
    };
    window.addEventListener("keydown", handleWorkspaceShortcut);
    return () =>
      window.removeEventListener("keydown", handleWorkspaceShortcut);
  }, [
    commandOpen,
    createOpen,
    guideOpen,
    openCommandPalette,
    removalOpen,
    setupOpen,
    selectedWorkspace,
    view,
    visibleByLane,
    visibleLanes,
    workspaceMaterialization,
  ]);

  useEffect(() => {
    const navigateHistory = (direction: "back" | "forward", now: number) => {
      const state = historySwipeRef.current;
      if (now - state.lastNavigationAt < HISTORY_SWIPE_COOLDOWN_MS) return;
      state.deltaX = 0;
      state.lastNavigationAt = now;
      if (direction === "back") {
        globalThis.history?.back();
      } else {
        globalThis.history?.forward();
      }
    };

    const handleHistorySwipe = (event: WheelEvent) => {
      const state = historySwipeRef.current;
      const now = Date.now();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? Math.max(window.innerWidth, 1)
          : 1;
      const deltaX = event.deltaX * scale;
      const deltaY = event.deltaY * scale;

      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        createOpen ||
        guideOpen ||
        setupOpen ||
        removalOpen ||
        commandOpen ||
        historySwipeBlockedTarget(event.target) ||
        Math.abs(deltaX) < 4 ||
        Math.abs(deltaX) <= Math.abs(deltaY) * HISTORY_SWIPE_AXIS_RATIO ||
        horizontalScrollConsumesSwipe(event.target, deltaX)
      ) {
        state.deltaX = 0;
        state.lastEventAt = now;
        return;
      }

      event.preventDefault();
      if (now - state.lastEventAt > HISTORY_SWIPE_SEQUENCE_GAP_MS) {
        state.deltaX = 0;
      }
      if (state.deltaX !== 0 && Math.sign(state.deltaX) !== Math.sign(deltaX)) {
        state.deltaX = 0;
      }
      state.deltaX += deltaX;
      state.lastEventAt = now;

      if (
        Math.abs(state.deltaX) < HISTORY_SWIPE_THRESHOLD_PX
      ) {
        return;
      }

      const direction = state.deltaX < 0 ? "back" : "forward";
      navigateHistory(direction, now);
    };

    const gestureBlocked = () =>
      createOpen ||
      guideOpen ||
      setupOpen ||
      removalOpen ||
      commandOpen;

    const handleTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      const state = historyTouchRef.current;
      const edge = touch
        ? touch.clientX <= HISTORY_SWIPE_EDGE_PX
          ? "left"
          : touch.clientX >= window.innerWidth - HISTORY_SWIPE_EDGE_PX
            ? "right"
            : null
        : null;
      if (
        event.touches.length !== 1 ||
        !touch ||
        !edge ||
        gestureBlocked() ||
        historySwipeBlockedTarget(event.target)
      ) {
        state.active = false;
        state.edge = null;
        return;
      }
      state.active = true;
      state.edge = edge;
      state.startX = touch.clientX;
      state.startY = touch.clientY;
      state.lastX = touch.clientX;
      state.lastY = touch.clientY;
      state.target = event.target;
    };

    const handleTouchMove = (event: TouchEvent) => {
      const state = historyTouchRef.current;
      const touch = event.touches[0];
      if (!state.active || !touch) return;
      state.lastX = touch.clientX;
      state.lastY = touch.clientY;
      const distanceX = state.lastX - state.startX;
      const distanceY = state.lastY - state.startY;
      if (
        Math.abs(distanceX) <=
          Math.abs(distanceY) * HISTORY_SWIPE_AXIS_RATIO ||
        horizontalScrollConsumesSwipe(state.target, -distanceX)
      ) {
        return;
      }
      if (Math.abs(distanceX) >= 12 && event.cancelable) {
        event.preventDefault();
      }
    };

    const handleTouchEnd = (event: TouchEvent) => {
      const state = historyTouchRef.current;
      const touch = event.changedTouches[0];
      if (!state.active) return;
      state.active = false;
      if (gestureBlocked()) return;
      const endX = touch?.clientX ?? state.lastX;
      const endY = touch?.clientY ?? state.lastY;
      const distanceX = endX - state.startX;
      const distanceY = endY - state.startY;
      if (
        Math.abs(distanceX) < HISTORY_TOUCH_THRESHOLD_PX ||
        Math.abs(distanceX) <=
          Math.abs(distanceY) * HISTORY_SWIPE_AXIS_RATIO ||
        (state.edge === "left" && distanceX <= 0) ||
        (state.edge === "right" && distanceX >= 0) ||
        horizontalScrollConsumesSwipe(state.target, -distanceX)
      ) {
        return;
      }
      navigateHistory(distanceX > 0 ? "back" : "forward", Date.now());
    };

    window.addEventListener("wheel", handleHistorySwipe, { passive: false });
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd, { passive: true });
    return () => {
      window.removeEventListener("wheel", handleHistorySwipe);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
    };
  }, [commandOpen, createOpen, guideOpen, removalOpen, setupOpen]);

  const returnToWorkspaceBoard = () => {
    invalidateDeepLinkLookup();
    pushNavigationPath("/");
    pendingBoardFocusRef.current =
      visibleWorkspaces[0]?.id ?? workspaces[0]?.id ?? null;
    setView("board");
  };

  const startRepositoryClone = useCallback(
    (request: CloneRepositoryRequest): RepositoryCloneHandle => {
      repositoryCloneSequenceRef.current += 1;
      const id = `repository-clone-${Date.now()}-${repositoryCloneSequenceRef.current}`;
      const promise = client.cloneRepository(request);
      const record: RepositoryCloneRecord = {
        id,
        promise,
        status: "cloning",
      };
      repositoryCloneRecordsRef.current.set(id, record);
      void promise.then(
        (result) => {
          record.status = "ready";
          record.result = result;
          setDeferredWorkspaceCreations((current) =>
            current.map((task) =>
              task.id === id
                ? {
                    ...task,
                    status: "ready",
                    result,
                    message: `Git cloned ${result.repository.label}. Continue workspace setup.`,
                  }
                : task,
            ),
          );
        },
        (error: unknown) => {
          const message =
            error instanceof Error
              ? error.message
              : "Git could not clone this repository.";
          record.status = "error";
          record.error = message;
          setDeferredWorkspaceCreations((current) =>
            current.map((task) =>
              task.id === id
                ? { ...task, status: "error", message }
                : task,
            ),
          );
        },
      );
      return { id, promise };
    },
    [client],
  );

  const deferRepositoryClone = useCallback(
    (request: DeferredCloneRequest) => {
      const record = repositoryCloneRecordsRef.current.get(request.cloneId);
      if (!record) return;
      const task: DeferredWorkspaceCreation = {
        id: request.cloneId,
        title: request.title,
        repositoryLabel: request.repositoryLabel,
        remoteUrl: request.cloneRequest.remoteUrl,
        ...(request.cloneRequest.branch
          ? { branch: request.cloneRequest.branch }
          : {}),
        shallow: request.cloneRequest.shallow === true,
        draft: request.draft,
        status: record.status,
        message:
          record.status === "ready" && record.result
            ? `Git cloned ${record.result.repository.label}. Continue workspace setup.`
            : record.status === "error"
              ? record.error ?? "Git could not clone this repository."
              : `Git is cloning ${request.repositoryLabel}${
                  request.cloneRequest.branch
                    ? ` from ${request.cloneRequest.branch}`
                    : ""
                }.`,
        ...(record.result ? { result: record.result } : {}),
      };
      setDeferredWorkspaceCreations((current) => [
        ...current.filter(
          (candidate) =>
            candidate.id !== task.id &&
            candidate.id !== request.replacesTaskId,
        ),
        task,
      ]);
      setResumedWorkspaceCreationId("");
      setCreateOpen(false);
      returnToWorkspaceBoard();
      setNotice(`${request.repositoryLabel} clone moved to the Kanban board`);
    },
    [returnToWorkspaceBoard],
  );

  const resumeWorkspaceCreation = (taskId: string) => {
    setReviewWorkspaceSeed(null);
    setCreateTemplateWorkspaceId("");
    setCreateRepositoryBaseOverrides({});
    setCreatePlanningEnabled(undefined);
    setResumedWorkspaceCreationId(taskId);
    setCreateOpen(true);
  };

  const openTimeReview = () => {
    invalidateDeepLinkLookup();
    pushNavigationPath("/time");
    setView("time");
  };

  const openMyReviews = () => {
    invalidateDeepLinkLookup();
    pushNavigationPath("/reviews");
    setView("reviews");
  };

  const openWorkbenchTab = (tab: WorkbenchTab) => {
    if (!selectedWorkspace) return;
    invalidateDeepLinkLookup();
    setActiveTab(tab);
    setView("workbench");
    pushNavigationPath(
      tab === "overview"
        ? `/sessions/${encodeURIComponent(selectedWorkspace.id)}`
        : tab === "planning"
          ? `/sessions/${encodeURIComponent(selectedWorkspace.id)}/planning`
          : tab === "changes"
          ? `/sessions/${encodeURIComponent(selectedWorkspace.id)}/changes${reviewRepositoryId ? `?repository=${encodeURIComponent(reviewRepositoryId)}` : ""}`
          : `/sessions/${encodeURIComponent(selectedWorkspace.id)}/verification`,
    );
  };

  const openRepositoryReview = (repositoryId: string) => {
    if (!selectedWorkspace) return;
    invalidateDeepLinkLookup();
    setReviewRepositoryId(repositoryId);
    setActiveTab("changes");
    setView("workbench");
    pushNavigationPath(
      `/sessions/${encodeURIComponent(selectedWorkspace.id)}/changes?repository=${encodeURIComponent(repositoryId)}`,
    );
  };

  const retryRegistry = () => {
    if (view === "workbench") {
      pendingRecoveryFocusRef.current = true;
    } else {
      pendingBoardFocusRef.current =
        visibleWorkspaces[0]?.id ?? workspaces[0]?.id ?? null;
    }
    setReloadRevision((revision) => revision + 1);
  };

  const retryDeepLinkedWorkspace = () => {
    if (!initialWorkspaceId) return;
    deepLinkEnabledRef.current = true;
    deepLinkGenerationRef.current += 1;
    pendingRecoveryFocusRef.current = true;
    setSelectedId(initialWorkspaceId);
    setDeepLinkError("");
    setDeepLinkState("loading");
    setDeepLinkRevision((revision) => revision + 1);
  };

  const startNewWorkspace = () => {
    invalidateDeepLinkLookup();
    setResumedWorkspaceCreationId("");
    setReviewWorkspaceSeed(null);
    setCreateTemplateWorkspaceId("");
    setCreateRepositoryBaseOverrides({});
    setCreatePlanningEnabled(undefined);
    setCreateOpen(true);
  };

  const startRevisedWorkspace = () => {
    if (!selectedWorkspace) return;
    setResumedWorkspaceCreationId("");
    setReviewWorkspaceSeed(null);
    setCreateRepositoryBaseOverrides({});
    setCreatePlanningEnabled(undefined);
    setCreateTemplateWorkspaceId(selectedWorkspace.id);
    setCreateOpen(true);
  };

  const completeRepositoryAddition = async (
    result: WorkspaceRepositoryAdditionResult,
  ) => {
    materializationCache.set(result.workspaceId, result.materialization);
    setWorkspaceMaterialization(result.materialization);
    setWorkspaceActionState("materialized");
    setWorkspacePreflight(null);
    setNotice(`${result.repositoryLabel} added to ${selectedWorkspace?.key ?? "the workspace"}`);
    try {
      const view = await client.getWorkspace(result.workspaceId);
      if (view.workspaceId !== result.workspaceId) return;
      const refreshed = workspaceFromView(view);
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === result.workspaceId ? refreshed : workspace,
        ),
      );
    } catch {
      setNotice("The repository was added. Refresh the workspace to update its saved plan.", "error");
    }
  };

  const removeSelectedWorkspaceRepository = async (
    repositoryId: string,
  ): Promise<WorkspaceRepositoryRemovalResult> => {
    if (!selectedWorkspace || workspaceCommandState !== "idle") {
      throw new Error("WTS cannot remove a repository while another workspace command is running.");
    }
    const workspaceId = selectedWorkspace.id;
    const result = await client.removeWorkspaceRepository(workspaceId, repositoryId);
    if (
      result.workspaceId !== workspaceId ||
      result.repositoryId !== repositoryId
    ) {
      throw new Error("WTS returned a repository removal for another workspace.");
    }
    invalidateRepositoryReview(client, workspaceId, repositoryId);
    invalidateWorkspaceGitlabMergeRequests(client, workspaceId);
    materializationCache.set(workspaceId, result.materialization);
    setWorkspaceMaterialization(result.materialization);
    setWorkspaceActionState("materialized");
    setWorkspacePreflight(null);
    try {
      const view = await client.getWorkspace(workspaceId);
      if (view.workspaceId !== workspaceId) {
        throw new Error("WTS returned status for another workspace.");
      }
      const refreshed = workspaceFromView(view);
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === workspaceId ? refreshed : workspace,
        ),
      );
    } catch {
      setNotice(
        "The repository was removed. Refresh the workspace to update its saved plan.",
        "error",
      );
    }
    return result;
  };

  const createPlanningHome = () => {
    if (!selectedWorkspace) return;
    setResumedWorkspaceCreationId("");
    setReviewWorkspaceSeed(null);
    setCreateRepositoryBaseOverrides({});
    setCreatePlanningEnabled(true);
    setCreateTemplateWorkspaceId(selectedWorkspace.id);
    setCreateOpen(true);
  };

  const startBaseRevision = (repositoryId: string, baseRef: string) => {
    if (!selectedWorkspace) return;
    setResumedWorkspaceCreationId("");
    setReviewWorkspaceSeed(null);
    setCreatePlanningEnabled(undefined);
    setCreateRepositoryBaseOverrides({ [repositoryId]: baseRef });
    setCreateTemplateWorkspaceId(selectedWorkspace.id);
    setCreateOpen(true);
  };

  const startGitlabReviewWorkspace = async (review: GitlabReview) => {
    if (preparingReviewId || preparingReviewIdRef.current) return;
    const existingWorkspace = workspaces.find(
      (workspace) => gitlabReviewForWorkspace(workspace, [review]) !== undefined,
    );
    if (existingWorkspace) {
      const repositoryLabel = review.repository.split("/").at(-1);
      const repositoryId = existingWorkspace.repositoryPlans.find(
        (repository) =>
          repository.baseRef === review.sourceBranch &&
          (repository.repositoryId === review.repositoryId ||
            repository.label === repositoryLabel),
      )?.repositoryId;
      invalidateDeepLinkLookup();
      setSelectedId(existingWorkspace.id);
      resetOperationalState(existingWorkspace);
      setReviewRepositoryId(repositoryId ?? "");
      setActiveTab("changes");
      setView("workbench");
      pushNavigationPath(
        `/sessions/${encodeURIComponent(existingWorkspace.id)}/changes${repositoryId ? `?repository=${encodeURIComponent(repositoryId)}` : ""}`,
      );
      return;
    }
    preparingReviewIdRef.current = review.id;
    setPreparingReviewId(review.id);
    setReviewWorkspaceErrors((current) => {
      const next = new Map(current);
      next.delete(review.id);
      return next;
    });
    let createdWorkspaceId = "";
    try {
      const preparation = await client.prepareGitlabReviewRepository(
        review.repositoryId,
        review.number,
      );
      setRepositoryCatalog((current) => ({
        repositoryRootDisplayPath: preparation.repositoryRootDisplayPath,
        repositories: [
          ...(current?.repositories.filter(
            (repository) => repository.id !== preparation.repository.id,
          ) ?? []),
          preparation.repository,
        ],
        skippedEntries: current?.skippedEntries ?? 0,
      }));
      const reviewLabel = `Review ${review.repository} !${review.number}`;
      const creationKey =
        reviewWorkspaceCreationKeysRef.current.get(review.id) ??
        newIdempotencyKey();
      reviewWorkspaceCreationKeysRef.current.set(review.id, creationKey);
      const created = await client.createWorkspace(
        {
          intent: { type: "repositorySet", label: reviewLabel },
          title: reviewLabel,
          preferredProvider: "codex",
          repositories: [
            {
              repositoryId: preparation.repository.id,
              label: preparation.repository.label,
              baseRef: review.sourceBranch,
            },
          ],
          planning: { folder: "plansAndKanban", format: "kanban" },
        },
        creationKey,
      );
      const returnedRepository = created.workspace.repositories.find(
        (repository) => repository.repositoryId === preparation.repository.id,
      );
      if (
        created.workspace.intent.type !== "repositorySet" ||
        created.workspace.intent.label !== reviewLabel ||
        returnedRepository?.baseRef !== review.sourceBranch
      ) {
        throw new Error("WTS saved a different review workspace.");
      }

      const workspace = workspaceFromView(created.workspace);
      createdWorkspaceId = workspace.id;
      reviewWorkspaceHydrationSkipsRef.current.add(workspace.id);
      setWorkspaces((current) => [
        ...current.filter((candidate) => candidate.id !== workspace.id),
        workspace,
      ]);
      invalidateDeepLinkLookup();
      setSelectedId(workspace.id);
      setReviewRepositoryId(preparation.repository.id);
      setWorkspaceCommandState("idle");
      setWorkspaceActionError("");
      setWorkspaceMaterialization(null);
      setView("workbench");
      setActiveTab("overview");
      pushNavigationPath(`/sessions/${encodeURIComponent(workspace.id)}`);
      setNotice(`${workspace.key} · WTS checks the review workspace`);

      setWorkspaceActionState("checking");
      const preflight = await client.preflightWorkspace(workspace.id);
      if (preflight.workspaceId !== workspace.id) {
        throw new Error("WTS returned setup effects for another workspace.");
      }
      setWorkspacePreflight(preflight);
      if (!preflight.ready) {
        setWorkspaceActionState("blocked");
        setNotice(
          `${workspace.key} needs ${preflight.blockers.length} local setup decision${preflight.blockers.length === 1 ? "" : "s"}`,
        );
        return;
      }

      setWorkspaceActionState("materializing");
      const materializationKey =
        reviewWorkspaceMaterializationKeysRef.current.get(
          `${workspace.id}:${preflight.effectDigest}`,
        ) ?? newIdempotencyKey();
      reviewWorkspaceMaterializationKeysRef.current.set(
        `${workspace.id}:${preflight.effectDigest}`,
        materializationKey,
      );
      const materialized = await client.materializeWorkspace(
        workspace.id,
        preflight.effectDigest,
        materializationKey,
      );
      if (materialized.materialization.workspaceId !== workspace.id) {
        throw new Error("WTS returned materialization for another workspace.");
      }
      materializationCache.set(workspace.id, materialized.materialization);
      workspaceActionGenerationRef.current += 1;
      setWorkspaceMaterialization(materialized.materialization);
      setWorkspaceActionState("materialized");
      setWorkspaces((current) =>
        current.map((candidate) =>
          candidate.id === workspace.id
            ? {
                ...candidate,
                lane: "planned",
                summary: `${worktreeCount(materialized.materialization.worktrees.length)} ready`,
              }
            : candidate,
        ),
      );
      setActiveTab("changes");
      pushNavigationPath(
        `/sessions/${encodeURIComponent(workspace.id)}/changes?repository=${encodeURIComponent(preparation.repository.id)}`,
      );
      setNotice(`${workspace.key} ready · Codex starts the initial review`);

      try {
        await client.launchAgentSession(workspace.id, {
          provider: "codex",
          category: "review",
          prompt: [
            `Review GitLab merge request ${review.repository} !${review.number}.`,
            `Compare source branch ${review.sourceBranch} with target branch ${review.targetBranch}.`,
            "Read WTS.md and the trusted workspace context before you start.",
            "Inspect the complete change and identify defects, risks, missing tests, and unclear behavior.",
            "Do not modify source files.",
            "Write the durable initial review into the workspace planning home.",
            "Include file paths and line numbers for each finding.",
          ].join(" "),
        });
      } catch (error) {
        setNotice(
          error instanceof Error
            ? `The review workspace is ready. Codex did not start: ${error.message}`
            : "The review workspace is ready. Codex did not start.",
          "error",
        );
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "WTS could not prepare this review repository.";
      if (createdWorkspaceId) {
        setActiveTab("overview");
        setWorkspaceActionState("error");
        setWorkspaceActionError(message);
        setWorkspaceActionErrorCode(error instanceof WorkspaceClientError ? error.code : "");
        setWorkspacePreflight(null);
      }
      setReviewWorkspaceErrors((current) =>
        new Map(current).set(review.id, message),
      );
      setNotice(`${review.repository} !${review.number} · ${message}`, "error");
    } finally {
      preparingReviewIdRef.current = "";
      setPreparingReviewId("");
    }
  };

  const openAssignedGitlabReview = async (review: GitlabReview) => {
    if (openingAssignedReviewId) return;
    setOpeningAssignedReviewId(review.id);
    setReviewWorkspaceErrors((current) => {
      const next = new Map(current);
      next.delete(review.id);
      return next;
    });
    try {
      const result = await client.openGitlabMergeRequest(
        review.repositoryId,
        review.number,
      );
      if (
        !result.accepted ||
        result.repositoryId !== review.repositoryId ||
        result.iid !== review.number
      ) {
        throw new Error("WTS returned a different merge-request handoff.");
      }
      setNotice(`${review.repository} !${review.number} · GitLab opened`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "WTS could not open this merge request.";
      setReviewWorkspaceErrors((current) =>
        new Map(current).set(review.id, message),
      );
      setNotice(`${review.repository} !${review.number} · ${message}`, "error");
    } finally {
      setOpeningAssignedReviewId("");
    }
  };

  const openWorkspaceGitlabMergeRequest = async (
    mergeRequest: GitlabMergeRequest,
  ) => {
    try {
      const result = await client.openGitlabMergeRequest(
        mergeRequest.repositoryId,
        mergeRequest.iid,
      );
      if (
        !result.accepted ||
        result.repositoryId !== mergeRequest.repositoryId ||
        result.iid !== mergeRequest.iid
      ) {
        throw new Error("WTS returned a different merge-request handoff.");
      }
      setNotice(
        `${mergeRequest.projectPath} !${mergeRequest.iid} · GitLab opened`,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "WTS could not open this merge request.";
      setNotice(
        `${mergeRequest.projectPath} !${mergeRequest.iid} · ${message}`,
        "error",
      );
    }
  };

  const copySelectedWorkspacePath = async () => {
    if (!selectedWorkspace) return;
    if (!navigator.clipboard?.writeText) {
      setNotice("Clipboard unavailable · Could not copy workspace path");
      return;
    }
    try {
      await navigator.clipboard.writeText(selectedWorkspace.path);
      setNotice(`${selectedWorkspace.path} copied`);
    } catch {
      setNotice("Clipboard denied · Could not copy workspace path");
    }
  };

  const startWorkspaceRename = () => {
    if (!selectedWorkspace || workspaceNameSaving) return;
    cancelWorkspaceRenameRef.current = false;
    setWorkspaceNameDraft(selectedWorkspace.title);
    setWorkspaceNameError("");
    setWorkspaceNameEditing(true);
  };

  const cancelWorkspaceRename = () => {
    cancelWorkspaceRenameRef.current = true;
    setWorkspaceNameEditing(false);
    setWorkspaceNameError("");
  };

  const saveWorkspaceName = async () => {
    if (!selectedWorkspace || workspaceNameSaving || workspaceRenamePendingRef.current) return;
    const title = workspaceNameDraft.trim();
    if (!title) {
      setWorkspaceNameError("Workspace name is required.");
      return;
    }
    if (title === selectedWorkspace.title) {
      setWorkspaceNameEditing(false);
      setWorkspaceNameError("");
      return;
    }
    const generation = workspaceRenameGenerationRef.current;
    workspaceRenamePendingRef.current = true;
    setWorkspaceNameSaving(true);
    setWorkspaceNameError("");
    try {
      const renamed = await client.renameWorkspace(selectedWorkspace.id, title);
      if (renamed.workspaceId !== selectedWorkspace.id) {
        throw new Error("WTS returned another workspace after renaming.");
      }
      if (workspaceRenameClientRef.current !== client) return;
      const updated = workspaceFromView(renamed);
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === updated.id ? updated : workspace,
        ),
      );
      if (generation === workspaceRenameGenerationRef.current) setWorkspaceNameEditing(false);
      setNotice(`Renamed workspace to ${updated.title}`);
    } catch (error) {
      if (workspaceRenameClientRef.current !== client) return;
      const message = error instanceof Error ? error.message : "Workspace rename failed.";
      if (generation === workspaceRenameGenerationRef.current) setWorkspaceNameError(message);
      else setNotice(`${selectedWorkspace.key}: ${message}`, "error");
    } finally {
      if (generation === workspaceRenameGenerationRef.current) {
        workspaceRenamePendingRef.current = false;
        setWorkspaceNameSaving(false);
      }
    }
  };

  useEffect(() => {
    if (view !== "workbench" || !selectedId) return;
    navigationCache.set(selectedId, { tab: activeTab, repositoryId: reviewRepositoryId });
  }, [activeTab, navigationCache, reviewRepositoryId, selectedId, view]);

  useLayoutEffect(() => {
    const viewport = workbenchScrollRef.current;
    if (view !== "workbench" || !selectedWorkspaceIsReady || !viewport) return;
    const position = scrollCache.get(`${selectedId}\0${activeTab}`);
    viewport.scrollTop = position?.top ?? 0;
    viewport.scrollLeft = position?.left ?? 0;
  }, [activeTab, scrollCache, selectedId, selectedWorkspaceIsReady, view]);

  const resetOperationalState = (workspace: Workspace) => {
    const cached = materializationCache.get(workspace.id) ?? null;
    workspaceActionGenerationRef.current += 1;
    setReviewRepositoryId(navigationCache.get(workspace.id)?.repositoryId ?? "");
    setWorkspaceCommandState("idle");
    setWorkspaceActionState(cached ? "materialized" : "idle");
    setWorkspacePreflight(null);
    setWorkspaceMaterialization(cached);
    setWorkspaceActionError("");
    materializationKeyRef.current = null;
  };

  useEffect(() => {
    const handleHistoryNavigation = () => {
      const target = historyNavigationTarget(globalThis.location?.pathname ?? "/");
      if (!target) return;

      closeCommandPalette();
      setGuideOpen(false);
      setSetupOpen(false);
      setRemovalOpen(false);
      invalidateDeepLinkLookup();

      if (target.view === "board") {
        pendingBoardFocusRef.current =
          visibleWorkspaces[0]?.id ?? workspaces[0]?.id ?? null;
        setView("board");
        return;
      }
      if (target.view === "time") {
        setView("time");
        return;
      }
      if (target.view === "reviews") {
        setView("reviews");
        return;
      }

      const workspace = workspaces.find(
        (item) => item.id === target.workspaceId,
      );
      if (!workspace) return;
      setSelectedId(workspace.id);
      resetOperationalState(workspace);
      setActiveTab(target.tab);
      if (target.tab === "changes") {
        setReviewRepositoryId(
          new URLSearchParams(globalThis.location?.search ?? "").get(
            "repository",
          ) ?? "",
        );
      }
      setView("workbench");
    };

    window.addEventListener("popstate", handleHistoryNavigation);
    return () =>
      window.removeEventListener("popstate", handleHistoryNavigation);
  }, [materializationCache, navigationCache, workspaces]);

  useEffect(() => {
    let generation = 0;
    let mounted = true;
    let stopHighlight: (() => void) | undefined;
    const openAgentWorkspace = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId: string; repositoryId: string; tab?: WorkbenchTab; selection?: FeedbackSelectionReturn }>).detail;
      if (!detail || typeof detail.workspaceId !== "string" || !detail.workspaceId.trim() ||
        typeof detail.repositoryId !== "string" || (!detail.repositoryId.trim() && !detail.selection && (!detail.tab || detail.tab === "changes"))) return;
      const request = ++generation;
      invalidateDeepLinkLookup();
      const navigationGeneration = agentNavigationGenerationRef.current;
      const open = (workspace: Workspace) => {
        if (!mounted || request !== generation || navigationGeneration !== agentNavigationGenerationRef.current) return;
        setWorkspaces((existing) => [...existing.filter((item) => item.id !== workspace.id), workspace]);
        setSelectedId(workspace.id);
        resetOperationalState(workspace);
        setReviewRepositoryId(detail.repositoryId);
        const tab = detail.tab ?? "changes";
        setActiveTab(tab);
        setView("workbench");
        const query = detail.repositoryId && tab === "changes" ? `?repository=${encodeURIComponent(detail.repositoryId)}` : "";
        pushNavigationPath(`/sessions/${encodeURIComponent(workspace.id)}${tab === "overview" ? "" : `/${tab}`}${query}`);
        if (detail.selection) {
          feedbackReturnNavigationRef.current = navigationGeneration;
          setFeedbackSelectionReturn(detail.selection);
          if (detail.selection.source.kind === "ui") {
            stopHighlight?.();
            stopHighlight = highlightFeedbackSelection(detail.selection.source.calloutId,
              () => mounted && request === generation && navigationGeneration === agentNavigationGenerationRef.current,
              () => setNotice("The original page is open, but the saved region is not visible. Its context remains in Agent feedback.", "info"));
          }
        }
      };
      const existing = agentNavigationWorkspacesRef.current.find((workspace) => workspace.id === detail.workspaceId);
      if (existing) { open(existing); return; }
      void client.getWorkspace(detail.workspaceId).then((result) => {
        if (result.workspaceId !== detail.workspaceId) throw new Error("Unexpected workspace");
        open(workspaceFromView(result));
      }).catch(() => {
        if (mounted && request === generation && navigationGeneration === agentNavigationGenerationRef.current) setNotice("WTS could not open the agent workspace. Select View local changes to try again.", "error");
      });
    };
    const returnFeedbackSelection = (event: Event) => {
      const detail = (event as CustomEvent<FeedbackSelectionReturn>).detail;
      if (!detail || typeof detail.requestId !== "string" || !detail.source) return;
      const source = detail.source;
      stopHighlight?.();
      closeCommandPalette();
      setGuideOpen(false);
      setSetupOpen(false);
      setRemovalOpen(false);
      if (source.kind === "workItem") {
        invalidateDeepLinkLookup();
        const request = ++generation;
        const navigationGeneration = agentNavigationGenerationRef.current;
        if (!client.getAgentConversation) {
          setNotice("This host cannot read the original selection. Open the parent result in Agent feedback.", "error");
          return;
        }
        void resolveFeedbackSelectionOrigin(source, id => client.getAgentConversation!(id)).then(origin => {
          if (!mounted || request !== generation || navigationGeneration !== agentNavigationGenerationRef.current) return;
          returnFeedbackSelection(new CustomEvent(RETURN_FEEDBACK_SELECTION_EVENT, { detail: { ...detail, source: origin } }));
        }).catch(() => {
          if (mounted && request === generation && navigationGeneration === agentNavigationGenerationRef.current) {
            setNotice("WTS could not read the original selection. Open the parent result in Agent feedback and retry.", "error");
          }
        });
        return;
      }
      if (source.kind === "gitlabDiscussion") {
        openAgentWorkspace(new CustomEvent("wts:open-agent-workspace", { detail: {
          workspaceId: source.workspaceId, repositoryId: source.repositoryId, selection: detail,
        } }));
        return;
      }
      if (source.kind !== "ui" || typeof source.route !== "string" || typeof source.calloutId !== "string") return;
      const target = source.route.startsWith("/") && !source.route.startsWith("//") && !source.route.includes("\\")
        ? source.route === "/sessions/new" ? { view: "board" as const } : historyNavigationTarget(source.route.split("?")[0]!) : null;
      if (!target) {
        setNotice("The saved selection does not have a supported WTS page. Its context remains in Agent feedback.", "error");
        return;
      }
      if (target.view === "workbench") {
        openAgentWorkspace(new CustomEvent("wts:open-agent-workspace", { detail: {
          workspaceId: target.workspaceId, tab: target.tab,
          repositoryId: new URLSearchParams(source.route.split("?")[1] ?? "").get("repository") ?? "",
          selection: detail,
        } }));
      } else {
        invalidateDeepLinkLookup();
        const request = ++generation;
        const navigationGeneration = agentNavigationGenerationRef.current;
        setView(target.view);
        pushNavigationPath(target.view === "board" ? "/" : `/${target.view}`);
        feedbackReturnNavigationRef.current = navigationGeneration;
        setFeedbackSelectionReturn(detail);
        stopHighlight = highlightFeedbackSelection(source.calloutId,
          () => mounted && request === generation && navigationGeneration === agentNavigationGenerationRef.current,
          () => setNotice("The original page is open, but the saved region is not visible. Its context remains in Agent feedback.", "info"));
      }
      if (source.calloutId.startsWith("environment.")) setSetupOpen(true);
      else if (source.calloutId.startsWith("guide.")) setGuideOpen(true);
      else if (source.calloutId.startsWith("workspace-create.")) setCreateOpen(true);
    };
    const openAgentSettings = () => setSetupOpen(true);
    window.addEventListener(RETURN_FEEDBACK_SELECTION_EVENT, returnFeedbackSelection);
    window.addEventListener("wts:open-agent-workspace", openAgentWorkspace);
    window.addEventListener("wts:open-agent-settings", openAgentSettings);
    return () => {
      mounted = false;
      stopHighlight?.();
      window.removeEventListener(RETURN_FEEDBACK_SELECTION_EVENT, returnFeedbackSelection);
      window.removeEventListener("wts:open-agent-workspace", openAgentWorkspace);
      window.removeEventListener("wts:open-agent-settings", openAgentSettings);
    };
  }, [client, materializationCache, navigationCache]);

  const openWorkspace = (workspaceId: string) => {
    const item = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!item) return;
    invalidateDeepLinkLookup();
    setSelectedId(workspaceId);
    resetOperationalState(item);
    const previousTab = navigationCache.get(workspaceId)?.tab ?? "overview";
    setActiveTab(previousTab);
    setView("workbench");
    const suffix = previousTab === "overview" ? "" : `/${previousTab}`;
    const repositoryId = navigationCache.get(workspaceId)?.repositoryId;
    const query = previousTab === "changes" && repositoryId
      ? `?repository=${encodeURIComponent(repositoryId)}` : "";
    pushNavigationPath(`/sessions/${encodeURIComponent(workspaceId)}${suffix}${query}`);
  };

  const openAttentionItem = (item: WorkspaceAttentionItem) => {
    const target = item.target;
    if (target.kind === "agent") {
      openAgentFeedbackResult({ conversationId: target.conversationId, requestId: target.requestId, messageId: target.messageId });
    } else if (target.kind === "gitlab") {
      returnToFeedbackSelection({ kind: "gitlabDiscussion", workspaceId: item.workspaceId,
        repositoryId: target.repositoryId, iid: target.iid, discussionId: target.discussionId,
        scopeId: target.scopeId, filePath: target.filePath, comments: [] });
    } else {
      const workspace = workspaces.find(candidate => candidate.id === item.workspaceId);
      if (!workspace) { setNotice("This workspace is no longer available. Refresh the board.", "error"); return; }
      invalidateDeepLinkLookup();
      setSelectedId(workspace.id);
      resetOperationalState(workspace);
      setActiveTab("verification");
      setVerificationSelection({ ...target, workspaceId: workspace.id, requestId: crypto.randomUUID() });
      setView("workbench");
      pushNavigationPath(`/sessions/${encodeURIComponent(workspace.id)}/verification`);
    }
  };

  const focusWorkspaceInVscode = (workspaceId: string) => {
    void client
      .openWorkspaceInVscode(workspaceId)
      .then((result) => {
        if (
          result.workspaceId !== workspaceId ||
          result.provider !== "vsCode" ||
          !result.accepted
        ) {
          throw new Error("WTS returned a mismatched VS Code handoff.");
        }
        setNotice("Workspace opened in VS Code");
      })
      .catch((error) => {
        setNotice(
          error instanceof Error
            ? error.message
            : "VS Code could not open this workspace",
        );
      });
  };

  const openWorkspaceJira = (workspace: Workspace) => {
    if (workspace.intent.type !== "jira") return;
    const issueKey = workspace.intent.issueKey;
    void client
      .previewWorkspaceJiraLink(workspace.id, issueKey, "primary")
      .then((preview) =>
        client.openWorkspaceJiraPreview(
          workspace.id,
          issueKey,
          preview.role,
          preview.previewDigest,
        ),
      )
      .then((result) => {
        if (result.workspaceId !== workspace.id || result.issueKey !== issueKey) {
          throw new Error("WTS returned a mismatched Jira handoff.");
        }
      })
      .catch((error: unknown) => {
        setNotice(
          error instanceof Error
            ? error.message
            : `Jira could not open ${issueKey}.`,
          "error",
        );
      });
  };

  const completeCreation = (view: WorkspaceView) => {
    invalidateDeepLinkLookup();
    const workspace = workspaceFromView(view);
    setWorkspaces((current) => {
      const exists = current.some((item) => item.id === workspace.id);
      return exists
        ? current.map((item) => (item.id === workspace.id ? workspace : item))
        : [...current, workspace];
    });
    setSelectedId(workspace.id);
    resetOperationalState(workspace);
    setView("workbench");
    setActiveTab("overview");
    pushNavigationPath(`/sessions/${encodeURIComponent(workspace.id)}`);
    setCreatePlanningEnabled(undefined);
    if (resumedWorkspaceCreationId) {
      setDeferredWorkspaceCreations((current) =>
        current.filter((task) => task.id !== resumedWorkspaceCreationId),
      );
      setResumedWorkspaceCreationId("");
    }
    setNotice(`${workspace.key} plan saved · no setup effects have run`);
  };

  const reviewWorkspaceSetup = async (repositoryIdToRefresh?: string) => {
    if (!selectedWorkspace || workspaceCommandState !== "idle") return;
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setWorkspaceActionError("");
    setWorkspaceActionErrorCode("");
    setWorkspacePreflight(null);
    setWorkspaceActionState("checking");
    try {
      if (repositoryIdToRefresh) {
        setNotice(`${workspaceKey} · fetching current branches from origin`);
        const refreshedRepository = await client.refreshRepositoryBranches(
          repositoryIdToRefresh,
        );
        if (actionGeneration !== workspaceActionGenerationRef.current) return;
        setRepositoryCatalog((current) => {
          if (!current) return current;
          return {
            ...current,
            repositories: [
              ...current.repositories.filter(
                (repository) => repository.id !== refreshedRepository.id,
              ),
              refreshedRepository,
            ],
          };
        });
      }
      const preflight = await client.preflightWorkspace(workspaceId);
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      if (preflight.workspaceId !== workspaceId) {
        throw new Error("WTS returned setup effects for another workspace.");
      }
      setWorkspacePreflight(preflight);
      setWorkspaceActionState(preflight.ready ? "ready" : "blocked");
      setNotice(
        preflight.ready
          ? `${workspaceKey} preflight ready · ${preflight.repositories.length} exact Git effects`
          : `${workspaceKey} needs ${preflight.blockers.length} local setup decision${preflight.blockers.length === 1 ? "" : "s"}`,
      );
    } catch (error) {
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      setWorkspaceActionError(
        error instanceof Error
          ? error.message
          : "Workspace preflight could not be completed.",
      );
      setWorkspaceActionErrorCode(error instanceof WorkspaceClientError ? error.code : "");
      setWorkspaceActionState("error");
      setNotice(`${workspaceKey} preflight failed`, "error");
    }
  };

  const recoverSelectedWorkspaceSetup = async () => {
    const recovery = workspacePreflight?.setupRecovery;
    if (!selectedWorkspace || workspacePreflight?.workspaceId !== selectedWorkspace.id ||
      !recovery?.ready || recovery.blockers.length > 0 || workspaceCommandState !== "idle" ||
      setupRecoveryPendingRef.current.has(selectedWorkspace.id) || !nativePreviewAllowsCommand("recover_workspace_setup")) return;
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setupRecoveryPendingRef.current.add(workspaceId);
    setWorkspaceCommandState("recoveringSetup");
    setWorkspaceActionError("");
    setWorkspaceActionErrorCode("");
    setNotice(`${workspaceKey} · WTS checks and cleans the setup files`);
    try {
      const result = await client.recoverWorkspaceSetup(workspaceId, recovery.effectDigest);
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      if (result.workspaceId !== workspaceId) throw new Error("WTS returned setup effects for another workspace.");
      setWorkspacePreflight(result);
      setWorkspaceActionState(result.ready ? "ready" : "blocked");
      materializationKeyRef.current = null;
      setNotice(`${workspaceKey} · review the current setup before you create the workspace`);
    } catch (error) {
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      setWorkspacePreflight(null);
      setWorkspaceActionState("error");
      setWorkspaceActionErrorCode(error instanceof WorkspaceClientError ? error.code : "");
      setWorkspaceActionError(`${error instanceof Error ? error.message : "WTS could not confirm setup cleanup."} Review setup again before you clean files or create the workspace.`);
      setNotice(`${workspaceKey} setup needs a fresh review`, "error");
    } finally {
      setupRecoveryPendingRef.current.delete(workspaceId);
      if (actionGeneration === workspaceActionGenerationRef.current) setWorkspaceCommandState("idle");
    }
  };

  const materializeSelectedWorkspace = async () => {
    if (
      !selectedWorkspace ||
      !workspacePreflight?.ready ||
      Boolean(workspacePreflight.setupRecovery) ||
      workspaceCommandState !== "idle"
    ) {
      return;
    }
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const digest = workspacePreflight.effectDigest;
    if (
      !materializationKeyRef.current ||
      materializationKeyRef.current.digest !== digest
    ) {
      materializationKeyRef.current = {
        digest,
        key: newIdempotencyKey(),
      };
    }
    const idempotencyKey = materializationKeyRef.current.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setWorkspaceActionError("");
    setWorkspaceActionState("materializing");
    setNotice(`${workspaceKey} · creating isolated worktrees…`);
    try {
      const result = await client.materializeWorkspace(
        workspaceId,
        digest,
        idempotencyKey,
      );
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      if (result.materialization.workspaceId !== workspaceId) {
        throw new Error("WTS returned materialization for another workspace.");
      }
      materializationCache.set(workspaceId, result.materialization);
      setWorkspaceMaterialization(result.materialization);
      setWorkspaceActionState("materialized");
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === workspaceId
            ? {
                ...workspace,
                lane: "planned",
                summary: `${worktreeCount(result.materialization.worktrees.length)} ready`,
              }
            : workspace,
        ),
      );
      setNotice(`${workspaceKey} ready · source checkouts were left unchanged`);
    } catch (error) {
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      setWorkspaceActionError(
        error instanceof Error ? error.message : "Workspace creation failed.",
      );
      setWorkspaceActionErrorCode(error instanceof WorkspaceClientError ? error.code : "");
      setWorkspacePreflight(null);
      setWorkspaceActionState("error");
      setNotice(`${workspaceKey} was not created`, "error");
    }
  };

  const openSelectedWorkspaceInVscode = async (): Promise<boolean> => {
    if (
      !selectedWorkspace ||
      !workspaceMaterialization ||
      workspaceCommandState !== "idle"
    ) {
      return false;
    }
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setWorkspaceActionError("");
    setWorkspaceActionState("opening");
    try {
      const result = await client.openWorkspaceInVscode(workspaceId);
      if (actionGeneration !== workspaceActionGenerationRef.current) {
        return false;
      }
      if (
        result.workspaceId !== workspaceId ||
        result.provider !== "vsCode" ||
        !result.accepted ||
        result.codeWorkspaceDisplayPath !==
          workspaceMaterialization.codeWorkspaceDisplayPath
      ) {
        throw new Error("WTS returned a mismatched VS Code handoff.");
      }
      setWorkspaceActionState("materialized");
      setNotice(`${workspaceKey} sent to VS Code`);
      return true;
    } catch (error) {
      if (actionGeneration !== workspaceActionGenerationRef.current) {
        return false;
      }
      setWorkspaceActionError(
        error instanceof Error
          ? error.message
          : "VS Code could not open this workspace.",
      );
      setWorkspaceActionState("materialized");
      setNotice(`VS Code did not open ${workspaceKey}`, "error");
      return false;
    }
  };

  const refreshSelectedWorkspace = async () => {
    if (!selectedWorkspace || workspaceCommandState !== "idle") return;
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setWorkspaceCommandState("refreshing");
    setWorkspaceActionError("");
    setNotice(`${workspaceKey} · refreshing local status…`);
    try {
      const materialization =
        await client.getWorkspaceMaterialization(workspaceId);
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      const view = await client.getWorkspace(workspaceId);
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      if (view.workspaceId !== workspaceId) {
        throw new Error("WTS returned status for another workspace.");
      }
      const refreshed = workspaceFromView(view);
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === workspaceId ? refreshed : workspace,
        ),
      );
      materializationCache.set(workspaceId, materialization);
      setWorkspaceMaterialization(materialization);
      setWorkspacePreflight(null);
      setWorkspaceActionErrorCode("");
      setWorkspaceActionState(materialization ? "materialized" : "idle");
      setNotice(
        `${workspaceKey} · ${materialization ? "workspace is ready" : "saved plan is current"}`,
      );
    } catch (error) {
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      try {
        const reconciledView = await client.getWorkspace(workspaceId);
        if (
          actionGeneration === workspaceActionGenerationRef.current &&
          reconciledView.workspaceId === workspaceId
        ) {
          const reconciled = workspaceFromView(reconciledView);
          setWorkspaces((current) =>
            current.map((workspace) =>
              workspace.id === workspaceId ? reconciled : workspace,
            ),
          );
        }
      } catch {
        // Preserve the original refresh failure; reconciliation is best-effort.
      }
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      const message =
        error instanceof Error
          ? error.message
          : "Workspace status could not be refreshed.";
      setWorkspaceActionError(message);
      setWorkspaceActionErrorCode(
        error instanceof WorkspaceClientError ? error.code : "",
      );
      setNotice(`${workspaceKey} · refresh failed`);
    } finally {
      if (actionGeneration === workspaceActionGenerationRef.current) {
        setWorkspaceCommandState("idle");
      }
    }
  };

  const indexSelectedWorkspaceGraph = async () => {
    if (!selectedWorkspace || !workspaceMaterialization) {
      throw new Error("Create the workspace before building its graph.");
    }
    if (workspaceCommandState !== "idle") {
      throw new Error("Wait for the current workspace command to finish.");
    }
    const workspaceId = selectedWorkspace.id;
    setNotice(`${selectedWorkspace.key} · building workspace graph…`);
    const result = await client.indexWorkspaceGraph(workspaceId);
    if (result.workspaceId !== workspaceId) {
      throw new Error("WTS indexed another workspace.");
    }
    const materialization =
      await client.getWorkspaceMaterialization(workspaceId);
    if (!materialization) {
      throw new Error("The materialized workspace could not be reloaded.");
    }
    materializationCache.set(workspaceId, materialization);
    setWorkspaceMaterialization(materialization);
    setNotice(`${selectedWorkspace.key} · workspace graph ready`);
    return result;
  };

  const reindexSelectedWorkspaceGraph = async () => {
    if (!selectedWorkspace || workspaceCommandState !== "idle") {
      return;
    }
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setWorkspaceCommandState("reindexing");
    setWorkspaceActionError("");
    setWorkspaceActionErrorCode("");
    setNotice(`${workspaceKey} · registering Git changes and re-indexing…`);
    try {
      const result = await client.reindexWorkspaceGraph(workspaceId);
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      if (result.workspaceId !== workspaceId) {
        throw new Error("WTS re-indexed another workspace.");
      }
      const materialization =
        await client.getWorkspaceMaterialization(workspaceId);
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      if (!materialization) {
        throw new Error("The materialized workspace could not be reloaded.");
      }
      materializationCache.set(workspaceId, materialization);
      setWorkspaceMaterialization(materialization);
      setWorkspaceActionState("materialized");
      setWorkspaceActionErrorCode("");
      setNotice(
        `${workspaceKey} · Git state registered and graph refreshed in ${Math.max(0, result.durationMs)} ms`,
      );
    } catch (error) {
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      try {
        const reconciled =
          await client.getWorkspaceMaterialization(workspaceId);
        if (
          actionGeneration === workspaceActionGenerationRef.current &&
          reconciled?.workspaceId === workspaceId
        ) {
          materializationCache.set(workspaceId, reconciled);
          setWorkspaceMaterialization(reconciled);
          setWorkspaceActionState("materialized");
        }
      } catch {
        // Preserve the graph failure. Reconciliation is reported only when the
        // trusted materialization can be loaded again.
      }
      if (actionGeneration !== workspaceActionGenerationRef.current) return;
      const message =
        error instanceof Error
          ? error.message
          : "The workspace graph could not be re-indexed.";
      setWorkspaceActionError(message);
      setWorkspaceActionErrorCode(
        error instanceof WorkspaceClientError ? error.code : "",
      );
      setNotice(`${workspaceKey} · re-index failed`);
      return message;
    } finally {
      if (actionGeneration === workspaceActionGenerationRef.current) {
        setWorkspaceCommandState("idle");
      }
    }
  };

  const syncSelectedWorkspaceRepository = async (
    repositoryId: string,
  ): Promise<WorkspaceRepositorySyncResult> => {
    if (
      !selectedWorkspace ||
      !workspaceMaterialization ||
      workspaceCommandState !== "idle"
    ) {
      throw new Error("Wait for the current workspace command to finish.");
    }
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setWorkspaceCommandState("syncing");
    setWorkspaceActionError("");
    setWorkspaceActionErrorCode("");
    setNotice(`${workspaceKey} · syncing repository and rebuilding graph…`);
    try {
      const result = await client.syncWorkspaceRepository(
        workspaceId,
        repositoryId,
      );
      if (actionGeneration !== workspaceActionGenerationRef.current) {
        throw new Error("The selected workspace changed during sync.");
      }
      if (
        result.workspaceId !== workspaceId ||
        result.repositoryId !== repositoryId ||
        result.materialization.workspaceId !== workspaceId
      ) {
        throw new Error("WTS returned a sync result for another repository.");
      }
      materializationCache.set(workspaceId, result.materialization);
      setWorkspaceMaterialization(result.materialization);
      setWorkspaceActionState("materialized");
      setNotice(
        result.graphRefreshed
          ? `${workspaceKey} · ${result.repositoryLabel} synced and graph refreshed`
          : `${workspaceKey} · ${result.repositoryLabel} synced; graph needs a re-index`,
      );
      return result;
    } catch (error) {
      if (actionGeneration === workspaceActionGenerationRef.current) {
        const message =
          error instanceof Error
            ? error.message
            : "The repository could not be synced.";
        setWorkspaceActionError(message);
        setWorkspaceActionErrorCode(
          error instanceof WorkspaceClientError ? error.code : "",
        );
        setNotice(`${workspaceKey} · repository sync failed`);
      }
      throw error;
    } finally {
      if (actionGeneration === workspaceActionGenerationRef.current) {
        setWorkspaceCommandState("idle");
      }
    }
  };

  const alignSelectedWorkspaceRepository = async (
    repositoryId: string,
    effectDigest: string,
  ): Promise<WorkspaceRepositoryAlignmentResult> => {
    if (
      !selectedWorkspace ||
      !workspaceMaterialization ||
      workspaceCommandState !== "idle"
    ) {
      throw new Error("Wait for the current workspace command to finish.");
    }
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setWorkspaceCommandState("aligning");
    setWorkspaceActionError("");
    setWorkspaceActionErrorCode("");
    setNotice(`${workspaceKey} · preserving the old commit and aligning repository…`);
    try {
      const result = await client.alignWorkspaceRepository(
        workspaceId,
        repositoryId,
        effectDigest,
      );
      if (actionGeneration !== workspaceActionGenerationRef.current) {
        throw new Error("The selected workspace changed during alignment.");
      }
      if (
        result.workspaceId !== workspaceId ||
        result.repositoryId !== repositoryId ||
        result.materialization.workspaceId !== workspaceId
      ) {
        throw new Error("WTS returned alignment results for another repository.");
      }
      materializationCache.set(workspaceId, result.materialization);
      setWorkspaceMaterialization(result.materialization);
      setWorkspaceActionState("materialized");
      setNotice(
        result.graphRefreshed
          ? `${workspaceKey} · repository aligned and graph refreshed`
          : `${workspaceKey} · repository aligned; graph needs a re-index`,
      );
      return result;
    } catch (error) {
      if (actionGeneration === workspaceActionGenerationRef.current) {
        setWorkspaceActionError(
          error instanceof Error
            ? error.message
            : "The repository could not be aligned.",
        );
        setWorkspaceActionErrorCode(
          error instanceof WorkspaceClientError ? error.code : "",
        );
      }
      throw error;
    } finally {
      if (actionGeneration === workspaceActionGenerationRef.current) {
        setWorkspaceCommandState("idle");
      }
    }
  };

  const loadRemovalPreflight = async (requestedWorkspaceId?: string) => {
    const workspaceId = requestedWorkspaceId ?? selectedWorkspace?.id;
    if (!workspaceId) return;
    const generation = ++removalGenerationRef.current;
    removalKeyRef.current = null;
    setRemovalState("loading");
    setRemovalPreflight(null);
    setRemovalError("");
    try {
      const preflight = await client.preflightWorkspaceRemoval(workspaceId);
      if (generation !== removalGenerationRef.current) return;
      if (preflight.workspaceId !== workspaceId) {
        throw new Error("WTS returned removal effects for another workspace.");
      }
      setRemovalPreflight(preflight);
      setRemovalState("ready");
    } catch (error) {
      if (generation !== removalGenerationRef.current) return;
      setRemovalError(
        error instanceof Error
          ? error.message
          : "Workspace removal could not be reviewed.",
      );
      setRemovalState("error");
    }
  };

  const reviewSelectedWorkspaceRemoval = () => {
    if (!selectedWorkspace || workspaceCommandState !== "idle") return;
    setRemovalOpen(true);
    void loadRemovalPreflight();
  };

  const registerChangesForRemoval = async () => {
    if (!selectedWorkspace || removalState !== "ready" || workspaceCommandState !== "idle") return;
    const workspaceId = selectedWorkspace.id;
    const generation = ++removalGenerationRef.current;
    removalKeyRef.current = null;
    setRemovalState("repairing");
    setRemovalError("");
    const repairError = await reindexSelectedWorkspaceGraph();
    if (generation !== removalGenerationRef.current) return;
    const recheck = loadRemovalPreflight(workspaceId);
    const recheckGeneration = removalGenerationRef.current;
    await recheck;
    if (repairError && recheckGeneration === removalGenerationRef.current) {
      setRemovalError((current) => [repairError, current].filter(Boolean).join(" "));
    }
  };

  const closeRemovalForRecovery = () => {
    removalGenerationRef.current += 1;
    setRemovalOpen(false);
    setRemovalPreflight(null);
    setRemovalError("");
  };

  const reviewWorkspaceRemoval = (workspaceId: string) => {
    if (workspaceCommandState !== "idle") return;
    setSelectedId(workspaceId);
    setRemovalOpen(true);
    void loadRemovalPreflight(workspaceId);
  };

  const handleWorkspaceDragStart = (event: DragStartEvent) => {
    setDraggedWorkspaceId(String(event.active.id).replace(/^workspace:/, ""));
    workspaceDropPreviewRef.current = null;
    workspaceDragPointerYRef.current =
      "clientY" in event.activatorEvent &&
      typeof event.activatorEvent.clientY === "number"
        ? event.activatorEvent.clientY
        : null;
    setWorkspaceDropPreview(null);
  };

  const handleWorkspaceDragMove = (event: DragMoveEvent) => {
    const initialPointerY =
      "clientY" in event.activatorEvent &&
      typeof event.activatorEvent.clientY === "number"
        ? event.activatorEvent.clientY
        : null;
    workspaceDragPointerYRef.current =
      initialPointerY === null ? null : initialPointerY + event.delta.y;
  };

  const placementForWorkspaceDrop = (
    event: DragOverEvent | DragEndEvent,
    workspace: Workspace,
  ): WorkspaceBoardPlacement | null => {
    if (!event.over) return null;
    const data = event.over.data.current;
    if (data?.type !== "card" && data?.type !== "column") return null;
    const targetLane = data.lane;
    if (
      targetLane !== "planned" &&
      targetLane !== "active" &&
      targetLane !== "attention" &&
      targetLane !== "suspended"
    ) {
      return null;
    }
    const targetWorkspaceId =
      data.type === "card" && typeof data.workspaceId === "string"
        ? data.workspaceId
        : null;
    if (targetWorkspaceId === workspace.id) return null;
    const targetRect = event.over.rect;
    const activeRect = event.active.rect.current.translated;
    const initialActiveRect = event.active.rect.current.initial;
    const pointerY =
      initialActiveRect && activeRect
        ? initialActiveRect.top + initialActiveRect.height / 2 +
          (activeRect.top - initialActiveRect.top)
        : workspaceDragPointerYRef.current ??
          (activeRect ? activeRect.top + activeRect.height / 2 : undefined);
    const sourceIndex = event.active.data.current?.index;
    const targetIndex = data.index;
    const edge =
      event.active.data.current?.lane === targetLane &&
      typeof sourceIndex === "number" &&
      typeof targetIndex === "number"
        ? targetIndex > sourceIndex
          ? "after"
          : "before"
        : pointerY !== undefined &&
            pointerY > targetRect.top + targetRect.height / 2
          ? "after"
          : "before";
    return {
      workspaceId: workspace.id,
      sourceLane: workspace.lane,
      targetLane,
      targetWorkspaceId,
      edge,
    };
  };

  const handleWorkspaceDragOver = (event: DragOverEvent) => {
    const workspaceId = String(event.active.id).replace(/^workspace:/, "");
    const workspace = workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    const placement = workspace
      ? placementForWorkspaceDrop(event, workspace)
      : null;
    workspaceDropPreviewRef.current = placement;
    setWorkspaceDropPreview(placement);
  };

  const saveLegacyBoardPlacement = (placement: WorkspaceBoardPlacement) => {
    const next = placeWorkspaceOnBoard(
      reconciledLegacyBoardOrder,
      placement,
    );
    try {
      saveWorkspaceBoardOrder(next);
    } catch {
      // The new position remains available for this session.
    }
    setLegacyWorkspaceBoardOrder(next);
    setWorkspaceBoardSessionOrder(next);
  };

  const mergeWorkflowSummary = (
    workspace: Workspace,
    workflow: Awaited<ReturnType<WorkspaceClient["placeWorkspaceOnBoard"]>>,
  ): Workspace => ({
    ...workspace,
    lane: laneForWorkflowState(workflow.state),
    workflowState: workflow.state,
    workflowRevision: workflow.revision,
    workflowUpdatedAtUnixMs: workflow.updatedAtUnixMs,
    workflowPersisted: true,
    workflowPlacementMode: workflow.placement?.mode,
    workflowPlacementRank: workflow.placement?.rank,
  });

  const followWorkspaceAgentActivity = async (workspaceId: string) => {
    const workspace = workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (
      !workspace ||
      !workspace.workflowPersisted ||
      workspaceCommandState !== "idle"
    ) {
      return;
    }
    setWorkspaceCommandState("refreshing");
    try {
      let workflow = await client.followWorkspaceAgent(
        workspaceId,
        workspace.workflowRevision,
      );
      const snapshot = workspaceAgents.get(workspaceId);
      const suggested = suggestedWorkflowState(workflow.state, snapshot, {
        allowUnpark: true,
      });
      if (suggested) {
        workflow = await client.transitionWorkspaceWorkflow(
          workspaceId,
          suggested,
          workflow.revision,
        );
        if (snapshot) {
          markWorkspaceWorkflowSignalHandled(
            workspaceId,
            snapshot.lastEventAtUnixMs,
          );
        }
      }
      setWorkspaces((current) =>
        current.map((candidate) =>
          candidate.id === workspaceId
            ? mergeWorkflowSummary(candidate, workflow)
            : candidate,
        ),
      );
      setNotice(`${workspace.key} now follows agent activity.`);
    } catch (error) {
      setNotice(
        error instanceof WorkspaceClientError &&
          error.code === "workspace_workflow_conflict"
          ? `${workspace.key} changed elsewhere. WTS refreshed the board.`
          : error instanceof Error
            ? error.message
            : `WTS could not update ${workspace.key}.`,
        "error",
      );
      setReloadRevision((current) => current + 1);
    } finally {
      setWorkspaceCommandState("idle");
    }
  };

  const moveWorkspaceToLane = async (
    workspaceId: string,
    lane: Lane,
    placement?: WorkspaceBoardPlacement,
  ) => {
    const workspace = workspaces.find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!workspace || workspaceCommandState !== "idle") return;
    const state = workflowStateForLane(lane);
    const effectivePlacement =
      placement ??
      ({
        workspaceId,
        sourceLane: workspace.lane,
        targetLane: lane,
        targetWorkspaceId: null,
        edge: "after",
      } satisfies WorkspaceBoardPlacement);
    if (
      workspace.workflowPersisted &&
      workspace.workflowState === state &&
      !placement
    ) {
      return;
    }
    const previousSessionOrder = workspaceBoardSessionOrder;
    const optimisticOrder = placeWorkspaceOnBoard(
      reconciledLegacyBoardOrder,
      effectivePlacement,
    );
    setWorkspaceBoardSessionOrder(optimisticOrder);
    setWorkspaceCommandState("refreshing");
    try {
      if (!workspace.workflowPersisted) {
        saveWorkspaceLane(workspaceId, lane);
        setWorkspaces((current) =>
          current.map((candidate) =>
            candidate.id === workspaceId
              ? {
                  ...candidate,
                  lane,
                  workflowState: state,
                }
              : candidate,
          ),
        );
      } else if (placement) {
        const workflow = await client.placeWorkspaceOnBoard(workspaceId, {
          state,
          expectedRevision: workspace.workflowRevision,
          ...workspacePlacementNeighbor(placement),
        });
        setWorkspaces((current) =>
          current.map((candidate) =>
            candidate.id === workspaceId
              ? mergeWorkflowSummary(candidate, workflow)
              : candidate,
          ),
        );
      } else {
        const workflow = await client.placeWorkspaceOnBoard(workspaceId, {
          state,
          expectedRevision: workspace.workflowRevision,
        });
        setWorkspaces((current) =>
          current.map((candidate) =>
            candidate.id === workspaceId
              ? mergeWorkflowSummary(candidate, workflow)
              : candidate,
          ),
        );
      }
      if (workspace.workflowPlacementRank === undefined) {
        saveLegacyBoardPlacement(effectivePlacement);
      }
      setNotice(
        workspace.workflowState === state
          ? `${workspace.key} position saved in ${laneDetails[lane].label}.`
          : `${workspace.key} moved to ${laneDetails[lane].label}.`,
      );
    } catch (error) {
      setWorkspaceBoardSessionOrder(previousSessionOrder);
      setNotice(
        error instanceof WorkspaceClientError &&
          error.code === "workspace_workflow_conflict"
          ? `${workspace.key} changed elsewhere. WTS refreshed the board.`
          : error instanceof Error
            ? error.message
            : `WTS could not move ${workspace.key}.`,
        "error",
      );
      setReloadRevision((current) => current + 1);
    } finally {
      setWorkspaceCommandState("idle");
    }
  };

  const handleWorkspaceDragEnd = (event: DragEndEvent) => {
    const workspaceId = String(event.active.id).replace(/^workspace:/, "");
    const lastPlacement = workspaceDropPreviewRef.current;
    setDraggedWorkspaceId(null);
    workspaceDropPreviewRef.current = null;
    workspaceDragPointerYRef.current = null;
    setWorkspaceDropPreview(null);
    const action = event.over
      ? resolveWorkspaceDropTarget(String(event.over.id))
      : null;
    if (!action) {
      if (lastPlacement) {
        void moveWorkspaceToLane(
          workspaceId,
          lastPlacement.targetLane,
          lastPlacement,
        );
      }
      return;
    }
    if (action.type === "delete") {
      reviewWorkspaceRemoval(workspaceId);
      return;
    }
    const placement =
      event.over?.data.current?.type === "column" &&
      lastPlacement?.targetLane === action.lane
        ? lastPlacement
        : undefined;
    void moveWorkspaceToLane(workspaceId, action.lane, placement);
  };

  const removeSelectedWorkspace = async (deleteProtectedPaths = false) => {
    const canRemoveReviewedLocalData =
      deleteProtectedPaths &&
      canAssertDestructiveWorkspaceRemoval(removalPreflight);
    if (
      !selectedWorkspace ||
      !removalPreflight ||
      (!removalPreflight.ready && !canRemoveReviewedLocalData) ||
      removalState !== "ready" ||
      workspaceCommandState !== "idle"
    ) {
      return;
    }
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const digest = removalPreflight.effectDigest;
    if (!removalKeyRef.current || removalKeyRef.current.digest !== digest) {
      removalKeyRef.current = {
        digest,
        key: newIdempotencyKey(),
      };
    }
    const generation = ++removalGenerationRef.current;
    setRemovalState("removing");
    setRemovalError("");
    setWorkspaceCommandState("removing");
    setNotice(`${workspaceKey} · removing reviewed local effects…`);
    try {
      const result: RemoveWorkspaceResult = await client.removeWorkspace(
        workspaceId,
        digest,
        removalKeyRef.current.key,
        deleteProtectedPaths,
      );
      if (generation !== removalGenerationRef.current) return;
      if (result.workspaceId !== workspaceId) {
        throw new Error("WTS removed another workspace.");
      }
      const nextWorkspace = workspaces.find(
        (workspace) => workspace.id !== workspaceId,
      );
      invalidateDeepLinkLookup();
      pendingBoardFocusRef.current = nextWorkspace?.id ?? null;
      setWorkspaces((current) =>
        current.filter((workspace) => workspace.id !== workspaceId),
      );
      setSelectedId(nextWorkspace?.id ?? "");
      materializationCache.delete(workspaceId);
      invalidateWorkspaceGitlabMergeRequests(client, workspaceId);
      navigationCache.delete(workspaceId);
      scrollCache.deletePrefix(`${workspaceId}\0`);
      clearPlanningWorkspaceCache(client, workspaceId);
      invalidateRepositoryReview(client, workspaceId);
      setWorkspaceMaterialization(null);
      setWorkspacePreflight(null);
      setWorkspaceActionState("idle");
      setRemovalOpen(false);
      setView("board");
      setNotice(
        `${workspaceKey} removed · ${result.retainedBranches.length} local branch${result.retainedBranches.length === 1 ? "" : "es"} retained`,
      );
    } catch (error) {
      if (generation !== removalGenerationRef.current) return;
      setRemovalError(
        error instanceof Error
          ? error.message
          : "Workspace removal did not complete.",
      );
      setRemovalState("error");
      setNotice(`${workspaceKey} · removal needs attention`);
    } finally {
      if (generation === removalGenerationRef.current) {
        setWorkspaceCommandState("idle");
      }
    }
  };

  const openSelectedWorkspaceCli = async (
    provider: AgentProvider,
    terminal: TerminalProvider,
  ) => {
    if (!selectedWorkspace || !workspaceMaterialization) {
      throw new Error("Create the workspace before opening a CLI.");
    }
    const workspaceId = selectedWorkspace.id;
    const providerName = providerFromView[provider];
    const terminalName = terminalNames[terminal];
    setNotice(
      `${selectedWorkspace.key} · opening ${providerName} in ${terminalName}…`,
    );
    const result = await client.openWorkspaceCli(
      workspaceId,
      provider,
      terminal,
    );
    if (
      result.workspaceId !== workspaceId ||
      result.provider !== provider ||
      result.terminal !== terminal ||
      result.workspaceDisplayPath !==
        workspaceMaterialization.workspaceDisplayPath
    ) {
      throw new Error("WTS returned a CLI handoff for another workspace.");
    }
    setNotice(
      `${selectedWorkspace.key} · ${providerName} handed off to ${terminalName}`,
    );
    return result;
  };

  const openSelectedWorkspacePreferred = async (): Promise<boolean> => {
    if (!selectedWorkspace || !workspaceMaterialization) return false;
    const preferredAgent = preferredAgentProvider(selectedWorkspace.provider);
    if (!preferredAgent) {
      return openSelectedWorkspaceInVscode();
    }

    const workspaceKey = selectedWorkspace.key;
    const providerName = providerFromView[preferredAgent];
    const terminal = preferredTerminalProvider(setupSnapshot?.integrations);
    setWorkspaceActionError("");
    setWorkspaceActionState("opening");
    try {
      const result = await openSelectedWorkspaceCli(preferredAgent, terminal);
      if (!result.accepted) {
        throw new Error(
          `${providerName} did not accept the workspace handoff.`,
        );
      }
      setWorkspaceActionState("materialized");
      return true;
    } catch (error) {
      setWorkspaceActionError(
        error instanceof Error
          ? error.message
          : `${providerName} could not open this workspace.`,
      );
      setWorkspaceActionState("materialized");
      setNotice(`${workspaceKey} · ${providerName} did not open`);
      return false;
    }
  };

  const saveWorkspaceAgentBrief = async (
    workspaceId: string,
    workspaceKey: string,
    prompt: string,
    revision: number,
  ) => {
    setCliDraft((current) =>
      current?.workspaceId === workspaceId && current.revision === revision
        ? {
            ...current,
            briefState: "saving",
            briefError: undefined,
          }
        : current,
    );
    try {
      const result = await client.writeWorkspaceAgentBrief(workspaceId, prompt);
      if (
        result.workspaceId !== workspaceId ||
        !result.briefDisplayPath.endsWith("/WTS.md")
      ) {
        throw new Error("WTS returned an agent brief for another workspace.");
      }
      setCliDraft((current) =>
        current?.workspaceId === workspaceId && current.revision === revision
          ? {
              ...current,
              briefState: "ready",
              briefDisplayPath: result.briefDisplayPath,
              briefError: undefined,
            }
          : current,
      );
      setNotice(`${workspaceKey} · WTS.md saved for the workspace agent`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The workspace agent brief could not be saved.";
      setCliDraft((current) =>
        current?.workspaceId === workspaceId && current.revision === revision
          ? {
              ...current,
              briefState: "error",
              briefError: message,
              briefDisplayPath: undefined,
            }
          : current,
      );
      setNotice(`${workspaceKey} · WTS.md could not be saved`);
    }
  };

  const board = (
    <main
      className={styles.boardMain}
      data-ui="spaces.board"
      data-ui-label="Spaces board"
    >
      <h1 className={styles.boardHeading} ref={boardHeadingRef} tabIndex={-1}>
        Spaces
      </h1>

      <div
        className={styles.boardToolbar}
        data-ui="spaces.toolbar"
        data-ui-label="Spaces toolbar"
      >
        <SearchField
          className={styles.searchField}
          data-expanded={searchExpanded || Boolean(search)}
          value={search}
          onChange={setSearch}
          aria-label="Search local workspaces"
          onBlur={(event) => {
            if (
              !search &&
              !event.currentTarget.contains(event.relatedTarget as Node | null)
            ) {
              setSearchExpanded(false);
            }
          }}
        >
          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <button
                ref={searchButtonRef}
                className={styles.searchToggle}
                aria-label="Search spaces"
                onClick={() => {
                  setSearchExpanded(true);
                  searchInputRef.current?.focus();
                }}
                type="button"
              >
                <Glyph name="search" size={16} />
              </button>
            </Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Content
                className={styles.tooltipContent}
                side="bottom"
                sideOffset={6}
              >
                Search spaces
              </Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
          <Input
            ref={searchInputRef}
            aria-hidden={!searchExpanded && !search}
            placeholder="Search workspaces, issues, or repositories"
            tabIndex={searchExpanded || search ? 0 : -1}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !search) {
                event.preventDefault();
                setSearchExpanded(false);
                searchButtonRef.current?.focus();
              }
            }}
          />
          {search && (
            <Button aria-label="Clear search" onPress={() => setSearch("")}>
              <Glyph name="close" size={14} />
            </Button>
          )}
        </SearchField>
        {workspaceCounts.all > 1 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className={styles.filterMenuTrigger} type="button">
                {filter === "all" ? "All workspaces" : laneDetails[filter].label}
                <span>{workspaceCounts[filter]}</span>
                <Glyph name="chevron" size={12} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="start"
                className={`${styles.portalSurface} ${styles.menuContent}`}
                sideOffset={6}
              >
                {(
                  [
                    ["all", "All workspaces"],
                    ["planned", "Ready"],
                    ["attention", "Review"],
                    ["active", "Active"],
                    ["suspended", "Parked"],
                  ] as Array<[Filter, string]>
                ).map(([value, label]) => (
                    <DropdownMenu.Item
                      className={styles.menuItem}
                      key={value}
                      onSelect={() => setFilter(value)}
                    >
                      <StateDot state={value === "all" ? "planned" : value} />
                      {label}
                      <span className={styles.filterMenuCount}>
                        {workspaceCounts[value]}
                      </span>
                    </DropdownMenu.Item>
                  ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
        <div className={styles.boardToolbarActions}>
          <Button
            aria-label="Refresh review status"
            className={styles.secondaryButton}
            onPress={() => {
              myReviews.refresh();
              refreshAttention(true);
              setNotice("WTS refreshes review status");
            }}
          >
            <Glyph name="refresh" size={13} />
            Refresh status
          </Button>
          <Button
            className={styles.secondaryButton}
            onPress={openTimeReview}
          >
            My time
          </Button>
          <Button
            className={styles.primaryButton}
            onPress={startNewWorkspace}
            isDisabled={registryState !== "ready"}
            ref={newWorkspaceButtonRef}
          >
            <Glyph name="plus" /> New workspace
          </Button>
        </div>
      </div>

      {registryState === "ready" && workspaces.length > 0 && <ConnectedBoardAttentionStatus store={attentionStore} onRefresh={() => refreshAttention(true)} />}
      {registryState === "loading" ? (
        <div className={styles.registryState}>
          <div
            className={styles.recoveryMessage}
            role="status"
            aria-busy="true"
          >
            <span className={styles.registrySpinner}>
              <Glyph name="refresh" size={20} />
            </span>
            <h2>Opening the local registry</h2>
            <p>Reading your saved workspace plans…</p>
          </div>
          <div
            className={styles.boardSkeleton}
            aria-hidden="true"
            data-testid="board-skeleton"
          >
            {[1, 2, 3].map((laneIdx) => (
              <div className={styles.skeletonLane} key={laneIdx}>
                <div className={styles.skeletonHeader} />
                <div className={styles.skeletonCard}>
                  <div className={`${styles.skeletonLine} ${styles.skeletonLineMedium}`} />
                  <div className={`${styles.skeletonLine} ${styles.skeletonLineLong}`} />
                  <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
                </div>
                <div className={styles.skeletonCard}>
                  <div className={`${styles.skeletonLine} ${styles.skeletonLineLong}`} />
                  <div className={`${styles.skeletonLine} ${styles.skeletonLineMedium}`} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : registryState === "error" ? (
        <div className={styles.registryState}>
          <div className={styles.recoveryMessage} role="alert">
            <span data-error>
              <Glyph name="warning" size={20} />
            </span>
            <h2>Couldn’t open the workspace registry</h2>
            <p>{registryError}</p>
          </div>
          <div className={styles.recoveryActions}>
            <Button className={styles.secondaryButton} onPress={retryRegistry}>
              <Glyph name="refresh" /> Retry connection
            </Button>
          </div>
        </div>
      ) : (
        <DndContext
          collisionDetection={workspaceDropCollision}
          onDragCancel={() => {
            setDraggedWorkspaceId(null);
            workspaceDropPreviewRef.current = null;
            workspaceDragPointerYRef.current = null;
            setWorkspaceDropPreview(null);
          }}
          onDragEnd={handleWorkspaceDragEnd}
          onDragMove={handleWorkspaceDragMove}
          onDragOver={handleWorkspaceDragOver}
          onDragStart={handleWorkspaceDragStart}
          sensors={boardSensors}
        >
          {visibleLanes.length > 1 && (
            <nav
              aria-label="Jump to a column"
              className={styles.laneJumpBar}
              data-ui="spaces.lane-jump"
              data-ui-label="Column jump bar"
            >
              {visibleLanes.map((lane) => (
                <a
                  className={styles.laneJumpLink}
                  data-tone={laneDetails[lane].tone}
                  href={`#workspace-lane-${lane}`}
                  key={lane}
                  onClick={(event) => {
                    event.preventDefault();
                    document
                      .getElementById(`workspace-lane-${lane}`)
                      ?.closest("section")
                      ?.scrollIntoView({ block: "nearest", inline: "start", behavior: "smooth" });
                  }}
                >
                  <StateDot state={lane} />
                  {laneDetails[lane].label}
                  <b>{visibleByLane[lane].length + (lane === "planned" ? visibleAssignedGitlabReviews.length : 0)}</b>
                </a>
              ))}
            </nav>
          )}
          <section
            className={styles.kanban}
            data-ui="spaces.lanes"
            data-ui-label="Workspace columns"
            data-filtered={filter !== "all"}
            data-lanes={visibleLanes.length}
            aria-label="Local workspace board"
          >
          {visibleLanes.map((lane) => {
            const items = visibleByLane[lane];
            const creationTasks = visibleDeferredWorkspaceCreations.filter(
              (task) => workspaceCreationLane(task) === lane,
            );
            const detail = laneDetails[lane];
            const laneHeadingId = `workspace-lane-${lane}`;
            return (
              <WorkspaceLaneDropTarget key={lane} lane={lane}>
                <header className={styles.laneHeader} data-tone={detail.tone}>
                  <span>
                    <StateDot state={lane} />
                    <h2 id={laneHeadingId}>{detail.label}</h2>
                    <span
                      aria-label={`${items.length + (lane === "planned" ? visibleAssignedGitlabReviews.length : 0)} items`}
                      className={styles.laneCount}
                    >
                      {items.length + (lane === "planned" ? visibleAssignedGitlabReviews.length : 0)}
                    </span>
                  </span>
                </header>
                <div className={styles.laneCards}>
                  {creationTasks.map((task) => (
                    <WorkspaceCreationTaskCard
                      key={task.id}
                      onContinue={() => resumeWorkspaceCreation(task.id)}
                      task={task}
                    />
                  ))}
                  {lane === "planned" &&
                    visibleAssignedGitlabReviews.map((review) => (
                      <AssignedReviewCard
                        error={reviewWorkspaceErrors.get(review.id)}
                        key={`review:${review.id}`}
                        onOpen={() => void openAssignedGitlabReview(review)}
                        onPrepare={() =>
                          void startGitlabReviewWorkspace(review)
                        }
                        opening={openingAssignedReviewId === review.id}
                        preparing={preparingReviewId === review.id}
                        review={review}
                      />
                    ))}
                  {items.map((workspace, index) => (
                    <DraggableWorkspaceCard
                      key={workspace.id}
                      workspace={workspace}
                      displayLane={lane}
                      index={index}
                      dropIndicator={
                        workspaceDropPreview?.targetWorkspaceId === workspace.id
                          ? workspaceDropPreview.edge
                          : undefined
                      }
                      agent={workspaceAgents.get(workspace.id)}
                      attention={<ConnectedWorkspaceAttentionCard store={attentionStore} workspaceId={workspace.id} workspaceLabel={workspace.key}
                        onOpen={openAttentionItem} onRefresh={() => refreshAttention(true)} />}
                      mergeRequests={
                        workspaceGitlabInboxes.get(workspace.id)?.mergeRequests
                      }
                      gitlabReview={gitlabReviewForWorkspace(
                        workspace,
                        myReviews.gitlabInbox?.reviews ?? [],
                      )}
                      onOpenMergeRequest={(mergeRequest) =>
                        void openWorkspaceGitlabMergeRequest(mergeRequest)
                      }
                      placementLabel={
                        workspace.workflowPlacementMode === "pinned"
                          ? "Pinned"
                          : undefined
                      }
                      reorderDisabled={filter !== "all" || Boolean(search)}
                      primaryActionLabel={
                        workspaceAgents.get(workspace.id)?.observedLocally &&
                        workspaceCardClickPreference === "workspace"
                          ? `Open ${workspace.key}: ${workspace.title} in VS Code`
                          : `Open ${workspace.key}: ${workspace.title} details`
                      }
                      onOpen={(modified) => {
                        const action = resolveWorkspaceCardAction(
                          workspaceCardClickPreference,
                          modified,
                          Boolean(
                            workspaceAgents.get(workspace.id)?.observedLocally,
                          ),
                        );
                        if (action === "workspace") {
                          focusWorkspaceInVscode(workspace.id);
                        } else {
                          openWorkspace(workspace.id);
                        }
                      }}
                      onOpenWorkspace={
                        workspace.lifecycleState === "materialized"
                          ? () => focusWorkspaceInVscode(workspace.id)
                          : undefined
                      }
                      issueAction={
                        workspace.intent.type === "jira"
                          ? {
                              label: `Open Jira issue ${workspace.intent.issueKey}`,
                              onPress: () => openWorkspaceJira(workspace),
                            }
                          : undefined
                      }
                      moveActions={[
                        ...(workspace.workflowPlacementMode === "pinned"
                          ? [
                              {
                                label: "Follow agent activity",
                                onPress: () =>
                                  void followWorkspaceAgentActivity(
                                    workspace.id,
                                  ),
                              },
                            ]
                          : []),
                        ...WORKSPACE_LANE_ORDER.filter(
                          (targetLane) => targetLane !== lane,
                        ).map((targetLane) => ({
                          label: `Move to ${laneDetails[targetLane].label}`,
                          onPress: () =>
                            void moveWorkspaceToLane(workspace.id, targetLane),
                        })),
                      ]}
                      buttonRef={(element) => {
                        if (element) {
                          workspaceCardRefs.current.set(workspace.id, element);
                        } else {
                          workspaceCardRefs.current.delete(workspace.id);
                        }
                      }}
                    />
                  ))}
                  {!items.length &&
                    !creationTasks.length &&
                    !(
                      lane === "planned" &&
                      visibleAssignedGitlabReviews.length
                    ) &&
                    (lane === visibleLanes[0] &&
                    visibleWorkspaces.length === 0 &&
                    visibleAssignedGitlabReviews.length === 0 &&
                    visibleDeferredWorkspaceCreations.length === 0 ? (
                      <div
                        className={`${styles.emptyLane} ${styles.boardEmptyLane}`}
                      >
                        <Glyph
                          name={workspaces.length ? "search" : "plus"}
                          size={18}
                        />
                        <span>
                          <h2>
                            {workspaces.length
                              ? "No matching workspaces found"
                              : "No local workspaces found"}
                          </h2>
                          <small>
                            {workspaces.length
                              ? "Clear search term or filter to show local workspaces."
                              : "Create the first local plan to isolate changes, review diffs, and manage worktrees."}
                          </small>
                          {workspaces.length > 0 && (
                            <Button
                              className={styles.secondaryButton}
                              onPress={() => {
                                setSearch("");
                                setFilter("all");
                              }}
                            >
                              Clear filters
                            </Button>
                          )}
                        </span>
                      </div>
                    ) : (
                      <div className={styles.emptyLane}>
                        <Glyph name="folder" size={14} />
                        <span>
                          <b>{detail.emptyTitle}</b>
                          <small>{detail.emptyMessage}</small>
                        </span>
                      </div>
                    ))}
                </div>
              </WorkspaceLaneDropTarget>
            );
          })}
          </section>
          {draggedWorkspaceId && (
            <div
              className={styles.workspaceActionShelf}
              aria-label="Workspace drop actions"
            >
              <WorkspaceActionDropTarget action="archive">
                <Glyph name="folder" size={16} /> Move to Parked
              </WorkspaceActionDropTarget>
              <WorkspaceActionDropTarget action="delete">
                <Glyph name="trash" size={16} /> Review and delete
              </WorkspaceActionDropTarget>
            </div>
          )}
          <DragOverlay modifiers={[snapCenterToCursor]} dropAnimation={null}>
            {draggedWorkspaceId ? (
              <div className={styles.workspaceDragOverlay}>
                {
                  workspaces.find(
                    (workspace) => workspace.id === draggedWorkspaceId,
                  )?.title
                }
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </main>
  );

  const selectedGitlabReview = selectedWorkspace
    ? gitlabReviewTargetForWorkspace(
        selectedWorkspace,
        myReviews.gitlabInbox?.reviews ?? [],
        workspaceGitlabInboxes.get(selectedWorkspace.id)?.mergeRequests,
      )
    : undefined;
  const gitlabConversations = useWorkspaceGitlabDiscussions({
    client,
    workspaceId: selectedWorkspace?.id,
    materialization: workspaceMaterialization,
    review: selectedGitlabReview,
    enabled: view === "workbench" && Boolean(workspaceMaterialization),
  });
  const savedCodeReview = useSavedCodeReview(
    client,
    selectedWorkspace?.id ?? "",
    view === "workbench" && Boolean(selectedGitlabReview),
    activeTab,
  );
  const reviewThreads = unreadHumanThreads(gitlabConversations);
  const [openAiReviewRequest, setOpenAiReviewRequest] = useState(0);
  const openReviewCode = (showAiReview: boolean) => {
    if (!selectedWorkspace || !workspaceMaterialization) return;
    if (showAiReview) setOpenAiReviewRequest((value) => value + 1);
    reviewSession(client, selectedWorkspace.id).mode = "code";
    openWorkbenchTab("changes");
  };
  const openReviewThread = (thread?: ReviewThreadSummary) => {
    if (!selectedWorkspace || !workspaceMaterialization) return;
    const session = reviewSession(client, selectedWorkspace.id);
    session.mode = "conversations";
    if (thread) {
      session.targets[thread.worktreeRepositoryId] = thread.targetKey;
      session.discussions[JSON.stringify([thread.targetKey, thread.scopeId])] = thread.id;
      if (thread.filePath) session.files[`${thread.worktreeRepositoryId}:${thread.targetKey}`] = thread.filePath;
      setReviewRepositoryId(thread.worktreeRepositoryId);
    }
    openWorkbenchTab("changes");
  };
  useEffect(() => {
    if (!selectedGitlabReview || activeTab !== "verification") return;
    const nextTab = workspaceMaterialization ? "changes" : "overview";
    setActiveTab(nextTab);
    pushNavigationPath(
      `/sessions/${encodeURIComponent(selectedWorkspace!.id)}${nextTab === "changes" ? "/changes" : ""}`,
    );
  }, [activeTab, selectedGitlabReview, selectedWorkspace, workspaceMaterialization]);
  const selectedWorkspaceHasKnownMaterialization =
    Boolean(workspaceMaterialization) ||
    (selectedWorkspace?.lifecycleState === "materialized" &&
      workspaceActionState === "checking");
  const selectedReviewStatusLabel = selectedGitlabReview?.status === "merged"
    ? "Merged"
    : selectedGitlabReview?.status === "closed"
      ? "Closed"
      : selectedGitlabReview?.reviewState === "changesAfterApproval"
        ? "New changes"
        : selectedGitlabReview?.reviewState === "approved"
          ? "Approved"
          : selectedGitlabReview?.draft
            ? "Draft"
            : selectedGitlabReview?.status === "open"
              ? "Review requested"
              : undefined;
  const selectedWorkspaceLifecycleLabel =
    selectedReviewStatusLabel ?? (selectedWorkspaceHasKnownMaterialization
      ? "Ready"
      : selectedWorkspace?.lifecycleState === "needsAttention"
        ? "Needs attention"
        : selectedWorkspace?.lifecycleState === "unknown"
          ? "Not checked"
          : "Needs setup");
  const workbenchRecoveryIsError =
    registryState === "error" || deepLinkState === "error";
  const workbenchRecoveryIsLoading =
    registryState === "loading" ||
    (registryState === "ready" && deepLinkState === "loading");
  const workbenchRecoveryTitle =
    registryState === "loading"
      ? "Opening the local registry"
      : registryState === "error"
        ? "Couldn’t open the workspace registry"
        : deepLinkState === "loading"
          ? "Opening linked workspace"
          : deepLinkState === "error"
            ? "Couldn’t open linked workspace"
            : "No workspace selected";
  const workbenchRecoveryDetail =
    registryState === "loading"
      ? "Reading your saved workspace plans…"
      : registryState === "error"
        ? registryError
        : deepLinkState === "loading"
          ? "The registry is ready. Reading the requested workspace plan…"
          : deepLinkState === "error"
            ? deepLinkError
            : "The local registry is connected, but there is no workspace to open yet.";
  const selectedPreferredAgent = selectedWorkspace
    ? preferredAgentProvider(selectedWorkspace.provider)
    : null;
  const selectedPreferredProviderName = selectedPreferredAgent
    ? providerFromView[selectedPreferredAgent]
    : "VS Code";
  const selectedPreferredTerminal = preferredTerminalProvider(
    setupSnapshot?.integrations,
  );
  const selectedPrimaryOpenLabel = selectedPreferredAgent
    ? `Open ${selectedPreferredProviderName} in ${terminalNames[selectedPreferredTerminal]}`
    : "Open in VS Code";
  const workspaceDriftDetected =
    workspaceActionErrorCode === "workspace_git_state_changed";
  const workbenchPrimaryActionLabel = workspaceMaterialization
    ? selectedPrimaryOpenLabel
    : workspaceDriftDetected
      ? "Register changes & re-index"
    : workspaceActionState === "ready"
      ? "Create workspace"
      : workspaceActionState === "checking"
        ? "Reviewing setup…"
        : workspaceActionState === "materializing"
          ? "Creating workspace…"
          : workspaceActionState === "blocked"
            ? "Review setup again"
            : "Review & create workspace";
  const workbenchPrimaryActionBusy =
    workspaceActionState === "checking" ||
    workspaceActionState === "materializing" ||
    workspaceActionState === "opening";
  const runWorkbenchPrimaryAction = () => {
    if (workspaceActionState === "ready") {
      void materializeSelectedWorkspace();
      return;
    }
    if (workspaceDriftDetected) {
      void reindexSelectedWorkspaceGraph();
      return;
    }
    void reviewWorkspaceSetup();
  };
  const workbench =
    selectedWorkspace && selectedWorkspaceIsReady ? (
      <main
        className={styles.workbench}
        data-ui="workspace.page"
        data-ui-label="Workspace page"
      >
        <Tabs.Root
          className={styles.workbenchTabs}
          data-ui="workspace.tabs"
          data-ui-label="Workspace view"
          value={activeTab}
          onValueChange={(value) => openWorkbenchTab(value as WorkbenchTab)}
        >
          <div
            className={styles.workbenchHeader}
            data-ui="workspace.header"
            data-ui-label="Workspace header"
          >
            <div
              className={styles.workbenchIdentity}
              data-ui="workspace.identity"
              data-ui-label="Workspace identity"
            >
              <span>
                <h1
                  className={styles.workbenchTitleLine}
                  ref={workbenchHeadingRef}
                  tabIndex={-1}
                >
                  {workspaceNameEditing ? (
                    <input
                      aria-label="Workspace name"
                      autoFocus
                      className={styles.workspaceTitleInput}
                      disabled={workspaceNameSaving}
                      maxLength={240}
                      onBlur={() => {
                        if (cancelWorkspaceRenameRef.current) {
                          cancelWorkspaceRenameRef.current = false;
                          return;
                        }
                        void saveWorkspaceName();
                      }}
                      onChange={(event) => {
                        setWorkspaceNameDraft(event.target.value);
                        setWorkspaceNameError("");
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void saveWorkspaceName();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelWorkspaceRename();
                        }
                      }}
                      value={workspaceNameDraft}
                    />
                  ) : (
                    <InfoTooltip content="Double-click to rename">
                      <Button
                        aria-label={selectedWorkspace.title}
                        className={styles.workspaceTitleButton}
                        onDoubleClick={startWorkspaceRename}
                        onKeyDown={(event) => {
                          if (event.key === "F2") startWorkspaceRename();
                        }}
                      >
                        {selectedWorkspace.title}
                      </Button>
                    </InfoTooltip>
                  )}
                </h1>
                <span className={styles.workbenchMeta}>
                  <span
                    className={styles.workspaceState}
                    data-suspended={false}
                  >
                    <StateDot
                      state={
                        selectedWorkspaceHasKnownMaterialization
                          ? "active"
                          : "attention"
                      }
                    />
                    {selectedWorkspaceLifecycleLabel}
                  </span>
                  <InfoTooltip content={selectedWorkspace.path}>
                    <code tabIndex={0}>{selectedWorkspace.path}</code>
                  </InfoTooltip>
                  <InfoTooltip content="Copy workspace path">
                    <Button
                      aria-label="Copy workspace path"
                      className={styles.pathCopyButton}
                      onPress={() => void copySelectedWorkspacePath()}
                    >
                      <Glyph name="copy" size={13} />
                    </Button>
                  </InfoTooltip>
                </span>
                {workspaceNameError && (
                  <span className={styles.workspaceRenameError} role="alert">
                    {workspaceNameError}
                  </span>
                )}
              </span>
              {activeTab === "changes" && workspaceMaterialization && (
                <div className={styles.identitySlot} ref={setIdentitySlot} />
              )}
            </div>
            <div
              className={styles.workspaceInlineViews}
              data-ui="workspace.tab-bar"
              data-ui-label="Workspace tabs"
            >
              <Tabs.List aria-label="Workspace views">
                <Tabs.Trigger value="overview">
                  {selectedGitlabReview ? "Overview" : "Workspace"}
                </Tabs.Trigger>
                <Tabs.Trigger value="planning">
                  {selectedGitlabReview ? "Agent review" : "Plans"}
                </Tabs.Trigger>
                {workspaceMaterialization && (
                  <Tabs.Trigger value="changes">
                    {selectedGitlabReview ? "Code review" : "Changes"}
                    {gitlabConversations.unreadCount > 0 && (
                      <span
                        className={styles.conversationBadge}
                        aria-label={`${gitlabConversations.unreadCount} unread merge request ${gitlabConversations.unreadCount === 1 ? "comment" : "comments"}`}
                        aria-live="polite"
                        title="Unread MR comments and replies"
                      >
                        {gitlabConversations.unreadCount > 99 ? "99+" : gitlabConversations.unreadCount}
                      </span>
                    )}
                  </Tabs.Trigger>
                )}
                {!selectedGitlabReview && (
                  <Tabs.Trigger value="verification">Verify</Tabs.Trigger>
                )}
              </Tabs.List>
            </div>
            <div
              className={styles.headerActions}
              data-ui="workspace.header-actions"
              data-ui-label="Workspace actions"
            >
              {(workspaceEvidenceRefreshing ||
                workspaceCommandState === "refreshing" ||
                workspaceCommandState === "reindexing" ||
                workspaceCommandState === "syncing" ||
                workspaceCommandState === "aligning") && (
                <span
                  aria-label="Refreshing workspace status"
                  className={styles.workspaceRefreshIndicator}
                  role="status"
                >
                  <Glyph name="refresh" size={12} />
                  {workspaceCommandState === "aligning"
                    ? "Aligning repository"
                    : workspaceCommandState === "syncing"
                      ? "Syncing repository"
                      : workspaceCommandState === "reindexing"
                        ? "Re-indexing graph"
                        : "Refreshing"}
                </span>
              )}
              {!workspaceMaterialization && (
                <Button
                  aria-label={workbenchPrimaryActionLabel}
                  className={styles.primaryButton}
                  isDisabled={
                    workbenchPrimaryActionBusy ||
                    workspaceCommandState !== "idle"
                  }
                  onPress={runWorkbenchPrimaryAction}
                >
                  {workbenchPrimaryActionLabel}
                </Button>
              )}
              <WorkspaceActionsMenu
                busy={
                  workspaceCommandState !== "idle" ||
                  workspaceActionState === "materializing" ||
                  workspaceActionState === "opening"
                }
                materialized={Boolean(workspaceMaterialization)}
                onOpenPrimary={() => void openSelectedWorkspacePreferred()}
                onOpenWith={() => setOpenWorkspaceLauncherOpen(true)}
                onRefresh={() => void refreshSelectedWorkspace()}
                onCreateRevisedCopy={startRevisedWorkspace}
                onRemove={reviewSelectedWorkspaceRemoval}
              />
            </div>
          </div>
          <div
            ref={workbenchScrollRef}
            className={styles.tabViewport}
            onScroll={(event) => {
              if (event.target !== event.currentTarget) return;
              scrollCache.set(`${selectedId}\0${activeTab}`, {
                top: event.currentTarget.scrollTop,
                left: event.currentTarget.scrollLeft,
              });
            }}
            data-terminal={false}
            data-ui="workspace.tab-content"
            data-ui-label="Workspace content"
          >
            <Tabs.Content value="overview">
              <DraftOverviewPanel
                client={client}
                workspace={selectedWorkspace}
                actionState={workspaceActionState}
                commandBusy={workspaceCommandState !== "idle"}
                preflight={workspacePreflight}
                materialization={workspaceMaterialization}
                repositoryCatalog={repositoryCatalog}
                actionError={workspaceActionError}
                actionErrorCode={workspaceActionErrorCode}
                driftDetected={workspaceDriftDetected}
                onReview={() => void reviewWorkspaceSetup()}
                onFetchBranches={(repositoryId) =>
                  void reviewWorkspaceSetup(repositoryId)
                }
                onReviseBase={startBaseRevision}
                onCreateRevisedCopy={startRevisedWorkspace}
                onAddRepositories={() =>
                  workspaceMaterialization
                    ? setAddRepositoryOpen(true)
                    : startRevisedWorkspace()
                }
                onRemoveRepository={removeSelectedWorkspaceRepository}
                onReconcile={() => void reindexSelectedWorkspaceGraph()}
                onSyncRepository={syncSelectedWorkspaceRepository}
                onAlignRepository={alignSelectedWorkspaceRepository}
                onMaterialize={materializeSelectedWorkspace}
                onReviewChanges={openRepositoryReview}
                onOpenWorkspace={() => void openSelectedWorkspacePreferred()}
                onNotice={setNotice}
                onOpenIntegrations={() => setSetupOpen(true)}
                onRefreshWorkspace={() => void refreshSelectedWorkspace()}
                onReviewRemainingFiles={reviewSelectedWorkspaceRemoval}
                onRecoverSetup={() => void recoverSelectedWorkspaceSetup()}
                gitlabReview={selectedGitlabReview}
                onRetryReviewStatus={myReviews.refresh}
                reviewInboxFresh={myReviews.gitlabInbox?.state === "fresh"}
                reviewInboxLoading={!myReviews.gitlabInbox && myReviews.state === "loading"}
                reviewAttention={
                  selectedGitlabReview && workspaceMaterialization ? (
                    <ReviewAttentionStrip
                      onOpenAgentReview={() => openWorkbenchTab("planning")}
                      onOpenCode={() => openReviewCode(false)}
                      onOpenConversations={() => openReviewThread(reviewThreads[0])}
                      review={savedCodeReview}
                      threads={reviewThreads}
                      finished={selectedGitlabReview.status === "merged" || selectedGitlabReview.status === "closed"}
                      threadsLoading={gitlabConversations.entries.length === 0 || gitlabConversations.entries.some((entry) => entry.state === "loading" && !entry.snapshot)}
                    />
                  ) : undefined
                }
              />
            </Tabs.Content>
            <Tabs.Content value="planning">
              <Suspense
                fallback={
                  <div className={styles.diffLoading} role="status">
                    <span />
                    <span />
                    <span />
                  </div>
                }
              >
                {selectedGitlabReview && workspaceMaterialization ? (
                  <ReviewHomePanel
                    finished={selectedGitlabReview.status === "merged" || selectedGitlabReview.status === "closed"}
                    onOpenFindings={() => openReviewCode(true)}
                    onOpenThread={openReviewThread}
                    onRunReview={() => openReviewCode(true)}
                    planning={
                      <PlanningDocumentsPanel
                        client={client}
                        onCreatePlanningHome={createPlanningHome}
                        onNotice={setNotice}
                        workspaceId={selectedWorkspace.id}
                        workspaceKey={selectedWorkspace.key}
                        workspaceTitle={selectedWorkspace.title}
                      />
                    }
                    review={savedCodeReview}
                    threads={reviewThreads}
                  />
                ) : (
                  <PlanningDocumentsPanel
                    client={client}
                    onCreatePlanningHome={createPlanningHome}
                    onNotice={setNotice}
                    workspaceId={selectedWorkspace.id}
                    workspaceKey={selectedWorkspace.key}
                    workspaceTitle={selectedWorkspace.title}
                  />
                )}
              </Suspense>
            </Tabs.Content>
            {workspaceMaterialization && (
              <Tabs.Content value="changes">
                <Suspense
                  fallback={
                    <div className={styles.diffLoading} role="status">
                      <span />
                      <span />
                      <span />
                    </div>
                  }
                >
                  <RepositoryReviewScreen
                    client={client}
                    onOpenIntegrations={() => setSetupOpen(true)}
                    onOpenWorkspaceStatus={() => openWorkbenchTab("overview")}
                    gitlabConversations={gitlabConversations}
                    feedbackSelectionReturn={feedbackReturnNavigationRef.current === agentNavigationGenerationRef.current ? feedbackSelectionReturn : undefined}
                    gitlabReview={selectedGitlabReview}
                    initialRepositoryId={reviewRepositoryId}
                    materialization={workspaceMaterialization}
                    onOpenVerification={
                      selectedGitlabReview
                        ? undefined
                        : () => openWorkbenchTab("verification")
                    }
                    onRepositoryChange={(repositoryId, navigation) => {
                      if (navigation === "user") invalidateDeepLinkLookup();
                      setReviewRepositoryId(repositoryId);
                      pushNavigationPath(
                        `/sessions/${encodeURIComponent(selectedWorkspace.id)}/changes?repository=${encodeURIComponent(repositoryId)}`,
                      );
                    }}
                    workspaceId={selectedWorkspace.id}
                    workspaceKey={selectedWorkspace.key}
                    onNotice={setNotice}
                    identitySlot={identitySlot}
                    openAiReviewRequest={openAiReviewRequest}
                  />
                </Suspense>
              </Tabs.Content>
            )}
            {!selectedGitlabReview && (
              <Tabs.Content value="verification">
                <VerificationPanel
                  client={client}
                  revealCheck={verificationSelection}
                  materialized={Boolean(workspaceMaterialization)}
                  onIndexGraph={indexSelectedWorkspaceGraph}
                  onNotice={setNotice}
                  onVerificationFailed={() => {
                    if (selectedWorkspace.workflowState !== "parked") {
                      void moveWorkspaceToLane(
                        selectedWorkspace.id,
                        "attention",
                      );
                    }
                  }}
                  onPrepareCliTask={(prompt) => {
                    const revision = ++cliDraftRevisionRef.current;
                    setCliDraft({
                      workspaceId: selectedWorkspace.id,
                      prompt,
                      revision,
                      briefState: "saving",
                    });
                    void saveWorkspaceAgentBrief(
                      selectedWorkspace.id,
                      selectedWorkspace.key,
                      prompt,
                      revision,
                    );
                  }}
                  workspaceId={selectedWorkspace.id}
                  workspaceKey={selectedWorkspace.key}
                />
                {cliDraft?.workspaceId === selectedWorkspace.id && (
                  <PreparedVerificationBrief
                    draft={cliDraft}
                    onOpen={() => setOpenWorkspaceLauncherOpen(true)}
                    onRetry={() =>
                      void saveWorkspaceAgentBrief(
                        selectedWorkspace.id,
                        selectedWorkspace.key,
                        cliDraft.prompt,
                        cliDraft.revision,
                      )
                    }
                    preferredProviderName={selectedPreferredProviderName}
                  />
                )}
              </Tabs.Content>
            )}
          </div>
        </Tabs.Root>
        {workspaceMaterialization && (
          <OpenWorkspaceLauncher
            integrations={setupSnapshot?.integrations}
            materialization={workspaceMaterialization}
            onOpenChange={setOpenWorkspaceLauncherOpen}
            onOpenCli={openSelectedWorkspaceCli}
            onOpenVscode={openSelectedWorkspaceInVscode}
            onRetryBrief={() => {
              if (
                !cliDraft ||
                cliDraft.workspaceId !== selectedWorkspace.id
              ) {
                return;
              }
              void saveWorkspaceAgentBrief(
                selectedWorkspace.id,
                selectedWorkspace.key,
                cliDraft.prompt,
                cliDraft.revision,
              );
            }}
            open={openWorkspaceLauncherOpen}
            preferredProvider={providerToRequest[selectedWorkspace.provider]}
            preparedBrief={
              cliDraft?.workspaceId === selectedWorkspace.id
                ? {
                    prompt: cliDraft.prompt,
                    state: cliDraft.briefState,
                    displayPath: cliDraft.briefDisplayPath,
                    error: cliDraft.briefError,
                  }
                : undefined
            }
            workspaceId={selectedWorkspace.id}
            workspaceKey={selectedWorkspace.key}
          />
        )}
      </main>
    ) : (
      <main className={styles.workbench}>
        <div
          className={styles.registryState}
          data-ui="workspace.recovery"
          data-ui-label="Workspace recovery"
        >
          <div
            className={styles.recoveryMessage}
            role={workbenchRecoveryIsError ? "alert" : "status"}
            aria-busy={workbenchRecoveryIsLoading || undefined}
          >
            <span data-error={workbenchRecoveryIsError || undefined}>
              <Glyph
                name={
                  workbenchRecoveryIsError
                    ? "warning"
                    : workbenchRecoveryIsLoading
                      ? "refresh"
                      : "folder"
                }
                size={20}
              />
            </span>
            <h2 ref={recoveryHeadingRef} tabIndex={-1}>
              {workbenchRecoveryTitle}
            </h2>
            <p>{workbenchRecoveryDetail}</p>
          </div>
          <div className={styles.recoveryActions}>
            {registryState === "error" && (
              <Button
                className={styles.secondaryButton}
                onPress={retryRegistry}
              >
                <Glyph name="refresh" /> Retry connection
              </Button>
            )}
            {registryState === "ready" && deepLinkState === "error" && (
              <Button
                className={styles.secondaryButton}
                onPress={retryDeepLinkedWorkspace}
              >
                <Glyph name="refresh" /> Retry workspace
              </Button>
            )}
            <Button
              className={styles.secondaryButton}
              onPress={returnToWorkspaceBoard}
            >
              Spaces
            </Button>
            {registryState === "ready" && (
              <Button
                className={styles.primaryButton}
                onPress={startNewWorkspace}
              >
                <Glyph name="plus" /> New workspace
              </Button>
            )}
          </div>
        </div>
      </main>
    );

  const timeReview = (
    <main
      className={styles.timeReview}
      data-ui="time.page"
      data-ui-label="Work activity page"
    >
      <AgentSessionsPanel
        client={client}
        onOpenIntegrations={() => setSetupOpen(true)}
        workspaceLabels={Object.fromEntries(
          workspaces.map((workspace) => [
            workspace.id,
            { key: workspace.key, title: workspace.title },
          ]),
        )}
      />
    </main>
  );

  const reviews = (
    <MyReviewsScreen
      client={client}
      error={myReviews.error}
      gitlabInbox={myReviews.gitlabInbox}
      inbox={myReviews.inbox}
      onOpenIntegrations={() => setSetupOpen(true)}
      onRefresh={myReviews.refresh}
      state={myReviews.state}
    />
  );

  const updates = <AppUpdateScreen controller={appUpdate} />;

  type CommandGroup =
    | "Workspaces"
    | "Navigate"
    | "Current workspace"
    | "Actions";
  type CommandItem = {
    id: string;
    group: CommandGroup;
    label: string;
    description: string;
    keywords: string;
    icon: Parameters<typeof Glyph>[0]["name"];
    disabled?: boolean;
    run: () => void;
  };
  const commandItems: CommandItem[] = [
    {
      id: "spaces",
      group: "Navigate",
      label: "Spaces",
      description: "Browse saved local workspaces",
      keywords: "home board workspaces",
      icon: "folder",
      run: () => {
        closeCommandPalette();
        returnToWorkspaceBoard();
      },
    },
    {
      id: "my-reviews",
      group: "Navigate",
      label: "My reviews",
      description: "Check direct GitHub review requests",
      keywords: "pull requests github assigned review requested",
      icon: "code",
      run: () => {
        closeCommandPalette();
        openMyReviews();
      },
    },
    {
      id: "daily-review",
      group: "Navigate",
      label: "My time",
      description: "Review time and agent activity",
      keywords: "time sessions agents activity",
      icon: "file",
      run: () => {
        closeCommandPalette();
        openTimeReview();
      },
    },
    ...(selectedWorkspace && selectedWorkspaceIsReady
      ? [
          {
            id: "workspace-overview",
            group: "Current workspace" as const,
            label: "Workspace",
            description: "Review setup and worktrees",
            keywords: `overview repositories ${selectedWorkspace.key} ${selectedWorkspace.title}`,
            icon: "branch" as const,
            run: () => {
              closeCommandPalette();
              openWorkbenchTab("overview");
            },
          },
          {
            id: "workspace-planning",
            group: "Current workspace" as const,
            label: "Plans & Kanban",
            description: "Read or edit trusted planning files",
            keywords: `plan kanban findings backlog ${selectedWorkspace.key} ${selectedWorkspace.title}`,
            icon: "file" as const,
            run: () => {
              closeCommandPalette();
              openWorkbenchTab("planning");
            },
          },
          {
            id: "workspace-verification",
            group: "Current workspace" as const,
            label: "Verification",
            description: "Run checks and review evidence",
            keywords: `tests checks evidence ${selectedWorkspace.key} ${selectedWorkspace.title}`,
            icon: "check" as const,
            run: () => {
              closeCommandPalette();
              openWorkbenchTab("verification");
            },
          },
          ...(workspaceMaterialization
            ? [
                {
                  id: "workspace-changes",
                  group: "Current workspace" as const,
                  label: "Changes",
                  description: "Review repository changes",
                  keywords: `diff review files ${selectedWorkspace.key} ${selectedWorkspace.title}`,
                  icon: "code" as const,
                  run: () => {
                    closeCommandPalette();
                    openWorkbenchTab("changes");
                  },
                },
                {
                  id: "open-workspace",
                  group: "Current workspace" as const,
                  label: "Open workspace",
                  description: "Choose an editor, agent, or terminal",
                  keywords: `vscode codex terminal ${selectedWorkspace.key}`,
                  icon: "terminal" as const,
                  run: () => {
                    closeCommandPalette();
                    setOpenWorkspaceLauncherOpen(true);
                  },
                },
              ]
            : []),
        ]
      : []),
    {
      id: "new-workspace",
      group: "Actions",
      label: "New workspace",
      description: "Create or import a workspace plan",
      keywords: "add create import jira repository",
      icon: "plus",
      disabled: registryState !== "ready",
      run: () => {
        closeCommandPalette();
        startNewWorkspace();
      },
    },
    {
      id: "environment",
      group: "Actions",
      label: "Environment & integrations",
      description: "Inspect tools, repositories, and connections",
      keywords: "settings preferences tools jira openproject",
      icon: "settings",
      run: () => {
        closeCommandPalette();
        setSetupOpen(true);
      },
    },
  ];
  const normalizedCommandQuery = commandQuery.trim().toLocaleLowerCase();
  const matchingWorkspaceItems: CommandItem[] = normalizedCommandQuery
    ? workspaces
        .map((workspace) => ({
          workspace,
          score: workspaceCommandMatchScore(
            workspace,
            normalizedCommandQuery,
          ),
        }))
        .filter(
          (
            match,
          ): match is { workspace: Workspace; score: number } =>
            match.score !== null,
        )
        .sort(
          (left, right) =>
            left.score - right.score ||
            Number(
              Boolean(
                workspaceAgents.get(right.workspace.id)?.observedLocally,
              ),
            ) -
              Number(
                Boolean(
                  workspaceAgents.get(left.workspace.id)?.observedLocally,
                ),
              ) ||
            compareWorkspaceRecency(left.workspace, right.workspace),
        )
        .map(({ workspace }) => ({
          id: `focus-workspace-${workspace.id}`,
          group: "Workspaces" as const,
          label: workspace.title,
          description: `Open in VS Code · ${workspaceCommandDescription(workspace)}`,
          keywords: workspaceCommandSearchFields(workspace).join(" "),
          icon: "folder" as const,
          run: () => {
            closeCommandPalette();
            focusWorkspaceInVscode(workspace.id);
          },
        }))
    : [];
  const matchingCommandItems = [
    ...matchingWorkspaceItems,
    ...commandItems.filter((item) =>
      normalizedCommandQuery
        ? `${item.label} ${item.description} ${item.keywords}`
            .toLocaleLowerCase()
            .includes(normalizedCommandQuery)
        : true,
    ),
  ];
  const activeCommandIndex = Math.min(
    commandActiveIndex,
    Math.max(0, matchingCommandItems.length - 1),
  );
  const commandGroups: CommandGroup[] = [
    "Workspaces",
    "Navigate",
    "Current workspace",
    "Actions",
  ];

  return (
    <Tooltip.Provider delayDuration={350}>
      <div
        className={styles.app}
        data-ui="wts.shell"
        data-ui-label="WTS window"
      >
        <TimeReviewScheduler client={client} />
        <header
          className={styles.chrome}
          data-ui="wts.top-bar"
          data-ui-label="Top bar"
        >
          <div
            className={styles.brand}
            data-ui="wts.navigation"
            data-ui-label="WTS navigation"
          >
            <button
              aria-current={view === "reviews" ? "page" : undefined}
              className={styles.chromeNavButton}
              onClick={openMyReviews}
              type="button"
            >
              My reviews
              {assignedReviewCount > 0 && (
                <span
                  aria-label={`${assignedReviewCount} assigned reviews`}
                  className={styles.reviewBadge}
                >
                  {assignedReviewCount > 99
                    ? "99+"
                    : assignedReviewCount}
                </span>
              )}
            </button>
            {view === "workbench" && (
              <>
                <span className={styles.chromeDivider} />
                <span>
                  Workspace · {selectedWorkspace && selectedWorkspaceIsReady
                    ? selectedWorkspace.title
                    : "Loading"}
                </span>
              </>
            )}
          </div>
          <Button
            aria-current={view === "board" ? "page" : undefined}
            aria-label="Open Spaces"
            className={styles.brandHome}
            data-ui="wts.home"
            data-ui-label="WTS home"
            onPress={returnToWorkspaceBoard}
          >
            <span className={styles.brandMark}>
              <Glyph name="branch" size={15} />
            </span>
            <b>WTS</b>
          </Button>
          <div
            className={styles.chromeTools}
            data-ui="wts.controls"
            data-ui-label="WTS controls"
          >
            <Button
              aria-label="Open command palette"
              className={styles.quickHint}
              onPress={openCommandPalette}
            >
              <Glyph name="command" size={13} /> K
            </Button>
            <Tooltip.Provider
              delayDuration={0}
              skipDelayDuration={0}
              disableHoverableContent
            >
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Button
                    className={styles.chromeIcon}
                    aria-label={`Switch to ${
                      resolvedTheme === "dark" ? "light" : "dark"
                    } mode`}
                    onPress={toggleTheme}
                  >
                    <Glyph
                      name={resolvedTheme === "dark" ? "sun" : "moon"}
                      size={15}
                    />
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className={styles.tooltip}
                    side="bottom"
                    sideOffset={6}
                  >
                    Use {resolvedTheme === "dark" ? "light" : "dark"} mode
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Button
                    className={styles.chromeIcon}
                    aria-label="Open How to use WTS"
                    onPress={() => setGuideOpen(true)}
                  >
                    <Glyph name="help" size={15} />
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className={styles.tooltip}
                    side="bottom"
                    sideOffset={6}
                  >
                    How to use WTS
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Button
                    className={styles.chromeIcon}
                    aria-label="Open Environment and integrations"
                    onPress={() => setSetupOpen(true)}
                  >
                    <Glyph name="settings" size={15} />
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Portal>
                  <Tooltip.Content
                    className={styles.tooltip}
                    side="bottom"
                    sideOffset={6}
                  >
                    Environment &amp; integrations (⌘,)
                  </Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
            </Tooltip.Provider>
          </div>
        </header>
        {view === "board"
          ? board
          : view === "time"
            ? timeReview
            : view === "reviews"
              ? reviews
              : view === "updates"
                ? updates
                : workbench}
        <ToastStack toasts={toasts} onDismiss={dismissToast} />
        <CommandPalette
          open={commandOpen}
          onOpenChange={(open) => {
            if (open) {
              openCommandPalette();
            } else {
              closeCommandPalette();
            }
          }}
          commandQuery={commandQuery}
          onCommandQueryChange={setCommandQuery}
          activeCommandIndex={activeCommandIndex}
          onActiveCommandIndexChange={setCommandActiveIndex}
          inputRef={commandInputRef}
          returnFocusRef={commandReturnFocusRef}
          matchingCommandItems={matchingCommandItems}
          commandGroups={commandGroups}
        />
        <NewWorkspaceDialog
          open={createOpen && registryState === "ready"}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) {
              setResumedWorkspaceCreationId("");
              setCreatePlanningEnabled(undefined);
            }
          }}
          onComplete={completeCreation}
          client={client}
          workspaces={workspaces}
          workspaceRootDisplayPath={workspaceRootDisplayPath}
          repositoryCatalog={repositoryCatalog ?? undefined}
          initialTemplateWorkspaceId={createTemplateWorkspaceId || undefined}
          initialRepositoryBaseOverrides={
            Object.keys(createRepositoryBaseOverrides).length > 0
              ? createRepositoryBaseOverrides
              : undefined
          }
          initialReviewWorkspace={reviewWorkspaceSeed ?? undefined}
          initialPlanningEnabled={createPlanningEnabled}
          initialDeferredClone={deferredWorkspaceCreations.find(
            (task) => task.id === resumedWorkspaceCreationId,
          )}
          onStartRepositoryClone={startRepositoryClone}
          onDeferRepositoryClone={deferRepositoryClone}
        />
        {selectedWorkspace && (
          <AddWorkspaceRepositoryDialog
            client={client}
            onComplete={(result) => void completeRepositoryAddition(result)}
            onOpenChange={setAddRepositoryOpen}
            open={addRepositoryOpen && Boolean(workspaceMaterialization)}
            repositoryCatalog={repositoryCatalog}
            workspace={selectedWorkspace}
          />
        )}
        <HowToGuide
          open={guideOpen}
          onOpenChange={setGuideOpen}
          onCreateWorkspace={startNewWorkspace}
        />
        <WorkspaceRemovalDialog
          open={removalOpen}
          onOpenChange={(open) => {
            setRemovalOpen(open);
            if (!open) {
              removalGenerationRef.current += 1;
              setRemovalPreflight(null);
              setRemovalError("");
            }
          }}
          workspace={selectedWorkspace}
          preflight={removalPreflight}
          state={removalState}
          error={removalError}
          onRetry={() => void loadRemovalPreflight()}
          onRegisterChanges={() => void registerChangesForRemoval()}
          onReviewChanges={removalPreflight?.kind === "materializedWorkspace" ? () => {
            closeRemovalForRecovery();
            openWorkbenchTab("changes");
          } : undefined}
          onOpenPlans={removalPreflight?.kind === "materializedWorkspace" ? () => {
            closeRemovalForRecovery();
            openWorkbenchTab("planning");
          } : undefined}
          onOpenWorkspace={() => {
            closeRemovalForRecovery();
            openWorkbenchTab("overview");
          }}
          onOpenVerification={removalPreflight?.kind === "materializedWorkspace" ? () => {
            closeRemovalForRecovery();
            openWorkbenchTab("verification");
          } : undefined}
          onOpenIntegrations={() => {
            closeRemovalForRecovery();
            setSetupOpen(true);
          }}
          onConfirm={(deleteProtectedPaths) =>
            void removeSelectedWorkspace(deleteProtectedPaths)
          }
        />
        <SetupSheet
          client={client}
          gitlabWorkspaceId={selectedWorkspace?.id}
          open={setupOpen}
          onOpenChange={setSetupOpen}
          snapshot={setupSnapshot ?? undefined}
          repositories={repositoryCatalog ?? undefined}
          loading={setupLoading}
          error={setupError || undefined}
          onRefresh={() => setSetupRevision((revision) => revision + 1)}
          onVerifyJira={() => client.verifyJiraMcp()}
          onVerifyOpenProject={() => client.verifyOpenProject()}
          appUpdate={appUpdate}
        />
      </div>
    </Tooltip.Provider>
  );
}
