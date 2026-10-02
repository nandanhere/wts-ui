//! Runs independent local workspace stacks through `RuntimeSupervisor`.
//!
//! The default run creates two copies of each fixture shape (six workspace
//! roots and fourteen service processes), deliberately gives every copy the
//! same preferred ports, validates every stack concurrently, stops one stack
//! while proving the other five remain healthy, and verifies final cleanup.
//!
//! ```text
//! cargo run -p wts-app --example simultaneous_workspace_lab
//! cargo run -p wts-app --example simultaneous_workspace_lab -- \
//!   --copies 4 --root target/wts-simultaneous-lab
//! ```

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    error::Error,
    fs,
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_app::{
    RuntimeEndpoint, RuntimeHealthCheck, RuntimeLimits, RuntimeServiceRequest, RuntimeStackKey,
    RuntimeStackRequest, RuntimeStackSnapshot, RuntimeStackState, RuntimeSupervisor,
};

type LabResult<T> = Result<T, Box<dyn Error>>;

const SCHEMA_VERSION: u32 = 1;
const SHAPES: [&str; 3] = ["frontend-backend", "api-worker", "event-driven"];
const DEFAULT_COPIES: usize = 2;
const MAX_COPIES: usize = 4;
const DEFAULT_PREFERRED_BASE: u16 = 46_000;
const MAX_HTTP_BYTES: u64 = 64 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(8);
const SMOKE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug)]
struct Options {
    copies: usize,
    preferred_base: u16,
    root: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackManifest {
    schema_version: u32,
    id: String,
    description: String,
    ports: Vec<PortDefinition>,
    processes: Vec<ProcessDefinition>,
    smoke: SmokeDefinition,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortDefinition {
    id: String,
    environment: String,
    offset: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessDefinition {
    id: String,
    working_directory: String,
    executable: String,
    arguments: Vec<String>,
    dependencies: Vec<String>,
    health: HealthDefinition,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HealthDefinition {
    port: String,
    path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SmokeDefinition {
    working_directory: String,
    executable: String,
    arguments: Vec<String>,
}

struct StackInstance {
    shape: String,
    description: String,
    instance_id: String,
    workspace_id: Uuid,
    workspace_root: PathBuf,
    stack_root: PathBuf,
    state_directory: PathBuf,
    manifest: StackManifest,
    snapshot: Option<RuntimeStackSnapshot>,
}

impl StackInstance {
    fn key(&self) -> RuntimeStackKey {
        RuntimeStackKey {
            workspace_id: self.workspace_id,
            stack_id: self.instance_id.clone(),
        }
    }

    fn snapshot(&self) -> LabResult<&RuntimeStackSnapshot> {
        self.snapshot
            .as_ref()
            .ok_or_else(|| failure("stack snapshot is unavailable"))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LabReport {
    schema_version: u32,
    lab_root: String,
    copies_per_shape: usize,
    shape_count: usize,
    stack_count: usize,
    process_count: usize,
    concurrent_validation_workers: usize,
    preferred_port_requests: usize,
    unique_preferred_ports: usize,
    unique_assigned_ports: usize,
    collisions_resolved: bool,
    initially_healthy_stacks: usize,
    smoke_passed_stacks: usize,
    resource_sample: ResourceSample,
    targeted_stop: TargetedStopReport,
    cleanup: CleanupReport,
    stacks: Vec<StackReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResourceSample {
    method: &'static str,
    interpretation: &'static str,
    supervisor_process_rss_kib: Option<u64>,
    fixture_child_process_count: usize,
    aggregate_fixture_child_rss_kib: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetedStopReport {
    stack_id: String,
    stopped_processes: usize,
    remaining_stack_count: usize,
    remaining_stacks_healthy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupReport {
    stopped_stack_count: usize,
    stopped_process_count: usize,
    supervisor_registry_empty: bool,
    all_processes_stopped: bool,
    all_ports_released: bool,
    success: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StackReport {
    shape: String,
    description: String,
    instance_id: String,
    workspace_id: Uuid,
    workspace_root: String,
    smoke_passed: bool,
    remained_healthy_after_sibling_stop: bool,
    services: Vec<ServiceReport>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceReport {
    id: String,
    preferred_port: u16,
    assigned_port: u16,
    health_path: String,
}

fn main() -> LabResult<()> {
    let options = arguments()?;
    let fixtures_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/service-stacks")
        .canonicalize()?;
    let (temporary_root, root) = create_lab_root(options.root.as_deref())?;
    let mut instances = prepare_instances(
        &fixtures_root,
        &root,
        options.copies,
        options.preferred_base,
    )?;

    let process_count = instances
        .iter()
        .map(|instance| instance.manifest.processes.len())
        .sum::<usize>();
    let supervisor = RuntimeSupervisor::new(RuntimeLimits {
        max_stacks: instances.len(),
        max_services_per_stack: 8,
        max_services_total: process_count,
        max_startup_timeout: STARTUP_TIMEOUT,
        health_poll_interval: Duration::from_millis(20),
    })?;

    for instance in &mut instances {
        let request = runtime_request(instance, options.preferred_base)?;
        let snapshot = supervisor.start_stack(request)?;
        ensure(
            snapshot.state == RuntimeStackState::Healthy,
            format!("{} did not start healthy", instance.instance_id),
        )?;
        instance.snapshot = Some(snapshot);
    }

    let preferred_ports = preferred_ports(&instances, options.preferred_base)?;
    let assigned_ports = assigned_ports(&instances)?;
    ensure(
        assigned_ports.len() == process_count,
        "runtime assigned duplicate ports",
    )?;
    ensure(
        preferred_ports.len() < process_count,
        "the lab did not create preferred-port collisions",
    )?;

    validate_all_concurrently(&instances)?;
    for instance in &instances {
        ensure(
            supervisor.inspect_stack(&instance.key())?.state == RuntimeStackState::Healthy,
            format!(
                "{} degraded during parallel validation",
                instance.instance_id
            ),
        )?;
    }
    let child_process_ids = instances
        .iter()
        .flat_map(|instance| {
            instance
                .snapshot
                .iter()
                .flat_map(|snapshot| snapshot.services.iter())
                .map(|service| service.process_id)
        })
        .collect::<Vec<_>>();
    let resource_sample = ResourceSample {
        method: "best-effort ps RSS (KiB); null when unavailable",
        interpretation: "process RSS includes shared pages and the child aggregate sums per-process values",
        supervisor_process_rss_kib: sample_rss_kib(&[std::process::id()]),
        fixture_child_process_count: child_process_ids.len(),
        aggregate_fixture_child_rss_kib: sample_rss_kib(&child_process_ids),
    };

    let target_key = instances[0].key();
    let targeted_snapshot = supervisor.stop_stack(&target_key)?;
    ensure(
        targeted_snapshot.state == RuntimeStackState::Stopped,
        "targeted stack did not stop cleanly",
    )?;

    let mut remaining_stacks_healthy = true;
    for instance in instances.iter().skip(1) {
        let refreshed = supervisor.inspect_stack(&instance.key())?;
        remaining_stacks_healthy &= refreshed.state == RuntimeStackState::Healthy;
        verify_http_health(instance, &refreshed)
            .map_err(|message| failure(format!("post-stop health failed: {message}")))?;
    }
    ensure(
        remaining_stacks_healthy,
        "a remaining stack degraded after the targeted stop",
    )?;

    let final_snapshots = supervisor.stop_all()?;
    let supervisor_registry_empty = supervisor.list_stacks()?.is_empty();
    let mut stopped_snapshots = Vec::with_capacity(instances.len());
    stopped_snapshots.push(targeted_snapshot.clone());
    stopped_snapshots.extend(final_snapshots);
    let all_processes_stopped = stopped_snapshots.iter().all(|snapshot| {
        snapshot.state == RuntimeStackState::Stopped
            && snapshot
                .services
                .iter()
                .all(|service| service.state == wts_app::RuntimeServiceState::Stopped)
    });
    let all_ports_released = assigned_ports.iter().all(|port| port_is_available(*port));
    let cleanup_success = supervisor_registry_empty && all_processes_stopped && all_ports_released;
    ensure(cleanup_success, "runtime cleanup verification failed")?;

    let target_id = instances[0].instance_id.clone();
    let stacks = instances
        .iter()
        .enumerate()
        .map(|(index, instance)| {
            stack_report(
                instance,
                options.preferred_base,
                index != 0 && remaining_stacks_healthy,
            )
        })
        .collect::<LabResult<Vec<_>>>()?;
    let report = LabReport {
        schema_version: SCHEMA_VERSION,
        lab_root: display(&root),
        copies_per_shape: options.copies,
        shape_count: SHAPES.len(),
        stack_count: instances.len(),
        process_count,
        concurrent_validation_workers: instances.len(),
        preferred_port_requests: process_count,
        unique_preferred_ports: preferred_ports.len(),
        unique_assigned_ports: assigned_ports.len(),
        collisions_resolved: assigned_ports.len() == process_count
            && preferred_ports.len() < process_count,
        initially_healthy_stacks: instances.len(),
        smoke_passed_stacks: instances.len(),
        resource_sample,
        targeted_stop: TargetedStopReport {
            stack_id: target_id,
            stopped_processes: targeted_snapshot.services.len(),
            remaining_stack_count: instances.len() - 1,
            remaining_stacks_healthy,
        },
        cleanup: CleanupReport {
            stopped_stack_count: stopped_snapshots.len(),
            stopped_process_count: stopped_snapshots
                .iter()
                .map(|snapshot| snapshot.services.len())
                .sum(),
            supervisor_registry_empty,
            all_processes_stopped,
            all_ports_released,
            success: cleanup_success,
        },
        stacks,
    };
    let report_json = serde_json::to_string_pretty(&report)?;
    fs::write(
        root.join("simultaneous-workspace-report.json"),
        format!("{report_json}\n"),
    )?;
    println!("{report_json}");

    // Keep the owner alive until every process is stopped and the report is
    // emitted. A user-provided --root is retained; the default temp root is not.
    drop(temporary_root);
    Ok(())
}

fn arguments() -> LabResult<Options> {
    let mut options = Options {
        copies: DEFAULT_COPIES,
        preferred_base: DEFAULT_PREFERRED_BASE,
        root: None,
    };
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--copies" => {
                options.copies = arguments
                    .next()
                    .ok_or_else(|| failure("--copies requires a value"))?
                    .parse()?;
            }
            "--preferred-base" => {
                options.preferred_base = arguments
                    .next()
                    .ok_or_else(|| failure("--preferred-base requires a value"))?
                    .parse()?;
            }
            "--root" => {
                options.root = Some(PathBuf::from(
                    arguments
                        .next()
                        .ok_or_else(|| failure("--root requires a path"))?,
                ));
            }
            _ => {
                return Err(failure(format!(
                    "unknown argument {argument:?}; use --copies, --preferred-base, or --root"
                )));
            }
        }
    }
    ensure(
        (1..=MAX_COPIES).contains(&options.copies),
        format!("--copies must be between 1 and {MAX_COPIES}"),
    )?;
    ensure(
        options.preferred_base >= 1024 && options.preferred_base <= u16::MAX.saturating_sub(10),
        "--preferred-base must leave room for fixture offsets",
    )?;
    Ok(options)
}

fn create_lab_root(requested: Option<&Path>) -> LabResult<(Option<TempDir>, PathBuf)> {
    if let Some(requested) = requested {
        if requested.exists() {
            ensure(
                requested.is_dir() && fs::read_dir(requested)?.next().is_none(),
                "--root must be a new or empty directory",
            )?;
        } else {
            fs::create_dir_all(requested)?;
        }
        return Ok((None, requested.canonicalize()?));
    }
    let temporary = tempfile::Builder::new()
        .prefix("wts-simultaneous-lab-")
        .tempdir()?;
    let root = temporary.path().canonicalize()?;
    Ok((Some(temporary), root))
}

fn prepare_instances(
    fixtures_root: &Path,
    root: &Path,
    copies: usize,
    preferred_base: u16,
) -> LabResult<Vec<StackInstance>> {
    let workspaces_root = root.join("workspaces");
    fs::create_dir(&workspaces_root)?;
    let mut instances = Vec::with_capacity(SHAPES.len() * copies);
    for (shape_index, shape) in SHAPES.iter().enumerate() {
        for copy_index in 0..copies {
            let instance_id = format!("{shape}-{:02}", copy_index + 1);
            let workspace_root = workspaces_root.join(&instance_id);
            let repositories_root = workspace_root.join("repositories");
            let stack_root = repositories_root.join(shape);
            fs::create_dir_all(&repositories_root)?;
            copy_tree(&fixtures_root.join(shape), &stack_root)?;
            copy_tree(&fixtures_root.join("lib"), &repositories_root.join("lib"))?;
            let state_directory = workspace_root.join(".wts-state");
            fs::create_dir(&state_directory)?;

            let workspace_root = workspace_root.canonicalize()?;
            let stack_root = stack_root.canonicalize()?;
            let state_directory = state_directory.canonicalize()?;
            let manifest = load_manifest(&stack_root.join("wts-stack.json"))?;
            ensure(
                manifest.id == *shape,
                "fixture shape and manifest id differ",
            )?;
            validate_preferred_ports(&manifest, preferred_base)?;
            instances.push(StackInstance {
                shape: manifest.id.clone(),
                description: manifest.description.clone(),
                instance_id,
                workspace_id: deterministic_workspace_id(shape_index, copy_index),
                workspace_root,
                stack_root,
                state_directory,
                manifest,
                snapshot: None,
            });
        }
    }
    Ok(instances)
}

fn load_manifest(path: &Path) -> LabResult<StackManifest> {
    let manifest: StackManifest = serde_json::from_slice(&fs::read(path)?)?;
    ensure(
        manifest.schema_version == SCHEMA_VERSION,
        "unsupported stack manifest schema",
    )?;
    ensure(valid_id(&manifest.id), "invalid stack id")?;
    ensure(!manifest.description.trim().is_empty(), "empty description")?;
    ensure(!manifest.ports.is_empty(), "manifest has no ports")?;
    ensure(!manifest.processes.is_empty(), "manifest has no processes")?;

    let mut port_ids = BTreeSet::new();
    let mut offsets = BTreeSet::new();
    let mut environment_names = BTreeSet::new();
    for port in &manifest.ports {
        ensure(valid_id(&port.id), "invalid port id")?;
        ensure(port_ids.insert(port.id.clone()), "duplicate port id")?;
        ensure(offsets.insert(port.offset), "duplicate port offset")?;
        ensure(
            valid_environment_name(&port.environment)
                && port.environment.ends_with("_PORT")
                && environment_names.insert(port.environment.clone()),
            "invalid or duplicate port environment",
        )?;
    }

    let process_ids = manifest
        .processes
        .iter()
        .map(|process| process.id.clone())
        .collect::<BTreeSet<_>>();
    ensure(
        process_ids.len() == manifest.processes.len(),
        "duplicate process id",
    )?;
    let mut health_ports = BTreeSet::new();
    for process in &manifest.processes {
        ensure(valid_id(&process.id), "invalid process id")?;
        ensure(process.executable == "node", "fixtures must execute node")?;
        ensure(
            !process.arguments.is_empty()
                && process
                    .arguments
                    .iter()
                    .all(|argument| !argument.contains('\0')),
            "invalid process arguments",
        )?;
        ensure(
            process
                .dependencies
                .iter()
                .all(|dependency| process_ids.contains(dependency)),
            "process has an unknown dependency",
        )?;
        ensure(
            port_ids.contains(&process.health.port)
                && health_ports.insert(process.health.port.clone())
                && process.health.path.starts_with('/'),
            "invalid or duplicate process health port",
        )?;
    }
    ensure(
        health_ports == port_ids,
        "each named port must belong to exactly one process",
    )?;
    ensure(
        manifest.smoke.executable == "node" && !manifest.smoke.arguments.is_empty(),
        "invalid smoke command",
    )?;
    Ok(manifest)
}

fn runtime_request(
    instance: &StackInstance,
    preferred_base: u16,
) -> LabResult<RuntimeStackRequest> {
    let bootstrap = bootstrap_script(&instance.manifest)?;
    let mut services = Vec::with_capacity(instance.manifest.processes.len());
    for process in &instance.manifest.processes {
        let port = instance
            .manifest
            .ports
            .iter()
            .find(|port| port.id == process.health.port)
            .ok_or_else(|| failure("process health port disappeared"))?;
        let working_directory =
            safe_existing_directory(&instance.stack_root, &process.working_directory)?;
        let mut arguments = vec![
            "--input-type=module".to_owned(),
            "--eval".to_owned(),
            bootstrap.clone(),
        ];
        arguments.extend(process.arguments.iter().cloned());
        services.push(RuntimeServiceRequest {
            id: process.id.clone(),
            working_directory,
            executable: process.executable.clone(),
            args: arguments,
            environment: BTreeMap::from([
                ("WTS_INSTANCE_ID".to_owned(), instance.instance_id.clone()),
                (
                    "WTS_STATE_DIR".to_owned(),
                    display(&instance.state_directory),
                ),
            ]),
            preferred_port: preferred_base
                .checked_add(port.offset)
                .ok_or_else(|| failure("preferred port overflow"))?,
            depends_on: process.dependencies.clone(),
            health_check: RuntimeHealthCheck::Tcp,
            startup_timeout: STARTUP_TIMEOUT,
        });
    }
    Ok(RuntimeStackRequest {
        workspace_id: instance.workspace_id,
        stack_id: instance.instance_id.clone(),
        workspace_root: instance.workspace_root.clone(),
        services,
    })
}

fn bootstrap_script(manifest: &StackManifest) -> LabResult<String> {
    let mut script = String::from(
        "import { resolve } from 'node:path';\
         import { pathToFileURL } from 'node:url';",
    );
    for port in &manifest.ports {
        let process = manifest
            .processes
            .iter()
            .find(|process| process.health.port == port.id)
            .ok_or_else(|| failure("port does not map to a process"))?;
        let target = serde_json::to_string(&port.environment)?;
        let source = serde_json::to_string(&format!(
            "WTS_SERVICE_{}_PORT",
            environment_token(&process.id)
        ))?;
        script.push_str(&format!(
            "if (!process.env[{source}]) throw new Error('missing WTS endpoint');\
             process.env[{target}] = process.env[{source}];"
        ));
    }
    script.push_str(
        "if (!process.argv[1]) throw new Error('missing service module');\
         await import(pathToFileURL(resolve(process.argv[1])).href);",
    );
    Ok(script)
}

fn validate_all_concurrently(instances: &[StackInstance]) -> LabResult<()> {
    let results = thread::scope(|scope| {
        instances
            .iter()
            .map(|instance| scope.spawn(move || validate_instance(instance)))
            .collect::<Vec<_>>()
            .into_iter()
            .map(|handle| {
                handle
                    .join()
                    .map_err(|_| "validation worker panicked".to_owned())?
            })
            .collect::<Result<Vec<_>, String>>()
    });
    results
        .map(|_| ())
        .map_err(|message| failure(format!("parallel stack validation failed: {message}")))
}

fn validate_instance(instance: &StackInstance) -> Result<(), String> {
    let snapshot = instance.snapshot().map_err(|error| error.to_string())?;
    verify_http_health(instance, snapshot)?;
    run_smoke(instance, snapshot)
}

fn verify_http_health(
    instance: &StackInstance,
    snapshot: &RuntimeStackSnapshot,
) -> Result<(), String> {
    for process in &instance.manifest.processes {
        let endpoint = endpoint_for_process(snapshot, &process.id)?;
        let response = http_get(endpoint, &process.health.path)?;
        let body: Value =
            serde_json::from_slice(&response).map_err(|error| format!("invalid JSON: {error}"))?;
        if body.get("status").and_then(Value::as_str) != Some("ok") {
            return Err(format!(
                "{}/{} returned a non-ok health payload",
                instance.instance_id, process.id
            ));
        }
    }
    Ok(())
}

fn http_get(endpoint: &RuntimeEndpoint, path: &str) -> Result<Vec<u8>, String> {
    if endpoint.host != Ipv4Addr::LOCALHOST.to_string() {
        return Err("runtime returned a non-loopback endpoint".to_owned());
    }
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, endpoint.port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))
        .map_err(|error| format!("health connect failed: {error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .map_err(|error| error.to_string())?;
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .map_err(|error| error.to_string())?;
    let mut response = Vec::new();
    stream
        .take(MAX_HTTP_BYTES + 1)
        .read_to_end(&mut response)
        .map_err(|error| error.to_string())?;
    if response.len() as u64 > MAX_HTTP_BYTES {
        return Err("health response exceeded the byte limit".to_owned());
    }
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "health response had no header terminator".to_owned())?;
    let headers = &response[..header_end];
    if !headers.starts_with(b"HTTP/1.1 200 ") {
        return Err("health endpoint did not return HTTP 200".to_owned());
    }
    Ok(response[header_end + 4..].to_vec())
}

fn run_smoke(instance: &StackInstance, snapshot: &RuntimeStackSnapshot) -> Result<(), String> {
    let smoke = &instance.manifest.smoke;
    let working_directory = safe_existing_directory(&instance.stack_root, &smoke.working_directory)
        .map_err(|error| error.to_string())?;
    let mut command = Command::new(&smoke.executable);
    command
        .args(&smoke.arguments)
        .current_dir(working_directory)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    copy_runtime_environment(&mut command);
    command
        .env("WTS_INSTANCE_ID", &instance.instance_id)
        .env("WTS_STATE_DIR", &instance.state_directory);
    for port in &instance.manifest.ports {
        let process = instance
            .manifest
            .processes
            .iter()
            .find(|process| process.health.port == port.id)
            .ok_or_else(|| "port does not map to a process".to_owned())?;
        let endpoint = endpoint_for_process(snapshot, &process.id)?;
        command.env(&port.environment, endpoint.port.to_string());
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("smoke process could not start: {error}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(status)) => {
                return Err(format!("smoke process exited with {status}"));
            }
            Ok(None) if started.elapsed() < SMOKE_TIMEOUT => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("smoke process timed out".to_owned());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("smoke process observation failed: {error}"));
            }
        }
    }
}

fn endpoint_for_process<'a>(
    snapshot: &'a RuntimeStackSnapshot,
    process_id: &str,
) -> Result<&'a RuntimeEndpoint, String> {
    snapshot
        .services
        .iter()
        .find(|service| service.id == process_id)
        .map(|service| &service.endpoint)
        .ok_or_else(|| format!("runtime endpoint is missing for {process_id}"))
}

fn stack_report(
    instance: &StackInstance,
    preferred_base: u16,
    remained_healthy_after_sibling_stop: bool,
) -> LabResult<StackReport> {
    let snapshot = instance.snapshot()?;
    let mut services = Vec::with_capacity(instance.manifest.processes.len());
    for process in &instance.manifest.processes {
        let port = instance
            .manifest
            .ports
            .iter()
            .find(|port| port.id == process.health.port)
            .ok_or_else(|| failure("report port mapping disappeared"))?;
        services.push(ServiceReport {
            id: process.id.clone(),
            preferred_port: preferred_base + port.offset,
            assigned_port: endpoint_for_process(snapshot, &process.id)
                .map_err(failure)?
                .port,
            health_path: process.health.path.clone(),
        });
    }
    Ok(StackReport {
        shape: instance.shape.clone(),
        description: instance.description.clone(),
        instance_id: instance.instance_id.clone(),
        workspace_id: instance.workspace_id,
        workspace_root: display(&instance.workspace_root),
        smoke_passed: true,
        remained_healthy_after_sibling_stop,
        services,
    })
}

fn preferred_ports(instances: &[StackInstance], base: u16) -> LabResult<BTreeSet<u16>> {
    instances
        .iter()
        .flat_map(|instance| instance.manifest.ports.iter())
        .map(|port| {
            base.checked_add(port.offset)
                .ok_or_else(|| failure("preferred port overflow"))
        })
        .collect()
}

fn assigned_ports(instances: &[StackInstance]) -> LabResult<BTreeSet<u16>> {
    let mut ports = BTreeSet::new();
    for instance in instances {
        ports.extend(
            instance
                .snapshot()?
                .services
                .iter()
                .map(|service| service.endpoint.port),
        );
    }
    Ok(ports)
}

fn validate_preferred_ports(manifest: &StackManifest, base: u16) -> LabResult<()> {
    ensure(
        manifest
            .ports
            .iter()
            .all(|port| base.checked_add(port.offset).is_some()),
        "fixture port offset overflow",
    )
}

fn safe_existing_directory(root: &Path, relative: &str) -> LabResult<PathBuf> {
    let path = Path::new(relative);
    ensure(!path.is_absolute(), "fixture path must be relative")?;
    ensure(
        path.components()
            .all(|component| !matches!(component, Component::ParentDir | Component::Prefix(_))),
        "fixture path escapes its workspace",
    )?;
    let canonical_root = root.canonicalize()?;
    let candidate = canonical_root.join(path).canonicalize()?;
    ensure(
        candidate.is_dir() && candidate.starts_with(&canonical_root),
        "fixture directory is outside its workspace",
    )?;
    Ok(candidate)
}

fn copy_tree(source: &Path, destination: &Path) -> LabResult<()> {
    ensure(source.is_dir(), "fixture source is not a directory")?;
    fs::create_dir(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target)?;
        } else {
            return Err(failure("fixture trees may not contain symbolic links"));
        }
    }
    Ok(())
}

fn copy_runtime_environment(command: &mut Command) {
    for name in [
        "PATH",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "SystemRoot",
        "PATHEXT",
    ] {
        if let Some(value) = env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn port_is_available(port: u16) -> bool {
    TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn sample_rss_kib(process_ids: &[u32]) -> Option<u64> {
    if process_ids.is_empty() {
        return Some(0);
    }
    let process_list = process_ids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &process_list])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return None;
    }
    output
        .stdout
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|field| !field.is_empty())
        .try_fold(0_u64, |total, field| {
            let value = std::str::from_utf8(field).ok()?.parse::<u64>().ok()?;
            total.checked_add(value)
        })
}

fn deterministic_workspace_id(shape_index: usize, copy_index: usize) -> Uuid {
    let ordinal =
        u16::try_from(shape_index * MAX_COPIES + copy_index + 1).expect("bounded fixture ordinal");
    let mut bytes = [0_u8; 16];
    bytes[0..3].copy_from_slice(b"WTS");
    bytes[6] = 0x40;
    bytes[8] = 0x80;
    bytes[14..16].copy_from_slice(&ordinal.to_be_bytes());
    Uuid::from_bytes(bytes)
}

fn environment_token(service_id: &str) -> String {
    service_id
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() {
                char::from(byte.to_ascii_uppercase())
            } else {
                '_'
            }
        })
        .collect()
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
}

fn valid_environment_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes.next().is_some_and(|byte| byte.is_ascii_uppercase())
        && bytes.all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn ensure(condition: bool, message: impl Into<String>) -> LabResult<()> {
    if condition {
        Ok(())
    } else {
        Err(failure(message))
    }
}

fn failure(message: impl Into<String>) -> Box<dyn Error> {
    Box::new(std::io::Error::other(message.into()))
}
