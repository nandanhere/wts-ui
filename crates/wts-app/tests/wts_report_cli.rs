use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
};
use tempfile::TempDir;
use uuid::Uuid;

struct WorkspaceFixture {
    _root: TempDir,
    workspace: PathBuf,
    report_path: PathBuf,
    repository: PathBuf,
    workspace_id: Uuid,
}

impl WorkspaceFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().expect("temporary root");
        let workspace = root.path().join("workspace");
        let evidence = workspace.join(".wts");
        let repository = workspace.join("wts-ui");
        let secondary_repository = workspace.join("wts-core");
        fs::create_dir_all(evidence.join("agent-runs")).expect("agent-runs");
        fs::create_dir(evidence.join("logs")).expect("logs");
        fs::create_dir(&repository).expect("repository worktree");
        fs::create_dir(&secondary_repository).expect("secondary repository worktree");
        fs::create_dir(repository.join("src")).expect("source directory");
        fs::write(
            repository.join("src/report.rs"),
            "pub fn publish_report() {}\n",
        )
        .expect("flow evidence");
        let workspace_id = Uuid::new_v4();
        let context = json!({
            "schemaVersion": 1,
            "workspaceId": workspace_id,
            "workspaceRecordVersion": 1,
            "title": "WTS improves WTS",
            "intent": {
                "type": "repositorySet",
                "label": "WTS"
            },
            "preferredProvider": "codex",
            "branchName": "wts/self-host",
            "workspaceDisplayPath": workspace,
            "codeWorkspaceDisplayPath": workspace.join("workspace.code-workspace"),
            "evidenceDisplayPath": evidence,
            "createdAtUnixMs": 1_721_776_400_000_i64,
            "wtsVersion": "0.1.0",
            "repositories": [
                {
                    "repositoryId": "repo_wts",
                    "label": "wts-ui",
                    "requestedBaseRef": "main",
                    "resolvedBaseRef": "main",
                    "baseCommitOid": "a".repeat(40),
                    "worktreeDisplayPath": repository
                },
                {
                    "repositoryId": "repo_core",
                    "label": "wts-core",
                    "requestedBaseRef": "main",
                    "resolvedBaseRef": "main",
                    "baseCommitOid": "b".repeat(40),
                    "worktreeDisplayPath": secondary_repository
                }
            ],
            "allowedRepositoryIds": ["repo_wts", "repo_core"]
        });
        fs::write(
            evidence.join("context.json"),
            serde_json::to_vec_pretty(&context).expect("context JSON"),
        )
        .expect("write context");
        let graph_manifest = json!({
            "schemaVersion": 1,
            "workspaceId": workspace_id,
            "status": "ready",
            "graphDisplayPath": workspace.join("graphify-out/graph.json"),
            "graphSha256": format!("sha256:{}", "c".repeat(64)),
            "indexedAtUnixMs": 1_721_776_450_000_i64,
            "indexedRepositories": [
                {"repositoryId": "repo_wts", "commitOid": "a".repeat(40)},
                {"repositoryId": "repo_core", "commitOid": "b".repeat(40)}
            ],
            "detail": "Current graph snapshot."
        });
        fs::write(
            evidence.join("graph-manifest.json"),
            serde_json::to_vec_pretty(&graph_manifest).expect("graph manifest JSON"),
        )
        .expect("write graph manifest");

        let report_path = evidence.join("agent-report.json");
        fs::write(
            &report_path,
            serde_json::to_vec_pretty(&empty_report(workspace_id)).expect("initial report JSON"),
        )
        .expect("initial report");
        Self {
            _root: root,
            workspace,
            report_path,
            repository,
            workspace_id,
        }
    }

    fn valid_report(&self) -> Value {
        json!({
            "schemaVersion": 1,
            "workspaceId": self.workspace_id,
            "updatedAtUnixMs": 1_721_776_500_000_i64,
            "summary": "The workspace contract has a process-boundary test.",
            "scope": {
                "coverage": "complete",
                "graphStatus": "ready",
                "graphSha256": format!("sha256:{}", "c".repeat(64)),
                "reviewedRepositoryIds": ["repo_wts", "repo_core"],
                "unresolvedRepositoryIds": [],
                "skippedRepositories": []
            },
            "environment": {
                "status": "needsInput",
                "summary": "Graph evidence identifies the Rust toolchain and one user-supplied token.",
                "requirements": [
                    {
                        "id": "rust-toolchain",
                        "repositoryId": "repo_wts",
                        "kind": "toolchain",
                        "name": "Rust toolchain",
                        "required": true,
                        "source": "repository",
                        "detail": "The workspace report publisher is implemented in Rust.",
                        "evidence": [{
                            "repositoryId": "repo_wts",
                            "path": "src/report.rs",
                            "line": 1
                        }]
                    },
                    {
                        "id": "wts-api-token",
                        "repositoryId": "repo_wts",
                        "kind": "secret",
                        "name": "WTS_API_TOKEN",
                        "required": true,
                        "source": "user",
                        "detail": "Supply through the user environment; never persist the value in WTS.",
                        "evidence": [{
                            "repositoryId": "repo_wts",
                            "path": "src/report.rs",
                            "line": 1
                        }]
                    }
                ],
                "setupSteps": [{
                    "id": "fetch-rust-dependencies",
                    "repositoryId": "repo_wts",
                    "workingDirectory": self.repository,
                    "action": "Fetch the declared Rust dependencies.",
                    "command": ["cargo", "fetch"],
                    "evidence": [{
                        "repositoryId": "repo_wts",
                        "path": "src/report.rs",
                        "line": 1
                    }]
                }],
                "unresolved": ["WTS_API_TOKEN must be supplied by the user."]
            },
            "flows": [{
                "id": "publish-report",
                "title": "Publish workspace verification evidence",
                "kind": "user",
                "actors": ["Workspace user", "Agent"],
                "entryPoints": ["wts-report standard input"],
                "steps": [{
                    "id": "validate",
                    "repositoryId": "repo_wts",
                    "component": "Agent report publisher",
                    "action": "Validate and atomically publish the report.",
                    "evidence": [{
                        "repositoryId": "repo_wts",
                        "path": "src/report.rs",
                        "line": 1
                    }]
                }],
                "expectedOutcome": "The user can review structured workspace evidence in WTS.",
                "risks": ["An untrusted report must not escape repository boundaries."],
                "existingCoverage": ["Real CLI process integration test"],
                "verificationCandidateIds": ["wts-rust-suite"]
            }],
            "findings": [{
                "id": "report-contract",
                "title": "Agent reporting is covered",
                "detail": "The CLI validates before replacing evidence.",
                "severity": "info",
                "repositoryId": "repo_wts",
                "evidence": ["crates/wts-app/tests/wts_report_cli.rs"],
                "flowIds": ["publish-report"]
            }],
            "nextActions": ["Keep the acceptance lane running."],
            "proposedChecks": [{
                "id": "wts-rust-suite",
                "label": "WTS Rust tests",
                "kind": "unit",
                "repositoryId": "repo_wts",
                "workingDirectory": self.repository,
                "executable": "cargo",
                "args": ["test", "--quiet"],
                "timeoutMs": 120_000,
                "environmentNames": ["CI"],
                "reason": "Exercise the trusted Rust boundary.",
                "evidence": ["crates/wts-app/tests/wts_report_cli.rs"]
            }],
            "validationFlows": [{
                "id": "publish-report",
                "title": "Publish an agent report",
                "goal": "Show validated findings in WTS.",
                "prerequisites": ["A materialized WTS workspace."],
                "steps": [{
                    "id": "publish",
                    "action": "Pipe the report to wts-report.",
                    "expected": "The report is atomically published.",
                    "evidence": [".wts/agent-report.json"]
                }]
            }]
        })
    }
}

fn empty_report(workspace_id: Uuid) -> Value {
    json!({
        "schemaVersion": 1,
        "workspaceId": workspace_id,
        "updatedAtUnixMs": null,
            "summary": "",
        "findings": [],
        "nextActions": [],
        "proposedChecks": [],
        "validationFlows": []
    })
}

fn run_with_stdin(workspace: &Path, value: &Value) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_wts-report"))
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn wts-report");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(&serde_json::to_vec(value).expect("input JSON"))
        .expect("write stdin");
    child.wait_with_output().expect("wts-report output")
}

#[test]
fn stdin_publishes_a_valid_report_through_the_real_cli_process() {
    let fixture = WorkspaceFixture::new();

    let output = run_with_stdin(&fixture.workspace, &fixture.valid_report());

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "Published .wts/agent-report.json\n"
    );
    let published: Value =
        serde_json::from_slice(&fs::read(&fixture.report_path).expect("published report"))
            .expect("published report JSON");
    assert_eq!(
        published["summary"],
        "The workspace contract has a process-boundary test."
    );
    assert_eq!(published["proposedChecks"][0]["executable"], "cargo");
    assert_eq!(published["scope"]["coverage"], "complete");
    assert_eq!(published["environment"]["status"], "needsInput");
    assert_eq!(
        published["environment"]["requirements"][1]["name"],
        "WTS_API_TOKEN"
    );
    assert_eq!(published["flows"][0]["id"], "publish-report");
    assert_eq!(
        published["flows"][0]["steps"][0]["evidence"][0]["path"],
        "src/report.rs"
    );
}

#[test]
fn partial_scope_accounts_for_every_repository_and_publishes_honest_coverage() {
    let fixture = WorkspaceFixture::new();
    let mut report = fixture.valid_report();
    report["scope"]["coverage"] = json!("partial");
    report["scope"]["reviewedRepositoryIds"] = json!(["repo_wts"]);
    report["scope"]["unresolvedRepositoryIds"] = json!(["repo_core"]);

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let published: Value =
        serde_json::from_slice(&fs::read(&fixture.report_path).expect("published report"))
            .expect("published report JSON");
    assert_eq!(published["scope"]["coverage"], "partial");
    assert_eq!(
        published["scope"]["unresolvedRepositoryIds"],
        json!(["repo_core"])
    );
}

#[test]
fn partial_scope_cannot_silently_omit_a_workspace_repository() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut report = fixture.valid_report();
    report["scope"]["coverage"] = json!("partial");
    report["scope"]["reviewedRepositoryIds"] = json!(["repo_wts"]);
    report["scope"]["unresolvedRepositoryIds"] = json!([]);

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("scope.coverage"), "{stderr}");
    assert!(
        stderr.contains("account for every other repository"),
        "{stderr}"
    );
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn report_graph_digest_must_match_the_current_trusted_snapshot() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut report = fixture.valid_report();
    report["scope"]["graphSha256"] = json!(format!("sha256:{}", "d".repeat(64)));

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("scope.graphSha256"), "{stderr}");
    assert!(stderr.contains("trusted graph manifest digest"), "{stderr}");
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn prefixed_graph_digest_from_the_trusted_manifest_is_publishable() {
    let fixture = WorkspaceFixture::new();
    let output = run_with_stdin(&fixture.workspace, &fixture.valid_report());

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let published: Value =
        serde_json::from_slice(&fs::read(&fixture.report_path).expect("published report"))
            .expect("published report JSON");
    assert_eq!(
        published["scope"]["graphSha256"],
        format!("sha256:{}", "c".repeat(64))
    );
}

#[test]
fn graph_digest_rejects_noncanonical_bare_or_uppercase_hex_without_replacing_evidence() {
    for invalid_digest in ["c".repeat(64), format!("sha256:{}", "C".repeat(64))] {
        let fixture = WorkspaceFixture::new();
        let original = fs::read(&fixture.report_path).expect("original report");
        let mut report = fixture.valid_report();
        report["scope"]["graphSha256"] = json!(invalid_digest);

        let output = run_with_stdin(&fixture.workspace, &report);

        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("scope.graphSha256"), "{stderr}");
        assert!(stderr.contains("trusted graph manifest digest"), "{stderr}");
        assert_eq!(
            fs::read(&fixture.report_path).expect("unchanged report"),
            original
        );
    }
}

#[test]
fn flow_evidence_cannot_escape_or_substitute_its_reviewed_repository() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut report = fixture.valid_report();
    report["flows"][0]["steps"][0]["evidence"][0]["path"] = json!("../wts-core/private.rs");

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("flows[0].steps[0].evidence[0].path"),
        "{stderr}"
    );
    assert!(stderr.contains("relative path"), "{stderr}");
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn flow_steps_cannot_claim_an_unreviewed_repository() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut report = fixture.valid_report();
    report["scope"]["coverage"] = json!("partial");
    report["scope"]["reviewedRepositoryIds"] = json!(["repo_core"]);
    report["scope"]["unresolvedRepositoryIds"] = json!(["repo_wts"]);
    report["environment"] = json!({
        "status": "unassessed",
        "summary": "",
        "requirements": [],
        "setupSteps": [],
        "unresolved": []
    });

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("flows[0].steps[0].repositoryId"),
        "{stderr}"
    );
    assert!(stderr.contains("scope.reviewedRepositoryIds"), "{stderr}");
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn findings_may_only_attach_to_declared_flows() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut report = fixture.valid_report();
    report["findings"][0]["flowIds"] = json!(["missing-flow"]);

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("findings[0].flowIds"), "{stderr}");
    assert!(stderr.contains("unknown flow missing-flow"), "{stderr}");
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn legacy_report_without_scope_or_flows_remains_publishable_as_unassessed() {
    let fixture = WorkspaceFixture::new();
    let mut report = fixture.valid_report();
    report
        .as_object_mut()
        .expect("report object")
        .remove("scope");
    report
        .as_object_mut()
        .expect("report object")
        .remove("flows");
    report
        .as_object_mut()
        .expect("report object")
        .remove("environment");
    report["findings"][0]
        .as_object_mut()
        .expect("finding object")
        .remove("flowIds");

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let published: Value =
        serde_json::from_slice(&fs::read(&fixture.report_path).expect("published report"))
            .expect("published report JSON");
    assert_eq!(published["scope"]["coverage"], "unassessed");
    assert_eq!(published["environment"]["status"], "unassessed");
    assert_eq!(published["flows"], json!([]));
}

#[test]
fn environment_reports_cannot_store_secret_values() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut report = fixture.valid_report();
    report["environment"]["requirements"][1]["value"] = json!("must-not-be-stored");

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("unknown field `value`"), "{stderr}");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("must-not-be-stored"));
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn environment_setup_evidence_cannot_escape_its_reviewed_repository() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut report = fixture.valid_report();
    report["environment"]["setupSteps"][0]["evidence"][0]["path"] = json!("../wts-core/Cargo.toml");

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("environment.setupSteps[0].evidence[0].path"),
        "{stderr}"
    );
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn invalid_input_file_reports_the_exact_field_and_preserves_the_existing_report() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut invalid = fixture.valid_report();
    invalid["proposedChecks"][0]["executable"] = json!("sh");
    invalid["proposedChecks"][0]["args"] = json!(["-c", "touch outside"]);
    let input_path = fixture.workspace.join("candidate-report.json");
    fs::write(
        &input_path,
        serde_json::to_vec_pretty(&invalid).expect("invalid candidate"),
    )
    .expect("write candidate");

    let output = Command::new(env!("CARGO_BIN_EXE_wts-report"))
        .current_dir(&fixture.workspace)
        .args(["--input", input_path.to_str().expect("UTF-8 input path")])
        .output()
        .expect("run wts-report");

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("proposedChecks[0].executable"), "{stderr}");
    assert!(stderr.contains("cargo test --quiet"), "{stderr}");
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn a_report_for_another_workspace_is_rejected_without_replacing_evidence() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut invalid = fixture.valid_report();
    invalid["workspaceId"] = json!(Uuid::new_v4());

    let output = run_with_stdin(&fixture.workspace, &invalid);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("workspaceId"), "{stderr}");
    assert!(stderr.contains(".wts/context.json"), "{stderr}");
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn a_proposed_check_cannot_substitute_another_working_directory() {
    let fixture = WorkspaceFixture::new();
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut invalid = fixture.valid_report();
    invalid["proposedChecks"][0]["workingDirectory"] =
        json!(fixture.workspace.join("another-directory"));

    let output = run_with_stdin(&fixture.workspace, &invalid);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("proposedChecks[0].workingDirectory"),
        "{stderr}"
    );
    assert!(stderr.contains("worktreeDisplayPath"), "{stderr}");
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}

#[test]
fn a_proposed_check_may_use_an_existing_nested_repository_directory() {
    let fixture = WorkspaceFixture::new();
    let nested = fixture.repository.join("api");
    fs::create_dir(&nested).expect("nested repository directory");
    let mut report = fixture.valid_report();
    report["proposedChecks"][0]["workingDirectory"] = json!(nested);

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(
        output.status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn a_proposed_check_cannot_use_a_symlinked_nested_directory() {
    use std::os::unix::fs::symlink;

    let fixture = WorkspaceFixture::new();
    let target = fixture.repository.join("real-api");
    let linked = fixture.repository.join("linked-api");
    fs::create_dir(&target).expect("real nested directory");
    symlink(&target, &linked).expect("nested directory symlink");
    let original = fs::read(&fixture.report_path).expect("original report");
    let mut report = fixture.valid_report();
    report["proposedChecks"][0]["workingDirectory"] = json!(linked);

    let output = run_with_stdin(&fixture.workspace, &report);

    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("proposedChecks[0].workingDirectory"),
        "{stderr}"
    );
    assert!(stderr.contains("non-symlink directory"), "{stderr}");
    assert_eq!(
        fs::read(&fixture.report_path).expect("unchanged report"),
        original
    );
}
