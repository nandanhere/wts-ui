use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentChangeRequestProposal, AgentProvider, AgentReportStatus, AgentSessionStatus, ArtifactKind,
    ArtifactMetadata, ChangeRequestDraftTarget, CloneRepositoryRequest, CodeWorkspaceImportRequest,
    CreateWorkspaceReviewThreadRequest, ExternalLauncher, GitlabMergeRequestTarget, JourneyAction,
    JourneyPlan, JourneyStep, LaunchFailure, LocalWtsError, LocalWtsService,
    MAX_PLANNING_DOCUMENT_BYTES, OpenWorkspaceChangeRequestDraft, PreflightBlockerCode,
    PrepareWorkspaceChangeRequest, ProcessWorkspaceAdapter, PublishWorkspaceChangeRequestBranch,
    RemovalBlockerCode, RepositoryBaseTarget, RepositoryForge, ResolveWorkspaceReviewThreadRequest,
    ReviewAnchorState, ReviewAuthor, ReviewCodeSide, ReviewTarget, ReviewThreadState,
    RuntimeAnalysisRequest, TEST_RUN_SCHEMA_VERSION, TerminalProvider, TestArtifactStore,
    TestRunResult, TestRunState, TestStepResult, TestStepState,
    UpdateWorkspacePlanningDocumentRequest, VerificationCheckStatus, VerificationStatus,
    WORKSPACE_EVIDENCE_SCHEMA_VERSION, WorkspaceGraphEvidenceStatus, WorkspacePlanningDocumentId,
    WorkspaceRemovalKind, WorkspaceWorkItemProvider, WorkspaceWorkItemRole,
};
use wts_core::workspace::{
    AddWorkspaceRepositoryRequest, CreateWorkspaceRequest, FollowWorkspaceAgentRequest,
    PlaceWorkspaceOnBoardRequest, RenameWorkspaceRequest, RuntimePlanSelection, RuntimePortPolicy,
    RuntimePortSelection, RuntimeServiceSelection, TransitionWorkspaceWorkflowRequest,
    WorkspaceIntent, WorkspaceMaterializationState, WorkspacePlanningFolder,
    WorkspacePlanningFormat, WorkspacePlanningSelection, WorkspaceProvider,
    WorkspaceRepositoryRequest, WorkspaceWorkflowState,
};
use wts_store::{WorkspaceBoardPlacementMode, WorkspaceStoreError};

#[derive(Clone, Default)]
struct RecordingLauncher {
    launched_vscode: Arc<Mutex<Vec<PathBuf>>>,
    launched_cli: Arc<Mutex<Vec<(PathBuf, AgentProvider, TerminalProvider)>>>,
    launched_repository_bases: Arc<Mutex<Vec<RepositoryBaseTarget>>>,
    launched_change_request_drafts: Arc<Mutex<Vec<ChangeRequestDraftTarget>>>,
    launched_gitlab_merge_requests: Arc<Mutex<Vec<GitlabMergeRequestTarget>>>,
    launched_jira_issues: Arc<Mutex<Vec<wts_app::JiraIssueTarget>>>,
    cli_failure: Arc<Mutex<Option<LaunchFailure>>>,
}

#[test]
fn local_service_exposes_atomic_board_placement_and_follow_agent() {
    let fixture = Fixture::new();
    let created = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "board-placement".to_owned(),
                },
                title: "Board placement".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "checkout-api".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: None,
            },
        )
        .expect("create workspace")
        .workspace;
    let pinned = fixture
        .service
        .place_workspace_on_board(
            created.workspace_id,
            PlaceWorkspaceOnBoardRequest {
                state: WorkspaceWorkflowState::Review,
                expected_revision: created.workflow.revision,
                before_workspace_id: None,
                after_workspace_id: None,
            },
        )
        .expect("place workspace");
    assert_eq!(pinned.placement.mode, WorkspaceBoardPlacementMode::Pinned);
    let ignored = fixture
        .service
        .transition_workspace_workflow(
            created.workspace_id,
            TransitionWorkspaceWorkflowRequest {
                state: WorkspaceWorkflowState::Active,
                expected_revision: pinned.revision,
            },
        )
        .expect("ignore automatic move while pinned");
    assert_eq!(ignored, pinned);
    let following = fixture
        .service
        .follow_workspace_agent(
            created.workspace_id,
            FollowWorkspaceAgentRequest {
                expected_revision: pinned.revision,
            },
        )
        .expect("follow agent");
    assert_eq!(
        following.placement.mode,
        WorkspaceBoardPlacementMode::Automatic
    );
}

#[test]
fn planning_review_threads_keep_their_digest_anchor_and_report_staleness() {
    let fixture = Fixture::new();
    let created = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "review-feedback".to_owned(),
                },
                title: "Review feedback".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "checkout-api".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: Some(WorkspacePlanningSelection {
                    folder: WorkspacePlanningFolder::Plans,
                    format: WorkspacePlanningFormat::Notes,
                }),
            },
        )
        .expect("planning workspace");
    let workspace_id = created.workspace.workspace_id;
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("planning preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize planning workspace");
    let workspace_path = PathBuf::from(&materialized.materialization.workspace_display_path);
    let review_inbox_path = workspace_path.join(".wts/review-inbox.json");
    let initial_inbox: serde_json::Value =
        serde_json::from_slice(&fs::read(&review_inbox_path).expect("read initial review inbox"))
            .expect("parse initial review inbox");
    assert_eq!(initial_inbox["schemaVersion"], 1);
    assert_eq!(initial_inbox["workspaceId"], workspace_id.to_string());
    assert_eq!(initial_inbox["openThreadCount"], 0);
    assert_eq!(initial_inbox["openThreads"], serde_json::json!([]));
    let guide = fs::read_to_string(workspace_path.join("WTS.md")).expect("read agent guide");
    assert!(guide.contains("Read `.wts/review-inbox.json`"), "{guide}");
    let original = fixture
        .service
        .read_workspace_planning_document(workspace_id, WorkspacePlanningDocumentId::Plan)
        .expect("read plan");
    let anchor_digest = original.sha256.clone();
    let thread = fixture
        .service
        .create_workspace_review_thread(
            workspace_id,
            CreateWorkspaceReviewThreadRequest {
                target: ReviewTarget::PlanningDocument {
                    document_id: WorkspacePlanningDocumentId::Plan,
                    document_sha256: original.sha256.clone(),
                    line: Some(1),
                },
                author: ReviewAuthor::User,
                body: "Explain this scope.".into(),
            },
        )
        .expect("create review thread");
    assert_eq!(thread.anchor_state, ReviewAnchorState::Current);
    let created_inbox: serde_json::Value =
        serde_json::from_slice(&fs::read(&review_inbox_path).expect("read created review inbox"))
            .expect("parse created review inbox");
    assert_eq!(created_inbox["openThreadCount"], 1);
    assert_eq!(created_inbox["includedOpenThreadCount"], 1);
    assert_eq!(created_inbox["truncated"], false);
    assert_eq!(
        created_inbox["openThreads"][0]["comments"][0]["body"],
        "Explain this scope."
    );

    let updated = fixture
        .service
        .update_workspace_planning_document(
            workspace_id,
            WorkspacePlanningDocumentId::Plan,
            UpdateWorkspacePlanningDocumentRequest {
                expected_sha256: original.sha256,
                contents: "# Revised plan\n".into(),
            },
        )
        .expect("update plan");
    fixture
        .service
        .open_workspace_cli(
            workspace_id,
            AgentProvider::Codex,
            TerminalProvider::Terminal,
        )
        .expect("refresh agent handoff");
    let stale_inbox: serde_json::Value =
        serde_json::from_slice(&fs::read(&review_inbox_path).expect("read refreshed review inbox"))
            .expect("parse refreshed review inbox");
    assert_eq!(stale_inbox["openThreads"][0]["anchorState"], "stale");
    assert_eq!(
        stale_inbox["openThreads"][0]["currentDocumentSha256"],
        updated.sha256
    );
    let listed = fixture
        .service
        .list_workspace_review_threads(workspace_id)
        .expect("list review threads");
    assert_eq!(listed.threads[0].anchor_state, ReviewAnchorState::Stale);
    assert_eq!(
        listed.threads[0].current_document_sha256.as_deref(),
        Some(updated.sha256.as_str())
    );
    let ReviewTarget::PlanningDocument {
        document_sha256, ..
    } = &listed.threads[0].target
    else {
        panic!("expected planning review target");
    };
    assert_eq!(document_sha256, &anchor_digest);

    let resolved = fixture
        .service
        .resolve_workspace_review_thread(
            workspace_id,
            thread.thread_id,
            ResolveWorkspaceReviewThreadRequest {
                expected_revision: thread.revision,
            },
        )
        .expect("resolve review thread");
    assert_eq!(resolved.state, ReviewThreadState::Resolved);
    let resolved_inbox: serde_json::Value =
        serde_json::from_slice(&fs::read(&review_inbox_path).expect("read resolved review inbox"))
            .expect("parse resolved review inbox");
    assert_eq!(resolved_inbox["openThreadCount"], 0);
    assert_eq!(resolved_inbox["resolvedThreadCount"], 1);
    assert_eq!(resolved_inbox["openThreads"], serde_json::json!([]));

    for index in 0..65 {
        fixture
            .service
            .create_workspace_review_thread(
                workspace_id,
                CreateWorkspaceReviewThreadRequest {
                    target: ReviewTarget::PlanningDocument {
                        document_id: WorkspacePlanningDocumentId::Plan,
                        document_sha256: updated.sha256.clone(),
                        line: None,
                    },
                    author: ReviewAuthor::User,
                    body: format!("Review note {index}."),
                },
            )
            .expect("create bounded review feedback");
    }
    let bounded_bytes = fs::read(&review_inbox_path).expect("read bounded review inbox");
    assert!(bounded_bytes.len() <= 240 * 1024);
    let bounded_inbox: serde_json::Value =
        serde_json::from_slice(&bounded_bytes).expect("parse bounded review inbox");
    assert_eq!(bounded_inbox["openThreadCount"], 65);
    assert_eq!(bounded_inbox["includedOpenThreadCount"], 64);
    assert_eq!(
        bounded_inbox["openThreads"].as_array().map(Vec::len),
        Some(64)
    );
    assert_eq!(bounded_inbox["truncated"], true);
}

#[cfg(unix)]
#[test]
fn agent_handoff_refuses_a_symlinked_review_inbox() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let inbox = workspace_path.join(".wts/review-inbox.json");
    let outside = fixture._directory.path().join("outside-review-inbox.json");
    fs::write(&outside, "outside stays unchanged\n").expect("write outside target");
    fs::remove_file(&inbox).expect("remove managed inbox");
    symlink(&outside, &inbox).expect("symlink managed inbox");

    assert!(matches!(
        fixture.service.open_workspace_cli(
            workspace_id,
            AgentProvider::Codex,
            TerminalProvider::Terminal,
        ),
        Err(LocalWtsError::InvalidMaterializationManifest)
    ));
    assert_eq!(
        fs::read_to_string(outside).expect("outside target"),
        "outside stays unchanged\n"
    );
    assert!(
        fixture
            .launcher
            .launched_cli
            .lock()
            .expect("CLI launcher lock")
            .is_empty()
    );
}

#[cfg(unix)]
#[test]
fn committed_review_feedback_survives_a_broken_derived_inbox() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let workspace_id = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "review-inbox-recovery".to_owned(),
                },
                title: "Review inbox recovery".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "checkout-api".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: Some(WorkspacePlanningSelection {
                    folder: WorkspacePlanningFolder::Plans,
                    format: WorkspacePlanningFormat::Notes,
                }),
            },
        )
        .expect("planning workspace")
        .workspace
        .workspace_id;
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let plan = fixture
        .service
        .read_workspace_planning_document(workspace_id, WorkspacePlanningDocumentId::Plan)
        .expect("read plan");
    let inbox = workspace_path.join(".wts/review-inbox.json");
    let outside = fixture._directory.path().join("outside-review-inbox.json");
    fs::write(&outside, "outside stays unchanged\n").expect("write outside target");
    fs::remove_file(&inbox).expect("remove managed inbox");
    symlink(&outside, &inbox).expect("symlink managed inbox");

    let created = fixture
        .service
        .create_workspace_review_thread(
            workspace_id,
            CreateWorkspaceReviewThreadRequest {
                target: ReviewTarget::PlanningDocument {
                    document_id: WorkspacePlanningDocumentId::Plan,
                    document_sha256: plan.sha256,
                    line: Some(1),
                },
                author: ReviewAuthor::User,
                body: "Keep this committed feedback.".to_owned(),
            },
        )
        .expect("committed create must remain successful");
    let resolved = fixture
        .service
        .resolve_workspace_review_thread(
            workspace_id,
            created.thread_id,
            ResolveWorkspaceReviewThreadRequest {
                expected_revision: created.revision,
            },
        )
        .expect("committed resolve must remain successful");

    assert_eq!(resolved.state, ReviewThreadState::Resolved);
    assert_eq!(
        fixture
            .service
            .list_workspace_review_threads(workspace_id)
            .expect("list authoritative feedback")
            .threads
            .len(),
        1
    );
    assert_eq!(
        fs::read_to_string(outside).expect("outside target"),
        "outside stays unchanged\n"
    );
}

impl ExternalLauncher for RecordingLauncher {
    fn launch_vscode(&self, code_workspace: &Path) -> Result<(), LaunchFailure> {
        self.launched_vscode
            .lock()
            .expect("launcher lock")
            .push(code_workspace.to_owned());
        Ok(())
    }

    fn launch_cli(
        &self,
        workspace: &Path,
        provider: AgentProvider,
        terminal: TerminalProvider,
    ) -> Result<(), LaunchFailure> {
        if let Some(failure) = self.cli_failure.lock().expect("CLI failure lock").take() {
            return Err(failure);
        }
        self.launched_cli.lock().expect("CLI launcher lock").push((
            workspace.to_owned(),
            provider,
            terminal,
        ));
        Ok(())
    }

    fn launch_repository_base(&self, target: &RepositoryBaseTarget) -> Result<(), LaunchFailure> {
        self.launched_repository_bases
            .lock()
            .expect("repository-base launcher lock")
            .push(target.clone());
        Ok(())
    }

    fn launch_change_request_draft(
        &self,
        target: &ChangeRequestDraftTarget,
    ) -> Result<(), LaunchFailure> {
        self.launched_change_request_drafts
            .lock()
            .expect("change-request launcher lock")
            .push(target.clone());
        Ok(())
    }

    fn launch_gitlab_merge_request(
        &self,
        target: &GitlabMergeRequestTarget,
    ) -> Result<(), LaunchFailure> {
        self.launched_gitlab_merge_requests
            .lock()
            .expect("GitLab merge request launcher lock")
            .push(target.clone());
        Ok(())
    }

    fn launch_jira_issue(&self, target: &wts_app::JiraIssueTarget) -> Result<(), LaunchFailure> {
        self.launched_jira_issues
            .lock()
            .expect("Jira launcher lock")
            .push(target.clone());
        Ok(())
    }
}

#[cfg(unix)]
#[test]
fn managed_agent_process_drives_the_persisted_session_lifecycle() {
    use std::os::unix::fs::PermissionsExt;

    let executable_fixture = tempfile::tempdir().expect("agent executable fixture");
    let executable = executable_fixture.path().join("fake-codex");
    fs::write(
        &executable,
        r#"#!/bin/sh
prompt=
for argument in "$@"; do
  prompt=$argument
done
case "$prompt" in
  complete)
    sleep 0.3
    printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'
    ;;
  detail-private-task)
    printf '%s\n' '{"type":"item.started","item":{"type":"command_execution","command":"private command"}}'
    printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"I found the failing boundary."}}'
    sleep 0.5
    printf '%s\n' '{"type":"turn.completed","usage":{"private":"value"}}'
    ;;
  fail)
    sleep 0.3
    printf '%s\n' 'provider failed' >&2
    exit 9
    ;;
  stop)
    sleep 30 &
    descendant=$!
    printf '%s' "$descendant" > "$PWD/managed-descendant.pid"
    wait "$descendant"
    ;;
esac
"#,
    )
    .expect("fake agent executable");
    let mut permissions = fs::metadata(&executable)
        .expect("fake executable metadata")
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&executable, permissions).expect("fake executable permissions");

    let adapter =
        ProcessWorkspaceAdapter::default().with_agent_executable(AgentProvider::Codex, executable);
    let fixture = Fixture::with_agent_adapter(adapter);
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");

    let completing = fixture
        .service
        .launch_agent_session(
            workspace_id,
            AgentProvider::Codex,
            "complete",
            wts_app::AgentSessionCategory::Implementation,
        )
        .expect("launch completing agent");
    assert_eq!(completing.status, AgentSessionStatus::Launching);
    wait_for_session_status(
        &fixture.service,
        completing.session_id,
        AgentSessionStatus::Running,
    );
    let completed = wait_for_session_status(
        &fixture.service,
        completing.session_id,
        AgentSessionStatus::Completed,
    );
    assert_eq!(completed.failure, None);

    let detailed = fixture
        .service
        .launch_agent_session(
            workspace_id,
            AgentProvider::Codex,
            "detail-private-task",
            wts_app::AgentSessionCategory::Investigation,
        )
        .expect("launch observable agent");
    wait_for_session_status(
        &fixture.service,
        detailed.session_id,
        AgentSessionStatus::Running,
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    let detail = loop {
        let detail = fixture
            .service
            .get_agent_session_detail(detailed.session_id)
            .expect("live agent detail");
        if detail
            .events
            .iter()
            .any(|event| event.kind == wts_app::AgentSessionEventKind::AgentUpdate)
        {
            break detail;
        }
        assert!(Instant::now() < deadline, "agent did not publish progress");
        thread::sleep(Duration::from_millis(10));
    };
    assert_eq!(detail.task, "detail-private-task");
    assert_eq!(
        detail.model_selection.authority,
        wts_app::AgentModelAuthority::ProviderDefault
    );
    assert_eq!(detail.model_selection.model, None);
    assert!(detail.events.iter().any(|event| {
        event.kind == wts_app::AgentSessionEventKind::RunsCommand
            && event.summary == "Codex runs a command."
    }));
    assert!(detail.events.iter().any(|event| {
        event.kind == wts_app::AgentSessionEventKind::AgentUpdate
            && event.summary == "I found the failing boundary."
    }));
    let serialized = serde_json::to_string(&detail).expect("serialized agent detail");
    assert!(!serialized.contains("private command"));
    assert!(!serialized.contains("private\":\"value"));
    let durable_ledger = fs::read_to_string(fixture.data_dir.join("agent-sessions-v1.json"))
        .expect("durable session ledger");
    assert!(!durable_ledger.contains("detail-private-task"));
    assert!(!durable_ledger.contains("I found the failing boundary."));
    wait_for_session_status(
        &fixture.service,
        detailed.session_id,
        AgentSessionStatus::Completed,
    );

    let failing = fixture
        .service
        .launch_agent_session(
            workspace_id,
            AgentProvider::Codex,
            "fail",
            wts_app::AgentSessionCategory::Verification,
        )
        .expect("launch failing agent");
    wait_for_session_status(
        &fixture.service,
        failing.session_id,
        AgentSessionStatus::Running,
    );
    let failed = wait_for_session_status(
        &fixture.service,
        failing.session_id,
        AgentSessionStatus::Failed,
    );
    assert_eq!(
        failed.failure,
        Some(wts_app::AgentSessionFailure::ProviderFailed)
    );

    let stopping = fixture
        .service
        .launch_agent_session(
            workspace_id,
            AgentProvider::Codex,
            "stop",
            wts_app::AgentSessionCategory::Review,
        )
        .expect("launch stoppable agent");
    wait_for_session_status(
        &fixture.service,
        stopping.session_id,
        AgentSessionStatus::Running,
    );
    let descendant_file = Path::new(&materialized.materialization.workspace_display_path)
        .join("managed-descendant.pid");
    let descendant = wait_for_numeric_pid(&descendant_file);
    let stop_requested = fixture
        .service
        .stop_agent_session(stopping.session_id)
        .expect("request stop");
    assert_eq!(stop_requested.status, AgentSessionStatus::Stopping);
    let interrupted = wait_for_session_status(
        &fixture.service,
        stopping.session_id,
        AgentSessionStatus::Interrupted,
    );
    assert_eq!(
        interrupted.failure,
        Some(wts_app::AgentSessionFailure::UserStopped)
    );
    wait_for_process_exit(descendant);
}

fn wait_for_session_status(
    service: &LocalWtsService,
    session_id: Uuid,
    expected: AgentSessionStatus,
) -> wts_app::AgentSession {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let session = service
            .list_agent_sessions(None)
            .expect("list agent sessions")
            .sessions
            .into_iter()
            .find(|session| session.session_id == session_id)
            .expect("managed session");
        if session.status == expected {
            return session;
        }
        assert!(
            Instant::now() < deadline,
            "agent session did not reach {expected:?}; last state was {:?}",
            session.status
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn wait_for_numeric_pid(path: &Path) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(value) = fs::read_to_string(path)
            && let Ok(process_id) = value.parse::<i32>()
        {
            return process_id;
        }
        assert!(
            Instant::now() < deadline,
            "agent descendant PID was not published"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn wait_for_process_exit(process_id: i32) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        // SAFETY: signal 0 checks process existence and does not change the process.
        let result = unsafe { libc::kill(process_id, 0) };
        if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return;
        }
        assert!(Instant::now() < deadline, "agent descendant survived stop");
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn rejected_cli_launch_persists_a_failed_launch_attempt() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");
    *fixture
        .launcher
        .cli_failure
        .lock()
        .expect("CLI failure lock") = Some(LaunchFailure::Rejected);

    assert!(matches!(
        fixture.service.open_workspace_cli(
            workspace_id,
            AgentProvider::Codex,
            TerminalProvider::Warp
        ),
        Err(LocalWtsError::AdapterRejected)
    ));
    let sessions = fixture
        .service
        .list_agent_sessions(None)
        .expect("global session ledger");
    assert_eq!(sessions.sessions.len(), 1);
    assert_eq!(sessions.sessions[0].workspace_id, workspace_id);
    assert_eq!(sessions.sessions[0].status, AgentSessionStatus::Failed);
    assert_eq!(
        sessions.sessions[0].failure,
        Some(wts_app::AgentSessionFailure::LaunchRejected)
    );
}

#[test]
fn workspace_agent_brief_replaces_only_the_managed_root_file() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let repository_path = workspace_path
        .read_dir()
        .expect("workspace entries")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.join(".git").exists())
        .expect("materialized repository");
    let repository_marker = repository_path.join("agent-brief-boundary.txt");
    let task = "# Verify checkout\n\nInspect `../../escaped.md`; do not create it.";

    let result = fixture
        .service
        .write_workspace_agent_brief(workspace_id, task)
        .expect("write managed brief");
    let brief_path = workspace_path.join("WTS.md");
    let brief = fs::read_to_string(&brief_path).expect("managed brief");

    assert_eq!(result.workspace_id, workspace_id);
    assert_eq!(
        Path::new(&result.workspace_display_path),
        workspace_path.as_path()
    );
    assert_eq!(Path::new(&result.brief_display_path), brief_path.as_path());
    assert!(brief.starts_with("# WTS workspace\n"), "{brief}");
    assert!(
        brief.contains("Publish findings through `wts-report --input"),
        "{brief}"
    );
    assert!(
        brief.contains("Use a simple present verb for an activity."),
        "{brief}"
    );
    assert!(
        brief.contains("Keep each status sentence at 20 words or fewer."),
        "{brief}"
    );
    assert!(
        brief.ends_with(&format!("## Current task\n\n{task}\n")),
        "{brief}"
    );
    assert!(!repository_marker.exists());
    assert!(
        !workspace_path
            .parent()
            .expect("workspace parent")
            .join("escaped.md")
            .exists()
    );
}

#[test]
fn workspace_agent_brief_rejects_invalid_content_without_changing_the_guide() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let brief_path = workspace_path.join("WTS.md");
    let original = fs::read(&brief_path).expect("original guide");

    for invalid in ["", " \n\t", "contains\0nul"] {
        assert!(matches!(
            fixture
                .service
                .write_workspace_agent_brief(workspace_id, invalid),
            Err(LocalWtsError::InvalidAgentPrompt)
        ));
        assert_eq!(
            fs::read(&brief_path).expect("unchanged guide"),
            original,
            "invalid content changed WTS.md"
        );
    }
    let oversized = "x".repeat(64 * 1024 + 1);
    assert!(matches!(
        fixture
            .service
            .write_workspace_agent_brief(workspace_id, &oversized),
        Err(LocalWtsError::InvalidAgentPrompt)
    ));
    assert_eq!(fs::read(&brief_path).expect("unchanged guide"), original);
}

#[test]
fn workspace_agent_brief_creates_the_managed_leaf_for_a_legacy_workspace() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let brief_path = workspace_path.join("WTS.md");
    fs::remove_file(&brief_path).expect("simulate a legacy workspace");

    let result = fixture
        .service
        .write_workspace_agent_brief(workspace_id, "Review the current workspace.");

    assert!(result.is_ok(), "{result:?}");
    let brief = fs::read_to_string(&brief_path).expect("created managed brief");
    assert!(brief.starts_with("# WTS workspace\n"), "{brief}");
    let sections = brief.split("\n## Current task\n").collect::<Vec<_>>();
    assert_eq!(sections.len(), 2, "{brief}");
    assert_eq!(sections[1], "\nReview the current workspace.\n");
}

#[test]
fn agent_handoff_refreshes_workspace_instructions_and_preserves_the_current_task() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let guide_path = workspace_path.join("WTS.md");
    let agents_path = workspace_path.join("AGENTS.md");
    let claude_path = workspace_path.join("CLAUDE.md");
    let cursor_path = workspace_path.join(".cursorrules");
    let copilot_path = workspace_path
        .join(".github")
        .join("copilot-instructions.md");
    let repository_path = workspace_path
        .read_dir()
        .expect("workspace entries")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_dir() && path.join(".git").exists())
        .expect("materialized repository");
    let repository_agents = repository_path.join("AGENTS.md");
    fs::write(
        &guide_path,
        "# Stale WTS guide\n\nOld behavior.\n\n## Current task\n\nPreserve this reviewed task.\n",
    )
    .expect("stale guide");
    fs::write(
        &agents_path,
        "# Old workspace instructions\n\n<!-- managed-by-wts: workspace-agents -->\n",
    )
    .expect("stale workspace instructions");
    fs::write(
        &claude_path,
        "# Old claude\n\n<!-- managed-by-wts: workspace-claude -->\n",
    )
    .expect("stale claude instructions");
    fs::write(
        &cursor_path,
        "# Old cursor\n\n<!-- managed-by-wts: workspace-cursorrules -->\n",
    )
    .expect("stale cursor instructions");
    fs::write(
        &copilot_path,
        "# Old copilot\n\n<!-- managed-by-wts: workspace-copilot -->\n",
    )
    .expect("stale copilot instructions");
    fs::write(
        &repository_agents,
        "# Repository instructions\n\nKeep this file.\n",
    )
    .expect("repository instructions");

    fixture
        .service
        .open_workspace_cli(
            workspace_id,
            AgentProvider::Codex,
            TerminalProvider::Terminal,
        )
        .expect("open refreshed agent handoff");

    let guide = fs::read_to_string(&guide_path).expect("refreshed WTS guide");
    assert!(guide.starts_with("# WTS workspace\n"), "{guide}");
    assert!(guide.contains("WTS guide version:"), "{guide}");
    assert!(!guide.contains("Old behavior."), "{guide}");
    assert!(
        guide.ends_with("## Current task\n\nPreserve this reviewed task.\n"),
        "{guide}"
    );
    let agents = fs::read_to_string(&agents_path).expect("refreshed workspace instructions");
    assert!(agents.contains("Read `WTS.md` before"), "{agents}");
    assert!(!agents.contains("Old workspace instructions"), "{agents}");
    let claude = fs::read_to_string(&claude_path).expect("refreshed claude instructions");
    assert!(claude.contains("Read `WTS.md` before"), "{claude}");
    assert!(!claude.contains("Old claude"), "{claude}");
    let cursor = fs::read_to_string(&cursor_path).expect("refreshed cursor instructions");
    assert!(cursor.contains("Read `WTS.md` before"), "{cursor}");
    assert!(!cursor.contains("Old cursor"), "{cursor}");
    let copilot = fs::read_to_string(&copilot_path).expect("refreshed copilot instructions");
    assert!(copilot.contains("Read `WTS.md` before"), "{copilot}");
    assert!(!copilot.contains("Old copilot"), "{copilot}");
    assert_eq!(
        fs::read_to_string(repository_agents).expect("repository instructions remain"),
        "# Repository instructions\n\nKeep this file.\n"
    );
}

#[test]
fn refresh_workspace_agent_files_refuses_to_overwrite_unmanaged_agent_files() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let claude_path = workspace_path.join("CLAUDE.md");
    fs::write(&claude_path, "# User custom claude without marker\n").expect("custom claude");

    assert!(matches!(
        fixture.service.open_workspace_cli(
            workspace_id,
            AgentProvider::Codex,
            TerminalProvider::Terminal,
        ),
        Err(wts_app::LocalWtsError::InvalidMaterializationManifest)
    ));
}

#[cfg(unix)]
#[test]
fn workspace_agent_brief_refuses_a_symlinked_managed_leaf() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let brief_path = workspace_path.join("WTS.md");
    let outside = fixture._directory.path().join("outside.md");
    fs::write(&outside, "outside stays unchanged\n").expect("outside target");
    fs::remove_file(&brief_path).expect("remove generated guide");
    symlink(&outside, &brief_path).expect("replace guide with symlink");

    assert!(matches!(
        fixture
            .service
            .write_workspace_agent_brief(workspace_id, "Do not follow the symlink."),
        Err(LocalWtsError::InvalidMaterializationManifest)
    ));
    assert_eq!(
        fs::read_to_string(&outside).expect("outside target"),
        "outside stays unchanged\n"
    );
}

struct Fixture {
    _directory: TempDir,
    service: LocalWtsService,
    launcher: RecordingLauncher,
    data_dir: PathBuf,
    repository_root: PathBuf,
    workspace_root: PathBuf,
    api: PathBuf,
    web: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        Self::with_agent_adapter(ProcessWorkspaceAdapter::default())
    }

    fn with_agent_adapter(adapter: ProcessWorkspaceAdapter) -> Self {
        let directory = tempfile::tempdir().expect("fixture root");
        let data_dir = directory.path().join("data");
        let repository_root = directory.path().join("repositories");
        let workspace_root = directory.path().join("workspaces");
        fs::create_dir(&repository_root).expect("repository root");
        let api = create_repository(&repository_root, "checkout-api");
        let web = create_repository(&repository_root, "checkout-web");
        let launcher = RecordingLauncher::default();
        let service = LocalWtsService::open_with_repository_roots_launcher_and_adapter(
            &data_dir,
            "test",
            &workspace_root,
            [repository_root.clone()],
            launcher.clone(),
            adapter,
        )
        .expect("local service");
        let workspace_root = workspace_root
            .canonicalize()
            .expect("canonical workspace root");
        Self {
            _directory: directory,
            service,
            launcher,
            data_dir,
            repository_root,
            workspace_root,
            api,
            web,
        }
    }

    fn create_plan(&self, repositories: &[&str]) -> Uuid {
        let result = self
            .service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::Jira {
                        issue_key: "PLATFORM-42".to_owned(),
                    },
                    title: "Fix duplicate checkout capture".to_owned(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: repositories
                        .iter()
                        .map(|label| WorkspaceRepositoryRequest {
                            repository_id: None,
                            label: (*label).to_owned(),
                            base_ref: "main".to_owned(),
                        })
                        .collect(),
                    runtime: None,
                    planning: None,
                },
            )
            .expect("workspace plan");
        result.workspace.workspace_id
    }

    fn reopen(&self, launcher: RecordingLauncher) -> LocalWtsService {
        LocalWtsService::open_with_launcher(
            &self.data_dir,
            "test",
            &self.workspace_root,
            &self.repository_root,
            launcher,
        )
        .expect("reopened local service")
    }
}

#[test]
fn jira_source_workspace_lists_its_creation_issue_as_the_primary_work_item() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);

    let result = fixture
        .service
        .list_workspace_work_item_links(workspace_id)
        .expect("list workspace work items");
    assert_eq!(result.schema_version, 1);
    assert_eq!(result.workspace_id, workspace_id);
    assert_eq!(result.links.len(), 1);
    let link = &result.links[0];
    assert_eq!(link.provider, WorkspaceWorkItemProvider::Jira);
    assert_eq!(link.role, WorkspaceWorkItemRole::Primary);
    assert_eq!(link.snapshot.issue_key, "PLATFORM-42");
    assert_eq!(link.snapshot.summary, None);
    assert_eq!(link.snapshot.status, None);
    assert_eq!(link.snapshot.content, "");
    assert_eq!(link.snapshot.browser_url, None);
    assert_eq!(link.snapshot.fetched_at_unix_ms, 0);
}

#[test]
fn discovers_repositories_and_reports_real_local_setup() {
    let fixture = Fixture::new();

    let catalog = fixture.service.repository_catalog().expect("catalog");
    assert_eq!(catalog.repositories.len(), 2);
    assert_eq!(
        catalog
            .repositories
            .iter()
            .map(|repository| repository.label.as_str())
            .collect::<Vec<_>>(),
        vec!["checkout-api", "checkout-web"]
    );
    assert_eq!(
        catalog
            .repositories
            .iter()
            .map(|repository| repository.default_branch.name.as_str())
            .collect::<Vec<_>>(),
        vec!["main", "main"]
    );
    assert!(catalog.repositories.iter().any(|repository| {
        repository.display_path
            == fixture
                .api
                .canonicalize()
                .expect("canonical api")
                .to_string_lossy()
    }));
    assert!(catalog.repositories.iter().any(|repository| {
        repository.display_path
            == fixture
                .web
                .canonicalize()
                .expect("canonical web")
                .to_string_lossy()
    }));

    let setup = fixture.service.setup_snapshot();
    assert_eq!(setup.repository_count, 2);
    assert_eq!(
        setup.integrations[0].id,
        wts_integrations::IntegrationId::Git
    );
}

#[test]
fn clone_request_reuses_an_existing_trusted_checkout_with_the_same_origin() {
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "origin",
            "https://github.com/acme/checkout-api.git",
        ],
    );

    let result = fixture
        .service
        .clone_repository(CloneRepositoryRequest {
            remote_url: "https://github.com/acme/checkout-api.git".to_owned(),
            branch: None,
            shallow: false,
        })
        .expect("reuse repository");

    assert!(result.reused_existing);
    assert_eq!(result.repository.label, "checkout-api");
    assert_eq!(
        result.repository.origin_url.as_deref(),
        Some("https://github.com/acme/checkout-api.git")
    );
    assert_eq!(
        result.repository.display_path,
        fixture
            .api
            .canonicalize()
            .expect("canonical repository path")
            .to_str()
            .expect("UTF-8 repository path")
    );
}

#[test]
fn clone_request_preserves_an_explicit_branch_in_a_full_clone() {
    let directory = tempfile::tempdir().expect("clone fixture");
    let source = create_repository(directory.path(), "source");
    git(Some(&source), ["checkout", "-b", "release/next"]);
    fs::write(source.join("release.txt"), "release commit\n").expect("release file");
    git(Some(&source), ["add", "release.txt"]);
    git(Some(&source), ["commit", "-m", "release"]);
    git(Some(&source), ["checkout", "main"]);
    let config = directory.path().join("clone.gitconfig");
    fs::write(
        &config,
        format!(
            "[url \"file://{}\"]\n\tinsteadOf = https://clone.example.invalid/release.git\n[protocol \"file\"]\n\tallow = always\n",
            source.display()
        ),
    )
    .expect("isolated clone configuration");
    let output = Command::new(std::env::current_exe().expect("test executable"))
        .args(["--exact", "clone_request_full_clone_child", "--nocapture"])
        .env("WTS_TEST_CLONE_ROOT", directory.path())
        .env("GIT_CONFIG_GLOBAL", &config)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .output()
        .expect("isolated clone test");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn clone_request_full_clone_child() {
    let Some(root) = std::env::var_os("WTS_TEST_CLONE_ROOT").map(PathBuf::from) else {
        return;
    };
    let repository_root = root.join("repositories");
    fs::create_dir(&repository_root).expect("repository root");
    let service = LocalWtsService::open_with_launcher(
        root.join("data"),
        "test",
        root.join("workspaces"),
        &repository_root,
        RecordingLauncher::default(),
    )
    .expect("clone service");
    let result = service
        .clone_repository(CloneRepositoryRequest {
            remote_url: "https://clone.example.invalid/release.git".to_owned(),
            branch: Some("release/next".to_owned()),
            shallow: false,
        })
        .expect("full clone");
    let wire = serde_json::to_value(&result).expect("clone response");
    assert_eq!(wire["selectedBaseRef"], "release/next");
    assert_eq!(result.repository.default_branch.name, "main");
    assert!(!result.reused_existing);
    assert_eq!(
        git_output(
            Some(Path::new(&result.repository.display_path)),
            ["branch", "--show-current"]
        )
        .trim(),
        "release/next"
    );
    let plan = service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "release".to_owned(),
                },
                title: "Release plan".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: Some(result.repository.id),
                    label: result.repository.label,
                    base_ref: wire["selectedBaseRef"]
                        .as_str()
                        .expect("selected branch")
                        .to_owned(),
                }],
                runtime: None,
                planning: None,
            },
        )
        .expect("save release plan");
    assert_eq!(plan.workspace.repositories[0].base_ref, "release/next");
}

#[test]
fn clone_request_reuses_local_and_cached_branches_without_changing_the_checkout() {
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "origin",
            "https://clone.example.invalid/release.git",
        ],
    );
    git(Some(&fixture.api), ["branch", "release/next"]);
    git(
        Some(&fixture.api),
        ["update-ref", "refs/remotes/origin/release/cached", "HEAD"],
    );
    fs::write(fixture.api.join("local-notes.txt"), "keep this file\n").expect("local work");
    let head = git_output(Some(&fixture.api), ["rev-parse", "HEAD"]);
    let refs = git_output(Some(&fixture.api), ["show-ref"]);
    let status = git_output(Some(&fixture.api), ["status", "--porcelain"]);

    for branch in ["release/next", "release/cached"] {
        let result = fixture
            .service
            .clone_repository(CloneRepositoryRequest {
                remote_url: "https://clone.example.invalid/release.git".to_owned(),
                branch: Some(branch.to_owned()),
                shallow: false,
            })
            .expect("reuse requested branch");
        assert!(result.reused_existing);
        assert_eq!(result.repository.default_branch.name, "main");
        assert_eq!(
            serde_json::to_value(result).expect("clone response")["selectedBaseRef"],
            branch
        );
    }
    assert_eq!(
        git_output(Some(&fixture.api), ["branch", "--show-current"]).trim(),
        "main"
    );
    assert_eq!(git_output(Some(&fixture.api), ["rev-parse", "HEAD"]), head);
    assert_eq!(git_output(Some(&fixture.api), ["show-ref"]), refs);
    assert_eq!(
        git_output(Some(&fixture.api), ["status", "--porcelain"]),
        status
    );
    assert!(!fixture.api.join(".git/FETCH_HEAD").exists());
}

#[test]
fn clone_request_rejects_a_branch_removed_after_the_catalog_snapshot() {
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "origin",
            "https://clone.example.invalid/release.git",
        ],
    );
    git(Some(&fixture.api), ["branch", "release/removed"]);
    fixture
        .service
        .repository_catalog()
        .expect("cached catalog");
    git(Some(&fixture.api), ["branch", "-D", "release/removed"]);
    let refs = git_output(Some(&fixture.api), ["show-ref"]);

    let error = fixture
        .service
        .clone_repository(CloneRepositoryRequest {
            remote_url: "https://clone.example.invalid/release.git".to_owned(),
            branch: Some("release/removed".to_owned()),
            shallow: false,
        })
        .expect_err("missing branch must not use the default branch");
    assert_eq!(
        error.to_string(),
        "The requested clone branch is not available in the local repository."
    );
    assert_eq!(git_output(Some(&fixture.api), ["show-ref"]), refs);
    assert_eq!(
        git_output(Some(&fixture.api), ["branch", "--show-current"]).trim(),
        "main"
    );
    assert!(!fixture.api.join(".git/FETCH_HEAD").exists());
}

#[test]
fn exact_commit_runtime_analysis_is_revalidated_and_persisted_with_the_plan() {
    let fixture = Fixture::new();
    fs::write(
        fixture.api.join("package.json"),
        r#"{"name":"checkout-api","scripts":{"dev":"node server.js --port 4310"}}"#,
    )
    .expect("runtime package metadata");
    git(Some(&fixture.api), ["add", "package.json"]);
    git(
        Some(&fixture.api),
        ["commit", "-m", "declare development service"],
    );

    let catalog = fixture.service.repository_catalog().expect("catalog");
    let repository = catalog
        .repositories
        .iter()
        .find(|repository| repository.label == "checkout-api")
        .expect("API repository");
    let repository_request = WorkspaceRepositoryRequest {
        repository_id: Some(repository.id.clone()),
        label: repository.label.clone(),
        base_ref: "main".to_owned(),
    };
    let analysis = fixture
        .service
        .analyze_workspace_runtime(RuntimeAnalysisRequest {
            repositories: vec![repository_request.clone()],
        })
        .expect("runtime analysis");
    assert_eq!(analysis.repositories.len(), 1);
    assert_eq!(analysis.services.len(), 1);
    assert_eq!(analysis.services[0].command, ["npm", "run", "dev"]);
    assert_eq!(analysis.services[0].ports[0].preferred_port, Some(4310));

    let runtime = RuntimePlanSelection {
        analysis_digest: analysis.analysis_digest.clone(),
        services: vec![RuntimeServiceSelection {
            candidate_id: analysis.services[0].candidate_id.clone(),
            ports: vec![RuntimePortSelection {
                port_id: analysis.services[0].ports[0].port_id.clone(),
                preferred_port: 4311,
                policy: RuntimePortPolicy::Prefer,
            }],
        }],
    };
    let created = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "runtime-plan".to_owned(),
                },
                title: "Runtime plan".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![repository_request.clone()],
                runtime: Some(runtime.clone()),
                planning: None,
            },
        )
        .expect("saved runtime plan");
    assert_eq!(created.workspace.runtime.as_ref(), Some(&runtime));

    let preflight = fixture
        .service
        .preflight_workspace(created.workspace.workspace_id)
        .expect("runtime preflight");
    assert_eq!(preflight.runtime.as_ref(), Some(&runtime));
    assert!(preflight.ready);
    let materialized = fixture
        .service
        .materialize_workspace(created.workspace.workspace_id, &preflight.effect_digest)
        .expect("runtime materialization");
    assert_eq!(
        materialized.materialization.runtime.as_ref(),
        Some(&runtime)
    );
    let reopened = fixture.reopen(RecordingLauncher::default());
    assert_eq!(
        reopened
            .get_materialization(created.workspace.workspace_id)
            .expect("reloaded materialization")
            .expect("materialization exists")
            .runtime
            .as_ref(),
        Some(&runtime)
    );

    let mut stale = runtime.clone();
    stale.analysis_digest = format!("sha256:{}", "0".repeat(64));
    assert!(matches!(
        fixture.service.create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "stale-runtime".to_owned(),
                },
                title: "Stale runtime".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![repository_request.clone()],
                runtime: Some(stale),
                planning: None,
            },
        ),
        Err(LocalWtsError::StaleRuntimeAnalysis)
    ));

    let unknown = RuntimePlanSelection {
        analysis_digest: analysis.analysis_digest,
        services: vec![RuntimeServiceSelection {
            candidate_id: "candidate:unknown".to_owned(),
            ports: Vec::new(),
        }],
    };
    assert!(matches!(
        fixture.service.create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "unknown-runtime".to_owned(),
                },
                title: "Unknown runtime".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![repository_request],
                runtime: Some(unknown),
                planning: None,
            },
        ),
        Err(LocalWtsError::InvalidRuntimeSelection)
    ));
}

#[test]
fn runtime_create_replays_after_base_moves_and_preflight_blocks_the_stale_plan() {
    let fixture = Fixture::new();
    fs::write(
        fixture.api.join("package.json"),
        r#"{"name":"checkout-api","scripts":{"dev":"node server.js --port 4310"}}"#,
    )
    .expect("runtime package metadata");
    git(Some(&fixture.api), ["add", "package.json"]);
    git(
        Some(&fixture.api),
        ["commit", "-m", "declare development service"],
    );

    let repository = fixture
        .service
        .repository_catalog()
        .expect("catalog")
        .repositories
        .into_iter()
        .find(|repository| repository.label == "checkout-api")
        .expect("API repository");
    let repository_request = WorkspaceRepositoryRequest {
        repository_id: Some(repository.id),
        label: repository.label,
        base_ref: "main".to_owned(),
    };
    let analysis = fixture
        .service
        .analyze_workspace_runtime(RuntimeAnalysisRequest {
            repositories: vec![repository_request.clone()],
        })
        .expect("runtime analysis");
    let runtime = RuntimePlanSelection {
        analysis_digest: analysis.analysis_digest,
        services: vec![RuntimeServiceSelection {
            candidate_id: analysis.services[0].candidate_id.clone(),
            ports: vec![RuntimePortSelection {
                port_id: analysis.services[0].ports[0].port_id.clone(),
                preferred_port: 4311,
                policy: RuntimePortPolicy::Prefer,
            }],
        }],
    };
    let request = CreateWorkspaceRequest {
        intent: WorkspaceIntent::RepositorySet {
            label: "runtime-replay".to_owned(),
        },
        title: "Runtime replay".to_owned(),
        preferred_provider: WorkspaceProvider::Codex,
        repositories: vec![repository_request],
        runtime: Some(runtime),
        planning: None,
    };
    let idempotency_key = Uuid::new_v4().to_string();
    let created = fixture
        .service
        .create_workspace(&idempotency_key, request.clone())
        .expect("saved runtime plan");
    assert!(!created.replayed);

    fs::write(
        fixture.api.join("package.json"),
        r#"{"name":"checkout-api","scripts":{"dev":"node server.js --port 4320"}}"#,
    )
    .expect("changed runtime package metadata");
    git(Some(&fixture.api), ["add", "package.json"]);
    git(Some(&fixture.api), ["commit", "-m", "move service port"]);

    let replayed = fixture
        .service
        .create_workspace(&idempotency_key, request.clone())
        .expect("idempotent replay after base move");
    assert!(replayed.replayed);
    assert_eq!(
        replayed.workspace.workspace_id,
        created.workspace.workspace_id
    );

    let preflight = fixture
        .service
        .preflight_workspace(created.workspace.workspace_id)
        .expect("stale runtime preflight");
    assert!(!preflight.ready);
    assert!(
        preflight
            .blockers
            .iter()
            .any(|blocker| { blocker.code == PreflightBlockerCode::RuntimeAnalysisStale })
    );

    assert!(matches!(
        fixture
            .service
            .create_workspace(&Uuid::new_v4().to_string(), request),
        Err(LocalWtsError::StaleRuntimeAnalysis)
    ));
}

#[test]
fn discovers_repositories_across_multiple_trusted_roots() {
    let directory = tempfile::tempdir().expect("fixture root");
    let first_root = directory.path().join("team-repositories");
    let second_root = directory.path().join("personal-repositories");
    fs::create_dir(&first_root).expect("first repository root");
    fs::create_dir(&second_root).expect("second repository root");
    create_repository(&first_root, "checkout-api");
    create_repository(&second_root, "checkout-web");
    let service = LocalWtsService::open_with_repository_roots(
        directory.path().join("data"),
        "multi-root-test",
        directory.path().join("workspaces"),
        vec![second_root, first_root],
    )
    .expect("multi-root local service");

    let catalog = service.repository_catalog().expect("multi-root catalog");
    assert_eq!(
        catalog
            .repositories
            .iter()
            .map(|repository| repository.label.as_str())
            .collect::<Vec<_>>(),
        vec!["checkout-api", "checkout-web"]
    );
}

#[test]
fn opens_a_catalog_owned_repository_base_at_its_exact_local_commit() {
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "origin",
            "git@gitlab.example.test:payments/platform/checkout-api.git",
        ],
    );
    git(Some(&fixture.api), ["branch", "feat/USB-NIC"]);

    let catalog = fixture.service.repository_catalog().expect("catalog");
    let api = catalog
        .repositories
        .iter()
        .find(|repository| repository.label == "checkout-api")
        .expect("API repository");
    let web = catalog
        .repositories
        .iter()
        .find(|repository| repository.label == "checkout-web")
        .expect("web repository");
    let commit_oid = git_output(Some(&fixture.api), ["rev-parse", "feat/USB-NIC"])
        .trim()
        .to_owned();

    let opened = fixture
        .service
        .open_repository_base(&api.id, "feat/USB-NIC")
        .expect("open selected base");
    assert!(opened.accepted);
    assert_eq!(opened.repository_id, api.id);
    assert_eq!(opened.forge, RepositoryForge::Gitlab);
    assert_eq!(opened.host, "gitlab.example.test");
    assert_eq!(opened.base_ref, "feat/USB-NIC");
    assert_eq!(opened.commit_oid, commit_oid);

    let launched = fixture
        .launcher
        .launched_repository_bases
        .lock()
        .expect("repository-base launcher lock");
    assert_eq!(launched.len(), 1);
    assert_eq!(launched[0].forge(), RepositoryForge::Gitlab);
    assert_eq!(launched[0].host(), "gitlab.example.test");
    assert_eq!(
        launched[0].repository_path(),
        "payments/platform/checkout-api"
    );
    assert_eq!(launched[0].commit_oid(), commit_oid);
    assert_eq!(
        launched[0].web_url(),
        format!("https://gitlab.example.test/payments/platform/checkout-api/-/tree/{commit_oid}")
    );
    drop(launched);

    assert!(matches!(
        fixture
            .service
            .open_repository_base(&api.id, "missing-base"),
        Err(LocalWtsError::RepositoryBaseNotFound)
    ));
    assert!(matches!(
        fixture.service.open_repository_base("repo_unknown", "main"),
        Err(LocalWtsError::RepositoryNotFound)
    ));
    assert!(matches!(
        fixture.service.open_repository_base(&web.id, "main"),
        Err(LocalWtsError::RepositoryForgeUnsupported)
    ));
    assert_eq!(
        fixture
            .launcher
            .launched_repository_bases
            .lock()
            .expect("repository-base launcher lock")
            .len(),
        1
    );
}

#[test]
fn opens_a_gitlab_merge_request_from_a_reinspected_tracking_remote() {
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "upstream",
            "git@gitlab.example.test:payments/platform/checkout-api.git",
        ],
    );
    let branch_name = branch(&fixture.api);
    git(
        Some(&fixture.api),
        [
            "update-ref",
            &format!("refs/remotes/upstream/{branch_name}"),
            "HEAD",
        ],
    );
    git(
        Some(&fixture.api),
        [
            "config",
            &format!("branch.{branch_name}.remote"),
            "upstream",
        ],
    );
    git(
        Some(&fixture.api),
        [
            "config",
            &format!("branch.{branch_name}.merge"),
            &format!("refs/heads/{branch_name}"),
        ],
    );
    let catalog = fixture.service.repository_catalog().expect("catalog");
    let repository = catalog
        .repositories
        .iter()
        .find(|repository| repository.label == "checkout-api")
        .expect("API repository");
    fixture
        .service
        .open_repository_base(&repository.id, &branch_name)
        .expect("open tracked repository base");

    let result = fixture
        .service
        .open_gitlab_merge_request(&repository.id, 418)
        .expect("open GitLab merge request");
    assert_eq!(result.repository_id, repository.id);
    assert_eq!(result.iid, 418);
    assert!(result.accepted);
    let targets = fixture
        .launcher
        .launched_gitlab_merge_requests
        .lock()
        .expect("GitLab merge request launcher lock");
    assert_eq!(targets.len(), 1);
    assert_eq!(
        targets[0].web_url(),
        "https://gitlab.example.test/payments/platform/checkout-api/-/merge_requests/418"
    );
}

#[test]
fn opens_a_catalog_owned_repository_base_from_its_tracking_remote() {
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "upstream",
            "git@gitlab.example.test:payments/platform/checkout-api.git",
        ],
    );
    git(
        Some(&fixture.api),
        ["config", "branch.main.remote", "upstream"],
    );
    git(
        Some(&fixture.api),
        ["config", "branch.main.merge", "refs/heads/main"],
    );

    let catalog = fixture.service.repository_catalog().expect("catalog");
    let api = catalog
        .repositories
        .iter()
        .find(|repository| repository.label == "checkout-api")
        .expect("API repository");

    let opened = fixture
        .service
        .open_repository_base(&api.id, "main")
        .expect("open selected base from upstream");

    assert!(opened.accepted);
    assert_eq!(opened.repository_id, api.id);
    assert_eq!(opened.forge, RepositoryForge::Gitlab);
    assert_eq!(opened.host, "gitlab.example.test");
}

#[test]
fn gitlab_status_uses_the_managed_base_tracking_remote_without_origin() {
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "upstream",
            "git@gitlab.example.test:payments/platform/checkout-api.git",
        ],
    );
    git(
        Some(&fixture.api),
        ["update-ref", "refs/remotes/upstream/main", "HEAD"],
    );
    git(
        Some(&fixture.api),
        ["config", "branch.main.remote", "upstream"],
    );
    git(
        Some(&fixture.api),
        ["config", "branch.main.merge", "refs/heads/main"],
    );
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");

    let status = fixture
        .service
        .gitlab_integration_status(workspace_id)
        .expect("GitLab integration status");

    assert_eq!(status.accounts.len(), 1);
    assert_eq!(status.accounts[0].host, "gitlab.example.test");
}

#[cfg(unix)]
#[test]
fn gitlab_discussions_use_catalog_on_cold_start_and_managed_tracking_remote() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("glab");
    fs::write(
        &executable,
        r#"#!/bin/sh
set -eu
root="$WTS_TEST_DISCUSSION_ROOT"
printf '%s\n' "$4" >> "$root/endpoints"
case "$4" in
 /user) printf '{"id":1,"username":"alice"}' ;;
 */discussions/*/notes) printf 'post\n' >> "$root/posts"; cat "$root/note.json" ;;
 */discussions\?*) printf '[]' ;;
 */discussions/*) cat "$root/thread.json" ;;
 */merge_requests/17) cat "$root/mr.json" ;;
 *) exit 31 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let mut paths = vec![directory.path().to_path_buf()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "gitlab_discussions_trusted_scope_child",
            "--nocapture",
        ])
        .env("WTS_TEST_DISCUSSION_ROOT", directory.path())
        .env("PATH", std::env::join_paths(paths).unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn gitlab_discussions_trusted_scope_child() {
    let Some(root) = std::env::var_os("WTS_TEST_DISCUSSION_ROOT").map(PathBuf::from) else {
        return;
    };
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "origin",
            "https://gitlab.example.test/catalog/checkout-api.git",
        ],
    );
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "upstream",
            "https://gitlab.example.test/trusted/checkout-api.git",
        ],
    );
    git(
        Some(&fixture.api),
        ["update-ref", "refs/remotes/upstream/main", "HEAD"],
    );
    git(
        Some(&fixture.api),
        ["config", "branch.main.remote", "upstream"],
    );
    git(
        Some(&fixture.api),
        ["config", "branch.main.merge", "refs/heads/main"],
    );
    let repository = fixture
        .service
        .repository_catalog()
        .unwrap()
        .repositories
        .into_iter()
        .find(|repository| repository.label == "checkout-api")
        .unwrap();
    let review = fixture
        .service
        .gitlab_discussions(&repository.id, 17, None)
        .expect("cold-start review discussions");
    assert!(review.discussions.is_empty());
    let initial_endpoints = fs::read_to_string(root.join("endpoints")).unwrap();
    assert!(
        initial_endpoints
            .contains("/projects/catalog%2Fcheckout-api/merge_requests/17/discussions?"),
        "{initial_endpoints}"
    );
    let note = serde_json::json!({"id":92,"body":"Reply","author":{"username":"alice"},"created_at":"2026-09-17T00:00:00Z","system":false});
    fs::write(root.join("note.json"), serde_json::to_vec(&note).unwrap()).unwrap();
    fs::write(
        root.join("thread.json"),
        serde_json::to_vec(&serde_json::json!({"id":"thread-1","notes":[note]})).unwrap(),
    )
    .unwrap();
    let reopened = fixture.reopen(RecordingLauncher::default());
    let reply = reopened
        .reply_gitlab_discussion(
            &repository.id,
            17,
            wts_app::ReplyGitlabDiscussionRequest {
                discussion_id: "thread-1".to_owned(),
                body: "Reply".to_owned(),
                workspace_id: None,
            },
        )
        .expect("cold-start review reply");
    assert_eq!(reply.comment.id, 92);

    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture.service.preflight_workspace(workspace_id).unwrap();
    let materialization = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .unwrap();
    let worktree = &materialization.materialization.worktrees[0];
    let branch = git_output(
        Some(Path::new(&worktree.target_display_path)),
        ["branch", "--show-current"],
    );
    let mut metadata = serde_json::json!({"id":77,"iid":17,"title":"Change","web_url":"https://gitlab.example.test/trusted/checkout-api/-/merge_requests/17","state":"opened","source_branch":branch.trim(),"target_branch":"main","author":{"username":"alice"},"updated_at":"2026-09-17T00:00:00Z"});
    fs::write(root.join("mr.json"), serde_json::to_vec(&metadata).unwrap()).unwrap();
    let authored = fixture
        .service
        .gitlab_discussions(&repository.id, 17, Some(workspace_id))
        .expect("managed tracking remote");
    assert_ne!(authored.scope_id, review.scope_id);
    let endpoints = fs::read_to_string(root.join("endpoints")).unwrap();
    assert!(endpoints.contains("/projects/trusted%2Fcheckout-api/merge_requests/17/discussions?"));
    metadata["source_branch"] = serde_json::json!("other-branch");
    fs::write(root.join("mr.json"), serde_json::to_vec(&metadata).unwrap()).unwrap();
    assert!(
        fixture
            .service
            .gitlab_discussions(&repository.id, 17, Some(workspace_id))
            .is_err()
    );
    assert!(
        fixture
            .service
            .reply_gitlab_discussion(
                &repository.id,
                17,
                wts_app::ReplyGitlabDiscussionRequest {
                    discussion_id: "thread-1".to_owned(),
                    body: "Reply".to_owned(),
                    workspace_id: Some(workspace_id)
                }
            )
            .is_err()
    );
    assert_eq!(fs::read_to_string(root.join("posts")).unwrap(), "post\n");
}

#[test]
fn prepares_and_opens_a_verified_gitlab_merge_request_draft() {
    let fixture = Fixture::new();
    git(
        Some(&fixture.api),
        [
            "remote",
            "add",
            "origin",
            "git@gitlab.example.test:payments/platform/checkout-api.git",
        ],
    );
    git(
        Some(&fixture.api),
        ["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize")
        .materialization;
    let worktree = &materialized.worktrees[0];
    let path = PathBuf::from(&worktree.target_display_path);
    let guide = fs::read_to_string(Path::new(&materialized.workspace_display_path).join("WTS.md"))
        .expect("read agent guide");
    assert!(guide.contains("WTS_CHANGE_REQUEST_PROPOSAL:"));
    assert!(guide.contains("Use this schema: `{\"schemaVersion\":1"));
    assert!(!guide.contains("Use this schema: `{{"));
    assert!(guide.contains("Do not add every linked issue."));
    let session = fixture
        .service
        .start_agent_session(
            workspace_id,
            AgentProvider::Codex,
            TerminalProvider::Terminal,
            wts_app::AgentSessionCategory::Implementation,
        )
        .expect("start proposing agent session");
    fs::write(
        path.join("README.md"),
        "# checkout-api\n\nValidate admission.\n",
    )
    .expect("change worktree");
    assert!(matches!(
        fixture.service.publish_workspace_change_request_branch(
            workspace_id,
            PublishWorkspaceChangeRequestBranch {
                repository_id: worktree.repository_id.clone(),
                branch_name: None,
            },
        ),
        Err(LocalWtsError::ChangeRequestWorktreeDirty)
    ));
    git(Some(&path), ["add", "README.md"]);
    git(
        Some(&path),
        ["commit", "-m", "feat: validate PPEC admission"],
    );
    let branch_name = branch(&path);
    git(
        Some(&path),
        ["config", &format!("branch.{branch_name}.remote"), "origin"],
    );
    git(
        Some(&path),
        [
            "config",
            &format!("branch.{branch_name}.merge"),
            &format!("refs/heads/{branch_name}"),
        ],
    );
    git(
        Some(&path),
        [
            "update-ref",
            &format!("refs/remotes/origin/{branch_name}"),
            "HEAD",
        ],
    );
    let head = git_output(Some(&path), ["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    fixture
        .service
        .record_agent_change_request_proposals(
            session.session_id,
            vec![AgentChangeRequestProposal {
                schema_version: 1,
                repository_id: worktree.repository_id.clone(),
                source_head_commit_oid: head.clone(),
                title: "OTHER-9: Invalid issue scope".to_owned(),
                body: "## Summary\n\nThis issue is not linked.".to_owned(),
                issue_keys: vec!["OTHER-9".to_owned()],
                verification: None,
            }],
        )
        .expect("record unlinked proposal");
    assert!(matches!(
        fixture.service.prepare_workspace_change_request(
            workspace_id,
            PrepareWorkspaceChangeRequest {
                repository_id: worktree.repository_id.clone(),
            },
        ),
        Err(LocalWtsError::ChangeRequestAgentProposalInvalid)
    ));
    fixture
        .service
        .record_agent_change_request_proposals(
            session.session_id,
            vec![AgentChangeRequestProposal {
                schema_version: 1,
                repository_id: worktree.repository_id.clone(),
                source_head_commit_oid: head.clone(),
                title: "PLATFORM-42: Validate PPEC admission".to_owned(),
                body:
                    "## Summary\n\nValidate PPEC admission.\n\n## Verification\n\n- Tests passed."
                        .to_owned(),
                issue_keys: vec!["PLATFORM-42".to_owned()],
                verification: Some(wts_app::AgentChangeRequestVerification {
                    status: wts_app::AgentChangeRequestVerificationStatus::Partial,
                    summary: "Targeted checks passed. The full suite needs a localhost listener."
                        .to_owned(),
                }),
            }],
        )
        .expect("record agent change-request proposal");
    let draft = fixture
        .service
        .prepare_workspace_change_request(
            workspace_id,
            PrepareWorkspaceChangeRequest {
                repository_id: worktree.repository_id.clone(),
            },
        )
        .expect("prepare merge request");
    assert_eq!(draft.forge, RepositoryForge::Gitlab);
    assert_eq!(draft.source_branch, branch_name);
    assert_eq!(draft.target_branch, "main");
    assert!(draft.remote_matches);
    assert!(draft.worktree_clean);
    assert_eq!(draft.title, "PLATFORM-42: Validate PPEC admission");
    assert!(draft.body.contains("## Verification"));
    assert_eq!(draft.proposed_by_session_id, session.session_id);
    assert_eq!(draft.commits.len(), 1);
    assert_eq!(draft.commits[0].commit_oid, head);
    assert_eq!(draft.changed_files, vec!["README.md"]);
    assert_eq!(draft.work_items.len(), 1);
    assert_eq!(draft.work_items[0].issue_key, "PLATFORM-42");
    assert_eq!(
        draft.verification_status,
        wts_app::AgentChangeRequestVerificationStatus::Partial
    );
    assert!(
        draft
            .verification_summary
            .contains("Targeted checks passed")
    );
    assert!(
        !draft
            .verification_summary
            .contains("Workspace verification")
    );

    let opened = fixture
        .service
        .open_workspace_change_request_draft(
            workspace_id,
            OpenWorkspaceChangeRequestDraft {
                repository_id: worktree.repository_id.clone(),
                effect_digest: draft.effect_digest,
                title: draft.title,
                body: draft.body,
            },
        )
        .expect("open merge request draft");
    assert!(opened.accepted);
    let targets = fixture
        .launcher
        .launched_change_request_drafts
        .lock()
        .expect("change-request targets");
    assert_eq!(targets.len(), 1);
    assert!(targets[0].web_url().contains("/-/merge_requests/new?"));
    assert!(
        targets[0]
            .web_url()
            .contains("merge_request%5Bsource_branch%5D=")
    );
    assert!(targets[0].web_url().contains("PLATFORM-42"));
}

#[test]
fn publishes_the_managed_branch_and_sets_its_upstream() {
    let fixture = Fixture::new();
    configure_local_origin(&fixture, &fixture.api);
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize")
        .materialization;
    let worktree = materialized
        .worktrees
        .iter()
        .find(|worktree| worktree.label == "checkout-api")
        .expect("API worktree");
    let path = PathBuf::from(&worktree.target_display_path);
    fs::write(
        path.join("README.md"),
        "# checkout-api\n\nPublished work.\n",
    )
    .expect("change worktree");
    git(Some(&path), ["add", "README.md"]);
    git(
        Some(&path),
        ["commit", "-m", "feat: publish managed branch"],
    );
    assert!(matches!(
        fixture.service.prepare_workspace_change_request(
            workspace_id,
            PrepareWorkspaceChangeRequest {
                repository_id: worktree.repository_id.clone(),
            },
        ),
        Err(LocalWtsError::ChangeRequestBranchNotPublished)
    ));

    let published = fixture
        .service
        .publish_workspace_change_request_branch(
            workspace_id,
            PublishWorkspaceChangeRequestBranch {
                repository_id: worktree.repository_id.clone(),
                branch_name: Some("feature/custom-published-name".to_owned()),
            },
        )
        .expect("publish branch");

    assert_eq!(published.repository_id, worktree.repository_id);
    assert_eq!(published.remote_name, "origin");
    assert_eq!(published.branch_name, "feature/custom-published-name");
    assert_eq!(
        git_output(
            Some(&path),
            [
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}"
            ],
        )
        .trim(),
        "origin/feature/custom-published-name"
    );
    assert_eq!(
        git_output(
            Some(&path),
            [
                "rev-parse",
                &format!("refs/remotes/origin/{}", published.branch_name)
            ],
        )
        .trim(),
        published.head_commit_oid
    );
}

#[test]
fn imports_and_materializes_a_nested_checkout_with_an_origin_derived_label() {
    let directory = tempfile::tempdir().expect("fixture root");
    let data_dir = directory.path().join("data");
    let repository_root = directory.path().join("repositories");
    let nested_parent = repository_root.join("bmc-virtual-console");
    let archive_parent = repository_root.join("archive");
    let workspace_root = directory.path().join("workspaces");
    fs::create_dir_all(&nested_parent).expect("nested repository parent");
    fs::create_dir_all(&archive_parent).expect("archive repository parent");
    let repository = create_repository(&nested_parent, "ppec-ui");
    let archive_repository = create_repository(&archive_parent, "ppec-ui");
    git(
        Some(&repository),
        [
            "remote",
            "add",
            "origin",
            "https://example.invalid/acme/ppec-ui-main.git",
        ],
    );
    git(
        Some(&archive_repository),
        [
            "remote",
            "add",
            "origin",
            "https://example.invalid/acme/ppec-ui-archive.git",
        ],
    );
    let service =
        LocalWtsService::open(&data_dir, "nested-test", &workspace_root, &repository_root)
            .expect("local service");
    let repository_display_path = repository
        .canonicalize()
        .expect("canonical repository")
        .to_str()
        .expect("UTF-8 repository")
        .to_owned();

    let catalog = service.repository_catalog().expect("nested catalog");
    assert_eq!(catalog.repositories.len(), 2);
    let catalog_repository = catalog
        .repositories
        .iter()
        .find(|candidate| candidate.label == "ppec-ui-main")
        .expect("BMC repository in catalog");
    assert_eq!(catalog_repository.checkout_leaf, "ppec-ui");
    assert_eq!(catalog_repository.display_path, repository_display_path);

    let import_request: CodeWorkspaceImportRequest = serde_json::from_value(serde_json::json!({
        "fileName": "bmc.code-workspace",
        "contents": r#"{ folders: [{ path: "bmc-virtual-console/ppec-ui" }] }"#,
    }))
    .expect("workspace import request");
    let imported = service
        .import_code_workspace_file(import_request)
        .expect("nested workspace import");
    assert_eq!(imported.repositories.len(), 1);
    assert_eq!(imported.repositories[0].label, "ppec-ui-main");
    assert_eq!(
        imported.folders[0].repository_display_path.as_deref(),
        Some(repository_display_path.as_str())
    );
    #[cfg(debug_assertions)]
    assert_eq!(
        imported
            .diagnostics
            .as_ref()
            .expect("development diagnostics")
            .folders[0]
            .reason,
        wts_app::CodeWorkspaceResolutionReason::MatchedRelativePathSuffix
    );

    let created = service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: imported.suggested_repository_set_label,
                },
                title: imported.suggested_title,
                preferred_provider: WorkspaceProvider::Codex,
                repositories: imported.repositories,
                runtime: None,
                planning: None,
            },
        )
        .expect("workspace plan");
    let preflight = service
        .preflight_workspace(created.workspace.workspace_id)
        .expect("nested repository preflight");
    assert!(preflight.ready);
    assert_eq!(
        preflight.repositories[0].source_display_path,
        repository_display_path
    );

    let materialized = service
        .materialize_workspace(created.workspace.workspace_id, &preflight.effect_digest)
        .expect("materialize nested repository");
    let target = Path::new(&materialized.materialization.worktrees[0].target_display_path);
    assert!(target.is_dir());
    assert!(
        target.starts_with(
            workspace_root
                .canonicalize()
                .expect("canonical workspace root")
        )
    );
    assert_eq!(branch(&repository), "main");
}

#[test]
fn imports_materializes_and_removes_distinct_repositories_with_the_same_label() {
    let directory = tempfile::tempdir().expect("fixture root");
    let data_dir = directory.path().join("data");
    let repository_root = directory.path().join("repositories");
    let workspace_root = directory.path().join("workspaces");
    fs::create_dir(&repository_root).expect("repository root");
    let first = create_repository(&repository_root, "first-checkout");
    let second = create_repository(&repository_root, "second-checkout");
    for repository in [&first, &second] {
        git(
            Some(repository),
            [
                "remote",
                "add",
                "origin",
                "https://example.invalid/acme/shared.git",
            ],
        );
    }
    let service = LocalWtsService::open(
        &data_dir,
        "duplicate-label-test",
        &workspace_root,
        &repository_root,
    )
    .expect("local service");
    let first_display_path = first
        .canonicalize()
        .expect("canonical first repository")
        .to_string_lossy()
        .into_owned();
    let second_display_path = second
        .canonicalize()
        .expect("canonical second repository")
        .to_string_lossy()
        .into_owned();
    let contents = serde_json::json!({
        "folders": [
            { "path": first_display_path },
            { "path": second_display_path },
        ],
    })
    .to_string();
    let import_request: CodeWorkspaceImportRequest = serde_json::from_value(serde_json::json!({
        "fileName": "same-label.code-workspace",
        "contents": contents,
    }))
    .expect("workspace import request");

    let imported = service
        .import_code_workspace_file(import_request)
        .expect("same-label workspace import");
    assert_eq!(imported.repositories.len(), 2);
    assert!(
        imported
            .repositories
            .iter()
            .all(|repository| repository.label.eq_ignore_ascii_case("shared"))
    );
    let first_repository_id = imported.repositories[0]
        .repository_id
        .clone()
        .expect("first pinned repository");
    let second_repository_id = imported.repositories[1]
        .repository_id
        .clone()
        .expect("second pinned repository");
    assert_ne!(first_repository_id, second_repository_id);
    assert_eq!(
        imported
            .folders
            .iter()
            .map(|folder| folder.repository_id.as_deref())
            .collect::<Vec<_>>(),
        vec![
            Some(first_repository_id.as_str()),
            Some(second_repository_id.as_str()),
        ]
    );

    let created = service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: imported.suggested_repository_set_label,
                },
                title: imported.suggested_title,
                preferred_provider: WorkspaceProvider::VsCode,
                repositories: imported.repositories,
                runtime: None,
                planning: None,
            },
        )
        .expect("same-label workspace plan");
    assert_eq!(created.workspace.repositories.len(), 2);
    assert!(
        created
            .workspace
            .repositories
            .iter()
            .all(|repository| repository.repository_id.is_some())
    );

    let preflight = service
        .preflight_workspace(created.workspace.workspace_id)
        .expect("same-label preflight");
    assert!(preflight.ready, "{:?}", preflight.blockers);
    assert_eq!(preflight.repositories.len(), 2);
    assert_ne!(
        preflight.repositories[0].repository_id,
        preflight.repositories[1].repository_id
    );
    assert_ne!(
        preflight.repositories[0].target_display_path,
        preflight.repositories[1].target_display_path
    );

    let materialized = service
        .materialize_workspace(created.workspace.workspace_id, &preflight.effect_digest)
        .expect("same-label materialization");
    assert_eq!(materialized.materialization.worktrees.len(), 2);
    let workspace_path = PathBuf::from(&materialized.materialization.workspace_display_path);

    let removal = service
        .preflight_workspace_removal(created.workspace.workspace_id)
        .expect("same-label removal preflight");
    assert!(removal.ready, "{:?}", removal.blockers);
    assert_eq!(removal.worktrees.len(), 2);
    let removed = service
        .remove_workspace(
            created.workspace.workspace_id,
            &removal.effect_digest,
            &Uuid::new_v4().to_string(),
            false,
        )
        .expect("same-label manual removal");
    assert_eq!(removed.removed_worktree_count, 2);
    assert!(!workspace_path.exists());
}

#[test]
fn linked_checkout_aliases_are_deduplicated_and_imported_once() {
    let directory = tempfile::tempdir().expect("fixture root");
    let data_dir = directory.path().join("data");
    let repository_root = directory.path().join("repositories");
    let workspace_root = directory.path().join("workspaces");
    fs::create_dir(&repository_root).expect("repository root");
    let primary = create_repository(&repository_root, "bmc-api");
    let alias = repository_root.join("bmc-remote-view");
    git(
        Some(&primary),
        [
            "worktree",
            "add",
            "-b",
            "linked",
            alias.to_str().expect("UTF-8 alias path"),
        ],
    );
    let service = LocalWtsService::open(&data_dir, "alias-test", &workspace_root, &repository_root)
        .expect("local service");

    let catalog = service.repository_catalog().expect("alias catalog");
    assert_eq!(catalog.repositories.len(), 1);
    assert_eq!(catalog.repositories[0].checkout_leaf, "bmc-api");
    assert_eq!(
        catalog.repositories[0].display_path,
        primary
            .canonicalize()
            .expect("canonical primary")
            .to_string_lossy()
    );

    let contents = format!(
        r#"{{ folders: [{{ path: "{}" }}, {{ path: "{}" }}] }}"#,
        primary.display(),
        alias.display()
    );
    let import_request: CodeWorkspaceImportRequest = serde_json::from_value(serde_json::json!({
        "fileName": "linked.code-workspace",
        "contents": contents,
    }))
    .expect("workspace import request");
    let imported = service
        .import_code_workspace_file(import_request)
        .expect("linked workspace import");

    assert_eq!(imported.repositories.len(), 1);
    assert_eq!(imported.folders.len(), 2);
    assert!(
        imported
            .folders
            .iter()
            .all(|folder| { folder.status == wts_app::CodeWorkspaceFolderStatus::Matched })
    );
    assert_eq!(
        imported
            .warnings
            .iter()
            .filter(|warning| {
                warning.code == wts_app::CodeWorkspaceImportWarningCode::DuplicateRepository
            })
            .count(),
        1
    );
}

#[cfg(unix)]
#[test]
fn recursive_discovery_does_not_follow_directory_symlinks() {
    let directory = tempfile::tempdir().expect("fixture root");
    let repository_root = directory.path().join("repositories");
    let outside_root = directory.path().join("outside");
    let workspace_root = directory.path().join("workspaces");
    fs::create_dir(&repository_root).expect("repository root");
    fs::create_dir(&outside_root).expect("outside root");
    create_repository(&outside_root, "not-trusted");
    std::os::unix::fs::symlink(&outside_root, repository_root.join("linked-outside"))
        .expect("directory symlink");
    let service = LocalWtsService::open(
        directory.path().join("data"),
        "symlink-test",
        &workspace_root,
        &repository_root,
    )
    .expect("local service");

    let catalog = service.repository_catalog().expect("symlink catalog");
    assert!(catalog.repositories.is_empty());
    assert_eq!(catalog.skipped_entries, 1);
}

#[test]
fn recursive_discovery_stops_beyond_the_depth_bound() {
    let directory = tempfile::tempdir().expect("fixture root");
    let repository_root = directory.path().join("repositories");
    let workspace_root = directory.path().join("workspaces");
    let too_deep_parent = repository_root.join("one/two/three/four");
    fs::create_dir_all(&too_deep_parent).expect("deep parent");
    create_repository(&too_deep_parent, "five");
    let service = LocalWtsService::open(
        directory.path().join("data"),
        "depth-test",
        &workspace_root,
        &repository_root,
    )
    .expect("local service");

    let first = service.repository_catalog().expect("bounded catalog");
    let cached = service
        .repository_catalog()
        .expect("cached bounded catalog");
    assert!(first.repositories.is_empty());
    assert_eq!(first.skipped_entries, 1);
    assert_eq!(cached, first);
}

#[test]
fn preflight_is_read_only_and_missing_labels_are_explicit_blockers() {
    let fixture = Fixture::new();
    let missing = fixture.create_plan(&["does-not-exist"]);

    let blocked = fixture
        .service
        .preflight_workspace(missing)
        .expect("blocked preflight is a view");
    assert!(!blocked.ready);
    assert_eq!(blocked.blockers.len(), 1);
    assert_eq!(
        blocked.blockers[0].repository_label.as_deref(),
        Some("does-not-exist")
    );

    let ready_id = fixture.create_plan(&["checkout-api", "checkout-web"]);
    let ready = fixture
        .service
        .preflight_workspace(ready_id)
        .expect("ready preflight");
    assert!(ready.ready);
    assert_eq!(ready.repositories.len(), 2);
    assert!(ready.effect_digest.starts_with("sha256:"));
    assert!(
        !Path::new(&ready.workspace_display_path).exists(),
        "preflight must not create the final workspace"
    );
}

#[test]
fn preflight_branch_conflict_exposes_a_non_destructive_recovery() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let ready = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("initial preflight");
    assert!(ready.ready);

    git(Some(&fixture.api), ["branch", ready.branch_name.as_str()]);

    let blocked = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("branch conflict preflight");
    let blocker = blocked
        .blockers
        .iter()
        .find(|blocker| blocker.code == PreflightBlockerCode::BranchConflict)
        .expect("branch conflict blocker");

    assert!(!blocked.ready);
    assert!(has_branch(&fixture.api, &ready.branch_name));
    assert!(blocker.message.contains("will not overwrite or delete it"));
    assert!(blocker.message.contains("create a revised plan"));
}

#[test]
fn pinned_repository_id_never_falls_back_to_a_matching_label() {
    let fixture = Fixture::new();
    let missing_repository_id = format!("repo_{}", "f".repeat(64));
    assert!(
        fixture
            .service
            .repository_catalog()
            .expect("repository catalog")
            .repositories
            .iter()
            .all(|repository| repository.id != missing_repository_id)
    );
    let created = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "pinned-missing".to_owned(),
                },
                title: "Pinned repository is unavailable".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: Some(missing_repository_id),
                    label: "checkout-api".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: None,
            },
        )
        .expect("pinned workspace plan");

    let preflight = fixture
        .service
        .preflight_workspace(created.workspace.workspace_id)
        .expect("pinned missing preflight");
    assert!(!preflight.ready);
    assert!(preflight.repositories.is_empty());
    assert_eq!(preflight.blockers.len(), 1);
    assert_eq!(
        preflight.blockers[0].code,
        PreflightBlockerCode::RepositoryMissing
    );
    assert!(
        preflight.blockers[0].message.contains("pinned"),
        "{:?}",
        preflight.blockers
    );
}

#[test]
fn materializes_once_and_opens_only_the_generated_vscode_workspace() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api", "checkout-web"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");

    let stale = fixture
        .service
        .materialize_workspace(workspace_id, "sha256:stale")
        .expect_err("stale digest");
    assert!(matches!(stale, LocalWtsError::StalePreflight));
    assert!(!Path::new(&preflight.workspace_display_path).exists());

    let first = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");
    assert!(!first.replayed);
    assert_eq!(first.materialization.worktrees.len(), 2);
    let listed = fixture
        .service
        .list_workspaces()
        .expect("list lifecycle")
        .workspaces
        .into_iter()
        .find(|workspace| workspace.workspace_id == workspace_id)
        .expect("listed workspace");
    assert_eq!(
        listed.lifecycle.materialization_state,
        WorkspaceMaterializationState::Materialized
    );
    assert_eq!(listed.lifecycle.worktree_count, 2);
    assert!(
        first
            .materialization
            .worktrees
            .iter()
            .all(|worktree| Path::new(&worktree.target_display_path).is_dir())
    );
    assert!(Path::new(&first.materialization.code_workspace_display_path).is_file());
    assert!(
        Path::new(&first.materialization.workspace_display_path)
            .join(".wts-workspace.json")
            .is_file()
    );
    let guide_path = Path::new(&first.materialization.workspace_display_path).join("WTS.md");
    let guide = fs::read_to_string(&guide_path).expect("generated WTS agent guide");
    assert!(guide.contains("Read `.wts/context.json`"), "{guide}");
    assert!(guide.contains("Read `.wts/review-inbox.json`"), "{guide}");
    assert!(guide.contains("wts-report --input"), "{guide}");
    assert!(guide.contains("including its `sha256:` prefix"), "{guide}");
    assert!(guide.contains("checkout-api"), "{guide}");
    assert!(guide.contains("checkout-web"), "{guide}");
    let workspace_root = Path::new(&first.materialization.workspace_display_path);
    let workspace_agents = fs::read_to_string(workspace_root.join("AGENTS.md"))
        .expect("generated workspace agent instructions");
    assert!(workspace_agents.contains("Read `WTS.md` before"));
    let workspace_claude = fs::read_to_string(workspace_root.join("CLAUDE.md"))
        .expect("generated workspace CLAUDE.md");
    assert!(workspace_claude.contains("Read `WTS.md` before"));
    let workspace_cursorrules = fs::read_to_string(workspace_root.join(".cursorrules"))
        .expect("generated workspace .cursorrules");
    assert!(workspace_cursorrules.contains("Read `WTS.md` before"));
    let workspace_copilot = fs::read_to_string(
        workspace_root
            .join(".github")
            .join("copilot-instructions.md"),
    )
    .expect("generated workspace copilot instructions");
    assert!(workspace_copilot.contains("Read `WTS.md` before"));

    let code_workspace_bytes = fs::read(&first.materialization.code_workspace_display_path)
        .expect("read code-workspace file");
    let code_workspace: serde_json::Value =
        serde_json::from_slice(&code_workspace_bytes).expect("parse code-workspace JSON");
    assert_eq!(code_workspace["folders"][0]["name"], "Workspace (WTS)");
    assert_eq!(
        code_workspace["folders"][0]["path"],
        first.materialization.workspace_display_path
    );
    let evidence_root = Path::new(&first.materialization.workspace_display_path).join(".wts");
    for leaf in [
        "context.json",
        "graph-manifest.json",
        "verification-plan.json",
        "verification-result.json",
        "agent-report.json",
        "review-inbox.json",
    ] {
        assert!(evidence_root.join(leaf).is_file(), "missing {leaf}");
    }
    assert!(evidence_root.join("agent-runs").is_dir());
    let evidence = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("workspace evidence")
        .expect("evidence exists");
    assert_eq!(
        evidence.context.schema_version,
        WORKSPACE_EVIDENCE_SCHEMA_VERSION
    );
    assert_eq!(evidence.context.workspace_id, workspace_id);
    assert_eq!(evidence.context.repositories.len(), 2);
    assert_eq!(evidence.context.allowed_repository_ids.len(), 2);
    assert_eq!(
        evidence.graph_manifest.status,
        WorkspaceGraphEvidenceStatus::NotStarted
    );
    assert_eq!(
        evidence.verification_result.status,
        VerificationStatus::NotRun
    );
    assert!(evidence.verification_plan.checks.is_empty());
    assert!(evidence.agent_runs.is_empty());
    assert_eq!(evidence.agent_report.status, AgentReportStatus::NotReported);

    fs::remove_file(evidence_root.join("agent-report.json")).expect("remove legacy report");
    let upgraded = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("legacy evidence upgrade")
        .expect("evidence exists");
    assert_eq!(upgraded.agent_report.status, AgentReportStatus::NotReported);
    assert!(evidence_root.join("agent-report.json").is_file());

    fs::write(
        evidence_root.join("agent-report.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schemaVersion": WORKSPACE_EVIDENCE_SCHEMA_VERSION,
            "workspaceId": workspace_id,
            "updatedAtUnixMs": 1_721_776_500_000_i64,
            "summary": "The checkout retry path can duplicate captures.",
            "findings": [{
                "id": "duplicate-capture-path",
                "title": "Retry bypasses the idempotency guard",
                "detail": "The retry handler reaches capture creation before restoring the prior key.",
                "severity": "warning",
                "repositoryId": evidence.context.allowed_repository_ids[0],
                "evidence": ["checkout-api/src/retry.rs:84"]
            }],
            "nextActions": ["Add a regression test around the retry handler."],
            "proposedChecks": [{
                "id": "checkout-cargo-test",
                "label": "Checkout API unit tests",
                "kind": "unit",
                "repositoryId": evidence.context.allowed_repository_ids[0],
                "workingDirectory": evidence.context.repositories[0].worktree_display_path,
                "executable": "cargo",
                "args": ["test", "--quiet"],
                "timeoutMs": 120_000,
                "environmentNames": ["CI"],
                "reason": "The retry path is implemented in the checkout API crate.",
                "evidence": ["checkout-api/src/retry.rs:84"]
            }],
            "validationFlows": [{
                "id": "retry-idempotency-flow",
                "title": "Retry an existing checkout",
                "goal": "Confirm a repeated capture request remains idempotent.",
                "prerequisites": ["A checkout fixture with a persisted idempotency key."],
                "steps": [{
                    "id": "submit-retry",
                    "action": "Submit the same retry request twice.",
                    "expected": "The second request returns the original capture.",
                    "evidence": ["checkout-api/src/retry.rs:84"]
                }]
            }]
        }))
        .expect("serialize agent report"),
    )
    .expect("publish agent report");
    let reported = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("agent report evidence")
        .expect("evidence exists");
    assert_eq!(reported.agent_report.status, AgentReportStatus::Ready);
    assert_eq!(reported.agent_report.findings.len(), 1);
    assert_eq!(
        reported.agent_report.findings[0].title,
        "Retry bypasses the idempotency guard"
    );
    assert_eq!(
        reported.agent_report.next_actions,
        ["Add a regression test around the retry handler."]
    );
    assert_eq!(reported.agent_report.proposed_checks.len(), 1);
    assert_eq!(reported.agent_report.validation_flows.len(), 1);
    let initial_plan_revision = reported.verification_plan.revision;
    let promoted = fixture
        .service
        .promote_agent_verification_check(workspace_id, "checkout-cargo-test")
        .expect("promote reviewed check");
    assert_eq!(
        promoted.verification_plan.revision,
        initial_plan_revision + 1
    );
    assert_eq!(promoted.verification_plan.checks.len(), 1);
    assert_eq!(
        promoted.verification_plan.checks[0].id,
        "agent-checkout-cargo-test"
    );
    assert_eq!(
        promoted.verification_plan.checks[0].args,
        ["test", "--quiet"]
    );
    assert!(promoted.verification_plan.checks[0].required);
    assert_eq!(
        promoted.verification_result.status,
        VerificationStatus::NotRun
    );
    assert_eq!(
        promoted.verification_result.plan_revision,
        promoted.verification_plan.revision
    );
    assert!(promoted.verification_result.checks.is_empty());
    let replayed_promotion = fixture
        .service
        .promote_agent_verification_check(workspace_id, "checkout-cargo-test")
        .expect("promotion is idempotent");
    assert_eq!(
        replayed_promotion.verification_plan.revision,
        promoted.verification_plan.revision
    );
    assert_eq!(replayed_promotion.verification_plan.checks.len(), 1);
    fs::write(
        evidence_root.join("agent-report.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "schemaVersion": WORKSPACE_EVIDENCE_SCHEMA_VERSION,
            "workspaceId": workspace_id,
            "updatedAtUnixMs": 1_721_776_500_001_i64,
            "summary": "Out-of-scope report",
            "findings": [{
                "id": "outside-scope",
                "title": "Outside scope",
                "detail": "",
                "severity": "critical",
                "repositoryId": "repo_not_allowed",
                "evidence": []
            }],
            "nextActions": []
        }))
        .expect("serialize invalid agent report"),
    )
    .expect("publish invalid agent report");
    let invalid_report = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("WTS-owned evidence remains readable")
        .expect("evidence exists");
    assert_eq!(
        invalid_report.agent_report.status,
        AgentReportStatus::Invalid
    );
    assert!(invalid_report.agent_report.findings.is_empty());
    let browser_runs = fixture
        .service
        .list_workspace_test_runs(workspace_id)
        .expect("empty browser journey history");
    assert_eq!(browser_runs.workspace_id, workspace_id);
    assert!(browser_runs.runs.is_empty());

    let stale_replay = fixture
        .service
        .materialize_workspace(workspace_id, "sha256:stale-after-success")
        .expect_err("stale replay digest");
    assert!(matches!(stale_replay, LocalWtsError::StalePreflight));

    let replay = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("idempotent materialization replay");
    assert!(replay.replayed);
    assert_eq!(replay.materialization, first.materialization);

    let opened = fixture
        .service
        .open_workspace_in_vscode(workspace_id)
        .expect("open VS Code");
    assert!(opened.accepted);
    assert_eq!(
        Path::new(&opened.code_workspace_display_path)
            .file_name()
            .and_then(|name| name.to_str()),
        Some("platform-42-fix-duplicate-checkout-capture.code-workspace"),
        "VS Code should show the issue workspace identity, not the WTS product name"
    );
    let launched = fixture
        .launcher
        .launched_vscode
        .lock()
        .expect("launcher lock");
    assert_eq!(
        launched.as_slice(),
        [PathBuf::from(&opened.code_workspace_display_path)]
    );
    assert!(launched[0].starts_with(&fixture.workspace_root));
    drop(launched);

    let cli = fixture
        .service
        .open_workspace_cli(workspace_id, AgentProvider::Hermes, TerminalProvider::Warp)
        .expect("open workspace CLI without a graph index");
    assert!(cli.accepted);
    assert_eq!(cli.provider, AgentProvider::Hermes);
    assert_eq!(cli.terminal, TerminalProvider::Warp);
    assert_eq!(
        cli.workspace_display_path,
        first.materialization.workspace_display_path
    );
    let sessions = fixture
        .service
        .list_agent_sessions(None)
        .expect("global agent session ledger");
    assert_eq!(sessions.sessions.len(), 1);
    assert_eq!(sessions.sessions[0].session_id, cli.session_id);
    assert_eq!(sessions.sessions[0].workspace_id, workspace_id);
    assert_eq!(
        sessions.sessions[0].status,
        AgentSessionStatus::HandoffAccepted
    );
    assert!(
        sessions.sessions[0]
            .ended_at_unix_ms
            .is_some_and(|ended| ended >= sessions.sessions[0].started_at_unix_ms),
        "a terminal handoff must be terminalized rather than reported as observed running time"
    );
    let reopened_sessions = fixture
        .reopen(RecordingLauncher::default())
        .list_agent_sessions(None)
        .expect("reopen global agent session ledger");
    assert_eq!(reopened_sessions.sessions[0].session_id, cli.session_id);
    let launched_cli = fixture
        .launcher
        .launched_cli
        .lock()
        .expect("CLI launcher lock");
    assert_eq!(
        launched_cli.as_slice(),
        [(
            PathBuf::from(&first.materialization.workspace_display_path),
            AgentProvider::Hermes,
            TerminalProvider::Warp,
        )]
    );
    drop(launched_cli);

    fs::write(
        &opened.code_workspace_display_path,
        r#"{"folders":[{"name":"outside","path":"/tmp"}]}"#,
    )
    .expect("tamper fixture");
    assert!(matches!(
        fixture.service.open_workspace_in_vscode(workspace_id),
        Err(LocalWtsError::InvalidMaterializationManifest)
    ));
    assert!(matches!(
        fixture.service.open_workspace_cli(
            workspace_id,
            AgentProvider::Codex,
            TerminalProvider::Terminal,
        ),
        Err(LocalWtsError::InvalidMaterializationManifest)
    ));
    let attention = fixture
        .service
        .list_workspaces()
        .expect("list attention lifecycle")
        .workspaces
        .into_iter()
        .find(|workspace| workspace.workspace_id == workspace_id)
        .expect("listed workspace");
    assert_eq!(
        attention.lifecycle.materialization_state,
        WorkspaceMaterializationState::NeedsAttention
    );

    assert_eq!(branch(&fixture.api), "main");
    assert_eq!(branch(&fixture.web), "main");
}

#[test]
fn rename_moves_the_materialized_workspace_and_repairs_its_managed_paths() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api", "checkout-web"]);
    let previous_workspace = materialize_test_workspace(&fixture, workspace_id);
    let marker = previous_workspace.join("user-marker.txt");
    fs::write(&marker, "keep me").expect("workspace marker");
    let test_store = TestArtifactStore::open(&previous_workspace).expect("test artifact store");
    let (test_run_id, _) = write_screenshot_test_run(&test_store, workspace_id, b"screenshot");

    let renamed = fixture
        .service
        .rename_workspace(
            workspace_id,
            RenameWorkspaceRequest {
                title: "Release readiness".to_owned(),
            },
        )
        .expect("rename materialized workspace");
    let current_workspace = PathBuf::from(&renamed.workspace_display_path);

    assert_ne!(current_workspace, previous_workspace);
    assert!(!previous_workspace.exists());
    assert!(current_workspace.is_dir());
    assert_eq!(
        fs::read_to_string(current_workspace.join("user-marker.txt")).expect("moved marker"),
        "keep me"
    );
    assert_eq!(
        renamed.workspace_leaf,
        format!("release-readiness-{workspace_id}")
    );

    let materialization = fixture
        .service
        .open_workspace_in_vscode(workspace_id)
        .expect("open renamed workspace");
    assert!(
        Path::new(&materialization.code_workspace_display_path).starts_with(&current_workspace)
    );
    assert_eq!(
        Path::new(&materialization.code_workspace_display_path)
            .file_name()
            .and_then(|name| name.to_str()),
        Some("release-readiness.code-workspace")
    );
    assert!(Path::new(&materialization.code_workspace_display_path).is_file());
    assert!(
        !current_workspace
            .join("platform-42-fix-duplicate-checkout-capture.code-workspace")
            .exists()
    );
    let evidence = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("read renamed evidence")
        .expect("materialized evidence");
    assert_eq!(
        Path::new(&evidence.context.workspace_display_path),
        current_workspace.as_path()
    );
    assert_eq!(evidence.context.title, "Fix duplicate checkout capture");
    assert_eq!(
        evidence.context.code_workspace_display_path,
        materialization.code_workspace_display_path
    );
    assert!(evidence.context.repositories.iter().all(|repository| {
        Path::new(&repository.worktree_display_path).starts_with(&current_workspace)
    }));
    for repository in &evidence.context.repositories {
        let output = Command::new("git")
            .arg("-C")
            .arg(&repository.worktree_display_path)
            .arg("status")
            .arg("--porcelain=v1")
            .output()
            .expect("inspect moved worktree");
        assert!(output.status.success(), "Git rejected a moved worktree");
    }
    let test_result = fixture
        .service
        .get_workspace_test_run(workspace_id, test_run_id)
        .expect("read moved test run");
    assert!(
        test_result
            .artifacts
            .iter()
            .all(|artifact| { Path::new(&artifact.display_path).starts_with(&current_workspace) })
    );
    let guide = fs::read_to_string(current_workspace.join("WTS.md")).expect("renamed guide");
    assert!(!guide.contains(previous_workspace.to_string_lossy().as_ref()));
    assert!(guide.contains(current_workspace.to_string_lossy().as_ref()));

    // Simulate a workspace renamed by an older WTS build. Reapplying the
    // current display name must repair its redundant VS Code filename.
    let legacy_code_workspace =
        current_workspace.join("platform-42-release-readiness.code-workspace");
    let mut legacy_materialization = fixture
        .service
        .get_materialization(workspace_id)
        .expect("read current receipt")
        .expect("current receipt");
    fs::rename(
        &materialization.code_workspace_display_path,
        &legacy_code_workspace,
    )
    .expect("restore legacy VS Code filename");
    legacy_materialization.code_workspace_display_path =
        legacy_code_workspace.to_string_lossy().into_owned();
    fs::write(
        current_workspace.join(".wts-workspace.json"),
        serde_json::to_vec_pretty(&legacy_materialization).expect("legacy receipt"),
    )
    .expect("write legacy receipt");
    serde_json::from_slice::<wts_app::WorkspaceMaterialization>(
        &fs::read(current_workspace.join(".wts-workspace.json")).expect("read legacy receipt"),
    )
    .expect("decode legacy receipt");
    let context_path = current_workspace.join(".wts/context.json");
    let mut legacy_context: serde_json::Value =
        serde_json::from_slice(&fs::read(&context_path).expect("read legacy context"))
            .expect("decode legacy context");
    legacy_context["codeWorkspaceDisplayPath"] =
        serde_json::Value::String(legacy_code_workspace.to_string_lossy().into_owned());
    fs::write(
        &context_path,
        serde_json::to_vec_pretty(&legacy_context).expect("legacy context"),
    )
    .expect("write legacy context");

    fixture
        .service
        .rename_workspace(
            workspace_id,
            RenameWorkspaceRequest {
                title: "Release readiness".to_owned(),
            },
        )
        .expect("repair an earlier rename");
    let repaired = fixture
        .service
        .open_workspace_in_vscode(workspace_id)
        .expect("open repaired workspace");
    assert_eq!(
        repaired.code_workspace_display_path,
        materialization.code_workspace_display_path
    );
    assert!(!legacy_code_workspace.exists());
}

#[test]
fn reads_one_bounded_repository_diff_from_the_managed_worktree() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let materialization = materialize_test_workspace(&fixture, workspace_id);
    let receipt = fixture
        .service
        .get_materialization(workspace_id)
        .expect("read materialization")
        .expect("materialization exists");
    let worktree = &receipt.worktrees[0];
    fs::write(
        Path::new(&worktree.target_display_path).join("README.md"),
        "changed in WTS\n",
    )
    .expect("tracked change");
    fs::write(
        Path::new(&worktree.target_display_path).join("notes.txt"),
        "untracked\n",
    )
    .expect("untracked change");

    let diff = fixture
        .service
        .workspace_repository_diff(workspace_id, &worktree.repository_id)
        .expect("workspace repository diff");

    assert_eq!(diff.workspace_id, workspace_id);
    assert_eq!(diff.repository_id, worktree.repository_id);
    assert!(diff.patch.contains("diff --git a/README.md b/README.md"));
    assert!(diff.patch.contains("diff --git a/notes.txt b/notes.txt"));
    assert!(diff.patch.contains("+untracked"));
    assert_eq!(diff.untracked_paths, ["notes.txt"]);
    assert!(!diff.patch_truncated);
    assert_eq!(diff.review_graph, None);
    assert!(materialization.is_dir());
    assert!(matches!(
        fixture
            .service
            .workspace_repository_diff(workspace_id, "repo-unknown"),
        Err(LocalWtsError::RepositoryNotFound)
    ));
}

#[test]
fn reads_one_complete_file_only_from_the_selected_managed_repository() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    materialize_test_workspace(&fixture, workspace_id);
    let receipt = fixture
        .service
        .get_materialization(workspace_id)
        .expect("read materialization")
        .expect("materialization exists");
    let worktree = &receipt.worktrees[0];
    let worktree_path = Path::new(&worktree.target_display_path);
    let content = (1..=120)
        .map(|line| {
            if line == 60 {
                "changed line 60".to_owned()
            } else {
                format!("neutral line {line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(worktree_path.join("README.md"), &content).expect("tracked change");
    let diff = fixture
        .service
        .workspace_repository_diff(workspace_id, &worktree.repository_id)
        .expect("bounded repository diff");

    let review = fixture
        .service
        .workspace_repository_file_review(
            workspace_id,
            &worktree.repository_id,
            "README.md",
            &diff.patch_sha256,
        )
        .expect("complete file review");

    assert_eq!(review.workspace_id, workspace_id);
    assert_eq!(review.repository_id, worktree.repository_id);
    assert_eq!(review.file_path, "README.md");
    assert_eq!(review.content, content);
    assert!(review.full_patch.contains("+neutral line 120"));
    assert_eq!(review.patch_sha256, diff.patch_sha256);
    assert!(review.content_sha256.starts_with("sha256:"));
    assert!(matches!(
        fixture.service.workspace_repository_file_review(
            workspace_id,
            "repo-outside-workspace",
            "README.md",
            &diff.patch_sha256,
        ),
        Err(LocalWtsError::RepositoryNotFound)
    ));
    assert!(matches!(
        fixture.service.workspace_repository_file_review(
            workspace_id,
            &worktree.repository_id,
            "../README.md",
            &diff.patch_sha256,
        ),
        Err(LocalWtsError::InvalidRepositoryFilePath)
    ));
    fs::write(worktree_path.join("README.md"), "newer worktree state\n")
        .expect("newer tracked change");
    assert!(matches!(
        fixture.service.workspace_repository_file_review(
            workspace_id,
            &worktree.repository_id,
            "README.md",
            &diff.patch_sha256,
        ),
        Err(LocalWtsError::WorkspaceGitStateChanged)
    ));
}

#[test]
fn code_review_threads_require_an_exact_current_changed_line() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    materialize_test_workspace(&fixture, workspace_id);
    let receipt = fixture
        .service
        .get_materialization(workspace_id)
        .expect("read materialization")
        .expect("materialization exists");
    let worktree = &receipt.worktrees[0];
    let worktree_path = Path::new(&worktree.target_display_path);
    fs::write(worktree_path.join("README.md"), "changed in review\n")
        .expect("write tracked change");
    let diff = fixture
        .service
        .workspace_repository_diff(workspace_id, &worktree.repository_id)
        .expect("read current diff");
    let target = ReviewTarget::CodeChange {
        repository_id: diff.repository_id.clone(),
        base_commit_oid: diff.base_commit_oid.clone(),
        head_commit_oid: diff.head_commit_oid.clone(),
        patch_sha256: diff.patch_sha256.clone(),
        file_path: "README.md".into(),
        side: ReviewCodeSide::Additions,
        line: 1,
    };
    let created = fixture
        .service
        .create_workspace_review_thread(
            workspace_id,
            CreateWorkspaceReviewThreadRequest {
                target: target.clone(),
                author: ReviewAuthor::User,
                body: "Explain why this line changed.".into(),
            },
        )
        .expect("create changed-line review thread");
    assert_eq!(created.anchor_state, ReviewAnchorState::Current);
    assert_eq!(created.target, target);
    let inbox: serde_json::Value = serde_json::from_slice(
        &fs::read(Path::new(&receipt.workspace_display_path).join(".wts/review-inbox.json"))
            .expect("read code review inbox"),
    )
    .expect("parse code review inbox");
    assert_eq!(inbox["openThreadCount"], 1);
    assert_eq!(inbox["includedOpenThreadCount"], 1);
    assert_eq!(inbox["openThreads"][0]["target"]["kind"], "codeChange");
    assert_eq!(inbox["openThreads"][0]["target"]["filePath"], "README.md");
    assert_eq!(inbox["openThreads"][0]["target"]["line"], 1);

    assert!(matches!(
        fixture.service.create_workspace_review_thread(
            workspace_id,
            CreateWorkspaceReviewThreadRequest {
                target: ReviewTarget::CodeChange {
                    repository_id: diff.repository_id.clone(),
                    base_commit_oid: diff.base_commit_oid.clone(),
                    head_commit_oid: diff.head_commit_oid.clone(),
                    patch_sha256: diff.patch_sha256.clone(),
                    file_path: "README.md".into(),
                    side: ReviewCodeSide::Additions,
                    line: 999,
                },
                author: ReviewAuthor::User,
                body: "This line is not in the patch.".into(),
            }
        ),
        Err(LocalWtsError::InvalidReviewThread)
    ));

    fs::write(worktree_path.join("README.md"), "changed after feedback\n")
        .expect("change anchored patch");
    let stale = fixture
        .service
        .list_workspace_review_threads(workspace_id)
        .expect("list stale code review thread");
    assert_eq!(stale.threads[0].anchor_state, ReviewAnchorState::Stale);

    let unavailable_path = worktree_path.with_extension("review-unavailable");
    fs::rename(worktree_path, &unavailable_path).expect("hide reviewed worktree");
    let unavailable = fixture
        .service
        .list_workspace_review_threads(workspace_id)
        .expect("list unavailable code review thread");
    assert_eq!(
        unavailable.threads[0].anchor_state,
        ReviewAnchorState::Unavailable
    );
    fs::rename(&unavailable_path, worktree_path).expect("restore reviewed worktree");
}

#[test]
fn reads_the_selected_repository_diff_when_an_unrelated_worktree_is_unavailable() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api", "checkout-web"]);
    materialize_test_workspace(&fixture, workspace_id);
    let receipt = fixture
        .service
        .get_materialization(workspace_id)
        .expect("read materialization")
        .expect("materialization exists");
    let selected = receipt
        .worktrees
        .iter()
        .find(|worktree| worktree.label == "checkout-api")
        .expect("selected worktree");
    let unrelated = receipt
        .worktrees
        .iter()
        .find(|worktree| worktree.label == "checkout-web")
        .expect("unrelated worktree");
    fs::write(
        Path::new(&selected.target_display_path).join("README.md"),
        "selected change\n",
    )
    .expect("selected change");
    fs::remove_dir_all(&unrelated.target_display_path).expect("remove unrelated worktree");

    let diff = fixture
        .service
        .workspace_repository_diff(workspace_id, &selected.repository_id)
        .expect("selected repository diff");

    assert_eq!(diff.repository_id, selected.repository_id);
    assert!(diff.patch.contains("+selected change"));
}

#[test]
fn reloads_and_replays_a_materialized_workspace_after_service_restart() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api", "checkout-web"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let first = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");

    let restarted_launcher = RecordingLauncher::default();
    let restarted = fixture.reopen(restarted_launcher);
    let reloaded = restarted
        .get_materialization(workspace_id)
        .expect("reload materialization")
        .expect("materialization exists");
    assert_eq!(reloaded, first.materialization);
    let evidence = restarted
        .get_workspace_evidence(workspace_id)
        .expect("reload evidence")
        .expect("evidence exists");
    assert_eq!(evidence.context.workspace_id, workspace_id);
    assert_eq!(evidence.context.repositories.len(), 2);

    let replay = restarted
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("replay after restart");
    assert!(replay.replayed);
    assert_eq!(replay.materialization, first.materialization);
    assert_eq!(branch(&fixture.api), "main");
    assert_eq!(branch(&fixture.web), "main");
}

#[test]
fn adds_a_repository_to_the_current_workspace_without_changing_existing_work() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight workspace");
    let initial = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize workspace")
        .materialization;
    let existing_worktree = PathBuf::from(&initial.worktrees[0].target_display_path);
    let local_work = existing_worktree.join("local-work.txt");
    fs::write(&local_work, "keep this local change\n").expect("write local work");
    let catalog = fixture
        .service
        .repository_catalog()
        .expect("repository catalog");
    let repository = catalog
        .repositories
        .iter()
        .find(|repository| repository.label == "checkout-web")
        .expect("checkout-web repository");

    let addition_request = AddWorkspaceRepositoryRequest {
        repository_id: repository.id.clone(),
        base_ref: repository.default_branch.name.clone(),
    };
    let addition_preflight = fixture
        .service
        .preflight_workspace_repository_addition(workspace_id, addition_request.clone())
        .expect("preflight repository addition");
    let added = fixture
        .service
        .add_workspace_repository(
            workspace_id,
            addition_request,
            &addition_preflight.effect_digest,
        )
        .expect("add repository");

    assert_eq!(added.workspace_id, workspace_id);
    assert_eq!(added.materialization.workspace_id, workspace_id);
    assert_eq!(
        added.materialization.workspace_display_path,
        initial.workspace_display_path
    );
    assert_eq!(added.materialization.worktrees.len(), 2);
    assert_eq!(
        fs::read_to_string(&local_work).expect("read preserved local work"),
        "keep this local change\n"
    );
    assert_eq!(
        added.materialization.worktrees[0].target_display_path,
        initial.worktrees[0].target_display_path
    );
    let workspace = fixture
        .service
        .get_workspace(workspace_id)
        .expect("read workspace")
        .expect("workspace exists");
    assert_eq!(workspace.repositories.len(), 2);
    let code_workspace = fs::read_to_string(&added.materialization.code_workspace_display_path)
        .expect("read VS Code workspace");
    assert!(code_workspace.contains("checkout-api"), "{code_workspace}");
    assert!(code_workspace.contains("checkout-web"), "{code_workspace}");

    let added_worktree = added
        .materialization
        .worktrees
        .iter()
        .find(|worktree| worktree.repository_id == repository.id)
        .expect("added worktree");
    let added_worktree_path = PathBuf::from(&added_worktree.target_display_path);
    let removed = fixture
        .service
        .remove_workspace_repository(workspace_id, &repository.id)
        .expect("remove repository from current workspace");

    assert_eq!(removed.workspace_id, workspace_id);
    assert_eq!(removed.repository_id, repository.id);
    assert_eq!(removed.materialization.worktrees.len(), 1);
    assert_eq!(
        fs::read_to_string(&local_work).expect("read retained local work"),
        "keep this local change\n"
    );
    assert!(!added_worktree_path.exists());
    assert!(
        fixture.web.exists(),
        "the stored checkout must stay on disk"
    );
    let workspace = fixture
        .service
        .get_workspace(workspace_id)
        .expect("read workspace after removal")
        .expect("workspace exists after removal");
    assert_eq!(workspace.repositories.len(), 1);
    let code_workspace = fs::read_to_string(&removed.materialization.code_workspace_display_path)
        .expect("read VS Code workspace after removal");
    assert!(code_workspace.contains("checkout-api"), "{code_workspace}");
    assert!(!code_workspace.contains("checkout-web"), "{code_workspace}");
}

#[test]
fn records_and_validates_an_existing_workspace_graph() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");
    let workspace = Path::new(&materialized.materialization.workspace_display_path);
    let worktree = Path::new(&materialized.materialization.worktrees[0].target_display_path);
    fs::write(worktree.join("indexed.txt"), "current head\n").expect("indexed change");
    git(Some(worktree), ["add", "indexed.txt"]);
    git(Some(worktree), ["commit", "-m", "advance graph head"]);
    let current_head = git_output(Some(worktree), ["rev-parse", "HEAD"]);
    let graph_directory = workspace.join("graphify-out");
    fs::create_dir(&graph_directory).expect("graph directory");
    let graph = graph_directory.join("graph.json");
    let repository_leaf = worktree
        .strip_prefix(workspace)
        .expect("repository inside workspace")
        .to_string_lossy();
    fs::write(
        &graph,
        format!(
            r#"{{"nodes":[{{"id":"file","label":"indexed.txt","source_file":"{repository_leaf}/indexed.txt","source_location":"L1"}},{{"id":"symbol","label":"currentHead","source_file":"{repository_leaf}/indexed.txt","source_location":"L1"}}],"links":[{{"source":"file","target":"symbol","relation":"contains","confidence":"EXTRACTED"}}]}}"#,
        ),
    )
    .expect("graph");

    let indexed = fixture
        .service
        .index_workspace_graph(workspace_id)
        .expect("record existing graph");
    assert_eq!(indexed.status, wts_app::GraphWorkspaceStatus::Ready);
    let evidence = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("graph evidence")
        .expect("evidence exists");
    assert_eq!(
        evidence.graph_manifest.status,
        WorkspaceGraphEvidenceStatus::Ready
    );
    assert!(
        evidence
            .graph_manifest
            .graph_sha256
            .as_deref()
            .is_some_and(|digest| digest.starts_with("sha256:"))
    );
    assert_eq!(evidence.graph_manifest.indexed_repositories.len(), 1);
    assert_eq!(
        evidence.graph_manifest.indexed_repositories[0].commit_oid,
        current_head.trim()
    );
    assert_ne!(
        evidence.graph_manifest.indexed_repositories[0].commit_oid,
        materialized.materialization.worktrees[0].base_commit_oid
    );

    fs::write(worktree.join("indexed.txt"), "current head\nchanged\n").expect("review change");
    let review = fixture
        .service
        .workspace_repository_diff(
            workspace_id,
            &materialized.materialization.worktrees[0].repository_id,
        )
        .expect("initial repository review");
    assert_eq!(review.review_graph, None);
    let review_graph = fixture
        .service
        .workspace_repository_review_graph(
            workspace_id,
            &materialized.materialization.worktrees[0].repository_id,
        )
        .expect("lazy review graph")
        .expect("bounded review graph");
    assert!(
        review_graph
            .nodes
            .iter()
            .any(|node| node.id == "symbol" && node.source_file == "indexed.txt")
    );
    assert!(review_graph.links.iter().any(|link| {
        link.source == "file" && link.target == "symbol" && link.relation == "contains"
    }));

    fs::write(&graph, br#"{"nodes":["tampered"],"edges":[]}"#).expect("tamper graph");
    assert!(
        fixture
            .service
            .workspace_repository_diff(
                workspace_id,
                &materialized.materialization.worktrees[0].repository_id,
            )
            .is_ok()
    );
    assert!(matches!(
        fixture.service.workspace_repository_review_graph(
            workspace_id,
            &materialized.materialization.worktrees[0].repository_id,
        ),
        Err(LocalWtsError::InvalidWorkspaceEvidence)
    ));
}

#[cfg(unix)]
#[test]
fn syncs_one_managed_repository_and_rebuilds_commit_bound_graph_evidence() {
    use std::os::unix::fs::PermissionsExt;

    let executable_fixture = tempfile::tempdir().expect("graph executable fixture");
    let graphify = executable_fixture.path().join("fake-graphify");
    fs::write(
        &graphify,
        "#!/bin/sh\nmkdir -p \"$2/graphify-out\"\nprintf '%s' '{\"nodes\":[],\"edges\":[]}' > \"$2/graphify-out/graph.json\"\n",
    )
    .expect("fake graphify");
    let mut permissions = fs::metadata(&graphify)
        .expect("graphify metadata")
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&graphify, permissions).expect("graphify permissions");
    let fixture = Fixture::with_agent_adapter(
        ProcessWorkspaceAdapter::default().with_graphify_executable(graphify),
    );
    let upstream = configure_local_origin(&fixture, &fixture.api);
    let workspace_id = fixture.create_plan(&["checkout-api", "checkout-web"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize")
        .materialization;
    let api = materialized
        .worktrees
        .iter()
        .find(|worktree| worktree.label == "checkout-api")
        .expect("API worktree");
    let web = materialized
        .worktrees
        .iter()
        .find(|worktree| worktree.label == "checkout-web")
        .expect("web worktree");
    let previous_api = api.base_commit_oid.clone();
    let previous_web = web.base_commit_oid.clone();
    let initial_revision = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("initial evidence")
        .expect("initial evidence exists")
        .verification_plan
        .revision;

    fs::write(upstream.join("upstream.txt"), "new upstream content\n").expect("upstream change");
    git(Some(&upstream), ["add", "upstream.txt"]);
    git(Some(&upstream), ["commit", "-m", "advance upstream"]);
    git(Some(&upstream), ["push", "origin", "main"]);
    let upstream_commit = git_output(Some(&upstream), ["rev-parse", "HEAD"])
        .trim()
        .to_owned();

    let result = fixture
        .service
        .sync_workspace_repository(workspace_id, &api.repository_id)
        .expect("sync repository");

    assert!(result.updated);
    assert!(result.graph_refreshed);
    assert_eq!(result.previous_base_commit_oid, previous_api);
    assert_eq!(result.base_commit_oid, upstream_commit);
    assert_eq!(
        result
            .materialization
            .worktrees
            .iter()
            .find(|worktree| worktree.repository_id == api.repository_id)
            .expect("synced worktree")
            .base_commit_oid,
        upstream_commit
    );
    assert_eq!(
        result
            .materialization
            .worktrees
            .iter()
            .find(|worktree| worktree.repository_id == web.repository_id)
            .expect("unchanged worktree")
            .base_commit_oid,
        previous_web
    );
    assert_eq!(
        result.materialization.graph.status,
        wts_app::GraphWorkspaceStatus::Ready
    );
    let evidence = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("synced evidence")
        .expect("synced evidence exists");
    assert_eq!(
        evidence
            .context
            .repositories
            .iter()
            .find(|repository| repository.repository_id == api.repository_id)
            .expect("API evidence")
            .base_commit_oid,
        upstream_commit
    );
    assert_eq!(evidence.verification_plan.revision, initial_revision + 1);
    assert_eq!(
        evidence.verification_result.status,
        VerificationStatus::NotRun
    );
    for indexed in &evidence.graph_manifest.indexed_repositories {
        let worktree = result
            .materialization
            .worktrees
            .iter()
            .find(|worktree| worktree.repository_id == indexed.repository_id)
            .expect("indexed repository");
        assert_eq!(
            indexed.commit_oid,
            worktree
                .git_state
                .as_ref()
                .expect("current Git state")
                .head_commit_oid
        );
    }
}

#[test]
fn materialization_exposes_the_configured_tracking_remote_url() {
    let fixture = Fixture::new();
    let _upstream = configure_local_origin(&fixture, &fixture.api);
    git(
        Some(&fixture.api),
        ["remote", "rename", "origin", "upstream"],
    );
    let tracking_url = git_output(
        Some(&fixture.api),
        ["config", "--get", "remote.upstream.url"],
    );
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize")
        .materialization;
    let worktree = &materialized.worktrees[0];
    assert_eq!(
        worktree
            .git_state
            .as_ref()
            .expect("Git state")
            .origin_url
            .as_deref(),
        Some(tracking_url.trim())
    );

    let result = fixture
        .service
        .sync_workspace_repository(workspace_id, &worktree.repository_id)
        .expect("no-op sync");

    assert!(!result.updated);
    assert_eq!(
        result.materialization.worktrees[0]
            .git_state
            .as_ref()
            .expect("refreshed Git state")
            .origin_url
            .as_deref(),
        Some(tracking_url.trim())
    );
}

#[cfg(unix)]
#[test]
fn repository_sync_reports_graph_failure_without_hiding_the_git_update() {
    use std::os::unix::fs::PermissionsExt;

    let executable_fixture = tempfile::tempdir().expect("graph executable fixture");
    let graphify = executable_fixture.path().join("failing-graphify");
    fs::write(&graphify, "#!/bin/sh\nexit 9\n").expect("fake graphify");
    let mut permissions = fs::metadata(&graphify)
        .expect("graphify metadata")
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&graphify, permissions).expect("graphify permissions");
    let fixture = Fixture::with_agent_adapter(
        ProcessWorkspaceAdapter::default().with_graphify_executable(graphify),
    );
    let upstream = configure_local_origin(&fixture, &fixture.api);
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize")
        .materialization;
    let repository_id = materialized.worktrees[0].repository_id.clone();
    fs::write(upstream.join("upstream.txt"), "new upstream content\n").expect("upstream change");
    git(Some(&upstream), ["add", "upstream.txt"]);
    git(Some(&upstream), ["commit", "-m", "advance upstream"]);
    git(Some(&upstream), ["push", "origin", "main"]);
    let upstream_commit = git_output(Some(&upstream), ["rev-parse", "HEAD"])
        .trim()
        .to_owned();

    let result = fixture
        .service
        .sync_workspace_repository(workspace_id, &repository_id)
        .expect("partial sync result");

    assert!(result.updated);
    assert!(!result.graph_refreshed);
    assert_eq!(result.base_commit_oid, upstream_commit);
    assert_eq!(
        result.materialization.graph.status,
        wts_app::GraphWorkspaceStatus::NotStarted
    );
    let evidence = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("partial evidence")
        .expect("partial evidence exists");
    assert_eq!(
        evidence.graph_manifest.status,
        WorkspaceGraphEvidenceStatus::Failed
    );
    assert_eq!(
        evidence.context.repositories[0].base_commit_oid,
        upstream_commit
    );
}

#[cfg(unix)]
#[test]
fn aligns_reviewed_divergent_history_and_preserves_the_registered_commit() {
    use std::os::unix::fs::PermissionsExt;

    let executable_fixture = tempfile::tempdir().expect("graph executable fixture");
    let graphify = executable_fixture.path().join("fake-graphify");
    fs::write(
        &graphify,
        "#!/bin/sh\nmkdir -p \"$2/graphify-out\"\nprintf '%s' '{\"nodes\":[],\"edges\":[]}' > \"$2/graphify-out/graph.json\"\n",
    )
    .expect("fake graphify");
    let mut permissions = fs::metadata(&graphify)
        .expect("graphify metadata")
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(&graphify, permissions).expect("graphify permissions");
    let fixture = Fixture::with_agent_adapter(
        ProcessWorkspaceAdapter::default().with_graphify_executable(graphify),
    );
    let upstream = configure_local_origin(&fixture, &fixture.api);
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("workspace preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize")
        .materialization;
    let worktree = materialized.worktrees[0].clone();
    let previous = worktree.base_commit_oid.clone();

    git(Some(&upstream), ["checkout", "--orphan", "rewritten"]);
    git(Some(&upstream), ["rm", "-r", "--cached", "."]);
    fs::remove_file(upstream.join("README.md")).expect("remove inherited file");
    fs::write(upstream.join("README.md"), "# rewritten history\n").expect("rewrite file");
    git(Some(&upstream), ["add", "README.md"]);
    git(
        Some(&upstream),
        ["commit", "-m", "rewrite upstream history"],
    );
    git(Some(&upstream), ["push", "--force", "origin", "HEAD:main"]);
    let target = git_output(Some(&upstream), ["rev-parse", "HEAD"])
        .trim()
        .to_owned();

    assert!(matches!(
        fixture
            .service
            .sync_workspace_repository(workspace_id, &worktree.repository_id),
        Err(LocalWtsError::RepositorySyncDiverged)
    ));
    let alignment = fixture
        .service
        .preflight_workspace_repository_alignment(workspace_id, &worktree.repository_id)
        .expect("alignment preflight");
    assert_eq!(alignment.current_commit_oid, previous);
    assert_eq!(alignment.target_commit_oid, target);
    assert!(alignment.effect_digest.starts_with("sha256:"));

    let result = fixture
        .service
        .align_workspace_repository(
            workspace_id,
            &worktree.repository_id,
            &alignment.effect_digest,
        )
        .expect("align repository");

    assert_eq!(result.previous_base_commit_oid, previous);
    assert_eq!(result.base_commit_oid, target);
    assert!(result.graph_refreshed);
    assert_eq!(
        git_output(
            Some(Path::new(&worktree.target_display_path)),
            ["rev-parse", result.backup_full_ref.as_str()],
        )
        .trim(),
        previous
    );
    let evidence = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("aligned evidence")
        .expect("aligned evidence exists");
    assert_eq!(evidence.context.repositories[0].base_commit_oid, target);
    assert_eq!(
        evidence.graph_manifest.indexed_repositories[0].commit_oid,
        target
    );
    assert_eq!(
        evidence.verification_result.status,
        VerificationStatus::NotRun
    );
}

#[test]
fn rejects_tampered_or_symlinked_workspace_evidence() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");
    let workspace = Path::new(&materialized.materialization.workspace_display_path);
    let context = workspace.join(".wts/context.json");
    let original = fs::read_to_string(&context).expect("context");
    let tampered = original.replace(
        "\"title\": \"Fix duplicate checkout capture\"",
        "\"title\": \"Different task\"",
    );
    assert_ne!(tampered, original);
    fs::write(&context, tampered).expect("tamper context");
    assert!(matches!(
        fixture.service.get_workspace_evidence(workspace_id),
        Err(LocalWtsError::InvalidWorkspaceEvidence)
    ));

    #[cfg(unix)]
    {
        fs::write(&context, original).expect("restore context");
        let outside = fixture.workspace_root.join("outside-context.json");
        fs::write(&outside, "{}").expect("outside");
        fs::remove_file(&context).expect("remove context");
        std::os::unix::fs::symlink(&outside, &context).expect("context symlink");
        assert!(matches!(
            fixture.service.get_workspace_evidence(workspace_id),
            Err(LocalWtsError::InvalidWorkspaceEvidence)
        ));
    }
}

#[test]
fn discovers_and_runs_a_persisted_workspace_verification_plan() {
    let fixture = Fixture::new();
    fs::write(
        fixture.web.join("package.json"),
        r#"{"name":"wts-verification-fixture","private":true,"scripts":{"test":"node --test"}}"#,
    )
    .expect("package manifest");
    fs::write(
        fixture.web.join("verification.test.js"),
        "import test from 'node:test';\ntest('passes', () => {});\n",
    )
    .expect("verification test");
    fs::write(
        fixture.web.join(".tool-versions"),
        include_str!("../../../.tool-versions"),
    )
    .expect("fixture node version");
    git(Some(&fixture.web), ["add", "."]);
    git(
        Some(&fixture.web),
        ["commit", "-m", "add deterministic verification"],
    );

    let workspace_id = fixture.create_plan(&["checkout-web"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");

    let evidence = fixture
        .service
        .get_workspace_evidence(workspace_id)
        .expect("evidence")
        .expect("materialized evidence");
    assert_eq!(evidence.verification_plan.checks.len(), 1);
    assert_eq!(
        evidence.verification_result.status,
        VerificationStatus::NotRun
    );

    let verified = fixture
        .service
        .run_workspace_verification(workspace_id)
        .expect("verification");
    assert_eq!(
        verified.verification_result.status,
        VerificationStatus::Passed
    );
    assert_eq!(
        verified.verification_result.checks[0].status,
        VerificationCheckStatus::Passed
    );
    let log_path = PathBuf::from(
        verified.verification_result.checks[0]
            .log_display_path
            .as_deref()
            .expect("bounded log"),
    );
    assert!(log_path.starts_with(&fixture.workspace_root));
    assert!(log_path.is_file());

    let check_id = verified.verification_plan.checks[0].id.clone();
    let targeted = fixture
        .service
        .run_workspace_verification_check(workspace_id, &check_id)
        .expect("targeted verification");
    assert_eq!(
        targeted.verification_result.checks[0].status,
        VerificationCheckStatus::Passed
    );

    let worktree = PathBuf::from(&targeted.verification_plan.checks[0].working_directory);
    fs::write(
        worktree.join("verification.test.js"),
        "import test from 'node:test';\ntest('fails', () => { throw new Error('expected'); });\n",
    )
    .expect("write failing verification");
    let failed = fixture
        .service
        .run_workspace_verification_check(workspace_id, &check_id)
        .expect("failed targeted verification result");
    assert_eq!(
        failed.verification_result.status,
        VerificationStatus::Failed
    );
    assert_eq!(
        failed.verification_result.checks[0].status,
        VerificationCheckStatus::Failed
    );
    let failed_completed_at = failed
        .verification_result
        .completed_at_unix_ms
        .expect("failed verification completion time");
    assert!(matches!(
        fixture.service.create_workspace_review_thread(
            workspace_id,
            CreateWorkspaceReviewThreadRequest {
                target: ReviewTarget::VerificationCheck {
                    plan_revision: failed.verification_result.plan_revision,
                    completed_at_unix_ms: failed_completed_at + 1,
                    check_id: check_id.clone(),
                },
                author: ReviewAuthor::User,
                body: "This must stay attached to the exact completed run.".into(),
            },
        ),
        Err(LocalWtsError::InvalidReviewThread)
    ));
    let verification_thread = fixture
        .service
        .create_workspace_review_thread(
            workspace_id,
            CreateWorkspaceReviewThreadRequest {
                target: ReviewTarget::VerificationCheck {
                    plan_revision: failed.verification_result.plan_revision,
                    completed_at_unix_ms: failed_completed_at,
                    check_id: check_id.clone(),
                },
                author: ReviewAuthor::User,
                body: "The local service was not running for this check.".into(),
            },
        )
        .expect("create verification feedback");
    assert_eq!(verification_thread.anchor_state, ReviewAnchorState::Current);
    let inbox_path =
        Path::new(&failed.context.workspace_display_path).join(".wts/review-inbox.json");
    let inbox: serde_json::Value =
        serde_json::from_slice(&fs::read(inbox_path).expect("read verification inbox"))
            .expect("parse verification inbox");
    assert_eq!(
        inbox["openThreads"][0]["target"]["kind"],
        "verificationCheck"
    );
    assert_eq!(
        inbox["openThreads"][0]["target"]["completedAtUnixMs"],
        failed_completed_at
    );
    assert_eq!(inbox["openThreads"][0]["target"]["checkId"], check_id);

    fs::write(
        worktree.join("verification.test.js"),
        "import test from 'node:test';\ntest('passes again', () => {});\n",
    )
    .expect("repair verification");
    let rerun = fixture
        .service
        .rerun_failed_workspace_verification(workspace_id)
        .expect("rerun failed verification");
    assert_eq!(rerun.verification_result.status, VerificationStatus::Passed);
    assert_eq!(
        rerun.verification_result.checks[0].status,
        VerificationCheckStatus::Passed
    );
    let listed = fixture
        .service
        .list_workspace_review_threads(workspace_id)
        .expect("list stale verification feedback");
    let stale = listed
        .threads
        .iter()
        .find(|thread| thread.thread_id == verification_thread.thread_id)
        .expect("verification feedback thread");
    assert_eq!(stale.anchor_state, ReviewAnchorState::Stale);
    assert_eq!(
        stale.current_verification_completed_at_unix_ms,
        rerun.verification_result.completed_at_unix_ms
    );
}

#[test]
fn reconciles_user_owned_branch_head_origin_and_upstream_changes() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize");
    let worktree = PathBuf::from(&materialized.materialization.worktrees[0].target_display_path);

    git(Some(&worktree), ["switch", "-c", "manual-drift"]);
    fs::write(worktree.join("pulled.txt"), "new upstream content\n").expect("changed checkout");
    git(Some(&worktree), ["add", "pulled.txt"]);
    git(Some(&worktree), ["commit", "-m", "simulate pulled commit"]);
    git(
        Some(&worktree),
        [
            "remote",
            "add",
            "origin",
            "https://github.com/example/checkout-api.git",
        ],
    );
    git(
        Some(&worktree),
        ["branch", "--set-upstream-to=main", "manual-drift"],
    );
    let changed_head = git_output(Some(&worktree), ["rev-parse", "HEAD"])
        .trim()
        .to_owned();
    let changed_inspection = wts_git::GitWorktreeService::new()
        .inspect_repository(&worktree)
        .expect("inspect changed worktree");
    assert_eq!(
        changed_inspection.current_branch_full_ref.as_deref(),
        Some("refs/heads/manual-drift")
    );
    assert_eq!(
        changed_inspection.upstream_full_ref.as_deref(),
        Some("refs/heads/main")
    );

    let last_known = fixture
        .service
        .list_workspaces()
        .expect("cheap list after external drift")
        .workspaces
        .into_iter()
        .find(|workspace| workspace.workspace_id == workspace_id)
        .expect("listed workspace");
    assert_eq!(
        last_known.lifecycle.materialization_state,
        WorkspaceMaterializationState::Materialized,
        "the list projection must remain cheap and last-known"
    );

    assert!(matches!(
        fixture.service.get_materialization(workspace_id),
        Err(LocalWtsError::WorkspaceGitStateChanged)
    ));
    let listed = fixture
        .service
        .list_workspaces()
        .expect("list drift lifecycle")
        .workspaces
        .into_iter()
        .find(|workspace| workspace.workspace_id == workspace_id)
        .expect("listed workspace");
    assert_eq!(
        listed.lifecycle.materialization_state,
        WorkspaceMaterializationState::NeedsAttention
    );

    let opened_during_git_changes = fixture
        .service
        .open_workspace_in_vscode(workspace_id)
        .expect("Git changes must not block the VS Code handoff");
    assert_eq!(
        opened_during_git_changes.code_workspace_display_path,
        materialized.materialization.code_workspace_display_path
    );
    assert_eq!(
        fixture
            .launcher
            .launched_vscode
            .lock()
            .expect("launcher lock")
            .as_slice(),
        [PathBuf::from(
            &materialized.materialization.code_workspace_display_path
        )]
    );

    let guide_path = Path::new(&materialized.materialization.workspace_display_path).join("WTS.md");
    fs::remove_file(&guide_path).expect("simulate a legacy workspace without WTS.md");
    let reconciled = fixture
        .service
        .reconcile_workspace(workspace_id)
        .expect("reconcile expected Git evolution");
    assert!(
        fs::read_to_string(&guide_path)
            .expect("reconcile restores WTS.md")
            .contains("wts-report --input")
    );
    let reconciled_worktree = &reconciled.worktrees[0];
    let git_state = reconciled_worktree
        .git_state
        .as_ref()
        .expect("recorded current Git state");
    assert_eq!(reconciled_worktree.branch_name, "manual-drift");
    assert_eq!(git_state.head_commit_oid, changed_head);
    assert_eq!(
        git_state.origin_url.as_deref(),
        Some("https://github.com/example/checkout-api.git")
    );
    assert_eq!(
        git_state.upstream_full_ref.as_deref(),
        Some("refs/heads/main")
    );
    assert_eq!(
        fixture
            .service
            .get_materialization(workspace_id)
            .expect("validated reconciled workspace"),
        Some(reconciled)
    );
    fixture
        .service
        .open_workspace_in_vscode(workspace_id)
        .expect("reconciled workspace opens");
}

#[test]
fn manually_removes_saved_plan_without_filesystem_effects_and_replays() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace = fixture
        .service
        .get_workspace(workspace_id)
        .expect("workspace")
        .expect("saved plan");
    assert!(!Path::new(&workspace.workspace_display_path).exists());

    let preflight = fixture
        .service
        .preflight_workspace_removal(workspace_id)
        .expect("removal preflight");
    assert_eq!(preflight.kind, WorkspaceRemovalKind::SavedPlan);
    assert!(preflight.ready);
    assert!(preflight.worktrees.is_empty());
    assert!(preflight.generated_paths.is_empty());

    let idempotency_key = Uuid::new_v4().to_string();
    let removed = fixture
        .service
        .remove_workspace(
            workspace_id,
            &preflight.effect_digest,
            &idempotency_key,
            false,
        )
        .expect("remove saved plan");
    assert!(!removed.replayed);
    assert_eq!(removed.removed_worktree_count, 0);
    assert!(!Path::new(&workspace.workspace_display_path).exists());
    assert!(
        fixture
            .service
            .get_workspace(workspace_id)
            .expect("hidden workspace")
            .is_none()
    );

    let replay = fixture
        .service
        .remove_workspace(
            workspace_id,
            &preflight.effect_digest,
            &idempotency_key,
            false,
        )
        .expect("removal replay");
    assert!(replay.replayed);
    assert_eq!(replay.workspace_id, workspace_id);
}

#[test]
fn removal_idempotency_key_cannot_be_reused_for_another_workspace() {
    let fixture = Fixture::new();
    let first_workspace_id = fixture.create_plan(&["checkout-api"]);
    let second_workspace_id = fixture.create_plan(&["checkout-web"]);
    let first_preflight = fixture
        .service
        .preflight_workspace_removal(first_workspace_id)
        .expect("first removal preflight");
    let second_preflight = fixture
        .service
        .preflight_workspace_removal(second_workspace_id)
        .expect("second removal preflight");
    let idempotency_key = Uuid::new_v4();

    fixture
        .service
        .remove_workspace(
            first_workspace_id,
            &first_preflight.effect_digest,
            &idempotency_key.to_string(),
            false,
        )
        .expect("remove first workspace");
    let conflict = fixture
        .service
        .remove_workspace(
            second_workspace_id,
            &second_preflight.effect_digest,
            &idempotency_key.to_string(),
            false,
        )
        .expect_err("cross-workspace idempotency reuse must conflict");
    assert!(matches!(
        conflict,
        LocalWtsError::Store(WorkspaceStoreError::TombstoneIdempotencyConflict {
            idempotency_key: found,
        }) if found == idempotency_key
    ));
    assert!(
        fixture
            .service
            .get_workspace(second_workspace_id)
            .expect("second workspace remains")
            .is_some()
    );
}

#[test]
fn manually_removes_clean_committed_worktree_and_retains_branch() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let create_preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("create preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &create_preflight.effect_digest)
        .expect("materialize");
    let workspace_path = PathBuf::from(&materialized.materialization.workspace_display_path);
    let target = PathBuf::from(&materialized.materialization.worktrees[0].target_display_path);
    fs::write(target.join("completed.txt"), "done\n").expect("completed work");
    git(Some(&target), ["add", "completed.txt"]);
    git(Some(&target), ["commit", "-m", "complete workspace"]);

    let preflight = fixture
        .service
        .preflight_workspace_removal(workspace_id)
        .expect("removal preflight");
    assert_eq!(preflight.kind, WorkspaceRemovalKind::MaterializedWorkspace);
    assert!(preflight.ready, "{:?}", preflight.blockers);
    assert_eq!(preflight.worktrees.len(), 1);
    assert!(preflight.worktrees[0].present);
    assert!(
        preflight
            .generated_paths
            .iter()
            .any(|path| path.ends_with(".wts-workspace.json"))
    );
    assert!(
        preflight
            .generated_paths
            .iter()
            .any(|path| path.ends_with("WTS.md"))
    );
    assert!(
        preflight
            .generated_paths
            .iter()
            .any(|path| path.ends_with("AGENTS.md"))
    );
    assert!(
        preflight
            .generated_paths
            .iter()
            .any(|path| path.ends_with("CLAUDE.md"))
    );
    assert!(
        preflight
            .generated_paths
            .iter()
            .any(|path| path.ends_with(".cursorrules"))
    );
    assert!(
        preflight
            .generated_paths
            .iter()
            .any(|path| path.ends_with(".github"))
    );
    let retained_branch = materialized.materialization.branch_name.clone();

    let removed = fixture
        .service
        .remove_workspace(
            workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            false,
        )
        .expect("remove materialized workspace");
    assert_eq!(removed.removed_worktree_count, 1);
    assert_eq!(removed.retained_branches, vec![retained_branch.clone()]);
    assert!(!workspace_path.exists());
    assert!(has_branch(&fixture.api, &retained_branch));
    assert!(
        fixture
            .service
            .get_workspace(workspace_id)
            .expect("hidden workspace")
            .is_none()
    );
}

#[test]
fn creates_an_editable_planning_home_and_requires_manual_preservation_or_deletion() {
    let fixture = Fixture::new();
    let planning = WorkspacePlanningSelection {
        folder: WorkspacePlanningFolder::PlansAndKanban,
        format: WorkspacePlanningFormat::Kanban,
    };
    let created = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "agent-planning".to_owned(),
                },
                title: "Agent planning workspace".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "checkout-api".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: Some(planning),
            },
        )
        .expect("planning workspace plan");
    assert_eq!(created.workspace.planning, Some(planning));

    let preflight = fixture
        .service
        .preflight_workspace(created.workspace.workspace_id)
        .expect("planning preflight");
    assert!(preflight.ready, "{:?}", preflight.blockers);
    assert_eq!(preflight.planning, Some(planning));
    let materialized = fixture
        .service
        .materialize_workspace(created.workspace.workspace_id, &preflight.effect_digest)
        .expect("planning materialization");
    assert_eq!(materialized.materialization.planning, Some(planning));

    let workspace = PathBuf::from(&materialized.materialization.workspace_display_path);
    let planning_home = workspace.join("plans-and-kanban");
    for leaf in [
        "README.md",
        "PLAN.md",
        "FINDINGS.md",
        "KANBAN.md",
        "PROGRAM-BACKLOG.md",
    ] {
        assert!(planning_home.join(leaf).is_file(), "missing {leaf}");
    }
    let code_workspace: serde_json::Value = serde_json::from_slice(
        &fs::read(&materialized.materialization.code_workspace_display_path)
            .expect("code workspace"),
    )
    .expect("code workspace JSON");
    assert!(
        code_workspace["folders"]
            .as_array()
            .expect("folders")
            .iter()
            .any(|folder| folder["path"] == planning_home.to_string_lossy().as_ref())
    );

    fs::write(
        planning_home.join("FINDINGS.md"),
        "# Findings\n\nPAY-2190 tracks the checkout retry work.\n",
    )
    .expect("edit findings");
    let worktree_path =
        PathBuf::from(&materialized.materialization.worktrees[0].target_display_path);
    fs::write(
        worktree_path.join("local-notes.txt"),
        "Uncommitted workspace notes.\n",
    )
    .expect("write uncommitted workspace file");
    let observed = fixture
        .service
        .get_workspace(created.workspace.workspace_id)
        .expect("refresh planning observations")
        .expect("planning workspace");
    assert_eq!(observed.repositories, created.workspace.repositories);
    assert_eq!(observed.observed_work_items.len(), 1);
    assert_eq!(observed.observed_work_items[0].issue_key, "PAY-2190");
    assert_eq!(
        observed.observed_work_items[0].source_files,
        vec!["FINDINGS.md"]
    );
    let reopened = fixture.reopen(RecordingLauncher::default());
    let reopened_items = reopened
        .get_workspace(created.workspace.workspace_id)
        .expect("read persisted observations")
        .expect("planning workspace")
        .observed_work_items;
    assert_eq!(reopened_items.len(), 1);
    assert_eq!(reopened_items[0].issue_key, "PAY-2190");
    assert_eq!(reopened_items[0].source_files, vec!["FINDINGS.md"]);
    assert!(
        reopened_items[0].observed_at_unix_ms
            >= observed.observed_work_items[0].observed_at_unix_ms
    );
    assert!(
        fixture
            .service
            .get_materialization(created.workspace.workspace_id)
            .expect("edited planning content remains valid")
            .is_some()
    );

    let blocked = fixture
        .service
        .preflight_workspace_removal(created.workspace.workspace_id)
        .expect("planning removal preflight");
    assert!(!blocked.ready);
    assert!(
        blocked
            .blockers
            .iter()
            .any(|blocker| { blocker.code == RemovalBlockerCode::PlanningDocumentsPresent })
    );
    assert!(
        blocked
            .blockers
            .iter()
            .any(|blocker| blocker.code == RemovalBlockerCode::WorktreeChanges)
    );
    assert_eq!(blocked.protected_paths.len(), 1);
    assert_eq!(
        blocked.protected_paths[0].display_path,
        planning_home.to_string_lossy()
    );
    assert!(
        blocked.protected_paths[0]
            .entries
            .contains(&"FINDINGS.md".to_owned())
    );
    assert!(
        blocked.protected_paths[0]
            .file_previews
            .iter()
            .any(|preview| {
                preview.relative_path == "FINDINGS.md" && preview.contents.contains("PAY-2190")
            })
    );
    assert!(matches!(
        fixture.service.remove_workspace(
            created.workspace.workspace_id,
            &blocked.effect_digest,
            &Uuid::new_v4().to_string(),
            false,
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert!(planning_home.join("FINDINGS.md").is_file());
    fixture
        .service
        .remove_workspace(
            created.workspace.workspace_id,
            &blocked.effect_digest,
            &Uuid::new_v4().to_string(),
            true,
        )
        .expect("assert removal of reviewed planning documents");
    assert!(!workspace.exists());
    assert!(!worktree_path.exists());
}

#[test]
fn planning_document_api_lists_generated_files_and_writes_with_compare_and_swap() {
    let fixture = Fixture::new();
    let planning = WorkspacePlanningSelection {
        folder: WorkspacePlanningFolder::PlansAndKanban,
        format: WorkspacePlanningFormat::Kanban,
    };
    let created = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "planning-api".to_owned(),
                },
                title: "Planning API".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "checkout-api".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: Some(planning),
            },
        )
        .expect("planning workspace");
    let workspace_id = created.workspace.workspace_id;
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("planning preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize planning workspace");
    let planning_home = PathBuf::from(&materialized.materialization.workspace_display_path)
        .join("plans-and-kanban");
    fs::write(
        planning_home.join("PPEC-MH1-CREDENTIAL-CHECK-2026-08-31.md"),
        "# Credential check\n\nGenerated evidence.\n",
    )
    .expect("write generated Markdown fixture");
    fs::write(
        planning_home.join("mh1-credential-check-failures-2026-08-31.csv"),
        "host,status\nnode-1,failed\n",
    )
    .expect("write generated CSV fixture");
    fs::write(planning_home.join("ignored.json"), "{}\n").expect("write unsupported fixture");

    let list = fixture
        .service
        .list_workspace_planning_documents(workspace_id)
        .expect("list planning documents");
    assert_eq!(
        list.documents
            .iter()
            .map(|document| (document.document_id.clone(), document.file_name.as_str()))
            .collect::<Vec<_>>(),
        vec![
            (WorkspacePlanningDocumentId::Readme, "README.md"),
            (WorkspacePlanningDocumentId::Plan, "PLAN.md"),
            (WorkspacePlanningDocumentId::Findings, "FINDINGS.md"),
            (WorkspacePlanningDocumentId::Kanban, "KANBAN.md"),
            (
                WorkspacePlanningDocumentId::ProgramBacklog,
                "PROGRAM-BACKLOG.md",
            ),
            (
                list.documents[5].document_id.clone(),
                "mh1-credential-check-failures-2026-08-31.csv",
            ),
            (
                list.documents[6].document_id.clone(),
                "PPEC-MH1-CREDENTIAL-CHECK-2026-08-31.md",
            ),
        ]
    );
    assert!(matches!(
        &list.documents[5].document_id,
        WorkspacePlanningDocumentId::Generated(value)
            if value.starts_with("generated-") && value.len() == 74
    ));
    assert!(
        !list
            .documents
            .iter()
            .any(|document| document.file_name == "ignored.json")
    );
    let generated = fixture
        .service
        .read_workspace_planning_document(workspace_id, list.documents[6].document_id.clone())
        .expect("read generated planning file");
    assert_eq!(
        generated.file_name,
        "PPEC-MH1-CREDENTIAL-CHECK-2026-08-31.md"
    );
    assert!(generated.contents.contains("Generated evidence."));

    let original = fixture
        .service
        .read_workspace_planning_document(workspace_id, WorkspacePlanningDocumentId::Plan)
        .expect("read plan");
    assert!(original.contents.starts_with("# Plan:"));
    let updated = fixture
        .service
        .update_workspace_planning_document(
            workspace_id,
            WorkspacePlanningDocumentId::Plan,
            UpdateWorkspacePlanningDocumentRequest {
                expected_sha256: original.sha256.clone(),
                contents: "# Plan\n\nReviewed by the user.\n".to_owned(),
            },
        )
        .expect("update plan");
    assert_eq!(updated.contents, "# Plan\n\nReviewed by the user.\n");
    assert_ne!(updated.sha256, original.sha256);
    assert!(matches!(
        fixture.service.update_workspace_planning_document(
            workspace_id,
            WorkspacePlanningDocumentId::Plan,
            UpdateWorkspacePlanningDocumentRequest {
                expected_sha256: original.sha256,
                contents: "stale write".to_owned(),
            },
        ),
        Err(LocalWtsError::PlanningDocumentConflict)
    ));
    assert_eq!(
        fixture
            .service
            .read_workspace_planning_document(workspace_id, WorkspacePlanningDocumentId::Plan)
            .expect("read updated plan")
            .contents,
        updated.contents
    );

    fs::create_dir_all(planning_home.join("epics/payments")).expect("nested planning folder");
    fs::create_dir_all(planning_home.join("epics/refunds")).expect("second planning folder");
    fs::write(
        planning_home.join("epics/payments/PLAN.md"),
        "# Payment plan\n",
    )
    .expect("nested payment plan");
    fs::write(
        planning_home.join("epics/refunds/PLAN.md"),
        "# Refund plan\n",
    )
    .expect("nested refund plan");
    let nested = fixture
        .service
        .list_workspace_planning_documents(workspace_id)
        .expect("list nested planning documents");
    let payment = nested
        .documents
        .iter()
        .find(|document| document.file_name == "epics/payments/PLAN.md")
        .expect("the document list includes subdirectories");
    let refund = nested
        .documents
        .iter()
        .find(|document| document.file_name == "epics/refunds/PLAN.md")
        .expect("another document with the same basename");
    assert_ne!(payment.document_id, refund.document_id);
    assert_ne!(payment.document_id, WorkspacePlanningDocumentId::Plan);
    let payment = fixture
        .service
        .read_workspace_planning_document(workspace_id, payment.document_id.clone())
        .expect("read the nested payment plan");
    let revised = fixture
        .service
        .update_workspace_planning_document(
            workspace_id,
            payment.document_id.clone(),
            UpdateWorkspacePlanningDocumentRequest {
                expected_sha256: payment.sha256.clone(),
                contents: "# Revised payment plan\n".to_owned(),
            },
        )
        .expect("update the nested payment plan");
    assert_eq!(revised.file_name, "epics/payments/PLAN.md");
    assert_eq!(
        fs::read_to_string(planning_home.join("epics/payments/PLAN.md"))
            .expect("saved payment plan"),
        revised.contents
    );
    assert_eq!(
        fs::read_to_string(planning_home.join("epics/refunds/PLAN.md"))
            .expect("unchanged refund plan"),
        "# Refund plan\n"
    );
    assert!(matches!(
        fixture.service.update_workspace_planning_document(
            workspace_id,
            payment.document_id,
            UpdateWorkspacePlanningDocumentRequest {
                expected_sha256: payment.sha256,
                contents: "stale update".to_owned(),
            }
        ),
        Err(LocalWtsError::PlanningDocumentConflict)
    ));

    fs::write(planning_home.join("KANBAN.md"), [0xff, 0xfe]).expect("write invalid UTF-8 fixture");
    assert!(matches!(
        fixture
            .service
            .read_workspace_planning_document(workspace_id, WorkspacePlanningDocumentId::Kanban,),
        Err(LocalWtsError::InvalidPlanningDocument)
    ));

    fs::write(
        planning_home.join("PROGRAM-BACKLOG.md"),
        vec![b'x'; MAX_PLANNING_DOCUMENT_BYTES + 1],
    )
    .expect("write oversized fixture");
    assert!(matches!(
        fixture.service.read_workspace_planning_document(
            workspace_id,
            WorkspacePlanningDocumentId::ProgramBacklog,
        ),
        Err(LocalWtsError::PlanningDocumentTooLarge)
    ));
}

#[cfg(unix)]
#[test]
fn planning_document_api_rejects_symbolic_links_and_path_like_identifiers() {
    use std::os::unix::fs::symlink;

    assert!(
        serde_json::from_str::<WorkspacePlanningDocumentId>("\"../PLAN.md\"").is_err(),
        "the transport contract must not accept a caller-supplied path"
    );

    let fixture = Fixture::new();
    let planning = WorkspacePlanningSelection {
        folder: WorkspacePlanningFolder::Plans,
        format: WorkspacePlanningFormat::Notes,
    };
    let created = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "planning-symlink".to_owned(),
                },
                title: "Planning symlink".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "checkout-api".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: Some(planning),
            },
        )
        .expect("planning workspace");
    let workspace_id = created.workspace.workspace_id;
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("planning preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest)
        .expect("materialize planning workspace");
    let planning_home =
        PathBuf::from(materialized.materialization.workspace_display_path).join("plans");
    let outside = fixture.repository_root.join("outside-plan.md");
    fs::write(&outside, "outside\n").expect("outside file");
    fs::remove_file(planning_home.join("FINDINGS.md")).expect("remove fixed document");
    symlink(&outside, planning_home.join("FINDINGS.md")).expect("symlink fixture");
    symlink(&outside, planning_home.join("generated-evidence.md"))
        .expect("generated symlink fixture");

    assert!(matches!(
        fixture
            .service
            .read_workspace_planning_document(workspace_id, WorkspacePlanningDocumentId::Findings,),
        Err(LocalWtsError::InvalidPlanningDocument)
    ));
    assert!(
        !fixture
            .service
            .list_workspace_planning_documents(workspace_id)
            .expect("list planning documents")
            .documents
            .iter()
            .any(|document| document.file_name == "generated-evidence.md")
    );
    assert!(matches!(
        fixture.service.read_workspace_planning_document(
            workspace_id,
            WorkspacePlanningDocumentId::Generated(format!("generated-{}", "a".repeat(64))),
        ),
        Err(LocalWtsError::PlanningDocumentUnavailable)
    ));
}

#[test]
fn manual_removal_blocks_file_changes_ignored_files_and_unknown_root_entries() {
    let fixture = Fixture::new();
    fs::write(fixture.api.join(".gitignore"), "*.cache\n").expect("ignore rule");
    git(Some(&fixture.api), ["add", ".gitignore"]);
    git(Some(&fixture.api), ["commit", "-m", "add ignore rule"]);
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let create_preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("create preflight");
    let materialized = fixture
        .service
        .materialize_workspace(workspace_id, &create_preflight.effect_digest)
        .expect("materialize");
    let workspace_path = PathBuf::from(&materialized.materialization.workspace_display_path);
    let target = PathBuf::from(&materialized.materialization.worktrees[0].target_display_path);
    fs::write(target.join("notes.txt"), "unsaved\n").expect("untracked file");
    fs::write(target.join("build.cache"), "ignored\n").expect("ignored file");
    fs::write(workspace_path.join("manual-note.txt"), "preserve me\n").expect("unknown root entry");

    let preflight = fixture
        .service
        .preflight_workspace_removal(workspace_id)
        .expect("blocked removal preflight");
    assert!(!preflight.ready);
    assert!(
        preflight
            .blockers
            .iter()
            .any(|blocker| blocker.code == RemovalBlockerCode::WorktreeChanges)
    );
    assert!(
        preflight
            .blockers
            .iter()
            .any(|blocker| blocker.code == RemovalBlockerCode::IgnoredFiles)
    );
    assert!(
        preflight
            .blockers
            .iter()
            .any(|blocker| blocker.code == RemovalBlockerCode::UnexpectedPath)
    );
    assert!(matches!(
        fixture.service.remove_workspace(
            workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            true,
        ),
        Err(LocalWtsError::RemovalBlocked { .. })
    ));
    assert!(target.is_dir());
    assert!(workspace_path.join("manual-note.txt").is_file());
}

#[test]
fn reads_one_test_run_with_deep_artifact_integrity_validation() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let store = TestArtifactStore::open(&workspace_path).expect("test artifact store");
    let (run_id, artifact_path) = write_screenshot_test_run(&store, workspace_id, b"good");

    let detail = fixture
        .service
        .get_workspace_test_run(workspace_id, run_id)
        .expect("deep-validated test run");
    assert_eq!(detail.run_id, run_id);
    assert_eq!(detail.workspace_id, workspace_id);
    assert_eq!(detail.artifacts.len(), 1);

    fs::write(&artifact_path, b"evil").expect("same-size artifact tamper");
    let summaries = fixture
        .service
        .list_workspace_test_runs(workspace_id)
        .expect("shallow test-run list");
    assert_eq!(summaries.runs.len(), 1);
    assert!(matches!(
        fixture.service.get_workspace_test_run(workspace_id, run_id),
        Err(LocalWtsError::InvalidTestEvidence)
    ));
}

#[test]
fn rejects_test_run_evidence_bound_to_another_workspace() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let workspace_path = materialize_test_workspace(&fixture, workspace_id);
    let store = TestArtifactStore::open(&workspace_path).expect("test artifact store");
    let other_workspace_id = Uuid::new_v4();
    let (run_id, _) = write_screenshot_test_run(&store, other_workspace_id, b"good");

    assert!(matches!(
        fixture.service.get_workspace_test_run(workspace_id, run_id),
        Err(LocalWtsError::InvalidTestEvidence)
    ));
    assert!(matches!(
        fixture
            .service
            .get_workspace_test_run(workspace_id, Uuid::new_v4()),
        Err(LocalWtsError::TestRunNotFound)
    ));
}

#[test]
fn reads_a_bounded_diff_only_for_a_repository_in_the_workspace() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    materialize_test_workspace(&fixture, workspace_id);
    let materialization = fixture
        .service
        .get_materialization(workspace_id)
        .expect("materialization read")
        .expect("materialized workspace");
    let worktree = &materialization.worktrees[0];
    let worktree_path = PathBuf::from(&worktree.target_display_path);
    fs::write(worktree_path.join("README.md"), "changed\n").expect("tracked change");
    fs::write(worktree_path.join("notes.txt"), "untracked\n").expect("untracked change");

    let diff = fixture
        .service
        .workspace_repository_diff(workspace_id, &worktree.repository_id)
        .expect("workspace repository diff");

    assert_eq!(diff.workspace_id, workspace_id);
    assert_eq!(diff.repository_id, worktree.repository_id);
    assert!(diff.patch.contains("diff --git a/README.md b/README.md"));
    assert_eq!(diff.untracked_paths, ["notes.txt"]);
    assert!(matches!(
        fixture
            .service
            .workspace_repository_diff(workspace_id, "repo-outside-workspace"),
        Err(LocalWtsError::RepositoryNotFound)
    ));
}

fn materialize_test_workspace(fixture: &Fixture, workspace_id: Uuid) -> PathBuf {
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("test workspace preflight");
    PathBuf::from(
        fixture
            .service
            .materialize_workspace(workspace_id, &preflight.effect_digest)
            .expect("materialize test workspace")
            .materialization
            .workspace_display_path,
    )
}

#[test]
fn materialization_preflight_preserves_an_existing_workspace_guide() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let initial = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("initial preflight");
    let workspace = PathBuf::from(&initial.workspace_display_path);
    fs::create_dir(&workspace).expect("existing workspace directory");
    let guide = b"# User guide\n\nKeep these existing instructions.\n";
    fs::write(workspace.join("WTS.md"), guide).expect("existing user guide");
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("preflight with existing guide");
    assert!(
        !preflight.ready,
        "an existing guide must block setup before Git writes"
    );
    assert!(preflight.blockers.iter().any(|blocker| {
        blocker.code == PreflightBlockerCode::TargetConflict
            && blocker
                .message
                .contains(workspace.join("WTS.md").to_str().unwrap())
    }));

    assert!(matches!(
        fixture
            .service
            .materialize_workspace(workspace_id, &initial.effect_digest),
        Err(LocalWtsError::PreflightBlocked { .. })
    ));

    assert_eq!(
        fs::read(workspace.join("WTS.md")).expect("existing guide must survive rollback"),
        guide
    );
    assert_eq!(directory_entry_names(&workspace), ["WTS.md"]);
    assert!(!has_branch(&fixture.api, &preflight.branch_name));
    assert_eq!(branch(&fixture.api), "main");
    assert!(git_output(Some(&fixture.api), ["status", "--porcelain"]).is_empty());
}

#[test]
fn materialization_preflight_checks_generated_destinations_and_allows_existing_directories() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let initial = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("initial preflight");
    let workspace = PathBuf::from(&initial.workspace_display_path);
    fs::create_dir(&workspace).expect("existing workspace directory");
    let parent_directories = [".github", ".wts", ".wts/agent-runs", ".wts/logs"];
    for relative in parent_directories {
        let path = workspace.join(relative);
        fs::write(&path, b"Keep the conflicting file.\n").expect("parent type conflict");
        let blocked = fixture
            .service
            .preflight_workspace(workspace_id)
            .expect("directory preflight");
        assert!(!blocked.ready, "{relative}");
        assert!(
            blocked.blockers.iter().any(|blocker| {
                blocker.code == PreflightBlockerCode::TargetConflict
                    && blocker.message.contains(path.to_str().unwrap())
            }),
            "{relative}: {:?}",
            blocked.blockers
        );
        assert_eq!(fs::read(&path).unwrap(), b"Keep the conflicting file.\n");
        fs::remove_file(&path).expect("resolve fixture parent conflict");
        fs::create_dir(&path).expect("existing parent directory");
    }
    let code_workspace = PathBuf::from(&initial.code_workspace_display_path);
    let destinations = [
        "WTS.md",
        "AGENTS.md",
        "CLAUDE.md",
        ".cursorrules",
        ".wts-workspace.json",
        ".github/copilot-instructions.md",
        ".wts/context.json",
        ".wts/graph-manifest.json",
        ".wts/verification-plan.json",
        ".wts/verification-result.json",
        ".wts/verification-history.json",
        ".wts/agent-report.json",
        ".wts/review-inbox.json",
    ]
    .map(|relative| workspace.join(relative));
    for path in destinations.into_iter().chain([code_workspace]) {
        fs::write(&path, b"Keep the existing contents.\n").expect("generated destination conflict");
        let blocked = fixture
            .service
            .preflight_workspace(workspace_id)
            .expect("file preflight");
        assert!(!blocked.ready, "{}", path.display());
        assert!(
            blocked.blockers.iter().any(|blocker| {
                blocker.code == PreflightBlockerCode::TargetConflict
                    && blocker.message.contains(path.to_str().unwrap())
            }),
            "{}: {:?}",
            path.display(),
            blocked.blockers
        );
        assert_eq!(fs::read(&path).unwrap(), b"Keep the existing contents.\n");
        fs::remove_file(&path).expect("resolve fixture file conflict");
    }
    let ready = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("resolved preflight");
    assert!(ready.ready, "{:?}", ready.blockers);
    assert!(!has_branch(&fixture.api, &ready.branch_name));
    let created = fixture
        .service
        .materialize_workspace(workspace_id, &ready.effect_digest)
        .expect("setup accepts existing regular parent directories");
    assert!(!created.replayed);
    assert!(workspace.join(".wts/review-inbox.json").is_file());
    assert_eq!(branch(&fixture.api), "main");
}

#[cfg(unix)]
#[test]
fn materialization_preflight_blocks_linked_generated_parent_directories() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let initial = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("initial preflight");
    let workspace = PathBuf::from(&initial.workspace_display_path);
    fs::create_dir(&workspace).expect("workspace directory");
    let outside = fixture._directory.path().join("outside-generated-parent");
    fs::create_dir(&outside).expect("outside directory");
    fs::write(outside.join("user.txt"), b"Keep outside contents.\n").expect("outside contents");
    for relative in [".github", ".wts"] {
        let path = workspace.join(relative);
        symlink(&outside, &path).expect("linked parent directory");
        let blocked = fixture
            .service
            .preflight_workspace(workspace_id)
            .expect("linked parent preflight");
        assert!(!blocked.ready, "{relative}");
        assert!(
            blocked.blockers.iter().any(|blocker| {
                blocker.code == PreflightBlockerCode::TargetConflict
                    && blocker.message.contains(path.to_str().unwrap())
            }),
            "{relative}: {:?}",
            blocked.blockers
        );
        assert!(matches!(
            fixture
                .service
                .materialize_workspace(workspace_id, &initial.effect_digest),
            Err(LocalWtsError::PreflightBlocked { .. })
        ));
        assert!(path.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(
            fs::read(outside.join("user.txt")).unwrap(),
            b"Keep outside contents.\n"
        );
        assert_eq!(directory_entry_names(&outside), ["user.txt"]);
        assert!(!has_branch(&fixture.api, &initial.branch_name));
        fs::remove_file(&path).expect("remove fixture symlink");
    }
}

#[cfg(unix)]
#[test]
fn materialization_rollback_preserves_a_plan_created_during_checkout() {
    let fixture = Fixture::new();
    let workspace_id = fixture
        .service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "rollback-plans".to_owned(),
                },
                title: "Preserve external planning files".to_owned(),
                preferred_provider: WorkspaceProvider::Codex,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "checkout-api".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: Some(WorkspacePlanningSelection {
                    folder: WorkspacePlanningFolder::Plans,
                    format: WorkspacePlanningFormat::Notes,
                }),
            },
        )
        .expect("planning workspace")
        .workspace
        .workspace_id;
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("planning preflight");
    assert!(preflight.ready, "{:?}", preflight.blockers);
    install_materialization_checkout_hook(
        &fixture.api,
        "mkdir -p ../plans\nprintf '%s\\n' '# External plan' 'Keep these user notes.' > ../plans/PLAN.md\n",
    );
    let workspace = PathBuf::from(&preflight.workspace_display_path);

    assert!(
        fixture
            .service
            .materialize_workspace(workspace_id, &preflight.effect_digest)
            .is_err()
    );

    assert_eq!(
        fs::read_to_string(workspace.join("plans/PLAN.md"))
            .expect("external plan must survive rollback"),
        "# External plan\nKeep these user notes.\n"
    );
    assert_eq!(directory_entry_names(&workspace), ["plans"]);
    assert_eq!(directory_entry_names(&workspace.join("plans")), ["PLAN.md"]);
    assert!(!has_branch(&fixture.api, &preflight.branch_name));
    assert_eq!(branch(&fixture.api), "main");
}

#[cfg(unix)]
#[test]
fn materialization_rollback_cleans_partial_evidence_and_allows_a_safe_retry() {
    let fixture = Fixture::new();
    let workspace_id = fixture.create_plan(&["checkout-api"]);
    let preflight = fixture
        .service
        .preflight_workspace(workspace_id)
        .expect("initial preflight");
    assert!(preflight.ready, "{:?}", preflight.blockers);
    let hook = install_materialization_checkout_hook(
        &fixture.api,
        "mkdir -p ../.wts/verification-plan.json\n",
    );
    let workspace = PathBuf::from(&preflight.workspace_display_path);

    let result = fixture
        .service
        .materialize_workspace(workspace_id, &preflight.effect_digest);
    assert!(
        matches!(
            result,
            Err(LocalWtsError::GeneratedFileFailed {
                cleanup_complete: false
            })
        ),
        "{result:?}"
    );
    assert!(workspace.join(".wts/verification-plan.json").is_dir());
    assert_eq!(directory_entry_names(&workspace), [".wts"]);
    assert_eq!(
        directory_entry_names(&workspace.join(".wts")),
        ["verification-plan.json"]
    );
    assert!(!has_branch(&fixture.api, &preflight.branch_name));
    assert!(
        fixture
            .service
            .get_materialization(workspace_id)
            .unwrap()
            .is_none()
    );

    fs::remove_file(hook).expect("disable fixture hook");
    fs::remove_dir(workspace.join(".wts/verification-plan.json"))
        .expect("user removes the external blocker");
    let reopened = fixture.reopen(RecordingLauncher::default());
    let retry = reopened
        .preflight_workspace(workspace_id)
        .expect("fresh retry preflight");
    let recovery = retry
        .setup_recovery
        .expect("the failed attempt needs explicit cleanup review");
    assert!(recovery.ready, "{:?}", recovery.blockers);
    let retry = reopened
        .recover_workspace_setup(workspace_id, &recovery.effect_digest)
        .expect("clean reviewed setup files");
    assert!(retry.ready, "{:?}", retry.blockers);
    let created = reopened
        .materialize_workspace(workspace_id, &retry.effect_digest)
        .expect("retry after removing the external blocker");
    assert!(!created.replayed);
    assert_eq!(created.materialization.worktrees.len(), 1);
    assert!(workspace.join(".wts/verification-plan.json").is_file());
    assert!(workspace.join(".wts/review-inbox.json").is_file());
    assert_eq!(branch(&fixture.api), "main");
    assert!(git_output(Some(&fixture.api), ["status", "--porcelain"]).is_empty());
}

fn directory_entry_names(path: &Path) -> Vec<String> {
    let mut entries = fs::read_dir(path)
        .expect("read directory")
        .map(|entry| {
            entry
                .expect("directory entry")
                .file_name()
                .into_string()
                .expect("fixture path")
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

#[cfg(unix)]
fn install_materialization_checkout_hook(repository: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;

    let hook = repository.join(".git/hooks/post-checkout");
    fs::write(&hook, format!("#!/bin/sh\nset -eu\n{body}")).expect("write fixture checkout hook");
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o700))
        .expect("fixture checkout hook permissions");
    hook
}

fn write_screenshot_test_run(
    store: &TestArtifactStore,
    recorded_workspace_id: Uuid,
    artifact_bytes: &[u8],
) -> (Uuid, PathBuf) {
    let run_id = Uuid::new_v4();
    let plan = JourneyPlan::new(
        run_id,
        recorded_workspace_id,
        "integrity-check",
        "Integrity check",
        "http://127.0.0.1:41000",
        1_000,
        vec![
            JourneyStep::new("capture", "Capture", 1_000, JourneyAction::Screenshot)
                .expect("screenshot step"),
        ],
    )
    .expect("test journey plan");
    let manifest = store.begin(&plan).expect("begin test run");
    let run_directory = store
        .run_directory(run_id)
        .expect("read run directory")
        .expect("run directory exists");
    let artifact_path = run_directory.join("evidence.png");
    fs::write(&artifact_path, artifact_bytes).expect("write test artifact");
    let completed_at_unix_ms = manifest.summary.started_at_unix_ms + 1;
    let artifact_id = "artifact-000".to_owned();
    let result = TestRunResult {
        schema_version: TEST_RUN_SCHEMA_VERSION,
        run_id,
        workspace_id: recorded_workspace_id,
        journey_id: plan.journey_id,
        state: TestRunState::Passed,
        started_at_unix_ms: manifest.summary.started_at_unix_ms,
        completed_at_unix_ms,
        duration_ms: 1,
        steps: vec![TestStepResult {
            step_id: "capture".to_owned(),
            label: "Capture".to_owned(),
            kind: "screenshot".to_owned(),
            state: TestStepState::Passed,
            started_at_unix_ms: manifest.summary.started_at_unix_ms,
            completed_at_unix_ms,
            duration_ms: 1,
            snapshot_artifact_id: None,
            screenshot_artifact_id: Some(artifact_id.clone()),
            error: None,
        }],
        console_errors: Vec::new(),
        requests: Vec::new(),
        artifacts: vec![ArtifactMetadata {
            artifact_id,
            kind: ArtifactKind::Screenshot,
            relative_path: "evidence.png".to_owned(),
            display_path: artifact_path
                .to_str()
                .expect("UTF-8 artifact path")
                .to_owned(),
            bytes: artifact_bytes.len() as u64,
            sha256: hex::encode(Sha256::digest(artifact_bytes)),
        }],
        failure: None,
        graph_sha256: None,
    };
    store.finalize(&result).expect("finalize test run");
    (run_id, artifact_path)
}

fn create_repository(parent: &Path, name: &str) -> PathBuf {
    let root = parent.join(name);
    fs::create_dir(&root).expect("repository directory");
    git(None, ["init", root.to_str().expect("UTF-8 path")]);
    git(Some(&root), ["config", "user.name", "WTS Test"]);
    git(Some(&root), ["config", "user.email", "wts@example.invalid"]);
    git(Some(&root), ["config", "commit.gpgSign", "false"]);
    fs::write(root.join("README.md"), format!("# {name}\n")).expect("fixture file");
    git(Some(&root), ["add", "README.md"]);
    git(Some(&root), ["commit", "-m", "initial"]);
    git(Some(&root), ["branch", "-M", "main"]);
    root
}

fn configure_local_origin(fixture: &Fixture, source: &Path) -> PathBuf {
    let remote_parent = fixture._directory.path().join("origins");
    fs::create_dir(&remote_parent).expect("origin parent");
    let remote = remote_parent.join(format!(
        "{}.git",
        source.file_name().unwrap().to_string_lossy()
    ));
    let upstream = fixture._directory.path().join(format!(
        "{}-upstream",
        source.file_name().unwrap().to_string_lossy()
    ));
    git(
        None,
        ["init", "--bare", remote.to_str().expect("remote path")],
    );
    git(
        Some(source),
        [
            "remote",
            "add",
            "origin",
            remote.to_str().expect("remote path"),
        ],
    );
    git(Some(source), ["push", "-u", "origin", "main"]);
    git(
        None,
        [
            "clone",
            "--branch",
            "main",
            remote.to_str().expect("remote path"),
            upstream.to_str().expect("upstream path"),
        ],
    );
    git(Some(&upstream), ["config", "user.name", "WTS Test"]);
    git(
        Some(&upstream),
        ["config", "user.email", "wts@example.invalid"],
    );
    git(Some(&upstream), ["config", "commit.gpgSign", "false"]);
    upstream
}

fn branch(repository: &Path) -> String {
    let output = Command::new("git")
        .args(["-C"])
        .arg(repository)
        .args(["branch", "--show-current"])
        .env("LC_ALL", "C")
        .output()
        .expect("git branch");
    assert!(output.status.success());
    String::from_utf8(output.stdout)
        .expect("UTF-8 branch")
        .trim()
        .to_owned()
}

fn has_branch(repository: &Path, branch: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["show-ref", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}"))
        .env("LC_ALL", "C")
        .status()
        .expect("git branch lookup")
        .success()
}

fn git<const N: usize>(repository: Option<&Path>, args: [&str; N]) {
    let mut command = Command::new("git");
    if let Some(repository) = repository {
        command.arg("-C").arg(repository);
    }
    let status = command
        .args(args)
        .env("LC_ALL", "C")
        .status()
        .expect("git command");
    assert!(status.success());
}

fn git_output<const N: usize>(repository: Option<&Path>, args: [&str; N]) -> String {
    let mut command = Command::new("git");
    if let Some(repository) = repository {
        command.arg("-C").arg(repository);
    }
    let output = command
        .args(args)
        .env("LC_ALL", "C")
        .output()
        .expect("git command");
    assert!(output.status.success());
    String::from_utf8(output.stdout).expect("UTF-8 git output")
}
