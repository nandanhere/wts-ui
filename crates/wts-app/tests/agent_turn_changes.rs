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
    AgentConversation, AgentConversationSource, AgentProvider, AgentTurnChangesState,
    CreateAgentConversationRequest, LocalWtsService, ProcessExternalLauncher,
    ProcessWorkspaceAdapter, SendAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
fn process_receipt_uses_dirty_before_state_and_survives_reopen_without_index_changes() {
    let fixture = Fixture::new(false);
    let index_path =
        PathBuf::from(git(&fixture.target, &["rev-parse", "--git-path", "index"]).trim());
    let index = fs::read(&index_path).unwrap();
    let head = git(&fixture.target, &["rev-parse", "HEAD"]);
    let first = fixture.run();
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, first)
        .unwrap();
    assert_eq!(receipt.state, AgentTurnChangesState::Ready);
    assert!(receipt.patch.contains("-dirty before task"));
    assert!(receipt.patch.contains("+task result 1"));
    assert!(!receipt.patch.contains("-committed"));
    assert!(!receipt.patch.contains("unrelated private draft"));
    let changed = receipt
        .files
        .iter()
        .find(|file| file.file_path == "tracked.txt")
        .unwrap();
    assert!(changed.pre_existing_change);
    assert!(!changed.undo_supported);
    assert!(
        receipt
            .files
            .iter()
            .any(|file| file.file_path == "created.txt")
    );
    assert_eq!(fs::read(&index_path).unwrap(), index);
    assert_eq!(git(&fixture.target, &["rev-parse", "HEAD"]), head);
    assert_eq!(
        fs::read_to_string(fixture.target.join("draft.txt")).unwrap(),
        "unrelated private draft\n"
    );
    let replay = fixture.directory.path().join("replay");
    fs::create_dir(&replay).unwrap();
    git(&replay, &["init", "-b", "main"]);
    fs::write(replay.join("tracked.txt"), "dirty before task\n").unwrap();
    fs::write(replay.join("deleted.txt"), "deleted during task\n").unwrap();
    let patch_path = fixture.directory.path().join("observed.patch");
    fs::write(&patch_path, &receipt.patch).unwrap();
    git(&replay, &["apply", "--check", patch_path.to_str().unwrap()]);
    git(&replay, &["apply", patch_path.to_str().unwrap()]);
    assert_eq!(
        fs::read_to_string(replay.join("tracked.txt")).unwrap(),
        "task result 1\n"
    );
    assert!(!replay.join("deleted.txt").exists());
    assert_eq!(
        fs::read(replay.join("empty.txt")).unwrap(),
        Vec::<u8>::new()
    );
    let second = fixture.run();
    let next = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, second)
        .unwrap();
    assert_eq!(next.state, AgentTurnChangesState::Ready);
    assert!(next.patch.contains("-task result 1"));
    assert!(next.patch.contains("+task result 2"));
    assert!(!next.patch.contains("dirty before task"));
    let reopened = fixture.open();
    assert_eq!(
        reopened
            .get_agent_turn_changes(fixture.conversation.conversation_id, first)
            .unwrap(),
        receipt
    );
    assert!(
        reopened
            .get_agent_turn_changes(fixture.conversation.conversation_id, Uuid::new_v4())
            .is_err()
    );
    let directory = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/turn-changes")
        .join(receipt.session_id.to_string());
    assert_eq!(
        fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    for file in fs::read_dir(directory).unwrap() {
        assert_eq!(
            file.unwrap().metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn failed_task_retains_observed_edits_and_reports_unsupported_paths_without_reading_links() {
    let fixture = Fixture::new(true);
    let outside = fixture.directory.path().join("outside");
    fs::write(&outside, "PRIVATE_OUTSIDE_BYTES").unwrap();
    symlink(&outside, fixture.target.join("link.txt")).unwrap();
    fs::write(fixture.target.join("binary.dat"), b"binary\0bytes").unwrap();
    let request = fixture.run();
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, request)
        .unwrap();
    assert_eq!(receipt.state, AgentTurnChangesState::Incomplete);
    assert_eq!(receipt.omitted_file_count, 1);
    assert!(receipt.patch.contains("+task result 1"));
    assert!(receipt.detail.contains("Symbolic links are not followed"));
    let json = serde_json::to_string(&receipt).unwrap();
    assert!(!json.contains("PRIVATE_OUTSIDE_BYTES"));
    assert!(
        !receipt
            .files
            .iter()
            .any(|file| file.file_path == "link.txt")
    );
    assert_eq!(
        fs::read_to_string(outside).unwrap(),
        "PRIVATE_OUTSIDE_BYTES"
    );
}

#[test]
fn terminal_capture_failure_is_explicit_and_legacy_pairs_remain_readable() {
    let fixture = Fixture::new(false);
    let request_id = fixture.run();
    let expected = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, request_id)
        .unwrap();
    let path = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/turn-changes")
        .join(expected.session_id.to_string())
        .join("receipt.json");
    let mut stored: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    stored["receipt"]["state"] = serde_json::json!("capturing");
    stored["receipt"]
        .as_object_mut()
        .unwrap()
        .remove("completedAtUnixMs");
    stored["receipt"].as_object_mut().unwrap().remove("after");
    stored["after"] = serde_json::Value::Null;
    let bytes = serde_json::to_vec(&stored).unwrap();
    fs::write(&path, &bytes).unwrap();
    let unavailable = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, request_id)
        .unwrap();
    assert_eq!(unavailable.state, AgentTurnChangesState::Unavailable);
    assert!(
        unavailable
            .detail
            .contains("after state could not be saved")
    );
    assert_eq!(
        fs::read(&path).unwrap(),
        bytes,
        "Reading a failed capture must not capture later edits as the original result."
    );
    fs::remove_file(&path).unwrap();
    let legacy = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, request_id)
        .unwrap();
    assert_eq!(legacy.state, AgentTurnChangesState::Unavailable);
    assert_eq!(legacy.session_id, expected.session_id);
    assert_eq!(legacy.source_context_sha256, expected.source_context_sha256);
}

#[test]
fn after_capture_storage_failure_keeps_the_completed_agent_result_and_a_terminal_receipt() {
    use sha2::{Digest, Sha256};
    let fixture = Fixture::new(false);
    let hash = format!("{:x}", Sha256::digest(b"task result 1\n"));
    let script = fs::read_to_string(&fixture.executable).unwrap();
    let blocker = format!(
        "session=$(basename \"$final\" .final.txt | cut -c38-)\nmkdir \"$(dirname \"$final\")/turn-changes/$session/{hash}\"\n"
    );
    let blocker = blocker.replace("\\\"", "\"");
    fs::write(
        &fixture.executable,
        script.replace("printf 'Done", &(blocker + "printf 'Done")),
    )
    .unwrap();
    let request_id = fixture.run();
    let conversation = fixture
        .service
        .get_agent_conversation(fixture.conversation.conversation_id)
        .unwrap();
    let assistant = conversation
        .messages
        .iter()
        .find(|message| {
            message.role == wts_app::AgentConversationMessageRole::Assistant
                && message.request_id == Some(request_id)
        })
        .unwrap();
    assert_eq!(
        assistant.status,
        wts_app::AgentConversationMessageStatus::Completed
    );
    assert_eq!(assistant.body, "Done with task 1.");
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, request_id)
        .unwrap();
    assert_eq!(receipt.state, AgentTurnChangesState::Unavailable);
    assert!(receipt.completed_at_unix_ms.is_some());
    assert!(receipt.detail.contains("after state could not be saved"));
}

#[test]
fn conditional_restore_keeps_original_dirty_index_and_replays_without_touching_later_edits() {
    let fixture = Fixture::new(false);
    let request_id = fixture.run();
    let index_path =
        PathBuf::from(git(&fixture.target, &["rev-parse", "--git-path", "index"]).trim());
    let index = fs::read(&index_path).unwrap();
    let preflight = fixture
        .service
        .preflight_agent_turn_restore(fixture.conversation.conversation_id, request_id)
        .unwrap();
    assert_eq!(
        preflight.state,
        wts_app::AgentTurnRestorePreflightState::Ready
    );
    assert!(
        preflight
            .files
            .iter()
            .any(|file| file.file_path == "created.txt"
                && file.action == wts_app::AgentTurnRestoreAction::Remove)
    );
    let request = wts_app::AgentTurnRestoreRequest {
        request_id: Uuid::new_v4(),
        effect_digest: preflight.effect_digest,
    };
    let result = fixture
        .service
        .restore_agent_turn(
            fixture.conversation.conversation_id,
            request_id,
            request.clone(),
        )
        .unwrap();
    assert_eq!(result.state, wts_app::AgentTurnRestoreResultState::Restored);
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "dirty before task\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("deleted.txt")).unwrap(),
        "deleted during task\n"
    );
    assert!(!fixture.target.join("created.txt").exists());
    assert!(!fixture.target.join("empty.txt").exists());
    assert_eq!(
        fs::read_to_string(fixture.target.join("draft.txt")).unwrap(),
        "unrelated private draft\n"
    );
    assert_eq!(fs::read(&index_path).unwrap(), index);
    fs::write(fixture.target.join("tracked.txt"), "later user edit\n").unwrap();
    let reopened = fixture.open();
    assert_eq!(
        reopened
            .restore_agent_turn(fixture.conversation.conversation_id, request_id, request)
            .unwrap(),
        result
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "later user edit\n"
    );
    assert_eq!(
        reopened
            .preflight_agent_turn_restore(fixture.conversation.conversation_id, request_id)
            .unwrap()
            .state,
        wts_app::AgentTurnRestorePreflightState::Restored
    );
}

#[test]
fn conditional_restore_rejects_later_file_or_index_changes_without_partial_writes() {
    let fixture = Fixture::new(false);
    let request_id = fixture.run();
    let preflight = fixture
        .service
        .preflight_agent_turn_restore(fixture.conversation.conversation_id, request_id)
        .unwrap();
    fs::write(fixture.target.join("draft.txt"), "later unrelated edit\n").unwrap();
    let result = fixture
        .service
        .restore_agent_turn(
            fixture.conversation.conversation_id,
            request_id,
            wts_app::AgentTurnRestoreRequest {
                request_id: Uuid::new_v4(),
                effect_digest: preflight.effect_digest,
            },
        )
        .unwrap();
    assert_eq!(result.state, wts_app::AgentTurnRestoreResultState::Conflict);
    assert!(result.files.is_empty());
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "task result 1\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("draft.txt")).unwrap(),
        "later unrelated edit\n"
    );
    fs::write(
        fixture.target.join("draft.txt"),
        "unrelated private draft\n",
    )
    .unwrap();
    git(&fixture.target, &["add", "tracked.txt"]);
    let blocked = fixture
        .service
        .preflight_agent_turn_restore(fixture.conversation.conversation_id, request_id)
        .unwrap();
    assert_eq!(
        blocked.state,
        wts_app::AgentTurnRestorePreflightState::Blocked
    );
    assert!(fixture.target.join("created.txt").exists());
}

#[test]
fn restore_restart_recovers_a_written_file_before_its_journal_acknowledgement() {
    let fixture = Fixture::new(false);
    let request_id = fixture.run();
    let request = seed_partial_restore(&fixture, request_id, false);
    let reopened = fixture.open();
    let result = reopened
        .restore_agent_turn(
            fixture.conversation.conversation_id,
            request_id,
            request.clone(),
        )
        .unwrap();
    assert_eq!(result.state, wts_app::AgentTurnRestoreResultState::Restored);
    assert_eq!(result.files.len(), 4);
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "dirty before task\n"
    );
    assert!(fixture.target.join("deleted.txt").exists());
    assert!(!fixture.target.join("empty.txt").exists());
    assert!(!fixture.target.join("created.txt").exists());
    fs::write(fixture.target.join("tracked.txt"), "later after recovery\n").unwrap();
    assert_eq!(
        reopened
            .restore_agent_turn(fixture.conversation.conversation_id, request_id, request)
            .unwrap(),
        result
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "later after recovery\n"
    );
}

#[test]
fn partial_restore_retry_checks_mixed_state_and_continues_only_when_conflicts_are_resolved() {
    let fixture = Fixture::new(false);
    let request_id = fixture.run();
    let request = seed_partial_restore(&fixture, request_id, true);
    fs::write(fixture.target.join("tracked.txt"), "later user work\n").unwrap();
    let conflict = fixture
        .service
        .restore_agent_turn(
            fixture.conversation.conversation_id,
            request_id,
            request.clone(),
        )
        .unwrap();
    assert_eq!(
        conflict.state,
        wts_app::AgentTurnRestoreResultState::Incomplete
    );
    assert!(!conflict.blockers.is_empty());
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "later user work\n"
    );
    assert!(!fixture.target.join("deleted.txt").exists());
    fs::write(fixture.target.join("tracked.txt"), "task result 1\n").unwrap();
    let resume = fixture
        .service
        .preflight_agent_turn_restore(fixture.conversation.conversation_id, request_id)
        .unwrap();
    assert_eq!(resume.state, wts_app::AgentTurnRestorePreflightState::Ready);
    assert_eq!(resume.resume_request_id, Some(request.request_id));
    assert!(
        resume
            .files
            .iter()
            .all(|file| file.file_path != "created.txt" && file.file_path != "empty.txt")
    );
    let finished = fixture
        .service
        .restore_agent_turn(fixture.conversation.conversation_id, request_id, request)
        .unwrap();
    assert_eq!(
        finished.state,
        wts_app::AgentTurnRestoreResultState::Restored
    );
    assert_eq!(finished.files.len(), 4);
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "dirty before task\n"
    );
    assert!(fixture.target.join("deleted.txt").exists());
}

fn seed_partial_restore(
    fixture: &Fixture,
    request_id: Uuid,
    acknowledged: bool,
) -> wts_app::AgentTurnRestoreRequest {
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, request_id)
        .unwrap();
    let preflight = fixture
        .service
        .preflight_agent_turn_restore(fixture.conversation.conversation_id, request_id)
        .unwrap();
    let request = wts_app::AgentTurnRestoreRequest {
        request_id: Uuid::new_v4(),
        effect_digest: preflight.effect_digest,
    };
    let result = fixture
        .service
        .restore_agent_turn(
            fixture.conversation.conversation_id,
            request_id,
            request.clone(),
        )
        .unwrap();
    assert_eq!(result.state, wts_app::AgentTurnRestoreResultState::Restored);
    // Model the durable state after two removals, with the second write not yet acknowledged.
    fs::write(fixture.target.join("tracked.txt"), "task result 1\n").unwrap();
    fs::remove_file(fixture.target.join("deleted.txt")).unwrap();
    let store = fixture.directory.path().join("data/agent-conversations-v1");
    let directory = store
        .join("turn-changes")
        .join(receipt.session_id.to_string());
    let path = directory.join(format!("restore-{}.json", request.request_id));
    let mut journal: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    journal["finished"] = serde_json::json!(acknowledged);
    journal["result"]["state"] = serde_json::json!("incomplete");
    journal["result"]
        .as_object_mut()
        .unwrap()
        .remove("restoredAtUnixMs");
    journal["result"]["files"] = serde_json::json!([{"filePath":"created.txt","action":"remove"}]);
    journal["pending_file"] = serde_json::json!({"filePath":"empty.txt","action":"remove"});
    fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    if acknowledged {
        fs::write(
            directory.join("restore-completed.json"),
            serde_json::to_vec(&journal["result"]).unwrap(),
        )
        .unwrap();
    } else {
        fs::remove_file(directory.join("restore-completed.json")).unwrap();
        fs::write(store.join(format!("workspace-{}.restore.pending", receipt.workspace_id)), serde_json::to_vec(&serde_json::json!({"session_id":receipt.session_id,"restore_request_id":request.request_id,"workspace_id":receipt.workspace_id})).unwrap()).unwrap();
    }
    request
}

#[test]
fn completed_restore_record_cannot_borrow_another_request_identity() {
    let fixture = Fixture::new(false);
    let request_id = fixture.run();
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, request_id)
        .unwrap();
    let preflight = fixture
        .service
        .preflight_agent_turn_restore(fixture.conversation.conversation_id, request_id)
        .unwrap();
    let request = wts_app::AgentTurnRestoreRequest {
        request_id: Uuid::new_v4(),
        effect_digest: preflight.effect_digest,
    };
    fixture
        .service
        .restore_agent_turn(fixture.conversation.conversation_id, request_id, request)
        .unwrap();
    let path = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/turn-changes")
        .join(receipt.session_id.to_string())
        .join("restore-completed.json");
    let mut forged: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    forged["requestId"] = serde_json::json!(Uuid::new_v4());
    fs::write(&path, serde_json::to_vec(&forged).unwrap()).unwrap();
    assert!(
        fixture
            .service
            .preflight_agent_turn_restore(fixture.conversation.conversation_id, request_id)
            .is_err()
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "dirty before task\n"
    );
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
