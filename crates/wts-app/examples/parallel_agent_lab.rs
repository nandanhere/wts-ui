use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    error::Error,
    ffi::OsStr,
    fs,
    io::{self, Read},
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::{Component, Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::{Builder as TempDirBuilder, TempDir};
use uuid::Uuid;
use wts_app::{
    AgentProvider, CollaborationControl, CollaborationCoordinator, CollaborationLimits,
    CollaborationPlan, CollaborationTask, CollaborationTaskId, CollaborationTaskResult,
    CollaborationTaskState, ProcessCollaborationAdapter,
};

type LabResult<T> = Result<T, Box<dyn Error>>;

const COLLABORATION_SCHEMA_VERSION: u32 = 1;
const REPORT_SCHEMA_VERSION: u32 = 1;
const COMMAND_OUTPUT_LIMIT: usize = 512 * 1024;
const REPORT_OUTPUT_LIMIT: usize = 24 * 1024;
const DIFF_OUTPUT_LIMIT: usize = 128 * 1024;
const TEST_TIMEOUT: Duration = Duration::from_secs(30);
const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const INTEGRATION_TIMEOUT: Duration = Duration::from_secs(35);
const AGENT_TIMEOUT: Duration = Duration::from_secs(8 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Preflight,
    ValidateOnly,
    LiveCodex,
}

impl Mode {
    fn label(self) -> &'static str {
        match self {
            Self::Preflight => "preflight",
            Self::ValidateOnly => "validateOnly",
            Self::LiveCodex => "liveCodex",
        }
    }
}

struct Arguments {
    mode: Mode,
    root: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CollaborationManifest {
    schema_version: u32,
    scenario_id: String,
    title: String,
    execution: String,
    acceptance_injections: Vec<AcceptanceInjection>,
    workstreams: Vec<Workstream>,
    integration: IntegrationDefinition,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AcceptanceInjection {
    repository: String,
    source: String,
    target: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Workstream {
    id: String,
    repository: String,
    brief: String,
    allowed_paths: Vec<String>,
    verification: DirectCommand,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntegrationDefinition {
    brief: String,
    executable: String,
    arguments: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectCommand {
    executable: String,
    arguments: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackManifest {
    schema_version: u32,
    id: String,
    description: String,
    ports: Vec<StackPort>,
    processes: Vec<StackProcess>,
    smoke: StackCommand,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackPort {
    id: String,
    environment: String,
    offset: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackProcess {
    id: String,
    working_directory: String,
    executable: String,
    arguments: Vec<String>,
    dependencies: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    environment: BTreeMap<String, String>,
    health: StackHealth,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackHealth {
    port: String,
    path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackCommand {
    working_directory: String,
    executable: String,
    arguments: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    environment: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LabReport {
    schema_version: u32,
    mode: String,
    scenario_id: String,
    title: String,
    lab_root: String,
    outcome: String,
    validation_passed: bool,
    baseline_checks: Vec<CheckReport>,
    acceptance_red_before: Vec<CheckReport>,
    task_results: Vec<TaskReport>,
    overlap_proven: Option<bool>,
    acceptance_tests_preserved: Option<bool>,
    repository_diffs: Vec<RepositoryDiffReport>,
    green_after: Option<Vec<CheckReport>>,
    integration: Option<CheckReport>,
    error: Option<String>,
}

impl LabReport {
    fn new(mode: Mode, manifest: &CollaborationManifest, root: &Path) -> Self {
        Self {
            schema_version: REPORT_SCHEMA_VERSION,
            mode: mode.label().to_owned(),
            scenario_id: manifest.scenario_id.clone(),
            title: manifest.title.clone(),
            lab_root: root.display().to_string(),
            outcome: "running".to_owned(),
            validation_passed: true,
            baseline_checks: Vec::new(),
            acceptance_red_before: Vec::new(),
            task_results: Vec::new(),
            overlap_proven: None,
            acceptance_tests_preserved: None,
            repository_diffs: Vec::new(),
            green_after: None,
            integration: None,
            error: None,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckReport {
    label: String,
    repository: Option<String>,
    succeeded: bool,
    exit_code: Option<i32>,
    timed_out: bool,
    duration_ms: u64,
    output_sha256: String,
    output_tail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskReport {
    task_id: String,
    state: CollaborationTaskState,
    started_at_unix_ms: Option<i64>,
    completed_at_unix_ms: i64,
    duration_ms: u64,
    output_sha256: String,
    output_tail: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryDiffReport {
    repository: String,
    allowed_paths: Vec<String>,
    changed_paths: Vec<String>,
    allowlist_passed: bool,
    patch_sha256: String,
    patch: String,
}

struct PreparedLab {
    stack_root: PathBuf,
    runner: PathBuf,
    workspace_id: Uuid,
    repository_roots: BTreeMap<String, PathBuf>,
    acceptance: Vec<AcceptanceGuard>,
}

struct AcceptanceGuard {
    path: PathBuf,
    expected_sha256: String,
}

struct OwnedLabRoot {
    path: PathBuf,
    temporary: Option<TempDir>,
    user_supplied: bool,
}

struct CommandResult {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    output_truncated: bool,
    timed_out: bool,
    duration: Duration,
}

impl CommandResult {
    fn succeeded(&self) -> bool {
        self.status.success() && !self.timed_out && !self.output_truncated
    }

    fn combined_output(&self) -> String {
        let mut output = String::from_utf8_lossy(&self.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&self.stderr);
        if !stderr.is_empty() {
            if !output.is_empty() && !output.ends_with('\n') {
                output.push('\n');
            }
            output.push_str(&stderr);
        }
        if self.output_truncated {
            output.push_str("\n[output exceeded the lab capture limit]");
        }
        output
    }
}

struct CapturedStream {
    bytes: Vec<u8>,
    truncated: bool,
}

fn main() -> LabResult<()> {
    let arguments = parse_arguments()?;
    let fixture_root = fixture_root()?;
    let manifest = load_and_validate_manifests(&fixture_root)?;
    if arguments.mode == Mode::ValidateOnly {
        println!(
            "Validated {}: two disjoint phase-0 workstreams, two acceptance injections, and one deterministic integration probe.",
            fixture_root.join("agent-collaboration.json").display()
        );
        return Ok(());
    }

    let owned_root = create_lab_root(arguments.root)?;
    let mut report = LabReport::new(arguments.mode, &manifest, &owned_root.path);
    let result = run_lab(
        &fixture_root,
        &owned_root.path,
        &manifest,
        arguments.mode,
        &mut report,
    );

    match result {
        Ok(()) => {
            write_report(&owned_root.path, &report)?;
            if owned_root.user_supplied {
                println!("Lab preserved at {}", owned_root.path.display());
            } else {
                println!("Temporary lab completed; its files will now be removed.");
            }
            drop(owned_root.temporary);
            Ok(())
        }
        Err(error) => {
            report.outcome = "failed".to_owned();
            report.error = Some(error.to_string());
            let report_result = write_report(&owned_root.path, &report);
            if owned_root.user_supplied {
                eprintln!("Failed lab preserved at {}", owned_root.path.display());
                eprintln!(
                    "Partial report: {}",
                    owned_root.path.join("lab-report.json").display()
                );
            }
            if let Err(report_error) = report_result {
                return Err(failure(format!(
                    "{error}; additionally could not write the partial report: {report_error}"
                )));
            }
            Err(error)
        }
    }
}

fn run_lab(
    fixture_root: &Path,
    root: &Path,
    manifest: &CollaborationManifest,
    mode: Mode,
    report: &mut LabReport,
) -> LabResult<()> {
    let prepared = prepare_lab(fixture_root, root, manifest, report)?;
    println!(
        "Acceptance contract is red in both repositories inside {}.",
        prepared.stack_root.display()
    );

    if mode == Mode::Preflight {
        report.outcome = "preflightReady".to_owned();
        println!(
            "Preflight complete. No agent was started and no green result is claimed. Re-run with --live-codex to dispatch the two confined workstreams."
        );
        return Ok(());
    }

    if mode != Mode::LiveCodex {
        return Err(failure("unsupported lab mode"));
    }

    run_live_collaboration(&prepared, manifest, report)?;
    if let Err(error) = verify_acceptance_guards(&prepared.acceptance) {
        report.acceptance_tests_preserved = Some(false);
        return Err(error);
    }
    report.acceptance_tests_preserved = Some(true);

    let mut diffs = Vec::new();
    for workstream in &manifest.workstreams {
        let repository_root = prepared
            .repository_roots
            .get(&workstream.repository)
            .ok_or_else(|| failure("validated workstream repository disappeared"))?;
        diffs.push(repository_diff(repository_root, workstream)?);
    }
    let allowlists_passed = diffs.iter().all(|diff| diff.allowlist_passed);
    report.repository_diffs = diffs;
    if !allowlists_passed {
        return Err(failure(
            "an agent changed a path outside its workstream allowlist",
        ));
    }

    let green = run_verification_checks(&prepared.repository_roots, manifest)?;
    if green.iter().any(|check| !check.succeeded) {
        report.green_after = Some(green);
        return Err(failure(
            "one or more repository acceptance checks stayed red after collaboration",
        ));
    }
    report.green_after = Some(green);

    let integration = run_integration(&prepared, manifest)?;
    let integration_passed = integration.succeeded;
    report.integration = Some(integration);
    if !integration_passed {
        return Err(failure(
            "the deterministic frontend/backend integration probe failed",
        ));
    }

    report.outcome = "passed".to_owned();
    println!(
        "Parallel Codex collaboration passed: overlap proven, tests preserved, diffs confined, both repositories green, and integration green."
    );
    Ok(())
}

fn prepare_lab(
    fixture_root: &Path,
    root: &Path,
    manifest: &CollaborationManifest,
    report: &mut LabReport,
) -> LabResult<PreparedLab> {
    let service_stacks = root.join("service-stacks");
    let stack_root = service_stacks.join("frontend-backend");
    copy_directory(fixture_root, &stack_root)?;
    copy_directory(
        fixture_root
            .parent()
            .ok_or_else(|| failure("fixture directory has no parent"))?
            .join("lib")
            .as_path(),
        service_stacks.join("lib").as_path(),
    )?;
    copy_file(
        fixture_root
            .parent()
            .ok_or_else(|| failure("fixture directory has no parent"))?
            .join("run-stack.mjs")
            .as_path(),
        service_stacks.join("run-stack.mjs").as_path(),
    )?;

    let copied_manifest =
        load_collaboration_manifest(&stack_root.join("agent-collaboration.json"))?;
    validate_collaboration_manifest(&copied_manifest, &stack_root)?;
    if copied_manifest.scenario_id != manifest.scenario_id {
        return Err(failure("copied collaboration manifest identity changed"));
    }

    let mut repository_roots = BTreeMap::new();
    for workstream in &manifest.workstreams {
        let repository = stack_root.join(safe_relative(&workstream.repository)?);
        let canonical = repository.canonicalize().map_err(|error| {
            failure(format!(
                "repository scope {} is unavailable: {error}",
                repository.display()
            ))
        })?;
        repository_roots.insert(workstream.repository.clone(), canonical);
    }

    report.baseline_checks = run_verification_checks(&repository_roots, manifest)?;
    if report.baseline_checks.iter().any(|check| !check.succeeded) {
        return Err(failure(
            "the untouched fixture baseline failed before acceptance injection",
        ));
    }

    let acceptance = inject_acceptance(&stack_root, &repository_roots, manifest)?;
    for repository in repository_roots.values() {
        initialize_repository(repository)?;
    }
    make_acceptance_read_only(&acceptance)?;

    report.acceptance_red_before = run_verification_checks(&repository_roots, manifest)?;
    if report
        .acceptance_red_before
        .iter()
        .any(|check| check.succeeded || check.timed_out)
    {
        return Err(failure(
            "each injected acceptance contract must fail cleanly before collaboration",
        ));
    }

    Ok(PreparedLab {
        stack_root: stack_root.canonicalize()?,
        runner: service_stacks.join("run-stack.mjs").canonicalize()?,
        workspace_id: Uuid::new_v4(),
        repository_roots,
        acceptance,
    })
}

fn run_live_collaboration(
    prepared: &PreparedLab,
    manifest: &CollaborationManifest,
    report: &mut LabReport,
) -> LabResult<()> {
    let limits = CollaborationLimits {
        maximum_parallel_agents: 2,
        maximum_tasks_per_run: 2,
        maximum_task_timeout: AGENT_TIMEOUT,
        maximum_prompt_bytes: 24 * 1024,
        maximum_output_bytes: 512 * 1024,
        maximum_retained_evidence: 2,
        maximum_retained_evidence_bytes: 1024 * 1024,
    };
    let coordinator = CollaborationCoordinator::new(ProcessCollaborationAdapter::new(), limits)?;
    let mut tasks = Vec::with_capacity(2);
    for workstream in &manifest.workstreams {
        let repository_root = prepared
            .repository_roots
            .get(&workstream.repository)
            .ok_or_else(|| failure("validated repository scope is missing"))?;
        let brief_path = prepared.stack_root.join(safe_relative(&workstream.brief)?);
        let brief = read_small_text(&brief_path, 16 * 1024)?;
        let prompt = agent_prompt(manifest, workstream, &brief);
        tasks.push(CollaborationTask {
            task_id: CollaborationTaskId::parse(workstream.id.clone())?,
            workspace_id: prepared.workspace_id,
            workspace_root: prepared.stack_root.clone(),
            scope_root: repository_root.clone(),
            provider: AgentProvider::Codex,
            prompt,
            phase: 0,
            timeout: AGENT_TIMEOUT,
        });
    }
    if tasks.len() != 2 || tasks.iter().any(|task| task.phase != 0) {
        return Err(failure(
            "the live lab requires exactly two phase-0 collaboration tasks",
        ));
    }

    println!("Dispatching exactly two confined Codex tasks in phase 0...");
    let collaboration = coordinator.execute(
        CollaborationPlan {
            collaboration_id: Uuid::new_v4(),
            tasks,
        },
        &CollaborationControl::default(),
    )?;
    report.task_results = collaboration.tasks.iter().map(task_report).collect();

    let overlap = collaboration_overlap(&collaboration.tasks);
    report.overlap_proven = Some(overlap);
    if collaboration.tasks.len() != 2 {
        return Err(failure(
            "collaboration returned a result count other than two",
        ));
    }
    if collaboration
        .tasks
        .iter()
        .any(|task| task.state != CollaborationTaskState::Succeeded)
    {
        return Err(failure("one or both Codex workstreams failed"));
    }
    if !overlap {
        return Err(failure(
            "task timestamps show that the two Codex workstreams serialized instead of overlapping",
        ));
    }
    Ok(())
}

fn agent_prompt(manifest: &CollaborationManifest, workstream: &Workstream, brief: &str) -> String {
    let allowed = workstream
        .allowed_paths
        .iter()
        .map(|path| format!("- {path}"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You are one of exactly two WTS workstreams running concurrently for {}.\n\
         Work only in the current repository scope ({}) and solve this workstream directly.\n\
         \n\
         {}\n\
         \n\
         Writable source allowlist:\n{}\n\
         \n\
         Hard constraints:\n\
         - Modify only the allowlisted source paths above.\n\
         - Never modify tests, package metadata, Git metadata, or any sibling repository.\n\
         - The injected acceptance tests are host-owned contract evidence and are read-only.\n\
         - Do not create extra files and do not commit changes.\n\
         - Run `npm test --silent` before returning.\n\
         - Keep the existing default behavior exactly intact.\n\
         Report the files changed and the verification result in your final response.",
        manifest.scenario_id, workstream.repository, brief, allowed
    )
}

fn collaboration_overlap(tasks: &[CollaborationTaskResult]) -> bool {
    if tasks.len() != 2 || tasks.iter().any(|task| task.started_at_unix_ms.is_none()) {
        return false;
    }
    let latest_start = tasks
        .iter()
        .filter_map(|task| task.started_at_unix_ms)
        .max();
    let earliest_completion = tasks.iter().map(|task| task.completed_at_unix_ms).min();
    matches!(
        (latest_start, earliest_completion),
        (Some(started), Some(completed)) if started < completed
    )
}

fn task_report(task: &CollaborationTaskResult) -> TaskReport {
    TaskReport {
        task_id: task.task_id.as_str().to_owned(),
        state: task.state,
        started_at_unix_ms: task.started_at_unix_ms,
        completed_at_unix_ms: task.completed_at_unix_ms,
        duration_ms: task.duration_ms,
        output_sha256: sha256(task.output.as_bytes()),
        output_tail: bounded_tail(&task.output, REPORT_OUTPUT_LIMIT),
    }
}

fn run_verification_checks(
    repository_roots: &BTreeMap<String, PathBuf>,
    manifest: &CollaborationManifest,
) -> LabResult<Vec<CheckReport>> {
    let mut reports = Vec::with_capacity(manifest.workstreams.len());
    for workstream in &manifest.workstreams {
        let root = repository_roots
            .get(&workstream.repository)
            .ok_or_else(|| failure("workstream repository is missing"))?;
        let mut command = Command::new(&workstream.verification.executable);
        command
            .args(&workstream.verification.arguments)
            .current_dir(root);
        let result = run_bounded(&mut command, TEST_TIMEOUT)?;
        reports.push(check_report(
            format!("{} npm acceptance", workstream.id),
            Some(workstream.repository.clone()),
            &result,
        ));
    }
    Ok(reports)
}

fn inject_acceptance(
    stack_root: &Path,
    repositories: &BTreeMap<String, PathBuf>,
    manifest: &CollaborationManifest,
) -> LabResult<Vec<AcceptanceGuard>> {
    let mut guards = Vec::with_capacity(manifest.acceptance_injections.len());
    for injection in &manifest.acceptance_injections {
        let source = stack_root.join(safe_relative(&injection.source)?);
        let repository = repositories
            .get(&injection.repository)
            .ok_or_else(|| failure("acceptance injection repository is missing"))?;
        let target = repository.join(safe_relative(&injection.target)?);
        copy_file(&source, &target)?;
        guards.push(AcceptanceGuard {
            expected_sha256: hash_file(&target)?,
            path: target,
        });
    }
    Ok(guards)
}

fn make_acceptance_read_only(acceptance: &[AcceptanceGuard]) -> LabResult<()> {
    for guard in acceptance {
        let mut permissions = fs::metadata(&guard.path)?.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&guard.path, permissions)?;
    }
    Ok(())
}

fn verify_acceptance_guards(acceptance: &[AcceptanceGuard]) -> LabResult<()> {
    for guard in acceptance {
        let actual = hash_file(&guard.path).map_err(|error| {
            failure(format!(
                "acceptance test {} is missing or unreadable: {error}",
                guard.path.display()
            ))
        })?;
        if actual != guard.expected_sha256 {
            return Err(failure(format!(
                "agent modified host-owned acceptance test {}",
                guard.path.display()
            )));
        }
    }
    Ok(())
}

fn repository_diff(root: &Path, workstream: &Workstream) -> LabResult<RepositoryDiffReport> {
    let changed = git_changed_paths(root)?;
    let allowed = workstream
        .allowed_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    let allowlist_passed = !changed.is_empty() && changed.iter().all(|path| allowed.contains(path));

    let mut command = Command::new("git");
    command
        .args([
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--no-renames",
            "--unified=3",
            "HEAD",
            "--",
        ])
        .args(&workstream.allowed_paths)
        .current_dir(root);
    let patch_result = run_bounded(&mut command, GIT_TIMEOUT)?;
    if !patch_result.succeeded() {
        return Err(command_failure("git diff", &patch_result));
    }
    let patch = String::from_utf8(patch_result.stdout)
        .map_err(|_| failure("git diff returned non-UTF-8 data"))?;
    if patch.len() > DIFF_OUTPUT_LIMIT {
        return Err(failure("repository patch exceeded the report limit"));
    }
    Ok(RepositoryDiffReport {
        repository: workstream.repository.clone(),
        allowed_paths: allowed.into_iter().collect(),
        changed_paths: changed,
        allowlist_passed,
        patch_sha256: sha256(patch.as_bytes()),
        patch,
    })
}

fn git_changed_paths(root: &Path) -> LabResult<Vec<String>> {
    let mut diff_command = Command::new("git");
    diff_command
        .args(["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"])
        .current_dir(root);
    let diff = run_bounded(&mut diff_command, GIT_TIMEOUT)?;
    if !diff.succeeded() {
        return Err(command_failure("git diff --name-only", &diff));
    }

    let mut untracked_command = Command::new("git");
    untracked_command
        .args(["ls-files", "--others", "--exclude-standard", "-z"])
        .current_dir(root);
    let untracked = run_bounded(&mut untracked_command, GIT_TIMEOUT)?;
    if !untracked.succeeded() {
        return Err(command_failure("git ls-files", &untracked));
    }

    let mut paths = BTreeSet::new();
    for bytes in [&diff.stdout, &untracked.stdout] {
        for raw in bytes
            .split(|byte| *byte == 0)
            .filter(|path| !path.is_empty())
        {
            let path = std::str::from_utf8(raw)
                .map_err(|_| failure("Git returned a non-UTF-8 changed path"))?;
            let normalized = safe_relative(path)?;
            paths.insert(portable_path(&normalized)?);
        }
    }
    Ok(paths.into_iter().collect())
}

fn run_integration(
    prepared: &PreparedLab,
    manifest: &CollaborationManifest,
) -> LabResult<CheckReport> {
    let source_stack = load_stack_manifest(&prepared.stack_root.join("wts-stack.json"))?;
    validate_stack_manifest(&source_stack, &prepared.stack_root)?;
    let mut integration_stack = source_stack;
    integration_stack.smoke = StackCommand {
        working_directory: ".".to_owned(),
        executable: manifest.integration.executable.clone(),
        arguments: manifest.integration.arguments.clone(),
        environment: BTreeMap::new(),
    };
    let integration_manifest = prepared.stack_root.join("wts-collaboration-stack.json");
    fs::write(
        &integration_manifest,
        serde_json::to_vec_pretty(&integration_stack)?,
    )?;

    let offsets = integration_stack
        .ports
        .iter()
        .map(|port| port.offset)
        .collect::<Vec<_>>();
    let base_port = available_base_port(&offsets)?;
    let state = prepared.stack_root.join(".wts-lab-state");
    fs::create_dir_all(&state)?;
    let instance = format!("parallel-{}", std::process::id());

    let mut command = Command::new("node");
    command
        .arg(&prepared.runner)
        .arg("--manifest")
        .arg(&integration_manifest)
        .arg("--base-port")
        .arg(base_port.to_string())
        .arg("--instance")
        .arg(&instance)
        .arg("--state-dir")
        .arg(&state)
        .args(["--smoke", "--exit-after-smoke"])
        .current_dir(
            prepared
                .runner
                .parent()
                .ok_or_else(|| failure("stack runner has no parent directory"))?,
        );
    let result = run_bounded(&mut command, INTEGRATION_TIMEOUT)?;
    let combined = result.combined_output();
    let probe_markers_present = combined.contains("WTS_STACK_SMOKE_PASSED")
        && combined.contains("parallel frontend/backend change integrated");
    let ports_released = offsets.iter().all(|offset| {
        TcpListener::bind(SocketAddrV4::new(
            Ipv4Addr::LOCALHOST,
            base_port.saturating_add(*offset),
        ))
        .is_ok()
    });
    let mut check = check_report("parallel stack integration".to_owned(), None, &result);
    check.succeeded = check.succeeded && probe_markers_present && ports_released;
    if !probe_markers_present {
        check
            .output_tail
            .push_str("\n[required integration marker was absent]");
    }
    if !ports_released {
        check
            .output_tail
            .push_str("\n[one or more fixture ports remained bound]");
    }
    Ok(check)
}

fn available_base_port(offsets: &[u16]) -> LabResult<u16> {
    let maximum_offset = offsets.iter().copied().max().unwrap_or(0);
    let range_end = 65_000u16.saturating_sub(maximum_offset);
    let span = range_end.saturating_sub(40_000).max(1);
    let seed = u16::try_from(std::process::id() % u32::from(span)).unwrap_or(0);
    for attempt in 0..span {
        let base = 40_000 + (seed + attempt) % span;
        let mut listeners = Vec::with_capacity(offsets.len());
        let mut available = true;
        for offset in offsets {
            match TcpListener::bind(SocketAddrV4::new(
                Ipv4Addr::LOCALHOST,
                base.saturating_add(*offset),
            )) {
                Ok(listener) => listeners.push(listener),
                Err(_) => {
                    available = false;
                    break;
                }
            }
        }
        if available {
            return Ok(base);
        }
    }
    Err(failure("could not find an available local port range"))
}

fn initialize_repository(root: &Path) -> LabResult<()> {
    run_checked(
        Command::new("git")
            .args(["init", "--quiet"])
            .current_dir(root),
        "git init",
    )?;
    for (key, value) in [
        ("user.name", "WTS Parallel Lab"),
        ("user.email", "wts-parallel-lab@example.invalid"),
        ("commit.gpgSign", "false"),
    ] {
        run_checked(
            Command::new("git")
                .args(["config", key, value])
                .current_dir(root),
            "git config",
        )?;
    }
    run_checked(
        Command::new("git")
            .args(["add", "--all", "--"])
            .current_dir(root),
        "git add",
    )?;
    run_checked(
        Command::new("git")
            .args(["commit", "--quiet", "-m", "Create parallel lab baseline"])
            .current_dir(root),
        "git commit",
    )?;
    run_checked(
        Command::new("git")
            .args(["branch", "-M", "main"])
            .current_dir(root),
        "git branch",
    )
}

fn run_checked(command: &mut Command, label: &str) -> LabResult<()> {
    let result = run_bounded(command, GIT_TIMEOUT)?;
    if result.succeeded() {
        Ok(())
    } else {
        Err(command_failure(label, &result))
    }
}

fn run_bounded(command: &mut Command, timeout: Duration) -> LabResult<CommandResult> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(command);
    let started = Instant::now();
    let mut child = command.spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| failure("child stdout was not captured"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| failure("child stderr was not captured"))?;
    let stdout_reader = capture_stream(stdout);
    let stderr_reader = capture_stream(stderr);

    let deadline = started + timeout;
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait()? {
            break (status, false);
        }
        if Instant::now() >= deadline {
            terminate_process_group(&mut child)?;
            let status = child.try_wait()?.ok_or_else(|| {
                failure("timed-out child did not report an exit status after termination")
            })?;
            break (status, true);
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = join_capture(stdout_reader)?;
    let stderr = join_capture(stderr_reader)?;
    Ok(CommandResult {
        status,
        output_truncated: stdout.truncated || stderr.truncated,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        timed_out,
        duration: started.elapsed(),
    })
}

fn capture_stream(
    mut stream: impl Read + Send + 'static,
) -> thread::JoinHandle<io::Result<CapturedStream>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 8192];
        let mut truncated = false;
        loop {
            let read = stream.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            let remaining = COMMAND_OUTPUT_LIMIT.saturating_sub(bytes.len());
            let accepted = remaining.min(read);
            bytes.extend_from_slice(&buffer[..accepted]);
            truncated |= accepted < read;
        }
        Ok(CapturedStream { bytes, truncated })
    })
}

fn join_capture(
    handle: thread::JoinHandle<io::Result<CapturedStream>>,
) -> LabResult<CapturedStream> {
    handle
        .join()
        .map_err(|_| failure("output capture thread panicked"))?
        .map_err(Into::into)
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn configure_process_group(_command: &mut Command) {}

#[cfg(unix)]
fn terminate_process_group(child: &mut Child) -> LabResult<()> {
    let group = i32::try_from(child.id())
        .map_err(|_| failure("child process identifier does not fit in a process group"))?;
    // SAFETY: `configure_process_group` created a child-owned group with the
    // child PID as its group ID. A negative target addresses that group only.
    let result = unsafe { libc::kill(-group, libc::SIGKILL) };
    if result == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error.into());
        }
    }
    child.wait()?;
    Ok(())
}

#[cfg(not(unix))]
fn terminate_process_group(child: &mut Child) -> LabResult<()> {
    if let Err(error) = child.kill()
        && error.kind() != io::ErrorKind::InvalidInput
    {
        return Err(error.into());
    }
    child.wait()?;
    Ok(())
}

fn check_report(label: String, repository: Option<String>, result: &CommandResult) -> CheckReport {
    let output = result.combined_output();
    CheckReport {
        label,
        repository,
        succeeded: result.succeeded(),
        exit_code: result.status.code(),
        timed_out: result.timed_out,
        duration_ms: duration_ms(result.duration),
        output_sha256: sha256(output.as_bytes()),
        output_tail: bounded_tail(&output, REPORT_OUTPUT_LIMIT),
    }
}

fn command_failure(label: &str, result: &CommandResult) -> Box<dyn Error> {
    failure(format!(
        "{label} failed (status {:?}, timeout {}, truncated {}):\n{}",
        result.status.code(),
        result.timed_out,
        result.output_truncated,
        bounded_tail(&result.combined_output(), REPORT_OUTPUT_LIMIT)
    ))
}

fn parse_arguments() -> LabResult<Arguments> {
    let mut mode = Mode::Preflight;
    let mut root = None;
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--root" => {
                let value = arguments
                    .next()
                    .ok_or_else(|| failure("--root requires a path"))?;
                root = Some(absolute(PathBuf::from(value))?);
            }
            "--validate-only" => {
                if mode != Mode::Preflight {
                    return Err(failure(
                        "--validate-only and --live-codex are mutually exclusive",
                    ));
                }
                mode = Mode::ValidateOnly;
            }
            "--live-codex" => {
                if mode != Mode::Preflight {
                    return Err(failure(
                        "--validate-only and --live-codex are mutually exclusive",
                    ));
                }
                mode = Mode::LiveCodex;
            }
            "--help" | "-h" => {
                println!(
                    "Usage: parallel_agent_lab [--root PATH] [--validate-only | --live-codex]\n\
                     \n\
                     With no mode flag, prepares fresh backend/frontend Git scopes and proves both\n\
                     injected contracts start red; it does not call an LLM or claim green.\n\
                     --validate-only parses the strict fixture manifests without creating a lab.\n\
                     --live-codex explicitly dispatches exactly two confined Codex tasks in parallel."
                );
                std::process::exit(0);
            }
            _ => return Err(failure(format!("unknown argument: {argument}"))),
        }
    }
    if mode == Mode::ValidateOnly && root.is_some() {
        return Err(failure("--root cannot be combined with --validate-only"));
    }
    Ok(Arguments { mode, root })
}

fn fixture_root() -> LabResult<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/service-stacks/frontend-backend")
        .canonicalize()
        .map_err(|error| {
            failure(format!(
                "frontend-backend fixture is unavailable relative to the crate: {error}"
            ))
        })
}

fn create_lab_root(requested: Option<PathBuf>) -> LabResult<OwnedLabRoot> {
    match requested {
        Some(path) => {
            if path.exists() {
                return Err(failure(format!(
                    "lab root already exists; choose a fresh path: {}",
                    path.display()
                )));
            }
            fs::create_dir_all(&path)?;
            Ok(OwnedLabRoot {
                path: path.canonicalize()?,
                temporary: None,
                user_supplied: true,
            })
        }
        None => {
            let temporary = TempDirBuilder::new()
                .prefix("wts-parallel-agent-lab-")
                .tempdir()?;
            Ok(OwnedLabRoot {
                path: temporary.path().canonicalize()?,
                temporary: Some(temporary),
                user_supplied: false,
            })
        }
    }
}

fn load_and_validate_manifests(fixture_root: &Path) -> LabResult<CollaborationManifest> {
    let collaboration =
        load_collaboration_manifest(&fixture_root.join("agent-collaboration.json"))?;
    validate_collaboration_manifest(&collaboration, fixture_root)?;
    let stack = load_stack_manifest(&fixture_root.join("wts-stack.json"))?;
    validate_stack_manifest(&stack, fixture_root)?;
    Ok(collaboration)
}

fn load_collaboration_manifest(path: &Path) -> LabResult<CollaborationManifest> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        failure(format!(
            "invalid collaboration manifest {}: {error}",
            path.display()
        ))
    })
}

fn load_stack_manifest(path: &Path) -> LabResult<StackManifest> {
    let bytes = fs::read(path)?;
    serde_json::from_slice(&bytes).map_err(|error| {
        failure(format!(
            "invalid stack manifest {}: {error}",
            path.display()
        ))
    })
}

fn validate_collaboration_manifest(manifest: &CollaborationManifest, root: &Path) -> LabResult<()> {
    if manifest.schema_version != COLLABORATION_SCHEMA_VERSION
        || !valid_identifier(&manifest.scenario_id)
        || manifest.title.trim().is_empty()
        || manifest.execution != "parallel-then-integrate"
    {
        return Err(failure(
            "collaboration manifest identity or execution contract is invalid",
        ));
    }
    if manifest.workstreams.len() != 2 || manifest.acceptance_injections.len() != 2 {
        return Err(failure(
            "parallel lab requires exactly two workstreams and two acceptance injections",
        ));
    }

    let expected_repositories = BTreeSet::from(["backend", "frontend"]);
    let repositories = manifest
        .workstreams
        .iter()
        .map(|workstream| workstream.repository.as_str())
        .collect::<BTreeSet<_>>();
    if repositories != expected_repositories {
        return Err(failure(
            "workstreams must independently target backend and frontend",
        ));
    }
    let mut task_ids = BTreeSet::new();
    for workstream in &manifest.workstreams {
        CollaborationTaskId::parse(workstream.id.clone())?;
        if !task_ids.insert(workstream.id.as_str())
            || workstream.allowed_paths.is_empty()
            || workstream.verification.executable != "npm"
            || workstream.verification.arguments != ["test", "--silent"]
        {
            return Err(failure("workstream contract is invalid or unsafe"));
        }
        let brief = safe_relative(&workstream.brief)?;
        require_regular_file(&root.join(brief), "workstream brief")?;
        let mut allowed = BTreeSet::new();
        for path in &workstream.allowed_paths {
            let path = safe_relative(path)?;
            if path.components().next() != Some(Component::Normal(OsStr::new("src")))
                || !allowed.insert(portable_path(&path)?)
            {
                return Err(failure(
                    "workstream allowlists must contain unique src/ paths",
                ));
            }
            require_regular_file(
                &root.join(&workstream.repository).join(path),
                "allowlisted source",
            )?;
        }
    }

    let mut injection_repositories = BTreeSet::new();
    for injection in &manifest.acceptance_injections {
        if !expected_repositories.contains(injection.repository.as_str())
            || !injection_repositories.insert(injection.repository.as_str())
        {
            return Err(failure(
                "each repository must have one acceptance injection",
            ));
        }
        let source = safe_relative(&injection.source)?;
        let target = safe_relative(&injection.target)?;
        if !source.starts_with("collaboration/acceptance") || !target.starts_with("test") {
            return Err(failure(
                "acceptance injection paths are outside their roles",
            ));
        }
        require_regular_file(&root.join(source), "acceptance source")?;
    }

    let integration_brief = safe_relative(&manifest.integration.brief)?;
    require_regular_file(&root.join(integration_brief), "integration brief")?;
    if manifest.integration.executable != "node"
        || manifest.integration.arguments != ["collaboration/smoke.mjs"]
    {
        return Err(failure(
            "integration probe must be the dependency-free collaboration smoke script",
        ));
    }
    require_regular_file(&root.join("collaboration/smoke.mjs"), "integration smoke")
}

fn validate_stack_manifest(manifest: &StackManifest, root: &Path) -> LabResult<()> {
    if manifest.schema_version != 1
        || !valid_identifier(&manifest.id)
        || manifest.description.trim().is_empty()
        || manifest.ports.is_empty()
        || manifest.processes.is_empty()
    {
        return Err(failure("stack manifest identity is invalid"));
    }
    let mut port_ids = BTreeSet::new();
    let mut offsets = BTreeSet::new();
    let mut environments = BTreeSet::new();
    for port in &manifest.ports {
        if !valid_identifier(&port.id)
            || port.offset > 9
            || !valid_port_environment(&port.environment)
            || !port_ids.insert(port.id.as_str())
            || !offsets.insert(port.offset)
            || !environments.insert(port.environment.as_str())
        {
            return Err(failure("stack port definition is invalid"));
        }
    }
    let mut process_ids = BTreeSet::new();
    for process in &manifest.processes {
        if !valid_identifier(&process.id)
            || !process_ids.insert(process.id.as_str())
            || process.executable != "node"
            || process.arguments.is_empty()
            || process
                .arguments
                .iter()
                .any(|argument| !safe_argument(argument))
            || process
                .dependencies
                .iter()
                .any(|dependency| !process_ids.contains(dependency.as_str()))
            || !port_ids.contains(process.health.port.as_str())
            || !valid_health_path(&process.health.path)
            || process.environment.iter().any(|(key, value)| {
                !valid_environment_key(key) || value.contains('\0') || value.len() > 1024
            })
        {
            return Err(failure("stack process definition is invalid"));
        }
        let workdir = safe_relative(&process.working_directory)?;
        require_directory(&root.join(workdir), "stack process working directory")?;
    }
    validate_stack_command(&manifest.smoke, root)
}

fn validate_stack_command(command: &StackCommand, root: &Path) -> LabResult<()> {
    if command.executable != "node"
        || command.arguments.is_empty()
        || command
            .arguments
            .iter()
            .any(|argument| !safe_argument(argument))
        || command.environment.iter().any(|(key, value)| {
            !valid_environment_key(key) || value.contains('\0') || value.len() > 1024
        })
    {
        return Err(failure("stack smoke command is invalid"));
    }
    let working_directory = safe_working_directory(&command.working_directory)?;
    require_directory(
        &root.join(working_directory),
        "stack smoke working directory",
    )
}

fn safe_relative(value: impl AsRef<Path>) -> LabResult<PathBuf> {
    let value = value.as_ref();
    if value.as_os_str().is_empty() || value.is_absolute() {
        return Err(failure("path must be a non-empty relative path"));
    }
    for component in value.components() {
        match component {
            Component::Normal(part) if part != OsStr::new(".git") => {}
            _ => {
                return Err(failure(format!(
                    "path contains a forbidden component: {}",
                    value.display()
                )));
            }
        }
    }
    Ok(value.to_owned())
}

fn safe_working_directory(value: impl AsRef<Path>) -> LabResult<PathBuf> {
    let value = value.as_ref();
    if value == Path::new(".") {
        Ok(PathBuf::from("."))
    } else {
        safe_relative(value)
    }
}

fn portable_path(path: &Path) -> LabResult<String> {
    let parts = path
        .components()
        .map(|component| match component {
            Component::Normal(value) => value
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| failure("path is not valid UTF-8")),
            _ => Err(failure("path is not portable")),
        })
        .collect::<LabResult<Vec<_>>>()?;
    Ok(parts.join("/"))
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_port_environment(value: &str) -> bool {
    value.ends_with("_PORT")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_environment_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn valid_health_path(value: &str) -> bool {
    value.starts_with('/') && value.len() <= 256 && !value.contains('\0')
}

fn safe_argument(value: &str) -> bool {
    !value.contains('\0') && value.len() <= 1024
}

fn require_regular_file(path: &Path, label: &str) -> LabResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(failure(format!("{label} is not a regular file")));
    }
    Ok(())
}

fn require_directory(path: &Path, label: &str) -> LabResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() {
        return Err(failure(format!("{label} is not a directory")));
    }
    Ok(())
}

fn copy_directory(source: &Path, target: &Path) -> LabResult<()> {
    require_directory(source, "copy source")?;
    fs::create_dir_all(target)?;
    let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for entry in entries {
        let file_type = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if file_type.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            copy_file(&entry.path(), &destination)?;
        } else {
            return Err(failure(format!(
                "fixture contains an unsupported symlink or special file: {}",
                entry.path().display()
            )));
        }
    }
    Ok(())
}

fn copy_file(source: &Path, target: &Path) -> LabResult<()> {
    require_regular_file(source, "copy source")?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(source, target)?;
    Ok(())
}

fn hash_file(path: &Path) -> LabResult<String> {
    Ok(sha256(&fs::read(path)?))
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn read_small_text(path: &Path, maximum_bytes: usize) -> LabResult<String> {
    let bytes = fs::read(path)?;
    if bytes.len() > maximum_bytes {
        return Err(failure(format!(
            "text file {} exceeds {maximum_bytes} bytes",
            path.display()
        )));
    }
    String::from_utf8(bytes).map_err(|_| failure("expected UTF-8 text"))
}

fn bounded_tail(value: &str, maximum_bytes: usize) -> String {
    if value.len() <= maximum_bytes {
        return value.to_owned();
    }
    let mut start = value.len() - maximum_bytes;
    while !value.is_char_boundary(start) {
        start += 1;
    }
    format!("[earlier output omitted]\n{}", &value[start..])
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn write_report(root: &Path, report: &LabReport) -> LabResult<()> {
    fs::write(
        root.join("lab-report.json"),
        serde_json::to_vec_pretty(report)?,
    )?;
    println!("Report: {}", root.join("lab-report.json").display());
    Ok(())
}

fn absolute(path: PathBuf) -> LabResult<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

fn failure(message: impl Into<String>) -> Box<dyn Error> {
    io::Error::other(message.into()).into()
}
