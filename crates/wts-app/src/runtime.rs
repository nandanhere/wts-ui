//! Lightweight ownership of workspace-scoped local service stacks.
//!
//! Commands are represented as an executable plus an argument vector and are
//! passed directly to `std::process::Command`; this module never invokes a
//! shell. WTS reserves and advertises only loopback endpoints, but a generic
//! executable can ignore the injected host. Enforcing a network namespace or
//! denying non-loopback binds remains an operating-system sandbox concern.

use crate::process::{configure_process_group, terminate_process_group};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

const LOOPBACK_HOST: &str = "127.0.0.1";
const MAX_STACK_ID_BYTES: usize = 96;
const MAX_SERVICE_ID_BYTES: usize = 96;
const MAX_EXECUTABLE_BYTES: usize = 4 * 1024;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 16 * 1024;
const MAX_ENVIRONMENT_ENTRIES: usize = 64;
const MAX_ENVIRONMENT_VALUE_BYTES: usize = 16 * 1024;
const OBSERVATION_CONNECT_TIMEOUT: Duration = Duration::from_millis(50);

/// Resource and startup ceilings for one local runtime supervisor.
///
/// These are process-count limits, not thread-pool hints. A supervisor never
/// queues work past them: callers receive `CapacityExceeded` and can retry
/// after stopping a stack.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeLimits {
    pub max_stacks: usize,
    pub max_services_per_stack: usize,
    pub max_services_total: usize,
    pub max_startup_timeout: Duration,
    pub health_poll_interval: Duration,
}

impl Default for RuntimeLimits {
    fn default() -> Self {
        Self {
            max_stacks: 30,
            max_services_per_stack: 16,
            max_services_total: 96,
            max_startup_timeout: Duration::from_secs(60),
            health_poll_interval: Duration::from_millis(25),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeHealthCheck {
    /// The service is considered running once its process survives the first
    /// observation. Later inspections still detect process exit.
    Process,
    /// WTS waits until the assigned loopback TCP port accepts a connection.
    Tcp,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeServiceRequest {
    pub id: String,
    pub working_directory: PathBuf,
    pub executable: String,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub preferred_port: u16,
    pub depends_on: Vec<String>,
    pub health_check: RuntimeHealthCheck,
    pub startup_timeout: Duration,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeStackRequest {
    pub workspace_id: Uuid,
    pub stack_id: String,
    pub workspace_root: PathBuf,
    pub services: Vec<RuntimeServiceRequest>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStackKey {
    pub workspace_id: Uuid,
    pub stack_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEndpoint {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeServiceState {
    Starting,
    Running,
    Healthy,
    Unhealthy,
    Exited,
    Stopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeStackState {
    Starting,
    Healthy,
    Degraded,
    Stopped,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeServiceSnapshot {
    pub id: String,
    pub endpoint: RuntimeEndpoint,
    pub process_id: u32,
    pub state: RuntimeServiceState,
    pub exit_code: Option<i32>,
    pub started_at_unix_ms: u64,
    pub observed_at_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeStackSnapshot {
    pub key: RuntimeStackKey,
    pub workspace_root_display_path: String,
    pub state: RuntimeStackState,
    pub services: Vec<RuntimeServiceSnapshot>,
    pub started_at_unix_ms: u64,
    pub observed_at_unix_ms: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RuntimeError {
    #[error("runtime limits must all be greater than zero")]
    InvalidLimits,
    #[error("runtime stack identifier is invalid")]
    InvalidStackId,
    #[error("runtime stack must contain at least one service")]
    EmptyStack,
    #[error("runtime stack capacity is exhausted")]
    CapacityExceeded,
    #[error("runtime service identifier is invalid: {0}")]
    InvalidServiceId(String),
    #[error("runtime service identifiers must be unique: {0}")]
    DuplicateService(String),
    #[error("runtime service endpoint environment names are ambiguous")]
    AmbiguousServiceEnvironment,
    #[error("runtime service has an unknown dependency: {service} -> {dependency}")]
    UnknownDependency { service: String, dependency: String },
    #[error("runtime service dependency graph contains a cycle")]
    DependencyCycle,
    #[error("runtime workspace root must be an existing canonical directory")]
    InvalidWorkspaceRoot,
    #[error("runtime service working directory is outside the workspace: {0}")]
    WorkingDirectoryOutsideWorkspace(String),
    #[error("runtime executable is invalid for service: {0}")]
    InvalidExecutable(String),
    #[error("runtime arguments are invalid for service: {0}")]
    InvalidArguments(String),
    #[error("runtime environment is invalid for service: {0}")]
    InvalidEnvironment(String),
    #[error("runtime preferred port must be non-zero for service: {0}")]
    InvalidPreferredPort(String),
    #[error("runtime startup timeout must be greater than zero for service: {0}")]
    InvalidStartupTimeout(String),
    #[error("no loopback port is available for service: {0}")]
    PortUnavailable(String),
    #[error("runtime stack is already running")]
    AlreadyRunning,
    #[error("runtime stack was not found")]
    StackNotFound,
    #[error("runtime service process could not start: {0}")]
    ProcessStartFailed(String),
    #[error("runtime service exited before it became ready: {0}")]
    StartupExited(String),
    #[error("runtime service did not become ready before its timeout: {0}")]
    StartupTimedOut(String),
    #[error("runtime service process could not be observed: {0}")]
    ProcessObservationFailed(String),
    #[error("runtime process cleanup was incomplete")]
    CleanupFailed,
    #[error("runtime supervisor state is unavailable")]
    StateUnavailable,
}

/// Owns workspace-scoped local service processes.
///
/// Clones share the same process registry. Dropping the final clone terminates
/// every process group still owned by the supervisor.
#[derive(Clone)]
pub struct RuntimeSupervisor {
    inner: Arc<RuntimeSupervisorInner>,
}

struct RuntimeSupervisorInner {
    limits: RuntimeLimits,
    state: Mutex<RuntimeState>,
}

#[derive(Default)]
struct RuntimeState {
    stacks: BTreeMap<RuntimeStackKey, ManagedStack>,
}

struct ManagedStack {
    key: RuntimeStackKey,
    workspace_root: PathBuf,
    services: Vec<ManagedService>,
    started_at_unix_ms: u64,
}

struct ManagedService {
    id: String,
    endpoint: RuntimeEndpoint,
    child: Child,
    state: RuntimeServiceState,
    exit_code: Option<i32>,
    started_at_unix_ms: u64,
    observed_at_unix_ms: u64,
    reaped: bool,
    health_check: RuntimeHealthCheck,
}

struct PreparedStack {
    key: RuntimeStackKey,
    workspace_root: PathBuf,
    services: Vec<RuntimeServiceRequest>,
}

struct ReservedService {
    request: RuntimeServiceRequest,
    endpoint: RuntimeEndpoint,
    reservation: TcpListener,
}

impl RuntimeSupervisor {
    pub fn new(limits: RuntimeLimits) -> Result<Self, RuntimeError> {
        if limits.max_stacks == 0
            || limits.max_services_per_stack == 0
            || limits.max_services_total == 0
            || limits.max_startup_timeout.is_zero()
            || limits.health_poll_interval.is_zero()
        {
            return Err(RuntimeError::InvalidLimits);
        }
        Ok(Self {
            inner: Arc::new(RuntimeSupervisorInner {
                limits,
                state: Mutex::new(RuntimeState::default()),
            }),
        })
    }

    /// Starts one stack synchronously.
    ///
    /// Services are started in dependency order. TCP services must accept a
    /// loopback connection before their dependants start. Any failure rolls
    /// back every process already started for this request.
    pub fn start_stack(
        &self,
        request: RuntimeStackRequest,
    ) -> Result<RuntimeStackSnapshot, RuntimeError> {
        let prepared = prepare_stack(request, self.inner.limits)?;
        let mut state = self.lock_state()?;
        if state.stacks.contains_key(&prepared.key) {
            return Err(RuntimeError::AlreadyRunning);
        }
        let active_services = state
            .stacks
            .values()
            .map(|stack| stack.services.len())
            .sum::<usize>();
        if state.stacks.len() >= self.inner.limits.max_stacks
            || active_services.saturating_add(prepared.services.len())
                > self.inner.limits.max_services_total
        {
            return Err(RuntimeError::CapacityExceeded);
        }

        let claimed_ports = state
            .stacks
            .values()
            .flat_map(|stack| stack.services.iter())
            .map(|service| service.endpoint.port)
            .collect::<BTreeSet<_>>();
        let reserved = reserve_services(prepared.services, claimed_ports)?;
        let endpoint_environment = endpoint_environment(&reserved);
        let started_at_unix_ms = now_unix_ms();
        let mut services = Vec::with_capacity(reserved.len());

        for reserved_service in reserved {
            let ReservedService {
                request,
                endpoint,
                reservation,
            } = reserved_service;
            drop(reservation);
            let mut command =
                service_command(&prepared.key, &request, &endpoint, &endpoint_environment);
            let child = match command.spawn() {
                Ok(child) => child,
                Err(_) => {
                    let cleanup_complete = stop_services(&mut services);
                    return if cleanup_complete {
                        Err(RuntimeError::ProcessStartFailed(request.id))
                    } else {
                        Err(RuntimeError::CleanupFailed)
                    };
                }
            };
            let now = now_unix_ms();
            let mut service = ManagedService {
                id: request.id,
                endpoint,
                child,
                state: RuntimeServiceState::Starting,
                exit_code: None,
                started_at_unix_ms: now,
                observed_at_unix_ms: now,
                reaped: false,
                health_check: request.health_check,
            };
            let startup_timeout = request
                .startup_timeout
                .min(self.inner.limits.max_startup_timeout);
            if let Err(error) = wait_until_ready(
                &mut service,
                startup_timeout,
                self.inner.limits.health_poll_interval,
            ) {
                services.push(service);
                let cleanup_complete = stop_services(&mut services);
                return if cleanup_complete {
                    Err(error)
                } else {
                    Err(RuntimeError::CleanupFailed)
                };
            }
            services.push(service);
        }

        let key = prepared.key;
        let stack = ManagedStack {
            key: key.clone(),
            workspace_root: prepared.workspace_root,
            services,
            started_at_unix_ms,
        };
        let snapshot = stack.snapshot();
        state.stacks.insert(key, stack);
        Ok(snapshot)
    }

    /// Returns last-known state without probing every process or endpoint.
    pub fn list_stacks(&self) -> Result<Vec<RuntimeStackSnapshot>, RuntimeError> {
        let state = self.lock_state()?;
        Ok(state.stacks.values().map(ManagedStack::snapshot).collect())
    }

    /// Refreshes process and TCP health for one selected stack.
    pub fn inspect_stack(
        &self,
        key: &RuntimeStackKey,
    ) -> Result<RuntimeStackSnapshot, RuntimeError> {
        let mut state = self.lock_state()?;
        let stack = state
            .stacks
            .get_mut(key)
            .ok_or(RuntimeError::StackNotFound)?;
        for service in &mut stack.services {
            observe_service(service)?;
        }
        Ok(stack.snapshot())
    }

    pub fn stop_stack(&self, key: &RuntimeStackKey) -> Result<RuntimeStackSnapshot, RuntimeError> {
        let mut state = self.lock_state()?;
        let mut stack = state
            .stacks
            .remove(key)
            .ok_or(RuntimeError::StackNotFound)?;
        let cleanup_complete = stop_services(&mut stack.services);
        let snapshot = stack.snapshot();
        if cleanup_complete {
            Ok(snapshot)
        } else {
            state.stacks.insert(key.clone(), stack);
            Err(RuntimeError::CleanupFailed)
        }
    }

    pub fn stop_all(&self) -> Result<Vec<RuntimeStackSnapshot>, RuntimeError> {
        let mut state = self.lock_state()?;
        let stacks = std::mem::take(&mut state.stacks);
        let mut cleanup_complete = true;
        let mut snapshots = Vec::with_capacity(stacks.len());
        for (key, mut stack) in stacks {
            let stack_cleanup_complete = stop_services(&mut stack.services);
            snapshots.push(stack.snapshot());
            if !stack_cleanup_complete {
                state.stacks.insert(key, stack);
            }
            cleanup_complete &= stack_cleanup_complete;
        }
        if cleanup_complete {
            Ok(snapshots)
        } else {
            Err(RuntimeError::CleanupFailed)
        }
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, RuntimeState>, RuntimeError> {
        self.inner
            .state
            .lock()
            .map_err(|_| RuntimeError::StateUnavailable)
    }
}

impl Default for RuntimeSupervisor {
    fn default() -> Self {
        Self::new(RuntimeLimits::default()).expect("default runtime limits are valid")
    }
}

impl Drop for RuntimeSupervisorInner {
    fn drop(&mut self) {
        let Ok(state) = self.state.get_mut() else {
            return;
        };
        for stack in state.stacks.values_mut() {
            let _ = stop_services(&mut stack.services);
        }
        state.stacks.clear();
    }
}

impl ManagedStack {
    fn snapshot(&self) -> RuntimeStackSnapshot {
        let observed_at_unix_ms = self
            .services
            .iter()
            .map(|service| service.observed_at_unix_ms)
            .max()
            .unwrap_or(self.started_at_unix_ms);
        RuntimeStackSnapshot {
            key: self.key.clone(),
            workspace_root_display_path: self.workspace_root.to_string_lossy().into_owned(),
            state: stack_state(&self.services),
            services: self.services.iter().map(ManagedService::snapshot).collect(),
            started_at_unix_ms: self.started_at_unix_ms,
            observed_at_unix_ms,
        }
    }
}

impl ManagedService {
    fn snapshot(&self) -> RuntimeServiceSnapshot {
        RuntimeServiceSnapshot {
            id: self.id.clone(),
            endpoint: self.endpoint.clone(),
            process_id: self.child.id(),
            state: self.state,
            exit_code: self.exit_code,
            started_at_unix_ms: self.started_at_unix_ms,
            observed_at_unix_ms: self.observed_at_unix_ms,
        }
    }
}

fn prepare_stack(
    request: RuntimeStackRequest,
    limits: RuntimeLimits,
) -> Result<PreparedStack, RuntimeError> {
    if !valid_identifier(&request.stack_id, MAX_STACK_ID_BYTES) {
        return Err(RuntimeError::InvalidStackId);
    }
    if request.services.is_empty() {
        return Err(RuntimeError::EmptyStack);
    }
    if request.services.len() > limits.max_services_per_stack
        || request.services.len() > limits.max_services_total
    {
        return Err(RuntimeError::CapacityExceeded);
    }
    let workspace_root =
        canonical_directory(&request.workspace_root).ok_or(RuntimeError::InvalidWorkspaceRoot)?;
    if workspace_root != request.workspace_root {
        return Err(RuntimeError::InvalidWorkspaceRoot);
    }

    let mut services = BTreeMap::new();
    let mut environment_tokens = BTreeSet::new();
    for mut service in request.services {
        service.id = service.id.trim().to_owned();
        if !valid_identifier(&service.id, MAX_SERVICE_ID_BYTES) {
            return Err(RuntimeError::InvalidServiceId(service.id));
        }
        if services.contains_key(&service.id) {
            return Err(RuntimeError::DuplicateService(service.id));
        }
        if !environment_tokens.insert(environment_token(&service.id)) {
            return Err(RuntimeError::AmbiguousServiceEnvironment);
        }
        let working_directory = canonical_directory(&service.working_directory)
            .ok_or_else(|| RuntimeError::WorkingDirectoryOutsideWorkspace(service.id.clone()))?;
        if working_directory != service.working_directory
            || !working_directory.starts_with(&workspace_root)
        {
            return Err(RuntimeError::WorkingDirectoryOutsideWorkspace(service.id));
        }
        service.working_directory = working_directory;
        validate_command(&service)?;
        if service.preferred_port == 0 {
            return Err(RuntimeError::InvalidPreferredPort(service.id));
        }
        if service.startup_timeout.is_zero() {
            return Err(RuntimeError::InvalidStartupTimeout(service.id));
        }
        service.depends_on.sort();
        service.depends_on.dedup();
        services.insert(service.id.clone(), service);
    }

    let service_ids = services.keys().cloned().collect::<BTreeSet<_>>();
    for service in services.values() {
        for dependency in &service.depends_on {
            if !service_ids.contains(dependency) {
                return Err(RuntimeError::UnknownDependency {
                    service: service.id.clone(),
                    dependency: dependency.clone(),
                });
            }
        }
    }

    let ordered_ids = dependency_order(&services)?;
    let ordered_services = ordered_ids
        .into_iter()
        .filter_map(|id| services.remove(&id))
        .collect::<Vec<_>>();
    Ok(PreparedStack {
        key: RuntimeStackKey {
            workspace_id: request.workspace_id,
            stack_id: request.stack_id,
        },
        workspace_root,
        services: ordered_services,
    })
}

fn validate_command(service: &RuntimeServiceRequest) -> Result<(), RuntimeError> {
    if service.executable.is_empty()
        || service.executable.trim() != service.executable
        || service.executable.len() > MAX_EXECUTABLE_BYTES
        || service
            .executable
            .chars()
            .any(|character| character == '\0')
    {
        return Err(RuntimeError::InvalidExecutable(service.id.clone()));
    }
    if service.args.len() > MAX_ARGUMENTS
        || service.args.iter().any(|argument| {
            argument.len() > MAX_ARGUMENT_BYTES
                || argument.chars().any(|character| character == '\0')
        })
    {
        return Err(RuntimeError::InvalidArguments(service.id.clone()));
    }
    if service.environment.len() > MAX_ENVIRONMENT_ENTRIES
        || service.environment.iter().any(|(name, value)| {
            !valid_environment_name(name)
                || reserved_environment_name(name)
                || value.len() > MAX_ENVIRONMENT_VALUE_BYTES
                || value.chars().any(|character| character == '\0')
        })
    {
        return Err(RuntimeError::InvalidEnvironment(service.id.clone()));
    }
    Ok(())
}

fn dependency_order(
    services: &BTreeMap<String, RuntimeServiceRequest>,
) -> Result<Vec<String>, RuntimeError> {
    let mut incoming = services
        .iter()
        .map(|(id, service)| (id.clone(), service.depends_on.len()))
        .collect::<BTreeMap<_, _>>();
    let mut outgoing = BTreeMap::<String, Vec<String>>::new();
    for service in services.values() {
        for dependency in &service.depends_on {
            outgoing
                .entry(dependency.clone())
                .or_default()
                .push(service.id.clone());
        }
    }
    let mut ready = incoming
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(id.clone()))
        .collect::<BTreeSet<_>>();
    let mut order = Vec::with_capacity(services.len());
    while let Some(id) = ready.pop_first() {
        order.push(id.clone());
        if let Some(dependants) = outgoing.get(&id) {
            for dependant in dependants {
                let count = incoming
                    .get_mut(dependant)
                    .expect("validated dependency target exists");
                *count -= 1;
                if *count == 0 {
                    ready.insert(dependant.clone());
                }
            }
        }
    }
    if order.len() == services.len() {
        Ok(order)
    } else {
        Err(RuntimeError::DependencyCycle)
    }
}

fn reserve_services(
    services: Vec<RuntimeServiceRequest>,
    mut claimed_ports: BTreeSet<u16>,
) -> Result<Vec<ReservedService>, RuntimeError> {
    let mut reserved = Vec::with_capacity(services.len());
    for request in services {
        let (port, reservation) = reserve_port(request.preferred_port, &claimed_ports)
            .ok_or_else(|| RuntimeError::PortUnavailable(request.id.clone()))?;
        claimed_ports.insert(port);
        reserved.push(ReservedService {
            request,
            endpoint: RuntimeEndpoint {
                host: LOOPBACK_HOST.to_owned(),
                port,
            },
            reservation,
        });
    }
    Ok(reserved)
}

fn reserve_port(preferred: u16, claimed_ports: &BTreeSet<u16>) -> Option<(u16, TcpListener)> {
    (preferred..=u16::MAX)
        .filter(|port| !claimed_ports.contains(port))
        .find_map(|port| {
            TcpListener::bind((Ipv4Addr::LOCALHOST, port))
                .ok()
                .map(|listener| (port, listener))
        })
}

fn endpoint_environment(services: &[ReservedService]) -> BTreeMap<String, String> {
    let mut environment = BTreeMap::new();
    for service in services {
        let token = environment_token(&service.request.id);
        environment.insert(
            format!("WTS_SERVICE_{token}_HOST"),
            LOOPBACK_HOST.to_owned(),
        );
        environment.insert(
            format!("WTS_SERVICE_{token}_PORT"),
            service.endpoint.port.to_string(),
        );
    }
    environment
}

fn service_command(
    key: &RuntimeStackKey,
    request: &RuntimeServiceRequest,
    endpoint: &RuntimeEndpoint,
    endpoint_environment: &BTreeMap<String, String>,
) -> Command {
    let mut command = Command::new(&request.executable);
    command
        .args(&request.args)
        .current_dir(&request.working_directory)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    copy_runtime_environment(&mut command);
    command.envs(&request.environment);
    command.envs(endpoint_environment);
    command
        .env("WTS_WORKSPACE_ID", key.workspace_id.to_string())
        .env("WTS_STACK_ID", &key.stack_id)
        .env("WTS_SERVICE_ID", &request.id)
        .env("WTS_HOST", LOOPBACK_HOST)
        .env("WTS_PORT", endpoint.port.to_string())
        .env("HOST", LOOPBACK_HOST)
        .env("PORT", endpoint.port.to_string());
    configure_process_group(&mut command);
    command
}

fn copy_runtime_environment(command: &mut Command) {
    for name in [
        "PATH",
        "HOME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "CARGO_HOME",
        "RUSTUP_HOME",
        "USERPROFILE",
        "SystemRoot",
        "PATHEXT",
    ] {
        if let Some(value) = env::var_os(name) {
            command.env(name, value);
        }
    }
}

fn wait_until_ready(
    service: &mut ManagedService,
    timeout: Duration,
    poll_interval: Duration,
) -> Result<(), RuntimeError> {
    let started = Instant::now();
    loop {
        service.observed_at_unix_ms = now_unix_ms();
        match service.child.try_wait() {
            Ok(Some(status)) => {
                service.state = RuntimeServiceState::Exited;
                service.exit_code = status.code();
                service.reaped = true;
                return Err(RuntimeError::StartupExited(service.id.clone()));
            }
            Ok(None) => {}
            Err(_) => {
                return Err(RuntimeError::ProcessObservationFailed(service.id.clone()));
            }
        }
        if service.health_check == RuntimeHealthCheck::Process {
            service.state = RuntimeServiceState::Running;
            return Ok(());
        }
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            service.state = RuntimeServiceState::Unhealthy;
            return Err(RuntimeError::StartupTimedOut(service.id.clone()));
        }
        let connect_timeout = poll_interval.min(timeout.saturating_sub(elapsed));
        if endpoint_accepts(&service.endpoint, connect_timeout) {
            service.state = RuntimeServiceState::Healthy;
            return Ok(());
        }
        thread::sleep(poll_interval.min(timeout.saturating_sub(started.elapsed())));
    }
}

fn observe_service(service: &mut ManagedService) -> Result<(), RuntimeError> {
    service.observed_at_unix_ms = now_unix_ms();
    match service.child.try_wait() {
        Ok(Some(status)) => {
            service.state = RuntimeServiceState::Exited;
            service.exit_code = status.code();
            service.reaped = true;
            Ok(())
        }
        Ok(None) => {
            service.state = match service.health_check {
                RuntimeHealthCheck::Process => RuntimeServiceState::Running,
                RuntimeHealthCheck::Tcp
                    if endpoint_accepts(&service.endpoint, OBSERVATION_CONNECT_TIMEOUT) =>
                {
                    RuntimeServiceState::Healthy
                }
                RuntimeHealthCheck::Tcp => RuntimeServiceState::Unhealthy,
            };
            Ok(())
        }
        Err(_) => Err(RuntimeError::ProcessObservationFailed(service.id.clone())),
    }
}

fn endpoint_accepts(endpoint: &RuntimeEndpoint, timeout: Duration) -> bool {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), endpoint.port);
    TcpStream::connect_timeout(&address, timeout.max(Duration::from_millis(1))).is_ok()
}

fn stop_services(services: &mut [ManagedService]) -> bool {
    let mut cleanup_complete = true;
    for service in services.iter_mut().rev() {
        match terminate_process_group(&mut service.child, service.reaped) {
            Ok(()) => {
                service.state = RuntimeServiceState::Stopped;
                service.reaped = true;
            }
            Err(_) => {
                cleanup_complete = false;
                service.state = RuntimeServiceState::Unhealthy;
            }
        }
        service.observed_at_unix_ms = now_unix_ms();
    }
    cleanup_complete
}

fn stack_state(services: &[ManagedService]) -> RuntimeStackState {
    if services
        .iter()
        .all(|service| service.state == RuntimeServiceState::Stopped)
    {
        RuntimeStackState::Stopped
    } else if services.iter().all(|service| {
        matches!(
            service.state,
            RuntimeServiceState::Healthy | RuntimeServiceState::Running
        )
    }) {
        RuntimeStackState::Healthy
    } else if services
        .iter()
        .any(|service| service.state == RuntimeServiceState::Starting)
    {
        RuntimeStackState::Starting
    } else {
        RuntimeStackState::Degraded
    }
}

fn canonical_directory(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute()
        || !path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        return None;
    }
    path.canonicalize().ok()
}

fn valid_identifier(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
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

fn valid_environment_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn reserved_environment_name(name: &str) -> bool {
    matches!(
        name,
        "PORT"
            | "HOST"
            | "WTS_PORT"
            | "WTS_HOST"
            | "WTS_WORKSPACE_ID"
            | "WTS_STACK_ID"
            | "WTS_SERVICE_ID"
    ) || name.starts_with("WTS_SERVICE_")
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io, net::Shutdown};
    use tempfile::tempdir;

    const HELPER_TEST_NAME: &str = "runtime::tests::runtime_child_service";

    #[test]
    fn two_multi_service_stacks_run_together_with_unique_ports() {
        let directory = tempdir().expect("temporary workspace");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical workspace");
        let preferred = available_port();
        let supervisor = RuntimeSupervisor::new(RuntimeLimits {
            max_stacks: 4,
            max_services_per_stack: 4,
            max_services_total: 8,
            max_startup_timeout: Duration::from_secs(5),
            health_poll_interval: Duration::from_millis(10),
        })
        .expect("supervisor");

        let first = supervisor
            .start_stack(stack_request(
                &root,
                "workspace-a",
                preferred,
                Uuid::new_v4(),
            ))
            .expect("first stack");
        let second = supervisor
            .start_stack(stack_request(
                &root,
                "workspace-b",
                preferred,
                Uuid::new_v4(),
            ))
            .expect("second stack");

        assert_eq!(first.state, RuntimeStackState::Healthy);
        assert_eq!(second.state, RuntimeStackState::Healthy);
        assert_eq!(first.services.len(), 2);
        assert_eq!(second.services.len(), 2);
        let ports = first
            .services
            .iter()
            .chain(&second.services)
            .map(|service| service.endpoint.port)
            .collect::<BTreeSet<_>>();
        assert_eq!(ports.len(), 4);
        assert!(first.services.iter().all(endpoint_is_open));
        assert!(second.services.iter().all(endpoint_is_open));

        let stopped = supervisor.stop_stack(&first.key).expect("stop first");
        assert_eq!(stopped.state, RuntimeStackState::Stopped);
        assert!(second.services.iter().all(endpoint_is_open));
        let inspected = supervisor
            .inspect_stack(&second.key)
            .expect("inspect second");
        assert_eq!(inspected.state, RuntimeStackState::Healthy);
        supervisor.stop_all().expect("stop remaining");
    }

    #[test]
    fn validation_rejects_cycles_paths_and_capacity_before_spawning() {
        let directory = tempdir().expect("temporary workspace");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical workspace");
        let outside = tempdir().expect("outside directory");
        let outside = outside.path().canonicalize().expect("canonical outside");
        let supervisor = RuntimeSupervisor::new(RuntimeLimits {
            max_stacks: 1,
            max_services_per_stack: 2,
            max_services_total: 2,
            ..RuntimeLimits::default()
        })
        .expect("supervisor");
        let mut invalid_path = helper_service(&root, "api", available_port());
        invalid_path.working_directory = outside;
        let error = supervisor
            .start_stack(RuntimeStackRequest {
                workspace_id: Uuid::new_v4(),
                stack_id: "path".to_owned(),
                workspace_root: root.clone(),
                services: vec![invalid_path],
            })
            .expect_err("outside path rejected");
        assert!(matches!(
            error,
            RuntimeError::WorkingDirectoryOutsideWorkspace(_)
        ));

        let mut first = helper_service(&root, "first", available_port());
        first.depends_on = vec!["second".to_owned()];
        let mut second = helper_service(&root, "second", available_port());
        second.depends_on = vec!["first".to_owned()];
        let error = supervisor
            .start_stack(RuntimeStackRequest {
                workspace_id: Uuid::new_v4(),
                stack_id: "cycle".to_owned(),
                workspace_root: root.clone(),
                services: vec![first, second],
            })
            .expect_err("cycle rejected");
        assert_eq!(error, RuntimeError::DependencyCycle);

        let services = ["one", "two", "three"]
            .into_iter()
            .map(|id| helper_service(&root, id, available_port()))
            .collect();
        let error = supervisor
            .start_stack(RuntimeStackRequest {
                workspace_id: Uuid::new_v4(),
                stack_id: "too-large".to_owned(),
                workspace_root: root,
                services,
            })
            .expect_err("capacity rejected");
        assert_eq!(error, RuntimeError::CapacityExceeded);
        assert!(supervisor.list_stacks().expect("list stacks").is_empty());
    }

    #[test]
    fn failed_start_rolls_back_processes_and_port_claims() {
        let directory = tempdir().expect("temporary workspace");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical workspace");
        let preferred = available_port();
        let supervisor = RuntimeSupervisor::new(RuntimeLimits {
            max_stacks: 2,
            max_services_per_stack: 4,
            max_services_total: 4,
            max_startup_timeout: Duration::from_secs(5),
            health_poll_interval: Duration::from_millis(10),
        })
        .expect("supervisor");
        let first = helper_service(&root, "api", preferred);
        let mut second = helper_service(&root, "web", preferred);
        second.depends_on = vec!["api".to_owned()];
        second.executable = root
            .join("missing-runtime-executable")
            .to_string_lossy()
            .into_owned();

        let error = supervisor
            .start_stack(RuntimeStackRequest {
                workspace_id: Uuid::new_v4(),
                stack_id: "rollback".to_owned(),
                workspace_root: root,
                services: vec![first, second],
            })
            .expect_err("second process cannot start");

        assert_eq!(error, RuntimeError::ProcessStartFailed("web".to_owned()));
        assert!(supervisor.list_stacks().expect("list stacks").is_empty());
        wait_until_port_can_bind(preferred);
    }

    #[test]
    fn occupied_preferred_port_is_skipped() {
        let directory = tempdir().expect("temporary workspace");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical workspace");
        let occupied = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("occupied port");
        let preferred = occupied.local_addr().expect("local address").port();
        let supervisor = RuntimeSupervisor::default();
        let snapshot = supervisor
            .start_stack(RuntimeStackRequest {
                workspace_id: Uuid::new_v4(),
                stack_id: "skip-occupied".to_owned(),
                workspace_root: root.clone(),
                services: vec![helper_service(&root, "api", preferred)],
            })
            .expect("stack starts");
        assert_ne!(snapshot.services[0].endpoint.port, preferred);
        supervisor.stop_all().expect("stop stack");
    }

    #[test]
    fn final_supervisor_drop_releases_owned_service() {
        let directory = tempdir().expect("temporary workspace");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical workspace");
        let supervisor = RuntimeSupervisor::default();
        let snapshot = supervisor
            .start_stack(RuntimeStackRequest {
                workspace_id: Uuid::new_v4(),
                stack_id: "drop-cleanup".to_owned(),
                workspace_root: root.clone(),
                services: vec![helper_service(&root, "api", available_port())],
            })
            .expect("stack starts");
        let port = snapshot.services[0].endpoint.port;
        let clone = supervisor.clone();
        drop(supervisor);
        assert!(endpoint_is_open(&snapshot.services[0]));
        drop(clone);
        wait_until_port_can_bind(port);
    }

    #[test]
    fn reserved_environment_cannot_override_runtime_authority() {
        let directory = tempdir().expect("temporary workspace");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical workspace");
        let supervisor = RuntimeSupervisor::default();
        let mut service = helper_service(&root, "api", available_port());
        service
            .environment
            .insert("PORT".to_owned(), "1".to_owned());
        let error = supervisor
            .start_stack(RuntimeStackRequest {
                workspace_id: Uuid::new_v4(),
                stack_id: "reserved-env".to_owned(),
                workspace_root: root,
                services: vec![service],
            })
            .expect_err("reserved environment rejected");
        assert_eq!(error, RuntimeError::InvalidEnvironment("api".to_owned()));
    }

    #[test]
    fn runtime_child_service() {
        if env::var_os("RUNTIME_TEST_HELPER").is_none() {
            return;
        }
        let port = env::var("WTS_PORT")
            .expect("injected port")
            .parse::<u16>()
            .expect("numeric port");
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).expect("bind helper service");
        listener
            .set_nonblocking(true)
            .expect("nonblocking helper listener");
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.shutdown(Shutdown::Both);
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("helper listener failed: {error}"),
            }
        }
    }

    fn stack_request(
        root: &Path,
        stack_id: &str,
        preferred: u16,
        workspace_id: Uuid,
    ) -> RuntimeStackRequest {
        let backend = helper_service(root, "backend", preferred);
        let mut frontend = helper_service(root, "frontend", preferred);
        frontend.depends_on = vec!["backend".to_owned()];
        RuntimeStackRequest {
            workspace_id,
            stack_id: stack_id.to_owned(),
            workspace_root: root.to_owned(),
            services: vec![frontend, backend],
        }
    }

    fn helper_service(root: &Path, id: &str, preferred_port: u16) -> RuntimeServiceRequest {
        let executable = env::current_exe()
            .expect("test executable")
            .to_string_lossy()
            .into_owned();
        RuntimeServiceRequest {
            id: id.to_owned(),
            working_directory: root.to_owned(),
            executable,
            args: vec![
                "--exact".to_owned(),
                HELPER_TEST_NAME.to_owned(),
                "--nocapture".to_owned(),
            ],
            environment: BTreeMap::from([("RUNTIME_TEST_HELPER".to_owned(), "1".to_owned())]),
            preferred_port,
            depends_on: Vec::new(),
            health_check: RuntimeHealthCheck::Tcp,
            startup_timeout: Duration::from_secs(5),
        }
    }

    fn available_port() -> u16 {
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .expect("ephemeral listener")
            .local_addr()
            .expect("ephemeral address")
            .port()
    }

    fn endpoint_is_open(service: &RuntimeServiceSnapshot) -> bool {
        TcpStream::connect((Ipv4Addr::LOCALHOST, service.endpoint.port)).is_ok()
    }

    fn wait_until_port_can_bind(port: u16) {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Ok(listener) = TcpListener::bind((Ipv4Addr::LOCALHOST, port)) {
                drop(listener);
                return;
            }
            assert!(
                Instant::now() < deadline,
                "runtime port remained occupied after rollback"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn path_must_be_canonical_not_a_symlink() {
        let directory = tempdir().expect("temporary workspace");
        let root = directory
            .path()
            .canonicalize()
            .expect("canonical workspace");
        let nested = root.join("nested");
        fs::create_dir(&nested).expect("nested directory");
        let supervisor = RuntimeSupervisor::default();
        let request = RuntimeStackRequest {
            workspace_id: Uuid::new_v4(),
            stack_id: "canonical".to_owned(),
            workspace_root: root,
            services: vec![helper_service(&nested, "api", available_port())],
        };
        let snapshot = supervisor
            .start_stack(request)
            .expect("canonical nested path");
        supervisor.stop_stack(&snapshot.key).expect("stop stack");
    }
}
