import { vi } from "vitest";
import type {
  ActivityWatchDailyReview,
  ActivityWatchStatus,
  AppUpdateStatus,
  AgentSessionList,
  AgentSessionDetail,
  CloneRepositoryResult,
  CodeWorkspaceFileImportResult,
  CreateWorkspaceResult,
  GraphIndexResult,
  GitlabIntegrationStatus,
  GitlabReviewInbox,
  JiraActiveIssueList,
  MaterializeWorkspaceResult,
  GithubReviewInbox,
  OpenRepositoryBaseResult,
  OpenWorkspaceChangeRequestResult,
  OpenWorkspaceResult,
  RemoveWorkspaceResult,
  RepositoryCatalog,
  RepositorySummary,
  RuntimeAnalysisResult,
  SetupSnapshot,
  WorkspaceClient,
  WorkspaceBranchPublicationResult,
  WorkspaceChangeRequestDraft,
  WorkspaceEvidence,
  WorkspaceList,
  WorkspaceMaterialization,
  WorkspacePreflight,
  WorkspaceRepositoryDiff,
  WorkspaceRepositoryFileReview,
  WorkspaceRepositoryReviewGraph,
  WorkspaceRepositoryAdditionPreflight,
  WorkspaceRepositoryAdditionResult,
  WorkspaceRepositoryRemovalResult,
  WorkspaceRepositoryAlignmentPreflight,
  WorkspaceRepositoryAlignmentResult,
  WorkspaceRepositorySyncResult,
  WorkspaceRemovalPreflight,
  GitlabMergeRequestInbox,
  WorkspaceTestRunList,
  WorkspaceTestRunDetail,
  WorkspaceTestRunSummary,
  WorkspaceView,
} from "../lib/wtsClient";

export function workspaceFixture(
  overrides: Partial<WorkspaceView> = {},
): WorkspaceView {
  return {
    schemaVersion: 1,
    workspaceId: "ws_01J_PERSISTED",
    recordVersion: 1,
    intent: { type: "jira", issueKey: "PLATFORM-42" },
    title: "Checkout retries create duplicate captures",
    phase: "draft",
    preferredProvider: "codex",
    repositories: [
      {
        requestId: "repo_checkout",
        label: "checkout-api",
        baseRef: "main",
        worktreeLeaf: "checkout-api",
      },
      {
        requestId: "repo_sdk",
        label: "payments-sdk",
        baseRef: "main",
        worktreeLeaf: "payments-sdk",
      },
    ],
    observedWorkItems: [],
    workspaceRootId: "root_local",
    workspaceLeaf: "platform-42-7fd1",
    workspaceDisplayPath: "~/cd/platform-42-7fd1",
    lifecycle: {
      materializationState: "notMaterialized",
      worktreeCount: 0,
      observedAtUnixMs: 1_721_776_400_000,
    },
    workflow: {
      state: "ready",
      revision: 1,
      updatedAtUnixMs: 1_721_776_400_000,
    },
    createdAtUnixMs: 1_721_776_400_000,
    updatedAtUnixMs: 1_721_776_400_000,
    ...overrides,
  };
}

export function workspaceListFixture(
  workspaces: WorkspaceView[] = [],
): WorkspaceList {
  return {
    workspaceRootId: "root_local",
    workspaceRootDisplayPath: "~/cd",
    workspaces,
  };
}

export function runtimeAnalysisFixture(
  overrides: Partial<RuntimeAnalysisResult> = {},
): RuntimeAnalysisResult {
  return {
    analysisDigest: `sha256:${"a".repeat(64)}`,
    repositories: [
      {
        repositoryId: "repo_checkout",
        repositoryLabel: "checkout-api",
        requestedBaseRef: "main",
        resolvedBaseRef: "refs/heads/main",
        commitOid: "0123456789abcdef0123456789abcdef01234567",
      },
    ],
    services: [],
    warnings: [],
    graph: {
      status: "unavailable",
      detail: "No current workspace graph was available.",
    },
    ...overrides,
  };
}

export function fakeWorkspaceClient(options: {
  list?: WorkspaceList;
  get?: WorkspaceView;
  create?: CreateWorkspaceResult;
  setup?: SetupSnapshot;
  repositories?: RepositoryCatalog;
  repositoryClone?: CloneRepositoryResult;
  repositoryRefresh?: RepositorySummary;
  codeWorkspaceImport?: CodeWorkspaceFileImportResult;
  runtimeAnalysis?: RuntimeAnalysisResult;
  preflight?: WorkspacePreflight;
  persistedMaterialization?: WorkspaceMaterialization | null;
  repositoryDiff?: WorkspaceRepositoryDiff;
  repositoryFileReview?: WorkspaceRepositoryFileReview;
  repositoryReviewGraph?: WorkspaceRepositoryReviewGraph | null;
  repositorySync?: WorkspaceRepositorySyncResult;
  repositoryAdditionPreflight?: WorkspaceRepositoryAdditionPreflight;
  repositoryAddition?: WorkspaceRepositoryAdditionResult;
  repositoryRemoval?: WorkspaceRepositoryRemovalResult;
  repositoryAlignmentPreflight?: WorkspaceRepositoryAlignmentPreflight;
  repositoryAlignment?: WorkspaceRepositoryAlignmentResult;
  materialize?: MaterializeWorkspaceResult;
  open?: OpenWorkspaceResult;
  repositoryBaseOpen?: OpenRepositoryBaseResult;
  changeRequestDraft?: WorkspaceChangeRequestDraft;
  branchPublication?: WorkspaceBranchPublicationResult;
  changeRequestOpen?: OpenWorkspaceChangeRequestResult;
  reindex?: GraphIndexResult;
  removalPreflight?: WorkspaceRemovalPreflight;
  remove?: RemoveWorkspaceResult;
  evidence?: WorkspaceEvidence | null;
  verificationRun?: WorkspaceEvidence;
  testRuns?: WorkspaceTestRunList;
  testRunDetail?: WorkspaceTestRunDetail;
  testRun?: WorkspaceTestRunSummary;
  agentSessions?: AgentSessionList;
  agentSessionDetail?: AgentSessionDetail;
  activityWatchStatus?: ActivityWatchStatus;
  activityWatchDailyReview?: ActivityWatchDailyReview;
  activeJiraIssues?: JiraActiveIssueList;
  githubReviewInbox?: GithubReviewInbox;
  gitlabReviewInbox?: GitlabReviewInbox;
  gitlabMergeRequestInbox?: GitlabMergeRequestInbox;
  gitlabIntegrationStatus?: GitlabIntegrationStatus;
  appUpdateStatus?: AppUpdateStatus;
} = {}) {
  const getGithubReviewInbox = vi
    .fn<WorkspaceClient["getGithubReviewInbox"]>()
    .mockResolvedValue(options.githubReviewInbox ?? {
      schemaVersion: 1,
      state: "fresh",
      reviews: [],
      fetchedAtUnixMs: 1_765_756_800_000,
      detail: "GitHub returned the current individual review requests.",
    });
  const openGithubReview = vi
    .fn<WorkspaceClient["openGithubReview"]>()
    .mockRejectedValue(new Error("Unexpected openGithubReview call"));
  const getGitlabReviewInbox = vi
    .fn<WorkspaceClient["getGitlabReviewInbox"]>()
    .mockResolvedValue(options.gitlabReviewInbox ?? {
      schemaVersion: 1,
      state: "fresh",
      reviews: [],
      fetchedAtUnixMs: 1_765_756_800_000,
      detail: "GitLab returned the current individual review requests.",
    });
  const prepareGitlabReviewRepository = vi
    .fn<WorkspaceClient["prepareGitlabReviewRepository"]>()
    .mockRejectedValue(
      new Error("Unexpected prepareGitlabReviewRepository call"),
    );
  const getGitlabReviewPatch = vi
    .fn<WorkspaceClient["getGitlabReviewPatch"]>()
    .mockRejectedValue(new Error("Unexpected getGitlabReviewPatch call"));
  const publishGitlabReviewComment = vi
    .fn<WorkspaceClient["publishGitlabReviewComment"]>()
    .mockRejectedValue(new Error("Unexpected publishGitlabReviewComment call"));
  const getGitlabDiscussions = vi
    .fn<WorkspaceClient["getGitlabDiscussions"]>()
    .mockRejectedValue(new Error("Unexpected getGitlabDiscussions call"));
  const replyGitlabDiscussion = vi
    .fn<WorkspaceClient["replyGitlabDiscussion"]>()
    .mockRejectedValue(new Error("Unexpected replyGitlabDiscussion call"));
  const getGitlabMergeRequests = vi
    .fn<WorkspaceClient["getGitlabMergeRequests"]>()
    .mockResolvedValue(options.gitlabMergeRequestInbox ?? {
      schemaVersion: 1,
      state: "fresh",
      mergeRequests: [],
      fetchedAtUnixMs: 1_765_756_800_000,
      detail: "GitLab returned no matching merge requests.",
    });
  const openGitlabMergeRequest = vi
    .fn<WorkspaceClient["openGitlabMergeRequest"]>()
    .mockRejectedValue(
      new Error("Unexpected openGitlabMergeRequest call"),
    );
  const getGitlabIntegrationStatus = vi
    .fn<WorkspaceClient["getGitlabIntegrationStatus"]>()
    .mockResolvedValue(options.gitlabIntegrationStatus ?? {
      schemaVersion: 1,
      cliState: "ready",
      accounts: [],
      detail: "This workspace does not use a GitLab host.",
    });
  const getUpdateStatus = vi
    .fn<WorkspaceClient["getUpdateStatus"]>()
    .mockResolvedValue(options.appUpdateStatus ?? {
      schemaVersion: 1,
      state: "disabled",
      currentVersion: "0.1.0",
      detail: "The update channel is not configured.",
      diagnosticCode: "notConfigured",
    });
  const checkForUpdate = vi
    .fn<WorkspaceClient["checkForUpdate"]>()
    .mockResolvedValue(options.appUpdateStatus ?? {
      schemaVersion: 1,
      state: "disabled",
      currentVersion: "0.1.0",
      detail: "The update channel is not configured.",
      diagnosticCode: "notConfigured",
    });
  const downloadAndInstallUpdate = vi
    .fn<WorkspaceClient["downloadAndInstallUpdate"]>()
    .mockRejectedValue(new Error("Unexpected downloadAndInstallUpdate call"));
  const relaunchUpdatedApp = vi
    .fn<WorkspaceClient["relaunchUpdatedApp"]>()
    .mockRejectedValue(new Error("Unexpected relaunchUpdatedApp call"));
  const listWorkspaces = vi
    .fn<WorkspaceClient["listWorkspaces"]>()
    .mockResolvedValue(options.list ?? workspaceListFixture());
  const getWorkspace = vi.fn<WorkspaceClient["getWorkspace"]>();
  const renameWorkspace = vi
    .fn<WorkspaceClient["renameWorkspace"]>()
    .mockRejectedValue(new Error("Unexpected renameWorkspace call"));
  const transitionWorkspaceWorkflow = vi
    .fn<WorkspaceClient["transitionWorkspaceWorkflow"]>()
    .mockRejectedValue(new Error("Unexpected transitionWorkspaceWorkflow call"));
  const placeWorkspaceOnBoard = vi
    .fn<WorkspaceClient["placeWorkspaceOnBoard"]>()
    .mockRejectedValue(new Error("Unexpected placeWorkspaceOnBoard call"));
  const followWorkspaceAgent = vi
    .fn<WorkspaceClient["followWorkspaceAgent"]>()
    .mockRejectedValue(new Error("Unexpected followWorkspaceAgent call"));
  const listWorkspacePlanningDocuments = vi
    .fn<WorkspaceClient["listWorkspacePlanningDocuments"]>()
    .mockRejectedValue(new Error("Unexpected listWorkspacePlanningDocuments call"));
  const readWorkspacePlanningDocument = vi
    .fn<WorkspaceClient["readWorkspacePlanningDocument"]>()
    .mockRejectedValue(new Error("Unexpected readWorkspacePlanningDocument call"));
  const updateWorkspacePlanningDocument = vi
    .fn<WorkspaceClient["updateWorkspacePlanningDocument"]>()
    .mockRejectedValue(new Error("Unexpected updateWorkspacePlanningDocument call"));
  const listWorkspaceReviewThreads = vi
    .fn<WorkspaceClient["listWorkspaceReviewThreads"]>()
    .mockRejectedValue(new Error("Unexpected listWorkspaceReviewThreads call"));
  const createWorkspaceReviewThread = vi
    .fn<WorkspaceClient["createWorkspaceReviewThread"]>()
    .mockRejectedValue(new Error("Unexpected createWorkspaceReviewThread call"));
  const resolveWorkspaceReviewThread = vi
    .fn<WorkspaceClient["resolveWorkspaceReviewThread"]>()
    .mockRejectedValue(new Error("Unexpected resolveWorkspaceReviewThread call"));
  const previewWorkspaceJiraLink = vi
    .fn<WorkspaceClient["previewWorkspaceJiraLink"]>()
    .mockRejectedValue(new Error("Unexpected previewWorkspaceJiraLink call"));
  const confirmWorkspaceJiraLink = vi
    .fn<WorkspaceClient["confirmWorkspaceJiraLink"]>()
    .mockRejectedValue(new Error("Unexpected confirmWorkspaceJiraLink call"));
  const openWorkspaceJiraPreview = vi
    .fn<WorkspaceClient["openWorkspaceJiraPreview"]>()
    .mockRejectedValue(new Error("Unexpected openWorkspaceJiraPreview call"));
  const listWorkspaceWorkItemLinks = vi
    .fn<WorkspaceClient["listWorkspaceWorkItemLinks"]>()
    .mockResolvedValue({ schemaVersion: 1, workspaceId: "ws_01J_PERSISTED", links: [] });
  const unlinkWorkspaceWorkItem = vi
    .fn<WorkspaceClient["unlinkWorkspaceWorkItem"]>()
    .mockRejectedValue(new Error("Unexpected unlinkWorkspaceWorkItem call"));
  const openWorkspaceWorkItem = vi
    .fn<WorkspaceClient["openWorkspaceWorkItem"]>()
    .mockRejectedValue(new Error("Unexpected openWorkspaceWorkItem call"));
  const proposeWorkspaceJiraIssue = vi
    .fn<WorkspaceClient["proposeWorkspaceJiraIssue"]>()
    .mockRejectedValue(new Error("Unexpected proposeWorkspaceJiraIssue call"));
  const createWorkspace = vi.fn<WorkspaceClient["createWorkspace"]>();
  const getSetupSnapshot = vi
    .fn<WorkspaceClient["getSetupSnapshot"]>()
    .mockResolvedValue(options.setup ?? setupFixture());
  const listRepositories = vi
    .fn<WorkspaceClient["listRepositories"]>()
    .mockResolvedValue(options.repositories ?? repositoryCatalogFixture());
  const cloneRepository = vi
    .fn<WorkspaceClient["cloneRepository"]>()
    .mockRejectedValue(new Error("Unexpected cloneRepository call"));
  const refreshRepositoryBranches = vi
    .fn<WorkspaceClient["refreshRepositoryBranches"]>()
    .mockRejectedValue(
      new Error("Unexpected refreshRepositoryBranches call"),
    );
  const importCodeWorkspaceFile = vi
    .fn<WorkspaceClient["importCodeWorkspaceFile"]>()
    .mockRejectedValue(new Error("Unexpected importCodeWorkspaceFile call"));
  const analyzeWorkspaceRuntime = vi
    .fn<WorkspaceClient["analyzeWorkspaceRuntime"]>()
    .mockResolvedValue(options.runtimeAnalysis ?? runtimeAnalysisFixture());
  const preflightWorkspace = vi.fn<WorkspaceClient["preflightWorkspace"]>();
  const recoverWorkspaceSetup = vi.fn<WorkspaceClient["recoverWorkspaceSetup"]>().mockRejectedValue(new Error("Unexpected recoverWorkspaceSetup call"));
  const getWorkspaceMaterialization =
    vi.fn<WorkspaceClient["getWorkspaceMaterialization"]>();
  const getWorkspaceRepositoryDiff = vi
    .fn<WorkspaceClient["getWorkspaceRepositoryDiff"]>()
    .mockRejectedValue(new Error("Unexpected getWorkspaceRepositoryDiff call"));
  const getWorkspaceGitlabComparison = vi.fn<WorkspaceClient["getWorkspaceGitlabComparison"]>().mockRejectedValue(new Error("Unexpected getWorkspaceGitlabComparison call"));
  const preflightAgentWorkItemIntegration = vi.fn<NonNullable<WorkspaceClient["preflightAgentWorkItemIntegration"]>>().mockRejectedValue(new Error("This host cannot inspect integration."));
  const integrateAgentWorkItem = vi.fn<NonNullable<WorkspaceClient["integrateAgentWorkItem"]>>().mockRejectedValue(new Error("This host cannot integrate candidates."));
  const openAgentWorkItemPreview = vi.fn<NonNullable<WorkspaceClient["openAgentWorkItemPreview"]>>().mockRejectedValue(new Error("This host cannot open candidate previews."));
  const createAgentWorkSet = vi.fn<NonNullable<WorkspaceClient["createAgentWorkSet"]>>().mockRejectedValue(new Error("This host cannot complete this task plan."));
  const getAgentWorkSet = vi.fn<NonNullable<WorkspaceClient["getAgentWorkSet"]>>().mockRejectedValue(new Error("This host cannot complete this task plan."));
  const listAgentWorkSets = vi.fn<NonNullable<WorkspaceClient["listAgentWorkSets"]>>().mockRejectedValue(new Error("This host cannot complete this task plan."));
  const cancelAgentWorkItem = vi.fn<NonNullable<WorkspaceClient["cancelAgentWorkItem"]>>().mockRejectedValue(new Error("This host cannot complete this task plan."));
  const getAgentTurnDecisions = vi.fn<NonNullable<WorkspaceClient["getAgentTurnDecisions"]>>().mockRejectedValue(new Error("This host cannot read or save task decisions."));
  const recordAgentTurnDecision = vi.fn<NonNullable<WorkspaceClient["recordAgentTurnDecision"]>>().mockRejectedValue(new Error("This host cannot read or save task decisions."));
  const getAgentTurnChecks = vi.fn<NonNullable<WorkspaceClient["getAgentTurnChecks"]>>().mockRejectedValue(new Error("This host cannot complete this task action."));
  const runAgentTurnCheck = vi.fn<NonNullable<WorkspaceClient["runAgentTurnCheck"]>>().mockRejectedValue(new Error("This host cannot complete this task action."));
  const preflightAgentTurnRestore = vi.fn<NonNullable<WorkspaceClient["preflightAgentTurnRestore"]>>().mockRejectedValue(new Error("This host cannot complete this task action."));
  const restoreAgentTurn = vi.fn<NonNullable<WorkspaceClient["restoreAgentTurn"]>>().mockRejectedValue(new Error("This host cannot complete this task action."));
  const getAgentTurnChanges = vi.fn<NonNullable<WorkspaceClient["getAgentTurnChanges"]>>().mockRejectedValue(new Error("No recorded changes are available for this task."));
  const getWorkspaceRepositorySource = vi.fn<WorkspaceClient["getWorkspaceRepositorySource"]>().mockRejectedValue(new Error("Unexpected getWorkspaceRepositorySource call"));
  const saveWorkspaceRepositorySource = vi.fn<WorkspaceClient["saveWorkspaceRepositorySource"]>().mockRejectedValue(new Error("Unexpected saveWorkspaceRepositorySource call"));
  const getWorkspaceRepositoryFileReview = vi
    .fn<WorkspaceClient["getWorkspaceRepositoryFileReview"]>()
    .mockRejectedValue(
      new Error("Unexpected getWorkspaceRepositoryFileReview call"),
    );
  const getWorkspaceRepositoryReviewGraph = vi
    .fn<WorkspaceClient["getWorkspaceRepositoryReviewGraph"]>()
    .mockResolvedValue(options.repositoryReviewGraph ?? null);
  const syncWorkspaceRepository = vi
    .fn<WorkspaceClient["syncWorkspaceRepository"]>()
    .mockRejectedValue(new Error("Unexpected syncWorkspaceRepository call"));
  const preflightWorkspaceRepositoryAddition = vi
    .fn<WorkspaceClient["preflightWorkspaceRepositoryAddition"]>()
    .mockRejectedValue(
      new Error("Unexpected preflightWorkspaceRepositoryAddition call"),
    );
  const addWorkspaceRepository = vi
    .fn<WorkspaceClient["addWorkspaceRepository"]>()
    .mockRejectedValue(new Error("Unexpected addWorkspaceRepository call"));
  const removeWorkspaceRepository = vi
    .fn<WorkspaceClient["removeWorkspaceRepository"]>()
    .mockRejectedValue(new Error("Unexpected removeWorkspaceRepository call"));
  const preflightWorkspaceRepositoryAlignment = vi
    .fn<WorkspaceClient["preflightWorkspaceRepositoryAlignment"]>()
    .mockRejectedValue(
      new Error("Unexpected preflightWorkspaceRepositoryAlignment call"),
    );
  const alignWorkspaceRepository = vi
    .fn<WorkspaceClient["alignWorkspaceRepository"]>()
    .mockRejectedValue(new Error("Unexpected alignWorkspaceRepository call"));
  const materializeWorkspace =
    vi.fn<WorkspaceClient["materializeWorkspace"]>();
  const openWorkspaceInVscode =
    vi.fn<WorkspaceClient["openWorkspaceInVscode"]>();
  const openRepositoryBase = vi
    .fn<WorkspaceClient["openRepositoryBase"]>()
    .mockRejectedValue(new Error("Unexpected openRepositoryBase call"));
  const prepareWorkspaceChangeRequest = vi
    .fn<WorkspaceClient["prepareWorkspaceChangeRequest"]>()
    .mockRejectedValue(new Error("Unexpected prepareWorkspaceChangeRequest call"));
  const publishWorkspaceChangeRequestBranch = vi
    .fn<WorkspaceClient["publishWorkspaceChangeRequestBranch"]>()
    .mockRejectedValue(new Error("Unexpected publishWorkspaceChangeRequestBranch call"));
  const openWorkspaceChangeRequestDraft = vi
    .fn<WorkspaceClient["openWorkspaceChangeRequestDraft"]>()
    .mockRejectedValue(new Error("Unexpected openWorkspaceChangeRequestDraft call"));
  const openWorkspaceCli = vi
    .fn<WorkspaceClient["openWorkspaceCli"]>()
    .mockRejectedValue(
      new Error("Unexpected openWorkspaceCli call"),
    );
  const writeWorkspaceAgentBrief = vi
    .fn<WorkspaceClient["writeWorkspaceAgentBrief"]>()
    .mockRejectedValue(
      new Error("Unexpected writeWorkspaceAgentBrief call"),
    );
  const indexWorkspaceGraph = vi
    .fn<WorkspaceClient["indexWorkspaceGraph"]>()
    .mockRejectedValue(new Error("Unexpected indexWorkspaceGraph call"));
  const reindexWorkspaceGraph = vi
    .fn<WorkspaceClient["reindexWorkspaceGraph"]>()
    .mockRejectedValue(new Error("Unexpected reindexWorkspaceGraph call"));
  const preflightWorkspaceRemoval = vi
    .fn<WorkspaceClient["preflightWorkspaceRemoval"]>()
    .mockRejectedValue(new Error("Unexpected preflightWorkspaceRemoval call"));
  const removeWorkspace = vi
    .fn<WorkspaceClient["removeWorkspace"]>()
    .mockRejectedValue(new Error("Unexpected removeWorkspace call"));
  const runWorkspaceAgent = vi
    .fn<WorkspaceClient["runWorkspaceAgent"]>()
    .mockRejectedValue(new Error("Unexpected runWorkspaceAgent call"));
  const getWorkspaceEvidence = vi
    .fn<WorkspaceClient["getWorkspaceEvidence"]>()
    .mockResolvedValue(options.evidence ?? null);
  const runWorkspaceVerification = vi
    .fn<WorkspaceClient["runWorkspaceVerification"]>();
  const runWorkspaceCodeReview = vi
    .fn<NonNullable<WorkspaceClient["runWorkspaceCodeReview"]>>()
    .mockResolvedValue({
      workspaceId: "ws_01J_PERSISTED",
      provider: "codex",
      scope: "recentChanges",
      summary: "Review completed with 0 warnings.",
      findings: [],
      actionableSteps: [],
      reviewedAtUnixMs: 1_726_000_000_000,
    });
  const promoteAgentVerificationCheck = vi
    .fn<WorkspaceClient["promoteAgentVerificationCheck"]>()
    .mockRejectedValue(
      new Error("Unexpected promoteAgentVerificationCheck call"),
    );
  const listWorkspaceTestRuns = vi
    .fn<NonNullable<WorkspaceClient["listWorkspaceTestRuns"]>>()
    .mockResolvedValue(
      options.testRuns ?? {
        schemaVersion: 1,
        workspaceId: "ws_01J_PERSISTED",
        runs: [],
      },
    );
  const runWorkspaceTestJourney =
    vi.fn<NonNullable<WorkspaceClient["runWorkspaceTestJourney"]>>();
  const getWorkspaceTestRun =
    vi.fn<NonNullable<WorkspaceClient["getWorkspaceTestRun"]>>();
  const verifyJiraMcp = vi
    .fn<WorkspaceClient["verifyJiraMcp"]>()
    .mockRejectedValue(new Error("Unexpected verifyJiraMcp call"));
  const importJiraIssue = vi
    .fn<WorkspaceClient["importJiraIssue"]>()
    .mockRejectedValue(new Error("Unexpected importJiraIssue call"));
  const listActiveJiraIssues = vi
    .fn<WorkspaceClient["listActiveJiraIssues"]>()
    .mockResolvedValue(
      options.activeJiraIssues ?? {
        schemaVersion: 1,
        issues: [],
        detail: "No assigned active Jira issues.",
      },
    );
  const verifyOpenProject = vi
    .fn<WorkspaceClient["verifyOpenProject"]>()
    .mockRejectedValue(new Error("Unexpected verifyOpenProject call"));
  const importOpenProjectWorkPackage = vi
    .fn<WorkspaceClient["importOpenProjectWorkPackage"]>()
    .mockRejectedValue(
      new Error("Unexpected importOpenProjectWorkPackage call"),
    );
  const listAgentSessions = vi
    .fn<NonNullable<WorkspaceClient["listAgentSessions"]>>()
    .mockResolvedValue(
      options.agentSessions ?? { schemaVersion: 1, sessions: [] },
    );
  const getAgentSessionDetail = vi
    .fn<WorkspaceClient["getAgentSessionDetail"]>()
    .mockImplementation(async (sessionId) => {
      if (options.agentSessionDetail) return options.agentSessionDetail;
      throw new Error(`No detail fixture for ${sessionId}`);
    });
  const startAgentSessionPrototype = vi
    .fn<WorkspaceClient["startAgentSessionPrototype"]>()
    .mockRejectedValue(new Error("Unexpected startAgentSessionPrototype call"));
  const heartbeatAgentSession = vi
    .fn<WorkspaceClient["heartbeatAgentSession"]>()
    .mockRejectedValue(new Error("Unexpected heartbeatAgentSession call"));
  const completeAgentSession = vi
    .fn<WorkspaceClient["completeAgentSession"]>()
    .mockRejectedValue(new Error("Unexpected completeAgentSession call"));
  const failAgentSession = vi
    .fn<WorkspaceClient["failAgentSession"]>()
    .mockRejectedValue(new Error("Unexpected failAgentSession call"));
  const launchAgentSession = vi
    .fn<WorkspaceClient["launchAgentSession"]>()
    .mockRejectedValue(new Error("Unexpected launchAgentSession call"));
  const stopAgentSession = vi
    .fn<WorkspaceClient["stopAgentSession"]>()
    .mockRejectedValue(new Error("Unexpected stopAgentSession call"));
  const getActivityWatchStatus = vi
    .fn<NonNullable<WorkspaceClient["getActivityWatchStatus"]>>()
    .mockResolvedValue(
      options.activityWatchStatus ?? {
        state: "unavailable",
        installation: "unknown",
        endpoint: "http://127.0.0.1:5600",
        capabilities: ["status"],
        detail:
          "ActivityWatch was not detected. No activity data was requested.",
        diagnosticCode: "connectionFailed",
      },
    );
  const getActivityWatchDailyReview = vi
    .fn<NonNullable<WorkspaceClient["getActivityWatchDailyReview"]>>()
    .mockResolvedValue(
      options.activityWatchDailyReview ?? {
        schemaVersion: 1,
        startedAtUnixMs: 1_785_369_600_000,
        endedAtUnixMs: 1_785_456_000_000,
        totalActiveSeconds: 0,
        sessions: [],
        detail: "No activity was selected.",
      },
    );

  if (options.get) {
    getWorkspace.mockResolvedValue(options.get);
  } else {
    getWorkspace.mockRejectedValue(new Error("Unexpected getWorkspace call"));
  }

  if (options.create) {
    createWorkspace.mockResolvedValue(options.create);
  } else {
    createWorkspace.mockRejectedValue(
      new Error("Unexpected createWorkspace call"),
    );
  }

  if (options.preflight) {
    preflightWorkspace.mockResolvedValue(options.preflight);
  } else {
    preflightWorkspace.mockRejectedValue(
      new Error("Unexpected preflightWorkspace call"),
    );
  }
  if (options.codeWorkspaceImport) {
    importCodeWorkspaceFile.mockResolvedValue(options.codeWorkspaceImport);
  }
  if (options.repositoryClone) {
    cloneRepository.mockResolvedValue(options.repositoryClone);
  }
  if (options.repositoryRefresh) {
    refreshRepositoryBranches.mockResolvedValue(options.repositoryRefresh);
  }
  getWorkspaceMaterialization.mockResolvedValue(
    options.persistedMaterialization ?? null,
  );
  if (options.repositoryDiff) {
    getWorkspaceRepositoryDiff.mockResolvedValue(options.repositoryDiff);
  }
  if (options.repositoryFileReview) {
    getWorkspaceRepositoryFileReview.mockResolvedValue(
      options.repositoryFileReview,
    );
  }
  if (options.repositorySync) {
    syncWorkspaceRepository.mockResolvedValue(options.repositorySync);
  }
  if (options.repositoryAdditionPreflight) {
    preflightWorkspaceRepositoryAddition.mockResolvedValue(
      options.repositoryAdditionPreflight,
    );
  }
  if (options.repositoryAddition) {
    addWorkspaceRepository.mockResolvedValue(options.repositoryAddition);
  }
  if (options.repositoryRemoval) {
    removeWorkspaceRepository.mockResolvedValue(options.repositoryRemoval);
  }
  if (options.repositoryAlignmentPreflight) {
    preflightWorkspaceRepositoryAlignment.mockResolvedValue(
      options.repositoryAlignmentPreflight,
    );
  }
  if (options.repositoryAlignment) {
    alignWorkspaceRepository.mockResolvedValue(options.repositoryAlignment);
  }
  if (options.materialize) {
    materializeWorkspace.mockResolvedValue(options.materialize);
  } else {
    materializeWorkspace.mockRejectedValue(
      new Error("Unexpected materializeWorkspace call"),
    );
  }
  if (options.open) {
    openWorkspaceInVscode.mockResolvedValue(options.open);
  } else {
    openWorkspaceInVscode.mockRejectedValue(
      new Error("Unexpected openWorkspaceInVscode call"),
    );
  }
  if (options.repositoryBaseOpen) {
    openRepositoryBase.mockResolvedValue(options.repositoryBaseOpen);
  }
  if (options.changeRequestDraft) {
    prepareWorkspaceChangeRequest.mockResolvedValue(options.changeRequestDraft);
  }
  if (options.branchPublication) {
    publishWorkspaceChangeRequestBranch.mockResolvedValue(options.branchPublication);
  }
  if (options.changeRequestOpen) {
    openWorkspaceChangeRequestDraft.mockResolvedValue(options.changeRequestOpen);
  }
  if (options.reindex) {
    reindexWorkspaceGraph.mockResolvedValue(options.reindex);
  }
  if (options.removalPreflight) {
    preflightWorkspaceRemoval.mockResolvedValue(options.removalPreflight);
  }
  if (options.remove) {
    removeWorkspace.mockResolvedValue(options.remove);
  }
  if (options.verificationRun) {
    runWorkspaceVerification.mockResolvedValue(options.verificationRun);
  } else {
    runWorkspaceVerification.mockRejectedValue(
      new Error("Unexpected runWorkspaceVerification call"),
    );
  }
  if (options.testRun) {
    runWorkspaceTestJourney.mockResolvedValue(options.testRun);
  } else {
    runWorkspaceTestJourney.mockRejectedValue(
      new Error("Unexpected runWorkspaceTestJourney call"),
    );
  }
  if (options.testRunDetail) {
    getWorkspaceTestRun.mockResolvedValue(options.testRunDetail);
  } else {
    getWorkspaceTestRun.mockRejectedValue(
      new Error("Unexpected getWorkspaceTestRun call"),
    );
  }

  const client: WorkspaceClient = {
    getGithubReviewInbox,
    openGithubReview,
    getGitlabReviewInbox,
    getGitlabReviewPatch,
    publishGitlabReviewComment,
    getGitlabDiscussions,
    replyGitlabDiscussion,
    prepareGitlabReviewRepository,
    listWorkspaces,
    getWorkspace,
    renameWorkspace,
    transitionWorkspaceWorkflow,
    placeWorkspaceOnBoard,
    followWorkspaceAgent,
    listWorkspacePlanningDocuments,
    readWorkspacePlanningDocument,
    updateWorkspacePlanningDocument,
    listWorkspaceReviewThreads,
    createWorkspaceReviewThread,
    resolveWorkspaceReviewThread,
    previewWorkspaceJiraLink,
    confirmWorkspaceJiraLink,
    openWorkspaceJiraPreview,
    listWorkspaceWorkItemLinks,
    unlinkWorkspaceWorkItem,
    openWorkspaceWorkItem,
    proposeWorkspaceJiraIssue,
    createWorkspace,
    getSetupSnapshot,
    listRepositories,
    cloneRepository,
    refreshRepositoryBranches,
    importCodeWorkspaceFile,
    analyzeWorkspaceRuntime,
    preflightWorkspace,
    recoverWorkspaceSetup,
    getWorkspaceMaterialization,
    getWorkspaceRepositoryDiff,
    getWorkspaceRepositoryFileReview,
    getWorkspaceGitlabComparison,
    getAgentTurnChanges,
    getAgentTurnChecks,
    getAgentTurnDecisions,
    preflightAgentWorkItemIntegration,
    integrateAgentWorkItem,
    openAgentWorkItemPreview,
    createAgentWorkSet,
    getAgentWorkSet,
    listAgentWorkSets,
    cancelAgentWorkItem,
    recordAgentTurnDecision,
    runAgentTurnCheck,
    preflightAgentTurnRestore,
    restoreAgentTurn,
    getWorkspaceRepositorySource,
    saveWorkspaceRepositorySource,
    getWorkspaceRepositoryReviewGraph,
    syncWorkspaceRepository,
    preflightWorkspaceRepositoryAddition,
    addWorkspaceRepository,
    removeWorkspaceRepository,
    preflightWorkspaceRepositoryAlignment,
    alignWorkspaceRepository,
    materializeWorkspace,
    openWorkspaceInVscode,
    openRepositoryBase,
    getGitlabMergeRequests,
    openGitlabMergeRequest,
    getGitlabIntegrationStatus,
    getUpdateStatus,
    checkForUpdate,
    downloadAndInstallUpdate,
    relaunchUpdatedApp,
    prepareWorkspaceChangeRequest,
    publishWorkspaceChangeRequestBranch,
    openWorkspaceChangeRequestDraft,
    openWorkspaceCli,
    writeWorkspaceAgentBrief,
    indexWorkspaceGraph,
    reindexWorkspaceGraph,
    preflightWorkspaceRemoval,
    removeWorkspace,
    runWorkspaceAgent,
    getWorkspaceEvidence,
    promoteAgentVerificationCheck,
    runWorkspaceVerification,
    runWorkspaceCodeReview,
    listWorkspaceTestRuns,
    getWorkspaceTestRun,
    runWorkspaceTestJourney,
    verifyJiraMcp,
    listActiveJiraIssues,
    importJiraIssue,
    verifyOpenProject,
    importOpenProjectWorkPackage,
    listAgentSessions,
    getAgentSessionDetail,
    startAgentSessionPrototype,
    heartbeatAgentSession,
    completeAgentSession,
    failAgentSession,
    launchAgentSession,
    stopAgentSession,
    getActivityWatchStatus,
    getActivityWatchDailyReview,
  };

  return {
    client,
    getGithubReviewInbox,
    openGithubReview,
    getGitlabReviewInbox,
    getGitlabReviewPatch,
    publishGitlabReviewComment,
    getGitlabDiscussions,
    replyGitlabDiscussion,
    prepareGitlabReviewRepository,
    listWorkspaces,
    getWorkspace,
    renameWorkspace,
    transitionWorkspaceWorkflow,
    placeWorkspaceOnBoard,
    followWorkspaceAgent,
    listWorkspacePlanningDocuments,
    readWorkspacePlanningDocument,
    updateWorkspacePlanningDocument,
    listWorkspaceReviewThreads,
    createWorkspaceReviewThread,
    resolveWorkspaceReviewThread,
    previewWorkspaceJiraLink,
    confirmWorkspaceJiraLink,
    openWorkspaceJiraPreview,
    listWorkspaceWorkItemLinks,
    unlinkWorkspaceWorkItem,
    openWorkspaceWorkItem,
    proposeWorkspaceJiraIssue,
    createWorkspace,
    getSetupSnapshot,
    listRepositories,
    cloneRepository,
    refreshRepositoryBranches,
    importCodeWorkspaceFile,
    analyzeWorkspaceRuntime,
    preflightWorkspace,
    recoverWorkspaceSetup,
    getWorkspaceMaterialization,
    getWorkspaceRepositoryDiff,
    getWorkspaceRepositoryFileReview,
    getWorkspaceGitlabComparison,
    getAgentTurnChanges,
    getAgentTurnChecks,
    getAgentTurnDecisions,
    preflightAgentWorkItemIntegration,
    integrateAgentWorkItem,
    openAgentWorkItemPreview,
    createAgentWorkSet,
    getAgentWorkSet,
    listAgentWorkSets,
    cancelAgentWorkItem,
    recordAgentTurnDecision,
    runAgentTurnCheck,
    preflightAgentTurnRestore,
    restoreAgentTurn,
    getWorkspaceRepositorySource,
    saveWorkspaceRepositorySource,
    getWorkspaceRepositoryReviewGraph,
    syncWorkspaceRepository,
    preflightWorkspaceRepositoryAddition,
    addWorkspaceRepository,
    removeWorkspaceRepository,
    preflightWorkspaceRepositoryAlignment,
    alignWorkspaceRepository,
    materializeWorkspace,
    openWorkspaceInVscode,
    openRepositoryBase,
    getGitlabMergeRequests,
    openGitlabMergeRequest,
    getGitlabIntegrationStatus,
    getUpdateStatus,
    checkForUpdate,
    downloadAndInstallUpdate,
    relaunchUpdatedApp,
    prepareWorkspaceChangeRequest,
    publishWorkspaceChangeRequestBranch,
    openWorkspaceChangeRequestDraft,
    openWorkspaceCli,
    writeWorkspaceAgentBrief,
    indexWorkspaceGraph,
    reindexWorkspaceGraph,
    preflightWorkspaceRemoval,
    removeWorkspace,
    runWorkspaceAgent,
    getWorkspaceEvidence,
    promoteAgentVerificationCheck,
    runWorkspaceVerification,
    runWorkspaceCodeReview,
    listWorkspaceTestRuns,
    getWorkspaceTestRun,
    runWorkspaceTestJourney,
    verifyJiraMcp,
    listActiveJiraIssues,
    importJiraIssue,
    verifyOpenProject,
    importOpenProjectWorkPackage,
    listAgentSessions,
    getAgentSessionDetail,
    startAgentSessionPrototype,
    heartbeatAgentSession,
    completeAgentSession,
    failAgentSession,
    launchAgentSession,
    stopAgentSession,
    getActivityWatchStatus,
    getActivityWatchDailyReview,
  };
}

export function setupFixture(): SetupSnapshot {
  return {
    checkedAtUnixMs: 1_721_776_400_000,
    repositoryCount: 1,
    integrations: [
      {
        id: "git",
        category: "sourceControl",
        status: "ready",
        installation: "detected",
        setup: "notRequired",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "version",
        capabilities: ["worktreeMaterialization"],
        version: "2.49.0",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: [],
      },
      {
        id: "vscode",
        category: "editor",
        status: "ready",
        installation: "detected",
        setup: "notRequired",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "version",
        capabilities: ["workspaceLaunch"],
        version: "1.125.0",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: [],
      },
      {
        id: "warp",
        category: "terminal",
        status: "notFound",
        installation: "missing",
        setup: "needsDependency",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "configurationSignal",
        capabilities: ["terminalSession"],
        detail: "Warp.app was not found in an Applications folder.",
        diagnosticCode: "executableMissing",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: ["warpLaunch"],
      },
      ...(["codex", "openCode", "hermes"] as const).map((id) => ({
        id,
        category: "agent" as const,
        status: "notConfigured" as const,
        installation: "detected" as const,
        setup: "unverified" as const,
        runtime: "idle" as const,
        wtsSupport: "available" as const,
        verificationKind: "version" as const,
        capabilities: ["agentSession" as const],
        lastProbeAt: 1_721_776_400_000,
        blockingFor: [],
      })),
      {
        id: "graphify",
        category: "knowledgeGraph",
        status: "ready",
        installation: "detected",
        setup: "notRequired",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "version",
        capabilities: ["graphIndexing"],
        version: "0.8.42",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: [],
      },
      {
        id: "jiraMcp",
        category: "issueTracker",
        status: "notConfigured",
        installation: "missing",
        setup: "needsDependency",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "configurationSignal",
        capabilities: ["jiraIssueImport"],
        lastProbeAt: 1_721_776_400_000,
        blockingFor: ["jiraIssueImport"],
      },
      {
        id: "openProject",
        category: "issueTracker",
        status: "notConfigured",
        installation: "missing",
        setup: "needsDependency",
        runtime: "idle",
        wtsSupport: "available",
        verificationKind: "configurationSignal",
        capabilities: ["openProjectWorkPackageImport"],
        diagnosticCode: "openProjectEndpointNotConfigured",
        lastProbeAt: 1_721_776_400_000,
        blockingFor: ["openProjectWorkPackageImport"],
      },
    ],
  };
}

export function repositoryCatalogFixture(): RepositoryCatalog {
  return {
    repositoryRootDisplayPath: "~/cd",
    repositories: [
      {
        id: "repo_checkout",
        label: "checkout-api",
        checkoutLeaf: "checkout-api",
        displayPath: "~/cd/checkout-api",
        defaultBranch: {
          name: "main",
          fullRef: "refs/heads/main",
          commitOid: "0123456789abcdef0123456789abcdef01234567",
        },
        availableBranches: [
          {
            name: "main",
            fullRef: "refs/heads/main",
            commitOid: "0123456789abcdef0123456789abcdef01234567",
            remote: false,
          },
          {
            name: "develop",
            fullRef: "refs/remotes/origin/develop",
            commitOid: "1123456789abcdef0123456789abcdef01234567",
            remote: true,
          },
          {
            name: "release/2026.07",
            fullRef: "refs/remotes/origin/release/2026.07",
            commitOid: "2123456789abcdef0123456789abcdef01234567",
            remote: true,
          },
        ],
      },
    ],
    skippedEntries: 0,
  };
}

export function workspaceEvidenceFixture(
  overrides: Partial<WorkspaceEvidence> = {},
): WorkspaceEvidence {
  const context: WorkspaceEvidence["context"] = {
    schemaVersion: 1,
    workspaceId: "ws_01J_PERSISTED",
    workspaceRecordVersion: 1,
    title: "Checkout retries create duplicate captures",
    intent: { type: "jira", issueKey: "PLATFORM-42" },
    preferredProvider: "codex",
    branchName: "wts/platform-42-durable",
    workspaceDisplayPath: "~/cd/platform-42-7fd1",
    codeWorkspaceDisplayPath: "~/cd/platform-42-7fd1/wts.code-workspace",
    evidenceDisplayPath: "~/cd/platform-42-7fd1/.wts",
    createdAtUnixMs: 1_721_776_400_000,
    wtsVersion: "0.1.0",
    repositories: [
      {
        repositoryId: "repo_checkout",
        label: "checkout-api",
        requestedBaseRef: "main",
        resolvedBaseRef: "refs/heads/main",
        baseCommitOid: "0123456789abcdef0123456789abcdef01234567",
        worktreeDisplayPath: "~/cd/platform-42-7fd1/checkout-api",
      },
    ],
    allowedRepositoryIds: ["repo_checkout"],
  };
  return {
    context,
    graphManifest: {
      schemaVersion: 1,
      workspaceId: context.workspaceId,
      status: "ready",
      graphDisplayPath: "~/cd/platform-42-7fd1/graphify-out/graph.json",
      graphSha256: "sha256:graph",
      indexedAtUnixMs: 1_721_776_410_000,
      indexedRepositories: [
        {
          repositoryId: "repo_checkout",
          commitOid: context.repositories[0]!.baseCommitOid,
        },
      ],
      detail: "Workspace graph contains checkout-api.",
    },
    verificationPlan: {
      schemaVersion: 1,
      workspaceId: context.workspaceId,
      revision: 1,
      updatedAtUnixMs: 1_721_776_420_000,
      checks: [
        {
          id: "checkout-unit",
          label: "Checkout unit tests",
          kind: "unit",
          repositoryId: "repo_checkout",
          workingDirectory: "checkout-api",
          executable: "cargo",
          args: ["test"],
          timeoutMs: 120_000,
          outputLimitBytes: 65_536,
          required: true,
          environmentNames: [],
          acceptanceFiles: [
            {
              displayPath: "tests/wts_checkout.rs",
              sha256: "sha256:acceptance",
            },
          ],
        },
      ],
    },
    verificationResult: {
      schemaVersion: 1,
      workspaceId: context.workspaceId,
      planRevision: 1,
      status: "failed",
      startedAtUnixMs: 1_721_776_430_000,
      completedAtUnixMs: 1_721_776_431_250,
      durationMs: 1_250,
      checks: [
        {
          checkId: "checkout-unit",
          status: "failed",
          startedAtUnixMs: 1_721_776_430_000,
          completedAtUnixMs: 1_721_776_431_250,
          durationMs: 1_250,
          exitCode: 101,
          logDisplayPath: "~/cd/platform-42-7fd1/.wts/logs/checkout-unit.log",
          detail: "Expected one capture, received two.",
        },
      ],
      warnings: [],
    },
    agentReport: {
      schemaVersion: 1,
      workspaceId: context.workspaceId,
      status: "notReported",
      displayPath: `${context.evidenceDisplayPath}/agent-report.json`,
      updatedAtUnixMs: null,
      summary: "",
      findings: [],
      nextActions: [],
      proposedChecks: [],
      validationFlows: [],
      scope: {
        coverage: "unassessed",
        graphStatus: "notStarted",
        reviewedRepositoryIds: [],
        unresolvedRepositoryIds: [],
        skippedRepositories: [],
      },
      environment: {
        status: "unassessed",
        summary: "",
        requirements: [],
        setupSteps: [],
        unresolved: [],
      },
      flows: [],
      detail: "No agent report has been published.",
    },
    agentRuns: [],
    ...overrides,
  };
}
