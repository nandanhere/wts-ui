//! Host checks for the exact file state recorded after one feedback task.
use super::*;

const MAX_CHECKS: usize = 64;
const MAX_RUNS: usize = 64;
const MAX_OUTPUT_BYTES: usize = 65_536;
const MAX_DETAIL_BYTES: usize = 2_048;
const MAX_RECORD_BYTES: u64 = 512 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnChecksState {
    Ready,
    Stale,
    Unavailable,
    NoChecks,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentTurnCheckStatus {
    Running,
    Passed,
    Failed,
    TimedOut,
    Cancelled,
    Interrupted,
    Stale,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnCheck {
    pub check_id: String,
    pub label: String,
    pub kind: VerificationCheckKind,
    pub plan_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnCheckRun {
    pub run_id: Uuid,
    pub check_id: String,
    pub status: AgentTurnCheckStatus,
    pub started_at_unix_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub output: String,
    pub output_truncated: bool,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentTurnChecks {
    pub schema_version: u32,
    pub conversation_id: Uuid,
    pub request_id: Uuid,
    pub session_id: Uuid,
    pub workspace_id: Uuid,
    pub repository_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_checkpoint_id: Option<Uuid>,
    pub state: AgentTurnChecksState,
    pub detail: String,
    pub checks: Vec<AgentTurnCheck>,
    pub runs: Vec<AgentTurnCheckRun>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunAgentTurnCheckRequest {
    pub request_id: Uuid,
    pub check_id: String,
    pub expected_after_checkpoint_id: Uuid,
    pub expected_plan_revision: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCheckRun {
    conversation_id: Uuid,
    turn_request_id: Uuid,
    session_id: Uuid,
    workspace_id: Uuid,
    repository_id: String,
    source_context_sha256: String,
    request: RunAgentTurnCheckRequest,
    check: VerificationCheck,
    #[serde(default)]
    verification_started_at_unix_ms: Option<i64>,
    run: AgentTurnCheckRun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct VerifiedTurnCheck {
    pub check: VerificationCheck,
    pub run_id: Uuid,
    pub completed_at_unix_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct VerifiedTurnChecks {
    pub after_checkpoint_id: Uuid,
    pub plan_revision: u64,
    pub checks: Vec<VerifiedTurnCheck>,
}

/// The caller holds the verification lock, store locks, and candidate writer leases.
pub(super) fn integration_check_proof(
    service: &LocalWtsService,
    target: &turn_changes::TrustedTurnCheckTarget,
) -> Result<VerifiedTurnChecks, LocalWtsError> {
    if !turn_changes::matches_check_target(target)? {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let (revision, checks) = eligible_checks(service, target)?;
    if checks.is_empty() {
        return Err(LocalWtsError::VerificationCheckUnavailable);
    }
    proof_from_saved_runs(
        &service.inner.agent_conversations,
        &target.receipt,
        revision,
        &checks,
    )
}

fn proof_from_saved_runs(
    store: &ConversationStore,
    receipt: &AgentTurnChanges,
    revision: u64,
    checks: &[VerificationCheck],
) -> Result<VerifiedTurnChecks, LocalWtsError> {
    if checks.is_empty() || checks.len() > MAX_CHECKS || revision == 0 {
        return Err(LocalWtsError::AgentConversationConflict);
    }
    let after_checkpoint_id = receipt
        .after
        .as_ref()
        .ok_or(LocalWtsError::AgentConversationConflict)?
        .checkpoint_id;
    let records = read_runs(store, receipt)?;
    let mut proof = Vec::with_capacity(checks.len());
    let mut ids = BTreeSet::new();
    for check in checks {
        if !ids.insert(check.id.as_str()) {
            return Err(LocalWtsError::AgentConversationConflict);
        }
        let matching = records
            .iter()
            .filter(|record| record.run.check_id == check.id)
            .collect::<Vec<_>>();
        let latest = matching
            .iter()
            .max_by_key(|record| (record.run.started_at_unix_ms, record.run.run_id))
            .ok_or(LocalWtsError::AgentConversationConflict)?;
        // Do not infer an order when two saved starts have the same timestamp.
        for record in matching
            .iter()
            .filter(|record| record.run.started_at_unix_ms == latest.run.started_at_unix_ms)
        {
            if record.run.status != AgentTurnCheckStatus::Passed
                || record.run.exit_code != Some(0)
                || record.run.completed_at_unix_ms.is_none()
                || record.request.expected_after_checkpoint_id != after_checkpoint_id
                || record.request.expected_plan_revision != revision
                || record.check != *check
            {
                return Err(LocalWtsError::AgentConversationConflict);
            }
        }
        proof.push(VerifiedTurnCheck {
            check: check.clone(),
            run_id: latest.run.run_id,
            completed_at_unix_ms: latest
                .run
                .completed_at_unix_ms
                .ok_or(LocalWtsError::AgentConversationConflict)?,
        });
    }
    Ok(VerifiedTurnChecks {
        after_checkpoint_id,
        plan_revision: revision,
        checks: proof,
    })
}

#[cfg(test)]
#[path = "agent_turn_check_proof_tests.rs"]
mod proof_tests;

#[cfg(all(test, unix))]
#[test]
fn removal_takes_conversation_guard_before_waiting_for_materialization() {
    let directory = tempfile::tempdir().unwrap();
    let repositories = directory.path().join("repositories");
    fs::create_dir(&repositories).unwrap();
    let service = LocalWtsService::open(
        directory.path().join("data"),
        "test",
        directory.path().join("workspaces"),
        &repositories,
    )
    .unwrap();
    let workspace = service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "Lock order".to_owned(),
                },
                title: "Lock order".to_owned(),
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
    let preflight = service
        .preflight_workspace_removal(workspace.workspace_id)
        .unwrap();
    assert!(preflight.ready);
    let materialization = service.inner.materialization_lock.lock().unwrap();
    let worker = service.clone();
    let handle = std::thread::spawn(move || {
        worker.remove_workspace(
            workspace.workspace_id,
            &preflight.effect_digest,
            &Uuid::new_v4().to_string(),
            false,
        )
    });
    let store = &service.inner.agent_conversations;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    let guarded = loop {
        if matches!(
            store.workspace_operation_lease(workspace.workspace_id),
            Err(LocalWtsError::AgentConversationBusy)
        ) && matches!(
            store.lock.try_lock(),
            Err(std::sync::TryLockError::WouldBlock)
        ) {
            break true;
        }
        if std::time::Instant::now() >= deadline {
            break false;
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    drop(materialization);
    handle.join().unwrap().unwrap();
    assert!(
        guarded,
        "Removal must acquire the conversation guard before the materialization lock."
    );
}

#[cfg(all(test, unix))]
#[test]
fn manual_session_rechecks_workspace_after_removal_wins_the_lease() {
    let directory = tempfile::tempdir().unwrap();
    let repositories = directory.path().join("repositories");
    let source = repositories.join("api");
    fs::create_dir_all(&source).unwrap();
    for args in [
        vec!["init", "-b", "main"],
        vec!["config", "user.name", "Fixture"],
        vec!["config", "user.email", "fixture@example.test"],
    ] {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(&source)
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    fs::write(source.join("README.md"), "Keep the source.\n").unwrap();
    for args in [vec!["add", "."], vec!["commit", "-m", "fixture"]] {
        assert!(
            std::process::Command::new("git")
                .arg("-C")
                .arg(&source)
                .args([
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=/dev/null"
                ])
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    let service = LocalWtsService::open(
        directory.path().join("data"),
        "test",
        directory.path().join("workspaces"),
        &repositories,
    )
    .unwrap();
    let workspace = service
        .create_workspace(
            &Uuid::new_v4().to_string(),
            CreateWorkspaceRequest {
                intent: WorkspaceIntent::RepositorySet {
                    label: "Session race".to_owned(),
                },
                title: "Session race".to_owned(),
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
    let preflight = service.preflight_workspace(workspace.workspace_id).unwrap();
    service
        .materialize_workspace(workspace.workspace_id, &preflight.effect_digest)
        .unwrap();
    let ready = service
        .preflight_workspace_removal(workspace.workspace_id)
        .unwrap();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let worker = service.clone();
    let handle = std::thread::spawn(move || {
        worker.start_agent_session_with_guard_callback(
            workspace.workspace_id,
            AgentProvider::Codex,
            TerminalProvider::Terminal,
            AgentSessionCategory::Uncategorized,
            || {
                entered_tx.send(()).unwrap();
                release_rx
                    .recv_timeout(std::time::Duration::from_secs(10))
                    .unwrap();
            },
        )
    });
    entered_rx
        .recv_timeout(std::time::Duration::from_secs(10))
        .unwrap();
    service
        .remove_workspace(
            workspace.workspace_id,
            &ready.effect_digest,
            &Uuid::new_v4().to_string(),
            false,
        )
        .unwrap();
    release_tx.send(()).unwrap();
    let result = handle.join().unwrap();
    assert!(
        result.is_err(),
        "A removed workspace must not receive an active session: {result:?}"
    );
    assert!(
        service
            .list_agent_sessions(Some(workspace.workspace_id))
            .unwrap()
            .sessions
            .is_empty()
    );
    assert!(source.join("README.md").is_file());
}

pub(crate) struct WorkspaceRemovalOperationGuard<'a> {
    _operation: fs::File,
    _disk: fs::File,
    _store: std::sync::MutexGuard<'a, ()>,
}

impl LocalWtsService {
    pub(crate) fn lease_workspace_removal_operation(
        &self,
        workspace_id: Uuid,
    ) -> Result<WorkspaceRemovalOperationGuard<'_>, LocalWtsError> {
        let store = &self.inner.agent_conversations;
        let guard = store
            .lock
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let disk = store.disk_lock()?;
        for id in store.ids()? {
            let conversation = store.read(id)?;
            if conversation.workspace_id == workspace_id && conversation_has_work(&conversation) {
                return Err(LocalWtsError::AgentConversationBusy);
            }
        }
        let operation = store.workspace_operation_lease(workspace_id)?;
        // Keep submissions and queue claims excluded until deletion and the tombstone finish.
        Ok(WorkspaceRemovalOperationGuard {
            _operation: operation,
            _disk: disk,
            _store: guard,
        })
    }

    pub(crate) fn lease_workspace_agent_operation(
        &self,
        workspace_id: Uuid,
    ) -> Result<Arc<fs::File>, LocalWtsError> {
        let store = &self.inner.agent_conversations;
        let _guard = store
            .lock
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let _disk = store.disk_lock()?;
        for id in store.ids()? {
            let conversation = store.read(id)?;
            if conversation.workspace_id == workspace_id && conversation.active_session_id.is_some()
            {
                return Err(LocalWtsError::AgentConversationBusy);
            }
        }
        Ok(Arc::new(store.workspace_operation_lease(workspace_id)?))
    }

    pub fn get_agent_turn_checks(
        &self,
        conversation_id: Uuid,
        request_id: Uuid,
    ) -> Result<AgentTurnChecks, LocalWtsError> {
        let receipt = self.get_agent_turn_changes(conversation_id, request_id)?;
        let conversation = self.get_agent_conversation(conversation_id)?;
        let store = &self.inner.agent_conversations;
        let runs = {
            let _guard = store
                .lock
                .lock()
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
            let _disk = store.disk_lock()?;
            let mut records = read_runs(store, &receipt)?;
            for record in &mut records {
                if matches!(
                    record.run.status,
                    AgentTurnCheckStatus::Running | AgentTurnCheckStatus::Interrupted
                ) && let Ok(_operation) = store.workspace_operation_lease(receipt.workspace_id)
                    && let Ok(_lease) = store.turn_lease(&conversation)
                {
                    if record.run.status == AgentTurnCheckStatus::Running {
                        record.run.status = AgentTurnCheckStatus::Interrupted;
                        record.run.completed_at_unix_ms = Some(now_unix_ms());
                        record.run.detail = "The host stopped before this check result was saved. Review the files. Start a new check to test the current recorded state.".to_owned();
                        save_run(store, &receipt, record)?;
                    }
                    // Retry shared-result repair if another verification held its lock earlier.
                    let _ = reconcile_abandoned_verification(self, record);
                }
            }
            records.into_iter().map(|record| record.run).collect()
        };
        let mut result = AgentTurnChecks {
            schema_version: 1,
            conversation_id,
            request_id,
            session_id: receipt.session_id,
            workspace_id: receipt.workspace_id,
            repository_id: receipt.repository_id.clone(),
            after_checkpoint_id: receipt
                .after
                .as_ref()
                .map(|checkpoint| checkpoint.checkpoint_id),
            state: AgentTurnChecksState::Unavailable,
            detail: "A complete task change record is required. Review the current local changes."
                .to_owned(),
            checks: vec![],
            runs,
        };
        let Ok(target) = turn_changes::load_check_target(self, conversation_id, request_id) else {
            return Ok(result);
        };
        let Ok((revision, checks)) = eligible_checks(self, &target) else {
            result.detail = "WTS could not read the saved verification plan. Open workspace verification to inspect the plan.".to_owned();
            return Ok(result);
        };
        result.checks = checks
            .iter()
            .take(MAX_CHECKS)
            .map(|check| AgentTurnCheck {
                check_id: check.id.clone(),
                label: check.label.clone(),
                kind: check.kind,
                plan_revision: revision,
            })
            .collect();
        if !turn_changes::matches_check_target(&target).unwrap_or(false) {
            result.state = AgentTurnChecksState::Stale;
            result.detail = "The files or Git state changed after this task. Review the current local changes. These checks cannot certify the changed state.".to_owned();
        } else if result.checks.is_empty() {
            result.state = AgentTurnChecksState::NoChecks;
            result.detail = "No saved host-approved check targets this repository. Open workspace verification to inspect or add a supported check.".to_owned();
        } else {
            result.state = AgentTurnChecksState::Ready;
            result.detail = "Run a saved check against the task's recorded file state. WTS compares the files and Git state before and after the check.".to_owned();
        }
        Ok(result)
    }

    pub fn run_agent_turn_check(
        &self,
        conversation_id: Uuid,
        turn_request_id: Uuid,
        request: RunAgentTurnCheckRequest,
    ) -> Result<AgentTurnChecks, LocalWtsError> {
        if request.request_id.is_nil()
            || request.expected_after_checkpoint_id.is_nil()
            || request.expected_plan_revision == 0
            || request.expected_plan_revision > 9_007_199_254_740_991
            || !valid_check_id(&request.check_id)
        {
            return Err(LocalWtsError::InvalidAgentConversation);
        }
        let receipt = self.get_agent_turn_changes(conversation_id, turn_request_id)?;
        let store = &self.inner.agent_conversations;
        {
            let _guard = store
                .lock
                .lock()
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
            let _disk = store.disk_lock()?;
            if let Some(record) = read_runs(store, &receipt)?
                .into_iter()
                .find(|record| record.run.run_id == request.request_id)
            {
                if record.request != request {
                    return Err(LocalWtsError::AgentConversationConflict);
                }
                drop(_disk);
                drop(_guard);
                return self.get_agent_turn_checks(conversation_id, turn_request_id);
            }
        }
        let target = Arc::new(turn_changes::load_check_target(
            self,
            conversation_id,
            turn_request_id,
        )?);
        let (revision, checks) = eligible_checks(self, &target)?;
        let check = checks
            .into_iter()
            .find(|check| check.id == request.check_id)
            .ok_or(LocalWtsError::VerificationCheckUnavailable)?;
        if receipt
            .after
            .as_ref()
            .map(|checkpoint| checkpoint.checkpoint_id)
            != Some(request.expected_after_checkpoint_id)
            || request.expected_plan_revision != revision
        {
            return Err(LocalWtsError::AgentConversationConflict);
        }
        let (operation, lease, mut record) = {
            let _guard = store
                .lock
                .lock()
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
            let _disk = store.disk_lock()?;
            let records = read_runs(store, &receipt)?;
            if let Some(record) = records
                .iter()
                .find(|record| record.run.run_id == request.request_id)
            {
                if record.request != request {
                    return Err(LocalWtsError::AgentConversationConflict);
                }
                drop(_disk);
                drop(_guard);
                return self.get_agent_turn_checks(conversation_id, turn_request_id);
            }
            if records.len() >= MAX_RUNS {
                return Err(LocalWtsError::AgentConversationLimit);
            }
            for id in store.ids()? {
                let current = store.read(id)?;
                if current.workspace_id == receipt.workspace_id
                    && current.active_session_id.is_some()
                {
                    return Err(LocalWtsError::AgentConversationBusy);
                }
            }
            if self
                .inner
                .agent_sessions
                .list(Some(receipt.workspace_id))
                .map_err(map_agent_session_failure)?
                .sessions
                .iter()
                .any(|session| {
                    matches!(
                        session.status,
                        AgentSessionStatus::Launching
                            | AgentSessionStatus::HandoffAccepted
                            | AgentSessionStatus::Running
                            | AgentSessionStatus::Stopping
                    )
                })
            {
                return Err(LocalWtsError::AgentConversationBusy);
            }
            let operation = Arc::new(store.workspace_operation_lease(receipt.workspace_id)?);
            let lease = Arc::new(store.turn_lease(&target.conversation)?);
            let record = StoredCheckRun {
                conversation_id,
                turn_request_id,
                session_id: receipt.session_id,
                workspace_id: receipt.workspace_id,
                repository_id: receipt.repository_id.clone(),
                source_context_sha256: receipt.source_context_sha256.clone(),
                request: request.clone(),
                check: check.clone(),
                verification_started_at_unix_ms: None,
                run: AgentTurnCheckRun {
                    run_id: request.request_id,
                    check_id: request.check_id.clone(),
                    status: AgentTurnCheckStatus::Running,
                    started_at_unix_ms: now_unix_ms(),
                    completed_at_unix_ms: None,
                    duration_ms: None,
                    exit_code: None,
                    output: String::new(),
                    output_truncated: false,
                    detail: "WTS prepares the saved check.".to_owned(),
                },
            };
            save_run(store, &receipt, &record)?;
            (operation, lease, record)
        };
        let started = std::time::Instant::now();
        let output = Arc::new(Mutex::new(Vec::new()));
        let verification_started = Arc::new(Mutex::new(None));
        let started_sink = Arc::clone(&verification_started);
        let started_service = self.clone();
        let started_receipt = receipt.clone();
        let run_id = request.request_id;
        let before_target = Arc::clone(&target);
        let outcome = self.run_selected_workspace_verification(
            receipt.workspace_id,
            VerificationSelection::BoundCheck {
                check: Box::new(check),
                plan_revision: revision,
                before_check: Box::new(move || {
                    turn_changes::matches_check_target(&before_target).unwrap_or(false)
                }),
                on_started: Box::new(move |timestamp| {
                    let store = &started_service.inner.agent_conversations;
                    let _guard = store
                        .lock
                        .lock()
                        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
                    let _disk = store.disk_lock()?;
                    let mut persisted = read_runs(store, &started_receipt)?
                        .into_iter()
                        .find(|record| record.run.run_id == run_id)
                        .ok_or(LocalWtsError::AgentConversationUnavailable)?;
                    persisted.verification_started_at_unix_ms = Some(timestamp);
                    save_run(store, &started_receipt, &persisted)?;
                    *started_sink
                        .lock()
                        .map_err(|_| LocalWtsError::AgentConversationUnavailable)? =
                        Some(timestamp);
                    Ok(())
                }),
                leases: vec![Arc::clone(&operation), Arc::clone(&lease)],
                output: Arc::clone(&output),
            },
        );
        record.verification_started_at_unix_ms = *verification_started
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let still_matches = turn_changes::matches_check_target(&target).unwrap_or(false);
        match outcome {
            Ok(evidence) => {
                let result = evidence
                    .verification_result
                    .checks
                    .iter()
                    .find(|result| result.check_id == request.check_id)
                    .ok_or(LocalWtsError::VerificationCheckUnavailable)?;
                record.run.status = match result.status {
                    VerificationCheckStatus::Passed => AgentTurnCheckStatus::Passed,
                    VerificationCheckStatus::Failed => AgentTurnCheckStatus::Failed,
                    VerificationCheckStatus::TimedOut => AgentTurnCheckStatus::TimedOut,
                    VerificationCheckStatus::Cancelled => AgentTurnCheckStatus::Cancelled,
                    _ => AgentTurnCheckStatus::Blocked,
                };
                record.run.exit_code = result.exit_code;
                record.run.detail = bounded_text(&result.detail, MAX_DETAIL_BYTES).0;
            }
            Err(error) => {
                record.run.status = AgentTurnCheckStatus::Blocked;
                record.run.detail = bounded_text(&format!("The host check could not run: {error}. Open workspace verification to inspect the saved check."), MAX_DETAIL_BYTES).0;
            }
        }
        if !still_matches {
            record.run.status = AgentTurnCheckStatus::Stale;
            record.run.detail = "The files or Git state changed before or during this check. This result does not verify the recorded task state. Review the current local changes.".to_owned();
        }
        let captured = output
            .lock()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        (record.run.output, record.run.output_truncated) =
            bounded_text(&String::from_utf8_lossy(&captured), MAX_OUTPUT_BYTES);
        drop(captured);
        record.run.completed_at_unix_ms = Some(now_unix_ms());
        record.run.duration_ms =
            Some(started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
        {
            let _guard = store
                .lock
                .lock()
                .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
            let _disk = store.disk_lock()?;
            save_run(store, &receipt, &record)?;
            // Persist the terminal result before another agent can acquire either lease.
            drop(lease);
            drop(operation);
        }
        self.get_agent_turn_checks(conversation_id, turn_request_id)
    }
}

fn reconcile_abandoned_verification(
    service: &LocalWtsService,
    record: &StoredCheckRun,
) -> Result<(), LocalWtsError> {
    let Some(started_at) = record.verification_started_at_unix_ms else {
        return Ok(());
    };
    let Ok(_verification) = service.inner.verification_lock.try_lock() else {
        return Ok(());
    };
    let (workspace, materialization) = service.read_materialization_receipt(record.workspace_id)?;
    let view = service
        .inner
        .registry
        .get(record.workspace_id)?
        .ok_or(LocalWtsError::WorkspaceNotFound)?;
    let evidence_store = EvidenceStore::open(&workspace).map_err(map_evidence_failure)?;
    let evidence = evidence_store.read().map_err(map_evidence_failure)?;
    validate_workspace_evidence(&view, &materialization, &evidence)?;
    let mut result = evidence.verification_result;
    if result.status != VerificationStatus::Running
        || result.started_at_unix_ms != Some(started_at)
        || result.plan_revision != record.request.expected_plan_revision
    {
        return Ok(());
    }
    let Some(check) = result.checks.iter_mut().find(|check| {
        check.check_id == record.run.check_id
            && matches!(
                check.status,
                VerificationCheckStatus::Pending | VerificationCheckStatus::Running
            )
    }) else {
        return Ok(());
    };
    check.status = VerificationCheckStatus::Cancelled;
    check.completed_at_unix_ms = Some(now_unix_ms());
    check.detail = "The host stopped before this check result was saved. Run the check again to obtain a result.".to_owned();
    result.status = VerificationStatus::Blocked;
    result.completed_at_unix_ms = Some(now_unix_ms());
    result.duration_ms = elapsed_between(started_at, result.completed_at_unix_ms);
    evidence_store
        .write_verification_result(&result)
        .map_err(map_evidence_failure)
}

fn eligible_checks(
    service: &LocalWtsService,
    target: &turn_changes::TrustedTurnCheckTarget,
) -> Result<(u64, Vec<VerificationCheck>), LocalWtsError> {
    let evidence = service
        .get_workspace_evidence(target.receipt.workspace_id)?
        .ok_or(LocalWtsError::EvidenceUnavailable)?;
    let plan = evidence.verification_plan;
    if plan.revision == 0 || plan.revision > 9_007_199_254_740_991 {
        return Err(LocalWtsError::EvidenceUnavailable);
    }
    let checks: Vec<_> = plan
        .checks
        .into_iter()
        .filter(|check| {
            let working = Path::new(&check.working_directory);
            check.repository_id.as_deref() == Some(target.receipt.repository_id.as_str())
                && valid_check_id(&check.id)
                && !check.label.trim().is_empty()
                && check.label.len() <= 512
                && approved_fixed_command(&check.executable, &check.args)
                && working.starts_with(&target.target)
                && working.canonicalize().ok().as_deref() == Some(working)
                && serde_json::to_vec(check).is_ok_and(|bytes| bytes.len() <= 32 * 1024)
        })
        .collect();
    if checks.len() > MAX_CHECKS {
        return Err(LocalWtsError::AgentConversationLimit);
    }
    Ok((plan.revision, checks))
}

fn valid_check_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn bounded_text(value: &str, limit: usize) -> (String, bool) {
    let clean: String = value
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\r' | '\t'))
        .collect();
    let mut end = clean.len().min(limit);
    while !clean.is_char_boundary(end) {
        end -= 1;
    }
    (clean[..end].to_owned(), clean.len() > end)
}

fn checks_dir(store: &ConversationStore, receipt: &AgentTurnChanges) -> PathBuf {
    store
        .root
        .join("turn-changes")
        .join(receipt.session_id.to_string())
        .join("checks")
}

fn save_run(
    store: &ConversationStore,
    receipt: &AgentTurnChanges,
    record: &StoredCheckRun,
) -> Result<(), LocalWtsError> {
    let directory = checks_dir(store, receipt);
    turn_changes::private_dir(&store.root.join("turn-changes"))?;
    turn_changes::private_dir(
        directory
            .parent()
            .ok_or(LocalWtsError::AgentConversationUnavailable)?,
    )?;
    turn_changes::private_dir(&directory)?;
    let bytes =
        serde_json::to_vec(record).map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
    if bytes.len() > MAX_RECORD_BYTES as usize {
        return Err(LocalWtsError::AgentConversationLimit);
    }
    turn_changes::write_private(
        &directory.join(format!("{}.json", record.run.run_id)),
        &bytes,
    )
}

fn read_runs(
    store: &ConversationStore,
    receipt: &AgentTurnChanges,
) -> Result<Vec<StoredCheckRun>, LocalWtsError> {
    let directory = checks_dir(store, receipt);
    if !directory
        .try_exists()
        .map_err(|_| LocalWtsError::AgentConversationUnavailable)?
    {
        return Ok(vec![]);
    }
    if !directory
        .symlink_metadata()
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
    {
        return Err(LocalWtsError::AgentConversationUnavailable);
    }
    let mut records = vec![];
    for entry in fs::read_dir(directory).map_err(|_| LocalWtsError::AgentConversationUnavailable)? {
        let entry = entry.map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let name = entry.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".json"))
            .and_then(|name| Uuid::parse_str(name).ok())
        else {
            continue;
        };
        if records.len() >= MAX_RUNS {
            return Err(LocalWtsError::AgentConversationLimit);
        }
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = options
            .open(entry.path())
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        let metadata = file
            .metadata()
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        if !metadata.is_file() || metadata.len() > MAX_RECORD_BYTES {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
        let mut bytes = vec![];
        file.take(MAX_RECORD_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        if bytes.len() > MAX_RECORD_BYTES as usize {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
        let record: StoredCheckRun = serde_json::from_slice(&bytes)
            .map_err(|_| LocalWtsError::AgentConversationUnavailable)?;
        if record.conversation_id != receipt.conversation_id
            || record.turn_request_id != receipt.request_id
            || record.session_id != receipt.session_id
            || record.workspace_id != receipt.workspace_id
            || record.repository_id != receipt.repository_id
            || record.source_context_sha256 != receipt.source_context_sha256
            || record.run.run_id != id
            || record.request.request_id != id
            || record.run.check_id != record.request.check_id
            || record.check.id != record.request.check_id
            || !valid_check_id(&record.run.check_id)
            || record.run.output.len() > MAX_OUTPUT_BYTES
            || record.run.output.contains('\0')
            || record.run.detail.len() > MAX_DETAIL_BYTES
        {
            return Err(LocalWtsError::AgentConversationUnavailable);
        }
        records.push(record);
    }
    records.sort_by_key(|record| (record.run.started_at_unix_ms, record.run.run_id));
    Ok(records)
}
