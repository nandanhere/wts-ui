use serde::Serialize;
use std::{
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::LocalWtsService;
use wts_core::workspace::{
    CreateWorkspaceRequest, WorkspaceIntent, WorkspaceProvider, WorkspaceRepositoryRequest,
};

type ProfileResult<T> = Result<T, Box<dyn Error>>;
const SCHEMA_VERSION: u32 = 1;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileReport {
    schema_version: u32,
    workspace_count: usize,
    repository_count: usize,
    host_os: String,
    host_arch: String,
    passed_resource_budgets: bool,
    budget_violations: Vec<String>,
    phases: Vec<PhaseSample>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseSample {
    name: String,
    wall_ms: u128,
    rss_kib: Option<u64>,
    virtual_memory_kib: Option<u64>,
    open_file_descriptors: Option<u64>,
    threads: Option<u64>,
    child_processes: Option<u64>,
    workspace_disk_bytes: u64,
}

fn main() -> ProfileResult<()> {
    let (workspace_count, output) = arguments()?;
    let fixture = TempDir::new()?;
    let repository_root = fixture.path().join("repositories");
    let workspace_root = fixture.path().join("workspaces");
    let data_root = fixture.path().join("data");
    fs::create_dir_all(&repository_root)?;
    fs::create_dir_all(&workspace_root)?;
    create_repository(&repository_root.join("sample-service"))?;

    let service = LocalWtsService::open(
        &data_root,
        "many-workspace-profile",
        &workspace_root,
        &repository_root,
    )?;
    let started = Instant::now();
    let mut phases = vec![sample("service-open", started.elapsed(), &workspace_root)?];
    let mut workspaces = Vec::with_capacity(workspace_count);

    let phase = Instant::now();
    for index in 0..workspace_count {
        let issue_key = format!("LOAD-{}", index + 1);
        let created = service.create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::Jira { issue_key },
                title: format!("Resource profile workspace {}", index + 1),
                preferred_provider: WorkspaceProvider::VsCode,
                repositories: vec![WorkspaceRepositoryRequest {
                    repository_id: None,
                    label: "sample-service".to_owned(),
                    base_ref: "main".to_owned(),
                }],
                runtime: None,
                planning: None,
            },
        )?;
        workspaces.push(created.workspace.workspace_id);
    }
    phases.push(sample(
        "plans-registered",
        phase.elapsed(),
        &workspace_root,
    )?);

    let phase = Instant::now();
    for workspace_id in &workspaces {
        let preflight = service.preflight_workspace(*workspace_id)?;
        if !preflight.ready {
            return Err(format!("preflight blocked for {workspace_id:?}").into());
        }
        service.materialize_workspace(*workspace_id, &preflight.effect_digest)?;
    }
    phases.push(sample(
        "worktrees-materialized",
        phase.elapsed(),
        &workspace_root,
    )?);

    let phase = Instant::now();
    for workspace_id in &workspaces {
        service.index_workspace_graph(*workspace_id)?;
    }
    phases.push(sample("graphs-indexed", phase.elapsed(), &workspace_root)?);

    drop(service);
    let phase = Instant::now();
    let reopened = LocalWtsService::open(
        &data_root,
        "many-workspace-profile",
        &workspace_root,
        &repository_root,
    )?;
    let listed = reopened.list_workspaces()?;
    if listed.workspaces.len() != workspace_count {
        return Err("restart returned an incomplete workspace registry".into());
    }
    phases.push(sample(
        "restart-registry-listed",
        phase.elapsed(),
        &workspace_root,
    )?);

    let phase = Instant::now();
    for workspace_id in &workspaces {
        let materialization = reopened.get_materialization(*workspace_id)?;
        if materialization.is_none() {
            return Err(format!("workspace {workspace_id:?} did not survive restart").into());
        }
    }
    phases.push(sample(
        "restart-deep-reconciled",
        phase.elapsed(),
        &workspace_root,
    )?);

    let budget_violations = evaluate_resource_budgets(&phases);
    let passed_resource_budgets = budget_violations.is_empty();
    let report = ProfileReport {
        schema_version: SCHEMA_VERSION,
        workspace_count,
        repository_count: 1,
        host_os: env::consts::OS.to_owned(),
        host_arch: env::consts::ARCH.to_owned(),
        passed_resource_budgets,
        budget_violations,
        phases,
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&output, serde_json::to_vec_pretty(&report)?)?;
    println!("Profiled {workspace_count} materialized and indexed workspaces.");
    println!("Report: {}", output.display());
    if !report.passed_resource_budgets {
        return Err(format!(
            "resource budgets failed: {}",
            report.budget_violations.join("; ")
        )
        .into());
    }
    Ok(())
}

fn arguments() -> ProfileResult<(usize, PathBuf)> {
    let mut count = 30_usize;
    let mut output = PathBuf::from("target/wts-many-workspace-profile.json");
    let mut args = env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--workspaces" => {
                count = args
                    .next()
                    .ok_or("--workspaces requires a value")?
                    .parse()?;
                if !(1..=100).contains(&count) {
                    return Err("--workspaces must be between 1 and 100".into());
                }
            }
            "--output" => {
                output = PathBuf::from(args.next().ok_or("--output requires a path")?);
            }
            _ => return Err(format!("unknown argument: {argument}").into()),
        }
    }
    Ok((count, output))
}

fn create_repository(path: &Path) -> ProfileResult<()> {
    fs::create_dir_all(path.join("src"))?;
    fs::write(
        path.join("Cargo.toml"),
        "[package]\nname = \"wts-profile-service\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    )?;
    fs::write(path.join("src/lib.rs"), "pub fn ready() -> bool { true }\n")?;
    run(Command::new("git").arg("-C").arg(path).arg("init"))?;
    run(Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["config", "user.name", "WTS Profiler"]))?;
    run(Command::new("git").arg("-C").arg(path).args([
        "config",
        "user.email",
        "wts-profiler@localhost",
    ]))?;
    run(Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["config", "commit.gpgSign", "false"]))?;
    run(Command::new("git").arg("-C").arg(path).args(["add", "."]))?;
    run(Command::new("git").arg("-C").arg(path).args([
        "commit",
        "-m",
        "Create profiling repository",
    ]))?;
    run(Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["branch", "-M", "main"]))?;
    Ok(())
}

fn run(command: &mut Command) -> ProfileResult<()> {
    let status = command.status()?;
    if !status.success() {
        return Err(format!("fixture command failed with {status}").into());
    }
    Ok(())
}

fn sample(name: &str, wall: Duration, workspace_root: &Path) -> ProfileResult<PhaseSample> {
    let pid = std::process::id();
    let (rss_kib, virtual_memory_kib) = process_memory(pid);
    Ok(PhaseSample {
        name: name.to_owned(),
        wall_ms: wall.as_millis(),
        rss_kib,
        virtual_memory_kib,
        open_file_descriptors: directory_count(Path::new("/dev/fd")),
        threads: thread_count(pid),
        child_processes: child_process_count(pid),
        workspace_disk_bytes: directory_bytes(workspace_root)?,
    })
}

fn process_memory(pid: u32) -> (Option<u64>, Option<u64>) {
    let output = Command::new("ps")
        .args(["-o", "rss=", "-o", "vsz=", "-p", &pid.to_string()])
        .output();
    let fields = output
        .ok()
        .filter(|result| result.status.success())
        .and_then(|result| String::from_utf8(result.stdout).ok())
        .and_then(|text| {
            let values = text
                .split_whitespace()
                .filter_map(|value| value.parse::<u64>().ok())
                .collect::<Vec<_>>();
            (values.len() >= 2).then_some((values[0], values[1]))
        });
    fields.map_or((None, None), |(rss, virtual_memory)| {
        (Some(rss), Some(virtual_memory))
    })
}

fn thread_count(pid: u32) -> Option<u64> {
    if let Ok(status) = fs::read_to_string("/proc/self/status")
        && let Some(value) = status
            .lines()
            .find_map(|line| line.strip_prefix("Threads:"))
            .and_then(|value| value.trim().parse().ok())
    {
        return Some(value);
    }
    Command::new("ps")
        .args(["-M", "-p", &pid.to_string()])
        .output()
        .ok()
        .filter(|result| result.status.success())
        .map(|result| {
            String::from_utf8_lossy(&result.stdout)
                .lines()
                .count()
                .saturating_sub(1) as u64
        })
}

fn child_process_count(pid: u32) -> Option<u64> {
    Command::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output()
        .ok()
        .map(|result| {
            String::from_utf8_lossy(&result.stdout)
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count() as u64
        })
}

fn directory_count(path: &Path) -> Option<u64> {
    fs::read_dir(path)
        .ok()
        .map(|entries| entries.count() as u64)
}

fn directory_bytes(path: &Path) -> ProfileResult<u64> {
    let mut total = 0_u64;
    let mut pending = vec![path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                total = total.saturating_add(entry.metadata()?.len());
            }
        }
    }
    Ok(total)
}

fn evaluate_resource_budgets(phases: &[PhaseSample]) -> Vec<String> {
    let Some(baseline) = phases.first() else {
        return vec!["profile produced no phase samples".to_owned()];
    };
    let mut violations = Vec::new();
    match baseline.rss_kib {
        Some(rss) if rss > 40 * 1024 => {
            violations.push("service-open RSS exceeded the 40 MiB idle budget".to_owned());
        }
        None => violations.push("service-open RSS measurement was unavailable".to_owned()),
        Some(_) => {}
    }
    if baseline.open_file_descriptors.is_none() {
        violations.push("service-open file-descriptor measurement was unavailable".to_owned());
    }
    if baseline.threads.is_none() {
        violations.push("service-open thread measurement was unavailable".to_owned());
    }
    if baseline.child_processes.is_none() {
        violations.push("service-open child-process measurement was unavailable".to_owned());
    }
    for phase in phases {
        match phase.child_processes {
            Some(count) if count != 0 => {
                violations.push(format!("{} retained {} child processes", phase.name, count));
            }
            None if phase.name != baseline.name => violations.push(format!(
                "{} child-process measurement was unavailable",
                phase.name
            )),
            _ => {}
        }
        match (baseline.open_file_descriptors, phase.open_file_descriptors) {
            (Some(base), Some(observed)) if observed > base.saturating_add(10) => {
                violations.push(format!(
                    "{} retained {} file descriptors above baseline",
                    phase.name,
                    observed.saturating_sub(base)
                ));
            }
            (Some(_), None) if phase.name != baseline.name => violations.push(format!(
                "{} file-descriptor measurement was unavailable",
                phase.name
            )),
            _ => {}
        }
        match (baseline.threads, phase.threads) {
            (Some(base), Some(observed)) if observed > base.saturating_add(2) => {
                violations.push(format!(
                    "{} retained {} threads above baseline",
                    phase.name,
                    observed.saturating_sub(base)
                ));
            }
            (Some(_), None) if phase.name != baseline.name => {
                violations.push(format!("{} thread measurement was unavailable", phase.name))
            }
            _ => {}
        }
        match (baseline.rss_kib, phase.rss_kib) {
            (Some(base), Some(observed)) if observed > base.saturating_add(40 * 1024) => {
                violations.push(format!("{} grew RSS by more than 40 MiB", phase.name));
            }
            (Some(_), None) if phase.name != baseline.name => {
                violations.push(format!("{} RSS measurement was unavailable", phase.name));
            }
            _ => {}
        }
    }
    violations
}
