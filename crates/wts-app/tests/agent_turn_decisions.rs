#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationSource, AgentProvider, AgentTurnChecksState,
    AgentTurnDecisionKind, AgentTurnDecisionsState, CreateAgentConversationRequest,
    LocalWtsService, ProcessExternalLauncher, ProcessWorkspaceAdapter,
    RecordAgentTurnDecisionRequest, SendAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
fn decision_history_binds_the_saved_result_and_replay_preserves_source() {
    let fixture = Fixture::new(false);
    let turn = fixture.run();
    let id = fixture.conversation.conversation_id;
    let index_path =
        PathBuf::from(git(&fixture.target, &["rev-parse", "--git-path", "index"]).trim());
    let index = fs::read(&index_path).unwrap();
    let source = fs::read(fixture.target.join("tracked.txt")).unwrap();
    let head = git(&fixture.target, &["rev-parse", "HEAD"]);
    let initial = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    assert_eq!(initial.state, AgentTurnDecisionsState::Ready);
    assert_eq!(initial.revision, 0);
    assert!(initial.decisions.is_empty());
    let request = RecordAgentTurnDecisionRequest {
        request_id: Uuid::new_v4(),
        expected_revision: 0,
        expected_receipt_digest: initial.receipt_digest.clone(),
        kind: AgentTurnDecisionKind::Accepted,
        reason: "The saved diff addresses this request.".to_owned(),
    };
    let saved = fixture
        .service
        .record_agent_turn_decision(id, turn, request.clone())
        .unwrap();
    assert_eq!(saved.revision, 1);
    assert_eq!(saved.decisions[0].decision_id, request.request_id);
    assert_eq!(
        saved.decisions[0].source_context_sha256,
        initial.source_context_sha256
    );
    assert_eq!(
        Some(saved.decisions[0].after_checkpoint_id),
        initial.after_checkpoint_id
    );
    assert!(saved.decisions[0].checks.is_empty());
    assert_eq!(
        saved.decisions[0].checks_state,
        AgentTurnChecksState::NoChecks
    );
    let reopened = fixture.open();
    assert_eq!(reopened.get_agent_turn_decisions(id, turn).unwrap(), saved);
    assert_eq!(
        reopened
            .record_agent_turn_decision(id, turn, request.clone())
            .unwrap(),
        saved
    );
    let mut changed_replay = request.clone();
    changed_replay.reason = "A changed replay must not replace the saved reason.".to_owned();
    assert!(matches!(
        reopened.record_agent_turn_decision(id, turn, changed_replay),
        Err(wts_app::LocalWtsError::AgentConversationConflict)
    ));
    let second = reopened
        .record_agent_turn_decision(
            id,
            turn,
            RecordAgentTurnDecisionRequest {
                request_id: Uuid::new_v4(),
                expected_revision: 1,
                expected_receipt_digest: initial.receipt_digest.clone(),
                kind: AgentTurnDecisionKind::Kept,
                reason: "Keep this result for comparison.".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(second.decisions.len(), 2);
    assert_eq!(second.decisions[0], saved.decisions[0]);
    assert_eq!(second.decisions[1].kind, AgentTurnDecisionKind::Kept);
    assert_eq!(
        reopened
            .record_agent_turn_decision(id, turn, request)
            .unwrap(),
        second
    );
    assert_eq!(fs::read(&index_path).unwrap(), index);
    assert_eq!(
        fs::read(fixture.target.join("tracked.txt")).unwrap(),
        source
    );
    assert_eq!(git(&fixture.target, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        fs::read_to_string(fixture.target.join("draft.txt")).unwrap(),
        "unrelated private draft\n"
    );
    assert!(
        reopened
            .get_agent_turn_decisions(id, Uuid::new_v4())
            .is_err()
    );
}

#[test]
fn concurrent_decisions_use_revision_checks_and_stale_source_keeps_its_identity() {
    let fixture = Fixture::new(false);
    let turn = fixture.run();
    let id = fixture.conversation.conversation_id;
    let initial = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers = [fixture.service.clone(), fixture.open()]
        .into_iter()
        .map(|service| {
            let barrier = barrier.clone();
            let digest = initial.receipt_digest.clone();
            thread::spawn(move || {
                barrier.wait();
                service.record_agent_turn_decision(
                    id,
                    turn,
                    RecordAgentTurnDecisionRequest {
                        request_id: Uuid::new_v4(),
                        expected_revision: 0,
                        expected_receipt_digest: digest,
                        kind: AgentTurnDecisionKind::Rejected,
                        reason: "This option needs more work.".to_owned(),
                    },
                )
            })
        })
        .collect::<Vec<_>>();
    let results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(
                result,
                Err(wts_app::LocalWtsError::AgentConversationConflict)
            ))
            .count(),
        1
    );
    fs::write(fixture.target.join("tracked.txt"), "later editor content\n").unwrap();
    let current = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    assert_eq!(current.receipt_digest, initial.receipt_digest);
    assert_eq!(current.checks_state, AgentTurnChecksState::Stale);
    let mut request = RecordAgentTurnDecisionRequest {
        request_id: Uuid::new_v4(),
        expected_revision: 1,
        expected_receipt_digest: format!("sha256:{}", "0".repeat(64)),
        kind: AgentTurnDecisionKind::Kept,
        reason: "Historical comparison.".to_owned(),
    };
    assert!(matches!(
        fixture
            .service
            .record_agent_turn_decision(id, turn, request.clone()),
        Err(wts_app::LocalWtsError::AgentConversationConflict)
    ));
    request.expected_receipt_digest = initial.receipt_digest;
    let saved = fixture
        .service
        .record_agent_turn_decision(id, turn, request)
        .unwrap();
    assert_eq!(saved.decisions[1].checks_state, AgentTurnChecksState::Stale);
    assert_eq!(
        saved.decisions[1].after_checkpoint_id,
        initial.after_checkpoint_id.unwrap()
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "later editor content\n"
    );
}

#[test]
fn decision_store_rejects_cross_result_records_and_does_not_follow_links() {
    let fixture = Fixture::new(false);
    let turn = fixture.run();
    let id = fixture.conversation.conversation_id;
    let initial = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    let request = RecordAgentTurnDecisionRequest {
        request_id: Uuid::new_v4(),
        expected_revision: 0,
        expected_receipt_digest: initial.receipt_digest,
        kind: AgentTurnDecisionKind::Accepted,
        reason: String::new(),
    };
    fixture
        .service
        .record_agent_turn_decision(id, turn, request.clone())
        .unwrap();
    let path = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/turn-decisions")
        .join(format!("{}.json", initial.session_id));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let original = fs::read(&path).unwrap();
    let mut forged: serde_json::Value = serde_json::from_slice(&original).unwrap();
    forged["turnRequestId"] = serde_json::json!(Uuid::new_v4());
    fs::write(&path, serde_json::to_vec(&forged).unwrap()).unwrap();
    assert!(fixture.service.get_agent_turn_decisions(id, turn).is_err());
    let outside = fixture.directory.path().join("outside.json");
    fs::write(&outside, &original).unwrap();
    fs::remove_file(&path).unwrap();
    symlink(&outside, &path).unwrap();
    assert!(fixture.service.get_agent_turn_decisions(id, turn).is_err());
    assert!(
        fixture
            .service
            .record_agent_turn_decision(id, turn, request)
            .is_err()
    );
    assert_eq!(fs::read(&outside).unwrap(), original);
}

#[test]
fn decision_request_limits_reject_invalid_input_without_an_append() {
    let fixture = Fixture::new(false);
    let turn = fixture.run();
    let id = fixture.conversation.conversation_id;
    let initial = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    for reason in ["x".repeat(4_097), "invalid\0reason".to_owned()] {
        assert!(
            fixture
                .service
                .record_agent_turn_decision(
                    id,
                    turn,
                    RecordAgentTurnDecisionRequest {
                        request_id: Uuid::new_v4(),
                        expected_revision: 0,
                        expected_receipt_digest: initial.receipt_digest.clone(),
                        kind: AgentTurnDecisionKind::Accepted,
                        reason,
                    }
                )
                .is_err()
        );
    }
    assert_eq!(
        fixture
            .service
            .get_agent_turn_decisions(id, turn)
            .unwrap()
            .revision,
        0
    );
    let forged = serde_json::json!({"requestId": Uuid::new_v4(), "expectedRevision":0,
        "expectedReceiptDigest": initial.receipt_digest, "kind":"accepted", "reason":"", "sourcePath":"/tmp/another-repository"});
    assert!(serde_json::from_value::<RecordAgentTurnDecisionRequest>(forged).is_err());
    let capture = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/turn-changes")
        .join(initial.session_id.to_string())
        .join("receipt.json");
    let mut stored: serde_json::Value =
        serde_json::from_slice(&fs::read(&capture).unwrap()).unwrap();
    stored["receipt"]["state"] = serde_json::json!("unavailable");
    stored["receipt"].as_object_mut().unwrap().remove("after");
    fs::write(&capture, serde_json::to_vec(&stored).unwrap()).unwrap();
    let unavailable = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    assert_eq!(unavailable.state, AgentTurnDecisionsState::Unavailable);
    assert!(
        fixture
            .service
            .record_agent_turn_decision(
                id,
                turn,
                RecordAgentTurnDecisionRequest {
                    request_id: Uuid::new_v4(),
                    expected_revision: 0,
                    expected_receipt_digest: unavailable.receipt_digest,
                    kind: AgentTurnDecisionKind::Accepted,
                    reason: String::new(),
                }
            )
            .is_err()
    );
}

#[test]
fn malformed_saved_decision_evidence_is_rejected_at_the_storage_boundary() {
    let fixture = Fixture::new(false);
    let turn = fixture.run();
    let id = fixture.conversation.conversation_id;
    let initial = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    fixture
        .service
        .record_agent_turn_decision(
            id,
            turn,
            RecordAgentTurnDecisionRequest {
                request_id: Uuid::new_v4(),
                expected_revision: 0,
                expected_receipt_digest: initial.receipt_digest,
                kind: AgentTurnDecisionKind::Kept,
                reason: "Use this result for comparison.".to_owned(),
            },
        )
        .unwrap();
    let path = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/turn-decisions")
        .join(format!("{}.json", initial.session_id));
    let valid: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let run_id = Uuid::new_v4();
    for (field, value) in [
        ("createdAtUnixMs", serde_json::json!(-1)),
        (
            "createdAtUnixMs",
            serde_json::json!(8_640_000_000_000_001_u64),
        ),
        (
            "checks",
            serde_json::json!([{"runId":run_id,"checkId":"../outside","status":"passed"}]),
        ),
        (
            "checks",
            serde_json::json!([{"runId":run_id,"checkId":"unit","status":"passed"},{"runId":run_id,"checkId":"unit","status":"passed"}]),
        ),
    ] {
        let mut stored = valid.clone();
        stored["records"][0]["decision"][field] = value;
        let bytes = serde_json::to_vec(&stored).unwrap();
        fs::write(&path, &bytes).unwrap();
        assert!(
            fixture.service.get_agent_turn_decisions(id, turn).is_err(),
            "The host must reject malformed {field}."
        );
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }
}

#[test]
fn the_last_decision_fills_the_ledger_without_losing_history_or_exact_replay() {
    let fixture = Fixture::new(false);
    let turn = fixture.run();
    let id = fixture.conversation.conversation_id;
    let initial = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    fixture
        .service
        .record_agent_turn_decision(
            id,
            turn,
            RecordAgentTurnDecisionRequest {
                request_id: Uuid::new_v4(),
                expected_revision: 0,
                expected_receipt_digest: initial.receipt_digest.clone(),
                kind: AgentTurnDecisionKind::Kept,
                reason: String::new(),
            },
        )
        .unwrap();
    let path = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/turn-decisions")
        .join(format!("{}.json", initial.session_id));
    let mut stored: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let template = stored["records"][0].clone();
    stored["records"] = serde_json::Value::Array(
        (0..63)
            .map(|index| {
                let mut row = template.clone();
                let mutation_id = Uuid::new_v4();
                row["request"]["requestId"] = serde_json::json!(mutation_id);
                row["request"]["expectedRevision"] = serde_json::json!(index);
                row["decision"]["decisionId"] = serde_json::json!(mutation_id);
                row["decision"]["revision"] = serde_json::json!(index + 1);
                row
            })
            .collect(),
    );
    fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    let before = fixture.service.get_agent_turn_decisions(id, turn).unwrap();
    assert_eq!(before.revision, 63);
    assert_eq!(before.state, AgentTurnDecisionsState::Ready);
    let request = RecordAgentTurnDecisionRequest {
        request_id: Uuid::new_v4(),
        expected_revision: 63,
        expected_receipt_digest: initial.receipt_digest.clone(),
        kind: AgentTurnDecisionKind::Accepted,
        reason: "The final review choice.".to_owned(),
    };
    let full = fixture
        .service
        .record_agent_turn_decision(id, turn, request.clone())
        .unwrap();
    assert_eq!(full.state, AgentTurnDecisionsState::Unavailable);
    assert_eq!(full.revision, 64);
    assert_eq!(&full.decisions[..63], before.decisions.as_slice());
    assert_eq!(full.decisions[63].kind, AgentTurnDecisionKind::Accepted);
    let reopened = fixture.open();
    assert_eq!(
        reopened
            .record_agent_turn_decision(id, turn, request)
            .unwrap(),
        full
    );
    let bytes = fs::read(&path).unwrap();
    assert!(
        reopened
            .record_agent_turn_decision(
                id,
                turn,
                RecordAgentTurnDecisionRequest {
                    request_id: Uuid::new_v4(),
                    expected_revision: 64,
                    expected_receipt_digest: initial.receipt_digest,
                    kind: AgentTurnDecisionKind::Rejected,
                    reason: String::new(),
                }
            )
            .is_err()
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

struct Fixture {
    directory: TempDir,
    service: LocalWtsService,
    conversation: AgentConversation,
    target: PathBuf,
    executable: PathBuf,
    repositories: PathBuf,
}
impl Fixture {
    fn new(failed: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let source = repositories.join("api");
        fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "-b", "main"]);
        git(&source, &["config", "user.name", "Fixture"]);
        git(&source, &["config", "user.email", "fixture@example.test"]);
        fs::write(source.join("tracked.txt"), "committed\n").unwrap();
        fs::write(source.join("deleted.txt"), "deleted during task\n").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "fixture"]);
        let executable = directory.path().join("fake-codex");
        fs::write(
            &executable,
            format!(
                r#"#!/bin/sh
set -eu
final=
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; final=$1; fi
 shift
done
number=1
if [ -f created.txt ]; then number=2; fi
printf 'task result %s\n' "$number" > tracked.txt
printf 'created during task %s\n' "$number" > created.txt
rm -f deleted.txt
: > empty.txt
printf 'Done with task %s.' "$number" > "$final"
printf '%s\n' '{{"type":"turn.completed"}}'
exit {}
"#,
                if failed { 7 } else { 0 }
            ),
        )
        .unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
        let service = open_service(directory.path(), &repositories, &executable);
        let workspace = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "Receipt fixture".to_owned(),
                    },
                    title: "Receipt fixture".to_owned(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: vec![WorkspaceRepositoryRequest {
                        repository_id: None,
                        label: "api".to_owned(),
                        base_ref: "main".to_owned(),
                    }],
                    runtime: None,
                    planning: None,
                },
            )
            .unwrap()
            .workspace;
        let preflight = service.preflight_workspace(workspace.workspace_id).unwrap();
        let materialized = service
            .materialize_workspace(workspace.workspace_id, &preflight.effect_digest)
            .unwrap();
        let target = PathBuf::from(&materialized.materialization.worktrees[0].target_display_path);
        fs::write(target.join("tracked.txt"), "staged before task\n").unwrap();
        git(&target, &["add", "tracked.txt"]);
        fs::write(target.join("tracked.txt"), "dirty before task\n").unwrap();
        fs::write(target.join("draft.txt"), "unrelated private draft\n").unwrap();
        service
            .configure_ui_development_repository(target.clone(), None)
            .unwrap();
        let conversation = service
            .create_agent_conversation(CreateAgentConversationRequest {
                request_id: Uuid::new_v4(),
                provider: AgentProvider::Codex,
                source: AgentConversationSource::Ui {
                    route: "/receipt".to_owned(),
                    callout_id: "receipt.fixture".to_owned(),
                    label: "Receipt fixture".to_owned(),
                    selected_text: None,
                    context: None,
                    capture: None,
                },
            })
            .unwrap();
        Self {
            directory,
            service,
            conversation,
            target,
            executable,
            repositories,
        }
    }
    fn run(&self) -> Uuid {
        let request_id = Uuid::new_v4();
        self.service
            .send_agent_conversation_message(
                self.conversation.conversation_id,
                SendAgentConversationMessageRequest {
                    request_id,
                    body: "Change the fixture files.".to_owned(),
                },
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let current = self
                .service
                .get_agent_conversation(self.conversation.conversation_id)
                .unwrap();
            if current.active_session_id.is_none()
                && current.messages.iter().any(|message| {
                    message.request_id == Some(request_id) && message.session_id.is_some()
                })
            {
                return request_id;
            }
            assert!(
                Instant::now() < deadline,
                "The fake turn did not finish: {current:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }
    fn open(&self) -> LocalWtsService {
        open_service(self.directory.path(), &self.repositories, &self.executable)
    }
}
fn open_service(root: &Path, repositories: &Path, executable: &Path) -> LocalWtsService {
    LocalWtsService::open_with_repository_roots_launcher_and_adapter(
        root.join("data"),
        "test",
        root.join("workspaces"),
        [repositories.to_owned()],
        ProcessExternalLauncher,
        ProcessWorkspaceAdapter::default()
            .with_agent_executable(AgentProvider::Codex, executable.to_owned()),
    )
    .unwrap()
}
fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}
