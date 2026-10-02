//! Pure domain types for the WTS workspace-boundary protocol.
//!
//! This module deliberately performs no Git, process, filesystem, network, or
//! provider I/O. Adapters may execute a compiled boundary, but they cannot
//! silently reinterpret it.

pub mod compatibility;
pub mod workspace;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepositoryPin {
    pub name: String,
    pub base_ref: String,
    pub base_commit: String,
    pub relevance_basis_points: u16,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceSpec {
    pub id: String,
    pub repository: String,
    pub default_port: u16,
    pub depends_on: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeLease {
    pub service_id: String,
    pub loopback_port: u16,
    pub hostname: String,
    pub namespace: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Effect {
    Read,
    Write,
    Execute,
    Network,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capability {
    pub effect: Effect,
    pub resource: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceBoundary {
    pub issue_key: String,
    pub revision: u32,
    pub parent_digest: Option<String>,
    pub base_graph_digest: String,
    pub overlay_digest: String,
    pub repositories: Vec<RepositoryPin>,
    pub runtime_leases: Vec<RuntimeLease>,
    pub capabilities: Vec<Capability>,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoundaryDraft {
    pub issue_key: String,
    pub base_graph_digest: String,
    pub repositories: Vec<RepositoryPin>,
    pub services: Vec<ServiceSpec>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActionEnvelope {
    pub boundary_digest: String,
    pub effect: Effect,
    pub resource: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphObservation {
    pub source_repository: String,
    pub target_repository: String,
    pub edge: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScopeDrift {
    pub observation: GraphObservation,
    pub reason: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum BoundaryError {
    #[error("an issue key is required")]
    MissingIssue,
    #[error("at least one repository is required")]
    EmptyScope,
    #[error("repository names must be unique: {0}")]
    DuplicateRepository(String),
    #[error("service {service} belongs to a repository outside the approved scope: {repository}")]
    ServiceOutsideScope { service: String, repository: String },
    #[error("no loopback port is available for {0}")]
    PortSpaceExhausted(String),
    #[error("the action was authored against a stale workspace boundary")]
    StaleBoundary,
    #[error("the requested effect is outside the approved workspace boundary")]
    CapabilityDenied,
}

pub struct BoundaryCompiler;

impl BoundaryCompiler {
    /// Compile a deterministic boundary. Equivalent drafts produce the same
    /// digest even if repository, service, evidence, or dependency input order
    /// differs.
    pub fn compile(
        mut draft: BoundaryDraft,
        occupied_ports: &BTreeSet<u16>,
    ) -> Result<WorkspaceBoundary, BoundaryError> {
        if draft.issue_key.trim().is_empty() {
            return Err(BoundaryError::MissingIssue);
        }
        if draft.repositories.is_empty() {
            return Err(BoundaryError::EmptyScope);
        }

        draft.issue_key = draft.issue_key.trim().to_ascii_uppercase();
        draft.repositories.sort_by(|a, b| a.name.cmp(&b.name));
        for repository in &mut draft.repositories {
            repository.evidence.sort();
            repository.evidence.dedup();
        }

        for pair in draft.repositories.windows(2) {
            if pair[0].name == pair[1].name {
                return Err(BoundaryError::DuplicateRepository(pair[0].name.clone()));
            }
        }

        let repository_names: BTreeSet<_> = draft
            .repositories
            .iter()
            .map(|repository| repository.name.as_str())
            .collect();

        draft.services.sort_by(|a, b| a.id.cmp(&b.id));
        for service in &mut draft.services {
            service.depends_on.sort();
            service.depends_on.dedup();
            if !repository_names.contains(service.repository.as_str()) {
                return Err(BoundaryError::ServiceOutsideScope {
                    service: service.id.clone(),
                    repository: service.repository.clone(),
                });
            }
        }

        let namespace = slug(&draft.issue_key);
        let mut reserved = occupied_ports.clone();
        let mut runtime_leases = Vec::with_capacity(draft.services.len());
        for service in &draft.services {
            let loopback_port = (service.default_port..=u16::MAX)
                .find(|candidate| !reserved.contains(candidate))
                .ok_or_else(|| BoundaryError::PortSpaceExhausted(service.id.clone()))?;
            reserved.insert(loopback_port);
            runtime_leases.push(RuntimeLease {
                service_id: service.id.clone(),
                loopback_port,
                hostname: format!("{}.{}.wts", slug(&service.id), namespace),
                namespace: namespace.clone(),
            });
        }

        let overlay_digest = digest_parts(
            std::iter::once(draft.issue_key.as_str())
                .chain(std::iter::once(draft.base_graph_digest.as_str()))
                .chain(draft.repositories.iter().flat_map(|repository| {
                    [
                        repository.name.as_str(),
                        repository.base_commit.as_str(),
                        repository.base_ref.as_str(),
                    ]
                })),
        );

        let mut capabilities = vec![
            Capability {
                effect: Effect::Read,
                resource: format!("workspace:{}/**", draft.issue_key),
            },
            Capability {
                effect: Effect::Write,
                resource: format!("workspace:{}/**", draft.issue_key),
            },
        ];
        capabilities.extend(runtime_leases.iter().flat_map(|lease| {
            [
                Capability {
                    effect: Effect::Execute,
                    resource: format!("process:{}", lease.service_id),
                },
                Capability {
                    effect: Effect::Network,
                    resource: format!("loopback:{}", lease.loopback_port),
                },
            ]
        }));
        capabilities.sort_by(|a, b| {
            effect_key(&a.effect)
                .cmp(effect_key(&b.effect))
                .then(a.resource.cmp(&b.resource))
        });

        let mut boundary = WorkspaceBoundary {
            issue_key: draft.issue_key,
            revision: 1,
            parent_digest: None,
            base_graph_digest: draft.base_graph_digest,
            overlay_digest,
            repositories: draft.repositories,
            runtime_leases,
            capabilities,
            digest: String::new(),
        };
        boundary.digest = boundary.compute_digest();
        Ok(boundary)
    }
}

impl WorkspaceBoundary {
    pub fn verify(&self, action: &ActionEnvelope) -> Result<(), BoundaryError> {
        if action.boundary_digest != self.digest {
            return Err(BoundaryError::StaleBoundary);
        }
        let permitted = self.capabilities.iter().any(|capability| {
            capability.effect == action.effect && capability.resource == action.resource
        });
        if permitted {
            Ok(())
        } else {
            Err(BoundaryError::CapabilityDenied)
        }
    }

    /// Detect a graph edge that has escaped the approved repository closure.
    /// An orchestrator can turn the result into a previewable boundary revision;
    /// it must not silently broaden agent authority.
    pub fn detect_scope_drift(&self, observation: GraphObservation) -> Option<ScopeDrift> {
        let approved: BTreeSet<_> = self
            .repositories
            .iter()
            .map(|repository| repository.name.as_str())
            .collect();
        if approved.contains(observation.source_repository.as_str())
            && !approved.contains(observation.target_repository.as_str())
        {
            Some(ScopeDrift {
                reason: format!(
                    "{} introduced an observed {} edge to excluded repository {}",
                    observation.source_repository, observation.edge, observation.target_repository
                ),
                observation,
            })
        } else {
            None
        }
    }

    pub fn revise(
        &self,
        draft: BoundaryDraft,
        occupied_ports: &BTreeSet<u16>,
    ) -> Result<Self, BoundaryError> {
        let mut revised = BoundaryCompiler::compile(draft, occupied_ports)?;
        revised.revision = self.revision + 1;
        revised.parent_digest = Some(self.digest.clone());
        revised.digest = revised.compute_digest();
        Ok(revised)
    }

    fn compute_digest(&self) -> String {
        let mut fields = BTreeMap::<String, String>::new();
        fields.insert("issue".into(), self.issue_key.clone());
        fields.insert("revision".into(), self.revision.to_string());
        fields.insert(
            "parent".into(),
            self.parent_digest.clone().unwrap_or_default(),
        );
        fields.insert("base_graph".into(), self.base_graph_digest.clone());
        fields.insert("overlay".into(), self.overlay_digest.clone());

        for repository in &self.repositories {
            fields.insert(
                format!("repo:{}", repository.name),
                format!(
                    "{}|{}|{}|{}",
                    repository.base_ref,
                    repository.base_commit,
                    repository.relevance_basis_points,
                    repository.evidence.join(",")
                ),
            );
        }
        for lease in &self.runtime_leases {
            fields.insert(
                format!("lease:{}", lease.service_id),
                format!(
                    "{}|{}|{}",
                    lease.loopback_port, lease.hostname, lease.namespace
                ),
            );
        }
        for (index, capability) in self.capabilities.iter().enumerate() {
            fields.insert(
                format!("capability:{index:04}"),
                format!("{}|{}", effect_key(&capability.effect), capability.resource),
            );
        }

        digest_parts(
            fields
                .iter()
                .flat_map(|(key, value)| [key.as_str(), value.as_str()]),
        )
    }
}

fn effect_key(effect: &Effect) -> &'static str {
    match effect {
        Effect::Read => "read",
        Effect::Write => "write",
        Effect::Execute => "execute",
        Effect::Network => "network",
    }
}

fn digest_parts<'a>(parts: impl Iterator<Item = &'a str>) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.len().to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn slug(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str, commit: &str) -> RepositoryPin {
        RepositoryPin {
            name: name.into(),
            base_ref: "main".into(),
            base_commit: commit.into(),
            relevance_basis_points: 9_000,
            evidence: vec!["ticket".into(), "graph-path".into()],
        }
    }

    fn draft(repositories: Vec<RepositoryPin>) -> BoundaryDraft {
        BoundaryDraft {
            issue_key: "platform-42".into(),
            base_graph_digest: "graph-base-42".into(),
            repositories,
            services: vec![
                ServiceSpec {
                    id: "ledger-events".into(),
                    repository: "ledger-events".into(),
                    default_port: 9_100,
                    depends_on: vec!["checkout-api".into()],
                },
                ServiceSpec {
                    id: "checkout-api".into(),
                    repository: "checkout-api".into(),
                    default_port: 9_000,
                    depends_on: vec![],
                },
            ],
        }
    }

    #[test]
    fn compilation_is_order_independent() {
        let first = BoundaryCompiler::compile(
            draft(vec![
                repo("ledger-events", "bbb"),
                repo("checkout-api", "aaa"),
            ]),
            &BTreeSet::new(),
        )
        .unwrap();
        let second = BoundaryCompiler::compile(
            draft(vec![
                repo("checkout-api", "aaa"),
                repo("ledger-events", "bbb"),
            ]),
            &BTreeSet::new(),
        )
        .unwrap();

        assert_eq!(first.digest, second.digest);
        assert_eq!(first.repositories, second.repositories);
    }

    #[test]
    fn runtime_leases_avoid_ports_held_by_other_sessions() {
        let boundary = BoundaryCompiler::compile(
            draft(vec![
                repo("checkout-api", "aaa"),
                repo("ledger-events", "bbb"),
            ]),
            &BTreeSet::from([9_000, 9_001, 9_100]),
        )
        .unwrap();

        assert_eq!(boundary.runtime_leases[0].loopback_port, 9_002);
        assert_eq!(boundary.runtime_leases[1].loopback_port, 9_101);
    }

    #[test]
    fn stale_actions_fail_before_capability_evaluation() {
        let boundary = BoundaryCompiler::compile(
            draft(vec![
                repo("checkout-api", "aaa"),
                repo("ledger-events", "bbb"),
            ]),
            &BTreeSet::new(),
        )
        .unwrap();
        let result = boundary.verify(&ActionEnvelope {
            boundary_digest: "older-boundary".into(),
            effect: Effect::Execute,
            resource: "process:checkout-api".into(),
        });

        assert_eq!(result, Err(BoundaryError::StaleBoundary));
    }

    #[test]
    fn observed_cross_boundary_edges_require_a_revision() {
        let boundary = BoundaryCompiler::compile(
            draft(vec![
                repo("checkout-api", "aaa"),
                repo("ledger-events", "bbb"),
            ]),
            &BTreeSet::new(),
        )
        .unwrap();
        let drift = boundary.detect_scope_drift(GraphObservation {
            source_repository: "checkout-api".into(),
            target_repository: "risk-engine".into(),
            edge: "runtime-call".into(),
        });

        assert!(drift.is_some());
        assert!(drift.unwrap().reason.contains("risk-engine"));
    }

    #[test]
    fn revisions_are_parent_linked_and_receive_new_authority() {
        let original = BoundaryCompiler::compile(
            draft(vec![
                repo("checkout-api", "aaa"),
                repo("ledger-events", "bbb"),
            ]),
            &BTreeSet::new(),
        )
        .unwrap();
        let mut next_draft = draft(vec![
            repo("checkout-api", "aaa"),
            repo("ledger-events", "bbb"),
            repo("risk-engine", "ccc"),
        ]);
        next_draft.services.push(ServiceSpec {
            id: "risk-engine".into(),
            repository: "risk-engine".into(),
            default_port: 9_200,
            depends_on: vec!["checkout-api".into()],
        });

        let revised = original.revise(next_draft, &BTreeSet::new()).unwrap();
        assert_eq!(revised.revision, 2);
        assert_eq!(
            revised.parent_digest.as_deref(),
            Some(original.digest.as_str())
        );
        assert_ne!(revised.digest, original.digest);
    }
}
