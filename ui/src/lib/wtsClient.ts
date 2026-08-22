export type WorkspaceIntent =
  | {
      type: "jira";
      issueKey: string;
    }
  | {
      type: "openProject";
      workPackageId: number;
      displayId: string;
    }
  | {
      type: "repositorySet";
      label: string;
    };

export type WorkspaceProvider =
  | "codex"
  | "openCode"
  | "hermes"
  | "vsCode";

export type WorkspacePhase = "draft";
export type WorkspaceWorkflowState = "ready" | "active" | "review" | "parked";
export type WorkspaceBoardPlacementMode = "automatic" | "pinned";

export interface WorkspaceBoardPlacementSummary {
  mode: WorkspaceBoardPlacementMode;
  rank: number;
}

export interface WorkspaceWorkflowSummary {
  state: WorkspaceWorkflowState;
  revision: number;
  updatedAtUnixMs: number;
  placement?: WorkspaceBoardPlacementSummary;
}

export interface PlaceWorkspaceOnBoardRequest {
  state: WorkspaceWorkflowState;
  expectedRevision: number;
  beforeWorkspaceId?: string;
  afterWorkspaceId?: string;
}

export interface WorkspaceRepositoryRequest {
  repositoryId?: string;
  label: string;
  baseRef: string;
}

export type RuntimePortPolicy = "prefer" | "fixed";

export interface RuntimePortSelection {
  portId: string;
  preferredPort: number;
  policy: RuntimePortPolicy;
}

export interface RuntimeServiceSelection {
  candidateId: string;
  ports: RuntimePortSelection[];
}

export interface RuntimePlanSelection {
  analysisDigest: string;
  services: RuntimeServiceSelection[];
}

export type WorkspacePlanningFolder = "plans" | "plansAndKanban";
export type WorkspacePlanningFormat = "notes" | "kanban";

export interface WorkspacePlanningSelection {
  folder: WorkspacePlanningFolder;
  format: WorkspacePlanningFormat;
}

export type WorkspacePlanningDocumentId =
  | "readme"
  | "plan"
  | "findings"
  | "kanban"
  | "programBacklog";

export interface WorkspacePlanningDocumentDescriptor {
  documentId: WorkspacePlanningDocumentId;
  fileName: string;
}

export interface WorkspacePlanningDocumentList {
  workspaceId: string;
  documents: WorkspacePlanningDocumentDescriptor[];
}

export interface WorkspacePlanningDocument {
  workspaceId: string;
  documentId: WorkspacePlanningDocumentId;
  fileName: string;
  contents: string;
  sha256: string;
}

export type ReviewAuthor = "user" | "agent";
export type ReviewThreadState = "open" | "resolved";
export type ReviewAnchorState = "current" | "stale" | "unavailable";

export interface PlanningDocumentReviewTarget {
  kind: "planningDocument";
  documentId: WorkspacePlanningDocumentId;
  documentSha256: string;
  line?: number;
}

export interface VerificationCheckReviewTarget {
  kind: "verificationCheck";
  planRevision: number;
  completedAtUnixMs: number;
  checkId: string;
}

export interface CodeChangeReviewTarget {
  kind: "codeChange";
  repositoryId: string;
  baseCommitOid: string;
  headCommitOid: string;
  patchSha256: string;
  filePath: string;
  side: "additions" | "deletions";
  line: number;
}

export type ReviewTarget =
  | PlanningDocumentReviewTarget
  | VerificationCheckReviewTarget
  | CodeChangeReviewTarget;

export interface ReviewComment {
  commentId: string;
  author: ReviewAuthor;
  body: string;
  createdAtUnixMs: number;
}

export interface WorkspaceReviewThread {
  threadId: string;
  workspaceId: string;
  target: ReviewTarget;
  anchorState: ReviewAnchorState;
  currentDocumentSha256?: string;
  currentVerificationCompletedAtUnixMs?: number;
  state: ReviewThreadState;
  revision: number;
  comments: ReviewComment[];
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
  resolvedAtUnixMs?: number;
}

export interface WorkspaceReviewThreadList {
  workspaceId: string;
  threads: WorkspaceReviewThread[];
}

export type GithubReviewInboxState = "fresh" | "stale" | "auth" | "error";
export type GithubReviewDiagnosticCode =
  | "ghMissing"
  | "authenticationRequired"
  | "providerTimedOut"
  | "providerOutputTooLarge"
  | "providerFailed"
  | "providerResponseInvalid";

export interface GithubReview {
  id: string;
  repositoryId: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  updatedAt: string;
  draft: boolean;
}

export interface OpenGithubReviewResult {
  repositoryId: string;
  number: number;
  accepted: boolean;
}

export interface GithubReviewInbox {
  schemaVersion: 1;
  state: GithubReviewInboxState;
  reviews: GithubReview[];
  fetchedAtUnixMs: number | null;
  detail: string;
  diagnosticCode?: GithubReviewDiagnosticCode;
}

export const GITHUB_REVIEW_INBOX_HTTP_PATH = "/api/v1/reviews/github";
export const GITHUB_REVIEW_INBOX_TAURI_COMMAND = "get_github_review_inbox";
export const OPEN_GITHUB_REVIEW_TAURI_COMMAND = "open_github_review";
export function openGithubReviewHttpPath(repositoryId: string, number: number) {
  return `/api/v1/reviews/github/${encodeURIComponent(repositoryId)}/${number}/open`;
}

export interface GitlabReview {
  id: string;
  repositoryId: string;
  repository: string;
  number: number;
  title: string;
  authorLogin: string;
  sourceBranch: string;
  targetBranch: string;
  headCommitOid?: string;
  updatedAt: string;
  draft: boolean;
  reviewState: "requested" | "approved" | "changesAfterApproval";
  status: "open" | "merged" | "closed";
  commentCount?: number;
  discussionsResolved?: boolean;
}

export type GitlabReviewTarget = Pick<
  GitlabReview,
  "repositoryId" | "repository" | "number"
>;

export interface GitlabReviewInbox {
  schemaVersion: 1;
  state: GitlabMergeRequestInboxState;
  reviews: GitlabReview[];
  fetchedAtUnixMs: number | null;
  detail: string;
  diagnosticCode?: GitlabMergeRequestDiagnosticCode;
}

export const GITLAB_REVIEW_INBOX_HTTP_PATH = "/api/v1/reviews/gitlab";
export const GITLAB_REVIEW_INBOX_TAURI_COMMAND = "get_gitlab_review_inbox";
export const GITLAB_REVIEW_PATCH_TAURI_COMMAND = "get_gitlab_review_patch";
export const PUBLISH_GITLAB_REVIEW_COMMENT_TAURI_COMMAND =
  "publish_gitlab_review_comment";
export const PREPARE_GITLAB_REVIEW_REPOSITORY_TAURI_COMMAND =
  "prepare_gitlab_review_repository";
export function prepareGitlabReviewRepositoryHttpPath(
  repositoryId: string,
  iid: number,
) {
  return `/api/v1/reviews/gitlab/${encodeURIComponent(repositoryId)}/${iid}/prepare-repository`;
}

export interface GitlabReviewPatch {
  schemaVersion: 1;
  repositoryId: string;
  iid: number;
  baseCommitOid: string;
  startCommitOid: string;
  headCommitOid: string;
  selectedCommitOid?: string;
  commits: GitlabReviewCommit[];
  discussions: GitlabReviewDiscussion[];
  patch: string;
  patchTruncated: boolean;
  fromCache: boolean;
  fetchedAtUnixMs: number;
}

export interface GitlabReviewDiscussion {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  automated: boolean;
  filePath?: string;
  side?: "additions" | "deletions";
  line?: number;
  comments: GitlabReviewDiscussionComment[];
}

export interface GitlabReviewDiscussionComment {
  id: number;
  body: string;
  authorLogin: string;
  createdAt: string;
}

export interface GitlabReviewCommit {
  oid: string;
  parentOid?: string;
  shortId: string;
  title: string;
  authorName: string;
  authoredAt: string;
}

export interface GitlabReviewCommentRequest {
  body: string;
  filePath?: string;
  side?: "additions" | "deletions";
  line?: number;
}

export interface PublishGitlabReviewCommentResult {
  schemaVersion: 1;
  repositoryId: string;
  iid: number;
  accepted: boolean;
}

export interface CreateWorkspaceRequest {
  intent: WorkspaceIntent;
  title: string;
  preferredProvider: WorkspaceProvider;
  repositories: WorkspaceRepositoryRequest[];
  runtime?: RuntimePlanSelection;
  planning?: WorkspacePlanningSelection;
}

export interface WorkspaceRepositoryView {
  requestId: string;
  repositoryId?: string;
  label: string;
  baseRef: string;
  worktreeLeaf: string;
}

/**
 * A cheap, last-known list projection. It is display context only; opening or
 * acting on a workspace always asks Rust to validate the materialization.
 */
export interface WorkspaceLifecycleSummary {
  materializationState:
    | "unknown"
    | "notMaterialized"
    | "materialized"
    | "needsAttention";
  worktreeCount: number;
  observedAtUnixMs: number | null;
}

export interface ObservedWorkItem {
  issueKey: string;
  sourceFiles: string[];
  observedAtUnixMs: number;
}

export interface WorkspaceView {
  schemaVersion: number;
  workspaceId: string;
  recordVersion: number;
  intent: WorkspaceIntent;
  title: string;
  displayName?: string;
  phase: WorkspacePhase;
  preferredProvider: WorkspaceProvider;
  repositories: WorkspaceRepositoryView[];
  runtime?: RuntimePlanSelection;
  planning?: WorkspacePlanningSelection;
  observedWorkItems?: ObservedWorkItem[];
  workspaceRootId: string;
  workspaceLeaf: string;
  workspaceDisplayPath: string;
  lifecycle: WorkspaceLifecycleSummary;
  /** Present on trusted backend responses. Optional for legacy in-memory fixtures. */
  workflow?: WorkspaceWorkflowSummary;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface WorkspaceList {
  workspaceRootId: string;
  workspaceRootDisplayPath: string;
  workspaces: WorkspaceView[];
}

export interface CreateWorkspaceResult {
  workspace: WorkspaceView;
  replayed: boolean;
}

export type IntegrationId =
  | "git"
  | "vscode"
  | "warp"
  | "codex"
  | "openCode"
  | "hermes"
  | "graphify"
  | "jiraMcp"
  | "openProject";

export type IntegrationStatus =
  | "ready"
  | "notConfigured"
  | "notFound"
  | "error";

export interface IntegrationSnapshot {
  id: IntegrationId;
  category:
    | "sourceControl"
    | "editor"
    | "terminal"
    | "agent"
    | "knowledgeGraph"
    | "issueTracker";
  status: IntegrationStatus;
  installation: "missing" | "detected" | "unsupported";
  setup:
    | "notRequired"
    | "needsAuth"
    | "unverified"
    | "needsDependency"
    | "ready"
    | "incompatible";
  runtime: "idle" | "starting" | "running" | "failed";
  wtsSupport: "available" | "detectionOnly";
  verificationKind: "version" | "configurationSignal";
  capabilities: Array<
    | "worktreeMaterialization"
    | "workspaceLaunch"
    | "terminalSession"
    | "agentSession"
    | "graphIndexing"
    | "jiraIssueImport"
    | "openProjectWorkPackageImport"
  >;
  version?: string;
  detail?: string;
  diagnosticCode?: string;
  lastProbeAt: number;
  blockingFor: Array<
    | "worktreeMaterialization"
    | "vscodeLaunch"
    | "warpLaunch"
    | "codexLaunch"
    | "openCodeLaunch"
    | "hermesLaunch"
    | "graphIndexing"
    | "jiraIssueImport"
    | "openProjectWorkPackageImport"
  >;
}

export type BrowserJourneyCheckStatus =
  | "ready"
  | "unavailable"
  | "blocked";

export type BrowserJourneyDiscoverySource =
  | "configured"
  | "packaged"
  | "path";

export type BrowserJourneyDiagnosticCode =
  | "nodeUnavailable"
  | "nodeProbeFailed"
  | "fixedHelperUnavailable"
  | "fixedHelperInvalid"
  | "playwrightUnavailable"
  | "playwrightProbeFailed"
  | "chromiumUnavailable"
  | "chromiumProbeFailed"
  | "prerequisiteUnavailable";

export interface BrowserJourneyReadinessCheck {
  status: BrowserJourneyCheckStatus;
  source?: BrowserJourneyDiscoverySource;
  detail: string;
  diagnosticCode?: BrowserJourneyDiagnosticCode;
}

export interface BrowserJourneyReadiness {
  ready: boolean;
  node: BrowserJourneyReadinessCheck;
  fixedHelper: BrowserJourneyReadinessCheck;
  playwright: BrowserJourneyReadinessCheck;
  chromium: BrowserJourneyReadinessCheck;
}

export interface SetupSnapshot {
  checkedAtUnixMs: number;
  repositoryCount: number;
  integrations: IntegrationSnapshot[];
  /**
   * Optional only for compatibility with setup responses produced before the
   * local browser-journey runner existed.
   */
  browserJourneyReadiness?: BrowserJourneyReadiness;
}

export interface RepositorySummary {
  id: string;
  label: string;
  checkoutLeaf: string;
  displayPath: string;
  originUrl?: string;
  defaultBranch: {
    name: string;
    fullRef: string;
    commitOid: string;
  };
  availableBranches?: Array<{
    name: string;
    fullRef: string;
    commitOid: string;
    remote: boolean;
  }>;
}

export interface RepositoryCatalog {
  repositoryRootDisplayPath: string;
  repositories: RepositorySummary[];
  skippedEntries: number;
}

export interface CloneRepositoryRequest {
  remoteUrl: string;
}

export interface CloneRepositoryResult {
  repository: RepositorySummary;
  repositoryRootDisplayPath: string;
  reusedExisting: boolean;
}

export const CODE_WORKSPACE_FILE_MAX_BYTES = 48 * 1024;

export interface CodeWorkspaceFileImportRequest {
  fileName: string;
  contents: string;
}

export type CodeWorkspaceFolderStatus =
  | "matched"
  | "missing"
  | "ambiguous"
  | "unsupported";

export interface CodeWorkspaceImportFolder {
  name: string;
  rawPath: string;
  status: CodeWorkspaceFolderStatus;
  repositoryId?: string;
  repositoryLabel?: string;
  repositoryDisplayPath?: string;
  baseRef?: string;
  message?: string;
}

export type CodeWorkspaceImportWarningCode =
  | "configurationIgnored"
  | "folderMissing"
  | "folderAmbiguous"
  | "folderUnsupported"
  | "duplicateRepository";

export interface CodeWorkspaceImportWarning {
  code: CodeWorkspaceImportWarningCode;
  message: string;
  folderName?: string;
}

export type CodeWorkspaceDiagnosticResolutionBasis =
  | "absolutePath"
  | "relativePathSuffix"
  | "pathBasename"
  | "explicitName";

export type CodeWorkspaceDiagnosticMatchReason =
  | "matchedExactPath"
  | "matchedRelativePathSuffix"
  | "matchedPathBasename"
  | "matchedExplicitName"
  | "noCatalogMatch"
  | "ambiguousExactPath"
  | "ambiguousRelativePathSuffix"
  | "ambiguousPathBasename"
  | "ambiguousExplicitName"
  | "unsupportedFolder";

export interface CodeWorkspaceDiagnosticCatalog {
  repositoryRootDisplayPath: string;
  repositoryCount: number;
  skippedEntries: number;
  repositories: CodeWorkspaceDiagnosticCandidate[];
  repositoriesTruncated: boolean;
}

export interface CodeWorkspaceDiagnosticAttempt {
  basis: CodeWorkspaceDiagnosticResolutionBasis;
  value: string;
  candidateCount: number;
}

export interface CodeWorkspaceDiagnosticCandidate {
  label: string;
  displayPath: string;
}

export interface CodeWorkspaceFolderDiagnostic {
  folderIndex: number;
  status: CodeWorkspaceFolderStatus;
  reason: CodeWorkspaceDiagnosticMatchReason;
  resolutionBasis?: CodeWorkspaceDiagnosticResolutionBasis;
  attempts: CodeWorkspaceDiagnosticAttempt[];
  candidates: CodeWorkspaceDiagnosticCandidate[];
  candidatesTruncated: boolean;
  duplicateRepository: boolean;
}

export interface CodeWorkspaceImportDiagnostics {
  catalog: CodeWorkspaceDiagnosticCatalog;
  folders: CodeWorkspaceFolderDiagnostic[];
}

export interface CodeWorkspaceFileImportResult {
  importId: string;
  fileName: string;
  suggestedTitle: string;
  suggestedRepositorySetLabel: string;
  folders: CodeWorkspaceImportFolder[];
  repositories: WorkspaceRepositoryRequest[];
  warnings: CodeWorkspaceImportWarning[];
  diagnostics?: CodeWorkspaceImportDiagnostics;
}

export interface RuntimeAnalysisRequest {
  repositories: Array<
    WorkspaceRepositoryRequest & {
      repositoryId: string;
    }
  >;
}

export type RuntimeAnalysisConfidence =
  | "declared"
  | "corroborated"
  | "inferred"
  | "suggested";

export interface RuntimeAnalysisEvidence {
  repositoryId: string;
  commitOid: string;
  path: string;
  detector: string;
  detail: string;
}

export interface RuntimePortCandidate {
  portId: string;
  environment?: string;
  preferredPort?: number;
  policy: RuntimePortPolicy;
  confidence: RuntimeAnalysisConfidence;
  evidence: RuntimeAnalysisEvidence[];
}

export interface RuntimeServiceCandidate {
  candidateId: string;
  serviceId: string;
  displayName: string;
  repositoryId: string;
  repositoryLabel: string;
  commitOid: string;
  workingDirectory: string;
  command: string[];
  dependencies: string[];
  ports: RuntimePortCandidate[];
  confidence: RuntimeAnalysisConfidence;
  evidence: RuntimeAnalysisEvidence[];
  includedByDefault: boolean;
}

export interface RuntimeAnalyzedRepository {
  repositoryId: string;
  repositoryLabel: string;
  requestedBaseRef: string;
  resolvedBaseRef: string;
  commitOid: string;
}

export interface RuntimeAnalysisGraph {
  status: "unavailable" | "stale" | "ready";
  detail: string;
}

export interface RuntimeAnalysisResult {
  analysisDigest: string;
  repositories: RuntimeAnalyzedRepository[];
  services: RuntimeServiceCandidate[];
  warnings: string[];
  graph: RuntimeAnalysisGraph;
}

export interface PreflightBlocker {
  code:
    | "repositoryMissing"
    | "repositoryAmbiguous"
    | "gitUnavailable"
    | "baseReferenceUnavailable"
    | "branchConflict"
    | "targetConflict"
    | "unsafeWorkspacePath"
    | "runtimeAnalysisStale"
    | "gitPreflightFailed";
  message: string;
  repositoryLabel?: string;
  repositoryId?: string;
  requestedBaseRef?: string;
}

export interface PreflightRepository {
  repositoryId: string;
  label: string;
  sourceDisplayPath: string;
  requestedBaseRef: string;
  resolvedBaseRef: string;
  baseCommitOid: string;
  targetDisplayPath: string;
}

export interface GraphWorkspaceSummary {
  status: "notStarted" | "ready";
  detail: string;
}

export interface WorkspacePreflight {
  workspaceId: string;
  workspaceDisplayPath: string;
  codeWorkspaceDisplayPath: string;
  branchName: string;
  ready: boolean;
  effectDigest: string;
  repositories: PreflightRepository[];
  blockers: PreflightBlocker[];
  warnings: string[];
  graph: GraphWorkspaceSummary;
  runtime?: RuntimePlanSelection;
  planning?: WorkspacePlanningSelection;
}

export interface MaterializedWorktree {
  repositoryId: string;
  label: string;
  targetDisplayPath: string;
  branchName: string;
  baseCommitOid: string;
  gitState?: {
    headCommitOid: string;
    originUrl?: string;
    upstreamFullRef?: string;
  };
  activity?: {
    changedFileCount: number;
    commitsAhead: number;
  };
}

export interface WorkspaceMaterialization {
  schemaVersion: number;
  workspaceId: string;
  workspaceRecordVersion: number;
  effectDigest: string;
  workspaceDisplayPath: string;
  codeWorkspaceDisplayPath: string;
  branchName: string;
  worktrees: MaterializedWorktree[];
  graph: GraphWorkspaceSummary;
  runtime?: RuntimePlanSelection;
  planning?: WorkspacePlanningSelection;
}

export interface WorkspaceRepositoryDiff {
  schemaVersion: number;
  workspaceId: string;
  repositoryId: string;
  repositoryLabel: string;
  baseCommitOid: string;
  headCommitOid: string;
  patchSha256?: string;
  patch: string;
  patchTruncated: boolean;
  untrackedPaths: string[];
  untrackedPathsTruncated: boolean;
  reviewGraph?: WorkspaceRepositoryReviewGraph;
}

export interface WorkspaceRepositoryFileReview {
  schemaVersion: number;
  workspaceId: string;
  repositoryId: string;
  repositoryLabel: string;
  baseCommitOid: string;
  headCommitOid: string;
  filePath: string;
  patchSha256: string;
  contentSha256: string;
  content: string;
  fullPatch: string;
}

export interface WorkspaceRepositoryReviewGraph {
  graphSha256: string;
  nodes: WorkspaceRepositoryReviewNode[];
  links: WorkspaceRepositoryReviewLink[];
  truncated: boolean;
}

export interface WorkspaceRepositoryReviewNode {
  id: string;
  label: string;
  sourceFile: string;
  sourceLocation: string;
}

export interface WorkspaceRepositoryReviewLink {
  source: string;
  target: string;
  relation: string;
  confidence: string;
}

export interface WorkspaceRepositorySyncResult {
  workspaceId: string;
  repositoryId: string;
  repositoryLabel: string;
  previousBaseCommitOid: string;
  baseCommitOid: string;
  updated: boolean;
  graphRefreshed: boolean;
  graphDetail: string;
  materialization: WorkspaceMaterialization;
}

export interface WorkspaceRepositoryAlignmentPreflight {
  workspaceId: string;
  repositoryId: string;
  repositoryLabel: string;
  baseRef: string;
  remoteFullRef: string;
  currentCommitOid: string;
  targetCommitOid: string;
  backupFullRef: string;
  effectDigest: string;
}

export interface WorkspaceRepositoryAlignmentResult {
  workspaceId: string;
  repositoryId: string;
  repositoryLabel: string;
  previousBaseCommitOid: string;
  baseCommitOid: string;
  backupFullRef: string;
  graphRefreshed: boolean;
  graphDetail: string;
  materialization: WorkspaceMaterialization;
}

export interface MaterializeWorkspaceResult {
  replayed: boolean;
  materialization: WorkspaceMaterialization;
}

export interface OpenWorkspaceResult {
  provider: "vsCode";
  accepted: boolean;
  workspaceId: string;
  codeWorkspaceDisplayPath: string;
}

export type RepositoryForge = "github" | "gitlab";

export interface OpenRepositoryBaseResult {
  repositoryId: string;
  forge: RepositoryForge;
  host: string;
  baseRef: string;
  commitOid: string;
  accepted: boolean;
}

export interface ChangeRequestWorkItem {
  linkId: string;
  issueKey: string;
  summary: string;
}

export interface ChangeRequestCommit {
  commitOid: string;
  subject: string;
}

export interface WorkspaceChangeRequestDraft {
  schemaVersion: number;
  workspaceId: string;
  repositoryId: string;
  repositoryLabel: string;
  forge: RepositoryForge;
  host: string;
  sourceRemoteName: string;
  sourceBranch: string;
  sourceHeadCommitOid: string;
  targetBranch: string;
  commitSubject: string;
  proposedBySessionId: string;
  proposedByProvider: AgentProvider;
  commits: ChangeRequestCommit[];
  changedFiles: string[];
  worktreeClean: boolean;
  remoteMatches: boolean;
  title: string;
  body: string;
  workItems: ChangeRequestWorkItem[];
  verificationStatus: AgentChangeRequestVerificationStatus;
  verificationSummary: string;
  effectDigest: string;
}

export interface OpenWorkspaceChangeRequestResult {
  workspaceId: string;
  repositoryId: string;
  forge: RepositoryForge;
  host: string;
  sourceBranch: string;
  targetBranch: string;
  sourceHeadCommitOid: string;
  accepted: boolean;
}

export type GitlabMergeRequestInboxState =
  | "fresh"
  | "stale"
  | "auth"
  | "error";
export type GitlabMergeRequestDiagnosticCode =
  | "glabMissing"
  | "authenticationRequired"
  | "providerTimedOut"
  | "providerOutputTooLarge"
  | "providerFailed"
  | "providerResponseInvalid";

export interface GitlabMergeRequest {
  id: string;
  repositoryId: string;
  projectPath: string;
  iid: number;
  title: string;
  sourceBranch: string;
  sourceHeadCommitOid?: string;
  targetBranch: string;
  authorUsername: string;
  updatedAt: string;
  draft: boolean;
  status: "open" | "merged" | "closed";
}

export interface GitlabMergeRequestInbox {
  schemaVersion: 1;
  state: GitlabMergeRequestInboxState;
  mergeRequests: GitlabMergeRequest[];
  fetchedAtUnixMs: number | null;
  detail: string;
  diagnosticCode?: GitlabMergeRequestDiagnosticCode;
}

export interface OpenGitlabMergeRequestResult {
  repositoryId: string;
  iid: number;
  accepted: boolean;
}

export type GitlabCliState = "ready" | "missing";
export type GitlabAccountState = "signedIn" | "signedOut" | "error";

export interface GitlabIntegrationAccount {
  host: string;
  state: GitlabAccountState;
  username?: string;
}

export interface GitlabIntegrationStatus {
  schemaVersion: 1;
  cliState: GitlabCliState;
  accounts: GitlabIntegrationAccount[];
  detail: string;
}

export function gitlabMergeRequestInboxHttpPath(workspaceId: string) {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/merge-requests/gitlab`;
}

export function openGitlabMergeRequestHttpPath(
  repositoryId: string,
  iid: number,
) {
  return `/api/v1/repositories/${encodeURIComponent(repositoryId)}/merge-requests/gitlab/${iid}/open`;
}

export const GET_GITLAB_MERGE_REQUESTS_TAURI_COMMAND =
  "get_gitlab_merge_requests";
export const OPEN_GITLAB_MERGE_REQUEST_TAURI_COMMAND =
  "open_gitlab_merge_request";
export const GET_GITLAB_INTEGRATION_STATUS_TAURI_COMMAND =
  "get_gitlab_integration_status";

export function gitlabIntegrationStatusHttpPath(workspaceId: string) {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/integrations/gitlab`;
}

export type AppUpdateState =
  | "disabled"
  | "upToDate"
  | "available"
  | "downloading"
  | "ready"
  | "error";
export type AppUpdateDiagnosticCode =
  | "notConfigured"
  | "networkUnavailable"
  | "manifestInvalid"
  | "signatureInvalid"
  | "downloadFailed"
  | "installFailed";

export interface AppUpdateStatus {
  schemaVersion: 1;
  state: AppUpdateState;
  currentVersion: string;
  availableVersion?: string;
  publishedAt?: string;
  notes?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  detail: string;
  diagnosticCode?: AppUpdateDiagnosticCode;
}

export interface AppUpdateProgress {
  version: string;
  downloadedBytes: number;
  totalBytes?: number;
}

export interface RelaunchUpdatedAppResult {
  accepted: boolean;
}

export const GET_UPDATE_STATUS_TAURI_COMMAND = "get_update_status";
export const CHECK_FOR_UPDATE_TAURI_COMMAND = "check_for_update";
export const DOWNLOAD_AND_INSTALL_UPDATE_TAURI_COMMAND =
  "download_and_install_update";
export const RELAUNCH_UPDATED_APP_TAURI_COMMAND = "relaunch_updated_app";

export type AgentProvider = "codex" | "openCode" | "hermes";
export type TerminalProvider = "terminal" | "warp";

export interface WorkspaceCliLaunchResult {
  workspaceId: string;
  /** Present when the host supports the durable agent-session ledger. */
  sessionId?: string;
  provider: AgentProvider;
  terminal: TerminalProvider;
  accepted: boolean;
  workspaceDisplayPath: string;
}

export interface WorkspaceAgentBriefResult {
  workspaceId: string;
  workspaceDisplayPath: string;
  briefDisplayPath: string;
}

export interface GraphIndexResult {
  workspaceId: string;
  status: "ready";
  graphDisplayPath: string;
  detail: string;
  durationMs: number;
}

export type WorkspaceRemovalKind =
  | "savedPlan"
  | "materializedWorkspace";

export type RemovalBlockerCode =
  | "workspaceDrift"
  | "worktreeChanges"
  | "ignoredFiles"
  | "planningDocumentsPresent"
  | "unexpectedPath"
  | "gitUnavailable";

export interface RemovalBlocker {
  code: RemovalBlockerCode;
  message: string;
  repositoryLabel?: string;
}

export interface RemovalWorktreeSummary {
  repositoryId: string;
  label: string;
  targetDisplayPath: string;
  branchName: string;
  headCommitOid: string;
  present: boolean;
}

export interface RemovalProtectedPath {
  displayPath: string;
  entries: string[];
  entriesTruncated: boolean;
  filePreviews: RemovalProtectedFilePreview[];
}

export interface RemovalProtectedFilePreview {
  relativePath: string;
  contents: string;
}

export interface WorkspaceRemovalPreflight {
  workspaceId: string;
  kind: WorkspaceRemovalKind;
  workspaceDisplayPath: string;
  ready: boolean;
  effectDigest: string;
  worktrees: RemovalWorktreeSummary[];
  generatedPaths: string[];
  protectedPaths: RemovalProtectedPath[];
  retainedBranches: string[];
  blockers: RemovalBlocker[];
  warnings: string[];
}

export interface RemoveWorkspaceResult {
  workspaceId: string;
  replayed: boolean;
  removedWorktreeCount: number;
  retainedBranches: string[];
  removedGeneratedPaths: string[];
}

export interface AgentRunResult {
  workspaceId: string;
  provider: AgentProvider;
  succeeded: boolean;
  output: string;
  durationMs: number;
}

export type VerificationKind =
  | "unit"
  | "integration"
  | "ui"
  | "contract"
  | "lint"
  | "build"
  | "custom";

export type VerificationRunStatus =
  | "notRun"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "cancelled";

export type VerificationCheckStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "timedOut"
  | "skipped"
  | "cancelled";

export interface WorkspaceEvidenceRepository {
  repositoryId: string;
  label: string;
  requestedBaseRef: string;
  resolvedBaseRef: string;
  baseCommitOid: string;
  worktreeDisplayPath: string;
}

export interface WorkspaceEvidenceContext {
  schemaVersion: number;
  workspaceId: string;
  workspaceRecordVersion: number;
  title: string;
  intent: WorkspaceIntent;
  preferredProvider: WorkspaceProvider;
  branchName: string;
  workspaceDisplayPath: string;
  codeWorkspaceDisplayPath: string;
  evidenceDisplayPath: string;
  createdAtUnixMs: number;
  wtsVersion: string;
  repositories: WorkspaceEvidenceRepository[];
  allowedRepositoryIds: string[];
}

export interface WorkspaceGraphManifest {
  schemaVersion: number;
  workspaceId: string;
  status: "notStarted" | "ready" | "failed";
  graphDisplayPath: string | null;
  graphSha256: string | null;
  indexedAtUnixMs: number | null;
  indexedRepositories: Array<{
    repositoryId: string;
    commitOid: string;
  }>;
  detail: string;
}

export interface WorkspaceVerificationCheck {
  id: string;
  label: string;
  kind: VerificationKind;
  repositoryId: string | null;
  workingDirectory: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  outputLimitBytes: number;
  required: boolean;
  environmentNames: string[];
  acceptanceFiles: Array<{
    displayPath: string;
    sha256: string;
  }>;
}

export interface WorkspaceVerificationPlan {
  schemaVersion: number;
  workspaceId: string;
  revision: number;
  updatedAtUnixMs: number;
  checks: WorkspaceVerificationCheck[];
}

export interface WorkspaceVerificationCheckResult {
  checkId: string;
  status: VerificationCheckStatus;
  startedAtUnixMs: number | null;
  completedAtUnixMs: number | null;
  durationMs: number | null;
  exitCode: number | null;
  logDisplayPath: string | null;
  detail: string;
}

export interface WorkspaceVerificationResult {
  schemaVersion: number;
  workspaceId: string;
  planRevision: number;
  status: VerificationRunStatus;
  startedAtUnixMs: number | null;
  completedAtUnixMs: number | null;
  durationMs: number | null;
  checks: WorkspaceVerificationCheckResult[];
  warnings: string[];
}

export interface WorkspaceAgentEvidence {
  schemaVersion: number;
  runId: string;
  workspaceId: string;
  provider: AgentProvider;
  state: "running" | "succeeded" | "failed";
  startedAtUnixMs: number;
  completedAtUnixMs: number | null;
  durationMs: number | null;
  promptSha256: string;
  outputSha256: string | null;
  failure:
    | "unavailable"
    | "spawnFailed"
    | "timedOut"
    | "outputTooLarge"
    | "providerFailed"
    | null;
}

export type AgentReportStatus = "notReported" | "ready" | "invalid";
export type AgentFindingSeverity = "info" | "warning" | "critical";

export interface WorkspaceAgentFinding {
  id: string;
  title: string;
  detail: string;
  severity: AgentFindingSeverity;
  repositoryId: string | null;
  evidence: string[];
  flowIds?: string[];
}

export interface WorkspaceAgentProposedCheck {
  id: string;
  label: string;
  kind: VerificationKind;
  repositoryId: string;
  workingDirectory: string;
  executable: string;
  args: string[];
  timeoutMs: number;
  environmentNames: string[];
  reason: string;
  evidence: string[];
}

export interface WorkspaceAgentValidationStep {
  id: string;
  action: string;
  expected: string;
  evidence: string[];
}

export interface WorkspaceAgentValidationFlow {
  id: string;
  title: string;
  goal: string;
  prerequisites: string[];
  steps: WorkspaceAgentValidationStep[];
}

export interface WorkspaceAgentReportScope {
  coverage: "unassessed" | "partial" | "complete";
  graphStatus: "notStarted" | "ready" | "failed";
  graphSha256?: string;
  reviewedRepositoryIds: string[];
  unresolvedRepositoryIds: string[];
  skippedRepositories: Array<{
    repositoryId: string;
    reason: string;
  }>;
}

export interface WorkspaceAgentFlowEvidence {
  repositoryId: string;
  path: string;
  line?: number;
}

export interface WorkspaceAgentFlowStep {
  id: string;
  repositoryId: string;
  component: string;
  action: string;
  evidence: WorkspaceAgentFlowEvidence[];
}

export interface WorkspaceAgentFlow {
  id: string;
  title: string;
  kind: "user" | "service" | "operational";
  actors: string[];
  entryPoints: string[];
  steps: WorkspaceAgentFlowStep[];
  expectedOutcome: string;
  risks: string[];
  existingCoverage: string[];
  verificationCandidateIds: string[];
}

export interface WorkspaceAgentEnvironmentRequirement {
  id: string;
  repositoryId: string;
  kind: "toolchain" | "configuration" | "secret" | "service";
  name: string;
  required: boolean;
  source: "repository" | "generated" | "user" | "external";
  detail: string;
  evidence: WorkspaceAgentFlowEvidence[];
}

export interface WorkspaceAgentEnvironmentSetupStep {
  id: string;
  repositoryId: string;
  workingDirectory: string;
  action: string;
  command: string[];
  evidence: WorkspaceAgentFlowEvidence[];
}

export interface WorkspaceAgentEnvironmentPlan {
  status: "unassessed" | "planned" | "needsInput" | "blocked";
  summary: string;
  requirements: WorkspaceAgentEnvironmentRequirement[];
  setupSteps: WorkspaceAgentEnvironmentSetupStep[];
  unresolved: string[];
}

export interface WorkspaceAgentReport {
  schemaVersion: number;
  workspaceId: string;
  status: AgentReportStatus;
  displayPath: string;
  updatedAtUnixMs: number | null;
  summary: string;
  findings: WorkspaceAgentFinding[];
  nextActions: string[];
  proposedChecks: WorkspaceAgentProposedCheck[];
  validationFlows: WorkspaceAgentValidationFlow[];
  scope: WorkspaceAgentReportScope;
  environment: WorkspaceAgentEnvironmentPlan;
  flows: WorkspaceAgentFlow[];
  detail: string;
}

export interface WorkspaceEvidence {
  context: WorkspaceEvidenceContext;
  graphManifest: WorkspaceGraphManifest;
  verificationPlan: WorkspaceVerificationPlan;
  verificationResult: WorkspaceVerificationResult;
  verificationHistory?: WorkspaceVerificationResult[];
  agentReport: WorkspaceAgentReport;
  agentRuns: WorkspaceAgentEvidence[];
}

export type WorkspaceTestRunState =
  | "passed"
  | "failed"
  | "cancelled"
  | "timedOut"
  | "running";

export interface WorkspaceTestRunSummary {
  schemaVersion: number;
  runId: string;
  workspaceId: string;
  journeyId: string;
  title: string;
  state: WorkspaceTestRunState;
  startedAtUnixMs: number;
  completedAtUnixMs: number | null;
  durationMs: number | null;
  passedSteps: number;
  failedSteps: number;
  totalSteps: number;
  failedStepId: string | null;
  message: string | null;
  artifactsDisplayPath: string;
  graphSha256: string | null;
}

export interface WorkspaceTestRunList {
  schemaVersion: number;
  workspaceId: string;
  runs: WorkspaceTestRunSummary[];
}

export interface WorkspaceTestStepResult {
  stepId: string;
  label: string;
  kind: string;
  state: "passed" | "failed";
  startedAtUnixMs: number;
  completedAtUnixMs: number;
  durationMs: number;
  snapshotArtifactId: string | null;
  screenshotArtifactId: string | null;
  error: string | null;
}

export interface WorkspaceTestArtifact {
  artifactId: string;
  kind: "trace" | "failureScreenshot" | "stepSnapshot" | "screenshot";
  relativePath: string;
  displayPath: string;
  bytes: number;
  sha256: string;
}

export interface WorkspaceTestRunDetail {
  schemaVersion: number;
  runId: string;
  workspaceId: string;
  journeyId: string;
  state: Exclude<WorkspaceTestRunState, "running">;
  startedAtUnixMs: number;
  completedAtUnixMs: number;
  durationMs: number;
  steps: WorkspaceTestStepResult[];
  consoleErrors: Array<{
    kind: string;
    text: string;
    timestampUnixMs: number;
  }>;
  requests: Array<{
    method: string;
    url: string;
    status: number | null;
    failure: string | null;
  }>;
  artifacts: WorkspaceTestArtifact[];
  failure: {
    failedStepId: string | null;
    failedStepKind: string | null;
    name: string;
    message: string;
    consoleErrors: WorkspaceTestRunDetail["consoleErrors"];
    failedRequests: WorkspaceTestRunDetail["requests"];
    artifactIds: string[];
  } | null;
  graphSha256: string | null;
}

export interface RunWorkspaceTestJourneyRequest {
  journeyId: string;
  baseUrl: string;
}

export interface JiraMcpVerification {
  connected: boolean;
  serverName: string;
  serverVersion: string;
  issueTool: string;
}

export interface JiraIssueImport {
  issueKey: string;
  summary?: string;
  status?: string;
  content: string;
  suggestedRepositories: string[];
  repositoryRecommendations: RepositoryRecommendation[];
}

export type WorkspaceWorkItemRole =
  | "primary"
  | "related"
  | "createdFromWorkspace";

export interface WorkspaceWorkItemSnapshot {
  issueKey: string;
  summary?: string;
  status?: string;
  content: string;
  browserUrl?: string;
  fetchedAtUnixMs: number;
}

export interface WorkspaceWorkItemLinkPreview {
  schemaVersion: 1;
  workspaceId: string;
  provider: "jira";
  role: WorkspaceWorkItemRole;
  snapshot: WorkspaceWorkItemSnapshot;
  previewDigest: string;
}

export interface WorkspaceWorkItemLink {
  linkId: string;
  workspaceId: string;
  provider: "jira";
  role: WorkspaceWorkItemRole;
  snapshot: WorkspaceWorkItemSnapshot;
  revision: number;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface ConfirmWorkspaceWorkItemLinkResult {
  link: WorkspaceWorkItemLink;
  replayed: boolean;
}

export interface WorkspaceWorkItemLinkList {
  schemaVersion: 1;
  workspaceId: string;
  links: WorkspaceWorkItemLink[];
}

export interface WorkspaceWorkItemUnlinkResult {
  workspaceId: string;
  linkId: string;
  removedRevision: number;
}

export interface WorkspaceWorkItemOpenResult {
  workspaceId: string;
  issueKey: string;
  accepted: true;
}

export interface JiraCreateProposal {
  schemaVersion: 1;
  workspaceId: string;
  summary: string;
  description: string;
  sourceDocumentSha256?: string;
  canExecute: false;
  requiresExplicitApproval: true;
  detail: string;
}

export type RepositoryRecommendationSource =
  | "label"
  | "checkoutLeaf"
  | "localPath"
  | "originRemote"
  | "workspaceHistory";

export interface RepositoryRecommendation {
  repositoryId: string;
  label: string;
  confidence: number;
  reason: string;
  sources: RepositoryRecommendationSource[];
}

export interface JiraActiveIssue {
  issueKey: string;
  summary: string;
  status: string;
}

export interface JiraActiveIssueList {
  schemaVersion: 1;
  issues: JiraActiveIssue[];
  detail: string;
}

export interface OpenProjectVerification {
  connected: boolean;
  instanceName: string;
  apiVersion: string;
  authenticatedUser: string;
}

export interface OpenProjectWorkPackageImport {
  workPackageId: number;
  displayId: string;
  subject: string;
  status?: string;
  project?: string;
  content: string;
  suggestedRepositories: string[];
  repositoryRecommendations: RepositoryRecommendation[];
}

export type AgentSessionCategory =
  | "uncategorized"
  | "ideation"
  | "investigation"
  | "implementation"
  | "verification"
  | "review"
  | "other";

export type AgentSessionStatus =
  | "launching"
  | "handoffAccepted"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "interrupted";

export interface AgentSession {
  schemaVersion: 1;
  sessionId: string;
  workspaceId: string;
  provider: AgentProvider;
  terminal: TerminalProvider;
  category: AgentSessionCategory;
  status: AgentSessionStatus;
  startedAtUnixMs: number;
  lastHeartbeatAtUnixMs: number;
  endedAtUnixMs: number | null;
  failure:
    | "launchRejected"
    | "providerFailed"
    | "processExited"
    | "staleHeartbeat"
    | "launchOutcomeUnknown"
    | "userStopped"
    | null;
  needsInput?: AgentNeedsInput;
  changeRequestProposals?: AgentChangeRequestProposal[];
}

export interface AgentChangeRequestProposal {
  schemaVersion: 1;
  repositoryId: string;
  sourceHeadCommitOid: string;
  title: string;
  body: string;
  issueKeys: string[];
  verification?: AgentChangeRequestVerification;
}

export type AgentChangeRequestVerificationStatus =
  | "notReported"
  | "passed"
  | "partial"
  | "failed";

export interface AgentChangeRequestVerification {
  status: AgentChangeRequestVerificationStatus;
  summary: string;
}

export interface AgentNeedsInput {
  kind: "question" | "access";
  detail: "Agent has a question." | "Agent needs access.";
}

export type AgentObservationStatus =
  | "working"
  | "idle"
  | "interrupted"
  | "stale";

export type AgentObservationActivity =
  | "thinking"
  | "usingTools"
  | "editing"
  | "runningCommand"
  | "searching"
  | "delegating";

export type AgentObservationUpdateKind = "progress" | "completion";

export interface ObservedAgentSession {
  schemaVersion: 1;
  sessionId: string;
  workspaceId: string;
  provider: "codex" | "copilot";
  source: "codexVscodeRollout" | "copilotVscodeSnapshot";
  status: AgentObservationStatus;
  activity: AgentObservationActivity | null;
  model?: string;
  latestUpdate?: string;
  updateKind?: AgentObservationUpdateKind;
  needsInput?: AgentNeedsInput;
  changeRequestProposals?: AgentChangeRequestProposal[];
  startedAtUnixMs: number;
  lastEventAtUnixMs: number;
}

export interface LaunchAgentSessionRequest {
  provider: AgentProvider;
  prompt: string;
  category: AgentSessionCategory;
}

export interface AgentSessionList {
  schemaVersion: 1;
  sessions: AgentSession[];
  observedSessions?: ObservedAgentSession[];
}

export type AgentSessionEventKind =
  | "started"
  | "thinking"
  | "usesTool"
  | "editsFiles"
  | "runsCommand"
  | "searches"
  | "agentUpdate"
  | "needsQuestion"
  | "needsAccess"
  | "completed";

export interface AgentSessionEvent {
  sequence: number;
  observedAtUnixMs: number;
  kind: AgentSessionEventKind;
  summary: string;
}

export interface AgentSessionDetail {
  schemaVersion: 1;
  sessionId: string;
  workspaceId: string;
  provider: AgentProvider;
  task: string;
  modelSelection: {
    authority: "providerDefault";
    model?: string;
    reasoningEffort?: string;
  };
  events: AgentSessionEvent[];
  eventsTruncated: boolean;
}

export interface ActivityWatchStatus {
  state: "running" | "unavailable" | "incompatible";
  installation: "detected" | "unknown";
  endpoint: string;
  apiVersion?: "v0";
  serverVersion?: string;
  capabilities: Array<"status" | "dailyReview">;
  detail: string;
  diagnosticCode?:
    | "connectionFailed"
    | "requestTimedOut"
    | "responseTooLarge"
    | "responseInvalid"
    | "serverRejected";
}

export type ActivityWatchSessionKind =
  | "coding"
  | "agent"
  | "browser"
  | "communication"
  | "terminal"
  | "other";

export interface ActivityWatchSessionCandidate {
  id: string;
  kind: ActivityWatchSessionKind;
  startedAtUnixMs: number;
  endedAtUnixMs: number;
  durationSeconds: number;
  description: string;
  application?: string;
  activityEvidence?: string;
  jiraIssueKey?: string;
  suggestedJiraIssueKey?: string;
  jiraSuggestionConfidence?: number;
  jiraSuggestionReason?: string;
  sourceEventCount: number;
}

export interface ActivityWatchDailyReview {
  schemaVersion: 1;
  startedAtUnixMs: number;
  endedAtUnixMs: number;
  totalActiveSeconds: number;
  sessions: ActivityWatchSessionCandidate[];
  detail: string;
}

export interface WorkspaceClient {
  getGithubReviewInbox(): Promise<GithubReviewInbox>;
  openGithubReview(repositoryId: string, number: number): Promise<OpenGithubReviewResult>;
  getGitlabReviewInbox(): Promise<GitlabReviewInbox>;
  getGitlabReviewPatch(
    repositoryId: string,
    iid: number,
    commitOid?: string,
    refresh?: boolean,
  ): Promise<GitlabReviewPatch>;
  publishGitlabReviewComment(
    repositoryId: string,
    iid: number,
    request: GitlabReviewCommentRequest,
  ): Promise<PublishGitlabReviewCommentResult>;
  prepareGitlabReviewRepository(
    repositoryId: string,
    iid: number,
  ): Promise<CloneRepositoryResult>;
  listWorkspaces(): Promise<WorkspaceList>;
  getWorkspace(workspaceId: string): Promise<WorkspaceView>;
  renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceView>;
  transitionWorkspaceWorkflow(
    workspaceId: string,
    state: WorkspaceWorkflowState,
    expectedRevision: number,
  ): Promise<WorkspaceWorkflowSummary>;
  placeWorkspaceOnBoard(
    workspaceId: string,
    request: PlaceWorkspaceOnBoardRequest,
  ): Promise<WorkspaceWorkflowSummary>;
  followWorkspaceAgent(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkflowSummary>;
  listWorkspacePlanningDocuments(
    workspaceId: string,
  ): Promise<WorkspacePlanningDocumentList>;
  readWorkspacePlanningDocument(
    workspaceId: string,
    documentId: WorkspacePlanningDocumentId,
  ): Promise<WorkspacePlanningDocument>;
  updateWorkspacePlanningDocument(
    workspaceId: string,
    documentId: WorkspacePlanningDocumentId,
    expectedSha256: string,
    contents: string,
  ): Promise<WorkspacePlanningDocument>;
  listWorkspaceReviewThreads(
    workspaceId: string,
  ): Promise<WorkspaceReviewThreadList>;
  createWorkspaceReviewThread(
    workspaceId: string,
    target: ReviewTarget,
    body: string,
    author?: ReviewAuthor,
  ): Promise<WorkspaceReviewThread>;
  resolveWorkspaceReviewThread(
    workspaceId: string,
    threadId: string,
    expectedRevision: number,
  ): Promise<WorkspaceReviewThread>;
  previewWorkspaceJiraLink(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
  ): Promise<WorkspaceWorkItemLinkPreview>;
  confirmWorkspaceJiraLink(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
    expectedPreviewDigest: string,
    idempotencyKey: string,
  ): Promise<ConfirmWorkspaceWorkItemLinkResult>;
  openWorkspaceJiraPreview(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
    expectedPreviewDigest: string,
  ): Promise<WorkspaceWorkItemOpenResult>;
  listWorkspaceWorkItemLinks(
    workspaceId: string,
  ): Promise<WorkspaceWorkItemLinkList>;
  unlinkWorkspaceWorkItem(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkItemUnlinkResult>;
  openWorkspaceWorkItem(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkItemOpenResult>;
  proposeWorkspaceJiraIssue(workspaceId: string): Promise<JiraCreateProposal>;
  createWorkspace(
    request: CreateWorkspaceRequest,
    idempotencyKey: string,
  ): Promise<CreateWorkspaceResult>;
  getSetupSnapshot(): Promise<SetupSnapshot>;
  listRepositories(): Promise<RepositoryCatalog>;
  cloneRepository(
    request: CloneRepositoryRequest,
  ): Promise<CloneRepositoryResult>;
  refreshRepositoryBranches(repositoryId: string): Promise<RepositorySummary>;
  importCodeWorkspaceFile(
    request: CodeWorkspaceFileImportRequest,
  ): Promise<CodeWorkspaceFileImportResult>;
  analyzeWorkspaceRuntime(
    request: RuntimeAnalysisRequest,
  ): Promise<RuntimeAnalysisResult>;
  preflightWorkspace(workspaceId: string): Promise<WorkspacePreflight>;
  getWorkspaceMaterialization(
    workspaceId: string,
  ): Promise<WorkspaceMaterialization | null>;
  getWorkspaceRepositoryDiff(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryDiff>;
  getWorkspaceRepositoryFileReview(
    workspaceId: string,
    repositoryId: string,
    filePath: string,
    expectedPatchSha256: string,
  ): Promise<WorkspaceRepositoryFileReview>;
  getWorkspaceRepositoryReviewGraph(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryReviewGraph | null>;
  syncWorkspaceRepository(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositorySyncResult>;
  preflightWorkspaceRepositoryAlignment(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryAlignmentPreflight>;
  alignWorkspaceRepository(
    workspaceId: string,
    repositoryId: string,
    effectDigest: string,
  ): Promise<WorkspaceRepositoryAlignmentResult>;
  materializeWorkspace(
    workspaceId: string,
    effectDigest: string,
    idempotencyKey: string,
  ): Promise<MaterializeWorkspaceResult>;
  openWorkspaceInVscode(workspaceId: string): Promise<OpenWorkspaceResult>;
  openRepositoryBase(
    repositoryId: string,
    baseRef: string,
  ): Promise<OpenRepositoryBaseResult>;
  getGitlabMergeRequests(workspaceId: string): Promise<GitlabMergeRequestInbox>;
  openGitlabMergeRequest(
    repositoryId: string,
    iid: number,
  ): Promise<OpenGitlabMergeRequestResult>;
  getGitlabIntegrationStatus(
    workspaceId: string,
  ): Promise<GitlabIntegrationStatus>;
  getUpdateStatus(): Promise<AppUpdateStatus>;
  checkForUpdate(): Promise<AppUpdateStatus>;
  downloadAndInstallUpdate(): Promise<AppUpdateStatus>;
  relaunchUpdatedApp(): Promise<RelaunchUpdatedAppResult>;
  prepareWorkspaceChangeRequest(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceChangeRequestDraft>;
  openWorkspaceChangeRequestDraft(
    workspaceId: string,
    repositoryId: string,
    effectDigest: string,
    title: string,
    body: string,
  ): Promise<OpenWorkspaceChangeRequestResult>;
  openWorkspaceCli(
    workspaceId: string,
    provider: AgentProvider,
    terminal?: TerminalProvider,
  ): Promise<WorkspaceCliLaunchResult>;
  writeWorkspaceAgentBrief(
    workspaceId: string,
    taskMarkdown: string,
  ): Promise<WorkspaceAgentBriefResult>;
  indexWorkspaceGraph(workspaceId: string): Promise<GraphIndexResult>;
  reindexWorkspaceGraph(workspaceId: string): Promise<GraphIndexResult>;
  preflightWorkspaceRemoval(
    workspaceId: string,
  ): Promise<WorkspaceRemovalPreflight>;
  removeWorkspace(
    workspaceId: string,
    effectDigest: string,
    idempotencyKey: string,
    deleteProtectedPaths?: boolean,
  ): Promise<RemoveWorkspaceResult>;
  runWorkspaceAgent(
    workspaceId: string,
    provider: AgentProvider,
    prompt: string,
  ): Promise<AgentRunResult>;
  getWorkspaceEvidence(workspaceId: string): Promise<WorkspaceEvidence | null>;
  promoteAgentVerificationCheck(
    workspaceId: string,
    proposalId: string,
  ): Promise<WorkspaceEvidence>;
  runWorkspaceVerification(workspaceId: string): Promise<WorkspaceEvidence>;
  runWorkspaceVerificationCheck?(
    workspaceId: string,
    checkId: string,
  ): Promise<WorkspaceEvidence>;
  rerunFailedWorkspaceVerification?(
    workspaceId: string,
  ): Promise<WorkspaceEvidence>;
  cancelWorkspaceVerification?(
    workspaceId: string,
  ): Promise<WorkspaceEvidence>;
  listWorkspaceTestRuns?(
    workspaceId: string,
  ): Promise<WorkspaceTestRunList>;
  getWorkspaceTestRun?(
    workspaceId: string,
    runId: string,
  ): Promise<WorkspaceTestRunDetail>;
  runWorkspaceTestJourney?(
    workspaceId: string,
    request: RunWorkspaceTestJourneyRequest,
  ): Promise<WorkspaceTestRunSummary>;
  verifyJiraMcp(): Promise<JiraMcpVerification>;
  listActiveJiraIssues(): Promise<JiraActiveIssueList>;
  importJiraIssue(issueKey: string): Promise<JiraIssueImport>;
  verifyOpenProject(): Promise<OpenProjectVerification>;
  importOpenProjectWorkPackage(
    reference: string,
  ): Promise<OpenProjectWorkPackageImport>;
  listAgentSessions(workspaceId?: string): Promise<AgentSessionList>;
  getAgentSessionDetail(sessionId: string): Promise<AgentSessionDetail>;
  startAgentSessionPrototype(workspaceId: string): Promise<AgentSession>;
  heartbeatAgentSession(sessionId: string): Promise<AgentSession>;
  completeAgentSession(sessionId: string): Promise<AgentSession>;
  failAgentSession(sessionId: string): Promise<AgentSession>;
  launchAgentSession(
    workspaceId: string,
    request: LaunchAgentSessionRequest,
  ): Promise<AgentSession>;
  stopAgentSession(sessionId: string): Promise<AgentSession>;
  getActivityWatchStatus(endpoint?: string): Promise<ActivityWatchStatus>;
  getActivityWatchDailyReview(
    startedAtUnixMs: number,
    endedAtUnixMs: number,
    endpoint?: string,
  ): Promise<ActivityWatchDailyReview>;
}

export type WorkspaceClientRuntime = "auto" | "http" | "tauri";

export interface WorkspaceClientOptions {
  runtime?: WorkspaceClientRuntime;
  baseUrl?: string;
  fetch?: typeof fetch;
  invoke?: Invoke;
}

interface WorkspaceClientErrorOptions {
  code: string;
  status?: number;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * A transport-agnostic error suitable for rendering without exposing native
 * adapter details. Server-provided error codes are preserved when available.
 */
export class WorkspaceClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: WorkspaceClientErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "WorkspaceClientError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

type UnknownRecord = Record<string, unknown>;
type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const providers: readonly WorkspaceProvider[] = [
  "codex",
  "openCode",
  "hermes",
  "vsCode",
];

const agentProviders: readonly AgentProvider[] = [
  "codex",
  "openCode",
  "hermes",
];

export const terminalProviders: readonly TerminalProvider[] = [
  "terminal",
  "warp",
];

const integrationIds: readonly IntegrationId[] = [
  "git",
  "vscode",
  "warp",
  "codex",
  "openCode",
  "hermes",
  "graphify",
  "jiraMcp",
  "openProject",
];

function invalidPayload(path: string): never {
  throw new WorkspaceClientError(
    `WTS returned an invalid workspace payload at ${path}`,
    { code: "invalid_response" },
  );
}

function record(value: unknown, path: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidPayload(path);
  }
  return value as UnknownRecord;
}

function exactRecord(
  value: unknown,
  path: string,
  fields: readonly string[],
): UnknownRecord {
  const result = record(value, path);
  const unexpected = Object.keys(result).find(
    (field) => !fields.includes(field),
  );
  if (unexpected) {
    return invalidPayload(`${path}.${unexpected}`);
  }
  return result;
}

function stringField(
  value: unknown,
  path: string,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    return invalidPayload(path);
  }
  return value;
}

function arrayField(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return invalidPayload(path);
  return value;
}

function integerField(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return invalidPayload(path);
  }
  return value;
}

function booleanField(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    return invalidPayload(path);
  }
  return value;
}

function normalizeIntent(value: unknown, path: string): WorkspaceIntent {
  const raw = record(value, path);
  const type = stringField(raw.type, `${path}.type`);
  if (type === "jira") {
    return {
      type,
      issueKey: stringField(raw.issueKey, `${path}.issueKey`),
    };
  }
  if (type === "openProject") {
    const workPackageId = integerField(
      raw.workPackageId,
      `${path}.workPackageId`,
    );
    if (workPackageId === 0) {
      return invalidPayload(`${path}.workPackageId`);
    }
    return {
      type,
      workPackageId,
      displayId: stringField(raw.displayId, `${path}.displayId`),
    };
  }
  if (type === "repositorySet") {
    return {
      type,
      label: stringField(raw.label, `${path}.label`),
    };
  }
  return invalidPayload(`${path}.type`);
}

function normalizeProvider(
  value: unknown,
  path: string,
): WorkspaceProvider {
  if (
    typeof value !== "string" ||
    !providers.includes(value as WorkspaceProvider)
  ) {
    return invalidPayload(path);
  }
  return value as WorkspaceProvider;
}

function normalizeRepositoryView(
  value: unknown,
  path: string,
): WorkspaceRepositoryView {
  const raw = record(value, path);
  const repositoryId = optionalStringField(
    raw.repositoryId,
    `${path}.repositoryId`,
  );
  return {
    requestId: stringField(raw.requestId, `${path}.requestId`),
    ...(repositoryId === undefined ? {} : { repositoryId }),
    label: stringField(raw.label, `${path}.label`),
    baseRef: stringField(raw.baseRef, `${path}.baseRef`),
    worktreeLeaf: stringField(raw.worktreeLeaf, `${path}.worktreeLeaf`),
  };
}

function normalizeWorkspaceWorkflowState(
  value: unknown,
  path: string,
): WorkspaceWorkflowState {
  if (
    value !== "ready" &&
    value !== "active" &&
    value !== "review" &&
    value !== "parked"
  ) {
    return invalidPayload(path);
  }
  return value;
}

function normalizeWorkspaceWorkflow(
  value: unknown,
  path: string,
): WorkspaceWorkflowSummary {
  const raw = record(value, path);
  const revision = integerField(raw.revision, `${path}.revision`);
  if (revision < 1) return invalidPayload(`${path}.revision`);
  return {
    state: normalizeWorkspaceWorkflowState(raw.state, `${path}.state`),
    revision,
    updatedAtUnixMs: integerField(
      raw.updatedAtUnixMs,
      `${path}.updatedAtUnixMs`,
    ),
    placement:
      raw.placement === undefined
        ? undefined
        : normalizeWorkspaceBoardPlacement(raw.placement, `${path}.placement`),
  };
}

function normalizeWorkspaceBoardPlacement(
  value: unknown,
  path: string,
): WorkspaceBoardPlacementSummary {
  const raw = record(value, path);
  if (raw.mode !== "automatic" && raw.mode !== "pinned") {
    return invalidPayload(`${path}.mode`);
  }
  const rank = integerField(raw.rank, `${path}.rank`);
  if (rank < 0) return invalidPayload(`${path}.rank`);
  return { mode: raw.mode, rank };
}

function normalizePlanningDocumentId(
  value: unknown,
  path: string,
): WorkspacePlanningDocumentId {
  if (
    value !== "readme" &&
    value !== "plan" &&
    value !== "findings" &&
    value !== "kanban" &&
    value !== "programBacklog"
  ) {
    return invalidPayload(path);
  }
  return value;
}

function normalizePlanningDocumentList(
  value: unknown,
): WorkspacePlanningDocumentList {
  const raw = record(value, "planningDocumentList");
  if (!Array.isArray(raw.documents)) {
    return invalidPayload("planningDocumentList.documents");
  }
  return {
    workspaceId: stringField(
      raw.workspaceId,
      "planningDocumentList.workspaceId",
    ),
    documents: raw.documents.map((value, index) => {
      const path = `planningDocumentList.documents[${index}]`;
      const document = record(value, path);
      return {
        documentId: normalizePlanningDocumentId(
          document.documentId,
          `${path}.documentId`,
        ),
        fileName: stringField(document.fileName, `${path}.fileName`),
      };
    }),
  };
}

function normalizePlanningDocument(
  value: unknown,
): WorkspacePlanningDocument {
  const raw = record(value, "planningDocument");
  const sha256 = stringField(raw.sha256, "planningDocument.sha256");
  if (!/^sha256:[0-9a-f]{64}$/.test(sha256)) {
    return invalidPayload("planningDocument.sha256");
  }
  return {
    workspaceId: stringField(raw.workspaceId, "planningDocument.workspaceId"),
    documentId: normalizePlanningDocumentId(
      raw.documentId,
      "planningDocument.documentId",
    ),
    fileName: stringField(raw.fileName, "planningDocument.fileName"),
    contents: stringField(raw.contents, "planningDocument.contents"),
    sha256,
  };
}

function normalizeSha256(value: unknown, path: string): string {
  const sha256 = stringField(value, path);
  if (!/^sha256:[0-9a-f]{64}$/.test(sha256)) {
    return invalidPayload(path);
  }
  return sha256;
}

function normalizeReviewTarget(value: unknown, path: string): ReviewTarget {
  const tagged = record(value, path);
  if (tagged.kind === "planningDocument") {
    const raw = exactRecord(value, path, [
      "kind",
      "documentId",
      "documentSha256",
      "line",
    ]);
    let line: number | undefined;
    if (raw.line !== undefined) {
      line = integerField(raw.line, `${path}.line`);
      if (line < 1 || line > 1_000_000) {
        return invalidPayload(`${path}.line`);
      }
    }
    return {
      kind: "planningDocument",
      documentId: normalizePlanningDocumentId(
        raw.documentId,
        `${path}.documentId`,
      ),
      documentSha256: normalizeSha256(
        raw.documentSha256,
        `${path}.documentSha256`,
      ),
      ...(line === undefined ? {} : { line }),
    };
  }
  if (tagged.kind === "verificationCheck") {
    const raw = exactRecord(value, path, [
      "kind",
      "planRevision",
      "completedAtUnixMs",
      "checkId",
    ]);
    const planRevision = integerField(raw.planRevision, `${path}.planRevision`);
    const completedAtUnixMs = integerField(
      raw.completedAtUnixMs,
      `${path}.completedAtUnixMs`,
    );
    const checkId = stringField(raw.checkId, `${path}.checkId`);
    if (
      planRevision < 1 ||
      completedAtUnixMs < 0 ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(checkId)
    ) {
      return invalidPayload(path);
    }
    return {
      kind: "verificationCheck",
      planRevision,
      completedAtUnixMs,
      checkId,
    };
  }
  if (tagged.kind === "codeChange") {
    const raw = exactRecord(value, path, [
      "kind",
      "repositoryId",
      "baseCommitOid",
      "headCommitOid",
      "patchSha256",
      "filePath",
      "side",
      "line",
    ]);
    const repositoryId = stringField(raw.repositoryId, `${path}.repositoryId`);
    const baseCommitOid = stringField(raw.baseCommitOid, `${path}.baseCommitOid`);
    const headCommitOid = stringField(raw.headCommitOid, `${path}.headCommitOid`);
    const filePath = stringField(raw.filePath, `${path}.filePath`);
    const line = integerField(raw.line, `${path}.line`);
    if (
      repositoryId.trim() !== repositoryId ||
      repositoryId.length > 512 ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(baseCommitOid) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(headCommitOid) ||
      !validReviewFilePath(filePath) ||
      line < 1 ||
      line > 1_000_000
    ) {
      return invalidPayload(path);
    }
    return {
      kind: "codeChange",
      repositoryId,
      baseCommitOid,
      headCommitOid,
      patchSha256: normalizeSha256(raw.patchSha256, `${path}.patchSha256`),
      filePath,
      side: enumField(
        raw.side,
        ["additions", "deletions"] as const,
        `${path}.side`,
      ),
      line,
    };
  }
  return invalidPayload(`${path}.kind`);
}

function normalizeWorkspaceReviewThread(
  value: unknown,
  path = "reviewThread",
): WorkspaceReviewThread {
  const raw = exactRecord(value, path, [
    "threadId",
    "workspaceId",
    "target",
    "anchorState",
    "currentDocumentSha256",
    "currentVerificationCompletedAtUnixMs",
    "state",
    "revision",
    "comments",
    "createdAtUnixMs",
    "updatedAtUnixMs",
    "resolvedAtUnixMs",
  ]);
  if (!Array.isArray(raw.comments)) {
    return invalidPayload(`${path}.comments`);
  }
  const revision = integerField(raw.revision, `${path}.revision`);
  if (revision < 1) return invalidPayload(`${path}.revision`);
  const currentDocumentSha256 = raw.currentDocumentSha256 === undefined
    ? undefined
    : normalizeSha256(raw.currentDocumentSha256, `${path}.currentDocumentSha256`);
  const currentVerificationCompletedAtUnixMs =
    raw.currentVerificationCompletedAtUnixMs === undefined
      ? undefined
      : integerField(
          raw.currentVerificationCompletedAtUnixMs,
          `${path}.currentVerificationCompletedAtUnixMs`,
        );
  const resolvedAtUnixMs = raw.resolvedAtUnixMs === undefined
    ? undefined
    : integerField(raw.resolvedAtUnixMs, `${path}.resolvedAtUnixMs`);
  const target = normalizeReviewTarget(raw.target, `${path}.target`);
  const anchorState = enumField(
    raw.anchorState,
    ["current", "stale", "unavailable"] as const,
    `${path}.anchorState`,
  );
  const state = enumField(
    raw.state,
    ["open", "resolved"] as const,
    `${path}.state`,
  );
  if (
    raw.comments.length === 0 ||
    (target.kind === "planningDocument" &&
      (currentVerificationCompletedAtUnixMs !== undefined ||
        (anchorState === "current" && currentDocumentSha256 !== target.documentSha256) ||
        (anchorState === "stale" &&
          (currentDocumentSha256 === undefined ||
            currentDocumentSha256 === target.documentSha256)) ||
        (anchorState === "unavailable" && currentDocumentSha256 !== undefined))) ||
    (target.kind === "verificationCheck" &&
      (currentDocumentSha256 !== undefined ||
        (anchorState === "current" &&
          currentVerificationCompletedAtUnixMs !== target.completedAtUnixMs) ||
        (anchorState === "stale" &&
          currentVerificationCompletedAtUnixMs === target.completedAtUnixMs) ||
        (anchorState === "unavailable" &&
          currentVerificationCompletedAtUnixMs !== undefined))) ||
    (target.kind === "codeChange" &&
      (currentDocumentSha256 !== undefined ||
        currentVerificationCompletedAtUnixMs !== undefined)) ||
    (state === "open" && resolvedAtUnixMs !== undefined) ||
    (state === "resolved" && resolvedAtUnixMs === undefined)
  ) {
    return invalidPayload(path);
  }
  return {
    threadId: uuidField(raw.threadId, `${path}.threadId`),
    workspaceId: uuidField(raw.workspaceId, `${path}.workspaceId`),
    target,
    anchorState,
    ...(currentDocumentSha256 === undefined ? {} : { currentDocumentSha256 }),
    ...(currentVerificationCompletedAtUnixMs === undefined
      ? {}
      : { currentVerificationCompletedAtUnixMs }),
    state,
    revision,
    comments: raw.comments.map((value, index) => {
      const commentPath = `${path}.comments[${index}]`;
      const comment = exactRecord(value, commentPath, [
        "commentId",
        "author",
        "body",
        "createdAtUnixMs",
      ]);
      return {
        commentId: uuidField(comment.commentId, `${commentPath}.commentId`),
        author: enumField(
          comment.author,
          ["user", "agent"] as const,
          `${commentPath}.author`,
        ),
        body: stringField(comment.body, `${commentPath}.body`),
        createdAtUnixMs: integerField(
          comment.createdAtUnixMs,
          `${commentPath}.createdAtUnixMs`,
        ),
      };
    }),
    createdAtUnixMs: integerField(raw.createdAtUnixMs, `${path}.createdAtUnixMs`),
    updatedAtUnixMs: integerField(raw.updatedAtUnixMs, `${path}.updatedAtUnixMs`),
    ...(resolvedAtUnixMs === undefined ? {} : { resolvedAtUnixMs }),
  };
}

function normalizeWorkspaceReviewThreadList(
  value: unknown,
): WorkspaceReviewThreadList {
  const raw = exactRecord(value, "reviewThreadList", ["workspaceId", "threads"]);
  if (!Array.isArray(raw.threads)) {
    return invalidPayload("reviewThreadList.threads");
  }
  return {
    workspaceId: uuidField(raw.workspaceId, "reviewThreadList.workspaceId"),
    threads: raw.threads.map((thread, index) =>
      normalizeWorkspaceReviewThread(thread, `reviewThreadList.threads[${index}]`),
    ),
  };
}

function validateGithubReviewIdentity(repositoryId: string, number: number) {
  if (
    !repositoryId ||
    repositoryId.trim() !== repositoryId ||
    repositoryId.length > 160 ||
    /[\0\n\r\t]/.test(repositoryId) ||
    !Number.isInteger(number) ||
    number < 1
  ) {
    throw new WorkspaceClientError("A valid GitHub review is required", {
      code: "invalid_request",
    });
  }
}

export function normalizeGithubReviewInbox(
  value: unknown,
): GithubReviewInbox {
  const raw = exactRecord(value, "githubReviewInbox", [
    "schemaVersion",
    "state",
    "reviews",
    "fetchedAtUnixMs",
    "detail",
    "diagnosticCode",
  ]);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.reviews)) {
    return invalidPayload("githubReviewInbox");
  }
  const reviews = raw.reviews.map((value, index): GithubReview => {
    const path = `githubReviewInbox.reviews[${index}]`;
    const review = exactRecord(value, path, [
      "id",
      "repositoryId",
      "repository",
      "number",
      "title",
      "url",
      "authorLogin",
      "updatedAt",
      "draft",
    ]);
    const number = integerField(review.number, `${path}.number`);
    const url = stringField(review.url, `${path}.url`);
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return invalidPayload(`${path}.url`);
    }
    const updatedAt = stringField(review.updatedAt, `${path}.updatedAt`);
    if (
      number < 1 ||
      parsedUrl.protocol !== "https:" ||
      parsedUrl.username ||
      parsedUrl.password ||
      !updatedAt ||
      Number.isNaN(Date.parse(updatedAt))
    ) {
      return invalidPayload(path);
    }
    return {
      id: stringField(review.id, `${path}.id`),
      repositoryId: stringField(review.repositoryId, `${path}.repositoryId`),
      repository: stringField(review.repository, `${path}.repository`),
      number,
      title: stringField(review.title, `${path}.title`),
      url: parsedUrl.href,
      authorLogin: stringField(review.authorLogin, `${path}.authorLogin`),
      updatedAt,
      draft: booleanField(review.draft, `${path}.draft`),
    };
  });
  const fetchedAtUnixMs = raw.fetchedAtUnixMs === null
    ? null
    : integerField(raw.fetchedAtUnixMs, "githubReviewInbox.fetchedAtUnixMs");
  return {
    schemaVersion: 1,
    state: enumField(
      raw.state,
      ["fresh", "stale", "auth", "error"] as const,
      "githubReviewInbox.state",
    ),
    reviews,
    fetchedAtUnixMs,
    detail: stringField(raw.detail, "githubReviewInbox.detail"),
    ...(raw.diagnosticCode === undefined
      ? {}
      : {
          diagnosticCode: enumField(
            raw.diagnosticCode,
            [
              "ghMissing",
              "authenticationRequired",
              "providerTimedOut",
              "providerOutputTooLarge",
              "providerFailed",
              "providerResponseInvalid",
            ] as const,
            "githubReviewInbox.diagnosticCode",
          ),
        }),
  };
}

export function normalizeGitlabReviewInbox(value: unknown): GitlabReviewInbox {
  const raw = exactRecord(value, "gitlabReviewInbox", [
    "schemaVersion",
    "state",
    "reviews",
    "fetchedAtUnixMs",
    "detail",
    "diagnosticCode",
  ]);
  if (
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.reviews) ||
    raw.reviews.length > 50
  ) {
    return invalidPayload("gitlabReviewInbox");
  }
  const reviews = raw.reviews.map((value, index): GitlabReview => {
    const path = `gitlabReviewInbox.reviews[${index}]`;
    const review = exactRecord(value, path, [
      "id",
      "repositoryId",
      "repository",
      "number",
      "title",
      "authorLogin",
      "sourceBranch",
      "targetBranch",
      "headCommitOid",
      "updatedAt",
      "draft",
      "reviewState",
      "status",
      "commentCount",
      "discussionsResolved",
    ]);
    const number = integerField(review.number, `${path}.number`);
    const updatedAt = stringField(review.updatedAt, `${path}.updatedAt`);
    const commentCount =
      review.commentCount === undefined
        ? undefined
        : integerField(review.commentCount, `${path}.commentCount`);
    const headCommitOid =
      review.headCommitOid === undefined
        ? undefined
        : stringField(review.headCommitOid, `${path}.headCommitOid`);
    if (
      number < 1 ||
      Number.isNaN(Date.parse(updatedAt)) ||
      (headCommitOid !== undefined &&
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headCommitOid)) ||
      (commentCount !== undefined && (commentCount < 0 || commentCount > 10_000))
    ) {
      return invalidPayload(path);
    }
    return {
      id: stringField(review.id, `${path}.id`),
      repositoryId: stringField(review.repositoryId, `${path}.repositoryId`),
      repository: stringField(review.repository, `${path}.repository`),
      number,
      title: stringField(review.title, `${path}.title`),
      authorLogin: stringField(review.authorLogin, `${path}.authorLogin`),
      sourceBranch: stringField(review.sourceBranch, `${path}.sourceBranch`),
      targetBranch: stringField(review.targetBranch, `${path}.targetBranch`),
      ...(headCommitOid === undefined ? {} : { headCommitOid }),
      updatedAt,
      draft: booleanField(review.draft, `${path}.draft`),
      reviewState: enumField(
        review.reviewState,
        ["requested", "approved", "changesAfterApproval"] as const,
        `${path}.reviewState`,
      ),
      status: enumField(
        review.status,
        ["open", "merged", "closed"] as const,
        `${path}.status`,
      ),
      ...(commentCount === undefined ? {} : { commentCount }),
      ...(review.discussionsResolved === undefined
        ? {}
        : {
            discussionsResolved: booleanField(
              review.discussionsResolved,
              `${path}.discussionsResolved`,
            ),
          }),
    };
  });
  return {
    schemaVersion: 1,
    state: enumField(
      raw.state,
      ["fresh", "stale", "auth", "error"] as const,
      "gitlabReviewInbox.state",
    ),
    reviews,
    fetchedAtUnixMs:
      raw.fetchedAtUnixMs === null
        ? null
        : integerField(
            raw.fetchedAtUnixMs,
            "gitlabReviewInbox.fetchedAtUnixMs",
          ),
    detail: stringField(raw.detail, "gitlabReviewInbox.detail"),
    ...(raw.diagnosticCode === undefined
      ? {}
      : {
          diagnosticCode: enumField(
            raw.diagnosticCode,
            [
              "glabMissing",
              "authenticationRequired",
              "providerTimedOut",
              "providerOutputTooLarge",
              "providerFailed",
              "providerResponseInvalid",
            ] as const,
            "gitlabReviewInbox.diagnosticCode",
          ),
        }),
  };
}

export function normalizeGitlabReviewPatch(value: unknown): GitlabReviewPatch {
  const raw = exactRecord(value, "gitlabReviewPatch", [
    "schemaVersion", "repositoryId", "iid", "baseCommitOid",
    "startCommitOid", "headCommitOid", "selectedCommitOid", "commits", "discussions",
    "patch", "patchTruncated", "fromCache", "fetchedAtUnixMs",
  ]);
  const iid = integerField(raw.iid, "gitlabReviewPatch.iid");
  const repositoryId = stringField(raw.repositoryId, "gitlabReviewPatch.repositoryId");
  const baseCommitOid = stringField(raw.baseCommitOid, "gitlabReviewPatch.baseCommitOid");
  const startCommitOid = stringField(raw.startCommitOid, "gitlabReviewPatch.startCommitOid");
  const headCommitOid = stringField(raw.headCommitOid, "gitlabReviewPatch.headCommitOid");
  if (!Array.isArray(raw.commits) || raw.commits.length > 50) {
    return invalidPayload("gitlabReviewPatch.commits");
  }
  const commits = raw.commits.map((value, index) => {
    const path = `gitlabReviewPatch.commits[${index}]`;
    const commit = exactRecord(value, path, [
      "oid", "parentOid", "shortId", "title", "authorName", "authoredAt",
    ]);
    const oid = stringField(commit.oid, `${path}.oid`);
    const parentOid = commit.parentOid === undefined
      ? undefined
      : stringField(commit.parentOid, `${path}.parentOid`);
    if (!/^[0-9a-f]{40}$/i.test(oid) || (parentOid && !/^[0-9a-f]{40}$/i.test(parentOid))) {
      return invalidPayload(path);
    }
    return {
      oid,
      ...(parentOid ? { parentOid } : {}),
      shortId: stringField(commit.shortId, `${path}.shortId`),
      title: stringField(commit.title, `${path}.title`),
      authorName: stringField(commit.authorName, `${path}.authorName`),
      authoredAt: stringField(commit.authoredAt, `${path}.authoredAt`),
    };
  });
  if (!Array.isArray(raw.discussions) || raw.discussions.length > 100) {
    return invalidPayload("gitlabReviewPatch.discussions");
  }
  let discussionCommentCount = 0;
  const discussions = raw.discussions.map((value, index) => {
    const path = `gitlabReviewPatch.discussions[${index}]`;
    const discussion = exactRecord(value, path, [
      "id", "resolvable", "resolved", "automated", "filePath", "side", "line", "comments",
    ]);
    if (!Array.isArray(discussion.comments)) return invalidPayload(`${path}.comments`);
    discussionCommentCount += discussion.comments.length;
    if (discussionCommentCount > 200) return invalidPayload(`${path}.comments`);
    const filePath = discussion.filePath === undefined
      ? undefined
      : stringField(discussion.filePath, `${path}.filePath`);
    const side = discussion.side === undefined
      ? undefined
      : enumField(discussion.side, ["additions", "deletions"] as const, `${path}.side`);
    const line = discussion.line === undefined
      ? undefined
      : integerField(discussion.line, `${path}.line`);
    return {
      id: stringField(discussion.id, `${path}.id`),
      resolvable: booleanField(discussion.resolvable, `${path}.resolvable`),
      resolved: booleanField(discussion.resolved, `${path}.resolved`),
      automated: booleanField(discussion.automated, `${path}.automated`),
      ...(filePath ? { filePath } : {}),
      ...(side ? { side } : {}),
      ...(line !== undefined ? { line } : {}),
      comments: discussion.comments.map((commentValue, commentIndex) => {
        const commentPath = `${path}.comments[${commentIndex}]`;
        const comment = exactRecord(commentValue, commentPath, [
          "id", "body", "authorLogin", "createdAt",
        ]);
        return {
          id: integerField(comment.id, `${commentPath}.id`),
          body: stringField(comment.body, `${commentPath}.body`),
          authorLogin: stringField(comment.authorLogin, `${commentPath}.authorLogin`),
          createdAt: stringField(comment.createdAt, `${commentPath}.createdAt`),
        };
      }),
    };
  });
  const selectedCommitOid = raw.selectedCommitOid === undefined
    ? undefined
    : stringField(raw.selectedCommitOid, "gitlabReviewPatch.selectedCommitOid");
  const patch = typeof raw.patch === "string" ? raw.patch : invalidPayload("gitlabReviewPatch.patch");
  if (raw.schemaVersion !== 1 || !/^[0-9a-f]{40}$/i.test(baseCommitOid) || !/^[0-9a-f]{40}$/i.test(startCommitOid) || !/^[0-9a-f]{40}$/i.test(headCommitOid) || (selectedCommitOid && (!/^[0-9a-f]{40}$/i.test(selectedCommitOid) || !commits.some((commit) => commit.oid === selectedCommitOid))) || patch.length > 1024 * 1024) {
    return invalidPayload("gitlabReviewPatch");
  }
  validateGitlabMergeRequestIdentity(repositoryId, iid);
  return {
    schemaVersion: 1,
    repositoryId,
    iid,
    baseCommitOid,
    startCommitOid,
    headCommitOid,
    ...(selectedCommitOid ? { selectedCommitOid } : {}),
    commits,
    discussions,
    patch,
    patchTruncated: booleanField(raw.patchTruncated, "gitlabReviewPatch.patchTruncated"),
    fromCache: booleanField(raw.fromCache, "gitlabReviewPatch.fromCache"),
    fetchedAtUnixMs: integerField(raw.fetchedAtUnixMs, "gitlabReviewPatch.fetchedAtUnixMs"),
  };
}

function normalizePublishGitlabReviewCommentResult(value: unknown): PublishGitlabReviewCommentResult {
  const raw = exactRecord(value, "publishGitlabReviewCommentResult", ["schemaVersion", "repositoryId", "iid", "accepted"]);
  const repositoryId = stringField(raw.repositoryId, "publishGitlabReviewCommentResult.repositoryId");
  const iid = integerField(raw.iid, "publishGitlabReviewCommentResult.iid");
  if (raw.schemaVersion !== 1) return invalidPayload("publishGitlabReviewCommentResult");
  validateGitlabMergeRequestIdentity(repositoryId, iid);
  return { schemaVersion: 1, repositoryId, iid, accepted: booleanField(raw.accepted, "publishGitlabReviewCommentResult.accepted") };
}

function normalizeOpenGithubReviewResult(value: unknown): OpenGithubReviewResult {
  const raw = exactRecord(value, "openGithubReviewResult", [
    "repositoryId",
    "number",
    "accepted",
  ]);
  const number = integerField(raw.number, "openGithubReviewResult.number");
  const repositoryId = stringField(
    raw.repositoryId,
    "openGithubReviewResult.repositoryId",
  );
  validateGithubReviewIdentity(repositoryId, number);
  return {
    repositoryId,
    number,
    accepted: booleanField(raw.accepted, "openGithubReviewResult.accepted"),
  };
}

export function normalizeGitlabMergeRequestInbox(
  value: unknown,
): GitlabMergeRequestInbox {
  const raw = exactRecord(value, "gitlabMergeRequestInbox", [
    "schemaVersion",
    "state",
    "mergeRequests",
    "fetchedAtUnixMs",
    "detail",
    "diagnosticCode",
  ]);
  if (
    raw.schemaVersion !== 1
    || !Array.isArray(raw.mergeRequests)
    || raw.mergeRequests.length > 50
  ) {
    return invalidPayload("gitlabMergeRequestInbox");
  }
  const state = enumField(
    raw.state,
    ["fresh", "stale", "auth", "error"] as const,
    "gitlabMergeRequestInbox.state",
  );
  const mergeRequests = raw.mergeRequests.map(
    (value, index): GitlabMergeRequest => {
      const path = `gitlabMergeRequestInbox.mergeRequests[${index}]`;
      const item = exactRecord(value, path, [
        "id",
        "repositoryId",
        "projectPath",
        "iid",
        "title",
        "sourceBranch",
        "sourceHeadCommitOid",
        "targetBranch",
        "authorUsername",
        "updatedAt",
        "draft",
        "status",
      ]);
      const iid = integerField(item.iid, `${path}.iid`);
      const updatedAt = stringField(item.updatedAt, `${path}.updatedAt`);
      if (iid < 1 || Number.isNaN(Date.parse(updatedAt))) {
        return invalidPayload(path);
      }
      const sourceHeadCommitOid = optionalStringField(
        item.sourceHeadCommitOid,
        `${path}.sourceHeadCommitOid`,
      );
      if (
        sourceHeadCommitOid !== undefined
        && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sourceHeadCommitOid)
      ) {
        return invalidPayload(`${path}.sourceHeadCommitOid`);
      }
      return {
        id: stringField(item.id, `${path}.id`),
        repositoryId: stringField(item.repositoryId, `${path}.repositoryId`),
        projectPath: stringField(item.projectPath, `${path}.projectPath`),
        iid,
        title: stringField(item.title, `${path}.title`),
        sourceBranch: stringField(item.sourceBranch, `${path}.sourceBranch`),
        ...(sourceHeadCommitOid === undefined ? {} : { sourceHeadCommitOid }),
        targetBranch: stringField(item.targetBranch, `${path}.targetBranch`),
        authorUsername: stringField(
          item.authorUsername,
          `${path}.authorUsername`,
        ),
        updatedAt,
        draft: booleanField(item.draft, `${path}.draft`),
        status: enumField(
          item.status,
          ["open", "merged", "closed"] as const,
          `${path}.status`,
        ),
      };
    },
  );
  const fetchedAtUnixMs = raw.fetchedAtUnixMs === null
    ? null
    : integerField(raw.fetchedAtUnixMs, "gitlabMergeRequestInbox.fetchedAtUnixMs");
  return {
    schemaVersion: 1,
    state,
    mergeRequests,
    fetchedAtUnixMs,
    detail: stringField(raw.detail, "gitlabMergeRequestInbox.detail"),
    ...(raw.diagnosticCode === undefined
      ? {}
      : {
          diagnosticCode: enumField(
            raw.diagnosticCode,
            [
              "glabMissing",
              "authenticationRequired",
              "providerTimedOut",
              "providerOutputTooLarge",
              "providerFailed",
              "providerResponseInvalid",
            ] as const,
            "gitlabMergeRequestInbox.diagnosticCode",
          ),
        }),
  };
}

function gitlabHostField(value: unknown, path: string): string {
  const host = stringField(value, path);
  if (
    host.length > 253
    || host.includes("..")
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/i.test(host)
  ) {
    return invalidPayload(path);
  }
  return host;
}

export function normalizeGitlabIntegrationStatus(
  value: unknown,
): GitlabIntegrationStatus {
  const raw = exactRecord(value, "gitlabIntegrationStatus", [
    "schemaVersion",
    "cliState",
    "accounts",
    "detail",
  ]);
  const accounts = arrayField(
    raw.accounts,
    "gitlabIntegrationStatus.accounts",
  );
  if (raw.schemaVersion !== 1 || accounts.length > 20) {
    return invalidPayload("gitlabIntegrationStatus");
  }
  const seenHosts = new Set<string>();
  const normalizedAccounts = accounts.map((value, index) => {
    const path = `gitlabIntegrationStatus.accounts[${index}]`;
    const account = exactRecord(value, path, [
      "host",
      "state",
      "username",
    ]);
    const host = gitlabHostField(account.host, `${path}.host`);
    const hostIdentity = host.toLowerCase();
    if (seenHosts.has(hostIdentity)) return invalidPayload(`${path}.host`);
    seenHosts.add(hostIdentity);
    const username = optionalStringField(account.username, `${path}.username`);
    if (username !== undefined && Array.from(username).length > 128) {
      return invalidPayload(`${path}.username`);
    }
    return {
      host,
      state: enumField(
        account.state,
        ["signedIn", "signedOut", "error"] as const,
        `${path}.state`,
      ),
      ...(username === undefined ? {} : { username }),
    };
  });
  return {
    schemaVersion: 1,
    cliState: enumField(
      raw.cliState,
      ["ready", "missing"] as const,
      "gitlabIntegrationStatus.cliState",
    ),
    accounts: normalizedAccounts,
    detail: stringField(raw.detail, "gitlabIntegrationStatus.detail"),
  };
}

function validateGitlabMergeRequestIdentity(
  repositoryId: string,
  iid: number,
) {
  requiredChangeRequestRepositoryId(repositoryId);
  if (!Number.isSafeInteger(iid) || iid < 1) {
    throw new WorkspaceClientError("A valid GitLab merge request is required", {
      code: "invalid_request",
    });
  }
}

function normalizeOpenGitlabMergeRequestResult(
  value: unknown,
): OpenGitlabMergeRequestResult {
  const raw = exactRecord(value, "openGitlabMergeRequestResult", [
    "repositoryId",
    "iid",
    "accepted",
  ]);
  const result = {
    repositoryId: stringField(
      raw.repositoryId,
      "openGitlabMergeRequestResult.repositoryId",
    ),
    iid: integerField(raw.iid, "openGitlabMergeRequestResult.iid"),
    accepted: booleanField(
      raw.accepted,
      "openGitlabMergeRequestResult.accepted",
    ),
  };
  validateGitlabMergeRequestIdentity(result.repositoryId, result.iid);
  return result;
}

export function normalizeAppUpdateStatus(value: unknown): AppUpdateStatus {
  const MAX_UPDATE_BYTES = 512 * 1024 * 1024;
  const boundedText = (rawValue: unknown, path: string, maxLength: number) => {
    const result = stringField(rawValue, path);
    if (result.length > maxLength) return invalidPayload(path);
    return result;
  };
  const optionalBoundedText = (
    rawValue: unknown,
    path: string,
    maxLength: number,
  ) => {
    const result = optionalStringField(rawValue, path);
    if (result !== undefined && result.length > maxLength) {
      return invalidPayload(path);
    }
    return result;
  };
  const semver = (rawValue: unknown, path: string) => {
    const result = boundedText(rawValue, path, 64);
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(result)) {
      return invalidPayload(path);
    }
    return result;
  };
  const raw = exactRecord(value, "appUpdateStatus", [
    "schemaVersion",
    "state",
    "currentVersion",
    "availableVersion",
    "publishedAt",
    "notes",
    "downloadedBytes",
    "totalBytes",
    "detail",
    "diagnosticCode",
  ]);
  if (raw.schemaVersion !== 1) return invalidPayload("appUpdateStatus.schemaVersion");
  const state = enumField(
    raw.state,
    ["disabled", "upToDate", "available", "downloading", "ready", "error"] as const,
    "appUpdateStatus.state",
  );
  const availableVersionRaw = optionalBoundedText(
    raw.availableVersion,
    "appUpdateStatus.availableVersion",
    64,
  );
  const availableVersion = availableVersionRaw === undefined
    ? undefined
    : semver(availableVersionRaw, "appUpdateStatus.availableVersion");
  const publishedAt = optionalBoundedText(
    raw.publishedAt,
    "appUpdateStatus.publishedAt",
    64,
  );
  if (publishedAt && Number.isNaN(Date.parse(publishedAt))) {
    return invalidPayload("appUpdateStatus.publishedAt");
  }
  const notes = optionalBoundedText(raw.notes, "appUpdateStatus.notes", 4_000);
  const downloadedBytes = raw.downloadedBytes === undefined
    ? undefined
    : integerField(raw.downloadedBytes, "appUpdateStatus.downloadedBytes");
  const totalBytes = raw.totalBytes === undefined
    ? undefined
    : integerField(raw.totalBytes, "appUpdateStatus.totalBytes");
  if (
    ["available", "downloading", "ready"].includes(state) &&
    availableVersion === undefined
  ) {
    return invalidPayload("appUpdateStatus.availableVersion");
  }
  if (
    downloadedBytes !== undefined &&
    totalBytes !== undefined &&
    downloadedBytes > totalBytes
  ) {
    return invalidPayload("appUpdateStatus.downloadedBytes");
  }
  if (
    (downloadedBytes !== undefined && downloadedBytes > MAX_UPDATE_BYTES) ||
    (totalBytes !== undefined && totalBytes > MAX_UPDATE_BYTES)
  ) {
    return invalidPayload("appUpdateStatus.totalBytes");
  }
  const diagnosticCode = raw.diagnosticCode === undefined
    ? undefined
    : enumField(
        raw.diagnosticCode,
        [
          "notConfigured",
          "networkUnavailable",
          "manifestInvalid",
          "signatureInvalid",
          "downloadFailed",
          "installFailed",
        ] as const,
        "appUpdateStatus.diagnosticCode",
      );
  if (
    (state === "disabled" && diagnosticCode !== "notConfigured") ||
    (state === "error" &&
      (diagnosticCode === undefined || diagnosticCode === "notConfigured")) ||
    (state !== "disabled" && state !== "error" && diagnosticCode !== undefined)
  ) {
    return invalidPayload("appUpdateStatus.diagnosticCode");
  }
  if (
    (state === "upToDate" || state === "disabled" || state === "error") &&
    availableVersion !== undefined
  ) {
    return invalidPayload("appUpdateStatus.availableVersion");
  }
  return {
    schemaVersion: 1,
    state,
    currentVersion: semver(raw.currentVersion, "appUpdateStatus.currentVersion"),
    ...(availableVersion === undefined ? {} : { availableVersion }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...(notes === undefined ? {} : { notes }),
    ...(downloadedBytes === undefined ? {} : { downloadedBytes }),
    ...(totalBytes === undefined ? {} : { totalBytes }),
    detail: boundedText(raw.detail, "appUpdateStatus.detail", 2_048),
    ...(diagnosticCode === undefined ? {} : { diagnosticCode }),
  };
}

export function normalizeAppUpdateProgress(value: unknown): AppUpdateProgress {
  const raw = exactRecord(value, "appUpdateProgress", [
    "version",
    "downloadedBytes",
    "totalBytes",
  ]);
  const version = stringField(raw.version, "appUpdateProgress.version");
  if (
    version.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)
  ) {
    return invalidPayload("appUpdateProgress.version");
  }
  const downloadedBytes = integerField(
    raw.downloadedBytes,
    "appUpdateProgress.downloadedBytes",
  );
  const totalBytes = raw.totalBytes === undefined
    ? undefined
    : integerField(raw.totalBytes, "appUpdateProgress.totalBytes");
  if (
    downloadedBytes > 512 * 1024 * 1024 ||
    (totalBytes !== undefined &&
      (totalBytes > 512 * 1024 * 1024 || downloadedBytes > totalBytes))
  ) {
    return invalidPayload("appUpdateProgress.downloadedBytes");
  }
  return {
    version,
    downloadedBytes,
    ...(totalBytes === undefined ? {} : { totalBytes }),
  };
}

function normalizeRelaunchUpdatedAppResult(
  value: unknown,
): RelaunchUpdatedAppResult {
  const raw = exactRecord(value, "relaunchUpdatedAppResult", ["accepted"]);
  return {
    accepted: booleanField(raw.accepted, "relaunchUpdatedAppResult.accepted"),
  };
}

function normalizeWorkspace(
  value: unknown,
  path = "workspace",
): WorkspaceView {
  const raw = record(value, path);
  if (raw.phase !== "draft") {
    return invalidPayload(`${path}.phase`);
  }
  if (!Array.isArray(raw.repositories)) {
    return invalidPayload(`${path}.repositories`);
  }
  const lifecycle = record(raw.lifecycle, `${path}.lifecycle`);
  const workflow = normalizeWorkspaceWorkflow(raw.workflow, `${path}.workflow`);
  if (
    lifecycle.materializationState !== "unknown" &&
    lifecycle.materializationState !== "notMaterialized" &&
    lifecycle.materializationState !== "materialized" &&
    lifecycle.materializationState !== "needsAttention"
  ) {
    return invalidPayload(`${path}.lifecycle.materializationState`);
  }
  const observedAtUnixMs =
    lifecycle.observedAtUnixMs === null
      ? null
      : integerField(
          lifecycle.observedAtUnixMs,
          `${path}.lifecycle.observedAtUnixMs`,
        );
  const worktreeCount = integerField(
    lifecycle.worktreeCount,
    `${path}.lifecycle.worktreeCount`,
  );
  const runtime =
    raw.runtime === undefined
      ? undefined
      : normalizeRuntimePlanSelection(raw.runtime, `${path}.runtime`);
  const planning =
    raw.planning === undefined
      ? undefined
      : normalizePlanningSelection(raw.planning, `${path}.planning`);
  if (raw.observedWorkItems !== undefined && !Array.isArray(raw.observedWorkItems)) {
    return invalidPayload(`${path}.observedWorkItems`);
  }
  const observedWorkItems = (raw.observedWorkItems ?? []).map((value, index) => {
    const itemPath = `${path}.observedWorkItems[${index}]`;
    const item = record(value, itemPath);
    if (!Array.isArray(item.sourceFiles)) {
      return invalidPayload(`${itemPath}.sourceFiles`);
    }
    return {
      issueKey: stringField(item.issueKey, `${itemPath}.issueKey`),
      sourceFiles: item.sourceFiles.map((source, sourceIndex) =>
        stringField(source, `${itemPath}.sourceFiles[${sourceIndex}]`),
      ),
      observedAtUnixMs: integerField(
        item.observedAtUnixMs,
        `${itemPath}.observedAtUnixMs`,
      ),
    };
  });
  if (
    (lifecycle.materializationState === "unknown" &&
      (worktreeCount !== 0 || observedAtUnixMs !== null)) ||
    (lifecycle.materializationState !== "unknown" &&
      observedAtUnixMs === null) ||
    (lifecycle.materializationState === "materialized" &&
      worktreeCount === 0) ||
    (lifecycle.materializationState !== "materialized" &&
      worktreeCount !== 0)
  ) {
    return invalidPayload(`${path}.lifecycle`);
  }

  return {
    schemaVersion: integerField(raw.schemaVersion, `${path}.schemaVersion`),
    workspaceId: stringField(raw.workspaceId, `${path}.workspaceId`),
    recordVersion: integerField(raw.recordVersion, `${path}.recordVersion`),
    intent: normalizeIntent(raw.intent, `${path}.intent`),
    title: stringField(raw.title, `${path}.title`),
    displayName:
      raw.displayName === undefined
        ? undefined
        : stringField(raw.displayName, `${path}.displayName`),
    phase: "draft",
    preferredProvider: normalizeProvider(
      raw.preferredProvider,
      `${path}.preferredProvider`,
    ),
    repositories: raw.repositories.map((repository, index) =>
      normalizeRepositoryView(
        repository,
        `${path}.repositories[${index}]`,
      ),
    ),
    ...(runtime === undefined ? {} : { runtime }),
    ...(planning === undefined ? {} : { planning }),
    observedWorkItems,
    workspaceRootId: stringField(
      raw.workspaceRootId,
      `${path}.workspaceRootId`,
    ),
    workspaceLeaf: stringField(raw.workspaceLeaf, `${path}.workspaceLeaf`),
    workspaceDisplayPath: stringField(
      raw.workspaceDisplayPath,
      `${path}.workspaceDisplayPath`,
    ),
    lifecycle: {
      materializationState: lifecycle.materializationState,
      worktreeCount,
      observedAtUnixMs,
    },
    workflow,
    createdAtUnixMs: integerField(
      raw.createdAtUnixMs,
      `${path}.createdAtUnixMs`,
    ),
    updatedAtUnixMs: integerField(
      raw.updatedAtUnixMs,
      `${path}.updatedAtUnixMs`,
    ),
  };
}

function normalizeWorkspaceList(value: unknown): WorkspaceList {
  const raw = record(value, "workspaceList");
  if (!Array.isArray(raw.workspaces)) {
    return invalidPayload("workspaceList.workspaces");
  }
  return {
    workspaceRootId: stringField(
      raw.workspaceRootId,
      "workspaceList.workspaceRootId",
    ),
    workspaceRootDisplayPath: stringField(
      raw.workspaceRootDisplayPath,
      "workspaceList.workspaceRootDisplayPath",
    ),
    workspaces: raw.workspaces.map((workspace, index) =>
      normalizeWorkspace(workspace, `workspaceList.workspaces[${index}]`),
    ),
  };
}

function normalizeCreateResult(value: unknown): CreateWorkspaceResult {
  const raw = record(value, "createWorkspaceResult");
  return {
    workspace: normalizeWorkspace(
      raw.workspace,
      "createWorkspaceResult.workspace",
    ),
    replayed: booleanField(
      raw.replayed,
      "createWorkspaceResult.replayed",
    ),
  };
}

function optionalStringField(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return stringField(value, path);
}

function uuidField(value: unknown, path: string): string {
  const candidate = stringField(value, path);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      candidate,
    )
  ) {
    return invalidPayload(path);
  }
  return candidate;
}

function optionalNullableStringField(
  value: unknown,
  path: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringField(value, path);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) return invalidPayload(path);
  return value.map((item, index) =>
    stringField(item, `${path}[${index}]`),
  );
}

function enumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    return invalidPayload(path);
  }
  return value as T;
}

function positiveInteger(value: unknown, path: string): number {
  const result = integerField(value, path);
  if (!Number.isSafeInteger(result) || result <= 0) {
    return invalidPayload(path);
  }
  return result;
}

function requiredSha256(value: unknown, path: string): string {
  const digest = stringField(value, path);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return invalidPayload(path);
  }
  return digest;
}

const runtimePortPolicies: readonly RuntimePortPolicy[] = ["prefer", "fixed"];
const runtimeAnalysisConfidences: readonly RuntimeAnalysisConfidence[] = [
  "declared",
  "corroborated",
  "inferred",
  "suggested",
];

function runtimePortField(value: unknown, path: string): number {
  const port = integerField(value, path);
  if (port < 1_024 || port > 65_535) return invalidPayload(path);
  return port;
}

function runtimeAnalysisDigestField(value: unknown, path: string): string {
  const digest = stringField(value, path);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) return invalidPayload(path);
  return digest;
}

function normalizeRuntimePortSelection(
  value: unknown,
  path: string,
): RuntimePortSelection {
  const raw = exactRecord(value, path, [
    "portId",
    "preferredPort",
    "policy",
  ]);
  return {
    portId: stringField(raw.portId, `${path}.portId`),
    preferredPort: runtimePortField(
      raw.preferredPort,
      `${path}.preferredPort`,
    ),
    policy: enumField(raw.policy, runtimePortPolicies, `${path}.policy`),
  };
}

function normalizeRuntimePlanSelection(
  value: unknown,
  path: string,
): RuntimePlanSelection {
  const raw = exactRecord(value, path, ["analysisDigest", "services"]);
  if (!Array.isArray(raw.services)) return invalidPayload(`${path}.services`);
  if (raw.services.length === 0) return invalidPayload(`${path}.services`);

  const candidateIds = new Set<string>();
  const services = raw.services.map((service, serviceIndex) => {
    const servicePath = `${path}.services[${serviceIndex}]`;
    const item = exactRecord(service, servicePath, ["candidateId", "ports"]);
    if (!Array.isArray(item.ports)) {
      return invalidPayload(`${servicePath}.ports`);
    }
    const candidateId = stringField(
      item.candidateId,
      `${servicePath}.candidateId`,
    );
    if (candidateIds.has(candidateId)) {
      return invalidPayload(`${servicePath}.candidateId`);
    }
    candidateIds.add(candidateId);

    const portIds = new Set<string>();
    const ports = item.ports.map((port, portIndex) => {
      const normalized = normalizeRuntimePortSelection(
        port,
        `${servicePath}.ports[${portIndex}]`,
      );
      if (portIds.has(normalized.portId)) {
        return invalidPayload(
          `${servicePath}.ports[${portIndex}].portId`,
        );
      }
      portIds.add(normalized.portId);
      return normalized;
    });
    return { candidateId, ports };
  });

  return {
    analysisDigest: runtimeAnalysisDigestField(
      raw.analysisDigest,
      `${path}.analysisDigest`,
    ),
    services,
  };
}

function normalizePlanningSelection(
  value: unknown,
  path: string,
): WorkspacePlanningSelection {
  const raw = exactRecord(value, path, ["folder", "format"]);
  return {
    folder: enumField(
      raw.folder,
      ["plans", "plansAndKanban"] as const,
      `${path}.folder`,
    ),
    format: enumField(
      raw.format,
      ["notes", "kanban"] as const,
      `${path}.format`,
    ),
  };
}

function normalizeRuntimeAnalysisEvidence(
  value: unknown,
  path: string,
): RuntimeAnalysisEvidence {
  const raw = exactRecord(value, path, [
    "repositoryId",
    "commitOid",
    "path",
    "detector",
    "detail",
  ]);
  return {
    repositoryId: stringField(raw.repositoryId, `${path}.repositoryId`),
    commitOid: stringField(raw.commitOid, `${path}.commitOid`),
    path: stringField(raw.path, `${path}.path`),
    detector: stringField(raw.detector, `${path}.detector`),
    detail: stringField(raw.detail, `${path}.detail`),
  };
}

function normalizeRuntimeAnalysisResult(
  value: unknown,
): RuntimeAnalysisResult {
  const raw = exactRecord(value, "runtimeAnalysis", [
    "analysisDigest",
    "repositories",
    "services",
    "warnings",
    "graph",
  ]);
  if (
    !Array.isArray(raw.repositories) ||
    !Array.isArray(raw.services) ||
    !Array.isArray(raw.warnings)
  ) {
    return invalidPayload("runtimeAnalysis");
  }

  const repositories = raw.repositories.map((repository, index) => {
    const path = `runtimeAnalysis.repositories[${index}]`;
    const item = exactRecord(repository, path, [
      "repositoryId",
      "repositoryLabel",
      "requestedBaseRef",
      "resolvedBaseRef",
      "commitOid",
    ]);
    return {
      repositoryId: stringField(item.repositoryId, `${path}.repositoryId`),
      repositoryLabel: stringField(
        item.repositoryLabel,
        `${path}.repositoryLabel`,
      ),
      requestedBaseRef: stringField(
        item.requestedBaseRef,
        `${path}.requestedBaseRef`,
      ),
      resolvedBaseRef: stringField(
        item.resolvedBaseRef,
        `${path}.resolvedBaseRef`,
      ),
      commitOid: stringField(item.commitOid, `${path}.commitOid`),
    };
  });

  const candidateIds = new Set<string>();
  const services = raw.services.map((service, serviceIndex) => {
    const path = `runtimeAnalysis.services[${serviceIndex}]`;
    const item = exactRecord(service, path, [
      "candidateId",
      "serviceId",
      "displayName",
      "repositoryId",
      "repositoryLabel",
      "commitOid",
      "workingDirectory",
      "command",
      "dependencies",
      "ports",
      "confidence",
      "evidence",
      "includedByDefault",
    ]);
    if (
      !Array.isArray(item.command) ||
      !Array.isArray(item.dependencies) ||
      !Array.isArray(item.ports) ||
      !Array.isArray(item.evidence)
    ) {
      return invalidPayload(path);
    }
    const candidateId = stringField(item.candidateId, `${path}.candidateId`);
    if (candidateIds.has(candidateId)) {
      return invalidPayload(`${path}.candidateId`);
    }
    candidateIds.add(candidateId);
    const command = stringArray(item.command, `${path}.command`);
    if (command.length === 0) return invalidPayload(`${path}.command`);

    const portIds = new Set<string>();
    const ports = item.ports.map((port, portIndex) => {
      const portPath = `${path}.ports[${portIndex}]`;
      const portItem = exactRecord(port, portPath, [
        "portId",
        "environment",
        "preferredPort",
        "policy",
        "confidence",
        "evidence",
      ]);
      if (!Array.isArray(portItem.evidence)) {
        return invalidPayload(`${portPath}.evidence`);
      }
      const portId = stringField(portItem.portId, `${portPath}.portId`);
      if (portIds.has(portId)) return invalidPayload(`${portPath}.portId`);
      portIds.add(portId);
      const preferredPort =
        portItem.preferredPort === undefined
          ? undefined
          : runtimePortField(
              portItem.preferredPort,
              `${portPath}.preferredPort`,
            );
      return {
        portId,
        environment: optionalStringField(
          portItem.environment,
          `${portPath}.environment`,
        ),
        ...(preferredPort === undefined ? {} : { preferredPort }),
        policy: enumField(
          portItem.policy,
          runtimePortPolicies,
          `${portPath}.policy`,
        ),
        confidence: enumField(
          portItem.confidence,
          runtimeAnalysisConfidences,
          `${portPath}.confidence`,
        ),
        evidence: portItem.evidence.map((evidence, evidenceIndex) =>
          normalizeRuntimeAnalysisEvidence(
            evidence,
            `${portPath}.evidence[${evidenceIndex}]`,
          ),
        ),
      };
    });

    return {
      candidateId,
      serviceId: stringField(item.serviceId, `${path}.serviceId`),
      displayName: stringField(item.displayName, `${path}.displayName`),
      repositoryId: stringField(
        item.repositoryId,
        `${path}.repositoryId`,
      ),
      repositoryLabel: stringField(
        item.repositoryLabel,
        `${path}.repositoryLabel`,
      ),
      commitOid: stringField(item.commitOid, `${path}.commitOid`),
      workingDirectory: stringField(
        item.workingDirectory,
        `${path}.workingDirectory`,
      ),
      command,
      dependencies: stringArray(item.dependencies, `${path}.dependencies`),
      ports,
      confidence: enumField(
        item.confidence,
        runtimeAnalysisConfidences,
        `${path}.confidence`,
      ),
      evidence: item.evidence.map((evidence, evidenceIndex) =>
        normalizeRuntimeAnalysisEvidence(
          evidence,
          `${path}.evidence[${evidenceIndex}]`,
        ),
      ),
      includedByDefault: booleanField(
        item.includedByDefault,
        `${path}.includedByDefault`,
      ),
    };
  });

  const graph = exactRecord(raw.graph, "runtimeAnalysis.graph", [
    "status",
    "detail",
  ]);
  return {
    analysisDigest: runtimeAnalysisDigestField(
      raw.analysisDigest,
      "runtimeAnalysis.analysisDigest",
    ),
    repositories,
    services,
    warnings: stringArray(raw.warnings, "runtimeAnalysis.warnings"),
    graph: {
      status: enumField(
        graph.status,
        ["unavailable", "stale", "ready"] as const,
        "runtimeAnalysis.graph.status",
      ),
      detail: stringField(graph.detail, "runtimeAnalysis.graph.detail"),
    },
  };
}

const agentSessionCategories: readonly AgentSessionCategory[] = [
  "uncategorized",
  "ideation",
  "investigation",
  "implementation",
  "verification",
  "review",
  "other",
];
const agentSessionStatuses: readonly AgentSessionStatus[] = [
  "launching",
  "handoffAccepted",
  "running",
  "stopping",
  "completed",
  "failed",
  "interrupted",
];

function validateLaunchAgentSessionRequest(
  value: LaunchAgentSessionRequest,
): LaunchAgentSessionRequest {
  if (
    !agentProviders.includes(value.provider) ||
    !agentSessionCategories.includes(value.category) ||
    !value.prompt.trim()
  ) {
    throw new WorkspaceClientError(
      "An agent provider, category, and prompt are required",
      { code: "invalid_request" },
    );
  }
  return { ...value, prompt: value.prompt.trim() };
}

function normalizeAgentSession(value: unknown, path: string): AgentSession {
  const raw = exactRecord(value, path, [
    "schemaVersion",
    "sessionId",
    "workspaceId",
    "provider",
    "terminal",
    "category",
    "status",
    "startedAtUnixMs",
    "lastHeartbeatAtUnixMs",
    "endedAtUnixMs",
    "failure",
    "needsInput",
    "changeRequestProposals",
  ]);
  if (integerField(raw.schemaVersion, `${path}.schemaVersion`) !== 1) {
    return invalidPayload(`${path}.schemaVersion`);
  }
  return {
    schemaVersion: 1,
    sessionId: uuidField(raw.sessionId, `${path}.sessionId`),
    workspaceId: stringField(raw.workspaceId, `${path}.workspaceId`),
    provider: enumField(
      raw.provider,
      agentProviders,
      `${path}.provider`,
    ),
    terminal: enumField(
      raw.terminal,
      terminalProviders,
      `${path}.terminal`,
    ),
    category: enumField(
      raw.category,
      agentSessionCategories,
      `${path}.category`,
    ),
    status: enumField(
      raw.status,
      agentSessionStatuses,
      `${path}.status`,
    ),
    startedAtUnixMs: integerField(
      raw.startedAtUnixMs,
      `${path}.startedAtUnixMs`,
    ),
    lastHeartbeatAtUnixMs: integerField(
      raw.lastHeartbeatAtUnixMs,
      `${path}.lastHeartbeatAtUnixMs`,
    ),
    endedAtUnixMs: nullableIntegerField(
      raw.endedAtUnixMs,
      `${path}.endedAtUnixMs`,
    ),
    failure:
      raw.failure === null
        ? null
        : enumField(
            raw.failure,
            [
              "launchRejected",
              "providerFailed",
              "processExited",
              "staleHeartbeat",
              "launchOutcomeUnknown",
              "userStopped",
            ] as const,
            `${path}.failure`,
          ),
    ...(raw.needsInput === undefined
      ? {}
      : { needsInput: normalizeAgentNeedsInput(raw.needsInput, `${path}.needsInput`) }),
    ...(raw.changeRequestProposals === undefined
      ? {}
      : {
          changeRequestProposals: arrayField(
            raw.changeRequestProposals,
            `${path}.changeRequestProposals`,
          ).map((proposal, index) =>
            normalizeAgentChangeRequestProposal(
              proposal,
              `${path}.changeRequestProposals[${index}]`,
            ),
          ),
        }),
  };
}

function normalizeAgentChangeRequestProposal(
  value: unknown,
  path: string,
): AgentChangeRequestProposal {
  const raw = exactRecord(value, path, [
    "schemaVersion",
    "repositoryId",
    "sourceHeadCommitOid",
    "title",
    "body",
    "issueKeys",
    "verification",
  ]);
  if (integerField(raw.schemaVersion, `${path}.schemaVersion`) !== 1) {
    return invalidPayload(`${path}.schemaVersion`);
  }
  const sourceHeadCommitOid = stringField(
    raw.sourceHeadCommitOid,
    `${path}.sourceHeadCommitOid`,
  );
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(sourceHeadCommitOid)) {
    return invalidPayload(`${path}.sourceHeadCommitOid`);
  }
  const verification = raw.verification === undefined
    ? undefined
    : exactRecord(raw.verification, `${path}.verification`, ["status", "summary"]);
  return {
    schemaVersion: 1,
    repositoryId: stringField(raw.repositoryId, `${path}.repositoryId`),
    sourceHeadCommitOid,
    title: stringField(raw.title, `${path}.title`),
    body: stringField(raw.body, `${path}.body`),
    issueKeys: arrayField(raw.issueKeys, `${path}.issueKeys`).map((key, index) =>
      stringField(key, `${path}.issueKeys[${index}]`),
    ),
    ...(verification === undefined
      ? {}
      : {
          verification: {
            status: enumField(
              verification.status,
              ["notReported", "passed", "partial", "failed"] as const,
              `${path}.verification.status`,
            ),
            summary: stringField(
              verification.summary,
              `${path}.verification.summary`,
            ),
          },
        }),
  };
}

function normalizeAgentNeedsInput(value: unknown, path: string): AgentNeedsInput {
  const raw = exactRecord(value, path, ["kind", "detail"]);
  const kind = enumField(raw.kind, ["question", "access"] as const, `${path}.kind`);
  const detail = stringField(raw.detail, `${path}.detail`);
  if (
    (kind === "question" && detail !== "Agent has a question.") ||
    (kind === "access" && detail !== "Agent needs access.")
  ) {
    return invalidPayload(`${path}.detail`);
  }
  return { kind, detail } as AgentNeedsInput;
}

function normalizeAgentSessionList(value: unknown): AgentSessionList {
  const raw = exactRecord(value, "agentSessionList", [
    "schemaVersion",
    "sessions",
    "observedSessions",
  ]);
  if (
    integerField(raw.schemaVersion, "agentSessionList.schemaVersion") !== 1 ||
    !Array.isArray(raw.sessions)
  ) {
    return invalidPayload("agentSessionList");
  }
  const observedSessions = raw.observedSessions;
  if (observedSessions !== undefined && !Array.isArray(observedSessions)) {
    return invalidPayload("agentSessionList.observedSessions");
  }
  return {
    schemaVersion: 1,
    sessions: raw.sessions.map((session, index) =>
      normalizeAgentSession(session, `agentSessionList.sessions[${index}]`),
    ),
    ...(observedSessions === undefined
      ? {}
      : {
          observedSessions: observedSessions.map((session, index) =>
            normalizeObservedAgentSession(
              session,
              `agentSessionList.observedSessions[${index}]`,
            ),
          ),
        }),
  };
}

function normalizeObservedAgentSession(
  value: unknown,
  path: string,
): ObservedAgentSession {
  const raw = exactRecord(value, path, [
    "schemaVersion",
    "sessionId",
    "workspaceId",
    "provider",
    "source",
    "status",
    "activity",
    "model",
    "latestUpdate",
    "updateKind",
    "needsInput",
    "changeRequestProposals",
    "startedAtUnixMs",
    "lastEventAtUnixMs",
  ]);
  if (integerField(raw.schemaVersion, `${path}.schemaVersion`) !== 1) {
    return invalidPayload(`${path}.schemaVersion`);
  }
  const latestUpdate = optionalStringField(
    raw.latestUpdate,
    `${path}.latestUpdate`,
  );
  const model = optionalStringField(raw.model, `${path}.model`);
  const updateKind =
    raw.updateKind === undefined
      ? undefined
      : enumField(
          raw.updateKind,
          ["progress", "completion"] as const,
          `${path}.updateKind`,
        );
  if (
    (latestUpdate === undefined) !== (updateKind === undefined) ||
    (latestUpdate !== undefined &&
      (latestUpdate.length === 0 ||
        Array.from(latestUpdate).length > 801 ||
        latestUpdate.split("\n").length > 4 ||
        /[\u0000-\u0009\u000b-\u001f\u007f]/.test(latestUpdate)))
  ) {
    return invalidPayload(`${path}.latestUpdate`);
  }
  return {
    schemaVersion: 1,
    sessionId: uuidField(raw.sessionId, `${path}.sessionId`),
    workspaceId: stringField(raw.workspaceId, `${path}.workspaceId`),
    provider: enumField(
      raw.provider,
      ["codex", "copilot"] as const,
      `${path}.provider`,
    ),
    source: enumField(
      raw.source,
      ["codexVscodeRollout", "copilotVscodeSnapshot"] as const,
      `${path}.source`,
    ),
    status: enumField(
      raw.status,
      ["working", "idle", "interrupted", "stale"] as const,
      `${path}.status`,
    ),
    activity:
      raw.activity === null
        ? null
        : enumField(
            raw.activity,
            [
              "thinking",
              "usingTools",
              "editing",
              "runningCommand",
              "searching",
              "delegating",
            ] as const,
            `${path}.activity`,
          ),
    ...(model === undefined ? {} : { model }),
    ...(latestUpdate === undefined
      ? {}
      : { latestUpdate, updateKind: updateKind! }),
    ...(raw.needsInput === undefined
      ? {}
      : { needsInput: normalizeAgentNeedsInput(raw.needsInput, `${path}.needsInput`) }),
    ...(raw.changeRequestProposals === undefined
      ? {}
      : {
          changeRequestProposals: arrayField(
            raw.changeRequestProposals,
            `${path}.changeRequestProposals`,
          ).map((proposal, index) =>
            normalizeAgentChangeRequestProposal(
              proposal,
              `${path}.changeRequestProposals[${index}]`,
            ),
          ),
        }),
    startedAtUnixMs: integerField(
      raw.startedAtUnixMs,
      `${path}.startedAtUnixMs`,
    ),
    lastEventAtUnixMs: integerField(
      raw.lastEventAtUnixMs,
      `${path}.lastEventAtUnixMs`,
    ),
  };
}

function normalizeAgentSessionDetail(value: unknown): AgentSessionDetail {
  const raw = exactRecord(value, "agentSessionDetail", [
    "schemaVersion",
    "sessionId",
    "workspaceId",
    "provider",
    "task",
    "modelSelection",
    "events",
    "eventsTruncated",
  ]);
  if (
    integerField(raw.schemaVersion, "agentSessionDetail.schemaVersion") !== 1 ||
    !Array.isArray(raw.events)
  ) {
    return invalidPayload("agentSessionDetail");
  }
  const model = exactRecord(
    raw.modelSelection,
    "agentSessionDetail.modelSelection",
    ["authority", "model", "reasoningEffort"],
  );
  return {
    schemaVersion: 1,
    sessionId: uuidField(raw.sessionId, "agentSessionDetail.sessionId"),
    workspaceId: stringField(raw.workspaceId, "agentSessionDetail.workspaceId"),
    provider: enumField(raw.provider, agentProviders, "agentSessionDetail.provider"),
    task: stringField(raw.task, "agentSessionDetail.task"),
    modelSelection: {
      authority: enumField(
        model.authority,
        ["providerDefault"] as const,
        "agentSessionDetail.modelSelection.authority",
      ),
      ...(model.model === undefined
        ? {}
        : {
            model: stringField(
              model.model,
              "agentSessionDetail.modelSelection.model",
            ),
          }),
      ...(model.reasoningEffort === undefined
        ? {}
        : {
            reasoningEffort: stringField(
              model.reasoningEffort,
              "agentSessionDetail.modelSelection.reasoningEffort",
            ),
          }),
    },
    events: raw.events.map((value, index) => {
      const path = `agentSessionDetail.events[${index}]`;
      const event = exactRecord(value, path, [
        "sequence",
        "observedAtUnixMs",
        "kind",
        "summary",
      ]);
      const kind = enumField(
        event.kind,
        [
          "started",
          "thinking",
          "usesTool",
          "editsFiles",
          "runsCommand",
          "searches",
          "agentUpdate",
          "needsQuestion",
          "needsAccess",
          "completed",
        ] as const,
        `${path}.kind`,
      );
      const summary = stringField(event.summary, `${path}.summary`);
      if (
        (kind === "needsQuestion" && summary !== "Agent has a question.") ||
        (kind === "needsAccess" && summary !== "Agent needs access.")
      ) {
        return invalidPayload(`${path}.summary`);
      }
      return {
        sequence: integerField(event.sequence, `${path}.sequence`),
        observedAtUnixMs: integerField(
          event.observedAtUnixMs,
          `${path}.observedAtUnixMs`,
        ),
        kind,
        summary,
      };
    }),
    eventsTruncated: booleanField(
      raw.eventsTruncated,
      "agentSessionDetail.eventsTruncated",
    ),
  };
}

function normalizeActivityWatchStatus(value: unknown): ActivityWatchStatus {
  const raw = exactRecord(value, "activityWatchStatus", [
    "state",
    "installation",
    "endpoint",
    "apiVersion",
    "serverVersion",
    "capabilities",
    "detail",
    "diagnosticCode",
  ]);
  if (!Array.isArray(raw.capabilities)) {
    return invalidPayload("activityWatchStatus.capabilities");
  }
  return {
    state: enumField(
      raw.state,
      ["running", "unavailable", "incompatible"] as const,
      "activityWatchStatus.state",
    ),
    installation: enumField(
      raw.installation,
      ["detected", "unknown"] as const,
      "activityWatchStatus.installation",
    ),
    endpoint: stringField(raw.endpoint, "activityWatchStatus.endpoint"),
    apiVersion:
      raw.apiVersion === undefined
        ? undefined
        : enumField(
            raw.apiVersion,
            ["v0"] as const,
            "activityWatchStatus.apiVersion",
          ),
    serverVersion: optionalStringField(
      raw.serverVersion,
      "activityWatchStatus.serverVersion",
    ),
    capabilities: raw.capabilities.map((capability, index) =>
      enumField(
        capability,
        ["status", "dailyReview"] as const,
        `activityWatchStatus.capabilities[${index}]`,
      ),
    ),
    detail: stringField(raw.detail, "activityWatchStatus.detail"),
    diagnosticCode:
      raw.diagnosticCode === undefined
        ? undefined
        : enumField(
            raw.diagnosticCode,
            [
              "connectionFailed",
              "requestTimedOut",
              "responseTooLarge",
              "responseInvalid",
              "serverRejected",
            ] as const,
            "activityWatchStatus.diagnosticCode",
          ),
  };
}

function normalizeActivityWatchDailyReview(
  value: unknown,
): ActivityWatchDailyReview {
  const raw = exactRecord(value, "activityWatchDailyReview", [
    "schemaVersion",
    "startedAtUnixMs",
    "endedAtUnixMs",
    "totalActiveSeconds",
    "sessions",
    "detail",
  ]);
  if (
    integerField(raw.schemaVersion, "activityWatchDailyReview.schemaVersion") !==
      1 ||
    !Array.isArray(raw.sessions)
  ) {
    return invalidPayload("activityWatchDailyReview");
  }
  const startedAtUnixMs = integerField(
    raw.startedAtUnixMs,
    "activityWatchDailyReview.startedAtUnixMs",
  );
  const endedAtUnixMs = integerField(
    raw.endedAtUnixMs,
    "activityWatchDailyReview.endedAtUnixMs",
  );
  if (endedAtUnixMs <= startedAtUnixMs) {
    return invalidPayload("activityWatchDailyReview.endedAtUnixMs");
  }
  return {
    schemaVersion: 1,
    startedAtUnixMs,
    endedAtUnixMs,
    totalActiveSeconds: integerField(
      raw.totalActiveSeconds,
      "activityWatchDailyReview.totalActiveSeconds",
    ),
    sessions: raw.sessions.map((value, index) => {
      const path = `activityWatchDailyReview.sessions[${index}]`;
      const session = exactRecord(value, path, [
        "id",
        "kind",
        "startedAtUnixMs",
        "endedAtUnixMs",
        "durationSeconds",
        "description",
        "application",
        "activityEvidence",
        "jiraIssueKey",
        "suggestedJiraIssueKey",
        "jiraSuggestionConfidence",
        "jiraSuggestionReason",
        "sourceEventCount",
      ]);
      const sessionStart = integerField(
        session.startedAtUnixMs,
        `${path}.startedAtUnixMs`,
      );
      const sessionEnd = integerField(
        session.endedAtUnixMs,
        `${path}.endedAtUnixMs`,
      );
      if (
        sessionEnd <= sessionStart ||
        sessionStart < startedAtUnixMs ||
        sessionEnd > endedAtUnixMs
      ) {
        return invalidPayload(`${path}.endedAtUnixMs`);
      }
      const suggestedJiraIssueKey = optionalStringField(
        session.suggestedJiraIssueKey,
        `${path}.suggestedJiraIssueKey`,
      );
      const jiraSuggestionConfidence =
        session.jiraSuggestionConfidence === undefined
          ? undefined
          : integerField(
              session.jiraSuggestionConfidence,
              `${path}.jiraSuggestionConfidence`,
            );
      const jiraSuggestionReason = optionalStringField(
        session.jiraSuggestionReason,
        `${path}.jiraSuggestionReason`,
      );
      if (
        [suggestedJiraIssueKey, jiraSuggestionConfidence, jiraSuggestionReason]
          .filter((field) => field !== undefined).length !==
        (suggestedJiraIssueKey === undefined ? 0 : 3)
      ) {
        return invalidPayload(`${path}.suggestedJiraIssueKey`);
      }
      if (
        jiraSuggestionConfidence !== undefined &&
        (jiraSuggestionConfidence < 1 || jiraSuggestionConfidence > 100)
      ) {
        return invalidPayload(`${path}.jiraSuggestionConfidence`);
      }
      const application = optionalStringField(
        session.application,
        `${path}.application`,
      );
      const activityEvidence = optionalStringField(
        session.activityEvidence,
        `${path}.activityEvidence`,
      );
      return {
        id: stringField(session.id, `${path}.id`),
        kind: enumField(
          session.kind,
          [
            "coding",
            "agent",
            "browser",
            "communication",
            "terminal",
            "other",
          ] as const,
          `${path}.kind`,
        ),
        startedAtUnixMs: sessionStart,
        endedAtUnixMs: sessionEnd,
        durationSeconds: integerField(
          session.durationSeconds,
          `${path}.durationSeconds`,
        ),
        description: stringField(session.description, `${path}.description`),
        ...(application === undefined ? {} : { application }),
        ...(activityEvidence === undefined ? {} : { activityEvidence }),
        jiraIssueKey: optionalStringField(
          session.jiraIssueKey,
          `${path}.jiraIssueKey`,
        ),
        suggestedJiraIssueKey,
        jiraSuggestionConfidence,
        jiraSuggestionReason,
        sourceEventCount: integerField(
          session.sourceEventCount,
          `${path}.sourceEventCount`,
        ),
      };
    }),
    detail: stringField(raw.detail, "activityWatchDailyReview.detail"),
  };
}

function normalizeIntegration(
  value: unknown,
  path: string,
): IntegrationSnapshot {
  const raw = record(value, path);
  return {
    id: enumField(raw.id, integrationIds, `${path}.id`),
    category: enumField(
      raw.category,
      [
        "sourceControl",
        "editor",
        "terminal",
        "agent",
        "knowledgeGraph",
        "issueTracker",
      ] as const,
      `${path}.category`,
    ),
    status: enumField(
      raw.status,
      ["ready", "notConfigured", "notFound", "error"] as const,
      `${path}.status`,
    ),
    installation: enumField(
      raw.installation,
      ["missing", "detected", "unsupported"] as const,
      `${path}.installation`,
    ),
    setup: enumField(
      raw.setup,
      [
        "notRequired",
        "needsAuth",
        "unverified",
        "needsDependency",
        "ready",
        "incompatible",
      ] as const,
      `${path}.setup`,
    ),
    runtime: enumField(
      raw.runtime,
      ["idle", "starting", "running", "failed"] as const,
      `${path}.runtime`,
    ),
    wtsSupport: enumField(
      raw.wtsSupport,
      ["available", "detectionOnly"] as const,
      `${path}.wtsSupport`,
    ),
    verificationKind: enumField(
      raw.verificationKind,
      ["version", "configurationSignal"] as const,
      `${path}.verificationKind`,
    ),
    capabilities: stringArray(
      raw.capabilities,
      `${path}.capabilities`,
    ).map((capability, index) =>
      enumField(
        capability,
        [
          "worktreeMaterialization",
          "workspaceLaunch",
          "terminalSession",
          "agentSession",
          "graphIndexing",
          "jiraIssueImport",
          "openProjectWorkPackageImport",
        ] as const,
        `${path}.capabilities[${index}]`,
      ),
    ),
    version: optionalStringField(raw.version, `${path}.version`),
    detail: optionalStringField(raw.detail, `${path}.detail`),
    diagnosticCode: optionalStringField(
      raw.diagnosticCode,
      `${path}.diagnosticCode`,
    ),
    lastProbeAt: integerField(raw.lastProbeAt, `${path}.lastProbeAt`),
    blockingFor: stringArray(
      raw.blockingFor,
      `${path}.blockingFor`,
    ).map((capability, index) =>
      enumField(
        capability,
        [
          "worktreeMaterialization",
          "vscodeLaunch",
          "warpLaunch",
          "codexLaunch",
          "openCodeLaunch",
          "hermesLaunch",
          "graphIndexing",
          "jiraIssueImport",
          "openProjectWorkPackageImport",
        ] as const,
        `${path}.blockingFor[${index}]`,
      ),
    ),
  };
}

function normalizeBrowserJourneyReadinessCheck(
  value: unknown,
  path: string,
): BrowserJourneyReadinessCheck {
  const raw = record(value, path);
  const status = enumField(
    raw.status,
    ["ready", "unavailable", "blocked"] as const,
    `${path}.status`,
  );
  const source =
    raw.source === undefined
      ? undefined
      : enumField(
          raw.source,
          ["configured", "packaged", "path"] as const,
          `${path}.source`,
        );
  const diagnosticCode =
    raw.diagnosticCode === undefined
      ? undefined
      : enumField(
          raw.diagnosticCode,
          [
            "nodeUnavailable",
            "nodeProbeFailed",
            "fixedHelperUnavailable",
            "fixedHelperInvalid",
            "playwrightUnavailable",
            "playwrightProbeFailed",
            "chromiumUnavailable",
            "chromiumProbeFailed",
            "prerequisiteUnavailable",
          ] as const,
          `${path}.diagnosticCode`,
        );
  if (
    (status === "ready" && diagnosticCode !== undefined) ||
    (status !== "ready" && diagnosticCode === undefined)
  ) {
    return invalidPayload(path);
  }
  return {
    status,
    source,
    detail: stringField(raw.detail, `${path}.detail`),
    diagnosticCode,
  };
}

function normalizeBrowserJourneyReadiness(
  value: unknown,
  path: string,
): BrowserJourneyReadiness {
  const raw = record(value, path);
  const readiness = {
    ready: booleanField(raw.ready, `${path}.ready`),
    node: normalizeBrowserJourneyReadinessCheck(
      raw.node,
      `${path}.node`,
    ),
    fixedHelper: normalizeBrowserJourneyReadinessCheck(
      raw.fixedHelper,
      `${path}.fixedHelper`,
    ),
    playwright: normalizeBrowserJourneyReadinessCheck(
      raw.playwright,
      `${path}.playwright`,
    ),
    chromium: normalizeBrowserJourneyReadinessCheck(
      raw.chromium,
      `${path}.chromium`,
    ),
  };
  const allReady = [
    readiness.node,
    readiness.fixedHelper,
    readiness.playwright,
    readiness.chromium,
  ].every((check) => check.status === "ready");
  if (readiness.ready !== allReady) return invalidPayload(`${path}.ready`);
  return readiness;
}

function normalizeSetupSnapshot(value: unknown): SetupSnapshot {
  const raw = record(value, "setupSnapshot");
  if (!Array.isArray(raw.integrations)) {
    return invalidPayload("setupSnapshot.integrations");
  }
  const integrations = raw.integrations.map((integration, index) =>
    normalizeIntegration(
      integration,
      `setupSnapshot.integrations[${index}]`,
    ),
  );
  if (
    new Set(integrations.map((integration) => integration.id)).size !==
    integrations.length
  ) {
    return invalidPayload("setupSnapshot.integrations");
  }
  const browserJourneyReadiness =
    raw.browserJourneyReadiness === undefined
      ? undefined
      : normalizeBrowserJourneyReadiness(
          raw.browserJourneyReadiness,
          "setupSnapshot.browserJourneyReadiness",
        );
  return {
    checkedAtUnixMs: integerField(
      raw.checkedAtUnixMs,
      "setupSnapshot.checkedAtUnixMs",
    ),
    repositoryCount: integerField(
      raw.repositoryCount,
      "setupSnapshot.repositoryCount",
    ),
    integrations,
    ...(browserJourneyReadiness
      ? { browserJourneyReadiness }
      : {}),
  };
}

function normalizeRepositorySummary(
  value: unknown,
  path: string,
): RepositorySummary {
  const item = record(value, path);
  const branch = record(item.defaultBranch, `${path}.defaultBranch`);
  if (
    item.availableBranches !== undefined &&
    !Array.isArray(item.availableBranches)
  ) {
    return invalidPayload(`${path}.availableBranches`);
  }
  const availableBranches =
    item.availableBranches === undefined
      ? undefined
      : item.availableBranches.map(
          (value, index) => {
            const available = record(
              value,
              `${path}.availableBranches[${index}]`,
            );
            return {
              name: stringField(
                available.name,
                `${path}.availableBranches[${index}].name`,
              ),
              fullRef: stringField(
                available.fullRef,
                `${path}.availableBranches[${index}].fullRef`,
              ),
              commitOid: stringField(
                available.commitOid,
                `${path}.availableBranches[${index}].commitOid`,
              ),
              remote: booleanField(
                available.remote,
                `${path}.availableBranches[${index}].remote`,
              ),
            };
          },
        );
  return {
    id: stringField(item.id, `${path}.id`),
    label: stringField(item.label, `${path}.label`),
    checkoutLeaf: stringField(item.checkoutLeaf, `${path}.checkoutLeaf`),
    displayPath: stringField(item.displayPath, `${path}.displayPath`),
    ...(item.originUrl === undefined
      ? {}
      : {
          originUrl: optionalStringField(item.originUrl, `${path}.originUrl`),
        }),
    defaultBranch: {
      name: stringField(branch.name, `${path}.defaultBranch.name`),
      fullRef: stringField(branch.fullRef, `${path}.defaultBranch.fullRef`),
      commitOid: stringField(branch.commitOid, `${path}.defaultBranch.commitOid`),
    },
    ...(availableBranches === undefined ? {} : { availableBranches }),
  };
}

function normalizeRepositoryCatalog(value: unknown): RepositoryCatalog {
  const raw = record(value, "repositoryCatalog");
  if (!Array.isArray(raw.repositories)) {
    return invalidPayload("repositoryCatalog.repositories");
  }
  return {
    repositoryRootDisplayPath: stringField(
      raw.repositoryRootDisplayPath,
      "repositoryCatalog.repositoryRootDisplayPath",
    ),
    repositories: raw.repositories.map((repository, index) =>
      normalizeRepositorySummary(
        repository,
        `repositoryCatalog.repositories[${index}]`,
      ),
    ),
    skippedEntries: integerField(
      raw.skippedEntries,
      "repositoryCatalog.skippedEntries",
    ),
  };
}

function normalizeCloneRepositoryResult(value: unknown): CloneRepositoryResult {
  const raw = exactRecord(value, "cloneRepositoryResult", [
    "repository",
    "repositoryRootDisplayPath",
    "reusedExisting",
  ]);
  return {
    repository: normalizeRepositorySummary(
      raw.repository,
      "cloneRepositoryResult.repository",
    ),
    repositoryRootDisplayPath: stringField(
      raw.repositoryRootDisplayPath,
      "cloneRepositoryResult.repositoryRootDisplayPath",
    ),
    reusedExisting: booleanField(
      raw.reusedExisting,
      "cloneRepositoryResult.reusedExisting",
    ),
  };
}

const codeWorkspaceFolderStatuses: readonly CodeWorkspaceFolderStatus[] = [
  "matched",
  "missing",
  "ambiguous",
  "unsupported",
];

const codeWorkspaceWarningCodes: readonly CodeWorkspaceImportWarningCode[] = [
  "configurationIgnored",
  "folderMissing",
  "folderAmbiguous",
  "folderUnsupported",
  "duplicateRepository",
];

const codeWorkspaceDiagnosticResolutionBases: readonly CodeWorkspaceDiagnosticResolutionBasis[] =
  [
    "absolutePath",
    "relativePathSuffix",
    "pathBasename",
    "explicitName",
  ];

const codeWorkspaceDiagnosticMatchReasons: readonly CodeWorkspaceDiagnosticMatchReason[] =
  [
    "matchedExactPath",
    "matchedRelativePathSuffix",
    "matchedPathBasename",
    "matchedExplicitName",
    "noCatalogMatch",
    "ambiguousExactPath",
    "ambiguousRelativePathSuffix",
    "ambiguousPathBasename",
    "ambiguousExplicitName",
    "unsupportedFolder",
  ];

function normalizeCodeWorkspaceImportDiagnostics(
  value: unknown,
): CodeWorkspaceImportDiagnostics {
  const path = "codeWorkspaceFileImport.diagnostics";
  const raw = exactRecord(value, path, ["catalog", "folders"]);
  const catalogPath = `${path}.catalog`;
  const catalog = exactRecord(raw.catalog, catalogPath, [
    "repositoryRootDisplayPath",
    "repositoryCount",
    "skippedEntries",
    "repositories",
    "repositoriesTruncated",
  ]);
  if (!Array.isArray(catalog.repositories)) {
    return invalidPayload(`${catalogPath}.repositories`);
  }
  if (!Array.isArray(raw.folders)) {
    return invalidPayload(`${path}.folders`);
  }

  return {
    catalog: {
      repositoryRootDisplayPath: stringField(
        catalog.repositoryRootDisplayPath,
        `${catalogPath}.repositoryRootDisplayPath`,
      ),
      repositoryCount: integerField(
        catalog.repositoryCount,
        `${catalogPath}.repositoryCount`,
      ),
      skippedEntries: integerField(
        catalog.skippedEntries,
        `${catalogPath}.skippedEntries`,
      ),
      repositories: catalog.repositories.map((repository, index) => {
        const repositoryPath = `${catalogPath}.repositories[${index}]`;
        const item = exactRecord(repository, repositoryPath, [
          "label",
          "displayPath",
        ]);
        return {
          label: stringField(item.label, `${repositoryPath}.label`),
          displayPath: stringField(
            item.displayPath,
            `${repositoryPath}.displayPath`,
          ),
        };
      }),
      repositoriesTruncated: booleanField(
        catalog.repositoriesTruncated,
        `${catalogPath}.repositoriesTruncated`,
      ),
    },
    folders: raw.folders.map((folder, index) => {
      const folderPath = `${path}.folders[${index}]`;
      const item = exactRecord(folder, folderPath, [
        "folderIndex",
        "status",
        "reason",
        "resolutionBasis",
        "attempts",
        "candidates",
        "candidatesTruncated",
        "duplicateRepository",
      ]);
      if (!Array.isArray(item.attempts)) {
        return invalidPayload(`${folderPath}.attempts`);
      }
      if (!Array.isArray(item.candidates)) {
        return invalidPayload(`${folderPath}.candidates`);
      }
      return {
        folderIndex: integerField(
          item.folderIndex,
          `${folderPath}.folderIndex`,
        ),
        status: enumField(
          item.status,
          codeWorkspaceFolderStatuses,
          `${folderPath}.status`,
        ),
        reason: enumField(
          item.reason,
          codeWorkspaceDiagnosticMatchReasons,
          `${folderPath}.reason`,
        ),
        resolutionBasis:
          item.resolutionBasis === undefined
            ? undefined
            : enumField(
                item.resolutionBasis,
                codeWorkspaceDiagnosticResolutionBases,
                `${folderPath}.resolutionBasis`,
              ),
        attempts: item.attempts.map((attempt, attemptIndex) => {
          const attemptPath = `${folderPath}.attempts[${attemptIndex}]`;
          const attemptItem = exactRecord(attempt, attemptPath, [
            "basis",
            "value",
            "candidateCount",
          ]);
          return {
            basis: enumField(
              attemptItem.basis,
              codeWorkspaceDiagnosticResolutionBases,
              `${attemptPath}.basis`,
            ),
            value: stringField(
              attemptItem.value,
              `${attemptPath}.value`,
              true,
            ),
            candidateCount: integerField(
              attemptItem.candidateCount,
              `${attemptPath}.candidateCount`,
            ),
          };
        }),
        candidates: item.candidates.map((candidate, candidateIndex) => {
          const candidatePath = `${folderPath}.candidates[${candidateIndex}]`;
          const candidateItem = exactRecord(candidate, candidatePath, [
            "label",
            "displayPath",
          ]);
          return {
            label: stringField(
              candidateItem.label,
              `${candidatePath}.label`,
            ),
            displayPath: stringField(
              candidateItem.displayPath,
              `${candidatePath}.displayPath`,
            ),
          };
        }),
        candidatesTruncated: booleanField(
          item.candidatesTruncated,
          `${folderPath}.candidatesTruncated`,
        ),
        duplicateRepository: booleanField(
          item.duplicateRepository,
          `${folderPath}.duplicateRepository`,
        ),
      };
    }),
  };
}

function normalizeCodeWorkspaceFileImport(
  value: unknown,
): CodeWorkspaceFileImportResult {
  const raw = exactRecord(value, "codeWorkspaceFileImport", [
    "importId",
    "fileName",
    "suggestedTitle",
    "suggestedRepositorySetLabel",
    "folders",
    "repositories",
    "warnings",
    "diagnostics",
  ]);
  if (
    !Array.isArray(raw.folders) ||
    !Array.isArray(raw.repositories) ||
    !Array.isArray(raw.warnings)
  ) {
    return invalidPayload("codeWorkspaceFileImport");
  }

  return {
    importId: stringField(
      raw.importId,
      "codeWorkspaceFileImport.importId",
    ),
    fileName: stringField(
      raw.fileName,
      "codeWorkspaceFileImport.fileName",
    ),
    suggestedTitle: stringField(
      raw.suggestedTitle,
      "codeWorkspaceFileImport.suggestedTitle",
    ),
    suggestedRepositorySetLabel: stringField(
      raw.suggestedRepositorySetLabel,
      "codeWorkspaceFileImport.suggestedRepositorySetLabel",
    ),
    folders: raw.folders.map((folder, index) => {
      const path = `codeWorkspaceFileImport.folders[${index}]`;
      const item = exactRecord(folder, path, [
        "name",
        "rawPath",
        "status",
        "repositoryId",
        "repositoryLabel",
        "repositoryDisplayPath",
        "baseRef",
        "message",
      ]);
      const status = enumField(
        item.status,
        codeWorkspaceFolderStatuses,
        `${path}.status`,
      );
      const rawPath = stringField(item.rawPath, `${path}.rawPath`, true);
      if (!rawPath.trim() && status !== "unsupported") {
        return invalidPayload(`${path}.rawPath`);
      }
      return {
        name: stringField(item.name, `${path}.name`),
        rawPath,
        status,
        repositoryId: optionalStringField(
          item.repositoryId,
          `${path}.repositoryId`,
        ),
        repositoryLabel: optionalStringField(
          item.repositoryLabel,
          `${path}.repositoryLabel`,
        ),
        repositoryDisplayPath: optionalStringField(
          item.repositoryDisplayPath,
          `${path}.repositoryDisplayPath`,
        ),
        baseRef: optionalStringField(item.baseRef, `${path}.baseRef`),
        message: optionalStringField(item.message, `${path}.message`),
      };
    }),
    repositories: raw.repositories.map((repository, index) => {
      const path = `codeWorkspaceFileImport.repositories[${index}]`;
      const item = exactRecord(repository, path, [
        "repositoryId",
        "label",
        "baseRef",
      ]);
      const repositoryId = stringField(
        item.repositoryId,
        `${path}.repositoryId`,
      );
      return {
        repositoryId,
        label: stringField(item.label, `${path}.label`),
        baseRef: stringField(item.baseRef, `${path}.baseRef`),
      };
    }),
    warnings: raw.warnings.map((warning, index) => {
      const path = `codeWorkspaceFileImport.warnings[${index}]`;
      const item = exactRecord(warning, path, [
        "code",
        "message",
        "folderName",
      ]);
      return {
        code: enumField(
          item.code,
          codeWorkspaceWarningCodes,
          `${path}.code`,
        ),
        message: stringField(item.message, `${path}.message`),
        folderName: optionalStringField(
          item.folderName,
          `${path}.folderName`,
        ),
      };
    }),
    diagnostics:
      raw.diagnostics === undefined
        ? undefined
        : normalizeCodeWorkspaceImportDiagnostics(raw.diagnostics),
  };
}

function normalizeGraph(
  value: unknown,
  path: string,
): GraphWorkspaceSummary {
  const raw = record(value, path);
  return {
    status: enumField(
      raw.status,
      ["notStarted", "ready"] as const,
      `${path}.status`,
    ),
    detail: stringField(raw.detail, `${path}.detail`),
  };
}

function normalizePreflight(value: unknown): WorkspacePreflight {
  const raw = record(value, "workspacePreflight");
  if (
    !Array.isArray(raw.repositories) ||
    !Array.isArray(raw.blockers) ||
    !Array.isArray(raw.warnings)
  ) {
    return invalidPayload("workspacePreflight");
  }
  const runtime =
    raw.runtime === undefined
      ? undefined
      : normalizeRuntimePlanSelection(
          raw.runtime,
          "workspacePreflight.runtime",
        );
  const planning =
    raw.planning === undefined
      ? undefined
      : normalizePlanningSelection(
          raw.planning,
          "workspacePreflight.planning",
        );
  return {
    workspaceId: stringField(
      raw.workspaceId,
      "workspacePreflight.workspaceId",
    ),
    workspaceDisplayPath: stringField(
      raw.workspaceDisplayPath,
      "workspacePreflight.workspaceDisplayPath",
    ),
    codeWorkspaceDisplayPath: stringField(
      raw.codeWorkspaceDisplayPath,
      "workspacePreflight.codeWorkspaceDisplayPath",
    ),
    branchName: stringField(
      raw.branchName,
      "workspacePreflight.branchName",
    ),
    ready: booleanField(raw.ready, "workspacePreflight.ready"),
    effectDigest: stringField(
      raw.effectDigest,
      "workspacePreflight.effectDigest",
    ),
    repositories: raw.repositories.map((repository, index) => {
      const path = `workspacePreflight.repositories[${index}]`;
      const item = record(repository, path);
      return {
        repositoryId: stringField(
          item.repositoryId,
          `${path}.repositoryId`,
        ),
        label: stringField(item.label, `${path}.label`),
        sourceDisplayPath: stringField(
          item.sourceDisplayPath,
          `${path}.sourceDisplayPath`,
        ),
        requestedBaseRef: stringField(
          item.requestedBaseRef,
          `${path}.requestedBaseRef`,
        ),
        resolvedBaseRef: stringField(
          item.resolvedBaseRef,
          `${path}.resolvedBaseRef`,
        ),
        baseCommitOid: stringField(
          item.baseCommitOid,
          `${path}.baseCommitOid`,
        ),
        targetDisplayPath: stringField(
          item.targetDisplayPath,
          `${path}.targetDisplayPath`,
        ),
      };
    }),
    blockers: raw.blockers.map((blocker, index) => {
      const path = `workspacePreflight.blockers[${index}]`;
      const item = record(blocker, path);
      return {
        code: enumField(
          item.code,
          [
            "repositoryMissing",
            "repositoryAmbiguous",
            "gitUnavailable",
            "baseReferenceUnavailable",
            "branchConflict",
            "targetConflict",
            "unsafeWorkspacePath",
            "runtimeAnalysisStale",
            "gitPreflightFailed",
          ] as const,
          `${path}.code`,
        ),
        message: stringField(item.message, `${path}.message`),
        repositoryLabel: optionalStringField(
          item.repositoryLabel,
          `${path}.repositoryLabel`,
        ),
        repositoryId: optionalStringField(
          item.repositoryId,
          `${path}.repositoryId`,
        ),
        requestedBaseRef: optionalStringField(
          item.requestedBaseRef,
          `${path}.requestedBaseRef`,
        ),
      };
    }),
    warnings: stringArray(raw.warnings, "workspacePreflight.warnings"),
    graph: normalizeGraph(raw.graph, "workspacePreflight.graph"),
    ...(runtime === undefined ? {} : { runtime }),
    ...(planning === undefined ? {} : { planning }),
  };
}

function normalizeMaterializedWorktree(
  value: unknown,
  path: string,
): MaterializedWorktree {
  const raw = record(value, path);
  const gitState =
    raw.gitState === undefined
      ? undefined
      : (() => {
          const state = record(raw.gitState, `${path}.gitState`);
          return {
            headCommitOid: stringField(
              state.headCommitOid,
              `${path}.gitState.headCommitOid`,
            ),
            ...(state.originUrl === undefined
              ? {}
              : {
                  originUrl: stringField(
                    state.originUrl,
                    `${path}.gitState.originUrl`,
                  ),
                }),
            ...(state.upstreamFullRef === undefined
              ? {}
              : {
                  upstreamFullRef: stringField(
                    state.upstreamFullRef,
                    `${path}.gitState.upstreamFullRef`,
                  ),
                }),
          };
        })();
  const activity =
    raw.activity === undefined
      ? undefined
      : (() => {
          const value = record(raw.activity, `${path}.activity`);
          return {
            changedFileCount: integerField(
              value.changedFileCount,
              `${path}.activity.changedFileCount`,
            ),
            commitsAhead: integerField(
              value.commitsAhead,
              `${path}.activity.commitsAhead`,
            ),
          };
        })();
  return {
    repositoryId: stringField(raw.repositoryId, `${path}.repositoryId`),
    label: stringField(raw.label, `${path}.label`),
    targetDisplayPath: stringField(
      raw.targetDisplayPath,
      `${path}.targetDisplayPath`,
    ),
    branchName: stringField(raw.branchName, `${path}.branchName`),
    baseCommitOid: stringField(raw.baseCommitOid, `${path}.baseCommitOid`),
    ...(gitState === undefined ? {} : { gitState }),
    ...(activity === undefined ? {} : { activity }),
  };
}

function normalizeMaterialization(
  value: unknown,
  path: string,
): WorkspaceMaterialization {
  const raw = record(value, path);
  if (!Array.isArray(raw.worktrees)) {
    return invalidPayload(`${path}.worktrees`);
  }
  const runtime =
    raw.runtime === undefined
      ? undefined
      : normalizeRuntimePlanSelection(raw.runtime, `${path}.runtime`);
  const planning =
    raw.planning === undefined
      ? undefined
      : normalizePlanningSelection(raw.planning, `${path}.planning`);
  return {
    schemaVersion: integerField(raw.schemaVersion, `${path}.schemaVersion`),
    workspaceId: stringField(raw.workspaceId, `${path}.workspaceId`),
    workspaceRecordVersion: integerField(
      raw.workspaceRecordVersion,
      `${path}.workspaceRecordVersion`,
    ),
    effectDigest: stringField(raw.effectDigest, `${path}.effectDigest`),
    workspaceDisplayPath: stringField(
      raw.workspaceDisplayPath,
      `${path}.workspaceDisplayPath`,
    ),
    codeWorkspaceDisplayPath: stringField(
      raw.codeWorkspaceDisplayPath,
      `${path}.codeWorkspaceDisplayPath`,
    ),
    branchName: stringField(raw.branchName, `${path}.branchName`),
    worktrees: raw.worktrees.map((worktree, index) =>
      normalizeMaterializedWorktree(worktree, `${path}.worktrees[${index}]`),
    ),
    graph: normalizeGraph(raw.graph, `${path}.graph`),
    ...(runtime === undefined ? {} : { runtime }),
    ...(planning === undefined ? {} : { planning }),
  };
}

function normalizeWorkspaceRepositoryDiff(
  value: unknown,
): WorkspaceRepositoryDiff {
  const raw = exactRecord(value, "workspaceRepositoryDiff", [
    "schemaVersion",
    "workspaceId",
    "repositoryId",
    "repositoryLabel",
    "baseCommitOid",
    "headCommitOid",
    "patchSha256",
    "patch",
    "patchTruncated",
    "untrackedPaths",
    "untrackedPathsTruncated",
    "reviewGraph",
  ]);
  const patch = stringField(raw.patch, "workspaceRepositoryDiff.patch", true);
  const untrackedPaths = stringArray(
    raw.untrackedPaths,
    "workspaceRepositoryDiff.untrackedPaths",
  );
  if (
    new TextEncoder().encode(patch).byteLength > 1024 * 1024 ||
    untrackedPaths.length > 256
  ) {
    return invalidPayload("workspaceRepositoryDiff.bounds");
  }
  const reviewGraph = raw.reviewGraph === undefined
    ? undefined
    : normalizeWorkspaceRepositoryReviewGraph(
        raw.reviewGraph,
        "workspaceRepositoryDiff.reviewGraph",
      );
  return {
    schemaVersion: integerField(
      raw.schemaVersion,
      "workspaceRepositoryDiff.schemaVersion",
    ),
    workspaceId: stringField(
      raw.workspaceId,
      "workspaceRepositoryDiff.workspaceId",
    ),
    repositoryId: stringField(
      raw.repositoryId,
      "workspaceRepositoryDiff.repositoryId",
    ),
    repositoryLabel: stringField(
      raw.repositoryLabel,
      "workspaceRepositoryDiff.repositoryLabel",
    ),
    baseCommitOid: stringField(
      raw.baseCommitOid,
      "workspaceRepositoryDiff.baseCommitOid",
    ),
    headCommitOid: stringField(
      raw.headCommitOid,
      "workspaceRepositoryDiff.headCommitOid",
    ),
    ...(raw.patchSha256 === undefined
      ? {}
      : {
          patchSha256: normalizeSha256(
            raw.patchSha256,
            "workspaceRepositoryDiff.patchSha256",
          ),
        }),
    patch,
    patchTruncated: booleanField(
      raw.patchTruncated,
      "workspaceRepositoryDiff.patchTruncated",
    ),
    untrackedPaths,
    untrackedPathsTruncated: booleanField(
      raw.untrackedPathsTruncated,
      "workspaceRepositoryDiff.untrackedPathsTruncated",
    ),
    ...(reviewGraph === undefined ? {} : { reviewGraph }),
  };
}

function normalizeWorkspaceRepositoryFileReview(
  value: unknown,
): WorkspaceRepositoryFileReview {
  const raw = exactRecord(value, "workspaceRepositoryFileReview", [
    "schemaVersion",
    "workspaceId",
    "repositoryId",
    "repositoryLabel",
    "baseCommitOid",
    "headCommitOid",
    "filePath",
    "patchSha256",
    "contentSha256",
    "content",
    "fullPatch",
  ]);
  const content = stringField(
    raw.content,
    "workspaceRepositoryFileReview.content",
    true,
  );
  const fullPatch = stringField(
    raw.fullPatch,
    "workspaceRepositoryFileReview.fullPatch",
    true,
  );
  if (
    new TextEncoder().encode(content).byteLength > 2 * 1024 * 1024 ||
    new TextEncoder().encode(fullPatch).byteLength > 8 * 1024 * 1024
  ) {
    return invalidPayload("workspaceRepositoryFileReview.bounds");
  }
  return {
    schemaVersion: integerField(
      raw.schemaVersion,
      "workspaceRepositoryFileReview.schemaVersion",
    ),
    workspaceId: stringField(
      raw.workspaceId,
      "workspaceRepositoryFileReview.workspaceId",
    ),
    repositoryId: stringField(
      raw.repositoryId,
      "workspaceRepositoryFileReview.repositoryId",
    ),
    repositoryLabel: stringField(
      raw.repositoryLabel,
      "workspaceRepositoryFileReview.repositoryLabel",
    ),
    baseCommitOid: stringField(
      raw.baseCommitOid,
      "workspaceRepositoryFileReview.baseCommitOid",
    ),
    headCommitOid: stringField(
      raw.headCommitOid,
      "workspaceRepositoryFileReview.headCommitOid",
    ),
    filePath: requiredRepositoryFilePath(
      stringField(raw.filePath, "workspaceRepositoryFileReview.filePath"),
    ),
    patchSha256: normalizeSha256(
      raw.patchSha256,
      "workspaceRepositoryFileReview.patchSha256",
    ),
    contentSha256: normalizeSha256(
      raw.contentSha256,
      "workspaceRepositoryFileReview.contentSha256",
    ),
    content,
    fullPatch,
  };
}

function normalizeWorkspaceRepositoryReviewGraph(
  value: unknown,
  path: string,
): WorkspaceRepositoryReviewGraph {
  const raw = exactRecord(value, path, [
    "graphSha256",
    "nodes",
    "links",
    "truncated",
  ]);
  if (
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.links) ||
    raw.nodes.length > 4_000 ||
    raw.links.length > 12_000
  ) {
    return invalidPayload(`${path}.bounds`);
  }
  return {
    graphSha256: stringField(raw.graphSha256, `${path}.graphSha256`),
    nodes: raw.nodes.map((value, index) => {
      const node = exactRecord(value, `${path}.nodes[${index}]`, [
        "id",
        "label",
        "sourceFile",
        "sourceLocation",
      ]);
      return {
        id: stringField(node.id, `${path}.nodes[${index}].id`),
        label: stringField(node.label, `${path}.nodes[${index}].label`),
        sourceFile: stringField(
          node.sourceFile,
          `${path}.nodes[${index}].sourceFile`,
        ),
        sourceLocation: stringField(
          node.sourceLocation,
          `${path}.nodes[${index}].sourceLocation`,
          true,
        ),
      };
    }),
    links: raw.links.map((value, index) => {
      const link = exactRecord(value, `${path}.links[${index}]`, [
        "source",
        "target",
        "relation",
        "confidence",
      ]);
      return {
        source: stringField(link.source, `${path}.links[${index}].source`),
        target: stringField(link.target, `${path}.links[${index}].target`),
        relation: stringField(
          link.relation,
          `${path}.links[${index}].relation`,
        ),
        confidence: stringField(
          link.confidence,
          `${path}.links[${index}].confidence`,
          true,
        ),
      };
    }),
    truncated: booleanField(raw.truncated, `${path}.truncated`),
  };
}

function normalizeWorkspaceRepositorySyncResult(
  value: unknown,
): WorkspaceRepositorySyncResult {
  const raw = exactRecord(value, "workspaceRepositorySyncResult", [
    "workspaceId",
    "repositoryId",
    "repositoryLabel",
    "previousBaseCommitOid",
    "baseCommitOid",
    "updated",
    "graphRefreshed",
    "graphDetail",
    "materialization",
  ]);
  const result = {
    workspaceId: stringField(
      raw.workspaceId,
      "workspaceRepositorySyncResult.workspaceId",
    ),
    repositoryId: stringField(
      raw.repositoryId,
      "workspaceRepositorySyncResult.repositoryId",
    ),
    repositoryLabel: stringField(
      raw.repositoryLabel,
      "workspaceRepositorySyncResult.repositoryLabel",
    ),
    previousBaseCommitOid: stringField(
      raw.previousBaseCommitOid,
      "workspaceRepositorySyncResult.previousBaseCommitOid",
    ),
    baseCommitOid: stringField(
      raw.baseCommitOid,
      "workspaceRepositorySyncResult.baseCommitOid",
    ),
    updated: booleanField(
      raw.updated,
      "workspaceRepositorySyncResult.updated",
    ),
    graphRefreshed: booleanField(
      raw.graphRefreshed,
      "workspaceRepositorySyncResult.graphRefreshed",
    ),
    graphDetail: stringField(
      raw.graphDetail,
      "workspaceRepositorySyncResult.graphDetail",
    ),
    materialization: normalizeMaterialization(
      raw.materialization,
      "workspaceRepositorySyncResult.materialization",
    ),
  };
  if (
    result.materialization.workspaceId !== result.workspaceId ||
    !result.materialization.worktrees.some(
      (worktree) =>
        worktree.repositoryId === result.repositoryId &&
        worktree.baseCommitOid === result.baseCommitOid,
    )
  ) {
    return invalidPayload("workspaceRepositorySyncResult.identity");
  }
  return result;
}

function normalizeWorkspaceRepositoryAlignmentPreflight(
  value: unknown,
): WorkspaceRepositoryAlignmentPreflight {
  const raw = exactRecord(value, "workspaceRepositoryAlignmentPreflight", [
    "workspaceId",
    "repositoryId",
    "repositoryLabel",
    "baseRef",
    "remoteFullRef",
    "currentCommitOid",
    "targetCommitOid",
    "backupFullRef",
    "effectDigest",
  ]);
  return {
    workspaceId: stringField(raw.workspaceId, "workspaceRepositoryAlignmentPreflight.workspaceId"),
    repositoryId: stringField(raw.repositoryId, "workspaceRepositoryAlignmentPreflight.repositoryId"),
    repositoryLabel: stringField(raw.repositoryLabel, "workspaceRepositoryAlignmentPreflight.repositoryLabel"),
    baseRef: stringField(raw.baseRef, "workspaceRepositoryAlignmentPreflight.baseRef"),
    remoteFullRef: stringField(raw.remoteFullRef, "workspaceRepositoryAlignmentPreflight.remoteFullRef"),
    currentCommitOid: stringField(raw.currentCommitOid, "workspaceRepositoryAlignmentPreflight.currentCommitOid"),
    targetCommitOid: stringField(raw.targetCommitOid, "workspaceRepositoryAlignmentPreflight.targetCommitOid"),
    backupFullRef: stringField(raw.backupFullRef, "workspaceRepositoryAlignmentPreflight.backupFullRef"),
    effectDigest: stringField(raw.effectDigest, "workspaceRepositoryAlignmentPreflight.effectDigest"),
  };
}

function normalizeWorkspaceRepositoryAlignmentResult(
  value: unknown,
): WorkspaceRepositoryAlignmentResult {
  const raw = exactRecord(value, "workspaceRepositoryAlignmentResult", [
    "workspaceId",
    "repositoryId",
    "repositoryLabel",
    "previousBaseCommitOid",
    "baseCommitOid",
    "backupFullRef",
    "graphRefreshed",
    "graphDetail",
    "materialization",
  ]);
  const result = {
    workspaceId: stringField(raw.workspaceId, "workspaceRepositoryAlignmentResult.workspaceId"),
    repositoryId: stringField(raw.repositoryId, "workspaceRepositoryAlignmentResult.repositoryId"),
    repositoryLabel: stringField(raw.repositoryLabel, "workspaceRepositoryAlignmentResult.repositoryLabel"),
    previousBaseCommitOid: stringField(raw.previousBaseCommitOid, "workspaceRepositoryAlignmentResult.previousBaseCommitOid"),
    baseCommitOid: stringField(raw.baseCommitOid, "workspaceRepositoryAlignmentResult.baseCommitOid"),
    backupFullRef: stringField(raw.backupFullRef, "workspaceRepositoryAlignmentResult.backupFullRef"),
    graphRefreshed: booleanField(raw.graphRefreshed, "workspaceRepositoryAlignmentResult.graphRefreshed"),
    graphDetail: stringField(raw.graphDetail, "workspaceRepositoryAlignmentResult.graphDetail"),
    materialization: normalizeMaterialization(raw.materialization, "workspaceRepositoryAlignmentResult.materialization"),
  };
  if (
    result.materialization.workspaceId !== result.workspaceId ||
    !result.materialization.worktrees.some(
      (worktree) =>
        worktree.repositoryId === result.repositoryId &&
        worktree.baseCommitOid === result.baseCommitOid,
    )
  ) {
    return invalidPayload("workspaceRepositoryAlignmentResult.identity");
  }
  return result;
}

function normalizeMaterializeResult(
  value: unknown,
): MaterializeWorkspaceResult {
  const raw = record(value, "materializeWorkspaceResult");
  return {
    replayed: booleanField(
      raw.replayed,
      "materializeWorkspaceResult.replayed",
    ),
    materialization: normalizeMaterialization(
      raw.materialization,
      "materializeWorkspaceResult.materialization",
    ),
  };
}

function normalizeOpenResult(value: unknown): OpenWorkspaceResult {
  const raw = record(value, "openWorkspaceResult");
  return {
    provider: enumField(
      raw.provider,
      ["vsCode"] as const,
      "openWorkspaceResult.provider",
    ),
    accepted: booleanField(
      raw.accepted,
      "openWorkspaceResult.accepted",
    ),
    workspaceId: stringField(
      raw.workspaceId,
      "openWorkspaceResult.workspaceId",
    ),
    codeWorkspaceDisplayPath: stringField(
      raw.codeWorkspaceDisplayPath,
      "openWorkspaceResult.codeWorkspaceDisplayPath",
    ),
  };
}

function normalizeOpenRepositoryBaseResult(
  value: unknown,
): OpenRepositoryBaseResult {
  const raw = exactRecord(value, "openRepositoryBaseResult", [
    "repositoryId",
    "forge",
    "host",
    "baseRef",
    "commitOid",
    "accepted",
  ]);
  const commitOid = stringField(
    raw.commitOid,
    "openRepositoryBaseResult.commitOid",
  );
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(commitOid)) {
    return invalidPayload("openRepositoryBaseResult.commitOid");
  }
  return {
    repositoryId: stringField(
      raw.repositoryId,
      "openRepositoryBaseResult.repositoryId",
    ),
    forge: enumField(
      raw.forge,
      ["github", "gitlab"] as const,
      "openRepositoryBaseResult.forge",
    ),
    host: stringField(raw.host, "openRepositoryBaseResult.host"),
    baseRef: stringField(raw.baseRef, "openRepositoryBaseResult.baseRef"),
    commitOid,
    accepted: booleanField(
      raw.accepted,
      "openRepositoryBaseResult.accepted",
    ),
  };
}

function normalizeWorkspaceChangeRequestDraft(
  value: unknown,
): WorkspaceChangeRequestDraft {
  const path = "workspaceChangeRequestDraft";
  const raw = exactRecord(value, path, [
    "schemaVersion", "workspaceId", "repositoryId", "repositoryLabel", "forge", "host",
    "sourceRemoteName", "sourceBranch", "sourceHeadCommitOid", "targetBranch",
    "commitSubject", "proposedBySessionId", "proposedByProvider", "commits", "changedFiles",
    "worktreeClean", "remoteMatches", "title", "body", "workItems",
    "verificationStatus", "verificationSummary", "effectDigest",
  ]);
  if (!Array.isArray(raw.workItems)) return invalidPayload(`${path}.workItems`);
  if (!Array.isArray(raw.commits)) return invalidPayload(`${path}.commits`);
  if (!Array.isArray(raw.changedFiles)) return invalidPayload(`${path}.changedFiles`);
  const head = stringField(raw.sourceHeadCommitOid, `${path}.sourceHeadCommitOid`);
  const digest = stringField(raw.effectDigest, `${path}.effectDigest`);
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(head)) {
    return invalidPayload(`${path}.sourceHeadCommitOid`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    return invalidPayload(`${path}.effectDigest`);
  }
  return {
    schemaVersion: integerField(raw.schemaVersion, `${path}.schemaVersion`),
    workspaceId: stringField(raw.workspaceId, `${path}.workspaceId`),
    repositoryId: stringField(raw.repositoryId, `${path}.repositoryId`),
    repositoryLabel: stringField(raw.repositoryLabel, `${path}.repositoryLabel`),
    forge: enumField(raw.forge, ["github", "gitlab"] as const, `${path}.forge`),
    host: stringField(raw.host, `${path}.host`),
    sourceRemoteName: stringField(raw.sourceRemoteName, `${path}.sourceRemoteName`),
    sourceBranch: stringField(raw.sourceBranch, `${path}.sourceBranch`),
    sourceHeadCommitOid: head,
    targetBranch: stringField(raw.targetBranch, `${path}.targetBranch`),
    commitSubject: stringField(raw.commitSubject, `${path}.commitSubject`),
    proposedBySessionId: stringField(raw.proposedBySessionId, `${path}.proposedBySessionId`),
    proposedByProvider: enumField(
      raw.proposedByProvider,
      agentProviders,
      `${path}.proposedByProvider`,
    ),
    commits: raw.commits.map((value, index) => {
      const commitPath = `${path}.commits[${index}]`;
      const commit = exactRecord(value, commitPath, ["commitOid", "subject"]);
      const commitOid = stringField(commit.commitOid, `${commitPath}.commitOid`);
      if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(commitOid)) {
        return invalidPayload(`${commitPath}.commitOid`);
      }
      return { commitOid, subject: stringField(commit.subject, `${commitPath}.subject`) };
    }),
    changedFiles: raw.changedFiles.map((value, index) =>
      stringField(value, `${path}.changedFiles[${index}]`),
    ),
    worktreeClean: booleanField(raw.worktreeClean, `${path}.worktreeClean`),
    remoteMatches: booleanField(raw.remoteMatches, `${path}.remoteMatches`),
    title: stringField(raw.title, `${path}.title`),
    body: stringField(raw.body, `${path}.body`),
    workItems: raw.workItems.map((value, index) => {
      const itemPath = `${path}.workItems[${index}]`;
      const item = exactRecord(value, itemPath, ["linkId", "issueKey", "summary"]);
      return {
        linkId: stringField(item.linkId, `${itemPath}.linkId`),
        issueKey: stringField(item.issueKey, `${itemPath}.issueKey`),
        summary: stringField(item.summary, `${itemPath}.summary`),
      };
    }),
    verificationStatus: enumField(
      raw.verificationStatus,
      ["notReported", "passed", "partial", "failed"] as const,
      `${path}.verificationStatus`,
    ),
    verificationSummary: stringField(raw.verificationSummary, `${path}.verificationSummary`),
    effectDigest: digest,
  };
}

function normalizeOpenWorkspaceChangeRequestResult(
  value: unknown,
): OpenWorkspaceChangeRequestResult {
  const path = "openWorkspaceChangeRequestResult";
  const raw = exactRecord(value, path, [
    "workspaceId", "repositoryId", "forge", "host", "sourceBranch", "targetBranch",
    "sourceHeadCommitOid", "accepted",
  ]);
  const head = stringField(raw.sourceHeadCommitOid, `${path}.sourceHeadCommitOid`);
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(head)) {
    return invalidPayload(`${path}.sourceHeadCommitOid`);
  }
  return {
    workspaceId: stringField(raw.workspaceId, `${path}.workspaceId`),
    repositoryId: stringField(raw.repositoryId, `${path}.repositoryId`),
    forge: enumField(raw.forge, ["github", "gitlab"] as const, `${path}.forge`),
    host: stringField(raw.host, `${path}.host`),
    sourceBranch: stringField(raw.sourceBranch, `${path}.sourceBranch`),
    targetBranch: stringField(raw.targetBranch, `${path}.targetBranch`),
    sourceHeadCommitOid: head,
    accepted: booleanField(raw.accepted, `${path}.accepted`),
  };
}

function normalizeWorkspaceCliLaunchResult(
  value: unknown,
): WorkspaceCliLaunchResult {
  const raw = exactRecord(value, "workspaceCliLaunchResult", [
    "workspaceId",
    "sessionId",
    "provider",
    "terminal",
    "accepted",
    "workspaceDisplayPath",
  ]);
  return {
    workspaceId: stringField(
      raw.workspaceId,
      "workspaceCliLaunchResult.workspaceId",
    ),
    sessionId:
      raw.sessionId === undefined
        ? undefined
        : uuidField(
            raw.sessionId,
            "workspaceCliLaunchResult.sessionId",
          ),
    provider: enumField(
      raw.provider,
      agentProviders,
      "workspaceCliLaunchResult.provider",
    ),
    terminal: enumField(
      raw.terminal,
      terminalProviders,
      "workspaceCliLaunchResult.terminal",
    ),
    accepted: booleanField(
      raw.accepted,
      "workspaceCliLaunchResult.accepted",
    ),
    workspaceDisplayPath: stringField(
      raw.workspaceDisplayPath,
      "workspaceCliLaunchResult.workspaceDisplayPath",
    ),
  };
}

function normalizeWorkspaceAgentBriefResult(
  value: unknown,
): WorkspaceAgentBriefResult {
  const raw = exactRecord(value, "workspaceAgentBriefResult", [
    "workspaceId",
    "workspaceDisplayPath",
    "briefDisplayPath",
  ]);
  return {
    workspaceId: stringField(
      raw.workspaceId,
      "workspaceAgentBriefResult.workspaceId",
    ),
    workspaceDisplayPath: stringField(
      raw.workspaceDisplayPath,
      "workspaceAgentBriefResult.workspaceDisplayPath",
    ),
    briefDisplayPath: stringField(
      raw.briefDisplayPath,
      "workspaceAgentBriefResult.briefDisplayPath",
    ),
  };
}

function normalizeGraphIndexResult(value: unknown): GraphIndexResult {
  const raw = record(value, "graphIndexResult");
  return {
    workspaceId: stringField(raw.workspaceId, "graphIndexResult.workspaceId"),
    status: enumField(raw.status, ["ready"] as const, "graphIndexResult.status"),
    graphDisplayPath: stringField(
      raw.graphDisplayPath,
      "graphIndexResult.graphDisplayPath",
    ),
    detail: stringField(raw.detail, "graphIndexResult.detail"),
    durationMs: integerField(raw.durationMs, "graphIndexResult.durationMs"),
  };
}

function normalizeWorkspaceRemovalPreflight(
  value: unknown,
): WorkspaceRemovalPreflight {
  const raw = record(value, "workspaceRemovalPreflight");
  if (
    !Array.isArray(raw.worktrees) ||
    !Array.isArray(raw.generatedPaths) ||
    !Array.isArray(raw.retainedBranches) ||
    !Array.isArray(raw.blockers) ||
    !Array.isArray(raw.warnings)
  ) {
    return invalidPayload("workspaceRemovalPreflight");
  }
  if (raw.protectedPaths !== undefined && !Array.isArray(raw.protectedPaths)) {
    return invalidPayload("workspaceRemovalPreflight.protectedPaths");
  }
  const normalized: WorkspaceRemovalPreflight = {
    workspaceId: stringField(
      raw.workspaceId,
      "workspaceRemovalPreflight.workspaceId",
    ),
    kind: enumField(
      raw.kind,
      ["savedPlan", "materializedWorkspace"] as const,
      "workspaceRemovalPreflight.kind",
    ),
    workspaceDisplayPath: stringField(
      raw.workspaceDisplayPath,
      "workspaceRemovalPreflight.workspaceDisplayPath",
    ),
    ready: booleanField(raw.ready, "workspaceRemovalPreflight.ready"),
    effectDigest: stringField(
      raw.effectDigest,
      "workspaceRemovalPreflight.effectDigest",
    ),
    worktrees: raw.worktrees.map((worktree, index) => {
      const path = `workspaceRemovalPreflight.worktrees[${index}]`;
      const item = record(worktree, path);
      return {
        repositoryId: stringField(
          item.repositoryId,
          `${path}.repositoryId`,
        ),
        label: stringField(item.label, `${path}.label`),
        targetDisplayPath: stringField(
          item.targetDisplayPath,
          `${path}.targetDisplayPath`,
        ),
        branchName: stringField(item.branchName, `${path}.branchName`),
        headCommitOid: stringField(
          item.headCommitOid,
          `${path}.headCommitOid`,
          true,
        ),
        present: booleanField(item.present, `${path}.present`),
      };
    }),
    generatedPaths: stringArray(
      raw.generatedPaths,
      "workspaceRemovalPreflight.generatedPaths",
    ),
    protectedPaths: (raw.protectedPaths ?? []).map((protectedPath, index) => {
      const path = `workspaceRemovalPreflight.protectedPaths[${index}]`;
      const item = record(protectedPath, path);
      if (item.filePreviews !== undefined && !Array.isArray(item.filePreviews)) {
        return invalidPayload(`${path}.filePreviews`);
      }
      return {
        displayPath: stringField(item.displayPath, `${path}.displayPath`),
        entries: stringArray(item.entries, `${path}.entries`),
        entriesTruncated: booleanField(
          item.entriesTruncated,
          `${path}.entriesTruncated`,
        ),
        filePreviews: (item.filePreviews ?? []).map((preview, previewIndex) => {
          const previewPath = `${path}.filePreviews[${previewIndex}]`;
          const previewItem = record(preview, previewPath);
          return {
            relativePath: stringField(
              previewItem.relativePath,
              `${previewPath}.relativePath`,
            ),
            contents: stringField(
              previewItem.contents,
              `${previewPath}.contents`,
              true,
            ),
          };
        }),
      };
    }),
    retainedBranches: stringArray(
      raw.retainedBranches,
      "workspaceRemovalPreflight.retainedBranches",
    ),
    blockers: raw.blockers.map((blocker, index) => {
      const path = `workspaceRemovalPreflight.blockers[${index}]`;
      const item = record(blocker, path);
      return {
        code: enumField(
          item.code,
          [
            "workspaceDrift",
            "worktreeChanges",
            "ignoredFiles",
            "planningDocumentsPresent",
            "unexpectedPath",
            "gitUnavailable",
          ] as const,
          `${path}.code`,
        ),
        message: stringField(item.message, `${path}.message`),
        repositoryLabel: optionalStringField(
          item.repositoryLabel,
          `${path}.repositoryLabel`,
        ),
      };
    }),
    warnings: stringArray(
      raw.warnings,
      "workspaceRemovalPreflight.warnings",
    ),
  };
  if (
    normalized.ready !== (normalized.blockers.length === 0) ||
    !/^sha256:[a-f0-9]{64}$/.test(normalized.effectDigest)
  ) {
    return invalidPayload("workspaceRemovalPreflight");
  }
  return normalized;
}

function normalizeRemoveWorkspaceResult(
  value: unknown,
): RemoveWorkspaceResult {
  const raw = record(value, "removeWorkspaceResult");
  if (
    !Array.isArray(raw.retainedBranches) ||
    !Array.isArray(raw.removedGeneratedPaths)
  ) {
    return invalidPayload("removeWorkspaceResult");
  }
  return {
    workspaceId: stringField(
      raw.workspaceId,
      "removeWorkspaceResult.workspaceId",
    ),
    replayed: booleanField(raw.replayed, "removeWorkspaceResult.replayed"),
    removedWorktreeCount: integerField(
      raw.removedWorktreeCount,
      "removeWorkspaceResult.removedWorktreeCount",
    ),
    retainedBranches: stringArray(
      raw.retainedBranches,
      "removeWorkspaceResult.retainedBranches",
    ),
    removedGeneratedPaths: stringArray(
      raw.removedGeneratedPaths,
      "removeWorkspaceResult.removedGeneratedPaths",
    ),
  };
}

function normalizeAgentRunResult(value: unknown): AgentRunResult {
  const raw = record(value, "agentRunResult");
  return {
    workspaceId: stringField(raw.workspaceId, "agentRunResult.workspaceId"),
    provider: enumField(
      raw.provider,
      agentProviders,
      "agentRunResult.provider",
    ),
    succeeded: booleanField(raw.succeeded, "agentRunResult.succeeded"),
    output: stringField(raw.output, "agentRunResult.output", true),
    durationMs: integerField(raw.durationMs, "agentRunResult.durationMs"),
  };
}

function nullableStringField(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return stringField(value, path);
}

function nullableIntegerField(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return integerField(value, path);
}

function normalizeWorkspaceVerificationResult(
  value: unknown,
  path: string,
): WorkspaceVerificationResult {
  const raw = record(value, path);
  if (!Array.isArray(raw.checks) || !Array.isArray(raw.warnings)) {
    return invalidPayload(path);
  }
  return {
    schemaVersion: integerField(raw.schemaVersion, `${path}.schemaVersion`),
    workspaceId: stringField(raw.workspaceId, `${path}.workspaceId`),
    planRevision: integerField(raw.planRevision, `${path}.planRevision`),
    status: enumField(
      raw.status,
      [
        "notRun",
        "running",
        "passed",
        "failed",
        "blocked",
        "cancelled",
      ] as const,
      `${path}.status`,
    ),
    startedAtUnixMs: nullableIntegerField(
      raw.startedAtUnixMs,
      `${path}.startedAtUnixMs`,
    ),
    completedAtUnixMs: nullableIntegerField(
      raw.completedAtUnixMs,
      `${path}.completedAtUnixMs`,
    ),
    durationMs: nullableIntegerField(raw.durationMs, `${path}.durationMs`),
    checks: raw.checks.map((check, index) => {
      const checkPath = `${path}.checks[${index}]`;
      const item = record(check, checkPath);
      return {
        checkId: stringField(item.checkId, `${checkPath}.checkId`),
        status: enumField(
          item.status,
          [
            "pending",
            "running",
            "passed",
            "failed",
            "timedOut",
            "skipped",
            "cancelled",
          ] as const,
          `${checkPath}.status`,
        ),
        startedAtUnixMs: nullableIntegerField(
          item.startedAtUnixMs,
          `${checkPath}.startedAtUnixMs`,
        ),
        completedAtUnixMs: nullableIntegerField(
          item.completedAtUnixMs,
          `${checkPath}.completedAtUnixMs`,
        ),
        durationMs: nullableIntegerField(
          item.durationMs,
          `${checkPath}.durationMs`,
        ),
        exitCode: nullableIntegerField(
          item.exitCode,
          `${checkPath}.exitCode`,
        ),
        logDisplayPath: nullableStringField(
          item.logDisplayPath,
          `${checkPath}.logDisplayPath`,
        ),
        detail: stringField(item.detail, `${checkPath}.detail`, true),
      };
    }),
    warnings: stringArray(raw.warnings, `${path}.warnings`),
  };
}

function normalizeWorkspaceEvidence(value: unknown): WorkspaceEvidence {
  const raw = record(value, "workspaceEvidence");
  const contextRaw = record(raw.context, "workspaceEvidence.context");
  const graphRaw = record(
    raw.graphManifest,
    "workspaceEvidence.graphManifest",
  );
  const planRaw = record(
    raw.verificationPlan,
    "workspaceEvidence.verificationPlan",
  );
  const resultRaw = record(
    raw.verificationResult,
    "workspaceEvidence.verificationResult",
  );
  const agentReportRaw = record(
    raw.agentReport,
    "workspaceEvidence.agentReport",
  );
  if (
    !Array.isArray(contextRaw.repositories) ||
    !Array.isArray(contextRaw.allowedRepositoryIds) ||
    !Array.isArray(graphRaw.indexedRepositories) ||
    !Array.isArray(planRaw.checks) ||
    !Array.isArray(resultRaw.checks) ||
    !Array.isArray(resultRaw.warnings) ||
    !Array.isArray(agentReportRaw.findings) ||
    !Array.isArray(agentReportRaw.nextActions) ||
    !Array.isArray(agentReportRaw.proposedChecks) ||
    !Array.isArray(agentReportRaw.validationFlows) ||
    !Array.isArray(raw.agentRuns)
  ) {
    return invalidPayload("workspaceEvidence");
  }

  const context: WorkspaceEvidenceContext = {
    schemaVersion: integerField(
      contextRaw.schemaVersion,
      "workspaceEvidence.context.schemaVersion",
    ),
    workspaceId: stringField(
      contextRaw.workspaceId,
      "workspaceEvidence.context.workspaceId",
    ),
    workspaceRecordVersion: integerField(
      contextRaw.workspaceRecordVersion,
      "workspaceEvidence.context.workspaceRecordVersion",
    ),
    title: stringField(contextRaw.title, "workspaceEvidence.context.title"),
    intent: normalizeIntent(
      contextRaw.intent,
      "workspaceEvidence.context.intent",
    ),
    preferredProvider: normalizeProvider(
      contextRaw.preferredProvider,
      "workspaceEvidence.context.preferredProvider",
    ),
    branchName: stringField(
      contextRaw.branchName,
      "workspaceEvidence.context.branchName",
    ),
    workspaceDisplayPath: stringField(
      contextRaw.workspaceDisplayPath,
      "workspaceEvidence.context.workspaceDisplayPath",
    ),
    codeWorkspaceDisplayPath: stringField(
      contextRaw.codeWorkspaceDisplayPath,
      "workspaceEvidence.context.codeWorkspaceDisplayPath",
    ),
    evidenceDisplayPath: stringField(
      contextRaw.evidenceDisplayPath,
      "workspaceEvidence.context.evidenceDisplayPath",
    ),
    createdAtUnixMs: integerField(
      contextRaw.createdAtUnixMs,
      "workspaceEvidence.context.createdAtUnixMs",
    ),
    wtsVersion: stringField(
      contextRaw.wtsVersion,
      "workspaceEvidence.context.wtsVersion",
    ),
    repositories: contextRaw.repositories.map((repository, index) => {
      const path = `workspaceEvidence.context.repositories[${index}]`;
      const item = record(repository, path);
      return {
        repositoryId: stringField(item.repositoryId, `${path}.repositoryId`),
        label: stringField(item.label, `${path}.label`),
        requestedBaseRef: stringField(
          item.requestedBaseRef,
          `${path}.requestedBaseRef`,
        ),
        resolvedBaseRef: stringField(
          item.resolvedBaseRef,
          `${path}.resolvedBaseRef`,
        ),
        baseCommitOid: stringField(
          item.baseCommitOid,
          `${path}.baseCommitOid`,
        ),
        worktreeDisplayPath: stringField(
          item.worktreeDisplayPath,
          `${path}.worktreeDisplayPath`,
        ),
      };
    }),
    allowedRepositoryIds: stringArray(
      contextRaw.allowedRepositoryIds,
      "workspaceEvidence.context.allowedRepositoryIds",
    ),
  };

  const graphManifest: WorkspaceGraphManifest = {
    schemaVersion: integerField(
      graphRaw.schemaVersion,
      "workspaceEvidence.graphManifest.schemaVersion",
    ),
    workspaceId: stringField(
      graphRaw.workspaceId,
      "workspaceEvidence.graphManifest.workspaceId",
    ),
    status: enumField(
      graphRaw.status,
      ["notStarted", "ready", "failed"] as const,
      "workspaceEvidence.graphManifest.status",
    ),
    graphDisplayPath: nullableStringField(
      graphRaw.graphDisplayPath,
      "workspaceEvidence.graphManifest.graphDisplayPath",
    ),
    graphSha256: nullableStringField(
      graphRaw.graphSha256,
      "workspaceEvidence.graphManifest.graphSha256",
    ),
    indexedAtUnixMs: nullableIntegerField(
      graphRaw.indexedAtUnixMs,
      "workspaceEvidence.graphManifest.indexedAtUnixMs",
    ),
    indexedRepositories: graphRaw.indexedRepositories.map(
      (repository, index) => {
        const path = `workspaceEvidence.graphManifest.indexedRepositories[${index}]`;
        const item = record(repository, path);
        return {
          repositoryId: stringField(item.repositoryId, `${path}.repositoryId`),
          commitOid: stringField(item.commitOid, `${path}.commitOid`),
        };
      },
    ),
    detail: stringField(
      graphRaw.detail,
      "workspaceEvidence.graphManifest.detail",
      true,
    ),
  };

  const verificationPlan: WorkspaceVerificationPlan = {
    schemaVersion: integerField(
      planRaw.schemaVersion,
      "workspaceEvidence.verificationPlan.schemaVersion",
    ),
    workspaceId: stringField(
      planRaw.workspaceId,
      "workspaceEvidence.verificationPlan.workspaceId",
    ),
    revision: integerField(
      planRaw.revision,
      "workspaceEvidence.verificationPlan.revision",
    ),
    updatedAtUnixMs: integerField(
      planRaw.updatedAtUnixMs,
      "workspaceEvidence.verificationPlan.updatedAtUnixMs",
    ),
    checks: planRaw.checks.map((check, index) => {
      const path = `workspaceEvidence.verificationPlan.checks[${index}]`;
      const item = record(check, path);
      if (
        !Array.isArray(item.args) ||
        !Array.isArray(item.environmentNames) ||
        !Array.isArray(item.acceptanceFiles)
      ) {
        return invalidPayload(path);
      }
      return {
        id: stringField(item.id, `${path}.id`),
        label: stringField(item.label, `${path}.label`),
        kind: enumField(
          item.kind,
          [
            "unit",
            "integration",
            "ui",
            "contract",
            "lint",
            "build",
            "custom",
          ] as const,
          `${path}.kind`,
        ),
        repositoryId:
          item.repositoryId === null || item.repositoryId === undefined
            ? null
            : stringField(item.repositoryId, `${path}.repositoryId`),
        workingDirectory: stringField(
          item.workingDirectory,
          `${path}.workingDirectory`,
        ),
        executable: stringField(item.executable, `${path}.executable`),
        args: stringArray(item.args, `${path}.args`),
        timeoutMs: integerField(item.timeoutMs, `${path}.timeoutMs`),
        outputLimitBytes: integerField(
          item.outputLimitBytes,
          `${path}.outputLimitBytes`,
        ),
        required: booleanField(item.required, `${path}.required`),
        environmentNames: stringArray(
          item.environmentNames,
          `${path}.environmentNames`,
        ),
        acceptanceFiles: item.acceptanceFiles.map(
          (acceptanceFile, acceptanceIndex) => {
            const acceptancePath = `${path}.acceptanceFiles[${acceptanceIndex}]`;
            const acceptance = record(acceptanceFile, acceptancePath);
            return {
              displayPath: stringField(
                acceptance.displayPath,
                `${acceptancePath}.displayPath`,
              ),
              sha256: stringField(
                acceptance.sha256,
                `${acceptancePath}.sha256`,
              ),
            };
          },
        ),
      };
    }),
  };

  const verificationResult = normalizeWorkspaceVerificationResult(
    resultRaw,
    "workspaceEvidence.verificationResult",
  );
  const verificationHistory = (
    Array.isArray(raw.verificationHistory) ? raw.verificationHistory : []
  ).map((run, index) =>
    normalizeWorkspaceVerificationResult(
      run,
      `workspaceEvidence.verificationHistory[${index}]`,
    ),
  );

  const agentRuns: WorkspaceAgentEvidence[] = raw.agentRuns.map(
    (run, index) => {
      const path = `workspaceEvidence.agentRuns[${index}]`;
      const item = record(run, path);
      return {
        schemaVersion: integerField(item.schemaVersion, `${path}.schemaVersion`),
        runId: stringField(item.runId, `${path}.runId`),
        workspaceId: stringField(item.workspaceId, `${path}.workspaceId`),
        provider: enumField(item.provider, agentProviders, `${path}.provider`),
        state: enumField(
          item.state,
          ["running", "succeeded", "failed"] as const,
          `${path}.state`,
        ),
        startedAtUnixMs: integerField(
          item.startedAtUnixMs,
          `${path}.startedAtUnixMs`,
        ),
        completedAtUnixMs: nullableIntegerField(
          item.completedAtUnixMs,
          `${path}.completedAtUnixMs`,
        ),
        durationMs: nullableIntegerField(
          item.durationMs,
          `${path}.durationMs`,
        ),
        promptSha256: stringField(
          item.promptSha256,
          `${path}.promptSha256`,
        ),
        outputSha256: nullableStringField(
          item.outputSha256,
          `${path}.outputSha256`,
        ),
        failure:
          item.failure === null || item.failure === undefined
            ? null
            : enumField(
                item.failure,
                [
                  "unavailable",
                  "spawnFailed",
                  "timedOut",
                  "outputTooLarge",
                  "providerFailed",
                ] as const,
                `${path}.failure`,
              ),
      };
    },
  );

  const agentReport: WorkspaceAgentReport = {
    schemaVersion: integerField(
      agentReportRaw.schemaVersion,
      "workspaceEvidence.agentReport.schemaVersion",
    ),
    workspaceId: stringField(
      agentReportRaw.workspaceId,
      "workspaceEvidence.agentReport.workspaceId",
    ),
    status: enumField(
      agentReportRaw.status,
      ["notReported", "ready", "invalid"] as const,
      "workspaceEvidence.agentReport.status",
    ),
    displayPath: stringField(
      agentReportRaw.displayPath,
      "workspaceEvidence.agentReport.displayPath",
    ),
    updatedAtUnixMs: nullableIntegerField(
      agentReportRaw.updatedAtUnixMs,
      "workspaceEvidence.agentReport.updatedAtUnixMs",
    ),
    summary: stringField(
      agentReportRaw.summary,
      "workspaceEvidence.agentReport.summary",
      true,
    ),
    findings: agentReportRaw.findings.map((finding, index) => {
      const path = `workspaceEvidence.agentReport.findings[${index}]`;
      const item = record(finding, path);
      if (!Array.isArray(item.evidence)) {
        return invalidPayload(path);
      }
      return {
        id: stringField(item.id, `${path}.id`),
        title: stringField(item.title, `${path}.title`),
        detail: stringField(item.detail, `${path}.detail`, true),
        severity: enumField(
          item.severity,
          ["info", "warning", "critical"] as const,
          `${path}.severity`,
        ),
        repositoryId: nullableStringField(
          item.repositoryId,
          `${path}.repositoryId`,
        ),
        evidence: stringArray(item.evidence, `${path}.evidence`),
        flowIds:
          item.flowIds === undefined
            ? []
            : stringArray(item.flowIds, `${path}.flowIds`),
      };
    }),
    nextActions: stringArray(
      agentReportRaw.nextActions,
      "workspaceEvidence.agentReport.nextActions",
    ),
    proposedChecks: agentReportRaw.proposedChecks.map((proposal, index) => {
      const path = `workspaceEvidence.agentReport.proposedChecks[${index}]`;
      const item = record(proposal, path);
      if (
        !Array.isArray(item.args) ||
        !Array.isArray(item.environmentNames) ||
        !Array.isArray(item.evidence)
      ) {
        return invalidPayload(path);
      }
      return {
        id: stringField(item.id, `${path}.id`),
        label: stringField(item.label, `${path}.label`),
        kind: enumField(
          item.kind,
          [
            "unit",
            "integration",
            "ui",
            "contract",
            "lint",
            "build",
            "custom",
          ] as const,
          `${path}.kind`,
        ),
        repositoryId: stringField(
          item.repositoryId,
          `${path}.repositoryId`,
        ),
        workingDirectory: stringField(
          item.workingDirectory,
          `${path}.workingDirectory`,
        ),
        executable: stringField(item.executable, `${path}.executable`),
        args: stringArray(item.args, `${path}.args`),
        timeoutMs: integerField(item.timeoutMs, `${path}.timeoutMs`),
        environmentNames: stringArray(
          item.environmentNames,
          `${path}.environmentNames`,
        ),
        reason: stringField(item.reason, `${path}.reason`),
        evidence: stringArray(item.evidence, `${path}.evidence`),
      };
    }),
    validationFlows: agentReportRaw.validationFlows.map((flow, index) => {
      const path = `workspaceEvidence.agentReport.validationFlows[${index}]`;
      const item = record(flow, path);
      if (
        !Array.isArray(item.prerequisites) ||
        !Array.isArray(item.steps)
      ) {
        return invalidPayload(path);
      }
      return {
        id: stringField(item.id, `${path}.id`),
        title: stringField(item.title, `${path}.title`),
        goal: stringField(item.goal, `${path}.goal`),
        prerequisites: stringArray(
          item.prerequisites,
          `${path}.prerequisites`,
        ),
        steps: item.steps.map((step, stepIndex) => {
          const stepPath = `${path}.steps[${stepIndex}]`;
          const stepItem = record(step, stepPath);
          if (!Array.isArray(stepItem.evidence)) {
            return invalidPayload(stepPath);
          }
          return {
            id: stringField(stepItem.id, `${stepPath}.id`),
            action: stringField(stepItem.action, `${stepPath}.action`),
            expected: stringField(stepItem.expected, `${stepPath}.expected`),
            evidence: stringArray(
              stepItem.evidence,
              `${stepPath}.evidence`,
            ),
          };
        }),
      };
    }),
    scope: (() => {
      if (agentReportRaw.scope === undefined || agentReportRaw.scope === null) {
        return {
          coverage: "unassessed" as const,
          graphStatus: "notStarted" as const,
          reviewedRepositoryIds: [],
          unresolvedRepositoryIds: [],
          skippedRepositories: [],
        };
      }
            const scopePath = "workspaceEvidence.agentReport.scope";
            const scope = record(agentReportRaw.scope, scopePath);
            if (
              !Array.isArray(scope.reviewedRepositoryIds) ||
              !Array.isArray(scope.unresolvedRepositoryIds) ||
              !Array.isArray(scope.skippedRepositories)
            ) {
              return invalidPayload(scopePath);
            }
            return {
              coverage: enumField(
                scope.coverage,
                ["unassessed", "partial", "complete"] as const,
                `${scopePath}.coverage`,
              ),
              graphStatus: enumField(
                scope.graphStatus,
                ["notStarted", "ready", "failed"] as const,
                `${scopePath}.graphStatus`,
              ),
              graphSha256:
                scope.graphSha256 === undefined || scope.graphSha256 === null
                  ? undefined
                  : stringField(
                      scope.graphSha256,
                      `${scopePath}.graphSha256`,
                    ),
              reviewedRepositoryIds: stringArray(
                scope.reviewedRepositoryIds,
                `${scopePath}.reviewedRepositoryIds`,
              ),
              unresolvedRepositoryIds: stringArray(
                scope.unresolvedRepositoryIds,
                `${scopePath}.unresolvedRepositoryIds`,
              ),
              skippedRepositories: scope.skippedRepositories.map(
                (skipped, skippedIndex) => {
                  const skippedPath = `${scopePath}.skippedRepositories[${skippedIndex}]`;
                  const item = record(skipped, skippedPath);
                  return {
                    repositoryId: stringField(
                      item.repositoryId,
                      `${skippedPath}.repositoryId`,
                    ),
                    reason: stringField(
                      item.reason,
                      `${skippedPath}.reason`,
                    ),
                  };
                },
              ),
            };
          })(),
    environment: (() => {
      if (
        agentReportRaw.environment === undefined ||
        agentReportRaw.environment === null
      ) {
        return {
          status: "unassessed" as const,
          summary: "",
          requirements: [],
          setupSteps: [],
          unresolved: [],
        };
      }
      const environmentPath = "workspaceEvidence.agentReport.environment";
      const environment = record(
        agentReportRaw.environment,
        environmentPath,
      );
      if (
        !Array.isArray(environment.requirements) ||
        !Array.isArray(environment.setupSteps) ||
        !Array.isArray(environment.unresolved)
      ) {
        return invalidPayload(environmentPath);
      }
      return {
        status: enumField(
          environment.status,
          ["unassessed", "planned", "needsInput", "blocked"] as const,
          `${environmentPath}.status`,
        ),
        summary: stringField(
          environment.summary,
          `${environmentPath}.summary`,
          true,
        ),
        requirements: environment.requirements.map(
          (requirement, requirementIndex) => {
            const path = `${environmentPath}.requirements[${requirementIndex}]`;
            const item = record(requirement, path);
            if (!Array.isArray(item.evidence)) {
              return invalidPayload(path);
            }
            return {
              id: stringField(item.id, `${path}.id`),
              repositoryId: stringField(
                item.repositoryId,
                `${path}.repositoryId`,
              ),
              kind: enumField(
                item.kind,
                ["toolchain", "configuration", "secret", "service"] as const,
                `${path}.kind`,
              ),
              name: stringField(item.name, `${path}.name`),
              required: booleanField(item.required, `${path}.required`),
              source: enumField(
                item.source,
                ["repository", "generated", "user", "external"] as const,
                `${path}.source`,
              ),
              detail: stringField(item.detail, `${path}.detail`),
              evidence: item.evidence.map((entry, evidenceIndex) => {
                const evidencePath = `${path}.evidence[${evidenceIndex}]`;
                const evidence = record(entry, evidencePath);
                return {
                  repositoryId: stringField(
                    evidence.repositoryId,
                    `${evidencePath}.repositoryId`,
                  ),
                  path: stringField(
                    evidence.path,
                    `${evidencePath}.path`,
                  ),
                  line:
                    evidence.line === undefined
                      ? undefined
                      : integerField(
                          evidence.line,
                          `${evidencePath}.line`,
                        ),
                };
              }),
            };
          },
        ),
        setupSteps: environment.setupSteps.map((step, stepIndex) => {
          const path = `${environmentPath}.setupSteps[${stepIndex}]`;
          const item = record(step, path);
          if (
            !Array.isArray(item.command) ||
            !Array.isArray(item.evidence)
          ) {
            return invalidPayload(path);
          }
          return {
            id: stringField(item.id, `${path}.id`),
            repositoryId: stringField(
              item.repositoryId,
              `${path}.repositoryId`,
            ),
            workingDirectory: stringField(
              item.workingDirectory,
              `${path}.workingDirectory`,
            ),
            action: stringField(item.action, `${path}.action`),
            command: stringArray(item.command, `${path}.command`),
            evidence: item.evidence.map((entry, evidenceIndex) => {
              const evidencePath = `${path}.evidence[${evidenceIndex}]`;
              const evidence = record(entry, evidencePath);
              return {
                repositoryId: stringField(
                  evidence.repositoryId,
                  `${evidencePath}.repositoryId`,
                ),
                path: stringField(evidence.path, `${evidencePath}.path`),
                line:
                  evidence.line === undefined
                    ? undefined
                    : integerField(
                        evidence.line,
                        `${evidencePath}.line`,
                      ),
              };
            }),
          };
        }),
        unresolved: stringArray(
          environment.unresolved,
          `${environmentPath}.unresolved`,
        ),
      };
    })(),
    flows: (
      Array.isArray(agentReportRaw.flows) ? agentReportRaw.flows : []
    ).map((flow, index) => {
      const path = `workspaceEvidence.agentReport.flows[${index}]`;
      const item = record(flow, path);
      if (
        !Array.isArray(item.actors) ||
        !Array.isArray(item.entryPoints) ||
        !Array.isArray(item.steps) ||
        !Array.isArray(item.risks) ||
        !Array.isArray(item.existingCoverage) ||
        !Array.isArray(item.verificationCandidateIds)
      ) {
        return invalidPayload(path);
      }
      return {
        id: stringField(item.id, `${path}.id`),
        title: stringField(item.title, `${path}.title`),
        kind: enumField(
          item.kind,
          ["user", "service", "operational"] as const,
          `${path}.kind`,
        ),
        actors: stringArray(item.actors, `${path}.actors`),
        entryPoints: stringArray(item.entryPoints, `${path}.entryPoints`),
        steps: item.steps.map((step, stepIndex) => {
          const stepPath = `${path}.steps[${stepIndex}]`;
          const stepItem = record(step, stepPath);
          if (!Array.isArray(stepItem.evidence)) {
            return invalidPayload(stepPath);
          }
          return {
            id: stringField(stepItem.id, `${stepPath}.id`),
            repositoryId: stringField(
              stepItem.repositoryId,
              `${stepPath}.repositoryId`,
            ),
            component: stringField(
              stepItem.component,
              `${stepPath}.component`,
            ),
            action: stringField(stepItem.action, `${stepPath}.action`),
            evidence: stepItem.evidence.map((entry, evidenceIndex) => {
              const evidencePath = `${stepPath}.evidence[${evidenceIndex}]`;
              const evidence = record(entry, evidencePath);
              return {
                repositoryId: stringField(
                  evidence.repositoryId,
                  `${evidencePath}.repositoryId`,
                ),
                path: stringField(evidence.path, `${evidencePath}.path`),
                line:
                  evidence.line === undefined
                    ? undefined
                    : integerField(evidence.line, `${evidencePath}.line`),
              };
            }),
          };
        }),
        expectedOutcome: stringField(
          item.expectedOutcome,
          `${path}.expectedOutcome`,
        ),
        risks: stringArray(item.risks, `${path}.risks`),
        existingCoverage: stringArray(
          item.existingCoverage,
          `${path}.existingCoverage`,
        ),
        verificationCandidateIds: stringArray(
          item.verificationCandidateIds,
          `${path}.verificationCandidateIds`,
        ),
      };
    }),
    detail: stringField(
      agentReportRaw.detail,
      "workspaceEvidence.agentReport.detail",
      true,
    ),
  };

  const workspaceIds = [
    context.workspaceId,
    graphManifest.workspaceId,
    verificationPlan.workspaceId,
    verificationResult.workspaceId,
    ...verificationHistory.map((run) => run.workspaceId),
    agentReport.workspaceId,
    ...agentRuns.map((run) => run.workspaceId),
  ];
  if (workspaceIds.some((workspaceId) => workspaceId !== context.workspaceId)) {
    return invalidPayload("workspaceEvidence.workspaceId");
  }

  return {
    context,
    graphManifest,
    verificationPlan,
    verificationResult,
    verificationHistory,
    agentReport,
    agentRuns,
  };
}

function normalizeWorkspaceTestRunSummary(
  value: unknown,
  path = "workspaceTestRun",
): WorkspaceTestRunSummary {
  const raw = record(value, path);
  const passedSteps = integerField(raw.passedSteps, `${path}.passedSteps`);
  const failedSteps = integerField(raw.failedSteps, `${path}.failedSteps`);
  const totalSteps = integerField(raw.totalSteps, `${path}.totalSteps`);
  const state = enumField(
    raw.state,
    ["passed", "failed", "cancelled", "timedOut", "running"] as const,
    `${path}.state`,
  );
  const completedAtUnixMs = nullableIntegerField(
    raw.completedAtUnixMs,
    `${path}.completedAtUnixMs`,
  );
  const durationMs = nullableIntegerField(
    raw.durationMs,
    `${path}.durationMs`,
  );
  const failedStepId = nullableStringField(
    raw.failedStepId,
    `${path}.failedStepId`,
  );
  const message = nullableStringField(
    raw.message,
    `${path}.message`,
  );

  if (
    passedSteps + failedSteps > totalSteps ||
    (state === "passed" && failedSteps !== 0) ||
    (failedStepId !== null && failedSteps === 0) ||
    (message !== null && state === "passed")
  ) {
    return invalidPayload(path);
  }

  return {
    schemaVersion: integerField(raw.schemaVersion, `${path}.schemaVersion`),
    runId: stringField(raw.runId, `${path}.runId`),
    workspaceId: stringField(raw.workspaceId, `${path}.workspaceId`),
    journeyId: stringField(raw.journeyId, `${path}.journeyId`),
    title: stringField(raw.title, `${path}.title`),
    state,
    startedAtUnixMs: integerField(
      raw.startedAtUnixMs,
      `${path}.startedAtUnixMs`,
    ),
    completedAtUnixMs,
    durationMs,
    passedSteps,
    failedSteps,
    totalSteps,
    failedStepId,
    message,
    artifactsDisplayPath: stringField(
      raw.artifactsDisplayPath,
      `${path}.artifactsDisplayPath`,
    ),
    graphSha256: nullableStringField(
      raw.graphSha256,
      `${path}.graphSha256`,
    ),
  };
}

function normalizeWorkspaceTestRunList(
  value: unknown,
): WorkspaceTestRunList {
  const raw = record(value, "workspaceTestRuns");
  if (!Array.isArray(raw.runs)) {
    return invalidPayload("workspaceTestRuns.runs");
  }
  return {
    schemaVersion: integerField(
      raw.schemaVersion,
      "workspaceTestRuns.schemaVersion",
    ),
    workspaceId: stringField(
      raw.workspaceId,
      "workspaceTestRuns.workspaceId",
    ),
    runs: raw.runs.map((run, index) =>
      normalizeWorkspaceTestRunSummary(
        run,
        `workspaceTestRuns.runs[${index}]`,
      ),
    ),
  };
}

function normalizeWorkspaceTestRunDetail(
  value: unknown,
): WorkspaceTestRunDetail {
  const raw = record(value, "workspaceTestRunDetail");
  if (
    !Array.isArray(raw.steps) ||
    !Array.isArray(raw.consoleErrors) ||
    !Array.isArray(raw.requests) ||
    !Array.isArray(raw.artifacts)
  ) {
    return invalidPayload("workspaceTestRunDetail");
  }
  const normalizeConsoleError = (value: unknown, path: string) => {
    const item = record(value, path);
    return {
      kind: stringField(item.kind, `${path}.kind`),
      text: stringField(item.text, `${path}.text`, true),
      timestampUnixMs: integerField(
        item.timestampUnixMs,
        `${path}.timestampUnixMs`,
      ),
    };
  };
  const normalizeRequest = (value: unknown, path: string) => {
    const item = record(value, path);
    return {
      method: stringField(item.method, `${path}.method`),
      url: stringField(item.url, `${path}.url`),
      status: nullableIntegerField(item.status, `${path}.status`),
      failure: nullableStringField(item.failure, `${path}.failure`),
    };
  };
  const steps = raw.steps.map((value, index) => {
    const path = `workspaceTestRunDetail.steps[${index}]`;
    const step = record(value, path);
    return {
      stepId: stringField(step.stepId, `${path}.stepId`),
      label: stringField(step.label, `${path}.label`),
      kind: stringField(step.kind, `${path}.kind`),
      state: enumField(
        step.state,
        ["passed", "failed"] as const,
        `${path}.state`,
      ),
      startedAtUnixMs: integerField(
        step.startedAtUnixMs,
        `${path}.startedAtUnixMs`,
      ),
      completedAtUnixMs: integerField(
        step.completedAtUnixMs,
        `${path}.completedAtUnixMs`,
      ),
      durationMs: integerField(step.durationMs, `${path}.durationMs`),
      snapshotArtifactId: nullableStringField(
        step.snapshotArtifactId,
        `${path}.snapshotArtifactId`,
      ),
      screenshotArtifactId: nullableStringField(
        step.screenshotArtifactId,
        `${path}.screenshotArtifactId`,
      ),
      error: nullableStringField(step.error, `${path}.error`),
    };
  });
  const consoleErrors = raw.consoleErrors.map((value, index) =>
    normalizeConsoleError(
      value,
      `workspaceTestRunDetail.consoleErrors[${index}]`,
    ),
  );
  const requests = raw.requests.map((value, index) =>
    normalizeRequest(value, `workspaceTestRunDetail.requests[${index}]`),
  );
  const artifacts = raw.artifacts.map((value, index) => {
    const path = `workspaceTestRunDetail.artifacts[${index}]`;
    const artifact = record(value, path);
    return {
      artifactId: stringField(artifact.artifactId, `${path}.artifactId`),
      kind: enumField(
        artifact.kind,
        [
          "trace",
          "failureScreenshot",
          "stepSnapshot",
          "screenshot",
        ] as const,
        `${path}.kind`,
      ),
      relativePath: stringField(
        artifact.relativePath,
        `${path}.relativePath`,
      ),
      displayPath: stringField(artifact.displayPath, `${path}.displayPath`),
      bytes: integerField(artifact.bytes, `${path}.bytes`),
      sha256: stringField(artifact.sha256, `${path}.sha256`),
    };
  });
  let failure: WorkspaceTestRunDetail["failure"] = null;
  if (raw.failure !== undefined && raw.failure !== null) {
    const item = record(raw.failure, "workspaceTestRunDetail.failure");
    if (
      !Array.isArray(item.consoleErrors) ||
      !Array.isArray(item.failedRequests) ||
      !Array.isArray(item.artifactIds)
    ) {
      return invalidPayload("workspaceTestRunDetail.failure");
    }
    failure = {
      failedStepId: nullableStringField(
        item.failedStepId,
        "workspaceTestRunDetail.failure.failedStepId",
      ),
      failedStepKind: nullableStringField(
        item.failedStepKind,
        "workspaceTestRunDetail.failure.failedStepKind",
      ),
      name: stringField(item.name, "workspaceTestRunDetail.failure.name"),
      message: stringField(
        item.message,
        "workspaceTestRunDetail.failure.message",
      ),
      consoleErrors: item.consoleErrors.map((value, index) =>
        normalizeConsoleError(
          value,
          `workspaceTestRunDetail.failure.consoleErrors[${index}]`,
        ),
      ),
      failedRequests: item.failedRequests.map((value, index) =>
        normalizeRequest(
          value,
          `workspaceTestRunDetail.failure.failedRequests[${index}]`,
        ),
      ),
      artifactIds: stringArray(
        item.artifactIds,
        "workspaceTestRunDetail.failure.artifactIds",
      ),
    };
  }

  return {
    schemaVersion: integerField(
      raw.schemaVersion,
      "workspaceTestRunDetail.schemaVersion",
    ),
    runId: stringField(raw.runId, "workspaceTestRunDetail.runId"),
    workspaceId: stringField(
      raw.workspaceId,
      "workspaceTestRunDetail.workspaceId",
    ),
    journeyId: stringField(
      raw.journeyId,
      "workspaceTestRunDetail.journeyId",
    ),
    state: enumField(
      raw.state,
      ["passed", "failed", "cancelled", "timedOut"] as const,
      "workspaceTestRunDetail.state",
    ),
    startedAtUnixMs: integerField(
      raw.startedAtUnixMs,
      "workspaceTestRunDetail.startedAtUnixMs",
    ),
    completedAtUnixMs: integerField(
      raw.completedAtUnixMs,
      "workspaceTestRunDetail.completedAtUnixMs",
    ),
    durationMs: integerField(
      raw.durationMs,
      "workspaceTestRunDetail.durationMs",
    ),
    steps,
    consoleErrors,
    requests,
    artifacts,
    failure,
    graphSha256: nullableStringField(
      raw.graphSha256,
      "workspaceTestRunDetail.graphSha256",
    ),
  };
}

function normalizeJiraVerification(value: unknown): JiraMcpVerification {
  const raw = record(value, "jiraMcpVerification");
  return {
    connected: booleanField(
      raw.connected,
      "jiraMcpVerification.connected",
    ),
    serverName: stringField(
      raw.serverName,
      "jiraMcpVerification.serverName",
    ),
    serverVersion: stringField(
      raw.serverVersion,
      "jiraMcpVerification.serverVersion",
    ),
    issueTool: stringField(
      raw.issueTool,
      "jiraMcpVerification.issueTool",
    ),
  };
}

function normalizeJiraIssueImport(value: unknown): JiraIssueImport {
  const raw = exactRecord(value, "jiraIssueImport", [
    "issueKey",
    "summary",
    "status",
    "content",
    "suggestedRepositories",
    "repositoryRecommendations",
  ]);
  return {
    issueKey: stringField(raw.issueKey, "jiraIssueImport.issueKey"),
    summary: optionalStringField(raw.summary, "jiraIssueImport.summary"),
    status: optionalStringField(raw.status, "jiraIssueImport.status"),
    content: stringField(raw.content, "jiraIssueImport.content"),
    suggestedRepositories: stringArray(
      raw.suggestedRepositories,
      "jiraIssueImport.suggestedRepositories",
    ),
    repositoryRecommendations: normalizeRepositoryRecommendations(
      raw.repositoryRecommendations,
      "jiraIssueImport.repositoryRecommendations",
    ),
  };
}

const workItemRoles: readonly WorkspaceWorkItemRole[] = [
  "primary",
  "related",
  "createdFromWorkspace",
];

function normalizeWorkItemRole(
  value: unknown,
  path: string,
): WorkspaceWorkItemRole {
  return enumField(value, workItemRoles, path);
}

function normalizeWorkspaceWorkItemSnapshot(
  value: unknown,
  path: string,
): WorkspaceWorkItemSnapshot {
  const raw = exactRecord(value, path, [
    "issueKey",
    "summary",
    "status",
    "content",
    "browserUrl",
    "fetchedAtUnixMs",
  ]);
  const issueKey = stringField(raw.issueKey, `${path}.issueKey`);
  if (!/^[A-Z0-9_]{1,32}-[0-9]{1,16}$/.test(issueKey)) {
    return invalidPayload(`${path}.issueKey`);
  }
  return {
    issueKey,
    summary: optionalStringField(raw.summary, `${path}.summary`),
    status: optionalStringField(raw.status, `${path}.status`),
    content: stringField(raw.content, `${path}.content`, true),
    browserUrl: optionalStringField(raw.browserUrl, `${path}.browserUrl`),
    fetchedAtUnixMs: integerField(
      raw.fetchedAtUnixMs,
      `${path}.fetchedAtUnixMs`,
    ),
  };
}

function normalizeWorkspaceWorkItemLink(
  value: unknown,
  path: string,
): WorkspaceWorkItemLink {
  const raw = exactRecord(value, path, [
    "linkId",
    "workspaceId",
    "provider",
    "role",
    "snapshot",
    "revision",
    "createdAtUnixMs",
    "updatedAtUnixMs",
  ]);
  if (raw.provider !== "jira") {
    return invalidPayload(`${path}.provider`);
  }
  return {
    linkId: requiredWorkspaceId(stringField(raw.linkId, `${path}.linkId`)),
    workspaceId: requiredWorkspaceId(
      stringField(raw.workspaceId, `${path}.workspaceId`),
    ),
    provider: "jira",
    role: normalizeWorkItemRole(raw.role, `${path}.role`),
    snapshot: normalizeWorkspaceWorkItemSnapshot(raw.snapshot, `${path}.snapshot`),
    revision: positiveInteger(raw.revision, `${path}.revision`),
    createdAtUnixMs: integerField(raw.createdAtUnixMs, `${path}.createdAtUnixMs`),
    updatedAtUnixMs: integerField(raw.updatedAtUnixMs, `${path}.updatedAtUnixMs`),
  };
}

function normalizeWorkspaceWorkItemLinkPreview(
  value: unknown,
): WorkspaceWorkItemLinkPreview {
  const raw = exactRecord(value, "workspaceWorkItemLinkPreview", [
    "schemaVersion",
    "workspaceId",
    "provider",
    "role",
    "snapshot",
    "previewDigest",
  ]);
  if (raw.schemaVersion !== 1 || raw.provider !== "jira") {
    return invalidPayload("workspaceWorkItemLinkPreview");
  }
  return {
    schemaVersion: 1,
    workspaceId: requiredWorkspaceId(
      stringField(raw.workspaceId, "workspaceWorkItemLinkPreview.workspaceId"),
    ),
    provider: "jira",
    role: normalizeWorkItemRole(raw.role, "workspaceWorkItemLinkPreview.role"),
    snapshot: normalizeWorkspaceWorkItemSnapshot(
      raw.snapshot,
      "workspaceWorkItemLinkPreview.snapshot",
    ),
    previewDigest: requiredSha256(
      raw.previewDigest,
      "workspaceWorkItemLinkPreview.previewDigest",
    ),
  };
}

function normalizeWorkspaceWorkItemLinkList(
  value: unknown,
): WorkspaceWorkItemLinkList {
  const raw = exactRecord(value, "workspaceWorkItemLinkList", [
    "schemaVersion",
    "workspaceId",
    "links",
  ]);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.links)) {
    return invalidPayload("workspaceWorkItemLinkList");
  }
  return {
    schemaVersion: 1,
    workspaceId: requiredWorkspaceId(
      stringField(raw.workspaceId, "workspaceWorkItemLinkList.workspaceId"),
    ),
    links: raw.links.map((link, index) =>
      normalizeWorkspaceWorkItemLink(
        link,
        `workspaceWorkItemLinkList.links[${index}]`,
      ),
    ),
  };
}

function normalizeJiraCreateProposal(value: unknown): JiraCreateProposal {
  const raw = exactRecord(value, "jiraCreateProposal", [
    "schemaVersion",
    "workspaceId",
    "summary",
    "description",
    "sourceDocumentSha256",
    "canExecute",
    "requiresExplicitApproval",
    "detail",
  ]);
  if (
    raw.schemaVersion !== 1 ||
    raw.canExecute !== false ||
    raw.requiresExplicitApproval !== true
  ) {
    return invalidPayload("jiraCreateProposal");
  }
  return {
    schemaVersion: 1,
    workspaceId: requiredWorkspaceId(
      stringField(raw.workspaceId, "jiraCreateProposal.workspaceId"),
    ),
    summary: stringField(raw.summary, "jiraCreateProposal.summary"),
    description: stringField(raw.description, "jiraCreateProposal.description"),
    sourceDocumentSha256:
      raw.sourceDocumentSha256 === undefined
        ? undefined
        : requiredSha256(
            raw.sourceDocumentSha256,
            "jiraCreateProposal.sourceDocumentSha256",
          ),
    canExecute: false,
    requiresExplicitApproval: true,
    detail: stringField(raw.detail, "jiraCreateProposal.detail"),
  };
}

function normalizeWorkspaceWorkItemOpenResult(
  value: unknown,
): WorkspaceWorkItemOpenResult {
  const raw = exactRecord(value, "workspaceWorkItemOpenResult", [
    "workspaceId",
    "issueKey",
    "accepted",
  ]);
  if (raw.accepted !== true) {
    return invalidPayload("workspaceWorkItemOpenResult.accepted");
  }
  const issueKey = stringField(
    raw.issueKey,
    "workspaceWorkItemOpenResult.issueKey",
  );
  if (!/^[A-Z0-9_]{1,32}-[0-9]{1,16}$/.test(issueKey)) {
    return invalidPayload("workspaceWorkItemOpenResult.issueKey");
  }
  return {
    workspaceId: requiredWorkspaceId(
      stringField(raw.workspaceId, "workspaceWorkItemOpenResult.workspaceId"),
    ),
    issueKey,
    accepted: true,
  };
}

const repositoryRecommendationSources: readonly RepositoryRecommendationSource[] =
  ["label", "checkoutLeaf", "localPath", "originRemote", "workspaceHistory"];

function normalizeRepositoryRecommendations(
  value: unknown,
  path: string,
): RepositoryRecommendation[] {
  if (!Array.isArray(value) || value.length > 256) {
    return invalidPayload(path);
  }
  const repositoryIds = new Set<string>();
  return value.map((recommendation, index) => {
    const itemPath = `${path}[${index}]`;
    const raw = exactRecord(recommendation, itemPath, [
      "repositoryId",
      "label",
      "confidence",
      "reason",
      "sources",
    ]);
    const repositoryId = stringField(
      raw.repositoryId,
      `${itemPath}.repositoryId`,
    );
    const confidence = integerField(
      raw.confidence,
      `${itemPath}.confidence`,
    );
    if (
      repositoryIds.has(repositoryId) ||
      confidence < 0 ||
      confidence > 100 ||
      !Array.isArray(raw.sources) ||
      raw.sources.length === 0
    ) {
      return invalidPayload(itemPath);
    }
    repositoryIds.add(repositoryId);
    return {
      repositoryId,
      label: stringField(raw.label, `${itemPath}.label`),
      confidence,
      reason: stringField(raw.reason, `${itemPath}.reason`),
      sources: raw.sources.map((source, sourceIndex) =>
        enumField(
          source,
          repositoryRecommendationSources,
          `${itemPath}.sources[${sourceIndex}]`,
        ),
      ),
    };
  });
}

function normalizeJiraActiveIssueList(value: unknown): JiraActiveIssueList {
  const raw = exactRecord(value, "jiraActiveIssueList", [
    "schemaVersion",
    "issues",
    "detail",
  ]);
  if (
    integerField(raw.schemaVersion, "jiraActiveIssueList.schemaVersion") !== 1 ||
    !Array.isArray(raw.issues) ||
    raw.issues.length > 20
  ) {
    return invalidPayload("jiraActiveIssueList");
  }
  const seen = new Set<string>();
  return {
    schemaVersion: 1,
    issues: raw.issues.map((value, index) => {
      const path = `jiraActiveIssueList.issues[${index}]`;
      const issue = exactRecord(value, path, [
        "issueKey",
        "summary",
        "status",
      ]);
      const issueKey = stringField(issue.issueKey, `${path}.issueKey`);
      if (!/^[A-Z][A-Z0-9_]{0,31}-[0-9]{1,16}$/.test(issueKey)) {
        return invalidPayload(`${path}.issueKey`);
      }
      if (seen.has(issueKey)) {
        return invalidPayload(`${path}.issueKey`);
      }
      seen.add(issueKey);
      return {
        issueKey,
        summary: stringField(issue.summary, `${path}.summary`),
        status: stringField(issue.status, `${path}.status`),
      };
    }),
    detail: stringField(raw.detail, "jiraActiveIssueList.detail"),
  };
}

function normalizeOpenProjectVerification(
  value: unknown,
): OpenProjectVerification {
  const raw = exactRecord(
    value,
    "openProjectVerification",
    ["connected", "instanceName", "apiVersion", "authenticatedUser"],
  );
  return {
    connected: booleanField(
      raw.connected,
      "openProjectVerification.connected",
    ),
    instanceName: stringField(
      raw.instanceName,
      "openProjectVerification.instanceName",
    ),
    apiVersion: stringField(
      raw.apiVersion,
      "openProjectVerification.apiVersion",
    ),
    authenticatedUser: stringField(
      raw.authenticatedUser,
      "openProjectVerification.authenticatedUser",
    ),
  };
}

function normalizeOpenProjectWorkPackageImport(
  value: unknown,
): OpenProjectWorkPackageImport {
  const raw = exactRecord(
    value,
    "openProjectWorkPackageImport",
    [
      "workPackageId",
      "displayId",
      "subject",
      "status",
      "project",
      "content",
      "suggestedRepositories",
      "repositoryRecommendations",
    ],
  );
  const workPackageId = integerField(
    raw.workPackageId,
    "openProjectWorkPackageImport.workPackageId",
  );
  if (!Number.isSafeInteger(workPackageId) || workPackageId <= 0) {
    return invalidPayload("openProjectWorkPackageImport.workPackageId");
  }
  return {
    workPackageId,
    displayId: stringField(
      raw.displayId,
      "openProjectWorkPackageImport.displayId",
    ),
    subject: stringField(
      raw.subject,
      "openProjectWorkPackageImport.subject",
    ),
    status: optionalNullableStringField(
      raw.status,
      "openProjectWorkPackageImport.status",
    ),
    project: optionalNullableStringField(
      raw.project,
      "openProjectWorkPackageImport.project",
    ),
    content: stringField(
      raw.content,
      "openProjectWorkPackageImport.content",
    ),
    suggestedRepositories: stringArray(
      raw.suggestedRepositories,
      "openProjectWorkPackageImport.suggestedRepositories",
    ),
    repositoryRecommendations: normalizeRepositoryRecommendations(
      raw.repositoryRecommendations,
      "openProjectWorkPackageImport.repositoryRecommendations",
    ),
  };
}

function validateCreateRequest(
  value: CreateWorkspaceRequest,
): CreateWorkspaceRequest {
  try {
    const raw = record(value, "createWorkspaceRequest");
    if (
      !Array.isArray(raw.repositories) ||
      raw.repositories.length === 0
    ) {
      throw new WorkspaceClientError(
        "A workspace requires at least one repository",
        { code: "invalid_request" },
      );
    }

    const repositories = raw.repositories.map((value, index) => {
      const repository = record(
        value,
        `createWorkspaceRequest.repositories[${index}]`,
      );
      const repositoryId = optionalStringField(
        repository.repositoryId,
        `createWorkspaceRequest.repositories[${index}].repositoryId`,
      );
      return {
        ...(repositoryId === undefined ? {} : { repositoryId }),
        label: stringField(
          repository.label,
          `createWorkspaceRequest.repositories[${index}].label`,
        ),
        baseRef: stringField(
          repository.baseRef,
          `createWorkspaceRequest.repositories[${index}].baseRef`,
        ),
      };
    });
    const runtime =
      raw.runtime === undefined
        ? undefined
        : normalizeRuntimePlanSelection(
            raw.runtime,
            "createWorkspaceRequest.runtime",
          );
    const planning =
      raw.planning === undefined
        ? undefined
        : normalizePlanningSelection(
            raw.planning,
            "createWorkspaceRequest.planning",
          );

    return {
      intent: normalizeIntent(
        raw.intent,
        "createWorkspaceRequest.intent",
      ),
      title: stringField(raw.title, "createWorkspaceRequest.title"),
      preferredProvider: normalizeProvider(
        raw.preferredProvider,
        "createWorkspaceRequest.preferredProvider",
      ),
      repositories,
      ...(runtime === undefined ? {} : { runtime }),
      ...(planning === undefined ? {} : { planning }),
    };
  } catch (error) {
    if (
      error instanceof WorkspaceClientError &&
      error.code === "invalid_response"
    ) {
      throw new WorkspaceClientError(
        error.message.replace(
          "WTS returned an invalid workspace payload",
          "Invalid workspace creation request",
        ),
        { code: "invalid_request", cause: error },
      );
    }
    throw error;
  }
}

function validateWorkspaceId(workspaceId: string): void {
  if (!workspaceId.trim()) {
    throw new WorkspaceClientError("A workspace ID is required", {
      code: "invalid_request",
    });
  }
}

function validateWorkspaceWorkflowRequest(
  workspaceId: string,
  state: WorkspaceWorkflowState,
  expectedRevision: number,
): void {
  validateWorkspaceId(workspaceId);
  if (
    (state !== "ready" &&
      state !== "active" &&
      state !== "review" &&
      state !== "parked") ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw new WorkspaceClientError("Choose a valid workspace state", {
      code: "invalid_request",
    });
  }
}

function validateBoardPlacementRequest(
  workspaceId: string,
  request: PlaceWorkspaceOnBoardRequest,
): void {
  validateWorkspaceWorkflowRequest(
    workspaceId,
    request.state,
    request.expectedRevision,
  );
  if (request.beforeWorkspaceId && request.afterWorkspaceId) {
    throw new WorkspaceClientError("Choose one workspace position", {
      code: "invalid_request",
    });
  }
  for (const neighborId of [
    request.beforeWorkspaceId,
    request.afterWorkspaceId,
  ]) {
    if (neighborId !== undefined && !neighborId.trim()) {
      throw new WorkspaceClientError("Choose a valid workspace position", {
        code: "invalid_request",
      });
    }
  }
}

function validatePlanningDocumentWrite(
  expectedSha256: string,
  contents: string,
): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new WorkspaceClientError("Reload the planning document and try again", {
      code: "invalid_request",
    });
  }
  if (new TextEncoder().encode(contents).byteLength > 256 * 1024) {
    throw new WorkspaceClientError(
      "The planning document exceeds the local size limit",
      { code: "invalid_request" },
    );
  }
}

function validateReviewThreadCreate(
  workspaceId: string,
  target: ReviewTarget,
  body: string,
  author: ReviewAuthor,
): void {
  validateWorkspaceId(workspaceId);
  const targetIsValid = target?.kind === "planningDocument"
    ? ["readme", "plan", "findings", "kanban", "programBacklog"].includes(
        target.documentId,
      ) &&
      /^sha256:[0-9a-f]{64}$/.test(target.documentSha256) &&
      (target.line === undefined ||
        (Number.isSafeInteger(target.line) &&
          target.line >= 1 &&
          target.line <= 1_000_000))
    : target?.kind === "verificationCheck"
      ? Number.isSafeInteger(target.planRevision) &&
        target.planRevision >= 1 &&
        Number.isSafeInteger(target.completedAtUnixMs) &&
        target.completedAtUnixMs >= 0 &&
        /^[A-Za-z0-9._-]{1,128}$/.test(target.checkId)
      : target?.kind === "codeChange"
        ? target.repositoryId.trim() === target.repositoryId &&
          target.repositoryId.length > 0 &&
          target.repositoryId.length <= 512 &&
          /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(target.baseCommitOid) &&
          /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(target.headCommitOid) &&
          /^sha256:[0-9a-f]{64}$/.test(target.patchSha256) &&
          validReviewFilePath(target.filePath) &&
          (target.side === "additions" || target.side === "deletions") &&
          Number.isSafeInteger(target.line) &&
          target.line >= 1 &&
          target.line <= 1_000_000
      : false;
  if (
    !targetIsValid ||
    (author !== "user" && author !== "agent") ||
    !body.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)
  ) {
    throw new WorkspaceClientError(
      "Choose a valid document line and enter a review comment",
      { code: "invalid_request" },
    );
  }
  if (new TextEncoder().encode(body).byteLength > 16 * 1024) {
    throw new WorkspaceClientError(
      "The review comment exceeds the local size limit",
      { code: "invalid_request" },
    );
  }
}

function validReviewFilePath(value: string): boolean {
  return value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    !value.includes("\0") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function reviewTargetRequest(target: ReviewTarget): ReviewTarget {
  if (target.kind === "planningDocument") {
    return {
      kind: "planningDocument",
      documentId: target.documentId,
      documentSha256: target.documentSha256,
      ...(target.line === undefined ? {} : { line: target.line }),
    };
  }
  if (target.kind === "verificationCheck") {
    return {
      kind: "verificationCheck",
      planRevision: target.planRevision,
      completedAtUnixMs: target.completedAtUnixMs,
      checkId: target.checkId,
    };
  }
  return {
    kind: "codeChange",
    repositoryId: target.repositoryId,
    baseCommitOid: target.baseCommitOid,
    headCommitOid: target.headCommitOid,
    patchSha256: target.patchSha256,
    filePath: target.filePath,
    side: target.side,
    line: target.line,
  };
}

function validateReviewThreadResolve(
  workspaceId: string,
  threadId: string,
  expectedRevision: number,
): void {
  validateWorkspaceId(workspaceId);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      threadId,
    ) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 1
  ) {
    throw new WorkspaceClientError("Reload the review thread and try again", {
      code: "invalid_request",
    });
  }
}

function validateWorkspaceJiraLinkInput(
  issueKey: string,
  role: WorkspaceWorkItemRole,
): { issueKey: string; role: WorkspaceWorkItemRole } {
  const key = issueKey.trim().toUpperCase();
  if (
    !/^[A-Z0-9_]{1,32}-[0-9]{1,16}$/.test(key) ||
    !workItemRoles.includes(role)
  ) {
    throw new WorkspaceClientError(
      "Enter a Jira issue key and choose how it relates to this workspace",
      { code: "invalid_request" },
    );
  }
  return { issueKey: key, role };
}

function validateRuntimeAnalysisRequest(
  value: RuntimeAnalysisRequest,
): RuntimeAnalysisRequest {
  try {
    const raw = exactRecord(value, "runtimeAnalysisRequest", ["repositories"]);
    if (!Array.isArray(raw.repositories) || raw.repositories.length === 0) {
      throw new WorkspaceClientError(
        "Runtime analysis requires at least one repository",
        { code: "invalid_request" },
      );
    }
    const repositories = raw.repositories.map((repository, index) => {
      const path = `runtimeAnalysisRequest.repositories[${index}]`;
      const item = exactRecord(repository, path, [
        "repositoryId",
        "label",
        "baseRef",
      ]);
      const repositoryId = stringField(
        item.repositoryId,
        `${path}.repositoryId`,
      );
      return {
        repositoryId,
        label: stringField(item.label, `${path}.label`),
        baseRef: stringField(item.baseRef, `${path}.baseRef`),
      };
    });
    return { repositories };
  } catch (error) {
    if (
      error instanceof WorkspaceClientError &&
      error.code === "invalid_response"
    ) {
      throw new WorkspaceClientError(
        error.message.replace(
          "WTS returned an invalid workspace payload",
          "Invalid runtime analysis request",
        ),
        { code: "invalid_request", cause: error },
      );
    }
    throw error;
  }
}

function validateCodeWorkspaceFileImportRequest(
  value: CodeWorkspaceFileImportRequest,
): CodeWorkspaceFileImportRequest {
  const fileName = value.fileName.trim();
  if (!fileName.toLowerCase().endsWith(".code-workspace")) {
    throw new WorkspaceClientError(
      "Choose a file ending in .code-workspace",
      { code: "invalid_request" },
    );
  }
  if (typeof value.contents !== "string" || value.contents.length === 0) {
    throw new WorkspaceClientError(
      "The VS Code workspace file is empty",
      { code: "invalid_request" },
    );
  }
  if (
    new TextEncoder().encode(value.contents).byteLength >
    CODE_WORKSPACE_FILE_MAX_BYTES
  ) {
    throw new WorkspaceClientError(
      "The VS Code workspace file must be 48 KiB or smaller",
      { code: "invalid_request" },
    );
  }
  return { fileName, contents: value.contents };
}

function validateTestJourneyRequest(
  value: RunWorkspaceTestJourneyRequest,
): RunWorkspaceTestJourneyRequest {
  const journeyId = value.journeyId.trim();
  const baseUrl = value.baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new WorkspaceClientError(
      "A valid loopback journey URL is required",
      { code: "invalid_request", cause: error },
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopback =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1";
  if (
    !journeyId ||
    !loopback ||
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new WorkspaceClientError(
      "A journey ID and loopback origin are required",
      { code: "invalid_request" },
    );
  }

  return { journeyId, baseUrl: parsed.origin };
}

function isTauriRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & {
    isTauri?: boolean;
    __TAURI_INTERNALS__?: unknown;
  };
  return runtime.isTauri === true || "__TAURI_INTERNALS__" in runtime;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function errorDetails(value: unknown): {
  code?: string;
  message?: string;
  retryable?: boolean;
} {
  if (typeof value === "string") {
    return { message: value };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const raw = value as UnknownRecord;
  const nested =
    raw.error &&
    typeof raw.error === "object" &&
    !Array.isArray(raw.error)
      ? (raw.error as UnknownRecord)
      : raw;
  const message =
    typeof nested.message === "string"
      ? nested.message
      : typeof raw.error === "string"
        ? raw.error
        : undefined;
  return {
    code: typeof nested.code === "string" ? nested.code : undefined,
    message,
    retryable:
      typeof nested.retryable === "boolean"
        ? nested.retryable
        : undefined,
  };
}

function wrapTransportError(error: unknown): WorkspaceClientError {
  if (error instanceof WorkspaceClientError) {
    return error;
  }
  const details = errorDetails(error);
  const hasStructuredServiceError = Boolean(details.code);
  return new WorkspaceClientError(
    hasStructuredServiceError && details.message
      ? details.message
      : "Cannot reach the local WTS host. Open this UI through `npm run desktop:dev`, or start `cargo run -p wts-server` and open its loopback URL; Vite alone cannot import workspaces.",
    {
      code: details.code ?? "transport_unavailable",
      retryable: details.retryable ?? true,
      cause: error,
    },
  );
}

function logHttpTransportFailure(
  stage: "bootstrap" | "request",
  method: string,
  path: string,
  error: WorkspaceClientError,
) {
  if (!import.meta.env.DEV || import.meta.env.MODE === "test") return;
  console.debug("[WTS] local HTTP transport failed", {
    schemaVersion: 1,
    event: "httpTransportFailed",
    stage,
    method,
    path,
    error: {
      code: error.code,
      retryable: error.retryable,
    },
  });
}

class HttpWorkspaceClient implements WorkspaceClient {
  private sessionTokenPromise?: Promise<string>;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchOverride?: typeof fetch,
  ) {
    this.baseUrl = trimTrailingSlash(baseUrl);
  }

  async getGithubReviewInbox(): Promise<GithubReviewInbox> {
    return normalizeGithubReviewInbox(
      await this.request(GITHUB_REVIEW_INBOX_HTTP_PATH),
    );
  }

  async openGithubReview(repositoryId: string, number: number): Promise<OpenGithubReviewResult> {
    validateGithubReviewIdentity(repositoryId, number);
    return normalizeOpenGithubReviewResult(
      await this.request(openGithubReviewHttpPath(repositoryId, number), {
        method: "POST",
      }),
    );
  }

  async getGitlabReviewInbox(): Promise<GitlabReviewInbox> {
    return normalizeGitlabReviewInbox(
      await this.request(GITLAB_REVIEW_INBOX_HTTP_PATH),
    );
  }

  async getGitlabReviewPatch(
    repositoryId: string,
    iid: number,
    commitOid?: string,
    refresh?: boolean,
  ): Promise<GitlabReviewPatch> {
    validateGitlabMergeRequestIdentity(repositoryId, iid);
    const params = new URLSearchParams();
    if (commitOid) params.set("commitOid", commitOid);
    if (refresh) params.set("refresh", "true");
    const query = params.size ? `?${params.toString()}` : "";
    return normalizeGitlabReviewPatch(await this.request(`/api/v1/reviews/gitlab/${encodeURIComponent(repositoryId)}/${iid}/patch${query}`));
  }

  async publishGitlabReviewComment(repositoryId: string, iid: number, request: GitlabReviewCommentRequest): Promise<PublishGitlabReviewCommentResult> {
    validateGitlabMergeRequestIdentity(repositoryId, iid);
    return normalizePublishGitlabReviewCommentResult(await this.request(`/api/v1/reviews/gitlab/${encodeURIComponent(repositoryId)}/${iid}/comments`, { method: "POST", body: JSON.stringify(request) }));
  }

  async prepareGitlabReviewRepository(
    repositoryId: string,
    iid: number,
  ): Promise<CloneRepositoryResult> {
    validateGitlabMergeRequestIdentity(repositoryId, iid);
    return normalizeCloneRepositoryResult(
      await this.request(
        prepareGitlabReviewRepositoryHttpPath(repositoryId, iid),
        { method: "POST" },
      ),
    );
  }

  async listWorkspaces(): Promise<WorkspaceList> {
    return normalizeWorkspaceList(
      await this.request("/api/v1/workspaces"),
    );
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceView> {
    if (!workspaceId.trim()) {
      throw new WorkspaceClientError("A workspace ID is required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspace(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
      ),
    );
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceView> {
    const normalizedTitle = title.trim();
    if (!workspaceId.trim() || !normalizedTitle) {
      throw new WorkspaceClientError("A workspace ID and name are required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspace(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: normalizedTitle }),
        },
      ),
    );
  }

  async transitionWorkspaceWorkflow(
    workspaceId: string,
    state: WorkspaceWorkflowState,
    expectedRevision: number,
  ): Promise<WorkspaceWorkflowSummary> {
    validateWorkspaceWorkflowRequest(workspaceId, state, expectedRevision);
    return normalizeWorkspaceWorkflow(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/workflow`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state, expectedRevision }),
        },
      ),
      "workflow",
    );
  }

  async placeWorkspaceOnBoard(
    workspaceId: string,
    request: PlaceWorkspaceOnBoardRequest,
  ): Promise<WorkspaceWorkflowSummary> {
    validateBoardPlacementRequest(workspaceId, request);
    return normalizeWorkspaceWorkflow(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/board-placement`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      ),
      "workflow",
    );
  }

  async followWorkspaceAgent(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkflowSummary> {
    validateWorkspaceWorkflowRequest(workspaceId, "ready", expectedRevision);
    return normalizeWorkspaceWorkflow(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/board-placement/follow-agent`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision }),
        },
      ),
      "workflow",
    );
  }

  async listWorkspacePlanningDocuments(
    workspaceId: string,
  ): Promise<WorkspacePlanningDocumentList> {
    validateWorkspaceId(workspaceId);
    return normalizePlanningDocumentList(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/planning/documents`,
      ),
    );
  }

  async readWorkspacePlanningDocument(
    workspaceId: string,
    documentId: WorkspacePlanningDocumentId,
  ): Promise<WorkspacePlanningDocument> {
    validateWorkspaceId(workspaceId);
    return normalizePlanningDocument(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/planning/documents/${encodeURIComponent(documentId)}`,
      ),
    );
  }

  async updateWorkspacePlanningDocument(
    workspaceId: string,
    documentId: WorkspacePlanningDocumentId,
    expectedSha256: string,
    contents: string,
  ): Promise<WorkspacePlanningDocument> {
    validateWorkspaceId(workspaceId);
    validatePlanningDocumentWrite(expectedSha256, contents);
    return normalizePlanningDocument(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/planning/documents/${encodeURIComponent(documentId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedSha256, contents }),
        },
      ),
    );
  }

  async listWorkspaceReviewThreads(
    workspaceId: string,
  ): Promise<WorkspaceReviewThreadList> {
    validateWorkspaceId(workspaceId);
    return normalizeWorkspaceReviewThreadList(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/review/threads`,
      ),
    );
  }

  async createWorkspaceReviewThread(
    workspaceId: string,
    target: ReviewTarget,
    body: string,
    author: ReviewAuthor = "user",
  ): Promise<WorkspaceReviewThread> {
    validateReviewThreadCreate(workspaceId, target, body, author);
    const requestTarget = reviewTargetRequest(target);
    return normalizeWorkspaceReviewThread(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/review/threads`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: requestTarget, author, body }),
        },
      ),
    );
  }

  async resolveWorkspaceReviewThread(
    workspaceId: string,
    threadId: string,
    expectedRevision: number,
  ): Promise<WorkspaceReviewThread> {
    validateReviewThreadResolve(workspaceId, threadId, expectedRevision);
    return normalizeWorkspaceReviewThread(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/review/threads/${encodeURIComponent(threadId)}/resolve`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision }),
        },
      ),
    );
  }

  async createWorkspace(
    request: CreateWorkspaceRequest,
    idempotencyKey: string,
  ): Promise<CreateWorkspaceResult> {
    if (!idempotencyKey.trim()) {
      throw new WorkspaceClientError(
        "An idempotency key is required to create a workspace",
        { code: "invalid_request" },
      );
    }
    const validated = validateCreateRequest(request);
    return normalizeCreateResult(
      await this.request("/api/v1/workspaces", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(validated),
      }),
    );
  }

  async getSetupSnapshot(): Promise<SetupSnapshot> {
    return normalizeSetupSnapshot(await this.request("/api/v1/setup"));
  }

  async listAgentSessions(workspaceId?: string): Promise<AgentSessionList> {
    const workspace =
      workspaceId === undefined ? undefined : requiredWorkspaceId(workspaceId);
    const query =
      workspace === undefined
        ? ""
        : `?workspaceId=${encodeURIComponent(workspace)}`;
    const result = normalizeAgentSessionList(
      await this.request(`/api/v1/agent-sessions${query}`),
    );
    if (
      workspace !== undefined &&
      result.sessions.some((session) => session.workspaceId !== workspace)
    ) {
      return invalidPayload("agentSessionList.sessions.workspaceId");
    }
    return result;
  }

  async previewWorkspaceJiraLink(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
  ): Promise<WorkspaceWorkItemLinkPreview> {
    const workspace = requiredWorkspaceId(workspaceId);
    const request = validateWorkspaceJiraLinkInput(issueKey, role);
    const result = normalizeWorkspaceWorkItemLinkPreview(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/work-items/jira/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      ),
    );
    if (result.workspaceId !== workspace) {
      return invalidPayload("workspaceWorkItemLinkPreview.workspaceId");
    }
    return result;
  }

  async confirmWorkspaceJiraLink(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
    expectedPreviewDigest: string,
    idempotencyKey: string,
  ): Promise<ConfirmWorkspaceWorkItemLinkResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const request = validateWorkspaceJiraLinkInput(issueKey, role);
    requiredSha256(expectedPreviewDigest, "expectedPreviewDigest");
    const idempotency = requiredWorkspaceId(idempotencyKey);
    const raw = exactRecord(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/work-items/jira/confirm`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...request,
            expectedPreviewDigest,
            idempotencyKey: idempotency,
          }),
        },
      ),
      "confirmWorkspaceWorkItemLinkResult",
      ["link", "replayed"],
    );
    const result = {
      link: normalizeWorkspaceWorkItemLink(
        raw.link,
        "confirmWorkspaceWorkItemLinkResult.link",
      ),
      replayed: booleanField(
        raw.replayed,
        "confirmWorkspaceWorkItemLinkResult.replayed",
      ),
    };
    if (result.link.workspaceId !== workspace) {
      return invalidPayload("confirmWorkspaceWorkItemLinkResult.link.workspaceId");
    }
    return result;
  }

  async openWorkspaceJiraPreview(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
    expectedPreviewDigest: string,
  ): Promise<WorkspaceWorkItemOpenResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const request = validateWorkspaceJiraLinkInput(issueKey, role);
    requiredSha256(expectedPreviewDigest, "expectedPreviewDigest");
    const result = normalizeWorkspaceWorkItemOpenResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/work-items/jira/open-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...request, expectedPreviewDigest }),
        },
      ),
    );
    if (result.workspaceId !== workspace || result.issueKey !== request.issueKey) {
      return invalidPayload("workspaceWorkItemOpenResult.identity");
    }
    return result;
  }

  async listWorkspaceWorkItemLinks(
    workspaceId: string,
  ): Promise<WorkspaceWorkItemLinkList> {
    const workspace = requiredWorkspaceId(workspaceId);
    const result = normalizeWorkspaceWorkItemLinkList(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/work-items`,
      ),
    );
    if (
      result.workspaceId !== workspace ||
      result.links.some((link) => link.workspaceId !== workspace)
    ) {
      return invalidPayload("workspaceWorkItemLinkList.workspaceId");
    }
    return result;
  }

  async unlinkWorkspaceWorkItem(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkItemUnlinkResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const link = requiredWorkspaceId(linkId);
    positiveInteger(expectedRevision, "expectedRevision");
    const raw = exactRecord(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/work-items/${encodeURIComponent(link)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision }),
        },
      ),
      "workspaceWorkItemUnlinkResult",
      ["workspaceId", "linkId", "removedRevision"],
    );
    const result = {
      workspaceId: requiredWorkspaceId(
        stringField(raw.workspaceId, "workspaceWorkItemUnlinkResult.workspaceId"),
      ),
      linkId: requiredWorkspaceId(
        stringField(raw.linkId, "workspaceWorkItemUnlinkResult.linkId"),
      ),
      removedRevision: positiveInteger(
        raw.removedRevision,
        "workspaceWorkItemUnlinkResult.removedRevision",
      ),
    };
    if (result.workspaceId !== workspace || result.linkId !== link) {
      return invalidPayload("workspaceWorkItemUnlinkResult.identity");
    }
    return result;
  }

  async openWorkspaceWorkItem(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkItemOpenResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const link = requiredWorkspaceId(linkId);
    positiveInteger(expectedRevision, "expectedRevision");
    const result = normalizeWorkspaceWorkItemOpenResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/work-items/${encodeURIComponent(link)}/open`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ expectedRevision }),
        },
      ),
    );
    if (result.workspaceId !== workspace) {
      return invalidPayload("workspaceWorkItemOpenResult.workspaceId");
    }
    return result;
  }

  async proposeWorkspaceJiraIssue(
    workspaceId: string,
  ): Promise<JiraCreateProposal> {
    const workspace = requiredWorkspaceId(workspaceId);
    const result = normalizeJiraCreateProposal(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/work-items/jira/create-proposal`,
      ),
    );
    if (result.workspaceId !== workspace) {
      return invalidPayload("jiraCreateProposal.workspaceId");
    }
    return result;
  }

  async getAgentSessionDetail(sessionId: string): Promise<AgentSessionDetail> {
    const session = requiredWorkspaceId(sessionId);
    return normalizeAgentSessionDetail(
      await this.request(
        `/api/v1/agent-sessions/${encodeURIComponent(session)}`,
      ),
    );
  }

  async startAgentSessionPrototype(workspaceId: string): Promise<AgentSession> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeAgentSession(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/agent-sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "codex",
            terminal: "terminal",
            category: "implementation",
          }),
        },
      ),
      "agentSession",
    );
  }

  async heartbeatAgentSession(sessionId: string): Promise<AgentSession> {
    const session = requiredWorkspaceId(sessionId);
    return normalizeAgentSession(
      await this.request(
        `/api/v1/agent-sessions/${encodeURIComponent(session)}/heartbeat`,
        { method: "POST" },
      ),
      "agentSession",
    );
  }

  async completeAgentSession(sessionId: string): Promise<AgentSession> {
    const session = requiredWorkspaceId(sessionId);
    return normalizeAgentSession(
      await this.request(
        `/api/v1/agent-sessions/${encodeURIComponent(session)}/complete`,
        { method: "POST" },
      ),
      "agentSession",
    );
  }

  async failAgentSession(sessionId: string): Promise<AgentSession> {
    const session = requiredWorkspaceId(sessionId);
    return normalizeAgentSession(
      await this.request(
        `/api/v1/agent-sessions/${encodeURIComponent(session)}/fail`,
        { method: "POST" },
      ),
      "agentSession",
    );
  }

  async launchAgentSession(
    workspaceId: string,
    request: LaunchAgentSessionRequest,
  ): Promise<AgentSession> {
    const workspace = requiredWorkspaceId(workspaceId);
    const validated = validateLaunchAgentSessionRequest(request);
    return normalizeAgentSession(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/agents/${encodeURIComponent(validated.provider)}/sessions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: validated.prompt,
            category: validated.category,
          }),
        },
      ),
      "agentSession",
    );
  }

  async stopAgentSession(sessionId: string): Promise<AgentSession> {
    const session = requiredWorkspaceId(sessionId);
    return normalizeAgentSession(
      await this.request(
        `/api/v1/agent-sessions/${encodeURIComponent(session)}/stop`,
        { method: "POST" },
      ),
      "agentSession",
    );
  }

  async getActivityWatchStatus(
    endpoint?: string,
  ): Promise<ActivityWatchStatus> {
    const query =
      endpoint === undefined
        ? ""
        : `?endpoint=${encodeURIComponent(endpoint)}`;
    return normalizeActivityWatchStatus(
      await this.request(
        `/api/v1/integrations/activity-watch/status${query}`,
      ),
    );
  }

  async getActivityWatchDailyReview(
    startedAtUnixMs: number,
    endedAtUnixMs: number,
    endpoint?: string,
  ): Promise<ActivityWatchDailyReview> {
    const start = integerField(startedAtUnixMs, "startedAtUnixMs");
    const end = integerField(endedAtUnixMs, "endedAtUnixMs");
    if (end <= start) return invalidPayload("endedAtUnixMs");
    const query = new URLSearchParams({
      startedAtUnixMs: String(start),
      endedAtUnixMs: String(end),
    });
    if (endpoint !== undefined) query.set("endpoint", endpoint);
    return normalizeActivityWatchDailyReview(
      await this.request(
        `/api/v1/integrations/activity-watch/daily-review?${query.toString()}`,
      ),
    );
  }

  async listRepositories(): Promise<RepositoryCatalog> {
    return normalizeRepositoryCatalog(
      await this.request("/api/v1/repositories"),
    );
  }

  async cloneRepository(
    request: CloneRepositoryRequest,
  ): Promise<CloneRepositoryResult> {
    const validated = validateCloneRepositoryRequest(request);
    return normalizeCloneRepositoryResult(
      await this.request("/api/v1/repositories/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      }),
    );
  }

  async refreshRepositoryBranches(
    repositoryId: string,
  ): Promise<RepositorySummary> {
    const repository = repositoryId.trim();
    if (!repository) {
      throw new WorkspaceClientError("A repository ID is required", {
        code: "invalid_request",
      });
    }
    const payload = record(
      await this.request(
        `/api/v1/repositories/${encodeURIComponent(repository)}/branches/refresh`,
        { method: "POST" },
      ),
      "repositoryBranchRefresh",
    );
    return normalizeRepositorySummary(
      payload.repository,
      "repositoryBranchRefresh.repository",
    );
  }

  async importCodeWorkspaceFile(
    request: CodeWorkspaceFileImportRequest,
  ): Promise<CodeWorkspaceFileImportResult> {
    const validated = validateCodeWorkspaceFileImportRequest(request);
    return normalizeCodeWorkspaceFileImport(
      await this.request("/api/v1/code-workspaces/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      }),
    );
  }

  async analyzeWorkspaceRuntime(
    request: RuntimeAnalysisRequest,
  ): Promise<RuntimeAnalysisResult> {
    const validated = validateRuntimeAnalysisRequest(request);
    return normalizeRuntimeAnalysisResult(
      await this.request("/api/v1/workspace-plans/runtime-analysis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      }),
    );
  }

  async preflightWorkspace(
    workspaceId: string,
  ): Promise<WorkspacePreflight> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizePreflight(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/preflight`,
      ),
    );
  }

  async getWorkspaceMaterialization(
    workspaceId: string,
  ): Promise<WorkspaceMaterialization | null> {
    const workspace = requiredWorkspaceId(workspaceId);
    const payload = await this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspace)}/materialization`,
    );
    return payload === null
      ? null
      : normalizeMaterialization(payload, "workspaceMaterialization");
  }

  async getWorkspaceRepositoryDiff(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryDiff> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = repositoryId.trim();
    if (!repository || repository.length > 512) {
      throw new WorkspaceClientError("A repository ID is required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspaceRepositoryDiff(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/repositories/${encodeURIComponent(repository)}/diff`,
      ),
    );
  }

  async getWorkspaceRepositoryFileReview(
    workspaceId: string,
    repositoryId: string,
    filePath: string,
    expectedPatchSha256: string,
  ): Promise<WorkspaceRepositoryFileReview> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredRepositoryId(repositoryId);
    const path = requiredRepositoryFilePath(filePath);
    const expectedPatch = normalizeSha256(
      expectedPatchSha256,
      "expectedPatchSha256",
    );
    return normalizeWorkspaceRepositoryFileReview(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/repositories/${encodeURIComponent(repository)}/file?path=${encodeURIComponent(path)}&expectedPatchSha256=${encodeURIComponent(expectedPatch)}`,
      ),
    );
  }

  async getWorkspaceRepositoryReviewGraph(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryReviewGraph | null> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredRepositoryId(repositoryId);
    const payload = await this.request(
      `/api/v1/workspaces/${encodeURIComponent(workspace)}/repositories/${encodeURIComponent(repository)}/review-graph`,
    );
    return payload === null
      ? null
      : normalizeWorkspaceRepositoryReviewGraph(
          payload,
          "workspaceRepositoryReviewGraph",
        );
  }

  async syncWorkspaceRepository(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositorySyncResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = repositoryId.trim();
    if (!repository || repository.length > 512) {
      throw new WorkspaceClientError("A repository ID is required", {
        code: "invalid_request",
      });
    }
    const result = normalizeWorkspaceRepositorySyncResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/repositories/${encodeURIComponent(repository)}/sync`,
        { method: "POST" },
      ),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== repository) {
      return invalidPayload("workspaceRepositorySyncResult.identity");
    }
    return result;
  }

  async preflightWorkspaceRepositoryAlignment(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryAlignmentPreflight> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredRepositoryId(repositoryId);
    const result = normalizeWorkspaceRepositoryAlignmentPreflight(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/repositories/${encodeURIComponent(repository)}/alignment-preflight`,
        { method: "POST" },
      ),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== repository) {
      return invalidPayload("workspaceRepositoryAlignmentPreflight.identity");
    }
    return result;
  }

  async alignWorkspaceRepository(
    workspaceId: string,
    repositoryId: string,
    effectDigest: string,
  ): Promise<WorkspaceRepositoryAlignmentResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredRepositoryId(repositoryId);
    if (!effectDigest.trim()) {
      throw new WorkspaceClientError("An alignment effect digest is required", {
        code: "invalid_request",
      });
    }
    const result = normalizeWorkspaceRepositoryAlignmentResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/repositories/${encodeURIComponent(repository)}/align`,
        {
          method: "POST",
          body: JSON.stringify({ effectDigest: effectDigest.trim() }),
        },
      ),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== repository) {
      return invalidPayload("workspaceRepositoryAlignmentResult.identity");
    }
    return result;
  }

  async materializeWorkspace(
    workspaceId: string,
    effectDigest: string,
    idempotencyKey: string,
  ): Promise<MaterializeWorkspaceResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    if (!effectDigest.trim() || !idempotencyKey.trim()) {
      throw new WorkspaceClientError(
        "An effect digest and idempotency key are required",
        { code: "invalid_request" },
      );
    }
    return normalizeMaterializeResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/materialize`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ effectDigest: effectDigest.trim() }),
        },
      ),
    );
  }

  async openWorkspaceInVscode(
    workspaceId: string,
  ): Promise<OpenWorkspaceResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeOpenResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/open/vscode`,
        { method: "POST" },
      ),
    );
  }

  async openRepositoryBase(
    repositoryId: string,
    baseRef: string,
  ): Promise<OpenRepositoryBaseResult> {
    const selection = requiredRepositoryBaseSelection(
      repositoryId,
      baseRef,
    );
    const result = normalizeOpenRepositoryBaseResult(
      await this.request(
        `/api/v1/repositories/${encodeURIComponent(selection.repositoryId)}/open/base`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ baseRef: selection.baseRef }),
        },
      ),
    );
    if (
      result.repositoryId !== selection.repositoryId ||
      result.baseRef !== selection.baseRef
    ) {
      return invalidPayload("openRepositoryBaseResult.identity");
    }
    return result;
  }

  async getGitlabMergeRequests(
    workspaceId: string,
  ): Promise<GitlabMergeRequestInbox> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeGitlabMergeRequestInbox(
      await this.request(gitlabMergeRequestInboxHttpPath(workspace)),
    );
  }

  async openGitlabMergeRequest(
    repositoryId: string,
    iid: number,
  ): Promise<OpenGitlabMergeRequestResult> {
    const repository = requiredChangeRequestRepositoryId(repositoryId);
    validateGitlabMergeRequestIdentity(repository, iid);
    const result = normalizeOpenGitlabMergeRequestResult(
      await this.request(
        openGitlabMergeRequestHttpPath(repository, iid),
        { method: "POST" },
      ),
    );
    if (
      result.repositoryId !== repository ||
      result.iid !== iid
    ) {
      return invalidPayload("openGitlabMergeRequestResult.identity");
    }
    return result;
  }

  async getGitlabIntegrationStatus(
    workspaceId: string,
  ): Promise<GitlabIntegrationStatus> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeGitlabIntegrationStatus(
      await this.request(gitlabIntegrationStatusHttpPath(workspace)),
    );
  }

  async getUpdateStatus(): Promise<AppUpdateStatus> {
    return {
      schemaVersion: 1,
      state: "disabled",
      currentVersion: "browser",
      detail: "App updates are available in the WTS desktop app.",
      diagnosticCode: "notConfigured",
    };
  }

  async checkForUpdate(): Promise<AppUpdateStatus> {
    return this.getUpdateStatus();
  }

  async downloadAndInstallUpdate(): Promise<AppUpdateStatus> {
    throw new WorkspaceClientError(
      "App updates are available in the WTS desktop app",
      { code: "unsupported" },
    );
  }

  async relaunchUpdatedApp(): Promise<RelaunchUpdatedAppResult> {
    throw new WorkspaceClientError(
      "App relaunch is available in the WTS desktop app",
      { code: "unsupported" },
    );
  }

  async prepareWorkspaceChangeRequest(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceChangeRequestDraft> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredChangeRequestRepositoryId(repositoryId);
    const result = normalizeWorkspaceChangeRequestDraft(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/change-requests/prepare`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repositoryId: repository }),
        },
      ),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== repository) {
      return invalidPayload("workspaceChangeRequestDraft.identity");
    }
    return result;
  }

  async openWorkspaceChangeRequestDraft(
    workspaceId: string,
    repositoryId: string,
    effectDigest: string,
    title: string,
    body: string,
  ): Promise<OpenWorkspaceChangeRequestResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const request = requiredChangeRequestDraft(repositoryId, effectDigest, title, body);
    const result = normalizeOpenWorkspaceChangeRequestResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/change-requests/open`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        },
      ),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== request.repositoryId) {
      return invalidPayload("openWorkspaceChangeRequestResult.identity");
    }
    return result;
  }

  async openWorkspaceCli(
    workspaceId: string,
    provider: AgentProvider,
    terminal: TerminalProvider = "terminal",
  ): Promise<WorkspaceCliLaunchResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    if (!agentProviders.includes(provider)) {
      throw new WorkspaceClientError("An agent provider is required", {
        code: "invalid_request",
      });
    }
    if (!terminalProviders.includes(terminal)) {
      throw new WorkspaceClientError("A terminal is required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspaceCliLaunchResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/open/cli/${encodeURIComponent(provider)}?terminal=${encodeURIComponent(terminal)}`,
        { method: "POST" },
      ),
    );
  }

  async writeWorkspaceAgentBrief(
    workspaceId: string,
    taskMarkdown: string,
  ): Promise<WorkspaceAgentBriefResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const task = taskMarkdown.trim();
    if (!task) {
      throw new WorkspaceClientError("An agent brief is required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspaceAgentBriefResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/agent-brief`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskMarkdown: task }),
        },
      ),
    );
  }

  async indexWorkspaceGraph(
    workspaceId: string,
  ): Promise<GraphIndexResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeGraphIndexResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/graph/index`,
        { method: "POST" },
      ),
    );
  }

  async reindexWorkspaceGraph(
    workspaceId: string,
  ): Promise<GraphIndexResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeGraphIndexResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/graph/reindex`,
        { method: "POST" },
      ),
    );
  }

  async preflightWorkspaceRemoval(
    workspaceId: string,
  ): Promise<WorkspaceRemovalPreflight> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeWorkspaceRemovalPreflight(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/removal-preflight`,
      ),
    );
  }

  async removeWorkspace(
    workspaceId: string,
    effectDigest: string,
    idempotencyKey: string,
    deleteProtectedPaths = false,
  ): Promise<RemoveWorkspaceResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    if (!effectDigest.trim() || !idempotencyKey.trim()) {
      throw new WorkspaceClientError(
        "An effect digest and idempotency key are required",
        { code: "invalid_request" },
      );
    }
    return normalizeRemoveWorkspaceResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/remove`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({
            effectDigest: effectDigest.trim(),
            deleteProtectedPaths,
          }),
        },
      ),
    );
  }

  async runWorkspaceAgent(
    workspaceId: string,
    provider: AgentProvider,
    prompt: string,
  ): Promise<AgentRunResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    if (!agentProviders.includes(provider) || !prompt.trim()) {
      throw new WorkspaceClientError(
        "An agent provider and prompt are required",
        { code: "invalid_request" },
      );
    }
    return normalizeAgentRunResult(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/agents/${encodeURIComponent(provider)}/run`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: prompt.trim() }),
        },
      ),
    );
  }

  async getWorkspaceEvidence(
    workspaceId: string,
  ): Promise<WorkspaceEvidence | null> {
    const workspace = requiredWorkspaceId(workspaceId);
    try {
      const payload = await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/evidence`,
      );
      return payload === null ? null : normalizeWorkspaceEvidence(payload);
    } catch (error) {
      if (error instanceof WorkspaceClientError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async runWorkspaceVerification(
    workspaceId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeWorkspaceEvidence(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/verification/run`,
        { method: "POST" },
      ),
    );
  }

  async runWorkspaceVerificationCheck(
    workspaceId: string,
    checkId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    const check = requiredVerificationCheckId(checkId);
    return normalizeWorkspaceEvidence(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/verification/checks/${encodeURIComponent(check)}/run`,
        { method: "POST" },
      ),
    );
  }

  async rerunFailedWorkspaceVerification(
    workspaceId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeWorkspaceEvidence(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/verification/failed/run`,
        { method: "POST" },
      ),
    );
  }

  async cancelWorkspaceVerification(
    workspaceId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeWorkspaceEvidence(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/verification/cancel`,
        { method: "POST" },
      ),
    );
  }

  async promoteAgentVerificationCheck(
    workspaceId: string,
    proposalId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    const proposal = requiredAgentProposalId(proposalId);
    return normalizeWorkspaceEvidence(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/verification/agent-proposals/${encodeURIComponent(proposal)}/promote`,
        { method: "POST" },
      ),
    );
  }

  async listWorkspaceTestRuns(
    workspaceId: string,
  ): Promise<WorkspaceTestRunList> {
    const workspace = requiredWorkspaceId(workspaceId);
    const result = normalizeWorkspaceTestRunList(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/test-runs`,
      ),
    );
    if (
      result.workspaceId !== workspace ||
      result.runs.some((run) => run.workspaceId !== workspace)
    ) {
      return invalidPayload("workspaceTestRuns.workspaceId");
    }
    return result;
  }

  async getWorkspaceTestRun(
    workspaceId: string,
    runId: string,
  ): Promise<WorkspaceTestRunDetail> {
    const workspace = requiredWorkspaceId(workspaceId);
    const run = requiredTestRunId(runId);
    const result = normalizeWorkspaceTestRunDetail(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/test-runs/${encodeURIComponent(run)}`,
      ),
    );
    if (result.workspaceId !== workspace || result.runId !== run) {
      return invalidPayload("workspaceTestRunDetail.identity");
    }
    return result;
  }

  async runWorkspaceTestJourney(
    workspaceId: string,
    request: RunWorkspaceTestJourneyRequest,
  ): Promise<WorkspaceTestRunSummary> {
    const workspace = requiredWorkspaceId(workspaceId);
    const validated = validateTestJourneyRequest(request);
    const result = normalizeWorkspaceTestRunSummary(
      await this.request(
        `/api/v1/workspaces/${encodeURIComponent(workspace)}/test-runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validated),
        },
      ),
    );
    if (
      result.workspaceId !== workspace ||
      result.journeyId !== validated.journeyId
    ) {
      return invalidPayload("workspaceTestRun.identity");
    }
    return result;
  }

  async verifyJiraMcp(): Promise<JiraMcpVerification> {
    return normalizeJiraVerification(
      await this.request("/api/v1/integrations/jira-mcp/verify", {
        method: "POST",
      }),
    );
  }

  async importJiraIssue(issueKey: string): Promise<JiraIssueImport> {
    const key = issueKey.trim().toUpperCase();
    if (!key) {
      throw new WorkspaceClientError("A Jira issue key is required", {
        code: "invalid_request",
      });
    }
    return normalizeJiraIssueImport(
      await this.request(
        `/api/v1/jira/issues/${encodeURIComponent(key)}/import`,
        { method: "POST" },
      ),
    );
  }

  async listActiveJiraIssues(): Promise<JiraActiveIssueList> {
    return normalizeJiraActiveIssueList(
      await this.request("/api/v1/jira/issues/active"),
    );
  }

  async verifyOpenProject(): Promise<OpenProjectVerification> {
    return normalizeOpenProjectVerification(
      await this.request("/api/v1/integrations/open-project/verify", {
        method: "POST",
      }),
    );
  }

  async importOpenProjectWorkPackage(
    reference: string,
  ): Promise<OpenProjectWorkPackageImport> {
    const normalizedReference = requiredOpenProjectReference(reference);
    return normalizeOpenProjectWorkPackageImport(
      await this.request(
        `/api/v1/open-project/work-packages/${encodeURIComponent(normalizedReference)}/import`,
        { method: "POST" },
      ),
    );
  }

  private fetch(): typeof fetch {
    const fetchImplementation = this.fetchOverride ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new WorkspaceClientError(
        "This environment cannot reach the local WTS service",
        { code: "transport_unavailable", retryable: true },
      );
    }
    return fetchImplementation.bind(globalThis);
  }

  private sessionToken(): Promise<string> {
    if (!this.sessionTokenPromise) {
      this.sessionTokenPromise = this.bootstrap().catch((error) => {
        this.sessionTokenPromise = undefined;
        throw error;
      });
    }
    return this.sessionTokenPromise;
  }

  private async bootstrap(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetch()(
        `${this.baseUrl}/api/v1/bootstrap`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-WTS-Request": "local-ui",
          },
        },
      );
    } catch (error) {
      const wrapped = wrapTransportError(error);
      logHttpTransportFailure(
        "bootstrap",
        "GET",
        "/api/v1/bootstrap",
        wrapped,
      );
      throw wrapped;
    }

    const payload = await this.readResponse(response);
    const raw = record(payload, "bootstrap");
    return stringField(raw.sessionToken, "bootstrap.sessionToken");
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const sessionToken = await this.sessionToken();
    let response: Response;
    try {
      response = await this.fetch()(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "X-WTS-Session": sessionToken,
          "X-WTS-Request": "local-ui",
          ...init.headers,
        },
      });
    } catch (error) {
      const wrapped = wrapTransportError(error);
      logHttpTransportFailure(
        "request",
        init.method ?? "GET",
        path,
        wrapped,
      );
      throw wrapped;
    }
    return this.readResponse(response);
  }

  private async readResponse(response: Response): Promise<unknown> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new WorkspaceClientError(
        response.ok
          ? "WTS returned malformed JSON"
          : `WTS request failed with HTTP ${response.status}`,
        {
          code: response.ok ? "invalid_response" : "http_error",
          status: response.status,
          retryable: retryableStatus(response.status),
          cause: error,
        },
      );
    }

    if (!response.ok) {
      const details = errorDetails(payload);
      throw new WorkspaceClientError(
        details.message ?? `WTS request failed with HTTP ${response.status}`,
        {
          code: details.code ?? "http_error",
          status: response.status,
          retryable:
            details.retryable ?? retryableStatus(response.status),
        },
      );
    }
    return payload;
  }
}

class TauriWorkspaceClient implements WorkspaceClient {
  constructor(private readonly invokeOverride?: Invoke) {}

  async getGithubReviewInbox(): Promise<GithubReviewInbox> {
    return normalizeGithubReviewInbox(
      await this.invoke(GITHUB_REVIEW_INBOX_TAURI_COMMAND),
    );
  }

  async openGithubReview(repositoryId: string, number: number): Promise<OpenGithubReviewResult> {
    validateGithubReviewIdentity(repositoryId, number);
    return normalizeOpenGithubReviewResult(
      await this.invoke(OPEN_GITHUB_REVIEW_TAURI_COMMAND, { repositoryId, number }),
    );
  }

  async getGitlabReviewInbox(): Promise<GitlabReviewInbox> {
    return normalizeGitlabReviewInbox(
      await this.invoke(GITLAB_REVIEW_INBOX_TAURI_COMMAND),
    );
  }

  async getGitlabReviewPatch(
    repositoryId: string,
    iid: number,
    commitOid?: string,
    refresh?: boolean,
  ): Promise<GitlabReviewPatch> {
    validateGitlabMergeRequestIdentity(repositoryId, iid);
    return normalizeGitlabReviewPatch(await this.invoke(GITLAB_REVIEW_PATCH_TAURI_COMMAND, {
      repositoryId,
      iid,
      commitOid,
      refresh,
    }));
  }

  async publishGitlabReviewComment(repositoryId: string, iid: number, request: GitlabReviewCommentRequest): Promise<PublishGitlabReviewCommentResult> {
    validateGitlabMergeRequestIdentity(repositoryId, iid);
    return normalizePublishGitlabReviewCommentResult(await this.invoke(PUBLISH_GITLAB_REVIEW_COMMENT_TAURI_COMMAND, { repositoryId, iid, request }));
  }

  async prepareGitlabReviewRepository(
    repositoryId: string,
    iid: number,
  ): Promise<CloneRepositoryResult> {
    validateGitlabMergeRequestIdentity(repositoryId, iid);
    return normalizeCloneRepositoryResult(
      await this.invoke(PREPARE_GITLAB_REVIEW_REPOSITORY_TAURI_COMMAND, {
        repositoryId,
        iid,
      }),
    );
  }

  async listWorkspaces(): Promise<WorkspaceList> {
    return normalizeWorkspaceList(
      await this.invoke("list_workspaces"),
    );
  }

  async getWorkspace(workspaceId: string): Promise<WorkspaceView> {
    if (!workspaceId.trim()) {
      throw new WorkspaceClientError("A workspace ID is required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspace(
      await this.invoke("get_workspace", { workspaceId }),
    );
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<WorkspaceView> {
    const normalizedTitle = title.trim();
    if (!workspaceId.trim() || !normalizedTitle) {
      throw new WorkspaceClientError("A workspace ID and name are required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspace(
      await this.invoke("rename_workspace", {
        workspaceId,
        request: { title: normalizedTitle },
      }),
    );
  }

  async transitionWorkspaceWorkflow(
    workspaceId: string,
    state: WorkspaceWorkflowState,
    expectedRevision: number,
  ): Promise<WorkspaceWorkflowSummary> {
    validateWorkspaceWorkflowRequest(workspaceId, state, expectedRevision);
    return normalizeWorkspaceWorkflow(
      await this.invoke("transition_workspace_workflow", {
        workspaceId,
        request: { state, expectedRevision },
      }),
      "workflow",
    );
  }

  async placeWorkspaceOnBoard(
    workspaceId: string,
    request: PlaceWorkspaceOnBoardRequest,
  ): Promise<WorkspaceWorkflowSummary> {
    validateBoardPlacementRequest(workspaceId, request);
    return normalizeWorkspaceWorkflow(
      await this.invoke("place_workspace_on_board", {
        workspaceId,
        request,
      }),
      "workflow",
    );
  }

  async followWorkspaceAgent(
    workspaceId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkflowSummary> {
    validateWorkspaceWorkflowRequest(workspaceId, "ready", expectedRevision);
    return normalizeWorkspaceWorkflow(
      await this.invoke("follow_workspace_agent", {
        workspaceId,
        request: { expectedRevision },
      }),
      "workflow",
    );
  }

  async listWorkspacePlanningDocuments(
    workspaceId: string,
  ): Promise<WorkspacePlanningDocumentList> {
    validateWorkspaceId(workspaceId);
    return normalizePlanningDocumentList(
      await this.invoke("list_workspace_planning_documents", { workspaceId }),
    );
  }

  async readWorkspacePlanningDocument(
    workspaceId: string,
    documentId: WorkspacePlanningDocumentId,
  ): Promise<WorkspacePlanningDocument> {
    validateWorkspaceId(workspaceId);
    return normalizePlanningDocument(
      await this.invoke("read_workspace_planning_document", {
        workspaceId,
        documentId,
      }),
    );
  }

  async updateWorkspacePlanningDocument(
    workspaceId: string,
    documentId: WorkspacePlanningDocumentId,
    expectedSha256: string,
    contents: string,
  ): Promise<WorkspacePlanningDocument> {
    validateWorkspaceId(workspaceId);
    validatePlanningDocumentWrite(expectedSha256, contents);
    return normalizePlanningDocument(
      await this.invoke("update_workspace_planning_document", {
        workspaceId,
        documentId,
        request: { expectedSha256, contents },
      }),
    );
  }

  async listWorkspaceReviewThreads(
    workspaceId: string,
  ): Promise<WorkspaceReviewThreadList> {
    validateWorkspaceId(workspaceId);
    return normalizeWorkspaceReviewThreadList(
      await this.invoke("list_workspace_review_threads", { workspaceId }),
    );
  }

  async createWorkspaceReviewThread(
    workspaceId: string,
    target: ReviewTarget,
    body: string,
    author: ReviewAuthor = "user",
  ): Promise<WorkspaceReviewThread> {
    validateReviewThreadCreate(workspaceId, target, body, author);
    const requestTarget = reviewTargetRequest(target);
    return normalizeWorkspaceReviewThread(
      await this.invoke("create_workspace_review_thread", {
        workspaceId,
        request: { target: requestTarget, author, body },
      }),
    );
  }

  async resolveWorkspaceReviewThread(
    workspaceId: string,
    threadId: string,
    expectedRevision: number,
  ): Promise<WorkspaceReviewThread> {
    validateReviewThreadResolve(workspaceId, threadId, expectedRevision);
    return normalizeWorkspaceReviewThread(
      await this.invoke("resolve_workspace_review_thread", {
        workspaceId,
        threadId,
        request: { expectedRevision },
      }),
    );
  }

  async previewWorkspaceJiraLink(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
  ): Promise<WorkspaceWorkItemLinkPreview> {
    const workspace = requiredWorkspaceId(workspaceId);
    const request = validateWorkspaceJiraLinkInput(issueKey, role);
    const result = normalizeWorkspaceWorkItemLinkPreview(
      await this.invoke("preview_workspace_jira_link", {
        workspaceId: workspace,
        request,
      }),
    );
    if (result.workspaceId !== workspace) {
      return invalidPayload("workspaceWorkItemLinkPreview.workspaceId");
    }
    return result;
  }

  async confirmWorkspaceJiraLink(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
    expectedPreviewDigest: string,
    idempotencyKey: string,
  ): Promise<ConfirmWorkspaceWorkItemLinkResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const request = validateWorkspaceJiraLinkInput(issueKey, role);
    requiredSha256(expectedPreviewDigest, "expectedPreviewDigest");
    const idempotency = requiredWorkspaceId(idempotencyKey);
    const raw = exactRecord(
      await this.invoke("confirm_workspace_jira_link", {
        workspaceId: workspace,
        request: {
          ...request,
          expectedPreviewDigest,
          idempotencyKey: idempotency,
        },
      }),
      "confirmWorkspaceWorkItemLinkResult",
      ["link", "replayed"],
    );
    const result = {
      link: normalizeWorkspaceWorkItemLink(
        raw.link,
        "confirmWorkspaceWorkItemLinkResult.link",
      ),
      replayed: booleanField(
        raw.replayed,
        "confirmWorkspaceWorkItemLinkResult.replayed",
      ),
    };
    if (result.link.workspaceId !== workspace) {
      return invalidPayload("confirmWorkspaceWorkItemLinkResult.link.workspaceId");
    }
    return result;
  }

  async openWorkspaceJiraPreview(
    workspaceId: string,
    issueKey: string,
    role: WorkspaceWorkItemRole,
    expectedPreviewDigest: string,
  ): Promise<WorkspaceWorkItemOpenResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const request = validateWorkspaceJiraLinkInput(issueKey, role);
    requiredSha256(expectedPreviewDigest, "expectedPreviewDigest");
    const result = normalizeWorkspaceWorkItemOpenResult(
      await this.invoke("open_workspace_jira_preview", {
        workspaceId: workspace,
        request: { ...request, expectedPreviewDigest },
      }),
    );
    if (result.workspaceId !== workspace || result.issueKey !== request.issueKey) {
      return invalidPayload("workspaceWorkItemOpenResult.identity");
    }
    return result;
  }

  async listWorkspaceWorkItemLinks(
    workspaceId: string,
  ): Promise<WorkspaceWorkItemLinkList> {
    const workspace = requiredWorkspaceId(workspaceId);
    const result = normalizeWorkspaceWorkItemLinkList(
      await this.invoke("list_workspace_work_item_links", {
        workspaceId: workspace,
      }),
    );
    if (
      result.workspaceId !== workspace ||
      result.links.some((link) => link.workspaceId !== workspace)
    ) {
      return invalidPayload("workspaceWorkItemLinkList.workspaceId");
    }
    return result;
  }

  async unlinkWorkspaceWorkItem(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkItemUnlinkResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const link = requiredWorkspaceId(linkId);
    positiveInteger(expectedRevision, "expectedRevision");
    const raw = exactRecord(
      await this.invoke("unlink_workspace_work_item", {
        workspaceId: workspace,
        linkId: link,
        request: { expectedRevision },
      }),
      "workspaceWorkItemUnlinkResult",
      ["workspaceId", "linkId", "removedRevision"],
    );
    const result = {
      workspaceId: requiredWorkspaceId(
        stringField(raw.workspaceId, "workspaceWorkItemUnlinkResult.workspaceId"),
      ),
      linkId: requiredWorkspaceId(
        stringField(raw.linkId, "workspaceWorkItemUnlinkResult.linkId"),
      ),
      removedRevision: positiveInteger(
        raw.removedRevision,
        "workspaceWorkItemUnlinkResult.removedRevision",
      ),
    };
    if (result.workspaceId !== workspace || result.linkId !== link) {
      return invalidPayload("workspaceWorkItemUnlinkResult.identity");
    }
    return result;
  }

  async openWorkspaceWorkItem(
    workspaceId: string,
    linkId: string,
    expectedRevision: number,
  ): Promise<WorkspaceWorkItemOpenResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const link = requiredWorkspaceId(linkId);
    positiveInteger(expectedRevision, "expectedRevision");
    const result = normalizeWorkspaceWorkItemOpenResult(
      await this.invoke("open_workspace_work_item", {
        workspaceId: workspace,
        linkId: link,
        request: { expectedRevision },
      }),
    );
    if (result.workspaceId !== workspace) {
      return invalidPayload("workspaceWorkItemOpenResult.workspaceId");
    }
    return result;
  }

  async proposeWorkspaceJiraIssue(
    workspaceId: string,
  ): Promise<JiraCreateProposal> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeJiraCreateProposal(
      await this.invoke("propose_workspace_jira_issue", {
        workspaceId: workspace,
      }),
    );
  }

  async createWorkspace(
    request: CreateWorkspaceRequest,
    idempotencyKey: string,
  ): Promise<CreateWorkspaceResult> {
    if (!idempotencyKey.trim()) {
      throw new WorkspaceClientError(
        "An idempotency key is required to create a workspace",
        { code: "invalid_request" },
      );
    }
    const validated = validateCreateRequest(request);
    return normalizeCreateResult(
      await this.invoke("create_workspace", {
        request: validated,
        idempotencyKey,
      }),
    );
  }

  async getSetupSnapshot(): Promise<SetupSnapshot> {
    return normalizeSetupSnapshot(
      await this.invoke("get_setup_snapshot"),
    );
  }

  async listRepositories(): Promise<RepositoryCatalog> {
    return normalizeRepositoryCatalog(
      await this.invoke("list_repositories"),
    );
  }

  async cloneRepository(
    request: CloneRepositoryRequest,
  ): Promise<CloneRepositoryResult> {
    const validated = validateCloneRepositoryRequest(request);
    return normalizeCloneRepositoryResult(
      await this.invoke("clone_repository", {
        request: validated,
      }),
    );
  }

  async refreshRepositoryBranches(
    repositoryId: string,
  ): Promise<RepositorySummary> {
    const repository = repositoryId.trim();
    if (!repository) {
      throw new WorkspaceClientError("A repository ID is required", {
        code: "invalid_request",
      });
    }
    const payload = record(
      await this.invoke("refresh_repository_branches", {
        request: { repositoryId: repository },
      }),
      "repositoryBranchRefresh",
    );
    return normalizeRepositorySummary(
      payload.repository,
      "repositoryBranchRefresh.repository",
    );
  }

  async importCodeWorkspaceFile(
    request: CodeWorkspaceFileImportRequest,
  ): Promise<CodeWorkspaceFileImportResult> {
    const validated = validateCodeWorkspaceFileImportRequest(request);
    return normalizeCodeWorkspaceFileImport(
      await this.invoke("import_code_workspace_file", {
        request: validated,
      }),
    );
  }

  async analyzeWorkspaceRuntime(
    request: RuntimeAnalysisRequest,
  ): Promise<RuntimeAnalysisResult> {
    const validated = validateRuntimeAnalysisRequest(request);
    return normalizeRuntimeAnalysisResult(
      await this.invoke("analyze_workspace_runtime", {
        request: validated,
      }),
    );
  }

  async preflightWorkspace(
    workspaceId: string,
  ): Promise<WorkspacePreflight> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizePreflight(
      await this.invoke("preflight_workspace", {
        workspaceId: workspace,
      }),
    );
  }

  async getWorkspaceMaterialization(
    workspaceId: string,
  ): Promise<WorkspaceMaterialization | null> {
    const workspace = requiredWorkspaceId(workspaceId);
    const payload = await this.invoke("get_workspace_materialization", {
      workspaceId: workspace,
    });
    return payload === null
      ? null
      : normalizeMaterialization(payload, "workspaceMaterialization");
  }

  async getWorkspaceRepositoryDiff(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryDiff> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = repositoryId.trim();
    if (!repository || repository.length > 512) {
      throw new WorkspaceClientError("A repository ID is required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspaceRepositoryDiff(
      await this.invoke("get_workspace_repository_diff", {
        workspaceId: workspace,
        repositoryId: repository,
      }),
    );
  }

  async getWorkspaceRepositoryFileReview(
    workspaceId: string,
    repositoryId: string,
    filePath: string,
    expectedPatchSha256: string,
  ): Promise<WorkspaceRepositoryFileReview> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredRepositoryId(repositoryId);
    const path = requiredRepositoryFilePath(filePath);
    const expectedPatch = normalizeSha256(
      expectedPatchSha256,
      "expectedPatchSha256",
    );
    return normalizeWorkspaceRepositoryFileReview(
      await this.invoke("get_workspace_repository_file_review", {
        workspaceId: workspace,
        repositoryId: repository,
        filePath: path,
        expectedPatchSha256: expectedPatch,
      }),
    );
  }

  async getWorkspaceRepositoryReviewGraph(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryReviewGraph | null> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredRepositoryId(repositoryId);
    const payload = await this.invoke("get_workspace_repository_review_graph", {
      workspaceId: workspace,
      repositoryId: repository,
    });
    return payload === null
      ? null
      : normalizeWorkspaceRepositoryReviewGraph(
          payload,
          "workspaceRepositoryReviewGraph",
        );
  }

  async syncWorkspaceRepository(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositorySyncResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = repositoryId.trim();
    if (!repository || repository.length > 512) {
      throw new WorkspaceClientError("A repository ID is required", {
        code: "invalid_request",
      });
    }
    const result = normalizeWorkspaceRepositorySyncResult(
      await this.invoke("sync_workspace_repository", {
        workspaceId: workspace,
        repositoryId: repository,
      }),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== repository) {
      return invalidPayload("workspaceRepositorySyncResult.identity");
    }
    return result;
  }

  async preflightWorkspaceRepositoryAlignment(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceRepositoryAlignmentPreflight> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredRepositoryId(repositoryId);
    const result = normalizeWorkspaceRepositoryAlignmentPreflight(
      await this.invoke("preflight_workspace_repository_alignment", {
        workspaceId: workspace,
        repositoryId: repository,
      }),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== repository) {
      return invalidPayload("workspaceRepositoryAlignmentPreflight.identity");
    }
    return result;
  }

  async alignWorkspaceRepository(
    workspaceId: string,
    repositoryId: string,
    effectDigest: string,
  ): Promise<WorkspaceRepositoryAlignmentResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredRepositoryId(repositoryId);
    if (!effectDigest.trim()) {
      throw new WorkspaceClientError("An alignment effect digest is required", {
        code: "invalid_request",
      });
    }
    const result = normalizeWorkspaceRepositoryAlignmentResult(
      await this.invoke("align_workspace_repository", {
        workspaceId: workspace,
        repositoryId: repository,
        effectDigest: effectDigest.trim(),
      }),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== repository) {
      return invalidPayload("workspaceRepositoryAlignmentResult.identity");
    }
    return result;
  }

  async materializeWorkspace(
    workspaceId: string,
    effectDigest: string,
    idempotencyKey: string,
  ): Promise<MaterializeWorkspaceResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    if (!effectDigest.trim() || !idempotencyKey.trim()) {
      throw new WorkspaceClientError(
        "An effect digest and idempotency key are required",
        { code: "invalid_request" },
      );
    }
    // Tauri invokes one in-process operation, so its manifest replay provides
    // idempotency. The key remains part of the cross-transport client contract.
    void idempotencyKey;
    return normalizeMaterializeResult(
      await this.invoke("materialize_workspace", {
        workspaceId: workspace,
        effectDigest: effectDigest.trim(),
      }),
    );
  }

  async openWorkspaceInVscode(
    workspaceId: string,
  ): Promise<OpenWorkspaceResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeOpenResult(
      await this.invoke("open_workspace_in_vscode", {
        workspaceId: workspace,
      }),
    );
  }

  async openRepositoryBase(
    repositoryId: string,
    baseRef: string,
  ): Promise<OpenRepositoryBaseResult> {
    const selection = requiredRepositoryBaseSelection(
      repositoryId,
      baseRef,
    );
    const result = normalizeOpenRepositoryBaseResult(
      await this.invoke("open_repository_base", {
        repositoryId: selection.repositoryId,
        baseRef: selection.baseRef,
      }),
    );
    if (
      result.repositoryId !== selection.repositoryId ||
      result.baseRef !== selection.baseRef
    ) {
      return invalidPayload("openRepositoryBaseResult.identity");
    }
    return result;
  }

  async getGitlabMergeRequests(
    workspaceId: string,
  ): Promise<GitlabMergeRequestInbox> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeGitlabMergeRequestInbox(
      await this.invoke(GET_GITLAB_MERGE_REQUESTS_TAURI_COMMAND, {
        workspaceId: workspace,
      }),
    );
  }

  async openGitlabMergeRequest(
    repositoryId: string,
    iid: number,
  ): Promise<OpenGitlabMergeRequestResult> {
    const repository = requiredChangeRequestRepositoryId(repositoryId);
    validateGitlabMergeRequestIdentity(repository, iid);
    const result = normalizeOpenGitlabMergeRequestResult(
      await this.invoke(OPEN_GITLAB_MERGE_REQUEST_TAURI_COMMAND, {
        repositoryId: repository,
        iid,
      }),
    );
    if (
      result.repositoryId !== repository ||
      result.iid !== iid
    ) {
      return invalidPayload("openGitlabMergeRequestResult.identity");
    }
    return result;
  }

  async getGitlabIntegrationStatus(
    workspaceId: string,
  ): Promise<GitlabIntegrationStatus> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeGitlabIntegrationStatus(
      await this.invoke(GET_GITLAB_INTEGRATION_STATUS_TAURI_COMMAND, {
        workspaceId: workspace,
      }),
    );
  }

  async getUpdateStatus(): Promise<AppUpdateStatus> {
    return normalizeAppUpdateStatus(
      await this.invoke(GET_UPDATE_STATUS_TAURI_COMMAND),
    );
  }

  async checkForUpdate(): Promise<AppUpdateStatus> {
    return normalizeAppUpdateStatus(
      await this.invoke(CHECK_FOR_UPDATE_TAURI_COMMAND),
    );
  }

  async downloadAndInstallUpdate(): Promise<AppUpdateStatus> {
    return normalizeAppUpdateStatus(
      await this.invoke(DOWNLOAD_AND_INSTALL_UPDATE_TAURI_COMMAND),
    );
  }

  async relaunchUpdatedApp(): Promise<RelaunchUpdatedAppResult> {
    return normalizeRelaunchUpdatedAppResult(
      await this.invoke(RELAUNCH_UPDATED_APP_TAURI_COMMAND),
    );
  }

  async prepareWorkspaceChangeRequest(
    workspaceId: string,
    repositoryId: string,
  ): Promise<WorkspaceChangeRequestDraft> {
    const workspace = requiredWorkspaceId(workspaceId);
    const repository = requiredChangeRequestRepositoryId(repositoryId);
    const result = normalizeWorkspaceChangeRequestDraft(
      await this.invoke("prepare_workspace_change_request", {
        workspaceId: workspace,
        request: { repositoryId: repository },
      }),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== repository) {
      return invalidPayload("workspaceChangeRequestDraft.identity");
    }
    return result;
  }

  async openWorkspaceChangeRequestDraft(
    workspaceId: string,
    repositoryId: string,
    effectDigest: string,
    title: string,
    body: string,
  ): Promise<OpenWorkspaceChangeRequestResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const request = requiredChangeRequestDraft(repositoryId, effectDigest, title, body);
    const result = normalizeOpenWorkspaceChangeRequestResult(
      await this.invoke("open_workspace_change_request_draft", {
        workspaceId: workspace,
        request,
      }),
    );
    if (result.workspaceId !== workspace || result.repositoryId !== request.repositoryId) {
      return invalidPayload("openWorkspaceChangeRequestResult.identity");
    }
    return result;
  }

  async openWorkspaceCli(
    workspaceId: string,
    provider: AgentProvider,
    terminal: TerminalProvider = "terminal",
  ): Promise<WorkspaceCliLaunchResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    if (!agentProviders.includes(provider)) {
      throw new WorkspaceClientError("An agent provider is required", {
        code: "invalid_request",
      });
    }
    if (!terminalProviders.includes(terminal)) {
      throw new WorkspaceClientError("A terminal is required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspaceCliLaunchResult(
      await this.invoke("open_workspace_cli", {
        workspaceId: workspace,
        provider,
        terminal,
      }),
    );
  }

  async writeWorkspaceAgentBrief(
    workspaceId: string,
    taskMarkdown: string,
  ): Promise<WorkspaceAgentBriefResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    const task = taskMarkdown.trim();
    if (!task) {
      throw new WorkspaceClientError("An agent brief is required", {
        code: "invalid_request",
      });
    }
    return normalizeWorkspaceAgentBriefResult(
      await this.invoke("write_workspace_agent_brief", {
        workspaceId: workspace,
        taskMarkdown: task,
      }),
    );
  }

  async indexWorkspaceGraph(
    workspaceId: string,
  ): Promise<GraphIndexResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeGraphIndexResult(
      await this.invoke("index_workspace_graph", {
        workspaceId: workspace,
      }),
    );
  }

  async reindexWorkspaceGraph(
    workspaceId: string,
  ): Promise<GraphIndexResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeGraphIndexResult(
      await this.invoke("reindex_workspace_graph", {
        workspaceId: workspace,
      }),
    );
  }

  async preflightWorkspaceRemoval(
    workspaceId: string,
  ): Promise<WorkspaceRemovalPreflight> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeWorkspaceRemovalPreflight(
      await this.invoke("preflight_workspace_removal", {
        workspaceId: workspace,
      }),
    );
  }

  async removeWorkspace(
    workspaceId: string,
    effectDigest: string,
    idempotencyKey: string,
    deleteProtectedPaths = false,
  ): Promise<RemoveWorkspaceResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    if (!effectDigest.trim() || !idempotencyKey.trim()) {
      throw new WorkspaceClientError(
        "An effect digest and idempotency key are required",
        { code: "invalid_request" },
      );
    }
    return normalizeRemoveWorkspaceResult(
      await this.invoke("remove_workspace", {
        workspaceId: workspace,
        effectDigest: effectDigest.trim(),
        idempotencyKey,
        deleteProtectedPaths,
      }),
    );
  }

  async runWorkspaceAgent(
    workspaceId: string,
    provider: AgentProvider,
    prompt: string,
  ): Promise<AgentRunResult> {
    const workspace = requiredWorkspaceId(workspaceId);
    if (!agentProviders.includes(provider) || !prompt.trim()) {
      throw new WorkspaceClientError(
        "An agent provider and prompt are required",
        { code: "invalid_request" },
      );
    }
    return normalizeAgentRunResult(
      await this.invoke("run_workspace_agent", {
        workspaceId: workspace,
        provider,
        prompt: prompt.trim(),
      }),
    );
  }

  async getWorkspaceEvidence(
    workspaceId: string,
  ): Promise<WorkspaceEvidence | null> {
    const workspace = requiredWorkspaceId(workspaceId);
    const payload = await this.invoke("get_workspace_evidence", {
      workspaceId: workspace,
    });
    return payload === null ? null : normalizeWorkspaceEvidence(payload);
  }

  async runWorkspaceVerification(
    workspaceId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeWorkspaceEvidence(
      await this.invoke("run_workspace_verification", {
        workspaceId: workspace,
      }),
    );
  }

  async runWorkspaceVerificationCheck(
    workspaceId: string,
    checkId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    const check = requiredVerificationCheckId(checkId);
    return normalizeWorkspaceEvidence(
      await this.invoke("run_workspace_verification_check", {
        workspaceId: workspace,
        checkId: check,
      }),
    );
  }

  async rerunFailedWorkspaceVerification(
    workspaceId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeWorkspaceEvidence(
      await this.invoke("rerun_failed_workspace_verification", {
        workspaceId: workspace,
      }),
    );
  }

  async cancelWorkspaceVerification(
    workspaceId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeWorkspaceEvidence(
      await this.invoke("cancel_workspace_verification", {
        workspaceId: workspace,
      }),
    );
  }

  async promoteAgentVerificationCheck(
    workspaceId: string,
    proposalId: string,
  ): Promise<WorkspaceEvidence> {
    const workspace = requiredWorkspaceId(workspaceId);
    const proposal = requiredAgentProposalId(proposalId);
    return normalizeWorkspaceEvidence(
      await this.invoke("promote_agent_verification_check", {
        workspaceId: workspace,
        proposalId: proposal,
      }),
    );
  }

  async listWorkspaceTestRuns(
    workspaceId: string,
  ): Promise<WorkspaceTestRunList> {
    const workspace = requiredWorkspaceId(workspaceId);
    const result = normalizeWorkspaceTestRunList(
      await this.invoke("list_workspace_test_runs", {
        workspaceId: workspace,
      }),
    );
    if (
      result.workspaceId !== workspace ||
      result.runs.some((run) => run.workspaceId !== workspace)
    ) {
      return invalidPayload("workspaceTestRuns.workspaceId");
    }
    return result;
  }

  async getWorkspaceTestRun(
    workspaceId: string,
    runId: string,
  ): Promise<WorkspaceTestRunDetail> {
    const workspace = requiredWorkspaceId(workspaceId);
    const run = requiredTestRunId(runId);
    const result = normalizeWorkspaceTestRunDetail(
      await this.invoke("get_workspace_test_run", {
        workspaceId: workspace,
        runId: run,
      }),
    );
    if (result.workspaceId !== workspace || result.runId !== run) {
      return invalidPayload("workspaceTestRunDetail.identity");
    }
    return result;
  }

  async runWorkspaceTestJourney(
    workspaceId: string,
    request: RunWorkspaceTestJourneyRequest,
  ): Promise<WorkspaceTestRunSummary> {
    const workspace = requiredWorkspaceId(workspaceId);
    const validated = validateTestJourneyRequest(request);
    const result = normalizeWorkspaceTestRunSummary(
      await this.invoke("run_workspace_test_journey", {
        workspaceId: workspace,
        request: validated,
      }),
    );
    if (
      result.workspaceId !== workspace ||
      result.journeyId !== validated.journeyId
    ) {
      return invalidPayload("workspaceTestRun.identity");
    }
    return result;
  }

  async verifyJiraMcp(): Promise<JiraMcpVerification> {
    return normalizeJiraVerification(
      await this.invoke("verify_jira_mcp"),
    );
  }

  async importJiraIssue(issueKey: string): Promise<JiraIssueImport> {
    const key = issueKey.trim().toUpperCase();
    if (!key) {
      throw new WorkspaceClientError("A Jira issue key is required", {
        code: "invalid_request",
      });
    }
    return normalizeJiraIssueImport(
      await this.invoke("import_jira_issue", { issueKey: key }),
    );
  }

  async listActiveJiraIssues(): Promise<JiraActiveIssueList> {
    return normalizeJiraActiveIssueList(
      await this.invoke("list_active_jira_issues"),
    );
  }

  async verifyOpenProject(): Promise<OpenProjectVerification> {
    return normalizeOpenProjectVerification(
      await this.invoke("verify_open_project"),
    );
  }

  async importOpenProjectWorkPackage(
    reference: string,
  ): Promise<OpenProjectWorkPackageImport> {
    const normalizedReference = requiredOpenProjectReference(reference);
    return normalizeOpenProjectWorkPackageImport(
      await this.invoke("import_open_project_work_package", {
        reference: normalizedReference,
      }),
    );
  }

  async listAgentSessions(workspaceId?: string): Promise<AgentSessionList> {
    const workspace =
      workspaceId === undefined ? undefined : requiredWorkspaceId(workspaceId);
    const result = normalizeAgentSessionList(
      await this.invoke("list_agent_sessions", {
        ...(workspace === undefined ? {} : { workspaceId: workspace }),
      }),
    );
    if (
      workspace !== undefined &&
      result.sessions.some((session) => session.workspaceId !== workspace)
    ) {
      return invalidPayload("agentSessionList.sessions.workspaceId");
    }
    return result;
  }

  async getAgentSessionDetail(sessionId: string): Promise<AgentSessionDetail> {
    return normalizeAgentSessionDetail(
      await this.invoke("get_agent_session_detail", {
        sessionId: requiredWorkspaceId(sessionId),
      }),
    );
  }

  async startAgentSessionPrototype(workspaceId: string): Promise<AgentSession> {
    const workspace = requiredWorkspaceId(workspaceId);
    return normalizeAgentSession(
      await this.invoke("start_agent_session", {
        workspaceId: workspace,
        provider: "codex",
        terminal: "terminal",
        category: "implementation",
      }),
      "agentSession",
    );
  }

  async heartbeatAgentSession(sessionId: string): Promise<AgentSession> {
    return normalizeAgentSession(
      await this.invoke("heartbeat_agent_session", {
        sessionId: requiredWorkspaceId(sessionId),
      }),
      "agentSession",
    );
  }

  async completeAgentSession(sessionId: string): Promise<AgentSession> {
    return normalizeAgentSession(
      await this.invoke("finish_agent_session", {
        sessionId: requiredWorkspaceId(sessionId),
      }),
      "agentSession",
    );
  }

  async failAgentSession(sessionId: string): Promise<AgentSession> {
    return normalizeAgentSession(
      await this.invoke("fail_agent_session", {
        sessionId: requiredWorkspaceId(sessionId),
      }),
      "agentSession",
    );
  }

  async launchAgentSession(
    workspaceId: string,
    request: LaunchAgentSessionRequest,
  ): Promise<AgentSession> {
    const workspace = requiredWorkspaceId(workspaceId);
    const validated = validateLaunchAgentSessionRequest(request);
    return normalizeAgentSession(
      await this.invoke("launch_agent_session", {
        workspaceId: workspace,
        provider: validated.provider,
        prompt: validated.prompt,
        category: validated.category,
      }),
      "agentSession",
    );
  }

  async stopAgentSession(sessionId: string): Promise<AgentSession> {
    return normalizeAgentSession(
      await this.invoke("stop_agent_session", {
        sessionId: requiredWorkspaceId(sessionId),
      }),
      "agentSession",
    );
  }

  async getActivityWatchStatus(
    endpoint?: string,
  ): Promise<ActivityWatchStatus> {
    return normalizeActivityWatchStatus(
      await this.invoke("get_activity_watch_status", {
        ...(endpoint === undefined ? {} : { endpoint }),
      }),
    );
  }

  async getActivityWatchDailyReview(
    startedAtUnixMs: number,
    endedAtUnixMs: number,
    endpoint?: string,
  ): Promise<ActivityWatchDailyReview> {
    const start = integerField(startedAtUnixMs, "startedAtUnixMs");
    const end = integerField(endedAtUnixMs, "endedAtUnixMs");
    if (end <= start) return invalidPayload("endedAtUnixMs");
    return normalizeActivityWatchDailyReview(
      await this.invoke("get_activity_watch_daily_review", {
        startedAtUnixMs: start,
        endedAtUnixMs: end,
        ...(endpoint === undefined ? {} : { endpoint }),
      }),
    );
  }

  private async invoke(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      const invoke =
        this.invokeOverride ??
        (await import("@tauri-apps/api/core")).invoke;
      return await invoke(command, args);
    } catch (error) {
      throw wrapTransportError(error);
    }
  }
}

function requiredWorkspaceId(workspaceId: string): string {
  const value = workspaceId.trim();
  if (!value) {
    throw new WorkspaceClientError("A workspace ID is required", {
      code: "invalid_request",
    });
  }
  return value;
}

function requiredRepositoryId(repositoryId: string): string {
  const value = repositoryId.trim();
  if (!value || value.length > 512) {
    throw new WorkspaceClientError("A repository ID is required", {
      code: "invalid_request",
    });
  }
  return value;
}

function requiredRepositoryFilePath(filePath: string): string {
  if (
    !filePath ||
    filePath.length > 4096 ||
    filePath.startsWith("/") ||
    filePath.includes("\\") ||
    filePath.split("/").some((part) => !part || part === "." || part === "..") ||
    /[\0-\x1f\x7f]/.test(filePath)
  ) {
    throw new WorkspaceClientError("A valid repository file path is required", {
      code: "invalid_request",
    });
  }
  return filePath;
}

function requiredAgentProposalId(proposalId: string): string {
  const value = proposalId.trim();
  if (!value || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new WorkspaceClientError("A valid agent proposal ID is required", {
      code: "invalid_request",
    });
  }
  return value;
}

function requiredVerificationCheckId(checkId: string): string {
  const value = checkId.trim();
  if (!value || value.length > 128 || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new WorkspaceClientError("A valid verification check ID is required", {
      code: "invalid_request",
    });
  }
  return value;
}

const MAX_REPOSITORY_BASE_INPUT_BYTES = 256;
const MAX_REPOSITORY_REMOTE_URL_BYTES = 2_048;

function validateCloneRepositoryRequest(
  request: CloneRepositoryRequest,
): CloneRepositoryRequest {
  const remoteUrl = request.remoteUrl.trim();
  if (
    !remoteUrl ||
    new TextEncoder().encode(remoteUrl).byteLength >
      MAX_REPOSITORY_REMOTE_URL_BYTES ||
    remoteUrl.startsWith("-") ||
    /[\s\u0000-\u001f\u007f?#\\%]/.test(remoteUrl)
  ) {
    throw new WorkspaceClientError(
      "Enter a supported HTTPS or SSH Git repository URL",
      { code: "invalid_request" },
    );
  }

  if (remoteUrl.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(remoteUrl);
    } catch {
      throw new WorkspaceClientError(
        "Enter a supported HTTPS or SSH Git repository URL",
        { code: "invalid_request" },
      );
    }
    if (
      !["https:", "ssh:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.password ||
      (parsed.protocol === "https:" && parsed.username)
    ) {
      throw new WorkspaceClientError(
        "Enter a supported HTTPS or SSH Git repository URL",
        { code: "invalid_request" },
      );
    }
  } else if (
    !/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:[A-Za-z0-9._+/-]+$/.test(
      remoteUrl,
    )
  ) {
    throw new WorkspaceClientError(
      "Enter a supported HTTPS or SSH Git repository URL",
      { code: "invalid_request" },
    );
  }

  return { remoteUrl };
}

function requiredRepositoryBaseSelection(
  repositoryId: string,
  baseRef: string,
): { repositoryId: string; baseRef: string } {
  const normalizedRepositoryId = repositoryId.trim();
  const normalizedBaseRef = baseRef.trim();
  if (
    !normalizedRepositoryId ||
    new TextEncoder().encode(normalizedRepositoryId).byteLength >
      MAX_REPOSITORY_BASE_INPUT_BYTES
  ) {
    throw new WorkspaceClientError(
      "A repository ID of 256 bytes or fewer is required",
      { code: "invalid_request" },
    );
  }
  if (
    !normalizedBaseRef ||
    new TextEncoder().encode(normalizedBaseRef).byteLength >
      MAX_REPOSITORY_BASE_INPUT_BYTES
  ) {
    throw new WorkspaceClientError(
      "A base reference of 256 bytes or fewer is required",
      { code: "invalid_request" },
    );
  }
  return {
    repositoryId: normalizedRepositoryId,
    baseRef: normalizedBaseRef,
  };
}

function requiredChangeRequestRepositoryId(repositoryId: string): string {
  const value = repositoryId.trim();
  if (!value || new TextEncoder().encode(value).byteLength > 160) {
    throw new WorkspaceClientError("A repository is required", { code: "invalid_request" });
  }
  return value;
}

function requiredChangeRequestDraft(
  repositoryId: string,
  effectDigest: string,
  title: string,
  body: string,
) {
  const repository = requiredChangeRequestRepositoryId(repositoryId);
  const digest = effectDigest.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new WorkspaceClientError("Refresh the change-request draft", { code: "invalid_request" });
  }
  const normalizedTitle = title.trim();
  if (!normalizedTitle || normalizedTitle.length > 256 || normalizedTitle.includes("\0")) {
    throw new WorkspaceClientError("Enter a title of 256 characters or fewer", { code: "invalid_request" });
  }
  if (!body.trim() || body.length > 16_000 || body.includes("\0")) {
    throw new WorkspaceClientError("Enter a description of 16,000 characters or fewer", { code: "invalid_request" });
  }
  return { repositoryId: repository, effectDigest: digest, title: normalizedTitle, body };
}

function requiredOpenProjectReference(reference: string): string {
  const normalizedReference = reference.trim();
  if (
    !normalizedReference ||
    normalizedReference.length > 128 ||
    !/^[A-Za-z0-9._-]+$/.test(normalizedReference) ||
    /^0+$/.test(normalizedReference)
  ) {
    throw new WorkspaceClientError(
      "A numeric OpenProject work-package ID or semantic display ID is required",
      { code: "invalid_request" },
    );
  }
  return normalizedReference;
}

function requiredTestRunId(runId: string): string {
  const value = runId.trim();
  if (!value) {
    throw new WorkspaceClientError("A test-run ID is required", {
      code: "invalid_request",
    });
  }
  return value;
}

export function createWorkspaceClient(
  options: WorkspaceClientOptions = {},
): WorkspaceClient {
  const runtime =
    options.runtime === "auto" || options.runtime === undefined
      ? isTauriRuntime()
        ? "tauri"
        : "http"
      : options.runtime;

  return runtime === "tauri"
    ? new TauriWorkspaceClient(options.invoke)
    : new HttpWorkspaceClient(options.baseUrl ?? "", options.fetch);
}

export const defaultWorkspaceClient: WorkspaceClient =
  createWorkspaceClient();
