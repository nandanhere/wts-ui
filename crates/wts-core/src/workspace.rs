//! Pure contracts for creating a local workspace record.
//!
//! These types describe user intent, not filesystem or process authority.
//! Filesystem roots, workspace identifiers, lifecycle state, and timestamps
//! are assigned by the trusted store.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;
use uuid::Uuid;

pub const MAX_WORKSPACE_TITLE_CHARS: usize = 240;
pub const MAX_REPOSITORIES_PER_WORKSPACE: usize = 32;
pub const MAX_REPOSITORY_LABEL_CHARS: usize = 128;
pub const MAX_BASE_REF_CHARS: usize = 255;
pub const MAX_REPOSITORY_SET_LABEL_CHARS: usize = 120;
pub const MAX_OPENPROJECT_DISPLAY_ID_CHARS: usize = 80;
pub const MAX_RUNTIME_SERVICES: usize = 32;
pub const MAX_RUNTIME_PORTS_PER_SERVICE: usize = 8;
pub const MAX_RUNTIME_IDENTIFIER_CHARS: usize = 160;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WorkspaceIntent {
    Jira {
        issue_key: String,
    },
    OpenProject {
        work_package_id: u64,
        display_id: String,
    },
    RepositorySet {
        label: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceProvider {
    Codex,
    OpenCode,
    Hermes,
    VsCode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePhase {
    Draft,
}

/// The user-controlled workflow lane for a workspace.
///
/// This state is deliberately separate from [`WorkspaceIntent`] and
/// [`WorkspacePhase`]. Moving a card must not rewrite the immutable creation
/// request or grant additional filesystem authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceWorkflowState {
    Ready,
    Active,
    Review,
    Parked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransitionWorkspaceWorkflowRequest {
    pub state: WorkspaceWorkflowState,
    pub expected_revision: u64,
}

/// Atomically places a workspace in an exact board lane position.
///
/// At most one neighbor can be set. When both neighbors are absent, the
/// workspace is appended to the target lane.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlaceWorkspaceOnBoardRequest {
    pub state: WorkspaceWorkflowState,
    pub expected_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_workspace_id: Option<Uuid>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_workspace_id: Option<Uuid>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FollowWorkspaceAgentRequest {
    pub expected_revision: u64,
}

/// A cheap, last-known observation of whether WTS created a workspace.
///
/// This is deliberately separate from `WorkspacePhase`: it is suitable for
/// rendering a list, but it does not grant authority to operate on a
/// workspace. Hosts must still validate the materialization before opening or
/// mutating it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceMaterializationState {
    Unknown,
    NotMaterialized,
    Materialized,
    NeedsAttention,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRepositoryRequest {
    /// Opaque host-derived identity for a specific local Git repository.
    ///
    /// Older saved plans omit this field and continue to resolve by their
    /// unique label. New catalog-backed plans pin it so a later label collision
    /// cannot silently retarget the workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository_id: Option<String>,
    pub label: String,
    pub base_ref: String,
}

/// Select one catalog-owned repository for an existing workspace.
///
/// The application resolves the opaque repository identity to a trusted local
/// path. The request never carries a filesystem path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AddWorkspaceRepositoryRequest {
    pub repository_id: String,
    pub base_ref: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimePortPolicy {
    Prefer,
    Fixed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePortSelection {
    pub port_id: String,
    pub preferred_port: u16,
    pub policy: RuntimePortPolicy,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeServiceSelection {
    pub candidate_id: String,
    pub ports: Vec<RuntimePortSelection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePlanSelection {
    pub analysis_digest: String,
    pub services: Vec<RuntimeServiceSelection>,
}

/// A bounded, workspace-local home for agent plans and findings.
///
/// The browser chooses only these semantic options. The trusted application
/// maps them to fixed leaf names beneath the workspace root.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePlanningFolder {
    Plans,
    PlansAndKanban,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspacePlanningFormat {
    Notes,
    Kanban,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePlanningSelection {
    pub folder: WorkspacePlanningFolder,
    pub format: WorkspacePlanningFormat,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateWorkspaceRequest {
    pub intent: WorkspaceIntent,
    pub title: String,
    pub preferred_provider: WorkspaceProvider,
    pub repositories: Vec<WorkspaceRepositoryRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<RuntimePlanSelection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub planning: Option<WorkspacePlanningSelection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenameWorkspaceRequest {
    pub title: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WorkspaceValidationError {
    #[error("workspace title is required")]
    MissingTitle,
    #[error("workspace title exceeds {MAX_WORKSPACE_TITLE_CHARS} characters")]
    TitleTooLong,
    #[error("workspace title contains control characters")]
    InvalidTitle,
    #[error("Jira issue key is invalid")]
    InvalidIssueKey,
    #[error("OpenProject work-package identity is invalid")]
    InvalidOpenProjectWorkPackage,
    #[error("repository-set label is required")]
    MissingRepositorySetLabel,
    #[error("repository-set label exceeds {MAX_REPOSITORY_SET_LABEL_CHARS} characters")]
    RepositorySetLabelTooLong,
    #[error("repository-set label contains control characters or path separators")]
    InvalidRepositorySetLabel,
    #[error("at least one repository request is required")]
    EmptyRepositories,
    #[error("a workspace may contain at most {MAX_REPOSITORIES_PER_WORKSPACE} repositories")]
    TooManyRepositories,
    #[error("repository label is required at index {index}")]
    MissingRepositoryLabel { index: usize },
    #[error("repository label at index {index} exceeds {MAX_REPOSITORY_LABEL_CHARS} characters")]
    RepositoryLabelTooLong { index: usize },
    #[error("repository label at index {index} contains control characters or path separators")]
    InvalidRepositoryLabel { index: usize },
    #[error("repository identifier is invalid for {repository}")]
    InvalidRepositoryId { repository: String },
    #[error("repository base ref is invalid for {repository}")]
    InvalidBaseRef { repository: String },
    #[error("repository labels must be unique: {0}")]
    DuplicateRepository(String),
    #[error("repository identifiers must be unique: {repository}")]
    DuplicateRepositoryId { repository: String },
    #[error("runtime analysis digest must be a lowercase sha256 digest")]
    InvalidRuntimeAnalysisDigest,
    #[error("a runtime plan must select at least one service")]
    EmptyRuntimeServices,
    #[error("a runtime plan may select at most {MAX_RUNTIME_SERVICES} services")]
    TooManyRuntimeServices,
    #[error("runtime candidate identifier is invalid at index {index}")]
    InvalidRuntimeCandidateId { index: usize },
    #[error("runtime candidate identifiers must be unique: {candidate_id}")]
    DuplicateRuntimeCandidateId { candidate_id: String },
    #[error(
        "runtime candidate {candidate_id} may configure at most {MAX_RUNTIME_PORTS_PER_SERVICE} ports"
    )]
    TooManyRuntimePorts { candidate_id: String },
    #[error("runtime port identifier is invalid for candidate {candidate_id} at index {index}")]
    InvalidRuntimePortId { candidate_id: String, index: usize },
    #[error("runtime port identifiers must be unique within candidate {candidate_id}: {port_id}")]
    DuplicateRuntimePortId {
        candidate_id: String,
        port_id: String,
    },
    #[error("runtime port {port_id} for candidate {candidate_id} must be between 1024 and 65535")]
    InvalidRuntimePort {
        candidate_id: String,
        port_id: String,
    },
}

impl CreateWorkspaceRequest {
    /// Validate and canonicalize untrusted creation input.
    ///
    /// Repository order is not semantically significant, so canonical output
    /// sorts repositories. This also makes request hashing stable across UI
    /// reorderings.
    pub fn normalize(mut self) -> Result<Self, WorkspaceValidationError> {
        self.title = normalize_workspace_title(self.title)?;

        self.intent = normalize_intent(self.intent)?;
        self.runtime = self.runtime.map(normalize_runtime).transpose()?;

        if self.repositories.is_empty() {
            return Err(WorkspaceValidationError::EmptyRepositories);
        }
        if self.repositories.len() > MAX_REPOSITORIES_PER_WORKSPACE {
            return Err(WorkspaceValidationError::TooManyRepositories);
        }

        let mut labels = BTreeMap::new();
        let mut repository_ids = BTreeSet::new();
        for (index, repository) in self.repositories.iter_mut().enumerate() {
            repository.label = repository.label.trim().to_owned();
            if repository.label.is_empty() {
                return Err(WorkspaceValidationError::MissingRepositoryLabel { index });
            }
            if repository.label.chars().count() > MAX_REPOSITORY_LABEL_CHARS {
                return Err(WorkspaceValidationError::RepositoryLabelTooLong { index });
            }
            if has_control_or_path_separator(&repository.label) {
                return Err(WorkspaceValidationError::InvalidRepositoryLabel { index });
            }

            if let Some(repository_id) = repository.repository_id.as_deref() {
                if !valid_repository_id(repository_id) {
                    return Err(WorkspaceValidationError::InvalidRepositoryId {
                        repository: repository.label.clone(),
                    });
                }
                if !repository_ids.insert(repository_id.to_owned()) {
                    return Err(WorkspaceValidationError::DuplicateRepositoryId {
                        repository: repository.label.clone(),
                    });
                }
            }

            repository.base_ref = repository.base_ref.trim().to_owned();
            if !valid_base_ref(&repository.base_ref) {
                return Err(WorkspaceValidationError::InvalidBaseRef {
                    repository: repository.label.clone(),
                });
            }

            let canonical_label = repository.label.to_lowercase();
            let pinned = repository.repository_id.is_some();
            if labels
                .insert(canonical_label, pinned)
                .is_some_and(|previous_pinned| !previous_pinned || !pinned)
            {
                return Err(WorkspaceValidationError::DuplicateRepository(
                    repository.label.clone(),
                ));
            }
        }

        self.repositories.sort_by(|left, right| {
            left.label
                .to_lowercase()
                .cmp(&right.label.to_lowercase())
                .then(left.repository_id.cmp(&right.repository_id))
                .then(left.base_ref.cmp(&right.base_ref))
        });
        Ok(self)
    }
}

impl RenameWorkspaceRequest {
    pub fn normalize(mut self) -> Result<Self, WorkspaceValidationError> {
        self.title = normalize_workspace_title(self.title)?;
        Ok(self)
    }
}

fn normalize_workspace_title(title: String) -> Result<String, WorkspaceValidationError> {
    let title = title.trim().to_owned();
    if title.is_empty() {
        return Err(WorkspaceValidationError::MissingTitle);
    }
    if title.chars().count() > MAX_WORKSPACE_TITLE_CHARS {
        return Err(WorkspaceValidationError::TitleTooLong);
    }
    if title.chars().any(char::is_control) {
        return Err(WorkspaceValidationError::InvalidTitle);
    }
    Ok(title)
}

fn normalize_runtime(
    mut runtime: RuntimePlanSelection,
) -> Result<RuntimePlanSelection, WorkspaceValidationError> {
    if !valid_analysis_digest(&runtime.analysis_digest) {
        return Err(WorkspaceValidationError::InvalidRuntimeAnalysisDigest);
    }
    if runtime.services.is_empty() {
        return Err(WorkspaceValidationError::EmptyRuntimeServices);
    }
    if runtime.services.len() > MAX_RUNTIME_SERVICES {
        return Err(WorkspaceValidationError::TooManyRuntimeServices);
    }

    let mut candidate_ids = BTreeSet::new();
    for (service_index, service) in runtime.services.iter_mut().enumerate() {
        if !valid_runtime_identifier(&service.candidate_id) {
            return Err(WorkspaceValidationError::InvalidRuntimeCandidateId {
                index: service_index,
            });
        }
        if !candidate_ids.insert(service.candidate_id.clone()) {
            return Err(WorkspaceValidationError::DuplicateRuntimeCandidateId {
                candidate_id: service.candidate_id.clone(),
            });
        }
        if service.ports.len() > MAX_RUNTIME_PORTS_PER_SERVICE {
            return Err(WorkspaceValidationError::TooManyRuntimePorts {
                candidate_id: service.candidate_id.clone(),
            });
        }

        let mut port_ids = BTreeSet::new();
        for (port_index, port) in service.ports.iter().enumerate() {
            if !valid_runtime_identifier(&port.port_id) {
                return Err(WorkspaceValidationError::InvalidRuntimePortId {
                    candidate_id: service.candidate_id.clone(),
                    index: port_index,
                });
            }
            if !port_ids.insert(port.port_id.clone()) {
                return Err(WorkspaceValidationError::DuplicateRuntimePortId {
                    candidate_id: service.candidate_id.clone(),
                    port_id: port.port_id.clone(),
                });
            }
            if port.preferred_port < 1024 {
                return Err(WorkspaceValidationError::InvalidRuntimePort {
                    candidate_id: service.candidate_id.clone(),
                    port_id: port.port_id.clone(),
                });
            }
        }
        service
            .ports
            .sort_by(|left, right| left.port_id.cmp(&right.port_id));
    }
    runtime
        .services
        .sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    Ok(runtime)
}

fn normalize_intent(intent: WorkspaceIntent) -> Result<WorkspaceIntent, WorkspaceValidationError> {
    match intent {
        WorkspaceIntent::Jira { issue_key } => {
            let issue_key = issue_key.trim().to_ascii_uppercase();
            if !valid_issue_key(&issue_key) {
                return Err(WorkspaceValidationError::InvalidIssueKey);
            }
            Ok(WorkspaceIntent::Jira { issue_key })
        }
        WorkspaceIntent::OpenProject {
            work_package_id,
            display_id,
        } => {
            let display_id = display_id.trim().to_owned();
            if work_package_id == 0
                || display_id.is_empty()
                || display_id.chars().count() > MAX_OPENPROJECT_DISPLAY_ID_CHARS
                || has_control_or_path_separator(&display_id)
            {
                return Err(WorkspaceValidationError::InvalidOpenProjectWorkPackage);
            }
            Ok(WorkspaceIntent::OpenProject {
                work_package_id,
                display_id,
            })
        }
        WorkspaceIntent::RepositorySet { label } => {
            let label = label.trim().to_owned();
            if label.is_empty() {
                return Err(WorkspaceValidationError::MissingRepositorySetLabel);
            }
            if label.chars().count() > MAX_REPOSITORY_SET_LABEL_CHARS {
                return Err(WorkspaceValidationError::RepositorySetLabelTooLong);
            }
            if has_control_or_path_separator(&label) {
                return Err(WorkspaceValidationError::InvalidRepositorySetLabel);
            }
            Ok(WorkspaceIntent::RepositorySet { label })
        }
    }
}

fn valid_issue_key(issue_key: &str) -> bool {
    let Some((project, number)) = issue_key.split_once('-') else {
        return false;
    };
    if project.len() < 2
        || project.len() > 16
        || !project
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_uppercase())
        || !project
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
    {
        return false;
    }
    (1..=10).contains(&number.len())
        && !number.starts_with('0')
        && number.bytes().all(|byte| byte.is_ascii_digit())
}

fn has_control_or_path_separator(value: &str) -> bool {
    value
        .chars()
        .any(|character| character.is_control() || matches!(character, '/' | '\\'))
}

fn valid_repository_id(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("repo_") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_analysis_digest(value: &str) -> bool {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return false;
    };
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_runtime_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_RUNTIME_IDENTIFIER_CHARS
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_base_ref(base_ref: &str) -> bool {
    if base_ref.is_empty()
        || base_ref.chars().count() > MAX_BASE_REF_CHARS
        || base_ref.starts_with('-')
        || base_ref.starts_with('/')
        || base_ref.ends_with('/')
        || base_ref.ends_with('.')
        || base_ref.ends_with(".lock")
        || base_ref.contains("..")
        || base_ref.contains("@{")
        || base_ref.contains("//")
    {
        return false;
    }

    !base_ref.chars().any(|character| {
        character.is_control()
            || character.is_whitespace()
            || matches!(character, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> CreateWorkspaceRequest {
        CreateWorkspaceRequest {
            intent: WorkspaceIntent::Jira {
                issue_key: " platform-42 ".into(),
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
                    label: " checkout-api ".into(),
                    base_ref: "release/2026.07".into(),
                },
            ],
            runtime: None,
            planning: None,
        }
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
    fn normalizes_workspace_creation_input_deterministically() {
        let normalized = request().normalize().unwrap();

        assert_eq!(normalized.title, "Checkout retry race");
        assert_eq!(
            normalized.intent,
            WorkspaceIntent::Jira {
                issue_key: "PLATFORM-42".into()
            }
        );
        assert_eq!(normalized.repositories[0].label, "checkout-api");
        assert_eq!(normalized.repositories[1].label, "payments-sdk");
    }

    #[test]
    fn validates_and_canonicalizes_runtime_selection() {
        let mut request = request();
        request.runtime = Some(runtime_selection());

        let normalized = request.normalize().expect("valid runtime selection");
        let runtime = normalized.runtime.expect("normalized runtime");

        assert_eq!(runtime.services[0].candidate_id, "service:api");
        assert_eq!(runtime.services[1].candidate_id, "service:web");
        assert_eq!(runtime.services[1].ports[0].port_id, "http");
        assert_eq!(runtime.services[1].ports[1].port_id, "metrics");
        assert_eq!(
            serde_json::to_value(&runtime).expect("serialize runtime"),
            json!({
                "analysisDigest": format!("sha256:{}", "a".repeat(64)),
                "services": [
                    {
                        "candidateId": "service:api",
                        "ports": [],
                    },
                    {
                        "candidateId": "service:web",
                        "ports": [
                            {
                                "portId": "http",
                                "preferredPort": 8080,
                                "policy": "fixed",
                            },
                            {
                                "portId": "metrics",
                                "preferredPort": 9090,
                                "policy": "prefer",
                            },
                        ],
                    },
                ],
            })
        );
    }

    #[test]
    fn serializes_the_bounded_planning_home_contract() {
        let mut request = request();
        request.planning = Some(WorkspacePlanningSelection {
            folder: WorkspacePlanningFolder::PlansAndKanban,
            format: WorkspacePlanningFormat::Kanban,
        });

        let normalized = request.normalize().expect("planning selection");
        assert_eq!(
            serde_json::to_value(normalized.planning).expect("serialize planning"),
            json!({
                "folder": "plansAndKanban",
                "format": "kanban",
            })
        );
    }

    #[test]
    fn rejects_invalid_runtime_shape_and_authority_tokens() {
        let mut empty = request();
        empty.runtime = Some(RuntimePlanSelection {
            analysis_digest: format!("sha256:{}", "a".repeat(64)),
            services: vec![],
        });
        assert_eq!(
            empty.normalize(),
            Err(WorkspaceValidationError::EmptyRuntimeServices)
        );

        for digest in [
            "a".repeat(64),
            format!("sha256:{}", "a".repeat(63)),
            format!("sha256:{}", "A".repeat(64)),
            format!("sha256:{}", "g".repeat(64)),
        ] {
            let mut invalid = request();
            let mut runtime = runtime_selection();
            runtime.analysis_digest = digest;
            invalid.runtime = Some(runtime);
            assert_eq!(
                invalid.normalize(),
                Err(WorkspaceValidationError::InvalidRuntimeAnalysisDigest)
            );
        }

        for candidate_id in [
            String::new(),
            "service/web".into(),
            "service web".into(),
            "a".repeat(MAX_RUNTIME_IDENTIFIER_CHARS + 1),
        ] {
            let mut invalid = request();
            let mut runtime = runtime_selection();
            runtime.services[0].candidate_id = candidate_id;
            invalid.runtime = Some(runtime);
            assert!(matches!(
                invalid.normalize(),
                Err(WorkspaceValidationError::InvalidRuntimeCandidateId { .. })
            ));
        }
    }

    #[test]
    fn rejects_duplicate_runtime_ids_limits_and_privileged_ports() {
        let mut duplicate_candidate = request();
        let mut runtime = runtime_selection();
        runtime.services[1].candidate_id = runtime.services[0].candidate_id.clone();
        duplicate_candidate.runtime = Some(runtime);
        assert!(matches!(
            duplicate_candidate.normalize(),
            Err(WorkspaceValidationError::DuplicateRuntimeCandidateId { .. })
        ));

        let mut duplicate_port = request();
        let mut runtime = runtime_selection();
        runtime.services[0].ports[1].port_id = runtime.services[0].ports[0].port_id.clone();
        duplicate_port.runtime = Some(runtime);
        assert!(matches!(
            duplicate_port.normalize(),
            Err(WorkspaceValidationError::DuplicateRuntimePortId { .. })
        ));

        let mut invalid_port_id = request();
        let mut runtime = runtime_selection();
        runtime.services[0].ports[0].port_id = "../http".into();
        invalid_port_id.runtime = Some(runtime);
        assert!(matches!(
            invalid_port_id.normalize(),
            Err(WorkspaceValidationError::InvalidRuntimePortId { .. })
        ));

        let mut privileged_port = request();
        let mut runtime = runtime_selection();
        runtime.services[0].ports[0].preferred_port = 80;
        privileged_port.runtime = Some(runtime);
        assert!(matches!(
            privileged_port.normalize(),
            Err(WorkspaceValidationError::InvalidRuntimePort { .. })
        ));

        let mut too_many_services = request();
        let template = runtime_selection().services.remove(0);
        too_many_services.runtime = Some(RuntimePlanSelection {
            analysis_digest: format!("sha256:{}", "a".repeat(64)),
            services: (0..=MAX_RUNTIME_SERVICES)
                .map(|index| RuntimeServiceSelection {
                    candidate_id: format!("service:{index}"),
                    ports: template.ports.clone(),
                })
                .collect(),
        });
        assert_eq!(
            too_many_services.normalize(),
            Err(WorkspaceValidationError::TooManyRuntimeServices)
        );

        let mut too_many_ports = request();
        let mut runtime = runtime_selection();
        runtime.services[0].ports = (0..=MAX_RUNTIME_PORTS_PER_SERVICE)
            .map(|index| RuntimePortSelection {
                port_id: format!("port:{index}"),
                preferred_port: 8080,
                policy: RuntimePortPolicy::Prefer,
            })
            .collect();
        too_many_ports.runtime = Some(runtime);
        assert!(matches!(
            too_many_ports.normalize(),
            Err(WorkspaceValidationError::TooManyRuntimePorts { .. })
        ));
    }

    #[test]
    fn normalizes_openproject_identity_without_discarding_display_id() {
        let mut request = request();
        request.intent = WorkspaceIntent::OpenProject {
            work_package_id: 42,
            display_id: "  APP-42  ".into(),
        };

        let normalized = request.normalize().unwrap();

        assert_eq!(
            normalized.intent,
            WorkspaceIntent::OpenProject {
                work_package_id: 42,
                display_id: "APP-42".into(),
            }
        );
    }

    #[test]
    fn rejects_invalid_openproject_identity() {
        for intent in [
            WorkspaceIntent::OpenProject {
                work_package_id: 0,
                display_id: "APP-42".into(),
            },
            WorkspaceIntent::OpenProject {
                work_package_id: 42,
                display_id: " ../APP-42 ".into(),
            },
        ] {
            let mut request = request();
            request.intent = intent;
            assert_eq!(
                request.normalize().unwrap_err(),
                WorkspaceValidationError::InvalidOpenProjectWorkPackage
            );
        }
    }

    #[test]
    fn rejects_duplicate_and_path_like_repository_labels() {
        let mut duplicate = request();
        duplicate.repositories[1].label = "PAYMENTS-SDK".into();
        assert_eq!(
            duplicate.normalize(),
            Err(WorkspaceValidationError::DuplicateRepository(
                "PAYMENTS-SDK".into()
            ))
        );

        let mut path_like = request();
        path_like.repositories[0].label = "../payments-sdk".into();
        assert_eq!(
            path_like.normalize(),
            Err(WorkspaceValidationError::InvalidRepositoryLabel { index: 0 })
        );
    }

    #[test]
    fn validates_and_deduplicates_optional_repository_ids() {
        let repository_id = format!("repo_{}", "a".repeat(64));
        let mut pinned = request();
        pinned.repositories[0].repository_id = Some(repository_id.clone());
        let normalized = pinned.normalize().expect("valid pinned repository");
        assert_eq!(
            normalized.repositories[1].repository_id.as_deref(),
            Some(repository_id.as_str())
        );
        assert_eq!(
            serde_json::to_value(&normalized).expect("serialize pinned request")["repositories"][1]
                ["repositoryId"],
            repository_id
        );

        for invalid in [
            "repo_abc".to_owned(),
            format!("repo_{}", "A".repeat(64)),
            format!("repo_{}", "g".repeat(64)),
            format!("other_{}", "a".repeat(64)),
            format!(" repo_{}", "a".repeat(64)),
        ] {
            let mut request = request();
            request.repositories[0].repository_id = Some(invalid);
            assert_eq!(
                request.normalize(),
                Err(WorkspaceValidationError::InvalidRepositoryId {
                    repository: "payments-sdk".into(),
                })
            );
        }

        let mut duplicate = request();
        duplicate.repositories[0].repository_id = Some(repository_id.clone());
        duplicate.repositories[1].repository_id = Some(repository_id);
        assert_eq!(
            duplicate.normalize(),
            Err(WorkspaceValidationError::DuplicateRepositoryId {
                repository: "checkout-api".into(),
            })
        );

        let mut same_label = request();
        same_label.repositories[0].label = "shared".into();
        same_label.repositories[0].repository_id = Some(format!("repo_{}", "a".repeat(64)));
        same_label.repositories[1].label = "SHARED".into();
        same_label.repositories[1].repository_id = Some(format!("repo_{}", "b".repeat(64)));
        assert!(
            same_label.normalize().is_ok(),
            "distinct pinned identities make a duplicate display label unambiguous"
        );
    }

    #[test]
    fn rejects_unknown_fields_in_mutating_payloads() {
        let value = json!({
            "intent": { "type": "jira", "issueKey": "PLATFORM-42", "path": "/tmp" },
            "title": "Checkout retry race",
            "preferredProvider": "codex",
            "repositories": [{ "label": "checkout-api", "baseRef": "main" }]
        });

        assert!(serde_json::from_value::<CreateWorkspaceRequest>(value).is_err());

        let value = json!({
            "intent": { "type": "jira", "issueKey": "PLATFORM-42" },
            "title": "Checkout retry race",
            "preferredProvider": "codex",
            "repositories": [{ "label": "checkout-api", "baseRef": "main" }],
            "runtime": {
                "analysisDigest": format!("sha256:{}", "a".repeat(64)),
                "services": [{
                    "candidateId": "service:api",
                    "ports": [{
                        "portId": "http",
                        "preferredPort": 8080,
                        "policy": "prefer",
                        "command": "npm run dev",
                    }],
                }],
            },
        });
        assert!(serde_json::from_value::<CreateWorkspaceRequest>(value).is_err());

        assert!(
            serde_json::from_value::<TransitionWorkspaceWorkflowRequest>(json!({
                "state": "review",
                "expectedRevision": 1,
                "path": "/tmp",
            }))
            .is_err()
        );
    }

    #[test]
    fn workflow_transition_uses_the_fixed_camel_case_contract() {
        let request: TransitionWorkspaceWorkflowRequest = serde_json::from_value(json!({
            "state": "parked",
            "expectedRevision": 4,
        }))
        .expect("workflow transition");

        assert_eq!(request.state, WorkspaceWorkflowState::Parked);
        assert_eq!(request.expected_revision, 4);
        assert_eq!(
            serde_json::to_value(request).expect("serialize workflow transition"),
            json!({ "state": "parked", "expectedRevision": 4 })
        );
        assert!(
            serde_json::from_value::<TransitionWorkspaceWorkflowRequest>(json!({
                "state": "deleted",
                "expectedRevision": 4,
            }))
            .is_err()
        );
    }

    #[test]
    fn board_placement_uses_the_fixed_camel_case_contract() {
        let before_workspace_id = Uuid::new_v4();
        let request: PlaceWorkspaceOnBoardRequest = serde_json::from_value(json!({
            "state": "review",
            "expectedRevision": 7,
            "beforeWorkspaceId": before_workspace_id,
        }))
        .expect("board placement");

        assert_eq!(request.state, WorkspaceWorkflowState::Review);
        assert_eq!(request.expected_revision, 7);
        assert_eq!(request.before_workspace_id, Some(before_workspace_id));
        assert_eq!(request.after_workspace_id, None);
        assert_eq!(
            serde_json::to_value(request).expect("serialize board placement"),
            json!({
                "state": "review",
                "expectedRevision": 7,
                "beforeWorkspaceId": before_workspace_id,
            })
        );

        let follow: FollowWorkspaceAgentRequest = serde_json::from_value(json!({
            "expectedRevision": 8,
        }))
        .expect("follow agent");
        assert_eq!(follow.expected_revision, 8);
        assert_eq!(
            serde_json::to_value(follow).expect("serialize follow agent"),
            json!({ "expectedRevision": 8 })
        );
    }

    #[test]
    fn round_trips_the_exact_camel_case_client_contract() {
        let value = json!({
            "intent": { "type": "jira", "issueKey": "PLATFORM-42" },
            "title": "Checkout retry race",
            "preferredProvider": "vsCode",
            "repositories": [{ "label": "checkout-api", "baseRef": "main" }]
        });

        let request: CreateWorkspaceRequest =
            serde_json::from_value(value.clone()).expect("client DTO must deserialize");

        assert_eq!(
            request.intent,
            WorkspaceIntent::Jira {
                issue_key: "PLATFORM-42".into()
            }
        );
        assert_eq!(
            serde_json::to_value(request).expect("request must serialize"),
            value
        );
    }

    #[test]
    fn omitted_repository_ids_preserve_the_legacy_wire_shape() {
        let normalized = request().normalize().expect("legacy request");
        let serialized = serde_json::to_value(normalized).expect("serialize legacy request");

        assert!(
            serialized["repositories"]
                .as_array()
                .expect("repositories")
                .iter()
                .all(|repository| repository.get("repositoryId").is_none())
        );
    }

    #[test]
    fn validates_jira_keys_and_git_refs() {
        let mut invalid_issue = request();
        invalid_issue.intent = WorkspaceIntent::Jira {
            issue_key: "https://jira/PLATFORM-42".into(),
        };
        assert_eq!(
            invalid_issue.normalize(),
            Err(WorkspaceValidationError::InvalidIssueKey)
        );

        let mut invalid_ref = request();
        invalid_ref.repositories[0].base_ref = "../main".into();
        assert!(matches!(
            invalid_ref.normalize(),
            Err(WorkspaceValidationError::InvalidBaseRef { .. })
        ));
    }
}
