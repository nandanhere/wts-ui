use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use hex::ToHex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use wts_core::workspace::{
    MAX_BASE_REF_CHARS, MAX_REPOSITORIES_PER_WORKSPACE, MAX_REPOSITORY_LABEL_CHARS,
    MAX_RUNTIME_PORTS_PER_SERVICE, MAX_RUNTIME_SERVICES, RuntimePortPolicy,
    WorkspaceRepositoryRequest,
};
use wts_git::{CommitCandidateBlob, CommitCandidateKind, GitError, GitWorktreeService};

const DETECTOR_VERSION: &str = "wts-runtime-analysis-v1";
const MAX_WARNINGS: usize = 64;
const MAX_EVIDENCE_PER_SERVICE: usize = 16;
const MAX_EVIDENCE_PER_PORT: usize = 8;
const MAX_PACKAGE_SCRIPT_BYTES: usize = 4096;
const MAX_COMMAND_ARGUMENTS: usize = 64;
const MAX_COMMAND_ARGUMENT_BYTES: usize = 1024;
const MAX_IDENTIFIER_BYTES: usize = 160;
const MAX_DISPLAY_CHARS: usize = 120;
const MAX_RELATIVE_PATH_BYTES: usize = 512;
const MAX_GRAPH_DETAIL_CHARS: usize = 240;
const MAX_MANIFEST_PORTS: usize = 64;
const MAX_MANIFEST_PROCESSES: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAnalysisRequest {
    pub repositories: Vec<WorkspaceRepositoryRequest>,
}

impl RuntimeAnalysisRequest {
    /// Canonicalize browser input before resolving repository IDs through the
    /// trusted catalog. Runtime analysis never falls back to a mutable label.
    pub fn normalize(mut self) -> Result<Self, RuntimeAnalysisError> {
        if self.repositories.is_empty() {
            return Err(RuntimeAnalysisError::EmptyRepositories);
        }
        if self.repositories.len() > MAX_REPOSITORIES_PER_WORKSPACE {
            return Err(RuntimeAnalysisError::TooManyRepositories);
        }

        let mut repository_ids = BTreeSet::new();
        for (index, repository) in self.repositories.iter_mut().enumerate() {
            repository.label = repository.label.trim().to_owned();
            repository.base_ref = repository.base_ref.trim().to_owned();
            let repository_id = repository
                .repository_id
                .as_mut()
                .ok_or(RuntimeAnalysisError::MissingRepositoryId { index })?;
            *repository_id = repository_id.trim().to_owned();

            if !valid_repository_id(repository_id) {
                return Err(RuntimeAnalysisError::InvalidRepositoryId { index });
            }
            if repository.label.is_empty()
                || repository.label.chars().count() > MAX_REPOSITORY_LABEL_CHARS
                || repository
                    .label
                    .chars()
                    .any(|character| character.is_control() || matches!(character, '/' | '\\'))
            {
                return Err(RuntimeAnalysisError::InvalidRepositoryLabel { index });
            }
            if !valid_base_ref(&repository.base_ref) {
                return Err(RuntimeAnalysisError::InvalidBaseRef { index });
            }
            if !repository_ids.insert(repository_id.clone()) {
                return Err(RuntimeAnalysisError::DuplicateRepositoryId);
            }
        }
        self.repositories.sort_by(|left, right| {
            left.repository_id
                .cmp(&right.repository_id)
                .then(left.label.cmp(&right.label))
                .then(left.base_ref.cmp(&right.base_ref))
        });
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeConfidence {
    Declared,
    Corroborated,
    Inferred,
    Suggested,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEvidence {
    pub repository_id: String,
    pub commit_oid: String,
    pub path: String,
    pub detector: String,
    pub detail: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePortCandidate {
    pub port_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferred_port: Option<u16>,
    pub policy: RuntimePortPolicy,
    pub confidence: RuntimeConfidence,
    pub evidence: Vec<RuntimeEvidence>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeServiceCandidate {
    pub candidate_id: String,
    pub service_id: String,
    pub display_name: String,
    pub repository_id: String,
    pub repository_label: String,
    pub commit_oid: String,
    pub working_directory: String,
    pub command: Vec<String>,
    pub dependencies: Vec<String>,
    pub ports: Vec<RuntimePortCandidate>,
    pub confidence: RuntimeConfidence,
    pub evidence: Vec<RuntimeEvidence>,
    pub included_by_default: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAnalyzedRepository {
    pub repository_id: String,
    pub repository_label: String,
    pub requested_base_ref: String,
    pub resolved_base_ref: String,
    pub commit_oid: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeGraphStatus {
    Unavailable,
    Stale,
    Ready,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeGraphAnalysis {
    pub status: RuntimeGraphStatus,
    pub detail: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeAnalysisResult {
    pub analysis_digest: String,
    pub repositories: Vec<RuntimeAnalyzedRepository>,
    pub services: Vec<RuntimeServiceCandidate>,
    pub warnings: Vec<String>,
    pub graph: RuntimeGraphAnalysis,
}

/// Trusted host input produced after a pinned browser repository ID is
/// catalog-resolved and its selected base is resolved to an exact commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeRepositorySource {
    pub(crate) repository_id: String,
    pub(crate) repository_label: String,
    pub(crate) requested_base_ref: String,
    pub(crate) resolved_base_ref: String,
    pub(crate) commit_oid: String,
    pub(crate) repository_root: PathBuf,
}

impl RuntimeRepositorySource {
    pub(crate) fn new(
        repository_id: impl Into<String>,
        repository_label: impl Into<String>,
        requested_base_ref: impl Into<String>,
        resolved_base_ref: impl Into<String>,
        commit_oid: impl Into<String>,
        repository_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            repository_id: repository_id.into(),
            repository_label: repository_label.into(),
            requested_base_ref: requested_base_ref.into(),
            resolved_base_ref: resolved_base_ref.into(),
            commit_oid: commit_oid.into(),
            repository_root: repository_root.into(),
        }
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RuntimeAnalysisError {
    #[error("at least one repository is required for runtime analysis")]
    EmptyRepositories,
    #[error("too many repositories were requested for runtime analysis")]
    TooManyRepositories,
    #[error("repositoryId is required at index {index}")]
    MissingRepositoryId { index: usize },
    #[error("repositoryId is invalid at index {index}")]
    InvalidRepositoryId { index: usize },
    #[error("repository label is invalid at index {index}")]
    InvalidRepositoryLabel { index: usize },
    #[error("base reference is invalid at index {index}")]
    InvalidBaseRef { index: usize },
    #[error("runtime analysis repository IDs must be unique")]
    DuplicateRepositoryId,
    #[error("trusted runtime analysis source metadata is invalid")]
    InvalidTrustedSource,
    #[error("trusted repository identity changed before runtime analysis")]
    RepositoryIdentityChanged,
    #[error("runtime analysis produced too many service candidates")]
    TooManyServices,
    #[error("runtime analysis produced duplicate candidate identities")]
    DuplicateCandidate,
    #[error("runtime analysis digest could not be created")]
    DigestFailed,
    #[error(transparent)]
    Git(#[from] GitError),
}

pub(crate) fn analyze_runtime(
    sources: &[RuntimeRepositorySource],
) -> Result<RuntimeAnalysisResult, RuntimeAnalysisError> {
    if sources.is_empty() {
        return Err(RuntimeAnalysisError::EmptyRepositories);
    }
    if sources.len() > MAX_REPOSITORIES_PER_WORKSPACE {
        return Err(RuntimeAnalysisError::TooManyRepositories);
    }

    let mut ordered = sources.iter().collect::<Vec<_>>();
    ordered.sort_by(|left, right| left.repository_id.cmp(&right.repository_id));
    validate_sources(&ordered)?;

    let git = GitWorktreeService::new();
    let mut repositories = Vec::with_capacity(ordered.len());
    let mut evidence_sets = Vec::with_capacity(ordered.len());
    let mut services = Vec::new();
    let mut warnings = Vec::new();
    for source in &ordered {
        let inspection = git.inspect_repository(&source.repository_root)?;
        if inspection.id.as_str() != source.repository_id {
            return Err(RuntimeAnalysisError::RepositoryIdentityChanged);
        }
        let blobs =
            git.read_runtime_candidate_blobs(&source.repository_root, &source.commit_oid)?;
        evidence_sets.push((*source, blobs));
        repositories.push(RuntimeAnalyzedRepository {
            repository_id: source.repository_id.clone(),
            repository_label: source.repository_label.clone(),
            requested_base_ref: source.requested_base_ref.clone(),
            resolved_base_ref: source.resolved_base_ref.clone(),
            commit_oid: source.commit_oid.clone(),
        });
    }

    // Build the bounded exact-commit evidence graph before running detectors.
    // Each repository and allowlisted configuration blob is a node; every blob
    // has a containment edge back to the repository/commit that supplied it.
    // This gives detectors a common, inspectable evidence set without checking
    // out code, executing repository content, or depending on a mutable graph
    // index from another commit.
    let evidence_file_count = evidence_sets
        .iter()
        .map(|(_, blobs)| blobs.len())
        .sum::<usize>();
    let evidence_node_count = evidence_sets.len() + evidence_file_count;
    let evidence_edge_count = evidence_file_count;

    for (source, blobs) in &evidence_sets {
        let mut detected = detect_repository(source, blobs, &mut warnings);
        services.append(&mut detected);
        if services.len() > MAX_RUNTIME_SERVICES {
            return Err(RuntimeAnalysisError::TooManyServices);
        }
    }

    services.sort_by(|left, right| left.candidate_id.cmp(&right.candidate_id));
    if services
        .windows(2)
        .any(|pair| pair[0].candidate_id == pair[1].candidate_id)
    {
        return Err(RuntimeAnalysisError::DuplicateCandidate);
    }
    if services.is_empty() {
        push_warning(
            &mut warnings,
            "No runnable services were inferred from the selected commits.".to_owned(),
        );
    }
    warnings.sort();
    warnings.dedup();
    warnings.truncate(MAX_WARNINGS);

    let graph = RuntimeGraphAnalysis {
        status: RuntimeGraphStatus::Ready,
        detail: format!(
            "Built an exact-commit evidence graph with {evidence_node_count} nodes and {evidence_edge_count} relationships across {} repositories and {evidence_file_count} manifest, Compose, Dockerfile, and example environment files.",
            evidence_sets.len(),
        )
        .chars()
        .take(MAX_GRAPH_DETAIL_CHARS)
        .collect(),
    };
    let analysis_digest = analysis_digest(&repositories, &services)?;
    Ok(RuntimeAnalysisResult {
        analysis_digest,
        repositories,
        services,
        warnings,
        graph,
    })
}

fn validate_sources(sources: &[&RuntimeRepositorySource]) -> Result<(), RuntimeAnalysisError> {
    let mut ids = BTreeSet::new();
    for source in sources {
        if !valid_repository_id(&source.repository_id)
            || source.repository_label.trim().is_empty()
            || source.repository_label != source.repository_label.trim()
            || source.repository_label.chars().count() > MAX_REPOSITORY_LABEL_CHARS
            || source
                .repository_label
                .chars()
                .any(|character| character.is_control() || matches!(character, '/' | '\\'))
            || !valid_base_ref(&source.requested_base_ref)
            || !valid_resolved_ref(&source.resolved_base_ref)
            || !valid_oid(&source.commit_oid)
            || source.repository_root.as_os_str().is_empty()
        {
            return Err(RuntimeAnalysisError::InvalidTrustedSource);
        }
        if !ids.insert(source.repository_id.clone()) {
            return Err(RuntimeAnalysisError::DuplicateRepositoryId);
        }
    }
    Ok(())
}

fn detect_repository(
    source: &RuntimeRepositorySource,
    blobs: &[CommitCandidateBlob],
    warnings: &mut Vec<String>,
) -> Vec<RuntimeServiceCandidate> {
    let mut manifest_services = Vec::new();
    for blob in blobs
        .iter()
        .filter(|blob| blob.kind == CommitCandidateKind::StackManifest)
    {
        match parse_stack_manifest(source, blob) {
            Some(mut services) => {
                manifest_services.append(&mut services);
            }
            None => push_warning(
                warnings,
                format!(
                    "Skipped {} in {}: invalid or unsupported wts-stack.json.",
                    blob.path, source.repository_label
                ),
            ),
        }
    }
    if !manifest_services.is_empty() {
        // A committed WTS manifest is the authority for its repository. Other
        // detectors are intentionally not allowed to manufacture competing
        // executable commands.
        for blob in blobs
            .iter()
            .filter(|blob| blob.kind == CommitCandidateKind::ComposeManifest)
        {
            push_warning(
                warnings,
                format!(
                    "Detected {} in {}; Compose remains evidence-only until it can be parsed without guessing YAML semantics.",
                    blob.path, source.repository_label
                ),
            );
        }
        return manifest_services;
    }

    let supplements = collect_supplemental_ports(source, blobs, warnings);
    let mut package_services = Vec::new();
    for blob in blobs
        .iter()
        .filter(|blob| blob.kind == CommitCandidateKind::PackageManifest)
    {
        match parse_package_services(source, blob, &supplements) {
            Some(mut detected) => package_services.append(&mut detected),
            None => push_warning(
                warnings,
                format!(
                    "Skipped {} in {}: package metadata was malformed or outside analysis bounds.",
                    blob.path, source.repository_label
                ),
            ),
        }
        if package_services.len() > MAX_RUNTIME_SERVICES {
            break;
        }
    }

    for blob in blobs
        .iter()
        .filter(|blob| blob.kind == CommitCandidateKind::ComposeManifest)
    {
        push_warning(
            warnings,
            format!(
                "Detected {} in {}; Compose remains evidence-only until it can be parsed without guessing YAML semantics.",
                blob.path, source.repository_label
            ),
        );
    }

    let used_ports = package_services
        .iter()
        .flat_map(|service| {
            service.ports.iter().filter_map(|port| {
                port.preferred_port
                    .map(|preferred| (service.working_directory.clone(), preferred))
            })
        })
        .collect::<BTreeSet<_>>();
    for supplement in &supplements {
        if !used_ports.contains(&(supplement.directory.clone(), supplement.port)) {
            push_warning(
                warnings,
                format!(
                    "{} declares port {} in {}, but no safe runnable command was found beside it.",
                    supplement.detector_label(),
                    supplement.port,
                    supplement.path
                ),
            );
        }
    }
    package_services
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackManifest {
    schema_version: u32,
    id: String,
    description: String,
    ports: Vec<StackPort>,
    processes: Vec<StackProcess>,
    smoke: StackCommand,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackPort {
    id: String,
    environment: String,
    offset: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackProcess {
    id: String,
    working_directory: String,
    executable: String,
    arguments: Vec<String>,
    dependencies: Vec<String>,
    health: StackHealth,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackHealth {
    port: String,
    path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StackCommand {
    working_directory: String,
    executable: String,
    arguments: Vec<String>,
}

fn parse_stack_manifest(
    source: &RuntimeRepositorySource,
    blob: &CommitCandidateBlob,
) -> Option<Vec<RuntimeServiceCandidate>> {
    let manifest = serde_json::from_slice::<StackManifest>(&blob.bytes).ok()?;
    if manifest.schema_version != 1
        || !valid_identifier(&manifest.id)
        || manifest.description.trim().is_empty()
        || manifest.description.chars().any(char::is_control)
        || manifest.ports.is_empty()
        || manifest.ports.len() > MAX_MANIFEST_PORTS
        || manifest.processes.is_empty()
        || manifest.processes.len() > MAX_MANIFEST_PROCESSES
        || manifest.smoke.arguments.is_empty()
        || !safe_command(
            &manifest.smoke.executable,
            &manifest.smoke.arguments,
            &manifest.smoke.working_directory,
        )
    {
        return None;
    }

    let mut port_ids = BTreeSet::new();
    let mut offsets = BTreeSet::new();
    let mut environments = BTreeSet::new();
    let mut ports = BTreeMap::new();
    for port in manifest.ports {
        if !valid_identifier(&port.id)
            || !valid_environment_name(&port.environment)
            || !port.environment.ends_with("_PORT")
            || !port_ids.insert(port.id.clone())
            || !offsets.insert(port.offset)
            || !environments.insert(port.environment.clone())
        {
            return None;
        }
        ports.insert(port.id.clone(), port);
    }

    let process_ids = manifest
        .processes
        .iter()
        .map(|process| process.id.clone())
        .collect::<BTreeSet<_>>();
    if process_ids.len() != manifest.processes.len()
        || process_ids.iter().any(|id| !valid_identifier(id))
    {
        return None;
    }
    let mut health_ports = BTreeSet::new();
    for process in &manifest.processes {
        if process.arguments.is_empty()
            || !safe_command(
                &process.executable,
                &process.arguments,
                &process.working_directory,
            )
            || process.health.path.is_empty()
            || process.health.path.len() > 256
            || !process.health.path.starts_with('/')
            || process.health.path.chars().any(char::is_control)
            || !ports.contains_key(&process.health.port)
            || !health_ports.insert(process.health.port.clone())
        {
            return None;
        }
        let mut dependencies = BTreeSet::new();
        if process.dependencies.len() > MAX_RUNTIME_SERVICES
            || process.dependencies.iter().any(|dependency| {
                dependency == &process.id
                    || !process_ids.contains(dependency)
                    || !dependencies.insert(dependency.clone())
            })
        {
            return None;
        }
    }
    if health_ports != port_ids || dependency_cycle(&manifest.processes) {
        return None;
    }

    let manifest_directory = parent_directory(&blob.path);
    let mut services = Vec::with_capacity(manifest.processes.len());
    for process in manifest.processes {
        let port = ports.get(&process.health.port)?;
        let working_directory =
            join_relative_directory(&manifest_directory, &process.working_directory)?;
        let service_evidence = evidence(
            source,
            &blob.path,
            "wts-stack",
            format!(
                "Schema v1 declares process {} in stack {}.",
                process.id, manifest.id
            ),
        );
        let port_evidence = evidence(
            source,
            &blob.path,
            "wts-stack",
            format!(
                "Port {} is assigned through {}; allocation is deferred until start.",
                port.id, port.environment
            ),
        );
        let mut command = Vec::with_capacity(process.arguments.len() + 1);
        command.push(process.executable);
        command.extend(process.arguments);
        let mut dependencies = process.dependencies;
        dependencies.sort();
        services.push(RuntimeServiceCandidate {
            candidate_id: candidate_id(
                source,
                "wts-stack",
                &blob.path,
                &process.id,
                &working_directory,
            ),
            service_id: process.id.clone(),
            display_name: display_name(&process.id),
            repository_id: source.repository_id.clone(),
            repository_label: source.repository_label.clone(),
            commit_oid: source.commit_oid.clone(),
            working_directory,
            command,
            dependencies,
            ports: vec![RuntimePortCandidate {
                port_id: port.id.clone(),
                environment: Some(port.environment.clone()),
                preferred_port: None,
                policy: RuntimePortPolicy::Prefer,
                confidence: RuntimeConfidence::Declared,
                evidence: vec![port_evidence],
            }],
            confidence: RuntimeConfidence::Declared,
            evidence: vec![service_evidence],
            included_by_default: true,
        });
    }
    Some(services)
}

fn dependency_cycle(processes: &[StackProcess]) -> bool {
    let mut remaining = processes
        .iter()
        .map(|process| {
            (
                process.id.as_str(),
                process
                    .dependencies
                    .iter()
                    .map(String::as_str)
                    .collect::<BTreeSet<_>>(),
            )
        })
        .collect::<BTreeMap<_, _>>();
    let mut completed = BTreeSet::new();
    while !remaining.is_empty() {
        let ready = remaining
            .iter()
            .filter(|(_, dependencies)| dependencies.is_subset(&completed))
            .map(|(id, _)| *id)
            .collect::<Vec<_>>();
        if ready.is_empty() {
            return true;
        }
        for id in ready {
            remaining.remove(id);
            completed.insert(id);
        }
    }
    false
}

#[derive(Clone, Debug)]
struct SupplementalPort {
    directory: String,
    port: u16,
    environment: Option<String>,
    path: String,
    detector: &'static str,
}

impl SupplementalPort {
    fn detector_label(&self) -> &'static str {
        match self.detector {
            "dockerfile-expose" => "Dockerfile EXPOSE",
            "environment-example" => "Environment example",
            _ => "Runtime configuration",
        }
    }
}

fn collect_supplemental_ports(
    source: &RuntimeRepositorySource,
    blobs: &[CommitCandidateBlob],
    warnings: &mut Vec<String>,
) -> Vec<SupplementalPort> {
    let mut ports = Vec::new();
    for blob in blobs {
        match blob.kind {
            CommitCandidateKind::Dockerfile => {
                let Some(text) = std::str::from_utf8(&blob.bytes).ok() else {
                    push_warning(
                        warnings,
                        format!(
                            "Skipped {} in {}: Dockerfile was not UTF-8.",
                            blob.path, source.repository_label
                        ),
                    );
                    continue;
                };
                for port in dockerfile_ports(text).into_iter().take(16) {
                    ports.push(SupplementalPort {
                        directory: parent_directory(&blob.path),
                        port,
                        environment: None,
                        path: blob.path.clone(),
                        detector: "dockerfile-expose",
                    });
                }
            }
            CommitCandidateKind::EnvironmentExample => {
                let Some(text) = std::str::from_utf8(&blob.bytes).ok() else {
                    push_warning(
                        warnings,
                        format!(
                            "Skipped {} in {}: environment example was not UTF-8.",
                            blob.path, source.repository_label
                        ),
                    );
                    continue;
                };
                for (environment, port) in environment_example_ports(text).into_iter().take(16) {
                    ports.push(SupplementalPort {
                        directory: parent_directory(&blob.path),
                        port,
                        environment: Some(environment),
                        path: blob.path.clone(),
                        detector: "environment-example",
                    });
                }
            }
            _ => {}
        }
    }
    ports.sort_by(|left, right| {
        left.directory
            .cmp(&right.directory)
            .then(left.port.cmp(&right.port))
            .then(left.environment.cmp(&right.environment))
            .then(left.path.cmp(&right.path))
            .then(left.detector.cmp(right.detector))
    });
    ports.dedup_by(|left, right| {
        left.directory == right.directory
            && left.port == right.port
            && left.environment == right.environment
            && left.path == right.path
            && left.detector == right.detector
    });
    ports
}

fn parse_package_services(
    source: &RuntimeRepositorySource,
    blob: &CommitCandidateBlob,
    supplements: &[SupplementalPort],
) -> Option<Vec<RuntimeServiceCandidate>> {
    let value = serde_json::from_slice::<serde_json::Value>(&blob.bytes).ok()?;
    let object = value.as_object()?;
    let scripts = object.get("scripts")?.as_object()?;
    let package_name = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .filter(|name| {
            !name.is_empty()
                && name.len() <= MAX_DISPLAY_CHARS
                && !name.chars().any(char::is_control)
        });
    let manager = package_manager(
        object
            .get("packageManager")
            .and_then(serde_json::Value::as_str),
    );
    let directory = parent_directory(&blob.path);
    let nearby = supplements
        .iter()
        .filter(|supplement| supplement.directory == directory)
        .collect::<Vec<_>>();

    let mut script_entries = scripts
        .iter()
        .filter_map(|(name, value)| {
            let script = value.as_str()?;
            valid_script_name(name).then_some((script_priority(name), name.as_str(), script))
        })
        .collect::<Vec<_>>();
    script_entries.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.to_lowercase().cmp(&right.1.to_lowercase()))
    });

    let mut services = Vec::new();
    for (_, script_name, script) in script_entries {
        if script.len() > MAX_PACKAGE_SCRIPT_BYTES || script.chars().any(char::is_control) {
            continue;
        }
        let explicit = script_ports(script);
        let conventional = script_priority(script_name) < 4;
        if explicit.is_empty() && (!conventional || nearby.is_empty()) {
            continue;
        }

        let mut detected_ports = if explicit.is_empty() {
            nearby
                .iter()
                .map(|supplement| ScriptPort {
                    port: supplement.port,
                    environment: supplement.environment.clone(),
                })
                .collect::<Vec<_>>()
        } else {
            explicit
        };
        detected_ports.sort_by(|left, right| {
            left.port
                .cmp(&right.port)
                .then(left.environment.cmp(&right.environment))
        });
        detected_ports.dedup();
        detected_ports.truncate(MAX_RUNTIME_PORTS_PER_SERVICE);
        if detected_ports.is_empty() {
            continue;
        }

        let service_id = package_service_id(package_name, script_name, &directory);
        let mut service_evidence = vec![evidence(
            source,
            &blob.path,
            "package-script",
            format!(
                "Package script {} provides a bounded package-manager command.",
                script_name
            ),
        )];
        let mut any_corroborated = false;
        let mut used_port_ids = BTreeSet::new();
        let mut ports = Vec::with_capacity(detected_ports.len());
        for detected in detected_ports {
            let mut port_evidence = vec![evidence(
                source,
                &blob.path,
                "package-script",
                format!(
                    "Package script {} declares or consumes port {}.",
                    script_name, detected.port
                ),
            )];
            for supplement in nearby
                .iter()
                .filter(|supplement| supplement.port == detected.port)
            {
                port_evidence.push(evidence(
                    source,
                    &supplement.path,
                    supplement.detector,
                    match &supplement.environment {
                        Some(environment) => format!(
                            "{} corroborates port {} through {}.",
                            supplement.detector_label(),
                            supplement.port,
                            environment
                        ),
                        None => format!(
                            "{} corroborates exposed port {}.",
                            supplement.detector_label(),
                            supplement.port
                        ),
                    },
                ));
            }
            port_evidence.sort_by(|left, right| {
                left.detector
                    .cmp(&right.detector)
                    .then(left.path.cmp(&right.path))
                    .then(left.detail.cmp(&right.detail))
            });
            port_evidence.dedup();
            port_evidence.truncate(MAX_EVIDENCE_PER_PORT);
            let detector_count = port_evidence
                .iter()
                .map(|entry| entry.detector.as_str())
                .collect::<BTreeSet<_>>()
                .len();
            let confidence = if detector_count > 1 {
                any_corroborated = true;
                RuntimeConfidence::Corroborated
            } else {
                RuntimeConfidence::Inferred
            };
            let port_id = unique_port_id(
                detected.environment.as_deref(),
                ports.len(),
                &mut used_port_ids,
            );
            ports.push(RuntimePortCandidate {
                port_id,
                environment: detected.environment,
                preferred_port: Some(detected.port),
                policy: RuntimePortPolicy::Prefer,
                confidence,
                evidence: port_evidence,
            });
        }
        if any_corroborated {
            service_evidence.push(evidence(
                source,
                &blob.path,
                "detector-merge",
                "Independent configuration evidence agrees with the package command.".to_owned(),
            ));
        }
        service_evidence.truncate(MAX_EVIDENCE_PER_SERVICE);
        let command = package_command(manager, script_name);
        services.push(RuntimeServiceCandidate {
            candidate_id: candidate_id(
                source,
                "package-script",
                &blob.path,
                &service_id,
                &directory,
            ),
            service_id: service_id.clone(),
            display_name: package_name
                .map(|name| format!("{} · {}", display_name(name), display_name(script_name)))
                .unwrap_or_else(|| display_name(&service_id)),
            repository_id: source.repository_id.clone(),
            repository_label: source.repository_label.clone(),
            commit_oid: source.commit_oid.clone(),
            working_directory: directory.clone(),
            command,
            dependencies: Vec::new(),
            ports,
            confidence: if any_corroborated {
                RuntimeConfidence::Corroborated
            } else {
                RuntimeConfidence::Inferred
            },
            evidence: service_evidence,
            included_by_default: true,
        });
        // One package represents one runnable service proposal. Prefer the
        // conventional lifecycle script order above; emitting both `dev` and
        // `start` would create duplicate default services for most projects.
        break;
    }
    Some(services)
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ScriptPort {
    port: u16,
    environment: Option<String>,
}

fn script_ports(script: &str) -> Vec<ScriptPort> {
    let tokens = script
        .split_ascii_whitespace()
        .take(256)
        .collect::<Vec<_>>();
    let mut ports = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = trim_shell_punctuation(tokens[index]);
        let paired = matches!(token, "--port" | "-p")
            .then(|| tokens.get(index + 1).copied())
            .flatten()
            .and_then(parse_port_literal);
        if let Some(port) = paired {
            ports.push(ScriptPort {
                port,
                environment: None,
            });
            index += 2;
            continue;
        }
        if let Some(value) = token
            .strip_prefix("--port=")
            .or_else(|| token.strip_prefix("-p="))
            .and_then(parse_port_literal)
        {
            ports.push(ScriptPort {
                port: value,
                environment: None,
            });
        } else if let Some((environment, value)) = token.split_once('=')
            && valid_environment_name(environment)
            && environment.contains("PORT")
            && let Some(port) = parse_port_literal(value)
        {
            ports.push(ScriptPort {
                port,
                environment: Some(environment.to_owned()),
            });
        }
        index += 1;
    }
    ports.sort();
    ports.dedup();
    ports
}

fn dockerfile_ports(text: &str) -> Vec<u16> {
    let mut ports = BTreeSet::new();
    for line in text.lines().take(4096) {
        let code = line.split('#').next().unwrap_or_default().trim();
        let mut tokens = code.split_ascii_whitespace();
        if !tokens
            .next()
            .is_some_and(|token| token.eq_ignore_ascii_case("EXPOSE"))
        {
            continue;
        }
        for token in tokens.take(16) {
            let value = token.split('/').next().unwrap_or_default();
            if let Some(port) = parse_port_literal(value) {
                ports.insert(port);
            }
        }
    }
    ports.into_iter().collect()
}

fn environment_example_ports(text: &str) -> Vec<(String, u16)> {
    let mut ports = BTreeSet::new();
    for line in text.lines().take(4096) {
        let mut code = line.trim();
        if code.is_empty() || code.starts_with('#') {
            continue;
        }
        if let Some(rest) = code.strip_prefix("export ") {
            code = rest.trim_start();
        }
        let Some((environment, value)) = code.split_once('=') else {
            continue;
        };
        let environment = environment.trim();
        if !valid_environment_name(environment) || !environment.contains("PORT") {
            continue;
        }
        let value = value
            .split('#')
            .next()
            .unwrap_or_default()
            .trim()
            .trim_matches(['\'', '"']);
        if let Some(port) = parse_port_literal(value) {
            ports.insert((environment.to_owned(), port));
        }
    }
    ports.into_iter().collect()
}

fn analysis_digest(
    repositories: &[RuntimeAnalyzedRepository],
    services: &[RuntimeServiceCandidate],
) -> Result<String, RuntimeAnalysisError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct DigestInput<'a> {
        detector_version: &'static str,
        repositories: &'a [RuntimeAnalyzedRepository],
        services: &'a [RuntimeServiceCandidate],
    }
    let bytes = serde_json::to_vec(&DigestInput {
        detector_version: DETECTOR_VERSION,
        repositories,
        services,
    })
    .map_err(|_| RuntimeAnalysisError::DigestFailed)?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!(
        "sha256:{}",
        hasher.finalize().encode_hex::<String>()
    ))
}

fn candidate_id(
    source: &RuntimeRepositorySource,
    detector: &str,
    path: &str,
    service_id: &str,
    working_directory: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(DETECTOR_VERSION.as_bytes());
    hasher.update(b"\0");
    for value in [
        source.repository_id.as_str(),
        source.commit_oid.as_str(),
        detector,
        path,
        service_id,
        working_directory,
    ] {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    let digest = hasher.finalize().encode_hex::<String>();
    format!("candidate:{}", &digest[..32])
}

fn evidence(
    source: &RuntimeRepositorySource,
    path: &str,
    detector: &str,
    detail: String,
) -> RuntimeEvidence {
    RuntimeEvidence {
        repository_id: source.repository_id.clone(),
        commit_oid: source.commit_oid.clone(),
        path: path.to_owned(),
        detector: detector.to_owned(),
        detail: detail.chars().take(320).collect(),
    }
}

fn parent_directory(path: &str) -> String {
    Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| ".".to_owned())
}

fn join_relative_directory(parent: &str, child: &str) -> Option<String> {
    if !safe_relative_directory(parent) || !safe_relative_directory(child) {
        return None;
    }
    let combined = if parent == "." {
        PathBuf::from(child)
    } else if child == "." {
        PathBuf::from(parent)
    } else {
        Path::new(parent).join(child)
    };
    let value = combined.to_string_lossy().replace('\\', "/");
    safe_relative_directory(&value).then_some(value)
}

fn safe_relative_directory(value: &str) -> bool {
    if value == "." {
        return true;
    }
    !value.is_empty()
        && value.len() <= MAX_RELATIVE_PATH_BYTES
        && !value.chars().any(char::is_control)
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn safe_command(executable: &str, arguments: &[String], working_directory: &str) -> bool {
    !executable.is_empty()
        && executable.len() <= 128
        && executable
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
        && arguments.len() <= MAX_COMMAND_ARGUMENTS
        && arguments.iter().all(|argument| {
            !argument.is_empty()
                && argument.len() <= MAX_COMMAND_ARGUMENT_BYTES
                && !argument.chars().any(char::is_control)
        })
        && safe_relative_directory(working_directory)
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_script_name(value: &str) -> bool {
    valid_identifier(value) && value.len() <= 80
}

fn valid_environment_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'A'..=b'Z' | b'_' => true,
            b'0'..=b'9' => index > 0,
            _ => false,
        })
}

fn valid_repository_id(value: &str) -> bool {
    value.strip_prefix("repo_").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_resolved_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_BASE_REF_CHARS + "refs/remotes/origin/".len()
        && !value.chars().any(|character| character.is_control())
        && (value.starts_with("refs/heads/") || value.starts_with("refs/remotes/origin/"))
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

fn parse_port_literal(value: &str) -> Option<u16> {
    let value = trim_shell_punctuation(value);
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse::<u16>().ok().filter(|port| *port >= 1024)
}

fn trim_shell_punctuation(value: &str) -> &str {
    value.trim_matches(|character| matches!(character, '\'' | '"' | '(' | ')' | ';' | ','))
}

fn script_priority(name: &str) -> u8 {
    match name {
        "dev" => 0,
        "start" => 1,
        "serve" => 2,
        "preview" => 3,
        _ => 4,
    }
}

#[derive(Clone, Copy)]
enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

fn package_manager(value: Option<&str>) -> PackageManager {
    match value.and_then(|value| value.split('@').next()) {
        Some("pnpm") => PackageManager::Pnpm,
        Some("yarn") => PackageManager::Yarn,
        Some("bun") => PackageManager::Bun,
        _ => PackageManager::Npm,
    }
}

fn package_command(manager: PackageManager, script: &str) -> Vec<String> {
    match manager {
        PackageManager::Npm => vec!["npm".to_owned(), "run".to_owned(), script.to_owned()],
        PackageManager::Pnpm => vec!["pnpm".to_owned(), "run".to_owned(), script.to_owned()],
        PackageManager::Yarn => vec!["yarn".to_owned(), script.to_owned()],
        PackageManager::Bun => vec!["bun".to_owned(), "run".to_owned(), script.to_owned()],
    }
}

fn package_service_id(package_name: Option<&str>, script: &str, directory: &str) -> String {
    let raw = package_name
        .map(|name| {
            format!(
                "{}-{}",
                name.trim_start_matches('@').replace('/', "-"),
                script
            )
        })
        .unwrap_or_else(|| {
            let leaf = directory.rsplit('/').next().unwrap_or("service");
            format!("{leaf}-{script}")
        });
    sanitize_identifier(&raw)
}

fn sanitize_identifier(value: &str) -> String {
    let mut sanitized = String::new();
    let mut separator = false;
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_') {
            sanitized.push(char::from(byte).to_ascii_lowercase());
            separator = false;
        } else if !separator && !sanitized.is_empty() {
            sanitized.push('-');
            separator = true;
        }
        if sanitized.len() >= MAX_IDENTIFIER_BYTES {
            break;
        }
    }
    let value = sanitized.trim_matches('-');
    if value.is_empty() {
        "service".to_owned()
    } else {
        value.to_owned()
    }
}

fn unique_port_id(environment: Option<&str>, index: usize, used: &mut BTreeSet<String>) -> String {
    let base = environment
        .map(|value| sanitize_identifier(value.trim_end_matches("_PORT")))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if index == 0 {
                "http".to_owned()
            } else {
                format!("http-{}", index + 1)
            }
        });
    let mut candidate = base.clone();
    let mut suffix = 2;
    while !used.insert(candidate.clone()) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

fn display_name(value: &str) -> String {
    let mut display = String::new();
    let mut spacing = false;
    for character in value.chars().take(MAX_DISPLAY_CHARS) {
        if character.is_control() {
            continue;
        }
        if matches!(character, '-' | '_') {
            if !display.is_empty() && !spacing {
                display.push(' ');
                spacing = true;
            }
        } else {
            display.push(character);
            spacing = character.is_whitespace();
        }
    }
    let trimmed = display.trim();
    if trimmed.is_empty() {
        "Service".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn push_warning(warnings: &mut Vec<String>, warning: String) {
    if warnings.len() < MAX_WARNINGS {
        warnings.push(warning);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn repository(files: &[(&str, &[u8])]) -> (tempfile::TempDir, RuntimeRepositorySource) {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let root = temporary.path().join("runtime-repository");
        fs::create_dir(&root).expect("repository directory");
        run(
            None,
            &["init", root.to_str().expect("UTF-8 repository path")],
        );
        run(Some(&root), &["config", "user.name", "WTS Test"]);
        run(
            Some(&root),
            &["config", "user.email", "wts@example.invalid"],
        );
        run(Some(&root), &["config", "commit.gpgSign", "false"]);
        for (path, contents) in files {
            let target = root.join(path);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).expect("fixture parent");
            }
            fs::write(target, contents).expect("fixture file");
        }
        run(Some(&root), &["add", "."]);
        run(Some(&root), &["commit", "-m", "runtime fixture"]);
        run(Some(&root), &["branch", "-M", "main"]);

        let commit_oid = output(Some(&root), &["rev-parse", "HEAD"]);
        let inspection = GitWorktreeService::new()
            .inspect_repository(&root)
            .expect("repository inspection");
        let source = RuntimeRepositorySource::new(
            inspection.id.as_str(),
            inspection.label,
            "main",
            "refs/heads/main",
            commit_oid,
            root,
        );
        (temporary, source)
    }

    #[test]
    fn request_requires_pinned_unique_repositories_and_canonicalizes_order() {
        let first = format!("repo_{}", "a".repeat(64));
        let second = format!("repo_{}", "b".repeat(64));
        let normalized = RuntimeAnalysisRequest {
            repositories: vec![
                WorkspaceRepositoryRequest {
                    repository_id: Some(second.clone()),
                    label: " Worker ".to_owned(),
                    base_ref: " develop ".to_owned(),
                },
                WorkspaceRepositoryRequest {
                    repository_id: Some(first.clone()),
                    label: " API ".to_owned(),
                    base_ref: " main ".to_owned(),
                },
            ],
        }
        .normalize()
        .expect("normalized request");
        assert_eq!(
            normalized.repositories[0].repository_id.as_deref(),
            Some(first.as_str())
        );
        assert_eq!(normalized.repositories[0].label, "API");
        assert_eq!(normalized.repositories[0].base_ref, "main");

        let missing = RuntimeAnalysisRequest {
            repositories: vec![WorkspaceRepositoryRequest {
                repository_id: None,
                label: "api".to_owned(),
                base_ref: "main".to_owned(),
            }],
        }
        .normalize();
        assert_eq!(
            missing,
            Err(RuntimeAnalysisError::MissingRepositoryId { index: 0 })
        );

        let duplicate = RuntimeAnalysisRequest {
            repositories: vec![
                WorkspaceRepositoryRequest {
                    repository_id: Some(first.clone()),
                    label: "api".to_owned(),
                    base_ref: "main".to_owned(),
                },
                WorkspaceRepositoryRequest {
                    repository_id: Some(first.clone()),
                    label: "worker".to_owned(),
                    base_ref: "main".to_owned(),
                },
            ],
        }
        .normalize();
        assert_eq!(duplicate, Err(RuntimeAnalysisError::DuplicateRepositoryId));

        let duplicate_labels = RuntimeAnalysisRequest {
            repositories: vec![
                WorkspaceRepositoryRequest {
                    repository_id: Some(first),
                    label: "shared".to_owned(),
                    base_ref: "main".to_owned(),
                },
                WorkspaceRepositoryRequest {
                    repository_id: Some(second),
                    label: "SHARED".to_owned(),
                    base_ref: "develop".to_owned(),
                },
            ],
        }
        .normalize()
        .expect("pinned identities make duplicate display labels unambiguous");
        assert_eq!(duplicate_labels.repositories.len(), 2);
    }

    #[test]
    fn analysis_allows_distinct_pinned_repositories_with_the_same_display_label() {
        let (_first_temporary, mut first) = repository(&[("README.md", b"first repository")]);
        let (_second_temporary, mut second) = repository(&[("README.md", b"second repository")]);
        first.repository_label = "shared".to_owned();
        second.repository_label = "shared".to_owned();

        let result = analyze_runtime(&[first, second]).expect("analyze pinned repositories");

        assert_eq!(result.repositories.len(), 2);
        assert_ne!(
            result.repositories[0].repository_id,
            result.repositories[1].repository_id
        );
        assert!(
            result
                .repositories
                .iter()
                .all(|repository| repository.repository_label == "shared")
        );
    }

    #[test]
    fn analysis_reads_the_exact_commit_not_dirty_worktree_content() {
        let (_temporary, source) = repository(&[(
            "package.json",
            br#"{"name":"console","scripts":{"dev":"next dev --port 4100"}}"#,
        )]);
        fs::write(
            source.repository_root.join("package.json"),
            br#"{"name":"console","scripts":{"dev":"next dev --port 9999"}}"#,
        )
        .expect("dirty package metadata");

        let first = analyze_runtime(std::slice::from_ref(&source)).expect("first analysis");
        let second = analyze_runtime(std::slice::from_ref(&source)).expect("second analysis");

        assert_eq!(first, second, "analysis must be deterministic");
        assert!(first.analysis_digest.starts_with("sha256:"));
        assert_eq!(first.services.len(), 1);
        assert_eq!(first.services[0].command, ["npm", "run", "dev"]);
        assert_eq!(first.services[0].ports[0].preferred_port, Some(4100));
    }

    #[test]
    fn strict_stack_manifest_is_authoritative_over_package_heuristics() {
        let manifest = br#"{
          "schemaVersion": 1,
          "id": "frontend-backend",
          "description": "API and frontend",
          "ports": [
            {"id":"backend","environment":"BACKEND_PORT","offset":0},
            {"id":"frontend","environment":"FRONTEND_PORT","offset":1}
          ],
          "processes": [
            {
              "id":"backend",
              "workingDirectory":"backend",
              "executable":"node",
              "arguments":["src/server.mjs"],
              "dependencies":[],
              "health":{"port":"backend","path":"/health"}
            },
            {
              "id":"frontend",
              "workingDirectory":"frontend",
              "executable":"node",
              "arguments":["src/server.mjs"],
              "dependencies":["backend"],
              "health":{"port":"frontend","path":"/health"}
            }
          ],
          "smoke":{"workingDirectory":".","executable":"node","arguments":["smoke.mjs"]}
        }"#;
        let (_temporary, source) = repository(&[
            ("wts-stack.json", manifest),
            ("package.json", br#"{"scripts":{"dev":"vite --port 5173"}}"#),
        ]);

        let result = analyze_runtime(&[source]).expect("manifest analysis");

        assert_eq!(result.services.len(), 2);
        assert!(
            result
                .services
                .iter()
                .all(|service| service.confidence == RuntimeConfidence::Declared)
        );
        let frontend = result
            .services
            .iter()
            .find(|service| service.service_id == "frontend")
            .expect("frontend service");
        assert_eq!(frontend.dependencies, ["backend"]);
        assert_eq!(frontend.ports[0].preferred_port, None);
        assert_eq!(frontend.command, ["node", "src/server.mjs"]);
        assert!(
            result
                .services
                .iter()
                .all(|service| !service.command.iter().any(|part| part == "npm"))
        );
    }

    #[test]
    fn package_ports_are_corroborated_without_leaking_example_secrets() {
        const SECRET_SENTINEL: &str = "DO_NOT_LEAK_THIS_VALUE";
        let environment_example = format!("SECRET={SECRET_SENTINEL}\nWEB_PORT=4173\n");
        let (_temporary, source) = repository(&[
            (
                "web/package.json",
                br#"{"name":"web","packageManager":"pnpm@9.0.0","scripts":{"dev":"vite --port 4173"}}"#,
            ),
            ("web/Dockerfile", b"FROM node:22\nEXPOSE 4173/tcp\n"),
            ("web/.env.example", environment_example.as_bytes()),
        ]);

        let result = analyze_runtime(&[source]).expect("corroborated analysis");
        assert_eq!(result.services.len(), 1);
        let service = &result.services[0];
        assert_eq!(service.command, ["pnpm", "run", "dev"]);
        assert_eq!(service.confidence, RuntimeConfidence::Corroborated);
        assert_eq!(service.ports[0].confidence, RuntimeConfidence::Corroborated);
        assert!(
            service.ports[0]
                .evidence
                .iter()
                .any(|evidence| evidence.detector == "dockerfile-expose")
        );
        assert!(
            service.ports[0]
                .evidence
                .iter()
                .any(|evidence| evidence.detector == "environment-example")
        );
        let serialized = serde_json::to_string(&result).expect("serialized analysis");
        assert!(!serialized.contains(SECRET_SENTINEL));
    }

    #[test]
    fn malformed_manifest_falls_back_and_oversized_blob_is_rejected() {
        let (_temporary, source) = repository(&[
            ("wts-stack.json", br#"{"schemaVersion":2}"#),
            (
                "package.json",
                br#"{"scripts":{"start":"PORT=8080 node server.js"}}"#,
            ),
        ]);
        let result = analyze_runtime(&[source]).expect("fallback analysis");
        assert_eq!(result.services.len(), 1);
        assert_eq!(result.services[0].ports[0].preferred_port, Some(8080));
        assert!(
            result
                .warnings
                .iter()
                .any(|warning| warning.contains("invalid or unsupported"))
        );

        let oversized = vec![b' '; wts_git::MAX_RUNTIME_CANDIDATE_BLOB_BYTES + 1];
        let (_temporary, source) = repository(&[("package.json", oversized.as_slice())]);
        assert!(matches!(
            analyze_runtime(&[source]),
            Err(RuntimeAnalysisError::Git(GitError::CommitFilesTooLarge))
        ));
    }

    fn run(repository: Option<&Path>, args: &[&str]) {
        let status = command(repository, args)
            .status()
            .expect("start fixture Git");
        assert!(status.success(), "fixture Git command failed: {args:?}");
    }

    fn output(repository: Option<&Path>, args: &[&str]) -> String {
        let output = command(repository, args)
            .output()
            .expect("start fixture Git");
        assert!(
            output.status.success(),
            "fixture Git command failed: {args:?}"
        );
        String::from_utf8(output.stdout)
            .expect("UTF-8 Git output")
            .trim()
            .to_owned()
    }

    fn command(repository: Option<&Path>, args: &[&str]) -> Command {
        let mut command = Command::new("git");
        if let Some(repository) = repository {
            command.arg("-C").arg(repository);
        }
        command
            .args(args)
            .env("LC_ALL", "C")
            .env("GIT_TERMINAL_PROMPT", "0");
        command
    }
}
