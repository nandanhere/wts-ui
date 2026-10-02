#![cfg(unix)]
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationSource, AgentProvider, AgentTurnCheckStatus,
    AgentTurnChecksState, CreateAgentConversationRequest, LocalWtsService, ProcessWorkspaceAdapter,
    RunAgentTurnCheckRequest, SendAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

use wts_app::{
    AgentWorkItemIntegrationPreflightState, AgentWorkItemIntegrationResultState,
    AgentWorkItemRequest, AgentWorkItemState, AgentWorkSet, AgentWorkSetKind,
    CreateAgentWorkSetRequest, IntegrateAgentWorkItemRequest,
};

const ORIGINAL_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0,
    5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
const CANDIDATE_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 96, 248, 255, 31, 0, 3,
    2, 1, 255, 230, 119, 11, 174, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

fn candidate(fixture: &Fixture) -> (AgentWorkSet, Uuid) {
    let turn = fixture.run();
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, turn)
        .unwrap();
    let task_id = Uuid::new_v4();
    let set = fixture
        .service
        .create_agent_work_set(
            fixture.conversation.conversation_id,
            turn,
            CreateAgentWorkSetRequest {
                request_id: Uuid::new_v4(),
                expected_after_checkpoint_id: receipt.after.unwrap().checkpoint_id,
                kind: AgentWorkSetKind::Alternatives,
                tasks: vec![AgentWorkItemRequest {
                    task_id,
                    title: "Isolated fix".to_owned(),
                    prompt: "Apply the candidate fix.".to_owned(),
                    depends_on: vec![],
                }],
            },
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let set = fixture.service.get_agent_work_set(set.work_set_id).unwrap();
        let task = &set.tasks[0];
        if task.state == AgentWorkItemState::Completed {
            return (set, task_id);
        }
        assert!(
            !matches!(
                task.state,
                AgentWorkItemState::Failed
                    | AgentWorkItemState::Blocked
                    | AgentWorkItemState::Cancelled
            ),
            "{task:?}"
        );
        assert!(Instant::now() < deadline, "{task:?}");
        thread::sleep(Duration::from_millis(20));
    }
}
fn check(fixture: &Fixture, set: &AgentWorkSet) {
    let task = &set.tasks[0];
    let checks = fixture
        .service
        .get_agent_turn_checks(task.conversation_id, task.request_id)
        .unwrap();
    assert_eq!(checks.state, AgentTurnChecksState::Ready, "{checks:?}");
    assert!(!checks.checks.is_empty());
    for item in checks.checks {
        let result = fixture
            .service
            .run_agent_turn_check(
                task.conversation_id,
                task.request_id,
                RunAgentTurnCheckRequest {
                    request_id: Uuid::new_v4(),
                    check_id: item.check_id,
                    expected_after_checkpoint_id: checks.after_checkpoint_id.unwrap(),
                    expected_plan_revision: item.plan_revision,
                },
            )
            .unwrap();
        assert_eq!(
            result.runs.last().unwrap().status,
            AgentTurnCheckStatus::Passed,
            "{result:?}"
        );
    }
}

#[test]
fn checked_candidate_integration_preserves_target_draft_index_history_and_exact_replay() {
    let fixture = Fixture::new();
    let (set, task_id) = candidate(&fixture);
    let head = git(&fixture.target, &["rev-parse", "HEAD"]);
    let index = git(&fixture.target, &["ls-files", "--stage"]);
    let index_path =
        PathBuf::from(git(&fixture.target, &["rev-parse", "--git-path", "index"]).trim());
    let index_bytes = fs::read(&index_path).unwrap();
    let before = fs::read(fixture.target.join("tracked.txt")).unwrap();
    let blocked = fixture
        .service
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    assert_eq!(
        blocked.state,
        AgentWorkItemIntegrationPreflightState::Blocked
    );
    assert!(
        blocked
            .blockers
            .iter()
            .any(|blocker| blocker.code == "checksNotPassed")
    );
    assert_eq!(
        fs::read(fixture.target.join("tracked.txt")).unwrap(),
        before
    );
    check(&fixture, &set);
    let preview = fixture
        .service
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    assert_eq!(
        preview.state,
        AgentWorkItemIntegrationPreflightState::Ready,
        "{preview:?}"
    );
    assert_eq!(preview.files.len(), 4);
    let request = IntegrateAgentWorkItemRequest {
        request_id: Uuid::new_v4(),
        effect_digest: preview.effect_digest,
    };
    let result = fixture
        .service
        .integrate_agent_work_item(set.work_set_id, task_id, request.clone())
        .unwrap();
    assert_eq!(
        result.state,
        AgentWorkItemIntegrationResultState::Integrated,
        "{result:?}"
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "candidate result\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("src/new/result.txt")).unwrap(),
        "candidate addition\n"
    );
    assert!(!fixture.target.join("deleted.txt").exists());
    assert_eq!(
        fs::read(fixture.target.join("icons/changed.png")).unwrap(),
        CANDIDATE_PNG
    );
    assert_eq!(
        fs::read(fixture.target.join("icons/unchanged.png")).unwrap(),
        ORIGINAL_PNG
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("draft.txt")).unwrap(),
        "unrelated private draft\n"
    );
    assert_eq!(git(&fixture.target, &["rev-parse", "HEAD"]), head);
    assert_eq!(git(&fixture.target, &["ls-files", "--stage"]), index);
    assert_eq!(fs::read(&index_path).unwrap(), index_bytes);
    let reopened = fixture.open();
    fs::write(fixture.target.join("tracked.txt"), "later user edit\n").unwrap();
    assert_eq!(
        reopened
            .integrate_agent_work_item(set.work_set_id, task_id, request.clone())
            .unwrap(),
        result
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "later user edit\n"
    );
    let changed = IntegrateAgentWorkItemRequest {
        effect_digest: format!("sha256:{}", "0".repeat(64)),
        ..request
    };
    assert!(
        reopened
            .integrate_agent_work_item(set.work_set_id, task_id, changed)
            .is_err()
    );
    assert_eq!(
        reopened.get_agent_work_set(set.work_set_id).unwrap().tasks[0].state,
        AgentWorkItemState::Completed
    );
    let journal_path = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/work-item-integrations")
        .join(set.work_set_id.to_string())
        .join(task_id.to_string())
        .join("integration.json");
    let original = fs::read(&journal_path).unwrap();
    let mut forged: serde_json::Value = serde_json::from_slice(&original).unwrap();
    forged["result"]["workspaceId"] = serde_json::json!(Uuid::new_v4());
    fs::write(&journal_path, serde_json::to_vec(&forged).unwrap()).unwrap();
    assert!(
        reopened
            .preflight_agent_work_item_integration(set.work_set_id, task_id)
            .is_err()
    );
    let outside = fixture.directory.path().join("outside-integration.json");
    fs::write(&outside, &original).unwrap();
    fs::remove_file(&journal_path).unwrap();
    std::os::unix::fs::symlink(&outside, &journal_path).unwrap();
    assert!(
        reopened
            .preflight_agent_work_item_integration(set.work_set_id, task_id)
            .is_err()
    );
    let replay: IntegrateAgentWorkItemRequest =
        serde_json::from_slice::<serde_json::Value>(&original)
            .and_then(|value| serde_json::from_value(value["request"].clone()))
            .unwrap();
    assert!(
        reopened
            .integrate_agent_work_item(set.work_set_id, task_id, replay)
            .is_err()
    );
    assert_eq!(fs::read(outside).unwrap(), original);
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "later user edit\n"
    );
}

#[test]
fn changed_target_or_candidate_prevents_any_integration_writes() {
    let fixture = Fixture::new();
    let (set, task_id) = candidate(&fixture);
    check(&fixture, &set);
    let preview = fixture
        .service
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    fs::write(fixture.target.join("draft.txt"), "later user draft\n").unwrap();
    let result = fixture
        .service
        .integrate_agent_work_item(
            set.work_set_id,
            task_id,
            IntegrateAgentWorkItemRequest {
                request_id: Uuid::new_v4(),
                effect_digest: preview.effect_digest.clone(),
            },
        )
        .unwrap();
    assert_eq!(result.state, AgentWorkItemIntegrationResultState::Conflict);
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "dirty before task\n"
    );
    assert!(fixture.target.join("deleted.txt").exists());
    assert!(!fixture.target.join("src/new/result.txt").exists());
    assert_eq!(
        fs::read_to_string(fixture.target.join("draft.txt")).unwrap(),
        "later user draft\n"
    );
    fs::write(
        fixture.target.join("draft.txt"),
        "unrelated private draft\n",
    )
    .unwrap();
    let candidate = fixture
        .service
        .get_materialization(set.tasks[0].workspace_id.unwrap())
        .unwrap()
        .unwrap();
    let candidate_root = PathBuf::from(&candidate.worktrees[0].target_display_path);
    fs::write(candidate_root.join("tracked.txt"), "later candidate edit\n").unwrap();
    let blocked = fixture
        .service
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    assert_eq!(
        blocked.state,
        AgentWorkItemIntegrationPreflightState::Blocked
    );
    assert!(
        blocked
            .blockers
            .iter()
            .any(|blocker| blocker.code == "candidateChanged")
    );
    let result = fixture
        .service
        .integrate_agent_work_item(
            set.work_set_id,
            task_id,
            IntegrateAgentWorkItemRequest {
                request_id: Uuid::new_v4(),
                effect_digest: preview.effect_digest,
            },
        )
        .unwrap();
    assert_eq!(result.state, AgentWorkItemIntegrationResultState::Conflict);
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "dirty before task\n"
    );
    assert!(fixture.target.join("deleted.txt").exists());
    fs::write(candidate_root.join("tracked.txt"), "candidate result\n").unwrap();
    fs::write(candidate_root.join(".check-fail"), "fail").unwrap();
    let checks = fixture
        .service
        .get_agent_turn_checks(set.tasks[0].conversation_id, set.tasks[0].request_id)
        .unwrap();
    let failed = fixture
        .service
        .run_agent_turn_check(
            set.tasks[0].conversation_id,
            set.tasks[0].request_id,
            RunAgentTurnCheckRequest {
                request_id: Uuid::new_v4(),
                check_id: checks.checks[0].check_id.clone(),
                expected_after_checkpoint_id: checks.after_checkpoint_id.unwrap(),
                expected_plan_revision: checks.checks[0].plan_revision,
            },
        )
        .unwrap();
    assert_eq!(
        failed.runs.last().unwrap().status,
        AgentTurnCheckStatus::Failed
    );
    let blocked = fixture
        .service
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    assert_eq!(
        blocked.state,
        AgentWorkItemIntegrationPreflightState::Blocked
    );
    assert!(
        blocked
            .blockers
            .iter()
            .any(|blocker| blocker.code == "checksNotPassed"),
        "{blocked:?}"
    );
}

#[test]
fn integration_reopens_a_partial_file_journal_and_resumes_only_the_same_request() {
    let fixture = Fixture::new();
    let (set, task_id) = candidate(&fixture);
    check(&fixture, &set);
    let preview = fixture
        .service
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    let request = IntegrateAgentWorkItemRequest {
        request_id: Uuid::new_v4(),
        effect_digest: preview.effect_digest,
    };
    let complete = fixture
        .service
        .integrate_agent_work_item(set.work_set_id, task_id, request.clone())
        .unwrap();
    assert_eq!(
        complete.state,
        AgentWorkItemIntegrationResultState::Integrated
    );
    let directory = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1/work-item-integrations")
        .join(set.work_set_id.to_string())
        .join(task_id.to_string());
    let path = directory.join("integration.json");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let mut journal: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    // Recreate the durable boundary after the first deletion, before its acknowledgement was saved.
    fs::write(fixture.target.join("tracked.txt"), "dirty before task\n").unwrap();
    fs::remove_file(fixture.target.join("src/new/result.txt")).unwrap();
    fs::write(fixture.target.join("icons/changed.png"), ORIGINAL_PNG).unwrap();
    journal["finished"] = serde_json::json!(false);
    journal["pending_file"] = serde_json::json!({"filePath":"deleted.txt","status":"deleted"});
    journal["result"]["state"] = serde_json::json!("incomplete");
    journal["result"]["files"] = serde_json::json!([]);
    journal["result"]
        .as_object_mut()
        .unwrap()
        .remove("integratedAtUnixMs");
    fs::write(&path, serde_json::to_vec(&journal).unwrap()).unwrap();
    let marker = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1")
        .join(format!(
            "workspace-{}.integration.pending",
            set.workspace_id
        ));
    fs::write(&marker, serde_json::to_vec(&serde_json::json!({"work_set_id":set.work_set_id,"task_id":task_id,"workspace_id":set.workspace_id,"request_id":request.request_id})).unwrap()).unwrap();
    assert!(
        matches!(
            fixture.service.start_agent_session(
                set.workspace_id,
                AgentProvider::Codex,
                wts_app::TerminalProvider::Terminal,
                wts_app::AgentSessionCategory::Implementation
            ),
            Err(wts_app::LocalWtsError::AgentConversationBusy)
        ),
        "An uncertain integration must exclude another writer."
    );
    let reopened = fixture.open();
    let session = reopened
        .start_agent_session(
            set.workspace_id,
            AgentProvider::Codex,
            wts_app::TerminalProvider::Terminal,
            wts_app::AgentSessionCategory::Implementation,
        )
        .expect("A durable terminal partial result must release the workspace.");
    reopened.finish_agent_session(session.session_id).unwrap();
    assert!(
        !marker.exists(),
        "Recovery saved the known partial effects before releasing its marker."
    );
    let preview = reopened
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    assert_eq!(
        preview.state,
        AgentWorkItemIntegrationPreflightState::Ready,
        "{preview:?}"
    );
    assert_eq!(preview.resume_request_id, Some(request.request_id));
    assert_eq!(preview.effect_digest, request.effect_digest);
    let other = IntegrateAgentWorkItemRequest {
        request_id: Uuid::new_v4(),
        effect_digest: request.effect_digest.clone(),
    };
    assert!(
        reopened
            .integrate_agent_work_item(set.work_set_id, task_id, other)
            .is_err()
    );
    fs::write(fixture.target.join("draft.txt"), "later external draft\n").unwrap();
    let blocked = reopened
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    assert_eq!(
        blocked.state,
        AgentWorkItemIntegrationPreflightState::Blocked
    );
    assert_eq!(blocked.resume_request_id, Some(request.request_id));
    let stopped = reopened
        .integrate_agent_work_item(set.work_set_id, task_id, request.clone())
        .unwrap();
    assert_eq!(
        stopped.state,
        AgentWorkItemIntegrationResultState::Incomplete
    );
    assert_eq!(
        stopped.files.len(),
        1,
        "A later conflict must retain the earlier confirmed file effect."
    );
    assert_eq!(stopped.files[0].file_path, "deleted.txt");
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "dirty before task\n"
    );
    fs::write(
        fixture.target.join("draft.txt"),
        "unrelated private draft\n",
    )
    .unwrap();
    let resumed = reopened
        .integrate_agent_work_item(set.work_set_id, task_id, request)
        .unwrap();
    assert_eq!(
        resumed.state,
        AgentWorkItemIntegrationResultState::Integrated,
        "{resumed:?}"
    );
    assert_eq!(resumed.files.len(), 4);
    assert_eq!(
        resumed
            .files
            .iter()
            .filter(|file| file.file_path == "deleted.txt")
            .count(),
        1
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "candidate result\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("src/new/result.txt")).unwrap(),
        "candidate addition\n"
    );
    assert_eq!(
        fs::read(fixture.target.join("icons/changed.png")).unwrap(),
        CANDIDATE_PNG
    );
    assert_eq!(
        fs::read(fixture.target.join("icons/unchanged.png")).unwrap(),
        ORIGINAL_PNG
    );
    assert!(!marker.exists());
}

#[test]
fn no_saved_host_checks_block_integration_with_a_verification_action() {
    let fixture = Fixture::with_checks(false);
    let (set, task_id) = candidate(&fixture);
    let preview = fixture
        .service
        .preflight_agent_work_item_integration(set.work_set_id, task_id)
        .unwrap();
    assert_eq!(
        preview.state,
        AgentWorkItemIntegrationPreflightState::Blocked
    );
    assert!(
        preview
            .blockers
            .iter()
            .any(|blocker| blocker.code == "noChecks"
                && blocker.detail.contains("workspace verification")),
        "{preview:?}"
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "dirty before task\n"
    );
}

#[test]
fn restoring_a_binary_candidate_recovers_exact_before_bytes_without_changing_its_index() {
    let fixture = Fixture::new();
    let (set, _) = candidate(&fixture);
    let task = &set.tasks[0];
    let materialization = fixture
        .service
        .get_materialization(task.workspace_id.unwrap())
        .unwrap()
        .unwrap();
    let target = PathBuf::from(&materialization.worktrees[0].target_display_path);
    let head = git(&target, &["rev-parse", "HEAD"]);
    let index_path = PathBuf::from(git(&target, &["rev-parse", "--git-path", "index"]).trim());
    let index = fs::read(&index_path).unwrap();
    assert_eq!(
        fs::read(target.join("icons/changed.png")).unwrap(),
        CANDIDATE_PNG
    );
    let receipt = fixture
        .service
        .get_agent_turn_changes(task.conversation_id, task.request_id)
        .unwrap();
    assert_eq!(receipt.state, wts_app::AgentTurnChangesState::Ready);
    assert!(
        receipt.patch_truncated,
        "Binary changes must not claim a complete text patch."
    );
    assert!(receipt.files.iter().any(|file| {
        file.file_path == "icons/changed.png"
            && !file.undo_supported
            && file
                .detail
                .as_ref()
                .is_some_and(|detail| detail.contains("binary") || detail.contains("Binary"))
    }));
    let preview = fixture
        .service
        .preflight_agent_turn_restore(task.conversation_id, task.request_id)
        .unwrap();
    assert_eq!(
        preview.state,
        wts_app::AgentTurnRestorePreflightState::Ready,
        "{preview:?}"
    );
    let request = wts_app::AgentTurnRestoreRequest {
        request_id: Uuid::new_v4(),
        effect_digest: preview.effect_digest,
    };
    let restored = fixture
        .service
        .restore_agent_turn(task.conversation_id, task.request_id, request.clone())
        .unwrap();
    assert_eq!(
        restored.state,
        wts_app::AgentTurnRestoreResultState::Restored,
        "{restored:?}"
    );
    assert_eq!(
        fs::read(target.join("icons/changed.png")).unwrap(),
        ORIGINAL_PNG
    );
    assert_eq!(
        fs::read(target.join("icons/unchanged.png")).unwrap(),
        ORIGINAL_PNG
    );
    assert_eq!(
        fs::read(fixture.target.join("icons/changed.png")).unwrap(),
        ORIGINAL_PNG
    );
    assert_eq!(fs::read(index_path).unwrap(), index);
    assert_eq!(git(&target, &["rev-parse", "HEAD"]), head);
    let reopened = fixture.open();
    assert_eq!(
        reopened
            .restore_agent_turn(task.conversation_id, task.request_id, request)
            .unwrap(),
        restored
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
    fn new() -> Self {
        Self::with_checks(true)
    }

    fn with_checks(supported_checks: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let source = repositories.join("api");
        fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "-b", "main"]);
        git(&source, &["config", "user.name", "Fixture"]);
        git(&source, &["config", "user.email", "fixture@example.test"]);
        fs::write(source.join("tracked.txt"), "committed\n").unwrap();
        fs::create_dir(source.join("icons")).unwrap();
        fs::write(source.join("icons/changed.png"), ORIGINAL_PNG).unwrap();
        fs::write(source.join("icons/unchanged.png"), ORIGINAL_PNG).unwrap();
        fs::write(source.join(".gitignore"), ".check-*\n.agent-count\n").unwrap();
        fs::write(
            source.join("package.json"),
            r#"{"name":"wts-check-fixture","version":"1.0.0","scripts":{"test":"node check.cjs"}}"#,
        )
        .unwrap();
        fs::write(
            source.join("check.cjs"),
            r#"const fs = require('node:fs');
fs.appendFileSync('.check-count', 'x');
if (fs.existsSync('.check-fail')) { console.error('candidate check failure'); process.exit(7); }
console.log('CHECKED_CANDIDATE');
"#,
        )
        .unwrap();
        fs::write(source.join("deleted.txt"), "deleted during task\n").unwrap();
        if !supported_checks {
            fs::remove_file(source.join("package.json")).unwrap();
            fs::remove_file(source.join("check.cjs")).unwrap();
        }
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "fixture"]);
        let executable = directory.path().join("fake-codex");
        fs::write(
            &executable,
            r#"#!/bin/sh
set -eu
final=
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; final=$1; fi
 shift
done
printf x >> .agent-count
if [ -f initial-result.txt ]; then
  printf 'candidate result\n' > tracked.txt
  printf '\211\120\116\107\015\012\032\012\000\000\000\015\111\110\104\122\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\015\111\104\101\124\170\234\143\140\140\370\377\037\000\003\002\001\377\346\167\013\256\000\000\000\000\111\105\116\104\256\102\140\202' > icons/changed.png
  mkdir -p src/new
  printf 'candidate addition\n' > src/new/result.txt
  rm -f deleted.txt
else
  printf 'initial result\n' > initial-result.txt
fi
printf 'Finished isolated fixture.' > "$final"
printf '%s\n' '{"type":"turn.completed"}'
"#,
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
        NoExternalLaunch,
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

struct NoExternalLaunch;
impl wts_app::ExternalLauncher for NoExternalLaunch {
    fn launch_vscode(&self, _: &Path) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
    fn launch_cli(
        &self,
        _: &Path,
        _: AgentProvider,
        _: wts_app::TerminalProvider,
    ) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
    fn launch_repository_base(
        &self,
        _: &wts_app::RepositoryBaseTarget,
    ) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
    fn launch_change_request_draft(
        &self,
        _: &wts_app::ChangeRequestDraftTarget,
    ) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
    fn launch_jira_issue(
        &self,
        _: &wts_app::JiraIssueTarget,
    ) -> Result<(), wts_app::LaunchFailure> {
        Err(wts_app::LaunchFailure::Rejected)
    }
}
