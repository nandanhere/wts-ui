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
    AgentConversation, AgentConversationSource, AgentProvider, AgentTurnChangesState,
    AgentWorkItemRequest, AgentWorkItemState, AgentWorkSetKind, CreateAgentConversationRequest,
    CreateAgentWorkSetRequest, LocalWtsError, LocalWtsService, ProcessExternalLauncher,
    ProcessWorkspaceAdapter, SendAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
fn isolated_alternatives_share_frozen_dirty_input_and_keep_parent_files_unchanged() {
    let fixture = Fixture::new(false);
    let origin = fixture.run();
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, origin)
        .unwrap();
    let checkpoint = receipt.after.unwrap().checkpoint_id;
    let parent_index_path =
        PathBuf::from(git(&fixture.target, &["rev-parse", "--git-path", "index"]).trim());
    let parent_index = fs::read(&parent_index_path).unwrap();
    let request = CreateAgentWorkSetRequest {
        request_id: Uuid::new_v4(),
        expected_after_checkpoint_id: checkpoint,
        kind: AgentWorkSetKind::Alternatives,
        tasks: vec![task("Option A", vec![]), task("Option B", vec![])],
    };
    let set = fixture
        .service
        .create_agent_work_set(
            fixture.conversation.conversation_id,
            origin,
            request.clone(),
        )
        .unwrap();
    let set = wait_set(&fixture.service, set.work_set_id);
    assert!(
        set.tasks
            .iter()
            .all(|task| task.state == AgentWorkItemState::Completed),
        "{set:?}"
    );
    assert_ne!(set.tasks[0].workspace_id, set.tasks[1].workspace_id);
    for task in &set.tasks {
        let child = fixture
            .service
            .get_agent_conversation(task.conversation_id)
            .unwrap();
        assert!(child.preview.is_none());
        let target = fs::read_dir(task.workspace_display_path.as_ref().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.join("icon.png").is_file())
            .unwrap();
        assert_eq!(
            fs::read(target.join("icon.png")).unwrap(),
            b"\x89PNG\r\n\x1a\n\0retained icon"
        );
        assert_eq!(
            fs::read(target.join("dirty-icon.png")).unwrap(),
            b"\x89PNG\r\n\x1a\n\0dirty icon"
        );
        assert!(
            matches!(child.source, AgentConversationSource::WorkItem { work_set_id, task_id, .. } if work_set_id == set.work_set_id && task_id == task.task_id)
        );
        let changes = fixture
            .service
            .get_agent_turn_changes(task.conversation_id, task.request_id)
            .unwrap();
        assert_eq!(changes.state, AgentTurnChangesState::Ready);
        assert!(changes.patch.contains("-task result 1"));
        assert!(changes.patch.contains("+task result 2"));
        assert!(!changes.patch.contains("-committed"));
    }
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "task result 1\n"
    );
    assert_eq!(fs::read(parent_index_path).unwrap(), parent_index);
    assert_eq!(
        fixture
            .service
            .list_agent_conversations()
            .unwrap()
            .conversations
            .len(),
        1
    );
    let child = &set.tasks[0];
    assert!(matches!(
        fixture.service.send_agent_conversation_message(
            child.conversation_id,
            SendAgentConversationMessageRequest {
                request_id: Uuid::new_v4(),
                body: "Bypass the work-set queue.".into()
            }
        ),
        Err(LocalWtsError::AgentConversationConflict)
    ));
    assert!(matches!(
        fixture.service.cancel_agent_work_item(
            set.work_set_id,
            child.task_id,
            wts_app::AgentWorkItemCancelRequest {
                request_id: Uuid::new_v4(),
                expected_revision: set.revision
            }
        ),
        Err(LocalWtsError::AgentConversationConflict)
    ));
    let reopened = fixture.open();
    assert_eq!(reopened.get_agent_work_set(set.work_set_id).unwrap(), set);
    assert_eq!(
        reopened
            .create_agent_work_set(fixture.conversation.conversation_id, origin, request)
            .unwrap(),
        set
    );
    assert_eq!(
        reopened
            .list_agent_work_sets(fixture.conversation.conversation_id, origin)
            .unwrap()
            .work_sets
            .len(),
        1
    );
}

#[test]
fn child_prompt_includes_exact_origin_turn_without_later_parent_messages() {
    let fixture = Fixture::new(false);
    let origin = fixture.run();
    let original_script = fs::read(&fixture.executable).unwrap();
    fs::write(
        &fixture.executable,
        r#"#!/bin/sh
set -eu
final=
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; final=$1; fi
 shift
done
printf '%s' 'UNRELATED_LATER_REPLY_DO_NOT_INCLUDE' > "$final"
printf '%s\n' '{"type":"turn.completed"}'
"#,
    )
    .unwrap();
    fixture.run_body("UNRELATED_LATER_REQUEST_DO_NOT_INCLUDE");
    fs::write(&fixture.executable, original_script).unwrap();
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, origin)
        .unwrap();
    let set = fixture
        .service
        .create_agent_work_set(
            fixture.conversation.conversation_id,
            origin,
            CreateAgentWorkSetRequest {
                request_id: Uuid::new_v4(),
                expected_after_checkpoint_id: receipt.after.unwrap().checkpoint_id,
                kind: AgentWorkSetKind::Alternatives,
                tasks: vec![task("Compact version", vec![])],
            },
        )
        .unwrap();
    let set = wait_set(&fixture.service, set.work_set_id);
    let child = &set.tasks[0];
    assert_eq!(child.state, AgentWorkItemState::Completed, "{set:?}");
    let changes = fixture
        .service
        .get_agent_turn_changes(child.conversation_id, child.request_id)
        .unwrap();
    let store = fixture.directory.path().join("data/agent-conversations-v1");
    let context_path = store.join(format!(
        "{}-{}.context.json",
        child.conversation_id, child.request_id
    ));
    let prompt = fs::read_to_string(store.join(format!(
        "{}-{}.final.txt.argv",
        child.conversation_id, changes.session_id
    )))
    .unwrap();
    assert!(prompt.contains(context_path.to_str().unwrap()));
    let context = fs::read_to_string(context_path).unwrap();
    let context_value: serde_json::Value = serde_json::from_str(&context).unwrap();
    let origin_context = &context_value["source"]["origin"];
    assert_eq!(
        origin_context["conversationId"],
        fixture.conversation.conversation_id.to_string()
    );
    assert_eq!(origin_context["requestId"], origin.to_string());
    assert_eq!(origin_context["sessionId"], receipt.session_id.to_string());
    let artifact_path = Path::new(origin_context["resultArtifactPath"].as_str().unwrap());
    assert!(
        artifact_path.canonicalize().unwrap().starts_with(
            store
                .join("work-sets")
                .join(set.work_set_id.to_string())
                .canonicalize()
                .unwrap()
        )
    );
    assert_eq!(
        fs::metadata(artifact_path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let artifact = fs::read_to_string(artifact_path).unwrap();
    let artifact_value: serde_json::Value = serde_json::from_str(&artifact).unwrap();
    assert_eq!(
        artifact_value["conversationId"],
        origin_context["conversationId"]
    );
    assert_eq!(artifact_value["requestId"], origin_context["requestId"]);
    assert_eq!(artifact_value["sessionId"], origin_context["sessionId"]);
    let messages = artifact_value["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["body"], "Change the fixture files.");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["body"], "Done with task 1.");
    for message in messages {
        assert_eq!(message["requestId"], origin.to_string());
        assert_eq!(message["sessionId"], receipt.session_id.to_string());
        assert!(message.get("submittedBody").is_none());
    }
    for text in [&prompt, &context, &artifact] {
        assert!(!text.contains("UNRELATED_LATER_"));
    }
}

#[test]
fn dependencies_use_finished_input_and_reject_cycles_before_creating_children() {
    let fixture = Fixture::new(false);
    let origin = fixture.run();
    let receipt = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, origin)
        .unwrap();
    let first = task("First", vec![]);
    let second = task("Second", vec![first.task_id]);
    let set = fixture
        .service
        .create_agent_work_set(
            fixture.conversation.conversation_id,
            origin,
            CreateAgentWorkSetRequest {
                request_id: Uuid::new_v4(),
                expected_after_checkpoint_id: receipt.after.unwrap().checkpoint_id,
                kind: AgentWorkSetKind::Tasks,
                tasks: vec![first, second],
            },
        )
        .unwrap();
    let set = wait_set(&fixture.service, set.work_set_id);
    assert!(
        set.tasks
            .iter()
            .all(|task| task.state == AgentWorkItemState::Completed),
        "{set:?}"
    );
    let first_result = fixture
        .service
        .get_agent_turn_changes(set.tasks[0].conversation_id, set.tasks[0].request_id)
        .unwrap();
    let second_result = fixture
        .service
        .get_agent_turn_changes(set.tasks[1].conversation_id, set.tasks[1].request_id)
        .unwrap();
    assert_eq!(
        first_result.after.unwrap().tree_sha256,
        second_result.before.unwrap().tree_sha256
    );
    let artifact = fixture
        .directory
        .path()
        .join("data/agent-conversations-v1")
        .join(format!(
            "{}-{}.context.json",
            set.tasks[1].conversation_id, set.tasks[1].request_id
        ));
    let source: serde_json::Value = serde_json::from_slice(&fs::read(artifact).unwrap()).unwrap();
    assert_eq!(
        source["source"]["originalSource"]["calloutId"],
        "receipt.fixture"
    );
    assert_eq!(
        source["source"]["dependencies"][0]["taskId"],
        set.tasks[0].task_id.to_string()
    );
}

#[test]
fn renderer_cannot_create_host_work_item_source() {
    let fixture = Fixture::new(false);
    let result = fixture
        .service
        .create_agent_conversation(CreateAgentConversationRequest {
            request_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            source: AgentConversationSource::WorkItem {
                work_set_id: Uuid::new_v4(),
                task_id: Uuid::new_v4(),
                label: "Forged".into(),
                origin_conversation_id: fixture.conversation.conversation_id,
                origin_request_id: Uuid::new_v4(),
            },
        });
    assert!(matches!(
        result,
        Err(LocalWtsError::InvalidAgentConversation)
    ));
    assert_eq!(
        fixture
            .service
            .list_agent_conversations()
            .unwrap()
            .conversations
            .len(),
        1
    );
}

#[test]
fn global_child_limit_cancel_and_reopen_keep_one_durable_dispatch_per_item() {
    let fixture = Fixture::new(false);
    let origin = fixture.run();
    let checkpoint = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, origin)
        .unwrap()
        .after
        .unwrap()
        .checkpoint_id;
    let control = fixture.directory.path().join("control");
    fs::create_dir(&control).unwrap();
    let release = control.join("release");
    let _release = Release(release.clone());
    let script = format!(
        r#"#!/bin/sh
set -eu
final=
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; final=$1; fi
 shift
done
printf '%s\n' "$PWD" >> '{}/starts'
for number in $(seq 1 600); do
 if [ -f '{}/release' ]; then break; fi
 sleep 0.05
done
printf 'child completed\n' > tracked.txt
printf 'Completed the child.' > "$final"
printf '%s\n' '{{"type":"turn.completed"}}'
"#,
        control.display(),
        control.display()
    );
    fs::write(&fixture.executable, script).unwrap();
    let first = task("First", vec![]);
    let dependent = task("Dependent", vec![first.task_id]);
    let tasks = vec![
        first,
        task("Second", vec![]),
        task("Third", vec![]),
        dependent,
        task("Fifth", vec![]),
    ];
    let set = fixture
        .service
        .create_agent_work_set(
            fixture.conversation.conversation_id,
            origin,
            CreateAgentWorkSetRequest {
                request_id: Uuid::new_v4(),
                expected_after_checkpoint_id: checkpoint,
                kind: AgentWorkSetKind::Tasks,
                tasks,
            },
        )
        .unwrap();
    let another = fixture
        .service
        .create_agent_work_set(
            fixture.conversation.conversation_id,
            origin,
            CreateAgentWorkSetRequest {
                request_id: Uuid::new_v4(),
                expected_after_checkpoint_id: checkpoint,
                kind: AgentWorkSetKind::Alternatives,
                tasks: vec![task("Other A", vec![]), task("Other B", vec![])],
            },
        )
        .unwrap();
    wait_until(|| starts(&control) == 3);
    thread::sleep(Duration::from_millis(500));
    assert_eq!(
        starts(&control),
        3,
        "More than three children started across sets"
    );
    let reopened = fixture.open();
    thread::sleep(Duration::from_millis(500));
    assert_eq!(starts(&control), 3, "Reopen repeated a dispatch");
    let current = fixture.service.get_agent_work_set(set.work_set_id).unwrap();
    let pending = current
        .tasks
        .iter()
        .find(|task| task.state == AgentWorkItemState::Pending)
        .unwrap();
    let cancel = wts_app::AgentWorkItemCancelRequest {
        request_id: Uuid::new_v4(),
        expected_revision: current.revision,
    };
    let cancelled = fixture
        .service
        .cancel_agent_work_item(set.work_set_id, pending.task_id, cancel.clone())
        .unwrap();
    assert_eq!(cancelled.last_mutation_request_id, Some(cancel.request_id));
    assert_eq!(
        reopened
            .cancel_agent_work_item(set.work_set_id, pending.task_id, cancel)
            .unwrap(),
        cancelled
    );
    let current = fixture.service.get_agent_work_set(set.work_set_id).unwrap();
    if let Some(running) = current
        .tasks
        .iter()
        .find(|task| task.state == AgentWorkItemState::Running)
    {
        fixture
            .service
            .cancel_agent_work_item(
                set.work_set_id,
                running.task_id,
                wts_app::AgentWorkItemCancelRequest {
                    request_id: Uuid::new_v4(),
                    expected_revision: current.revision,
                },
            )
            .unwrap();
    }
    fs::write(&release, "").unwrap();
    let final_set = wait_set(&reopened, set.work_set_id);
    let other = wait_set(&reopened, another.work_set_id);
    assert!(
        final_set
            .tasks
            .iter()
            .any(|task| task.state == AgentWorkItemState::Cancelled)
    );
    assert!(
        other
            .tasks
            .iter()
            .all(|task| task.state == AgentWorkItemState::Completed)
    );
    let journal = fs::read_to_string(control.join("starts")).unwrap();
    let entries = journal.lines().collect::<Vec<_>>();
    assert_eq!(
        entries.len(),
        entries
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        "A child was dispatched twice"
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("tracked.txt")).unwrap(),
        "task result 1\n"
    );
}

#[test]
fn invalid_graph_and_changed_checkpoint_create_no_children() {
    let fixture = Fixture::new(false);
    let origin = fixture.run();
    let checkpoint = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, origin)
        .unwrap()
        .after
        .unwrap()
        .checkpoint_id;
    let mut first = task("First", vec![]);
    let second = task("Second", vec![first.task_id]);
    first.depends_on.push(second.task_id);
    let request = CreateAgentWorkSetRequest {
        request_id: Uuid::new_v4(),
        expected_after_checkpoint_id: checkpoint,
        kind: AgentWorkSetKind::Tasks,
        tasks: vec![first, second],
    };
    let count = fixture.service.list_workspaces().unwrap().workspaces.len();
    assert!(matches!(
        fixture.service.create_agent_work_set(
            fixture.conversation.conversation_id,
            origin,
            request
        ),
        Err(LocalWtsError::InvalidAgentConversation)
    ));
    fs::write(fixture.target.join("later.txt"), "later private edit").unwrap();
    assert!(matches!(
        fixture.service.create_agent_work_set(
            fixture.conversation.conversation_id,
            origin,
            CreateAgentWorkSetRequest {
                request_id: Uuid::new_v4(),
                expected_after_checkpoint_id: checkpoint,
                kind: AgentWorkSetKind::Tasks,
                tasks: vec![task("One", vec![])]
            }
        ),
        Err(LocalWtsError::AgentConversationConflict)
    ));
    assert_eq!(
        fixture.service.list_workspaces().unwrap().workspaces.len(),
        count
    );
    assert!(
        fixture
            .service
            .list_agent_work_sets(fixture.conversation.conversation_id, origin)
            .unwrap()
            .work_sets
            .is_empty()
    );
}

#[test]
fn failed_prerequisite_blocks_only_its_dependents_and_keeps_partial_files() {
    let fixture = Fixture::new(false);
    let origin = fixture.run();
    let checkpoint = fixture
        .service
        .get_agent_turn_changes(fixture.conversation.conversation_id, origin)
        .unwrap()
        .after
        .unwrap()
        .checkpoint_id;
    fs::write(&fixture.executable,r#"#!/bin/sh
set -eu
final=
last=
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; final=$1; fi
 last=$1
 shift
done
case "$last" in
 *'Implement Fail task.'*) printf 'partial work\n' > failed.txt; printf 'Provider failed after an edit.' >&2; exit 7;;
esac
printf 'independent work\n' > independent.txt
printf 'Completed independently.' > "$final"
printf '%s\n' '{"type":"turn.completed"}'
"#).unwrap();
    let failed = task("Fail task", vec![]);
    let dependent = task("Dependent", vec![failed.task_id]);
    let set = fixture
        .service
        .create_agent_work_set(
            fixture.conversation.conversation_id,
            origin,
            CreateAgentWorkSetRequest {
                request_id: Uuid::new_v4(),
                expected_after_checkpoint_id: checkpoint,
                kind: AgentWorkSetKind::Tasks,
                tasks: vec![failed, dependent, task("Independent", vec![])],
            },
        )
        .unwrap();
    let set = wait_set(&fixture.service, set.work_set_id);
    assert_eq!(set.tasks[0].state, AgentWorkItemState::Failed);
    assert_eq!(set.tasks[1].state, AgentWorkItemState::Blocked);
    assert!(set.tasks[1].workspace_id.is_none());
    assert_eq!(set.tasks[2].state, AgentWorkItemState::Completed);
    let receipt = fixture
        .service
        .get_agent_turn_changes(set.tasks[0].conversation_id, set.tasks[0].request_id)
        .unwrap();
    assert!(receipt.patch.contains("+partial work"));
    assert!(!fixture.target.join("failed.txt").exists());
    assert!(!fixture.target.join("independent.txt").exists());
}

struct Release(PathBuf);
impl Drop for Release {
    fn drop(&mut self) {
        let _ = fs::write(&self.0, "");
    }
}
fn starts(control: &Path) -> usize {
    fs::read_to_string(control.join("starts"))
        .unwrap_or_default()
        .lines()
        .count()
}
fn wait_until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !predicate() {
        assert!(
            Instant::now() < deadline,
            "The fake process did not reach the gate"
        );
        thread::sleep(Duration::from_millis(40));
    }
}

fn task(title: &str, depends_on: Vec<Uuid>) -> AgentWorkItemRequest {
    AgentWorkItemRequest {
        task_id: Uuid::new_v4(),
        title: title.into(),
        prompt: format!("Implement {title}."),
        depends_on,
    }
}
fn wait_set(service: &LocalWtsService, id: Uuid) -> wts_app::AgentWorkSet {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let set = service.get_agent_work_set(id).unwrap();
        if set.tasks.iter().all(|task| {
            matches!(
                task.state,
                AgentWorkItemState::Completed
                    | AgentWorkItemState::Failed
                    | AgentWorkItemState::Blocked
                    | AgentWorkItemState::Cancelled
            )
        }) {
            return set;
        }
        assert!(Instant::now() < deadline, "{set:?}");
        thread::sleep(Duration::from_millis(40));
    }
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
        fs::write(source.join("icon.png"), b"\x89PNG\r\n\x1a\n\0retained icon").unwrap();
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
prompt=
while [ "$#" -gt 0 ]; do
 if [ "$1" = '--output-last-message' ]; then shift; final=$1; fi
 prompt=$1
 shift
done
printf '%s' "$prompt" > "$final.argv"
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
        fs::write(
            target.join("dirty-icon.png"),
            b"\x89PNG\r\n\x1a\n\0dirty icon",
        )
        .unwrap();
        fs::create_dir_all(target.join("nested/draft")).unwrap();
        fs::write(target.join("nested/draft/private.txt"), "nested draft\n").unwrap();
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
        self.run_body("Change the fixture files.")
    }
    fn run_body(&self, body: &str) -> Uuid {
        let request_id = Uuid::new_v4();
        self.service
            .send_agent_conversation_message(
                self.conversation.conversation_id,
                SendAgentConversationMessageRequest {
                    request_id,
                    body: body.to_owned(),
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
