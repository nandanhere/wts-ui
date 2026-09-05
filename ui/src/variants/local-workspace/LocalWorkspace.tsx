import {
  lazy,
  Suspense,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
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
import {
  Button,
  Checkbox,
  Input,
  Label,
  Radio,
  RadioGroup,
  SearchField,
} from "react-aria-components";
import {
  CODE_WORKSPACE_FILE_MAX_BYTES,
  defaultWorkspaceClient,
  type AgentProvider,
  type AgentRunResult,
  type AgentSessionList,
  type CodeWorkspaceDiagnosticMatchReason,
  type CodeWorkspaceDiagnosticResolutionBasis,
  type CodeWorkspaceFileImportResult,
  type CodeWorkspaceFolderDiagnostic,
  type CloneRepositoryResult,
  type CreateWorkspaceRequest,
  type GraphIndexResult,
  type GitlabMergeRequest,
  type GitlabMergeRequestInbox,
  type GitlabReview,
  type GitlabReviewTarget,
  type JiraIssueImport,
  type MaterializedWorktree,
  type OpenProjectWorkPackageImport,
  type RemoveWorkspaceResult,
  type WorkspaceRemovalPreflight,
  type RepositoryCatalog,
  type RepositorySummary,
  type RuntimeAnalysisConfidence,
  type RuntimeAnalysisRequest,
  type RuntimeAnalysisResult,
  type RuntimePlanSelection,
  type RuntimePortPolicy,
  type SetupSnapshot,
  type TerminalProvider,
  type WorkspaceAgentEvidence,
  type WorkspaceGraphManifest,
  type WorkspaceMaterialization,
  type WorkspacePlanningSelection,
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
  type WorkspaceIntent,
  type WorkspaceProvider,
  type WorkspaceWorkflowState,
  type WorkspaceView,
} from "../../lib/wtsClient";
import { useTheme } from "../../theme";
import { useVisiblePolling } from "../../lib/useVisiblePolling";
import { SelectMenu } from "../../components/SelectMenu";
import { SetupSheet } from "./SetupSheet";
import { VerificationPanel } from "./VerificationPanel";
import { AgentSessionsPanel } from "./AgentSessionsPanel";
import { TimeReviewScheduler } from "./TimeReviewScheduler";
import { AgentStatePrototype } from "./AgentStatePrototype";
import { WorkspaceWorkItemsPanel } from "./WorkspaceWorkItemsPanel";
import { OpenWorkspaceLauncher } from "./OpenWorkspaceLauncher";
import { Glyph } from "./Glyph";
import { GuideDialog, HowToGuide } from "./GuideDialog";
import { ToastStack, ToastItem, type NoticeToast } from "./ToastStack";
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

export type Lane = "planned" | "active" | "attention" | "suspended";
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
type Provider = "Codex" | "OpenCode" | "Hermes" | "VS Code";
type WorkbenchTab = "overview" | "planning" | "changes" | "verification";
type CreateStep =
  "source" | "evidence" | "services" | "manifest" | "saving" | "saved";
type SourceMode = "issue" | "workspace" | "codeWorkspace" | "set";
type IssueProvider = "jira" | "openProject";
type CodeWorkspaceRepositoryAddMode = "existing" | "clone";
type Filter = "all" | Lane;
type RegistryState = "loading" | "ready" | "error";
type DeepLinkState = "idle" | "loading" | "ready" | "error";
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
  | "removing";

export interface Workspace {
  id: string;
  intent: WorkspaceIntent;
  key: string;
  kind: "Jira" | "OpenProject" | "Repositories";
  title: string;
  lane: Lane;
  workflowState: WorkspaceWorkflowState;
  workflowRevision: number;
  workflowUpdatedAtUnixMs: number;
  workflowPersisted: boolean;
  workflowPlacementMode?: "automatic" | "pinned";
  workflowPlacementRank?: number;
  lifecycleState: WorkspaceView["lifecycle"]["materializationState"];
  knownWorktreeCount: number;
  observedAtUnixMs: number | null;
  provider: Provider;
  repos: number;
  repositoryPlans: Array<{
    repositoryId?: string;
    label: string;
    baseRef: string;
    worktreeLeaf: string;
  }>;
  runtime?: RuntimePlanSelection;
  planning?: WorkspacePlanningSelection;
  observedWorkItems: NonNullable<WorkspaceView["observedWorkItems"]>;
  path: string;
  updated: string;
  updatedAtUnixMs: number;
  summary: string;
}

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

interface RepoEvidence {
  key: string;
  id: string;
  repositoryId?: string;
  reason: string;
  confidence: number;
  included: boolean;
  base: string;
}

interface RuntimePortDraft {
  portId: string;
  preferredPort: string;
  policy: RuntimePortPolicy;
}

interface RuntimeServiceDraft {
  included: boolean;
  ports: RuntimePortDraft[];
}

const workspaceMaterializationCaches = new WeakMap<
  WorkspaceClient,
  Map<string, WorkspaceMaterialization | null>
>();

function materializationCacheFor(
  client: WorkspaceClient,
): Map<string, WorkspaceMaterialization | null> {
  const existing = workspaceMaterializationCaches.get(client);
  if (existing) return existing;
  const created = new Map<string, WorkspaceMaterialization | null>();
  workspaceMaterializationCaches.set(client, created);
  return created;
}

function readTextFile(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("The selected file could not be read as text."));
      }
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("The selected file could not be read."));
    });
    reader.readAsText(file);
  });
}

const codeWorkspaceDiagnosticReasonLabels: Record<
  CodeWorkspaceDiagnosticMatchReason,
  string
> = {
  matchedExactPath: "Matched the exact absolute repository path",
  matchedRelativePathSuffix:
    "Matched the relative folder path to a discovered checkout",
  matchedPathBasename:
    "Matched the final folder name to a discovered checkout folder or repository label",
  matchedExplicitName:
    "Matched the VS Code folder name to a discovered repository label",
  noCatalogMatch:
    "No discovered checkout folder or repository label matched this folder",
  ambiguousExactPath:
    "Multiple discovered repositories share this absolute path",
  ambiguousRelativePathSuffix:
    "Multiple discovered checkouts matched the relative folder path",
  ambiguousPathBasename:
    "Multiple discovered checkouts or repository labels matched the final folder name",
  ambiguousExplicitName:
    "Multiple discovered repository labels matched the VS Code folder name",
  unsupportedFolder: "This folder entry cannot be matched safely",
};

const codeWorkspaceDiagnosticBasisLabels: Record<
  CodeWorkspaceDiagnosticResolutionBasis,
  string
> = {
  absolutePath: "Absolute path",
  relativePathSuffix: "Relative path suffix",
  pathBasename: "Final folder name",
  explicitName: "VS Code name",
};

export interface InfoTooltipProps {
  content?: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
}

export function InfoTooltip({
  content,
  children,
  side = "top",
  align = "center",
}: InfoTooltipProps) {
  if (!content) {
    return <>{children}</>;
  }

  return (
    <Tooltip.Provider
      delayDuration={0}
      skipDelayDuration={0}
      disableHoverableContent
    >
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className={styles.infoTooltipContent}
            side={side}
            align={align}
            sideOffset={4}
          >
            {content}
            <Tooltip.Arrow className={styles.infoTooltipArrow} />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

const interactiveDevLogging =
  import.meta.env.DEV && import.meta.env.MODE !== "test";

const unsupportedUriDiagnosticValue = "<unsupported-uri>";
const unsupportedDiagnosticValue = "<unsupported-value>";
const missingDiagnosticPathValue = "<missing-path>";
const uriSchemePattern = /^[a-z][a-z0-9+.-]*:/i;
const windowsAbsolutePathPattern = /^[a-z]:[\\/]/i;

function isUriShapedDiagnosticValue(value: unknown) {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  return (
    !windowsAbsolutePathPattern.test(candidate) &&
    uriSchemePattern.test(candidate)
  );
}

function sanitizedFolderDiagnosticName(name: unknown, rawPathIsUri: boolean) {
  if (rawPathIsUri || isUriShapedDiagnosticValue(name)) {
    return unsupportedUriDiagnosticValue;
  }
  return typeof name === "string" && name.trim()
    ? name
    : unsupportedDiagnosticValue;
}

function sanitizedFolderDiagnosticPath(rawPath: unknown) {
  if (typeof rawPath !== "string") return unsupportedDiagnosticValue;
  if (!rawPath.trim()) return missingDiagnosticPathValue;
  return isUriShapedDiagnosticValue(rawPath)
    ? unsupportedUriDiagnosticValue
    : rawPath;
}

function sanitizedMatchAttemptValue(
  rawPath: unknown,
  folderName: unknown,
  value: unknown,
) {
  return isUriShapedDiagnosticValue(rawPath) ||
    isUriShapedDiagnosticValue(folderName) ||
    isUriShapedDiagnosticValue(value)
    ? unsupportedUriDiagnosticValue
    : typeof value === "string"
      ? value
      : unsupportedDiagnosticValue;
}

function codeWorkspaceFolderStatusLabel(
  status: CodeWorkspaceFolderDiagnostic["status"],
) {
  switch (status) {
    case "matched":
      return "Matched";
    case "missing":
      return "No match";
    case "ambiguous":
      return "Ambiguous";
    case "unsupported":
      return "Unsupported";
  }
}

function codeWorkspaceDiagnosticsPayload(
  imported: CodeWorkspaceFileImportResult,
) {
  const folderDiagnostics = new Map<number, CodeWorkspaceFolderDiagnostic>(
    imported.diagnostics?.folders.map((folder) => [folder.folderIndex, folder]),
  );
  return {
    schemaVersion: 1,
    event: "codeWorkspaceImport",
    fileName: imported.fileName,
    importId: imported.importId,
    result: {
      folderCount: imported.folders.length,
      matchedRepositoryCount: imported.repositories.length,
      warningCodes: imported.warnings.map((warning) => warning.code),
    },
    catalog: imported.diagnostics
      ? {
          repositoryRootDisplayPath:
            imported.diagnostics.catalog.repositoryRootDisplayPath,
          repositoryCount: imported.diagnostics.catalog.repositoryCount,
          skippedEntries: imported.diagnostics.catalog.skippedEntries,
          repositories: imported.diagnostics.catalog.repositories.map(
            (repository) => ({
              label: repository.label,
              displayPath: repository.displayPath,
            }),
          ),
          repositoriesTruncated:
            imported.diagnostics.catalog.repositoriesTruncated,
        }
      : null,
    folders: imported.folders.map((folder, folderIndex) => {
      const diagnostic = folderDiagnostics.get(folderIndex);
      const rawPathIsUri = isUriShapedDiagnosticValue(folder.rawPath);
      const folderNameIsUri = isUriShapedDiagnosticValue(folder.name);
      return {
        folderIndex,
        name: sanitizedFolderDiagnosticName(folder.name, rawPathIsUri),
        path: sanitizedFolderDiagnosticPath(folder.rawPath),
        status: folder.status,
        repository:
          !rawPathIsUri &&
          !folderNameIsUri &&
          folder.repositoryLabel &&
          folder.repositoryDisplayPath
            ? {
                ...(folder.repositoryId === undefined
                  ? {}
                  : { repositoryId: folder.repositoryId }),
                label: folder.repositoryLabel,
                displayPath: folder.repositoryDisplayPath,
                baseRef: folder.baseRef,
              }
            : null,
        resolution: diagnostic
          ? {
              reason: diagnostic.reason,
              resolutionBasis: diagnostic.resolutionBasis,
              attempts: diagnostic.attempts.map((attempt) => ({
                basis: attempt.basis,
                value: sanitizedMatchAttemptValue(
                  folder.rawPath,
                  folder.name,
                  attempt.value,
                ),
                candidateCount: attempt.candidateCount,
              })),
              candidates:
                rawPathIsUri || folderNameIsUri
                  ? []
                  : diagnostic.candidates.map((candidate) => ({
                      label: candidate.label,
                      displayPath: candidate.displayPath,
                    })),
              candidatesTruncated: diagnostic.candidatesTruncated,
              duplicateRepository: diagnostic.duplicateRepository,
            }
          : null,
      };
    }),
  };
}

function logCodeWorkspaceImportCompletion(
  imported: CodeWorkspaceFileImportResult,
) {
  if (!imported.diagnostics && !interactiveDevLogging) return;
  console.debug(
    "[WTS] VS Code workspace import completed",
    codeWorkspaceDiagnosticsPayload(imported),
  );
}

function logCodeWorkspaceImportFailure(fileName: string, error: unknown) {
  if (!interactiveDevLogging) return;
  const clientError = error instanceof WorkspaceClientError ? error : undefined;
  console.debug("[WTS] VS Code workspace import failed", {
    schemaVersion: 1,
    event: "codeWorkspaceImportFailed",
    fileName,
    error: {
      name: error instanceof Error ? error.name : "UnknownError",
      message:
        error instanceof Error
          ? error.message
          : "The VS Code workspace file could not be imported.",
      code: clientError?.code,
      status: clientError?.status,
      retryable: clientError?.retryable,
    },
  });
}

function issueKeyFrom(value: string) {
  const match = value.toUpperCase().match(/[A-Z][A-Z0-9]+-\d+/);
  return (
    match?.[0] ??
    value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
  );
}

function openProjectReferenceFrom(value: string) {
  const reference = value.trim();
  const direct = reference.match(/^#?([1-9][0-9]{0,14})$/);
  const fromUrl = reference.match(
    /(?:^|\/)work_packages\/([1-9][0-9]{0,14})(?:[/?#]|$)/i,
  );
  const numericReference = direct?.[1] ?? fromUrl?.[1];
  if (numericReference) return numericReference;

  const semanticReference = reference.toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,127}$/.test(semanticReference) &&
    !/^0+$/.test(semanticReference)
    ? semanticReference
    : null;
}

function openProjectImportMatchesReference(
  imported: OpenProjectWorkPackageImport,
  reference: string,
) {
  return /^[1-9][0-9]{0,14}$/.test(reference)
    ? imported.workPackageId === Number(reference)
    : imported.displayId.trim().toUpperCase() === reference.toUpperCase();
}

function importedIssueContent(content: string, title: string) {
  let readable = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    const record =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const fields =
      record?.fields !== null && typeof record?.fields === "object"
        ? (record.fields as Record<string, unknown>)
        : null;
    const description = fields?.description ?? record?.description;
    if (typeof description === "string") {
      readable = description;
    } else if (description !== undefined) {
      const text: string[] = [];
      const pending: unknown[] = [description];
      while (pending.length > 0 && text.length < 200) {
        const value = pending.pop();
        if (value === null || value === undefined) continue;
        if (typeof value === "string") {
          text.push(value);
        } else if (Array.isArray(value)) {
          pending.push(...value.slice().reverse());
        } else if (typeof value === "object") {
          const object = value as Record<string, unknown>;
          if (typeof object.text === "string") text.push(object.text);
          if (Array.isArray(object.content)) {
            pending.push(...object.content.slice().reverse());
          }
        }
      }
      if (text.length > 0) readable = text.join(" ");
    }
  } catch {
    // OpenProject content and some Jira MCP implementations return plain text.
  }
  readable = readable.replace(/\s+/g, " ").trim();
  if (readable.toLowerCase().startsWith(title.trim().toLowerCase())) {
    readable = readable.slice(title.trim().length).trim();
  }
  if (!readable) return "No description was provided by the issue tracker.";
  return readable.length > 1_200
    ? `${readable.slice(0, 1_197).trimEnd()}…`
    : readable;
}

function workspaceIntentMatches(left: WorkspaceIntent, right: WorkspaceIntent) {
  if (left.type !== right.type) return false;
  if (left.type === "jira" && right.type === "jira") {
    return left.issueKey === right.issueKey;
  }
  if (left.type === "openProject" && right.type === "openProject") {
    return (
      left.workPackageId === right.workPackageId &&
      left.displayId === right.displayId
    );
  }
  return (
    left.type === "repositorySet" &&
    right.type === "repositorySet" &&
    left.label === right.label
  );
}

function repositoryNamesFrom(value: string) {
  const seen = new Set<string>();
  return value
    .split(/[\n,]+/)
    .map((name) => name.trim())
    .filter((name) => {
      if (!name) return false;
      const normalized = name.toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function repositoryLeafFromRemoteUrl(value: string) {
  const remote = value.trim();
  if (
    !remote ||
    remote.length > 2_048 ||
    /\s|[\u0000-\u001f\u007f\\%?#]/.test(remote) ||
    remote.startsWith("--")
  ) {
    return null;
  }

  let path = "";
  try {
    const parsed = new URL(remote);
    if (!["https:", "ssh:"].includes(parsed.protocol)) return null;
    if (
      !parsed.hostname ||
      parsed.password ||
      (parsed.protocol === "https:" && parsed.username)
    ) {
      return null;
    }
    path = parsed.pathname;
  } catch {
    const scpRemote = remote.match(
      /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:([A-Za-z0-9._/-]+)$/,
    );
    if (!scpRemote) return null;
    path = scpRemote[1];
  }

  const leaf = path
    .replace(/\/+$/, "")
    .split("/")
    .at(-1)
    ?.replace(/\.git$/i, "");
  return leaf && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(leaf) ? leaf : null;
}

export interface IssueRepositoryUpstream {
  label: string;
  remoteUrl: string;
}

function isIssueGitRemoteUrl(remoteUrl: string) {
  try {
    const parsed = new URL(remoteUrl);
    if (!['https:', 'ssh:'].includes(parsed.protocol)) return false;

    // An issue page is context, not a Git clone target.
    if (/\/browse\//i.test(parsed.pathname)) return false;
    return (
      /\.git$/i.test(parsed.pathname) ||
      /(?:^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/i.test(
        parsed.hostname,
      )
    );
  } catch {
    return /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[A-Za-z0-9._/+-]+(?:\.git)?$/i.test(
      remoteUrl,
    );
  }
}

export function repositoryUpstreamsFromIssueContent(
  content: string,
): IssueRepositoryUpstream[] {
  const candidates =
    content.match(
      /(?:https|ssh):\/\/[^\s<>"'`]+|(?:[A-Za-z0-9._-]+@)[A-Za-z0-9.-]+:[A-Za-z0-9._/+\-]+/g,
    ) ?? [];
  const upstreams = new Map<string, IssueRepositoryUpstream>();

  for (const candidate of candidates) {
    const remoteUrl = candidate.replace(/[),.;\]}]+$/, "");
    if (!isIssueGitRemoteUrl(remoteUrl)) continue;
    const label = repositoryLeafFromRemoteUrl(remoteUrl);
    if (!label) continue;
    upstreams.set(label.toLocaleLowerCase(), { label, remoteUrl });
  }

  return Array.from(upstreams.values());
}

function joinDisplayPath(root: string, leaf: string) {
  if (!root) return leaf;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${leaf}`;
}

function repositoryEvidenceKey(
  repositoryId: string | undefined,
  label: string,
) {
  return repositoryId ?? label.trim().toLowerCase();
}

function moveCompositeFocus(
  root: HTMLElement,
  event: Pick<ReactKeyboardEvent<HTMLElement>, "key" | "target" | "preventDefault" | "stopPropagation">,
  selector: string,
  columns: number,
  activate = false,
) {
  const key = event.key;
  if (
    !["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
      key,
    )
  ) {
    return;
  }

  const items = Array.from(
    root.querySelectorAll<HTMLElement>(selector),
  ).filter((item) => !item.matches(":disabled, [aria-disabled='true']"));
  const focusedItem = event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>(selector)
    : null;
  const currentIndex = focusedItem ? items.indexOf(focusedItem) : -1;
  if (currentIndex < 0 || items.length === 0) return;

  const rowStart = Math.floor(currentIndex / columns) * columns;
  const rowEnd = Math.min(rowStart + columns - 1, items.length - 1);
  let nextIndex = currentIndex;
  if (key === "Home") nextIndex = 0;
  else if (key === "End") nextIndex = items.length - 1;
  else if (key === "ArrowLeft") nextIndex = Math.max(rowStart, currentIndex - 1);
  else if (key === "ArrowRight") nextIndex = Math.min(rowEnd, currentIndex + 1);
  else if (key === "ArrowUp") nextIndex = Math.max(0, currentIndex - columns);
  else if (key === "ArrowDown") {
    nextIndex = Math.min(items.length - 1, currentIndex + columns);
  }

  if (nextIndex === currentIndex) return;
  event.preventDefault();
  const next = items[nextIndex]!;
  next.focus();
  if (activate) next.click();
}

function catalogRepositoryFor(
  repositoryId: string | undefined,
  label: string,
  repositoryCatalog: RepositoryCatalog | undefined,
): RepositorySummary | undefined {
  const repositories = repositoryCatalog?.repositories ?? [];
  if (repositoryId) {
    return repositories.find((repository) => repository.id === repositoryId);
  }

  const labelMatches = repositories.filter(
    (repository) =>
      repository.label.localeCompare(label, undefined, {
        sensitivity: "accent",
      }) === 0,
  );
  if (labelMatches.length === 1) return labelMatches[0];
  if (labelMatches.length > 1) return undefined;

  const checkoutMatches = repositories.filter(
    (repository) =>
      repository.checkoutLeaf.localeCompare(label, undefined, {
        sensitivity: "accent",
      }) === 0,
  );
  return checkoutMatches.length === 1 ? checkoutMatches[0] : undefined;
}

function remoteMatchesRepositoryLabel(
  label: string,
  repository: RepositorySummary,
) {
  const normalize = (value: string) =>
    value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  const target = normalize(label);
  if (!target) return false;

  return [repository.label, repository.checkoutLeaf, repository.originUrl]
    .filter((value): value is string => Boolean(value))
    .map(normalize)
    .some((value) => value.includes(target) || target.includes(value));
}

const runtimeConfidenceLabels: Record<RuntimeAnalysisConfidence, string> = {
  declared: "Declared",
  corroborated: "Corroborated",
  inferred: "Inferred",
  suggested: "Suggested",
};

function runtimeAnalysisPreparationFor(
  repositories: RepoEvidence[],
  repositoryCatalog: RepositoryCatalog | undefined,
): {
  request: RuntimeAnalysisRequest | null;
  fingerprint: string;
  unresolvedLabels: string[];
} {
  const prepared = repositories.map((repository) => {
    const catalogRepository = catalogRepositoryFor(
      repository.repositoryId,
      repository.id,
      repositoryCatalog,
    );
    return {
      repositoryId: repository.repositoryId ?? catalogRepository?.id,
      label: repository.id.trim(),
      baseRef: repository.base.trim(),
    };
  });
  const resolvedIdCounts = new Map<string, number>();
  for (const repository of prepared) {
    if (!repository.repositoryId) continue;
    resolvedIdCounts.set(
      repository.repositoryId,
      (resolvedIdCounts.get(repository.repositoryId) ?? 0) + 1,
    );
  }
  const unresolvedLabels = prepared
    .filter(
      (repository) =>
        !repository.repositoryId ||
        resolvedIdCounts.get(repository.repositoryId) !== 1,
    )
    .map((repository) => repository.label);
  const fingerprint = JSON.stringify(
    prepared
      .map((repository) => ({
        repositoryId: repository.repositoryId ?? "",
        label: repository.label,
        baseRef: repository.baseRef,
      }))
      .sort(
        (left, right) =>
          left.repositoryId.localeCompare(right.repositoryId) ||
          left.label.localeCompare(right.label) ||
          left.baseRef.localeCompare(right.baseRef),
      ),
  );

  return {
    request:
      unresolvedLabels.length === 0
        ? {
            repositories: prepared.map((repository) => ({
              repositoryId: repository.repositoryId!,
              label: repository.label,
              baseRef: repository.baseRef,
            })),
          }
        : null,
    fingerprint,
    unresolvedLabels,
  };
}

function runtimeDraftsFromAnalysis(
  analysis: RuntimeAnalysisResult,
): Map<string, RuntimeServiceDraft> {
  return new Map(
    analysis.services.map((service) => [
      service.candidateId,
      {
        included: service.includedByDefault,
        ports: service.ports.map((port) => ({
          portId: port.portId,
          preferredPort:
            port.preferredPort === undefined ? "" : String(port.preferredPort),
          policy: port.policy,
        })),
      },
    ]),
  );
}

function validRuntimePort(value: string) {
  if (!/^[0-9]+$/.test(value)) return null;
  const port = Number(value);
  return Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535
    ? port
    : null;
}

function runtimePortErrorId(candidateId: string, portId: string) {
  return `runtime-port-error-${candidateId}-${portId}`.replace(
    /[^a-zA-Z0-9_-]/g,
    "-",
  );
}

type RepositoryForgeTarget = {
  forge: "github" | "gitlab";
  host: string;
};

function repositoryForgeTarget(
  originUrl: string | undefined,
): RepositoryForgeTarget | null {
  if (!originUrl) return null;
  const value = originUrl.trim();
  if (!value || /[?#\u0000-\u001f\u007f]/.test(value)) return null;

  let host = "";
  let repositoryPath = "";
  const scheme = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    if (!["https", "ssh"].includes(scheme[1]!.toLowerCase())) {
      return null;
    }
    try {
      const parsed = new URL(value);
      if (parsed.username || parsed.password || parsed.port) return null;
      host = parsed.hostname.toLowerCase();
      repositoryPath = parsed.pathname.replace(/^\/+|\/+$/g, "");
    } catch {
      return null;
    }
  } else {
    const scp = value.match(/^(?:[^@/:\\]+@)?([^/:\\]+):(.+)$/);
    if (!scp) return null;
    host = scp[1]!.toLowerCase();
    repositoryPath = scp[2]!.replace(/^\/+|\/+$/g, "");
  }

  if (
    !host ||
    !host.includes(".") ||
    !repositoryPath ||
    repositoryPath.includes("\\") ||
    repositoryPath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }

  const firstLabel = host.split(".")[0];
  if (host === "github.com" || firstLabel === "github") {
    return { forge: "github", host };
  }
  if (host === "gitlab.com" || firstLabel === "gitlab") {
    return { forge: "gitlab", host };
  }
  return null;
}

function forgeDisplayName(forge: RepositoryForgeTarget["forge"]) {
  return forge === "github" ? "GitHub" : "GitLab";
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

function newIdempotencyKey() {
  const crypto = globalThis.crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const providerFromView: Record<WorkspaceProvider, Provider> = {
  codex: "Codex",
  openCode: "OpenCode",
  hermes: "Hermes",
  vsCode: "VS Code",
};

const providerToRequest: Record<Provider, WorkspaceProvider> = {
  Codex: "codex",
  OpenCode: "openCode",
  Hermes: "hermes",
  "VS Code": "vsCode",
};

function preferredAgentProvider(provider: Provider): AgentProvider | null {
  switch (provider) {
    case "Codex":
      return "codex";
    case "OpenCode":
      return "openCode";
    case "Hermes":
      return "hermes";
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

const providers: Array<{
  id: Provider;
  description: string;
  capability: string;
}> = [
  {
    id: "Codex",
    description: "Interactive Codex CLI rooted at the generated workspace.",
    capability: "Terminal CLI",
  },
  {
    id: "OpenCode",
    description:
      "A terminal-native coding agent inside the selected worktrees.",
    capability: "Terminal session",
  },
  {
    id: "Hermes",
    description: "Interactive Hermes CLI rooted at the generated workspace.",
    capability: "Terminal CLI",
  },
  {
    id: "VS Code",
    description: "Open the workspace directly without an autonomous agent.",
    capability: "Editor only",
  },
];

const providerMarks: Record<Provider, string> = {
  Codex: "CX",
  OpenCode: "OC",
  Hermes: "HM",
  "VS Code": "VS",
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

function CodeWorkspaceDiagnosticsPanel({
  imported,
  copyState,
  onCopy,
}: {
  imported: CodeWorkspaceFileImportResult;
  copyState: "idle" | "copied" | "error";
  onCopy: () => void;
}) {
  const diagnostics = imported.diagnostics;
  if (!diagnostics) return null;

  return (
    <details
      className={styles.importDiagnostics}
      data-ui="workspace-import.diagnostics"
      data-ui-label="Import diagnostics"
    >
      <summary>
        <span className={styles.importDiagnosticsChevron}>
          <Glyph name="chevron" size={14} />
        </span>
        <span>
          <b>Developer diagnostics</b>
          <small>Trace trusted-root discovery and folder matching</small>
        </span>
        <span className={styles.importDiagnosticsBadge}>DEBUG DATA</span>
      </summary>

      <div className={styles.importDiagnosticsBody}>
        <p className={styles.importDiagnosticsBoundary}>
          WTS searches a bounded set of nested folders under the configured
          trusted source roots. Absolute paths can match exactly. Because the
          browser does not reveal the selected file’s parent directory, relative
          paths remain non-authoritative lookup hints: WTS first compares their
          safe path suffix inside the trusted catalog, then tries the final
          folder name and optional VS Code name. A workspace file never grants
          filesystem authority outside those roots.
        </p>

        <dl className={styles.importDiagnosticsFacts}>
          <div>
            <dt>Import ID</dt>
            <dd>
              <code>{imported.importId}</code>
            </dd>
          </div>
          <div>
            <dt>Discovery mode</dt>
            <dd>Nested repositories · bounded scan</dd>
          </div>
          <div className={styles.importDiagnosticsRootFact}>
            <dt>Primary trusted source root</dt>
            <dd>
              <code>{diagnostics.catalog.repositoryRootDisplayPath}</code>
            </dd>
          </div>
          <div>
            <dt>Repositories found</dt>
            <dd>
              {diagnostics.catalog.repositoryCount}{" "}
              {diagnostics.catalog.repositoryCount === 1
                ? "repository"
                : "repositories"}
            </dd>
          </div>
          <div>
            <dt>Entries skipped</dt>
            <dd>
              {diagnostics.catalog.skippedEntries} during bounded discovery
            </dd>
          </div>
        </dl>

        <section
          aria-labelledby="code-workspace-catalog-sample-title"
          className={styles.importDiagnosticsSection}
        >
          <header>
            <h4 id="code-workspace-catalog-sample-title">
              Discovered local sources
            </h4>
            <small>
              {diagnostics.catalog.repositories.length} shown
              {diagnostics.catalog.repositoriesTruncated ? " · truncated" : ""}
            </small>
          </header>
          {diagnostics.catalog.repositories.length > 0 ? (
            <ul className={styles.importDiagnosticsRepositories}>
              {diagnostics.catalog.repositories.map((repository, index) => (
                <li
                  key={`${repository.label}-${repository.displayPath}-${index}`}
                >
                  <b>{repository.label}</b>
                  <code>{repository.displayPath}</code>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.importDiagnosticsEmpty}>
              No Git repositories were discovered under the configured trusted
              source roots within this bounded scan.
            </p>
          )}
        </section>

        <section
          aria-labelledby="code-workspace-folder-diagnostics-title"
          className={styles.importDiagnosticsSection}
        >
          <header>
            <h4 id="code-workspace-folder-diagnostics-title">
              Folder resolution
            </h4>
            <small>{diagnostics.folders.length} inspected</small>
          </header>
          <div className={styles.importDiagnosticsFolders}>
            {diagnostics.folders.map((diagnostic) => {
              const folder = imported.folders[diagnostic.folderIndex];
              return (
                <article
                  data-status={diagnostic.status}
                  key={`${diagnostic.folderIndex}-${diagnostic.reason}`}
                >
                  <header>
                    <span>
                      <b>
                        {folder?.name ?? `Folder ${diagnostic.folderIndex + 1}`}
                      </b>
                      <code>{folder?.rawPath || "No path supplied"}</code>
                    </span>
                    <em>{codeWorkspaceFolderStatusLabel(diagnostic.status)}</em>
                  </header>
                  <p>
                    {codeWorkspaceDiagnosticReasonLabels[diagnostic.reason]}
                    <code>{diagnostic.reason}</code>
                  </p>
                  {diagnostic.attempts.length > 0 && (
                    <ol
                      aria-label={`Matching attempts for ${
                        folder?.name ?? "folder"
                      }`}
                    >
                      {diagnostic.attempts.map((attempt, attemptIndex) => (
                        <li
                          key={`${attempt.basis}-${attempt.value}-${attemptIndex}`}
                        >
                          <span>
                            {codeWorkspaceDiagnosticBasisLabels[attempt.basis]}
                          </span>
                          <code>{attempt.value || "empty value"}</code>
                          <small>
                            {attempt.candidateCount}{" "}
                            {attempt.candidateCount === 1
                              ? "candidate"
                              : "candidates"}
                          </small>
                        </li>
                      ))}
                    </ol>
                  )}
                  {diagnostic.candidates.length > 0 && (
                    <div className={styles.importDiagnosticsCandidates}>
                      <b>
                        Decisive candidates
                        {diagnostic.candidatesTruncated ? " (truncated)" : ""}
                      </b>
                      <ul>
                        {diagnostic.candidates.map((candidate, index) => (
                          <li
                            key={`${candidate.label}-${candidate.displayPath}-${index}`}
                          >
                            <span>{candidate.label}</span>
                            <code>{candidate.displayPath}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {diagnostic.duplicateRepository && (
                    <small className={styles.importDiagnosticsDuplicate}>
                      This match duplicated a repository selected by an earlier
                      folder.
                    </small>
                  )}
                </article>
              );
            })}
          </div>
        </section>

        <footer className={styles.importDiagnosticsFooter}>
          <p>
            The copy includes local paths and repository labels. It excludes
            workspace-file contents, settings, tasks, extensions, and session
            credentials.
          </p>
          <button
            className={styles.importDiagnosticsCopy}
            onClick={onCopy}
            type="button"
          >
            <Glyph name={copyState === "copied" ? "check" : "copy"} size={14} />
            {copyState === "copied" ? "Diagnostics copied" : "Copy diagnostics"}
          </button>
          {copyState !== "idle" && (
            <span
              aria-live={copyState === "error" ? "assertive" : "polite"}
              className={styles.importDiagnosticsCopyStatus}
              role={copyState === "error" ? "alert" : "status"}
            >
              {copyState === "error"
                ? "Clipboard unavailable. Copy from this panel instead."
                : "Copied—review local paths before sharing."}
            </span>
          )}
        </footer>
      </div>
    </details>
  );
}

interface ReviewWorkspaceSeed {
  preparation: CloneRepositoryResult;
  review: GitlabReview;
}

function NewWorkspaceDialog({
  open,
  onOpenChange,
  onComplete,
  client,
  workspaces,
  workspaceRootDisplayPath,
  repositoryCatalog,
  initialTemplateWorkspaceId,
  initialRepositoryBaseOverrides,
  initialReviewWorkspace,
  initialPlanningEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onComplete: (workspace: WorkspaceView) => void;
  client: WorkspaceClient;
  workspaces: Workspace[];
  workspaceRootDisplayPath: string;
  repositoryCatalog?: RepositoryCatalog;
  initialTemplateWorkspaceId?: string;
  initialRepositoryBaseOverrides?: Record<string, string>;
  initialReviewWorkspace?: ReviewWorkspaceSeed;
  initialPlanningEnabled?: boolean;
}) {
  const isRevisionMode = Boolean(initialTemplateWorkspaceId);
  const [step, setStep] = useState<CreateStep>("source");
  const [furthestReviewStepNumber, setFurthestReviewStepNumber] = useState(1);
  const [sourceMode, setSourceMode] = useState<SourceMode>("issue");
  const [issueProvider, setIssueProvider] = useState<IssueProvider>("jira");
  const [sourceValue, setSourceValue] = useState("");
  const [templateWorkspaceId, setTemplateWorkspaceId] = useState("");
  const [revisionTitle, setRevisionTitle] = useState("");
  const [issueRepositories, setIssueRepositories] = useState("");
  const [jiraImport, setJiraImport] = useState<JiraIssueImport | null>(null);
  const [openProjectImport, setOpenProjectImport] =
    useState<OpenProjectWorkPackageImport | null>(null);
  const [sourceImportState, setSourceImportState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [sourceImportMessage, setSourceImportMessage] = useState("");
  const [codeWorkspaceImport, setCodeWorkspaceImport] =
    useState<CodeWorkspaceFileImportResult | null>(null);
  const [codeWorkspaceImportState, setCodeWorkspaceImportState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [codeWorkspaceImportMessage, setCodeWorkspaceImportMessage] =
    useState("");
  const [codeWorkspaceTitle, setCodeWorkspaceTitle] = useState("");
  const [codeWorkspaceAddedRepositoryIds, setCodeWorkspaceAddedRepositoryIds] =
    useState<string[]>([]);
  const [codeWorkspaceRepositoryToAdd, setCodeWorkspaceRepositoryToAdd] =
    useState("");
  const [codeWorkspaceRepositoryAddMode, setCodeWorkspaceRepositoryAddMode] =
    useState<CodeWorkspaceRepositoryAddMode>("existing");
  const [codeWorkspaceCloneUrl, setCodeWorkspaceCloneUrl] = useState("");
  const [codeWorkspaceCloneState, setCodeWorkspaceCloneState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [codeWorkspaceCloneMessage, setCodeWorkspaceCloneMessage] =
    useState("");
  const [issueRepositoryCloneKey, setIssueRepositoryCloneKey] = useState("");
  const [issueRepositoryCloneNotice, setIssueRepositoryCloneNotice] = useState<{
    kind: "success" | "error";
    message: string;
  } | null>(null);
  const [issueRepositoryLocalMatches, setIssueRepositoryLocalMatches] =
    useState<Record<string, string>>({});
  const [issueRepositoryShowAllRemotes, setIssueRepositoryShowAllRemotes] =
    useState<Record<string, boolean>>({});
  const [codeWorkspaceClonedRepositories, setCodeWorkspaceClonedRepositories] =
    useState<RepositorySummary[]>([]);
  const [refreshedRepositories, setRefreshedRepositories] = useState<
    RepositorySummary[]
  >([]);
  const [refreshingRepositoryId, setRefreshingRepositoryId] = useState("");
  const [codeWorkspaceCloneRoot, setCodeWorkspaceCloneRoot] = useState("");
  const [codeWorkspaceExportState, setCodeWorkspaceExportState] = useState<
    "idle" | "downloaded" | "error"
  >("idle");
  const [
    codeWorkspaceDiagnosticsCopyState,
    setCodeWorkspaceDiagnosticsCopyState,
  ] = useState<"idle" | "copied" | "error">("idle");
  const [repos, setRepos] = useState<RepoEvidence[]>([]);
  const [openingRepositoryBaseKey, setOpeningRepositoryBaseKey] = useState("");
  const [repositoryBaseNotice, setRepositoryBaseNotice] = useState<{
    kind: "opening" | "success" | "error";
    message: string;
  } | null>(null);
  const [runtimeAnalysis, setRuntimeAnalysis] =
    useState<RuntimeAnalysisResult | null>(null);
  const [runtimeAnalysisState, setRuntimeAnalysisState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [runtimeAnalysisError, setRuntimeAnalysisError] = useState("");
  const [runtimeAnalysisElapsedSeconds, setRuntimeAnalysisElapsedSeconds] =
    useState(0);
  const [runtimeAnalysisFingerprint, setRuntimeAnalysisFingerprint] =
    useState("");
  const [runtimeServiceDrafts, setRuntimeServiceDrafts] = useState<
    Map<string, RuntimeServiceDraft>
  >(new Map());
  const [provider, setProvider] = useState<Provider>("Codex");
  const [planningEnabled, setPlanningEnabled] = useState(false);
  const [planningFolder, setPlanningFolder] =
    useState<WorkspacePlanningSelection["folder"]>("plansAndKanban");
  const [planningFormat, setPlanningFormat] =
    useState<WorkspacePlanningSelection["format"]>("kanban");
  const [saveError, setSaveError] = useState("");
  const [saveWarning, setSaveWarning] = useState("");
  const [savedWorkspace, setSavedWorkspace] = useState<WorkspaceView | null>(
    null,
  );
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStepRef = useRef<CreateStep>("source");
  const idempotencyKeyRef = useRef("");
  const idempotencyRequestRef = useRef("");
  const dialogSessionGenerationRef = useRef(0);
  const sourceImportGenerationRef = useRef(0);
  const codeWorkspaceImportIdRef = useRef<string | null>(null);
  const repositoryCloneGenerationRef = useRef(0);
  const repositoryEditRevisionRef = useRef(0);
  const repositoryBaseOpenGenerationRef = useRef(0);
  const runtimeAnalysisGenerationRef = useRef(0);
  const runtimeAnalysisCacheRef = useRef(
    new Map<string, RuntimeAnalysisResult>(),
  );
  const reviewedSourceRepositoriesFingerprintRef = useRef("");
  const currentRuntimeFingerprintRef = useRef("");
  const saveGenerationRef = useRef(0);
  const activeSaveRef = useRef(false);
  const currentClientRef = useRef(client);
  const autoSuggestedRepositoriesRef = useRef<string | null>(null);

  useEffect(() => {
    dialogSessionGenerationRef.current += 1;
    sourceImportGenerationRef.current += 1;
    repositoryCloneGenerationRef.current += 1;
    saveGenerationRef.current += 1;
    repositoryEditRevisionRef.current = 0;
    repositoryBaseOpenGenerationRef.current += 1;
    runtimeAnalysisGenerationRef.current += 1;
    runtimeAnalysisCacheRef.current.clear();
    reviewedSourceRepositoriesFingerprintRef.current = "";
    currentRuntimeFingerprintRef.current = "";
    activeSaveRef.current = false;
    autoSuggestedRepositoriesRef.current = null;

    if (!open) {
      setStep("source");
      setFurthestReviewStepNumber(1);
      setSourceMode("issue");
      setIssueProvider("jira");
      setSourceValue("");
      setTemplateWorkspaceId("");
      setRevisionTitle("");
      setIssueRepositories("");
      setJiraImport(null);
      setOpenProjectImport(null);
      setSourceImportState("idle");
      setSourceImportMessage("");
      setCodeWorkspaceImport(null);
      codeWorkspaceImportIdRef.current = null;
      setCodeWorkspaceImportState("idle");
      setCodeWorkspaceImportMessage("");
      setCodeWorkspaceTitle("");
      setCodeWorkspaceAddedRepositoryIds([]);
      setCodeWorkspaceRepositoryToAdd("");
      setCodeWorkspaceRepositoryAddMode("existing");
      setCodeWorkspaceCloneUrl("");
      setCodeWorkspaceCloneState("idle");
      setCodeWorkspaceCloneMessage("");
      setIssueRepositoryCloneKey("");
      setIssueRepositoryCloneNotice(null);
      setIssueRepositoryLocalMatches({});
      setIssueRepositoryShowAllRemotes({});
      setCodeWorkspaceClonedRepositories([]);
      setRefreshedRepositories([]);
      setRefreshingRepositoryId("");
      setCodeWorkspaceCloneRoot("");
      setCodeWorkspaceExportState("idle");
      setCodeWorkspaceDiagnosticsCopyState("idle");
      setRepos([]);
      setOpeningRepositoryBaseKey("");
      setRepositoryBaseNotice(null);
      setRuntimeAnalysis(null);
      setRuntimeAnalysisState("idle");
      setRuntimeAnalysisError("");
      setRuntimeAnalysisElapsedSeconds(0);
      setRuntimeAnalysisFingerprint("");
      setRuntimeServiceDrafts(new Map());
      setProvider("Codex");
      setPlanningEnabled(false);
      setPlanningFolder("plansAndKanban");
      setPlanningFormat("kanban");
      setSaveError("");
      setSaveWarning("");
      setSavedWorkspace(null);
      idempotencyKeyRef.current = "";
      idempotencyRequestRef.current = "";
    }

    return () => {
      dialogSessionGenerationRef.current += 1;
      sourceImportGenerationRef.current += 1;
      repositoryCloneGenerationRef.current += 1;
      codeWorkspaceImportIdRef.current = null;
      repositoryBaseOpenGenerationRef.current += 1;
      runtimeAnalysisGenerationRef.current += 1;
      saveGenerationRef.current += 1;
      activeSaveRef.current = false;
    };
  }, [open]);

  useEffect(() => {
    if (currentClientRef.current === client) return;

    currentClientRef.current = client;
    sourceImportGenerationRef.current += 1;
    repositoryCloneGenerationRef.current += 1;
    repositoryBaseOpenGenerationRef.current += 1;
    runtimeAnalysisGenerationRef.current += 1;
    runtimeAnalysisCacheRef.current.clear();
    currentRuntimeFingerprintRef.current = "";
    saveGenerationRef.current += 1;
    activeSaveRef.current = false;
    setOpeningRepositoryBaseKey("");
    setRepositoryBaseNotice(null);
    setRuntimeAnalysis(null);
    setRuntimeAnalysisState("idle");
    setRuntimeAnalysisError("");
    setRuntimeAnalysisFingerprint("");
    setRuntimeServiceDrafts(new Map());
    if (sourceImportState === "loading") {
      setSourceImportState("idle");
      setSourceImportMessage(
        "The workspace connection changed. Import this issue again.",
      );
    }
    if (codeWorkspaceImportState === "loading") {
      setCodeWorkspaceImportState("idle");
      setCodeWorkspaceImportMessage(
        "The workspace connection changed. Choose the VS Code workspace file again.",
      );
    }
    if (codeWorkspaceCloneState === "loading") {
      setCodeWorkspaceCloneState("idle");
      setCodeWorkspaceCloneMessage(
        "The workspace connection changed. Enter the repository URL again.",
      );
    }
    if (step === "saving" && !saveError) {
      setSaveError(
        "The workspace connection changed before the save completed. Review and retry the plan.",
      );
    }
  }, [client]);

  useEffect(() => {
    if (!open || !initialTemplateWorkspaceId) return;
    const sourceWorkspace = workspaces.find(
      (workspace) => workspace.id === initialTemplateWorkspaceId,
    );
    setSourceMode("workspace");
    setTemplateWorkspaceId(initialTemplateWorkspaceId);
    if (!sourceWorkspace) return;
    setProvider(sourceWorkspace.provider);
    setPlanningEnabled(
      initialPlanningEnabled ?? sourceWorkspace.planning !== undefined,
    );
    setPlanningFolder(sourceWorkspace.planning?.folder ?? "plansAndKanban");
    setPlanningFormat(sourceWorkspace.planning?.format ?? "kanban");
    setRevisionTitle(`${sourceWorkspace.title} · revised`);
    setRepos(
      sourceWorkspace.repositoryPlans.map((repository) => ({
        key: repositoryEvidenceKey(repository.repositoryId, repository.label),
        id: repository.label,
        ...(repository.repositoryId === undefined
          ? {}
          : { repositoryId: repository.repositoryId }),
        reason: `Revised from ${sourceWorkspace.key}`,
        confidence: 100,
        included: true,
        base:
          (repository.repositoryId
            ? initialRepositoryBaseOverrides?.[repository.repositoryId]
            : undefined) ?? repository.baseRef,
      })),
    );
    if (
      initialRepositoryBaseOverrides &&
      Object.keys(initialRepositoryBaseOverrides).length > 0
    ) {
      setStep("evidence");
    }
  }, [
    initialRepositoryBaseOverrides,
    initialPlanningEnabled,
    initialTemplateWorkspaceId,
    open,
    workspaces,
  ]);

  useEffect(() => {
    if (!open || !initialReviewWorkspace) return;
    const repository = initialReviewWorkspace.preparation.repository;
    setSourceMode("set");
    setSourceValue(
      `Review ${initialReviewWorkspace.review.repository} !${initialReviewWorkspace.review.number}`,
    );
    setCodeWorkspaceClonedRepositories([repository]);
    setCodeWorkspaceCloneRoot(
      initialReviewWorkspace.preparation.repositoryRootDisplayPath,
    );
    setCodeWorkspaceAddedRepositoryIds([repository.id]);
    setProvider("Codex");
    setPlanningEnabled(true);
  }, [initialReviewWorkspace, open]);

  useEffect(() => {
    const stepChanged = previousStepRef.current !== step;
    previousStepRef.current = step;
    if (!open || !stepChanged) return;

    const frame = window.requestAnimationFrame(() => {
      stepHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, step]);

  useEffect(() => {
    const reviewStepNumber =
      step === "source"
        ? 1
        : step === "evidence"
          ? 2
          : step === "services"
            ? 3
            : step === "manifest"
              ? 4
              : 0;
    if (reviewStepNumber === 0) return;
    setFurthestReviewStepNumber((current) =>
      Math.max(current, reviewStepNumber),
    );
  }, [step]);

  useEffect(() => {
    if (step === "evidence") return;
    repositoryBaseOpenGenerationRef.current += 1;
    setOpeningRepositoryBaseKey("");
    setRepositoryBaseNotice(null);
  }, [step]);

  const runtimeAnalysisStartedAtRef = useRef<number>(0);
  useEffect(() => {
    if (runtimeAnalysisState === "loading") {
      runtimeAnalysisStartedAtRef.current = Date.now();
      setRuntimeAnalysisElapsedSeconds(0);
    }
  }, [runtimeAnalysisState]);

  useVisiblePolling(
    () => {
      if (runtimeAnalysisState === "loading") {
        setRuntimeAnalysisElapsedSeconds(
          Math.max(
            0,
            Math.floor(
              (Date.now() - runtimeAnalysisStartedAtRef.current) / 1000,
            ),
          ),
        );
      }
    },
    1000,
    { enabled: runtimeAnalysisState === "loading" },
  );

  const included = repos.filter((repo) => repo.included);
  const effectiveRepositoryCatalog = useMemo(() => {
    if (
      codeWorkspaceClonedRepositories.length === 0 &&
      refreshedRepositories.length === 0
    ) {
      return repositoryCatalog;
    }
    const repositories = new Map(
      (repositoryCatalog?.repositories ?? []).map((repository) => [
        repository.id,
        repository,
      ]),
    );
    for (const repository of codeWorkspaceClonedRepositories) {
      repositories.set(repository.id, repository);
    }
    for (const repository of refreshedRepositories) {
      repositories.set(repository.id, repository);
    }
    return {
      repositoryRootDisplayPath:
        repositoryCatalog?.repositoryRootDisplayPath ?? codeWorkspaceCloneRoot,
      repositories: Array.from(repositories.values()),
      skippedEntries: repositoryCatalog?.skippedEntries ?? 0,
    };
  }, [
    codeWorkspaceCloneRoot,
    codeWorkspaceClonedRepositories,
    refreshedRepositories,
    repositoryCatalog,
  ]);
  useEffect(() => {
    if (
      !effectiveRepositoryCatalog ||
      effectiveRepositoryCatalog.repositories.length === 0 ||
      repos.length === 0
    ) {
      return;
    }

    setRepos((current) => {
      const claimedRepositoryIds = new Set(
        current.flatMap((repository) =>
          repository.repositoryId ? [repository.repositoryId] : [],
        ),
      );
      let changed = false;
      const reconciled = current.map((repository) => {
        if (repository.repositoryId) return repository;
        const catalogRepository = catalogRepositoryFor(
          undefined,
          repository.id,
          effectiveRepositoryCatalog,
        );
        if (
          !catalogRepository ||
          claimedRepositoryIds.has(catalogRepository.id)
        ) {
          return repository;
        }

        claimedRepositoryIds.add(catalogRepository.id);
        changed = true;
        const selectedBaseAvailable =
          catalogRepository.availableBranches?.some(
            (branch) => branch.name === repository.base,
          ) ?? false;
        return {
          ...repository,
          repositoryId: catalogRepository.id,
          base: selectedBaseAvailable
            ? repository.base
            : catalogRepository.defaultBranch.name,
        };
      });
      return changed ? reconciled : current;
    });
  }, [effectiveRepositoryCatalog, repos]);
  const runtimeAnalysisPreparation = useMemo(
    () =>
      runtimeAnalysisPreparationFor(
        repos.filter((repo) => repo.included),
        effectiveRepositoryCatalog,
      ),
    [effectiveRepositoryCatalog, repos],
  );
  const runtimeAnalysisRequest = runtimeAnalysisPreparation.request;
  const currentRuntimeFingerprint = runtimeAnalysisPreparation.fingerprint;
  currentRuntimeFingerprintRef.current = currentRuntimeFingerprint;
  const isIssueSource = sourceMode === "issue";
  const isWorkspaceSource = sourceMode === "workspace";
  const isCodeWorkspaceSource = sourceMode === "codeWorkspace";
  const templateWorkspace = workspaces.find(
    (workspace) => workspace.id === templateWorkspaceId,
  );
  const catalogRepositoriesById = useMemo(
    () =>
      new Map(
        (effectiveRepositoryCatalog?.repositories ?? []).map((repository) => [
          repository.id,
          repository,
        ]),
      ),
    [effectiveRepositoryCatalog],
  );
  const importedCodeWorkspaceRepositoryIds = useMemo(
    () =>
      new Set(
        codeWorkspaceImport?.repositories.flatMap((repository) =>
          repository.repositoryId ? [repository.repositoryId] : [],
        ) ?? [],
      ),
    [codeWorkspaceImport],
  );
  const templateWorkspaceRepositoryIds = useMemo(
    () =>
      new Set(
        templateWorkspace?.repositoryPlans.flatMap((repository) =>
          repository.repositoryId ? [repository.repositoryId] : [],
        ) ?? [],
      ),
    [templateWorkspace],
  );
  const templateWorkspaceRepositoryLabels = useMemo(
    () =>
      new Set(
        templateWorkspace?.repositoryPlans.map((repository) =>
          repository.label.toLocaleLowerCase(),
        ) ?? [],
      ),
    [templateWorkspace],
  );
  const addedCodeWorkspaceRepositories = useMemo(
    () =>
      codeWorkspaceAddedRepositoryIds.flatMap((repositoryId) => {
        const repository = catalogRepositoriesById.get(repositoryId);
        return repository ? [repository] : [];
      }),
    [catalogRepositoriesById, codeWorkspaceAddedRepositoryIds],
  );
  const clonedCodeWorkspaceRepositoryIds = useMemo(
    () =>
      new Set(
        codeWorkspaceClonedRepositories.map((repository) => repository.id),
      ),
    [codeWorkspaceClonedRepositories],
  );
  const availableCodeWorkspaceRepositories = useMemo(
    () =>
      (effectiveRepositoryCatalog?.repositories ?? []).filter(
        (repository) =>
          !importedCodeWorkspaceRepositoryIds.has(repository.id) &&
          !templateWorkspaceRepositoryIds.has(repository.id) &&
          !templateWorkspaceRepositoryLabels.has(
            repository.label.toLocaleLowerCase(),
          ) &&
          !codeWorkspaceAddedRepositoryIds.includes(repository.id),
      ),
    [
      codeWorkspaceAddedRepositoryIds,
      importedCodeWorkspaceRepositoryIds,
      templateWorkspaceRepositoryIds,
      templateWorkspaceRepositoryLabels,
      effectiveRepositoryCatalog,
    ],
  );
  const codeWorkspaceCloneLeaf = repositoryLeafFromRemoteUrl(
    codeWorkspaceCloneUrl,
  );
  const codeWorkspaceCloneTarget = codeWorkspaceCloneLeaf
    ? joinDisplayPath(
        effectiveRepositoryCatalog?.repositoryRootDisplayPath ??
          codeWorkspaceCloneRoot,
        codeWorkspaceCloneLeaf,
      )
    : "";
  const jiraRepositoryUpstreams = useMemo(
    () => repositoryUpstreamsFromIssueContent(jiraImport?.content ?? ""),
    [jiraImport?.content],
  );
  const jiraRepositoryUpstreamsByLabel = useMemo(
    () =>
      new Map(
        jiraRepositoryUpstreams.map((upstream) => [
          upstream.label.toLocaleLowerCase(),
          upstream,
        ]),
      ),
    [jiraRepositoryUpstreams],
  );
  useEffect(() => {
    if (
      !runtimeAnalysisFingerprint ||
      runtimeAnalysisFingerprint === currentRuntimeFingerprint
    ) {
      return;
    }
    runtimeAnalysisGenerationRef.current += 1;
    setRuntimeAnalysis(null);
    setRuntimeAnalysisState("idle");
    setRuntimeAnalysisError("");
    setRuntimeAnalysisFingerprint("");
    setRuntimeServiceDrafts(new Map());
  }, [currentRuntimeFingerprint, runtimeAnalysisFingerprint]);
  const enteredRepositories: Array<{
    repositoryId?: string;
    label: string;
    baseRef: string;
  }> = isWorkspaceSource
    ? [
        ...(templateWorkspace?.repositoryPlans.map((repository) => ({
          ...(repository.repositoryId === undefined
            ? {}
            : { repositoryId: repository.repositoryId }),
          label: repository.label,
          baseRef:
            (repository.repositoryId
              ? initialRepositoryBaseOverrides?.[repository.repositoryId]
              : undefined) ?? repository.baseRef,
        })) ?? []),
        ...addedCodeWorkspaceRepositories.map((repository) => ({
          repositoryId: repository.id,
          label: repository.label,
          baseRef:
            initialRepositoryBaseOverrides?.[repository.id] ??
            repository.defaultBranch.name,
        })),
      ]
    : isCodeWorkspaceSource
      ? [
          ...(codeWorkspaceImport?.repositories ?? []),
          ...addedCodeWorkspaceRepositories.map((repository) => ({
            repositoryId: repository.id,
            label: repository.label,
            baseRef: repository.defaultBranch.name,
          })),
        ]
      : sourceMode === "set"
        ? addedCodeWorkspaceRepositories.map((repository) => ({
            repositoryId: repository.id,
            label: repository.label,
            baseRef:
              initialRepositoryBaseOverrides?.[repository.id] ??
              repository.defaultBranch.name,
          }))
      : repositoryNamesFrom(
          isIssueSource ? issueRepositories : sourceValue,
        ).map((label) => {
          const selectedRepositoryId = isIssueSource
            ? issueRepositoryLocalMatches[label.toLocaleLowerCase()]
            : undefined;
          const catalogRepository = catalogRepositoryFor(
            selectedRepositoryId,
            label,
            effectiveRepositoryCatalog,
          );
          return catalogRepository
            ? {
                repositoryId: catalogRepository.id,
                label: catalogRepository.label,
                baseRef: catalogRepository.defaultBranch.name,
              }
            : { label, baseRef: "main" };
        });
  const sourceRepositoryReview = enteredRepositories.map((repository) => ({
    repository,
    catalogRepository: catalogRepositoryFor(
      repository.repositoryId,
      repository.label,
      effectiveRepositoryCatalog,
    ),
    upstreamRepository:
      issueProvider === "jira"
        ? jiraRepositoryUpstreamsByLabel.get(
            repository.label.toLocaleLowerCase(),
          )
        : undefined,
  }));
  const enteredRepositoryNames = enteredRepositories.map(
    (repository) => repository.label,
  );
  const sourceRepositoriesFingerprint = JSON.stringify(
    enteredRepositories.map((repository) => [
      repository.repositoryId ?? "",
      repository.label,
      repository.baseRef,
    ]),
  );
  const jiraKey = issueKeyFrom(sourceValue);
  const openProjectReference = openProjectReferenceFrom(sourceValue);
  const draftKey = isIssueSource
    ? issueProvider === "jira"
      ? jiraKey
      : (openProjectImport?.displayId ?? openProjectReference ?? "")
    : isWorkspaceSource
      ? isRevisionMode
        ? (templateWorkspace?.key ?? "workspace")
        : `Copy of ${templateWorkspace?.key ?? "workspace"}`
      : isCodeWorkspaceSource
        ? (codeWorkspaceImport?.suggestedRepositorySetLabel ?? "")
        : initialReviewWorkspace
          ? `Review ${initialReviewWorkspace.preparation.repository.label} !${initialReviewWorkspace.review.number}`
          : `Local repositories · ${enteredRepositoryNames[0] ?? "workspace"}`;
  const draftTitle = isIssueSource
    ? issueProvider === "jira"
      ? (jiraImport?.summary ?? `Work on ${draftKey || "Jira issue"}`)
      : (openProjectImport?.subject ??
        `Work on ${draftKey || "OpenProject work package"}`)
    : isWorkspaceSource
      ? isRevisionMode
        ? revisionTitle.trim()
        : `${templateWorkspace?.title ?? "Saved WTS plan"} · copy`
      : isCodeWorkspaceSource
        ? codeWorkspaceTitle.trim()
      : initialReviewWorkspace
        ? `Review ${initialReviewWorkspace.review.repository} !${initialReviewWorkspace.review.number}`
        : `Repositories: ${
            enteredRepositoryNames.slice(0, 2).join(" + ") || "local work"
          }`;
  const importedIssue =
    issueProvider === "jira" && jiraImport
      ? {
          reference: jiraImport.issueKey,
          title: jiraImport.summary ?? jiraImport.issueKey,
          status: jiraImport.status,
          project: undefined,
          content: jiraImport.content,
          recommendations: jiraImport.repositoryRecommendations,
        }
      : issueProvider === "openProject" && openProjectImport
        ? {
            reference: openProjectImport.displayId,
            title: openProjectImport.subject,
            status: openProjectImport.status,
            project: openProjectImport.project,
            content: openProjectImport.content,
            recommendations: openProjectImport.repositoryRecommendations,
          }
        : null;
  const jiraKeyIsValid = /^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,9}$/.test(jiraKey);
  const openProjectReferenceIsValid = openProjectReference !== null;
  const canAnalyze =
    enteredRepositoryNames.length > 0 &&
    (!isRevisionMode || revisionTitle.trim().length > 0) &&
    (isWorkspaceSource
      ? templateWorkspace !== undefined
      : isCodeWorkspaceSource
        ? codeWorkspaceImportState === "ready" &&
          codeWorkspaceImport !== null &&
          codeWorkspaceTitle.trim().length > 0
        : sourceMode === "set"
          ? true
          : sourceValue.trim().length > 0 &&
            (sourceImportState !== "loading" || issueProvider === "jira") &&
            (issueProvider === "jira"
              ? jiraKeyIsValid
              : openProjectReferenceIsValid && openProjectImport !== null));
  const sourceBlockingMessage = canAnalyze
    ? null
    : enteredRepositoryNames.length === 0
      ? "Choose at least one local repository to continue."
      : isRevisionMode && revisionTitle.trim().length === 0
        ? "Add a title for the revised workspace."
        : isWorkspaceSource && templateWorkspace === undefined
          ? "Choose a saved WTS plan to copy."
          : isCodeWorkspaceSource && codeWorkspaceImportState !== "ready"
            ? "Import a valid VS Code workspace file first."
            : isCodeWorkspaceSource && codeWorkspaceTitle.trim().length === 0
              ? "Add a title for the imported workspace."
              : sourceValue.trim().length === 0
                ? sourceMode === "set"
                  ? "Name this workspace to continue."
                  : `Enter a ${issueProvider === "jira" ? "Jira issue key" : "work package reference"}.`
                : issueProvider === "jira" && !jiraKeyIsValid
                  ? "Enter a valid Jira issue key, such as PLATFORM-42."
                  : issueProvider === "openProject" &&
                      (!openProjectReferenceIsValid ||
                        openProjectImport === null)
                    ? "Import a valid OpenProject work package first."
                    : "Complete the required source details to continue.";
  const stepNumber =
    step === "source"
      ? 1
      : step === "evidence"
        ? 2
        : step === "services"
          ? 3
          : step === "manifest"
            ? 4
            : 5;

  const analyzeSource = () => {
    if (!canAnalyze) return;
    setRepositoryBaseNotice(null);
    if (isIssueSource && sourceImportState === "loading") {
      sourceImportGenerationRef.current += 1;
      setSourceImportState("idle");
      setSourceImportMessage(
        "Continuing with the repositories you entered manually. The pending Jira result will be ignored.",
      );
    }
    setRepos((current) => {
      if (
        reviewedSourceRepositoriesFingerprintRef.current ===
          sourceRepositoriesFingerprint &&
        current.length > 0
      ) {
        return current;
      }
      const currentByKey = new Map(
        current.map((repository) => [repository.key, repository]),
      );
      return enteredRepositories.map((sourceRepository) => {
        const key = repositoryEvidenceKey(
          sourceRepository.repositoryId,
          sourceRepository.label,
        );
        const existing = currentByKey.get(key);
        return {
          key,
          id: sourceRepository.label,
          ...(sourceRepository.repositoryId === undefined
            ? {}
            : { repositoryId: sourceRepository.repositoryId }),
          reason: isWorkspaceSource
            ? `${isRevisionMode ? "Revised" : "Copied"} from ${
                templateWorkspace?.key ?? "the saved workspace"
              }`
            : isCodeWorkspaceSource
              ? codeWorkspaceAddedRepositoryIds.includes(
                  sourceRepository.repositoryId ?? "",
                )
                ? clonedCodeWorkspaceRepositoryIds.has(
                    sourceRepository.repositoryId ?? "",
                  )
                  ? "Cloned from a reviewed Git URL"
                  : "Added from the local repository catalog"
                : `Imported from ${codeWorkspaceImport?.fileName ?? "VS Code workspace file"}`
              : "Selected by you for this workspace plan",
          confidence: 100,
          included: existing?.included ?? true,
          base: existing?.base ?? sourceRepository.baseRef,
        };
      });
    });
    reviewedSourceRepositoriesFingerprintRef.current =
      sourceRepositoriesFingerprint;
    setStep("evidence");
  };

  const importJira = async () => {
    if (!jiraKeyIsValid) return;
    const requestGeneration = ++sourceImportGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const repositoryEditRevision = repositoryEditRevisionRef.current;
    const requestClient = client;
    setSourceImportState("loading");
    setSourceImportMessage("");
    try {
      const imported = await requestClient.importJiraIssue(jiraKey);
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (issueKeyFrom(imported.issueKey) !== jiraKey) {
        throw new Error(
          `Jira returned ${imported.issueKey} while WTS was importing ${jiraKey}. Try the import again.`,
        );
      }
      const repositoriesWereEdited =
        repositoryEditRevision !== repositoryEditRevisionRef.current;
      const upstreamRepositories = repositoryUpstreamsFromIssueContent(
        imported.content,
      );
      const suggestedRepositories = Array.from(
        new Map(
          [
            ...imported.suggestedRepositories,
            ...upstreamRepositories.map((upstream) => upstream.label),
          ].map((label) => [label.toLocaleLowerCase(), label]),
        ).values(),
      );
      setJiraImport(imported);
      if (suggestedRepositories.length && !repositoriesWereEdited) {
        const suggestions = suggestedRepositories.join(", ");
        autoSuggestedRepositoriesRef.current = suggestions;
        setIssueRepositoryLocalMatches({});
        setIssueRepositoryShowAllRemotes({});
        setIssueRepositories(suggestions);
      } else if (!repositoriesWereEdited) {
        autoSuggestedRepositoriesRef.current = null;
        setIssueRepositoryLocalMatches({});
        setIssueRepositoryShowAllRemotes({});
      }
      setSourceImportMessage(
        repositoriesWereEdited
          ? "Imported issue context. Kept the repositories you edited while the import was running."
          : suggestedRepositories.length
            ? upstreamRepositories.length
              ? `Imported issue context and found ${suggestedRepositories.length} repository upstreams.`
              : `Imported issue context and matched ${suggestedRepositories.length} local repositories.`
            : "Imported issue context. No local repository names were found, so choose them below.",
      );
      setSourceImportState("ready");
    } catch (error) {
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setSourceImportMessage(
        error instanceof Error ? error.message : "Jira import failed.",
      );
      setSourceImportState("error");
    }
  };

  const importOpenProject = async () => {
    if (openProjectReference === null) return;
    const requestGeneration = ++sourceImportGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const repositoryEditRevision = repositoryEditRevisionRef.current;
    const requestClient = client;
    setSourceImportState("loading");
    setSourceImportMessage("");
    try {
      const imported =
        await requestClient.importOpenProjectWorkPackage(openProjectReference);
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (!openProjectImportMatchesReference(imported, openProjectReference)) {
        throw new Error(
          `OpenProject returned ${imported.displayId} while WTS was importing ${openProjectReference}. Try the import again.`,
        );
      }
      const repositoriesWereEdited =
        repositoryEditRevision !== repositoryEditRevisionRef.current;
      setOpenProjectImport(imported);
      if (imported.suggestedRepositories.length && !repositoriesWereEdited) {
        const suggestions = imported.suggestedRepositories.join(", ");
        autoSuggestedRepositoriesRef.current = suggestions;
        setIssueRepositories(suggestions);
      } else if (!repositoriesWereEdited) {
        autoSuggestedRepositoriesRef.current = null;
      }
      setSourceImportMessage(
        repositoriesWereEdited
          ? `Imported ${imported.displayId}. Kept the repositories you edited while the import was running.`
          : imported.suggestedRepositories.length
            ? `Imported ${imported.displayId} and matched ${imported.suggestedRepositories.length} local repositories.`
            : `Imported ${imported.displayId}. Choose the local repositories for this workspace below.`,
      );
      setSourceImportState("ready");
    } catch (error) {
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setSourceImportMessage(
        error instanceof Error ? error.message : "OpenProject import failed.",
      );
      setSourceImportState("error");
    }
  };

  const importCodeWorkspaceFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = "";
    const requestGeneration = ++sourceImportGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;

    setCodeWorkspaceImport(null);
    codeWorkspaceImportIdRef.current = null;
    setCodeWorkspaceTitle("");
    setCodeWorkspaceAddedRepositoryIds([]);
    setCodeWorkspaceRepositoryToAdd("");
    repositoryCloneGenerationRef.current += 1;
    setCodeWorkspaceRepositoryAddMode("existing");
    setCodeWorkspaceCloneUrl("");
    setCodeWorkspaceCloneState("idle");
    setCodeWorkspaceCloneMessage("");
    setCodeWorkspaceClonedRepositories([]);
    setCodeWorkspaceCloneRoot("");
    setCodeWorkspaceExportState("idle");
    setCodeWorkspaceDiagnosticsCopyState("idle");
    setRepos([]);
    setProvider("VS Code");
    if (!file) {
      setCodeWorkspaceImportState("idle");
      setCodeWorkspaceImportMessage("");
      return;
    }
    const rejectBeforeRead = (message: string) => {
      setCodeWorkspaceImportState("error");
      setCodeWorkspaceImportMessage(message);
      logCodeWorkspaceImportFailure(file.name, new Error(message));
    };
    if (!file.name.toLowerCase().endsWith(".code-workspace")) {
      rejectBeforeRead("Choose a file ending in .code-workspace.");
      return;
    }
    if (file.size === 0) {
      rejectBeforeRead("That VS Code workspace file is empty.");
      return;
    }
    if (file.size > CODE_WORKSPACE_FILE_MAX_BYTES) {
      rejectBeforeRead(
        "That file is larger than 48 KiB. Choose a smaller .code-workspace file.",
      );
      return;
    }

    setCodeWorkspaceImportState("loading");
    setCodeWorkspaceImportMessage(`Reading ${file.name}…`);
    try {
      const contents = await readTextFile(file);
      if (
        new TextEncoder().encode(contents).byteLength >
        CODE_WORKSPACE_FILE_MAX_BYTES
      ) {
        throw new Error(
          "That file is larger than 48 KiB. Choose a smaller .code-workspace file.",
        );
      }
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      const imported = await requestClient.importCodeWorkspaceFile({
        fileName: file.name,
        contents,
      });
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (imported.fileName !== file.name) {
        throw new Error(
          `WTS returned ${imported.fileName} while importing ${file.name}. Choose the file again.`,
        );
      }

      logCodeWorkspaceImportCompletion(imported);
      codeWorkspaceImportIdRef.current = imported.importId;
      setCodeWorkspaceImport(imported);
      setCodeWorkspaceTitle(imported.suggestedTitle);
      setCodeWorkspaceImportState("ready");
      const unmatchedFolderCount = imported.folders.filter(
        (folder) => folder.status !== "matched",
      ).length;
      const matchedFolderCount = imported.folders.length - unmatchedFolderCount;
      setCodeWorkspaceImportMessage(
        imported.repositories.length === 0
          ? imported.diagnostics
            ? `No trusted local repositories matched ${imported.fileName}. Open Developer diagnostics to inspect the bounded nested scan and folder reasons.`
            : `No trusted local repositories matched ${imported.fileName}. Check the configured repository root and folder entries.`
          : unmatchedFolderCount > 0
            ? `Imported ${matchedFolderCount} of ${imported.folders.length} folders from ${imported.fileName}. ${unmatchedFolderCount} not added.`
            : `Imported ${imported.repositories.length} ${
                imported.repositories.length === 1
                  ? "repository"
                  : "repositories"
              } from ${imported.fileName}.`,
      );
    } catch (error) {
      if (
        requestGeneration !== sourceImportGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setCodeWorkspaceImportState("error");
      setCodeWorkspaceImportMessage(
        error instanceof Error
          ? error.message
          : "The VS Code workspace file could not be imported.",
      );
      logCodeWorkspaceImportFailure(file.name, error);
    }
  };

  const copyCodeWorkspaceDiagnostics = async () => {
    if (!codeWorkspaceImport?.diagnostics) return;
    const importId = codeWorkspaceImport.importId;
    const sourceGeneration = sourceImportGenerationRef.current;
    const dialogGeneration = dialogSessionGenerationRef.current;
    const isCurrentImport = () =>
      codeWorkspaceImportIdRef.current === importId &&
      sourceImportGenerationRef.current === sourceGeneration &&
      dialogSessionGenerationRef.current === dialogGeneration;
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable.");
      }
      await navigator.clipboard.writeText(
        JSON.stringify(
          codeWorkspaceDiagnosticsPayload(codeWorkspaceImport),
          null,
          2,
        ),
      );
      if (!isCurrentImport()) return;
      setCodeWorkspaceDiagnosticsCopyState("copied");
    } catch {
      if (!isCurrentImport()) return;
      setCodeWorkspaceDiagnosticsCopyState("error");
    }
  };

  const addCodeWorkspaceRepository = () => {
    if (
      !codeWorkspaceRepositoryToAdd ||
      importedCodeWorkspaceRepositoryIds.has(codeWorkspaceRepositoryToAdd) ||
      codeWorkspaceAddedRepositoryIds.includes(codeWorkspaceRepositoryToAdd) ||
      !catalogRepositoriesById.has(codeWorkspaceRepositoryToAdd)
    ) {
      return;
    }
    setCodeWorkspaceAddedRepositoryIds((current) => [
      ...current,
      codeWorkspaceRepositoryToAdd,
    ]);
    setCodeWorkspaceRepositoryToAdd("");
    setCodeWorkspaceExportState("idle");
  };

  const cloneCodeWorkspaceRepository = async () => {
    if (
      !codeWorkspaceCloneLeaf ||
      codeWorkspaceCloneState === "loading"
    ) {
      return;
    }

    const requestGeneration = ++repositoryCloneGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setCodeWorkspaceCloneState("loading");
    setCodeWorkspaceCloneMessage(
      `Cloning ${codeWorkspaceCloneLeaf} into the trusted repository root…`,
    );
    setCodeWorkspaceExportState("idle");

    try {
      const result = await requestClient.cloneRepository({
        remoteUrl: codeWorkspaceCloneUrl.trim(),
      });
      if (
        requestGeneration !== repositoryCloneGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }

      const alreadyInPlan =
        importedCodeWorkspaceRepositoryIds.has(result.repository.id) ||
        codeWorkspaceAddedRepositoryIds.includes(result.repository.id);
      setCodeWorkspaceClonedRepositories((current) => [
        ...current.filter(
          (repository) => repository.id !== result.repository.id,
        ),
        result.repository,
      ]);
      setCodeWorkspaceCloneRoot(result.repositoryRootDisplayPath);
      if (!alreadyInPlan) {
        setCodeWorkspaceAddedRepositoryIds((current) => [
          ...current,
          result.repository.id,
        ]);
      }
      setCodeWorkspaceCloneUrl("");
      setCodeWorkspaceCloneState("ready");
      setCodeWorkspaceCloneMessage(
        alreadyInPlan
          ? `${result.repository.label} is already included in this workspace plan.`
          : result.reusedExisting
            ? `Found ${result.repository.label} in the trusted repository root and added it to this plan.`
            : `Cloned ${result.repository.label} and added it to this workspace plan.`,
      );
    } catch (error) {
      if (
        requestGeneration !== repositoryCloneGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setCodeWorkspaceCloneState("error");
      setCodeWorkspaceCloneMessage(
        error instanceof Error
          ? error.message
          : "The repository could not be cloned.",
      );
    }
  };

  const cloneIssueRepository = async (upstream: IssueRepositoryUpstream) => {
    if (issueRepositoryCloneKey) return;
    const requestGeneration = ++repositoryCloneGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setIssueRepositoryCloneKey(upstream.label.toLocaleLowerCase());
    setIssueRepositoryCloneNotice(null);

    try {
      const result = await requestClient.cloneRepository({
        remoteUrl: upstream.remoteUrl,
      });
      if (
        requestGeneration !== repositoryCloneGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setRefreshedRepositories((current) => [
        ...current.filter(
          (repository) => repository.id !== result.repository.id,
        ),
        result.repository,
      ]);
      setIssueRepositoryCloneKey("");
      setIssueRepositoryCloneNotice({
        kind: "success",
        message: result.reusedExisting
          ? `Found ${result.repository.label} in the trusted repository root.`
          : `Cloned ${result.repository.label} into the trusted repository root.`,
      });
    } catch (error) {
      if (
        requestGeneration !== repositoryCloneGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setIssueRepositoryCloneKey("");
      setIssueRepositoryCloneNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The repository could not be cloned.",
      });
    }
  };

  const removeCodeWorkspaceRepository = (repositoryId: string) => {
    setCodeWorkspaceAddedRepositoryIds((current) =>
      current.filter((candidate) => candidate !== repositoryId),
    );
    setCodeWorkspaceExportState("idle");
  };

  const downloadEditedCodeWorkspace = () => {
    if (!codeWorkspaceImport || addedCodeWorkspaceRepositories.length === 0) {
      return;
    }
    try {
      const folders = codeWorkspaceImport.folders
        .filter(
          (folder) =>
            folder.rawPath !== unsupportedUriDiagnosticValue &&
            folder.rawPath !== unsupportedDiagnosticValue &&
            folder.rawPath !== missingDiagnosticPathValue,
        )
        .map((folder) => ({
          name: folder.name,
          path: folder.rawPath,
        }));
      folders.push(
        ...addedCodeWorkspaceRepositories.map((repository) => ({
          name: repository.label,
          path: repository.displayPath,
        })),
      );
      const contents = `${JSON.stringify({ folders }, null, 2)}\n`;
      const baseName = codeWorkspaceImport.fileName.replace(
        /\.code-workspace$/i,
        "",
      );
      const anchor = document.createElement("a");
      anchor.download = `${baseName}.edited.code-workspace`;
      anchor.href = `data:application/json;charset=utf-8,${encodeURIComponent(
        contents,
      )}`;
      anchor.style.display = "none";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setCodeWorkspaceExportState("downloaded");
    } catch {
      setCodeWorkspaceExportState("error");
    }
  };

  const continueFromSource = (event: FormEvent) => {
    event.preventDefault();
    analyzeSource();
  };

  const updateRepo = (key: string, patch: Partial<RepoEvidence>) => {
    setRepositoryBaseNotice(null);
    setRepos((current) =>
      current.map((repo) => (repo.key === key ? { ...repo, ...patch } : repo)),
    );
  };

  const openRepositoryBase = async (
    repo: RepoEvidence,
    target: RepositoryForgeTarget,
  ) => {
    if (!repo.repositoryId || openingRepositoryBaseKey) return;
    const requestedBase = repo.base;
    const requestGeneration = ++repositoryBaseOpenGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setOpeningRepositoryBaseKey(repo.key);
    setRepositoryBaseNotice({
      kind: "opening",
      message: `Resolving ${repo.id} at ${requestedBase} locally, then opening ${forgeDisplayName(target.forge)}…`,
    });
    try {
      const result = await requestClient.openRepositoryBase(
        repo.repositoryId,
        requestedBase,
      );
      if (
        requestGeneration !== repositoryBaseOpenGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (
        result.repositoryId !== repo.repositoryId ||
        result.baseRef !== requestedBase ||
        result.forge !== target.forge ||
        result.host !== target.host ||
        !result.accepted
      ) {
        throw new Error("WTS returned a mismatched repository base handoff.");
      }
      setRepositoryBaseNotice({
        kind: "success",
        message: `Browser handoff accepted for ${repo.id} at ${requestedBase} (${result.commitOid.slice(0, 12)}) on ${forgeDisplayName(target.forge)}.`,
      });
    } catch (error) {
      if (
        requestGeneration !== repositoryBaseOpenGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setRepositoryBaseNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The selected repository base could not be opened.",
      });
    } finally {
      if (
        requestGeneration === repositoryBaseOpenGenerationRef.current &&
        sessionGeneration === dialogSessionGenerationRef.current &&
        requestClient === currentClientRef.current
      ) {
        setOpeningRepositoryBaseKey("");
      }
    }
  };

  const refreshRepositoryBranches = async (repo: RepoEvidence) => {
    if (!repo.repositoryId || refreshingRepositoryId) return;
    const repositoryId = repo.repositoryId;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setRefreshingRepositoryId(repositoryId);
    setRepositoryBaseNotice({
      kind: "opening",
      message: `Fetching current branches for ${repo.id} from origin…`,
    });
    try {
      const repository =
        await requestClient.refreshRepositoryBranches(repositoryId);
      if (
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setRefreshedRepositories((current) => [
        ...current.filter((candidate) => candidate.id !== repository.id),
        repository,
      ]);
      const count = repository.availableBranches?.length ?? 0;
      setRepositoryBaseNotice({
        kind: "success",
        message: `Fetched ${count} ${count === 1 ? "branch" : "branches"} for ${repo.id}. Choose the base you want to pin.`,
      });
    } catch (error) {
      if (
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      setRepositoryBaseNotice({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : `Could not refresh branches for ${repo.id}.`,
      });
    } finally {
      if (
        sessionGeneration === dialogSessionGenerationRef.current &&
        requestClient === currentClientRef.current
      ) {
        setRefreshingRepositoryId("");
      }
    }
  };

  const analyzeRuntime = async (retry = false) => {
    if (!included.length) return;
    const request = runtimeAnalysisRequest;
    const fingerprint = currentRuntimeFingerprint;
    if (!request) {
      runtimeAnalysisGenerationRef.current += 1;
      setRuntimeAnalysisFingerprint(fingerprint);
      setRuntimeAnalysis(null);
      setRuntimeServiceDrafts(new Map());
      setRuntimeAnalysisError(
        `WTS needs one trusted local repository match for ${
          runtimeAnalysisPreparation.unresolvedLabels.length === 1
            ? runtimeAnalysisPreparation.unresolvedLabels[0]
            : runtimeAnalysisPreparation.unresolvedLabels.join(", ")
        } before it can inspect code. Refresh repository discovery or continue without services.`,
      );
      setRuntimeAnalysisState("error");
      return;
    }
    if (!retry) {
      if (
        runtimeAnalysisFingerprint === fingerprint &&
        runtimeAnalysisState !== "idle"
      ) {
        return;
      }
      const cached = runtimeAnalysisCacheRef.current.get(fingerprint);
      if (cached) {
        setRuntimeAnalysis(cached);
        setRuntimeAnalysisFingerprint(fingerprint);
        setRuntimeServiceDrafts(runtimeDraftsFromAnalysis(cached));
        setRuntimeAnalysisError("");
        setRuntimeAnalysisState("ready");
        return;
      }
    }

    const requestGeneration = ++runtimeAnalysisGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    setRuntimeAnalysisFingerprint(fingerprint);
    setRuntimeAnalysis(null);
    setRuntimeServiceDrafts(new Map());
    setRuntimeAnalysisError("");
    setRuntimeAnalysisState("loading");
    try {
      const result = await requestClient.analyzeWorkspaceRuntime(request);
      if (
        requestGeneration !== runtimeAnalysisGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      runtimeAnalysisCacheRef.current.set(fingerprint, result);
      if (fingerprint !== currentRuntimeFingerprintRef.current) return;
      setRuntimeAnalysis(result);
      setRuntimeServiceDrafts(runtimeDraftsFromAnalysis(result));
      setRuntimeAnalysisError("");
      setRuntimeAnalysisState("ready");
    } catch (error) {
      if (
        requestGeneration !== runtimeAnalysisGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current ||
        fingerprint !== currentRuntimeFingerprintRef.current
      ) {
        return;
      }
      setRuntimeAnalysisError(
        error instanceof WorkspaceClientError
          ? `${error.message} (${error.code})`
          : error instanceof Error
            ? error.message
            : "WTS could not analyze the selected repository bases.",
      );
      setRuntimeAnalysisState("error");
    }
  };

  const setRuntimeServiceIncluded = (
    candidateId: string,
    included: boolean,
  ) => {
    setRuntimeServiceDrafts((current) => {
      const next = new Map(current);
      const draft = next.get(candidateId);
      if (!draft) return current;
      next.set(candidateId, { ...draft, included });
      return next;
    });
  };

  const updateRuntimePort = (
    candidateId: string,
    portId: string,
    update: Partial<Pick<RuntimePortDraft, "preferredPort" | "policy">>,
  ) => {
    setRuntimeServiceDrafts((current) => {
      const next = new Map(current);
      const draft = next.get(candidateId);
      if (!draft) return current;
      next.set(candidateId, {
        ...draft,
        ports: draft.ports.map((port) =>
          port.portId === portId ? { ...port, ...update } : port,
        ),
      });
      return next;
    });
  };

  const selectedRuntimeServices =
    runtimeAnalysis?.services.filter(
      (service) => runtimeServiceDrafts.get(service.candidateId)?.included,
    ) ?? [];
  const runtimePortErrors = selectedRuntimeServices.flatMap((service) => {
    const draft = runtimeServiceDrafts.get(service.candidateId);
    return (
      draft?.ports
        .filter((port) => validRuntimePort(port.preferredPort) === null)
        .map((port) => `${service.displayName} · ${port.portId}`) ?? []
    );
  });
  const runtimeSelection: RuntimePlanSelection | undefined =
    runtimeAnalysisState === "ready" &&
    runtimeAnalysis &&
    runtimeAnalysisFingerprint === currentRuntimeFingerprint &&
    selectedRuntimeServices.length > 0 &&
    runtimePortErrors.length === 0
      ? {
          analysisDigest: runtimeAnalysis.analysisDigest,
          services: selectedRuntimeServices.map((service) => {
            const draft = runtimeServiceDrafts.get(service.candidateId)!;
            return {
              candidateId: service.candidateId,
              ports: draft.ports.map((port) => ({
                portId: port.portId,
                preferredPort: validRuntimePort(port.preferredPort)!,
                policy: port.policy,
              })),
            };
          }),
        }
      : undefined;

  const createRequest = (): CreateWorkspaceRequest => ({
    intent:
      isRevisionMode && templateWorkspace
        ? templateWorkspace.intent
        : sourceMode === "issue" && issueProvider === "jira"
          ? { type: "jira", issueKey: draftKey }
          : sourceMode === "issue" && openProjectImport !== null
            ? {
                type: "openProject",
                workPackageId: openProjectImport.workPackageId,
                displayId: openProjectImport.displayId,
              }
            : { type: "repositorySet", label: draftKey },
    title: draftTitle,
    preferredProvider: providerToRequest[provider],
    repositories:
      runtimeAnalysisPreparation.request?.repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        label: repository.label,
        baseRef: repository.baseRef,
      })) ??
      included.map((repository) => ({
        ...(repository.repositoryId === undefined
          ? {}
          : { repositoryId: repository.repositoryId }),
        label: repository.id,
        baseRef: repository.base,
      })),
    ...(runtimeSelection === undefined ? {} : { runtime: runtimeSelection }),
    ...(planningEnabled
      ? {
          planning: {
            folder: planningFolder,
            format: planningFormat,
          },
        }
      : {}),
  });

  const savePlan = async () => {
    if (!included.length) return;
    const request = createRequest();
    const requestFingerprint = JSON.stringify(request);
    if (
      !idempotencyKeyRef.current ||
      idempotencyRequestRef.current !== requestFingerprint
    ) {
      idempotencyKeyRef.current = newIdempotencyKey();
      idempotencyRequestRef.current = requestFingerprint;
    }
    const requestGeneration = ++saveGenerationRef.current;
    const sessionGeneration = dialogSessionGenerationRef.current;
    const requestClient = client;
    activeSaveRef.current = true;
    setSaveError("");
    setSaveWarning("");
    setStep("saving");
    try {
      const result = await requestClient.createWorkspace(
        request,
        idempotencyKeyRef.current,
      );
      if (
        requestGeneration !== saveGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      if (
        isRevisionMode &&
        templateWorkspace &&
        (result.workspace.workspaceId === templateWorkspace.id ||
          !workspaceIntentMatches(result.workspace.intent, request.intent))
      ) {
        throw new Error(
          "WTS did not return a separate revised workspace. The original plan remains unchanged; review the request and retry.",
        );
      }
      activeSaveRef.current = false;
      setSavedWorkspace(result.workspace);
      setStep("saved");
    } catch (error) {
      if (
        requestGeneration !== saveGenerationRef.current ||
        sessionGeneration !== dialogSessionGenerationRef.current ||
        requestClient !== currentClientRef.current
      ) {
        return;
      }
      activeSaveRef.current = false;
      setSaveError(
        error instanceof Error
          ? error.message
          : "The local workspace registry could not save this plan.",
      );
    }
  };

  const stopWaitingForSave = () => {
    if (!activeSaveRef.current) return;
    saveGenerationRef.current += 1;
    activeSaveRef.current = false;
    setSaveError("");
    setSaveWarning(
      "WTS stopped waiting, but the original save may still complete. Retry from this dialog to reconcile it with the same request identity.",
    );
    setStep("manifest");
  };

  const saveIsPending = step === "saving" && !saveError;
  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && activeSaveRef.current) return;
    if (!nextOpen) {
      dialogSessionGenerationRef.current += 1;
      sourceImportGenerationRef.current += 1;
      codeWorkspaceImportIdRef.current = null;
      repositoryBaseOpenGenerationRef.current += 1;
      saveGenerationRef.current += 1;
      activeSaveRef.current = false;
    }
    onOpenChange(nextOpen);
  };

  const dialogHeading =
    step === "saved"
      ? isRevisionMode
        ? "Revised plan saved"
        : "Workspace plan saved"
      : step === "saving"
        ? saveError
          ? "Save needs attention"
          : isRevisionMode
            ? "Saving revised plan"
            : "Saving workspace plan"
        : isRevisionMode
          ? `Revise ${templateWorkspace?.key ?? "workspace"}`
          : "New workspace";
  const dialogStepDescription =
    step === "source"
      ? isRevisionMode
        ? `Create a separate plan from ${templateWorkspace?.key ?? "this workspace"}. The original workspace is retained.`
        : "Start from an issue, a saved workspace, or repositories you already know. Saved workspaces are WTS plans, and you can also import a VS Code workspace file."
      : step === "evidence"
        ? isRevisionMode
          ? "Adjust the copied repository requests and base branches for the revised plan."
          : "Confirm the repository requests and their base branches."
        : step === "services"
          ? "Review the services and preferred ports WTS found at the selected base commits."
          : step === "manifest"
            ? isRevisionMode
              ? "Review the separate revised plan. The original workspace remains unchanged."
              : "Review the durable plan. No Git or process effects happen yet."
            : step === "saving"
              ? saveError
                ? "WTS could not confirm the registry write. Retry safely with the same request identity, or go back and review the plan."
                : isRevisionMode
                  ? "Saving a separate revised plan to your local workspace registry."
                  : "Saving the plan to your local workspace registry."
              : isRevisionMode
                ? `The revised plan is saved separately at ${savedWorkspace?.workspaceDisplayPath}.`
                : `The plan is saved at ${savedWorkspace?.workspaceDisplayPath}.`;
  const progressLabels = isRevisionMode
    ? ["Original", "Repositories", "Services", "Revised plan", "Save"]
    : ["Source", "Repositories", "Services", "Plan", "Save"];
  const sourceReviewIsCurrent =
    repos.length > 0 &&
    reviewedSourceRepositoriesFingerprintRef.current ===
      sourceRepositoriesFingerprint;
  const runtimeReviewIsCurrent =
    runtimeAnalysisState === "ready" &&
    runtimeAnalysisFingerprint === currentRuntimeFingerprint &&
    runtimePortErrors.length === 0;
  const canRevisitProgressStep = (index: number) => {
    if (index === 0) return true;
    if (index === 1) return sourceReviewIsCurrent;
    if (index === 2) return sourceReviewIsCurrent && included.length > 0;
    return (
      sourceReviewIsCurrent &&
      included.length > 0 &&
      (runtimeReviewIsCurrent || runtimeAnalysisState === "error")
    );
  };
  const revisitProgressStep = (index: number) => {
    const target = (["source", "evidence", "services", "manifest"] as const)[
      index
    ];
    if (!target || !canRevisitProgressStep(index)) return;
    setStep(target);
    if (target === "services" && runtimeAnalysisState === "idle") {
      void analyzeRuntime();
    }
  };
  const handleSourceChoiceKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ) => {
    const grid = event.currentTarget.closest<HTMLElement>(
      "[data-source-choice-grid]",
    );
    if (grid) {
      moveCompositeFocus(grid, event, "input[type='radio']", 2, true);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleDialogOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.dialogOverlay} />
        <Dialog.Content
          className={`${styles.portalSurface} ${styles.createDialog}`}
          data-ui="workspace-create.dialog"
          data-ui-label="New workspace dialog"
          aria-describedby="new-workspace-description"
          onEscapeKeyDown={(event) => {
            if (saveIsPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (saveIsPending) event.preventDefault();
          }}
        >
          <div
            className={styles.dialogHeader}
            data-ui="workspace-create.header"
            data-ui-label="New workspace heading"
          >
            <div>
              <span className={styles.dialogEyebrow}>
                {isRevisionMode ? "REVISED WORKSPACE PLAN" : "LOCAL WORKSPACE"}
              </span>
              <Dialog.Title
                className={styles.dialogTitle}
                ref={stepHeadingRef}
                tabIndex={-1}
              >
                {dialogHeading}
              </Dialog.Title>
              <Dialog.Description
                className={styles.dialogDescription}
                id="new-workspace-description"
              >
                {dialogStepDescription}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className={styles.iconButton}
              aria-label="Close new workspace"
              disabled={saveIsPending}
            >
              <Glyph name="close" />
            </Dialog.Close>
          </div>

          <ol
            className={styles.stepper}
            data-ui="workspace-create.progress"
            data-ui-label="Workspace setup steps"
            aria-label="Workspace creation progress"
            onKeyDownCapture={(event) =>
              moveCompositeFocus(event.currentTarget, event, `.${styles.stepButton}`, 5)
            }
          >
            {progressLabels.map((label, index) => (
              <li
                key={label}
                data-active={index + 1 === stepNumber}
                data-complete={index + 1 < stepNumber}
                aria-current={index + 1 === stepNumber ? "step" : undefined}
              >
                {index + 1 <= furthestReviewStepNumber &&
                index + 1 !== stepNumber &&
                step !== "saving" &&
                step !== "saved" &&
                index < 4 ? (
                  <button
                    className={styles.stepButton}
                    disabled={!canRevisitProgressStep(index)}
                    onClick={() => revisitProgressStep(index)}
                    type="button"
                  >
                    <span className={styles.stepMarker}>
                      <Glyph name="check" size={13} />
                    </span>
                    <span className={styles.stepLabel}>{label}</span>
                  </button>
                ) : (
                  <span className={styles.stepItem}>
                    <span className={styles.stepMarker}>
                      {index + 1 < stepNumber ? (
                        <Glyph name="check" size={13} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span className={styles.stepLabel}>{label}</span>
                  </span>
                )}
              </li>
            ))}
          </ol>

          <div
            className={styles.dialogBody}
            data-ui="workspace-create.content"
            data-ui-label="Workspace setup content"
            data-workspace-dialog-body
            key={step}
          >
            {step === "source" && (
              <form
                className={styles.sourceForm}
                data-ui="workspace-create.source"
                data-ui-label="Workspace source"
                onSubmit={continueFromSource}
              >
                {!isRevisionMode && (
                  <RadioGroup
                    className={styles.sourceChoices}
                    data-source-choice-grid
                    value={sourceMode}
                    onChange={(value) => {
                      const next = value as SourceMode;
                      sourceImportGenerationRef.current += 1;
                      repositoryEditRevisionRef.current += 1;
                      autoSuggestedRepositoriesRef.current = null;
                      setSourceMode(next);
                      setSourceValue("");
                      setTemplateWorkspaceId("");
                      setIssueRepositories("");
                      setIssueRepositoryLocalMatches({});
                      setIssueRepositoryShowAllRemotes({});
                      setJiraImport(null);
                      setOpenProjectImport(null);
                      setSourceImportState("idle");
                      setSourceImportMessage("");
                      setCodeWorkspaceImport(null);
                      codeWorkspaceImportIdRef.current = null;
                      setCodeWorkspaceImportState("idle");
                      setCodeWorkspaceImportMessage("");
                      setCodeWorkspaceTitle("");
                      setCodeWorkspaceAddedRepositoryIds([]);
                      setCodeWorkspaceRepositoryToAdd("");
                      setCodeWorkspaceExportState("idle");
                      setCodeWorkspaceDiagnosticsCopyState("idle");
                      setRepos([]);
                      setRepositoryBaseNotice(null);
                      setProvider(
                        next === "codeWorkspace" ? "VS Code" : "Codex",
                      );
                    }}
                    aria-label="Workspace source"
                  >
                    <Radio
                      value="issue"
                      className={styles.sourceChoice}
                      onKeyDown={handleSourceChoiceKeyDown}
                    >
                      <span className={styles.radioIndicator} />
                      <span className={styles.sourceIcon} data-source="issue">
                        <Glyph name="issue" size={18} />
                      </span>
                      <span>
                        <strong>Issue</strong>
                        <small>Import context and infer repository scope</small>
                      </span>
                    </Radio>
                    <Radio
                      value="workspace"
                      className={styles.sourceChoice}
                      onKeyDown={handleSourceChoiceKeyDown}
                    >
                      <span className={styles.radioIndicator} />
                      <span
                        className={styles.sourceIcon}
                        data-source="workspace"
                      >
                        <Glyph name="copy" size={18} />
                      </span>
                      <span>
                        <strong>Saved WTS plan</strong>
                        <small>Copy repository and base-ref requests</small>
                      </span>
                    </Radio>
                    <Radio
                      value="set"
                      className={styles.sourceChoice}
                      onKeyDown={handleSourceChoiceKeyDown}
                    >
                      <span className={styles.radioIndicator} />
                      <span className={styles.sourceIcon}>
                        <Glyph name="folder" size={18} />
                      </span>
                      <span>
                        <strong>Repositories</strong>
                        <small>Choose local repositories directly</small>
                      </span>
                    </Radio>
                    <Radio
                      value="codeWorkspace"
                      className={styles.sourceChoice}
                      onKeyDown={handleSourceChoiceKeyDown}
                    >
                      <span className={styles.radioIndicator} />
                      <span
                        className={styles.sourceIcon}
                        data-source="codeWorkspace"
                      >
                        <Glyph name="file" size={18} />
                      </span>
                      <span>
                        <strong>VS Code workspace file</strong>
                        <small>Import folders from .code-workspace</small>
                      </span>
                    </Radio>
                  </RadioGroup>
                )}
                {isIssueSource && (
                  <div className={styles.issueProviderField}>
                    <span>Issue provider</span>
                    <div
                      className={styles.issueProviderSelector}
                      role="radiogroup"
                      aria-label="Issue provider"
                      onKeyDownCapture={(event) =>
                        moveCompositeFocus(event.currentTarget, event, "[role='radio']", 2, true)
                      }
                    >
                      {(
                        [
                          ["jira", "Jira", "jira"],
                          ["openProject", "OpenProject", "openProject"],
                        ] as const
                      ).map(([id, label, glyph]) => (
                        <button
                          aria-checked={issueProvider === id}
                          data-selected={issueProvider === id || undefined}
                          key={id}
                          role="radio"
                          tabIndex={issueProvider === id ? 0 : -1}
                          onClick={() => {
                            if (issueProvider === id) return;
                            sourceImportGenerationRef.current += 1;
                            repositoryEditRevisionRef.current += 1;
                            autoSuggestedRepositoriesRef.current = null;
                            setIssueProvider(id);
                            setSourceValue("");
                            setIssueRepositories("");
                            setJiraImport(null);
                            setOpenProjectImport(null);
                            setSourceImportState("idle");
                            setSourceImportMessage("");
                            setRepos([]);
                            setRepositoryBaseNotice(null);
                          }}
                          type="button"
                        >
                          <Glyph name={glyph} size={14} />
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {isWorkspaceSource ? (
                  <div className={styles.field}>
                    <Label>
                      {isRevisionMode
                        ? "Original workspace"
                        : "Saved plan to copy"}
                    </Label>
                    {!isRevisionMode && (
                      <div className={styles.inputWithIcon}>
                        <Glyph name="copy" size={17} />
                        <SelectMenu
                          autoFocus
                          aria-label="Saved plan to copy"
                          disabled={!workspaces.length}
                          value={templateWorkspaceId}
                          onChange={(workspaceId) => {
                            const template = workspaces.find(
                              (workspace) => workspace.id === workspaceId,
                            );
                            setTemplateWorkspaceId(workspaceId);
                            setProvider(template?.provider ?? "Codex");
                            setPlanningEnabled(
                              template?.planning !== undefined,
                            );
                            setPlanningFolder(
                              template?.planning?.folder ?? "plansAndKanban",
                            );
                            setPlanningFormat(
                              template?.planning?.format ?? "kanban",
                            );
                            setRepos([]);
                          }}
                        >
                          <option value="">Choose a saved WTS plan…</option>
                          {workspaces.map((workspace) => (
                            <option key={workspace.id} value={workspace.id}>
                              {workspace.key} · {workspace.title}
                            </option>
                          ))}
                        </SelectMenu>
                      </div>
                    )}
                    <small>
                      {isRevisionMode
                        ? "This fixed source supplies the intent, repository requests, base refs, and preferred provider for a separate revised plan."
                        : "Copy the saved repository requests, base refs, and preferred provider into a fresh plan. This is a WTS plan, not a VS Code file."}
                    </small>
                    {!isRevisionMode && !workspaces.length && (
                      <p className={styles.templateEmpty}>
                        No saved WTS plans yet. Start from an issue, a
                        repositories, or a VS Code workspace file first.
                      </p>
                    )}
                    {isRevisionMode && !templateWorkspace && (
                      <p className={styles.templateEmpty} role="alert">
                        The original workspace is no longer available. Close
                        this dialog, refresh Spaces, and start the
                        revision again.
                      </p>
                    )}
                    {templateWorkspace && (
                      <>
                        <div
                          className={styles.templatePreview}
                          data-revision={isRevisionMode || undefined}
                        >
                          <span className={styles.templateIdentity}>
                            <span className={styles.providerMark}>
                              {providerMarks[templateWorkspace.provider]}
                            </span>
                            <span>
                              <b>{templateWorkspace.key}</b>
                              <strong>{templateWorkspace.title}</strong>
                            </span>
                          </span>
                          <span className={styles.templateFacts}>
                            <span>
                              {templateWorkspace.repos}{" "}
                              {templateWorkspace.repos === 1 ? "repo" : "repos"}
                            </span>
                            <span>{templateWorkspace.provider}</span>
                            <code>{templateWorkspace.path}</code>
                          </span>
                          <span className={styles.templateRepositories}>
                            {templateWorkspace.repositoryPlans.map(
                              (repository) => (
                                <code
                                  key={repositoryEvidenceKey(
                                    repository.repositoryId,
                                    repository.label,
                                  )}
                                >
                                  {repository.label} ← {repository.baseRef}
                                </code>
                              ),
                            )}
                          </span>
                        </div>
                        <p
                          className={styles.templateNote}
                          data-revision={isRevisionMode || undefined}
                        >
                          <Glyph name="copy" size={14} />
                          <span>
                            {isRevisionMode && <b>Original retained</b>}
                            {isRevisionMode
                              ? `${templateWorkspace.key} and its existing worktrees, branches, changes, and sessions remain untouched. WTS will save a separate plan with its own path.`
                              : "This copies the plan—not branches, uncommitted changes, agent history, or running processes."}
                          </span>
                        </p>
                        {isRevisionMode && (
                          <div className={styles.revisionTitleField}>
                            <Label>New plan title</Label>
                            <div className={styles.inputWithIcon}>
                              <Glyph name="file" size={17} />
                              <Input
                                aria-label="New plan title"
                                autoFocus
                                maxLength={240}
                                required
                                value={revisionTitle}
                                onChange={(event) =>
                                  setRevisionTitle(event.target.value)
                                }
                              />
                            </div>
                            <small>
                              Required · up to 240 characters. The original
                              title remains unchanged.
                            </small>
                          </div>
                        )}
                        <section
                          aria-labelledby="copied-plan-repositories-title"
                          className={styles.workspaceFolderEditor}
                          data-ui="workspace-create.copy-repositories"
                          data-ui-label="Copied plan repositories"
                        >
                          <header>
                            <span><Glyph name="folder" size={15} /></span>
                            <div>
                              <h4 id="copied-plan-repositories-title">
                                Add repositories
                              </h4>
                              <small>
                                Extend this copied plan before WTS saves it.
                              </small>
                            </div>
                            <b>
                              {templateWorkspace.repositoryPlans.length +
                                addedCodeWorkspaceRepositories.length}{" "}
                              IN PLAN
                            </b>
                          </header>
                          <Tabs.Root
                            onValueChange={(value) => {
                              setCodeWorkspaceRepositoryAddMode(
                                value as CodeWorkspaceRepositoryAddMode,
                              );
                              setCodeWorkspaceCloneState("idle");
                              setCodeWorkspaceCloneMessage("");
                            }}
                            value={codeWorkspaceRepositoryAddMode}
                          >
                            <Tabs.List
                              aria-label="Additional repository source"
                              className={styles.repositoryAddModes}
                            >
                              <Tabs.Trigger
                                disabled={codeWorkspaceCloneState === "loading"}
                                value="existing"
                              >
                                Existing local
                              </Tabs.Trigger>
                              <Tabs.Trigger
                                disabled={codeWorkspaceCloneState === "loading"}
                                value="clone"
                              >
                                Clone Git URL
                              </Tabs.Trigger>
                            </Tabs.List>
                            <Tabs.Content value="existing">
                              <div className={styles.repositoryClonePanel}>
                                <div className={styles.workspaceFolderPicker}>
                                  <label>
                                    <span>Local repository</span>
                                    <SelectMenu
                                      aria-label="Repository to add to copied plan"
                                      disabled={
                                        availableCodeWorkspaceRepositories.length ===
                                        0
                                      }
                                      onChange={setCodeWorkspaceRepositoryToAdd}
                                      value={codeWorkspaceRepositoryToAdd}
                                    >
                                      <option value="">
                                        {availableCodeWorkspaceRepositories.length
                                          ? "Choose a discovered repository…"
                                          : "No more discovered repositories"}
                                      </option>
                                      {availableCodeWorkspaceRepositories.map(
                                        (repository) => (
                                          <option
                                            key={repository.id}
                                            value={repository.id}
                                          >
                                            {repository.label} ·{" "}
                                            {repository.displayPath}
                                          </option>
                                        ),
                                      )}
                                    </SelectMenu>
                                  </label>
                                  <button
                                    className={styles.addWorkspaceFolderButton}
                                    disabled={!codeWorkspaceRepositoryToAdd}
                                    onClick={addCodeWorkspaceRepository}
                                    type="button"
                                  >
                                    <Glyph name="plus" size={13} />
                                    Add repository
                                  </button>
                                </div>
                              </div>
                            </Tabs.Content>
                            <Tabs.Content value="clone">
                              <div className={styles.repositoryClonePanel}>
                                <div className={styles.workspaceFolderPicker}>
                                  <label>
                                    <span>Git repository URL</span>
                                    <input
                                      aria-describedby="copied-plan-clone-help"
                                      autoComplete="off"
                                      onChange={(event) => {
                                        setCodeWorkspaceCloneUrl(
                                          event.target.value,
                                        );
                                        setCodeWorkspaceCloneState("idle");
                                        setCodeWorkspaceCloneMessage("");
                                      }}
                                      placeholder="https://host/team/repo.git or git@host:team/repo.git"
                                      spellCheck={false}
                                      type="text"
                                      value={codeWorkspaceCloneUrl}
                                    />
                                  </label>
                                  <button
                                    className={styles.addWorkspaceFolderButton}
                                    disabled={
                                      !codeWorkspaceCloneLeaf ||
                                      codeWorkspaceCloneState === "loading"
                                    }
                                    onClick={() =>
                                      void cloneCodeWorkspaceRepository()
                                    }
                                    type="button"
                                  >
                                    <Glyph
                                      name={
                                        codeWorkspaceCloneState === "loading"
                                          ? "refresh"
                                          : "plus"
                                      }
                                      size={13}
                                    />
                                    {codeWorkspaceCloneState === "loading"
                                      ? "Cloning…"
                                      : "Clone and add"}
                                  </button>
                                </div>
                                <div
                                  className={styles.repositoryCloneHelp}
                                  id="copied-plan-clone-help"
                                >
                                  <span>
                                    {codeWorkspaceCloneTarget ? (
                                      <>Clone target <code>{codeWorkspaceCloneTarget}</code></>
                                    ) : (
                                      "Paste an HTTPS or SSH Git URL to preview its local destination."
                                    )}
                                  </span>
                                  <small>
                                    Git uses your credential helper or SSH agent.
                                    WTS does not store credentials.
                                  </small>
                                </div>
                                {codeWorkspaceCloneMessage && (
                                  <p
                                    className={styles.repositoryCloneStatus}
                                    data-error={
                                      codeWorkspaceCloneState === "error" ||
                                      undefined
                                    }
                                    role={
                                      codeWorkspaceCloneState === "error"
                                        ? "alert"
                                        : "status"
                                    }
                                  >
                                    {codeWorkspaceCloneMessage}
                                  </p>
                                )}
                              </div>
                            </Tabs.Content>
                          </Tabs.Root>
                          {addedCodeWorkspaceRepositories.length > 0 && (
                            <div
                              aria-label="Additional repositories in copied plan"
                              className={styles.addedWorkspaceFolders}
                              role="list"
                            >
                              {addedCodeWorkspaceRepositories.map(
                                (repository) => (
                                  <div key={repository.id} role="listitem">
                                    <span>
                                      <b>{repository.label}</b>
                                      <code>{repository.displayPath}</code>
                                    </span>
                                    <small>
                                      Base {repository.defaultBranch.name}
                                    </small>
                                    <button
                                      aria-label={`Remove ${repository.label} from copied plan`}
                                      onClick={() =>
                                        removeCodeWorkspaceRepository(
                                          repository.id,
                                        )
                                      }
                                      type="button"
                                    >
                                      <Glyph name="close" size={12} />
                                    </button>
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                        </section>
                      </>
                    )}
                  </div>
                ) : isCodeWorkspaceSource ? (
                  <div className={styles.fileImportField}>
                    <div className={styles.fileImportHeading}>
                      <span>
                        <b>Bring in an existing VS Code workspace</b>
                        <small>
                          WTS finds local Git sources under your trusted
                          repository roots, including nested checkouts.
                        </small>
                      </span>
                      <span className={styles.fileLimitBadge}>MAX 48 KiB</span>
                    </div>
                    <label htmlFor="code-workspace-file-input">
                      VS Code workspace file
                    </label>
                    <input
                      accept=".code-workspace,application/json"
                      aria-describedby="code-workspace-file-help code-workspace-file-status"
                      className={styles.fileInput}
                      id="code-workspace-file-input"
                      onChange={(event) =>
                        void importCodeWorkspaceFile(event.currentTarget)
                      }
                      type="file"
                    />
                    <p
                      className={styles.fileImportHelp}
                      id="code-workspace-file-help"
                    >
                      Choose one <code>.code-workspace</code> file, up to 48
                      KiB. WTS reads it once and treats its folder paths as
                      lookup hints for a bounded search under your trusted
                      repository roots. The file and existing checkouts are
                      never changed.
                    </p>
                    <div
                      aria-live={
                        codeWorkspaceImportState === "error"
                          ? "assertive"
                          : "polite"
                      }
                      className={styles.fileImportStatus}
                      data-state={codeWorkspaceImportState}
                      data-warning={
                        codeWorkspaceImportState === "ready" &&
                        codeWorkspaceImport?.repositories.length === 0
                          ? true
                          : undefined
                      }
                      id="code-workspace-file-status"
                      role={
                        codeWorkspaceImportState === "error"
                          ? "alert"
                          : "status"
                      }
                    >
                      <Glyph
                        name={
                          codeWorkspaceImportState === "error" ||
                          (codeWorkspaceImportState === "ready" &&
                            codeWorkspaceImport?.repositories.length === 0)
                            ? "warning"
                            : codeWorkspaceImportState === "loading"
                              ? "refresh"
                              : codeWorkspaceImportState === "ready"
                                ? "check"
                                : "file"
                        }
                        size={15}
                      />
                      <span>
                        {codeWorkspaceImportMessage ||
                          "No file selected. Your VS Code configuration remains untouched."}
                      </span>
                    </div>

                    {codeWorkspaceImport && (
                      <section
                        aria-label={`Import preview for ${codeWorkspaceImport.fileName}`}
                        className={styles.fileImportPreview}
                        data-ui="workspace-create.import-preview"
                        data-ui-label="Workspace import preview"
                      >
                        <header>
                          <span>
                            <Glyph name="file" size={17} />
                          </span>
                          <div>
                            <b>{codeWorkspaceImport.fileName}</b>
                            <small>
                              {codeWorkspaceImport.repositories.length} matched{" "}
                              {codeWorkspaceImport.repositories.length === 1
                                ? "repository"
                                : "repositories"}{" "}
                              · {codeWorkspaceImport.folders.length}{" "}
                              {codeWorkspaceImport.folders.length === 1
                                ? "folder"
                                : "folders"}{" "}
                              inspected
                            </small>
                          </div>
                          <span className={styles.fileReadyBadge}>
                            READ ONCE
                          </span>
                        </header>

                        <div className={styles.fileTitleField}>
                          <Label>Workspace plan title</Label>
                          <div className={styles.inputWithIcon}>
                            <Glyph name="file" size={17} />
                            <Input
                              aria-label="Workspace plan title"
                              maxLength={240}
                              onChange={(event) =>
                                setCodeWorkspaceTitle(event.target.value)
                              }
                              required
                              value={codeWorkspaceTitle}
                            />
                          </div>
                          <small>
                            Suggested from the file name. You can change it
                            before saving.
                          </small>
                        </div>

                        <div
                          aria-label="Imported workspace folders"
                          className={styles.importFolderList}
                          role="list"
                        >
                          {codeWorkspaceImport.folders.map((folder, index) => (
                            <div
                              className={styles.importFolderRow}
                              data-status={folder.status}
                              key={`${folder.rawPath}-${index}`}
                              role="listitem"
                            >
                              <span className={styles.importFolderGlyph}>
                                <Glyph
                                  name={
                                    folder.status === "matched"
                                      ? "check"
                                      : "warning"
                                  }
                                  size={14}
                                />
                              </span>
                              <span className={styles.importFolderIdentity}>
                                <b>{folder.name}</b>
                                <code>{folder.rawPath}</code>
                                {folder.message && (
                                  <small>{folder.message}</small>
                                )}
                              </span>
                              <span className={styles.importFolderMatch}>
                                <b>
                                  {folder.status === "matched"
                                    ? folder.repositoryLabel
                                    : folder.status}
                                </b>
                                {folder.status === "matched" &&
                                  folder.repositoryDisplayPath && (
                                    <InfoTooltip
                                      content={`Local Git source: ${folder.repositoryDisplayPath}`}
                                    >
                                      <code tabIndex={0}>
                                        {folder.repositoryDisplayPath}
                                      </code>
                                    </InfoTooltip>
                                  )}
                                <small>
                                  {folder.status === "matched"
                                    ? folder.baseRef
                                      ? `Base ${folder.baseRef}`
                                      : "Matched locally"
                                    : "Not added to the plan"}
                                </small>
                              </span>
                            </div>
                          ))}
                        </div>

                        <section
                          aria-labelledby="workspace-folder-editor-title"
                          className={styles.workspaceFolderEditor}
                          data-ui="workspace-create.import-repositories"
                          data-ui-label="Imported repositories"
                        >
                          <header>
                            <span>
                              <Glyph name="folder" size={15} />
                            </span>
                            <div>
                              <h4 id="workspace-folder-editor-title">
                                Add repository folders
                              </h4>
                              <small>
                                Extend this WTS plan before creating its
                                isolated worktrees.
                              </small>
                            </div>
                            <b>
                              {codeWorkspaceImport.repositories.length +
                                addedCodeWorkspaceRepositories.length}{" "}
                              IN PLAN
                            </b>
                          </header>
                          <Tabs.Root
                            onValueChange={(value) => {
                              const mode =
                                value as CodeWorkspaceRepositoryAddMode;
                              setCodeWorkspaceRepositoryAddMode(mode);
                              if (mode === "clone") {
                                setCodeWorkspaceCloneState("idle");
                                setCodeWorkspaceCloneMessage("");
                              }
                            }}
                            value={codeWorkspaceRepositoryAddMode}
                          >
                            <Tabs.List
                              aria-label="Repository folder source"
                              className={styles.repositoryAddModes}
                            >
                              <Tabs.Trigger
                                disabled={codeWorkspaceCloneState === "loading"}
                                value="existing"
                              >
                                Existing local
                              </Tabs.Trigger>
                              <Tabs.Trigger
                                disabled={codeWorkspaceCloneState === "loading"}
                                value="clone"
                              >
                                Clone from URL
                              </Tabs.Trigger>
                            </Tabs.List>
                            <Tabs.Content value="existing">
                              <div className={styles.workspaceFolderPicker}>
                                <label>
                                  <span>Local repository</span>
                                  <SelectMenu
                                    aria-label="Add local repository folder"
                                    disabled={
                                      availableCodeWorkspaceRepositories.length ===
                                      0
                                    }
                                    value={codeWorkspaceRepositoryToAdd}
                                    onChange={(value) => {
                                      setCodeWorkspaceRepositoryToAdd(value);
                                      setCodeWorkspaceExportState("idle");
                                    }}
                                  >
                                    <option value="">
                                      {availableCodeWorkspaceRepositories.length
                                        ? "Choose a discovered repository…"
                                        : "No more discovered repositories"}
                                    </option>
                                    {availableCodeWorkspaceRepositories.map(
                                      (repository) => (
                                        <option
                                          key={repository.id}
                                          value={repository.id}
                                        >
                                          {repository.label} ·{" "}
                                          {repository.checkoutLeaf}
                                        </option>
                                      ),
                                    )}
                                  </SelectMenu>
                                </label>
                                <button
                                  className={styles.addWorkspaceFolderButton}
                                  disabled={!codeWorkspaceRepositoryToAdd}
                                  onClick={addCodeWorkspaceRepository}
                                  type="button"
                                >
                                  <Glyph name="plus" size={13} />
                                  Add folder
                                </button>
                              </div>
                            </Tabs.Content>
                            <Tabs.Content value="clone">
                              <div className={styles.repositoryClonePanel}>
                                <div className={styles.workspaceFolderPicker}>
                                  <label>
                                    <span>Git repository URL</span>
                                    <input
                                      aria-describedby="repository-clone-help"
                                      autoComplete="off"
                                      onChange={(event) => {
                                        setCodeWorkspaceCloneUrl(
                                          event.target.value,
                                        );
                                        setCodeWorkspaceCloneState("idle");
                                        setCodeWorkspaceCloneMessage("");
                                      }}
                                      placeholder="https://host/team/repo.git or git@host:team/repo.git"
                                      spellCheck={false}
                                      type="url"
                                      value={codeWorkspaceCloneUrl}
                                    />
                                  </label>
                                  <button
                                    className={styles.addWorkspaceFolderButton}
                                    disabled={
                                      !codeWorkspaceCloneLeaf ||
                                      codeWorkspaceCloneState === "loading"
                                    }
                                    onClick={() => {
                                      void cloneCodeWorkspaceRepository();
                                    }}
                                    type="button"
                                  >
                                    <Glyph
                                      name={
                                        codeWorkspaceCloneState === "loading"
                                          ? "refresh"
                                          : "plus"
                                      }
                                      size={13}
                                    />
                                    {codeWorkspaceCloneState === "loading"
                                      ? "Cloning…"
                                      : "Clone and add"}
                                  </button>
                                </div>
                                <div
                                  className={styles.repositoryCloneHelp}
                                  id="repository-clone-help"
                                >
                                  <span>
                                    {codeWorkspaceCloneTarget ? (
                                      <>
                                        Clone target{" "}
                                        <code>{codeWorkspaceCloneTarget}</code>
                                      </>
                                    ) : (
                                      "Paste an HTTPS or SSH Git URL to preview its local destination."
                                    )}
                                  </span>
                                  <small>
                                    Uses your Git credential helper or SSH
                                    agent. WTS does not store credentials.
                                  </small>
                                </div>
                                {codeWorkspaceCloneMessage && (
                                  <p
                                    className={styles.repositoryCloneStatus}
                                    data-error={
                                      codeWorkspaceCloneState === "error" ||
                                      undefined
                                    }
                                    role={
                                      codeWorkspaceCloneState === "error"
                                        ? "alert"
                                        : "status"
                                    }
                                  >
                                    {codeWorkspaceCloneMessage}
                                  </p>
                                )}
                              </div>
                            </Tabs.Content>
                          </Tabs.Root>
                          {addedCodeWorkspaceRepositories.length > 0 && (
                            <div
                              aria-label="Additional repository folders"
                              className={styles.addedWorkspaceFolders}
                              role="list"
                            >
                              {addedCodeWorkspaceRepositories.map(
                                (repository) => (
                                  <div key={repository.id} role="listitem">
                                    <span>
                                      <b>{repository.label}</b>
                                      <code>{repository.displayPath}</code>
                                    </span>
                                    <small>
                                      Base {repository.defaultBranch.name}
                                    </small>
                                    <button
                                      aria-label={`Remove added folder ${repository.label}`}
                                      onClick={() =>
                                        removeCodeWorkspaceRepository(
                                          repository.id,
                                        )
                                      }
                                      type="button"
                                    >
                                      <Glyph name="close" size={12} />
                                    </button>
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                          <footer>
                            <span>
                              <b>Edit the VS Code file too?</b>
                              <small>
                                Download a folder-only copy with these
                                additions. Settings, tasks, comments, and the
                                original file stay untouched.
                              </small>
                            </span>
                            <button
                              className={styles.downloadWorkspaceCopyButton}
                              disabled={
                                addedCodeWorkspaceRepositories.length === 0
                              }
                              onClick={downloadEditedCodeWorkspace}
                              type="button"
                            >
                              <Glyph name="file" size={13} />
                              Download edited copy
                            </button>
                          </footer>
                          {codeWorkspaceExportState !== "idle" && (
                            <p
                              className={styles.workspaceFolderExportStatus}
                              data-error={
                                codeWorkspaceExportState === "error" ||
                                undefined
                              }
                              role={
                                codeWorkspaceExportState === "error"
                                  ? "alert"
                                  : "status"
                              }
                            >
                              {codeWorkspaceExportState === "downloaded"
                                ? `Downloaded ${codeWorkspaceImport.fileName.replace(
                                    /\.code-workspace$/i,
                                    "",
                                  )}.edited.code-workspace.`
                                : "The edited workspace copy could not be downloaded."}
                            </p>
                          )}
                        </section>

                        {codeWorkspaceImport.warnings.length > 0 && (
                          <div className={styles.fileWarnings}>
                            <b>Import notes</b>
                            <ul>
                              {codeWorkspaceImport.warnings.map(
                                (warning, index) => (
                                  <li
                                    key={`${warning.code}-${warning.folderName ?? "general"}-${index}`}
                                  >
                                    <Glyph name="warning" size={13} />
                                    <span>{warning.message}</span>
                                  </li>
                                ),
                              )}
                            </ul>
                          </div>
                        )}
                        <CodeWorkspaceDiagnosticsPanel
                          copyState={codeWorkspaceDiagnosticsCopyState}
                          imported={codeWorkspaceImport}
                          onCopy={() => void copyCodeWorkspaceDiagnostics()}
                        />
                        <section
                          aria-labelledby="code-workspace-worktree-boundary"
                          className={styles.fileBoundaryNote}
                        >
                          <Glyph name="check" size={14} />
                          <span>
                            <h4 id="code-workspace-worktree-boundary">
                              Local source → managed worktree
                            </h4>
                            <small>
                              A matched checkout is used as the local Git
                              source. When you later create this workspace, WTS
                              adds a separate worktree under{" "}
                              <code>{workspaceRootDisplayPath}</code>. Import
                              and preflight do not fetch or edit any source
                              checkout; cloning happens only when you explicitly
                              choose Clone from URL.
                            </small>
                          </span>
                        </section>
                      </section>
                    )}
                  </div>
                ) : sourceMode === "set" ? (
                  <section
                    aria-labelledby="repository-source-title"
                    className={styles.workspaceFolderEditor}
                    data-ui="workspace-create.repositories"
                    data-ui-label="Repository selection"
                  >
                    <header>
                      <span><Glyph name="folder" size={15} /></span>
                      <div>
                        <h4 id="repository-source-title">Choose repositories</h4>
                        <small>
                          Use a discovered checkout or clone any Git repository
                          into the trusted repository root.
                        </small>
                      </div>
                      <b>{addedCodeWorkspaceRepositories.length} IN PLAN</b>
                    </header>
                    <Tabs.Root
                      onValueChange={(value) => {
                        setCodeWorkspaceRepositoryAddMode(
                          value as CodeWorkspaceRepositoryAddMode,
                        );
                        setCodeWorkspaceCloneState("idle");
                        setCodeWorkspaceCloneMessage("");
                      }}
                      value={codeWorkspaceRepositoryAddMode}
                    >
                      <Tabs.List
                        aria-label="Repository source"
                        className={styles.repositoryAddModes}
                      >
                        <Tabs.Trigger
                          disabled={codeWorkspaceCloneState === "loading"}
                          value="existing"
                        >
                          Existing local
                        </Tabs.Trigger>
                        <Tabs.Trigger
                          disabled={codeWorkspaceCloneState === "loading"}
                          value="clone"
                        >
                          Clone Git URL
                        </Tabs.Trigger>
                      </Tabs.List>
                      <Tabs.Content value="existing">
                        <div className={styles.repositoryClonePanel}>
                          <div className={styles.workspaceFolderPicker}>
                            <label>
                              <span>Local repository</span>
                              <SelectMenu
                                aria-label="Repository to add"
                                disabled={
                                  availableCodeWorkspaceRepositories.length ===
                                  0
                                }
                                onChange={setCodeWorkspaceRepositoryToAdd}
                                value={codeWorkspaceRepositoryToAdd}
                              >
                                <option value="">
                                  {availableCodeWorkspaceRepositories.length
                                    ? "Choose a discovered repository…"
                                    : "No more discovered repositories"}
                                </option>
                                {availableCodeWorkspaceRepositories.map(
                                  (repository) => (
                                    <option
                                      key={repository.id}
                                      value={repository.id}
                                    >
                                      {repository.label} ·{" "}
                                      {repository.displayPath}
                                    </option>
                                  ),
                                )}
                              </SelectMenu>
                            </label>
                            <button
                              className={styles.addWorkspaceFolderButton}
                              disabled={!codeWorkspaceRepositoryToAdd}
                              onClick={addCodeWorkspaceRepository}
                              type="button"
                            >
                              <Glyph name="plus" size={13} /> Add repository
                            </button>
                          </div>
                          <div className={styles.repositoryCloneHelp}>
                            <span>
                              WTS lists only repositories discovered under your
                              trusted repository roots.
                            </span>
                            <small>
                              A typed local path cannot expand this access. Use
                              Clone Git URL to add another repository safely.
                            </small>
                          </div>
                        </div>
                      </Tabs.Content>
                      <Tabs.Content value="clone">
                        <div className={styles.repositoryClonePanel}>
                          <div className={styles.workspaceFolderPicker}>
                            <label>
                              <span>Git repository URL</span>
                              <input
                                aria-describedby="new-workspace-repository-clone-help"
                                autoComplete="off"
                                onChange={(event) => {
                                  setCodeWorkspaceCloneUrl(event.target.value);
                                  setCodeWorkspaceCloneState("idle");
                                  setCodeWorkspaceCloneMessage("");
                                }}
                                placeholder="https://host/team/repo.git or git@host:team/repo.git"
                                spellCheck={false}
                                type="text"
                                value={codeWorkspaceCloneUrl}
                              />
                            </label>
                            <button
                              className={styles.addWorkspaceFolderButton}
                              disabled={
                                !codeWorkspaceCloneLeaf ||
                                codeWorkspaceCloneState === "loading"
                              }
                              onClick={() => void cloneCodeWorkspaceRepository()}
                              type="button"
                            >
                              <Glyph
                                name={
                                  codeWorkspaceCloneState === "loading"
                                    ? "refresh"
                                    : "plus"
                                }
                                size={13}
                              />
                              {codeWorkspaceCloneState === "loading"
                                ? "Cloning…"
                                : "Clone and add"}
                            </button>
                          </div>
                          <div
                            className={styles.repositoryCloneHelp}
                            id="new-workspace-repository-clone-help"
                          >
                            <span>
                              {codeWorkspaceCloneTarget ? (
                                <>Clone target <code>{codeWorkspaceCloneTarget}</code></>
                              ) : (
                                "Paste an HTTPS or SSH Git URL to preview its local destination."
                              )}
                            </span>
                            <small>
                              Git uses your credential helper or SSH agent. WTS
                              does not store credentials.
                            </small>
                          </div>
                          {codeWorkspaceCloneMessage && (
                            <p
                              aria-live="polite"
                              className={styles.repositoryCloneStatus}
                              data-error={
                                codeWorkspaceCloneState === "error" || undefined
                              }
                              role={
                                codeWorkspaceCloneState === "error"
                                  ? "alert"
                                  : "status"
                              }
                            >
                              {codeWorkspaceCloneMessage}
                            </p>
                          )}
                        </div>
                      </Tabs.Content>
                    </Tabs.Root>
                    {addedCodeWorkspaceRepositories.length > 0 && (
                      <div
                        aria-label="Repositories in this workspace plan"
                        className={styles.addedWorkspaceFolders}
                        role="list"
                      >
                        {addedCodeWorkspaceRepositories.map((repository) => (
                          <div key={repository.id} role="listitem">
                            <span>
                              <b>{repository.label}</b>
                              <code>{repository.displayPath}</code>
                            </span>
                            <small>Base {repository.defaultBranch.name}</small>
                            <button
                              aria-label={`Remove ${repository.label} from plan`}
                              onClick={() =>
                                removeCodeWorkspaceRepository(repository.id)
                              }
                              type="button"
                            >
                              <Glyph name="close" size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <footer>
                      <span>
                        <b>Branch selection comes next</b>
                        <small>
                          Add every repository now. You can choose a branch for
                          each repository on the next step and return here at
                          any time.
                        </small>
                      </span>
                    </footer>
                  </section>
                ) : (
                  <div className={styles.field}>
                    <Label>
                      {isIssueSource
                        ? issueProvider === "jira"
                          ? "Jira issue key or URL"
                          : "OpenProject work package"
                        : "Repositories"}
                    </Label>
                    <div className={styles.inputWithIcon}>
                      <Glyph
                        name={
                          isIssueSource
                            ? issueProvider === "jira"
                              ? "jira"
                              : "openProject"
                            : "folder"
                        }
                        size={17}
                      />
                      <Input
                        autoFocus
                        value={sourceValue}
                        onChange={(event) => {
                          sourceImportGenerationRef.current += 1;
                          setSourceValue(event.target.value);
                          setRepositoryBaseNotice(null);
                          if (
                            autoSuggestedRepositoriesRef.current !== null &&
                            issueRepositories ===
                              autoSuggestedRepositoriesRef.current
                          ) {
                            setIssueRepositories("");
                          }
                          autoSuggestedRepositoriesRef.current = null;
                          setJiraImport(null);
                          setOpenProjectImport(null);
                          setSourceImportState("idle");
                          setSourceImportMessage("");
                        }}
                        aria-label={
                          isIssueSource
                            ? issueProvider === "jira"
                              ? "Jira issue key or URL"
                              : "OpenProject work package"
                            : "Repositories"
                        }
                        placeholder={
                          isIssueSource
                            ? issueProvider === "jira"
                              ? "e.g. PLATFORM-42"
                              : "e.g. APP-42, #42, or a work package URL"
                            : "repo-a, repo-b"
                        }
                      />
                      {isIssueSource && (
                        <button
                          className={styles.inlineImportButton}
                          disabled={
                            (issueProvider === "jira"
                              ? !jiraKeyIsValid
                              : !openProjectReferenceIsValid) ||
                            sourceImportState === "loading"
                          }
                          onClick={() =>
                            void (issueProvider === "jira"
                              ? importJira()
                              : importOpenProject())
                          }
                          type="button"
                        >
                          {sourceImportState === "loading"
                            ? "Importing…"
                            : sourceImportState === "ready"
                              ? "Re-import"
                              : "Import"}
                        </button>
                      )}
                    </div>
                    <small>
                      {isIssueSource
                        ? issueProvider === "jira"
                          ? jiraKeyIsValid || !sourceValue.trim()
                            ? "Import through your connected Jira account, or continue with repositories you enter manually."
                            : "Enter a Jira key such as PLATFORM-42."
                          : openProjectReferenceIsValid || !sourceValue.trim()
                            ? openProjectImport
                              ? "Imported from OpenProject. Review the repository scope before continuing."
                              : "Import through WTS before reviewing the repository scope."
                            : "Enter APP-42, #42, or a work package URL."
                        : "These labels are matched against repositories discovered in your configured local folder."}
                    </small>
                    {sourceImportMessage && (
                      <small
                        className={styles.sourceImportMessage}
                        data-error={sourceImportState === "error" || undefined}
                        role={
                          sourceImportState === "error" ? "alert" : "status"
                        }
                      >
                        {sourceImportMessage}
                      </small>
                    )}
                  </div>
                )}
                {isIssueSource && importedIssue && (
                  <section
                    aria-labelledby="imported-issue-title"
                    className={styles.importedIssueCard}
                    data-ui="workspace-create.issue-preview"
                    data-ui-label="Issue preview"
                  >
                    <header>
                      <span>
                        <Glyph name="check" size={15} />
                        <span>
                          <h4 id="imported-issue-title">
                            Imported {importedIssue.reference}
                          </h4>
                          <small>{importedIssue.title}</small>
                        </span>
                      </span>
                      {importedIssue.status && <b>{importedIssue.status}</b>}
                    </header>
                    <div className={styles.importedIssueBody}>
                      {importedIssue.project && (
                        <small>
                          Project <b>{importedIssue.project}</b>
                        </small>
                      )}
                      <p>
                        {importedIssueContent(
                          importedIssue.content,
                          importedIssue.title,
                        )}
                      </p>
                      <section aria-label="Recommended repositories">
                        <h4>Recommended repositories</h4>
                        {importedIssue.recommendations.length > 0 ? (
                          <div role="list">
                            {importedIssue.recommendations.map(
                              (recommendation) => (
                                <div
                                  className={styles.importedRecommendation}
                                  key={recommendation.repositoryId}
                                  role="listitem"
                                >
                                  <span>
                                    <b>{recommendation.label}</b>
                                    <small>{recommendation.reason}</small>
                                  </span>
                                  <b>
                                    {recommendation.confidence >= 96
                                      ? "Strong match"
                                      : recommendation.confidence >= 90
                                        ? "Good match"
                                        : "Possible match"}
                                  </b>
                                </div>
                              ),
                            )}
                          </div>
                        ) : (
                          <p>
                            No trusted repository metadata matched this issue.
                            Choose the scope manually below.
                          </p>
                        )}
                        <small>
                          Based on local repository identity metadata. Review
                          these suggestions before continuing; no LLM was used.
                        </small>
                      </section>
                    </div>
                  </section>
                )}
                {isIssueSource && (
                  <div className={styles.field}>
                    <Label>Repositories for this plan</Label>
                    <div className={styles.inputWithIcon}>
                      <Glyph name="folder" size={17} />
                      <Input
                        value={issueRepositories}
                        onChange={(event) => {
                          repositoryEditRevisionRef.current += 1;
                          autoSuggestedRepositoriesRef.current = null;
                          setIssueRepositories(event.target.value);
                          setIssueRepositoryLocalMatches({});
                          setIssueRepositoryShowAllRemotes({});
                          setRepositoryBaseNotice(null);
                        }}
                        aria-label="Repositories for this plan"
                        placeholder="repo-a, repo-b"
                      />
                    </div>
                    <small>
                      {(
                        issueProvider === "jira"
                          ? jiraImport?.suggestedRepositories.length
                          : openProjectImport?.suggestedRepositories.length
                      )
                        ? "Suggested from the imported issue context. Review before continuing."
                        : "Choose the local repositories that belong in this issue workspace."}
                    </small>
                  </div>
                )}
                {sourceRepositoryReview.length > 0 && (
                  <section
                    aria-labelledby="source-repository-review-title"
                    className={styles.sourceRepositoryReview}
                    data-ui="workspace-create.repository-matches"
                    data-ui-label="Repository matches"
                  >
                    <header>
                      <span>
                        <Glyph name="branch" size={15} />
                        <span>
                          <h4 id="source-repository-review-title">
                            Repository identity
                          </h4>
                          <small>
                            Confirm the name and trusted remote before
                            continuing.
                          </small>
                        </span>
                      </span>
                      <b>
                        {sourceRepositoryReview.length}{" "}
                        {sourceRepositoryReview.length === 1
                          ? "REPOSITORY"
                          : "REPOSITORIES"}
                      </b>
                    </header>
                    <div
                      aria-label="Repository identity list"
                      className={styles.sourceRepositoryList}
                      role="list"
                    >
                      {sourceRepositoryReview.map(
                        ({
                          repository,
                          catalogRepository,
                          upstreamRepository,
                        }) => {
                          const remoteMatchKey =
                            repository.label.toLocaleLowerCase();
                          const allLocalRemoteChoices = (
                            effectiveRepositoryCatalog?.repositories ?? []
                          ).filter((candidate) => Boolean(candidate.originUrl));
                          const scopedLocalRemoteChoices =
                            allLocalRemoteChoices.filter((candidate) =>
                              remoteMatchesRepositoryLabel(
                                repository.label,
                                candidate,
                              ),
                            );
                          const localRemoteChoices =
                            issueRepositoryShowAllRemotes[remoteMatchKey]
                              ? allLocalRemoteChoices
                              : scopedLocalRemoteChoices;
                          const forgeTarget = repositoryForgeTarget(
                            catalogRepository?.originUrl,
                          );
                          const openingKey = repositoryEvidenceKey(
                            repository.repositoryId,
                            repository.label,
                          );
                          const opening =
                            openingRepositoryBaseKey === openingKey;
                          const defaultBase =
                            catalogRepository?.defaultBranch.name ??
                            repository.baseRef;

                          return (
                            <div
                              className={styles.sourceRepositoryRow}
                              data-resolved={
                                catalogRepository ? "true" : "false"
                              }
                              data-upstream={
                                !catalogRepository && upstreamRepository
                                  ? "true"
                                  : undefined
                              }
                              key={openingKey}
                              role="listitem"
                            >
                              <span className={styles.sourceRepositoryIdentity}>
                                <b>{repository.label}</b>
                                <InfoTooltip
                                  content={
                                    catalogRepository?.originUrl ??
                                    upstreamRepository?.remoteUrl ??
                                    "No unique repository match in the local catalog"
                                  }
                                >
                                  <code tabIndex={0}>
                                    {catalogRepository?.originUrl ??
                                      upstreamRepository?.remoteUrl ??
                                      "No unique local repository match"}
                                  </code>
                                </InfoTooltip>
                              </span>
                              <InfoTooltip content={catalogRepository?.displayPath}>
                                <span
                                  className={styles.sourceRepositoryStatus}
                                  data-resolved={
                                    catalogRepository ? "true" : "false"
                                  }
                                  data-upstream={
                                    !catalogRepository && upstreamRepository
                                      ? "true"
                                      : undefined
                                  }
                                  tabIndex={0}
                                >
                                  <Glyph
                                    name={catalogRepository ? "check" : "warning"}
                                    size={11}
                                  />
                                  {catalogRepository
                                    ? `Base ${defaultBase}`
                                    : upstreamRepository
                                      ? "Upstream found"
                                    : "Needs match"}
                                </span>
                              </InfoTooltip>
                              {!catalogRepository && localRemoteChoices.length > 0 ? (
                                <SelectMenu
                                  aria-label={`Select local remote for ${repository.label}`}
                                  className={styles.sourceRepositorySelect}
                                  onChange={(repositoryId) => {
                                    repositoryEditRevisionRef.current += 1;
                                    setIssueRepositoryLocalMatches((current) => {
                                      const key = repository.label.toLocaleLowerCase();
                                      if (!repositoryId) {
                                        const { [key]: _removed, ...remaining } = current;
                                        return remaining;
                                      }
                                      return { ...current, [key]: repositoryId };
                                    });
                                  }}
                                  value=""
                                >
                                  <option value="">Select remote</option>
                                  {localRemoteChoices.map((candidate) => (
                                    <option key={candidate.id} value={candidate.id}>
                                      {candidate.label} — {candidate.originUrl}
                                    </option>
                                  ))}
                                </SelectMenu>
                              ) : !catalogRepository &&
                                allLocalRemoteChoices.length > 0 ? (
                                <Button
                                  aria-label={`Show all local remotes for ${repository.label}`}
                                  className={styles.sourceRepositoryLink}
                                  onPress={() =>
                                    setIssueRepositoryShowAllRemotes((current) => ({
                                      ...current,
                                      [remoteMatchKey]: true,
                                    }))
                                  }
                                >
                                  Show all
                                </Button>
                              ) : !catalogRepository && upstreamRepository ? (
                                <InfoTooltip
                                  content="Clone this upstream into the trusted repository root."
                                >
                                  <Button
                                    aria-label={`Clone ${repository.label} from its Jira upstream`}
                                    className={styles.sourceRepositoryLink}
                                    isDisabled={Boolean(issueRepositoryCloneKey)}
                                    onPress={() =>
                                      void cloneIssueRepository(
                                        upstreamRepository,
                                      )
                                    }
                                  >
                                    {issueRepositoryCloneKey ===
                                    upstreamRepository.label.toLocaleLowerCase()
                                      ? "Cloning…"
                                      : "Clone"}
                                    <Glyph
                                      name={
                                        issueRepositoryCloneKey ===
                                        upstreamRepository.label.toLocaleLowerCase()
                                          ? "refresh"
                                          : "plus"
                                      }
                                      size={11}
                                    />
                                  </Button>
                                </InfoTooltip>
                              ) : catalogRepository && forgeTarget ? (
                                <InfoTooltip
                                  content={
                                    openingRepositoryBaseKey
                                      ? "Opening repository base in browser"
                                      : undefined
                                  }
                                >
                                  <Button
                                    aria-label={`${opening ? "Opening" : "Open"} ${repository.label} default base ${defaultBase} on ${forgeDisplayName(forgeTarget.forge)} (${forgeTarget.host}) in browser`}
                                    className={styles.sourceRepositoryLink}
                                    data-forge={forgeTarget.forge}
                                    isDisabled={Boolean(openingRepositoryBaseKey)}
                                    onPress={() =>
                                      void openRepositoryBase(
                                        {
                                          key: openingKey,
                                          id: repository.label,
                                          repositoryId: catalogRepository.id,
                                          reason:
                                            "Selected in the workspace source",
                                          confidence: 100,
                                          included: true,
                                          base: defaultBase,
                                        },
                                        forgeTarget,
                                      )
                                    }
                                  >
                                    {opening
                                      ? "Opening"
                                      : forgeDisplayName(forgeTarget.forge)}
                                    <Glyph name="external" size={11} />
                                  </Button>
                                </InfoTooltip>
                              ) : (
                                <InfoTooltip
                                  content={
                                    catalogRepository
                                      ? "The origin is visible, but it is not a supported GitHub or GitLab URL."
                                      : "Match this name to a discovered local repository to inspect its remote."
                                  }
                                >
                                  <span
                                    className={styles.sourceRepositoryNoLink}
                                    tabIndex={0}
                                  >
                                    {catalogRepository?.originUrl
                                      ? "Origin only"
                                      : "No remote"}
                                  </span>
                                </InfoTooltip>
                              )}
                            </div>
                          );
                        },
                      )}
                    </div>
                    {issueRepositoryCloneNotice && (
                      <p
                        className={styles.sourceRepositoryNotice}
                        data-error={
                          issueRepositoryCloneNotice.kind === "error" ||
                          undefined
                        }
                        role={
                          issueRepositoryCloneNotice.kind === "error"
                            ? "alert"
                            : "status"
                        }
                      >
                        <Glyph
                          name={
                            issueRepositoryCloneNotice.kind === "error"
                              ? "warning"
                              : "check"
                          }
                          size={12}
                        />
                        {issueRepositoryCloneNotice.message}
                      </p>
                    )}
                    {repositoryBaseNotice && (
                      <p
                        className={styles.sourceRepositoryNotice}
                        data-error={
                          repositoryBaseNotice.kind === "error" || undefined
                        }
                        role={
                          repositoryBaseNotice.kind === "error"
                            ? "alert"
                            : "status"
                        }
                      >
                        <Glyph
                          name={
                            repositoryBaseNotice.kind === "error"
                              ? "warning"
                              : repositoryBaseNotice.kind === "opening"
                                ? "refresh"
                                : "check"
                          }
                          size={12}
                        />
                        {repositoryBaseNotice.message}
                      </p>
                    )}
                  </section>
                )}
                <div className={styles.sourcePreview}>
                  <Glyph name="folder" />
                  <span>
                    <strong>Managed workspace root</strong>
                    <code>{workspaceRootDisplayPath}</code>
                  </span>
                  <span className={styles.localPill}>On this Mac</span>
                </div>
              </form>
            )}

            {step === "evidence" && (
              <div
                className={styles.evidencePanel}
                data-ui="workspace-create.repository-review"
                data-ui-label="Repository review"
              >
                <div className={styles.issueContext}>
                  <span className={styles.jiraTile}>
                    <Glyph
                      name={
                        isIssueSource
                          ? issueProvider === "jira"
                            ? "jira"
                            : "openProject"
                          : isWorkspaceSource
                            ? "copy"
                            : isCodeWorkspaceSource
                              ? "file"
                              : "folder"
                      }
                      size={18}
                    />
                  </span>
                  <span>
                    <b>{draftKey}</b>
                    <strong>{draftTitle}</strong>
                  </span>
                  <span className={styles.contextStatus}>
                    <Glyph name="check" size={13} />{" "}
                    {isRevisionMode
                      ? "Original retained"
                      : isWorkspaceSource
                        ? "Copied setup"
                        : isCodeWorkspaceSource
                          ? "File read · original unchanged"
                          : "Details entered"}
                  </span>
                </div>
                <div className={styles.evidenceHeading}>
                  <span>
                    <strong>Repository requests</strong>
                    <small>
                      {included.length} included · no worktrees created
                    </small>
                  </span>
                  <span className={styles.boundaryBadge}>PLAN PREVIEW</span>
                </div>
                <div className={styles.repoEvidenceList}>
                  {repos.map((repo) => {
                    const catalogRepository = repo.repositoryId
                      ? catalogRepositoriesById.get(repo.repositoryId)
                      : undefined;
                    const forgeTarget = repositoryForgeTarget(
                      catalogRepository?.originUrl,
                    );
                    const forgeName = forgeTarget
                      ? forgeDisplayName(forgeTarget.forge)
                      : "";
                    const opening = openingRepositoryBaseKey === repo.key;
                    const baseActionAvailable = Boolean(
                      repo.repositoryId && forgeTarget,
                    );
                    const baseActionLabel = baseActionAvailable
                      ? `${opening ? "Opening" : "Open"} ${repo.id} base ${repo.base} on ${forgeName} (${forgeTarget!.host}) in browser`
                      : `Cannot open ${repo.id} base in browser: no trusted GitHub or GitLab origin`;
                    const baseActionTooltip = baseActionAvailable
                      ? `Open “${repo.base}” on ${forgeName} · ${forgeTarget!.host}`
                      : repo.repositoryId
                        ? "No supported GitHub or GitLab origin is available."
                        : "This repository has no trusted catalog identity.";
                    const knownBranches =
                      catalogRepository?.availableBranches ?? [];
                    const selectedBaseAvailable = knownBranches.some(
                      (branch) => branch.name === repo.base,
                    );
                    const baseOptions = selectedBaseAvailable
                      ? knownBranches
                      : [
                          {
                            name: repo.base,
                            fullRef: "",
                            commitOid: "",
                            remote: false,
                          },
                          ...knownBranches,
                        ];
                    const refreshing =
                      refreshingRepositoryId === repo.repositoryId;

                    return (
                      <div
                        className={styles.repoEvidenceRow}
                        data-included={repo.included}
                        key={repo.key}
                      >
                        <Checkbox
                          className={styles.checkbox}
                          isSelected={repo.included}
                          onChange={(included) =>
                            updateRepo(repo.key, { included })
                          }
                          aria-label={`Include ${repo.id}${
                            repo.repositoryId ? ` [${repo.repositoryId}]` : ""
                          }`}
                        >
                          <span>
                            <Glyph name="check" size={12} />
                          </span>
                        </Checkbox>
                        <span className={styles.repoEvidenceMeta}>
                          <span className={styles.repoIdentity}>
                            {baseActionAvailable && forgeTarget ? (
                              <InfoTooltip content={baseActionTooltip}>
                                <Button
                                  aria-label={baseActionLabel}
                                  className={styles.repositoryIdentityLink}
                                  data-forge={forgeTarget.forge}
                                  data-opening={opening || undefined}
                                  isDisabled={Boolean(openingRepositoryBaseKey)}
                                  onPress={() =>
                                    void openRepositoryBase(repo, forgeTarget)
                                  }
                                >
                                  <b>{repo.id}</b>
                                  <Glyph name="external" size={11} />
                                </Button>
                              </InfoTooltip>
                            ) : (
                              <b>{repo.id}</b>
                            )}
                            <small>{repo.reason}</small>
                          </span>
                          <span className={styles.confidence} data-level="high">
                            {isRevisionMode
                              ? "Revised from plan"
                              : isWorkspaceSource
                                ? "Copied from plan"
                                : isCodeWorkspaceSource
                                  ? codeWorkspaceAddedRepositoryIds.includes(
                                      repo.repositoryId ?? "",
                                    )
                                    ? clonedCodeWorkspaceRepositoryIds.has(
                                        repo.repositoryId ?? "",
                                      )
                                      ? "Cloned from URL"
                                      : "Added from catalog"
                                    : "Matched locally"
                                  : repo.repositoryId
                                    ? "Matched locally"
                                    : "Selected manually"}
                          </span>
                        </span>
                        <div className={styles.baseReviewControl}>
                          <label className={styles.compactSelect}>
                            <span>Base branch</span>
                            <InfoTooltip content={!repo.included ? "Include repository to choose a base branch" : repo.base}>
                              <SelectMenu
                                value={repo.base}
                                onChange={(value) =>
                                  updateRepo(repo.key, {
                                    base: value,
                                  })
                                }
                                disabled={!repo.included || opening}
                                aria-label={`Base branch for ${repo.id}${
                                  repo.repositoryId
                                    ? ` [${repo.repositoryId}]`
                                    : ""
                                }`}
                              >
                                {baseOptions.map((branch) => (
                                  <option
                                    key={`${branch.fullRef}:${branch.name}`}
                                    value={branch.name}
                                  >
                                    {branch.name}
                                    {!selectedBaseAvailable &&
                                    branch.name === repo.base
                                      ? " · unavailable"
                                      : branch.remote
                                        ? " · origin"
                                        : catalogRepository?.originUrl
                                          ? " · local"
                                          : ""}
                                  </option>
                                ))}
                              </SelectMenu>
                            </InfoTooltip>
                          </label>
                          <div className={styles.baseReviewActions}>
                            <InfoTooltip
                              content={
                                refreshingRepositoryId === repo.repositoryId
                                  ? "Refreshing branches from origin"
                                  : !repo.repositoryId
                                    ? "This repository is not matched to the local catalog"
                                    : !catalogRepository?.originUrl
                                      ? "This repository has no configured origin URL"
                                      : "Fetch current branches from origin"
                              }
                            >
                              <Button
                                aria-label={`Fetch current branches for ${repo.id} from origin`}
                                className={styles.repositoryBaseLink}
                                data-opening={refreshing || undefined}
                                isDisabled={
                                  !repo.repositoryId ||
                                  !catalogRepository?.originUrl ||
                                  Boolean(refreshingRepositoryId)
                                }
                                onPress={() =>
                                  void refreshRepositoryBranches(repo)
                                }
                              >
                                <Glyph name="refresh" size={12} />
                                <b>{refreshing ? "Fetching" : "Refresh"}</b>
                              </Button>
                            </InfoTooltip>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {repositoryBaseNotice && (
                  <p
                    className={styles.repositoryBaseNotice}
                    data-error={
                      repositoryBaseNotice.kind === "error" || undefined
                    }
                    data-opening={
                      repositoryBaseNotice.kind === "opening" || undefined
                    }
                    role={
                      repositoryBaseNotice.kind === "error" ? "alert" : "status"
                    }
                  >
                    <Glyph
                      name={
                        repositoryBaseNotice.kind === "error"
                          ? "warning"
                          : repositoryBaseNotice.kind === "opening"
                            ? "refresh"
                            : "check"
                      }
                      size={13}
                    />
                    <span>{repositoryBaseNotice.message}</span>
                  </p>
                )}
                <p className={styles.evidenceNote}>
                  <Glyph name="warning" size={14} />
                  <span>
                    {isCodeWorkspaceSource
                      ? `Read-only preflight verifies each trusted source, base commit, branch conflict, and target path. Creating the workspace later adds separate managed worktrees under ${workspaceRootDisplayPath}; preflight does not fetch or edit the source checkouts.`
                      : "WTS resolves these labels against the local catalog and verifies base commits, branch conflicts, and safe target paths during the read-only preflight."}
                  </span>
                </p>
              </div>
            )}

            {step === "services" && (
              <div
                className={styles.runtimeAnalysisPanel}
                data-ui="workspace-create.runtime"
                data-ui-label="Runtime setup"
              >
                <header className={styles.runtimeAnalysisHeader}>
                  <span className={styles.runtimeAnalysisIcon}>
                    <Glyph name="command" size={18} />
                  </span>
                  <div>
                    <small>READ-ONLY CODE ANALYSIS</small>
                    <h3>Choose what this workspace should run</h3>
                    <p>
                      WTS found runnable services at the selected base commits.
                      Include only what this task needs; commands and source
                      paths are read-only findings.
                    </p>
                  </div>
                  <span
                    className={styles.runtimeAnalysisState}
                    data-state={runtimeAnalysisState}
                  >
                    {runtimeAnalysisState === "loading"
                      ? "Analyzing…"
                      : runtimeAnalysisState === "ready"
                        ? "Analysis ready"
                        : runtimeAnalysisState === "error"
                          ? "Needs attention"
                          : "Not started"}
                  </span>
                </header>

                {runtimeAnalysisState === "loading" && (
                  <div
                    aria-live="polite"
                    className={styles.runtimeAnalysisLoading}
                    role="status"
                  >
                    <span aria-hidden="true">
                      <Glyph name="refresh" size={18} />
                    </span>
                    <div>
                      <b>
                        Analyzing {included.length} selected base{" "}
                        {included.length === 1 ? "commit" : "commits"} ·{" "}
                        {runtimeAnalysisElapsedSeconds}s
                      </b>
                      <small>
                        1. Resolve exact refs · 2. Build evidence graph · 3.
                        Inspect manifests, Compose, Dockerfiles, and example env
                        files · 4. Correlate commands and ports
                      </small>
                    </div>
                  </div>
                )}

                {runtimeAnalysisState === "idle" && (
                  <div className={styles.runtimeAnalysisEmpty}>
                    <span>
                      <Glyph name="refresh" size={17} />
                    </span>
                    <div>
                      <b>Repository selection changed</b>
                      <p>
                        Analyze the selected base commits again before adding
                        services or port preferences to this plan.
                      </p>
                    </div>
                  </div>
                )}

                {runtimeAnalysisState === "error" && (
                  <div className={styles.runtimeAnalysisError} role="alert">
                    <Glyph name="warning" size={17} />
                    <div>
                      <b>Service analysis could not finish</b>
                      <p>{runtimeAnalysisError}</p>
                    </div>
                    <span className={styles.runtimeAnalysisErrorActions}>
                      <button
                        className={styles.secondaryAction}
                        onClick={() => setStep("manifest")}
                        type="button"
                      >
                        Continue without services
                      </button>
                      <button
                        className={styles.primaryButton}
                        onClick={() => void analyzeRuntime(true)}
                        type="button"
                      >
                        <Glyph name="refresh" size={13} /> Retry
                      </button>
                    </span>
                  </div>
                )}

                {runtimeAnalysisState === "ready" && runtimeAnalysis && (
                  <>
                    <div className={styles.runtimeAnalysisSummary}>
                      <span>
                        <b>{runtimeAnalysis.services.length}</b>
                        <small>
                          {runtimeAnalysis.services.length === 1
                            ? "service found"
                            : "services found"}
                        </small>
                      </span>
                      <span>
                        <b>{selectedRuntimeServices.length}</b>
                        <small>will be ready to run</small>
                      </span>
                      <span>
                        <b>
                          {runtimeAnalysis.services.reduce(
                            (total, service) => total + service.ports.length,
                            0,
                          )}
                        </b>
                        <small>ports to reserve</small>
                      </span>
                      <InfoTooltip content={runtimeAnalysis.graph.detail}>
                        <span
                          className={styles.runtimeGraphStatus}
                          data-state={runtimeAnalysis.graph.status}
                          tabIndex={0}
                        >
                          <Glyph
                            name={
                              runtimeAnalysis.graph.status === "ready"
                                ? "check"
                                : "warning"
                            }
                            size={13}
                          />
                          <b>Graph {runtimeAnalysis.graph.status}</b>
                          <small>{runtimeAnalysis.graph.detail}</small>
                        </span>
                      </InfoTooltip>
                    </div>

                    {runtimeAnalysis.warnings.length > 0 && (
                      <div
                        aria-label="Runtime analysis warnings"
                        className={styles.runtimeAnalysisWarnings}
                      >
                        {runtimeAnalysis.warnings.map((warning, index) => (
                          <p key={`${warning}-${index}`}>
                            <Glyph name="warning" size={13} />
                            <span>{warning}</span>
                          </p>
                        ))}
                      </div>
                    )}

                    {runtimeAnalysis.services.length === 0 ? (
                      <div className={styles.runtimeAnalysisEmpty}>
                        <span>
                          <Glyph name="check" size={17} />
                        </span>
                        <div>
                          <b>No runnable services detected</b>
                          <p>
                            You can save without runtime services. WTS will not
                            guess a command or open a port without evidence.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div
                        aria-label="Detected services"
                        className={styles.runtimeServiceList}
                        role="list"
                      >
                        {runtimeAnalysis.services.map((service) => {
                          const draft = runtimeServiceDrafts.get(
                            service.candidateId,
                          );
                          if (!draft) return null;
                          const evidence = [
                            ...service.evidence,
                            ...service.ports.flatMap((port) => port.evidence),
                          ];
                          return (
                            <article
                              className={styles.runtimeServiceCard}
                              data-included={draft.included}
                              key={service.candidateId}
                              role="listitem"
                            >
                              <header>
                                <Checkbox
                                  aria-label={`Include ${service.displayName} in runtime plan`}
                                  className={styles.checkbox}
                                  isSelected={draft.included}
                                  onChange={(included) =>
                                    setRuntimeServiceIncluded(
                                      service.candidateId,
                                      included,
                                    )
                                  }
                                >
                                  <span>
                                    <Glyph name="check" size={12} />
                                  </span>
                                </Checkbox>
                                <span className={styles.runtimeServiceIdentity}>
                                  <b>{service.displayName}</b>
                                  <small>
                                    {service.repositoryLabel} ·{" "}
                                    <code>
                                      {service.commitOid.slice(0, 12)}
                                    </code>
                                  </small>
                                </span>
                                <span className={styles.runtimeInclusionLabel}>
                                  {draft.included
                                    ? "Included in this plan"
                                    : "Not included"}
                                </span>
                                <span
                                  className={styles.runtimeConfidence}
                                  data-confidence={service.confidence}
                                >
                                  {runtimeConfidenceLabels[service.confidence]}
                                </span>
                              </header>

                              <div className={styles.runtimeServiceFacts}>
                                <span>
                                  <small>RUNS</small>
                                  <InfoTooltip content={service.command.join(" ")}>
                                    <code tabIndex={0}>
                                      {service.command.join(" ")}
                                    </code>
                                  </InfoTooltip>
                                </span>
                                <span>
                                  <small>FROM</small>
                                  <InfoTooltip content={service.workingDirectory}>
                                    <code tabIndex={0}>
                                      {service.workingDirectory}
                                    </code>
                                  </InfoTooltip>
                                </span>
                                <span>
                                  <small>START ORDER</small>
                                  <code>
                                    {service.dependencies.length
                                      ? `After ${service.dependencies.join(", ")}`
                                      : "Can start immediately"}
                                  </code>
                                </span>
                              </div>

                              {service.ports.length > 0 && (
                                <fieldset
                                  className={styles.runtimePortSet}
                                  disabled={!draft.included}
                                >
                                  <legend>Ports this service expects</legend>
                                  {service.ports.map((port) => {
                                    const portDraft = draft.ports.find(
                                      (item) => item.portId === port.portId,
                                    );
                                    if (!portDraft) return null;
                                    const invalid =
                                      validRuntimePort(
                                        portDraft.preferredPort,
                                      ) === null;
                                    const errorId = runtimePortErrorId(
                                      service.candidateId,
                                      port.portId,
                                    );
                                    return (
                                      <div
                                        className={styles.runtimePortRow}
                                        key={port.portId}
                                      >
                                        <span
                                          className={styles.runtimePortIdentity}
                                        >
                                          <b>{port.portId}</b>
                                          <small>
                                            {port.environment ??
                                              "WTS_PORT / PORT"}
                                          </small>
                                        </span>
                                        <label>
                                          <span>Preferred port</span>
                                          <input
                                            aria-invalid={invalid || undefined}
                                            aria-describedby={
                                              invalid && draft.included
                                                ? errorId
                                                : undefined
                                            }
                                            aria-label={`Preferred port for ${service.displayName} ${port.portId}`}
                                            inputMode="numeric"
                                            max={65_535}
                                            min={1_024}
                                            onChange={(event) =>
                                              updateRuntimePort(
                                                service.candidateId,
                                                port.portId,
                                                {
                                                  preferredPort:
                                                    event.currentTarget.value,
                                                },
                                              )
                                            }
                                            type="number"
                                            value={portDraft.preferredPort}
                                          />
                                        </label>
                                        <label>
                                          <span>Allocation</span>
                                          <SelectMenu
                                            aria-label={`Port allocation policy for ${service.displayName} ${port.portId}`}
                                            onChange={(value) =>
                                              updateRuntimePort(
                                                service.candidateId,
                                                port.portId,
                                                {
                                                  policy: value as RuntimePortPolicy,
                                                },
                                              )
                                            }
                                            value={portDraft.policy}
                                          >
                                            <option value="prefer">
                                              Prefer; move if occupied
                                            </option>
                                            <option value="fixed">
                                              Fixed; block if occupied
                                            </option>
                                          </SelectMenu>
                                        </label>
                                        <span
                                          className={
                                            styles.runtimePortConfidence
                                          }
                                          data-confidence={port.confidence}
                                        >
                                          {
                                            runtimeConfidenceLabels[
                                              port.confidence
                                            ]
                                          }
                                        </span>
                                        {invalid && draft.included && (
                                          <small
                                            className={styles.runtimePortError}
                                            id={errorId}
                                            role="alert"
                                          >
                                            Enter a port from 1024 to 65535.
                                          </small>
                                        )}
                                      </div>
                                    );
                                  })}
                                </fieldset>
                              )}

                              <details className={styles.runtimeEvidence}>
                                <summary>
                                  <Glyph name="file" size={13} />
                                  Evidence · {evidence.length}{" "}
                                  {evidence.length === 1
                                    ? "finding"
                                    : "findings"}
                                </summary>
                                {evidence.length ? (
                                  <ul>
                                    {evidence.map((item, index) => (
                                      <li
                                        key={`${item.repositoryId}-${item.path}-${item.detector}-${index}`}
                                      >
                                        <code>{item.path}</code>
                                        <span>{item.detail}</span>
                                        <small>
                                          {item.detector} ·{" "}
                                          {item.commitOid.slice(0, 12)}
                                        </small>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p>
                                    No additional file evidence was returned.
                                  </p>
                                )}
                              </details>
                            </article>
                          );
                        })}
                      </div>
                    )}

                    <p className={styles.runtimeAssignmentNote}>
                      <Glyph name="check" size={14} />
                      <span>
                        This plan stores preferred ports only. WTS assigns and
                        shows actual loopback ports when you explicitly start
                        the runtime.
                      </span>
                    </p>
                  </>
                )}
              </div>
            )}

            {step === "manifest" && (
              <div
                className={styles.manifestPanel}
                data-ui="workspace-create.plan-review"
                data-ui-label="Workspace plan review"
              >
                {saveWarning && (
                  <p className={styles.evidenceNote} role="alert">
                    <Glyph name="warning" size={14} />
                    <span>{saveWarning}</span>
                  </p>
                )}
                {isRevisionMode && templateWorkspace && (
                  <div className={styles.revisionContinuity}>
                    <span>
                      <Glyph name="copy" size={16} />
                    </span>
                    <div>
                      <b>Original retained</b>
                      <p>
                        {templateWorkspace.key} remains unchanged. Saving adds a
                        separate durable plan titled “{draftTitle}” with its own
                        workspace path.
                      </p>
                    </div>
                  </div>
                )}
                <div className={styles.manifestSummary}>
                  <span>
                    <small>
                      {isRevisionMode
                        ? "ORIGINAL"
                        : isIssueSource
                          ? issueProvider === "jira"
                            ? "ISSUE"
                            : "WORK PACKAGE"
                          : isWorkspaceSource
                            ? "TEMPLATE"
                            : isCodeWorkspaceSource
                              ? "VS CODE FILE"
                              : "DIRECT"}
                    </small>
                    <b>
                      {isCodeWorkspaceSource
                        ? codeWorkspaceImport?.fileName
                        : draftKey}
                    </b>
                  </span>
                  <span>
                    <small>REPOSITORIES</small>
                    <b>{included.length}</b>
                  </span>
                  <span>
                    <small>SERVICES</small>
                    <b>{selectedRuntimeServices.length}</b>
                  </span>
                  <span>
                    <small>OPEN WITH</small>
                    <b>{provider}</b>
                  </span>
                </div>
                <div className={styles.reviewDecisionIntro}>
                  <span>
                    <small>FINAL REVIEW</small>
                    <h3>Does this plan match the task?</h3>
                    <p>
                      Check repository branches and runnable services before
                      saving. You can edit either choice without starting over.
                    </p>
                  </span>
                  <span className={styles.reviewDecisionState}>
                    <Glyph name="check" size={14} />
                    No Git or processes yet
                  </span>
                </div>
                <div className={styles.manifestGrid}>
                  <section className={styles.planningHomeSection}>
                    <div className={styles.planningHomeIntro}>
                      <span className={styles.planningHomeIcon}>
                        <Glyph name="file" size={17} />
                      </span>
                      <div>
                        <h3>Planning home</h3>
                        <p>
                          Give agents a durable place for plans, findings, and
                          handoffs.
                        </p>
                      </div>
                    </div>
                    <RadioGroup
                      aria-label="Planning home"
                      className={styles.planningChoices}
                      value={planningEnabled ? "starter" : "existing"}
                      onChange={(value) =>
                        setPlanningEnabled(value === "starter")
                      }
                    >
                      <Radio value="existing" className={styles.planningChoice}>
                        <span className={styles.radioIndicator} />
                        <span>
                          <strong>Use repositories as-is</strong>
                          <small>
                            Planning files already exist, or are not needed.
                          </small>
                        </span>
                      </Radio>
                      <Radio value="starter" className={styles.planningChoice}>
                        <span className={styles.radioIndicator} />
                        <span>
                          <strong>Create a starter kit</strong>
                          <small>
                            Add editable planning files when provisioning.
                          </small>
                        </span>
                      </Radio>
                    </RadioGroup>
                    {planningEnabled && (
                      <div className={styles.planningSettings}>
                        <label>
                          <span>Folder</span>
                          <SelectMenu
                            aria-label="Planning folder"
                            value={planningFolder}
                            onChange={(value) =>
                              setPlanningFolder(
                                value as WorkspacePlanningSelection["folder"],
                              )
                            }
                          >
                            <option value="plansAndKanban">
                              plans-and-kanban
                            </option>
                            <option value="plans">plans</option>
                          </SelectMenu>
                        </label>
                        <label>
                          <span>Starter</span>
                          <SelectMenu
                            aria-label="Planning starter"
                            value={planningFormat}
                            onChange={(value) =>
                              setPlanningFormat(
                                value as WorkspacePlanningSelection["format"],
                              )
                            }
                          >
                            <option value="kanban">
                              Plan, findings &amp; Kanban
                            </option>
                            <option value="notes">Plan &amp; findings</option>
                          </SelectMenu>
                        </label>
                        <p>
                          WTS creates these files once. They remain editable
                          user content and are never silently removed.
                        </p>
                      </div>
                    )}
                  </section>
                  <section className={styles.planDecisionSection}>
                    <header className={styles.planDecisionHeader}>
                      <span>
                        <h3>Repositories and branches</h3>
                        <small>
                          {included.length} selected for separate worktrees
                        </small>
                      </span>
                      <button
                        className={styles.planEditButton}
                        onClick={() => setStep("evidence")}
                        type="button"
                      >
                        Edit repositories
                      </button>
                    </header>
                    <dl className={styles.manifestList}>
                      <div>
                        <dt>Root</dt>
                        <dd>
                          <code>{workspaceRootDisplayPath}</code>
                          <small>WTS assigns the final folder on save</small>
                        </dd>
                      </div>
                      <div>
                        <dt>Base refs</dt>
                        <dd>
                          {included.map((repo) => (
                            <code key={repo.key}>
                              {repo.id} ← {repo.base}
                            </code>
                          ))}
                        </dd>
                      </div>
                      <div>
                        <dt>Worktrees</dt>
                        <dd>
                          <code>Created only after saved-plan review</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Planning</dt>
                        <dd>
                          <code>
                            {planningEnabled
                              ? `${planningFolder === "plans" ? "plans" : "plans-and-kanban"}/ · ${
                                  planningFormat === "kanban"
                                    ? "Kanban kit"
                                    : "notes kit"
                                }`
                              : "Use repository planning files as-is"}
                          </code>
                          <small>
                            {planningEnabled
                              ? "Included as a folder in the generated VS Code workspace"
                              : "No extra planning folder will be created"}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>Graph scope</dt>
                        <dd>
                          <code>Built on demand after workspace creation</code>
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <section className={styles.planDecisionSection}>
                    <header className={styles.planDecisionHeader}>
                      <span>
                        <h3>Runtime services</h3>
                        <small>
                          {selectedRuntimeServices.length
                            ? `${selectedRuntimeServices.length} selected`
                            : "No services selected"}
                        </small>
                      </span>
                      <button
                        className={styles.planEditButton}
                        onClick={() => setStep("services")}
                        type="button"
                      >
                        Edit services
                      </button>
                    </header>
                    <div className={styles.planServiceReview}>
                      {selectedRuntimeServices.length ? (
                        selectedRuntimeServices.map((service) => {
                          const draft = runtimeServiceDrafts.get(
                            service.candidateId,
                          );
                          const ports =
                            draft?.ports
                              .map(
                                (port) =>
                                  `${port.portId}: ${port.preferredPort} · ${port.policy}`,
                              )
                              .join(", ") || "No ports";
                          return (
                            <span key={service.candidateId}>
                              <b>{service.displayName}</b>
                              <code>{ports}</code>
                            </span>
                          );
                        })
                      ) : (
                        <p>
                          This workspace will not start any runtime services.
                        </p>
                      )}
                      <small>
                        Actual loopback ports are assigned only when you
                        explicitly start the runtime.
                      </small>
                    </div>
                  </section>
                  <section>
                    <h3>Open with</h3>
                    <div className={styles.providerCompactGrid}>
                      {providers.map((item) => (
                        <Button
                          key={item.id}
                          className={styles.providerCompact}
                          data-selected={provider === item.id}
                          onPress={() => setProvider(item.id)}
                          aria-pressed={provider === item.id}
                        >
                          <span>{providerMarks[item.id]}</span>
                          <b>{item.id}</b>
                          {provider === item.id && (
                            <Glyph name="check" size={14} />
                          )}
                        </Button>
                      ))}
                    </div>
                    <div className={styles.safetyNote}>
                      <Glyph name="check" />
                      <span>
                        <b>
                          {isRevisionMode
                            ? "This action saves a separate revised plan."
                            : isCodeWorkspaceSource
                              ? "This action only saves a local plan from the matched folders."
                              : "This action only saves a local plan."}
                        </b>
                        {isRevisionMode
                          ? ` The original ${templateWorkspace?.key ?? "workspace"}, its worktrees, branches, changes, and sessions remain untouched.`
                          : isCodeWorkspaceSource
                            ? " The source file and trusted checkouts—including their settings, branches, changes, and existing worktrees—remain untouched. Saving performs no Git operation; provisioning later creates separate managed worktrees."
                            : " No repository, worktree, port, process, editor, graph, or agent side effect is started by this step."}
                      </span>
                    </div>
                  </section>
                </div>
              </div>
            )}

            {step === "saving" && (
              <div
                className={styles.provisionPanel}
                data-ui="workspace-create.saving"
                data-ui-label="Workspace save progress"
                role={saveError ? "alert" : "status"}
                aria-live={saveError ? "assertive" : "polite"}
                aria-busy={!saveError}
              >
                <div
                  className={styles.savingGlyph}
                  data-error={Boolean(saveError)}
                  aria-hidden="true"
                >
                  <Glyph name={saveError ? "warning" : "refresh"} size={24} />
                </div>
                <div className={styles.provisionDetails}>
                  <h3>
                    {saveError ? "Save needs attention" : `Saving ${draftKey}`}
                  </h3>
                  <p>
                    {saveError
                      ? saveError
                      : "Writing the workspace and idempotency record in one local transaction…"}
                  </p>
                  {saveError && (
                    <small>
                      Retrying uses the same request identity so WTS can safely
                      reconcile an uncertain result.
                    </small>
                  )}
                  {!saveError && (
                    <ul>
                      <li data-complete>
                        <span>
                          <Glyph name="check" size={13} />
                        </span>
                        Validate the structured plan
                      </li>
                      <li data-active>
                        <span>2</span>
                        Commit to the local registry
                      </li>
                      <li>
                        <span>3</span>
                        Return the saved workspace identity
                      </li>
                    </ul>
                  )}
                </div>
              </div>
            )}

            {step === "saved" && savedWorkspace && (
              <div
                className={styles.readyPanel}
                data-ui="workspace-create.saved"
                data-ui-label="Saved workspace"
                role="status"
                aria-live="polite"
              >
                <span className={styles.readyGlyph}>
                  <Glyph name="check" size={28} />
                </span>
                <h3>
                  {isRevisionMode
                    ? `Revised ${draftKey} plan is saved`
                    : `${draftKey} is saved`}
                </h3>
                <p>
                  {isRevisionMode
                    ? `Original retained: ${templateWorkspace?.key ?? "the source workspace"} remains unchanged. This separate plan is ready for Git preflight at its new reserved path.`
                    : "The durable workspace plan is ready for Git preflight in its workbench. No worktrees or processes were created."}
                </p>
                <div className={styles.readyFacts}>
                  <span>
                    <Glyph name="folder" />
                    <b>{savedWorkspace.workspaceDisplayPath}</b>
                    <small>Reserved display path</small>
                  </span>
                  <span>
                    <span className={styles.providerMark}>
                      {providerMarks[provider]}
                    </span>
                    <b>{provider}</b>
                    <small>Default provider</small>
                  </span>
                </div>
              </div>
            )}
          </div>

          <div
            className={styles.dialogFooter}
            data-ui="workspace-create.actions"
            data-ui-label="Workspace setup actions"
          >
            <span
              className={styles.dialogFootnote}
              data-attention={
                step === "source" && Boolean(sourceBlockingMessage)
              }
            >
              <Glyph
                name={
                  step === "source" && sourceBlockingMessage
                    ? "warning"
                    : isRevisionMode
                      ? "copy"
                      : isCodeWorkspaceSource
                        ? "file"
                        : "folder"
                }
                size={14}
              />{" "}
              {step === "source" && sourceBlockingMessage
                ? sourceBlockingMessage
                : isRevisionMode
                  ? `${templateWorkspace?.key ?? "Original workspace"} stays unchanged`
                  : isCodeWorkspaceSource
                    ? `${codeWorkspaceImport?.fileName ?? "Source file"} stays unchanged`
                    : `Workspace roots stay under ${workspaceRootDisplayPath}`}
            </span>
            <span className={styles.dialogActions}>
              {step === "evidence" && (
                <Button
                  className={styles.secondaryButton}
                  onPress={() => setStep("source")}
                >
                  Back
                </Button>
              )}
              {step === "services" && (
                <Button
                  className={styles.secondaryButton}
                  onPress={() => setStep("evidence")}
                >
                  Back
                </Button>
              )}
              {step === "manifest" && (
                <Button
                  className={styles.secondaryButton}
                  onPress={() => setStep("services")}
                >
                  Back
                </Button>
              )}
              {step === "source" && (
                <Button
                  className={styles.primaryButton}
                  onPress={analyzeSource}
                  isDisabled={!canAnalyze}
                >
                  {isWorkspaceSource
                    ? isRevisionMode
                      ? "Review revised setup"
                      : "Review copied setup"
                    : isCodeWorkspaceSource
                      ? "Review imported repositories"
                      : "Review repositories"}{" "}
                  <Glyph name="arrow" />
                </Button>
              )}
              {step === "evidence" && (
                <Button
                  className={styles.primaryButton}
                  onPress={() => {
                    setStep("services");
                    void analyzeRuntime();
                  }}
                  isDisabled={included.length === 0}
                >
                  Analyze services <Glyph name="arrow" />
                </Button>
              )}
              {step === "services" && (
                <Button
                  className={styles.primaryButton}
                  onPress={() => {
                    if (runtimeAnalysisState === "idle") {
                      void analyzeRuntime();
                      return;
                    }
                    setStep("manifest");
                  }}
                  isDisabled={
                    runtimeAnalysisState === "loading" ||
                    runtimeAnalysisState === "error" ||
                    (runtimeAnalysisState === "ready" &&
                      (runtimeAnalysisFingerprint !==
                        currentRuntimeFingerprint ||
                        runtimePortErrors.length > 0))
                  }
                >
                  {runtimeAnalysisState === "loading"
                    ? "Analyzing services…"
                    : runtimeAnalysisState === "idle"
                      ? "Analyze services"
                      : isRevisionMode
                        ? "Review revised plan"
                        : "Review plan"}{" "}
                  <Glyph name="arrow" />
                </Button>
              )}
              {step === "manifest" && (
                <Button
                  className={styles.primaryButton}
                  onPress={() => void savePlan()}
                >
                  {isRevisionMode ? "Save revised plan" : "Save workspace plan"}{" "}
                  <Glyph name="arrow" />
                </Button>
              )}
              {step === "saving" && saveError && (
                <>
                  <Button
                    className={styles.secondaryButton}
                    onPress={() => setStep("manifest")}
                  >
                    Back
                  </Button>
                  <Button
                    className={styles.primaryButton}
                    onPress={() => void savePlan()}
                  >
                    Retry save <Glyph name="refresh" />
                  </Button>
                </>
              )}
              {step === "saving" && !saveError && (
                <Button
                  className={styles.secondaryButton}
                  onPress={stopWaitingForSave}
                >
                  <Glyph name="stop" /> Stop waiting
                </Button>
              )}
              {step === "saved" && savedWorkspace && (
                <Button
                  className={styles.primaryButton}
                  onPress={() => {
                    handleDialogOpenChange(false);
                    onComplete(savedWorkspace);
                  }}
                >
                  {isRevisionMode ? "Open revised plan" : "Open saved plan"}{" "}
                  <Glyph name="arrow" />
                </Button>
              )}
            </span>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
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
  const availableRepositories = useMemo(() => {
    const currentIds = new Set(
      workspace.repositoryPlans.flatMap((repository) =>
        repository.repositoryId ? [repository.repositoryId] : [],
      ),
    );
    const currentLabels = new Set(
      workspace.repositoryPlans.map((repository) => repository.label.toLowerCase()),
    );
    return (repositoryCatalog?.repositories ?? []).filter(
      (repository) =>
        !currentIds.has(repository.id) &&
        !currentLabels.has(repository.label.toLowerCase()),
    );
  }, [repositoryCatalog, workspace.repositoryPlans]);
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
    const repository = availableRepositories[0];
    setRepositoryId(repository?.id ?? "");
    setBaseRef(repository?.defaultBranch.name ?? "");
    setPreflight(null);
    setState("idle");
    setError("");
  }, [open, availableRepositories]);

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
              {availableRepositories.length === 0 && <p>No additional local repositories are available.</p>}
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
  driftDetected,
  onReview,
  onFetchBranches,
  onReviseBase,
  onCreateRevisedCopy,
  onReconcile,
  onMaterialize,
}: {
  workspace: Workspace;
  state: WorkspaceActionState;
  commandBusy: boolean;
  preflight: WorkspacePreflight | null;
  materialization: WorkspaceMaterialization | null;
  repositoryCatalog: RepositoryCatalog | null;
  error: string;
  driftDetected: boolean;
  onReview: () => void;
  onFetchBranches: (repositoryId: string) => void;
  onReviseBase: (repositoryId: string, baseRef: string) => void;
  onCreateRevisedCopy: () => void;
  onReconcile: () => void;
  onMaterialize: () => void;
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
  const blocked = preflight && !preflight.ready;
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
            : state === "checking"
              ? "Checking the exact Git effects"
              : state === "materializing"
                ? `Creating ${workspace.key}`
                : blocked
                  ? "Resolve the blockers before creating worktrees"
                  : preflight?.ready
                    ? "Review complete · ready to create"
                    : "Turn this saved plan into isolated worktrees"}
        </h2>
        <p>
          {driftDetected
            ? "WTS can safely re-read the managed worktrees, register their current branches, HEAD commits, origins, and upstreams, then rebuild the workspace graph."
            : state === "checking"
              ? "WTS is resolving local repositories, base commits, branch names, and target paths."
              : state === "materializing"
                ? "WTS is creating the worktrees transactionally and writing the VS Code workspace."
                : preflight?.ready
                  ? "Nothing has changed yet. These exact effects are locked to this review and will be checked again before creation."
                  : "WTS will inspect only the configured local repository catalog. Preflight itself does not write to Git."}
        </p>
        {error && (
          <div className={styles.provisionError} role="alert">
            <Glyph name="warning" size={14} />
            {error}
          </div>
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
        {preflight?.ready && (
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
          preflight?.ready ? styles.primaryButton : styles.secondaryButton
        }
        onPress={preflight?.ready ? onMaterialize : onReview}
        isDisabled={busy}
      >
        {busy && <Glyph name="refresh" size={14} />}
        {state === "checking"
          ? "Checking…"
          : state === "materializing"
            ? "Creating…"
            : preflight?.ready
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
  gitlabReview,
}: {
  client: WorkspaceClient;
  workspace: Workspace;
  actionState: WorkspaceActionState;
  commandBusy: boolean;
  preflight: WorkspacePreflight | null;
  materialization: WorkspaceMaterialization | null;
  repositoryCatalog: RepositoryCatalog | null;
  actionError: string;
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
  gitlabReview?: GitlabReviewTarget & Partial<GitlabReview>;
}) {
  type GitlabInboxView =
    | { state: "loading" }
    | { state: "ready"; inbox: GitlabMergeRequestInbox }
    | { state: "error"; detail: string };
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
  const [openingGitlabMergeRequestId, setOpeningGitlabMergeRequestId] =
    useState<string | null>(null);
  const [alignmentOpen, setAlignmentOpen] = useState(false);
  const [alignmentPreflight, setAlignmentPreflight] =
    useState<WorkspaceRepositoryAlignmentPreflight | null>(null);
  const [alignmentState, setAlignmentState] =
    useState<"loading" | "ready" | "aligning" | "error">("loading");
  const [alignmentError, setAlignmentError] = useState("");
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
      ? "Status unavailable"
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
      ? "GitLab no longer returns the current review status."
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
          (mergeRequest) => mergeRequest.status === "open",
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
    setGitlabInbox({ state: "loading" });
    void client.getGitlabMergeRequests(workspace.id).then(
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
      setRepositoryNotice(`${changeRequestDraft.repositoryLabel} · ${requestName} form opened.`);
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
        setAlignmentOpen(true);
        setAlignmentState("loading");
        setAlignmentError("");
        setAlignmentPreflight(null);
        try {
          const preflight = await client.preflightWorkspaceRepositoryAlignment(
            workspace.id,
            created.repositoryId,
          );
          if (
            preflight.workspaceId !== workspace.id ||
            preflight.repositoryId !== created.repositoryId
          ) {
            throw new Error("WTS returned alignment details for another repository.");
          }
          setAlignmentPreflight(preflight);
          setAlignmentState("ready");
        } catch (preflightCause) {
          setAlignmentError(
            preflightCause instanceof Error
              ? preflightCause.message
              : "WTS could not review repository alignment.",
          );
          setAlignmentState("error");
        }
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
              driftDetected={driftDetected}
              onReview={onReview}
              onFetchBranches={onFetchBranches}
              onReviseBase={onReviseBase}
              onCreateRevisedCopy={onCreateRevisedCopy}
              onReconcile={onReconcile}
              onMaterialize={onMaterialize}
            />
            <WorkspaceWorkItemsPanel
              client={client}
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
                      <code>{repository.baseRef}</code>
                      {created && (
                        <span className={styles.repoBaseMeta}>
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
                        </span>
                      )}
                    </span>
                    <span className={styles.repoWorkCell} role="cell">
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
                          mergeRequests.length > 0 ? (
                            <span className={styles.repoDeliveryFallback}>
                              {mergeRequests.map((mergeRequest) => {
                                const hasNewLocalWork = Boolean(
                                  mergeRequest.sourceHeadCommitOid &&
                                    created.gitState?.headCommitOid &&
                                    mergeRequest.sourceHeadCommitOid !==
                                      created.gitState.headCommitOid,
                                );
                                return (
                                  <a
                                    aria-label={`Open ${repository.label} merge request !${mergeRequest.iid} on GitLab: ${mergeRequest.title}`}
                                    className={styles.repoDeliveryLink}
                                    aria-disabled={
                                      commandBusy || openingGitlabMergeRequestId !== null
                                    }
                                    data-status={mergeRequest.status}
                                    href={mergeRequest.webUrl}
                                    key={mergeRequest.id}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      if (
                                        commandBusy ||
                                        openingGitlabMergeRequestId !== null
                                      ) return;
                                      void openGitlabMergeRequest(created, mergeRequest);
                                    }}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    <Glyph name="external" size={11} />
                                    {openingGitlabMergeRequestId ===
                                    created.repositoryId
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
                                );
                              })}
                            </span>
                          ) : workSummary !== "Clean" &&
                            gitlabInbox.state === "ready" &&
                            gitlabInbox.inbox.state === "fresh" ? (
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
                          ) : null
                        ) : null}
                    </span>
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
        onOpenChange={setAlignmentOpen}
        onRetry={() => {
          const created = materialization?.worktrees.find(
            (worktree) => worktree.repositoryId === alignmentPreflight?.repositoryId,
          );
          if (created) void syncRepository(created);
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

export type { NoticeToast };

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
  const [view, setView] = useState<
    "board" | "workbench" | "time" | "reviews" | "updates"
  >(initialView);
  const myReviews = useGithubReviewInbox(client);
  const assignedReviewCount =
    (myReviews.inbox?.reviews.length ?? 0) +
    (myReviews.gitlabInbox?.reviews.length ?? 0);
  const appUpdate = useAppUpdate(client);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
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
  const [workspaceGitlabInboxes, setWorkspaceGitlabInboxes] = useState(
    () => new Map<string, GitlabMergeRequestInbox>(),
  );
  const [boardStatusRevision, setBoardStatusRevision] = useState(0);
  const [workspaceNameEditing, setWorkspaceNameEditing] = useState(false);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [workspaceNameSaving, setWorkspaceNameSaving] = useState(false);
  const [workspaceNameError, setWorkspaceNameError] = useState("");
  const [selectedId, setSelectedId] = useState(initialWorkspaceId ?? "");
  const [registryState, setRegistryState] = useState<RegistryState>("loading");
  const [registryError, setRegistryError] = useState("");
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
    "loading" | "ready" | "removing" | "error"
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
  const [workspaceMaterialization, setWorkspaceMaterialization] =
    useState<WorkspaceMaterialization | null>(null);
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
  const deepLinkGenerationRef = useRef(0);
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
    if (!initialWorkspaceId) return;
    deepLinkEnabledRef.current = false;
    deepLinkGenerationRef.current += 1;
    setDeepLinkError("");
    setDeepLinkState("idle");
  };

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
        setSelectedId(
          resolveDeepLinkNow
            ? (initialWorkspaceId ?? "")
            : (selected?.id ?? ""),
        );
        setDeepLinkState(
          resolveDeepLinkNow ? (listedWorkspace ? "ready" : "loading") : "idle",
        );
        setNotice(
          selected
            ? `${selected.key} plan loaded from the local registry`
            : resolveDeepLinkNow
              ? "Local registry connected · opening linked workspace…"
              : "Local registry connected · no workspace plans yet",
        );
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
        const sessions = await client.listAgentSessions();
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
        workspace.lifecycleState === "materialized" &&
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
            const inbox = await client.getGitlabMergeRequests(workspace.id);
            if (!current) return;
            setWorkspaceGitlabInboxes((existing) => {
              const next = new Map(existing);
              next.set(workspace.id, inbox);
              return next;
            });
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
            gitlabWorkflowObservationsRef.current.set(
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
          } catch {
            // Keep the durable lane when GitLab or the workflow transition fails.
          } finally {
            pendingGitlabWorkflowTransitionsRef.current.delete(workspace.id);
          }
        }),
      );
    };

    void refreshMergeRequestWorkflow();
    const refreshTimer = window.setInterval(
      () => void refreshMergeRequestWorkflow(),
      60_000,
    );
    return () => {
      current = false;
      window.clearInterval(refreshTimer);
    };
  }, [
    boardStatusRevision,
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
        setNotice(`${workspace.key} plan loaded from the local registry`);
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

    void client
      .getWorkspaceMaterialization(workspaceId)
      .then((materialization) => {
        if (
          !current ||
          actionGeneration !== workspaceActionGenerationRef.current
        ) {
          return;
        }
        materializationCache.set(workspaceId, materialization);
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
      return counts;
    },
    [unmatchedAssignedGitlabReviews.length, workspaceAgents, workspaces],
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
    setReviewWorkspaceSeed(null);
    setCreateTemplateWorkspaceId("");
    setCreateRepositoryBaseOverrides({});
    setCreatePlanningEnabled(undefined);
    setCreateOpen(true);
  };

  const startRevisedWorkspace = () => {
    if (!selectedWorkspace) return;
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
    setReviewWorkspaceSeed(null);
    setCreateRepositoryBaseOverrides({});
    setCreatePlanningEnabled(true);
    setCreateTemplateWorkspaceId(selectedWorkspace.id);
    setCreateOpen(true);
  };

  const startBaseRevision = (repositoryId: string, baseRef: string) => {
    if (!selectedWorkspace) return;
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
    if (!selectedWorkspace || workspaceNameSaving) return;
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
    setWorkspaceNameSaving(true);
    setWorkspaceNameError("");
    try {
      const renamed = await client.renameWorkspace(selectedWorkspace.id, title);
      if (renamed.workspaceId !== selectedWorkspace.id) {
        throw new Error("WTS returned another workspace after renaming.");
      }
      const updated = workspaceFromView(renamed);
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === updated.id ? updated : workspace,
        ),
      );
      setWorkspaceNameEditing(false);
      setNotice(`Renamed workspace to ${updated.title}`);
    } catch (error) {
      setWorkspaceNameError(
        error instanceof Error ? error.message : "Workspace rename failed.",
      );
    } finally {
      setWorkspaceNameSaving(false);
    }
  };

  const resetOperationalState = (workspace: Workspace) => {
    const cached = materializationCache.get(workspace.id) ?? null;
    workspaceActionGenerationRef.current += 1;
    setReviewRepositoryId("");
    setWorkspaceCommandState("idle");
    setWorkspaceActionState(cached ? "materialized" : "idle");
    setWorkspacePreflight(null);
    setWorkspaceMaterialization(cached);
    setWorkspaceActionError("");
    materializationKeyRef.current = null;
    setNotice(
      cached
        ? `${workspace.key} opened · checking for newer local evidence`
        : `${workspace.key} plan loaded · workspace setup has not run`,
    );
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
  }, [workspaces]);

  const openWorkspace = (workspaceId: string) => {
    const item = workspaces.find((workspace) => workspace.id === workspaceId);
    if (!item) return;
    invalidateDeepLinkLookup();
    setSelectedId(workspaceId);
    resetOperationalState(item);
    setActiveTab("overview");
    setView("workbench");
    pushNavigationPath(`/sessions/${encodeURIComponent(workspaceId)}`);
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
    setNotice(`${workspace.key} plan saved · no setup effects have run`);
  };

  const reviewWorkspaceSetup = async (repositoryIdToRefresh?: string) => {
    if (!selectedWorkspace || workspaceCommandState !== "idle") return;
    const workspaceId = selectedWorkspace.id;
    const workspaceKey = selectedWorkspace.key;
    const actionGeneration = ++workspaceActionGenerationRef.current;
    setWorkspaceActionError("");
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
      setWorkspaceActionState("error");
      setNotice(`${workspaceKey} preflight failed`, "error");
    }
  };

  const materializeSelectedWorkspace = async () => {
    if (
      !selectedWorkspace ||
      !workspacePreflight?.ready ||
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
        {workspaces.length > 1 && (
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
              setBoardStatusRevision((revision) => revision + 1);
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
            const detail = laneDetails[lane];
            const laneHeadingId = `workspace-lane-${lane}`;
            return (
              <WorkspaceLaneDropTarget key={lane} lane={lane}>
                <header className={styles.laneHeader} data-tone={detail.tone}>
                  <span>
                    <StateDot state={lane} />
                    <h2 id={laneHeadingId}>{detail.label}</h2>
                  </span>
                </header>
                <div className={styles.laneCards}>
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
                    !(lane === "planned" && visibleAssignedGitlabReviews.length) &&
                    (lane === visibleLanes[0] &&
                    visibleWorkspaces.length === 0 &&
                    visibleAssignedGitlabReviews.length === 0 ? (
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
      )
    : undefined;
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
  const workbenchPrimaryActionLabel = workspaceMaterialization
    ? selectedPrimaryOpenLabel
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
            </div>
            <div
              className={styles.workspaceInlineViews}
              data-ui="workspace.tab-bar"
              data-ui-label="Workspace tabs"
            >
              <Tabs.List aria-label="Workspace views">
                <Tabs.Trigger value="overview">
                  {selectedGitlabReview ? "Review" : "Workspace"}
                </Tabs.Trigger>
                <Tabs.Trigger value="planning">
                  {selectedGitlabReview ? "Agent review" : "Plans"}
                </Tabs.Trigger>
                {workspaceMaterialization && (
                  <Tabs.Trigger value="changes">
                    {selectedGitlabReview ? "Code review" : "Changes"}
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
            className={styles.tabViewport}
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
                driftDetected={
                  workspaceActionErrorCode === "workspace_git_state_changed"
                }
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
                gitlabReview={selectedGitlabReview}
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
                <PlanningDocumentsPanel
                  client={client}
                  onCreatePlanningHome={createPlanningHome}
                  onNotice={setNotice}
                  workspaceId={selectedWorkspace.id}
                  workspaceKey={selectedWorkspace.key}
                />
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
                    gitlabReview={selectedGitlabReview}
                    initialRepositoryId={reviewRepositoryId}
                    materialization={workspaceMaterialization}
                    onOpenVerification={
                      selectedGitlabReview
                        ? undefined
                        : () => {
                            setActiveTab("verification");
                            pushNavigationPath(
                              `/sessions/${encodeURIComponent(selectedWorkspace.id)}/verification`,
                            );
                          }
                    }
                    onRepositoryChange={(repositoryId) => {
                      setReviewRepositoryId(repositoryId);
                      pushNavigationPath(
                        `/sessions/${encodeURIComponent(selectedWorkspace.id)}/changes?repository=${encodeURIComponent(repositoryId)}`,
                      );
                    }}
                    workspaceId={selectedWorkspace.id}
                  />
                </Suspense>
              </Tabs.Content>
            )}
            {!selectedGitlabReview && (
              <Tabs.Content value="verification">
                <VerificationPanel
                  client={client}
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
