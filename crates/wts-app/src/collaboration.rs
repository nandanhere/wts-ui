//! Bounded, workspace-isolated orchestration for independent agent tasks.
//!
//! This module deliberately does not know how a provider process is launched.
//! An adapter must attest that it enforces a single writable task scope,
//! and must poll [`CollaborationInvocation::checkpoint`] while it runs. The
//! coordinator supplies the remaining invariants: canonical workspace and
//! worktree-scope boundaries, one writer per overlapping scope, bounded global
//! fan-out, ordered phases, explicit task identifiers, deterministic
//! aggregation, cancellation, deadlines, and bounded summary evidence.

use crate::AgentProvider;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt, fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use thiserror::Error;
use uuid::Uuid;

const MAX_TASK_ID_BYTES: usize = 128;
const GATE_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Stable caller-authored identity used for cancellation and aggregation.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CollaborationTaskId(String);

impl CollaborationTaskId {
    pub fn parse(value: impl Into<String>) -> Result<Self, CollaborationTaskIdError> {
        let value = value.into();
        if value.is_empty() || value.len() > MAX_TASK_ID_BYTES {
            return Err(CollaborationTaskIdError);
        }
        if !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
        {
            return Err(CollaborationTaskIdError);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CollaborationTaskId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[error("collaboration task identifiers must be 1-128 portable ASCII characters")]
pub struct CollaborationTaskIdError;

#[derive(Clone, Debug)]
pub struct CollaborationTask {
    pub task_id: CollaborationTaskId,
    pub workspace_id: Uuid,
    pub workspace_root: PathBuf,
    /// Canonical repository worktree (or, for a whole-stack verification
    /// phase, the workspace root) that is writable for this task.
    pub scope_root: PathBuf,
    pub provider: AgentProvider,
    pub prompt: String,
    /// Tasks in one phase may run concurrently. A higher phase starts only
    /// after every task in all lower phases has returned.
    pub phase: u32,
    /// Includes admission and workspace-writer queue time.
    pub timeout: Duration,
}

#[derive(Clone, Debug)]
pub struct CollaborationPlan {
    pub collaboration_id: Uuid,
    pub tasks: Vec<CollaborationTask>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CollaborationLimits {
    pub maximum_parallel_agents: usize,
    pub maximum_tasks_per_run: usize,
    pub maximum_task_timeout: Duration,
    pub maximum_prompt_bytes: usize,
    pub maximum_output_bytes: usize,
    pub maximum_retained_evidence: usize,
    pub maximum_retained_evidence_bytes: usize,
}

impl Default for CollaborationLimits {
    fn default() -> Self {
        Self {
            maximum_parallel_agents: 4,
            maximum_tasks_per_run: 32,
            maximum_task_timeout: Duration::from_secs(15 * 60),
            maximum_prompt_bytes: 16 * 1024,
            maximum_output_bytes: 1024 * 1024,
            maximum_retained_evidence: 256,
            maximum_retained_evidence_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum CollaborationConfigError {
    #[error("collaboration limits must all be greater than zero")]
    ZeroLimit,
}

#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum CollaborationPlanError {
    #[error("a collaboration plan must contain at least one task")]
    Empty,
    #[error("the collaboration plan exceeds the configured task limit")]
    TooManyTasks,
    #[error("collaboration task identifier `{0}` is duplicated")]
    DuplicateTaskId(CollaborationTaskId),
    #[error("collaboration task `{0}` has an invalid prompt")]
    InvalidPrompt(CollaborationTaskId),
    #[error("collaboration task `{0}` has an invalid timeout")]
    InvalidTimeout(CollaborationTaskId),
    #[error("collaboration task `{0}` does not identify a local directory")]
    InvalidWorkspaceRoot(CollaborationTaskId),
    #[error("workspace `{workspace_id}` was assigned more than one root")]
    WorkspaceIdentityMismatch { workspace_id: Uuid },
    #[error("workspace root is shared by `{first_workspace_id}` and `{second_workspace_id}`")]
    WorkspaceRootAlias {
        first_workspace_id: Uuid,
        second_workspace_id: Uuid,
    },
    #[error("workspace roots overlap and cannot identify independent WTS workspaces")]
    OverlappingWorkspaceRoots,
    #[error("collaboration task `{0}` has a scope outside its WTS workspace")]
    ScopeOutsideWorkspace(CollaborationTaskId),
    #[error("task scopes overlap within one collaboration phase")]
    OverlappingTaskScopes,
    #[error("provider confinement is not verified for task `{task_id}`")]
    ProviderConfinementUnavailable { task_id: CollaborationTaskId },
}

/// The minimum adapter guarantee required for a mutating collaboration task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollaborationConfinement {
    /// Writes are OS- or process-policy-limited to the supplied task scope
    /// (and provider-owned temporary state), with no other WTS root writable.
    WorkspaceWriteIsolated,
    /// The provider's write boundary has not been proven.
    Unverified,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollaborationStopReason {
    Cancelled,
    TimedOut,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollaborationAdapterFailure {
    Unavailable,
    SpawnFailed,
    ProviderFailed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CollaborationAdapterOutcome {
    Succeeded {
        output: String,
    },
    Failed {
        failure: CollaborationAdapterFailure,
        output: String,
    },
    Stopped(CollaborationStopReason),
}

/// One owned provider invocation. Adapters must not broaden `scope_root`.
#[derive(Clone)]
pub struct CollaborationInvocation {
    task_id: CollaborationTaskId,
    workspace_id: Uuid,
    workspace_root: PathBuf,
    scope_root: PathBuf,
    provider: AgentProvider,
    prompt: String,
    deadline: Instant,
    cancellation: TaskCancellation,
}

impl CollaborationInvocation {
    pub fn task_id(&self) -> &CollaborationTaskId {
        &self.task_id
    }

    pub fn workspace_id(&self) -> Uuid {
        self.workspace_id
    }

    pub fn workspace_root(&self) -> &Path {
        &self.workspace_root
    }

    /// The adapter current directory and writable sandbox root.
    pub fn scope_root(&self) -> &Path {
        &self.scope_root
    }

    pub fn provider(&self) -> AgentProvider {
        self.provider
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }

    pub fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }

    /// Adapters should call this between blocking polls. A process adapter
    /// should terminate its owned process group when this returns an error.
    pub fn checkpoint(&self) -> Result<(), CollaborationStopReason> {
        self.cancellation.checkpoint(self.deadline)
    }
}

pub trait CollaborationAdapter: Send + Sync + 'static {
    fn confinement(&self, provider: AgentProvider) -> CollaborationConfinement;
    fn run(&self, invocation: CollaborationInvocation) -> CollaborationAdapterOutcome;
}

#[derive(Clone, Default)]
pub struct CollaborationControl {
    inner: Arc<ControlInner>,
}

#[derive(Default)]
struct ControlInner {
    cancelled: Arc<AtomicBool>,
    tasks: Mutex<BTreeMap<CollaborationTaskId, Arc<AtomicBool>>>,
}

impl CollaborationControl {
    pub fn cancel_all(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
    }

    /// Returns `true` only for the first cancellation request for this task.
    /// Calling this before execution is supported.
    pub fn cancel_task(&self, task_id: &CollaborationTaskId) -> bool {
        let task = self.task_token(task_id);
        !task.swap(true, Ordering::AcqRel)
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::Acquire)
    }

    fn task_token(&self, task_id: &CollaborationTaskId) -> Arc<AtomicBool> {
        recover_lock(&self.inner.tasks)
            .entry(task_id.clone())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    fn cancellation_for(&self, task_id: &CollaborationTaskId) -> TaskCancellation {
        TaskCancellation {
            all: Arc::clone(&self.inner.cancelled),
            task: self.task_token(task_id),
        }
    }
}

#[derive(Clone)]
struct TaskCancellation {
    all: Arc<AtomicBool>,
    task: Arc<AtomicBool>,
}

impl TaskCancellation {
    fn is_cancelled(&self) -> bool {
        self.all.load(Ordering::Acquire) || self.task.load(Ordering::Acquire)
    }

    fn checkpoint(&self, deadline: Instant) -> Result<(), CollaborationStopReason> {
        if self.is_cancelled() {
            return Err(CollaborationStopReason::Cancelled);
        }
        if Instant::now() >= deadline {
            return Err(CollaborationStopReason::TimedOut);
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CollaborationTaskState {
    Succeeded,
    ProviderFailed,
    AdapterFailed,
    AdapterPanicked,
    Cancelled,
    TimedOut,
    OutputTooLarge,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollaborationTaskResult {
    pub task_id: CollaborationTaskId,
    pub workspace_id: Uuid,
    pub provider: AgentProvider,
    pub phase: u32,
    pub state: CollaborationTaskState,
    pub output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<CollaborationAdapterFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<i64>,
    pub completed_at_unix_ms: i64,
    pub duration_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollaborationReport {
    pub collaboration_id: Uuid,
    pub started_at_unix_ms: i64,
    pub completed_at_unix_ms: i64,
    pub duration_ms: u64,
    /// Always ordered by phase, then lexicographically by explicit task ID.
    pub tasks: Vec<CollaborationTaskResult>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CollaborationTaskEvidence {
    pub collaboration_id: Uuid,
    pub task_id: CollaborationTaskId,
    pub workspace_id: Uuid,
    pub workspace_root: PathBuf,
    pub scope_root: PathBuf,
    pub provider: AgentProvider,
    pub phase: u32,
    pub state: CollaborationTaskState,
    pub prompt_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<CollaborationAdapterFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<i64>,
    pub completed_at_unix_ms: i64,
    pub duration_ms: u64,
}

pub struct CollaborationCoordinator<A: CollaborationAdapter> {
    adapter: Arc<A>,
    limits: CollaborationLimits,
    gate: Arc<ExecutionGate>,
    evidence: Arc<Mutex<EvidenceRetention>>,
}

impl<A: CollaborationAdapter> Clone for CollaborationCoordinator<A> {
    fn clone(&self) -> Self {
        Self {
            adapter: Arc::clone(&self.adapter),
            limits: self.limits,
            gate: Arc::clone(&self.gate),
            evidence: Arc::clone(&self.evidence),
        }
    }
}

impl<A: CollaborationAdapter> CollaborationCoordinator<A> {
    pub fn new(adapter: A, limits: CollaborationLimits) -> Result<Self, CollaborationConfigError> {
        if limits.maximum_parallel_agents == 0
            || limits.maximum_tasks_per_run == 0
            || limits.maximum_task_timeout.is_zero()
            || limits.maximum_prompt_bytes == 0
            || limits.maximum_output_bytes == 0
            || limits.maximum_retained_evidence == 0
            || limits.maximum_retained_evidence_bytes == 0
        {
            return Err(CollaborationConfigError::ZeroLimit);
        }
        Ok(Self {
            adapter: Arc::new(adapter),
            limits,
            gate: Arc::new(ExecutionGate::new(limits.maximum_parallel_agents)),
            evidence: Arc::new(Mutex::new(EvidenceRetention::default())),
        })
    }

    pub fn limits(&self) -> CollaborationLimits {
        self.limits
    }

    /// Completed summary evidence in retention order (oldest to newest).
    pub fn retained_evidence(&self) -> Vec<CollaborationTaskEvidence> {
        recover_lock(&self.evidence)
            .entries
            .iter()
            .map(|entry| entry.evidence.clone())
            .collect()
    }

    pub fn execute(
        &self,
        plan: CollaborationPlan,
        control: &CollaborationControl,
    ) -> Result<CollaborationReport, CollaborationPlanError> {
        let prepared = self.prepare(plan.tasks)?;
        let started_at_unix_ms = now_unix_ms();
        let started = Instant::now();
        let collaboration_id = plan.collaboration_id;

        let prompt_digests = prepared
            .iter()
            .map(|task| (task.task_id.clone(), sha256(task.prompt.as_bytes())))
            .collect::<BTreeMap<_, _>>();
        let workspace_roots = prepared
            .iter()
            .map(|task| (task.task_id.clone(), task.workspace_root.clone()))
            .collect::<BTreeMap<_, _>>();
        let scope_roots = prepared
            .iter()
            .map(|task| (task.task_id.clone(), task.scope_root.clone()))
            .collect::<BTreeMap<_, _>>();

        let mut phased = BTreeMap::<u32, BTreeMap<PathBuf, Vec<PreparedTask>>>::new();
        for task in prepared {
            phased
                .entry(task.phase)
                .or_default()
                .entry(task.scope_root.clone())
                .or_default()
                .push(task);
        }
        let results = Mutex::new(Vec::with_capacity(prompt_digests.len()));
        for grouped in phased.into_values() {
            let mut groups = grouped.into_values().collect::<Vec<_>>();
            for tasks in &mut groups {
                tasks.sort_by(|left, right| left.task_id.cmp(&right.task_id));
            }
            let next_group = AtomicUsize::new(0);
            let worker_count = groups.len().min(self.limits.maximum_parallel_agents);
            thread::scope(|scope| {
                for _ in 0..worker_count {
                    scope.spawn(|| {
                        loop {
                            let group_index = next_group.fetch_add(1, Ordering::Relaxed);
                            let Some(group) = groups.get(group_index) else {
                                break;
                            };
                            for task in group {
                                let result = self.execute_task(task, control);
                                recover_lock(&results).push(result);
                            }
                        }
                    });
                }
            });
        }

        let mut tasks = results
            .into_inner()
            .unwrap_or_else(|error| error.into_inner());
        tasks.sort_by(|left, right| {
            left.phase
                .cmp(&right.phase)
                .then_with(|| left.task_id.cmp(&right.task_id))
        });
        let completed_at_unix_ms = now_unix_ms();
        let report = CollaborationReport {
            collaboration_id,
            started_at_unix_ms,
            completed_at_unix_ms,
            duration_ms: elapsed_ms(started),
            tasks,
        };
        self.retain_report_evidence(
            &report,
            &prompt_digests,
            &workspace_roots,
            &scope_roots,
            self.limits.maximum_retained_evidence,
            self.limits.maximum_retained_evidence_bytes,
        );
        Ok(report)
    }

    fn prepare(
        &self,
        tasks: Vec<CollaborationTask>,
    ) -> Result<Vec<PreparedTask>, CollaborationPlanError> {
        if tasks.is_empty() {
            return Err(CollaborationPlanError::Empty);
        }
        if tasks.len() > self.limits.maximum_tasks_per_run {
            return Err(CollaborationPlanError::TooManyTasks);
        }

        let mut task_ids = BTreeSet::new();
        let mut roots_by_workspace = BTreeMap::<Uuid, PathBuf>::new();
        let mut owners_by_root = BTreeMap::<PathBuf, Uuid>::new();
        let mut scopes_by_phase = BTreeMap::<u32, Vec<PathBuf>>::new();
        let mut prepared = Vec::with_capacity(tasks.len());
        for task in tasks {
            if !task_ids.insert(task.task_id.clone()) {
                return Err(CollaborationPlanError::DuplicateTaskId(task.task_id));
            }
            let prompt = task.prompt.trim().to_owned();
            if prompt.is_empty()
                || prompt.len() > self.limits.maximum_prompt_bytes
                || prompt.contains('\0')
            {
                return Err(CollaborationPlanError::InvalidPrompt(task.task_id));
            }
            if task.timeout.is_zero() || task.timeout > self.limits.maximum_task_timeout {
                return Err(CollaborationPlanError::InvalidTimeout(task.task_id));
            }
            if self.adapter.confinement(task.provider)
                != CollaborationConfinement::WorkspaceWriteIsolated
            {
                return Err(CollaborationPlanError::ProviderConfinementUnavailable {
                    task_id: task.task_id,
                });
            }
            if !task.workspace_root.is_absolute() {
                return Err(CollaborationPlanError::InvalidWorkspaceRoot(task.task_id));
            }
            let workspace_root = fs::canonicalize(&task.workspace_root)
                .map_err(|_| CollaborationPlanError::InvalidWorkspaceRoot(task.task_id.clone()))?;
            let metadata = workspace_root
                .symlink_metadata()
                .map_err(|_| CollaborationPlanError::InvalidWorkspaceRoot(task.task_id.clone()))?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(CollaborationPlanError::InvalidWorkspaceRoot(task.task_id));
            }
            if let Some(existing) = roots_by_workspace.get(&task.workspace_id) {
                if existing != &workspace_root {
                    return Err(CollaborationPlanError::WorkspaceIdentityMismatch {
                        workspace_id: task.workspace_id,
                    });
                }
            } else {
                roots_by_workspace.insert(task.workspace_id, workspace_root.clone());
            }
            if let Some(existing) = owners_by_root.get(&workspace_root) {
                if *existing != task.workspace_id {
                    return Err(CollaborationPlanError::WorkspaceRootAlias {
                        first_workspace_id: *existing,
                        second_workspace_id: task.workspace_id,
                    });
                }
            } else {
                owners_by_root.insert(workspace_root.clone(), task.workspace_id);
            }
            if !task.scope_root.is_absolute() {
                return Err(CollaborationPlanError::ScopeOutsideWorkspace(task.task_id));
            }
            let scope_root = fs::canonicalize(&task.scope_root)
                .map_err(|_| CollaborationPlanError::ScopeOutsideWorkspace(task.task_id.clone()))?;
            let scope_metadata = scope_root
                .symlink_metadata()
                .map_err(|_| CollaborationPlanError::ScopeOutsideWorkspace(task.task_id.clone()))?;
            if !scope_metadata.is_dir()
                || scope_metadata.file_type().is_symlink()
                || !scope_root.starts_with(&workspace_root)
            {
                return Err(CollaborationPlanError::ScopeOutsideWorkspace(task.task_id));
            }
            scopes_by_phase
                .entry(task.phase)
                .or_default()
                .push(scope_root.clone());
            prepared.push(PreparedTask {
                task_id: task.task_id,
                workspace_id: task.workspace_id,
                workspace_root,
                scope_root,
                provider: task.provider,
                prompt,
                phase: task.phase,
                timeout: task.timeout,
            });
        }

        let roots = owners_by_root.keys().collect::<Vec<_>>();
        for (index, root) in roots.iter().enumerate() {
            for other in roots.iter().skip(index + 1) {
                if root.starts_with(other) || other.starts_with(root) {
                    return Err(CollaborationPlanError::OverlappingWorkspaceRoots);
                }
            }
        }
        for scopes in scopes_by_phase.values() {
            for (index, scope) in scopes.iter().enumerate() {
                for other in scopes.iter().skip(index + 1) {
                    if paths_overlap(scope, other) {
                        return Err(CollaborationPlanError::OverlappingTaskScopes);
                    }
                }
            }
        }
        Ok(prepared)
    }

    fn execute_task(
        &self,
        task: &PreparedTask,
        control: &CollaborationControl,
    ) -> CollaborationTaskResult {
        let queued = Instant::now();
        let deadline = queued
            .checked_add(task.timeout)
            .unwrap_or_else(Instant::now);
        let cancellation = control.cancellation_for(&task.task_id);
        let permit = match self.gate.acquire(&task.scope_root, &cancellation, deadline) {
            Ok(permit) => permit,
            Err(reason) => return stopped_result(task, reason, None, queued),
        };
        let started_at_unix_ms = now_unix_ms();
        let started = Instant::now();
        if let Err(reason) = cancellation.checkpoint(deadline) {
            drop(permit);
            return stopped_result(task, reason, Some(started_at_unix_ms), started);
        }
        let invocation = CollaborationInvocation {
            task_id: task.task_id.clone(),
            workspace_id: task.workspace_id,
            workspace_root: task.workspace_root.clone(),
            scope_root: task.scope_root.clone(),
            provider: task.provider,
            prompt: task.prompt.clone(),
            deadline,
            cancellation: cancellation.clone(),
        };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.adapter.run(invocation)
        }));
        drop(permit);

        let completed_at_unix_ms = now_unix_ms();
        let duration_ms = elapsed_ms(started);
        if cancellation.is_cancelled() {
            return result(
                task,
                CollaborationTaskState::Cancelled,
                String::new(),
                None,
                Some(started_at_unix_ms),
                completed_at_unix_ms,
                duration_ms,
            );
        }
        if Instant::now() >= deadline {
            return result(
                task,
                CollaborationTaskState::TimedOut,
                String::new(),
                None,
                Some(started_at_unix_ms),
                completed_at_unix_ms,
                duration_ms,
            );
        }
        match outcome {
            Err(_) => result(
                task,
                CollaborationTaskState::AdapterPanicked,
                String::new(),
                None,
                Some(started_at_unix_ms),
                completed_at_unix_ms,
                duration_ms,
            ),
            Ok(CollaborationAdapterOutcome::Stopped(reason)) => {
                stopped_result(task, reason, Some(started_at_unix_ms), started)
            }
            Ok(CollaborationAdapterOutcome::Succeeded { output }) => {
                if output.len() > self.limits.maximum_output_bytes {
                    result(
                        task,
                        CollaborationTaskState::OutputTooLarge,
                        String::new(),
                        None,
                        Some(started_at_unix_ms),
                        completed_at_unix_ms,
                        duration_ms,
                    )
                } else {
                    result(
                        task,
                        CollaborationTaskState::Succeeded,
                        output,
                        None,
                        Some(started_at_unix_ms),
                        completed_at_unix_ms,
                        duration_ms,
                    )
                }
            }
            Ok(CollaborationAdapterOutcome::Failed { failure, output }) => {
                if output.len() > self.limits.maximum_output_bytes {
                    result(
                        task,
                        CollaborationTaskState::OutputTooLarge,
                        String::new(),
                        Some(failure),
                        Some(started_at_unix_ms),
                        completed_at_unix_ms,
                        duration_ms,
                    )
                } else {
                    let state = if failure == CollaborationAdapterFailure::ProviderFailed {
                        CollaborationTaskState::ProviderFailed
                    } else {
                        CollaborationTaskState::AdapterFailed
                    };
                    result(
                        task,
                        state,
                        output,
                        Some(failure),
                        Some(started_at_unix_ms),
                        completed_at_unix_ms,
                        duration_ms,
                    )
                }
            }
        }
    }

    fn retain_report_evidence(
        &self,
        report: &CollaborationReport,
        prompt_digests: &BTreeMap<CollaborationTaskId, String>,
        workspace_roots: &BTreeMap<CollaborationTaskId, PathBuf>,
        scope_roots: &BTreeMap<CollaborationTaskId, PathBuf>,
        maximum_count: usize,
        maximum_bytes: usize,
    ) {
        let mut retention = recover_lock(&self.evidence);
        for task in &report.tasks {
            let evidence = CollaborationTaskEvidence {
                collaboration_id: report.collaboration_id,
                task_id: task.task_id.clone(),
                workspace_id: task.workspace_id,
                workspace_root: workspace_roots
                    .get(&task.task_id)
                    .cloned()
                    .expect("prepared task has a workspace root"),
                scope_root: scope_roots
                    .get(&task.task_id)
                    .cloned()
                    .expect("prepared task has a scope root"),
                provider: task.provider,
                phase: task.phase,
                state: task.state,
                prompt_sha256: prompt_digests
                    .get(&task.task_id)
                    .cloned()
                    .expect("prepared task has a prompt digest"),
                output_sha256: (!task.output.is_empty()).then(|| sha256(task.output.as_bytes())),
                failure: task.failure,
                started_at_unix_ms: task.started_at_unix_ms,
                completed_at_unix_ms: task.completed_at_unix_ms,
                duration_ms: task.duration_ms,
            };
            let Ok(bytes) = serde_json::to_vec(&evidence).map(|bytes| bytes.len()) else {
                continue;
            };
            if bytes > maximum_bytes {
                continue;
            }
            retention.total_bytes = retention.total_bytes.saturating_add(bytes);
            retention
                .entries
                .push_back(RetainedEvidence { bytes, evidence });
            while retention.entries.len() > maximum_count || retention.total_bytes > maximum_bytes {
                let Some(removed) = retention.entries.pop_front() else {
                    break;
                };
                retention.total_bytes = retention.total_bytes.saturating_sub(removed.bytes);
            }
        }
    }
}

#[derive(Clone)]
struct PreparedTask {
    task_id: CollaborationTaskId,
    workspace_id: Uuid,
    workspace_root: PathBuf,
    scope_root: PathBuf,
    provider: AgentProvider,
    prompt: String,
    phase: u32,
    timeout: Duration,
}

fn result(
    task: &PreparedTask,
    state: CollaborationTaskState,
    output: String,
    failure: Option<CollaborationAdapterFailure>,
    started_at_unix_ms: Option<i64>,
    completed_at_unix_ms: i64,
    duration_ms: u64,
) -> CollaborationTaskResult {
    CollaborationTaskResult {
        task_id: task.task_id.clone(),
        workspace_id: task.workspace_id,
        provider: task.provider,
        phase: task.phase,
        state,
        output,
        failure,
        started_at_unix_ms,
        completed_at_unix_ms,
        duration_ms,
    }
}

fn stopped_result(
    task: &PreparedTask,
    reason: CollaborationStopReason,
    started_at_unix_ms: Option<i64>,
    started: Instant,
) -> CollaborationTaskResult {
    let state = match reason {
        CollaborationStopReason::Cancelled => CollaborationTaskState::Cancelled,
        CollaborationStopReason::TimedOut => CollaborationTaskState::TimedOut,
    };
    result(
        task,
        state,
        String::new(),
        None,
        started_at_unix_ms,
        now_unix_ms(),
        elapsed_ms(started),
    )
}

struct ExecutionGate {
    maximum: usize,
    state: Mutex<ExecutionGateState>,
    changed: Condvar,
}

#[derive(Default)]
struct ExecutionGateState {
    active: usize,
    workspace_roots: BTreeSet<PathBuf>,
}

impl ExecutionGate {
    fn new(maximum: usize) -> Self {
        Self {
            maximum,
            state: Mutex::new(ExecutionGateState::default()),
            changed: Condvar::new(),
        }
    }

    fn acquire<'a>(
        &'a self,
        workspace_root: &Path,
        cancellation: &TaskCancellation,
        deadline: Instant,
    ) -> Result<ExecutionPermit<'a>, CollaborationStopReason> {
        let mut state = recover_lock(&self.state);
        loop {
            cancellation.checkpoint(deadline)?;
            if state.active < self.maximum
                && !state
                    .workspace_roots
                    .iter()
                    .any(|active| paths_overlap(active, workspace_root))
            {
                state.active += 1;
                state.workspace_roots.insert(workspace_root.to_owned());
                return Ok(ExecutionPermit {
                    gate: self,
                    workspace_root: workspace_root.to_owned(),
                });
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(CollaborationStopReason::TimedOut);
            }
            let wait = remaining.min(GATE_POLL_INTERVAL);
            let (next, _) = self
                .changed
                .wait_timeout(state, wait)
                .unwrap_or_else(|error| error.into_inner());
            state = next;
        }
    }
}

struct ExecutionPermit<'a> {
    gate: &'a ExecutionGate,
    workspace_root: PathBuf,
}

impl Drop for ExecutionPermit<'_> {
    fn drop(&mut self) {
        let mut state = recover_lock(&self.gate.state);
        state.active = state.active.saturating_sub(1);
        state.workspace_roots.remove(&self.workspace_root);
        self.gate.changed.notify_all();
    }
}

#[derive(Default)]
struct EvidenceRetention {
    entries: VecDeque<RetainedEvidence>,
    total_bytes: usize,
}

struct RetainedEvidence {
    bytes: usize,
    evidence: CollaborationTaskEvidence,
}

fn recover_lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn sha256(bytes: &[u8]) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes);
    hex::encode(digest.finalize())
}

fn now_unix_ms() -> i64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(elapsed).unwrap_or(i64::MAX)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{
            Barrier,
            atomic::{AtomicUsize, Ordering},
        },
        time::Duration,
    };
    use tempfile::{TempDir, tempdir};

    #[derive(Clone)]
    struct FakeAdapter {
        state: Arc<FakeState>,
        confinement: CollaborationConfinement,
    }

    struct FakeState {
        active: AtomicUsize,
        maximum_active: AtomicUsize,
        first_pair: Barrier,
        first_pair_count: AtomicUsize,
        active_roots: Mutex<BTreeSet<PathBuf>>,
        started: (Mutex<BTreeSet<CollaborationTaskId>>, Condvar),
        calls: Mutex<Vec<(CollaborationTaskId, PathBuf)>>,
    }

    impl FakeAdapter {
        fn isolated() -> Self {
            Self {
                state: Arc::new(FakeState {
                    active: AtomicUsize::new(0),
                    maximum_active: AtomicUsize::new(0),
                    first_pair: Barrier::new(2),
                    first_pair_count: AtomicUsize::new(0),
                    active_roots: Mutex::new(BTreeSet::new()),
                    started: (Mutex::new(BTreeSet::new()), Condvar::new()),
                    calls: Mutex::new(Vec::new()),
                }),
                confinement: CollaborationConfinement::WorkspaceWriteIsolated,
            }
        }

        fn wait_until_started(&self, task_id: &CollaborationTaskId) {
            let deadline = Instant::now() + Duration::from_secs(2);
            let (lock, changed) = &self.state.started;
            let mut started = recover_lock(lock);
            while !started.contains(task_id) {
                assert!(Instant::now() < deadline, "task did not start");
                let (next, _) = changed
                    .wait_timeout(started, Duration::from_millis(20))
                    .unwrap_or_else(|error| error.into_inner());
                started = next;
            }
        }
    }

    impl CollaborationAdapter for FakeAdapter {
        fn confinement(&self, _provider: AgentProvider) -> CollaborationConfinement {
            self.confinement
        }

        fn run(&self, invocation: CollaborationInvocation) -> CollaborationAdapterOutcome {
            {
                let (started, changed) = &self.state.started;
                recover_lock(started).insert(invocation.task_id().clone());
                changed.notify_all();
            }
            let active = self.state.active.fetch_add(1, Ordering::AcqRel) + 1;
            self.state
                .maximum_active
                .fetch_max(active, Ordering::AcqRel);
            assert!(
                recover_lock(&self.state.active_roots).insert(invocation.scope_root().to_owned()),
                "two adapters entered one task scope"
            );
            recover_lock(&self.state.calls).push((
                invocation.task_id().clone(),
                invocation.scope_root().to_owned(),
            ));

            let pair = self.state.first_pair_count.fetch_add(1, Ordering::AcqRel);
            if pair < 2 {
                self.state.first_pair.wait();
            }
            let outcome = match invocation.prompt() {
                "wait-for-cancel" | "wait-for-timeout" => loop {
                    if let Err(reason) = invocation.checkpoint() {
                        break CollaborationAdapterOutcome::Stopped(reason);
                    }
                    thread::sleep(Duration::from_millis(5));
                },
                "panic" => panic!("deterministic fake adapter panic"),
                _ => {
                    invocation.checkpoint().expect("active fake task");
                    let marker = invocation
                        .scope_root()
                        .join(format!("{}.marker", invocation.task_id()));
                    fs::write(&marker, invocation.workspace_id().to_string())
                        .expect("write workspace marker");
                    CollaborationAdapterOutcome::Succeeded {
                        output: format!("{}:{}", invocation.task_id(), invocation.workspace_id()),
                    }
                }
            };
            assert!(
                recover_lock(&self.state.active_roots).remove(invocation.scope_root()),
                "active task scope must be registered"
            );
            self.state.active.fetch_sub(1, Ordering::AcqRel);
            outcome
        }
    }

    fn fixture_roots(count: usize) -> (TempDir, Vec<PathBuf>) {
        let fixture = tempdir().expect("temporary fixture");
        let roots = (0..count)
            .map(|index| {
                let root = fixture.path().join(format!("workspace-{index}"));
                fs::create_dir(&root).expect("workspace root");
                root.canonicalize().expect("canonical workspace root")
            })
            .collect();
        (fixture, roots)
    }

    fn task(
        task_id: &str,
        workspace_id: Uuid,
        workspace_root: &Path,
        prompt: &str,
        timeout: Duration,
    ) -> CollaborationTask {
        scoped_task(
            task_id,
            workspace_id,
            workspace_root,
            workspace_root,
            prompt,
            0,
            timeout,
        )
    }

    fn scoped_task(
        task_id: &str,
        workspace_id: Uuid,
        workspace_root: &Path,
        scope_root: &Path,
        prompt: &str,
        phase: u32,
        timeout: Duration,
    ) -> CollaborationTask {
        CollaborationTask {
            task_id: CollaborationTaskId::parse(task_id).expect("task id"),
            workspace_id,
            workspace_root: workspace_root.to_owned(),
            scope_root: scope_root.to_owned(),
            provider: AgentProvider::Codex,
            prompt: prompt.to_owned(),
            phase,
            timeout,
        }
    }

    fn limits(maximum_parallel_agents: usize) -> CollaborationLimits {
        CollaborationLimits {
            maximum_parallel_agents,
            maximum_task_timeout: Duration::from_secs(2),
            ..CollaborationLimits::default()
        }
    }

    #[test]
    fn disjoint_same_workspace_agents_overlap_then_verification_runs() {
        let (_fixture, roots) = fixture_roots(2);
        let backend = roots[0].join("backend");
        let frontend = roots[0].join("frontend");
        fs::create_dir(&backend).expect("backend worktree");
        fs::create_dir(&frontend).expect("frontend worktree");
        let adapter = FakeAdapter::isolated();
        let state = Arc::clone(&adapter.state);
        let coordinator = CollaborationCoordinator::new(adapter, limits(2)).expect("coordinator");
        let workspace_a = Uuid::from_u128(1);
        let workspace_b = Uuid::from_u128(2);
        let timeout = Duration::from_secs(1);
        let plan = CollaborationPlan {
            collaboration_id: Uuid::from_u128(99),
            tasks: vec![
                scoped_task(
                    "b-backend",
                    workspace_a,
                    &roots[0],
                    &backend,
                    "fast",
                    0,
                    timeout,
                ),
                task("c-worker", workspace_b, &roots[1], "fast", timeout),
                scoped_task(
                    "a-frontend",
                    workspace_a,
                    &roots[0],
                    &frontend,
                    "fast",
                    0,
                    timeout,
                ),
                scoped_task(
                    "z-verify",
                    workspace_a,
                    &roots[0],
                    &roots[0],
                    "fast",
                    1,
                    timeout,
                ),
            ],
        };

        let report = coordinator
            .execute(plan, &CollaborationControl::default())
            .expect("collaboration report");

        assert_eq!(state.maximum_active.load(Ordering::Acquire), 2);
        assert_eq!(
            report
                .tasks
                .iter()
                .map(|task| task.task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a-frontend", "b-backend", "c-worker", "z-verify"]
        );
        assert!(
            report
                .tasks
                .iter()
                .all(|task| task.state == CollaborationTaskState::Succeeded)
        );
        for (task_id, workspace_id, scope) in [
            ("a-frontend", workspace_a, &frontend),
            ("b-backend", workspace_a, &backend),
            ("c-worker", workspace_b, &roots[1]),
            ("z-verify", workspace_a, &roots[0]),
        ] {
            assert_eq!(
                fs::read_to_string(scope.join(format!("{task_id}.marker")))
                    .expect("scope-local marker"),
                workspace_id.to_string()
            );
        }
        let calls = recover_lock(&state.calls);
        assert_eq!(
            calls.last().map(|(task_id, _)| task_id.as_str()),
            Some("z-verify"),
            "the whole-stack verifier must enter only after phase zero"
        );
    }

    #[test]
    fn cancellation_timeout_and_panics_do_not_block_sibling_workspaces() {
        let (_fixture, roots) = fixture_roots(4);
        let adapter = FakeAdapter::isolated();
        let observer = adapter.clone();
        let coordinator = CollaborationCoordinator::new(adapter, limits(4)).expect("coordinator");
        let control = CollaborationControl::default();
        let cancelled_id = CollaborationTaskId::parse("cancelled").expect("task id");
        let plan = CollaborationPlan {
            collaboration_id: Uuid::from_u128(100),
            tasks: vec![
                task(
                    cancelled_id.as_str(),
                    Uuid::from_u128(1),
                    &roots[0],
                    "wait-for-cancel",
                    Duration::from_secs(1),
                ),
                task(
                    "timed-out",
                    Uuid::from_u128(2),
                    &roots[1],
                    "wait-for-timeout",
                    Duration::from_millis(80),
                ),
                task(
                    "panicked",
                    Uuid::from_u128(3),
                    &roots[2],
                    "panic",
                    Duration::from_secs(1),
                ),
                task(
                    "succeeded",
                    Uuid::from_u128(4),
                    &roots[3],
                    "fast",
                    Duration::from_secs(1),
                ),
            ],
        };
        let runner = {
            let coordinator = coordinator.clone();
            let control = control.clone();
            thread::spawn(move || coordinator.execute(plan, &control).expect("report"))
        };
        observer.wait_until_started(&cancelled_id);
        assert!(control.cancel_task(&cancelled_id));

        let report = runner.join().expect("collaboration thread");
        let states = report
            .tasks
            .iter()
            .map(|task| (task.task_id.as_str(), task.state))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(states["cancelled"], CollaborationTaskState::Cancelled);
        assert_eq!(states["timed-out"], CollaborationTaskState::TimedOut);
        assert_eq!(states["panicked"], CollaborationTaskState::AdapterPanicked);
        assert_eq!(states["succeeded"], CollaborationTaskState::Succeeded);
    }

    #[test]
    fn rejects_unverified_and_overlapping_scope_boundaries_before_dispatch() {
        let (fixture, roots) = fixture_roots(1);
        let nested = roots[0].join("nested");
        fs::create_dir(&nested).expect("nested workspace");
        let unverified = FakeAdapter {
            confinement: CollaborationConfinement::Unverified,
            ..FakeAdapter::isolated()
        };
        let unverified_state = Arc::clone(&unverified.state);
        let coordinator =
            CollaborationCoordinator::new(unverified, limits(2)).expect("coordinator");
        let error = coordinator
            .execute(
                CollaborationPlan {
                    collaboration_id: Uuid::new_v4(),
                    tasks: vec![task(
                        "unsafe",
                        Uuid::new_v4(),
                        &roots[0],
                        "fast",
                        Duration::from_secs(1),
                    )],
                },
                &CollaborationControl::default(),
            )
            .expect_err("unverified provider must be rejected");
        assert!(matches!(
            error,
            CollaborationPlanError::ProviderConfinementUnavailable { .. }
        ));
        assert!(recover_lock(&unverified_state.calls).is_empty());

        let adapter = FakeAdapter::isolated();
        let state = Arc::clone(&adapter.state);
        let coordinator = CollaborationCoordinator::new(adapter, limits(2)).expect("coordinator");
        let error = coordinator
            .execute(
                CollaborationPlan {
                    collaboration_id: Uuid::new_v4(),
                    tasks: vec![
                        scoped_task(
                            "parent",
                            Uuid::from_u128(1),
                            &roots[0],
                            &roots[0],
                            "fast",
                            0,
                            Duration::from_secs(1),
                        ),
                        scoped_task(
                            "child",
                            Uuid::from_u128(1),
                            &roots[0],
                            &nested,
                            "fast",
                            0,
                            Duration::from_secs(1),
                        ),
                    ],
                },
                &CollaborationControl::default(),
            )
            .expect_err("overlapping scopes must be rejected");
        assert_eq!(error, CollaborationPlanError::OverlappingTaskScopes);
        assert!(recover_lock(&state.calls).is_empty());
        drop(fixture);
    }

    #[test]
    fn retained_evidence_is_digest_only_and_count_bounded() {
        let (_fixture, roots) = fixture_roots(3);
        let adapter = FakeAdapter::isolated();
        let mut retention_limits = limits(3);
        retention_limits.maximum_retained_evidence = 2;
        let coordinator =
            CollaborationCoordinator::new(adapter, retention_limits).expect("coordinator");
        coordinator
            .execute(
                CollaborationPlan {
                    collaboration_id: Uuid::from_u128(101),
                    tasks: vec![
                        task(
                            "a",
                            Uuid::from_u128(1),
                            &roots[0],
                            "fast",
                            Duration::from_secs(1),
                        ),
                        task(
                            "b",
                            Uuid::from_u128(2),
                            &roots[1],
                            "fast",
                            Duration::from_secs(1),
                        ),
                        task(
                            "c",
                            Uuid::from_u128(3),
                            &roots[2],
                            "fast",
                            Duration::from_secs(1),
                        ),
                    ],
                },
                &CollaborationControl::default(),
            )
            .expect("collaboration report");

        let evidence = coordinator.retained_evidence();
        assert_eq!(evidence.len(), 2);
        assert_eq!(
            evidence
                .iter()
                .map(|entry| entry.task_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b", "c"]
        );
        assert!(evidence.iter().all(|entry| {
            entry.prompt_sha256.len() == 64
                && entry
                    .output_sha256
                    .as_ref()
                    .is_some_and(|hash| hash.len() == 64)
        }));
        let encoded = serde_json::to_string(&evidence).expect("serialize evidence");
        assert!(!encoded.contains("fast"));
        assert!(!encoded.contains("b:00000000"));
    }
}
