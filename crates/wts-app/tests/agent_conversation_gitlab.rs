#![cfg(unix)]

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    AgentConversation, AgentConversationMessageRole, AgentConversationMessageStatus,
    AgentConversationSource, AgentProvider, CreateAgentConversationRequest, LocalWtsService,
    SendAgentConversationMessageRequest,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

struct Fixture {
    _directory: TempDir,
    service: LocalWtsService,
    workspace_id: Uuid,
    repository_id: String,
    worktree: PathBuf,
    base: String,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let repositories = directory.path().join("repositories");
        let source = repositories.join("api");
        fs::create_dir_all(&source).unwrap();
        git(&source, &["init", "--initial-branch=main"]);
        git(&source, &["config", "user.name", "WTS Test"]);
        git(&source, &["config", "user.email", "wts@example.invalid"]);
        git(&source, &["config", "commit.gpgSign", "false"]);
        fs::write(source.join("README.md"), "base\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        let base = git(&source, &["rev-parse", "HEAD"]);
        git(
            &source,
            &[
                "remote",
                "add",
                "origin",
                "https://gitlab.example.test/catalog/api.git",
            ],
        );
        git(
            &source,
            &[
                "remote",
                "add",
                "upstream",
                "https://gitlab.example.test/trusted/api.git",
            ],
        );
        git(
            &source,
            &["update-ref", "refs/remotes/upstream/main", "HEAD"],
        );
        git(&source, &["config", "branch.main.remote", "upstream"]);
        git(&source, &["config", "branch.main.merge", "refs/heads/main"]);
        let service = LocalWtsService::open(
            directory.path().join("data"),
            "test",
            directory.path().join("workspaces"),
            &repositories,
        )
        .unwrap();
        let workspace_id = service
            .create_workspace(
                &Uuid::new_v4().to_string(),
                CreateWorkspaceRequest {
                    intent: WorkspaceIntent::RepositorySet {
                        label: "MR working changes".to_owned(),
                    },
                    title: "MR working changes".to_owned(),
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
            .workspace
            .workspace_id;
        let preflight = service.preflight_workspace(workspace_id).unwrap();
        let materialized = service
            .materialize_workspace(workspace_id, &preflight.effect_digest)
            .unwrap();
        let worktree = &materialized.materialization.worktrees[0];
        Self {
            _directory: directory,
            service,
            workspace_id,
            repository_id: worktree.repository_id.clone(),
            worktree: PathBuf::from(&worktree.target_display_path),
            base,
        }
    }
}

fn git(repository: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[test]
fn gitlab_chat_rechecks_project_account_and_thread_before_agent_dispatch() {
    let directory = tempfile::tempdir().unwrap();
    let executable = directory.path().join("glab");
    fs::write(
        &executable,
        r#"#!/bin/sh
set -eu
root="$WTS_TEST_CHAT_GITLAB_ROOT"
printf '%s\n' "$4" >> "$root/endpoints"
case "$4" in
 /user) cat "$root/user.json" ;;
 /merge_requests\?*) cat "$root/reviews.json" ;;
 /projects/trusted%2Fapi/merge_requests/17/changes) cat "$root/mr.json" ;;
 /projects/trusted%2Fapi/merge_requests/17/discussions\?*) cat "$root/discussions.json" ;;
 *) exit 31 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    let codex = directory.path().join("codex");
    fs::write(
        &codex,
        "#!/bin/sh\npwd >> \"$WTS_TEST_CHAT_GITLAB_ROOT/agent-launches\"\nexit 99\n",
    )
    .unwrap();
    fs::set_permissions(&codex, fs::Permissions::from_mode(0o700)).unwrap();
    let mut paths = vec![directory.path().to_path_buf()];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "trusted_gitlab_chat_child", "--nocapture"])
        .env("WTS_TEST_CHAT_GITLAB_ROOT", directory.path())
        .env("PATH", std::env::join_paths(paths).unwrap())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fs::read_to_string(directory.path().join("agent-launches"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn trusted_gitlab_chat_child() {
    use sha2::{Digest, Sha256};
    let Some(root) = std::env::var_os("WTS_TEST_CHAT_GITLAB_ROOT").map(PathBuf::from) else {
        return;
    };
    let fixture = Fixture::new();
    let metadata = serde_json::json!({"id":77,"iid":17,"title":"Review","web_url":"https://gitlab.example.test/trusted/api/-/merge_requests/17","state":"opened","source_branch":"main","target_branch":"release","author":{"username":"another-author"},"updated_at":"2026-09-17T00:00:00Z","diff_refs":{"base_sha":fixture.base,"start_sha":fixture.base,"head_sha":fixture.base},"changes":[],"overflow":false});
    assert_ne!(
        git(&fixture.worktree, &["branch", "--show-current"]),
        "main"
    );
    fs::write(root.join("mr.json"), serde_json::to_vec(&metadata).unwrap()).unwrap();
    fs::write(root.join("user.json"), r#"{"id":1,"username":"alice"}"#).unwrap();
    fs::write(root.join("discussions.json"), r#"[{"id":"thread-1","notes":[{"id":91,"body":"Inspect the current retry path.","author":{"username":"bob"},"created_at":"2026-09-17T00:00:00Z","system":false}]}]"#).unwrap();
    // The inbox can retain a synthetic ID from before the project entered the catalog.
    git(
        &fixture.worktree,
        &["config", "branch.main.remote", "origin"],
    );
    let mut review = metadata.clone();
    review["reviewers"] = serde_json::json!([{"username":"alice"}]);
    fs::write(
        root.join("reviews.json"),
        serde_json::to_vec(&serde_json::json!([review])).unwrap(),
    )
    .unwrap();
    let inbox = fixture.service.gitlab_review_inbox().unwrap();
    assert!(
        inbox
            .reviews
            .iter()
            .any(|review| review.repository_id == "gitlab-review-77")
    );
    git(
        &fixture.worktree,
        &["config", "branch.main.remote", "upstream"],
    );
    let scope = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&serde_json::json!([
                "gitlab.example.test",
                "trusted/api",
                17,
                1
            ]))
            .unwrap()
        )
    );
    let source: AgentConversationSource = serde_json::from_value(serde_json::json!({"kind":"gitlabDiscussion","workspaceId":fixture.workspace_id,"repositoryId":fixture.repository_id,"providerRepositoryId":"gitlab-review-77","iid":17,"discussionId":"thread-1","scopeId":scope,"comments":[{"id":91,"body":"Inspect the current retry path.","authorLogin":"bob","createdAt":"2026-09-17T00:00:00Z"}]})).unwrap();
    let create = |source| {
        fixture
            .service
            .create_agent_conversation(CreateAgentConversationRequest {
                request_id: Uuid::new_v4(),
                provider: AgentProvider::Codex,
                source,
            })
    };
    let conversation = create(source.clone()).unwrap();
    assert_eq!(conversation.workspace_id, fixture.workspace_id);
    assert_eq!(conversation.repository_id, fixture.repository_id);
    assert_eq!(conversation.source, source);
    let mut unscoped_source = serde_json::to_value(&source).unwrap();
    unscoped_source.as_object_mut().unwrap().remove("scopeId");
    let unscoped = create(serde_json::from_value(unscoped_source).unwrap()).unwrap();
    let binding_path = fixture
        ._directory
        .path()
        .join("data/agent-conversations-v1")
        .join(format!("{}.review-binding", unscoped.conversation_id));
    let binding: serde_json::Value =
        serde_json::from_slice(&fs::read(&binding_path).unwrap()).unwrap();
    assert_eq!(binding["scopeId"], scope);
    assert_eq!(binding["host"], "gitlab.example.test");
    assert_eq!(binding["projectPath"], "trusted/api");
    assert_eq!(
        fs::metadata(binding_path).unwrap().permissions().mode() & 0o777,
        0o600
    );

    for (field, value) in [
        ("discussionId", serde_json::json!("another-thread")),
        ("scopeId", serde_json::json!("f".repeat(64))),
        ("providerRepositoryId", serde_json::json!("another-project")),
    ] {
        let mut untrusted = serde_json::to_value(&source).unwrap();
        untrusted[field] = value;
        assert!(
            create(serde_json::from_value(untrusted).unwrap()).is_err(),
            "reject a mismatched {field}"
        );
    }
    fs::write(root.join("user.json"), r#"{"id":2,"username":"alice"}"#).unwrap();
    for (conversation_id, body) in [
        (conversation.conversation_id, "Implement the fix."),
        (unscoped.conversation_id, "Use the original account."),
    ] {
        let request = SendAgentConversationMessageRequest {
            request_id: Uuid::new_v4(),
            body: body.to_owned(),
        };
        assert_rejected_before_dispatch(&fixture.service, conversation_id, request);
    }
    let endpoints = fs::read_to_string(root.join("endpoints")).unwrap();
    assert!(!endpoints.contains("catalog%2Fapi"));
    assert!(endpoints.contains("/projects/trusted%2Fapi/merge_requests/17/discussions?"));
    assert!(!root.join("agent-launches").exists());
    fs::write(root.join("user.json"), r#"{"id":1,"username":"alice"}"#).unwrap();
    let reopened = LocalWtsService::open(
        fixture._directory.path().join("data"),
        "test",
        fixture._directory.path().join("workspaces"),
        fixture._directory.path().join("repositories"),
    )
    .unwrap();
    let restarted_request = SendAgentConversationMessageRequest {
        request_id: Uuid::new_v4(),
        body: "Continue after the host restart.".to_owned(),
    };
    let accepted = reopened
        .send_agent_conversation_message(conversation.conversation_id, restarted_request.clone())
        .expect("the persisted binding must not require the inbox cache");
    assert!(
        accepted
            .messages
            .iter()
            .any(|message| message.body == "Continue after the host restart.")
    );
    wait_for_failed_request(
        &reopened,
        conversation.conversation_id,
        restarted_request.request_id,
    );
    assert_eq!(
        fs::read_to_string(root.join("agent-launches"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    git(
        &fixture.worktree,
        &["config", "branch.main.remote", "origin"],
    );
    assert_rejected_before_dispatch(
        &reopened,
        conversation.conversation_id,
        SendAgentConversationMessageRequest {
            request_id: Uuid::new_v4(),
            body: "Do not switch projects.".to_owned(),
        },
    );
    assert_eq!(
        fs::read_to_string(root.join("agent-launches"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

fn wait_for_failed_request(
    service: &LocalWtsService,
    conversation_id: Uuid,
    request_id: Uuid,
) -> AgentConversation {
    let started = std::time::Instant::now();
    loop {
        let current = service.get_agent_conversation(conversation_id).unwrap();
        if current.messages.iter().any(|message| {
            message.role == AgentConversationMessageRole::User
                && message.request_id == Some(request_id)
                && message.status == AgentConversationMessageStatus::Failed
        }) {
            assert!(current.active_session_id.is_none());
            return current;
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

fn assert_rejected_before_dispatch(
    service: &LocalWtsService,
    conversation_id: Uuid,
    request: SendAgentConversationMessageRequest,
) {
    let accepted = service
        .send_agent_conversation_message(conversation_id, request.clone())
        .expect("record the task before the worker checks its current source");
    assert!(accepted.messages.iter().any(|message| {
        message.role == AgentConversationMessageRole::User
            && message.request_id == Some(request.request_id)
            && message.body == request.body
    }));
    let failed = wait_for_failed_request(service, conversation_id, request.request_id);
    let failure = failed
        .messages
        .iter()
        .find(|message| {
            message.role == AgentConversationMessageRole::Assistant
                && message.request_id == Some(request.request_id)
        })
        .unwrap();
    assert_eq!(failure.status, AgentConversationMessageStatus::Failed);
    assert!(
        failure
            .error
            .as_deref()
            .is_some_and(|error| error.starts_with("The queued request could not start:"))
    );
    let replay = service
        .send_agent_conversation_message(conversation_id, request.clone())
        .unwrap();
    assert_eq!(replay.messages, failed.messages);
    assert!(replay.active_session_id.is_none());
}
