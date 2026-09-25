#![cfg(unix)]
//! Runs the Raptik review through the service with a fake Codex executable.

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
};
use uuid::Uuid;
use wts_app::{
    AgentProvider, CodeReviewLabel, CodeReviewMode, CodeReviewOptions, CodeReviewOutcome,
    CodeReviewScope, LocalWtsService, ProcessExternalLauncher, ProcessWorkspaceAdapter,
    ReviewCodeSide,
};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

fn git(root: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.test")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.test")
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap()
}

fn write_skill(root: &Path) -> PathBuf {
    let skill = root.join("raptik-review");
    fs::create_dir_all(skill.join("references")).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: raptik-review\n---\n# Raptik Review\nMARKER_SKILL_RULES flag nil dereference.\n",
    )
    .unwrap();
    fs::write(skill.join("references/playbook.md"), "MARKER_PLAYBOOK log the error before returning.\n").unwrap();
    fs::write(
        skill.join("references/pratik_comments.jsonl"),
        concat!(
            "{\"body\":\"Issue: can cause runtime panic if cfg is nil, check before use\",\"file\":\"svc/config.go\",\"url\":\"https://gitlab.example.test/note/1\"}\n",
            "{\"body\":\"rename this\",\"file\":\"x.py\",\"url\":\"https://gitlab.example.test/note/2\"}\n",
            "{\"body\":\"add a timeout to this http client\",\"file\":\"a.go\"}\n",
            "{\"body\":\"why is this ignored\",\"file\":\"b.go\"}\n",
            "{\"body\":\"move this magic value to a constant\",\"file\":\"c.py\"}\n",
            "{\"body\":\"close the response body\",\"file\":\"d.go\"}\n",
            "{\"body\":\"use utc here\",\"file\":\"e.py\"}\n",
            "{\"body\":\"nice work\",\"file\":\"f.go\"}\n",
        ),
    )
    .unwrap();
    skill
}

/// The fake records its arguments and prompt, then prints a Codex JSON event stream.
fn write_fake_codex(root: &Path) -> PathBuf {
    let executable = root.join("fake-codex");
    let review = serde_json::json!({
        "intent": "Load the service configuration.",
        "summary": "One Blocking item.",
        "findings": [
            {"label": "blocking", "repository": "api", "filePath": "config.go", "line": 3, "side": "additions",
             "title": "cfg can be nil", "why": "missing file -> nil cfg -> runtime panic nil dereference",
             "code": "return cfg.Name", "suggestedComment": "can cause runtime panic if cfg is nil, check before use",
             "unknownField": true},
            {"label": "nit", "filePath": "config.go", "line": 99, "title": "not on a changed line", "why": "style"}
        ]
    })
    .to_string();
    let event = serde_json::json!({"type": "item.completed", "item": {"type": "agent_message", "text": review}}).to_string();
    let script = format!(
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$(dirname \"$0\")/codex-args.txt\"\nprintf '%s\\n' '{{\"type\":\"thread.started\"}}'\ncat <<'JSON'\n{event}\nJSON\nprintf '%s\\n' '{{\"type\":\"turn.completed\"}}'\n"
    );
    fs::write(&executable, script).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    executable
}

#[test]
fn raptik_review_runs_read_only_anchors_findings_attaches_precedents_and_persists() {
    let directory = tempfile::tempdir().unwrap();
    let skill = write_skill(directory.path());
    // This test binary owns its process, so it can point WTS at the fixture skill.
    // Isolate skill discovery from the skills on the machine that runs the test.
    let isolated_home = directory.path().join("home");
    fs::create_dir_all(&isolated_home).unwrap();
    unsafe {
        std::env::set_var("CODEX_HOME", isolated_home.join(".codex"));
        std::env::set_var("HOME", &isolated_home);
        std::env::set_var("WTS_RAPTIK_SKILL_DIR", &skill);
    }
    let repositories = directory.path().join("repositories");
    let source = repositories.join("api");
    fs::create_dir_all(&source).unwrap();
    git(&source, &["init", "-b", "main"]);
    fs::write(source.join("config.go"), "package api\n\nfunc name() string { return \"\" }\n").unwrap();
    git(&source, &["add", "."]);
    git(&source, &["commit", "-m", "fixture"]);
    let executable = write_fake_codex(directory.path());
    let service = LocalWtsService::open_with_repository_roots_launcher_and_adapter(
        directory.path().join("data"),
        "test",
        directory.path().join("workspaces"),
        [repositories.clone()],
        ProcessExternalLauncher,
        ProcessWorkspaceAdapter::default().with_agent_executable(AgentProvider::Codex, executable),
    )
    .unwrap();
    let workspace = service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet { label: "Review fixture".to_owned() },
                title: "Review fixture".to_owned(),
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
    let workspace_id = workspace.workspace_id;
    let preflight = service.preflight_workspace(workspace_id).unwrap();
    let materialized = service.materialize_workspace(workspace_id, &preflight.effect_digest).unwrap();
    let worktree = &materialized.materialization.worktrees[0];
    let target = PathBuf::from(&worktree.target_display_path);
    fs::write(target.join("config.go"), "package api\n\nfunc name(cfg *Config) string { return cfg.Name }\n").unwrap();
    assert!(service.get_workspace_code_review(workspace_id).unwrap().is_none());

    let result = service
        .run_workspace_code_review_with_options(
            workspace_id,
            AgentProvider::Codex,
            CodeReviewScope::RecentChanges,
            CodeReviewOptions {
                model: Some("gpt-5.6-sol".to_owned()),
                repository_id: Some(worktree.repository_id.clone()),
                ignore_size_gate: false,
                ..CodeReviewOptions::default()
            },
        )
        .unwrap();

    assert_eq!(result.mode, CodeReviewMode::Raptik);
    assert_eq!(result.outcome, CodeReviewOutcome::Reviewed);
    assert_eq!(result.intent.as_deref(), Some("Load the service configuration."));
    assert_eq!(result.repositories.len(), 1);
    assert_eq!(result.repositories[0].changed_lines, 2);
    let blocking = &result.findings[0];
    assert_eq!(blocking.label, CodeReviewLabel::Blocking);
    assert!(blocking.anchored);
    assert_eq!(blocking.line, Some(3));
    assert_eq!(blocking.side, Some(ReviewCodeSide::Additions));
    assert_eq!(blocking.repository_id.as_deref(), Some(worktree.repository_id.as_str()));
    assert_eq!(
        blocking.suggested_comment.as_deref(),
        Some("Blocking: can cause runtime panic if cfg is nil, check before use")
    );
    let precedent = blocking.precedent.as_ref().expect("closest past comment");
    assert_eq!(precedent.url.as_deref(), Some("https://gitlab.example.test/note/1"));
    assert!(!result.findings[1].anchored);

    let args = fs::read_to_string(directory.path().join("codex-args.txt")).unwrap();
    assert!(args.contains("read-only\n"), "{args}");
    assert!(!args.contains("workspace-write"));
    assert!(args.contains("--model\ngpt-5.6-sol\n"));
    assert!(args.contains("MARKER_SKILL_RULES"));
    assert!(args.contains("MARKER_PLAYBOOK"));
    assert!(args.contains("+func name(cfg *Config) string { return cfg.Name }"));

    let saved = service.get_workspace_code_review(workspace_id).unwrap().unwrap();
    assert_eq!(saved, result);
    let wire = serde_json::to_value(&saved).unwrap();
    assert_eq!(wire["findings"][0]["label"], "blocking");
    assert_eq!(wire["findings"][0]["precedent"]["url"], "https://gitlab.example.test/note/1");
    assert_eq!(wire["repositories"][0]["patchSha256"], result.repositories[0].patch_sha256);

    let many = (0..600).map(|index| format!("// line {index}\n")).collect::<String>();
    fs::write(target.join("big.go"), many).unwrap();
    fs::remove_file(directory.path().join("codex-args.txt")).unwrap();
    let gated = service
        .run_workspace_code_review_with_options(
            workspace_id,
            AgentProvider::Codex,
            CodeReviewScope::RecentChanges,
            CodeReviewOptions::default(),
        )
        .unwrap();
    assert_eq!(gated.outcome, CodeReviewOutcome::SizeGateStopped);
    assert!(gated.summary.contains("Pratik stops at 500"));
    assert!(!directory.path().join("codex-args.txt").exists(), "The size gate must stop before the agent runs.");

    let invalid = service.run_workspace_code_review_with_options(
        workspace_id,
        AgentProvider::Codex,
        CodeReviewScope::RecentChanges,
        CodeReviewOptions { model: Some("--sandbox".to_owned()), ..CodeReviewOptions::default() },
    );
    assert!(invalid.is_err());

    // A second skill with a wts-review.toml manifest replaces the Raptik rules.
    let team = directory.path().join("more-skills/team-review");
    fs::create_dir_all(team.join("docs")).unwrap();
    fs::write(team.join("SKILL.md"), "---\nname: team-review\ndescription: Team rules\n---\nMARKER_TEAM_RULES check config loads.\n").unwrap();
    fs::write(team.join("docs/house.md"), "MARKER_TEAM_REFERENCE prefer early returns.\n").unwrap();
    fs::write(team.join("docs/past.jsonl"), "{\"body\":\"cfg can be nil here, add a nil check\",\"file\":\"svc.go\",\"url\":\"https://gitlab.example.test/team/1\"}\n{\"body\":\"rename\"}\n{\"body\":\"other words\"}\n{\"body\":\"more words\"}\n").unwrap();
    fs::write(
        team.join("wts-review.toml"),
        "schema = 1\nlabel = \"Team rules\"\nreviewer = \"Asha\"\nreferences = [\"docs/house.md\"]\nprecedents = \"docs/past.jsonl\"\nsize_gate_lines = 2000\n",
    )
    .unwrap();
    unsafe { std::env::set_var("WTS_REVIEW_SKILL_DIRS", directory.path().join("more-skills")) };
    let catalog = service.agent_model_catalog(true);
    let ids = catalog.review_skills.iter().map(|skill| skill.id.as_str()).collect::<Vec<_>>();
    assert_eq!(ids, vec!["team-review", "raptik-review"]);
    assert_eq!(catalog.default_review_skill.as_deref(), Some("raptik-review"));
    assert!(catalog.review_skills[0].has_manifest);

    let team_result = service
        .run_workspace_code_review_with_options(
            workspace_id,
            AgentProvider::Codex,
            CodeReviewScope::RecentChanges,
            CodeReviewOptions { skill: Some("team-review".to_owned()), ..CodeReviewOptions::default() },
        )
        .unwrap();
    assert_eq!(team_result.mode, CodeReviewMode::Skill);
    assert_eq!(team_result.outcome, CodeReviewOutcome::Reviewed, "{}", team_result.summary);
    let skill = team_result.skill.as_ref().unwrap();
    assert_eq!((skill.id.as_str(), skill.label.as_str(), skill.reviewer.as_deref()), ("team-review", "Team rules", Some("Asha")));
    let args = fs::read_to_string(directory.path().join("codex-args.txt")).unwrap();
    assert!(args.contains("MARKER_TEAM_RULES"));
    assert!(args.contains("MARKER_TEAM_REFERENCE"));
    assert!(!args.contains("MARKER_SKILL_RULES"));
    assert!(args.contains("past comments from Asha"));
    assert_eq!(
        team_result.findings[0].precedent.as_ref().and_then(|precedent| precedent.url.as_deref()),
        Some("https://gitlab.example.test/team/1")
    );

    let missing = service.run_workspace_code_review_with_options(
        workspace_id,
        AgentProvider::Codex,
        CodeReviewScope::RecentChanges,
        CodeReviewOptions { skill: Some("missing-skill".to_owned()), ..CodeReviewOptions::default() },
    );
    assert!(missing.is_err());
    unsafe { std::env::remove_var("WTS_REVIEW_SKILL_DIRS") };
}
