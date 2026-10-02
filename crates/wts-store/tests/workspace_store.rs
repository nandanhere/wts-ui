use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Barrier},
    thread,
};
use tempfile::TempDir;
use uuid::Uuid;
use wts_core::workspace::{
    CreateWorkspaceRequest, FollowWorkspaceAgentRequest, MAX_BASE_REF_CHARS,
    MAX_REPOSITORIES_PER_WORKSPACE, MAX_REPOSITORY_LABEL_CHARS, MAX_RUNTIME_IDENTIFIER_CHARS,
    MAX_RUNTIME_PORTS_PER_SERVICE, MAX_RUNTIME_SERVICES, MAX_WORKSPACE_TITLE_CHARS,
    PlaceWorkspaceOnBoardRequest, RenameWorkspaceRequest, RuntimePlanSelection, RuntimePortPolicy,
    RuntimePortSelection, RuntimeServiceSelection, TransitionWorkspaceWorkflowRequest,
    WorkspaceIntent, WorkspaceMaterializationState, WorkspacePhase, WorkspacePlanningFolder,
    WorkspacePlanningFormat, WorkspacePlanningSelection, WorkspaceProvider,
    WorkspaceRepositoryRequest, WorkspaceValidationError, WorkspaceWorkflowState,
};
use wts_store::{
    MAX_REVIEW_COMMENT_BYTES, ObservedWorkItem, StoredReviewAuthor, StoredReviewTarget,
    StoredReviewThreadState, StoredWorkItemProvider, StoredWorkItemRole, StoredWorkItemSnapshot,
    WORKSPACE_RECORD_SCHEMA_VERSION, WORKSPACE_RECORD_VERSION, WorkspaceBoardPlacementMode,
    WorkspaceService, WorkspaceStoreError,
};

#[test]
fn review_threads_persist_across_restart_and_use_revision_checks() {
    let harness = Harness::new();
    let workspace_id = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace
        .workspace_id;
    let digest = format!("sha256:{}", "a".repeat(64));
    let created = harness
        .service
        .create_review_thread(
            workspace_id,
            StoredReviewTarget::PlanningDocument {
                document_id: "plan".into(),
                document_sha256: digest.clone(),
                line: Some(7),
            },
            StoredReviewAuthor::User,
            "  Check the retry rule.  ",
        )
        .expect("create review thread");

    assert_eq!(created.revision, 1);
    assert_eq!(created.comments[0].body, "Check the retry rule.");
    assert_eq!(created.state, StoredReviewThreadState::Open);
    let connection = Connection::open(harness.service.store().database_path())
        .expect("open review store directly");
    assert!(
        connection
            .execute(
                "UPDATE workspace_review_threads SET target_line = 8 WHERE thread_id = ?1",
                [created.thread_id.to_string()],
            )
            .is_err()
    );
    assert!(
        connection
            .execute(
                "UPDATE workspace_review_comments SET body = 'rewritten' WHERE thread_id = ?1",
                [created.thread_id.to_string()],
            )
            .is_err()
    );
    drop(connection);
    let reopened = harness
        .reopen()
        .list_review_threads(workspace_id)
        .expect("list persisted review threads");
    assert_eq!(reopened, vec![created.clone()]);

    assert!(matches!(
        harness.service.resolve_review_thread(
            workspace_id,
            created.thread_id,
            created.revision + 1,
        ),
        Err(WorkspaceStoreError::ReviewThreadConflict { .. })
    ));
    let resolved = harness
        .service
        .resolve_review_thread(workspace_id, created.thread_id, created.revision)
        .expect("resolve review thread");
    assert_eq!(resolved.state, StoredReviewThreadState::Resolved);
    assert_eq!(resolved.revision, 2);
    assert!(resolved.resolved_at_unix_ms.is_some());
}

#[test]
fn review_thread_rejects_invalid_targets_and_oversize_comments() {
    let harness = Harness::new();
    let workspace_id = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace
        .workspace_id;
    assert!(matches!(
        harness.service.create_review_thread(
            workspace_id,
            StoredReviewTarget::PlanningDocument {
                document_id: "../../PLAN.md".into(),
                document_sha256: format!("sha256:{}", "a".repeat(64)),
                line: None,
            },
            StoredReviewAuthor::User,
            "Check this",
        ),
        Err(WorkspaceStoreError::InvalidReviewThread)
    ));
    assert!(matches!(
        harness.service.create_review_thread(
            workspace_id,
            StoredReviewTarget::PlanningDocument {
                document_id: "plan".into(),
                document_sha256: format!("sha256:{}", "a".repeat(64)),
                line: None,
            },
            StoredReviewAuthor::User,
            &"x".repeat(MAX_REVIEW_COMMENT_BYTES + 1),
        ),
        Err(WorkspaceStoreError::ReviewCommentTooLarge)
    ));
    assert!(matches!(
        harness.service.create_review_thread(
            workspace_id,
            StoredReviewTarget::PlanningDocument {
                document_id: "plan".into(),
                document_sha256: format!("sha256:{}", "a".repeat(64)),
                line: None,
            },
            StoredReviewAuthor::User,
            " \t\n ",
        ),
        Err(WorkspaceStoreError::InvalidReviewThread)
    ));
    assert!(matches!(
        harness.service.create_review_thread(
            workspace_id,
            StoredReviewTarget::VerificationCheck {
                plan_revision: 0,
                completed_at_unix_ms: 1,
                check_id: "cargo/test".into(),
            },
            StoredReviewAuthor::User,
            "Check this failure",
        ),
        Err(WorkspaceStoreError::InvalidReviewThread)
    ));
}

#[test]
fn verification_review_threads_persist_and_keep_their_run_anchor() {
    let harness = Harness::new();
    let workspace_id = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace
        .workspace_id;
    let target = StoredReviewTarget::VerificationCheck {
        plan_revision: 4,
        completed_at_unix_ms: 1_722_000_000_100,
        check_id: "checkout-api-cargo-test".into(),
    };
    let created = harness
        .service
        .create_review_thread(
            workspace_id,
            target.clone(),
            StoredReviewAuthor::User,
            "The failure was caused by a missing local service.",
        )
        .expect("create verification review thread");

    assert_eq!(created.target, target);
    assert_eq!(
        harness
            .reopen()
            .list_review_threads(workspace_id)
            .expect("reopen verification review threads"),
        vec![created.clone()]
    );
    let connection = Connection::open(harness.service.store().database_path())
        .expect("open verification review store directly");
    assert!(
        connection
            .execute(
                "UPDATE workspace_verification_review_threads
                 SET target_check_id = 'other-check' WHERE thread_id = ?1",
                [created.thread_id.to_string()],
            )
            .is_err()
    );
    drop(connection);

    let resolved = harness
        .service
        .resolve_review_thread(workspace_id, created.thread_id, created.revision)
        .expect("resolve verification review thread");
    assert_eq!(resolved.target, target);
    assert_eq!(resolved.state, StoredReviewThreadState::Resolved);
    assert_eq!(resolved.revision, 2);
}

#[test]
fn code_review_threads_persist_and_keep_their_line_anchor() {
    let harness = Harness::new();
    let workspace_id = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace
        .workspace_id;
    let target = StoredReviewTarget::CodeChange {
        repository_id: format!("repo_{}", "a".repeat(64)),
        base_commit_oid: "a".repeat(40),
        head_commit_oid: "b".repeat(40),
        patch_sha256: format!("sha256:{}", "c".repeat(64)),
        file_path: "src/review.rs".into(),
        side: "additions".into(),
        line: 42,
    };
    let created = harness
        .service
        .create_review_thread(
            workspace_id,
            target.clone(),
            StoredReviewAuthor::User,
            "Keep this failure visible to the agent.",
        )
        .expect("create code review thread");

    assert_eq!(created.target, target);
    assert_eq!(
        harness
            .reopen()
            .list_review_threads(workspace_id)
            .expect("reopen code review threads"),
        vec![created.clone()]
    );
    let connection = Connection::open(harness.service.store().database_path())
        .expect("open code review store directly");
    assert!(
        connection
            .execute(
                "UPDATE workspace_code_review_threads
                 SET target_line = 43 WHERE thread_id = ?1",
                [created.thread_id.to_string()],
            )
            .is_err()
    );
    drop(connection);

    assert!(matches!(
        harness.service.resolve_review_thread(
            workspace_id,
            created.thread_id,
            created.revision + 1,
        ),
        Err(WorkspaceStoreError::ReviewThreadConflict { .. })
    ));
    let resolved = harness
        .service
        .resolve_review_thread(workspace_id, created.thread_id, created.revision)
        .expect("resolve code review thread");
    assert_eq!(resolved.target, target);
    assert_eq!(resolved.state, StoredReviewThreadState::Resolved);
    assert_eq!(resolved.revision, 2);
}

#[test]
fn code_review_threads_reject_untrusted_paths_and_invalid_sides() {
    let harness = Harness::new();
    let workspace_id = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace
        .workspace_id;
    let target = |file_path: &str, side: &str| StoredReviewTarget::CodeChange {
        repository_id: format!("repo_{}", "a".repeat(64)),
        base_commit_oid: "a".repeat(40),
        head_commit_oid: "b".repeat(40),
        patch_sha256: format!("sha256:{}", "c".repeat(64)),
        file_path: file_path.into(),
        side: side.into(),
        line: 42,
    };

    for invalid in [
        target("../secret", "additions"),
        target("/secret", "additions"),
        target("src/lib.rs", "context"),
    ] {
        assert!(matches!(
            harness.service.create_review_thread(
                workspace_id,
                invalid,
                StoredReviewAuthor::User,
                "Check this line",
            ),
            Err(WorkspaceStoreError::InvalidReviewThread)
        ));
    }
}

#[test]
fn work_item_observations_replace_and_persist_without_changing_repositories() {
    let harness = Harness::new();
    let mut create_request = request();
    let payments_id = format!("repo_{}", "a".repeat(64));
    let checkout_id = format!("repo_{}", "b".repeat(64));
    create_request.repositories[0].repository_id = Some(payments_id.clone());
    create_request.repositories[1].repository_id = Some(checkout_id.clone());
    let created = harness
        .service
        .create(&Uuid::new_v4().to_string(), create_request)
        .expect("create workspace")
        .workspace;
    let repositories = created.repositories.clone();
    let observations = vec![ObservedWorkItem {
        issue_key: "PAY-2190".into(),
        source_files: vec!["PLAN.md".into(), "FINDINGS.md".into()],
        observed_at_unix_ms: 1_722_000_000_000,
    }];

    harness
        .service
        .replace_observed_work_items(created.workspace_id, &observations)
        .expect("persist observations");
    let reopened = harness
        .reopen()
        .get(created.workspace_id)
        .expect("read workspace")
        .expect("workspace");

    assert_eq!(reopened.observed_work_items, observations);
    assert_eq!(reopened.repositories, repositories);
    assert_eq!(
        harness
            .service
            .repositories_observed_for_issue("PAY-2190")
            .expect("repository history"),
        vec![payments_id, checkout_id]
    );
}

struct Harness {
    _temp: TempDir,
    data_dir: PathBuf,
    workspace_root: PathBuf,
    service: WorkspaceService,
}

#[test]
fn workspace_rename_persists_the_name_and_new_managed_leaf() {
    let harness = Harness::new();
    let original = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace;

    let renamed = harness
        .service
        .rename(
            original.workspace_id,
            RenameWorkspaceRequest {
                title: "  Release readiness  ".into(),
            },
        )
        .expect("rename workspace");

    assert_eq!(renamed.display_name.as_deref(), Some("Release readiness"));
    assert_eq!(renamed.title, original.title);
    assert_ne!(renamed.workspace_leaf, original.workspace_leaf);
    assert_eq!(
        renamed.workspace_leaf,
        format!("release-readiness-{}", original.workspace_id)
    );
    assert!(
        renamed
            .workspace_display_path
            .ends_with(&renamed.workspace_leaf)
    );
    assert_eq!(renamed.record_version, original.record_version);
    let wire = serde_json::to_value(&renamed).expect("serialize renamed workspace");
    assert_eq!(wire["displayName"], "Release readiness");
    let reopened = harness
        .reopen()
        .get(original.workspace_id)
        .expect("read renamed workspace")
        .expect("renamed workspace");
    assert_eq!(reopened.display_name.as_deref(), Some("Release readiness"));
    assert_eq!(reopened.workspace_leaf, renamed.workspace_leaf);
    assert_eq!(
        reopened.workspace_display_path,
        renamed.workspace_display_path
    );
}

impl Harness {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let data_dir = temp.path().join("data");
        let workspace_root = temp.path().join("managed-workspaces");
        let service = WorkspaceService::open(&data_dir, "default", &workspace_root).unwrap();
        Self {
            _temp: temp,
            data_dir,
            workspace_root,
            service,
        }
    }

    fn reopen(&self) -> WorkspaceService {
        WorkspaceService::open(&self.data_dir, "default", &self.workspace_root).unwrap()
    }
}

fn request() -> CreateWorkspaceRequest {
    CreateWorkspaceRequest {
        intent: WorkspaceIntent::Jira {
            issue_key: "platform-42".into(),
        },
        title: " Checkout retry race ".into(),
        preferred_provider: WorkspaceProvider::Codex,
        repositories: vec![
            WorkspaceRepositoryRequest {
                repository_id: None,
                label: "payments-sdk".into(),
                base_ref: "main".into(),
            },
            WorkspaceRepositoryRequest {
                repository_id: None,
                label: "checkout-api".into(),
                base_ref: "release/2026.07".into(),
            },
        ],
        runtime: None,
        planning: None,
    }
}

fn repository_set_request() -> CreateWorkspaceRequest {
    let mut request = request();
    request.intent = WorkspaceIntent::RepositorySet {
        label: "checkout-retry".into(),
    };
    request
}

fn runtime_selection() -> RuntimePlanSelection {
    RuntimePlanSelection {
        analysis_digest: format!("sha256:{}", "a".repeat(64)),
        services: vec![
            RuntimeServiceSelection {
                candidate_id: "service:web".into(),
                ports: vec![
                    RuntimePortSelection {
                        port_id: "metrics".into(),
                        preferred_port: 9090,
                        policy: RuntimePortPolicy::Prefer,
                    },
                    RuntimePortSelection {
                        port_id: "http".into(),
                        preferred_port: 8080,
                        policy: RuntimePortPolicy::Fixed,
                    },
                ],
            },
            RuntimeServiceSelection {
                candidate_id: "service:api".into(),
                ports: vec![],
            },
        ],
    }
}

#[test]
fn empty_store_lists_and_gets_without_fixtures() {
    let harness = Harness::new();

    let list = harness.service.list().unwrap();
    assert!(list.workspaces.is_empty());
    assert_eq!(list.workspace_root_id, "default");
    assert_eq!(
        Path::new(&list.workspace_root_display_path),
        harness.workspace_root
    );
    assert!(harness.service.get(Uuid::new_v4()).unwrap().is_none());
}

#[test]
fn created_workspace_survives_reopen_with_rust_owned_paths() {
    let harness = Harness::new();
    let result = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .unwrap();

    assert!(!result.replayed);
    let workspace = result.workspace;
    assert_eq!(workspace.schema_version, WORKSPACE_RECORD_SCHEMA_VERSION);
    assert_eq!(workspace.record_version, WORKSPACE_RECORD_VERSION);
    assert_eq!(workspace.phase, WorkspacePhase::Draft);
    assert_eq!(workspace.workflow.state, WorkspaceWorkflowState::Ready);
    assert_eq!(workspace.workflow.revision, 1);
    assert_eq!(
        workspace.lifecycle.materialization_state,
        WorkspaceMaterializationState::NotMaterialized
    );
    assert_eq!(workspace.lifecycle.worktree_count, 0);
    assert!(workspace.lifecycle.observed_at_unix_ms.is_some());
    assert_eq!(
        workspace.intent,
        WorkspaceIntent::Jira {
            issue_key: "PLATFORM-42".into()
        }
    );
    assert_eq!(workspace.workspace_root_id, "default");
    assert!(workspace.workspace_leaf.starts_with("platform-42-"));
    assert_eq!(
        Path::new(&workspace.workspace_display_path),
        harness.workspace_root.join(&workspace.workspace_leaf)
    );
    assert_eq!(workspace.repositories[0].label, "checkout-api");
    assert_eq!(workspace.repositories[1].label, "payments-sdk");
    assert!(workspace.repositories.iter().all(|repository| {
        !repository.request_id.is_nil()
            && repository
                .worktree_leaf
                .ends_with(&repository.request_id.to_string())
            && !repository.worktree_leaf.contains('/')
    }));
    let wire: Value = serde_json::to_value(&workspace).unwrap();
    assert_eq!(wire["intent"]["type"], "jira");
    assert_eq!(wire["intent"]["issueKey"], "PLATFORM-42");
    assert!(wire["intent"].get("issue_key").is_none());
    assert_eq!(wire["preferredProvider"], "codex");
    assert!(wire["repositories"][0]["requestId"].is_string());
    assert!(wire["repositories"][0]["worktreeLeaf"].is_string());
    assert!(wire["repositories"][0].get("repositoryId").is_none());
    assert_eq!(wire["lifecycle"]["materializationState"], "notMaterialized");
    assert_eq!(wire["lifecycle"]["worktreeCount"], 0);
    assert!(wire["lifecycle"]["observedAtUnixMs"].is_number());
    assert!(wire.get("repositoryPlans").is_none());

    let reopened = harness.reopen();
    assert_eq!(
        reopened.get(workspace.workspace_id).unwrap(),
        Some(workspace.clone())
    );
    assert_eq!(reopened.list().unwrap().workspaces, vec![workspace]);
}

#[test]
fn jira_workspace_creation_projects_its_primary_issue_without_inventing_jira_fields() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create Jira workspace")
        .workspace;

    let links = harness
        .service
        .list_work_item_links(workspace.workspace_id)
        .expect("list Jira intent link");
    assert_eq!(links.len(), 1);
    let link = &links[0];
    assert_eq!(link.workspace_id, workspace.workspace_id);
    assert_eq!(link.provider, StoredWorkItemProvider::Jira);
    assert_eq!(link.role, StoredWorkItemRole::Primary);
    assert_eq!(link.snapshot.issue_key, "PLATFORM-42");
    assert_eq!(link.snapshot.summary, None);
    assert_eq!(link.snapshot.status, None);
    assert_eq!(link.snapshot.content, "");
    assert_eq!(link.snapshot.browser_url, None);
    assert_eq!(link.snapshot.fetched_at_unix_ms, 0);
    assert_eq!(link.created_at_unix_ms, workspace.created_at_unix_ms);
    assert_eq!(
        harness
            .reopen()
            .list_work_item_links(workspace.workspace_id)
            .expect("list persisted Jira intent link"),
        links
    );

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let event_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM workspace_work_item_link_events
             WHERE workspace_id = ?1 AND link_id = ?2",
            [workspace.workspace_id.to_string(), link.link_id.to_string()],
            |row| row.get(0),
        )
        .expect("Jira intent link event");
    assert_eq!(event_count, 1);
}

#[test]
fn pinned_repository_ids_survive_store_round_trips() {
    let harness = Harness::new();
    let checkout_api_id = format!("repo_{}", "a".repeat(64));
    let payments_sdk_id = format!("repo_{}", "b".repeat(64));
    let mut request = request();
    request.repositories[0].repository_id = Some(payments_sdk_id.clone());
    request.repositories[1].repository_id = Some(checkout_api_id.clone());

    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request)
        .expect("create pinned workspace")
        .workspace;

    assert_eq!(
        workspace.repositories[0].repository_id.as_deref(),
        Some(checkout_api_id.as_str())
    );
    assert_eq!(
        workspace.repositories[1].repository_id.as_deref(),
        Some(payments_sdk_id.as_str())
    );
    let wire = serde_json::to_value(&workspace).expect("serialize workspace");
    assert_eq!(wire["repositories"][0]["repositoryId"], checkout_api_id);
    assert_eq!(
        harness
            .reopen()
            .get(workspace.workspace_id)
            .expect("read pinned workspace")
            .expect("pinned workspace"),
        workspace
    );
}

#[test]
fn runtime_selection_is_canonicalized_persisted_and_projected() {
    let harness = Harness::new();
    let mut request = request();
    request.runtime = Some(runtime_selection());

    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request)
        .expect("create runtime-aware workspace")
        .workspace;
    let runtime = workspace.runtime.as_ref().expect("runtime selection");

    assert_eq!(runtime.services[0].candidate_id, "service:api");
    assert_eq!(runtime.services[1].candidate_id, "service:web");
    assert_eq!(runtime.services[1].ports[0].port_id, "http");
    assert_eq!(runtime.services[1].ports[1].port_id, "metrics");
    assert_eq!(
        harness
            .reopen()
            .get(workspace.workspace_id)
            .expect("read persisted runtime selection")
            .expect("runtime-aware workspace"),
        workspace
    );

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let record_json: String = connection
        .query_row("SELECT record_json FROM workspace_projection", [], |row| {
            row.get(0)
        })
        .expect("stored workspace record");
    let stored: Value = serde_json::from_str(&record_json).expect("stored record JSON");
    assert_eq!(
        stored["runtime"]["analysisDigest"],
        format!("sha256:{}", "a".repeat(64))
    );
    assert_eq!(
        stored["runtime"]["services"][0]["candidateId"],
        "service:api"
    );
}

#[test]
fn durable_record_bound_covers_the_maximal_valid_runtime_contract() {
    fn padded_identifier(prefix: String) -> String {
        format!("{prefix}{}", "x".repeat(MAX_RUNTIME_IDENTIFIER_CHARS))
            .chars()
            .take(MAX_RUNTIME_IDENTIFIER_CHARS)
            .collect()
    }

    let harness = Harness::new();
    let repositories = (0..MAX_REPOSITORIES_PER_WORKSPACE)
        .map(|index| WorkspaceRepositoryRequest {
            repository_id: Some(format!("repo_{index:064x}")),
            label: format!(
                "repository-{index:02}-{}",
                "l".repeat(MAX_REPOSITORY_LABEL_CHARS)
            )
            .chars()
            .take(MAX_REPOSITORY_LABEL_CHARS)
            .collect(),
            base_ref: format!("feature-{index:02}-{}", "b".repeat(MAX_BASE_REF_CHARS))
                .chars()
                .take(MAX_BASE_REF_CHARS)
                .collect(),
        })
        .collect();
    let services = (0..MAX_RUNTIME_SERVICES)
        .map(|service_index| RuntimeServiceSelection {
            candidate_id: padded_identifier(format!("candidate:{service_index:02}:")),
            ports: (0..MAX_RUNTIME_PORTS_PER_SERVICE)
                .map(|port_index| RuntimePortSelection {
                    port_id: padded_identifier(format!("port:{port_index:02}:")),
                    preferred_port: 10_000
                        + u16::try_from(service_index * MAX_RUNTIME_PORTS_PER_SERVICE + port_index)
                            .expect("bounded preferred port"),
                    policy: RuntimePortPolicy::Prefer,
                })
                .collect(),
        })
        .collect();
    let request = CreateWorkspaceRequest {
        intent: WorkspaceIntent::RepositorySet {
            label: "durable-boundary".to_owned(),
        },
        title: "t".repeat(MAX_WORKSPACE_TITLE_CHARS),
        preferred_provider: WorkspaceProvider::Codex,
        repositories,
        runtime: Some(RuntimePlanSelection {
            analysis_digest: format!("sha256:{}", "a".repeat(64)),
            services,
        }),
        planning: Some(WorkspacePlanningSelection {
            folder: WorkspacePlanningFolder::PlansAndKanban,
            format: WorkspacePlanningFormat::Kanban,
        }),
    };

    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request)
        .expect("the complete valid core contract must fit durably")
        .workspace;
    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let record_bytes: i64 = connection
        .query_row(
            "SELECT length(record_json) FROM workspace_projection WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("stored boundary record size");
    assert!(
        record_bytes > 64 * 1024,
        "regression fixture must exceed the previous durable limit"
    );
    assert_eq!(
        harness
            .reopen()
            .get(workspace.workspace_id)
            .expect("read boundary workspace"),
        Some(workspace)
    );
}

#[test]
fn omitted_repository_ids_preserve_the_legacy_request_digest() {
    let harness = Harness::new();
    harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create legacy-shaped workspace");

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let stored_digest: String = connection
        .query_row(
            "SELECT request_digest FROM workspace_created_events",
            [],
            |row| row.get(0),
        )
        .expect("stored request digest");
    let legacy_request_json = concat!(
        r#"{"intent":{"type":"jira","issueKey":"PLATFORM-42"},"#,
        r#""title":"Checkout retry race","preferredProvider":"codex","#,
        r#""repositories":[{"label":"checkout-api","baseRef":"release/2026.07"},"#,
        r#"{"label":"payments-sdk","baseRef":"main"}]}"#,
    );
    let expected_digest = hex::encode(Sha256::digest(legacy_request_json.as_bytes()));

    assert_eq!(stored_digest, expected_digest);
}

#[test]
fn migration_is_versioned_and_creation_events_are_append_only() {
    let harness = Harness::new();
    harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .unwrap();

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    let event_count: i64 = connection
        .query_row("SELECT count(*) FROM workspace_created_events", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(user_version, 11);
    assert_eq!(event_count, 1);
    assert!(
        connection
            .execute("UPDATE workspace_created_events SET event_json = '{}'", [],)
            .is_err()
    );
    assert!(
        connection
            .execute("DELETE FROM workspace_created_events", [])
            .is_err()
    );
}

#[test]
fn lifecycle_observations_are_persisted_but_remain_a_list_summary() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .unwrap()
        .workspace;

    let summary = harness
        .service
        .observe_lifecycle(
            workspace.workspace_id,
            WorkspaceMaterializationState::Materialized,
            2,
        )
        .unwrap();
    assert_eq!(
        summary.materialization_state,
        WorkspaceMaterializationState::Materialized
    );
    assert_eq!(summary.worktree_count, 2);
    assert_eq!(
        harness
            .reopen()
            .get(workspace.workspace_id)
            .unwrap()
            .unwrap()
            .lifecycle,
        summary
    );

    let attention = harness
        .service
        .observe_lifecycle(
            workspace.workspace_id,
            WorkspaceMaterializationState::NeedsAttention,
            0,
        )
        .unwrap();
    assert_eq!(
        attention.materialization_state,
        WorkspaceMaterializationState::NeedsAttention
    );
    assert!(
        harness
            .service
            .observe_lifecycle(
                workspace.workspace_id,
                WorkspaceMaterializationState::Materialized,
                1,
            )
            .is_err()
    );
}

#[test]
fn v1_store_migration_preserves_records_as_unknown_until_observed() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .unwrap()
        .workspace;
    {
        let connection = Connection::open(harness.service.store().database_path()).unwrap();
        connection
            .execute_batch(
                "DROP TABLE workspace_verification_review_comments;
                 DROP TABLE workspace_verification_review_threads;
                 DROP TABLE workspace_code_review_comments;
                 DROP TABLE workspace_code_review_threads;
                 DROP TABLE workspace_work_item_link_events;
                 DROP TABLE workspace_work_item_link_confirmations;
                 DROP TABLE workspace_work_item_links;
                 DROP TABLE workspace_review_comments;
                 DROP TABLE workspace_review_threads;
                 DROP TABLE workspace_board_placement_events;
                 DROP TABLE workspace_board_placement_projection;
                 DROP TABLE workspace_workflow_events;
                 DROP TABLE workspace_workflow_projection;
                 DROP TABLE workspace_work_item_observations;
                 DROP TABLE workspace_tombstone_events;
                 DROP TABLE workspace_lifecycle_projection;
                 PRAGMA user_version = 1;",
            )
            .unwrap();
    }

    let migrated = harness
        .reopen()
        .get(workspace.workspace_id)
        .unwrap()
        .unwrap();
    assert_eq!(migrated.title, workspace.title);
    assert_eq!(
        migrated.lifecycle.materialization_state,
        WorkspaceMaterializationState::Unknown
    );
    assert_eq!(migrated.lifecycle.worktree_count, 0);
    assert_eq!(migrated.lifecycle.observed_at_unix_ms, None);

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(user_version, 11);
}

#[test]
fn v9_store_migration_adds_automatic_board_placement() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace;
    {
        let connection = Connection::open(harness.service.store().database_path()).unwrap();
        connection
            .execute_batch(
                "DROP TABLE workspace_board_placement_events;
                 DROP TABLE workspace_board_placement_projection;
                 PRAGMA user_version = 9;",
            )
            .expect("restore version 9 schema suffix");
    }

    let migrated = harness
        .reopen()
        .get(workspace.workspace_id)
        .expect("read migrated workspace")
        .expect("workspace");
    assert_eq!(migrated.workflow.state, WorkspaceWorkflowState::Ready);
    assert_eq!(
        migrated.workflow.placement.mode,
        WorkspaceBoardPlacementMode::Automatic
    );
    assert_eq!(migrated.workflow.placement.rank, 0);
    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(user_version, 11);
}

#[test]
fn v10_store_migration_recovers_the_jira_intent_link_without_fabricated_details() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create Jira workspace")
        .workspace;
    {
        let connection = Connection::open(harness.service.store().database_path()).unwrap();
        connection
            .execute_batch(
                "DROP TRIGGER workspace_work_item_link_events_no_delete;
                 DELETE FROM workspace_work_item_link_events;
                 DELETE FROM workspace_work_item_links;
                 CREATE TRIGGER workspace_work_item_link_events_no_delete
                 BEFORE DELETE ON workspace_work_item_link_events
                 BEGIN
                     SELECT RAISE(ABORT, 'workspace work-item link events are append-only');
                 END;
                 PRAGMA user_version = 10;",
            )
            .expect("restore the version 10 missing-link state");
    }

    let migrated = harness
        .reopen()
        .list_work_item_links(workspace.workspace_id)
        .expect("list migrated Jira intent link");
    assert_eq!(migrated.len(), 1);
    let link = &migrated[0];
    assert_eq!(link.provider, StoredWorkItemProvider::Jira);
    assert_eq!(link.role, StoredWorkItemRole::Primary);
    assert_eq!(link.snapshot.issue_key, "PLATFORM-42");
    assert_eq!(link.snapshot.summary, None);
    assert_eq!(link.snapshot.status, None);
    assert_eq!(link.snapshot.content, "");
    assert_eq!(link.snapshot.browser_url, None);
    assert_eq!(link.snapshot.fetched_at_unix_ms, 0);
    assert_eq!(link.created_at_unix_ms, workspace.created_at_unix_ms);

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let user_version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(user_version, 11);
    let (event_id, event_json): (String, String) = connection
        .query_row(
            "SELECT event_id, event_json FROM workspace_work_item_link_events
             WHERE workspace_id = ?1 AND link_id = ?2",
            [workspace.workspace_id.to_string(), link.link_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("migrated Jira intent link event");
    let event: Value = serde_json::from_str(&event_json).expect("valid migrated event JSON");
    assert_eq!(event["eventId"], event_id);
    assert_eq!(event["link"]["linkId"], link.link_id.to_string());
    assert_eq!(event["link"]["snapshot"]["issueKey"], "PLATFORM-42");
    assert!(event["link"]["snapshot"].get("summary").is_none());
    assert!(event["link"]["snapshot"].get("status").is_none());
    assert!(event["link"]["snapshot"].get("browserUrl").is_none());
}

#[test]
fn work_item_links_are_idempotent_persisted_and_do_not_rewrite_workspace_intent() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), repository_set_request())
        .expect("create workspace")
        .workspace;
    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let original_record_json: String = connection
        .query_row(
            "SELECT record_json FROM workspace_projection WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("original workspace record");
    drop(connection);

    let idempotency_key = Uuid::new_v4().to_string();
    let preview_digest = format!("sha256:{}", "b".repeat(64));
    let snapshot = StoredWorkItemSnapshot {
        issue_key: "PLATFORM-42".into(),
        summary: Some("Prevent an incorrect server classification".into()),
        status: Some("In Progress".into()),
        content: "The imported Jira issue content.".into(),
        browser_url: Some("https://jira.example.test/browse/PLATFORM-42".into()),
        fetched_at_unix_ms: 1_786_000_000_000,
    };
    let first = harness
        .service
        .confirm_work_item_link(
            workspace.workspace_id,
            &idempotency_key,
            &preview_digest,
            StoredWorkItemProvider::Jira,
            StoredWorkItemRole::Primary,
            snapshot.clone(),
        )
        .expect("confirm work-item link");
    assert!(!first.replayed);
    assert_eq!(first.link.snapshot, snapshot);
    assert_eq!(first.link.revision, 1);

    let replay = harness
        .reopen()
        .confirm_work_item_link(
            workspace.workspace_id,
            &idempotency_key,
            &preview_digest,
            StoredWorkItemProvider::Jira,
            StoredWorkItemRole::Primary,
            first.link.snapshot.clone(),
        )
        .expect("replay work-item link");
    assert!(replay.replayed);
    assert_eq!(replay.link, first.link);
    assert_eq!(
        harness
            .reopen()
            .list_work_item_links(workspace.workspace_id)
            .expect("persisted links"),
        vec![first.link.clone()]
    );

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let current_record_json: String = connection
        .query_row(
            "SELECT record_json FROM workspace_projection WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("current workspace record");
    assert_eq!(current_record_json, original_record_json);
    assert_eq!(
        harness
            .service
            .get(workspace.workspace_id)
            .unwrap()
            .unwrap()
            .intent,
        workspace.intent
    );
}

#[test]
fn work_item_links_enforce_one_primary_and_unlink_with_revision_cas() {
    let harness = Harness::new();
    let workspace_id = harness
        .service
        .create(&Uuid::new_v4().to_string(), repository_set_request())
        .expect("create workspace")
        .workspace
        .workspace_id;
    let confirm = |issue_key: &str, role: StoredWorkItemRole| {
        harness.service.confirm_work_item_link(
            workspace_id,
            &Uuid::new_v4().to_string(),
            &format!(
                "sha256:{}",
                if issue_key.ends_with('1') { "c" } else { "d" }.repeat(64)
            ),
            StoredWorkItemProvider::Jira,
            role,
            StoredWorkItemSnapshot {
                issue_key: issue_key.into(),
                summary: None,
                status: None,
                content: String::new(),
                browser_url: None,
                fetched_at_unix_ms: 1_786_000_000_000,
            },
        )
    };
    let primary = confirm("OPS-1", StoredWorkItemRole::Primary)
        .expect("first primary")
        .link;
    assert!(matches!(
        confirm("OPS-2", StoredWorkItemRole::Primary),
        Err(WorkspaceStoreError::PrimaryWorkItemLinkAlreadyExists)
    ));
    let related = confirm("OPS-2", StoredWorkItemRole::Related)
        .expect("related link")
        .link;
    assert!(matches!(
        harness
            .service
            .unlink_work_item_link(workspace_id, related.link_id, related.revision + 1,),
        Err(WorkspaceStoreError::WorkItemLinkConflict { .. })
    ));
    let removed = harness
        .service
        .unlink_work_item_link(workspace_id, related.link_id, related.revision)
        .expect("unlink related issue");
    assert_eq!(removed.link_id, related.link_id);
    assert_eq!(
        harness
            .service
            .list_work_item_links(workspace_id)
            .expect("remaining links"),
        vec![primary]
    );
}

#[test]
fn workflow_transitions_use_cas_and_survive_restart_without_rewriting_the_record() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace;
    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let original_record_json: String = connection
        .query_row(
            "SELECT record_json FROM workspace_projection WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("record JSON");
    drop(connection);

    let mut revision = workspace.workflow.revision;
    for state in [
        WorkspaceWorkflowState::Active,
        WorkspaceWorkflowState::Review,
        WorkspaceWorkflowState::Parked,
        WorkspaceWorkflowState::Ready,
    ] {
        let summary = harness
            .service
            .transition_workflow(
                workspace.workspace_id,
                TransitionWorkspaceWorkflowRequest {
                    state,
                    expected_revision: revision,
                },
            )
            .expect("transition workflow");
        revision += 1;
        assert_eq!(summary.state, state);
        assert_eq!(summary.revision, revision);
    }

    assert!(matches!(
        harness.service.transition_workflow(
            workspace.workspace_id,
            TransitionWorkspaceWorkflowRequest {
                state: WorkspaceWorkflowState::Active,
                expected_revision: 1,
            },
        ),
        Err(WorkspaceStoreError::WorkspaceWorkflowConflict {
            expected: 1,
            actual: 5,
        })
    ));

    let reopened = harness
        .reopen()
        .get(workspace.workspace_id)
        .expect("read workspace")
        .expect("workspace");
    assert_eq!(reopened.workflow.state, WorkspaceWorkflowState::Ready);
    assert_eq!(reopened.workflow.revision, 5);
    assert_eq!(reopened.intent, workspace.intent);

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let persisted_record_json: String = connection
        .query_row(
            "SELECT record_json FROM workspace_projection WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("record JSON after workflow transitions");
    let event_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM workspace_workflow_events WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("workflow events");
    assert_eq!(persisted_record_json, original_record_json);
    assert_eq!(event_count, 4);
    assert!(
        connection
            .execute("DELETE FROM workspace_workflow_events", [])
            .is_err()
    );
}

#[test]
fn board_placement_persists_same_lane_and_cross_lane_order_across_restart() {
    let harness = Harness::new();
    let first = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create first workspace")
        .workspace;
    let second = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create second workspace")
        .workspace;
    let third = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create third workspace")
        .workspace;
    let first_id = first.workspace_id;
    let second_id = second.workspace_id;
    let third_id = third.workspace_id;

    let first = harness
        .service
        .place_workspace_on_board(
            first_id,
            PlaceWorkspaceOnBoardRequest {
                state: WorkspaceWorkflowState::Active,
                expected_revision: first.workflow.revision,
                before_workspace_id: None,
                after_workspace_id: None,
            },
        )
        .expect("place first in active");
    let _second_placement = harness
        .service
        .place_workspace_on_board(
            second_id,
            PlaceWorkspaceOnBoardRequest {
                state: WorkspaceWorkflowState::Active,
                expected_revision: second.workflow.revision,
                before_workspace_id: None,
                after_workspace_id: Some(first_id),
            },
        )
        .expect("place second after first");
    let _third_placement = harness
        .service
        .place_workspace_on_board(
            third_id,
            PlaceWorkspaceOnBoardRequest {
                state: WorkspaceWorkflowState::Active,
                expected_revision: third.workflow.revision,
                before_workspace_id: Some(second_id),
                after_workspace_id: None,
            },
        )
        .expect("place third before second");

    let moved_first = harness
        .service
        .place_workspace_on_board(
            first_id,
            PlaceWorkspaceOnBoardRequest {
                state: WorkspaceWorkflowState::Active,
                expected_revision: first.revision,
                before_workspace_id: None,
                after_workspace_id: Some(second_id),
            },
        )
        .expect("reorder first in active");
    assert_eq!(moved_first.revision, first.revision + 1);
    assert_eq!(
        moved_first.placement.mode,
        WorkspaceBoardPlacementMode::Pinned
    );

    let reopened = harness.reopen().list().expect("list after restart");
    let mut active = reopened
        .workspaces
        .iter()
        .filter(|workspace| workspace.workflow.state == WorkspaceWorkflowState::Active)
        .collect::<Vec<_>>();
    active.sort_by_key(|workspace| workspace.workflow.placement.rank);
    assert_eq!(
        active
            .iter()
            .map(|workspace| workspace.workspace_id)
            .collect::<Vec<_>>(),
        vec![third_id, second_id, first_id]
    );
    assert_eq!(
        active
            .iter()
            .map(|workspace| workspace.workflow.placement.rank)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert!(
        active
            .iter()
            .all(|workspace| workspace.workflow.placement.mode
                == WorkspaceBoardPlacementMode::Pinned)
    );

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let workflow_event_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM workspace_workflow_events WHERE workspace_id = ?1",
            [first_id.to_string()],
            |row| row.get(0),
        )
        .expect("workflow transition events");
    assert_eq!(
        workflow_event_count, 1,
        "same-lane reorder is not a transition"
    );
    assert!(
        connection
            .execute("DELETE FROM workspace_board_placement_events", [])
            .is_err()
    );
    assert!(
        connection
            .execute(
                "UPDATE workspace_board_placement_events SET to_rank = 99",
                [],
            )
            .is_err()
    );

    assert!(matches!(
        harness.service.place_workspace_on_board(
            first_id,
            PlaceWorkspaceOnBoardRequest {
                state: WorkspaceWorkflowState::Ready,
                expected_revision: first.revision,
                before_workspace_id: None,
                after_workspace_id: None,
            },
        ),
        Err(WorkspaceStoreError::WorkspaceWorkflowConflict { .. })
    ));
}

#[test]
fn pinned_workspace_ignores_automation_until_follow_agent_is_enabled() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .expect("create workspace")
        .workspace;
    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let original_record_json: String = connection
        .query_row(
            "SELECT record_json FROM workspace_projection WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("record JSON");
    drop(connection);

    let pinned = harness
        .service
        .place_workspace_on_board(
            workspace.workspace_id,
            PlaceWorkspaceOnBoardRequest {
                state: WorkspaceWorkflowState::Review,
                expected_revision: workspace.workflow.revision,
                before_workspace_id: None,
                after_workspace_id: None,
            },
        )
        .expect("pin workspace");
    let ignored = harness
        .service
        .transition_workflow(
            workspace.workspace_id,
            TransitionWorkspaceWorkflowRequest {
                state: WorkspaceWorkflowState::Active,
                expected_revision: pinned.revision,
            },
        )
        .expect("ignore automatic transition while pinned");
    assert_eq!(ignored, pinned);

    let following = harness
        .service
        .follow_workspace_agent(
            workspace.workspace_id,
            FollowWorkspaceAgentRequest {
                expected_revision: pinned.revision,
            },
        )
        .expect("follow agent activity");
    assert_eq!(
        following.placement.mode,
        WorkspaceBoardPlacementMode::Automatic
    );
    assert_eq!(following.revision, pinned.revision + 1);
    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let workflow_event_count: i64 = connection
        .query_row(
            "SELECT count(*) FROM workspace_workflow_events WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("workflow transition events before automation");
    assert_eq!(
        workflow_event_count, 1,
        "follow-agent is not a lane transition"
    );
    drop(connection);
    let automated = harness
        .service
        .transition_workflow(
            workspace.workspace_id,
            TransitionWorkspaceWorkflowRequest {
                state: WorkspaceWorkflowState::Active,
                expected_revision: following.revision,
            },
        )
        .expect("apply automatic transition after unpin");
    assert_eq!(automated.state, WorkspaceWorkflowState::Active);
    assert_eq!(automated.revision, following.revision + 1);

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    let persisted_record_json: String = connection
        .query_row(
            "SELECT record_json FROM workspace_projection WHERE workspace_id = ?1",
            [workspace.workspace_id.to_string()],
            |row| row.get(0),
        )
        .expect("record JSON after board placement");
    assert_eq!(persisted_record_json, original_record_json);
}

#[test]
fn removal_tombstone_is_append_only_idempotent_and_hidden_from_active_views() {
    let harness = Harness::new();
    let workspace = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .unwrap()
        .workspace;
    let idempotency_key = Uuid::new_v4().to_string();
    let effect_digest = format!("sha256:{}", "a".repeat(64));
    let result_json = format!(
        r#"{{"workspaceId":"{}","removedWorktreeCount":0}}"#,
        workspace.workspace_id
    );

    let removed = harness
        .service
        .tombstone(
            workspace.workspace_id,
            &idempotency_key,
            &effect_digest,
            &result_json,
        )
        .expect("append tombstone");
    assert!(!removed.replayed);
    assert_eq!(removed.tombstone.workspace_id, workspace.workspace_id);
    assert_eq!(removed.tombstone.result_json, result_json);
    assert!(
        harness
            .service
            .get(workspace.workspace_id)
            .unwrap()
            .is_none()
    );
    assert!(harness.service.list().unwrap().workspaces.is_empty());
    assert!(
        harness
            .reopen()
            .get(workspace.workspace_id)
            .unwrap()
            .is_none()
    );

    let replay = harness
        .service
        .tombstone(
            workspace.workspace_id,
            &idempotency_key,
            &effect_digest,
            &result_json,
        )
        .expect("replay tombstone");
    assert!(replay.replayed);
    assert_eq!(replay.tombstone, removed.tombstone);

    let connection = Connection::open(harness.service.store().database_path()).unwrap();
    assert!(
        connection
            .execute(
                "UPDATE workspace_tombstone_events SET result_json = '{}'",
                []
            )
            .is_err()
    );
    assert!(
        connection
            .execute("DELETE FROM workspace_tombstone_events", [])
            .is_err()
    );
}

#[test]
fn same_key_and_canonical_request_replays_but_different_request_conflicts() {
    let harness = Harness::new();
    let idempotency_key = Uuid::new_v4();
    let first = harness
        .service
        .create(&idempotency_key.to_string(), request())
        .unwrap();

    let mut equivalent = request();
    equivalent.intent = WorkspaceIntent::Jira {
        issue_key: " PLATFORM-42 ".into(),
    };
    equivalent.title = "Checkout retry race".into();
    equivalent.repositories.reverse();
    let replay = harness
        .service
        .create(&idempotency_key.to_string(), equivalent)
        .unwrap();
    assert!(replay.replayed);
    assert_eq!(replay.workspace, first.workspace);

    let mut conflict = request();
    conflict.title = "A different workspace".into();
    assert!(matches!(
        harness
            .service
            .create(&idempotency_key.to_string(), conflict),
        Err(WorkspaceStoreError::IdempotencyConflict {
            idempotency_key: found
        }) if found == idempotency_key
    ));
    assert_eq!(harness.service.list().unwrap().workspaces.len(), 1);
}

#[test]
fn issue_key_is_not_an_upsert_key() {
    let harness = Harness::new();
    let first = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .unwrap();
    let second = harness
        .service
        .create(&Uuid::new_v4().to_string(), request())
        .unwrap();

    assert_ne!(first.workspace.workspace_id, second.workspace.workspace_id);
    assert_eq!(harness.service.list().unwrap().workspaces.len(), 2);
}

#[test]
fn rejects_invalid_configuration_keys_and_workspace_input() {
    let temp = tempfile::tempdir().unwrap();
    let relative = PathBuf::from("relative-data");
    assert!(matches!(
        WorkspaceService::open(&relative, "default", temp.path()),
        Err(WorkspaceStoreError::DataDirectoryMustBeAbsolute)
    ));
    assert!(matches!(
        WorkspaceService::open(temp.path(), "bad/root", temp.path()),
        Err(WorkspaceStoreError::InvalidWorkspaceRootId)
    ));
    assert!(matches!(
        WorkspaceService::open(temp.path(), "default", Path::new("relative-root")),
        Err(WorkspaceStoreError::WorkspaceRootMustBeAbsolute)
    ));

    let harness = Harness::new();
    assert!(matches!(
        harness.service.create("not-a-uuid", request()),
        Err(WorkspaceStoreError::InvalidIdempotencyKey)
    ));
    let mut invalid = request();
    invalid.repositories.clear();
    assert!(matches!(
        harness.service.create(&Uuid::new_v4().to_string(), invalid),
        Err(WorkspaceStoreError::Validation(
            WorkspaceValidationError::EmptyRepositories
        ))
    ));
    assert!(harness.service.list().unwrap().workspaces.is_empty());
}

#[test]
fn concurrent_retries_create_exactly_one_workspace_and_event() {
    let harness = Harness::new();
    let service = Arc::new(harness.service.clone());
    let barrier = Arc::new(Barrier::new(8));
    let idempotency_key = Uuid::new_v4().to_string();
    let handles: Vec<_> = (0..8)
        .map(|_| {
            let service = Arc::clone(&service);
            let barrier = Arc::clone(&barrier);
            let idempotency_key = idempotency_key.clone();
            thread::spawn(move || {
                barrier.wait();
                service.create(&idempotency_key, request()).unwrap()
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();

    assert_eq!(results.iter().filter(|result| !result.replayed).count(), 1);
    assert_eq!(results.iter().filter(|result| result.replayed).count(), 7);
    let workspace_id = results[0].workspace.workspace_id;
    assert!(
        results
            .iter()
            .all(|result| result.workspace.workspace_id == workspace_id)
    );
    assert_eq!(service.list().unwrap().workspaces.len(), 1);
}
