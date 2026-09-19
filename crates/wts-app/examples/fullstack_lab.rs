use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env,
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use wts_app::{AgentProvider, GraphWorkspaceStatus, LocalWtsService};
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

const UI_PACKAGE: &str =
    include_str!("../../../examples/fullstack-lab/templates/storefront-ui/package.json");
const UI_SOURCE: &str =
    include_str!("../../../examples/fullstack-lab/templates/storefront-ui/src/checkout.js");
const UI_BASELINE_TEST: &str =
    include_str!("../../../examples/fullstack-lab/templates/storefront-ui/test/baseline.test.js");
const API_CARGO: &str =
    include_str!("../../../examples/fullstack-lab/templates/checkout-api/Cargo.toml");
const API_CARGO_LOCK: &str =
    include_str!("../../../examples/fullstack-lab/templates/checkout-api/Cargo.lock");
const API_GITIGNORE: &str =
    include_str!("../../../examples/fullstack-lab/templates/checkout-api/.gitignore");
const API_SOURCE: &str =
    include_str!("../../../examples/fullstack-lab/templates/checkout-api/src/lib.rs");
type LabResult<T> = Result<T, Box<dyn Error>>;
const SCENARIO_SCHEMA_VERSION: u32 = 1;
const SAMPLE_REPOSITORIES: [&str; 2] = ["storefront-ui", "checkout-api"];

#[derive(Clone, Copy)]
enum Executor {
    Reference,
    Agent(AgentProvider),
}

impl Executor {
    fn label(self) -> &'static str {
        match self {
            Self::Reference => "reference",
            Self::Agent(AgentProvider::Hermes) => "hermes",
            Self::Agent(AgentProvider::Codex) => "codex",
            Self::Agent(AgentProvider::OpenCode) => "opencode",
            Self::Agent(AgentProvider::Copilot) => "copilot",
        }
    }

    fn workspace_provider(self) -> WorkspaceProvider {
        match self {
            Self::Reference => WorkspaceProvider::VsCode,
            Self::Agent(AgentProvider::Hermes) => WorkspaceProvider::Hermes,
            Self::Agent(AgentProvider::Codex) => WorkspaceProvider::Codex,
            Self::Agent(AgentProvider::OpenCode) => WorkspaceProvider::OpenCode,
            Self::Agent(AgentProvider::Copilot) => WorkspaceProvider::Copilot,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Scenario {
    schema_version: u32,
    id: String,
    issue: String,
    title: String,
    repositories: Vec<String>,
    brief_file: String,
    acceptance: Vec<FileInjection>,
    checks: Vec<ScenarioCheck>,
    reference_changes: Vec<ReferenceChange>,
    expected_changed_sources: Vec<String>,
    #[serde(skip)]
    brief: String,
    #[serde(skip)]
    manifest_directory: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileInjection {
    repository: String,
    source: String,
    target: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScenarioCheck {
    id: String,
    label: String,
    repository: String,
    executable: String,
    args: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReferenceChange {
    repository: String,
    path: String,
    find: String,
    replace: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LabReport {
    schema_version: u32,
    executor: String,
    lab_root: String,
    scenarios: Vec<ScenarioReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScenarioReport {
    issue: String,
    workspace_id: Uuid,
    branch: String,
    workspace_path: String,
    repositories: Vec<String>,
    graph_path: String,
    evidence_path: String,
    wts_verification_status: String,
    red_verified: bool,
    green_verified: bool,
    acceptance_tests_preserved: bool,
    changed_files: Vec<String>,
    agent_output: Option<String>,
}

fn main() -> LabResult<()> {
    let (root, executor, scenario_directory, validate_only) = arguments()?;
    let scenarios = load_scenarios(&scenario_directory)?;
    if validate_only {
        println!(
            "Validated {} scenario manifests in {}.",
            scenarios.len(),
            scenario_directory.display()
        );
        return Ok(());
    }
    ensure_new_root(&root)?;

    let repository_root = root.join("repositories");
    let workspace_root = root.join("workspaces");
    let data_root = root.join("data");
    fs::create_dir_all(&repository_root)?;
    fs::create_dir_all(&workspace_root)?;
    create_repositories(&repository_root)?;

    let service = LocalWtsService::open(
        &data_root,
        "fullstack-lab",
        &workspace_root,
        &repository_root,
    )?;
    let catalog = service.repository_catalog()?;
    let labels = catalog
        .repositories
        .iter()
        .map(|repository| repository.label.as_str())
        .collect::<Vec<_>>();
    if !labels.contains(&"checkout-api") || !labels.contains(&"storefront-ui") {
        return Err(failure(format!(
            "expected both sample repositories, discovered {labels:?}"
        )));
    }

    println!("WTS full-stack lab: {}", root.display());
    println!("Executor: {}", executor.label());

    let mut reports = Vec::new();
    for scenario in &scenarios {
        println!("\n{} — {}", scenario.issue, scenario.title);
        reports.push(run_scenario(&service, scenario, executor)?);
    }

    let report = LabReport {
        schema_version: SCENARIO_SCHEMA_VERSION,
        executor: executor.label().to_owned(),
        lab_root: display(&root)?,
        scenarios: reports,
    };
    let report_path = root.join("lab-report.json");
    fs::write(&report_path, serde_json::to_vec_pretty(&report)?)?;
    println!("\nAll {} scenarios passed.", scenarios.len());
    println!("Report: {}", report_path.display());
    Ok(())
}

fn arguments() -> LabResult<(PathBuf, Executor, PathBuf, bool)> {
    let mut arguments = env::args().skip(1);
    let mut root = None;
    let mut executor = Executor::Reference;
    let mut scenario_directory = None;
    let mut validate_only = false;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--root" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| failure("--root requires a path"))?;
                root = Some(PathBuf::from(value));
            }
            "--executor" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| failure("--executor requires a value"))?;
                executor = match value.as_str() {
                    "reference" => Executor::Reference,
                    "hermes" => Executor::Agent(AgentProvider::Hermes),
                    "codex" => Executor::Agent(AgentProvider::Codex),
                    "opencode" => Executor::Agent(AgentProvider::OpenCode),
                    _ => {
                        return Err(failure(
                            "--executor must be reference, hermes, codex, or opencode",
                        ));
                    }
                };
            }
            "--scenario-dir" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| failure("--scenario-dir requires a path"))?;
                scenario_directory = Some(PathBuf::from(value));
            }
            "--validate-only" => validate_only = true,
            "--help" | "-h" => {
                println!(
                    "Usage: fullstack_lab [--root PATH] [--scenario-dir PATH] [--validate-only] \
                     [--executor reference|hermes|codex|opencode]"
                );
                std::process::exit(0);
            }
            _ => return Err(failure(format!("unknown argument: {argument}"))),
        }
    }
    let root = match root {
        Some(root) => absolute(root)?,
        None => {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
            env::temp_dir().join(format!(
                "wts-fullstack-lab-{timestamp}-{}",
                std::process::id()
            ))
        }
    };
    let scenario_directory = match scenario_directory {
        Some(path) => absolute(path)?,
        None => {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/fullstack-lab/scenarios")
        }
    };
    Ok((root, executor, scenario_directory, validate_only))
}

fn load_scenarios(directory: &Path) -> LabResult<Vec<Scenario>> {
    let directory = directory.canonicalize().map_err(|error| {
        failure(format!(
            "scenario directory is unavailable at {}: {error}",
            directory.display()
        ))
    })?;
    let mut manifests = fs::read_dir(&directory)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    manifests.sort();
    if manifests.is_empty() {
        return Err(failure(format!(
            "no JSON scenarios found in {}",
            directory.display()
        )));
    }

    let mut scenarios = Vec::new();
    for manifest in manifests {
        let bytes = fs::read(&manifest)?;
        let mut scenario: Scenario = serde_json::from_slice(&bytes).map_err(|error| {
            failure(format!("invalid scenario {}: {error}", manifest.display()))
        })?;
        scenario.manifest_directory = directory
            .parent()
            .ok_or_else(|| failure("scenario directory has no lab root"))?
            .to_owned();
        validate_scenario(&scenario, &manifest)?;
        let brief = safe_relative(&scenario.brief_file)?;
        scenario.brief =
            fs::read_to_string(scenario.manifest_directory.join(brief)).map_err(|error| {
                failure(format!(
                    "brief for scenario {} is unavailable: {error}",
                    scenario.id
                ))
            })?;
        scenarios.push(scenario);
    }
    Ok(scenarios)
}

fn validate_scenario(scenario: &Scenario, manifest: &Path) -> LabResult<()> {
    if scenario.schema_version != SCENARIO_SCHEMA_VERSION {
        return Err(failure(format!(
            "{} uses unsupported schema version {}",
            manifest.display(),
            scenario.schema_version
        )));
    }
    if scenario.id.trim().is_empty()
        || scenario.issue.trim().is_empty()
        || scenario.title.trim().is_empty()
        || scenario.repositories.is_empty()
        || scenario.checks.is_empty()
        || scenario.acceptance.is_empty()
        || scenario.reference_changes.is_empty()
    {
        return Err(failure(format!(
            "{} is missing required scenario content",
            manifest.display()
        )));
    }
    let mut repositories = std::collections::BTreeSet::new();
    for repository in &scenario.repositories {
        if !SAMPLE_REPOSITORIES.contains(&repository.as_str())
            || !repositories.insert(repository.as_str())
        {
            return Err(failure(format!(
                "{} contains an unsupported or duplicate repository",
                scenario.id
            )));
        }
    }
    safe_relative(&scenario.brief_file)?;
    for acceptance in &scenario.acceptance {
        require_selected_repository(scenario, &acceptance.repository)?;
        safe_relative(&acceptance.source)?;
        safe_relative(&acceptance.target)?;
    }
    for check in &scenario.checks {
        require_selected_repository(scenario, &check.repository)?;
        if check.id.trim().is_empty()
            || check.label.trim().is_empty()
            || !matches!(check.executable.as_str(), "node" | "cargo")
            || check
                .args
                .iter()
                .any(|argument| argument.contains('\0') || argument.len() > 512)
        {
            return Err(failure(format!(
                "{} contains an unsafe verification check",
                scenario.id
            )));
        }
    }
    for change in &scenario.reference_changes {
        require_selected_repository(scenario, &change.repository)?;
        safe_relative(&change.path)?;
        if change.find.is_empty() || change.find == change.replace {
            return Err(failure(format!(
                "{} contains an invalid reference change",
                scenario.id
            )));
        }
    }
    for expected in &scenario.expected_changed_sources {
        let Some((repository, path)) = expected.split_once(':') else {
            return Err(failure(format!(
                "{} contains an invalid expected source path",
                scenario.id
            )));
        };
        require_selected_repository(scenario, repository)?;
        safe_relative(path)?;
    }
    Ok(())
}

fn ensure_new_root(root: &Path) -> LabResult<()> {
    if root.exists() {
        return Err(failure(format!(
            "lab root already exists; choose a new path: {}",
            root.display()
        )));
    }
    fs::create_dir_all(root)?;
    Ok(())
}

fn create_repositories(repository_root: &Path) -> LabResult<()> {
    let ui = repository_root.join("storefront-ui");
    write(&ui.join("package.json"), UI_PACKAGE)?;
    write(&ui.join("src/checkout.js"), UI_SOURCE)?;
    write(&ui.join("test/baseline.test.js"), UI_BASELINE_TEST)?;
    initialize_repository(&ui)?;

    let api = repository_root.join("checkout-api");
    write(&api.join("Cargo.toml"), API_CARGO)?;
    write(&api.join("Cargo.lock"), API_CARGO_LOCK)?;
    write(&api.join(".gitignore"), API_GITIGNORE)?;
    write(&api.join("src/lib.rs"), API_SOURCE)?;
    initialize_repository(&api)?;
    Ok(())
}

fn initialize_repository(root: &Path) -> LabResult<()> {
    run_checked(Command::new("git").arg("init").arg(root), "git init")?;
    run_checked(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["config", "user.name", "WTS Lab"]),
        "git user name",
    )?;
    run_checked(
        Command::new("git").arg("-C").arg(root).args([
            "config",
            "user.email",
            "wts-lab@example.invalid",
        ]),
        "git user email",
    )?;
    run_checked(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["config", "commit.gpgSign", "false"]),
        "disable commit signing",
    )?;
    run_checked(
        Command::new("git").arg("-C").arg(root).args(["add", "."]),
        "git add",
    )?;
    run_checked(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["commit", "-m", "Create WTS lab repository"]),
        "git commit",
    )?;
    run_checked(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["branch", "-M", "main"]),
        "git main branch",
    )?;
    Ok(())
}

fn run_scenario(
    service: &LocalWtsService,
    scenario: &Scenario,
    executor: Executor,
) -> LabResult<ScenarioReport> {
    let created = service.create_workspace(
        &Uuid::new_v4().to_string(),
        CreateWorkspaceRequest {
            intent: WorkspaceIntent::Jira {
                issue_key: scenario.issue.to_owned(),
            },
            title: scenario.title.to_owned(),
            preferred_provider: executor.workspace_provider(),
            repositories: scenario
                .repositories
                .iter()
                .map(|label| WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: label.to_owned(),
                    base_ref: "main".to_owned(),
                })
                .collect(),
            runtime: None,
            planning: None,
        },
    )?;
    let workspace_id = created.workspace.workspace_id;
    let preflight = service.preflight_workspace(workspace_id)?;
    if !preflight.ready {
        return Err(failure(format!(
            "{} preflight blocked: {:?}",
            scenario.issue, preflight.blockers
        )));
    }
    let materialized = service.materialize_workspace(workspace_id, &preflight.effect_digest)?;
    let materialization = materialized.materialization;
    let workspace = PathBuf::from(&materialization.workspace_display_path);

    inject_acceptance_tests(scenario, &materialization.worktrees)?;
    write_task_context(&workspace, scenario, &materialization.branch_name, executor)?;

    let acceptance_files = acceptance_files(scenario, &materialization.worktrees)?;
    let acceptance_hashes = acceptance_files
        .iter()
        .map(|path| Ok((path.clone(), hash_file(path)?)))
        .collect::<LabResult<Vec<_>>>()?;

    let graph = service.index_workspace_graph(workspace_id)?;
    if graph.status != GraphWorkspaceStatus::Ready {
        return Err(failure("workspace graph was not ready"));
    }
    verify_graph_scope(Path::new(&graph.graph_display_path), scenario)?;

    let red = verify_scenario(scenario, &materialization.worktrees)?;
    if red.succeeded {
        return Err(failure(format!(
            "{} acceptance checks unexpectedly passed before the fix",
            scenario.issue
        )));
    }
    println!("  red: expected acceptance failure observed");

    let agent_output = match executor {
        Executor::Reference => {
            apply_reference_changes(scenario, &materialization.worktrees)?;
            None
        }
        Executor::Agent(provider) => {
            let prompt = agent_prompt(scenario);
            let run = service.run_agent(workspace_id, provider, &prompt)?;
            if !run.succeeded {
                return Err(failure(format!(
                    "{} agent failed:\n{}",
                    scenario.issue, run.output
                )));
            }
            Some(run.output)
        }
    };

    let acceptance_tests_preserved = acceptance_hashes
        .iter()
        .all(|(path, before)| hash_file(path).is_ok_and(|after| &after == before));
    if !acceptance_tests_preserved {
        return Err(failure(format!(
            "{} executor changed an acceptance test",
            scenario.issue
        )));
    }

    let green = verify_scenario(scenario, &materialization.worktrees)?;
    if !green.succeeded {
        return Err(failure(format!(
            "{} verification failed after the fix:\n{}",
            scenario.issue, green.output
        )));
    }
    let evidence = service.run_workspace_verification(workspace_id)?;
    if evidence.verification_result.status != wts_app::VerificationStatus::Passed {
        return Err(failure(format!(
            "{} WTS verification engine returned {:?}",
            scenario.issue, evidence.verification_result.status
        )));
    }
    println!("  graph: {}", graph.graph_display_path);
    println!("  green: all repository checks passed");
    println!(
        "  evidence: {} ({:?})",
        evidence.context.evidence_display_path, evidence.verification_result.status
    );

    let changed_files = changed_files(&materialization.worktrees)?;
    verify_expected_source_changes(scenario, &changed_files)?;

    Ok(ScenarioReport {
        issue: scenario.issue.to_owned(),
        workspace_id,
        branch: materialization.branch_name,
        workspace_path: materialization.workspace_display_path,
        repositories: scenario
            .repositories
            .iter()
            .map(|label| label.to_owned())
            .collect(),
        graph_path: graph.graph_display_path,
        evidence_path: evidence.context.evidence_display_path,
        wts_verification_status: format!("{:?}", evidence.verification_result.status),
        red_verified: true,
        green_verified: true,
        acceptance_tests_preserved,
        changed_files,
        agent_output,
    })
}

fn worktree(worktrees: &[wts_app::MaterializedWorktree], label: &str) -> LabResult<PathBuf> {
    worktrees
        .iter()
        .find(|worktree| worktree.label == label)
        .map(|worktree| PathBuf::from(&worktree.target_display_path))
        .ok_or_else(|| failure(format!("worktree for {label} is missing")))
}

fn inject_acceptance_tests(
    scenario: &Scenario,
    worktrees: &[wts_app::MaterializedWorktree],
) -> LabResult<()> {
    for acceptance in &scenario.acceptance {
        let source = scenario
            .manifest_directory
            .join(safe_relative(&acceptance.source)?);
        let target =
            worktree(worktrees, &acceptance.repository)?.join(safe_relative(&acceptance.target)?);
        let content = fs::read_to_string(&source).map_err(|error| {
            failure(format!(
                "acceptance source is unavailable at {}: {error}",
                source.display()
            ))
        })?;
        write(&target, &content)?;
    }
    Ok(())
}

fn acceptance_files(
    scenario: &Scenario,
    worktrees: &[wts_app::MaterializedWorktree],
) -> LabResult<Vec<PathBuf>> {
    scenario
        .acceptance
        .iter()
        .map(|acceptance| {
            Ok(worktree(worktrees, &acceptance.repository)?
                .join(safe_relative(&acceptance.target)?))
        })
        .collect()
}

fn write_task_context(
    workspace: &Path,
    scenario: &Scenario,
    branch: &str,
    executor: Executor,
) -> LabResult<()> {
    let repositories = scenario.repositories.join(", ");
    let content = format!(
        "# WTS isolated task context\n\n\
         Issue: {}\n\
         Branch: {branch}\n\
         Executor: {}\n\
         Allowed repositories: {repositories}\n\
         Workspace graph: `graphify-out/graph.json`\n\n\
         {}\n\n\
         ## Agent guardrails\n\n\
         - Read this file before changing code.\n\
         - Use the workspace graph for repository-local context.\n\
         - Modify only the allowed repository directories.\n\
         - Do not edit files whose names start with `wts_`; they are acceptance tests.\n\
         - Run every verification command in the issue brief before finishing.\n",
        scenario.issue,
        executor.label(),
        scenario.brief
    );
    write(&workspace.join(".wts-task.md"), &content)
}

fn agent_prompt(scenario: &Scenario) -> String {
    format!(
        "Work on {} in this isolated WTS workspace. Read .wts-task.md first, \
         then consult graphify-out/graph.json for workspace-only context. \
         Implement the requested change only in the allowed repositories. \
         Never edit wts_* acceptance tests. Run all verification commands \
         from the task brief and finish with a concise summary.",
        scenario.issue
    )
}

fn apply_reference_changes(
    scenario: &Scenario,
    worktrees: &[wts_app::MaterializedWorktree],
) -> LabResult<()> {
    for change in &scenario.reference_changes {
        let path = worktree(worktrees, &change.repository)?.join(safe_relative(&change.path)?);
        replace_once(&path, &change.find, &change.replace)?;
    }
    Ok(())
}

struct Verification {
    succeeded: bool,
    output: String,
}

fn verify_scenario(
    scenario: &Scenario,
    worktrees: &[wts_app::MaterializedWorktree],
) -> LabResult<Verification> {
    let mut outputs = Vec::new();
    let mut succeeded = true;
    for check in &scenario.checks {
        let root = worktree(worktrees, &check.repository)?;
        let mut command = Command::new(&check.executable);
        command.args(&check.args).current_dir(root);
        let output = run_output(&mut command, &check.label)?;
        succeeded &= output.status.success();
        outputs.push(format_output(
            &format!("{}: {}", check.repository, check.label),
            &output,
        ));
    }
    Ok(Verification {
        succeeded,
        output: outputs.join("\n"),
    })
}

fn verify_graph_scope(graph: &Path, scenario: &Scenario) -> LabResult<()> {
    let content = fs::read_to_string(graph)?;
    for repository in &scenario.repositories {
        if !content.contains(repository) {
            return Err(failure(format!(
                "{} graph does not mention selected repository {repository}",
                scenario.issue
            )));
        }
    }
    for repository in SAMPLE_REPOSITORIES {
        if !scenario
            .repositories
            .iter()
            .any(|selected| selected == repository)
            && content.contains(repository)
        {
            return Err(failure(format!(
                "{} graph leaked unselected repository {repository}",
                scenario.issue
            )));
        }
    }
    Ok(())
}

fn changed_files(worktrees: &[wts_app::MaterializedWorktree]) -> LabResult<Vec<String>> {
    let mut changed = Vec::new();
    for worktree in worktrees {
        let root = PathBuf::from(&worktree.target_display_path);
        let output = run_output(
            Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["status", "--porcelain"]),
            "git status",
        )?;
        if !output.status.success() {
            return Err(failure(format_output("git status", &output)));
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            changed.push(format!("{}:{}", worktree.label, line.trim()));
        }
    }
    changed.sort();
    Ok(changed)
}

fn verify_expected_source_changes(scenario: &Scenario, changed: &[String]) -> LabResult<()> {
    let actual = changed
        .iter()
        .filter_map(|line| {
            let (repository, status_path) = line.split_once(':')?;
            let path = status_path.strip_prefix("M ")?.trim();
            Some(format!("{repository}:{path}"))
        })
        .collect::<std::collections::BTreeSet<_>>();
    let expected = scenario
        .expected_changed_sources
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    if actual != expected {
        return Err(failure(format!(
            "{} changed unexpected tracked sources: expected {expected:?}, actual {actual:?}",
            scenario.issue
        )));
    }
    Ok(())
}

fn replace_once(path: &Path, before: &str, after: &str) -> LabResult<()> {
    let content = fs::read_to_string(path)?;
    if content.matches(before).count() != 1 {
        return Err(failure(format!(
            "expected exactly one reference pattern in {}",
            path.display()
        )));
    }
    fs::write(path, content.replacen(before, after, 1))?;
    Ok(())
}

fn hash_file(path: &Path) -> LabResult<Vec<u8>> {
    Ok(Sha256::digest(fs::read(path)?).to_vec())
}

fn write(path: &Path, content: &str) -> LabResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

fn require_selected_repository(scenario: &Scenario, repository: &str) -> LabResult<()> {
    if scenario
        .repositories
        .iter()
        .any(|selected| selected == repository)
    {
        Ok(())
    } else {
        Err(failure(format!(
            "{} references unselected repository {repository}",
            scenario.id
        )))
    }
}

fn safe_relative(value: &str) -> LabResult<PathBuf> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\0')
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::CurDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(failure(format!("unsafe relative path: {value}")));
    }
    Ok(path.to_owned())
}

fn run_checked(command: &mut Command, label: &str) -> LabResult<()> {
    let output = run_output(command, label)?;
    if !output.status.success() {
        return Err(failure(format_output(label, &output)));
    }
    Ok(())
}

fn run_output(command: &mut Command, label: &str) -> LabResult<Output> {
    command
        .env("LC_ALL", "C")
        .output()
        .map_err(|error| failure(format!("{label} could not start: {error}")))
}

fn format_output(label: &str, output: &Output) -> String {
    format!(
        "{label}\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

fn display(path: &Path) -> LabResult<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| failure("path is not valid UTF-8"))
}

fn absolute(path: PathBuf) -> LabResult<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

fn failure(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(io::Error::other(message.into()))
}
