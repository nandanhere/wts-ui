use super::*;

fn fixture() -> (
    tempfile::TempDir,
    ConversationStore,
    AgentTurnChanges,
    Vec<VerificationCheck>,
) {
    let directory = tempfile::tempdir().unwrap();
    let store = ConversationStore::open(directory.path()).unwrap();
    let checkpoint = AgentTurnCheckpoint {
        checkpoint_id: Uuid::new_v4(),
        head_commit_oid: "a".repeat(40),
        branch_name: "fixture".to_owned(),
        captured_at_unix_ms: 100,
        tree_sha256: format!("sha256:{}", "b".repeat(64)),
        index_sha256: format!("sha256:{}", "c".repeat(64)),
    };
    let receipt = AgentTurnChanges {
        schema_version: 1,
        conversation_id: Uuid::new_v4(),
        request_id: Uuid::new_v4(),
        session_id: Uuid::new_v4(),
        workspace_id: Uuid::new_v4(),
        repository_id: "api".to_owned(),
        source_context_sha256: format!("sha256:{}", "d".repeat(64)),
        state: AgentTurnChangesState::Ready,
        observation: AgentTurnChangesObservation::Normal,
        started_at_unix_ms: 50,
        completed_at_unix_ms: Some(100),
        before: Some(checkpoint.clone()),
        after: Some(checkpoint),
        files: vec![],
        omitted_file_count: 0,
        patch: String::new(),
        patch_truncated: false,
        detail: String::new(),
    };
    let checks = ["unit", "lint"]
        .map(|id| VerificationCheck {
            id: id.to_owned(),
            label: id.to_owned(),
            kind: VerificationCheckKind::Unit,
            repository_id: Some("api".to_owned()),
            working_directory: directory.path().to_string_lossy().into_owned(),
            executable: "npm".to_owned(),
            args: vec!["test".to_owned(), "--silent".to_owned()],
            timeout_ms: 1_000,
            output_limit_bytes: 65_536,
            required: true,
            environment_names: vec![],
            acceptance_files: vec![],
        })
        .to_vec();
    (directory, store, receipt, checks)
}

fn save(
    store: &ConversationStore,
    receipt: &AgentTurnChanges,
    check: &VerificationCheck,
    started: i64,
    status: AgentTurnCheckStatus,
) -> Uuid {
    let id = Uuid::new_v4();
    let record = StoredCheckRun {
        conversation_id: receipt.conversation_id,
        turn_request_id: receipt.request_id,
        session_id: receipt.session_id,
        workspace_id: receipt.workspace_id,
        repository_id: receipt.repository_id.clone(),
        source_context_sha256: receipt.source_context_sha256.clone(),
        request: RunAgentTurnCheckRequest {
            request_id: id,
            check_id: check.id.clone(),
            expected_after_checkpoint_id: receipt.after.as_ref().unwrap().checkpoint_id,
            expected_plan_revision: 7,
        },
        check: check.clone(),
        verification_started_at_unix_ms: Some(started),
        run: AgentTurnCheckRun {
            run_id: id,
            check_id: check.id.clone(),
            status,
            started_at_unix_ms: started,
            completed_at_unix_ms: Some(started + 1),
            duration_ms: Some(1),
            exit_code: Some(if status == AgentTurnCheckStatus::Passed {
                0
            } else {
                1
            }),
            output: "Saved process output".to_owned(),
            output_truncated: false,
            detail: String::new(),
        },
    };
    save_run(store, receipt, &record).unwrap();
    id
}

#[test]
fn checked_candidate_proof_reads_every_latest_saved_check_and_survives_reopen() {
    let (directory, store, receipt, checks) = fixture();
    save(
        &store,
        &receipt,
        &checks[0],
        200,
        AgentTurnCheckStatus::Failed,
    );
    let unit = save(
        &store,
        &receipt,
        &checks[0],
        300,
        AgentTurnCheckStatus::Passed,
    );
    let lint = save(
        &store,
        &receipt,
        &checks[1],
        400,
        AgentTurnCheckStatus::Passed,
    );
    let proof = proof_from_saved_runs(&store, &receipt, 7, &checks).unwrap();
    assert_eq!(
        proof
            .checks
            .iter()
            .map(|check| check.run_id)
            .collect::<Vec<_>>(),
        vec![unit, lint]
    );
    assert_eq!(proof.plan_revision, 7);
    assert_eq!(
        proof.after_checkpoint_id,
        receipt.after.as_ref().unwrap().checkpoint_id
    );
    let reopened = ConversationStore::open(directory.path()).unwrap();
    assert_eq!(
        proof_from_saved_runs(&reopened, &receipt, 7, &checks).unwrap(),
        proof
    );
}

#[test]
fn checked_candidate_proof_rejects_missing_failed_and_replaced_checks() {
    let (_directory, store, receipt, mut checks) = fixture();
    assert!(proof_from_saved_runs(&store, &receipt, 7, &[]).is_err());
    save(
        &store,
        &receipt,
        &checks[0],
        200,
        AgentTurnCheckStatus::Passed,
    );
    assert!(proof_from_saved_runs(&store, &receipt, 7, &checks).is_err());
    save(
        &store,
        &receipt,
        &checks[1],
        300,
        AgentTurnCheckStatus::Passed,
    );
    assert!(proof_from_saved_runs(&store, &receipt, 8, &checks).is_err());
    checks[0].args.push("--changed".to_owned());
    assert!(proof_from_saved_runs(&store, &receipt, 7, &checks).is_err());
    checks[0].args.pop();
    save(
        &store,
        &receipt,
        &checks[0],
        400,
        AgentTurnCheckStatus::Failed,
    );
    assert!(proof_from_saved_runs(&store, &receipt, 7, &checks).is_err());
}

#[test]
fn checked_candidate_proof_rejects_mismatched_checkpoint_or_saved_source() {
    let (_directory, store, mut receipt, checks) = fixture();
    for (index, check) in checks.iter().enumerate() {
        save(
            &store,
            &receipt,
            check,
            200 + index as i64,
            AgentTurnCheckStatus::Passed,
        );
    }
    receipt.after.as_mut().unwrap().checkpoint_id = Uuid::new_v4();
    assert!(proof_from_saved_runs(&store, &receipt, 7, &checks).is_err());
    receipt.source_context_sha256 = format!("sha256:{}", "0".repeat(64));
    assert!(proof_from_saved_runs(&store, &receipt, 7, &checks).is_err());
}
