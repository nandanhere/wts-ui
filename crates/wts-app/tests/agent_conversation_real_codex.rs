#![cfg(unix)]

//! These tests start the installed Codex with the user's configured account and model.
//! They write only to temporary repositories through the public conversation API.
//! Run it explicitly with both environment variables:
//! WTS_RUN_REAL_CODEX_SMOKE=1 WTS_REAL_CODEX_EXECUTABLE=/absolute/path/to/codex
//! cargo test -p wts-app --test agent_conversation_real_codex -- --ignored --nocapture --test-threads=1
//! The queue case reopens the service. It does not simulate a host process crash.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationMessageRole, AgentConversationMessageStatus,
    AgentConversationSource, AgentProvider, CancelAgentConversationMessageRequest,
    ChangeRequestDraftTarget, CreateAgentConversationRequest, ExternalLauncher, JiraIssueTarget,
    LaunchFailure, LocalWtsService, ProcessWorkspaceAdapter, RepositoryBaseTarget,
    SendAgentConversationMessageRequest, TerminalProvider,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

#[test]
#[ignore = "Requires an explicit installed-Codex path and starts a real provider task."]
fn installed_codex_completes_a_temporary_conversation_with_full_final_output() {
    let fixture = RealProviderFixture::new(&[]);
    let service = &fixture.service;
    let repository = &fixture.repository;
    let target = &fixture.target;
    let conversation = service
        .create_agent_conversation(CreateAgentConversationRequest {
            request_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            source: AgentConversationSource::Ui {
                route: "/isolated-provider-smoke".to_owned(),
                callout_id: "smoke.temporary".to_owned(),
                label: "Temporary provider test".to_owned(),
                selected_text: None,
                context: None,
                capture: None,
            },
        })
        .unwrap();
    assert_eq!(conversation.workspace_id, fixture.workspace_id);
    assert_eq!(conversation.repository_id, fixture.repository_id);
    let _cleanup = StopOwnedConversation {
        service,
        id: conversation.conversation_id,
    };
    let nonce = Uuid::new_v4();
    let file_contents = format!("WTS_REAL_FILE_{nonce}\n");
    let final_start = format!("WTS_REAL_FINAL_START_{nonce}");
    let final_end = format!("WTS_REAL_FINAL_END_{nonce}");
    let expected_reply = format!(
        "{final_start}\n{}{final_end}",
        "WTS preserves the full final response from this temporary provider test.\n".repeat(20),
    );
    let request_id = Uuid::new_v4();
    service.send_agent_conversation_message(
        conversation.conversation_id,
        SendAgentConversationMessageRequest {
            request_id,
            body: format!(
                "This is an isolated transport smoke test. Read AGENTS.md. Create smoke-result.txt with exactly this content: {file_contents:?}. Preserve all other files, including user-draft.txt. Read the file to check it. Do not run a build or start another agent. Then finish the turn. Your final answer must contain this complete block, with both markers and all twenty repeated lines. Do not put this block in a progress update:\n\n{expected_reply}"
            ),
        },
    ).unwrap();
    let started = Instant::now();
    let completed = loop {
        let current = service
            .get_agent_conversation(conversation.conversation_id)
            .unwrap();
        let user = current
            .messages
            .iter()
            .find(|message| {
                message.role == AgentConversationMessageRole::User
                    && message.request_id == Some(request_id)
            })
            .unwrap();
        if matches!(
            user.status,
            AgentConversationMessageStatus::Completed
                | AgentConversationMessageStatus::Failed
                | AgentConversationMessageStatus::Interrupted
        ) {
            break current;
        }
        assert!(
            started.elapsed() < Duration::from_secs(180),
            "The real provider did not finish this small task within three minutes. The test stops only its temporary session."
        );
        thread::sleep(Duration::from_millis(50));
    };
    let final_message = completed
        .messages
        .iter()
        .find(|message| {
            message.role == AgentConversationMessageRole::Assistant
                && message.request_id == Some(request_id)
        })
        .expect("The completed request needs its paired assistant result.");
    assert_eq!(
        final_message.status,
        AgentConversationMessageStatus::Completed,
        "The real provider failed. Inspect the adapter failure and provider setup. The retained answer has {} characters. Diagnostic: {:?}",
        final_message.body.chars().count(),
        final_message.error
    );
    assert_eq!(
        completed
            .messages
            .iter()
            .find(|message| message.role == AgentConversationMessageRole::User
                && message.request_id == Some(request_id))
            .unwrap()
            .status,
        AgentConversationMessageStatus::Completed,
        "The paired user request must also be complete."
    );
    assert!(completed.active_session_id.is_none());
    assert_eq!(
        fs::read_to_string(target.join("smoke-result.txt")).unwrap(),
        file_contents
    );
    assert_eq!(
        fs::read_to_string(target.join("user-draft.txt")).unwrap(),
        "Preserve this existing draft.\n"
    );
    assert!(!repository.join("smoke-result.txt").exists());
    assert!(
        final_message.body.contains(&final_start),
        "The final response lost its start marker."
    );
    assert!(
        final_message.body.contains(&final_end),
        "The final response lost its end marker."
    );
    assert!(
        final_message.body.chars().count() > 800,
        "The final response was reduced to a progress summary."
    );
    eprintln!(
        "Real Codex smoke passed in {:.1}s: file effect, retained draft, and {} final-response characters.",
        started.elapsed().as_secs_f64(),
        final_message.body.chars().count()
    );
}

const QUEUED_SOURCE: &str = "def normalize_key(value):\n    return value\n\ndef capture_once(receipts, key, create):\n    return create()\n\ndef capture_batch(requests, create):\n    return [capture_once({}, key, create) for key in requests]\n";

const QUEUED_TESTS: &str = r#"import unittest
from checkout import normalize_key, capture_once, capture_batch

class CheckoutTests(unittest.TestCase):
    def test_normalize_key(self):
        self.assertEqual(normalize_key("  EXAMPLE-Key  "), "example-key")
        self.assertEqual(normalize_key("  "), "")

    def test_capture_once(self):
        receipts = {}
        calls = []
        def create():
            calls.append(len(calls) + 1)
            return {"receipt": calls[-1]}
        first = capture_once(receipts, "EXAMPLE-Key", create)
        second = capture_once(receipts, " example-key ", create)
        self.assertIs(first, second)
        self.assertEqual(calls, [1])
        self.assertIs(receipts["example-key"], first)

    def test_capture_batch(self):
        calls = []
        def create():
            calls.append(len(calls) + 1)
            return {"receipt": calls[-1]}
        results = capture_batch([" Alpha ", "alpha", "BETA", " beta "], create)
        self.assertIs(results[0], results[1])
        self.assertIs(results[2], results[3])
        self.assertIsNot(results[0], results[2])
        self.assertEqual(calls, [1, 2])

if __name__ == "__main__":
    unittest.main()
"#;

#[test]
#[ignore = "Requires an explicit installed-Codex path and starts three real queued provider tasks."]
fn installed_codex_completes_three_dependent_queued_fixes_after_service_reopen() {
    let fixture = RealProviderFixture::new(&[
        ("checkout.py", QUEUED_SOURCE),
        ("test_checkout.py", QUEUED_TESTS),
    ]);
    let before = python_tests(&fixture.target);
    assert!(
        !before.status.success(),
        "The fixture must contain three bugs."
    );
    assert!(String::from_utf8_lossy(&before.stderr).contains("failures=3"));
    eprintln!("The unmodified Python fixture has three failing behavior tests.");

    let conversation = fixture
        .service
        .create_agent_conversation(CreateAgentConversationRequest {
            request_id: Uuid::new_v4(),
            provider: AgentProvider::Codex,
            source: AgentConversationSource::Ui {
                route: "/isolated-queued-provider-smoke".to_owned(),
                callout_id: "smoke.queue".to_owned(),
                label: "Temporary queued fixes".to_owned(),
                selected_text: None,
                context: None,
                capture: None,
            },
        })
        .unwrap();
    assert_eq!(conversation.workspace_id, fixture.workspace_id);
    assert_eq!(conversation.repository_id, fixture.repository_id);
    let _cleanup = StopOwnedConversation {
        service: &fixture.service,
        id: conversation.conversation_id,
    };
    let tasks = [
        "Fix only normalize_key in checkout.py. It must strip surrounding whitespace and convert the key to lowercase. Run test_checkout.CheckoutTests.test_normalize_key. Leave capture_once and capture_batch unchanged.",
        "Fix only capture_once in checkout.py. Use normalize_key from the preceding fix. Reuse the existing receipt for a normalized key, or call create once and store its result under that key. Run the normalize_key and capture_once tests. Leave capture_batch unchanged.",
        "Fix only capture_batch in checkout.py. Share one receipts dictionary across the whole batch. Use capture_once from the preceding fix, so repeated normalized keys reuse one receipt. Run all three test_checkout tests.",
    ];
    let markers: Vec<_> = (1..=3)
        .map(|index| format!("WTS_QUEUED_FIX_{index}_{}", Uuid::new_v4()))
        .collect();
    let requests: Vec<_> = tasks
        .iter()
        .zip(&markers)
        .map(|(task, marker)| SendAgentConversationMessageRequest {
            request_id: Uuid::new_v4(),
            body: format!(
                "Read AGENTS.md and the current files. {task} Use Python's standard library: PYTHONDONTWRITEBYTECODE=1 python3 -m unittest <test names>. Preserve test_checkout.py and user-draft.txt exactly. Do not install packages, start another agent, commit, push, or publish. Finish with a final answer that explains the change and the actual test result. Include this exact completion marker in the final answer: {marker}"
            ),
        })
        .collect();
    let started = Instant::now();
    for request in &requests {
        fixture
            .service
            .send_agent_conversation_message(conversation.conversation_id, request.clone())
            .unwrap();
    }
    let accepted = fixture
        .service
        .get_agent_conversation(conversation.conversation_id)
        .unwrap();
    assert!(
        accepted
            .messages
            .iter()
            .filter(|message| message.role == AgentConversationMessageRole::User
                && message.status == AgentConversationMessageStatus::Queued)
            .count()
            >= 2,
        "The requests must reach the queue before the first provider finishes."
    );
    let sequences: Vec<_> = requests
        .iter()
        .map(|request| {
            accepted
                .messages
                .iter()
                .find(|message| {
                    message.role == AgentConversationMessageRole::User
                        && message.request_id == Some(request.request_id)
                })
                .unwrap()
                .queue_sequence
                .expect("Each user request needs a durable queue sequence.")
        })
        .collect();
    assert!(sequences.windows(2).all(|pair| pair[0] < pair[1]));

    // A new service reads the same store while the original worker remains active.
    // This checks reload and duplicate submission. It does not simulate a host crash.
    let reopened = fixture.reopen();
    let replayed = reopened
        .send_agent_conversation_message(conversation.conversation_id, requests[1].clone())
        .unwrap();
    assert_eq!(
        replayed
            .messages
            .iter()
            .filter(|message| message.role == AgentConversationMessageRole::User)
            .count(),
        3,
        "An exact submission retry must not add a fourth task."
    );
    let mut last_state = String::new();
    let completed = loop {
        let current = reopened
            .get_agent_conversation(conversation.conversation_id)
            .unwrap();
        let users: Vec<_> = requests
            .iter()
            .map(|request| {
                current
                    .messages
                    .iter()
                    .find(|message| {
                        message.role == AgentConversationMessageRole::User
                            && message.request_id == Some(request.request_id)
                    })
                    .unwrap()
            })
            .collect();
        let state = format!(
            "{:?}",
            users
                .iter()
                .map(|message| message.status)
                .collect::<Vec<_>>()
        );
        if state != last_state {
            eprintln!(
                "Real queue at {:.1}s: {state}; owned session {:?}.",
                started.elapsed().as_secs_f64(),
                current.active_session_id
            );
            last_state = state;
        }
        if users.iter().all(|message| {
            matches!(
                message.status,
                AgentConversationMessageStatus::Completed
                    | AgentConversationMessageStatus::Failed
                    | AgentConversationMessageStatus::Interrupted
            )
        }) {
            break current;
        }
        assert!(
            started.elapsed() < Duration::from_secs(540),
            "The three small provider tasks did not finish within nine minutes. The test stops only its temporary session."
        );
        thread::sleep(Duration::from_millis(50));
    };
    assert!(completed.active_session_id.is_none());
    assert_eq!(completed.messages.len(), 6);
    let mut preceding_messages = Vec::new();
    for (index, request) in requests.iter().enumerate() {
        let user = paired_message(
            &completed,
            request.request_id,
            AgentConversationMessageRole::User,
        );
        let assistant = paired_message(
            &completed,
            request.request_id,
            AgentConversationMessageRole::Assistant,
        );
        assert_eq!(
            user.status,
            AgentConversationMessageStatus::Completed,
            "Queue task {} failed: {:?}",
            index + 1,
            assistant.error
        );
        assert_eq!(assistant.status, AgentConversationMessageStatus::Completed);
        assert_eq!(user.queue_sequence, Some(sequences[index]));
        assert!(
            assistant.body.contains(&markers[index]),
            "Queue task {} lost its final marker.",
            index + 1
        );
        let final_path = fixture
            .directory
            .path()
            .join("data/agent-conversations-v1")
            .join(format!(
                "{}-{}.final.txt",
                conversation.conversation_id,
                assistant.session_id.unwrap()
            ));
        let full_final = fs::read_to_string(final_path).unwrap();
        assert_eq!(
            assistant.body,
            full_final.trim(),
            "The final response must retain the complete provider artifact."
        );
        let context_path = fixture
            .directory
            .path()
            .join("data/agent-conversations-v1")
            .join(format!(
                "{}-{}.context.json",
                conversation.conversation_id, request.request_id
            ));
        let context: serde_json::Value =
            serde_json::from_slice(&fs::read(context_path).unwrap()).unwrap();
        preceding_messages.push(request.body.clone());
        let context_bodies: Vec<_> = context["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["body"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(
            context_bodies, preceding_messages,
            "Task context must include complete earlier replies and omit future queued requests."
        );
        preceding_messages.push(assistant.body.clone());
        eprintln!(
            "Real queue task {} completed with {} final-response characters.",
            index + 1,
            assistant.body.chars().count()
        );
    }

    let after = python_tests(&fixture.target);
    assert!(
        after.status.success(),
        "The real queued fixes failed their behavior tests: {}",
        String::from_utf8_lossy(&after.stderr)
    );
    assert!(String::from_utf8_lossy(&after.stderr).contains("Ran 3 tests"));
    assert_eq!(
        fs::read_to_string(fixture.target.join("test_checkout.py")).unwrap(),
        QUEUED_TESTS
    );
    assert_eq!(
        fs::read_to_string(fixture.target.join("user-draft.txt")).unwrap(),
        "Preserve this existing draft.\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.repository.join("checkout.py")).unwrap(),
        QUEUED_SOURCE
    );
    assert_eq!(
        git(&fixture.target, &["rev-parse", "HEAD"]),
        git(&fixture.repository, &["rev-parse", "HEAD"]),
        "The agent must not commit the temporary fixes."
    );
    let final_reopen = fixture
        .reopen()
        .get_agent_conversation(conversation.conversation_id)
        .unwrap();
    assert_eq!(
        serde_json::to_value(&final_reopen.messages).unwrap(),
        serde_json::to_value(&completed.messages).unwrap()
    );
    eprintln!(
        "Real queued Codex smoke passed in {:.1}s: three failing Python tests now pass, FIFO context and full final replies survive service reopen, duplicate retry adds no task, and the draft and base checkout remain unchanged.",
        started.elapsed().as_secs_f64()
    );
}

fn paired_message(
    conversation: &AgentConversation,
    request_id: Uuid,
    role: AgentConversationMessageRole,
) -> &wts_app::AgentConversationMessage {
    conversation
        .messages
        .iter()
        .find(|message| message.role == role && message.request_id == Some(request_id))
        .expect("The request needs its paired user and assistant messages.")
}

fn python_tests(repository: &Path) -> std::process::Output {
    Command::new("python3")
        .args(["-m", "unittest", "-v", "test_checkout"])
        .current_dir(repository)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .expect("The queued provider fixture needs Python 3.")
}

struct RealProviderFixture {
    service: LocalWtsService,
    directory: tempfile::TempDir,
    repositories: PathBuf,
    repository: PathBuf,
    target: PathBuf,
    executable: PathBuf,
    workspace_id: Uuid,
    repository_id: String,
}

impl RealProviderFixture {
    fn new(extra_files: &[(&str, &str)]) -> Self {
        assert_eq!(
            std::env::var("WTS_RUN_REAL_CODEX_SMOKE").as_deref(),
            Ok("1"),
            "Set WTS_RUN_REAL_CODEX_SMOKE=1 to start this real provider test."
        );
        let executable = PathBuf::from(
            std::env::var_os("WTS_REAL_CODEX_EXECUTABLE")
                .expect("Set WTS_REAL_CODEX_EXECUTABLE to the installed Codex binary."),
        );
        assert!(
            executable.is_absolute() && executable.is_file(),
            "WTS_REAL_CODEX_EXECUTABLE must name an existing absolute file."
        );
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let repository = repositories.join("smoke");
        fs::create_dir_all(&repository).unwrap();
        git(&repository, &["init", "--initial-branch=main"]);
        git(&repository, &["config", "user.name", "WTS Smoke"]);
        git(
            &repository,
            &["config", "user.email", "wts@example.invalid"],
        );
        fs::write(
            repository.join("README.md"),
            "Temporary WTS provider test.\n",
        )
        .unwrap();
        fs::write(
        repository.join("AGENTS.md"),
        "This is an isolated WTS provider test. Work only in this repository.\nDo not commit, push, publish, or contact another application.\nDo not start another agent. No package install or build is required.\n",
    )
    .unwrap();
        for (name, contents) in extra_files {
            fs::write(repository.join(name), contents).unwrap();
        }
        git(&repository, &["add", "."]);
        git(&repository, &["commit", "-m", "Temporary smoke fixture"]);
        let service = LocalWtsService::open_with_repository_roots_launcher_and_adapter(
            directory.path().join("data"),
            "test",
            directory.path().join("workspaces"),
            [repositories.clone()],
            NoExternalLaunch,
            ProcessWorkspaceAdapter::default()
                .with_agent_executable(AgentProvider::Codex, executable.clone()),
        )
        .unwrap();
        let workspace = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "Isolated provider smoke".to_owned(),
                    },
                    title: "Isolated provider smoke".to_owned(),
                    preferred_provider: WorkspaceProvider::Codex,
                    repositories: vec![WorkspaceRepositoryRequest {
                        repository_id: None,
                        label: "smoke".to_owned(),
                        base_ref: "main".to_owned(),
                    }],
                    runtime: None,
                    planning: None,
                },
            )
            .unwrap()
            .workspace;
        let preflight = service.preflight_workspace(workspace.workspace_id).unwrap();
        let receipt = service
            .materialize_workspace(workspace.workspace_id, &preflight.effect_digest)
            .unwrap();
        let worktree = &receipt.materialization.worktrees[0];
        let target = PathBuf::from(&worktree.target_display_path);
        assert!(
            target
                .canonicalize()
                .unwrap()
                .starts_with(directory.path().canonicalize().unwrap())
        );
        fs::write(
            target.join("user-draft.txt"),
            "Preserve this existing draft.\n",
        )
        .unwrap();
        service
            .configure_ui_development_repository(target.clone(), None)
            .unwrap();
        let repository_id = worktree.repository_id.clone();
        Self {
            service,
            directory,
            repositories,
            repository,
            target,
            executable,
            workspace_id: workspace.workspace_id,
            repository_id,
        }
    }

    fn reopen(&self) -> LocalWtsService {
        let service = LocalWtsService::open_with_repository_roots_launcher_and_adapter(
            self.directory.path().join("data"),
            "test",
            self.directory.path().join("workspaces"),
            [self.repositories.clone()],
            NoExternalLaunch,
            ProcessWorkspaceAdapter::default()
                .with_agent_executable(AgentProvider::Codex, self.executable.clone()),
        )
        .unwrap();
        service
            .configure_ui_development_repository(self.target.clone(), None)
            .unwrap();
        service
    }
}

struct StopOwnedConversation<'a> {
    service: &'a LocalWtsService,
    id: Uuid,
}

impl Drop for StopOwnedConversation<'_> {
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while let Ok(conversation) = self.service.get_agent_conversation(self.id) {
            for message in &conversation.messages {
                if message.status == AgentConversationMessageStatus::Queued {
                    let _ = self.service.cancel_agent_conversation_message(
                        self.id,
                        message.message_id,
                        CancelAgentConversationMessageRequest {
                            request_id: Uuid::new_v4(),
                            expected_body: message.body.clone(),
                        },
                    );
                }
            }
            let Some(session_id) = conversation.active_session_id else {
                break;
            };
            let _ = self.service.stop_agent_session(session_id);
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

fn git(repository: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
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
        "Fixture Git command failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

struct NoExternalLaunch;
impl ExternalLauncher for NoExternalLaunch {
    fn launch_vscode(&self, _: &Path) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
    fn launch_cli(
        &self,
        _: &Path,
        _: AgentProvider,
        _: TerminalProvider,
    ) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
    fn launch_repository_base(&self, _: &RepositoryBaseTarget) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
    fn launch_change_request_draft(
        &self,
        _: &ChangeRequestDraftTarget,
    ) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
    fn launch_jira_issue(&self, _: &JiraIssueTarget) -> Result<(), LaunchFailure> {
        panic!("Unexpected external launch")
    }
}
