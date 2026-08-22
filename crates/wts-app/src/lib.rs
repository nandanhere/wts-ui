//! Trusted orchestration for the local WTS application.
//!
//! Browser and WebView callers identify only stored workspace records. This
//! layer owns repository roots, source paths, worktree targets, branch names,
//! generated files, and external command arguments.

mod adapter;
mod agent_observation;
mod agent_session_details;
mod agent_sessions;
mod code_workspace;
mod collaboration;
mod copilot_observation;
mod evidence;
mod launcher;
mod model;
mod process;
mod runtime;
mod runtime_analysis;
mod service;
mod testing;
mod time_review;
mod verification;

pub use adapter::{AdapterFailure, ProcessCollaborationAdapter, ProcessWorkspaceAdapter};
pub use agent_observation::{
    AGENT_OBSERVATION_SCHEMA_VERSION, AgentNeedsInput, AgentNeedsInputKind,
    AgentObservationActivity, AgentObservationSource, AgentObservationStatus,
    AgentObservationUpdateKind, ObservedAgentProvider, ObservedAgentSession,
};
pub use agent_session_details::{
    AGENT_SESSION_DETAIL_SCHEMA_VERSION, AgentModelAuthority, AgentModelSelection,
    AgentProcessEvent, AgentProcessEventKind, AgentSessionDetail, AgentSessionEvent,
    AgentSessionEventKind,
};
pub use agent_sessions::{
    AGENT_SESSION_SCHEMA_VERSION, AgentChangeRequestProposal, AgentChangeRequestVerification,
    AgentChangeRequestVerificationStatus, AgentSession, AgentSessionCategory, AgentSessionFailure,
    AgentSessionList, AgentSessionStatus,
};
pub use collaboration::{
    CollaborationAdapter, CollaborationAdapterFailure, CollaborationAdapterOutcome,
    CollaborationConfigError, CollaborationConfinement, CollaborationControl,
    CollaborationCoordinator, CollaborationInvocation, CollaborationLimits, CollaborationPlan,
    CollaborationPlanError, CollaborationReport, CollaborationStopReason, CollaborationTask,
    CollaborationTaskEvidence, CollaborationTaskId, CollaborationTaskIdError,
    CollaborationTaskResult, CollaborationTaskState,
};
pub use evidence::{
    AcceptanceFileDigest, AgentEnvironmentPlan, AgentEnvironmentRequirement,
    AgentEnvironmentRequirementKind, AgentEnvironmentRequirementSource, AgentEnvironmentSetupStep,
    AgentEnvironmentStatus, AgentFinding, AgentFindingSeverity, AgentFlow, AgentFlowEvidence,
    AgentFlowKind, AgentFlowStep, AgentProposedCheck, AgentReportCoverage, AgentReportPublishError,
    AgentReportScope, AgentReportStatus, AgentRunFailure, AgentRunState, AgentRunSummary,
    AgentSkippedRepository, AgentValidationFlow, AgentValidationStep, EvidenceRepository,
    GraphIndexedRepository, MAX_AGENT_REPORT_BYTES, VerificationCheck, VerificationCheckKind,
    VerificationCheckResult, VerificationCheckStatus, VerificationStatus,
    WORKSPACE_EVIDENCE_SCHEMA_VERSION, WorkspaceAgentReport, WorkspaceEvidence,
    WorkspaceEvidenceContext, WorkspaceGraphEvidenceStatus, WorkspaceGraphManifest,
    WorkspaceVerificationPlan, WorkspaceVerificationResult, publish_agent_report,
};
pub use launcher::{
    ChangeRequestDraftTarget, ExternalLauncher, GithubReviewTarget, GitlabMergeRequestTarget,
    JiraIssueTarget, LaunchFailure, ProcessExternalLauncher, RepositoryBaseTarget,
};
pub use model::{
    AgentProvider, AgentRunResult, ChangeRequestCommit, ChangeRequestWorkItem,
    CloneRepositoryRequest, CloneRepositoryResult, CodeWorkspaceCatalogDiagnostics,
    CodeWorkspaceFolderDiagnostics, CodeWorkspaceFolderImport, CodeWorkspaceFolderStatus,
    CodeWorkspaceImportDiagnostics, CodeWorkspaceImportRequest, CodeWorkspaceImportResult,
    CodeWorkspaceImportWarning, CodeWorkspaceImportWarningCode, CodeWorkspaceMatchAttempt,
    CodeWorkspaceMatchCandidate, CodeWorkspaceResolutionBasis, CodeWorkspaceResolutionReason,
    ConfirmWorkspaceJiraLinkRequest, ConfirmWorkspaceWorkItemLinkResult,
    CreateWorkspaceReviewThreadRequest, GraphIndexResult, GraphWorkspaceStatus,
    GraphWorkspaceSummary, JiraCreateProposal, JiraIssueImport, MAX_PLANNING_DOCUMENT_BYTES,
    MaterializeWorkspaceResult, MaterializedGitState, MaterializedWorktree,
    MaterializedWorktreeActivity, OpenGithubReviewResult, OpenProjectWorkPackageImport,
    OpenRepositoryBaseResult, OpenWorkspaceChangeRequestDraft, OpenWorkspaceChangeRequestResult,
    OpenWorkspaceGitlabMergeRequestResult, OpenWorkspaceJiraPreviewRequest, OpenWorkspaceResult,
    OpenWorkspaceWorkItemRequest, OpenWorkspaceWorkItemResult, PreflightBlocker,
    PreflightBlockerCode, PreflightRepository, PrepareWorkspaceChangeRequest,
    PreviewWorkspaceJiraLinkRequest, RefreshRepositoryBranchesRequest,
    RefreshRepositoryBranchesResult, RemovalBlocker, RemovalBlockerCode,
    RemovalProtectedFilePreview, RemovalProtectedPath, RemovalWorktreeSummary,
    RemoveWorkspaceResult, RepositoryAvailableBranch, RepositoryBranchSummary, RepositoryCatalog,
    RepositoryForge, RepositoryRecommendation, RepositoryRecommendationSource, RepositorySummary,
    ResolveWorkspaceReviewThreadRequest, ReviewAnchorState, ReviewAuthor, ReviewCodeSide,
    ReviewComment, ReviewTarget, ReviewThreadState, TerminalProvider,
    UnlinkWorkspaceWorkItemRequest, UpdateWorkspacePlanningDocumentRequest,
    WorkspaceAgentBriefResult, WorkspaceChangeRequestDraft, WorkspaceCliLaunchResult,
    WorkspaceMaterialization, WorkspacePlanningDocument, WorkspacePlanningDocumentDescriptor,
    WorkspacePlanningDocumentId, WorkspacePlanningDocumentList, WorkspacePreflight,
    WorkspaceRemovalKind, WorkspaceRemovalPreflight, WorkspaceRepositoryAlignmentPreflight,
    WorkspaceRepositoryAlignmentResult, WorkspaceRepositoryDiff, WorkspaceRepositoryFileReview,
    WorkspaceRepositoryReviewGraph, WorkspaceRepositoryReviewLink, WorkspaceRepositoryReviewNode,
    WorkspaceRepositorySyncResult, WorkspaceReviewThread, WorkspaceReviewThreadList,
    WorkspaceWorkItemLink, WorkspaceWorkItemLinkList, WorkspaceWorkItemLinkPreview,
    WorkspaceWorkItemProvider, WorkspaceWorkItemRole, WorkspaceWorkItemSnapshot,
    WorkspaceWorkItemUnlinkResult,
};
pub use runtime::{
    RuntimeEndpoint, RuntimeError, RuntimeHealthCheck, RuntimeLimits, RuntimeServiceRequest,
    RuntimeServiceSnapshot, RuntimeServiceState, RuntimeStackKey, RuntimeStackRequest,
    RuntimeStackSnapshot, RuntimeStackState, RuntimeSupervisor,
};
pub use runtime_analysis::{
    RuntimeAnalysisError, RuntimeAnalysisRequest, RuntimeAnalysisResult, RuntimeAnalyzedRepository,
    RuntimeConfidence, RuntimeEvidence, RuntimeGraphAnalysis, RuntimeGraphStatus,
    RuntimePortCandidate, RuntimeServiceCandidate,
};
pub use service::{LocalWtsError, LocalWtsService};
pub use testing::{
    ArtifactKind, ArtifactMetadata, BrowserJourneyAdapter, BrowserJourneyFailure,
    ConsoleErrorSummary, FailureCapsule, JourneyAction, JourneyKey, JourneyPlan, JourneyPlanError,
    JourneyStep, JourneyTarget, ProcessBrowserJourneyAdapter, RequestSummary,
    TEST_RUN_SCHEMA_VERSION, TestArtifactRetention, TestArtifactStore, TestArtifactStoreError,
    TestRunList, TestRunManifest, TestRunResult, TestRunState, TestRunSummary, TestStepResult,
    TestStepState,
};
pub use time_review::{
    MAX_SANITIZED_ATTENTION_INTERVALS, SANITIZED_ATTENTION_SCHEMA_VERSION,
    SanitizedAttentionInterval, TIME_REVIEW_SCHEMA_VERSION, TimeAttribution, TimeReviewDraft,
    TimeReviewError, TimeReviewGroup, TimeReviewSchedule, TimeReviewScheduleState,
    TimeReviewSegment, build_time_review_draft, time_review_schedule_state,
};
pub use wts_integrations::{
    GithubReview, GithubReviewDiagnosticCode, GithubReviewInbox, GithubReviewInboxState,
    GitlabMergeRequest, GitlabMergeRequestDiagnosticCode, GitlabMergeRequestInbox,
    GitlabMergeRequestInboxState, GitlabMergeRequestStatus, GitlabReview,
    GitlabReviewCommentRequest, GitlabReviewCommit, GitlabReviewDiscussion,
    GitlabReviewDiscussionComment, GitlabReviewInbox, GitlabReviewPatch, GitlabReviewState,
    PublishGitlabReviewCommentResult,
};
