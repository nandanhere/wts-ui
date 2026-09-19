import {
  type RuntimePlanSelection,
  type WorkspacePlanningSelection,
  type WorkspaceIntent,
  type WorkspaceWorkflowState,
  type WorkspaceView,
} from "../../lib/wtsClient";

export type Lane = "planned" | "active" | "attention" | "suspended";

export type Provider = "Codex" | "OpenCode" | "Hermes" | "VS Code" | "Copilot";

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
