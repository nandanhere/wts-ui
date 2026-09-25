use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, FromRequest, Path as AxumPath, Query, Request, State,
        rejection::JsonRejection,
    },
    http::{
        HeaderMap, HeaderValue, Method, StatusCode,
        header::{CACHE_CONTROL, HOST, ORIGIN, RETRY_AFTER},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use rand::RngCore;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::BTreeSet,
    env,
    error::Error,
    ffi::OsStr,
    fmt,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
};
use subtle::ConstantTimeEq;
use thiserror::Error;
use tokio::{
    net::TcpListener,
    sync::{OwnedSemaphorePermit, Semaphore},
};
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;
use uuid::Uuid;
use wts_app::{
    AgentModelCatalog, AgentProvider, AgentRunResult, AgentSession, AgentSessionCategory, AgentSessionDetail,
    AgentSessionFailure, AgentSessionList, CloneRepositoryRequest, CloneRepositoryResult,
    CodeReviewOptions, CodeReviewScope, CodeWorkspaceImportRequest, CodeWorkspaceImportResult,
    ConfirmWorkspaceJiraLinkRequest, ConfirmWorkspaceWorkItemLinkResult,
    CreateWorkspaceReviewThreadRequest, GraphIndexResult, JiraCreateProposal, JiraIssueImport,
    LocalWtsError, LocalWtsService, MAX_PLANNING_DOCUMENT_BYTES, MaterializeWorkspaceResult,
    OpenGithubReviewResult, OpenProjectWorkPackageImport, OpenRepositoryBaseResult,
    OpenWorkspaceChangeRequestDraft, OpenWorkspaceChangeRequestResult,
    OpenWorkspaceGitlabMergeRequestResult, OpenWorkspaceJiraPreviewRequest, OpenWorkspaceResult,
    OpenWorkspaceWorkItemRequest, OpenWorkspaceWorkItemResult, PrepareWorkspaceChangeRequest,
    PreviewWorkspaceJiraLinkRequest, PublishWorkspaceChangeRequestBranch,
    RefreshRepositoryBranchesRequest, RefreshRepositoryBranchesResult, RemoveWorkspaceResult,
    RepositoryCatalog, ResolveWorkspaceReviewThreadRequest, RunWorkspaceCodeReviewRequest,
    RuntimeAnalysisRequest, RuntimeAnalysisResult, TerminalProvider, TestRunList, TestRunResult,
    TestRunSummary, UnlinkWorkspaceWorkItemRequest, UpdateWorkspacePlanningDocumentRequest,
    WorkspaceBranchPublicationResult, WorkspaceChangeRequestDraft, WorkspaceCliLaunchResult,
    WorkspaceCodeReviewResult, WorkspaceEvidence, WorkspaceMaterialization, WorkspaceVerificationSummary,
    WorkspacePlanningDocument, WorkspacePlanningDocumentId, WorkspacePlanningDocumentList,
    WorkspacePreflight, WorkspaceRemovalPreflight, WorkspaceRepositoryAdditionPreflight,
    WorkspaceRepositoryAdditionResult, WorkspaceRepositoryAlignmentPreflight,
    WorkspaceRepositoryAlignmentResult, WorkspaceRepositoryDiff, WorkspaceRepositoryFileReview,
    WorkspaceRepositoryRemovalResult, WorkspaceRepositoryReviewGraph,
    WorkspaceRepositorySyncResult, WorkspaceReviewThread, WorkspaceReviewThreadList,
    WorkspaceWorkItemLinkList, WorkspaceWorkItemLinkPreview, WorkspaceWorkItemUnlinkResult,
};
use wts_core::{
    BoundaryCompiler, BoundaryDraft, RepositoryPin, ServiceSpec, WorkspaceBoundary,
    workspace::{
        AddWorkspaceRepositoryRequest, CreateWorkspaceRequest, FollowWorkspaceAgentRequest,
        PlaceWorkspaceOnBoardRequest, RenameWorkspaceRequest, TransitionWorkspaceWorkflowRequest,
    },
};
use wts_integrations::{
    ActivityWatchConnector, ActivityWatchDailyReview, ActivityWatchError, ActivityWatchReviewError,
    ActivityWatchStatus, GithubReviewInbox, GitlabIntegrationStatus, JiraActiveIssueList,
    JiraMcpError, JiraMcpVerification, OpenProjectError, OpenProjectVerification, SetupSnapshot,
    TimeReviewAgentBrief,
};
use wts_store::{
    WorkspaceList, WorkspaceService, WorkspaceStoreError, WorkspaceView, WorkspaceWorkflowSummary,
};

pub const DEFAULT_ADDRESS: &str = "127.0.0.1:3000";
const API_BODY_LIMIT_BYTES: usize = 64 * 1024;
// JSON string escaping can nearly double a valid 48 KiB workspace file.
// Keep the larger allowance scoped to the import route; the app service still
// enforces the exact decoded-content limit.
const CODE_WORKSPACE_IMPORT_BODY_LIMIT_BYTES: usize = 128 * 1024;
const PLANNING_DOCUMENT_BODY_LIMIT_BYTES: usize = MAX_PLANNING_DOCUMENT_BYTES * 2 + 1024;
const DEFAULT_WORKSPACE_ROOT_ID: &str = "default";
const SESSION_HEADER: &str = "x-wts-session";
const REQUEST_HEADER: &str = "x-wts-request";
const REQUEST_MARKER: &str = "local-ui";
const IDEMPOTENCY_HEADER: &str = "idempotency-key";
// Initial laptop-oriented admission defaults, chosen from the 30-workspace
// profile. They are implementation tuning values rather than API guarantees.
const DEFAULT_READ_OPERATION_LIMIT: usize = 16;
const DEFAULT_SCAN_OPERATION_LIMIT: usize = 4;
const DEFAULT_HEAVY_OPERATION_LIMIT: usize = 4;
// Remote reads wait on GitLab or GitHub, not on local disk. One review view
// starts several of them at once, so they get their own lane and queue briefly.
const DEFAULT_REMOTE_READ_OPERATION_LIMIT: usize = 8;
const REMOTE_READ_ADMISSION_WAIT: std::time::Duration = std::time::Duration::from_secs(20);
const OVERLOAD_RETRY_AFTER_SECONDS: &str = "1";

pub type ServerResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Clone)]
pub struct ServerPaths {
    pub data_dir: PathBuf,
    pub workspace_root: PathBuf,
    pub repository_roots: Vec<PathBuf>,
}

#[derive(Debug, Error)]
pub enum StartupError {
    #[error("WTS_ADDR must be a valid socket address")]
    InvalidAddress,
    #[error("WTS only accepts loopback listen addresses")]
    NonLoopbackAddress,
    #[error("{0} must be an absolute path")]
    RelativePath(&'static str),
    #[error("the local user home directory is unavailable")]
    MissingHome,
    #[error("the WTS session token could not be generated")]
    SessionToken,
}

#[derive(Clone)]
pub struct SecurityPolicy {
    authority: Arc<str>,
    origin: Arc<str>,
    session_token: Arc<str>,
}

impl fmt::Debug for SecurityPolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SecurityPolicy")
            .field("authority", &self.authority)
            .field("origin", &self.origin)
            .field("session_token", &"[redacted]")
            .finish()
    }
}

impl SecurityPolicy {
    pub fn generate(bound_address: SocketAddr) -> Result<Self, StartupError> {
        let mut bytes = [0_u8; 32];
        rand::rngs::OsRng
            .try_fill_bytes(&mut bytes)
            .map_err(|_| StartupError::SessionToken)?;
        Self::with_session_token(bound_address, hex::encode(bytes))
    }

    pub fn with_session_token(
        bound_address: SocketAddr,
        session_token: impl Into<String>,
    ) -> Result<Self, StartupError> {
        if !bound_address.ip().is_loopback() {
            return Err(StartupError::NonLoopbackAddress);
        }

        let authority: Arc<str> = bound_address.to_string().into();
        let origin: Arc<str> = format!("http://{authority}").into();
        let session_token = session_token.into();
        if session_token.len() < 32
            || !session_token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(StartupError::SessionToken);
        }

        Ok(Self {
            authority,
            origin,
            session_token: session_token.into(),
        })
    }

    pub fn authority(&self) -> &str {
        &self.authority
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    fn session_token(&self) -> &str {
        &self.session_token
    }

    fn matches_session(&self, candidate: &str) -> bool {
        candidate.len() == self.session_token.len()
            && bool::from(candidate.as_bytes().ct_eq(self.session_token.as_bytes()))
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    status: &'static str,
    service: &'static str,
    version: &'static str,
    ui_available: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    api_version: &'static str,
    origin: String,
    session_token: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOutcome<W> {
    pub workspace: W,
    pub replayed: bool,
}

#[derive(Debug)]
pub enum RegistryFailure {
    Validation(String),
    Conflict,
    RepositoryCatalogUnavailable,
    RepositoryNotFound,
    RepositoryChanged,
    InvalidRepositoryBase,
    RepositoryBaseNotFound,
    InvalidRuntimeAnalysisRequest,
    RuntimeAnalysisUnavailable,
    StaleRuntimeAnalysis,
    InvalidRuntimeSelection,
    NotFound,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MvpFailure {
    InvalidLocalConfiguration,
    RepositoryCatalogUnavailable,
    InvalidRepositoryRemote,
    RepositoryCloneConflict,
    RepositoryCloneBranchUnavailable,
    RepositoryCloneFailed,
    RepositoryFetchFailed,
    RepositoryNotFound,
    InvalidRepositoryFilePath,
    RepositoryFileUnavailable,
    RepositoryFileNotText,
    RepositoryFileTooLarge,
    RepositoryFileConflict,
    InvalidRepositoryFileRevision,
    GitlabComparisonUnavailable,
    GitlabMergeRequestLinkUnavailable,
    RepositoryChanged,
    RepositorySyncBlocked,
    RepositorySyncDiverged,
    RepositorySyncFailed,
    RepositorySyncBusy,
    RepositoryAlreadyInWorkspace,
    RepositoryAdditionStale,
    RepositoryAdditionFailed,
    RepositoryAdditionCleanupIncomplete,
    RepositoryRemovalBlocked,
    RepositoryRemovalFailed,
    RepositoryAlignmentStale,
    RepositoryAlignmentFailed,
    InvalidRepositoryBase,
    RepositoryBaseNotFound,
    RepositoryForgeUnsupported,
    GitlabReviewCommentFailed,
    GitlabDiscussionsUnavailable,
    GitlabDiscussionReplyFailed,
    ChangeRequestBranchNotPublished,
    ChangeRequestBranchPublishFailed,
    InvalidChangeRequestBranchName,
    ChangeRequestBranchAuthenticationFailed,
    ChangeRequestBranchNetworkFailed,
    ChangeRequestBranchRejected,
    ChangeRequestRemoteMismatch,
    ChangeRequestWorktreeDirty,
    ChangeRequestForkUnsupported,
    ChangeRequestAgentProposalUnavailable,
    ChangeRequestAgentProposalInvalid,
    InvalidChangeRequestDraft,
    StaleChangeRequestDraft,
    BrowserUnavailable,
    BrowserLaunchRejected,
    JiraBrowserUrlUnavailable,
    InvalidCodeWorkspaceImport,
    CodeWorkspaceImportTooLarge,
    InvalidRuntimeAnalysisRequest,
    RuntimeAnalysisUnavailable,
    StaleRuntimeAnalysis,
    InvalidRuntimeSelection,
    WorkspaceNotFound,
    WorkspaceWorkflowConflict,
    InvalidWorkspaceBoardPlacement,
    PlanningNotConfigured,
    PlanningDocumentUnavailable,
    InvalidPlanningDocument,
    PlanningDocumentTooLarge,
    PlanningDocumentConflict,
    InvalidReviewThread,
    ReviewCommentTooLarge,
    ReviewThreadNotFound,
    ReviewThreadConflict,
    InvalidWorkItemLink,
    StaleWorkItemLinkPreview,
    WorkItemLinkIdempotencyConflict,
    WorkItemLinkAlreadyExists,
    PrimaryWorkItemLinkAlreadyExists,
    WorkItemLinkNotFound,
    WorkItemLinkConflict,
    PreflightBlocked,
    StalePreflight,
    MaterializationFailed,
    MaterializationCleanupIncomplete,
    GeneratedWorkspaceFailed,
    GeneratedWorkspaceCleanupIncomplete,
    WorkspaceNotMaterialized,
    InvalidMaterializationManifest,
    WorkspaceGitStateChanged,
    WorkspaceEvidenceUnavailable,
    InvalidWorkspaceEvidence,
    InvalidTestJourney,
    TestRunnerUnavailable,
    TestRunnerFailed,
    TestRunnerBusy,
    TestRunnerTimedOut,
    TestRunnerOutputTooLarge,
    TestEvidenceUnavailable,
    TestRunNotFound,
    InvalidTestEvidence,
    VscodeUnavailable,
    VscodeLaunchRejected,
    AdapterUnavailable,
    AdapterRejected,
    AdapterTimedOut,
    AdapterOutputTooLarge,
    GraphIndexFailed,
    GraphRequired,
    WorkspaceRemovalBlocked,
    WorkspaceRemovalFailed,
    IdempotencyConflict,
    InvalidAgentConversation,
    AgentConversationNotFound,
    AgentConversationConflict,
    AgentConversationBusy,
    AgentConversationQueueFull,
    AgentConversationUnavailable,
    AgentConversationSourceUnavailable,
    AgentConversationStorageFull,
    AgentConversationLimit,
    AgentConversationPlatformUnavailable,
    InvalidAgentPrompt,
    AgentSessionUnavailable,
    InvalidAgentSessionStore,
    AgentSessionNotFound,
    AgentSessionNotRunning,
    AgentProposalUnavailable,
    VerificationCheckUnavailable,
    VerificationRunUnavailable,
    InvalidJiraIssueKey,
    JiraMcpUnavailable,
    JiraMcpConfiguration,
    JiraMcpSpawnFailed,
    JiraMcpTimedOut,
    JiraMcpProtocolInvalid,
    JiraMcpIssueToolMissing,
    JiraMcpToolCallFailed,
    JiraMcpOutputTooLarge,
    InvalidOpenProjectReference,
    OpenProjectConfiguration,
    OpenProjectAuthentication,
    OpenProjectPermission,
    OpenProjectNotFound,
    OpenProjectAmbiguous,
    OpenProjectTimedOut,
    OpenProjectResponseTooLarge,
    OpenProjectRateLimited,
    OpenProjectRemoteFailure,
    Unavailable,
}

pub trait RegistryBackend: Send + Sync + 'static {
    type Workspace: Serialize + Send + 'static;
    type WorkspaceList: Serialize + Send + 'static;

    fn list(&self) -> Result<Self::WorkspaceList, RegistryFailure>;
    fn get(&self, workspace_id: Uuid) -> Result<Option<Self::Workspace>, RegistryFailure>;
    fn rename(
        &self,
        workspace_id: Uuid,
        request: RenameWorkspaceRequest,
    ) -> Result<Self::Workspace, RegistryFailure>;
    fn create(
        &self,
        idempotency_key: &str,
        request: CreateWorkspaceRequest,
    ) -> Result<CreateOutcome<Self::Workspace>, RegistryFailure>;
}

pub trait MvpBackend: RegistryBackend {
    type Setup: Serialize + Send + 'static;
    type GithubReviewInbox: Serialize + Send + 'static;
    type GithubReviewOpen: Serialize + Send + 'static;
    type GitlabReviewInbox: Serialize + Send + 'static;
    type GitlabDiscussions: Serialize + Send + 'static;
    type GitlabDiscussionReply: Serialize + Send + 'static;
    type GitlabReviewCommentPublication: Serialize + Send + 'static;
    type GitlabMergeRequestInbox: Serialize + Send + 'static;
    type GitlabMergeRequestLink: Serialize + Send + 'static;
    type GitlabMergeRequestOpen: Serialize + Send + 'static;
    type GitlabIntegrationStatus: Serialize + Send + 'static;
    type RepositoryCatalog: Serialize + Send + 'static;
    type RepositoryClone: Serialize + Send + 'static;
    type RepositoryRefresh: Serialize + Send + 'static;
    type RepositoryBaseOpen: Serialize + Send + 'static;
    type ChangeRequestDraft: Serialize + Send + 'static;
    type BranchPublication: Serialize + Send + 'static;
    type ChangeRequestOpen: Serialize + Send + 'static;
    type CodeWorkspaceImport: Serialize + Send + 'static;
    type RuntimeAnalysis: Serialize + Send + 'static;
    type Preflight: Serialize + Send + 'static;
    type ExistingMaterialization: Serialize + Send + 'static;
    type RepositoryDiff: Serialize + Send + 'static;
    type RepositoryFileReview: Serialize + Send + 'static;
    type GitlabComparison: Serialize + Send + 'static;
    type RepositorySource: Serialize + Send + 'static;
    type RepositoryReviewGraph: Serialize + Send + 'static;
    type RepositorySync: Serialize + Send + 'static;
    type RepositoryAdditionPreflight: Serialize + Send + 'static;
    type RepositoryAddition: Serialize + Send + 'static;
    type RepositoryRemoval: Serialize + Send + 'static;
    type RepositoryAlignmentPreflight: Serialize + Send + 'static;
    type RepositoryAlignment: Serialize + Send + 'static;
    type Materialization: Serialize + Send + 'static;
    type OpenWorkspace: Serialize + Send + 'static;
    type CliLaunch: Serialize + Send + 'static;
    type AgentBrief: Serialize + Send + 'static;
    type GraphIndex: Serialize + Send + 'static;
    type RemovalPreflight: Serialize + Send + 'static;
    type Removal: Serialize + Send + 'static;
    type AgentRun: Serialize + Send + 'static;
    type CodeReview: Serialize + Send + 'static;
    type Evidence: Serialize + Send + 'static;
    type TestRunList: Serialize + Send + 'static;
    type TestRunDetail: Serialize + Send + 'static;
    type TestRun: Serialize + Send + 'static;
    type JiraVerification: Serialize + Send + 'static;
    type JiraActiveIssues: Serialize + Send + 'static;
    type TimeReviewBrief: Serialize + Send + 'static;
    type JiraIssue: Serialize + Send + 'static;
    type OpenProjectVerification: Serialize + Send + 'static;
    type OpenProjectWorkPackage: Serialize + Send + 'static;
    type Workflow: Serialize + Send + 'static;
    type PlanningDocumentList: Serialize + Send + 'static;
    type PlanningDocument: Serialize + Send + 'static;
    type ReviewThreadList: Serialize + Send + 'static;
    type ReviewThread: Serialize + Send + 'static;
    type WorkItemLinkPreview: Serialize + Send + 'static;
    type WorkItemLinkConfirmation: Serialize + Send + 'static;
    type WorkItemLinkList: Serialize + Send + 'static;
    type WorkItemUnlink: Serialize + Send + 'static;
    type WorkItemOpen: Serialize + Send + 'static;
    type JiraCreateProposal: Serialize + Send + 'static;

    fn setup(&self) -> Result<Self::Setup, MvpFailure>;
    fn github_review_inbox(&self) -> Result<Self::GithubReviewInbox, MvpFailure>;
    fn open_github_review(
        &self,
        repository_id: &str,
        number: u64,
    ) -> Result<Self::GithubReviewOpen, MvpFailure>;
    fn gitlab_review_inbox(&self) -> Result<Self::GitlabReviewInbox, MvpFailure>;
    fn gitlab_discussions(
        &self,
        repository_id: &str,
        iid: u64,
        workspace_id: Option<Uuid>,
    ) -> Result<Self::GitlabDiscussions, MvpFailure>;
    fn reply_gitlab_discussion(
        &self,
        repository_id: &str,
        iid: u64,
        request: wts_app::ReplyGitlabDiscussionRequest,
    ) -> Result<Self::GitlabDiscussionReply, MvpFailure>;
    fn publish_gitlab_review_comment(
        &self,
        repository_id: &str,
        iid: u64,
        request: wts_app::GitlabReviewCommentRequest,
    ) -> Result<Self::GitlabReviewCommentPublication, MvpFailure>;
    fn gitlab_merge_requests(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::GitlabMergeRequestInbox, MvpFailure>;
    fn link_workspace_gitlab_merge_request(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        iid: u64,
    ) -> Result<Self::GitlabMergeRequestLink, MvpFailure>;
    fn gitlab_integration_status(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::GitlabIntegrationStatus, MvpFailure>;
    fn open_gitlab_merge_request(
        &self,
        repository_id: &str,
        iid: u64,
    ) -> Result<Self::GitlabMergeRequestOpen, MvpFailure>;
    fn prepare_gitlab_review_repository(
        &self,
        repository_id: &str,
        iid: u64,
    ) -> Result<Self::RepositoryClone, MvpFailure>;
    fn repositories(&self) -> Result<Self::RepositoryCatalog, MvpFailure>;
    fn clone_repository(
        &self,
        request: CloneRepositoryRequest,
    ) -> Result<Self::RepositoryClone, MvpFailure>;
    fn refresh_repository_branches(
        &self,
        repository_id: &str,
    ) -> Result<Self::RepositoryRefresh, MvpFailure>;
    fn open_repository_base(
        &self,
        repository_id: &str,
        base_ref: &str,
    ) -> Result<Self::RepositoryBaseOpen, MvpFailure>;
    fn prepare_workspace_change_request(
        &self,
        workspace_id: Uuid,
        request: PrepareWorkspaceChangeRequest,
    ) -> Result<Self::ChangeRequestDraft, MvpFailure>;
    fn publish_workspace_change_request_branch(
        &self,
        workspace_id: Uuid,
        request: PublishWorkspaceChangeRequestBranch,
    ) -> Result<Self::BranchPublication, MvpFailure>;
    fn open_workspace_change_request_draft(
        &self,
        workspace_id: Uuid,
        request: OpenWorkspaceChangeRequestDraft,
    ) -> Result<Self::ChangeRequestOpen, MvpFailure>;
    fn import_code_workspace(
        &self,
        request: CodeWorkspaceImportRequest,
    ) -> Result<Self::CodeWorkspaceImport, MvpFailure>;
    fn analyze_runtime(
        &self,
        request: RuntimeAnalysisRequest,
    ) -> Result<Self::RuntimeAnalysis, MvpFailure>;
    fn preflight(&self, workspace_id: Uuid) -> Result<Self::Preflight, MvpFailure>;
    fn recover_setup(
        &self,
        workspace_id: Uuid,
        expected_effect_digest: &str,
    ) -> Result<Self::Preflight, MvpFailure> {
        let _ = (workspace_id, expected_effect_digest);
        Err(MvpFailure::Unavailable)
    }
    fn transition_workflow(
        &self,
        workspace_id: Uuid,
        request: TransitionWorkspaceWorkflowRequest,
    ) -> Result<Self::Workflow, MvpFailure>;
    fn place_workspace_on_board(
        &self,
        workspace_id: Uuid,
        request: PlaceWorkspaceOnBoardRequest,
    ) -> Result<Self::Workflow, MvpFailure>;
    fn follow_workspace_agent(
        &self,
        workspace_id: Uuid,
        request: FollowWorkspaceAgentRequest,
    ) -> Result<Self::Workflow, MvpFailure>;
    fn list_planning_documents(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::PlanningDocumentList, MvpFailure>;
    fn read_planning_document(
        &self,
        workspace_id: Uuid,
        document_id: WorkspacePlanningDocumentId,
    ) -> Result<Self::PlanningDocument, MvpFailure>;
    fn update_planning_document(
        &self,
        workspace_id: Uuid,
        document_id: WorkspacePlanningDocumentId,
        request: UpdateWorkspacePlanningDocumentRequest,
    ) -> Result<Self::PlanningDocument, MvpFailure>;
    fn list_review_threads(&self, workspace_id: Uuid)
    -> Result<Self::ReviewThreadList, MvpFailure>;
    fn create_review_thread(
        &self,
        workspace_id: Uuid,
        request: CreateWorkspaceReviewThreadRequest,
    ) -> Result<Self::ReviewThread, MvpFailure>;
    fn resolve_review_thread(
        &self,
        workspace_id: Uuid,
        thread_id: Uuid,
        request: ResolveWorkspaceReviewThreadRequest,
    ) -> Result<Self::ReviewThread, MvpFailure>;
    fn preview_jira_link(
        &self,
        workspace_id: Uuid,
        request: PreviewWorkspaceJiraLinkRequest,
    ) -> Result<Self::WorkItemLinkPreview, MvpFailure>;
    fn confirm_jira_link(
        &self,
        workspace_id: Uuid,
        request: ConfirmWorkspaceJiraLinkRequest,
    ) -> Result<Self::WorkItemLinkConfirmation, MvpFailure>;
    fn open_jira_preview(
        &self,
        workspace_id: Uuid,
        request: OpenWorkspaceJiraPreviewRequest,
    ) -> Result<Self::WorkItemOpen, MvpFailure>;
    fn list_work_item_links(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::WorkItemLinkList, MvpFailure>;
    fn unlink_work_item(
        &self,
        workspace_id: Uuid,
        link_id: Uuid,
        request: UnlinkWorkspaceWorkItemRequest,
    ) -> Result<Self::WorkItemUnlink, MvpFailure>;
    fn open_work_item(
        &self,
        workspace_id: Uuid,
        link_id: Uuid,
        request: OpenWorkspaceWorkItemRequest,
    ) -> Result<Self::WorkItemOpen, MvpFailure>;
    fn propose_jira_issue(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::JiraCreateProposal, MvpFailure>;
    fn get_materialization(
        &self,
        workspace_id: Uuid,
    ) -> Result<Option<Self::ExistingMaterialization>, MvpFailure>;
    fn repository_diff(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Self::RepositoryDiff, MvpFailure>;
    fn repository_file_review(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        file_path: &str,
        expected_patch_sha256: &str,
    ) -> Result<Self::RepositoryFileReview, MvpFailure>;
    fn gitlab_comparison(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        iid: u64,
        refresh: bool,
    ) -> Result<Self::GitlabComparison, MvpFailure>;
    fn repository_source(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        file_path: &str,
    ) -> Result<Self::RepositorySource, MvpFailure>;
    fn save_repository_source(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        request: wts_app::WorkspaceRepositorySourceSaveRequest,
    ) -> Result<Self::RepositorySource, MvpFailure>;
    fn repository_review_graph(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Option<Self::RepositoryReviewGraph>, MvpFailure>;
    fn sync_repository(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Self::RepositorySync, MvpFailure>;
    fn preflight_repository_addition(
        &self,
        workspace_id: Uuid,
        request: AddWorkspaceRepositoryRequest,
    ) -> Result<Self::RepositoryAdditionPreflight, MvpFailure>;
    fn add_repository(
        &self,
        workspace_id: Uuid,
        request: AddWorkspaceRepositoryRequest,
        expected_effect_digest: &str,
    ) -> Result<Self::RepositoryAddition, MvpFailure>;
    fn remove_repository(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Self::RepositoryRemoval, MvpFailure>;
    fn preflight_repository_alignment(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Self::RepositoryAlignmentPreflight, MvpFailure>;
    fn align_repository(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        expected_effect_digest: &str,
    ) -> Result<Self::RepositoryAlignment, MvpFailure>;
    fn materialize(
        &self,
        workspace_id: Uuid,
        expected_effect_digest: &str,
    ) -> Result<Self::Materialization, MvpFailure>;
    fn open_vscode(&self, workspace_id: Uuid) -> Result<Self::OpenWorkspace, MvpFailure>;
    fn open_cli(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        terminal: TerminalProvider,
    ) -> Result<Self::CliLaunch, MvpFailure>;
    fn write_agent_brief(
        &self,
        workspace_id: Uuid,
        task_markdown: &str,
    ) -> Result<Self::AgentBrief, MvpFailure>;
    fn index_graph(&self, workspace_id: Uuid) -> Result<Self::GraphIndex, MvpFailure>;
    fn reindex_graph(&self, workspace_id: Uuid) -> Result<Self::GraphIndex, MvpFailure>;
    fn preflight_removal(&self, workspace_id: Uuid) -> Result<Self::RemovalPreflight, MvpFailure>;
    fn remove(
        &self,
        workspace_id: Uuid,
        expected_effect_digest: &str,
        idempotency_key: &str,
        delete_protected_paths: bool,
    ) -> Result<Self::Removal, MvpFailure>;
    fn run_agent(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        prompt: &str,
    ) -> Result<Self::AgentRun, MvpFailure>;
    fn list_agent_sessions(
        &self,
        workspace_id: Option<Uuid>,
    ) -> Result<AgentSessionList, MvpFailure>;
    fn create_agent_work_set(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: wts_app::CreateAgentWorkSetRequest,
    ) -> Result<wts_app::AgentWorkSet, MvpFailure> {
        let _ = (conversation_id, turn_request_id, request);
        Err(MvpFailure::Unavailable)
    }
    fn list_agent_work_sets(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentWorkSetList, MvpFailure> {
        let _ = (conversation_id, request_id);
        Err(MvpFailure::Unavailable)
    }
    fn get_agent_work_set(&self, work_set_id: Uuid) -> Result<wts_app::AgentWorkSet, MvpFailure> {
        let _ = (work_set_id,);
        Err(MvpFailure::Unavailable)
    }
    fn cancel_agent_work_item(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
        request: wts_app::AgentWorkItemCancelRequest,
    ) -> Result<wts_app::AgentWorkSet, MvpFailure> {
        let _ = (work_set_id, task_id, request);
        Err(MvpFailure::Unavailable)
    }
    fn preflight_agent_work_item_integration(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
    ) -> Result<wts_app::AgentWorkItemIntegrationPreflight, MvpFailure> {
        let _ = (work_set_id, task_id);
        Err(MvpFailure::Unavailable)
    }
    fn integrate_agent_work_item(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
        request: wts_app::IntegrateAgentWorkItemRequest,
    ) -> Result<wts_app::AgentWorkItemIntegrationResult, MvpFailure> {
        let _ = (work_set_id, task_id, request);
        Err(MvpFailure::Unavailable)
    }
    fn create_agent_conversation(
        &self,
        request: wts_app::CreateAgentConversationRequest,
    ) -> Result<wts_app::AgentConversation, MvpFailure> {
        let _ = request;
        Err(MvpFailure::Unavailable)
    }
    fn list_agent_conversations(&self) -> Result<wts_app::AgentConversationList, MvpFailure> {
        Err(MvpFailure::Unavailable)
    }
    fn get_agent_conversation(&self, id: Uuid) -> Result<wts_app::AgentConversation, MvpFailure> {
        let _ = id;
        Err(MvpFailure::Unavailable)
    }
    fn get_agent_turn_changes(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentTurnChanges, MvpFailure> {
        let _ = (conversation_id, request_id);
        Err(MvpFailure::Unavailable)
    }
    fn get_agent_turn_decisions(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentTurnDecisions, MvpFailure> {
        let _ = (conversation_id, request_id);
        Err(MvpFailure::Unavailable)
    }
    fn record_agent_turn_decision(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: wts_app::RecordAgentTurnDecisionRequest,
    ) -> Result<wts_app::AgentTurnDecisions, MvpFailure> {
        let _ = (conversation_id, turn_request_id, request);
        Err(MvpFailure::Unavailable)
    }
    fn get_agent_turn_checks(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentTurnChecks, MvpFailure> {
        let _ = (conversation_id, request_id);
        Err(MvpFailure::Unavailable)
    }
    fn run_agent_turn_check(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: wts_app::RunAgentTurnCheckRequest,
    ) -> Result<wts_app::AgentTurnChecks, MvpFailure> {
        let _ = (conversation_id, turn_request_id, request);
        Err(MvpFailure::Unavailable)
    }
    fn preflight_agent_turn_restore(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentTurnRestorePreflight, MvpFailure> {
        let _ = (conversation_id, request_id);
        Err(MvpFailure::Unavailable)
    }
    fn restore_agent_turn(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: wts_app::AgentTurnRestoreRequest,
    ) -> Result<wts_app::AgentTurnRestoreResult, MvpFailure> {
        let _ = (conversation_id, turn_request_id, request);
        Err(MvpFailure::Unavailable)
    }
    fn send_agent_conversation_message(
        &self,
        id: Uuid,
        request: wts_app::SendAgentConversationMessageRequest,
    ) -> Result<wts_app::AgentConversation, MvpFailure> {
        let _ = (id, request);
        Err(MvpFailure::Unavailable)
    }
    fn update_agent_conversation_message(
        &self,
        id: Uuid,
        message_id: Uuid,
        request: wts_app::UpdateAgentConversationMessageRequest,
    ) -> Result<wts_app::AgentConversation, MvpFailure> {
        let _ = (id, message_id, request);
        Err(MvpFailure::Unavailable)
    }
    fn cancel_agent_conversation_message(
        &self,
        id: Uuid,
        message_id: Uuid,
        request: wts_app::CancelAgentConversationMessageRequest,
    ) -> Result<wts_app::AgentConversation, MvpFailure> {
        let _ = (id, message_id, request);
        Err(MvpFailure::Unavailable)
    }
    fn get_agent_session_detail(&self, session_id: Uuid) -> Result<AgentSessionDetail, MvpFailure> {
        let _ = session_id;
        Err(MvpFailure::Unavailable)
    }
    fn start_agent_session(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        terminal: TerminalProvider,
        category: AgentSessionCategory,
    ) -> Result<AgentSession, MvpFailure>;
    fn heartbeat_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure>;
    fn finish_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure>;
    fn fail_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure>;
    fn launch_agent_session(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        prompt: &str,
        category: AgentSessionCategory,
    ) -> Result<AgentSession, MvpFailure> {
        let _ = (workspace_id, provider, prompt, category);
        Err(MvpFailure::Unavailable)
    }
    fn stop_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
        let _ = session_id;
        Err(MvpFailure::Unavailable)
    }
    fn get_evidence(&self, workspace_id: Uuid) -> Result<Option<Self::Evidence>, MvpFailure>;
    fn get_verification_summary(&self, workspace_id: Uuid) -> Result<Option<WorkspaceVerificationSummary>, MvpFailure> {
        let _ = workspace_id;
        Err(MvpFailure::Unavailable)
    }
    fn promote_agent_check(
        &self,
        workspace_id: Uuid,
        proposal_id: &str,
    ) -> Result<Self::Evidence, MvpFailure>;
    fn run_code_review(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        scope: CodeReviewScope,
        options: CodeReviewOptions,
    ) -> Result<Self::CodeReview, MvpFailure> {
        let _ = (workspace_id, provider, scope, options);
        Err(MvpFailure::Unavailable)
    }
    fn get_code_review(&self, workspace_id: Uuid) -> Result<Option<Self::CodeReview>, MvpFailure> {
        let _ = workspace_id;
        Err(MvpFailure::Unavailable)
    }
    fn agent_models(&self, refresh: bool) -> Result<AgentModelCatalog, MvpFailure> {
        let _ = refresh;
        Err(MvpFailure::Unavailable)
    }
    fn code_review_trace(
        &self,
        workspace_id: Uuid,
        after: Option<u32>,
    ) -> Result<Option<wts_app::CodeReviewTrace>, MvpFailure> {
        let _ = (workspace_id, after);
        Ok(None)
    }
    fn run_verification(&self, workspace_id: Uuid) -> Result<Self::Evidence, MvpFailure>;
    fn run_verification_check(
        &self,
        workspace_id: Uuid,
        check_id: &str,
    ) -> Result<Self::Evidence, MvpFailure> {
        let _ = (workspace_id, check_id);
        Err(MvpFailure::Unavailable)
    }
    fn rerun_failed_verification(&self, workspace_id: Uuid) -> Result<Self::Evidence, MvpFailure> {
        let _ = workspace_id;
        Err(MvpFailure::Unavailable)
    }
    fn cancel_verification(&self, workspace_id: Uuid) -> Result<Self::Evidence, MvpFailure> {
        let _ = workspace_id;
        Err(MvpFailure::Unavailable)
    }
    fn list_test_runs(&self, workspace_id: Uuid) -> Result<Self::TestRunList, MvpFailure>;
    fn get_test_run(
        &self,
        workspace_id: Uuid,
        run_id: Uuid,
    ) -> Result<Self::TestRunDetail, MvpFailure>;
    fn run_test_journey(
        &self,
        workspace_id: Uuid,
        journey_id: &str,
        base_url: &str,
    ) -> Result<Self::TestRun, MvpFailure>;
    fn verify_jira(&self) -> Result<Self::JiraVerification, MvpFailure>;
    fn active_jira_issues(&self) -> Result<Self::JiraActiveIssues, MvpFailure>;
    fn activity_watch_time_review_brief(
        &self,
        started_at_unix_ms: i64,
        ended_at_unix_ms: i64,
        endpoint: Option<&str>,
    ) -> Result<Self::TimeReviewBrief, MvpFailure>;
    fn import_jira(&self, issue_key: &str) -> Result<Self::JiraIssue, MvpFailure>;
    fn verify_open_project(&self) -> Result<Self::OpenProjectVerification, MvpFailure>;
    fn import_open_project_work_package(
        &self,
        reference: &str,
    ) -> Result<Self::OpenProjectWorkPackage, MvpFailure>;
}

impl RegistryBackend for WorkspaceService {
    type Workspace = WorkspaceView;
    type WorkspaceList = WorkspaceList;

    fn list(&self) -> Result<Self::WorkspaceList, RegistryFailure> {
        WorkspaceService::list(self).map_err(map_store_error)
    }

    fn get(&self, workspace_id: Uuid) -> Result<Option<Self::Workspace>, RegistryFailure> {
        WorkspaceService::get(self, workspace_id).map_err(map_store_error)
    }

    fn rename(
        &self,
        workspace_id: Uuid,
        request: RenameWorkspaceRequest,
    ) -> Result<Self::Workspace, RegistryFailure> {
        WorkspaceService::rename(self, workspace_id, request).map_err(map_store_error)
    }

    fn create(
        &self,
        idempotency_key: &str,
        request: CreateWorkspaceRequest,
    ) -> Result<CreateOutcome<Self::Workspace>, RegistryFailure> {
        let result =
            WorkspaceService::create(self, idempotency_key, request).map_err(map_store_error)?;
        Ok(CreateOutcome {
            workspace: result.workspace,
            replayed: result.replayed,
        })
    }
}

impl RegistryBackend for LocalWtsService {
    type Workspace = WorkspaceView;
    type WorkspaceList = WorkspaceList;

    fn list(&self) -> Result<Self::WorkspaceList, RegistryFailure> {
        self.list_workspaces().map_err(map_local_registry_error)
    }

    fn get(&self, workspace_id: Uuid) -> Result<Option<Self::Workspace>, RegistryFailure> {
        self.get_workspace(workspace_id)
            .map_err(map_local_registry_error)
    }

    fn rename(
        &self,
        workspace_id: Uuid,
        request: RenameWorkspaceRequest,
    ) -> Result<Self::Workspace, RegistryFailure> {
        self.rename_workspace(workspace_id, request)
            .map_err(map_local_registry_error)
    }

    fn create(
        &self,
        idempotency_key: &str,
        request: CreateWorkspaceRequest,
    ) -> Result<CreateOutcome<Self::Workspace>, RegistryFailure> {
        let result = self
            .create_workspace(idempotency_key, request)
            .map_err(map_local_registry_error)?;
        Ok(CreateOutcome {
            workspace: result.workspace,
            replayed: result.replayed,
        })
    }
}

impl MvpBackend for LocalWtsService {
    type Setup = SetupSnapshot;
    type GithubReviewInbox = GithubReviewInbox;
    type GithubReviewOpen = OpenGithubReviewResult;
    type GitlabReviewInbox = wts_app::GitlabReviewInbox;
    type GitlabDiscussions = wts_app::GitlabDiscussions;
    type GitlabDiscussionReply = wts_app::ReplyGitlabDiscussionResult;
    type GitlabReviewCommentPublication = wts_app::PublishGitlabReviewCommentResult;
    type GitlabMergeRequestInbox = wts_app::GitlabMergeRequestInbox;
    type GitlabMergeRequestLink = wts_integrations::GitlabMergeRequest;
    type GitlabMergeRequestOpen = OpenWorkspaceGitlabMergeRequestResult;
    type GitlabIntegrationStatus = GitlabIntegrationStatus;
    type RepositoryCatalog = RepositoryCatalog;
    type RepositoryClone = CloneRepositoryResult;
    type RepositoryRefresh = RefreshRepositoryBranchesResult;
    type RepositoryBaseOpen = OpenRepositoryBaseResult;
    type ChangeRequestDraft = WorkspaceChangeRequestDraft;
    type BranchPublication = WorkspaceBranchPublicationResult;
    type ChangeRequestOpen = OpenWorkspaceChangeRequestResult;
    type CodeWorkspaceImport = CodeWorkspaceImportResult;
    type RuntimeAnalysis = RuntimeAnalysisResult;
    type Preflight = WorkspacePreflight;
    type ExistingMaterialization = WorkspaceMaterialization;
    type RepositoryDiff = WorkspaceRepositoryDiff;
    type RepositoryFileReview = WorkspaceRepositoryFileReview;
    type GitlabComparison = wts_app::WorkspaceGitlabComparison;
    type RepositorySource = wts_app::WorkspaceRepositorySource;
    type RepositoryReviewGraph = WorkspaceRepositoryReviewGraph;
    type RepositorySync = WorkspaceRepositorySyncResult;
    type RepositoryAdditionPreflight = WorkspaceRepositoryAdditionPreflight;
    type RepositoryAddition = WorkspaceRepositoryAdditionResult;
    type RepositoryRemoval = WorkspaceRepositoryRemovalResult;
    type RepositoryAlignmentPreflight = WorkspaceRepositoryAlignmentPreflight;
    type RepositoryAlignment = WorkspaceRepositoryAlignmentResult;
    type Materialization = MaterializeWorkspaceResult;
    type OpenWorkspace = OpenWorkspaceResult;
    type CliLaunch = WorkspaceCliLaunchResult;
    type AgentBrief = wts_app::WorkspaceAgentBriefResult;
    type GraphIndex = GraphIndexResult;
    type RemovalPreflight = WorkspaceRemovalPreflight;
    type Removal = RemoveWorkspaceResult;
    type AgentRun = AgentRunResult;
    type CodeReview = WorkspaceCodeReviewResult;
    type Evidence = WorkspaceEvidence;
    type TestRunList = TestRunList;
    type TestRunDetail = TestRunResult;
    type TestRun = TestRunSummary;
    type JiraVerification = JiraMcpVerification;
    type JiraActiveIssues = JiraActiveIssueList;
    type TimeReviewBrief = TimeReviewAgentBrief;
    type JiraIssue = JiraIssueImport;
    type OpenProjectVerification = OpenProjectVerification;
    type OpenProjectWorkPackage = OpenProjectWorkPackageImport;
    type Workflow = WorkspaceWorkflowSummary;
    type PlanningDocumentList = WorkspacePlanningDocumentList;
    type PlanningDocument = WorkspacePlanningDocument;
    type ReviewThreadList = WorkspaceReviewThreadList;
    type ReviewThread = WorkspaceReviewThread;
    type WorkItemLinkPreview = WorkspaceWorkItemLinkPreview;
    type WorkItemLinkConfirmation = ConfirmWorkspaceWorkItemLinkResult;
    type WorkItemLinkList = WorkspaceWorkItemLinkList;
    type WorkItemUnlink = WorkspaceWorkItemUnlinkResult;
    type WorkItemOpen = OpenWorkspaceWorkItemResult;
    type JiraCreateProposal = JiraCreateProposal;

    fn setup(&self) -> Result<Self::Setup, MvpFailure> {
        Ok(self.setup_snapshot())
    }

    fn github_review_inbox(&self) -> Result<Self::GithubReviewInbox, MvpFailure> {
        LocalWtsService::github_review_inbox(self).map_err(map_local_mvp_error)
    }

    fn open_github_review(
        &self,
        repository_id: &str,
        number: u64,
    ) -> Result<Self::GithubReviewOpen, MvpFailure> {
        LocalWtsService::open_github_review(self, repository_id, number)
            .map_err(map_local_mvp_error)
    }

    fn gitlab_review_inbox(&self) -> Result<Self::GitlabReviewInbox, MvpFailure> {
        LocalWtsService::gitlab_review_inbox(self).map_err(map_local_mvp_error)
    }

    fn gitlab_discussions(
        &self,
        repository_id: &str,
        iid: u64,
        workspace_id: Option<Uuid>,
    ) -> Result<Self::GitlabDiscussions, MvpFailure> {
        LocalWtsService::gitlab_discussions(self, repository_id, iid, workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn reply_gitlab_discussion(
        &self,
        repository_id: &str,
        iid: u64,
        request: wts_app::ReplyGitlabDiscussionRequest,
    ) -> Result<Self::GitlabDiscussionReply, MvpFailure> {
        LocalWtsService::reply_gitlab_discussion(self, repository_id, iid, request)
            .map_err(map_local_mvp_error)
    }

    fn gitlab_merge_requests(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::GitlabMergeRequestInbox, MvpFailure> {
        LocalWtsService::gitlab_merge_requests(self, workspace_id).map_err(map_local_mvp_error)
    }

    fn link_workspace_gitlab_merge_request(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        iid: u64,
    ) -> Result<Self::GitlabMergeRequestLink, MvpFailure> {
        LocalWtsService::link_workspace_gitlab_merge_request(self, workspace_id, repository_id, iid)
            .map_err(map_local_mvp_error)
    }

    fn publish_gitlab_review_comment(
        &self,
        repository_id: &str,
        iid: u64,
        request: wts_app::GitlabReviewCommentRequest,
    ) -> Result<Self::GitlabReviewCommentPublication, MvpFailure> {
        LocalWtsService::publish_gitlab_review_comment(self, repository_id, iid, request)
            .map_err(map_local_mvp_error)
    }

    fn gitlab_integration_status(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::GitlabIntegrationStatus, MvpFailure> {
        LocalWtsService::gitlab_integration_status(self, workspace_id).map_err(map_local_mvp_error)
    }

    fn open_gitlab_merge_request(
        &self,
        repository_id: &str,
        iid: u64,
    ) -> Result<Self::GitlabMergeRequestOpen, MvpFailure> {
        LocalWtsService::open_gitlab_merge_request(self, repository_id, iid)
            .map_err(map_local_mvp_error)
    }

    fn prepare_gitlab_review_repository(
        &self,
        repository_id: &str,
        iid: u64,
    ) -> Result<Self::RepositoryClone, MvpFailure> {
        LocalWtsService::prepare_gitlab_review_repository(self, repository_id, iid)
            .map_err(map_local_mvp_error)
    }

    fn repositories(&self) -> Result<Self::RepositoryCatalog, MvpFailure> {
        self.repository_catalog().map_err(map_local_mvp_error)
    }

    fn clone_repository(
        &self,
        request: CloneRepositoryRequest,
    ) -> Result<Self::RepositoryClone, MvpFailure> {
        LocalWtsService::clone_repository(self, request).map_err(map_local_mvp_error)
    }

    fn refresh_repository_branches(
        &self,
        repository_id: &str,
    ) -> Result<Self::RepositoryRefresh, MvpFailure> {
        LocalWtsService::refresh_repository_branches(
            self,
            RefreshRepositoryBranchesRequest {
                repository_id: repository_id.to_owned(),
            },
        )
        .map_err(map_local_mvp_error)
    }

    fn open_repository_base(
        &self,
        repository_id: &str,
        base_ref: &str,
    ) -> Result<Self::RepositoryBaseOpen, MvpFailure> {
        LocalWtsService::open_repository_base(self, repository_id, base_ref)
            .map_err(map_local_mvp_error)
    }

    fn prepare_workspace_change_request(
        &self,
        workspace_id: Uuid,
        request: PrepareWorkspaceChangeRequest,
    ) -> Result<Self::ChangeRequestDraft, MvpFailure> {
        LocalWtsService::prepare_workspace_change_request(self, workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn publish_workspace_change_request_branch(
        &self,
        workspace_id: Uuid,
        request: PublishWorkspaceChangeRequestBranch,
    ) -> Result<Self::BranchPublication, MvpFailure> {
        LocalWtsService::publish_workspace_change_request_branch(self, workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn open_workspace_change_request_draft(
        &self,
        workspace_id: Uuid,
        request: OpenWorkspaceChangeRequestDraft,
    ) -> Result<Self::ChangeRequestOpen, MvpFailure> {
        LocalWtsService::open_workspace_change_request_draft(self, workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn import_code_workspace(
        &self,
        request: CodeWorkspaceImportRequest,
    ) -> Result<Self::CodeWorkspaceImport, MvpFailure> {
        self.import_code_workspace_file(request)
            .map_err(map_local_mvp_error)
    }

    fn analyze_runtime(
        &self,
        request: RuntimeAnalysisRequest,
    ) -> Result<Self::RuntimeAnalysis, MvpFailure> {
        self.analyze_workspace_runtime(request)
            .map_err(map_local_mvp_error)
    }

    fn preflight(&self, workspace_id: Uuid) -> Result<Self::Preflight, MvpFailure> {
        self.preflight_workspace(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn recover_setup(
        &self,
        workspace_id: Uuid,
        expected_effect_digest: &str,
    ) -> Result<Self::Preflight, MvpFailure> {
        self.recover_workspace_setup(workspace_id, expected_effect_digest)
            .map_err(map_local_mvp_error)
    }

    fn preflight_repository_addition(
        &self,
        workspace_id: Uuid,
        request: AddWorkspaceRepositoryRequest,
    ) -> Result<Self::RepositoryAdditionPreflight, MvpFailure> {
        LocalWtsService::preflight_workspace_repository_addition(self, workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn add_repository(
        &self,
        workspace_id: Uuid,
        request: AddWorkspaceRepositoryRequest,
        expected_effect_digest: &str,
    ) -> Result<Self::RepositoryAddition, MvpFailure> {
        LocalWtsService::add_workspace_repository(
            self,
            workspace_id,
            request,
            expected_effect_digest,
        )
        .map_err(map_local_mvp_error)
    }

    fn remove_repository(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Self::RepositoryRemoval, MvpFailure> {
        LocalWtsService::remove_workspace_repository(self, workspace_id, repository_id)
            .map_err(map_local_mvp_error)
    }

    fn transition_workflow(
        &self,
        workspace_id: Uuid,
        request: TransitionWorkspaceWorkflowRequest,
    ) -> Result<Self::Workflow, MvpFailure> {
        self.transition_workspace_workflow(workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn place_workspace_on_board(
        &self,
        workspace_id: Uuid,
        request: PlaceWorkspaceOnBoardRequest,
    ) -> Result<Self::Workflow, MvpFailure> {
        self.place_workspace_on_board(workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn follow_workspace_agent(
        &self,
        workspace_id: Uuid,
        request: FollowWorkspaceAgentRequest,
    ) -> Result<Self::Workflow, MvpFailure> {
        self.follow_workspace_agent(workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn list_planning_documents(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::PlanningDocumentList, MvpFailure> {
        self.list_workspace_planning_documents(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn read_planning_document(
        &self,
        workspace_id: Uuid,
        document_id: WorkspacePlanningDocumentId,
    ) -> Result<Self::PlanningDocument, MvpFailure> {
        self.read_workspace_planning_document(workspace_id, document_id)
            .map_err(map_local_mvp_error)
    }

    fn update_planning_document(
        &self,
        workspace_id: Uuid,
        document_id: WorkspacePlanningDocumentId,
        request: UpdateWorkspacePlanningDocumentRequest,
    ) -> Result<Self::PlanningDocument, MvpFailure> {
        self.update_workspace_planning_document(workspace_id, document_id, request)
            .map_err(map_local_mvp_error)
    }

    fn list_review_threads(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::ReviewThreadList, MvpFailure> {
        self.list_workspace_review_threads(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn create_review_thread(
        &self,
        workspace_id: Uuid,
        request: CreateWorkspaceReviewThreadRequest,
    ) -> Result<Self::ReviewThread, MvpFailure> {
        self.create_workspace_review_thread(workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn resolve_review_thread(
        &self,
        workspace_id: Uuid,
        thread_id: Uuid,
        request: ResolveWorkspaceReviewThreadRequest,
    ) -> Result<Self::ReviewThread, MvpFailure> {
        self.resolve_workspace_review_thread(workspace_id, thread_id, request)
            .map_err(map_local_mvp_error)
    }

    fn preview_jira_link(
        &self,
        workspace_id: Uuid,
        request: PreviewWorkspaceJiraLinkRequest,
    ) -> Result<Self::WorkItemLinkPreview, MvpFailure> {
        self.preview_workspace_jira_link(workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn confirm_jira_link(
        &self,
        workspace_id: Uuid,
        request: ConfirmWorkspaceJiraLinkRequest,
    ) -> Result<Self::WorkItemLinkConfirmation, MvpFailure> {
        self.confirm_workspace_jira_link(workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn open_jira_preview(
        &self,
        workspace_id: Uuid,
        request: OpenWorkspaceJiraPreviewRequest,
    ) -> Result<Self::WorkItemOpen, MvpFailure> {
        self.open_workspace_jira_preview(workspace_id, request)
            .map_err(map_local_mvp_error)
    }

    fn list_work_item_links(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::WorkItemLinkList, MvpFailure> {
        self.list_workspace_work_item_links(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn unlink_work_item(
        &self,
        workspace_id: Uuid,
        link_id: Uuid,
        request: UnlinkWorkspaceWorkItemRequest,
    ) -> Result<Self::WorkItemUnlink, MvpFailure> {
        self.unlink_workspace_work_item(workspace_id, link_id, request)
            .map_err(map_local_mvp_error)
    }

    fn open_work_item(
        &self,
        workspace_id: Uuid,
        link_id: Uuid,
        request: OpenWorkspaceWorkItemRequest,
    ) -> Result<Self::WorkItemOpen, MvpFailure> {
        self.open_workspace_work_item(workspace_id, link_id, request)
            .map_err(map_local_mvp_error)
    }

    fn propose_jira_issue(
        &self,
        workspace_id: Uuid,
    ) -> Result<Self::JiraCreateProposal, MvpFailure> {
        self.propose_workspace_jira_issue(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn get_materialization(
        &self,
        workspace_id: Uuid,
    ) -> Result<Option<Self::ExistingMaterialization>, MvpFailure> {
        LocalWtsService::get_materialization(self, workspace_id).map_err(map_local_mvp_error)
    }

    fn repository_diff(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Self::RepositoryDiff, MvpFailure> {
        self.workspace_repository_diff(workspace_id, repository_id)
            .map_err(map_local_mvp_error)
    }

    fn repository_file_review(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        file_path: &str,
        expected_patch_sha256: &str,
    ) -> Result<Self::RepositoryFileReview, MvpFailure> {
        self.workspace_repository_file_review(
            workspace_id,
            repository_id,
            file_path,
            expected_patch_sha256,
        )
        .map_err(map_local_mvp_error)
    }

    fn gitlab_comparison(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        iid: u64,
        refresh: bool,
    ) -> Result<Self::GitlabComparison, MvpFailure> {
        self.workspace_gitlab_comparison(workspace_id, repository_id, iid, refresh)
            .map_err(map_local_mvp_error)
    }
    fn repository_source(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        file_path: &str,
    ) -> Result<Self::RepositorySource, MvpFailure> {
        self.workspace_repository_source(workspace_id, repository_id, file_path)
            .map_err(map_local_mvp_error)
    }
    fn save_repository_source(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        request: wts_app::WorkspaceRepositorySourceSaveRequest,
    ) -> Result<Self::RepositorySource, MvpFailure> {
        self.save_workspace_repository_source(workspace_id, repository_id, request)
            .map_err(map_local_mvp_error)
    }

    fn repository_review_graph(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Option<Self::RepositoryReviewGraph>, MvpFailure> {
        self.workspace_repository_review_graph(workspace_id, repository_id)
            .map_err(map_local_mvp_error)
    }

    fn sync_repository(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Self::RepositorySync, MvpFailure> {
        self.sync_workspace_repository(workspace_id, repository_id)
            .map_err(map_local_mvp_error)
    }

    fn preflight_repository_alignment(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
    ) -> Result<Self::RepositoryAlignmentPreflight, MvpFailure> {
        self.preflight_workspace_repository_alignment(workspace_id, repository_id)
            .map_err(map_local_mvp_error)
    }

    fn align_repository(
        &self,
        workspace_id: Uuid,
        repository_id: &str,
        expected_effect_digest: &str,
    ) -> Result<Self::RepositoryAlignment, MvpFailure> {
        self.align_workspace_repository(workspace_id, repository_id, expected_effect_digest)
            .map_err(map_local_mvp_error)
    }

    fn materialize(
        &self,
        workspace_id: Uuid,
        expected_effect_digest: &str,
    ) -> Result<Self::Materialization, MvpFailure> {
        self.materialize_workspace(workspace_id, expected_effect_digest)
            .map_err(map_local_mvp_error)
    }

    fn open_vscode(&self, workspace_id: Uuid) -> Result<Self::OpenWorkspace, MvpFailure> {
        self.open_workspace_in_vscode(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn open_cli(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        terminal: TerminalProvider,
    ) -> Result<Self::CliLaunch, MvpFailure> {
        self.open_workspace_cli(workspace_id, provider, terminal)
            .map_err(map_local_mvp_error)
    }

    fn write_agent_brief(
        &self,
        workspace_id: Uuid,
        task_markdown: &str,
    ) -> Result<Self::AgentBrief, MvpFailure> {
        self.write_workspace_agent_brief(workspace_id, task_markdown)
            .map_err(map_local_mvp_error)
    }

    fn index_graph(&self, workspace_id: Uuid) -> Result<Self::GraphIndex, MvpFailure> {
        self.index_workspace_graph(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn reindex_graph(&self, workspace_id: Uuid) -> Result<Self::GraphIndex, MvpFailure> {
        self.reindex_workspace_graph(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn preflight_removal(&self, workspace_id: Uuid) -> Result<Self::RemovalPreflight, MvpFailure> {
        self.preflight_workspace_removal(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn remove(
        &self,
        workspace_id: Uuid,
        expected_effect_digest: &str,
        idempotency_key: &str,
        delete_protected_paths: bool,
    ) -> Result<Self::Removal, MvpFailure> {
        self.remove_workspace(
            workspace_id,
            expected_effect_digest,
            idempotency_key,
            delete_protected_paths,
        )
        .map_err(map_local_mvp_error)
    }

    fn run_agent(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        prompt: &str,
    ) -> Result<Self::AgentRun, MvpFailure> {
        LocalWtsService::run_agent(self, workspace_id, provider, prompt)
            .map_err(map_local_mvp_error)
    }

    fn list_agent_sessions(
        &self,
        workspace_id: Option<Uuid>,
    ) -> Result<AgentSessionList, MvpFailure> {
        LocalWtsService::list_agent_sessions(self, workspace_id).map_err(map_local_mvp_error)
    }

    fn create_agent_work_set(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: wts_app::CreateAgentWorkSetRequest,
    ) -> Result<wts_app::AgentWorkSet, MvpFailure> {
        LocalWtsService::create_agent_work_set(self, conversation_id, turn_request_id, request)
            .map_err(map_local_mvp_error)
    }
    fn list_agent_work_sets(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentWorkSetList, MvpFailure> {
        LocalWtsService::list_agent_work_sets(self, conversation_id, request_id)
            .map_err(map_local_mvp_error)
    }
    fn get_agent_work_set(&self, work_set_id: Uuid) -> Result<wts_app::AgentWorkSet, MvpFailure> {
        LocalWtsService::get_agent_work_set(self, work_set_id).map_err(map_local_mvp_error)
    }
    fn cancel_agent_work_item(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
        request: wts_app::AgentWorkItemCancelRequest,
    ) -> Result<wts_app::AgentWorkSet, MvpFailure> {
        LocalWtsService::cancel_agent_work_item(self, work_set_id, task_id, request)
            .map_err(map_local_mvp_error)
    }
    fn preflight_agent_work_item_integration(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
    ) -> Result<wts_app::AgentWorkItemIntegrationPreflight, MvpFailure> {
        LocalWtsService::preflight_agent_work_item_integration(self, work_set_id, task_id)
            .map_err(map_local_mvp_error)
    }
    fn integrate_agent_work_item(
        &self,
        work_set_id: Uuid,
        task_id: Uuid,
        request: wts_app::IntegrateAgentWorkItemRequest,
    ) -> Result<wts_app::AgentWorkItemIntegrationResult, MvpFailure> {
        LocalWtsService::integrate_agent_work_item(self, work_set_id, task_id, request)
            .map_err(map_local_mvp_error)
    }
    fn create_agent_conversation(
        &self,
        request: wts_app::CreateAgentConversationRequest,
    ) -> Result<wts_app::AgentConversation, MvpFailure> {
        LocalWtsService::create_agent_conversation(self, request).map_err(map_local_mvp_error)
    }
    fn list_agent_conversations(&self) -> Result<wts_app::AgentConversationList, MvpFailure> {
        LocalWtsService::list_agent_conversations(self).map_err(map_local_mvp_error)
    }
    fn get_agent_conversation(&self, id: Uuid) -> Result<wts_app::AgentConversation, MvpFailure> {
        LocalWtsService::get_agent_conversation(self, id).map_err(map_local_mvp_error)
    }
    fn get_agent_turn_changes(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentTurnChanges, MvpFailure> {
        LocalWtsService::get_agent_turn_changes(self, conversation_id, request_id)
            .map_err(map_local_mvp_error)
    }
    fn get_agent_turn_decisions(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentTurnDecisions, MvpFailure> {
        LocalWtsService::get_agent_turn_decisions(self, conversation_id, request_id)
            .map_err(map_local_mvp_error)
    }
    fn record_agent_turn_decision(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: wts_app::RecordAgentTurnDecisionRequest,
    ) -> Result<wts_app::AgentTurnDecisions, MvpFailure> {
        LocalWtsService::record_agent_turn_decision(self, conversation_id, turn_request_id, request)
            .map_err(map_local_mvp_error)
    }
    fn get_agent_turn_checks(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentTurnChecks, MvpFailure> {
        LocalWtsService::get_agent_turn_checks(self, conversation_id, request_id)
            .map_err(map_local_mvp_error)
    }
    fn run_agent_turn_check(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: wts_app::RunAgentTurnCheckRequest,
    ) -> Result<wts_app::AgentTurnChecks, MvpFailure> {
        LocalWtsService::run_agent_turn_check(self, conversation_id, turn_request_id, request)
            .map_err(map_local_mvp_error)
    }
    fn preflight_agent_turn_restore(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<wts_app::AgentTurnRestorePreflight, MvpFailure> {
        LocalWtsService::preflight_agent_turn_restore(self, conversation_id, request_id)
            .map_err(map_local_mvp_error)
    }
    fn restore_agent_turn(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: wts_app::AgentTurnRestoreRequest,
    ) -> Result<wts_app::AgentTurnRestoreResult, MvpFailure> {
        LocalWtsService::restore_agent_turn(self, conversation_id, turn_request_id, request)
            .map_err(map_local_mvp_error)
    }
    fn send_agent_conversation_message(
        &self,
        id: Uuid,
        request: wts_app::SendAgentConversationMessageRequest,
    ) -> Result<wts_app::AgentConversation, MvpFailure> {
        LocalWtsService::send_agent_conversation_message(self, id, request)
            .map_err(map_local_mvp_error)
    }
    fn update_agent_conversation_message(
        &self,
        id: Uuid,
        message_id: Uuid,
        request: wts_app::UpdateAgentConversationMessageRequest,
    ) -> Result<wts_app::AgentConversation, MvpFailure> {
        LocalWtsService::update_agent_conversation_message(self, id, message_id, request)
            .map_err(map_local_mvp_error)
    }
    fn cancel_agent_conversation_message(
        &self,
        id: Uuid,
        message_id: Uuid,
        request: wts_app::CancelAgentConversationMessageRequest,
    ) -> Result<wts_app::AgentConversation, MvpFailure> {
        LocalWtsService::cancel_agent_conversation_message(self, id, message_id, request)
            .map_err(map_local_mvp_error)
    }
    fn get_agent_session_detail(&self, session_id: Uuid) -> Result<AgentSessionDetail, MvpFailure> {
        LocalWtsService::get_agent_session_detail(self, session_id).map_err(map_local_mvp_error)
    }

    fn start_agent_session(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        terminal: TerminalProvider,
        category: AgentSessionCategory,
    ) -> Result<AgentSession, MvpFailure> {
        LocalWtsService::start_agent_session(self, workspace_id, provider, terminal, category)
            .map_err(map_local_mvp_error)
    }

    fn heartbeat_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
        LocalWtsService::heartbeat_agent_session(self, session_id).map_err(map_local_mvp_error)
    }

    fn finish_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
        LocalWtsService::finish_agent_session(self, session_id).map_err(map_local_mvp_error)
    }

    fn fail_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
        LocalWtsService::fail_agent_session(self, session_id, AgentSessionFailure::ProviderFailed)
            .map_err(map_local_mvp_error)
    }

    fn launch_agent_session(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        prompt: &str,
        category: AgentSessionCategory,
    ) -> Result<AgentSession, MvpFailure> {
        LocalWtsService::launch_agent_session(self, workspace_id, provider, prompt, category)
            .map_err(map_local_mvp_error)
    }

    fn stop_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
        LocalWtsService::stop_agent_session(self, session_id).map_err(map_local_mvp_error)
    }

    fn get_verification_summary(&self, workspace_id: Uuid) -> Result<Option<WorkspaceVerificationSummary>, MvpFailure> {
        self.get_workspace_verification_summary(workspace_id).map_err(map_local_mvp_error)
    }

    fn get_evidence(&self, workspace_id: Uuid) -> Result<Option<Self::Evidence>, MvpFailure> {
        self.get_workspace_evidence(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn promote_agent_check(
        &self,
        workspace_id: Uuid,
        proposal_id: &str,
    ) -> Result<Self::Evidence, MvpFailure> {
        self.promote_agent_verification_check(workspace_id, proposal_id)
            .map_err(map_local_mvp_error)
    }

    fn run_code_review(
        &self,
        workspace_id: Uuid,
        provider: AgentProvider,
        scope: CodeReviewScope,
        options: CodeReviewOptions,
    ) -> Result<Self::CodeReview, MvpFailure> {
        self.run_workspace_code_review_with_options(workspace_id, provider, scope, options)
            .map_err(map_local_mvp_error)
    }

    fn get_code_review(&self, workspace_id: Uuid) -> Result<Option<Self::CodeReview>, MvpFailure> {
        self.get_workspace_code_review(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn agent_models(&self, refresh: bool) -> Result<AgentModelCatalog, MvpFailure> {
        Ok(self.agent_model_catalog(refresh))
    }

    fn code_review_trace(
        &self,
        workspace_id: Uuid,
        after: Option<u32>,
    ) -> Result<Option<wts_app::CodeReviewTrace>, MvpFailure> {
        Ok(self.workspace_code_review_trace(workspace_id, after))
    }

    fn run_verification(&self, workspace_id: Uuid) -> Result<Self::Evidence, MvpFailure> {
        self.run_workspace_verification(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn run_verification_check(
        &self,
        workspace_id: Uuid,
        check_id: &str,
    ) -> Result<Self::Evidence, MvpFailure> {
        self.run_workspace_verification_check(workspace_id, check_id)
            .map_err(map_local_mvp_error)
    }

    fn rerun_failed_verification(&self, workspace_id: Uuid) -> Result<Self::Evidence, MvpFailure> {
        self.rerun_failed_workspace_verification(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn cancel_verification(&self, workspace_id: Uuid) -> Result<Self::Evidence, MvpFailure> {
        self.cancel_workspace_verification(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn list_test_runs(&self, workspace_id: Uuid) -> Result<Self::TestRunList, MvpFailure> {
        self.list_workspace_test_runs(workspace_id)
            .map_err(map_local_mvp_error)
    }

    fn get_test_run(
        &self,
        workspace_id: Uuid,
        run_id: Uuid,
    ) -> Result<Self::TestRunDetail, MvpFailure> {
        self.get_workspace_test_run(workspace_id, run_id)
            .map_err(map_local_mvp_error)
    }

    fn run_test_journey(
        &self,
        workspace_id: Uuid,
        journey_id: &str,
        base_url: &str,
    ) -> Result<Self::TestRun, MvpFailure> {
        self.run_workspace_test_journey(workspace_id, journey_id, base_url)
            .map_err(map_local_mvp_error)
    }

    fn verify_jira(&self) -> Result<Self::JiraVerification, MvpFailure> {
        self.verify_jira_mcp().map_err(map_local_mvp_error)
    }

    fn active_jira_issues(&self) -> Result<Self::JiraActiveIssues, MvpFailure> {
        LocalWtsService::active_jira_issues(self).map_err(map_local_mvp_error)
    }

    fn activity_watch_time_review_brief(
        &self,
        started_at_unix_ms: i64,
        ended_at_unix_ms: i64,
        endpoint: Option<&str>,
    ) -> Result<Self::TimeReviewBrief, MvpFailure> {
        LocalWtsService::activity_watch_time_review_brief(
            self,
            started_at_unix_ms,
            ended_at_unix_ms,
            endpoint,
        )
        .map_err(map_local_mvp_error)
    }

    fn import_jira(&self, issue_key: &str) -> Result<Self::JiraIssue, MvpFailure> {
        self.import_jira_issue(issue_key)
            .map_err(map_local_mvp_error)
    }

    fn verify_open_project(&self) -> Result<Self::OpenProjectVerification, MvpFailure> {
        LocalWtsService::verify_open_project(self).map_err(map_local_mvp_error)
    }

    fn import_open_project_work_package(
        &self,
        reference: &str,
    ) -> Result<Self::OpenProjectWorkPackage, MvpFailure> {
        LocalWtsService::import_open_project_work_package(self, reference)
            .map_err(map_local_mvp_error)
    }
}

fn map_store_error(error: WorkspaceStoreError) -> RegistryFailure {
    // Keep storage and local-path details out of HTTP responses. This match is
    // refined against the store's public semantic variants below; unknown I/O
    // failures remain intentionally opaque.
    match error {
        WorkspaceStoreError::Validation(error) => RegistryFailure::Validation(error.to_string()),
        WorkspaceStoreError::InvalidIdempotencyKey => {
            RegistryFailure::Validation("Idempotency-Key is invalid.".to_owned())
        }
        WorkspaceStoreError::IdempotencyConflict { .. } => RegistryFailure::Conflict,
        WorkspaceStoreError::WorkspaceNotFound { .. } => RegistryFailure::NotFound,
        _ => RegistryFailure::Unavailable,
    }
}

fn map_local_registry_error(error: LocalWtsError) -> RegistryFailure {
    match error {
        LocalWtsError::Store(error) => map_store_error(error),
        LocalWtsError::RepositoryCatalogUnavailable => {
            RegistryFailure::RepositoryCatalogUnavailable
        }
        LocalWtsError::RepositoryNotFound => RegistryFailure::RepositoryNotFound,
        LocalWtsError::RepositoryChanged => RegistryFailure::RepositoryChanged,
        LocalWtsError::InvalidRepositoryBase => RegistryFailure::InvalidRepositoryBase,
        LocalWtsError::RepositoryBaseNotFound => RegistryFailure::RepositoryBaseNotFound,
        LocalWtsError::InvalidRuntimeAnalysisRequest => {
            RegistryFailure::InvalidRuntimeAnalysisRequest
        }
        LocalWtsError::RuntimeAnalysisUnavailable => RegistryFailure::RuntimeAnalysisUnavailable,
        LocalWtsError::StaleRuntimeAnalysis => RegistryFailure::StaleRuntimeAnalysis,
        LocalWtsError::InvalidRuntimeSelection => RegistryFailure::InvalidRuntimeSelection,
        LocalWtsError::WorkspaceNotFound => RegistryFailure::NotFound,
        _ => RegistryFailure::Unavailable,
    }
}

fn map_local_mvp_error(error: LocalWtsError) -> MvpFailure {
    match error {
        LocalWtsError::InvalidRepositoryRoot => MvpFailure::InvalidLocalConfiguration,
        LocalWtsError::RepositoryCatalogUnavailable => MvpFailure::RepositoryCatalogUnavailable,
        LocalWtsError::InvalidRepositoryRemote => MvpFailure::InvalidRepositoryRemote,
        LocalWtsError::RepositoryCloneConflict => MvpFailure::RepositoryCloneConflict,
        LocalWtsError::RepositoryCloneBranchUnavailable => {
            MvpFailure::RepositoryCloneBranchUnavailable
        }
        LocalWtsError::RepositoryCloneFailed => MvpFailure::RepositoryCloneFailed,
        LocalWtsError::RepositoryFetchFailed => MvpFailure::RepositoryFetchFailed,
        LocalWtsError::RepositoryNotFound => MvpFailure::RepositoryNotFound,
        LocalWtsError::InvalidRepositoryFilePath => MvpFailure::InvalidRepositoryFilePath,
        LocalWtsError::RepositoryFileUnavailable => MvpFailure::RepositoryFileUnavailable,
        LocalWtsError::RepositoryFileNotText => MvpFailure::RepositoryFileNotText,
        LocalWtsError::RepositoryFileTooLarge => MvpFailure::RepositoryFileTooLarge,
        LocalWtsError::RepositoryFileConflict => MvpFailure::RepositoryFileConflict,
        LocalWtsError::InvalidRepositoryFileRevision => MvpFailure::InvalidRepositoryFileRevision,
        LocalWtsError::GitlabComparisonUnavailable => MvpFailure::GitlabComparisonUnavailable,
        LocalWtsError::GitlabMergeRequestLinkUnavailable => {
            MvpFailure::GitlabMergeRequestLinkUnavailable
        }
        LocalWtsError::RepositoryChanged => MvpFailure::RepositoryChanged,
        LocalWtsError::InvalidRepositoryBase => MvpFailure::InvalidRepositoryBase,
        LocalWtsError::RepositoryBaseNotFound => MvpFailure::RepositoryBaseNotFound,
        LocalWtsError::RepositoryForgeUnsupported => MvpFailure::RepositoryForgeUnsupported,
        LocalWtsError::GitlabReviewCommentFailed => MvpFailure::GitlabReviewCommentFailed,
        LocalWtsError::GitlabDiscussionsUnavailable => MvpFailure::GitlabDiscussionsUnavailable,
        LocalWtsError::GitlabDiscussionReplyFailed => MvpFailure::GitlabDiscussionReplyFailed,
        LocalWtsError::ChangeRequestBranchNotPublished => {
            MvpFailure::ChangeRequestBranchNotPublished
        }
        LocalWtsError::ChangeRequestBranchPublishFailed => {
            MvpFailure::ChangeRequestBranchPublishFailed
        }
        LocalWtsError::InvalidChangeRequestBranchName => MvpFailure::InvalidChangeRequestBranchName,
        LocalWtsError::ChangeRequestBranchAuthenticationFailed => {
            MvpFailure::ChangeRequestBranchAuthenticationFailed
        }
        LocalWtsError::ChangeRequestBranchNetworkFailed => {
            MvpFailure::ChangeRequestBranchNetworkFailed
        }
        LocalWtsError::ChangeRequestBranchRejected => MvpFailure::ChangeRequestBranchRejected,
        LocalWtsError::ChangeRequestRemoteMismatch => MvpFailure::ChangeRequestRemoteMismatch,
        LocalWtsError::ChangeRequestWorktreeDirty => MvpFailure::ChangeRequestWorktreeDirty,
        LocalWtsError::ChangeRequestForkUnsupported => MvpFailure::ChangeRequestForkUnsupported,
        LocalWtsError::ChangeRequestAgentProposalUnavailable => {
            MvpFailure::ChangeRequestAgentProposalUnavailable
        }
        LocalWtsError::ChangeRequestAgentProposalInvalid => {
            MvpFailure::ChangeRequestAgentProposalInvalid
        }
        LocalWtsError::InvalidChangeRequestDraft => MvpFailure::InvalidChangeRequestDraft,
        LocalWtsError::StaleChangeRequestDraft => MvpFailure::StaleChangeRequestDraft,
        LocalWtsError::BrowserUnavailable => MvpFailure::BrowserUnavailable,
        LocalWtsError::BrowserLaunchRejected => MvpFailure::BrowserLaunchRejected,
        LocalWtsError::JiraBrowserUrlUnavailable => MvpFailure::JiraBrowserUrlUnavailable,
        LocalWtsError::InvalidCodeWorkspaceImport => MvpFailure::InvalidCodeWorkspaceImport,
        LocalWtsError::CodeWorkspaceImportTooLarge => MvpFailure::CodeWorkspaceImportTooLarge,
        LocalWtsError::InvalidRuntimeAnalysisRequest => MvpFailure::InvalidRuntimeAnalysisRequest,
        LocalWtsError::RuntimeAnalysisUnavailable => MvpFailure::RuntimeAnalysisUnavailable,
        LocalWtsError::StaleRuntimeAnalysis => MvpFailure::StaleRuntimeAnalysis,
        LocalWtsError::InvalidRuntimeSelection => MvpFailure::InvalidRuntimeSelection,
        LocalWtsError::WorkspaceNotFound => MvpFailure::WorkspaceNotFound,
        LocalWtsError::PlanningNotConfigured => MvpFailure::PlanningNotConfigured,
        LocalWtsError::PlanningDocumentUnavailable => MvpFailure::PlanningDocumentUnavailable,
        LocalWtsError::InvalidPlanningDocument => MvpFailure::InvalidPlanningDocument,
        LocalWtsError::PlanningDocumentTooLarge => MvpFailure::PlanningDocumentTooLarge,
        LocalWtsError::PlanningDocumentConflict => MvpFailure::PlanningDocumentConflict,
        LocalWtsError::InvalidReviewThread => MvpFailure::InvalidReviewThread,
        LocalWtsError::ReviewCommentTooLarge => MvpFailure::ReviewCommentTooLarge,
        LocalWtsError::ReviewThreadNotFound => MvpFailure::ReviewThreadNotFound,
        LocalWtsError::ReviewThreadConflict => MvpFailure::ReviewThreadConflict,
        LocalWtsError::WorkspaceRenameConflict
        | LocalWtsError::WorkspaceRenameBusy
        | LocalWtsError::WorkspaceRenameFailed { .. } => MvpFailure::Unavailable,
        LocalWtsError::PreflightBlocked { .. } => MvpFailure::PreflightBlocked,
        LocalWtsError::StalePreflight => MvpFailure::StalePreflight,
        LocalWtsError::MaterializationFailed {
            cleanup_complete: true,
        } => MvpFailure::MaterializationFailed,
        LocalWtsError::MaterializationFailed {
            cleanup_complete: false,
        } => MvpFailure::MaterializationCleanupIncomplete,
        LocalWtsError::GeneratedFileFailed {
            cleanup_complete: true,
        } => MvpFailure::GeneratedWorkspaceFailed,
        LocalWtsError::GeneratedFileFailed {
            cleanup_complete: false,
        } => MvpFailure::GeneratedWorkspaceCleanupIncomplete,
        LocalWtsError::NotMaterialized => MvpFailure::WorkspaceNotMaterialized,
        LocalWtsError::InvalidMaterializationManifest => MvpFailure::InvalidMaterializationManifest,
        LocalWtsError::WorkspaceGitStateChanged => MvpFailure::WorkspaceGitStateChanged,
        LocalWtsError::RepositorySyncBlocked => MvpFailure::RepositorySyncBlocked,
        LocalWtsError::RepositorySyncDiverged => MvpFailure::RepositorySyncDiverged,
        LocalWtsError::RepositorySyncFailed => MvpFailure::RepositorySyncFailed,
        LocalWtsError::RepositorySyncBusy => MvpFailure::RepositorySyncBusy,
        LocalWtsError::RepositoryAlreadyInWorkspace => MvpFailure::RepositoryAlreadyInWorkspace,
        LocalWtsError::RepositoryAdditionStale => MvpFailure::RepositoryAdditionStale,
        LocalWtsError::RepositoryAdditionFailed {
            cleanup_complete: true,
        } => MvpFailure::RepositoryAdditionFailed,
        LocalWtsError::RepositoryAdditionFailed {
            cleanup_complete: false,
        } => MvpFailure::RepositoryAdditionCleanupIncomplete,
        LocalWtsError::RepositoryRemovalBlocked => MvpFailure::RepositoryRemovalBlocked,
        LocalWtsError::RepositoryRemovalFailed => MvpFailure::RepositoryRemovalFailed,
        LocalWtsError::RepositoryAlignmentStale => MvpFailure::RepositoryAlignmentStale,
        LocalWtsError::RepositoryAlignmentFailed => MvpFailure::RepositoryAlignmentFailed,
        LocalWtsError::EvidenceUnavailable => MvpFailure::WorkspaceEvidenceUnavailable,
        LocalWtsError::InvalidWorkspaceEvidence => MvpFailure::InvalidWorkspaceEvidence,
        LocalWtsError::InvalidTestJourney => MvpFailure::InvalidTestJourney,
        LocalWtsError::TestRunnerUnavailable => MvpFailure::TestRunnerUnavailable,
        LocalWtsError::TestRunnerFailed => MvpFailure::TestRunnerFailed,
        LocalWtsError::TestRunnerBusy => MvpFailure::TestRunnerBusy,
        LocalWtsError::TestRunnerTimedOut => MvpFailure::TestRunnerTimedOut,
        LocalWtsError::TestRunnerOutputTooLarge => MvpFailure::TestRunnerOutputTooLarge,
        LocalWtsError::TestEvidenceUnavailable => MvpFailure::TestEvidenceUnavailable,
        LocalWtsError::TestRunNotFound => MvpFailure::TestRunNotFound,
        LocalWtsError::InvalidTestEvidence => MvpFailure::InvalidTestEvidence,
        LocalWtsError::VscodeUnavailable => MvpFailure::VscodeUnavailable,
        LocalWtsError::VscodeLaunchRejected => MvpFailure::VscodeLaunchRejected,
        LocalWtsError::AdapterUnavailable => MvpFailure::AdapterUnavailable,
        LocalWtsError::AdapterRejected => MvpFailure::AdapterRejected,
        LocalWtsError::AdapterTimedOut => MvpFailure::AdapterTimedOut,
        LocalWtsError::AdapterOutputTooLarge => MvpFailure::AdapterOutputTooLarge,
        LocalWtsError::GraphIndexFailed => MvpFailure::GraphIndexFailed,
        LocalWtsError::GraphRequired => MvpFailure::GraphRequired,
        LocalWtsError::RemovalBlocked { .. } => MvpFailure::WorkspaceRemovalBlocked,
        LocalWtsError::RemovalFailed => MvpFailure::WorkspaceRemovalFailed,
        LocalWtsError::InvalidAgentConversation => MvpFailure::InvalidAgentConversation,
        LocalWtsError::AgentConversationNotFound => MvpFailure::AgentConversationNotFound,
        LocalWtsError::AgentConversationConflict => MvpFailure::AgentConversationConflict,
        LocalWtsError::AgentConversationBusy => MvpFailure::AgentConversationBusy,
        LocalWtsError::AgentConversationQueueFull => MvpFailure::AgentConversationQueueFull,
        LocalWtsError::AgentConversationPlatformUnavailable => {
            MvpFailure::AgentConversationPlatformUnavailable
        }
        LocalWtsError::AgentConversationStorageFull => MvpFailure::AgentConversationStorageFull,
        LocalWtsError::AgentConversationLimit => MvpFailure::AgentConversationLimit,
        LocalWtsError::AgentConversationSourceUnavailable => {
            MvpFailure::AgentConversationSourceUnavailable
        }
        LocalWtsError::AgentConversationUnavailable => MvpFailure::AgentConversationUnavailable,
        LocalWtsError::InvalidAgentPrompt => MvpFailure::InvalidAgentPrompt,
        LocalWtsError::AgentSessionUnavailable => MvpFailure::AgentSessionUnavailable,
        LocalWtsError::InvalidAgentSessionStore => MvpFailure::InvalidAgentSessionStore,
        LocalWtsError::AgentSessionNotFound => MvpFailure::AgentSessionNotFound,
        LocalWtsError::AgentSessionNotRunning => MvpFailure::AgentSessionNotRunning,
        LocalWtsError::AgentProposalUnavailable => MvpFailure::AgentProposalUnavailable,
        LocalWtsError::VerificationCheckUnavailable => MvpFailure::VerificationCheckUnavailable,
        LocalWtsError::VerificationRunUnavailable => MvpFailure::VerificationRunUnavailable,
        LocalWtsError::JiraMcp(JiraMcpError::InvalidIssueKey) => MvpFailure::InvalidJiraIssueKey,
        LocalWtsError::JiraMcp(JiraMcpError::ConfigurationMissing) => {
            MvpFailure::JiraMcpUnavailable
        }
        LocalWtsError::JiraMcp(
            JiraMcpError::ConfigurationUnsupported | JiraMcpError::ConfigurationInvalid,
        ) => MvpFailure::JiraMcpConfiguration,
        LocalWtsError::JiraMcp(JiraMcpError::SpawnFailed) => MvpFailure::JiraMcpSpawnFailed,
        LocalWtsError::JiraMcp(JiraMcpError::ProtocolTimedOut) => MvpFailure::JiraMcpTimedOut,
        LocalWtsError::JiraMcp(JiraMcpError::ProtocolInvalid) => MvpFailure::JiraMcpProtocolInvalid,
        LocalWtsError::JiraMcp(
            JiraMcpError::IssueToolMissing | JiraMcpError::SearchToolMissing,
        ) => MvpFailure::JiraMcpIssueToolMissing,
        LocalWtsError::JiraMcp(JiraMcpError::ToolCallFailed) => MvpFailure::JiraMcpToolCallFailed,
        LocalWtsError::JiraMcp(JiraMcpError::OutputTooLarge) => MvpFailure::JiraMcpOutputTooLarge,
        LocalWtsError::OpenProject(OpenProjectError::InvalidReference) => {
            MvpFailure::InvalidOpenProjectReference
        }
        LocalWtsError::OpenProject(
            OpenProjectError::EndpointMissing
            | OpenProjectError::TokenMissing
            | OpenProjectError::InvalidEndpoint
            | OpenProjectError::InvalidToken
            | OpenProjectError::ClientInitializationFailed,
        ) => MvpFailure::OpenProjectConfiguration,
        LocalWtsError::OpenProject(OpenProjectError::AuthenticationFailed) => {
            MvpFailure::OpenProjectAuthentication
        }
        LocalWtsError::OpenProject(OpenProjectError::PermissionDenied) => {
            MvpFailure::OpenProjectPermission
        }
        LocalWtsError::OpenProject(OpenProjectError::ResourceNotFound) => {
            MvpFailure::OpenProjectNotFound
        }
        LocalWtsError::OpenProject(OpenProjectError::AmbiguousReference) => {
            MvpFailure::OpenProjectAmbiguous
        }
        LocalWtsError::OpenProject(OpenProjectError::RequestTimedOut) => {
            MvpFailure::OpenProjectTimedOut
        }
        LocalWtsError::OpenProject(OpenProjectError::ResponseTooLarge) => {
            MvpFailure::OpenProjectResponseTooLarge
        }
        LocalWtsError::OpenProject(OpenProjectError::RateLimited) => {
            MvpFailure::OpenProjectRateLimited
        }
        LocalWtsError::OpenProject(
            OpenProjectError::RequestFailed
            | OpenProjectError::ResponseInvalid
            | OpenProjectError::ServerRejected,
        ) => MvpFailure::OpenProjectRemoteFailure,
        LocalWtsError::ActivityWatch(_) | LocalWtsError::ActivityWatchReview(_) => {
            MvpFailure::Unavailable
        }
        LocalWtsError::Store(WorkspaceStoreError::TombstoneIdempotencyConflict { .. }) => {
            MvpFailure::IdempotencyConflict
        }
        LocalWtsError::Store(WorkspaceStoreError::WorkspaceWorkflowConflict { .. }) => {
            MvpFailure::WorkspaceWorkflowConflict
        }
        LocalWtsError::Store(WorkspaceStoreError::InvalidWorkspaceBoardPlacement) => {
            MvpFailure::InvalidWorkspaceBoardPlacement
        }
        LocalWtsError::Store(WorkspaceStoreError::InvalidWorkItemLink) => {
            MvpFailure::InvalidWorkItemLink
        }
        LocalWtsError::Store(WorkspaceStoreError::StaleWorkItemLinkPreview) => {
            MvpFailure::StaleWorkItemLinkPreview
        }
        LocalWtsError::Store(WorkspaceStoreError::WorkItemLinkIdempotencyConflict { .. }) => {
            MvpFailure::WorkItemLinkIdempotencyConflict
        }
        LocalWtsError::Store(WorkspaceStoreError::WorkItemLinkAlreadyExists) => {
            MvpFailure::WorkItemLinkAlreadyExists
        }
        LocalWtsError::Store(WorkspaceStoreError::PrimaryWorkItemLinkAlreadyExists) => {
            MvpFailure::PrimaryWorkItemLinkAlreadyExists
        }
        LocalWtsError::Store(WorkspaceStoreError::WorkItemLinkNotFound { .. }) => {
            MvpFailure::WorkItemLinkNotFound
        }
        LocalWtsError::Store(WorkspaceStoreError::WorkItemLinkConflict { .. }) => {
            MvpFailure::WorkItemLinkConflict
        }
        LocalWtsError::Store(_) => MvpFailure::Unavailable,
    }
}

struct AppState<R: MvpBackend> {
    registry: Arc<R>,
    security: SecurityPolicy,
    health: Arc<Health>,
    demo_boundary: Arc<WorkspaceBoundary>,
    admission: AdmissionController,
}

impl<R: MvpBackend> Clone for AppState<R> {
    fn clone(&self) -> Self {
        Self {
            registry: Arc::clone(&self.registry),
            security: self.security.clone(),
            health: Arc::clone(&self.health),
            demo_boundary: Arc::clone(&self.demo_boundary),
            admission: self.admission.clone(),
        }
    }
}

#[derive(Clone, Copy)]
struct AdmissionLimits {
    reads: usize,
    scans: usize,
    heavy: usize,
    remote: usize,
}

impl Default for AdmissionLimits {
    fn default() -> Self {
        Self {
            reads: DEFAULT_READ_OPERATION_LIMIT,
            scans: DEFAULT_SCAN_OPERATION_LIMIT,
            heavy: DEFAULT_HEAVY_OPERATION_LIMIT,
            remote: DEFAULT_REMOTE_READ_OPERATION_LIMIT,
        }
    }
}

#[derive(Clone, Copy)]
enum OperationClass {
    Read,
    Scan,
    Heavy,
    RemoteRead,
}

#[derive(Clone)]
struct AdmissionController {
    reads: Arc<Semaphore>,
    scans: Arc<Semaphore>,
    heavy: Arc<Semaphore>,
    remote: Arc<Semaphore>,
}

impl AdmissionController {
    fn new(limits: AdmissionLimits) -> Self {
        assert!(limits.reads > 0, "read admission limit must be non-zero");
        assert!(limits.scans > 0, "scan admission limit must be non-zero");
        assert!(limits.heavy > 0, "heavy admission limit must be non-zero");
        assert!(limits.remote > 0, "remote read admission limit must be non-zero");
        Self {
            reads: Arc::new(Semaphore::new(limits.reads)),
            scans: Arc::new(Semaphore::new(limits.scans)),
            heavy: Arc::new(Semaphore::new(limits.heavy)),
            remote: Arc::new(Semaphore::new(limits.remote)),
        }
    }

    fn try_acquire(&self, class: OperationClass) -> Result<OwnedSemaphorePermit, ApiError> {
        let semaphore = match class {
            OperationClass::Read => &self.reads,
            OperationClass::Scan => &self.scans,
            OperationClass::Heavy => &self.heavy,
            OperationClass::RemoteRead => &self.remote,
        };
        Arc::clone(semaphore)
            .try_acquire_owned()
            .map_err(|_| ApiError::capacity_exhausted(class))
    }

    /// Remote reads queue for a short time. A user who opens a review view
    /// should see the data a moment later instead of a capacity error.
    async fn admit(&self, class: OperationClass) -> Result<OwnedSemaphorePermit, ApiError> {
        if !matches!(class, OperationClass::RemoteRead) {
            return self.try_acquire(class);
        }
        match tokio::time::timeout(
            REMOTE_READ_ADMISSION_WAIT,
            Arc::clone(&self.remote).acquire_owned(),
        )
        .await
        {
            Ok(Ok(permit)) => Ok(permit),
            _ => Err(ApiError::capacity_exhausted(class)),
        }
    }
}

pub fn build_router<R: MvpBackend>(
    registry: Arc<R>,
    security: SecurityPolicy,
    ui_dist: Option<&Path>,
) -> Router {
    build_router_with_admission_limits(registry, security, ui_dist, AdmissionLimits::default())
}

fn build_router_with_admission_limits<R: MvpBackend>(
    registry: Arc<R>,
    security: SecurityPolicy,
    ui_dist: Option<&Path>,
    admission_limits: AdmissionLimits,
) -> Router {
    let state = AppState {
        registry,
        security: security.clone(),
        health: Arc::new(Health {
            status: "ok",
            service: "wts-server",
            version: env!("CARGO_PKG_VERSION"),
            ui_available: ui_dist.is_some(),
        }),
        demo_boundary: Arc::new(
            demo_boundary().expect("the fixed demonstration boundary must remain valid"),
        ),
        admission: AdmissionController::new(admission_limits),
    };

    let protected_registry = Router::new()
        .route("/setup", get(setup_snapshot::<R>))
        .route("/agent-models", get(get_agent_models::<R>))
        .route("/reviews/github", get(get_github_review_inbox::<R>))
        .route("/reviews/gitlab", get(get_gitlab_review_inbox::<R>))
        .route(
            "/reviews/gitlab/{repository_id}/{iid}/discussions",
            get(get_gitlab_discussions::<R>),
        )
        .route(
            "/reviews/gitlab/{repository_id}/{iid}/discussions/reply",
            axum::routing::post(reply_gitlab_discussion::<R>),
        )
        .route(
            "/reviews/gitlab/{repository_id}/{iid}/comments",
            axum::routing::post(publish_gitlab_review_comment::<R>)
                .layer(DefaultBodyLimit::max(16_384 * 6 + 8192)),
        )
        .route(
            "/reviews/github/{repository_id}/{number}/open",
            axum::routing::post(open_github_review::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/merge-requests/gitlab",
            get(get_gitlab_merge_requests::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/gitlab-merge-requests/{repository_id}/{iid}/link",
            axum::routing::post(link_workspace_gitlab_merge_request::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/integrations/gitlab",
            get(get_gitlab_integration_status::<R>),
        )
        .route(
            "/repositories/{repository_id}/merge-requests/gitlab/{iid}/open",
            axum::routing::post(open_gitlab_merge_request::<R>),
        )
        .route(
            "/reviews/gitlab/{repository_id}/{iid}/prepare-repository",
            axum::routing::post(prepare_gitlab_review_repository::<R>),
        )
        .route("/repositories", get(list_repositories::<R>))
        .route(
            "/repositories/clone",
            axum::routing::post(clone_repository::<R>),
        )
        .route(
            "/repositories/{repository_id}/branches/refresh",
            axum::routing::post(refresh_repository_branches::<R>),
        )
        .route(
            "/workspace-plans/runtime-analysis",
            axum::routing::post(analyze_workspace_runtime::<R>),
        )
        .route(
            "/repositories/{repository_id}/open/base",
            axum::routing::post(open_repository_base::<R>),
        )
        .route(
            "/workspaces",
            get(list_workspaces::<R>).post(create_workspace::<R>),
        )
        .route(
            "/workspaces/{workspace_id}",
            get(get_workspace::<R>).patch(rename_workspace::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/change-requests/prepare",
            axum::routing::post(prepare_workspace_change_request::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/change-requests/publish-branch",
            axum::routing::post(publish_workspace_change_request_branch::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/change-requests/open",
            axum::routing::post(open_workspace_change_request_draft::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/workflow",
            axum::routing::patch(transition_workspace_workflow::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/board-placement",
            axum::routing::patch(place_workspace_on_board::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/board-placement/follow-agent",
            axum::routing::patch(follow_workspace_agent::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/planning/documents",
            get(list_workspace_planning_documents::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/planning/documents/{document_id}",
            get(read_workspace_planning_document::<R>)
                .put(update_workspace_planning_document::<R>)
                .layer(DefaultBodyLimit::max(PLANNING_DOCUMENT_BODY_LIMIT_BYTES)),
        )
        .route(
            "/workspaces/{workspace_id}/review/threads",
            get(list_workspace_review_threads::<R>).post(create_workspace_review_thread::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/review/threads/{thread_id}/resolve",
            axum::routing::patch(resolve_workspace_review_thread::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/work-items",
            get(list_workspace_work_item_links::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/work-items/jira/preview",
            axum::routing::post(preview_workspace_jira_link::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/work-items/jira/confirm",
            axum::routing::post(confirm_workspace_jira_link::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/work-items/jira/open-preview",
            axum::routing::post(open_workspace_jira_preview::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/work-items/{link_id}",
            axum::routing::delete(unlink_workspace_work_item::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/work-items/{link_id}/open",
            axum::routing::post(open_workspace_work_item::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/work-items/jira/create-proposal",
            get(propose_workspace_jira_issue::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/preflight",
            get(preflight_workspace::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/setup-recovery",
            axum::routing::post(recover_workspace_setup::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/materialization",
            get(get_workspace_materialization::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/addition-preflight",
            axum::routing::post(preflight_workspace_repository_addition::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories",
            axum::routing::post(add_workspace_repository::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}",
            axum::routing::delete(remove_workspace_repository::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}/diff",
            get(get_workspace_repository_diff::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}/file",
            get(get_workspace_repository_file_review::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}/gitlab/{iid}/comparison",
            get(get_workspace_gitlab_comparison::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}/source",
            get(get_workspace_repository_source::<R>)
                .put(save_workspace_repository_source::<R>)
                .layer(DefaultBodyLimit::max(2 * 1024 * 1024 * 6 + 32 * 1024)),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}/review-graph",
            get(get_workspace_repository_review_graph::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}/sync",
            axum::routing::post(sync_workspace_repository::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}/alignment-preflight",
            axum::routing::post(preflight_workspace_repository_alignment::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/repositories/{repository_id}/align",
            axum::routing::post(align_workspace_repository::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/materialize",
            axum::routing::post(materialize_workspace::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/open/vscode",
            axum::routing::post(open_workspace_in_vscode::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/open/cli/{provider}",
            axum::routing::post(open_workspace_cli::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/agent-brief",
            axum::routing::put(write_workspace_agent_brief::<R>),
        )
        .route(
            "/agent-conversations",
            get(list_agent_conversations::<R>)
                .post(create_agent_conversation::<R>)
                .layer(DefaultBodyLimit::max(4 * 1024 * 1024)),
        )
        .route(
            "/agent-conversations/{conversation_id}",
            get(get_agent_conversation::<R>),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages",
            axum::routing::post(send_agent_conversation_message::<R>)
                .layer(DefaultBodyLimit::max(16_384 * 6 + 8192)),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages/{message_id}",
            axum::routing::patch(update_agent_conversation_message::<R>)
                .layer(DefaultBodyLimit::max(2 * 16_384 * 6 + 8192)),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages/{message_id}/changes",
            get(get_agent_turn_changes::<R>),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages/{message_id}/work-sets",
            get(list_agent_work_sets::<R>)
                .post(create_agent_work_set::<R>)
                .layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/agent-work-sets/{work_set_id}",
            get(get_agent_work_set::<R>),
        )
        .route(
            "/agent-work-sets/{work_set_id}/items/{task_id}/cancel",
            axum::routing::post(cancel_agent_work_item::<R>).layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/agent-work-sets/{work_set_id}/items/{task_id}/integration-preflight",
            get(preflight_agent_work_item_integration::<R>),
        )
        .route(
            "/agent-work-sets/{work_set_id}/items/{task_id}/integration",
            axum::routing::post(integrate_agent_work_item::<R>).layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages/{message_id}/decisions",
            get(get_agent_turn_decisions::<R>)
                .post(record_agent_turn_decision::<R>)
                .layer(DefaultBodyLimit::max(32768)),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages/{message_id}/checks",
            get(get_agent_turn_checks::<R>)
                .post(run_agent_turn_check::<R>)
                .layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages/{message_id}/restore-preflight",
            get(preflight_agent_turn_restore::<R>),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages/{message_id}/restore",
            axum::routing::post(restore_agent_turn::<R>).layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/agent-conversations/{conversation_id}/messages/{message_id}/cancel",
            axum::routing::post(cancel_agent_conversation_message::<R>)
                .layer(DefaultBodyLimit::max(16_384 * 6 + 8192)),
        )
        .route("/agent-sessions", get(list_agent_sessions::<R>))
        .route(
            "/agent-sessions/{session_id}",
            get(get_agent_session_detail::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/agent-sessions",
            axum::routing::post(start_agent_session::<R>),
        )
        .route(
            "/agent-sessions/{session_id}/heartbeat",
            axum::routing::post(heartbeat_agent_session::<R>),
        )
        .route(
            "/agent-sessions/{session_id}/complete",
            axum::routing::post(finish_agent_session::<R>),
        )
        .route(
            "/agent-sessions/{session_id}/fail",
            axum::routing::post(fail_agent_session::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/agents/{provider}/sessions",
            axum::routing::post(launch_agent_session::<R>),
        )
        .route(
            "/agent-sessions/{session_id}/stop",
            axum::routing::post(stop_agent_session::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/graph/index",
            axum::routing::post(index_workspace_graph::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/graph/reindex",
            axum::routing::post(reindex_workspace_graph::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/removal-preflight",
            get(preflight_workspace_removal::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/remove",
            axum::routing::post(remove_workspace::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/agents/{provider}/run",
            axum::routing::post(run_workspace_agent::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/evidence",
            get(get_workspace_evidence::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/verification/summary",
            get(get_workspace_verification_summary::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/verification/run",
            axum::routing::post(run_workspace_verification::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/code-review/run",
            axum::routing::post(run_workspace_code_review::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/code-review",
            get(get_workspace_code_review::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/code-review/trace",
            get(get_workspace_code_review_trace::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/verification/checks/{check_id}/run",
            axum::routing::post(run_workspace_verification_check::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/verification/failed/run",
            axum::routing::post(rerun_failed_workspace_verification::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/verification/cancel",
            axum::routing::post(cancel_workspace_verification::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/verification/agent-proposals/{proposal_id}/promote",
            axum::routing::post(promote_agent_verification_check::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/test-runs",
            get(list_workspace_test_runs::<R>).post(run_workspace_test_journey::<R>),
        )
        .route(
            "/workspaces/{workspace_id}/test-runs/{run_id}",
            get(get_workspace_test_run::<R>),
        )
        .route(
            "/integrations/jira-mcp/verify",
            axum::routing::post(verify_jira_mcp::<R>),
        )
        .route("/jira/issues/active", get(list_active_jira_issues::<R>))
        .route(
            "/integrations/activity-watch/status",
            get(activity_watch_status::<R>),
        )
        .route(
            "/integrations/activity-watch/daily-review",
            get(activity_watch_daily_review::<R>),
        )
        .route(
            "/integrations/activity-watch/time-review-brief",
            get(activity_watch_time_review_brief::<R>),
        )
        .route(
            "/jira/issues/{issue_key}/import",
            axum::routing::post(import_jira_issue::<R>),
        )
        .route(
            "/code-workspaces/import",
            axum::routing::post(import_code_workspace_file::<R>).layer(DefaultBodyLimit::max(
                CODE_WORKSPACE_IMPORT_BODY_LIMIT_BYTES,
            )),
        )
        .route(
            "/integrations/open-project/verify",
            axum::routing::post(verify_open_project::<R>),
        )
        .route(
            "/open-project/work-packages/{reference}/import",
            axum::routing::post(import_open_project_work_package::<R>),
        )
        .route_layer(middleware::from_fn_with_state(
            security.clone(),
            require_registry_access,
        ));

    let versioned_api = Router::new()
        .route("/bootstrap", get(bootstrap::<R>))
        .merge(protected_registry)
        .route_layer(middleware::from_fn_with_state(security, require_exact_host));

    let api = Router::new()
        .route("/health", get(health::<R>))
        .route("/demo-boundary", get(demo_boundary_json::<R>))
        .nest("/v1", versioned_api)
        .fallback(api_not_found)
        .layer(DefaultBodyLimit::max(API_BODY_LIMIT_BYTES))
        .layer(middleware::from_fn(add_no_store));

    let app = Router::new().nest("/api", api).with_state(state);
    let app = match ui_dist {
        Some(directory) => {
            let index = directory.join("index.html");
            app.fallback_service(ServeDir::new(directory).fallback(ServeFile::new(index)))
        }
        None => app.fallback(ui_not_built),
    };

    #[cfg(debug_assertions)]
    let app = app.layer(middleware::from_fn(log_development_http_request));

    app.layer(TraceLayer::new_for_http())
}

async fn health<R: MvpBackend>(State(state): State<AppState<R>>) -> Json<Health> {
    Json((*state.health).clone())
}

async fn bootstrap<R: MvpBackend>(State(state): State<AppState<R>>) -> Json<Bootstrap> {
    Json(Bootstrap {
        api_version: "v1",
        origin: state.security.origin().to_owned(),
        session_token: state.security.session_token().to_owned(),
    })
}

async fn setup_snapshot<R: MvpBackend>(
    State(state): State<AppState<R>>,
) -> Result<Json<R::Setup>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.setup()
    })
    .await
    .map(Json)
}

async fn get_github_review_inbox<R: MvpBackend>(
    State(state): State<AppState<R>>,
) -> Result<Json<R::GithubReviewInbox>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::RemoteRead, move || {
        backend.github_review_inbox()
    })
    .await
    .map(Json)
}

async fn open_github_review<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((repository_id, number)): AxumPath<(String, u64)>,
) -> Result<Json<R::GithubReviewOpen>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.open_github_review(&repository_id, number)
    })
    .await
    .map(Json)
}

async fn get_gitlab_review_inbox<R: MvpBackend>(
    State(state): State<AppState<R>>,
) -> Result<Json<R::GitlabReviewInbox>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::RemoteRead, move || {
        backend.gitlab_review_inbox()
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitlabDiscussionsQuery {
    workspace_id: Option<Uuid>,
}

async fn publish_gitlab_review_comment<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((repository_id, iid)): AxumPath<(String, u64)>,
    ApiJson(request): ApiJson<wts_app::GitlabReviewCommentRequest>,
) -> Result<Json<R::GitlabReviewCommentPublication>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.publish_gitlab_review_comment(&repository_id, iid, request)
    })
    .await
    .map(Json)
}

async fn get_gitlab_discussions<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((repository_id, iid)): AxumPath<(String, u64)>,
    Query(query): Query<GitlabDiscussionsQuery>,
) -> Result<Json<R::GitlabDiscussions>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::RemoteRead, move || {
        backend.gitlab_discussions(&repository_id, iid, query.workspace_id)
    })
    .await
    .map(Json)
}

async fn reply_gitlab_discussion<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((repository_id, iid)): AxumPath<(String, u64)>,
    ApiJson(request): ApiJson<wts_app::ReplyGitlabDiscussionRequest>,
) -> Result<Json<R::GitlabDiscussionReply>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.reply_gitlab_discussion(&repository_id, iid, request)
    })
    .await
    .map(Json)
}

async fn get_gitlab_merge_requests<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<Uuid>,
) -> Result<Json<R::GitlabMergeRequestInbox>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::RemoteRead, move || {
        backend.gitlab_merge_requests(workspace_id)
    })
    .await
    .map(Json)
}

async fn link_workspace_gitlab_merge_request<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id, iid)): AxumPath<(Uuid, String, u64)>,
) -> Result<Json<R::GitlabMergeRequestLink>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.link_workspace_gitlab_merge_request(workspace_id, &repository_id, iid)
    })
    .await
    .map(Json)
}

async fn get_gitlab_integration_status<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<Uuid>,
) -> Result<Json<R::GitlabIntegrationStatus>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::RemoteRead, move || {
        backend.gitlab_integration_status(workspace_id)
    })
    .await
    .map(Json)
}

async fn open_gitlab_merge_request<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((repository_id, iid)): AxumPath<(String, u64)>,
) -> Result<Json<R::GitlabMergeRequestOpen>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.open_gitlab_merge_request(&repository_id, iid)
    })
    .await
    .map(Json)
}

async fn prepare_gitlab_review_repository<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((repository_id, iid)): AxumPath<(String, u64)>,
) -> Result<Json<R::RepositoryClone>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.prepare_gitlab_review_repository(&repository_id, iid)
    })
    .await
    .map(Json)
}

async fn list_repositories<R: MvpBackend>(
    State(state): State<AppState<R>>,
) -> Result<Json<R::RepositoryCatalog>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.repositories()
    })
    .await
    .map(Json)
}

async fn clone_repository<R: MvpBackend>(
    State(state): State<AppState<R>>,
    ApiJson(request): ApiJson<CloneRepositoryRequest>,
) -> Result<Json<R::RepositoryClone>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.clone_repository(request)
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenRepositoryBaseRequest {
    base_ref: String,
}

async fn open_repository_base<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(repository_id): AxumPath<String>,
    ApiJson(request): ApiJson<OpenRepositoryBaseRequest>,
) -> Result<Json<R::RepositoryBaseOpen>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.open_repository_base(&repository_id, &request.base_ref)
    })
    .await
    .map(Json)
}

async fn prepare_workspace_change_request<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<Uuid>,
    ApiJson(request): ApiJson<PrepareWorkspaceChangeRequest>,
) -> Result<Json<R::ChangeRequestDraft>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.prepare_workspace_change_request(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn publish_workspace_change_request_branch<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<Uuid>,
    ApiJson(request): ApiJson<PublishWorkspaceChangeRequestBranch>,
) -> Result<Json<R::BranchPublication>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.publish_workspace_change_request_branch(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn open_workspace_change_request_draft<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<Uuid>,
    ApiJson(request): ApiJson<OpenWorkspaceChangeRequestDraft>,
) -> Result<Json<R::ChangeRequestOpen>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.open_workspace_change_request_draft(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn list_workspaces<R: MvpBackend>(
    State(state): State<AppState<R>>,
) -> Result<Json<R::WorkspaceList>, ApiError> {
    let registry = Arc::clone(&state.registry);
    run_registry_operation(&state.admission, OperationClass::Read, move || {
        registry.list()
    })
    .await
    .map(Json)
}

async fn get_workspace<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::Workspace>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let registry = Arc::clone(&state.registry);
    run_registry_operation(&state.admission, OperationClass::Read, move || {
        registry.get(workspace_id)
    })
    .await?
    .map(Json)
    .ok_or_else(ApiError::not_found)
}

async fn rename_workspace<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<RenameWorkspaceRequest>,
) -> Result<Json<R::Workspace>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let registry = Arc::clone(&state.registry);
    run_registry_operation(&state.admission, OperationClass::Read, move || {
        registry.rename(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn transition_workspace_workflow<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<TransitionWorkspaceWorkflowRequest>,
) -> Result<Json<R::Workflow>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.transition_workflow(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn place_workspace_on_board<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<PlaceWorkspaceOnBoardRequest>,
) -> Result<Json<R::Workflow>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.place_workspace_on_board(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn follow_workspace_agent<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<FollowWorkspaceAgentRequest>,
) -> Result<Json<R::Workflow>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.follow_workspace_agent(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn list_workspace_planning_documents<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::PlanningDocumentList>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.list_planning_documents(workspace_id)
    })
    .await
    .map(Json)
}

async fn read_workspace_planning_document<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, document_id)): AxumPath<(String, String)>,
) -> Result<Json<R::PlanningDocument>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let document_id = parse_planning_document_id(&document_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.read_planning_document(workspace_id, document_id)
    })
    .await
    .map(Json)
}

async fn update_workspace_planning_document<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, document_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<UpdateWorkspacePlanningDocumentRequest>,
) -> Result<Json<R::PlanningDocument>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let document_id = parse_planning_document_id(&document_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.update_planning_document(workspace_id, document_id, request)
    })
    .await
    .map(Json)
}

async fn list_workspace_review_threads<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::ReviewThreadList>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.list_review_threads(workspace_id)
    })
    .await
    .map(Json)
}

async fn create_workspace_review_thread<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<CreateWorkspaceReviewThreadRequest>,
) -> Result<Json<R::ReviewThread>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.create_review_thread(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn resolve_workspace_review_thread<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, thread_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<ResolveWorkspaceReviewThreadRequest>,
) -> Result<Json<R::ReviewThread>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let thread_id = parse_workspace_id(&thread_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.resolve_review_thread(workspace_id, thread_id, request)
    })
    .await
    .map(Json)
}

async fn preview_workspace_jira_link<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<PreviewWorkspaceJiraLinkRequest>,
) -> Result<Json<R::WorkItemLinkPreview>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.preview_jira_link(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn confirm_workspace_jira_link<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<ConfirmWorkspaceJiraLinkRequest>,
) -> Result<Json<R::WorkItemLinkConfirmation>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.confirm_jira_link(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn open_workspace_jira_preview<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<OpenWorkspaceJiraPreviewRequest>,
) -> Result<Json<R::WorkItemOpen>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.open_jira_preview(workspace_id, request)
    })
    .await
    .map(Json)
}

async fn list_workspace_work_item_links<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::WorkItemLinkList>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.list_work_item_links(workspace_id)
    })
    .await
    .map(Json)
}

async fn unlink_workspace_work_item<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, link_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<UnlinkWorkspaceWorkItemRequest>,
) -> Result<Json<R::WorkItemUnlink>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let link_id = parse_workspace_id(&link_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.unlink_work_item(workspace_id, link_id, request)
    })
    .await
    .map(Json)
}

async fn open_workspace_work_item<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, link_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<OpenWorkspaceWorkItemRequest>,
) -> Result<Json<R::WorkItemOpen>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let link_id = parse_workspace_id(&link_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.open_work_item(workspace_id, link_id, request)
    })
    .await
    .map(Json)
}

async fn propose_workspace_jira_issue<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::JiraCreateProposal>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.propose_jira_issue(workspace_id)
    })
    .await
    .map(Json)
}

async fn create_workspace<R: MvpBackend>(
    State(state): State<AppState<R>>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<CreateWorkspaceRequest>,
) -> Result<Response, ApiError> {
    let idempotency_key = exactly_one_header(&headers, IDEMPOTENCY_HEADER)
        .ok_or_else(ApiError::missing_idempotency_key)?;
    validate_idempotency_key(idempotency_key)?;

    let idempotency_key = idempotency_key.to_owned();
    let registry = Arc::clone(&state.registry);
    let outcome = run_registry_operation(&state.admission, OperationClass::Heavy, move || {
        registry.create(&idempotency_key, request)
    })
    .await?;
    let replayed = outcome.replayed;
    let status = if replayed {
        StatusCode::OK
    } else {
        StatusCode::CREATED
    };
    let mut response = (status, Json(outcome)).into_response();
    response.headers_mut().insert(
        "x-wts-idempotent-replay",
        HeaderValue::from_static(if replayed { "true" } else { "false" }),
    );
    Ok(response)
}

async fn analyze_workspace_runtime<R: MvpBackend>(
    State(state): State<AppState<R>>,
    ApiJson(request): ApiJson<RuntimeAnalysisRequest>,
) -> Result<Json<R::RuntimeAnalysis>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.analyze_runtime(request)
    })
    .await
    .map(Json)
}

async fn refresh_repository_branches<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(repository_id): AxumPath<String>,
) -> Result<Json<R::RepositoryRefresh>, ApiError> {
    if repository_id.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "A repository ID is required.",
        ));
    }
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.refresh_repository_branches(&repository_id)
    })
    .await
    .map(Json)
}

async fn preflight_workspace<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::Preflight>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.preflight(workspace_id)
    })
    .await
    .map(Json)
}

async fn recover_workspace_setup<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<MaterializeRequest>,
) -> Result<Json<R::Preflight>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    if !request
        .effect_digest
        .strip_prefix("sha256:")
        .is_some_and(|digest| {
            digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Use the current setup recovery review, then try again.",
        ));
    }
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.recover_setup(workspace_id, &request.effect_digest)
    })
    .await
    .map(Json)
}

async fn get_workspace_materialization<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<Option<R::ExistingMaterialization>>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.get_materialization(workspace_id)
    })
    .await
    .map(Json)
}

async fn preflight_workspace_repository_addition<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<AddWorkspaceRepositoryRequest>,
) -> Result<Json<R::RepositoryAdditionPreflight>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.preflight_repository_addition(workspace_id, request)
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AddRepositoryHttpRequest {
    repository_id: String,
    base_ref: String,
    effect_digest: String,
}

async fn add_workspace_repository<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<AddRepositoryHttpRequest>,
) -> Result<Json<R::RepositoryAddition>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    if request.effect_digest.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Review the repository addition before you add it.",
        ));
    }
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.add_repository(
            workspace_id,
            AddWorkspaceRepositoryRequest {
                repository_id: request.repository_id,
                base_ref: request.base_ref,
            },
            &request.effect_digest,
        )
    })
    .await
    .map(Json)
}

async fn remove_workspace_repository<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
) -> Result<Json<R::RepositoryRemoval>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.remove_repository(workspace_id, &repository_id)
    })
    .await
    .map(Json)
}

async fn get_workspace_repository_diff<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
) -> Result<Json<R::RepositoryDiff>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.repository_diff(workspace_id, &repository_id)
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryFileReviewQuery {
    path: String,
    expected_patch_sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitlabComparisonQuery {
    #[serde(default)]
    refresh: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RepositorySourceQuery {
    file_path: String,
}

async fn get_workspace_gitlab_comparison<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id, iid)): AxumPath<(String, String, u64)>,
    Query(query): Query<GitlabComparisonQuery>,
) -> Result<Json<R::GitlabComparison>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::RemoteRead, move || {
        backend.gitlab_comparison(workspace_id, &repository_id, iid, query.refresh)
    })
    .await
    .map(Json)
}

async fn get_workspace_repository_source<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
    Query(query): Query<RepositorySourceQuery>,
) -> Result<Json<R::RepositorySource>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.repository_source(workspace_id, &repository_id, &query.file_path)
    })
    .await
    .map(Json)
}

async fn save_workspace_repository_source<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::WorkspaceRepositorySourceSaveRequest>,
) -> Result<Json<R::RepositorySource>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.save_repository_source(workspace_id, &repository_id, request)
    })
    .await
    .map(Json)
}

async fn get_workspace_repository_file_review<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
    Query(query): Query<RepositoryFileReviewQuery>,
) -> Result<Json<R::RepositoryFileReview>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.repository_file_review(
            workspace_id,
            &repository_id,
            &query.path,
            &query.expected_patch_sha256,
        )
    })
    .await
    .map(Json)
}

async fn get_workspace_repository_review_graph<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
) -> Result<Json<Option<R::RepositoryReviewGraph>>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.repository_review_graph(workspace_id, &repository_id)
    })
    .await
    .map(Json)
}

async fn sync_workspace_repository<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
) -> Result<Json<R::RepositorySync>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.sync_repository(workspace_id, &repository_id)
    })
    .await
    .map(Json)
}

async fn preflight_workspace_repository_alignment<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
) -> Result<Json<R::RepositoryAlignmentPreflight>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.preflight_repository_alignment(workspace_id, &repository_id)
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AlignRepositoryRequest {
    effect_digest: String,
}

async fn align_workspace_repository<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, repository_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<AlignRepositoryRequest>,
) -> Result<Json<R::RepositoryAlignment>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    if request.effect_digest.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "An alignment effect digest is required.",
        ));
    }
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.align_repository(workspace_id, &repository_id, request.effect_digest.trim())
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaterializeRequest {
    effect_digest: String,
}

async fn materialize_workspace<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<MaterializeRequest>,
) -> Result<Json<R::Materialization>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let idempotency_key = exactly_one_header(&headers, IDEMPOTENCY_HEADER)
        .ok_or_else(ApiError::missing_idempotency_key)?;
    validate_idempotency_key(idempotency_key)?;

    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.materialize(workspace_id, &request.effect_digest)
    })
    .await
    .map(Json)
}

async fn open_workspace_in_vscode<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<R::OpenWorkspace>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.open_vscode(workspace_id)
    })
    .await
    .map(Json)
}

async fn open_workspace_cli<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, provider)): AxumPath<(String, String)>,
    Query(query): Query<OpenWorkspaceCliQuery>,
    _empty: EmptyBody,
) -> Result<Json<R::CliLaunch>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let provider = parse_agent_provider(&provider)?;
    let terminal = query.terminal.unwrap_or(TerminalProvider::Terminal);
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.open_cli(workspace_id, provider, terminal)
    })
    .await
    .map(Json)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenWorkspaceCliQuery {
    terminal: Option<TerminalProvider>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteWorkspaceAgentBriefRequest {
    task_markdown: String,
}

async fn write_workspace_agent_brief<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(request): Json<WriteWorkspaceAgentBriefRequest>,
) -> Result<Json<R::AgentBrief>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.write_agent_brief(workspace_id, &request.task_markdown)
    })
    .await
    .map(Json)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentSessionListQuery {
    workspace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartAgentSessionRequest {
    provider: AgentProvider,
    terminal: TerminalProvider,
    category: AgentSessionCategory,
}

async fn list_agent_conversations<R: MvpBackend>(
    State(state): State<AppState<R>>,
) -> Result<Json<wts_app::AgentConversationList>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.list_agent_conversations()
    })
    .await
    .map(Json)
}

async fn get_agent_conversation<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<wts_app::AgentConversation>, ApiError> {
    let id = parse_workspace_id(&id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.get_agent_conversation(id)
    })
    .await
    .map(Json)
}

async fn create_agent_work_set<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, turn_request_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::CreateAgentWorkSetRequest>,
) -> Result<Json<wts_app::AgentWorkSet>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let turn_request_id = parse_workspace_id(&turn_request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.create_agent_work_set(conversation_id, turn_request_id, request)
    })
    .await
    .map(Json)
}

async fn list_agent_work_sets<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, request_id)): AxumPath<(String, String)>,
) -> Result<Json<wts_app::AgentWorkSetList>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let request_id = parse_workspace_id(&request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.list_agent_work_sets(conversation_id, request_id)
    })
    .await
    .map(Json)
}

async fn get_agent_work_set<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(work_set_id): AxumPath<String>,
) -> Result<Json<wts_app::AgentWorkSet>, ApiError> {
    let work_set_id = parse_workspace_id(&work_set_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.get_agent_work_set(work_set_id)
    })
    .await
    .map(Json)
}

async fn cancel_agent_work_item<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((work_set_id, task_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::AgentWorkItemCancelRequest>,
) -> Result<Json<wts_app::AgentWorkSet>, ApiError> {
    let work_set_id = parse_workspace_id(&work_set_id)?;
    let task_id = parse_workspace_id(&task_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.cancel_agent_work_item(work_set_id, task_id, request)
    })
    .await
    .map(Json)
}

async fn preflight_agent_work_item_integration<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((work_set_id, task_id)): AxumPath<(String, String)>,
) -> Result<Json<wts_app::AgentWorkItemIntegrationPreflight>, ApiError> {
    let work_set_id = parse_workspace_id(&work_set_id)?;
    let task_id = parse_workspace_id(&task_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.preflight_agent_work_item_integration(work_set_id, task_id)
    })
    .await
    .map(Json)
}

async fn integrate_agent_work_item<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((work_set_id, task_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::IntegrateAgentWorkItemRequest>,
) -> Result<Json<wts_app::AgentWorkItemIntegrationResult>, ApiError> {
    let work_set_id = parse_workspace_id(&work_set_id)?;
    let task_id = parse_workspace_id(&task_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.integrate_agent_work_item(work_set_id, task_id, request)
    })
    .await
    .map(Json)
}

async fn create_agent_conversation<R: MvpBackend>(
    State(state): State<AppState<R>>,
    ApiJson(request): ApiJson<wts_app::CreateAgentConversationRequest>,
) -> Result<Json<wts_app::AgentConversation>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.create_agent_conversation(request)
    })
    .await
    .map(Json)
}

async fn get_agent_turn_changes<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, request_id)): AxumPath<(String, String)>,
) -> Result<Json<wts_app::AgentTurnChanges>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let request_id = parse_workspace_id(&request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.get_agent_turn_changes(conversation_id, request_id)
    })
    .await
    .map(Json)
}

async fn get_agent_turn_decisions<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, request_id)): AxumPath<(String, String)>,
) -> Result<Json<wts_app::AgentTurnDecisions>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let request_id = parse_workspace_id(&request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.get_agent_turn_decisions(conversation_id, request_id)
    })
    .await
    .map(Json)
}

async fn record_agent_turn_decision<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, turn_request_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::RecordAgentTurnDecisionRequest>,
) -> Result<Json<wts_app::AgentTurnDecisions>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let turn_request_id = parse_workspace_id(&turn_request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.record_agent_turn_decision(conversation_id, turn_request_id, request)
    })
    .await
    .map(Json)
}

async fn get_agent_turn_checks<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, request_id)): AxumPath<(String, String)>,
) -> Result<Json<wts_app::AgentTurnChecks>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let request_id = parse_workspace_id(&request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.get_agent_turn_checks(conversation_id, request_id)
    })
    .await
    .map(Json)
}

async fn run_agent_turn_check<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, turn_request_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::RunAgentTurnCheckRequest>,
) -> Result<Json<wts_app::AgentTurnChecks>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let turn_request_id = parse_workspace_id(&turn_request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.run_agent_turn_check(conversation_id, turn_request_id, request)
    })
    .await
    .map(Json)
}

async fn preflight_agent_turn_restore<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, request_id)): AxumPath<(String, String)>,
) -> Result<Json<wts_app::AgentTurnRestorePreflight>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let request_id = parse_workspace_id(&request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.preflight_agent_turn_restore(conversation_id, request_id)
    })
    .await
    .map(Json)
}

async fn restore_agent_turn<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((conversation_id, turn_request_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::AgentTurnRestoreRequest>,
) -> Result<Json<wts_app::AgentTurnRestoreResult>, ApiError> {
    let conversation_id = parse_workspace_id(&conversation_id)?;
    let turn_request_id = parse_workspace_id(&turn_request_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.restore_agent_turn(conversation_id, turn_request_id, request)
    })
    .await
    .map(Json)
}

async fn send_agent_conversation_message<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(id): AxumPath<String>,
    ApiJson(request): ApiJson<wts_app::SendAgentConversationMessageRequest>,
) -> Result<Json<wts_app::AgentConversation>, ApiError> {
    let id = parse_workspace_id(&id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.send_agent_conversation_message(id, request)
    })
    .await
    .map(Json)
}

async fn update_agent_conversation_message<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((id, message_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::UpdateAgentConversationMessageRequest>,
) -> Result<Json<wts_app::AgentConversation>, ApiError> {
    let id = parse_workspace_id(&id)?;
    let message_id = parse_workspace_id(&message_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.update_agent_conversation_message(id, message_id, request)
    })
    .await
    .map(Json)
}

async fn cancel_agent_conversation_message<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((id, message_id)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<wts_app::CancelAgentConversationMessageRequest>,
) -> Result<Json<wts_app::AgentConversation>, ApiError> {
    let id = parse_workspace_id(&id)?;
    let message_id = parse_workspace_id(&message_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.cancel_agent_conversation_message(id, message_id, request)
    })
    .await
    .map(Json)
}

async fn list_agent_sessions<R: MvpBackend>(
    State(state): State<AppState<R>>,
    Query(query): Query<AgentSessionListQuery>,
) -> Result<Json<AgentSessionList>, ApiError> {
    let workspace_id = query
        .workspace_id
        .as_deref()
        .map(parse_workspace_id)
        .transpose()?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.list_agent_sessions(workspace_id)
    })
    .await
    .map(Json)
}

async fn get_agent_session_detail<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<AgentSessionDetail>, ApiError> {
    let session_id = parse_workspace_id(&session_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.get_agent_session_detail(session_id)
    })
    .await
    .map(Json)
}

async fn start_agent_session<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<StartAgentSessionRequest>,
) -> Result<Json<AgentSession>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.start_agent_session(
            workspace_id,
            request.provider,
            request.terminal,
            request.category,
        )
    })
    .await
    .map(Json)
}

async fn heartbeat_agent_session<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<AgentSession>, ApiError> {
    let session_id = parse_workspace_id(&session_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.heartbeat_agent_session(session_id)
    })
    .await
    .map(Json)
}

async fn finish_agent_session<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<AgentSession>, ApiError> {
    let session_id = parse_workspace_id(&session_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.finish_agent_session(session_id)
    })
    .await
    .map(Json)
}

async fn fail_agent_session<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(session_id): AxumPath<String>,
) -> Result<Json<AgentSession>, ApiError> {
    let session_id = parse_workspace_id(&session_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.fail_agent_session(session_id)
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LaunchAgentSessionRequest {
    prompt: String,
    #[serde(default)]
    category: AgentSessionCategory,
}

async fn launch_agent_session<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, provider)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<LaunchAgentSessionRequest>,
) -> Result<Json<AgentSession>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let provider = parse_agent_provider(&provider)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.launch_agent_session(workspace_id, provider, &request.prompt, request.category)
    })
    .await
    .map(Json)
}

async fn stop_agent_session<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(session_id): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<AgentSession>, ApiError> {
    let session_id = parse_workspace_id(&session_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.stop_agent_session(session_id)
    })
    .await
    .map(Json)
}

async fn index_workspace_graph<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<R::GraphIndex>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.index_graph(workspace_id)
    })
    .await
    .map(Json)
}

async fn reindex_workspace_graph<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<R::GraphIndex>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.reindex_graph(workspace_id)
    })
    .await
    .map(Json)
}

async fn preflight_workspace_removal<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::RemovalPreflight>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.preflight_removal(workspace_id)
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RemoveWorkspaceRequest {
    effect_digest: String,
    #[serde(default)]
    delete_protected_paths: bool,
}

async fn remove_workspace<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    headers: HeaderMap,
    ApiJson(request): ApiJson<RemoveWorkspaceRequest>,
) -> Result<Json<R::Removal>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let idempotency_key = exactly_one_header(&headers, IDEMPOTENCY_HEADER)
        .ok_or_else(ApiError::missing_idempotency_key)?;
    validate_idempotency_key(idempotency_key)?;

    let idempotency_key = idempotency_key.to_owned();
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.remove(
            workspace_id,
            &request.effect_digest,
            &idempotency_key,
            request.delete_protected_paths,
        )
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentRunRequest {
    prompt: String,
}

async fn run_workspace_agent<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, provider)): AxumPath<(String, String)>,
    ApiJson(request): ApiJson<AgentRunRequest>,
) -> Result<Json<R::AgentRun>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let provider = parse_agent_provider(&provider)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.run_agent(workspace_id, provider, &request.prompt)
    })
    .await
    .map(Json)
}

async fn get_workspace_verification_summary<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<Option<WorkspaceVerificationSummary>>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.get_verification_summary(workspace_id)
    }).await.map(Json)
}

async fn get_workspace_evidence<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::Evidence>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.get_evidence(workspace_id)
    })
    .await?
    .map(Json)
    .ok_or_else(ApiError::not_found)
}

async fn run_workspace_verification<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<R::Evidence>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.run_verification(workspace_id)
    })
    .await
    .map(Json)
}

async fn run_workspace_code_review<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<RunWorkspaceCodeReviewRequest>,
) -> Result<Json<R::CodeReview>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    let options = request.options();
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.run_code_review(workspace_id, request.provider, request.scope, options)
    })
    .await
    .map(Json)
}

async fn get_workspace_code_review<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<Option<R::CodeReview>>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.get_code_review(workspace_id)
    })
    .await
    .map(Json)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentModelsQuery {
    #[serde(default)]
    refresh: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CodeReviewTraceQuery {
    #[serde(default)]
    after: Option<u32>,
}

async fn get_workspace_code_review_trace<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    Query(query): Query<CodeReviewTraceQuery>,
) -> Result<Json<Option<wts_app::CodeReviewTrace>>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Read, move || {
        backend.code_review_trace(workspace_id, query.after)
    })
    .await
    .map(Json)
}

async fn get_agent_models<R: MvpBackend>(
    State(state): State<AppState<R>>,
    Query(query): Query<AgentModelsQuery>,
) -> Result<Json<AgentModelCatalog>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.agent_models(query.refresh)
    })
    .await
    .map(Json)
}

async fn run_workspace_verification_check<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, check_id)): AxumPath<(String, String)>,
    _empty: EmptyBody,
) -> Result<Json<R::Evidence>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.run_verification_check(workspace_id, &check_id)
    })
    .await
    .map(Json)
}

async fn rerun_failed_workspace_verification<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<R::Evidence>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.rerun_failed_verification(workspace_id)
    })
    .await
    .map(Json)
}

async fn cancel_workspace_verification<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<R::Evidence>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.cancel_verification(workspace_id)
    })
    .await
    .map(Json)
}

async fn promote_agent_verification_check<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, proposal_id)): AxumPath<(String, String)>,
    _empty: EmptyBody,
) -> Result<Json<R::Evidence>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.promote_agent_check(workspace_id, &proposal_id)
    })
    .await
    .map(Json)
}

async fn list_workspace_test_runs<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Result<Json<R::TestRunList>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.list_test_runs(workspace_id)
    })
    .await
    .map(Json)
}

async fn get_workspace_test_run<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath((workspace_id, run_id)): AxumPath<(String, String)>,
) -> Result<Json<R::TestRunDetail>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let run_id = Uuid::parse_str(&run_id).map_err(|_| ApiError::test_run_not_found())?;
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.get_test_run(workspace_id, run_id)
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TestJourneyRequest {
    journey_id: String,
    base_url: String,
}

async fn run_workspace_test_journey<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(workspace_id): AxumPath<String>,
    ApiJson(request): ApiJson<TestJourneyRequest>,
) -> Result<Json<R::TestRun>, ApiError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    if request.base_url != state.security.origin() {
        return Err(ApiError::from_mvp(MvpFailure::InvalidTestJourney));
    }
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.run_test_journey(workspace_id, &request.journey_id, &request.base_url)
    })
    .await
    .map(Json)
}

async fn verify_jira_mcp<R: MvpBackend>(
    State(state): State<AppState<R>>,
    _empty: EmptyBody,
) -> Result<Json<R::JiraVerification>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.verify_jira()
    })
    .await
    .map(Json)
}

async fn list_active_jira_issues<R: MvpBackend>(
    State(state): State<AppState<R>>,
) -> Result<Json<R::JiraActiveIssues>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.active_jira_issues()
    })
    .await
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityWatchStatusQuery {
    endpoint: Option<String>,
}

async fn activity_watch_status<R: MvpBackend>(
    State(state): State<AppState<R>>,
    Query(query): Query<ActivityWatchStatusQuery>,
) -> Result<Json<ActivityWatchStatus>, ApiError> {
    let permit = state.admission.try_acquire(OperationClass::Scan)?;
    tokio::task::spawn_blocking(move || {
        // Construct and drop reqwest's blocking client on the blocking lane.
        // Its internal runtime must never be created on a Tokio worker.
        let _permit = permit;
        let connector = ActivityWatchConnector::configured(query.endpoint.as_deref())
            .map_err(activity_watch_api_error)?;
        Ok(connector.status())
    })
    .await
    .map_err(|_| {
        warn!("ActivityWatch status worker stopped unexpectedly");
        ApiError::from_mvp(MvpFailure::Unavailable)
    })?
    .map(Json)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivityWatchDailyReviewQuery {
    started_at_unix_ms: i64,
    ended_at_unix_ms: i64,
    endpoint: Option<String>,
}

async fn activity_watch_daily_review<R: MvpBackend>(
    State(state): State<AppState<R>>,
    Query(query): Query<ActivityWatchDailyReviewQuery>,
) -> Result<Json<ActivityWatchDailyReview>, ApiError> {
    let permit = state.admission.try_acquire(OperationClass::Scan)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let connector = ActivityWatchConnector::configured(query.endpoint.as_deref())
            .map_err(activity_watch_api_error)?;
        connector
            .daily_review(query.started_at_unix_ms, query.ended_at_unix_ms)
            .map_err(activity_watch_review_api_error)
    })
    .await
    .map_err(|_| {
        warn!("ActivityWatch daily review worker stopped unexpectedly");
        ApiError::from_mvp(MvpFailure::Unavailable)
    })?
    .map(Json)
}

async fn activity_watch_time_review_brief<R: MvpBackend>(
    State(state): State<AppState<R>>,
    Query(query): Query<ActivityWatchDailyReviewQuery>,
) -> Result<Json<R::TimeReviewBrief>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.activity_watch_time_review_brief(
            query.started_at_unix_ms,
            query.ended_at_unix_ms,
            query.endpoint.as_deref(),
        )
    })
    .await
    .map(Json)
}

fn activity_watch_api_error(error: ActivityWatchError) -> ApiError {
    match error {
        ActivityWatchError::InvalidEndpoint => ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "activity_watch_invalid_endpoint",
            error.safe_message(),
        ),
        ActivityWatchError::ClientInitializationFailed => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "activity_watch_connector_unavailable",
            error.safe_message(),
        ),
    }
}

fn activity_watch_review_api_error(error: ActivityWatchReviewError) -> ApiError {
    let (status, code) = match error {
        ActivityWatchReviewError::InvalidTimeRange => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "activity_watch_invalid_time_range",
        ),
        ActivityWatchReviewError::RequestTimedOut => (
            StatusCode::GATEWAY_TIMEOUT,
            "activity_watch_review_timed_out",
        ),
        ActivityWatchReviewError::ConnectionFailed => (
            StatusCode::SERVICE_UNAVAILABLE,
            "activity_watch_unavailable",
        ),
        ActivityWatchReviewError::ResponseTooLarge => (
            StatusCode::PAYLOAD_TOO_LARGE,
            "activity_watch_review_too_large",
        ),
        ActivityWatchReviewError::ResponseInvalid => {
            (StatusCode::BAD_GATEWAY, "activity_watch_response_invalid")
        }
        ActivityWatchReviewError::EndpointRedirected => (
            StatusCode::BAD_GATEWAY,
            "activity_watch_endpoint_redirected",
        ),
        ActivityWatchReviewError::ServerRejected => {
            (StatusCode::BAD_GATEWAY, "activity_watch_server_rejected")
        }
    };
    ApiError::new(status, code, error.safe_message())
}

async fn import_jira_issue<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(issue_key): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<R::JiraIssue>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.import_jira(&issue_key)
    })
    .await
    .map(Json)
}

async fn import_code_workspace_file<R: MvpBackend>(
    State(state): State<AppState<R>>,
    ApiJson(mut request): ApiJson<CodeWorkspaceImportRequest>,
) -> Result<Json<R::CodeWorkspaceImport>, ApiError> {
    let import_id = Uuid::new_v4();
    request.assign_import_id(import_id);
    #[cfg(debug_assertions)]
    info!(
        target: "wts_server::code_workspace_import",
        %import_id,
        file_name = ?bounded_diagnostic_text(&request.file_name, 255),
        content_bytes = request.contents.len(),
        "code_workspace_import.begin"
    );

    let backend = Arc::clone(&state.registry);
    let result = run_mvp_operation(&state.admission, OperationClass::Scan, move || {
        backend.import_code_workspace(request)
    })
    .await;

    #[cfg(debug_assertions)]
    match &result {
        Ok(imported) => log_development_code_workspace_import_success(import_id, imported),
        Err(error) => info!(
            target: "wts_server::code_workspace_import",
            %import_id,
            success = false,
            error_code = error.code,
            status = error.status.as_u16(),
            "code_workspace_import.end"
        ),
    }

    result.map(Json)
}

#[cfg(debug_assertions)]
fn log_development_code_workspace_import_success<T: Serialize>(import_id: Uuid, imported: &T) {
    let Ok(value) = serde_json::to_value(imported) else {
        info!(
            target: "wts_server::code_workspace_import",
            %import_id,
            success = true,
            diagnostics_available = false,
            "code_workspace_import.end"
        );
        return;
    };

    let folders = value
        .get("folders")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let matched_count = folder_status_count(folders, "matched");
    let missing_count = folder_status_count(folders, "missing");
    let ambiguous_count = folder_status_count(folders, "ambiguous");
    let unsupported_count = folder_status_count(folders, "unsupported");
    let diagnostics = value
        .get("diagnostics")
        .and_then(serde_json::Value::as_object);

    if let Some(catalog) = diagnostics
        .and_then(|diagnostics| diagnostics.get("catalog"))
        .and_then(serde_json::Value::as_object)
    {
        let catalog_repositories = catalog
            .get("repositories")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .take(16)
            .map(|repository| {
                format!(
                    "{} @ {}",
                    diagnostic_field(repository, "label", 255),
                    diagnostic_field(repository, "displayPath", 4096)
                )
            })
            .collect::<Vec<_>>();
        info!(
            target: "wts_server::code_workspace_import",
            %import_id,
            repository_root = ?diagnostic_object_field(catalog, "repositoryRootDisplayPath", 4096),
            repository_count = diagnostic_u64(catalog, "repositoryCount"),
            skipped_entries = diagnostic_u64(catalog, "skippedEntries"),
            repositories = ?catalog_repositories,
            repositories_truncated = diagnostic_bool(catalog, "repositoriesTruncated"),
            "code_workspace_import.catalog"
        );
    }

    if let Some(diagnostic_folders) = diagnostics
        .and_then(|diagnostics| diagnostics.get("folders"))
        .and_then(serde_json::Value::as_array)
    {
        for diagnostic in diagnostic_folders.iter().take(32) {
            let Some(diagnostic) = diagnostic.as_object() else {
                continue;
            };
            let folder_index = diagnostic_u64(diagnostic, "folderIndex");
            let source_folder = usize::try_from(folder_index)
                .ok()
                .and_then(|index| folders.get(index));
            let attempts = diagnostic
                .get("attempts")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .take(3)
                .map(|attempt| {
                    format!(
                        "{}={} (candidates={})",
                        diagnostic_field(attempt, "basis", 32),
                        diagnostic_field(attempt, "value", 4096),
                        attempt
                            .get("candidateCount")
                            .and_then(serde_json::Value::as_u64)
                            .unwrap_or_default()
                    )
                })
                .collect::<Vec<_>>();
            let candidates = diagnostic
                .get("candidates")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .take(8)
                .map(|candidate| {
                    format!(
                        "{} @ {}",
                        diagnostic_field(candidate, "label", 255),
                        diagnostic_field(candidate, "displayPath", 4096)
                    )
                })
                .collect::<Vec<_>>();
            info!(
                target: "wts_server::code_workspace_import",
                %import_id,
                folder_index,
                folder_name = ?source_folder
                    .map(|folder| diagnostic_field(folder, "name", 255))
                    .unwrap_or_default(),
                raw_path = ?source_folder
                    .map(|folder| diagnostic_field(folder, "rawPath", 4096))
                    .unwrap_or_default(),
                status = ?diagnostic_object_field(diagnostic, "status", 32),
                reason = ?diagnostic_object_field(diagnostic, "reason", 64),
                resolution_basis = ?diagnostic_object_field(diagnostic, "resolutionBasis", 32),
                attempts = ?attempts,
                candidates = ?candidates,
                candidates_truncated = diagnostic_bool(diagnostic, "candidatesTruncated"),
                duplicate_repository = diagnostic_bool(diagnostic, "duplicateRepository"),
                "code_workspace_import.folder"
            );
        }
    } else {
        for (folder_index, folder) in folders.iter().take(32).enumerate() {
            info!(
                target: "wts_server::code_workspace_import",
                %import_id,
                folder_index,
                folder_name = ?diagnostic_field(folder, "name", 255),
                raw_path = ?diagnostic_field(folder, "rawPath", 4096),
                status = ?diagnostic_field(folder, "status", 32),
                diagnostics_available = false,
                "code_workspace_import.folder"
            );
        }
    }

    let response_import_id = value
        .get("importId")
        .and_then(serde_json::Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok());
    info!(
        target: "wts_server::code_workspace_import",
        %import_id,
        success = true,
        import_id_matches = response_import_id == Some(import_id),
        diagnostics_available = diagnostics.is_some(),
        folder_count = folders.len(),
        matched_count,
        missing_count,
        ambiguous_count,
        unsupported_count,
        "code_workspace_import.end"
    );
}

#[cfg(debug_assertions)]
fn folder_status_count(folders: &[serde_json::Value], expected: &str) -> usize {
    folders
        .iter()
        .filter(|folder| folder.get("status").and_then(serde_json::Value::as_str) == Some(expected))
        .count()
}

#[cfg(debug_assertions)]
fn diagnostic_object_field(
    object: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    maximum_chars: usize,
) -> String {
    object
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(|value| bounded_diagnostic_text(value, maximum_chars))
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn diagnostic_field(value: &serde_json::Value, field: &str, maximum_chars: usize) -> String {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(|value| bounded_diagnostic_text(value, maximum_chars))
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn diagnostic_u64(object: &serde_json::Map<String, serde_json::Value>, field: &str) -> u64 {
    object
        .get(field)
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn diagnostic_bool(object: &serde_json::Map<String, serde_json::Value>, field: &str) -> bool {
    object
        .get(field)
        .and_then(serde_json::Value::as_bool)
        .unwrap_or_default()
}

#[cfg(debug_assertions)]
fn bounded_diagnostic_text(value: &str, maximum_chars: usize) -> String {
    if is_uri_shaped_diagnostic_value(value) {
        return "<unsupported-uri>".to_owned();
    }
    value
        .chars()
        .take(maximum_chars)
        .map(|character| {
            if character.is_control() {
                '\u{fffd}'
            } else {
                character
            }
        })
        .collect()
}

#[cfg(debug_assertions)]
fn is_uri_shaped_diagnostic_value(value: &str) -> bool {
    let value = value.trim_start();
    let Some((scheme, remainder)) = value.split_once(':') else {
        return false;
    };
    let mut characters = scheme.chars();
    let valid_scheme = matches!(
        characters.next(),
        Some(first) if first.is_ascii_alphabetic()
    ) && characters
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.'));
    if !valid_scheme {
        return false;
    }
    let windows_drive_absolute =
        scheme.len() == 1 && matches!(remainder.as_bytes().first(), Some(b'/' | b'\\'));
    !windows_drive_absolute
}

async fn verify_open_project<R: MvpBackend>(
    State(state): State<AppState<R>>,
    _empty: EmptyBody,
) -> Result<Json<R::OpenProjectVerification>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.verify_open_project()
    })
    .await
    .map(Json)
}

async fn import_open_project_work_package<R: MvpBackend>(
    State(state): State<AppState<R>>,
    AxumPath(reference): AxumPath<String>,
    _empty: EmptyBody,
) -> Result<Json<R::OpenProjectWorkPackage>, ApiError> {
    let backend = Arc::clone(&state.registry);
    run_mvp_operation(&state.admission, OperationClass::Heavy, move || {
        backend.import_open_project_work_package(&reference)
    })
    .await
    .map(Json)
}

fn parse_agent_provider(value: &str) -> Result<AgentProvider, ApiError> {
    match value {
        "codex" => Ok(AgentProvider::Codex),
        "openCode" => Ok(AgentProvider::OpenCode),
        "hermes" => Ok(AgentProvider::Hermes),
        _ => Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_agent_provider",
            "The requested agent provider is not supported.",
        )),
    }
}

fn parse_workspace_id(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| ApiError::not_found())
}

fn parse_planning_document_id(value: &str) -> Result<WorkspacePlanningDocumentId, ApiError> {
    WorkspacePlanningDocumentId::from_wire(value).ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "planning_document_unavailable",
            "The planning document is not available for this workspace.",
        )
    })
}

async fn run_registry_operation<T>(
    admission: &AdmissionController,
    class: OperationClass,
    operation: impl FnOnce() -> Result<T, RegistryFailure> + Send + 'static,
) -> Result<T, ApiError>
where
    T: Send + 'static,
{
    let permit = admission.try_acquire(class)?;
    tokio::task::spawn_blocking(move || {
        // Keep admission tied to the actual blocking work. Axum may drop the
        // request future after a disconnect, but spawn_blocking work cannot be
        // cancelled once it starts.
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| {
        warn!("workspace registry worker stopped unexpectedly");
        ApiError::from_registry(RegistryFailure::Unavailable)
    })?
    .map_err(ApiError::from_registry)
}

async fn run_mvp_operation<T>(
    admission: &AdmissionController,
    class: OperationClass,
    operation: impl FnOnce() -> Result<T, MvpFailure> + Send + 'static,
) -> Result<T, ApiError>
where
    T: Send + 'static,
{
    let permit = admission.admit(class).await?;
    tokio::task::spawn_blocking(move || {
        // The permit deliberately lives inside the blocking worker; dropping
        // an HTTP request must not admit replacement work prematurely.
        let _permit = permit;
        operation()
    })
    .await
    .map_err(|_| {
        warn!("local WTS worker stopped unexpectedly");
        ApiError::from_mvp(MvpFailure::Unavailable)
    })?
    .map_err(ApiError::from_mvp)
}

async fn demo_boundary_json<R: MvpBackend>(
    State(state): State<AppState<R>>,
) -> Json<WorkspaceBoundary> {
    Json((*state.demo_boundary).clone())
}

async fn require_exact_host(
    State(security): State<SecurityPolicy>,
    request: Request,
    next: Next,
) -> Response {
    if exactly_one_header(request.headers(), HOST.as_str()) != Some(security.authority()) {
        return ApiError::invalid_host().into_response();
    }
    next.run(request).await
}

async fn require_registry_access(
    State(security): State<SecurityPolicy>,
    request: Request,
    next: Next,
) -> Response {
    let Some(session) = exactly_one_header(request.headers(), SESSION_HEADER) else {
        return ApiError::unauthorized().into_response();
    };
    if !security.matches_session(session) {
        return ApiError::unauthorized().into_response();
    }
    if exactly_one_header(request.headers(), REQUEST_HEADER) != Some(REQUEST_MARKER) {
        return ApiError::invalid_client().into_response();
    }
    if matches!(
        request.method(),
        &Method::POST | &Method::PUT | &Method::PATCH | &Method::DELETE
    ) && exactly_one_header(request.headers(), ORIGIN.as_str()) != Some(security.origin())
    {
        return ApiError::invalid_origin().into_response();
    }
    next.run(request).await
}

async fn add_no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(debug_assertions)]
async fn log_development_http_request(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = bounded_diagnostic_text(request.uri().path(), 2048);
    let started_at = std::time::Instant::now();
    info!(
        target: "wts_server::http",
        %method,
        %path,
        "http_request.begin"
    );
    let response = next.run(request).await;
    let latency_milliseconds = u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    info!(
        target: "wts_server::http",
        %method,
        %path,
        status = response.status().as_u16(),
        latency_milliseconds,
        "http_request.end"
    );
    response
}

fn exactly_one_header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let first = values.next()?.to_str().ok()?;
    if values.next().is_some() {
        return None;
    }
    Some(first)
}

fn validate_idempotency_key(value: &str) -> Result<(), ApiError> {
    let Ok(idempotency_key) = Uuid::parse_str(value) else {
        return Err(ApiError::invalid_idempotency_key());
    };
    if idempotency_key.is_nil() {
        return Err(ApiError::invalid_idempotency_key());
    }
    Ok(())
}

struct ApiJson<T>(T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        Json::<T>::from_request(request, state)
            .await
            .map(|Json(value)| Self(value))
            .map_err(ApiError::from_json_rejection)
    }
}

struct EmptyBody;

impl<S> FromRequest<S> for EmptyBody
where
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, _state: &S) -> Result<Self, Self::Rejection> {
        match axum::body::to_bytes(request.into_body(), 1).await {
            Ok(bytes) if bytes.is_empty() => Ok(Self),
            _ => Err(ApiError::unexpected_body()),
        }
    }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

#[derive(Serialize)]
struct ApiErrorEnvelope {
    error: ApiErrorBody,
}

#[derive(Serialize)]
struct ApiErrorBody {
    code: &'static str,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message: message.to_owned(),
        }
    }

    fn invalid_host() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "invalid_host",
            "The request host is not permitted.",
        )
    }

    fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "A valid local WTS session is required.",
        )
    }

    fn invalid_client() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "invalid_client",
            "The request did not identify the local WTS interface.",
        )
    }

    fn invalid_origin() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "invalid_origin",
            "The request origin is not permitted.",
        )
    }

    fn missing_idempotency_key() -> Self {
        Self::new(
            StatusCode::BAD_REQUEST,
            "missing_idempotency_key",
            "Idempotency-Key is required.",
        )
    }

    fn invalid_idempotency_key() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_idempotency_key",
            "Idempotency-Key is invalid.",
        )
    }

    fn unexpected_body() -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "unexpected_body",
            "This action does not accept a request body.",
        )
    }

    fn not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "workspace_not_found",
            "The local workspace was not found.",
        )
    }

    fn test_run_not_found() -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "test_run_not_found",
            "The local browser test run was not found.",
        )
    }

    fn capacity_exhausted(class: OperationClass) -> Self {
        match class {
            OperationClass::Read => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "read_capacity_exhausted",
                "WTS is already serving the maximum number of local read operations. Retry shortly.",
            ),
            OperationClass::Scan => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "scan_capacity_exhausted",
                "WTS is already inspecting the maximum number of local workspaces. Retry shortly.",
            ),
            OperationClass::Heavy => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "operation_capacity_exhausted",
                "WTS is already running the maximum number of local operations. Retry shortly.",
            ),
            OperationClass::RemoteRead => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "remote_read_capacity_exhausted",
                "WTS is already waiting on the maximum number of GitLab or GitHub reads. Retry shortly.",
            ),
        }
    }

    fn from_registry(error: RegistryFailure) -> Self {
        match error {
            RegistryFailure::Validation(message) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "validation_failed",
                message,
            },
            RegistryFailure::Conflict => Self::new(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "The idempotency key was already used for another request.",
            ),
            RegistryFailure::RepositoryCatalogUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "repository_catalog_unavailable",
                "The local repository catalog is unavailable.",
            ),
            RegistryFailure::RepositoryNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "repository_not_found",
                "The selected local repository is no longer in the WTS catalog.",
            ),
            RegistryFailure::RepositoryChanged => Self::new(
                StatusCode::CONFLICT,
                "repository_changed",
                "The selected local repository changed after it was cataloged.",
            ),
            RegistryFailure::InvalidRepositoryBase => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_repository_base",
                "Choose a valid local branch as the repository base.",
            ),
            RegistryFailure::RepositoryBaseNotFound => Self::new(
                StatusCode::CONFLICT,
                "repository_base_not_found",
                "The selected repository base is not available in the local checkout.",
            ),
            RegistryFailure::InvalidRuntimeAnalysisRequest => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_runtime_analysis_request",
                "Choose pinned local repositories and valid bases before saving runtime services.",
            ),
            RegistryFailure::RuntimeAnalysisUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "runtime_analysis_unavailable",
                "WTS could not revalidate the selected repository commits.",
            ),
            RegistryFailure::StaleRuntimeAnalysis => Self::new(
                StatusCode::CONFLICT,
                "stale_runtime_analysis",
                "The selected repositories changed after service analysis. Analyze them again.",
            ),
            RegistryFailure::InvalidRuntimeSelection => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_runtime_selection",
                "The runtime plan contains a service or port that was not proposed by WTS.",
            ),
            RegistryFailure::NotFound => Self::not_found(),
            RegistryFailure::Unavailable => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "registry_unavailable",
                "The local workspace registry is unavailable.",
            ),
        }
    }

    fn from_mvp(error: MvpFailure) -> Self {
        match error {
            MvpFailure::InvalidLocalConfiguration => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_local_configuration",
                "The local WTS configuration is invalid.",
            ),
            MvpFailure::RepositoryCatalogUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "repository_catalog_unavailable",
                "The local repository catalog is unavailable.",
            ),
            MvpFailure::InvalidRepositoryRemote => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_repository_remote",
                "Enter a supported HTTPS or SSH Git repository URL without embedded credentials.",
            ),
            MvpFailure::RepositoryCloneConflict => Self::new(
                StatusCode::CONFLICT,
                "repository_clone_conflict",
                "A different local folder already uses the repository name derived from this URL.",
            ),
            MvpFailure::RepositoryCloneBranchUnavailable => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "repository_clone_branch_unavailable",
                "The requested branch is not available locally. Refresh the repository branches, or select an available branch.",
            ),
            MvpFailure::RepositoryCloneFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "repository_clone_failed",
                "Git could not clone the repository. Check the URL, network, SSH agent, or credential helper and retry.",
            ),
            MvpFailure::RepositoryFetchFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "repository_fetch_failed",
                "Git could not refresh branches. Check the network, SSH agent, or credential helper and retry.",
            ),
            MvpFailure::RepositoryNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "repository_not_found",
                "The selected local repository is no longer in the WTS catalog.",
            ),
            MvpFailure::InvalidRepositoryFilePath => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_repository_file_path",
                "Choose a file inside the selected repository.",
            ),
            MvpFailure::RepositoryFileUnavailable => Self::new(
                StatusCode::NOT_FOUND,
                "repository_file_unavailable",
                "The selected repository file is not available as a regular local file.",
            ),
            MvpFailure::RepositoryFileNotText => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "repository_file_not_text",
                "WTS can show the complete file only when it contains UTF-8 text.",
            ),
            MvpFailure::RepositoryFileTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "repository_file_too_large",
                "The selected repository file exceeds the complete-file limit.",
            ),
            MvpFailure::RepositoryFileConflict => Self::new(
                StatusCode::CONFLICT,
                "repository_file_conflict",
                "The source file changed. Reload the file before you save.",
            ),
            MvpFailure::InvalidRepositoryFileRevision => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_repository_file_revision",
                "The source file revision is invalid.",
            ),
            MvpFailure::GitlabComparisonUnavailable => Self::new(
                StatusCode::BAD_GATEWAY,
                "gitlab_comparison_unavailable",
                "WTS could not load the merge request comparison. Refresh the merge request and check the local branch.",
            ),
            MvpFailure::GitlabMergeRequestLinkUnavailable => Self::new(
                StatusCode::BAD_GATEWAY,
                "gitlab_merge_request_link_unavailable",
                "WTS could not link the merge request. Check the GitLab connection and merge request, then retry.",
            ),
            MvpFailure::RepositoryChanged => Self::new(
                StatusCode::CONFLICT,
                "repository_changed",
                "The selected local repository changed after it was cataloged.",
            ),
            MvpFailure::RepositorySyncBlocked => Self::new(
                StatusCode::CONFLICT,
                "repository_sync_blocked",
                "Sync cannot change a worktree that has local work. Review or save the local work before you retry.",
            ),
            MvpFailure::RepositorySyncDiverged => Self::new(
                StatusCode::CONFLICT,
                "repository_sync_diverged",
                "The tracking branch has different history. Review alignment before moving this clean worktree.",
            ),
            MvpFailure::RepositorySyncFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "repository_sync_failed",
                "WTS could not fetch the saved tracking branch. Check the remote access and retry.",
            ),
            MvpFailure::RepositorySyncBusy => Self::new(
                StatusCode::CONFLICT,
                "repository_sync_busy",
                "Stop active agent or verification work before syncing this repository.",
            ),
            MvpFailure::RepositoryAlreadyInWorkspace => Self::new(
                StatusCode::CONFLICT,
                "repository_already_in_workspace",
                "This repository is already in the workspace.",
            ),
            MvpFailure::RepositoryAdditionStale => Self::new(
                StatusCode::CONFLICT,
                "repository_addition_stale",
                "The repository changed after review. Review the repository addition again.",
            ),
            MvpFailure::RepositoryAdditionFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "repository_addition_failed",
                "WTS could not add the repository. The existing workspace was not changed.",
            ),
            MvpFailure::RepositoryAdditionCleanupIncomplete => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "repository_addition_cleanup_failed",
                "WTS could not add the repository or complete cleanup. Check the workspace before you retry.",
            ),
            MvpFailure::RepositoryRemovalBlocked => Self::new(
                StatusCode::CONFLICT,
                "repository_removal_blocked",
                "WTS cannot remove the only repository or a repository that has local files.",
            ),
            MvpFailure::RepositoryRemovalFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "repository_removal_failed",
                "WTS could not remove the repository. Refresh the workspace before you retry.",
            ),
            MvpFailure::RepositoryAlignmentStale => Self::new(
                StatusCode::CONFLICT,
                "repository_alignment_stale",
                "The repository changed after alignment review. Check the alignment again.",
            ),
            MvpFailure::RepositoryAlignmentFailed => Self::new(
                StatusCode::CONFLICT,
                "repository_alignment_failed",
                "WTS could not preserve and align the repository. Review its Git state before retrying.",
            ),
            MvpFailure::InvalidRepositoryBase => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_repository_base",
                "Choose a valid local branch as the repository base.",
            ),
            MvpFailure::RepositoryBaseNotFound => Self::new(
                StatusCode::CONFLICT,
                "repository_base_not_found",
                "The selected repository base is not available in the local checkout.",
            ),
            MvpFailure::RepositoryForgeUnsupported => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "repository_forge_unsupported",
                "The repository does not have a supported GitHub or GitLab origin.",
            ),
            MvpFailure::GitlabReviewCommentFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "gitlab_review_comment_failed",
                "GitLab did not accept this comment. Refresh the merge request changes, then retry on a current changed line.",
            ),
            MvpFailure::GitlabDiscussionsUnavailable => Self::new(
                StatusCode::BAD_GATEWAY,
                "gitlab_discussions_unavailable",
                "WTS could not load the GitLab discussions. Check the connection and GitLab account.",
            ),
            MvpFailure::GitlabDiscussionReplyFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "gitlab_discussion_reply_failed",
                "WTS could not confirm the reply. Refresh the discussion before you try again.",
            ),
            MvpFailure::ChangeRequestBranchNotPublished => Self::new(
                StatusCode::CONFLICT,
                "change_request_branch_not_published",
                "Publish this branch and set its upstream before you prepare a change request.",
            ),
            MvpFailure::ChangeRequestBranchPublishFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "change_request_branch_publish_failed",
                "Git rejected the publish operation for an unknown reason. Open the workspace and run Git push to see the diagnostic.",
            ),
            MvpFailure::InvalidChangeRequestBranchName => Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_change_request_branch_name",
                "Enter a valid Git branch name and retry.",
            ),
            MvpFailure::ChangeRequestBranchAuthenticationFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "change_request_branch_authentication_failed",
                "Git authentication failed. Unlock the SSH key or credential helper, then retry.",
            ),
            MvpFailure::ChangeRequestBranchNetworkFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "change_request_branch_network_failed",
                "Git cannot reach the remote. Check the network connection, then retry.",
            ),
            MvpFailure::ChangeRequestBranchRejected => Self::new(
                StatusCode::CONFLICT,
                "change_request_branch_rejected",
                "The remote rejected this branch update. Choose another branch name or synchronize the branch.",
            ),
            MvpFailure::ChangeRequestRemoteMismatch => Self::new(
                StatusCode::CONFLICT,
                "change_request_remote_mismatch",
                "The local and remote branch commits do not match. Publish the current commit and retry.",
            ),
            MvpFailure::ChangeRequestWorktreeDirty => Self::new(
                StatusCode::CONFLICT,
                "change_request_worktree_dirty",
                "Commit or discard local changes before you prepare a change request.",
            ),
            MvpFailure::ChangeRequestForkUnsupported => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "change_request_fork_unsupported",
                "WTS cannot prepare a fork change request until the provider project is verified.",
            ),
            MvpFailure::ChangeRequestAgentProposalUnavailable => Self::new(
                StatusCode::CONFLICT,
                "change_request_agent_proposal_unavailable",
                "No agent session prepared a change request for this repository commit. Select Ask agent to prepare.",
            ),
            MvpFailure::ChangeRequestAgentProposalInvalid => Self::new(
                StatusCode::CONFLICT,
                "change_request_agent_proposal_invalid",
                "The agent proposal does not match the current repository or linked Jira issues.",
            ),
            MvpFailure::InvalidChangeRequestDraft => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_change_request_draft",
                "The change-request draft contains invalid or oversized content.",
            ),
            MvpFailure::StaleChangeRequestDraft => Self::new(
                StatusCode::CONFLICT,
                "stale_change_request_draft",
                "The repository changed. Refresh the change-request draft and review it again.",
            ),
            MvpFailure::BrowserUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "browser_unavailable",
                "The system browser launcher is unavailable.",
            ),
            MvpFailure::BrowserLaunchRejected => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "browser_launch_rejected",
                "The system browser did not accept the launch.",
            ),
            MvpFailure::JiraBrowserUrlUnavailable => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "jira_browser_url_unavailable",
                "This Jira issue does not contain a safe browser link.",
            ),
            MvpFailure::InvalidCodeWorkspaceImport => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_code_workspace_import",
                "Choose a valid VS Code .code-workspace file.",
            ),
            MvpFailure::CodeWorkspaceImportTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "code_workspace_import_too_large",
                "The VS Code workspace file exceeds the local import limit.",
            ),
            MvpFailure::InvalidRuntimeAnalysisRequest => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_runtime_analysis_request",
                "Choose at least one pinned local repository and a valid base before analyzing services.",
            ),
            MvpFailure::RuntimeAnalysisUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "runtime_analysis_unavailable",
                "WTS could not inspect the selected repository commits.",
            ),
            MvpFailure::StaleRuntimeAnalysis => Self::new(
                StatusCode::CONFLICT,
                "stale_runtime_analysis",
                "The selected repositories changed after service analysis. Analyze them again.",
            ),
            MvpFailure::InvalidRuntimeSelection => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_runtime_selection",
                "The runtime plan contains a service or port that was not proposed by WTS.",
            ),
            MvpFailure::WorkspaceNotFound => Self::not_found(),
            MvpFailure::WorkspaceWorkflowConflict => Self::new(
                StatusCode::CONFLICT,
                "workspace_workflow_conflict",
                "The workspace moved to another state. Reload it and try again.",
            ),
            MvpFailure::InvalidWorkspaceBoardPlacement => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_workspace_board_placement",
                "Choose a valid position in the workspace state.",
            ),
            MvpFailure::PlanningNotConfigured => Self::new(
                StatusCode::CONFLICT,
                "planning_not_configured",
                "This workspace does not have a planning home.",
            ),
            MvpFailure::PlanningDocumentUnavailable => Self::new(
                StatusCode::NOT_FOUND,
                "planning_document_unavailable",
                "The planning document is not available for this workspace.",
            ),
            MvpFailure::InvalidPlanningDocument => Self::new(
                StatusCode::CONFLICT,
                "invalid_planning_document",
                "The planning document failed local safety validation.",
            ),
            MvpFailure::PlanningDocumentTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "planning_document_too_large",
                "The planning document exceeds the local size limit.",
            ),
            MvpFailure::PlanningDocumentConflict => Self::new(
                StatusCode::CONFLICT,
                "planning_document_conflict",
                "The planning document changed. Reload it and try again.",
            ),
            MvpFailure::InvalidReviewThread => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_review_thread",
                "Choose a valid document line and enter a review comment.",
            ),
            MvpFailure::ReviewCommentTooLarge => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "review_comment_too_large",
                "The review comment exceeds the local size limit.",
            ),
            MvpFailure::ReviewThreadNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "review_thread_not_found",
                "The review thread was not found.",
            ),
            MvpFailure::ReviewThreadConflict => Self::new(
                StatusCode::CONFLICT,
                "review_thread_conflict",
                "The review thread changed. Reload it and try again.",
            ),
            MvpFailure::InvalidWorkItemLink => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_work_item_link",
                "Choose a valid Jira issue and work-item role.",
            ),
            MvpFailure::StaleWorkItemLinkPreview => Self::new(
                StatusCode::CONFLICT,
                "stale_work_item_link_preview",
                "The Jira issue changed. Review it again before you link it.",
            ),
            MvpFailure::WorkItemLinkIdempotencyConflict => Self::new(
                StatusCode::CONFLICT,
                "work_item_link_idempotency_conflict",
                "This retry key was used for a different Jira link operation.",
            ),
            MvpFailure::WorkItemLinkAlreadyExists => Self::new(
                StatusCode::CONFLICT,
                "work_item_link_exists",
                "This Jira issue is already linked to the workspace.",
            ),
            MvpFailure::PrimaryWorkItemLinkAlreadyExists => Self::new(
                StatusCode::CONFLICT,
                "primary_work_item_link_exists",
                "This workspace already has a primary work item.",
            ),
            MvpFailure::WorkItemLinkNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "work_item_link_not_found",
                "The linked work item was not found.",
            ),
            MvpFailure::WorkItemLinkConflict => Self::new(
                StatusCode::CONFLICT,
                "work_item_link_conflict",
                "The linked work item changed. Reload it and try again.",
            ),
            MvpFailure::PreflightBlocked => Self::new(
                StatusCode::CONFLICT,
                "preflight_blocked",
                "The workspace cannot be materialized until its preflight blockers are resolved.",
            ),
            MvpFailure::StalePreflight => Self::new(
                StatusCode::CONFLICT,
                "stale_preflight",
                "The workspace preflight changed and must be reviewed again.",
            ),
            MvpFailure::MaterializationFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "materialization_failed",
                "The workspace could not be materialized.",
            ),
            MvpFailure::MaterializationCleanupIncomplete => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "materialization_cleanup_incomplete",
                "Workspace materialization failed and local cleanup is incomplete.",
            ),
            MvpFailure::GeneratedWorkspaceFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "generated_workspace_failed",
                "The generated workspace files could not be committed.",
            ),
            MvpFailure::GeneratedWorkspaceCleanupIncomplete => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "generated_workspace_cleanup_incomplete",
                "Generated workspace files failed and local cleanup is incomplete.",
            ),
            MvpFailure::WorkspaceNotMaterialized => Self::new(
                StatusCode::CONFLICT,
                "workspace_not_materialized",
                "The workspace has not been materialized.",
            ),
            MvpFailure::InvalidMaterializationManifest => Self::new(
                StatusCode::CONFLICT,
                "invalid_materialization_manifest",
                "The workspace materialization record is invalid.",
            ),
            MvpFailure::WorkspaceGitStateChanged => Self::new(
                StatusCode::CONFLICT,
                "workspace_git_state_changed",
                "The managed worktrees changed since WTS last registered their Git state.",
            ),
            MvpFailure::WorkspaceEvidenceUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "workspace_evidence_unavailable",
                "Workspace verification evidence is temporarily unavailable.",
            ),
            MvpFailure::InvalidWorkspaceEvidence => Self::new(
                StatusCode::CONFLICT,
                "invalid_workspace_evidence",
                "Workspace verification evidence failed integrity validation.",
            ),
            MvpFailure::AgentSessionUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_session_unavailable",
                "The local agent session ledger is temporarily unavailable.",
            ),
            MvpFailure::InvalidAgentSessionStore => Self::new(
                StatusCode::CONFLICT,
                "invalid_agent_session_store",
                "The local agent session ledger failed integrity validation.",
            ),
            MvpFailure::AgentSessionNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "agent_session_not_found",
                "The requested agent session was not found.",
            ),
            MvpFailure::AgentSessionNotRunning => Self::new(
                StatusCode::CONFLICT,
                "agent_session_not_running",
                "The requested agent session has already ended.",
            ),
            MvpFailure::AgentProposalUnavailable => Self::new(
                StatusCode::CONFLICT,
                "agent_proposal_unavailable",
                "The agent-proposed check is unavailable or is not an approved WTS command.",
            ),
            MvpFailure::VerificationCheckUnavailable => Self::new(
                StatusCode::NOT_FOUND,
                "verification_check_unavailable",
                "The requested verification check is no longer in this workspace plan.",
            ),
            MvpFailure::VerificationRunUnavailable => Self::new(
                StatusCode::CONFLICT,
                "verification_run_unavailable",
                "There is no active or failed verification run for this action.",
            ),
            MvpFailure::VscodeUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "vscode_unavailable",
                "VS Code is unavailable.",
            ),
            MvpFailure::VscodeLaunchRejected => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "vscode_launch_rejected",
                "VS Code did not accept the workspace launch.",
            ),
            MvpFailure::AdapterUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "adapter_unavailable",
                "The requested local adapter is unavailable.",
            ),
            MvpFailure::AdapterRejected => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "adapter_rejected",
                "The requested local adapter could not start.",
            ),
            MvpFailure::AdapterTimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                "adapter_timed_out",
                "The requested local adapter timed out.",
            ),
            MvpFailure::AdapterOutputTooLarge => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "adapter_output_too_large",
                "The adapter produced more output than WTS can display safely.",
            ),
            MvpFailure::GraphIndexFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "graph_index_failed",
                "Graphify could not build the workspace graph.",
            ),
            MvpFailure::GraphRequired => Self::new(
                StatusCode::CONFLICT,
                "workspace_graph_required",
                "Build the workspace graph before starting an agent.",
            ),
            MvpFailure::WorkspaceRemovalBlocked => Self::new(
                StatusCode::CONFLICT,
                "workspace_removal_blocked",
                "The workspace contains local changes or unexpected files that must be resolved before removal.",
            ),
            MvpFailure::WorkspaceRemovalFailed => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_removal_failed",
                "The workspace could not be removed safely.",
            ),
            MvpFailure::IdempotencyConflict => Self::new(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                "The idempotency key was already used for another request.",
            ),
            MvpFailure::InvalidAgentConversation => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_agent_conversation",
                "The agent conversation request is invalid.",
            ),
            MvpFailure::AgentConversationNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "agent_conversation_not_found",
                "The agent conversation was not found.",
            ),
            MvpFailure::AgentConversationConflict => Self::new(
                StatusCode::CONFLICT,
                "agent_conversation_conflict",
                "The request changed or has started. Reload the conversation before you retry.",
            ),
            MvpFailure::AgentConversationQueueFull => Self::new(
                StatusCode::CONFLICT,
                "agent_conversation_queue_full",
                "This workspace has 64 queued requests. Wait for a request to finish or cancel a queued request.",
            ),
            MvpFailure::AgentConversationBusy => Self::new(
                StatusCode::CONFLICT,
                "agent_conversation_busy",
                "Another WTS task is active in this workspace. Wait for it to finish, then retry.",
            ),
            MvpFailure::AgentConversationPlatformUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_conversation_platform_unavailable",
                "Agent chat execution needs macOS or Linux. Saved chats remain available.",
            ),
            MvpFailure::AgentConversationStorageFull => Self::new(
                StatusCode::CONFLICT,
                "agent_conversation_storage_full",
                "Conversation storage is full. Open an existing conversation to continue.",
            ),
            MvpFailure::AgentConversationLimit => Self::new(
                StatusCode::CONFLICT,
                "agent_conversation_limit",
                "This conversation reached its limit. Start a new conversation to continue.",
            ),
            MvpFailure::AgentConversationSourceUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_conversation_source_unavailable",
                "WTS needs its source repository. Start WTS with WTS_UI_REPOSITORY_ROOT set to the source checkout.",
            ),
            MvpFailure::AgentConversationUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_conversation_unavailable",
                "The conversation or its workspace is unavailable. Check the workspace and try again.",
            ),
            MvpFailure::InvalidAgentPrompt => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_agent_prompt",
                "Enter a non-empty agent prompt within the local size limit.",
            ),
            MvpFailure::InvalidTestJourney => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_test_journey",
                "Choose a supported local user journey and loopback application URL.",
            ),
            MvpFailure::TestRunnerUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "test_runner_unavailable",
                "The local browser test runner is unavailable.",
            ),
            MvpFailure::TestRunnerFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "test_runner_failed",
                "The local browser test runner failed to complete the journey.",
            ),
            MvpFailure::TestRunnerBusy => Self::new(
                StatusCode::CONFLICT,
                "test_runner_busy",
                "Another local browser journey is already running.",
            ),
            MvpFailure::TestRunnerTimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                "test_runner_timed_out",
                "The local browser journey exceeded its time limit.",
            ),
            MvpFailure::TestRunnerOutputTooLarge => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "test_runner_output_too_large",
                "The local browser test runner produced too much output.",
            ),
            MvpFailure::TestEvidenceUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "test_evidence_unavailable",
                "Local user-test evidence is temporarily unavailable.",
            ),
            MvpFailure::TestRunNotFound => Self::test_run_not_found(),
            MvpFailure::InvalidTestEvidence => Self::new(
                StatusCode::CONFLICT,
                "invalid_test_evidence",
                "Local user-test evidence failed integrity validation.",
            ),
            MvpFailure::InvalidJiraIssueKey => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_jira_issue_key",
                "Enter a Jira key such as PLATFORM-42.",
            ),
            MvpFailure::JiraMcpUnavailable => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "jira_mcp_unavailable",
                "No supported Jira MCP stdio registration was found in VS Code.",
            ),
            MvpFailure::JiraMcpConfiguration => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "jira_mcp_configuration_invalid",
                "The Jira MCP registration uses a command or substitution WTS does not allow.",
            ),
            MvpFailure::JiraMcpSpawnFailed => Self::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "jira_mcp_spawn_failed",
                "WTS could not start Jira. Start Podman, then try again.",
            ),
            MvpFailure::JiraMcpTimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                "jira_mcp_timed_out",
                "The Jira MCP process did not answer before the timeout.",
            ),
            MvpFailure::JiraMcpProtocolInvalid => Self::new(
                StatusCode::BAD_GATEWAY,
                "jira_mcp_protocol_invalid",
                "The Jira MCP process returned an invalid protocol message.",
            ),
            MvpFailure::JiraMcpIssueToolMissing => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "jira_mcp_issue_tool_missing",
                "The Jira MCP server does not expose jira_get_issue.",
            ),
            MvpFailure::JiraMcpToolCallFailed => Self::new(
                StatusCode::BAD_GATEWAY,
                "jira_mcp_tool_call_failed",
                "The Jira MCP server could not import that issue.",
            ),
            MvpFailure::JiraMcpOutputTooLarge => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "jira_mcp_output_too_large",
                "The Jira MCP response exceeded WTS's local safety limit.",
            ),
            MvpFailure::InvalidOpenProjectReference => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_open_project_reference",
                "Enter a positive numeric OpenProject work-package ID.",
            ),
            MvpFailure::OpenProjectConfiguration => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "open_project_configuration_invalid",
                "Configure a valid OpenProject URL and personal API token.",
            ),
            MvpFailure::OpenProjectAuthentication => Self::new(
                StatusCode::BAD_GATEWAY,
                "open_project_authentication_failed",
                "OpenProject rejected the configured token.",
            ),
            MvpFailure::OpenProjectPermission => Self::new(
                StatusCode::BAD_GATEWAY,
                "open_project_permission_denied",
                "The configured OpenProject account cannot access that resource.",
            ),
            MvpFailure::OpenProjectNotFound => Self::new(
                StatusCode::NOT_FOUND,
                "open_project_work_package_not_found",
                "OpenProject did not find that work package.",
            ),
            MvpFailure::OpenProjectAmbiguous => Self::new(
                StatusCode::CONFLICT,
                "open_project_reference_ambiguous",
                "More than one OpenProject work package matched that reference.",
            ),
            MvpFailure::OpenProjectTimedOut => Self::new(
                StatusCode::GATEWAY_TIMEOUT,
                "open_project_timed_out",
                "OpenProject did not answer before the timeout.",
            ),
            MvpFailure::OpenProjectResponseTooLarge => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "open_project_response_too_large",
                "The OpenProject response exceeded WTS's local safety limit.",
            ),
            MvpFailure::OpenProjectRateLimited => Self::new(
                StatusCode::TOO_MANY_REQUESTS,
                "open_project_rate_limited",
                "OpenProject temporarily rate-limited this request.",
            ),
            MvpFailure::OpenProjectRemoteFailure => Self::new(
                StatusCode::BAD_GATEWAY,
                "open_project_remote_failure",
                "OpenProject did not return a valid API v3 response.",
            ),
            MvpFailure::Unavailable => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "local_service_unavailable",
                "The local WTS service is unavailable.",
            ),
        }
    }

    fn from_json_rejection(rejection: JsonRejection) -> Self {
        match rejection.status() {
            StatusCode::PAYLOAD_TOO_LARGE => Self::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload_too_large",
                "The JSON request exceeds the local API limit.",
            ),
            StatusCode::UNSUPPORTED_MEDIA_TYPE => Self::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "Content-Type must be application/json.",
            ),
            StatusCode::UNPROCESSABLE_ENTITY => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_payload",
                "The JSON request does not match the workspace contract.",
            ),
            _ => Self::new(
                StatusCode::BAD_REQUEST,
                "invalid_json",
                "The request body is not valid JSON.",
            ),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let retry_after = self.status == StatusCode::TOO_MANY_REQUESTS;
        let mut response = (
            self.status,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response();
        if retry_after {
            response.headers_mut().insert(
                RETRY_AFTER,
                HeaderValue::from_static(OVERLOAD_RETRY_AFTER_SECONDS),
            );
        }
        response
    }
}

async fn api_not_found() -> Response {
    ApiError::new(
        StatusCode::NOT_FOUND,
        "api_route_not_found",
        "The local API route was not found.",
    )
    .into_response()
}

async fn ui_not_built() -> Response {
    (
        StatusCode::NOT_FOUND,
        "WTS UI is not built. Build ui/dist and restart the server.",
    )
        .into_response()
}

pub fn parse_bind_address(value: &str) -> Result<SocketAddr, StartupError> {
    let address = value
        .parse::<SocketAddr>()
        .map_err(|_| StartupError::InvalidAddress)?;
    if !address.ip().is_loopback() {
        return Err(StartupError::NonLoopbackAddress);
    }
    Ok(address)
}

pub fn configured_address() -> Result<SocketAddr, StartupError> {
    let configured = env::var("WTS_ADDR").unwrap_or_else(|_| DEFAULT_ADDRESS.to_owned());
    parse_bind_address(&configured)
}

pub fn server_paths_from_env() -> Result<ServerPaths, StartupError> {
    let home = env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    let data_dir = match env::var_os("WTS_DATA_DIR").filter(|value| !value.is_empty()) {
        Some(value) => checked_absolute(PathBuf::from(value), "WTS_DATA_DIR")?,
        None => default_data_dir(home.as_deref())?,
    };
    let workspace_root = match env::var_os("WTS_WORKSPACE_ROOT").filter(|value| !value.is_empty()) {
        Some(value) => checked_absolute(PathBuf::from(value), "WTS_WORKSPACE_ROOT")?,
        None => home.ok_or(StartupError::MissingHome)?.join("cd"),
    };
    let repository_roots = match env::var_os("WTS_REPOSITORY_ROOTS")
        .filter(|value| !value.is_empty())
    {
        Some(value) => checked_repository_root_list(&value)?,
        None => {
            let root = match env::var_os("WTS_REPOSITORY_ROOT").filter(|value| !value.is_empty()) {
                Some(value) => checked_absolute(PathBuf::from(value), "WTS_REPOSITORY_ROOT")?,
                None => workspace_root.clone(),
            };
            vec![root]
        }
    };

    Ok(ServerPaths {
        data_dir,
        workspace_root,
        repository_roots,
    })
}

/// The desktop app stores workspaces under "local-default". Set
/// WTS_WORKSPACE_ROOT_ID to that value to serve a desktop registry.
fn workspace_root_id_from_env() -> String {
    workspace_root_id_from_value(env::var("WTS_WORKSPACE_ROOT_ID").ok())
}

fn workspace_root_id_from_value(value: Option<String>) -> String {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_WORKSPACE_ROOT_ID.to_owned())
}

fn checked_repository_root_list(value: &OsStr) -> Result<Vec<PathBuf>, StartupError> {
    env::split_paths(value)
        .map(|path| checked_absolute(path, "WTS_REPOSITORY_ROOTS"))
        .collect()
}

fn checked_absolute(path: PathBuf, variable: &'static str) -> Result<PathBuf, StartupError> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(StartupError::RelativePath(variable))
    }
}

/// Reads the optional host override for the Codex executable.
///
/// Only the process that starts WTS sets this value. The browser cannot change it.
pub fn agent_adapter_from_env() -> Result<wts_app::ProcessWorkspaceAdapter, StartupError> {
    agent_adapter_from_value(env::var_os("WTS_CODEX_EXECUTABLE"))
}

fn agent_adapter_from_value(
    codex: Option<std::ffi::OsString>,
) -> Result<wts_app::ProcessWorkspaceAdapter, StartupError> {
    let adapter = wts_app::ProcessWorkspaceAdapter::default();
    match codex.filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = checked_absolute(PathBuf::from(value), "WTS_CODEX_EXECUTABLE")?;
            Ok(adapter.with_agent_executable(AgentProvider::Codex, path))
        }
        None => Ok(adapter),
    }
}

#[cfg(target_os = "macos")]
fn default_data_dir(home: Option<&Path>) -> Result<PathBuf, StartupError> {
    Ok(home
        .ok_or(StartupError::MissingHome)?
        .join("Library")
        .join("Application Support")
        .join("WTS"))
}

#[cfg(target_os = "windows")]
fn default_data_dir(_home: Option<&Path>) -> Result<PathBuf, StartupError> {
    env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or(StartupError::MissingHome)
        .map(|path| path.join("WTS"))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn default_data_dir(home: Option<&Path>) -> Result<PathBuf, StartupError> {
    if let Some(path) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return checked_absolute(PathBuf::from(path), "XDG_DATA_HOME").map(|path| path.join("wts"));
    }
    Ok(home
        .ok_or(StartupError::MissingHome)?
        .join(".local")
        .join("share")
        .join("wts"))
}

pub fn available_ui_dist() -> Option<PathBuf> {
    let directory = env::var_os("WTS_UI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist"));
    if directory.join("index.html").is_file() {
        Some(directory)
    } else {
        info!(
            path = %directory.display(),
            "ui/dist is absent; API routes remain available"
        );
        None
    }
}

pub async fn run() -> ServerResult<()> {
    init_tracing()?;

    let configured = configured_address()?;
    let listener = TcpListener::bind(configured).await?;
    let bound_address = listener.local_addr()?;
    let security = SecurityPolicy::generate(bound_address)?;

    // Bind before building authority-bearing state so port 0 and dual-stack
    // behavior cannot make the accepted Host/Origin differ from the listener.
    let paths = server_paths_from_env()?;
    let adapter = agent_adapter_from_env()?;
    let workspace_root_id = workspace_root_id_from_env();
    let registry = Arc::new(LocalWtsService::open_with_repository_roots_launcher_and_adapter(
        &paths.data_dir,
        workspace_root_id.as_str(),
        &paths.workspace_root,
        paths.repository_roots,
        wts_app::ProcessExternalLauncher,
        adapter,
    )?);
    if let Some(source) = env::var_os("WTS_UI_REPOSITORY_ROOT").map(PathBuf::from) {
        let _ = registry.configure_ui_development_repository(source, None);
    }
    let ui_dist = available_ui_dist();
    let app = build_router(registry, security.clone(), ui_dist.as_deref());

    info!(
        %bound_address,
        origin = security.origin(),
        ui_available = ui_dist.is_some(),
        "WTS server listening"
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    info!("WTS server stopped");
    Ok(())
}

fn demo_boundary() -> Result<WorkspaceBoundary, wts_core::BoundaryError> {
    let draft = BoundaryDraft {
        issue_key: "PLATFORM-42".into(),
        base_graph_digest: "graph-base-demo-42".into(),
        repositories: vec![
            RepositoryPin {
                name: "checkout-api".into(),
                base_ref: "main".into(),
                base_commit: "44f62ae".into(),
                relevance_basis_points: 9_600,
                evidence: vec!["ticket-component".into(), "graph-path".into()],
            },
            RepositoryPin {
                name: "ledger-events".into(),
                base_ref: "main".into(),
                base_commit: "8ef1b88".into(),
                relevance_basis_points: 8_700,
                evidence: vec!["runtime-edge".into(), "ticket-description".into()],
            },
            RepositoryPin {
                name: "payments-sdk".into(),
                base_ref: "main".into(),
                base_commit: "cb1f8a2".into(),
                relevance_basis_points: 9_100,
                evidence: vec!["idempotency-contract".into(), "compatible-ci".into()],
            },
        ],
        services: vec![
            ServiceSpec {
                id: "checkout-api".into(),
                repository: "checkout-api".into(),
                default_port: 9_000,
                depends_on: vec![],
            },
            ServiceSpec {
                id: "ledger-events".into(),
                repository: "ledger-events".into(),
                default_port: 9_100,
                depends_on: vec!["checkout-api".into()],
            },
        ],
    };
    let occupied = BTreeSet::from([9_000, 9_100]);
    let revision_one = BoundaryCompiler::compile(draft.clone(), &occupied)?;
    let revision_two = revision_one.revise(draft.clone(), &occupied)?;
    revision_two.revise(draft, &occupied)
}

fn init_tracing() -> ServerResult<()> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(default_tracing_filter()));
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .try_init()?;
    Ok(())
}

fn default_tracing_filter() -> &'static str {
    if cfg!(debug_assertions) {
        "wts_server=info,wts_app::repository_catalog=info,wts_app::repository_clone=info,wts_app::runtime_analysis=info,wts_app::operations=info,tower_http=warn"
    } else {
        "wts_server=info"
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            warn!(%error, "failed to install Ctrl+C handler");
            std::future::pending::<()>().await;
        }
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                warn!(%error, "failed to install SIGTERM handler");
                std::future::pending::<()>().await;
            }
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {}
        () = terminate => {}
    }
    info!("shutdown signal received");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_root_id_uses_the_desktop_value_when_set() {
        assert_eq!(workspace_root_id_from_value(None), "default");
        assert_eq!(workspace_root_id_from_value(Some("  ".into())), "default");
        assert_eq!(
            workspace_root_id_from_value(Some("local-default".into())),
            "local-default"
        );
    }
    use axum::{
        body::{Body, to_bytes},
        http::{
            Request,
            header::{ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_TYPE},
        },
    };
    use serde_json::{Value, json};
    use std::{
        collections::BTreeMap,
        io::{Read, Write},
        net::TcpListener as StdTcpListener,
        sync::{
            Condvar, Mutex,
            atomic::{AtomicUsize, Ordering},
        },
        thread,
    };
    use tower::ServiceExt;
    use wts_core::workspace::{
        RenameWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
    };

    const TEST_TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TEST_KEY: &str = "11111111-1111-4111-8111-111111111111";
    const MATERIALIZE_KEY: &str = "33333333-3333-4333-8333-333333333333";
    const REMOVE_KEY: &str = "44444444-4444-4444-8444-444444444444";

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FakeWorkspace {
        workspace_id: Uuid,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        display_name: Option<String>,
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FakeWorkspaceList {
        workspace_root_id: &'static str,
        workspace_root_display_path: &'static str,
        workspaces: Vec<FakeWorkspace>,
    }

    #[derive(Default)]
    struct FakeRegistry {
        workspaces: Mutex<BTreeMap<Uuid, FakeWorkspace>>,
        materializations: Mutex<BTreeMap<Uuid, Value>>,
        idempotency: Mutex<BTreeMap<String, (String, Uuid)>>,
        removal_idempotency: Mutex<BTreeMap<String, (Uuid, String, Value)>>,
        removal_preflight: Mutex<Option<wts_app::WorkspaceRemovalPreflight>>,
        setup_recovery_preflight: Mutex<Option<wts_app::WorkspacePreflight>>,
        setup_recovery_calls: Mutex<Vec<(Uuid, String)>>,
        create_failure: Mutex<Option<RegistryFailure>>,
        sequence: AtomicUsize,
        discussion_calls: AtomicUsize,
        merge_request_link_calls: Mutex<Vec<(Uuid, String, u64)>>,
        merge_request_link_failure: Mutex<Option<MvpFailure>>,
        source_calls: AtomicUsize,
        turn_changes: Mutex<Option<wts_app::AgentTurnChanges>>,
        turn_decisions: Mutex<Option<wts_app::AgentTurnDecisions>>,
        work_set: Mutex<Option<wts_app::AgentWorkSet>>,
        work_item_integration_preflight: Mutex<Option<wts_app::AgentWorkItemIntegrationPreflight>>,
        work_item_integration_result: Mutex<Option<wts_app::AgentWorkItemIntegrationResult>>,
        turn_checks: Mutex<Option<wts_app::AgentTurnChecks>>,
        turn_restore_preflight: Mutex<Option<wts_app::AgentTurnRestorePreflight>>,
        turn_restore_result: Mutex<Option<wts_app::AgentTurnRestoreResult>>,
        turn_recovery_calls: Mutex<Vec<Value>>,
        verification_probe: Option<Arc<BlockingProbe>>,
    }

    #[derive(Default)]
    struct BlockingProbe {
        active: AtomicUsize,
        calls: AtomicUsize,
        peak: AtomicUsize,
        released: Mutex<bool>,
        release_signal: Condvar,
    }

    impl BlockingProbe {
        fn enter(&self) {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(active, Ordering::SeqCst);

            let mut released = self.released.lock().expect("probe release lock");
            while !*released {
                released = self
                    .release_signal
                    .wait(released)
                    .expect("probe release wait");
            }
            self.active.fetch_sub(1, Ordering::SeqCst);
        }

        fn release(&self) {
            *self.released.lock().expect("probe release lock") = true;
            self.release_signal.notify_all();
        }
    }

    fn fake_running_agent_session(session_id: Uuid) -> AgentSession {
        AgentSession {
            schema_version: 1,
            session_id,
            workspace_id: Uuid::from_u128(42),
            provider: AgentProvider::Codex,
            terminal: TerminalProvider::Terminal,
            category: AgentSessionCategory::Implementation,
            status: wts_app::AgentSessionStatus::Running,
            started_at_unix_ms: 2_000,
            last_heartbeat_at_unix_ms: 3_000,
            ended_at_unix_ms: None,
            failure: None,
            needs_input: None,
            change_request_proposals: Vec::new(),
            mr_link_proposals: Vec::new(),
        }
    }

    impl RegistryBackend for FakeRegistry {
        type Workspace = FakeWorkspace;
        type WorkspaceList = FakeWorkspaceList;

        fn list(&self) -> Result<Self::WorkspaceList, RegistryFailure> {
            let workspaces = self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .values()
                .cloned()
                .collect();
            Ok(FakeWorkspaceList {
                workspace_root_id: "default",
                workspace_root_display_path: "/Users/test/cd",
                workspaces,
            })
        }

        fn get(&self, workspace_id: Uuid) -> Result<Option<Self::Workspace>, RegistryFailure> {
            Ok(self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .get(&workspace_id)
                .cloned())
        }

        fn rename(
            &self,
            workspace_id: Uuid,
            request: RenameWorkspaceRequest,
        ) -> Result<Self::Workspace, RegistryFailure> {
            let request = request
                .normalize()
                .map_err(|error| RegistryFailure::Validation(error.to_string()))?;
            let mut workspaces = self.workspaces.lock().expect("workspace test lock");
            let workspace = workspaces
                .get_mut(&workspace_id)
                .ok_or(RegistryFailure::NotFound)?;
            workspace.display_name = Some(request.title);
            Ok(workspace.clone())
        }

        fn create(
            &self,
            idempotency_key: &str,
            request: CreateWorkspaceRequest,
        ) -> Result<CreateOutcome<Self::Workspace>, RegistryFailure> {
            if let Some(failure) = self
                .create_failure
                .lock()
                .expect("create failure test lock")
                .take()
            {
                return Err(failure);
            }
            let request = request
                .normalize()
                .map_err(|error| RegistryFailure::Validation(error.to_string()))?;
            let fingerprint = serde_json::to_string(&request).expect("serialize test request");

            let mut idempotency = self.idempotency.lock().expect("idempotency test lock");
            if let Some((existing_fingerprint, workspace_id)) = idempotency.get(idempotency_key) {
                if existing_fingerprint != &fingerprint {
                    return Err(RegistryFailure::Conflict);
                }
                let workspace = self
                    .workspaces
                    .lock()
                    .expect("workspace test lock")
                    .get(workspace_id)
                    .expect("idempotency points at workspace")
                    .clone();
                return Ok(CreateOutcome {
                    workspace,
                    replayed: true,
                });
            }

            let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) as u128 + 1;
            let workspace = FakeWorkspace {
                workspace_id: Uuid::from_u128(sequence),
                title: request.title,
                display_name: None,
            };
            self.workspaces
                .lock()
                .expect("workspace test lock")
                .insert(workspace.workspace_id, workspace.clone());
            idempotency.insert(
                idempotency_key.to_owned(),
                (fingerprint, workspace.workspace_id),
            );
            Ok(CreateOutcome {
                workspace,
                replayed: false,
            })
        }
    }

    impl MvpBackend for FakeRegistry {
        fn run_code_review(
            &self,
            workspace_id: Uuid,
            provider: AgentProvider,
            scope: CodeReviewScope,
            options: CodeReviewOptions,
        ) -> Result<Self::CodeReview, MvpFailure> {
            let call = json!({"operation":"runCodeReview","workspaceId":workspace_id,"provider":provider,"scope":scope,"model":options.model,"repositoryId":options.repository_id,"ignoreSizeGate":options.ignore_size_gate,"skill":options.skill,"mergeRequestIid":options.merge_request_iid});
            self.turn_recovery_calls.lock().unwrap().push(call.clone());
            Ok(json!({"workspaceId": workspace_id, "mode": "raptik", "findings": [], "request": call}))
        }
        fn get_code_review(&self, workspace_id: Uuid) -> Result<Option<Self::CodeReview>, MvpFailure> {
            Ok(Some(json!({"workspaceId": workspace_id, "mode": "raptik", "findings": []})))
        }
        fn agent_models(&self, refresh: bool) -> Result<wts_app::AgentModelCatalog, MvpFailure> {
            Ok(wts_app::AgentModelCatalog {
                providers: vec![wts_app::AgentProviderModels {
                    provider: AgentProvider::Codex,
                    installed: true,
                    default_model: Some(if refresh { "refreshed" } else { "gpt-5.6-sol" }.to_owned()),
                    default_source: Some("~/.codex/config.toml".to_owned()),
                    models: vec!["gpt-5.6-sol".to_owned()],
                    model_selectable: true,
                }],
                raptik_skill_loaded: true,
                review_skills: Vec::new(),
                default_review_skill: Some("raptik-review".to_owned()),
            })
        }
        fn code_review_trace(
            &self,
            workspace_id: Uuid,
            after: Option<u32>,
        ) -> Result<Option<wts_app::CodeReviewTrace>, MvpFailure> {
            let after = after.unwrap_or(0);
            Ok(Some(wts_app::CodeReviewTrace {
                workspace_id,
                run_id: Uuid::nil(),
                provider: AgentProvider::Codex,
                model: Some("gpt-5.6-sol".to_owned()),
                state: wts_app::CodeReviewRunState::Running,
                started_at_unix_ms: 1,
                steps: (1..=3)
                    .filter(|sequence| *sequence > after)
                    .map(|sequence| wts_app::CodeReviewTraceStep {
                        sequence,
                        kind: wts_app::CodeReviewTraceKind::Command,
                        text: format!("step {sequence}"),
                        detail: None,
                        item_id: None,
                        running: sequence == 3,
                        at_unix_ms: 1,
                    })
                    .collect(),
                dropped_steps: 0,
            }))
        }
        type Setup = Value;
        type GithubReviewInbox = Value;
        type GithubReviewOpen = Value;
        type GitlabReviewInbox = Value;
        type GitlabDiscussions = Value;
        type GitlabDiscussionReply = Value;
        type GitlabReviewCommentPublication = Value;
        type GitlabMergeRequestInbox = Value;
        type GitlabMergeRequestLink = Value;
        type GitlabMergeRequestOpen = Value;
        type GitlabIntegrationStatus = Value;
        type RepositoryCatalog = Value;
        type RepositoryClone = Value;
        type RepositoryRefresh = Value;
        type RepositoryBaseOpen = Value;
        type ChangeRequestDraft = Value;
        type BranchPublication = Value;
        type ChangeRequestOpen = Value;
        type CodeWorkspaceImport = Value;
        type RuntimeAnalysis = Value;
        type Preflight = Value;
        type ExistingMaterialization = Value;
        type RepositoryDiff = Value;
        type RepositoryFileReview = Value;
        type GitlabComparison = Value;
        type RepositorySource = Value;
        type RepositoryReviewGraph = Value;
        type RepositorySync = Value;
        type RepositoryAdditionPreflight = Value;
        type RepositoryAddition = Value;
        type RepositoryRemoval = Value;
        type RepositoryAlignmentPreflight = Value;
        type RepositoryAlignment = Value;
        type Materialization = Value;
        type OpenWorkspace = Value;
        type CliLaunch = Value;
        type AgentBrief = Value;
        type GraphIndex = Value;
        type RemovalPreflight = Value;
        type Removal = Value;
        type AgentRun = Value;
        type CodeReview = Value;
        type Evidence = Value;
        type TestRunList = Value;
        type TestRunDetail = Value;
        type TestRun = Value;
        type JiraVerification = Value;
        type JiraActiveIssues = Value;
        type TimeReviewBrief = Value;
        type JiraIssue = Value;
        type OpenProjectVerification = Value;
        type OpenProjectWorkPackage = Value;
        type Workflow = Value;
        type PlanningDocumentList = Value;
        type PlanningDocument = Value;
        type ReviewThreadList = Value;
        type ReviewThread = Value;
        type WorkItemLinkPreview = Value;
        type WorkItemLinkConfirmation = Value;
        type WorkItemLinkList = Value;
        type WorkItemUnlink = Value;
        type WorkItemOpen = Value;
        type JiraCreateProposal = Value;

        fn get_agent_turn_changes(
            &self,
            conversation_id: Uuid,
            request_id: Uuid,
        ) -> Result<wts_app::AgentTurnChanges, MvpFailure> {
            let receipt = self
                .turn_changes
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if receipt.conversation_id != conversation_id || receipt.request_id != request_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            Ok(receipt)
        }

        fn get_agent_work_set(
            &self,
            work_set_id: Uuid,
        ) -> Result<wts_app::AgentWorkSet, MvpFailure> {
            let set = self
                .work_set
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if set.work_set_id != work_set_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            Ok(set)
        }
        fn list_agent_work_sets(
            &self,
            conversation_id: Uuid,
            request_id: Uuid,
        ) -> Result<wts_app::AgentWorkSetList, MvpFailure> {
            let set = self
                .work_set
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if set.conversation_id != conversation_id || set.request_id != request_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            Ok(wts_app::AgentWorkSetList {
                schema_version: 1,
                conversation_id,
                request_id,
                work_sets: vec![set],
            })
        }
        fn create_agent_work_set(
            &self,
            conversation_id: Uuid,
            turn_request_id: Uuid,
            request: wts_app::CreateAgentWorkSetRequest,
        ) -> Result<wts_app::AgentWorkSet, MvpFailure> {
            let set = self.get_agent_work_set(request.request_id)?;
            if set.conversation_id != conversation_id || set.request_id != turn_request_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            self.turn_recovery_calls.lock().unwrap().push(json!({"operation":"createWorkSet","conversationId":conversation_id,"turnRequestId":turn_request_id,"request":request}));
            Ok(set)
        }
        fn cancel_agent_work_item(
            &self,
            work_set_id: Uuid,
            task_id: Uuid,
            request: wts_app::AgentWorkItemCancelRequest,
        ) -> Result<wts_app::AgentWorkSet, MvpFailure> {
            let set = self.get_agent_work_set(work_set_id)?;
            if !set.tasks.iter().any(|task| task.task_id == task_id) {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            self.turn_recovery_calls.lock().unwrap().push(json!({"operation":"cancelWorkItem","workSetId":work_set_id,"taskId":task_id,"request":request}));
            Ok(set)
        }
        fn preflight_agent_work_item_integration(
            &self,
            work_set_id: Uuid,
            task_id: Uuid,
        ) -> Result<wts_app::AgentWorkItemIntegrationPreflight, MvpFailure> {
            let preflight = self
                .work_item_integration_preflight
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if preflight.work_set_id != work_set_id || preflight.task_id != task_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            Ok(preflight)
        }
        fn integrate_agent_work_item(
            &self,
            work_set_id: Uuid,
            task_id: Uuid,
            request: wts_app::IntegrateAgentWorkItemRequest,
        ) -> Result<wts_app::AgentWorkItemIntegrationResult, MvpFailure> {
            let result = self
                .work_item_integration_result
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if result.work_set_id != work_set_id || result.task_id != task_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            self.turn_recovery_calls.lock().unwrap().push(json!({"operation":"integrateWorkItem","workSetId":work_set_id,"taskId":task_id,"request":request}));
            Ok(result)
        }

        fn get_agent_turn_decisions(
            &self,
            conversation_id: Uuid,
            request_id: Uuid,
        ) -> Result<wts_app::AgentTurnDecisions, MvpFailure> {
            let receipt = self
                .turn_decisions
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if receipt.conversation_id != conversation_id || receipt.request_id != request_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            Ok(receipt)
        }
        fn record_agent_turn_decision(
            &self,
            conversation_id: Uuid,
            turn_request_id: Uuid,
            request: wts_app::RecordAgentTurnDecisionRequest,
        ) -> Result<wts_app::AgentTurnDecisions, MvpFailure> {
            let receipt = self.get_agent_turn_decisions(conversation_id, turn_request_id)?;
            self.turn_recovery_calls.lock().unwrap().push(json!({"operation":"decision","conversationId":conversation_id,"turnRequestId":turn_request_id,"request":request}));
            Ok(receipt)
        }
        fn get_agent_turn_checks(
            &self,
            conversation_id: Uuid,
            request_id: Uuid,
        ) -> Result<wts_app::AgentTurnChecks, MvpFailure> {
            let receipt = self
                .turn_checks
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if receipt.conversation_id != conversation_id || receipt.request_id != request_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            Ok(receipt)
        }
        fn run_agent_turn_check(
            &self,
            conversation_id: Uuid,
            turn_request_id: Uuid,
            request: wts_app::RunAgentTurnCheckRequest,
        ) -> Result<wts_app::AgentTurnChecks, MvpFailure> {
            let receipt = self.get_agent_turn_checks(conversation_id, turn_request_id)?;
            self.turn_recovery_calls.lock().unwrap().push(json!({"operation":"check","conversationId":conversation_id,"turnRequestId":turn_request_id,"request":request}));
            Ok(receipt)
        }
        fn preflight_agent_turn_restore(
            &self,
            conversation_id: Uuid,
            request_id: Uuid,
        ) -> Result<wts_app::AgentTurnRestorePreflight, MvpFailure> {
            let receipt = self
                .turn_restore_preflight
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if receipt.conversation_id != conversation_id || receipt.request_id != request_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            Ok(receipt)
        }
        fn restore_agent_turn(
            &self,
            conversation_id: Uuid,
            turn_request_id: Uuid,
            request: wts_app::AgentTurnRestoreRequest,
        ) -> Result<wts_app::AgentTurnRestoreResult, MvpFailure> {
            let receipt = self
                .turn_restore_result
                .lock()
                .unwrap()
                .clone()
                .ok_or(MvpFailure::Unavailable)?;
            if receipt.conversation_id != conversation_id || receipt.request_id != turn_request_id {
                return Err(MvpFailure::AgentConversationNotFound);
            }
            self.turn_recovery_calls.lock().unwrap().push(json!({"operation":"restore","conversationId":conversation_id,"turnRequestId":turn_request_id,"request":request}));
            Ok(receipt)
        }

        fn setup(&self) -> Result<Self::Setup, MvpFailure> {
            Ok(json!({
                "checkedAtUnixMs": 1,
                "repositoryCount": 1,
                "integrations": []
            }))
        }

        fn github_review_inbox(&self) -> Result<Self::GithubReviewInbox, MvpFailure> {
            Ok(json!({
                "schemaVersion": 1,
                "state": "fresh",
                "reviews": [{
                    "id": "PR_1",
                    "repositoryId": "repo-1",
                    "repository": "acme/checkout-api",
                    "number": 7,
                    "title": "Review checkout change",
                    "url": "https://github.com/acme/checkout-api/pull/7",
                    "authorLogin": "alice",
                    "updatedAt": "2026-08-14T09:00:00Z",
                    "draft": false
                }],
                "fetchedAtUnixMs": 1,
                "detail": "GitHub returned the current individual review requests."
            }))
        }

        fn open_github_review(
            &self,
            repository_id: &str,
            number: u64,
        ) -> Result<Self::GithubReviewOpen, MvpFailure> {
            if repository_id != "repo-1" || number != 7 {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(json!({
                "repositoryId": repository_id,
                "number": number,
                "accepted": true
            }))
        }

        fn gitlab_review_inbox(&self) -> Result<Self::GitlabReviewInbox, MvpFailure> {
            Ok(json!({
                "schemaVersion": 1,
                "state": "fresh",
                "reviews": [{
                    "id": "1017",
                    "repositoryId": "repo-1",
                    "repository": "acme/checkout-api",
                    "number": 17,
                    "title": "Review checkout delivery",
                    "authorLogin": "bob",
                    "sourceBranch": "feat/delivery",
                    "targetBranch": "develop",
                    "updatedAt": "2026-08-14T09:00:00Z",
                    "draft": false
                }],
                "fetchedAtUnixMs": 1,
                "detail": "GitLab returned the current individual review requests."
            }))
        }

        fn gitlab_discussions(
            &self,
            repository_id: &str,
            iid: u64,
            workspace_id: Option<Uuid>,
        ) -> Result<Self::GitlabDiscussions, MvpFailure> {
            self.discussion_calls.fetch_add(1, Ordering::SeqCst);
            if repository_id != "repo-1" || iid != 17 || workspace_id.is_some_and(|id| !id.is_nil())
            {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(
                json!({"schemaVersion":1,"repositoryId":repository_id,"iid":iid,"scopeId":"a".repeat(64),"viewerLogin":"alice","discussions":[],"fetchedAtUnixMs":1,"fromCache":false,"truncated":false}),
            )
        }

        fn reply_gitlab_discussion(
            &self,
            repository_id: &str,
            iid: u64,
            request: wts_app::ReplyGitlabDiscussionRequest,
        ) -> Result<Self::GitlabDiscussionReply, MvpFailure> {
            self.discussion_calls.fetch_add(1, Ordering::SeqCst);
            if repository_id != "repo-1"
                || iid != 17
                || request.workspace_id != Some(Uuid::nil())
                || request.discussion_id != "thread-1"
            {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(
                json!({"schemaVersion":1,"repositoryId":repository_id,"iid":iid,"discussionId":request.discussion_id,"comment":{"id":92,"body":request.body,"authorLogin":"alice","createdAt":"2026-09-17T00:00:00Z"}}),
            )
        }

        fn gitlab_merge_requests(
            &self,
            _workspace_id: Uuid,
        ) -> Result<Self::GitlabMergeRequestInbox, MvpFailure> {
            Ok(json!({
                "schemaVersion": 1,
                "state": "fresh",
                "mergeRequests": [{
                    "id": "1017",
                    "repositoryId": "repo-1",
                    "projectPath": "acme/checkout-api",
                    "iid": 17,
                    "title": "Track delivery",
                    "authorUsername": "alice",
                    "sourceBranch": "feat/delivery",
                    "targetBranch": "develop",
                    "sourceHeadCommitOid": "0123456789abcdef0123456789abcdef01234567",
                    "updatedAt": "2026-08-14T09:00:00Z",
                    "draft": false,
                    "status": "open"
                }],
                "fetchedAtUnixMs": 1,
                "detail": "GitLab returned the current authored merge requests."
            }))
        }

        fn link_workspace_gitlab_merge_request(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
            iid: u64,
        ) -> Result<Self::GitlabMergeRequestLink, MvpFailure> {
            self.merge_request_link_calls.lock().unwrap().push((
                workspace_id,
                repository_id.to_owned(),
                iid,
            ));
            if let Some(failure) = *self.merge_request_link_failure.lock().unwrap() {
                return Err(failure);
            }
            Ok(json!({
                "id": "1043",
                "repositoryId": repository_id,
                "projectPath": "sre-tools/senzu",
                "webUrl": "https://gitlab.example.com/sre-tools/senzu/-/merge_requests/43",
                "iid": iid,
                "title": "Senzu complete flow",
                "authorUsername": "alice",
                "sourceBranch": "review/senzu-complete-flow",
                "targetBranch": "develop",
                "sourceHeadCommitOid": "0123456789abcdef0123456789abcdef01234567",
                "updatedAt": "2026-09-23T09:00:00Z",
                "draft": false,
                "status": "open"
            }))
        }

        fn publish_gitlab_review_comment(
            &self,
            repository_id: &str,
            iid: u64,
            request: wts_app::GitlabReviewCommentRequest,
        ) -> Result<Self::GitlabReviewCommentPublication, MvpFailure> {
            self.discussion_calls.fetch_add(1, Ordering::SeqCst);
            if repository_id != "repo-1"
                || iid != 17
                || request.workspace_id.as_deref() != Some(Uuid::nil().to_string().as_str())
                || request
                    .expected_position
                    .as_ref()
                    .map(|position| position.head_commit_oid.as_str())
                    != Some("b".repeat(40).as_str())
            {
                return Err(MvpFailure::GitlabReviewCommentFailed);
            }
            Ok(json!({"schemaVersion":1,"repositoryId":repository_id,"iid":iid,"accepted":true}))
        }

        fn gitlab_integration_status(
            &self,
            _workspace_id: Uuid,
        ) -> Result<Self::GitlabIntegrationStatus, MvpFailure> {
            Ok(json!({
                "schemaVersion": 1,
                "cliState": "ready",
                "accounts": [{
                    "host": "gitlab.example.com",
                    "state": "signedOut"
                }],
                "detail": "Sign in to each GitLab host that you want WTS to use."
            }))
        }

        fn open_gitlab_merge_request(
            &self,
            repository_id: &str,
            iid: u64,
        ) -> Result<Self::GitlabMergeRequestOpen, MvpFailure> {
            if repository_id != "repo-1" || iid != 17 {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(json!({"repositoryId": repository_id, "iid": iid, "accepted": true}))
        }

        fn prepare_gitlab_review_repository(
            &self,
            repository_id: &str,
            iid: u64,
        ) -> Result<Self::RepositoryClone, MvpFailure> {
            if repository_id != "repo-1" || iid != 17 {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(json!({
                "repository": {
                    "id": "repo-1",
                    "label": "checkout-api",
                    "checkoutLeaf": "checkout-api",
                    "displayPath": "/Users/test/src/checkout-api",
                    "defaultBranch": {
                        "name": "main",
                        "fullRef": "refs/remotes/origin/main",
                        "commitOid": "1111111111111111111111111111111111111111"
                    }
                },
                "repositoryRootDisplayPath": "/Users/test/src",
                "reusedExisting": true
            }))
        }

        fn repositories(&self) -> Result<Self::RepositoryCatalog, MvpFailure> {
            Ok(json!({
                "repositoryRootDisplayPath": "/Users/test/src",
                "repositories": [{
                    "id": "repo-1",
                    "label": "checkout-api",
                    "displayPath": "/Users/test/src/checkout-api",
                    "defaultBranch": {
                        "name": "main",
                        "fullRef": "refs/heads/main",
                        "commitOid": "1111111111111111111111111111111111111111"
                    }
                }],
                "skippedEntries": 0
            }))
        }

        fn clone_repository(
            &self,
            request: CloneRepositoryRequest,
        ) -> Result<Self::RepositoryClone, MvpFailure> {
            if request.remote_url != "https://github.com/acme/ledger-api.git" {
                return Err(MvpFailure::InvalidRepositoryRemote);
            }
            Ok(json!({
                "repository": {
                    "id": "repo-cloned",
                    "label": "ledger-api",
                    "checkoutLeaf": "ledger-api",
                    "displayPath": "/Users/test/src/ledger-api",
                    "originUrl": request.remote_url,
                    "defaultBranch": {
                        "name": "main",
                        "fullRef": "refs/remotes/origin/main",
                        "commitOid": "2222222222222222222222222222222222222222"
                    }
                },
                "repositoryRootDisplayPath": "/Users/test/src",
                "reusedExisting": false
            }))
        }

        fn refresh_repository_branches(
            &self,
            repository_id: &str,
        ) -> Result<Self::RepositoryRefresh, MvpFailure> {
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(json!({
                "repository": {
                    "id": "repo-1",
                    "label": "checkout-api",
                    "checkoutLeaf": "checkout-api",
                    "displayPath": "/Users/test/src/checkout-api",
                    "originUrl": "https://gitlab.example.com/acme/checkout-api.git",
                    "defaultBranch": {
                        "name": "main",
                        "fullRef": "refs/remotes/origin/main",
                        "commitOid": "1111111111111111111111111111111111111111"
                    },
                    "availableBranches": [{
                        "name": "dev-local",
                        "fullRef": "refs/remotes/origin/dev-local",
                        "commitOid": "2222222222222222222222222222222222222222",
                        "remote": true
                    }]
                }
            }))
        }

        fn open_repository_base(
            &self,
            repository_id: &str,
            base_ref: &str,
        ) -> Result<Self::RepositoryBaseOpen, MvpFailure> {
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            if base_ref != "main" {
                return Err(MvpFailure::RepositoryBaseNotFound);
            }
            Ok(json!({
                "repositoryId": repository_id,
                "forge": "gitlab",
                "host": "gitlab.example.test",
                "baseRef": base_ref,
                "commitOid": "1111111111111111111111111111111111111111",
                "accepted": true
            }))
        }

        fn prepare_workspace_change_request(
            &self,
            workspace_id: Uuid,
            request: PrepareWorkspaceChangeRequest,
        ) -> Result<Self::ChangeRequestDraft, MvpFailure> {
            Ok(json!({
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "repositoryId": request.repository_id,
                "repositoryLabel": "checkout-api",
                "forge": "gitlab",
                "host": "gitlab.example.test",
                "sourceRemoteName": "upstream",
                "sourceBranch": "feat/PLATFORM-7197",
                "sourceHeadCommitOid": "1111111111111111111111111111111111111111",
                "targetBranch": "main",
                "commitSubject": "Validate admission",
                "proposedBySessionId": Uuid::from_u128(85),
                "proposedByProvider": "codex",
                "commits": [{
                    "commitOid": "1111111111111111111111111111111111111111",
                    "subject": "Validate admission"
                }],
                "changedFiles": ["src/admission.rs"],
                "worktreeClean": true,
                "remoteMatches": true,
                "title": "PLATFORM-7197: Validate admission",
                "body": "## Summary\n\n- Validate admission",
                "workItems": [],
                "verificationStatus": "notReported",
                "verificationSummary": "The agent did not report verification.",
                "effectDigest": format!("sha256:{}", "a".repeat(64))
            }))
        }

        fn publish_workspace_change_request_branch(
            &self,
            workspace_id: Uuid,
            request: PublishWorkspaceChangeRequestBranch,
        ) -> Result<Self::BranchPublication, MvpFailure> {
            let branch_name = request
                .branch_name
                .unwrap_or_else(|| "feat/PLATFORM-7197".to_owned());
            Ok(json!({
                "workspaceId": workspace_id,
                "repositoryId": request.repository_id,
                "repositoryLabel": "checkout-api",
                "remoteName": "origin",
                "branchName": branch_name,
                "headCommitOid": "1111111111111111111111111111111111111111"
            }))
        }

        fn open_workspace_change_request_draft(
            &self,
            workspace_id: Uuid,
            request: OpenWorkspaceChangeRequestDraft,
        ) -> Result<Self::ChangeRequestOpen, MvpFailure> {
            Ok(json!({
                "workspaceId": workspace_id,
                "repositoryId": request.repository_id,
                "forge": "gitlab",
                "host": "gitlab.example.test",
                "sourceBranch": "feat/PLATFORM-7197",
                "targetBranch": "main",
                "sourceHeadCommitOid": "1111111111111111111111111111111111111111",
                "accepted": true
            }))
        }

        fn import_code_workspace(
            &self,
            request: CodeWorkspaceImportRequest,
        ) -> Result<Self::CodeWorkspaceImport, MvpFailure> {
            let import_id = request
                .import_id()
                .expect("HTTP transport assigns an import id");
            let repository_id = format!("repo_{}", "1".repeat(64));
            Ok(json!({
                "importId": import_id,
                "fileName": request.file_name,
                "suggestedTitle": "checkout",
                "suggestedRepositorySetLabel": "VS Code · checkout",
                "folders": [{
                    "name": "checkout-api",
                    "rawPath": "../checkout-api",
                    "status": "matched",
                    "repositoryId": repository_id.clone(),
                    "repositoryLabel": "checkout-api",
                    "repositoryDisplayPath": "/Users/test/cd/checkout-api",
                    "baseRef": "main"
                }],
                "repositories": [{
                    "repositoryId": repository_id,
                    "label": "checkout-api",
                    "baseRef": "main"
                }],
                "warnings": []
            }))
        }

        fn analyze_runtime(
            &self,
            request: RuntimeAnalysisRequest,
        ) -> Result<Self::RuntimeAnalysis, MvpFailure> {
            let repository = request
                .repositories
                .first()
                .ok_or(MvpFailure::Unavailable)?;
            let repository_id = repository
                .repository_id
                .as_deref()
                .ok_or(MvpFailure::Unavailable)?;
            Ok(json!({
                "analysisDigest": format!("sha256:{}", "a".repeat(64)),
                "repositories": [{
                    "repositoryId": repository_id,
                    "repositoryLabel": repository.label,
                    "requestedBaseRef": repository.base_ref,
                    "resolvedBaseRef": "refs/heads/main",
                    "commitOid": "1111111111111111111111111111111111111111"
                }],
                "services": [],
                "warnings": [],
                "graph": {
                    "status": "unavailable",
                    "detail": "Graphify enrichment is optional for runtime analysis."
                }
            }))
        }

        fn transition_workflow(
            &self,
            workspace_id: Uuid,
            request: TransitionWorkspaceWorkflowRequest,
        ) -> Result<Self::Workflow, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            Ok(json!({
                "state": request.state,
                "revision": request.expected_revision + 1,
                "updatedAtUnixMs": 42,
            }))
        }

        fn place_workspace_on_board(
            &self,
            workspace_id: Uuid,
            request: PlaceWorkspaceOnBoardRequest,
        ) -> Result<Self::Workflow, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            Ok(json!({
                "state": request.state,
                "revision": request.expected_revision + 1,
                "updatedAtUnixMs": 42,
                "placement": { "mode": "pinned", "rank": 0 },
            }))
        }

        fn follow_workspace_agent(
            &self,
            workspace_id: Uuid,
            request: FollowWorkspaceAgentRequest,
        ) -> Result<Self::Workflow, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            Ok(json!({
                "state": "ready",
                "revision": request.expected_revision + 1,
                "updatedAtUnixMs": 42,
                "placement": { "mode": "automatic", "rank": 0 },
            }))
        }

        fn list_planning_documents(
            &self,
            workspace_id: Uuid,
        ) -> Result<Self::PlanningDocumentList, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "documents": [{ "documentId": "plan", "fileName": "PLAN.md" }],
            }))
        }

        fn read_planning_document(
            &self,
            workspace_id: Uuid,
            document_id: WorkspacePlanningDocumentId,
        ) -> Result<Self::PlanningDocument, MvpFailure> {
            if document_id != WorkspacePlanningDocumentId::Plan {
                return Err(MvpFailure::PlanningDocumentUnavailable);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "documentId": "plan",
                "fileName": "PLAN.md",
                "contents": "# Plan\n",
                "sha256": format!("sha256:{}", "a".repeat(64)),
            }))
        }

        fn update_planning_document(
            &self,
            workspace_id: Uuid,
            document_id: WorkspacePlanningDocumentId,
            request: UpdateWorkspacePlanningDocumentRequest,
        ) -> Result<Self::PlanningDocument, MvpFailure> {
            if document_id != WorkspacePlanningDocumentId::Plan {
                return Err(MvpFailure::PlanningDocumentUnavailable);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "documentId": "plan",
                "fileName": "PLAN.md",
                "contents": request.contents,
                "sha256": format!("sha256:{}", "b".repeat(64)),
            }))
        }

        fn list_review_threads(
            &self,
            workspace_id: Uuid,
        ) -> Result<Self::ReviewThreadList, MvpFailure> {
            Ok(json!({ "workspaceId": workspace_id, "threads": [] }))
        }

        fn create_review_thread(
            &self,
            workspace_id: Uuid,
            request: CreateWorkspaceReviewThreadRequest,
        ) -> Result<Self::ReviewThread, MvpFailure> {
            let (current_document_sha256, current_verification_completed_at_unix_ms) =
                match &request.target {
                    wts_app::ReviewTarget::PlanningDocument { .. } => {
                        (Some(format!("sha256:{}", "a".repeat(64))), None)
                    }
                    wts_app::ReviewTarget::VerificationCheck {
                        completed_at_unix_ms,
                        ..
                    } => (None, Some(*completed_at_unix_ms)),
                    wts_app::ReviewTarget::CodeChange { .. } => (None, None),
                };
            Ok(json!({
                "threadId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "workspaceId": workspace_id,
                "target": request.target,
                "anchorState": "current",
                "currentDocumentSha256": current_document_sha256,
                "currentVerificationCompletedAtUnixMs": current_verification_completed_at_unix_ms,
                "state": "open",
                "revision": 1,
                "comments": [{
                    "commentId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "author": request.author,
                    "body": request.body,
                    "createdAtUnixMs": 42
                }],
                "createdAtUnixMs": 42,
                "updatedAtUnixMs": 42
            }))
        }

        fn resolve_review_thread(
            &self,
            workspace_id: Uuid,
            thread_id: Uuid,
            request: ResolveWorkspaceReviewThreadRequest,
        ) -> Result<Self::ReviewThread, MvpFailure> {
            Ok(json!({
                "threadId": thread_id,
                "workspaceId": workspace_id,
                "target": {
                    "kind": "planningDocument",
                    "documentId": "plan",
                    "documentSha256": format!("sha256:{}", "a".repeat(64))
                },
                "anchorState": "current",
                "currentDocumentSha256": format!("sha256:{}", "a".repeat(64)),
                "state": "resolved",
                "revision": request.expected_revision + 1,
                "comments": [],
                "createdAtUnixMs": 42,
                "updatedAtUnixMs": 43,
                "resolvedAtUnixMs": 43
            }))
        }

        fn preview_jira_link(
            &self,
            workspace_id: Uuid,
            request: PreviewWorkspaceJiraLinkRequest,
        ) -> Result<Self::WorkItemLinkPreview, MvpFailure> {
            Ok(json!({
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "provider": "jira",
                "role": request.role,
                "snapshot": {
                    "issueKey": request.issue_key,
                    "summary": "Test issue",
                    "status": "Open",
                    "content": "Imported requirements",
                    "fetchedAtUnixMs": 42
                },
                "previewDigest": format!("sha256:{}", "a".repeat(64))
            }))
        }

        fn confirm_jira_link(
            &self,
            workspace_id: Uuid,
            request: ConfirmWorkspaceJiraLinkRequest,
        ) -> Result<Self::WorkItemLinkConfirmation, MvpFailure> {
            Ok(json!({
                "link": {
                    "linkId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                    "workspaceId": workspace_id,
                    "provider": "jira",
                    "role": request.role,
                    "snapshot": {
                        "issueKey": request.issue_key,
                        "summary": "Test issue",
                        "status": "Open",
                        "content": "Imported requirements",
                        "fetchedAtUnixMs": 42
                    },
                    "revision": 1,
                    "createdAtUnixMs": 42,
                    "updatedAtUnixMs": 42
                },
                "replayed": false
            }))
        }

        fn open_jira_preview(
            &self,
            workspace_id: Uuid,
            request: OpenWorkspaceJiraPreviewRequest,
        ) -> Result<Self::WorkItemOpen, MvpFailure> {
            Ok(json!({
                "workspaceId": workspace_id,
                "issueKey": request.issue_key,
                "accepted": true
            }))
        }

        fn list_work_item_links(
            &self,
            workspace_id: Uuid,
        ) -> Result<Self::WorkItemLinkList, MvpFailure> {
            Ok(json!({ "schemaVersion": 1, "workspaceId": workspace_id, "links": [] }))
        }

        fn unlink_work_item(
            &self,
            workspace_id: Uuid,
            link_id: Uuid,
            request: UnlinkWorkspaceWorkItemRequest,
        ) -> Result<Self::WorkItemUnlink, MvpFailure> {
            Ok(json!({
                "workspaceId": workspace_id,
                "linkId": link_id,
                "removedRevision": request.expected_revision
            }))
        }

        fn open_work_item(
            &self,
            workspace_id: Uuid,
            _link_id: Uuid,
            _request: OpenWorkspaceWorkItemRequest,
        ) -> Result<Self::WorkItemOpen, MvpFailure> {
            Ok(json!({
                "workspaceId": workspace_id,
                "issueKey": "PLATFORM-42",
                "accepted": true
            }))
        }

        fn propose_jira_issue(
            &self,
            workspace_id: Uuid,
        ) -> Result<Self::JiraCreateProposal, MvpFailure> {
            Ok(json!({
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "summary": "Test workspace",
                "description": "Plan content",
                "canExecute": false,
                "requiresExplicitApproval": true,
                "detail": "Jira creation is unavailable."
            }))
        }

        fn preflight(&self, workspace_id: Uuid) -> Result<Self::Preflight, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            if let Some(preflight) = self.setup_recovery_preflight.lock().unwrap().as_ref() {
                return Ok(serde_json::to_value(preflight).unwrap());
            }
            Ok(fake_preflight(workspace_id))
        }

        fn recover_setup(
            &self,
            workspace_id: Uuid,
            expected_effect_digest: &str,
        ) -> Result<Self::Preflight, MvpFailure> {
            self.setup_recovery_calls
                .lock()
                .unwrap()
                .push((workspace_id, expected_effect_digest.to_owned()));
            if !self.workspaces.lock().unwrap().contains_key(&workspace_id) {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            let saved = self.setup_recovery_preflight.lock().unwrap();
            if saved
                .as_ref()
                .and_then(|preflight| preflight.setup_recovery.as_ref())
                .is_none_or(|recovery| recovery.effect_digest != expected_effect_digest)
            {
                return Err(MvpFailure::StalePreflight);
            }
            Ok(fake_preflight(workspace_id))
        }

        fn preflight_repository_addition(
            &self,
            workspace_id: Uuid,
            request: AddWorkspaceRepositoryRequest,
        ) -> Result<Self::RepositoryAdditionPreflight, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "repositoryId": request.repository_id,
                "repositoryLabel": "checkout-web",
                "baseRef": request.base_ref,
                "resolvedBaseRef": "refs/heads/main",
                "baseCommitOid": "1111111111111111111111111111111111111111",
                "targetDisplayPath": "checkout-web",
                "branchName": "wts/test",
                "effectDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }))
        }

        fn add_repository(
            &self,
            workspace_id: Uuid,
            request: AddWorkspaceRepositoryRequest,
            _expected_effect_digest: &str,
        ) -> Result<Self::RepositoryAddition, MvpFailure> {
            Ok(json!({
                "workspaceId": workspace_id,
                "repositoryId": request.repository_id,
                "repositoryLabel": "checkout-web",
                "replayed": false,
                "graphRefreshed": false,
                "graphDetail": "Graph indexing is not configured.",
                "materialization": fake_materialization(workspace_id)
            }))
        }

        fn remove_repository(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
        ) -> Result<Self::RepositoryRemoval, MvpFailure> {
            Ok(json!({
                "workspaceId": workspace_id,
                "repositoryId": repository_id,
                "repositoryLabel": "checkout-web",
                "graphRefreshed": false,
                "graphDetail": "Re-index the graph.",
                "materialization": fake_materialization(workspace_id)
            }))
        }

        fn get_materialization(
            &self,
            workspace_id: Uuid,
        ) -> Result<Option<Self::ExistingMaterialization>, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            Ok(self
                .materializations
                .lock()
                .expect("materialization test lock")
                .get(&workspace_id)
                .cloned())
        }

        fn gitlab_comparison(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
            iid: u64,
            refresh: bool,
        ) -> Result<Self::GitlabComparison, MvpFailure> {
            self.source_calls.fetch_add(1, Ordering::SeqCst);
            if repository_id != "repo-1" || iid != 17 || !refresh {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(
                json!({"schemaVersion":1,"workspaceId":workspace_id,"repositoryId":repository_id,"repositoryLabel":"api","iid":iid,"localHeadCommitOid":"c".repeat(40),"status":"missingCommits","published":{"schemaVersion":1,"repositoryId":repository_id,"iid":iid,"baseCommitOid":"a".repeat(40),"startCommitOid":"a".repeat(40),"headCommitOid":"b".repeat(40),"commits":[],"discussions":[],"patch":"","patchTruncated":false,"fromCache":false,"fetchedAtUnixMs":1}}),
            )
        }
        fn repository_source(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
            file_path: &str,
        ) -> Result<Self::RepositorySource, MvpFailure> {
            self.source_calls.fetch_add(1, Ordering::SeqCst);
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(
                json!({"schemaVersion":1,"workspaceId":workspace_id,"repositoryId":repository_id,"filePath":file_path,"content":"local content","revision":format!("sha256:{}","a".repeat(64))}),
            )
        }
        fn save_repository_source(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
            request: wts_app::WorkspaceRepositorySourceSaveRequest,
        ) -> Result<Self::RepositorySource, MvpFailure> {
            self.source_calls.fetch_add(1, Ordering::SeqCst);
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            if request.expected_revision != format!("sha256:{}", "a".repeat(64)) {
                return Err(MvpFailure::RepositoryFileConflict);
            }
            Ok(
                json!({"schemaVersion":1,"workspaceId":workspace_id,"repositoryId":repository_id,"filePath":request.file_path,"content":request.content,"revision":format!("sha256:{}","b".repeat(64))}),
            )
        }

        fn repository_diff(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
        ) -> Result<Self::RepositoryDiff, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(json!({
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "repositoryId": repository_id,
                "repositoryLabel": "checkout-api",
                "baseCommitOid": "1111111111111111111111111111111111111111",
                "headCommitOid": "2222222222222222222222222222222222222222",
                "patch": "diff --git a/README.md b/README.md\n",
                "patchTruncated": false,
                "untrackedPaths": [],
                "untrackedPathsTruncated": false
            }))
        }

        fn repository_file_review(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
            file_path: &str,
            expected_patch_sha256: &str,
        ) -> Result<Self::RepositoryFileReview, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            if file_path != "README.md" {
                return Err(MvpFailure::InvalidRepositoryFilePath);
            }
            Ok(json!({
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "repositoryId": repository_id,
                "repositoryLabel": "checkout-api",
                "baseCommitOid": "1111111111111111111111111111111111111111",
                "headCommitOid": "2222222222222222222222222222222222222222",
                "filePath": file_path,
                "patchSha256": expected_patch_sha256,
                "contentSha256": format!("sha256:{}", "a".repeat(64)),
                "content": "complete file\n",
                "fullPatch": "diff --git a/README.md b/README.md\n"
            }))
        }

        fn repository_review_graph(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
        ) -> Result<Option<Self::RepositoryReviewGraph>, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(Some(json!({
                "graphSha256": "sha256:review",
                "nodes": [],
                "links": [],
                "truncated": false
            })))
        }

        fn sync_repository(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
        ) -> Result<Self::RepositorySync, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "repositoryId": repository_id,
                "repositoryLabel": "checkout-api",
                "previousBaseCommitOid": "1111111111111111111111111111111111111111",
                "baseCommitOid": "2222222222222222222222222222222222222222",
                "updated": true,
                "graphRefreshed": true,
                "graphDetail": "Workspace graph refreshed.",
                "materialization": fake_materialization(workspace_id)
            }))
        }

        fn preflight_repository_alignment(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
        ) -> Result<Self::RepositoryAlignmentPreflight, MvpFailure> {
            if repository_id != "repo-1" {
                return Err(MvpFailure::RepositoryNotFound);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "repositoryId": repository_id,
                "repositoryLabel": "checkout-api",
                "baseRef": "main",
                "remoteFullRef": "refs/remotes/upstream/main",
                "currentCommitOid": "1111111111111111111111111111111111111111",
                "targetCommitOid": "2222222222222222222222222222222222222222",
                "backupFullRef": "refs/wts/backups/1111111111111111111111111111111111111111",
                "effectDigest": format!("sha256:{}", "a".repeat(64))
            }))
        }

        fn align_repository(
            &self,
            workspace_id: Uuid,
            repository_id: &str,
            expected_effect_digest: &str,
        ) -> Result<Self::RepositoryAlignment, MvpFailure> {
            if repository_id != "repo-1" || !expected_effect_digest.starts_with("sha256:") {
                return Err(MvpFailure::RepositoryAlignmentStale);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "repositoryId": repository_id,
                "repositoryLabel": "checkout-api",
                "previousBaseCommitOid": "1111111111111111111111111111111111111111",
                "baseCommitOid": "2222222222222222222222222222222222222222",
                "backupFullRef": "refs/wts/backups/1111111111111111111111111111111111111111",
                "graphRefreshed": true,
                "graphDetail": "Workspace graph refreshed.",
                "materialization": fake_materialization(workspace_id)
            }))
        }

        fn materialize(
            &self,
            workspace_id: Uuid,
            expected_effect_digest: &str,
        ) -> Result<Self::Materialization, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            if expected_effect_digest != "sha256:test" {
                return Err(MvpFailure::StalePreflight);
            }
            let mut materializations = self
                .materializations
                .lock()
                .expect("materialization test lock");
            let replayed = materializations.contains_key(&workspace_id);
            let materialization = materializations
                .entry(workspace_id)
                .or_insert_with(|| fake_materialization(workspace_id))
                .clone();
            Ok(json!({
                "replayed": replayed,
                "materialization": materialization
            }))
        }

        fn open_vscode(&self, workspace_id: Uuid) -> Result<Self::OpenWorkspace, MvpFailure> {
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            Ok(json!({
                "provider": "vsCode",
                "accepted": true,
                "workspaceId": workspace_id,
                "codeWorkspaceDisplayPath": format!("/Users/test/cd/{workspace_id}/wts.code-workspace")
            }))
        }

        fn open_cli(
            &self,
            workspace_id: Uuid,
            provider: AgentProvider,
            terminal: TerminalProvider,
        ) -> Result<Self::CliLaunch, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "sessionId": Uuid::from_u128(84),
                "provider": provider,
                "terminal": terminal,
                "accepted": true,
                "workspaceDisplayPath": format!("/Users/test/cd/{workspace_id}")
            }))
        }

        fn write_agent_brief(
            &self,
            workspace_id: Uuid,
            task_markdown: &str,
        ) -> Result<Self::AgentBrief, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            if task_markdown.trim().is_empty() {
                return Err(MvpFailure::InvalidAgentPrompt);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "workspaceDisplayPath": format!("/Users/test/cd/{workspace_id}"),
                "briefDisplayPath": format!("/Users/test/cd/{workspace_id}/WTS.md")
            }))
        }

        fn index_graph(&self, workspace_id: Uuid) -> Result<Self::GraphIndex, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "status": "ready",
                "graphDisplayPath": format!("/Users/test/cd/{workspace_id}/graphify-out/graph.json"),
                "detail": "Structural graph ready.",
                "durationMs": 12
            }))
        }

        fn reindex_graph(&self, workspace_id: Uuid) -> Result<Self::GraphIndex, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "status": "ready",
                "graphDisplayPath": format!("/Users/test/cd/{workspace_id}/graphify-out/graph.json"),
                "detail": "Structural graph refreshed.",
                "durationMs": 18
            }))
        }

        fn preflight_removal(
            &self,
            workspace_id: Uuid,
        ) -> Result<Self::RemovalPreflight, MvpFailure> {
            if let Some(preflight) = self.removal_preflight.lock().unwrap().as_ref() {
                if preflight.workspace_id != workspace_id {
                    return Err(MvpFailure::WorkspaceNotFound);
                }
                return serde_json::to_value(preflight)
                    .map_err(|_| MvpFailure::WorkspaceRemovalFailed);
            }
            if !self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            let materialized = self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id);
            Ok(fake_removal_preflight(workspace_id, materialized))
        }

        fn remove(
            &self,
            workspace_id: Uuid,
            expected_effect_digest: &str,
            idempotency_key: &str,
            _delete_protected_paths: bool,
        ) -> Result<Self::Removal, MvpFailure> {
            if self
                .removal_preflight
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|preflight| preflight.workspace_id == workspace_id && !preflight.ready)
            {
                return Err(MvpFailure::WorkspaceRemovalBlocked);
            }
            let mut idempotency = self
                .removal_idempotency
                .lock()
                .expect("removal idempotency test lock");
            if let Some((existing_workspace_id, existing_digest, result)) =
                idempotency.get(idempotency_key)
            {
                if existing_workspace_id != &workspace_id
                    || existing_digest != expected_effect_digest
                {
                    return Err(MvpFailure::IdempotencyConflict);
                }
                let mut replay = result.clone();
                replay["replayed"] = Value::Bool(true);
                return Ok(replay);
            }
            if expected_effect_digest != "sha256:remove-test" {
                return Err(MvpFailure::StalePreflight);
            }
            if self
                .workspaces
                .lock()
                .expect("workspace test lock")
                .remove(&workspace_id)
                .is_none()
            {
                return Err(MvpFailure::WorkspaceNotFound);
            }
            let materialized = self
                .materializations
                .lock()
                .expect("materialization test lock")
                .remove(&workspace_id)
                .is_some();
            let result = json!({
                "workspaceId": workspace_id,
                "replayed": false,
                "removedWorktreeCount": if materialized { 1 } else { 0 },
                "retainedBranches": if materialized {
                    vec!["wts/platform-42-test"]
                } else {
                    Vec::<&str>::new()
                },
                "removedGeneratedPaths": if materialized {
                    vec![
                        format!("/Users/test/cd/{workspace_id}/wts.code-workspace"),
                        format!("/Users/test/cd/{workspace_id}/.wts"),
                        format!("/Users/test/cd/{workspace_id}/graphify-out"),
                    ]
                } else {
                    Vec::<String>::new()
                }
            });
            idempotency.insert(
                idempotency_key.to_owned(),
                (
                    workspace_id,
                    expected_effect_digest.to_owned(),
                    result.clone(),
                ),
            );
            Ok(result)
        }

        fn run_agent(
            &self,
            workspace_id: Uuid,
            provider: AgentProvider,
            prompt: &str,
        ) -> Result<Self::AgentRun, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "provider": provider,
                "succeeded": true,
                "output": format!("Completed: {prompt}"),
                "durationMs": 24
            }))
        }

        fn list_agent_conversations(&self) -> Result<wts_app::AgentConversationList, MvpFailure> {
            Ok(wts_app::AgentConversationList {
                schema_version: 1,
                conversations: Vec::new(),
            })
        }

        fn list_agent_sessions(
            &self,
            workspace_id: Option<Uuid>,
        ) -> Result<AgentSessionList, MvpFailure> {
            let workspace_id = workspace_id.unwrap_or_else(|| Uuid::from_u128(42));
            serde_json::from_value(json!({
                "schemaVersion": 1,
                "sessions": [{
                    "schemaVersion": 1,
                    "sessionId": Uuid::from_u128(84),
                    "workspaceId": workspace_id,
                    "provider": "codex",
                    "terminal": "warp",
                    "category": "uncategorized",
                    "status": "handoffAccepted",
                    "startedAtUnixMs": 1_000,
                    "lastHeartbeatAtUnixMs": 1_000,
                    "endedAtUnixMs": 1_000,
                    "failure": null
                }],
                "observedSessions": [{
                    "schemaVersion": 1,
                    "sessionId": Uuid::from_u128(126),
                    "workspaceId": workspace_id,
                    "provider": "codex",
                    "source": "codexVscodeRollout",
                    "status": "working",
                    "activity": "runningCommand",
                    "needsInput": {
                        "kind": "access",
                        "detail": "Agent needs access."
                    },
                    "latestUpdate": "Implemented the workspace card hierarchy and started verification.",
                    "updateKind": "progress",
                    "startedAtUnixMs": 2_000,
                    "lastEventAtUnixMs": 3_000
                }]
            }))
            .map_err(|_| MvpFailure::Unavailable)
        }

        fn get_agent_session_detail(
            &self,
            session_id: Uuid,
        ) -> Result<AgentSessionDetail, MvpFailure> {
            serde_json::from_value(json!({
                "schemaVersion": 1,
                "sessionId": session_id,
                "workspaceId": Uuid::from_u128(42),
                "provider": "codex",
                "task": "Implement the approved task.",
                "modelSelection": {
                    "authority": "providerDefault"
                },
                "events": [{
                    "sequence": 1,
                    "observedAtUnixMs": 4_000,
                    "kind": "started",
                    "summary": "Codex starts the task."
                }, {
                    "sequence": 2,
                    "observedAtUnixMs": 4_100,
                    "kind": "agentUpdate",
                    "summary": "I found the failing boundary."
                }],
                "eventsTruncated": false
            }))
            .map_err(|_| MvpFailure::Unavailable)
        }

        fn start_agent_session(
            &self,
            workspace_id: Uuid,
            provider: AgentProvider,
            terminal: TerminalProvider,
            category: AgentSessionCategory,
        ) -> Result<AgentSession, MvpFailure> {
            Ok(AgentSession {
                schema_version: 1,
                session_id: Uuid::from_u128(85),
                workspace_id,
                provider,
                terminal,
                category,
                status: wts_app::AgentSessionStatus::Running,
                started_at_unix_ms: 2_000,
                last_heartbeat_at_unix_ms: 2_000,
                ended_at_unix_ms: None,
                failure: None,
                needs_input: None,
                change_request_proposals: Vec::new(),
                mr_link_proposals: Vec::new(),
            })
        }

        fn heartbeat_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
            Ok(fake_running_agent_session(session_id))
        }

        fn finish_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
            let mut session = fake_running_agent_session(session_id);
            session.status = wts_app::AgentSessionStatus::Completed;
            session.ended_at_unix_ms = Some(3_000);
            Ok(session)
        }

        fn fail_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
            let mut session = fake_running_agent_session(session_id);
            session.status = wts_app::AgentSessionStatus::Failed;
            session.ended_at_unix_ms = Some(3_000);
            session.failure = Some(AgentSessionFailure::ProviderFailed);
            Ok(session)
        }

        fn launch_agent_session(
            &self,
            workspace_id: Uuid,
            provider: AgentProvider,
            _prompt: &str,
            category: AgentSessionCategory,
        ) -> Result<AgentSession, MvpFailure> {
            Ok(AgentSession {
                schema_version: 1,
                session_id: Uuid::from_u128(86),
                workspace_id,
                provider,
                terminal: TerminalProvider::Terminal,
                category,
                status: wts_app::AgentSessionStatus::Running,
                started_at_unix_ms: 4_000,
                last_heartbeat_at_unix_ms: 4_000,
                ended_at_unix_ms: None,
                failure: None,
                needs_input: None,
                change_request_proposals: Vec::new(),
                mr_link_proposals: Vec::new(),
            })
        }

        fn stop_agent_session(&self, session_id: Uuid) -> Result<AgentSession, MvpFailure> {
            let mut session = fake_running_agent_session(session_id);
            session.status = wts_app::AgentSessionStatus::Stopping;
            Ok(session)
        }

        fn get_verification_summary(&self, workspace_id: Uuid) -> Result<Option<WorkspaceVerificationSummary>, MvpFailure> {
            if !self.materializations.lock().unwrap().contains_key(&workspace_id) { return Ok(None); }
            let evidence = fake_evidence(workspace_id, "failed");
            Ok(Some(serde_json::from_value(json!({
                "schemaVersion":1, "workspaceId":workspace_id,
                "verificationPlan":evidence["verificationPlan"],
                "verificationResult":evidence["verificationResult"],
                "verificationHistory":[],
            })).unwrap()))
        }

        fn get_evidence(&self, workspace_id: Uuid) -> Result<Option<Self::Evidence>, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Ok(None);
            }
            Ok(Some(fake_evidence(workspace_id, "notRun")))
        }

        fn promote_agent_check(
            &self,
            workspace_id: Uuid,
            proposal_id: &str,
        ) -> Result<Self::Evidence, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            Ok(json!({
                "workspaceId": workspace_id,
                "proposalId": proposal_id,
                "promoted": true
            }))
        }

        fn run_verification(&self, workspace_id: Uuid) -> Result<Self::Evidence, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            if let Some(probe) = &self.verification_probe {
                probe.enter();
            }
            Ok(fake_evidence(workspace_id, "passed"))
        }

        fn run_verification_check(
            &self,
            workspace_id: Uuid,
            check_id: &str,
        ) -> Result<Self::Evidence, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            let mut evidence = fake_evidence(workspace_id, "passed");
            evidence["selectedCheckId"] = json!(check_id);
            Ok(evidence)
        }

        fn rerun_failed_verification(
            &self,
            workspace_id: Uuid,
        ) -> Result<Self::Evidence, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            let mut evidence = fake_evidence(workspace_id, "passed");
            evidence["selection"] = json!("failed");
            Ok(evidence)
        }

        fn cancel_verification(&self, workspace_id: Uuid) -> Result<Self::Evidence, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            Ok(fake_evidence(workspace_id, "cancelled"))
        }

        fn list_test_runs(&self, workspace_id: Uuid) -> Result<Self::TestRunList, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            Ok(json!({
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "runs": []
            }))
        }

        fn get_test_run(
            &self,
            workspace_id: Uuid,
            run_id: Uuid,
        ) -> Result<Self::TestRunDetail, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            let expected_run_id =
                Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").expect("test run UUID");
            if run_id != expected_run_id {
                return Err(MvpFailure::TestRunNotFound);
            }
            Ok(json!({
                "schemaVersion": 1,
                "runId": run_id,
                "workspaceId": workspace_id,
                "journeyId": "wts-help-preferences",
                "state": "passed",
                "startedAtUnixMs": 1,
                "completedAtUnixMs": 9,
                "durationMs": 8,
                "steps": [],
                "consoleErrors": [],
                "requests": [],
                "artifacts": []
            }))
        }

        fn run_test_journey(
            &self,
            workspace_id: Uuid,
            journey_id: &str,
            base_url: &str,
        ) -> Result<Self::TestRun, MvpFailure> {
            if !self
                .materializations
                .lock()
                .expect("materialization test lock")
                .contains_key(&workspace_id)
            {
                return Err(MvpFailure::WorkspaceNotMaterialized);
            }
            if journey_id != "wts-help-preferences" || !base_url.starts_with("http://127.0.0.1:") {
                return Err(MvpFailure::InvalidTestJourney);
            }
            Ok(json!({
                "schemaVersion": 1,
                "runId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "workspaceId": workspace_id,
                "journeyId": journey_id,
                "title": "WTS help and preferences",
                "state": "passed",
                "startedAtUnixMs": 1,
                "completedAtUnixMs": 9,
                "durationMs": 8,
                "passedSteps": 4,
                "failedSteps": 0,
                "totalSteps": 4,
                "artifactsDisplayPath": format!("/Users/test/cd/{workspace_id}/.wts/test-runs/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
            }))
        }

        fn verify_jira(&self) -> Result<Self::JiraVerification, MvpFailure> {
            Ok(json!({
                "connected": true,
                "serverName": "mcp-atlassian",
                "serverVersion": "test",
                "issueTool": "jira_get_issue"
            }))
        }

        fn active_jira_issues(&self) -> Result<Self::JiraActiveIssues, MvpFailure> {
            Ok(json!({
                "schemaVersion": 1,
                "issues": [{
                    "issueKey": "PLATFORM-42",
                    "summary": "Retry duplicate captures",
                    "status": "In Progress"
                }],
                "detail": "Assigned active Jira issues."
            }))
        }

        fn activity_watch_time_review_brief(
            &self,
            started_at_unix_ms: i64,
            ended_at_unix_ms: i64,
            endpoint: Option<&str>,
        ) -> Result<Self::TimeReviewBrief, MvpFailure> {
            assert_eq!(started_at_unix_ms, 1_775_000_000_000);
            assert_eq!(ended_at_unix_ms, 1_775_000_600_000);
            assert_eq!(endpoint, Some("http://127.0.0.1:5600"));
            Ok(json!({
                "schemaVersion": 1,
                "reviewId": "activitywatch-2026-04-01-1775000000000",
                "reviewDate": "2026-04-01",
                "generatedAtUnixMs": 1_775_000_700_000_i64,
                "ledger": [{
                    "id": "row-1",
                    "startedAtUnixMs": started_at_unix_ms,
                    "endedAtUnixMs": ended_at_unix_ms,
                    "durationSeconds": 600,
                    "activityType": "coding",
                    "application": "Visual Studio Code",
                    "context": "PLATFORM-42 · auth.py",
                    "detectedJiraIssueKey": "PLATFORM-42",
                    "sourceEventCount": 8
                }],
                "jiraCandidates": [{
                    "issueKey": "PLATFORM-42",
                    "summary": "Retry duplicate captures",
                    "status": "In Progress"
                }]
            }))
        }

        fn import_jira(&self, issue_key: &str) -> Result<Self::JiraIssue, MvpFailure> {
            Ok(json!({
                "issueKey": issue_key,
                "summary": "Test issue",
                "status": "Open",
                "content": "checkout-api",
                "suggestedRepositories": ["checkout-api"],
                "repositoryRecommendations": [{
                    "repositoryId": "repo_checkout",
                    "label": "checkout-api",
                    "confidence": 100,
                    "reason": "The imported issue references this repository's repository label.",
                    "sources": ["label"]
                }]
            }))
        }

        fn verify_open_project(&self) -> Result<Self::OpenProjectVerification, MvpFailure> {
            Ok(json!({
                "connected": true,
                "instanceName": "OpenProject",
                "apiVersion": "v3",
                "authenticatedUser": "Ada Lovelace"
            }))
        }

        fn import_open_project_work_package(
            &self,
            reference: &str,
        ) -> Result<Self::OpenProjectWorkPackage, MvpFailure> {
            Ok(json!({
                "workPackageId": 42,
                "displayId": reference,
                "subject": "Test work package",
                "status": "New",
                "project": "WTS",
                "content": "checkout-api",
                "suggestedRepositories": ["checkout-api"],
                "repositoryRecommendations": [{
                    "repositoryId": "repo_checkout",
                    "label": "checkout-api",
                    "confidence": 100,
                    "reason": "The imported issue references this repository's repository label.",
                    "sources": ["label"]
                }]
            }))
        }
    }

    fn fake_preflight(workspace_id: Uuid) -> Value {
        json!({
            "workspaceId": workspace_id,
            "workspaceDisplayPath": format!("/Users/test/cd/{workspace_id}"),
            "codeWorkspaceDisplayPath": format!("/Users/test/cd/{workspace_id}/wts.code-workspace"),
            "branchName": "wts/platform-42-test",
            "ready": true,
            "effectDigest": "sha256:test",
            "repositories": [],
            "blockers": [],
            "warnings": [],
            "graph": {
                "status": "notStarted",
                "detail": "Not started."
            }
        })
    }

    fn fake_removal_preflight(workspace_id: Uuid, materialized: bool) -> Value {
        json!({
            "workspaceId": workspace_id,
            "kind": if materialized { "materializedWorkspace" } else { "savedPlan" },
            "workspaceDisplayPath": format!("/Users/test/cd/{workspace_id}"),
            "ready": true,
            "effectDigest": "sha256:remove-test",
            "worktrees": if materialized {
                vec![json!({
                    "repositoryId": "repo-1",
                    "label": "checkout-api",
                    "targetDisplayPath": format!("/Users/test/cd/{workspace_id}/checkout-api"),
                    "branchName": "wts/platform-42-test",
                    "headCommitOid": "2222222222222222222222222222222222222222",
                    "present": true
                })]
            } else {
                Vec::<Value>::new()
            },
            "generatedPaths": if materialized {
                vec![
                    format!("/Users/test/cd/{workspace_id}/wts.code-workspace"),
                    format!("/Users/test/cd/{workspace_id}/.wts"),
                    format!("/Users/test/cd/{workspace_id}/graphify-out"),
                ]
            } else {
                Vec::<String>::new()
            },
            "retainedBranches": if materialized {
                vec!["wts/platform-42-test"]
            } else {
                Vec::<&str>::new()
            },
            "blockers": [],
            "warnings": ["Branches and their commits are retained in source repositories."]
        })
    }

    fn fake_materialization(workspace_id: Uuid) -> Value {
        json!({
            "schemaVersion": 1,
            "workspaceId": workspace_id,
            "workspaceRecordVersion": 1,
            "effectDigest": "sha256:test",
            "workspaceDisplayPath": format!("/Users/test/cd/{workspace_id}"),
            "codeWorkspaceDisplayPath": format!("/Users/test/cd/{workspace_id}/wts.code-workspace"),
            "branchName": "wts/platform-42-test",
            "worktrees": [],
            "graph": {
                "status": "notStarted",
                "detail": "Not started."
            }
        })
    }

    fn fake_evidence(workspace_id: Uuid, status: &str) -> Value {
        json!({
            "context": {
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "workspaceRecordVersion": 1,
                "title": "Test workspace",
                "intent": {"type": "jira", "issueKey": "PLATFORM-42"},
                "preferredProvider": "codex",
                "branchName": "wts/platform-42-test",
                "workspaceDisplayPath": format!("/Users/test/cd/{workspace_id}"),
                "codeWorkspaceDisplayPath": format!("/Users/test/cd/{workspace_id}/wts.code-workspace"),
                "evidenceDisplayPath": format!("/Users/test/cd/{workspace_id}/.wts"),
                "createdAtUnixMs": 1,
                "wtsVersion": "test",
                "repositories": [],
                "allowedRepositoryIds": []
            },
            "graphManifest": {
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "status": "notStarted",
                "indexedRepositories": [],
                "detail": "Not started."
            },
            "verificationPlan": {
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "revision": 1,
                "updatedAtUnixMs": 1,
                "checks": []
            },
            "verificationResult": {
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "planRevision": 1,
                "status": status,
                "checks": [],
                "warnings": []
            },
            "agentReport": {
                "schemaVersion": 1,
                "workspaceId": workspace_id,
                "status": "notReported",
                "displayPath": format!("/Users/test/cd/{workspace_id}/.wts/agent-report.json"),
                "summary": "",
                "findings": [],
                "nextActions": [],
                "detail": "No agent report has been published."
            },
            "agentRuns": []
        })
    }

    fn policy() -> SecurityPolicy {
        SecurityPolicy::with_session_token(
            "127.0.0.1:43123".parse().expect("test socket"),
            TEST_TOKEN,
        )
        .expect("valid test policy")
    }

    fn app() -> Router {
        build_router(Arc::new(FakeRegistry::default()), policy(), None)
    }

    fn sample_request(title: &str) -> CreateWorkspaceRequest {
        CreateWorkspaceRequest {
            intent: WorkspaceIntent::Jira {
                issue_key: "PLATFORM-42".into(),
            },
            title: title.into(),
            preferred_provider: WorkspaceProvider::Codex,
            repositories: vec![WorkspaceRepositoryRequest {
                repository_id: None,
                label: "checkout-api".into(),
                base_ref: "main".into(),
            }],
            runtime: None,
            planning: None,
        }
    }

    fn protected_request(method: Method, uri: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(uri)
            .header(HOST, policy().authority())
            .header(SESSION_HEADER, TEST_TOKEN)
            .header(REQUEST_HEADER, REQUEST_MARKER)
    }

    fn create_request(request: &CreateWorkspaceRequest, idempotency_key: &str) -> Request<Body> {
        protected_request(Method::POST, "/api/v1/workspaces")
            .header(ORIGIN, policy().origin())
            .header(IDEMPOTENCY_HEADER, idempotency_key)
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(request).expect("serialize request"),
            ))
            .expect("build request")
    }

    fn empty_action_request(uri: &str) -> Request<Body> {
        protected_request(Method::POST, uri)
            .header(ORIGIN, policy().origin())
            .body(Body::empty())
            .expect("build request")
    }

    async fn response_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), 256 * 1024)
            .await
            .expect("read response body");
        serde_json::from_slice(&bytes).expect("JSON response")
    }

    #[tokio::test]
    async fn conversation_routes_protect_requests_and_reject_unknown_scope_fields() {
        let read = app()
            .oneshot(
                protected_request(Method::GET, "/api/v1/agent-conversations")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        assert_eq!(
            response_json(read).await,
            json!({"schemaVersion":1,"conversations":[]})
        );
        let request = json!({"requestId":Uuid::new_v4(),"provider":"codex","source":{"kind":"ui","route":"/","calloutId":"spaces.toolbar","label":"Spaces toolbar"},"workspacePath":"/untrusted"});
        let unknown = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/agent-conversations")
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let no_origin = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/agent-conversations")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_origin.status(), StatusCode::FORBIDDEN);
        let no_auth = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/agent-conversations")
                    .header(HOST, policy().authority())
                    .header(REQUEST_HEADER, REQUEST_MARKER)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);
        let wrong_message = app().oneshot(protected_request(Method::POST, &format!("/api/v1/agent-conversations/{}/messages",Uuid::new_v4())).header(ORIGIN,policy().origin()).header(CONTENT_TYPE,"application/json").body(Body::from(json!({"requestId":Uuid::new_v4(),"body":"Fix the spacing.","workspaceId":Uuid::new_v4()}).to_string())).unwrap()).await.unwrap();
        assert_eq!(wrong_message.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }

    #[tokio::test]
    async fn turn_change_route_requires_a_session_and_valid_request_identity() {
        let path = format!(
            "/api/v1/agent-conversations/{}/messages/{}/changes",
            Uuid::new_v4(),
            Uuid::new_v4()
        );
        let response = app()
            .oneshot(
                Request::builder()
                    .uri(&path)
                    .header(HOST, policy().authority())
                    .header(REQUEST_HEADER, REQUEST_MARKER)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let response = app()
            .oneshot(
                protected_request(Method::GET, &path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let invalid = format!(
            "/api/v1/agent-conversations/{}/messages/not-a-request/changes",
            Uuid::new_v4()
        );
        let response = app()
            .oneshot(
                protected_request(Method::GET, &invalid)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn turn_recovery_routes_require_a_session_and_reject_renderer_commands() {
        let base = format!(
            "/api/v1/agent-conversations/{}/messages/{}",
            Uuid::new_v4(),
            Uuid::new_v4()
        );
        for suffix in ["checks", "restore-preflight", "decisions"] {
            let response = app()
                .oneshot(
                    Request::builder()
                        .uri(format!("{base}/{suffix}"))
                        .header(HOST, policy().authority())
                        .header(REQUEST_HEADER, REQUEST_MARKER)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        for (suffix, body) in [
            (
                "decisions",
                json!({"requestId":Uuid::new_v4(),"expectedRevision":0,"expectedReceiptDigest":format!("sha256:{}","a".repeat(64)),"kind":"kept","reason":"Compare this result."}),
            ),
            (
                "checks",
                json!({"requestId":Uuid::new_v4(),"checkId":"unit", "expectedAfterCheckpointId":Uuid::new_v4(), "expectedPlanRevision":1}),
            ),
            (
                "restore",
                json!({"requestId":Uuid::new_v4(),"effectDigest":format!("sha256:{}","a".repeat(64))}),
            ),
        ] {
            let path = format!("{base}/{suffix}");
            let response = app()
                .oneshot(
                    protected_request(Method::POST, &path)
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            for field in ["executable", "workingDirectory", "targetPath"] {
                let mut injected = body.clone();
                injected[field] = json!("/outside-workspace");
                let response = app()
                    .oneshot(
                        protected_request(Method::POST, &path)
                            .header(ORIGIN, policy().origin())
                            .header(CONTENT_TYPE, "application/json")
                            .body(Body::from(injected.to_string()))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
            }
        }
    }

    #[tokio::test]
    async fn turn_change_route_serializes_the_requested_receipt_without_current_workspace_state() {
        let conversation_id = Uuid::new_v4();
        let request_id = Uuid::new_v4();
        let wire = json!({
            "schemaVersion": 1, "conversationId": conversation_id, "requestId": request_id,
            "sessionId": Uuid::new_v4(), "workspaceId": Uuid::new_v4(), "repositoryId": "repo-wts",
            "sourceContextSha256": format!("sha256:{}", "a".repeat(64)),
            "state": "incomplete", "observation": "recovered", "startedAtUnixMs": 10,
            "completedAtUnixMs": 20, "files": [{"filePath": "draft.txt", "status": "modified",
                "preExistingChange": true, "undoSupported": false}],
            "omittedFileCount": 1, "patch": "-saved before\n+saved result\n",
            "patchTruncated": false, "detail": "One file was omitted from this capture."
        });
        let registry = FakeRegistry::default();
        *registry.turn_changes.lock().unwrap() =
            Some(serde_json::from_value(wire.clone()).unwrap());
        let router = build_router(Arc::new(registry), policy(), None);
        let path =
            format!("/api/v1/agent-conversations/{conversation_id}/messages/{request_id}/changes");
        let response = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 32 * 1024)
            .await
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), wire);
        let wrong_path = format!(
            "/api/v1/agent-conversations/{conversation_id}/messages/{}/changes",
            Uuid::new_v4()
        );
        let response = router
            .oneshot(
                protected_request(Method::GET, &wrong_path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn turn_recovery_routes_preserve_turn_and_mutation_identity_across_transport() {
        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let after_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let restore_id = Uuid::new_v4();
        let scope = json!({"schemaVersion":1,"conversationId":conversation_id,"requestId":turn_id,
            "sessionId":Uuid::new_v4(),"workspaceId":Uuid::new_v4(),"repositoryId":"repo-wts","afterCheckpointId":after_id});
        let mut checks = scope.clone();
        checks.as_object_mut().unwrap().extend(json!({"state":"ready","detail":"The selected check passed.",
            "checks":[{"checkId":"unit","label":"Unit tests","kind":"unit","planRevision":2}],
            "runs":[{"runId":run_id,"checkId":"unit","status":"passed","startedAtUnixMs":10,"completedAtUnixMs":20,
                "durationMs":10,"exitCode":0,"output":"literal $result\npassed\n","outputTruncated":false,"detail":"The check passed."}]
        }).as_object().unwrap().clone());
        let digest = format!("sha256:{}", "b".repeat(64));
        let files = json!([{"filePath":"new.txt","action":"remove"},{"filePath":"dirty.txt","action":"restore"}]);
        let mut preflight = scope;
        preflight.as_object_mut().unwrap().extend(
            json!({"state":"ready","effectDigest":digest,"files":files,
            "blockers":[],"detail":"Review these two file effects before restoration."})
            .as_object()
            .unwrap()
            .clone(),
        );
        let restored = json!({"schemaVersion":1,"conversationId":conversation_id,"requestId":turn_id,"restoreRequestId":restore_id,
            "state":"restored","restoredAtUnixMs":30,"files":files,"blockers":[],"detail":"The two files were restored."});
        let registry = Arc::new(FakeRegistry::default());
        *registry.turn_checks.lock().unwrap() =
            Some(serde_json::from_value(checks.clone()).unwrap());
        *registry.turn_restore_preflight.lock().unwrap() =
            Some(serde_json::from_value(preflight.clone()).unwrap());
        *registry.turn_restore_result.lock().unwrap() =
            Some(serde_json::from_value(restored.clone()).unwrap());
        let router = build_router(registry.clone(), policy(), None);
        let base = format!("/api/v1/agent-conversations/{conversation_id}/messages/{turn_id}");
        for (suffix, expected) in [("checks", &checks), ("restore-preflight", &preflight)] {
            let response = router
                .clone()
                .oneshot(
                    protected_request(Method::GET, &format!("{base}/{suffix}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), 32 * 1024)
                .await
                .unwrap();
            assert_eq!(&serde_json::from_slice::<Value>(&body).unwrap(), expected);
        }
        assert!(registry.turn_recovery_calls.lock().unwrap().is_empty());
        let check_request = json!({"requestId":run_id,"checkId":"unit","expectedAfterCheckpointId":after_id,"expectedPlanRevision":2});
        let restore_request = json!({"requestId":restore_id,"effectDigest":digest});
        for (suffix, request, expected) in [
            ("checks", &check_request, &checks),
            ("restore", &restore_request, &restored),
        ] {
            let response = router
                .clone()
                .oneshot(
                    protected_request(Method::POST, &format!("{base}/{suffix}"))
                        .header(ORIGIN, policy().origin())
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(request.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body = axum::body::to_bytes(response.into_body(), 32 * 1024)
                .await
                .unwrap();
            assert_eq!(&serde_json::from_slice::<Value>(&body).unwrap(), expected);
        }
        assert_eq!(
            *registry.turn_recovery_calls.lock().unwrap(),
            vec![
                json!({"operation":"check","conversationId":conversation_id,"turnRequestId":turn_id,"request":check_request}),
                json!({"operation":"restore","conversationId":conversation_id,"turnRequestId":turn_id,"request":restore_request}),
            ]
        );
    }

    #[tokio::test]
    async fn turn_decision_route_preserves_the_result_and_user_mutation_identity() {
        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let decision_id = Uuid::new_v4();
        let after_id = Uuid::new_v4();
        let digest = format!("sha256:{}", "a".repeat(64));
        let context_digest = format!("sha256:{}", "b".repeat(64));
        let wire = json!({"schemaVersion":1,"conversationId":conversation_id,"requestId":turn_id,
            "sessionId":Uuid::new_v4(),"workspaceId":Uuid::new_v4(),"repositoryId":"repo-wts",
            "afterCheckpointId":after_id,"receiptDigest":digest,"sourceContextSha256":context_digest,
            "revision":1,"state":"ready","checksState":"stale","detail":"This choice describes the saved result.",
            "decisions":[{"decisionId":decision_id,"revision":1,"kind":"kept","reason":"Keep the literal $value.\nCompare later.",
                "createdAtUnixMs":123,"afterCheckpointId":after_id,"receiptDigest":digest,
                "sourceContextSha256":context_digest,"checksState":"noChecks","checks":[]}]});
        let registry = Arc::new(FakeRegistry::default());
        *registry.turn_decisions.lock().unwrap() =
            Some(serde_json::from_value(wire.clone()).unwrap());
        let router = build_router(registry.clone(), policy(), None);
        let path =
            format!("/api/v1/agent-conversations/{conversation_id}/messages/{turn_id}/decisions");
        let response = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 32768)
            .await
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), wire);
        assert!(registry.turn_recovery_calls.lock().unwrap().is_empty());
        let request = json!({"requestId":decision_id,"expectedRevision":0,"expectedReceiptDigest":digest,
            "kind":"kept","reason":"Keep the literal $value.\nCompare later."});
        let response = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &path)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 32768)
            .await
            .unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), wire);
        assert_eq!(
            *registry.turn_recovery_calls.lock().unwrap(),
            vec![json!({"operation":"decision",
            "conversationId":conversation_id,"turnRequestId":turn_id,"request":request})]
        );
        let wrong_path = format!(
            "/api/v1/agent-conversations/{conversation_id}/messages/{}/decisions",
            Uuid::new_v4()
        );
        let response = router
            .oneshot(
                protected_request(Method::GET, &wrong_path)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    fn work_set_route_fixture() -> (Arc<FakeRegistry>, Value, Value, Value) {
        let set_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        let checkpoint_id = Uuid::new_v4();
        let child_workspace = Uuid::new_v4();
        let child_conversation = Uuid::new_v4();
        let child_request = Uuid::new_v4();
        let child_checkpoint = Uuid::new_v4();
        let digest = format!("sha256:{}", "a".repeat(64));
        let set = json!({"schemaVersion":1,"workSetId":set_id,"conversationId":conversation_id,"requestId":turn_id,"workspaceId":workspace_id,"repositoryId":"repo-wts","sourceCheckpointId":checkpoint_id,"sourceContextSha256":digest,"kind":"alternatives","revision":3,"createdAtUnixMs":100,"updatedAtUnixMs":200,"tasks":[{"taskId":task_id,"title":"Option A","prompt":"Preserve literal $value and `text`.\nUse the current files.","dependsOn":[],"state":"completed","conversationId":child_conversation,"requestId":child_request,"workspaceId":child_workspace,"repositoryId":"repo-wts","workspaceDisplayPath":"/workspaces/isolated","afterCheckpointId":child_checkpoint,"detail":"The task finished."}],"detail":"Review the isolated result."});
        let preflight = json!({"schemaVersion":1,"workSetId":set_id,"taskId":task_id,"workspaceId":workspace_id,"repositoryId":"repo-wts","sourceConversationId":conversation_id,"sourceRequestId":turn_id,"sourceAfterCheckpointId":checkpoint_id,"candidateWorkspaceId":child_workspace,"candidateConversationId":child_conversation,"candidateRequestId":child_request,"candidateAfterCheckpointId":child_checkpoint,"state":"ready","effectDigest":digest,"files":[{"filePath":"src/view.tsx","status":"modified"}],"checkRunIds":[Uuid::new_v4()],"blockers":[],"detail":"Review these file effects."});
        let result = json!({"schemaVersion":1,"workSetId":set_id,"taskId":task_id,"workspaceId":workspace_id,"repositoryId":"repo-wts","integrationRequestId":Uuid::new_v4(),"state":"integrated","files":[{"filePath":"src/view.tsx","status":"modified"}],"blockers":[],"detail":"The file effects were applied.","integratedAtUnixMs":300});
        let registry = Arc::new(FakeRegistry::default());
        *registry.work_set.lock().unwrap() = Some(serde_json::from_value(set.clone()).unwrap());
        *registry.work_item_integration_preflight.lock().unwrap() =
            Some(serde_json::from_value(preflight.clone()).unwrap());
        *registry.work_item_integration_result.lock().unwrap() =
            Some(serde_json::from_value(result.clone()).unwrap());
        (registry, set, preflight, result)
    }

    #[tokio::test]
    async fn work_set_routes_preserve_exact_scope_payloads_and_read_without_mutation() {
        let (registry, set, preflight, result) = work_set_route_fixture();
        let router = build_router(registry.clone(), policy(), None);
        let conversation = set["conversationId"].as_str().unwrap();
        let turn = set["requestId"].as_str().unwrap();
        let id = set["workSetId"].as_str().unwrap();
        let task = set["tasks"][0]["taskId"].as_str().unwrap();
        let base = format!("/api/v1/agent-conversations/{conversation}/messages/{turn}/work-sets");
        let item = format!("/api/v1/agent-work-sets/{id}/items/{task}");
        for (path, expected) in [
            (
                base.clone(),
                json!({"schemaVersion":1,"conversationId":conversation,"requestId":turn,"workSets":[set.clone()]}),
            ),
            (format!("/api/v1/agent-work-sets/{id}"), set.clone()),
            (format!("{item}/integration-preflight"), preflight.clone()),
        ] {
            let response = router
                .clone()
                .oneshot(
                    protected_request(Method::GET, &path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{path}");
            let bytes = axum::body::to_bytes(response.into_body(), 32768)
                .await
                .unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
        }
        assert!(registry.turn_recovery_calls.lock().unwrap().is_empty());
        let create = json!({"requestId":id,"expectedAfterCheckpointId":set["sourceCheckpointId"],"kind":"alternatives","tasks":[{"taskId":task,"title":"Option A","prompt":set["tasks"][0]["prompt"],"dependsOn":[]}]});
        let cancel = json!({"requestId":Uuid::new_v4(),"expectedRevision":3});
        let integrate = json!({"requestId":result["integrationRequestId"],"effectDigest":preflight["effectDigest"]});
        for (path, request, expected) in [
            (base.clone(), create.clone(), set.clone()),
            (format!("{item}/cancel"), cancel.clone(), set.clone()),
            (
                format!("{item}/integration"),
                integrate.clone(),
                result.clone(),
            ),
        ] {
            let response = router
                .clone()
                .oneshot(
                    protected_request(Method::POST, &path)
                        .header(ORIGIN, policy().origin())
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(request.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = axum::body::to_bytes(response.into_body(), 32768)
                .await
                .unwrap();
            assert_eq!(serde_json::from_slice::<Value>(&bytes).unwrap(), expected);
        }
        assert_eq!(
            *registry.turn_recovery_calls.lock().unwrap(),
            vec![
                json!({"operation":"createWorkSet","conversationId":conversation,"turnRequestId":turn,"request":create}),
                json!({"operation":"cancelWorkItem","workSetId":id,"taskId":task,"request":cancel}),
                json!({"operation":"integrateWorkItem","workSetId":id,"taskId":task,"request":integrate})
            ]
        );
        let before = registry.turn_recovery_calls.lock().unwrap().len();
        for path in [
            format!("/api/v1/agent-work-sets/{}", Uuid::new_v4()),
            format!(
                "/api/v1/agent-conversations/{conversation}/messages/{}/work-sets",
                Uuid::new_v4()
            ),
            format!(
                "/api/v1/agent-work-sets/{id}/items/{}/integration-preflight",
                Uuid::new_v4()
            ),
            "/api/v1/agent-work-sets/not-a-uuid".into(),
        ] {
            let response = router
                .clone()
                .oneshot(
                    protected_request(Method::GET, &path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
        }
        assert_eq!(registry.turn_recovery_calls.lock().unwrap().len(), before);
    }

    #[tokio::test]
    async fn work_set_routes_require_auth_and_reject_renderer_paths_or_commands() {
        let (registry, set, preflight, _) = work_set_route_fixture();
        let router = build_router(registry.clone(), policy(), None);
        let base = format!(
            "/api/v1/agent-conversations/{}/messages/{}/work-sets",
            set["conversationId"].as_str().unwrap(),
            set["requestId"].as_str().unwrap()
        );
        let set_path = format!(
            "/api/v1/agent-work-sets/{}",
            set["workSetId"].as_str().unwrap()
        );
        let item = format!(
            "{set_path}/items/{}",
            set["tasks"][0]["taskId"].as_str().unwrap()
        );
        let create = json!({"requestId":set["workSetId"],"expectedAfterCheckpointId":set["sourceCheckpointId"],"kind":"alternatives","tasks":[{"taskId":set["tasks"][0]["taskId"],"title":"A","prompt":"Change A.","dependsOn":[]}]});
        let mutations = [
            (base.clone(), create),
            (
                format!("{item}/cancel"),
                json!({"requestId":Uuid::new_v4(),"expectedRevision":3}),
            ),
            (
                format!("{item}/integration"),
                json!({"requestId":Uuid::new_v4(),"effectDigest":preflight["effectDigest"]}),
            ),
        ];
        for path in [
            base.clone(),
            set_path,
            format!("{item}/integration-preflight"),
        ] {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(&path)
                        .header(HOST, policy().authority())
                        .header(REQUEST_HEADER, REQUEST_MARKER)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        for (path, body) in mutations {
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(&path)
                        .header(HOST, policy().authority())
                        .header(REQUEST_HEADER, REQUEST_MARKER)
                        .header(ORIGIN, policy().origin())
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let response = router
                .clone()
                .oneshot(
                    protected_request(Method::POST, &path)
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            for field in ["command", "workspacePath", "candidatePath", "sourceRoot"] {
                let mut injected = body.clone();
                injected[field] = json!("../../outside; touch marker");
                let response = router
                    .clone()
                    .oneshot(
                        protected_request(Method::POST, &path)
                            .header(ORIGIN, policy().origin())
                            .header(CONTENT_TYPE, "application/json")
                            .body(Body::from(injected.to_string()))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
            }
        }
        assert!(registry.turn_recovery_calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn work_set_create_route_accepts_eight_maximum_escaped_prompts_and_bounds_the_body() {
        let (registry, set, _, _) = work_set_route_fixture();
        let router = build_router(registry.clone(), policy(), None);
        let path = format!(
            "/api/v1/agent-conversations/{}/messages/{}/work-sets",
            set["conversationId"].as_str().unwrap(),
            set["requestId"].as_str().unwrap()
        );
        let tasks = (0..8)
            .map(|_| {
                format!(
                    r#"{{"taskId":"{}","title":"Maximum","prompt":"{}","dependsOn":[]}}"#,
                    Uuid::new_v4(),
                    "\\u0078".repeat(16_384)
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let body = format!(
            r#"{{"requestId":"{}","expectedAfterCheckpointId":"{}","kind":"alternatives","tasks":[{}]}}"#,
            set["workSetId"].as_str().unwrap(),
            set["sourceCheckpointId"].as_str().unwrap(),
            tasks
        );
        let response = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &path)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let calls = registry.turn_recovery_calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["request"]["tasks"].as_array().unwrap().len(), 8);
        assert_eq!(
            calls[0]["request"]["tasks"][7]["prompt"].as_str().unwrap(),
            "x".repeat(16_384)
        );
        let oversized = format!(r#"{{"padding":"{}"}}"#, "x".repeat(1024 * 1024));
        let response = router
            .oneshot(
                protected_request(Method::POST, &path)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(oversized))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(registry.turn_recovery_calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn queued_message_routes_protect_scope_and_accept_two_maximum_bodies() {
        let path = format!(
            "/api/v1/agent-conversations/{}/messages/{}",
            Uuid::new_v4(),
            Uuid::new_v4()
        );
        for (method, url, body) in [
            (
                Method::PATCH,
                path.clone(),
                json!({"requestId":Uuid::new_v4(),"expectedBody":"Old request", "body":"Updated request"}),
            ),
            (
                Method::POST,
                format!("{path}/cancel"),
                json!({"requestId":Uuid::new_v4(),"expectedBody":"Old request"}),
            ),
        ] {
            let response = app()
                .oneshot(
                    protected_request(method.clone(), &url)
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
            let response = app()
                .oneshot(
                    Request::builder()
                        .method(method.clone())
                        .uri(&url)
                        .header(HOST, policy().authority())
                        .header(ORIGIN, policy().origin())
                        .header(REQUEST_HEADER, REQUEST_MARKER)
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let mut unknown = body;
            unknown["workspaceId"] = json!(Uuid::new_v4());
            let response = app()
                .oneshot(
                    protected_request(method, &url)
                        .header(ORIGIN, policy().origin())
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(unknown.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        }
        let escaped = "\\u0061".repeat(16_384);
        let body = format!(
            "{{\"requestId\":\"{}\",\"expectedBody\":\"{escaped}\",\"body\":\"{escaped}\"}}",
            Uuid::new_v4()
        );
        let response = app()
            .oneshot(
                protected_request(Method::PATCH, &path)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "valid bodies reach the backend"
        );
        let response = app()
            .oneshot(
                protected_request(Method::PATCH, &path)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from("a".repeat(2 * 16_384 * 6 + 8193)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn agent_session_list_route_serializes_global_handoff_contract() {
        let response = app()
            .oneshot(
                protected_request(Method::GET, "/api/v1/agent-sessions")
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["schemaVersion"], 1);
        assert_eq!(
            body["sessions"][0]["sessionId"],
            Uuid::from_u128(84).to_string()
        );
        assert_eq!(
            body["sessions"][0]["workspaceId"],
            Uuid::from_u128(42).to_string()
        );
        assert_eq!(body["sessions"][0]["status"], "handoffAccepted");
        assert_eq!(body["sessions"][0]["startedAtUnixMs"], 1_000);
        assert_eq!(body["sessions"][0]["endedAtUnixMs"], 1_000);
        assert!(body["sessions"][0].get("prompt").is_none());
        assert!(body["sessions"][0].get("transcript").is_none());
        assert!(body["sessions"][0].get("output").is_none());
        assert_eq!(body["observedSessions"][0]["status"], "working");
        assert_eq!(body["observedSessions"][0]["needsInput"]["kind"], "access");
        assert_eq!(
            body["observedSessions"][0]["needsInput"]["detail"],
            "Agent needs access."
        );
        assert!(body["observedSessions"][0].get("question").is_none());
        assert!(body["observedSessions"][0].get("command").is_none());
        assert_eq!(
            body["observedSessions"][0]["latestUpdate"],
            "Implemented the workspace card hierarchy and started verification."
        );
        assert_eq!(
            body["observedSessions"][0]["workspaceId"],
            Uuid::from_u128(42).to_string()
        );
    }

    #[tokio::test]
    async fn agent_session_detail_route_serializes_only_bounded_live_context() {
        let session_id = Uuid::from_u128(86);
        let response = app()
            .oneshot(
                protected_request(Method::GET, &format!("/api/v1/agent-sessions/{session_id}"))
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["schemaVersion"], 1);
        assert_eq!(body["sessionId"], session_id.to_string());
        assert_eq!(body["task"], "Implement the approved task.");
        assert_eq!(body["modelSelection"]["authority"], "providerDefault");
        assert!(body["modelSelection"].get("model").is_none());
        assert_eq!(body["events"][1]["kind"], "agentUpdate");
        assert_eq!(
            body["events"][1]["summary"],
            "I found the failing boundary."
        );
        assert!(body.get("reasoning").is_none());
        assert!(body.get("command").is_none());
        assert!(body.get("output").is_none());
    }

    #[tokio::test]
    async fn agent_session_list_route_serializes_read_only_local_observation() {
        let workspace_id = Uuid::from_u128(42);
        let response = app()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/agent-sessions?workspaceId={workspace_id}"),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        let observed = &body["observedSessions"][0];
        assert_eq!(observed["workspaceId"], workspace_id.to_string());
        assert_eq!(observed["source"], "codexVscodeRollout");
        assert_eq!(observed["status"], "working");
        assert_eq!(observed["activity"], "runningCommand");
        assert_eq!(observed["updateKind"], "progress");
        assert!(observed.get("prompt").is_none());
        assert!(observed.get("reasoning").is_none());
        assert!(observed.get("command").is_none());
        assert!(observed.get("output").is_none());
    }

    #[tokio::test]
    async fn active_jira_issue_route_returns_only_the_bounded_suggestion_contract() {
        let response = app()
            .oneshot(
                protected_request(Method::GET, "/api/v1/jira/issues/active")
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["schemaVersion"], 1);
        assert_eq!(body["issues"][0]["issueKey"], "PLATFORM-42");
        assert_eq!(body["issues"][0]["status"], "In Progress");
        assert!(body["issues"][0].get("description").is_none());
        assert!(body["issues"][0].get("content").is_none());
    }

    #[tokio::test]
    async fn time_review_brief_route_serializes_the_agent_ready_contract() {
        let response = app()
            .oneshot(
                protected_request(
                    Method::GET,
                    "/api/v1/integrations/activity-watch/time-review-brief?startedAtUnixMs=1775000000000&endedAtUnixMs=1775000600000&endpoint=http%3A%2F%2F127.0.0.1%3A5600",
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["schemaVersion"], 1);
        assert_eq!(body["reviewId"], "activitywatch-2026-04-01-1775000000000");
        assert_eq!(body["ledger"][0]["application"], "Visual Studio Code");
        assert_eq!(body["ledger"][0]["context"], "PLATFORM-42 · auth.py");
        assert_eq!(body["jiraCandidates"][0]["issueKey"], "PLATFORM-42");
        assert!(body["ledger"][0].get("rawTitle").is_none());
        assert!(body["ledger"][0].get("url").is_none());
    }

    async fn error_code(response: Response) -> String {
        response_json(response).await["error"]["code"]
            .as_str()
            .expect("error code")
            .to_owned()
    }

    #[tokio::test]
    async fn mr_source_routes_preserve_scope_revision_and_large_literal_text() {
        let uri = format!(
            "/api/v1/workspaces/{}/repositories/repo-1/source",
            Uuid::nil()
        );
        let read = app()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("{uri}?filePath=src%2Fsource%20file.ts"),
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        let source = response_json(read).await;
        assert_eq!(source["filePath"], "src/source file.ts");
        let content = "literal $text\\\n".repeat(8192);
        let request = json!({"filePath":"src/source file.ts","content":content,"expectedRevision":source["revision"]});
        let saved = app()
            .oneshot(
                protected_request(Method::PUT, &uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(response_json(saved).await["content"], content);
        let conflict = app().oneshot(protected_request(Method::PUT,&uri).header(ORIGIN,policy().origin()).header(CONTENT_TYPE,"application/json").body(Body::from(json!({"filePath":"src/source file.ts","content":"stale","expectedRevision":format!("sha256:{}","c".repeat(64))}).to_string())).unwrap()).await.unwrap();
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(error_code(conflict).await, "repository_file_conflict");
    }

    #[tokio::test]
    async fn mr_source_routes_forward_one_comparison_identity_and_refresh_flag() {
        let uri = format!(
            "/api/v1/workspaces/{}/repositories/repo-1/gitlab/17/comparison?refresh=true",
            Uuid::nil()
        );
        let response = app()
            .oneshot(
                protected_request(Method::GET, &uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let comparison = response_json(response).await;
        assert_eq!(comparison["iid"], 17);
        assert_eq!(comparison["published"]["repositoryId"], "repo-1");
        assert_eq!(comparison["status"], "missingCommits");
        assert!(comparison.get("latestWork").is_none());
    }

    #[tokio::test]
    async fn mr_inline_comment_route_preserves_workspace_and_published_position() {
        let request = json!({"body":"Explain this line.","filePath":"source.rs","side":"additions","line":1,"workspaceId":Uuid::nil(),"expectedPosition":{"baseCommitOid":"a".repeat(40),"startCommitOid":"a".repeat(40),"headCommitOid":"b".repeat(40)}});
        let response = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/reviews/gitlab/repo-1/17/comments")
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response_json(response).await["accepted"], true);
    }

    #[tokio::test]
    async fn mr_source_routes_reject_untrusted_requests_before_backend_calls() {
        let backend = Arc::new(FakeRegistry::default());
        let router = build_router(backend.clone(), policy(), None);
        let uri = format!(
            "/api/v1/workspaces/{}/repositories/repo-1/source",
            Uuid::nil()
        );
        let request = json!({"filePath":"source.ts","content":"edit","expectedRevision":format!("sha256:{}","a".repeat(64))});
        let no_origin = router
            .clone()
            .oneshot(
                protected_request(Method::PUT, &uri)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(request.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_origin.status(), StatusCode::FORBIDDEN);
        let mut untrusted = request;
        untrusted["root"] = json!("/outside");
        let unknown_field = router
            .clone()
            .oneshot(
                protected_request(Method::PUT, &uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(untrusted.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unknown_field.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let bad_query = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &format!("{uri}?filePath=file&root=outside"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(bad_query.status(), StatusCode::BAD_REQUEST);
        let no_auth = router
            .oneshot(
                Request::builder()
                    .uri(format!("{uri}?filePath=file"))
                    .header(HOST, policy().authority())
                    .header(REQUEST_HEADER, REQUEST_MARKER)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(no_auth.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(backend.source_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn gitlab_discussions_route_preserves_workspace_scope_and_freshness() {
        let workspace_id = Uuid::nil();
        let response = app()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!(
                        "/api/v1/reviews/gitlab/repo-1/17/discussions?workspaceId={workspace_id}"
                    ),
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["repositoryId"], "repo-1");
        assert_eq!(body["iid"], 17);
        assert_eq!(body["viewerLogin"], "alice");
        assert_eq!(body["fromCache"], false);
        assert_eq!(body["truncated"], false);
    }

    #[tokio::test]
    async fn gitlab_discussion_reply_route_preserves_thread_and_body() {
        let response = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/reviews/gitlab/repo-1/17/discussions/reply")
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"discussionId":"thread-1","body":"Reply with $literal\ntext", "workspaceId":Uuid::nil()}).to_string())).unwrap(),
            ).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["discussionId"], "thread-1");
        assert_eq!(body["comment"]["body"], "Reply with $literal\ntext");
        assert_eq!(body["comment"]["id"], 92);
    }

    #[tokio::test]
    async fn gitlab_discussion_routes_reject_untrusted_requests_before_backend_calls() {
        let backend = Arc::new(FakeRegistry::default());
        let router = build_router(backend.clone(), policy(), None);
        let read_uri = "/api/v1/reviews/gitlab/repo-1/17/discussions";
        let reply_uri = "/api/v1/reviews/gitlab/repo-1/17/discussions/reply";
        let unauthenticated = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(read_uri)
                    .header(HOST, policy().authority())
                    .header(REQUEST_HEADER, REQUEST_MARKER)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(error_code(unauthenticated).await, "unauthorized");
        let missing_origin = router
            .clone()
            .oneshot(
                protected_request(Method::POST, reply_uri)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"discussionId":"thread-1","body":"Reply"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(missing_origin).await, "invalid_origin");
        let unknown_field = router.clone().oneshot(protected_request(Method::POST,reply_uri)
            .header(ORIGIN,policy().origin()).header(CONTENT_TYPE,"application/json")
            .body(Body::from(r#"{"discussionId":"thread-1","body":"Reply","origin":"https://other.example/project.git"}"#)).unwrap()).await.unwrap();
        assert_eq!(unknown_field.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(unknown_field).await, "invalid_payload");
        for query in ["workspaceId=invalid", "origin=https%3A%2F%2Fother.example"] {
            let response = router
                .clone()
                .oneshot(
                    protected_request(Method::GET, &format!("{read_uri}?{query}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        assert_eq!(backend.discussion_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn gitlab_discussion_reply_failure_asks_for_refresh_before_retry() {
        let response = ApiError::from_mvp(map_local_mvp_error(
            LocalWtsError::GitlabDiscussionReplyFailed,
        ))
        .into_response();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "gitlab_discussion_reply_failed");
        assert_eq!(
            body["error"]["message"],
            "WTS could not confirm the reply. Refresh the discussion before you try again."
        );
    }

    #[tokio::test]
    async fn a_busy_workspace_gives_a_recovery_step_for_checks_and_restores() {
        let response =
            ApiError::from_mvp(map_local_mvp_error(LocalWtsError::AgentConversationBusy))
                .into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "agent_conversation_busy");
        assert_eq!(
            body["error"]["message"],
            "Another WTS task is active in this workspace. Wait for it to finish, then retry."
        );
    }

    #[tokio::test]
    async fn unavailable_clone_branch_has_a_recoverable_http_error() {
        let response = ApiError::from_mvp(map_local_mvp_error(
            LocalWtsError::RepositoryCloneBranchUnavailable,
        ))
        .into_response();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "repository_clone_branch_unavailable");
        assert_eq!(
            body["error"]["message"],
            "The requested branch is not available locally. Refresh the repository branches, or select an available branch."
        );
    }

    #[tokio::test]
    async fn activity_watch_route_rejects_remote_endpoints_before_transport() {
        let response = app()
            .oneshot(
                protected_request(
                    Method::GET,
                    "/api/v1/integrations/activity-watch/status?endpoint=http%3A%2F%2F192.168.1.4%3A5600",
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            error_code(response).await,
            "activity_watch_invalid_endpoint"
        );
    }

    #[tokio::test]
    async fn activity_watch_daily_review_route_rejects_unbounded_windows_before_reading_events() {
        let response = app()
            .oneshot(
                protected_request(
                    Method::GET,
                    "/api/v1/integrations/activity-watch/daily-review?startedAtUnixMs=1000&endedAtUnixMs=172801001",
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            error_code(response).await,
            "activity_watch_invalid_time_range"
        );
    }

    #[tokio::test]
    async fn activity_watch_route_runs_blocking_client_off_async_worker() {
        let listener =
            StdTcpListener::bind("127.0.0.1:0").expect("bind mock ActivityWatch endpoint");
        let port = listener.local_addr().expect("mock address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept ActivityWatch request");
            let mut request = [0_u8; 4096];
            let size = stream
                .read(&mut request)
                .expect("read ActivityWatch request");
            assert!(
                std::str::from_utf8(&request[..size])
                    .expect("request is utf-8")
                    .starts_with("GET /api/0/info HTTP/1.1\r\n")
            );
            let body = r#"{"version":"v0.13.2"}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write ActivityWatch response");
        });
        let uri = format!(
            "/api/v1/integrations/activity-watch/status?endpoint=http%3A%2F%2F127.0.0.1%3A{port}"
        );

        let response = app()
            .oneshot(
                protected_request(Method::GET, &uri)
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");

        server.join().expect("mock ActivityWatch server");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["state"], "running");
        assert_eq!(body["serverVersion"], "v0.13.2");
    }

    async fn create_saved_workspace(router: &Router) -> Uuid {
        let response = router
            .clone()
            .oneshot(create_request(
                &sample_request("Checkout retry race"),
                TEST_KEY,
            ))
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::CREATED);
        let body = response_json(response).await;
        Uuid::parse_str(
            body["workspace"]["workspaceId"]
                .as_str()
                .expect("workspace id"),
        )
        .expect("UUID workspace id")
    }

    #[test]
    fn rejects_non_loopback_bind_addresses() {
        assert!(matches!(
            parse_bind_address("0.0.0.0:3000"),
            Err(StartupError::NonLoopbackAddress)
        ));
        assert!(matches!(
            parse_bind_address("[::]:3000"),
            Err(StartupError::NonLoopbackAddress)
        ));
        assert!(parse_bind_address("127.0.0.1:0").is_ok());
        assert!(parse_bind_address("[::1]:0").is_ok());
    }

    #[test]
    fn repository_root_configuration_rejects_relative_paths() {
        assert!(matches!(
            checked_absolute(
                PathBuf::from("relative/repositories"),
                "WTS_REPOSITORY_ROOT"
            ),
            Err(StartupError::RelativePath("WTS_REPOSITORY_ROOT"))
        ));
    }

    #[test]
    fn codex_executable_override_must_be_absolute() {
        assert!(matches!(
            agent_adapter_from_value(Some("bin/codex".into())),
            Err(StartupError::RelativePath("WTS_CODEX_EXECUTABLE"))
        ));
        assert!(agent_adapter_from_value(Some("/opt/fake/codex".into())).is_ok());
        assert!(agent_adapter_from_value(Some("".into())).is_ok());
        assert!(agent_adapter_from_value(None).is_ok());
    }

    #[test]
    fn repository_root_list_uses_the_platform_path_separator() {
        let first = env::temp_dir().join("wts-root-one");
        let second = env::temp_dir().join("wts-root-two");
        let joined = env::join_paths([&first, &second]).expect("platform path list");
        assert_eq!(
            checked_repository_root_list(&joined).expect("absolute root list"),
            vec![first, second.clone()]
        );

        let invalid = env::join_paths([Path::new("relative"), second.as_path()])
            .expect("invalid fixture path list");
        assert!(matches!(
            checked_repository_root_list(&invalid),
            Err(StartupError::RelativePath("WTS_REPOSITORY_ROOTS"))
        ));
    }

    #[test]
    fn mvp_failures_have_stable_sanitized_http_mappings() {
        let cases = [
            (
                MvpFailure::InvalidAgentConversation,
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_agent_conversation",
            ),
            (
                MvpFailure::AgentConversationNotFound,
                StatusCode::NOT_FOUND,
                "agent_conversation_not_found",
            ),
            (
                MvpFailure::AgentConversationConflict,
                StatusCode::CONFLICT,
                "agent_conversation_conflict",
            ),
            (
                MvpFailure::AgentConversationBusy,
                StatusCode::CONFLICT,
                "agent_conversation_busy",
            ),
            (
                MvpFailure::AgentConversationSourceUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_conversation_source_unavailable",
            ),
            (
                MvpFailure::AgentConversationPlatformUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "agent_conversation_platform_unavailable",
            ),
            (
                MvpFailure::AgentConversationStorageFull,
                StatusCode::CONFLICT,
                "agent_conversation_storage_full",
            ),
            (
                MvpFailure::AgentConversationLimit,
                StatusCode::CONFLICT,
                "agent_conversation_limit",
            ),
            (
                MvpFailure::InvalidLocalConfiguration,
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_local_configuration",
            ),
            (
                MvpFailure::RepositoryCatalogUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "repository_catalog_unavailable",
            ),
            (
                MvpFailure::WorkspaceNotFound,
                StatusCode::NOT_FOUND,
                "workspace_not_found",
            ),
            (
                MvpFailure::InvalidReviewThread,
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_review_thread",
            ),
            (
                MvpFailure::ReviewCommentTooLarge,
                StatusCode::PAYLOAD_TOO_LARGE,
                "review_comment_too_large",
            ),
            (
                MvpFailure::ReviewThreadNotFound,
                StatusCode::NOT_FOUND,
                "review_thread_not_found",
            ),
            (
                MvpFailure::ReviewThreadConflict,
                StatusCode::CONFLICT,
                "review_thread_conflict",
            ),
            (
                MvpFailure::PreflightBlocked,
                StatusCode::CONFLICT,
                "preflight_blocked",
            ),
            (
                MvpFailure::StalePreflight,
                StatusCode::CONFLICT,
                "stale_preflight",
            ),
            (
                MvpFailure::MaterializationFailed,
                StatusCode::INTERNAL_SERVER_ERROR,
                "materialization_failed",
            ),
            (
                MvpFailure::MaterializationCleanupIncomplete,
                StatusCode::INTERNAL_SERVER_ERROR,
                "materialization_cleanup_incomplete",
            ),
            (
                MvpFailure::GeneratedWorkspaceFailed,
                StatusCode::INTERNAL_SERVER_ERROR,
                "generated_workspace_failed",
            ),
            (
                MvpFailure::GeneratedWorkspaceCleanupIncomplete,
                StatusCode::INTERNAL_SERVER_ERROR,
                "generated_workspace_cleanup_incomplete",
            ),
            (
                MvpFailure::WorkspaceNotMaterialized,
                StatusCode::CONFLICT,
                "workspace_not_materialized",
            ),
            (
                MvpFailure::InvalidMaterializationManifest,
                StatusCode::CONFLICT,
                "invalid_materialization_manifest",
            ),
            (
                MvpFailure::WorkspaceGitStateChanged,
                StatusCode::CONFLICT,
                "workspace_git_state_changed",
            ),
            (
                MvpFailure::WorkspaceRemovalBlocked,
                StatusCode::CONFLICT,
                "workspace_removal_blocked",
            ),
            (
                MvpFailure::WorkspaceRemovalFailed,
                StatusCode::INTERNAL_SERVER_ERROR,
                "workspace_removal_failed",
            ),
            (
                MvpFailure::IdempotencyConflict,
                StatusCode::CONFLICT,
                "idempotency_conflict",
            ),
            (
                MvpFailure::VscodeUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "vscode_unavailable",
            ),
            (
                MvpFailure::VscodeLaunchRejected,
                StatusCode::INTERNAL_SERVER_ERROR,
                "vscode_launch_rejected",
            ),
            (
                MvpFailure::InvalidTestJourney,
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_test_journey",
            ),
            (
                MvpFailure::TestRunnerUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "test_runner_unavailable",
            ),
            (
                MvpFailure::TestRunnerFailed,
                StatusCode::BAD_GATEWAY,
                "test_runner_failed",
            ),
            (
                MvpFailure::TestRunnerBusy,
                StatusCode::CONFLICT,
                "test_runner_busy",
            ),
            (
                MvpFailure::TestRunnerTimedOut,
                StatusCode::GATEWAY_TIMEOUT,
                "test_runner_timed_out",
            ),
            (
                MvpFailure::TestRunnerOutputTooLarge,
                StatusCode::UNPROCESSABLE_ENTITY,
                "test_runner_output_too_large",
            ),
            (
                MvpFailure::TestEvidenceUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "test_evidence_unavailable",
            ),
            (
                MvpFailure::TestRunNotFound,
                StatusCode::NOT_FOUND,
                "test_run_not_found",
            ),
            (
                MvpFailure::InvalidTestEvidence,
                StatusCode::CONFLICT,
                "invalid_test_evidence",
            ),
            (
                MvpFailure::InvalidOpenProjectReference,
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_open_project_reference",
            ),
            (
                MvpFailure::OpenProjectConfiguration,
                StatusCode::UNPROCESSABLE_ENTITY,
                "open_project_configuration_invalid",
            ),
            (
                MvpFailure::OpenProjectAuthentication,
                StatusCode::BAD_GATEWAY,
                "open_project_authentication_failed",
            ),
            (
                MvpFailure::OpenProjectPermission,
                StatusCode::BAD_GATEWAY,
                "open_project_permission_denied",
            ),
            (
                MvpFailure::OpenProjectNotFound,
                StatusCode::NOT_FOUND,
                "open_project_work_package_not_found",
            ),
            (
                MvpFailure::OpenProjectAmbiguous,
                StatusCode::CONFLICT,
                "open_project_reference_ambiguous",
            ),
            (
                MvpFailure::OpenProjectTimedOut,
                StatusCode::GATEWAY_TIMEOUT,
                "open_project_timed_out",
            ),
            (
                MvpFailure::OpenProjectResponseTooLarge,
                StatusCode::UNPROCESSABLE_ENTITY,
                "open_project_response_too_large",
            ),
            (
                MvpFailure::OpenProjectRateLimited,
                StatusCode::TOO_MANY_REQUESTS,
                "open_project_rate_limited",
            ),
            (
                MvpFailure::OpenProjectRemoteFailure,
                StatusCode::BAD_GATEWAY,
                "open_project_remote_failure",
            ),
        ];

        for (failure, status, code) in cases {
            let error = ApiError::from_mvp(failure);
            assert_eq!(error.status, status);
            assert_eq!(error.code, code);
            assert!(!error.message.contains('/'));
            assert!(!error.message.contains("git "));
            assert!(!error.message.contains("command"));
        }
    }

    #[tokio::test]
    async fn bootstrap_requires_the_exact_bound_host_and_disables_caching_and_cors() {
        let rejected = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/bootstrap")
                    .header(HOST, "localhost:43123")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(rejected).await, "invalid_host");

        let accepted = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/bootstrap")
                    .header(HOST, policy().authority())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(accepted.headers()[CACHE_CONTROL], "no-store");
        assert!(
            accepted
                .headers()
                .get(ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none()
        );
        let body = response_json(accepted).await;
        assert_eq!(body["apiVersion"], "v1");
        assert_eq!(body["origin"], policy().origin());
        assert_eq!(body["sessionToken"], TEST_TOKEN);
    }

    #[tokio::test]
    async fn registry_reads_require_the_session_and_local_ui_marker() {
        let missing_session = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/workspaces")
                    .header(HOST, policy().authority())
                    .header(REQUEST_HEADER, REQUEST_MARKER)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_session.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(error_code(missing_session).await, "unauthorized");

        let missing_marker = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/workspaces")
                    .header(HOST, policy().authority())
                    .header(SESSION_HEADER, TEST_TOKEN)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_marker.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(missing_marker).await, "invalid_client");

        let accepted = app()
            .oneshot(
                protected_request(Method::GET, "/api/v1/workspaces")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(accepted.status(), StatusCode::OK);
        assert_eq!(
            response_json(accepted).await,
            json!({
                "workspaceRootId": "default",
                "workspaceRootDisplayPath": "/Users/test/cd",
                "workspaces": []
            })
        );
    }

    #[tokio::test]
    async fn mvp_reads_are_protected_and_return_the_wire_contracts() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;

        let unauthorized = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/setup")
                    .header(HOST, policy().authority())
                    .header(REQUEST_HEADER, REQUEST_MARKER)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(error_code(unauthorized).await, "unauthorized");

        let setup = router
            .clone()
            .oneshot(
                protected_request(Method::GET, "/api/v1/setup")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(setup.status(), StatusCode::OK);
        assert_eq!(
            response_json(setup).await,
            json!({
                "checkedAtUnixMs": 1,
                "repositoryCount": 1,
                "integrations": []
            })
        );

        let repositories = router
            .clone()
            .oneshot(
                protected_request(Method::GET, "/api/v1/repositories")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(repositories.status(), StatusCode::OK);
        let repositories = response_json(repositories).await;
        assert_eq!(repositories["repositoryRootDisplayPath"], "/Users/test/src");
        assert_eq!(repositories["repositories"][0]["label"], "checkout-api");
        assert_eq!(
            repositories["repositories"][0]["defaultBranch"]["name"],
            "main"
        );

        let cloned = router
            .clone()
            .oneshot(
                protected_request(Method::POST, "/api/v1/repositories/clone")
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "remoteUrl": "https://github.com/acme/ledger-api.git"
                        })
                        .to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(cloned.status(), StatusCode::OK);
        let cloned = response_json(cloned).await;
        assert_eq!(cloned["repository"]["label"], "ledger-api");
        assert_eq!(
            cloned["repository"]["displayPath"],
            "/Users/test/src/ledger-api"
        );
        assert_eq!(cloned["reusedExisting"], false);

        let preflight = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/preflight"),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(preflight.status(), StatusCode::OK);
        let preflight = response_json(preflight).await;
        assert_eq!(preflight["workspaceId"], workspace_id.to_string());
        assert_eq!(preflight["ready"], true);
        assert_eq!(preflight["effectDigest"], "sha256:test");

        let materialization = router
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/materialization"),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(materialization.status(), StatusCode::OK);
        assert_eq!(response_json(materialization).await, Value::Null);
    }

    #[tokio::test]
    async fn review_thread_routes_preserve_the_typed_planning_anchor() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let created = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/review/threads"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "target": {
                            "kind": "planningDocument",
                            "documentId": "plan",
                            "documentSha256": format!("sha256:{}", "a".repeat(64)),
                            "line": 2
                        },
                        "author": "user",
                        "body": "Check this condition."
                    })
                    .to_string(),
                ))
                .expect("build request"),
            )
            .await
            .expect("router response");
        if created.status() != StatusCode::OK {
            let status = created.status();
            let payload = response_json(created).await;
            panic!("review thread create returned {status}: {payload}");
        }
        let created = response_json(created).await;
        assert_eq!(created["target"]["kind"], "planningDocument");
        assert_eq!(created["target"]["line"], 2);
        assert_eq!(created["comments"][0]["body"], "Check this condition.");

        let listed = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/review/threads"),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(listed.status(), StatusCode::OK);
        assert_eq!(
            response_json(listed).await["workspaceId"],
            workspace_id.to_string()
        );

        let resolved = router
            .oneshot(
                protected_request(
                    Method::PATCH,
                    &format!(
                        "/api/v1/workspaces/{workspace_id}/review/threads/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/resolve"
                    ),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"expectedRevision":1}"#))
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(resolved.status(), StatusCode::OK);
        assert_eq!(response_json(resolved).await["state"], "resolved");
    }

    #[tokio::test]
    async fn review_thread_route_preserves_the_typed_verification_anchor() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let created = router
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/review/threads"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "target": {
                            "kind": "verificationCheck",
                            "planRevision": 7,
                            "completedAtUnixMs": 1_722_000_000_100_i64,
                            "checkId": "checkout-api-cargo-test"
                        },
                        "author": "user",
                        "body": "The local service was not running."
                    })
                    .to_string(),
                ))
                .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await;
        assert_eq!(created["target"]["kind"], "verificationCheck");
        assert_eq!(created["target"]["planRevision"], 7);
        assert_eq!(
            created["currentVerificationCompletedAtUnixMs"],
            1_722_000_000_100_i64
        );
        assert!(created["currentDocumentSha256"].is_null());
    }

    #[tokio::test]
    async fn review_thread_route_preserves_the_typed_code_anchor() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let created = router
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/review/threads"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "target": {
                            "kind": "codeChange",
                            "repositoryId": format!("repo_{}", "a".repeat(64)),
                            "baseCommitOid": "a".repeat(40),
                            "headCommitOid": "b".repeat(40),
                            "patchSha256": format!("sha256:{}", "c".repeat(64)),
                            "filePath": "src/review.rs",
                            "side": "additions",
                            "line": 42
                        },
                        "author": "user",
                        "body": "Explain this branch."
                    })
                    .to_string(),
                ))
                .expect("build request"),
            )
            .await
            .expect("router response");

        assert_eq!(created.status(), StatusCode::OK);
        let created = response_json(created).await;
        assert_eq!(created["target"]["kind"], "codeChange");
        assert_eq!(created["target"]["filePath"], "src/review.rs");
        assert_eq!(created["target"]["side"], "additions");
        assert_eq!(created["target"]["line"], 42);
    }

    #[tokio::test]
    async fn workspace_jira_link_routes_require_preview_before_confirm_and_preserve_cas() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let preview = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/work-items/jira/preview"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"issueKey":"PLATFORM-42","role":"primary"}"#))
                .expect("Jira preview request"),
            )
            .await
            .expect("Jira preview response");
        assert_eq!(preview.status(), StatusCode::OK);
        let preview = response_json(preview).await;
        assert_eq!(preview["snapshot"]["issueKey"], "PLATFORM-42");
        assert_eq!(preview["role"], "primary");
        let digest = preview["previewDigest"].as_str().expect("preview digest");

        let opened_preview = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/work-items/jira/open-preview"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "issueKey": "PLATFORM-42",
                        "role": "primary",
                        "expectedPreviewDigest": digest
                    })
                    .to_string(),
                ))
                .expect("open Jira preview request"),
            )
            .await
            .expect("open Jira preview response");
        assert_eq!(opened_preview.status(), StatusCode::OK);
        assert_eq!(response_json(opened_preview).await["accepted"], true);

        let confirmed = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/work-items/jira/confirm"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "issueKey": "PLATFORM-42",
                        "role": "primary",
                        "expectedPreviewDigest": digest,
                        "idempotencyKey": "33333333-3333-4333-8333-333333333333"
                    })
                    .to_string(),
                ))
                .expect("Jira confirmation request"),
            )
            .await
            .expect("Jira confirmation response");
        assert_eq!(confirmed.status(), StatusCode::OK);
        let confirmed = response_json(confirmed).await;
        assert_eq!(confirmed["link"]["snapshot"]["issueKey"], "PLATFORM-42");
        assert_eq!(confirmed["link"]["revision"], 1);

        let listed = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/work-items"),
                )
                .body(Body::empty())
                .expect("list work items request"),
            )
            .await
            .expect("list work items response");
        assert_eq!(listed.status(), StatusCode::OK);

        let link_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        let opened_link = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/work-items/{link_id}/open"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"expectedRevision":1}"#))
                .expect("open linked Jira request"),
            )
            .await
            .expect("open linked Jira response");
        assert_eq!(opened_link.status(), StatusCode::OK);
        assert_eq!(response_json(opened_link).await["accepted"], true);

        let unlinked = router
            .clone()
            .oneshot(
                protected_request(
                    Method::DELETE,
                    &format!("/api/v1/workspaces/{workspace_id}/work-items/{link_id}"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"expectedRevision":1}"#))
                .expect("unlink work item request"),
            )
            .await
            .expect("unlink work item response");
        assert_eq!(unlinked.status(), StatusCode::OK);
        assert_eq!(response_json(unlinked).await["removedRevision"], 1);

        let proposal = router
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/work-items/jira/create-proposal"),
                )
                .body(Body::empty())
                .expect("Jira create proposal request"),
            )
            .await
            .expect("Jira create proposal response");
        assert_eq!(proposal.status(), StatusCode::OK);
        let proposal = response_json(proposal).await;
        assert_eq!(proposal["canExecute"], false);
        assert_eq!(proposal["requiresExplicitApproval"], true);
    }

    #[tokio::test]
    async fn runtime_analysis_is_protected_and_uses_only_repository_intent() {
        let router = app();
        let uri = "/api/v1/workspace-plans/runtime-analysis";
        let payload = json!({
            "repositories": [{
                "repositoryId": "repo-1",
                "label": "checkout-api",
                "baseRef": "main"
            }]
        });

        let response = router
            .clone()
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(payload.to_string()))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        let response = response_json(response).await;
        assert_eq!(
            response["analysisDigest"],
            format!("sha256:{}", "a".repeat(64))
        );
        assert_eq!(response["repositories"][0]["repositoryId"], "repo-1");
        assert_eq!(response["graph"]["status"], "unavailable");

        let unknown_authority = router
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "repositories": [{
                                "repositoryId": "repo-1",
                                "label": "checkout-api",
                                "baseRef": "main"
                            }],
                            "command": ["npm", "run", "dev"]
                        })
                        .to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(unknown_authority.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(unknown_authority).await, "invalid_payload");
    }

    #[tokio::test]
    async fn code_workspace_import_is_protected_and_uses_a_strict_wire_contract() {
        let router = app();
        let uri = "/api/v1/code-workspaces/import";
        let payload = json!({
            "fileName": "checkout.code-workspace",
            "contents": "{ folders: [{ path: '../checkout-api' }] }"
        });

        let missing_origin = router
            .clone()
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&payload).expect("serialize request"),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(missing_origin).await, "invalid_origin");

        let imported = router
            .clone()
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&payload).expect("serialize request"),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(imported.status(), StatusCode::OK);
        let imported = response_json(imported).await;
        let import_id = imported["importId"]
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
            .expect("response import id");
        assert!(!import_id.is_nil());
        assert_eq!(imported["fileName"], "checkout.code-workspace");
        assert_eq!(imported["suggestedTitle"], "checkout");
        assert_eq!(
            imported["suggestedRepositorySetLabel"],
            "VS Code · checkout"
        );
        assert_eq!(imported["folders"][0]["status"], "matched");
        assert_eq!(
            imported["folders"][0]["repositoryId"],
            imported["repositories"][0]["repositoryId"]
        );
        assert_eq!(imported["repositories"][0]["label"], "checkout-api");
        assert_eq!(imported["repositories"][0]["baseRef"], "main");

        let escaped_contents = format!(
            "{{ folders: [], settings: {{ blob: '{}' }} }}",
            "\\\\".repeat(22 * 1024)
        );
        assert!(escaped_contents.len() < 48 * 1024);
        let escaped_body = serde_json::to_vec(&json!({
            "fileName": "escaped.code-workspace",
            "contents": escaped_contents,
        }))
        .expect("serialize escaped request");
        assert!(escaped_body.len() > API_BODY_LIMIT_BYTES);
        assert!(escaped_body.len() < CODE_WORKSPACE_IMPORT_BODY_LIMIT_BYTES);
        let escaped = router
            .clone()
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(escaped_body))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(escaped.status(), StatusCode::OK);

        let unknown_field = router
            .clone()
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"fileName":"checkout.code-workspace","contents":"{ folders: [] }","path":"/tmp/unsafe"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(unknown_field.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(unknown_field).await, "invalid_payload");

        let spoofed_import_id = router
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"fileName":"checkout.code-workspace","contents":"{ folders: [] }","importId":"11111111-1111-4111-8111-111111111111"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(spoofed_import_id.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(spoofed_import_id).await, "invalid_payload");
    }

    #[test]
    fn code_workspace_import_failures_have_stable_api_errors() {
        let invalid = ApiError::from_mvp(MvpFailure::InvalidCodeWorkspaceImport);
        assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(invalid.code, "invalid_code_workspace_import");

        let too_large = ApiError::from_mvp(MvpFailure::CodeWorkspaceImportTooLarge);
        assert_eq!(too_large.status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(too_large.code, "code_workspace_import_too_large");
    }

    #[test]
    fn default_tracing_filter_targets_the_library_crate() {
        #[cfg(debug_assertions)]
        assert_eq!(
            default_tracing_filter(),
            "wts_server=info,wts_app::repository_catalog=info,wts_app::repository_clone=info,wts_app::runtime_analysis=info,wts_app::operations=info,tower_http=warn"
        );
        #[cfg(not(debug_assertions))]
        assert_eq!(default_tracing_filter(), "wts_server=info");
    }

    #[cfg(debug_assertions)]
    #[test]
    fn development_log_values_are_bounded_and_control_safe() {
        assert_eq!(bounded_diagnostic_text("infra\nrepo", 64), "infra�repo");
        assert_eq!(bounded_diagnostic_text("abcdef", 3), "abc");
        assert_eq!(
            bounded_diagnostic_text("vscode-remote://user:secret@host/repo?token=sentinel", 4096),
            "<unsupported-uri>"
        );
        assert_eq!(
            bounded_diagnostic_text("vscode-remote:user:secret@host/repo?token=sentinel", 4096),
            "<unsupported-uri>"
        );
        assert_eq!(
            bounded_diagnostic_text(r"C:\repos\checkout-api", 4096),
            r"C:\repos\checkout-api"
        );
    }

    #[tokio::test]
    async fn repository_base_open_uses_a_strict_server_owned_contract() {
        let router = app();
        let uri = "/api/v1/repositories/repo-1/open/base";

        let opened = router
            .clone()
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"baseRef":"main"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = response_json(opened).await;
        assert_eq!(opened["repositoryId"], "repo-1");
        assert_eq!(opened["forge"], "gitlab");
        assert_eq!(opened["host"], "gitlab.example.test");
        assert_eq!(opened["baseRef"], "main");
        assert_eq!(
            opened["commitOid"],
            "1111111111111111111111111111111111111111"
        );
        assert_eq!(opened["accepted"], true);
        assert!(opened.get("url").is_none());

        let unknown_field = router
            .clone()
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"baseRef":"main","url":"https://example.invalid"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(unknown_field.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(unknown_field).await, "invalid_payload");

        let unknown_repository = router
            .clone()
            .oneshot(
                protected_request(Method::POST, "/api/v1/repositories/repo-unknown/open/base")
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"baseRef":"main"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(unknown_repository.status(), StatusCode::NOT_FOUND);
        assert_eq!(error_code(unknown_repository).await, "repository_not_found");

        let missing_base = router
            .oneshot(
                protected_request(Method::POST, uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"baseRef":"develop"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_base.status(), StatusCode::CONFLICT);
        assert_eq!(error_code(missing_base).await, "repository_base_not_found");
    }

    #[tokio::test]
    async fn setup_recovery_route_preserves_review_and_requires_an_explicit_exact_action() {
        let backend = Arc::new(FakeRegistry::default());
        let router = build_router(Arc::clone(&backend), policy(), None);
        let workspace_id = create_saved_workspace(&router).await;
        let digest = format!("sha256:{}", "a".repeat(64));
        let mut preview = fake_preflight(workspace_id);
        preview["ready"] = json!(false);
        preview["setupRecovery"] = json!({
            "effectDigest": digest,
            "ready": true,
            "paths": ["/Users/test/cd/retained-workspace/checkout-api"],
            "blockers": []
        });
        *backend.setup_recovery_preflight.lock().unwrap() =
            Some(serde_json::from_value(preview.clone()).unwrap());
        let read = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/preflight"),
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        assert_eq!(response_json(read).await, preview);
        assert!(backend.setup_recovery_calls.lock().unwrap().is_empty());
        assert!(backend.materializations.lock().unwrap().is_empty());

        let uri = format!("/api/v1/workspaces/{workspace_id}/setup-recovery");
        let recover = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"effectDigest":digest}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(recover.status(), StatusCode::OK);
        assert_eq!(response_json(recover).await, fake_preflight(workspace_id));
        assert_eq!(
            *backend.setup_recovery_calls.lock().unwrap(),
            [(workspace_id, digest)]
        );
        assert!(backend.materializations.lock().unwrap().is_empty());

        let stale = format!("sha256:{}", "b".repeat(64));
        let rejected = router
            .oneshot(
                protected_request(Method::POST, &uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"effectDigest":stale}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::CONFLICT);
        assert_eq!(error_code(rejected).await, "stale_preflight");
        assert!(backend.materializations.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn setup_recovery_route_rejects_untrusted_and_malformed_actions_before_backend() {
        let backend = Arc::new(FakeRegistry::default());
        let router = build_router(Arc::clone(&backend), policy(), None);
        let workspace_id = create_saved_workspace(&router).await;
        let uri = format!("/api/v1/workspaces/{workspace_id}/setup-recovery");
        let valid = json!({"effectDigest":format!("sha256:{}", "a".repeat(64))});
        let unauthenticated = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(&uri)
                    .header(HOST, policy().authority())
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(valid.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        let missing_origin = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &uri)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(valid.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
        for (path, body, expected) in [
            (
                uri.clone(),
                json!({"effectDigest":valid["effectDigest"],"workspacePath":"/outside"}),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (uri.clone(), json!({}), StatusCode::UNPROCESSABLE_ENTITY),
            (
                uri.clone(),
                json!({"effectDigest":" "}),
                StatusCode::BAD_REQUEST,
            ),
            (
                uri.clone(),
                json!({"effectDigest":"sha256:short"}),
                StatusCode::BAD_REQUEST,
            ),
            (
                "/api/v1/workspaces/not-a-uuid/setup-recovery".to_owned(),
                valid.clone(),
                StatusCode::NOT_FOUND,
            ),
        ] {
            let rejected = router
                .clone()
                .oneshot(
                    protected_request(Method::POST, &path)
                        .header(ORIGIN, policy().origin())
                        .header(CONTENT_TYPE, "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(rejected.status(), expected, "{path}: {body}");
        }
        assert!(backend.setup_recovery_calls.lock().unwrap().is_empty());
        assert!(backend.materializations.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn materialize_and_open_enforce_transport_guards_and_strict_bodies() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let materialize_uri = format!("/api/v1/workspaces/{workspace_id}/materialize");
        let open_uri = format!("/api/v1/workspaces/{workspace_id}/open/vscode");
        let cli_uri = format!("/api/v1/workspaces/{workspace_id}/open/cli/codex?terminal=warp");
        let brief_uri = format!("/api/v1/workspaces/{workspace_id}/agent-brief");

        let missing_origin = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &materialize_uri)
                    .header(IDEMPOTENCY_HEADER, MATERIALIZE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(missing_origin).await, "invalid_origin");

        let missing_idempotency = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &materialize_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_idempotency.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            error_code(missing_idempotency).await,
            "missing_idempotency_key"
        );

        let extra_field = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &materialize_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, MATERIALIZE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"effectDigest":"sha256:test","workspacePath":"/tmp"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(extra_field.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(extra_field).await, "invalid_payload");

        let not_materialized = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &open_uri)
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(not_materialized.status(), StatusCode::CONFLICT);
        assert_eq!(
            error_code(not_materialized).await,
            "workspace_not_materialized"
        );
        let cli_not_materialized = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &cli_uri)
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(cli_not_materialized.status(), StatusCode::CONFLICT);
        assert_eq!(
            error_code(cli_not_materialized).await,
            "workspace_not_materialized"
        );

        let materialized = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &materialize_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, MATERIALIZE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(materialized.status(), StatusCode::OK);
        let materialized = response_json(materialized).await;
        assert_eq!(materialized["replayed"], false);
        assert_eq!(
            materialized["materialization"]["workspaceId"],
            workspace_id.to_string()
        );

        let durable_view = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/materialization"),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(durable_view.status(), StatusCode::OK);
        assert_eq!(
            response_json(durable_view).await["workspaceId"],
            workspace_id.to_string()
        );

        let written_brief = router
            .clone()
            .oneshot(
                protected_request(Method::PUT, &brief_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"taskMarkdown":"Verify the real user flows."}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(written_brief.status(), StatusCode::OK);
        let written_brief = response_json(written_brief).await;
        assert_eq!(written_brief["workspaceId"], workspace_id.to_string());
        assert_eq!(
            written_brief["briefDisplayPath"],
            format!("/Users/test/cd/{workspace_id}/WTS.md")
        );

        let missing_open_origin = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &open_uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_open_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(missing_open_origin).await, "invalid_origin");

        let unexpected_body = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &open_uri)
                    .header(ORIGIN, policy().origin())
                    .body(Body::from("{}"))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(unexpected_body.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(unexpected_body).await, "unexpected_body");

        let opened = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &open_uri)
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = response_json(opened).await;
        assert_eq!(opened["provider"], "vsCode");
        assert_eq!(opened["accepted"], true);
        assert_eq!(opened["workspaceId"], workspace_id.to_string());

        let invalid_provider = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/open/cli/unknown"),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(invalid_provider.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(invalid_provider).await, "invalid_agent_provider");

        let unexpected_cli_body = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &cli_uri)
                    .header(ORIGIN, policy().origin())
                    .body(Body::from("{}"))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(
            unexpected_cli_body.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(error_code(unexpected_cli_body).await, "unexpected_body");

        let cli_opened = router
            .oneshot(
                protected_request(Method::POST, &cli_uri)
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(cli_opened.status(), StatusCode::OK);
        let cli_opened = response_json(cli_opened).await;
        assert_eq!(cli_opened["workspaceId"], workspace_id.to_string());
        assert_eq!(cli_opened["provider"], "codex");
        assert_eq!(cli_opened["terminal"], "warp");
        assert_eq!(cli_opened["accepted"], true);
        assert_eq!(
            cli_opened["workspaceDisplayPath"],
            format!("/Users/test/cd/{workspace_id}")
        );
    }

    #[tokio::test]
    async fn change_request_handoff_uses_strict_workspace_routes() {
        let router = app();
        let workspace_id = Uuid::new_v4();
        let prepare_uri = format!("/api/v1/workspaces/{workspace_id}/change-requests/prepare");
        let prepared = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &prepare_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"repositoryId":"repo-1"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(prepared.status(), StatusCode::OK);
        let prepared = response_json(prepared).await;
        assert_eq!(prepared["repositoryId"], "repo-1");
        assert!(prepared.get("url").is_none());

        let publish_uri =
            format!("/api/v1/workspaces/{workspace_id}/change-requests/publish-branch");
        let published = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &publish_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"repositoryId":"repo-1","branchName":"feat/custom-name"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(published.status(), StatusCode::OK);
        let published = response_json(published).await;
        assert_eq!(published["repositoryId"], "repo-1");
        assert_eq!(published["remoteName"], "origin");
        assert_eq!(published["branchName"], "feat/custom-name");
        assert!(published.get("remoteUrl").is_none());

        let open_uri = format!("/api/v1/workspaces/{workspace_id}/change-requests/open");
        let opened = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &open_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "repositoryId": "repo-1",
                            "effectDigest": format!("sha256:{}", "a".repeat(64)),
                            "title": "PLATFORM-7197: Validate admission",
                            "body": "## Summary\n\n- Validate admission"
                        })
                        .to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = response_json(opened).await;
        assert_eq!(opened["accepted"], true);
        assert!(opened.get("url").is_none());

        let rejected = router
            .oneshot(
                protected_request(Method::POST, &open_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"repositoryId":"repo-1","effectDigest":"sha256:bad","title":"Title","body":"Body","url":"https://evil.invalid"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(rejected.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(rejected).await, "invalid_payload");
    }

    #[tokio::test]
    async fn github_review_inbox_uses_a_read_only_server_owned_contract() {
        let response = app()
            .oneshot(
                protected_request(Method::GET, "/api/v1/reviews/github")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["state"], "fresh");
        assert_eq!(body["reviews"][0]["repository"], "acme/checkout-api");
        assert_eq!(body["reviews"][0]["number"], 7);
        assert!(body.get("repositoryUrl").is_none());

        let opened = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/reviews/github/repo-1/7/open")
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = response_json(opened).await;
        assert_eq!(opened["repositoryId"], "repo-1");
        assert_eq!(opened["number"], 7);
        assert_eq!(opened["accepted"], true);

        let gitlab = app()
            .oneshot(
                protected_request(Method::GET, "/api/v1/reviews/gitlab")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(gitlab.status(), StatusCode::OK);
        let gitlab = response_json(gitlab).await;
        assert_eq!(gitlab["state"], "fresh");
        assert_eq!(gitlab["reviews"][0]["repository"], "acme/checkout-api");
        assert_eq!(gitlab["reviews"][0]["number"], 17);
        assert_eq!(gitlab["reviews"][0]["sourceBranch"], "feat/delivery");
        assert_eq!(gitlab["reviews"][0]["targetBranch"], "develop");
        assert!(gitlab["reviews"][0].get("webUrl").is_none());

        let prepared = app()
            .oneshot(
                protected_request(
                    Method::POST,
                    "/api/v1/reviews/gitlab/repo-1/17/prepare-repository",
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(prepared.status(), StatusCode::OK);
        let prepared = response_json(prepared).await;
        assert_eq!(prepared["repository"]["id"], "repo-1");
        assert_eq!(prepared["reusedExisting"], true);
        assert!(prepared.get("url").is_none());
    }

    #[tokio::test]
    async fn link_merge_request_forwards_workspace_repository_and_iid_and_returns_verified_mr() {
        let backend = Arc::new(FakeRegistry::default());
        let router = build_router(Arc::clone(&backend), policy(), None);
        let workspace_id = Uuid::new_v4();
        let path = format!("/api/v1/workspaces/{workspace_id}/gitlab-merge-requests/repo-1/43/link");
        let response = router
            .oneshot(
                protected_request(Method::POST, &path)
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["repositoryId"], "repo-1");
        assert_eq!(body["iid"], 43);
        assert_eq!(body["sourceBranch"], "review/senzu-complete-flow");
        assert_eq!(
            *backend.merge_request_link_calls.lock().unwrap(),
            vec![(workspace_id, "repo-1".to_owned(), 43)]
        );
    }

    #[tokio::test]
    async fn link_merge_request_reports_provider_failure_without_claiming_success() {
        assert_eq!(
            map_local_mvp_error(LocalWtsError::GitlabMergeRequestLinkUnavailable),
            MvpFailure::GitlabMergeRequestLinkUnavailable
        );
        let backend = Arc::new(FakeRegistry::default());
        *backend.merge_request_link_failure.lock().unwrap() =
            Some(MvpFailure::GitlabMergeRequestLinkUnavailable);
        let router = build_router(backend, policy(), None);
        let workspace_id = Uuid::new_v4();
        let response = router
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!(
                        "/api/v1/workspaces/{workspace_id}/gitlab-merge-requests/repo-1/43/link"
                    ),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "gitlab_merge_request_link_unavailable");
        assert!(body["error"]["message"].as_str().unwrap().contains("retry"));
    }

    #[tokio::test]
    async fn gitlab_merge_requests_use_workspace_scope_and_a_server_owned_open_action() {
        let workspace_id = Uuid::new_v4();
        let response = app()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/merge-requests/gitlab"),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        assert_eq!(body["state"], "fresh");
        assert_eq!(body["mergeRequests"][0]["iid"], 17);
        assert_eq!(body["mergeRequests"][0]["status"], "open");
        assert!(body["mergeRequests"][0].get("webUrl").is_none());

        let opened = app()
            .oneshot(
                protected_request(
                    Method::POST,
                    "/api/v1/repositories/repo-1/merge-requests/gitlab/17/open",
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = response_json(opened).await;
        assert_eq!(opened["repositoryId"], "repo-1");
        assert_eq!(opened["iid"], 17);
        assert_eq!(opened["accepted"], true);
        assert!(opened.get("url").is_none());
    }

    #[tokio::test]
    async fn gitlab_integration_is_a_read_only_cli_status_contract() {
        let workspace_id = Uuid::new_v4();
        let status = app()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/integrations/gitlab"),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(status.status(), StatusCode::OK);
        let status = response_json(status).await;
        assert_eq!(status["accounts"][0]["host"], "gitlab.example.com");
        for secret_field in ["token", "url", "command", "path"] {
            assert!(status.get(secret_field).is_none());
        }

        let sign_in = app()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/integrations/gitlab/sign-in"),
                )
                .header(ORIGIN, policy().origin())
                .header("content-type", "application/json")
                .body(Body::from(r#"{"host":"gitlab.example.com"}"#))
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(sign_in.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn removal_routes_preserve_active_operation_recovery_without_deleting() {
        let backend = Arc::new(FakeRegistry::default());
        let router = build_router(Arc::clone(&backend), policy(), None);
        let workspace_id = create_saved_workspace(&router).await;
        let mut value = fake_removal_preflight(workspace_id, false);
        value["ready"] = json!(false);
        value["protectedPaths"] = json!([]);
        value["blockers"] = json!([{
            "code": "activeOperation",
            "message": "An agent task is active. Wait before removal.",
            "displayPath": format!("/Users/test/cd/{workspace_id}"),
            "expected": "No active or queued workspace operations.",
            "observed": "An agent task is active.",
            "recoverySteps": ["Wait for the task to finish, or stop it from its task controls.", "Select Check again."]
        }]);
        *backend.removal_preflight.lock().unwrap() =
            Some(serde_json::from_value(value.clone()).unwrap());
        let read = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/removal-preflight"),
                )
                .body(Body::empty())
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(read.status(), StatusCode::OK);
        assert_eq!(response_json(read).await, value);
        assert!(backend.removal_idempotency.lock().unwrap().is_empty());
        let remove = router
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/remove"),
                )
                .header(ORIGIN, policy().origin())
                .header(IDEMPOTENCY_HEADER, REMOVE_KEY)
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"effectDigest":"sha256:remove-test","deleteProtectedPaths":true}"#,
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(remove.status(), StatusCode::CONFLICT);
        assert_eq!(error_code(remove).await, "workspace_removal_blocked");
        assert!(
            backend
                .workspaces
                .lock()
                .unwrap()
                .contains_key(&workspace_id)
        );
        assert!(backend.removal_idempotency.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn manual_workspace_commands_are_strict_previewed_and_idempotent() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let materialize_uri = format!("/api/v1/workspaces/{workspace_id}/materialize");
        let reindex_uri = format!("/api/v1/workspaces/{workspace_id}/graph/reindex");
        let removal_preflight_uri = format!("/api/v1/workspaces/{workspace_id}/removal-preflight");
        let remove_uri = format!("/api/v1/workspaces/{workspace_id}/remove");

        let saved_plan_preflight = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &removal_preflight_uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(saved_plan_preflight.status(), StatusCode::OK);
        let saved_plan_preflight = response_json(saved_plan_preflight).await;
        assert_eq!(saved_plan_preflight["kind"], "savedPlan");
        assert_eq!(saved_plan_preflight["ready"], true);
        assert_eq!(saved_plan_preflight["effectDigest"], "sha256:remove-test");

        let reindex_before_materialization = router
            .clone()
            .oneshot(empty_action_request(&reindex_uri))
            .await
            .expect("router response");
        assert_eq!(
            reindex_before_materialization.status(),
            StatusCode::CONFLICT
        );
        assert_eq!(
            error_code(reindex_before_materialization).await,
            "workspace_not_materialized"
        );

        let materialized = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &materialize_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, MATERIALIZE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(materialized.status(), StatusCode::OK);

        let reindex_with_body = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &reindex_uri)
                    .header(ORIGIN, policy().origin())
                    .body(Body::from("{}"))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(reindex_with_body.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(reindex_with_body).await, "unexpected_body");

        let reindexed = router
            .clone()
            .oneshot(empty_action_request(&reindex_uri))
            .await
            .expect("router response");
        assert_eq!(reindexed.status(), StatusCode::OK);
        let reindexed = response_json(reindexed).await;
        assert_eq!(reindexed["status"], "ready");
        assert_eq!(reindexed["detail"], "Structural graph refreshed.");

        let materialized_preflight = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &removal_preflight_uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(materialized_preflight.status(), StatusCode::OK);
        let materialized_preflight = response_json(materialized_preflight).await;
        assert_eq!(materialized_preflight["kind"], "materializedWorkspace");
        assert_eq!(materialized_preflight["worktrees"][0]["present"], true);
        assert_eq!(
            materialized_preflight["retainedBranches"],
            json!(["wts/platform-42-test"])
        );

        let missing_origin = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &remove_uri)
                    .header(IDEMPOTENCY_HEADER, REMOVE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:remove-test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(missing_origin).await, "invalid_origin");

        let missing_idempotency = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &remove_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:remove-test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_idempotency.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            error_code(missing_idempotency).await,
            "missing_idempotency_key"
        );

        let invalid_idempotency = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &remove_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, "not-a-uuid")
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:remove-test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(
            invalid_idempotency.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            error_code(invalid_idempotency).await,
            "invalid_idempotency_key"
        );

        let extra_field = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &remove_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, REMOVE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"effectDigest":"sha256:remove-test","deleteBranches":true}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(extra_field.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(extra_field).await, "invalid_payload");

        let stale_preflight = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &remove_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, REMOVE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:stale"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(stale_preflight.status(), StatusCode::CONFLICT);
        assert_eq!(error_code(stale_preflight).await, "stale_preflight");

        let removed = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &remove_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, REMOVE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:remove-test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(removed.status(), StatusCode::OK);
        let removed = response_json(removed).await;
        assert_eq!(removed["replayed"], false);
        assert_eq!(removed["removedWorktreeCount"], 1);
        assert_eq!(removed["retainedBranches"], json!(["wts/platform-42-test"]));

        let replayed = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &remove_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, REMOVE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:remove-test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(replayed.status(), StatusCode::OK);
        assert_eq!(response_json(replayed).await["replayed"], true);

        let removed_workspace = router
            .oneshot(
                protected_request(Method::GET, &format!("/api/v1/workspaces/{workspace_id}"))
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(removed_workspace.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn repository_patch_full_file_and_review_graph_use_separate_read_routes() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let repository_uri = format!("/api/v1/workspaces/{workspace_id}/repositories/repo-1");

        let patch = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &format!("{repository_uri}/diff"))
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(patch.status(), StatusCode::OK);
        let patch = response_json(patch).await;
        assert!(patch.get("reviewGraph").is_none());

        let full_file = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!(
                        "{repository_uri}/file?path=README.md&expectedPatchSha256=sha256%3Atest"
                    ),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(full_file.status(), StatusCode::OK);
        let full_file = response_json(full_file).await;
        assert_eq!(full_file["filePath"], "README.md");
        assert_eq!(full_file["content"], "complete file\n");

        let invalid_path = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!(
                        "{repository_uri}/file?path=..%2Foutside.txt&expectedPatchSha256=sha256%3Atest"
                    ),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(invalid_path.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            response_json(invalid_path).await["error"]["code"],
            "invalid_repository_file_path"
        );

        let graph = router
            .oneshot(
                protected_request(Method::GET, &format!("{repository_uri}/review-graph"))
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(graph.status(), StatusCode::OK);
        assert_eq!(response_json(graph).await["graphSha256"], "sha256:review");
    }

    #[tokio::test]
    async fn repository_sync_uses_only_workspace_and_repository_identities() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let uri = format!("/api/v1/workspaces/{workspace_id}/repositories/repo-1/sync");

        let synced = router
            .clone()
            .oneshot(empty_action_request(&uri))
            .await
            .expect("router response");
        assert_eq!(synced.status(), StatusCode::OK);
        let synced = response_json(synced).await;
        assert_eq!(synced["workspaceId"], workspace_id.to_string());
        assert_eq!(synced["repositoryId"], "repo-1");
        assert_eq!(synced["updated"], true);
        assert_eq!(synced["graphRefreshed"], true);
        assert_eq!(
            synced["baseCommitOid"],
            "2222222222222222222222222222222222222222"
        );

        let unknown = router
            .oneshot(empty_action_request(&format!(
                "/api/v1/workspaces/{workspace_id}/repositories/repo-missing/sync"
            )))
            .await
            .expect("router response");
        assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
        assert_eq!(error_code(unknown).await, "repository_not_found");
    }

    #[tokio::test]
    async fn repository_alignment_requires_a_reviewed_digest_and_rejects_extra_authority() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let preview_uri =
            format!("/api/v1/workspaces/{workspace_id}/repositories/repo-1/alignment-preflight");
        let align_uri = format!("/api/v1/workspaces/{workspace_id}/repositories/repo-1/align");

        let preview = router
            .clone()
            .oneshot(empty_action_request(&preview_uri))
            .await
            .expect("router response");
        assert_eq!(preview.status(), StatusCode::OK);
        let preview = response_json(preview).await;
        assert_eq!(preview["repositoryId"], "repo-1");
        assert_eq!(preview["remoteFullRef"], "refs/remotes/upstream/main");
        assert_eq!(
            preview["backupFullRef"],
            "refs/wts/backups/1111111111111111111111111111111111111111"
        );

        let aligned = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &align_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "effectDigest": preview["effectDigest"] }).to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(aligned.status(), StatusCode::OK);
        let aligned = response_json(aligned).await;
        assert_eq!(aligned["repositoryId"], "repo-1");
        assert_eq!(
            aligned["previousBaseCommitOid"],
            preview["currentCommitOid"]
        );
        assert_eq!(aligned["baseCommitOid"], preview["targetCommitOid"]);

        let over_authorized = router
            .oneshot(
                protected_request(Method::POST, &align_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "effectDigest": preview["effectDigest"],
                            "targetCommitOid": preview["targetCommitOid"]
                        })
                        .to_string(),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(over_authorized.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(over_authorized).await, "invalid_payload");
    }

    #[tokio::test]
    async fn code_review_routes_forward_review_options_and_expose_saved_reviews_and_models() {
        let registry = Arc::new(FakeRegistry::default());
        let router = build_router(registry.clone(), policy(), None);
        let workspace_id = Uuid::new_v4();
        let run_uri = format!("/api/v1/workspaces/{workspace_id}/code-review/run");
        let run = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &run_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({"provider":"codex","scope":"recentChanges","model":"gpt-5.6-sol","repositoryId":"repo_api","ignoreSizeGate":true,"skill":"team-review","mergeRequestIid":41}).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(run.status(), StatusCode::OK);
        let wire = response_json(run).await;
        assert_eq!(wire["request"]["model"], "gpt-5.6-sol");
        assert_eq!(wire["request"]["repositoryId"], "repo_api");
        assert_eq!(wire["request"]["ignoreSizeGate"], true);
        assert_eq!(wire["request"]["skill"], "team-review");
        assert_eq!(wire["request"]["mergeRequestIid"], 41);

        let legacy = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &run_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({"provider":"copilot","scope":"totalCode","agent":"auto"}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response_json(legacy).await["request"]["model"], "auto");

        let saved = router
            .clone()
            .oneshot(protected_request(Method::GET, &format!("/api/v1/workspaces/{workspace_id}/code-review")).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);
        assert_eq!(response_json(saved).await["mode"], "raptik");

        let models = router
            .clone()
            .oneshot(protected_request(Method::GET, "/api/v1/agent-models?refresh=true").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(models.status(), StatusCode::OK);
        let models = response_json(models).await;
        assert_eq!(models["providers"][0]["provider"], "codex");
        assert_eq!(models["providers"][0]["defaultModel"], "refreshed");
        assert_eq!(models["providers"][0]["modelSelectable"], true);
        assert_eq!(models["defaultReviewSkill"], "raptik-review");

        let untrusted = router
            .oneshot(Request::builder().method(Method::GET).uri("/api/v1/agent-models").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_ne!(untrusted.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn code_review_trace_route_returns_steps_after_the_given_sequence() {
        let registry = Arc::new(FakeRegistry::default());
        let router = build_router(registry, policy(), None);
        let workspace_id = Uuid::new_v4();
        let uri = format!("/api/v1/workspaces/{workspace_id}/code-review/trace?after=1");
        let trace = router
            .clone()
            .oneshot(protected_request(Method::GET, &uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(trace.status(), StatusCode::OK);
        let trace = response_json(trace).await;
        assert_eq!(trace["state"], "running");
        assert_eq!(trace["provider"], "codex");
        assert_eq!(trace["steps"].as_array().unwrap().len(), 2);
        assert_eq!(trace["steps"][0]["sequence"], 2);
        assert_eq!(trace["steps"][0]["kind"], "command");
        assert_eq!(trace["steps"][1]["running"], true);

        let unknown = router
            .oneshot(
                protected_request(Method::GET, &format!("/api/v1/workspaces/{workspace_id}/code-review/trace?since=1"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(unknown.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn saved_verification_summary_route_returns_only_the_saved_contract() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let uri = format!("/api/v1/workspaces/{workspace_id}/verification/summary");
        let empty = router.clone().oneshot(protected_request(Method::GET, &uri).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(empty.status(), StatusCode::OK);
        assert_eq!(response_json(empty).await, Value::Null);
        let materialize_uri = format!("/api/v1/workspaces/{workspace_id}/materialize");
        let materialized = router.clone().oneshot(protected_request(Method::POST, &materialize_uri)
            .header(ORIGIN, policy().origin()).header(IDEMPOTENCY_HEADER, MATERIALIZE_KEY)
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"effectDigest":"sha256:test"}"#)).unwrap()).await.unwrap();
        assert_eq!(materialized.status(), StatusCode::OK);
        let response = router.clone().oneshot(protected_request(Method::GET, &uri).body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let wire = response_json(response).await;
        assert_eq!(wire["workspaceId"], workspace_id.to_string());
        assert_eq!(wire["verificationResult"]["status"], "failed");
        assert_eq!(wire["verificationResult"]["planRevision"], 1);
        assert_eq!(wire.as_object().unwrap().len(), 5);
        assert!(wire.get("context").is_none());
        let untrusted = router.oneshot(Request::builder().method(Method::GET).uri(uri).body(Body::empty()).unwrap()).await.unwrap();
        assert_ne!(untrusted.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn graph_agent_and_jira_adapter_routes_return_real_wire_contracts() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let materialize_uri = format!("/api/v1/workspaces/{workspace_id}/materialize");

        let materialized = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &materialize_uri)
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, MATERIALIZE_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"effectDigest":"sha256:test"}"#))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(materialized.status(), StatusCode::OK);

        let graph = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/graph/index"),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(graph.status(), StatusCode::OK);
        assert_eq!(response_json(graph).await["status"], "ready");

        let agent = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/agents/codex/run"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"prompt":"Inspect the failing test."}"#))
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(agent.status(), StatusCode::OK);
        let agent = response_json(agent).await;
        assert_eq!(agent["provider"], "codex");
        assert_eq!(agent["succeeded"], true);

        let evidence_uri = format!("/api/v1/workspaces/{workspace_id}/evidence");
        let evidence = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &evidence_uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(evidence.status(), StatusCode::OK);
        assert_eq!(
            response_json(evidence).await["verificationResult"]["status"],
            "notRun"
        );

        let promoted = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!(
                        "/api/v1/workspaces/{workspace_id}/verification/agent-proposals/checkout-cargo-test/promote"
                    ),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(promoted.status(), StatusCode::OK);
        assert_eq!(
            response_json(promoted).await["proposalId"],
            "checkout-cargo-test"
        );

        let workspace_verification = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/verification/run"),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(workspace_verification.status(), StatusCode::OK);
        assert_eq!(
            response_json(workspace_verification).await["verificationResult"]["status"],
            "passed"
        );

        let targeted_verification = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!(
                        "/api/v1/workspaces/{workspace_id}/verification/checks/checkout-cargo-test/run"
                    ),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(targeted_verification.status(), StatusCode::OK);
        assert_eq!(
            response_json(targeted_verification).await["selectedCheckId"],
            "checkout-cargo-test"
        );

        let rerun_failed = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/verification/failed/run"),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(rerun_failed.status(), StatusCode::OK);
        assert_eq!(response_json(rerun_failed).await["selection"], "failed");

        let cancelled = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/verification/cancel"),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(cancelled.status(), StatusCode::OK);
        assert_eq!(
            response_json(cancelled).await["verificationResult"]["status"],
            "cancelled"
        );

        let jira_verification = router
            .clone()
            .oneshot(
                protected_request(Method::POST, "/api/v1/integrations/jira-mcp/verify")
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(jira_verification.status(), StatusCode::OK);
        assert_eq!(
            response_json(jira_verification).await["issueTool"],
            "jira_get_issue"
        );

        let issue = router
            .clone()
            .oneshot(
                protected_request(Method::POST, "/api/v1/jira/issues/PLATFORM-42/import")
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(issue.status(), StatusCode::OK);
        let issue = response_json(issue).await;
        assert_eq!(issue["issueKey"], "PLATFORM-42");
        assert_eq!(issue["suggestedRepositories"], json!(["checkout-api"]));
        assert_eq!(
            issue["repositoryRecommendations"][0],
            json!({
                "repositoryId": "repo_checkout",
                "label": "checkout-api",
                "confidence": 100,
                "reason": "The imported issue references this repository's repository label.",
                "sources": ["label"]
            })
        );

        let open_project_verification = router
            .clone()
            .oneshot(
                protected_request(Method::POST, "/api/v1/integrations/open-project/verify")
                    .header(ORIGIN, policy().origin())
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(open_project_verification.status(), StatusCode::OK);
        assert_eq!(
            response_json(open_project_verification).await["apiVersion"],
            "v3"
        );

        let work_package = router
            .oneshot(
                protected_request(
                    Method::POST,
                    "/api/v1/open-project/work-packages/APP-42/import",
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(work_package.status(), StatusCode::OK);
        let work_package = response_json(work_package).await;
        assert_eq!(work_package["displayId"], "APP-42");
        assert_eq!(
            work_package["suggestedRepositories"],
            json!(["checkout-api"])
        );
        assert_eq!(
            work_package["repositoryRecommendations"][0]["repositoryId"],
            "repo_checkout"
        );
    }

    #[tokio::test]
    async fn test_run_routes_require_materialization_and_use_strict_journey_requests() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let test_runs_uri = format!("/api/v1/workspaces/{workspace_id}/test-runs");

        let list_before_materialization = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &test_runs_uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(list_before_materialization.status(), StatusCode::CONFLICT);
        assert_eq!(
            error_code(list_before_materialization).await,
            "workspace_not_materialized"
        );

        let run_before_materialization = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &test_runs_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"journeyId":"wts-help-preferences","baseUrl":"http://127.0.0.1:43123"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(run_before_materialization.status(), StatusCode::CONFLICT);
        assert_eq!(
            error_code(run_before_materialization).await,
            "workspace_not_materialized"
        );

        let materialized = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/materialize"),
                )
                .header(ORIGIN, policy().origin())
                .header(IDEMPOTENCY_HEADER, MATERIALIZE_KEY)
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"effectDigest":"sha256:test"}"#))
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(materialized.status(), StatusCode::OK);

        let list = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &test_runs_uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(list.status(), StatusCode::OK);
        let list = response_json(list).await;
        assert_eq!(list["workspaceId"], workspace_id.to_string());
        assert_eq!(list["runs"], json!([]));

        let run_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let test_run_uri = format!("{test_runs_uri}/{run_id}");
        let unauthenticated_detail = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&test_run_uri)
                    .header(HOST, policy().authority())
                    .header(REQUEST_HEADER, REQUEST_MARKER)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(unauthenticated_detail.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(error_code(unauthenticated_detail).await, "unauthorized");

        let detail = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &test_run_uri)
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(detail.status(), StatusCode::OK);
        let detail = response_json(detail).await;
        assert_eq!(detail["workspaceId"], workspace_id.to_string());
        assert_eq!(detail["runId"], run_id);
        assert_eq!(detail["state"], "passed");

        let missing_detail = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("{test_runs_uri}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
                )
                .body(Body::empty())
                .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_detail.status(), StatusCode::NOT_FOUND);
        assert_eq!(error_code(missing_detail).await, "test_run_not_found");

        let malformed_detail = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &format!("{test_runs_uri}/not-a-uuid"))
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(malformed_detail.status(), StatusCode::NOT_FOUND);
        assert_eq!(error_code(malformed_detail).await, "test_run_not_found");

        let unknown_field = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &test_runs_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"journeyId":"wts-help-preferences","baseUrl":"http://127.0.0.1:43123","script":"rm -rf /"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(unknown_field.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(unknown_field).await, "invalid_payload");

        let invalid_journey = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &test_runs_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"journeyId":"arbitrary-script","baseUrl":"https://example.com"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(invalid_journey.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(invalid_journey).await, "invalid_test_journey");

        let alternate_loopback_origin = router
            .clone()
            .oneshot(
                protected_request(Method::POST, &test_runs_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"journeyId":"wts-help-preferences","baseUrl":"http://127.0.0.1:43124"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(
            alternate_loopback_origin.status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            error_code(alternate_loopback_origin).await,
            "invalid_test_journey"
        );

        let run = router
            .oneshot(
                protected_request(Method::POST, &test_runs_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        r#"{"journeyId":"wts-help-preferences","baseUrl":"http://127.0.0.1:43123"}"#,
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(run.status(), StatusCode::OK);
        let run = response_json(run).await;
        assert_eq!(run["workspaceId"], workspace_id.to_string());
        assert_eq!(run["journeyId"], "wts-help-preferences");
        assert_eq!(run["state"], "passed");
    }

    #[tokio::test]
    async fn creation_requires_same_origin_json_and_an_idempotency_key() {
        let payload = sample_request("Checkout retry race");

        let missing_origin = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/workspaces")
                    .header(IDEMPOTENCY_HEADER, TEST_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&payload).expect("serialize request"),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(missing_origin).await, "invalid_origin");

        let foreign_origin = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/workspaces")
                    .header(ORIGIN, "https://example.invalid")
                    .header(IDEMPOTENCY_HEADER, TEST_KEY)
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&payload).expect("serialize request"),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(foreign_origin.status(), StatusCode::FORBIDDEN);
        assert_eq!(error_code(foreign_origin).await, "invalid_origin");

        let missing_idempotency = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/workspaces")
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        serde_json::to_vec(&payload).expect("serialize request"),
                    ))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(missing_idempotency.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            error_code(missing_idempotency).await,
            "missing_idempotency_key"
        );

        let wrong_content_type = app()
            .oneshot(
                protected_request(Method::POST, "/api/v1/workspaces")
                    .header(ORIGIN, policy().origin())
                    .header(IDEMPOTENCY_HEADER, TEST_KEY)
                    .header(CONTENT_TYPE, "text/plain")
                    .body(Body::from("{}"))
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(
            wrong_content_type.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
        assert_eq!(
            error_code(wrong_content_type).await,
            "unsupported_media_type"
        );
    }

    #[tokio::test]
    async fn creation_reports_created_replay_conflict_and_validation_semantics() {
        let router = app();
        let first = router
            .clone()
            .oneshot(create_request(
                &sample_request("Checkout retry race"),
                TEST_KEY,
            ))
            .await
            .expect("router response");
        assert_eq!(first.status(), StatusCode::CREATED);
        assert_eq!(first.headers()["x-wts-idempotent-replay"], "false");
        let first_body = response_json(first).await;
        assert_eq!(first_body["replayed"], false);

        let replay = router
            .clone()
            .oneshot(create_request(
                &sample_request("Checkout retry race"),
                TEST_KEY,
            ))
            .await
            .expect("router response");
        assert_eq!(replay.status(), StatusCode::OK);
        assert_eq!(replay.headers()["x-wts-idempotent-replay"], "true");
        let replay_body = response_json(replay).await;
        assert_eq!(replay_body["replayed"], true);
        assert_eq!(replay_body["workspace"], first_body["workspace"]);

        let conflict = router
            .clone()
            .oneshot(create_request(
                &sample_request("Another workspace"),
                TEST_KEY,
            ))
            .await
            .expect("router response");
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(error_code(conflict).await, "idempotency_conflict");

        let invalid = router
            .oneshot(create_request(
                &sample_request(" "),
                "22222222-2222-4222-8222-222222222222",
            ))
            .await
            .expect("router response");
        assert_eq!(invalid.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(error_code(invalid).await, "validation_failed");
    }

    #[tokio::test]
    async fn creation_preserves_actionable_runtime_revalidation_failures() {
        let cases = [
            (
                RegistryFailure::RepositoryCatalogUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "repository_catalog_unavailable",
            ),
            (
                RegistryFailure::RepositoryNotFound,
                StatusCode::NOT_FOUND,
                "repository_not_found",
            ),
            (
                RegistryFailure::RepositoryChanged,
                StatusCode::CONFLICT,
                "repository_changed",
            ),
            (
                RegistryFailure::InvalidRepositoryBase,
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_repository_base",
            ),
            (
                RegistryFailure::RepositoryBaseNotFound,
                StatusCode::CONFLICT,
                "repository_base_not_found",
            ),
            (
                RegistryFailure::InvalidRuntimeAnalysisRequest,
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_runtime_analysis_request",
            ),
            (
                RegistryFailure::RuntimeAnalysisUnavailable,
                StatusCode::SERVICE_UNAVAILABLE,
                "runtime_analysis_unavailable",
            ),
        ];

        for (failure, expected_status, expected_code) in cases {
            let registry = Arc::new(FakeRegistry {
                create_failure: Mutex::new(Some(failure)),
                ..FakeRegistry::default()
            });
            let response = build_router(registry, policy(), None)
                .oneshot(create_request(
                    &sample_request("Runtime-aware workspace"),
                    TEST_KEY,
                ))
                .await
                .expect("router response");

            assert_eq!(response.status(), expected_status);
            assert_eq!(error_code(response).await, expected_code);
        }
    }

    #[tokio::test]
    async fn get_maps_invalid_or_unknown_workspace_ids_to_not_found() {
        for workspace_id in ["not-a-uuid".to_owned(), Uuid::from_u128(99).to_string()] {
            let response = app()
                .oneshot(
                    protected_request(Method::GET, &format!("/api/v1/workspaces/{workspace_id}"))
                        .body(Body::empty())
                        .expect("build request"),
                )
                .await
                .expect("router response");
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(error_code(response).await, "workspace_not_found");
        }
    }

    #[tokio::test]
    async fn rename_workspace_updates_the_display_name_over_the_wire() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let uri = format!("/api/v1/workspaces/{workspace_id}");

        let response = router
            .clone()
            .oneshot(
                protected_request(Method::PATCH, &uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"title":"  Release readiness  "}"#))
                    .expect("build rename request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        let renamed = response_json(response).await;
        assert_eq!(renamed["title"], "Checkout retry race");
        assert_eq!(renamed["displayName"], "Release readiness");

        let response = router
            .oneshot(
                protected_request(Method::GET, &uri)
                    .body(Body::empty())
                    .expect("build get request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response_json(response).await["displayName"],
            "Release readiness"
        );
    }

    #[tokio::test]
    async fn workflow_and_planning_documents_use_fixed_http_contracts() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;

        let workflow = router
            .clone()
            .oneshot(
                protected_request(
                    Method::PATCH,
                    &format!("/api/v1/workspaces/{workspace_id}/workflow"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"state":"review","expectedRevision":1}"#))
                .expect("workflow request"),
            )
            .await
            .expect("workflow response");
        assert_eq!(workflow.status(), StatusCode::OK);
        let workflow = response_json(workflow).await;
        assert_eq!(workflow["state"], "review");
        assert_eq!(workflow["revision"], 2);

        let placement = router
            .clone()
            .oneshot(
                protected_request(
                    Method::PATCH,
                    &format!("/api/v1/workspaces/{workspace_id}/board-placement"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"state":"active","expectedRevision":2}"#))
                .expect("board placement request"),
            )
            .await
            .expect("board placement response");
        assert_eq!(placement.status(), StatusCode::OK);
        let placement = response_json(placement).await;
        assert_eq!(placement["state"], "active");
        assert_eq!(placement["placement"]["mode"], "pinned");

        let follow = router
            .clone()
            .oneshot(
                protected_request(
                    Method::PATCH,
                    &format!("/api/v1/workspaces/{workspace_id}/board-placement/follow-agent"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"expectedRevision":3}"#))
                .expect("follow-agent request"),
            )
            .await
            .expect("follow-agent response");
        assert_eq!(follow.status(), StatusCode::OK);
        assert_eq!(
            response_json(follow).await["placement"]["mode"],
            "automatic"
        );

        let list_uri = format!("/api/v1/workspaces/{workspace_id}/planning/documents");
        let list = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &list_uri)
                    .body(Body::empty())
                    .expect("planning list request"),
            )
            .await
            .expect("planning list response");
        assert_eq!(list.status(), StatusCode::OK);
        assert_eq!(
            response_json(list).await["documents"][0]["fileName"],
            "PLAN.md"
        );

        let plan_uri = format!("{list_uri}/plan");
        let plan = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &plan_uri)
                    .body(Body::empty())
                    .expect("planning read request"),
            )
            .await
            .expect("planning read response");
        assert_eq!(plan.status(), StatusCode::OK);
        assert_eq!(response_json(plan).await["contents"], "# Plan\n");

        let updated = router
            .clone()
            .oneshot(
                protected_request(Method::PUT, &plan_uri)
                    .header(ORIGIN, policy().origin())
                    .header(CONTENT_TYPE, "application/json")
                    .body(Body::from(format!(
                        r##"{{"expectedSha256":"sha256:{}","contents":"# Reviewed\n"}}"##,
                        "a".repeat(64)
                    )))
                    .expect("planning update request"),
            )
            .await
            .expect("planning update response");
        assert_eq!(updated.status(), StatusCode::OK);
        assert_eq!(response_json(updated).await["contents"], "# Reviewed\n");

        let traversal = router
            .oneshot(
                protected_request(Method::GET, &format!("{list_uri}/..%2FPLAN.md"))
                    .body(Body::empty())
                    .expect("path-like planning identifier request"),
            )
            .await
            .expect("path-like planning identifier response");
        assert!(matches!(
            traversal.status(),
            StatusCode::NOT_FOUND | StatusCode::BAD_REQUEST
        ));
    }

    #[tokio::test]
    async fn agent_session_prototype_exposes_start_heartbeat_and_completion_states() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let started = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/agent-sessions"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"provider":"codex","terminal":"terminal","category":"implementation"}"#,
                ))
                .expect("build start request"),
            )
            .await
            .expect("start response");
        assert_eq!(started.status(), StatusCode::OK);
        let started = response_json(started).await;
        assert_eq!(started["status"], "running");
        let session_id = started["sessionId"].as_str().expect("session id");

        let heartbeat = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/agent-sessions/{session_id}/heartbeat"),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build heartbeat request"),
            )
            .await
            .expect("heartbeat response");
        assert_eq!(response_json(heartbeat).await["status"], "running");

        let completed = router
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/agent-sessions/{session_id}/complete"),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build completion request"),
            )
            .await
            .expect("completion response");
        assert_eq!(response_json(completed).await["status"], "completed");
    }

    #[tokio::test]
    async fn owned_agent_session_returns_live_identity_and_accepts_stop() {
        let router = app();
        let workspace_id = create_saved_workspace(&router).await;
        let launched = router
            .clone()
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/workspaces/{workspace_id}/agents/codex/sessions"),
                )
                .header(ORIGIN, policy().origin())
                .header(CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"prompt":"Implement the approved task.","category":"implementation"}"#,
                ))
                .expect("build launch request"),
            )
            .await
            .expect("launch response");
        assert_eq!(launched.status(), StatusCode::OK);
        let launched = response_json(launched).await;
        assert_eq!(launched["sessionId"], Uuid::from_u128(86).to_string());
        assert_eq!(launched["status"], "running");
        assert_eq!(launched["provider"], "codex");

        let stopped = router
            .oneshot(
                protected_request(
                    Method::POST,
                    &format!("/api/v1/agent-sessions/{}/stop", Uuid::from_u128(86)),
                )
                .header(ORIGIN, policy().origin())
                .body(Body::empty())
                .expect("build stop request"),
            )
            .await
            .expect("stop response");
        assert_eq!(stopped.status(), StatusCode::OK);
        assert_eq!(response_json(stopped).await["status"], "stopping");
    }

    #[tokio::test]
    async fn default_body_limit_returns_a_structured_error() {
        let oversized = sample_request(&"x".repeat(API_BODY_LIMIT_BYTES + 1024));
        let response = app()
            .oneshot(create_request(&oversized, TEST_KEY))
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(error_code(response).await, "payload_too_large");
    }

    #[tokio::test]
    async fn heavy_admission_rejects_bursts_before_spawning_and_preserves_other_lanes() {
        let workspace_id = Uuid::from_u128(42);
        let probe = Arc::new(BlockingProbe::default());
        let registry = Arc::new(FakeRegistry {
            verification_probe: Some(Arc::clone(&probe)),
            ..FakeRegistry::default()
        });
        registry
            .workspaces
            .lock()
            .expect("workspace test lock")
            .insert(
                workspace_id,
                FakeWorkspace {
                    workspace_id,
                    title: "Admission test".to_owned(),
                    display_name: None,
                },
            );
        registry
            .materializations
            .lock()
            .expect("materialization test lock")
            .insert(workspace_id, fake_materialization(workspace_id));

        let router = build_router_with_admission_limits(
            registry,
            policy(),
            None,
            AdmissionLimits {
                reads: 1,
                scans: 1,
                heavy: 2,
                remote: 1,
            },
        );
        let verification_uri = format!("/api/v1/workspaces/{workspace_id}/verification/run");

        let first_router = router.clone();
        let first_uri = verification_uri.clone();
        let first = tokio::spawn(async move {
            first_router
                .oneshot(empty_action_request(&first_uri))
                .await
                .expect("first verification response")
        });
        let second_router = router.clone();
        let second_uri = verification_uri.clone();
        let second = tokio::spawn(async move {
            second_router
                .oneshot(empty_action_request(&second_uri))
                .await
                .expect("second verification response")
        });

        for _ in 0..10_000 {
            if probe.active.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(
            probe.active.load(Ordering::SeqCst),
            2,
            "both heavy permits should reach the backend"
        );

        // Cancellation drops the HTTP future, but its blocking worker and
        // admission permit must remain live until the underlying work exits.
        first.abort();
        assert!(
            first
                .await
                .expect_err("first request should be cancelled")
                .is_cancelled(),
            "request task should report cancellation"
        );

        for _ in 0..20 {
            let overloaded = router
                .clone()
                .oneshot(empty_action_request(&verification_uri))
                .await
                .expect("overload response");
            assert_eq!(overloaded.status(), StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(
                overloaded.headers()[RETRY_AFTER],
                OVERLOAD_RETRY_AFTER_SECONDS
            );
            assert_eq!(error_code(overloaded).await, "operation_capacity_exhausted");
        }

        let read = router
            .clone()
            .oneshot(
                protected_request(Method::GET, &format!("/api/v1/workspaces/{workspace_id}"))
                    .body(Body::empty())
                    .expect("build read request"),
            )
            .await
            .expect("read response");
        assert_eq!(
            read.status(),
            StatusCode::OK,
            "heavy saturation must not consume read capacity"
        );

        let scan = router
            .clone()
            .oneshot(
                protected_request(
                    Method::GET,
                    &format!("/api/v1/workspaces/{workspace_id}/evidence"),
                )
                .body(Body::empty())
                .expect("build scan request"),
            )
            .await
            .expect("scan response");
        assert_eq!(
            scan.status(),
            StatusCode::OK,
            "heavy saturation must not consume scan capacity"
        );

        let remote = router
            .clone()
            .oneshot(
                protected_request(Method::GET, "/api/v1/reviews/gitlab/repo-1/17/discussions")
                    .body(Body::empty())
                    .expect("build remote read request"),
            )
            .await
            .expect("remote read response");
        assert_eq!(
            remote.status(),
            StatusCode::OK,
            "heavy saturation must not block the GitLab reads of a review view"
        );
        assert_eq!(probe.calls.load(Ordering::SeqCst), 2);
        assert_eq!(probe.peak.load(Ordering::SeqCst), 2);

        probe.release();
        assert_eq!(
            second.await.expect("second request task").status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn health_remains_available_without_registry_authority() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/health")
                    .body(Body::empty())
                    .expect("build request"),
            )
            .await
            .expect("router response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
        assert_eq!(response_json(response).await["status"], "ok");
    }
}
