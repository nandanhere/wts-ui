mod ui_capture;
mod work_item_preview;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, env, path::PathBuf, process::Command};
use tauri::Manager;
#[cfg(debug_assertions)]
use tracing::info;
#[cfg(debug_assertions)]
use tracing_subscriber::EnvFilter;
use uuid::Uuid;
use wts_app::{
    AgentProvider, AgentRunResult, AgentSession, AgentSessionCategory, AgentSessionDetail,
    AgentSessionFailure, AgentSessionList, CloneRepositoryRequest, CloneRepositoryResult,
    CodeReviewScope, CodeWorkspaceImportRequest, CodeWorkspaceImportResult,
    ConfirmWorkspaceJiraLinkRequest, ConfirmWorkspaceWorkItemLinkResult,
    CreateWorkspaceReviewThreadRequest, GitlabReviewCommentRequest, GitlabReviewPatch,
    GraphIndexResult, JiraCreateProposal, JiraIssueImport, LocalWtsError, LocalWtsService,
    MaterializeWorkspaceResult, OpenGithubReviewResult, OpenProjectWorkPackageImport,
    OpenRepositoryBaseResult, OpenWorkspaceChangeRequestDraft, OpenWorkspaceChangeRequestResult,
    OpenWorkspaceGitlabMergeRequestResult, OpenWorkspaceJiraPreviewRequest, OpenWorkspaceResult,
    OpenWorkspaceWorkItemRequest, OpenWorkspaceWorkItemResult, PrepareWorkspaceChangeRequest,
    PreviewWorkspaceJiraLinkRequest, PublishGitlabReviewCommentResult,
    PublishWorkspaceChangeRequestBranch, RefreshRepositoryBranchesRequest,
    RefreshRepositoryBranchesResult, RemoveWorkspaceResult, RepositoryCatalog,
    ResolveWorkspaceReviewThreadRequest, RuntimeAnalysisRequest, RuntimeAnalysisResult,
    TerminalProvider, TestRunList, TestRunResult, TestRunSummary, UnlinkWorkspaceWorkItemRequest,
    UpdateWorkspacePlanningDocumentRequest, WorkspaceAgentBriefResult,
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
    ActionEnvelope, BoundaryCompiler, BoundaryDraft, Capability, Effect, RepositoryPin,
    RuntimeLease, ServiceSpec, WorkspaceBoundary,
    workspace::{
        AddWorkspaceRepositoryRequest, CreateWorkspaceRequest, FollowWorkspaceAgentRequest,
        PlaceWorkspaceOnBoardRequest, RenameWorkspaceRequest, TransitionWorkspaceWorkflowRequest,
    },
};
use wts_integrations::{
    ActivityWatchDailyReview, ActivityWatchError, ActivityWatchReviewError, ActivityWatchStatus,
    GithubReviewInbox, GitlabIntegrationStatus, GitlabMergeRequestInbox, GitlabReviewInbox,
    JiraActiveIssueList, JiraMcpVerification, OpenProjectError, OpenProjectVerification,
    SetupSnapshot, TimeReviewAgentBrief,
};
use wts_store::{
    CreateWorkspaceResult, WorkspaceList, WorkspaceStoreError, WorkspaceView,
    WorkspaceWorkflowSummary,
};

mod updater;

const WORKSPACE_ROOT_ID: &str = "local-default";
const MAX_NOTIFICATION_TITLE_CHARS: usize = 160;
const MAX_NOTIFICATION_BODY_CHARS: usize = 1_024;
const MAX_NOTIFICATION_TAG_CHARS: usize = 128;

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopLifecycleEvent {
    MainWindowCloseRequested,
    ApplicationReopened,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopLifecycleAction {
    HideMainWindow,
    RestoreMainWindow,
}

#[cfg(any(target_os = "macos", test))]
fn desktop_lifecycle_action(event: DesktopLifecycleEvent) -> DesktopLifecycleAction {
    match event {
        DesktopLifecycleEvent::MainWindowCloseRequested => DesktopLifecycleAction::HideMainWindow,
        DesktopLifecycleEvent::ApplicationReopened => DesktopLifecycleAction::RestoreMainWindow,
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCommandError {
    code: &'static str,
    message: String,
    retryable: bool,
}

async fn run_blocking_command<T, F>(operation: F) -> Result<T, WorkspaceCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, WorkspaceCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| WorkspaceCommandError {
            code: "operation_interrupted",
            message: "The background operation ended before WTS received its result.".to_owned(),
            retryable: true,
        })?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    product_name: String,
    version: String,
    identifier: String,
    target_os: &'static str,
    target_arch: &'static str,
    tauri_version: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoRepositorySummary {
    name: String,
    base_ref: String,
    base_commit: String,
    relevance_basis_points: u16,
    evidence: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoRuntimeSummary {
    service_id: String,
    loopback_port: u16,
    hostname: String,
    namespace: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoCapabilitySummary {
    effect: &'static str,
    resource: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoBoundarySummary {
    issue_key: String,
    revision: u32,
    parent_digest: Option<String>,
    base_graph_digest: String,
    overlay_digest: String,
    digest: String,
    repositories: Vec<DemoRepositorySummary>,
    runtime_leases: Vec<DemoRuntimeSummary>,
    capabilities: Vec<DemoCapabilitySummary>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DemoAction {
    ReadWorkspace,
    WriteWorkspace,
    StartCheckoutApi,
    ConnectCheckoutApi,
    StartLedgerEvents,
    ConnectLedgerEvents,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DemoActionVerification {
    allowed: bool,
    decision: &'static str,
    reason: String,
    boundary_digest: String,
    effect: &'static str,
    resource: String,
}

#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    AppInfo {
        product_name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        identifier: app.config().identifier.clone(),
        target_os: std::env::consts::OS,
        target_arch: std::env::consts::ARCH,
        tauri_version: tauri::VERSION,
    }
}

#[tauri::command]
fn get_update_status(app: tauri::AppHandle) -> updater::AppUpdateStatus {
    updater::get_status(&app)
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> updater::AppUpdateStatus {
    updater::check(app).await
}

#[tauri::command]
async fn download_and_install_update(app: tauri::AppHandle) -> updater::AppUpdateStatus {
    updater::download_and_install(app).await
}

#[tauri::command]
fn relaunch_updated_app(app: tauri::AppHandle) -> updater::AppRelaunchResult {
    let accepted = updater::can_relaunch(&app);
    if accepted {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(100));
            app.request_restart();
        });
    }
    updater::AppRelaunchResult { accepted }
}

fn normalized_notification_text(
    value: &str,
    max_chars: usize,
) -> Result<String, WorkspaceCommandError> {
    if value.chars().count() > max_chars
        || value
            .chars()
            .any(|character| character.is_control() && !character.is_whitespace())
    {
        return Err(WorkspaceCommandError {
            code: "invalid_notification",
            message: "The notification text is invalid.".to_owned(),
            retryable: false,
        });
    }
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return Err(WorkspaceCommandError {
            code: "invalid_notification",
            message: "The notification text is required.".to_owned(),
            retryable: false,
        });
    }
    Ok(normalized)
}

fn apple_script_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('\"', "\\\""))
}

fn desktop_notification_script(title: &str, body: &str) -> String {
    format!(
        "display notification {} with title {}",
        apple_script_string(body),
        apple_script_string(title)
    )
}

#[tauri::command]
async fn send_desktop_notification(
    title: String,
    body: String,
    tag: String,
) -> Result<(), WorkspaceCommandError> {
    let title = normalized_notification_text(&title, MAX_NOTIFICATION_TITLE_CHARS)?;
    let body = normalized_notification_text(&body, MAX_NOTIFICATION_BODY_CHARS)?;
    let _tag = normalized_notification_text(&tag, MAX_NOTIFICATION_TAG_CHARS)?;
    run_blocking_command(move || {
        #[cfg(target_os = "macos")]
        {
            let status = Command::new("/usr/bin/osascript")
                .arg("-e")
                .arg(desktop_notification_script(&title, &body))
                .status()
                .map_err(|_| WorkspaceCommandError {
                    code: "notification_failed",
                    message: "WTS could not send the desktop notification.".to_owned(),
                    retryable: true,
                })?;
            if status.success() {
                Ok(())
            } else {
                Err(WorkspaceCommandError {
                    code: "notification_failed",
                    message: "WTS could not send the desktop notification.".to_owned(),
                    retryable: true,
                })
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (title, body);
            Err(WorkspaceCommandError {
                code: "notification_unsupported",
                message: "Desktop notifications are not available on this platform.".to_owned(),
                retryable: false,
            })
        }
    })
    .await
}

#[tauri::command]
async fn list_workspaces(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceList, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || service.list_workspaces().map_err(local_wts_command_error)).await
}

#[tauri::command]
async fn get_workspace(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceView, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_workspace(workspace_id)
            .map_err(local_wts_command_error)?
            .ok_or_else(|| WorkspaceCommandError {
                code: "workspace_not_found",
                message: "The local workspace plan was not found.".to_owned(),
                retryable: false,
            })
    })
    .await
}

#[tauri::command]
async fn rename_workspace(
    workspace_id: String,
    request: RenameWorkspaceRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceView, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .rename_workspace(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn transition_workspace_workflow(
    workspace_id: String,
    request: TransitionWorkspaceWorkflowRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceWorkflowSummary, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .transition_workspace_workflow(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn place_workspace_on_board(
    workspace_id: String,
    request: PlaceWorkspaceOnBoardRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceWorkflowSummary, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .place_workspace_on_board(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn follow_workspace_agent(
    workspace_id: String,
    request: FollowWorkspaceAgentRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceWorkflowSummary, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .follow_workspace_agent(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn list_workspace_planning_documents(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspacePlanningDocumentList, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .list_workspace_planning_documents(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn read_workspace_planning_document(
    workspace_id: String,
    document_id: WorkspacePlanningDocumentId,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspacePlanningDocument, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .read_workspace_planning_document(workspace_id, document_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn update_workspace_planning_document(
    workspace_id: String,
    document_id: WorkspacePlanningDocumentId,
    request: UpdateWorkspacePlanningDocumentRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspacePlanningDocument, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .update_workspace_planning_document(workspace_id, document_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn list_workspace_review_threads(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceReviewThreadList, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .list_workspace_review_threads(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn create_workspace_review_thread(
    workspace_id: String,
    request: CreateWorkspaceReviewThreadRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceReviewThread, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .create_workspace_review_thread(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn resolve_workspace_review_thread(
    workspace_id: String,
    thread_id: String,
    request: ResolveWorkspaceReviewThreadRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceReviewThread, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let thread_id = parse_workspace_id(&thread_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .resolve_workspace_review_thread(workspace_id, thread_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn create_workspace(
    request: CreateWorkspaceRequest,
    idempotency_key: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<CreateWorkspaceResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .create_workspace(&idempotency_key, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_setup_snapshot(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<SetupSnapshot, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || Ok(service.setup_snapshot())).await
}

#[tauri::command]
async fn get_activity_watch_status(
    endpoint: Option<String>,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<ActivityWatchStatus, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .activity_watch_status(endpoint.as_deref())
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_github_review_inbox(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<GithubReviewInbox, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .github_review_inbox()
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_github_review(
    repository_id: String,
    number: u64,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenGithubReviewResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .open_github_review(&repository_id, number)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_gitlab_review_inbox(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<GitlabReviewInbox, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .gitlab_review_inbox()
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_gitlab_review_patch(
    repository_id: String,
    iid: u64,
    commit_oid: Option<String>,
    refresh: Option<bool>,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<GitlabReviewPatch, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .gitlab_review_patch(
                &repository_id,
                iid,
                commit_oid.as_deref(),
                refresh.unwrap_or(false),
            )
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn publish_gitlab_review_comment(
    repository_id: String,
    iid: u64,
    request: GitlabReviewCommentRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<PublishGitlabReviewCommentResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .publish_gitlab_review_comment(&repository_id, iid, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_gitlab_discussions(
    repository_id: String,
    iid: u64,
    workspace_id: Option<Uuid>,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::GitlabDiscussions, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .gitlab_discussions(&repository_id, iid, workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn reply_gitlab_discussion(
    repository_id: String,
    iid: u64,
    request: wts_app::ReplyGitlabDiscussionRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::ReplyGitlabDiscussionResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .reply_gitlab_discussion(&repository_id, iid, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_gitlab_merge_requests(
    workspace_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<GitlabMergeRequestInbox, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .gitlab_merge_requests(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_gitlab_integration_status(
    workspace_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<GitlabIntegrationStatus, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .gitlab_integration_status(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_gitlab_merge_request(
    repository_id: String,
    iid: u64,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenWorkspaceGitlabMergeRequestResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .open_gitlab_merge_request(&repository_id, iid)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn prepare_gitlab_review_repository(
    repository_id: String,
    iid: u64,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<CloneRepositoryResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .prepare_gitlab_review_repository(&repository_id, iid)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_activity_watch_daily_review(
    started_at_unix_ms: i64,
    ended_at_unix_ms: i64,
    endpoint: Option<String>,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<ActivityWatchDailyReview, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .activity_watch_daily_review(started_at_unix_ms, ended_at_unix_ms, endpoint.as_deref())
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_activity_watch_time_review_brief(
    started_at_unix_ms: i64,
    ended_at_unix_ms: i64,
    endpoint: Option<String>,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<TimeReviewAgentBrief, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .activity_watch_time_review_brief(
                started_at_unix_ms,
                ended_at_unix_ms,
                endpoint.as_deref(),
            )
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn list_repositories(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<RepositoryCatalog, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .repository_catalog()
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn clone_repository(
    request: CloneRepositoryRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<CloneRepositoryResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .clone_repository(request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn refresh_repository_branches(
    request: RefreshRepositoryBranchesRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<RefreshRepositoryBranchesResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .refresh_repository_branches(request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn analyze_workspace_runtime(
    request: RuntimeAnalysisRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<RuntimeAnalysisResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .analyze_workspace_runtime(request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn preflight_workspace(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspacePreflight, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .preflight_workspace(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

fn recover_workspace_setup_command(
    service: &LocalWtsService,
    workspace_id: &str,
    effect_digest: &str,
) -> Result<WorkspacePreflight, WorkspaceCommandError> {
    if !effect_digest.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    }) {
        return Err(WorkspaceCommandError {
            code: "invalid_request",
            message: "Use the current setup recovery review, then try again.".to_owned(),
            retryable: false,
        });
    }
    let workspace_id = parse_workspace_id(workspace_id)?;
    service
        .recover_workspace_setup(workspace_id, effect_digest)
        .map_err(local_wts_command_error)
}

#[tauri::command]
async fn recover_workspace_setup(
    workspace_id: String,
    effect_digest: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspacePreflight, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        recover_workspace_setup_command(&service, &workspace_id, &effect_digest)
    })
    .await
}

#[tauri::command]
async fn get_workspace_materialization(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<Option<WorkspaceMaterialization>, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_materialization(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_workspace_repository_diff(
    workspace_id: String,
    repository_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRepositoryDiff, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .workspace_repository_diff(workspace_id, &repository_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_workspace_repository_file_review(
    workspace_id: String,
    repository_id: String,
    file_path: String,
    expected_patch_sha256: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRepositoryFileReview, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .workspace_repository_file_review(
                workspace_id,
                &repository_id,
                &file_path,
                &expected_patch_sha256,
            )
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_workspace_gitlab_comparison(
    workspace_id: String,
    repository_id: String,
    iid: u64,
    refresh: Option<bool>,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::WorkspaceGitlabComparison, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .workspace_gitlab_comparison(
                workspace_id,
                &repository_id,
                iid,
                refresh.unwrap_or(false),
            )
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_workspace_repository_source(
    workspace_id: String,
    repository_id: String,
    file_path: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::WorkspaceRepositorySource, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .workspace_repository_source(workspace_id, &repository_id, &file_path)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn save_workspace_repository_source(
    workspace_id: String,
    repository_id: String,
    request: wts_app::WorkspaceRepositorySourceSaveRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::WorkspaceRepositorySource, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .save_workspace_repository_source(workspace_id, &repository_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_workspace_repository_review_graph(
    workspace_id: String,
    repository_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<Option<WorkspaceRepositoryReviewGraph>, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .workspace_repository_review_graph(workspace_id, &repository_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn sync_workspace_repository(
    workspace_id: String,
    repository_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRepositorySyncResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .sync_workspace_repository(workspace_id, &repository_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn preflight_workspace_repository_addition(
    workspace_id: String,
    request: AddWorkspaceRepositoryRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRepositoryAdditionPreflight, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .preflight_workspace_repository_addition(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn add_workspace_repository(
    workspace_id: String,
    request: AddWorkspaceRepositoryRequest,
    effect_digest: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRepositoryAdditionResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .add_workspace_repository(workspace_id, request, &effect_digest)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn remove_workspace_repository(
    workspace_id: String,
    repository_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRepositoryRemovalResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .remove_workspace_repository(workspace_id, &repository_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn preflight_workspace_repository_alignment(
    workspace_id: String,
    repository_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRepositoryAlignmentPreflight, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .preflight_workspace_repository_alignment(workspace_id, &repository_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn align_workspace_repository(
    workspace_id: String,
    repository_id: String,
    effect_digest: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRepositoryAlignmentResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .align_workspace_repository(workspace_id, &repository_id, &effect_digest)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn materialize_workspace(
    workspace_id: String,
    effect_digest: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<MaterializeWorkspaceResult, WorkspaceCommandError> {
    if effect_digest.trim().is_empty() {
        return Err(WorkspaceCommandError {
            code: "invalid_request",
            message: "A preflight effect digest is required.".to_owned(),
            retryable: false,
        });
    }
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let effect_digest = effect_digest.trim().to_owned();
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .materialize_workspace(workspace_id, &effect_digest)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_workspace_in_vscode(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenWorkspaceResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .open_workspace_in_vscode(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_workspace_cli(
    workspace_id: String,
    provider: AgentProvider,
    terminal: TerminalProvider,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceCliLaunchResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .open_workspace_cli(workspace_id, provider, terminal)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn write_workspace_agent_brief(
    workspace_id: String,
    task_markdown: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceAgentBriefResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .write_workspace_agent_brief(workspace_id, &task_markdown)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_agent_work_item_preview(
    work_set_id: Uuid,
    task_id: Uuid,
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentWorkItemPreview, WorkspaceCommandError> {
    let service = state.inner().clone();
    let preview_service = service.clone();
    let preview = run_blocking_command(move || {
        preview_service
            .start_agent_work_item_preview(work_set_id, task_id)
            .map_err(local_wts_command_error)
    })
    .await?;
    work_item_preview::show_preview(&app, service, preview)
}

#[tauri::command]
async fn create_agent_work_set(
    conversation_id: Uuid,
    turn_request_id: Uuid,
    request: wts_app::CreateAgentWorkSetRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentWorkSet, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .create_agent_work_set(conversation_id, turn_request_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn list_agent_work_sets(
    conversation_id: Uuid,
    request_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentWorkSetList, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .list_agent_work_sets(conversation_id, request_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_agent_work_set(
    work_set_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentWorkSet, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_agent_work_set(work_set_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn cancel_agent_work_item(
    work_set_id: Uuid,
    task_id: Uuid,
    request: wts_app::AgentWorkItemCancelRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentWorkSet, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .cancel_agent_work_item(work_set_id, task_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn preflight_agent_work_item_integration(
    work_set_id: Uuid,
    task_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentWorkItemIntegrationPreflight, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .preflight_agent_work_item_integration(work_set_id, task_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn integrate_agent_work_item(
    work_set_id: Uuid,
    task_id: Uuid,
    request: wts_app::IntegrateAgentWorkItemRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentWorkItemIntegrationResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .integrate_agent_work_item(work_set_id, task_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn create_agent_conversation(
    request: wts_app::CreateAgentConversationRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentConversation, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .create_agent_conversation(request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn list_agent_conversations(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentConversationList, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .list_agent_conversations()
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_agent_conversation(
    conversation_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentConversation, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_agent_conversation(conversation_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_agent_turn_changes(
    conversation_id: Uuid,
    request_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentTurnChanges, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_agent_turn_changes(conversation_id, request_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_agent_turn_decisions(
    conversation_id: Uuid,
    request_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentTurnDecisions, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_agent_turn_decisions(conversation_id, request_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn record_agent_turn_decision(
    conversation_id: Uuid,
    turn_request_id: Uuid,
    request: wts_app::RecordAgentTurnDecisionRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentTurnDecisions, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .record_agent_turn_decision(conversation_id, turn_request_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_agent_turn_checks(
    conversation_id: Uuid,
    request_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentTurnChecks, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_agent_turn_checks(conversation_id, request_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn run_agent_turn_check(
    conversation_id: Uuid,
    turn_request_id: Uuid,
    request: wts_app::RunAgentTurnCheckRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentTurnChecks, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .run_agent_turn_check(conversation_id, turn_request_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn preflight_agent_turn_restore(
    conversation_id: Uuid,
    request_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentTurnRestorePreflight, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .preflight_agent_turn_restore(conversation_id, request_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn restore_agent_turn(
    conversation_id: Uuid,
    turn_request_id: Uuid,
    request: wts_app::AgentTurnRestoreRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentTurnRestoreResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .restore_agent_turn(conversation_id, turn_request_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn send_agent_conversation_message(
    conversation_id: Uuid,
    request: wts_app::SendAgentConversationMessageRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentConversation, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .send_agent_conversation_message(conversation_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn update_agent_conversation_message(
    conversation_id: Uuid,
    message_id: Uuid,
    request: wts_app::UpdateAgentConversationMessageRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentConversation, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .update_agent_conversation_message(conversation_id, message_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn cancel_agent_conversation_message(
    conversation_id: Uuid,
    message_id: Uuid,
    request: wts_app::CancelAgentConversationMessageRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<wts_app::AgentConversation, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .cancel_agent_conversation_message(conversation_id, message_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn list_agent_sessions(
    workspace_id: Option<String>,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentSessionList, WorkspaceCommandError> {
    let workspace_id = workspace_id
        .as_deref()
        .map(parse_workspace_id)
        .transpose()?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .list_agent_sessions(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_agent_session_detail(
    session_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentSessionDetail, WorkspaceCommandError> {
    let session_id = parse_workspace_id(&session_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_agent_session_detail(session_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn start_agent_session(
    workspace_id: String,
    provider: AgentProvider,
    terminal: TerminalProvider,
    category: AgentSessionCategory,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentSession, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .start_agent_session(workspace_id, provider, terminal, category)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn heartbeat_agent_session(
    session_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentSession, WorkspaceCommandError> {
    let session_id = parse_workspace_id(&session_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .heartbeat_agent_session(session_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn finish_agent_session(
    session_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentSession, WorkspaceCommandError> {
    let session_id = parse_workspace_id(&session_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .finish_agent_session(session_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn fail_agent_session(
    session_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentSession, WorkspaceCommandError> {
    let session_id = parse_workspace_id(&session_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .fail_agent_session(session_id, AgentSessionFailure::ProviderFailed)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn launch_agent_session(
    workspace_id: String,
    provider: AgentProvider,
    prompt: String,
    category: AgentSessionCategory,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentSession, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .launch_agent_session(workspace_id, provider, &prompt, category)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn stop_agent_session(
    session_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentSession, WorkspaceCommandError> {
    let session_id = parse_workspace_id(&session_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .stop_agent_session(session_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_repository_base(
    repository_id: String,
    base_ref: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenRepositoryBaseResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .open_repository_base(&repository_id, &base_ref)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn prepare_workspace_change_request(
    workspace_id: String,
    request: PrepareWorkspaceChangeRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceChangeRequestDraft, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .prepare_workspace_change_request(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn publish_workspace_change_request_branch(
    workspace_id: String,
    request: PublishWorkspaceChangeRequestBranch,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceBranchPublicationResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .publish_workspace_change_request_branch(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_workspace_change_request_draft(
    workspace_id: String,
    request: OpenWorkspaceChangeRequestDraft,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenWorkspaceChangeRequestResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .open_workspace_change_request_draft(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn index_workspace_graph(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<GraphIndexResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .index_workspace_graph(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn reindex_workspace_graph(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<GraphIndexResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .reindex_workspace_graph(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn preflight_workspace_removal(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceRemovalPreflight, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .preflight_workspace_removal(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn remove_workspace(
    workspace_id: String,
    effect_digest: String,
    idempotency_key: String,
    delete_protected_paths: bool,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<RemoveWorkspaceResult, WorkspaceCommandError> {
    if effect_digest.trim().is_empty() {
        return Err(WorkspaceCommandError {
            code: "invalid_request",
            message: "A removal preflight effect digest is required.".to_owned(),
            retryable: false,
        });
    }
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let effect_digest = effect_digest.trim().to_owned();
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .remove_workspace(
                workspace_id,
                &effect_digest,
                &idempotency_key,
                delete_protected_paths,
            )
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn run_workspace_agent(
    workspace_id: String,
    provider: AgentProvider,
    prompt: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<AgentRunResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .run_agent(workspace_id, provider, &prompt)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn run_workspace_code_review(
    workspace_id: String,
    provider: AgentProvider,
    scope: CodeReviewScope,
    model: Option<String>,
    agent: Option<String>,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceCodeReviewResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    let selected_model = model.or(agent);
    run_blocking_command(move || {
        service
            .run_workspace_code_review(workspace_id, provider, scope, selected_model.as_deref())
            .map_err(local_wts_command_error)
    })
    .await
}

fn get_workspace_verification_summary_command(
    service: &LocalWtsService,
    workspace_id: &str,
) -> Result<Option<WorkspaceVerificationSummary>, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(workspace_id)?;
    service.get_workspace_verification_summary(workspace_id).map_err(local_wts_command_error)
}

#[tauri::command]
async fn get_workspace_verification_summary(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<Option<WorkspaceVerificationSummary>, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || get_workspace_verification_summary_command(&service, &workspace_id)).await
}

#[tauri::command]
async fn get_workspace_evidence(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<Option<WorkspaceEvidence>, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_workspace_evidence(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn run_workspace_verification(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceEvidence, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .run_workspace_verification(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn run_workspace_verification_check(
    workspace_id: String,
    check_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceEvidence, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .run_workspace_verification_check(workspace_id, &check_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn rerun_failed_workspace_verification(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceEvidence, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .rerun_failed_workspace_verification(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn cancel_workspace_verification(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceEvidence, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .cancel_workspace_verification(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn promote_agent_verification_check(
    workspace_id: String,
    proposal_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceEvidence, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .promote_agent_verification_check(workspace_id, &proposal_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn list_workspace_test_runs(
    workspace_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<TestRunList, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .list_workspace_test_runs(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn get_workspace_test_run(
    workspace_id: String,
    run_id: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<TestRunResult, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let run_id = parse_test_run_id(&run_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .get_workspace_test_run(workspace_id, run_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunWorkspaceTestJourneyRequest {
    journey_id: String,
    base_url: String,
}

#[tauri::command]
async fn run_workspace_test_journey(
    workspace_id: String,
    request: RunWorkspaceTestJourneyRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<TestRunSummary, WorkspaceCommandError> {
    let workspace_id = parse_workspace_id(&workspace_id)?;
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .run_workspace_test_journey(workspace_id, &request.journey_id, &request.base_url)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn verify_jira_mcp(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<JiraMcpVerification, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || service.verify_jira_mcp().map_err(local_wts_command_error)).await
}

#[tauri::command]
async fn list_active_jira_issues(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<JiraActiveIssueList, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .active_jira_issues()
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn import_jira_issue(
    issue_key: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<JiraIssueImport, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .import_jira_issue(&issue_key)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn preview_workspace_jira_link(
    workspace_id: Uuid,
    request: PreviewWorkspaceJiraLinkRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceWorkItemLinkPreview, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .preview_workspace_jira_link(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn confirm_workspace_jira_link(
    workspace_id: Uuid,
    request: ConfirmWorkspaceJiraLinkRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<ConfirmWorkspaceWorkItemLinkResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .confirm_workspace_jira_link(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_workspace_jira_preview(
    workspace_id: Uuid,
    request: OpenWorkspaceJiraPreviewRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenWorkspaceWorkItemResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .open_workspace_jira_preview(workspace_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn list_workspace_work_item_links(
    workspace_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceWorkItemLinkList, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .list_workspace_work_item_links(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn unlink_workspace_work_item(
    workspace_id: Uuid,
    link_id: Uuid,
    request: UnlinkWorkspaceWorkItemRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<WorkspaceWorkItemUnlinkResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .unlink_workspace_work_item(workspace_id, link_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn open_workspace_work_item(
    workspace_id: Uuid,
    link_id: Uuid,
    request: OpenWorkspaceWorkItemRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenWorkspaceWorkItemResult, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .open_workspace_work_item(workspace_id, link_id, request)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn propose_workspace_jira_issue(
    workspace_id: Uuid,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<JiraCreateProposal, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .propose_workspace_jira_issue(workspace_id)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn import_code_workspace_file(
    mut request: CodeWorkspaceImportRequest,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<CodeWorkspaceImportResult, WorkspaceCommandError> {
    let import_id = Uuid::new_v4();
    request.assign_import_id(import_id);
    #[cfg(debug_assertions)]
    info!(
        target: "wts_desktop::code_workspace_import",
        %import_id,
        file_name = ?bounded_development_log_text(&request.file_name, 255),
        content_bytes = request.contents.len(),
        "code_workspace_import.begin"
    );

    let service = state.inner().clone();
    let result = run_blocking_command(move || {
        service
            .import_code_workspace_file(request)
            .map_err(local_wts_command_error)
    })
    .await;

    #[cfg(debug_assertions)]
    match &result {
        Ok(imported) => log_development_code_workspace_import(imported),
        Err(error) => info!(
            target: "wts_desktop::code_workspace_import",
            %import_id,
            success = false,
            error_code = error.code,
            retryable = error.retryable,
            "code_workspace_import.end"
        ),
    }

    result
}

#[cfg(debug_assertions)]
fn log_development_code_workspace_import(imported: &CodeWorkspaceImportResult) {
    let import_id = imported.import_id;
    if let Some(diagnostics) = imported.diagnostics.as_ref() {
        let catalog_repositories = diagnostics
            .catalog
            .repositories
            .iter()
            .take(16)
            .map(|repository| {
                format!(
                    "{} @ {}",
                    bounded_development_log_text(&repository.label, 255),
                    bounded_development_log_text(&repository.display_path, 4096)
                )
            })
            .collect::<Vec<_>>();
        info!(
            target: "wts_desktop::code_workspace_import",
            %import_id,
            repository_root = ?bounded_development_log_text(
                &diagnostics.catalog.repository_root_display_path,
                4096
            ),
            repository_count = diagnostics.catalog.repository_count,
            skipped_entries = diagnostics.catalog.skipped_entries,
            repositories = ?catalog_repositories,
            repositories_truncated = diagnostics.catalog.repositories_truncated,
            "code_workspace_import.catalog"
        );

        for diagnostic in diagnostics.folders.iter().take(32) {
            let source_folder = usize::try_from(diagnostic.folder_index)
                .ok()
                .and_then(|index| imported.folders.get(index));
            let attempts = diagnostic
                .attempts
                .iter()
                .take(3)
                .map(|attempt| {
                    format!(
                        "{:?}={} (candidates={})",
                        attempt.basis,
                        bounded_development_log_text(&attempt.value, 4096),
                        attempt.candidate_count
                    )
                })
                .collect::<Vec<_>>();
            let candidates = diagnostic
                .candidates
                .iter()
                .take(8)
                .map(|candidate| {
                    format!(
                        "{} @ {}",
                        bounded_development_log_text(&candidate.label, 255),
                        bounded_development_log_text(&candidate.display_path, 4096)
                    )
                })
                .collect::<Vec<_>>();
            info!(
                target: "wts_desktop::code_workspace_import",
                %import_id,
                folder_index = diagnostic.folder_index,
                folder_name = ?source_folder
                    .map(|folder| bounded_development_log_text(&folder.name, 255))
                    .unwrap_or_default(),
                raw_path = ?source_folder
                    .map(|folder| bounded_development_log_text(&folder.raw_path, 4096))
                    .unwrap_or_default(),
                status = ?diagnostic.status,
                reason = ?diagnostic.reason,
                resolution_basis = ?diagnostic.resolution_basis,
                attempts = ?attempts,
                candidates = ?candidates,
                candidates_truncated = diagnostic.candidates_truncated,
                duplicate_repository = diagnostic.duplicate_repository,
                "code_workspace_import.folder"
            );
        }
    }

    let matched_count = imported
        .folders
        .iter()
        .filter(|folder| folder.status == wts_app::CodeWorkspaceFolderStatus::Matched)
        .count();
    let missing_count = imported
        .folders
        .iter()
        .filter(|folder| folder.status == wts_app::CodeWorkspaceFolderStatus::Missing)
        .count();
    let ambiguous_count = imported
        .folders
        .iter()
        .filter(|folder| folder.status == wts_app::CodeWorkspaceFolderStatus::Ambiguous)
        .count();
    let unsupported_count = imported
        .folders
        .iter()
        .filter(|folder| folder.status == wts_app::CodeWorkspaceFolderStatus::Unsupported)
        .count();
    info!(
        target: "wts_desktop::code_workspace_import",
        %import_id,
        success = true,
        diagnostics_available = imported.diagnostics.is_some(),
        folder_count = imported.folders.len(),
        matched_count,
        missing_count,
        ambiguous_count,
        unsupported_count,
        "code_workspace_import.end"
    );
}

#[cfg(debug_assertions)]
fn bounded_development_log_text(value: &str, maximum_chars: usize) -> String {
    if is_uri_shaped_development_value(value) {
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
fn is_uri_shaped_development_value(value: &str) -> bool {
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

#[tauri::command]
async fn verify_open_project(
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenProjectVerification, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .verify_open_project()
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
async fn import_open_project_work_package(
    reference: String,
    state: tauri::State<'_, LocalWtsService>,
) -> Result<OpenProjectWorkPackageImport, WorkspaceCommandError> {
    let service = state.inner().clone();
    run_blocking_command(move || {
        service
            .import_open_project_work_package(&reference)
            .map_err(local_wts_command_error)
    })
    .await
}

#[tauri::command]
fn get_demo_boundary() -> Result<DemoBoundarySummary, String> {
    demo_boundary().map(DemoBoundarySummary::from)
}

/// Verify one of a closed set of demonstrations against a freshly compiled
/// boundary. The frontend cannot pass an arbitrary resource or filesystem path.
#[tauri::command]
fn verify_demo_action(
    boundary_digest: String,
    action: DemoAction,
) -> Result<DemoActionVerification, String> {
    let boundary = demo_boundary()?;
    let (effect, resource) = demo_action_resource(action, &boundary);
    let envelope = ActionEnvelope {
        boundary_digest,
        effect: effect.clone(),
        resource: resource.clone(),
    };

    let (allowed, decision, reason) = match boundary.verify(&envelope) {
        Ok(()) => (
            true,
            "allow",
            "The action matches the active boundary digest and an approved capability.".to_owned(),
        ),
        Err(error) => (false, "deny", error.to_string()),
    };

    Ok(DemoActionVerification {
        allowed,
        decision,
        reason,
        boundary_digest: boundary.digest,
        effect: effect_name(&effect),
        resource,
    })
}

fn demo_boundary() -> Result<WorkspaceBoundary, String> {
    let draft = BoundaryDraft {
        issue_key: "PLATFORM-42".to_owned(),
        base_graph_digest: "sha256:base-graph-demo-42".to_owned(),
        repositories: vec![
            RepositoryPin {
                name: "checkout-api".to_owned(),
                base_ref: "main".to_owned(),
                base_commit: "44f62aeff9f9bd24ee0064f72753bb8173ac3481".to_owned(),
                relevance_basis_points: 9_600,
                evidence: vec![
                    "ticket component: checkout".to_owned(),
                    "graph path: payment submission".to_owned(),
                ],
            },
            RepositoryPin {
                name: "ledger-events".to_owned(),
                base_ref: "main".to_owned(),
                base_commit: "8ef1b886dd6c596246fa95240b2825ddf84cf89f".to_owned(),
                relevance_basis_points: 8_700,
                evidence: vec![
                    "runtime edge: checkout-api -> ledger-events".to_owned(),
                    "ticket label: payment-event".to_owned(),
                ],
            },
            RepositoryPin {
                name: "payments-sdk".to_owned(),
                base_ref: "main".to_owned(),
                base_commit: "cb1f8a21966bc4e2f8273676238389118843c4be".to_owned(),
                relevance_basis_points: 9_100,
                evidence: vec![
                    "contract edge: idempotency key".to_owned(),
                    "compatible integration run".to_owned(),
                ],
            },
        ],
        services: vec![
            ServiceSpec {
                id: "checkout-api".to_owned(),
                repository: "checkout-api".to_owned(),
                default_port: 9_000,
                depends_on: Vec::new(),
            },
            ServiceSpec {
                id: "ledger-events".to_owned(),
                repository: "ledger-events".to_owned(),
                default_port: 9_100,
                depends_on: vec!["checkout-api".to_owned()],
            },
        ],
    };

    // Reserve the conventional ports to make the isolated remapping visible in
    // the demo without inspecting or touching the user's actual processes.
    let occupied = BTreeSet::from([9_000, 9_100]);
    let revision_one =
        BoundaryCompiler::compile(draft.clone(), &occupied).map_err(|error| error.to_string())?;
    let revision_two = revision_one
        .revise(draft.clone(), &occupied)
        .map_err(|error| error.to_string())?;
    revision_two
        .revise(draft, &occupied)
        .map_err(|error| error.to_string())
}

fn demo_action_resource(action: DemoAction, boundary: &WorkspaceBoundary) -> (Effect, String) {
    match action {
        DemoAction::ReadWorkspace => (Effect::Read, format!("workspace:{}/**", boundary.issue_key)),
        DemoAction::WriteWorkspace => (
            Effect::Write,
            format!("workspace:{}/**", boundary.issue_key),
        ),
        DemoAction::StartCheckoutApi => (Effect::Execute, "process:checkout-api".to_owned()),
        DemoAction::ConnectCheckoutApi => (
            Effect::Network,
            lease_resource(&boundary.runtime_leases, "checkout-api"),
        ),
        DemoAction::StartLedgerEvents => (Effect::Execute, "process:ledger-events".to_owned()),
        DemoAction::ConnectLedgerEvents => (
            Effect::Network,
            lease_resource(&boundary.runtime_leases, "ledger-events"),
        ),
    }
}

fn lease_resource(leases: &[RuntimeLease], service_id: &str) -> String {
    let port = leases
        .iter()
        .find(|lease| lease.service_id == service_id)
        .map(|lease| lease.loopback_port)
        .expect("the fixed demo service must have a runtime lease");
    format!("loopback:{port}")
}

fn effect_name(effect: &Effect) -> &'static str {
    match effect {
        Effect::Read => "read",
        Effect::Write => "write",
        Effect::Execute => "execute",
        Effect::Network => "network",
    }
}

impl From<WorkspaceBoundary> for DemoBoundarySummary {
    fn from(boundary: WorkspaceBoundary) -> Self {
        Self {
            issue_key: boundary.issue_key,
            revision: boundary.revision,
            parent_digest: boundary.parent_digest,
            base_graph_digest: boundary.base_graph_digest,
            overlay_digest: boundary.overlay_digest,
            digest: boundary.digest,
            repositories: boundary
                .repositories
                .into_iter()
                .map(DemoRepositorySummary::from)
                .collect(),
            runtime_leases: boundary
                .runtime_leases
                .into_iter()
                .map(DemoRuntimeSummary::from)
                .collect(),
            capabilities: boundary
                .capabilities
                .into_iter()
                .map(DemoCapabilitySummary::from)
                .collect(),
        }
    }
}

impl From<RepositoryPin> for DemoRepositorySummary {
    fn from(repository: RepositoryPin) -> Self {
        Self {
            name: repository.name,
            base_ref: repository.base_ref,
            base_commit: repository.base_commit,
            relevance_basis_points: repository.relevance_basis_points,
            evidence: repository.evidence,
        }
    }
}

impl From<RuntimeLease> for DemoRuntimeSummary {
    fn from(lease: RuntimeLease) -> Self {
        Self {
            service_id: lease.service_id,
            loopback_port: lease.loopback_port,
            hostname: lease.hostname,
            namespace: lease.namespace,
        }
    }
}

impl From<Capability> for DemoCapabilitySummary {
    fn from(capability: Capability) -> Self {
        Self {
            effect: effect_name(&capability.effect),
            resource: capability.resource,
        }
    }
}

fn local_wts_service(app: &tauri::AppHandle) -> Result<LocalWtsService, LocalWtsError> {
    let data_dir = env::var_os("WTS_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            app.path()
                .app_local_data_dir()
                .expect("the desktop platform must provide an app-local data directory")
        });
    let workspace_root = env::var_os("WTS_WORKSPACE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            app.path()
                .home_dir()
                .expect("the desktop platform must provide a home directory")
                .join("cd")
        });
    let repository_roots =
        match env::var_os("WTS_REPOSITORY_ROOTS").filter(|value| !value.is_empty()) {
            Some(value) => env::split_paths(&value).collect(),
            None => vec![
                env::var_os("WTS_REPOSITORY_ROOT")
                    .filter(|value| !value.is_empty())
                    .map(PathBuf::from)
                    .unwrap_or_else(|| workspace_root.clone()),
            ],
        };
    let service = LocalWtsService::open_with_repository_roots(
        data_dir,
        WORKSPACE_ROOT_ID,
        workspace_root,
        repository_roots,
    )?;
    if let Some(source) = env::var_os("WTS_UI_REPOSITORY_ROOT").map(PathBuf::from) {
        let _ = service.configure_ui_development_repository(source, None);
    } else if cfg!(debug_assertions) {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("desktop source repository")
            .to_owned();
        let preview = app.config().build.dev_url.as_ref().map(ToString::to_string);
        let _ = service.configure_ui_development_repository(source, preview);
    }
    Ok(service)
}

fn parse_workspace_id(value: &str) -> Result<Uuid, WorkspaceCommandError> {
    Uuid::parse_str(value.trim()).map_err(|_| WorkspaceCommandError {
        code: "invalid_request",
        message: "The workspace ID is invalid.".to_owned(),
        retryable: false,
    })
}

fn parse_test_run_id(value: &str) -> Result<Uuid, WorkspaceCommandError> {
    Uuid::parse_str(value.trim()).map_err(|_| WorkspaceCommandError {
        code: "invalid_request",
        message: "The browser test-run ID is invalid.".to_owned(),
        retryable: false,
    })
}

fn local_wts_command_error(error: LocalWtsError) -> WorkspaceCommandError {
    match error {
        LocalWtsError::InvalidAgentConversation => WorkspaceCommandError { code: "invalid_agent_conversation", message: "The agent conversation request is invalid.".to_owned(), retryable: false },
        LocalWtsError::AgentConversationNotFound => WorkspaceCommandError { code: "agent_conversation_not_found", message: "The agent conversation was not found.".to_owned(), retryable: false },
        LocalWtsError::AgentConversationConflict => WorkspaceCommandError { code: "agent_conversation_conflict", message: "The request changed or has started. Reload the conversation before you retry.".to_owned(), retryable: false },
        LocalWtsError::AgentConversationQueueFull => WorkspaceCommandError { code: "agent_conversation_queue_full", message: "This workspace has 64 queued requests. Wait for a request to finish or cancel a queued request.".to_owned(), retryable: true },
        LocalWtsError::AgentConversationBusy => WorkspaceCommandError { code: "agent_conversation_busy", message: "Another WTS task is active in this workspace. Wait for it to finish, then retry.".to_owned(), retryable: true },
        LocalWtsError::AgentConversationPlatformUnavailable => WorkspaceCommandError { code: "agent_conversation_platform_unavailable", message: "Agent chat execution needs macOS or Linux. Saved chats remain available.".to_owned(), retryable: false },
        LocalWtsError::AgentConversationStorageFull => WorkspaceCommandError { code: "agent_conversation_storage_full", message: "Conversation storage is full. Open an existing conversation to continue.".to_owned(), retryable: false },
        LocalWtsError::AgentConversationLimit => WorkspaceCommandError { code: "agent_conversation_limit", message: "This conversation reached its limit. Start a new conversation to continue.".to_owned(), retryable: false },
        LocalWtsError::AgentConversationSourceUnavailable => WorkspaceCommandError { code: "agent_conversation_source_unavailable", message: "WTS needs its source repository. Start WTS with WTS_UI_REPOSITORY_ROOT set to the source checkout.".to_owned(), retryable: true },
        LocalWtsError::AgentConversationUnavailable => WorkspaceCommandError { code: "agent_conversation_unavailable", message: "The conversation or its workspace is unavailable. Check the workspace and try again.".to_owned(), retryable: true },
        LocalWtsError::InvalidRepositoryRoot => WorkspaceCommandError {
            code: "invalid_local_configuration",
            message: "The configured WTS repository root is invalid.".to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryCatalogUnavailable => WorkspaceCommandError {
            code: "repository_catalog_unavailable",
            message: "The local repository catalog is temporarily unavailable.".to_owned(),
            retryable: true,
        },
        LocalWtsError::RepositoryNotFound => WorkspaceCommandError {
            code: "repository_not_found",
            message: "The selected local repository is no longer in the WTS catalog.".to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidRepositoryFilePath => WorkspaceCommandError {
            code: "invalid_repository_file_path",
            message: "Choose a file inside the selected repository.".to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryFileUnavailable => WorkspaceCommandError {
            code: "repository_file_unavailable",
            message: "The selected repository file is not available as a regular local file."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryFileNotText => WorkspaceCommandError {
            code: "repository_file_not_text",
            message: "WTS can show the complete file only when it contains UTF-8 text."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryFileTooLarge => WorkspaceCommandError {
            code: "repository_file_too_large",
            message: "The selected repository file exceeds the complete-file limit.".to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryFileConflict => WorkspaceCommandError {code:"repository_file_conflict",message:"The source file changed. Reload the file before you save.".to_owned(),retryable:false},
        LocalWtsError::InvalidRepositoryFileRevision => WorkspaceCommandError {code:"invalid_repository_file_revision",message:"The source file revision is invalid.".to_owned(),retryable:false},
        LocalWtsError::GitlabComparisonUnavailable => WorkspaceCommandError {code:"gitlab_comparison_unavailable",message:"WTS could not load the merge request comparison. Refresh the merge request and check the local branch.".to_owned(),retryable:true},
        LocalWtsError::InvalidRepositoryRemote => WorkspaceCommandError {
            code: "invalid_repository_remote",
            message: "Enter a supported HTTPS or SSH Git repository URL without embedded credentials."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryCloneConflict => WorkspaceCommandError {
            code: "repository_clone_conflict",
            message:
                "A different local folder already uses the repository name derived from this URL."
                    .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryCloneBranchUnavailable => WorkspaceCommandError {
            code: "repository_clone_branch_unavailable",
            message: "The requested branch is not available locally. Refresh the repository branches, or select an available branch.".to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryCloneFailed => WorkspaceCommandError {
            code: "repository_clone_failed",
            message:
                "Git could not clone the repository. Check the URL, network, SSH agent, or credential helper and retry."
                    .to_owned(),
            retryable: true,
        },
        LocalWtsError::RepositoryFetchFailed => WorkspaceCommandError {
            code: "repository_fetch_failed",
            message:
                "Git could not refresh branches. Check the network, SSH agent, or credential helper and retry."
                    .to_owned(),
            retryable: true,
        },
        LocalWtsError::RepositoryChanged => WorkspaceCommandError {
            code: "repository_changed",
            message: "The selected local repository changed after it was cataloged.".to_owned(),
            retryable: true,
        },
        LocalWtsError::InvalidRepositoryBase => WorkspaceCommandError {
            code: "invalid_repository_base",
            message: "Choose a valid local branch as the repository base.".to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryBaseNotFound => WorkspaceCommandError {
            code: "repository_base_not_found",
            message: "The selected repository base is not available in the local checkout."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::RepositoryForgeUnsupported => WorkspaceCommandError {
            code: "repository_forge_unsupported",
            message: "The repository does not have a supported GitHub or GitLab origin.".to_owned(),
            retryable: false,
        },
        LocalWtsError::GitlabReviewCommentFailed => WorkspaceCommandError {
            code: "gitlab_review_comment_failed",
            message: "GitLab did not accept this comment. Refresh the merge request changes, then retry on a current changed line.".to_owned(),
            retryable: true,
        },
        LocalWtsError::GitlabDiscussionsUnavailable => WorkspaceCommandError {
            code: "gitlab_discussions_unavailable",
            message: "WTS could not load the GitLab discussions. Check the connection and GitLab account.".to_owned(),
            retryable: true,
        },
        LocalWtsError::GitlabDiscussionReplyFailed => WorkspaceCommandError {
            code: "gitlab_discussion_reply_failed",
            message: "WTS could not confirm the reply. Refresh the discussion before you try again.".to_owned(),
            retryable: false,
        },
        LocalWtsError::BrowserUnavailable => WorkspaceCommandError {
            code: "browser_unavailable",
            message: "The system browser launcher is unavailable.".to_owned(),
            retryable: false,
        },
        LocalWtsError::BrowserLaunchRejected => WorkspaceCommandError {
            code: "browser_launch_rejected",
            message: "The system browser did not accept the launch.".to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestBranchNotPublished => WorkspaceCommandError {
            code: "change_request_branch_not_published",
            message: "Publish this branch and set its upstream before you prepare a change request."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestBranchPublishFailed => WorkspaceCommandError {
            code: "change_request_branch_publish_failed",
            message: "Git rejected the publish operation for an unknown reason. Open the workspace and run Git push to see the diagnostic."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::InvalidChangeRequestBranchName => WorkspaceCommandError {
            code: "invalid_change_request_branch_name",
            message: "Enter a valid Git branch name and retry.".to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestBranchAuthenticationFailed => WorkspaceCommandError {
            code: "change_request_branch_authentication_failed",
            message: "Git authentication failed. Unlock the SSH key or credential helper, then retry."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestBranchNetworkFailed => WorkspaceCommandError {
            code: "change_request_branch_network_failed",
            message: "Git cannot reach the remote. Check the network connection, then retry."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestBranchRejected => WorkspaceCommandError {
            code: "change_request_branch_rejected",
            message: "The remote rejected this branch update. Choose another branch name or synchronize the branch."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestRemoteMismatch => WorkspaceCommandError {
            code: "change_request_remote_mismatch",
            message: "The local and remote branch commits do not match. Publish the current commit and retry."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestWorktreeDirty => WorkspaceCommandError {
            code: "change_request_worktree_dirty",
            message: "Commit or discard local changes before you prepare a change request."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestForkUnsupported => WorkspaceCommandError {
            code: "change_request_fork_unsupported",
            message: "WTS cannot prepare a fork change request until the provider project is verified."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::ChangeRequestAgentProposalUnavailable => WorkspaceCommandError {
            code: "change_request_agent_proposal_unavailable",
            message: "No agent session prepared a change request for this repository commit. Select Ask agent to prepare."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::ChangeRequestAgentProposalInvalid => WorkspaceCommandError {
            code: "change_request_agent_proposal_invalid",
            message: "The agent proposal does not match the current repository or linked Jira issues."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::InvalidChangeRequestDraft => WorkspaceCommandError {
            code: "invalid_change_request_draft",
            message: "The change-request draft contains invalid or oversized content.".to_owned(),
            retryable: false,
        },
        LocalWtsError::StaleChangeRequestDraft => WorkspaceCommandError {
            code: "stale_change_request_draft",
            message: "The repository changed. Refresh the change-request draft and review it again."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::JiraBrowserUrlUnavailable => WorkspaceCommandError {
            code: "jira_browser_url_unavailable",
            message: "This Jira issue does not contain a safe browser link.".to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidCodeWorkspaceImport => WorkspaceCommandError {
            code: "invalid_code_workspace_import",
            message: "Choose a valid VS Code .code-workspace file.".to_owned(),
            retryable: false,
        },
        LocalWtsError::CodeWorkspaceImportTooLarge => WorkspaceCommandError {
            code: "code_workspace_import_too_large",
            message: "The VS Code workspace file exceeds the local import limit.".to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidRuntimeAnalysisRequest => WorkspaceCommandError {
            code: "invalid_runtime_analysis_request",
            message:
                "Choose at least one pinned local repository and a valid base before analyzing services."
                    .to_owned(),
            retryable: false,
        },
        LocalWtsError::RuntimeAnalysisUnavailable => WorkspaceCommandError {
            code: "runtime_analysis_unavailable",
            message: "WTS could not inspect the selected repository commits.".to_owned(),
            retryable: true,
        },
        LocalWtsError::StaleRuntimeAnalysis => WorkspaceCommandError {
            code: "stale_runtime_analysis",
            message:
                "The selected repositories changed after service analysis. Analyze them again."
                    .to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidRuntimeSelection => WorkspaceCommandError {
            code: "invalid_runtime_selection",
            message: "The runtime plan contains a service or port that was not proposed by WTS."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::WorkspaceNotFound => WorkspaceCommandError {
            code: "workspace_not_found",
            message: "The local workspace plan was not found.".to_owned(),
            retryable: false,
        },
        LocalWtsError::PlanningNotConfigured => WorkspaceCommandError {
            code: "planning_not_configured",
            message: "This workspace does not have a planning home.".to_owned(),
            retryable: false,
        },
        LocalWtsError::PlanningDocumentUnavailable => WorkspaceCommandError {
            code: "planning_document_unavailable",
            message: "The planning document is not available for this workspace.".to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidPlanningDocument => WorkspaceCommandError {
            code: "invalid_planning_document",
            message: "The planning document failed local safety validation.".to_owned(),
            retryable: false,
        },
        LocalWtsError::PlanningDocumentTooLarge => WorkspaceCommandError {
            code: "planning_document_too_large",
            message: "The planning document exceeds the local size limit.".to_owned(),
            retryable: false,
        },
        LocalWtsError::PlanningDocumentConflict => WorkspaceCommandError {
            code: "planning_document_conflict",
            message: "The planning document changed. Reload it and try again.".to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidReviewThread => WorkspaceCommandError {
            code: "invalid_review_thread",
            message: "Choose a valid document line and enter a review comment.".to_owned(),
            retryable: false,
        },
        LocalWtsError::ReviewCommentTooLarge => WorkspaceCommandError {
            code: "review_comment_too_large",
            message: "The review comment exceeds the local size limit.".to_owned(),
            retryable: false,
        },
        LocalWtsError::ReviewThreadNotFound => WorkspaceCommandError {
            code: "review_thread_not_found",
            message: "The review thread was not found.".to_owned(),
            retryable: false,
        },
        LocalWtsError::ReviewThreadConflict => WorkspaceCommandError {
            code: "review_thread_conflict",
            message: "The review thread changed. Reload it and try again.".to_owned(),
            retryable: false,
        },
        LocalWtsError::WorkspaceRenameConflict => WorkspaceCommandError {
            code: "workspace_rename_conflict",
            message: "Another managed workspace already uses this folder name.".to_owned(),
            retryable: false,
        },
        LocalWtsError::WorkspaceRenameBusy => WorkspaceCommandError {
            code: "workspace_rename_busy",
            message: "Stop active WTS work before you rename this workspace.".to_owned(),
            retryable: true,
        },
        LocalWtsError::WorkspaceRenameFailed { cleanup_complete } => WorkspaceCommandError {
            code: if cleanup_complete {
                "workspace_rename_failed"
            } else {
                "workspace_rename_cleanup_incomplete"
            },
            message: if cleanup_complete {
                "WTS could not rename the workspace folder. The original workspace is unchanged."
                    .to_owned()
            } else {
                "WTS could not rename the workspace folder. Inspect the managed workspace before you retry."
                    .to_owned()
            },
            retryable: cleanup_complete,
        },
        LocalWtsError::PreflightBlocked { .. } => WorkspaceCommandError {
            code: "preflight_blocked",
            message: "Workspace preflight is blocked; review the reported blockers.".to_owned(),
            retryable: false,
        },
        LocalWtsError::StalePreflight => WorkspaceCommandError {
            code: "stale_preflight",
            message: "The workspace changed after preflight; review it again.".to_owned(),
            retryable: false,
        },
        LocalWtsError::MaterializationFailed { cleanup_complete } => WorkspaceCommandError {
            code: if cleanup_complete {
                "materialization_failed"
            } else {
                "materialization_cleanup_incomplete"
            },
            message: if cleanup_complete {
                "Git could not materialize the workspace; created worktrees were rolled back."
                    .to_owned()
            } else {
                "Git could not materialize the workspace and cleanup needs inspection.".to_owned()
            },
            retryable: cleanup_complete,
        },
        LocalWtsError::GeneratedFileFailed { cleanup_complete } => WorkspaceCommandError {
            code: if cleanup_complete {
                "generated_workspace_failed"
            } else {
                "generated_workspace_cleanup_incomplete"
            },
            message: if cleanup_complete {
                "WTS could not write the generated workspace files; worktrees were rolled back."
                    .to_owned()
            } else {
                "WTS could not write the generated workspace files and cleanup needs inspection."
                    .to_owned()
            },
            retryable: cleanup_complete,
        },
        LocalWtsError::NotMaterialized => WorkspaceCommandError {
            code: "workspace_not_materialized",
            message: "Materialize this workspace before opening it.".to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidMaterializationManifest => WorkspaceCommandError {
            code: "invalid_materialization_manifest",
            message: "The materialized workspace no longer matches its trusted manifest."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::WorkspaceGitStateChanged => WorkspaceCommandError {
            code: "workspace_git_state_changed",
            message:
                "The managed worktrees changed since WTS last registered their Git state."
                    .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryAlreadyInWorkspace => WorkspaceCommandError {
            code: "repository_already_in_workspace",
            message: "This workspace already contains the selected repository.".to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryAdditionStale => WorkspaceCommandError {
            code: "repository_addition_stale",
            message: "The repository changed after review. Review the repository again."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryAdditionFailed { cleanup_complete } => WorkspaceCommandError {
            code: if cleanup_complete {
                "repository_addition_failed"
            } else {
                "repository_addition_cleanup_failed"
            },
            message: if cleanup_complete {
                "WTS could not add the repository. The current workspace is unchanged."
                    .to_owned()
            } else {
                "WTS could not add the repository or complete cleanup. Review the workspace before you retry."
                    .to_owned()
            },
            retryable: cleanup_complete,
        },
        LocalWtsError::RepositoryRemovalBlocked => WorkspaceCommandError {
            code: "repository_removal_blocked",
            message: "WTS cannot remove the only repository or a repository that has local files. Save or discard its local files first."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryRemovalFailed => WorkspaceCommandError {
            code: "repository_removal_failed",
            message: "WTS could not remove the repository. Refresh the workspace before you retry."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::RepositorySyncBlocked => WorkspaceCommandError {
            code: "repository_sync_blocked",
            message: "Sync cannot change a worktree that has local work. Review or save the local work before you retry."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositorySyncDiverged => WorkspaceCommandError {
            code: "repository_sync_diverged",
            message: "The tracking branch has different history. Review alignment before moving this clean worktree."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositorySyncFailed => WorkspaceCommandError {
            code: "repository_sync_failed",
            message: "WTS could not fetch the saved tracking branch. Check the remote access and retry."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::RepositorySyncBusy => WorkspaceCommandError {
            code: "repository_sync_busy",
            message: "Stop active agent or verification work before syncing this repository."
                .to_owned(),
            retryable: true,
        },
        LocalWtsError::RepositoryAlignmentStale => WorkspaceCommandError {
            code: "repository_alignment_stale",
            message: "The repository changed after alignment review. Check the alignment again."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::RepositoryAlignmentFailed => WorkspaceCommandError {
            code: "repository_alignment_failed",
            message: "WTS could not preserve and align the repository. Review its Git state before retrying."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::VscodeUnavailable => WorkspaceCommandError {
            code: "vscode_unavailable",
            message: "The VS Code command-line launcher is not available.".to_owned(),
            retryable: false,
        },
        LocalWtsError::VscodeLaunchRejected => WorkspaceCommandError {
            code: "vscode_launch_rejected",
            message: "VS Code did not accept the workspace launch request.".to_owned(),
            retryable: true,
        },
        LocalWtsError::AdapterUnavailable => WorkspaceCommandError {
            code: "adapter_unavailable",
            message: "The requested local adapter is unavailable.".to_owned(),
            retryable: false,
        },
        LocalWtsError::AdapterRejected => WorkspaceCommandError {
            code: "adapter_rejected",
            message: "The requested local adapter could not start.".to_owned(),
            retryable: true,
        },
        LocalWtsError::AdapterTimedOut => WorkspaceCommandError {
            code: "adapter_timed_out",
            message: "The requested local adapter timed out.".to_owned(),
            retryable: true,
        },
        LocalWtsError::AdapterOutputTooLarge => WorkspaceCommandError {
            code: "adapter_output_too_large",
            message: "The adapter produced more output than WTS can display safely.".to_owned(),
            retryable: false,
        },
        LocalWtsError::GraphIndexFailed => WorkspaceCommandError {
            code: "graph_index_failed",
            message: "Graphify could not build the workspace graph.".to_owned(),
            retryable: true,
        },
        LocalWtsError::GraphRequired => WorkspaceCommandError {
            code: "workspace_graph_required",
            message: "Build the workspace graph before starting an agent.".to_owned(),
            retryable: false,
        },
        LocalWtsError::RemovalBlocked { .. } => WorkspaceCommandError {
            code: "workspace_removal_blocked",
            message: "Workspace removal is blocked; review the reported blockers.".to_owned(),
            retryable: false,
        },
        LocalWtsError::RemovalFailed => WorkspaceCommandError {
            code: "workspace_removal_failed",
            message: "WTS could not safely finish removing the workspace.".to_owned(),
            retryable: true,
        },
        LocalWtsError::InvalidAgentPrompt => WorkspaceCommandError {
            code: "invalid_agent_prompt",
            message: "Enter a non-empty agent prompt within the local size limit.".to_owned(),
            retryable: false,
        },
        LocalWtsError::AgentSessionUnavailable => WorkspaceCommandError {
            code: "agent_session_unavailable",
            message: "The local agent session ledger is temporarily unavailable.".to_owned(),
            retryable: true,
        },
        LocalWtsError::InvalidAgentSessionStore => WorkspaceCommandError {
            code: "invalid_agent_session_store",
            message: "The local agent session ledger failed integrity validation.".to_owned(),
            retryable: false,
        },
        LocalWtsError::AgentSessionNotFound => WorkspaceCommandError {
            code: "agent_session_not_found",
            message: "The requested agent session was not found.".to_owned(),
            retryable: false,
        },
        LocalWtsError::AgentSessionNotRunning => WorkspaceCommandError {
            code: "agent_session_not_running",
            message: "The requested agent session has already ended.".to_owned(),
            retryable: false,
        },
        LocalWtsError::AgentProposalUnavailable => WorkspaceCommandError {
            code: "agent_proposal_unavailable",
            message:
                "The agent-proposed check is unavailable or is not an approved WTS command."
                    .to_owned(),
            retryable: false,
        },
        LocalWtsError::VerificationCheckUnavailable => WorkspaceCommandError {
            code: "verification_check_unavailable",
            message: "The requested verification check is no longer in this workspace plan."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::VerificationRunUnavailable => WorkspaceCommandError {
            code: "verification_run_unavailable",
            message: "There is no active or failed verification run for this action.".to_owned(),
            retryable: false,
        },
        LocalWtsError::EvidenceUnavailable => WorkspaceCommandError {
            code: "workspace_evidence_unavailable",
            message: "Workspace verification evidence is temporarily unavailable.".to_owned(),
            retryable: true,
        },
        LocalWtsError::InvalidWorkspaceEvidence => WorkspaceCommandError {
            code: "invalid_workspace_evidence",
            message: "Workspace verification evidence failed integrity validation.".to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidTestJourney => WorkspaceCommandError {
            code: "invalid_test_journey",
            message: "Choose a supported local user journey and loopback application URL."
                .to_owned(),
            retryable: false,
        },
        LocalWtsError::TestRunnerUnavailable => WorkspaceCommandError {
            code: "test_runner_unavailable",
            message: "The local browser test runner is unavailable.".to_owned(),
            retryable: false,
        },
        LocalWtsError::TestRunnerFailed => WorkspaceCommandError {
            code: "test_runner_failed",
            message: "The local browser test runner failed to complete the journey.".to_owned(),
            retryable: true,
        },
        LocalWtsError::TestRunnerBusy => WorkspaceCommandError {
            code: "test_runner_busy",
            message: "Another local browser journey is already running.".to_owned(),
            retryable: true,
        },
        LocalWtsError::TestRunnerTimedOut => WorkspaceCommandError {
            code: "test_runner_timed_out",
            message: "The local browser journey exceeded its time limit.".to_owned(),
            retryable: true,
        },
        LocalWtsError::TestRunnerOutputTooLarge => WorkspaceCommandError {
            code: "test_runner_output_too_large",
            message: "The local browser test runner produced too much output.".to_owned(),
            retryable: false,
        },
        LocalWtsError::TestEvidenceUnavailable => WorkspaceCommandError {
            code: "test_evidence_unavailable",
            message: "Local user-test evidence is temporarily unavailable.".to_owned(),
            retryable: true,
        },
        LocalWtsError::TestRunNotFound => WorkspaceCommandError {
            code: "test_run_not_found",
            message: "The local browser test run was not found.".to_owned(),
            retryable: false,
        },
        LocalWtsError::InvalidTestEvidence => WorkspaceCommandError {
            code: "invalid_test_evidence",
            message: "Local user-test evidence failed integrity validation.".to_owned(),
            retryable: false,
        },
        LocalWtsError::JiraMcp(error) => WorkspaceCommandError {
            code: "jira_mcp_failed",
            message: error.safe_message().to_owned(),
            retryable: true,
        },
        LocalWtsError::OpenProject(error) => open_project_command_error(error),
        LocalWtsError::ActivityWatch(error) => activity_watch_command_error(error),
        LocalWtsError::ActivityWatchReview(error) => {
            activity_watch_review_command_error(error)
        },
        LocalWtsError::Store(error) => workspace_command_error(error),
    }
}

fn activity_watch_review_command_error(error: ActivityWatchReviewError) -> WorkspaceCommandError {
    WorkspaceCommandError {
        code: match error {
            ActivityWatchReviewError::InvalidTimeRange => "activity_watch_invalid_time_range",
            ActivityWatchReviewError::ConnectionFailed => "activity_watch_unavailable",
            ActivityWatchReviewError::RequestTimedOut => "activity_watch_review_timed_out",
            ActivityWatchReviewError::ResponseTooLarge => "activity_watch_review_too_large",
            ActivityWatchReviewError::ResponseInvalid => "activity_watch_response_invalid",
            ActivityWatchReviewError::EndpointRedirected => "activity_watch_endpoint_redirected",
            ActivityWatchReviewError::ServerRejected => "activity_watch_server_rejected",
        },
        message: error.safe_message().to_owned(),
        retryable: !matches!(error, ActivityWatchReviewError::InvalidTimeRange),
    }
}

fn activity_watch_command_error(error: ActivityWatchError) -> WorkspaceCommandError {
    WorkspaceCommandError {
        code: match error {
            ActivityWatchError::InvalidEndpoint => "activity_watch_invalid_endpoint",
            ActivityWatchError::ClientInitializationFailed => {
                "activity_watch_connector_unavailable"
            }
        },
        message: error.safe_message().to_owned(),
        retryable: matches!(error, ActivityWatchError::ClientInitializationFailed),
    }
}

fn open_project_command_error(error: OpenProjectError) -> WorkspaceCommandError {
    let (code, retryable) = match error {
        OpenProjectError::EndpointMissing
        | OpenProjectError::TokenMissing
        | OpenProjectError::InvalidEndpoint
        | OpenProjectError::InvalidToken
        | OpenProjectError::ClientInitializationFailed => {
            ("open_project_configuration_invalid", false)
        }
        OpenProjectError::InvalidReference => ("invalid_open_project_reference", false),
        OpenProjectError::AuthenticationFailed => ("open_project_authentication_failed", false),
        OpenProjectError::PermissionDenied => ("open_project_permission_denied", false),
        OpenProjectError::ResourceNotFound => ("open_project_work_package_not_found", false),
        OpenProjectError::AmbiguousReference => ("open_project_reference_ambiguous", false),
        OpenProjectError::RequestTimedOut => ("open_project_timed_out", true),
        OpenProjectError::ResponseTooLarge => ("open_project_response_too_large", false),
        OpenProjectError::RateLimited => ("open_project_rate_limited", true),
        OpenProjectError::RequestFailed
        | OpenProjectError::ResponseInvalid
        | OpenProjectError::ServerRejected => ("open_project_remote_failure", true),
    };
    WorkspaceCommandError {
        code,
        message: error.safe_message().to_owned(),
        retryable,
    }
}

fn workspace_command_error(error: WorkspaceStoreError) -> WorkspaceCommandError {
    match error {
        WorkspaceStoreError::Validation(_)
        | WorkspaceStoreError::InvalidIdempotencyKey
        | WorkspaceStoreError::InvalidEffectDigest
        | WorkspaceStoreError::InvalidWorkItemLink
        | WorkspaceStoreError::InvalidReviewThread => WorkspaceCommandError {
            code: "invalid_request",
            message: "The workspace request did not pass validation.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::IdempotencyConflict { .. }
        | WorkspaceStoreError::TombstoneIdempotencyConflict { .. }
        | WorkspaceStoreError::WorkItemLinkIdempotencyConflict { .. } => WorkspaceCommandError {
            code: "idempotency_conflict",
            message: "This retry key was already used for a different workspace operation."
                .to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::WorkspaceAlreadyTombstoned { .. } => WorkspaceCommandError {
            code: "workspace_already_removed",
            message: "This workspace has already been removed.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::WorkspaceNotFound { .. } => WorkspaceCommandError {
            code: "workspace_not_found",
            message: "The local workspace plan was not found.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::ReviewThreadNotFound { .. } => WorkspaceCommandError {
            code: "review_thread_not_found",
            message: "The review thread was not found.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::WorkItemLinkNotFound { .. } => WorkspaceCommandError {
            code: "work_item_link_not_found",
            message: "The linked work item was not found.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::StaleWorkItemLinkPreview => WorkspaceCommandError {
            code: "stale_work_item_link_preview",
            message: "The Jira issue changed. Review it again before you link it.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::WorkItemLinkAlreadyExists => WorkspaceCommandError {
            code: "work_item_link_exists",
            message: "This Jira issue is already linked to the workspace.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::PrimaryWorkItemLinkAlreadyExists => WorkspaceCommandError {
            code: "primary_work_item_link_exists",
            message: "This workspace already has a primary work item.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::WorkItemLinkConflict { .. } => WorkspaceCommandError {
            code: "work_item_link_conflict",
            message: "The linked work item changed. Reload it and try again.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::WorkspaceWorkflowConflict { .. } => WorkspaceCommandError {
            code: "workspace_workflow_conflict",
            message: "The workspace moved to another state. Reload it and try again.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::InvalidWorkspaceBoardPlacement => WorkspaceCommandError {
            code: "invalid_workspace_board_placement",
            message: "Choose a valid position in the workspace state.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::ReviewThreadConflict { .. } => WorkspaceCommandError {
            code: "review_thread_conflict",
            message: "The review thread changed. Reload it and try again.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::ReviewCommentTooLarge => WorkspaceCommandError {
            code: "review_comment_too_large",
            message: "The review comment exceeds the local size limit.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::UnsupportedSchemaVersion { .. }
        | WorkspaceStoreError::CorruptRecord(_)
        | WorkspaceStoreError::UnknownWorkspaceRoot(_) => WorkspaceCommandError {
            code: "workspace_store_incompatible",
            message: "The local workspace registry cannot be read by this WTS version.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::DataDirectoryMustBeAbsolute
        | WorkspaceStoreError::WorkspaceRootMustBeAbsolute
        | WorkspaceStoreError::InvalidWorkspaceRoot
        | WorkspaceStoreError::NonUtf8WorkspaceRoot
        | WorkspaceStoreError::InvalidWorkspaceRootId => WorkspaceCommandError {
            code: "invalid_local_configuration",
            message: "The configured WTS data or workspace root is invalid.".to_owned(),
            retryable: false,
        },
        WorkspaceStoreError::InvalidSystemClock
        | WorkspaceStoreError::Io(_)
        | WorkspaceStoreError::Database(_)
        | WorkspaceStoreError::Serialization(_) => WorkspaceCommandError {
            code: "workspace_store_unavailable",
            message: "The local workspace registry is temporarily unavailable.".to_owned(),
            retryable: true,
        },
    }
}

#[cfg(debug_assertions)]
fn initialize_development_tracing() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(default_development_tracing_filter()));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

#[cfg(debug_assertions)]
fn default_development_tracing_filter() -> &'static str {
    "wts_desktop=info,wts_app::repository_catalog=info,wts_app::repository_clone=info,wts_app::runtime_analysis=info,wts_app::operations=info"
}

pub fn run() {
    #[cfg(debug_assertions)]
    initialize_development_tracing();

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(updater::update_public_key())
                .build(),
        )
        .setup(|app| {
            let service = local_wts_service(app.handle())
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(service);
            app.manage(updater::AppUpdateState::new(
                app.package_info().version.to_string(),
            ));
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
            #[cfg(target_os = "macos")]
            if window.label() == "main"
                && let tauri::WindowEvent::CloseRequested { api, .. } = event
                && desktop_lifecycle_action(DesktopLifecycleEvent::MainWindowCloseRequested)
                    == DesktopLifecycleAction::HideMainWindow
            {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_info,
            get_update_status,
            check_for_update,
            download_and_install_update,
            relaunch_updated_app,
            send_desktop_notification,
            list_workspaces,
            get_workspace,
            rename_workspace,
            transition_workspace_workflow,
            place_workspace_on_board,
            follow_workspace_agent,
            list_workspace_planning_documents,
            read_workspace_planning_document,
            update_workspace_planning_document,
            list_workspace_review_threads,
            create_workspace_review_thread,
            resolve_workspace_review_thread,
            create_workspace,
            get_setup_snapshot,
            get_github_review_inbox,
            open_github_review,
            get_gitlab_review_inbox,
            get_gitlab_review_patch,
            publish_gitlab_review_comment,
            get_gitlab_discussions,
            reply_gitlab_discussion,
            get_gitlab_merge_requests,
            get_gitlab_integration_status,
            open_gitlab_merge_request,
            prepare_gitlab_review_repository,
            get_activity_watch_status,
            get_activity_watch_daily_review,
            get_activity_watch_time_review_brief,
            list_repositories,
            clone_repository,
            refresh_repository_branches,
            analyze_workspace_runtime,
            preflight_workspace,
            recover_workspace_setup,
            get_workspace_materialization,
            get_workspace_repository_diff,
            get_workspace_repository_file_review,
            get_workspace_gitlab_comparison,
            get_workspace_repository_source,
            save_workspace_repository_source,
            get_workspace_repository_review_graph,
            sync_workspace_repository,
            preflight_workspace_repository_addition,
            add_workspace_repository,
            remove_workspace_repository,
            preflight_workspace_repository_alignment,
            align_workspace_repository,
            materialize_workspace,
            open_workspace_in_vscode,
            open_workspace_cli,
            write_workspace_agent_brief,
            ui_capture::capture_ui_region,
            open_agent_work_item_preview,
            create_agent_work_set,
            list_agent_work_sets,
            get_agent_work_set,
            cancel_agent_work_item,
            preflight_agent_work_item_integration,
            integrate_agent_work_item,
            create_agent_conversation,
            list_agent_conversations,
            get_agent_conversation,
            get_agent_turn_changes,
            get_agent_turn_decisions,
            record_agent_turn_decision,
            get_agent_turn_checks,
            run_agent_turn_check,
            preflight_agent_turn_restore,
            restore_agent_turn,
            send_agent_conversation_message,
            update_agent_conversation_message,
            cancel_agent_conversation_message,
            list_agent_sessions,
            get_agent_session_detail,
            start_agent_session,
            heartbeat_agent_session,
            finish_agent_session,
            fail_agent_session,
            launch_agent_session,
            stop_agent_session,
            open_repository_base,
            prepare_workspace_change_request,
            publish_workspace_change_request_branch,
            open_workspace_change_request_draft,
            index_workspace_graph,
            reindex_workspace_graph,
            preflight_workspace_removal,
            remove_workspace,
            run_workspace_agent,
            run_workspace_code_review,
            get_workspace_evidence,
            get_workspace_verification_summary,
            promote_agent_verification_check,
            run_workspace_verification,
            run_workspace_verification_check,
            rerun_failed_workspace_verification,
            cancel_workspace_verification,
            list_workspace_test_runs,
            get_workspace_test_run,
            run_workspace_test_journey,
            verify_jira_mcp,
            list_active_jira_issues,
            import_jira_issue,
            preview_workspace_jira_link,
            confirm_workspace_jira_link,
            open_workspace_jira_preview,
            list_workspace_work_item_links,
            unlink_workspace_work_item,
            open_workspace_work_item,
            propose_workspace_jira_issue,
            import_code_workspace_file,
            verify_open_project,
            import_open_project_work_package,
            get_demo_boundary,
            verify_demo_action
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the WTS desktop application");

    app.run(|app_handle, event| {
        #[cfg(not(target_os = "macos"))]
        let _ = (app_handle, event);
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event
            && desktop_lifecycle_action(DesktopLifecycleEvent::ApplicationReopened)
                == DesktopLifecycleAction::RestoreMainWindow
        {
            restore_main_window(app_handle);
        }
    });
}

#[cfg(target_os = "macos")]
fn restore_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unimplemented_agent_publication_has_no_desktop_permission() {
        let configured: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let generated: serde_json::Value =
            serde_json::from_str(include_str!("../gen/schemas/capabilities.json")).unwrap();
        for permissions in [
            configured["permissions"].as_array().unwrap(),
            generated["default"]["permissions"].as_array().unwrap(),
        ] {
            for forbidden in [
                "allow-preflight-agent-conversation-publication",
                "allow-publish-agent-conversation-branch",
            ] {
                assert!(
                    !permissions.iter().any(|value| value == forbidden),
                    "The desktop must not grant the unfinished command: {forbidden}"
                );
            }
        }
    }

    #[test]
    fn desktop_source_editor_preserves_revision_and_reports_conflicts() {
        let wire = serde_json::json!({"filePath":"src/source.rs","content":"line one\nline two","expectedRevision":format!("sha256:{}","a".repeat(64))});
        let request: wts_app::WorkspaceRepositorySourceSaveRequest =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(request.content, "line one\nline two");
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
        let mut untrusted = wire;
        untrusted["root"] = serde_json::json!("/outside");
        assert!(
            serde_json::from_value::<wts_app::WorkspaceRepositorySourceSaveRequest>(untrusted)
                .is_err()
        );
        let error = serde_json::to_value(local_wts_command_error(
            LocalWtsError::RepositoryFileConflict,
        ))
        .unwrap();
        assert_eq!(error["code"], "repository_file_conflict");
        assert_eq!(error["retryable"], false);
        assert_eq!(
            local_wts_command_error(LocalWtsError::GitlabComparisonUnavailable).code,
            "gitlab_comparison_unavailable"
        );
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for (command, permission) in [
            (
                "get_workspace_gitlab_comparison",
                "allow-get-workspace-gitlab-comparison",
            ),
            (
                "get_workspace_repository_source",
                "allow-get-workspace-repository-source",
            ),
            (
                "save_workspace_repository_source",
                "allow-save-workspace-repository-source",
            ),
        ] {
            assert!(
                capability["permissions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|value| value == permission)
            );
            let generated = std::fs::read_to_string(format!(
                "{}/permissions/autogenerated/{command}.toml",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap();
            assert!(generated.contains(&format!("commands.allow = [\"{command}\"]")));
        }
    }

    #[test]
    fn desktop_inline_comment_preserves_workspace_and_published_position() {
        let wire = serde_json::json!({"body":"Explain this line.","filePath":"source.rs","side":"additions","line":1,"workspaceId":Uuid::nil(),"expectedPosition":{"baseCommitOid":"a".repeat(40),"startCommitOid":"a".repeat(40),"headCommitOid":"b".repeat(40)}});
        let request: wts_app::GitlabReviewCommentRequest =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(
            request.workspace_id.as_deref(),
            Some(Uuid::nil().to_string().as_str())
        );
        assert_eq!(
            request.expected_position.as_ref().unwrap().head_commit_oid,
            "b".repeat(40)
        );
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
    }

    #[test]
    fn desktop_agent_conversation_contract_rejects_renderer_paths_and_keeps_recovery_codes() {
        let wire = serde_json::json!({"requestId":Uuid::new_v4(),"provider":"codex","source":{"kind":"ui","route":"/spaces","calloutId":"spaces.toolbar","label":"Spaces toolbar","context":"{\"width\":600}"}});
        let request: wts_app::CreateAgentConversationRequest =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
        let mut untrusted = wire;
        untrusted["workspacePath"] = serde_json::json!("/tmp/other-workspace");
        assert!(
            serde_json::from_value::<wts_app::CreateAgentConversationRequest>(untrusted).is_err()
        );
        let message = serde_json::json!({"requestId":Uuid::new_v4(),"body":"Change the spacing. $literal\nSecond line"});
        let parsed: wts_app::SendAgentConversationMessageRequest =
            serde_json::from_value(message.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), message);
        let update = serde_json::json!({"requestId":Uuid::new_v4(),"expectedBody":"Old request", "body":"Updated request"});
        let parsed: wts_app::UpdateAgentConversationMessageRequest =
            serde_json::from_value(update.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), update);
        let cancel = serde_json::json!({"requestId":Uuid::new_v4(),"expectedBody":"Old request"});
        let parsed: wts_app::CancelAgentConversationMessageRequest =
            serde_json::from_value(cancel.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), cancel);
        let mut untrusted = update;
        untrusted["workspaceId"] = serde_json::json!(Uuid::new_v4());
        assert!(
            serde_json::from_value::<wts_app::UpdateAgentConversationMessageRequest>(untrusted)
                .is_err()
        );
        for (failure, code, retryable) in [
            (
                LocalWtsError::InvalidAgentConversation,
                "invalid_agent_conversation",
                false,
            ),
            (
                LocalWtsError::AgentConversationConflict,
                "agent_conversation_conflict",
                false,
            ),
            (
                LocalWtsError::AgentConversationQueueFull,
                "agent_conversation_queue_full",
                true,
            ),
            (
                LocalWtsError::AgentConversationPlatformUnavailable,
                "agent_conversation_platform_unavailable",
                false,
            ),
            (
                LocalWtsError::AgentConversationLimit,
                "agent_conversation_limit",
                false,
            ),
            (
                LocalWtsError::AgentConversationStorageFull,
                "agent_conversation_storage_full",
                false,
            ),
            (
                LocalWtsError::AgentConversationSourceUnavailable,
                "agent_conversation_source_unavailable",
                true,
            ),
        ] {
            let error = serde_json::to_value(local_wts_command_error(failure)).unwrap();
            assert_eq!(error["code"], code);
            assert_eq!(error["retryable"], retryable);
        }
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for command in [
            "open_agent_work_item_preview",
            "create_agent_work_set",
            "list_agent_work_sets",
            "get_agent_work_set",
            "cancel_agent_work_item",
            "preflight_agent_work_item_integration",
            "integrate_agent_work_item",
            "create_agent_conversation",
            "list_agent_conversations",
            "get_agent_conversation",
            "get_agent_turn_changes",
            "get_agent_turn_decisions",
            "record_agent_turn_decision",
            "get_agent_turn_checks",
            "run_agent_turn_check",
            "preflight_agent_turn_restore",
            "restore_agent_turn",
            "send_agent_conversation_message",
            "update_agent_conversation_message",
            "cancel_agent_conversation_message",
            "capture_ui_region",
        ] {
            let permission = format!("allow-{}", command.replace('_', "-"));
            assert!(
                capability["permissions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|value| value == &permission)
            );
            let generated = std::fs::read_to_string(format!(
                "{}/permissions/autogenerated/{command}.toml",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap();
            assert!(generated.contains(&format!("commands.allow = [\"{command}\"]")));
        }
    }

    #[test]
    fn desktop_gitlab_discussion_reply_preserves_scope_and_literal_body() {
        let wire = serde_json::json!({"discussionId":"thread-1","body":"Reply with $literal\ntext","workspaceId":Uuid::nil()});
        let request: wts_app::ReplyGitlabDiscussionRequest =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(request.workspace_id, Some(Uuid::nil()));
        assert_eq!(request.discussion_id, "thread-1");
        assert_eq!(request.body, "Reply with $literal\ntext");
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
        let mut untrusted = wire;
        untrusted["origin"] = serde_json::json!("https://other.example/project.git");
        assert!(
            serde_json::from_value::<wts_app::ReplyGitlabDiscussionRequest>(untrusted).is_err()
        );
        let failure = local_wts_command_error(LocalWtsError::GitlabDiscussionReplyFailed);
        let error = serde_json::to_value(failure).unwrap();
        assert_eq!(error["code"], "gitlab_discussion_reply_failed");
        assert_eq!(error["retryable"], false);
        assert_eq!(
            error["message"],
            "WTS could not confirm the reply. Refresh the discussion before you try again."
        );
        assert_eq!(
            local_wts_command_error(LocalWtsError::GitlabDiscussionsUnavailable).code,
            "gitlab_discussions_unavailable"
        );
    }

    #[test]
    fn desktop_work_set_requests_preserve_dependencies_and_apply_identity() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let wire = serde_json::json!({"requestId":Uuid::new_v4(),"expectedAfterCheckpointId":Uuid::new_v4(),"kind":"tasks","tasks":[
            {"taskId":first,"title":"Fix parsing","prompt":"Keep $literal and `code`.\nParse the description.","dependsOn":[]},
            {"taskId":second,"title":"Show the result","prompt":"Use the parsed description.","dependsOn":[first]}
        ]});
        let parsed: wts_app::CreateAgentWorkSetRequest =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let mut forged = wire.clone();
        forged["workspacePath"] = serde_json::json!("/tmp/injected");
        assert!(serde_json::from_value::<wts_app::CreateAgentWorkSetRequest>(forged).is_err());
        let mut forged = wire;
        forged["tasks"][0]["command"] = serde_json::json!("injected");
        assert!(serde_json::from_value::<wts_app::CreateAgentWorkSetRequest>(forged).is_err());
        let wire = serde_json::json!({"requestId":Uuid::new_v4(),"effectDigest":format!("sha256:{}", "a".repeat(64))});
        let parsed: wts_app::IntegrateAgentWorkItemRequest =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let mut forged = wire;
        forged["files"] = serde_json::json!([{"filePath":"/tmp/other"}]);
        assert!(serde_json::from_value::<wts_app::IntegrateAgentWorkItemRequest>(forged).is_err());
        let wire = serde_json::json!({"requestId":Uuid::new_v4(),"expectedRevision":7});
        let parsed: wts_app::AgentWorkItemCancelRequest =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), wire);
        let mut forged = wire;
        forged["processId"] = serde_json::json!(123);
        assert!(serde_json::from_value::<wts_app::AgentWorkItemCancelRequest>(forged).is_err());
    }

    #[test]
    fn desktop_turn_decision_request_keeps_the_user_choice_and_rejects_source_paths() {
        let wire = serde_json::json!({"requestId":Uuid::new_v4(),"expectedRevision":3,
            "expectedReceiptDigest":format!("sha256:{}","a".repeat(64)),"kind":"rejected",
            "reason":"Keep the literal $value.\nThis result needs another change."});
        let request: wts_app::RecordAgentTurnDecisionRequest =
            serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), wire);
        for field in ["workingDirectory", "sourcePath", "command"] {
            let mut injected = wire.clone();
            injected[field] = serde_json::json!("/another-workspace");
            assert!(
                serde_json::from_value::<wts_app::RecordAgentTurnDecisionRequest>(injected)
                    .is_err()
            );
        }
    }

    #[test]
    fn desktop_turn_recovery_requests_keep_mutation_identity_and_reject_paths() {
        let busy = local_wts_command_error(LocalWtsError::AgentConversationBusy);
        assert_eq!(busy.code, "agent_conversation_busy");
        assert!(busy.retryable);
        assert_eq!(
            busy.message,
            "Another WTS task is active in this workspace. Wait for it to finish, then retry."
        );
        let check = serde_json::json!({"requestId":Uuid::new_v4(),"checkId":"unit.tests",
            "expectedAfterCheckpointId":Uuid::new_v4(),"expectedPlanRevision":2});
        let request: wts_app::RunAgentTurnCheckRequest =
            serde_json::from_value(check.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), check);
        let restore = serde_json::json!({"requestId":Uuid::new_v4(),"effectDigest":format!("sha256:{}","a".repeat(64))});
        let request: wts_app::AgentTurnRestoreRequest =
            serde_json::from_value(restore.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), restore);
        for field in ["executable", "targetPath", "workingDirectory"] {
            let mut untrusted = check.clone();
            untrusted[field] = serde_json::json!("/outside");
            assert!(
                serde_json::from_value::<wts_app::RunAgentTurnCheckRequest>(untrusted).is_err()
            );
            let mut untrusted = restore.clone();
            untrusted[field] = serde_json::json!("/outside");
            assert!(serde_json::from_value::<wts_app::AgentTurnRestoreRequest>(untrusted).is_err());
        }
    }

    #[test]
    fn desktop_capability_exposes_gitlab_discussion_commands() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        for (command, permission) in [
            ("get_gitlab_discussions", "allow-get-gitlab-discussions"),
            ("reply_gitlab_discussion", "allow-reply-gitlab-discussion"),
        ] {
            assert!(
                capability["permissions"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|value| value == permission)
            );
            let generated = std::fs::read_to_string(format!(
                "{}/permissions/autogenerated/{command}.toml",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap();
            assert!(generated.contains(&format!("commands.allow = [\"{command}\"]")));
        }
    }

    #[test]
    fn desktop_lifecycle_hides_close_requests_and_restores_reopen_requests() {
        assert_eq!(
            desktop_lifecycle_action(DesktopLifecycleEvent::MainWindowCloseRequested),
            DesktopLifecycleAction::HideMainWindow
        );
        assert_eq!(
            desktop_lifecycle_action(DesktopLifecycleEvent::ApplicationReopened),
            DesktopLifecycleAction::RestoreMainWindow
        );
    }

    #[test]
    fn desktop_review_command_accepts_the_exact_code_change_anchor() {
        let request: CreateWorkspaceReviewThreadRequest =
            serde_json::from_value(serde_json::json!({
                "target": {
                    "kind": "codeChange",
                    "repositoryId": "repo_checkout",
                    "baseCommitOid": "a".repeat(40),
                    "headCommitOid": "b".repeat(40),
                    "patchSha256": format!("sha256:{}", "c".repeat(64)),
                    "filePath": "src/checkout.rs",
                    "side": "additions",
                    "line": 42
                },
                "author": "user",
                "body": "Explain this branch."
            }))
            .expect("deserialize code review command input");

        let wts_app::ReviewTarget::CodeChange {
            repository_id,
            file_path,
            side,
            line,
            ..
        } = request.target
        else {
            panic!("expected code review target");
        };
        assert_eq!(repository_id, "repo_checkout");
        assert_eq!(file_path, "src/checkout.rs");
        assert_eq!(side, wts_app::ReviewCodeSide::Additions);
        assert_eq!(line, 42);
    }

    #[test]
    fn desktop_notification_text_is_bounded_and_script_escaped() {
        assert_eq!(
            normalized_notification_text("  Review\nready  ", 20).expect("valid text"),
            "Review ready"
        );
        assert!(normalized_notification_text("", 20).is_err());
        assert!(normalized_notification_text("too long", 3).is_err());
        assert!(normalized_notification_text("bad\0text", 20).is_err());
        assert_eq!(
            desktop_notification_script("Review \"ready\"", r#"Use C:\workspace"#),
            r#"display notification "Use C:\\workspace" with title "Review \"ready\"""#
        );
    }

    #[test]
    fn removal_failures_have_stable_command_error_codes() {
        let blocker = wts_app::RemovalBlocker {
            code: wts_app::RemovalBlockerCode::ActiveOperation,
            message: "A workspace operation has not finished.".to_owned(),
            repository_label: None,
            display_path: Some("/fixture/workspace".to_owned()),
            expected: Some("No active or queued workspace operations.".to_owned()),
            observed: Some("An agent task is active.".to_owned()),
            recovery_steps: vec![
                "Wait for the task to finish, then select Check again.".to_owned(),
            ],
        };
        let wire = serde_json::to_value(&blocker).unwrap();
        assert_eq!(wire["code"], "activeOperation");
        assert_eq!(wire["displayPath"], "/fixture/workspace");
        assert_eq!(
            wire["recoverySteps"][0],
            "Wait for the task to finish, then select Check again."
        );
        let blocked = local_wts_command_error(LocalWtsError::RemovalBlocked {
            blockers: vec![blocker],
        });
        assert_eq!(blocked.code, "workspace_removal_blocked");
        assert!(!blocked.retryable);

        let failed = local_wts_command_error(LocalWtsError::RemovalFailed);
        assert_eq!(failed.code, "workspace_removal_failed");
        assert!(failed.retryable);

        let invalid_digest = workspace_command_error(WorkspaceStoreError::InvalidEffectDigest);
        assert_eq!(invalid_digest.code, "invalid_request");
        assert!(!invalid_digest.retryable);
    }

    #[test]
    fn code_workspace_import_failures_have_stable_command_error_codes() {
        let invalid = local_wts_command_error(LocalWtsError::InvalidCodeWorkspaceImport);
        assert_eq!(invalid.code, "invalid_code_workspace_import");
        assert!(!invalid.retryable);

        let too_large = local_wts_command_error(LocalWtsError::CodeWorkspaceImportTooLarge);
        assert_eq!(too_large.code, "code_workspace_import_too_large");
        assert!(!too_large.retryable);
    }

    #[test]
    fn repository_base_failures_have_stable_command_error_codes() {
        let invalid = local_wts_command_error(LocalWtsError::InvalidRepositoryBase);
        assert_eq!(invalid.code, "invalid_repository_base");
        assert!(!invalid.retryable);

        let unsupported = local_wts_command_error(LocalWtsError::RepositoryForgeUnsupported);
        assert_eq!(unsupported.code, "repository_forge_unsupported");
        assert!(!unsupported.retryable);

        let comment_failed = local_wts_command_error(LocalWtsError::GitlabReviewCommentFailed);
        assert_eq!(comment_failed.code, "gitlab_review_comment_failed");
        assert!(comment_failed.retryable);
        assert!(!comment_failed.message.contains("supported origin"));

        let rejected = local_wts_command_error(LocalWtsError::BrowserLaunchRejected);
        assert_eq!(rejected.code, "browser_launch_rejected");
        assert!(rejected.retryable);
    }

    #[test]
    fn repository_clone_failures_have_stable_command_error_codes() {
        let invalid = local_wts_command_error(LocalWtsError::InvalidRepositoryRemote);
        assert_eq!(invalid.code, "invalid_repository_remote");
        assert!(!invalid.retryable);
        assert!(!invalid.message.contains("secret"));

        let conflict = local_wts_command_error(LocalWtsError::RepositoryCloneConflict);
        assert_eq!(conflict.code, "repository_clone_conflict");
        assert!(!conflict.retryable);

        let branch = local_wts_command_error(LocalWtsError::RepositoryCloneBranchUnavailable);
        assert_eq!(branch.code, "repository_clone_branch_unavailable");
        assert!(!branch.retryable);
        assert!(branch.message.contains("select an available branch"));

        let failed = local_wts_command_error(LocalWtsError::RepositoryCloneFailed);
        assert_eq!(failed.code, "repository_clone_failed");
        assert!(failed.retryable);
    }

    #[test]
    fn repository_sync_failures_have_stable_command_error_codes() {
        let blocked = local_wts_command_error(LocalWtsError::RepositorySyncBlocked);
        assert_eq!(blocked.code, "repository_sync_blocked");
        assert!(!blocked.retryable);

        let failed = local_wts_command_error(LocalWtsError::RepositorySyncFailed);
        assert_eq!(failed.code, "repository_sync_failed");
        assert!(failed.retryable);

        let busy = local_wts_command_error(LocalWtsError::RepositorySyncBusy);
        assert_eq!(busy.code, "repository_sync_busy");
        assert!(busy.retryable);

        let diverged = local_wts_command_error(LocalWtsError::RepositorySyncDiverged);
        assert_eq!(diverged.code, "repository_sync_diverged");
        assert!(!diverged.retryable);

        let stale = local_wts_command_error(LocalWtsError::RepositoryAlignmentStale);
        assert_eq!(stale.code, "repository_alignment_stale");
        assert!(!stale.retryable);

        let alignment_failed = local_wts_command_error(LocalWtsError::RepositoryAlignmentFailed);
        assert_eq!(alignment_failed.code, "repository_alignment_failed");
        assert!(!alignment_failed.retryable);
    }

    #[test]
    fn activity_watch_configuration_failures_have_stable_command_error_codes() {
        let error = activity_watch_command_error(ActivityWatchError::InvalidEndpoint);
        assert_eq!(error.code, "activity_watch_invalid_endpoint");
        assert!(!error.retryable);
        assert_eq!(
            error.message,
            ActivityWatchError::InvalidEndpoint.safe_message()
        );

        let review =
            activity_watch_review_command_error(ActivityWatchReviewError::InvalidTimeRange);
        assert_eq!(review.code, "activity_watch_invalid_time_range");
        assert!(!review.retryable);
        assert_eq!(
            review.message,
            ActivityWatchReviewError::InvalidTimeRange.safe_message()
        );

        let redirected =
            activity_watch_review_command_error(ActivityWatchReviewError::EndpointRedirected);
        assert_eq!(redirected.code, "activity_watch_endpoint_redirected");
        assert!(redirected.retryable);
    }

    #[test]
    fn workspace_git_drift_is_distinct_from_manifest_corruption() {
        let drift = local_wts_command_error(LocalWtsError::WorkspaceGitStateChanged);
        assert_eq!(drift.code, "workspace_git_state_changed");
        assert!(!drift.retryable);

        let corrupted = local_wts_command_error(LocalWtsError::InvalidMaterializationManifest);
        assert_eq!(corrupted.code, "invalid_materialization_manifest");
        assert!(!corrupted.retryable);
    }

    #[test]
    fn change_request_commands_have_stable_errors_and_permissions() {
        let stale = local_wts_command_error(LocalWtsError::StaleChangeRequestDraft);
        assert_eq!(stale.code, "stale_change_request_draft");
        assert!(stale.retryable);
        let authentication =
            local_wts_command_error(LocalWtsError::ChangeRequestBranchAuthenticationFailed);
        assert_eq!(
            authentication.code,
            "change_request_branch_authentication_failed"
        );
        assert!(authentication.message.contains("authentication failed"));
        let invalid_name = local_wts_command_error(LocalWtsError::InvalidChangeRequestBranchName);
        assert_eq!(invalid_name.code, "invalid_change_request_branch_name");
        let capability = include_str!("../capabilities/default.json");
        let prepare =
            include_str!("../permissions/autogenerated/prepare_workspace_change_request.toml");
        let publish = include_str!(
            "../permissions/autogenerated/publish_workspace_change_request_branch.toml"
        );
        let open =
            include_str!("../permissions/autogenerated/open_workspace_change_request_draft.toml");
        let github_reviews =
            include_str!("../permissions/autogenerated/get_github_review_inbox.toml");
        let github_review_open =
            include_str!("../permissions/autogenerated/open_github_review.toml");
        let gitlab_merge_requests =
            include_str!("../permissions/autogenerated/get_gitlab_merge_requests.toml");
        let gitlab_reviews =
            include_str!("../permissions/autogenerated/get_gitlab_review_inbox.toml");
        let gitlab_integration_status =
            include_str!("../permissions/autogenerated/get_gitlab_integration_status.toml");
        let gitlab_merge_request_open =
            include_str!("../permissions/autogenerated/open_gitlab_merge_request.toml");
        let gitlab_review_prepare =
            include_str!("../permissions/autogenerated/prepare_gitlab_review_repository.toml");
        assert!(capability.contains("allow-prepare-workspace-change-request"));
        assert!(capability.contains("allow-publish-workspace-change-request-branch"));
        assert!(capability.contains("allow-open-workspace-change-request-draft"));
        assert!(prepare.contains("commands.allow = [\"prepare_workspace_change_request\"]"));
        assert!(publish.contains("commands.allow = [\"publish_workspace_change_request_branch\"]"));
        assert!(open.contains("commands.allow = [\"open_workspace_change_request_draft\"]"));
        assert!(capability.contains("allow-get-github-review-inbox"));
        assert!(capability.contains("allow-open-github-review"));
        assert!(github_reviews.contains("commands.allow = [\"get_github_review_inbox\"]"));
        assert!(github_review_open.contains("commands.allow = [\"open_github_review\"]"));
        assert!(capability.contains("allow-get-gitlab-merge-requests"));
        assert!(capability.contains("allow-get-gitlab-review-inbox"));
        assert!(capability.contains("allow-get-gitlab-integration-status"));
        assert!(capability.contains("allow-open-gitlab-merge-request"));
        assert!(capability.contains("allow-prepare-gitlab-review-repository"));
        assert!(gitlab_merge_requests.contains("commands.allow = [\"get_gitlab_merge_requests\"]"));
        assert!(gitlab_reviews.contains("commands.allow = [\"get_gitlab_review_inbox\"]"));
        assert!(
            gitlab_integration_status
                .contains("commands.allow = [\"get_gitlab_integration_status\"]")
        );
        assert!(
            gitlab_merge_request_open.contains("commands.allow = [\"open_gitlab_merge_request\"]")
        );
        assert!(
            gitlab_review_prepare
                .contains("commands.allow = [\"prepare_gitlab_review_repository\"]")
        );
    }

    #[test]
    fn updater_commands_have_a_bounded_capability_and_local_transport() {
        let capability = include_str!("../capabilities/default.json");
        let build = include_str!("../build.rs");
        let config = include_str!("../tauri.conf.json");
        for (command, permission) in [
            ("get_update_status", "allow-get-update-status"),
            ("check_for_update", "allow-check-for-update"),
            (
                "download_and_install_update",
                "allow-download-and-install-update",
            ),
            ("relaunch_updated_app", "allow-relaunch-updated-app"),
        ] {
            let permission_file = std::fs::read_to_string(format!(
                "{}/permissions/autogenerated/{command}.toml",
                env!("CARGO_MANIFEST_DIR")
            ))
            .expect("generated updater permission");
            assert!(build.contains(&format!("\"{command}\"")));
            assert!(capability.contains(&format!("\"{permission}\"")));
            assert!(permission_file.contains(&format!("commands.allow = [\"{command}\"]")));
        }
        let config: serde_json::Value = serde_json::from_str(config).expect("Tauri config JSON");
        let updater = &config["plugins"]["updater"];
        assert_eq!(updater["endpoints"], serde_json::json!([]));
        assert_eq!(updater["dangerousInsecureTransportProtocol"], true);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn desktop_development_logging_is_control_safe_and_visible_by_default() {
        assert_eq!(
            default_development_tracing_filter(),
            "wts_desktop=info,wts_app::repository_catalog=info,wts_app::repository_clone=info,wts_app::runtime_analysis=info,wts_app::operations=info"
        );
        assert_eq!(
            bounded_development_log_text("infra\nworkspace", 64),
            "infra�workspace"
        );
        assert_eq!(bounded_development_log_text("abcdef", 3), "abc");
        assert_eq!(
            bounded_development_log_text(
                "vscode-remote://user:secret@host/repo?token=sentinel",
                4096
            ),
            "<unsupported-uri>"
        );
        assert_eq!(
            bounded_development_log_text(
                "vscode-remote:user:secret@host/repo?token=sentinel",
                4096
            ),
            "<unsupported-uri>"
        );
        assert_eq!(
            bounded_development_log_text(r"C:\repos\checkout-api", 4096),
            r"C:\repos\checkout-api"
        );
    }

    #[test]
    fn saved_verification_summary_native_adapter_preserves_scope_and_permission() {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        std::fs::create_dir(&repositories).unwrap();
        let service = LocalWtsService::open(directory.path().join("data"), "summary-test", directory.path().join("workspaces"), repositories).unwrap();
        assert_eq!(get_workspace_verification_summary_command(&service, "invalid").unwrap_err().code, "invalid_request");
        assert_eq!(get_workspace_verification_summary_command(&service, &Uuid::new_v4().to_string()).unwrap_err().code, "workspace_not_found");
        let capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(capability["permissions"].as_array().unwrap().iter().any(|permission| permission == "allow-get-workspace-verification-summary"));
        let permission = std::fs::read_to_string(format!("{}/permissions/autogenerated/get_workspace_verification_summary.toml", env!("CARGO_MANIFEST_DIR"))).unwrap();
        assert!(permission.contains("commands.allow = [\"get_workspace_verification_summary\"]"));
    }

    #[test]
    fn setup_recovery_native_adapter_rejects_invalid_scope_before_service_dispatch() {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        std::fs::create_dir(&repositories).unwrap();
        let service = LocalWtsService::open(
            directory.path().join("data"),
            "native-recovery-test",
            directory.path().join("workspaces"),
            &repositories,
        )
        .unwrap();
        let workspace_id = Uuid::new_v4().to_string();
        for digest in ["", " ", "sha256:short", "sha256:../../outside"] {
            let rejected =
                recover_workspace_setup_command(&service, &workspace_id, digest).unwrap_err();
            assert_eq!(rejected.code, "invalid_request", "{digest}");
        }
        let digest = format!("sha256:{}", "a".repeat(64));
        assert_eq!(
            recover_workspace_setup_command(&service, "not-a-uuid", &digest)
                .unwrap_err()
                .code,
            "invalid_request"
        );
        assert_eq!(
            recover_workspace_setup_command(&service, &workspace_id, &digest)
                .unwrap_err()
                .code,
            "workspace_not_found"
        );
        assert_eq!(
            local_wts_command_error(LocalWtsError::StalePreflight).code,
            "stale_preflight"
        );
    }

    #[test]
    fn setup_recovery_native_capability_and_preflight_preserve_the_exact_review() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(
            capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|permission| permission == "allow-recover-workspace-setup")
        );
        assert!(include_str!("../build.rs").contains("\"recover_workspace_setup\""));
        let wire = serde_json::json!({
            "workspaceId": Uuid::new_v4(), "workspaceDisplayPath":"/tmp/wts/workspace",
            "codeWorkspaceDisplayPath":"/tmp/wts/workspace/workspace.code-workspace",
            "branchName":"wts/recovery", "ready":false, "effectDigest":format!("sha256:{}", "b".repeat(64)),
            "repositories":[], "blockers":[], "warnings":[],
            "graph":{"status":"notStarted","detail":"Setup has not finished."},
            "setupRecovery":{"effectDigest":format!("sha256:{}", "a".repeat(64)), "ready":false,
                "paths":["/tmp/wts/workspace/api"], "blockers":["Keep the changed files before recovery."]}
        });
        let preflight: WorkspacePreflight = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(preflight).unwrap(), wire);
        let mut unknown = wire;
        unknown["setupRecovery"]["deleteUnrelatedPaths"] = serde_json::json!(true);
        assert!(serde_json::from_value::<WorkspacePreflight>(unknown).is_err());
        let permission = std::fs::read_to_string(format!(
            "{}/permissions/autogenerated/recover_workspace_setup.toml",
            env!("CARGO_MANIFEST_DIR")
        ))
        .unwrap();
        assert!(permission.contains("commands.allow = [\"recover_workspace_setup\"]"));
    }

    #[test]
    fn desktop_capability_exposes_manual_workspace_commands() {
        let capability = include_str!("../capabilities/default.json");
        let build = include_str!("../build.rs");
        let notification_permission =
            include_str!("../permissions/autogenerated/send_desktop_notification.toml");
        let permission = include_str!("../permissions/autogenerated/open_repository_base.toml");
        let clone_permission = include_str!("../permissions/autogenerated/clone_repository.toml");
        let runtime_permission =
            include_str!("../permissions/autogenerated/analyze_workspace_runtime.toml");
        let activity_watch_permission =
            include_str!("../permissions/autogenerated/get_activity_watch_status.toml");
        let activity_watch_review_permission =
            include_str!("../permissions/autogenerated/get_activity_watch_daily_review.toml");
        let time_review_brief_permission =
            include_str!("../permissions/autogenerated/get_activity_watch_time_review_brief.toml");
        let active_jira_permission =
            include_str!("../permissions/autogenerated/list_active_jira_issues.toml");
        let agent_sessions_permission =
            include_str!("../permissions/autogenerated/list_agent_sessions.toml");
        let agent_brief_permission =
            include_str!("../permissions/autogenerated/write_workspace_agent_brief.toml");
        let repository_sync_permission =
            include_str!("../permissions/autogenerated/sync_workspace_repository.toml");
        let repository_review_graph_permission =
            include_str!("../permissions/autogenerated/get_workspace_repository_review_graph.toml");
        let repository_file_review_permission =
            include_str!("../permissions/autogenerated/get_workspace_repository_file_review.toml");
        let repository_alignment_preflight_permission = include_str!(
            "../permissions/autogenerated/preflight_workspace_repository_alignment.toml"
        );
        let repository_alignment_permission =
            include_str!("../permissions/autogenerated/align_workspace_repository.toml");
        let workflow_permission =
            include_str!("../permissions/autogenerated/transition_workspace_workflow.toml");
        let board_placement_permission =
            include_str!("../permissions/autogenerated/place_workspace_on_board.toml");
        let follow_agent_permission =
            include_str!("../permissions/autogenerated/follow_workspace_agent.toml");
        let planning_list_permission =
            include_str!("../permissions/autogenerated/list_workspace_planning_documents.toml");
        let planning_read_permission =
            include_str!("../permissions/autogenerated/read_workspace_planning_document.toml");
        let planning_update_permission =
            include_str!("../permissions/autogenerated/update_workspace_planning_document.toml");
        let review_list_permission =
            include_str!("../permissions/autogenerated/list_workspace_review_threads.toml");
        let review_create_permission =
            include_str!("../permissions/autogenerated/create_workspace_review_thread.toml");
        let review_resolve_permission =
            include_str!("../permissions/autogenerated/resolve_workspace_review_thread.toml");
        assert!(capability.contains("\"allow-import-code-workspace-file\""));
        assert!(capability.contains("\"allow-send-desktop-notification\""));
        assert!(capability.contains("\"allow-reindex-workspace-graph\""));
        assert!(capability.contains("\"allow-preflight-workspace-removal\""));
        assert!(capability.contains("\"allow-remove-workspace\""));
        assert!(capability.contains("\"allow-open-repository-base\""));
        assert!(capability.contains("\"allow-clone-repository\""));
        assert!(capability.contains("\"allow-analyze-workspace-runtime\""));
        assert!(capability.contains("\"allow-get-activity-watch-status\""));
        assert!(capability.contains("\"allow-get-activity-watch-daily-review\""));
        assert!(capability.contains("\"allow-get-activity-watch-time-review-brief\""));
        assert!(capability.contains("\"allow-list-active-jira-issues\""));
        assert!(capability.contains("\"allow-list-agent-sessions\""));
        assert!(capability.contains("\"allow-write-workspace-agent-brief\""));
        assert!(capability.contains("\"allow-sync-workspace-repository\""));
        assert!(capability.contains("\"allow-get-workspace-repository-review-graph\""));
        assert!(capability.contains("\"allow-get-workspace-repository-file-review\""));
        assert!(capability.contains("\"allow-preflight-workspace-repository-alignment\""));
        assert!(capability.contains("\"allow-align-workspace-repository\""));
        assert!(capability.contains("\"allow-transition-workspace-workflow\""));
        assert!(capability.contains("\"allow-place-workspace-on-board\""));
        assert!(capability.contains("\"allow-follow-workspace-agent\""));
        assert!(capability.contains("\"allow-list-workspace-planning-documents\""));
        assert!(capability.contains("\"allow-read-workspace-planning-document\""));
        assert!(capability.contains("\"allow-update-workspace-planning-document\""));
        assert!(capability.contains("\"allow-list-workspace-review-threads\""));
        assert!(capability.contains("\"allow-create-workspace-review-thread\""));
        assert!(capability.contains("\"allow-resolve-workspace-review-thread\""));
        assert!(build.contains("\"open_repository_base\""));
        assert!(build.contains("\"send_desktop_notification\""));
        assert!(build.contains("\"clone_repository\""));
        assert!(build.contains("\"analyze_workspace_runtime\""));
        assert!(build.contains("\"get_activity_watch_status\""));
        assert!(build.contains("\"get_activity_watch_daily_review\""));
        assert!(build.contains("\"get_activity_watch_time_review_brief\""));
        assert!(build.contains("\"list_active_jira_issues\""));
        assert!(build.contains("\"list_agent_sessions\""));
        assert!(build.contains("\"write_workspace_agent_brief\""));
        assert!(build.contains("\"sync_workspace_repository\""));
        assert!(build.contains("\"get_workspace_repository_review_graph\""));
        assert!(build.contains("\"get_workspace_repository_file_review\""));
        assert!(build.contains("\"preflight_workspace_repository_alignment\""));
        assert!(build.contains("\"align_workspace_repository\""));
        assert!(build.contains("\"transition_workspace_workflow\""));
        assert!(build.contains("\"place_workspace_on_board\""));
        assert!(build.contains("\"follow_workspace_agent\""));
        assert!(build.contains("\"list_workspace_planning_documents\""));
        assert!(build.contains("\"read_workspace_planning_document\""));
        assert!(build.contains("\"update_workspace_planning_document\""));
        assert!(build.contains("\"list_workspace_review_threads\""));
        assert!(build.contains("\"create_workspace_review_thread\""));
        assert!(build.contains("\"resolve_workspace_review_thread\""));
        assert!(permission.contains("commands.allow = [\"open_repository_base\"]"));
        assert!(
            notification_permission.contains("commands.allow = [\"send_desktop_notification\"]")
        );
        assert!(clone_permission.contains("commands.allow = [\"clone_repository\"]"));
        assert!(runtime_permission.contains("commands.allow = [\"analyze_workspace_runtime\"]"));
        assert!(
            activity_watch_permission.contains("commands.allow = [\"get_activity_watch_status\"]")
        );
        assert!(
            activity_watch_review_permission
                .contains("commands.allow = [\"get_activity_watch_daily_review\"]")
        );
        assert!(
            time_review_brief_permission
                .contains("commands.allow = [\"get_activity_watch_time_review_brief\"]")
        );
        assert!(active_jira_permission.contains("commands.allow = [\"list_active_jira_issues\"]"));
        assert!(agent_sessions_permission.contains("commands.allow = [\"list_agent_sessions\"]"));
        assert!(
            agent_brief_permission.contains("commands.allow = [\"write_workspace_agent_brief\"]")
        );
        assert!(
            repository_sync_permission.contains("commands.allow = [\"sync_workspace_repository\"]")
        );
        assert!(
            repository_review_graph_permission
                .contains("commands.allow = [\"get_workspace_repository_review_graph\"]")
        );
        assert!(
            repository_file_review_permission
                .contains("commands.allow = [\"get_workspace_repository_file_review\"]")
        );
        assert!(
            repository_alignment_preflight_permission
                .contains("commands.allow = [\"preflight_workspace_repository_alignment\"]")
        );
        assert!(
            repository_alignment_permission
                .contains("commands.allow = [\"align_workspace_repository\"]")
        );
        assert!(
            workflow_permission.contains("commands.allow = [\"transition_workspace_workflow\"]")
        );
        assert!(
            board_placement_permission.contains("commands.allow = [\"place_workspace_on_board\"]")
        );
        assert!(follow_agent_permission.contains("commands.allow = [\"follow_workspace_agent\"]"));
        assert!(
            planning_list_permission
                .contains("commands.allow = [\"list_workspace_planning_documents\"]")
        );
        assert!(
            planning_read_permission
                .contains("commands.allow = [\"read_workspace_planning_document\"]")
        );
        assert!(
            planning_update_permission
                .contains("commands.allow = [\"update_workspace_planning_document\"]")
        );
        assert!(
            review_list_permission.contains("commands.allow = [\"list_workspace_review_threads\"]")
        );
        assert!(
            review_create_permission
                .contains("commands.allow = [\"create_workspace_review_thread\"]")
        );
        assert!(
            review_resolve_permission
                .contains("commands.allow = [\"resolve_workspace_review_thread\"]")
        );
    }

    #[test]
    fn planning_and_workflow_failures_have_stable_command_error_codes() {
        assert_eq!(
            local_wts_command_error(LocalWtsError::PlanningDocumentConflict).code,
            "planning_document_conflict"
        );
        assert_eq!(
            local_wts_command_error(LocalWtsError::InvalidPlanningDocument).code,
            "invalid_planning_document"
        );
        assert_eq!(
            workspace_command_error(WorkspaceStoreError::WorkspaceWorkflowConflict {
                expected: 1,
                actual: 2,
            })
            .code,
            "workspace_workflow_conflict"
        );
    }

    #[test]
    fn desktop_capability_exposes_managed_agent_commands() {
        let capability = include_str!("../capabilities/default.json");
        let build = include_str!("../build.rs");
        for (command, permission) in [
            ("list_agent_sessions", "allow-list-agent-sessions"),
            ("get_agent_session_detail", "allow-get-agent-session-detail"),
            ("start_agent_session", "allow-start-agent-session"),
            ("heartbeat_agent_session", "allow-heartbeat-agent-session"),
            ("finish_agent_session", "allow-finish-agent-session"),
            ("fail_agent_session", "allow-fail-agent-session"),
            ("launch_agent_session", "allow-launch-agent-session"),
            ("stop_agent_session", "allow-stop-agent-session"),
        ] {
            let permission_file = std::fs::read_to_string(format!(
                "{}/permissions/autogenerated/{command}.toml",
                env!("CARGO_MANIFEST_DIR")
            ))
            .expect("generated agent permission");
            assert!(build.contains(&format!("\"{command}\"")));
            assert!(capability.contains(&format!("\"{permission}\"")));
            assert!(permission_file.contains(&format!("commands.allow = [\"{command}\"]")));
        }
    }

    #[test]
    fn desktop_capability_exposes_granular_verification_commands() {
        let capability = include_str!("../capabilities/default.json");
        let build = include_str!("../build.rs");
        for (command, permission) in [
            (
                "run_workspace_verification_check",
                "allow-run-workspace-verification-check",
            ),
            (
                "rerun_failed_workspace_verification",
                "allow-rerun-failed-workspace-verification",
            ),
            (
                "cancel_workspace_verification",
                "allow-cancel-workspace-verification",
            ),
        ] {
            assert!(build.contains(&format!("\"{command}\"")));
            assert!(capability.contains(&format!("\"{permission}\"")));
        }
    }
}
